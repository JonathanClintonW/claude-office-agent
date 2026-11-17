/**
 * Zero-extra-inference, runtime half: the guard is installed in this test process, a monitor
 * with every default plugin runs a long mock workload, and the guard must observe zero
 * office-generated inference and zero external requests. Detection is proven with deliberate
 * inference attempts that are blocked before anything runs or leaves the machine.
 */
import { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { get as httpGet, request as httpRequest } from 'node:http';
import { get as httpsGet, request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_HEADER, type InferencePluginMeta } from '@agent-office/core';
import { loadOrCreateConfig } from '../src/config';
import {
  acquireInferenceGuard,
  classifyHost,
  classifyLaunch,
  compileHostPatterns,
  DEFAULT_INFERENCE_HOSTS,
  inferenceGuardDiagnostics,
  InferenceBlockedError,
  inferenceHostsFromEnv,
  installInferenceGuard,
  isInferenceGuardActive,
  resetInferenceGuard,
  uninstallInferenceGuard,
} from '../src/inferenceGuard';
import type { MonitorPlugin } from '../src/plugin';
import { defaultPlugins } from '../src/plugins';
import { inferencePlugin } from '../src/plugins/inference';
import { createMonitor } from '../src/server';
import { buildScenario, endScenario } from '../src/simulate';
import { appendToSpool } from '../src/spool';
import { freePort, http, MirrorClient, sleep, tempDir } from './helpers';

const nodeHttp = process.getBuiltinModule('node:http');
const nodeCp = process.getBuiltinModule('node:child_process');

function claudeDirFixture(dir: string, sid: string): void {
  const proj = join(dir, 'projects', 'c--work-guarded');
  mkdirSync(join(proj, sid, 'subagents'), { recursive: true });
  const now = Date.now();
  const lines = [
    { type: 'user', cwd: 'c:\\work\\guarded', timestamp: new Date(now - 4000).toISOString(), message: { role: 'user', content: '[mock prompt]' } },
    { type: 'ai-title', aiTitle: 'Guarded session', sessionId: sid },
    {
      type: 'assistant',
      timestamp: new Date(now - 1000).toISOString(),
      cwd: 'c:\\work\\guarded',
      message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: '[mock reply]' }], usage: { input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 50 } },
    },
  ];
  writeFileSync(join(proj, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(join(proj, sid, 'subagents', 'agent-g1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Look around', finished: true }));
  writeFileSync(join(proj, sid, 'subagents', 'agent-g1.jsonl'), '{}\n');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  writeFileSync(join(dir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, status: 'busy', statusUpdatedAt: now - 500, cwd: 'c:\\work\\guarded' }));
}

beforeAll(() => {
  uninstallInferenceGuard();
  resetInferenceGuard();
  installInferenceGuard({ env: {} }); // deterministic: ignore ANTHROPIC_*_BASE_URL of the developer's shell
});
afterAll(() => uninstallInferenceGuard());

describe('zero office inference at runtime', () => {
  it('a long monitored workload through every default plugin makes no inference calls and no external requests', async () => {
    expect(isInferenceGuardActive()).toBe(true);
    resetInferenceGuard();
    const home = tempDir('inference-home');
    const claude = tempDir('inference-claude');
    const plugins: MonitorPlugin[] = defaultPlugins();
    const port = await freePort();
    const token = loadOrCreateConfig(home.path, { port }).token;
    claudeDirFixture(claude.path, 'guarded-session-1');
    const monitor = createMonitor({
      home: home.path,
      port,
      token,
      claudeDirs: [claude.path],
      plugins,
      transcriptWindowMs: 3_600_000,
      registryIntervalMs: 30,
      transcriptIntervalMs: 60,
      tickIntervalMs: 40,
      spoolIntervalMs: 50,
      metaIntervalMs: 50,
    });
    try {
      await monitor.start();
      // A long mock session: several runs of the scripted scenario (3 sessions, subagents, teammates,
      // tasks, permissions, failures), delivered directly, over HTTP and through the spool.
      const t0 = Date.now() - 120_000;
      let n = 0;
      for (let run = 0; run < 8; run++) {
        const runId = `guard${run}`;
        for (const s of buildScenario(runId)) {
          const env = { v: 1, ts: t0 + run * 20_000 + s.at, payload: s.payload };
          if (n % 25 === 0) {
            const r = await http(port, { method: 'POST', path: '/api/hook', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token }, body: JSON.stringify(env) });
            expect(r.status).toBe(204);
          } else if (n % 25 === 1) {
            appendToSpool(home.path, JSON.stringify(env));
          } else {
            expect(monitor.ingestHook(env).ok).toBe(true);
          }
          n += 1;
        }
        for (const e of endScenario(runId)) monitor.ingestHook(e);
      }
      expect(n).toBeGreaterThan(400);
      await monitor.scanNow();

      // Every RPC route of every default plugin, with empty params (rejections are fine), directly,
      // over the WebSocket and over HTTP.
      const methods = plugins.flatMap((p) => Object.keys(p.routes ?? {}).map((r) => `${p.name}.${r}`));
      expect(methods).toContain('inference.diagnostics');
      for (const m of methods) await monitor.rpc(m, {}).catch(() => undefined);
      const client = new MirrorClient(port, token);
      await client.opened();
      await client.waitFor((c) => c.messages.some((m) => m.type === 'snapshot'));
      methods.forEach((method, i) => client.ws.send(JSON.stringify({ type: 'rpc', id: i + 1, method, params: {} })));
      client.ws.send(JSON.stringify({ type: 'resync' }));
      await client.waitFor((c) => c.messages.filter((m) => m.type === 'rpcResult').length === methods.length, 20_000);
      for (const m of methods) await http(port, { path: `/api/rpc/${m}?params=%7B%7D`, headers: { [TOKEN_HEADER]: token } });
      client.close();

      // Let every periodic timer (registry, transcripts, ticks, spool, meta, plugin timers) run many times.
      await sleep(800);
      const second = new MirrorClient(port, token);
      await second.opened();
      await second.waitFor((c) => c.messages.some((m) => m.type === 'snapshot'));
      second.close();
      await monitor.scanNow();

      const state = monitor.getState();
      expect(state.agents['guarded-session-1']).toMatchObject({ title: 'Guarded session' });
      expect(Object.keys(state.agents).filter((k) => k.startsWith('sim-')).length).toBeGreaterThan(3);

      const meta = monitor.getMeta().plugins?.inference as InferencePluginMeta;
      expect(meta).toMatchObject({ guard: 'active', host: 'node', officeInferenceCalls: 0, externalRequests: 0, blocked: 0 });
      expect(meta.instrumented).toEqual(expect.arrayContaining(['http', 'https', 'fetch', 'child_process']));
      expect(meta.staticCheck).toBe('packages/monitor/test/staticNoInference.test.ts');
      expect(meta.hookScopes).toMatchObject({ duplicateEvents: [] });
    } finally {
      await monitor.stop();
      home.cleanup();
      claude.cleanup();
    }
    const d = inferenceGuardDiagnostics();
    expect(d.officeInferenceCalls).toBe(0);
    expect(d.externalRequests).toBe(0);
    expect(d.blocked).toBe(0);
    expect(d.lastViolation).toBeUndefined();
    // Only read-only git may be launched by the office runtime (no browser opener here, nothing else).
    expect(d.processLaunches).toMatchObject({ browser: 0, other: 0 });
    // The guard really observed this traffic: the test's own HTTP and WebSocket calls are loopback requests.
    expect(d.loopbackRequests).toBeGreaterThan(10);
    // The monitor's plugin released its hold; the manual install keeps the guard active.
    expect(isInferenceGuardActive()).toBe(true);
  }, 60_000);

  // Safety nets: even if the guard were broken, these attempts could not reach the network
  // (DNS is a local function that fails, fetch signals are pre-aborted) or run Claude
  // (`--version` only, and the working directory does not exist so no process can start).
  const offline = ((_h: string, _o: unknown, cb: (e: Error) => void) => cb(new Error('offline test'))) as never;
  const NOWHERE = join(tmpdir(), 'agent-office-guard-nonexistent-dir');

  it('blocks and counts requests to inference hosts before anything leaves the machine', async () => {
    resetInferenceGuard();
    const net = { lookup: offline, agent: false } as const;
    const attempts: Array<() => unknown> = [
      () => httpsRequest('https://api.anthropic.com/v1/messages', { method: 'POST', ...net }),
      () => httpsGet({ hostname: 'API.Anthropic.com.', path: '/v1/models', ...net }),
      () => httpsRequest(new URL('https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke'), net),
      () => httpRequest({ host: 'claude.ai', port: 80, path: '/', ...net }),
      () => httpGet('http://bedrock-mantle.eu-west-1.api.aws/anthropic/v1/messages', net),
      () => httpsRequest({ host: 'my-resource.services.ai.azure.com', path: '/anthropic/v1/messages', ...net }),
    ];
    for (const a of attempts) expect(a).toThrow(InferenceBlockedError);
    const signal = AbortSignal.abort();
    await expect(fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}', signal })).rejects.toBeInstanceOf(InferenceBlockedError);
    await expect(fetch(new URL('https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/l'), { signal })).rejects.toBeInstanceOf(InferenceBlockedError);
    await expect(fetch(new Request('https://claude.googleapis.com/v1/messages', { signal }))).rejects.toBeInstanceOf(InferenceBlockedError);
    const d = inferenceGuardDiagnostics();
    expect(d).toMatchObject({ officeInferenceCalls: attempts.length + 3, blocked: attempts.length + 3, externalRequests: 0 });
    expect(d.lastViolation).toMatchObject({ kind: 'inference:fetch', target: 'https://claude.googleapis.com' }); // origin only, never paths or queries
  });

  it('blocks WebSockets to inference hosts (a configured loopback port stands in for the remote host)', () => {
    uninstallInferenceGuard();
    installInferenceGuard({ env: {}, inferenceHosts: ['127.0.0.1:9'] });
    resetInferenceGuard();
    try {
      expect(typeof globalThis.WebSocket).toBe('function');
      expect(() => new WebSocket('ws://127.0.0.1:9/v1/socket')).toThrow(InferenceBlockedError);
      expect(() => httpRequest({ host: '127.0.0.1', port: 9, lookup: offline })).toThrow(InferenceBlockedError);
      expect(inferenceGuardDiagnostics()).toMatchObject({ officeInferenceCalls: 2, lastViolation: { kind: 'inference:http', target: 'http://127.0.0.1:9' } });
    } finally {
      uninstallInferenceGuard();
      installInferenceGuard({ env: {} });
    }
  });

  it('blocks and counts every way of launching Claude; nothing runs (the throw is synchronous, before spawning)', () => {
    resetInferenceGuard();
    const noop = () => {};
    const o = { cwd: NOWHERE, stdio: 'ignore' as const, windowsHide: true };
    const attempts: Array<() => unknown> = [
      () => spawn('claude', ['--version', '--marker-SECRET'], o),
      () => spawn('C:\\Users\\dev\\.local\\bin\\claude.exe', ['--version'], o),
      () => spawnSync('claude', ['--version'], o),
      () => execFile('claude', ['--version', '--marker-SECRET'], { cwd: NOWHERE }, noop),
      () => execFileSync('/usr/local/bin/claude', ['--version'], o),
      () => exec('claude --version --marker-SECRET', { cwd: NOWHERE }, noop),
      () => execSync('npx @anthropic-ai/claude-code --version', o),
      () => spawn('echo x && claude --version', { ...o, shell: true }),
      () => spawn('cmd.exe', ['/d', '/s', '/c', 'claude', '--version'], o),
      () => spawn('powershell', ['-NoProfile', '-Command', '& claude --version'], o),
      () => spawn(process.execPath, ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', '--version'], o),
      () => fork('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', ['--version'], { cwd: NOWHERE, silent: true }),
    ];
    for (const a of attempts) expect(a).toThrow(InferenceBlockedError);
    const d = inferenceGuardDiagnostics();
    expect(d.officeInferenceCalls).toBe(attempts.length);
    expect(d.blocked).toBe(attempts.length);
    expect(d.processLaunches).toEqual({ git: 0, browser: 0, other: 0 });
    expect(d.lastViolation).toMatchObject({ kind: 'claude-process:fork', target: 'node (launches Claude)' });
    expect(JSON.stringify(d)).not.toContain('SECRET'); // arguments are never stored
  });

  it('counts loopback, external and allowed process launches without blocking them', async () => {
    resetInferenceGuard();
    // loopback and external requests whose DNS lookup is a local function that fails: nothing is sent
    for (const host of ['localhost', 'example.com']) {
      await new Promise<void>((done) => {
        const r = httpRequest({ host, path: '/', agent: false, lookup: offline });
        r.on('error', () => done());
        r.end();
      });
    }
    // external fetch with an already-aborted signal: rejected before any connection
    await expect(fetch('http://192.0.2.1/', { signal: AbortSignal.abort() })).rejects.toThrow();
    // a harmless local process (not Claude, not git): allowed and counted
    expect(spawnSync(process.execPath, ['-e', '0']).status).toBe(0);
    const d = inferenceGuardDiagnostics();
    expect(d).toMatchObject({ officeInferenceCalls: 0, externalRequests: 2, loopbackRequests: 1 });
    expect(d.processLaunches).toEqual({ git: 0, browser: 0, other: 1 });
    expect(d.lastViolation).toMatchObject({ kind: 'external:fetch', target: 'http://192.0.2.1' });
  });
});

describe('inference guard lifecycle', () => {
  it('install is idempotent, uninstall restores the original functions (CJS objects and ESM bindings)', () => {
    uninstallInferenceGuard();
    const original = { request: nodeHttp.request, spawn: nodeCp.spawn, fetch: globalThis.fetch };
    expect(httpRequest).toBe(original.request);
    installInferenceGuard({ env: {} });
    const wrapped = nodeHttp.request;
    expect(wrapped).not.toBe(original.request);
    expect(httpRequest).toBe(wrapped); // ESM named imports were re-synced
    expect(spawn).toBe(nodeCp.spawn);
    expect(spawn).not.toBe(original.spawn);
    installInferenceGuard({ env: {} });
    expect(nodeHttp.request).toBe(wrapped); // not wrapped twice
    uninstallInferenceGuard();
    uninstallInferenceGuard();
    expect(nodeHttp.request).toBe(original.request);
    expect(httpRequest).toBe(original.request);
    expect(spawn).toBe(original.spawn);
    expect(globalThis.fetch).toBe(original.fetch);
    expect(inferenceGuardDiagnostics()).toMatchObject({ guard: 'inactive', instrumented: [] });
    installInferenceGuard({ env: {} });
  });

  it('acquire/release is reference counted and never removes a manual install', () => {
    uninstallInferenceGuard();
    const r1 = acquireInferenceGuard();
    const r2 = acquireInferenceGuard();
    r1();
    r1(); // idempotent
    expect(isInferenceGuardActive()).toBe(true);
    r2();
    expect(isInferenceGuardActive()).toBe(false);
    installInferenceGuard({ env: {} });
    acquireInferenceGuard()();
    expect(isInferenceGuardActive()).toBe(true);
  });

  it('never patches the shared VS Code extension host and reports itself inactive there', async () => {
    uninstallInferenceGuard();
    const before = nodeHttp.request;
    const electron = { ...process.versions, electron: '37.2.0' };
    expect(installInferenceGuard({ versions: electron })).toMatchObject({ guard: 'inactive', instrumented: [], host: 'electron' });
    expect(inferenceGuardDiagnostics().inactiveReason).toMatch(/VS Code extension host/);
    expect(nodeHttp.request).toBe(before);
    uninstallInferenceGuard();

    const plugin = inferencePlugin({ guardOptions: { versions: electron } });
    const home = tempDir('inference-electron');
    const port = await freePort();
    const monitor = createMonitor({ home: home.path, port, token: 't'.repeat(32), claudeDirs: [home.path], discovery: false, plugins: [plugin], tickIntervalMs: 3_600_000 });
    try {
      await monitor.start();
      expect(monitor.getMeta().plugins?.inference).toMatchObject({ guard: 'inactive', instrumented: [], host: 'electron', officeInferenceCalls: 0 });
      expect(nodeHttp.request).toBe(before);
    } finally {
      await monitor.stop();
      home.cleanup();
    }
    installInferenceGuard({ env: {} });
    expect(isInferenceGuardActive()).toBe(true);
  });
});

describe('inference plugin', () => {
  it('reports Agent Office hooks installed in both user settings and a running session\'s project', async () => {
    const root = tempDir('inference-scopes');
    const claudeDir = join(root.path, 'claude');
    const project = join(root.path, 'project');
    const ours = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['x/agent-office-hook.cjs'], async: true }] }] } });
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), ours);
    writeFileSync(join(project, '.claude', 'settings.local.json'), ours);
    const port = await freePort();
    const monitor = createMonitor({ home: root.path, port, token: 't'.repeat(32), claudeDirs: [claudeDir], discovery: false, plugins: [inferencePlugin({ guard: false })], tickIntervalMs: 3_600_000 });
    try {
      await monitor.start();
      expect((monitor.getMeta().plugins?.inference as InferencePluginMeta).hookScopes?.duplicateEvents).toEqual([]);
      monitor.ingestHook({ session_id: 'scoped-1', hook_event_name: 'SessionStart', cwd: project });
      const d = (await monitor.rpc('inference.diagnostics')) as InferencePluginMeta;
      expect(d.hookScopes?.duplicateEvents).toEqual(['Stop']);
      expect(d.hookScopes?.scopes.map((s) => s.scope)).toEqual(['user', 'project-local']);
      // guard: false leaves the runtime guard to its other owners (here: the test's manual install)
      expect(d.guard).toBe('active');
    } finally {
      await monitor.stop();
      root.cleanup();
    }
  });
});

describe('classification', () => {
  it('recognises Claude inference hosts, loopback and everything else', () => {
    const inference = [
      'api.anthropic.com',
      'API.ANTHROPIC.COM.',
      'anthropic.com',
      'statsig.anthropic.com',
      'claude.ai',
      'www.claude.ai',
      'bedrock-runtime.us-east-1.amazonaws.com',
      'bedrock-runtime-fips.us-gov-west-1.amazonaws.com',
      'bedrock-mantle.eu-central-1.api.aws',
      'aws-external-anthropic.us-west-2.api.aws',
      'aiplatform.googleapis.com',
      'europe-west1-aiplatform.googleapis.com',
      'claude.googleapis.com',
      'my-res.services.ai.azure.com',
    ];
    for (const h of inference) expect(classifyHost(h), h).toBe('inference');
    for (const h of ['127.0.0.1', '127.8.9.10', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1']) expect(classifyHost(h), h).toBe('loopback');
    for (const h of ['anthropic.com.evil.example', 'notanthropic.com', 's3.amazonaws.com', 'github.com', '10.0.0.5', 'claude.ai.example.net', 'code.claude.com'])
      expect(classifyHost(h), h).toBe('external');
    expect(DEFAULT_INFERENCE_HOSTS).toEqual(expect.arrayContaining(['anthropic.com', '*.anthropic.com', 'claude.ai', 'bedrock-runtime.*.amazonaws.com', '*aiplatform.googleapis.com']));
  });

  it('treats Claude base-URL overrides and configured hosts as inference, port-aware for local proxies', () => {
    const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000/v1', ANTHROPIC_VERTEX_BASE_URL: 'https://vertex-proxy.corp.example', AGENT_OFFICE_INFERENCE_HOSTS: 'llm.corp.example, *.gateway.example:8443', PATH: '/bin' };
    const hosts = inferenceHostsFromEnv(env);
    expect(hosts).toHaveLength(4);
    const p = compileHostPatterns([...DEFAULT_INFERENCE_HOSTS, ...hosts]);
    expect(classifyHost('127.0.0.1', 4000, p)).toBe('inference');
    expect(classifyHost('127.0.0.1', 47821, p)).toBe('loopback');
    expect(classifyHost('vertex-proxy.corp.example', 443, p)).toBe('inference');
    expect(classifyHost('llm.corp.example', 80, p)).toBe('inference');
    expect(classifyHost('eu.gateway.example', 8443, p)).toBe('inference');
    expect(classifyHost('eu.gateway.example', 443, p)).toBe('external');
  });

  it('classifies process launches: Claude in any disguise, git, the loopback browser opener, other', () => {
    const url = 'http://127.0.0.1:47821/';
    const cases: Array<[string, string[], boolean, string]> = [
      ['claude', ['-p', 'x'], false, 'claude'],
      ['C:\\Program Files\\Claude\\claude.exe', [], false, 'claude'],
      ['/opt/homebrew/bin/claude', ['--resume'], false, 'claude'],
      ['claude.cmd', [], false, 'claude'],
      ['node', ['/x/node_modules/@anthropic-ai/claude-code/cli.js'], false, 'claude'],
      ['npx', ['-y', '@anthropic-ai/claude-code'], false, 'claude'],
      ['bash', ['-lc', 'cd /w && claude -p hi'], false, 'claude'],
      ['claude --version', [], true, 'claude'],
      ['git status && claude', [], true, 'claude'],
      ['git', ['-C', 'c:\\work\\app', 'status', '--porcelain=v2'], false, 'git'],
      ['C:\\Program Files\\Git\\cmd\\git.exe', ['rev-parse', 'HEAD'], false, 'git'],
      ['git status --porcelain', [], true, 'git'],
      ['git status; rm -rf /', [], true, 'other'],
      ['rundll32', ['url.dll,FileProtocolHandler', url], false, 'browser'],
      ['open', [url], false, 'browser'],
      ['xdg-open', [url], false, 'browser'],
      ['xdg-open', ['https://example.com/'], false, 'other'],
      ['open', ['-a', 'Claude'], false, 'other'],
      ['node', ['-e', '0'], false, 'other'],
      ['esbuild', ['--service=0.28.2'], false, 'other'],
      ['claude-agent-viewer', [], false, 'other'],
    ];
    for (const [file, args, shell, want] of cases) expect(classifyLaunch(file, args, shell), `${file} ${args.join(' ')}`).toBe(want);
  });
});
