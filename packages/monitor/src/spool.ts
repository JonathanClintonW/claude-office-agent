import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Durable buffer for hook events captured while the monitor is not running.
 * One small file per event keeps concurrent hook processes race-free.
 */

export const MAX_SPOOL_FILES = 5000;
const SPOOL_FILE = /^ev-\d+-\d+-[a-f0-9]+\.json$/;

export function spoolDir(home: string): string {
  return join(home, 'spool');
}

export function appendToSpool(home: string, body: string): boolean {
  const dir = spoolDir(home);
  try {
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length >= MAX_SPOOL_FILES) return false;
    const name = `ev-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}.json`;
    // Write under a temporary name so a draining monitor never reads a partial file.
    writeFileSync(join(dir, `${name}.part`), body, { encoding: 'utf8', mode: 0o600 });
    renameSync(join(dir, `${name}.part`), join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/** Claim and remove all spooled events. Each file is claimed by rename so two monitors never replay the same event. */
export function drainSpool(home: string): unknown[] {
  const dir = spoolDir(home);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => SPOOL_FILE.test(n));
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const name of names.sort()) {
    const claimed = join(dir, `${name}.claimed-${process.pid}`);
    try {
      renameSync(join(dir, name), claimed);
    } catch {
      continue; // claimed by someone else
    }
    try {
      out.push(JSON.parse(readFileSync(claimed, 'utf8')));
    } catch {
      /* corrupt entry: drop */
    }
    try {
      unlinkSync(claimed);
    } catch {
      /* ignore */
    }
  }
  return out;
}
