/**
 * Runtime zero-inference guard for the monitor process.
 *
 * Wraps the process-wide outbound primitives (node:http / node:https request+get, global
 * fetch, global WebSocket, node:child_process spawn/exec/execFile/fork and their Sync
 * variants) to count and classify everything the office runtime starts:
 *
 * - Requests to Claude/Anthropic inference hosts and launches of a Claude executable are
 *   BLOCKED: the call throws (or the fetch promise rejects) before any DNS lookup, socket
 *   or process exists, and the attempt is counted as office-generated inference.
 * - Any other non-loopback request is counted as external (expected: 0).
 * - Loopback requests, read-only `git` and the OS browser opener used by `cli.ts --open`
 *   (with a loopback URL) are allowed and counted.
 *
 * The guard only touches the process it is installed in. The user's own Claude Code
 * sessions are separate processes and are never affected. Inside the VS Code extension
 * host (`process.versions.electron`) the process is shared with other extensions, so the
 * guard refuses to patch anything there and reports itself inactive; the static test
 * (ZERO_INFERENCE_STATIC_TEST) covers that host instead.
 *
 * Wrappers check `active` on every call, so a wrapper left behind after uninstall (because
 * another library wrapped the same function later) is a transparent pass-through.
 */
import { syncBuiltinESMExports } from 'node:module';
import { ZERO_INFERENCE_STATIC_TEST, type InferenceDiagnostics } from '@agent-office/core';

/**
 * Hosts through which Claude inference is reachable. `*` matches any run of host characters.
 * First-party API and apps, Claude Platform on AWS, Amazon Bedrock (InvokeModel and Mantle),
 * Google Vertex AI, Claude on Google Cloud (Anthropic managed), Microsoft Foundry.
 */
export const DEFAULT_INFERENCE_HOSTS: readonly string[] = [
  'anthropic.com',
  '*.anthropic.com',
  'claude.ai',
  '*.claude.ai',
  'aws-external-anthropic.*.api.aws',
  'bedrock-runtime.*.amazonaws.com',
  'bedrock-runtime-fips.*.amazonaws.com',
  'bedrock-mantle.*.api.aws',
  '*aiplatform.googleapis.com',
  'claude.googleapis.com',
  '*.services.ai.azure.com',
];

/** Comma-separated extra inference hosts (`host`, `*.host`, `host:port` or a URL). */
export const INFERENCE_HOSTS_ENV = 'AGENT_OFFICE_INFERENCE_HOSTS';
/** Claude client base-URL overrides (gateways, proxies, cloud endpoints) are inference hosts too. */
const BASE_URL_ENV = /^ANTHROPIC_[A-Z0-9_]*BASE_URL$/;

export interface InferenceGuardOptions {
  /** Extra inference host patterns, added to DEFAULT_INFERENCE_HOSTS and the environment. */
  inferenceHosts?: readonly string[];
  log?(msg: string): void;
  /** Environment to read inference endpoints from (default process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Runtime versions (default process.versions); `electron` set means the shared VS Code extension host. */
  versions?: Readonly<Record<string, string | undefined>>;
}

export class InferenceBlockedError extends Error {
  readonly code = 'ERR_AGENT_OFFICE_INFERENCE_BLOCKED';
  constructor(
    readonly kind: string,
    readonly target: string,
  ) {
    super(`Agent Office blocked ${kind} (${target}): the office never runs model inference or launches Claude.`);
    this.name = 'InferenceBlockedError';
  }
}

// ---------------------------------------------------------------- host classification

interface HostPattern {
  re: RegExp;
  port?: number;
}

export type HostClass = 'inference' | 'loopback' | 'external';

function normalizeHost(h: string): string {
  let s = h.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  return s.replace(/\.$/, '');
}

function compilePattern(raw: string): HostPattern | undefined {
  let s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (s.includes('://')) {
    try {
      s = new URL(s).host;
    } catch {
      return undefined;
    }
  }
  let host = s;
  let port: number | undefined;
  const v6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(s);
  const plain = /^([^:]+)(?::(\d{1,5}))?$/.exec(s);
  if (v6) {
    host = v6[1]!;
    if (v6[2]) port = Number(v6[2]);
  } else if (plain) {
    host = plain[1]!;
    if (plain[2]) port = Number(plain[2]);
  }
  host = normalizeHost(host);
  if (!host || !/^[a-z0-9.*:_-]+$/.test(host)) return undefined;
  const body = host.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9.-]*');
  return port === undefined ? { re: new RegExp(`^${body}$`) } : { re: new RegExp(`^${body}$`), port };
}

/** Inference host patterns from the environment: Claude base-URL overrides and AGENT_OFFICE_INFERENCE_HOSTS. */
export function inferenceHostsFromEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v && BASE_URL_ENV.test(k)) out.push(v);
  }
  for (const h of (env[INFERENCE_HOSTS_ENV] ?? '').split(',')) if (h.trim()) out.push(h.trim());
  return out;
}

export function compileHostPatterns(patterns: readonly string[]): HostPattern[] {
  return patterns.map(compilePattern).filter((p): p is HostPattern => p !== undefined);
}

export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Classify a request target. Inference patterns win over loopback (a local Claude proxy is still inference). */
export function classifyHost(host: string, port?: number, patterns: readonly HostPattern[] = defaultPatterns): HostClass {
  const h = normalizeHost(host);
  if (patterns.some((p) => p.re.test(h) && (p.port === undefined || p.port === port))) return 'inference';
  return isLoopbackHost(h) ? 'loopback' : 'external';
}

const defaultPatterns = compileHostPatterns(DEFAULT_INFERENCE_HOSTS);

// ---------------------------------------------------------------- process classification

export type LaunchClass = 'claude' | 'git' | 'browser' | 'other';

const EXE_EXT = /\.(exe|cmd|bat|com|ps1)$/;
const CLAUDE_PACKAGE = /@anthropic-ai[\\/]+(claude-code|claude-agent-sdk)/i;
const SHELL_CHAINING = /[&|;\n`]|\$\(/;
/** Programs that run another program named in their arguments. */
const LAUNCHERS = new Set([
  'cmd', 'sh', 'bash', 'zsh', 'dash', 'fish', 'powershell', 'pwsh', 'node', 'nodejs', 'npx', 'npm', 'pnpm', 'pnpx',
  'yarn', 'bun', 'bunx', 'deno', 'env', 'start', 'wsl', 'nohup', 'sudo', 'xargs', 'timeout', 'nice', 'tsx', 'ts-node',
]);

function exeName(p: string): string {
  const s = p.trim().replace(/^["']+|["']+$/g, '');
  const base = s.split(/[\\/]/).pop() ?? s;
  return base.toLowerCase().replace(EXE_EXT, '');
}

function shellTokens(s: string): string[] {
  return s.split(/[\s"'`&|;()<>^]+/).filter(Boolean);
}

const isClaudeToken = (t: string) => exeName(t) === 'claude';

function isLoopbackUrl(s: string | undefined): boolean {
  if (!s) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Classify a process launch. `shell` means `file` (+ args) is a shell command line.
 * Arguments are inspected only to recognise Claude; they are never stored or reported.
 */
export function classifyLaunch(file: string, args: readonly string[] = [], shell = false): LaunchClass {
  if (shell) {
    const line = [file, ...args].join(' ');
    const tokens = shellTokens(line);
    if (CLAUDE_PACKAGE.test(line) || tokens.some(isClaudeToken)) return 'claude';
    return tokens[0] && exeName(tokens[0]) === 'git' && !SHELL_CHAINING.test(line) ? 'git' : 'other';
  }
  const exe = exeName(file);
  if (exe === 'claude') return 'claude';
  if (exe === 'git') return 'git';
  if (exe === 'rundll32' && args.length === 2 && args[0]?.toLowerCase() === 'url.dll,fileprotocolhandler' && isLoopbackUrl(args[1])) return 'browser';
  if ((exe === 'open' || exe === 'xdg-open') && args.length === 1 && isLoopbackUrl(args[0])) return 'browser';
  if (args.some((a) => CLAUDE_PACKAGE.test(a))) return 'claude';
  if (LAUNCHERS.has(exe) && args.some((a) => isClaudeToken(a) || shellTokens(a).some(isClaudeToken))) return 'claude';
  return 'other';
}

// ---------------------------------------------------------------- state

type AnyFn = (...args: unknown[]) => unknown;
type Mod = Record<string, unknown>;

interface Patch {
  target: object;
  key: string;
  original: PropertyDescriptor;
  wrapper: unknown;
}

interface Counters {
  inference: number;
  blocked: number;
  external: number;
  loopback: number;
  launches: { git: number; browser: number; other: number };
  lastViolation?: { at: number; kind: string; target: string };
  since: number;
}

const ELECTRON_REASON =
  'The monitor runs inside the VS Code extension host, a process shared with other extensions, so the runtime guard does not patch its globals. The static test covers this host.';
const NOT_INSTALLED_REASON = 'The runtime guard is not installed in this process.';

const newCounters = (): Counters => ({ inference: 0, blocked: 0, external: 0, loopback: 0, launches: { git: 0, browser: 0, other: 0 }, since: Date.now() });

let active = false;
let manual = false;
let holders = 0;
let depth = 0;
let host: 'node' | 'electron' = process.versions.electron ? 'electron' : 'node';
let inactiveReason = NOT_INSTALLED_REASON;
let instrumented: string[] = [];
let patterns: HostPattern[] = defaultPatterns;
let logFn: ((msg: string) => void) | undefined;
let patches: Patch[] = [];
let c: Counters = newCounters();

function violation(kind: string, target: string): void {
  c.lastViolation = { at: Date.now(), kind, target: target.slice(0, 200) };
}

function safeLog(msg: string): void {
  try {
    logFn?.(msg);
  } catch {
    /* logging must never break the caller */
  }
}

function block(kind: string, target: string): never {
  c.inference += 1;
  c.blocked += 1;
  violation(kind, target);
  safeLog(`inference guard BLOCKED ${kind} (${target})`);
  throw new InferenceBlockedError(kind, target);
}

// ---------------------------------------------------------------- network checks

interface Target {
  protocol: string;
  host: string;
  port?: number;
  ipc?: boolean;
}

/** Scheme, host and non-default port only: paths and queries can carry identifiers or keys. */
function origin(t: Target): string {
  const h = t.host.includes(':') ? `[${t.host}]` : t.host;
  const secure = t.protocol === 'https:' || t.protocol === 'wss:';
  const showPort = t.port !== undefined && t.port !== (secure ? 443 : 80);
  return `${t.protocol}//${h}${showPort ? `:${t.port}` : ''}`;
}

function checkNetwork(kind: string, t: Target | undefined): void {
  if (!t) return; // not a network target (data:, blob:) or invalid input that the original rejects itself
  if (t.ipc) {
    c.loopback += 1;
    return;
  }
  const cls = classifyHost(t.host, t.port, patterns);
  if (cls === 'inference') block(`inference:${kind}`, origin(t));
  if (cls === 'loopback') {
    c.loopback += 1;
    return;
  }
  c.external += 1;
  violation(`external:${kind}`, origin(t));
  safeLog(`inference guard: external request ${kind} (${origin(t)})`);
}

function isUrlLike(v: unknown): v is URL {
  if (v instanceof URL) return true;
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && typeof o.href === 'string' && typeof o.protocol === 'string' && o.path === undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function portOf(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Target of http(s).request/get, following Node's own argument rules (URL fields, then options). */
function httpTarget(args: unknown[], defaultProtocol: 'http:' | 'https:'): Target | undefined {
  const [a, b] = args;
  let url: URL | undefined;
  let opts: Mod | undefined;
  if (typeof a === 'string') {
    try {
      url = new URL(a);
    } catch {
      return undefined;
    }
  } else if (isUrlLike(a)) {
    url = new URL(a.href);
  } else if (a && typeof a === 'object') {
    opts = a as Mod;
  }
  if (url && b && typeof b === 'object') opts = b as Mod;
  const protocol = str(opts?.protocol) ?? url?.protocol ?? defaultProtocol;
  if (str(opts?.socketPath)) return { protocol, host: 'localhost', ipc: true };
  let hostname = str(opts?.hostname) ?? (url ? normalizeHost(url.hostname) : undefined) ?? str(opts?.host) ?? 'localhost';
  let port = portOf(opts?.port) ?? portOf(url?.port);
  const withPort = /^([^:[\]]+):(\d{1,5})$/.exec(hostname);
  if (withPort) {
    hostname = withPort[1]!;
    port ??= portOf(withPort[2]);
  }
  return { protocol, host: normalizeHost(hostname), port: port ?? portOf(opts?.defaultPort) ?? (protocol === 'https:' ? 443 : 80) };
}

function urlTarget(input: unknown): Target | undefined {
  let u: URL;
  try {
    const raw = typeof input === 'string' ? input : isUrlLike(input) ? input.href : str((input as Mod | null)?.url);
    if (!raw) return undefined;
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return undefined;
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  return { protocol: u.protocol, host: normalizeHost(u.hostname), port: portOf(u.port) ?? (secure ? 443 : 80) };
}

// ---------------------------------------------------------------- process checks

interface Launch {
  file: string;
  args: string[];
  shell: boolean;
}

function optionsAfter(args: unknown[]): Mod | undefined {
  const o = Array.isArray(args[1]) ? args[2] : args[1];
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Mod) : undefined;
}

function launchOf(fn: string, args: unknown[]): Launch {
  if (fn === 'exec' || fn === 'execSync') return { file: String(args[0] ?? ''), args: [], shell: true };
  const list = Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [];
  const opts = optionsAfter(args);
  if (fn === 'fork') return { file: str(opts?.execPath) ?? process.execPath, args: [String(args[0] ?? ''), ...list], shell: false };
  return { file: String(args[0] ?? ''), args: list, shell: Boolean(opts?.shell) };
}

function checkLaunch(fn: string, args: unknown[]): void {
  const l = launchOf(fn, args);
  const cls = classifyLaunch(l.file, l.args, l.shell);
  const exe = exeName(l.shell ? (shellTokens(l.file)[0] ?? 'shell') : l.file) || 'unknown';
  if (cls === 'claude') block(`claude-process:${fn}`, exe === 'claude' ? 'claude' : `${exe} (launches Claude)`);
  c.launches[cls] += 1;
  if (cls === 'other') safeLog(`inference guard: process launch ${fn} (${exe})`);
}

// ---------------------------------------------------------------- patching

function builtin(id: string): Mod | undefined {
  const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  try {
    if (typeof get === 'function') return get.call(process, id) as Mod | undefined;
    if (typeof require === 'function') return require(id) as Mod;
  } catch {
    /* not available in this runtime */
  }
  return undefined;
}

function wrapMethod(target: Mod | undefined, key: string, check: (args: unknown[]) => void): boolean {
  if (!target) return false;
  const desc = Object.getOwnPropertyDescriptor(target, key);
  if (!desc || typeof desc.value !== 'function' || !desc.writable) return false;
  const original = desc.value as AnyFn;
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    // Nested calls (exec -> execFile -> spawn) were already checked by the outermost wrapper.
    if (!active || depth > 0) return original.apply(this, args);
    depth += 1;
    try {
      check(args);
      return original.apply(this, args);
    } finally {
      depth -= 1;
    }
  };
  Object.defineProperty(wrapper, 'name', { value: original.name });
  target[key] = wrapper;
  patches.push({ target, key, original: desc, wrapper });
  return true;
}

function wrapGlobal(key: 'fetch' | 'WebSocket', make: (original: AnyFn) => unknown): boolean {
  const g = globalThis as unknown as Mod;
  const current = g[key]; // resolves lazily defined globals first
  const desc = Object.getOwnPropertyDescriptor(globalThis, key);
  if (typeof current !== 'function' || !desc?.configurable) return false;
  const wrapper = make(current as AnyFn);
  Object.defineProperty(globalThis, key, { configurable: true, enumerable: desc.enumerable ?? false, writable: true, value: wrapper });
  patches.push({ target: globalThis, key, original: desc, wrapper });
  return true;
}

function patchAll(): string[] {
  const out: string[] = [];
  const http = builtin('node:http');
  const https = builtin('node:https');
  const cp = builtin('node:child_process');
  const httpCheck = (proto: 'http:' | 'https:') => (args: unknown[]) => checkNetwork(proto.slice(0, -1), httpTarget(args, proto));
  if ([wrapMethod(http, 'request', httpCheck('http:')), wrapMethod(http, 'get', httpCheck('http:'))].some(Boolean)) out.push('http');
  if ([wrapMethod(https, 'request', httpCheck('https:')), wrapMethod(https, 'get', httpCheck('https:'))].some(Boolean)) out.push('https');
  const fetchPatched = wrapGlobal('fetch', (original) =>
    function fetch(this: unknown, ...args: unknown[]): unknown {
      if (!active || depth > 0) return original.apply(this, args);
      try {
        checkNetwork('fetch', urlTarget(args[0]));
      } catch (e) {
        return Promise.reject(e);
      }
      return original.apply(this, args);
    },
  );
  if (fetchPatched) out.push('fetch');
  const wsPatched = wrapGlobal(
    'WebSocket',
    (original) =>
      new Proxy(original, {
        construct(target, args, newTarget) {
          if (active && depth === 0) checkNetwork('websocket', urlTarget(args[0]));
          return Reflect.construct(target, args, newTarget) as object;
        },
      }),
  );
  if (wsPatched) out.push('websocket');
  let cpPatched = false;
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    if (wrapMethod(cp, fn, (args) => checkLaunch(fn, args))) cpPatched = true;
  }
  if (cpPatched) out.push('child_process');
  syncBuiltinESMExports(); // ESM named imports of builtins (`import { request } from 'node:http'`) see the wrappers
  return out;
}

function restoreAll(): void {
  for (const p of patches.reverse()) {
    const current = (p.target as Mod)[p.key];
    // Another library wrapped ours later: leave its chain intact; our wrapper is inert while inactive.
    if (current === p.wrapper) Object.defineProperty(p.target, p.key, p.original);
  }
  patches = [];
  syncBuiltinESMExports();
}

function activate(opts: InferenceGuardOptions): boolean {
  if (opts.log) logFn = opts.log;
  if (active) return true;
  host = (opts.versions ?? process.versions).electron ? 'electron' : 'node';
  if (host === 'electron') {
    inactiveReason = ELECTRON_REASON;
    return false;
  }
  patterns = compileHostPatterns([...DEFAULT_INFERENCE_HOSTS, ...(opts.inferenceHosts ?? []), ...inferenceHostsFromEnv(opts.env ?? process.env)]);
  active = true; // set before patching: a throw mid-way is cleaned up below
  try {
    instrumented = patchAll();
  } catch (e) {
    active = false;
    restoreAll();
    instrumented = [];
    inactiveReason = `The runtime guard failed to install: ${(e as Error).message}`;
    return false;
  }
  return true;
}

function deactivate(): void {
  if (active) restoreAll();
  active = false;
  instrumented = [];
  inactiveReason = NOT_INSTALLED_REASON;
}

// ---------------------------------------------------------------- public API

/** Install the guard in this process (idempotent). Returns the resulting diagnostics. */
export function installInferenceGuard(opts: InferenceGuardOptions = {}): InferenceDiagnostics {
  manual = true;
  activate(opts);
  return inferenceGuardDiagnostics();
}

/** Remove every wrapper (idempotent), regardless of acquired holders. Counters are kept until reset(). */
export function uninstallInferenceGuard(): void {
  manual = false;
  holders = 0;
  deactivate();
}

/**
 * Reference-counted install for owners such as the monitor plugin: the guard stays installed
 * while any holder (or a manual install) remains. The returned release function is idempotent.
 */
export function acquireInferenceGuard(opts: InferenceGuardOptions = {}): () => void {
  holders += 1;
  activate(opts);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0 && !manual) deactivate();
  };
}

/** Zero the counters and forget the last violation. */
export function resetInferenceGuard(): void {
  c = newCounters();
}

export function inferenceGuardDiagnostics(): InferenceDiagnostics {
  const d: InferenceDiagnostics = {
    guard: active ? 'active' : 'inactive',
    instrumented: active ? [...instrumented] : [],
    officeInferenceCalls: c.inference,
    externalRequests: c.external,
    host,
    blocked: c.blocked,
    loopbackRequests: c.loopback,
    processLaunches: { ...c.launches },
    since: c.since,
    staticCheck: ZERO_INFERENCE_STATIC_TEST,
  };
  if (c.lastViolation) d.lastViolation = { ...c.lastViolation };
  if (!active) d.inactiveReason = inactiveReason;
  return d;
}

export function isInferenceGuardActive(): boolean {
  return active;
}

/** The same API as one object. */
export const inferenceGuard = {
  install: installInferenceGuard,
  uninstall: uninstallInferenceGuard,
  acquire: acquireInferenceGuard,
  reset: resetInferenceGuard,
  diagnostics: inferenceGuardDiagnostics,
  isActive: isInferenceGuardActive,
};
