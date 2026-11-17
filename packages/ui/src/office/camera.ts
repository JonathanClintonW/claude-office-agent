/**
 * Camera math for the office scene (pure, no rendering). The camera is the world point (in
 * world pixels, 16 per tile) shown at the centre of the view, plus a zoom factor.
 */

export interface Size {
  w: number;
  h: number;
}

export interface Vec {
  x: number;
  y: number;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Allowed zoom levels. From 1× up, whole steps make every art pixel an exact square of
 * screen pixels; half steps above 2× stay within one screen pixel of square (as the original
 * fit did). 0.5× and 0.75× exist only to overview big offices in small panes.
 */
export const ZOOM_STEPS: readonly number[] = [0.5, 0.75, 1, 2, 2.5, 3, 3.5, 4, 5, 6, 8];
export const MIN_ZOOM = ZOOM_STEPS[0]!;
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
/** Screen pixels the office may be dragged past the view edge. */
export const OVERSCROLL = 48;
/** Screen pixels per arrow-key press. */
export const KEY_PAN = 64;
/** Pointer travel (screen px) before a press becomes a drag instead of a click. */
export const DRAG_THRESHOLD = 4;

/** The zoom step closest to `z`. */
export function snapZoom(z: number): number {
  let best = ZOOM_STEPS[0]!;
  for (const s of ZOOM_STEPS) if (Math.abs(s - z) < Math.abs(best - z)) best = s;
  return best;
}

/** Next zoom step in a direction (+1 in, -1 out); stays at the ends. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > zoom + 1e-6) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((s) => s < zoom - 1e-6) ?? MIN_ZOOM;
}

/**
 * Zoom at which the whole world fits in the view (with a small margin), using the original
 * office fit: half steps from 2× up, quarter steps below (never under 0.5×), so the initial
 * view fills the pane as before. The +/- controls then move through ZOOM_STEPS.
 */
export function fitZoom(world: Size, view: Size, margin = 12): number {
  const raw = Math.min((view.w - margin * 2) / world.w, (view.h - margin * 2) / world.h);
  const z = raw >= 2 ? Math.floor(raw * 2 + 1e-6) / 2 : Math.max(MIN_ZOOM, Math.floor(raw * 4 + 1e-6) / 4);
  return Math.min(z, MAX_ZOOM);
}

function clampAxis(c: number, worldLen: number, viewLen: number, zoom: number): number {
  const half = viewLen / 2 / zoom;
  const pad = OVERSCROLL / zoom;
  if (worldLen <= 2 * half) {
    // The world fits along this axis: keep it centred, allowing only the overscroll.
    const mid = worldLen / 2;
    return Math.min(Math.max(c, mid - pad), mid + pad);
  }
  return Math.min(Math.max(c, half - pad), worldLen - half + pad);
}

/** Keep the office on screen. */
export function clampCamera(cam: Camera, world: Size, view: Size): Camera {
  const zoom = Math.min(Math.max(cam.zoom, MIN_ZOOM), MAX_ZOOM);
  return { zoom, x: clampAxis(cam.x, world.w, view.w, zoom), y: clampAxis(cam.y, world.h, view.h, zoom) };
}

/** Whole office centred at the largest zoom step that fits. */
export function fitCamera(world: Size, view: Size): Camera {
  return { x: world.w / 2, y: world.h / 2, zoom: fitZoom(world, view) };
}

/** Root container transform for a camera. Offsets are whole pixels so art stays crisp. */
export function rootTransform(cam: Camera, view: Size): { x: number; y: number; scale: number } {
  return { x: Math.round(view.w / 2 - cam.x * cam.zoom), y: Math.round(view.h / 2 - cam.y * cam.zoom), scale: cam.zoom };
}

export function worldToScreen(cam: Camera, view: Size, p: Vec): Vec {
  const t = rootTransform(cam, view);
  return { x: t.x + p.x * cam.zoom, y: t.y + p.y * cam.zoom };
}

export function screenToWorld(cam: Camera, view: Size, p: Vec): Vec {
  const t = rootTransform(cam, view);
  return { x: (p.x - t.x) / cam.zoom, y: (p.y - t.y) / cam.zoom };
}

/** Change zoom while keeping the world point under `anchor` (screen px) fixed. */
export function zoomAt(cam: Camera, zoom: number, anchor: Vec, world: Size, view: Size): Camera {
  const z = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
  const wx = cam.x + (anchor.x - view.w / 2) / cam.zoom;
  const wy = cam.y + (anchor.y - view.h / 2) / cam.zoom;
  return clampCamera({ zoom: z, x: wx - (anchor.x - view.w / 2) / z, y: wy - (anchor.y - view.h / 2) / z }, world, view);
}

/** Drag the office by a screen-space delta (content follows the pointer). */
export function panBy(cam: Camera, dx: number, dy: number, world: Size, view: Size): Camera {
  return clampCamera({ ...cam, x: cam.x - dx / cam.zoom, y: cam.y - dy / cam.zoom }, world, view);
}

/** Centre the view on a world point, optionally at a new zoom. */
export function centerOn(cam: Camera, p: Vec, world: Size, view: Size, zoom = cam.zoom): Camera {
  return clampCamera({ zoom, x: p.x, y: p.y }, world, view);
}

/** The world rectangle currently visible. */
export function visibleRect(cam: Camera, view: Size): Rect {
  const w = view.w / cam.zoom;
  const h = view.h / cam.zoom;
  return { x: cam.x - w / 2, y: cam.y - h / 2, w, h };
}

/** Whether a world point is inside the view, `margin` screen px in from the edges. */
export function isVisible(cam: Camera, view: Size, p: Vec, margin = 0): boolean {
  const s = worldToScreen(cam, view, p);
  return s.x >= margin && s.y >= margin && s.x <= view.w - margin && s.y <= view.h - margin;
}

/** Ease the camera towards a goal; returns the goal itself once close enough. */
export function approach(cam: Camera, goal: Camera, dtMs: number): Camera {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / 90);
  const next = { x: cam.x + (goal.x - cam.x) * k, y: cam.y + (goal.y - cam.y) * k, zoom: goal.zoom };
  return Math.abs(next.x - goal.x) * goal.zoom < 0.5 && Math.abs(next.y - goal.y) * goal.zoom < 0.5 ? goal : next;
}

export type CameraKeyAction = { type: 'pan'; dx: number; dy: number } | { type: 'zoom'; dir: 1 | -1 } | { type: 'fit' };

/** Keyboard shortcuts for the office view. */
export function keyAction(key: string): CameraKeyAction | undefined {
  switch (key) {
    case 'ArrowLeft':
      return { type: 'pan', dx: KEY_PAN, dy: 0 };
    case 'ArrowRight':
      return { type: 'pan', dx: -KEY_PAN, dy: 0 };
    case 'ArrowUp':
      return { type: 'pan', dx: 0, dy: KEY_PAN };
    case 'ArrowDown':
      return { type: 'pan', dx: 0, dy: -KEY_PAN };
    case '+':
    case '=':
      return { type: 'zoom', dir: 1 };
    case '-':
    case '_':
      return { type: 'zoom', dir: -1 };
    case '0':
      return { type: 'fit' };
    default:
      return undefined;
  }
}

/** Accumulates wheel deltas so trackpads (many small deltas) and mice (one big notch) step alike. */
export class WheelZoom {
  private acc = 0;
  private last = 0;
  constructor(private readonly notch = 50) {}

  /** Returns a zoom direction once enough delta accumulated, else 0. */
  push(deltaY: number, deltaMode: number, now: number): 1 | -1 | 0 {
    if (now - this.last > 400) this.acc = 0;
    this.last = now;
    this.acc += deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
    if (Math.abs(this.acc) < this.notch) return 0;
    const dir = this.acc < 0 ? 1 : -1;
    this.acc = 0;
    return dir;
  }
}
