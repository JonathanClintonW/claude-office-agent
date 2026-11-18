import {
  blockedTiles,
  isPathInside,
  reachableTiles,
  roomContains,
  seatOf,
  WALL_ROWS,
  type FurnitureItem,
  type OfficeLayout,
  type Room,
  type RoomKind,
} from '@agent-office/core';

export interface Point {
  x: number;
  y: number;
}

export const key = (p: Point) => `${p.x},${p.y}`;

/**
 * Walkable floor tiles: not furniture, not interior walls (gaps in walls are doorways). The
 * tile just outside the door is always walkable.
 */
export function walkable(layout: OfficeLayout): (p: Point) => boolean {
  const blocked = blockedTiles(layout);
  return (p) => {
    if (p.x === layout.door.x && p.y === layout.rows) return true; // outside the door
    if (p.x < 0 || p.x >= layout.cols || p.y < WALL_ROWS || p.y >= layout.rows) return false;
    return !blocked.has(key(p));
  };
}

export function roomAt(layout: Pick<OfficeLayout, 'rooms'>, p: Point): Room | undefined {
  return layout.rooms?.find((r) => roomContains(r, p));
}

const STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Numeric tile id for the search maps (tiles just outside the grid stay distinct). */
const nid = (x: number, y: number) => (y + 8) * 8192 + (x + 8);

interface Node {
  p: Point;
  g: number;
  f: number;
  h: number;
  n: number;
}

/** Heap order: lowest f, then the node nearer the goal, then the older one (deterministic). */
const before = (a: Node, b: Node) => a.f - b.f || a.h - b.h || a.n - b.n;

function heapPush(heap: Node[], node: Node): void {
  heap.push(node);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (before(heap[i]!, heap[parent]!) >= 0) break;
    [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
    i = parent;
  }
}

function heapPop(heap: Node[]): Node | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (!top || !last || !heap.length) return top;
  heap[0] = last;
  let i = 0;
  for (;;) {
    const l = 2 * i + 1;
    const r = l + 1;
    let m = i;
    if (l < heap.length && before(heap[l]!, heap[m]!) < 0) m = l;
    if (r < heap.length && before(heap[r]!, heap[m]!) < 0) m = r;
    if (m === i) break;
    [heap[i], heap[m]] = [heap[m]!, heap[i]!];
    i = m;
  }
  return top;
}

/**
 * A* on a 4-connected grid (no diagonal steps, so it never cuts a wall corner). The goal may be
 * a blocked tile (a chair or couch the worker sits on); every other step must pass `ok`.
 * Returns the path excluding `from`, or undefined if unreachable within `limit` expansions.
 */
export function findPath(from: Point, to: Point, ok: (p: Point) => boolean, limit = 4000): Point[] | undefined {
  if (from.x === to.x && from.y === to.y) return [];
  const h0 = Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
  const open: Node[] = [{ p: from, g: 0, f: h0, h: h0, n: 0 }];
  const came = new Map<number, Point>();
  const gScore = new Map<number, number>([[nid(from.x, from.y), 0]]);
  let seq = 1;
  let steps = 0;
  while (open.length && steps < limit) {
    const cur = heapPop(open)!;
    if (cur.g > (gScore.get(nid(cur.p.x, cur.p.y)) ?? Infinity)) continue; // stale entry
    steps++;
    if (cur.p.x === to.x && cur.p.y === to.y) {
      const path: Point[] = [];
      let k: Point | undefined = cur.p;
      while (k && !(k.x === from.x && k.y === from.y)) {
        path.push(k);
        k = came.get(nid(k.x, k.y));
      }
      return path.reverse();
    }
    for (const [dx, dy] of STEPS) {
      const n = { x: cur.p.x + dx, y: cur.p.y + dy };
      const isGoal = n.x === to.x && n.y === to.y;
      if (!isGoal && !ok(n)) continue;
      const g = cur.g + 1;
      const id = nid(n.x, n.y);
      if (g < (gScore.get(id) ?? Infinity)) {
        gScore.set(id, g);
        came.set(id, cur.p);
        const h = Math.abs(n.x - to.x) + Math.abs(n.y - to.y);
        heapPush(open, { p: n, g, f: g + h, h, n: seq++ });
      }
    }
  }
  return undefined;
}

/**
 * Tiles around `p` that pass `pred`, nearest first (Manhattan rings up to `maxRadius`, in a
 * fixed order within a ring), at most `limit` of them.
 */
export function nearestTiles(p: Point, pred: (p: Point) => boolean, maxRadius = 6, limit = 1): Point[] {
  const out: Point[] = [];
  for (let r = 0; r <= maxRadius && out.length < limit; r++) {
    for (let dy = -r; dy <= r && out.length < limit; dy++) {
      const dx = r - Math.abs(dy);
      const c = { x: p.x - dx, y: p.y + dy };
      if (pred(c)) out.push(c);
      if (dx !== 0 && out.length < limit) {
        const d = { x: p.x + dx, y: p.y + dy };
        if (pred(d)) out.push(d);
      }
    }
  }
  return out;
}

/** Walkable tiles connected to `to` (or, for a blocked goal such as a chair, to its walkable neighbours). */
export function regionOf(to: Point, ok: (p: Point) => boolean, cap = 6000): Set<number> {
  const seen = new Set<number>();
  const queue: Point[] = [];
  const visit = (p: Point) => {
    const id = nid(p.x, p.y);
    if (seen.has(id) || !ok(p)) return;
    seen.add(id);
    queue.push(p);
  };
  visit(to);
  for (const [dx, dy] of STEPS) visit({ x: to.x + dx, y: to.y + dy });
  for (let i = 0; i < queue.length && seen.size < cap; i++) {
    const p = queue[i]!;
    for (const [dx, dy] of STEPS) visit({ x: p.x + dx, y: p.y + dy });
  }
  return seen;
}

export interface Route {
  /** Tiles to walk, excluding the start. */
  path: Point[];
  /** Recovery: put the worker on this tile first (it had no way to the target from where it stood). */
  place?: Point;
}

/** How far (tiles) recovery looks for a tile from which the target can be reached. */
export const RECOVERY_RADIUS = 12;

/**
 * Route for a worker standing at `pos` (fractional while between two tiles) to `to`:
 * 1. A* from the tile it is on. Mid-step, the route first returns to the nearer of the two
 *    tiles it is between (both walkable), so it never cuts across a wall corner.
 * 2. No path (an edit walled it in, it stands off the floor, or on a blocked tile with no way
 *    out): put it on the nearest tile from which the target is reachable, then walk.
 * 3. Last resort (the target is unreachable from anywhere near): put it at the target.
 * Never returns a path through walls, furniture or off the layout.
 */
export function planRoute(pos: Point, to: Point, ok: (p: Point) => boolean, limit = 4000): Route {
  const from = { x: Math.round(pos.x), y: Math.round(pos.y) };
  const mid = from.x !== pos.x || from.y !== pos.y;
  const direct = findPath(from, to, ok, limit);
  if (direct) return { path: mid ? [from, ...direct] : direct };
  const region = regionOf(to, ok);
  const [start] = nearestTiles(from, (p) => region.has(nid(p.x, p.y)), RECOVERY_RADIUS, 1);
  const path = start ? findPath(start, to, ok, limit) : undefined;
  if (start && path) return { path, place: start };
  return { path: [], place: { x: to.x, y: to.y } };
}

/** No new tile for this long while walking counts as stuck. */
export const STUCK_MS = 3_000;

export type StuckAction = 'ok' | 'repath' | 'place';

/**
 * Progress check for one walker, fed a few times per second. A walker that has a path but has
 * not reached a new tile for STUCK_MS gets 'repath'; still stuck after that, 'place' (put it
 * at its target). Pure: the caller passes the clock.
 */
export class ProgressWatch {
  private tx = Number.NaN;
  private ty = Number.NaN;
  private since = 0;
  private strikes = 0;

  update(now: number, x: number, y: number, walking: boolean): StuckAction {
    if (!walking || x !== this.tx || y !== this.ty) {
      this.tx = x;
      this.ty = y;
      this.since = now;
      this.strikes = 0;
      return 'ok';
    }
    if (now - this.since < STUCK_MS) return 'ok';
    this.since = now;
    return ++this.strikes >= 2 ? 'place' : 'repath';
  }
}

export interface Seat {
  deskId: string;
  desk: FurnitureItem;
  seat: Point;
  zoneId?: string;
  workspaceMatch?: string;
  /** Room containing the desk (layout semantics, not a Claude role). */
  roomId?: string;
  roomKind?: RoomKind;
}

export function seatsOf(layout: OfficeLayout): Seat[] {
  return layout.items
    .filter((i) => i.type === 'desk')
    .map((desk) => {
      const seat = seatOf(desk);
      const zone = layout.zones.find((z) => desk.x >= z.x && desk.x < z.x + z.w && desk.y >= z.y && desk.y < z.y + z.h);
      const s: Seat = { deskId: desk.id, desk, seat };
      if (zone) {
        s.zoneId = zone.id;
        if (zone.workspaceMatch) s.workspaceMatch = zone.workspaceMatch;
      }
      const room = roomAt(layout, desk);
      if (room) {
        s.roomId = room.id;
        s.roomKind = room.kind;
      }
      return s;
    })
    .sort((a, b) => a.seat.y - b.seat.y || a.seat.x - b.seat.x);
}

export interface Assignable {
  key: string;
  parentKey?: string;
  cwd?: string;
  /** Department from local rules (see departments.ts); desks in rooms of this kind are preferred. */
  department?: string;
}

function zoneMatches(match: string | undefined, cwd: string | undefined): boolean {
  if (!match || !cwd) return false;
  if (/^[a-zA-Z]:[\\/]|^\//.test(match)) return isPathInside(cwd, match);
  return cwd.toLowerCase().replace(/\//g, '\\').includes(match.toLowerCase().replace(/\//g, '\\'));
}

/** Rooms whose desks are not tied to any department: a fallback before other departments' rooms. */
const GENERIC_ROOM = (kind: RoomKind | undefined) => kind === undefined || kind === 'office';

function narrow<T>(list: T[], pred: (t: T) => boolean): T[] {
  const n = list.filter(pred);
  return n.length ? n : list;
}

/** Mean seat position of a department's desks (taken or not), if the layout has any. */
function departmentCentre(seats: readonly Seat[], department: string): Point | undefined {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const s of seats) {
    if (s.roomKind !== department) continue;
    x += s.seat.x;
    y += s.seat.y;
    n++;
  }
  return n ? { x: x / n, y: y / n } : undefined;
}

/**
 * Stable desk assignment. Existing assignments are kept. New agents prefer, in order:
 * 1. desks in a room of their department (local rules). When that room is full: generic desks
 *    before other departments' rooms, nearest to the full department first,
 * 2. desks in a zone whose workspace match fits their cwd (sessions without a match avoid
 *    other workspaces' zones),
 * 3. the free desk nearest to their parent (subagents/teammates),
 * 4. the first free desk.
 * Agents that do not fit get `null` (they stand in the lounge).
 */
export function assignDesks(prev: ReadonlyMap<string, string | null>, agents: readonly Assignable[], seats: readonly Seat[]): Map<string, string | null> {
  const byId = new Map(seats.map((s) => [s.deskId, s]));
  const out = new Map<string, string | null>();
  const taken = new Set<string>();
  for (const a of agents) {
    const d = prev.get(a.key);
    if (d && byId.has(d) && !taken.has(d)) {
      out.set(a.key, d);
      taken.add(d);
    }
  }
  const free = () => seats.filter((s) => !taken.has(s.deskId));
  const centres = new Map<string, Point | undefined>();
  // Parents first so children can be seated near them.
  const pending = agents.filter((a) => !out.has(a.key)).sort((x, y) => Number(Boolean(x.parentKey)) - Number(Boolean(y.parentKey)));
  for (const a of pending) {
    let candidates = free();
    if (!candidates.length) {
      out.set(a.key, null);
      continue;
    }
    let overflow: Point | undefined;
    if (a.department) {
      const dept = candidates.filter((s) => s.roomKind === a.department);
      if (dept.length) candidates = dept;
      else {
        candidates = narrow(candidates, (s) => GENERIC_ROOM(s.roomKind));
        if (!centres.has(a.department)) centres.set(a.department, departmentCentre(seats, a.department));
        overflow = centres.get(a.department);
      }
    }
    const parentDesk = a.parentKey ? out.get(a.parentKey) : undefined;
    const anchor = parentDesk ? byId.get(parentDesk)?.seat : undefined;
    const zoned = candidates.filter((s) => zoneMatches(s.workspaceMatch, a.cwd));
    if (zoned.length) candidates = zoned;
    else if (!anchor) candidates = narrow(candidates, (s) => !s.workspaceMatch);
    let pick = candidates[0]!;
    const near = anchor ?? overflow;
    if (near) {
      const dist = (s: Seat) => Math.abs(s.seat.x - near.x) + Math.abs(s.seat.y - near.y) * 1.5;
      pick = candidates.reduce((best, s) => (dist(s) < dist(best) ? s : best));
    }
    out.set(a.key, pick.deskId);
    taken.add(pick.deskId);
  }
  return out;
}

/**
 * Stable slot assignment (e.g. lounge places for agents without a desk): a key keeps its
 * previous slot while that slot exists and nobody earlier kept it; new keys take the lowest
 * free slot. When there are more keys than slots, the rest share slots in order. Empty when
 * there are no slots.
 */
export function assignSlots(prev: ReadonlyMap<string, number>, keys: readonly string[], count: number): Map<string, number> {
  const out = new Map<string, number>();
  if (count <= 0) return out;
  const used = new Set<number>();
  for (const k of keys) {
    const s = prev.get(k);
    if (s !== undefined && s >= 0 && s < count && !used.has(s)) {
      out.set(k, s);
      used.add(s);
    }
  }
  let next = 0;
  let extra = 0;
  for (const k of keys) {
    if (out.has(k)) continue;
    while (next < count && used.has(next)) next++;
    if (next < count) {
      out.set(k, next);
      used.add(next);
    } else out.set(k, extra++ % count);
  }
  return out;
}

/** Rooms where agents without a desk may wait. */
const LOUNGE_KINDS: ReadonlySet<RoomKind> = new Set(['reception', 'break', 'corridor', 'collaboration', 'office']);

/**
 * Free floor tiles, from the front (door) row backwards, where agents without a desk wait. Only tiles
 * reachable from the door; with rooms, only in lounge-like rooms or outside any room. `avoid`
 * ("x,y" keys) skips tiles other workers walk to (activity spots, meeting seats).
 */
export function loungeSpots(layout: OfficeLayout, avoid?: ReadonlySet<string>): Point[] {
  const ok = walkable(layout);
  const reach = reachableTiles(layout);
  const seats = new Set(seatsOf(layout).map((s) => key(s.seat)));
  const hasRooms = Boolean(layout.rooms?.length);
  const spots: Point[] = [];
  for (let y = layout.rows - 2; y >= WALL_ROWS && spots.length < 40; y--)
    for (let x = 1; x < layout.cols - 1; x++) {
      const p = { x, y };
      if (!ok(p) || seats.has(key(p)) || x === layout.door.x || !reach.has(key(p)) || avoid?.has(key(p))) continue;
      if (hasRooms) {
        const room = roomAt(layout, p);
        if (room && !LOUNGE_KINDS.has(room.kind)) continue;
      }
      spots.push(p);
    }
  return spots;
}
