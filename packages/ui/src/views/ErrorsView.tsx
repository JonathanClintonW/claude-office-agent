// Rule-based errors and blockers (see ../errors.ts).
import { useMemo, useState } from 'react';
import { displayName } from '@agent-office/core';
import { SimBadge } from '../components/common';
import { ago, clock } from '../hooks';
import { CATEGORY_META, countBy, DEFAULT_ISSUE_FILTER, detectIssues, filterIssues, type Issue, type IssueCategory, type IssueFilter, type IssueSeverity } from '../errors';
import type { ViewProps } from './types';
import '../dashboard.css';

const SEVERITY_LABEL: Record<IssueSeverity, string> = { error: 'Error', warning: 'Warning', info: 'Info' };
const SEVERITY_ICON: Record<IssueSeverity, string> = { error: '✗', warning: '!', info: 'i' };

export function ErrorsView({ snap, now, onSelectAgent }: ViewProps) {
  const state = snap.state;
  const [filter, setFilter] = useState<IssueFilter>(DEFAULT_ISSUE_FILTER);
  // Durations in titles ("quiet for 6m") use `now`; recompute at most every 10 s.
  const coarseNow = Math.floor(now / 10_000) * 10_000;
  const all = useMemo(() => detectIssues(state, coarseNow), [state, coarseNow]);
  const shown = useMemo(() => filterIssues(all, filter), [all, filter]);
  const byCategory = countBy(all, (i) => i.category);
  const bySeverity = countBy(all, (i) => i.severity);
  const projects = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of all) if (i.projectKey) m.set(i.projectKey, i.projectLabel ?? i.projectKey);
    return [...m].sort((x, y) => x[1].localeCompare(y[1]));
  }, [all]);
  const set = (p: Partial<IssueFilter>) => setFilter({ ...filter, ...p });

  return (
    <section className="page dash-errors" aria-label="Errors">
      <h2>Errors &amp; blockers</h2>
      <p className="muted small">
        Rule-based detection from observed hook, registry and transcript events: no model inference. Items marked <span className="dash-heur">heuristic</span> are
        estimates and say what they are based on. Tool failures, denials and permission blocks require hooks.
      </p>
      <div className="dash-summary" aria-label="Summary">
        {(['error', 'warning', 'info'] as IssueSeverity[]).map((s) => (
          <button
            key={s}
            className={`dash-count sev-${s} ${filter.severity === s ? 'active' : ''}`}
            aria-pressed={filter.severity === s}
            onClick={() => set({ severity: filter.severity === s ? 'all' : s })}
          >
            <b>{bySeverity[s] ?? 0}</b> {SEVERITY_LABEL[s].toLowerCase()}
            {(bySeverity[s] ?? 0) === 1 ? '' : 's'}
          </button>
        ))}
      </div>
      <div className="dash-filters">
        <label className="ctl">
          <span>Type</span>
          <select aria-label="Filter by type" value={filter.category} onChange={(e) => set({ category: e.target.value as 'all' | IssueCategory })}>
            <option value="all">All types ({all.length})</option>
            {(Object.keys(CATEGORY_META) as IssueCategory[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_META[c].label} ({byCategory[c] ?? 0})
              </option>
            ))}
          </select>
        </label>
        <label className="ctl">
          <span>Severity</span>
          <select aria-label="Filter by severity" value={filter.severity} onChange={(e) => set({ severity: e.target.value as 'all' | IssueSeverity })}>
            <option value="all">All</option>
            <option value="error">Errors</option>
            <option value="warning">Warnings</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label className="ctl">
          <span>Project</span>
          <select aria-label="Filter by project" value={filter.project} onChange={(e) => set({ project: e.target.value })}>
            <option value="all">All projects</option>
            {projects.map(([k, label]) => (
              <option key={k} value={k} title={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="ctl check">
          <input type="checkbox" checked={filter.ongoingOnly} onChange={(e) => set({ ongoingOnly: e.target.checked })} />
          <span>Ongoing only</span>
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="muted">{all.length ? 'Nothing matches these filters.' : 'No problems detected in the retained history.'}</p>
      ) : (
        <ul className="dash-issues" aria-label="Detected problems">
          {shown.map((i) => (
            <IssueRow key={i.id} issue={i} now={now} agentName={state.agents[i.agentKey] ? displayName(state.agents[i.agentKey]!) : undefined} onSelect={onSelectAgent} />
          ))}
        </ul>
      )}
    </section>
  );
}

function IssueRow({ issue: i, now, agentName, onSelect }: { issue: Issue; now: number; agentName?: string; onSelect(key: string): void }) {
  return (
    <li className={`dash-issue sev-${i.severity}`} data-category={i.category}>
      <span className="dash-issue-icon" title={SEVERITY_LABEL[i.severity]} aria-label={SEVERITY_LABEL[i.severity]}>
        {SEVERITY_ICON[i.severity]}
      </span>
      <div className="dash-issue-body">
        <div className="dash-issue-title">
          <strong>{i.title}</strong>
          <span className="dash-tag" title={CATEGORY_META[i.category].description}>
            {CATEGORY_META[i.category].label}
          </span>
          {i.heuristic ? (
            <span className="dash-heur" title={i.heuristic}>
              heuristic
            </span>
          ) : null}
          {i.ongoing ? <span className="dash-tag warn">ongoing</span> : null}
          {i.simulated ? <SimBadge /> : null}
        </div>
        {i.detail ? <div className="dash-issue-detail">{i.detail}</div> : null}
        {i.context ? <div className="muted small ellipsis" title={i.context}>{i.context}</div> : null}
        {i.heuristic ? <div className="muted tiny">{i.heuristic}</div> : null}
        <div className="muted tiny">
          {agentName ? (
            <button className="link" onClick={() => onSelect(i.agentKey)}>
              {agentName}
            </button>
          ) : (
            i.agentKey
          )}
          {i.projectLabel ? ` · ${i.projectLabel}` : ''} · {clock(i.at)} ({ago(i.at, now)}) · source: {i.evidence}
        </div>
      </div>
    </li>
  );
}
