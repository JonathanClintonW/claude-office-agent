// Read-only local Git status plugin.
//
// Safety rules (see docs/DASHBOARD.md):
// - git is started ONLY through execFile('git', args, { cwd, timeout, maxBuffer, windowsHide: true }):
//   no shell, a time budget and an output cap on every call.
// - Only read-only subcommands from READ_ONLY_SUBCOMMANDS run. Network commands (fetch, pull, push,
//   remote, ls-remote, clone, submodule) are never issued, so nothing leaves the machine.
// - Only directories that are the cwd of an agent in the monitor state are inspected; params from
//   the UI are validated against that set, so arbitrary paths cannot be probed.
// - `--no-optional-locks` keeps `git status` from rewriting the index; fsmonitor hooks, external
//   diff drivers and textconv filters are disabled.
// - No file contents, diffs, author names or emails are read or returned.
import { execFile, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import {
  baseName,
  displayPath,
  fromGitBashPath,
  GIT_EDIT_TOOLS,
  GIT_LIMITS,
  isPathInside,
  isWindowsPath,
  normalizePathKey,
  safeText,
  truncate,
  type Agent,
  type GitBranchInfo,
  type GitChangeCounts,
  type GitChangeKind,
  type GitCommitInfo,
  type GitConflictSession,
  type GitDiffTotals,
  type GitFileChange,
  type GitPotentialConflict,
  type GitProblem,
  type GitRepoAgents,
  type GitRepoInfo,
  type GitReposResult,
  type GitStatusResult,
  type GitUnresolvedDir,
  type OfficeState,
} from '@agent-office/core';
import type { MonitorPlugin, PluginContext } from '../plugin';

/** The only git subcommands this plugin may run. */
const READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set(['rev-parse', 'status', 'log', 'diff']);

/** Prepended to every invocation (global options, before the subcommand). */
const SAFE_GLOBAL_ARGS = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=off',
  '-c',
  'color.ui=never',
  '-c',
  'log.showSignature=false',
];

type GitRun = { ok: true; stdout: string } | { ok: false; problem: GitProblem };

// ---------------------------------------------------------------- pure parsing (exported for tests)

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanName(s: string, max: number): string {
  return truncate(s.replace(CONTROL_CHARS, '?').trim(), max);
}

/** Parse the `## …` header of `git status --porcelain=v1 -b`. */
export function parseBranchHeader(header: string): GitBranchInfo {
  let h = header.replace(/^## /, '').trim();
  let initial = false;
  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(h);
  if (unborn) {
    initial = true;
    h = unborn[1]!;
  }
  if (/^HEAD \(no branch\)/.test(h)) return { name: null, detached: true, initial };
  const m = /^(.*?)(?:\.\.\.(\S+))?(?: \[([^\]]*)\])?$/.exec(h);
  const info: GitBranchInfo = { name: cleanName(m?.[1] ?? h, 160) || null, detached: false, initial };
  const upstream = m?.[2];
  if (upstream) {
    info.upstream = cleanName(upstream, 160);
    const track = m?.[3] ?? '';
    if (/\bgone\b/.test(track)) {
      info.upstreamGone = true;
    } else {
      info.ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
      info.behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
    }
  }
  return info;
}

const UNMERGED_CODES: ReadonlySet<string> = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function changeKind(code: string): GitChangeKind {
  if (code === '??') return 'untracked';
  if (UNMERGED_CODES.has(code)) return 'unmerged';
  const x = code[0] ?? ' ';
  const y = code[1] ?? ' ';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C' || y === 'C') return 'copied';
  if (x === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'T' || y === 'T') return 'type_changed';
  return 'modified';
}

/** Parse `git status --porcelain=v1 -b -z` (NUL separated; renames are `XY new\0old\0`). */
export function parseStatusZ(stdout: string): { branch: GitBranchInfo; files: GitFileChange[] } {
  const tokens = stdout.split('\0');
  let branch: GitBranchInfo = { name: null, detached: false, initial: false };
  const files: GitFileChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok) continue;
    if (tok.startsWith('## ')) {
      branch = parseBranchHeader(tok);
      continue;
    }
    if (tok.length < 4 || tok[2] !== ' ') continue;
    const code = tok.slice(0, 2);
    if (code === '!!') continue;
    const x = code[0]!;
    const y = code[1]!;
    const f: GitFileChange = {
      path: cleanName(tok.slice(3), 300),
      kind: changeKind(code),
      staged: x !== ' ' && x !== '?',
      // Untracked (`??`) counts as a working-tree change.
      unstaged: y !== ' ',
      code,
    };
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const orig = tokens[++i];
      if (orig) f.origPath = cleanName(orig, 300);
    }
    files.push(f);
  }
  return { branch, files };
}

export function countChanges(files: readonly GitFileChange[]): GitChangeCounts {
  const c: GitChangeCounts = { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, unmerged: 0, total: files.length };
  for (const f of files) {
    if (f.kind === 'modified' || f.kind === 'type_changed') c.modified++;
    else if (f.kind === 'renamed' || f.kind === 'copied') c.renamed++;
    else c[f.kind]++;
  }
  return c;
}

/** Totals of `git diff --numstat` output. Paths are ignored. */
export function parseNumstat(stdout: string): GitDiffTotals {
  const t: GitDiffTotals = { files: 0, insertions: 0, deletions: 0, binaryFiles: 0 };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ins, del] = line.split('\t');
    t.files++;
    if (ins === '-' || del === '-') {
      t.binaryFiles++;
      continue;
    }
    t.insertions += Number(ins) || 0;
    t.deletions += Number(del) || 0;
  }
  return t;
}

/** Parse `git log --format=%h%x1f%aI%x1f%s%x1e` (hash, ISO author date, subject; no author identity). */
export function parseLog(stdout: string, max: number = GIT_LIMITS.maxCommits): GitCommitInfo[] {
  const out: GitCommitInfo[] = [];
  for (const rec of stdout.split('\x1e')) {
    if (out.length >= max) break;
    const r = rec.replace(/^\s+/, '');
    if (!r) continue;
    const [hash = '', date = '', ...rest] = r.split('\x1f');
    if (!/^[0-9a-f]{4,40}$/.test(hash) || !Number.isFinite(Date.parse(date.trim()))) continue;
    out.push({ hash, date: date.trim(), subject: safeText(rest.join(' '), 200) ?? '' });
  }
  return out;
}

function absoluteTarget(target: string, cwd: string | undefined): string | undefined {
  if (isWindowsPath(target) || target.startsWith('/')) return target;
  if (!cwd) return undefined;
  return isWindowsPath(cwd) ? win32.resolve(cwd, target) : posix.resolve(cwd, target);
}

function joinRoot(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${rel}`;
}

/** Path of `abs` relative to the first base containing it, with `/` separators. */
function relativeToRepo(abs: string, bases: readonly string[]): string | undefined {
  for (const b of bases) {
    if (!isPathInside(abs, b)) continue;
    const rel = displayPath(abs, b).replace(/\\/g, '/');
    return rel === '.' ? undefined : rel;
  }
  return undefined;
}

/** `cwd` with as many trailing segments removed as `prefix` (from `rev-parse --show-prefix`) has. */
export function repoRootAlias(cwd: string, prefix: string): string {
  const depth = prefix.split('/').filter(Boolean).length;
  const p = isWindowsPath(cwd) ? win32 : posix;
  let out = cwd;
  for (let i = 0; i < depth; i++) out = p.dirname(out);
  return out;
}

/**
 * Heuristic potential conflicts: files inside the repository that edit tool calls from two or more
 * sessions targeted (retained tool history only). Failed, denied and interrupted edits are ignored.
 * `aliases` are other spellings of the root (e.g. as the agents' cwds spell it: 8.3 short names,
 * Git Bash paths), so tool targets reported by Claude Code still match git's root.
 */
export function potentialConflicts(
  state: OfficeState,
  root: string,
  changed: readonly GitFileChange[] = [],
  aliases: readonly string[] = [],
): GitPotentialConflict[] {
  const bases = [root, ...aliases.filter((a) => normalizePathKey(a) !== normalizePathKey(root))];
  const dirtyFiles = new Set<string>();
  const dirtyDirs: string[] = [];
  for (const f of changed) {
    if (f.path.endsWith('/')) dirtyDirs.push(f.path);
    else dirtyFiles.add(normalizePathKey(joinRoot(root, f.path)));
  }
  const byPath = new Map<string, { rel: string; sessions: Map<string, GitConflictSession> }>();
  for (const a of Object.values(state.agents)) {
    for (const t of a.tools) {
      if (!t.target || !GIT_EDIT_TOOLS.includes(t.name)) continue;
      if (t.status === 'failed' || t.status === 'denied' || t.status === 'interrupted') continue;
      const abs = absoluteTarget(t.target, a.cwd);
      const rel = abs ? relativeToRepo(abs, bases) : undefined;
      if (!rel) continue;
      const key = normalizePathKey(joinRoot(root, rel));
      let entry = byPath.get(key);
      if (!entry) {
        entry = { rel, sessions: new Map() };
        byPath.set(key, entry);
      }
      let s = entry.sessions.get(a.sessionId);
      if (!s) {
        s = { sessionId: a.sessionId, agentKeys: [], toolNames: [] };
        entry.sessions.set(a.sessionId, s);
      }
      if (!s.agentKeys.includes(a.key)) s.agentKeys.push(a.key);
      if (!s.toolNames.includes(t.name)) s.toolNames.push(t.name);
      const at = t.endedAt ?? t.startedAt;
      if (at !== undefined && (s.lastAt === undefined || at > s.lastAt)) s.lastAt = at;
    }
  }
  const out: GitPotentialConflict[] = [];
  for (const [key, entry] of byPath) {
    if (entry.sessions.size < 2) continue;
    const sessions = [...entry.sessions.values()].sort((x, y) => (y.lastAt ?? 0) - (x.lastAt ?? 0));
    out.push({
      path: cleanName(entry.rel, 300),
      sessions,
      uncommitted: dirtyFiles.has(key) || dirtyDirs.some((d) => isPathInside(joinRoot(root, entry.rel), joinRoot(root, d))),
    });
  }
  const latest = (c: GitPotentialConflict) => Math.max(0, ...c.sessions.map((s) => s.lastAt ?? 0));
  return out.sort((x, y) => y.sessions.length - x.sessions.length || latest(y) - latest(x)).slice(0, GIT_LIMITS.maxConflicts);
}

// ---------------------------------------------------------------- process helpers

function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            queue.shift()?.();
          });
      };
      if (active < max) start();
      else queue.push(start);
    });
  };
}

interface ExecError extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

function classify(err: ExecError, stderr: string): GitProblem {
  if (err.code === 'ENOENT') return { code: 'git_missing', message: 'git is not installed or not on PATH' };
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { code: 'failed', message: 'git output exceeded the size cap' };
  if (err.killed || err.signal) return { code: 'timeout', message: `git did not answer within ${GIT_LIMITS.commandTimeoutMs / 1000} s` };
  if (/not a git repository|must be run in a work tree/i.test(stderr)) return { code: 'not_a_repo', message: 'Not a git repository' };
  if (/dubious ownership/i.test(stderr)) return { code: 'failed', message: 'git refused to read this repository (safe.directory ownership check)' };
  const first = stderr.split(/\r?\n/).find((l) => /\S/.test(l) && !/^warning:/i.test(l));
  return { code: 'failed', message: safeText(first?.replace(/^fatal:\s*/i, ''), 160) ?? `git exited with code ${String(err.code ?? 'unknown')}` };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function isAbsoluteDir(p: string): boolean {
  return isWindowsPath(p) || p.startsWith('/');
}

/** The cwd string as the OS expects it (Git Bash style `/c/x` becomes `c:\x` on Windows). */
function execDirOf(cwd: string): string {
  return process.platform === 'win32' ? fromGitBashPath(cwd) : cwd;
}

// ---------------------------------------------------------------- plugin

interface AgentDir {
  cwd: string;
  agents: Agent[];
  lastActivity: number;
}

/** `alias` is the root spelled the way the agent's cwd spells it. */
type RootLookup = { root: string; alias: string } | { problem: GitProblem };

interface RawStatus {
  checkedAt: number;
  branch: GitBranchInfo;
  files: GitFileChange[];
  commits: GitCommitInfo[];
  commitsProblem?: GitProblem;
  diff: { unstaged: GitDiffTotals | null; staged: GitDiffTotals | null };
}

interface CacheEntry<T> {
  at: number;
  ttl: number;
  value: Promise<T>;
}

/** Agent working directories in the state, keyed by normalized path. */
function agentDirs(state: OfficeState): Map<string, AgentDir> {
  const dirs = new Map<string, AgentDir>();
  for (const a of Object.values(state.agents)) {
    if (!a.cwd || !a.cwd.trim()) continue;
    const key = normalizePathKey(a.cwd);
    const d = dirs.get(key);
    if (d) {
      d.agents.push(a);
      d.lastActivity = Math.max(d.lastActivity, a.lastEventAt);
    } else dirs.set(key, { cwd: a.cwd, agents: [a], lastActivity: a.lastEventAt });
  }
  return dirs;
}

function summarizeAgents(dirs: Iterable<AgentDir>): GitRepoAgents {
  const agentKeys = new Set<string>();
  const sessionIds = new Set<string>();
  const cwds: string[] = [];
  for (const d of dirs) {
    cwds.push(d.cwd);
    for (const a of d.agents) {
      agentKeys.add(a.key);
      sessionIds.add(a.sessionId);
    }
  }
  return { agentKeys: [...agentKeys], sessionIds: [...sessionIds], cwds };
}

export function gitPlugin(): MonitorPlugin {
  let ctx: PluginContext | undefined;
  const children = new Set<ChildProcess>();
  const limit = createLimiter(GIT_LIMITS.concurrency);
  const rootCache = new Map<string, CacheEntry<RootLookup>>();
  /** Settled root lookups (dir key → normalized root key and alias), used to attribute agents to repos. */
  const knownRoots = new Map<string, { rootKey: string; alias: string } | null>();
  /** Bounded: one entry per distinct agent cwd, oldest dropped first. */
  const rememberRoot = (dirKey: string, v: { rootKey: string; alias: string } | null) => {
    knownRoots.delete(dirKey);
    knownRoots.set(dirKey, v);
    if (knownRoots.size > 500) knownRoots.delete(knownRoots.keys().next().value!);
  };
  const statusCache = new Map<string, CacheEntry<RawStatus | { problem: GitProblem }>>();

  const now = () => ctx?.now() ?? Date.now();

  function runGit(dir: string, sub: string[]): Promise<GitRun> {
    const verb = sub[0];
    if (!verb || !READ_ONLY_SUBCOMMANDS.has(verb)) return Promise.resolve({ ok: false, problem: { code: 'failed', message: `refused git subcommand ${String(verb)}` } });
    const args = [...SAFE_GLOBAL_ARGS, ...sub];
    const cwd = dir;
    const timeout = GIT_LIMITS.commandTimeoutMs;
    const maxBuffer = GIT_LIMITS.maxBufferBytes;
    return limit(
      () =>
        new Promise<GitRun>((resolve) => {
          if (!ctx) return resolve({ ok: false, problem: { code: 'failed', message: 'git plugin stopped' } });
          let child: ChildProcess | undefined;
          try {
            child = execFile('git', args, { cwd, timeout, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
              if (child) children.delete(child);
              if (err) resolve({ ok: false, problem: classify(err as ExecError, String(stderr ?? '')) });
              else resolve({ ok: true, stdout: String(stdout) });
            });
            children.add(child);
          } catch (e) {
            resolve({ ok: false, problem: classify(e as ExecError, '') });
          }
        }),
    );
  }

  function cached<T>(map: Map<string, CacheEntry<T>>, key: string, ttl: number, failTtl: number, isFailure: (v: T) => boolean, load: () => Promise<T>): Promise<T> {
    const t = now();
    const hit = map.get(key);
    if (hit && t - hit.at < hit.ttl) return hit.value;
    if (map.size > 400) for (const [k, e] of map) if (t - e.at >= e.ttl) map.delete(k);
    const entry: CacheEntry<T> = { at: t, ttl, value: load() };
    entry.value.then(
      (v) => {
        if (isFailure(v)) entry.ttl = failTtl;
      },
      () => map.delete(key),
    );
    map.set(key, entry);
    return entry.value;
  }

  function lookupRoot(dirKey: string, cwd: string): Promise<RootLookup> {
    return cached(rootCache, dirKey, GIT_LIMITS.rootCacheMs, GIT_LIMITS.cacheMs, (v) => 'problem' in v, async () => {
      if (!isAbsoluteDir(cwd)) return { problem: { code: 'missing_dir', message: 'The working directory is not an absolute path' } };
      const dir = execDirOf(cwd);
      if (!(await isDirectory(dir))) return { problem: { code: 'missing_dir', message: 'The directory does not exist on this machine' } };
      const r = await runGit(dir, ['rev-parse', '--show-toplevel', '--show-prefix']);
      if (!r.ok) {
        if (r.problem.code === 'not_a_repo') rememberRoot(dirKey, null);
        return { problem: r.problem };
      }
      const [first = '', prefix = ''] = r.stdout.split(/\r?\n/);
      const root = first.trim();
      if (!root) return { problem: { code: 'failed', message: 'git did not report a repository root' } };
      const alias = repoRootAlias(cwd, prefix.trim());
      rememberRoot(dirKey, { rootKey: normalizePathKey(root), alias });
      return { root, alias };
    });
  }

  function readStatus(rootKey: string, dir: string): Promise<RawStatus | { problem: GitProblem }> {
    return cached(statusCache, rootKey, GIT_LIMITS.cacheMs, GIT_LIMITS.cacheMs, (v) => 'problem' in v, async () => {
      const checkedAt = now();
      const st = await runGit(dir, ['status', '--porcelain=v1', '-b', '-z']);
      if (!st.ok) return { problem: st.problem };
      const { branch, files } = parseStatusZ(st.stdout);
      const numstat = ['--numstat', '--no-ext-diff', '--no-textconv', '--no-color'];
      const [unstaged, staged, log] = await Promise.all([
        runGit(dir, ['diff', ...numstat]),
        runGit(dir, ['diff', '--cached', ...numstat]),
        branch.initial ? Promise.resolve<GitRun>({ ok: true, stdout: '' }) : runGit(dir, ['log', `-n${GIT_LIMITS.maxCommits}`, '--no-color', '--format=%h%x1f%aI%x1f%s%x1e']),
      ]);
      const raw: RawStatus = {
        checkedAt,
        branch,
        files,
        commits: log.ok ? parseLog(log.stdout) : [],
        diff: { unstaged: unstaged.ok ? parseNumstat(unstaged.stdout) : null, staged: staged.ok ? parseNumstat(staged.stdout) : null },
      };
      if (!log.ok) raw.commitsProblem = log.problem;
      return raw;
    });
  }

  function requireCtx(): PluginContext {
    if (!ctx) throw new Error('git plugin is not running');
    return ctx;
  }

  /** Agent directories that belong to the repository at `root` (exact when the root lookup is known). */
  function dirsInRepo(dirs: Map<string, AgentDir>, root: string): { dirs: AgentDir[]; aliases: string[] } {
    const rootKey = normalizePathKey(root);
    const out: AgentDir[] = [];
    const aliases = new Map<string, string>();
    for (const [key, d] of dirs) {
      const known = knownRoots.get(key);
      if (known !== undefined ? known?.rootKey === rootKey : isPathInside(d.cwd, root)) out.push(d);
      if (known && known.rootKey === rootKey) aliases.set(normalizePathKey(known.alias), known.alias);
    }
    return { dirs: out, aliases: [...aliases.values()] };
  }

  return {
    name: 'git',
    start(c) {
      ctx = c;
    },
    stop() {
      ctx = undefined;
      for (const child of children) child.kill();
      children.clear();
      rootCache.clear();
      statusCache.clear();
      knownRoots.clear();
    },
    routes: {
      /** Repositories containing the working directories of agents in the monitor state. */
      async repos(): Promise<GitReposResult> {
        const c = requireCtx();
        const checkedAt = now();
        const all = [...agentDirs(c.getState())].sort((x, y) => y[1].lastActivity - x[1].lastActivity);
        const dirs = all.slice(0, GIT_LIMITS.maxDirs);
        const lookups = await Promise.all(dirs.map(async ([key, d]) => ({ key, d, r: await lookupRoot(key, d.cwd) })));
        const groups = new Map<string, { root: string; dirs: AgentDir[] }>();
        const unresolved: GitUnresolvedDir[] = [];
        let gitAvailable = true;
        for (const { d, r } of lookups) {
          if ('problem' in r) {
            if (r.problem.code === 'git_missing') gitAvailable = false;
            unresolved.push({ cwd: d.cwd, agentKeys: d.agents.map((a) => a.key), problem: r.problem });
            continue;
          }
          const rk = normalizePathKey(r.root);
          const g = groups.get(rk) ?? { root: r.root, dirs: [] };
          g.dirs.push(d);
          groups.set(rk, g);
        }
        const repos: GitRepoInfo[] = [...groups.values()]
          .map((g) => ({ root: g.root, name: baseName(g.root), ...summarizeAgents(g.dirs) }))
          .sort((x, y) => x.name.localeCompare(y.name) || x.root.localeCompare(y.root));
        return { checkedAt, gitAvailable, repos, unresolved, truncated: all.length > dirs.length };
      },

      /** Branch, changes, recent commits, diff totals and potential conflicts for an agent's cwd. */
      async status(params): Promise<GitStatusResult> {
        const c = requireCtx();
        const cwd = params.cwd;
        if (typeof cwd !== 'string' || !cwd.trim() || cwd.length > 1024) throw new Error('invalid params: cwd must be a non-empty string');
        const echo = truncate(cwd, 300);
        const state = c.getState();
        const dirs = agentDirs(state);
        const key = normalizePathKey(cwd);
        const dir = dirs.get(key);
        if (!dir) return { ok: false, cwd: echo, problem: { code: 'not_tracked', message: 'Not the working directory of an agent known to the monitor' }, checkedAt: now() };
        const r = await lookupRoot(key, dir.cwd);
        if ('problem' in r) return { ok: false, cwd: echo, problem: r.problem, checkedAt: now() };
        const raw = await readStatus(normalizePathKey(r.root), execDirOf(dir.cwd));
        if ('problem' in raw) return { ok: false, cwd: echo, problem: raw.problem, checkedAt: now() };
        const inRepo = dirsInRepo(dirs, r.root);
        const result: GitStatusResult = {
          ok: true,
          cwd: echo,
          root: r.root,
          name: baseName(r.root),
          branch: raw.branch,
          files: raw.files.slice(0, GIT_LIMITS.maxFiles),
          filesTruncated: raw.files.length > GIT_LIMITS.maxFiles,
          counts: countChanges(raw.files),
          commits: raw.commits,
          diff: raw.diff,
          conflicts: potentialConflicts(state, r.root, raw.files, [r.alias, ...inRepo.aliases]),
          checkedAt: raw.checkedAt,
          ...summarizeAgents(inRepo.dirs),
        };
        if (raw.commitsProblem) result.commitsProblem = raw.commitsProblem;
        return result;
      },
    },
  };
}
