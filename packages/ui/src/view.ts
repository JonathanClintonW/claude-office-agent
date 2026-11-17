import {
  baseName,
  displayName,
  isSimulated,
  normalizePathKey,
  TERMINAL_STATUSES,
  workspaceOf,
  type Agent,
  type OfficeState,
} from '@agent-office/core';
import { failureKind, looksLikeTest } from './office/poses';
import type { WorkerView } from './office/scene';

export interface Filters {
  workspace: string; // 'all' or a workspace key
  showEnded: boolean;
}

export interface WorkspaceOption {
  key: string;
  label: string;
  count: number;
}

function rootSession(state: OfficeState, a: Agent): Agent {
  return state.agents[a.sessionId] ?? a;
}

/** Workspace key: the containing VS Code folder if known, else the session's cwd. */
export function workspaceKey(state: OfficeState, a: Agent, folders: readonly string[]): string | undefined {
  const root = rootSession(state, a);
  const cwd = root.cwd ?? a.cwd;
  if (!cwd) return undefined;
  const folder = workspaceOf({ ...root, cwd }, folders);
  return normalizePathKey(folder ?? cwd);
}

export function workspaceOptions(state: OfficeState, folders: readonly string[]): WorkspaceOption[] {
  const map = new Map<string, WorkspaceOption>();
  for (const a of Object.values(state.agents)) {
    if (a.kind !== 'session' || TERMINAL_STATUSES.has(a.status)) continue;
    const k = workspaceKey(state, a, folders);
    if (!k) continue;
    const opt = map.get(k) ?? { key: k, label: baseName(k), count: 0 };
    opt.count += 1;
    map.set(k, opt);
  }
  for (const f of folders) {
    const k = normalizePathKey(f);
    if (!map.has(k)) map.set(k, { key: k, label: baseName(f), count: 0 });
  }
  return [...map.values()].sort((x, y) => x.label.localeCompare(y.label));
}

export function filterAgents(state: OfficeState, filters: Filters, folders: readonly string[]): Agent[] {
  return Object.values(state.agents).filter((a) => {
    if (!filters.showEnded && TERMINAL_STATUSES.has(a.status) && !(a.endedAt && Date.now() - a.endedAt < 15_000)) return false;
    if (filters.workspace !== 'all' && workspaceKey(state, a, folders) !== filters.workspace) return false;
    return true;
  });
}

/** One view per agent key (one character per agent), in a stable order: first appearance, then key. */
export function toWorkerViews(agents: readonly Agent[]): WorkerView[] {
  const unique = new Map<string, Agent>();
  for (const a of agents) if (!unique.has(a.key)) unique.set(a.key, a);
  return [...unique.values()]
    .sort((x, y) => x.firstSeenAt - y.firstSeenAt || x.key.localeCompare(y.key))
    .map((a) => {
      const v: WorkerView = {
        key: a.key,
        name: displayName(a),
        status: a.status,
        stale: Boolean(a.stale),
        kind: a.kind,
        sessionId: a.sessionId,
        simulated: isSimulated(a),
      };
      if (a.parentKey) v.parentKey = a.parentKey;
      if (a.cwd) v.cwd = a.cwd;
      if (a.turnCompletedAt) v.turnCompletedAt = a.turnCompletedAt;
      if (TERMINAL_STATUSES.has(a.status)) v.terminalAt = a.endedAt ?? a.statusAt;
      if (a.agentType) v.agentType = a.agentType;
      if (a.statusDetail) v.statusDetail = a.statusDetail;
      const current = a.currentToolId ? a.tools.find((t) => t.id === a.currentToolId) : undefined;
      v.toolRunning = current?.status === 'running';
      if (current?.status === 'running') {
        v.toolName = current.name;
        v.toolSummary = current.summary;
      }
      const facts = toolFacts(a.tools);
      if (facts.last) v.lastToolEnd = { id: facts.last.id, ok: facts.last.status === 'succeeded' };
      if (facts.failure) v.failure = facts.failure;
      if (facts.failureOpen) v.failureOpen = true;
      if (facts.lastTestPassAt !== undefined) v.lastTestPassAt = facts.lastTestPassAt;
      if (facts.lastWorkMs !== undefined) v.lastWorkMs = facts.lastWorkMs;
      return v;
    });
}

/** Gap between tool calls that ends an observed "working stretch". */
export const WORK_STRETCH_GAP_MS = 2 * 60_000;

type Tool = Agent['tools'][number];

export interface ToolFacts {
  /** Most recently finished tool with a known outcome. */
  last?: Tool;
  /** Most recent failed tool call, classified by local rules (never by a model). */
  failure?: { kind: 'test' | 'build' | 'tool'; at: number };
  /** The most recently finished tool failed (nothing succeeded since). */
  failureOpen?: boolean;
  /** End of the most recent successful test-like command. */
  lastTestPassAt?: number;
  /**
   * Observed span of the latest cluster of tool calls (gaps under WORK_STRETCH_GAP_MS). A
   * lower bound: only the tools the reducer keeps are seen, and model time outside tools is not.
   */
  lastWorkMs?: number;
}

/** Facts derived only from observed tool calls (status, name, sanitized summary, timestamps). */
export function toolFacts(tools: readonly Tool[]): ToolFacts {
  const out: ToolFacts = {};
  let failed: Tool | undefined;
  const spans: Array<[number, number]> = [];
  for (const t of tools) {
    if (t.startedAt !== undefined) spans.push([t.startedAt, t.endedAt ?? t.startedAt]);
    if (t.endedAt === undefined || t.status === 'unknown' || t.status === 'running' || t.status === 'awaiting_permission') continue;
    if (!out.last || t.endedAt >= (out.last.endedAt ?? 0)) out.last = t;
    if (t.status === 'failed' && (!failed || t.endedAt >= (failed.endedAt ?? 0))) failed = t;
    if (t.status === 'succeeded' && looksLikeTest(t.summary) && t.endedAt > (out.lastTestPassAt ?? -Infinity)) out.lastTestPassAt = t.endedAt;
  }
  if (failed) {
    out.failure = { kind: failureKind(failed.name, failed.summary), at: failed.endedAt! };
    if (out.last === failed) out.failureOpen = true;
  }
  if (spans.length) {
    spans.sort((x, y) => y[1] - x[1]); // latest end first
    let [start, end] = spans[0]!;
    for (const [s, e] of spans.slice(1)) {
      if (e < start - WORK_STRETCH_GAP_MS) break;
      start = Math.min(start, s);
      end = Math.max(end, e);
    }
    if (end > start) out.lastWorkMs = end - start;
  }
  return out;
}
