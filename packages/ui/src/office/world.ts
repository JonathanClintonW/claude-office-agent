/**
 * Layout → behavior world: interactive spots, chat tiles, rooms, lounge seats, room doorways
 * and reception counters. Pure: no rendering, no randomness. Only tiles reachable on foot from
 * the door are used. Spots and chat tiles stay off meeting seats and presenter spots, so one
 * provider's destination tiles never double as another's.
 */
import { blockedTiles, reachableTiles, roomContains, seatOf, WALL_ROWS, type FurnitureItem, type FurnitureType, type OfficeLayout, type RoomKind } from '@agent-office/core';
import type { Face, Point, RoomInfo, Seat, Spot, SpotKind, World } from './behavior';

const key = (p: Point) => `${p.x},${p.y}`;
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

/** Neighbour offsets in preference order (in front of an item first), with the face that looks back at it. */
const AROUND: ReadonlyArray<{ dx: number; dy: number; face: Face }> = [
  { dx: 0, dy: 1, face: 'up' },
  { dx: -1, dy: 0, face: 'right' },
  { dx: 1, dy: 0, face: 'left' },
  { dx: 0, dy: -1, face: 'down' },
];

/** Furniture that offers a spot, and the kind of spot. */
const SPOT_OF: Partial<Record<FurnitureType, SpotKind>> = {
  cooler: 'water',
  coffee: 'coffee',
  toilet: 'toilet',
  snack: 'snack',
  bookshelf: 'books',
  noticeboard: 'board',
  board: 'board',
  whiteboard: 'whiteboard',
  plant: 'plant',
};

/** Rooms where free tiles around tables count as (standing) seats when there are no chairs. */
const STANDING_SEAT_KINDS = new Set(['meeting', 'collaboration']);

/** Common areas whose free-standing chairs (not at a table) are lounge seats. */
const LOUNGE_ROOM_KINDS: ReadonlySet<RoomKind> = new Set<RoomKind>(['reception', 'break', 'corridor', 'office', 'collaboration']);

/** A free-standing chair in a common area where an idle worker can sit for a while. */
export interface LoungeSeat {
  id: string;
  /** The chair tile (a blocked tile, walked onto as a path goal). */
  at: Point;
  face: Face;
  roomId?: string;
}

/** A tile just inside a room entrance, facing into the room (where a passer-by looks in). */
export interface Doorway {
  roomId: string;
  at: Point;
  face: Face;
}

/** Where someone stands to talk to the reception desk (simulated visitors check in here). */
export interface Counter {
  id: string;
  at: Point;
  face: Face;
  roomId?: string;
}

export interface OfficeWorld extends World {
  lounges: LoungeSeat[];
  doorways: Doorway[];
  counters: Counter[];
}

/** Which way a meeting chair faces: towards an adjacent table, else down (towards the viewer). */
export function chairFacing(layout: Pick<OfficeLayout, 'items'>, chair: Point): Face {
  const tables = new Set(layout.items.filter((i) => i.type === 'table').map(key));
  for (const { dx, dy } of AROUND) {
    if (tables.has(key({ x: chair.x + dx, y: chair.y + dy }))) {
      return dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : 'up';
    }
  }
  return 'down';
}

export function buildWorld(layout: OfficeLayout, windowXs: readonly number[], night: boolean): OfficeWorld {
  const blocked = blockedTiles(layout);
  const reach = reachableTiles(layout);
  const seats = new Set(layout.items.filter((i) => i.type === 'desk').map((d) => key(seatOf(d))));
  const door = { x: layout.door.x, y: layout.rows - 1 };
  const rooms = layout.rooms ?? [];
  const roomIdAt = (p: Point) => rooms.find((r) => roomContains(r, p))?.id;
  const free = (p: Point) =>
    p.x >= 0 && p.x < layout.cols && p.y >= WALL_ROWS && p.y < layout.rows && !blocked.has(key(p)) && !seats.has(key(p)) && !same(p, door) && reach.has(key(p));

  // Rooms first: their seats and presenter spots belong to meetings.
  const roomInfos = rooms.map((r) => roomInfo(layout, r, free));
  const meetingTiles = new Set(roomInfos.flatMap((r) => [...r.seats.map((s) => key(s.at)), ...(r.presenter ? [key(r.presenter.at)] : [])]));
  const open = (p: Point) => free(p) && !meetingTiles.has(key(p));
  const access = (it: Point): { at: Point; face: Face } | undefined => {
    for (const a of AROUND) {
      const at = { x: it.x + a.dx, y: it.y + a.dy };
      if (open(at)) return { at, face: a.face };
    }
    return undefined;
  };

  const spots: Spot[] = [];
  const counters: Counter[] = [];
  const push = (s: Spot, roomId: string | undefined) => spots.push(roomId ? { ...s, roomId } : s);
  for (const it of layout.items) {
    const roomId = roomIdAt(it);
    if (it.type === 'reception') {
      const a = access(it);
      if (a) counters.push(roomId ? { id: it.id, ...a, roomId } : { id: it.id, ...a });
      continue;
    }
    if (it.type === 'couch') {
      // Sit on the couch itself; it must be reachable from a free neighbour.
      if (access(it)) push({ id: it.id, kind: 'couch', at: { x: it.x, y: it.y }, face: 'down' }, roomId);
      continue;
    }
    const kind = SPOT_OF[it.type];
    if (!kind) continue;
    if (it.type === 'board') {
      // The task board hangs on the back wall: read it from the floor tile below.
      const at = { x: it.x, y: WALL_ROWS };
      if (open(at)) push({ id: it.id, kind, at, face: 'up' }, roomIdAt(at));
      continue;
    }
    const a = access(it);
    if (a) push({ id: it.id, kind, at: a.at, face: a.face }, roomId);
  }
  for (const x of windowXs) {
    const at = { x, y: WALL_ROWS };
    if (open(at)) push({ id: `window-${x}`, kind: 'window', at, face: 'up' }, roomIdAt(at));
  }

  const used = new Set(spots.map((s) => key(s.at)));
  const chatTiles: Point[] = [];
  for (let y = WALL_ROWS; y < layout.rows; y++)
    for (let x = 0; x < layout.cols - 1; x++) {
      const a = { x, y };
      const b = { x: x + 1, y };
      if (open(a) && open(b) && !used.has(key(a)) && !used.has(key(b))) chatTiles.push(a);
    }

  return { spots, chatTiles, rooms: roomInfos, night, lounges: loungeSeats(layout, free, roomIdAt), doorways: doorways(rooms, open, reach), counters };
}

/** Free-standing chairs (no adjacent table) in common areas, reachable from a free neighbour. */
function loungeSeats(layout: OfficeLayout, free: (p: Point) => boolean, roomIdAt: (p: Point) => string | undefined): LoungeSeat[] {
  const tables = new Set(layout.items.filter((i) => i.type === 'table').map(key));
  const kindOf = new Map((layout.rooms ?? []).map((r) => [r.id, r.kind]));
  const out: LoungeSeat[] = [];
  for (const c of layout.items) {
    if (c.type !== 'chair') continue;
    if (AROUND.some(({ dx, dy }) => tables.has(key({ x: c.x + dx, y: c.y + dy })))) continue;
    if (!AROUND.some(({ dx, dy }) => free({ x: c.x + dx, y: c.y + dy }))) continue;
    const roomId = roomIdAt(c);
    const kind = roomId ? kindOf.get(roomId) : undefined;
    if (kind && !LOUNGE_ROOM_KINDS.has(kind)) continue;
    const seat: LoungeSeat = { id: c.id, at: { x: c.x, y: c.y }, face: chairFacing(layout, c) };
    if (roomId) seat.roomId = roomId;
    out.push(seat);
  }
  return out;
}

/**
 * Entrance tiles of every room: free tiles inside the room with a reachable neighbour outside
 * it, facing into the room. Walls only open at doorways, so these are where workers enter.
 */
function doorways(rooms: NonNullable<OfficeLayout['rooms']>, open: (p: Point) => boolean, reach: ReadonlySet<string>): Doorway[] {
  const out: Doorway[] = [];
  for (const room of rooms) {
    for (let y = room.y; y < room.y + room.h; y++)
      for (let x = room.x; x < room.x + room.w; x++) {
        const p = { x, y };
        if (!open(p)) continue;
        for (const { dx, dy } of AROUND) {
          const n = { x: x + dx, y: y + dy };
          if (roomContains(room, n) || !reach.has(key(n))) continue;
          // Looking from the outside neighbour into the room.
          const face: Face = dx === 1 ? 'left' : dx === -1 ? 'right' : dy === 1 ? 'up' : 'down';
          out.push({ roomId: room.id, at: p, face });
          break;
        }
      }
  }
  return out;
}

function roomInfo(layout: OfficeLayout, room: NonNullable<OfficeLayout['rooms']>[number], free: (p: Point) => boolean): RoomInfo {
  const inRoom = (p: Point) => roomContains(room, p);
  const items = layout.items.filter((i) => inRoom(i));
  const tables = new Set(items.filter((i) => i.type === 'table').map(key));
  const nextToTable = (p: Point): Face | undefined => {
    for (const { dx, dy } of AROUND) if (tables.has(key({ x: p.x + dx, y: p.y + dy }))) return dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : 'up';
    return undefined;
  };
  const reachableFrom = (p: Point) => AROUND.some((a) => free({ x: p.x + a.dx, y: p.y + a.dy }));

  const seats: Seat[] = [];
  for (const c of items.filter((i) => i.type === 'chair')) {
    const face = nextToTable(c);
    if (face && reachableFrom(c)) seats.push({ at: { x: c.x, y: c.y }, face });
  }
  if (!seats.length && tables.size && STANDING_SEAT_KINDS.has(room.kind)) {
    for (let y = room.y; y < room.y + room.h; y++)
      for (let x = room.x; x < room.x + room.w; x++) {
        const p = { x, y };
        const face = nextToTable(p);
        if (face && free(p)) seats.push({ at: p, face });
      }
  }
  seats.sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x);

  const info: RoomInfo = { id: room.id, name: room.name, kind: room.kind, x: room.x, y: room.y, w: room.w, h: room.h, seats, capacity: seats.length };
  const presenter = presenterSeat(items, free, new Set(seats.map((s) => key(s.at))), inRoom);
  if (presenter) info.presenter = presenter;
  return info;
}

/** In front of the room's presentation screen (preferred) or whiteboard, facing the audience. */
function presenterSeat(items: FurnitureItem[], free: (p: Point) => boolean, taken: Set<string>, inRoom: (p: Point) => boolean): Seat | undefined {
  const boards = [...items.filter((i) => i.type === 'screen'), ...items.filter((i) => i.type === 'whiteboard')];
  for (const b of boards) {
    for (const p of [
      { x: b.x, y: b.y + 1 },
      { x: b.x - 1, y: b.y },
      { x: b.x + 1, y: b.y },
    ]) {
      if (inRoom(p) && free(p) && !taken.has(key(p))) return { at: p, face: 'down' };
    }
  }
  return undefined;
}

/** Tiles workers are sent to by some provider: spots, meeting seats, presenter spots, lounge seats. */
export function destinationTiles(world: Pick<OfficeWorld, 'spots' | 'rooms'> & Partial<Pick<OfficeWorld, 'lounges'>>): Set<string> {
  const out = new Set<string>();
  for (const s of world.spots) out.add(key(s.at));
  for (const r of world.rooms) {
    for (const s of r.seats) out.add(key(s.at));
    if (r.presenter) out.add(key(r.presenter.at));
  }
  for (const l of world.lounges ?? []) out.add(key(l.at));
  return out;
}
