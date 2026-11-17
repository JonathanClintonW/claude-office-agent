import { describe, expect, it } from 'vitest';
import { agentKeyFor, createInitialState, normalizeHookPayload, reduce, taskKeyFor, type MonitorEvent, type OfficeState } from '@agent-office/core';
import {
  CollabFeed,
  collabSignals,
  collabVisuals,
  diffSignals,
  isCollaborative,
  parallelWork,
  relationOf,
  teams,
  uniqueNames,
  VISUAL_DETAIL_MAX,
  type CollabSignal,
} from '../src/office/collab';

const T = 1_700_000_000_000;
const S = 'sess-1';
const LEAD = agentKeyFor(S);
const EX1 = agentKeyFor(S, 'ex1');
const EX2 = agentKeyFor(S, 'ex2');

type Step = [name: string, ts: number, extra: Record<string, unknown>, sessionId?: string];

let seq = 0;
function apply(state: OfficeState, steps: Step[]): OfficeState {
  let s = state;
  for (const [name, ts, extra, sid] of steps) {
    const r = normalizeHookPayload({ session_id: sid ?? S, cwd: 'c:\\work\\app', hook_event_name: name, ...extra }, ts);
    if (!r.ok) throw new Error(r.error);
    s = reduce(s, { ...r.event, seq: ++seq });
  }
  return s;
}
const build = (steps: Step[]) => apply(createInitialState(), steps);

function raw(state: OfficeState, ev: MonitorEvent): OfficeState {
  return reduce(state, { ...ev, seq: ++seq });
}

const kinds = (list: CollabSignal[]) => list.map((s) => s.kind);

const start: Step[] = [
  ['SessionStart', T, { source: 'startup' }],
  ['UserPromptSubmit', T + 10, {}],
];
const delegate: Step[] = [
  ['PreToolUse', T + 100, { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { subagent_type: 'Explore', description: 'Find tests', prompt: 'SECRET PROMPT TEXT' } }],
  ['SubagentStart', T + 200, { agent_id: 'ex1', agent_type: 'Explore' }],
];
const nested: Step[] = [
  ['PreToolUse', T + 300, { agent_id: 'ex1', agent_type: 'Explore', tool_name: 'Task', tool_use_id: 'a2', tool_input: { subagent_type: 'Plan', description: 'Plan it' } }],
  ['SubagentStart', T + 400, { agent_id: 'ex2', agent_type: 'Plan' }],
];

describe('collabSignals: delegation', () => {
  it('derives a verified lead → subagent delegation from SubagentStart matched to the Agent tool', () => {
    const s = build([...start, ...delegate]);
    const sig = collabSignals(s);
    expect(sig).toHaveLength(1);
    expect(sig[0]).toMatchObject({ kind: 'delegation', from: LEAD, to: EX1, source: 'real', confidence: 'verified', label: 'Subagent delegated', at: T + 200 });
    // Never echoes prompts or tool input.
    expect(JSON.stringify(sig)).not.toMatch(/SECRET PROMPT|Find tests/);
  });

  it('derives nested delegation from a subagent that spawned another subagent', () => {
    const s = build([...start, ...delegate, ...nested]);
    const sig = collabSignals(s);
    expect(kinds(sig)).toEqual(['delegation', 'nested_delegation']);
    expect(sig[1]).toMatchObject({ from: EX1, to: EX2, confidence: 'verified', label: 'Nested delegation' });
  });

  it('marks a SubagentStart without an observed spawning call as verified "started", not as a delegation', () => {
    const s = build([...start, ['SubagentStart', T + 200, { agent_id: 'lone', agent_type: 'Explore' }]]);
    const [sig] = collabSignals(s);
    expect(sig).toMatchObject({ kind: 'subagent_started', confidence: 'verified', label: 'Subagent started' });
  });

  it('reports delegated work completed (child → parent) on SubagentStop', () => {
    const s = build([...start, ...delegate, ['SubagentStop', T + 900, { agent_id: 'ex1', agent_type: 'Explore', last_assistant_message: 'private output' }]]);
    const done = collabSignals(s).find((x) => x.kind === 'delegated_complete');
    expect(done).toMatchObject({ from: EX1, to: LEAD, at: T + 900, confidence: 'verified', label: 'Delegated work completed' });
    expect(JSON.stringify(done)).not.toContain('private output');
  });

  it('does not treat children ended by their session as completed work', () => {
    const s = build([...start, ...delegate, ['SessionEnd', T + 900, { reason: 'other' }]]);
    expect(kinds(collabSignals(s))).toEqual(['delegation']);
  });
});

describe('collabSignals: inferred links', () => {
  it('marks implicit parent links (no SubagentStart) as inferred', () => {
    const s = build([...start, ['PreToolUse', T + 100, { agent_id: 'ghost', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'a.ts' } }]]);
    const [sig] = collabSignals(s);
    expect(sig).toMatchObject({ kind: 'subagent_started', confidence: 'inferred', label: 'Subagent started (link inferred)' });
    expect(sig!.note).toMatch(/Inferred link/);
    const rel = relationOf(s, s.agents[agentKeyFor(S, 'ghost')]!)!;
    expect(rel).toMatchObject({ confidence: 'inferred', basis: 'implicit', label: 'inferred' });
  });

  it('marks transcript-discovered subagents as partial/inferred, including their completion', () => {
    let s = build(start);
    s = raw(s, { kind: 'TranscriptSubagentSeen', seq: 0, ts: T + 500, source: 'transcript', sessionId: S, agentId: 'tx1', finished: true });
    const sig = collabSignals(s);
    expect(sig.map((x) => [x.kind, x.confidence])).toEqual([
      ['subagent_started', 'inferred'],
      ['delegated_complete', 'inferred'],
    ]);
    expect(sig[0]!.note).toMatch(/Partial link/);
    const [team] = teams(s);
    expect(team!.partial).toBe(true);
  });

  it('upgrades an implicit link once the SubagentStart arrives (new verified signal, distinct id)', () => {
    const s1 = build([...start, ['PreToolUse', T + 100, { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { subagent_type: 'Explore' } }], ['PreToolUse', T + 150, { agent_id: 'ex1', tool_name: 'Read', tool_use_id: 'r1', tool_input: {} }]]);
    expect(collabSignals(s1)[0]!.confidence).toBe('inferred');
    const s2 = apply(s1, [['SubagentStart', T + 200, { agent_id: 'ex1', agent_type: 'Explore' }]]);
    const d = diffSignals(s1, s2);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: 'delegation', confidence: 'verified' });
  });
});

describe('collabSignals: teammates and tasks', () => {
  const teamSteps: Step[] = [
    ...start,
    ['TaskCreated', T + 100, { task_id: '1', task_subject: 'Fix login bug', team_name: 'alpha' }],
    ['TeammateIdle', T + 200, { agent_id: 'tm-bob', teammate_name: 'bob', team_name: 'alpha' }],
    ['TaskCompleted', T + 300, { agent_id: 'tm-bob', task_id: '1', task_subject: 'Fix login bug', teammate_name: 'bob', team_name: 'alpha' }],
  ];
  const BOB = agentKeyFor(S, 'tm-bob');

  it('reports teammates from teammate hook events as verified team members', () => {
    const s = build(teamSteps);
    const tm = collabSignals(s).find((x) => x.kind === 'teammate');
    expect(tm).toMatchObject({ from: LEAD, to: BOB, confidence: 'verified', label: 'Teammate joined' });
    expect(relationOf(s, s.agents[BOB]!)).toMatchObject({ kind: 'teammate', basis: 'team-event', confidence: 'verified' });
  });

  it('detects a task handoff (created by one agent, completed by another) with its subject', () => {
    const s = build(teamSteps);
    const h = collabSignals(s).find((x) => x.kind === 'task_handoff');
    expect(h).toMatchObject({ from: LEAD, to: BOB, at: T + 300, label: 'Task handoff detected', subject: 'Fix login bug', taskKey: taskKeyFor(S, '1'), confidence: 'verified' });
  });

  it('omits the subject when the state has none, and never yields a handoff for one agent', () => {
    const s = build([
      ...start,
      ['TaskCreated', T + 100, { task_id: '7' }],
      ['TaskCompleted', T + 200, { agent_id: 'w1', task_id: '7' }],
      ['TaskCreated', T + 300, { task_id: '8', task_subject: 'Solo task' }],
      ['TaskCompleted', T + 400, { task_id: '8', task_subject: 'Solo task' }],
    ]);
    const handoffs = collabSignals(s).filter((x) => x.kind === 'task_handoff');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.subject).toBeUndefined();
    expect('subject' in handoffs[0]!).toBe(false);
    expect(handoffs[0]!.label).toBe('Task handoff detected');
  });

  it('re-sanitises task subjects taken from state', () => {
    let s = build([...start, ['TaskCreated', T + 100, { task_id: '1' }], ['TaskCompleted', T + 200, { agent_id: 'w1', task_id: '1' }]]);
    const k = taskKeyFor(S, '1');
    s = { ...s, tasks: { ...s.tasks, [k]: { ...s.tasks[k]!, subject: 'Rotate   password=hunter2\nnow' } } };
    const h = collabSignals(s).find((x) => x.kind === 'task_handoff')!;
    expect(h.subject).not.toContain('hunter2');
    expect(h.subject).not.toContain('\n');
  });
});

describe('collabSignals: missing data', () => {
  it('yields nothing for a lone session with tools, open tasks or unknown creators', () => {
    let s = build([
      ...start,
      ['PreToolUse', T + 100, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } }],
      ['TaskCreated', T + 200, { task_id: '1', task_subject: 'Open task' }],
    ]);
    expect(collabSignals(s)).toEqual([]);
    // Completion without an observed creation is not a handoff.
    s = apply(s, [['TaskCompleted', T + 300, { agent_id: 'w1', task_id: '99' }]]);
    expect(collabSignals(s).filter((x) => x.kind === 'task_handoff')).toEqual([]);
    expect(collabSignals(createInitialState())).toEqual([]);
  });

  it('yields nothing when neither the parent nor the session is in state', () => {
    const s = build([...start, ...delegate]);
    const { [LEAD]: _gone, ...agents } = s.agents;
    const orphan = { ...s, agents };
    expect(collabSignals(orphan)).toEqual([]);
  });
});

describe('diffSignals and parallel work', () => {
  it('emits each signal once across consecutive diffs', () => {
    const s1 = build(start);
    const s2 = apply(s1, delegate);
    const s3 = apply(s2, nested);
    const s4 = apply(s3, [['SubagentStop', T + 900, { agent_id: 'ex2' }]]);
    const s5 = apply(s4, [['SubagentStop', T + 950, { agent_id: 'ex2' }]]); // duplicate stop
    const all = [diffSignals(s1, s2), diffSignals(s2, s3), diffSignals(s3, s4), diffSignals(s4, s5)].flat();
    const ids = all.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(diffSignals(s3, s3)).toEqual([]);
    expect(all.filter((x) => x.kind === 'delegated_complete')).toHaveLength(1);
  });

  it('detects ≥2 agents of one session working at once, on the transition only', () => {
    const s1 = build([...start, ...delegate]); // lead working (prompt) + ex1 working (started)
    expect(parallelWork(s1)).toEqual([{ sessionId: S, leadKey: LEAD, keys: [EX1, LEAD].sort(), at: T + 200, simulated: false }]);
    const before = build(start);
    const d = diffSignals(before, s1).filter((x) => x.kind === 'parallel_work');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ confidence: 'verified', participants: [EX1, LEAD].sort(), label: 'Parallel work detected: 2 agents' });
    // Still parallel: nothing new.
    const s2 = apply(s1, [['PreToolUse', T + 250, { agent_id: 'ex1', tool_name: 'Read', tool_use_id: 'r9', tool_input: {} }]]);
    expect(diffSignals(s1, s2).filter((x) => x.kind === 'parallel_work')).toEqual([]);
    // Parallel ends, then starts again: a new stretch.
    const s3 = apply(s2, [['SubagentStop', T + 300, { agent_id: 'ex1' }]]);
    expect(parallelWork(s3)).toEqual([]);
    const s4 = apply(s3, [['PreToolUse', T + 400, { tool_name: 'Agent', tool_use_id: 'a5', tool_input: { subagent_type: 'Plan' } }], ['SubagentStart', T + 500, { agent_id: 'p1', agent_type: 'Plan' }]]);
    expect(diffSignals(s3, s4).filter((x) => x.kind === 'parallel_work')).toHaveLength(1);
  });

  it('does not count agents of different sessions, idle or stale agents as parallel', () => {
    const s = build([
      ['UserPromptSubmit', T, {}, 'a'],
      ['UserPromptSubmit', T, {}, 'b'],
      ...start,
      ['Stop', T + 50, {}],
    ]);
    expect(parallelWork(s)).toEqual([]);
    const stale = build([...start, ...delegate]);
    const ex = stale.agents[EX1]!;
    expect(parallelWork({ ...stale, agents: { ...stale.agents, [EX1]: { ...ex, stale: true } } })).toEqual([]);
  });

  it('CollabFeed primes on the first state and never repeats an id, even if evidence flaps', () => {
    const feed = new CollabFeed();
    const s1 = build([...start, ...delegate]);
    expect(feed.push(s1)).toEqual([]);
    const s2 = apply(s1, nested);
    expect(kinds(feed.push(s2))).toEqual(['nested_delegation']);
    const { [EX2]: _x, ...rest } = s2.agents;
    expect(feed.push({ ...s2, agents: rest })).toEqual([]);
    expect(feed.push(s2)).toEqual([]);
  });
});

describe('collabVisuals', () => {
  it('turns new verified events into delegate / handoff / complete effects', () => {
    const s1 = build(start);
    const s2 = apply(s1, delegate);
    expect(collabVisuals(s1, s2)).toEqual([expect.objectContaining({ kind: 'delegate', from: LEAD, to: EX1, at: T + 200, label: 'Delegated' })]);
    const s3 = apply(s2, [
      ['TaskCreated', T + 300, { task_id: '1', task_subject: 'x' }],
      ['TaskCompleted', T + 400, { agent_id: 'ex1', task_id: '1' }],
      ['SubagentStop', T + 500, { agent_id: 'ex1' }],
    ]);
    expect(collabVisuals(s2, s3).map((v) => [v.kind, v.from, v.to])).toEqual([
      ['handoff', LEAD, EX1],
      ['complete', EX1, LEAD],
    ]);
  });

  it('adds the sanitised task subject (≤ 40 chars) to handoff effects only, and only when the task has one', () => {
    const s1 = build([...start, ...delegate]);
    const handoff = (subject: string | undefined, id: string) => {
      const extra = subject === undefined ? {} : { task_subject: subject };
      const s2 = apply(s1, [
        ['TaskCreated', T + 300, { task_id: id, ...extra }],
        ['TaskCompleted', T + 400, { agent_id: 'ex1', task_id: id, ...extra }],
      ]);
      return collabVisuals(s1, s2).find((v) => v.kind === 'handoff')!;
    };
    expect(handoff('Fix login bug', '1').detail).toBe('Fix login bug');
    const long = handoff('Refactor the checkout totals module to use integer cents everywhere', '2').detail!;
    expect(long.length).toBeLessThanOrEqual(VISUAL_DETAIL_MAX);
    expect(long).toBe('Refactor the checkout totals module to …');
    expect(handoff('Rotate password=hunter2 now', '3').detail).not.toContain('hunter2');
    const bare = handoff(undefined, '4');
    expect('detail' in bare).toBe(false);
    // Delegations and completions never carry text.
    const s3 = apply(s1, [['SubagentStop', T + 900, { agent_id: 'ex1' }]]);
    expect(collabVisuals(build(start), s1).every((v) => !('detail' in v))).toBe(true);
    expect(collabVisuals(s1, s3).every((v) => !('detail' in v))).toBe(true);
  });

  it('emits nothing for the first snapshot, inferred links, or old evidence', () => {
    const s1 = build(start);
    const s2 = apply(s1, delegate);
    expect(collabVisuals(undefined, s2)).toEqual([]);
    const ghost = apply(s1, [['PreToolUse', T + 100, { agent_id: 'ghost', tool_name: 'Read', tool_use_id: 'r1', tool_input: {} }]]);
    expect(collabVisuals(s1, ghost)).toEqual([]);
    expect(collabVisuals(s1, s2, { now: T + 200 + 60_000, maxAgeMs: 15_000 })).toEqual([]);
    expect(collabVisuals(s1, s2, { now: T + 1000 })).toHaveLength(1);
  });
});

describe('teams', () => {
  it('builds per-session teams: lead, nested members, relations and task links', () => {
    const s = build([
      ...start,
      ...delegate,
      ...nested,
      ['TaskCreated', T + 500, { task_id: '1', task_subject: 'Review' }],
      ['TaskCompleted', T + 600, { agent_id: 'ex2', task_id: '1', task_subject: 'Review' }],
      ['SessionStart', T + 700, { source: 'startup' }, 'solo'],
    ]);
    const list = teams(s);
    expect(list.map((t) => t.sessionId).sort()).toEqual(['sess-1', 'solo']);
    const team = list.find((t) => t.sessionId === S)!;
    expect(team.leadKey).toBe(LEAD);
    expect(team.members.map((m) => [m.key, m.depth, m.parentKey])).toEqual([
      [EX1, 1, LEAD],
      [EX2, 2, EX1],
    ]);
    expect(team.relations.map((r) => [r.from, r.to, r.label, r.confidence])).toEqual([
      [LEAD, EX1, 'delegated', 'verified'],
      [EX1, EX2, 'nested', 'verified'],
    ]);
    expect(team.tasks).toEqual([expect.objectContaining({ taskId: '1', subject: 'Review', createdBy: LEAD, completedBy: EX2, handoff: true })]);
    expect(team.partial).toBe(false);
    expect(isCollaborative(team)).toBe(true);
    const solo = list.find((t) => t.sessionId === 'solo')!;
    expect(solo.members).toEqual([]);
    expect(isCollaborative(solo)).toBe(false);
  });

  it('marks a team without its lead as partial and keeps its members', () => {
    const s = build([...start, ...delegate]);
    const { [LEAD]: _gone, ...agents } = s.agents;
    const [team] = teams({ ...s, agents });
    expect(team!.leadKey).toBeUndefined();
    expect(team!.partial).toBe(true);
    expect(team!.members.map((m) => m.key)).toEqual([EX1]);
  });

  it('gives every member a name that is unique within its team', () => {
    const s = build([
      ...start,
      ['PreToolUse', T + 100, { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { subagent_type: 'Explore' } }],
      ['PreToolUse', T + 110, { tool_name: 'Agent', tool_use_id: 'a2', tool_input: { subagent_type: 'Explore' } }],
      ['PreToolUse', T + 120, { tool_name: 'Agent', tool_use_id: 'a3', tool_input: { subagent_type: 'Plan' } }],
      ['SubagentStart', T + 200, { agent_id: 'sim-w-explore', agent_type: 'Explore' }],
      ['SubagentStart', T + 210, { agent_id: 'sim-w-nested', agent_type: 'Explore' }],
      ['SubagentStart', T + 220, { agent_id: 'sim-w-plan', agent_type: 'Plan' }],
    ]);
    const [team] = teams(s);
    expect(team!.members).toHaveLength(3);
    expect(team!.names).toEqual({
      [LEAD]: 'app · sess-1',
      [agentKeyFor(S, 'sim-w-explore')]: 'Explore · sim-w-explore',
      [agentKeyFor(S, 'sim-w-nested')]: 'Explore · sim-w-nested',
      [agentKeyFor(S, 'sim-w-plan')]: 'Plan · sim-w-',
    });
    // Same type and id in two sessions: an ordinal is the last resort.
    const other = build([['SessionStart', T, {}, 'sess-2'], ['SubagentStart', T + 300, { agent_id: 'ex1', agent_type: 'Explore' }, 'sess-2'], ...start, ...delegate]);
    const names = uniqueNames(Object.values(other.agents).filter((a) => a.kind === 'subagent'));
    expect(Object.values(names).sort()).toEqual(['Explore · ex1', 'Explore · ex1 #2']);
  });

  it('flags simulated demo sessions', () => {
    const s = build([['SessionStart', T, {}, 'sim-demo']]);
    expect(teams(s)[0]!.simulated).toBe(true);
  });
});
