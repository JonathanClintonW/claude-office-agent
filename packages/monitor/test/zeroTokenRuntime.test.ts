/**
 * End-to-end RUNTIME check of the zero-extra-inference rule, in-process. The monitor runs with
 * defaultPlugins() (discovery off, then on against a temp Claude dir) through a long simulation, an
 * HTTP burst, reconnecting clients, every plugin RPC route and several ticks, while child_process,
 * http/https, net/tls, fetch and WebSocket are spied. Proves: no Claude executable was launched, every
 * process is git, every connection went to loopback, and after stop() the monitor makes no call at
 * all and its guard is released with the counters at 0. Complements staticNoInference.test.ts and
 * inference.test.ts without repeating them.
 *
 * The spies are installed BEFORE the monitor modules are imported (dynamic imports in beforeAll),
 * so module-level captures such as `promisify(execFile)` go through them as well.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createInitialState, reduce, TOKEN_HEADER, type InferenceDiagnostics, type OfficeState, type ServerMessage } from '@agent-office/core';
import type * as ConfigModule from '../src/config';
import type * as PluginsModule from '../src/plugins';
import type * as ServerModule from '../src/server';
import type * as SimulateModule from '../src/simulate';
import { freePort, http, tempDir } from './helpers';

interface Call {
  api: string;
  /** Network calls: destination host ('ipc' for pipes / unix sockets). */
  host?: string;
  /** Process calls: executable and arguments. */
  file?: string;
  args?: string[];
}

const calls: Call[] = [];
const restorers: Array<() => void> = [];
const leftovers: string[] = [];
const nodeRequire = createRequire(import.meta.url);

type Fn = (...args: unknown[]) => unknown;
type Mod = Record<string | symbol, unknown>;

function spy(mod: Mod, key: string, api: string, describe: (args: unknown[]) => Omit<Call, 'api'>): void {
  const original = mod[key] as Fn | undefined;
  if (typeof original !== 'function') return;
  const record = (args: unknown[]) => {
    try {
      calls.push({ api, ...describe(args) });
    } catch {
      calls.push({ api, host: 'unparsed' });
    }
  };
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    record(args);
    return original.apply(this, args);
  } as Fn & Mod;
  Object.defineProperty(wrapper, 'name', { value: original.name });
  // exec/execFile carry a custom promisified form; keep it (and spy on it).
  const custom = (original as unknown as Mod)[promisify.custom] as Fn | undefined;
  if (typeof custom === 'function') {
    wrapper[promisify.custom] = function (this: unknown, ...args: unknown[]): unknown {
      record(args);
      return custom.apply(this, args);
    };
  }
  mod[key] = wrapper;
  restorers.push(() => {
    if (mod[key] === wrapper) mod[key] = original;
    else leftovers.push(api); // someone wrapped our wrapper and did not unwrap: report, never clobber
  });
}

function normHost(h: unknown): string {
  return String(h ?? 'localhost')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function urlHost(input: unknown): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: unknown } | null)?.url ?? '');
  return normHost(new URL(raw).hostname);
}

function httpHost(args: unknown[]): string {
  const [a, b] = args;
  let url: URL | undefined;
  let o: Record<string, unknown> | undefined;
  if (typeof a === 'string') url = new URL(a);
  else if (a instanceof URL) url = a;
  else if (a && typeof a === 'object') o = a as Record<string, unknown>;
  if (url && b && typeof b === 'object') o = b as Record<string, unknown>;
  if (o?.socketPath) return 'ipc';
  const h = o?.hostname ?? (url ? url.hostname : undefined) ?? o?.host;
  return normHost(String(h ?? 'localhost').replace(/:\d+$/, ''));
}

function netHost(args: unknown[]): string {
  const [a, b] = args;
  if (a && typeof a === 'object') {
    const o = a as Record<string, unknown>;
    return o.path ? 'ipc' : normHost(o.host);
  }
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) return normHost(typeof b === 'string' ? b : 'localhost');
  return 'ipc'; // a path
}

function launch(args: unknown[]): Omit<Call, 'api'> {
  return { file: String(args[0] ?? ''), args: Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [] };
}

function shellLaunch(args: unknown[]): Omit<Call, 'api'> {
  const tokens = String(args[0] ?? '')
    .split(/\s+/)
    .filter(Boolean);
  return { file: tokens[0] ?? '', args: tokens.slice(1) };
}

const isLoopback = (h: string | undefined) => h === 'ipc' || h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h ?? '') || /^::ffff:127\./.test(h ?? '');
const exe = (f: string) => (f.trim().replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs)$/, '');
const isClaudeLaunch = (c: Call) => [c.file ?? '', ...(c.args ?? [])].some((s) => exe(s) === 'claude' || /@anthropic-ai[\\/]+claude|claude-code/i.test(s));
const isGit = (c: Call) => exe(c.file ?? '') === 'git';

function installSpies(): void {
  const cp = nodeRequire('node:child_process') as Mod;
  for (const k of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) spy(cp, k, `child_process.${k}`, launch);
  for (const k of ['exec', 'execSync']) spy(cp, k, `child_process.${k}`, shellLaunch);
  for (const id of ['node:http', 'node:https']) {
    const m = nodeRequire(id) as Mod;
    for (const k of ['request', 'get']) spy(m, k, `${id.slice(5)}.${k}`, (args) => ({ host: httpHost(args) }));
  }
  const net = nodeRequire('node:net') as Mod;
  for (const k of ['connect', 'createConnection']) spy(net, k, `net.${k}`, (args) => ({ host: netHost(args) }));
  spy(nodeRequire('node:tls') as Mod, 'connect', 'tls.connect', (args) => ({ host: netHost(args) }));
  const g = globalThis as unknown as Mod;
  spy(g, 'fetch', 'fetch', (args) => ({ host: urlHost(args[0]) }));
  const OriginalWS = g.WebSocket as (new (...a: unknown[]) => object) | undefined;
  if (typeof OriginalWS === 'function') {
    const proxy = new Proxy(OriginalWS, {
      construct(target, args, newTarget) {
        calls.push({ api: 'WebSocket', host: urlHost(args[0]) });
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
    g.WebSocket = proxy;
    restorers.push(() => {
      if (g.WebSocket === proxy) g.WebSocket = OriginalWS;
      else leftovers.push('WebSocket');
    });
  }
  syncBuiltinESMExports(); // ESM named imports of builtins see the wrappers too
}

function restoreSpies(): void {
  for (const r of restorers.splice(0).reverse()) r();
  syncBuiltinESMExports();
}

/** WebSocket client with the UI store's semantics (skip duplicates, resync on a gap) plus RPC. */
class Mirror {
  ws: WebSocket;
  state: OfficeState = createInitialState();
  synced = false;
  snapshots = 0;
  gaps = 0;
  ticks = 0;
  private nextId = 1;
  private pending = new Map<number, (m: Extract<ServerMessage, { type: 'rpcResult' }>) => void>();
  constructor(port: number, token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    this.ws.on('message', (d) => {
      const msg = JSON.parse(String(d)) as ServerMessage;
      if (msg.type === 'snapshot') {
        this.state = msg.state;
        this.synced = true;
        this.snapshots += 1;
      } else if (msg.type === 'events' && this.synced) {
        for (const ev of msg.events) {
          if (ev.seq <= this.state.lastSeq) continue;
          if (ev.seq !== this.state.lastSeq + 1) {
            this.gaps += 1;
            this.resync();
            return;
          }
          if (ev.kind === 'Tick') this.ticks += 1;
          this.state = reduce(this.state, ev);
        }
      } else if (msg.type === 'rpcResult') {
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
  }
  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }
  resync(): void {
    this.synced = false;
    this.ws.send(JSON.stringify({ type: 'resync' }));
  }
  rpc(method: string, params: Record<string, unknown> = {}): Promise<Extract<ServerMessage, { type: 'rpcResult' }>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`ws rpc ${method} timed out`)), 25_000);
      this.pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this.ws.send(JSON.stringify({ type: 'rpc', id, method, params }));
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
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function burstQueues(prefix: string, sessions: number, pairs: number): Record<string, unknown>[][] {
  return Array.from({ length: sessions }, (_, i) => {
    const s = `${prefix}-${i}`;
    const h = (event: string, extra: Record<string, unknown> = {}) => ({ session_id: s, cwd: `c:\\work\\${s}`, permission_mode: 'default', hook_event_name: event, ...extra });
    const q = [h('SessionStart', { source: 'startup', model: 'claude-sonnet-5-5' }), h('UserPromptSubmit', { prompt: '[dropped]' })];
    for (let t = 0; t < pairs; t++) {
      const id = `${s}-t${t}`;
      q.push(h('PreToolUse', { tool_name: t % 2 ? 'Read' : 'Bash', tool_use_id: id, tool_input: t % 2 ? { file_path: 'x.ts' } : { command: 'npm test' } }));
      q.push(h(t % 13 === 7 ? 'PostToolUseFailure' : 'PostToolUse', { tool_name: t % 2 ? 'Read' : 'Bash', tool_use_id: id, tool_input: {}, tool_response: { success: true }, error: 'Exit code 1' }));
    }
    q.push(h('Stop', { last_assistant_message: 'done' }));
    return q;
  });
}

function seedClaudeDir(dir: string): void {
  const now = Date.now();
  const sid = 'zt-live-session-0001';
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  writeFileSync(join(dir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, cwd: dir, status: 'busy', statusUpdatedAt: now - 1000, name: 'zt-live', entrypoint: 'cli' }));
  const proj = join(dir, 'projects', 'c--work-zt');
  mkdirSync(join(proj, sid, 'subagents'), { recursive: true });
  const lines = [
    { type: 'user', cwd: dir, timestamp: new Date(now - 9000).toISOString(), message: { role: 'user', content: 'SECRET PROMPT' } },
    { type: 'ai-title', aiTitle: 'Zero token runtime check', sessionId: sid },
    { type: 'assistant', timestamp: new Date(now - 4000).toISOString(), cwd: dir, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'SECRET ANSWER' }], usage: { input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 50, output_tokens: 300 } } },
  ];
  writeFileSync(join(proj, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(join(proj, sid, 'subagents', 'agent-zt1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Look around', finished: false }));
  writeFileSync(join(proj, sid, 'subagents', 'agent-zt1.jsonl'), '{}\n');
}

let mods: { config: typeof ConfigModule; plugins: typeof PluginsModule; server: typeof ServerModule; simulate: typeof SimulateModule };
let guardDiagnostics: (() => InferenceDiagnostics) | undefined;
const sandbox = tempDir('zt-sandbox');
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'AGENT_OFFICE_HOME'];
const summary: Record<string, unknown> = {};

describe('zero extra inference at runtime (monitor + defaultPlugins, in-process)', () => {
  beforeAll(async () => {
    // Nothing in this process may touch the real ~/.claude or ~/.agent-office.
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    mkdirSync(join(sandbox.path, 'home'), { recursive: true });
    process.env.HOME = join(sandbox.path, 'home');
    process.env.USERPROFILE = join(sandbox.path, 'home');
    process.env.CLAUDE_CONFIG_DIR = join(sandbox.path, 'home', '.claude');
    process.env.AGENT_OFFICE_HOME = join(sandbox.path, 'home', '.agent-office');

    installSpies();
    // Positive control: a builtin imported statically by ESM (as the monitor sources do) is observed.
    execFileSync(process.execPath, ['-e', '0'], { windowsHide: true });
    expect(calls.some((c) => c.api === 'child_process.execFileSync' && c.file === process.execPath)).toBe(true);
    calls.length = 0;

    // Import the monitor only now, so module-level captures go through the spies.
    mods = {
      config: await import('../src/config'),
      plugins: await import('../src/plugins'),
      server: await import('../src/server'),
      simulate: await import('../src/simulate'),
    };
    const guardPath = '../src/inferenceGuard';
    const guard = (await import(/* @vite-ignore */ guardPath).catch(() => undefined)) as Record<string, unknown> | undefined;
    const fn = guard?.inferenceGuardDiagnostics;
    if (typeof fn === 'function') guardDiagnostics = fn as () => InferenceDiagnostics;
  });

  afterAll(() => {
    restoreSpies();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    sandbox.cleanup();
    console.log(`[zero-token] ${JSON.stringify(summary)}`);
  });

  for (const discovery of [false, true]) {
    it(`discovery ${discovery ? 'on (temp Claude dir)' : 'off'}: long simulation, burst, reconnection, every RPC route, ticks`, async () => {
      const home = tempDir('zt-home');
      const claude = tempDir('zt-claude');
      if (discovery) seedClaudeDir(claude.path);
      const port = await freePort();
      const token = mods.config.loadOrCreateConfig(home.path, { port }).token;
      const logs: string[] = [];
      const monitor = mods.server.createMonitor({
        home: home.path,
        port,
        token,
        claudeDirs: [claude.path],
        discovery,
        plugins: mods.plugins.defaultPlugins(),
        tickIntervalMs: 100,
        metaIntervalMs: 200,
        spoolIntervalMs: 200,
        registryIntervalMs: 150,
        transcriptIntervalMs: 300,
        log: (m) => logs.push(m),
      });
      await monitor.start();
      const clients: Mirror[] = [];
      const client = async () => {
        const c = new Mirror(port, token);
        clients.push(c);
        await c.opened();
        await until(() => c.synced, 10_000, 'snapshot');
        return c;
      };
      const m: Record<string, unknown> = {};
      let stopped = false;
      try {
        const a = await client();

        // Positive control for fetch + http spies (loopback, so allowed).
        const before = calls.length;
        expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
        expect((await http(port, { path: '/api/health' })).status).toBe(200);
        const ctl = calls.slice(before);
        expect(ctl.some((c) => c.api === 'fetch' && c.host === '127.0.0.1')).toBe(true);
        expect(ctl.some((c) => c.api.startsWith('http.') && c.host === '127.0.0.1')).toBe(true);

        // 1. A long simulated session: 12 full scenario runs (3 sessions each, subagents, teammates, tasks).
        const base = Date.now() - 30 * 60_000;
        let simEvents = 0;
        for (let k = 0; k < 12; k++) {
          for (const step of mods.simulate.buildScenario(`zt${discovery ? 'd' : 'n'}${k}`)) {
            expect(monitor.ingestHook(step.payload, base + k * 20_000 + step.at).ok).toBe(true);
            simEvents++;
          }
          if (k % 2 === 0) for (const p of mods.simulate.endScenario(`zt${discovery ? 'd' : 'n'}${k}`)) monitor.ingestHook(p, base + k * 20_000 + 19_000);
        }

        // 2. A burst over HTTP, with the first client dropping out and a new one joining mid-burst.
        const queues = burstQueues(`zt-burst-${discovery ? 'd' : 'n'}`, 20, 75);
        const burst = queues.reduce((s, q) => s + q.length, 0);
        const post = (p: Record<string, unknown>) =>
          http(port, { method: 'POST', path: '/api/hook', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token }, body: JSON.stringify({ v: 1, ts: Date.now(), payload: p }) });
        const statuses: Record<number, number> = {};
        const phase = async (from: number, to: number) => {
          await Promise.all(
            queues.map(async (q) => {
              for (const p of q.slice(Math.floor(q.length * from), Math.floor(q.length * to))) {
                const r = await post(p);
                statuses[r.status] = (statuses[r.status] ?? 0) + 1;
              }
            }),
          );
        };
        const t0 = performance.now();
        await phase(0, 1 / 3);
        a.close(); // client drops out mid-burst
        const bPromise = client(); // new client connects while events keep flowing
        await phase(1 / 3, 2 / 3);
        const b = await bPromise;
        b.resync(); // explicit resync request while the burst continues
        await phase(2 / 3, 1);
        m.burstMs = Math.round(performance.now() - t0);
        expect(statuses[204]).toBe(burst);
        await until(() => b.synced && b.state.lastSeq >= monitor.getState().lastSeq - 1, 15_000, 'client B to catch up');
        expect(b.snapshots).toBeGreaterThanOrEqual(2);
        b.close();

        // 3. Reconnect once more and keep going (events + ticks) on the new connection.
        const c = await client();
        for (const p of burstQueues(`zt-after-${discovery ? 'd' : 'n'}`, 4, 10).flat()) await post(p);

        // 4. Every RPC route the plugins register, with empty params: direct, over WebSocket and over HTTP.
        const methods = mods.plugins.defaultPlugins().flatMap((p) => Object.keys(p.routes ?? {}).map((r) => `${p.name}.${r}`));
        expect(methods.length).toBeGreaterThan(0);
        const rpc: Record<string, string> = {};
        for (const method of methods) {
          const direct = await monitor.rpc(method, {}).then(
            () => 'ok',
            (e: Error) => `error: ${e.message.slice(0, 60)}`,
          );
          const ws = await c.rpc(method, {});
          const h = await http(port, { path: `/api/rpc/${method}?params=${encodeURIComponent('{}')}`, headers: { [TOKEN_HEADER]: token } });
          expect([200, 400]).toContain(h.status); // answered or rejected by validation; never a crash or a hang
          expect(ws.ok).toBe(direct === 'ok');
          rpc[method] = direct;
        }
        m.rpc = rpc;

        // 5. Several short ticks (100 ms) plus discovery/meta/spool timers.
        const ticksBefore = c.ticks;
        await sleep(1_500);
        expect(c.ticks - ticksBefore).toBeGreaterThanOrEqual(5);

        // 6. The reconnected client mirrors the monitor exactly (compared at the same sequence).
        await until(() => c.synced && c.state.lastSeq === monitor.getState().lastSeq, 10_000, 'client C to converge');
        expect(c.state).toEqual(monitor.getState());
        for (const x of clients) expect(x.gaps).toBe(0);

        if (discovery) {
          const live = monitor.getState().agents['zt-live-session-0001'];
          expect(live).toMatchObject({ title: 'Zero token runtime check', registryName: 'zt-live' });
          expect(JSON.stringify(monitor.getState())).not.toContain('SECRET');
        }

        // 7. The inference guard's counters (published contract, and the guard module itself when present).
        const inf = monitor.getMeta().plugins?.inference as Partial<InferenceDiagnostics> | undefined;
        if (inf && typeof inf.officeInferenceCalls === 'number') {
          expect(inf.officeInferenceCalls).toBe(0);
          expect(inf.externalRequests).toBe(0);
          m.inferenceMeta = { guard: inf.guard, officeInferenceCalls: inf.officeInferenceCalls, externalRequests: inf.externalRequests, loopbackRequests: (inf as Record<string, unknown>).loopbackRequests, processLaunches: (inf as Record<string, unknown>).processLaunches };
        } else {
          m.inferenceMeta = 'not exposed';
        }
        if (guardDiagnostics) {
          const d = guardDiagnostics();
          expect(d.officeInferenceCalls).toBe(0);
          expect(d.externalRequests).toBe(0);
        }
        expect(logs.filter((l) => /failed to (start|stop)|BLOCKED/i.test(l))).toEqual([]);

        m.events = { simulated: simEvents, burst, lastSeq: monitor.getState().lastSeq, agents: Object.keys(monitor.getState().agents).length };

        // 8. Shutdown: after stop() nothing runs any more (no tick, scan, plugin timer or call),
        //    the guard is released and its counters are still 0.
        for (const x of clients) x.close();
        await sleep(50);
        const stopAt = Date.now();
        await monitor.stop();
        stopped = true;
        m.stopMs = Date.now() - stopAt;
        const afterStop = calls.length;
        const seqAtStop = monitor.getState().lastSeq;
        await sleep(600); // several tick, meta, spool and discovery intervals
        expect(calls.slice(afterStop)).toEqual([]);
        expect(monitor.getState().lastSeq).toBe(seqAtStop);
        await expect(http(port, { path: '/api/health' })).rejects.toThrow();
        if (guardDiagnostics) {
          const d = guardDiagnostics();
          expect(d.guard).toBe('inactive');
          expect(d.officeInferenceCalls).toBe(0);
          expect(d.externalRequests).toBe(0);
          m.guardAfterStop = { guard: d.guard, officeInferenceCalls: d.officeInferenceCalls, externalRequests: d.externalRequests };
        }
        expect(logs.filter((l) => /failed to stop/i.test(l))).toEqual([]);
      } finally {
        for (const x of clients) x.close();
        if (!stopped) await monitor.stop();
        home.cleanup();
        claude.cleanup();
        summary[`discovery_${discovery ? 'on' : 'off'}`] = m;
      }
    }, 120_000);
  }

  it('no Claude launch, only git processes, and only loopback connections were made', () => {
    const processes = calls.filter((c) => c.api.startsWith('child_process.'));
    const network = calls.filter((c) => c.host !== undefined);
    const external = network.filter((c) => !isLoopback(c.host));
    const byApi: Record<string, number> = {};
    for (const c of calls) byApi[c.api] = (byApi[c.api] ?? 0) + 1;
    summary.calls = byApi;
    summary.processes = { total: processes.length, git: processes.filter(isGit).length };
    summary.externalConnections = external.map((c) => `${c.api} ${c.host}`);
    if (guardDiagnostics) {
      const d = guardDiagnostics();
      summary.guardAfterRuns = { officeInferenceCalls: d.officeInferenceCalls, externalRequests: d.externalRequests };
      expect(d.officeInferenceCalls).toBe(0);
      expect(d.externalRequests).toBe(0);
    }

    expect(network.length).toBeGreaterThan(100); // the spies really saw the traffic
    expect(processes.filter(isClaudeLaunch)).toEqual([]);
    expect(processes.filter((c) => !isGit(c)).map((c) => `${c.api} ${c.file}`)).toEqual([]);
    expect(external).toEqual([]);
  });

  it('classifier sanity (no network involved)', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('api.anthropic.com')).toBe(false);
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(isClaudeLaunch({ api: 'x', file: 'C:\\Users\\me\\.local\\bin\\claude.exe', args: [] })).toBe(true);
    expect(isClaudeLaunch({ api: 'x', file: 'npx', args: ['@anthropic-ai/claude-code', '-p', 'hi'] })).toBe(true);
    expect(isClaudeLaunch({ api: 'x', file: 'git', args: ['status', '--porcelain'] })).toBe(false);
    expect(isGit({ api: 'x', file: 'C:\\Program Files\\Git\\cmd\\git.exe' })).toBe(true);
    expect(httpHost([{ host: '127.0.0.1', port: 80 }])).toBe('127.0.0.1');
    expect(httpHost(['https://api.anthropic.com/v1/messages'])).toBe('api.anthropic.com');
    expect(netHost([443, 'bedrock-runtime.us-east-1.amazonaws.com'])).toBe('bedrock-runtime.us-east-1.amazonaws.com');
    expect(netHost(['\\\\.\\pipe\\x'])).toBe('ipc');
  });
});
