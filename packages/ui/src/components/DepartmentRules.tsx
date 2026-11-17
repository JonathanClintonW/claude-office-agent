// Editor for local department rules (rendered on the Settings page).
import { useState } from 'react';
import { DEPARTMENT_KINDS, type DepartmentKind } from '@agent-office/core';
import { DEFAULT_DEPARTMENT, departmentFor, matchingRule, moveRule, newRule, ROOM_KIND_LABELS, RULE_FIELD_LABELS } from '../departments';
import { defaultSettings, useSettings, type DepartmentRule } from '../settings';
import '../office.css';

const FIELDS = Object.keys(RULE_FIELD_LABELS) as Array<DepartmentRule['field']>;

export function DepartmentRules() {
  const [settings, update] = useSettings();
  const rules = settings.departmentRules;
  const [probe, setProbe] = useState<{ field: DepartmentRule['field']; value: string }>({ field: 'agentType', value: '' });
  const set = (next: DepartmentRule[]) => update({ departmentRules: next });
  const edit = (id: string, patch: Partial<DepartmentRule>) => set(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const subject = { [probe.field]: probe.value };
  const hit = probe.value ? matchingRule(subject, rules) : undefined;

  return (
    <div className="dept-rules">
      <p className="muted small dept-note" role="note">
        Local heuristic, not a Claude role: these rules only choose which room's desks an agent prefers. They match real fields this app observed (agent
        type, working directory, name) as case-insensitive text. The first matching rule wins; agents no rule matches sit in{' '}
        {ROOM_KIND_LABELS[DEFAULT_DEPARTMENT]}.
      </p>
      {rules.length ? (
        <ol className="dept-rule-list">
          {rules.map((r, i) => (
            <li key={r.id} className="dept-rule" data-testid={`rule-${r.id}`}>
              <select aria-label="Field" value={r.field} onChange={(e) => edit(r.id, { field: e.target.value as DepartmentRule['field'] })}>
                {FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {RULE_FIELD_LABELS[f]}
                  </option>
                ))}
              </select>
              <span className="muted small">contains</span>
              <input className="text" aria-label="Pattern" value={r.pattern} maxLength={120} placeholder="text" onChange={(e) => edit(r.id, { pattern: e.target.value })} />
              <span className="muted small">→</span>
              <select aria-label="Department" value={r.department} onChange={(e) => edit(r.id, { department: e.target.value as DepartmentKind })}>
                {DEPARTMENT_KINDS.map((d) => (
                  <option key={d} value={d}>
                    {ROOM_KIND_LABELS[d]}
                  </option>
                ))}
              </select>
              <button className="btn small icon" aria-label="Move up" disabled={i === 0} onClick={() => set(moveRule(rules, r.id, -1))}>
                ↑
              </button>
              <button className="btn small icon" aria-label="Move down" disabled={i === rules.length - 1} onClick={() => set(moveRule(rules, r.id, 1))}>
                ↓
              </button>
              <button className="btn danger small" onClick={() => set(rules.filter((x) => x.id !== r.id))}>
                Remove
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted small">No rules: every agent prefers {ROOM_KIND_LABELS[DEFAULT_DEPARTMENT]} desks.</p>
      )}
      <div className="editor-row">
        <button className="btn small" disabled={rules.length >= 50} onClick={() => set([...rules, newRule(rules)])}>
          Add rule
        </button>
        <button className="btn small" onClick={() => set(defaultSettings().departmentRules)}>
          Reset to defaults
        </button>
      </div>
      <div className="dept-probe editor-row">
        <span className="muted small">Try it:</span>
        <select aria-label="Test field" value={probe.field} onChange={(e) => setProbe({ ...probe, field: e.target.value as DepartmentRule['field'] })}>
          {FIELDS.map((f) => (
            <option key={f} value={f}>
              {RULE_FIELD_LABELS[f]}
            </option>
          ))}
        </select>
        <input className="text" aria-label="Test value" placeholder="e.g. Explore" value={probe.value} onChange={(e) => setProbe({ ...probe, value: e.target.value })} />
        {probe.value ? (
          <span className="small" data-testid="dept-probe-result">
            → {ROOM_KIND_LABELS[departmentFor(subject, rules)]}
            {hit ? '' : ' (no rule matched)'}
          </span>
        ) : null}
      </div>
    </div>
  );
}
