/**
 * Mode A: real collaboration.
 *
 * Pure functions that derive collaboration facts from the reducer's OfficeState, and
 * from diffs between two consecutive states. Nothing here is guessed: every signal maps
 * to a field the reducer set from an observed event (hook, transcript, registry).
 *
 * - `verified`: backed by a hook event that names both sides (SubagentStart matched to the
 *   spawning Agent/Task tool call, TaskCreated/TaskCompleted attributed to an agent,
 *   teammate hook events, SubagentStop).
 * - `inferred`: the reducer had to assume part of the link (parentVia 'implicit' or
 *   'transcript', or a parent that is no longer in state). Always shown as such.
 *
 * Labels are fixed, generic strings. The only free text that can appear is a task
 * subject that is already present in state, re-sanitised with `safeText`. Prompts, tool
 * input and tool output are never read here.
 */
import { describeParentLink, displayName, safeText, TERMINAL_STATUSES, type Agent, type OfficeState, type Task } from '@agent-office/core';

export type Confidence = 'verified' | 'inferred';

export type CollabSignalKind =
  /** Lead (session) → subagent, matched to the spawning Agent/Task tool call. */
  | 'delegation'
  /** Subagent → subagent, matched to the spawning Agent/Task tool call. */
  | 'nested_delegation'
  /** Subagent observed in a session without a matched spawning call (or link inferred). */
  | 'subagent_started'
  /** Agent-team teammate reported by teammate hook events in the lead's session. */
  | 'teammate'
  /** Task created by one agent and completed by another. */
  | 'task_handoff'
  /** At least two agents of one session in the `working` status at the same time. */
  | 'parallel_work'
  /** A delegated subagent finished (SubagentStop). */
  | 'delegated_complete';

export interface CollabSignal {
  /** Stable identity used to de-duplicate signals across diffs. */
  id: string;
  kind: CollabSignalKind;
  /** Agent key of the originator (parent, creator, finishing child, first parallel worker). */
  from: string;
  /** Agent key of the recipient (child, completer, parent, second parallel worker). */
  to: string;
  /** Timestamp of the evidence (epoch ms). */
  at: number;
  /** Generic, sanitised label, e.g. "Task handoff detected". */
  label: string;
  /** Task subject, only when present in state (sanitised). */
  subject?: string;
  /** Task key for task signals. */
  taskKey?: string;
  sessionId: string;
  /** All agents involved (parallel work lists every worker). */
  participants?: string[];
  source: 'real';
  confidence: Confidence;
  /** Why a signal is inferred, or which event backs it. */
  note?: string;
  /** From `agent-office simulate` demo sessions (`sim-` prefix): real events, demo data. */
  simulated: boolean;
}

/** Which evidence established a relation. */
export type RelationBasis = 'spawn-tool' | 'session' | 'team-event' | 'transcript' | 'implicit' | 'missing-parent';

export interface TeamRelation {
  from: string;
  to: string;
  kind: 'delegation' | 'nested_delegation' | 'subagent' | 'teammate';
  confidence: Confidence;
  /** Short edge label. */
  label: string;
  basis: RelationBasis;
  /** Explanation, always present for inferred relations. */
  note?: string;
}

export interface TeamMember {
  key: string;
  agent: Agent;
  /** 1 = direct child of the lead. */
  depth: number;
  /** Graph parent (lead key, another member, or undefined when there is no lead). */
  parentKey?: string;
}

export interface TaskLink {
  taskKey: string;
  taskId: string;
  subject?: string;
  status: Task['status'];
  orphaned: boolean;
  createdBy?: string;
  completedBy?: string;
  /** Created by one agent and completed by another (both observed). */
  handoff: boolean;
  createdAt?: number;
  completedAt?: number;
  teammateName?: string;
}

export interface Team {
  sessionId: string;
  /** Session agent key, when the session itself is in state. */
  leadKey?: string;
  lead?: Agent;
  /** Every non-lead agent of the session, depth-first (children after their parent). */
  members: TeamMember[];
  relations: TeamRelation[];
  tasks: TaskLink[];
  /** Agents of this session in the `working` status right now (≥2 means parallel work). */
  working: string[];
  /** Display name per agent key (lead and members), unique within the team. */
  names: Record<string, string>;
  teamNames: string[];
  /** Some relation is inferred, or the lead is missing. */
  partial: boolean;
  /** Any agent of the session is still live. */
  active: boolean;
  simulated: boolean;
  lastActivityAt: number;
}

export interface ParallelGroup {
  sessionId: string;
  leadKey?: string;
  keys: string[];
  /** Newest status evidence among the workers. */
  at: number;
  simulated: boolean;
}

/** Transient scene effect for a newly observed, verified collaboration event. */
export interface CollabVisual {
  id: string;
  kind: 'handoff' | 'delegate' | 'complete';
  /** Agent key whose desk the effect starts at. */
  from: string;
  /** Agent key whose desk the effect flies to. */
  to: string;
  at: number;
  label: string;
  /** Handoffs only: the task subject from state, sanitised again and at most VISUAL_DETAIL_MAX characters. */
  detail?: string;
}

/** Longest `CollabVisual.detail` (a task subject drawn next to the desk-to-desk effect). */
export const VISUAL_DETAIL_MAX = 40;

export const SIGNAL_LABEL: Record<CollabSignalKind, string> = {
  delegation: 'Subagent delegated',
  nested_delegation: 'Nested delegation',
  subagent_started: 'Subagent started',
  teammate: 'Teammate joined',
  task_handoff: 'Task handoff detected',
  parallel_work: 'Parallel work detected',
  delegated_complete: 'Delegated work completed',
};

const INFERRED_NOTE: Record<'implicit' | 'transcript' | 'missing-parent', string> = {
  implicit: 'Inferred link: the agent was seen in this session, but no SubagentStart was observed; parent assumed to be the session lead',
  transcript: 'Partial link: discovered from transcript metadata; the spawning agent was not observed by hooks',
  'missing-parent': 'Inferred link: the reported parent is no longer in state',
};

const isSim = (sessionId: string) => sessionId.startsWith('sim-');

/** The relation of a non-session agent to its parent, from the reducer's parentVia. */
export function relationOf(state: OfficeState, a: Agent): TeamRelation | undefined {
  if (a.kind === 'session') return undefined;
  const sessionKey = a.sessionId;
  const reportedParent = a.parentKey && state.agents[a.parentKey] ? a.parentKey : undefined;
  const from = reportedParent ?? (state.agents[sessionKey] ? sessionKey : undefined);
  if (!from) return undefined;
  const parent = state.agents[from]!;
  const nested = parent.kind !== 'session';
  const via = a.parentVia;

  if (a.parentKey && !reportedParent) {
    return { from, to: a.key, kind: a.kind === 'teammate' ? 'teammate' : 'subagent', confidence: 'inferred', label: 'inferred', basis: 'missing-parent', note: INFERRED_NOTE['missing-parent'] };
  }
  if (via === 'spawn-tool') {
    // A teammate that was also spawned by a tool call keeps the verified spawn link.
    return {
      from,
      to: a.key,
      kind: nested ? 'nested_delegation' : 'delegation',
      confidence: 'verified',
      label: nested ? 'nested' : 'delegated',
      basis: 'spawn-tool',
      note: 'SubagentStart matched to the Agent/Task tool call that spawned it',
    };
  }
  if (a.kind === 'teammate' && via !== 'transcript') {
    // kind 'teammate' is only set by teammate hook events (TeammateIdle, Task* with teammate_name).
    return { from, to: a.key, kind: 'teammate', confidence: 'verified', label: 'teammate', basis: 'team-event', note: 'Reported by agent-team hook events in this session' };
  }
  if (via === 'session') {
    return { from, to: a.key, kind: 'subagent', confidence: 'verified', label: 'started', basis: 'session', note: describeParentLink(a) ?? 'SubagentStart observed in this session; the spawning tool call was not observed' };
  }
  const basis = via === 'transcript' ? 'transcript' : 'implicit';
  return { from, to: a.key, kind: a.kind === 'teammate' ? 'teammate' : 'subagent', confidence: 'inferred', label: 'inferred', basis, note: INFERRED_NOTE[basis] };
}

function subjectOf(t: Task): string | undefined {
  return safeText(t.subject, 120);
}

/** Tie-break for equal timestamps: a link is reported before work on it completes. */
const KIND_RANK: Record<CollabSignalKind, number> = {
  delegation: 0,
  nested_delegation: 0,
  subagent_started: 0,
  teammate: 0,
  parallel_work: 1,
  task_handoff: 2,
  delegated_complete: 3,
};

function sortSignals(list: CollabSignal[]): CollabSignal[] {
  return list.sort((x, y) => x.at - y.at || KIND_RANK[x.kind] - KIND_RANK[y.kind] || x.id.localeCompare(y.id));
}

/**
 * Collaboration facts derivable from a single state snapshot (oldest first). Parallel work
 * is a live condition, not history: see `parallelWork` and `diffSignals`.
 */
export function collabSignals(state: OfficeState): CollabSignal[] {
  const out: CollabSignal[] = [];
  for (const a of Object.values(state.agents)) {
    if (a.kind === 'session') continue;
    const rel = relationOf(state, a);
    if (!rel) continue;
    const kind: CollabSignalKind =
      rel.kind === 'delegation' ? 'delegation' : rel.kind === 'nested_delegation' ? 'nested_delegation' : rel.kind === 'teammate' ? 'teammate' : 'subagent_started';
    out.push({
      id: `${kind}:${a.key}:${rel.confidence}`,
      kind,
      from: rel.from,
      to: a.key,
      at: a.firstSeenAt,
      label: rel.confidence === 'inferred' ? `${SIGNAL_LABEL[kind]} (link inferred)` : SIGNAL_LABEL[kind],
      sessionId: a.sessionId,
      source: 'real',
      confidence: rel.confidence,
      note: rel.note,
      simulated: isSim(a.sessionId),
    });

    // SubagentStop sets `completed`; a session ending its children yields `ended`, which is not a completion.
    if (a.status === 'completed' && a.kind === 'subagent') {
      const fromHook = a.statusSource === 'hook';
      const confidence: Confidence = fromHook && rel.confidence === 'verified' ? 'verified' : 'inferred';
      const note = !fromHook ? 'Completion read from transcript metadata, not from a SubagentStop hook' : rel.confidence === 'inferred' ? rel.note : 'SubagentStop received';
      const at = a.endedAt ?? a.statusAt;
      out.push({
        // Not keyed on time: a duplicate SubagentStop must not count as a second completion.
        id: `delegated_complete:${a.key}:${confidence}`,
        kind: 'delegated_complete',
        from: a.key,
        to: rel.from,
        at,
        label: SIGNAL_LABEL.delegated_complete,
        sessionId: a.sessionId,
        source: 'real',
        confidence,
        note,
        simulated: isSim(a.sessionId),
      });
    }
  }

  for (const t of Object.values(state.tasks)) {
    if (t.status !== 'completed' || !t.createdBy || !t.completedBy || t.createdBy === t.completedBy) continue;
    if (!state.agents[t.createdBy] || !state.agents[t.completedBy]) continue;
    const subject = subjectOf(t);
    const at = t.completedAt ?? t.createdAt ?? 0;
    const sig: CollabSignal = {
      // Keyed on the task instance (createdAt resets only when the id is re-created).
      id: `task_handoff:${t.key}:${t.createdAt ?? 0}`,
      kind: 'task_handoff',
      from: t.createdBy,
      to: t.completedBy,
      at,
      label: SIGNAL_LABEL.task_handoff,
      taskKey: t.key,
      sessionId: t.sessionId,
      source: 'real',
      confidence: 'verified',
      note: 'TaskCreated and TaskCompleted were reported by different agents',
      simulated: isSim(t.sessionId),
    };
    if (subject) sig.subject = subject;
    out.push(sig);
  }
  return sortSignals(out);
}

/** Sessions where at least two agents are `working` right now (stale agents excluded). */
export function parallelWork(state: OfficeState): ParallelGroup[] {
  const bySession = new Map<string, Agent[]>();
  for (const a of Object.values(state.agents)) {
    if (a.status !== 'working' || a.stale) continue;
    const list = bySession.get(a.sessionId) ?? [];
    list.push(a);
    bySession.set(a.sessionId, list);
  }
  const out: ParallelGroup[] = [];
  for (const [sessionId, list] of bySession) {
    if (list.length < 2) continue;
    const keys = list.map((a) => a.key).sort();
    const g: ParallelGroup = { sessionId, keys, at: Math.max(...list.map((a) => a.statusAt)), simulated: isSim(sessionId) };
    if (state.agents[sessionId]) g.leadKey = sessionId;
    out.push(g);
  }
  return out.sort((x, y) => x.sessionId.localeCompare(y.sessionId));
}

/**
 * Signals that are new in `next` compared with `prev` (oldest first). Includes a
 * `parallel_work` signal when a session goes from fewer than two working agents to two or
 * more. With `prev` undefined every snapshot signal counts as new (parallel work too).
 * Applying it to consecutive states never yields the same signal id twice for one
 * continuous fact; use `CollabFeed` for a stream that also survives flapping evidence.
 */
export function diffSignals(prev: OfficeState | undefined, next: OfficeState): CollabSignal[] {
  const before = new Set(prev ? collabSignals(prev).map((s) => s.id) : []);
  const out = collabSignals(next).filter((s) => !before.has(s.id));
  const wasParallel = new Set(prev ? parallelWork(prev).map((g) => g.sessionId) : []);
  for (const g of parallelWork(next)) {
    if (wasParallel.has(g.sessionId)) continue;
    out.push({
      id: `parallel_work:${g.sessionId}:${g.at}`,
      kind: 'parallel_work',
      from: g.keys[0]!,
      to: g.keys[1]!,
      at: g.at,
      label: `${SIGNAL_LABEL.parallel_work}: ${g.keys.length} agents`,
      sessionId: g.sessionId,
      participants: g.keys,
      source: 'real',
      confidence: 'verified',
      note: 'Statuses reported by hooks or the session registry',
      simulated: g.simulated,
    });
  }
  return sortSignals(out);
}

/**
 * Stateful helper for a live stream: emits each signal id at most once, even if the
 * evidence disappears and comes back (e.g. pruning or a resync). Bounded memory.
 */
export class CollabFeed {
  private prev: OfficeState | undefined;
  private seen = new Set<string>();

  constructor(private readonly maxRemembered = 2000) {}

  /** New signals since the last call. The first call only primes the feed (returns []). */
  push(next: OfficeState): CollabSignal[] {
    const prime = this.prev === undefined;
    const fresh = diffSignals(this.prev, next).filter((s) => !this.seen.has(s.id));
    this.prev = next;
    for (const s of fresh) this.seen.add(s.id);
    if (this.seen.size > this.maxRemembered) {
      const drop = this.seen.size - this.maxRemembered;
      let i = 0;
      for (const id of this.seen) {
        if (i++ >= drop) break;
        this.seen.delete(id);
      }
    }
    return prime ? [] : fresh;
  }

  reset(): void {
    this.prev = undefined;
    this.seen.clear();
  }
}

/**
 * Transient scene effects for newly observed, verified events between two consecutive
 * states: 'delegate' (parent desk → child desk), 'handoff' (creator → completer),
 * 'complete' (child → parent). Inferred links never produce an effect. Returns [] without
 * `prev` (first snapshot: nothing happened "now"). With `now`, effects whose evidence is
 * older than `maxAgeMs` are skipped (e.g. after a resync snapshot).
 */
export function collabVisuals(
  prev: OfficeState | undefined,
  next: OfficeState,
  opts: { now?: number; maxAgeMs?: number } = {},
): CollabVisual[] {
  if (!prev) return [];
  const maxAge = opts.maxAgeMs ?? 15_000;
  const out: CollabVisual[] = [];
  for (const s of diffSignals(prev, next)) {
    if (s.confidence !== 'verified') continue;
    if (opts.now !== undefined && opts.now - s.at > maxAge) continue;
    if (!next.agents[s.from] || !next.agents[s.to]) continue;
    switch (s.kind) {
      case 'delegation':
      case 'nested_delegation':
        out.push({ id: s.id, kind: 'delegate', from: s.from, to: s.to, at: s.at, label: 'Delegated' });
        break;
      case 'task_handoff': {
        const v: CollabVisual = { id: s.id, kind: 'handoff', from: s.from, to: s.to, at: s.at, label: 'Task handoff' };
        const detail = safeText(s.subject, VISUAL_DETAIL_MAX);
        if (detail) v.detail = detail;
        out.push(v);
        break;
      }
      case 'delegated_complete':
        out.push({ id: s.id, kind: 'complete', from: s.from, to: s.to, at: s.at, label: 'Work completed' });
        break;
      default:
        break;
    }
  }
  return out;
}

function taskLink(t: Task, state: OfficeState): TaskLink {
  const createdBy = t.createdBy && state.agents[t.createdBy] ? t.createdBy : undefined;
  const completedBy = t.completedBy && state.agents[t.completedBy] ? t.completedBy : undefined;
  const link: TaskLink = {
    taskKey: t.key,
    taskId: t.taskId,
    status: t.status,
    orphaned: Boolean(t.orphaned),
    handoff: t.status === 'completed' && Boolean(createdBy && completedBy && createdBy !== completedBy),
  };
  const subject = subjectOf(t);
  if (subject) link.subject = subject;
  if (createdBy) link.createdBy = createdBy;
  if (completedBy) link.completedBy = completedBy;
  if (t.createdAt !== undefined) link.createdAt = t.createdAt;
  if (t.completedAt !== undefined) link.completedAt = t.completedAt;
  const tm = safeText(t.teammateName, 80);
  if (tm) link.teammateName = tm;
  return link;
}

/**
 * Display names that tell agents apart: `displayName` where it is unique, otherwise the type
 * (or teammate name) with a longer id, then an ordinal (by first sighting) as a last resort.
 * Several subagents of one type started together often share a short id prefix.
 */
export function uniqueNames(agents: readonly Agent[]): Record<string, string> {
  const base = new Map(agents.map((a) => [a.key, displayName(a)]));
  const count = new Map<string, number>();
  for (const n of base.values()) count.set(n, (count.get(n) ?? 0) + 1);
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const a of agents) {
    const n = base.get(a.key)!;
    if (count.get(n) === 1) {
      out[a.key] = n;
      used.add(n);
    }
  }
  const rest = agents.filter((a) => !(a.key in out)).sort((x, y) => x.firstSeenAt - y.firstSeenAt || x.key.localeCompare(y.key));
  for (const a of rest) {
    const id = (a.agentId ?? a.key).replace(/^agent-/, '');
    let n = a.kind === 'session' ? base.get(a.key)! : `${a.teammateName ?? a.agentType ?? a.kind} · ${id.slice(0, 16)}`;
    if (used.has(n)) {
      let i = 2;
      while (used.has(`${n} #${i}`)) i++;
      n = `${n} #${i}`;
    }
    used.add(n);
    out[a.key] = n;
  }
  return out;
}

/**
 * Per-session teams: the lead (session agent), every subagent/teammate (nested, depth
 * first), their relations and the session's task links. Sorted live first, then by most
 * recent activity.
 */
export function teams(state: OfficeState): Team[] {
  const sessions = new Map<string, Agent[]>();
  for (const a of Object.values(state.agents)) {
    const list = sessions.get(a.sessionId) ?? [];
    list.push(a);
    sessions.set(a.sessionId, list);
  }
  const tasksBySession = new Map<string, Task[]>();
  for (const t of Object.values(state.tasks)) {
    const list = tasksBySession.get(t.sessionId) ?? [];
    list.push(t);
    tasksBySession.set(t.sessionId, list);
  }
  const out: Team[] = [];
  for (const [sessionId, agents] of sessions) {
    const lead = agents.find((a) => a.kind === 'session');
    const others = agents.filter((a) => a.kind !== 'session').sort((x, y) => x.firstSeenAt - y.firstSeenAt || x.key.localeCompare(y.key));
    const relations: TeamRelation[] = [];
    const graphParent = new Map<string, string | undefined>();
    for (const a of others) {
      const rel = relationOf(state, a);
      if (rel) relations.push(rel);
      graphParent.set(a.key, rel?.from);
    }
    // Depth-first order; cycles and over-deep chains are cut (never expected from the reducer).
    const children = new Map<string | undefined, Agent[]>();
    for (const a of others) {
      const p = graphParent.get(a.key);
      const parentKnown = p !== undefined && (p === lead?.key || others.some((o) => o.key === p));
      const k = parentKnown ? p : undefined;
      const list = children.get(k) ?? [];
      list.push(a);
      children.set(k, list);
    }
    const members: TeamMember[] = [];
    const visited = new Set<string>();
    const walk = (parent: string | undefined, depth: number) => {
      for (const a of children.get(parent) ?? []) {
        if (visited.has(a.key) || depth > 12) continue;
        visited.add(a.key);
        const m: TeamMember = { key: a.key, agent: a, depth };
        if (parent !== undefined) m.parentKey = parent;
        members.push(m);
        walk(a.key, depth + 1);
      }
    };
    walk(lead?.key, 1);
    if (lead) walk(undefined, 1);
    for (const a of others) if (!visited.has(a.key)) members.push({ key: a.key, agent: a, depth: 1 });

    const tasks = (tasksBySession.get(sessionId) ?? [])
      .map((t) => taskLink(t, state))
      .sort((x, y) => (x.createdAt ?? x.completedAt ?? 0) - (y.createdAt ?? y.completedAt ?? 0) || x.taskKey.localeCompare(y.taskKey));
    const teamNames = [
      ...new Set(
        [...agents.map((a) => a.teamName), ...(tasksBySession.get(sessionId) ?? []).map((t) => t.teamName)]
          .map((n) => safeText(n, 80))
          .filter((n): n is string => Boolean(n)),
      ),
    ].sort();
    const team: Team = {
      sessionId,
      members,
      relations,
      tasks,
      working: agents.filter((a) => a.status === 'working' && !a.stale).map((a) => a.key).sort(),
      names: uniqueNames(agents),
      teamNames,
      partial: !lead || relations.some((r) => r.confidence === 'inferred'),
      active: agents.some((a) => !TERMINAL_STATUSES.has(a.status)),
      simulated: isSim(sessionId),
      lastActivityAt: Math.max(...agents.map((a) => a.lastEventAt)),
    };
    if (lead) {
      team.lead = lead;
      team.leadKey = lead.key;
    }
    out.push(team);
  }
  return out.sort((x, y) => Number(y.active) - Number(x.active) || y.lastActivityAt - x.lastActivityAt || x.sessionId.localeCompare(y.sessionId));
}

/** A team has something to show beyond a lone session. */
export function isCollaborative(t: Team): boolean {
  return t.members.length > 0 || t.tasks.some((l) => l.handoff);
}
