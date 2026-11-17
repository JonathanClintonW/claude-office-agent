// Replay equivalence, seeking, the player model and the History view (canvas mocked).
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInitialState,
  defaultLayout,
  normalizeHookPayload,
  reduce,
  systemEvent,
  type HistorySessionEntry,
  type MonitorEvent,
  type OfficeState,
} from '@agent-office/core';
import { StoreContext } from '../src/hooks';
import {
  advance,
  buildReplay,
  createPlayer,
  describeEvent,
  eventsBefore,
  fetchSessionEvents,
  indexAtTime,
  pause,
  play,
  replayWorkerViews,
  seek,
  setSpeed,
  stateAtIndex,
  stateAtTime,
  stepEvent,
  timelineBars,
  togglePlay,
} from '../src/replay';
import type { OfficeStore, StoreSnapshot } from '../src/store';
import type { HostInfo } from '../src/transport';
import { dayBounds, HistoryView } from '../src/views/HistoryView';

// The PixiJS scene needs WebGL; the replay view is tested with a stand-in that exposes its props.
vi.mock('../src/components/OfficeView', async () => {
  const { createElement: h } = await import('react');
  return {
    OfficeView: (p: { workers: unknown[]; idleLife: boolean; editMode: boolean }) =>
      h('div', { 'data-testid': 'office', 'data-workers': p.workers.length, 'data-idle-life': String(p.idleLife), 'data-edit': String(p.editMode) }),
  };
});

afterEach(cleanup);

const T = Date.parse('2026-11-17T09:00:00.000Z');
let seq = 0;

function ev(name: string, ts: number, extra: Record<string, unknown> = {}, sessionId = 's1'): MonitorEvent {
  const r = normalizeHookPayload({ session_id: sessionId, cwd: 'c:\\work\\app', hook_event_name: name, ...extra }, ts);
  if (!r.ok) throw new Error(r.error);
  return { ...r.event, seq: ++seq };
}

function scenario(): MonitorEvent[] {
  return [
    ev('SessionStart', T, { source: 'startup', model: 'claude-test-1' }),
    ev('UserPromptSubmit', T + 1000),
    ev('PreToolUse', T + 2000, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } }),
    ev('PreToolUse', T + 1500, { tool_name: 'Read', tool_use_id: 'r0', tool_input: { file_path: 'x.ts' } }), // late, older ts
    ev('PostToolUseFailure', T + 3000, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {}, error: 'Exit code 1' }),
    ev('PreToolUse', T + 4000, { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { subagent_type: 'Explore', description: 'look' } }),
    ev('SubagentStart', T + 4100, { agent_id: 'ex1', agent_type: 'Explore' }),
    { ...systemEvent({ kind: 'Tick' }, { ts: T + 4200, sessionId: '*' }), seq: ++seq },
    ev('TaskCreated', T + 5000, { task_id: '1', task_subject: 'Fix it' }),
    ev('PermissionRequest', T + 6000, { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }),
    ev('SubagentStop', T + 7000, { agent_id: 'ex1', last_assistant_message: 'SECRET-ANSWER' }),
    ev('TaskCompleted', T + 8000, { task_id: '1' }),
    ev('Stop', T + 9000, { last_assistant_message: 'SECRET-ANSWER' }),
    ev('UserPromptSubmit', T + 9 * 60_000), // a quiet gap of ~9 minutes
    ev('StopFailure', T + 9 * 60_000 + 500, { error: 'rate_limit' }),
    ev('SessionEnd', T + 10 * 60_000, { reason: 'other' }),
  ];
}

function prefix(events: MonitorEvent[], n: number): OfficeState {
  let s = createInitialState();
  for (const e of events.slice(0, n)) s = reduce(s, e);
  return s;
}

describe('replay timeline', () => {
  const events = scenario();
  const noTick = events.filter((e) => e.kind !== 'Tick');

  it('state at every index equals reducing the event prefix, whatever the access order', () => {
    const tl = buildReplay(events, { checkpointEvery: 3 });
    expect(tl.events).toHaveLength(noTick.length);
    expect(tl.checkpoints).toHaveLength(Math.floor(noTick.length / 3) + 1);
    for (let n = 0; n <= noTick.length; n++) expect(stateAtIndex(tl, n)).toEqual(prefix(noTick, n));
    // backwards and random seeks hit checkpoints instead of replaying from the cursor
    for (const n of [noTick.length, 0, 7, 2, 11, 5, 5, 14, 1]) expect(stateAtIndex(tl, n)).toEqual(prefix(noTick, n));
    expect(stateAtIndex(tl, -5)).toEqual(createInitialState());
    expect(stateAtIndex(tl, 999)).toEqual(prefix(noTick, noTick.length));
  });

  it('state at time t equals reducing the events whose replay clock is <= t (monotone for late events)', () => {
    const tl = buildReplay(events);
    expect(tl.times).toEqual([...tl.times].sort((a, b) => a - b));
    expect(tl.start).toBe(T);
    expect(tl.end).toBe(T + 10 * 60_000);
    // The late Read (ts T+1500) sits after Bash (T+2000): its replay clock is T+2000.
    expect(indexAtTime(tl, T + 1999)).toBe(2);
    expect(indexAtTime(tl, T + 2000)).toBe(4);
    for (const t of [T - 1, T, T + 1500, T + 2000, T + 4150, T + 6500, T + 9000, T + 5 * 60_000, T + 10 * 60_000, T + 99 * 60_000]) {
      const n = noTick.filter((_, i) => tl.times[i]! <= t).length;
      expect(stateAtTime(tl, t)).toEqual(prefix(noTick, n));
    }
    const mid = stateAtTime(tl, T + 6500);
    expect(mid.agents['s1']!.status).toBe('waiting_permission');
    expect(mid.agents['s1::ex1']!.status).toBe('working');
    expect(stateAtTime(tl, T + 10 * 60_000).agents['s1']!.status).toBe('ended');
  });

  it('handles an empty session', () => {
    const tl = buildReplay([]);
    expect(stateAtTime(tl, T)).toEqual(createInitialState());
    expect(play(tl, createPlayer(tl)).playing).toBe(false);
    expect(timelineBars(tl, 10).every((b) => b.events === 0)).toBe(true);
  });
});

describe('player model', () => {
  const tl = buildReplay(scenario());

  it('plays, pauses, changes speed (1x to 16x) and stops at the end', () => {
    let p = createPlayer(tl);
    expect(p).toEqual({ playing: false, speed: 1, position: tl.start });
    expect(advance(tl, p, 1000)).toBe(p); // paused: nothing moves
    p = play(tl, p);
    p = advance(tl, p, 1000);
    expect(p.position).toBe(tl.start + 1000);
    p = setSpeed(p, 8);
    p = advance(tl, p, 500);
    expect(p.position).toBe(tl.start + 5000);
    expect(setSpeed(p, 100).speed).toBe(16);
    expect(setSpeed(p, 0).speed).toBe(1);
    expect(setSpeed(p, 3).speed).toBe(2);
    expect(pause(p).playing).toBe(false);
    p = advance(tl, setSpeed(p, 16), 10 * 60_000);
    expect(p).toMatchObject({ position: tl.end, playing: false });
    // Play at the end restarts from the beginning.
    expect(togglePlay(tl, p)).toMatchObject({ playing: true, position: tl.start });
  });

  it('seeks within bounds and steps between events', () => {
    let p = createPlayer(tl);
    expect(seek(tl, p, tl.start - 5000).position).toBe(tl.start);
    expect(seek(tl, p, tl.end + 5000).position).toBe(tl.end);
    expect(seek(tl, p, Number.NaN).position).toBe(tl.start);
    p = seek(tl, p, T + 2500);
    p = stepEvent(tl, p, 1);
    expect(p.position).toBe(T + 3000);
    p = stepEvent(tl, p, -1);
    expect(p.position).toBe(T + 2000);
    p = stepEvent(tl, seek(tl, p, tl.start), -1);
    expect(p.position).toBe(tl.start);
    expect(stepEvent(tl, seek(tl, p, tl.end), 1).position).toBe(tl.end);
  });

  it('can jump across quiet gaps when asked (labelled in the UI)', () => {
    let p = play(tl, seek(tl, createPlayer(tl), T + 9000));
    const plain = advance(tl, p, 100);
    expect(plain.position).toBe(T + 9100);
    p = advance(tl, p, 100, { skipGapsOverMs: 30_000 });
    expect(p.position).toBe(T + 9 * 60_000 - 1000 + 100);
  });

  it('lists the events at a time, describes them without message text, and shifts scene timestamps', () => {
    const recent = eventsBefore(tl, T + 9000, 3);
    expect(recent.map((r) => r.event.kind)).toEqual(['SubagentStop', 'TaskCompleted', 'Stop']);
    expect(recent[2]!.index).toBe(11);
    const texts = tl.events.map((e) => describeEvent(e).text);
    expect(texts.join('\n')).not.toContain('SECRET-ANSWER');
    expect(describeEvent(tl.events[4]!)).toEqual({ text: '✗ Bash failed: Exit code 1', tone: 'bad' });
    expect(describeEvent(tl.events[0]!).text).toBe('Session started (startup) · claude-test-1');
    expect(describeEvent(tl.events[tl.events.length - 2]!)).toEqual({ text: 'Turn failed (rate_limit)', tone: 'bad' });

    const at = T + 9500;
    const state = stateAtTime(tl, at);
    const wall = T + 3_600_000;
    const views = replayWorkerViews(state, at, wall);
    const main = views.find((v) => v.key === 's1')!;
    expect(main.turnCompletedAt).toBe(T + 9000 + (wall - at));
    const sub = views.find((v) => v.key === 's1::ex1')!;
    expect(sub.status).toBe('completed');
    expect(sub.terminalAt).toBe(T + 7000 + (wall - at));
    const bars = timelineBars(tl, 20);
    expect(bars.reduce((n, b) => n + b.events, 0)).toBe(tl.events.length);
    expect(bars.reduce((n, b) => n + b.errors, 0)).toBe(2);
  });
});

describe('fetchSessionEvents', () => {
  const all = scenario().filter((e) => e.kind !== 'Tick');
  const pager = (pageSize: number) =>
    vi.fn(async (_m: string, p: Record<string, unknown>) => {
      const cursor = p.cursor as number;
      const limit = Math.min(pageSize, p.limit as number);
      const events = all.slice(cursor, cursor + limit);
      const done = cursor + events.length >= all.length;
      return { sessionId: p.sessionId, events, done, total: all.length, ...(done ? {} : { nextCursor: cursor + events.length }) };
    });

  it('follows the cursor until done', async () => {
    const rpc = pager(4);
    const r = await fetchSessionEvents(rpc, 's1');
    expect(r).toEqual({ events: all, total: all.length, truncated: false });
    expect(rpc).toHaveBeenCalledTimes(Math.ceil(all.length / 4));
    expect(rpc.mock.calls[0]).toEqual(['history.events', { sessionId: 's1', cursor: 0, limit: 5000 }]);
  });

  it('stops at the cap and reports truncation', async () => {
    const r = await fetchSessionEvents(pager(4), 's1', 6, 4);
    expect(r.events).toHaveLength(6);
    expect(r.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------- HistoryView (non-canvas parts)

const host: HostInfo = { kind: 'browser', workspaceFolders: [], canOpenFiles: false, canFocusClaude: false };

const entry: HistorySessionEntry = {
  sessionId: 's1',
  firstTs: T,
  lastTs: T + 10 * 60_000,
  cwd: 'c:\\work\\app',
  projectKey: 'c:\\work\\app',
  project: 'app',
  title: 'Fix the tests',
  ended: true,
  endedAt: T + 10 * 60_000,
  events: 15,
  agents: 2,
  tasks: 1,
  tasksCompleted: 1,
  toolCalls: 3,
  toolFailures: 1,
  toolInterrupts: 0,
  permissionRequests: 1,
  turns: 1,
  turnFailures: 1,
  days: ['2026-11-17'],
};

function renderHistory(rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>, connection: StoreSnapshot['connection'] = 'open') {
  const store = { rpc: vi.fn(rpc) } as unknown as OfficeStore;
  const snap: StoreSnapshot = { state: createInitialState(), layout: defaultLayout(), connection, synced: true, host, version: 1 };
  render(createElement(StoreContext.Provider, { value: store }, createElement(HistoryView, { snap, now: T, onSelectAgent: vi.fn() })));
  return store as unknown as { rpc: ReturnType<typeof vi.fn> };
}

const events = scenario().filter((e) => e.kind !== 'Tick');
const historyRpc = async (method: string, params: Record<string, unknown>) => {
  if (method === 'history.sessions') {
    const sessions = params.project && params.project !== 'c:\\work\\app' ? [] : [entry];
    return { sessions, total: sessions.length, projects: [{ key: 'c:\\work\\app', label: 'app', count: 1 }] };
  }
  if (method === 'history.events') return { sessionId: 's1', events, done: true, total: events.length };
  if (method === 'usage.session') {
    const b = { inputTokens: 1200, outputTokens: 300, cacheCreationTokens: 0, cacheReadTokens: 0, messages: 4 };
    return { sessionId: 's1', total: b, byModel: { 'claude-test-1': b }, subagentTotal: { ...b, messages: 0 }, subagents: 0, complete: true, inState: false, agents: [], tracked: true, transcriptFound: true };
  }
  throw new Error(`unexpected ${method}`);
};

describe('HistoryView', () => {
  it('lists sessions, filters by project and date, and opens a labelled replay of the pixel office', async () => {
    const store = renderHistory(historyRpc);
    const table = await screen.findByRole('table', { name: 'Recorded sessions' });
    expect(within(table).getByText('Fix the tests')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'c:\\work\\app' } });
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-11-17' } });
    await waitFor(() =>
      expect(store.rpc.mock.calls.some((c) => c[0] === 'history.sessions' && (c[1] as Record<string, unknown>).project === 'c:\\work\\app' && (c[1] as Record<string, unknown>).from === dayBounds('2026-11-17', 'start'))).toBe(true),
    );

    fireEvent.click(within(await screen.findByRole('table', { name: 'Recorded sessions' })).getByText('Fix the tests'));
    expect(await screen.findByText('Replay · movement reconstructed')).toBeTruthy();
    const office = screen.getByTestId('office');
    expect(office.getAttribute('data-idle-life')).toBe('false');
    expect(office.getAttribute('data-edit')).toBe('false');
    expect(office.getAttribute('data-workers')).toBe('1'); // at the start only the session exists
    // working [1s,6s) + [9m,9m0.5s); waiting for permission [6s,9s); idle [0,1s) + [9s,9m); failed until the end
    expect(screen.getByLabelText('Session summary').textContent).toBe('1 task completed, 1 tool error, 1 failed turn. Main agent working 6s, waiting 3s, idle 8m 52s over 10m 0s.');

    // Step through events: the event list and the office follow the replay clock.
    for (let i = 0; i < 6; i++) fireEvent.click(screen.getByLabelText('Next event'));
    const list = screen.getByRole('list', { name: 'Events at the selected time' });
    expect(within(list).getByText('Explore started')).toBeTruthy();
    expect(screen.getByTestId('office').getAttribute('data-workers')).toBe('2');
    expect(screen.getByRole('table', { name: 'Session tasks' }).textContent).toContain('Fix it');
    expect(screen.getByRole('table', { name: 'Session tools' }).textContent).toContain('Bash');
    expect(await screen.findByText('1.50k')).toBeTruthy(); // historical usage (transcript-observed)

    fireEvent.change(screen.getByLabelText('Replay speed'), { target: { value: '16' } });
    expect((screen.getByLabelText('Replay speed') as HTMLSelectElement).value).toBe('16');
    fireEvent.click(screen.getByLabelText('Play'));
    expect(screen.getByLabelText('Pause')).toBeTruthy();
    expect(screen.getByText('Replay · movement reconstructed')).toBeTruthy(); // always visible while playing
    fireEvent.click(screen.getByLabelText('Pause'));
  });

  it('shows empty, error and disconnected states', async () => {
    renderHistory(async (m) => (m === 'history.sessions' ? { sessions: [], total: 0, projects: [] } : null));
    expect(await screen.findByText(/No sessions recorded yet/)).toBeTruthy();
    cleanup();

    renderHistory(async () => {
      throw new Error('unknown method history.sessions');
    });
    expect(await screen.findByText(/History unavailable: unknown method history.sessions/)).toBeTruthy();
    cleanup();

    const store = renderHistory(historyRpc, 'reconnecting');
    expect(await screen.findByText(/History unavailable: Not connected to the monitor/)).toBeTruthy();
    expect(store.rpc).not.toHaveBeenCalled();
  });

  it('reports events that cannot be loaded for a session', async () => {
    renderHistory(async (m, p) => (m === 'history.events' ? Promise.reject(new Error('disk error')) : historyRpc(m, p)));
    fireEvent.click(within(await screen.findByRole('table', { name: 'Recorded sessions' })).getByText('Fix the tests'));
    expect(await screen.findByText(/Events unavailable: disk error/)).toBeTruthy();
    expect(screen.queryByTestId('office')).toBeNull();
  });

  it('converts date inputs to local day bounds', () => {
    const start = dayBounds('2026-11-17', 'start')!;
    const end = dayBounds('2026-11-17', 'end')!;
    expect(new Date(start).getHours()).toBe(0);
    expect(end - start).toBe(86_400_000 - 1);
    expect(dayBounds('', 'start')).toBeUndefined();
    expect(dayBounds('17/11/2026', 'start')).toBeUndefined();
  });
});
