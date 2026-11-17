// UI-side hot paths with ~300 agents / ~200 actors. Thresholds are generous;
// the printed measurements are recorded in docs/VALIDATION.md.
import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  defaultLayout,
  normalizeHookPayload,
  reduce,
  type ClientMessage,
  type MonitorEvent,
  type MonitorMeta,
  type OfficeState,
  type ServerMessage,
} from '@agent-office/core';
import type { Actor, BehaviorProvider, Directive, World } from '../src/office/behavior';
import { IdleDirector } from '../src/office/idleLife';
import { OfficeStore } from '../src/store';
import type { HostInfo, Transport, TransportHandlers } from '../src/transport';
import { filterAgents, toWorkerViews, workspaceOptions } from '../src/view';

const META: MonitorMeta = { protocol: 1, monitorVersion: 'perf', startedAt: 0, claudeDirs: [], rejectedEvents: 0, spooledEventsReplayed: 0 };

class FakeTransport implements Transport {
  host: HostInfo = { kind: 'browser', workspaceFolders: [], canOpenFiles: false, canFocusClaude: false };
  sent: ClientMessage[] = [];
  h?: TransportHandlers;
  connect(h: TransportHandlers) {
    this.h = h;
  }
  send(m: ClientMessage) {
    this.sent.push(m);
  }
  emit(m: ServerMessage) {
    this.h!.onMessage(m);
  }
  openTranscript() {}
  focusClaude() {}
  installHooks() {}
  dispose() {}
}

function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/**
 * Thresholds use the median: it catches algorithmic regressions (they move every sample) while
 * staying stable when other processes compete for the CPU (those inflate the average and the tail).
 */
function stats(samples: number[]): { avg: number; p50: number; p95: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    avg: r(samples.reduce((s, x) => s + x, 0) / samples.length),
    p50: r(sorted[Math.floor(sorted.length * 0.5)]!),
    p95: r(sorted[Math.floor(sorted.length * 0.95)]!),
    max: r(sorted[sorted.length - 1]!),
  };
}

/** 100 sessions × (1 session + 2 subagents) = 300 agents with tool history; every 10th session ended. */
function bigState(): { state: OfficeState; events: MonitorEvent[] } {
  let seq = 0;
  const base = Date.now() - 600_000;
  const events: MonitorEvent[] = [];
  const add = (p: Record<string, unknown>) => {
    const r = normalizeHookPayload(p, base + seq * 5);
    if (!r.ok) throw new Error(r.error);
    events.push({ ...r.event, seq: ++seq });
  };
  for (let i = 0; i < 100; i++) {
    const s = `ui-perf-${i}`;
    const mk = (event: string, extra: Record<string, unknown> = {}) => ({ session_id: s, cwd: `c:\\work\\proj-${i % 7}`, hook_event_name: event, ...extra });
    add(mk('SessionStart', { source: 'startup' }));
    add(mk('UserPromptSubmit'));
    for (let sub = 0; sub < 2; sub++) {
      const ag = { agent_id: `a${sub}`, agent_type: 'Explore' };
      add(mk('SubagentStart', ag));
      for (let t = 0; t < 10; t++) {
        add(mk('PreToolUse', { ...ag, tool_name: 'Read', tool_use_id: `r-${i}-${sub}-${t}`, tool_input: { file_path: 'x.ts' } }));
        add(mk('PostToolUse', { ...ag, tool_name: 'Read', tool_use_id: `r-${i}-${sub}-${t}`, tool_input: {}, tool_response: { success: true } }));
      }
    }
    for (let t = 0; t < 20; t++) {
      add(mk('PreToolUse', { tool_name: 'Bash', tool_use_id: `b-${i}-${t}`, tool_input: { command: 'npm test' } }));
      if (t < 19) add(mk('PostToolUse', { tool_name: 'Bash', tool_use_id: `b-${i}-${t}`, tool_input: {}, tool_response: { success: true } }));
    }
    if (i % 10 === 0) add(mk('SessionEnd', { reason: 'other' }));
  }
  let state = createInitialState();
  for (const e of events) state = reduce(state, e);
  return { state, events };
}

function time(n: number, fn: () => unknown): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const t0 = performance.now();
    fn();
    out.push(performance.now() - t0);
  }
  return out;
}

describe('UI performance', () => {
  it('filterAgents / toWorkerViews / workspaceOptions with ~300 agents', () => {
    const { state } = bigState();
    const total = Object.keys(state.agents).length;
    expect(total).toBe(300);
    const folders = ['c:\\work\\proj-3'];
    const all = { workspace: 'all', showEnded: false };
    const visible = filterAgents(state, all, []);
    const ws = workspaceOptions(state, folders);
    const one = { workspace: ws.find((w) => w.label === 'proj-3')!.key, showEnded: false };

    const m = {
      agents: total,
      visible: visible.length,
      filterAll: stats(time(300, () => filterAgents(state, all, []))),
      filterWorkspace: stats(time(300, () => filterAgents(state, one, folders))),
      workerViews: stats(time(300, () => toWorkerViews(visible))),
      workspaceOptions: stats(time(300, () => workspaceOptions(state, folders))),
    };
    console.log(`[perf:ui] views ${JSON.stringify(m)}`);
    expect(visible.length).toBeLessThan(total); // ended sessions are hidden
    expect(toWorkerViews(visible)).toHaveLength(visible.length);
    expect(filterAgents(state, one, folders).length).toBeGreaterThan(0);
    // Generous: these run on every store change; a 60 fps frame is 16 ms.
    expect(m.filterAll.p50).toBeLessThan(8);
    expect(m.filterWorkspace.p50).toBeLessThan(8);
    expect(m.workerViews.p50).toBeLessThan(8);
    expect(m.workspaceOptions.p50).toBeLessThan(8);
  }, 30_000);

  it('OfficeStore applies live event batches on a 300-agent state quickly', () => {
    const { state, events } = bigState();
    const t = new FakeTransport();
    const store = new OfficeStore(t);
    let notified = 0;
    store.subscribe(() => notified++);
    store.start();
    // Start from the state before the last 2 000 events, then replay those as live batches of 20.
    const cut = events.length - 2_000;
    let start = createInitialState();
    for (const e of events.slice(0, cut)) start = reduce(start, e);
    t.emit({ type: 'snapshot', state: start, meta: META, layout: defaultLayout() });
    const batches: MonitorEvent[][] = [];
    for (let i = cut; i < events.length; i += 20) batches.push(events.slice(i, i + 20));
    const samples = time(batches.length, () => t.emit({ type: 'events', events: batches.shift()! }));
    const m = { batches: samples.length, perBatchMs: stats(samples), totalMs: Math.round(samples.reduce((s, x) => s + x, 0)), notified };
    console.log(`[perf:ui] store ${JSON.stringify(m)}`);
    expect(store.getSnapshot().state.lastSeq).toBe(state.lastSeq);
    expect(store.getSnapshot().state).toEqual(state); // the client mirror converges exactly
    expect(t.sent).toEqual([]); // no resync needed
    expect(m.perBatchMs.p50).toBeLessThan(25);
  }, 30_000);

  it('IdleDirector.tick with ~200 actors stays far below the 200 ms scene cadence', () => {
    const world: World = {
      spots: [
        { id: 'coffee-1', kind: 'coffee', at: { x: 21, y: 10 }, face: 'up' },
        { id: 'cooler-1', kind: 'water', at: { x: 21, y: 7 }, face: 'up' },
        { id: 'wc-1', kind: 'toilet', at: { x: 1, y: 10 }, face: 'up' },
        { id: 'wc-2', kind: 'toilet', at: { x: 2, y: 10 }, face: 'up' },
        ...[4, 5, 17, 18].map((x) => ({ id: `couch-${x}`, kind: 'couch' as const, at: { x, y: 12 }, face: 'down' as const })),
        ...[2, 6, 10, 14].map((x) => ({ id: `window-${x}`, kind: 'window' as const, at: { x, y: 2 }, face: 'up' as const })),
      ],
      chatTiles: Array.from({ length: 20 }, (_, x) => ({ x: x + 1, y: 11 })),
      rooms: [],
      night: false,
    };
    const director: BehaviorProvider = new IdleDirector(seeded(11));
    director.setWorld(world);
    director.setEnabled(true);
    const rng = seeded(3);
    const actors: Actor[] = Array.from({ length: 200 }, (_, i) => {
      const home = { x: 1 + (i % 21), y: 3 + Math.floor(i / 21) };
      return { key: `actor-${i}`, idle: i % 5 !== 0, home, pos: { ...home }, moving: false };
    });
    const kinds = new Set<string>();
    const samples: number[] = [];
    let now = Date.now();
    let maxAway = 0;
    for (let step = 0; step < 1_500; step++) {
      now += 200;
      if (step % 100 === 50) for (const a of actors) if (rng() < 0.1) a.idle = !a.idle; // real status changes
      const t0 = performance.now();
      const d: Map<string, Directive> = director.tick(now, actors);
      samples.push(performance.now() - t0);
      let away = 0;
      for (const a of actors) {
        const di = d.get(a.key);
        if (!di) continue;
        if (di.type === 'do') kinds.add(di.activity);
        // Teleport to the target, like the existing idle-life tests.
        const to = di.type === 'home' ? a.home : di.type === 'go' ? di.to : di.at;
        if (to.x !== a.home.x || to.y !== a.home.y) away++;
        a.pos = { ...to };
        a.moving = false;
      }
      maxAway = Math.max(maxAway, away);
      expect(d.size).toBeLessThanOrEqual(actors.length);
    }
    const m = { actors: actors.length, ticks: samples.length, tickMs: stats(samples), maxAwayAtOnce: maxAway, activities: [...kinds].sort() };
    console.log(`[perf:ui] idleDirector ${JSON.stringify(m)}`);
    expect(kinds.size).toBeGreaterThan(0); // the workload really exercised idle life
    expect(maxAway).toBeLessThan(actors.length); // never everyone away at once
    expect(m.tickMs.p50).toBeLessThan(5);
    expect(m.tickMs.p95).toBeLessThan(40);
  }, 30_000);
});
