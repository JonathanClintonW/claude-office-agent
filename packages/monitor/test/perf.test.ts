// Monitor ingest throughput, WebSocket fan-out convergence and snapshot size.
// Thresholds are generous; the printed measurements are recorded in docs/VALIDATION.md.
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createInitialState, reduce, TOKEN_HEADER, type OfficeState, type ServerMessage } from '@agent-office/core';
import { loadOrCreateConfig } from '../src/config';
import type { MonitorPlugin } from '../src/plugin';
import { defaultPlugins } from '../src/plugins';
import { createMonitor, type Monitor } from '../src/server';
import { freePort, http, tempDir } from './helpers';

const LONG = 3_600_000;

/** WebSocket client with the UI store's semantics: skip duplicates, count (and resync on) gaps. */
class Mirror {
  ws: WebSocket;
  state: OfficeState = createInitialState();
  synced = false;
  gaps = 0;
  duplicates = 0;
  messages = 0;
  bytes = 0;
  snapshotBytes = 0;
  snapshotAt = 0;
  constructor(port: number, token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    this.ws.on('message', (d) => {
      const text = String(d);
      this.messages += 1;
      this.bytes += text.length;
      const msg = JSON.parse(text) as ServerMessage;
      if (msg.type === 'snapshot') {
        this.state = msg.state;
        this.synced = true;
        this.snapshotBytes = text.length;
        this.snapshotAt = performance.now();
      } else if (msg.type === 'events' && this.synced) {
        for (const ev of msg.events) {
          if (ev.seq <= this.state.lastSeq) {
            this.duplicates += 1;
            continue;
          }
          if (ev.seq !== this.state.lastSeq + 1) {
            this.gaps += 1;
            this.synced = false;
            this.ws.send(JSON.stringify({ type: 'resync' }));
            return;
          }
          this.state = reduce(this.state, ev);
        }
      }
    });
  }
  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }
  close(): void {
    this.ws.close();
  }
}

async function until(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function hook(session: string, event: string, extra: Record<string, unknown> = {}) {
  return { session_id: session, cwd: `c:\\work\\${session}`, transcript_path: `c:\\t\\${session}.jsonl`, permission_mode: 'default', hook_event_name: event, ...extra };
}

/** Per-session ordered payloads: start, prompt, `pairs` tool calls, stop. */
function sessionEvents(session: string, pairs: number): Record<string, unknown>[] {
  const out = [hook(session, 'SessionStart', { source: 'startup' }), hook(session, 'UserPromptSubmit')];
  for (let t = 0; t < pairs; t++) {
    const id = `${session}-t${t}`;
    out.push(hook(session, 'PreToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: { command: `npm run step-${t}` } }));
    out.push(hook(session, 'PostToolUse', { tool_name: 'Bash', tool_use_id: id, tool_input: {}, tool_response: { success: true }, duration_ms: 3 }));
  }
  out.push(hook(session, 'Stop', { last_assistant_message: 'done' }));
  return out;
}

describe('monitor performance', () => {
  let home: ReturnType<typeof tempDir> | undefined;
  let monitor: Monitor | undefined;
  const mirrors: Mirror[] = [];

  async function start(plugins: MonitorPlugin[]): Promise<{ port: number; token: string }> {
    home = tempDir('perf');
    const port = await freePort();
    const token = loadOrCreateConfig(home.path, { port }).token;
    monitor = createMonitor({
      home: home.path,
      port,
      token,
      claudeDirs: [home.path],
      discovery: false,
      plugins,
      tickIntervalMs: LONG,
      metaIntervalMs: LONG,
      spoolIntervalMs: LONG,
    });
    await monitor.start();
    return { port, token };
  }

  afterEach(async () => {
    for (const m of mirrors.splice(0)) m.close();
    await monitor?.stop();
    monitor = undefined;
    home?.cleanup();
    home = undefined;
  });

  async function burstAndFanOut(label: string, plugins: MonitorPlugin[]) {
    const { port, token } = await start(plugins);
    const CLIENTS = 6;
    for (let i = 0; i < CLIENTS; i++) mirrors.push(new Mirror(port, token));
    await Promise.all(mirrors.map((m) => m.opened()));
    await until(() => mirrors.every((m) => m.synced), 5_000, 'initial snapshots');

    const SESSIONS = 25;
    const queues = Array.from({ length: SESSIONS }, (_, i) => sessionEvents(`burst-${label}-${i}`, 60));
    const total = queues.reduce((s, q) => s + q.length, 0);
    const statuses = new Map<number, number>();
    const t0 = performance.now();
    // One sequential poster per session (hooks of one session are ordered), all sessions concurrently.
    await Promise.all(
      queues.map(async (q) => {
        for (const p of q) {
          const r = await http(port, {
            method: 'POST',
            path: '/api/hook',
            headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token },
            body: JSON.stringify({ v: 1, ts: Date.now(), payload: p }),
          });
          statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
        }
      }),
    );
    const ingestMs = performance.now() - t0;
    const target = monitor!.getState().lastSeq;
    await until(() => mirrors.every((m) => m.state.lastSeq >= target), 15_000, 'all clients to catch up');
    const convergeMs = performance.now() - t0;

    const serverState = monitor!.getState();
    for (const m of mirrors) {
      expect(m.gaps).toBe(0);
      expect(m.state).toEqual(serverState); // identical reducer, identical events → identical state
    }
    expect(statuses.get(204)).toBe(total);
    const m = {
      plugins: plugins.map((p) => p.name),
      events: total,
      clients: CLIENTS,
      ingestMs: Math.round(ingestMs),
      requestsPerSec: Math.round(total / (ingestMs / 1000)),
      allClientsConvergedMs: Math.round(convergeMs),
      wsMessagesPerClient: mirrors[0]!.messages,
      wsKBPerClient: Math.round(mirrors[0]!.bytes / 1024),
      duplicatesSkipped: mirrors.reduce((s, x) => s + x.duplicates, 0),
    };
    console.log(`[perf:monitor] burst ${JSON.stringify(m)}`);
    return m;
  }

  it('ingests a 3k-event HTTP burst and fans out to 6 WebSocket clients without gaps (no plugins)', async () => {
    const m = await burstAndFanOut('bare', []);
    expect(m.requestsPerSec).toBeGreaterThan(150);
    expect(m.allClientsConvergedMs).toBeLessThan(30_000);
  }, 60_000);

  it('same burst with defaultPlugins() (plugin overhead)', async () => {
    const m = await burstAndFanOut('plugins', defaultPlugins());
    expect(m.requestsPerSec).toBeGreaterThan(100);
    expect(m.allClientsConvergedMs).toBeLessThan(30_000);
  }, 60_000);

  it('snapshot size and latency with ~300 agents (100 sessions × 2 subagents, full tool histories)', async () => {
    const { port, token } = await start([]);
    const base = Date.now() - 600_000;
    let n = 0;
    for (let i = 0; i < 100; i++) {
      const s = `snap-${i}`;
      const ing = (event: string, extra: Record<string, unknown> = {}) => monitor!.ingestHook(hook(s, event, extra), base + n++);
      ing('SessionStart', { source: 'startup', model: 'claude-opus-5-5' });
      ing('UserPromptSubmit');
      for (let sub = 0; sub < 2; sub++) {
        const ag = { agent_id: `sa${sub}`, agent_type: 'Explore' };
        ing('SubagentStart', ag);
        for (let t = 0; t < 30; t++) {
          ing('PreToolUse', { ...ag, tool_name: 'Grep', tool_use_id: `${s}-${sub}-${t}`, tool_input: { pattern: 'x'.repeat(40), path: 'src' } });
          ing('PostToolUse', { ...ag, tool_name: 'Grep', tool_use_id: `${s}-${sub}-${t}`, tool_input: {}, tool_response: { success: true } });
        }
      }
      for (let t = 0; t < 70; t++) {
        ing('PreToolUse', { tool_name: 'Edit', tool_use_id: `${s}-m${t}`, tool_input: { file_path: `c:\\work\\${s}\\src\\module-${t}.ts` } });
        ing('PostToolUse', { tool_name: 'Edit', tool_use_id: `${s}-m${t}`, tool_input: {}, tool_response: { success: true } });
      }
    }
    const state = monitor!.getState();
    expect(Object.keys(state.agents)).toHaveLength(300);

    const s0 = performance.now();
    const json = JSON.stringify(state);
    const stringifyMs = performance.now() - s0;

    const h0 = performance.now();
    const r = await http(port, { path: '/api/state', headers: { [TOKEN_HEADER]: token } });
    const httpMs = performance.now() - h0;
    expect(r.status).toBe(200);

    const w0 = performance.now();
    const c = new Mirror(port, token);
    mirrors.push(c);
    await c.opened();
    await until(() => c.synced, 10_000, 'snapshot');
    const wsMs = c.snapshotAt - w0;
    expect(c.state).toEqual(state);

    const m = {
      agents: 300,
      events: n,
      stateKB: Math.round(json.length / 1024),
      stringifyMs: Math.round(stringifyMs),
      httpStateKB: Math.round(r.body.length / 1024),
      httpStateMs: Math.round(httpMs),
      wsSnapshotKB: Math.round(c.snapshotBytes / 1024),
      wsSnapshotMs: Math.round(wsMs),
    };
    console.log(`[perf:monitor] snapshot ${JSON.stringify(m)}`);
    expect(c.snapshotBytes).toBeLessThan(8 * 1024 * 1024); // below the server's slow-consumer limit
    expect(m.httpStateMs).toBeLessThan(3_000);
    expect(m.wsSnapshotMs).toBeLessThan(3_000);
  }, 60_000);
});
