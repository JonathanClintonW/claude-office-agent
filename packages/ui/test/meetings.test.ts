import { describe, expect, it } from 'vitest';
import type { Actor, Directive, Point, RoomInfo, Spot, World } from '../src/office/behavior';
import { isTemplateLine } from '../src/office/dialogue';
import { DEFAULT_MEETING_OPTIONS, MeetingScheduler, roomSeats, type MeetingInfo, type MeetingOptions } from '../src/office/meetings';

function seeded(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const FAST: MeetingOptions = {
  ...DEFAULT_MEETING_OPTIONS,
  firstDelay: [1000, 1000],
  interval: [5000, 5000],
  duration: { meeting: [10_000, 10_000], collaboration: [10_000, 10_000], break: [10_000, 10_000] },
  arrivalTimeout: 10_000,
  roomCooldown: 0,
  actorCooldown: 600_000,
  presenterChance: 0,
  maxShare: 1,
};

const meetingRoom: RoomInfo = {
  id: 'm1',
  name: 'Meeting room',
  kind: 'meeting',
  x: 9,
  y: 4,
  w: 5,
  h: 5,
  seats: [
    { at: { x: 10, y: 5 }, face: 'down' },
    { at: { x: 11, y: 5 }, face: 'down' },
    { at: { x: 10, y: 7 }, face: 'up' },
    { at: { x: 11, y: 7 }, face: 'up' },
    { at: { x: 11, y: 7 }, face: 'up' }, // duplicate tile: must not be handed out twice
  ],
  capacity: 4,
  presenter: { at: { x: 12, y: 6 }, face: 'left' },
};
const breakRoom: RoomInfo = {
  id: 'b1',
  name: 'Break room',
  kind: 'break',
  x: 1,
  y: 9,
  w: 5,
  h: 3,
  seats: [
    { at: { x: 2, y: 10 }, face: 'down' },
    { at: { x: 3, y: 10 }, face: 'down' },
    { at: { x: 4, y: 10 }, face: 'down' },
  ],
  capacity: 3,
  presenter: { at: { x: 5, y: 10 }, face: 'left' },
};
const devRoom: RoomInfo = { id: 'd1', name: 'Dev', kind: 'development', x: 0, y: 0, w: 4, h: 4, seats: [{ at: { x: 1, y: 1 }, face: 'up' }, { at: { x: 2, y: 1 }, face: 'up' }], capacity: 2 };
const tinyRoom: RoomInfo = { id: 't1', name: 'Phone booth', kind: 'meeting', x: 20, y: 1, w: 1, h: 1, seats: [{ at: { x: 20, y: 1 }, face: 'up' }], capacity: 4 };

const world = (rooms: RoomInfo[]): World => ({ spots: [], chatTiles: [], rooms, night: false });

function actor(key: string, x: number, y: number, idle = true): Actor {
  return { key, idle, home: { x, y }, pos: { x, y }, moving: false };
}
const crew = (n: number) => Array.from({ length: n }, (_, i) => actor(`a${i}`, i + 1, 1));

/** Run the scheduler, teleporting actors to wherever they are told to go. */
function run(s: MeetingScheduler, actors: Actor[], from: number, ms: number, onTick?: (t: number, d: Map<string, Directive>) => void, step = 200): number {
  let t = from;
  for (; t < from + ms; t += step) {
    const d = s.tick(t, actors);
    onTick?.(t, d);
    for (const a of actors) {
      const di = d.get(a.key);
      if (!di) continue;
      const to = di.type === 'home' ? a.home : di.type === 'go' ? di.to : di.at;
      a.pos = { ...to };
      a.moving = false;
    }
  }
  return t;
}

const tileKey = (d: Directive) => (d.type === 'do' ? `${d.at.x},${d.at.y}` : d.type === 'go' ? `${d.to.x},${d.to.y}` : 'home');

describe('MeetingScheduler: gathering', () => {
  it('waits for the first slot, then gathers 2–5 idle actors to unique seats within capacity', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const s = new MeetingScheduler(seeded(seed), { ...FAST, presenterChance: 0.5 });
      s.setWorld(world([meetingRoom, breakRoom]));
      const actors = crew(9);
      run(s, actors, 0, 800, (_t, d) => expect([...d.values()].every((x) => x.type === 'home')).toBe(true));
      run(s, actors, 1000, 400, (_t, d) => {
        const ms = s.currentMeetings();
        expect(ms.length).toBeGreaterThan(0);
        const inAny = ms.flatMap((m) => m.participants);
        expect(new Set(inAny).size).toBe(inAny.length); // nobody in two meetings
        expect(new Set(ms.map((m) => m.roomId)).size).toBe(ms.length); // one meeting per room
        for (const m of ms) {
          const room = m.roomId === 'm1' ? meetingRoom : breakRoom;
          expect(m.participants.length).toBeGreaterThanOrEqual(2);
          expect(m.participants.length).toBeLessThanOrEqual(Math.min(5, room.capacity));
          const tiles = m.participants.map((k) => tileKey(d.get(k)!));
          expect(new Set(tiles).size).toBe(tiles.length); // unique seats
          expect(tiles).not.toContain('home');
        }
      });
    }
  });

  it('only uses meeting, collaboration and break rooms with room for two', () => {
    const s = new MeetingScheduler(seeded(3), FAST);
    s.setWorld(world([devRoom, tinyRoom]));
    const actors = crew(4);
    run(s, actors, 0, 30_000, () => expect(s.currentMeetings()).toEqual([]));
    expect(roomSeats(meetingRoom)).toHaveLength(4);
  });

  it('never picks actors that are away, moving, not at their desk or not idle', () => {
    const s = new MeetingScheduler(seeded(5), FAST);
    s.setWorld(world([meetingRoom]));
    const a = actor('a', 1, 1);
    const away = { ...actor('away', 2, 1), away: true };
    const moving = { ...actor('moving', 3, 1), moving: true };
    const out = { ...actor('out', 4, 1), pos: { x: 6, y: 6 } };
    const busy = actor('busy', 5, 1, false);
    const fixed = [a, away, moving, out, busy];
    for (let t = 0; t < 20_000; t += 200) {
      s.tick(t, fixed);
      expect(s.currentMeetings()).toEqual([]);
    }
    const b = actor('b', 7, 1);
    s.tick(25_000, [...fixed, b]);
    expect(s.currentMeetings().map((m) => [...m.participants].sort())).toEqual([['a', 'b']]);
  });
});

describe('MeetingScheduler: lifecycle', () => {
  it('goes through arrival (go) → meeting (do, sit_meeting, groupId) → departure (home)', () => {
    const s = new MeetingScheduler(seeded(11), FAST);
    s.setWorld(world([meetingRoom]));
    const actors = crew(3);
    const types: Record<string, string[]> = {};
    const phases: string[] = [];
    let groupId: string | undefined;
    run(s, actors, 0, 14_000, (_t, d) => {
      const m = s.currentMeetings()[0];
      phases.push(m?.phase ?? 'none');
      for (const [k, di] of d) {
        (types[k] ??= []).push(di.type);
        if (di.type === 'do') {
          expect(di.pose).toBe('sit_meeting');
          expect(di.activity).toBe('meeting');
          expect(di.speech).toBeUndefined();
          groupId ??= di.groupId;
          expect(di.groupId).toBe(groupId);
          expect(di.groupId).toBe(m?.id);
        }
      }
    });
    const participants = Object.keys(types).filter((k) => types[k]!.includes('do'));
    expect(participants.length).toBeGreaterThanOrEqual(2);
    for (const k of participants) {
      const seq = types[k]!.filter((x, i, arr) => i === 0 || arr[i - 1] !== x);
      expect(seq).toEqual(['home', 'go', 'do', 'home']);
    }
    expect(phases.filter((p, i, arr) => i === 0 || arr[i - 1] !== p)).toEqual(['none', 'gathering', 'meeting', 'ending', 'none']);
    for (const a of actors) expect(a.pos).toEqual(a.home);
  });

  it('starts only once every participant has arrived', () => {
    const s = new MeetingScheduler(seeded(8), { ...FAST, minParticipants: 3, maxParticipants: 3, arrivalTimeout: 20_000 });
    s.setWorld(world([meetingRoom]));
    const actors = crew(3);
    s.tick(0, actors);
    s.tick(1000, actors);
    const [k1, k2, k3] = s.currentMeetings()[0]!.participants as [string, string, string];
    const late = actors.find((a) => a.key === k3)!;
    for (let t = 1200; t <= 5000; t += 200) {
      const d = s.tick(t, actors);
      expect(s.currentMeetings()[0]!.phase).toBe('gathering');
      for (const k of [k1, k2]) {
        const di = d.get(k)!;
        if (di.type === 'do') expect(di.bubble).toBeUndefined(); // seated and waiting: no bubbles yet
        const a = actors.find((x) => x.key === k)!;
        a.pos = di.type === 'go' ? { ...di.to } : di.type === 'do' ? { ...di.at } : { ...a.home };
      }
      late.moving = true; // still on its way
    }
    const seat = s.tick(5200, actors).get(k3)!;
    expect(seat.type).toBe('go');
    late.moving = false;
    late.pos = seat.type === 'go' ? { ...seat.to } : late.pos;
    s.tick(5400, actors);
    expect(s.currentMeetings()[0]).toMatchObject({ phase: 'meeting', startedAt: 5400 });
  });

  it('ends with a staggered departure: participants leave one after another', () => {
    const s = new MeetingScheduler(seeded(11), { ...FAST, minParticipants: 4, maxParticipants: 4, departureStagger: 900 });
    s.setWorld(world([meetingRoom]));
    const actors = crew(4);
    const left = new Map<string, number>();
    let endingSeen = 0;
    run(s, actors, 0, 20_000, (t, d) => {
      const m = s.currentMeetings()[0];
      if (m?.phase === 'ending') {
        endingSeen++;
        // Whoever has not left yet stays seated, without bubbles.
        for (const k of m.participants) expect(d.get(k)).toMatchObject({ type: 'do', pose: 'sit_meeting' });
        expect([...d.values()].every((x) => x.type !== 'do' || x.bubble === undefined)).toBe(true);
      }
      for (const [k, di] of d) if (di.type === 'home' && !left.has(k) && s.meetingOf(k) === undefined && t > 2000) left.set(k, t);
    });
    expect(endingSeen).toBeGreaterThan(0);
    const times = [...left.values()].sort((x, y) => x - y);
    expect(times).toHaveLength(4);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(800);
      expect(times[i]! - times[i - 1]!).toBeLessThanOrEqual(1200);
    }
    expect(s.currentMeetings()).toEqual([]);
  });

  it('runs meetings in several rooms at once, each within its capacity', () => {
    const smallRoom: RoomInfo = { ...meetingRoom, id: 'm2', name: 'Small room', x: 20, y: 4, seats: [10, 11, 12, 13].map((x) => ({ at: { x: x + 10, y: 5 }, face: 'down' as const })), capacity: 2, presenter: undefined };
    let together = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const s = new MeetingScheduler(seeded(seed), { ...FAST, actorCooldown: 0, interval: [800, 800], maxConcurrent: 2 });
      s.setWorld(world([meetingRoom, smallRoom]));
      const actors = crew(10);
      run(s, actors, 0, 30_000, () => {
        const ms = s.currentMeetings();
        if (ms.length === 2) together++;
        expect(ms.length).toBeLessThanOrEqual(2);
        for (const m of ms) expect(m.participants.length).toBeLessThanOrEqual(m.roomId === 'm2' ? 2 : 4);
      });
    }
    expect(together).toBeGreaterThan(0);
  });

  it('honours room and actor cooldowns', () => {
    const s = new MeetingScheduler(seeded(13), { ...FAST, interval: [500, 500], roomCooldown: 20_000, actorCooldown: 40_000, minParticipants: 2, maxParticipants: 2 });
    s.setWorld(world([meetingRoom]));
    const actors = crew(6);
    let ended = 0;
    let roomFreeAt: number | undefined;
    const leftAt = new Map<string, number>(); // actor -> when it last left a meeting
    let rejoined = 0;
    let prev: ReturnType<MeetingScheduler['currentMeetings']> = [];
    run(s, actors, 0, 200_000, (t) => {
      const ms = s.currentMeetings();
      for (const m of prev) {
        if (!ms.some((x) => x.id === m.id)) {
          ended++;
          roomFreeAt = t;
        }
        for (const k of m.participants) if (!ms.some((x) => x.participants.includes(k))) leftAt.set(k, t);
      }
      for (const m of ms) {
        if (prev.some((x) => x.id === m.id)) continue;
        // A new meeting in the room only after the room cooldown...
        if (roomFreeAt !== undefined) expect(m.createdAt - roomFreeAt).toBeGreaterThanOrEqual(20_000);
        // ...and with actors only after their own cooldown.
        for (const k of m.participants) {
          const last = leftAt.get(k);
          if (last === undefined) continue;
          rejoined++;
          expect(m.createdAt - last).toBeGreaterThanOrEqual(40_000);
        }
      }
      prev = ms;
    });
    expect(ended).toBeGreaterThan(2);
    expect(rejoined).toBeGreaterThan(0);
  });

  it('never hands out a seat another actor stands on or calls home', () => {
    const blocker = actor('lounge', 10, 5); // an agent without a desk waiting on a meeting chair
    for (let seed = 1; seed <= 20; seed++) {
      const s = new MeetingScheduler(seeded(seed), { ...FAST, presenterChance: 0.5, minParticipants: 4, maxParticipants: 5 });
      s.setWorld(world([meetingRoom]));
      const actors = [...crew(6), { ...blocker, idle: false }];
      run(s, actors, 0, 6000, (_t, d) => {
        for (const [k, di] of d) if (k !== 'lounge' && di.type !== 'home') expect(tileKey(di)).not.toBe('10,5');
        for (const m of s.currentMeetings()) expect(m.participants.length).toBeLessThanOrEqual(4); // 3 free seats + presenter
      });
    }
  });

  it('places the presenter at the presenter spot with pose "present"', () => {
    const s = new MeetingScheduler(seeded(2), { ...FAST, presenterChance: 1, minParticipants: 3, maxParticipants: 3 });
    s.setWorld(world([meetingRoom]));
    const actors = crew(3);
    const poses = new Map<string, Set<string>>();
    run(s, actors, 0, 6000, (_t, d) => {
      for (const [k, di] of d) if (di.type === 'do') (poses.get(k) ?? poses.set(k, new Set()).get(k)!).add(`${di.pose}@${di.at.x},${di.at.y}`);
    });
    const m = s.currentMeetings()[0]!;
    expect(m.presenter).toBeDefined();
    expect(poses.get(m.presenter!)).toContain('present@12,6');
    for (const k of m.participants.filter((x) => x !== m.presenter)) expect([...poses.get(k)!].every((p) => p.startsWith('sit_meeting'))).toBe(true);
  });

  it('runs group breaks in break rooms without a presenter', () => {
    const s = new MeetingScheduler(seeded(4), { ...FAST, presenterChance: 1 });
    s.setWorld(world([breakRoom]));
    const actors = crew(5);
    const seen = new Set<string>();
    run(s, actors, 0, 8000, (_t, d) => {
      for (const di of d.values()) if (di.type === 'do') seen.add(`${di.activity}/${di.pose}`);
    });
    expect([...seen]).toEqual(['group_break/sit_meeting']);
    expect(s.currentMeetings()[0]!.presenter).toBeUndefined();
    expect(s.currentMeetings()[0]!.participants.length).toBeLessThanOrEqual(3);
  });

  it('shows occasional icon bubbles only, never text', () => {
    const s = new MeetingScheduler(seeded(9), { ...FAST, duration: { ...FAST.duration, meeting: [60_000, 60_000] } });
    s.setWorld(world([meetingRoom]));
    const actors = crew(4);
    const icons = new Set<string>();
    let doTicks = 0;
    let bubbleTicks = 0;
    run(s, actors, 0, 50_000, (_t, d) => {
      for (const di of d.values()) {
        if (di.type !== 'do') continue;
        doTicks++;
        expect('speech' in di).toBe(false);
        if (di.bubble) {
          bubbleTicks++;
          icons.add(di.bubble);
          expect(di.bubble).toMatch(/^chat_/);
        }
      }
    });
    expect(bubbleTicks).toBeGreaterThan(0);
    expect(bubbleTicks).toBeLessThan(doTicks / 2);
  });
});

describe('MeetingScheduler: interruptions', () => {
  const three = { ...FAST, minParticipants: 3, maxParticipants: 3 };

  it('sends an interrupted actor home in a hurry; the meeting continues while ≥2 remain', () => {
    const s = new MeetingScheduler(seeded(6), three);
    s.setWorld(world([meetingRoom]));
    const actors = crew(3);
    run(s, actors, 0, 2000);
    const m = s.currentMeetings()[0]!;
    expect(m.phase).toBe('meeting');
    const [k1, k2, k3] = m.participants as [string, string, string];
    const a1 = actors.find((a) => a.key === k1)!;
    a1.idle = false;
    let d = s.tick(2000, actors);
    expect(d.get(k1)).toEqual({ type: 'home', hurry: true });
    expect(s.currentMeetings()[0]!.participants.sort()).toEqual([k2, k3].sort());
    expect(d.get(k2)!.type).toBe('do');
    a1.pos = { ...a1.home };
    d = s.tick(2200, actors);
    expect(d.get(k1)).toEqual({ type: 'home', hurry: false });

    // Second interruption: only one would remain, so the meeting ends for everyone.
    actors.find((a) => a.key === k2)!.idle = false;
    d = s.tick(2400, actors);
    expect(d.get(k2)).toEqual({ type: 'home', hurry: true });
    expect(d.get(k3)).toEqual({ type: 'home', hurry: false });
    expect(s.currentMeetings()).toEqual([]);
  });

  it('hurries on a real status change, leaves calmly when a higher-priority provider claims the actor', () => {
    const s = new MeetingScheduler(seeded(6), { ...FAST, minParticipants: 3, maxParticipants: 3 });
    s.setWorld(world([meetingRoom]));
    const actors: Actor[] = crew(3).map((a) => ({ ...a, ctx: { kind: 'subagent', sessionId: 's', status: 'idle' } }));
    run(s, actors, 0, 2000);
    const [k1, k2] = s.currentMeetings()[0]!.participants as [string, string, string];
    const a1 = actors.find((a) => a.key === k1)!;
    a1.idle = false; // claimed (e.g. by a verified handoff); real status still idle
    expect(s.tick(2000, actors).get(k1)).toEqual({ type: 'home', hurry: false });
    expect(s.currentMeetings()[0]!.participants).toHaveLength(2); // continues with two
    const a2 = actors.find((a) => a.key === k2)!;
    a2.idle = false;
    a2.ctx = { ...a2.ctx!, status: 'waiting_permission' };
    expect(s.tick(2200, actors).get(k2)).toEqual({ type: 'home', hurry: true });
    expect(s.currentMeetings()).toEqual([]);
  });

  it('hurries actors already walking back once real work arrives', () => {
    const s = new MeetingScheduler(seeded(6), FAST);
    s.setWorld(world([meetingRoom]));
    const actors = crew(2);
    run(s, actors, 0, 2000);
    s.setEnabled(false); // meeting ends calmly; actors are on their way back
    const a = actors[0]!;
    expect(s.tick(2000, actors).get(a.key)).toEqual({ type: 'home', hurry: false });
    a.idle = false;
    expect(s.tick(2200, actors).get(a.key)).toEqual({ type: 'home', hurry: true });
  });

  it('releases participants that do not arrive in time', () => {
    const s = new MeetingScheduler(seeded(8), { ...three, arrivalTimeout: 3000 });
    s.setWorld(world([meetingRoom]));
    const actors = crew(3);
    s.tick(0, actors); // schedules the first slot at 1000
    s.tick(1000, actors);
    const m = s.currentMeetings()[0]!;
    // Two walk to their seats; the third is stuck.
    const [k1, k2, k3] = m.participants as [string, string, string];
    for (let t = 1200; t <= 4200; t += 200) {
      const d = s.tick(t, actors);
      for (const a of actors) {
        const di = d.get(a.key)!;
        if (a.key === k3) {
          a.moving = true;
          continue;
        }
        a.pos = di.type === 'go' ? { ...di.to } : di.type === 'do' ? { ...di.at } : { ...a.home };
      }
    }
    const now = s.currentMeetings()[0]!;
    expect(now.phase).toBe('meeting');
    expect(now.participants.sort()).toEqual([k1, k2].sort());
  });

  it('always answers idle=false with "home", whatever happens', () => {
    const toggle = seeded(99);
    for (let seed = 1; seed <= 5; seed++) {
      const s = new MeetingScheduler(seeded(seed), { ...FAST, actorCooldown: 0, interval: [1000, 1000] });
      s.setWorld(world([meetingRoom, breakRoom]));
      const actors = crew(8);
      run(s, actors, 0, 60_000, (_t, d) => {
        for (const a of actors) if (!a.idle) expect(d.get(a.key)!.type).toBe('home');
        for (const a of actors) a.idle = toggle() > 0.08 ? a.idle || toggle() > 0.7 : !a.idle;
      });
    }
  });
});

describe('MeetingScheduler: duplicates, cleanup, frequency, determinism', () => {
  it('never runs two meetings in one room or puts an actor in two meetings', () => {
    const s = new MeetingScheduler(seeded(12), { ...FAST, actorCooldown: 0, interval: [500, 500], maxConcurrent: 3 });
    s.setWorld(world([meetingRoom, breakRoom]));
    const actors = crew(12);
    const ids = new Set<string>();
    run(s, actors, 0, 120_000, () => {
      const ms = s.currentMeetings();
      for (const m of ms) ids.add(m.id);
      expect(ms.length).toBeLessThanOrEqual(2);
      expect(new Set(ms.map((m) => m.roomId)).size).toBe(ms.length);
      const all = ms.flatMap((m) => m.participants);
      expect(new Set(all).size).toBe(all.length);
    });
    expect(ids.size).toBeGreaterThan(3);
  });

  it('cleans up on forget, setWorld and setEnabled(false)', () => {
    const s = new MeetingScheduler(seeded(6), FAST);
    s.setWorld(world([meetingRoom]));
    const actors = crew(2);
    run(s, actors, 0, 2000);
    expect(s.currentMeetings()).toHaveLength(1);
    // Rebuilt world with the same room (e.g. day → night): the meeting continues.
    s.setWorld({ ...world([{ ...meetingRoom }]), night: true });
    expect(s.currentMeetings()).toHaveLength(1);
    s.forget(actors[0]!.key);
    expect(s.currentMeetings()).toEqual([]);
    expect(s.tick(2200, actors).get(actors[1]!.key)!.type).toBe('home');

    const s2 = new MeetingScheduler(seeded(6), FAST);
    s2.setWorld(world([meetingRoom]));
    const b = crew(3);
    run(s2, b, 0, 2000);
    expect(s2.currentMeetings()).toHaveLength(1);
    s2.setWorld(world([{ ...meetingRoom, seats: meetingRoom.seats.slice(1) }])); // room changed
    expect(s2.currentMeetings()).toEqual([]);
    expect([...s2.tick(2200, b).values()].every((d) => d.type === 'home')).toBe(true);

    const s3 = new MeetingScheduler(seeded(6), FAST);
    s3.setWorld(world([meetingRoom]));
    const c = crew(3);
    run(s3, c, 0, 2000);
    s3.setEnabled(false);
    expect(s3.currentMeetings()).toEqual([]);
    run(s3, c, 2000, 30_000, (_t, d) => expect([...d.values()].every((x) => x.type === 'home')).toBe(true));
    s3.setEnabled(true);
    run(s3, c.map((x) => ({ ...x })), 700_000, 3000);
    expect(s3.currentMeetings()).toHaveLength(1);
  });

  it('honours the frequency multiplier (0 = never)', () => {
    const count = (freq: number) => {
      const s = new MeetingScheduler(seeded(21), { ...FAST, actorCooldown: 0, interval: [10_000, 10_000], duration: { meeting: [2000, 2000], collaboration: [2000, 2000], break: [2000, 2000] } });
      s.setFrequency(freq);
      s.setWorld(world([meetingRoom]));
      const ids = new Set<string>();
      run(s, crew(4), 0, 200_000, () => s.currentMeetings().forEach((m) => ids.add(m.id)));
      return ids.size;
    };
    expect(count(0)).toBe(0);
    const low = count(0.5);
    const normal = count(1);
    const high = count(2);
    expect(low).toBeGreaterThan(0);
    expect(normal).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(normal);
  });

  it('is deterministic for the same seed and inputs', () => {
    const trace = (seed: number) => {
      const s = new MeetingScheduler(seeded(seed), { ...FAST, presenterChance: 0.5, actorCooldown: 5000 });
      s.setWorld(world([meetingRoom, breakRoom]));
      const actors = crew(7);
      const out: string[] = [];
      run(s, actors, 0, 60_000, (t, d) => {
        if (t === 20_000) actors[2]!.idle = false;
        if (t === 30_000) actors[2]!.idle = true;
        out.push(JSON.stringify([...d.entries()]));
      });
      return out;
    };
    expect(trace(31)).toEqual(trace(31));
    expect(trace(31)).not.toEqual(trace(32));
  });
});

const k = (p: Point) => `${p.x},${p.y}`;

/** A walkable floor; chat tiles like world.ts builds them (never a home/desk seat or a spot tile). */
function floorWorld(rooms: RoomInfo[], spots: Spot[], homes: Point[], opts: { cols?: number; rows?: number; blocked?: Point[] } = {}): World {
  const cols = opts.cols ?? 30;
  const rows = opts.rows ?? 16;
  const blocked = new Set((opts.blocked ?? []).map(k));
  const reserved = new Set([...homes, ...spots.map((s) => s.at)].map(k));
  const walk = (p: Point) => p.x >= 0 && p.y >= 1 && p.x < cols && p.y < rows && !blocked.has(k(p));
  const free = (p: Point) => walk(p) && !reserved.has(k(p));
  const chatTiles: Point[] = [];
  for (let y = 1; y < rows; y++) for (let x = 0; x < cols - 1; x++) if (free({ x, y }) && free({ x: x + 1, y })) chatTiles.push({ x, y });
  return { spots, chatTiles, rooms, night: false, isWalkable: walk };
}

/** A break room without a table: only standing gatherings are possible there. */
const lounge: RoomInfo = { id: 'b2', name: 'Break room', kind: 'break', x: 14, y: 6, w: 8, h: 6, seats: [], capacity: 0 };
const coffee: Spot = { id: 'coffee-1', kind: 'coffee', at: { x: 15, y: 7 }, face: 'up', roomId: 'b2' };
const SOCIAL: MeetingOptions = { ...FAST, socialChance: 1, socialDuration: [12_000, 12_000], actorCooldown: 0, interval: [3000, 3000], hourOf: () => 12 };
const homesOf = (actors: Actor[]) => actors.map((a) => a.home);

/** The empty tile every participant stands next to (the centre of the circle). */
function centreOf(tiles: Point[]): Point | undefined {
  const xs = tiles.map((t) => t.x);
  const ys = tiles.map((t) => t.y);
  for (let y = Math.min(...ys) - 1; y <= Math.max(...ys) + 1; y++)
    for (let x = Math.min(...xs) - 1; x <= Math.max(...xs) + 1; x++) {
      const c = { x, y };
      if (tiles.every((t) => !(t.x === x && t.y === y) && Math.max(Math.abs(t.x - x), Math.abs(t.y - y)) === 1)) return c;
    }
  return undefined;
}

describe('MeetingScheduler: social gatherings', () => {
  it('gathers 3–4 idle agents standing in a circle in a common area, facing its empty centre', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const s = new MeetingScheduler(seeded(seed), SOCIAL);
      const actors = crew(6);
      s.setWorld(floorWorld([lounge], [coffee], homesOf(actors)));
      let checked = false;
      run(s, actors, 0, 3000, (_t, d) => {
        const m = s.currentMeetings()[0];
        if (!m || m.phase === 'gathering' || checked) return;
        checked = true;
        expect(m).toMatchObject({ kind: 'social', topic: 'coffee', roomId: 'b2', roomName: 'Break room', simulated: true });
        expect(m.participants.length).toBeGreaterThanOrEqual(3);
        expect(m.participants.length).toBeLessThanOrEqual(4);
        const dos = m.participants.map((p) => d.get(p)!) as Array<Extract<Directive, { type: 'do' }>>;
        expect(dos.every((x) => x.type === 'do' && x.activity === 'coffee_chat' && x.groupId === m.id)).toBe(true);
        const tiles = dos.map((x) => x.at);
        expect(new Set(tiles.map(k)).size).toBe(tiles.length);
        for (const t of tiles) expect(t.x >= 14 && t.x < 22 && t.y >= 6 && t.y < 12).toBe(true);
        const c = centreOf(tiles)!;
        expect(c).toBeDefined();
        expect(k(c)).not.toBe(k(coffee.at));
        for (const x of dos) expect(x.face).toBe(x.at.x < c.x ? 'right' : x.at.x > c.x ? 'left' : x.at.y < c.y ? 'down' : 'up');
      });
      expect(checked).toBe(true);
    }
  });

  it('talks one at a time in icons and verbatim template lines, only once everyone is there', () => {
    const lines = new Set<string>();
    const poses = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const s = new MeetingScheduler(seeded(seed), { ...SOCIAL, socialSpeechChance: 0.5 });
      const actors = crew(5).map((a) => ({ ...a, ctx: { kind: 'subagent' as const, sessionId: 's', status: 'idle' as const } }));
      s.setWorld(floorWorld([lounge], [coffee], homesOf(actors)));
      run(s, actors, 0, 30_000, (_t, d) => {
        const m = s.currentMeetings()[0];
        const talking = [...d.values()].filter((x) => x.type === 'do' && (x.speech !== undefined || x.bubble !== undefined));
        expect(talking.length).toBeLessThanOrEqual(1);
        for (const x of d.values()) {
          if (x.type !== 'do') continue;
          poses.add(x.pose);
          if (x.speech === undefined) continue;
          expect(m?.phase).toBe('meeting');
          expect(isTemplateLine(x.speech)).toBe(true);
          expect(x.bubble).toBeUndefined();
          lines.add(x.speech);
        }
      });
    }
    expect(lines.size).toBeGreaterThan(2);
    expect([...poses].every((p) => ['stand', 'talk', 'drink', 'wave'].includes(p))).toBe(true);
    expect(poses).toContain('talk');
  });

  it('never gathers just two agents (two-person chats belong to idle life)', () => {
    const s = new MeetingScheduler(seeded(3), SOCIAL);
    const actors = crew(2);
    s.setWorld(floorWorld([lounge], [coffee], homesOf(actors)));
    run(s, actors, 0, 60_000, () => expect(s.currentMeetings()).toEqual([]));
  });

  it('waves and leaves one after another at the end', () => {
    const s = new MeetingScheduler(seeded(4), { ...SOCIAL, socialSize: [4, 4], departureStagger: 1000 });
    const actors = crew(4);
    s.setWorld(floorWorld([lounge], [coffee], homesOf(actors)));
    const waved = new Set<string>();
    const left = new Map<string, number>();
    let started = false;
    run(s, actors, 0, 25_000, (t, d) => {
      if (s.currentMeetings()[0]?.phase === 'meeting') started = true;
      for (const [key, x] of d) {
        if (x.type === 'do' && x.pose === 'wave') {
          waved.add(key);
          expect(s.currentMeetings()[0]!.phase).toBe('ending');
        }
        if (started && x.type === 'home' && !left.has(key)) left.set(key, t);
      }
    });
    expect(waved.size).toBe(4);
    const times = [...left.values()].sort((x, y) => x - y);
    expect(times).toHaveLength(4);
    for (let i = 1; i < 4; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1000);
  });

  it('continues with two after an interruption once under way, but needs three to begin', () => {
    const s = new MeetingScheduler(seeded(5), { ...SOCIAL, socialSize: [3, 3] });
    const actors = crew(3);
    s.setWorld(floorWorld([lounge], [coffee], homesOf(actors)));
    run(s, actors, 0, 1600);
    expect(s.currentMeetings()[0]!.phase).toBe('meeting');
    const [k1] = s.currentMeetings()[0]!.participants as [string];
    actors.find((a) => a.key === k1)!.idle = false;
    expect(s.tick(1600, actors).get(k1)).toEqual({ type: 'home', hurry: true });
    expect(s.currentMeetings()[0]!.participants).toHaveLength(2);

    const s2 = new MeetingScheduler(seeded(5), { ...SOCIAL, socialSize: [3, 3] });
    const b = crew(3);
    s2.setWorld(floorWorld([lounge], [coffee], homesOf(b)));
    s2.tick(0, b);
    s2.tick(1000, b); // gathering: nobody has arrived yet
    const m = s2.currentMeetings()[0]!;
    expect(m.phase).toBe('gathering');
    b.find((a) => a.key === m.participants[0])!.idle = false;
    const d = s2.tick(1200, b);
    expect(s2.currentMeetings()).toEqual([]);
    for (const p of m.participants.slice(1)) expect(d.get(p)!.type).toBe('home');
  });

  it('uses lounge spots outside rooms, but never spots in department rooms', () => {
    const open: Spot = { id: 'cooler-1', kind: 'water', at: { x: 20, y: 9 }, face: 'up' };
    const s = new MeetingScheduler(seeded(6), SOCIAL);
    const actors = crew(4);
    s.setWorld(floorWorld([], [open], homesOf(actors)));
    run(s, actors, 0, 1200);
    expect(s.currentMeetings()[0]).toMatchObject({ kind: 'social', roomId: 'spot:cooler-1', roomName: 'Water cooler', topic: 'coffee' });

    const dev: RoomInfo = { id: 'dev', name: 'Dev', kind: 'development', x: 14, y: 6, w: 8, h: 6, seats: [], capacity: 0 };
    const s2 = new MeetingScheduler(seeded(6), SOCIAL);
    const b = crew(4);
    s2.setWorld(floorWorld([dev], [{ ...coffee, roomId: 'dev' }], homesOf(b)));
    run(s2, b, 0, 30_000, () => expect(s2.currentMeetings()).toEqual([]));
  });

  it('holds team discussions in collaboration rooms and mixes with seated meetings', () => {
    const collab: RoomInfo = { id: 'c1', name: 'Collaboration', kind: 'collaboration', x: 1, y: 6, w: 10, h: 8, seats: [], capacity: 0 };
    const board: Spot = { id: 'wb-1', kind: 'whiteboard', at: { x: 5, y: 7 }, face: 'up', roomId: 'c1' };
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const s = new MeetingScheduler(seeded(seed), { ...SOCIAL, socialChance: 0.5 });
      const actors = crew(8);
      s.setWorld(floorWorld([collab, meetingRoom], [board], homesOf(actors)));
      run(s, actors, 0, 6000, (_t, d) => {
        for (const m of s.currentMeetings()) {
          kinds.add(m.kind === 'social' ? `social/${m.topic}` : m.kind);
          if (m.kind === 'social' && m.phase !== 'gathering') for (const p of m.participants) expect(d.get(p)).toMatchObject({ activity: 'team_discussion' });
        }
      });
    }
    expect(kinds).toEqual(new Set(['social/discussion', 'meeting']));
  });

  it('ends when its tiles become blocked, survives an unchanged rebuild', () => {
    const s = new MeetingScheduler(seeded(7), SOCIAL);
    const actors = crew(4);
    const w = floorWorld([lounge], [coffee], homesOf(actors));
    s.setWorld(w);
    run(s, actors, 0, 1600);
    const m = s.currentMeetings()[0]!;
    s.setWorld({ ...floorWorld([{ ...lounge }], [{ ...coffee }], homesOf(actors)), night: true });
    expect(s.currentMeetings().map((x) => x.id)).toEqual([m.id]);
    const d = s.tick(1600, actors).get(m.participants[0]!) as Extract<Directive, { type: 'do' }>;
    s.setWorld(floorWorld([lounge], [coffee], homesOf(actors), { blocked: [d.at] })); // furniture placed on a participant's tile
    expect(s.currentMeetings()).toEqual([]);
    expect([...s.tick(1800, actors).values()].every((x) => x.type === 'home')).toBe(true);
  });
});

describe('MeetingScheduler: invariants', () => {
  it('never puts two actors on one tile, nor anyone on another actor’s home, across concurrent activities', () => {
    const breakRoom2: RoomInfo = { ...breakRoom, id: 'b3', x: 1, y: 9 };
    const toggle = seeded(77);
    const seen = new Set<MeetingInfo['kind']>();
    const problems: string[] = [];
    for (let seed = 1; seed <= 5; seed++) {
      const s = new MeetingScheduler(seeded(seed), { ...FAST, socialChance: 0.5, actorCooldown: 0, interval: [700, 700], maxConcurrent: 3, presenterChance: 0.5 });
      const actors = crew(12);
      actors.push({ ...actor('lounger', 16, 9), idle: false }); // waits in the break room, never idle
      s.setWorld(floorWorld([meetingRoom, breakRoom2, lounge], [coffee], homesOf(actors)));
      const homes = new Map(actors.map((a) => [k(a.home), a.key]));
      run(s, actors, 0, 60_000, (t, d) => {
        for (const m of s.currentMeetings()) seen.add(m.kind);
        const targets = new Map<string, string>();
        for (const [key, x] of d) {
          if (x.type === 'home') continue;
          const at = tileKey(x);
          if (targets.has(at)) problems.push(`${t}: ${key} and ${targets.get(at)} on ${at}`);
          targets.set(at, key);
          const owner = homes.get(at);
          if (owner !== undefined && owner !== key) problems.push(`${t}: ${key} on the home of ${owner}`);
        }
        for (const a of actors) {
          if (!a.idle && d.get(a.key)!.type !== 'home') problems.push(`${t}: ${a.key} is not idle but was not sent home`);
          if (a.key !== 'lounger' && toggle() < 0.01) a.idle = !a.idle;
        }
      });
    }
    expect(problems).toEqual([]);
    expect(seen.has('social')).toBe(true);
    expect(seen.has('meeting') || seen.has('break')).toBe(true);
  });

  it('is deterministic with social gatherings too', () => {
    const trace = (seed: number) => {
      const s = new MeetingScheduler(seeded(seed), { ...SOCIAL, socialChance: 0.5 });
      const actors = crew(7).map((a) => ({ ...a, ctx: { kind: 'subagent' as const, sessionId: 's', status: 'idle' as const } }));
      s.setWorld(floorWorld([lounge, meetingRoom], [coffee], homesOf(actors)));
      const out: string[] = [];
      run(s, actors, 0, 40_000, (_t, d) => out.push(JSON.stringify([...d.entries()])));
      return out;
    };
    expect(trace(41)).toEqual(trace(41));
    expect(trace(41)).not.toEqual(trace(42));
  });
});
