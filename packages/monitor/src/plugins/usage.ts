// Observed token usage from transcripts.
import { readFileSync, statSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  baseName,
  isValidId,
  normalizePathKey,
  safeText,
  type CostEstimate,
  type ModelPrice,
  type PriceTable,
  type PricingStatus,
  type ReportedCost,
  type ReportedModelUsage,
  type TokenCounts,
  type UsageAgentRow,
  type UsageBucket,
  type UsageMeta,
  type UsageModelRow,
  type UsageProjectRow,
  type UsageScanStatus,
  type UsageSessionDetail,
  type UsageSessionRow,
  type UsageSummary,
} from '@agent-office/core';
import { listSubagents, sessionIdFromTranscriptPath } from '../discovery/transcripts';
import type { MonitorPlugin, PluginContext } from '../plugin';

/**
 * Observed token usage, read from Claude Code's own transcripts.
 *
 * - Only sessions known to the monitor (plus sessions explicitly requested through
 *   `usage.session`) are tracked; their main transcript and `subagents/agent-<id>.jsonl` files.
 * - Files are read incrementally from a byte offset. A partial last line is carried over to
 *   the next read; a file that shrinks or whose first bytes change is treated as replaced and
 *   the whole session is recounted from zero (never added twice).
 * - Every read is time-boxed (antivirus can block opens of growing files on Windows) and each
 *   pass reads a bounded number of bytes; large backlogs are caught up over several passes.
 * - Assistant usage is deduplicated by `message.id` (streaming repeats a message id; the
 *   per-field maximum is kept). Message content is never retained: only the id, the model and
 *   four token counters per message.
 * - The latest `cost-state` record per session is kept verbatim as "reported by Claude Code".
 * - A cost estimate is produced only from the user's own `<home>/pricing.json`.
 */

export interface ChunkResult {
  /** File size at the time of the read. */
  size: number;
  /** The first `headBytes` bytes (fewer if the file is shorter). */
  head: Buffer;
  /** Bytes from `offset`, at most `maxBytes`. */
  data: Buffer;
}

export type ChunkReader = (file: string, offset: number, maxBytes: number, headBytes: number) => Promise<ChunkResult>;

export interface UsagePluginOptions {
  /** Delay between passes when there is no backlog. */
  intervalMs?: number;
  /** Delay before the next pass while a backlog is being caught up. */
  catchUpMs?: number;
  maxBytesPerPass?: number;
  maxBytesPerFile?: number;
  readTimeoutMs?: number;
  /** Files whose read timed out are skipped for this long. */
  cooldownMs?: number;
  maxSessions?: number;
  /** Lines longer than this are skipped (and counted) instead of buffered. */
  maxLineBytes?: number;
  /** Run passes on a timer (default true). Tests call scanNow() instead. */
  autoScan?: boolean;
  reader?: ChunkReader;
}

export interface UsagePlugin extends MonitorPlugin {
  /** Run one bounded pass now (serialised with timer passes). */
  scanNow(): Promise<void>;
}

const HEAD_BYTES = 256;
const PRICING_FILE = 'pricing.json';
const MAX_PRICING_BYTES = 256 * 1024;
const SUBAGENT_RESCAN_MS = 10_000;
const LOOKUP_RETRY_MS = 60_000;
const MAX_SUMMARY_SESSIONS = 500;
const MAX_SUMMARY_AGENTS = 200;
const MAX_MODEL_LEN = 100;

// ---------------------------------------------------------------- pricing (pure)

const MODEL_KEY = /^(?:[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,99})?\*?$/;
const PRICE_FIELDS = ['inputPerMTok', 'outputPerMTok', 'cacheWritePerMTok', 'cacheReadPerMTok'] as const;
const MAX_PRICE = 100_000;

export type PriceTableResult = { ok: true; table: PriceTable } | { ok: false; error: string };

/** Validate a user-supplied price table. Strict: unknown fields are rejected to catch typos. */
export function validatePriceTable(raw: unknown): PriceTableResult {
  const fail = (error: string): PriceTableResult => ({ ok: false, error });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('pricing.json must contain a JSON object');
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!['version', 'currency', 'note', 'models'].includes(k)) return fail(`unknown field "${k.slice(0, 40)}"`);
  if (r.version !== 1) return fail('"version" must be 1');
  if (typeof r.currency !== 'string' || !/^[A-Z]{3}$/.test(r.currency)) return fail('"currency" must be a 3-letter ISO 4217 code such as "USD"');
  if (r.note !== undefined && typeof r.note !== 'string') return fail('"note" must be a string');
  const models = r.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return fail('"models" must be an object keyed by model id');
  const entries = Object.entries(models as Record<string, unknown>);
  if (entries.length === 0) return fail('"models" is empty');
  if (entries.length > 500) return fail('"models" has more than 500 entries');
  const out: Record<string, ModelPrice> = {};
  for (const [key, value] of entries) {
    const label = `models["${key.slice(0, 60)}"]`;
    if (!key || !MODEL_KEY.test(key)) return fail(`${label}: invalid model id (use an exact id or a prefix ending in *)`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${label} must be an object`);
    const v = value as Record<string, unknown>;
    for (const f of Object.keys(v)) {
      if (!(PRICE_FIELDS as readonly string[]).includes(f)) return fail(`${label}: unknown field "${f.slice(0, 40)}" (expected ${PRICE_FIELDS.join(', ')})`);
    }
    const price: Partial<ModelPrice> = {};
    for (const f of PRICE_FIELDS) {
      const n = v[f];
      if (n === undefined) {
        if (f === 'inputPerMTok' || f === 'outputPerMTok') return fail(`${label}: "${f}" is required`);
        continue;
      }
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_PRICE) return fail(`${label}: "${f}" must be a number between 0 and ${MAX_PRICE}`);
      price[f] = n;
    }
    out[key] = price as ModelPrice;
  }
  const table: PriceTable = { version: 1, currency: r.currency, models: out };
  const note = safeText(r.note, 200);
  if (note) table.note = note;
  return { ok: true, table };
}

/** Exact model id first, otherwise the longest `prefix*` key that matches. */
export function matchPrice(table: PriceTable, model: string): ModelPrice | undefined {
  const exact = table.models[model];
  if (exact && !model.endsWith('*')) return exact;
  let best: { len: number; price: ModelPrice } | undefined;
  for (const [key, price] of Object.entries(table.models)) {
    if (!key.endsWith('*')) continue;
    const prefix = key.slice(0, -1);
    if (model.startsWith(prefix) && (!best || prefix.length > best.len)) best = { len: prefix.length, price };
  }
  return best?.price;
}

function totalTokens(c: TokenCounts): number {
  return c.inputTokens + c.outputTokens + c.cacheCreationTokens + c.cacheReadTokens;
}

/** API-equivalent estimate from the user's table. Tokens without a price are excluded and listed. */
export function estimateCost(byModel: Record<string, TokenCounts>, table: PriceTable): CostEstimate {
  let amount = 0;
  const unpriced = new Set<string>();
  const unpricedCache = new Set<string>();
  for (const [model, c] of Object.entries(byModel)) {
    if (totalTokens(c) === 0) continue;
    const p = matchPrice(table, model);
    if (!p) {
      unpriced.add(model);
      continue;
    }
    amount += (c.inputTokens * p.inputPerMTok + c.outputTokens * p.outputPerMTok) / 1e6;
    if (c.cacheCreationTokens > 0) {
      if (p.cacheWritePerMTok === undefined) unpricedCache.add(model);
      else amount += (c.cacheCreationTokens * p.cacheWritePerMTok) / 1e6;
    }
    if (c.cacheReadTokens > 0) {
      if (p.cacheReadPerMTok === undefined) unpricedCache.add(model);
      else amount += (c.cacheReadTokens * p.cacheReadPerMTok) / 1e6;
    }
  }
  return {
    source: 'price-table',
    currency: table.currency,
    amount,
    partial: unpriced.size > 0 || unpricedCache.size > 0,
    unpricedModels: [...unpriced].sort(),
    unpricedCacheModels: [...unpricedCache].sort(),
  };
}

// ---------------------------------------------------------------- buckets (pure)

export function emptyBucket(): UsageBucket {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, messages: 0 };
}

function addInto(into: UsageBucket, c: TokenCounts, messages: number): void {
  into.inputTokens += c.inputTokens;
  into.outputTokens += c.outputTokens;
  into.cacheCreationTokens += c.cacheCreationTokens;
  into.cacheReadTokens += c.cacheReadTokens;
  into.messages += messages;
}

function mergeModels(into: Record<string, UsageBucket>, from: Map<string, UsageBucket> | Record<string, UsageBucket>): void {
  const entries = from instanceof Map ? from.entries() : Object.entries(from);
  for (const [model, b] of entries) {
    const t = (into[model] ??= emptyBucket());
    addInto(t, b, b.messages);
  }
}

function sumModels(byModel: Record<string, UsageBucket>): UsageBucket {
  const t = emptyBucket();
  for (const b of Object.values(byModel)) addInto(t, b, b.messages);
  return t;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

// ---------------------------------------------------------------- I/O

/** One open per call: size, head bytes and up to maxBytes from offset. */
export const readChunk: ChunkReader = async (file, offset, maxBytes, headBytes) => {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const hb = Math.min(headBytes, size);
    const head = Buffer.alloc(hb);
    if (hb > 0) await fh.read(head, 0, hb, 0);
    const len = offset < size ? Math.min(maxBytes, size - offset) : 0;
    const data = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const r = await fh.read(data, got, len - got, offset + got);
      if (r.bytesRead === 0) break;
      got += r.bytesRead;
    }
    return { size, head, data: got < len ? data.subarray(0, got) : data };
  } finally {
    await fh.close();
  }
};

type Boxed<T> = { ok: true; value: T } | { ok: false; reason: 'busy' | 'timeout' | 'missing' | 'error' };

/** Same policy as discovery's GuardedReader: one read per file at a time, time budget, cooldown. */
class TimeBox {
  private inflight = new Set<string>();
  private cooldownUntil = new Map<string, number>();
  constructor(
    private readonly timeoutMs: number,
    private readonly cooldownMs: number,
  ) {}

  async run<T>(key: string, now: number, fn: () => Promise<T>): Promise<Boxed<T>> {
    if (this.inflight.has(key) || (this.cooldownUntil.get(key) ?? 0) > now) return { ok: false, reason: 'busy' };
    this.inflight.add(key);
    const op = fn().finally(() => this.inflight.delete(key));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), this.timeoutMs);
      timer.unref?.();
    });
    try {
      const res = await Promise.race([op, timeout]);
      if (res === 'timeout') {
        this.cooldownUntil.set(key, now + this.cooldownMs);
        op.catch(() => {});
        return { ok: false, reason: 'timeout' };
      }
      return { ok: true, value: res as T };
    } catch (e) {
      return { ok: false, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error' };
    } finally {
      clearTimeout(timer);
    }
  }

  slowCount(now: number): number {
    let n = 0;
    for (const t of this.cooldownUntil.values()) if (t > now) n++;
    return n;
  }
}

// ---------------------------------------------------------------- plugin state

interface FileCursor {
  path: string;
  /** 'main' for the session transcript, else the subagent id. */
  agent: string;
  offset: number;
  size: number;
  mtimeMs: number;
  /** At least one successful read. */
  readOnce: boolean;
  head?: Buffer;
  carry?: Buffer;
  /** Discarding the rest of an oversized line. */
  skipping: boolean;
  missing: boolean;
}

interface SessionAcc {
  sessionId: string;
  transcriptPath?: string;
  sessionDir?: string;
  title?: string;
  stateCwd?: string;
  transcriptCwd?: string;
  inState: boolean;
  files: Map<string, FileCursor>;
  /** agent -> model -> bucket */
  buckets: Map<string, Map<string, UsageBucket>>;
  agentTypes: Map<string, string>;
  reported?: ReportedCost;
  firstAt?: number;
  lastAt?: number;
  lastLookupAt: number;
  lastSubagentScanAt: number;
  touchedAt: number;
}

interface MsgRec {
  sessionId: string;
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

export function usagePlugin(opts: UsagePluginOptions = {}): UsagePlugin {
  const intervalMs = opts.intervalMs ?? 15_000;
  const catchUpMs = opts.catchUpMs ?? 250;
  const maxBytesPerPass = opts.maxBytesPerPass ?? 16 * 1024 * 1024;
  const maxBytesPerFile = opts.maxBytesPerFile ?? 4 * 1024 * 1024;
  const maxSessions = opts.maxSessions ?? 300;
  const maxLineBytes = opts.maxLineBytes ?? 16 * 1024 * 1024;
  const reader = opts.reader ?? readChunk;
  const box = new TimeBox(opts.readTimeoutMs ?? 2500, opts.cooldownMs ?? 60_000);

  let ctx: PluginContext | undefined;
  const sessions = new Map<string, SessionAcc>();
  const messages = new Map<string, MsgRec>();
  const skipped = { noMessageId: 0, unparsableLines: 0, oversizedLines: 0, crossSessionDuplicates: 0 };
  let resets = 0;
  let lastScanAt: number | undefined;
  let lastScanMs: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  let chain: Promise<void> = Promise.resolve();
  let pricing: PricingStatus = { state: 'none', message: 'no price table configured', file: PRICING_FILE };
  let priceTable: PriceTable | undefined;
  let pricingSig = '';

  const now = () => (ctx ? ctx.now() : Date.now());

  // ---------- pricing

  function refreshPricing(): void {
    if (!ctx) return;
    const file = join(ctx.home, PRICING_FILE);
    let sig: string;
    try {
      const st = statSync(file);
      sig = `${st.mtimeMs}:${st.size}`;
      if (sig === pricingSig) return;
      pricingSig = sig;
      if (st.size > MAX_PRICING_BYTES) throw new Error(`pricing.json is larger than ${MAX_PRICING_BYTES} bytes`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
      } catch {
        throw new Error('pricing.json is not valid JSON');
      }
      const r = validatePriceTable(parsed);
      if (!r.ok) throw new Error(r.error);
      priceTable = r.table;
      pricing = { state: 'ok', currency: r.table.currency, models: Object.keys(r.table.models).length, file: PRICING_FILE, loadedAt: now() };
      if (r.table.note) pricing.note = r.table.note;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      priceTable = undefined;
      if (code === 'ENOENT') {
        pricingSig = '';
        pricing = { state: 'none', message: 'no price table configured', file: PRICING_FILE };
      } else {
        pricing = { state: 'invalid', error: code ? `cannot read pricing.json (${code})` : (e as Error).message, file: PRICING_FILE };
      }
    }
  }

  // ---------- session bookkeeping

  function newCursor(path: string, agent: string): FileCursor {
    return { path, agent, offset: 0, size: 0, mtimeMs: 0, readOnce: false, skipping: false, missing: false };
  }

  function getAcc(sessionId: string): SessionAcc {
    let acc = sessions.get(sessionId);
    if (!acc) {
      acc = {
        sessionId,
        inState: false,
        files: new Map(),
        buckets: new Map(),
        agentTypes: new Map(),
        lastLookupAt: 0,
        lastSubagentScanAt: 0,
        touchedAt: now(),
      };
      sessions.set(sessionId, acc);
    }
    return acc;
  }

  function setTranscript(acc: SessionAcc, path: string): void {
    if (acc.transcriptPath) return;
    acc.transcriptPath = path;
    acc.sessionDir = join(dirname(path), acc.sessionId);
    acc.files.set(path, newCursor(path, 'main'));
  }

  function syncFromState(): void {
    if (!ctx) return;
    const seen = new Set<string>();
    for (const a of Object.values(ctx.getState().agents)) {
      if (a.kind !== 'session' || a.sessionId.startsWith('sim-')) continue;
      const acc = getAcc(a.sessionId);
      seen.add(a.sessionId);
      acc.inState = true;
      acc.touchedAt = now();
      if (a.title) acc.title = a.title;
      if (a.cwd) acc.stateCwd = a.cwd;
      // Only accept a path whose file name is this session's id.
      if (a.transcriptPath && sessionIdFromTranscriptPath(a.transcriptPath) === a.sessionId) setTranscript(acc, a.transcriptPath);
    }
    for (const acc of sessions.values()) if (!seen.has(acc.sessionId)) acc.inState = false;
    evict();
  }

  function evict(): void {
    if (sessions.size <= maxSessions) return;
    const candidates = [...sessions.values()].filter((s) => !s.inState).sort((x, y) => x.touchedAt - y.touchedAt);
    for (const s of candidates) {
      if (sessions.size <= maxSessions) break;
      dropMessages(s.sessionId);
      sessions.delete(s.sessionId);
    }
  }

  function dropMessages(sessionId: string): void {
    for (const [id, m] of messages) if (m.sessionId === sessionId) messages.delete(id);
  }

  /** A transcript shrank or was replaced: forget everything counted for the session and re-read. */
  function resetSession(acc: SessionAcc): void {
    dropMessages(acc.sessionId);
    acc.buckets.clear();
    acc.reported = undefined;
    acc.firstAt = undefined;
    acc.lastAt = undefined;
    for (const f of acc.files.values()) {
      f.offset = 0;
      f.size = 0;
      f.mtimeMs = 0;
      f.readOnce = false;
      f.head = undefined;
      f.carry = undefined;
      f.skipping = false;
    }
    resets += 1;
  }

  let projectDirsCache: { at: number; dirs: string[] } | undefined;
  async function projectDirs(): Promise<string[]> {
    if (projectDirsCache && now() - projectDirsCache.at < 30_000) return projectDirsCache.dirs;
    const dirs: string[] = [];
    for (const d of ctx?.claudeDirs ?? []) {
      const root = join(d, 'projects');
      try {
        for (const p of await readdir(root)) dirs.push(join(root, p));
      } catch {
        /* no projects dir */
      }
    }
    projectDirsCache = { at: now(), dirs };
    return dirs;
  }

  async function locate(acc: SessionAcc): Promise<void> {
    const t = now();
    if (!acc.transcriptPath && t - acc.lastLookupAt >= LOOKUP_RETRY_MS) {
      acc.lastLookupAt = t;
      for (const dir of await projectDirs()) {
        const candidate = join(dir, `${acc.sessionId}.jsonl`);
        try {
          if ((await stat(candidate)).isFile()) {
            setTranscript(acc, candidate);
            break;
          }
        } catch {
          /* not in this project */
        }
      }
    }
    if (acc.sessionDir && t - acc.lastSubagentScanAt >= SUBAGENT_RESCAN_MS) {
      acc.lastSubagentScanAt = t;
      const dir = join(acc.sessionDir, 'subagents');
      let names: string[] = [];
      try {
        names = await readdir(dir);
      } catch {
        /* no subagents */
      }
      let fresh = false;
      for (const name of names) {
        const m = /^agent-(.+)\.jsonl$/.exec(name);
        if (!m || !isValidId(m[1])) continue;
        const path = join(dir, name);
        if (!acc.files.has(path)) {
          acc.files.set(path, newCursor(path, m[1]!));
          fresh = true;
        }
      }
      if (fresh) {
        for (const s of await listSubagents(acc.sessionDir, 0)) if (s.agentType) acc.agentTypes.set(s.agentId, s.agentType);
      }
    }
  }

  // ---------- parsing

  function bucketFor(acc: SessionAcc, agent: string, model: string): UsageBucket {
    let byModel = acc.buckets.get(agent);
    if (!byModel) acc.buckets.set(agent, (byModel = new Map()));
    let b = byModel.get(model);
    if (!b) byModel.set(model, (b = emptyBucket()));
    return b;
  }

  function onAssistant(acc: SessionAcc, f: FileCursor, r: Record<string, unknown>): void {
    const m = r.message as Record<string, unknown> | undefined;
    if (!m || typeof m !== 'object') return;
    const model = typeof m.model === 'string' ? m.model.slice(0, MAX_MODEL_LEN) : undefined;
    // `<synthetic>` and similar placeholders are not API calls.
    if (!model || model.startsWith('<')) return;
    const u = m.usage as Record<string, unknown> | undefined;
    if (!u || typeof u !== 'object') return;
    const id = typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 200 ? m.id : undefined;
    if (!id) {
      skipped.noMessageId += 1;
      return;
    }
    const usage: TokenCounts = {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheCreationTokens: num(u.cache_creation_input_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
    };
    const agent = f.agent !== 'main' ? f.agent : r.isSidechain === true ? (isValidId(r.agentId) ? r.agentId : 'sidechain') : 'main';
    const prev = messages.get(id);
    if (!prev) {
      messages.set(id, { sessionId: acc.sessionId, agent, model, ...usage });
      addInto(bucketFor(acc, agent, model), usage, 1);
    } else if (prev.sessionId !== acc.sessionId) {
      skipped.crossSessionDuplicates += 1;
      return;
    } else {
      // Streaming repeats: keep the per-field maximum, add only the difference.
      const delta: TokenCounts = {
        inputTokens: Math.max(0, usage.inputTokens - prev.inputTokens),
        outputTokens: Math.max(0, usage.outputTokens - prev.outputTokens),
        cacheCreationTokens: Math.max(0, usage.cacheCreationTokens - prev.cacheCreationTokens),
        cacheReadTokens: Math.max(0, usage.cacheReadTokens - prev.cacheReadTokens),
      };
      if (totalTokens(delta) > 0) {
        addInto(bucketFor(acc, prev.agent, prev.model), delta, 0);
        prev.inputTokens += delta.inputTokens;
        prev.outputTokens += delta.outputTokens;
        prev.cacheCreationTokens += delta.cacheCreationTokens;
        prev.cacheReadTokens += delta.cacheReadTokens;
      }
    }
    const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (acc.firstAt === undefined || ts < acc.firstAt) acc.firstAt = ts;
      if (acc.lastAt === undefined || ts > acc.lastAt) acc.lastAt = ts;
    }
    if (!acc.transcriptCwd && f.agent === 'main' && typeof r.cwd === 'string' && r.cwd) acc.transcriptCwd = r.cwd.slice(0, 1024);
  }

  function onCostState(acc: SessionAcc, r: Record<string, unknown>): void {
    let src: Record<string, unknown> = r;
    const has = (o: Record<string, unknown>) => 'totalCostUSD' in o || 'totalAPIDuration' in o || 'modelUsage' in o;
    if (!has(r)) {
      for (const k of ['costState', 'state', 'data']) {
        const inner = r[k];
        if (inner && typeof inner === 'object' && !Array.isArray(inner) && has(inner as Record<string, unknown>)) {
          src = inner as Record<string, unknown>;
          break;
        }
      }
    }
    const rep: ReportedCost = { source: 'claude-code' };
    const cost = optNum(src.totalCostUSD);
    if (cost !== undefined) rep.totalCostUSD = cost;
    const dur = optNum(src.totalAPIDuration);
    if (dur !== undefined) rep.totalAPIDurationMs = dur;
    const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    if (Number.isFinite(ts)) rep.at = ts;
    const mu = src.modelUsage;
    if (mu && typeof mu === 'object' && !Array.isArray(mu)) {
      const out: Record<string, ReportedModelUsage> = {};
      let n = 0;
      for (const [model, v] of Object.entries(mu as Record<string, unknown>)) {
        if (n >= 50) break;
        if (!model || model.length > MAX_MODEL_LEN || !v || typeof v !== 'object') continue;
        const o = v as Record<string, unknown>;
        const row: ReportedModelUsage = {};
        for (const k of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD'] as const) {
          const x = optNum(o[k]);
          if (x !== undefined) row[k] = x;
        }
        out[model] = row;
        n++;
      }
      if (n) rep.modelUsage = out;
    }
    if (rep.totalCostUSD === undefined && rep.totalAPIDurationMs === undefined && !rep.modelUsage) return;
    acc.reported = rep;
  }

  function processLine(acc: SessionAcc, f: FileCursor, line: string, tentative: boolean): void {
    // Cheap pre-filter: most lines (tool results, user turns) are never parsed.
    const assistant = line.includes('"assistant"');
    if (!assistant && !line.includes('"cost-state"')) return;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      if (!tentative) skipped.unparsableLines += 1;
      return;
    }
    if (!r || typeof r !== 'object' || Array.isArray(r)) return;
    const rec = r as Record<string, unknown>;
    if (rec.type === 'assistant') onAssistant(acc, f, rec);
    else if (rec.type === 'cost-state' && f.agent === 'main') onCostState(acc, rec);
  }

  function consume(acc: SessionAcc, f: FileCursor, data: Buffer): void {
    let buf = f.carry ? Buffer.concat([f.carry, data]) : data;
    f.carry = undefined;
    if (f.skipping) {
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      buf = buf.subarray(nl + 1);
      f.skipping = false;
    }
    const lastNl = buf.lastIndexOf(10);
    if (lastNl >= 0) {
      // Split on newline bytes, so a multi-byte character is never cut.
      const text = buf.subarray(0, lastNl).toString('utf8');
      for (const line of text.split('\n')) if (line.length > 16) processLine(acc, f, line, false);
    }
    const rest = buf.subarray(lastNl + 1);
    if (rest.length > maxLineBytes) {
      f.skipping = true;
      skipped.oversizedLines += 1;
    } else if (rest.length) {
      f.carry = Buffer.from(rest);
    }
  }

  /**
   * At end of file a final line without a newline may already be complete. Processing is
   * idempotent (dedupe by id, latest cost-state), so it is parsed tentatively and kept as carry.
   */
  function tentativeCarry(acc: SessionAcc, f: FileCursor): void {
    if (!f.carry || f.skipping) return;
    const s = f.carry.toString('utf8').trim();
    if (s.endsWith('}')) processLine(acc, f, s, true);
  }

  function headMatches(known: Buffer, head: Buffer): boolean {
    const n = Math.min(known.length, head.length);
    return known.subarray(0, n).equals(head.subarray(0, n));
  }

  /** Read and parse up to `allowance` bytes of one file. Returns bytes consumed. */
  async function scanFile(acc: SessionAcc, f: FileCursor, allowance: number): Promise<number> {
    // stat first: unchanged files are never opened again (opening is what antivirus slows down).
    const st = await box.run(`stat:${f.path}`, now(), () => stat(f.path));
    if (!st.ok) {
      if (st.reason === 'missing') f.missing = true;
      return 0;
    }
    f.missing = false;
    if (f.readOnce && st.value.size === f.size && st.value.mtimeMs === f.mtimeMs && f.offset >= f.size) {
      tentativeCarry(acc, f);
      return 0;
    }
    const res = await box.run(f.path, now(), () => reader(f.path, f.offset, allowance, HEAD_BYTES));
    if (!res.ok) {
      if (res.reason === 'missing') f.missing = true;
      return 0;
    }
    let { size, head, data } = res.value;
    if (size < f.offset || (f.head && !headMatches(f.head, head))) {
      // Truncated or replaced: recount the whole session from zero (never add twice).
      resetSession(acc);
      const again = await box.run(f.path, now(), () => reader(f.path, 0, allowance, HEAD_BYTES));
      if (!again.ok) return 0;
      ({ size, head, data } = again.value);
    }
    if (!f.head || head.length > f.head.length) f.head = Buffer.from(head);
    f.size = size;
    f.mtimeMs = st.value.mtimeMs;
    f.readOnce = true;
    if (data.length) {
      consume(acc, f, data);
      f.offset += data.length;
    }
    if (f.offset >= f.size) tentativeCarry(acc, f);
    return data.length;
  }

  // ---------- passes

  function orderedSessions(only?: string): SessionAcc[] {
    const list = only ? [sessions.get(only)].filter((s): s is SessionAcc => Boolean(s)) : [...sessions.values()];
    return list.sort((x, y) => Number(y.inState) - Number(x.inState) || (y.lastAt ?? y.touchedAt) - (x.lastAt ?? x.touchedAt));
  }

  async function pass(only?: string): Promise<boolean> {
    if (!ctx) return false;
    const t0 = Date.now();
    syncFromState();
    refreshPricing();
    let budget = maxBytesPerPass;
    let backlog = false;
    outer: for (const acc of orderedSessions(only)) {
      await locate(acc);
      // Subagent files first: a sidechain copy in the main file is then attributed to its subagent.
      const files = [...acc.files.values()].sort((x, y) => Number(x.agent === 'main') - Number(y.agent === 'main'));
      for (const f of files) {
        if (budget <= 0) {
          backlog = true;
          break outer;
        }
        const got = await scanFile(acc, f, Math.min(budget, maxBytesPerFile));
        budget -= got;
        if (f.offset < f.size) backlog = true;
        if (got > 0) await yieldToLoop();
      }
    }
    lastScanAt = now();
    lastScanMs = Date.now() - t0;
    return backlog;
  }

  function runPass(only?: string): Promise<boolean> {
    const p = chain.then(() => pass(only));
    chain = p.then(
      () => undefined,
      (e) => ctx?.log(`usage scan failed: ${(e as Error).message}`),
    );
    return p.catch(() => false);
  }

  function schedule(delay: number): void {
    if (stopped || opts.autoScan === false) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped) return;
      void runPass().then((backlog) => schedule(backlog ? catchUpMs : intervalMs));
    }, delay);
    timer.unref?.();
  }

  async function boundedRefresh(only?: string): Promise<void> {
    let t: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((r) => {
      t = setTimeout(r, 8000);
      t.unref?.();
    });
    await Promise.race([runPass(only), limit]);
    clearTimeout(t);
  }

  // ---------- results

  function backlogBytes(): number {
    let n = 0;
    for (const s of sessions.values()) for (const f of s.files.values()) if (f.size > f.offset) n += f.size - f.offset;
    return n;
  }

  function fileCount(): number {
    let n = 0;
    for (const s of sessions.values()) n += s.files.size;
    return n;
  }

  function scanStatus(): UsageScanStatus {
    const s: UsageScanStatus = {
      sessionsTracked: sessions.size,
      filesTracked: fileCount(),
      backlogBytes: backlogBytes(),
      slowFiles: box.slowCount(now()),
      skipped: { ...skipped },
      resets,
    };
    if (lastScanAt !== undefined) s.lastScanAt = lastScanAt;
    if (lastScanMs !== undefined) s.lastScanMs = lastScanMs;
    return s;
  }

  function estimate(byModel: Record<string, TokenCounts>): CostEstimate | undefined {
    return priceTable ? estimateCost(byModel, priceTable) : undefined;
  }

  function cwdOf(acc: SessionAcc): string | undefined {
    return acc.stateCwd ?? acc.transcriptCwd;
  }

  function sessionRow(acc: SessionAcc): UsageSessionRow {
    const byModel: Record<string, UsageBucket> = {};
    const subByModel: Record<string, UsageBucket> = {};
    for (const [agent, models] of acc.buckets) {
      mergeModels(byModel, models);
      if (agent !== 'main') mergeModels(subByModel, models);
    }
    const subagentKeys = new Set<string>();
    for (const f of acc.files.values()) if (f.agent !== 'main') subagentKeys.add(f.agent);
    for (const agent of acc.buckets.keys()) if (agent !== 'main') subagentKeys.add(agent);
    const complete = Boolean(acc.transcriptPath) && [...acc.files.values()].every((f) => f.readOnce && !f.missing && f.offset >= f.size);
    const row: UsageSessionRow = {
      sessionId: acc.sessionId,
      total: sumModels(byModel),
      byModel,
      subagentTotal: sumModels(subByModel),
      subagents: subagentKeys.size,
      complete,
      inState: acc.inState,
    };
    const cwd = cwdOf(acc);
    if (cwd) {
      row.cwd = cwd;
      row.projectKey = normalizePathKey(cwd);
      row.project = baseName(cwd);
    }
    if (acc.title) row.title = acc.title;
    if (acc.firstAt !== undefined) row.firstAt = acc.firstAt;
    if (acc.lastAt !== undefined) row.lastAt = acc.lastAt;
    if (acc.reported) row.reported = acc.reported;
    const est = estimate(byModel);
    if (est) row.estimate = est;
    return row;
  }

  function agentRows(acc: SessionAcc): UsageAgentRow[] {
    const rows: UsageAgentRow[] = [];
    for (const [agent, models] of acc.buckets) {
      const byModel: Record<string, UsageBucket> = {};
      mergeModels(byModel, models);
      const row: UsageAgentRow = {
        sessionId: acc.sessionId,
        agent,
        kind: agent === 'main' ? 'main' : agent === 'sidechain' ? 'sidechain' : 'subagent',
        total: sumModels(byModel),
        byModel,
      };
      const type = acc.agentTypes.get(agent);
      if (type) row.agentType = type;
      const est = estimate(byModel);
      if (est) row.estimate = est;
      rows.push(row);
    }
    return rows.sort((x, y) => (x.kind === 'main' ? -1 : y.kind === 'main' ? 1 : totalTokens(y.total) - totalTokens(x.total)));
  }

  function summary(): UsageSummary {
    refreshPricing();
    const rows = [...sessions.values()].map(sessionRow);
    const byModel: Record<string, UsageBucket> = {};
    const projects = new Map<string, UsageProjectRow & { models: Record<string, UsageBucket> }>();
    let reportedSessions = 0;
    let reportedTotal = 0;
    for (const r of rows) {
      mergeModels(byModel, r.byModel);
      const key = r.projectKey ?? '(unknown)';
      let p = projects.get(key);
      if (!p) {
        p = { key, label: r.project ?? 'Unknown project', sessions: 0, total: emptyBucket(), reportedSessions: 0, models: {} };
        if (r.cwd) p.cwd = r.cwd;
        projects.set(key, p);
      }
      p.sessions += 1;
      addInto(p.total, r.total, r.total.messages);
      mergeModels(p.models, r.byModel);
      if (r.reported?.totalCostUSD !== undefined) {
        reportedSessions += 1;
        reportedTotal += r.reported.totalCostUSD;
        p.reportedSessions += 1;
        p.reportedCostUSD = (p.reportedCostUSD ?? 0) + r.reported.totalCostUSD;
      }
    }
    const modelRows: UsageModelRow[] = Object.entries(byModel)
      .map(([model, total]) => {
        const row: UsageModelRow = { model, total };
        const est = estimate({ [model]: total });
        if (est) row.estimate = est;
        return row;
      })
      .sort((x, y) => totalTokens(y.total) - totalTokens(x.total));
    const projectRows: UsageProjectRow[] = [...projects.values()]
      .map(({ models, ...p }) => {
        const est = estimate(models);
        return est ? { ...p, estimate: est } : p;
      })
      .sort((x, y) => totalTokens(y.total) - totalTokens(x.total));
    const agents = [...sessions.values()]
      .flatMap(agentRows)
      .sort((x, y) => totalTokens(y.total) - totalTokens(x.total))
      .slice(0, MAX_SUMMARY_AGENTS);
    const out: UsageSummary = {
      source: 'transcript',
      generatedAt: now(),
      total: sumModels(byModel),
      byModel: modelRows,
      byProject: projectRows,
      sessions: rows.sort((x, y) => (y.lastAt ?? 0) - (x.lastAt ?? 0)).slice(0, MAX_SUMMARY_SESSIONS),
      agents,
      reported: reportedSessions ? { source: 'claude-code', sessions: reportedSessions, totalCostUSD: reportedTotal } : null,
      pricing,
      scan: scanStatus(),
    };
    const est = estimate(byModel);
    if (est) out.estimate = est;
    return out;
  }

  function sessionDetail(sessionId: string): UsageSessionDetail {
    const acc = sessions.get(sessionId);
    if (!acc) {
      return {
        sessionId,
        total: emptyBucket(),
        byModel: {},
        subagentTotal: emptyBucket(),
        subagents: 0,
        complete: false,
        inState: false,
        agents: [],
        tracked: false,
        transcriptFound: false,
      };
    }
    return { ...sessionRow(acc), agents: agentRows(acc), tracked: true, transcriptFound: Boolean(acc.transcriptPath) };
  }

  return {
    name: 'usage',
    start(c) {
      ctx = c;
      stopped = false;
      refreshPricing();
      schedule(0);
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      let t: NodeJS.Timeout | undefined;
      await Promise.race([chain, new Promise<void>((r) => (t = setTimeout(r, 3000)))]);
      clearTimeout(t);
    },
    scanNow: async () => {
      await runPass();
    },
    routes: {
      async summary(params) {
        if (params.refresh === true) await boundedRefresh();
        return summary();
      },
      async session(params) {
        const sessionId = params.sessionId;
        if (!isValidId(sessionId)) throw new Error('invalid sessionId');
        if (!sessions.has(sessionId)) {
          // Historical session not in the live state: track it on request (bounded like any pass).
          getAcc(sessionId).touchedAt = now();
          evict();
          await boundedRefresh(sessionId);
        } else if (params.refresh === true) {
          await boundedRefresh(sessionId);
        }
        return sessionDetail(sessionId);
      },
    },
    meta(): UsageMeta {
      const m: UsageMeta = { sessionsTracked: sessions.size, filesTracked: fileCount(), backlogBytes: backlogBytes(), pricing: pricing.state };
      if (lastScanAt !== undefined) m.lastScanAt = lastScanAt;
      return m;
    },
  };
}
