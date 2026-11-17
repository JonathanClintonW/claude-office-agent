import { describe, expect, it } from 'vitest';
import { defaultLayout, openOfficeLayout, roomContains, validateLayout, type OfficeLayout } from '@agent-office/core';
import {
  assignDesks,
  assignSlots,
  findPath,
  loungeSpots,
  nearestTiles,
  planRoute,
  ProgressWatch,
  regionOf,
  roomAt,
  seatsOf,
  STUCK_MS,
  walkable,
  type Point,
} from '../src/office/grid';

const outside = (l: OfficeLayout) => ({ x: l.door.x, y: l.rows });

function expectValidPath(path: Point[] | undefined, from: Point, to: Point, ok: (p: Point) => boolean) {
  expect(path).toBeDefined();
  expect(path!.at(-1)).toEqual(to);
  let prev = from;
  for (const p of path!) {
    expect(Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y)).toBe(1);
    expect(ok(p) || (p.x === to.x && p.y === to.y)).toBe(true);
    prev = p;
  }
}

describe('pathfinding (classic open office)', () => {
  const layout = openOfficeLayout();
  const ok = walkable(layout);

  it('walks from outside the door to every seat', () => {
    for (const s of seatsOf(layout)) expectValidPath(findPath(outside(layout), s.seat, ok), outside(layout), s.seat, ok);
  });

  it('never walks through furniture or the back wall', () => {
    const desk = layout.items.find((i) => i.type === 'desk')!;
    expect(ok(desk)).toBe(false);
    expect(ok({ x: 3, y: 1 })).toBe(false);
    expect(ok({ x: -1, y: 5 })).toBe(false);
  });

  it('returns undefined for unreachable targets', () => {
    const boxed: OfficeLayout = {
      ...layout,
      items: [
        { id: 'a', type: 'plant', x: 1, y: 2 },
        { id: 'b', type: 'plant', x: 0, y: 3 },
        { id: 'c', type: 'plant', x: 2, y: 3 },
        { id: 'd', type: 'plant', x: 1, y: 4 },
      ],
    };
    expect(findPath(outside(boxed), { x: 1, y: 3 }, walkable(boxed), 20000)).toBeUndefined();
  });
});

describe('pathfinding with interior walls', () => {
  const layout = defaultLayout();
  const ok = walkable(layout);

  it('treats walls as blocked and doorway gaps as walkable', () => {
    for (const w of layout.walls!) expect(ok(w), `${w.x},${w.y}`).toBe(false);
    expect(ok({ x: 8, y: 11 })).toBe(true); // development doorway
    expect(ok({ x: 7, y: 11 })).toBe(false);
  });

  it('reaches every desk seat in the default office from outside the door, never crossing a wall', () => {
    const walls = new Set(layout.walls!.map((w) => `${w.x},${w.y}`));
    for (const s of seatsOf(layout)) {
      const path = findPath(outside(layout), s.seat, ok);
      expectValidPath(path, outside(layout), s.seat, ok);
      expect(path!.some((p) => walls.has(`${p.x},${p.y}`))).toBe(false);
    }
  });

  it('routes between rooms through doorways', () => {
    const dev = seatsOf(layout).find((s) => s.roomKind === 'development')!;
    const devops = seatsOf(layout).find((s) => s.roomKind === 'devops')!;
    const path = findPath(dev.seat, devops.seat, ok);
    expectValidPath(path, dev.seat, devops.seat, ok);
    // it has to leave development through its doorway row (y = 11)
    expect(path!.some((p) => p.y === 11 && (p.x === 8 || p.x === 9))).toBe(true);
    expect(path!.length).toBeGreaterThan(Math.abs(dev.seat.x - devops.seat.x));
  });

  it('cannot walk into a walled-off area', () => {
    const sealed: OfficeLayout = {
      ...openOfficeLayout(),
      walls: [
        { x: 1, y: 11 },
        { x: 2, y: 11 },
        { x: 3, y: 11 },
        { x: 3, y: 12 },
        { x: 3, y: 13 },
        { x: 0, y: 11 },
      ],
      items: openOfficeLayout().items.filter((i) => i.id !== 'plant-1' && i.id !== 'lamp-1'),
    };
    expect(validateLayout(sealed).ok).toBe(true);
    expect(findPath(outside(sealed), { x: 1, y: 12 }, walkable(sealed), 20000)).toBeUndefined();
  });
});

/** Breadth-first walking distance (reference for A* optimality). */
function bfsDistance(from: Point, to: Point, ok: (p: Point) => boolean): number | undefined {
  const seen = new Set([`${from.x},${from.y}`]);
  let frontier = [from];
  for (let d = 0; frontier.length; d++) {
    const next: Point[] = [];
    for (const p of frontier) {
      if (p.x === to.x && p.y === to.y) return d;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const n = { x: p.x + dx, y: p.y + dy };
        const k = `${n.x},${n.y}`;
        if (seen.has(k) || (!ok(n) && !(n.x === to.x && n.y === to.y))) continue;
        seen.add(k);
        next.push(n);
      }
    }
    frontier = next;
  }
  return undefined;
}

describe('A* paths are shortest and deterministic', () => {
  const layout = defaultLayout();
  const ok = walkable(layout);
  const seats = seatsOf(layout).map((s) => s.seat);

  it('matches the breadth-first distance between desks across the office', () => {
    for (let i = 0; i < seats.length; i += 2) {
      const from = seats[i]!;
      const to = seats[(i * 5 + 7) % seats.length]!;
      expect(findPath(from, to, ok)!.length, `${from.x},${from.y} -> ${to.x},${to.y}`).toBe(bfsDistance(from, to, ok));
    }
    expect(findPath(seats[0]!, seats[9]!, ok)).toEqual(findPath(seats[0]!, seats[9]!, ok));
  });

  it('walks onto a blocked goal (a chair or couch) but never through one', () => {
    const item = layout.items.find((i) => i.type === 'chair')!;
    const chair = { x: item.x, y: item.y };
    const path = findPath(outside(layout), chair, ok)!;
    expectValidPath(path, outside(layout), chair, ok);
    expect(path.slice(0, -1).every(ok)).toBe(true);
  });
});

describe('planRoute (never stuck, never through walls)', () => {
  const layout = defaultLayout();
  const ok = walkable(layout);
  const walls = new Set(layout.walls!.map((w) => `${w.x},${w.y}`));

  it('returns to the nearer tile first when a worker is between two tiles', () => {
    // walking from (8,12) up to (8,11) (the development doorway), turned round half-way
    const r = planRoute({ x: 8, y: 11.4 }, { x: 3, y: 13 }, ok);
    expect(r.place).toBeUndefined();
    expect(r.path[0]).toEqual({ x: 8, y: 11 });
    expectValidPath(r.path.slice(1), r.path[0]!, { x: 3, y: 13 }, ok);
    expect(planRoute({ x: 8, y: 11.6 }, { x: 3, y: 13 }, ok).path[0]).toEqual({ x: 8, y: 12 });
    // standing still exactly on the target: nothing to do; mid-step onto it: one short step
    expect(planRoute({ x: 3, y: 13 }, { x: 3, y: 13 }, ok)).toEqual({ path: [] });
    expect(planRoute({ x: 3.2, y: 13 }, { x: 3, y: 13 }, ok)).toEqual({ path: [{ x: 3, y: 13 }] });
  });

  it('recovers a worker an edit walled in: put on the nearest tile with a way out, then walks', () => {
    // a worker stands at (2,13) in the corridor when walls box it in
    const boxed: OfficeLayout = {
      ...layout,
      walls: [...layout.walls!, { x: 2, y: 12 }, { x: 1, y: 13 }, { x: 3, y: 13 }, { x: 2, y: 14 }].filter((w, i, all) => all.findIndex((o) => o.x === w.x && o.y === w.y) === i),
    };
    const okBoxed = walkable(boxed);
    const r = planRoute({ x: 2, y: 13 }, { x: 8, y: 12 }, okBoxed);
    expect(r.place).toBeDefined();
    expect(Math.abs(r.place!.x - 2) + Math.abs(r.place!.y - 13)).toBeLessThanOrEqual(3);
    expect(okBoxed(r.place!)).toBe(true);
    expectValidPath(r.path, r.place!, { x: 8, y: 12 }, okBoxed);
    expect(r.path.some((p) => walls.has(`${p.x},${p.y}`))).toBe(false);
  });

  it('recovers a worker standing off the floor (e.g. after the layout shrank)', () => {
    const r = planRoute({ x: 60, y: 40 }, { x: 8, y: 12 }, ok);
    // nothing walkable near: placed at the target (last resort), never left outside
    expect(r).toEqual({ path: [], place: { x: 8, y: 12 } });
    // just past the edge: it steps straight back onto the floor and walks from there
    const near = planRoute({ x: 44, y: 13 }, { x: 8, y: 12 }, ok);
    expect(near.path[0]).toEqual({ x: 43, y: 13 });
    expectValidPath(near.path, { x: 44, y: 13 }, { x: 8, y: 12 }, ok);
  });

  it('puts the worker at an unreachable target instead of walking through walls', () => {
    const sealed: OfficeLayout = { ...openOfficeLayout(), items: [...openOfficeLayout().items, { id: 'p1', type: 'plant', x: 0, y: 12 }, { id: 'p2', type: 'plant', x: 1, y: 13 }] };
    const r = planRoute({ x: 11, y: 13 }, { x: 0, y: 13 }, walkable(sealed));
    expect(r).toEqual({ path: [], place: { x: 0, y: 13 } });
  });

  it('never routes off the layout or through furniture', () => {
    const items = new Set(layout.items.map((i) => `${i.x},${i.y}`));
    const seats = seatsOf(layout).map((s) => s.seat);
    for (let i = 0; i < seats.length; i += 4) {
      const r = planRoute(seats[i]!, outside(layout), ok);
      expect(r.place).toBeUndefined();
      for (const p of r.path.slice(0, -1)) {
        expect(p.x >= 0 && p.x < layout.cols && p.y >= 2 && p.y < layout.rows).toBe(true);
        expect(items.has(`${p.x},${p.y}`)).toBe(false);
        expect(walls.has(`${p.x},${p.y}`)).toBe(false);
      }
    }
  });
});

describe('nearestTiles / regionOf', () => {
  it('lists tiles ring by ring in a fixed order', () => {
    expect(nearestTiles({ x: 5, y: 5 }, () => true, 1, 5)).toEqual([
      { x: 5, y: 5 },
      { x: 5, y: 4 },
      { x: 4, y: 5 },
      { x: 6, y: 5 },
      { x: 5, y: 6 },
    ]);
    expect(nearestTiles({ x: 5, y: 5 }, (p) => p.x === 7 && p.y === 5, 3, 1)).toEqual([{ x: 7, y: 5 }]);
    expect(nearestTiles({ x: 5, y: 5 }, () => false, 3, 1)).toEqual([]);
  });

  it('collects the walkable area connected to a (possibly blocked) goal', () => {
    const layout = openOfficeLayout();
    const ok = walkable(layout);
    const couch = layout.items.find((i) => i.type === 'couch')!;
    const region = regionOf(couch, ok);
    expect(region.size).toBeGreaterThan(100);
  });
});

describe('ProgressWatch (stuck detection)', () => {
  it('is quiet while the walker reaches new tiles or stands still', () => {
    const w = new ProgressWatch();
    let t = 0;
    for (let x = 0; x < 20; x++, t += 400) expect(w.update(t, x, 3, true)).toBe('ok');
    for (; t < 20_000; t += 200) expect(w.update(t, 20, 3, false)).toBe('ok');
  });

  it('asks for a new route after STUCK_MS without a new tile, then to place the walker', () => {
    const w = new ProgressWatch();
    expect(w.update(0, 4, 4, true)).toBe('ok');
    expect(w.update(STUCK_MS - 1, 4, 4, true)).toBe('ok');
    expect(w.update(STUCK_MS, 4, 4, true)).toBe('repath');
    expect(w.update(STUCK_MS + 100, 4, 4, true)).toBe('ok');
    expect(w.update(2 * STUCK_MS, 4, 4, true)).toBe('place');
    // progress resets the strikes
    const v = new ProgressWatch();
    v.update(0, 1, 1, true);
    expect(v.update(STUCK_MS, 1, 1, true)).toBe('repath');
    expect(v.update(STUCK_MS + 10, 2, 1, true)).toBe('ok');
    expect(v.update(2 * STUCK_MS + 10, 2, 1, true)).toBe('repath');
  });
});

describe('rooms and seats', () => {
  const layout = defaultLayout();

  it('tags seats with their room', () => {
    const seats = seatsOf(layout);
    for (const s of seats) {
      const room = roomAt(layout, s.desk)!;
      expect(room, s.deskId).toBeDefined();
      expect(s.roomId).toBe(room.id);
      expect(s.roomKind).toBe(room.kind);
    }
    expect(roomAt(layout, { x: 16, y: 5 })).toBeUndefined(); // a wall between rooms
    expect(roomAt(openOfficeLayout(), { x: 4, y: 4 })).toBeUndefined();
  });

  it('keeps lounge spots reachable and in lounge-like rooms', () => {
    const spots = loungeSpots(layout);
    expect(spots.length).toBeGreaterThan(10);
    const ok = walkable(layout);
    const seats = new Set(seatsOf(layout).map((s) => `${s.seat.x},${s.seat.y}`));
    for (const p of spots) {
      expect(ok(p)).toBe(true);
      expect(seats.has(`${p.x},${p.y}`)).toBe(false);
      const kind = roomAt(layout, p)?.kind;
      expect(['reception', 'break', 'corridor', 'collaboration', 'office', undefined]).toContain(kind);
      expect(findPath(outside(layout), p, ok)).toBeDefined();
    }
  });
});

describe('desk assignment', () => {
  const layout = openOfficeLayout();
  const seats = seatsOf(layout);

  it('keeps existing assignments stable as agents come and go', () => {
    const a1 = assignDesks(new Map(), [{ key: 's1' }, { key: 's2' }], seats);
    const a2 = assignDesks(a1, [{ key: 's2' }, { key: 's3' }], seats);
    expect(a2.get('s2')).toBe(a1.get('s2'));
    expect(a2.get('s3')).toBe(a1.get('s1')); // freed desk is reused
  });

  it('seats subagents next to their parent', () => {
    const others = Array.from({ length: 4 }, (_, i) => ({ key: `x${i}` }));
    const a = assignDesks(new Map(), [...others, { key: 'p' }, { key: 'c', parentKey: 'p' }], seats);
    const byId = new Map(seats.map((s) => [s.deskId, s.seat]));
    const p = byId.get(a.get('p')!)!;
    const c = byId.get(a.get('c')!)!;
    expect(Math.abs(p.x - c.x) + Math.abs(p.y - c.y)).toBe(1);
  });

  it('prefers zones that match the workspace', () => {
    const zoned: OfficeLayout = { ...layout, zones: [{ id: 'z', name: 'Acme', x: 13, y: 9, w: 4, h: 3, color: '#ff0000', workspaceMatch: 'work\\acme' }] };
    const zs = seatsOf(zoned);
    const a = assignDesks(new Map(), [{ key: 'other', cwd: 'c:\\work\\x' }, { key: 'acme', cwd: 'C:\\Work\\Acme\\api' }], zs);
    expect(zs.find((s) => s.deskId === a.get('acme'))!.zoneId).toBe('z');
    expect(zs.find((s) => s.deskId === a.get('other'))!.zoneId).toBeUndefined();
  });

  it('overflows to the lounge (null) when desks run out', () => {
    const many = Array.from({ length: seats.length + 3 }, (_, i) => ({ key: `a${i}` }));
    const a = assignDesks(new Map(), many, seats);
    expect([...a.values()].filter((v) => v === null)).toHaveLength(3);
    expect(new Set([...a.values()].filter(Boolean)).size).toBe(seats.length);
    expect(loungeSpots(layout).length).toBeGreaterThan(3);
  });

  it('ignores departments in layouts without rooms (old behaviour)', () => {
    const plain = assignDesks(new Map(), [{ key: 'a' }, { key: 'b' }], seats);
    const withDept = assignDesks(new Map(), [{ key: 'a', department: 'qa' }, { key: 'b', department: 'research' }], seats);
    expect(withDept).toEqual(plain);
  });
});

describe('desk assignment with department rooms', () => {
  const layout = defaultLayout();
  const seats = seatsOf(layout);
  const kindOf = (deskId: string | null | undefined) => seats.find((s) => s.deskId === deskId)?.roomKind;

  it('prefers desks in a room of the agent department', () => {
    const a = assignDesks(
      new Map(),
      [
        { key: 'dev', department: 'development' },
        { key: 'qa', department: 'qa' },
        { key: 'res', department: 'research' },
        { key: 'ops', department: 'devops' },
        { key: 'sec', department: 'security' },
        { key: 'col', department: 'collaboration' },
      ],
      seats,
    );
    expect(kindOf(a.get('dev'))).toBe('development');
    expect(kindOf(a.get('qa'))).toBe('qa');
    expect(kindOf(a.get('res'))).toBe('research');
    expect(kindOf(a.get('ops'))).toBe('devops');
    expect(kindOf(a.get('sec'))).toBe('security');
    expect(kindOf(a.get('col'))).toBe('collaboration');
  });

  it('puts a subagent in its own department, as close to its parent as that allows', () => {
    const a = assignDesks(new Map(), [{ key: 'p', department: 'development' }, { key: 'c', parentKey: 'p', department: 'research' }, { key: 'd', parentKey: 'p', department: 'development' }], seats);
    expect(kindOf(a.get('c'))).toBe('research');
    const byId = new Map(seats.map((s) => [s.deskId, s.seat]));
    const p = byId.get(a.get('p')!)!;
    const d = byId.get(a.get('d')!)!;
    expect(Math.abs(p.x - d.x) + Math.abs(p.y - d.y)).toBe(1);
    // the research desk nearest the parent
    const research = seats.filter((s) => s.roomKind === 'research');
    const dist = (s: Point) => Math.abs(s.x - p.x) + Math.abs(s.y - p.y) * 1.5;
    const best = Math.min(...research.map((s) => dist(s.seat)));
    expect(dist(byId.get(a.get('c')!)!)).toBe(best);
  });

  it('falls back to other desks when the department room is full, keeping zone preference next', () => {
    const devops = seats.filter((s) => s.roomKind === 'devops');
    const agents = Array.from({ length: devops.length + 2 }, (_, i) => ({ key: `ops${i}`, department: 'devops' }));
    const a = assignDesks(new Map(), agents, seats);
    const kinds = agents.map((x) => kindOf(a.get(x.key)));
    expect(kinds.filter((k) => k === 'devops')).toHaveLength(devops.length);
    expect(kinds.filter((k) => k !== 'devops' && k !== undefined)).toHaveLength(2);

    const zoned: OfficeLayout = { ...layout, zones: [{ id: 'z', name: 'Acme', x: 17, y: 2, w: 10, h: 9, color: '#ff0000', workspaceMatch: 'acme' }] };
    const zs = seatsOf(zoned);
    const b = assignDesks(new Map(), [{ key: 'q', department: 'qa', cwd: 'c:\\work\\acme' }, { key: 'r', department: 'development', cwd: 'c:\\work\\acme' }], zs);
    expect(zs.find((s) => s.deskId === b.get('q'))!.zoneId).toBe('z');
    // department beats zone: the development agent stays in development
    expect(zs.find((s) => s.deskId === b.get('r'))!.roomKind).toBe('development');
  });

  it('keeps an existing desk even if the department would now differ (scene re-seats explicitly)', () => {
    const a1 = assignDesks(new Map(), [{ key: 'x', department: 'qa' }], seats);
    const a2 = assignDesks(a1, [{ key: 'x', department: 'research' }], seats);
    expect(a2.get('x')).toBe(a1.get('x'));
    const fresh = new Map(a1);
    fresh.delete('x');
    expect(kindOf(assignDesks(fresh, [{ key: 'x', department: 'research' }], seats).get('x'))).toBe('research');
  });

  it('treats every seat as inside its room rectangle', () => {
    for (const s of seats) expect(roomContains(layout.rooms!.find((r) => r.id === s.roomId)!, s.desk)).toBe(true);
  });

  it('overflows a full department to the free desks nearest to it, not the first desk in the office', () => {
    const qa = seats.filter((s) => s.roomKind === 'qa');
    const agents = Array.from({ length: qa.length + 3 }, (_, i) => ({ key: `qa${i}`, department: 'qa' }));
    const a = assignDesks(new Map(), agents, seats);
    const centre = { x: qa.reduce((s, x) => s + x.seat.x, 0) / qa.length, y: qa.reduce((s, x) => s + x.seat.y, 0) / qa.length };
    const d = (p: Point) => Math.abs(p.x - centre.x) + Math.abs(p.y - centre.y) * 1.5;
    const overflow = agents.slice(qa.length).map((x) => seats.find((s) => s.deskId === a.get(x.key))!);
    for (const s of overflow) expect(s.roomKind).not.toBe('qa');
    // every overflow desk is at least as close to QA as any other free non-QA desk
    const used = new Set([...a.values()]);
    const best = Math.min(...seats.filter((s) => s.roomKind !== 'qa' && !used.has(s.deskId)).map((s) => d(s.seat)));
    for (const s of overflow) expect(d(s.seat)).toBeLessThanOrEqual(best);
    expect(overflow.some((s) => s.deskId === seats[0]!.deskId)).toBe(false);
  });

  it('keeps assignments stable while agents come and go and departments overflow', () => {
    const agents = Array.from({ length: 12 }, (_, i) => ({ key: `a${i}`, department: i % 2 ? 'devops' : 'security' }));
    const first = assignDesks(new Map(), agents, seats);
    const again = assignDesks(first, [...agents].reverse(), seats);
    expect(again).toEqual(first);
    const fewer = assignDesks(first, agents.slice(3), seats);
    for (const x of agents.slice(3)) expect(fewer.get(x.key)).toBe(first.get(x.key));
    expect(new Set([...first.values()]).size).toBe(agents.length);
  });
});

describe('assignSlots (stable lounge places)', () => {
  it('keeps slots, reuses freed ones and shares slots only when full', () => {
    const a = assignSlots(new Map(), ['x', 'y', 'z'], 5);
    expect([...a]).toEqual([
      ['x', 0],
      ['y', 1],
      ['z', 2],
    ]);
    const b = assignSlots(a, ['z', 'w'], 5); // x and y left
    expect(b.get('z')).toBe(2);
    expect(b.get('w')).toBe(0);
    const c = assignSlots(b, ['z', 'w', 'p', 'q', 'r', 's', 't'], 5);
    expect(c.get('z')).toBe(2);
    expect(c.get('w')).toBe(0);
    expect(new Set([c.get('p'), c.get('q'), c.get('r')])).toEqual(new Set([1, 3, 4]));
    expect([c.get('s'), c.get('t')]).toEqual([0, 1]); // overflow shares in order
    expect(assignSlots(c, ['z'], 0).size).toBe(0);
    expect(assignSlots(new Map([['z', 9]]), ['z'], 3).get('z')).toBe(0); // a slot that no longer exists
  });

  it('keeps lounge places off spots and seats other workers walk to', () => {
    const layout = defaultLayout();
    const all = loungeSpots(layout);
    const avoid = new Set(all.slice(0, 5).map((p) => `${p.x},${p.y}`));
    const some = loungeSpots(layout, avoid);
    for (const p of some) expect(avoid.has(`${p.x},${p.y}`)).toBe(false);
    expect(some.length).toBeGreaterThan(10);
  });
});
