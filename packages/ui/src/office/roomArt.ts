/**
 * Procedural pixel art for rooms and department furniture. Same rules as
 * pixelArt.ts: original art drawn in code, 16px tiles, nearest-neighbour scaling, dark
 * outlines, the office palette. Pure helpers at the top are testable without a canvas.
 */
import { WALL_ROWS, roomContains, type AgentStatus, type OfficeLayout, type RoomKind } from '@agent-office/core';

const TILE = 16;
const OUTLINE = '#17141f';

// ------------------------------------------------------------------ pure helpers

/** Neighbour bits for auto-tiling. */
export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;

export function maskOf(has: (x: number, y: number) => boolean, x: number, y: number): number {
  return (has(x, y - 1) ? N : 0) | (has(x + 1, y) ? E : 0) | (has(x, y + 1) ? S : 0) | (has(x - 1, y) ? W : 0);
}

export interface RoomStyle {
  /** Floor finish. */
  floor: 'wood' | 'carpet' | 'vinyl' | 'panel' | 'checker' | 'smalltile' | 'marble';
  base: string;
  alt: string;
  /** Label colour in the scene and room colour in the mini-map. */
  accent: string;
}

export const ROOM_STYLE: Record<RoomKind, RoomStyle> = {
  office: { floor: 'wood', base: '#9a7351', alt: '#93694a', accent: '#f1eedf' },
  development: { floor: 'carpet', base: '#4d5b7c', alt: '#56658a', accent: '#8fb4ff' },
  qa: { floor: 'vinyl', base: '#a3cfc3', alt: '#8fbcb0', accent: '#7ee7c4' },
  devops: { floor: 'panel', base: '#7d8590', alt: '#6c7480', accent: '#9ad1ff' },
  security: { floor: 'carpet', base: '#3b4152', alt: '#434a5e', accent: '#ff9a8a' },
  research: { floor: 'carpet', base: '#4f6b4a', alt: '#587653', accent: '#a8e08f' },
  collaboration: { floor: 'carpet', base: '#8a6a4a', alt: '#937352', accent: '#ffc27a' },
  meeting: { floor: 'carpet', base: '#6b3f52', alt: '#76485c', accent: '#f0a6ca' },
  break: { floor: 'checker', base: '#e8dcc0', alt: '#c9744f', accent: '#ffd166' },
  restroom: { floor: 'smalltile', base: '#dfe8ee', alt: '#b8c6d0', accent: '#b8e2ff' },
  reception: { floor: 'marble', base: '#d9d4cc', alt: '#bdb6aa', accent: '#ffe9a8' },
  corridor: { floor: 'wood', base: '#9a7351', alt: '#93694a', accent: '#d8c9a8' },
};

export type QaLampState = 'off' | 'run' | 'ok' | 'fail';

/**
 * QA desk build lamp: shows the seated agent's most recent REAL tool result (amber while a
 * tool runs, then green/red). Off when nobody sits there or nothing was observed.
 */
export function qaLampState(v: { status: AgentStatus; toolRunning?: boolean; lastToolEnd?: { ok: boolean } } | undefined): QaLampState {
  if (!v) return 'off';
  if (v.status === 'working' && v.toolRunning) return 'run';
  if (v.lastToolEnd) return v.lastToolEnd.ok ? 'ok' : 'fail';
  return 'off';
}

export type ConsoleTheme = 'cctv' | 'graphs' | 'dash';

/** What a console's screens show, by room kind (decoration only, never agent status). */
export function consoleTheme(kind: RoomKind | undefined): ConsoleTheme {
  return kind === 'security' ? 'cctv' : kind === 'devops' ? 'graphs' : 'dash';
}

// ------------------------------------------------------------------ canvas helpers

type Px = (x: number, y: number, w: number, h: number, c: string) => void;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D, Px] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true }); // CPU-backed: outline() reads pixels back
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.imageSmoothingEnabled = false;
  const px: Px = (x, y, ww, hh, col) => {
    if (ww <= 0 || hh <= 0) return;
    ctx.fillStyle = col;
    ctx.fillRect(x, y, ww, hh);
  };
  return [c, ctx, px];
}

function outline(ctx: CanvasRenderingContext2D, w: number, h: number, color = OUTLINE): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3]! > 0;
  const marks: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (solid(x, y)) continue;
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) marks.push(x, y);
    }
  ctx.fillStyle = color;
  for (let i = 0; i < marks.length; i += 2) ctx.fillRect(marks[i]!, marks[i + 1]!, 1, 1);
}

function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

function hashXY(x: number, y: number, salt = 0): number {
  let h = 2166136261 ^ salt;
  h = Math.imul(h ^ (x + 1013), 16777619);
  h = Math.imul(h ^ (y + 7919), 16777619);
  return h >>> 0;
}

function mix(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f))));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// ------------------------------------------------------------------ floors

function paintFloorTile(px: Px, ox: number, oy: number, st: RoomStyle, x: number, y: number): void {
  const r = seeded(hashXY(x, y, 77));
  switch (st.floor) {
    case 'carpet': {
      px(ox, oy, TILE, TILE, st.base);
      // woven texture: a faint diagonal weave plus a few flecks
      for (let i = 0; i < TILE; i += 4) px(ox + ((i + y * 2) % TILE), oy + i, 2, 1, st.alt);
      for (let i = 0; i < 6; i++) px(ox + Math.floor(r() * 16), oy + Math.floor(r() * 16), 1, 1, mix(st.base, r() > 0.5 ? 0.1 : -0.12));
      break;
    }
    case 'vinyl':
      px(ox, oy, TILE, TILE, st.base);
      px(ox, oy, TILE, 1, mix(st.base, 0.18));
      px(ox, oy + 15, TILE, 1, st.alt);
      px(ox + 15, oy, 1, TILE, st.alt);
      for (let i = 0; i < 4; i++) px(ox + 1 + Math.floor(r() * 13), oy + 1 + Math.floor(r() * 13), 1, 1, mix(st.base, -0.1));
      break;
    case 'panel':
      for (const [qx, qy] of [
        [0, 0],
        [8, 0],
        [0, 8],
        [8, 8],
      ] as const) {
        px(ox + qx, oy + qy, 8, 8, st.base);
        px(ox + qx, oy + qy, 8, 1, mix(st.base, 0.15));
        px(ox + qx + 7, oy + qy, 1, 8, st.alt);
        px(ox + qx, oy + qy + 7, 8, 1, mix(st.alt, -0.15));
      }
      if ((x + y) % 3 === 0) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) px(ox + 2 + i * 2, oy + 10 + j * 2 - 8, 1, 1, mix(st.alt, -0.25)); // perforated panel
      break;
    case 'checker':
      for (let i = 0; i < 2; i++)
        for (let j = 0; j < 2; j++) {
          const c = (i + j + x + y) % 2 === 0 ? st.base : st.alt;
          px(ox + i * 8, oy + j * 8, 8, 8, c);
          px(ox + i * 8, oy + j * 8, 8, 1, mix(c, 0.12));
        }
      break;
    case 'smalltile':
      px(ox, oy, TILE, TILE, st.alt);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) px(ox + i * 4, oy + j * 4, 3, 3, (i + j + x) % 5 === 0 ? mix(st.base, -0.06) : st.base);
      break;
    case 'marble': {
      px(ox, oy, TILE, TILE, st.base);
      px(ox, oy, TILE, 1, mix(st.base, 0.2));
      px(ox, oy + 15, TILE, 1, st.alt);
      px(ox + 15, oy, 1, TILE, mix(st.alt, 0.1));
      let vx = Math.floor(r() * 16);
      for (let vy = 0; vy < 15; vy++) {
        if (r() > 0.45) px(ox + Math.max(0, Math.min(14, vx)), oy + vy, 1, 1, st.alt);
        vx += r() > 0.5 ? 1 : -1;
      }
      break;
    }
    case 'wood':
      break; // drawn by the caller with the classic floor
  }
}

/**
 * The whole floor (rows WALL_ROWS..rows-1) in one canvas: room finishes inside rooms, the
 * classic wooden floor elsewhere. One texture keeps big offices cheap to draw.
 */
export function drawFloorMap(layout: Pick<OfficeLayout, 'cols' | 'rows' | 'rooms'>, wood: (x: number, y: number) => HTMLCanvasElement): HTMLCanvasElement {
  const [c, ctx, px] = canvas(layout.cols * TILE, (layout.rows - WALL_ROWS) * TILE);
  const rooms = layout.rooms ?? [];
  for (let y = WALL_ROWS; y < layout.rows; y++)
    for (let x = 0; x < layout.cols; x++) {
      const room = rooms.find((r) => roomContains(r, { x, y }));
      const st = room ? ROOM_STYLE[room.kind] : undefined;
      const ox = x * TILE;
      const oy = (y - WALL_ROWS) * TILE;
      if (!st || st.floor === 'wood') ctx.drawImage(wood(x, y), ox, oy);
      else paintFloorTile(px, ox, oy, st, x, y);
    }
  // A thin threshold line where a room's floor meets a different floor.
  for (const r of rooms) {
    const st = ROOM_STYLE[r.kind];
    if (st.floor === 'wood') continue;
    const edge = mix(st.base, -0.35);
    const ox = r.x * TILE;
    const oy = (r.y - WALL_ROWS) * TILE;
    px(ox, oy, r.w * TILE, 1, edge);
    px(ox, oy + r.h * TILE - 1, r.w * TILE, 1, edge);
    px(ox, oy, 1, r.h * TILE, edge);
    px(ox + r.w * TILE - 1, oy, 1, r.h * TILE, edge);
  }
  return c;
}

// ------------------------------------------------------------------ walls

const CAP = '#cbb994';
const CAP_HI = '#e6dabe';
const CAP_LO = '#ad9a76';
const WALL_LINE = '#5a4636';

/** Interior wall block (16×24): an 8px-high top cap over its tile plus a front face when open to the south. */
export function drawInteriorWall(mask: number): HTMLCanvasElement {
  const [c, , px] = canvas(TILE, 24);
  const openS = !(mask & S);
  const capH = openS ? 16 : 24;
  px(0, 0, TILE, capH, CAP);
  // subtle brick courses on the cap
  for (let yy = 3; yy < capH; yy += 5) px(0, yy, TILE, 1, CAP_LO);
  if (!(mask & N)) {
    px(0, 0, TILE, 1, WALL_LINE);
    px(0, 1, TILE, 1, CAP_HI);
  }
  if (!(mask & W)) {
    px(0, 0, 1, capH, WALL_LINE);
    px(1, mask & N ? 0 : 1, 1, capH - (mask & N ? 0 : 1), CAP_HI);
  }
  if (!(mask & E)) {
    px(15, 0, 1, capH, WALL_LINE);
    px(14, mask & N ? 0 : 1, 1, capH - (mask & N ? 0 : 1), CAP_LO);
  }
  if (openS) {
    px(0, 16, TILE, 1, WALL_LINE);
    px(0, 17, TILE, 2, '#d8c9a8'); // plaster
    px(0, 19, TILE, 1, '#a57a56'); // chair rail
    px(0, 20, TILE, 3, '#6b4a33'); // wainscot
    px(0, 20, TILE, 1, '#7c5840');
    px(0, 23, TILE, 1, '#3e2b20'); // baseboard
    if (!(mask & W)) px(0, 16, 1, 8, '#3e2b20');
    if (!(mask & E)) px(15, 16, 1, 8, '#3e2b20');
  }
  return c;
}

// ------------------------------------------------------------------ department furniture

/** Server rack (16×30) with blinking status LEDs. */
export function drawServerRack(variant: number, frame: number): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 30);
  px(1, 1, 14, 27, '#2b2f3a');
  px(1, 1, 14, 1, '#4a5163');
  px(2, 3, 12, 23, '#1c1f27');
  const r = seeded(variant * 131 + 7);
  const leds = ['#7ee787', '#7ee787', '#5ad1ff', '#ffb057'];
  for (let u = 0; u < 5; u++) {
    const y = 4 + u * 4;
    px(3, y, 10, 3, '#353b49');
    px(3, y, 10, 1, '#424a5b');
    for (let v = 0; v < 3; v++) px(9 + v, y + 1, 1, 1, '#22262f'); // vents
    for (let l = 0; l < 2; l++) {
      const on = (Math.floor(r() * 7) + frame * (l + 1) + u) % 3 !== 0;
      px(4 + l * 2, y + 1, 1, 1, on ? leds[Math.floor(r() * leds.length)]! : '#2a3a2e');
    }
  }
  px(3, 25, 10, 1, '#424a5b');
  px(2, 28, 3, 2, '#1a1c22');
  px(11, 28, 3, 2, '#1a1c22');
  outline(ctx, TILE, 30);
  return c;
}

/** Standing whiteboard (16×26) with marker sketches. */
export function drawWhiteboard(variant: number): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 26);
  px(0, 2, 16, 13, '#b8bec9'); // frame
  px(1, 3, 14, 11, '#f7f9fb');
  px(1, 3, 14, 1, '#ffffff');
  const r = seeded(variant * 17 + 3);
  const inks = ['#2e6fd8', '#d83a2e', '#2e9e4f', '#3a3f4b'];
  if (variant % 3 === 0) {
    // boxes and an arrow: an architecture sketch
    px(2, 5, 4, 3, inks[0]!);
    px(3, 6, 2, 1, '#f7f9fb');
    px(10, 9, 4, 3, inks[2]!);
    px(11, 10, 2, 1, '#f7f9fb');
    px(6, 6, 4, 1, inks[3]!);
    px(9, 7, 1, 2, inks[3]!);
  } else if (variant % 3 === 1) {
    // a little chart
    for (let i = 0; i < 5; i++) px(3 + i * 2, 12 - (2 + Math.floor(r() * 6)), 1, 2 + Math.floor(r() * 6), inks[i % 3]!);
    px(2, 12, 12, 1, inks[3]!);
  } else {
    for (let l = 0; l < 4; l++) px(2, 5 + l * 2, 4 + Math.floor(r() * 9), 1, inks[Math.floor(r() * inks.length)]!);
  }
  px(2, 15, 12, 1, '#8e97a5'); // marker tray
  px(4, 14, 2, 1, inks[1]!);
  px(7, 14, 2, 1, inks[0]!);
  px(3, 16, 1, 9, '#6b7280'); // legs
  px(12, 16, 1, 9, '#6b7280');
  px(1, 24, 5, 1, '#4a4f5c');
  px(10, 24, 5, 1, '#4a4f5c');
  outline(ctx, TILE, 26);
  return c;
}

/** Presentation screen on a stand (16×26) showing a static slide. */
export function drawPresentationScreen(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 26);
  px(0, 1, 16, 12, '#2d3240'); // bezel
  px(1, 2, 14, 10, '#1f3b63');
  px(1, 2, 14, 2, '#2a4f84'); // title bar
  px(2, 2, 6, 1, '#e8eef5');
  const bars = [3, 5, 4, 7, 6];
  bars.forEach((h, i) => px(3 + i * 2, 11 - h, 1, h, i === 3 ? '#ffd166' : '#5ad1ff'));
  px(2, 11, 12, 1, '#8fb4ff');
  px(7, 13, 2, 10, '#4a4f5c'); // pole
  px(3, 23, 10, 2, '#3a3f4f');
  px(3, 23, 10, 1, '#4f5668');
  outline(ctx, TILE, 26);
  return c;
}

/** Table tile (16×16) that joins with neighbouring table tiles into one big table. */
export function drawTable(mask: number): HTMLCanvasElement {
  const [c, , px] = canvas(TILE, TILE);
  const top = '#a87b52';
  const hi = '#c8986a';
  const edge = '#6b4a33';
  const x0 = mask & W ? 0 : 1;
  const x1 = mask & E ? 16 : 15;
  const y0 = mask & N ? 0 : 3;
  const y1 = mask & S ? 16 : 11;
  px(x0, y0, x1 - x0, y1 - y0, top);
  // wood grain
  for (let yy = y0 + 2; yy < y1; yy += 3) px(x0, yy, x1 - x0, 1, mix(top, -0.08));
  if (!(mask & N)) {
    px(x0, y0 - 1, x1 - x0, 1, edge);
    px(x0, y0, x1 - x0, 1, hi);
  }
  if (!(mask & W)) px(0, y0 - (mask & N ? 0 : 1), 1, y1 - y0 + (mask & N ? 0 : 1) + (mask & S ? 0 : 3), edge);
  if (!(mask & E)) px(15, y0 - (mask & N ? 0 : 1), 1, y1 - y0 + (mask & N ? 0 : 1) + (mask & S ? 0 : 3), edge);
  if (!(mask & S)) {
    px(x0, 11, x1 - x0, 3, '#8c5f3e'); // apron
    px(x0, 11, x1 - x0, 1, '#7d5436');
    px(x0, 14, x1 - x0, 1, edge);
    if (!(mask & W)) px(1, 14, 2, 2, '#4f3524'); // legs at the outer corners
    if (!(mask & E)) px(13, 14, 2, 2, '#4f3524');
  }
  return c;
}

/** Meeting chair (16×16) facing a direction (the way the sitter looks). */
export function drawMeetingChair(face: 'up' | 'down' | 'left' | 'right'): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, TILE);
  const fab = '#a5523f';
  const hi = '#c96b55';
  const lo = '#7a3a2c';
  const leg = '#3a2a20';
  switch (face) {
    case 'up': // seen from behind: backrest in front
      px(4, 5, 8, 3, fab);
      px(4, 8, 8, 5, lo);
      px(5, 9, 6, 3, fab);
      px(5, 9, 6, 1, hi);
      px(4, 13, 1, 2, leg);
      px(11, 13, 1, 2, leg);
      break;
    case 'down': // seen from the front: backrest behind the seat
      px(4, 2, 8, 6, lo);
      px(5, 3, 6, 4, fab);
      px(5, 3, 6, 1, hi);
      px(3, 8, 10, 4, fab);
      px(3, 8, 10, 1, hi);
      px(4, 12, 1, 3, leg);
      px(11, 12, 1, 3, leg);
      break;
    default: {
      // side view; the backrest is away from the table
      const back = face === 'left' ? 11 : 2;
      px(back, 3, 3, 8, lo);
      px(back + 1, 4, 1, 6, fab);
      px(3, 9, 10, 3, fab);
      px(3, 9, 10, 1, hi);
      px(4, 12, 1, 3, leg);
      px(11, 12, 1, 3, leg);
      break;
    }
  }
  outline(ctx, TILE, TILE);
  return c;
}

/** Snack vending machine (16×30). */
export function drawSnackMachine(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 30);
  px(1, 1, 14, 27, '#c0392b');
  px(1, 1, 14, 2, '#e05a49');
  px(2, 4, 9, 17, '#22303f'); // glass
  px(2, 4, 9, 1, '#5d7489');
  const snacks = ['#ffd166', '#7ee787', '#ff9a8a', '#5ad1ff', '#f2b134', '#b06bff'];
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < 3; i++) px(3 + i * 3, 6 + row * 4, 2, 2, snacks[(row * 3 + i) % snacks.length]!);
    px(2, 8 + row * 4, 9, 1, '#3a4b5e');
  }
  px(3, 5, 1, 14, '#41566b'); // reflection
  px(12, 5, 2, 3, '#1c1f27'); // keypad
  for (let k = 0; k < 3; k++) px(12, 9 + k * 2, 2, 1, '#e8eef5');
  px(12, 16, 2, 3, '#7a1f16'); // coin slot
  px(3, 22, 8, 3, '#1c1f27'); // pickup
  px(3, 22, 8, 1, '#3a3f4b');
  px(2, 28, 3, 2, '#3a2a20');
  px(11, 28, 3, 2, '#3a2a20');
  outline(ctx, TILE, 30);
  return c;
}

/** Reception counter piece (16×22) that joins left/right with neighbours. */
export function drawReceptionDesk(mask: number, withBell: boolean): HTMLCanvasElement {
  const [c, , px] = canvas(TILE, 22);
  const x0 = mask & W ? 0 : 1;
  const x1 = mask & E ? 16 : 15;
  px(x0, 3, x1 - x0, 4, '#ece4d4'); // counter top
  px(x0, 3, x1 - x0, 1, '#fffaf0');
  px(x0, 7, x1 - x0, 1, '#b8ad98');
  px(x0, 8, x1 - x0, 13, '#5f4130'); // front panel
  px(x0, 8, x1 - x0, 1, '#7c5840');
  px(x0, 12, x1 - x0, 2, '#d9a441'); // brass stripe
  px(x0, 12, x1 - x0, 1, '#f2cc60');
  px(x0, 20, x1 - x0, 1, '#3e2b20');
  if (!(mask & W)) {
    px(0, 3, 1, 18, OUTLINE);
    px(1, 3, 1, 18, '#7c5840');
  }
  if (!(mask & E)) {
    px(15, 3, 1, 18, OUTLINE);
    px(14, 3, 1, 18, '#4a3326');
  }
  px(x0, 2, x1 - x0, 1, OUTLINE);
  px(x0, 21, x1 - x0, 1, OUTLINE);
  if (withBell) {
    px(7, 1, 3, 2, '#f2cc60');
    px(8, 0, 1, 1, '#f2cc60');
    px(6, 3, 5, 1, '#b8912e');
  }
  return c;
}

/** Noticeboard on legs (16×24) with pinned notes. */
export function drawNoticeboard(variant: number): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 24);
  px(0, 1, 16, 13, '#7a5235');
  px(1, 2, 14, 11, '#c49a6c');
  const r = seeded(variant * 29 + 11);
  for (let i = 0; i < 4; i++) px(1 + Math.floor(r() * 9), 3 + Math.floor(r() * 7), 1, 1, mix('#c49a6c', -0.15)); // cork grain
  const notes = ['#fbfbf2', '#fff176', '#ffab91', '#80deea', '#a5d6a7'];
  const spots: Array<[number, number]> = [
    [2, 3],
    [8, 3],
    [3, 8],
    [10, 8],
  ];
  spots.forEach(([x, y], i) => {
    const col = notes[(i + variant) % notes.length]!;
    px(x, y, 4, 4, col);
    px(x + 1, y + 2, 2, 1, mix(col, -0.3));
    px(x + 1, y, 1, 1, ['#c0392b', '#2e86c1', '#239b56'][i % 3]!); // pin
  });
  px(3, 14, 1, 8, '#4a3326');
  px(12, 14, 1, 8, '#4a3326');
  px(1, 22, 5, 1, '#3e2b20');
  px(10, 22, 5, 1, '#3e2b20');
  outline(ctx, TILE, 24);
  return c;
}

/** Console desk (16×22) with two small monitors; decorative feeds themed by room. */
export function drawConsole(theme: ConsoleTheme, frame: number): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 22);
  px(0, 10, 16, 5, '#3a3f4b'); // desk top
  px(0, 10, 16, 1, '#555c6c');
  px(0, 15, 16, 5, '#2b2f3a');
  px(1, 16, 14, 3, '#232631');
  for (let k = 0; k < 5; k++) px(3 + k * 2, 12, 1, 1, ['#7ee787', '#ffb057', '#5ad1ff', '#7ee787', '#ff6b6b'][k]!); // buttons
  px(1, 20, 2, 2, '#1a1c22');
  px(13, 20, 2, 2, '#1a1c22');
  for (const ox of [1, 8]) {
    px(ox, 1, 7, 7, '#2d3240'); // bezel
    px(ox + 1, 2, 5, 5, '#0b0f17');
    px(ox + 3, 8, 1, 2, '#3a4050');
    const s = (ox === 1 ? 0 : 1) + frame;
    if (theme === 'cctv') {
      px(ox + 1, 2, 5, 5, '#2f3f3a');
      px(ox + 1, 5, 5, 2, '#46594f'); // floor of the camera view
      px(ox + 2 + (s % 3), 4, 1, 2, '#9fb5a8'); // a figure-ish blob
      px(ox + 1, 2 + (s % 5), 5, 1, '#5a7166'); // scanline
      px(ox + 5, 2, 1, 1, frame % 2 ? '#ff5252' : '#7a2020'); // REC dot
    } else if (theme === 'graphs') {
      px(ox + 1, 2, 5, 5, '#0f1a14');
      for (let i = 0; i < 5; i++) px(ox + 1 + i, 2 + ((i * 2 + s) % 4) + 1, 1, 1, '#7ee787');
    } else {
      px(ox + 1, 2, 5, 5, '#0f1626');
      px(ox + 2, 3, 3, 1, '#5ad1ff');
      px(ox + 2, 5, (s % 3) + 1, 1, '#ffd166');
    }
  }
  outline(ctx, TILE, 22);
  return c;
}

/** Tiny build lamp (5×6) sitting on a QA monitor. */
export function drawQaLamp(state: QaLampState, lit: boolean): HTMLCanvasElement {
  const [c, , px] = canvas(5, 6);
  const color = { off: '#3a3f4b', run: lit ? '#ffb057' : '#8a5a20', ok: '#7ee787', fail: '#ff6b6b' }[state];
  px(1, 0, 3, 1, OUTLINE);
  px(0, 1, 1, 3, OUTLINE);
  px(4, 1, 1, 3, OUTLINE);
  px(1, 1, 3, 3, color);
  if (state !== 'off') px(1, 1, 1, 1, mix(color, 0.5));
  px(0, 4, 5, 2, '#2d3240');
  px(0, 5, 5, 1, OUTLINE);
  return c;
}

/** Small stack of books (7×5) for research desks. */
export function drawBookStack(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(7, 5);
  px(0, 3, 6, 2, '#2e86c1');
  px(1, 1, 5, 2, '#c0392b');
  px(0, 0, 4, 1, '#d4ac0d');
  px(0, 3, 6, 1, '#5dade2');
  px(1, 1, 5, 1, '#e74c3c');
  outline(ctx, 7, 5);
  return c;
}
