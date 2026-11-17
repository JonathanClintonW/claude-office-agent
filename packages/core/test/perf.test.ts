// Reducer throughput and memory-cap checks. Thresholds are deliberately generous
// (a slow CI box must pass); the printed measurements are what docs/VALIDATION.md records.
import { describe, expect, it } from 'vitest';
import { normalizeHookPayload, systemEvent, type MonitorEvent } from '../src/events';
import { createInitialState, DEFAULT_REDUCER_OPTIONS, reduce, TERMINAL_STATUSES, type OfficeState } from '../src/state';

// packages/core compiles without DOM or Node types (it runs in both); declare what this test uses.
declare const performance: { now(): number };
declare const console: { log(...args: unknown[]): void };
declare const process: { memoryUsage(): { heapUsed: number } };

const T0 = Date.now() - 3 * 3600_000;
const O = DEFAULT_REDUCER_OPTIONS;

function payload(session: string, event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: session, cwd: `c:\\work\\proj-${session.slice(-3)}`, transcript_path: `c:\\t\\${session}.jsonl`, permission_mode: 'default', hook_event_name: event, ...extra };
}

/**
 * Realistic hook payloads for one session: tools, failures, permission prompts, subagents
 * (spawned through the Agent tool), tasks, then Stop and (for even sessions) SessionEnd.
 */
function sessionScript(i: number, mainTools: number, subTools: number): Record<string, unknown>[] {
  const s = `perf-session-${String(i).padStart(4, '0')}`;
  const out: Record<string, unknown>[] = [];
  out.push(payload(s, 'SessionStart', { source: 'startup', model: 'claude-opus-5-5' }));
  out.push(payload(s, 'UserPromptSubmit', { prompt: '[dropped]' }));
  for (let sub = 0; sub < 2; sub++) {
    const ag = { agent_id: `sub-${i}-${sub}`, agent_type: sub ? 'Plan' : 'Explore' };
    out.push(payload(s, 'PreToolUse', { tool_name: 'Agent', tool_use_id: `spawn-${i}-${sub}`, tool_input: { description: 'explore', subagent_type: ag.agent_type } }));
    out.push(payload(s, 'SubagentStart', ag));
    for (let t = 0; t < subTools; t++) {
      const id = `st-${i}-${sub}-${t}`;
      out.push(payload(s, 'PreToolUse', { ...ag, tool_name: 'Read', tool_use_id: id, tool_input: { file_path: `c:\\work\\f${t}.ts` } }));
      out.push(payload(s, 'PostToolUse', { ...ag, tool_name: 'Read', tool_use_id: id, tool_input: {}, tool_response: { success: true }, duration_ms: 12 }));
    }
    out.push(payload(s, 'SubagentStop', { ...ag, last_assistant_message: 'done' }));
    out.push(payload(s, 'PostToolUse', { tool_name: 'Agent', tool_use_id: `spawn-${i}-${sub}`, tool_input: {}, tool_response: {} }));
  }
  for (let k = 0; k < 4; k++) out.push(payload(s, 'TaskCreated', { task_id: `${k}`, task_subject: `Task ${k}` }));
  for (let t = 0; t < mainTools; t++) {
    const id = `t-${i}-${t}`;
    const name = t % 3 === 0 ? 'Bash' : t % 3 === 1 ? 'Edit' : 'Grep';
    const input = name === 'Bash' ? { command: `npm test -- ${t}`, description: 'Run tests' } : name === 'Edit' ? { file_path: `c:\\work\\src\\m${t}.ts` } : { pattern: `foo${t}` };
    out.push(payload(s, 'PreToolUse', { tool_name: name, tool_use_id: id, tool_input: input }));
    if (t % 10 === 5) {
      out.push(payload(s, 'PermissionRequest', { tool_name: name, tool_input: input }));
      out.push(payload(s, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }));
    }
    if (t % 17 === 3) out.push(payload(s, 'PostToolUseFailure', { tool_name: name, tool_use_id: id, tool_input: {}, error: 'Exit code 1', duration_ms: 40 }));
    else out.push(payload(s, 'PostToolUse', { tool_name: name, tool_use_id: id, tool_input: {}, tool_response: { success: true }, duration_ms: 25 }));
  }
  for (let k = 0; k < 4; k++) out.push(payload(s, 'TaskCompleted', { task_id: `${k}`, task_subject: `Task ${k}` }));
  out.push(payload(s, 'Stop', { last_assistant_message: 'Finished the change.' }));
  if (i % 2 === 0) out.push(payload(s, 'SessionEnd', { reason: 'other' }));
  return out;
}

/** Round-robin across sessions so all of them are live at the same time. */
function workload(sessions: number, mainTools: number, subTools: number): MonitorEvent[] {
  const queues = Array.from({ length: sessions }, (_, i) => sessionScript(i, mainTools, subTools));
  const raw: Record<string, unknown>[] = [];
  for (let step = 0, left = true; left; step++) {
    left = false;
    for (const q of queues) {
      const p = q[step];
      if (p) {
        raw.push(p);
        left = true;
      }
    }
  }
  return raw.map((p, i) => {
    const r = normalizeHookPayload(p, T0 + i * 10);
    if (!r.ok) throw new Error(r.error);
    return { ...r.event, seq: i + 1 };
  });
}

function run(events: MonitorEvent[], chunk = 10_000): { state: OfficeState; ms: number; chunkMs: number[] } {
  let state = createInitialState();
  const chunkMs: number[] = [];
  const t0 = performance.now();
  let c0 = t0;
  for (let i = 0; i < events.length; i++) {
    state = reduce(state, events[i]!);
    if ((i + 1) % chunk === 0) {
      const t = performance.now();
      chunkMs.push(Math.round(t - c0));
      c0 = t;
    }
  }
  return { state, ms: performance.now() - t0, chunkMs };
}

const tick = (state: OfficeState, ts: number) => reduce(state, { ...systemEvent({ kind: 'Tick' }, { ts, sessionId: '*' }), seq: state.lastSeq + 1 });

describe('core reducer performance', () => {
  it('reduces ~50k events across 50 concurrent sessions (150 agents) quickly; history stays capped', () => {
    const n0 = performance.now();
    const events = workload(50, 450, 20);
    const normalizeMs = performance.now() - n0;
    expect(events.length).toBeGreaterThan(48_000);

    const heapBefore = process.memoryUsage().heapUsed;
    const { state, ms, chunkMs } = run(events);
    const heapAfter = process.memoryUsage().heapUsed;
    const agents = Object.values(state.agents);
    const m = {
      events: events.length,
      agents: agents.length,
      normalizeMs: Math.round(normalizeMs),
      reduceMs: Math.round(ms),
      eventsPerSec: Math.round(events.length / (ms / 1000)),
      usPerEvent: Math.round((ms / events.length) * 1000),
      chunkMs,
      maxToolsPerAgent: Math.max(...agents.map((a) => a.tools.length)),
      log: state.log.length,
      notices: state.notices.length,
      maxSpawnsPerSession: Math.max(0, ...Object.values(state.spawns).map((l) => l.length)),
      snapshotKB: Math.round(JSON.stringify(state).length / 1024),
      heapDeltaMB: Math.round((heapAfter - heapBefore) / 1048576),
    };
    console.log(`[perf:core] throughput ${JSON.stringify(m)}`);

    // Generous floor: a regression to per-event full-history copies would drop far below it.
    expect(m.eventsPerSec).toBeGreaterThan(2_000);
    // Per-event cost must not keep growing with history (all history structures are capped).
    expect(chunkMs[chunkMs.length - 1]!).toBeLessThan(Math.max(chunkMs[0]! * 4, 400));
    expect(m.maxToolsPerAgent).toBeLessThanOrEqual(O.maxToolsPerAgent);
    expect(m.log).toBeLessThanOrEqual(O.maxLog);
    expect(m.notices).toBeLessThanOrEqual(O.maxNotices);
    expect(m.maxSpawnsPerSession).toBeLessThanOrEqual(20);
  }, 60_000);

  it('caps the agent table at Tick and prunes ended agents (and their tasks) after the window', () => {
    // 250 sessions × (1 session + 2 subagents) = 750 agents, well over maxAgents (400).
    const events = workload(250, 12, 3);
    const { state, ms } = run(events);
    const agents = Object.values(state.agents);
    const last = T0 + events.length * 10;
    const t0 = performance.now();
    const capped = tick(state, last + 1);
    const tickMs = performance.now() - t0;
    const pruned = tick(capped, last + O.pruneAfterMs + 60_000);
    const m = {
      events: events.length,
      usPerEventAt750Agents: Math.round((ms / events.length) * 1000),
      agentsBefore: agents.length,
      agentsAfterCapTick: Object.keys(capped.agents).length,
      agentsAfterPruneTick: Object.keys(pruned.agents).length,
      tasksBefore: Object.keys(capped.tasks).length,
      tasksAfterPrune: Object.keys(pruned.tasks).length,
      tickMs: Math.round(tickMs * 10) / 10,
    };
    console.log(`[perf:core] caps ${JSON.stringify(m)}`);

    expect(m.agentsBefore).toBeGreaterThan(O.maxAgents); // the workload really exceeds the cap…
    expect(m.agentsAfterCapTick).toBeLessThanOrEqual(O.maxAgents); // …and Tick brings it back under
    for (const a of agents) if (!TERMINAL_STATUSES.has(a.status)) expect(capped.agents[a.key]).toBeDefined(); // live agents are never dropped
    expect(Object.values(pruned.agents).every((a) => !TERMINAL_STATUSES.has(a.status))).toBe(true);
    const liveSessions = new Set(Object.values(pruned.agents).map((a) => a.sessionId));
    expect(Object.values(pruned.tasks).every((t) => liveSessions.has(t.sessionId))).toBe(true);
    expect(m.tasksAfterPrune).toBeLessThan(m.tasksBefore);
    expect(tickMs).toBeLessThan(500);
  }, 60_000);

  it('per-event cost on a full state (log, notices, tool history at their caps) by agent count', () => {
    const costs: Record<string, number> = {};
    for (const n of [50, 200, 400]) {
      let state = createInitialState();
      let seq = 0;
      const ap = (p: Record<string, unknown>) => {
        const r = normalizeHookPayload(p, T0 + seq);
        if (!r.ok) throw new Error(r.error);
        state = reduce(state, { ...r.event, seq: ++seq });
      };
      for (let i = 0; i < n; i++) ap(payload(`big-${i}`, 'SessionStart', { source: 'startup' }));
      // Fill one agent's tool history, the global log and the notices to their caps.
      for (let t = 0; t < O.maxLog; t++) {
        ap(payload('big-0', 'PreToolUse', { tool_name: 'Bash', tool_use_id: `b-${t}`, tool_input: { command: 'x' } }));
        if (t < O.maxNotices + 10) ap(payload('big-0', 'PostToolUseFailure', { tool_name: 'Bash', tool_use_id: `b-${t}`, tool_input: {}, error: 'boom' }));
      }
      expect(state.log.length).toBe(O.maxLog);
      expect(state.notices.length).toBe(O.maxNotices);
      const probe = normalizeHookPayload(payload('big-0', 'PreToolUse', { tool_name: 'Read', tool_use_id: 'probe', tool_input: { file_path: 'x' } }), T0 + seq);
      if (!probe.ok) throw new Error(probe.error);
      const N = 1_000;
      let out = state;
      const t0 = performance.now();
      for (let k = 0; k < N; k++) out = reduce(state, { ...probe.event, seq: seq + 1 });
      costs[`${n}agents`] = Math.round(((performance.now() - t0) / N) * 1000);
      expect(out.agents['big-0']!.currentToolId).toBe('probe');
      expect(out.agents['big-0']!.tools.length).toBeLessThanOrEqual(O.maxToolsPerAgent);
    }
    console.log(`[perf:core] µs per event on a full state: ${JSON.stringify(costs)}`);
    expect(costs['400agents']!).toBeLessThan(5_000);
  }, 60_000);
});
