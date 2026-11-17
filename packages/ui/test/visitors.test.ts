import { describe, expect, it } from 'vitest';
import { blockedTiles, defaultLayout, openOfficeLayout, type OfficeLayout } from '@agent-office/core';
import { DIALOGUE_RULES, DIALOGUE_TABLE } from '../src/office/dialogue';
import { DEFAULT_VISITOR_OPTIONS, VisitorDirector, type VisitorBody, type VisitorDirective, type VisitorOptions, type VisitorWorld } from '../src/office/visitors';
import { buildWorld } from '../src/office/world';

function seeded(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;

function worldOf(layout: OfficeLayout, night = false): VisitorWorld {
  return { ...buildWorld(layout, [2, 6, 10, 14, 18, 22], night), door: { x: layout.door.x, y: layout.rows } };
}

/** Busy office: visitors come often, so a short run sees plenty of them (no group meetings unless a test asks). */
const BUSY: VisitorOptions = { ...DEFAULT_VISITOR_OPTIONS, firstArrival: [1_000, 1_000], arrivalGap: [3_000, 6_000], meetingChance: 0 };
/** Every arrival is a meeting group when a room is free; short meetings. */
const MEETINGS: VisitorOptions = { ...BUSY, meetingChance: 1, meetingDuration: [10_000, 10_000] };

/** Lines visitors may say: families marked for visitors or for both. */
const VISITOR_LINES = new Set(DIALOGUE_RULES.filter((r) => r.speakers === 'visitors' || r.speakers === 'both').flatMap((r) => DIALOGUE_TABLE[r.family]));

/**
 * Run the director like the scene does, teleporting bodies to wherever they are sent. Bodies
 * the director no longer lists are removed (they walked out).
 */
function run(
  d: VisitorDirector,
  door: { x: number; y: number },
  from: number,
  ms: number,
  onTick?: (t: number, m: Map<string, VisitorDirective>, bodies: Map<string, VisitorBody>) => void,
  taken: () => ReadonlySet<string> = () => new Set(),
  bodies = new Map<string, VisitorBody>(),
  step = 200,
): number {
  let t = from;
  for (; t < from + ms; t += step) {
    const m = d.tick(t, [...bodies.values()], taken());
    for (const [id, di] of m) {
      const b = bodies.get(id) ?? { id, pos: { ...door }, moving: false };
      if (di.type === 'go' || di.type === 'leave') b.pos = { ...di.to };
      else if (di.type === 'do') b.pos = { ...di.at };
      bodies.set(id, b);
    }
    for (const id of [...bodies.keys()]) if (!m.has(id)) bodies.delete(id);
    onTick?.(t, m, bodies);
  }
  return t;
}

describe('buildWorld reception counters', () => {
  it('finds a free tile in front of the reception desk', () => {
    const layout = defaultLayout();
    const w = buildWorld(layout, [], false);
    expect(w.counters.length).toBeGreaterThan(0);
    const blocked = blockedTiles(layout);
    for (const c of w.counters) {
      expect(blocked.has(key(c.at))).toBe(false);
      expect(layout.items.find((i) => i.id === c.id)?.type).toBe('reception');
    }
  });
});

describe('VisitorDirector', () => {
  it('brings visitors in even with no agents at all, and lets them leave again', () => {
    const layout = defaultLayout();
    const world = worldOf(layout);
    const d = new VisitorDirector(seeded(), BUSY);
    d.setWorld(world);
    const arrived = new Set<string>();
    const activities = new Set<string>();
    let most = 0;
    run(d, world.door, 0, 10 * 60_000, (_t, m) => {
      for (const [id, di] of m) {
        arrived.add(id);
        if (di.type === 'do') activities.add(di.activity);
      }
      most = Math.max(most, [...m.values()].filter((x) => x.type !== 'leave').length);
    });
    expect(arrived.size).toBeGreaterThan(10);
    expect(most).toBeLessThanOrEqual(BUSY.maxVisitors);
    for (const a of ['reception', 'visit']) expect(activities).toContain(a);
    expect(activities.size).toBeGreaterThan(4);
    // Stop arrivals: everyone still inside walks out and is gone.
    d.setEnabled(false);
    const left = new Map<string, VisitorBody>();
    run(d, world.door, 10 * 60_000, 2_000, undefined, undefined, left);
    expect(d.currentVisitors()).toEqual([]);
  });

  it('never puts two visitors on the same tile or spot', () => {
    const world = worldOf(defaultLayout());
    const d = new VisitorDirector(seeded(3), { ...BUSY, maxVisitors: 6 });
    d.setWorld(world);
    run(d, world.door, 0, 5 * 60_000, (_t, m) => {
      const tiles = [...m.values()].flatMap((x) => (x.type === 'do' ? [key(x.at)] : x.type === 'go' ? [key(x.to)] : []));
      expect(new Set(tiles).size).toBe(tiles.length);
    });
  });

  it('keeps off tiles agents use and steps aside when an agent wants its spot', () => {
    const world = worldOf(defaultLayout());
    const counters = new Set((world.counters ?? []).map((c) => key(c.at)));
    // Agents stand at every reception counter: no visitor ever goes there.
    const d = new VisitorDirector(seeded(), BUSY);
    d.setWorld(world);
    run(
      d,
      world.door,
      0,
      3 * 60_000,
      (_t, m) => {
        for (const di of m.values()) {
          if (di.type === 'go') expect(counters.has(key(di.to))).toBe(false);
          if (di.type === 'do') expect(counters.has(key(di.at))).toBe(false);
        }
      },
      () => counters,
    );

    // A visitor busy somewhere moves on the very tick an agent heads for that tile.
    const d2 = new VisitorDirector(seeded(), BUSY);
    d2.setWorld(world);
    const bodies = new Map<string, VisitorBody>();
    let busy: { id: string; at: string } | undefined;
    let t = 0;
    while (!busy && t < 120_000) {
      t = run(d2, world.door, t, 200, (_t, m) => {
        for (const [id, di] of m) if (di.type === 'do' && di.activity !== 'chat') busy = { id, at: key(di.at) };
      }, undefined, bodies);
    }
    expect(busy).toBeDefined();
    const next = d2.tick(t, [...bodies.values()], new Set([busy!.at]));
    const di = next.get(busy!.id)!;
    const to = di.type === 'do' ? key(di.at) : di.type === 'go' || di.type === 'leave' ? key(di.to) : undefined;
    expect(to).not.toBe(busy!.at);
  });

  it('chats between visitors, and only ever says visitor template lines', () => {
    const world = worldOf(defaultLayout());
    const d = new VisitorDirector(seeded(11), { ...BUSY, chatChance: 1, soloSpeechChance: 1 });
    d.setWorld(world);
    const said = new Set<string>();
    let chats = 0;
    run(d, world.door, 0, 10 * 60_000, (_t, m) => {
      const talking = [...m.values()].filter((x) => x.type === 'do' && x.activity === 'chat');
      if (talking.length) chats++;
      for (const di of m.values()) if (di.type === 'do' && di.speech) said.add(di.speech);
    });
    expect(chats).toBeGreaterThan(0);
    expect(said.size).toBeGreaterThan(3);
    for (const line of said) expect(VISITOR_LINES.has(line), line).toBe(true);
    expect([...said].some((l) => DIALOGUE_TABLE.visit_open.includes(l))).toBe(true);
  });

  it('hides a visitor in the restroom and marks the stall as occupied', () => {
    const world = worldOf(defaultLayout());
    const toilets = world.spots.filter((s) => s.kind === 'toilet');
    expect(toilets.length).toBeGreaterThan(0);
    const d = new VisitorDirector(seeded(5), { ...BUSY, receptionChance: 0 });
    d.setWorld(world);
    let seen = false;
    run(d, world.door, 0, 10 * 60_000, (_t, m) => {
      for (const di of m.values()) {
        if (di.type !== 'do' || di.activity !== 'toilet' || !di.hidden) continue;
        seen = true;
        expect(toilets.some((s) => d.isInUse(s.id))).toBe(true);
        expect(di.speech).toBeUndefined();
      }
    });
    expect(seen).toBe(true);
  });

  it('does not walk into a room while a meeting is on there', () => {
    const world = worldOf(defaultLayout());
    const busy = new Set(world.rooms.filter((r) => r.kind === 'meeting' || r.kind === 'collaboration').map((r) => r.id));
    expect(busy.size).toBeGreaterThan(0);
    const inBusy = (p: { x: number; y: number }) => world.rooms.some((r) => busy.has(r.id) && p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h);
    const d = new VisitorDirector(seeded(4), BUSY);
    d.setWorld(world);
    let visits = 0;
    const bodies = new Map<string, VisitorBody>();
    let t = 0;
    while (t < 5 * 60_000) {
      const m = d.tick(t, [...bodies.values()], new Set(), busy);
      for (const [id, di] of m) {
        if (di.type === 'do' && di.activity === 'visit') {
          visits++;
          expect(inBusy(di.at)).toBe(false);
        }
        const b = bodies.get(id) ?? { id, pos: { ...world.door }, moving: false };
        b.pos = di.type === 'do' ? { ...di.at } : di.type === 'wait' ? b.pos : { ...di.to };
        bodies.set(id, b);
      }
      for (const id of [...bodies.keys()]) if (!m.has(id)) bodies.delete(id);
      t += 200;
    }
    expect(visits).toBeGreaterThan(0);
  });

  it('holds visitor meetings: a small group sits around one table for a while, then leaves', () => {
    const world = worldOf(defaultLayout());
    const d = new VisitorDirector(seeded(8), MEETINGS);
    d.setWorld(world);
    const bodies = new Map<string, VisitorBody>();
    let seen: { roomId: string; members: string[] } | undefined;
    let t = run(d, world.door, 0, 60_000, (_t, m) => {
      const info = d.currentMeeting();
      if (!info || info.phase !== 'meeting' || seen) return;
      const room = world.rooms.find((r) => r.id === info.roomId)!;
      expect(['meeting', 'collaboration', 'break']).toContain(room.kind);
      expect(info.visitors.length).toBeGreaterThanOrEqual(2);
      expect(info.visitors.length).toBeLessThanOrEqual(3);
      expect(info.simulated).toBe(true);
      const seats = new Set(room.seats.map((s) => key(s.at)));
      const at = info.visitors.map((id) => m.get(id)!).map((di) => {
        expect(di.type === 'do' && di.activity === 'meeting' && di.pose === 'sit_meeting').toBe(true);
        return di.type === 'do' ? key(di.at) : '';
      });
      for (const a of at) expect(seats.has(a)).toBe(true);
      expect(new Set(at).size).toBe(at.length);
      seen = { roomId: info.roomId, members: [...info.visitors] };
    }, undefined, bodies);
    expect(seen).toBeDefined();
    // After the meeting everyone gets up and walks out.
    t = run(d, world.door, t, 30_000, undefined, undefined, bodies);
    for (const id of seen!.members) expect(d.currentVisitors().find((v) => v.id === id)?.activity).not.toBe('meeting');
  });

  it('starts a visitor meeting on request, and says why when it cannot', () => {
    const world = worldOf(defaultLayout());
    const d = new VisitorDirector(seeded(), BUSY);
    d.setWorld(world);
    d.tick(0, [], new Set(), new Set(['huddle']));
    expect(d.requestMeeting('qa')).toBe('no-seats'); // not a meeting room
    expect(d.requestMeeting('huddle')).toBe('busy'); // agents meet there
    expect(d.requestMeeting('meeting')).toBe('ok');
    expect(d.currentMeeting()?.roomId).toBe('meeting');
    expect(d.requestMeeting('break')).toBe('already');
    d.setEnabled(false);
    expect(d.currentMeeting()).toBeUndefined();
    expect(d.requestMeeting('meeting')).toBe('disabled');
  });

  it('gives the room to agents at once', () => {
    const world = worldOf(defaultLayout());
    const d = new VisitorDirector(seeded(2), BUSY);
    d.setWorld(world);
    const bodies = new Map<string, VisitorBody>();
    d.tick(0, [], new Set());
    expect(d.requestMeeting('meeting')).toBe('ok');
    const t = run(d, world.door, 200, 2_000, undefined, undefined, bodies);
    const info = d.currentMeeting()!;
    expect(info.phase).toBe('meeting');
    // An agent heads for one of the seats: the meeting ends and nobody stays seated.
    const seat = d.tick(t, [...bodies.values()], new Set()).get(info.visitors[0]!)!;
    const wanted = new Set([key(seat.type === 'do' ? seat.at : { x: -1, y: -1 })]);
    const next = d.tick(t + 200, [...bodies.values()], wanted);
    expect(d.currentMeeting()).toBeUndefined();
    for (const id of info.visitors) {
      const di = next.get(id)!;
      expect(di.type === 'do' && di.activity === 'meeting').toBe(false);
    }
  });

  it('sends no one in while disabled, and comes back soon after re-enabling', () => {
    const world = worldOf(openOfficeLayout());
    const d = new VisitorDirector(seeded(), BUSY);
    d.setWorld(world);
    d.setEnabled(false);
    run(d, world.door, 0, 60_000, (_t, m) => expect(m.size).toBe(0));
    d.setEnabled(true);
    let any = false;
    run(d, world.door, 60_000, 5_000, (_t, m) => (any ||= m.size > 0));
    expect(any).toBe(true);
  });

  it('comes less often at night', () => {
    const count = (night: boolean) => {
      const world = worldOf(defaultLayout(), night);
      const d = new VisitorDirector(seeded(9), { ...BUSY, maxVisitors: 20 });
      d.setWorld(world);
      const ids = new Set<string>();
      run(d, world.door, 0, 10 * 60_000, (_t, m) => m.forEach((_v, id) => ids.add(id)));
      return ids.size;
    };
    expect(count(true)).toBeLessThan(count(false));
  });

  it('is deterministic for a seeded RNG', () => {
    const trace = (seed: number) => {
      const world = worldOf(defaultLayout());
      const d = new VisitorDirector(seeded(seed), BUSY);
      d.setWorld(world);
      const out: string[] = [];
      run(d, world.door, 0, 3 * 60_000, (t, m) => m.forEach((di, id) => out.push(`${t}:${id}:${JSON.stringify(di)}`)));
      return out.join('\n');
    };
    expect(trace(1)).toBe(trace(1));
    expect(trace(1)).not.toBe(trace(2));
  });
});
