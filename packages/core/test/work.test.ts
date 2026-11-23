import { describe, expect, it } from 'vitest';
import { agentKeyFor, agentWorkedMs, createInitialState, normalizeHookPayload, reduce, workedMs, type OfficeState } from '../src';

const T = 1_700_000_000_000;
const S = 'sess-work';
let seq = 0;

function hook(state: OfficeState, name: string, at: number, extra: Record<string, unknown> = {}): OfficeState {
  const r = normalizeHookPayload({ session_id: S, cwd: 'c:\\work\\app', hook_event_name: name, ...extra }, at);
  if (!r.ok) throw new Error(r.error);
  return reduce(state, { ...r.event, seq: ++seq });
}

const tool = (id: string, command = 'npm test') => ({ tool_name: 'Bash', tool_use_id: id, tool_input: { command } });

describe('observed working time', () => {
  it('counts the time between events while working, not while idle', () => {
    let s = hook(createInitialState(), 'SessionStart', T, { source: 'startup' });
    s = hook(s, 'UserPromptSubmit', T + 60_000); // idle until now: not work
    s = hook(s, 'PreToolUse', T + 70_000, tool('a'));
    s = hook(s, 'PostToolUse', T + 100_000, { ...tool('a'), tool_response: {} });
    s = hook(s, 'Stop', T + 120_000);
    const a = s.agents[agentKeyFor(S)]!;
    expect(a.status).toBe('idle');
    expect(a.workMs).toBe(60_000);
    expect(agentWorkedMs(a, T + 999_000)).toBe(60_000); // idle: nothing more
  });

  it('caps quiet gaps like the stale limits, longer while a tool runs', () => {
    let s = hook(createInitialState(), 'SessionStart', T, { source: 'startup' });
    s = hook(s, 'UserPromptSubmit', T + 1000);
    s = hook(s, 'Notification', T + 1000 + 3600_000, { message: 'still here', notification_type: 'other' }); // an hour of silence
    let a = s.agents[agentKeyFor(S)]!;
    expect(a.workMs).toBe(5 * 60_000);
    s = hook(s, 'PreToolUse', T + 7200_000, tool('long', 'npm run build'));
    s = hook(s, 'PostToolUse', T + 7200_000 + 3600_000, { ...tool('long', 'npm run build'), tool_response: {} });
    a = s.agents[agentKeyFor(S)]!;
    expect(a.workMs).toBe(5 * 60_000 + 5 * 60_000 + 20 * 60_000);
  });

  it('ignores events that arrive out of order and keeps live time capped', () => {
    let s = hook(createInitialState(), 'SessionStart', T, { source: 'startup' });
    s = hook(s, 'UserPromptSubmit', T + 10_000);
    s = hook(s, 'PreToolUse', T + 20_000, tool('x'));
    const before = s.agents[agentKeyFor(S)]!.workMs;
    s = hook(s, 'Notification', T + 15_000, { message: 'late', notification_type: 'other' });
    expect(s.agents[agentKeyFor(S)]!.workMs).toBe(before);
    const live = { workMs: 1000, status: 'working' as const, lastEventAt: T };
    expect(workedMs(live, T + 2500)).toBe(3500);
    expect(workedMs(live, T + 3600_000)).toBe(1000 + 5 * 60_000);
    expect(workedMs({ ...live, toolRunning: true }, T + 3600_000)).toBe(1000 + 20 * 60_000);
    expect(workedMs({ ...live, status: 'waiting_permission' }, T + 3600_000)).toBe(1000);
    expect(workedMs({ status: 'working', lastEventAt: T }, T - 5)).toBe(0);
  });

  it('treats a saved state without workMs as zero', () => {
    let s = hook(createInitialState(), 'SessionStart', T, { source: 'startup' });
    const a = { ...s.agents[agentKeyFor(S)]! };
    delete a.workMs;
    expect(agentWorkedMs(a, T + 1000)).toBe(0);
    s = hook(s, 'UserPromptSubmit', T + 1000);
    expect(agentWorkedMs(s.agents[agentKeyFor(S)]!, T + 4000)).toBe(3000);
  });
});
