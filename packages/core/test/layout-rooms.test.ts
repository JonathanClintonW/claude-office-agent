import { describe, expect, it } from 'vitest';
import {
  blockedTiles,
  defaultLayout,
  FURNITURE_TYPES,
  layoutFromMap,
  openOfficeLayout,
  reachableTiles,
  roomContains,
  seatOf,
  validateLayout,
  WALL_ROWS,
  type OfficeLayout,
} from '../src/layout';
import { DEPARTMENT_KINDS, ROOM_KINDS } from '../src/contracts/office';

const k = (p: { x: number; y: number }) => `${p.x},${p.y}`;

/** A small wall-less version-1 layout exactly as older versions saved it. */
function legacy(): OfficeLayout {
  return {
    version: 1,
    name: 'My office',
    cols: 12,
    rows: 9,
    door: { x: 6 },
    items: [
      { id: 'desk-1', type: 'desk', x: 2, y: 3 },
      { id: 'plant-1', type: 'plant', x: 0, y: 2 },
      { id: 'board-1', type: 'board', x: 4, y: 1 },
      { id: 'wc-1', type: 'toilet', x: 10, y: 2 },
    ],
    zones: [{ id: 'z1', name: 'Acme', x: 1, y: 2, w: 4, h: 3, color: '#ff0000', workspaceMatch: 'acme' }],
  };
}

describe('layout model: backward compatibility', () => {
  it('validates old version-1 layouts unchanged, without adding walls or rooms keys', () => {
    const old = legacy();
    const r = validateLayout(JSON.parse(JSON.stringify(old)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout).toEqual(old);
    expect('walls' in r.layout).toBe(false);
    expect('rooms' in r.layout).toBe(false);
  });

  it('keeps the original open office available and valid', () => {
    const o = openOfficeLayout();
    expect(o.cols).toBe(23);
    expect(o.rows).toBe(14);
    expect(o.items.filter((i) => i.type === 'desk')).toHaveLength(24);
    const r = validateLayout(o);
    expect(r.ok && r.layout).toEqual(o);
  });

  it('does not reject wall-less layouts whose desks are boxed in by furniture (they loaded before)', () => {
    const boxed = legacy();
    boxed.items.push(
      { id: 'p1', type: 'plant', x: 1, y: 4 },
      { id: 'p2', type: 'plant', x: 3, y: 4 },
      { id: 'p3', type: 'plant', x: 2, y: 5 },
    );
    expect(validateLayout(boxed).ok).toBe(true);
  });

  it('is idempotent for the new fields', () => {
    const r1 = validateLayout(defaultLayout());
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = validateLayout(JSON.parse(JSON.stringify(r1.layout)));
    expect(r2.ok && r2.layout).toEqual(r1.layout);
    expect(r1.layout).toEqual(defaultLayout());
  });
});

describe('layout model: walls and rooms validation', () => {
  const base = (): OfficeLayout => ({ ...legacy(), zones: [] });

  it('accepts interior walls and rooms', () => {
    const l: OfficeLayout = {
      ...base(),
      walls: [
        { x: 6, y: 2 },
        { x: 6, y: 3 },
        { x: 6, y: 5 },
      ],
      rooms: [
        { id: 'a', name: 'Dev', kind: 'development', x: 0, y: 2, w: 6, h: 4 },
        { id: 'b', name: 'Loo', kind: 'restroom', x: 7, y: 2, w: 5, h: 4 },
      ],
    };
    const r = validateLayout(l);
    expect(r.ok).toBe(true);
    expect(r.ok && r.layout.walls).toHaveLength(3);
    expect(r.ok && r.layout.rooms!.map((x) => x.kind)).toEqual(['development', 'restroom']);
  });

  it('rejects walls out of bounds, on the back wall, duplicated, on the door or under furniture', () => {
    const b = base();
    expect(validateLayout({ ...b, walls: [{ x: 99, y: 3 }] })).toMatchObject({ ok: false, error: 'wall out of bounds' });
    expect(validateLayout({ ...b, walls: [{ x: 3, y: 1 }] }).ok).toBe(false);
    expect(validateLayout({ ...b, walls: [{ x: 3, y: 3.5 }] }).ok).toBe(false);
    expect(validateLayout({ ...b, walls: [{ x: 5, y: 5 }, { x: 5, y: 5 }] })).toMatchObject({ ok: false, error: 'duplicate wall at 5,5' });
    expect(validateLayout({ ...b, walls: [{ x: b.door.x, y: b.rows - 1 }] })).toMatchObject({ ok: false, error: 'a wall blocks the door' });
    expect(validateLayout({ ...b, walls: [{ x: 0, y: 2 }] })).toMatchObject({ ok: false, error: 'item plant-1 is inside a wall' });
    expect(validateLayout({ ...b, walls: [{ x: 2, y: 4 }] })).toMatchObject({ ok: false, error: 'desk desk-1 chair is blocked by a wall' });
    expect(validateLayout({ ...b, walls: 'nope' }).ok).toBe(false);
    expect(validateLayout({ ...b, walls: Array.from({ length: 1201 }, (_, i) => ({ x: i % 12, y: 2 + (i % 7) })) }).ok).toBe(false);
  });

  it('rejects walls that cut a desk off from the door', () => {
    const b = base();
    const ring = [
      { x: 1, y: 3 },
      { x: 1, y: 4 },
      { x: 3, y: 3 },
      { x: 3, y: 4 },
      { x: 1, y: 5 },
      { x: 2, y: 5 },
      { x: 3, y: 5 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
    ];
    expect(validateLayout({ ...b, walls: ring })).toMatchObject({ ok: false, error: 'desk desk-1 cannot be reached from the door' });
    // a doorway (gap) fixes it
    expect(validateLayout({ ...b, walls: ring.filter((w) => !(w.x === 2 && w.y === 5)) }).ok).toBe(true);
  });

  it('rejects invalid, out-of-bounds and overlapping rooms', () => {
    const b = base();
    const room = { id: 'r', name: 'R', kind: 'qa', x: 0, y: 2, w: 4, h: 3 };
    expect(validateLayout({ ...b, rooms: [{ ...room, kind: 'dungeon' }] })).toMatchObject({ ok: false, error: 'room r has an invalid kind' });
    expect(validateLayout({ ...b, rooms: [{ ...room, id: '../x' }] })).toMatchObject({ ok: false, error: 'invalid room id' });
    expect(validateLayout({ ...b, rooms: [room, { ...room }] })).toMatchObject({ ok: false, error: 'invalid room id' });
    expect(validateLayout({ ...b, rooms: [{ ...room, y: 1 }] }).ok).toBe(false);
    expect(validateLayout({ ...b, rooms: [{ ...room, w: 13 }] })).toMatchObject({ ok: false, error: 'room r out of bounds' });
    expect(validateLayout({ ...b, rooms: [room, { ...room, id: 's', x: 3 }] })).toMatchObject({ ok: false, error: 'room s overlaps room r' });
    expect(validateLayout({ ...b, rooms: [room, { ...room, id: 's', x: 4 }] }).ok).toBe(true);
    const named = validateLayout({ ...b, rooms: [{ ...room, name: 'x'.repeat(80), evil: 1 }] });
    expect(named.ok && named.layout.rooms![0]!.name).toHaveLength(40);
    expect(named.ok && (named.layout.rooms![0] as unknown as Record<string, unknown>).evil).toBeUndefined();
  });

  it('accepts every new furniture type on the floor', () => {
    const b = base();
    const types = FURNITURE_TYPES.filter((t) => t !== 'board' && t !== 'desk');
    const items = types.map((type, i) => ({ id: `n${i}`, type, x: i % 12, y: 6 + Math.floor(i / 12) }));
    const r = validateLayout({ ...b, rows: 9, items: [...b.items, ...items] });
    expect(r.ok).toBe(true);
    for (const t of ['server', 'whiteboard', 'screen', 'table', 'chair', 'snack', 'reception', 'noticeboard', 'console']) expect(FURNITURE_TYPES).toContain(t);
  });
});

describe('default layout', () => {
  const layout = defaultLayout();
  const reach = reachableTiles(layout);
  const blocked = blockedTiles(layout);

  it('is a large multi-department office that validates', () => {
    expect(layout.cols).toBeGreaterThanOrEqual(40);
    expect(layout.rows).toBeGreaterThanOrEqual(28);
    expect(validateLayout(layout).ok).toBe(true);
    const kinds = new Set(layout.rooms!.map((r) => r.kind));
    for (const kind of [...DEPARTMENT_KINDS, 'meeting', 'break', 'restroom', 'reception', 'corridor'] as const) expect(kinds, kind).toContain(kind);
    for (const r of layout.rooms!) expect(ROOM_KINDS).toContain(r.kind);
  });

  it('has the expected props in their rooms', () => {
    const roomOf = (p: { x: number; y: number }) => layout.rooms!.find((r) => roomContains(r, p))?.kind;
    const typesIn = (kind: string) => new Set(layout.items.filter((i) => roomOf(i) === kind).map((i) => i.type));
    expect(typesIn('devops')).toContain('server');
    expect(typesIn('security')).toContain('console');
    expect(typesIn('research')).toContain('bookshelf');
    expect(typesIn('research')).toContain('whiteboard');
    expect(typesIn('meeting')).toEqual(expect.objectContaining(new Set(['table', 'chair', 'screen'])));
    for (const t of ['coffee', 'cooler', 'couch', 'snack']) expect(typesIn('break'), t).toContain(t);
    expect(typesIn('restroom')).toContain('toilet');
    expect(typesIn('reception')).toContain('reception');
    expect(typesIn('reception')).toContain('noticeboard');
    expect(typesIn('collaboration')).toContain('table');
    // desks in every department room
    for (const d of DEPARTMENT_KINDS) expect(typesIn(d), d).toContain('desk');
    expect(layout.items.filter((i) => i.type === 'desk').length).toBeGreaterThanOrEqual(30);
  });

  it('keeps the idle-life fixtures of the original office (2 restroom stalls, 4 couch seats, free windows)', () => {
    expect(layout.items.filter((i) => i.type === 'toilet')).toHaveLength(2);
    expect(layout.items.filter((i) => i.type === 'couch')).toHaveLength(4);
    for (const x of [2, 6, 10]) expect(blocked.has(`${x},${WALL_ROWS}`)).toBe(false);
  });

  it('reaches every desk chair and every room from the door', () => {
    for (const d of layout.items.filter((i) => i.type === 'desk')) expect(reach.has(k(seatOf(d))), d.id).toBe(true);
    for (const r of layout.rooms!) {
      let any = false;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (reach.has(`${x},${y}`)) any = true;
      expect(any, r.id).toBe(true);
    }
  });

  it('gives every furniture item a reachable neighbour (tables are reached through their chairs)', () => {
    for (const it of layout.items) {
      if (it.type === 'board' || it.type === 'table') continue;
      const n = [
        { x: it.x, y: it.y + 1 },
        { x: it.x - 1, y: it.y },
        { x: it.x + 1, y: it.y },
        { x: it.x, y: it.y - 1 },
      ];
      expect(n.some((p) => reach.has(k(p))), it.id).toBe(true);
    }
  });

  it('lets every room be entered on foot from outside it (a doorway or an open side)', () => {
    for (const r of layout.rooms!) {
      let entrances = 0;
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) {
          if (!reach.has(`${x},${y}`)) continue;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const n = { x: x + dx, y: y + dy };
            if (!roomContains(r, n) && reach.has(k(n))) entrances++;
          }
        }
      expect(entrances, r.id).toBeGreaterThan(0);
    }
    // the department rooms each have a narrow doorway in their wall
    for (const id of ['dev', 'qa', 'research', 'devops', 'security', 'meeting', 'restroom']) {
      const r = layout.rooms!.find((x) => x.id === id)!;
      let gaps = 0;
      for (let y = r.y - 1; y <= r.y + r.h; y++)
        for (let x = r.x - 1; x <= r.x + r.w; x++) {
          const edge = x === r.x - 1 || x === r.x + r.w || y === r.y - 1 || y === r.y + r.h;
          if (edge && !roomContains(r, { x, y }) && reach.has(`${x},${y}`) && !layout.rooms!.some((o) => roomContains(o, { x, y }))) gaps++;
        }
      expect(gaps, id).toBeGreaterThan(0);
      expect(gaps, id).toBeLessThanOrEqual(4);
    }
  });

  it('has walls only between rooms (never inside a room rectangle)', () => {
    for (const w of layout.walls!) expect(layout.rooms!.some((r) => roomContains(r, w)), k(w)).toBe(false);
  });
});

describe('layoutFromMap', () => {
  it('parses symbols into stable ids and walls', () => {
    const { items, walls } = layoutFromMap(['D.#', 'hXh']);
    expect(walls).toEqual([{ x: 2, y: WALL_ROWS }]);
    expect(items.map((i) => i.id)).toEqual(['desk-1', 'chair-1', 'table-1', 'chair-2']);
    expect(() => layoutFromMap(['D?'])).toThrow(/unknown map symbol/);
    expect(() => layoutFromMap(['..', '.'])).toThrow(/columns/);
  });
});
