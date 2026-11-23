import { describe, expect, it } from 'vitest';
import { defaultLayout, openOfficeLayout, reachableTiles, roomContains, seatOf, type OfficeLayout } from '@agent-office/core';
import { buildWorld, chairFacing, destinationTiles } from '../src/office/world';
import { findPath, walkable } from '../src/office/grid';

const k = (p: { x: number; y: number }) => `${p.x},${p.y}`;

describe('buildWorld (default department office)', () => {
  const layout = defaultLayout();
  const world = buildWorld(layout, [2, 6, 10, 14, 18, 22], false);
  const reach = reachableTiles(layout);
  const ok = walkable(layout);
  const door = { x: layout.door.x, y: layout.rows };

  it('offers every spot kind', () => {
    const kinds = new Set(world.spots.map((s) => s.kind));
    for (const kind of ['coffee', 'water', 'snack', 'toilet', 'couch', 'window', 'books', 'board', 'whiteboard', 'plant'] as const) expect(kinds, kind).toContain(kind);
  });

  it('puts every spot on a reachable tile (couches: next to one) and tags its room', () => {
    for (const s of world.spots) {
      if (s.kind === 'couch') {
        const n = [
          { x: s.at.x + 1, y: s.at.y },
          { x: s.at.x - 1, y: s.at.y },
          { x: s.at.x, y: s.at.y + 1 },
          { x: s.at.x, y: s.at.y - 1 },
        ];
        expect(n.some((p) => reach.has(k(p))), s.id).toBe(true);
      } else {
        expect(reach.has(k(s.at)), s.id).toBe(true);
        expect(findPath(door, s.at, ok), s.id).toBeDefined();
      }
    }
    const snack = world.spots.find((s) => s.kind === 'snack')!;
    expect(snack.roomId).toBe('break');
    expect(world.spots.filter((s) => s.kind === 'toilet').every((s) => s.roomId === 'restroom')).toBe(true);
    expect(world.spots.find((s) => s.kind === 'whiteboard' && s.roomId === 'research')).toBeDefined();
  });

  it('faces each spot towards its furniture', () => {
    const items = new Map(layout.items.map((i) => [i.id, i]));
    const step = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] } as const;
    for (const s of world.spots) {
      const it = items.get(s.id);
      if (!it || s.kind === 'couch' || it.type === 'board') continue;
      const [dx, dy] = step[s.face];
      expect({ x: s.at.x + dx, y: s.at.y + dy }, s.id).toEqual({ x: it.x, y: it.y });
    }
    // bookshelves against the back of research are read from above (facing down)
    const books = world.spots.filter((s) => s.kind === 'books' && s.roomId === 'research' && s.at.y === 9);
    expect(books.length).toBeGreaterThan(0);
    expect(books.every((s) => s.face === 'down')).toBe(true);
  });

  it('describes every layout room', () => {
    expect(world.rooms.map((r) => r.id)).toEqual(layout.rooms!.map((r) => r.id));
    for (const r of world.rooms) expect(r.capacity).toBe(r.seats.length);
  });

  it('seats people around the meeting table with a presenter at the screen', () => {
    const meeting = world.rooms.find((r) => r.id === 'meeting')!;
    expect(meeting.kind).toBe('meeting');
    expect(meeting.capacity).toBe(12);
    expect(meeting.presenter).toEqual({ at: { x: 30, y: 16 }, face: 'down' });
    const tables = new Set(layout.items.filter((i) => i.type === 'table').map(k));
    const step = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] } as const;
    for (const s of meeting.seats) {
      expect(roomContains(meeting, s.at)).toBe(true);
      const [dx, dy] = step[s.face];
      expect(tables.has(k({ x: s.at.x + dx, y: s.at.y + dy })), k(s.at)).toBe(true);
      // seats are chair tiles: a worker walks onto them as a path goal
      expect(findPath(door, s.at, ok), k(s.at)).toBeDefined();
    }
    const faces = new Set(meeting.seats.map((s) => s.face));
    expect(faces).toEqual(new Set(['up', 'down', 'left', 'right']));
  });

  it('has a huddle room, collaboration tables and a break-room table', () => {
    const byId = new Map(world.rooms.map((r) => [r.id, r]));
    expect(byId.get('huddle')!.capacity).toBe(8);
    expect(byId.get('huddle')!.presenter).toEqual({ at: { x: 33, y: 24 }, face: 'down' });
    expect(byId.get('collab')!.capacity).toBe(16);
    expect(byId.get('collab')!.presenter?.at).toEqual({ x: 17, y: 16 });
    expect(byId.get('break')!.capacity).toBe(4);
    expect(byId.get('dev')!.capacity).toBe(0);
    expect(byId.get('dev')!.presenter).toBeUndefined();
    expect(byId.get('research')!.presenter).toEqual({ at: { x: 33, y: 7 }, face: 'down' });
  });

  it('keeps chat tiles off desk seats, spots and walls', () => {
    const seats = new Set(layout.items.filter((i) => i.type === 'desk').map((d) => k(seatOf(d))));
    const spots = new Set(world.spots.map((s) => k(s.at)));
    const walls = new Set(layout.walls!.map(k));
    expect(world.chatTiles.length).toBeGreaterThan(50);
    for (const t of world.chatTiles) {
      for (const p of [t, { x: t.x + 1, y: t.y }]) {
        expect(seats.has(k(p))).toBe(false);
        expect(spots.has(k(p))).toBe(false);
        expect(walls.has(k(p))).toBe(false);
        expect(reach.has(k(p))).toBe(true);
      }
    }
  });

  it('is pure and deterministic', () => {
    expect(buildWorld(layout, [2, 6, 10, 14, 18, 22], false)).toEqual(world);
    expect(buildWorld(layout, [2], true).night).toBe(true);
  });

  it('keeps spots and chat tiles off meeting seats and presenter spots (no shared destinations)', () => {
    const meeting = new Set(world.rooms.flatMap((r) => [...r.seats.map((s) => k(s.at)), ...(r.presenter ? [k(r.presenter.at)] : [])]));
    expect(meeting.size).toBeGreaterThan(30);
    for (const s of world.spots) expect(meeting.has(k(s.at)), s.id).toBe(false);
    for (const t of world.chatTiles) {
      expect(meeting.has(k(t))).toBe(false);
      expect(meeting.has(k({ x: t.x + 1, y: t.y }))).toBe(false);
    }
    // the whiteboards in front of which presenters stand are used from the side by idle life
    for (const id of ['whiteboard-1', 'whiteboard-2', 'whiteboard-3']) expect(world.spots.find((s) => s.id === id)?.face, id).toBe('right');
    const dest = destinationTiles(world);
    for (const t of meeting) expect(dest.has(t)).toBe(true);
    for (const s of world.spots) expect(dest.has(k(s.at))).toBe(true);
    for (const l of world.lounges) expect(dest.has(k(l.at))).toBe(true);
  });

  it('offers the reception waiting chairs as lounge seats', () => {
    expect(world.lounges.map((l) => k(l.at))).toEqual(['9,27', '10,27', '11,27']);
    for (const l of world.lounges) {
      expect(l.roomId).toBe('reception');
      expect(l.face).toBe('down');
      expect(layout.items.find((i) => i.id === l.id)?.type).toBe('chair');
      expect(findPath(door, l.at, ok), l.id).toBeDefined();
    }
    // chairs at a table are meeting seats, never lounge seats
    const seats = new Set(world.rooms.flatMap((r) => r.seats.map((s) => k(s.at))));
    for (const l of world.lounges) expect(seats.has(k(l.at))).toBe(false);
  });

  it('finds every room entrance: inside the room, reachable, facing in from a tile outside it', () => {
    const step = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] } as const;
    const byRoom = new Map<string, number>();
    for (const d of world.doorways) {
      const room = layout.rooms!.find((r) => r.id === d.roomId)!;
      expect(roomContains(room, d.at), k(d.at)).toBe(true);
      expect(reach.has(k(d.at)), k(d.at)).toBe(true);
      // one step back (against the face) is outside the room and reachable
      const [dx, dy] = step[d.face];
      const behind = { x: d.at.x - dx, y: d.at.y - dy };
      expect(roomContains(room, behind), k(d.at)).toBe(false);
      expect(reach.has(k(behind)) || (behind.x === door.x && behind.y === door.y), k(d.at)).toBe(true);
      byRoom.set(d.roomId, (byRoom.get(d.roomId) ?? 0) + 1);
    }
    for (const r of layout.rooms!) expect(byRoom.get(r.id) ?? 0, r.id).toBeGreaterThan(0);
    expect(world.doorways.filter((d) => d.roomId === 'dev').map((d) => k(d.at))).toEqual(['8,10', '9,10']);
    expect(world.doorways.filter((d) => d.roomId === 'meeting')).toEqual([{ roomId: 'meeting', at: { x: 27, y: 15 }, face: 'down' }]);
  });

  it('enters and leaves rooms only through their doorways (walls block everything else)', () => {
    const doorTiles = new Map<string, Set<string>>();
    for (const d of world.doorways) {
      if (!doorTiles.has(d.roomId)) doorTiles.set(d.roomId, new Set());
      doorTiles.get(d.roomId)!.add(k(d.at));
    }
    const roomOf = (p: { x: number; y: number }) => layout.rooms!.find((r) => roomContains(r, p))?.id;
    const seats = layout.items.filter((i) => i.type === 'desk').map((d) => seatOf(d));
    const targets = [...seats, ...world.spots.filter((s) => s.kind !== 'couch').map((s) => s.at)];
    let checked = 0;
    for (let i = 0; i < targets.length; i += 3) {
      const from = targets[i]!;
      const to = targets[(i * 7 + 11) % targets.length]!;
      const path = findPath(from, to, ok)!;
      expect(path, `${k(from)} -> ${k(to)}`).toBeDefined();
      let prev = from;
      for (const p of path) {
        const a = roomOf(prev);
        const b = roomOf(p);
        if (a !== b) {
          // stepping out of room a happens from one of its doorway tiles, into room b onto one of its doorway tiles
          if (a) expect(doorTiles.get(a)!.has(k(prev)), `${k(prev)} leaves ${a}`).toBe(true);
          if (b) expect(doorTiles.get(b)!.has(k(p)) || k(p) === k(to), `${k(p)} enters ${b}`).toBe(true);
          checked++;
        }
        prev = p;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('default office: departments and common rooms are usable', () => {
  const layout = defaultLayout();
  const world = buildWorld(layout, [2, 6, 10, 14, 18, 22], false);
  const roomById = new Map(layout.rooms!.map((r) => [r.id, r]));

  it('gives every department room reachable desks and every room a way in', () => {
    const reach = reachableTiles(layout);
    for (const r of layout.rooms!) {
      expect(world.doorways.some((d) => d.roomId === r.id), r.id).toBe(true);
      if (!(['development', 'qa', 'research', 'devops', 'security', 'collaboration'] as string[]).includes(r.kind)) continue;
      const desks = layout.items.filter((i) => i.type === 'desk' && roomContains(r, i));
      expect(desks.length, r.id).toBeGreaterThanOrEqual(2);
      for (const d of desks) expect(reach.has(k(seatOf(d))), d.id).toBe(true);
    }
  });

  it('gives every common room something to do: spots, seats or lounge chairs', () => {
    const things = (roomId: string) =>
      world.spots.filter((s) => s.roomId === roomId).length + world.rooms.find((r) => r.id === roomId)!.seats.length + world.lounges.filter((l) => l.roomId === roomId).length;
    for (const id of ['break', 'restroom', 'reception', 'meeting', 'huddle', 'collab', 'corridor']) expect(things(id), id).toBeGreaterThan(0);
    expect(world.spots.filter((s) => s.roomId === 'restroom' && s.kind === 'toilet')).toHaveLength(2);
    expect(new Set(world.spots.filter((s) => s.roomId === 'break').map((s) => s.kind))).toEqual(new Set(['coffee', 'snack', 'water', 'couch', 'plant']));
    expect(roomById.get('reception')!.kind).toBe('reception');
  });
});

describe('buildWorld (older layouts and edge cases)', () => {
  it('keeps the classic office spots and has no rooms', () => {
    const w = buildWorld(openOfficeLayout(), [2, 6, 10], false);
    const kinds = w.spots.map((s) => s.kind);
    expect(kinds.filter((x) => x === 'toilet')).toHaveLength(2);
    expect(kinds.filter((x) => x === 'couch')).toHaveLength(4);
    expect(kinds).toContain('coffee');
    expect(kinds).toContain('water');
    expect(kinds).toContain('books');
    expect(kinds).toContain('board'); // the task board on the back wall
    expect(w.rooms).toEqual([]);
    expect(w.spots.every((s) => s.roomId === undefined)).toBe(true);
    expect(w.doorways).toEqual([]);
    expect(w.lounges).toEqual([]);
  });

  it('takes free-standing chairs as lounge seats only in common areas', () => {
    const base = openOfficeLayout();
    const l: OfficeLayout = {
      ...base,
      items: [...base.items, { id: 'c1', type: 'chair', x: 10, y: 12 }, { id: 'c2', type: 'chair', x: 14, y: 12 }, { id: 't', type: 'table', x: 15, y: 12 }],
      rooms: [{ id: 'q', name: 'QA', kind: 'qa', x: 0, y: 2, w: 8, h: 4 }],
    };
    // c1: free-standing, outside any room; c2: at a table (a seat, not a lounge chair)
    expect(buildWorld(l, [], false).lounges.map((s) => s.id)).toEqual(['c1']);
    const inQa = { ...l, items: [...l.items, { id: 'c3', type: 'chair' as const, x: 5, y: 4 }] };
    expect(buildWorld(inQa, [], false).lounges.map((s) => s.id)).toEqual(['c1']);
    const inReception = { ...inQa, rooms: [{ ...inQa.rooms![0]!, kind: 'reception' as const }] };
    expect(buildWorld(inReception, [], false).lounges.map((s) => s.id)).toEqual(['c1', 'c3']);
  });

  it('offers an arcade spot on the free tile in front of an arcade cabinet, facing it', () => {
    const base = defaultLayout();
    const l: OfficeLayout = { ...base, items: [...base.items, { id: 'arcade-1', type: 'arcade', x: 36, y: 15 }] };
    const arcade = buildWorld(l, [], false).spots.filter((s) => s.kind === 'arcade');
    expect(arcade).toEqual([{ id: 'arcade-1', kind: 'arcade', at: { x: 36, y: 16 }, face: 'up', roomId: 'break' }]);
    expect(buildWorld(base, [], false).spots.some((s) => s.kind === 'arcade')).toBe(false);
  });

  it('drops spots that cannot be reached', () => {
    const base = openOfficeLayout();
    const sealed: OfficeLayout = {
      ...base,
      items: [...base.items.filter((i) => i.id !== 'plant-1' && i.id !== 'lamp-1'), { id: 'snack-1', type: 'snack', x: 1, y: 13 }],
      walls: [
        { x: 0, y: 11 },
        { x: 1, y: 11 },
        { x: 2, y: 11 },
        { x: 3, y: 11 },
        { x: 3, y: 12 },
        { x: 3, y: 13 },
      ],
    };
    const w = buildWorld(sealed, [], false);
    expect(w.spots.find((s) => s.kind === 'snack')).toBeUndefined();
    expect(w.chatTiles.some((t) => t.x < 3 && t.y > 11)).toBe(false);
  });

  it('falls back to standing seats around tables in meeting rooms without chairs', () => {
    const base = openOfficeLayout();
    const l: OfficeLayout = {
      ...base,
      items: [...base.items, { id: 't1', type: 'table', x: 10, y: 12 }, { id: 't2', type: 'table', x: 11, y: 12 }, { id: 'wb', type: 'whiteboard', x: 15, y: 11 }],
      rooms: [{ id: 'm', name: 'Huddle', kind: 'meeting', x: 8, y: 11, w: 8, h: 3 }],
    };
    const room = buildWorld(l, [], false).rooms[0]!;
    expect(room.seats.length).toBeGreaterThanOrEqual(4);
    expect(room.seats.every((s) => (s.at.y === 11 && s.face === 'down') || (s.at.y === 13 && s.face === 'up') || s.face === 'left' || s.face === 'right')).toBe(true);
    expect(room.seats.some((s) => s.at.x === 11 && s.at.y === 13)).toBe(false); // the door tile is never a seat
    expect(room.presenter).toEqual({ at: { x: 15, y: 12 }, face: 'down' });
    // the same room as a break room has no standing seats
    const asBreak = buildWorld({ ...l, rooms: [{ ...l.rooms![0]!, kind: 'break' }] }, [], false).rooms[0]!;
    expect(asBreak.capacity).toBe(0);
  });

  it('turns chairs towards adjacent tables', () => {
    const items = [
      { id: 't', type: 'table' as const, x: 5, y: 5 },
      { id: 'a', type: 'chair' as const, x: 5, y: 4 },
    ];
    expect(chairFacing({ items }, { x: 5, y: 4 })).toBe('down');
    expect(chairFacing({ items }, { x: 5, y: 6 })).toBe('up');
    expect(chairFacing({ items }, { x: 4, y: 5 })).toBe('right');
    expect(chairFacing({ items }, { x: 6, y: 5 })).toBe('left');
    expect(chairFacing({ items }, { x: 9, y: 9 })).toBe('down');
  });
});
