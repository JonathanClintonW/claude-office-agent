/**
 * Office display settings: local to the browser/webview, never sent to any model. Older
 * preferences (filters, showNames, idleLife, readNotices) keep their own storage keys.
 */
import { useSyncExternalStore } from 'react';
import { DEPARTMENT_KINDS, type DepartmentKind } from '@agent-office/core';

/** Local, user-editable rule mapping agents to a department. A heuristic, not a verified Claude role. */
export interface DepartmentRule {
  id: string;
  department: DepartmentKind;
  /** Which real, observed field to match. */
  field: 'agentType' | 'cwd' | 'name';
  /** Case-insensitive. */
  pattern: string;
}

export interface OfficeSettings {
  /** Maximum render frame rate. */
  animationFps: 15 | 30 | 60;
  /** How often idle agents start simulated activities (and how often simulated visitors come in). */
  idleFrequency: 'low' | 'normal' | 'high';
  /** Simulated visitors (not agents) walk through the office while idle life is on. */
  visitors: boolean;
  /** Sound master switch (off by default; browsers need a click before any audio plays). */
  sound: boolean;
  /** Procedural background music (while sound is on). */
  music: boolean;
  /** Sound effects and typing ambience (while sound is on). */
  soundEffects: boolean;
  /** Volume, 0..1. */
  volume: number;
  roomLabels: boolean;
  minimap: boolean;
  /** Fewer particles, no bobbing/flashing. Defaults to the OS preference. */
  reduceMotion: boolean;
  /** Office coins: agents earn them for observed working time and spend them on simulated breaks and desk upgrades. */
  coins: boolean;
  departmentRules: DepartmentRule[];
}

export const IDLE_FREQUENCY_MULTIPLIER: Record<OfficeSettings['idleFrequency'], number> = { low: 0.5, normal: 1, high: 2 };

const KEY = 'agent-office:settings';

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function defaultSettings(): OfficeSettings {
  return {
    animationFps: 30,
    idleFrequency: 'normal',
    visitors: true,
    sound: false,
    music: true,
    soundEffects: true,
    volume: 0.5,
    roomLabels: true,
    minimap: true,
    reduceMotion: prefersReducedMotion(),
    coins: true,
    // The first matching rule wins, so specific departments come before broad ones:
    // "security-reviewer" is Security (not QA), "deployment-planner" is DevOps (not Research).
    departmentRules: [
      { id: 'r-security', department: 'security', field: 'agentType', pattern: 'security' },
      { id: 'r-devops', department: 'devops', field: 'agentType', pattern: 'devops' },
      { id: 'r-deploy', department: 'devops', field: 'agentType', pattern: 'deploy' },
      { id: 'r-test', department: 'qa', field: 'agentType', pattern: 'test' },
      { id: 'r-review', department: 'qa', field: 'agentType', pattern: 'review' },
      { id: 'r-explore', department: 'research', field: 'agentType', pattern: 'explore' },
      { id: 'r-plan', department: 'research', field: 'agentType', pattern: 'plan' },
    ],
  };
}

/** Rule ids of the first default list (broad rules first); saved unchanged copies are upgraded. */
const LEGACY_DEFAULT_ORDER = ['r-explore', 'r-plan', 'r-test', 'r-review', 'r-security', 'r-devops', 'r-deploy'];

/** True when `rules` is the untouched first default list (same ids, order, fields and patterns). */
function isLegacyDefault(rules: readonly DepartmentRule[]): boolean {
  if (rules.length !== LEGACY_DEFAULT_ORDER.length) return false;
  const current = new Map(defaultSettings().departmentRules.map((r) => [r.id, r]));
  return rules.every((r, i) => {
    const d = current.get(r.id);
    return r.id === LEGACY_DEFAULT_ORDER[i] && d !== undefined && d.department === r.department && d.field === r.field && d.pattern === r.pattern;
  });
}

function sanitize(raw: unknown): OfficeSettings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const rules = Array.isArray(r.departmentRules)
    ? r.departmentRules
        .filter(
          (x): x is DepartmentRule =>
            !!x &&
            typeof x === 'object' &&
            typeof (x as DepartmentRule).id === 'string' &&
            DEPARTMENT_KINDS.includes((x as DepartmentRule).department) &&
            ['agentType', 'cwd', 'name'].includes((x as DepartmentRule).field) &&
            typeof (x as DepartmentRule).pattern === 'string',
        )
        .slice(0, 50)
    : d.departmentRules;
  return {
    animationFps: r.animationFps === 15 || r.animationFps === 30 || r.animationFps === 60 ? r.animationFps : d.animationFps,
    idleFrequency: r.idleFrequency === 'low' || r.idleFrequency === 'high' || r.idleFrequency === 'normal' ? r.idleFrequency : d.idleFrequency,
    visitors: typeof r.visitors === 'boolean' ? r.visitors : d.visitors,
    sound: typeof r.sound === 'boolean' ? r.sound : d.sound,
    music: typeof r.music === 'boolean' ? r.music : d.music,
    soundEffects: typeof r.soundEffects === 'boolean' ? r.soundEffects : d.soundEffects,
    volume: typeof r.volume === 'number' && Number.isFinite(r.volume) ? Math.min(1, Math.max(0, r.volume)) : d.volume,
    roomLabels: typeof r.roomLabels === 'boolean' ? r.roomLabels : d.roomLabels,
    minimap: typeof r.minimap === 'boolean' ? r.minimap : d.minimap,
    reduceMotion: typeof r.reduceMotion === 'boolean' ? r.reduceMotion : d.reduceMotion,
    coins: typeof r.coins === 'boolean' ? r.coins : d.coins,
    departmentRules: isLegacyDefault(rules) ? d.departmentRules : rules,
  };
}

let current: OfficeSettings = (() => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? sanitize(JSON.parse(raw)) : defaultSettings();
  } catch {
    return defaultSettings();
  }
})();
const listeners = new Set<() => void>();

export function getSettings(): OfficeSettings {
  return current;
}

export function updateSettings(patch: Partial<OfficeSettings>): void {
  current = sanitize({ ...current, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable (some webviews) */
  }
  for (const l of listeners) l();
}

export function useSettings(): [OfficeSettings, (patch: Partial<OfficeSettings>) => void] {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  return [s, updateSettings];
}
