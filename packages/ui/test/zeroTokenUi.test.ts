/**
 * Runtime zero-inference check for the UI's passive features (idle life, dialogue, meetings,
 * teamwork, collaboration analysis, desk presentation, errors, analytics, replay, department rules):
 * they run for a long simulated period while every network primitive is a recorder that must stay
 * unused. zeroTokenApp.test.tsx renders the whole app under the same recorders.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInitialState, defaultLayout, normalizeHookPayload, reduce, type MonitorEvent, type OfficeState } from '@agent-office/core';
import { computeSessionMetrics, stateMetrics } from '../src/analytics';
import { departmentFor } from '../src/departments';
import { detectIssues, sortIssues } from '../src/errors';
import type { Actor, BehaviorProvider, Directive, TeamEvent } from '../src/office/behavior';
import { collabSignals, collabVisuals, parallelWork, teams } from '../src/office/collab';
import { allDialogueLines, isTemplateLine, pickLine, type DialogueRole } from '../src/office/dialogue';
import { seatsOf } from '../src/office/grid';
import { IdleDirector } from '../src/office/idleLife';
import { MeetingScheduler } from '../src/office/meetings';
import { TeamworkProvider } from '../src/office/teamwork';
import { workPresentation } from '../src/office/poses';
import { buildWorld } from '../src/office/world';
import { advance, buildReplay, createPlayer, describeEvent, play, replayWorkerViews, stateAtTime, timelineBars } from '../src/replay';
import { defaultSettings } from '../src/settings';
import { toWorkerViews } from '../src/view';

const calls: string[] = [];
const restore: Array<() => void> = [];

function trap(obj: Record<string, unknown>, key: string, label: string): void {
  const had = Object.prototype.hasOwnProperty.call(obj, key);
  const orig = obj[key];
  const fn = function (this: unknown, ...args: unknown[]) {
    calls.push(`${label}(${String(args[0]).slice(0, 80)})`);
    throw new Error(`zero-token test: ${label} must not be called`);
  };
  Object.defineProperty(obj, key, { value: fn, configurable: true, writable: true });
  restore.push(() => {
    if (had) Object.defineProperty(obj, key, { value: orig, configurable: true, writable: true });
    else delete obj[key];
  });
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Worker', 'SharedWorker', 'RTCPeerConnection']) trap(g, k, k);
  trap(navigator as unknown as Record<string, unknown>, 'sendBeacon', 'navigator.sendBeacon');
  trap(window as unknown as Record<string, unknown>, 'open', 'window.open');
});

afterAll(() => {
  for (const r of restore.reverse()) r();
});

// A realistic observed session.

const T0 = Date.now() - 30 * 60_000;
let seq = 0;
const events: MonitorEvent[] = [];
function hook(state: OfficeState, name: string, ts: number, extra: Record<string, unknown>, sessionId = 'sess-a'): OfficeState {
  const r = normalizeHookPayload({ session_id: sessionId, cwd: 'c:\\work\\shop', hook_event_name: name, ...extra }, ts);
  if (!r.ok) throw new Error(r.error);
  const ev = { ...r.event, seq: ++seq } as MonitorEvent;
  events.push(ev);
  return reduce(state, ev);
}

function observedStates(): OfficeState[] {
  const out: OfficeState[] = [];
  let s = createInitialState();
  let t = T0;
  const push = (next: OfficeState) => {
    out.push(next);
    s = next;
  };
  push(hook(s, 'SessionStart', t, { source: 'startup' }));
  push(hook(s, 'UserPromptSubmit', (t += 100), {}));
  push(hook(s, 'PreToolUse', (t += 100), { tool_name: 'Agent', tool_use_id: 'sp1', tool_input: { subagent_type: 'test-runner', description: 'Run tests' } }));
  push(hook(s, 'SubagentStart', (t += 100), { agent_id: 'tr1', agent_type: 'test-runner' }));
  push(hook(s, 'TaskCreated', (t += 100), { task_id: '1', task_subject: 'Fix totals' }));
  for (let i = 0; i < 40; i++) {
    const id = `t${i}`;
    const tool = i % 4 === 0 ? { tool_name: 'Bash', tool_input: { command: 'npm test' } } : i % 4 === 1 ? { tool_name: 'Read', tool_input: { file_path: 'c:\\work\\shop\\a.ts' } } : i % 4 === 2 ? { tool_name: 'Grep', tool_input: { pattern: 'total' } } : { tool_name: 'Edit', tool_input: { file_path: 'c:\\work\\shop\\a.ts', old_string: 'x', new_string: 'y' } };
    push(hook(s, 'PreToolUse', (t += 5_000), { agent_id: 'tr1', agent_type: 'test-runner', tool_use_id: id, ...tool }));
    if (i % 8 === 0) push(hook(s, 'PostToolUseFailure', (t += 2_000), { agent_id: 'tr1', agent_type: 'test-runner', tool_use_id: id, ...tool, error: 'Exit code 1: 1 failing test' }));
    else push(hook(s, 'PostToolUse', (t += 2_000), { agent_id: 'tr1', agent_type: 'test-runner', tool_use_id: id, ...tool, tool_response: { ok: true } }));
  }
  push(hook(s, 'PermissionRequest', (t += 1_000), { tool_name: 'Bash', tool_input: { command: 'npm run build' } }));
  push(hook(s, 'TaskCompleted', (t += 1_000), { agent_id: 'tr1', task_id: '1' }));
  push(hook(s, 'SubagentStop', (t += 1_000), { agent_id: 'tr1' }));
  push(hook(s, 'Stop', (t += 1_000), {}));
  push(hook(s, 'SessionStart', (t += 1_000), { source: 'startup' }, 'sess-b'));
  push(hook(s, 'Stop', (t += 1_000), {}, 'sess-b'));
  return out;
}

let observedCache: OfficeState[] | undefined;
/** The observed states, built once (building records the events used by the replay test). */
const observed = () => (observedCache ??= observedStates());

describe('UI passive features make no network calls (zero office inference)', () => {
  it('observed-state analysis: worker views, presentation, collaboration, errors, analytics, departments', () => {
    const states = observed();
    const last = states.at(-1)!;
    const now = Date.now();
    let visuals = 0;
    for (let i = 1; i < states.length; i++) visuals += collabVisuals(states[i - 1], states[i]!).length;
    expect(visuals).toBeGreaterThan(0); // the session really delegated, handed off and completed
    expect(collabSignals(last).length).toBeGreaterThan(0);
    expect(teams(last).length).toBeGreaterThan(0);
    parallelWork(last);
    const views = toWorkerViews(Object.values(last.agents));
    for (const v of views) {
      const p = workPresentation({ status: v.status, detail: v.statusDetail, toolName: v.toolName, toolSummary: v.toolSummary, stale: v.stale });
      expect(p.screen).toBeTruthy();
      departmentFor({ agentType: v.agentType, cwd: v.cwd, name: v.name }, defaultSettings().departmentRules);
    }
    expect(sortIssues(detectIssues(last, now)).length).toBeGreaterThan(0);
    expect(stateMetrics(last).toolCalls).toBeGreaterThan(0);
    computeSessionMetrics(events);
    expect(calls).toEqual([]);
  });

  it('teamwork interactions for the verified delegation and handoff of the observed session', () => {
    const states = observed();
    // Team events exactly as the office derives them: collabVisuals between consecutive states.
    const teamEvents: TeamEvent[] = [];
    for (let i = 1; i < states.length; i++) {
      for (const v of collabVisuals(states[i - 1], states[i]!)) {
        const e: TeamEvent = { id: v.id, kind: v.kind, from: v.from, to: v.to, at: v.at };
        if (v.detail) e.detail = v.detail;
        teamEvents.push(e);
      }
    }
    const delegation = teamEvents.find((e) => e.kind === 'delegate' && e.from === 'sess-a' && e.to === 'sess-a::tr1');
    const handoff = teamEvents.find((e) => e.kind === 'handoff' && e.to === 'sess-a::tr1');
    expect(delegation).toBeTruthy();
    expect(handoff).toBeTruthy();

    const layout = defaultLayout();
    const seats = seatsOf(layout);
    let rng = 11;
    const random = () => ((rng = (rng * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const teamwork = new TeamworkProvider(random);
    teamwork.setWorld(buildWorld(layout, [2, 6, 10, 14, 18, 22], false));
    teamwork.setEnabled(true);
    const run = (event: TeamEvent, lead: Actor, sub: Actor) => {
      const seen: Directive[] = [];
      const start = Date.now();
      teamwork.onTeamEvents([event], start);
      for (let t = start; t < start + 20_000; t += 250) {
        const out = teamwork.tick(t, [lead, sub]);
        const d = out.get(sub.key);
        if (out.has(lead.key) && out.get(lead.key)!.type !== 'home') throw new Error('the lead never leaves its desk');
        if (d) seen.push(d);
        sub.pos = d && d.type === 'go' ? { ...d.to } : d && d.type === 'do' ? { ...d.at } : { ...sub.home };
        sub.moving = false;
        sub.away = sub.pos.x !== sub.home.x || sub.pos.y !== sub.home.y;
      }
      return seen;
    };
    const lead = (status: 'working' | 'idle'): Actor => ({ key: 'sess-a', idle: status === 'idle', home: { ...seats[0]!.seat }, pos: { ...seats[0]!.seat }, moving: false, ctx: { kind: 'session', sessionId: 'sess-a', status } });
    // Briefing: the new subagent is on its way in (still at the door) and really working.
    const walkingIn: Actor = { key: 'sess-a::tr1', idle: false, home: { ...seats[3]!.seat }, pos: { x: layout.door.x, y: layout.rows - 1 }, moving: true, ctx: { kind: 'subagent', sessionId: 'sess-a', parentKey: 'sess-a', status: 'working' } };
    const briefing = run(delegation!, lead('working'), walkingIn);
    expect(briefing.some((d) => d.type === 'do' && d.activity === 'briefing' && d.verified === true)).toBe(true);
    // Handoff: both agents idle at their desks.
    const atDesk: Actor = { key: 'sess-a::tr1', idle: true, home: { ...seats[3]!.seat }, pos: { ...seats[3]!.seat }, moving: false, ctx: { kind: 'subagent', sessionId: 'sess-a', parentKey: 'sess-a', status: 'idle' } };
    const handing = run(handoff!, lead('idle'), atDesk);
    expect(handing.some((d) => d.type === 'do' && d.activity === 'handoff' && d.verified === true)).toBe(true);
    for (const d of [...briefing, ...handing]) if (d.type === 'do') expect(d.speech).toBeUndefined(); // a pose and an icon, never text
    expect(teamwork.current()).toEqual([]); // released within the hold cap
    expect(calls).toEqual([]);
  });

  it('replay of the recorded events', () => {
    const tl = buildReplay(events);
    let p = play(tl, createPlayer(tl));
    let steps = 0;
    while (p.playing && steps++ < 5_000) {
      p = advance(tl, p, 1_000, { skipGapsOverMs: 10_000 });
      replayWorkerViews(stateAtTime(tl, p.position), p.position, Date.now());
    }
    timelineBars(tl, 120);
    for (const ev of events) describeEvent(ev);
    expect(steps).toBeGreaterThan(1);
    expect(calls).toEqual([]);
  });

  it('two simulated hours of idle life, dialogue, meetings and teamwork in the default office', () => {
    const layout = defaultLayout();
    const world = buildWorld(layout, [2, 6, 10, 14, 18, 22], false);
    const seats = seatsOf(layout).slice(0, 10);
    expect(seats.length).toBe(10);
    let rng = 7;
    const random = () => ((rng = (rng * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const director = new IdleDirector(random);
    const meetings = new MeetingScheduler(random);
    const teamwork = new TeamworkProvider(random);
    // Priority order as in the scene: verified teamwork first, then meetings, then idle life.
    const providers: BehaviorProvider[] = [teamwork, meetings, director];
    for (const p of providers) {
      p.setWorld(world);
      p.setEnabled(true);
      p.setFrequency?.(2);
    }
    const start = Date.now();
    const actors: Actor[] = seats.map((s, i) => ({
      key: `a${i}`,
      idle: true,
      home: { ...s.seat },
      pos: { ...s.seat },
      moving: false,
      ctx: {
        kind: i % 3 ? 'subagent' : 'session',
        sessionId: `s${i % 3}`,
        status: 'idle',
        finishedAt: start - i * 60_000,
        lastWorkMs: i * 5 * 60_000,
        ...(i % 2 ? { recentFailure: { kind: 'test' as const, at: start - 5 * 60_000 } } : {}),
      },
    }));
    const said = new Set<string>();
    const activities = new Set<string>();
    let meetingTicks = 0;
    const teamworkKinds = new Set<string>();
    let teamworkSpeech = 0;
    let n = 0;
    for (let t = start; t < start + 2 * 3_600_000; t += 500) {
      // Every 10 simulated minutes a verified delegation and a task handoff arrive (as collabVisuals reports them).
      if (n++ % 1200 === 600) {
        const events: TeamEvent[] = [
          { id: `d${n}`, kind: 'delegate', from: 'a0', to: 'a1', at: t },
          { id: `h${n}`, kind: 'handoff', from: 'a3', to: 'a4', at: t, detail: 'Fix totals' },
        ];
        for (const p of providers) p.onTeamEvents?.(events, t);
      }
      const claimed = new Map<string, Directive>();
      for (const p of providers) {
        const offered = actors.map((a) => (claimed.has(a.key) ? { ...a, idle: false } : a));
        for (const [k, d] of p.tick(t, offered)) if (!claimed.has(k) && d.type !== 'home') claimed.set(k, d);
      }
      if (meetings.currentMeetings().length) meetingTicks += 1;
      for (const a of actors) {
        const d = claimed.get(a.key);
        a.pos = d ? { ...(d.type === 'go' ? d.to : d.type === 'do' ? d.at : a.home) } : { ...a.home };
        a.away = a.pos.x !== a.home.x || a.pos.y !== a.home.y;
        if (d?.type === 'do') {
          activities.add(d.activity);
          if (d.speech) said.add(d.speech);
          if (d.verified) {
            teamworkKinds.add(d.activity);
            if (d.speech) teamworkSpeech += 1;
          }
        }
      }
    }
    // Non-vacuous: the simulation really ran, talked and met.
    expect(activities.size).toBeGreaterThan(4);
    expect(said.size).toBeGreaterThan(3);
    expect(meetingTicks).toBeGreaterThan(0);
    for (const kind of ['coffee', 'toilet', 'chat']) expect(activities, kind).toContain(kind); // breaks and chit-chat
    expect([...teamworkKinds].sort()).toEqual(['briefing', 'handoff']);
    expect(teamworkSpeech).toBe(0); // verified interactions show a pose and an icon, never text
    expect(teamwork.current()).toEqual([]); // every interaction was released
    // Every spoken line is verbatim from the local template table.
    for (const line of said) expect(isTemplateLine(line), line).toBe(true);
    // Direct dialogue picks for every role, too.
    const roles: DialogueRole[] = ['open', 'reply', 'small_talk', 'close', 'solo'];
    for (const role of roles)
      for (const activity of ['chat', 'coffee', 'water', 'window', 'books', 'plant', 'walk'])
        for (let i = 0; i < 20; i++) {
          const l = pickLine({ role, activity, self: actors[i % actors.length]!.ctx, partner: actors[(i + 1) % actors.length]!.ctx, now: start, hour: i % 24, rng: random });
          if (l) expect(allDialogueLines()).toContain(l.text);
        }
    expect(calls).toEqual([]);
  }, 60_000);

  it('the recorders are live (a call would have been caught)', () => {
    expect(() => (globalThis as unknown as { fetch: (u: string) => unknown }).fetch('https://example.invalid/')).toThrow(/must not be called/);
    expect(calls).toEqual(['fetch(https://example.invalid/)']);
    calls.length = 0;
  });
});
