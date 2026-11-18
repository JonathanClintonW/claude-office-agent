import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInitialState,
  defaultLayout,
  normalizeHookPayload,
  reduce,
  systemEvent,
  type HistoryEventsResult,
  type HistorySessionsResult,
  type HistorySummary,
  type MonitorEvent,
  type OfficeState,
} from '@agent-office/core';
import { loadOrCreateConfig } from '../src/config';
import type { PluginContext } from '../src/plugin';
import { dayOf, historyPlugin, journalRecord, type HistoryPlugin, type HistoryPluginOptions } from '../src/plugins/history';
import { createMonitor } from '../src/server';
import { freePort, tempDir } from './helpers';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-17T09:00:00.000Z');

describe('history plugin', () => {
  let home: ReturnType<typeof tempDir>;
  let state: OfficeState;
  let seq: number;
  let clock: number;
  let plugin: HistoryPlugin | undefined;

  const ctx = (): PluginContext => ({ home: home.path, claudeDirs: [], now: () => clock, log: () => {}, getState: () => state, getLayout: defaultLayout });

  async function start(o: HistoryPluginOptions = {}): Promise<HistoryPlugin> {
    plugin = historyPlugin({ autoTimers: false, ...o });
    await plugin.start!(ctx());
    await plugin.ready();
    return plugin;
  }

  /** Apply an event the way the monitor does: sequence, reduce, then notify the plugin. */
  function apply(ev: MonitorEvent): MonitorEvent {
    const sequenced = { ...ev, seq: ++seq } as MonitorEvent;
    state = reduce(state, sequenced);
    plugin?.onEvent!(sequenced, state);
    return sequenced;
  }

  function hook(name: string, ts: number, extra: Record<string, unknown> = {}, sessionId = 's1'): MonitorEvent {
    const r = normalizeHookPayload({ session_id: sessionId, cwd: 'c:\\work\\app', transcript_path: 'c:\\t\\s1.jsonl', hook_event_name: name, ...extra }, ts);
    if (!r.ok) throw new Error(r.error);
    return apply(r.event);
  }

  function scenario(sessionId = 's1', t = T0, cwd = 'c:\\work\\app'): void {
    hook('SessionStart', t, { source: 'startup', model: 'claude-test-1', session_title: 'Fix the tests', cwd }, sessionId);
    hook('UserPromptSubmit', t + 100, { prompt: 'SECRET-PROMPT', cwd }, sessionId);
    hook('PreToolUse', t + 200, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' }, cwd }, sessionId);
    hook('PostToolUseFailure', t + 900, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {}, error: 'E'.repeat(390), cwd }, sessionId);
    hook('PreToolUse', t + 1000, { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { subagent_type: 'Explore', description: 'Find tests' }, cwd }, sessionId);
    hook('SubagentStart', t + 1100, { agent_id: 'ex1', agent_type: 'Explore', cwd }, sessionId);
    hook('TaskCreated', t + 1200, { task_id: '1', task_subject: 'Fix failing test', task_description: 'PRIVATE-DESC', cwd }, sessionId);
    hook('TaskCreated', t + 1300, { task_id: '1', task_subject: 'Fix failing test', cwd }, sessionId); // late duplicate
    hook('TaskCompleted', t + 1400, { task_id: '1', cwd }, sessionId);
    hook('SubagentStop', t + 1500, { agent_id: 'ex1', last_assistant_message: 'SECRET-ANSWER', cwd }, sessionId);
    hook('PermissionRequest', t + 1600, { tool_name: 'Edit', tool_input: { file_path: 'c:\\work\\app\\a.ts' }, cwd }, sessionId);
    hook('Stop', t + 1700, { last_assistant_message: 'SECRET-ANSWER-2', cwd }, sessionId);
    apply(systemEvent({ kind: 'Tick' }, { ts: t + 1800, sessionId: '*' }));
    hook('StopFailure', t + 1900, { error: 'rate_limit', cwd }, sessionId);
  }

  const sessions = async (params: Record<string, unknown> = {}) => (await plugin!.routes!.sessions!(params)) as HistorySessionsResult;
  const events = async (params: Record<string, unknown>) => (await plugin!.routes!.events!(params)) as HistoryEventsResult;
  const dayFile = (day: string) => join(home.path, 'history', `${day}.jsonl`);
  const lines = (day: string) => readFileSync(dayFile(day), 'utf8').split('\n').filter(Boolean);

  beforeEach(() => {
    home = tempDir('history');
    state = createInitialState();
    seq = 0;
    clock = T0 + 5000;
    plugin = undefined;
  });
  afterEach(async () => {
    await plugin?.stop?.();
    home.cleanup();
  });

  it('buffers events in onEvent and appends them per UTC day on flush, without Tick or message text', async () => {
    await start();
    scenario();
    const day = dayOf(clock);
    expect(existsSync(dayFile(day))).toBe(false); // nothing written synchronously
    await plugin!.flush();
    const written = lines(day).map((l) => JSON.parse(l) as MonitorEvent);
    expect(written).toHaveLength(13); // 14 applied, Tick skipped
    expect(written.map((e) => e.seq)).toEqual(written.map((_, i) => (i < 12 ? i + 1 : i + 2)));
    const raw = readFileSync(dayFile(day), 'utf8');
    expect(raw).not.toMatch(/SECRET-PROMPT|SECRET-ANSWER|PRIVATE-DESC|transcriptPath|s1\.jsonl/);
    const failure = written.find((e) => e.kind === 'PostToolUseFailure') as Extract<MonitorEvent, { kind: 'PostToolUseFailure' }>;
    expect(failure.error!.length).toBeLessThanOrEqual(200);
    expect(written.find((e) => e.kind === 'TaskCreated')).toMatchObject({ subject: 'Fix failing test' });
  });

  it('keeps a session index with counts, project, title and end state', async () => {
    await start();
    scenario();
    hook('SessionEnd', T0 + 2500, { reason: 'other' });
    const r = await sessions();
    expect(r.total).toBe(1);
    expect(r.sessions[0]).toMatchObject({
      sessionId: 's1',
      firstTs: T0,
      lastTs: T0 + 2500,
      cwd: 'c:\\work\\app',
      project: 'app',
      projectKey: 'c:\\work\\app',
      title: 'Fix the tests',
      model: 'claude-test-1',
      ended: true,
      endedAt: T0 + 2500,
      events: 14,
      agents: 2,
      tasks: 1,
      tasksCompleted: 1,
      toolCalls: 2,
      toolFailures: 1,
      toolInterrupts: 0,
      permissionRequests: 1,
      turns: 1,
      turnFailures: 1,
      days: [dayOf(clock)],
    });
    expect(r.projects).toEqual([{ key: 'c:\\work\\app', label: 'app', count: 1 }]);
    expect(plugin!.meta!()).toMatchObject({ sessions: 1, bufferedEvents: 14, retentionDays: 14 });
  });

  it('filters sessions by project and by date range', async () => {
    await start();
    scenario('s1', T0, 'c:\\work\\app');
    scenario('s2', T0 + 3 * 3600_000, 'c:\\work\\other');
    expect((await sessions()).sessions.map((s) => s.sessionId)).toEqual(['s2', 's1']);
    expect((await sessions({ project: 'C:/work/other' })).sessions.map((s) => s.sessionId)).toEqual(['s2']);
    expect((await sessions({ project: 'app' })).sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect((await sessions({ from: T0 + 3600_000 })).sessions.map((s) => s.sessionId)).toEqual(['s2']);
    expect((await sessions({ to: T0 + 3600_000 })).sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect((await sessions({ limit: 1 }))).toMatchObject({ total: 2 });
    expect((await sessions({ limit: 1 })).sessions).toHaveLength(1);
    expect((await sessions({ from: 'yesterday', project: 42 })).total).toBe(2); // invalid filters are ignored
  });

  it('pages a session\'s events with a cursor, filters by time and includes monitor restarts', async () => {
    await start();
    scenario('s1');
    scenario('s2', T0 + 10);
    apply(systemEvent({ kind: 'Restored' }, { ts: T0 + 1750, sessionId: '*' }));
    const all: MonitorEvent[] = [];
    let cursor: number | undefined = 0;
    let pages = 0;
    while (cursor !== undefined) {
      const page = await events({ sessionId: 's1', limit: 5, cursor });
      all.push(...page.events);
      expect(page.total).toBe(14);
      cursor = page.nextCursor;
      pages += 1;
      if (page.done) break;
    }
    expect(pages).toBe(3);
    expect(all.filter((e) => e.sessionId === 's1')).toHaveLength(13);
    expect(all.filter((e) => e.kind === 'Restored')).toHaveLength(1);
    expect(all.map((e) => e.seq)).toEqual([...all.map((e) => e.seq)].sort((a, b) => a - b));
    const ranged = await events({ sessionId: 's1', from: T0 + 1000, to: T0 + 1400, limit: 100 });
    expect(ranged.events.map((e) => e.kind)).toEqual(['PreToolUse', 'SubagentStart', 'TaskCreated', 'TaskCreated', 'TaskCompleted']);
    expect(ranged.done).toBe(true);
    expect((await events({ sessionId: 'nope' })).events).toEqual([]);
    await expect(events({ sessionId: '' })).rejects.toThrow('invalid sessionId');
    const big = await events({ sessionId: 's1', limit: 1e9 });
    expect(big.events).toHaveLength(14);
  });

  it('persists the index on stop and rebuilds it from the journal when missing or stale', async () => {
    await start();
    scenario();
    await plugin!.stop!();
    const indexFile = join(home.path, 'history', 'index.json');
    expect(existsSync(indexFile)).toBe(true);
    const saved = (await (async () => {
      await start();
      return sessions();
    })()).sessions[0];
    expect(saved).toMatchObject({ sessionId: 's1', events: 13, toolCalls: 2, tasks: 1, agents: 2 });
    await plugin!.stop!();

    rmSync(indexFile);
    await start();
    const rebuilt = (await sessions()).sessions[0]!;
    expect(rebuilt).toMatchObject({ sessionId: 's1', events: 13, toolCalls: 2, toolFailures: 1, tasks: 1, tasksCompleted: 1, agents: 2, title: 'Fix the tests', project: 'app' });
    // Events keep flowing after a rebuild.
    hook('UserPromptSubmit', T0 + 3000);
    expect((await sessions()).sessions[0]!.events).toBe(14);
  });

  it('applies retention by age (default 14 days) and by total size, never deleting today', async () => {
    const dir = join(home.path, 'history');
    mkdirSync(dir, { recursive: true });
    const old = (n: number) => dayOf(clock - n * DAY);
    const line = (sessionId: string, ts: number) => JSON.stringify({ seq: 1, ts, source: 'hook', sessionId, kind: 'UserPromptSubmit' }) + '\n';
    writeFileSync(join(dir, `${old(20)}.jsonl`), line('ancient', clock - 20 * DAY));
    writeFileSync(join(dir, `${old(14)}.jsonl`), line('expired', clock - 14 * DAY));
    writeFileSync(join(dir, `${old(13)}.jsonl`), line('kept', clock - 13 * DAY).repeat(50));
    writeFileSync(join(dir, `${old(1)}.jsonl`), line('recent', clock - DAY).repeat(50));
    writeFileSync(join(dir, 'notes.txt'), 'not a journal file');
    await start();
    const files = () => readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    expect(files()).toEqual([`${old(13)}.jsonl`, `${old(1)}.jsonl`]);
    expect((await sessions()).sessions.map((s) => s.sessionId).sort()).toEqual(['kept', 'recent']);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    await plugin!.stop!();

    // Size cap: the oldest files go first; today's file is kept even when it alone is large.
    const size = readFileSync(join(dir, `${old(1)}.jsonl`)).length;
    await start({ maxTotalBytes: size + 10 });
    expect(files()).toEqual([`${old(1)}.jsonl`]);
    scenario('today', clock);
    await plugin!.flush();
    expect(files()).toEqual([`${dayOf(clock)}.jsonl`]);
    const summary = (await plugin!.routes!.summary!({})) as HistorySummary;
    expect(summary.days.map((d) => d.day)).toEqual([dayOf(clock)]);
    expect(summary.maxTotalBytes).toBe(size + 10);
    await plugin!.stop!();

    // Day rollover triggers the daily cleanup on the next flush.
    await start({ retentionDays: 1 });
    clock += DAY;
    hook('UserPromptSubmit', clock, {}, 'tomorrow');
    await plugin!.flush();
    expect(files()).toEqual([`${dayOf(clock)}.jsonl`]);
    const left = await sessions();
    expect(left.sessions.map((s) => s.sessionId)).toEqual(['tomorrow']);
  });

  it('marks sessions whose older days were removed as partial', async () => {
    await start();
    scenario('long', T0);
    await plugin!.flush();
    clock += 2 * DAY;
    hook('UserPromptSubmit', clock, {}, 'long');
    await plugin!.flush();
    await plugin!.stop!();
    await start({ retentionDays: 1 });
    const s = (await sessions()).sessions[0]!;
    expect(s).toMatchObject({ sessionId: 'long', partial: true, days: [dayOf(clock)] });
  });

  it('does not merge new records into a torn last line left by a crash', async () => {
    const dir = join(home.path, 'history');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${dayOf(clock)}.jsonl`), '{"seq":1,"ts":1,"sessionId":"s1","kind":"Sessi');
    await start();
    scenario();
    const page = await events({ sessionId: 's1' });
    expect(page.events).toHaveLength(13);
  });

  it('flushes buffered events on stop and drops (and counts) events beyond the buffer cap', async () => {
    await start({ maxBufferedEvents: 5 });
    scenario();
    expect(plugin!.meta!()).toMatchObject({ bufferedEvents: 5, droppedEvents: 8 });
    await plugin!.stop!();
    expect(lines(dayOf(clock))).toHaveLength(5);
    plugin = undefined;
  });

  it('journal records drop message text and paths', () => {
    const ev = { seq: 3, ts: 1, source: 'hook', sessionId: 's', transcriptPath: 'c:\\t\\s.jsonl', kind: 'Stop', lastMessage: 'hello' } as MonitorEvent;
    expect(journalRecord(ev)).toEqual({ seq: 3, ts: 1, source: 'hook', sessionId: 's', kind: 'Stop' });
    expect(ev).toHaveProperty('lastMessage'); // the live event is not mutated
  });

  it('serves history routes through the monitor and flushes on monitor stop', async () => {
    const port = await freePort();
    const token = loadOrCreateConfig(home.path, { port }).token;
    const monitor = createMonitor({ home: home.path, port, token, claudeDirs: [home.path], discovery: false, persist: false, plugins: [historyPlugin()], tickIntervalMs: 3_600_000 });
    await monitor.start();
    const now = Date.now();
    monitor.ingestHook({ session_id: 'live-1', hook_event_name: 'SessionStart', cwd: 'c:\\work\\app' }, now);
    monitor.ingestHook({ session_id: 'live-1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'a.ts' } }, now + 1);
    try {
      const s = (await monitor.rpc('history.sessions', {})) as HistorySessionsResult;
      expect(s.sessions[0]).toMatchObject({ sessionId: 'live-1', toolCalls: 1, events: 2 });
      const e = (await monitor.rpc('history.events', { sessionId: 'live-1' })) as HistoryEventsResult;
      expect(e.events.map((x) => x.kind)).toEqual(['SessionStart', 'PreToolUse']);
      const sum = (await monitor.rpc('history.summary')) as HistorySummary;
      expect(sum).toMatchObject({ sessions: 1, events: 2, retentionDays: 14, totals: { toolCalls: 1 } });
      expect(monitor.getMeta().plugins?.history).toMatchObject({ sessions: 1 });
      monitor.ingestHook({ session_id: 'live-1', hook_event_name: 'Stop' }, now + 2);
    } finally {
      await monitor.stop();
    }
    const file = join(home.path, 'history', `${dayOf(Date.now())}.jsonl`);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(existsSync(join(home.path, 'history', 'index.json'))).toBe(true);
  });
});
