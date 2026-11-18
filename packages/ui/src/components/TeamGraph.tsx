// Per-session relationship graph (real data only).
import { useId, type KeyboardEvent } from 'react';
import { displayName, STATUS_META, type Agent } from '@agent-office/core';
import type { Team, TeamRelation } from '../office/collab';

interface Props {
  team: Team;
  onSelectAgent(key: string): void;
}

interface Row {
  key: string;
  agent: Agent;
  depth: number;
  parentKey?: string;
  relation?: TeamRelation;
}

const W = 188;
const H = 34;
const ROW = 46;
const INDENT = 96;
const PAD = 8;
const LANE = 18;

const KIND_LABEL: Record<Agent['kind'], string> = { session: 'lead', subagent: 'subagent', teammate: 'teammate' };

/** Shorten in the middle: the end of a name carries the id that tells agents of one type apart. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const tail = Math.min(8, Math.floor(max / 3));
  return s.slice(0, max - tail - 1) + '…' + s.slice(-tail);
}

/**
 * Lead at the top, subagents and teammates indented under whoever spawned them. Solid edges are
 * verified by hook events, dashed edges are inferred (the note says why); `∥` marks parallel work.
 */
export function TeamGraph({ team, onSelectAgent }: Props) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const relByChild = new Map(team.relations.map((r) => [r.to, r]));
  const rows: Row[] = [];
  if (team.lead) rows.push({ key: team.lead.key, agent: team.lead, depth: 0 });
  const shift = team.lead ? 0 : 1;
  for (const m of team.members) {
    const row: Row = { key: m.key, agent: m.agent, depth: m.depth - shift };
    if (m.parentKey) row.parentKey = m.parentKey;
    const rel = relByChild.get(m.key);
    if (rel) row.relation = rel;
    rows.push(row);
  }
  const index = new Map(rows.map((r, i) => [r.key, i]));
  const x = (r: Row) => PAD + r.depth * INDENT;
  const y = (i: number) => PAD + i * ROW;

  // Task handoffs between two agents in the graph, one lane per pair.
  const pairs = new Map<string, { from: string; to: string; n: number; subjects: string[] }>();
  for (const t of team.tasks) {
    if (!t.handoff || !t.createdBy || !t.completedBy) continue;
    if (!index.has(t.createdBy) || !index.has(t.completedBy)) continue;
    const k = `${t.createdBy}>${t.completedBy}`;
    const p = pairs.get(k) ?? { from: t.createdBy, to: t.completedBy, n: 0, subjects: [] };
    p.n += 1;
    if (t.subject) p.subjects.push(t.subject);
    pairs.set(k, p);
  }
  const lanes = [...pairs.values()];
  const right = PAD + Math.max(0, ...rows.map((r) => r.depth)) * INDENT + W;
  const width = right + PAD + (lanes.length ? 14 + lanes.length * LANE + 76 : 0);
  const height = PAD * 2 + Math.max(1, rows.length) * ROW - (ROW - H);
  const nameOf = (a: Agent) => team.names[a.key] ?? displayName(a);
  const leadName = team.lead ? nameOf(team.lead) : 'session';

  const onKey = (e: KeyboardEvent, key: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectAgent(key);
    }
  };

  return (
    <div className="team-graph-wrap">
      <svg
        className="team-graph"
        role="group"
        aria-label={`Team graph for ${leadName}`}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        shapeRendering="crispEdges"
      >
        <defs>
          <marker id={`arrow-${uid}`} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L6,3 L0,6 z" className="team-arrow" />
          </marker>
          <marker id={`harrow-${uid}`} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L6,3 L0,6 z" className="team-arrow handoff" />
          </marker>
        </defs>

        {rows.map((r, i) => {
          if (!r.parentKey || !r.relation) return null;
          const pi = index.get(r.parentKey);
          if (pi === undefined) return null;
          const parent = rows[pi]!;
          const sx = x(parent) + 12;
          const sy = y(pi) + H;
          const ex = x(r);
          const ey = y(i) + H / 2;
          const inferred = r.relation.confidence === 'inferred';
          return (
            <g key={`e-${r.key}`} className={`team-edge-group${inferred ? ' inferred' : ''}`} data-confidence={r.relation.confidence}>
              <path
                className={`team-edge${inferred ? ' inferred' : ''}`}
                d={`M${sx},${sy} V${ey} H${ex - 1}`}
                strokeDasharray={inferred ? '4 3' : undefined}
                markerEnd={`url(#arrow-${uid})`}
              >
                <title>{r.relation.note ?? r.relation.label}</title>
              </path>
              <text className={`team-edge-label${inferred ? ' inferred' : ''}`} x={sx + 6} y={ey - 4}>
                {r.relation.label}
              </text>
            </g>
          );
        })}

        {lanes.map((p, li) => {
          const a = index.get(p.from)!;
          const b = index.get(p.to)!;
          const x0 = x(rows[a]!) + W;
          const x1 = x(rows[b]!) + W;
          const y0 = y(a) + H / 2 + 4;
          const y1 = y(b) + H / 2 - 4;
          const cx = right + 14 + li * LANE;
          return (
            <g key={`h-${p.from}-${p.to}`} className="team-handoff-group">
              <path className="team-handoff" d={`M${x0},${y0} H${cx} V${y1} H${x1 + 1}`} markerEnd={`url(#harrow-${uid})`}>
                <title>{p.subjects.length ? `Task handoff: ${p.subjects.join(', ')}` : 'Task handoff (created by one agent, completed by another)'}</title>
              </path>
              <text className="team-edge-label handoff" x={cx + 4} y={(y0 + y1) / 2 + 3}>
                {p.n > 1 ? `handoff ×${p.n}` : 'handoff'}
              </text>
            </g>
          );
        })}

        {rows.map((r, i) => {
          const meta = STATUS_META[r.agent.status];
          const name = nameOf(r.agent);
          const kind = KIND_LABEL[r.agent.kind];
          const working = team.working.length >= 2 && team.working.includes(r.key);
          const evidence = r.relation ? ` · ${r.relation.confidence} link: ${r.relation.note ?? r.relation.label}` : '';
          return (
            <g
              key={r.key}
              className={`team-node kind-${r.agent.kind}`}
              transform={`translate(${x(r)},${y(i)})`}
              role="button"
              tabIndex={0}
              aria-label={`${name} (${kind}, ${meta.label})${working ? ' · working in parallel' : ''}`}
              data-key={r.key}
              onClick={() => onSelectAgent(r.key)}
              onKeyDown={(e) => onKey(e, r.key)}
            >
              <title>{`${name} · ${kind} · ${meta.label}: ${meta.description}${r.agent.stale ? ' (quiet: may be outdated)' : ''}${working ? ' · working in parallel' : ''}${evidence}`}</title>
              <rect className="team-node-box" width={W} height={H} />
              <rect className="team-node-status" width={6} height={H} fill={meta.color} />
              <text className="team-node-name" x={12} y={14}>
                {clip(name, 25)}
              </text>
              <text className="team-node-sub" x={12} y={27}>
                {`${kind} · ${meta.label}${r.agent.stale ? ' · quiet' : ''}`}
              </text>
              {working ? (
                <text className="team-node-flag" x={W - 6} y={14} textAnchor="end">
                  ∥
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
