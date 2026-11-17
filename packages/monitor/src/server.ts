import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createInitialState,
  normalizeHookPayload,
  PROTOCOL_VERSION,
  reduce,
  RPC_METHOD,
  systemEvent,
  TERMINAL_STATUSES,
  TOKEN_HEADER,
  validateLayout,
  type ClaudeDirStatus,
  type ClientMessage,
  type MonitorEvent,
  type MonitorMeta,
  type NormalizeResult,
  type OfficeLayout,
  type OfficeState,
  type ServerMessage,
} from '@agent-office/core';
import { isPidAlive, readRegistry, type RegistryEntry } from './discovery/registry';
import { GuardedReader, listSubagents, listTranscripts, readTranscriptInfo, type TranscriptInfo } from './discovery/transcripts';
import { inspectClaudeDir } from './hooks';
import { drainSpool } from './spool';
import { createDeduper } from './dedupe';
import type { MonitorPlugin, PluginContext } from './plugin';
import { loadLayout, loadState, saveLayout, saveState } from './store';

export const MONITOR_VERSION = '0.1.0';
const MAX_HOOK_BODY = 16 * 1024 * 1024;
const MAX_WS_BUFFER = 8 * 1024 * 1024;

export interface MonitorOptions {
  home: string;
  port: number;
  token: string;
  claudeDirs: string[];
  /** Directory with the built UI (index.html + assets). Optional. */
  uiDir?: string;
  /** Extra browser origins allowed to open the WebSocket (e.g. the Vite dev server). */
  allowedOrigins?: string[];
  persist?: boolean;
  discovery?: boolean;
  registryIntervalMs?: number;
  transcriptIntervalMs?: number;
  tickIntervalMs?: number;
  spoolIntervalMs?: number;
  metaIntervalMs?: number;
  /** Transcripts modified within this window are considered for discovery. */
  transcriptWindowMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
  /** Override the transcript reader (tests). */
  readTranscript?: (file: string) => Promise<TranscriptInfo>;
  /** Per-file read budget for transcripts. */
  transcriptReadTimeoutMs?: number;
  /** Passive extensions (history, usage, git, inference guard). See plugin.ts. */
  plugins?: MonitorPlugin[];
}

export interface Monitor {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  readonly port: number;
  getState(): OfficeState;
  getMeta(): MonitorMeta;
  getLayout(): OfficeLayout;
  /** Ingest a hook payload directly (used by tests and the embedded VS Code monitor). */
  ingestHook(raw: unknown, receivedAt?: number): NormalizeResult;
  /** Run one discovery pass immediately (registry + transcripts + spool). */
  scanNow(): Promise<void>;
  /** Invoke a plugin RPC route directly (same path as WebSocket/HTTP RPC). */
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

interface RegistrySeen {
  fingerprint: string;
  pid: number;
}

export function createMonitor(opts: MonitorOptions): Monitor {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const persist = opts.persist ?? true;
  const discovery = opts.discovery ?? true;
  const transcriptWindowMs = opts.transcriptWindowMs ?? 30 * 60_000;

  let state: OfficeState = createInitialState();
  let layout: OfficeLayout = loadLayout(opts.home);
  let seq = 0;
  const startedAt = now();
  let server: Server | undefined;
  let wss: WebSocketServer | undefined;
  let port = opts.port;
  const clients = new Set<WebSocket>();
  const alive = new WeakSet<WebSocket>();
  const timers: NodeJS.Timeout[] = [];
  let pendingBroadcast: MonitorEvent[] = [];
  let flushScheduled = false;
  let saveTimer: NodeJS.Timeout | undefined;
  let rejected = 0;
  let replayed = 0;
  const deduper = createDeduper();
  let duplicatesDropped = 0;
  let lastRegistryScanAt: number | undefined;
  let lastTranscriptScanAt: number | undefined;
  let claudeDirStatus: ClaudeDirStatus[] = opts.claudeDirs.map((d) => inspectClaudeDir(d));
  const registrySeen = new Map<string, RegistrySeen>();
  const transcriptSeen = new Map<string, string>();
  const subagentSeen = new Map<string, string>();
  const transcriptReadAt = new Map<string, number>();
  const reader = new GuardedReader(opts.readTranscript ?? readTranscriptInfo, opts.transcriptReadTimeoutMs ?? 2500);
  // Each discovery lane is serialised (a request made while one runs is queued, never dropped).
  // Registry and transcripts use separate lanes so slow transcript I/O never delays liveness.
  const lanes = new Map<string, { chain: Promise<void>; queued: boolean }>();
  function enqueue(lane: 'registry' | 'transcripts', fn: () => Promise<void>): Promise<void> {
    const l = lanes.get(lane) ?? { chain: Promise.resolve(), queued: false };
    lanes.set(lane, l);
    if (l.queued) return l.chain;
    l.queued = true;
    l.chain = l.chain
      .then(async () => {
        l.queued = false;
        await fn();
      })
      .catch((e) => log(`${lane} scan failed: ${(e as Error).message}`));
    return l.chain;
  }

  const plugins = opts.plugins ?? [];
  const startedPlugins = new Set<MonitorPlugin>();
  const routes = new Map<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>();
  for (const p of plugins) {
    for (const [route, handler] of Object.entries(p.routes ?? {})) {
      const method = `${p.name}.${route}`;
      if (!RPC_METHOD.test(method)) throw new Error(`invalid plugin route name: ${method}`);
      if (routes.has(method)) throw new Error(`duplicate plugin route: ${method}`);
      routes.set(method, handler);
    }
  }

  if (persist) {
    const restored = loadState(opts.home);
    if (restored) {
      state = restored;
      seq = restored.lastSeq;
      apply(systemEvent({ kind: 'Restored' }, { ts: now(), sessionId: '*' }));
      log(`restored ${Object.keys(restored.agents).length} agents from snapshot`);
    }
  }

  async function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (typeof method !== 'string' || !RPC_METHOD.test(method)) throw new Error('invalid method');
    const handler = routes.get(method);
    if (!handler) throw new Error(`unknown method ${method}`);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('rpc timed out')), 20_000);
      timer.unref?.();
    });
    try {
      return await Promise.race([Promise.resolve().then(() => handler(params)), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  function meta(): MonitorMeta {
    const m: MonitorMeta = {
      protocol: PROTOCOL_VERSION,
      monitorVersion: MONITOR_VERSION,
      startedAt,
      claudeDirs: claudeDirStatus,
      rejectedEvents: rejected,
      spooledEventsReplayed: replayed,
    };
    if (duplicatesDropped) m.duplicatesDropped = duplicatesDropped;
    if (state.lastHookEventAt) m.lastHookEventAt = state.lastHookEventAt;
    if (lastRegistryScanAt) m.lastRegistryScanAt = lastRegistryScanAt;
    if (lastTranscriptScanAt) m.lastTranscriptScanAt = lastTranscriptScanAt;
    const contributed: Record<string, unknown> = {};
    for (const p of plugins) {
      if (!p.meta) continue;
      try {
        contributed[p.name] = p.meta();
      } catch (e) {
        contributed[p.name] = { error: (e as Error).message };
      }
    }
    if (Object.keys(contributed).length) m.plugins = contributed;
    return m;
  }

  function sendRaw(ws: WebSocket, data: string): void {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_WS_BUFFER) {
      ws.terminate(); // slow consumer: it will reconnect and resync
      return;
    }
    ws.send(data);
  }

  function send(ws: WebSocket, msg: ServerMessage): void {
    sendRaw(ws, JSON.stringify(msg));
  }

  function broadcast(msg: ServerMessage): void {
    if (!clients.size) return;
    const data = JSON.stringify(msg); // serialise once for all clients
    for (const c of clients) sendRaw(c, data);
  }

  /** Drop discovery bookkeeping for sessions the state no longer knows (bounded memory). */
  function pruneSeen(): void {
    const sessions = new Set(Object.values(state.agents).map((a) => a.sessionId));
    for (const k of transcriptSeen.keys()) if (!sessions.has(k)) transcriptSeen.delete(k);
    for (const k of transcriptReadAt.keys()) if (!sessions.has(k)) transcriptReadAt.delete(k);
    for (const k of subagentSeen.keys()) if (!sessions.has(k.split('::')[0]!)) subagentSeen.delete(k);
  }

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    setImmediate(() => {
      flushScheduled = false;
      if (!pendingBroadcast.length) return;
      const events = pendingBroadcast;
      pendingBroadcast = [];
      broadcast({ type: 'events', events });
    });
  }

  function scheduleSave(): void {
    if (!persist || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      try {
        saveState(opts.home, state);
      } catch (e) {
        log(`failed to persist state: ${(e as Error).message}`);
      }
    }, 2000);
  }

  function apply(ev: MonitorEvent): void {
    const sequenced = { ...ev, seq: ++seq } as MonitorEvent;
    state = reduce(state, sequenced);
    for (const p of startedPlugins) {
      try {
        p.onEvent?.(sequenced, state);
      } catch (e) {
        log(`plugin ${p.name} onEvent failed: ${(e as Error).message}`);
      }
    }
    pendingBroadcast.push(sequenced);
    scheduleFlush();
    scheduleSave();
  }

  function ingestHook(raw: unknown, receivedAt = now()): NormalizeResult {
    const r = normalizeHookPayload(raw, receivedAt);
    if (r.ok) {
      // Hooks installed in two scopes (user + project) deliver every event twice.
      if (deduper.isDuplicate(raw, receivedAt)) {
        duplicatesDropped += 1;
        return r;
      }
      apply(r.event);
    } else {
      rejected += 1;
      log(`rejected hook payload: ${r.error}`);
    }
    return r;
  }

  // ---------------- discovery ----------------

  function drain(): void {
    const items = drainSpool(opts.home);
    if (!items.length) return;
    const t = now();
    const results = items
      .map((raw) => ({ raw, r: normalizeHookPayload(raw, t) }))
      .filter((x): x is { raw: unknown; r: Extract<NormalizeResult, { ok: true }> } => x.r.ok)
      .sort((a, b) => a.r.event.ts - b.r.event.ts);
    let applied = 0;
    for (const { raw, r } of results) {
      if (deduper.isDuplicate(raw, t)) {
        duplicatesDropped += 1;
        continue;
      }
      apply(r.event);
      applied += 1;
    }
    replayed += applied;
    rejected += items.length - results.length;
    log(`replayed ${applied} spooled hook events`);
  }

  async function scanRegistry(): Promise<Set<string> | undefined> {
    const live = new Map<string, RegistryEntry>();
    let anyAvailable = false;
    for (const dir of opts.claudeDirs) {
      const r = await readRegistry(dir);
      if (!r.available) continue;
      anyAvailable = true;
      for (const e of r.entries) {
        const prev = live.get(e.sessionId);
        if (!prev || (e.updatedAt ?? 0) > (prev.updatedAt ?? 0)) live.set(e.sessionId, e);
      }
    }
    lastRegistryScanAt = now();
    if (!anyAvailable) return undefined;

    for (const e of live.values()) {
      const alive = isPidAlive(e.pid);
      const fingerprint = JSON.stringify([alive, e.pid, e.status, e.waitingFor, e.statusUpdatedAt, e.name, e.cwd]);
      if (registrySeen.get(e.sessionId)?.fingerprint === fingerprint) continue;
      registrySeen.set(e.sessionId, { fingerprint, pid: e.pid });
      const known = state.agents[e.sessionId];
      // Do not resurrect sessions that already ended unless the registry has newer news.
      if (known && TERMINAL_STATUSES.has(known.status) && !alive) continue;
      if (!known && !alive) continue; // stale file from a crashed process we never saw: nothing to show
      const fields: Parameters<typeof systemEvent>[1] = {
        ts: alive ? (e.statusUpdatedAt ?? e.updatedAt ?? now()) : now(),
        sessionId: e.sessionId,
        source: 'registry',
      };
      if (e.cwd) fields.cwd = e.cwd;
      const body = { kind: 'RegistryStatus' as const, pid: e.pid, alive } as Extract<MonitorEvent, { kind: 'RegistryStatus' }>;
      if (e.status) body.status = e.status;
      if (e.waitingFor) body.waitingFor = e.waitingFor;
      if (e.name) body.name = e.name;
      if (e.entrypoint) body.entrypoint = e.entrypoint;
      if (e.version) body.version = e.version;
      if (e.startedAt) body.startedAt = e.startedAt;
      apply(systemEvent(body, fields));
    }
    for (const [sessionId, seen] of registrySeen) {
      if (live.has(sessionId)) continue;
      registrySeen.delete(sessionId);
      const known = state.agents[sessionId];
      if (known && !TERMINAL_STATUSES.has(known.status)) {
        apply(systemEvent({ kind: 'RegistryGone', pid: seen.pid }, { ts: now(), sessionId, source: 'registry' }));
      }
    }
    return new Set(live.keys());
  }

  async function scanTranscripts(liveSessions: Set<string> | undefined): Promise<void> {
    const t = now();
    const include = new Set<string>(liveSessions ?? []);
    for (const a of Object.values(state.agents)) if (a.kind === 'session' && !TERMINAL_STATUSES.has(a.status)) include.add(a.sessionId);
    for (const dir of opts.claudeDirs) {
      const { files } = await listTranscripts(dir, { minMtimeMs: t - transcriptWindowMs, include });
      for (const f of files) {
        const known = state.agents[f.sessionId];
        const isLive = liveSessions ? liveSessions.has(f.sessionId) : undefined;
        // Only surface sessions that are running (registry) or recently active when no registry exists.
        // Recently-written transcripts outside the registry may belong to an older CLI; show them as unknown.
        if (!known) {
          if (isLive === false && t - f.mtimeMs > 2 * 60_000) continue;
        } else if (TERMINAL_STATUSES.has(known.status)) {
          continue;
        }
        const fp = `${f.mtimeMs}:${f.size}`;
        // Busy transcripts change constantly; re-read them at most once a minute.
        const recentlyRead = t - (transcriptReadAt.get(f.sessionId) ?? 0) < 60_000 && transcriptSeen.has(f.sessionId);
        if (transcriptSeen.get(f.sessionId) !== fp && !recentlyRead) {
          const info = await reader.info(f.path);
          if (info === 'busy') continue; // slow or locked: try again on a later pass
          transcriptSeen.set(f.sessionId, fp);
          transcriptReadAt.set(f.sessionId, t);
          const body = { kind: 'TranscriptSeen' as const } as Extract<MonitorEvent, { kind: 'TranscriptSeen' }>;
          if (info.title) body.title = info.title;
          if (info.model) body.model = info.model;
          if (info.usage) body.usage = info.usage;
          body.lastActivityAt = info.lastActivityAt ?? f.mtimeMs;
          // Absence from the registry is not proof of exit (older CLIs do not write it), so only 'live' is asserted.
          if (isLive) body.live = true;
          const fields: Parameters<typeof systemEvent>[1] = { ts: now(), sessionId: f.sessionId, source: 'transcript', transcriptPath: f.path };
          if (info.cwd) fields.cwd = info.cwd;
          apply(systemEvent(body, fields));
        }
        for (const s of await listSubagents(f.sessionDir, t - transcriptWindowMs)) {
          const key = `${f.sessionId}::${s.agentId}`;
          const sfp = `${s.mtimeMs}:${s.finished}`;
          if (subagentSeen.get(key) === sfp) continue;
          subagentSeen.set(key, sfp);
          const body = { kind: 'TranscriptSubagentSeen' as const, lastActivityAt: s.mtimeMs } as Extract<MonitorEvent, { kind: 'TranscriptSubagentSeen' }>;
          if (s.description) body.description = s.description;
          if (s.finished !== undefined) body.finished = s.finished;
          if (s.spawnToolUseId) body.spawnToolUseId = s.spawnToolUseId;
          const fields: Parameters<typeof systemEvent>[1] = { ts: now(), sessionId: f.sessionId, agentId: s.agentId, source: 'transcript' };
          if (s.agentType) fields.agentType = s.agentType;
          apply(systemEvent(body, fields));
        }
      }
    }
    lastTranscriptScanAt = now();
  }

  let lastLiveSessions: Set<string> | undefined;
  async function scanNow(): Promise<void> {
    drain();
    if (!discovery) return;
    await enqueue('registry', async () => {
      lastLiveSessions = await scanRegistry();
    });
    await enqueue('transcripts', () => scanTranscripts(lastLiveSessions));
  }

  /** Broadcast meta when Claude dir status or any plugin's meta changed (e.g. the inference badge). */
  let lastMetaKey = '';
  function refreshMeta(): void {
    claudeDirStatus = opts.claudeDirs.map((d) => inspectClaudeDir(d));
    const m = meta();
    const key = JSON.stringify({ c: m.claudeDirs, p: m.plugins, d: m.duplicatesDropped });
    if (key !== lastMetaKey) {
      lastMetaKey = key;
      broadcast({ type: 'meta', meta: m });
    }
  }

  // ---------------- HTTP ----------------

  function allowedHost(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
  }

  function allowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true; // non-browser client (forwarder, VS Code extension host, CLI)
    const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    return own.includes(origin) || (opts.allowedOrigins ?? []).includes(origin);
  }

  function tokenFrom(req: IncomingMessage, url: URL): string | undefined {
    const h = req.headers[TOKEN_HEADER];
    if (typeof h === 'string') return h;
    return url.searchParams.get('token') ?? undefined;
  }

  function end(res: ServerResponse, status: number, body?: string, type = 'application/json'): void {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  }

  function serveUi(res: ServerResponse, pathname: string): void {
    const dir = opts.uiDir && existsSync(join(opts.uiDir, 'index.html')) ? resolve(opts.uiDir) : undefined;
    if (!dir) {
      end(res, 200, '<!doctype html><title>Agent Office</title><p>UI not built. Run <code>npm run build</code>.</p>', 'text/html; charset=utf-8');
      return;
    }
    let rel: string;
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      end(res, 400, '{"error":"bad request"}'); // malformed percent-encoding
      return;
    }
    const file = resolve(dir, normalize(rel));
    if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      end(res, 404, '{"error":"not found"}');
      return;
    }
    if (file.endsWith('index.html')) {
      const nonce = randomBytes(16).toString('base64');
      const html = readFileSync(file, 'utf8').replace(
        '<head>',
        `<head><script nonce="${nonce}">window.__AGENT_OFFICE__=${JSON.stringify({ token: opts.token, wsPath: '/ws' })}</script>`,
      );
      res.writeHead(200, {
        'content-type': MIME['.html']!,
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'content-security-policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'`,
        'referrer-policy': 'no-referrer',
      });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600', 'x-content-type-options': 'nosniff' });
    res.end(readFileSync(file));
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (!allowedHost(req)) return end(res, 403, '{"error":"forbidden host"}');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const origin = req.headers.origin;
    if (!allowedOrigin(origin)) return end(res, 403, '{"error":"forbidden origin"}');

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return end(res, 200, JSON.stringify({ app: 'agent-office', protocol: PROTOCOL_VERSION, version: MONITOR_VERSION }));
    }

    if (url.pathname === '/api/hook') {
      if (req.method !== 'POST') return end(res, 405);
      const token = req.headers[TOKEN_HEADER];
      if (typeof token !== 'string' || !safeEqual(token, opts.token)) return end(res, 401);
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return end(res, 415);
      const receivedAt = now();
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      req.on('data', (c: Buffer) => {
        if (aborted) return;
        size += c.length;
        if (size > MAX_HOOK_BODY) {
          aborted = true;
          end(res, 413);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (aborted) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          rejected += 1;
          return end(res, 400);
        }
        const r = ingestHook(parsed, receivedAt);
        // Empty 2xx body: an HTTP hook response with no content has no effect on Claude Code.
        end(res, r.ok ? 204 : 400);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const token = tokenFrom(req, url);
      if (!token || !safeEqual(token, opts.token)) return end(res, 401);
      return end(res, 200, JSON.stringify({ state, meta: meta(), layout }));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/rpc/')) {
      const token = tokenFrom(req, url);
      if (!token || !safeEqual(token, opts.token)) return end(res, 401);
      let params: Record<string, unknown> = {};
      let method: string;
      try {
        method = decodeURIComponent(url.pathname.slice('/api/rpc/'.length));
        const raw = url.searchParams.get('params');
        if (raw) params = JSON.parse(raw) as Record<string, unknown>;
        if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params must be an object');
      } catch {
        return end(res, 400, '{"error":"invalid params"}');
      }
      rpc(method, params).then(
        (result) => end(res, 200, JSON.stringify({ ok: true, result })),
        (e: Error) => end(res, 400, JSON.stringify({ ok: false, error: e.message })),
      );
      return;
    }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveUi(res, url.pathname);
    end(res, 404, '{"error":"not found"}');
  }

  function onClientMessage(ws: WebSocket, data: unknown): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data)) as ClientMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return; // valid JSON such as `null` or `1`
    if (msg.type === 'resync') {
      send(ws, { type: 'snapshot', state, meta: meta(), layout });
    } else if (msg.type === 'saveLayout') {
      const r = validateLayout(msg.layout);
      if (!r.ok) {
        send(ws, { type: 'error', message: `Layout rejected: ${r.error}` });
        return;
      }
      layout = r.layout;
      try {
        saveLayout(opts.home, layout);
      } catch (e) {
        log(`failed to save layout: ${(e as Error).message}`);
      }
      broadcast({ type: 'layout', layout });
    } else if (msg.type === 'rpc') {
      const id = msg.id;
      if (typeof id !== 'number' || !Number.isInteger(id)) return;
      const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};
      rpc(msg.method, params).then(
        (result) => send(ws, { type: 'rpcResult', id, ok: true, result }),
        (e: Error) => send(ws, { type: 'rpcResult', id, ok: false, error: e.message }),
      );
    }
  }

  return {
    get port() {
      return port;
    },
    getState: () => state,
    getMeta: meta,
    getLayout: () => layout,
    ingestHook,
    scanNow,
    rpc,
    async start() {
      const ctx: PluginContext = { home: opts.home, claudeDirs: opts.claudeDirs, now, log, getState: () => state, getLayout: () => layout };
      for (const p of plugins) {
        try {
          await p.start?.(ctx);
          startedPlugins.add(p);
        } catch (e) {
          log(`plugin ${p.name} failed to start: ${(e as Error).message}`);
        }
      }
      // A request that throws (malformed URL, ...) must never take the monitor down.
      server = createServer((req, res) => {
        try {
          handle(req, res);
        } catch (e) {
          log(`request failed: ${(e as Error).message}`);
          if (!res.headersSent) end(res, 400, '{"error":"bad request"}');
          else res.destroy();
        }
      });
      wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
      server.on('upgrade', (req, socket, head) => {
        const reject = (code: number, text: string) => {
          socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
          socket.destroy();
        };
        let url: URL;
        try {
          url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        } catch {
          return reject(400, 'Bad Request');
        }
        const token = url.searchParams.get('token');
        if (!allowedHost(req)) return reject(403, 'Forbidden');
        if (!allowedOrigin(req.headers.origin)) return reject(403, 'Forbidden');
        if (url.pathname !== '/ws') return reject(404, 'Not Found');
        if (!token || !safeEqual(token, opts.token)) return reject(401, 'Unauthorized');
        wss!.handleUpgrade(req, socket, head, (ws) => {
          clients.add(ws);
          alive.add(ws);
          ws.on('pong', () => alive.add(ws));
          ws.on('message', (d) => onClientMessage(ws, d));
          ws.on('close', () => clients.delete(ws));
          ws.on('error', () => clients.delete(ws));
          send(ws, { type: 'snapshot', state, meta: meta(), layout });
        });
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        server!.once('error', rejectListen);
        // Loopback only: never reachable from the network.
        server!.listen(opts.port, '127.0.0.1', () => {
          server!.off('error', rejectListen);
          resolveListen();
        });
      });
      // Errors after listening (e.g. accept failures) are logged instead of becoming uncaught.
      server.on('error', (e) => log(`server error: ${e.message}`));
      port = (server.address() as AddressInfo).port;
      log(`listening on http://127.0.0.1:${port}`);

      const every = (ms: number, fn: () => void) => {
        const t = setInterval(fn, ms);
        t.unref();
        timers.push(t);
      };
      every(opts.tickIntervalMs ?? 15_000, () => {
        apply(systemEvent({ kind: 'Tick' }, { ts: now(), sessionId: '*' }));
        pruneSeen();
      });
      // Heartbeat: drop half-open clients (they reconnect and resync on their own).
      every(30_000, () => {
        for (const c of clients) {
          if (!alive.has(c)) {
            c.terminate();
            clients.delete(c);
            continue;
          }
          alive.delete(c);
          try {
            c.ping();
          } catch {
            /* closed meanwhile */
          }
        }
      });
      every(opts.metaIntervalMs ?? 10_000, refreshMeta);
      every(opts.spoolIntervalMs ?? 10_000, drain);
      if (discovery) {
        every(opts.registryIntervalMs ?? 2_000, () => {
          void enqueue('registry', async () => {
            lastLiveSessions = await scanRegistry();
          });
        });
        every(opts.transcriptIntervalMs ?? 15_000, () => {
          void enqueue('transcripts', () => scanTranscripts(lastLiveSessions));
        });
      }
      void scanNow();
      return { port };
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      for (const p of [...startedPlugins].reverse()) {
        try {
          await p.stop?.();
        } catch (e) {
          log(`plugin ${p.name} failed to stop: ${(e as Error).message}`);
        }
      }
      startedPlugins.clear();
      await Promise.all([...lanes.values()].map((l) => l.chain));
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      if (persist) {
        try {
          saveState(opts.home, state);
        } catch (e) {
          log(`failed to persist state: ${(e as Error).message}`);
        }
      }
      for (const c of clients) c.terminate();
      clients.clear();
      await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      server = undefined;
      wss = undefined;
    },
  };
}
