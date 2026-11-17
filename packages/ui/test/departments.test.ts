import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultLayout, DEPARTMENT_KINDS, ROOM_KINDS } from '@agent-office/core';
import { DEFAULT_DEPARTMENT, departmentFor, isDepartmentKind, matchingRule, moveRule, newRule, ROOM_KIND_LABELS } from '../src/departments';
import { defaultSettings, getSettings, updateSettings, type DepartmentRule } from '../src/settings';
import { assignDesks, seatsOf } from '../src/office/grid';
import { DepartmentRules } from '../src/components/DepartmentRules';

afterEach(cleanup);

const DEFAULT_RULES = defaultSettings().departmentRules;

describe('departmentFor', () => {
  it('maps observed agent types with the default rules, case-insensitively', () => {
    expect(departmentFor({ agentType: 'Explore' }, DEFAULT_RULES)).toBe('research');
    expect(departmentFor({ agentType: 'Plan' }, DEFAULT_RULES)).toBe('research');
    expect(departmentFor({ agentType: 'test-runner' }, DEFAULT_RULES)).toBe('qa');
    expect(departmentFor({ agentType: 'CODE-REVIEWER' }, DEFAULT_RULES)).toBe('qa');
    expect(departmentFor({ agentType: 'security-auditor' }, DEFAULT_RULES)).toBe('security');
    expect(departmentFor({ agentType: 'devops-helper' }, DEFAULT_RULES)).toBe('devops');
    expect(departmentFor({ agentType: 'deployer' }, DEFAULT_RULES)).toBe('devops');
  });

  it('sends everything unmatched to development', () => {
    expect(DEFAULT_DEPARTMENT).toBe('development');
    expect(departmentFor({ agentType: 'general-purpose' }, DEFAULT_RULES)).toBe('development');
    expect(departmentFor({}, DEFAULT_RULES)).toBe('development');
    expect(departmentFor({ agentType: 'Explore' }, [])).toBe('development');
  });

  it('matches only the rule field, ignores empty patterns and uses the first match', () => {
    const rules: DepartmentRule[] = [
      { id: 'a', department: 'security', field: 'cwd', pattern: '  ' },
      { id: 'b', department: 'devops', field: 'cwd', pattern: 'Infra\\Terraform' },
      { id: 'c', department: 'qa', field: 'name', pattern: 'tests' },
      { id: 'd', department: 'research', field: 'name', pattern: 'test' },
    ];
    expect(departmentFor({ name: 'infra/terraform' }, rules)).toBe('development'); // name, not cwd
    expect(departmentFor({ cwd: 'C:/work/infra/terraform/modules' }, rules)).toBe('devops'); // slashes normalised
    expect(departmentFor({ cwd: 'c:\\work\\INFRA\\terraform' }, rules)).toBe('devops');
    expect(departmentFor({ name: 'Run tests' }, rules)).toBe('qa');
    expect(matchingRule({ name: 'unit test' }, rules)?.id).toBe('d');
    expect(matchingRule({ cwd: 'c:\\x' }, rules)).toBeUndefined();
  });

  it('labels every room kind and knows department kinds', () => {
    for (const k of ROOM_KINDS) expect(ROOM_KIND_LABELS[k]).toBeTruthy();
    for (const k of DEPARTMENT_KINDS) expect(isDepartmentKind(k)).toBe(true);
    expect(isDepartmentKind('break')).toBe(false);
    expect(isDepartmentKind(undefined)).toBe(false);
  });

  it('creates unique rules and reorders them', () => {
    const r1 = newRule(DEFAULT_RULES);
    expect(DEFAULT_RULES.some((r) => r.id === r1.id)).toBe(false);
    const r2 = newRule([...DEFAULT_RULES, r1], { department: 'qa', pattern: 'x' });
    expect(r2.id).not.toBe(r1.id);
    expect(r2).toMatchObject({ department: 'qa', pattern: 'x', field: 'agentType' });
    const rules = [r1, r2];
    expect(moveRule(rules, r2.id, -1).map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(moveRule(rules, r1.id, -1).map((r) => r.id)).toEqual([r1.id, r2.id]);
    expect(moveRule(rules, 'missing', 1)).toEqual(rules);
  });
});

describe('departments drive desk preference', () => {
  it('seats an Explore subagent in Research and a general one next to its parent in Development', () => {
    const layout = defaultLayout();
    const seats = seatsOf(layout);
    const agents = [
      { key: 's', agentType: undefined, name: 'my-app · abc123' },
      { key: 'e', parentKey: 's', agentType: 'Explore' },
      { key: 'g', parentKey: 's', agentType: 'general-purpose' },
      { key: 't', parentKey: 's', agentType: 'test-runner' },
    ].map((a) => ({ key: a.key, parentKey: a.parentKey, department: departmentFor(a, DEFAULT_RULES) }));
    const out = assignDesks(new Map(), agents, seats);
    const kind = (k: string) => seats.find((s) => s.deskId === out.get(k))?.roomKind;
    expect(kind('s')).toBe('development');
    expect(kind('e')).toBe('research');
    expect(kind('g')).toBe('development');
    expect(kind('t')).toBe('qa');
  });
});

describe('DepartmentRules editor', () => {
  beforeEach(() => updateSettings({ departmentRules: defaultSettings().departmentRules }));

  it('explains that rules are a local heuristic, not a Claude role', () => {
    render(createElement(DepartmentRules));
    expect(screen.getByRole('note').textContent).toMatch(/local heuristic, not a Claude role/i);
    expect(screen.getAllByLabelText('Pattern')).toHaveLength(DEFAULT_RULES.length);
  });

  it('adds, edits, reorders and removes rules through the settings store', () => {
    render(createElement(DepartmentRules));
    fireEvent.click(screen.getByText('Add rule'));
    expect(getSettings().departmentRules).toHaveLength(DEFAULT_RULES.length + 1);
    const patterns = screen.getAllByLabelText('Pattern');
    fireEvent.change(patterns.at(-1)!, { target: { value: 'infra' } });
    const departments = screen.getAllByLabelText('Department');
    fireEvent.change(departments.at(-1)!, { target: { value: 'devops' } });
    const fields = screen.getAllByLabelText('Field');
    fireEvent.change(fields.at(-1)!, { target: { value: 'cwd' } });
    const added = getSettings().departmentRules.at(-1)!;
    expect(added).toMatchObject({ pattern: 'infra', department: 'devops', field: 'cwd' });

    fireEvent.click(screen.getAllByLabelText('Move up').at(-1)!);
    expect(getSettings().departmentRules.at(-2)!.id).toBe(added.id);

    const before = getSettings().departmentRules.length;
    fireEvent.click(screen.getAllByText('Remove')[0]!);
    expect(getSettings().departmentRules).toHaveLength(before - 1);
    expect(getSettings().departmentRules.some((r) => r.id === DEFAULT_RULES[0]!.id)).toBe(false);

    fireEvent.click(screen.getByText('Reset to defaults'));
    expect(getSettings().departmentRules).toEqual(DEFAULT_RULES);
  });

  it('lets you try a value against the rules', () => {
    render(createElement(DepartmentRules));
    fireEvent.change(screen.getByLabelText('Test value'), { target: { value: 'Explore' } });
    expect(screen.getByTestId('dept-probe-result').textContent).toContain('Research');
    fireEvent.change(screen.getByLabelText('Test value'), { target: { value: 'something-else' } });
    expect(screen.getByTestId('dept-probe-result').textContent).toContain('Development (no rule matched)');
  });

  it('shows a hint when there are no rules', () => {
    updateSettings({ departmentRules: [] });
    render(createElement(DepartmentRules));
    expect(screen.getByText(/No rules: every agent prefers Development desks/)).toBeTruthy();
  });
});
