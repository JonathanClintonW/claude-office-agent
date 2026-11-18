// Usage analytics with explicit data sources.
import './analytics.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  displayName,
  shortId,
  USAGE_SOURCE_LABEL,
  type CostEstimate,
  type HistorySummary,
  type PricingStatus,
  type UsageBucket,
  type UsageSource,
  type UsageSummary,
} from '@agent-office/core';
import { formatMoney, formatTokens, METRIC_DEFINITIONS, stateMetrics, tokensOf } from '../analytics';
import { ago, useStoreInstance } from '../hooks';
import type { ViewProps } from './types';

// Shared helpers, also used by HistoryView.

export type Loadable<T> =
  | { status: 'idle' }
  | { status: 'loading'; data?: T }
  | { status: 'ok'; data: T; at: number }
  | { status: 'error'; error: string; data?: T };

/**
 * Read-only plugin query with loading/error states. `params === null` disables the query.
 * Failures (e.g. disconnected monitor) keep the last good data and surface the error.
 */
export function useRpc<T>(method: string, params: Record<string, unknown> | null, connected: boolean, refreshMs?: number): { state: Loadable<T>; reload(extra?: Record<string, unknown>): void } {
  const store = useStoreInstance();
  const [state, setState] = useState<Loadable<T>>(params ? { status: 'loading' } : { status: 'idle' });
  const [nonce, setNonce] = useState(0);
  const extraRef = useRef<Record<string, unknown> | undefined>(undefined);
  const key = params ? `${method}:${JSON.stringify(params)}` : '';
  useEffect(() => {
    if (!params) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    const run = () => {
      const extra = extraRef.current;
      extraRef.current = undefined;
      setState((s) => ({ status: 'loading', ...('data' in s && s.data !== undefined ? { data: s.data } : {}) }));
      if (!connected) {
        setState((s) => ({ status: 'error', error: 'Not connected to the monitor', ...('data' in s && s.data !== undefined ? { data: s.data } : {}) }));
        return;
      }
      store.rpc<T>(method, { ...params, ...extra }).then(
        (data) => {
          if (!cancelled) setState({ status: 'ok', data, at: Date.now() });
        },
        (e: Error) => {
          if (!cancelled) setState((s) => ({ status: 'error', error: e.message || 'Request failed', ...('data' in s && s.data !== undefined ? { data: s.data } : {}) }));
        },
      );
    };
    run();
    const t = refreshMs && connected ? setInterval(run, refreshMs) : undefined;
    return () => {
      cancelled = true;
      if (t) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected, nonce, refreshMs]);
  return {
    state,
    reload: (extra) => {
      extraRef.current = extra;
      setNonce((n) => n + 1);
    },
  };
}

export function dataOf<T>(s: Loadable<T>): T | undefined {
  return 'data' in s ? s.data : undefined;
}

export function SourceChip({ source }: { source: UsageSource | 'office' }) {
  const label = source === 'office' ? 'Office events (observed)' : USAGE_SOURCE_LABEL[source];
  const title =
    source === 'transcript'
      ? 'Token counts Claude Code recorded in its transcripts, summed once per message id'
      : source === 'claude-code'
        ? "The latest cost-state record Claude Code wrote for the session (Claude Code's own accounting)"
        : source === 'price-table'
          ? 'Computed from your own pricing.json; Agent Office ships no prices'
          : 'Counts of hook, registry and transcript events received by the monitor';
  return (
    <span className={`an-src an-src-${source}`} title={title}>
      {label}
    </span>
  );
}

export function LoadState({ state, what, onRetry }: { state: Loadable<unknown>; what: string; onRetry(): void }) {
  if (state.status === 'loading' && dataOf(state) === undefined) return <p className="muted an-loading">Loading {what}…</p>;
  if (state.status === 'error') {
    return (
      <div className="banner warn an-error" role="alert">
        {what[0]!.toUpperCase() + what.slice(1)} unavailable: {state.error}.{' '}
        <button type="button" className="btn small" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  return null;
}

export function EstimateText({ estimate, pricing }: { estimate?: CostEstimate; pricing?: PricingStatus }) {
  if (!estimate) return <span className="muted">{pricing?.state === 'invalid' ? 'price table invalid' : '—'}</span>;
  const missing = [...estimate.unpricedModels, ...estimate.unpricedCacheModels.map((m) => `${m} (cache)`)];
  return (
    <span title={estimate.partial ? `Partial: no price for ${missing.join(', ')}` : 'Estimate from your price table'}>
      ≈ {formatMoney(estimate.amount, estimate.currency)}
      {estimate.partial ? <span className="an-partial"> partial</span> : null}
    </span>
  );
}

function usd(n: number | undefined): string {
  return n === undefined ? '—' : formatMoney(n, 'USD');
}

function TokenFacts({ b }: { b: UsageBucket }) {
  return (
    <dl className="facts an-facts">
      <dt>Total tokens</dt>
      <dd className="an-big">{formatTokens(tokensOf(b))}</dd>
      <dt>Input</dt>
      <dd>{formatTokens(b.inputTokens)}</dd>
      <dt>Output</dt>
      <dd>{formatTokens(b.outputTokens)}</dd>
      <dt>Cache write</dt>
      <dd>{formatTokens(b.cacheCreationTokens)}</dd>
      <dt>Cache read</dt>
      <dd>{formatTokens(b.cacheReadTokens)}</dd>
      <dt>API messages</dt>
      <dd>{b.messages.toLocaleString()}</dd>
    </dl>
  );
}

function TokenCells({ b }: { b: UsageBucket }) {
  return (
    <>
      <td className="num">{b.messages.toLocaleString()}</td>
      <td className="num">{formatTokens(b.inputTokens)}</td>
      <td className="num">{formatTokens(b.outputTokens)}</td>
      <td className="num">{formatTokens(b.cacheCreationTokens)}</td>
      <td className="num">{formatTokens(b.cacheReadTokens)}</td>
    </>
  );
}

const TOKEN_HEADERS = (
  <>
    <th className="num">Msgs</th>
    <th className="num">Input</th>
    <th className="num">Output</th>
    <th className="num">Cache wr.</th>
    <th className="num">Cache rd.</th>
  </>
);

export function PricingNote({ pricing }: { pricing: PricingStatus }) {
  if (pricing.state === 'ok') {
    return (
      <p className="muted an-note">
        Estimates use your <code>pricing.json</code> ({pricing.models} model entr{pricing.models === 1 ? 'y' : 'ies'}, {pricing.currency}
        {pricing.note ? ` · ${pricing.note}` : ''}). They are API-equivalent estimates, not bills.
      </p>
    );
  }
  if (pricing.state === 'invalid') {
    return (
      <p className="an-note an-bad" role="status">
        Price table invalid: {pricing.error}. No estimate is shown until <code>pricing.json</code> is fixed.
      </p>
    );
  }
  return (
    <p className="muted an-note">
      No price table configured. Agent Office never guesses prices: add <code>pricing.json</code> to the Agent Office data folder to see estimates
      (format in docs/ANALYTICS.md).
    </p>
  );
}

const MAX_ROWS = 100;

export function AnalyticsView({ snap, now, onSelectAgent }: ViewProps) {
  const connected = snap.connection === 'open';
  const usage = useRpc<UsageSummary>('usage.summary', {}, connected, 30_000);
  const history = useRpc<HistorySummary>('history.summary', {}, connected, 60_000);
  const live = useMemo(() => stateMetrics(snap.state), [snap.state]);
  const demoAgents = useMemo(() => Object.values(snap.state.agents).filter((a) => a.sessionId.startsWith('sim-')).length, [snap.state]);
  const u = dataOf(usage.state);
  const h = dataOf(history.state);
  const [showAll, setShowAll] = useState(false);

  const nameForAgent = (sessionId: string, agent: string): string => {
    // Transcript files are named agent-<id>.jsonl; hooks may report either spelling of the id.
    const alt = agent.startsWith('agent-') ? agent.slice('agent-'.length) : `agent-${agent}`;
    const a = agent === 'main' ? snap.state.agents[sessionId] : (snap.state.agents[`${sessionId}::${agent}`] ?? snap.state.agents[`${sessionId}::${alt}`]);
    if (a) return displayName(a);
    return agent === 'main' ? `Session ${shortId(sessionId)}` : agent === 'sidechain' ? 'Sidechain (no agent id)' : `subagent · ${shortId(agent)}`;
  };
  const sessionLabel = (r: { sessionId: string; title?: string; project?: string }) => {
    const a = snap.state.agents[r.sessionId];
    return r.title ?? (a ? displayName(a) : `${r.project ?? 'Session'} · ${shortId(r.sessionId)}`);
  };
  const rows = <T,>(list: T[]) => (showAll ? list : list.slice(0, MAX_ROWS));

  return (
    <section className="page analytics" aria-label="Analytics">
      <h2>Analytics</h2>
      <p className="muted an-intro">
        Local, read-only numbers. Nothing on this page calls a model or the network. Every figure names its source:{' '}
        <SourceChip source="transcript" /> <SourceChip source="claude-code" /> <SourceChip source="price-table" /> <SourceChip source="office" />
      </p>
      <div className="an-toolbar">
        <button type="button" className="btn small" onClick={() => usage.reload({ refresh: true })} disabled={!connected}>
          Refresh
        </button>
        {usage.state.status === 'loading' && u ? <span className="muted">Updating…</span> : null}
        {u ? (
          <span className="muted">
            Transcripts scanned {ago(u.scan.lastScanAt, now)} · {u.scan.sessionsTracked} session{u.scan.sessionsTracked === 1 ? '' : 's'}, {u.scan.filesTracked} file
            {u.scan.filesTracked === 1 ? '' : 's'}
            {u.scan.backlogBytes > 0 ? ` · catching up (${formatTokens(u.scan.backlogBytes)}B left to read)` : ''}
            {u.scan.slowFiles > 0 ? ` · ${u.scan.slowFiles} slow file(s) retried later` : ''}
          </span>
        ) : null}
      </div>
      <LoadState state={usage.state} what="usage" onRetry={() => usage.reload()} />

      {u ? (
        <>
          <div className="an-cards">
            <div className="card an-card">
              <div className="card-title">
                Tokens · <SourceChip source="transcript" />
              </div>
              <TokenFacts b={u.total} />
              <p className="muted an-note">Summed once per API message id across {u.sessions.length} session(s) and their subagents.</p>
            </div>
            <div className="card an-card">
              <div className="card-title">
                Cost · <SourceChip source="claude-code" />
              </div>
              {u.reported ? (
                <>
                  <div className="an-big">{usd(u.reported.totalCostUSD)}</div>
                  <p className="muted an-note">
                    Sum of the latest cost Claude Code recorded in {u.reported.sessions} session transcript{u.reported.sessions === 1 ? '' : 's'}.
                  </p>
                </>
              ) : (
                <p className="muted an-note">Claude Code has not recorded a cost in the tracked transcripts.</p>
              )}
            </div>
            <div className="card an-card">
              <div className="card-title">
                Estimate · <SourceChip source="price-table" />
              </div>
              {u.estimate ? (
                <div className="an-big">
                  <EstimateText estimate={u.estimate} pricing={u.pricing} />
                </div>
              ) : null}
              <PricingNote pricing={u.pricing} />
            </div>
          </div>
          {u.sessions.length === 0 ? (
            <p className="an-empty muted">
              No token usage observed yet. Usage appears for sessions the monitor knows once their transcripts record assistant messages.
            </p>
          ) : null}
        </>
      ) : null}

      <h3>
        Office activity · <SourceChip source="office" />
      </h3>
      <p className="an-summary">{live.summary}</p>
      <div className="an-cards">
        <div className="card an-card">
          <div className="card-title">Now (current office state)</div>
          <dl className="facts an-facts">
            <dt>Sessions</dt>
            <dd>
              {live.sessions.live} live · {live.sessions.ended} ended
            </dd>
            <dt>Agents</dt>
            <dd>
              {live.agents.working} working · {live.agents.waiting} waiting · {live.agents.idle} idle · {live.agents.failed} failed
              {live.agents.unknown ? ` · ${live.agents.unknown} unknown` : ''}
            </dd>
            <dt title={METRIC_DEFINITIONS.toolCalls.definition}>Tool calls</dt>
            <dd>{live.toolCalls}</dd>
            <dt title="PostToolUseFailure events, user interrupts included">Tool failures</dt>
            <dd>{live.toolFailures}</dd>
            <dt>Permission prompts</dt>
            <dd>{live.permissionRequests}</dd>
            <dt title={METRIC_DEFINITIONS.turns.definition}>Turns</dt>
            <dd>{live.turns}</dd>
            <dt>Tasks</dt>
            <dd>
              {live.tasks.completed} completed · {live.tasks.open} open · {live.tasks.leftOpen} left open
            </dd>
          </dl>
          {demoAgents ? (
            <p className="muted small">
              {demoAgents} SIMULATED demo {demoAgents === 1 ? 'agent is' : 'agents are'} not counted here. The journal records every event it receives,
              demo events included.
            </p>
          ) : null}
        </div>
        <div className="card an-card">
          <div className="card-title">Journal (history plugin)</div>
          <LoadState state={history.state} what="history" onRetry={() => history.reload()} />
          {h ? (
            <dl className="facts an-facts">
              <dt>Sessions recorded</dt>
              <dd>{h.sessions}</dd>
              <dt>Events</dt>
              <dd>{h.events.toLocaleString()}</dd>
              <dt>Tool calls</dt>
              <dd>{h.totals.toolCalls.toLocaleString()}</dd>
              <dt title={METRIC_DEFINITIONS.toolErrors.definition}>Tool errors</dt>
              <dd>{h.totals.toolFailures.toLocaleString()}</dd>
              <dt>Tasks</dt>
              <dd>
                {h.totals.tasksCompleted} of {h.totals.tasks} completed
              </dd>
              <dt>Turns</dt>
              <dd>
                {h.totals.turns} ({h.totals.turnFailures} failed)
              </dd>
              <dt>Retention</dt>
              <dd>
                {h.retentionDays} days · {formatTokens(h.totalBytes)}B on disk{h.oldestDay ? ` · since ${h.oldestDay}` : ''}
              </dd>
            </dl>
          ) : null}
        </div>
      </div>

      {u && u.sessions.length ? (
        <>
          <h3>
            Sessions · <SourceChip source="transcript" />
          </h3>
          <div className="an-table-wrap">
            <table className="an-table" aria-label="Usage by session">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Project</th>
                  {TOKEN_HEADERS}
                  <th className="num">Subagents</th>
                  <th className="num">Reported cost</th>
                  <th className="num">Estimate</th>
                  <th>Read</th>
                </tr>
              </thead>
              <tbody>
                {rows(u.sessions).map((r) => (
                  <tr key={r.sessionId}>
                    <td className="an-name">
                      {snap.state.agents[r.sessionId] ? (
                        <button type="button" className="link" onClick={() => onSelectAgent(r.sessionId)}>
                          {sessionLabel(r)}
                        </button>
                      ) : (
                        sessionLabel(r)
                      )}
                    </td>
                    <td title={r.cwd}>{r.project ?? '—'}</td>
                    <TokenCells b={r.total} />
                    <td className="num">{r.subagents || '—'}</td>
                    <td className="num" title={r.reported ? 'Reported by Claude Code (cost-state)' : undefined}>
                      {usd(r.reported?.totalCostUSD)}
                    </td>
                    <td className="num">
                      <EstimateText estimate={r.estimate} pricing={u.pricing} />
                    </td>
                    <td>{r.complete ? <span className="an-ok">complete</span> : <span className="muted">reading…</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>
            Agents · <SourceChip source="transcript" />
          </h3>
          <div className="an-table-wrap">
            <table className="an-table" aria-label="Usage by agent">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Kind</th>
                  <th>Session</th>
                  {TOKEN_HEADERS}
                  <th className="num">Estimate</th>
                </tr>
              </thead>
              <tbody>
                {rows(u.agents).map((r) => (
                  <tr key={`${r.sessionId}:${r.agent}`}>
                    <td className="an-name">{nameForAgent(r.sessionId, r.agent)}</td>
                    <td>{r.kind === 'main' ? 'main thread' : r.kind === 'sidechain' ? 'sidechain' : (r.agentType ?? 'subagent')}</td>
                    <td className="muted">{shortId(r.sessionId)}</td>
                    <TokenCells b={r.total} />
                    <td className="num">
                      <EstimateText estimate={r.estimate} pricing={u.pricing} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="an-split">
            <div>
              <h3>
                Projects · <SourceChip source="transcript" />
              </h3>
              <div className="an-table-wrap">
                <table className="an-table" aria-label="Usage by project">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th className="num">Sessions</th>
                      <th className="num">Tokens</th>
                      <th className="num">Reported cost</th>
                      <th className="num">Estimate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.byProject.map((p) => (
                      <tr key={p.key}>
                        <td className="an-name" title={p.cwd}>
                          {p.label}
                        </td>
                        <td className="num">{p.sessions}</td>
                        <td className="num">{formatTokens(tokensOf(p.total))}</td>
                        <td className="num" title={p.reportedSessions ? `${p.reportedSessions} session(s) reported a cost` : undefined}>
                          {usd(p.reportedCostUSD)}
                        </td>
                        <td className="num">
                          <EstimateText estimate={p.estimate} pricing={u.pricing} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h3>
                Models · <SourceChip source="transcript" />
              </h3>
              <div className="an-table-wrap">
                <table className="an-table" aria-label="Usage by model">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th className="num">Msgs</th>
                      <th className="num">Tokens</th>
                      <th className="num">Estimate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.byModel.map((m) => (
                      <tr key={m.model}>
                        <td className="an-name">{m.model}</td>
                        <td className="num">{m.total.messages.toLocaleString()}</td>
                        <td className="num">{formatTokens(tokensOf(m.total))}</td>
                        <td className="num">
                          <EstimateText estimate={m.estimate} pricing={u.pricing} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          {u.sessions.length > MAX_ROWS || u.agents.length > MAX_ROWS ? (
            <button type="button" className="btn small" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer rows' : 'Show all rows'}
            </button>
          ) : null}
          {u.scan.skipped.noMessageId + u.scan.skipped.unparsableLines + u.scan.skipped.oversizedLines + u.scan.skipped.crossSessionDuplicates > 0 ? (
            <p className="muted an-note">
              Not counted: {u.scan.skipped.noMessageId} assistant records without a message id, {u.scan.skipped.unparsableLines} unparsable lines,{' '}
              {u.scan.skipped.oversizedLines} oversized lines, {u.scan.skipped.crossSessionDuplicates} records already counted in another session.
            </p>
          ) : null}
        </>
      ) : null}

      <details className="an-defs">
        <summary>Definitions</summary>
        <dl className="facts an-facts">
          <dt>{USAGE_SOURCE_LABEL.transcript}</dt>
          <dd>
            Assistant <code>message.usage</code> records in Claude Code transcripts (main transcript and <code>subagents/agent-*.jsonl</code>), counted once per{' '}
            <code>message.id</code>. Office activity never counts as usage.
          </dd>
          <dt>{USAGE_SOURCE_LABEL['claude-code']}</dt>
          <dd>
            The latest <code>cost-state</code> record of a session transcript, shown as recorded.
          </dd>
          <dt>{USAGE_SOURCE_LABEL['price-table']}</dt>
          <dd>Observed tokens multiplied by the per-million-token prices in your pricing.json. Tokens without a price are excluded and the estimate is marked partial.</dd>
          {Object.values(METRIC_DEFINITIONS).map((d) => (
            <Definition key={d.label} label={d.label} kind={d.kind} text={d.definition} />
          ))}
        </dl>
      </details>
    </section>
  );
}

function Definition({ label, kind, text }: { label: string; kind: string; text: string }) {
  return (
    <>
      <dt>
        {label} <span className={`an-kind an-kind-${kind}`}>{kind}</span>
      </dt>
      <dd>{text}</dd>
    </>
  );
}
