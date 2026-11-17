import { useState } from 'react';
import {
  agentLog,
  agentTasks,
  baseName,
  childrenOf,
  describeParentLink,
  displayName,
  displayPath,
  formatDuration,
  formatTokens,
  isSimulated,
  safeText,
  type Agent,
  type OfficeState,
  type ToolCall,
  type ToolStatus,
} from '@agent-office/core';
import { recentToolProblems } from '../errors';
import { ago, clock } from '../hooks';
import type { HostInfo } from '../transport';
import { GitSummary, useGitStatus } from '../views/GitView';
import { KindBadge, SimBadge, SourceTag, StatusPill } from './common';
import { Portrait } from './Portrait';
import '../dashboard.css';

interface Props {
  agent: Agent;
  state: OfficeState;
  now: number;
  host: HostInfo;
  onSelect(key: string): void;
  onClose(): void;
  onOpenTranscript(path: string): void;
  onFocusClaude(): void;
}

const TOOL_ICON: Record<ToolStatus, [string, string]> = {
  running: ['▶', 'Running'],
  awaiting_permission: ['!', 'Waiting for permission'],
  succeeded: ['✓', 'Succeeded'],
  failed: ['✗', 'Failed'],
  denied: ['⊘', 'Denied'],
  interrupted: ['■', 'Interrupted'],
  unknown: ['?', 'Outcome not observed'],
};

type Tab = 'activity' | 'tools' | 'tasks' | 'log';

/** Tools whose target is a single file path. */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);

/** The file a tool call operates on, when the tool's target is a file path. */
function fileTarget(t: ToolCall | undefined): string | undefined {
  return t && t.target && FILE_TOOLS.has(t.name) ? t.target : undefined;
}

const GIT_REFRESH_MS = 20_000;

/** Task subjects come from hook payloads; they are sanitised again before display. */
function taskSubject(subject: string | undefined, taskId: string): string {
  return safeText(subject, 200) ?? `Task ${taskId}`;
}

function childrenLabel(children: readonly Agent[]): string {
  const teammates = children.filter((c) => c.kind === 'teammate').length;
  const kind = teammates === 0 ? 'Subagents' : teammates === children.length ? 'Teammates' : 'Subagents & teammates';
  return `${kind} (${children.length})`;
}

function Field({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd title={title}>{children}</dd>
    </>
  );
}

function ToolRow({ t, now, cwd }: { t: ToolCall; now: number; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const [icon, label] = TOOL_ICON[t.status];
  const running = t.status === 'running' || t.status === 'awaiting_permission';
  const duration =
    t.durationMs !== undefined ? formatDuration(t.durationMs) : running && t.startedAt ? `${formatDuration(now - t.startedAt)}…` : '—';
  const hasMore = Boolean(t.error || t.note || t.target);
  return (
    <li className={`tool tool-${t.status}`}>
      <button className="tool-main" onClick={() => hasMore && setOpen(!open)} aria-expanded={hasMore ? open : undefined}>
        <span className="tool-icon" title={label}>
          {icon}
        </span>
        <span className="tool-name">{t.mcpServer ? `MCP ${t.name.split('__').slice(2).join('__')}` : t.name}</span>
        <span className="tool-summary ellipsis" title={t.summary}>
          {t.summary}
        </span>
        <span className="tool-dur" title={t.durationSource === 'reported' ? 'Duration reported by Claude Code' : t.durationSource === 'observed' ? 'Observed between hook events' : ''}>
          {duration}
        </span>
        <span className="tool-time muted">{clock(t.startedAt ?? t.endedAt)}</span>
      </button>
      {open ? (
        <div className="tool-detail">
          {t.target ? (
            <div>
              <span className="muted">Target:</span> <code>{t.target.length > 3 && cwd ? displayPath(t.target, cwd) : t.target}</code>
            </div>
          ) : null}
          {t.error ? (
            <div className="err">
              <span className="muted">Error:</span> {t.error}
            </div>
          ) : null}
          {t.note ? <div className="muted">{t.note}</div> : null}
          <div className="muted">
            {label}
            {t.hasRealId ? ` · ${t.id}` : ' · no tool_use_id'}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function Inspector({ agent: a, state, now, host, onSelect, onClose, onOpenTranscript, onFocusClaude }: Props) {
  const [tab, setTab] = useState<Tab>('activity');
  const parent = a.parentKey ? state.agents[a.parentKey] : undefined;
  const children = childrenOf(state, a.key);
  const current = a.currentToolId ? a.tools.find((t) => t.id === a.currentToolId) : undefined;
  const tasks = agentTasks(state, a);
  const log = agentLog(state, a.key, 200);
  const tools = [...a.tools].reverse();
  const observedToolMs = a.tools.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  const usage = a.usage;
  const context = usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens : undefined;
  const hooked = a.sources.includes('hook');
  const currentFile = fileTarget(current);
  const lastFileTool = tools.find((t) => fileTarget(t) !== undefined && t !== current);
  const problems = recentToolProblems(a, 5);
  const observedFor = (a.endedAt ?? now) - a.firstSeenAt;
  const git = useGitStatus(a.cwd, a.cwd, GIT_REFRESH_MS);
  const sortedTasks = [...tasks].sort((x, y) => (y.createdAt ?? y.completedAt ?? 0) - (x.createdAt ?? x.completedAt ?? 0));
  const rel = (p: string) => (a.cwd ? displayPath(p, a.cwd) : p);
  const session = a.kind !== 'session' ? state.agents[a.sessionId] : undefined;
  const projectDir = (session ?? a).cwd ?? a.cwd;
  const parentLink = describeParentLink(a);
  const tasksCreated = tasks.filter((t) => t.createdBy === a.key).length;
  const tasksCompleted = tasks.filter((t) => t.completedBy === a.key).length;

  return (
    <section className="inspector" aria-label={`Details for ${displayName(a)}`}>
      <header className="insp-head">
        <div className="insp-title">
          <Portrait agent={a} scale={3} pose={a.status === 'completed' ? 'stand_cheer' : a.status === 'failed' ? 'stand_slump' : a.status === 'waiting_permission' ? 'stand_raise' : 'stand'} />
          <div className="insp-name">
            <h2 title={displayName(a)}>{displayName(a)}</h2>
            <div className="insp-class">
              {a.kind === 'session' ? 'Session' : a.kind === 'teammate' ? 'Teammate' : 'Subagent'}
              {a.agentType ? ` · ${a.agentType}` : ''}
              {a.model ? ` · ${a.model}` : ''}
            </div>
            {a.sources.includes('hook') ? (
              <div className="stats" aria-label="Observed counts">
                <span className="stat" title="Turns completed">
                  <b>{a.counts.turns}</b>turns
                </span>
                <span className="stat" title="Tool calls">
                  <b>{a.counts.tools}</b>tools
                </span>
                <span className={`stat ${a.counts.failures ? 'bad' : ''}`} title="Tool failures">
                  <b>{a.counts.failures}</b>fails
                </span>
                <span className={`stat ${a.counts.permissions ? 'warn' : ''}`} title="Permission requests">
                  <b>{a.counts.permissions}</b>perms
                </span>
              </div>
            ) : null}
          </div>
          <button className="btn icon" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>
        <div className="insp-tags">
          <KindBadge agent={a} />
          {isSimulated(a) ? <SimBadge /> : null}
          <StatusPill status={a.status} stale={a.stale} />
          <SourceTag source={a.statusSource} />
        </div>
        <p className="insp-detail">
          {a.statusDetail ?? '—'} <span className="muted">· since {ago(a.statusAt || undefined, now)}</span>
        </p>
        {a.status === 'unknown' && a.lastKnownStatus ? <p className="muted small">Last known status: {a.lastKnownStatus}. Waiting for live data.</p> : null}
        {a.stale ? <p className="warn-text small">No events for {formatDuration(now - a.lastEventAt)}. The status may be outdated (missed events, a long silent operation, or a crashed process).</p> : null}
      </header>

      <nav className="tabs" role="tablist">
        {(
          [
            ['activity', 'Activity'],
            ['tools', `Tools (${a.tools.length})`],
            ['tasks', `Tasks (${tasks.length})`],
            ['log', `Log (${log.length})`],
          ] as Array<[Tab, string]>
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </nav>

      <div className="insp-body">
        {tab === 'activity' ? (
          <>
            {current ? (
              <div className="card now-card">
                <div className="card-title">Current tool</div>
                <div>
                  <strong>{current.name}</strong> {current.summary}
                </div>
                {current.target ? <code className="block">{a.cwd ? displayPath(current.target, a.cwd) : current.target}</code> : null}
                <div className="muted small">
                  {current.status === 'awaiting_permission' ? 'Waiting for permission · ' : 'Running · '}
                  {current.startedAt ? formatDuration(now - current.startedAt) : 'start time unknown'}
                </div>
              </div>
            ) : null}
            {a.pendingPermission ? (
              <div className="card perm-card">
                <div className="card-title">Permission requested</div>
                <div>
                  <strong>{a.pendingPermission.toolName}</strong> {a.pendingPermission.summary}
                </div>
                <div className="muted small">{ago(a.pendingPermission.at, now)} · answer it in Claude Code</div>
                {host.canFocusClaude ? (
                  <div className="dash-nav-action">
                    <button
                      className="btn small"
                      onClick={onFocusClaude}
                      title="Navigation only: focuses the official Claude Code extension. Nothing is sent to Claude and the permission is not answered."
                    >
                      Open Claude Code
                    </button>
                    <span className="muted tiny">Navigation only: switches to the Claude Code panel. No prompt or answer is sent.</span>
                  </div>
                ) : null}
              </div>
            ) : null}
            {a.lastMessage ? (
              <div className="card">
                <div className="card-title">Last reported message (truncated)</div>
                <p className="last-msg">{a.lastMessage}</p>
              </div>
            ) : null}

            <dl className="facts">
              <Field label="Current file" title={currentFile ?? 'The running tool does not target a file, or no tool is running'}>
                {currentFile ? <code>{rel(currentFile)}</code> : <span className="muted">Not reported</span>}
              </Field>
              {lastFileTool ? (
                <Field label="Last file" title={`${lastFileTool.name} · ${clock(lastFileTool.startedAt ?? lastFileTool.endedAt)}`}>
                  <code>{rel(fileTarget(lastFileTool)!)}</code> <span className="muted small">({lastFileTool.name})</span>
                </Field>
              ) : null}
              <Field label="Project" title={projectDir}>
                {projectDir ? baseName(projectDir) : <span className="muted">Not reported</span>}
              </Field>
              <Field label="Session">
                {session && session.key !== a.parentKey ? (
                  <>
                    <button className="link" onClick={() => onSelect(session.key)}>
                      {displayName(session)}
                    </button>{' '}
                  </>
                ) : null}
                <code>{a.sessionId}</code>
              </Field>
              {a.agentId ? (
                <Field label="Agent id">
                  <code>{a.agentId}</code>
                </Field>
              ) : null}
              {a.agentType ? <Field label="Agent type">{a.agentType}</Field> : null}
              {a.teammateName ? <Field label="Teammate">{a.teammateName}</Field> : null}
              {a.teamName ? <Field label="Team">{a.teamName}</Field> : null}
              {a.description ? <Field label="Task">{a.description}</Field> : null}
              {a.kind !== 'session' ? (
                <Field label="Parent" title={a.spawnToolUseId ? `Spawning tool call ${a.spawnToolUseId}` : undefined}>
                  {parent ? (
                    <button className="link" onClick={() => onSelect(parent.key)}>
                      {displayName(parent)}
                    </button>
                  ) : (
                    <span className="muted">{a.parentKey ? 'No longer in the office (removed)' : 'Not reported'}</span>
                  )}
                  {parentLink ? <div className="muted small parent-via">{parentLink}</div> : null}
                </Field>
              ) : null}
              {children.length ? (
                <Field label={childrenLabel(children)}>
                  <span className="chips">
                    {children.map((c) => (
                      <button key={c.key} className="chip" onClick={() => onSelect(c.key)}>
                        {displayName(c)} <StatusPill status={c.status} />
                      </button>
                    ))}
                  </span>
                </Field>
              ) : null}
              <Field label="Tasks" title="From TaskCreated / TaskCompleted hook events">
                {tasks.length ? (
                  <>
                    {tasksCreated} created · {tasksCompleted} completed by this agent
                    {tasks.length > tasksCreated ? <span className="muted small"> ({tasks.length} related)</span> : null}
                  </>
                ) : (
                  <span className="muted">None reported</span>
                )}
              </Field>
              {a.cwd ? (
                <Field label="Directory" title={a.cwd}>
                  <code>{a.cwd}</code>
                </Field>
              ) : null}
              {a.model ? <Field label="Model">{a.model}</Field> : null}
              {a.permissionMode ? <Field label="Permission mode">{a.permissionMode}</Field> : null}
              {a.entrypoint ? <Field label="Launched from">{a.entrypoint === 'claude-vscode' ? 'VS Code extension' : a.entrypoint}</Field> : null}
              {a.pid ? <Field label="Process">{a.pid}</Field> : null}
              {a.version ? <Field label="Claude Code">{a.version}</Field> : null}
              {a.backgroundRunning ? <Field label="Background tasks">{a.backgroundRunning} running at last turn end</Field> : null}
            </dl>

            <h3>Timing</h3>
            <dl className="facts">
              <Field label="First seen">
                {clock(a.firstSeenAt)} <span className="muted">({ago(a.firstSeenAt, now)})</span>
              </Field>
              <Field label="Last event">
                {clock(a.lastEventAt)} <span className="muted">({ago(a.lastEventAt, now)})</span>
              </Field>
              {a.endedAt ? (
                <Field label="Ended">
                  {clock(a.endedAt)} <span className="muted">· {a.endReason}</span>
                </Field>
              ) : null}
              {a.turnCompletedAt ? <Field label="Last turn done">{clock(a.turnCompletedAt)}</Field> : null}
              <Field
                label={a.kind === 'session' ? 'Session duration' : 'Lifetime'}
                title="Observed: from the first event the monitor saw to the end (or now). The agent may have started earlier."
              >
                {observedFor >= 0 ? formatDuration(observedFor) : '—'}{' '}
                <span className="muted small">(observed{a.endedAt ? '' : ', not ended'})</span>
              </Field>
              <Field label="Observed">
                {a.sources.includes('hook') ? (
                  <>
                    {a.counts.turns} turns · {a.counts.tools} tool calls · {a.counts.failures} failures · {a.counts.permissions} permission requests
                  </>
                ) : (
                  <span className="muted">No hook events received for this agent, so turns and tool calls are not observed.</span>
                )}
              </Field>
              <Field label="Tool time" title="Sum of reported or observed durations of the retained tool history">
                {observedToolMs ? formatDuration(observedToolMs) : '—'}
              </Field>
            </dl>

            <h3>Recent errors</h3>
            {problems.length ? (
              <ul className="dash-mini-list dash-recent-errors" aria-label="Recent errors">
                {problems.map((t) => (
                  <li key={t.id} className={`dash-err-${t.status}`}>
                    <span className="muted small">{clock(t.endedAt ?? t.startedAt)}</span> <strong>{t.name}</strong> {TOOL_ICON[t.status][1].toLowerCase()}
                    {t.error ? <span className="err small"> · {t.error.split(/\r?\n/)[0]}</span> : null}
                    <div className="muted tiny ellipsis" title={t.summary}>
                      {t.summary}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">{hooked ? 'No failed, denied or interrupted tool calls in the retained history.' : 'Not reported (tool activity requires hooks).'}</p>
            )}
            {a.status === 'failed' ? <p className="err small">Turn failed: {a.statusDetail ?? 'no detail reported'}</p> : null}

            <h3>Git</h3>
            {a.cwd ? (
              <GitSummary load={git} state={state} now={now} onSelect={onSelect} />
            ) : (
              <p className="muted small">Not reported (no working directory known for this agent).</p>
            )}

            <h3>Context usage</h3>
            {usage && context !== undefined ? (
              <dl className="facts">
                <Field label="Context">
                  {formatTokens(context)} tokens <span className="muted">(input {formatTokens(usage.inputTokens)}, cache read {formatTokens(usage.cacheReadTokens)}, cache write {formatTokens(usage.cacheCreationTokens)})</span>
                </Field>
                <Field label="Output">{formatTokens(usage.outputTokens)} tokens</Field>
                <Field label="Source">
                  {(a.usageSource ?? 'transcript') === 'transcript' ? 'Latest API call recorded in the transcript' : 'Latest reported API call'}
                  {usage.at ? `, ${ago(usage.at, now)}` : ''} <SourceTag source={a.usageSource ?? 'transcript'} />
                </Field>
              </dl>
            ) : (
              <p className="muted small">Not available. Usage is only shown when Claude Code recorded it in a readable transcript; it is never estimated.</p>
            )}

            <h3>Data sources</h3>
            <p className="sources-line">
              {a.sources.map((s) => (
                <SourceTag key={s} source={s} />
              ))}
            </p>
            {a.transcriptPath && host.canOpenFiles && a.kind === 'session' ? (
              <button className="btn small" onClick={() => onOpenTranscript(a.transcriptPath!)}>
                Open transcript (read-only)
              </button>
            ) : null}
            <p className="dash-readonly small" role="note">
              <strong>Read-only monitoring.</strong> This dashboard cannot send prompts, answer permission requests, or start, resume or stop Claude sessions. Use
              Claude Code itself for that.
            </p>
          </>
        ) : null}

        {tab === 'tools' ? (
          tools.length ? (
            <ul className="tool-list">
              {tools.map((t) => (
                <ToolRow key={t.id} t={t} now={now} cwd={a.cwd} />
              ))}
            </ul>
          ) : (
            <p className="muted">No tool calls observed{a.sources.includes('hook') ? '' : ' (tool activity requires hooks)'}.</p>
          )
        ) : null}

        {tab === 'tasks' ? (
          tasks.length ? (
            <>
              <p className="muted small">Task history from TaskCreated / TaskCompleted hook events, newest first.</p>
              <ul className="task-mini">
                {sortedTasks.map((t) => (
                  <li key={t.key} className={`task-card ${t.status === 'open' && t.orphaned ? 'orphaned' : t.status}`}>
                    <div className="task-subject">{taskSubject(t.subject, t.taskId)}</div>
                    {t.description ? <div className="muted small">{safeText(t.description, 800)}</div> : null}
                    <div className="muted small">
                      {t.status === 'completed' ? `Completed ${clock(t.completedAt)}` : t.orphaned ? 'Open when the session ended' : `Open since ${clock(t.createdAt)}`}
                      {t.teammateName ? ` · ${t.teammateName}` : ''}
                    </div>
                    <div className="muted tiny">
                      {t.createdAt ? `Created ${clock(t.createdAt)}` : 'Creation not observed'}
                      {t.createdBy && t.createdBy !== a.key && state.agents[t.createdBy] ? ` by ${displayName(state.agents[t.createdBy]!)}` : ''}
                      {t.completedAt && t.completedBy && t.completedBy !== a.key && state.agents[t.completedBy] ? ` · completed by ${displayName(state.agents[t.completedBy]!)}` : ''}
                      {t.createdAt && t.completedAt ? ` · took ${formatDuration(t.completedAt - t.createdAt)}` : ''}
                      {t.status === 'open' && !t.orphaned && t.createdAt ? ` · open for ${formatDuration(now - t.createdAt)}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">No tasks created or completed by this agent.</p>
          )
        ) : null}

        {tab === 'log' ? (
          log.length ? (
            <ol className="log">
              {[...log].reverse().map((e) => (
                <li key={`${e.seq}-${e.kind}`}>
                  <span className="log-time">{clock(e.ts)}</span>
                  <SourceTag source={e.source} />
                  <span className="log-text">{e.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No log entries retained.</p>
          )
        ) : null}
      </div>
    </section>
  );
}
