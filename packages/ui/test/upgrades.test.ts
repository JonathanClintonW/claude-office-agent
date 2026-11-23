import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultLayout, openOfficeLayout, reachableTiles, roomContains, seatOf, validateLayout, type OfficeLayout, type Room } from '@agent-office/core';
import { walkable } from '../src/office/grid';
import { ARCADE_FRAMES, drawArcade, drawCoffeeMachine, drawCrate, drawCrown, drawPizzaBox } from '../src/office/pixelArt';
import { placeArcade, withArcade } from '../src/office/upgrades';
import { buildWorld } from '../src/office/world';

const k = (p: { x: number; y: number }) => `${p.x},${p.y}`;

/** A 12×9 office with one room and the door at x=6 on the bottom row. */
function small(room: Omit<Room, 'id' | 'name'>, items: OfficeLayout['items'] = [], walls: OfficeLayout['walls'] = []): OfficeLayout {
  return { version: 1, name: 'Small', cols: 12, rows: 9, door: { x: 6 }, items, zones: [], walls, rooms: [{ id: 'r', name: 'Room', ...room }] };
}

describe('placeArcade', () => {
  it('puts the office arcade in the default break room, against its top wall, with a free tile in front', () => {
    const layout = defaultLayout();
    const arcade = placeArcade(layout)!;
    expect(arcade).toEqual({ id: 'arcade-office', type: 'arcade', x: 42, y: 15 });
    const room = layout.rooms!.find((r) => roomContains(r, arcade))!;
    expect(room.kind).toBe('break');
    expect(arcade.y).toBe(room.y);
    expect(layout.walls).toContainEqual({ x: arcade.x, y: arcade.y - 1 });
    const front = { x: arcade.x, y: arcade.y + 1 };
    const ok = walkable(layout);
    expect(ok(front)).toBe(true);
    expect(layout.items.some((i) => i.x === front.x && i.y === front.y)).toBe(false);
    expect(layout.items.filter((i) => i.type === 'desk').map((d) => k(seatOf(d)))).not.toContain(k(front));

    // every tile reachable before stays reachable, except the arcade tile itself
    const placed = withArcade(layout);
    const before = reachableTiles(layout);
    const after = reachableTiles(placed);
    expect(after.size).toBe(before.size - 1);
    for (const t of before) if (t !== k(arcade)) expect(after.has(t), t).toBe(true);
    expect(validateLayout(placed).ok).toBe(true);

    // and idle agents get a spot to play it
    const spot = buildWorld(placed, [], false).spots.find((s) => s.kind === 'arcade');
    expect(spot).toEqual({ id: 'arcade-office', kind: 'arcade', at: front, face: 'up', roomId: 'break' });
  });

  it('is pure: the input layout is never changed', () => {
    const layout = defaultLayout();
    const copy = JSON.parse(JSON.stringify(layout)) as OfficeLayout;
    const placed = withArcade(layout);
    expect(layout).toEqual(copy);
    expect(placed).not.toBe(layout);
    expect(placed.items).toHaveLength(layout.items.length + 1);
    expect(withArcade(layout)).toEqual(placed);
  });

  it('places nothing when the layout already has an arcade', () => {
    const base = defaultLayout();
    const layout: OfficeLayout = { ...base, items: [...base.items, { id: 'mine', type: 'arcade', x: 36, y: 15 }] };
    expect(placeArcade(layout)).toBeUndefined();
    expect(withArcade(layout)).toBe(layout);
  });

  it('places nothing without a break room, collaboration room or reception', () => {
    expect(placeArcade(openOfficeLayout())).toBeUndefined();
    const qa = small({ kind: 'qa', x: 0, y: 2, w: 12, h: 4 });
    expect(placeArcade(qa)).toBeUndefined();
    expect(withArcade(qa)).toBe(qa);
  });

  it('falls back to a collaboration room, then reception', () => {
    const base = defaultLayout();
    const noBreak: OfficeLayout = { ...base, rooms: base.rooms!.filter((r) => r.kind !== 'break') };
    const inCollab = placeArcade(noBreak)!;
    expect(base.rooms!.find((r) => roomContains(r, inCollab))?.kind).toBe('collaboration');
    const onlyReception: OfficeLayout = { ...base, rooms: base.rooms!.filter((r) => r.kind !== 'break' && r.kind !== 'collaboration') };
    const inReception = placeArcade(onlyReception)!;
    expect(base.rooms!.find((r) => roomContains(r, inReception))?.kind).toBe('reception');
  });

  it('places nothing in a fully blocked break room', () => {
    const items: OfficeLayout['items'] = [];
    for (let y = 2; y < 5; y++) for (let x = 0; x < 4; x++) items.push({ id: `p${x}${y}`, type: 'plant', x, y });
    const full = small({ kind: 'break', x: 0, y: 2, w: 4, h: 3 }, items);
    expect(validateLayout(full).ok).toBe(true);
    expect(placeArcade(full)).toBeUndefined();
  });

  it('never takes a desk seat', () => {
    const desks: OfficeLayout['items'] = [0, 1, 2, 3].map((x) => ({ id: `d${x}`, type: 'desk', x, y: 2 }));
    // The only free tiles with something behind them are the desk seats (the row below the desks).
    const l = small({ kind: 'break', x: 0, y: 2, w: 4, h: 3 }, desks);
    expect(validateLayout(l).ok).toBe(true);
    expect(placeArcade(l)).toBeUndefined();
  });

  it('skips tiles whose blocking would cut off part of the office or plug an entrance', () => {
    // Break room x2..9, y2..3. Row y3 is walled from x4, so the top row is the only way to x4..11;
    // a wall at x1 closes the room's west side, and y4 is walled except an entrance at x2.
    const walls: OfficeLayout['walls'] = [{ x: 1, y: 2 }, { x: 1, y: 3 }];
    for (let x = 4; x < 10; x++) walls.push({ x, y: 3 });
    for (let x = 0; x < 12; x++) if (x !== 2) walls.push({ x, y: 4 });
    const l = small({ kind: 'break', x: 2, y: 2, w: 8, h: 2 }, [], walls);
    const ok = walkable(l);
    expect(ok({ x: 3, y: 3 }) && ok({ x: 2, y: 3 })).toBe(true);
    // (3,2) would cut off the rest of the top row; (2,2) keeps everything reachable.
    expect(placeArcade(l)).toEqual({ id: 'arcade-office', type: 'arcade', x: 2, y: 2 });
    // A second way in west of (2,2), via x=0: (2,2) is now an entrance and nothing fits.
    const open = small({ kind: 'break', x: 2, y: 2, w: 8, h: 2 }, [], walls.filter((w) => !(w.x === 1 && w.y === 2) && !(w.x === 0 && w.y === 4)));
    expect(reachableTiles(open).has('0,2')).toBe(true);
    expect(placeArcade(open)).toBeUndefined();
  });

  it('keeps furniture next to the arcade reachable and picks a unique id', () => {
    // The couch at (10,2) can only be reached from (11,2), so the arcade moves left of the plants.
    const couch = { id: 'couch', type: 'couch' as const, x: 10, y: 2 };
    const plants: OfficeLayout['items'] = [
      { id: 'arcade-office', type: 'plant', x: 9, y: 2 },
      { id: 'p2', type: 'plant', x: 10, y: 3 },
    ];
    const l = small({ kind: 'break', x: 0, y: 2, w: 12, h: 5 }, [couch, ...plants]);
    expect(placeArcade(l)).toEqual({ id: 'arcade-office-2', type: 'arcade', x: 8, y: 2 });
    // With a second free side (no plant below it) the couch does not stand in the way.
    expect(placeArcade(small({ kind: 'break', x: 0, y: 2, w: 12, h: 5 }, [couch, plants[0]!]))).toEqual({ id: 'arcade-office-2', type: 'arcade', x: 11, y: 2 });
  });
});

// Fake 2D canvas: jsdom has none.
const pixels = new WeakMap<HTMLCanvasElement, Uint8ClampedArray>();
const realGetContext = HTMLCanvasElement.prototype.getContext;

function fakeGetContext(this: HTMLCanvasElement): CanvasRenderingContext2D {
  const c = this;
  const data = new Uint8ClampedArray(c.width * c.height * 4);
  pixels.set(c, data);
  const ctx = {
    imageSmoothingEnabled: true,
    fillStyle: '#000000' as string,
    fillRect(x: number, y: number, w: number, h: number) {
      const n = parseInt(String(ctx.fillStyle).slice(1), 16);
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++) {
          if (xx < 0 || yy < 0 || xx >= c.width || yy >= c.height) continue;
          const i = (yy * c.width + xx) * 4;
          data[i] = (n >> 16) & 255;
          data[i + 1] = (n >> 8) & 255;
          data[i + 2] = n & 255;
          data[i + 3] = 255;
        }
    },
    getImageData(_x: number, _y: number, w: number, h: number) {
      return { data: data.slice(), width: w, height: h };
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = fakeGetContext as unknown as typeof realGetContext;
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

const image = (c: HTMLCanvasElement) => Array.from(pixels.get(c)!).join(',');
/** Lowest row with an opaque pixel (sprites are bottom-anchored on the floor line). */
const lowestRow = (c: HTMLCanvasElement) => {
  const d = pixels.get(c)!;
  for (let y = c.height - 1; y >= 0; y--) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3]) return y;
  return -1;
};
const opaque = (c: HTMLCanvasElement) => {
  const d = pixels.get(c)!;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
  return n;
};

describe('upgrade sprites', () => {
  it('draws a one-tile arcade cabinet whose screen animates', () => {
    const frames = Array.from({ length: ARCADE_FRAMES }, (_, f) => drawArcade(f));
    for (const c of frames) {
      expect([c.width, c.height]).toEqual([16, 30]);
      expect(lowestRow(c)).toBe(29);
      expect(opaque(c)).toBeGreaterThan(300);
    }
    expect(ARCADE_FRAMES).toBe(4);
    expect(new Set(frames.map(image)).size).toBe(ARCADE_FRAMES);
    expect(image(drawArcade(ARCADE_FRAMES + 1))).toBe(image(frames[1]!));
    expect(image(drawArcade(2))).toBe(image(drawArcade(2)));
  });

  it('draws a closed crate, a crown and a pizza box', () => {
    const crate = drawCrate();
    expect([crate.width, crate.height]).toEqual([16, 26]);
    expect(lowestRow(crate)).toBe(25);
    const crown = drawCrown();
    expect([crown.width, crown.height]).toEqual([9, 7]);
    expect(lowestRow(crown)).toBe(6);
    const pizza = drawPizzaBox();
    expect([pizza.width, pizza.height]).toEqual([14, 10]);
    expect(lowestRow(pizza)).toBe(9);
    for (const c of [crate, crown, pizza]) expect(opaque(c)).toBeGreaterThan(30);
  });

  it('keeps the default coffee machine and adds a distinct espresso machine', () => {
    for (const busy of [false, true])
      for (const f of [0, 1]) {
        const plain = drawCoffeeMachine(f, busy);
        expect(image(plain)).toBe(image(drawCoffeeMachine(f, busy, false)));
        const espresso = drawCoffeeMachine(f, busy, true);
        expect([espresso.width, espresso.height]).toEqual([plain.width, plain.height]);
        expect(lowestRow(espresso)).toBe(lowestRow(plain));
        expect(image(espresso)).not.toBe(image(plain));
      }
    expect(image(drawCoffeeMachine(0, true, true))).not.toBe(image(drawCoffeeMachine(1, true, true)));
  });
});
