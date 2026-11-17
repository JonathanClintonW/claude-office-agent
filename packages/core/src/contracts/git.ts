/**
 * Read-only local Git status contracts.
 *
 * Served by the monitor's `git` plugin as the RPC methods `git.repos` and `git.status`.
 * The plugin runs only local, read-only git commands (`rev-parse`, `status`, `log`,
 * `diff --numstat`) and only in directories that are the working directory of an agent
 * present in the monitor state. It never contacts a remote (no fetch/pull/push), so
 * ahead/behind counts are relative to the last *locally known* upstream ref.
 *
 * Privacy: no file contents, no diffs, no author names or emails. Commit subjects are
 * secret-redacted and truncated.
 */

/** Why git information is unavailable for a directory. */
export type GitProblemCode =
  /** Params missing or malformed. */
  | 'invalid_params'
  /** The directory is not the cwd of an agent in the monitor state (no arbitrary probing). */
  | 'not_tracked'
  /** The agent's directory does not exist (any more) on this machine. */
  | 'missing_dir'
  /** The directory is not inside a git work tree. */
  | 'not_a_repo'
  /** The `git` executable could not be started. */
  | 'git_missing'
  /** A git command exceeded its time budget. */
  | 'timeout'
  /** Any other git failure (e.g. `safe.directory` ownership refusal, output cap). */
  | 'failed';

export interface GitProblem {
  code: GitProblemCode;
  /** Short, human-readable reason (sanitized). */
  message: string;
}

export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'type_changed' | 'untracked' | 'unmerged';

export interface GitFileChange {
  /** Path relative to the repository root, as reported by `git status --porcelain`. */
  path: string;
  /** Source path of a rename or copy. */
  origPath?: string;
  kind: GitChangeKind;
  /** Change recorded in the index. */
  staged: boolean;
  /** Change in the working tree not yet staged. */
  unstaged: boolean;
  /** Raw two-letter porcelain code, e.g. ` M`, `A `, `??`, `UU`. */
  code: string;
}

export interface GitChangeCounts {
  /** Modified or type-changed paths. */
  modified: number;
  added: number;
  deleted: number;
  /** Renamed or copied paths. */
  renamed: number;
  untracked: number;
  unmerged: number;
  total: number;
}

export interface GitCommitInfo {
  /** Abbreviated hash. */
  hash: string;
  /** Subject line, secret-redacted and truncated. */
  subject: string;
  /** Author date, strict ISO 8601. */
  date: string;
}

/** Totals from `git diff --numstat` (line counts only; never file contents). */
export interface GitDiffTotals {
  files: number;
  insertions: number;
  deletions: number;
  /** Binary files have no line counts. */
  binaryFiles: number;
}

export interface GitBranchInfo {
  /** Current branch, or null with a detached HEAD. */
  name: string | null;
  detached: boolean;
  /** The repository has no commits yet. */
  initial: boolean;
  /** Configured upstream such as `origin/main`, when any. */
  upstream?: string;
  /** Commits ahead of / behind the locally known upstream ref (no fetch is performed). */
  ahead?: number;
  behind?: number;
  /** The upstream branch is configured but no longer exists locally. */
  upstreamGone?: boolean;
}

/** One session involved in a potential conflict. */
export interface GitConflictSession {
  sessionId: string;
  /** Agents of this session whose edit tool calls targeted the file. */
  agentKeys: string[];
  /** Latest observed edit (tool start/end) in this session. */
  lastAt?: number;
  toolNames: string[];
}

/**
 * Heuristic: a file that edit tool calls (Edit/Write/MultiEdit/NotebookEdit) from more than one
 * session targeted, within the retained tool history. It does not mean git has a merge conflict.
 */
export interface GitPotentialConflict {
  /** Path relative to the repository root. */
  path: string;
  sessions: GitConflictSession[];
  /** Git currently reports uncommitted changes for this path. */
  uncommitted: boolean;
}

/** Agents (from the monitor state) whose cwd lies in a repository. */
export interface GitRepoAgents {
  agentKeys: string[];
  sessionIds: string[];
  /** Distinct agent working directories inside the repository, as reported by Claude Code. */
  cwds: string[];
}

export interface GitRepoInfo extends GitRepoAgents {
  /** Repository root (`git rev-parse --show-toplevel`). */
  root: string;
  /** Root folder name. */
  name: string;
}

export interface GitUnresolvedDir {
  cwd: string;
  agentKeys: string[];
  problem: GitProblem;
}

/** Result of `git.repos`. */
export interface GitReposResult {
  checkedAt: number;
  /** False only when git could not be started at all. */
  gitAvailable: boolean;
  repos: GitRepoInfo[];
  /** Agent directories that are not git work trees or could not be checked. */
  unresolved: GitUnresolvedDir[];
  /** More distinct agent directories existed than the plugin checks at once. */
  truncated: boolean;
}

export interface GitStatusOk extends GitRepoAgents {
  ok: true;
  /** The cwd the request named. */
  cwd: string;
  root: string;
  name: string;
  branch: GitBranchInfo;
  /** Changed paths, capped at GIT_LIMITS.maxFiles (counts cover all of them). */
  files: GitFileChange[];
  filesTruncated: boolean;
  counts: GitChangeCounts;
  /** Latest commits on HEAD (at most GIT_LIMITS.maxCommits). Empty when there are none. */
  commits: GitCommitInfo[];
  /** Set when `git log` failed: commits are then unavailable rather than empty. */
  commitsProblem?: GitProblem;
  /** Line totals; null when that `git diff --numstat` call failed (unavailable, not zero). */
  diff: { unstaged: GitDiffTotals | null; staged: GitDiffTotals | null };
  /** Heuristic, see GitPotentialConflict. */
  conflicts: GitPotentialConflict[];
  /** When git was last queried for this repository (answers are cached briefly). */
  checkedAt: number;
}

export interface GitStatusFailed {
  ok: false;
  cwd: string;
  problem: GitProblem;
  checkedAt: number;
}

/** Result of `git.status({ cwd })`. */
export type GitStatusResult = GitStatusOk | GitStatusFailed;

/** Parameters of `git.status`. `cwd` must equal the cwd of an agent in the monitor state. */
export interface GitStatusParams {
  cwd: string;
}

export const GIT_LIMITS = {
  /** Answers are reused for this long. */
  cacheMs: 5_000,
  /** Repository-root lookups are reused for this long. */
  rootCacheMs: 30_000,
  /** Per git command. */
  commandTimeoutMs: 5_000,
  /** stdout cap per git command. */
  maxBufferBytes: 2 * 1024 * 1024,
  maxFiles: 200,
  maxCommits: 10,
  /** Distinct agent directories checked by `git.repos`. */
  maxDirs: 40,
  maxConflicts: 50,
  /** Concurrent git processes. */
  concurrency: 3,
} as const;

/** Tools whose target is a file they write. Used for the potential-conflict heuristic. */
export const GIT_EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
