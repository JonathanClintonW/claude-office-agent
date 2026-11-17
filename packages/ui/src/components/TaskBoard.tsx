import { useMemo, useState } from 'react';
import { baseName, displayName, formatDuration, normalizePathKey, type Agent, type OfficeState, type Task } from '@agent-office/core';
import { ago, clock } from '../hooks';
import '../dashboard.css';

interface Props {
  state: OfficeState;
  sessionKeys: Set<string>;
  now: number;
  onSelect(key: string): void;
  onClose(): void;
  /** Render as a page (Tasks view) instead of a modal. */
  inline?: boolean;
}

type ColumnId = 'open' | 'completed' | 'orphaned';
type Column = { id: ColumnId; title: string; hint: string };
const COLUMNS: Column[] = [
  { id: 'open', title: 'Open', hint: 'TaskCreated received, no TaskCompleted yet' },
  { id: 'completed', title: 'Completed', hint: 'TaskCompleted received' },
  { id: 'orphaned', title: 'Open when session ended', hint: 'The session ended before a completion was reported; the outcome is unknown' },
];

export function columnOf(t: Task): ColumnId {
  if (t.status === 'completed') return 'completed';
  return t.orphaned ? 'orphaned' : 'open';
}

/** The agent responsible for a task: the named teammate in its session, else the creator. */
export function taskOwner(state: OfficeState, t: Task): Agent | undefined {
  if (t.teammateName) {
    const mate = Object.values(state.agents).find((a) => a.sessionId === t.sessionId && a.teammateName === t.teammateName);
    if (mate) return mate;
  }
  const key = t.status === 'completed' ? (t.completedBy ?? t.createdBy) : t.createdBy;
  return key ? state.agents[key] : undefined;
}

export type TaskSubState = 'running' | 'waiting' | 'blocked';

const SUB_STATE: Record<TaskSubState, { label: string; why: string }> = {
  running: { label: 'Running', why: 'the owning agent is working' },
  waiting: { label: 'Waiting', why: 'the owning agent is waiting for your input' },
  blocked: { label: 'Blocked', why: 'the owning agent is waiting for a permission decision' },
};

/**
 * Heuristic sub-state of an open task, from the owning agent's real status. Claude Code does not
 * report task progress, so this only says what the owner is doing right now.
 */
export function taskSubState(state: OfficeState, t: Task): TaskSubState | undefined {
  if (columnOf(t) !== 'open') return undefined;
  const owner = taskOwner(state, t);
  switch (owner?.status) {
    case 'working':
      return 'running';
    case 'waiting_input':
      return 'waiting';
    case 'waiting_permission':
      return 'blocked';
    default:
      return undefined;
  }
}

function projectCwd(state: OfficeState, t: Task): string | undefined {
  const owner = taskOwner(state, t);
  return state.agents[t.sessionId]?.cwd ?? owner?.cwd;
}

function sessionLabel(state: OfficeState, sessionId: string): string {
  const s = state.agents[sessionId];
  return s ? displayName(s) : sessionId;
}

export function TaskBoard({ state, sessionKeys, now, onSelect, onClose, inline }: Props) {
  const [session, setSession] = useState('all');
  const [project, setProject] = useState('all');
  const visible = useMemo(() => Object.values(state.tasks).filter((t) => sessionKeys.has(t.sessionId) || !state.agents[t.sessionId]), [state, sessionKeys]);
  const tasks = useMemo(
    () =>
      visible
        .filter((t) => session === 'all' || t.sessionId === session)
        .filter((t) => {
          if (project === 'all') return true;
          const cwd = projectCwd(state, t);
          return cwd !== undefined && normalizePathKey(cwd) === project;
        })
        .sort((a, b) => (b.completedAt ?? b.createdAt ?? 0) - (a.completedAt ?? a.createdAt ?? 0)),
    [state, visible, session, project],
  );
  const sessions = [...new Set(visible.map((t) => t.sessionId))];
  const projects = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of visible) {
      const cwd = projectCwd(state, t);
      if (cwd) m.set(normalizePathKey(cwd), baseName(cwd));
    }
    return [...m].sort((x, y) => x[1].localeCompare(y[1]));
  }, [state, visible]);

  return (
    <Frame inline={inline} onClose={onClose}>
      <section className={inline ? 'page taskboard' : 'modal taskboard'} role={inline ? undefined : 'dialog'} aria-label="Task board" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Task board</h2>
          <label className="ctl">
            <span>Session</span>
            <select value={session} onChange={(e) => setSession(e.target.value)} aria-label="Filter by session">
              <option value="all">All sessions</option>
              {sessions.map((s) => (
                <option key={s} value={s}>
                  {sessionLabel(state, s)}
                </option>
              ))}
            </select>
          </label>
          <label className="ctl">
            <span>Project</span>
            <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Filter by project">
              <option value="all">All projects</option>
              {projects.map(([k, label]) => (
                <option key={k} value={k} title={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button className="btn icon" onClick={onClose} aria-label="Close task board">
            ✕
          </button>
        </header>
        <p className="muted small modal-note">
          Tasks come from TaskCreated / TaskCompleted hook events (agent teams and task lists). Columns are not inferred. Running / Waiting / Blocked tags are a
          labeled heuristic from the owning agent's live status.
        </p>
        <div className="columns">
          {COLUMNS.map((c) => {
            const list = tasks.filter((t) => columnOf(t) === c.id);
            return (
              <div key={c.id} className={`column col-${c.id}`}>
                <h3 title={c.hint}>
                  {c.title} <span className="muted">{list.length}</span>
                </h3>
                {list.length === 0 ? <p className="muted small">None</p> : null}
                {list.map((t) => (
                  <TaskCard key={t.key} t={t} column={c.id} state={state} now={now} onSelect={onSelect} />
                ))}
              </div>
            );
          })}
        </div>
      </section>
    </Frame>
  );
}

function TaskCard({ t, column, state, now, onSelect }: { t: Task; column: ColumnId; state: OfficeState; now: number; onSelect(key: string): void }) {
  const owner = taskOwner(state, t);
  const sub = taskSubState(state, t);
  const cwd = projectCwd(state, t);
  const session = state.agents[t.sessionId];
  const lastUpdate = t.completedAt ?? t.createdAt;
  let duration: string | undefined;
  if (t.createdAt !== undefined) {
    if (column === 'completed' && t.completedAt !== undefined) duration = `took ${formatDuration(t.completedAt - t.createdAt)}`;
    else if (column === 'open') duration = `open for ${formatDuration(now - t.createdAt)}`;
    else if (column === 'orphaned' && session?.endedAt !== undefined) duration = `open ${formatDuration(session.endedAt - t.createdAt)} until the session ended`;
  }
  return (
    <article className={`task-card ${column}`}>
      <div className="task-subject">{t.subject ?? `Task ${t.taskId}`}</div>
      {t.description ? <div className="small task-desc">{t.description}</div> : null}
      <div className="task-meta small">
        {sub ? (
          <span
            className={`dash-heur dash-sub-${sub}`}
            title={`Heuristic: ${SUB_STATE[sub].why}. Claude Code does not report task progress.`}
            aria-label={`${SUB_STATE[sub].label} (heuristic: ${SUB_STATE[sub].why})`}
          >
            {SUB_STATE[sub].label} · heuristic
          </span>
        ) : null}
        {t.teammateName ? <span className="badge kind-teammate">{t.teammateName}</span> : null}
        {owner ? (
          <button className="link" onClick={() => onSelect(owner.key)}>
            {displayName(owner)}
          </button>
        ) : (
          <span className="muted">Agent not reported</span>
        )}
      </div>
      <dl className="dash-task-facts tiny">
        <dt>Project</dt>
        <dd title={cwd}>{cwd ? baseName(cwd) : 'Not reported'}</dd>
        <dt>Created</dt>
        <dd>{t.createdAt ? `${clock(t.createdAt)} (${ago(t.createdAt, now)})` : 'Not observed'}</dd>
        <dt>Duration</dt>
        <dd>{duration ?? 'Not reported'}</dd>
        <dt>Last update</dt>
        <dd title="Latest task event (TaskCreated / TaskCompleted)">{lastUpdate ? `${clock(lastUpdate)} (${ago(lastUpdate, now)})` : 'Not observed'}</dd>
      </dl>
      <div className="muted tiny">
        #{t.taskId} · {sessionLabel(state, t.sessionId)}
      </div>
    </article>
  );
}

function Frame({ inline, onClose, children }: { inline?: boolean; onClose(): void; children: React.ReactNode }) {
  if (inline) return <>{children}</>;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      {children}
    </div>
  );
}
