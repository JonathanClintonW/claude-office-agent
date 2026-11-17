import { isWallMounted, roomContains, validateLayout, WALL_ROWS, type FurnitureType, type OfficeLayout, type Room, type RoomKind, type WallTile, type Zone } from '@agent-office/core';

export type EditTool = FurnitureType | 'erase' | 'door' | 'wall' | 'unwall';

export type EditResult = { ok: true; layout: OfficeLayout } | { ok: false; error: string };

function nextId(layout: OfficeLayout, prefix: string): string {
  const rooms = layout.rooms ?? [];
  let n = layout.items.length + layout.zones.length + rooms.length + 1;
  const ids = new Set([...layout.items.map((i) => i.id), ...layout.zones.map((z) => z.id), ...rooms.map((r) => r.id)]);
  while (ids.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

function check(layout: OfficeLayout): EditResult {
  const r = validateLayout(layout);
  return r.ok ? { ok: true, layout: r.layout } : { ok: false, error: r.error };
}

const isWallAt = (layout: OfficeLayout, x: number, y: number) => (layout.walls ?? []).some((w) => w.x === x && w.y === y);
const withWalls = (layout: OfficeLayout, walls: WallTile[]): OfficeLayout => ({ ...layout, walls });

/** Apply the selected tool to a tile. */
export function applyTool(layout: OfficeLayout, tool: EditTool, x: number, y: number): EditResult {
  const walls = layout.walls ?? [];
  if (tool === 'erase') {
    const items = layout.items.filter((i) => !(i.x === x && i.y === y));
    if (items.length !== layout.items.length) return check({ ...layout, items });
    if (isWallAt(layout, x, y)) return check(withWalls(layout, walls.filter((w) => !(w.x === x && w.y === y))));
    return { ok: false, error: 'Nothing to remove here' };
  }
  if (tool === 'door') {
    if (y !== layout.rows - 1) return { ok: false, error: 'The door must be on the bottom row' };
    return check({ ...layout, door: { x } });
  }
  if (tool === 'wall') {
    if (y < WALL_ROWS) return { ok: false, error: 'Interior walls go on the floor' };
    if (isWallAt(layout, x, y)) return { ok: false, error: 'There is already a wall here' };
    if (layout.items.some((i) => i.x === x && i.y === y && !isWallMounted(i.type))) return { ok: false, error: 'Remove the furniture here first' };
    return check(withWalls(layout, [...walls, { x, y }]));
  }
  if (tool === 'unwall') {
    if (!isWallAt(layout, x, y)) return { ok: false, error: 'No wall here' };
    return check(withWalls(layout, walls.filter((w) => !(w.x === x && w.y === y))));
  }
  const mounted = isWallMounted(tool);
  if (mounted ? y !== 1 : y < WALL_ROWS) return { ok: false, error: mounted ? 'Boards hang on the wall (top row)' : 'Furniture goes on the floor' };
  if (!mounted && isWallAt(layout, x, y)) return { ok: false, error: 'Remove the wall here first' };
  const items = layout.items.filter((i) => !(i.x === x && i.y === y && mounted === isWallMounted(i.type)));
  return check({ ...layout, items: [...items, { id: nextId(layout, tool), type: tool, x, y }] });
}

export function moveItem(layout: OfficeLayout, id: string, x: number, y: number): EditResult {
  if (!layout.items.some((i) => i.id === id)) return { ok: false, error: 'Unknown item' };
  return check({ ...layout, items: layout.items.map((i) => (i.id === id ? { ...i, x, y } : i)) });
}

function clip<T extends { x: number; y: number; w: number; h: number }>(r: T, cols: number, rows: number): T {
  return { ...r, w: Math.min(r.w, cols - r.x), h: Math.min(r.h, rows - r.y) };
}

export function resizeLayout(layout: OfficeLayout, cols: number, rows: number): EditResult {
  // Desks need their chair tile (below) inside the room too.
  const items = layout.items.filter((i) => i.x < cols && i.y < rows - (i.type === 'desk' ? 1 : 0));
  const zones = layout.zones.filter((z) => z.x < cols && z.y < rows).map((z) => clip(z, cols, rows));
  const door = { x: Math.min(layout.door.x, cols - 1) };
  // Never leave anything on the new bottom row's door tile.
  const cleared = items.filter((i) => !(i.x === door.x && i.y === rows - 1));
  const next: OfficeLayout = { ...layout, cols, rows, items: cleared, zones, door };
  if (layout.walls) next.walls = layout.walls.filter((w) => w.x < cols && w.y < rows && !(w.x === door.x && w.y === rows - 1));
  if (layout.rooms) next.rooms = layout.rooms.filter((r) => r.x < cols && r.y < rows).map((r) => clip(r, cols, rows));
  return check(next);
}

export function addZone(layout: OfficeLayout): EditResult {
  const zone: Zone = {
    id: nextId(layout, 'zone'),
    name: `Team ${layout.zones.length + 1}`,
    x: 1,
    y: WALL_ROWS,
    w: Math.min(8, layout.cols - 1),
    h: Math.min(4, layout.rows - WALL_ROWS),
    color: ['#4f8cff', '#38c172', '#ff7a59', '#b06bff', '#ffcd3c'][layout.zones.length % 5]!,
  };
  return check({ ...layout, zones: [...layout.zones, zone] });
}

export function updateZone(layout: OfficeLayout, id: string, patch: Partial<Zone>): EditResult {
  return check({ ...layout, zones: layout.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)) });
}

export function removeZone(layout: OfficeLayout, id: string): EditResult {
  return check({ ...layout, zones: layout.zones.filter((z) => z.id !== id) });
}

// ------------------------------------------------------------------ rooms

const overlapsAny = (rooms: readonly Room[], r: Pick<Room, 'x' | 'y' | 'w' | 'h'>) =>
  rooms.some((o) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h);

/** Add a room in the first free, wall-free rectangle (rooms may not overlap). */
export function addRoom(layout: OfficeLayout, kind: RoomKind = 'office'): EditResult {
  const rooms = layout.rooms ?? [];
  const walls = layout.walls ?? [];
  const hasWall = (r: Pick<Room, 'x' | 'y' | 'w' | 'h'>) => walls.some((w) => roomContains(r, w));
  for (const [w, h] of [
    [6, 4],
    [4, 3],
    [3, 2],
    [2, 2],
  ] as const) {
    for (let y = WALL_ROWS; y + h <= layout.rows; y++)
      for (let x = 0; x + w <= layout.cols; x++) {
        if (overlapsAny(rooms, { x, y, w, h }) || hasWall({ x, y, w, h })) continue;
        const room: Room = { id: nextId(layout, 'room'), name: `Room ${rooms.length + 1}`, kind, x, y, w, h };
        return check({ ...layout, rooms: [...rooms, room] });
      }
  }
  return { ok: false, error: 'No free floor for a new room: shrink or remove a room first' };
}

export function updateRoom(layout: OfficeLayout, id: string, patch: Partial<Omit<Room, 'id'>>): EditResult {
  const rooms = layout.rooms ?? [];
  if (!rooms.some((r) => r.id === id)) return { ok: false, error: 'Unknown room' };
  return check({ ...layout, rooms: rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
}

export function removeRoom(layout: OfficeLayout, id: string): EditResult {
  if (!(layout.rooms ?? []).some((r) => r.id === id)) return { ok: false, error: 'Unknown room' };
  return check({ ...layout, rooms: (layout.rooms ?? []).filter((r) => r.id !== id) });
}

/**
 * Surround a room with walls on the ring just outside it, leaving a doorway on the side
 * nearest the office door. Tiles with furniture, desk chairs, the door or other walls are
 * left as they are. Validation then checks every desk is still reachable.
 */
export function wallInRoom(layout: OfficeLayout, id: string): EditResult {
  const room = (layout.rooms ?? []).find((r) => r.id === id);
  if (!room) return { ok: false, error: 'Unknown room' };
  const existing = new Set((layout.walls ?? []).map((w) => `${w.x},${w.y}`));
  const busy = new Set(layout.items.filter((i) => !isWallMounted(i.type)).map((i) => `${i.x},${i.y}`));
  for (const d of layout.items) if (d.type === 'desk') busy.add(`${d.x},${d.y + 1}`);
  const door = { x: layout.door.x, y: layout.rows - 1 };
  busy.add(`${door.x},${door.y}`);
  const ring: WallTile[] = [];
  for (let x = room.x - 1; x <= room.x + room.w; x++) for (const y of [room.y - 1, room.y + room.h]) ring.push({ x, y });
  for (let y = room.y; y < room.y + room.h; y++) for (const x of [room.x - 1, room.x + room.w]) ring.push({ x, y });
  const inBounds = (p: WallTile) => p.x >= 0 && p.x < layout.cols && p.y >= WALL_ROWS && p.y < layout.rows;
  const corner = (p: WallTile) => (p.x === room.x - 1 || p.x === room.x + room.w) && (p.y === room.y - 1 || p.y === room.y + room.h);
  const candidates = ring.filter((p) => inBounds(p) && !existing.has(`${p.x},${p.y}`) && !busy.has(`${p.x},${p.y}`));
  if (!candidates.length) return { ok: false, error: 'Nothing to wall in: the room already has walls or touches the edges' };
  // Doorway: a non-corner ring tile with free floor on both sides, nearest the office door,
  // preferring one outside other rooms.
  const solid = new Set([...existing, ...layout.items.filter((i) => !isWallMounted(i.type)).map((i) => `${i.x},${i.y}`)]);
  const freeFloor = (p: WallTile) => inBounds(p) && !solid.has(`${p.x},${p.y}`);
  const passable = (p: WallTile) => {
    const [dx, dy] = p.y === room.y - 1 ? [0, 1] : p.y === room.y + room.h ? [0, -1] : p.x === room.x - 1 ? [1, 0] : [-1, 0];
    return freeFloor({ x: p.x + dx, y: p.y + dy }) && freeFloor({ x: p.x - dx, y: p.y - dy });
  };
  const dist = (p: WallTile) => Math.abs(p.x - door.x) + Math.abs(p.y - door.y);
  const inOther = (p: WallTile) => (layout.rooms ?? []).some((r) => r.id !== room.id && roomContains(r, p));
  const openings = candidates.filter((p) => !corner(p));
  const doorway = [...openings].sort(
    (a, b) => Number(passable(b)) - Number(passable(a)) || Number(inOther(a)) - Number(inOther(b)) || dist(a) - dist(b) || a.y - b.y || a.x - b.x,
  )[0];
  const add = candidates.filter((p) => p !== doorway);
  if (!add.length) return { ok: false, error: 'Nothing to wall in' };
  return check({ ...layout, walls: [...(layout.walls ?? []), ...add] });
}
