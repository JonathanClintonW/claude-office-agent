import { describe, expect, it } from 'vitest';
import { systemEvent, type MonitorEvent } from '../src/events';
import { agentTasks, agentTree, childrenOf, describeParentLink, displayName } from '../src/selectors';
import {
  agentKeyFor,
  createInitialState,
  DEFAULT_REDUCER_OPTIONS,
  PARENT_ENDED_REASON,
  reduce,
  taskKeyFor,
  teammateIdFor,
  type OfficeState,
} from '../src/state';
import { CWD, Harness, SESSION, SESSION_B, hook, norm } from './helpers';

/**
 * Lifecycle scenarios driven through normalizeHookPayload + reduce, the way the monitor and
 * every UI client apply real Claude Code hook traffic (including async, out-of-order delivery).
 */

const T = 1_800_000_000_000;
const sub = (id: string, s = SESSION) => agentKeyFor(s, id);
const spawnCall = (id: string, type?: string, extra: Record<string, unknown> = {}) => ({
  tool_name: 'Agent',
  tool_use_id: id,
  tool_input: { description: `Task ${id}`, ...(type ? { subagent_type: type } : {}) },
  ...extra,
});
const tool = (id: string, name = 'Grep', extra: Record<string, unknown> = {}) => ({ tool_name: name, tool_use_id: id, tool_input: { pattern: id }, ...extra });
const tick = (ts: number) => systemEvent({ kind: 'Tick' }, { ts, sessionId: '*' });
const transcriptSub = (ts: number, agentId: string, body: Record<string, unknown>, agentType?: string, sessionId = SESSION) =>
  systemEvent({ kind: 'TranscriptSubagentSeen', ...body } as never, { ts, sessionId, agentId, ...(agentType ? { agentType } : {}), source: 'transcript' });

function nonSessionAgents(s: OfficeState, sessionId = SESSION) {
  return Object.values(s.agents).filter((a) => a.sessionId === sessionId && a.kind !== 'session');
}

describe('parallel subagents of the same type', () => {
  it('gives each of 3 parallel Explore subagents and 1 Plan subagent its own entity under the lead', () => {
    const h = new Harness()
      .hook('UserPromptSubmit', T)
      .hook('PreToolUse', T + 10, spawnCall('s1', 'Explore'))
      .hook('PreToolUse', T + 11, spawnCall('s2', 'Explore'))
      .hook('PreToolUse', T + 12, spawnCall('s3', 'Explore'))
      .hook('PreToolUse', T + 13, spawnCall('s4', 'Plan'))
      .hook('SubagentStart', T + 20, { agent_id: 'e1', agent_type: 'Explore' })
      .hook('SubagentStart', T + 21, { agent_id: 'p1', agent_type: 'Plan' })
      .hook('SubagentStart', T + 22, { agent_id: 'e2', agent_type: 'Explore' })
      .hook('SubagentStart', T + 23, { agent_id: 'e3', agent_type: 'Explore' });

    const subs = nonSessionAgents(h.state);
    expect(subs.map((a) => a.key).sort()).toEqual([sub('e1'), sub('e2'), sub('e3'), sub('p1')]);
    for (const a of subs) expect(a).toMatchObject({ kind: 'subagent', parentKey: SESSION, parentVia: 'spawn-tool', status: 'working' });
    // The Plan call is the only one of its type: matched exactly.
    expect(h.agent(sub('p1')).spawnToolUseId).toBe('s4');
    // Which Explore call started which Explore agent is not knowable from hooks: no tool id is claimed.
    for (const id of ['e1', 'e2', 'e3']) {
      expect(h.agent(sub(id)).spawnToolUseId).toBeUndefined();
      expect(h.agent(sub(id)).agentType).toBe('Explore');
    }
    expect(h.state.spawns[SESSION]).toEqual([]);
    expect(childrenOf(h.state, SESSION).map((a) => a.key)).toEqual([sub('e1'), sub('p1'), sub('e2'), sub('e3')]);

    // Their tool calls stay with the right agent.
    h.hook('PreToolUse', T + 30, tool('g-e2', 'Grep', { agent_id: 'e2', agent_type: 'Explore' }));
    h.hook('PreToolUse', T + 31, tool('g-e1', 'Grep', { agent_id: 'e1', agent_type: 'Explore' }));
    h.hook('PostToolUse', T + 40, tool('g-e2', 'Grep', { agent_id: 'e2', agent_type: 'Explore' }));
    expect(h.agent(sub('e1')).tools.map((t) => [t.id, t.status])).toEqual([['g-e1', 'running']]);
    expect(h.agent(sub('e2')).tools.map((t) => [t.id, t.status])).toEqual([['g-e2', 'succeeded']]);
    expect(h.agent(sub('e3')).tools).toEqual([]);
    expect(h.agent().tools.map((t) => t.name)).toEqual(['Agent', 'Agent', 'Agent', 'Agent']);

    // Transcript metadata later names the exact spawning call of each Explore agent.
    h.apply(transcriptSub(T + 50, 'e2', { spawnToolUseId: 's1' }, 'Explore'));
    h.apply(transcriptSub(T + 51, 'e1', { spawnToolUseId: 's3' }, 'Explore'));
    expect(h.agent(sub('e2'))).toMatchObject({ parentKey: SESSION, parentVia: 'spawn-tool', spawnToolUseId: 's1' });
    expect(h.agent(sub('e1'))).toMatchObject({ parentKey: SESSION, parentVia: 'spawn-tool', spawnToolUseId: 's3' });
  });

  it('matches interleaved spawn calls and starts one to one', () => {
    const h = new Harness()
      .hook('PreToolUse', T, spawnCall('s1', 'Explore'))
      .hook('SubagentStart', T + 5, { agent_id: 'e1', agent_type: 'Explore' })
      .hook('PreToolUse', T + 10, spawnCall('s2', 'Explore'))
      .hook('PreToolUse', T + 11, spawnCall('s3', 'Plan'))
      .hook('SubagentStart', T + 15, { agent_id: 'p1', agent_type: 'Plan' })
      .hook('SubagentStart', T + 16, { agent_id: 'e2', agent_type: 'Explore' });
    expect(h.agent(sub('e1')).spawnToolUseId).toBe('s1');
    expect(h.agent(sub('e2')).spawnToolUseId).toBe('s2');
    expect(h.agent(sub('p1')).spawnToolUseId).toBe('s3');
    expect(h.state.spawns[SESSION]).toEqual([]);
  });

  it('links a spawn call that is delivered after the SubagentStart it caused', () => {
    // Hooks run asynchronously: the start can arrive first even though the call happened first.
    const h = new Harness()
      .hook('SubagentStart', T + 5, { agent_id: 'e1', agent_type: 'Explore' })
      .hook('PreToolUse', T, spawnCall('s1', 'Explore'));
    expect(h.agent(sub('e1'))).toMatchObject({ parentKey: SESSION, parentVia: 'spawn-tool' });
    // Another call of the same type may still be in flight, so the exact call is not claimed.
    expect(h.agent(sub('e1')).spawnToolUseId).toBeUndefined();
    // Nothing is left pending that a later, unrelated start could pick up.
    expect(h.state.spawns[SESSION] ?? []).toEqual([]);
    h.hook('SubagentStart', T + 60_000, { agent_id: 'e2', agent_type: 'Explore' });
    expect(h.agent(sub('e2'))).toMatchObject({ parentKey: SESSION, parentVia: 'session' });
    expect(h.agent(sub('e2')).spawnToolUseId).toBeUndefined();
  });

  it('never links a start to a pending call for a different subagent type', () => {
    const h = new Harness()
      .hook('SubagentStart', T, { agent_id: 'outer', agent_type: 'general-purpose' })
      .hook('PreToolUse', T + 10, spawnCall('s-plan', 'Plan', { agent_id: 'outer' }))
      .hook('SubagentStart', T + 20, { agent_id: 'x', agent_type: 'Explore' });
    expect(h.agent(sub('x'))).toMatchObject({ parentKey: SESSION, parentVia: 'session' });
    // The Plan call is still waiting for its own subagent.
    h.hook('SubagentStart', T + 30, { agent_id: 'p', agent_type: 'Plan' });
    expect(h.agent(sub('p'))).toMatchObject({ parentKey: sub('outer'), parentVia: 'spawn-tool', spawnToolUseId: 's-plan' });
  });
});

describe('nested subagents', () => {
  it('links a subagent spawned by a subagent to that subagent', () => {
    const h = new Harness()
      .hook('PreToolUse', T, spawnCall('s-outer', 'general-purpose'))
      .hook('SubagentStart', T + 1, { agent_id: 'outer', agent_type: 'general-purpose' })
      .hook('PreToolUse', T + 2, spawnCall('s-inner', 'Explore', { agent_id: 'outer', agent_type: 'general-purpose' }))
      .hook('SubagentStart', T + 3, { agent_id: 'inner', agent_type: 'Explore' })
      .hook('PreToolUse', T + 4, tool('g1', 'Grep', { agent_id: 'inner', agent_type: 'Explore' }));
    expect(h.agent(sub('outer'))).toMatchObject({ parentKey: SESSION, parentVia: 'spawn-tool', spawnToolUseId: 's-outer' });
    expect(h.agent(sub('inner'))).toMatchObject({ parentKey: sub('outer'), parentVia: 'spawn-tool', spawnToolUseId: 's-inner' });
    expect(h.agent(sub('inner')).tools.map((t) => t.id)).toEqual(['g1']);
    expect(h.agent(sub('outer')).tools.map((t) => t.id)).toEqual(['s-inner']);
    expect(describeParentLink(h.agent(sub('inner')))).toMatch(/Agent\/Task tool call/);

    const tree = agentTree(h.state);
    expect(tree.map((n) => n.agent.key)).toEqual([SESSION]);
    expect(tree[0]!.children.map((n) => n.agent.key)).toEqual([sub('outer')]);
    expect(tree[0]!.children[0]!.children.map((n) => n.agent.key)).toEqual([sub('inner')]);

    h.hook('SubagentStop', T + 10, { agent_id: 'inner', agent_type: 'Explore', last_assistant_message: 'done' });
    expect(h.agent(sub('inner'))).toMatchObject({ status: 'completed', endReason: 'Finished' });
    expect(h.agent(sub('outer')).status).toBe('working');
  });

  it('does not guess the spawner when the lead and a subagent spawn the same type at once', () => {
    const h = new Harness()
      .hook('SubagentStart', T, { agent_id: 'outer', agent_type: 'general-purpose' })
      .hook('PreToolUse', T + 10, spawnCall('s-lead', 'Explore'))
      .hook('PreToolUse', T + 11, spawnCall('s-nested', 'Explore', { agent_id: 'outer' }))
      .hook('SubagentStart', T + 12, { agent_id: 'x', agent_type: 'Explore' })
      .hook('SubagentStart', T + 13, { agent_id: 'y', agent_type: 'Explore' });
    for (const id of ['x', 'y']) {
      expect(h.agent(sub(id))).toMatchObject({ parentKey: SESSION, parentVia: 'session', spawnAmbiguous: true });
      expect(describeParentLink(h.agent(sub(id)))).toMatch(/not determined/);
    }
    expect(childrenOf(h.state, sub('outer'))).toEqual([]);

    // Transcript metadata resolves both exactly.
    h.apply(transcriptSub(T + 100, 'x', { spawnToolUseId: 's-nested' }, 'Explore'));
    h.apply(transcriptSub(T + 101, 'y', { spawnToolUseId: 's-lead' }, 'Explore'));
    expect(h.agent(sub('x'))).toMatchObject({ parentKey: sub('outer'), parentVia: 'spawn-tool', spawnToolUseId: 's-nested' });
    expect(h.agent(sub('x')).spawnAmbiguous).toBeUndefined();
    expect(h.agent(sub('y'))).toMatchObject({ parentKey: SESSION, parentVia: 'spawn-tool', spawnToolUseId: 's-lead' });
  });

  it('links a nested subagent whose tool events arrive before its SubagentStart', () => {
    const h = new Harness()
      .hook('SubagentStart', T, { agent_id: 'outer', agent_type: 'general-purpose' })
      .hook('PreToolUse', T + 1, spawnCall('s-inner', 'Explore', { agent_id: 'outer' }))
      .hook('PreToolUse', T + 3, tool('r1', 'Read', { agent_id: 'inner', agent_type: 'Explore' }))
      .hook('PostToolUse', T + 4, tool('r1', 'Read', { agent_id: 'inner', agent_type: 'Explore' }));
    expect(h.agent(sub('inner'))).toMatchObject({ kind: 'subagent', parentKey: SESSION, parentVia: 'implicit' });
    h.hook('SubagentStart', T + 2, { agent_id: 'inner', agent_type: 'Explore' });
    expect(Object.keys(h.state.agents).filter((k) => k.endsWith('::inner'))).toHaveLength(1);
    expect(h.agent(sub('inner'))).toMatchObject({ parentKey: sub('outer'), parentVia: 'spawn-tool', spawnToolUseId: 's-inner' });
    expect(h.agent(sub('inner')).tools.map((t) => [t.id, t.status])).toEqual([['r1', 'succeeded']]);
    // The late start is older than the tool events: it does not override their status.
    expect(h.agent(sub('inner')).status).toBe('working');
  });

  it('drops a spawn call that was denied or failed instead of matching it to another start', () => {
    const h = new Harness()
      .hook('SubagentStart', T, { agent_id: 'outer', agent_type: 'general-purpose' })
      .hook('PreToolUse', T + 1, spawnCall('s-denied', 'Explore', { agent_id: 'outer' }))
      .hook('PermissionDenied', T + 2, { ...spawnCall('s-denied', 'Explore'), agent_id: 'outer', reason: 'not allowed' })
      .hook('PreToolUse', T + 3, spawnCall('s-failed', 'Explore', { agent_id: 'outer' }))
      .hook('PostToolUseFailure', T + 4, { ...spawnCall('s-failed', 'Explore'), agent_id: 'outer', error: 'boom' })
      .hook('PreToolUse', T + 120_000, spawnCall('s-lead', 'Explore'))
      .hook('SubagentStart', T + 120_001, { agent_id: 'x', agent_type: 'Explore' });
    expect(h.agent(sub('x'))).toMatchObject({ parentKey: SESSION, parentVia: 'spawn-tool', spawnToolUseId: 's-lead' });
    expect(h.state.spawns[SESSION]).toEqual([]);
  });
});

describe('agent-team teammates', () => {
  it('tracks a teammate across turns: tasks, idle, new messages', () => {
    const tm = { agent_id: 'tm1', agent_type: 'general-purpose' };
    const h = new Harness()
      .hook('PreToolUse', T, spawnCall('s-tm', 'general-purpose', { tool_input: { name: 'researcher', subagent_type: 'general-purpose' } }))
      .hook('SubagentStart', T + 1, tm)
      .hook('TaskCreated', T + 2, { task_id: 't1', task_subject: 'Survey the API', teammate_name: 'researcher', team_name: 'session-11111111', ...tm })
      .hook('PreToolUse', T + 3, tool('w1', 'WebSearch', tm))
      .hook('PostToolUse', T + 4, tool('w1', 'WebSearch', tm))
      .hook('TaskCompleted', T + 5, { task_id: 't1', task_subject: 'Survey the API', teammate_name: 'researcher', ...tm })
      .hook('TeammateIdle', T + 6, { teammate_name: 'researcher', team_name: 'session-11111111', ...tm });
    const a = h.agent(sub('tm1'));
    expect(a).toMatchObject({ kind: 'teammate', teammateName: 'researcher', teamName: 'session-11111111', status: 'idle', parentKey: SESSION, parentVia: 'spawn-tool' });
    expect(displayName(a)).toBe('researcher');
    expect(h.state.tasks[taskKeyFor(SESSION, 't1')]).toMatchObject({ status: 'completed', createdBy: sub('tm1'), completedBy: sub('tm1'), subject: 'Survey the API' });
    expect(agentTasks(h.state, a).map((t) => t.taskId)).toEqual(['t1']);

    // The lead spawns a subagent; meanwhile the teammate's next message fires SubagentStart again.
    h.hook('PreToolUse', T + 10, spawnCall('s-ex', 'general-purpose'));
    h.hook('SubagentStart', T + 11, tm);
    expect(h.agent(sub('tm1'))).toMatchObject({ status: 'working', statusDetail: 'Handling a new message', spawnToolUseId: 's-tm' });
    h.hook('SubagentStart', T + 12, { agent_id: 'gp', agent_type: 'general-purpose' });
    expect(h.agent(sub('gp'))).toMatchObject({ parentVia: 'spawn-tool', spawnToolUseId: 's-ex' });

    // A teammate's SubagentStop ends its turn, not its membership in the team.
    h.hook('SubagentStop', T + 20, { ...tm, last_assistant_message: 'Findings sent to the lead' });
    expect(h.agent(sub('tm1'))).toMatchObject({ status: 'idle', statusDetail: 'Turn finished', lastMessage: 'Findings sent to the lead', turnCompletedAt: T + 20 });
    expect(h.agent(sub('tm1')).endedAt).toBeUndefined();
    expect(nonSessionAgents(h.state).filter((x) => x.teammateName === 'researcher')).toHaveLength(1);

    // The session ending ends the team.
    h.hook('SessionEnd', T + 30, { reason: 'other' });
    expect(h.agent(sub('tm1'))).toMatchObject({ status: 'ended', endReason: PARENT_ENDED_REASON });
  });

  it('merges a teammate known only by name into the agent that later reports that name with an agent_id', () => {
    const h = new Harness()
      .hook('TeammateIdle', T, { teammate_name: 'bob' })
      .hook('TaskCreated', T + 1, { task_id: 'k1', task_subject: 'Spec', teammate_name: 'bob' });
    const synthetic = sub(teammateIdFor('bob'));
    expect(h.agent(synthetic)).toMatchObject({ kind: 'teammate', teammateName: 'bob', status: 'idle' });
    expect(h.state.tasks[taskKeyFor(SESSION, 'k1')]!.createdBy).toBe(synthetic);

    // Without agent_id the same name keeps resolving to the same character.
    h.hook('TeammateIdle', T + 2, { teammate_name: 'bob' });
    expect(nonSessionAgents(h.state)).toHaveLength(1);

    h.hook('TaskCompleted', T + 3, { task_id: 'k1', task_subject: 'Spec', teammate_name: 'bob', agent_id: 'tm-bob' });
    expect(h.state.agents[synthetic]).toBeUndefined();
    expect(nonSessionAgents(h.state).map((a) => a.key)).toEqual([sub('tm-bob')]);
    expect(h.agent(sub('tm-bob'))).toMatchObject({ kind: 'teammate', teammateName: 'bob', status: 'idle', firstSeenAt: T });
    expect(h.state.tasks[taskKeyFor(SESSION, 'k1')]).toMatchObject({ createdBy: sub('tm-bob'), completedBy: sub('tm-bob') });
    expect(h.state.log.some((l) => l.agentKey === synthetic)).toBe(false);

    // Later name-only events go to the real agent.
    h.hook('TeammateIdle', T + 4, { teammate_name: 'bob' });
    expect(nonSessionAgents(h.state).map((a) => a.key)).toEqual([sub('tm-bob')]);
  });

  it('treats a split-pane teammate as its own session instead of inventing a child of it', () => {
    const team = `session-${SESSION.slice(0, 8)}`;
    const h = new Harness()
      .hook('SessionStart', T, {}, SESSION)
      .hook('SessionStart', T + 1, { cwd: CWD }, SESSION_B)
      .hook('TaskCreated', T + 2, { task_id: '3', task_subject: 'Review', teammate_name: 'reviewer', team_name: team }, SESSION_B)
      .hook('TeammateIdle', T + 3, { teammate_name: 'reviewer', team_name: team }, SESSION_B);
    expect(nonSessionAgents(h.state, SESSION_B)).toEqual([]);
    expect(h.agent(SESSION_B)).toMatchObject({ kind: 'session', teammateName: 'reviewer', teamName: team, status: 'idle' });
    expect(displayName(h.agent(SESSION_B))).toMatch(/^reviewer · /);
    expect(h.state.tasks[taskKeyFor(SESSION_B, '3')]!.createdBy).toBe(SESSION_B);
  });
});

describe('multiple sessions and projects', () => {
  it('keeps colliding agent ids in different sessions apart', () => {
    const h = new Harness()
      .hook('SessionStart', T, { cwd: 'c:\\work\\alpha' }, SESSION)
      .hook('SessionStart', T + 1, { cwd: 'c:\\work\\beta' }, SESSION_B)
      .hook('PreToolUse', T + 2, spawnCall('same', 'Explore', { cwd: 'c:\\work\\alpha' }), SESSION)
      .hook('SubagentStart', T + 3, { agent_id: 'a1', agent_type: 'Explore', cwd: 'c:\\work\\beta' }, SESSION_B)
      .hook('SubagentStart', T + 4, { agent_id: 'a1', agent_type: 'Explore', cwd: 'c:\\work\\alpha' }, SESSION)
      .hook('PreToolUse', T + 5, tool('same', 'Grep', { agent_id: 'a1', cwd: 'c:\\work\\beta' }), SESSION_B)
      .hook('SubagentStop', T + 6, { agent_id: 'a1', agent_type: 'Explore', cwd: 'c:\\work\\beta' }, SESSION_B);
    const a = h.agent(sub('a1', SESSION));
    const b = h.agent(sub('a1', SESSION_B));
    expect(a).toMatchObject({ sessionId: SESSION, parentKey: SESSION, cwd: 'c:\\work\\alpha', status: 'working', parentVia: 'spawn-tool', spawnToolUseId: 'same' });
    // Session B's start never consumed session A's spawn call.
    expect(b).toMatchObject({ sessionId: SESSION_B, parentKey: SESSION_B, cwd: 'c:\\work\\beta', status: 'completed', parentVia: 'session' });
    expect(b.tools.map((t) => t.id)).toEqual(['same']);
    expect(a.tools).toEqual([]);
    expect(h.agent(SESSION).cwd).toBe('c:\\work\\alpha');
    expect(h.agent(SESSION_B).cwd).toBe('c:\\work\\beta');
    expect(Object.keys(h.state.agents).sort()).toEqual([SESSION, sub('a1', SESSION), SESSION_B, sub('a1', SESSION_B)].sort());
  });

  it('does not move a session to a subagent’s working directory (worktrees)', () => {
    const h = new Harness()
      .hook('SessionStart', T)
      .hook('SubagentStart', T + 1, { agent_id: 'w1', agent_type: 'general-purpose' })
      .hook('PreToolUse', T + 2, tool('b1', 'Bash', { agent_id: 'w1', cwd: 'c:\\work\\demo-worktree' }));
    expect(h.agent().cwd).toBe(CWD);
    expect(h.agent(sub('w1')).cwd).toBe('c:\\work\\demo-worktree');
  });
});

describe('duplicates and unknown agents', () => {
  it('ignores a duplicate SubagentStart (no second entity, no stolen spawn call)', () => {
    const start = { agent_id: 'e1', agent_type: 'Explore' };
    const h = new Harness()
      .hook('PreToolUse', T, spawnCall('s1', 'Explore'))
      .hook('PreToolUse', T + 1, spawnCall('s2', 'Explore'))
      .hook('SubagentStart', T + 2, start)
      .hook('PreToolUse', T + 3, tool('g', 'Grep', start))
      .hook('SubagentStart', T + 2, start);
    expect(nonSessionAgents(h.state)).toHaveLength(1);
    expect(h.agent(sub('e1'))).toMatchObject({ status: 'working', statusDetail: 'Grep g' });
    expect(h.state.spawns[SESSION]).toHaveLength(1);
    h.hook('SubagentStart', T + 4, { agent_id: 'e2', agent_type: 'Explore' });
    expect(h.agent(sub('e2'))).toMatchObject({ parentVia: 'spawn-tool', parentKey: SESSION });
  });

  it('counts a duplicate SubagentStop once and keeps the first end time', () => {
    const h = new Harness()
      .hook('SubagentStart', T, { agent_id: 'e1', agent_type: 'Explore' })
      .hook('SubagentStop', T + 10, { agent_id: 'e1', agent_type: 'Explore' })
      .hook('SubagentStop', T + 10, { agent_id: 'e1', agent_type: 'Explore' });
    expect(h.agent(sub('e1'))).toMatchObject({ status: 'completed', endedAt: T + 10 });
    expect(h.agent(sub('e1')).counts.turns).toBe(1);
    expect(h.state.log.filter((l) => l.agentKey === sub('e1') && l.kind === 'SubagentStop')).toHaveLength(1);
  });

  it('handles Stop for agents and sessions it has never seen', () => {
    const h = new Harness().hook('Stop', T, { agent_id: 'mystery' }).hook('Stop', T + 1, { agent_id: 'mystery' });
    expect(nonSessionAgents(h.state).map((a) => a.key)).toEqual([sub('mystery')]);
    expect(h.agent(sub('mystery'))).toMatchObject({ status: 'idle', parentVia: 'implicit', parentKey: SESSION });
    const h2 = new Harness().hook('Stop', T, {}, SESSION_B);
    expect(Object.keys(h2.state.agents)).toEqual([SESSION_B]);
    expect(h2.agent(SESSION_B)).toMatchObject({ kind: 'session', status: 'idle' });
  });

  it('records a real SubagentStop without a prior start, and a late start does not revive it', () => {
    const h = new Harness().hook('SubagentStop', T + 10, { agent_id: 'quick', agent_type: 'Explore', last_assistant_message: 'ok' });
    expect(h.agent(sub('quick'))).toMatchObject({ status: 'completed', parentVia: 'implicit', agentType: 'Explore', lastMessage: 'ok' });
    h.hook('SubagentStart', T + 5, { agent_id: 'quick', agent_type: 'Explore' });
    expect(nonSessionAgents(h.state)).toHaveLength(1);
    expect(h.agent(sub('quick'))).toMatchObject({ status: 'completed', parentVia: 'session' });
  });

  it('does not invent characters for Claude Code’s internal helper agents', () => {
    // Prompt suggestions and side questions report SubagentStop with an empty agent_type.
    const h = new Harness()
      .hook('SessionStart', T)
      .hook('SubagentStop', T + 10, { agent_id: 'helper1', agent_type: '' })
      .hook('SubagentStop', T + 20, { agent_id: 'helper2' });
    expect(nonSessionAgents(h.state)).toEqual([]);
    expect(h.agent().lastEventAt).toBe(T + 20);
    // ...or the session's own `--agent` type.
    const h2 = new Harness().hook('UserPromptSubmit', T, { agent_type: 'reviewer' }).hook('SubagentStop', T + 1, { agent_id: 'helper', agent_type: 'reviewer' });
    expect(nonSessionAgents(h2.state)).toEqual([]);
    expect(h2.agent()).toMatchObject({ agentType: 'reviewer', status: 'working' });
  });

  it('resolves agent ids with and without the agent- prefix to one agent', () => {
    const h = new Harness()
      .hook('SubagentStart', T, { agent_id: 'agent-abc123', agent_type: 'Explore' })
      .apply(transcriptSub(T + 100, 'abc123', { description: 'Find usages', finished: false }, 'Explore'))
      .hook('SubagentStop', T + 200, { agent_id: 'agent-abc123', agent_type: 'Explore' });
    expect(nonSessionAgents(h.state).map((a) => a.key)).toEqual([sub('agent-abc123')]);
    expect(h.agent(sub('agent-abc123'))).toMatchObject({ status: 'completed', description: 'Find usages' });
    expect(h.agent(sub('agent-abc123')).sources).toEqual(['hook', 'transcript']);
  });
});

describe('session end, resume and completion', () => {
  it('ends running children (not completed) when the session ends, and keeps their history', () => {
    const h = new Harness()
      .hook('PreToolUse', T, spawnCall('s1', 'Explore'))
      .hook('SubagentStart', T + 1, { agent_id: 'run', agent_type: 'Explore' })
      .hook('PreToolUse', T + 2, tool('g', 'Grep', { agent_id: 'run' }))
      .hook('SubagentStart', T + 3, { agent_id: 'done', agent_type: 'Plan' })
      .hook('SubagentStop', T + 4, { agent_id: 'done', agent_type: 'Plan' })
      .hook('PreToolUse', T + 5, spawnCall('s-pending', 'Explore'))
      .hook('SessionEnd', T + 6, { reason: 'prompt_input_exit' });
    expect(h.agent(sub('run'))).toMatchObject({ status: 'ended', endReason: PARENT_ENDED_REASON, endedAt: T + 6 });
    expect(h.agent(sub('run')).tools[0]).toMatchObject({ id: 'g', status: 'unknown' });
    expect(h.agent(sub('done'))).toMatchObject({ status: 'completed', endedAt: T + 4 });
    expect(h.state.spawns[SESSION]).toBeUndefined();
    expect(h.state.log.some((l) => l.agentKey === sub('run'))).toBe(true);

    // A stop that happened before the end, delivered late, reports the real outcome.
    h.hook('SubagentStop', T + 5, { agent_id: 'run', agent_type: 'Explore' });
    expect(h.agent(sub('run'))).toMatchObject({ status: 'completed', endReason: 'Finished', endedAt: T + 5 });
  });

  it('ends children even when their last event carries a later capture time than SessionEnd', () => {
    const h = new Harness()
      .hook('SubagentStart', T, { agent_id: 'a', agent_type: 'Explore' })
      .hook('PreToolUse', T + 50, tool('g', 'Grep', { agent_id: 'a' }))
      .hook('SessionEnd', T + 40);
    expect(h.agent(sub('a')).status).toBe('ended');
  });

  it('reactivates the same session entity on resume', () => {
    const h = new Harness()
      .hook('SessionStart', T, { source: 'startup' })
      .hook('SubagentStart', T + 1, { agent_id: 'old', agent_type: 'Explore' })
      .hook('SessionEnd', T + 2, { reason: 'other' })
      .hook('SessionStart', T + 10_000, { source: 'resume' });
    expect(Object.values(h.state.agents).filter((a) => a.kind === 'session')).toHaveLength(1);
    expect(h.agent()).toMatchObject({ key: SESSION, status: 'idle', statusDetail: 'Resumed, waiting for a prompt', firstSeenAt: T });
    expect(h.agent().endedAt).toBeUndefined();
    // Children of the earlier run stay ended; nothing is revived without evidence.
    expect(h.agent(sub('old')).status).toBe('ended');
    h.hook('UserPromptSubmit', T + 11_000).hook('PreToolUse', T + 11_001, spawnCall('s-new', 'Explore')).hook('SubagentStart', T + 11_002, { agent_id: 'new', agent_type: 'Explore' });
    expect(h.agent(sub('new'))).toMatchObject({ parentKey: SESSION, parentVia: 'spawn-tool', status: 'working' });
  });

  it('resumes a completed subagent on a new SubagentStart', () => {
    const h = new Harness()
      .hook('SubagentStart', T, { agent_id: 'r', agent_type: 'Explore' })
      .hook('SubagentStop', T + 1000, { agent_id: 'r', agent_type: 'Explore' })
      .hook('PreToolUse', T + 5000, spawnCall('s-other', 'Explore'))
      .hook('SubagentStart', T + 9000, { agent_id: 'r', agent_type: 'Explore' });
    expect(h.agent(sub('r'))).toMatchObject({ status: 'working', statusDetail: 'Resumed', endedAt: undefined });
    // The resumed agent did not take the pending call meant for a new subagent.
    expect(h.state.spawns[SESSION]).toHaveLength(1);
    h.hook('SubagentStop', T + 20_000, { agent_id: 'r', agent_type: 'Explore' });
    expect(h.agent(sub('r'))).toMatchObject({ status: 'completed', endedAt: T + 20_000 });
    expect(h.agent(sub('r')).counts.turns).toBe(2);
  });
});

describe('staleness and pruning', () => {
  it('flags a quiet working subagent stale, never an idle teammate, and prunes finished trees together', () => {
    const o = DEFAULT_REDUCER_OPTIONS;
    const h = new Harness()
      .hook('SessionStart', T)
      .hook('SubagentStart', T, { agent_id: 'busy', agent_type: 'Explore' })
      .hook('TeammateIdle', T, { agent_id: 'tm', teammate_name: 'carol' })
      .hook('SubagentStart', T, { agent_id: 'outer', agent_type: 'general-purpose' })
      .hook('PreToolUse', T + 1, spawnCall('s-in', 'Explore', { agent_id: 'outer' }))
      .hook('SubagentStart', T + 2, { agent_id: 'inner', agent_type: 'Explore' })
      .hook('SubagentStop', T + 3, { agent_id: 'inner', agent_type: 'Explore' })
      .apply(tick(T + o.staleAfterMs + 10));
    expect(h.agent(sub('busy'))).toMatchObject({ status: 'working', stale: true });
    expect(h.agent(sub('tm')).stale).toBeUndefined();
    expect(h.agent(sub('inner')).stale).toBeUndefined();

    h.hook('SubagentStop', T + o.staleAfterMs + 20, { agent_id: 'outer', agent_type: 'general-purpose' });
    h.hook('PreToolUse', T + o.pruneAfterMs, tool('keepalive', 'Read', { agent_id: 'busy' }));
    h.apply(tick(T + o.staleAfterMs + 30 + o.pruneAfterMs));
    // Both the finished outer subagent and its finished child are gone; the live ones stay.
    expect(h.state.agents[sub('outer')]).toBeUndefined();
    expect(h.state.agents[sub('inner')]).toBeUndefined();
    expect(Object.keys(h.state.agents).sort()).toEqual([SESSION, sub('busy'), sub('tm')].sort());
  });
});

describe('persisted state from earlier versions', () => {
  it('keeps working with pending spawns saved without the newer optional fields', () => {
    const old = JSON.parse(
      JSON.stringify({
        ...createInitialState(),
        agents: {
          [SESSION]: {
            key: SESSION, sessionId: SESSION, kind: 'session', status: 'working', statusAt: T, statusSource: 'hook',
            firstSeenAt: T, lastEventAt: T, tools: [], sources: ['hook'], counts: { tools: 0, failures: 0, permissions: 0, turns: 0 }, toolSeq: 0,
          },
        },
        spawns: { [SESSION]: [{ byKey: SESSION, toolUseId: 's1', subagentType: 'Explore', ts: T }] },
        lastSeq: 7,
      }),
    ) as OfficeState;
    const ev: MonitorEvent = { ...norm(hook('SubagentStart', { agent_id: 'e1', agent_type: 'Explore' }), T + 5), seq: 8 };
    const s = reduce(old, ev);
    expect(s.agents[sub('e1')]).toMatchObject({ parentVia: 'spawn-tool', spawnToolUseId: 's1', parentKey: SESSION });
    expect(s.spawns[SESSION]).toEqual([]);
  });
});
