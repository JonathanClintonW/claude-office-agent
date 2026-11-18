import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInitialState,
  normalizeHookPayload,
  normalizePathKey,
  reduce,
  type GitReposResult,
  type GitStatusOk,
  type GitStatusResult,
  type OfficeState,
} from '@agent-office/core';
import { loadOrCreateConfig } from '../src/config';
import { gitPlugin, parseBranchHeader, parseLog, parseNumstat, parseStatusZ, potentialConflicts, repoRootAlias } from '../src/plugins/git';
import { createMonitor, type Monitor } from '../src/server';
import { freePort, tempDir } from './helpers';

// Record every child process the plugin starts (calls pass through to the real implementation).
const calls = vi.hoisted(() => [] as Array<{ file: unknown; args: unknown; opts: unknown }>);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (...a: unknown[]) => {
    calls.push({ file: a[0], args: a[1], opts: a[2] });
    return (actual.execFile as unknown as (...x: unknown[]) => unknown)(...a);
  };
  return { ...actual, execFile };
});

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const GIT = hasGit();

/** The machine's temp dir is normally outside any repository; skip such assertions if it is not. */
function insideSomeRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test Author', '-c', 'user.email=secret.author@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function stateFrom(events: Array<[string, number, Record<string, unknown>, string, string]>): OfficeState {
  let s = createInitialState();
  let seq = 0;
  for (const [name, ts, extra, sid, cwd] of events) {
    const r = normalizeHookPayload({ session_id: sid, cwd, hook_event_name: name, ...extra }, ts);
    if (!r.ok) throw new Error(r.error);
    s = reduce(s, { ...r.event, seq: ++seq });
  }
  return s;
}

describe('git parsers (pure)', () => {
  it('parses branch headers: upstream, ahead/behind, gone, detached and unborn', () => {
    expect(parseBranchHeader('## main')).toEqual({ name: 'main', detached: false, initial: false });
    expect(parseBranchHeader('## main...origin/main')).toEqual({ name: 'main', detached: false, initial: false, upstream: 'origin/main', ahead: 0, behind: 0 });
    expect(parseBranchHeader('## feat/x...origin/feat/x [ahead 2, behind 13]')).toMatchObject({ name: 'feat/x', upstream: 'origin/feat/x', ahead: 2, behind: 13 });
    expect(parseBranchHeader('## dev...origin/dev [behind 1]')).toMatchObject({ ahead: 0, behind: 1 });
    expect(parseBranchHeader('## dev...origin/dev [gone]')).toEqual({ name: 'dev', detached: false, initial: false, upstream: 'origin/dev', upstreamGone: true });
    expect(parseBranchHeader('## HEAD (no branch)')).toEqual({ name: null, detached: true, initial: false });
    expect(parseBranchHeader('## No commits yet on main')).toEqual({ name: 'main', detached: false, initial: true });
    expect(parseBranchHeader('## Initial commit on master')).toEqual({ name: 'master', detached: false, initial: true });
  });

  it('parses NUL-separated porcelain status including renames, untracked and unmerged paths', () => {
    const out = '## main...origin/main [ahead 1]\0 M src/a.ts\0R  new name.ts\0old name.ts\0A  added.ts\0 D gone.ts\0UU both.ts\0?? tmp/\0';
    const { branch, files } = parseStatusZ(out);
    expect(branch).toMatchObject({ name: 'main', ahead: 1, behind: 0 });
    expect(files).toEqual([
      { path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true, code: ' M' },
      { path: 'new name.ts', origPath: 'old name.ts', kind: 'renamed', staged: true, unstaged: false, code: 'R ' },
      { path: 'added.ts', kind: 'added', staged: true, unstaged: false, code: 'A ' },
      { path: 'gone.ts', kind: 'deleted', staged: false, unstaged: true, code: ' D' },
      { path: 'both.ts', kind: 'unmerged', staged: true, unstaged: true, code: 'UU' },
      { path: 'tmp/', kind: 'untracked', staged: false, unstaged: true, code: '??' },
    ]);
  });

  it('totals numstat output without reading paths or contents; counts binary files separately', () => {
    expect(parseNumstat('3\t1\ta.ts\n-\t-\timg.png\n10\t0\tdir/{x => y}.ts\n')).toEqual({ files: 3, insertions: 13, deletions: 1, binaryFiles: 1 });
    expect(parseNumstat('')).toEqual({ files: 0, insertions: 0, deletions: 0, binaryFiles: 0 });
  });

  it('parses commits (hash, ISO date, redacted subject) and drops malformed records', () => {
    const log = 'abc1234\x1f2026-11-17T10:00:00+01:00\x1fFix login with token=supersecretvalue123\x1e\ngarbage\x1e\nfff0000\x1fnot-a-date\x1fX\x1e\n';
    const commits = parseLog(log);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({ hash: 'abc1234', date: '2026-11-17T10:00:00+01:00', subject: 'Fix login with token=[REDACTED]' });
  });

  it('derives the root as spelled by the agent cwd from the rev-parse prefix', () => {
    expect(repoRootAlias('c:\\work\\app\\packages\\ui', 'packages/ui/')).toBe('c:\\work\\app');
    expect(repoRootAlias('/home/u/app', '')).toBe('/home/u/app');
    expect(repoRootAlias('/home/u/app/src', 'src/')).toBe('/home/u/app');
  });

  it('flags files edited from more than one session (heuristic), ignoring failed/denied edits and other repos', () => {
    const T = 1_700_000_000_000;
    const repo = 'c:\\work\\app';
    const state = stateFrom([
      ['PreToolUse', T, { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'c:\\work\\app\\src\\a.ts' } }, 's1', repo],
      ['PostToolUse', T + 10, { tool_name: 'Edit', tool_use_id: 'e1', tool_input: {} }, 's1', repo],
      ['PreToolUse', T + 20, { tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: 'C:/Work/App/src/a.ts' } }, 's2', 'c:\\work\\app\\src'],
      ['PostToolUse', T + 30, { tool_name: 'Write', tool_use_id: 'w1', tool_input: {} }, 's2', 'c:\\work\\app\\src'],
      // relative target resolved against the agent cwd
      ['PreToolUse', T + 40, { tool_name: 'Edit', tool_use_id: 'e2', tool_input: { file_path: 'b.ts' } }, 's2', 'c:\\work\\app\\src'],
      ['PreToolUse', T + 50, { tool_name: 'Edit', tool_use_id: 'e3', tool_input: { file_path: 'c:\\work\\app\\src\\b.ts' } }, 's3', repo],
      // failed edit from a third session on a.ts and a read are ignored
      ['PreToolUse', T + 60, { tool_name: 'Edit', tool_use_id: 'e4', tool_input: { file_path: 'c:\\work\\app\\src\\only.ts' } }, 's1', repo],
      ['PreToolUse', T + 70, { tool_name: 'Edit', tool_use_id: 'e5', tool_input: { file_path: 'c:\\work\\app\\src\\only.ts' } }, 's4', repo],
      ['PostToolUseFailure', T + 80, { tool_name: 'Edit', tool_use_id: 'e5', tool_input: {}, error: 'old_string not found' }, 's4', repo],
      ['PreToolUse', T + 90, { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'c:\\work\\app\\src\\only.ts' } }, 's5', repo],
      // another repository
      ['PreToolUse', T + 100, { tool_name: 'Edit', tool_use_id: 'x1', tool_input: { file_path: 'c:\\other\\src\\a.ts' } }, 's5', repo],
      ['PreToolUse', T + 110, { tool_name: 'Edit', tool_use_id: 'x2', tool_input: { file_path: 'c:\\other\\src\\a.ts' } }, 's1', repo],
    ]);
    const conflicts = potentialConflicts(state, 'C:/work/app', [{ path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true, code: ' M' }]);
    expect(conflicts.map((c) => c.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    const a = conflicts.find((c) => c.path === 'src/a.ts')!;
    expect(a.uncommitted).toBe(true);
    expect(a.sessions.map((s) => s.sessionId)).toEqual(['s2', 's1']);
    expect(a.sessions[0]).toMatchObject({ toolNames: ['Write'], lastAt: T + 30 });
    expect(conflicts.find((c) => c.path === 'src/b.ts')!.uncommitted).toBe(false);
    // an alias spelling of the root (e.g. 8.3 short name) still matches
    expect(potentialConflicts(state, 'C:/Long/Name/app', [], ['c:\\work\\app']).map((c) => c.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe.skipIf(!GIT)('git plugin routes (temporary repository)', () => {
  let home: ReturnType<typeof tempDir>;
  let base: string;
  let repo: string;
  let plain: string;
  let monitor: Monitor;
  let clock: number;

  beforeAll(() => {
    home = tempDir('git');
    // realpath: on Windows the temp dir may be an 8.3 short path while git reports long names.
    base = realpathSync.native(home.path);
    repo = join(base, 'repo');
    plain = join(base, 'plain');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(plain);
    git(repo, 'init', '-q');
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'old.txt'), 'old\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
    git(repo, 'add', '.');
    // Fake key assembled at runtime so no secret-shaped literal is in the source (not a real key).
    git(repo, 'commit', '-q', '-m', `Add b with api_key=${['sk', 'ant', 'abcdefghijklmnopqrstu'].join('-')}`);
    // Local upstream (no remote, no network): main is one commit ahead of `base`.
    git(repo, 'branch', 'base', 'HEAD~1');
    git(repo, 'branch', '-q', '--set-upstream-to=base');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\nexport const c = 3;\nexport const d = 4;\n');
    git(repo, 'mv', 'old.txt', 'renamed.txt');
    writeFileSync(join(repo, 'staged.ts'), 'x\n');
    git(repo, 'add', 'staged.ts');
    writeFileSync(join(repo, 'untracked.md'), 'u\n');
  });
  afterAll(() => home.cleanup());

  beforeEach(async () => {
    calls.length = 0;
    clock = Date.now();
    const port = await freePort();
    const token = loadOrCreateConfig(join(base, 'home'), { port }).token;
    monitor = createMonitor({
      home: join(base, 'home'),
      port,
      token,
      claudeDirs: [join(base, 'home')],
      discovery: false,
      persist: false,
      plugins: [gitPlugin()],
      tickIntervalMs: 3_600_000,
      now: () => clock,
    });
    await monitor.start();
    const ingest = (sid: string, cwd: string, name: string, extra: Record<string, unknown> = {}) =>
      monitor.ingestHook({ session_id: sid, cwd, hook_event_name: name, ...extra }, clock);
    ingest('s1', repo, 'SessionStart');
    ingest('s2', join(repo, 'src'), 'SessionStart');
    ingest('s3', plain, 'SessionStart');
    ingest('s4', join(base, 'deleted-dir'), 'SessionStart');
    // Both sessions edit src/a.ts: a potential conflict.
    ingest('s1', repo, 'PreToolUse', { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: join(repo, 'src', 'a.ts') } });
    ingest('s1', repo, 'PostToolUse', { tool_name: 'Edit', tool_use_id: 'e1', tool_input: {} });
    ingest('s2', join(repo, 'src'), 'PreToolUse', { tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: join(repo, 'src', 'a.ts') } });
  });
  afterEach(async () => {
    await monitor.stop();
  });

  it('lists repositories derived from agent working directories', async () => {
    const r = (await monitor.rpc('git.repos')) as GitReposResult;
    expect(r.gitAvailable).toBe(true);
    expect(r.repos).toHaveLength(1);
    const info = r.repos[0]!;
    expect(normalizePathKey(info.root)).toBe(normalizePathKey(repo));
    expect(info.name).toBe('repo');
    expect(info.sessionIds.sort()).toEqual(['s1', 's2']);
    expect(info.cwds).toHaveLength(2);
    const codes = Object.fromEntries(r.unresolved.map((u) => [normalizePathKey(u.cwd), u.problem.code]));
    expect(codes[normalizePathKey(join(base, 'deleted-dir'))]).toBe('missing_dir');
    if (!insideSomeRepo(plain)) expect(codes[normalizePathKey(plain)]).toBe('not_a_repo');
  });

  it('reports branch, upstream, changes, commits, diff totals and potential conflicts without emails or contents', async () => {
    const r = (await monitor.rpc('git.status', { cwd: join(repo, 'src') })) as GitStatusResult;
    expect(r.ok).toBe(true);
    const s = r as GitStatusOk;
    expect(normalizePathKey(s.root)).toBe(normalizePathKey(repo));
    expect(s.branch).toMatchObject({ name: 'main', detached: false, initial: false, upstream: 'base', ahead: 1, behind: 0 });
    expect(s.counts).toMatchObject({ modified: 1, added: 1, renamed: 1, untracked: 1, total: 4 });
    expect(s.files.find((f) => f.kind === 'renamed')).toMatchObject({ path: 'renamed.txt', origPath: 'old.txt', staged: true });
    expect(s.files.find((f) => f.path === 'untracked.md')).toMatchObject({ kind: 'untracked', code: '??' });
    expect(s.commits.map((c) => c.subject)).toEqual(['Add b with api_key=[REDACTED]', 'Initial commit']);
    expect(s.commits[0]!.hash).toMatch(/^[0-9a-f]{4,40}$/);
    expect(Number.isFinite(Date.parse(s.commits[0]!.date))).toBe(true);
    expect(s.diff.unstaged).toEqual({ files: 1, insertions: 2, deletions: 0, binaryFiles: 0 });
    expect(s.diff.staged).toMatchObject({ files: 2 });
    expect(s.conflicts).toHaveLength(1);
    expect(s.conflicts[0]).toMatchObject({ path: 'src/a.ts', uncommitted: true });
    expect(s.conflicts[0]!.sessions.map((x) => x.sessionId).sort()).toEqual(['s1', 's2']);
    expect(s.sessionIds.sort()).toEqual(['s1', 's2']);
    const json = JSON.stringify(s);
    expect(json).not.toContain('secret.author@example.invalid');
    expect(json).not.toContain('Test Author');
    expect(json).not.toContain('export const');
  });

  it('runs only read-only git commands via execFile with a time budget, output cap and no shell', async () => {
    await monitor.rpc('git.repos');
    await monitor.rpc('git.status', { cwd: repo });
    expect(calls.length).toBeGreaterThan(0);
    const allowed = new Set(['rev-parse', 'status', 'log', 'diff']);
    for (const c of calls) {
      expect(c.file).toBe('git');
      const args = c.args as string[];
      expect(args[0]).toBe('--no-optional-locks');
      const verb = args.find((a, i) => i > 0 && !a.startsWith('-') && args[i - 1] !== '-c');
      expect(allowed.has(verb!)).toBe(true);
      expect(args.some((a) => /^(fetch|pull|push|remote|ls-remote|clone|submodule)$/.test(a))).toBe(false);
      const opts = c.opts as Record<string, unknown>;
      expect(opts).toMatchObject({ windowsHide: true });
      expect(opts.timeout).toBeGreaterThan(0);
      expect(opts.maxBuffer).toBeGreaterThan(0);
      expect(opts.shell).toBeUndefined();
    }
  });

  it('only inspects directories that are agent working directories; validates params', async () => {
    await expect(monitor.rpc('git.status', {})).rejects.toThrow(/invalid params/);
    await expect(monitor.rpc('git.status', { cwd: 42 })).rejects.toThrow(/invalid params/);
    await expect(monitor.rpc('git.status', { cwd: 'x'.repeat(2000) })).rejects.toThrow(/invalid params/);
    calls.length = 0;
    const r = (await monitor.rpc('git.status', { cwd: base })) as GitStatusResult;
    expect(r).toMatchObject({ ok: false, problem: { code: 'not_tracked' } });
    expect(calls).toHaveLength(0);
    const gone = (await monitor.rpc('git.status', { cwd: join(base, 'deleted-dir') })) as GitStatusResult;
    expect(gone).toMatchObject({ ok: false, problem: { code: 'missing_dir' } });
    expect(calls).toHaveLength(0);
  });

  it('caches answers briefly, then re-reads', async () => {
    const first = (await monitor.rpc('git.status', { cwd: repo })) as GitStatusOk;
    const n = calls.length;
    writeFileSync(join(repo, 'later.txt'), 'later\n');
    try {
      const second = (await monitor.rpc('git.status', { cwd: repo })) as GitStatusOk;
      expect(calls.length).toBe(n);
      expect(second.checkedAt).toBe(first.checkedAt);
      expect(second.files.some((f) => f.path === 'later.txt')).toBe(false);
      clock += 6_000;
      const third = (await monitor.rpc('git.status', { cwd: repo })) as GitStatusOk;
      expect(third.checkedAt).toBe(clock);
      expect(third.files.some((f) => f.path === 'later.txt')).toBe(true);
    } finally {
      renameSync(join(repo, 'later.txt'), join(base, 'later.txt'));
    }
  });

  it('degrades gracefully when the directory is not a repository or git cannot be started', async () => {
    if (!insideSomeRepo(plain)) {
      const r = (await monitor.rpc('git.status', { cwd: plain })) as GitStatusResult;
      expect(r).toMatchObject({ ok: false, problem: { code: 'not_a_repo', message: 'Not a git repository' } });
    }
    const saved = process.env.PATH;
    try {
      process.env.PATH = '';
      const fresh = join(base, 'fresh');
      mkdirSync(fresh, { recursive: true });
      monitor.ingestHook({ session_id: 's9', cwd: fresh, hook_event_name: 'SessionStart' }, clock);
      const m = (await monitor.rpc('git.status', { cwd: fresh })) as GitStatusResult;
      expect(m).toMatchObject({ ok: false, problem: { code: 'git_missing' } });
      const repos = (await monitor.rpc('git.repos')) as GitReposResult;
      expect(repos.unresolved.find((u) => normalizePathKey(u.cwd) === normalizePathKey(fresh))?.problem.code).toBe('git_missing');
      expect(repos.gitAvailable).toBe(false);
    } finally {
      process.env.PATH = saved;
    }
  });
});
