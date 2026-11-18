import { baseName, isPathInside } from './paths';
import type { Agent, AgentStatus, LogEntry, OfficeState, Task } from './state';
import { TERMINAL_STATUSES } from './state';

export const STATUS_META: Record<AgentStatus, { label: string; color: string; description: string }> = {
  working: { label: 'Working', color: '#4fc3f7', description: 'Running tools or thinking' },
  waiting_permission: { label: 'Needs permission', color: '#ffb74d', description: 'Blocked on a permission prompt' },
  waiting_input: { label: 'Needs input', color: '#ffd54f', description: 'Waiting for your answer' },
  idle: { label: 'Idle', color: '#a5d6a7', description: 'Turn finished, waiting for a prompt' },
  completed: { label: 'Completed', color: '#81c784', description: 'Subagent finished' },
  failed: { label: 'Failed', color: '#e57373', description: 'Turn ended with an error' },
  ended: { label: 'Ended', color: '#90a4ae', description: 'Session ended or process exited' },
  unknown: { label: 'Unknown', color: '#b0bec5', description: 'No live data to determine status' },
};

export function shortId(id: string): string {
  return id.replace(/^agent-/, '').slice(0, 6);
}

export function isSimulated(a: Pick<Agent, 'sessionId'>): boolean {
  return a.sessionId.startsWith('sim-');
}

export function displayName(a: Agent): string {
  if (a.kind === 'session') {
    if (a.title) return a.title;
    if (a.registryName) return a.registryName;
    // A split-pane agent-team teammate runs as its own session.
    if (a.teammateName) return `${a.teammateName} · ${shortId(a.sessionId)}`;
    if (a.cwd) return `${baseName(a.cwd)} · ${shortId(a.sessionId)}`;
    return `Session ${shortId(a.sessionId)}`;
  }
  if (a.teammateName) return a.teammateName;
  const type = a.agentType ?? (a.kind === 'teammate' ? 'teammate' : 'subagent');
  return `${type} · ${shortId(a.agentId ?? a.key)}`;
}

const byAppearance = (x: Agent, y: Agent) => x.firstSeenAt - y.firstSeenAt || x.key.localeCompare(y.key);

export function childrenOf(state: OfficeState, key: string): Agent[] {
  return Object.values(state.agents)
    .filter((a) => a.parentKey === key && a.key !== key)
    .sort(byAppearance);
}

/** How an agent's parent link was established, in plain words. Undefined for sessions. */
export function describeParentLink(a: Agent): string | undefined {
  if (a.kind === 'session') return undefined;
  switch (a.parentVia) {
    case 'spawn-tool':
      return a.spawnToolUseId
        ? 'Spawned by an Agent/Task tool call of this agent'
        : 'Spawned by an Agent/Task tool call of this agent (matched by type and timing; the exact call is not known)';
    case 'session':
      return a.spawnAmbiguous
        ? 'Start observed; several agents were spawning at the time, so the spawner was not determined'
        : 'Start observed in this session; the spawning tool call was not observed';
    case 'transcript':
      return 'Found in transcript metadata; the spawning agent was not observed';
    case 'implicit':
      return 'Seen in this session without an observed start; parent assumed to be the session';
    default:
      return a.kind === 'teammate' ? 'Reported by agent-team hook events in this session' : undefined;
  }
}

function priority(a: Agent): number {
  if (a.status === 'waiting_permission' || a.status === 'waiting_input' || a.status === 'failed') return 0;
  if (TERMINAL_STATUSES.has(a.status)) return 2;
  return 1;
}

export interface TreeNode {
  agent: Agent;
  children: TreeNode[];
}

/** Root agents with their nested subagents and teammates; every agent appears exactly once. */
export function agentTree(state: OfficeState, filter?: (a: Agent) => boolean): TreeNode[] {
  const all = Object.values(state.agents).filter((a) => !filter || filter(a));
  const byParent = new Map<string, Agent[]>();
  for (const a of all) {
    if (!a.parentKey) continue;
    const list = byParent.get(a.parentKey) ?? [];
    list.push(a);
    byParent.set(a.parentKey, list);
  }
  const seen = new Set<string>();
  const build = (a: Agent, depth: number): TreeNode => {
    seen.add(a.key);
    const kids = depth > 8 ? [] : (byParent.get(a.key) ?? []).filter((c) => !seen.has(c.key)).sort(byAppearance);
    return { agent: a, children: kids.map((c) => build(c, depth + 1)) };
  };
  const present = new Set(all.map((a) => a.key));
  const roots = all.filter((a) => !a.parentKey || !present.has(a.parentKey));
  // Stable order (rows must not jump while you click): attention first, then by first appearance.
  const tree = roots.sort((x, y) => priority(x) - priority(y) || byAppearance(x, y)).map((a) => build(a, 0));
  // Every agent is listed exactly once, even with a malformed (cyclic or very deep) parent chain.
  const rest = all.filter((a) => !seen.has(a.key)).sort(byAppearance);
  for (const a of rest) if (!seen.has(a.key)) tree.push(build(a, 0));
  return tree;
}

export function statusCounts(agents: Iterable<Agent>): Record<AgentStatus, number> {
  const out = Object.fromEntries(Object.keys(STATUS_META).map((k) => [k, 0])) as Record<AgentStatus, number>;
  for (const a of agents) out[a.status] += 1;
  return out;
}

export function agentLog(state: OfficeState, key: string, limit = 200): LogEntry[] {
  const out: LogEntry[] = [];
  for (let i = state.log.length - 1; i >= 0 && out.length < limit; i--) {
    const e = state.log[i]!;
    if (e.agentKey === key) out.push(e);
  }
  return out.reverse();
}

export function agentTasks(state: OfficeState, a: Agent): Task[] {
  return Object.values(state.tasks).filter(
    (t) =>
      t.createdBy === a.key ||
      t.completedBy === a.key ||
      (a.teammateName !== undefined && t.teammateName === a.teammateName && t.sessionId === a.sessionId),
  );
}

export function isActive(a: Agent): boolean {
  return !TERMINAL_STATUSES.has(a.status);
}

/** The VS Code workspace folder containing the agent's cwd, if any. */
export function workspaceOf(a: Agent, folders: readonly string[]): string | undefined {
  if (!a.cwd) return undefined;
  let best: string | undefined;
  for (const f of folders) if (isPathInside(a.cwd, f) && (!best || f.length > best.length)) best = f;
  return best;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
