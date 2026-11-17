/**
 * Local department mapping. Departments are a seating heuristic built from the user's own
 * rules over real, observed fields (agent type, working directory, display name). They are
 * never presented as a verified Claude role, and nothing here calls a model.
 */
import { DEPARTMENT_KINDS, type DepartmentKind, type RoomKind } from '@agent-office/core';
import type { DepartmentRule } from './settings';

/** Agents no rule matches sit in development. */
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

/** The first rule (in order) whose pattern is a case-insensitive substring of its field. */
export function matchingRule(subject: DepartmentSubject, rules: readonly DepartmentRule[]): DepartmentRule | undefined {
  for (const r of rules) {
    const pattern = normalise(r.field, r.pattern);
    const value = subject[r.field];
    if (!pattern || !value) continue;
    if (normalise(r.field, value).includes(pattern)) return r;
  }
  return undefined;
}

/** Department for an agent: first matching rule, else development. */
export function departmentFor(subject: DepartmentSubject, rules: readonly DepartmentRule[]): DepartmentKind {
  return matchingRule(subject, rules)?.department ?? DEFAULT_DEPARTMENT;
}

/** A fresh rule with an id not used by `existing`. */
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
