// Pure session replay (state at time t) and the player model.
import { createInitialState, DEFAULT_REDUCER_OPTIONS, reduce, type MonitorEvent, type OfficeState, type ReducerOptions } from '@agent-office/core';
import type { WorkerView } from './office/scene';
import { toWorkerViews } from './view';

/**
 * Replay re-applies a session's journaled events, in the monitor's apply order, through the live
 * reducer, so statuses, tools and tasks are exactly what the office showed; only movement and
 * animation are reconstructed. Timestamps are not monotone (async hooks, spool replays), so an
 * event's replay clock is the running max of the timestamps up to it.
 */

export const REPLAY_SPEEDS = [1, 2, 4, 8, 16] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export interface ReplayTimeline {
  readonly events: readonly MonitorEvent[];
  /** Replay clock per event (running max of ts). */
  readonly times: readonly number[];
  readonly start: number;
  readonly end: number;
  readonly checkpointEvery: number;
  /** checkpoints[k] = state after k * checkpointEvery events. */
  readonly checkpoints: readonly OfficeState[];
  readonly options: ReducerOptions;
  /** Last computed position, so playing forward applies only the new events. */
  cursor: { index: number; state: OfficeState };
}

export interface ReplayOptions {
  checkpointEvery?: number;
  reducer?: ReducerOptions;
}

export function buildReplay(input: readonly MonitorEvent[], opts: ReplayOptions = {}): ReplayTimeline {
  const every = Math.max(1, Math.floor(opts.checkpointEvery ?? 250));
  const options = opts.reducer ?? DEFAULT_REDUCER_OPTIONS;
  const events = input.filter((e) => e.kind !== 'Tick');
  const times: number[] = [];
  let clock = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    clock = Math.max(clock, e.ts);
    times.push(clock);
  }
  const checkpoints: OfficeState[] = [];
  let state = createInitialState();
  checkpoints.push(state);
  for (let i = 0; i < events.length; i++) {
    state = reduce(state, events[i]!, options);
    if ((i + 1) % every === 0) checkpoints.push(state);
  }
  const start = events.length ? times[0]! : 0;
  const end = events.length ? times[times.length - 1]! : 0;
  return { events, times, start, end, checkpointEvery: every, checkpoints, options, cursor: { index: events.length, state } };
}

/** State after the first `n` events (0 <= n <= events.length). */
export function stateAtIndex(tl: ReplayTimeline, n: number): OfficeState {
  const target = Math.max(0, Math.min(tl.events.length, Math.floor(n)));
  let index: number;
  let state: OfficeState;
  const c = tl.cursor;
  if (c.index <= target && target - c.index <= tl.checkpointEvery) {
    index = c.index;
    state = c.state;
  } else {
    const k = Math.floor(target / tl.checkpointEvery);
    index = k * tl.checkpointEvery;
    state = tl.checkpoints[k]!;
  }
  for (; index < target; index++) state = reduce(state, tl.events[index]!, tl.options);
  tl.cursor = { index: target, state };
  return state;
}

/** Number of events whose replay clock is <= t. */
export function indexAtTime(tl: ReplayTimeline, t: number): number {
  let lo = 0;
  let hi = tl.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tl.times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function stateAtTime(tl: ReplayTimeline, t: number): OfficeState {
  return stateAtIndex(tl, indexAtTime(tl, t));
}

export interface PlayerState {
  playing: boolean;
  speed: ReplaySpeed;
  /** Replay clock (epoch ms). */
  position: number;
}

export function createPlayer(tl: ReplayTimeline): PlayerState {
  return { playing: false, speed: 1, position: tl.start };
}

function clampPos(tl: ReplayTimeline, t: number): number {
  return Math.max(tl.start, Math.min(tl.end, Number.isFinite(t) ? t : tl.start));
}

export function play(tl: ReplayTimeline, p: PlayerState): PlayerState {
  if (!tl.events.length) return { ...p, playing: false };
  return { ...p, playing: true, position: p.position >= tl.end ? tl.start : p.position };
}

export function pause(p: PlayerState): PlayerState {
  return p.playing ? { ...p, playing: false } : p;
}

export function togglePlay(tl: ReplayTimeline, p: PlayerState): PlayerState {
  return p.playing ? pause(p) : play(tl, p);
}

/** Snap to the closest supported speed (1x to 16x). */
export function setSpeed(p: PlayerState, speed: number): PlayerState {
  let best: ReplaySpeed = REPLAY_SPEEDS[0];
  for (const s of REPLAY_SPEEDS) if (Math.abs(s - speed) < Math.abs(best - speed)) best = s;
  return { ...p, speed: best };
}

export function seek(tl: ReplayTimeline, p: PlayerState, t: number): PlayerState {
  return { ...p, position: clampPos(tl, t) };
}

/** Jump to the next (dir 1) or previous (dir -1) event time and pause. */
export function stepEvent(tl: ReplayTimeline, p: PlayerState, dir: 1 | -1): PlayerState {
  if (!tl.events.length) return pause(p);
  if (dir > 0) {
    const i = indexAtTime(tl, p.position);
    return { ...p, playing: false, position: i < tl.times.length ? tl.times[i]! : tl.end };
  }
  // Last event time strictly before the position.
  let lo = 0;
  let hi = tl.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tl.times[mid]! < p.position) lo = mid + 1;
    else hi = mid;
  }
  return { ...p, playing: false, position: lo > 0 ? tl.times[lo - 1]! : tl.start };
}

export interface AdvanceOptions {
  /** Jump straight across quiet gaps longer than this (replay time). The UI labels it. */
  skipGapsOverMs?: number;
}

/** Advance the clock by `realMs` of wall time at the current speed; stops at the end. */
export function advance(tl: ReplayTimeline, p: PlayerState, realMs: number, opts: AdvanceOptions = {}): PlayerState {
  if (!p.playing || realMs <= 0) return p;
  let position = p.position;
  if (opts.skipGapsOverMs !== undefined) {
    const i = indexAtTime(tl, position);
    const next = i < tl.times.length ? tl.times[i]! : undefined;
    if (next !== undefined && next - position > opts.skipGapsOverMs) position = next - Math.min(opts.skipGapsOverMs, 1000);
  }
  position += realMs * p.speed;
  if (position >= tl.end) return { ...p, position: tl.end, playing: false };
  return { ...p, position };
}

export interface LoadedSessionEvents {
  events: MonitorEvent[];
  /** Matching events reported by the monitor. */
  total: number;
  /** Fewer events than `total` were loaded (UI cap or monitor read cap). */
  truncated: boolean;
}

type EventsPage = { events?: MonitorEvent[]; done?: boolean; nextCursor?: number; total?: number; capped?: boolean };

/** Fetch every page of `history.events` for a session, up to `cap` events. */
export async function fetchSessionEvents(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  sessionId: string,
  cap = 50_000,
  pageSize = 5000,
): Promise<LoadedSessionEvents> {
  const events: MonitorEvent[] = [];
  let cursor = 0;
  let total = 0;
  let capped = false;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = (await rpc('history.events', { sessionId, cursor, limit: Math.min(pageSize, cap - events.length) })) as EventsPage;
    const got = Array.isArray(page?.events) ? page.events : [];
    events.push(...got);
    total = typeof page?.total === 'number' ? page.total : events.length;
    capped ||= page?.capped === true;
    if (page?.done || page?.nextCursor === undefined || !got.length || events.length >= cap) break;
    cursor = page.nextCursor;
  }
  return { events, total, truncated: capped || events.length < total };
}

export interface TimelineEvent {
  index: number;
  time: number;
  event: MonitorEvent;
}

/** The `count` most recent events at or before `t` (oldest first). */
export function eventsBefore(tl: ReplayTimeline, t: number, count = 12): TimelineEvent[] {
  const n = indexAtTime(tl, t);
  const out: TimelineEvent[] = [];
  for (let i = Math.max(0, n - count); i < n; i++) out.push({ index: i, time: tl.times[i]!, event: tl.events[i]! });
  return out;
}

/**
 * Worker views for the office scene at replay time `position`. The scene times effects
 * (celebrations, lingering finished agents) against the wall clock, so historical
 * timestamps are shifted by (wallNow - position).
 */
export function replayWorkerViews(state: OfficeState, position: number, wallNow: number): WorkerView[] {
  const offset = wallNow - position;
  return toWorkerViews(Object.values(state.agents)).map((v) => {
    const out: WorkerView = { ...v };
    if (v.turnCompletedAt !== undefined) out.turnCompletedAt = v.turnCompletedAt + offset;
    if (v.terminalAt !== undefined) out.terminalAt = v.terminalAt + offset;
    if (v.failure) out.failure = { ...v.failure, at: v.failure.at + offset };
    if (v.lastTestPassAt !== undefined) out.lastTestPassAt = v.lastTestPassAt + offset;
    return out;
  });
}

export interface TimelineBar {
  start: number;
  end: number;
  events: number;
  /** Events described with the 'bad' tone (tool errors, failed turns). */
  errors: number;
  /** Events described with the 'warn' tone (permission prompts, interrupts, restarts). */
  warnings: number;
}

/** Event density in `n` equal slices of the replay clock (for the scrubber). */
export function timelineBars(tl: ReplayTimeline, n = 120): TimelineBar[] {
  const count = Math.max(1, Math.floor(n));
  const span = Math.max(1, tl.end - tl.start);
  const width = span / count;
  const bars: TimelineBar[] = [];
  for (let i = 0; i < count; i++) bars.push({ start: tl.start + i * width, end: tl.start + (i + 1) * width, events: 0, errors: 0, warnings: 0 });
  for (let i = 0; i < tl.events.length; i++) {
    const b = bars[Math.min(count - 1, Math.floor((tl.times[i]! - tl.start) / width))]!;
    b.events += 1;
    const tone = describeEvent(tl.events[i]!).tone;
    if (tone === 'bad') b.errors += 1;
    else if (tone === 'warn') b.warnings += 1;
  }
  return bars;
}

export type EventTone = 'ok' | 'bad' | 'warn' | 'info' | 'muted';

const clip = (s: string | undefined, max = 90) => {
  const l = (s ?? '').split('\n')[0]!.trim();
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
};

/** One-line description of an event for the timeline. Uses only the sanitized summary fields. */
export function describeEvent(ev: MonitorEvent): { text: string; tone: EventTone } {
  switch (ev.kind) {
    case 'SessionStart':
      return { text: `Session started${ev.startSource ? ` (${ev.startSource})` : ''}${ev.model ? ` · ${ev.model}` : ''}`, tone: 'info' };
    case 'SessionEnd':
      return { text: `Session ended${ev.reason ? ` (${clip(ev.reason, 40)})` : ''}`, tone: 'muted' };
    case 'SubagentStart':
      return { text: `${ev.agentType ?? 'Subagent'} started`, tone: 'info' };
    case 'SubagentStop':
      return { text: `${ev.agentType ?? 'Subagent'} finished`, tone: 'ok' };
    case 'PreToolUse':
      return { text: `▶ ${ev.tool.name}: ${clip(ev.tool.summary)}`, tone: 'info' };
    case 'PostToolUse':
      return ev.success === false ? { text: `✗ ${ev.tool.name} reported failure`, tone: 'bad' } : { text: `✓ ${ev.tool.name}`, tone: 'ok' };
    case 'PostToolUseFailure':
      return ev.isInterrupt
        ? { text: `■ ${ev.tool.name} interrupted`, tone: 'warn' }
        : { text: `✗ ${ev.tool.name} failed${ev.error ? `: ${clip(ev.error, 70)}` : ''}`, tone: 'bad' };
    case 'PermissionRequest':
      return { text: `Permission requested: ${ev.tool.name}`, tone: 'warn' };
    case 'PermissionDenied':
      return { text: `Permission denied: ${ev.tool.name}`, tone: 'warn' };
    case 'Notification':
      return { text: `Notification: ${(ev.notificationType ?? 'unknown').replace(/_/g, ' ')}`, tone: 'muted' };
    case 'Stop':
      return { text: 'Turn complete', tone: 'ok' };
    case 'StopFailure':
      return { text: `Turn failed (${clip(ev.error, 40) || 'unknown error'})`, tone: 'bad' };
    case 'TaskCreated':
      return { text: `Task created: ${clip(ev.subject, 70) || ev.taskId}`, tone: 'info' };
    case 'TaskCompleted':
      return { text: `Task completed: ${clip(ev.subject, 70) || ev.taskId}`, tone: 'ok' };
    case 'TeammateIdle':
      return { text: `${ev.teammateName ?? 'Teammate'} idle`, tone: 'muted' };
    case 'UserPromptSubmit':
      return { text: 'Prompt submitted', tone: 'info' };
    case 'PreCompact':
      return { text: 'Compacting context', tone: 'muted' };
    case 'PostCompact':
      return { text: 'Context compacted', tone: 'muted' };
    case 'UnknownHook':
      return { text: `Unrecognised hook ${ev.hookEventName}`, tone: 'muted' };
    case 'RegistryStatus':
      return { text: `Registry: ${ev.alive ? (ev.status ?? 'running') : 'process exited'}`, tone: ev.alive ? 'muted' : 'warn' };
    case 'RegistryGone':
      return { text: 'Left the session registry', tone: 'muted' };
    case 'TranscriptSeen':
      return { text: 'Transcript activity seen', tone: 'muted' };
    case 'TranscriptSubagentSeen':
      return { text: `Subagent seen in transcript${ev.finished ? ' (finished)' : ''}`, tone: 'muted' };
    case 'Restored':
      return { text: 'Monitor restarted (live status unverified)', tone: 'warn' };
    case 'Tick':
      return { text: 'Clock tick', tone: 'muted' };
  }
}
