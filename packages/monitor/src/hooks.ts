import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import {
  HOOK_EVENTS,
  normalizePathKey,
  TOKEN_HEADER,
  type ClaudeDirStatus,
  type HookEventName,
  type HookScopeReport,
  type HooksInstallState,
} from '@agent-office/core';
import { writeFileAtomic } from './config';

/**
 * Non-destructive management of Agent Office hooks in Claude Code settings files.
 *
 * - Existing hooks, matchers and every other setting are preserved byte-for-byte in meaning.
 * - Only handlers we own (identified by HOOK_MARKER or our HTTP endpoint + header) are touched.
 * - A timestamped backup is written before every change, and a plan can be reviewed first.
 */

export const HOOK_MARKER = 'agent-office-hook';
export const FORWARDER_FILE = `${HOOK_MARKER}.cjs`;

/** Events that support HTTP handlers. SessionStart only supports command hooks. */
const COMMAND_ONLY: ReadonlySet<string> = new Set(['SessionStart']);

export type HookMode = 'command' | 'http';

type Json = Record<string, unknown>;

export function isOurHandler(h: unknown): boolean {
  if (!h || typeof h !== 'object') return false;
  const o = h as Json;
  if (o.type === 'command') {
    const parts = [o.command, ...(Array.isArray(o.args) ? o.args : [])];
    return parts.some((p) => typeof p === 'string' && p.includes(HOOK_MARKER));
  }
  if (o.type === 'http' && typeof o.url === 'string' && o.url.includes('/api/hook')) {
    const headers = o.headers && typeof o.headers === 'object' ? Object.keys(o.headers as Json) : [];
    return headers.some((k) => k.toLowerCase() === TOKEN_HEADER);
  }
  return false;
}

export interface SettingsInspection {
  hooks: HooksInstallState;
  hookEvents: string[];
  hooksDisabled: boolean;
}

export function inspectSettingsText(text: string | undefined): SettingsInspection {
  if (text === undefined) return { hooks: 'not_installed', hookEvents: [], hooksDisabled: false };
  let s: Json;
  try {
    s = JSON.parse(text) as Json;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('not an object');
  } catch {
    return { hooks: 'unreadable', hookEvents: [], hooksDisabled: false };
  }
  const hooks = s.hooks && typeof s.hooks === 'object' ? (s.hooks as Json) : {};
  const events: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const has = groups.some((g) => g && typeof g === 'object' && Array.isArray((g as Json).hooks) && ((g as Json).hooks as unknown[]).some(isOurHandler));
    if (has) events.push(event);
  }
  const required = HOOK_EVENTS.slice(0, 13);
  const state: HooksInstallState = events.length === 0 ? 'not_installed' : required.every((e) => events.includes(e)) ? 'installed' : 'partial';
  return { hooks: state, hookEvents: events, hooksDisabled: s.disableAllHooks === true };
}

export function userSettingsPath(claudeDir: string): string {
  return join(claudeDir, 'settings.json');
}

export function projectSettingsPath(projectDir: string): string {
  return join(projectDir, '.claude', 'settings.local.json');
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export function inspectClaudeDir(claudeDir: string): ClaudeDirStatus {
  let text: string | undefined;
  let unreadable = false;
  try {
    text = readText(userSettingsPath(claudeDir));
  } catch {
    unreadable = true;
  }
  const ins = unreadable ? { hooks: 'unreadable' as const, hookEvents: [], hooksDisabled: false } : inspectSettingsText(text);
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  return {
    path: claudeDir,
    hooks: ins.hooks,
    hookEvents: ins.hookEvents,
    hooksDisabled: ins.hooksDisabled || undefined,
    registryAvailable: isDir(join(claudeDir, 'sessions')),
    transcriptsAvailable: isDir(join(claudeDir, 'projects')),
  };
}

export interface InstallOptions {
  settingsPath: string;
  mode: HookMode;
  /** Absolute path to a Node.js executable (required for command handlers). */
  nodePath?: string;
  /** Absolute path of the installed forwarder script. */
  forwarderPath: string;
  /** Agent Office home passed to the forwarder so it finds the right config. */
  home: string;
  port: number;
  token: string;
  events?: readonly HookEventName[];
}

export interface HookPlan {
  settingsPath: string;
  existed: boolean;
  before: string | undefined;
  after: string;
  changed: boolean;
  events: string[];
  warnings: string[];
}

function detectIndent(text: string | undefined): string | number {
  const m = text ? /\n([ \t]+)"/.exec(text) : null;
  return m ? m[1]! : 2;
}

function parseSettings(text: string | undefined, file: string): Json {
  if (text === undefined || !text.trim()) return {};
  let s: unknown;
  try {
    s = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}); refusing to modify it.`);
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${file} does not contain a JSON object; refusing to modify it.`);
  return s as Json;
}

/** Remove our handlers from a hooks object; drop groups/events that become empty only if we emptied them. */
function stripOurs(hooks: Json, keepEmptyKeys = false): Json {
  const out: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept: unknown[] = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray((g as Json).hooks)) {
        kept.push(g);
        continue;
      }
      const handlers = (g as Json).hooks as unknown[];
      const remaining = handlers.filter((h) => !isOurHandler(h));
      if (remaining.length === handlers.length) kept.push(g);
      else if (remaining.length > 0) kept.push({ ...(g as Json), hooks: remaining });
    }
    if (keepEmptyKeys || kept.length > 0 || groups.length === 0) out[event] = kept;
  }
  return out;
}

function handlerFor(event: string, o: InstallOptions): Json | undefined {
  const useCommand = o.mode === 'command' || COMMAND_ONLY.has(event);
  if (useCommand) {
    if (!o.nodePath) return undefined;
    // Exec form (no shell): robust against spaces and quoting in Windows paths.
    // async: never blocks Claude Code and can never influence a decision.
    return { type: 'command', command: o.nodePath, args: [o.forwarderPath, '--home', o.home], async: true, timeout: 10 };
  }
  return { type: 'http', url: `http://127.0.0.1:${o.port}/api/hook`, headers: { [TOKEN_HEADER]: o.token }, timeout: 3 };
}

/**
 * The only hook handler types the installer may ever write. `prompt` and `agent` handlers run a
 * model on every event (consuming the user's tokens) and `mcp_tool` handlers call MCP servers;
 * Agent Office must never install any of them.
 */
export const PASSIVE_HANDLER_TYPES: ReadonlySet<string> = new Set(['command', 'http']);

/** Throws unless `h` is a passive handler: an async command hook, or an HTTP hook to 127.0.0.1. */
export function assertPassiveHandler(h: Json): void {
  if (!PASSIVE_HANDLER_TYPES.has(String(h.type))) throw new Error(`refusing to install a "${String(h.type)}" hook: only command and http handlers are passive`);
  if (h.type === 'command' && h.async !== true) throw new Error('refusing to install a synchronous command hook');
  if (h.type === 'http' && !/^http:\/\/127\.0\.0\.1:\d+\//.test(String(h.url))) throw new Error('refusing to install an HTTP hook that does not target 127.0.0.1');
}

function finishPlan(file: string, before: string | undefined, settings: Json, events: string[], warnings: string[]): HookPlan {
  const indent = detectIndent(before);
  const eol = before?.includes('\r\n') ? '\r\n' : '\n';
  let after = JSON.stringify(settings, null, indent) + '\n';
  if (eol === '\r\n') after = after.replace(/\n/g, '\r\n');
  const same = before !== undefined && JSON.stringify(parseSettings(before, file)) === JSON.stringify(settings);
  return { settingsPath: file, existed: before !== undefined, before, after: same ? before! : after, changed: !same, events, warnings };
}

export function planInstall(o: InstallOptions): HookPlan {
  const before = readText(o.settingsPath);
  const settings = parseSettings(before, o.settingsPath);
  const warnings: string[] = [];
  if (settings.disableAllHooks === true) warnings.push('disableAllHooks is true in this file: Claude Code will not run any hooks until it is removed.');
  if (o.mode === 'http' && Array.isArray(settings.allowedHttpHookUrls)) {
    warnings.push('allowedHttpHookUrls is set: add "http://127.0.0.1:*" to it or HTTP hooks will be blocked.');
  }
  if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))) {
    throw new Error(`${o.settingsPath}: "hooks" is not an object; refusing to modify it.`);
  }
  const original = (settings.hooks as Json | undefined) ?? {};
  const hooks = stripOurs(original, true);
  const events: string[] = [];
  for (const event of o.events ?? HOOK_EVENTS) {
    const h = handlerFor(event, o);
    if (!h) {
      warnings.push(`${event} skipped: it needs a command hook and no Node.js executable was found.`);
      continue;
    }
    assertPassiveHandler(h);
    const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    groups.push({ hooks: [h] });
    hooks[event] = groups;
    events.push(event);
  }
  // Drop event keys that only held our handlers and are no longer subscribed.
  for (const [event, groups] of Object.entries(hooks)) {
    const was = original[event];
    if (Array.isArray(groups) && groups.length === 0 && Array.isArray(was) && was.length > 0) delete hooks[event];
  }
  return finishPlan(o.settingsPath, before, { ...settings, hooks }, events, warnings);
}

export function planUninstall(settingsPath: string): HookPlan {
  const before = readText(settingsPath);
  if (before === undefined) return { settingsPath, existed: false, before, after: '', changed: false, events: [], warnings: [] };
  const settings = parseSettings(before, settingsPath);
  if (!settings.hooks || typeof settings.hooks !== 'object') return finishPlan(settingsPath, before, settings, [], []);
  const removed = inspectSettingsText(before).hookEvents;
  const hooks = stripOurs(settings.hooks as Json);
  const next: Json = { ...settings, hooks };
  // Remove the "hooks" key only if it held nothing but our handlers.
  if (Object.keys(hooks).length === 0 && removed.length > 0) delete next.hooks;
  return finishPlan(settingsPath, before, next, removed, []);
}

export interface ApplyResult {
  written: boolean;
  backupPath?: string;
}

/** Apply a plan. Refuses if the file changed since the plan was made. */
export function applyPlan(plan: HookPlan, now = Date.now()): ApplyResult {
  if (!plan.changed) return { written: false };
  const current = readText(plan.settingsPath);
  if (current !== plan.before) throw new Error(`${plan.settingsPath} changed since the plan was created; please re-run.`);
  let backupPath: string | undefined;
  if (current !== undefined) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    backupPath = `${plan.settingsPath}.agent-office-backup-${stamp}`;
    copyFileSync(plan.settingsPath, backupPath);
  } else {
    mkdirSync(dirname(plan.settingsPath), { recursive: true });
  }
  writeFileAtomic(plan.settingsPath, plan.after);
  return { written: true, backupPath };
}

/** Copy the bundled forwarder to a stable location so hook paths survive extension updates. */
export function installForwarder(bundledForwarder: string, home: string): string {
  const target = join(home, 'bin', FORWARDER_FILE);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(bundledForwarder, target);
  return target;
}

/** Locate a real Node.js binary (inside VS Code, process.execPath is Electron). */
export function findNodeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!process.versions.electron && process.execPath) return process.execPath;
  const names = process.platform === 'win32' ? ['node.exe'] : ['node'];
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = join(dir.replace(/^"|"$/g, ''), n);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- duplicate scopes

export interface HookScopeFile {
  scope: 'user' | 'project' | 'project-local';
  path: string;
  /** File contents, or undefined when the file does not exist. */
  text: string | undefined;
  /** Project directory (groups `.claude/settings.json` and `.claude/settings.local.json`). */
  project?: string;
}

/**
 * Pure: which settings files hold Agent Office hooks, and which events are registered in more
 * than one scope that applies to the same session. A session reads its user settings plus the
 * project's `.claude/settings.json` and `.claude/settings.local.json`; every scope that holds
 * our handler for an event delivers that event once more. Several user config dirs alone are
 * not a duplicate: one session only reads one of them.
 */
export function detectDuplicateHookScopes(files: readonly HookScopeFile[], now = Date.now()): HookScopeReport {
  const scopes: HookScopeReport['scopes'] = [];
  const seen = new Set<string>();
  const userEvents = new Set<string>();
  const perProject = new Map<string, Map<string, number>>();
  const userFirst = [...files].sort((a, b) => Number(a.scope !== 'user') - Number(b.scope !== 'user'));
  for (const f of userFirst) {
    const key = normalizePathKey(f.path);
    if (seen.has(key)) continue; // e.g. a project rooted at the home directory: its .claude is the user dir
    seen.add(key);
    const events = inspectSettingsText(f.text).hookEvents;
    if (!events.length) continue;
    scopes.push({ scope: f.scope, path: f.path, events });
    if (f.scope === 'user') {
      for (const e of events) userEvents.add(e);
      continue;
    }
    const projectKey = normalizePathKey(f.project ?? f.path);
    const counts = perProject.get(projectKey) ?? new Map<string, number>();
    perProject.set(projectKey, counts);
    for (const e of events) counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  const dup = new Set<string>();
  for (const counts of perProject.values()) {
    for (const [e, n] of counts) if (n + (userEvents.has(e) ? 1 : 0) > 1) dup.add(e);
  }
  const order = (e: string) => {
    const i = (HOOK_EVENTS as readonly string[]).indexOf(e);
    return i < 0 ? HOOK_EVENTS.length : i;
  };
  return { scopes, duplicateEvents: [...dup].sort((a, b) => order(a) - order(b) || a.localeCompare(b)), checkedAt: now };
}

/** Read the user settings of each Claude config dir and both project settings files of each project dir. */
export function collectHookScopes(claudeDirs: readonly string[], projectDirs: readonly string[], now = Date.now()): HookScopeReport {
  const read = (p: string) => {
    try {
      return readText(p);
    } catch {
      return undefined;
    }
  };
  const files: HookScopeFile[] = claudeDirs.map((d) => ({ scope: 'user' as const, path: userSettingsPath(d), text: read(userSettingsPath(d)) }));
  for (const p of projectDirs) {
    const shared = join(p, '.claude', 'settings.json');
    files.push({ scope: 'project', project: p, path: shared, text: read(shared) });
    files.push({ scope: 'project-local', project: p, path: projectSettingsPath(p), text: read(projectSettingsPath(p)) });
  }
  return detectDuplicateHookScopes(files, now);
}

/** A compact, line-based diff for previewing a plan. */
export function describePlan(plan: HookPlan): string {
  const lines = [`Settings file: ${plan.settingsPath}${plan.existed ? '' : ' (will be created)'}`];
  if (!plan.changed) lines.push('No changes needed.');
  else lines.push(`Events: ${plan.events.join(', ') || '(none)'}`);
  for (const w of plan.warnings) lines.push(`Warning: ${w}`);
  if (plan.changed) {
    const before = new Set((plan.before ?? '').split(/\r?\n/));
    const added = plan.after.split(/\r?\n/).filter((l) => l.trim() && !before.has(l));
    const after = new Set(plan.after.split(/\r?\n/));
    const removed = (plan.before ?? '').split(/\r?\n/).filter((l) => l.trim() && !after.has(l));
    lines.push('', ...removed.slice(0, 60).map((l) => `- ${l}`), ...added.slice(0, 120).map((l) => `+ ${l}`));
  }
  return lines.join('\n');
}
