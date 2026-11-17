import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidId, truncate } from '@agent-office/core';

/**
 * Read-only access to Claude Code's live session registry: `<claudeDir>/sessions/<pid>.json`.
 *
 * Only whitelisted, non-secret fields are read. The neighbouring `<pid>.<hash>.key` files
 * contain peer tokens and are never opened (see REGISTRY_FILE).
 */

export const REGISTRY_FILE = /^\d{1,10}\.json$/;
const MAX_FILE_BYTES = 64 * 1024;

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  version?: string;
  kind?: string;
  entrypoint?: string;
  name?: string;
  status?: string;
  waitingFor?: string;
  statusUpdatedAt?: number;
  updatedAt?: number;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}
function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length ? truncate(v, max) : undefined;
}

export function parseRegistryEntry(raw: unknown): RegistryEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const pid = r.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (!isValidId(r.sessionId)) return undefined;
  const e: RegistryEntry = { pid, sessionId: r.sessionId };
  const fields: Array<[keyof RegistryEntry, unknown]> = [
    ['cwd', str(r.cwd, 1024)],
    ['startedAt', num(r.startedAt)],
    ['version', str(r.version, 40)],
    ['kind', str(r.kind, 40)],
    ['entrypoint', str(r.entrypoint, 60)],
    ['name', str(r.name, 120)],
    ['status', str(r.status, 40)],
    ['waitingFor', str(r.waitingFor, 120)],
    ['statusUpdatedAt', num(r.statusUpdatedAt)],
    ['updatedAt', num(r.updatedAt)],
  ];
  for (const [k, v] of fields) if (v !== undefined) (e as unknown as Record<string, unknown>)[k] = v;
  return e;
}

export async function readRegistry(claudeDir: string): Promise<{ available: boolean; entries: RegistryEntry[] }> {
  const dir = join(claudeDir, 'sessions');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { available: false, entries: [] };
  }
  const entries: RegistryEntry[] = [];
  for (const name of names) {
    if (!REGISTRY_FILE.test(name)) continue;
    const file = join(dir, name);
    try {
      const st = await stat(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const e = parseRegistryEntry(JSON.parse(await readFile(file, 'utf8')));
      if (e) entries.push(e);
    } catch {
      /* file disappeared or is mid-write; next scan will pick it up */
    }
  }
  return { available: true, entries };
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
