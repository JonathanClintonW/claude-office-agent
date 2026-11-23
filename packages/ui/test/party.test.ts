import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor, ActorContext, Directive, Point, RoomInfo, World } from '../src/office/behavior';
import { DEFAULT_PARTY_OPTIONS, PartyPlanner, type PartyInfo, type PartyOptions } from '../src/office/party';

function seeded(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const FAST: PartyOptions = { ...DEFAULT_PARTY_OPTIONS, eatMs: [10_000, 10_000], arrivalTimeout: 10_000, checkEveryMs: 1000 };

/** Six seats around a two-tile table at (12,4)-(13,4). */
const breakRoom: RoomInfo = {
  id: 'b1',
  name: 'Break room',
  kind: 'break',
  x: 10,
  y: 2,
  w: 6,
  h: 5,
  seats: [
    { at: { x: 12, y: 3 }, face: 'down' },
    { at: { x: 13, y: 3 }, face: 'down' },
    { at: { x: 11, y: 4 }, face: 'right' },
    { at: { x: 14, y: 4 }, face: 'left' },
    { at: { x: 12, y: 5 }, face: 'up' },
    { at: { x: 13, y: 5 }, face: 'up' },
  ],
  capacity: 6,
};
/** Four seats around a table at (22,4)-(23,4). */
const meetingRoom: RoomInfo = {
  id: 'm1',
  name: 'Meeting room',
  kind: 'meeting',
  x: 20,
  y: 2,
  w: 6,
  h: 5,
  seats: [
    { at: { x: 22, y: 3 }, face: 'down' },
    { at: { x: 23, y: 3 }, face: 'down' },
    { at: { x: 22, y: 5 }, face: 'up' },
    { at: { x: 23, y: 5 }, face: 'up' },
  ],
  capacity: 4,
  presenter: { at: { x: 24, y: 4 }, face: 'left' },
};
const devRoom: RoomInfo = { id: 'd1', name: 'Dev', kind: 'development', x: 0, y: 6, w: 6, h: 4, seats: [7, 8, 9].map((y) => ({ at: { x: 2, y }, face: 'up' as const })), capacity: 3 };

const world = (rooms: RoomInfo[]): World => ({ spots: [], chatTiles: [], rooms, night: false });
const k = (p: Point) => `${p.x},${p.y}`;

function agent(key: string, x: number, coins: number | undefined, sessionId: string): Actor {
  const ctx: ActorContext = { kind: key.endsWith('-0') ? 'session' : 'subagent', sessionId, status: 'idle' };
  if (coins !== undefined) ctx.coins = coins;
  return { key, idle: true, home: { x, y: 1 }, pos: { x, y: 1 }, moving: false, ctx };
}
/** A lead session and its subagents, at desks along y = 1. */
const team = (n: number, coins = 100, sessionId = 's1', x0 = 1) => Array.from({ length: n }, (_, i) => agent(`${sessionId}-${i}`, x0 + i, coins, sessionId));

function planner(rooms: RoomInfo[] = [breakRoom], o: PartyOptions = FAST, seed = 7): PartyPlanner {
  const p = new PartyPlanner(seeded(seed), o);
  p.setWorld(world(rooms));
  return p;
}

interface PayCall {
  keys: string[];
  sessionId: string;
  now: number;
}
/** Funding like the scene's: charges the members' coins (or refuses) and records each call. */
function fund(p: PartyPlanner, actors: Actor[], ok: boolean | ((call: PayCall) => boolean) = true): PayCall[] {
  const calls: PayCall[] = [];
  p.setFunding((keys, sessionId, now) => {
    const call = { keys: [...keys], sessionId, now };
    calls.push(call);
    const paid = typeof ok === 'function' ? ok(call) : ok;
    if (paid) for (const key of keys) actors.find((a) => a.key === key)!.ctx!.coins! -= Math.ceil(FAST.price / keys.length);
    return paid;
  });
  return calls;
}

/** Bystanders the tests park somewhere: run() never moves them. */
const PARKED = new Set(['lounger', 'guest']);

/** Run the planner, teleporting actors to wherever they are told to go. */
function run(p: PartyPlanner, actors: Actor[], from: number, ms: number, onTick?: (t: number, d: Map<string, Directive>) => void, step = 200): number {
  let t = from;
  for (; t < from + ms; t += step) {
    const d = p.tick(t, actors);
    onTick?.(t, d);
    for (const a of actors) {
      const di = d.get(a.key);
      if (!di || PARKED.has(a.key)) continue;
      a.pos = { ...(di.type === 'home' ? a.home : di.type === 'go' ? di.to : di.at) };
      a.moving = false;
    }
  }
  return t;
}

const target = (d: Directive | undefined): Point | undefined => (d?.type === 'do' ? d.at : d?.type === 'go' ? d.to : undefined);
const dedupe = <T>(xs: T[]) => xs.filter((x, i) => i === 0 || xs[i - 1] !== x);

/** Run until the first party is eating. */
function eating(p: PartyPlanner, actors: Actor[]): { party: PartyInfo; t: number } {
  let t = 0;
  for (; t < 10_000 && p.currentParties()[0]?.phase !== 'eating'; t += 200) run(p, actors, t, 200);
  return { party: p.currentParties()[0]!, t };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PartyPlanner: starting', () => {
  it('never throws a party without funding (coin game off)', () => {
    const p = planner();
    const actors = team(4, 500);
    run(p, actors, 0, 60_000, (_t, d) => {
      expect(p.currentParties()).toEqual([]);
      expect([...d.values()].every((x) => x.type === 'home')).toBe(true);
    });
    p.setFunding(() => true);
    p.setFunding(null);
    run(p, actors, 60_000, 30_000, () => expect(p.currentParties()).toEqual([]));
  });

  it('needs three idle members at their desks whose coins add up to the price', () => {
    const cases: Array<[string, Actor[]]> = [
      ['too poor', team(3, 70)],
      ['only two', team(2, 500)],
      ['one busy', team(3, 100).map((a, i) => (i === 0 ? { ...a, idle: false, ctx: { ...a.ctx!, status: 'working' as const } } : a))],
      ['one away', team(3, 100).map((a, i) => (i === 0 ? { ...a, away: true } : a))],
      ['one walking', team(3, 100).map((a, i) => (i === 0 ? { ...a, moving: true } : a))],
      ['one not at its desk', team(3, 100).map((a, i) => (i === 0 ? { ...a, pos: { x: 8, y: 8 } } : a))],
      ['one without coins', team(3, 120).map((a, i) => (i === 0 ? { ...a, ctx: { ...a.ctx!, coins: undefined } } : a))],
    ];
    for (const [label, actors] of cases) {
      const p = planner();
      const calls = fund(p, actors);
      for (let t = 0; t < 30_000; t += 200) p.tick(t, actors); // nobody moves
      expect({ label, parties: p.currentParties(), calls: calls.length }).toEqual({ label, parties: [], calls: 0 });
    }
  });

  it('takes the richest members, up to maxMembers, and shrinks the group to fit the best room', () => {
    const p = planner([breakRoom], { ...FAST, maxMembers: 6 });
    const actors = [5, 90, 60, 10, 80, 70, 40, 20].map((c, i) => agent(`s1-${i}`, i + 1, c, 's1'));
    const calls = fund(p, actors);
    run(p, actors, 0, 1200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.keys).toEqual(['s1-1', 's1-4', 's1-5', 's1-2', 's1-6', 's1-7']);

    const small = { ...breakRoom, seats: breakRoom.seats.slice(0, 4), capacity: 4 };
    const q = planner([small]);
    const b = [90, 80, 70, 60, 50, 40].map((c, i) => agent(`s1-${i}`, i + 1, c, 's1'));
    fund(q, b);
    run(q, b, 0, 1200);
    expect(q.currentParties()[0]!.members.sort()).toEqual(['s1-0', 's1-1', 's1-2', 's1-3']);
  });

  it('does not start when the funding callback refuses, and waits six checks before asking again', () => {
    const p = planner();
    const actors = team(3, 100);
    const calls = fund(p, actors, false);
    run(p, actors, 0, 30_000, (_t, d) => {
      expect(p.currentParties()).toEqual([]);
      expect([...d.values()].every((x) => x.type === 'home')).toBe(true);
    });
    expect(calls.length).toBeGreaterThan(1);
    for (let i = 1; i < calls.length; i++) expect(calls[i]!.now - calls[i - 1]!.now).toBeGreaterThanOrEqual(6 * FAST.checkEveryMs);
    expect(actors.map((a) => a.ctx!.coins)).toEqual([100, 100, 100]);
  });

  it('only uses break, meeting and collaboration rooms, preferring break rooms', () => {
    const none = planner([devRoom]);
    const a = team(3);
    const calls = fund(none, a);
    run(none, a, 0, 20_000, () => expect(none.currentParties()).toEqual([]));
    expect(calls).toEqual([]);

    const p = planner([meetingRoom, breakRoom]);
    const b = team(3);
    fund(p, b);
    run(p, b, 0, 1200);
    expect(p.currentParties()[0]!.roomId).toBe('b1');
  });
});

describe('PartyPlanner: lifecycle', () => {
  it('pays once, gathers at distinct break-room seats, eats, then everyone walks back and the party disappears', () => {
    const p = planner();
    const actors = team(3);
    const keys = actors.map((a) => a.key);
    const calls = fund(p, actors);
    const types: Record<string, string[]> = {};
    const phases: string[] = [];
    const poses = new Set<string>();
    const seatKeys = new Set(breakRoom.seats.map((s) => k(s.at)));
    let id: string | undefined;
    run(p, actors, 0, 30_000, (_t, d) => {
      const party = p.currentParties()[0];
      phases.push(party?.phase ?? 'none');
      if (party) id ??= party.id;
      const tiles = keys.map((key) => target(d.get(key))).filter((x): x is Point => x !== undefined);
      expect(new Set(tiles.map(k)).size).toBe(tiles.length);
      for (const x of tiles) expect(seatKeys.has(k(x))).toBe(true);
      for (const [key, di] of d) {
        (types[key] ??= []).push(di.type);
        if (di.type !== 'do') continue;
        poses.add(di.pose);
        expect(di).toMatchObject({ activity: 'party', groupId: id });
        expect(di.speech).toBeUndefined();
        expect(di.pose).toBe(party?.phase === 'eating' ? di.pose : 'stand');
        if (di.bubble) expect(['chat_laugh', 'chat_heart', 'chat_music']).toContain(di.bubble);
        expect(di.face).toBe(breakRoom.seats.find((s) => s.at.x === di.at.x && s.at.y === di.at.y)!.face);
      }
    });
    expect(calls).toEqual([{ keys: expect.arrayContaining(keys), sessionId: 's1', now: 1000 }]);
    expect(calls[0]!.keys).toHaveLength(3);
    expect(dedupe(phases)).toEqual(['none', 'gathering', 'eating', 'ending', 'none']);
    for (const key of keys) expect(dedupe(types[key]!)).toEqual(['home', 'go', 'do', 'home']);
    expect(poses).toEqual(new Set(['stand', 'eat', 'talk']));
    expect(p.currentParties()).toEqual([]);
    for (const a of actors) expect(a.pos).toEqual(a.home);
  });

  it('exposes the table, phase, members and times through currentParties() and partyOf()', () => {
    const p = planner();
    const actors = team(3);
    fund(p, actors);
    p.tick(0, actors);
    const d = p.tick(1000, actors);
    const party = p.currentParties()[0]!;
    expect(party).toMatchObject({ sessionId: 's1', roomId: 'b1', roomName: 'Break room', phase: 'gathering', createdAt: 1000, simulated: true });
    expect(party.id).toMatch(/^party-b1-/);
    expect([...party.members].sort()).toEqual(actors.map((a) => a.key).sort());
    expect(party.startedAt).toBeUndefined();
    // The box sits at the centre of the members' seats, on the table rather than on a chair.
    const seats = party.members.map((key) => target(d.get(key))!);
    const centre = { x: Math.round(seats.reduce((s, x) => s + x.x, 0) / 3), y: Math.round(seats.reduce((s, x) => s + x.y, 0) / 3) };
    expect(party.table).toEqual(centre);
    expect(breakRoom.seats.some((s) => k(s.at) === k(party.table))).toBe(false);
    for (const key of party.members) expect(p.partyOf(key)).toEqual(party);
    expect(p.partyOf('nobody')).toBeUndefined();

    run(p, actors, 1000, 400);
    expect(p.currentParties()[0]).toMatchObject({ phase: 'eating', startedAt: 1200, endsAt: 11_200 });
  });

  it('seats the members as close together as possible, near their desks', () => {
    const p = planner([breakRoom], { ...FAST, minMembers: 2 });
    const actors = team(2, 200);
    fund(p, actors);
    p.tick(0, actors);
    const d = p.tick(1000, actors);
    const [a, b] = actors.map((x) => target(d.get(x.key))!) as [Point, Point];
    expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1);
  });

  it('releases members that do not arrive in time, and ends when fewer than two arrived', () => {
    const p = planner([breakRoom], { ...FAST, arrivalTimeout: 3000 });
    const actors = team(4);
    fund(p, actors);
    p.tick(0, actors);
    p.tick(1000, actors);
    const late = actors[3]!;
    for (let t = 1200; t <= 4200; t += 200) {
      const d = p.tick(t, actors);
      for (const a of actors) {
        if (a === late) {
          a.moving = true; // stuck on its way
          continue;
        }
        a.pos = { ...(target(d.get(a.key)) ?? a.home) };
      }
    }
    expect(p.currentParties()[0]).toMatchObject({ phase: 'eating' });
    expect(p.currentParties()[0]!.members).not.toContain(late.key);
    expect(p.tick(4400, actors).get(late.key)).toEqual({ type: 'home', hurry: false });

    const q = planner([breakRoom], { ...FAST, arrivalTimeout: 3000 });
    const b = team(3);
    fund(q, b);
    q.tick(0, b);
    q.tick(1000, b);
    for (let t = 1200; t <= 4200; t += 200) {
      const d = q.tick(t, b);
      b[0]!.pos = { ...(target(d.get(b[0]!.key)) ?? b[0]!.home) };
      b[1]!.moving = true;
      b[2]!.moving = true;
    }
    expect(q.currentParties()).toEqual([]);
  });

  it('leaves one after another about 900 ms apart', () => {
    const p = planner([breakRoom], { ...FAST, maxMembers: 4 });
    const actors = team(4);
    fund(p, actors);
    const left = new Map<string, number>();
    run(p, actors, 0, 20_000, (t, d) => {
      for (const [key, di] of d) if (t > 2000 && di.type === 'home' && !left.has(key)) left.set(key, t);
    });
    const times = [...left.values()].sort((x, y) => x - y);
    expect(times).toHaveLength(4);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(800);
      expect(times[i]! - times[i - 1]!).toBeLessThanOrEqual(1200);
    }
  });
});

describe('PartyPlanner: teams and rooms', () => {
  it('never mixes two sessions, and never runs two parties for one session', () => {
    const mixed = planner([breakRoom, meetingRoom]);
    const pairs = [...team(2, 300, 's1', 1), ...team(2, 300, 's2', 5)];
    const none = fund(mixed, pairs);
    run(mixed, pairs, 0, 20_000, () => expect(mixed.currentParties()).toEqual([]));
    expect(none).toEqual([]);

    // A spare room, so only the one-party-per-team rule keeps the rest of s1 at their desks.
    const spare: RoomInfo = { ...meetingRoom, id: 'm2', name: 'Spare room', x: 30, seats: meetingRoom.seats.map((s) => ({ ...s, at: { x: s.at.x + 10, y: s.at.y } })), presenter: undefined };
    const p = planner([breakRoom, meetingRoom, spare], { ...FAST, maxMembers: 3 });
    const actors = [...team(3, 100, 's1', 1), ...team(3, 100, 's2', 5), ...team(3, 200, 's1', 9).map((a, i) => ({ ...a, key: `s1-extra-${i}` }))];
    const calls = fund(p, actors);
    run(p, actors, 0, 1200);
    const parties = p.currentParties();
    expect(parties.map((x) => x.sessionId).sort()).toEqual(['s1', 's2']);
    expect(new Set(parties.map((x) => x.roomId)).size).toBe(2);
    for (const party of parties) for (const key of party.members) expect(actors.find((a) => a.key === key)!.ctx!.sessionId).toBe(party.sessionId);
    expect(calls.map((c) => c.sessionId).sort()).toEqual(['s1', 's2']);
    run(p, actors, 1200, 8000, () => expect(p.currentParties().filter((x) => x.sessionId === 's1')).toHaveLength(1));
    expect(calls).toHaveLength(2);
  });

  it('never hands out a seat another actor calls home, nor a room another actor is in', () => {
    // A lounger whose home is a break-room chair, away for now: its chair stays free.
    const lounger: Actor = { key: 'lounger', idle: false, home: { x: 11, y: 4 }, pos: { x: 6, y: 1 }, moving: true };
    for (let seed = 1; seed <= 10; seed++) {
      const p = planner([breakRoom], { ...FAST, maxMembers: 5 }, seed);
      const actors = [...team(5, 100), lounger];
      fund(p, actors);
      run(p, actors, 0, 3000, (_t, d) => {
        for (const [key, di] of d) if (key !== 'lounger') expect(k(target(di) ?? actors.find((a) => a.key === key)!.home)).not.toBe('11,4');
      });
      expect(p.currentParties()[0]!.members).toHaveLength(5);
    }

    // Someone else in the break room (maybe in a meeting): the party goes to the meeting room.
    const guest: Actor = { key: 'guest', idle: false, home: { x: 30, y: 1 }, pos: { x: 15, y: 6 }, moving: false, ctx: { kind: 'session', sessionId: 'other', status: 'working' } };
    const p = planner([breakRoom, meetingRoom]);
    const actors = [...team(3), guest];
    fund(p, actors);
    run(p, actors, 0, 1200, (_t, d) => {
      for (const a of actors) {
        const x = target(d.get(a.key));
        if (x && a !== guest) expect(x.x >= 20).toBe(true);
      }
    });
    expect(p.currentParties()[0]!.roomId).toBe('m1');

    const q = planner([breakRoom]);
    const b = [...team(3), { ...guest, pos: { x: 12, y: 3 } }];
    const calls = fund(q, b);
    run(q, b, 0, 20_000, () => expect(q.currentParties()).toEqual([]));
    expect(calls).toEqual([]);
  });

  it('keeps seats of a running party for it: one party per room', () => {
    const p = planner([breakRoom]);
    const actors = [...team(3, 100, 's1', 1), ...team(3, 100, 's2', 5)];
    fund(p, actors);
    run(p, actors, 0, 8000, () => expect(p.currentParties().length).toBeLessThanOrEqual(1));
    expect(p.currentParties()).toHaveLength(1);
  });
});

describe('PartyPlanner: real status wins', () => {
  it('sends a member with real work home in a hurry; the others keep eating', () => {
    const p = planner([breakRoom], { ...FAST, maxMembers: 4 });
    const actors = team(4);
    fund(p, actors);
    const { party, t } = eating(p, actors);
    const [k1, k2, k3, k4] = party.members as [string, string, string, string];
    const a1 = actors.find((a) => a.key === k1)!;
    a1.idle = false;
    a1.ctx = { ...a1.ctx!, status: 'working' };
    let d = p.tick(t, actors);
    expect(d.get(k1)).toEqual({ type: 'home', hurry: true });
    expect([...p.currentParties()[0]!.members].sort()).toEqual([k2, k3, k4].sort());
    for (const key of [k2, k3, k4]) expect(d.get(key)!.type).toBe('do');

    // Claimed by a higher-priority provider while still really idle: leaves calmly.
    actors.find((a) => a.key === k2)!.idle = false;
    d = p.tick(t + 200, actors);
    expect(d.get(k2)).toEqual({ type: 'home', hurry: false });
    expect(p.currentParties()[0]!.members).toHaveLength(2);
    expect(d.get(k1)).toEqual({ type: 'home', hurry: true }); // still on its way back
  });

  it('ends when two of three members leave', () => {
    const p = planner();
    const actors = team(3);
    fund(p, actors);
    const { party, t } = eating(p, actors);
    const [k1, k2, k3] = party.members as [string, string, string];
    const work = (key: string) => {
      const a = actors.find((x) => x.key === key)!;
      a.idle = false;
      a.ctx = { ...a.ctx!, status: 'waiting_permission' };
    };
    work(k1);
    p.tick(t, actors);
    expect(p.currentParties()[0]!.members).toHaveLength(2);
    work(k2);
    const d = p.tick(t + 200, actors);
    expect(d.get(k2)).toEqual({ type: 'home', hurry: true });
    expect(d.get(k3)).toEqual({ type: 'home', hurry: false });
    expect(p.currentParties()).toEqual([]);
  });

  it('always answers idle=false with "home"', () => {
    const toggle = seeded(99);
    const p = planner([breakRoom, meetingRoom], { ...FAST, minMembers: 2 });
    const actors = [...team(4, 1000, 's1', 1), ...team(4, 1000, 's2', 6)];
    p.setFunding(() => true);
    let parties = 0;
    run(p, actors, 0, 60_000, (_t, d) => {
      parties = Math.max(parties, p.currentParties().length);
      for (const a of actors) if (!a.idle) expect(d.get(a.key)!.type).toBe('home');
      for (const a of actors) a.idle = toggle() > 0.05 ? a.idle || toggle() > 0.7 : !a.idle;
    });
    expect(parties).toBeGreaterThan(0);
  });

  it('cleans up on forget, setWorld and setEnabled(false)', () => {
    const p = planner();
    const actors = team(3);
    fund(p, actors);
    const { party, t } = eating(p, actors);
    p.setWorld({ ...world([{ ...breakRoom }]), night: true }); // rebuilt, same room: goes on
    expect(p.currentParties()).toHaveLength(1);
    p.forget(party.members[0]!);
    expect(p.currentParties()[0]!.members).toHaveLength(2);
    p.forget(party.members[1]!);
    expect(p.currentParties()).toEqual([]);
    expect(p.tick(t, actors).get(party.members[2]!)).toEqual({ type: 'home', hurry: false });

    const q = planner();
    const b = team(3);
    fund(q, b);
    eating(q, b);
    q.setWorld(world([meetingRoom])); // the break room is gone
    expect(q.currentParties()).toEqual([]);

    const r = planner();
    const c = team(3, 300);
    fund(r, c);
    const { t: t2 } = eating(r, c);
    r.setEnabled(false);
    expect(r.currentParties()).toEqual([]);
    run(r, c, t2, 20_000, (_t, d) => {
      expect(r.currentParties()).toEqual([]);
      expect([...d.values()].every((x) => x.type === 'home' && !x.hurry)).toBe(true);
    });
    r.setEnabled(true);
    run(r, c, t2 + 20_000, 2000);
    expect(r.currentParties()).toHaveLength(1);
  });
});

describe('PartyPlanner: determinism', () => {
  it('is deterministic for the same seed and never uses Math.random when an rng is given', () => {
    const random = vi.spyOn(Math, 'random');
    const trace = (seed: number) => {
      const p = planner([breakRoom, meetingRoom], { ...FAST, eatMs: [10_000, 20_000] }, seed);
      const actors = [...team(4, 200, 's1', 1), ...team(3, 200, 's2', 6)];
      fund(p, actors, (c) => c.sessionId === 's2' || c.now > 5000); // s1 is refused once
      const out: string[] = [];
      run(p, actors, 0, 40_000, (t, d) => {
        if (t === 5000) actors[1]!.idle = false;
        if (t === 9000) actors[1]!.idle = true;
        out.push(JSON.stringify([...d.entries()]), JSON.stringify(p.currentParties()));
      });
      return out;
    };
    expect(trace(31)).toEqual(trace(31));
    expect(trace(31)).not.toEqual(trace(32));
    expect(random).not.toHaveBeenCalled();
  });

  it('shows occasional icon bubbles while eating, never text', () => {
    const p = planner([breakRoom], { ...FAST, eatMs: [60_000, 60_000], maxMembers: 4 });
    const actors = team(4);
    fund(p, actors);
    let eatingTicks = 0;
    let bubbles = 0;
    run(p, actors, 0, 50_000, (_t, d) => {
      for (const di of d.values()) {
        if (di.type !== 'do' || p.currentParties()[0]?.phase !== 'eating') continue;
        eatingTicks++;
        expect('speech' in di).toBe(false);
        if (di.bubble) bubbles++;
      }
    });
    expect(bubbles).toBeGreaterThan(0);
    expect(bubbles).toBeLessThan(eatingTicks / 3);
  });
});
