// Read-only Git dashboard (data from the monitor's `git` plugin).
import { useContext, useEffect, useMemo, useState } from 'react';
import {
  displayName,
  normalizePathKey,
  type GitBranchInfo,
  type GitDiffTotals,
  type GitProblem,
  type GitRepoInfo,
  type GitReposResult,
  type GitStatusOk,
  type GitStatusResult,
  type OfficeState,
} from '@agent-office/core';
import { StatusPill } from '../components/common';
import { ago, StoreContext } from '../hooks';
import type { ViewProps } from './types';
import '../dashboard.css';

const REFRESH_MS = 20_000;
const FILES_SHOWN = 40;

export interface Loadable<T> {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  data?: T;
  error?: string;
}

/**
 * `git.status` for an agent's cwd. Re-queries when `refreshKey` changes and every `refreshMs`
 * (0 = no timer). Without a monitor connection it stays idle.
 */
export function useGitStatus(cwd: string | undefined, refreshKey: unknown = 0, refreshMs = 0): Loadable<GitStatusResult> & { available: boolean } {
  const store = useContext(StoreContext);
  const [tick, setTick] = useState(0);
  const [load, setLoad] = useState<Loadable<GitStatusResult>>({ phase: 'idle' });
  useEffect(() => {
    if (!store || !cwd) return;
    let cancelled = false;
    setLoad((l) => ({ phase: 'loading', data: l.data }));
    store.rpc<GitStatusResult>('git.status', { cwd }).then(
      (data) => {
        if (!cancelled) setLoad({ phase: 'ready', data });
      },
      (e: Error) => {
        if (!cancelled) setLoad((l) => ({ phase: 'error', data: l.data, error: e.message }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, cwd, refreshKey, tick]);
  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(() => {
      if (!document.hidden) setTick((n) => n + 1); // no git runs while the window is hidden
    }, refreshMs);
    return () => clearInterval(t);
  }, [refreshMs]);
  return { ...load, available: Boolean(store) };
}

const PROBLEM_TEXT: Record<GitProblem['code'], string> = {
  invalid_params: 'Invalid request',
  not_tracked: 'Not an agent working directory',
  missing_dir: 'Directory not found on this machine',
  not_a_repo: 'Not a git repository',
  git_missing: 'Git is not available on this machine',
  timeout: 'Git timed out',
  failed: 'Git could not read this repository',
};

export function problemText(p: GitProblem): string {
  const base = PROBLEM_TEXT[p.code];
  return p.message && p.message !== base ? `${base}: ${p.message}` : base;
}

export function BranchLine({ branch }: { branch: GitBranchInfo }) {
  return (
    <span className="dash-branch">
      <span className="dash-branch-name" title="Current branch">
        {branch.detached ? 'detached HEAD' : (branch.name ?? 'unknown')}
      </span>
      {branch.initial ? <span className="muted"> · no commits yet</span> : null}
      {branch.upstream ? (
        <span className="muted" title="Compared with the locally known upstream ref; the dashboard never fetches, so it may be out of date">
          {' '}
          → {branch.upstream}
          {branch.upstreamGone ? ' (gone)' : ` · ↑${branch.ahead ?? 0} ↓${branch.behind ?? 0}`}
        </span>
      ) : !branch.detached ? (
        <span className="muted"> · no upstream</span>
      ) : null}
    </span>
  );
}

function diffText(d: GitDiffTotals | null): string {
  if (!d) return 'Unavailable';
  if (!d.files) return 'none';
  return `+${d.insertions} −${d.deletions} in ${d.files} file${d.files === 1 ? '' : 's'}${d.binaryFiles ? ` (${d.binaryFiles} binary)` : ''}`;
}

export function changeSummary(s: GitStatusOk): string {
  const c = s.counts;
  if (!c.total) return 'Clean working tree';
  const parts: string[] = [];
  if (c.modified) parts.push(`${c.modified} modified`);
  if (c.added) parts.push(`${c.added} added`);
  if (c.deleted) parts.push(`${c.deleted} deleted`);
  if (c.renamed) parts.push(`${c.renamed} renamed`);
  if (c.untracked) parts.push(`${c.untracked} untracked`);
  if (c.unmerged) parts.push(`${c.unmerged} unmerged`);
  return parts.join(' · ');
}

function AgentChip({ state, agentKey, onSelect }: { state: OfficeState; agentKey: string; onSelect(key: string): void }) {
  const a = state.agents[agentKey];
  if (!a) return null;
  return (
    <button className="chip" onClick={() => onSelect(a.key)}>
      {displayName(a)} <StatusPill status={a.status} stale={a.stale} />
    </button>
  );
}

function Conflicts({ s, state, onSelect, limit }: { s: GitStatusOk; state: OfficeState; onSelect(key: string): void; limit?: number }) {
  if (!s.conflicts.length) return null;
  const shown = limit ? s.conflicts.slice(0, limit) : s.conflicts;
  return (
    <div className="dash-conflicts">
      <div className="card-title">
        Potential conflicts <span className="dash-heur" title="Heuristic: the same file was targeted by edit tool calls (Edit/Write/MultiEdit/NotebookEdit) from more than one session, within the retained tool history. This is not a git merge conflict.">heuristic</span>
      </div>
      <ul className="dash-mini-list">
        {shown.map((c) => (
          <li key={c.path}>
            <code>{c.path}</code>
            {c.uncommitted ? <span className="dash-tag warn">uncommitted</span> : null}
            <span className="muted small"> edited by {c.sessions.length} sessions: </span>
            <span className="chips">
              {c.sessions.map((x) => (
                <AgentChip key={x.sessionId} state={state} agentKey={x.agentKeys[0] ?? x.sessionId} onSelect={onSelect} />
              ))}
            </span>
          </li>
        ))}
      </ul>
      {limit && s.conflicts.length > limit ? <p className="muted small">{s.conflicts.length - limit} more in the Git tab</p> : null}
    </div>
  );
}

/** Compact repository summary used by the inspector. */
export function GitSummary({ load, state, now, onSelect }: { load: Loadable<GitStatusResult> & { available: boolean }; state: OfficeState; now: number; onSelect(key: string): void }) {
  if (!load.available) return <p className="muted small">Unavailable (not connected to the monitor).</p>;
  const s = load.data;
  if (!s) {
    if (load.phase === 'error') return <p className="muted small">Unavailable: {load.error}</p>;
    return <p className="muted small">Checking…</p>;
  }
  if (!s.ok) return <p className="muted small">{problemText(s.problem)}</p>;
  const last = s.commits[0];
  return (
    <div className="dash-git-compact">
      <dl className="facts">
        <dt>Repository</dt>
        <dd title={s.root}>{s.name}</dd>
        <dt>Branch</dt>
        <dd>
          <BranchLine branch={s.branch} />
        </dd>
        <dt>Changes</dt>
        <dd>{changeSummary(s)}</dd>
        <dt>Diff</dt>
        <dd>
          unstaged {diffText(s.diff.unstaged)} · staged {diffText(s.diff.staged)}
        </dd>
        <dt>Last commit</dt>
        <dd>
          {last ? (
            <>
              <code>{last.hash}</code> {last.subject} <span className="muted">({ago(Date.parse(last.date), now)})</span>
            </>
          ) : s.commitsProblem ? (
            `Unavailable: ${problemText(s.commitsProblem)}`
          ) : (
            'No commits yet'
          )}
        </dd>
      </dl>
      <Conflicts s={s} state={state} onSelect={onSelect} limit={3} />
      <p className="muted tiny">
        Checked {ago(s.checkedAt, now)} · local read-only git (no fetch){load.phase === 'error' ? ` · refresh failed: ${load.error}` : ''}
      </p>
    </div>
  );
}

function RepoCard({ repo, state, now, refreshKey, onSelect }: { repo: GitRepoInfo; state: OfficeState; now: number; refreshKey: unknown; onSelect(key: string): void }) {
  const load = useGitStatus(repo.cwds[0], refreshKey);
  const [allFiles, setAllFiles] = useState(false);
  const s = load.data;
  const sessions = repo.sessionIds.map((id) => state.agents[id]).filter((a) => a !== undefined);
  const others = repo.agentKeys.filter((k) => state.agents[k]?.kind !== 'session');
  return (
    <article className="card dash-repo" aria-label={`Repository ${repo.name}`}>
      <header className="dash-repo-head">
        <h3>{repo.name}</h3>
        <code className="muted small" title={repo.root}>
          {repo.root}
        </code>
        {s?.ok ? <BranchLine branch={s.branch} /> : null}
      </header>
      <div className="dash-row">
        <span className="muted small">Sessions</span>
        <span className="chips">
          {sessions.length ? sessions.map((a) => <AgentChip key={a.key} state={state} agentKey={a.key} onSelect={onSelect} />) : <span className="muted small">Not reported</span>}
        </span>
      </div>
      {others.length ? (
        <div className="dash-row">
          <span className="muted small">Subagents</span>
          <span className="chips">
            {others.map((k) => (
              <AgentChip key={k} state={state} agentKey={k} onSelect={onSelect} />
            ))}
          </span>
        </div>
      ) : null}
      {!s ? (
        <p className="muted small">{load.phase === 'error' ? `Unavailable: ${load.error}` : 'Checking…'}</p>
      ) : !s.ok ? (
        <p className="muted small">{problemText(s.problem)}</p>
      ) : (
        <>
          <dl className="facts">
            <dt>Changes</dt>
            <dd>{changeSummary(s)}</dd>
            <dt>Unstaged</dt>
            <dd>{diffText(s.diff.unstaged)}</dd>
            <dt>Staged</dt>
            <dd>{diffText(s.diff.staged)}</dd>
          </dl>
          {s.files.length ? (
            <details className="dash-files">
              <summary>
                Changed files ({s.counts.total}
                {s.filesTruncated ? `, first ${s.files.length} listed` : ''})
              </summary>
              <ul className="dash-mini-list">
                {(allFiles ? s.files : s.files.slice(0, FILES_SHOWN)).map((f) => (
                  <li key={`${f.code}:${f.path}`}>
                    <code className="dash-code" title={`${f.kind}${f.staged ? ', staged' : ''}${f.unstaged ? ', unstaged' : ''}`}>
                      {f.code.replace(/ /g, '·')}
                    </code>{' '}
                    {f.origPath ? (
                      <>
                        <span className="muted">{f.origPath} → </span>
                      </>
                    ) : null}
                    {f.path}
                  </li>
                ))}
              </ul>
              {!allFiles && s.files.length > FILES_SHOWN ? (
                <button className="btn small" onClick={() => setAllFiles(true)}>
                  Show {s.files.length - FILES_SHOWN} more
                </button>
              ) : null}
            </details>
          ) : null}
          <Conflicts s={s} state={state} onSelect={onSelect} />
          <div className="card-title dash-gap">Recent commits</div>
          {s.commits.length ? (
            <ol className="dash-mini-list dash-commits">
              {s.commits.map((c) => (
                <li key={c.hash}>
                  <code>{c.hash}</code> <span>{c.subject}</span>{' '}
                  <span className="muted small" title={c.date}>
                    {ago(Date.parse(c.date), now)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">{s.commitsProblem ? `Unavailable: ${problemText(s.commitsProblem)}` : s.branch.initial ? 'No commits yet' : 'None reported'}</p>
          )}
          <p className="muted tiny">Checked {ago(s.checkedAt, now)}</p>
        </>
      )}
    </article>
  );
}

export function GitView({ snap, now, onSelectAgent }: ViewProps) {
  const store = useContext(StoreContext);
  const connected = snap.connection === 'open';
  const cwdSignature = useMemo(
    () =>
      [...new Set(Object.values(snap.state.agents).flatMap((a) => (a.cwd ? [normalizePathKey(a.cwd)] : [])))]
        .sort()
        .join('\n'),
    [snap.state.agents],
  );
  const [tick, setTick] = useState(0);
  const [repos, setRepos] = useState<Loadable<GitReposResult>>({ phase: 'idle' });

  useEffect(() => {
    if (!store || !connected) return;
    let cancelled = false;
    setRepos((r) => ({ phase: 'loading', data: r.data }));
    store.rpc<GitReposResult>('git.repos', {}).then(
      (data) => {
        if (!cancelled) setRepos({ phase: 'ready', data });
      },
      (e: Error) => {
        if (!cancelled) setRepos((r) => ({ phase: 'error', data: r.data, error: e.message }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, connected, cwdSignature, tick]);

  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) setTick((n) => n + 1);
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const data = repos.data;
  return (
    <section className="page dash-git" aria-label="Git">
      <div className="dash-page-head">
        <h2>Git</h2>
        <button className="btn small" onClick={() => setTick((n) => n + 1)} disabled={!store || !connected}>
          Refresh
        </button>
      </div>
      <p className="muted small">
        Local, read-only git (<code>status</code>, <code>log</code>, <code>diff --numstat</code>) for the directories where agents run. Nothing is fetched, pulled or
        pushed, so ahead/behind is relative to the last fetched upstream. File contents and author emails are never shown.
      </p>
      {!store || !connected ? (
        <p className="muted">Unavailable: not connected to the monitor.</p>
      ) : !data ? (
        <p className="muted">{repos.phase === 'error' ? `Unavailable: ${repos.error}` : 'Checking repositories…'}</p>
      ) : (
        <>
          {repos.phase === 'error' ? <p className="warn-text small">Refresh failed: {repos.error}</p> : null}
          {!data.gitAvailable ? <p className="warn-text">Git is not available on this machine (the git executable could not be started).</p> : null}
          {data.repos.length === 0 && data.unresolved.length === 0 ? <p className="muted">No agent working directories reported yet.</p> : null}
          <div className="dash-repos">
            {data.repos.map((r) => (
              <RepoCard key={r.root} repo={r} state={snap.state} now={now} refreshKey={tick} onSelect={onSelectAgent} />
            ))}
          </div>
          {data.unresolved.length ? (
            <>
              <h3>Other working directories</h3>
              <ul className="dash-mini-list">
                {data.unresolved.map((u) => (
                  <li key={u.cwd}>
                    <code>{u.cwd}</code> <span className="muted small">· {problemText(u.problem)}</span>{' '}
                    <span className="chips">
                      {u.agentKeys
                        .filter((k) => snap.state.agents[k]?.kind === 'session')
                        .map((k) => (
                          <AgentChip key={k} state={snap.state} agentKey={k} onSelect={onSelectAgent} />
                        ))}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {data.truncated ? <p className="muted small">Only the most recently active directories are checked.</p> : null}
        </>
      )}
    </section>
  );
}
