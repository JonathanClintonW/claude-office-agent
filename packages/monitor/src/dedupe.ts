/**
 * Duplicate hook-event filter. Pure: no I/O, no timers, no globals.
 *
 * When Agent Office hooks are installed in two scopes (user settings and a project's
 * `.claude/settings.local.json`), Claude Code runs both handlers and every event arrives twice.
 * A forwarder whose POST timed out after the monitor had already accepted it also spools a
 * second copy. Both copies carry the same payload and (almost) the same capture time.
 *
 * An event is a duplicate only when an earlier event had the same fingerprint AND a capture
 * time within `windowMs`. The fingerprint covers session, agent, hook event, tool_use_id, tool
 * name, notification type, task id and a hash of the whole remaining payload, so events that
 * differ in any field (two tool uses without ids but different inputs) are never merged, and an
 * identical event repeated outside the window (a Notification minutes later) is kept.
 *
 * Limitation (inherent): two byte-identical payloads captured within `windowMs` cannot be told
 * apart from a duplicated delivery and are treated as one.
 *
 * Use one input form consistently: raw payloads (preferred, the most precise) or normalized
 * events. Only fingerprints and timestamps are retained, never payload content.
 */
import type { MonitorEvent } from '@agent-office/core';

export interface DeduperOptions {
  /** Copies whose capture times differ by at most this many ms are duplicates (default 2000). */
  windowMs?: number;
  /** Fingerprints are remembered for this long after they were last seen (default max(60 s, 30 x window)). */
  retainMs?: number;
  /** Upper bound on remembered fingerprints (default 4096); the oldest are evicted first. */
  maxEntries?: number;
}

export interface Deduper {
  /**
   * True when `input` repeats an event seen within the window; false records it as seen.
   * Accepts a raw hook payload, a forwarder envelope `{ v: 1, ts, payload }` or a normalized
   * MonitorEvent. `receivedAt` is the arrival time, used when the input has no capture time.
   * Inputs that are not hook events are never duplicates.
   */
  isDuplicate(input: unknown, receivedAt: number): boolean;
  readonly size: number;
  clear(): void;
}

export interface HookFingerprint {
  key: string;
  /** Capture time of this copy (ms), when the input carries one. */
  ts?: number;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const part = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** JSON with object keys sorted, so key order never makes two equal payloads differ. */
function stableJson(v: unknown): string {
  return (
    JSON.stringify(v, (_k, val: unknown) => {
      if (!isObj(val)) return val;
      const out: Obj = {};
      for (const k of Object.keys(val).sort()) out[k] = val[k];
      return out;
    }) ?? ''
  );
}

/** cyrb53: fast 53-bit string hash (public domain). Collisions within a seconds-long window are negligible. */
function hash53(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function isMonitorEvent(v: Obj): boolean {
  return typeof v.kind === 'string' && typeof v.seq === 'number' && typeof v.source === 'string';
}

/** Fingerprint of a hook event, or undefined when the input is not a hook event. */
export function hookFingerprint(input: unknown): HookFingerprint | undefined {
  if (!isObj(input)) return undefined;
  if (isMonitorEvent(input)) {
    const ev = input as unknown as MonitorEvent;
    if (ev.source !== 'hook') return undefined;
    const { seq: _seq, ts, ...rest } = ev;
    const tool = 'tool' in ev ? ev.tool : undefined;
    const fields = [
      ev.sessionId,
      ev.agentId,
      ev.kind,
      tool?.useId,
      tool?.name,
      ev.kind === 'Notification' ? ev.notificationType : undefined,
      'taskId' in ev ? ev.taskId : undefined,
    ];
    return { key: `e|${fields.map(part).join('|')}|${hash53(stableJson(rest))}`, ts };
  }
  let p = input;
  let ts: number | undefined;
  if (input.v === 1 && isObj(input.payload)) {
    p = input.payload;
    if (typeof input.ts === 'number' && Number.isFinite(input.ts)) ts = input.ts;
  }
  if (typeof p.hook_event_name !== 'string' || typeof p.session_id !== 'string') return undefined;
  const fields = [p.session_id, p.agent_id, p.hook_event_name, p.tool_use_id, p.tool_name, p.notification_type, p.task_id];
  const fp: HookFingerprint = { key: `r|${fields.map(part).join('|')}|${hash53(stableJson(p))}` };
  if (ts !== undefined) fp.ts = ts;
  return fp;
}

interface Entry {
  /** Capture times seen for this fingerprint (most recent last, bounded). */
  times: number[];
  seenAt: number;
}

const MAX_TIMES = 8;

export function createDeduper(opts: DeduperOptions = {}): Deduper {
  const windowMs = Math.max(0, opts.windowMs ?? 2000);
  const retainMs = Math.max(windowMs, opts.retainMs ?? Math.max(60_000, windowMs * 30));
  const maxEntries = Math.max(1, opts.maxEntries ?? 4096);
  // Insertion order == last-seen order (entries are re-inserted on every sighting).
  const seen = new Map<string, Entry>();

  const prune = (now: number) => {
    for (const [k, e] of seen) {
      if (seen.size > maxEntries || e.seenAt < now - retainMs) seen.delete(k);
      else break;
    }
  };

  return {
    isDuplicate(input, receivedAt) {
      const fp = hookFingerprint(input);
      if (!fp) return false;
      const at = fp.ts ?? receivedAt;
      prune(receivedAt);
      const e = seen.get(fp.key);
      if (e && e.times.some((t) => Math.abs(t - at) <= windowMs)) return true;
      const times = e ? [...e.times, at].slice(-MAX_TIMES) : [at];
      seen.delete(fp.key);
      seen.set(fp.key, { times, seenAt: receivedAt });
      prune(receivedAt);
      return false;
    },
    get size() {
      return seen.size;
    },
    clear() {
      seen.clear();
    },
  };
}
