import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInitialState,
  DEFAULT_REDUCER_OPTIONS,
  defaultLayout,
  normalizeHookPayload,
  reduce,
  type MonitorEvent,
  type OfficeState,
  type UsageSummary,
} from '@agent-office/core';
import {
  computeSessionMetrics,
  durationStats,
  formatMoney,
  formatTokens,
  normalizeError,
  stateMetrics,
  summarize,
  trackedOf,
} from '../src/analytics';
import { StoreContext } from '../src/hooks';
import type { OfficeStore, StoreSnapshot } from '../src/store';
import type { HostInfo } from '../src/transport';
import { AnalyticsView } from '../src/views/AnalyticsView';

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
    ev('SessionStart', T, { source: 'startup' }),
    ev('UserPromptSubmit', T + 1000, { prompt: 'never kept' }),
    ev('PreToolUse', T + 2000, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } }),
    ev('PostToolUseFailure', T + 3000, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {}, error: 'Exit code 1\nlots of output' }),
    ev('PreToolUse', T + 4000, { tool_name: 'Bash', tool_use_id: 'b2', tool_input: { command: 'npm test' } }),
    ev('PostToolUseFailure', T + 5000, { tool_name: 'Bash', tool_use_id: 'b2', tool_input: {}, error: 'Exit code 2' }),
    ev('PreToolUse', T + 6000, { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'a.ts' } }),
    ev('PostToolUse', T + 6500, { tool_name: 'Read', tool_use_id: 'r1', tool_input: {}, duration_ms: 250 }),
    ev('PreToolUse', T + 7000, { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'a.ts' } }),
    ev('PermissionRequest', T + 7500, { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }),
    ev('SubagentStart', T + 8000, { agent_id: 'ex1', agent_type: 'Explore' }),
    ev('SubagentStop', T + 9000, { agent_id: 'ex1' }),
    ev('PostToolUse', T + 10_000, { tool_name: 'Edit', tool_use_id: 'e1', tool_input: {} }),
    ev('TaskCreated', T + 11_000, { task_id: '1', task_subject: 'Fix the test' }),
    ev('TaskCompleted', T + 14_000, { task_id: '1' }),
    ev('TaskCreated', T + 15_000, { task_id: '2', task_subject: 'Write docs' }),
    ev('Stop', T + 20_000, {}),
    ev('SessionEnd', T + 30_000, { reason: 'other' }),
  ];
}

describe('computeSessionMetrics', () => {
  it('derives status time from replayed status transitions and counts observed events', () => {
    const m = computeSessionMetrics(scenario(), { sessionId: 's1' });
    expect(m).toMatchObject({ sessionId: 's1', firstTs: T, lastTs: T + 30_000, durationMs: 30_000, ended: true, eventCount: 18 });
    // idle [0,1s) + [20s,30s); working [1s,7.5s) + [10s,20s); waiting for permission [7.5s,10s)
    expect(m.main).toEqual({ working: 16_500, waitingPermission: 2500, waitingInput: 0, idle: 11_000, failed: 0, unknown: 0 });
    expect(trackedOf(m.main)).toBe(m.durationMs);
    // agent-time adds the subagent's second of work
    expect(m.allAgents.working).toBe(17_500);
    expect(m.byAgent.map((a) => a.kind)).toEqual(['session', 'subagent']);
    expect(m.turns).toEqual({ prompts: 1, completed: 1, failed: 0 });
  });

  it('counts tool calls, outcomes and durations (reported first, then observed)', () => {
    const m = computeSessionMetrics(scenario(), { sessionId: 's1' });
    expect(m.tools).toMatchObject({ calls: 4, succeeded: 2, errors: 2, interrupted: 0, denied: 0, unresolved: 0, permissionRequests: 1, errorRate: 0.5 });
    expect(m.tools.durations).toMatchObject({ count: 4, medianMs: 1000, maxMs: 3000, totalMs: 5250 });
    const bash = m.tools.byName.find((t) => t.name === 'Bash')!;
    expect(bash).toMatchObject({ calls: 2, failed: 2, totalMs: 2000 });
    expect(m.tools.byName.find((t) => t.name === 'Read')).toMatchObject({ totalMs: 250, timedCalls: 1 });
    expect(m.activity.byTool[0]).toMatchObject({ name: 'Bash', calls: 2, share: 0.5 });
    expect(m.activity.buckets.reduce((n, b) => n + b.events, 0)).toBe(m.eventCount);
    expect(m.activity.buckets.reduce((n, b) => n + b.toolCalls, 0)).toBe(4);
    expect(m.activity.buckets.reduce((n, b) => n + b.errors, 0)).toBe(2);
  });

  it('groups repeated errors ignoring numbers and reports tasks with the board\'s semantics', () => {
    const m = computeSessionMetrics(scenario(), { sessionId: 's1' });
    expect(m.repeatedErrors).toHaveLength(1);
    expect(m.repeatedErrors[0]).toMatchObject({ tool: 'Bash', signature: 'Bash: exit code #', count: 2, sample: 'Exit code 1', firstTs: T + 3000, lastTs: T + 5000 });
    expect(m.tasks).toMatchObject({ total: 2, completed: 1, open: 0, leftOpen: 1 });
    expect(m.tasks.durations).toMatchObject({ count: 1, medianMs: 3000 });
    expect(m.tasks.list.map((t) => [t.subject, t.status, t.durationMs])).toEqual([
      ['Fix the test', 'completed', 3000],
      ['Write docs', 'left_open', undefined],
    ]);
    expect(m.summary).toBe('1 task completed, 1 left open, 2 tool errors (1 repeated). Main agent working 17s, waiting 3s, idle 11s over 30s.');
  });

  it('extends open intervals to `until` for live sessions and never yields negative time for late events', () => {
    const events = [
      ev('SessionStart', T, {}, 'live'),
      ev('UserPromptSubmit', T + 1000, {}, 'live'),
      // an async hook delivered late, with an older timestamp
      ev('PreToolUse', T + 500, { tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'x' } }, 'live'),
    ];
    const m = computeSessionMetrics(events, { sessionId: 'live', until: T + 61_000 });
    expect(m.ended).toBe(false);
    expect(m.durationMs).toBe(61_000);
    expect(m.main.idle).toBe(1000);
    expect(m.main.working).toBe(60_000);
    expect(Object.values(m.main).every((v) => v >= 0)).toBe(true);
    expect(m.tools.unresolved).toBe(1);
    expect(m.tools.errorRate).toBeUndefined();
  });

  it('gives the same result as replaying with the full reducer options (log/notices are output only)', () => {
    const events = scenario();
    expect(computeSessionMetrics(events, { sessionId: 's1' })).toEqual(computeSessionMetrics(events, { sessionId: 's1', reducer: DEFAULT_REDUCER_OPTIONS }));
  });

  it('ignores other sessions and handles an empty event list', () => {
    const mixed = [...scenario(), ev('SessionStart', T + 100, {}, 'other'), ev('PreToolUse', T + 200, { tool_name: 'Bash', tool_use_id: 'x', tool_input: {} }, 'other')];
    expect(computeSessionMetrics(mixed, { sessionId: 's1' }).tools.calls).toBe(4);
    const empty = computeSessionMetrics([]);
    expect(empty).toMatchObject({ durationMs: 0, eventCount: 0, ended: false });
    expect(empty.summary).toBe('No tasks or tool activity recorded.');
  });
});

describe('summaries and helpers', () => {
  it('builds fixed-template sentences', () => {
    expect(summarize({ tasksCompleted: 3, tasksLeftOpen: 1, tasksOpen: 0, toolCalls: 20, toolErrors: 5, turnFailures: 0 })).toBe('3 tasks completed, 1 left open, 5 tool errors.');
    expect(summarize({ tasksCompleted: 0, tasksLeftOpen: 2, tasksOpen: 1, toolCalls: 3, toolErrors: 0, turnFailures: 1 })).toBe('2 tasks left open, 1 still open, 3 tool calls, no tool errors, 1 failed turn.');
    expect(summarize({ tasksCompleted: 1, tasksLeftOpen: 0, tasksOpen: 0, toolCalls: 1, toolErrors: 1, repeatedErrorGroups: 0, turnFailures: 2 })).toBe('1 task completed, 1 tool error, 2 failed turns.');
    expect(summarize({ tasksCompleted: 0, tasksLeftOpen: 0, tasksOpen: 0, toolCalls: 0, toolErrors: 0, turnFailures: 0 })).toBe('No tasks or tool activity recorded.');
  });

  it('normalizes errors, computes duration stats and formats numbers', () => {
    expect(normalizeError('Exit code 127\n  stack...')).toBe('exit code #');
    expect(normalizeError(undefined)).toBe('(no error text)');
    expect(durationStats([3000, 1000, 2000])).toEqual({ count: 3, totalMs: 6000, meanMs: 2000, medianMs: 2000, maxMs: 3000 });
    expect(durationStats([1, 2, 3, 4]).medianMs).toBe(2.5);
    expect(durationStats([])).toEqual({ count: 0, totalMs: 0 });
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1234)).toBe('1.23k');
    expect(formatTokens(45_600)).toBe('45.6k');
    expect(formatTokens(7_250_000)).toBe('7.25M');
    expect(formatMoney(12.5, 'USD')).toBe('USD 12.50');
    expect(formatMoney(0.01234, 'EUR')).toBe('EUR 0.0123');
  });

  it('summarizes the live office state and leaves simulated sessions out', () => {
    let s: OfficeState = createInitialState();
    for (const e of [...scenario(), ev('SessionStart', T, {}, 'sim-demo'), ev('PreToolUse', T + 1, { tool_name: 'Bash', tool_use_id: 'z', tool_input: {} }, 'sim-demo')]) s = reduce(s, e);
    const m = stateMetrics(s);
    expect(m.sessions).toEqual({ total: 1, live: 0, ended: 1 });
    expect(m.toolCalls).toBe(4);
    expect(m.toolFailures).toBe(2);
    expect(m.tasks).toMatchObject({ total: 2, completed: 1, leftOpen: 1, open: 0 });
    expect(m.summary).toBe('1 task completed, 1 left open, 2 tool failures.');
  });
});

const host: HostInfo = { kind: 'browser', workspaceFolders: [], canOpenFiles: false, canFocusClaude: false };

function snapshot(connection: StoreSnapshot['connection'] = 'open', state: OfficeState = createInitialState()): StoreSnapshot {
  return { state, layout: defaultLayout(), connection, synced: true, host, version: 1 };
}

const bucket = (n: number) => ({ inputTokens: n, outputTokens: n * 2, cacheCreationTokens: 0, cacheReadTokens: n * 10, messages: 3 });

function usageSummary(over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    source: 'transcript',
    generatedAt: T,
    total: bucket(1000),
    byModel: [{ model: 'claude-test-1', total: bucket(1000) }],
    byProject: [{ key: 'c:\\work\\app', label: 'app', sessions: 1, total: bucket(1000), reportedSessions: 1, reportedCostUSD: 0.42 }],
    sessions: [
      {
        sessionId: 's1',
        title: 'Fix the tests',
        project: 'app',
        total: bucket(1000),
        byModel: { 'claude-test-1': bucket(1000) },
        subagentTotal: bucket(0),
        subagents: 0,
        complete: true,
        inState: false,
        reported: { source: 'claude-code', totalCostUSD: 0.42 },
      },
    ],
    agents: [{ sessionId: 's1', agent: 'main', kind: 'main', total: bucket(1000), byModel: {} }],
    reported: { source: 'claude-code', sessions: 1, totalCostUSD: 0.42 },
    pricing: { state: 'none', message: 'no price table configured', file: 'pricing.json' },
    scan: { sessionsTracked: 1, filesTracked: 1, backlogBytes: 0, slowFiles: 0, skipped: { noMessageId: 0, unparsableLines: 0, oversizedLines: 0, crossSessionDuplicates: 0 }, resets: 0, lastScanAt: T },
    ...over,
  };
}

function renderView(rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>, snap = snapshot()) {
  const store = { rpc: vi.fn(rpc) } as unknown as OfficeStore;
  render(createElement(StoreContext.Provider, { value: store }, createElement(AnalyticsView, { snap, now: T + 60_000, onSelectAgent: vi.fn() })));
  return store as unknown as { rpc: ReturnType<typeof vi.fn> };
}

const historySummary = { sessions: 2, events: 40, days: [], totalBytes: 2048, retentionDays: 14, maxTotalBytes: 1, bufferedEvents: 0, droppedEvents: 0, writeErrors: 0, totals: { toolCalls: 9, toolFailures: 2, tasks: 3, tasksCompleted: 2, turns: 4, turnFailures: 1 } };

describe('AnalyticsView', () => {
  it('shows loading, then totals with explicit sources and the no-price-table notice', async () => {
    let resolve!: (v: unknown) => void;
    const pending = new Promise((r) => (resolve = r));
    renderView((m) => (m === 'usage.summary' ? pending : Promise.resolve(historySummary)));
    expect(screen.getByText('Loading usage…')).toBeTruthy();
    resolve(usageSummary());
    expect(await screen.findByText(/No price table configured/)).toBeTruthy();
    expect(screen.getAllByText('Transcript-observed').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Reported by Claude Code').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Estimate from your price table').length).toBeGreaterThan(0);
    expect(screen.getAllByText('USD 0.4200').length).toBeGreaterThan(0);
    expect(screen.getByRole('table', { name: 'Usage by session' }).textContent).toContain('Fix the tests');
    expect(screen.getByRole('table', { name: 'Usage by model' }).textContent).toContain('claude-test-1');
    expect(screen.getByRole('table', { name: 'Usage by project' }).textContent).toContain('app');
    expect(await screen.findByText('Sessions recorded')).toBeTruthy();
  });

  it('shows an estimate only when the monitor returns one from the user price table', async () => {
    renderView((m) =>
      Promise.resolve(
        m === 'usage.summary'
          ? usageSummary({
              pricing: { state: 'ok', currency: 'USD', models: 1, file: 'pricing.json', loadedAt: T },
              estimate: { source: 'price-table', currency: 'USD', amount: 3.5, partial: true, unpricedModels: ['other'], unpricedCacheModels: [] },
            })
          : historySummary,
      ),
    );
    expect(await screen.findByText(/≈ USD 3.50/)).toBeTruthy();
    expect(screen.getByText(/API-equivalent estimates, not bills/)).toBeTruthy();
    expect(screen.getAllByText('partial').length).toBeGreaterThan(0);
  });

  it('shows an empty state when nothing was observed and an error state with retry when the RPC fails', async () => {
    renderView((m) => Promise.resolve(m === 'usage.summary' ? usageSummary({ sessions: [], agents: [], byModel: [], byProject: [], reported: null }) : historySummary));
    expect(await screen.findByText(/No token usage observed yet/)).toBeTruthy();
    expect(screen.getByText(/has not recorded a cost/)).toBeTruthy();
    cleanup();

    let fail = true;
    const store = renderView((m) => (m === 'usage.summary' && fail ? Promise.reject(new Error('rpc timed out')) : Promise.resolve(m === 'usage.summary' ? usageSummary() : historySummary)));
    expect(await screen.findByText(/Usage unavailable: rpc timed out/)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getAllByText('Retry')[0]!);
    await waitFor(() => expect(screen.queryByText(/Usage unavailable/)).toBeNull());
    expect(store.rpc.mock.calls.filter((c) => c[0] === 'usage.summary').length).toBeGreaterThanOrEqual(2);
  });

  it('does not call the monitor while disconnected and still shows office activity', async () => {
    const store = renderView(() => Promise.resolve(usageSummary()), snapshot('closed'));
    expect(await screen.findByText(/Usage unavailable: Not connected to the monitor/)).toBeTruthy();
    expect(store.rpc).not.toHaveBeenCalled();
    expect(screen.getByText('No tasks or tool activity recorded.')).toBeTruthy();
  });

  it('asks the monitor for a fresh scan on Refresh', async () => {
    const store = renderView((m) => Promise.resolve(m === 'usage.summary' ? usageSummary() : historySummary));
    await screen.findByRole('table', { name: 'Usage by session' });
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(store.rpc.mock.calls.some((c) => c[0] === 'usage.summary' && (c[1] as Record<string, unknown>).refresh === true)).toBe(true));
  });
});
