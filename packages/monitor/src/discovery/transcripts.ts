import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isValidId, safeText, type TokenUsage } from '@agent-office/core';

/**
 * Read-only transcript discovery under `<claudeDir>/projects/<slug>/<sessionId>.jsonl`.
 *
 * Transcripts can be tens of megabytes, so only the tail is read. Message content is
 * never extracted: only the session title, model, last activity time, cwd and the
 * token usage that Claude Code itself recorded for the latest API call.
 */

const TAIL_BYTES = 256 * 1024;
const MAX_TRANSCRIPTS = 80;

export interface TranscriptFile {
  sessionId: string;
  path: string;
  /** Directory holding `subagents/` for this session. */
  sessionDir: string;
  mtimeMs: number;
  size: number;
}

export interface TranscriptInfo {
  cwd?: string;
  title?: string;
  model?: string;
  lastActivityAt?: number;
  usage?: TokenUsage;
}

export interface SubagentMeta {
  agentId: string;
  agentType?: string;
  description?: string;
  finished?: boolean;
  spawnToolUseId?: string;
  mtimeMs: number;
}

export async function listTranscripts(claudeDir: string, opts: { minMtimeMs: number; include: ReadonlySet<string> }): Promise<{ available: boolean; files: TranscriptFile[] }> {
  const root = join(claudeDir, 'projects');
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return { available: false, files: [] };
  }
  const files: TranscriptFile[] = [];
  for (const p of projects) {
    const dir = join(root, p);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const sessionId = n.slice(0, -'.jsonl'.length);
      if (!isValidId(sessionId)) continue;
      const file = join(dir, n);
      try {
        const st = await stat(file);
        if (!st.isFile()) continue;
        if (st.mtimeMs < opts.minMtimeMs && !opts.include.has(sessionId)) continue;
        files.push({ sessionId, path: file, sessionDir: join(dir, sessionId), mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* ignore */
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { available: true, files: files.slice(0, MAX_TRANSCRIPTS) };
}

async function readTail(file: string, bytes: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const st = await fh.stat();
    const start = Math.max(0, st.size - bytes);
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    return text;
  } finally {
    await fh.close();
  }
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function parseTranscriptTail(text: string): TranscriptInfo {
  const info: TranscriptInfo = {};
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r || typeof r !== 'object') continue;
    if (info.lastActivityAt === undefined && typeof r.timestamp === 'string') {
      const t = Date.parse(r.timestamp);
      if (Number.isFinite(t)) info.lastActivityAt = t;
    }
    if (info.cwd === undefined && typeof r.cwd === 'string') info.cwd = r.cwd.slice(0, 1024);
    if (info.title === undefined && r.type === 'ai-title' && typeof r.aiTitle === 'string') info.title = safeText(r.aiTitle, 160);
    if (info.usage === undefined && r.type === 'assistant' && r.isSidechain !== true) {
      const m = r.message as Record<string, unknown> | undefined;
      const model = m && typeof m.model === 'string' && !m.model.startsWith('<') ? m.model : undefined;
      const u = m?.usage as Record<string, unknown> | undefined;
      if (model && u) {
        info.model = model.slice(0, 100);
        const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
        info.usage = {
          inputTokens: n(u.input_tokens),
          cacheReadTokens: n(u.cache_read_input_tokens),
          cacheCreationTokens: n(u.cache_creation_input_tokens),
          outputTokens: n(u.output_tokens),
          ...(Number.isFinite(at) ? { at } : {}),
        };
      }
    }
    if (info.lastActivityAt !== undefined && info.cwd !== undefined && info.title !== undefined && info.usage !== undefined) break;
  }
  return info;
}

export async function readTranscriptInfo(file: string): Promise<TranscriptInfo> {
  try {
    return parseTranscriptTail(await readTail(file, TAIL_BYTES));
  } catch {
    return {};
  }
}

/**
 * Opening a transcript that is being appended to can block for a long time on Windows
 * (real-time antivirus rescans the growing file on every open). Each read gets a time
 * budget; a file that exceeds it is skipped and cooled down, and a file is never read
 * twice concurrently, so a stuck read can neither stall discovery nor pile up I/O threads.
 */
export class GuardedReader {
  private inflight = new Set<string>();
  private cooldownUntil = new Map<string, number>();

  constructor(
    private readonly read: (file: string) => Promise<TranscriptInfo> = readTranscriptInfo,
    private readonly timeoutMs = 2500,
    private readonly cooldownMs = 120_000,
  ) {}

  async info(file: string, now = Date.now()): Promise<TranscriptInfo | 'busy'> {
    if (this.inflight.has(file) || (this.cooldownUntil.get(file) ?? 0) > now) return 'busy';
    this.inflight.add(file);
    const op = this.read(file).finally(() => this.inflight.delete(file));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), this.timeoutMs);
      timer.unref?.();
    });
    const res = await Promise.race([op, timeout]);
    clearTimeout(timer);
    if (res === 'timeout') {
      this.cooldownUntil.set(file, now + this.cooldownMs);
      op.catch(() => {});
      return 'busy';
    }
    return res;
  }

  isSlow(file: string, now = Date.now()): boolean {
    return (this.cooldownUntil.get(file) ?? 0) > now;
  }
}

export async function listSubagents(sessionDir: string, minMtimeMs: number): Promise<SubagentMeta[]> {
  const dir = join(sessionDir, 'subagents');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SubagentMeta[] = [];
  for (const name of names) {
    const m = /^agent-(.+)\.meta\.json$/.exec(name);
    if (!m || !isValidId(m[1])) continue;
    const agentId = m[1]!;
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(join(dir, `agent-${agentId}.jsonl`))).mtimeMs;
    } catch {
      try {
        mtimeMs = (await stat(join(dir, name))).mtimeMs;
      } catch {
        continue;
      }
    }
    if (mtimeMs < minMtimeMs) continue;
    try {
      const raw = await readFile(join(dir, name), 'utf8');
      if (raw.length > 64 * 1024) continue;
      const meta = JSON.parse(raw) as Record<string, unknown>;
      const s: SubagentMeta = { agentId, mtimeMs };
      // Shown as the agent's type, so it gets the same treatment as other free text.
      const agentType = safeText(meta.agentType, 100);
      if (agentType) s.agentType = agentType;
      const desc = safeText(meta.description, 160);
      if (desc) s.description = desc;
      if (typeof meta.finished === 'boolean') s.finished = meta.finished;
      if (isValidId(meta.toolUseId)) s.spawnToolUseId = meta.toolUseId;
      out.push(s);
    } catch {
      /* ignore unreadable meta */
    }
  }
  return out;
}

export function sessionIdFromTranscriptPath(p: string): string | undefined {
  const b = basename(p);
  if (!b.endsWith('.jsonl')) return undefined;
  const id = b.slice(0, -6);
  return isValidId(id) ? id : undefined;
}
