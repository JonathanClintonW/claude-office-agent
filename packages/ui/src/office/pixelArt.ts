/**
 * Procedural pixel art (original, drawn in code). Native resolution: 16px tiles, scaled with
 * nearest-neighbour filtering. Characters use 3-tone shading and an automatic dark outline.
 */

export const TILE = 16;
export const CHAR_W = 16;
export const CHAR_H = 24;
export const SCREEN_W = 10;
export const SCREEN_H = 8;

export type Facing = 'down' | 'up' | 'side';
export type Pose =
  | `walk_${Facing}_${0 | 1 | 2 | 3}`
  | 'stand'
  | 'think'
  | 'stand_raise'
  | 'stand_cheer'
  | 'stand_slump'
  | 'sit'
  | 'type0'
  | 'type1'
  | 'sit_raise'
  | 'sit_cheer'
  | 'sit_slump'
  | 'sit_stretch'
  | 'sit_sip'
  | 'couch'
  | 'drink'
  | 'side_talk'
  // simulated idle-life / meeting poses (front, side or back views)
  /** Front, holding an open book. */
  | 'read'
  /** Front, a snack at the mouth. */
  | 'eat'
  /** Front, standing with both arms stretched up. */
  | 'stretch'
  /** Front, seated at a table, forearms resting on it. */
  | 'sit_meeting'
  /** Side, seated at a table. */
  | 'sit_meeting_side'
  /** Side, pointing forward (presenting). */
  | 'present'
  /** Front, pointing to the side. */
  | 'present_front'
  /** Back, one arm raised towards a board. */
  | 'present_up'
  /** Front, waving (two frames). */
  | 'wave'
  | 'wave1'
  /** Side, watering a plant with a can. */
  | 'water'
  /** Front, talking with a small gesture. */
  | 'talk_front'
  // seated desk poses for real working states (back view, see poses.ts workPresentation)
  /** Hand on the mouse, scrolling (two frames). */
  | 'sit_read'
  | 'sit_read1'
  /** Leaning back, hands behind the head (watching a test run / waiting). */
  | 'sit_lean'
  /** Scratching the head (debugging after a real failure). */
  | 'sit_debug'
  /** Hand at the chin (thinking). */
  | 'sit_think';

const WALK_POSES: Pose[] = (['down', 'up', 'side'] as const).flatMap((f) => ([0, 1, 2, 3] as const).map((n) => `walk_${f}_${n}` as const));

/** Every pose drawCharacter() supports (runtime list for tests and tooling). */
export const SPRITE_POSES: readonly Pose[] = [
  ...WALK_POSES,
  'stand',
  'think',
  'stand_raise',
  'stand_cheer',
  'stand_slump',
  'sit',
  'type0',
  'type1',
  'sit_raise',
  'sit_cheer',
  'sit_slump',
  'sit_stretch',
  'sit_sip',
  'couch',
  'drink',
  'side_talk',
  'read',
  'eat',
  'stretch',
  'sit_meeting',
  'sit_meeting_side',
  'present',
  'present_front',
  'present_up',
  'wave',
  'wave1',
  'water',
  'talk_front',
  'sit_read',
  'sit_read1',
  'sit_lean',
  'sit_debug',
  'sit_think',
];

export interface Look {
  outfit: 0 | 1 | 2 | 3; // hoodie, t-shirt, shirt & tie, jacket
  hairStyle: 0 | 1 | 2 | 3; // short, long, curly, buzz
  shirt: string;
  skin: string;
  hair: string;
  pants: string;
  /** Cap colour for subagents, headset colour for teammates. */
  accent?: string;
  /** `visitor`: a simulated visitor (visitors.ts), never an agent; wears a lavender lanyard badge. */
  role: 'session' | 'subagent' | 'teammate' | 'visitor';
}

const OUTLINE = '#17141f';

// --- colour helpers

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
/** f > 0 lightens towards white, f < 0 darkens (with a slight cool shift for shadows). */
export function shade(hex: string, f: number): string {
  const [r, g, b] = rgb(hex);
  if (f >= 0) return toHex(r + (255 - r) * f, g + (255 - g) * f, b + (255 - b) * f);
  const k = 1 + f;
  return toHex(r * k, g * k, b * k + 10 * -f);
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const FAMILY = ['#4f8cff', '#ff7a59', '#38c172', '#b06bff', '#f2b134', '#ff5c8a', '#26c6da', '#e57c2f', '#7bd389', '#8d99ae', '#5c6bff', '#a3d65c'];
const SKINS = ['#f6d5b3', '#eab88f', '#c98e5a', '#9a6438', '#6e4527'];
const HAIRS = ['#2a1d16', '#5b3a26', '#a8692f', '#e3c15f', '#1e2a46', '#7e3434', '#c9c9d1', '#3d2f4f'];
const PANTS = ['#2f3756', '#3a3030', '#26393d', '#3d3a52', '#4a4f5c'];

export function lookFor(seed: string, role: Look['role'], familySeed: string): Look {
  const h = hash(seed);
  const shirt = FAMILY[hash(familySeed) % FAMILY.length]!;
  const look: Look = {
    outfit: (role === 'session' ? h % 4 : (h >>> 4) % 2 === 0 ? 0 : 1) as Look['outfit'],
    hairStyle: ((h >>> 6) % 4) as Look['hairStyle'],
    shirt,
    skin: SKINS[(h >>> 9) % SKINS.length]!,
    hair: HAIRS[(h >>> 12) % HAIRS.length]!,
    pants: PANTS[(h >>> 15) % PANTS.length]!,
    role,
  };
  if (role === 'subagent') look.accent = FAMILY[(hash(familySeed) + 5) % FAMILY.length];
  if (role === 'teammate') look.accent = '#e8e8ee';
  return look;
}

/** Muted clothes for simulated visitors (agents wear their session's family colour). */
const VISITOR_SHIRTS = ['#7d8597', '#a1887f', '#6d8b74', '#9575a6', '#b5a46a', '#5f7d95', '#b07a6e'];
/** Lanyard and badge stripe of simulated visitors: the lavender of simulated speech. */
export const VISITOR_BADGE = { strap: '#8f7fd6', card: '#d9d0ff', stripe: '#5a4d9e' } as const;

/** Look of a simulated visitor: muted clothes and a lavender lanyard badge. */
export function visitorLook(seed: string): Look {
  const h = hash(`visitor:${seed}`);
  return {
    outfit: ([1, 2, 3] as const)[h % 3]!,
    hairStyle: ((h >>> 6) % 4) as Look['hairStyle'],
    shirt: VISITOR_SHIRTS[(h >>> 3) % VISITOR_SHIRTS.length]!,
    skin: SKINS[(h >>> 9) % SKINS.length]!,
    hair: HAIRS[(h >>> 12) % HAIRS.length]!,
    pants: PANTS[(h >>> 15) % PANTS.length]!,
    role: 'visitor',
  };
}

export function workspaceColor(key: string): string {
  return FAMILY[hash(key) % FAMILY.length]!;
}

// --- canvas helpers

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

/** Deterministic pseudo-random sequence for textures. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

// --- characters

interface Tones {
  hi: string;
  base: string;
  lo: string;
  dk: string;
}
function tones(base: string): Tones {
  return { hi: shade(base, 0.28), base, lo: shade(base, -0.22), dk: shade(base, -0.42) };
}

export function drawCharacter(look: Look, pose: Pose): HTMLCanvasElement {
  const [c, ctx, px] = canvas(CHAR_W, CHAR_H);
  const skin = tones(look.skin);
  const hair = tones(look.hair);
  const pants = tones(look.pants);
  const shirtBase = look.outfit === 2 ? '#e9edf3' : look.outfit === 3 ? shade(look.shirt, -0.35) : look.shirt;
  const shirt = tones(shirtBase);
  const shoe = '#2a2433';

  const frontSeated = pose === 'sit_meeting';
  const sideSeated = pose === 'sit_meeting_side';
  // Desk poses are seen from behind (facing the monitor).
  const seated = !frontSeated && !sideSeated && (pose === 'sit' || pose.startsWith('type') || pose.startsWith('sit_'));
  const sideView = pose === 'side_talk' || pose === 'present' || pose === 'water' || sideSeated;
  const facing: Facing =
    seated || pose === 'present_up' ? 'up' : sideView ? 'side' : pose.startsWith('walk_') ? (pose.split('_')[1] as Facing) : 'down';
  const frame = pose.startsWith('walk_') ? Number(pose.split('_')[2]) : 0;
  const slump = pose === 'sit_slump' || pose === 'stand_slump';
  const headDy = (slump ? 2 : 0) + (pose === 'type1' || pose === 'read' || pose === 'sit_lean' ? 1 : 0);
  const bodyDy = slump ? 1 : 0;

  // legs & shoes (frames 1/3 lift one leg)
  const leg = (x: number, lift: number, shoeDx: number) => {
    px(x, 18 + bodyDy, 3, 4 - lift, pants.base);
    px(x, 18 + bodyDy, 1, 4 - lift, pants.hi);
    px(x + 2, 18 + bodyDy, 1, 4 - lift, pants.lo);
    px(x + shoeDx, 22 - lift, 4, 2, shoe);
    px(x + shoeDx, 22 - lift, 2, 1, '#4a4258');
  };
  if (pose === 'couch' || frontSeated) {
    // seen from the front while sitting: thighs towards the viewer, shins down
    px(4, 18, 8, 2, pants.base);
    px(4, 18, 8, 1, pants.hi);
    px(5, 20, 2, 2, pants.lo);
    px(9, 20, 2, 2, pants.lo);
    px(4, 22, 3, 2, shoe);
    px(9, 22, 3, 2, shoe);
  } else if (sideSeated) {
    // seen from the side while sitting: thigh forward, shin down
    px(6, 18, 6, 2, pants.base);
    px(6, 18, 6, 1, pants.hi);
    px(10, 20, 2, 2, pants.lo);
    px(10, 22, 4, 2, shoe);
    px(10, 22, 2, 1, '#4a4258');
  } else if (facing === 'side') {
    const fwd = frame === 1 ? 1 : frame === 3 ? -1 : 0;
    leg(6 - fwd, frame === 3 ? 1 : 0, 0);
    leg(8 + fwd, frame === 1 ? 1 : 0, 0);
  } else {
    leg(5, frame === 1 ? 1 : 0, -1);
    leg(8, frame === 3 ? 1 : 0, 0);
  }

  // torso
  const ty = 11 + bodyDy;
  const tx = facing === 'side' ? 5 : 4;
  const tw = facing === 'side' ? 6 : 8;
  px(tx, ty, tw, 6, shirt.base);
  px(tx, ty, 1, 6, shirt.hi);
  px(tx + tw - 2, ty, 2, 6, shirt.lo);
  px(tx, ty + 5, tw, 1, shirt.lo);
  px(tx, ty + 6, tw, 1, '#2b2530'); // belt
  if (facing === 'down') {
    if (look.outfit === 0) {
      px(5, ty, 6, 1, shirt.lo); // hood rim
      px(6, ty + 1, 1, 2, shirt.hi); // strings
      px(9, ty + 1, 1, 2, shirt.hi);
      px(6, ty + 4, 4, 1, shirt.dk); // pocket
    } else if (look.outfit === 1) {
      px(7, ty, 2, 1, skin.lo); // neckline
      px(6, ty + 2, 4, 2, shirt.hi); // print
      px(7, ty + 2, 2, 1, shirt.lo);
    } else if (look.outfit === 2) {
      px(6, ty, 1, 1, '#ffffff');
      px(9, ty, 1, 1, '#ffffff');
      px(7, ty, 2, 6, look.shirt); // tie
      px(7, ty, 2, 1, shade(look.shirt, 0.3));
    } else {
      px(7, ty, 2, 6, '#e9edf3'); // shirt under jacket
      px(6, ty, 1, 3, shirt.dk); // lapels
      px(9, ty, 1, 3, shirt.dk);
      px(7, ty + 1, 2, 4, look.shirt);
    }
  } else if (facing === 'up') {
    if (look.outfit === 0) px(5, ty, 6, 2, shirt.lo); // hood on the back
    px(7, ty + 1, 2, 4, shirt.lo); // spine shadow
  }

  // arms
  const sleeve = look.outfit === 1 ? 2 : 4;
  const armDown = (x: number, dy: number) => {
    px(x, ty + dy, 1, sleeve, shirt.lo);
    px(x, ty + dy + sleeve, 1, 5 - sleeve, skin.base);
    px(x, ty + dy + 5, 1, 1, skin.lo);
  };
  const armUp = (x: number, top: number) => {
    px(x, top + 2, 1, ty - top + 1, shirt.lo);
    px(x, top, 1, 2, skin.base);
  };
  const elbow = (x: number, dy: number) => {
    px(x, ty + 1 + dy, 1, 3, shirt.lo);
    px(x, ty + 4 + dy, 1, 1, skin.lo);
  };
  if (pose === 'side_talk') {
    px(8, ty + 1, 1, 2, shirt.dk); // gesturing forearm
    px(9, ty, 1, 2, shirt.dk);
    px(10, ty - 1, 1, 2, skin.base);
  } else if (pose === 'present') {
    px(9, ty + 1, 2, 1, shirt.dk); // arm stretched forward
    px(11, ty, 1, 1, shirt.dk);
    px(12, ty - 1, 2, 1, skin.base); // pointing hand
  } else if (pose === 'water') {
    px(8, ty + 1, 1, 2, shirt.dk);
    px(9, ty + 3, 1, 1, shirt.dk);
    px(10, ty + 3, 1, 1, skin.base); // hand on the handle
    px(10, ty + 4, 3, 3, '#3e9e4f'); // watering can
    px(10, ty + 4, 3, 1, '#5ac46a');
    px(13, ty + 4, 1, 1, '#2f8240'); // spout
    px(14, ty + 3, 1, 1, '#2f8240');
    px(14, ty + 6, 1, 1, '#8fd0ff'); // a drop
  } else if (sideSeated) {
    px(8, ty + 2, 1, 2, shirt.dk); // forearm resting on the table
    px(9, ty + 4, 2, 1, skin.base);
  } else if (facing === 'side') {
    const swing = frame === 1 ? 1 : frame === 3 ? -1 : 0;
    px(8 + swing, ty + 1, 1, 4, shirt.dk);
    px(8 + swing, ty + 5, 1, 1, skin.base);
  } else if (seated) {
    switch (pose) {
      case 'type0':
        elbow(3, 0);
        elbow(12, 1);
        break;
      case 'type1':
        elbow(3, 1);
        elbow(12, 0);
        break;
      case 'sit_raise':
        elbow(3, 0);
        armUp(12, 2);
        break;
      case 'sit_cheer':
        armUp(3, 2);
        armUp(12, 2);
        break;
      case 'sit_stretch':
        armUp(2, 3);
        armUp(13, 3);
        break;
      case 'sit_sip':
        elbow(3, 0);
        px(12, ty - 2, 1, 4, shirt.lo);
        px(12, 6, 2, 3, '#f2f2f2'); // mug
        px(14, 7, 1, 1, '#f2f2f2');
        px(12, 6, 2, 1, '#7a4a2a'); // coffee
        break;
      case 'sit_read':
      case 'sit_read1':
        elbow(3, 0);
        px(12, ty + 1, 1, 2, shirt.lo); // arm out to the mouse
        px(13, ty + 3, 1, 1, shirt.lo);
        px(14, ty + (pose === 'sit_read1' ? 3 : 4), 1, 1, skin.lo);
        break;
      case 'sit_lean':
        // upper arms raised; forearms and hands are drawn on the back of the head below
        px(2, 6, 1, ty - 6, shirt.lo);
        px(13, 6, 1, ty - 6, shirt.lo);
        break;
      case 'sit_debug':
        elbow(3, 0);
        px(13, 4, 1, ty - 3, shirt.lo); // raised elbow; the hand is drawn on the head below
        break;
      case 'sit_think':
        elbow(3, 0);
        px(12, ty, 1, 3, shirt.lo);
        px(12, ty - 2, 1, 2, skin.base); // hand at the chin
        break;
      default:
        elbow(3, 0);
        elbow(12, 0);
    }
  } else {
    const swing = frame === 1 ? 1 : frame === 3 ? -1 : 0;
    switch (pose) {
      case 'stand_raise':
        armDown(3, 0);
        armUp(12, 2);
        break;
      case 'stand_cheer':
        armUp(3, 2);
        armUp(12, 2);
        break;
      case 'think':
        armDown(3, 0);
        px(11, ty + 1, 1, 3, shirt.lo);
        px(10, ty - 1, 1, 2, skin.base); // hand at chin
        break;
      case 'drink':
        armDown(3, 0);
        px(11, ty + 1, 1, 3, shirt.lo);
        px(10, ty - 1, 1, 2, skin.base);
        break;
      case 'couch':
        armDown(3, 1);
        armDown(12, 1);
        break;
      case 'read':
        px(3, ty, 1, 3, shirt.lo); // forearms bent inwards, holding a book
        px(12, ty, 1, 3, shirt.lo);
        px(4, ty + 3, 1, 1, skin.base);
        px(11, ty + 3, 1, 1, skin.base);
        px(5, ty + 1, 6, 4, '#2e86c1'); // open book (cover towards the viewer)
        px(7, ty + 1, 2, 4, '#1f618d'); // spine
        px(5, ty + 1, 2, 1, '#f5f1e6'); // page edges
        px(9, ty + 1, 2, 1, '#f5f1e6');
        break;
      case 'eat':
        armDown(3, 0);
        px(11, ty + 1, 1, 3, shirt.lo); // hand at the mouth; the snack is drawn below
        px(10, ty - 1, 1, 2, skin.base);
        break;
      case 'stretch':
        armUp(3, 0);
        armUp(12, 0);
        break;
      case 'sit_meeting':
        px(3, ty + 1, 1, 3, shirt.lo); // forearms resting on the table
        px(12, ty + 1, 1, 3, shirt.lo);
        px(4, ty + 4, 2, 1, skin.base);
        px(10, ty + 4, 2, 1, skin.base);
        break;
      case 'present_front':
        armDown(3, 0);
        px(12, ty, 1, 2, shirt.lo); // arm out to the side, pointing
        px(13, ty + 1, 1, 1, shirt.lo);
        px(14, ty + 1, 1, 1, skin.base);
        break;
      case 'present_up':
        armDown(3, 0);
        armUp(12, 2);
        break;
      case 'wave':
        armDown(3, 0);
        px(12, ty - 1, 1, 2, shirt.lo);
        px(13, ty - 3, 1, 2, shirt.lo); // forearm tilted outwards
        px(13, ty - 5, 2, 2, skin.base); // open hand
        break;
      case 'wave1':
        armDown(3, 0);
        px(12, ty - 1, 1, 2, shirt.lo);
        px(12, ty - 3, 1, 2, shirt.lo); // forearm upright
        px(12, ty - 5, 2, 2, skin.base);
        break;
      case 'talk_front':
        armDown(3, 0);
        px(12, ty, 1, 3, shirt.lo); // small gesture in front of the chest
        px(11, ty + 3, 2, 1, skin.base);
        break;
      default:
        armDown(3, swing);
        armDown(12, -swing);
    }
  }

  // neck & head
  const hy = 1 + headDy;
  if (facing !== 'up') px(7, 10 + bodyDy, 2, 1, skin.lo);
  if (facing === 'up') {
    px(5, hy, 6, 1, hair.base);
    px(4, hy + 1, 8, 8, hair.base);
    px(5, hy + 1, 3, 1, hair.hi);
    px(4, hy + 7, 8, 2, hair.lo);
    px(3, hy + 4, 1, 2, skin.base); // ears
    px(12, hy + 4, 1, 2, skin.base);
    if (look.hairStyle === 1) px(4, hy + 8, 8, 3, hair.lo); // long hair down the back
    if (look.hairStyle === 2) {
      px(4, hy, 1, 1, hair.base);
      px(11, hy, 1, 1, hair.base);
      px(6, hy + 3, 1, 1, hair.lo);
      px(9, hy + 5, 1, 1, hair.lo);
    }
    if (look.hairStyle === 3) {
      px(4, hy + 1, 8, 8, hair.lo);
      px(5, hy + 2, 6, 5, shade(look.hair, -0.1));
    }
  } else if (facing === 'side') {
    px(6, hy, 5, 1, hair.base);
    px(5, hy + 1, 6, 2, hair.base);
    px(5, hy + 3, 6, 6, skin.base);
    px(5, hy + 3, 3, 5, hair.base); // back of head
    px(6, hy + 1, 3, 1, hair.hi);
    px(7, hy + 5, 1, 2, skin.lo); // ear
    px(10, hy + 4, 1, 2, OUTLINE); // eye
    px(11, hy + 6, 1, 1, skin.base); // nose
    px(9, hy + 7, 2, 1, skin.lo);
    px(6, hy + 8, 4, 1, skin.lo);
    if (look.hairStyle === 1) px(5, hy + 3, 2, 7, hair.lo);
  } else {
    px(5, hy, 6, 1, hair.base);
    px(4, hy + 1, 8, 2, hair.base);
    px(5, hy + 1, 3, 1, hair.hi);
    px(4, hy + 3, 8, 6, skin.base);
    px(4, hy + 3, 8, 1, hair.base); // hairline
    px(4, hy + 4, 1, 2, hair.base); // sideburns
    px(11, hy + 4, 1, 2, hair.base);
    px(5, hy + 3, 3, 1, hair.lo); // fringe
    px(11, hy + 6, 1, 2, skin.lo);
    px(4, hy + 6, 1, 2, skin.lo);
    if (slump || pose === 'stretch') {
      px(6, hy + 5, 2, 1, skin.lo); // eyes closed
      px(9, hy + 5, 2, 1, skin.lo);
    } else if (pose === 'read') {
      px(6, hy + 6, 1, 1, OUTLINE); // looking down at the book
      px(9, hy + 6, 1, 1, OUTLINE);
    } else {
      px(6, hy + 5, 1, 2, OUTLINE);
      px(9, hy + 5, 1, 2, OUTLINE);
    }
    px(6, hy + 4, 1, 1, hair.lo);
    px(9, hy + 4, 1, 1, hair.lo);
    px(7, hy + 7, 2, 1, pose === 'stand_cheer' ? '#a83a3a' : pose === 'stretch' || pose === 'talk_front' ? '#5a2a2a' : skin.lo);
    px(5, hy + 8, 6, 1, skin.lo); // jaw shadow
    if (look.hairStyle === 1) {
      px(3, hy + 2, 1, 7, hair.base);
      px(12, hy + 2, 1, 7, hair.base);
    }
    if (look.hairStyle === 2) {
      px(4, hy, 1, 1, hair.base);
      px(11, hy, 1, 1, hair.base);
      px(8, Math.max(0, hy - 1), 2, 1, hair.base);
    }
    if (look.hairStyle === 3) {
      px(4, hy + 1, 8, 2, hair.lo);
      px(4, hy + 3, 8, 1, skin.base);
    }
  }

  if (pose === 'drink') {
    px(8, hy + 6, 3, 3, '#e8f4ff'); // paper cup at the mouth
    px(8, hy + 6, 3, 1, '#8fd0ff');
  } else if (pose === 'eat') {
    px(8, hy + 6, 3, 1, '#e9c27a'); // sandwich at the mouth
    px(8, hy + 7, 3, 1, '#6cc04a');
    px(8, hy + 8, 3, 1, '#e9c27a');
  } else if (pose === 'sit_lean') {
    px(3, hy + 4, 2, 1, shirt.lo); // forearms to the back of the head
    px(11, hy + 4, 2, 1, shirt.lo);
    px(5, hy + 4, 6, 1, skin.base); // hands behind the head
    px(5, hy + 5, 6, 1, skin.lo);
  } else if (pose === 'sit_debug') {
    px(12, hy + 2, 1, 2, shirt.lo);
    px(10, hy + 2, 2, 2, skin.base); // scratching the head
  }

  // role accessories
  if (look.role === 'subagent' && look.accent) {
    const cap = tones(look.accent);
    px(4, Math.max(0, hy - 1), 8, 3, cap.base);
    px(5, Math.max(0, hy - 1), 3, 1, cap.hi);
    if (facing === 'down') px(3, hy + 2, 6, 1, cap.lo); // brim
    if (facing === 'side') px(10, hy + 2, 3, 1, cap.lo);
    if (facing === 'up') px(5, hy + 2, 6, 1, cap.lo);
  } else if (look.role === 'teammate') {
    px(4, Math.max(0, hy - 1), 8, 1, '#3a3f4f');
    if (facing === 'side') px(7, hy + 3, 2, 3, '#3a3f4f');
    else {
      px(3, hy + 3, 1, 3, '#3a3f4f');
      px(12, hy + 3, 1, 3, '#3a3f4f');
      if (facing === 'down') px(11, hy + 6, 2, 1, look.accent ?? '#e8e8ee');
    }
  } else if (look.role === 'visitor') {
    // Lanyard with a visitor badge (lavender: simulated).
    const b = VISITOR_BADGE;
    if (facing === 'down' && pose !== 'read') {
      px(6, ty, 1, 2, b.strap);
      px(9, ty, 1, 2, b.strap);
      px(7, ty + 2, 2, 3, b.card);
      px(7, ty + 2, 2, 1, b.stripe);
    } else if (facing === 'side') {
      px(7, ty, 1, 2, b.strap);
      px(8, ty + 2, 1, 2, b.card);
      px(8, ty + 2, 1, 1, b.stripe);
    } else if (facing === 'up') {
      px(6, ty, 4, 1, b.strap); // strap round the back of the neck
    }
  }

  outline(ctx, CHAR_W, CHAR_H);
  return c;
}

// --- room

export function drawFloor(x: number, y: number): HTMLCanvasElement {
  const [c, , px] = canvas(TILE, TILE);
  const r = rng(hash(`${x},${y}`));
  const woods = ['#9a7351', '#a27a56', '#93694a', '#a5805c'];
  for (let row = 0; row < 4; row++) {
    const base = woods[Math.floor(r() * woods.length)]!;
    const py = row * 4;
    px(0, py, TILE, 4, base);
    px(0, py, TILE, 1, shade(base, 0.08));
    px(0, py + 3, TILE, 1, shade(base, -0.25)); // seam
    const end = (Math.floor(r() * 3) * 5 + (row % 2) * 7 + x * 3) % TILE; // staggered plank ends
    px(end, py, 1, 3, shade(base, -0.3));
    for (let g = 0; g < 2; g++) px(Math.floor(r() * 14), py + 1 + Math.floor(r() * 2), 2 + Math.floor(r() * 3), 1, shade(base, -0.1));
  }
  return c;
}

export type Sky = 'day' | 'dawn' | 'dusk' | 'night';

export function skyFor(hour: number): Sky {
  if (hour >= 7 && hour < 17) return 'day';
  if (hour >= 5 && hour < 7) return 'dawn';
  if (hour >= 17 && hour < 19) return 'dusk';
  return 'night';
}

/** Two-tile-high back wall segment. */
export function drawWall(x: number, kind: 'plain' | 'window' | 'art', sky: Sky): HTMLCanvasElement {
  const [c, , px] = canvas(TILE, TILE * 2);
  px(0, 0, TILE, 20, '#d8c9a8'); // plaster
  px(0, 0, TILE, 2, '#e6dabe');
  if (x % 2 === 0) px(0, 3, 1, 16, '#cdbd9b');
  px(0, 19, TILE, 2, '#8a6446'); // chair rail
  px(0, 19, TILE, 1, '#a57a56');
  px(0, 21, TILE, 9, '#6b4a33'); // wainscot
  px(2, 22, 12, 7, '#5f4130');
  px(2, 22, 12, 1, '#7c5840');
  px(0, 30, TILE, 2, '#3e2b20'); // baseboard
  if (kind === 'window') {
    const skies: Record<Sky, [string, string]> = {
      day: ['#7cc8ff', '#c8ecff'],
      dawn: ['#ffb37a', '#ffd9a8'],
      dusk: ['#ff8f70', '#6d5aa8'],
      night: ['#121a3d', '#1d2a5c'],
    };
    const [top, bottom] = skies[sky];
    px(1, 3, 14, 15, '#f1ece0'); // frame
    px(2, 4, 12, 6, top);
    px(2, 10, 12, 6, bottom);
    px(2, 4, 12, 1, shade(top, -0.1));
    if (sky === 'night') {
      px(4, 6, 1, 1, '#ffffff');
      px(11, 5, 1, 1, '#fff3b0');
      px(8, 12, 1, 1, '#c0c8ff');
      px(10, 7, 2, 2, '#f5f1d0'); // moon
    } else {
      px(4, 7, 4, 1, '#ffffff');
      px(5, 6, 2, 1, '#ffffff');
      px(9, 12, 3, 1, '#f4fbff');
    }
    px(7, 4, 2, 12, '#f1ece0'); // mullions
    px(2, 9, 12, 1, '#f1ece0');
    px(0, 17, TILE, 2, '#efe8d8'); // sill
    px(0, 18, TILE, 1, '#cfc4ad');
  } else if (kind === 'art') {
    const r = rng(hash(`art${x}`));
    px(3, 5, 10, 10, '#4a3527');
    px(4, 6, 8, 8, ['#2e5d8a', '#8a4b2e', '#2e7a54'][Math.floor(r() * 3)]!);
    px(4, 10, 8, 4, ['#d9a441', '#4f7b3a', '#c8d6e6'][Math.floor(r() * 3)]!);
    px(5 + Math.floor(r() * 4), 7, 2, 2, '#fff2a8');
  }
  return c;
}

export function drawDesk(variant: number): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 20);
  px(0, 4, 16, 6, '#b9875c'); // top surface
  px(0, 4, 16, 1, '#d4a273');
  px(0, 9, 16, 1, '#a0734d');
  px(0, 10, 16, 7, '#8c5f3e'); // front panel
  px(1, 11, 14, 5, '#7d5436');
  px(1, 11, 14, 1, '#93694a');
  px(6, 13, 4, 1, '#c7a17a'); // drawer handle
  px(1, 17, 2, 3, '#4f3524'); // legs
  px(13, 17, 2, 3, '#4f3524');
  px(3, 7, 9, 2, '#d7dbe3'); // keyboard
  for (let k = 0; k < 4; k++) px(4 + k * 2, 7, 1, 1, '#a9afbd');
  px(4, 8, 7, 1, '#bfc5d1');
  px(13, 7, 2, 2, '#d7dbe3'); // mouse
  if (variant % 3 === 0) {
    px(1, 5, 2, 3, '#f2f2f2'); // mug
    px(1, 5, 2, 1, '#6b3f22');
  } else if (variant % 3 === 1) {
    px(0, 5, 3, 2, '#fbfbf2'); // papers
    px(1, 4, 3, 2, '#f1f1e4');
  } else {
    px(13, 4, 2, 2, '#4caf50'); // tiny cactus
    px(13, 6, 2, 1, '#b5651d');
  }
  outline(ctx, 16, 20, '#2a1c14');
  return c;
}

/** Monitor bezel; the screen content is a separate animated sprite on top. */
export function drawMonitor(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 14);
  px(2, 0, 12, 10, '#2d3240');
  px(2, 0, 12, 1, '#454c5e');
  px(3, 1, 10, 8, '#0b0f17');
  px(7, 10, 2, 2, '#3a4050');
  px(5, 12, 6, 2, '#3a4050');
  px(5, 12, 6, 1, '#4f5668');
  outline(ctx, 16, 14, '#14161d');
  return c;
}

export type ScreenKind =
  | 'off'
  | 'code'
  | 'think'
  | 'perm'
  | 'ask'
  | 'fail'
  | 'done'
  | 'saver'
  | 'noise'
  /** Document scrolling (Read, WebFetch). */
  | 'read'
  /** Magnifier sweeping over lines (Grep, Glob, WebSearch). */
  | 'search'
  /** Lines being typed with a diff gutter (Edit, Write). */
  | 'edit'
  /** Test run in progress: neutral progress only, never pass/fail colours. */
  | 'test'
  /** Highlighted line and a bug icon (after a real failure). */
  | 'debug'
  /** Shell with a prompt (other commands). */
  | 'terminal'
  /** Spinner (waiting on a subagent or background job). */
  | 'wait'
  /** Neutral activity bar (working, nothing more specific known). */
  | 'busy';

export const SCREEN_KINDS: readonly ScreenKind[] = [
  'off',
  'code',
  'think',
  'perm',
  'ask',
  'fail',
  'done',
  'saver',
  'noise',
  'read',
  'search',
  'edit',
  'test',
  'debug',
  'terminal',
  'wait',
  'busy',
];

/** Frame count and frame duration for each screen (frame = Math.floor(t / ms) % frames). */
export const SCREEN_ANIMATION: Readonly<Record<ScreenKind, { frames: number; ms: number }>> = {
  off: { frames: 1, ms: 1000 },
  code: { frames: 12, ms: 160 },
  think: { frames: 3, ms: 300 },
  perm: { frames: 2, ms: 450 },
  ask: { frames: 2, ms: 600 },
  fail: { frames: 1, ms: 1000 },
  done: { frames: 1, ms: 1000 },
  saver: { frames: 8, ms: 260 },
  noise: { frames: 3, ms: 120 },
  read: { frames: 10, ms: 420 },
  search: { frames: 6, ms: 220 },
  edit: { frames: 14, ms: 170 },
  test: { frames: 17, ms: 180 },
  debug: { frames: 2, ms: 400 },
  terminal: { frames: 8, ms: 260 },
  wait: { frames: 8, ms: 120 },
  busy: { frames: 6, ms: 200 },
};

const CODE_COLORS = ['#7ee787', '#79c0ff', '#ffa657', '#d2a8ff', '#c9d1d9', '#f2cc60'];

export function drawScreen(kind: ScreenKind, frame: number, seed = 0): HTMLCanvasElement {
  const [c, , px] = canvas(SCREEN_W, SCREEN_H);
  const glyph = (rows: string[], color: string, ox: number, oy: number) =>
    rows.forEach((r, y) => [...r].forEach((ch, x) => ch === 'X' && px(ox + x, oy + y, 1, 1, color)));
  switch (kind) {
    case 'off':
      px(0, 0, SCREEN_W, SCREEN_H, '#0b0f17');
      px(1, 1, 2, 1, '#1b2230');
      break;
    case 'code': {
      px(0, 0, SCREEN_W, SCREEN_H, '#0f1626');
      const r = rng(seed * 7919 + 17);
      const lines: Array<[number, number, string]> = [];
      for (let i = 0; i < 12; i++) lines.push([Math.floor(r() * 3), 2 + Math.floor(r() * 6), CODE_COLORS[Math.floor(r() * CODE_COLORS.length)]!]);
      for (let row = 0; row < 4; row++) {
        const [indent, len, col] = lines[(row + frame) % lines.length]!;
        px(1 + indent, row * 2 + 1, Math.min(len, SCREEN_W - 2 - indent), 1, col);
      }
      if (frame % 2 === 0) px(SCREEN_W - 2, 7, 1, 1, '#ffffff'); // cursor
      break;
    }
    case 'think':
      px(0, 0, SCREEN_W, SCREEN_H, '#0f1626');
      for (let i = 0; i < 3; i++) px(2 + i * 2, 4, 1, 1, i === frame % 3 ? '#ffffff' : '#4b5a7a');
      break;
    case 'perm':
      px(0, 0, SCREEN_W, SCREEN_H, frame % 2 ? '#e8873a' : '#ffa94d');
      glyph(['X', 'X', 'X', '.', 'X'], '#ffffff', 4, 1);
      px(5, 1, 1, 3, '#ffffff');
      break;
    case 'ask':
      px(0, 0, SCREEN_W, SCREEN_H, frame % 2 ? '#e0b93a' : '#ffd54f');
      glyph(['XXX', '..X', '.X.', '...', '.X.'], '#3a2a00', 3, 1);
      break;
    case 'fail':
      px(0, 0, SCREEN_W, SCREEN_H, '#b3261e');
      glyph(['X...X', '.X.X.', '..X..', '.X.X.', 'X...X'], '#ffffff', 2, 1);
      break;
    case 'done':
      px(0, 0, SCREEN_W, SCREEN_H, '#2e7d32');
      glyph(['....X', '...X.', 'X.X..', '.X...'], '#ffffff', 2, 2);
      break;
    case 'saver': {
      px(0, 0, SCREEN_W, SCREEN_H, '#0b1a33');
      const path = [
        [1, 1],
        [3, 2],
        [5, 3],
        [7, 4],
        [8, 6],
        [6, 5],
        [4, 4],
        [2, 3],
      ];
      const [sx, sy] = path[frame % path.length]!;
      px(sx!, sy!, 1, 1, '#5ad1ff');
      const [tx, ty] = path[(frame + path.length - 1) % path.length]!;
      px(tx!, ty!, 1, 1, '#24537a');
      break;
    }
    case 'noise': {
      const r = rng(frame * 131 + 7);
      for (let y = 0; y < SCREEN_H; y++) for (let x = 0; x < SCREEN_W; x++) px(x, y, 1, 1, ['#2a2e36', '#5a606c', '#8a909c', '#3d424c'][Math.floor(r() * 4)]!);
      break;
    }
    case 'read': {
      px(0, 0, SCREEN_W, SCREEN_H, '#dfe6ee');
      const r = rng(seed * 4241 + 3);
      const widths: number[] = [];
      for (let i = 0; i < 10; i++) widths.push(3 + Math.floor(r() * 6));
      for (let row = 0; row < 4; row++) px(1, row * 2 + 1, widths[(row + frame) % widths.length]!, 1, row === 1 ? '#3a6ad1' : '#7a8699');
      px(SCREEN_W - 1, (frame % 4) * 2, 1, 2, '#9aa5b1'); // scrollbar
      break;
    }
    case 'search': {
      px(0, 0, SCREEN_W, SCREEN_H, '#0f1626');
      for (let row = 0; row < 4; row++) px(1, row * 2 + 1, 4 + ((row * 3 + seed) % 4), 1, '#2c3a55');
      glyph(['XXX.', 'X.X.', 'XXX.', '...X'], '#f2cc60', frame % 6, 2); // magnifier
      break;
    }
    case 'edit': {
      px(0, 0, SCREEN_W, SCREEN_H, '#0f1626');
      const r = rng(seed * 6007 + 11);
      for (let row = 0; row < 3; row++) px(2, row * 2 + 1, 2 + Math.floor(r() * 6), 1, CODE_COLORS[Math.floor(r() * CODE_COLORS.length)]!);
      const typed = 1 + (frame % 7);
      px(0, 7, 1, 1, '#38c172'); // changed-line gutter
      px(2, 7, typed, 1, '#79c0ff');
      if (frame % 2 === 0) px(2 + typed, 7, 1, 1, '#ffffff'); // cursor
      break;
    }
    case 'test': {
      px(0, 0, SCREEN_W, SCREEN_H, '#0f1626');
      const done = frame % 17;
      for (let i = 0; i < 16; i++) px(1 + (i % 8), 1 + Math.floor(i / 8) * 2, 1, 1, i < done ? '#e6edf3' : '#2c3a55');
      px(1, 6, 8, 1, '#1f2a44');
      px(1, 6, Math.round((done / 16) * 8), 1, '#f2cc60'); // progress
      break;
    }
    case 'debug': {
      px(0, 0, SCREEN_W, SCREEN_H, '#1a1020');
      const r = rng(seed * 3301 + 5);
      for (let row = 0; row < 4; row++) if (row !== 1) px(2, row * 2 + 1, 2 + Math.floor(r() * 5), 1, '#6e5a7e');
      px(0, 3, SCREEN_W, 1, '#4a1e2a'); // highlighted line
      px(2, 3, 4, 1, '#ffb3b3');
      px(0, 3, 1, 1, '#ff5c5c'); // breakpoint
      if (frame % 2 === 0) glyph(['X.X', '.X.', 'XXX', 'X.X'], '#ff8a65', 6, 4); // bug
      break;
    }
    case 'terminal': {
      px(0, 0, SCREEN_W, SCREEN_H, '#05070a');
      const r = rng(seed * 2711 + 13);
      const lens: number[] = [];
      for (let i = 0; i < 8; i++) lens.push(2 + Math.floor(r() * 6));
      for (let row = 0; row < 3; row++) px(1, row * 2 + 1, lens[(row + frame) % lens.length]!, 1, '#9aa5b1');
      px(1, 7, 1, 1, '#7ee787'); // prompt
      if (frame % 2 === 0) px(3, 7, 1, 1, '#e6edf3'); // cursor
      break;
    }
    case 'wait': {
      px(0, 0, SCREEN_W, SCREEN_H, '#0f1626');
      const ring: Array<[number, number]> = [
        [4, 2],
        [5, 2],
        [6, 3],
        [6, 4],
        [5, 5],
        [4, 5],
        [3, 4],
        [3, 3],
      ];
      ring.forEach(([x, y], i) => {
        const d = (frame - i + ring.length * 4) % ring.length;
        px(x, y, 1, 1, d === 0 ? '#ffffff' : d === 1 ? '#79c0ff' : d === 2 ? '#3a5a8a' : '#1f2a44');
      });
      break;
    }
    case 'busy':
      px(0, 0, SCREEN_W, SCREEN_H, '#0f1626');
      px(1, 4, 8, 1, '#1f2a44');
      px(1 + (frame % 6), 4, 3, 1, '#79c0ff');
      break;
  }
  return c;
}

export function drawChair(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 18);
  px(5, 9, 6, 5, '#5b6b8c'); // backrest (seen from behind), low so the shirt stays visible
  px(5, 9, 6, 1, '#7d8fb3');
  px(6, 10, 4, 3, '#4e5d7c');
  px(4, 13, 8, 2, '#3f4a63'); // seat edge
  px(7, 15, 2, 2, '#55586a'); // gas lift
  px(3, 17, 10, 1, '#2a2c38'); // star base
  outline(ctx, TILE, 18);
  return c;
}

export function drawPlant(frame: number): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 24);
  const sway = frame % 2;
  px(4, 17, 8, 6, '#b5651d');
  px(4, 17, 8, 1, '#d98a3a');
  px(5, 22, 6, 1, '#8a4a16');
  px(5, 16, 6, 1, '#3d2b1f');
  const leaf = (x: number, y: number, w: number, h: number, col: string) => px(x + (y < 10 ? sway : 0), y, w, h, col);
  leaf(6, 2, 3, 6, '#5ac46a');
  leaf(3, 6, 4, 4, '#3e9e4f');
  leaf(9, 5, 4, 5, '#3e9e4f');
  leaf(2, 10, 4, 5, '#2f8240');
  leaf(10, 10, 4, 5, '#2f8240');
  leaf(5, 9, 6, 7, '#47ad58');
  leaf(7, 3, 1, 4, '#8fe39b');
  leaf(4, 7, 1, 2, '#72d07f');
  outline(ctx, TILE, 24);
  return c;
}

export function drawCooler(frame: number): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 28);
  px(5, 1, 6, 9, '#8fd0ff');
  px(6, 2, 2, 6, '#d2eeff');
  px(5, 9, 6, 1, '#6aa8d6');
  if (frame % 2) px(9, 4 + (frame % 4), 1, 1, '#ffffff');
  px(4, 10, 8, 16, '#e8ecf2');
  px(4, 10, 8, 1, '#ffffff');
  px(10, 11, 2, 15, '#c9cfd9');
  px(5, 14, 2, 2, '#4f8cff');
  px(8, 14, 2, 2, '#ff5c5c');
  px(5, 19, 6, 1, '#c5ccd6');
  outline(ctx, TILE, 28);
  return c;
}

export function drawBookshelf(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 30);
  px(1, 1, 14, 28, '#7a5235');
  px(1, 1, 14, 1, '#9a6b47');
  const books = ['#c0392b', '#2e86c1', '#d4ac0d', '#239b56', '#7d3c98', '#e5e7e9', '#ca6f1e', '#1f618d'];
  const r = rng(99);
  for (const y of [3, 11, 19]) {
    px(2, y, 12, 7, '#4a301e');
    let x = 2;
    while (x < 14) {
      const w = r() > 0.7 ? 2 : 1;
      const h = 5 + Math.floor(r() * 2);
      const col = books[Math.floor(r() * books.length)]!;
      px(x, y + 7 - h, w, h, col);
      px(x, y + 7 - h, w, 1, shade(col, 0.3));
      x += w;
    }
    px(1, y + 7, 14, 1, '#9a6b47');
  }
  outline(ctx, TILE, 30);
  return c;
}

export function drawCouch(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 20);
  px(0, 4, 16, 8, '#4f7f8f');
  px(0, 4, 16, 1, '#6a9cad');
  px(0, 11, 16, 6, '#5d93a5');
  px(0, 11, 16, 1, '#7db3c4');
  px(8, 5, 1, 6, '#41707f');
  px(1, 17, 2, 2, '#3a2a20');
  px(13, 17, 2, 2, '#3a2a20');
  px(3, 7, 4, 3, '#e8c15f'); // cushion
  outline(ctx, TILE, 20);
  return c;
}

export function drawPrinter(frame: number): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 20);
  px(1, 7, 14, 11, '#c5ccd6');
  px(1, 7, 14, 2, '#e8ecf2');
  px(3, 3, 10, 5, '#fbfbf7');
  px(4, 4, 6, 1, '#b8bec9');
  px(3, 12, 10, 2, '#8e97a5');
  px(11, 10, 2, 1, frame % 2 ? '#38c172' : '#1f6b3f');
  px(2, 18, 2, 2, '#4a4f5c');
  px(12, 18, 2, 2, '#4a4f5c');
  outline(ctx, TILE, 20);
  return c;
}

export function drawLamp(on: boolean): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 30);
  px(4, 1, 8, 6, on ? '#ffe9a8' : '#e9dcc0');
  px(4, 1, 8, 1, on ? '#fff6d6' : '#f5ecd9');
  px(5, 6, 6, 1, '#c9b48a');
  px(7, 7, 2, 20, '#4a4f5c');
  px(4, 27, 8, 2, '#3a3f4f');
  outline(ctx, TILE, 30);
  return c;
}

export function drawBoard(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, TILE);
  px(1, 2, 14, 12, '#a87b4f');
  px(2, 3, 12, 10, '#d4ac7c');
  px(3, 4, 3, 3, '#fff176');
  px(7, 4, 3, 3, '#80deea');
  px(11, 5, 2, 3, '#ffab91');
  px(4, 8, 3, 3, '#a5d6a7');
  px(8, 9, 4, 2, '#fff176');
  px(4, 4, 1, 1, '#c0392b');
  px(8, 4, 1, 1, '#c0392b');
  outline(ctx, TILE, TILE);
  return c;
}

/** Restroom stall seen from the front; the sign turns red while occupied. */
export function drawToilet(occupied: boolean): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 30);
  px(0, 2, 16, 27, '#cfd8dc'); // partition
  px(0, 2, 16, 1, '#eceff1');
  px(0, 2, 1, 27, '#b0bec5');
  px(15, 2, 1, 27, '#90a4ae');
  px(3, 8, 10, 21, occupied ? '#6d8fa8' : '#81a4bd'); // door
  px(3, 8, 10, 1, '#a8c4d8');
  px(11, 18, 1, 2, '#eceff1'); // handle
  px(4, 3, 8, 4, occupied ? '#c62828' : '#2e7d32'); // sign: red = occupied, green = free
  px(6, 4, 1, 2, '#ffffff'); // little figures
  px(9, 4, 1, 2, '#ffffff');
  px(7, 6, 2, 1, occupied ? '#ff5252' : '#69f0ae'); // occupied light
  px(3, 28, 10, 1, '#78909c');
  outline(ctx, TILE, 30);
  return c;
}

/** Coffee machine on a counter; `espresso` draws the upgraded espresso machine (same size and anchor). */
export function drawCoffeeMachine(frame: number, busy: boolean, espresso = false): HTMLCanvasElement {
  if (espresso) return drawEspressoMachine(frame, busy);
  const [c, ctx, px] = canvas(TILE, 28);
  px(0, 14, 16, 13, '#8c5f3e'); // counter
  px(0, 14, 16, 2, '#b9875c');
  px(2, 18, 12, 1, '#7d5436');
  px(7, 21, 2, 1, '#c7a17a');
  px(3, 3, 10, 11, '#3a3f4b'); // machine
  px(3, 3, 10, 2, '#5a6070');
  px(5, 6, 6, 2, '#1f232b');
  px(10, 6, 1, 1, busy ? '#ff5252' : '#69f0ae');
  px(6, 9, 4, 1, '#22262e'); // spout
  px(6, 11, 4, 3, '#f5f5f5'); // cup
  px(6, 11, 4, 1, '#6b3f22');
  if (busy) {
    const off = frame % 2;
    px(6 + off, 0, 1, 2, '#e8eef5');
    px(9 - off, 1, 1, 2, '#e8eef5');
  }
  outline(ctx, TILE, 28);
  return c;
}

function drawEspressoMachine(frame: number, busy: boolean): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 28);
  px(0, 14, 16, 13, '#8c5f3e'); // counter (as the plain machine)
  px(0, 14, 16, 2, '#b9875c');
  px(2, 18, 12, 1, '#7d5436');
  px(7, 21, 2, 1, '#c7a17a');
  px(2, 3, 12, 2, '#c0392b'); // red cup warmer on top
  px(2, 3, 12, 1, '#e05a49');
  px(2, 5, 12, 8, '#c9ced8'); // chrome body
  px(3, 5, 1, 8, '#eef1f6');
  px(12, 5, 2, 8, '#9aa1ae');
  px(7, 5, 2, 2, '#f5f5f5'); // pressure gauge
  px(8, 5, 1, 1, '#3a3f4b');
  px(11, 7, 1, 1, busy ? '#ff5252' : '#69f0ae');
  px(3, 8, 1, 4, '#59606e'); // steam wand
  px(5, 8, 4, 1, '#59606e'); // group head
  px(5, 9, 4, 1, '#3a3f4b'); // portafilter with its handle
  px(9, 9, 4, 1, '#1c1f27');
  px(6, 11, 3, 2, '#f5f5f5'); // espresso cup
  px(6, 11, 3, 1, '#b07a4a');
  px(3, 13, 10, 1, '#59606e'); // drip tray
  if (busy) {
    const off = frame % 2;
    px(7, 10, 1, 1, '#6b3f22'); // pouring shot
    px(5 + off, 0, 1, 2, '#e8eef5');
    px(10 - off, 1, 1, 2, '#e8eef5');
  }
  outline(ctx, TILE, 28);
  return c;
}

export function drawDoormat(): HTMLCanvasElement {
  const [c, , px] = canvas(TILE, TILE);
  px(1, 3, 14, 11, '#6e3f25');
  px(2, 4, 12, 9, '#8f5a33');
  for (let x = 3; x < 13; x += 2) px(x, 5, 1, 7, '#7a4a2a');
  return c;
}

/** Soft radial light used for monitor glow, lamps and windows (additive blend). */
export function drawLight(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// --- bubbles

export const BUBBLE_W = 13;
export const BUBBLE_H = 11;

export type BubbleKind =
  | 'permission'
  | 'question'
  | 'done'
  | 'failed'
  | 'stale'
  | 'unknown'
  | 'thinking'
  | 'chat_coffee'
  | 'chat_music'
  | 'chat_heart'
  | 'chat_laugh'
  | 'chat_idea'
  | 'chat_sun'
  | 'chat_moon'
  | 'chat_dots';

const GLYPHS: Record<BubbleKind, [string[], string]> = {
  permission: [['..X..', '..X..', '..X..', '.....', '..X..'], '#e67e22'],
  question: [['.XXX.', '....X', '..XX.', '.....', '..X..'], '#c99a06'],
  done: [['....X', '...X.', 'X.X..', '.X...', '.....'], '#27ae60'],
  failed: [['X...X', '.X.X.', '..X..', '.X.X.', 'X...X'], '#c0392b'],
  stale: [['.....', '.....', '.....', '.....', 'X.X.X'], '#7f8c8d'],
  unknown: [['.XXX.', '....X', '..XX.', '.....', '..X..'], '#7f8c8d'],
  thinking: [['.....', '.....', 'X.X.X', '.....', '.....'], '#3a6ad1'],
  chat_coffee: [['.X.X.', '.....', 'XXXX.', 'XXX.X', '.XX..'], '#7a4a2a'],
  chat_music: [['..XXX', '..X.X', '..X.X', 'XX.XX', 'XX.XX'], '#5c6bff'],
  chat_heart: [['.X.X.', 'XXXXX', 'XXXXX', '.XXX.', '..X..'], '#e0245e'],
  chat_laugh: [['.....', '.X.X.', '.....', 'X...X', '.XXX.'], '#d68910'],
  chat_idea: [['.XXX.', 'X...X', '.X.X.', '..X..', '..X..'], '#d4ac0d'],
  chat_sun: [['X.X.X', '.XXX.', 'XXXXX', '.XXX.', 'X.X.X'], '#f39c12'],
  chat_moon: [['.XXX.', 'XX...', 'XX...', 'XX...', '.XXX.'], '#5d6d7e'],
  chat_dots: [['.....', '.....', 'X.X.X', '.....', '.....'], '#7f8c8d'],
};

export function drawBubble(kind: BubbleKind): HTMLCanvasElement {
  const [c, ctx, px] = canvas(BUBBLE_W, BUBBLE_H);
  const bg = kind === 'unknown' || kind === 'stale' ? '#dfe4ea' : '#ffffff';
  px(2, 1, 9, 7, bg);
  px(1, 2, 11, 5, bg);
  px(5, 8, 3, 1, bg);
  px(6, 9, 1, 1, bg);
  const [rows, color] = GLYPHS[kind];
  rows.forEach((r, y) => [...r].forEach((ch, x) => ch === 'X' && px(4 + x, 2 + y, 1, 1, color)));
  outline(ctx, BUBBLE_W, BUBBLE_H);
  return c;
}

/**
 * Style of SIMULATED speech (local template lines from dialogue.ts): pale lavender with a
 * dashed border, deliberately unlike the white status bubbles, so it can never be mistaken
 * for real agent output. Pair it with a "simulated" legend.
 */
export const SIM_SPEECH_STYLE = { fill: '#f1ecff', border: '#6b5fa8', text: '#2f2752' } as const;

/** Background for a simulated speech line: `width` x `height` box plus a 3px tail below. */
export function drawSpeechBubble(width: number, height: number): HTMLCanvasElement {
  const w = Math.max(12, Math.round(width));
  const h = Math.max(8, Math.round(height));
  const [c, , px] = canvas(w, h + 3);
  const { fill, border } = SIM_SPEECH_STYLE;
  px(1, 1, w - 2, h - 2, fill);
  for (let x = 1; x < w - 1; x++)
    if (x % 3 !== 2) {
      px(x, 0, 1, 1, border); // dashed border
      px(x, h - 1, 1, 1, border);
    }
  for (let y = 1; y < h - 1; y++)
    if (y % 3 !== 2) {
      px(0, y, 1, 1, border);
      px(w - 1, y, 1, 1, border);
    }
  const m = Math.floor(w / 2);
  px(m - 1, h - 1, 3, 1, fill); // tail
  px(m, h, 1, 1, fill);
  px(m - 2, h - 1, 1, 1, border);
  px(m + 2, h - 1, 1, 1, border);
  px(m - 1, h, 1, 1, border);
  px(m + 1, h, 1, 1, border);
  px(m, h + 1, 1, 1, border);
  return c;
}

// --- office coins (game layer)

/** A gold office coin (7x7). */
export function drawCoin(): HTMLCanvasElement {
  const [c, , px] = canvas(7, 7);
  const rim = '#b7801a';
  px(2, 0, 3, 1, rim);
  px(1, 1, 5, 5, '#f2c230');
  px(0, 2, 7, 3, '#f2c230');
  px(2, 6, 3, 1, rim);
  for (const [x, y] of [
    [1, 1],
    [5, 1],
    [1, 5],
    [5, 5],
  ] as const)
    px(x, y, 1, 1, rim);
  px(0, 2, 1, 3, rim);
  px(6, 2, 1, 3, rim);
  px(2, 2, 1, 2, '#fff4b8');
  px(3, 2, 1, 3, '#c99a1c');
  return c;
}

/** Desk upgrades bought with office coins (bottom-anchored, 1px outline margin). */
export function drawDeskPlant(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(7, 9);
  px(2, 5, 3, 3, '#b5651d');
  px(2, 5, 3, 1, '#cf7d33');
  px(3, 1, 1, 4, '#3f9d4a');
  px(1, 2, 2, 2, '#57b85f');
  px(4, 1, 2, 2, '#57b85f');
  px(4, 3, 2, 1, '#3f9d4a');
  outline(ctx, 7, 9, '#1f3a22');
  return c;
}

export function drawRubberDuck(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(7, 6);
  px(1, 2, 5, 3, '#ffd83d');
  px(3, 1, 2, 2, '#ffd83d');
  px(5, 2, 1, 1, '#ff8a1f');
  px(4, 1, 1, 1, '#1a1a1a');
  px(1, 2, 1, 1, '#f2c230');
  outline(ctx, 7, 6, '#7a5a10');
  return c;
}

export function drawDeskLamp(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(7, 11);
  px(1, 9, 4, 1, '#3a4050');
  px(2, 4, 1, 5, '#59606e');
  px(2, 3, 3, 1, '#59606e');
  px(3, 1, 3, 3, '#e05d44');
  px(4, 3, 2, 1, '#fff2a8');
  outline(ctx, 7, 11, '#1d1f26');
  return c;
}

export function drawPhotoFrame(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(7, 7);
  px(1, 1, 5, 5, '#8c5f3e');
  px(2, 2, 3, 3, '#9fd3ff');
  px(2, 4, 3, 1, '#57b85f');
  px(4, 2, 1, 1, '#ffe066');
  outline(ctx, 7, 7, '#3b2618');
  return c;
}

// --- shared office upgrades (game layer)

export const ARCADE_FRAMES = 4;

/** Arcade cabinet (16x30, bottom-anchored like the bookshelf): marquee, animated screen, joystick and buttons. */
export function drawArcade(frame: number): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 30);
  const f = ((frame % ARCADE_FRAMES) + ARCADE_FRAMES) % ARCADE_FRAMES;
  const body = '#5b3a9e';
  const side = '#35205e';
  px(2, 1, 12, 4, side); // marquee
  px(3, 2, 10, 2, '#ffd166');
  px(3, 2, 10, 1, '#fff2b0');
  for (const x of [4, 7, 10]) px(x, 3, 2, 1, '#e0245e');
  px(2, 5, 12, 9, body); // upper cabinet
  px(2, 5, 1, 9, '#7a56c4');
  px(13, 5, 1, 9, side);
  px(3, 5, 10, 8, '#1c1f27'); // bezel
  px(4, 6, 8, 6, '#0b1630'); // screen
  // A tiny invaders game: two rows of aliens sway, the ship moves and fires.
  px(4, 6, 1 + f, 1, '#ffd166'); // score
  const sway = f === 1 || f === 2 ? 1 : 0;
  for (let i = 0; i < 2; i++) {
    px(5 + sway + i * 4, 7, 2, 1, '#7ee787');
    px(4 + (1 - sway) + i * 4, 8, 2, 1, '#d2a8ff');
  }
  const ship = [5, 6, 8, 7][f]!;
  px(ship, 11, 3, 1, '#79c0ff');
  px(ship + 1, 10, 1, 1, '#79c0ff');
  if (f > 0) px(ship + 1, 10 - f, 1, 1, '#fff2a8');
  px(1, 14, 14, 1, '#8a68d1'); // control panel
  px(1, 15, 14, 1, '#6d4bb3');
  px(1, 16, 14, 1, '#3f2870');
  px(4, 12, 2, 2, '#e05d44'); // joystick knob
  px(4, 12, 1, 1, '#ff8a75');
  px(8, 14, 2, 1, '#5ad1ff'); // buttons
  px(11, 14, 2, 1, '#ffd166');
  px(2, 17, 12, 10, body); // lower cabinet
  px(2, 17, 1, 10, '#7a56c4');
  px(13, 17, 1, 10, side);
  px(5, 19, 6, 5, '#2a2c38'); // coin door with lit slots
  px(7, 20, 2, 1, '#ffb347');
  px(7, 22, 2, 1, '#ffb347');
  px(3, 25, 10, 1, '#ff5c8a'); // side-art stripe
  px(2, 27, 12, 2, '#1c1f27'); // kick plate
  outline(ctx, TILE, 30);
  return c;
}

/** A closed wooden shipping crate (16x26, bottom-anchored): an arcade the office fund has not unlocked yet. */
export function drawCrate(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(TILE, 26);
  const post = '#9a6a3c';
  px(3, 3, 10, 20, '#c8955a'); // slats
  for (const y of [3, 8, 13, 18]) px(3, y, 10, 1, '#deb07a');
  for (const y of [7, 12, 17]) px(3, y, 10, 1, '#7a5230');
  for (let i = 0; i < 10; i++) px(3 + i, 21 - i * 2, 2, 2, post); // diagonal brace
  px(1, 1, 2, 24, post); // frame
  px(13, 1, 2, 24, post);
  px(1, 1, 14, 2, post);
  px(1, 23, 14, 2, post);
  px(1, 1, 14, 1, '#b5824f');
  for (const [x, y] of [
    [2, 2],
    [13, 2],
    [2, 23],
    [13, 23],
  ] as const)
    px(x, y, 1, 1, '#7d8597'); // nails
  px(6, 4, 1, 1, '#5a3a22'); // "this side up" arrow
  px(5, 5, 3, 1, '#5a3a22');
  px(4, 6, 5, 1, '#5a3a22');
  px(6, 7, 1, 2, '#5a3a22');
  px(9, 15, 4, 3, '#f1ece0'); // shipping label
  px(10, 16, 2, 1, '#8a8f9c');
  outline(ctx, TILE, 26, '#3b2618');
  return c;
}

/** A gold crown (7x5 plus a 1px outline margin) for the top earner's head, bottom-anchored. */
export function drawCrown(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(9, 7);
  const gold = '#f2c230';
  px(1, 1, 1, 1, gold); // points
  px(4, 1, 1, 1, '#fff4b8');
  px(7, 1, 1, 1, gold);
  px(1, 2, 2, 1, gold);
  px(4, 2, 1, 1, gold);
  px(6, 2, 2, 1, gold);
  px(1, 3, 7, 2, gold); // band
  px(1, 3, 7, 1, '#ffe27a');
  px(2, 4, 1, 1, '#e0245e'); // gems
  px(4, 4, 1, 1, '#5ad1ff');
  px(6, 4, 1, 1, '#e0245e');
  px(1, 5, 7, 1, '#c99a1c');
  outline(ctx, 9, 7, '#6b4a10');
  return c;
}

/** An open pizza box with a pizza (12x8 plus a 1px outline margin), bottom-anchored on a table top. */
export function drawPizzaBox(): HTMLCanvasElement {
  const [c, ctx, px] = canvas(14, 10);
  px(1, 1, 12, 3, '#c9a36a'); // open lid at the back
  px(2, 2, 10, 2, '#e8cf9f');
  px(5, 2, 4, 1, '#c0392b'); // logo
  px(1, 4, 12, 5, '#c9a36a'); // box
  px(2, 4, 10, 4, '#e8d3a8');
  px(1, 8, 12, 1, '#a8834f');
  px(4, 4, 6, 1, '#d08a3a'); // crust
  px(3, 5, 8, 2, '#d08a3a');
  px(4, 7, 6, 1, '#d08a3a');
  px(4, 5, 6, 2, '#f6c945'); // cheese
  px(8, 6, 2, 1, '#e8d3a8'); // a slice already gone
  px(10, 6, 1, 1, '#e8d3a8');
  px(5, 5, 1, 1, '#c0392b'); // pepperoni and basil
  px(8, 5, 1, 1, '#c0392b');
  px(6, 6, 1, 1, '#c0392b');
  px(7, 5, 1, 1, '#3f9d4a');
  outline(ctx, 14, 10, '#5a3d1f');
  return c;
}
