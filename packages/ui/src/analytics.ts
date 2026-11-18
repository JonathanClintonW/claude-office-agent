// Pure, rule-based metrics from journaled events and live state.
import {
  agentKeyFor,
  createInitialState,
  DEFAULT_REDUCER_OPTIONS,
  displayName,
  formatDuration,
  reduce,
  TERMINAL_STATUSES,
  type Agent,
  type AgentStatus,
  type MonitorEvent,
  type OfficeState,
  type ReducerOptions,
  type Task,
  type TokenCounts,
} from '@agent-office/core';

/**
 * Every metric is either
 * - `observed`: a count of events the monitor actually received, or
 * - `derived`: computed from observed timestamps (durations, rates, shares).
 * Nothing here is estimated, sampled or generated; summaries are fixed sentence templates.
 */
export type MetricKind = 'observed' | 'derived';

export interface MetricDefinition {
  label: string;
  kind: MetricKind;
  definition: string;
}

export const METRIC_DEFINITIONS = {
  sessionDuration: {
    label: 'Session duration',
    kind: 'derived',
    definition: 'Time between the first and the last journaled event of the session (for a live session: until now).',
  },
  tasksCompleted: { label: 'Tasks completed', kind: 'observed', definition: 'Distinct tasks with a TaskCompleted event.' },
  tasksLeftOpen: {
    label: 'Tasks left open',
    kind: 'observed',
    definition: 'Tasks still open when their session ended. Claude Code reports no task failure event, so these are not called failed.',
  },
  tasksOpen: { label: 'Tasks open', kind: 'observed', definition: 'Tasks created and not completed in a session that is still running.' },
  taskDuration: {
    label: 'Task duration',
    kind: 'derived',
    definition: 'TaskCompleted time minus TaskCreated time, for tasks where both events were observed.',
  },
  toolCalls: { label: 'Tool calls', kind: 'observed', definition: 'Distinct tool calls (by tool_use_id) seen in PreToolUse/PostToolUse/PostToolUseFailure/PermissionDenied.' },
  toolErrors: {
    label: 'Tool errors',
    kind: 'observed',
    definition: 'PostToolUseFailure events that were not user interrupts, plus PostToolUse events reporting success=false.',
  },
  toolInterrupts: { label: 'Interrupted tools', kind: 'observed', definition: 'PostToolUseFailure events flagged as user interrupts.' },
  toolDenied: { label: 'Denied tools', kind: 'observed', definition: 'PermissionDenied events.' },
  toolUnresolved: { label: 'Outcome not observed', kind: 'observed', definition: 'Tool calls with a start but no completion event.' },
  toolDuration: {
    label: 'Tool time',
    kind: 'derived',
    definition: 'duration_ms reported by Claude Code when present, otherwise completion time minus start time.',
  },
  failureRate: { label: 'Tool error rate', kind: 'derived', definition: 'Tool errors divided by tool calls with an observed outcome.' },
  turns: { label: 'Turns', kind: 'observed', definition: 'Stop events (turn completed).' },
  turnFailures: { label: 'Failed turns', kind: 'observed', definition: 'StopFailure events (the turn ended with an API error).' },
  prompts: { label: 'Prompts', kind: 'observed', definition: 'UserPromptSubmit events (the prompt text is never recorded).' },
  statusTime: {
    label: 'Time by status',
    kind: 'derived',
    definition:
      'Each agent\'s status after every event, replayed through the same reducer as the office. A status lasts until the next status change, or until the last event (now, for live sessions). Waiting = waiting for permission + waiting for input.',
  },
  agentTime: {
    label: 'Agent-time',
    kind: 'derived',
    definition: 'Status time summed over all agents of the session: two agents working in parallel for one minute count as two minutes.',
  },
  repeatedErrors: {
    label: 'Repeated errors',
    kind: 'derived',
    definition: 'Tool errors and failed turns grouped by tool name and first error line (numbers ignored); groups seen at least twice.',
  },
  activity: { label: 'Activity distribution', kind: 'derived', definition: 'Events, tool calls and errors per equal-width time bucket, and tool calls per tool and per agent.' },
} as const satisfies Record<string, MetricDefinition>;

export type MetricId = keyof typeof METRIC_DEFINITIONS;

export function tokensOf(c: TokenCounts): number {
  return c.inputTokens + c.outputTokens + c.cacheCreationTokens + c.cacheReadTokens;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 2 : 1)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(2)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

export function formatMoney(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) return '—';
  const digits = amount !== 0 && Math.abs(amount) < 1 ? 4 : 2;
  return `${currency} ${amount.toFixed(digits)}`;
}

export function percent(part: number, whole: number): string {
  if (!whole) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}

export interface StatusDurations {
  working: number;
  waitingPermission: number;
  waitingInput: number;
  idle: number;
  failed: number;
  unknown: number;
}

type StatusBucket = keyof StatusDurations;

const STATUS_BUCKET: Partial<Record<AgentStatus, StatusBucket>> = {
  working: 'working',
  waiting_permission: 'waitingPermission',
  waiting_input: 'waitingInput',
  idle: 'idle',
  failed: 'failed',
  unknown: 'unknown',
};

export function emptyDurations(): StatusDurations {
  return { working: 0, waitingPermission: 0, waitingInput: 0, idle: 0, failed: 0, unknown: 0 };
}

export function waitingOf(d: StatusDurations): number {
  return d.waitingPermission + d.waitingInput;
}

export function trackedOf(d: StatusDurations): number {
  return d.working + d.waitingPermission + d.waitingInput + d.idle + d.failed + d.unknown;
}

export interface DurationStats {
  count: number;
  totalMs: number;
  meanMs?: number;
  medianMs?: number;
  maxMs?: number;
}

export function durationStats(values: readonly number[]): DurationStats {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const totalMs = v.reduce((s, x) => s + x, 0);
  if (!v.length) return { count: 0, totalMs: 0 };
  const mid = Math.floor(v.length / 2);
  const medianMs = v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
  return { count: v.length, totalMs, meanMs: totalMs / v.length, medianMs, maxMs: v[v.length - 1]! };
}

export type TaskOutcome = 'completed' | 'open' | 'left_open';

export interface TaskMetric {
  key: string;
  taskId: string;
  subject?: string;
  status: TaskOutcome;
  createdAt?: number;
  completedAt?: number;
  durationMs?: number;
  agentKey?: string;
}

export type ToolOutcome = 'succeeded' | 'failed' | 'interrupted' | 'denied';

export interface ToolNameStats {
  name: string;
  calls: number;
  succeeded: number;
  failed: number;
  interrupted: number;
  denied: number;
  unresolved: number;
  /** Sum of known durations (reported or observed). */
  totalMs: number;
  timedCalls: number;
}

export interface AgentMetrics {
  key: string;
  name: string;
  kind: Agent['kind'];
  durations: StatusDurations;
  toolCalls: number;
  toolErrors: number;
}

export interface RepeatedError {
  signature: string;
  tool: string;
  /** First error line, shortened. */
  sample: string;
  count: number;
  firstTs: number;
  lastTs: number;
  agents: string[];
}

export interface ActivityBucket {
  start: number;
  end: number;
  events: number;
  toolCalls: number;
  errors: number;
}

export interface SessionMetrics {
  sessionId?: string;
  firstTs?: number;
  lastTs?: number;
  /** Until the last event, or `until` when given. */
  durationMs: number;
  ended: boolean;
  eventCount: number;
  tasks: { total: number; completed: number; open: number; leftOpen: number; durations: DurationStats; list: TaskMetric[] };
  tools: {
    calls: number;
    succeeded: number;
    errors: number;
    interrupted: number;
    denied: number;
    unresolved: number;
    permissionRequests: number;
    /** errors / calls with an observed outcome; undefined when no outcome was observed. */
    errorRate?: number;
    durations: DurationStats;
    byName: ToolNameStats[];
  };
  turns: { prompts: number; completed: number; failed: number };
  /** Main session agent. */
  main: StatusDurations;
  /** Sum over all agents (agent-time). */
  allAgents: StatusDurations;
  byAgent: AgentMetrics[];
  repeatedErrors: RepeatedError[];
  activity: {
    bucketMs: number;
    buckets: ActivityBucket[];
    byTool: Array<{ name: string; calls: number; share: number }>;
    byAgent: Array<{ key: string; name: string; calls: number; share: number }>;
  };
  summary: string;
}

export interface MetricsOptions {
  sessionId?: string;
  /** Extend open status intervals to this time (use `now` for live sessions). */
  until?: number;
  buckets?: number;
  reducer?: ReducerOptions;
}

interface ToolRec {
  name: string;
  agentKey: string;
  startTs?: number;
  outcome?: ToolOutcome;
  durationMs?: number;
}

export function normalizeError(error: string | undefined): string {
  if (!error) return '(no error text)';
  const first = error.split('\n').find((l) => l.trim()) ?? '';
  return first.trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 120) || '(no error text)';
}

function firstLine(error: string | undefined, max = 160): string {
  const l = (error ?? '').split('\n').find((x) => x.trim())?.trim() ?? '';
  return l.length > max ? `${l.slice(0, max - 1)}…` : l || '(no error text)';
}

const isOpen = (r: ToolRec) => r.outcome === undefined;

const METRICS_REDUCER_OPTIONS: ReducerOptions = { ...DEFAULT_REDUCER_OPTIONS, maxLog: 1, maxNotices: 1 };

/**
 * Metrics for one session from its journaled events (journal order = the monitor's apply order).
 * Status time is derived by replaying the events through the office reducer.
 */
export function computeSessionMetrics(events: readonly MonitorEvent[], opts: MetricsOptions = {}): SessionMetrics {
  // The reducer's log and notices are output only (never read back), so metrics skip copying them.
  const ro = opts.reducer ?? METRICS_REDUCER_OPTIONS;
  let state = createInitialState();
  let clock = Number.NEGATIVE_INFINITY;
  let firstTs: number | undefined;
  let lastTs: number | undefined;
  let eventCount = 0;
  const open = new Map<string, { status: AgentStatus; since: number }>();
  const dur = new Map<string, StatusDurations>();
  const tools = new Map<string, ToolRec>();
  const anon = new Map<string, string[]>();
  let anonSeq = 0;
  let permissionRequests = 0;
  const turns = { prompts: 0, completed: 0, failed: 0 };
  const errors = new Map<string, RepeatedError>();
  const stamps: Array<{ ts: number; tool: boolean; error: boolean }> = [];

  const addDur = (key: string, status: AgentStatus, ms: number) => {
    const b = STATUS_BUCKET[status];
    if (!b || ms <= 0) return;
    let d = dur.get(key);
    if (!d) dur.set(key, (d = emptyDurations()));
    d[b] += ms;
  };
  const noteError = (tool: string, error: string | undefined, ts: number, agentKey: string) => {
    const signature = `${tool}: ${normalizeError(error)}`;
    let g = errors.get(signature);
    if (!g) errors.set(signature, (g = { signature, tool, sample: firstLine(error), count: 0, firstTs: ts, lastTs: ts, agents: [] }));
    g.count += 1;
    g.firstTs = Math.min(g.firstTs, ts);
    g.lastTs = Math.max(g.lastTs, ts);
    if (!g.agents.includes(agentKey)) g.agents.push(agentKey);
  };
  const toolFor = (ev: MonitorEvent & { tool: { name: string; useId?: string } }, create: boolean): ToolRec | undefined => {
    const agentKey = agentKeyFor(ev.sessionId, ev.agentId);
    const anonKey = `${agentKey}|${ev.tool.name}`;
    if (ev.tool.useId) {
      const k = `${agentKey}|${ev.tool.useId}`;
      let r = tools.get(k);
      if (!r) {
        // A record opened without an id (e.g. an older PreToolUse) is upgraded by the first id seen.
        const stack = anon.get(anonKey);
        const prior = stack?.pop();
        r = prior ? tools.get(prior) : undefined;
        if (r && prior) tools.delete(prior);
        r ??= { name: ev.tool.name, agentKey };
        tools.set(k, r);
      }
      return r;
    }
    const stack = anon.get(anonKey) ?? [];
    anon.set(anonKey, stack);
    if (create) {
      const k = `${agentKey}|~${++anonSeq}`;
      const r: ToolRec = { name: ev.tool.name, agentKey };
      tools.set(k, r);
      stack.push(k);
      return r;
    }
    const k = stack.pop();
    if (k) return tools.get(k);
    const r: ToolRec = { name: ev.tool.name, agentKey };
    tools.set(`${agentKey}|~${++anonSeq}`, r);
    return r;
  };
  const finish = (r: ToolRec | undefined, outcome: ToolOutcome, ts: number, reported?: number) => {
    if (!r || !isOpen(r)) return; // real outcomes are final, like the reducer
    r.outcome = outcome;
    if (reported !== undefined) r.durationMs = reported;
    else if (r.startTs !== undefined && ts >= r.startTs) r.durationMs = ts - r.startTs;
  };

  for (const ev of events) {
    if (ev.kind === 'Tick') continue;
    if (opts.sessionId && ev.sessionId !== opts.sessionId && ev.sessionId !== '*') continue;
    const before = state.agents;
    state = reduce(state, ev, ro);
    clock = Math.max(clock, ev.ts);
    if (state.agents !== before) {
      for (const [k, a] of Object.entries(state.agents)) {
        if (before[k] === a) continue;
        const cur = open.get(k);
        if (!cur) open.set(k, { status: a.status, since: clock });
        else if (cur.status !== a.status) {
          addDur(k, cur.status, clock - cur.since);
          open.set(k, { status: a.status, since: clock });
        }
      }
    }
    if (ev.sessionId === '*') continue;
    eventCount += 1;
    firstTs = firstTs === undefined ? ev.ts : Math.min(firstTs, ev.ts);
    lastTs = lastTs === undefined ? ev.ts : Math.max(lastTs, ev.ts);
    const agentKey = agentKeyFor(ev.sessionId, ev.agentId);
    let stampTool = false;
    let stampError = false;
    switch (ev.kind) {
      case 'PreToolUse': {
        const r = toolFor(ev, true)!;
        if (r.startTs === undefined || ev.ts < r.startTs) r.startTs = ev.ts;
        stampTool = true;
        break;
      }
      case 'PostToolUse': {
        const r = toolFor(ev, false);
        finish(r, ev.success === false ? 'failed' : 'succeeded', ev.ts, ev.durationMs);
        if (ev.success === false) {
          noteError(ev.tool.name, undefined, ev.ts, agentKey);
          stampError = true;
        }
        break;
      }
      case 'PostToolUseFailure': {
        const r = toolFor(ev, false);
        finish(r, ev.isInterrupt ? 'interrupted' : 'failed', ev.ts, ev.durationMs);
        if (!ev.isInterrupt) {
          noteError(ev.tool.name, ev.error, ev.ts, agentKey);
          stampError = true;
        }
        break;
      }
      case 'PermissionDenied':
        finish(toolFor(ev, false), 'denied', ev.ts);
        break;
      case 'PermissionRequest':
        permissionRequests += 1;
        break;
      case 'UserPromptSubmit':
        turns.prompts += 1;
        break;
      case 'Stop':
        turns.completed += 1;
        break;
      case 'StopFailure':
        turns.failed += 1;
        noteError('Turn', ev.error, ev.ts, agentKey);
        stampError = true;
        break;
      default:
        break;
    }
    stamps.push({ ts: ev.ts, tool: stampTool, error: stampError });
  }

  const start = firstTs ?? 0;
  const lastEvent = Number.isFinite(clock) ? clock : start;
  const end = opts.until !== undefined ? Math.max(opts.until, lastEvent) : lastEvent;
  for (const [k, cur] of open) {
    if (!TERMINAL_STATUSES.has(cur.status)) addDur(k, cur.status, end - cur.since);
  }

  const sessionId = opts.sessionId ?? (firstTs !== undefined ? events.find((e) => e.sessionId !== '*')?.sessionId : undefined);
  const sessionAgent = sessionId ? state.agents[sessionId] : undefined;
  const ended = sessionAgent ? TERMINAL_STATUSES.has(sessionAgent.status) : false;

  // Tasks: final reducer state, the same semantics as the task board.
  const taskList: TaskMetric[] = Object.values(state.tasks)
    .filter((t) => !sessionId || t.sessionId === sessionId)
    .map((t) => taskMetric(t))
    .sort((x, y) => (x.createdAt ?? x.completedAt ?? 0) - (y.createdAt ?? y.completedAt ?? 0));
  const taskDurations = taskList.map((t) => t.durationMs).filter((d): d is number => d !== undefined);

  const byName = new Map<string, ToolNameStats>();
  const perAgent = new Map<string, { calls: number; errors: number }>();
  let succeeded = 0;
  let failed = 0;
  let interrupted = 0;
  let denied = 0;
  let unresolved = 0;
  const toolDurations: number[] = [];
  for (const r of tools.values()) {
    let s = byName.get(r.name);
    if (!s) byName.set(r.name, (s = { name: r.name, calls: 0, succeeded: 0, failed: 0, interrupted: 0, denied: 0, unresolved: 0, totalMs: 0, timedCalls: 0 }));
    s.calls += 1;
    const pa = perAgent.get(r.agentKey) ?? { calls: 0, errors: 0 };
    pa.calls += 1;
    perAgent.set(r.agentKey, pa);
    switch (r.outcome) {
      case 'succeeded':
        s.succeeded += 1;
        succeeded += 1;
        break;
      case 'failed':
        s.failed += 1;
        failed += 1;
        pa.errors += 1;
        break;
      case 'interrupted':
        s.interrupted += 1;
        interrupted += 1;
        break;
      case 'denied':
        s.denied += 1;
        denied += 1;
        break;
      default:
        s.unresolved += 1;
        unresolved += 1;
    }
    if (r.durationMs !== undefined) {
      s.totalMs += r.durationMs;
      s.timedCalls += 1;
      toolDurations.push(r.durationMs);
    }
  }
  const calls = tools.size;
  const resolved = calls - unresolved;

  const nameOf = (key: string) => {
    const a = state.agents[key];
    return a ? displayName(a) : key;
  };
  const byAgent: AgentMetrics[] = Object.values(state.agents)
    .filter((a) => !sessionId || a.sessionId === sessionId)
    .sort((x, y) => x.firstSeenAt - y.firstSeenAt || x.key.localeCompare(y.key))
    .map((a) => ({
      key: a.key,
      name: displayName(a),
      kind: a.kind,
      durations: dur.get(a.key) ?? emptyDurations(),
      toolCalls: perAgent.get(a.key)?.calls ?? 0,
      toolErrors: perAgent.get(a.key)?.errors ?? 0,
    }));
  const allAgents = emptyDurations();
  for (const a of byAgent) for (const k of Object.keys(allAgents) as StatusBucket[]) allAgents[k] += a.durations[k];
  const main = (sessionId && dur.get(agentKeyFor(sessionId))) || emptyDurations();

  const nBuckets = Math.max(1, Math.min(200, Math.floor(opts.buckets ?? 24)));
  const span = Math.max(0, end - start);
  const bucketMs = Math.max(1000, Math.ceil(span / nBuckets) || 1000);
  const buckets: ActivityBucket[] = [];
  for (let i = 0; i < nBuckets; i++) buckets.push({ start: start + i * bucketMs, end: start + (i + 1) * bucketMs, events: 0, toolCalls: 0, errors: 0 });
  for (const s of stamps) {
    const i = Math.min(nBuckets - 1, Math.max(0, Math.floor((s.ts - start) / bucketMs)));
    const b = buckets[i]!;
    b.events += 1;
    if (s.tool) b.toolCalls += 1;
    if (s.error) b.errors += 1;
  }
  const byTool = [...byName.values()]
    .sort((x, y) => y.calls - x.calls || x.name.localeCompare(y.name))
    .map((s) => ({ name: s.name, calls: s.calls, share: calls ? s.calls / calls : 0 }));
  const byAgentShare = [...perAgent.entries()]
    .sort((x, y) => y[1].calls - x[1].calls)
    .map(([key, v]) => ({ key, name: nameOf(key), calls: v.calls, share: calls ? v.calls / calls : 0 }));

  const repeatedErrors = [...errors.values()].filter((g) => g.count >= 2).sort((x, y) => y.count - x.count || x.firstTs - y.firstTs);

  const metrics: SessionMetrics = {
    durationMs: firstTs === undefined ? 0 : Math.max(0, end - start),
    ended,
    eventCount,
    tasks: {
      total: taskList.length,
      completed: taskList.filter((t) => t.status === 'completed').length,
      open: taskList.filter((t) => t.status === 'open').length,
      leftOpen: taskList.filter((t) => t.status === 'left_open').length,
      durations: durationStats(taskDurations),
      list: taskList,
    },
    tools: {
      calls,
      succeeded,
      errors: failed,
      interrupted,
      denied,
      unresolved,
      permissionRequests,
      durations: durationStats(toolDurations),
      byName: [...byName.values()].sort((x, y) => y.calls - x.calls || x.name.localeCompare(y.name)),
    },
    turns,
    main,
    allAgents,
    byAgent,
    repeatedErrors,
    activity: { bucketMs, buckets, byTool, byAgent: byAgentShare },
    summary: '',
  };
  if (resolved > 0) metrics.tools.errorRate = failed / resolved;
  if (sessionId) metrics.sessionId = sessionId;
  if (firstTs !== undefined) metrics.firstTs = firstTs;
  if (lastTs !== undefined) metrics.lastTs = lastTs;
  metrics.summary = summarize({
    tasksCompleted: metrics.tasks.completed,
    tasksLeftOpen: metrics.tasks.leftOpen,
    tasksOpen: metrics.tasks.open,
    toolCalls: calls,
    toolErrors: failed,
    repeatedErrorGroups: repeatedErrors.filter((g) => g.tool !== 'Turn').length,
    turnFailures: turns.failed,
    durationMs: metrics.durationMs,
    main: firstTs === undefined ? undefined : main,
  });
  return metrics;
}

function taskMetric(t: Task): TaskMetric {
  const status: TaskOutcome = t.status === 'completed' ? 'completed' : t.orphaned ? 'left_open' : 'open';
  const m: TaskMetric = { key: t.key, taskId: t.taskId, status };
  if (t.subject) m.subject = t.subject;
  if (t.createdAt !== undefined) m.createdAt = t.createdAt;
  if (t.completedAt !== undefined) m.completedAt = t.completedAt;
  if (status === 'completed' && t.createdAt !== undefined && t.completedAt !== undefined && t.completedAt >= t.createdAt) m.durationMs = t.completedAt - t.createdAt;
  const by = t.completedBy ?? t.createdBy;
  if (by) m.agentKey = by;
  return m;
}

export interface SummaryInput {
  tasksCompleted: number;
  tasksLeftOpen: number;
  tasksOpen: number;
  toolCalls: number;
  toolErrors: number;
  repeatedErrorGroups?: number;
  turnFailures: number;
  durationMs?: number;
  main?: StatusDurations;
  /** Noun for toolErrors (default "tool error"). */
  errorNoun?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Rule-based sentence, e.g. "3 tasks completed, 1 left open, 5 tool errors (2 repeated), 1 failed turn." */
export function summarize(m: SummaryInput): string {
  const parts: string[] = [];
  // The first task clause names the noun ("3 tasks completed"); later ones only the count ("1 left open").
  const task = (n: number, what: string) => parts.push(parts.length ? `${n} ${what}` : `${plural(n, 'task')} ${what}`);
  if (m.tasksCompleted) task(m.tasksCompleted, 'completed');
  if (m.tasksLeftOpen) task(m.tasksLeftOpen, 'left open');
  if (m.tasksOpen) task(m.tasksOpen, 'still open');
  const noun = m.errorNoun ?? 'tool error';
  if (m.toolErrors) parts.push(`${plural(m.toolErrors, noun)}${m.repeatedErrorGroups ? ` (${m.repeatedErrorGroups} repeated)` : ''}`);
  else if (m.toolCalls) parts.push(`${plural(m.toolCalls, 'tool call')}, no ${noun}s`);
  if (m.turnFailures) parts.push(plural(m.turnFailures, 'failed turn'));
  let text = parts.length ? `${parts.join(', ')}.` : 'No tasks or tool activity recorded.';
  if (m.main && m.durationMs && m.durationMs > 0) {
    const segs: string[] = [];
    if (m.main.working) segs.push(`working ${formatDuration(m.main.working)}`);
    const waiting = waitingOf(m.main);
    if (waiting) segs.push(`waiting ${formatDuration(waiting)}`);
    if (m.main.idle) segs.push(`idle ${formatDuration(m.main.idle)}`);
    if (segs.length) text += ` Main agent ${segs.join(', ')} over ${formatDuration(m.durationMs)}.`;
  }
  return text;
}

export interface StateMetrics {
  sessions: { total: number; live: number; ended: number };
  agents: { total: number; working: number; waiting: number; idle: number; failed: number; unknown: number; finished: number };
  /** Sums of the reducer's per-agent counters (observed). */
  toolCalls: number;
  /** PostToolUseFailure events, interrupts included (the reducer's failure counter). */
  toolFailures: number;
  permissionRequests: number;
  turns: number;
  tasks: { total: number; completed: number; open: number; leftOpen: number; durations: DurationStats };
  summary: string;
}

/** Metrics from the current office state only (no journal needed). */
export function stateMetrics(state: OfficeState, filter?: (a: Agent) => boolean): StateMetrics {
  const agents = Object.values(state.agents).filter((a) => !a.sessionId.startsWith('sim-') && (!filter || filter(a)));
  const sessionIds = new Set(agents.filter((a) => a.kind === 'session').map((a) => a.sessionId));
  const m: StateMetrics = {
    sessions: { total: 0, live: 0, ended: 0 },
    agents: { total: agents.length, working: 0, waiting: 0, idle: 0, failed: 0, unknown: 0, finished: 0 },
    toolCalls: 0,
    toolFailures: 0,
    permissionRequests: 0,
    turns: 0,
    tasks: { total: 0, completed: 0, open: 0, leftOpen: 0, durations: { count: 0, totalMs: 0 } },
    summary: '',
  };
  for (const a of agents) {
    if (a.kind === 'session') {
      m.sessions.total += 1;
      if (TERMINAL_STATUSES.has(a.status)) m.sessions.ended += 1;
      else m.sessions.live += 1;
    }
    if (a.status === 'working') m.agents.working += 1;
    else if (a.status === 'waiting_permission' || a.status === 'waiting_input') m.agents.waiting += 1;
    else if (a.status === 'idle') m.agents.idle += 1;
    else if (a.status === 'failed') m.agents.failed += 1;
    else if (a.status === 'unknown') m.agents.unknown += 1;
    else m.agents.finished += 1;
    m.toolCalls += a.counts.tools;
    m.toolFailures += a.counts.failures;
    m.permissionRequests += a.counts.permissions;
    m.turns += a.counts.turns;
  }
  const tasks = Object.values(state.tasks).filter((t) => sessionIds.has(t.sessionId)).map(taskMetric);
  m.tasks.total = tasks.length;
  m.tasks.completed = tasks.filter((t) => t.status === 'completed').length;
  m.tasks.open = tasks.filter((t) => t.status === 'open').length;
  m.tasks.leftOpen = tasks.filter((t) => t.status === 'left_open').length;
  m.tasks.durations = durationStats(tasks.map((t) => t.durationMs).filter((d): d is number => d !== undefined));
  m.summary = summarize({
    tasksCompleted: m.tasks.completed,
    tasksLeftOpen: m.tasks.leftOpen,
    tasksOpen: m.tasks.open,
    toolCalls: m.toolCalls,
    toolErrors: m.toolFailures,
    turnFailures: 0,
    errorNoun: 'tool failure',
  });
  if (m.agents.failed) m.summary += ` ${plural(m.agents.failed, 'agent')} currently in a failed turn.`;
  return m;
}
