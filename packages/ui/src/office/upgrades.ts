/**
 * Shared office upgrades bought by the office fund (a local game layer). The arcade cabinet is
 * placed virtually: it is added to the layout the scene renders, never to the user's saved layout.
 * Pure: no rendering, no randomness, no side effects.
 */
import { roomContains, type FurnitureItem, type OfficeLayout, type Room, type RoomKind } from '@agent-office/core';
import { key, seatsOf, walkable, type Point } from './grid';

/** Room kinds that can host the arcade, in order of preference. */
const ARCADE_ROOMS: readonly RoomKind[] = ['break', 'collaboration', 'reception'];

const ARCADE_ID = 'arcade-office';

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Tiles reachable on foot from the door, with `extra` treated as blocked. */
function reachable(layout: OfficeLayout, ok: (p: Point) => boolean, extra?: Point): Set<string> {
  const seen = new Set<string>();
  const start = { x: layout.door.x, y: layout.rows - 1 };
  const pass = (p: Point) => ok(p) && !(extra && p.x === extra.x && p.y === extra.y);
  if (!pass(start)) return seen;
  seen.add(key(start));
  const queue: Point[] = [start];
  while (queue.length) {
    const p = queue.pop()!;
    for (const [dx, dy] of NEIGHBOURS) {
      const n = { x: p.x + dx, y: p.y + dy };
      if (seen.has(key(n)) || !pass(n)) continue;
      seen.add(key(n));
      queue.push(n);
    }
  }
  return seen;
}

/**
 * Where the office arcade goes: a free tile against a wall in a break room (else a collaboration
 * room, else reception), with a free tile in front for the player, that blocks no desk seat, cuts
 * off no reachable tile and leaves every reachable piece of furniture reachable. Topmost row
 * first, then rightmost. Undefined when the layout already has an arcade or no tile fits.
 */
export function placeArcade(layout: OfficeLayout): FurnitureItem | undefined {
  if (layout.items.some((i) => i.type === 'arcade')) return undefined;
  const rooms = layout.rooms ?? [];
  if (!rooms.length) return undefined;
  const ok = walkable(layout);
  const reach = reachable(layout, ok);
  const occupied = new Set(layout.items.map(key));
  const seats = new Set(seatsOf(layout).map((s) => key(s.seat)));
  const door = { x: layout.door.x, y: layout.rows - 1 };
  const isDoor = (p: Point) => p.x === door.x && p.y === door.y;
  const freeFloor = (p: Point) => p.y < layout.rows && ok(p) && !occupied.has(key(p)) && !seats.has(key(p)) && !isDoor(p);
  const sides = (p: Point) => NEIGHBOURS.map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy }));

  const fits = (room: Room, p: Point): boolean => {
    if (!freeFloor(p) || !reach.has(key(p))) return false;
    if (ok({ x: p.x, y: p.y - 1 })) return false; // against a wall (or furniture), never free-standing
    if (!freeFloor({ x: p.x, y: p.y + 1 })) return false; // the player stands here
    if (sides(p).some((n) => reach.has(key(n)) && !roomContains(room, n))) return false; // never plug a room entrance
    const after = reachable(layout, ok, p);
    if (after.size !== reach.size - 1) return false;
    // Neighbouring furniture that could be reached keeps another reachable side.
    return sides(p).every((n) => !occupied.has(key(n)) || ok(n) || !sides(n).some((s) => reach.has(key(s))) || sides(n).some((s) => after.has(key(s))));
  };

  for (const kind of ARCADE_ROOMS) {
    let best: Point | undefined;
    for (const r of rooms) {
      if (r.kind !== kind) continue;
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x + r.w - 1; x >= r.x; x--) {
          if (best && (y > best.y || (y === best.y && x <= best.x))) continue;
          if (fits(r, { x, y })) best = { x, y };
        }
    }
    if (best) {
      const ids = new Set(layout.items.map((i) => i.id));
      let id = ARCADE_ID;
      for (let n = 2; ids.has(id); n++) id = `${ARCADE_ID}-${n}`;
      return { id, type: 'arcade', x: best.x, y: best.y };
    }
  }
  return undefined;
}

/** The layout with the office arcade placed, or the same layout object when none is placed. */
export function withArcade(layout: OfficeLayout): OfficeLayout {
  const arcade = placeArcade(layout);
  return arcade ? { ...layout, items: [...layout.items, arcade] } : layout;
}
