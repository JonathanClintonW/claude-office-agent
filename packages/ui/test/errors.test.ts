// Rule-based error detection (pure).
import { describe, expect, it } from 'vitest';
import { agentKeyFor, createInitialState, normalizeHookPayload, normalizePathKey, reduce, systemEvent, type MonitorEvent, type OfficeState } from '@agent-office/core';
import { DEFAULT_ISSUE_FILTER, detectIssues, filterIssues, looksLikeTestRun, recentToolProblems, type Issue } from '../src/errors';

const T = 1_800_000_000_000;
const MIN = 60_000;

type Step = [string, number, Record<string, unknown>, string?] | MonitorEvent;

function build(steps: Step[]): OfficeState {
  let s = createInitialState();
  let seq = 0;
  for (const step of steps) {
    if (!Array.isArray(step)) {
      s = reduce(s, { ...step, seq: ++seq });
      continue;
    }
    const [name, ts, extra, sid] = step;
    const r = normalizeHookPayload({ session_id: sid ?? 's1', cwd: 'c:\\work\\app', hook_event_name: name, ...extra }, ts);
    if (!r.ok) throw new Error(r.error);
    s = reduce(s, { ...r.event, seq: ++seq });
  }
  return s;
}

const bash = (id: string, ts: number, command: string, description?: string): Step => [
  'PreToolUse',
  ts,
  { tool_name: 'Bash', tool_use_id: id, tool_input: { command, ...(description ? { description } : {}) } },
];
const fail = (id: string, ts: number, error = 'Exit code 1', extra: Record<string, unknown> = {}): Step => [
  'PostToolUseFailure',
  ts,
  { tool_name: 'Bash', tool_use_id: id, tool_input: {}, error, ...extra },
];

function byCategory(issues: Issue[], c: Issue['category']): Issue[] {
  return issues.filter((i) => i.category === c);
}

describe('looksLikeTestRun (heuristic)', () => {
  it.each([
    ['npm test', undefined],
    ['npm run test:unit', undefined],
    ['npx vitest run packages/ui', undefined],
    ['pytest -q tests/', undefined],
    ['go test ./...', undefined],
    ['cargo test', undefined],
    ['./gradlew :app:test', undefined],
    ['php artisan test', undefined],
    ['make check', 'Run the unit tests'],
  ])('flags %s', (command, description) => {
    expect(looksLikeTestRun({ name: 'Bash', summary: description ?? command, target: command })).toBe(true);
  });

  it('flags runner output in the error text and ignores other commands and tools', () => {
    expect(looksLikeTestRun({ name: 'Bash', summary: 'make', target: 'make', error: 'Tests: 2 failed, 10 passed' })).toBe(true);
    expect(looksLikeTestRun({ name: 'Bash', summary: 'npm install', target: 'npm install' })).toBe(false);
    expect(looksLikeTestRun({ name: 'Bash', summary: 'cat latest.txt', target: 'cat latest.txt' })).toBe(false);
    expect(looksLikeTestRun({ name: 'Edit', summary: 'Edit test.ts', target: 'c:\\x\\test.ts' })).toBe(false);
  });
});

describe('detectIssues', () => {
  it('reports failed tools, likely test failures, denials and interruptions with their evidence', () => {
    const s = build([
      ['SessionStart', T, {}],
      bash('b1', T + 1000, 'npm run build'),
      fail('b1', T + 2000, 'Exit code 2\nsrc/x.ts(1,1): error TS1005'),
      bash('b2', T + 3000, 'npm test', 'Run tests'),
      fail('b2', T + 4000),
      ['PreToolUse', T + 5000, { tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: 'c:\\work\\app\\.env' } }],
      ['PermissionDenied', T + 6000, { tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: 'c:\\work\\app\\.env' }, reason: 'User denied' }],
      bash('b3', T + 7000, 'sleep 100'),
      fail('b3', T + 8000, 'Interrupted', { is_interrupt: true }),
    ]);
    const issues = detectIssues(s, T + 9000);
    const tool = byCategory(issues, 'tool_failure');
    expect(tool).toHaveLength(1);
    expect(tool[0]).toMatchObject({ title: 'Bash failed', detail: 'Exit code 2', severity: 'error', agentKey: 's1', at: T + 2000, evidence: 'PostToolUseFailure hook', projectLabel: 'app' });
    expect(tool[0]!.heuristic).toBeUndefined();
    const test = byCategory(issues, 'test_failure');
    expect(test).toHaveLength(1);
    expect(test[0]!.title).toBe('Likely test failure (Bash)');
    expect(test[0]!.heuristic).toMatch(/^Heuristic/);
    expect(byCategory(issues, 'denied')[0]).toMatchObject({ title: 'Write denied', detail: 'User denied', severity: 'warning' });
    expect(byCategory(issues, 'interrupted')[0]).toMatchObject({ title: 'Bash interrupted', severity: 'info' });
    // severity first, then most recent first
    expect(issues.map((i) => i.severity)).toEqual([...issues.map((i) => i.severity)].sort((a, b) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(b)));
    expect(issues[0]!.category).toBe('test_failure');
    expect(issues[1]!.category).toBe('tool_failure');
  });

  it('detects the same tool call failing three times within the window, but not when spread out', () => {
    const steps: Step[] = [['SessionStart', T, {}]];
    for (let i = 0; i < 3; i++) steps.push(bash(`r${i}`, T + i * MIN, 'npm run lint'), fail(`r${i}`, T + i * MIN + 500));
    // Spread: 3 failures 8 minutes apart (window is 10 minutes) — never 3 inside one window.
    for (let i = 0; i < 3; i++) steps.push(bash(`p${i}`, T + i * 8 * MIN, 'npm run e2e'), fail(`p${i}`, T + i * 8 * MIN + 500));
    const issues = detectIssues(build(steps), T + 30 * MIN);
    const rep = byCategory(issues, 'repeated_failure');
    expect(rep).toHaveLength(1);
    expect(rep[0]).toMatchObject({ count: 3, context: 'npm run lint', at: T + 2 * MIN + 500, severity: 'error' });
    expect(rep[0]!.title).toBe('Bash failed 3× within 10m 0s');
  });

  it('reports turn failures as ongoing while the agent is failed, and keeps them as history after recovery', () => {
    const failed = build([
      ['SessionStart', T, {}],
      ['UserPromptSubmit', T + 100, {}],
      ['StopFailure', T + 200, { error: 'rate_limit' }],
    ]);
    const now = detectIssues(failed, T + 300);
    const turn = byCategory(now, 'turn_failure');
    expect(turn).toHaveLength(1);
    expect(turn[0]).toMatchObject({ title: 'Turn failed: rate_limit', ongoing: true, evidence: 'StopFailure hook' });

    const recovered = build([
      ['SessionStart', T, {}],
      ['UserPromptSubmit', T + 100, {}],
      ['StopFailure', T + 200, { error: 'rate_limit' }],
      ['UserPromptSubmit', T + 300, {}],
      ['Stop', T + 400, {}],
    ]);
    const later = byCategory(detectIssues(recovered, T + 500), 'turn_failure');
    expect(later).toHaveLength(1);
    expect(later[0]!.ongoing).toBe(false);
  });

  it('reports blocked agents: pending permission and waiting for input', () => {
    const s = build([
      ['SessionStart', T, {}],
      ['PreToolUse', T + 100, { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'c:\\work\\app\\a.ts' } }],
      ['PermissionRequest', T + 200, { tool_name: 'Edit', tool_input: { file_path: 'c:\\work\\app\\a.ts' } }],
      ['SessionStart', T, {}, 's2'],
      ['PreToolUse', T + 300, { tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: {} }, 's2'],
    ]);
    const issues = detectIssues(s, T + 1000);
    expect(byCategory(issues, 'permission_blocked')[0]).toMatchObject({ agentKey: 's1', title: 'Waiting for permission: Edit', context: 'Edit a.ts', at: T + 200, ongoing: true });
    expect(byCategory(issues, 'input_blocked')[0]).toMatchObject({ agentKey: 's2', title: 'Waiting for your input', detail: 'Asking you a question', ongoing: true });
  });

  it('flags quiet agents (heuristic) and disconnected sessions with orphaned subagents', () => {
    const s = build([
      ['SessionStart', T, {}],
      ['UserPromptSubmit', T + 100, {}],
      systemEvent({ kind: 'Tick' }, { ts: T + 6 * MIN, sessionId: '*' }),
      ['SessionStart', T, {}, 's2'],
      ['SubagentStart', T + 50, { agent_id: 'sub1', agent_type: 'Explore' }, 's2'],
      systemEvent({ kind: 'RegistryStatus', pid: 4242, alive: false }, { ts: T + 7 * MIN, sessionId: 's2' }),
    ]);
    const issues = detectIssues(s, T + 7 * MIN);
    const stale = byCategory(issues, 'stale');
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ agentKey: 's1', title: 'Quiet for 7m 0s', severity: 'warning', ongoing: true });
    expect(stale[0]!.heuristic).toMatch(/5 minutes/);
    const disc = byCategory(issues, 'disconnected');
    expect(disc).toHaveLength(1);
    expect(disc[0]).toMatchObject({ agentKey: 's2', title: 'Session disconnected', at: T + 7 * MIN });
    expect(disc[0]!.detail).toMatch(/^Process exited.*1 subagent ended without a reported outcome$/);
    // the orphaned subagent itself is not double-reported as disconnected
    expect(disc.some((i) => i.agentKey === agentKeyFor('s2', 'sub1'))).toBe(false);
  });

  it('reports unknown statuses and unobserved tool outcomes as info', () => {
    const s = build([
      ['SessionStart', T, {}],
      ['UserPromptSubmit', T + 100, {}],
      bash('b1', T + 200, 'npm run dev'),
      ['Stop', T + 300, {}],
      ['SessionStart', T, {}, 's2'],
      ['UserPromptSubmit', T + 100, {}, 's2'],
      systemEvent({ kind: 'Restored' }, { ts: T + 400, sessionId: '*' }),
    ]);
    const issues = detectIssues(s, T + 500);
    const unknown = byCategory(issues, 'unknown_status');
    expect(unknown.find((i) => i.id === 'tool-unknown:s1')).toMatchObject({ title: 'Tool outcome not observed', detail: 'No completion event before the turn ended', severity: 'info' });
    expect(unknown.find((i) => i.id === 'unknown:s2')).toMatchObject({ title: 'Status unknown', ongoing: true });
    expect(unknown.find((i) => i.id === 'unknown:s2')!.detail).toMatch(/Monitor restarted.*last known: working/);
  });

  it('returns nothing for a healthy session', () => {
    const s = build([
      ['SessionStart', T, {}],
      ['UserPromptSubmit', T + 100, {}],
      bash('b1', T + 200, 'ls'),
      ['PostToolUse', T + 300, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {} }],
      ['Stop', T + 400, {}],
    ]);
    expect(detectIssues(s, T + 500)).toEqual([]);
  });

  it('filters by category, severity, project and ongoing state', () => {
    const s = build([
      ['SessionStart', T, {}],
      bash('b1', T + 100, 'npm run build'),
      fail('b1', T + 200),
      ['SessionStart', T, { cwd: 'c:\\work\\other' }, 's2'],
      ['PreToolUse', T + 300, { tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: {}, cwd: 'c:\\work\\other' }, 's2'],
    ]);
    const all = detectIssues(s, T + 1000);
    expect(all).toHaveLength(2);
    expect(filterIssues(all, { ...DEFAULT_ISSUE_FILTER, severity: 'error' }).map((i) => i.category)).toEqual(['tool_failure']);
    expect(filterIssues(all, { ...DEFAULT_ISSUE_FILTER, category: 'input_blocked' }).map((i) => i.agentKey)).toEqual(['s2']);
    expect(filterIssues(all, { ...DEFAULT_ISSUE_FILTER, project: normalizePathKey('c:\\work\\other') }).map((i) => i.agentKey)).toEqual(['s2']);
    expect(filterIssues(all, { ...DEFAULT_ISSUE_FILTER, ongoingOnly: true }).map((i) => i.category)).toEqual(['input_blocked']);
  });
});

describe('recentToolProblems', () => {
  it('lists failed, denied and interrupted calls newest first, capped', () => {
    const steps: Step[] = [['SessionStart', T, {}]];
    for (let i = 0; i < 7; i++) steps.push(bash(`b${i}`, T + i * 1000, `cmd ${i}`), fail(`b${i}`, T + i * 1000 + 10));
    steps.push(bash('ok', T + 9000, 'ls'), ['PostToolUse', T + 9100, { tool_name: 'Bash', tool_use_id: 'ok', tool_input: {} }]);
    const a = build(steps).agents.s1!;
    expect(recentToolProblems(a).map((t) => t.id)).toEqual(['b6', 'b5', 'b4', 'b3', 'b2']);
    expect(recentToolProblems(a, 2)).toHaveLength(2);
  });
});
