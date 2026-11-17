import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentKeyFor, createInitialState, normalizeHookPayload, reduce, systemEvent, taskKeyFor, type MonitorEvent, type OfficeState } from '@agent-office/core';
import { AgentList } from '../src/components/AgentList';
import { Inspector } from '../src/components/Inspector';
import type { HostInfo } from '../src/transport';
import { filterAgents, toWorkerViews } from '../src/view';

afterEach(cleanup);

const T = Date.now() - 60_000;
const S = 'sess-1';
const host: HostInfo = { kind: 'browser', workspaceFolders: [], canOpenFiles: false, canFocusClaude: false };
const key = (id: string, s = S) => agentKeyFor(s, id);

function build(events: Array<[string, number, Record<string, unknown>, string?]>, extra: MonitorEvent[] = []): OfficeState {
  let s = createInitialState();
  let seq = 0;
  for (const [name, ts, fields, sid] of events) {
    const r = normalizeHookPayload({ session_id: sid ?? S, cwd: 'c:\\work\\app', transcript_path: 'c:\\t\\sess-1.jsonl', hook_event_name: name, ...fields }, ts);
    if (!r.ok) throw new Error(r.error);
    s = reduce(s, { ...r.event, seq: ++seq });
  }
  for (const e of extra) s = reduce(s, { ...e, seq: ++seq });
  return s;
}

const spawn = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Agent', tool_use_id: id, tool_input: { description: id, subagent_type: type }, ...extra });

// A lead with two parallel Explore subagents, a nested Plan subagent and an agent-team teammate.
const team = build(
  [
    ['SessionStart', T, { source: 'startup' }],
    ['UserPromptSubmit', T + 100, {}],
    ['PreToolUse', T + 200, spawn('s-gp', 'general-purpose')],
    ['SubagentStart', T + 300, { agent_id: 'gp', agent_type: 'general-purpose' }],
    ['PreToolUse', T + 400, spawn('s-plan', 'Plan', { agent_id: 'gp', agent_type: 'general-purpose' })],
    ['SubagentStart', T + 500, { agent_id: 'plan', agent_type: 'Plan' }],
    ['PreToolUse', T + 600, spawn('s-e1', 'Explore')],
    ['PreToolUse', T + 601, spawn('s-e2', 'Explore')],
    ['SubagentStart', T + 700, { agent_id: 'e1', agent_type: 'Explore' }],
    ['SubagentStart', T + 701, { agent_id: 'e2', agent_type: 'Explore' }],
    ['PreToolUse', T + 800, { agent_id: 'e2', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'login' } }],
    ['TaskCreated', T + 900, { agent_id: 'tm', task_id: 't1', task_subject: 'Review the auth flow', teammate_name: 'reviewer', team_name: 'session-sess1xyz' }],
    ['TaskCompleted', T + 1000, { agent_id: 'tm', task_id: 't1', task_subject: 'Review the auth flow', teammate_name: 'reviewer' }],
    ['TeammateIdle', T + 1100, { agent_id: 'tm', teammate_name: 'reviewer', team_name: 'session-sess1xyz' }],
    ['SubagentStop', T + 1200, { agent_id: 'plan', agent_type: 'Plan', last_assistant_message: 'Plan ready' }],
  ],
  [
    systemEvent(
      { kind: 'TranscriptSeen', usage: { inputTokens: 10, cacheReadTokens: 2000, cacheCreationTokens: 5, outputTokens: 40, at: T + 1300 } },
      { ts: T + 1300, sessionId: S, source: 'transcript' },
    ),
  ],
);

function inspect(state: OfficeState, k: string) {
  const onSelect = vi.fn();
  render(<Inspector agent={state.agents[k]!} state={state} now={Date.now()} host={host} onSelect={onSelect} onClose={vi.fn()} onOpenTranscript={vi.fn()} onFocusClaude={vi.fn()} />);
  return onSelect;
}

const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;

describe('Inspector: identity and relationships', () => {
  it('shows a nested subagent’s parent, how the link was established, its session and project', () => {
    const onSelect = inspect(team, key('plan'));
    const parent = fact('Parent');
    expect(within(parent).getByRole('button').textContent).toBe('general-purpose · gp');
    expect(parent.textContent).toMatch(/Spawned by an Agent\/Task tool call of this agent/);
    fireEvent.click(within(parent).getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith(key('gp'));
    // The session is not the direct parent here, so it is linked separately.
    const session = fact('Session');
    fireEvent.click(within(session).getByRole('button', { name: /app · sess-1/ }));
    expect(onSelect).toHaveBeenCalledWith(S);
    expect(session.textContent).toContain(S);
    expect(fact('Project').textContent).toBe('app');
    expect(fact('Tasks').textContent).toBe('None reported');
    expect(screen.getByText('Plan ready')).toBeTruthy();
  });

  it('says when the spawning call of a parallel subagent could not be pinned down', () => {
    inspect(team, key('e1'));
    expect(fact('Parent').textContent).toMatch(/matched by type and timing; the exact call is not known/);
  });

  it('lists children of every kind and the current tool of a subagent', () => {
    inspect(team, S);
    const children = screen.getByText(/^Subagents & teammates \(4\)$/, { selector: 'dt' }).nextElementSibling as HTMLElement;
    const names = within(children).getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['general-purpose · gp Working', 'Explore · e1 Working', 'Explore · e2 Working', 'reviewer Idle']);
    expect(screen.queryByText('Parent', { selector: 'dt' })).toBeNull();
    cleanup();
    inspect(team, key('e2'));
    expect(screen.getByText('Current tool')).toBeTruthy();
    expect(screen.getAllByText(/Grep login/).length).toBeGreaterThan(0);
  });

  it('shows teammate name, team and task history', () => {
    inspect(team, key('tm'));
    expect(fact('Teammate').textContent).toBe('reviewer');
    expect(fact('Team').textContent).toBe('session-sess1xyz');
    expect(fact('Tasks').textContent).toBe('1 created · 1 completed by this agent');
    fireEvent.click(screen.getByRole('tab', { name: /Tasks \(1\)/ }));
    expect(screen.getByText('Review the auth flow')).toBeTruthy();
  });

  it('shows usage with its source only when reported', () => {
    inspect(team, S);
    expect(fact('Source').textContent).toMatch(/Latest API call recorded in the transcript/);
    expect(within(fact('Source')).getByText('transcript')).toBeTruthy();
    cleanup();
    inspect(team, key('e1'));
    expect(screen.getByText(/never estimated/)).toBeTruthy();
  });

  it('re-sanitises task subjects before display and handles a removed parent', () => {
    const secret = ['sk', 'ant', 'api03', 'x'.repeat(20)].join('-');
    const s: OfficeState = structuredClone(team);
    s.tasks[taskKeyFor(S, 't1')]!.subject = `Rotate ${secret}`;
    delete s.agents[key('gp')];
    inspect(s, key('tm'));
    fireEvent.click(screen.getByRole('tab', { name: /Tasks/ }));
    expect(document.body.textContent).not.toContain(secret);
    expect(screen.getByText(/Rotate sk-ant-\[REDACTED\]/)).toBeTruthy();
    cleanup();
    inspect(s, key('plan'));
    expect(fact('Parent').textContent).toMatch(/^No longer in the office \(removed\)/);
  });
});

describe('AgentList and worker views', () => {
  it('lists every agent once, nested under the agent that spawned it', () => {
    const agents = filterAgents(team, { workspace: 'all', showEnded: true }, []);
    render(<AgentList state={team} agents={agents} selected={null} now={Date.now()} onSelect={vi.fn()} />);
    const rows = screen.getAllByRole('button').map((b) => b.querySelector('.agent-name')!.textContent);
    expect(rows).toEqual(['app · sess-1', '└ general-purpose · gp', '└ Plan · plan', '└ Explore · e1', '└ Explore · e2', '└ reviewer']);
  });

  it('builds exactly one worker view per agent in a stable order, and flags simulated sessions', () => {
    const agents = Object.values(team.agents);
    const views = toWorkerViews([...agents, ...agents.slice(0, 2)]);
    expect(views.map((v) => v.key)).toEqual([S, key('gp'), key('plan'), key('e1'), key('e2'), key('tm')]);
    expect(toWorkerViews([...agents].reverse()).map((v) => v.key)).toEqual(views.map((v) => v.key));
    expect(views.find((v) => v.key === key('plan'))).toMatchObject({ kind: 'subagent', parentKey: key('gp'), status: 'completed', agentType: 'Plan' });
    expect(views.find((v) => v.key === key('tm'))).toMatchObject({ kind: 'teammate', name: 'reviewer', parentKey: S, status: 'idle' });
    expect(views.find((v) => v.key === key('e2'))).toMatchObject({ toolRunning: true, toolName: 'Grep' });
    expect(views.every((v) => !v.simulated)).toBe(true);

    const sim = build([
      ['SessionStart', T, {}, 'sim-demo-1'],
      ['SubagentStart', T + 1, { agent_id: 'sim-explore-1', agent_type: 'Explore' }, 'sim-demo-1'],
    ]);
    expect(toWorkerViews(Object.values(sim.agents)).map((v) => v.simulated)).toEqual([true, true]);
  });

  it('keeps a finished subagent visible briefly, then only with the Ended filter', () => {
    const now = Date.now();
    const s = build([
      ['SessionStart', now - 120_000, {}],
      ['SubagentStart', now - 110_000, { agent_id: 'old', agent_type: 'Explore' }],
      ['SubagentStop', now - 100_000, { agent_id: 'old', agent_type: 'Explore' }],
      ['SubagentStart', now - 5_000, { agent_id: 'new', agent_type: 'Explore' }],
      ['SubagentStop', now - 2_000, { agent_id: 'new', agent_type: 'Explore' }],
    ]);
    const visible = filterAgents(s, { workspace: 'all', showEnded: false }, []).map((a) => a.key);
    expect(visible).toEqual([S, key('new')]);
    expect(filterAgents(s, { workspace: 'all', showEnded: true }, []).map((a) => a.key).sort()).toEqual([S, key('new'), key('old')].sort());
    // History is still in state until normal pruning.
    expect(s.agents[key('old')]).toMatchObject({ status: 'completed', counts: { turns: 1 } });
  });
});
