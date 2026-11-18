#!/usr/bin/env node
/**
 * Repository lint with no extra dependencies: TypeScript plus a few rules implemented here.
 *
 *   1. `tsc -p packages/<pkg> --noEmit` with STRICT_FLAGS for core, monitor, ui and vscode-extension.
 *   2. Repo rules (comments and string literals are tokenised so prose never trips a rule):
 *        no-debugger          `debugger` statements anywhere (src, tests, scripts)
 *        no-focused-tests     `.only(` in tests
 *        no-unexplained-skip  `.skip(` in tests without a comment on the same or previous line
 *        no-console-log       console.log/info/debug/trace/dir/table in packages/*\/src
 *                             (console.error/warn are explicit error paths and allowed; CLI files are exempt)
 *        no-external-urls     http(s)/ws(s) URLs in packages/*\/src whose host is not loopback,
 *                             except documentation links (inside comments, or to a documentation host)
 *        no-ts-suppress       `@ts-ignore` / `@ts-nocheck` (use `@ts-expect-error <reason>`)
 *   3. Documentation and repository hygiene (plain text, every line):
 *        docs-links           relative links and image paths in README.md, CONTRIBUTING.md,
 *                             docs/**\/*.md and packages/*\/README.md must resolve to a repository
 *                             file with the exact letter case (GitHub is case-sensitive), never into
 *                             node_modules or build output. Links in code, URLs with a scheme and
 *                             same-page anchors are skipped; `--anchors` also checks #fragments.
 *        no-internal-notes    development-process markers (INTERNAL_NOTES) in sources, scripts, docs
 *                             and manifests; plain "lead" or "worker" are fine. Allowlist: NOTE_ALLOW.
 *
 * Usage: node scripts/lint.mjs [--rules-only | --tsc-only] [--anchors] [--json] [--root <dir>]
 * Exit code: 0 clean, 1 findings, 2 internal error.
 *
 * Escape hatches (each needs a reason in the comment):
 *   // lint-allow-url: <reason>       on the same or the previous line
 *   // lint-allow-console: <reason>   on the same or the previous line
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name) => argv.includes(name);
const rootArg = argv.indexOf('--root');
const ROOT = rootArg >= 0 && argv[rootArg + 1] ? resolve(argv[rootArg + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = opt('--json');
const RUN_TSC = !opt('--rules-only');
const RUN_RULES = !opt('--tsc-only');
const CHECK_ANCHORS = opt('--anchors');

const PACKAGES = ['core', 'monitor', 'ui', 'vscode-extension'];
const STRICT_FLAGS = ['--noUnusedLocals', '--noUnusedParameters', '--noImplicitReturns', '--noFallthroughCasesInSwitch'];

/** Files allowed to print with console.log (command-line entry points). */
const CONSOLE_ALLOWED_FILES = [/^packages\/monitor\/src\/cli\.ts$/, /^packages\/[^/]+\/src\/cli\/.*$/];

/** Documentation (or XML-namespace) hosts: links to them never make the office contact the network. */
const DOC_HOSTS = new Set([
  'code.claude.com',
  'docs.claude.com',
  'docs.anthropic.com',
  'support.claude.com',
  'support.anthropic.com',
  'github.com',
  'developer.mozilla.org',
  'nodejs.org',
  'code.visualstudio.com',
  'marketplace.visualstudio.com',
  'www.typescriptlang.org',
  'react.dev',
  'pixijs.com',
  'pixijs.download',
  'vitest.dev',
  'vite.dev',
  'playwright.dev',
  'www.w3.org',
  'json-schema.org',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const posix = (p) => p.split(sep).join('/');

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist' || name === 'media' || name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Classify every character of a JS/TS(X) source as code (0), comment (1), string (2) or
 * regex (3). Heuristic but robust for this codebase: strings never span lines (an
 * unterminated quote, e.g. an apostrophe in JSX text, stops at the end of the line),
 * template literals nest through `${}`, and `/` starts a regex only after an operator.
 */
export function classify(src) {
  const cls = new Uint8Array(src.length);
  const n = src.length;
  const stack = []; // 'tpl' | 'brace'
  let mode = 'code';
  let lastSig = '';
  let lastWord = '';
  const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
  const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (mode === 'tpl') {
      if (c === '\\') {
        cls[i] = 2;
        if (i + 1 < n) cls[i + 1] = 2;
        i += 2;
        continue;
      }
      if (c === '`') {
        cls[i] = 2;
        i++;
        mode = 'code';
        lastSig = '`';
        lastWord = '';
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        cls[i] = 2;
        cls[i + 1] = 2;
        i += 2;
        stack.push('tpl');
        mode = 'code';
        lastSig = '{';
        lastWord = '';
        continue;
      }
      cls[i] = 2;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') cls[i++] = 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      while (i < stop) cls[i++] = 1;
      continue;
    }
    if (c === "'" || c === '"') {
      cls[i++] = 2;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < n && src[i + 1] !== '\n') cls[i++] = 2;
        cls[i++] = 2;
      }
      if (i < n && src[i] === c) cls[i++] = 2;
      lastSig = c;
      lastWord = '';
      continue;
    }
    if (c === '`') {
      cls[i++] = 2;
      mode = 'tpl';
      continue;
    }
    if (c === '/' && (REGEX_AFTER.has(lastSig) || REGEX_KEYWORDS.has(lastWord))) {
      const start = i;
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && src[j] !== '\n') {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) {
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(src[j])) j++;
        for (let k = start; k < j; k++) cls[k] = 3;
        i = j;
        lastSig = '/';
        lastWord = '';
        continue;
      }
      // Not a regex after all (e.g. a JSX closing tag): treat the slash as code.
    }
    if (c === '{') stack.push('brace');
    if (c === '}') {
      const top = stack.pop();
      if (top === 'tpl') {
        cls[i] = 2;
        i++;
        mode = 'tpl';
        continue;
      }
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      lastWord = src.slice(i, j);
      lastSig = 'w';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      lastSig = c;
      lastWord = '';
    }
    i++;
  }
  return cls;
}

function lineTable(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Text of each line restricted to one character class (others blanked out). */
function linesOfClass(src, cls, wanted) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    out += ch === '\n' || cls[i] === wanted ? ch : ' ';
  }
  return out.split('\n');
}

function hostOf(rest) {
  let authority = rest.split(/[/?#]/)[0] ?? '';
  authority = authority.replace(/^[^@]*@/, '');
  if (authority.startsWith('[')) return authority.slice(0, authority.indexOf(']') + 1).toLowerCase();
  return authority.split(':')[0].toLowerCase();
}

function runRules() {
  const findings = [];
  const counts = {};
  const RULE_NAMES = ['no-debugger', 'no-focused-tests', 'no-unexplained-skip', 'no-console-log', 'no-external-urls', 'no-ts-suppress', 'docs-links', 'no-internal-notes'];
  for (const r of RULE_NAMES) counts[r] = 0;
  const add = (rule, file, line, message) => {
    counts[rule] += 1;
    findings.push({ rule, file, line, message });
  };

  const files = [
    ...walk(join(ROOT, 'packages')).filter((f) => /[\\/]packages[\\/][^\\/]+[\\/](src|test|scripts)[\\/]/.test(f)),
    ...walk(join(ROOT, 'scripts')),
  ];
  let scanned = 0;
  for (const abs of files) {
    const rel = posix(relative(ROOT, abs));
    if (rel === 'scripts/lint.mjs') continue; // this file names every pattern it looks for
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    const cls = classify(src);
    const starts = lineTable(src);
    const code = linesOfClass(src, cls, 0);
    const comments = linesOfClass(src, cls, 1);
    const raw = src.split('\n');
    const isSrc = /^packages\/[^/]+\/src\//.test(rel);
    const isTest = /^packages\/[^/]+\/test\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
    const commentNear = (ln, marker) => {
      for (const k of [ln, ln - 1]) {
        if (k < 0) continue;
        const text = comments[k] ?? '';
        if (marker ? text.includes(marker) : text.replace(/[\s/*]/g, '').length >= 8) return true;
      }
      return false;
    };

    code.forEach((line, ln) => {
      if (/\bdebugger\b/.test(line)) add('no-debugger', rel, ln + 1, 'debugger statement');
      if (isTest && /\b(?:describe|it|test|suite|bench)(?:\.\w+)*\.only\b/.test(line)) add('no-focused-tests', rel, ln + 1, '.only() left in a test');
      if (isTest && /\b(?:describe|it|test|suite|bench)(?:\.(?:concurrent|sequential|each|fails))*\.skip\b(?!If)/.test(line) && !commentNear(ln)) {
        add('no-unexplained-skip', rel, ln + 1, '.skip() without a reason comment on the same or previous line');
      }
      if (isSrc && /\bconsole\.(?:log|info|debug|trace|dir|table)\s*\(/.test(line)) {
        const allowed = CONSOLE_ALLOWED_FILES.some((re) => re.test(rel)) || commentNear(ln, 'lint-allow-console');
        if (!allowed) add('no-console-log', rel, ln + 1, `${(raw[ln] ?? '').trim().slice(0, 80)} (use console.error/warn for error paths, or remove)`);
      }
    });
    comments.forEach((line, ln) => {
      if (/@ts-(?:ignore|nocheck)\b/.test(line)) add('no-ts-suppress', rel, ln + 1, '@ts-ignore/@ts-nocheck (use @ts-expect-error with a reason)');
    });

    if (isSrc) {
      const re = /\b(https?|wss?):\/\/([^\s'"`<>()\\]+)/gi;
      let m;
      while ((m = re.exec(src))) {
        const idx = m.index;
        const ln = lineOf(starts, idx);
        if (cls[idx] === 1) continue; // documentation inside a comment
        if (cls[idx] === 3) continue; // part of a regex literal
        const host = hostOf(m[2]);
        if (!host || host.startsWith('$') || host.startsWith('{')) continue; // dynamic host: covered by runtime tests
        if (LOOPBACK_HOSTS.has(host)) continue;
        if (DOC_HOSTS.has(host)) continue;
        if (commentNear(ln, 'lint-allow-url')) continue;
        // Simulated tool inputs (e.g. a SIMULATED WebFetch target) are data shown as a summary, never requested.
        if (/simulat/i.test(rel) && /\b(?:url|query|website|href)\s*:/.test(raw[ln] ?? '')) continue;
        add('no-external-urls', rel, ln + 1, `non-loopback URL ${m[0].slice(0, 100)}`);
      }
    }
  }
  scanned += checkDocLinks(add);
  scanned += checkInternalNotes(add);
  return { scanned, findings, counts };
}

/** Markdown files whose relative links are published (repository front page, docs, extension README). */
function markdownFiles() {
  const out = [];
  for (const name of ['README.md', 'CONTRIBUTING.md']) if (existsSync(join(ROOT, name))) out.push(join(ROOT, name));
  const docs = (dir) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (d.isDirectory()) docs(join(dir, d.name));
      else if (d.name.toLowerCase().endsWith('.md')) out.push(join(dir, d.name));
    }
  };
  docs(join(ROOT, 'docs'));
  for (const pkg of readdirSafe(join(ROOT, 'packages'))) {
    const readme = join(ROOT, 'packages', pkg, 'README.md');
    if (existsSync(readme)) out.push(readme);
  }
  return out;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Markdown with code blocks, code spans and HTML comments blanked out (same length per line, so
 * line numbers and columns stay valid).
 */
function markdownProse(src) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let text = src.replace(/<!--[\s\S]*?-->/g, blank);
  const lines = text.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !/\S/.test(lines[i].slice(m.index + m[0].length))) fence = null;
      lines[i] = blank(lines[i]);
      continue;
    }
    if (m) {
      fence = m[1];
      lines[i] = blank(lines[i]);
      continue;
    }
    lines[i] = lines[i].replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, blank);
  }
  return lines;
}

/** GitHub's heading anchors for a markdown file (lowercase, punctuation dropped, spaces to dashes, -n for repeats). */
function headingAnchors(src) {
  const seen = new Map();
  const out = new Set();
  for (const line of markdownProse(src)) {
    const m = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[1].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '');
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  // Explicit anchors (<a name="x"> / id="x") count too.
  for (const m of src.matchAll(/<a\s+[^>]*?\b(?:name|id)\s*=\s*["']([^"']+)["']/gi)) out.add(m[1]);
  return out;
}

/** The on-disk path with the exact case of every segment, or undefined when a segment differs or is missing. */
function exactCase(abs) {
  const rel = relative(ROOT, abs);
  if (!rel || rel.startsWith('..')) return existsSync(abs) ? abs : undefined;
  let cur = ROOT;
  for (const seg of rel.split(sep)) {
    if (!seg) continue;
    if (!readdirSafe(cur).includes(seg)) return undefined;
    cur = join(cur, seg);
  }
  return cur;
}

function checkDocLinks(add) {
  const files = markdownFiles();
  const anchorCache = new Map();
  const anchorsOf = (abs) => {
    if (!anchorCache.has(abs)) anchorCache.set(abs, headingAnchors(readFileSync(abs, 'utf8')));
    return anchorCache.get(abs);
  };
  for (const abs of files) {
    const rel = posix(relative(ROOT, abs));
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = markdownProse(src);
    lines.forEach((line, ln) => {
      const targets = [];
      for (const m of line.matchAll(/!?\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) targets.push(m[1]);
      const def = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line);
      if (def) targets.push(def[1]);
      for (const m of line.matchAll(/<(?:img|a|source|link)\b[^>]*?\b(?:src|href|srcset)\s*=\s*["']([^"'\s]+)[^"']*["']/gi)) targets.push(m[1]);
      for (let target of targets) {
        target = target.replace(/^<|>$/g, '').trim();
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue; // URL with a scheme
        const hash = target.indexOf('#');
        const fragment = hash >= 0 ? target.slice(hash + 1) : '';
        let pathPart = (hash >= 0 ? target.slice(0, hash) : target).replace(/\?.*$/, '');
        try {
          pathPart = decodeURIComponent(pathPart);
        } catch {
          /* keep as written */
        }
        let resolved;
        if (!pathPart) {
          if (!CHECK_ANCHORS || !fragment) continue; // same-page anchor
          resolved = abs;
        } else {
          resolved = pathPart.startsWith('/') ? join(ROOT, pathPart) : join(dirname(abs), pathPart);
          const inside = relative(ROOT, resolved);
          if (inside.startsWith('..') || resolve(resolved) === resolve(ROOT, '..')) {
            add('docs-links', rel, ln + 1, `link points outside the repository: ${target}`);
            continue;
          }
          if (/(^|[\\/])(node_modules|dist)([\\/]|$)/.test(inside)) {
            add('docs-links', rel, ln + 1, `link points into build output or dependencies (not published): ${target}`);
            continue;
          }
          if (!existsSync(resolved)) {
            add('docs-links', rel, ln + 1, `broken relative link: ${target}`);
            continue;
          }
          if (!exactCase(resolved.replace(/[\\/]+$/, ''))) {
            add('docs-links', rel, ln + 1, `letter case differs from the file on disk (breaks on case-sensitive hosts): ${target}`);
            continue;
          }
        }
        if (CHECK_ANCHORS && fragment && /\.md$/i.test(resolved) && statSync(resolved).isFile()) {
          let frag = fragment;
          try {
            frag = decodeURIComponent(fragment);
          } catch {
            /* keep as written */
          }
          if (!anchorsOf(resolved).has(frag.toLowerCase()) && !anchorsOf(resolved).has(frag)) add('docs-links', rel, ln + 1, `no heading for anchor #${fragment} in ${posix(relative(ROOT, resolved))}`);
        }
      }
    });
  }
  return files.length;
}

/** Development-process markers that must not ship in sources, docs or manifests. */
const INTERNAL_NOTES = [
  [/\bwork[- ]?streams?\s*#?\d/i, 'development workstream reference'],
  [/\b[Ww]orkers?\s+[A-G1-7]\b(?![-.]\w)/, 'development worker reference'],
  [/\bowned by (?:the )?lead\b/i, 'development ownership note'],
  [/\blead[- ]owned\b/i, 'development ownership note'],
  // "(lead)" as an annotation, not code such as `if (lead)` or `walk(lead)`.
  [/(?<![\w$\])])(?<!\b(?:if|while|for|switch|return|await|typeof|catch)\s)\(lead\)/, 'development ownership note'],
  [/\bowned by others\b/i, 'development ownership note'],
];

/**
 * Narrow allowlist: [file (posix, relative to the root), pattern or null for the whole file, reason].
 * Keep each entry justified; prefer rewording the text.
 */
const NOTE_ALLOW = [['scripts/lint.mjs', null, 'this linter names the markers it looks for']];

const NOTE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|md|css|html|json|ya?ml|txt)$/i;

function noteFiles() {
  const out = [];
  const walkText = (dir) => {
    for (const name of readdirSafe(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'media' || name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walkText(full);
      else if (NOTE_EXT.test(name) && name !== 'package-lock.json') out.push(full);
    }
  };
  for (const pkg of readdirSafe(join(ROOT, 'packages'))) {
    const base = join(ROOT, 'packages', pkg);
    for (const sub of ['src', 'test', 'scripts']) walkText(join(base, sub));
    for (const name of readdirSafe(base)) if (NOTE_EXT.test(name) && !name.startsWith('.')) out.push(join(base, name));
  }
  walkText(join(ROOT, 'scripts'));
  walkText(join(ROOT, 'docs'));
  for (const name of readdirSafe(ROOT)) {
    if (NOTE_EXT.test(name) && name !== 'package-lock.json' && !name.startsWith('.')) {
      try {
        if (statSync(join(ROOT, name)).isFile()) out.push(join(ROOT, name));
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

function checkInternalNotes(add) {
  const files = noteFiles();
  for (const abs of files) {
    const rel = posix(relative(ROOT, abs));
    const allow = NOTE_ALLOW.filter(([f]) => f === rel);
    if (allow.some(([, re]) => re === null)) continue;
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    src.split('\n').forEach((line, ln) => {
      for (const [re, what] of INTERNAL_NOTES) {
        const text = line.trim();
        const m = re.exec(text);
        if (!m || allow.some(([, a]) => a && a.test(line))) continue;
        const from = Math.max(0, m.index - 20);
        add('no-internal-notes', rel, ln + 1, `${what}: "${from ? '…' : ''}${text.slice(from, m.index + m[0].length + 40)}"`);
        break;
      }
    });
  }
  return files.length;
}

function tscCommand() {
  const bin = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (existsSync(bin)) return { cmd: process.execPath, pre: [bin], shell: false };
  return { cmd: 'npx', pre: ['tsc'], shell: process.platform === 'win32' };
}

function runTsc(pkg) {
  const dir = join(ROOT, 'packages', pkg);
  const started = Date.now();
  if (!existsSync(join(dir, 'tsconfig.json'))) return Promise.resolve({ pkg, ok: false, ms: 0, errors: [`packages/${pkg}/tsconfig.json not found`], exitCode: null });
  const { cmd, pre, shell } = tscCommand();
  return new Promise((done) => {
    const p = spawn(cmd, [...pre, '-p', dir, '--noEmit', '--pretty', 'false', ...STRICT_FLAGS], { cwd: ROOT, shell, windowsHide: true });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (out += c));
    p.on('error', (e) => done({ pkg, ok: false, ms: Date.now() - started, errors: [`failed to run tsc: ${e.message}`], exitCode: null }));
    p.on('close', (code) => {
      const lines = out.split(/\r?\n/).filter((l) => l.trim());
      const errors = lines.filter((l) => /error TS\d+/.test(l)).map((l) => posix(l.replace(ROOT + sep, '').replace(posix(ROOT) + '/', '')));
      const other = code !== 0 && !errors.length ? lines.slice(0, 20) : [];
      done({ pkg, ok: code === 0, ms: Date.now() - started, errors: [...errors, ...other], exitCode: code });
    });
  });
}

async function main() {
  const t0 = Date.now();
  const tsc = RUN_TSC ? await Promise.all(PACKAGES.map(runTsc)) : [];
  const rules = RUN_RULES ? runRules() : { scanned: 0, findings: [], counts: {} };
  const tscErrors = tsc.reduce((s, r) => s + (r.ok ? 0 : Math.max(1, r.errors.length)), 0);
  const total = tscErrors + rules.findings.length;

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: total === 0, flags: STRICT_FLAGS, tsc, rules, ms: Date.now() - t0 }, null, 2));
    return total === 0 ? 0 : 1;
  }

  if (RUN_TSC) {
    console.log(`TypeScript (${STRICT_FLAGS.join(' ')})`);
    for (const r of tsc) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  packages/${r.pkg}  (${(r.ms / 1000).toFixed(1)}s${r.ok ? '' : `, ${r.errors.length} error(s)`})`);
      for (const e of r.errors.slice(0, 50)) console.log(`        ${e}`);
      if (r.errors.length > 50) console.log(`        ... ${r.errors.length - 50} more`);
    }
  }
  if (RUN_RULES) {
    console.log(`Repo rules (${rules.scanned} files)`);
    for (const [rule, n] of Object.entries(rules.counts)) {
      console.log(`  ${n ? 'FAIL' : 'PASS'}  ${rule}${n ? ` (${n})` : ''}`);
      for (const f of rules.findings.filter((x) => x.rule === rule)) console.log(`        ${f.file}:${f.line}: ${f.message}`);
    }
  }
  console.log(total === 0 ? `lint: clean (${((Date.now() - t0) / 1000).toFixed(1)}s)` : `lint: ${total} problem(s): ${tscErrors} TypeScript, ${rules.findings.length} repo-rule`);
  return total === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`lint: internal error: ${e?.stack ?? e}`);
    process.exit(2);
  },
);
