// Session history, event timeline and the office replay player.
import './analytics.css';
import { useEffect, useMemo, useState } from 'react';
import {
  agentKeyFor,
  displayName,
  formatDuration,
  shortId,
  type HistorySessionEntry,
  type HistorySessionsResult,
  type MonitorEvent,
  type OfficeLayout,
  type OfficeState,
  type UsageSessionDetail,
} from '@agent-office/core';
import { computeSessionMetrics, formatTokens, METRIC_DEFINITIONS, percent, tokensOf, waitingOf, type SessionMetrics } from '../analytics';
import { SimBadge, StatusPill } from '../components/common';
import { OfficeView } from '../components/OfficeView';
import { clock, useStoreInstance } from '../hooks';
import {
  advance,
  buildReplay,
  createPlayer,
  describeEvent,
  eventsBefore,
  fetchSessionEvents,
  REPLAY_SPEEDS,
  replayWorkerViews,
  seek,
  setSpeed,
  stateAtTime,
  stepEvent,
  timelineBars,
  togglePlay,
  type LoadedSessionEvents,
  type PlayerState,
  type ReplayTimeline,
} from '../replay';
import { dataOf, EstimateText, LoadState, SourceChip, useRpc, type Loadable } from './AnalyticsView';
import type { ViewProps } from './types';

const REPLAY_LABEL = 'Replay · movement reconstructed';
const SKIP_GAPS_MS = 30_000;

/** Local-midnight bounds for an <input type="date"> value. */
export function dayBounds(value: string, edge: 'start' | 'end'): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (edge === 'end') d.setHours(23, 59, 59, 999);
  const t = d.getTime();
  return Number.isFinite(t) ? t : undefined;
}

function dateTime(ts: number): string {
  return new Date(ts).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function sessionTitle(e: HistorySessionEntry): string {
  return e.title ?? `${e.project ?? 'Session'} · ${shortId(e.sessionId)}`;
}

export function HistoryView({ snap }: ViewProps) {
  const connected = snap.connection === 'open';
  const [project, setProject] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const params = useMemo(() => {
    const p: Record<string, unknown> = { limit: 300 };
    if (project !== 'all') p.project = project;
    const f = dayBounds(from, 'start');
    const t = dayBounds(to, 'end');
    if (f !== undefined) p.from = f;
    if (t !== undefined) p.to = t;
    return p;
  }, [project, from, to]);
  const list = useRpc<HistorySessionsResult>('history.sessions', params, connected, 30_000);
  const data = dataOf(list.state);
  const entry = data?.sessions.find((s) => s.sessionId === selected);

  return (
    <section className="page history" aria-label="History">
      <h2>History</h2>
      <p className="muted an-intro">
        Sessions journaled by this monitor on this machine. Replays re-apply the recorded events through the office reducer; nothing is re-run and no model is
        called.
      </p>
      <div className="an-toolbar hv-filters" role="search">
        <label className="ctl">
          Project
          <select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="all">All projects</option>
            {(data?.projects ?? []).map((p) => (
              <option key={p.key} value={p.key}>
                {p.label} ({p.count})
              </option>
            ))}
          </select>
        </label>
        <label className="ctl">
          From
          <input className="text" type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="ctl">
          To
          <input className="text" type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="btn small" onClick={() => list.reload()} disabled={!connected}>
          Refresh
        </button>
        {data ? (
          <span className="muted">
            {data.total} session{data.total === 1 ? '' : 's'}
            {data.total > data.sessions.length ? ` (showing ${data.sessions.length})` : ''}
          </span>
        ) : null}
      </div>
      <LoadState state={list.state} what="history" onRetry={() => list.reload()} />
      {data && data.sessions.length === 0 ? (
        <p className="an-empty muted">
          {project !== 'all' || from || to ? 'No sessions match these filters.' : 'No sessions recorded yet. Sessions appear here once the monitor receives their events.'}
        </p>
      ) : null}
      {data && data.sessions.length ? (
        <div className="an-table-wrap hv-sessions">
          <table className="an-table" aria-label="Recorded sessions">
            <thead>
              <tr>
                <th>Session</th>
                <th>Project</th>
                <th>Started</th>
                <th className="num">Duration</th>
                <th className="num">Agents</th>
                <th className="num">Tasks done</th>
                <th className="num">Tools</th>
                <th className="num">Tool errors</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr key={s.sessionId} className={s.sessionId === selected ? 'an-selected' : undefined}>
                  <td className="an-name">
                    <button type="button" className="link" onClick={() => setSelected(s.sessionId === selected ? null : s.sessionId)}>
                      {sessionTitle(s)}
                    </button>
                    {s.simulated ? <SimBadge /> : null}
                    {s.partial ? (
                      <span className="badge" title="Older events were removed by retention">
                        partial
                      </span>
                    ) : null}
                  </td>
                  <td title={s.cwd}>{s.project ?? '—'}</td>
                  <td className="nowrap">{dateTime(s.firstTs)}</td>
                  <td className="num">{formatDuration(s.lastTs - s.firstTs)}</td>
                  <td className="num">{s.agents}</td>
                  <td className="num">
                    {s.tasksCompleted}/{s.tasks}
                  </td>
                  <td className="num">{s.toolCalls}</td>
                  <td className={`num${s.toolFailures ? ' an-bad' : ''}`}>{s.toolFailures}</td>
                  <td>{s.ended ? <span className="muted">ended</span> : <span className="an-ok">live</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {selected ? <SessionDetail key={selected} sessionId={selected} entry={entry} layout={snap.layout} connected={connected} /> : null}
    </section>
  );
}

type EventsLoad = { status: 'loading' } | { status: 'ok'; data: LoadedSessionEvents } | { status: 'error'; error: string };

function SessionDetail({ sessionId, entry, layout, connected }: { sessionId: string; entry?: HistorySessionEntry; layout: OfficeLayout; connected: boolean }) {
  const store = useStoreInstance();
  const [load, setLoad] = useState<EventsLoad>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const usage = useRpc<UsageSessionDetail>('usage.session', { sessionId }, connected);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    if (!connected) {
      setLoad({ status: 'error', error: 'Not connected to the monitor' });
      return;
    }
    fetchSessionEvents((m, p) => store.rpc(m, p), sessionId).then(
      (data) => !cancelled && setLoad({ status: 'ok', data }),
      (e: Error) => !cancelled && setLoad({ status: 'error', error: e.message || 'Request failed' }),
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, connected, nonce, store]);

  const events = load.status === 'ok' ? load.data.events : undefined;
  const metrics = useMemo(() => (events ? computeSessionMetrics(events, { sessionId }) : undefined), [events, sessionId]);
  const timeline = useMemo(() => (events ? buildReplay(events) : undefined), [events]);

  return (
    <div className="hv-detail" aria-label="Session detail">
      <h3>
        {entry ? sessionTitle(entry) : `Session ${shortId(sessionId)}`}
        {entry?.simulated ? <SimBadge /> : null}
      </h3>
      {load.status === 'loading' ? <p className="muted an-loading">Loading recorded events…</p> : null}
      {load.status === 'error' ? (
        <div className="banner warn an-error" role="alert">
          Events unavailable: {load.error}.{' '}
          <button type="button" className="btn small" onClick={() => setNonce((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : null}
      {load.status === 'ok' && load.data.truncated ? (
        <p className="an-note an-warn">
          Showing the first {load.data.events.length.toLocaleString()} of {load.data.total.toLocaleString()} recorded events.
        </p>
      ) : null}
      {entry && !entry.ended ? (
        <p className="muted an-note">
          Live session: this covers the events recorded so far.{' '}
          <button type="button" className="btn small" onClick={() => setNonce((n) => n + 1)}>
            Reload events
          </button>
        </p>
      ) : null}
      {metrics && timeline ? (
        timeline.events.length ? (
          <>
            <MetricsPanel metrics={metrics} />
            <ReplayPlayer timeline={timeline} layout={layout} />
            <TaskAndToolTables metrics={metrics} />
          </>
        ) : (
          <p className="an-empty muted">No events recorded for this session.</p>
        )
      ) : null}
      <UsagePanel state={usage.state} onRetry={() => usage.reload()} />
    </div>
  );
}

function MetricsPanel({ metrics: m }: { metrics: SessionMetrics }) {
  const d = METRIC_DEFINITIONS;
  return (
    <>
      <p className="an-summary" aria-label="Session summary">
        {m.summary}
      </p>
      <div className="an-cards">
        <div className="card an-card">
          <div className="card-title">
            Observed · <SourceChip source="office" />
          </div>
          <dl className="facts an-facts">
            <dt title={d.prompts.definition}>Prompts</dt>
            <dd>{m.turns.prompts}</dd>
            <dt title={d.turns.definition}>Turns</dt>
            <dd>
              {m.turns.completed} completed{m.turns.failed ? `, ${m.turns.failed} failed` : ''}
            </dd>
            <dt title={d.toolCalls.definition}>Tool calls</dt>
            <dd>{m.tools.calls}</dd>
            <dt title={d.toolErrors.definition}>Tool errors</dt>
            <dd className={m.tools.errors ? 'an-bad' : undefined}>{m.tools.errors}</dd>
            <dt>Interrupted / denied</dt>
            <dd>
              {m.tools.interrupted} / {m.tools.denied}
            </dd>
            <dt title={d.toolUnresolved.definition}>Outcome not observed</dt>
            <dd>{m.tools.unresolved}</dd>
            <dt>Permission prompts</dt>
            <dd>{m.tools.permissionRequests}</dd>
            <dt>Tasks</dt>
            <dd>
              {m.tasks.completed} completed · {m.tasks.leftOpen} left open · {m.tasks.open} open
            </dd>
          </dl>
        </div>
        <div className="card an-card">
          <div className="card-title">
            Derived <span className="an-kind an-kind-derived">derived</span>
          </div>
          <dl className="facts an-facts">
            <dt title={d.sessionDuration.definition}>Duration</dt>
            <dd>{formatDuration(m.durationMs)}</dd>
            <dt title={d.statusTime.definition}>Main agent</dt>
            <dd>
              working {formatDuration(m.main.working)} · waiting {formatDuration(waitingOf(m.main))} · idle {formatDuration(m.main.idle)}
            </dd>
            <dt title={d.agentTime.definition}>All agents</dt>
            <dd>
              working {formatDuration(m.allAgents.working)} · waiting {formatDuration(waitingOf(m.allAgents))} · idle {formatDuration(m.allAgents.idle)}
            </dd>
            <dt title={d.failureRate.definition}>Tool error rate</dt>
            <dd>{m.tools.errorRate === undefined ? '—' : `${Math.round(m.tools.errorRate * 100)}%`}</dd>
            <dt title={d.toolDuration.definition}>Median tool time</dt>
            <dd>{m.tools.durations.medianMs === undefined ? '—' : formatDuration(m.tools.durations.medianMs)}</dd>
            <dt title={d.taskDuration.definition}>Median task time</dt>
            <dd>{m.tasks.durations.medianMs === undefined ? '—' : formatDuration(m.tasks.durations.medianMs)}</dd>
          </dl>
        </div>
        <div className="card an-card">
          <div className="card-title">
            Activity <span className="an-kind an-kind-derived">derived</span>
          </div>
          <ul className="an-bars" aria-label="Tool calls by tool">
            {m.activity.byTool.slice(0, 8).map((t) => (
              <li key={t.name}>
                <span className="an-bar-label">{t.name}</span>
                <span className="an-bar" style={{ ['--w' as string]: `${Math.max(2, Math.round(t.share * 100))}%` }} />
                <span className="an-bar-val">
                  {t.calls} · {percent(t.calls, m.tools.calls)}
                </span>
              </li>
            ))}
            {m.activity.byTool.length === 0 ? <li className="muted">No tool calls recorded.</li> : null}
          </ul>
          {m.activity.byAgent.length > 1 ? (
            <p className="muted an-note">
              By agent: {m.activity.byAgent.slice(0, 5).map((a) => `${a.name} ${percent(a.calls, m.tools.calls)}`).join(' · ')}
            </p>
          ) : null}
        </div>
      </div>
      {m.repeatedErrors.length ? (
        <>
          <h3 title={d.repeatedErrors.definition}>Repeated errors</h3>
          <ul className="an-errors">
            {m.repeatedErrors.map((g) => (
              <li key={g.signature}>
                <span className="an-bad">×{g.count}</span> <strong>{g.tool}</strong>: <span className="mono">{g.sample}</span>{' '}
                <span className="muted">
                  {clock(g.firstTs)}–{clock(g.lastTs)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function TaskAndToolTables({ metrics: m }: { metrics: SessionMetrics }) {
  return (
    <div className="an-split">
      <div>
        <h3>Tasks</h3>
        {m.tasks.list.length ? (
          <div className="an-table-wrap">
            <table className="an-table" aria-label="Session tasks">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Outcome</th>
                  <th className="num">Duration</th>
                </tr>
              </thead>
              <tbody>
                {m.tasks.list.map((t) => (
                  <tr key={t.key}>
                    <td className="an-name">{t.subject ?? `Task ${t.taskId}`}</td>
                    <td>
                      {t.status === 'completed' ? (
                        <span className="an-ok">completed</span>
                      ) : t.status === 'left_open' ? (
                        <span className="an-warn" title={METRIC_DEFINITIONS.tasksLeftOpen.definition}>
                          left open
                        </span>
                      ) : (
                        <span className="muted">open</span>
                      )}
                    </td>
                    <td className="num">{t.durationMs === undefined ? '—' : formatDuration(t.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No tasks recorded.</p>
        )}
      </div>
      <div>
        <h3>Tools</h3>
        {m.tools.byName.length ? (
          <div className="an-table-wrap">
            <table className="an-table" aria-label="Session tools">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th className="num">Calls</th>
                  <th className="num">Errors</th>
                  <th className="num">Time</th>
                </tr>
              </thead>
              <tbody>
                {m.tools.byName.map((t) => (
                  <tr key={t.name}>
                    <td className="an-name">{t.name}</td>
                    <td className="num">{t.calls}</td>
                    <td className={`num${t.failed ? ' an-bad' : ''}`}>{t.failed}</td>
                    <td className="num">{t.timedCalls ? formatDuration(t.totalMs) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No tool calls recorded.</p>
        )}
      </div>
    </div>
  );
}

function UsagePanel({ state, onRetry }: { state: Loadable<UsageSessionDetail>; onRetry(): void }) {
  const u = dataOf(state);
  return (
    <>
      <h3>
        Usage · <SourceChip source="transcript" />
      </h3>
      <LoadState state={state} what="usage" onRetry={onRetry} />
      {u ? (
        u.total.messages === 0 ? (
          <p className="muted">
            {u.transcriptFound ? 'The transcript records no token usage for this session yet.' : 'No transcript found for this session, so no token usage is shown.'}
          </p>
        ) : (
          <div className="an-cards">
            <div className="card an-card">
              <div className="card-title">
                Tokens · <SourceChip source="transcript" />
              </div>
              <dl className="facts an-facts">
                <dt>Total</dt>
                <dd className="an-big">{formatTokens(tokensOf(u.total))}</dd>
                <dt>Input / output</dt>
                <dd>
                  {formatTokens(u.total.inputTokens)} / {formatTokens(u.total.outputTokens)}
                </dd>
                <dt>Cache write / read</dt>
                <dd>
                  {formatTokens(u.total.cacheCreationTokens)} / {formatTokens(u.total.cacheReadTokens)}
                </dd>
                <dt>Subagents</dt>
                <dd>
                  {u.subagents} ({formatTokens(tokensOf(u.subagentTotal))} tokens)
                </dd>
                <dt>Models</dt>
                <dd>{Object.keys(u.byModel).join(', ') || '—'}</dd>
              </dl>
              {!u.complete ? <p className="muted an-note">Still reading the transcript; totals may grow.</p> : null}
            </div>
            <div className="card an-card">
              <div className="card-title">
                Cost · <SourceChip source="claude-code" />
              </div>
              {u.reported?.totalCostUSD !== undefined ? (
                <div className="an-big">USD {u.reported.totalCostUSD.toFixed(u.reported.totalCostUSD < 1 ? 4 : 2)}</div>
              ) : (
                <p className="muted an-note">Not reported in this transcript.</p>
              )}
              <div className="card-title">
                Estimate · <SourceChip source="price-table" />
              </div>
              {u.estimate ? <EstimateText estimate={u.estimate} /> : <p className="muted an-note">No price table configured (or it is invalid).</p>}
            </div>
          </div>
        )
      ) : null}
    </>
  );
}

function agentLabel(state: OfficeState, ev: MonitorEvent): string {
  const a = state.agents[agentKeyFor(ev.sessionId, ev.agentId)];
  if (a) return displayName(a);
  if (ev.sessionId === '*') return 'monitor';
  return ev.agentId ? `${ev.agentType ?? 'subagent'} · ${shortId(ev.agentId)}` : 'session';
}

function ReplayPlayer({ timeline, layout }: { timeline: ReplayTimeline; layout: OfficeLayout }) {
  const [player, setPlayer] = useState<PlayerState>(() => createPlayer(timeline));
  const [skipGaps, setSkipGaps] = useState(true);
  const [showNames, setShowNames] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!player.playing) return;
    let last = performance.now();
    const t = setInterval(() => {
      const at = performance.now();
      const dt = at - last;
      last = at;
      setPlayer((p) => advance(timeline, p, dt, skipGaps ? { skipGapsOverMs: SKIP_GAPS_MS } : {}));
    }, 100);
    return () => clearInterval(t);
  }, [player.playing, timeline, skipGaps]);

  const state = useMemo(() => stateAtTime(timeline, player.position), [timeline, player.position]);
  // Rebuilt only when the replayed state changes, not on every clock tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const workers = useMemo(() => replayWorkerViews(state, player.position, Date.now()), [state]);
  const openTasks = useMemo(() => Object.values(state.tasks).filter((t) => t.status === 'open' && !t.orphaned).length, [state]);
  const bars = useMemo(() => timelineBars(timeline, 120), [timeline]);
  const maxBar = Math.max(1, ...bars.map((b) => b.events));
  const recent = eventsBefore(timeline, player.position, 14);
  const pickedAgent = picked ? state.agents[picked] : undefined;
  const span = Math.max(1, timeline.end - timeline.start);

  return (
    <div className="hv-replay">
      <h3>Replay</h3>
      <div className="hv-stage">
        <div className="hv-replay-label" role="note">
          {REPLAY_LABEL}
        </div>
        <OfficeView
          layout={layout}
          workers={workers}
          selected={picked}
          showNames={showNames}
          editMode={false}
          idleLife={false}
          openTasks={openTasks}
          onSelect={setPicked}
          onBoardClick={() => {}}
          onTileClick={() => {}}
          onItemMove={() => {}}
          debugHandle={false}
          collabState={state}
          collabNow={player.position}
          hourOverride={new Date(player.position).getHours()}
        />
      </div>
      <div className="hv-controls" role="group" aria-label="Replay controls">
        <button type="button" className="btn small" aria-label="Previous event" onClick={() => setPlayer((p) => stepEvent(timeline, p, -1))}>
          ⏮
        </button>
        <button type="button" className="btn small primary" aria-label={player.playing ? 'Pause' : 'Play'} onClick={() => setPlayer((p) => togglePlay(timeline, p))}>
          {player.playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button type="button" className="btn small" aria-label="Next event" onClick={() => setPlayer((p) => stepEvent(timeline, p, 1))}>
          ⏭
        </button>
        <label className="ctl">
          Speed
          <select aria-label="Replay speed" value={player.speed} onChange={(e) => setPlayer((p) => setSpeed(p, Number(e.target.value)))}>
            {REPLAY_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <label className="ctl check" title={`During playback, jump across periods with no events longer than ${SKIP_GAPS_MS / 1000} s`}>
          <input type="checkbox" checked={skipGaps} onChange={(e) => setSkipGaps(e.target.checked)} />
          Skip quiet gaps &gt; {SKIP_GAPS_MS / 1000}s
        </label>
        <label className="ctl check">
          <input type="checkbox" checked={showNames} onChange={(e) => setShowNames(e.target.checked)} />
          Names
        </label>
        <span className="hv-clock" aria-live="off">
          {clock(player.position)} · {formatDuration(player.position - timeline.start)} / {formatDuration(span === 1 ? 0 : span)}
        </span>
      </div>
      <div className="hv-scrub">
        <div
          className="hv-bars"
          aria-hidden="true"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const f = r.width ? (e.clientX - r.left) / r.width : 0;
            setPlayer((p) => seek(timeline, p, timeline.start + f * span));
          }}
        >
          {bars.map((b, i) => (
            <span
              key={i}
              className={`hv-tick${b.errors ? ' bad' : b.warnings ? ' warn' : ''}`}
              style={{ ['--h' as string]: `${b.events ? Math.max(12, Math.round((b.events / maxBar) * 100)) : 0}%` }}
            />
          ))}
          <span className="hv-playhead" style={{ ['--x' as string]: `${((player.position - timeline.start) / span) * 100}%` }} />
        </div>
        <input
          type="range"
          className="hv-range"
          aria-label="Seek"
          min={timeline.start}
          max={timeline.end}
          step={Math.max(1, Math.round(span / 2000))}
          value={player.position}
          onChange={(e) => setPlayer((p) => seek(timeline, p, Number(e.target.value)))}
        />
      </div>
      <div className="an-split">
        <div>
          <h3>Events up to {clock(player.position)}</h3>
          <ol className="hv-events" aria-label="Events at the selected time">
            {recent.length === 0 ? <li className="muted">Before the first recorded event.</li> : null}
            {recent.map((r, i) => {
              const dsc = describeEvent(r.event);
              return (
                <li key={r.index} className={`tone-${dsc.tone}${i === recent.length - 1 ? ' current' : ''}`}>
                  <span className="hv-ev-time">{clock(r.event.ts)}</span>
                  <span className="hv-ev-agent">{agentLabel(state, r.event)}</span>
                  <span className="hv-ev-text">{dsc.text}</span>
                </li>
              );
            })}
          </ol>
        </div>
        <div>
          <h3>Office at this moment</h3>
          <ul className="hv-agents">
            {Object.values(state.agents)
              .sort((x, y) => x.firstSeenAt - y.firstSeenAt)
              .map((a) => (
                <li key={a.key} className={a.key === picked ? 'current' : undefined}>
                  <button type="button" className="link" onClick={() => setPicked(a.key === picked ? null : a.key)}>
                    {displayName(a)}
                  </button>{' '}
                  <StatusPill status={a.status} />
                  {a.key === pickedAgent?.key && a.statusDetail ? <span className="muted"> {a.statusDetail}</span> : null}
                </li>
              ))}
          </ul>
          <p className="muted an-note">
            Statuses are the recorded ones at {clock(player.position)}; walking, seating and animations in the scene are reconstructed.
          </p>
        </div>
      </div>
    </div>
  );
}
