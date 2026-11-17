/** Office layout model shared by the monitor (persistence/validation) and the UI (rendering/editing). */
import { ROOM_KINDS, type RoomKind } from './contracts/office';

export const FURNITURE_TYPES = [
  'desk',
  'plant',
  'cooler',
  'board',
  'bookshelf',
  'couch',
  'printer',
  'lamp',
  'toilet',
  'coffee',
  // Department and room furniture (all decorative or spots; desks remain the only agent seats).
  'server',
  'whiteboard',
  'screen',
  'table',
  'chair',
  'snack',
  'reception',
  'noticeboard',
  'console',
] as const;
export type FurnitureType = (typeof FURNITURE_TYPES)[number];

export interface FurnitureItem {
  id: string;
  type: FurnitureType;
  x: number;
  y: number;
}

/** A coloured floor area. Desks inside a zone with `workspaceMatch` are preferred for agents in that workspace. */
export interface Zone {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  /** Case-insensitive substring matched against the agent's cwd, e.g. "projects\\my-app". */
  workspaceMatch?: string;
}

/** One interior wall tile. Walls block movement; a gap in a wall line is a doorway. */
export interface WallTile {
  x: number;
  y: number;
}

/**
 * A named room: a rectangle of floor with a kind. Rooms are local layout semantics (floor style,
 * labels, department desk preference), never a verified Claude role. Rooms may not overlap.
 */
export interface Room {
  id: string;
  name: string;
  kind: RoomKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OfficeLayout {
  version: 1;
  name: string;
  cols: number;
  rows: number;
  /** Floor tile where workers enter and leave. Must be on the bottom row. */
  door: { x: number };
  items: FurnitureItem[];
  zones: Zone[];
  /** Interior wall tiles. Optional: older layouts have none. */
  walls?: WallTile[];
  /** Named rooms. Optional: older layouts have none. */
  rooms?: Room[];
}

/** Rows 0-1 are wall; the floor starts at this row. */
export const WALL_ROWS = 2;
export const MIN_COLS = 10;
export const MAX_COLS = 48;
export const MIN_ROWS = 8;
export const MAX_ROWS = 32;
export const MAX_ITEMS = 400;
export const MAX_ZONES = 20;
export const MAX_WALLS = 1200;
export const MAX_ROOMS = 40;

/** Furniture that hangs on the back wall instead of standing on the floor. */
export function isWallMounted(type: FurnitureType): boolean {
  return type === 'board';
}

export function isBlocking(type: FurnitureType): boolean {
  return type !== 'board';
}

/** The tile a worker occupies when seated at a desk (in front of it, facing the monitor). */
export function seatOf(desk: Pick<FurnitureItem, 'x' | 'y'>): { x: number; y: number } {
  return { x: desk.x, y: desk.y + 1 };
}

const tileKey = (x: number, y: number) => `${x},${y}`;

/** Tiles that block movement: blocking furniture and interior walls. */
export function blockedTiles(layout: Pick<OfficeLayout, 'items' | 'walls'>): Set<string> {
  const out = new Set<string>();
  for (const it of layout.items) if (isBlocking(it.type)) out.add(tileKey(it.x, it.y));
  for (const w of layout.walls ?? []) out.add(tileKey(w.x, w.y));
  return out;
}

/** Floor tiles reachable on foot from the door (4-connected), as "x,y" keys. */
export function reachableTiles(layout: Pick<OfficeLayout, 'cols' | 'rows' | 'door' | 'items' | 'walls'>): Set<string> {
  const blocked = blockedTiles(layout);
  const seen = new Set<string>();
  const start = { x: layout.door.x, y: layout.rows - 1 };
  if (blocked.has(tileKey(start.x, start.y))) return seen;
  const queue = [start];
  seen.add(tileKey(start.x, start.y));
  while (queue.length) {
    const p = queue.pop()!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = p.x + dx;
      const y = p.y + dy;
      const k = tileKey(x, y);
      if (x < 0 || x >= layout.cols || y < WALL_ROWS || y >= layout.rows || seen.has(k) || blocked.has(k)) continue;
      seen.add(k);
      queue.push({ x, y });
    }
  }
  return seen;
}

export function roomContains(r: Pick<Room, 'x' | 'y' | 'w' | 'h'>, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
}

function overlaps(a: Pick<Room, 'x' | 'y' | 'w' | 'h'>, b: Pick<Room, 'x' | 'y' | 'w' | 'h'>): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// ------------------------------------------------------------------ default layouts

const MAP_LEGEND: Record<string, FurnitureType | 'wall' | undefined> = {
  '.': undefined,
  '#': 'wall',
  D: 'desk',
  P: 'plant',
  C: 'cooler',
  S: 'bookshelf',
  U: 'couch',
  R: 'printer',
  L: 'lamp',
  T: 'toilet',
  K: 'coffee',
  V: 'server',
  W: 'whiteboard',
  Y: 'screen',
  X: 'table',
  h: 'chair',
  N: 'snack',
  Q: 'reception',
  O: 'noticeboard',
  Z: 'console',
};

/**
 * Build items and walls from an ASCII floor plan (one string per floor row, starting at
 * WALL_ROWS). Ids are `<type>-<n>` in reading order, so they are stable for a given map.
 */
export function layoutFromMap(map: readonly string[]): { items: FurnitureItem[]; walls: WallTile[] } {
  const items: FurnitureItem[] = [];
  const walls: WallTile[] = [];
  const counters = new Map<string, number>();
  map.forEach((row, i) => {
    const y = WALL_ROWS + i;
    if (row.length !== map[0]!.length) throw new Error(`map row ${y} has ${row.length} columns, expected ${map[0]!.length}`);
    [...row].forEach((ch, x) => {
      if (!(ch in MAP_LEGEND)) throw new Error(`unknown map symbol ${ch} at ${x},${y}`);
      const t = MAP_LEGEND[ch];
      if (!t) return;
      if (t === 'wall') {
        walls.push({ x, y });
        return;
      }
      const n = (counters.get(t) ?? 0) + 1;
      counters.set(t, n);
      items.push({ id: `${t}-${n}`, type: t, x, y });
    });
  });
  return { items, walls };
}

/**
 * The default office: 44×30 tiles with department rooms along the back wall, a corridor,
 * security/collaboration/meeting/break rooms in the middle, and restrooms, reception (main
 * door) and a huddle room at the front. Legend: see MAP_LEGEND (D desk; its chair is the
 * free tile below it).
 */
const DEFAULT_MAP = [
  // x: 0         1         2         3         4
  //    01234567890123456789012345678901234567890123
  'P............R.P#P.........#P......S#VVVVVVP', // y2
  '..DD..DD..DD...C#.DD..DD..O#.DD..DD.#.......', // y3
  '................#..........#........#.......', // y4
  '................#..........#........#.DD.DD.', // y5
  '..DD..DD..DD...S#.DD..DD...#.DD..W..#.......', // y6
  '................#..........#........#.......', // y7
  '................#..........#........#VVV.VVV', // y8
  '..DD..DD..DD...P#R.........#........#.......', // y9
  'P...............#.........P#SSS..SSS#......P', // y10
  '########..##########..#########..#######..##', // y11
  'P...........O....................O.........P', // y12
  '............................................', // y13
  '####..#####P............P##.############..##', // y14
  'ZZ.......P#......W....DD.#P...Y...P#.KNC...P', // y15
  '..DD..DD..#..............#.........#........', // y16
  '..........#..hhh...hhh...#..hhhhh..#....hXXh', // y17
  '..........#.hXXXh.hXXXh..#.hXXXXXh.#.....hh.', // y18
  '..........#..hhh...hhh...#..XXXXX..#........', // y19
  '..........#..............#..hhhhh..#.UUL.UU.', // y20
  'P......LOP#..............#........P#.......P', // y21
  '###########P............P################.##', // y22
  '.T.T.#OP....................PO#P.W.........P', // y23
  '.....#........................#....hhh......', // y24
  '.....#..............QQQ.......#...hXXXh.....', // y25
  '...............................' + '....XXX......', // y26 (doorways at x=5 and x=30)
  '.....#..LhhhP..............C..#....hhh......', // y27
  '.....#........................#.............', // y28
  'P...P#P......................P#P...........P', // y29
];

const DEFAULT_ROOMS: Room[] = [
  { id: 'dev', name: 'Development', kind: 'development', x: 0, y: 2, w: 16, h: 9 },
  { id: 'qa', name: 'QA & Testing', kind: 'qa', x: 17, y: 2, w: 10, h: 9 },
  { id: 'research', name: 'Research', kind: 'research', x: 28, y: 2, w: 8, h: 9 },
  { id: 'devops', name: 'DevOps · Servers', kind: 'devops', x: 37, y: 2, w: 7, h: 9 },
  { id: 'corridor', name: 'Corridor', kind: 'corridor', x: 0, y: 12, w: 44, h: 2 },
  { id: 'security', name: 'Security', kind: 'security', x: 0, y: 15, w: 10, h: 7 },
  { id: 'collab', name: 'Collaboration', kind: 'collaboration', x: 11, y: 14, w: 14, h: 9 },
  { id: 'meeting', name: 'Meeting room', kind: 'meeting', x: 26, y: 15, w: 9, h: 7 },
  { id: 'break', name: 'Break room', kind: 'break', x: 36, y: 15, w: 8, h: 7 },
  { id: 'restroom', name: 'Restrooms', kind: 'restroom', x: 0, y: 23, w: 5, h: 7 },
  { id: 'reception', name: 'Reception', kind: 'reception', x: 6, y: 23, w: 24, h: 7 },
  { id: 'huddle', name: 'Huddle room', kind: 'meeting', x: 31, y: 23, w: 13, h: 7 },
];

export function defaultLayout(): OfficeLayout {
  const { items, walls } = layoutFromMap(DEFAULT_MAP);
  items.push({ id: 'board-1', type: 'board', x: 8, y: 1 });
  return {
    version: 1,
    name: 'Department office',
    cols: 44,
    rows: 30,
    door: { x: 18 },
    items,
    zones: [],
    walls,
    rooms: DEFAULT_ROOMS.map((r) => ({ ...r })),
  };
}

/** The original single-room open office (23×14), kept as a template for small screens. */
export function openOfficeLayout(): OfficeLayout {
  const items: FurnitureItem[] = [];
  let n = 0;
  const desk = (x: number, y: number) => items.push({ id: `desk-${++n}`, type: 'desk', x, y });
  // Desk pairs; each worker sits on the tile below their desk, facing the monitor.
  for (const y of [3, 6, 9]) for (const x of [3, 4, 8, 9, 13, 14, 18, 19]) desk(x, y);
  items.push(
    { id: 'board-1', type: 'board', x: 11, y: 1 },
    { id: 'shelf-1', type: 'bookshelf', x: 1, y: 2 },
    { id: 'shelf-2', type: 'bookshelf', x: 21, y: 2 },
    { id: 'plant-1', type: 'plant', x: 1, y: 13 },
    { id: 'plant-2', type: 'plant', x: 21, y: 13 },
    { id: 'plant-3', type: 'plant', x: 6, y: 2 },
    { id: 'plant-4', type: 'plant', x: 16, y: 2 },
    { id: 'cooler-1', type: 'cooler', x: 21, y: 6 },
    { id: 'printer-1', type: 'printer', x: 1, y: 6 },
    { id: 'couch-1', type: 'couch', x: 4, y: 12 },
    { id: 'couch-2', type: 'couch', x: 5, y: 12 },
    { id: 'couch-3', type: 'couch', x: 17, y: 12 },
    { id: 'couch-4', type: 'couch', x: 18, y: 12 },
    { id: 'lamp-1', type: 'lamp', x: 3, y: 12 },
    { id: 'lamp-2', type: 'lamp', x: 19, y: 12 },
    { id: 'wc-1', type: 'toilet', x: 1, y: 9 },
    { id: 'wc-2', type: 'toilet', x: 2, y: 9 },
    { id: 'coffee-1', type: 'coffee', x: 21, y: 9 },
  );
  return { version: 1, name: 'Open office', cols: 23, rows: 14, door: { x: 11 }, items, zones: [] };
}

// ------------------------------------------------------------------ validation

export type LayoutResult = { ok: true; layout: OfficeLayout } | { ok: false; error: string };

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

function int(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

/**
 * Strict validation: layouts arrive from the UI and are written to disk by the monitor.
 * Version-1 layouts without walls/rooms validate exactly as before (and come back without
 * those keys). Layouts with interior walls must also keep every desk chair reachable from
 * the door.
 */
export function validateLayout(input: unknown): LayoutResult {
  if (!input || typeof input !== 'object') return { ok: false, error: 'layout must be an object' };
  const l = input as Record<string, unknown>;
  if (l.version !== 1) return { ok: false, error: 'unsupported layout version' };
  const cols = int(l.cols, MIN_COLS, MAX_COLS);
  const rows = int(l.rows, MIN_ROWS, MAX_ROWS);
  if (cols === undefined || rows === undefined) return { ok: false, error: 'cols/rows out of range' };
  const name = typeof l.name === 'string' ? l.name.slice(0, 60) : 'Office';
  const doorRaw = l.door as Record<string, unknown> | undefined;
  const doorX = int(doorRaw?.x, 0, cols - 1);
  if (doorX === undefined) return { ok: false, error: 'invalid door' };
  if (!Array.isArray(l.items) || l.items.length > MAX_ITEMS) return { ok: false, error: 'invalid items' };
  if (!Array.isArray(l.zones) || l.zones.length > MAX_ZONES) return { ok: false, error: 'invalid zones' };
  if (l.walls !== undefined && (!Array.isArray(l.walls) || l.walls.length > MAX_WALLS)) return { ok: false, error: 'invalid walls' };
  if (l.rooms !== undefined && (!Array.isArray(l.rooms) || l.rooms.length > MAX_ROOMS)) return { ok: false, error: 'invalid rooms' };

  // Interior walls first, so furniture on a wall tile is reported as such.
  const walls: WallTile[] = [];
  const wallSet = new Set<string>();
  for (const raw of (l.walls as unknown[] | undefined) ?? []) {
    const w = raw as Record<string, unknown> | null;
    const x = int(w?.x, 0, cols - 1);
    const y = int(w?.y, WALL_ROWS, rows - 1);
    if (x === undefined || y === undefined) return { ok: false, error: 'wall out of bounds' };
    const k = tileKey(x, y);
    if (wallSet.has(k)) return { ok: false, error: `duplicate wall at ${k}` };
    if (x === doorX && y === rows - 1) return { ok: false, error: 'a wall blocks the door' };
    wallSet.add(k);
    walls.push({ x, y });
  }

  const items: FurnitureItem[] = [];
  const occupied = new Set<string>();
  const ids = new Set<string>();
  for (const raw of l.items) {
    const it = raw as Record<string, unknown>;
    if (!it || typeof it.id !== 'string' || !ID.test(it.id) || ids.has(it.id)) return { ok: false, error: 'invalid item id' };
    if (!FURNITURE_TYPES.includes(it.type as FurnitureType)) return { ok: false, error: `invalid item type ${String(it.type)}` };
    const type = it.type as FurnitureType;
    const mounted = isWallMounted(type);
    const minY = mounted ? 1 : WALL_ROWS;
    const maxY = mounted ? 1 : type === 'desk' ? rows - 2 : rows - 1;
    const x = int(it.x, 0, cols - 1);
    const y = int(it.y, minY, maxY);
    if (x === undefined || y === undefined) return { ok: false, error: `item ${it.id} out of bounds` };
    const cell = tileKey(x, y);
    if (!mounted) {
      if (occupied.has(cell)) return { ok: false, error: `item ${it.id} overlaps another item` };
      if (wallSet.has(cell)) return { ok: false, error: `item ${it.id} is inside a wall` };
      occupied.add(cell);
    }
    ids.add(it.id);
    items.push({ id: it.id, type, x, y });
  }
  // Desk chairs (the tile below a desk) must stay free so workers can sit.
  for (const it of items) {
    if (it.type !== 'desk') continue;
    const chair = tileKey(it.x, it.y + 1);
    if (occupied.has(chair)) return { ok: false, error: `desk ${it.id} chair is blocked` };
    if (wallSet.has(chair)) return { ok: false, error: `desk ${it.id} chair is blocked by a wall` };
    if (it.x === doorX && it.y + 1 === rows - 1) return { ok: false, error: `desk ${it.id} chair blocks the door` };
  }
  if (occupied.has(tileKey(doorX, rows - 1))) return { ok: false, error: 'the door tile is blocked' };

  const zones: Zone[] = [];
  for (const raw of l.zones) {
    const z = raw as Record<string, unknown>;
    if (!z || typeof z.id !== 'string' || !ID.test(z.id)) return { ok: false, error: 'invalid zone id' };
    const x = int(z.x, 0, cols - 1);
    const y = int(z.y, WALL_ROWS, rows - 1);
    const w = int(z.w, 1, cols);
    const h = int(z.h, 1, rows);
    if (x === undefined || y === undefined || w === undefined || h === undefined || x + w > cols || y + h > rows) {
      return { ok: false, error: `zone ${z.id} out of bounds` };
    }
    const color = typeof z.color === 'string' && COLOR.test(z.color) ? z.color : '#3a4a6b';
    const zone: Zone = { id: z.id, name: typeof z.name === 'string' ? z.name.slice(0, 40) : z.id, x, y, w, h, color };
    if (typeof z.workspaceMatch === 'string' && z.workspaceMatch.trim()) zone.workspaceMatch = z.workspaceMatch.trim().slice(0, 260);
    zones.push(zone);
  }

  const rooms: Room[] = [];
  const roomIds = new Set<string>();
  for (const raw of (l.rooms as unknown[] | undefined) ?? []) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r.id !== 'string' || !ID.test(r.id) || roomIds.has(r.id)) return { ok: false, error: 'invalid room id' };
    if (!ROOM_KINDS.includes(r.kind as RoomKind)) return { ok: false, error: `room ${r.id} has an invalid kind` };
    const x = int(r.x, 0, cols - 1);
    const y = int(r.y, WALL_ROWS, rows - 1);
    const w = int(r.w, 1, cols);
    const h = int(r.h, 1, rows);
    if (x === undefined || y === undefined || w === undefined || h === undefined || x + w > cols || y + h > rows) {
      return { ok: false, error: `room ${r.id} out of bounds` };
    }
    const room: Room = { id: r.id, name: typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 40) : r.id, kind: r.kind as RoomKind, x, y, w, h };
    const clash = rooms.find((o) => overlaps(o, room));
    if (clash) return { ok: false, error: `room ${room.id} overlaps room ${clash.id}` };
    roomIds.add(room.id);
    rooms.push(room);
  }

  const layout: OfficeLayout = { version: 1, name, cols, rows, door: { x: doorX }, items, zones };
  if (walls.length) layout.walls = walls;
  if (rooms.length) layout.rooms = rooms;

  // With interior walls, every desk must be reachable on foot from the door. (Older wall-less
  // layouts are not checked so that saved user layouts keep loading unchanged.)
  if (walls.length) {
    const reach = reachableTiles(layout);
    for (const it of items) {
      if (it.type !== 'desk') continue;
      const s = seatOf(it);
      if (!reach.has(tileKey(s.x, s.y))) return { ok: false, error: `desk ${it.id} cannot be reached from the door` };
    }
  }
  return { ok: true, layout };
}
