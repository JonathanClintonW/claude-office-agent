/**
 * Usage analytics and history contracts. Every number carries its source so the UI never presents an
 * estimate as an observation: `transcript` (tokens Claude Code recorded), `claude-code` (its own `cost-state`
 * records) or `price-table` (estimate from the user's `<home>/pricing.json`). No price is ever built in or guessed.
 */
import type { MonitorEvent } from '../events';

export type UsageSource = 'transcript' | 'claude-code' | 'price-table';

export const USAGE_SOURCE_LABEL: Record<UsageSource, string> = {
  transcript: 'Transcript-observed',
  'claude-code': 'Reported by Claude Code',
  'price-table': 'Estimate from your price table',
};

/** Token counts summed from assistant `message.usage` records (deduplicated by `message.id`). */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface UsageBucket extends TokenCounts {
  /** Distinct assistant messages (API responses) counted. */
  messages: number;
}

/** Prices per million tokens, in the table's currency. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Price for `cache_creation_input_tokens`. Omit to leave cache writes unpriced. */
  cacheWritePerMTok?: number;
  /** Price for `cache_read_input_tokens`. Omit to leave cache reads unpriced. */
  cacheReadPerMTok?: number;
}

/**
 * `<home>/pricing.json`. Keys of `models` are exact model ids (`claude-x-1`) or prefixes ending
 * in `*` (`claude-x-*`); an exact key wins, otherwise the longest matching prefix.
 */
export interface PriceTable {
  version: 1;
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
  /** Optional free text shown next to estimates (e.g. where the prices came from). */
  note?: string;
  models: Record<string, ModelPrice>;
}

export type PricingStatus =
  | { state: 'none'; message: 'no price table configured'; file: 'pricing.json' }
  | { state: 'invalid'; error: string; file: 'pricing.json' }
  | { state: 'ok'; currency: string; models: number; note?: string; file: 'pricing.json'; loadedAt: number };

export interface CostEstimate {
  source: 'price-table';
  currency: string;
  amount: number;
  /** True when some tokens could not be priced (see the two lists). */
  partial: boolean;
  /** Models with tokens but no matching price entry: their tokens are excluded. */
  unpricedModels: string[];
  /** Models whose cache tokens were excluded because the entry has no cache price. */
  unpricedCacheModels: string[];
}

export interface ReportedModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

/** The latest `cost-state` record of a session transcript, verbatim numbers only. */
export interface ReportedCost {
  source: 'claude-code';
  totalCostUSD?: number;
  /** `totalAPIDuration` as recorded (milliseconds). */
  totalAPIDurationMs?: number;
  /** Timestamp of the record, when present. */
  at?: number;
  modelUsage?: Record<string, ReportedModelUsage>;
}

export type UsageAgentKind = 'main' | 'subagent' | 'sidechain';

export interface UsageAgentRow {
  sessionId: string;
  /** 'main', a subagent id, or 'sidechain' (sidechain records in the main transcript without an agent id). */
  agent: string;
  kind: UsageAgentKind;
  agentType?: string;
  total: UsageBucket;
  byModel: Record<string, UsageBucket>;
  estimate?: CostEstimate;
}

export interface UsageSessionRow {
  sessionId: string;
  title?: string;
  cwd?: string;
  /** normalizePathKey(cwd) */
  projectKey?: string;
  /** baseName(cwd) */
  project?: string;
  /** Timestamps of the first/last assistant message counted. */
  firstAt?: number;
  lastAt?: number;
  /** Whole session: main thread + subagents. */
  total: UsageBucket;
  byModel: Record<string, UsageBucket>;
  /** Subagent transcripts (and unattributed sidechains) only. */
  subagentTotal: UsageBucket;
  subagents: number;
  reported?: ReportedCost;
  estimate?: CostEstimate;
  /** All bytes of all known transcript files have been read. */
  complete: boolean;
  /** The session is currently present in the monitor state. */
  inState: boolean;
}

export interface UsageSessionDetail extends UsageSessionRow {
  agents: UsageAgentRow[];
  /** False when the session is not (yet) tracked: no transcript found. */
  tracked: boolean;
  transcriptFound: boolean;
}

export interface UsageProjectRow {
  key: string;
  label: string;
  cwd?: string;
  sessions: number;
  total: UsageBucket;
  estimate?: CostEstimate;
  /** Sum of the latest reported cost of each session that has one. */
  reportedCostUSD?: number;
  reportedSessions: number;
}

export interface UsageModelRow {
  model: string;
  total: UsageBucket;
  estimate?: CostEstimate;
}

export interface UsageScanStatus {
  lastScanAt?: number;
  lastScanMs?: number;
  sessionsTracked: number;
  filesTracked: number;
  /** Bytes appended to tracked transcripts that have not been read yet. */
  backlogBytes: number;
  /** Files currently skipped because a read exceeded its time budget. */
  slowFiles: number;
  skipped: {
    /** Assistant records without a message id (cannot be deduplicated, so not counted). */
    noMessageId: number;
    unparsableLines: number;
    oversizedLines: number;
    /** Messages already counted for another session (e.g. a resumed conversation). */
    crossSessionDuplicates: number;
  };
  /** Sessions re-read from the start after a transcript shrank or was replaced. */
  resets: number;
}

export interface UsageSummary {
  source: 'transcript';
  generatedAt: number;
  total: UsageBucket;
  byModel: UsageModelRow[];
  byProject: UsageProjectRow[];
  sessions: UsageSessionRow[];
  /** Largest sessions' agents (main thread and subagents), most tokens first. */
  agents: UsageAgentRow[];
  /** Sum over sessions of the latest cost Claude Code reported; null when none reported. */
  reported: { source: 'claude-code'; sessions: number; totalCostUSD: number } | null;
  estimate?: CostEstimate;
  pricing: PricingStatus;
  scan: UsageScanStatus;
}

export interface UsageMeta {
  sessionsTracked: number;
  filesTracked: number;
  lastScanAt?: number;
  backlogBytes: number;
  pricing: PricingStatus['state'];
}

export interface HistorySessionEntry {
  sessionId: string;
  /** First/last journaled event time for this session. */
  firstTs: number;
  lastTs: number;
  cwd?: string;
  projectKey?: string;
  project?: string;
  title?: string;
  model?: string;
  simulated?: boolean;
  ended: boolean;
  endedAt?: number;
  /** Journaled events (Tick excluded). */
  events: number;
  /** Main session plus distinct subagents/teammates seen. */
  agents: number;
  /** Distinct task ids seen (TaskCreated or TaskCompleted). */
  tasks: number;
  /** Distinct task ids with a TaskCompleted event. */
  tasksCompleted: number;
  /** PreToolUse events. */
  toolCalls: number;
  /** PostToolUseFailure (not interrupts) + PostToolUse with success=false. */
  toolFailures: number;
  toolInterrupts: number;
  permissionRequests: number;
  /** Stop events. */
  turns: number;
  /** StopFailure events. */
  turnFailures: number;
  /** Journal day files (UTC, YYYY-MM-DD) holding this session's events. */
  days: string[];
  /** Older events of this session were removed by retention. */
  partial?: boolean;
}

export interface HistoryProjectOption {
  key: string;
  label: string;
  count: number;
}

export interface HistorySessionsResult {
  sessions: HistorySessionEntry[];
  /** Matching sessions before the limit was applied. */
  total: number;
  projects: HistoryProjectOption[];
}

export interface HistoryEventsResult {
  sessionId: string;
  events: MonitorEvent[];
  /** Pass as `cursor` to get the next page. Absent when done. */
  nextCursor?: number;
  done: boolean;
  /** Matching events (after from/to filtering) across all pages. */
  total: number;
  /** The session has more journaled events than the per-session read cap; the oldest are returned. */
  capped?: boolean;
}

export interface HistorySummary {
  sessions: number;
  events: number;
  days: Array<{ day: string; bytes: number }>;
  totalBytes: number;
  retentionDays: number;
  maxTotalBytes: number;
  oldestDay?: string;
  newestDay?: string;
  lastFlushAt?: number;
  bufferedEvents: number;
  droppedEvents: number;
  writeErrors: number;
  totals: {
    toolCalls: number;
    toolFailures: number;
    tasks: number;
    tasksCompleted: number;
    turns: number;
    turnFailures: number;
  };
}

export interface HistoryMeta {
  sessions: number;
  bufferedEvents: number;
  totalBytes: number;
  retentionDays: number;
  lastFlushAt?: number;
  writeErrors: number;
  droppedEvents: number;
}
