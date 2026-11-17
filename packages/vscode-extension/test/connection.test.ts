import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKEN_HEADER, type ServerMessage } from '@agent-office/core';
import { MonitorConnection, checkHealth, type LinkStatus } from '../src/connection';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

const until = async (pred: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

function postHook(port: number, token: string, payload: unknown): Promise<number> {
  return new Promise((done) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/hook', method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token } }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.end(JSON.stringify(payload));
  });
}

describe('MonitorConnection (multi-window leader election)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function make(home: string, port: number, claude: string) {
    const statuses: LinkStatus[] = [];
    const messages: ServerMessage[] = [];
    const c = new MonitorConnection({
      home,
      port,
      token: 't'.repeat(48),
      claudeDirs: [claude],
      autoStart: true,
      log: () => {},
      onMessage: (m) => messages.push(m),
      onStatus: (s) => statuses.push(s),
    });
    c.start();
    cleanups.push(() => c.dispose());
    return { c, statuses, messages };
  }

  it('first window starts the monitor, second connects, and the second takes over when the first closes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-office-ext-'));
    const claude = mkdtempSync(join(tmpdir(), 'agent-office-claude-'));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(claude, { recursive: true, force: true });
    });
    const port = await freePort();

    const w1 = await make(home, port, claude);
    await until(() => w1.c.status === 'open');
    expect(w1.c.ownsMonitor).toBe(true);
    expect(await checkHealth(port)).toBe('ours');

    const w2 = await make(home, port, claude);
    await until(() => w2.c.status === 'open');
    expect(w2.c.ownsMonitor).toBe(false);

    // live events reach both windows and their mirrors agree
    expect(await postHook(port, 't'.repeat(48), { session_id: 'sess-x', hook_event_name: 'UserPromptSubmit' })).toBe(204);
    await until(() => w1.c.mirror?.state.agents['sess-x']?.status === 'working' && w2.c.mirror?.state.agents['sess-x']?.status === 'working');

    // the leader window closes: the follower notices and starts its own monitor
    await w1.c.dispose();
    await until(() => w2.c.ownsMonitor && w2.c.status === 'open', 20000);
    expect(await checkHealth(port)).toBe('ours');
    // persisted state survived the handover (restored as unknown until confirmed)
    await until(() => w2.c.mirror?.state.agents['sess-x'] !== undefined);
    expect(w2.c.mirror!.state.agents['sess-x']!.status).toBe('unknown');
  }, 40000);

  it('refuses to talk to a foreign service on the port', async () => {
    const port = await freePort();
    const foreign = (await import('node:http')).createServer((_req, res) => res.end('hello'));
    await new Promise<void>((r) => foreign.listen(port, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => foreign.close(() => r())));
    const home = mkdtempSync(join(tmpdir(), 'agent-office-ext-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const w = await make(home, port, home);
    await until(() => w.statuses.includes('reconnecting'));
    expect(w.c.ownsMonitor).toBe(false);
    expect(w.c.detail).toContain('used by another program');
  });
});
