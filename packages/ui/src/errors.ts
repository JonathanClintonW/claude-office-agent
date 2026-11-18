// Rule-based problem detection from the observed office state; nothing is inferred by a model.
// Heuristic rules carry a `heuristic` explanation that the UI shows.
import {
  baseName,
  formatDuration,
  isSimulated,
  normalizePathKey,
  TERMINAL_STATUSES,
  type Agent,
  type OfficeState,
  type ToolCall,
} from '@agent-office/core';

export type IssueCategory =
  | 'turn_failure'
  | 'tool_failure'
  | 'test_failure'
  | 'repeated_failure'
  | 'permission_blocked'
  | 'input_blocked'
  | 'denied'
  | 'interrupted'
  | 'stale'
  | 'disconnected'
  | 'unknown_status';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface Issue {
  /** Stable across renders while the underlying evidence is unchanged. */
  id: string;
  category: IssueCategory;
  severity: IssueSeverity;
  agentKey: string;
  sessionId: string;
  title: string;
  /** Short reason (first line of a reported error, a status detail…). */
  detail?: string;
  /** What the agent was doing (sanitized tool summary). */
  context?: string;
  /** Timestamp of the evidence. */
  at: number;
  /** A current condition (status, pending permission) rather than a past event. */
  ongoing: boolean;
  /** Set when the rule is a heuristic: explains what it is based on. */
  heuristic?: string;
  /** The event or data source behind the item. */
  evidence: string;
  toolName?: string;
  count?: number;
  projectKey?: string;
  projectLabel?: string;
  simulated: boolean;
}

export const SEVERITY_RANK: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };

export const CATEGORY_META: Record<IssueCategory, { label: string; description: string }> = {
  turn_failure: { label: 'Turn / API failure', description: 'A turn ended with an API error (StopFailure hook).' },
  tool_failure: { label: 'Tool failure', description: 'A tool execution failed (PostToolUseFailure hook).' },
  test_failure: { label: 'Likely test failure', description: 'A failed shell command that looks like a test run (heuristic).' },
  repeated_failure: { label: 'Repeated failure', description: 'The same tool call failed several times in a short window.' },
  permission_blocked: { label: 'Blocked on permission', description: 'Waiting for you to approve or deny a tool call.' },
  input_blocked: { label: 'Waiting for input', description: 'Waiting for your answer.' },
  denied: { label: 'Permission denied', description: 'A tool call was denied (PermissionDenied hook).' },
  interrupted: { label: 'Interrupted', description: 'A tool call was interrupted by the user.' },
  stale: { label: 'Quiet agent', description: 'No events for a while; the shown status may be outdated.' },
  disconnected: { label: 'Disconnected session', description: 'The process exited or left the session registry without SessionEnd.' },
  unknown_status: { label: 'Unknown status', description: 'There is no live evidence for the status, or a tool outcome was not observed.' },
};

export interface DetectOptions {
  /** Same tool + summary failing at least this many times… */
  repeatThreshold: number;
  /** …within this window counts as a repeated failure. */
  repeatWindowMs: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = { repeatThreshold: 3, repeatWindowMs: 10 * 60_000 };

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** Test runners and test scripts commonly invoked from a shell. */
export const TEST_COMMAND =
  /\b(?:vitest|jest|mocha|karma|ava|playwright\s+test|cypress\s+run|pytest|py\.test|nose2?|tox|nox|unittest|phpunit|pest|artisan\s+test|rspec|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|ctest|deno\s+test|bun\s+test|mix\s+test|swift\s+test|(?:mvnw?|gradlew?)\b[^|;&]*\btest|(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test(?::[\w:-]+)?)\b/i;
/** Tool descriptions such as "Run the unit tests". */
const TEST_DESCRIPTION = /\b(?:run|runs|running|rerun|re-run|execute)\b[^.\n]{0,40}\btests?\b/i;
/** Typical test-runner failure output in the (sanitized, truncated) error text. */
const TEST_OUTPUT = /\b\d+\s+(?:tests?\s+)?(?:failed|failing)\b|\bTests?:\s+\d+\s+failed|\bAssertionError\b/i;

/** Heuristic: a failed shell tool call that looks like a test run. */
export function looksLikeTestRun(t: Pick<ToolCall, 'name' | 'summary' | 'target' | 'error'>): boolean {
  if (!SHELL_TOOLS.has(t.name)) return false;
  const text = `${t.summary}\n${t.target ?? ''}`;
  return TEST_COMMAND.test(text) || TEST_DESCRIPTION.test(t.summary) || TEST_OUTPUT.test(t.error ?? '');
}

function firstLine(s: string | undefined, max = 200): string | undefined {
  if (!s) return undefined;
  const line = s.split(/\r?\n/).find((l) => l.trim())?.trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toolTime(t: ToolCall, fallback: number): number {
  return t.endedAt ?? t.startedAt ?? fallback;
}

function projectOf(state: OfficeState, a: Agent): { projectKey?: string; projectLabel?: string } {
  const cwd = state.agents[a.sessionId]?.cwd ?? a.cwd;
  return cwd ? { projectKey: normalizePathKey(cwd), projectLabel: baseName(cwd) } : {};
}

/** Failed, denied and interrupted tool calls of one agent, newest first. */
export function recentToolProblems(a: Agent, limit = 5): ToolCall[] {
  const out: ToolCall[] = [];
  for (let i = a.tools.length - 1; i >= 0 && out.length < limit; i--) {
    const t = a.tools[i]!;
    if (t.status === 'failed' || t.status === 'denied' || t.status === 'interrupted') out.push(t);
  }
  return out;
}

/** Largest number of timestamps inside any window of `windowMs`, and the last timestamp of that window. */
function densestWindow(times: number[], windowMs: number): { count: number; last: number } {
  const ts = [...times].sort((x, y) => x - y);
  let best = { count: 0, last: 0 };
  let lo = 0;
  for (let hi = 0; hi < ts.length; hi++) {
    while (ts[hi]! - ts[lo]! > windowMs) lo++;
    const count = hi - lo + 1;
    if (count >= best.count) best = { count, last: ts[hi]! };
  }
  return best;
}

/**
 * Detect problems from the observed state. Pure and deterministic for a given (state, now).
 * The result is sorted by severity, then recency.
 */
export function detectIssues(state: OfficeState, now: number, opts: DetectOptions = DEFAULT_DETECT_OPTIONS): Issue[] {
  const issues: Issue[] = [];

  for (const a of Object.values(state.agents)) {
    const base = { agentKey: a.key, sessionId: a.sessionId, simulated: isSimulated(a), ...projectOf(state, a) };
    const terminal = TERMINAL_STATUSES.has(a.status);

    const failuresByCall = new Map<string, { tool: ToolCall; times: number[] }>();
    const unknownTools: ToolCall[] = [];
    for (const t of a.tools) {
      const at = toolTime(t, a.lastEventAt);
      if (t.status === 'failed') {
        const test = looksLikeTestRun(t);
        issues.push({
          ...base,
          id: `tool:${a.key}:${t.id}`,
          category: test ? 'test_failure' : 'tool_failure',
          severity: 'error',
          title: test ? `Likely test failure (${t.name})` : `${t.name} failed`,
          detail: firstLine(t.error) ?? 'No error text reported',
          context: t.summary,
          at,
          ongoing: false,
          heuristic: test ? 'Heuristic: a failed shell command whose command, description or error looks like a test run.' : undefined,
          evidence: 'PostToolUseFailure hook',
          toolName: t.name,
        });
        const k = `${t.name}\u0000${t.summary}`;
        const g = failuresByCall.get(k) ?? { tool: t, times: [] };
        g.times.push(at);
        failuresByCall.set(k, g);
      } else if (t.status === 'denied') {
        issues.push({
          ...base,
          id: `tool:${a.key}:${t.id}`,
          category: 'denied',
          severity: 'warning',
          title: `${t.name} denied`,
          detail: firstLine(t.error) ?? 'No reason reported',
          context: t.summary,
          at,
          ongoing: false,
          evidence: 'PermissionDenied hook',
          toolName: t.name,
        });
      } else if (t.status === 'interrupted') {
        issues.push({
          ...base,
          id: `tool:${a.key}:${t.id}`,
          category: 'interrupted',
          severity: 'info',
          title: `${t.name} interrupted`,
          context: t.summary,
          at,
          ongoing: false,
          evidence: 'PostToolUseFailure hook (is_interrupt)',
          toolName: t.name,
        });
      } else if (t.status === 'unknown') {
        unknownTools.push(t);
      }
    }

    for (const [k, g] of failuresByCall) {
      const { count, last } = densestWindow(g.times, opts.repeatWindowMs);
      if (count < opts.repeatThreshold) continue;
      issues.push({
        ...base,
        id: `repeat:${a.key}:${k}`,
        category: 'repeated_failure',
        severity: 'error',
        title: `${g.tool.name} failed ${count}× within ${formatDuration(opts.repeatWindowMs)}`,
        detail: firstLine(g.tool.error),
        context: g.tool.summary,
        at: last,
        ongoing: false,
        evidence: 'PostToolUseFailure hooks',
        toolName: g.tool.name,
        count,
      });
    }

    if (unknownTools.length) {
      const latest = unknownTools.reduce((x, y) => (toolTime(y, 0) >= toolTime(x, 0) ? y : x));
      issues.push({
        ...base,
        id: `tool-unknown:${a.key}`,
        category: 'unknown_status',
        severity: 'info',
        title: unknownTools.length === 1 ? 'Tool outcome not observed' : `${unknownTools.length} tool outcomes not observed`,
        detail: latest.note ?? 'No completion event was received',
        context: latest.summary,
        at: toolTime(latest, a.lastEventAt),
        ongoing: false,
        evidence: 'Missing PostToolUse / PostToolUseFailure',
        toolName: latest.name,
        count: unknownTools.length,
      });
    }

    if (a.status === 'failed') {
      const notice = state.notices.find((n) => n.kind === 'stop_failure' && n.agentKey === a.key && n.ts === a.statusAt);
      if (!notice) {
        issues.push({
          ...base,
          id: `turn:${a.key}:${a.statusAt}`,
          category: 'turn_failure',
          severity: 'error',
          title: 'Turn failed',
          detail: a.statusDetail,
          at: a.statusAt || a.lastEventAt,
          ongoing: true,
          evidence: 'StopFailure hook',
        });
      }
    }
    if (!terminal && (a.status === 'waiting_permission' || a.pendingPermission)) {
      const p = a.pendingPermission;
      issues.push({
        ...base,
        id: `perm:${a.key}`,
        category: 'permission_blocked',
        severity: 'warning',
        title: p ? `Waiting for permission: ${p.toolName}` : 'Waiting for permission',
        detail: p ? undefined : a.statusDetail,
        context: p?.summary,
        at: p?.at ?? a.statusAt,
        ongoing: true,
        evidence: a.statusSource === 'registry' ? 'Session registry' : 'PermissionRequest / Notification hook',
      });
    } else if (a.status === 'waiting_input') {
      issues.push({
        ...base,
        id: `input:${a.key}`,
        category: 'input_blocked',
        severity: 'warning',
        title: 'Waiting for your input',
        detail: a.statusDetail,
        at: a.statusAt,
        ongoing: true,
        evidence: a.statusSource === 'registry' ? 'Session registry' : 'Notification hook',
      });
    }
    if (!terminal && a.stale) {
      issues.push({
        ...base,
        id: `stale:${a.key}`,
        category: 'stale',
        severity: 'warning',
        title: `Quiet for ${formatDuration(now - a.lastEventAt)}`,
        detail: `No events while ${a.status.replace('_', ' ')}; the status may be outdated (missed events, a long silent operation or a crashed process).`,
        at: a.lastEventAt,
        ongoing: true,
        heuristic: 'Heuristic: flagged after 5 minutes without events (20 minutes while a tool runs). The status itself is not changed.',
        evidence: 'Monitor tick',
      });
    }
    if (a.kind === 'session' && a.status === 'ended' && /^(Process exited|Left the session registry)/.test(a.endReason ?? '')) {
      const orphans = Object.values(state.agents).filter((c) => c.sessionId === a.sessionId && c.key !== a.key && /^Parent session ended/.test(c.endReason ?? '')).length;
      issues.push({
        ...base,
        id: `disc:${a.key}`,
        category: 'disconnected',
        severity: 'warning',
        title: 'Session disconnected',
        detail: `${a.endReason}${orphans ? ` · ${orphans} subagent${orphans > 1 ? 's' : ''} ended without a reported outcome` : ''}`,
        at: a.endedAt ?? a.statusAt,
        ongoing: false,
        evidence: 'Session registry / process liveness',
      });
    }
    if (a.status === 'unknown') {
      issues.push({
        ...base,
        id: `unknown:${a.key}`,
        category: 'unknown_status',
        severity: 'info',
        title: 'Status unknown',
        detail: `${a.statusDetail ?? 'No live data'}${a.lastKnownStatus ? ` · last known: ${a.lastKnownStatus.replace('_', ' ')}` : ''}`,
        at: a.statusAt || a.lastEventAt,
        ongoing: true,
        evidence: 'No status evidence',
      });
    }
  }

  // Turn failures recorded as notices: the history survives a later recovery.
  for (const n of state.notices) {
    if (n.kind !== 'stop_failure') continue;
    const a = state.agents[n.agentKey];
    if (!a) continue;
    issues.push({
      agentKey: a.key,
      sessionId: a.sessionId,
      simulated: isSimulated(a),
      ...projectOf(state, a),
      id: `turn:${n.id}`,
      category: 'turn_failure',
      severity: 'error',
      title: n.title,
      at: n.ts,
      ongoing: a.status === 'failed' && a.statusAt === n.ts,
      evidence: 'StopFailure hook',
    });
  }

  return sortIssues(issues);
}

export function sortIssues(issues: Issue[]): Issue[] {
  return issues.sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || y.at - x.at || x.id.localeCompare(y.id));
}

export interface IssueFilter {
  category: 'all' | IssueCategory;
  severity: 'all' | IssueSeverity;
  /** 'all' or a project key (normalized cwd). */
  project: string;
  ongoingOnly: boolean;
}

export const DEFAULT_ISSUE_FILTER: IssueFilter = { category: 'all', severity: 'all', project: 'all', ongoingOnly: false };

export function filterIssues(issues: readonly Issue[], f: IssueFilter): Issue[] {
  return issues.filter(
    (i) =>
      (f.category === 'all' || i.category === f.category) &&
      (f.severity === 'all' || i.severity === f.severity) &&
      (f.project === 'all' || i.projectKey === f.project) &&
      (!f.ongoingOnly || i.ongoing),
  );
}

export function countBy<K extends string>(issues: readonly Issue[], key: (i: Issue) => K): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const i of issues) {
    const k = key(i);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
