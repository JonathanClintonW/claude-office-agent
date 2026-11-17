import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '@agent-office/core';
import type { Actor, Directive, Point, TeamEvent, World } from '../src/office/behavior';
import { DEFAULT_TEAMWORK_OPTIONS, TeamworkProvider, type TeamworkOptions } from '../src/office/teamwork';

/** Deterministic RNG. */
function seeded(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const k = (p: Point) => `${p.x},${p.y}`;
const DOOR: Point = { x: 15, y: 15 };

/**
 * A 30×16 office: a row of desks at y=4 (blocked) with their seats at y=5. Chat tiles, like
 * world.ts builds them, never include desk seats.
 */
function office(blocked: Point[] = []): World {
  const cols = 30;
  const rows = 16;
  const desks = new Set(Array.from({ length: 8 }, (_, i) => k({ x: 4 + i, y: 4 })));
  const extra = new Set(blocked.map(k));
  const seats = new Set(Array.from({ length: 8 }, (_, i) => k({ x: 4 + i, y: 5 })));
  const walk = (p: Point) => p.x >= 0 && p.y >= 1 && p.x < cols && p.y < rows && !desks.has(k(p)) && !extra.has(k(p));
  const free = (p: Point) => walk(p) && !seats.has(k(p));
  const chatTiles: Point[] = [];
  for (let y = 1; y < rows; y++) for (let x = 0; x < cols - 1; x++) if (free({ x, y }) && free({ x: x + 1, y })) chatTiles.push({ x, y });
  return { spots: [], chatTiles, rooms: [], night: false, isWalkable: walk };
}

function agent(key: string, home: Point, status: AgentStatus, extra: Partial<Actor> = {}): Actor {
  return {
    key,
    idle: status === 'idle',
    home: { ...home },
    pos: { ...home },
    moving: false,
    ctx: { kind: key.startsWith('P') || key.startsWith('A') ? 'session' : 'subagent', sessionId: 's', status },
    ...extra,
  };
}

/** A subagent that has just appeared at the door and is walking to its desk. */
const newChild = (key: string, home: Point, status: AgentStatus = 'working') => agent(key, home, status, { pos: { ...DOOR }, moving: true });

const setStatus = (a: Actor, status: AgentStatus) => {
  a.ctx = { ...a.ctx!, status };
  a.idle = status === 'idle';
};

const delegate = (to: string, from = 'P', at = 0): TeamEvent => ({ id: `delegation:${to}:verified`, kind: 'delegate', from, to, at });
const handoff = (from: string, to: string, at = 0, detail?: string): TeamEvent => ({ id: `task_handoff:${from}>${to}:${at}`, kind: 'handoff', from, to, at, ...(detail ? { detail } : {}) });

type Do = Extract<Directive, { type: 'do' }>;

/** Tick every 200 ms, teleporting actors wherever they are sent (no directive: their desk). */
function drive(tw: TeamworkProvider, actors: Actor[], from: number, ms: number, onTick?: (t: number, d: Map<string, Directive>) => void, hold?: Set<string>): number {
  let t = from;
  for (; t < from + ms; t += 200) {
    const d = tw.tick(t, actors);
    onTick?.(t, d);
    for (const a of actors) {
      if (hold?.has(a.key)) continue;
      const di = d.get(a.key);
      a.pos = { ...(di?.type === 'go' ? di.to : di?.type === 'do' ? di.at : a.home) };
      a.moving = false;
    }
  }
  return t;
}

function provider(o: Partial<TeamworkOptions> = {}, w: World = office()): TeamworkProvider {
  const tw = new TeamworkProvider(seeded(1), { ...DEFAULT_TEAMWORK_OPTIONS, ...o });
  tw.setWorld(w);
  return tw;
}

const chebyshev = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

describe('TeamworkProvider: spawn briefing (verified delegation)', () => {
  it('stops the new subagent next to its parent, facing it, then lets it walk on to its desk', () => {
    const tw = provider();
    const parent = agent('P', { x: 5, y: 5 }, 'working');
    const child = newChild('C1', { x: 6, y: 5 });
    const actors = [parent, child];
    tw.onTeamEvents([delegate('C1')], 0);
    const seq: string[] = [];
    let talk = 0;
    drive(tw, actors, 0, 6000, (_t, d) => {
      expect(d.has('P')).toBe(false); // the parent never leaves its desk
      const di = d.get('C1');
      seq.push(di?.type ?? 'none');
      if (di?.type === 'go') expect(di.to).toEqual({ x: 4, y: 6 });
      if (di?.type === 'do') {
        talk++;
        expect(di).toEqual({ type: 'do', at: { x: 4, y: 6 }, face: 'right', pose: 'talk', activity: 'briefing', groupId: 'briefing:P', verified: true });
      }
    });
    expect(seq.filter((x, i, arr) => i === 0 || arr[i - 1] !== x)).toEqual(['go', 'do', 'home', 'none']);
    expect(talk * 200).toBeGreaterThanOrEqual(DEFAULT_TEAMWORK_OPTIONS.briefingMs - 200);
    expect(talk * 200).toBeLessThanOrEqual(3000);
    expect(child.pos).toEqual(child.home);
    expect(tw.current()).toEqual([]);
  });

  it('gives children spawned in parallel distinct free tiles next to the parent desk', () => {
    const tw = provider();
    const parent = agent('P', { x: 5, y: 5 }, 'working');
    const kids = [newChild('C1', { x: 6, y: 5 }), newChild('C2', { x: 7, y: 5 }), newChild('C3', { x: 8, y: 5 }), newChild('C4', { x: 9, y: 5 })];
    const actors = [parent, ...kids];
    tw.onTeamEvents(kids.map((c) => delegate(c.key)), 0);
    const d = tw.tick(0, actors);
    const tiles = kids.map((c) => d.get(c.key)).map((x) => (x?.type === 'go' ? x.to : undefined));
    expect(tiles.every(Boolean)).toBe(true);
    expect(new Set(tiles.map((p) => k(p!))).size).toBe(4);
    for (const p of tiles) {
      expect(chebyshev(p!, parent.home)).toBe(1);
      for (const a of actors) expect(k(a.home)).not.toBe(k(p!)); // never another agent's desk seat
    }
    // Free floor first; the empty desk seat on the left only as the last resort.
    expect(tiles.map((p) => k(p!))).toEqual(['4,6', '6,6', '5,6', '4,5']);
    drive(tw, actors, 200, 1000, (t, dd) => {
      if (t >= 400) for (const c of kids) expect(dd.get(c.key)).toMatchObject({ type: 'do', groupId: 'briefing:P', verified: true });
    });
  });

  it('skips long detours, missing agents and subagents already at their desk', () => {
    // Detour: the child's desk is far from its parent.
    const far = provider();
    const p1 = agent('P', { x: 5, y: 5 }, 'working');
    const c1 = newChild('C1', { x: 27, y: 14 });
    far.onTeamEvents([delegate('C1')], 0);
    drive(far, [p1, c1], 0, 5000, (_t, d) => expect(d.size).toBe(0));

    // The child shows up within startWithinMs: the briefing still happens.
    const late = provider();
    const p2 = agent('P', { x: 5, y: 5 }, 'working');
    const c2 = newChild('C1', { x: 6, y: 5 });
    late.onTeamEvents([delegate('C1')], 0);
    drive(late, [p2], 0, 2000);
    expect(late.tick(2000, [p2, c2]).get('C1')).toMatchObject({ type: 'go' });

    // ...but not once that window has passed.
    const tooLate = provider();
    const c3 = newChild('C1', { x: 6, y: 5 });
    tooLate.onTeamEvents([delegate('C1')], 0);
    drive(tooLate, [p2], 0, DEFAULT_TEAMWORK_OPTIONS.startWithinMs + 200);
    expect(tooLate.tick(DEFAULT_TEAMWORK_OPTIONS.startWithinMs + 400, [p2, c3]).size).toBe(0);

    // Parent not in the office: nothing.
    const orphan = provider();
    orphan.onTeamEvents([delegate('C1')], 0);
    drive(orphan, [newChild('C1', { x: 6, y: 5 })], 0, 6000, (_t, d) => expect(d.size).toBe(0));

    // Already seated at its own desk: a working agent is never pulled away.
    const settled = provider();
    settled.onTeamEvents([delegate('C1')], 0);
    drive(settled, [agent('P', { x: 5, y: 5 }, 'working'), agent('C1', { x: 6, y: 5 }, 'working')], 0, 6000, (_t, d) => expect(d.size).toBe(0));
  });

  it('ends at once, in a hurry, on a permission prompt, a question, a failure or an unknown status', () => {
    for (const status of ['waiting_permission', 'waiting_input', 'failed', 'unknown'] as const) {
      for (const when of [0, 600]) {
        const tw = provider();
        const parent = agent('P', { x: 5, y: 5 }, 'working');
        const child = newChild('C1', { x: 6, y: 5 });
        tw.onTeamEvents([delegate('C1')], 0);
        drive(tw, [parent, child], 0, when + 200, undefined, new Set(when ? [] : ['C1']));
        expect(tw.current()[0]!.phase).toBe(when ? 'talk' : 'go');
        setStatus(child, status);
        expect(tw.tick(when + 200, [parent, child]).get('C1')).toEqual({ type: 'home', hurry: true });
        expect(tw.current()).toEqual([]);
        expect(tw.tick(when + 400, [parent, child]).get('C1')).toEqual({ type: 'home', hurry: true });
      }
    }
    // A subagent that finishes during its briefing just walks on calmly.
    const tw = provider();
    const parent = agent('P', { x: 5, y: 5 }, 'working');
    const child = newChild('C1', { x: 6, y: 5 });
    tw.onTeamEvents([delegate('C1')], 0);
    drive(tw, [parent, child], 0, 400);
    setStatus(child, 'completed');
    expect(tw.tick(400, [parent, child]).get('C1')).toEqual({ type: 'home', hurry: false });
  });

  it('never holds anyone past the hard cap, even if it never arrives', () => {
    const tw = provider();
    const parent = agent('P', { x: 5, y: 5 }, 'working');
    const child = newChild('C1', { x: 6, y: 5 });
    tw.onTeamEvents([delegate('C1')], 1000);
    let last = 0;
    for (let t = 1000; t < 20_000; t += 200) {
      const d = tw.tick(t, [parent, child]); // the child stays stuck at the door, walking
      if (d.get('C1')?.type === 'go') last = t;
    }
    expect(last).toBeGreaterThan(1000);
    expect(last).toBeLessThan(1000 + DEFAULT_TEAMWORK_OPTIONS.maxHoldMs);
  });
});

describe('TeamworkProvider: task handoff (verified)', () => {
  it('walks the idle completer to the idle creator for about three seconds, with an icon and no text', () => {
    const tw = provider();
    const creator = agent('A', { x: 5, y: 5 }, 'idle');
    const completer = agent('B', { x: 20, y: 5 }, 'idle');
    const actors = [creator, completer];
    tw.onTeamEvents([handoff('A', 'B', 0, 'Fix login bug')], 0);
    const seq: string[] = [];
    const bubbles = new Set<string>();
    let talk = 0;
    drive(tw, actors, 0, 8000, (_t, d) => {
      expect(d.has('A')).toBe(false); // the creator stays at its desk
      const di = d.get('B');
      seq.push(di?.type ?? 'none');
      if (di?.type !== 'do') return;
      talk++;
      expect(di).toMatchObject({ at: { x: 4, y: 6 }, face: 'right', pose: 'talk', activity: 'handoff', groupId: 'handoff:A', verified: true });
      expect('speech' in di).toBe(false);
      if (di.bubble) bubbles.add(di.bubble);
    });
    expect(seq.filter((x, i, arr) => i === 0 || arr[i - 1] !== x)).toEqual(['go', 'do', 'home', 'none']);
    expect(talk * 200).toBeGreaterThanOrEqual(2800);
    expect(talk * 200).toBeLessThanOrEqual(3200);
    expect(bubbles.size).toBe(1);
    expect([...bubbles][0]).toMatch(/^chat_/);
    expect(JSON.stringify(seq)).not.toContain('Fix login bug');
  });

  it('does nothing unless both agents are idle and the creator is at its desk', () => {
    const cases: Array<[string, Actor, Actor]> = [
      ['creator working', agent('A', { x: 5, y: 5 }, 'working'), agent('B', { x: 20, y: 5 }, 'idle')],
      ['completer working', agent('A', { x: 5, y: 5 }, 'idle'), agent('B', { x: 20, y: 5 }, 'working')],
      ['creator waiting', agent('A', { x: 5, y: 5 }, 'waiting_input'), agent('B', { x: 20, y: 5 }, 'idle')],
      ['creator away', agent('A', { x: 5, y: 5 }, 'idle', { pos: { x: 12, y: 10 }, away: true }), agent('B', { x: 20, y: 5 }, 'idle')],
    ];
    for (const [, a, b] of cases) {
      const tw = provider();
      tw.onTeamEvents([handoff('A', 'B')], 0);
      for (let t = 0; t < 8000; t += 200) expect(tw.tick(t, [a, b]).size).toBe(0);
    }
  });

  it('ends early when either agent gets busy: hurried on real work, calm when the creator is needed', () => {
    const start = () => {
      const tw = provider();
      const a = agent('A', { x: 5, y: 5 }, 'idle');
      const b = agent('B', { x: 20, y: 5 }, 'idle');
      tw.onTeamEvents([handoff('A', 'B')], 0);
      drive(tw, [a, b], 0, 600);
      expect(tw.current()[0]!.phase).toBe('talk');
      return { tw, a, b };
    };
    const one = start();
    setStatus(one.b, 'working');
    expect(one.tw.tick(600, [one.a, one.b]).get('B')).toEqual({ type: 'home', hurry: true });

    const two = start();
    setStatus(two.a, 'working');
    expect(two.tw.tick(600, [two.a, two.b]).get('B')).toEqual({ type: 'home', hurry: false });

    // Claimed by nobody else: the completer is the one walking, so a creator heading off ends it too.
    const three = start();
    three.a.moving = true;
    expect(three.tw.tick(600, [three.a, three.b]).get('B')).toEqual({ type: 'home', hurry: false });
  });

  it('waits briefly for both to become idle (event order jitter), then gives up', () => {
    const tw = provider();
    const a = agent('A', { x: 5, y: 5 }, 'idle');
    const b = agent('B', { x: 20, y: 5 }, 'working');
    tw.onTeamEvents([handoff('A', 'B')], 0);
    expect(tw.tick(0, [a, b]).size).toBe(0);
    setStatus(b, 'idle');
    expect(tw.tick(1000, [a, b]).get('B')).toMatchObject({ type: 'go' });
  });
});

describe('TeamworkProvider: lifecycle', () => {
  it('ignores completions, self-events, duplicates and events while disabled', () => {
    const tw = provider();
    const actors = [agent('P', { x: 5, y: 5 }, 'working'), newChild('C1', { x: 6, y: 5 })];
    tw.onTeamEvents([{ id: 'done', kind: 'complete', from: 'C1', to: 'P', at: 0 }, { id: 'self', kind: 'delegate', from: 'C1', to: 'C1', at: 0 }], 0);
    expect(tw.tick(0, actors).size).toBe(0);
    tw.setEnabled(false);
    tw.onTeamEvents([delegate('C1')], 0);
    tw.setEnabled(true);
    tw.onTeamEvents([delegate('C1')], 0); // same id again: already seen
    expect(tw.tick(200, actors).size).toBe(0);
    expect(tw.current()).toEqual([]);
  });

  it('keeps an unstarted plan across forget (a new worker is re-seated on arrival), drops a running one', () => {
    const tw = provider();
    const parent = agent('P', { x: 5, y: 5 }, 'working');
    const child = newChild('C1', { x: 6, y: 5 });
    tw.onTeamEvents([delegate('C1')], 0);
    tw.forget('C1'); // the scene forgets a worker when it first gets its desk
    expect(tw.tick(0, [parent, child]).get('C1')).toMatchObject({ type: 'go' });
    tw.forget('C1'); // re-seated while walking over: the briefing is dropped
    expect(tw.current()).toEqual([]);
    expect(tw.tick(200, [parent, child]).has('C1')).toBe(false);
  });

  it('releases on setEnabled(false), on a parent re-seat and when the layout blocks the target', () => {
    const run = (mutate: (tw: TeamworkProvider, parent: Actor) => void) => {
      const tw = provider();
      const parent = agent('P', { x: 5, y: 5 }, 'working');
      const child = newChild('C1', { x: 6, y: 5 });
      tw.onTeamEvents([delegate('C1')], 0);
      drive(tw, [parent, child], 0, 400);
      expect(tw.current()[0]!.phase).toBe('talk');
      mutate(tw, parent);
      const d = tw.tick(400, [parent, child]).get('C1');
      expect(d?.type ?? 'home').toBe('home');
      expect(tw.current()).toEqual([]);
    };
    run((tw) => tw.setEnabled(false));
    run((_tw, parent) => (parent.home = { x: 9, y: 5 }));
    run((tw) => tw.setWorld(office([{ x: 4, y: 6 }])));
    // An unchanged rebuild keeps it.
    const tw = provider();
    const parent = agent('P', { x: 5, y: 5 }, 'working');
    const child = newChild('C1', { x: 6, y: 5 });
    tw.onTeamEvents([delegate('C1')], 0);
    drive(tw, [parent, child], 0, 400);
    tw.setWorld({ ...office(), night: true });
    expect(tw.tick(400, [parent, child]).get('C1')).toMatchObject({ type: 'do', verified: true });
  });

  it('only ever emits verified talk poses, never speech, and never directs the agent at the other desk', () => {
    const rng = seeded(9);
    for (let round = 0; round < 30; round++) {
      const tw = new TeamworkProvider(seeded(round), DEFAULT_TEAMWORK_OPTIONS);
      tw.setWorld(office());
      const lead = agent('P', { x: 5, y: 5 }, rng() < 0.5 ? 'idle' : 'working');
      const kids = [newChild('C1', { x: 6, y: 5 }), newChild('C2', { x: 7, y: 5 }), agent('B', { x: 20, y: 5 }, 'idle')];
      const actors = [lead, ...kids];
      tw.onTeamEvents([delegate('C1'), delegate('C2'), handoff('P', 'B')], 0);
      drive(tw, actors, 0, 16_000, (_t, d) => {
        expect(d.has('P')).toBe(false);
        for (const di of d.values()) {
          if (di.type !== 'do') continue;
          expect((di as Do).verified).toBe(true);
          expect(di.pose).toBe('talk');
          expect('speech' in di).toBe(false);
        }
        if (rng() < 0.05) setStatus(kids[Math.floor(rng() * kids.length)]!, (['working', 'idle', 'waiting_permission', 'failed'] as const)[Math.floor(rng() * 4)]!);
      });
      expect(tw.current()).toEqual([]); // everything released within the hard cap
    }
  });
});
