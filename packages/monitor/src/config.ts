import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_PORT, normalizePathKey } from '@agent-office/core';

export interface AppConfig {
  port: number;
  /** Shared secret for hook ingestion and UI connections. Generated locally, never leaves the machine. */
  token: string;
  /** Extra Claude configuration directories to watch, in addition to ~/.claude and CLAUDE_CONFIG_DIR. */
  claudeConfigDirs: string[];
}

export function resolveAppHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office'));
}

export function defaultClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
}

/** Unique Claude config dirs, compared case-insensitively on Windows. */
export function resolveClaudeDirs(extra: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of [defaultClaudeDir(env), ...extra]) {
    if (!d || !d.trim()) continue;
    const abs = resolve(d.trim());
    const key = normalizePathKey(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
  // Windows may briefly lock the target (antivirus, indexer); retry a few times.
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 5) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
}

function sanitizeConfig(raw: unknown): Partial<AppConfig> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<AppConfig> = {};
  if (typeof r.port === 'number' && Number.isInteger(r.port) && r.port >= 1024 && r.port <= 65535) out.port = r.port;
  if (typeof r.token === 'string' && /^[A-Za-z0-9]{32,128}$/.test(r.token)) out.token = r.token;
  if (Array.isArray(r.claudeConfigDirs)) out.claudeConfigDirs = r.claudeConfigDirs.filter((d): d is string => typeof d === 'string').slice(0, 20);
  return out;
}

export function configPath(home: string): string {
  return join(home, 'config.json');
}

/** Read config without creating anything (used by the hook forwarder and status checks). */
export function readConfig(home: string): AppConfig | undefined {
  try {
    const c = sanitizeConfig(JSON.parse(readFileSync(configPath(home), 'utf8')));
    if (!c.token) return undefined;
    return { port: c.port ?? DEFAULT_PORT, token: c.token, claudeConfigDirs: c.claudeConfigDirs ?? [] };
  } catch {
    return undefined;
  }
}

export function loadOrCreateConfig(home: string, overrides: Partial<AppConfig> = {}): AppConfig {
  let current: Partial<AppConfig> = {};
  if (existsSync(configPath(home))) {
    try {
      current = sanitizeConfig(JSON.parse(readFileSync(configPath(home), 'utf8')));
    } catch {
      current = {};
    }
  }
  const cfg: AppConfig = {
    port: overrides.port ?? current.port ?? DEFAULT_PORT,
    token: current.token ?? randomBytes(24).toString('hex'),
    claudeConfigDirs: overrides.claudeConfigDirs ?? current.claudeConfigDirs ?? [],
  };
  const changed = cfg.port !== current.port || cfg.token !== current.token || JSON.stringify(cfg.claudeConfigDirs) !== JSON.stringify(current.claudeConfigDirs);
  if (changed) writeFileAtomic(configPath(home), JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}
