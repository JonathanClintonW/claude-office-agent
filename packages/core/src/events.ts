import { safeMultiline, safeText, summarizeToolInput, truncate } from './sanitize';

/** Hook events the monitor subscribes to. The first 13 are the required set. */
export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
  // Optional extras that make status more accurate when available.
  'UserPromptSubmit',
  'StopFailure',
  'PermissionDenied',
  'PreCompact',
  'PostCompact',
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

const HOOK_EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS);

export function isKnownHookEvent(name: string): name is HookEventName {
  return HOOK_EVENT_SET.has(name);
}

/** Where a piece of information came from. Shown in the UI so status is never ambiguous. */
export type Source = 'hook' | 'registry' | 'transcript' | 'system';

export interface ToolRef {
  name: string;
  /** tool_use_id; absent for PermissionRequest and older Claude Code versions. */
  useId?: string;
  summary: string;
  target?: string;
  mcpServer?: string;
}

export interface TaskFields {
  taskId: string;
  subject?: string;
  description?: string;
  teammateName?: string;
  teamName?: string;
}

export type EventBody =
  | { kind: 'SessionStart'; startSource?: string; model?: string; title?: string }
  | { kind: 'SessionEnd'; reason?: string }
  | { kind: 'SubagentStart' }
  | { kind: 'SubagentStop'; lastMessage?: string; agentTranscriptPath?: string }
  | { kind: 'PreToolUse'; tool: ToolRef }
  | { kind: 'PostToolUse'; tool: ToolRef; durationMs?: number; success?: boolean }
  | { kind: 'PostToolUseFailure'; tool: ToolRef; error?: string; isInterrupt?: boolean; durationMs?: number }
  | { kind: 'PermissionRequest'; tool: ToolRef }
  | { kind: 'PermissionDenied'; tool: ToolRef; reason?: string }
  | { kind: 'Notification'; notificationType?: string; message?: string; title?: string }
  | { kind: 'Stop'; lastMessage?: string; backgroundRunning?: number }
  | { kind: 'StopFailure'; error?: string; lastMessage?: string }
  | ({ kind: 'TaskCreated' } & TaskFields)
  | ({ kind: 'TaskCompleted' } & TaskFields)
  | { kind: 'TeammateIdle'; teammateName?: string; teamName?: string }
  | { kind: 'UserPromptSubmit' }
  | { kind: 'PreCompact'; trigger?: string }
  | { kind: 'PostCompact'; trigger?: string }
  /** A hook event this build does not model. Recorded, never used to infer status. */
  | { kind: 'UnknownHook'; hookEventName: string }
  // Monitor-generated events (read-only discovery and housekeeping).
  | {
      kind: 'RegistryStatus';
      pid: number;
      alive: boolean;
      status?: string;
      waitingFor?: string;
      name?: string;
      entrypoint?: string;
      version?: string;
      startedAt?: number;
    }
  | { kind: 'RegistryGone'; pid?: number }
  | {
      kind: 'TranscriptSeen';
      title?: string;
      model?: string;
      lastActivityAt?: number;
      usage?: TokenUsage;
      live?: boolean;
    }
  | {
      kind: 'TranscriptSubagentSeen';
      description?: string;
      finished?: boolean;
      lastActivityAt?: number;
      spawnToolUseId?: string;
    }
  /** Periodic clock event; lets the reducer flag stale agents deterministically. */
  | { kind: 'Tick' }
  /** Applied once after loading a persisted snapshot: live state is unverified. */
  | { kind: 'Restored' };

export interface TokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** When the API call that reported this usage happened. */
  at?: number;
}

export interface EventBase {
  /** Monotonic sequence assigned by the monitor. 0 until assigned. */
  seq: number;
  /** Epoch ms when the event happened (forwarder capture time) or was observed. */
  ts: number;
  source: Source;
  /** Session the event belongs to. '*' for global housekeeping events. */
  sessionId: string;
  agentId?: string;
  agentType?: string;
  cwd?: string;
  transcriptPath?: string;
  permissionMode?: string;
}

export type MonitorEvent = EventBase & EventBody;
export type Body<K extends EventBody['kind']> = Extract<EventBody, { kind: K }>;
export type EventOf<K extends EventBody['kind']> = EventBase & Body<K>;
export type EventKind = EventBody['kind'];

export type NormalizeResult = { ok: true; event: MonitorEvent } | { ok: false; error: string };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;

export function isValidId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

function optString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  return truncate(v, max);
}

function optNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function toolRef(p: Record<string, unknown>): ToolRef | string {
  const name = p.tool_name;
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return 'missing or invalid tool_name';
  const useId = p.tool_use_id;
  if (useId !== undefined && !isValidId(useId)) return 'invalid tool_use_id';
  const s = summarizeToolInput(name, p.tool_input);
  const ref: ToolRef = { name, summary: s.summary };
  if (typeof useId === 'string') ref.useId = useId;
  if (s.target) ref.target = s.target;
  const mcp = p.mcp_server;
  if (mcp && typeof mcp === 'object' && typeof (mcp as Record<string, unknown>).name === 'string') {
    ref.mcpServer = truncate((mcp as Record<string, unknown>).name as string, 80);
  } else if (s.mcpServer) {
    ref.mcpServer = s.mcpServer;
  }
  return ref;
}

function taskFields(p: Record<string, unknown>): TaskFields | string {
  const raw = p.task_id;
  const taskId = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
  if (!isValidId(taskId)) return 'missing or invalid task_id';
  const out: TaskFields = { taskId };
  const subject = safeText(p.task_subject, 200);
  const description = safeMultiline(p.task_description, 800);
  const teammateName = safeText(p.teammate_name, 80);
  const teamName = safeText(p.team_name, 80);
  if (subject) out.subject = subject;
  if (description) out.description = description;
  if (teammateName) out.teammateName = teammateName;
  if (teamName) out.teamName = teamName;
  return out;
}

const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_EVENT_AGE_MS = 7 * 24 * 3600_000;

/**
 * Validate and normalise a hook payload: raw hook JSON (HTTP hook) or the forwarder envelope `{ v: 1, ts, payload }`.
 * Unknown fields are ignored; required identifiers are validated strictly so malformed input never creates phantom agents.
 */
export function normalizeHookPayload(input: unknown, receivedAt: number): NormalizeResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'payload must be an object' };
  let p = input as Record<string, unknown>;
  let ts = receivedAt;
  if (p.v === 1 && p.payload && typeof p.payload === 'object' && !Array.isArray(p.payload)) {
    const t = p.ts;
    if (typeof t === 'number' && Number.isFinite(t) && t <= receivedAt + MAX_CLOCK_SKEW_MS && t >= receivedAt - MAX_EVENT_AGE_MS) {
      ts = t;
    }
    p = p.payload as Record<string, unknown>;
  }

  const hookEventName = p.hook_event_name;
  if (typeof hookEventName !== 'string' || !/^[A-Za-z]{1,64}$/.test(hookEventName)) {
    return { ok: false, error: 'missing or invalid hook_event_name' };
  }
  const sessionId = p.session_id;
  if (!isValidId(sessionId)) return { ok: false, error: 'missing or invalid session_id' };
  const agentId = p.agent_id;
  if (agentId !== undefined && agentId !== null && !isValidId(agentId)) return { ok: false, error: 'invalid agent_id' };

  const base: EventBase = { seq: 0, ts, source: 'hook', sessionId };
  if (typeof agentId === 'string') base.agentId = agentId;
  const agentType = optString(p.agent_type, 100);
  if (agentType) base.agentType = agentType;
  const cwd = optString(p.cwd, 1024);
  if (cwd) base.cwd = cwd;
  const transcriptPath = optString(p.transcript_path, 1024);
  if (transcriptPath) base.transcriptPath = transcriptPath;
  const permissionMode = optString(p.permission_mode, 40);
  if (permissionMode) base.permissionMode = permissionMode;

  const fail = (error: string): NormalizeResult => ({ ok: false, error: `${hookEventName}: ${error}` });
  const ok = (body: EventBody): NormalizeResult => ({ ok: true, event: { ...base, ...body } as MonitorEvent });

  switch (hookEventName) {
    case 'SessionStart': {
      const body: Body<'SessionStart'> = { kind: 'SessionStart' };
      const src = optString(p.source, 40);
      const model = optString(p.model, 100);
      const title = safeText(p.session_title, 160);
      if (src) body.startSource = src;
      if (model) body.model = model;
      if (title) body.title = title;
      return ok(body);
    }
    case 'SessionEnd': {
      const reason = optString(p.reason, 60);
      return ok(reason ? { kind: 'SessionEnd', reason } : { kind: 'SessionEnd' });
    }
    case 'SubagentStart':
      if (!base.agentId) return fail('agent_id is required');
      return ok({ kind: 'SubagentStart' });
    case 'SubagentStop': {
      if (!base.agentId) return fail('agent_id is required');
      const body: Body<'SubagentStop'> = { kind: 'SubagentStop' };
      const msg = safeMultiline(p.last_assistant_message, 600);
      const atp = optString(p.agent_transcript_path, 1024);
      if (msg) body.lastMessage = msg;
      if (atp) body.agentTranscriptPath = atp;
      return ok(body);
    }
    case 'PreToolUse':
    case 'PermissionRequest': {
      const tool = toolRef(p);
      if (typeof tool === 'string') return fail(tool);
      return ok({ kind: hookEventName, tool });
    }
    case 'PostToolUse': {
      const tool = toolRef(p);
      if (typeof tool === 'string') return fail(tool);
      const body: Body<'PostToolUse'> = { kind: 'PostToolUse', tool };
      const d = optNumber(p.duration_ms);
      if (d !== undefined) body.durationMs = d;
      const r = p.tool_response;
      if (r && typeof r === 'object' && !Array.isArray(r) && typeof (r as Record<string, unknown>).success === 'boolean') {
        body.success = (r as Record<string, unknown>).success as boolean;
      }
      return ok(body);
    }
    case 'PostToolUseFailure': {
      const tool = toolRef(p);
      if (typeof tool === 'string') return fail(tool);
      const body: Body<'PostToolUseFailure'> = { kind: 'PostToolUseFailure', tool };
      const err = safeMultiline(p.error, 400);
      if (err) body.error = err;
      if (p.is_interrupt === true) body.isInterrupt = true;
      const d = optNumber(p.duration_ms);
      if (d !== undefined) body.durationMs = d;
      return ok(body);
    }
    case 'PermissionDenied': {
      const tool = toolRef(p);
      if (typeof tool === 'string') return fail(tool);
      const reason = safeText(p.reason, 300);
      return ok(reason ? { kind: 'PermissionDenied', tool, reason } : { kind: 'PermissionDenied', tool });
    }
    case 'Notification': {
      const body: Body<'Notification'> = { kind: 'Notification' };
      const nt = optString(p.notification_type, 60);
      const message = safeText(p.message, 300);
      const title = safeText(p.title, 120);
      if (nt) body.notificationType = nt;
      if (message) body.message = message;
      if (title) body.title = title;
      return ok(body);
    }
    case 'Stop': {
      const body: Body<'Stop'> = { kind: 'Stop' };
      const msg = safeMultiline(p.last_assistant_message, 600);
      if (msg) body.lastMessage = msg;
      if (Array.isArray(p.background_tasks)) {
        body.backgroundRunning = p.background_tasks.filter(
          (t) => t && typeof t === 'object' && (t as Record<string, unknown>).status === 'running',
        ).length;
      }
      return ok(body);
    }
    case 'StopFailure': {
      const body: Body<'StopFailure'> = { kind: 'StopFailure' };
      const err = optString(p.error, 60);
      const msg = safeMultiline(p.last_assistant_message, 400);
      if (err) body.error = err;
      if (msg) body.lastMessage = msg;
      return ok(body);
    }
    case 'TaskCreated':
    case 'TaskCompleted': {
      const t = taskFields(p);
      if (typeof t === 'string') return fail(t);
      return ok({ kind: hookEventName, ...t });
    }
    case 'TeammateIdle': {
      const body: Body<'TeammateIdle'> = { kind: 'TeammateIdle' };
      const tn = safeText(p.teammate_name, 80);
      const team = safeText(p.team_name, 80);
      if (tn) body.teammateName = tn;
      if (team) body.teamName = team;
      return ok(body);
    }
    case 'UserPromptSubmit':
      // The prompt text is intentionally discarded.
      return ok({ kind: 'UserPromptSubmit' });
    case 'PreCompact':
    case 'PostCompact': {
      const trigger = optString(p.trigger, 20);
      return ok(trigger ? { kind: hookEventName, trigger } : { kind: hookEventName });
    }
    default:
      return ok({ kind: 'UnknownHook', hookEventName });
  }
}

/** Build a monitor-generated event (registry, transcript, system). */
export function systemEvent<B extends EventBody>(
  body: B,
  fields: Omit<EventBase, 'seq' | 'source'> & { source?: Source },
): MonitorEvent {
  return { seq: 0, source: fields.source ?? 'system', ...fields, ...body } as MonitorEvent;
}
