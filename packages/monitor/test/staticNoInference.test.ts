/**
 * Zero-extra-inference, static half. Scans every source file under packages/<pkg>/src,
 * packages/<pkg>/scripts and scripts/ and fails when one
 *  - imports an Anthropic/Claude (or any other LLM / MCP) SDK,
 *  - names a Claude inference host (the runtime guard's DEFAULT_INFERENCE_HOSTS),
 *  - could launch Claude (a `claude` command string in a file that can start processes),
 *  - uses VS Code's in-editor model APIs, chat commands or an unknown Claude extension command,
 *  - or uses a network/process primitive (http(s) client, fetch, WebSocket, net/tls, child_process,
 *    VS Code terminals/tasks, browser automation) outside the small, justified ALLOWLIST below,
 *    where every URL literal must also target loopback.
 *
 * Sources are first run through esbuild (comments and type-only imports disappear), then a small
 * lexer separates string literals from code, so text in comments, strings and JSX never counts as
 * a call. This test also covers the VS Code extension host, where the runtime guard is inactive.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { transformSync, type Loader } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { DEFAULT_INFERENCE_HOSTS } from '../src/inferenceGuard';

const ROOT = join(__dirname, '..', '..', '..');

type Primitive =
  | 'http-client' // node:http request/get/Agent, node:https
  | 'net' // node:net / node:tls connections
  | 'child_process' // node:child_process, node:cluster
  | 'websocket' // WebSocket clients (ws package or the global)
  | 'browser-network' // fetch, XMLHttpRequest, EventSource, sendBeacon, ...
  | 'network-lib' // undici, axios, node-fetch, http2, dgram, ...
  | 'browser-automation' // playwright, puppeteer
  | 'dynamic-builtin' // process.getBuiltinModule / process.binding
  | 'vscode-process'; // VS Code terminals, tasks, openExternal

interface AllowEntry {
  file: string;
  allow: Primitive[];
  why: string;
  /** The file may not use its primitives (yet): absence is not a failure. */
  optional?: boolean;
  /** Narrow exemptions, each with its reason. */
  exempt?: {
    /** Every inference rule (only the guard itself, which must name what it blocks). */
    all?: string;
    /** The file names inference hosts in order to detect or block them. */
    inferenceHosts?: string;
    /** Reviewed strings that look like a Claude command but are not one. */
    claudeStrings?: Record<string, string>;
  };
  /** URL hosts that are not loopback but are never contacted (e.g. a base for URL parsing). */
  allowedUrlHosts?: string[];
}

/** Every file allowed to touch the network or start processes, with the reason. Keep it small. */
export const ALLOWLIST: AllowEntry[] = [
  {
    file: 'packages/monitor/src/inferenceGuard.ts',
    allow: ['http-client', 'child_process', 'browser-network', 'websocket', 'dynamic-builtin'],
    why: 'The runtime guard wraps these primitives to count and block them; it never starts a request or a process itself.',
    exempt: { all: 'It has to name the inference hosts and Claude executables it blocks.' },
  },
  {
    file: 'packages/monitor/src/forwarder.ts',
    allow: ['http-client'],
    why: 'Hook forwarder: POSTs the pre-trimmed hook payload to the monitor on 127.0.0.1 only (spools to disk otherwise).',
  },
  {
    file: 'packages/monitor/src/cli.ts',
    allow: ['http-client', 'child_process'],
    why: 'CLI: health check and `simulate` POSTs go to 127.0.0.1; spawn runs only the OS browser opener (rundll32/open/xdg-open) for --open with the loopback URL.',
  },
  {
    file: 'packages/monitor/src/plugins/git.ts',
    allow: ['child_process'],
    why: "Git plugin: read-only local Git status via execFile('git', ...) only.",
    optional: true,
  },
  {
    file: 'packages/vscode-extension/src/connection.ts',
    allow: ['http-client', 'websocket'],
    why: 'VS Code extension: health check and WebSocket to the monitor on 127.0.0.1.',
  },
  {
    file: 'packages/ui/src/transport.ts',
    allow: ['websocket'],
    why: "Browser UI: WebSocket to the serving monitor's own origin; the page CSP limits connect-src to ws://127.0.0.1 / ws://localhost.",
  },
  {
    file: 'scripts/audit-publish.cjs',
    allow: ['child_process'],
    why: "Developer script: execFileSync('git') with a temporary GIT_DIR to list publishable files; no network.",
  },
  {
    file: 'scripts/smoke-webview.cjs',
    allow: ['http-client', 'browser-automation'],
    why: 'Developer smoke test: local static server and GET /api/state on 127.0.0.1, driven in a local headless Edge.',
    allowedUrlHosts: ['x'], // `new URL(req.url, 'http://x')`: a parsing base, never contacted
  },
  {
    file: 'scripts/e2e-zero-token.cjs',
    allow: ['http-client', 'child_process', 'net', 'browser-automation'],
    why: 'Developer browser e2e: spawns an isolated local monitor (node), finds a free port with net.createServer, drives the UI on 127.0.0.1 in headless Edge and aborts any non-loopback request.',
    exempt: {
      inferenceHosts: 'Its INFERENCE_HOST pattern recognises inference requests in order to abort and count them.',
      claudeStrings: { claude: 'Name of the temporary CLAUDE_CONFIG_DIR folder, never executed.' },
    },
  },
  {
    file: 'scripts/capture-screenshots.cjs',
    allow: ['http-client', 'child_process', 'browser-automation'],
    why: 'Developer screenshot capture: spawns an isolated local monitor and SIMULATED traffic (node), POSTs hooks and polls health on 127.0.0.1, drives the UI in headless Edge and aborts any non-loopback request.',
  },
  {
    file: 'scripts/lint.mjs',
    allow: ['child_process'],
    why: 'Developer lint: runs the local TypeScript compiler (node + the tsc bin from node_modules); no network.',
    exempt: { inferenceHosts: 'Lists documentation hosts (docs/support.anthropic.com) that its no-external-urls rule accepts as links.' },
  },
];

/** Official Claude Code extension commands that only open its UI (never submit a prompt). */
const KNOWN_CLAUDE_UI_COMMANDS = new Set(['claude-vscode.focus', 'claude-vscode.editor.openLast', 'claude-vscode.sidebar.open']);

interface Lexed {
  /** Code with every string literal (and template chunk) replaced by "§<index>" and regexes by /r/. */
  code: string;
  strings: string[];
}

const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

function unescapeJs(s: string): string {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_m, e: string) => {
    if (e.length > 1 && e[0] === 'u') return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16));
    if (e.length === 3 && e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<string, string>)[e] ?? e;
  });
}

export function lex(src: string): Lexed {
  const strings: string[] = [];
  const out: string[] = [];
  const n = src.length;
  const templates: number[] = []; // brace depth at each open `${`
  let depth = 0;
  let prevSig = ''; // last significant code character
  let word = ''; // identifier that ends the code so far
  let i = src.startsWith('#!') ? src.indexOf('\n') + 1 || n : 0;

  const emit = (s: string) => {
    out.push(s);
    for (const ch of s) {
      if (/\s/.test(ch)) continue;
      word = /[\w$]/.test(ch) ? (/[\w$]/.test(prevSig) ? word + ch : ch) : '';
      prevSig = ch;
    }
  };
  const value = (s: string) => {
    strings.push(unescapeJs(s));
    out.push(`"§${strings.length - 1}"`);
    prevSig = '"';
    word = '';
  };
  const regexAllowed = () => prevSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prevSig) || REGEX_KEYWORDS.has(word);
  const template = (j: number): number => {
    let val = '';
    while (j < n) {
      const ch = src[j]!;
      if (ch === '\\') {
        val += src.slice(j, j + 2);
        j += 2;
      } else if (ch === '`') {
        value(val);
        emit('`');
        return j + 1;
      } else if (ch === '$' && src[j + 1] === '{') {
        value(val);
        emit('${');
        templates.push(depth);
        depth += 1;
        return j + 2;
      } else {
        val += ch;
        j += 1;
      }
    }
    value(val);
    return n;
  };

  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '"' || c === "'") {
      let j = i + 1;
      let val = '';
      // A quote cannot span lines: a stray apostrophe (JSX text) only affects its own line.
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') {
          val += src.slice(j, j + 2);
          j += 2;
        } else val += src[j++];
      }
      value(val);
      i = j + 1;
    } else if (c === '`') {
      emit('`');
      i = template(i + 1);
    } else if (c === '/' && next === '/') {
      const j = src.indexOf('\n', i);
      i = j < 0 ? n : j;
    } else if (c === '/' && next === '*') {
      const j = src.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
      out.push(' ');
    } else if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n && src[j] !== '\n') {
        const ch = src[j]!;
        if (ch === '\\') j += 1;
        else if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          ok = true;
          break;
        }
        j += 1;
      }
      if (!ok) {
        emit('/');
        i += 1;
        continue;
      }
      j += 1;
      while (j < n && /[a-z]/i.test(src[j]!)) j += 1;
      out.push('/r/');
      prevSig = ')'; // a regex is a value: a following `/` divides
      word = '';
      i = j;
    } else if (c === '{') {
      depth += 1;
      emit(c);
      i += 1;
    } else if (c === '}') {
      if (templates.length && templates[templates.length - 1] === depth - 1) {
        templates.pop();
        depth -= 1;
        emit('}');
        i = template(i + 1);
      } else {
        depth -= 1;
        emit(c);
        i += 1;
      }
    } else {
      emit(c);
      i += 1;
    }
  }
  return { code: out.join(''), strings };
}

const SDK_SPEC =
  /^(?:@anthropic-ai\/|anthropic$|@aws-sdk\/client-bedrock|@google-cloud\/(?:vertexai|aiplatform)|@google\/(?:genai|generative-ai)|@azure\/(?:openai|ai-)|@azure-rest\/ai-|@modelcontextprotocol\/|openai$|@openai\/|ai$|@ai-sdk\/|langchain|@langchain\/|llamaindex|ollama$|cohere-ai$|@mistralai\/|groq-sdk$|replicate$|@huggingface\/inference)/;
const HTTP_SAFE = new Set(['createServer', 'Server', 'STATUS_CODES', 'METHODS', 'IncomingMessage', 'ServerResponse', 'OutgoingMessage', 'validateHeaderName', 'validateHeaderValue', 'maxHeaderSize']);
const NET_SAFE = new Set(['isIP', 'isIPv4', 'isIPv6', 'createServer', 'Server', 'BlockList', 'SocketAddress']);
const WS_SAFE = new Set(['WebSocketServer', 'Server']);
const NETWORK_LIBS = new Set(['http2', 'dgram', 'undici', 'node-fetch', 'axios', 'got', 'ky', 'superagent', 'cross-fetch', 'isomorphic-fetch', 'needle', 'request', 'socket.io-client', 'eventsource']);
const BROWSER_AUTOMATION = new Set(['playwright', 'playwright-core', '@playwright/test', 'puppeteer', 'puppeteer-core', 'selenium-webdriver']);
const SENSITIVE_MODULES = new Set(['child_process', 'cluster', 'http', 'https', 'net', 'tls', 'ws', ...NETWORK_LIBS, ...BROWSER_AUTOMATION]);

type ModuleClass = Primitive | 'sdk' | undefined;

function classifyModule(spec: string, names: string[]): ModuleClass {
  if (SDK_SPEC.test(spec)) return 'sdk';
  const m = spec.replace(/^node:/, '');
  const safe = (set: Set<string>) => names.length > 0 && names.every((x) => set.has(x));
  if (m === 'child_process' || m === 'cluster') return 'child_process';
  if (m === 'http') return safe(HTTP_SAFE) ? undefined : 'http-client';
  if (m === 'https') return safe(new Set(['createServer', 'Server'])) ? undefined : 'http-client';
  if (m === 'net' || m === 'tls') return safe(NET_SAFE) ? undefined : 'net';
  if (m === 'ws') return safe(WS_SAFE) ? undefined : 'websocket';
  if (NETWORK_LIBS.has(m)) return 'network-lib';
  if (BROWSER_AUTOMATION.has(m)) return 'browser-automation';
  return undefined;
}

function importedNames(clause: string): string[] {
  const names: string[] = [];
  const c = clause.trim();
  const braces = /\{([^}]*)\}/.exec(c);
  if (braces) {
    for (const part of braces[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+|\s*:\s*/)[0]!.trim();
      if (name) names.push(name);
    }
  }
  const outside = c.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
  if (outside) names.push('*'); // default or namespace import: any member may be used
  return names;
}

/** First literal fragment (4+ chars) of each inference host pattern. */
const HOST_MARKERS = [
  ...new Set(
    DEFAULT_INFERENCE_HOSTS.map((p) =>
      (p.split('*').map((f) => f.replace(/^\.+|\.+$/g, '')).find((f) => f.length >= 4) ?? p).toLowerCase(),
    ),
  ),
];
const markerRe = new RegExp(`(?<![a-z0-9-])(?:${HOST_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![a-z0-9-])`, 'i');

const DOC_HOSTS = /(?<![a-z0-9.-])(?:docs|support)\.anthropic\.com(?![a-z0-9-])/gi;
const CLAUDE_COMMAND_START = /^\s*["']?(?:[^\s"']*[\\/])?claude(?:\.exe|\.cmd|\.bat|\.ps1)?["']?(?:\s|$)/;
const CLAUDE_COMMAND_INLINE = /(?:^|[\s&|;(])claude(?:\.exe)?\s+-{1,2}[a-z]/;
const CLAUDE_PACKAGE = /@anthropic-ai\/|@modelcontextprotocol\//;
const VSCODE_MODEL_API = /\bvscode\s*\.\s*lm\b|\blm\s*\.\s*(?:selectChatModels|invokeTool|registerTool|registerMcpServerDefinitionProvider)\b|\bLanguageModelChat\w*|\bselectChatModels\b|\bcreateChatParticipant\b|\bMcp(?:Stdio|Http)ServerDefinition\b/;
const CHAT_COMMAND = /^(?:workbench\.action\.chat|workbench\.panel\.chat|github\.copilot|inlineChat)/;
const URL_HOST = /\b(?:https?|wss?):\/\/(\[[^\]]*\]|[^/\s:"'`?#\\]*)/g;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const GLOBAL_PRIMITIVES: Array<[RegExp, Primitive]> = [
  [/(?<![\w$.])fetch\s*\(/, 'browser-network'],
  [/\b(?:globalThis|window|self|global)\s*\.\s*fetch\b/, 'browser-network'],
  [/\bnew\s+(?:(?:globalThis|window)\s*\.\s*)?WebSocket\s*\(/, 'websocket'],
  [/\b(?:XMLHttpRequest|EventSource|WebTransport|RTCPeerConnection)\b/, 'browser-network'],
  [/\b(?:sendBeacon|importScripts)\s*\(/, 'browser-network'],
  [/\bgetBuiltinModule\s*\(|\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\s*\(/, 'dynamic-builtin'],
];
const VSCODE_PRIMITIVES: Array<[RegExp, Primitive]> = [[/\b(?:ShellExecution|ProcessExecution|CustomExecution)\b|\.\s*(?:createTerminal|sendText|executeTask|openExternal)\s*\(/, 'vscode-process']];

export interface ScanResult {
  primitives: Set<Primitive>;
  findings: string[];
  transformed: boolean;
}

function loaderFor(file: string): Loader {
  if (file.endsWith('.tsx')) return 'tsx';
  if (/\.[mc]?ts$/.test(file)) return 'ts';
  if (file.endsWith('.jsx')) return 'jsx';
  return 'js';
}

/** Scan one source file. `rel` is its repository-relative path with forward slashes. */
export function scanSource(rel: string, src: string, entry: AllowEntry | undefined = ALLOWLIST.find((e) => e.file === rel)): ScanResult {
  let text = src;
  let transformed = false;
  try {
    text = transformSync(src, { loader: loaderFor(rel), target: 'esnext', legalComments: 'none', jsx: 'automatic', charset: 'utf8', sourcefile: rel }).code;
    transformed = true;
  } catch {
    // Unparseable work in progress: fall back to the raw source (the lexer drops comments itself).
  }
  const { code, strings } = lex(text);
  const findings: string[] = [];
  const primitives = new Set<Primitive>();
  const consumed = new Set<number>();
  const exempt = Boolean(entry?.exempt?.all);
  const reviewed = entry?.exempt?.claudeStrings ?? {};
  const isVsCode = rel.startsWith('packages/vscode-extension/');

  const useModule = (idx: number, names: string[]) => {
    consumed.add(idx);
    const spec = strings[idx] ?? '';
    const cls = classifyModule(spec, names);
    if (cls === 'sdk') findings.push(`imports an AI/LLM/MCP SDK: "${spec}"`);
    else if (cls) primitives.add(cls);
  };
  for (const m of code.matchAll(/\bimport\s+(?!type\b)([\w$*{}\s,]+?)\s+from\s*"§(\d+)"/g)) useModule(Number(m[2]), importedNames(m[1]!));
  for (const m of code.matchAll(/\bexport\s*(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*"§(\d+)"/g)) useModule(Number(m[2]), importedNames(m[1]!));
  for (const m of code.matchAll(/\bimport\s*"§(\d+)"/g)) useModule(Number(m[1]), []);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\s*\(\s*"§(\d+)"\s*\)/g)) useModule(Number(m[2]), importedNames(m[1]!));
  for (const m of code.matchAll(/\b(?:require|import|getBuiltinModule)\s*\(\s*"§(\d+)"\s*\)/g)) if (!consumed.has(Number(m[1]))) useModule(Number(m[1]), ['*']);
  // Builtins named outside an import (e.g. handed to a loader helper). Bare words such as "http" or
  // "ws" are too common in ordinary strings, so only `node:`-prefixed names and child_process count.
  strings.forEach((s, idx) => {
    if (consumed.has(idx) || !(s === 'child_process' || (s.startsWith('node:') && SENSITIVE_MODULES.has(s.slice(5))))) return;
    const cls = classifyModule(s, ['*']);
    if (cls && cls !== 'sdk') primitives.add(cls);
  });
  for (const [re, p] of [...GLOBAL_PRIMITIVES, ...(isVsCode ? VSCODE_PRIMITIVES : [])]) if (re.test(code)) primitives.add(p);

  if (!exempt) {
    // Documentation links are user navigation, never a request made by the office.
    const hay = `${text}\n${text.replace(/\\/g, '')}`.replace(DOC_HOSTS, '');
    const host = entry?.exempt?.inferenceHosts ? null : markerRe.exec(hay);
    if (host) findings.push(`names a Claude inference host ("${host[0]}")`);
    const pkg = strings.find((s) => CLAUDE_PACKAGE.test(s));
    if (pkg) findings.push(`references an Anthropic/MCP package: "${pkg.slice(0, 80)}"`);
  }
  if (VSCODE_MODEL_API.test(code)) findings.push('uses the VS Code language-model / chat / MCP API (in-editor inference)');
  for (const s of strings) {
    if (isVsCode && CHAT_COMMAND.test(s)) findings.push(`runs a chat/Copilot command: "${s}"`);
    if (/^claude-(?:vscode|code)\./.test(s) && !KNOWN_CLAUDE_UI_COMMANDS.has(s)) findings.push(`uses Claude extension command "${s}" that is not a known UI-only command`);
  }
  if (!exempt && (primitives.has('child_process') || primitives.has('vscode-process'))) {
    const cmd = strings.find((s) => !Object.hasOwn(reviewed, s) && (CLAUDE_COMMAND_START.test(s) || CLAUDE_COMMAND_INLINE.test(s)));
    if (cmd !== undefined) findings.push(`can start processes and contains a Claude command string: "${cmd.slice(0, 60)}"`);
  }
  for (const p of primitives) if (!entry?.allow.includes(p)) findings.push(`uses ${p} but is not in the allowlist`);
  if (entry && !exempt) {
    for (const s of strings) {
      for (const m of s.matchAll(URL_HOST)) {
        const h = (m[1] ?? '').toLowerCase();
        if (h && !LOOPBACK.has(h) && !entry.allowedUrlHosts?.includes(h)) findings.push(`network-capable file contains a non-loopback URL host "${h}"`);
      }
    }
  }
  return { primitives, findings, transformed };
}

function sourceFiles(): string[] {
  const roots: string[] = [join(ROOT, 'scripts')];
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    for (const sub of ['src', 'scripts']) roots.push(join(ROOT, 'packages', pkg, sub));
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'media') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(name) && !name.endsWith('.d.ts')) out.push(relative(ROOT, p).replace(/\\/g, '/'));
    }
  };
  roots.forEach(walk);
  return out.sort();
}

describe('static zero-inference scan', () => {
  const files = sourceFiles();
  const results = new Map(files.map((f) => [f, scanSource(f, readFileSync(join(ROOT, f), 'utf8'))]));

  it('finds the sources it is meant to cover', () => {
    expect(files.length).toBeGreaterThan(40);
    for (const f of ['packages/monitor/src/server.ts', 'packages/monitor/src/forwarder.ts', 'packages/monitor/src/hooks.ts', 'packages/vscode-extension/src/extension.ts', 'packages/ui/src/App.tsx', 'scripts/audit-publish.cjs'])
      expect(files).toContain(f);
  });

  it('no source imports an AI SDK, names an inference host, can launch Claude, or uses an unapproved network/process primitive', () => {
    const report = [...results].flatMap(([f, r]) => r.findings.map((x) => `${f}: ${x}`));
    expect(report).toEqual([]);
  });

  it('parses the sources and sees exactly the expected primitives in known files', () => {
    expect([...results.values()].filter((r) => r.transformed).length / files.length).toBeGreaterThan(0.9);
    const prims = (f: string) => [...(results.get(f)?.primitives ?? [])].sort();
    expect(prims('packages/monitor/src/server.ts')).toEqual([]); // listens on 127.0.0.1; servers are not outbound
    expect(prims('packages/monitor/src/hooks.ts')).toEqual([]);
    expect(prims('packages/monitor/src/cli.ts')).toEqual(['child_process', 'http-client']);
    expect(prims('packages/monitor/src/forwarder.ts')).toEqual(['http-client']);
    expect(prims('packages/vscode-extension/src/connection.ts')).toEqual(['http-client', 'websocket']);
    expect(prims('packages/vscode-extension/src/extension.ts')).toEqual([]);
    expect(prims('packages/ui/src/transport.ts')).toEqual(['websocket']);
  });

  it('the allowlist is small, justified and not stale', () => {
    expect(ALLOWLIST.length).toBeLessThanOrEqual(12);
    for (const e of ALLOWLIST) {
      expect(e.why.length, e.file).toBeGreaterThan(30);
      if (e.optional) continue;
      expect(existsSync(join(ROOT, e.file)), `${e.file} exists`).toBe(true);
      const used = results.get(e.file)?.primitives ?? new Set();
      expect(e.allow.some((p) => used.has(p)), `${e.file} still uses an allowed primitive`).toBe(true);
    }
  });

  it('the guard blocks at least the required inference hosts', () => {
    expect(DEFAULT_INFERENCE_HOSTS).toEqual(expect.arrayContaining(['anthropic.com', '*.anthropic.com', 'claude.ai', 'bedrock-runtime.*.amazonaws.com', '*aiplatform.googleapis.com']));
    expect(HOST_MARKERS).toEqual(expect.arrayContaining(['anthropic.com', 'claude.ai', 'bedrock-runtime', 'aiplatform.googleapis.com']));
  });
});

describe('scanner self-test', () => {
  const scan = (src: string, rel = 'packages/monitor/src/fixture.ts', entry?: AllowEntry) => scanSource(rel, src, entry);

  it('ignores comments, plain strings, regex literals and JSX text', () => {
    const r = scan(
      [
        '// fetch("https://api.anthropic.com") and spawn("claude")',
        '/* import Anthropic from "@anthropic-ai/sdk" */',
        'export const help = "use fetch() or http.request to call it";',
        'export const re = /^"|"$/g;',
        "export const half = (a: number) => a / 2 / 1;",
        'export const t = `${help} new WebSocket(x)`;',
      ].join('\n'),
    );
    expect(r).toMatchObject({ findings: [], transformed: true });
    expect(r.primitives.size).toBe(0);
    const jsx = scan("export const P = () => <p>Don't panic: fetch( is just text</p>;\nexport const go = () => fetch('/x');", 'packages/ui/src/Fixture.tsx');
    expect(jsx.findings).toEqual(['uses browser-network but is not in the allowlist']);
    // the raw-source fallback (unparseable work in progress) also drops comments
    const broken = scan('const = ; // fetch(\n/* new WebSocket( */ const ok = "fetch(";');
    expect(broken).toMatchObject({ findings: [], transformed: false });
  });

  it('flags SDK imports, inference hosts and Anthropic packages', () => {
    expect(scan('import Anthropic from "@anthropic-ai/sdk";\nexport const c = new Anthropic();').findings).toContain('imports an AI/LLM/MCP SDK: "@anthropic-ai/sdk"');
    expect(scan('export const m = await import("@modelcontextprotocol/sdk/client/index.js");').findings.join()).toMatch(/AI\/LLM\/MCP SDK/);
    expect(scan('export const u = "https://API.Anthropic.com/v1/messages";').findings).toEqual(['names a Claude inference host ("Anthropic.com")']);
    expect(scan('export const u = (r: string) => `https://bedrock-runtime.${r}.amazonaws.com`;').findings.join()).toMatch(/inference host/);
    expect(scan('export const re = /claude\\.ai/;').findings.join()).toMatch(/inference host/);
    expect(scan('export const ok = "anthropic.claude-code";').findings).toEqual([]);
    // documentation links are user navigation, not office requests
    expect(scan('export const doc = "https://docs.anthropic.com/en/docs/claude-code/hooks";').findings).toEqual([]);
    expect(scan('export const both = ["https://docs.anthropic.com/x", "https://api.anthropic.com/v1"];').findings.join()).toMatch(/inference host/);
  });

  it('flags network and process primitives outside the allowlist, but not servers or type-only imports', () => {
    expect(scan('import { createServer } from "node:http";\nimport type { AddressInfo } from "node:net";\nimport { WebSocketServer } from "ws";\nexport { createServer, WebSocketServer };').findings).toEqual([]);
    const cases: Array<[string, Primitive]> = [
      ['import { request } from "node:http";\nrequest({});', 'http-client'],
      ['import * as https from "node:https";\nhttps.get("x");', 'http-client'],
      ['const http = require("http");\nhttp.get({});', 'http-client'],
      ['import { execFile } from "node:child_process";\nexecFile("git", []);', 'child_process'],
      ['const { spawnSync } = require("child_process");\nspawnSync("ls");', 'child_process'],
      ['export const cp = process.getBuiltinModule("node:child_process");', 'child_process'],
      ['import { connect } from "node:net";\nconnect(80);', 'net'],
      ['import WebSocket from "ws";\nnew WebSocket("ws://127.0.0.1");', 'websocket'],
      ['export const go = () => fetch("/api");', 'browser-network'],
      ['export const go = () => globalThis.fetch;', 'browser-network'],
      ['export const x = new XMLHttpRequest();', 'browser-network'],
      ['import { request } from "undici";\nrequest("x");', 'network-lib'],
      ['import { chromium } from "playwright-core";\nchromium.launch();', 'browser-automation'],
    ];
    for (const [src, p] of cases) {
      const r = scan(src);
      expect([...r.primitives], src).toContain(p);
      expect(r.findings, src).toContain(`uses ${p} but is not in the allowlist`);
    }
    const allowed: AllowEntry = { file: 'packages/monitor/src/fixture.ts', allow: ['http-client'], why: 'fixture' };
    expect(scan('import { request } from "node:http";\nrequest({ host: "127.0.0.1" });', allowed.file, allowed).findings).toEqual([]);
  });

  it('flags Claude launches, VS Code model APIs, chat commands and unknown Claude extension commands', () => {
    const cp = 'import { spawn, exec } from "node:child_process";\n';
    const entry: AllowEntry = { file: 'x', allow: ['child_process'], why: 'fixture' };
    for (const cmd of ['spawn("claude", ["-p", "hi"]);', 'spawn("C:\\\\bin\\\\claude.exe", []);', 'exec("cd /w && claude --print hi");', 'const CLI = "claude"; spawn(CLI);'])
      expect(scan(cp + cmd, 'x', entry).findings.join(), cmd).toMatch(/Claude command string/);
    expect(scan(cp + 'spawn("git", ["status"]); export const help = "Claude Code picks up hooks";', 'x', entry).findings).toEqual([]);
    expect(scan(cp + 'spawn("npx", ["@anthropic-ai/claude-code"]);', 'x', entry).findings.join()).toMatch(/Anthropic\/MCP package/);
    const vs = 'packages/vscode-extension/src/fixture.ts';
    expect(scan('import * as vscode from "vscode";\nexport const m = vscode.lm.selectChatModels({});', vs).findings.join()).toMatch(/language-model/);
    expect(scan('import * as vscode from "vscode";\nvscode.commands.executeCommand("workbench.action.chat.open", { query: "hi" });', vs).findings.join()).toMatch(/chat\/Copilot/);
    expect(scan('import * as vscode from "vscode";\nvscode.commands.executeCommand("claude-vscode.sendPrompt", "hi");', vs).findings.join()).toMatch(/not a known UI-only command/);
    expect(scan('import * as vscode from "vscode";\nvscode.commands.executeCommand("claude-vscode.focus");', vs).findings).toEqual([]);
    expect(scan('import * as vscode from "vscode";\nvscode.window.createTerminal("x").sendText("claude");', vs).findings.join()).toMatch(/vscode-process/);
  });

  it('requires loopback URLs in network-capable files', () => {
    const entry: AllowEntry = { file: 'f', allow: ['http-client'], why: 'fixture', allowedUrlHosts: ['x'] };
    const src = 'import { get } from "node:http";\nget(`http://127.0.0.1:${1}/`); get("http://localhost:1"); new URL("/", "http://x");\n';
    expect(scan(src, 'f', entry).findings).toEqual([]);
    expect(scan(src + 'get("https://telemetry.example.com/x");', 'f', entry).findings).toEqual(['network-capable file contains a non-loopback URL host "telemetry.example.com"']);
  });
});
