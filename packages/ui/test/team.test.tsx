import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentKeyFor, createInitialState, defaultLayout, normalizeHookPayload, reduce, type OfficeState } from '@agent-office/core';
import type { StoreSnapshot } from '../src/store';
import type { HostInfo } from '../src/transport';
import { TeamView } from '../src/views/TeamView';
import type { MeetingInfo } from '../src/office/meetings';

afterEach(cleanup);

const T = Date.now() - 60_000;
const host: HostInfo = { kind: 'browser', workspaceFolders: [], canOpenFiles: false, canFocusClaude: false };

type Step = [name: string, ts: number, extra: Record<string, unknown>, sessionId?: string];

function build(steps: Step[]): OfficeState {
  let s = createInitialState();
  let seq = 0;
  for (const [name, ts, extra, sid] of steps) {
    const r = normalizeHookPayload({ session_id: sid ?? 'sess-1', cwd: 'c:\\work\\app', hook_event_name: name, ...extra }, ts);
    if (!r.ok) throw new Error(r.error);
    s = reduce(s, { ...r.event, seq: ++seq });
  }
  return s;
}

const snapOf = (state: OfficeState, synced = true): StoreSnapshot => ({ state, layout: defaultLayout(), connection: 'open', synced, host, version: 1 });

const teamState = build([
  ['SessionStart', T, { source: 'startup' }],
  ['UserPromptSubmit', T + 10, { prompt: 'TOP SECRET PROMPT' }],
  ['PreToolUse', T + 100, { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { subagent_type: 'Explore', description: 'Find tests' } }],
  ['SubagentStart', T + 200, { agent_id: 'ex1', agent_type: 'Explore' }],
  ['PreToolUse', T + 300, { agent_id: 'ex1', tool_name: 'Task', tool_use_id: 'a2', tool_input: { subagent_type: 'Plan', description: 'Plan' } }],
  ['SubagentStart', T + 400, { agent_id: 'ex2', agent_type: 'Plan' }],
  ['PreToolUse', T + 450, { agent_id: 'ghost', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'a.ts' } }],
  ['TaskCreated', T + 500, { task_id: '1', task_subject: 'Fix login bug' }],
  ['TaskCompleted', T + 600, { agent_id: 'ex1', task_id: '1', task_subject: 'Fix login bug' }],
  ['SubagentStop', T + 700, { agent_id: 'ex2', last_assistant_message: 'PRIVATE OUTPUT' }],
  ['SessionStart', T + 800, { source: 'startup' }, 'solo-1'],
]);

const LEAD = agentKeyFor('sess-1');
const EX1 = agentKeyFor('sess-1', 'ex1');
const EX2 = agentKeyFor('sess-1', 'ex2');
const GHOST = agentKeyFor('sess-1', 'ghost');

function renderView(state: OfficeState, extra: { meetings?: MeetingInfo[]; synced?: boolean } = {}) {
  const onSelectAgent = vi.fn();
  render(<TeamView snap={snapOf(state, extra.synced ?? true)} now={Date.now()} onSelectAgent={onSelectAgent} meetings={extra.meetings} />);
  return onSelectAgent;
}

describe('TeamView', () => {
  it('draws the lead, nested subagents and labelled edges in a graph', () => {
    renderView(teamState);
    const graph = screen.getByRole('group', { name: /Team graph for app · sess-1/ });
    const g = within(graph);
    expect(g.getByRole('button', { name: /^app · sess-1 \(lead, Working\)/ })).toBeTruthy();
    expect(g.getByRole('button', { name: /^Explore · ex1 \(subagent, Working\)/ })).toBeTruthy();
    expect(g.getByRole('button', { name: /^Plan · ex2 \(subagent, Completed\)/ })).toBeTruthy();
    expect(g.getByText('delegated')).toBeTruthy();
    expect(g.getByText('nested')).toBeTruthy();
    expect(g.getByText('handoff')).toBeTruthy();
    // Nested node is indented under its parent.
    const x = (key: string) => Number(/translate\((\d+)/.exec(graph.querySelector(`[data-key="${key}"]`)!.getAttribute('transform')!)![1]);
    expect(x(EX2)).toBeGreaterThan(x(EX1));
    expect(x(EX1)).toBeGreaterThan(x(LEAD));
  });

  it('draws inferred links dashed and explains them', () => {
    renderView(teamState);
    const graph = screen.getByRole('group', { name: /Team graph/ });
    const inferred = graph.querySelectorAll('[data-confidence="inferred"]');
    expect(inferred).toHaveLength(1);
    expect(inferred[0]!.querySelector('path')!.getAttribute('stroke-dasharray')).toBe('4 3');
    expect(within(graph).getByText('inferred')).toBeTruthy();
    expect(graph.querySelectorAll('[data-confidence="verified"] path:not([stroke-dasharray])')).toHaveLength(2);
    const row = document.querySelector(`.team-members tr[data-key="${GHOST}"]`)!;
    expect(row.className).toBe('inferred');
    expect(row.textContent).toMatch(/subagent · ghost.*assumed to belong to.*inferred.*no SubagentStart was observed/);
    expect(screen.getAllByText('partial').length).toBeGreaterThan(0);
  });

  it('lists every subagent as its own member with its link, evidence, status and parallel work', () => {
    renderView(teamState);
    const table = screen.getByRole('table', { name: 'Members and evidence' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.getAttribute('data-key'))).toEqual([EX1, EX2, GHOST]);
    const [ex1, ex2] = rows as [HTMLElement, HTMLElement];
    expect(ex1.textContent).toMatch(/Explore · ex1.*delegated by app · sess-1.*verified.*SubagentStart matched to the Agent\/Task tool call/);
    expect(ex2.textContent).toMatch(/Plan · ex2.*nested, delegated by Explore · ex1.*verified/);
    // Parallel work: the lead, ex1 and ghost are working; ex2 has completed.
    expect(within(ex1).getByText('∥ parallel')).toBeTruthy();
    expect(within(ex2).queryByText('∥ parallel')).toBeNull();
    expect(within(ex2).getByText('Completed')).toBeTruthy();
    expect(screen.getByText('∥ 3 working in parallel')).toBeTruthy();
    expect(screen.getByText(/3 members \(3 subagents\)/)).toBeTruthy();
    const graph = within(screen.getByRole('group', { name: /Team graph/ }));
    expect(graph.getByRole('button', { name: /^Explore · ex1 \(subagent, Working\) · working in parallel$/ })).toBeTruthy();
    expect(graph.getByRole('button', { name: /^Plan · ex2 \(subagent, Completed\)$/ })).toBeTruthy();
    // Task links name both sides of the handoff.
    const task = screen.getByText('Fix login bug', { selector: '.team-task-subject' }).closest('li')!;
    expect(task.textContent).toMatch(/created by app · sess-1 · completed by Explore · ex1/);
    expect(within(task).getByText('handoff')).toBeTruthy();
  });

  it('tells apart parallel subagents of one type whose short ids collide', () => {
    const state = build([
      ['SessionStart', T, { source: 'startup' }],
      ['UserPromptSubmit', T + 10, {}],
      ['PreToolUse', T + 100, { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { subagent_type: 'Explore' } }],
      ['PreToolUse', T + 110, { tool_name: 'Agent', tool_use_id: 'a2', tool_input: { subagent_type: 'Explore' } }],
      ['SubagentStart', T + 200, { agent_id: 'abcdef111', agent_type: 'Explore' }],
      ['SubagentStart', T + 210, { agent_id: 'abcdef222', agent_type: 'Explore' }],
    ]);
    renderView(state);
    const graph = within(screen.getByRole('group', { name: /Team graph/ }));
    expect(graph.getByRole('button', { name: /^Explore · abcdef111 \(subagent, Working\)/ })).toBeTruthy();
    expect(graph.getByRole('button', { name: /^Explore · abcdef222 \(subagent, Working\)/ })).toBeTruthy();
    expect(graph.getAllByText('delegated')).toHaveLength(2);
    const rows = within(screen.getByRole('table', { name: 'Members and evidence' })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => within(r).getAllByRole('button')[0]!.textContent)).toEqual(['Explore · abcdef111', 'Explore · abcdef222']);
    expect(screen.getByText('∥ 3 working in parallel')).toBeTruthy();
  });

  it('labels real events and the office simulation visibly', () => {
    renderView(teamState);
    expect(screen.getAllByText('Real agent event').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Office simulation').length).toBeGreaterThan(0);
    const sim = within(screen.getByRole('region', { name: 'Office simulation' }));
    expect(sim.getByText(/Simulated office activity, not Claude Code activity/)).toBeTruthy();
    expect(sim.getByText(/three or four of them standing in a common area: a coffee chat/)).toBeTruthy();
    expect(sim.getByText(/fixed list of local templates/)).toBeTruthy();
    const feed = screen.getByRole('region', { name: 'Real agent events' });
    expect(within(feed).getByText('Task handoff detected')).toBeTruthy();
    expect(within(feed).getByText('“Fix login bug”')).toBeTruthy();
    expect(within(feed).getByText('Subagent delegated')).toBeTruthy();
    expect(within(feed).getByText('Nested delegation')).toBeTruthy();
    expect(within(feed).getByText('Delegated work completed')).toBeTruthy();
    expect(within(feed).getByText(/working in parallel/)).toBeTruthy();
    // Office animations of real events are explained as animations, not messages.
    expect(within(feed).getByText('Animation of a verified event')).toBeTruthy();
    expect(within(feed).getByText(/short briefing.*They are not messages: nothing is said/)).toBeTruthy();
    // Privacy: prompts and agent output never appear.
    expect(document.body.textContent).not.toMatch(/TOP SECRET PROMPT|PRIVATE OUTPUT|Find tests/);
  });

  it('selects an agent when a node is clicked or activated with the keyboard', () => {
    const onSelect = renderView(teamState);
    const graph = within(screen.getByRole('group', { name: /Team graph/ }));
    fireEvent.click(graph.getByRole('button', { name: /^Explore · ex1/ }));
    expect(onSelect).toHaveBeenLastCalledWith(EX1);
    fireEvent.keyDown(graph.getByRole('button', { name: /^Plan · ex2/ }), { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith(EX2);
    // Agent names in the feed open the inspector too.
    const feed = within(screen.getByRole('region', { name: 'Real agent events' }));
    fireEvent.click(feed.getAllByRole('button', { name: 'app · sess-1' })[0]!);
    expect(onSelect).toHaveBeenLastCalledWith(LEAD);
  });

  it('lists solo sessions separately', () => {
    renderView(teamState);
    expect(screen.getByText(/Working solo/)).toBeTruthy();
    expect(screen.getAllByRole('group', { name: /Team graph/ })).toHaveLength(1);
  });

  it('shows empty states with no data and with solo sessions only', () => {
    renderView(createInitialState());
    expect(screen.getByText(/No agents yet\./)).toBeTruthy();
    expect(screen.getByText(/No delegations, handoffs or completions yet/)).toBeTruthy();
    expect(screen.getAllByText('Office simulation').length).toBeGreaterThan(0);
    cleanup();
    renderView(createInitialState(), { synced: false });
    expect(screen.getByText(/Waiting for the monitor/)).toBeTruthy();
    cleanup();
    renderView(build([['SessionStart', T, {}]]));
    expect(screen.getByText(/No delegation, teammates or task handoffs observed in live sessions/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: /Team graph/ })).toBeNull();
  });

  it('hides ended sessions until asked', () => {
    const ended = build([
      ['SessionStart', T, {}],
      ['PreToolUse', T + 100, { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { subagent_type: 'Explore' } }],
      ['SubagentStart', T + 200, { agent_id: 'ex1', agent_type: 'Explore' }],
      ['SessionEnd', T + 300, {}],
    ]);
    renderView(ended);
    expect(screen.queryByRole('group', { name: /Team graph/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Include ended sessions/ }));
    expect(screen.getByRole('group', { name: /Team graph/ })).toBeTruthy();
  });

  it('marks demo sessions as demo data, not real agent events', () => {
    const sim = build([
      ['SessionStart', T, {}, 'sim-demo'],
      ['PreToolUse', T + 100, { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { subagent_type: 'Explore' } }, 'sim-demo'],
      ['SubagentStart', T + 200, { agent_id: 'ex1', agent_type: 'Explore' }, 'sim-demo'],
    ]);
    renderView(sim);
    const feed = within(screen.getByRole('region', { name: 'Real agent events' }));
    expect(feed.getAllByText('Demo data').length).toBeGreaterThan(0);
    expect(feed.queryAllByText('Real agent event', { selector: 'li span' })).toHaveLength(0);
    expect(screen.getByText('SIMULATED')).toBeTruthy();
  });

  it('lists live simulated meetings when the scene passes them in', () => {
    const meetings: MeetingInfo[] = [
      { id: 'meeting-m1-1', roomId: 'm1', roomName: 'Meeting room', kind: 'meeting', participants: [LEAD, EX1], phase: 'meeting', createdAt: T, startedAt: T, simulated: true },
    ];
    renderView(teamState, { meetings });
    const sim = within(screen.getByRole('region', { name: 'Office simulation' }));
    expect(sim.getByText('simulated')).toBeTruthy();
    expect(sim.getByText(/Meeting · Meeting room · in progress · app · sess-1, Explore · ex1/)).toBeTruthy();
  });

  it('lists simulated social gatherings with their kind and phase', () => {
    const meetings: MeetingInfo[] = [
      { id: 'social-b1-1', roomId: 'b1', roomName: 'Break room', kind: 'social', topic: 'coffee', participants: [LEAD, EX1, EX2], phase: 'ending', createdAt: T, simulated: true },
      { id: 'social-c1-2', roomId: 'c1', roomName: 'Collaboration', kind: 'social', topic: 'discussion', participants: [EX1, EX2, LEAD], phase: 'gathering', createdAt: T, simulated: true },
    ];
    renderView(teamState, { meetings });
    const sim = within(screen.getByRole('region', { name: 'Office simulation' }));
    expect(sim.getAllByText('simulated')).toHaveLength(2);
    expect(sim.getByText(/Coffee chat · Break room · wrapping up · app · sess-1, Explore · ex1, Plan · ex2/)).toBeTruthy();
    expect(sim.getByText(/Pretend team discussion · Collaboration · gathering/)).toBeTruthy();
    // Simulated gatherings never show up as real events.
    const feed = within(screen.getByRole('region', { name: 'Real agent events' }));
    expect(feed.queryByText(/Coffee chat|team discussion/)).toBeNull();
  });
});
