/**
 * Departments are a seating heuristic from the user's own rules over real, observed fields.
 * They are never presented as a verified Claude role, and nothing here calls a model.
 */
import { DEPARTMENT_KINDS, type DepartmentKind, type RoomKind } from '@agent-office/core';
import type { DepartmentRule } from './settings';

export const DEFAULT_DEPARTMENT: DepartmentKind = 'development';

export const ROOM_KIND_LABELS: Record<RoomKind, string> = {
  office: 'Office',
  development: 'Development',
  qa: 'QA & Testing',
  devops: 'DevOps',
  security: 'Security',
  research: 'Research',
  collaboration: 'Collaboration',
  meeting: 'Meeting room',
  break: 'Break room',
  restroom: 'Restroom',
  reception: 'Reception',
  corridor: 'Corridor',
};

export const RULE_FIELD_LABELS: Record<DepartmentRule['field'], string> = {
  agentType: 'Agent type',
  cwd: 'Directory',
  name: 'Name',
};

/** Real fields a rule can match. Missing fields never match. */
export interface DepartmentSubject {
  agentType?: string;
  cwd?: string;
  name?: string;
}

export function isDepartmentKind(kind: string | undefined): kind is DepartmentKind {
  return kind !== undefined && (DEPARTMENT_KINDS as readonly string[]).includes(kind);
}

function normalise(field: DepartmentRule['field'], value: string): string {
  const v = value.trim().toLowerCase();
  // Treat / and \ alike for directories so rules work for Windows and Git Bash paths.
  return field === 'cwd' ? v.replace(/\\/g, '/') : v;
}

/** The value as written, plus a camelCase-split reading ("CodeReviewer" → "code-reviewer"). */
function readings(field: DepartmentRule['field'], value: string): string[] {
  const plain = normalise(field, value);
  const split = normalise(field, value.replace(/([a-z0-9])([A-Z])/g, '$1-$2'));
  return split === plain ? [plain] : [plain, split];
}

const isWordChar = (c: string | undefined) => c !== undefined && /[a-z0-9]/.test(c);

/** `pattern` occurs in `value` at the start of a word: "test" matches "test-runner" and "testing", not "latest". */
export function matchesWordStart(value: string, pattern: string): boolean {
  for (let i = value.indexOf(pattern); i >= 0; i = value.indexOf(pattern, i + 1)) {
    if (!isWordChar(value[i - 1])) return true;
  }
  return false;
}

/** The first rule (in order) whose pattern starts a word in its field, case-insensitively. */
export function matchingRule(subject: DepartmentSubject, rules: readonly DepartmentRule[]): DepartmentRule | undefined {
  for (const r of rules) {
    const pattern = normalise(r.field, r.pattern);
    const value = subject[r.field];
    if (!pattern || !value) continue;
    if (readings(r.field, value).some((v) => matchesWordStart(v, pattern))) return r;
  }
  return undefined;
}

export function departmentFor(subject: DepartmentSubject, rules: readonly DepartmentRule[]): DepartmentKind {
  return matchingRule(subject, rules)?.department ?? DEFAULT_DEPARTMENT;
}

export function newRule(existing: readonly DepartmentRule[], patch: Partial<Omit<DepartmentRule, 'id'>> = {}): DepartmentRule {
  const ids = new Set(existing.map((r) => r.id));
  let n = existing.length + 1;
  while (ids.has(`rule-${n}`)) n++;
  return { id: `rule-${n}`, department: 'research', field: 'agentType', pattern: '', ...patch };
}

/** Move a rule up (-1) or down (+1); rules are evaluated in order. */
export function moveRule(rules: readonly DepartmentRule[], id: string, dir: -1 | 1): DepartmentRule[] {
  const i = rules.findIndex((r) => r.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= rules.length) return [...rules];
  const out = [...rules];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}
