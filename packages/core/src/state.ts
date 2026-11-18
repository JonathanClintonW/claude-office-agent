import type { EventOf, MonitorEvent, Source, TokenUsage, ToolRef } from './events';

/**
 * Agent status. Every value is derived from an observed event; when evidence is
 * missing the status is `unknown`, never a guess.
 */
export type AgentStatus =
  | 'working'
  | 'waiting_permission'
  | 'waiting_input'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'ended'
  | 'unknown';

export const TERMINAL_STATUSES: ReadonlySet<AgentStatus> = new Set(['completed', 'ended']);
export const WAITING_STATUSES: ReadonlySet<AgentStatus> = new Set(['waiting_permission', 'waiting_input']);

export type AgentKind = 'session' | 'subagent' | 'teammate';

export type ToolStatus = 'running' | 'awaiting_permission' | 'succeeded' | 'failed' | 'denied' | 'interrupted' | 'unknown';

export interface ToolCall {
  /** tool_use_id when Claude Code supplies one, otherwise a synthetic id. */
  id: string;
  hasRealId: boolean;
  name: string;
  summary: string;
  target?: string;
  mcpServer?: string;
  status: ToolStatus;
  startedAt?: number;
  endedAt?: number;
  /** Reported by Claude Code (duration_ms) or computed from observed start/end. */
  durationMs?: number;
  durationSource?: 'reported' | 'observed';
  error?: string;
  /** Explanation for `unknown` outcomes. */
  note?: string;
}

export interface Agent {
  key: string;
  sessionId: string;
  agentId?: string;
  kind: AgentKind;
  parentKey?: string;
  /**
   * How the parent link was established:
   * - `spawn-tool`: matched to the Agent/Task tool call that spawned it (by subagent type and
   *   timing, or exactly by tool_use_id from transcript metadata);
   * - `session`: its SubagentStart was observed, but the spawning call was not (or not uniquely);
   * - `transcript`: discovered from transcript metadata only;
   * - `implicit`: seen in the session's events before (or without) any SubagentStart.
   */
  parentVia?: 'session' | 'spawn-tool' | 'transcript' | 'implicit';
  /** tool_use_id of the spawning Agent/Task call; only set when the match is unambiguous. */
  spawnToolUseId?: string;
  /** Several pending spawning calls (from different agents) could have started this agent; the spawner is undetermined. */
  spawnAmbiguous?: boolean;
  agentType?: string;
  teammateName?: string;
  teamName?: string;
  title?: string;
  registryName?: string;
  description?: string;
  cwd?: string;
  transcriptPath?: string;
  permissionMode?: string;
  model?: string;
  entrypoint?: string;
  version?: string;
  pid?: number;

  status: AgentStatus;
  /** Timestamp of the evidence behind `status`. Older events never override it. */
  statusAt: number;
  statusSource: Source;
  statusDetail?: string;
  /** Set when status is `unknown` but an earlier status is known. */
  lastKnownStatus?: AgentStatus;

  firstSeenAt: number;
  lastEventAt: number;
  endedAt?: number;
  endReason?: string;
  /** Set by Tick when no event has been seen for a while. Cleared by any event. */
  stale?: boolean;

  currentToolId?: string;
  tools: ToolCall[];
  pendingPermission?: { toolName: string; summary: string; at: number };
  lastMessage?: string;
  backgroundRunning?: number;
  turnCompletedAt?: number;
  usage?: TokenUsage;
  usageSource?: Source;
  transcriptLastActivityAt?: number;
  sources: Source[];
  counts: { tools: number; failures: number; permissions: number; turns: number };
  toolSeq: number;
}

export type TaskStatus = 'open' | 'completed';

export interface Task {
  key: string;
  taskId: string;
  sessionId: string;
  subject?: string;
  description?: string;
  teammateName?: string;
  teamName?: string;
  status: TaskStatus;
  createdAt?: number;
  completedAt?: number;
  createdBy?: string;
  completedBy?: string;
  /** True if the session ended while the task was still open. */
  orphaned?: boolean;
}

export type Severity = 'info' | 'warning' | 'error';
export type NoticeKind = 'permission' | 'tool_failure' | 'stop_failure' | 'input_needed' | 'notification' | 'session' | 'task';

export interface Notice {
  id: string;
  ts: number;
  severity: Severity;
  kind: NoticeKind;
  agentKey: string;
  sessionId: string;
  title: string;
  message?: string;
}

export interface LogEntry {
  seq: number;
  ts: number;
  agentKey: string;
  kind: string;
  source: Source;
  text: string;
}

interface PendingSpawn {
  byKey: string;
  toolUseId?: string;
  subagentType?: string;
  ts: number;
  /** When the spawning call finished (PostToolUse / PostToolUseFailure); its subagent started before that. */
  closedAt?: number;
  /**
   * A compatible sibling spawn was consumed by a SubagentStart that may have been this call's:
   * `id` = the sibling had the same spawner (the parent is still known, the tool_use_id is not);
   * `parent` = the sibling had a different spawner (neither is known).
   */
  ambiguous?: 'id' | 'parent';
}

interface SpawnMatch {
  spawn: PendingSpawn;
  parentCertain: boolean;
  idCertain: boolean;
}

export interface OfficeState {
  version: 1;
  agents: Record<string, Agent>;
  tasks: Record<string, Task>;
  notices: Notice[];
  log: LogEntry[];
  /** Agent/Task tool calls not yet matched to a SubagentStart, per session. */
  spawns: Record<string, PendingSpawn[]>;
  lastSeq: number;
  lastEventAt?: number;
  lastHookEventAt?: number;
}

export interface ReducerOptions {
  maxToolsPerAgent: number;
  maxLog: number;
  maxNotices: number;
  /** Flag an agent stale after this long without events (no tool running). */
  staleAfterMs: number;
  /** Flag a running tool stale after this long. */
  staleToolAfterMs: number;
  /** Remove ended/completed agents after this long. */
  pruneAfterMs: number;
  maxAgents: number;
  /** Upper bound on tasks kept while sessions are alive (oldest finished tasks are dropped first). */
  maxTasks: number;
}

export const DEFAULT_REDUCER_OPTIONS: ReducerOptions = {
  maxToolsPerAgent: 60,
  maxLog: 1500,
  maxNotices: 200,
  staleAfterMs: 5 * 60_000,
  staleToolAfterMs: 20 * 60_000,
  pruneAfterMs: 6 * 3600_000,
  maxAgents: 400,
  maxTasks: 500,
};

export function createInitialState(): OfficeState {
  return { version: 1, agents: {}, tasks: {}, notices: [], log: [], spawns: {}, lastSeq: 0 };
}

export function agentKeyFor(sessionId: string, agentId?: string): string {
  return agentId ? `${sessionId}::${agentId}` : sessionId;
}

export function taskKeyFor(sessionId: string, taskId: string): string {
  return `${sessionId}#${taskId}`;
}

const SPAWN_TOOLS = new Set(['Agent', 'Task']);

/** Hooks run asynchronously in separate processes: capture times of related events may be this far out of order. */
const SPAWN_JITTER_MS = 2_000;
/** A SubagentStart may happen this long after its spawning call returned (background launches). */
const SPAWN_CLOSED_MATCH_MS = 5_000;
/** A finished spawning call is kept this long for a SubagentStart that is delivered late, then dropped. */
const SPAWN_CLOSED_RETAIN_MS = 60_000;
/** A spawning call never matches a SubagentStart that happened this much later. */
const SPAWN_MAX_AGE_MS = 30 * 60_000;
/** A spawning call delivered after its SubagentStart is linked back to agents started within this window. */
const LATE_SPAWN_WINDOW_MS = 60_000;
const MAX_PENDING_SPAWNS = 20;

/** End reason given to children when their session ends without reporting their outcome. */
export const PARENT_ENDED_REASON = 'Parent session ended (outcome not reported)';

function spawnTypeFits(spawnType: string | undefined, agentType: string | undefined): boolean {
  return spawnType === undefined || agentType === undefined || spawnType.toLowerCase() === agentType.toLowerCase();
}

/** Key suffix used for a teammate reported only by name (TeammateIdle without agent_id). */
export function teammateIdFor(name: string): string {
  return `teammate:${name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unnamed'}`;
}

/**
 * Team names are derived from the lead's session id (`session-` + its first 8 characters).
 * True when the event's team belongs to another session, i.e. it fired in a split-pane
 * teammate that runs as its own Claude Code session.
 */
function isOtherSessionsTeam(sessionId: string, teamName: string | undefined): boolean {
  const m = /^session-([A-Za-z0-9]{8})$/.exec(teamName ?? '');
  return Boolean(m && !sessionId.toLowerCase().startsWith(m[1]!.toLowerCase()));
}
const QUESTION_TOOLS: Record<string, string> = {
  AskUserQuestion: 'Asking you a question',
  ExitPlanMode: 'Waiting for plan approval',
};

class Ctx {
  agents: Record<string, Agent>;
  tasks: Record<string, Task>;
  notices: Notice[];
  log: LogEntry[];
  spawns: Record<string, PendingSpawn[]>;
  private edited = new Set<string>();
  private tasksCopied = false;
  private spawnsCopied = false;
  private agentsCopied = false;
  private logCopied = false;
  private noticesCopied = false;
  private noticeCounter = 0;

  constructor(
    readonly state: OfficeState,
    readonly ev: MonitorEvent,
    readonly o: ReducerOptions,
  ) {
    // Copy-on-write: most events touch one or two agents, so tables are copied on first write, not per event.
    this.agents = state.agents;
    this.tasks = state.tasks;
    this.notices = state.notices;
    this.log = state.log;
    this.spawns = state.spawns;
  }

  get(key: string): Agent | undefined {
    return this.agents[key];
  }

  edit(key: string): Agent {
    const a = this.agents[key];
    if (!a) throw new Error(`agent ${key} missing`);
    if (this.edited.has(key)) return a;
    const copy: Agent = { ...a, tools: [...a.tools], counts: { ...a.counts }, sources: [...a.sources] };
    this.ownAgents();
    this.agents[key] = copy;
    this.edited.add(key);
    return copy;
  }

  private create(key: string, init: Pick<Agent, 'sessionId' | 'kind'> & Partial<Agent>): Agent {
    const ev = this.ev;
    const a: Agent = {
      key,
      status: 'unknown',
      statusAt: 0,
      statusSource: ev.source,
      firstSeenAt: ev.ts,
      lastEventAt: ev.ts,
      tools: [],
      sources: [],
      counts: { tools: 0, failures: 0, permissions: 0, turns: 0 },
      toolSeq: 0,
      ...init,
    };
    this.ownAgents();
    this.agents[key] = a;
    this.edited.add(key);
    return a;
  }

  private ownAgents(): void {
    if (!this.agentsCopied) {
      this.agents = { ...this.agents };
      this.agentsCopied = true;
    }
  }

  removeAgent(key: string): void {
    this.ownAgents();
    delete this.agents[key];
  }

  ensureSession(): Agent {
    const ev = this.ev;
    const key = agentKeyFor(ev.sessionId);
    const existing = this.agents[key];
    const a = existing ? this.edit(key) : this.create(key, { sessionId: ev.sessionId, kind: 'session' });
    // A subagent may work in another directory (e.g. a worktree): only main-agent events move the session.
    if (ev.cwd && (!ev.agentId || !a.cwd)) a.cwd = ev.cwd;
    if (ev.transcriptPath) a.transcriptPath = ev.transcriptPath;
    if (ev.permissionMode && !ev.agentId) a.permissionMode = ev.permissionMode;
    // agent_type on a main-session event means `claude --agent <type>`.
    if (ev.agentType && !ev.agentId && ev.source === 'hook') a.agentType = ev.agentType;
    return a;
  }

  /**
   * Key of a subagent in a session. Hook payloads and transcript file names may spell the same id
   * with or without an `agent-` prefix (`agent-<id>.jsonl`); an existing agent under either spelling
   * is reused so one agent never becomes two characters.
   */
  subagentKey(sessionId: string, agentId: string): string {
    const key = agentKeyFor(sessionId, agentId);
    if (this.agents[key]) return key;
    const alt = agentId.startsWith('agent-') ? agentId.slice('agent-'.length) : `agent-${agentId}`;
    if (alt.length && this.agents[agentKeyFor(sessionId, alt)]) return agentKeyFor(sessionId, alt);
    return key;
  }

  ensureSubagent(agentId: string, via: Agent['parentVia'] = 'implicit'): Agent {
    const ev = this.ev;
    const session = this.ensureSession();
    const key = this.subagentKey(ev.sessionId, agentId);
    const existing = this.agents[key];
    const a = existing
      ? this.edit(key)
      : this.create(key, {
          sessionId: ev.sessionId,
          agentId,
          kind: 'subagent',
          parentKey: session.key,
          parentVia: via,
          cwd: ev.cwd ?? session.cwd,
        });
    // Identity fields only come from events that fired in this agent.
    const own = ev.agentId === agentId;
    if (ev.agentType && own) a.agentType = ev.agentType;
    if (ev.cwd && (own || !a.cwd)) a.cwd = ev.cwd;
    if (ev.permissionMode && own) a.permissionMode = ev.permissionMode;
    return a;
  }

  /** A non-session agent of the session known by its teammate name (real agent ids first). */
  teammateByName(sessionId: string, name: string): Agent | undefined {
    let synthetic: Agent | undefined;
    for (const a of Object.values(this.agents)) {
      if (a.sessionId !== sessionId || a.kind === 'session' || a.teammateName !== name) continue;
      if (!a.agentId?.startsWith('teammate:')) return a;
      synthetic ??= a;
    }
    return synthetic;
  }

  /**
   * Fold a teammate that was only known by name into the agent that now reported the same name
   * with a real agent_id, so the teammate is one character with one history.
   */
  adoptNamedTeammate(real: Agent): void {
    if (!real.teammateName || real.kind === 'session' || real.agentId?.startsWith('teammate:')) return;
    const synthKey = agentKeyFor(real.sessionId, teammateIdFor(real.teammateName));
    const s = this.agents[synthKey];
    if (!s || synthKey === real.key || s.kind === 'session') return;
    if (s.statusAt > real.statusAt) {
      real.status = s.status;
      real.statusAt = s.statusAt;
      real.statusSource = s.statusSource;
      real.statusDetail = s.statusDetail;
      real.endedAt = s.endedAt;
      real.endReason = s.endReason;
    }
    real.firstSeenAt = Math.min(real.firstSeenAt, s.firstSeenAt);
    real.lastEventAt = Math.max(real.lastEventAt, s.lastEventAt);
    for (const src of s.sources) if (!real.sources.includes(src)) real.sources.push(src);
    real.teamName ??= s.teamName;
    real.counts.turns += s.counts.turns;
    this.rekey(synthKey, real.key);
    this.removeAgent(synthKey);
  }

  /** Point tasks, log entries, notices and children of agent `from` at agent `to`. */
  private rekey(from: string, to: string): void {
    for (const tk of Object.keys(this.tasks)) {
      const t = this.tasks[tk]!;
      if (t.createdBy !== from && t.completedBy !== from) continue;
      const e = this.editTask(tk);
      if (e.createdBy === from) e.createdBy = to;
      if (e.completedBy === from) e.completedBy = to;
    }
    if (this.log.some((l) => l.agentKey === from)) {
      this.log = this.log.map((l) => (l.agentKey === from ? { ...l, agentKey: to } : l));
      this.logCopied = true;
    }
    if (this.notices.some((n) => n.agentKey === from)) {
      this.notices = this.notices.map((n) => (n.agentKey === from ? { ...n, agentKey: to } : n));
      this.noticesCopied = true;
    }
    for (const k of Object.keys(this.agents)) if (this.agents[k]!.parentKey === from) this.edit(k).parentKey = to;
  }

  /** The agent the current event fired in. */
  actor(): Agent {
    const ev = this.ev;
    return ev.agentId ? this.ensureSubagent(ev.agentId) : this.ensureSession();
  }

  touch(a: Agent): void {
    const ev = this.ev;
    if (ev.ts > a.lastEventAt) a.lastEventAt = ev.ts;
    if (!a.sources.includes(ev.source)) a.sources.push(ev.source);
    a.stale = undefined;
  }

  /**
   * Apply a status if the evidence is at least as new as the current status.
   * Returns false when the event is older (out-of-order delivery).
   */
  setStatus(a: Agent, status: AgentStatus, detail?: string, at = this.ev.ts, force = false): boolean {
    if (!force && a.statusAt !== 0 && at < a.statusAt) return false;
    a.status = status;
    a.statusAt = at;
    a.statusSource = this.ev.source;
    a.statusDetail = detail;
    a.lastKnownStatus = undefined;
    if (status !== 'ended' && status !== 'completed') {
      a.endedAt = undefined;
      a.endReason = undefined;
    }
    return true;
  }

  // Tools

  findTool(a: Agent, ref: ToolRef, preferStatus?: ToolStatus[]): ToolCall | undefined {
    if (ref.useId) {
      const byId = a.tools.find((t) => t.id === ref.useId);
      if (byId) return byId;
      // A PermissionRequest (which has no tool_use_id) may have created the record first.
      return this.latestOpen(a, ref, (t) => !t.hasRealId);
    }
    if (preferStatus) {
      return this.latestOpen(a, ref, (t) => preferStatus.includes(t.status));
    }
    for (let i = a.tools.length - 1; i >= 0; i--) if (a.tools[i]!.name === ref.name) return a.tools[i];
    return undefined;
  }

  /** Latest open tool with the same name, preferring one with an identical summary. */
  private latestOpen(a: Agent, ref: ToolRef, extra: (t: ToolCall) => boolean): ToolCall | undefined {
    let fallback: ToolCall | undefined;
    for (let i = a.tools.length - 1; i >= 0; i--) {
      const t = a.tools[i]!;
      if (t.name !== ref.name || (t.status !== 'running' && t.status !== 'awaiting_permission') || !extra(t)) continue;
      if (t.summary === ref.summary) return t;
      fallback ??= t;
    }
    return fallback;
  }

  upsertTool(a: Agent, ref: ToolRef): ToolCall {
    const found = this.findTool(a, ref, ref.useId ? undefined : ['running', 'awaiting_permission']);
    if (found) {
      const idx = a.tools.indexOf(found);
      const copy: ToolCall = { ...found };
      if (ref.useId && !copy.hasRealId) {
        if (a.currentToolId === copy.id) a.currentToolId = ref.useId;
        copy.id = ref.useId;
        copy.hasRealId = true;
      }
      if (!copy.summary || copy.summary === copy.name) copy.summary = ref.summary;
      if (ref.target && !copy.target) copy.target = ref.target;
      if (ref.mcpServer && !copy.mcpServer) copy.mcpServer = ref.mcpServer;
      a.tools[idx] = copy;
      return copy;
    }
    a.toolSeq += 1;
    const t: ToolCall = {
      id: ref.useId ?? `${a.key}~${a.toolSeq}`,
      hasRealId: Boolean(ref.useId),
      name: ref.name,
      summary: ref.summary,
      status: 'running',
    };
    if (ref.target) t.target = ref.target;
    if (ref.mcpServer) t.mcpServer = ref.mcpServer;
    a.tools.push(t);
    a.counts.tools += 1;
    if (a.tools.length > this.o.maxToolsPerAgent) {
      const drop = a.tools.length - this.o.maxToolsPerAgent;
      a.tools.splice(0, drop);
    }
    return t;
  }

  finishTool(a: Agent, t: ToolCall, status: ToolStatus, durationMs?: number): void {
    const ev = this.ev;
    // An unknown outcome may be upgraded by a late event; real outcomes are final.
    const isFinal = t.status !== 'running' && t.status !== 'awaiting_permission' && t.status !== 'unknown';
    if (isFinal && status === 'unknown') return;
    t.status = status;
    if (status !== 'unknown') {
      t.endedAt = ev.ts;
      t.note = undefined;
      if (durationMs !== undefined) {
        t.durationMs = durationMs;
        t.durationSource = 'reported';
      } else if (t.startedAt !== undefined && ev.ts >= t.startedAt) {
        t.durationMs = ev.ts - t.startedAt;
        t.durationSource = 'observed';
      }
    }
    if (a.currentToolId === t.id) a.currentToolId = this.latestRunningTool(a)?.id;
  }

  /** Status implied by the agent's open tool calls while its turn is in progress. */
  applyActiveStatus(a: Agent, idleDetail = 'Thinking'): void {
    let awaiting: ToolCall | undefined;
    let running: ToolCall | undefined;
    for (let i = a.tools.length - 1; i >= 0; i--) {
      const t = a.tools[i]!;
      if (t.status === 'awaiting_permission' && !awaiting) awaiting = t;
      if (t.status === 'running' && !running) running = t;
    }
    if (awaiting) {
      this.setStatus(a, 'waiting_permission', `Permission: ${awaiting.name}`);
      return;
    }
    if (running) {
      const q = QUESTION_TOOLS[running.name];
      if (q) this.setStatus(a, 'waiting_input', q);
      else this.setStatus(a, 'working', running.summary);
      return;
    }
    this.setStatus(a, 'working', idleDetail);
  }

  latestRunningTool(a: Agent): ToolCall | undefined {
    for (let i = a.tools.length - 1; i >= 0; i--) {
      const t = a.tools[i]!;
      if (t.status === 'running' || t.status === 'awaiting_permission') return t;
    }
    return undefined;
  }

  /** Tools still marked running when the agent's turn ended: the outcome was never observed. */
  resolveDanglingTools(a: Agent, note: string): void {
    for (let i = 0; i < a.tools.length; i++) {
      const t = a.tools[i]!;
      if (t.status === 'running' || t.status === 'awaiting_permission') {
        a.tools[i] = { ...t, status: 'unknown', note };
      }
    }
    a.currentToolId = undefined;
  }

  end(a: Agent, reason: string, status: 'ended' | 'completed' = 'ended', force = false): boolean {
    if (!this.setStatus(a, status, reason, this.ev.ts, force)) return false;
    a.endedAt = this.ev.ts;
    a.endReason = reason;
    a.pendingPermission = undefined;
    this.resolveDanglingTools(a, `No completion event before ${status === 'completed' ? 'the agent finished' : 'the session ended'}`);
    return true;
  }

  endSessionTree(session: Agent, reason: string): void {
    if (!this.end(session, reason)) return;
    for (const k of Object.keys(this.agents)) {
      const child = this.agents[k]!;
      if (child.sessionId !== session.sessionId || child.key === session.key) continue;
      if (TERMINAL_STATUSES.has(child.status)) continue;
      // Nothing runs on in a session that ended, even if a child's last event carries a later capture time.
      this.end(this.edit(k), PARENT_ENDED_REASON, 'ended', true);
    }
    for (const tk of Object.keys(this.tasks)) {
      const t = this.tasks[tk]!;
      if (t.sessionId === session.sessionId && t.status === 'open' && !t.orphaned) {
        this.editTask(tk).orphaned = true;
      }
    }
    if (this.spawns[session.sessionId]) {
      this.copySpawns();
      delete this.spawns[session.sessionId];
    }
  }

  /** Clear the pending permission once no tool is waiting for approval any more. */
  clearPendingPermissionIfOlder(a: Agent): void {
    if (!a.pendingPermission || a.pendingPermission.at > this.ev.ts) return;
    if (a.tools.some((t) => t.status === 'awaiting_permission')) return;
    a.pendingPermission = undefined;
  }

  editTask(key: string): Task {
    if (!this.tasksCopied) {
      this.tasks = { ...this.tasks };
      this.tasksCopied = true;
    }
    const t = this.tasks[key]!;
    const copy = { ...t };
    this.tasks[key] = copy;
    return copy;
  }

  upsertTask(key: string, init: Task): Task {
    if (!this.tasksCopied) {
      this.tasks = { ...this.tasks };
      this.tasksCopied = true;
    }
    const existing = this.tasks[key];
    const t: Task = existing ? { ...existing } : init;
    this.tasks[key] = t;
    return t;
  }

  copySpawns(): void {
    if (!this.spawnsCopied) {
      this.spawns = { ...this.spawns };
      this.spawnsCopied = true;
    }
  }

  // Spawning calls (Agent/Task)

  /** Pending spawns of a session, without those that can no longer match anything at `at`. */
  liveSpawns(sessionId: string, at: number): PendingSpawn[] {
    return (this.spawns[sessionId] ?? []).filter(
      (p) => at - p.ts <= SPAWN_MAX_AGE_MS && (p.closedAt === undefined || at - p.closedAt <= SPAWN_CLOSED_RETAIN_MS),
    );
  }

  setSpawns(sessionId: string, list: PendingSpawn[]): void {
    const prev = this.spawns[sessionId];
    if (!prev && !list.length) return;
    if (prev && prev.length === list.length && prev.every((p, i) => p === list[i])) return;
    this.copySpawns();
    this.spawns[sessionId] = list.slice(-MAX_PENDING_SPAWNS);
  }

  /**
   * Consume the pending spawning call that most likely started a subagent of `agentType` at `at`.
   * Exact type matches win over untyped calls, then the oldest call. The match is only reported as
   * certain when no other compatible call could have been the one.
   */
  takeSpawn(sessionId: string, agentType: string | undefined, at: number): SpawnMatch | undefined {
    const list = this.liveSpawns(sessionId, at);
    const compatible = list.filter(
      (p) =>
        spawnTypeFits(p.subagentType, agentType) &&
        p.ts <= at + SPAWN_JITTER_MS &&
        at - p.ts <= SPAWN_MAX_AGE_MS &&
        (p.closedAt === undefined || at <= p.closedAt + SPAWN_CLOSED_MATCH_MS),
    );
    if (!compatible.length) {
      this.setSpawns(sessionId, list);
      return undefined;
    }
    const rank = (p: PendingSpawn) => (agentType === undefined || p.subagentType === agentType ? 0 : p.subagentType !== undefined ? 1 : 2);
    const spawn = [...compatible].sort((x, y) => rank(x) - rank(y) || x.ts - y.ts)[0]!;
    const parentCertain = compatible.every((p) => p.byKey === spawn.byKey && p.ambiguous !== 'parent');
    const idCertain = compatible.length === 1 && !spawn.ambiguous && spawn.toolUseId !== undefined;
    const rest = list
      .filter((p) => p !== spawn)
      .map((p): PendingSpawn => {
        if (compatible.length < 2 || !compatible.includes(p)) return p;
        const ambiguous: PendingSpawn['ambiguous'] = p.ambiguous === 'parent' || compatible.some((q) => q.byKey !== p.byKey) ? 'parent' : 'id';
        return p.ambiguous === ambiguous ? p : { ...p, ambiguous };
      });
    this.setSpawns(sessionId, rest);
    return { spawn, parentCertain, idCertain };
  }

  /** The spawning call returned or failed: its subagent (if any) has started by now. */
  closeSpawn(sessionId: string, toolUseId: string, at: number): void {
    const list = this.spawns[sessionId];
    if (!list?.some((p) => p.toolUseId === toolUseId && p.closedAt === undefined)) return;
    this.setSpawns(
      sessionId,
      list.map((p) => (p.toolUseId === toolUseId && p.closedAt === undefined ? { ...p, closedAt: at } : p)),
    );
  }

  dropSpawn(sessionId: string, toolUseId: string): void {
    const list = this.spawns[sessionId];
    if (list?.some((p) => p.toolUseId === toolUseId)) this.setSpawns(sessionId, list.filter((p) => p.toolUseId !== toolUseId));
  }

  // Output

  addLog(agentKey: string, text: string): void {
    const ev = this.ev;
    const entry: LogEntry = { seq: ev.seq, ts: ev.ts, agentKey, kind: ev.kind, source: ev.source, text };
    // One copy per event (not per entry); trimmed to maxLog in finish().
    if (!this.logCopied) {
      this.log = this.log.slice(Math.max(0, this.log.length - this.o.maxLog));
      this.logCopied = true;
    }
    this.log.push(entry);
  }

  notice(severity: Severity, kind: NoticeKind, a: Agent, title: string, message?: string): void {
    const ev = this.ev;
    const n: Notice = { id: `n${ev.seq}.${this.noticeCounter++}`, ts: ev.ts, severity, kind, agentKey: a.key, sessionId: a.sessionId, title };
    if (message) n.message = message;
    if (!this.noticesCopied) {
      this.notices = this.notices.slice(Math.max(0, this.notices.length - this.o.maxNotices));
      this.noticesCopied = true;
    }
    this.notices.push(n);
  }

  /** Bound the task table while sessions are alive: drop the oldest finished tasks first. */
  private capTasks(): void {
    const keys = Object.keys(this.tasks);
    if (keys.length <= this.o.maxTasks) return;
    const finished = keys
      .map((k) => this.tasks[k]!)
      .filter((t) => t.status === 'completed' || t.orphaned)
      .sort((x, y) => (x.completedAt ?? x.createdAt ?? 0) - (y.completedAt ?? y.createdAt ?? 0));
    const drop = finished.slice(0, keys.length - this.o.maxTasks);
    if (!drop.length) return;
    if (!this.tasksCopied) {
      this.tasks = { ...this.tasks };
      this.tasksCopied = true;
    }
    for (const t of drop) delete this.tasks[t.key];
  }

  finish(): OfficeState {
    const ev = this.ev;
    if (this.log.length > this.o.maxLog) this.log.splice(0, this.log.length - this.o.maxLog);
    if (this.notices.length > this.o.maxNotices) this.notices.splice(0, this.notices.length - this.o.maxNotices);
    if (this.tasksCopied) this.capTasks();
    const s: OfficeState = {
      version: 1,
      agents: this.agents,
      tasks: this.tasks,
      notices: this.notices,
      log: this.log,
      spawns: this.spawns,
      lastSeq: Math.max(this.state.lastSeq, ev.seq),
      lastEventAt: ev.kind === 'Tick' ? this.state.lastEventAt : Math.max(this.state.lastEventAt ?? 0, ev.ts),
      lastHookEventAt: ev.source === 'hook' ? Math.max(this.state.lastHookEventAt ?? 0, ev.ts) : this.state.lastHookEventAt,
    };
    return s;
  }
}

function label(a: Agent): string {
  return a.kind === 'session' ? 'session' : (a.teammateName ?? a.agentType ?? 'subagent');
}

/**
 * Pure reducer: (state, event) → state. Used by the monitor and by every UI client,
 * which replay the same sequenced events and therefore cannot diverge.
 */
export function reduce(state: OfficeState, ev: MonitorEvent, o: ReducerOptions = DEFAULT_REDUCER_OPTIONS): OfficeState {
  const c = new Ctx(state, ev, o);
  switch (ev.kind) {
    case 'SessionStart':
      onSessionStart(c, ev);
      break;
    case 'SessionEnd': {
      const s = c.ensureSession();
      c.touch(s);
      c.endSessionTree(s, `Session ended${ev.reason ? ` (${ev.reason})` : ''}`);
      c.addLog(s.key, `Session ended${ev.reason ? `: ${ev.reason}` : ''}`);
      break;
    }
    case 'SubagentStart':
      onSubagentStart(c, ev);
      break;
    case 'SubagentStop':
      onSubagentStop(c, ev);
      break;
    case 'PreToolUse':
      onPreToolUse(c, ev);
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      onPostTool(c, ev);
      break;
    case 'PermissionRequest': {
      const a = c.actor();
      c.touch(a);
      const open = c.findTool(a, ev.tool, ['running', 'awaiting_permission']);
      // Delivered after the tool already finished (async hooks may reorder): history only.
      if (!open && a.statusAt > ev.ts) {
        a.counts.permissions += 1;
        c.addLog(a.key, `Permission requested for ${ev.tool.name} (already resolved)`);
        break;
      }
      const t = c.upsertTool(a, ev.tool);
      if (t.status === 'running') t.status = 'awaiting_permission';
      if (t.startedAt === undefined) t.startedAt = ev.ts;
      a.counts.permissions += 1;
      a.pendingPermission = { toolName: ev.tool.name, summary: ev.tool.summary, at: ev.ts };
      if (t.status === 'awaiting_permission') c.setStatus(a, 'waiting_permission', `Permission: ${ev.tool.name}`);
      c.notice('warning', 'permission', a, `Permission requested: ${ev.tool.name}`, ev.tool.target ?? ev.tool.summary);
      c.addLog(a.key, `Permission requested for ${ev.tool.name}: ${ev.tool.summary}`);
      break;
    }
    case 'PermissionDenied': {
      const a = c.actor();
      c.touch(a);
      const t = c.upsertTool(a, ev.tool);
      c.finishTool(a, t, 'denied');
      if (ev.reason) t.error = ev.reason;
      // A denied spawning call starts no subagent: it must not be matched to someone else's.
      if (SPAWN_TOOLS.has(ev.tool.name) && ev.tool.useId) c.dropSpawn(ev.sessionId, ev.tool.useId);
      c.clearPendingPermissionIfOlder(a);
      c.applyActiveStatus(a, 'Continuing after denial');
      c.notice('warning', 'permission', a, `Permission denied: ${ev.tool.name}`, ev.reason);
      c.addLog(a.key, `Permission denied for ${ev.tool.name}${ev.reason ? `: ${ev.reason}` : ''}`);
      break;
    }
    case 'Notification':
      onNotification(c, ev);
      break;
    case 'Stop': {
      const a = c.actor();
      c.touch(a);
      if (ev.lastMessage) a.lastMessage = ev.lastMessage;
      a.backgroundRunning = ev.backgroundRunning;
      a.counts.turns += 1;
      a.turnCompletedAt = ev.ts;
      c.clearPendingPermissionIfOlder(a);
      c.resolveDanglingTools(a, 'No completion event before the turn ended');
      const bg = ev.backgroundRunning ? ` (${ev.backgroundRunning} background task${ev.backgroundRunning > 1 ? 's' : ''} running)` : '';
      c.setStatus(a, 'idle', `Turn complete${bg}`);
      c.addLog(a.key, `Turn complete${bg}`);
      break;
    }
    case 'StopFailure': {
      const a = c.actor();
      c.touch(a);
      c.resolveDanglingTools(a, 'Turn ended with an API error');
      c.setStatus(a, 'failed', `API error: ${ev.error ?? 'unknown'}`);
      c.notice('error', 'stop_failure', a, `Turn failed: ${ev.error ?? 'unknown error'}`, ev.lastMessage);
      c.addLog(a.key, `Turn failed (${ev.error ?? 'unknown'})`);
      break;
    }
    case 'TaskCreated':
    case 'TaskCompleted':
      onTask(c, ev);
      break;
    case 'TeammateIdle':
      onTeammateIdle(c, ev);
      break;
    case 'UserPromptSubmit': {
      const a = c.actor();
      c.touch(a);
      a.turnCompletedAt = undefined;
      c.clearPendingPermissionIfOlder(a);
      c.setStatus(a, 'working', 'Prompt received');
      c.addLog(a.key, 'Prompt submitted');
      break;
    }
    case 'PreCompact': {
      const a = c.actor();
      c.touch(a);
      c.setStatus(a, 'working', `Compacting context${ev.trigger ? ` (${ev.trigger})` : ''}`);
      c.addLog(a.key, `Compacting context${ev.trigger ? ` (${ev.trigger})` : ''}`);
      break;
    }
    case 'PostCompact': {
      const a = c.actor();
      c.touch(a);
      c.addLog(a.key, 'Context compacted');
      break;
    }
    case 'UnknownHook': {
      const a = c.actor();
      c.touch(a);
      c.addLog(a.key, `Unrecognised hook event ${ev.hookEventName} (ignored for status)`);
      break;
    }
    case 'RegistryStatus':
      onRegistryStatus(c, ev);
      break;
    case 'RegistryGone': {
      const existing = c.get(agentKeyFor(ev.sessionId));
      if (!existing || TERMINAL_STATUSES.has(existing.status)) break;
      const s = c.ensureSession();
      c.endSessionTree(s, 'Left the session registry (no SessionEnd received)');
      c.addLog(s.key, 'Session no longer listed in the session registry');
      break;
    }
    case 'TranscriptSeen':
      onTranscriptSeen(c, ev);
      break;
    case 'TranscriptSubagentSeen':
      onTranscriptSubagent(c, ev);
      break;
    case 'Tick':
      onTick(c, ev);
      break;
    case 'Restored':
      onRestored(c);
      break;
  }
  return c.finish();
}

function onSessionStart(c: Ctx, ev: EventOf<'SessionStart'>): void {
  const s = c.ensureSession();
  c.touch(s);
  if (ev.model) s.model = ev.model;
  if (ev.title) s.title = ev.title;
  const src = ev.startSource;
  if (src === 'compact') {
    // Compaction happens mid-work; it does not mean the session is idle.
    if (s.status === 'unknown' || TERMINAL_STATUSES.has(s.status)) c.setStatus(s, 'working', 'Resumed after compaction');
  } else {
    c.setStatus(s, 'idle', src === 'resume' ? 'Resumed, waiting for a prompt' : 'Started, waiting for a prompt');
  }
  if (src === 'clear') s.lastMessage = undefined;
  c.addLog(s.key, `Session started${src ? ` (${src})` : ''}${ev.model ? ` · ${ev.model}` : ''}`);
}

function onSubagentStart(c: Ctx, ev: EventOf<'SubagentStart'>): void {
  const sessionKey = agentKeyFor(ev.sessionId);
  const prev = c.get(c.subagentKey(ev.sessionId, ev.agentId!));
  // SubagentStart also fires when a subagent is resumed and each time an in-process teammate
  // handles a new message. Only the first observed start can belong to a pending spawning call.
  const firstStart = !prev || prev.parentVia === 'implicit' || !prev.sources.includes('hook');
  const linkable = firstStart && prev?.parentVia !== 'spawn-tool';
  const a = c.ensureSubagent(ev.agentId!, 'session');
  c.touch(a);

  if (linkable && a.spawnToolUseId) {
    // Transcript metadata already named the exact spawning call.
    linkExactSpawn(c, a, a.spawnToolUseId);
    if (a.parentVia !== 'spawn-tool') a.parentVia = 'session';
  } else if (linkable) {
    const m = c.takeSpawn(ev.sessionId, ev.agentType, ev.ts);
    if (m && m.parentCertain && c.get(m.spawn.byKey) && m.spawn.byKey !== a.key) {
      a.parentKey = m.spawn.byKey;
      a.parentVia = 'spawn-tool';
      a.spawnAmbiguous = undefined;
      if (m.idCertain) a.spawnToolUseId = m.spawn.toolUseId;
    } else {
      a.parentKey = sessionKey;
      a.parentVia = 'session';
      if (m) a.spawnAmbiguous = true;
    }
  }

  const nested = a.parentKey !== undefined && a.parentKey !== sessionKey;
  if (firstStart) {
    c.setStatus(a, 'working', 'Started');
    c.addLog(a.key, `${label(a)} started${nested ? ' (nested)' : ''}${a.spawnAmbiguous ? ' (spawning call not determined)' : ''}`);
  } else if (a.status !== 'working' && a.status !== 'waiting_permission' && a.status !== 'waiting_input') {
    // A duplicate start while it runs changes nothing; after a stop it means the agent continues.
    a.turnCompletedAt = undefined;
    c.setStatus(a, 'working', a.kind === 'teammate' ? 'Handling a new message' : 'Resumed');
    c.addLog(a.key, `${label(a)} ${a.kind === 'teammate' ? 'is handling a new message' : 'resumed'}`);
  }
}

/** A SubagentStop without any earlier sign of the agent and without a subagent type of its own. */
function isInternalAgentStop(c: Ctx, ev: EventOf<'SubagentStop'>): boolean {
  if (c.get(c.subagentKey(ev.sessionId, ev.agentId!))) return false;
  // Claude Code also reports SubagentStop for its own helper agents (prompt suggestions, side
  // questions). Those carry an empty agent_type, or the session's own `--agent` type.
  return ev.agentType === undefined || ev.agentType === c.get(agentKeyFor(ev.sessionId))?.agentType;
}

function onSubagentStop(c: Ctx, ev: EventOf<'SubagentStop'>): void {
  if (isInternalAgentStop(c, ev)) {
    // Not an agent the user spawned: no character, but the session is evidently alive.
    c.touch(c.ensureSession());
    return;
  }
  const a = c.ensureSubagent(ev.agentId!);
  c.touch(a);
  if (ev.lastMessage) a.lastMessage = ev.lastMessage;
  // Without a SubagentStart in between, another stop is the same stop delivered again.
  const repeat =
    a.status === 'completed' ||
    (a.kind === 'teammate' && a.status === 'idle' && a.turnCompletedAt !== undefined && Math.abs(ev.ts - a.turnCompletedAt) <= SPAWN_JITTER_MS);
  if (!repeat) a.counts.turns += 1;
  if (a.kind === 'teammate') {
    // A teammate that finished its turn stays on the team and can be messaged again.
    if (!repeat) {
      a.turnCompletedAt = ev.ts;
      c.clearPendingPermissionIfOlder(a);
      c.resolveDanglingTools(a, 'No completion event before the turn ended');
      c.setStatus(a, 'idle', 'Turn finished');
      c.addLog(a.key, `${label(a)} finished its turn`);
    }
    return;
  }
  // A stop that happened before the session ended upgrades "outcome not reported" to completed.
  const force = a.status === 'ended' && a.endReason === PARENT_ENDED_REASON && ev.ts <= a.statusAt;
  if (c.end(a, 'Finished', 'completed', force) && !repeat) c.addLog(a.key, `${label(a)} finished`);
}

function onTeammateIdle(c: Ctx, ev: EventOf<'TeammateIdle'>): void {
  let a: Agent;
  if (ev.agentId) {
    a = c.ensureSubagent(ev.agentId);
  } else if (ev.teammateName && isOtherSessionsTeam(ev.sessionId, ev.teamName)) {
    // Fired in a split-pane teammate, which is its own Claude Code session: that session is the teammate.
    a = c.ensureSession();
  } else if (ev.teammateName) {
    const known = c.teammateByName(ev.sessionId, ev.teammateName);
    a = known ? c.ensureSubagent(known.agentId!) : c.ensureSubagent(teammateIdFor(ev.teammateName));
  } else {
    a = c.ensureSession();
  }
  c.touch(a);
  if (a.kind === 'subagent') a.kind = 'teammate';
  if (ev.teammateName) a.teammateName = ev.teammateName;
  if (ev.teamName) a.teamName = ev.teamName;
  c.setStatus(a, 'idle', 'Teammate idle');
  c.addLog(a.key, `${ev.teammateName ?? 'Teammate'} is idle`);
  if (ev.agentId) c.adoptNamedTeammate(a);
}

function onPreToolUse(c: Ctx, ev: EventOf<'PreToolUse'>): void {
  const a = c.actor();
  c.touch(a);
  const t = c.upsertTool(a, ev.tool);
  if (t.startedAt === undefined || ev.ts < t.startedAt) t.startedAt = ev.ts;
  if (t.endedAt !== undefined && t.durationMs === undefined && t.endedAt >= t.startedAt) {
    t.durationMs = t.endedAt - t.startedAt;
    t.durationSource = 'observed';
  }
  // A start that arrives after the agent's turn (or life) ended belongs to that past turn.
  const pastBoundary =
    (a.turnCompletedAt !== undefined && ev.ts <= a.turnCompletedAt) || (TERMINAL_STATUSES.has(a.status) && ev.ts <= a.statusAt);
  if (pastBoundary && t.status === 'running') {
    t.status = 'unknown';
    t.note = 'Start reported late; completion not observed';
  }
  const stillRunning = t.status === 'running' || t.status === 'awaiting_permission';
  if (stillRunning && (!a.currentToolId || ev.ts >= a.statusAt)) a.currentToolId = t.id;
  c.clearPendingPermissionIfOlder(a);

  if (SPAWN_TOOLS.has(ev.tool.name)) recordSpawn(c, a, t, ev);

  if (stillRunning) c.applyActiveStatus(a);
  c.addLog(a.key, `▶ ${ev.tool.name}: ${ev.tool.summary}`);
}

/** Remember an Agent/Task call until the SubagentStart it causes, or link it to one that came first. */
function recordSpawn(c: Ctx, by: Agent, t: ToolCall, ev: EventOf<'PreToolUse'>): void {
  const useId = ev.tool.useId;
  const list = c.liveSpawns(ev.sessionId, ev.ts);
  const sessionAgents = Object.values(c.agents).filter((x) => x.sessionId === ev.sessionId && x.kind !== 'session');
  // Duplicate delivery, or a subagent that transcript metadata already tied to this exact call.
  const exact = useId ? sessionAgents.find((x) => x.spawnToolUseId === useId) : undefined;
  if (exact && exact.parentVia !== 'spawn-tool' && exact.key !== by.key) {
    const x = c.edit(exact.key);
    x.parentKey = by.key;
    x.parentVia = 'spawn-tool';
    x.spawnAmbiguous = undefined;
  }
  if (exact || (useId && list.some((p) => p.toolUseId === useId))) {
    c.setSpawns(ev.sessionId, list);
    return;
  }
  const spawn: PendingSpawn = { byKey: by.key, ts: ev.ts };
  if (useId) spawn.toolUseId = useId;
  if (ev.tool.target) spawn.subagentType = ev.tool.target;
  if (t.endedAt !== undefined) spawn.closedAt = t.endedAt;

  // Hooks are delivered asynchronously, so the SubagentStart this call caused may already be applied.
  const late = sessionAgents
    .filter(
      (x) =>
        x.key !== by.key &&
        x.parentVia === 'session' &&
        !x.spawnToolUseId &&
        !x.spawnAmbiguous &&
        spawnTypeFits(spawn.subagentType, x.agentType) &&
        x.firstSeenAt >= ev.ts - SPAWN_JITTER_MS &&
        x.firstSeenAt - ev.ts <= LATE_SPAWN_WINDOW_MS &&
        (x.endedAt === undefined || x.endedAt >= ev.ts) &&
        (spawn.closedAt === undefined || x.firstSeenAt <= spawn.closedAt + SPAWN_CLOSED_MATCH_MS),
    )
    .sort((x, y) => x.firstSeenAt - y.firstSeenAt || x.key.localeCompare(y.key));
  const sessionKey = agentKeyFor(ev.sessionId);
  if (late.length === 1 || (late.length > 1 && by.key === sessionKey)) {
    // With several candidates the spawner is still certain when it is the session itself (their
    // parent already). The exact call is not claimed: a sibling call may still be in flight.
    const x = c.edit(late[0]!.key);
    x.parentKey = by.key;
    x.parentVia = 'spawn-tool';
    c.addLog(x.key, `${label(x)} linked to the call that spawned it (reported late)`);
    c.setSpawns(ev.sessionId, list);
    return;
  }
  if (late.length > 1) spawn.ambiguous = 'parent';
  c.setSpawns(ev.sessionId, [...list, spawn]);
}

function onPostTool(c: Ctx, ev: EventOf<'PostToolUse'> | EventOf<'PostToolUseFailure'>): void {
  const a = c.actor();
  c.touch(a);
  const t = c.upsertTool(a, ev.tool);
  c.clearPendingPermissionIfOlder(a);
  if (SPAWN_TOOLS.has(ev.tool.name) && ev.tool.useId) c.closeSpawn(ev.sessionId, ev.tool.useId, ev.ts);
  if (ev.kind === 'PostToolUse') {
    const status: ToolStatus = ev.success === false ? 'failed' : 'succeeded';
    c.finishTool(a, t, status, ev.durationMs);
    c.clearPendingPermissionIfOlder(a);
    c.applyActiveStatus(a);
    c.addLog(a.key, `✓ ${ev.tool.name}${t.durationMs !== undefined ? ` (${Math.round(t.durationMs)} ms)` : ''}`);
  } else {
    const interrupted = ev.isInterrupt === true;
    c.finishTool(a, t, interrupted ? 'interrupted' : 'failed', ev.durationMs);
    if (ev.error) t.error = ev.error;
    a.counts.failures += 1;
    if (interrupted) {
      // Stop hooks do not fire on user interrupt; the interrupt itself ends the turn.
      c.resolveDanglingTools(a, 'Interrupted');
      c.setStatus(a, 'idle', 'Interrupted by user');
      c.notice('info', 'tool_failure', a, `${ev.tool.name} interrupted`, ev.tool.summary);
    } else {
      c.clearPendingPermissionIfOlder(a);
      c.applyActiveStatus(a, `Recovering from ${ev.tool.name} failure`);
      c.notice('error', 'tool_failure', a, `${ev.tool.name} failed`, ev.error ?? ev.tool.summary);
    }
    c.addLog(a.key, `✗ ${ev.tool.name}${interrupted ? ' interrupted' : ' failed'}${ev.error ? `: ${ev.error}` : ''}`);
  }
}

function onNotification(c: Ctx, ev: EventOf<'Notification'>): void {
  const a = c.actor();
  c.touch(a);
  const nt = ev.notificationType ?? 'unknown';
  const text = ev.message ?? ev.title ?? nt;
  switch (nt) {
    case 'permission_prompt': {
      const recent = a.pendingPermission && Math.abs(ev.ts - a.pendingPermission.at) < 15_000;
      c.setStatus(a, 'waiting_permission', a.pendingPermission ? `Permission: ${a.pendingPermission.toolName}` : 'Permission needed');
      if (!recent) c.notice('warning', 'permission', a, 'Permission needed', text);
      break;
    }
    case 'idle_prompt':
      c.setStatus(a, 'idle', 'Waiting for your next prompt');
      break;
    case 'elicitation_dialog':
    case 'elicitation_url_dialog':
    case 'agent_needs_input':
      c.setStatus(a, 'waiting_input', text);
      c.notice('warning', 'input_needed', a, 'Input needed', text);
      break;
    case 'elicitation_complete':
    case 'elicitation_response':
      if (a.status === 'waiting_input') c.setStatus(a, 'working', 'Input received');
      break;
    case 'auth_storage_failure':
      c.notice('error', 'notification', a, ev.title ?? 'Authentication storage failure', ev.message);
      break;
    case 'auth_success':
      break;
    default:
      c.notice(nt.startsWith('quota') ? 'warning' : 'info', 'notification', a, ev.title ?? nt.replace(/_/g, ' '), ev.message);
  }
  c.addLog(a.key, `Notification (${nt}): ${text}`);
}

function onTask(c: Ctx, ev: EventOf<'TaskCreated'> | EventOf<'TaskCompleted'>): void {
  let a: Agent;
  if (ev.agentId) {
    a = c.actor();
  } else if (ev.teammateName && isOtherSessionsTeam(ev.sessionId, ev.teamName)) {
    // A split-pane teammate's own session.
    a = c.ensureSession();
    a.teammateName = ev.teammateName;
    if (ev.teamName) a.teamName = ev.teamName;
  } else {
    // Without agent_id (older Claude Code), attribute the task to the named teammate when it is known.
    const known = ev.teammateName ? c.teammateByName(ev.sessionId, ev.teammateName) : undefined;
    a = known ? c.ensureSubagent(known.agentId!) : c.ensureSession();
  }
  c.touch(a);
  if (ev.teammateName && a.kind !== 'session') {
    a.kind = 'teammate';
    a.teammateName = ev.teammateName;
    if (ev.teamName) a.teamName = ev.teamName;
    if (ev.agentId) c.adoptNamedTeammate(a);
  }
  const key = taskKeyFor(ev.sessionId, ev.taskId);
  const t = c.upsertTask(key, { key, taskId: ev.taskId, sessionId: ev.sessionId, status: 'open' });
  if (ev.subject) t.subject = ev.subject;
  if (ev.description) t.description = ev.description;
  if (ev.teammateName) t.teammateName = ev.teammateName;
  if (ev.teamName) t.teamName = ev.teamName;
  if (ev.kind === 'TaskCreated') {
    if (t.status === 'completed' && t.completedAt !== undefined && ev.ts > t.completedAt) {
      // Same id created again after completion: a new task, not a late duplicate.
      t.status = 'open';
      t.createdAt = ev.ts;
      t.completedAt = undefined;
      t.completedBy = undefined;
      t.createdBy = a.key;
    }
    t.orphaned = undefined;
    if (t.createdAt === undefined || ev.ts < t.createdAt) t.createdAt = ev.ts;
    t.createdBy ??= a.key;
    c.addLog(a.key, `Task created: ${ev.subject ?? ev.taskId}`);
  } else {
    t.status = 'completed';
    t.orphaned = undefined;
    t.completedAt = ev.ts;
    t.completedBy = a.key;
    c.addLog(a.key, `Task completed: ${ev.subject ?? ev.taskId}`);
  }
}

function onRegistryStatus(c: Ctx, ev: EventOf<'RegistryStatus'>): void {
  const s = c.ensureSession();
  c.touch(s);
  s.pid = ev.pid;
  if (ev.name) s.registryName = ev.name;
  if (ev.entrypoint) s.entrypoint = ev.entrypoint;
  if (ev.version) s.version = ev.version;
  if (!ev.alive) {
    if (!TERMINAL_STATUSES.has(s.status)) {
      c.endSessionTree(s, 'Process exited (no SessionEnd received)');
      c.addLog(s.key, `Process ${ev.pid} is not running`);
    }
    return;
  }
  const reg = ev.status;
  // Restored or transcript-discovered sessions accept the registry's current view.
  const force = s.status === 'unknown' && s.statusSource !== 'hook';
  // "busy" is coarser than hook data (a busy session may be waiting on a permission prompt),
  // so it only replaces statuses it is inconsistent with.
  if (reg === 'busy') {
    if (!['working', 'waiting_permission', 'waiting_input'].includes(s.status)) c.setStatus(s, 'working', 'Busy (session registry)', ev.ts, force);
  } else if (reg === 'idle') {
    c.setStatus(s, 'idle', 'Idle (session registry)', ev.ts, force);
  } else if (reg === 'waiting') {
    const perm = /permission|approv/i.test(ev.waitingFor ?? '');
    const target = perm ? 'waiting_permission' : 'waiting_input';
    if (!WAITING_STATUSES.has(s.status)) c.setStatus(s, target, `Waiting: ${ev.waitingFor ?? 'unknown'} (session registry)`, ev.ts, force);
  } else if (s.status === 'unknown' || TERMINAL_STATUSES.has(s.status)) {
    c.setStatus(s, 'unknown', 'Process running; status not reported');
  }
}

function onTranscriptSeen(c: Ctx, ev: EventOf<'TranscriptSeen'>): void {
  const isNew = !c.get(agentKeyFor(ev.sessionId));
  const s = c.ensureSession();
  if (!s.sources.includes('transcript')) s.sources.push('transcript');
  if (ev.title) s.title = ev.title;
  if (ev.model && !s.model) s.model = ev.model;
  if (ev.usage && (!s.usage || (ev.usage.at ?? 0) >= (s.usage.at ?? 0))) {
    s.usage = ev.usage;
    s.usageSource = 'transcript';
  }
  if (ev.lastActivityAt) {
    s.transcriptLastActivityAt = Math.max(s.transcriptLastActivityAt ?? 0, ev.lastActivityAt);
    if (ev.lastActivityAt > s.lastEventAt) s.lastEventAt = ev.lastActivityAt;
  }
  if (isNew) {
    s.firstSeenAt = ev.lastActivityAt ?? ev.ts;
    if (ev.live === false) {
      c.end(s, 'Not running (found in transcript history)');
    } else {
      s.statusSource = 'transcript';
      s.statusDetail = 'Discovered from transcript; live status unknown';
    }
    c.addLog(s.key, 'Discovered from transcript');
  }
}

function onTranscriptSubagent(c: Ctx, ev: EventOf<'TranscriptSubagentSeen'>): void {
  if (!ev.agentId) return;
  const isNew = !c.get(c.subagentKey(ev.sessionId, ev.agentId));
  const a = c.ensureSubagent(ev.agentId, 'transcript');
  if (!a.sources.includes('transcript')) a.sources.push('transcript');
  if (ev.description && !a.description) a.description = ev.description;
  if (ev.spawnToolUseId && a.spawnToolUseId !== ev.spawnToolUseId) linkExactSpawn(c, a, ev.spawnToolUseId);
  if (ev.lastActivityAt && ev.lastActivityAt > a.lastEventAt) a.lastEventAt = ev.lastActivityAt;
  if (isNew) a.firstSeenAt = ev.lastActivityAt ?? ev.ts;
  // Hook data (if any) wins; transcript metadata only fills in what we never saw.
  if (a.sources.includes('hook')) return;
  if (ev.finished === true) {
    c.end(a, 'Finished (transcript metadata)', 'completed');
  } else if (isNew) {
    a.statusSource = 'transcript';
    a.statusDetail = 'Discovered from transcript; live status unknown';
  }
}

/**
 * Transcript metadata names the exact tool_use_id of the call that spawned a subagent. The agent
 * whose tool history holds that call is the parent; this overrides a link guessed from timing.
 */
function linkExactSpawn(c: Ctx, a: Agent, toolUseId: string): void {
  let owner: Agent | undefined;
  for (const x of Object.values(c.agents)) {
    if (x.sessionId !== a.sessionId || x.key === a.key) continue;
    if (x.tools.some((t) => t.id === toolUseId && SPAWN_TOOLS.has(t.name))) {
      owner = x;
      break;
    }
  }
  const pending = (c.spawns[a.sessionId] ?? []).find((p) => p.toolUseId === toolUseId);
  const byKey = owner?.key ?? (pending && pending.byKey !== a.key && c.get(pending.byKey) ? pending.byKey : undefined);
  a.spawnToolUseId = toolUseId;
  if (byKey) {
    a.parentKey = byKey;
    a.parentVia = 'spawn-tool';
    a.spawnAmbiguous = undefined;
  }
  if (pending) c.dropSpawn(a.sessionId, toolUseId);
  // Another agent that was given this call by timing was matched wrongly.
  for (const k of Object.keys(c.agents)) {
    const x = c.agents[k]!;
    if (k !== a.key && x.sessionId === a.sessionId && x.spawnToolUseId === toolUseId) c.edit(k).spawnToolUseId = undefined;
  }
}

function onTick(c: Ctx, ev: EventOf<'Tick'>): void {
  const now = ev.ts;
  const prune: string[] = [];
  for (const key of Object.keys(c.agents)) {
    const a = c.agents[key]!;
    if (TERMINAL_STATUSES.has(a.status)) {
      if (now - (a.endedAt ?? a.statusAt) > c.o.pruneAfterMs) prune.push(key);
      continue;
    }
    if (a.status === 'unknown' || a.stale || a.statusSource === 'registry') continue;
    const running = a.currentToolId ? a.tools.find((t) => t.id === a.currentToolId) : undefined;
    const quietFor = now - a.lastEventAt;
    const limit = running ? c.o.staleToolAfterMs : c.o.staleAfterMs;
    // Idle sessions are expected to be quiet; only active states go stale.
    if (a.status !== 'idle' && quietFor > limit) c.edit(key).stale = true;
  }
  // Keep the agent table bounded: drop the oldest terminal agents first.
  const total = Object.keys(c.agents).length - prune.length;
  if (total > c.o.maxAgents) {
    const terminal = Object.values(c.agents)
      .filter((a) => TERMINAL_STATUSES.has(a.status) && !prune.includes(a.key))
      .sort((x, y) => (x.endedAt ?? x.statusAt) - (y.endedAt ?? y.statusAt));
    prune.push(...terminal.slice(0, total - c.o.maxAgents).map((a) => a.key));
  }
  if (!prune.length) return;
  const pruneSet = new Set(prune);
  // Finished children go with their pruned session or parent, so no orphan is left behind.
  for (let changed = true, depth = 0; changed && depth < 10; depth++) {
    changed = false;
    for (const key of Object.keys(c.agents)) {
      const a = c.agents[key]!;
      if (pruneSet.has(key) || a.kind === 'session' || !TERMINAL_STATUSES.has(a.status)) continue;
      if (pruneSet.has(agentKeyFor(a.sessionId)) || (a.parentKey !== undefined && pruneSet.has(a.parentKey))) {
        pruneSet.add(key);
        changed = true;
      }
    }
  }
  for (const key of pruneSet) c.removeAgent(key);
  const prunedSessions = new Set([...pruneSet].filter((k) => !k.includes('::')));
  if (prunedSessions.size) {
    const kept = Object.fromEntries(Object.entries(c.tasks).filter(([, t]) => !prunedSessions.has(t.sessionId)));
    if (Object.keys(kept).length !== Object.keys(c.tasks).length) c.tasks = kept;
  }
}

function onRestored(c: Ctx): void {
  for (const key of Object.keys(c.agents)) {
    const a = c.agents[key]!;
    if (TERMINAL_STATUSES.has(a.status) || a.status === 'unknown') continue;
    const e = c.edit(key);
    e.lastKnownStatus = a.status;
    e.status = 'unknown';
    e.statusSource = 'system';
    e.statusDetail = 'Monitor restarted; waiting for live data';
    e.stale = undefined;
    e.pendingPermission = undefined;
    for (let i = 0; i < e.tools.length; i++) {
      const t = e.tools[i]!;
      if (t.status === 'running' || t.status === 'awaiting_permission') e.tools[i] = { ...t, status: 'unknown', note: 'Monitor restarted while running' };
    }
    e.currentToolId = undefined;
  }
}
