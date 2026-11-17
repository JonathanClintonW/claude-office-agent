import { describe, expect, it } from 'vitest';
import { createInitialState, isSimulated, normalizeHookPayload, reduce, type OfficeState } from '@agent-office/core';
import { isScenarioName, SCENARIOS } from '../src/simulate';

function play(name: keyof typeof SCENARIOS, runId: string): { state: OfficeState; rejected: string[] } {
  const { build, end } = SCENARIOS[name];
  const steps = build(runId);
  const t0 = 1_700_000_000_000;
  let state = createInitialState();
  let seq = 0;
  const rejected: string[] = [];
  const apply = (payload: Record<string, unknown>, at: number) => {
    const r = normalizeHookPayload(payload, at);
    if (!r.ok) {
      rejected.push(`${String(payload.hook_event_name)}: ${r.error}`);
      return;
    }
    state = reduce(state, { ...r.event, seq: ++seq });
  };
  for (const s of steps) apply(s.payload, t0 + s.at);
  const last = t0 + Math.max(...steps.map((s) => s.at)) + 1000;
  for (const p of end(runId)) apply(p, last);
  return { state, rejected };
}

describe('simulated demo scenarios', () => {
  it('knows its scenario names', () => {
    expect(isScenarioName('default')).toBe(true);
    expect(isScenarioName('showcase')).toBe(true);
    expect(isScenarioName('toString')).toBe(false);
    expect(isScenarioName('nope')).toBe(false);
  });

  for (const name of Object.keys(SCENARIOS) as Array<keyof typeof SCENARIOS>) {
    it(`${name}: every event is accepted and every agent is labelled simulated`, () => {
      const { state, rejected } = play(name, 'test1');
      expect(rejected).toEqual([]);
      const agents = Object.values(state.agents);
      expect(agents.length).toBeGreaterThan(3);
      for (const a of agents) {
        expect(a.sessionId.startsWith('sim-')).toBe(true);
        expect(isSimulated(a)).toBe(true);
      }
    });
  }

  it('showcase: several sessions with parallel and nested subagents and a team', () => {
    const { state } = play('showcase', 'test2');
    const agents = Object.values(state.agents);
    const sessions = agents.filter((a) => a.kind === 'session');
    const subagents = agents.filter((a) => a.kind === 'subagent');
    expect(sessions.length).toBe(5);
    expect(subagents.length).toBeGreaterThanOrEqual(5);
    // nested: a subagent whose parent is itself a subagent
    expect(subagents.some((a) => a.parentKey && state.agents[a.parentKey]?.kind === 'subagent')).toBe(true);
    // parallel: one parent with at least two subagent children
    const children = new Map<string, number>();
    for (const a of subagents) if (a.parentKey) children.set(a.parentKey, (children.get(a.parentKey) ?? 0) + 1);
    expect([...children.values()].some((n) => n >= 2)).toBe(true);
    expect(agents.some((a) => a.kind === 'teammate')).toBe(true);
    // the end events close every session
    for (const s of sessions) expect(s.status).toBe('ended');
  });
});
