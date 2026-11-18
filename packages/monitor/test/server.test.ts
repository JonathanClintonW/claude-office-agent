import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agentKeyFor, defaultLayout, taskKeyFor, TOKEN_HEADER, type ServerMessage } from '@agent-office/core';
import { loadOrCreateConfig } from '../src/config';
import { createMonitor, type Monitor } from '../src/server';
import { buildScenario, simSessions } from '../src/simulate';
import { spoolDir } from '../src/spool';
import { buildForwarder, freePort, http, MirrorClient, runForwarder, sleep, tempDir } from './helpers';

const SID = '0f9c7a4e-1111-4222-8333-944455556666';

function hookPayload(event: string, extra: Record<string, unknown> = {}, sessionId = SID) {
  return { session_id: sessionId, cwd: 'c:\\work\\demo', transcript_path: 'c:\\x.jsonl', permission_mode: 'default', hook_event_name: event, ...extra };
}

describe('monitor server', () => {
  let home: ReturnType<typeof tempDir>;
  let claude: ReturnType<typeof tempDir>;
  let build: ReturnType<typeof tempDir>;
  let forwarder: string;
  let monitor: Monitor;
  let port: number;
  let token: string;
  const clients: MirrorClient[] = [];

  beforeAll(async () => {
    build = tempDir('build');
    forwarder = await buildForwarder(build.path);
  });
  afterAll(() => build.cleanup());

  async function startMonitor(opts: { discovery?: boolean } = {}) {
    monitor = createMonitor({
      home: home.path,
      port,
      token,
      claudeDirs: [claude.path],
      discovery: opts.discovery ?? false,
      tickIntervalMs: 3_600_000,
      registryIntervalMs: 3_600_000,
      transcriptIntervalMs: 3_600_000,
      spoolIntervalMs: 3_600_000,
    });
    await monitor.start();
  }

  function client(headers?: Record<string, string>) {
    const c = new MirrorClient(port, token, headers);
    clients.push(c);
    return c;
  }

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    http(port, { method: 'POST', path: '/api/hook', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token, ...headers }, body: JSON.stringify(body) });

  beforeEach(async () => {
    home = tempDir('home');
    claude = tempDir('claude');
    port = await freePort();
    token = loadOrCreateConfig(home.path, { port }).token;
    await startMonitor();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await monitor.stop();
    home.cleanup();
    claude.cleanup();
  });

  describe('HTTP security', () => {
    it('serves an unauthenticated health check', async () => {
      const r = await http(port, { path: '/api/health' });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toMatchObject({ app: 'agent-office', protocol: 1 });
    });

    it('accepts valid hook payloads with an empty 204 (no influence on Claude Code)', async () => {
      const r = await post(hookPayload('SessionStart', { source: 'startup' }));
      expect(r.status).toBe(204);
      expect(r.body).toBe('');
      expect(monitor.getState().agents[SID]?.status).toBe('idle');
    });

    it('rejects bad tokens, hosts, origins, content types and payloads', async () => {
      expect((await post(hookPayload('Stop'), { [TOKEN_HEADER]: 'wrong' })).status).toBe(401);
      expect((await http(port, { method: 'POST', path: '/api/hook', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
      // DNS-rebinding style Host header
      expect((await post(hookPayload('Stop'), { host: 'evil.example:80' })).status).toBe(403);
      // cross-site browser request
      expect((await post(hookPayload('Stop'), { origin: 'https://evil.example' })).status).toBe(403);
      expect((await post(hookPayload('Stop'), { 'content-type': 'text/plain' })).status).toBe(415);
      expect((await http(port, { method: 'POST', path: '/api/hook', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token }, body: '{not json' })).status).toBe(400);
      expect((await post({ session_id: '../../etc', hook_event_name: 'Stop' })).status).toBe(400);
      expect(Object.keys(monitor.getState().agents)).toHaveLength(0);
      expect(monitor.getMeta().rejectedEvents).toBe(2);
    });

    it('protects the state endpoint with the token', async () => {
      expect((await http(port, { path: '/api/state' })).status).toBe(401);
      const r = await http(port, { path: '/api/state', headers: { [TOKEN_HEADER]: token } });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toHaveProperty('state.agents');
    });

    it('binds to loopback only', () => {
      expect(monitor.port).toBe(port);
    });

    it('answers malformed request paths with 400 and keeps running', async () => {
      // Any local page can make the browser request a URL without an Origin header (e.g. <img src>).
      await monitor.stop();
      const ui = tempDir('ui');
      writeFileSync(join(ui.path, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
      try {
        monitor = createMonitor({ home: home.path, port, token, claudeDirs: [claude.path], uiDir: ui.path, discovery: false, persist: false });
        await monitor.start();
        expect((await http(port, { path: '/%E0%A4%A' })).status).toBe(400);
        expect((await http(port, { path: '/api/rpc/%E0%A4%A', headers: { [TOKEN_HEADER]: token } })).status).toBe(400);
        expect((await http(port, { path: '/' })).status).toBe(200);
        expect((await http(port, { path: '/api/health' })).status).toBe(200);
      } finally {
        ui.cleanup();
      }
    });
  });

  describe('WebSocket', () => {
    it('rejects connections without a valid token or from foreign origins', async () => {
      const bad = new MirrorClient(port, 'nope');
      await expect(bad.opened()).rejects.toThrow('401');
      const foreign = new MirrorClient(port, token, { origin: 'https://evil.example' });
      await expect(foreign.opened()).rejects.toThrow('403');
    });

    it('ignores client messages that are valid JSON but not objects', async () => {
      const c = client();
      await c.opened();
      await c.waitFor((x) => x.messages.some((m) => m.type === 'snapshot'));
      for (const m of ['null', '1', '"resync"', '[]']) c.ws.send(m);
      c.ws.send(JSON.stringify({ type: 'resync' }));
      await c.waitFor((x) => x.messages.filter((m) => m.type === 'snapshot').length === 2);
      expect((await http(port, { path: '/api/health' })).status).toBe(200);
    });

    it('sends a snapshot, then sequenced events that replay to the identical state', async () => {
      await post(hookPayload('SessionStart'));
      const c = client({ origin: `http://127.0.0.1:${port}` });
      await c.opened();
      await c.waitFor((x) => x.messages.some((m) => m.type === 'snapshot'));
      expect(c.state.agents[SID]?.status).toBe('idle');

      await post(hookPayload('UserPromptSubmit'));
      await post(hookPayload('PreToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' } }));
      await post(hookPayload('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
      await c.waitFor((x) => x.state.agents[SID]?.status === 'waiting_permission');
      expect(c.gaps).toBe(0);
      expect(JSON.stringify(c.state)).toBe(JSON.stringify(monitor.getState()));
    });

    it('validates and persists layouts', async () => {
      const c = client();
      await c.opened();
      const layout = { ...defaultLayout(), name: 'Team room' };
      c.ws.send(JSON.stringify({ type: 'saveLayout', layout }));
      await c.waitFor((x) => x.messages.some((m) => m.type === 'layout'));
      expect(JSON.parse(readFileSync(join(home.path, 'layout.json'), 'utf8')).name).toBe('Team room');

      c.ws.send(JSON.stringify({ type: 'saveLayout', layout: { ...layout, cols: 5000 } }));
      await c.waitFor((x) => x.messages.some((m) => m.type === 'error'));
      expect(monitor.getLayout().name).toBe('Team room');
    });
  });

  describe('mock Claude Code session end-to-end', () => {
    it('replays a multi-session scenario with subagents, permissions, failures, tasks and teammates', async () => {
      const c = client();
      await c.opened();
      const t0 = Date.now() - 20_000;
      for (const step of buildScenario()) {
        expect((await post({ v: 1, ts: t0 + step.at, payload: step.payload })).status).toBe(204);
      }
      const s = monitor.getState();
      const [A, B, C] = simSessions('0001');
      expect(s.agents[A]).toMatchObject({ status: 'idle', kind: 'session' });
      expect(s.agents[agentKeyFor(A, 'sim-explore-1')]).toMatchObject({ status: 'completed', parentKey: A, parentVia: 'spawn-tool', agentType: 'Explore' });
      expect(s.agents[agentKeyFor(A, 'sim-explore-1')]!.tools.map((t) => t.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
      expect(s.tasks[taskKeyFor(A, '1')]).toMatchObject({ status: 'completed' });
      expect(s.tasks[taskKeyFor(A, '2')]).toMatchObject({ status: 'completed' });
      expect(s.agents[B]).toMatchObject({ status: 'idle' });
      expect(s.agents[agentKeyFor(B, 'sim-tm-alice')]).toMatchObject({ kind: 'teammate', teammateName: 'alice', status: 'idle' });
      expect(s.agents[C]).toMatchObject({ status: 'failed' });
      const kinds = s.notices.map((n) => `${n.kind}:${n.severity}`);
      expect(kinds).toContain('permission:warning');
      expect(kinds).toContain('tool_failure:error');
      expect(kinds).toContain('stop_failure:error');
      await c.waitFor((x) => x.state.lastSeq === s.lastSeq);
      expect(c.gaps).toBe(0);
      expect(JSON.stringify(c.state)).toBe(JSON.stringify(s));
    });
  });

  describe('hook forwarder process', () => {
    it('delivers events, writes nothing to stdout/stderr and exits 0', async () => {
      const r = await runForwarder(forwarder, home.path, JSON.stringify(hookPayload('SessionStart', { source: 'startup' })));
      expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(monitor.getState().agents[SID]?.status).toBe('idle');

      const r2 = await runForwarder(forwarder, home.path, JSON.stringify(hookPayload('PreToolUse', { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'c:\\a.ts' } })));
      expect(r2.code).toBe(0);
      expect(monitor.getState().agents[SID]?.currentToolId).toBe('r1');
    });

    it('exits 0 silently on garbage input', async () => {
      for (const input of ['', 'not json', '[]', '{"hook_event_name":"Stop"}']) {
        expect(await runForwarder(forwarder, home.path, input)).toEqual({ code: 0, stdout: '', stderr: '' });
      }
    });

    it('spools while the monitor is down and replays with original timestamps on restart', async () => {
      await monitor.stop();
      const before = Date.now();
      const r = await runForwarder(forwarder, home.path, JSON.stringify(hookPayload('UserPromptSubmit', { prompt: 'TOP SECRET PROMPT' })));
      expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
      const files = readdirSync(spoolDir(home.path));
      expect(files).toHaveLength(1);
      const spooled = readFileSync(join(spoolDir(home.path), files[0]!), 'utf8');
      expect(spooled).not.toContain('TOP SECRET PROMPT'); // pre-trimmed before touching disk
      await sleep(30);

      await startMonitor();
      await monitor.scanNow();
      const a = monitor.getState().agents[SID];
      expect(a?.status).toBe('working');
      expect(a!.statusAt).toBeGreaterThanOrEqual(before);
      expect(a!.statusAt).toBeLessThan(Date.now() - 20);
      expect(readdirSync(spoolDir(home.path))).toHaveLength(0);
      expect(monitor.getMeta().spooledEventsReplayed).toBe(1);
    });
  });

  describe('persistence', () => {
    it('restores state after restart and marks live agents unknown until confirmed', async () => {
      await post(hookPayload('UserPromptSubmit'));
      await post(hookPayload('SessionEnd', {}, 'ended-session-1'));
      await monitor.stop();
      expect(existsSync(join(home.path, 'state.json'))).toBe(true);
      await startMonitor();
      const s = monitor.getState();
      expect(s.agents[SID]).toMatchObject({ status: 'unknown', lastKnownStatus: 'working' });
      expect(s.agents['ended-session-1']).toMatchObject({ status: 'ended' });
      // sequence numbers continue so reconnecting clients detect the gap
      expect(s.lastSeq).toBeGreaterThan(2);
    });
  });

  describe('slow transcript I/O', () => {
    it('a transcript read that never returns does not stall discovery', async () => {
      await monitor.stop();
      const slowSid = 'slow-session-aaaa';
      const fastSid = 'fast-session-bbbb';
      const proj = join(claude.path, 'projects', 'c--x');
      mkdirSync(proj, { recursive: true });
      writeFileSync(join(proj, `${slowSid}.jsonl`), '{}\n');
      writeFileSync(join(proj, `${fastSid}.jsonl`), '{}\n');
      const dir = join(claude.path, 'sessions');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: fastSid, status: 'busy', statusUpdatedAt: Date.now() - 1000 }));
      let hung = 0;
      monitor = createMonitor({
        home: home.path,
        port,
        token,
        claudeDirs: [claude.path],
        tickIntervalMs: 3_600_000,
        registryIntervalMs: 3_600_000,
        transcriptIntervalMs: 3_600_000,
        spoolIntervalMs: 3_600_000,
        transcriptReadTimeoutMs: 200,
        readTranscript: (file) => {
          if (file.includes(slowSid)) {
            hung += 1;
            return new Promise(() => {}); // e.g. an antivirus scan that never finishes
          }
          return Promise.resolve({ title: 'Fast one' });
        },
      });
      await monitor.start();
      const t0 = Date.now();
      await monitor.scanNow();
      await monitor.scanNow();
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(monitor.getMeta().lastTranscriptScanAt).toBeDefined();
      expect(monitor.getState().agents[fastSid]).toMatchObject({ title: 'Fast one', status: 'working' });
      // the stuck file is not read again while cooling down (no piling up of I/O)
      expect(hung).toBe(1);
      // registry keeps working
      writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: fastSid, status: 'idle', statusUpdatedAt: Date.now() }));
      await monitor.scanNow();
      expect(monitor.getState().agents[fastSid]!.status).toBe('idle');
    });
  });

  describe('read-only discovery', () => {
    beforeEach(async () => {
      await monitor.stop();
      await startMonitor({ discovery: true });
    });

    it('discovers live sessions from the registry without reading key files', async () => {
      const dir = join(claude.path, 'sessions');
      mkdirSync(dir, { recursive: true });
      const live = 'live-session-aaaa';
      writeFileSync(
        join(dir, `${process.pid}.json`),
        JSON.stringify({ pid: process.pid, sessionId: live, cwd: 'c:\\work\\acme', status: 'busy', statusUpdatedAt: Date.now() - 3000, entrypoint: 'claude-vscode', name: 'acme-01', messagingSocketPath: '\\\\.\\pipe\\SECRET-PIPE' }),
      );
      writeFileSync(join(dir, `${process.pid}.deadbeef.key`), JSON.stringify({ peerToken: 'SECRET-PEER-TOKEN' }));
      await monitor.scanNow();
      const s = monitor.getState();
      expect(s.agents[live]).toMatchObject({ status: 'working', statusSource: 'registry', pid: process.pid, registryName: 'acme-01', entrypoint: 'claude-vscode' });
      const json = JSON.stringify(s);
      expect(json).not.toContain('SECRET-PEER-TOKEN');
      expect(json).not.toContain('SECRET-PIPE');

      writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: live, status: 'idle', statusUpdatedAt: Date.now() - 2000 }));
      await monitor.scanNow();
      expect(monitor.getState().agents[live]!.status).toBe('idle');

      // entry disappears → session left the registry
      unlinkSync(join(dir, `${process.pid}.json`));
      writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: live, status: 'busy', statusUpdatedAt: Date.now() - 1000 }));
      await monitor.scanNow();
      unlinkSync(join(dir, `${process.pid}.json`));
      await monitor.scanNow();
      expect(monitor.getState().agents[live]).toMatchObject({ status: 'ended' });
    });

    it('detects crashed sessions whose process is gone', async () => {
      await post(hookPayload('UserPromptSubmit'));
      const dir = join(claude.path, 'sessions');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '4194300.json'), JSON.stringify({ pid: 4194300, sessionId: SID, status: 'busy', statusUpdatedAt: Date.now() }));
      await monitor.scanNow();
      expect(monitor.getState().agents[SID]).toMatchObject({ status: 'ended', endReason: 'Process exited (no SessionEnd received)' });
    });

    it('enriches live sessions from transcripts without retaining message content', async () => {
      const sid = 'tx-session-bbbb';
      const proj = join(claude.path, 'projects', 'c--work-demo');
      mkdirSync(join(proj, sid, 'subagents'), { recursive: true });
      const now = Date.now();
      const lines = [
        { type: 'user', cwd: 'c:\\work\\demo', timestamp: new Date(now - 5000).toISOString(), message: { role: 'user', content: 'TOP SECRET USER MESSAGE' } },
        { type: 'ai-title', aiTitle: 'Refactor billing module', sessionId: sid },
        { type: 'assistant', timestamp: new Date(now - 1000).toISOString(), cwd: 'c:\\work\\demo', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'TOP SECRET ASSISTANT TEXT' }], usage: { input_tokens: 12, cache_read_input_tokens: 45000, cache_creation_input_tokens: 300, output_tokens: 800 } } },
      ];
      writeFileSync(join(proj, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      writeFileSync(join(proj, sid, 'subagents', 'agent-abc123.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find invoice code', finished: true, toolUseId: 'toolu_x' }));
      writeFileSync(join(proj, sid, 'subagents', 'agent-abc123.jsonl'), '{}\n');
      const dir = join(claude.path, 'sessions');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, status: 'idle', statusUpdatedAt: now }));

      await monitor.scanNow();
      const s = monitor.getState();
      expect(s.agents[sid]).toMatchObject({ title: 'Refactor billing module', model: 'claude-opus-5-5', status: 'idle', usageSource: 'transcript' });
      expect(s.agents[sid]!.usage).toMatchObject({ cacheReadTokens: 45000, outputTokens: 800 });
      expect(s.agents[agentKeyFor(sid, 'abc123')]).toMatchObject({ status: 'completed', agentType: 'Explore', description: 'Find invoice code', parentKey: sid });
      const json = JSON.stringify(s);
      expect(json).not.toContain('TOP SECRET');
    });
  });
});

describe('message types', () => {
  it('ServerMessage union covers what the server sends', () => {
    const kinds: ServerMessage['type'][] = ['snapshot', 'events', 'meta', 'layout', 'error'];
    expect(kinds).toHaveLength(5);
  });
});
