// Event journal, session history and replay data.
import { createReadStream, readFileSync } from 'node:fs';
import { appendFile, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  baseName,
  isValidId,
  normalizePathKey,
  teammateIdFor,
  TERMINAL_STATUSES,
  truncate,
  type HistoryEventsResult,
  type HistoryMeta,
  type HistoryProjectOption,
  type HistorySessionEntry,
  type HistorySessionsResult,
  type HistorySummary,
  type MonitorEvent,
  type OfficeState,
} from '@agent-office/core';
import { writeFileAtomic } from '../config';
import type { MonitorPlugin, PluginContext } from '../plugin';

/**
 * Append-only journal of the monitor's sequenced events, one JSONL file per UTC day under
 * `<home>/history/`, plus a session index (`index.json`).
 *
 * - onEvent only pushes the event onto a buffer and updates in-memory counters (O(1));
 *   a timer appends the buffer asynchronously. `Tick` events are not journaled.
 * - Events are already sanitized by the monitor; the journal additionally drops assistant
 *   message text, subagent/task descriptions and transcript paths, and shortens error and
 *   notification text (see journalRecord).
 * - Retention: day files older than `retentionDays` and, beyond that, the oldest files while
 *   the journal exceeds `maxTotalBytes`, are deleted at start and daily.
 */

export interface HistoryPluginOptions {
  retentionDays?: number;
  maxTotalBytes?: number;
  flushIntervalMs?: number;
  maxBufferedEvents?: number;
  indexSaveIntervalMs?: number;
  /** Most sessions kept in the index. */
  maxSessions?: number;
  /** Most events read back for one session. */
  maxEventsPerSession?: number;
  /** Run flush/cleanup timers (default true). Tests call flush()/cleanup() instead. */
  autoTimers?: boolean;
}

export interface HistoryPlugin extends MonitorPlugin {
  flush(): Promise<void>;
  cleanup(): Promise<void>;
  /** Resolves once the index is loaded (or rebuilt from the journal). */
  ready(): Promise<void>;
}

const DAY_MS = 86_400_000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const INDEX_FILE = 'index.json';
const MAX_IDS = 500;

export function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Privacy filter applied to every journaled event (in addition to the monitor's own sanitizing). */
export function journalRecord(ev: MonitorEvent): MonitorEvent {
  const out = { ...ev } as Record<string, unknown>;
  delete out.transcriptPath;
  delete out.agentTranscriptPath;
  delete out.lastMessage; // assistant message text (Stop, SubagentStop, StopFailure)
  delete out.description; // task / subagent descriptions (free text written by the model or user)
  if (typeof out.error === 'string') out.error = truncate(out.error, 200);
  if (typeof out.message === 'string') out.message = truncate(out.message, 160);
  if (typeof out.reason === 'string') out.reason = truncate(out.reason, 160);
  return out as unknown as MonitorEvent;
}

interface LiveEntry {
  entry: HistorySessionEntry;
  agentIds: Set<string>;
  taskIds: Set<string>;
  completedIds: Set<string>;
}

interface PersistedEntry extends HistorySessionEntry {
  agentIds?: string[];
  taskIds?: string[];
  completedIds?: string[];
}

function finiteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function count(v: unknown): number {
  return finiteNum(v) && v >= 0 ? Math.floor(v) : 0;
}

function strArr(v: unknown, max: number, valid: (s: string) => boolean): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && valid(x)).slice(0, max) : [];
}

function reviveEntry(raw: unknown): LiveEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as PersistedEntry;
  if (!isValidId(r.sessionId) || !finiteNum(r.firstTs) || !finiteNum(r.lastTs)) return undefined;
  const e: HistorySessionEntry = {
    sessionId: r.sessionId,
    firstTs: r.firstTs,
    lastTs: r.lastTs,
    ended: r.ended === true,
    events: count(r.events),
    agents: Math.max(1, count(r.agents)),
    tasks: count(r.tasks),
    tasksCompleted: count(r.tasksCompleted),
    toolCalls: count(r.toolCalls),
    toolFailures: count(r.toolFailures),
    toolInterrupts: count(r.toolInterrupts),
    permissionRequests: count(r.permissionRequests),
    turns: count(r.turns),
    turnFailures: count(r.turnFailures),
    days: strArr(r.days, 400, (d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  };
  if (typeof r.cwd === 'string' && r.cwd) setCwd(e, r.cwd);
  if (typeof r.title === 'string') e.title = truncate(r.title, 160);
  if (typeof r.model === 'string') e.model = truncate(r.model, 100);
  if (r.simulated === true) e.simulated = true;
  if (finiteNum(r.endedAt)) e.endedAt = r.endedAt;
  if (r.partial === true) e.partial = true;
  return {
    entry: e,
    agentIds: new Set(strArr(r.agentIds, MAX_IDS, isValidId)),
    taskIds: new Set(strArr(r.taskIds, MAX_IDS, isValidId)),
    completedIds: new Set(strArr(r.completedIds, MAX_IDS, isValidId)),
  };
}

function setCwd(e: HistorySessionEntry, cwd: string): void {
  e.cwd = cwd.slice(0, 1024);
  e.projectKey = normalizePathKey(e.cwd);
  e.project = baseName(e.cwd);
}

function optTime(v: unknown): number | undefined {
  return finiteNum(v) && v >= 0 ? v : undefined;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  if (!finiteNum(v)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export function historyPlugin(opts: HistoryPluginOptions = {}): HistoryPlugin {
  const retentionDays = Math.max(1, Math.floor(opts.retentionDays ?? 14));
  const maxTotalBytes = Math.max(1024, opts.maxTotalBytes ?? 256 * 1024 * 1024);
  const flushIntervalMs = opts.flushIntervalMs ?? 1000;
  const maxBuffered = opts.maxBufferedEvents ?? 50_000;
  const indexSaveIntervalMs = opts.indexSaveIntervalMs ?? 5000;
  const maxSessions = opts.maxSessions ?? 5000;
  const maxEventsPerSession = opts.maxEventsPerSession ?? 200_000;

  let ctx: PluginContext | undefined;
  let dir = '';
  const index = new Map<string, LiveEntry>();
  const dayBytes = new Map<string, number>();
  const newlineChecked = new Set<string>();
  let pending: Array<{ day: string; ev: MonitorEvent }> = [];
  let deferred: Array<{ day: string; ev: MonitorEvent; state: OfficeState }> | undefined;
  let isReady = false;
  let readyPromise: Promise<void> = Promise.resolve();
  let flushChain: Promise<void> = Promise.resolve();
  let flushTimer: NodeJS.Timeout | undefined;
  let dailyTimer: NodeJS.Timeout | undefined;
  let indexDirty = false;
  let lastIndexSave = 0;
  let lastFlushAt: number | undefined;
  let lastCleanupDay = '';
  let dropped = 0;
  let writeErrors = 0;
  let started = false;
  const cache = new Map<string, { sig: string; events: MonitorEvent[]; capped: boolean }>();

  const now = () => (ctx ? ctx.now() : Date.now());
  const fileFor = (day: string) => join(dir, `${day}.jsonl`);

  // ---------------------------------------------------------------- index

  function entryFor(sessionId: string, ts: number): LiveEntry {
    let L = index.get(sessionId);
    if (!L) {
      const e: HistorySessionEntry = {
        sessionId,
        firstTs: ts,
        lastTs: ts,
        ended: false,
        events: 0,
        agents: 1,
        tasks: 0,
        tasksCompleted: 0,
        toolCalls: 0,
        toolFailures: 0,
        toolInterrupts: 0,
        permissionRequests: 0,
        turns: 0,
        turnFailures: 0,
        days: [],
      };
      if (sessionId.startsWith('sim-')) e.simulated = true;
      L = { entry: e, agentIds: new Set(), taskIds: new Set(), completedIds: new Set() };
      index.set(sessionId, L);
      if (index.size > maxSessions) evictOldestSession();
    }
    return L;
  }

  function evictOldestSession(): void {
    let oldest: LiveEntry | undefined;
    for (const L of index.values()) if (!oldest || L.entry.lastTs < oldest.entry.lastTs) oldest = L;
    if (oldest) index.delete(oldest.entry.sessionId);
  }

  /** O(1) bookkeeping for one event. `state` (when live) supplies title/cwd/model/ended. */
  function indexEvent(ev: MonitorEvent, day: string, state?: OfficeState): void {
    if (ev.sessionId === '*') return;
    const L = entryFor(ev.sessionId, ev.ts);
    const e = L.entry;
    e.events += 1;
    if (ev.ts < e.firstTs) e.firstTs = ev.ts;
    if (ev.ts > e.lastTs) e.lastTs = ev.ts;
    if (e.days[e.days.length - 1] !== day && !e.days.includes(day)) e.days.push(day);
    // Count agents the way the reducer identifies them: teammates reported only by name get a
    // name-based id, which is merged away once an event reports the name with a real agent_id.
    const teammateName = (ev as { teammateName?: string }).teammateName;
    const nameId = teammateName ? teammateIdFor(teammateName) : undefined;
    if (ev.agentId && nameId && L.agentIds.delete(nameId)) e.agents = 1 + L.agentIds.size;
    const id = ev.agentId ?? nameId;
    if (id && L.agentIds.size < MAX_IDS && !L.agentIds.has(id)) {
      L.agentIds.add(id);
      e.agents = 1 + L.agentIds.size;
    }
    if (!ev.agentId && ev.cwd && !e.cwd) setCwd(e, ev.cwd);
    switch (ev.kind) {
      case 'SessionStart':
        if (ev.title) e.title = ev.title;
        if (ev.model) e.model = ev.model;
        e.ended = false;
        e.endedAt = undefined;
        break;
      case 'TranscriptSeen':
        if (ev.title) e.title = ev.title;
        if (ev.model && !e.model) e.model = ev.model;
        break;
      case 'SessionEnd':
      case 'RegistryGone':
        e.ended = true;
        e.endedAt = ev.ts;
        break;
      case 'RegistryStatus':
        if (!ev.alive) {
          e.ended = true;
          e.endedAt = ev.ts;
        }
        break;
      case 'TaskCreated':
      case 'TaskCompleted':
        if (L.taskIds.size < MAX_IDS) L.taskIds.add(ev.taskId);
        if (ev.kind === 'TaskCompleted' && L.completedIds.size < MAX_IDS) L.completedIds.add(ev.taskId);
        e.tasks = L.taskIds.size;
        e.tasksCompleted = L.completedIds.size;
        break;
      case 'PreToolUse':
        e.toolCalls += 1;
        break;
      case 'PostToolUse':
        if (ev.success === false) e.toolFailures += 1;
        break;
      case 'PostToolUseFailure':
        if (ev.isInterrupt) e.toolInterrupts += 1;
        else e.toolFailures += 1;
        break;
      case 'PermissionRequest':
        e.permissionRequests += 1;
        break;
      case 'Stop':
        e.turns += 1;
        break;
      case 'StopFailure':
        e.turnFailures += 1;
        break;
      default:
        break;
    }
    const a = state?.agents[ev.sessionId];
    if (a) {
      if (a.cwd) setCwd(e, a.cwd);
      if (a.title) e.title = a.title;
      if (a.model) e.model = a.model;
      e.ended = TERMINAL_STATUSES.has(a.status);
      e.endedAt = e.ended ? (a.endedAt ?? a.statusAt) : undefined;
    }
    indexDirty = true;
  }

  function persistedIndex(): string {
    const sessions: PersistedEntry[] = [...index.values()].map((L) => ({
      ...L.entry,
      agentIds: [...L.agentIds],
      taskIds: [...L.taskIds],
      completedIds: [...L.completedIds],
    }));
    // Wall clock (not ctx.now): compared with journal file mtimes on the next start.
    return JSON.stringify({ version: 1, savedAt: Date.now(), sessions });
  }

  function saveIndex(): void {
    if (!dir) return;
    try {
      writeFileAtomic(join(dir, INDEX_FILE), persistedIndex());
      indexDirty = false;
      lastIndexSave = now();
    } catch (e) {
      writeErrors += 1;
      ctx?.log(`history: failed to save index: ${(e as Error).message}`);
    }
  }

  async function listDays(): Promise<Array<{ day: string; bytes: number; mtimeMs: number }>> {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: Array<{ day: string; bytes: number; mtimeMs: number }> = [];
    for (const n of names) {
      const m = DAY_FILE.exec(n);
      if (!m) continue;
      try {
        const st = await stat(join(dir, n));
        if (st.isFile()) out.push({ day: m[1]!, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* vanished */
      }
    }
    return out.sort((x, y) => x.day.localeCompare(y.day));
  }

  /** Stream one day file, calling `fn` for each parsed event (lines are pre-filtered by `needle`). */
  async function readDay(day: string, fn: (ev: MonitorEvent) => boolean | void, needles?: string[]): Promise<void> {
    let stream;
    try {
      if (!(await stat(fileFor(day))).isFile()) return;
      stream = createReadStream(fileFor(day), { encoding: 'utf8' });
    } catch {
      return;
    }
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line || (needles && !needles.some((n) => line.includes(n)))) continue;
        let ev: MonitorEvent;
        try {
          ev = JSON.parse(line) as MonitorEvent;
        } catch {
          continue; // torn line from a crash
        }
        if (!ev || typeof ev !== 'object' || typeof ev.kind !== 'string' || typeof ev.sessionId !== 'string' || !finiteNum(ev.ts)) continue;
        if (fn(ev) === false) break;
      }
    } catch {
      /* missing or unreadable file */
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  async function rebuildIndex(days: string[]): Promise<void> {
    index.clear();
    for (const day of days) {
      await readDay(day, (ev) => {
        if (ev.kind !== 'Tick') indexEvent(ev, day);
      });
    }
    indexDirty = true;
  }

  async function load(): Promise<void> {
    await mkdir(dir, { recursive: true });
    const days = await listDays();
    for (const d of days) dayBytes.set(d.day, d.bytes);
    let savedAt = -1;
    try {
      const raw = JSON.parse(readFileSync(join(dir, INDEX_FILE), 'utf8')) as { version?: unknown; savedAt?: unknown; sessions?: unknown };
      if (raw && raw.version === 1 && Array.isArray(raw.sessions)) {
        for (const s of raw.sessions) {
          const L = reviveEntry(s);
          if (L) index.set(L.entry.sessionId, L);
        }
        savedAt = finiteNum(raw.savedAt) ? raw.savedAt : 0;
      }
    } catch {
      /* missing or corrupt */
    }
    // The index is a cache of the journal: rebuild it if it is missing or older than the journal.
    const journalNewer = days.some((d) => d.mtimeMs > savedAt + 2000);
    if (days.length && (savedAt < 0 || journalNewer)) {
      await rebuildIndex(days.map((d) => d.day));
      ctx?.log(`history: rebuilt session index from ${days.length} journal file(s)`);
    }
    await cleanup();
  }

  // ---------------------------------------------------------------- retention

  async function cleanupNow(): Promise<void> {
    const today = dayOf(now());
    const cutoff = dayOf(now() - (retentionDays - 1) * DAY_MS);
    const days = await listDays();
    const deleted = new Set<string>();
    let total = 0;
    for (const d of days) {
      if (d.day < cutoff) {
        try {
          await unlink(fileFor(d.day));
          deleted.add(d.day);
        } catch {
          total += d.bytes;
        }
      } else total += d.bytes;
    }
    for (const d of days) {
      if (total <= maxTotalBytes) break;
      if (deleted.has(d.day) || d.day === today) continue;
      try {
        await unlink(fileFor(d.day));
        deleted.add(d.day);
        total -= d.bytes;
      } catch {
        /* locked: retry next cleanup */
      }
    }
    dayBytes.clear();
    for (const d of days) if (!deleted.has(d.day)) dayBytes.set(d.day, d.bytes);
    if (deleted.size) {
      for (const [id, L] of index) {
        const before = L.entry.days.length;
        L.entry.days = L.entry.days.filter((d) => !deleted.has(d));
        if (!L.entry.days.length) index.delete(id);
        else if (L.entry.days.length !== before) L.entry.partial = true;
      }
      cache.clear();
      indexDirty = true;
      ctx?.log(`history: retention removed ${deleted.size} journal file(s)`);
    }
    lastCleanupDay = today;
  }

  function cleanup(): Promise<void> {
    // Serialised with flushes so a file is never deleted while being appended.
    const p = flushChain.then(cleanupNow);
    flushChain = p.catch((e) => ctx?.log(`history: cleanup failed: ${(e as Error).message}`));
    return flushChain;
  }

  // ---------------------------------------------------------------- writing

  async function needsLeadingNewline(day: string): Promise<boolean> {
    if (newlineChecked.has(day)) return false;
    newlineChecked.add(day);
    try {
      const fh = await open(fileFor(day), 'r');
      try {
        const { size } = await fh.stat();
        if (size === 0) return false;
        const b = Buffer.alloc(1);
        await fh.read(b, 0, 1, size - 1);
        return b[0] !== 10; // a crash left a torn last line: start on a fresh one
      } finally {
        await fh.close();
      }
    } catch {
      return false;
    }
  }

  async function flushNow(): Promise<void> {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const byDay = new Map<string, string[]>();
    for (const { day, ev } of batch) {
      let lines = byDay.get(day);
      if (!lines) byDay.set(day, (lines = []));
      lines.push(JSON.stringify(journalRecord(ev)));
    }
    for (const [day, lines] of byDay) {
      if ((dayBytes.get(day) ?? 0) >= maxTotalBytes) {
        // A single day already exceeds the size cap: stop journaling until the next day.
        dropped += lines.length;
        continue;
      }
      let text = lines.join('\n') + '\n';
      if (await needsLeadingNewline(day)) text = '\n' + text;
      try {
        await appendFile(fileFor(day), text, { encoding: 'utf8', mode: 0o600 });
        dayBytes.set(day, (dayBytes.get(day) ?? 0) + Buffer.byteLength(text));
      } catch (e) {
        writeErrors += 1;
        dropped += lines.length;
        ctx?.log(`history: append failed: ${(e as Error).message}`);
      }
    }
    lastFlushAt = now();
    let total = 0;
    for (const b of dayBytes.values()) total += b;
    if (dayOf(now()) !== lastCleanupDay || total > maxTotalBytes) await cleanupNow();
    if (indexDirty && now() - lastIndexSave >= indexSaveIntervalMs) saveIndex();
  }

  async function flush(): Promise<void> {
    await readyPromise;
    const p = flushChain.then(flushNow);
    flushChain = p.catch((e) => ctx?.log(`history: flush failed: ${(e as Error).message}`));
    await flushChain;
  }

  // ---------------------------------------------------------------- reading

  async function sessionEvents(L: LiveEntry): Promise<{ events: MonitorEvent[]; capped: boolean }> {
    const e = L.entry;
    const sig = `${e.events}|${e.days.join(',')}`;
    const hit = cache.get(e.sessionId);
    if (hit && hit.sig === sig) return hit;
    const events: MonitorEvent[] = [];
    let capped = false;
    const needles = [`"sessionId":"${e.sessionId}"`, '"sessionId":"*"'];
    for (const day of [...e.days].sort()) {
      await readDay(
        day,
        (ev) => {
          const mine = ev.sessionId === e.sessionId;
          // A monitor restart affects every live session: keep it in the session's replay.
          const restart = ev.sessionId === '*' && ev.kind === 'Restored' && ev.ts >= e.firstTs && ev.ts <= e.lastTs;
          if (!mine && !restart) return true;
          if (events.length >= maxEventsPerSession) {
            capped = true;
            return false;
          }
          events.push(ev);
          return true;
        },
        needles,
      );
      if (capped) break;
    }
    const value = { sig, events, capped };
    cache.set(e.sessionId, value);
    while (cache.size > 3) cache.delete(cache.keys().next().value!);
    return value;
  }

  function entryOut(L: LiveEntry): HistorySessionEntry {
    return { ...L.entry, days: [...L.entry.days] };
  }

  function projectOptions(): HistoryProjectOption[] {
    const m = new Map<string, HistoryProjectOption>();
    for (const { entry: e } of index.values()) {
      if (!e.projectKey) continue;
      const o = m.get(e.projectKey) ?? { key: e.projectKey, label: e.project ?? e.projectKey, count: 0 };
      o.count += 1;
      m.set(e.projectKey, o);
    }
    return [...m.values()].sort((x, y) => x.label.localeCompare(y.label));
  }

  function totalBytes(): number {
    let t = 0;
    for (const b of dayBytes.values()) t += b;
    return t;
  }

  // ---------------------------------------------------------------- plugin

  return {
    name: 'history',
    async start(c) {
      ctx = c;
      dir = join(c.home, 'history');
      started = true;
      deferred = [];
      isReady = false;
      readyPromise = load()
        .catch((e) => c.log(`history: failed to load: ${(e as Error).message}`))
        .finally(() => {
          isReady = true;
          for (const d of deferred ?? []) indexEvent(d.ev, d.day, d.state);
          deferred = undefined;
        });
      if (opts.autoTimers !== false) {
        flushTimer = setInterval(() => void flush(), flushIntervalMs);
        flushTimer.unref?.();
        dailyTimer = setInterval(() => void cleanup(), DAY_MS);
        dailyTimer.unref?.();
      }
      // Loading may rebuild a large index: do not hold up the monitor's start.
    },
    async stop() {
      clearInterval(flushTimer);
      clearInterval(dailyTimer);
      flushTimer = dailyTimer = undefined;
      if (!started) return;
      await flush();
      saveIndex();
      started = false;
    },
    onEvent(ev, state) {
      if (ev.kind === 'Tick' || !started) return;
      if (pending.length >= maxBuffered) {
        dropped += 1;
        return;
      }
      const day = dayOf(now());
      pending.push({ day, ev });
      if (!isReady) deferred?.push({ day, ev, state });
      else indexEvent(ev, day, state);
    },
    flush,
    cleanup: async () => {
      await readyPromise;
      await cleanup();
    },
    ready: () => readyPromise,
    routes: {
      async sessions(params) {
        await readyPromise;
        const from = optTime(params.from);
        const to = optTime(params.to);
        const limit = clampInt(params.limit, 1, 1000, 200);
        const project = typeof params.project === 'string' && params.project && params.project !== 'all' ? params.project.slice(0, 1024) : undefined;
        const projectKey = project ? normalizePathKey(project) : undefined;
        const matches = [...index.values()].filter(({ entry: e }) => {
          if (projectKey && e.projectKey !== projectKey && e.project !== project) return false;
          if (from !== undefined && e.lastTs < from) return false;
          if (to !== undefined && e.firstTs > to) return false;
          return true;
        });
        matches.sort((x, y) => y.entry.lastTs - x.entry.lastTs);
        const out: HistorySessionsResult = { sessions: matches.slice(0, limit).map(entryOut), total: matches.length, projects: projectOptions() };
        return out;
      },
      async events(params) {
        const sessionId = params.sessionId;
        if (!isValidId(sessionId)) throw new Error('invalid sessionId');
        const limit = clampInt(params.limit, 1, 5000, 2000);
        const cursor = clampInt(params.cursor, 0, Number.MAX_SAFE_INTEGER, 0);
        const from = optTime(params.from);
        const to = optTime(params.to);
        await flush();
        const L = index.get(sessionId);
        if (!L) {
          const empty: HistoryEventsResult = { sessionId, events: [], done: true, total: 0 };
          return empty;
        }
        const { events, capped } = await sessionEvents(L);
        const filtered = from === undefined && to === undefined ? events : events.filter((ev) => (from === undefined || ev.ts >= from) && (to === undefined || ev.ts <= to));
        const page = filtered.slice(cursor, cursor + limit);
        const done = cursor + page.length >= filtered.length;
        const out: HistoryEventsResult = { sessionId, events: page, done, total: filtered.length };
        if (!done) out.nextCursor = cursor + page.length;
        if (capped) out.capped = true;
        return out;
      },
      async summary() {
        await flush();
        const totals = { toolCalls: 0, toolFailures: 0, tasks: 0, tasksCompleted: 0, turns: 0, turnFailures: 0 };
        let events = 0;
        for (const { entry: e } of index.values()) {
          events += e.events;
          totals.toolCalls += e.toolCalls;
          totals.toolFailures += e.toolFailures;
          totals.tasks += e.tasks;
          totals.tasksCompleted += e.tasksCompleted;
          totals.turns += e.turns;
          totals.turnFailures += e.turnFailures;
        }
        const days = [...dayBytes.entries()].map(([day, bytes]) => ({ day, bytes })).sort((x, y) => x.day.localeCompare(y.day));
        const out: HistorySummary = {
          sessions: index.size,
          events,
          days,
          totalBytes: totalBytes(),
          retentionDays,
          maxTotalBytes,
          bufferedEvents: pending.length,
          droppedEvents: dropped,
          writeErrors,
          totals,
        };
        if (days.length) {
          out.oldestDay = days[0]!.day;
          out.newestDay = days[days.length - 1]!.day;
        }
        if (lastFlushAt !== undefined) out.lastFlushAt = lastFlushAt;
        return out;
      },
    },
    meta(): HistoryMeta {
      const m: HistoryMeta = { sessions: index.size, bufferedEvents: pending.length, totalBytes: totalBytes(), retentionDays, writeErrors, droppedEvents: dropped };
      if (lastFlushAt !== undefined) m.lastFlushAt = lastFlushAt;
      return m;
    },
  };
}
