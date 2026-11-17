import 'pixi.js/unsafe-eval'; // CSP-safe (no eval) for VS Code webviews
import { Application, CanvasSource, Container, Graphics, Rectangle, Sprite, Text, Texture, type FederatedPointerEvent } from 'pixi.js';
import { STATUS_META, TERMINAL_STATUSES, WALL_ROWS, roomContains, type AgentKind, type AgentStatus, type OfficeLayout, type Room, type RoomKind } from '@agent-office/core';
import { assignDesks, assignSlots, key as tileKey, loungeSpots, planRoute, ProgressWatch, roomAt, seatsOf, walkable, type Assignable, type Point, type Seat } from './grid';
import { cueForStatus, type SfxKind } from '../audio/cues';
import type { SoundSink } from '../audio/engine';
import type { Actor, BehaviorProvider, Directive } from './behavior';
import type { CollabVisual } from './collab';
import type { DialogueFacts } from './dialogue';
import { resolveDirectives, restPhase, type ArbiterActor, type Claim, type Resolved } from './directives';
import { DEFAULT_DIRECTOR_OPTIONS, IdleDirector } from './idleLife';
import { DEFAULT_MEETING_OPTIONS, MeetingScheduler, type MeetingInfo, type MeetingKind, type MeetingPhase, type SocialTopic } from './meetings';
import { idleDeskPose, idleStandPose, seatedFrame, spritePose, workPresentation, type WorkInput, type WorkPresentation } from './poses';
import { TeamworkProvider } from './teamwork';
import { DEFAULT_VISITOR_OPTIONS, VisitorDirector, type MeetingRequest, type VisitorBody, type VisitorDirective } from './visitors';
import { buildWorld, chairFacing, destinationTiles, type OfficeWorld } from './world';
import {
  approach,
  centerOn,
  clampCamera,
  DRAG_THRESHOLD,
  fitCamera,
  isVisible,
  panBy,
  rootTransform,
  stepZoom,
  visibleRect,
  WheelZoom,
  zoomAt,
  type Camera,
  type Rect,
  type Size,
  type Vec,
} from './camera';
import {
  consoleTheme,
  drawBookStack,
  drawConsole,
  drawFloorMap,
  drawInteriorWall,
  drawMeetingChair,
  drawNoticeboard,
  drawPresentationScreen,
  drawQaLamp,
  drawReceptionDesk,
  drawServerRack,
  drawSnackMachine,
  drawTable,
  drawWhiteboard,
  E as EAST,
  maskOf,
  qaLampState,
  ROOM_STYLE,
  S as SOUTH,
  W as WEST,
} from './roomArt';
import { departmentFor } from '../departments';
import type { DepartmentRule } from '../settings';
import {
  BUBBLE_H,
  CHAR_H,
  drawBoard,
  drawBookshelf,
  drawBubble,
  drawChair,
  drawCoffeeMachine,
  drawCharacter,
  drawCooler,
  drawCouch,
  drawDesk,
  drawDoormat,
  drawFloor,
  drawLamp,
  drawLight,
  drawMonitor,
  drawPlant,
  drawPrinter,
  drawScreen,
  drawToilet,
  drawWall,
  hash,
  lookFor,
  SCREEN_ANIMATION,
  SIM_SPEECH_STYLE,
  skyFor,
  drawSpeechBubble,
  TILE,
  visitorLook,
  type BubbleKind,
  type Look,
  type Pose,
  type ScreenKind,
  type Sky,
} from './pixelArt';

export interface WorkerView {
  key: string;
  name: string;
  status: AgentStatus;
  stale: boolean;
  kind: AgentKind;
  sessionId: string;
  parentKey?: string;
  cwd?: string;
  /** Observed agent type (subagents/teammates), used by local department rules. */
  agentType?: string;
  simulated: boolean;
  turnCompletedAt?: number;
  /** When the agent reached a terminal status (completed/ended). */
  terminalAt?: number;
  /** A tool is currently running (vs. the model thinking). */
  toolRunning?: boolean;
  /** Most recently finished tool, used to trigger success/failure effects. */
  lastToolEnd?: { id: string; ok: boolean };
  /** Reducer statusDetail, verbatim (e.g. 'Thinking'). */
  statusDetail?: string;
  /** Name and sanitized summary of the tool that is running right now. */
  toolName?: string;
  toolSummary?: string;
  /** Most recent failed tool call (kind by local rules) and whether nothing succeeded since. */
  failure?: { kind: 'test' | 'build' | 'tool'; at: number };
  failureOpen?: boolean;
  /** End of the most recent successful test-like command. */
  lastTestPassAt?: number;
  /** Observed span of the latest cluster of tool calls (lower bound). */
  lastWorkMs?: number;
}

export interface SceneCallbacks {
  onSelect(key: string | null): void;
  onBoardClick(): void;
  onTileClick(x: number, y: number): void;
  onItemMove(id: string, x: number, y: number): void;
  /** A click on the floor of a room (or outside any room: null). Not called in edit mode. */
  onRoomClick?(roomId: string | null): void;
}

/** What the mini-map needs, in tile units. */
export interface MiniMapState {
  zoom: number;
  view: Rect;
  workers: Array<{ key: string; x: number; y: number; status: AgentStatus; selected: boolean }>;
}

/** A simulated meeting in a room, for the room card (always simulated). */
export interface RoomMeeting {
  /** Held by idle agents (meetings.ts) or by simulated visitors (visitors.ts). */
  who: 'agents' | 'visitors';
  kind: MeetingKind;
  topic?: SocialTopic;
  phase: MeetingPhase;
  people: number;
  endsAt?: number;
}

export interface RoomOccupant {
  key: string;
  name: string;
  status: AgentStatus;
  simulated: boolean;
  /** Taking part in a simulated meeting or gathering right now (office animation, not real work). */
  inMeeting?: boolean;
}

type Phase = 'walking' | 'seated' | 'standing' | 'leaving';

/** What walking needs: agents' workers and simulated visitors move the same way. */
interface Walker {
  pos: { x: number; y: number };
  path: Point[];
  phase: Phase;
  arrive: Phase;
  target?: Point;
  facing: 'down' | 'up' | 'left' | 'right';
  /** Stuck detection for the current walk. */
  watch: ProgressWatch;
}

/** Simulated speech bubble (local template line), drawn in screen space. */
interface Speech {
  node: Container;
  box: Sprite;
  text: Text;
  line?: string;
}

/**
 * A simulated visitor's body (visitors.ts). Never an agent: it has no WorkerView, cannot be
 * selected, and stays out of the mini-map, room cards and agent lists.
 */
interface Guest extends Walker {
  id: string;
  lookKey: string;
  look: Look;
  offset: number;
  leaving: boolean;
  /** Current simulated activity, if any. */
  perform?: Extract<Directive, { type: 'do' }>;
  node: Container;
  sprite: Sprite;
  bubble: Sprite;
  /** "Visitor (simulated)", shown on hover or with names on. */
  label: Text;
  hovered: boolean;
  shownPose?: Pose;
  shownBubble?: BubbleKind;
  speech: Speech;
}

interface Worker {
  view: WorkerView;
  look: Look;
  lookKey: string;
  pos: { x: number; y: number };
  path: Point[];
  phase: Phase;
  arrive: Phase;
  target?: Point;
  deskId: string | null;
  facing: 'down' | 'up' | 'left' | 'right';
  offset: number;
  node: Container;
  sprite: Sprite;
  shadow: Graphics;
  /** Selection ring under the feet (drawn once; only its alpha animates). */
  ring: Graphics;
  bubble: Sprite;
  label: Text;
  hovered: boolean;
  /** What is on screen now, so textures and styles are only touched when they change. */
  shownPose?: Pose;
  shownBubble?: BubbleKind;
  shadowSeated?: boolean;
  labelFill?: string;
  /** View and time `pres` was computed for. */
  presView?: WorkerView;
  presAt: number;
  /** Stuck detection for the current walk. */
  watch: ProgressWatch;
  leaving: boolean;
  lastToolId?: string;
  lastStatus: AgentStatus;
  lastTurn?: number;
  /** Where the worker belongs (desk seat or lounge spot) and how it rests there. */
  home: Point;
  homeArrive: Phase;
  hurry: boolean;
  /** Current simulated activity (cosmetic), if any. */
  perform?: Extract<Directive, { type: 'do' }>;
  /** Desk presentation for the real state, computed once per frame. */
  pres?: WorkPresentation;
  /** Simulated speech bubble (local template line), drawn in screen space. */
  speech: Speech;
}

/** A paper / task card / check mark flying between two desks for a verified collaboration event. */
interface Flight {
  id: string;
  kind: CollabVisual['kind'];
  /** World pixels of the sender when the event was observed. */
  from: Vec;
  to: string;
  start: number;
  /** Sanitized task subject (handoffs), drawn above the card as real data. */
  detail?: string;
  label?: Text;
}

interface Desk {
  seat: Seat;
  screen: Sprite;
  glow: Sprite;
  variant: number;
  /** QA build lamp showing the seated agent's last real tool result. */
  lamp?: Sprite;
  /** Screen and lamp currently shown (textures are only swapped on change). */
  shownKind?: ScreenKind;
  shownFrame: number;
  shownLamp?: string;
}

/** A prop whose texture follows the state of a spot (restroom door sign, coffee machine). */
interface SpotProp {
  id: string;
  sprite: Sprite;
  /** Shown state: -1 idle, otherwise the busy animation frame. */
  shown: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: number;
  size: number;
  gravity: number;
}

type Labelled = Text & { tile?: Point };

const SPEED = 3.2; // tiles per second
const LINGER_COMPLETED_MS = 12_000;
const LINGER_ENDED_MS = 2_500;
const CELEBRATE_MS = 3_500;
const LABEL_FONT = '"Pixelify Sans", "Silkscreen", Consolas, monospace';
const BOTTOM_WALL = 6;

/** How dark it is; drives the strength of lamp, screen and prop glows. */
const DARKNESS: Record<Sky, number> = { day: 0, dawn: 0.2, dusk: 0.28, night: 0.48 };
/**
 * Ambient light, multiplied over the room. Multiplying scales each colour channel instead of
 * mixing in a flat dark wash, so the office keeps its colours after dark rather than turning
 * a muddy near-greyscale. The cool night tint still reads as night.
 */
const AMBIENT: Record<Sky, number> = { day: 0xffffff, dawn: 0xf2ded2, dusk: 0xdcc8d8, night: 0x9ca8d8 };
const SCREEN_LIGHT: Partial<Record<ScreenKind, number>> = {
  code: 0x5aa9ff,
  think: 0x5aa9ff,
  perm: 0xffa94d,
  ask: 0xffd54f,
  fail: 0xff4d4d,
  done: 0x5fd068,
  saver: 0x2a6fb0,
  noise: 0x9aa5b1,
  read: 0x8fc7ff,
  search: 0x79c0ff,
  edit: 0x5aa9ff,
  test: 0xb59cff,
  debug: 0xff8c5a,
  terminal: 0x6fd3a0,
  wait: 0x9aa5b1,
  busy: 0x5aa9ff,
};
/** Screens that use the desk's variant seed for their content. */
const SEEDED_SCREENS = new Set<ScreenKind>(['code', 'read', 'search', 'edit', 'terminal']);
/** Screens whose light flickers with on-screen activity. */
const FLICKER_SCREENS = new Set<ScreenKind>(['code', 'edit', 'terminal', 'busy']);
/** Real work at the keyboard: these desks feed the typing ambience. */
const TYPING_SCREENS = new Set<ScreenKind>(['code', 'edit', 'terminal']);
/** A failure is presented as "debugging" for this long unless something succeeded since. */
const RECENT_FAILURE_MS = 10 * 60_000;
const FLIGHT_MS = 1400;
const MAX_FLIGHTS = 24;
const SPEECH_FONT_SIZE = 11;
const SPEECH_MAX_W = 150;
/** Visitors stroll a little slower than agents walk. */
const VISITOR_PACE = 0.85;
const VISITOR_LABEL = 'Visitor (simulated)';

function tex(canvas: HTMLCanvasElement): Texture {
  return new Texture({ source: new CanvasSource({ resource: canvas, scaleMode: 'nearest' }) });
}

export class OfficeScene {
  private app = new Application();
  private ready = false;
  private destroyed = false;
  private backdrop = new Container();
  private root = new Container();
  private frameLayer = new Graphics();
  private floorLayer = new Container();
  private zoneLayer = new Container();
  private wallLayer = new Container();
  private shadowLayer = new Container();
  private items = new Container();
  private darkness = new Graphics();
  private lightLayer = new Container();
  private fxLayer = new Container();
  private fx = new Graphics();
  private editLayer = new Container();
  private overlay = new Container();
  private textures = new Map<string, Texture>();
  private floorKey?: string;
  private workers = new Map<string, Worker>();
  private assignment = new Map<string, string | null>();
  private layout?: OfficeLayout;
  private rooms: Room[] = [];
  private seats: Seat[] = [];
  private seatById = new Map<string, Seat>();
  private lounge: Point[] = [];
  /** Lounge tiles ("x,y"): homes of agents without a desk, kept out of the chat tiles. */
  private loungeKeys = new Set<string>();
  /** Stable lounge slot per agent without a desk. */
  private loungeOf = new Map<string, number>();
  private ok: (p: Point) => boolean = () => true;
  private desks = new Map<string, Desk>();
  /** Desk id -> worker shown at it, rebuilt every frame (reused map). */
  private occupied = new Map<string, Worker>();
  private animated: Array<{ sprite: Sprite; key: string; frames: number; ms: number; make: (f: number) => HTMLCanvasElement; offset: number; shown: number }> = [];
  private lamps: Array<{ sprite: Sprite; light: Sprite }> = [];
  private windowLights: Sprite[] = [];
  /** Lights of glowing props (screens, vending machine, consoles) shown when it is dark. */
  private propLights: Array<{ light: Sprite; strength: number }> = [];
  private clock?: Graphics;
  private clockAt?: Point;
  private boardBadge?: Text;
  private views: WorkerView[] = [];
  private firstReconcile = true;
  private selected: string | null = null;
  private showNames = false;
  private editMode = false;
  private resizeObserver?: ResizeObserver;
  private drag?: { id: string; from: Point; ghost: Graphics; moved: boolean };
  /** Pointer press on the floor/backdrop that may become a camera drag or a click. */
  private press?: { start: Vec; cam: Camera; moved: boolean; tile?: Point; pan: boolean };
  private lastReconcile = 0;
  private openTasks = 0;
  private zoneLabels: Labelled[] = [];
  private roomLabels: Labelled[] = [];
  private particles: Particle[] = [];
  private sky: Sky = skyFor(new Date().getHours());
  private lastClockDraw = -1;
  private hourOverride: number | null = null;
  /** Idle life uses the scene's hour (so a lighting override also drives time-of-day lines). */
  private director = new IdleDirector(Math.random, { ...DEFAULT_DIRECTOR_OPTIONS, hourOf: () => this.hour() });
  private meetings = new MeetingScheduler(Math.random, { ...DEFAULT_MEETING_OPTIONS, hourOf: () => this.hour() });
  /** Short animations of verified real collaboration events (spawn briefings, task handoffs). */
  private teamwork = new TeamworkProvider();
  /**
   * Behavior providers in priority order (highest first). Each tick, actors claimed by an
   * earlier provider are passed to later ones with `idle: false` (see behavior.ts):
   * verified-event interactions first, then simulated meetings and gatherings (so a gathering
   * is not undone by a coffee break), then idle life.
   */
  private behaviors: BehaviorProvider[] = [this.teamwork, this.meetings, this.director];
  /**
   * Simulated visitors (not agents) so the office has some life even without idle agents.
   * They run after the agents' providers and keep off every tile an agent uses or wants.
   */
  private visitors = new VisitorDirector(Math.random, { ...DEFAULT_VISITOR_OPTIONS, hourOf: () => this.hour() });
  private guests = new Map<string, Guest>();
  private visitorsWanted = true;
  /** Office sounds (music lives in the engine; the scene only sends cues and the activity level). */
  private sound: SoundSink | null = null;
  /** Spots in use at the previous behavior tick (coffee starts, restroom ends). */
  private spotBusyBefore = new Set<string>();
  private active = true;
  private flights: Flight[] = [];
  private seenFlights = new Set<string>();
  private behaviorsOn = true;
  private frequency = 1;
  private lastDirect = 0;
  private idleLife = true;
  private toilets: SpotProp[] = [];
  private coffees: SpotProp[] = [];
  /** Spots in use (restroom stalls, coffee machines), refreshed with the behaviors. */
  private spotBusy = new Set<string>();
  /** Second of the last clock/lighting check. */
  private lastSec = -1;
  /** Camera the overlay labels were last placed for. */
  private labelCam = { x: Number.NaN, y: Number.NaN, zoom: Number.NaN };
  /** The effects layer has something drawn that the next frame must clear. */
  private fxDirty = false;
  /** Reused per-frame pose result (no allocation per worker and frame). */
  private readonly po: { pose: Pose; flip: boolean; bubble?: BubbleKind; alpha: number } = { pose: 'stand', flip: false, alpha: 1 };
  // camera & display settings
  private cam: Camera = { x: 0, y: 0, zoom: 2 };
  private camGoal?: Camera;
  private camTouched = false;
  private viewSize: Size = { w: 640, h: 480 };
  private wheel = new WheelZoom();
  private fps: 15 | 30 | 60 = 60;
  private reduceMotion = false;
  private showRoomLabels = true;
  private rules: readonly DepartmentRule[] = [];
  private deptOf = new Map<string, string>();
  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const dir = this.wheel.push(e.deltaY, e.deltaMode, performance.now());
    if (!dir || !this.ready) return;
    const r = this.app.canvas.getBoundingClientRect();
    this.zoomStep(dir, { x: e.clientX - r.left, y: e.clientY - r.top });
  };
  private readonly onContextMenu = (e: Event) => e.preventDefault();

  constructor(
    private readonly host: HTMLElement,
    private readonly cb: SceneCallbacks,
  ) {}

  async init(): Promise<void> {
    try {
      await document.fonts?.load(`12px ${LABEL_FONT}`);
    } catch {
      /* fall back to system font */
    }
    await this.app.init({ width: 640, height: 480, backgroundAlpha: 0, antialias: false, roundPixels: true, resolution: 1, preference: 'webgl' });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    this.app.canvas.setAttribute('aria-hidden', 'true');
    this.app.canvas.style.imageRendering = 'pixelated';
    this.host.appendChild(this.app.canvas);
    this.items.sortableChildren = true;
    // Decorative layers must not take part in hit testing: under an interactive stage, any
    // non-interactive sprite that is hit would swallow clicks meant for workers below it.
    for (const l of [this.frameLayer, this.zoneLayer, this.shadowLayer, this.darkness, this.lightLayer, this.fxLayer, this.editLayer, this.overlay]) l.eventMode = 'none';
    this.fxLayer.addChild(this.fx);
    this.darkness.blendMode = 'multiply';
    this.root.addChild(this.frameLayer,this.floorLayer, this.zoneLayer, this.wallLayer, this.shadowLayer, this.items, this.darkness, this.lightLayer, this.fxLayer, this.editLayer);
    // The backdrop (whole view, behind the office) lets the camera be dragged from the margins.
    this.app.stage.addChild(this.backdrop, this.root, this.overlay);
    this.overlay.sortableChildren = true;
    this.app.stage.eventMode = 'static';
    this.backdrop.eventMode = 'static';
    this.backdrop.on('pointerdown', (e) => this.onBackdropDown(e));
    this.floorLayer.eventMode = 'static';
    this.floorLayer.on('pointerdown', (e) => this.onFloorDown(e));
    this.app.stage.on('pointermove', (e) => this.onFloorMove(e));
    this.app.stage.on('pointerup', (e) => this.onFloorUp(e));
    this.app.stage.on('pointerupoutside', (e) => this.onFloorUp(e));
    this.app.ticker.maxFPS = this.fps;
    this.app.ticker.add((t) => this.frame(t.deltaMS));
    if (!this.active) this.app.ticker.stop();
    this.host.addEventListener('wheel', this.onWheel, { passive: false });
    this.app.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.host);
    this.ready = true;
    if (this.layout) this.buildRoom();
    this.fit();
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.host.removeEventListener('wheel', this.onWheel);
    if (this.ready) {
      this.app.canvas.removeEventListener('contextmenu', this.onContextMenu);
      this.app.destroy(true, { children: true });
    }
    for (const t of this.textures.values()) t.destroy(true);
    this.textures.clear();
  }

  // ------------------------------------------------------------- public API

  setLayout(layout: OfficeLayout): void {
    if (this.layout && JSON.stringify(this.layout) === JSON.stringify(layout)) return;
    const resized = !this.layout || this.layout.cols !== layout.cols || this.layout.rows !== layout.rows;
    this.layout = layout;
    this.rooms = layout.rooms ?? [];
    this.seats = seatsOf(layout);
    this.seatById = new Map(this.seats.map((s) => [s.deskId, s]));
    this.ok = walkable(layout);
    // Agents without a desk wait where no activity, meeting seat or lounge chair sends anyone.
    this.lounge = loungeSpots(layout, destinationTiles(buildWorld(layout, [], false)));
    this.loungeKeys = new Set(this.lounge.map(tileKey));
    if (resized) this.camTouched = false;
    if (this.ready) {
      this.buildRoom();
      this.fit();
      this.reconcile(true);
      // Walls or furniture may now stand where leaving workers were headed: route them again.
      for (const w of this.workers.values()) if (w.leaving) this.walkTo(w, { x: layout.door.x, y: layout.rows }, 'leaving');
    }
  }

  setWorkers(views: WorkerView[]): void {
    this.views = views;
    if (this.ready && this.layout) this.reconcile(false);
  }

  setSelected(key: string | null): void {
    const changed = key !== this.selected;
    this.selected = key;
    // Selecting someone off-screen (e.g. from the agent list) brings them into view.
    const w = key ? this.workers.get(key) : undefined;
    if (changed && w && this.ready && !isVisible(this.cam, this.viewSize, this.workerWorldPos(w), 24)) this.focus(key!);
  }

  setShowNames(v: boolean): void {
    this.showNames = v;
  }

  /** Force the lighting to a given hour (preview/testing); null follows the local clock. */
  setHourOverride(hour: number | null): void {
    if (hour === this.hourOverride) return;
    this.hourOverride = hour;
    if (this.ready && this.layout) this.buildRoom();
  }

  private hour(): number {
    return this.hourOverride ?? new Date().getHours();
  }

  setOpenTasks(n: number): void {
    this.openTasks = n;
    if (this.boardBadge) this.boardBadge.text = n > 0 ? String(n) : '';
  }

  /** Idle agents take coffee breaks, chat, etc. Cosmetic; real status is unaffected. */
  setIdleLife(on: boolean): void {
    this.idleLife = on;
    this.updateBehaviorsEnabled();
  }

  /** Where sound cues go (null: silent, e.g. a history replay). */
  setSound(sink: SoundSink | null): void {
    this.sound = sink;
  }

  /** Play a cue, panned to where it happens on screen (world x in pixels). */
  private cue(kind: SfxKind, worldX?: number): void {
    if (!this.sound) return;
    let pan = 0;
    if (worldX !== undefined) {
      const sx = this.root.position.x + worldX * this.cam.zoom;
      pan = Math.max(-1, Math.min(1, (sx / Math.max(1, this.viewSize.w)) * 2 - 1)) * 0.7;
    }
    this.sound.play(kind, pan);
  }

  /** Simulated visitors walk through the office (settings.visitors; only while idle life is on). */
  setVisitors(on: boolean): void {
    this.visitorsWanted = on;
    this.updateBehaviorsEnabled();
  }

  setEditMode(on: boolean): void {
    this.editMode = on;
    this.updateBehaviorsEnabled();
    this.drawEditGrid();
    for (const w of this.workers.values()) w.node.eventMode = on ? 'none' : 'static';
    for (const g of this.guests.values()) g.node.eventMode = on ? 'none' : 'static';
  }

  /**
   * Plug in another (lower-priority) behavior provider, e.g. simulated meetings. Providers
   * are asked in the order added after the idle director unless `first` is set.
   */
  addBehaviorProvider(p: BehaviorProvider, first = false): void {
    if (this.behaviors.includes(p)) return;
    if (first) this.behaviors.unshift(p);
    else this.behaviors.push(p);
    p.setEnabled(this.behaviorsOn);
    p.setFrequency?.(this.frequency);
    if (this.layout && this.ready) p.setWorld(this.world(this.layout));
  }

  /** How often idle agents start simulated activities (settings.idleFrequency multiplier). */
  setIdleFrequency(multiplier: number): void {
    this.frequency = multiplier;
    for (const b of this.behaviors) b.setFrequency?.(multiplier);
    this.visitors.setFrequency(multiplier);
  }

  /** Maximum render frame rate (settings.animationFps). */
  setAnimationFps(fps: 15 | 30 | 60): void {
    this.fps = fps;
    if (this.ready) this.app.ticker.maxFPS = fps;
  }

  /** No particles, bobbing, blinking or flashing (settings.reduceMotion). */
  setReduceMotion(on: boolean): void {
    this.reduceMotion = on;
    if (on) {
      this.particles = [];
      for (const f of this.flights) f.label?.destroy();
      this.flights = [];
    }
  }

  setRoomLabels(on: boolean): void {
    this.showRoomLabels = on;
    for (const l of this.roomLabels) l.visible = on;
  }

  /**
   * Pause rendering and simulation while the office is not shown (another dashboard view is
   * open). Real data keeps flowing through setWorkers; nothing is lost.
   */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (!this.ready) return;
    if (on) {
      // The clock ran on while paused: restart stuck detection instead of counting the pause.
      for (const w of this.workers.values()) w.watch = new ProgressWatch();
      this.app.ticker.start();
      this.fit();
    } else {
      this.app.ticker.stop();
    }
  }

  /**
   * World for behavior providers, with the scene's walkability check. Chat tiles skip the
   * lounge tiles where agents without a desk stand.
   */
  private world(layout: OfficeLayout): OfficeWorld {
    const w = buildWorld(layout, this.windowXs(), this.sky === 'night');
    const lounge = this.loungeKeys;
    const chatTiles = lounge.size ? w.chatTiles.filter((t) => !lounge.has(tileKey(t)) && !lounge.has(tileKey({ x: t.x + 1, y: t.y }))) : w.chatTiles;
    return { ...w, chatTiles, isWalkable: (p) => this.ok(p) };
  }

  /** Simulated meetings currently gathering or running (always simulated; for display). */
  currentMeetings(): MeetingInfo[] {
    return this.meetings.currentMeetings();
  }

  /**
   * Fly a paper (delegation), task card (handoff) or check mark (completion) between the two
   * agents' desks. Only for verified collaboration events (collab.ts collabVisuals); skipped
   * with reduced motion, while paused, or when either agent is not in the office.
   */
  playCollabVisuals(visuals: readonly CollabVisual[]): void {
    const fresh = visuals.filter((v) => !this.seenFlights.has(v.id));
    if (!fresh.length) return;
    // Behavior providers may react with short local interactions (e.g. a spawn briefing).
    const now = Date.now();
    for (const b of this.behaviors) b.onTeamEvents?.(fresh, now);
    for (const v of fresh) {
      this.seenFlights.add(v.id);
      if (this.seenFlights.size > 500) this.seenFlights.delete(this.seenFlights.values().next().value!);
      if (this.reduceMotion || !this.active || !this.ready) continue;
      const from = this.workers.get(v.from);
      if (!from || !this.workers.has(v.to) || v.from === v.to) continue;
      this.flights.push({ id: v.id, kind: v.kind, from: this.workerWorldPos(from), to: v.to, start: performance.now(), ...(v.detail ? { detail: v.detail } : {}) });
      this.cue('handoff', this.workerWorldPos(from).x);
      if (this.flights.length > MAX_FLIGHTS) this.flights.shift()?.label?.destroy();
    }
  }

  /** Local department rules (settings.departmentRules) used to prefer desks in department rooms. */
  setDepartmentRules(rules: readonly DepartmentRule[]): void {
    if (JSON.stringify(rules) === JSON.stringify(this.rules)) return;
    this.rules = rules;
    if (this.ready && this.layout) this.reconcile(false);
  }

  // ------------------------------------------------------------- camera API

  private worldSize(): Size {
    const L = this.layout;
    return L ? { w: L.cols * TILE, h: L.rows * TILE + BOTTOM_WALL } : { w: 640, h: 480 };
  }

  private setCamera(cam: Camera, animate: boolean): void {
    const next = clampCamera(cam, this.worldSize(), this.viewSize);
    if (animate && !this.reduceMotion) this.camGoal = next;
    else {
      this.camGoal = undefined;
      this.cam = next;
      this.applyCamera();
    }
  }

  private applyCamera(): void {
    const t = rootTransform(this.cam, this.viewSize);
    this.root.scale.set(t.scale);
    this.root.position.set(t.x, t.y);
  }

  /** Zoom one step in (+1) or out (-1), keeping `at` (screen px) fixed; default: view centre. */
  zoomStep(dir: 1 | -1, at?: Vec): void {
    if (!this.ready) return;
    const base = this.camGoal ?? this.cam;
    const anchor = at ?? { x: this.viewSize.w / 2, y: this.viewSize.h / 2 };
    this.camTouched = true;
    this.setCamera(zoomAt(base, stepZoom(base.zoom, dir), anchor, this.worldSize(), this.viewSize), false);
  }

  /** Show the whole office at the largest crisp zoom that fits. */
  fitView(): void {
    if (!this.ready) return;
    this.camTouched = false;
    this.setCamera(fitCamera(this.worldSize(), this.viewSize), true);
  }

  /** Pan by a screen-space delta (arrow keys). */
  panBy(dx: number, dy: number): void {
    if (!this.ready) return;
    this.camTouched = true;
    this.setCamera(panBy(this.camGoal ?? this.cam, dx, dy, this.worldSize(), this.viewSize), true);
  }

  /** Centre the view on a tile (mini-map navigation). */
  centerOnTile(x: number, y: number): void {
    if (!this.ready) return;
    this.camTouched = true;
    this.setCamera(centerOn(this.cam, { x: x * TILE, y: y * TILE }, this.worldSize(), this.viewSize), true);
  }

  /** Centre the camera on a worker (zooming in to at least 2× if needed). False if not in the office. */
  focus(agentKey: string): boolean {
    const w = this.workers.get(agentKey);
    if (!w || !this.ready) return false;
    this.camTouched = true;
    const zoom = Math.max(this.cam.zoom, 2);
    this.setCamera(centerOn(this.cam, this.workerWorldPos(w), this.worldSize(), this.viewSize, zoom), true);
    return true;
  }

  getZoom(): number {
    return (this.camGoal ?? this.cam).zoom;
  }

  /** Mini-map snapshot: visible area and worker positions in tiles. */
  minimapState(): MiniMapState {
    const v = visibleRect(this.cam, this.viewSize);
    return {
      zoom: this.cam.zoom,
      view: { x: v.x / TILE, y: v.y / TILE, w: v.w / TILE, h: v.h / TILE },
      workers: [...this.workers.values()]
        .filter((w) => !w.leaving && w.node.visible)
        .map((w) => ({ key: w.view.key, x: w.pos.x, y: w.pos.y, status: w.view.status, selected: w.view.key === this.selected })),
    };
  }

  /** Workers currently standing or sitting inside a room (what the scene shows right now). */
  roomOccupants(roomId: string): RoomOccupant[] {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) return [];
    return [...this.workers.values()]
      .filter((w) => !w.leaving && roomContains(room, { x: Math.round(w.pos.x), y: Math.round(w.pos.y) }))
      .map((w) => {
        const o: RoomOccupant = { key: w.view.key, name: w.view.name, status: w.view.status, simulated: w.view.simulated };
        if (this.meetings.meetingOf(w.view.key)?.roomId === roomId) o.inMeeting = true;
        return o;
      });
  }

  /** The simulated meeting or gathering held in a room right now (idle agents or visitors), if any. */
  roomMeeting(roomId: string): RoomMeeting | undefined {
    const m = this.meetings.currentMeetings().find((x) => x.roomId === roomId);
    if (m) {
      const out: RoomMeeting = { who: 'agents', kind: m.kind, phase: m.phase, people: m.participants.length };
      if (m.topic) out.topic = m.topic;
      if (m.endsAt !== undefined) out.endsAt = m.endsAt;
      return out;
    }
    const v = this.visitors.currentMeeting();
    if (!v || v.roomId !== roomId) return undefined;
    const out: RoomMeeting = { who: 'visitors', kind: v.roomKind as MeetingKind, phase: v.phase, people: v.visitors.length };
    if (v.endsAt !== undefined) out.endsAt = v.endsAt;
    return out;
  }

  /** Bring a small group of simulated visitors in for a meeting in this room (room card button). */
  startVisitorMeeting(roomId: string): MeetingRequest {
    return this.visitors.requestMeeting(roomId);
  }

  /** Desks in a room and how many are assigned to agents. */
  roomDesks(roomId: string): { desks: number; assigned: number } {
    const desks = this.seats.filter((s) => s.roomId === roomId);
    const taken = new Set([...this.assignment.values()].filter(Boolean));
    return { desks: desks.length, assigned: desks.filter((s) => taken.has(s.deskId)).length };
  }

  private workerWorldPos(w: Worker): Vec {
    return { x: w.pos.x * TILE + TILE / 2, y: (w.pos.y + 1) * TILE - CHAR_H / 2 };
  }

  // ------------------------------------------------------------- room

  private t(key: string, make: () => HTMLCanvasElement): Texture {
    let t = this.textures.get(key);
    if (!t) {
      t = tex(make());
      this.textures.set(key, t);
    }
    return t;
  }

  private sprite(texture: Texture, x: number, y: number, z: number, anchorBottom = true): Sprite {
    const s = new Sprite(texture);
    s.eventMode = 'none';
    if (anchorBottom) s.anchor.set(0.5, 1);
    s.position.set(x, y);
    s.zIndex = z;
    return s;
  }

  private light(x: number, y: number, tint: number, scale: number): Sprite {
    const l = new Sprite(this.t('light64', () => drawLight(64)));
    l.eventMode = 'none';
    l.anchor.set(0.5);
    l.blendMode = 'add';
    l.tint = tint;
    l.position.set(x, y);
    l.scale.set(scale);
    this.lightLayer.addChild(l);
    return l;
  }

  private wallKind(x: number): 'plain' | 'window' | 'art' {
    const L = this.layout!;
    if (L.items.some((i) => i.type === 'board' && i.x === x)) return 'plain';
    if (this.clockAt && this.clockAt.x === x) return 'plain';
    if (x % 4 === 2) return 'window';
    if (x % 8 === 4) return 'art';
    return 'plain';
  }

  private windowXs(): number[] {
    const L = this.layout!;
    const xs: number[] = [];
    for (let x = 0; x < L.cols; x++) if (this.wallKind(x) === 'window') xs.push(x);
    return xs;
  }

  private label(text: string, fill: string, tile: Point, fontSize = 12): Labelled {
    const label: Labelled = new Text({ text, style: { fontFamily: LABEL_FONT, fontSize, fill, stroke: { color: '#1a1424', width: 3 } }, resolution: 2 });
    label.tile = tile;
    this.overlay.addChild(label);
    return label;
  }

  private buildRoom(): void {
    const L = this.layout!;
    for (const layer of [this.floorLayer, this.zoneLayer, this.wallLayer, this.shadowLayer, this.lightLayer]) layer.removeChildren().forEach((c) => c.destroy());
    for (const c of this.items.removeChildren()) if (!(c as Container & { isWorker?: boolean }).isWorker) c.destroy();
    for (const l of [...this.zoneLabels, ...this.roomLabels]) l.destroy();
    this.zoneLabels = [];
    this.roomLabels = [];
    this.boardBadge?.destroy();
    this.boardBadge = undefined;
    this.desks.clear();
    this.animated = [];
    this.lamps = [];
    this.windowLights = [];
    this.propLights = [];
    this.toilets = [];
    this.coffees = [];
    this.sky = skyFor(this.hour());
    const W = L.cols * TILE;
    const H = L.rows * TILE;

    // frame around the office (the canvas now fills the whole view)
    this.frameLayer.clear();
    this.frameLayer.rect(4, 4, W + 8, H + BOTTOM_WALL + 8).fill({ color: 0x000000, alpha: 0.45 });
    this.frameLayer.rect(-4, -4, W + 8, H + BOTTOM_WALL + 8).fill(0x2a1c14);
    this.frameLayer.rect(-4, -4, W + 8, 1).fill(0x4a3326);

    // floor: one texture for the whole floor (room finishes + classic wood elsewhere)
    const floorKey = `floormap|${L.cols}x${L.rows}|${JSON.stringify(this.rooms.map((r) => [r.kind, r.x, r.y, r.w, r.h]))}`;
    if (this.floorKey && this.floorKey !== floorKey) {
      this.textures.get(this.floorKey)?.destroy(true);
      this.textures.delete(this.floorKey);
    }
    this.floorKey = floorKey;
    const floor = new Sprite(this.t(floorKey, () => drawFloorMap(L, drawFloor)));
    floor.eventMode = 'none';
    floor.position.set(0, WALL_ROWS * TILE);
    this.floorLayer.addChild(floor);
    this.floorLayer.hitArea = new Rectangle(0, 0, W, H + TILE);
    const wallShadow = new Graphics();
    wallShadow.rect(0, WALL_ROWS * TILE, W, 3).fill({ color: 0x000000, alpha: 0.18 });
    wallShadow.eventMode = 'none';
    this.floorLayer.addChild(wallShadow);
    const mat = new Sprite(this.t('doormat', drawDoormat));
    mat.eventMode = 'none';
    mat.position.set(L.door.x * TILE, (L.rows - 1) * TILE);
    this.floorLayer.addChild(mat);
    const bottom = new Graphics();
    bottom.eventMode = 'none';
    for (let x = 0; x < L.cols; x++) if (x !== L.door.x) bottom.rect(x * TILE, H, TILE, BOTTOM_WALL).fill(0x3e2b20).rect(x * TILE, H, TILE, 1).fill(0x6b4a33);
    bottom.rect(L.door.x * TILE - 2, H - 4, 2, 10).fill(0x8a6446);
    bottom.rect((L.door.x + 1) * TILE, H - 4, 2, 10).fill(0x8a6446);
    this.floorLayer.addChild(bottom);

    // back wall: windows, art, clock, board
    this.clockAt = undefined;
    for (const cx of [L.cols - 3, 3, 5, 7, 9]) {
      if (cx > 0 && cx < L.cols && cx % 4 !== 2 && !L.items.some((i) => i.type === 'board' && i.x === cx)) {
        this.clockAt = { x: cx, y: 0 };
        break;
      }
    }
    for (let x = 0; x < L.cols; x++) {
      const kind = this.wallKind(x);
      const s = new Sprite(this.t(`wall-${kind}-${x % 8}-${this.sky}`, () => drawWall(x, kind, this.sky)));
      s.eventMode = 'none';
      s.position.set(x * TILE, 0);
      this.wallLayer.addChild(s);
      if (kind === 'window') {
        const light = this.light(x * TILE + 8, WALL_ROWS * TILE + 10, 0xffffff, 1);
        light.scale.set(1.1, 0.55);
        this.windowLights.push(light);
      }
    }
    if (this.clockAt) {
      this.clock = new Graphics();
      this.clock.eventMode = 'none';
      this.clock.position.set(this.clockAt.x * TILE + 8, 11);
      this.wallLayer.addChild(this.clock);
      this.lastClockDraw = -1;
    } else {
      this.clock = undefined;
    }

    // interior walls: blocks that sort with workers, so walls hide whoever stands behind them
    const walls = new Set((L.walls ?? []).map((w) => `${w.x},${w.y}`));
    const isWall = (x: number, y: number) => y < WALL_ROWS || walls.has(`${x},${y}`);
    for (const wt of L.walls ?? []) {
      const mask = maskOf(isWall, wt.x, wt.y);
      const bottomPx = (wt.y + 1) * TILE;
      this.items.addChild(this.sprite(this.t(`iwall${mask}`, () => drawInteriorWall(mask)), wt.x * TILE + TILE / 2, bottomPx, bottomPx));
      if (!(mask & SOUTH) && wt.y < L.rows - 1) {
        const g = new Graphics();
        g.rect(wt.x * TILE, bottomPx, TILE, 3).fill({ color: 0x000000, alpha: 0.2 });
        g.eventMode = 'none';
        this.shadowLayer.addChild(g);
      }
    }

    // zones as rugs
    for (const z of L.zones) {
      const g = new Graphics();
      const color = parseInt(z.color.slice(1), 16);
      g.rect(z.x * TILE + 1, z.y * TILE + 1, z.w * TILE - 2, z.h * TILE - 2).fill({ color, alpha: 0.28 });
      g.rect(z.x * TILE + 3, z.y * TILE + 3, z.w * TILE - 6, z.h * TILE - 6).stroke({ color, alpha: 0.6, width: 1 });
      this.zoneLayer.addChild(g);
      this.zoneLabels.push(this.label(z.name, '#ffffff', { x: z.x, y: z.y }));
    }

    // room labels (settings.roomLabels)
    for (const r of this.rooms) {
      const l = this.label(r.name, ROOM_STYLE[r.kind].accent, { x: r.x, y: r.y }, 11);
      l.alpha = 0.92;
      l.visible = this.showRoomLabels;
      this.roomLabels.push(l);
    }

    // furniture
    const at = (type: string) => new Set(L.items.filter((i) => i.type === type).map((i) => `${i.x},${i.y}`));
    const tables = at('table');
    const counters = at('reception');
    for (const it of L.items) {
      const cx = it.x * TILE + TILE / 2;
      const bottomPx = (it.y + 1) * TILE;
      const roomKind: RoomKind | undefined = roomAt(L, it)?.kind;
      const shadow = (w: number, h = 3) => {
        const g = new Graphics();
        g.ellipse(cx, bottomPx - 1, w, h).fill({ color: 0x000000, alpha: 0.22 });
        g.eventMode = 'none';
        this.shadowLayer.addChild(g);
      };
      const anim = (s: Sprite, key: string, frames: number, ms: number, make: (f: number) => HTMLCanvasElement) =>
        this.animated.push({ sprite: s, key, frames, ms, make, offset: hash(it.id) % 1000, shown: 0 });
      const glow = (x: number, y: number, tint: number, scale: number, strength: number) => this.propLights.push({ light: this.light(x, y, tint, scale), strength });
      switch (it.type) {
        case 'desk': {
          const seat = this.seatById.get(it.id)!;
          const variant = hash(it.id) % 6;
          const g = new Graphics();
          g.rect(it.x * TILE, bottomPx - 1, TILE, 3).fill({ color: 0x000000, alpha: 0.25 });
          g.eventMode = 'none';
          this.shadowLayer.addChild(g);
          this.items.addChild(this.sprite(this.t(`desk${variant}`, () => drawDesk(variant)), cx, bottomPx, bottomPx));
          const monitorBottom = bottomPx - 14;
          this.items.addChild(this.sprite(this.t('monitor', drawMonitor), cx, monitorBottom, bottomPx + 1));
          const screen = this.sprite(this.t('screen-off-0-0', () => drawScreen('off', 0)), it.x * TILE + 3, monitorBottom - 13, bottomPx + 2, false);
          this.items.addChild(screen);
          const chairBottom = (seat.seat.y + 1) * TILE;
          this.items.addChild(this.sprite(this.t('chair', drawChair), cx, chairBottom, chairBottom + 0.5));
          const glowSprite = this.light(cx, monitorBottom - 6, 0xffffff, 0.75);
          glowSprite.visible = false;
          const desk: Desk = { seat, screen, glow: glowSprite, variant, shownKind: 'off', shownFrame: 0 };
          // Department dressing (decoration; the main screen always shows the real status).
          if (seat.roomKind === 'qa') {
            desk.lamp = this.sprite(this.t('qa-off-true', () => drawQaLamp('off', true)), it.x * TILE + 13, monitorBottom - 12, bottomPx + 3);
            this.items.addChild(desk.lamp);
          } else if (seat.roomKind === 'research') {
            this.items.addChild(this.sprite(this.t('bookstack', drawBookStack), it.x * TILE + 3, bottomPx - 11, bottomPx + 3));
          }
          this.desks.set(it.id, desk);
          break;
        }
        case 'plant': {
          shadow(5);
          const s = this.sprite(this.t('plant0', () => drawPlant(0)), cx, bottomPx, bottomPx);
          this.items.addChild(s);
          anim(s, 'plant', 2, 1300, drawPlant);
          break;
        }
        case 'cooler': {
          shadow(5);
          const s = this.sprite(this.t('cooler0', () => drawCooler(0)), cx, bottomPx, bottomPx);
          this.items.addChild(s);
          anim(s, 'cooler', 4, 450, drawCooler);
          break;
        }
        case 'printer': {
          shadow(7);
          const s = this.sprite(this.t('printer0', () => drawPrinter(0)), cx, bottomPx, bottomPx);
          this.items.addChild(s);
          anim(s, 'printer', 2, 900, drawPrinter);
          break;
        }
        case 'bookshelf':
          shadow(7, 2);
          this.items.addChild(this.sprite(this.t('shelf', drawBookshelf), cx, bottomPx, bottomPx));
          break;
        case 'couch':
          shadow(8);
          this.items.addChild(this.sprite(this.t('couch', drawCouch), cx, bottomPx, bottomPx));
          break;
        case 'lamp': {
          shadow(4, 2);
          const s = this.sprite(this.t('lamp0', () => drawLamp(false)), cx, bottomPx, bottomPx);
          this.items.addChild(s);
          this.lamps.push({ sprite: s, light: this.light(cx, bottomPx - 18, 0xffd28a, 1.6) });
          break;
        }
        case 'toilet': {
          shadow(7, 2);
          const s = this.sprite(this.t('toilet0', () => drawToilet(false)), cx, bottomPx, bottomPx);
          this.items.addChild(s);
          this.toilets.push({ id: it.id, sprite: s, shown: -1 });
          break;
        }
        case 'coffee': {
          shadow(7, 2);
          const s = this.sprite(this.t('coffee-idle', () => drawCoffeeMachine(0, false)), cx, bottomPx, bottomPx);
          this.items.addChild(s);
          this.coffees.push({ id: it.id, sprite: s, shown: -1 });
          break;
        }
        case 'server': {
          shadow(7, 2);
          const v = hash(it.id) % 4;
          const s = this.sprite(this.t(`rack${v}-0`, () => drawServerRack(v, 0)), cx, bottomPx, bottomPx);
          this.items.addChild(s);
          anim(s, `rack${v}-`, 4, 420, (f) => drawServerRack(v, f));
          glow(cx, bottomPx - 14, 0x7ee787, 0.45, 0.35);
          break;
        }
        case 'whiteboard': {
          shadow(7, 2);
          const v = hash(it.id) % 3;
          this.items.addChild(this.sprite(this.t(`whiteboard${v}`, () => drawWhiteboard(v)), cx, bottomPx, bottomPx));
          break;
        }
        case 'screen':
          shadow(6, 2);
          this.items.addChild(this.sprite(this.t('pscreen', drawPresentationScreen), cx, bottomPx, bottomPx));
          glow(cx, bottomPx - 19, 0x5ad1ff, 0.8, 0.6);
          break;
        case 'table': {
          const mask = maskOf((x, y) => tables.has(`${x},${y}`), it.x, it.y);
          if (!(mask & SOUTH)) {
            const g = new Graphics();
            g.rect(it.x * TILE + (mask & WEST ? 0 : 1), bottomPx - 1, TILE - (mask & WEST ? 0 : 1) - (mask & EAST ? 0 : 1), 3).fill({ color: 0x000000, alpha: 0.22 });
            g.eventMode = 'none';
            this.shadowLayer.addChild(g);
          }
          this.items.addChild(this.sprite(this.t(`table${mask}`, () => drawTable(mask)), cx, bottomPx, bottomPx - 2));
          break;
        }
        case 'chair': {
          const face = chairFacing(L, it);
          shadow(5, 2);
          // A chair seen from behind sits in front of whoever uses it; otherwise behind them.
          this.items.addChild(this.sprite(this.t(`mchair-${face}`, () => drawMeetingChair(face)), cx, bottomPx, face === 'up' ? bottomPx + 0.5 : bottomPx - 1.5));
          break;
        }
        case 'snack':
          shadow(7, 2);
          this.items.addChild(this.sprite(this.t('snack', drawSnackMachine), cx, bottomPx, bottomPx));
          glow(cx, bottomPx - 16, 0xfff1c0, 0.7, 0.55);
          break;
        case 'reception': {
          const mask = maskOf((x, y) => counters.has(`${x},${y}`), it.x, it.y) & (EAST | WEST);
          const bell = mask === (EAST | WEST);
          this.items.addChild(this.sprite(this.t(`reception${mask}-${bell}`, () => drawReceptionDesk(mask, bell)), cx, bottomPx, bottomPx));
          break;
        }
        case 'noticeboard': {
          shadow(6, 2);
          const v = hash(it.id) % 4;
          this.items.addChild(this.sprite(this.t(`notice${v}`, () => drawNoticeboard(v)), cx, bottomPx, bottomPx));
          break;
        }
        case 'console': {
          shadow(8, 2);
          const theme = consoleTheme(roomKind);
          const s = this.sprite(this.t(`console-${theme}-0`, () => drawConsole(theme, 0)), cx, bottomPx, bottomPx);
          this.items.addChild(s);
          anim(s, `console-${theme}-`, 6, 700, (f) => drawConsole(theme, f));
          glow(cx, bottomPx - 16, theme === 'cctv' ? 0x9fd8b0 : 0x7ee787, 0.6, 0.5);
          break;
        }
        case 'board': {
          const s = new Sprite(this.t('board', drawBoard));
          s.position.set(it.x * TILE, it.y * TILE - 2);
          s.eventMode = 'static';
          s.cursor = 'pointer';
          s.on('pointertap', (e) => {
            e.stopPropagation();
            if (!this.editMode) this.cb.onBoardClick();
          });
          this.wallLayer.addChild(s);
          this.boardBadge = new Text({
            text: this.openTasks > 0 ? String(this.openTasks) : '',
            style: { fontFamily: LABEL_FONT, fontSize: 12, fontWeight: '700', fill: '#ffffff', stroke: { color: '#c0392b', width: 4 } },
            resolution: 2,
          });
          (this.boardBadge as Labelled).tile = { x: it.x + 1, y: it.y };
          this.overlay.addChild(this.boardBadge);
          break;
        }
      }
    }
    for (const w of this.workers.values()) if (!w.node.parent) this.items.addChild(w.node);
    for (const g of this.guests.values()) if (!g.node.parent) this.items.addChild(g.node);
    const world = this.world(L);
    for (const b of this.behaviors) b.setWorld(world);
    this.visitors.setWorld({ ...world, door: { x: L.door.x, y: L.rows } });
    // Walls or furniture may have moved: route every visitor again on the next tick.
    for (const g of this.guests.values()) g.target = undefined;
    this.lastSec = -1;
    this.labelCam.zoom = Number.NaN;
    this.applyTimeOfDay();
    this.drawEditGrid();
  }

  private applyTimeOfDay(): void {
    if (!this.layout) return;
    const L = this.layout;
    const dark = DARKNESS[this.sky];
    this.darkness.clear();
    if (dark > 0) this.darkness.rect(0, 0, L.cols * TILE, L.rows * TILE + BOTTOM_WALL).fill({ color: AMBIENT[this.sky] });
    const lampsOn = this.sky === 'night' || this.sky === 'dusk';
    for (const l of this.lamps) {
      l.sprite.texture = this.t(lampsOn ? 'lamp1' : 'lamp0', () => drawLamp(lampsOn));
      l.light.visible = lampsOn;
      l.light.alpha = 0.45;
    }
    for (const w of this.windowLights) {
      w.visible = this.sky !== 'night';
      w.tint = this.sky === 'day' ? 0xfff4d0 : 0xffb070;
      w.alpha = this.sky === 'day' ? 0.16 : 0.12;
    }
    for (const p of this.propLights) {
      p.light.visible = dark > 0;
      p.light.alpha = p.strength * dark;
    }
  }

  private drawClock(now: Date): void {
    if (!this.clock) return;
    const sec = now.getSeconds();
    if (sec === this.lastClockDraw) return;
    this.lastClockDraw = sec;
    const g = this.clock;
    g.clear();
    g.circle(0, 0, 7).fill(0x3e2b20);
    g.circle(0, 0, 6).fill(0xf7f3e8);
    for (let i = 0; i < 12; i += 3) {
      const a = (i / 12) * Math.PI * 2;
      g.rect(Math.round(Math.sin(a) * 5) - 0.5, Math.round(-Math.cos(a) * 5) - 0.5, 1, 1).fill(0x3e2b20);
    }
    const hand = (frac: number, len: number, color: number, width: number) => {
      const a = frac * Math.PI * 2;
      g.moveTo(0, 0).lineTo(Math.sin(a) * len, -Math.cos(a) * len).stroke({ color, width });
    };
    hand((now.getHours() % 12) / 12 + now.getMinutes() / 720, 3, 0x2a1d16, 1.2);
    hand(now.getMinutes() / 60 + sec / 3600, 4.6, 0x2a1d16, 1);
    hand(sec / 60, 5, 0xc0392b, 0.6);
    g.rect(-0.5, -0.5, 1, 1).fill(0x2a1d16);
  }

  private drawEditGrid(): void {
    this.editLayer.removeChildren().forEach((c) => c.destroy());
    if (!this.editMode || !this.layout) return;
    const L = this.layout;
    const g = new Graphics();
    for (let x = 0; x <= L.cols; x++) g.rect(x * TILE, TILE, 0.5, (L.rows - 1) * TILE).fill({ color: 0xffffff, alpha: 0.22 });
    for (let y = 1; y <= L.rows; y++) g.rect(0, y * TILE, L.cols * TILE, 0.5).fill({ color: 0xffffff, alpha: 0.22 });
    for (const r of this.rooms) {
      const color = parseInt(ROOM_STYLE[r.kind].accent.slice(1), 16);
      g.rect(r.x * TILE + 1, r.y * TILE + 1, r.w * TILE - 2, r.h * TILE - 2).stroke({ color, alpha: 0.9, width: 1 });
    }
    for (const s of this.seats) g.rect(s.seat.x * TILE + 4, s.seat.y * TILE + 4, 8, 8).stroke({ color: 0x81c784, alpha: 0.8, width: 1 });
    g.rect(L.door.x * TILE + 1, (L.rows - 1) * TILE + 1, TILE - 2, TILE - 2).stroke({ color: 0xffd54f, width: 1 });
    this.editLayer.addChild(g);
  }

  /** Size the canvas to the host and keep the camera valid. */
  private fit(): void {
    if (!this.ready || !this.layout) return;
    // Hidden (another view is open): keep the current size and camera until shown again.
    if (!this.host.clientWidth || !this.host.clientHeight) return;
    const w = Math.max(200, Math.floor(this.host.clientWidth));
    const h = Math.max(200, Math.floor(this.host.clientHeight));
    this.viewSize = { w, h };
    this.app.renderer.resize(w, h);
    this.backdrop.hitArea = new Rectangle(0, 0, w, h);
    if (!this.camTouched) this.cam = fitCamera(this.worldSize(), this.viewSize);
    this.cam = clampCamera(this.cam, this.worldSize(), this.viewSize);
    this.camGoal = undefined;
    this.applyCamera();
  }

  // ------------------------------------------------------------- workers

  private visible(v: WorkerView, now: number): boolean {
    if (!TERMINAL_STATUSES.has(v.status)) return true;
    const linger = v.status === 'completed' ? LINGER_COMPLETED_MS : LINGER_ENDED_MS;
    return v.terminalAt !== undefined && now - v.terminalAt < linger;
  }

  /** Assignment input with the agent's department (local rules over real fields). */
  private assignable(v: WorkerView): Assignable {
    const department = departmentFor({ agentType: v.agentType, cwd: v.cwd, name: v.name }, this.rules);
    const before = this.deptOf.get(v.key);
    // Re-seat an agent whose department changed (rules edited, or its type became known).
    if (before !== undefined && before !== department) this.assignment.delete(v.key);
    this.deptOf.set(v.key, department);
    return { key: v.key, parentKey: v.parentKey, cwd: v.cwd, department };
  }

  private reconcile(layoutChanged: boolean): void {
    const now = Date.now();
    this.lastReconcile = now;
    const L = this.layout!;
    const visible = this.views.filter((v) => this.visible(v, now));
    const keys = new Set(visible.map((v) => v.key));
    this.assignment = assignDesks(
      this.assignment,
      visible.map((v) => this.assignable(v)),
      this.seats,
    );
    // Agents without a desk keep their lounge place while they stay (stable, like desks).
    const deskless = visible.filter((v) => !this.assignment.get(v.key)).map((v) => v.key);
    this.loungeOf = assignSlots(this.loungeOf, deskless, this.lounge.length);
    const instant = this.firstReconcile;
    this.firstReconcile = false;

    for (const v of visible) {
      const deskId = this.assignment.get(v.key) ?? null;
      const slot = this.loungeOf.get(v.key);
      const target = deskId ? this.seatById.get(deskId)!.seat : ((slot !== undefined ? this.lounge[slot] : undefined) ?? { x: L.door.x, y: L.rows - 1 });
      let w = this.workers.get(v.key);
      if (!w) {
        w = this.createWorker(v, instant ? target : { x: L.door.x, y: L.rows });
        this.workers.set(v.key, w);
        // A real agent walks in (not the ones already there when the office opens).
        if (!instant) this.cue('arrive', L.door.x * TILE + TILE / 2);
      }
      this.effectsFor(w, v);
      w.view = v;
      if (w.leaving) w.leaving = false;
      const arrive: Phase = deskId ? 'seated' : 'standing';
      const moved = w.deskId !== deskId || w.home.x !== target.x || w.home.y !== target.y;
      w.home = target;
      w.homeArrive = arrive;
      w.deskId = deskId;
      // Movement is driven by the behavior providers each tick; only (re)assignments force a walk here.
      if (layoutChanged || moved || !w.target) {
        if (moved) this.forgetActor(v.key);
        w.perform = undefined;
        this.walkTo(w, target, arrive);
      }
    }
    for (const w of this.workers.values()) {
      if (keys.has(w.view.key) || w.leaving) continue;
      w.leaving = true;
      w.deskId = null;
      w.perform = undefined;
      this.forgetActor(w.view.key);
      this.walkTo(w, { x: L.door.x, y: L.rows }, 'leaving');
    }
  }

  /** Particle effects for real, observed transitions only. */
  private effectsFor(w: Worker, v: WorkerView): void {
    const hx = w.pos.x * TILE + 8;
    const hy = (w.pos.y + 1) * TILE - CHAR_H;
    if (v.lastToolEnd && v.lastToolEnd.id !== w.lastToolId) {
      if (w.lastToolId !== undefined || w.phase === 'seated') {
        if (v.lastToolEnd.ok) this.burst(hx, hy + 4, [0x7ee787, 0xffffff, 0xf2cc60], 6, -40);
        else {
          this.burst(hx, hy + 4, [0xff6b6b, 0x9aa5b1, 0x5a606c], 9, -18);
          this.cue('toolFail', hx);
        }
      }
      w.lastToolId = v.lastToolEnd.id;
    }
    if (v.status !== w.lastStatus) {
      if (v.status === 'completed') this.burst(hx, hy, [0xff7a59, 0x4f8cff, 0xf2b134, 0x38c172, 0xb06bff], 18, -60);
      const sound = cueForStatus(w.lastStatus, v.status);
      if (sound) this.cue(sound, hx);
      w.lastStatus = v.status;
    }
    if (v.kind === 'session' && v.turnCompletedAt && v.turnCompletedAt !== w.lastTurn) {
      if (Date.now() - v.turnCompletedAt < 5000) {
        this.burst(hx, hy, [0xffe066, 0xffffff, 0x7ee787], 12, -50);
        this.cue('done', hx);
      }
      w.lastTurn = v.turnCompletedAt;
    }
  }

  private burst(x: number, y: number, colors: number[], n: number, vy: number): void {
    if (this.reduceMotion) return;
    for (let i = 0; i < n; i++) {
      const life = 0.6 + Math.random() * 0.6;
      this.particles.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 50,
        vy: vy * (0.6 + Math.random() * 0.8),
        life,
        max: life,
        color: colors[i % colors.length]!,
        size: Math.random() > 0.7 ? 2 : 1,
        gravity: 90,
      });
    }
    if (this.particles.length > 400) this.particles.splice(0, this.particles.length - 400);
  }

  /** Collaboration flights: an arc from the sender's desk to the receiver's current position. */
  private drawFlights(): void {
    if (!this.flights.length) return;
    const t = performance.now();
    const g = this.fx;
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i]!;
      const target = this.workers.get(f.to);
      const p = (t - f.start) / FLIGHT_MS;
      if (!target || this.reduceMotion) {
        this.flights.splice(i, 1);
        f.label?.destroy();
        continue;
      }
      const to = this.workerWorldPos(target);
      if (p >= 1) {
        this.flights.splice(i, 1);
        f.label?.destroy();
        const colors = f.kind === 'complete' ? [0x7ee787, 0xffffff] : f.kind === 'handoff' ? [0xf2cc60, 0xffffff] : [0xffffff, 0x79c0ff];
        this.burst(to.x, to.y - 4, colors, 8, -36);
        continue;
      }
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2; // ease in-out
      const lift = Math.min(28, 10 + Math.hypot(to.x - f.from.x, to.y - f.from.y) * 0.15);
      const x = Math.round(f.from.x + (to.x - f.from.x) * e);
      const y = Math.round(f.from.y + (to.y - f.from.y) * e - Math.sin(Math.PI * p) * lift - 6);
      g.ellipse(x, Math.round(f.from.y + (to.y - f.from.y) * e + 2), 3, 1).fill({ color: 0x000000, alpha: 0.18 });
      if (f.kind === 'delegate') {
        // sheet of paper
        g.rect(x - 2, y - 3, 5, 6).fill(0xffffff);
        g.rect(x - 1, y - 2, 3, 1).fill(0x9aa5b1);
        g.rect(x - 1, y, 3, 1).fill(0x9aa5b1);
        g.rect(x - 2, y + 3, 5, 1).fill({ color: 0x5a606c, alpha: 0.6 });
      } else if (f.kind === 'handoff') {
        // task card
        g.rect(x - 3, y - 2, 7, 5).fill(0xf2cc60);
        g.rect(x - 3, y - 2, 7, 1).fill(0xc99a06);
        g.rect(x - 2, y, 4, 1).fill(0x8a6a04);
        if (f.detail) {
          // Real, sanitized task subject (white label style, not the simulated lavender).
          if (!f.label) {
            f.label = new Text({
              text: f.detail,
              style: { fontFamily: LABEL_FONT, fontSize: 11, fill: '#ffe9a8', stroke: { color: '#1a1424', width: 3 } },
              resolution: 2,
            });
            f.label.anchor.set(0.5, 1);
            f.label.eventMode = 'none';
            f.label.zIndex = 2;
            this.overlay.addChild(f.label);
          }
          const zoom = this.cam.zoom;
          f.label.position.set(Math.round(this.root.position.x + x * zoom), Math.round(this.root.position.y + (y - 4) * zoom));
          f.label.alpha = p > 0.8 ? (1 - p) / 0.2 : 1;
        }
      } else {
        // check mark
        g.rect(x - 3, y, 1, 1).fill(0x27ae60);
        g.rect(x - 2, y + 1, 1, 1).fill(0x27ae60);
        g.rect(x - 1, y, 1, 1).fill(0x27ae60);
        g.rect(x, y - 1, 1, 1).fill(0x27ae60);
        g.rect(x + 1, y - 2, 1, 1).fill(0x27ae60);
        g.rect(x + 2, y - 3, 1, 1).fill(0x27ae60);
      }
    }
  }

  // ------------------------------------------------------------- behavior (directives)

  private updateBehaviorsEnabled(): void {
    this.behaviorsOn = this.idleLife && !this.editMode;
    for (const b of this.behaviors) b.setEnabled(this.behaviorsOn);
    this.visitors.setEnabled(this.behaviorsOn && this.visitorsWanted);
  }

  private forgetActor(key: string): void {
    for (const b of this.behaviors) b.forget(key);
  }

  private spotInUse(spotId: string): boolean {
    return this.behaviors.some((b) => b.isInUse?.(spotId) ?? false) || this.visitors.isInUse(spotId);
  }

  /**
   * The one place where simulated behavior reaches workers: build actors from real status,
   * ask every provider in priority order (an actor claimed by one provider is offered to the
   * next ones as not idle), let directives.ts have the final say (real status wins, one worker
   * per destination), then apply the result to each worker.
   */
  private runBehaviors(now: number): void {
    const actors: Actor[] = [];
    const arbiter: ArbiterActor[] = [];
    for (const w of this.workers.values()) {
      this.checkProgress(w, now);
      if (w.leaving) continue;
      const idle =
        w.view.status === 'idle' && !w.view.stale && !(w.view.kind === 'session' && w.view.turnCompletedAt !== undefined && now - w.view.turnCompletedAt < CELEBRATE_MS);
      actors.push({
        key: w.view.key,
        idle,
        away: w.target !== undefined && (w.target.x !== w.home.x || w.target.y !== w.home.y),
        home: w.home,
        pos: { x: Math.round(w.pos.x), y: Math.round(w.pos.y) },
        moving: w.path.length > 0,
        ctx: this.actorContext(w),
      });
      const a: ArbiterActor = { key: w.view.key, idle, status: w.view.status, home: w.home };
      if (w.target) a.target = w.target;
      arbiter.push(a);
    }
    const claimed = new Map<string, Claim>(); // non-home directives: the actor is taken
    const homes = new Map<string, Directive>(); // home directives (a hurried one wins)
    for (const provider of this.behaviors) {
      // Providers that react to verified collaboration events may move busy actors briefly.
      const trusted = typeof provider.onTeamEvents === 'function';
      const offered = actors.map((a) => (claimed.has(a.key) ? { ...a, idle: false } : a));
      for (const [key, d] of provider.tick(now, offered)) {
        if (claimed.has(key)) continue; // a higher-priority provider already has this actor
        if (d.type !== 'home') {
          claimed.set(key, { directive: d, trusted });
          continue;
        }
        const prev = homes.get(key);
        if (!prev || (d.hurry && prev.type === 'home' && !prev.hurry)) homes.set(key, d);
      }
    }
    const resolved = resolveDirectives(arbiter, claimed, homes);
    for (const w of this.workers.values()) if (!w.leaving) this.applyDirective(w, resolved.get(w.view.key));
    this.runVisitors(now);
    // Props that show whether a spot is in use (restroom door sign, busy coffee machine).
    const before = this.spotBusyBefore;
    this.spotBusyBefore = this.spotBusy;
    this.spotBusy = before;
    this.spotBusy.clear();
    for (const p of this.toilets) if (this.spotInUse(p.id)) this.spotBusy.add(p.id);
    for (const p of this.coffees) if (this.spotInUse(p.id)) this.spotBusy.add(p.id);
    // Simulated sounds: the coffee machine starts brewing; someone leaves the restroom.
    for (const p of this.coffees) if (this.spotBusy.has(p.id) && !this.spotBusyBefore.has(p.id)) this.cue('coffee', p.sprite.x);
    for (const p of this.toilets) if (!this.spotBusy.has(p.id) && this.spotBusyBefore.has(p.id)) this.cue('flush', p.sprite.x);
  }

  /**
   * Simulated visitors: the director plans their trips, the scene walks them. Every tile an
   * agent stands on (when not walking) or is heading to is passed as taken, so visitors keep
   * clear of agents and step aside when an agent wants their spot.
   */
  private runVisitors(now: number): void {
    const taken = new Set<string>();
    for (const w of this.workers.values()) {
      if (w.leaving) continue;
      if (w.target) taken.add(tileKey(w.target));
      if (!w.path.length) taken.add(tileKey({ x: Math.round(w.pos.x), y: Math.round(w.pos.y) }));
    }
    const bodies: VisitorBody[] = [];
    for (const g of this.guests.values()) {
      this.checkProgress(g, now);
      bodies.push({ id: g.id, pos: { x: Math.round(g.pos.x), y: Math.round(g.pos.y) }, moving: g.path.length > 0 });
    }
    // Visitors do not walk into a room while a meeting is on there.
    const busyRooms = new Set(this.meetings.currentMeetings().map((m) => m.roomId));
    const directives = this.visitors.tick(now, bodies, taken, busyRooms);
    for (const [id, d] of directives) {
      let g = this.guests.get(id);
      if (!g) {
        g = this.createGuest(id, this.visitors.lookOf(id) ?? id);
        this.guests.set(id, g);
        this.cue('visitor', g.pos.x * TILE + TILE / 2);
      }
      this.applyGuest(g, d);
    }
    // Visitors the director let go have walked out through the door.
    for (const g of [...this.guests.values()]) if (!directives.has(g.id)) this.removeGuest(g);
  }

  private applyGuest(g: Guest, d: VisitorDirective): void {
    if (d.type === 'wait') {
      // Between two stops: stand on the nearest tile.
      g.perform = undefined;
      const here = { x: Math.round(g.pos.x), y: Math.round(g.pos.y) };
      if (!g.target || g.target.x !== here.x || g.target.y !== here.y) this.walkTo(g, here, 'standing');
      return;
    }
    const to = d.type === 'do' ? d.at : d.to;
    g.perform = d.type === 'do' ? d : undefined;
    g.leaving = d.type === 'leave';
    if (!g.target || g.target.x !== to.x || g.target.y !== to.y) this.walkTo(g, to, g.leaving ? 'leaving' : 'standing');
  }

  private createGuest(id: string, seed: string): Guest {
    const L = this.layout!;
    const look = visitorLook(seed);
    const node = new Container() as Container & { isWorker?: boolean };
    node.isWorker = true; // kept across room rebuilds, like workers
    const shadow = new Graphics();
    shadow.eventMode = 'none';
    shadow.ellipse(0, -1, 5, 2).fill({ color: 0x000000, alpha: 0.28 });
    const sprite = new Sprite();
    sprite.eventMode = 'none';
    sprite.anchor.set(0.5, 1);
    node.addChild(shadow, sprite);
    // Hover shows what it is; there is nothing to select (a visitor is not an agent).
    node.eventMode = this.editMode ? 'none' : 'static';
    node.hitArea = new Rectangle(-7, -CHAR_H, 14, CHAR_H);
    const bubble = new Sprite();
    bubble.eventMode = 'none';
    bubble.anchor.set(0.5, 1);
    this.fxLayer.addChild(bubble);
    const label = new Text({
      text: VISITOR_LABEL,
      style: { fontFamily: LABEL_FONT, fontSize: 11, fill: SIM_SPEECH_STYLE.fill, stroke: { color: SIM_SPEECH_STYLE.border, width: 3 }, align: 'center' },
      resolution: 2,
    });
    label.anchor.set(0.5, 1);
    label.visible = false;
    this.overlay.addChild(label);
    const g: Guest = {
      id,
      look,
      lookKey: `visitor:${seed}`,
      pos: { x: L.door.x, y: L.rows },
      path: [],
      phase: 'walking',
      arrive: 'standing',
      facing: 'up',
      watch: new ProgressWatch(),
      offset: hash(id) % 5000,
      leaving: false,
      node,
      sprite,
      bubble,
      label,
      hovered: false,
      speech: this.createSpeech(),
    };
    node.on('pointerover', () => (g.hovered = true));
    node.on('pointerout', () => (g.hovered = false));
    this.items.addChild(node);
    return g;
  }

  private removeGuest(g: Guest): void {
    this.guests.delete(g.id);
    g.node.destroy({ children: true });
    g.bubble.destroy();
    g.label.destroy();
    g.speech.node.destroy({ children: true });
    const prefix = `${g.lookKey}|`;
    for (const [k, t] of this.textures) {
      if (!k.startsWith(prefix)) continue;
      t.destroy(true);
      this.textures.delete(k);
    }
  }

  /** Simulated speech: lavender dashed box (SIM_SPEECH_STYLE), never the white status bubbles. */
  private createSpeech(): Speech {
    const node = new Container();
    node.eventMode = 'none';
    node.visible = false;
    const box = new Sprite();
    box.anchor.set(0.5, 1);
    box.scale.set(2);
    const text = new Text({
      text: '',
      style: {
        fontFamily: LABEL_FONT,
        fontSize: SPEECH_FONT_SIZE,
        fill: SIM_SPEECH_STYLE.text,
        align: 'center',
        wordWrap: true,
        wordWrapWidth: SPEECH_MAX_W,
        lineHeight: SPEECH_FONT_SIZE + 2,
      },
      resolution: 2,
    });
    text.anchor.set(0.5, 1);
    node.addChild(box, text);
    this.overlay.addChild(node);
    return { node, box, text };
  }

  /** Show (or hide) a simulated speech line above a character; `top` is the head (world px). */
  private showSpeech(sp: Speech, line: string | undefined, visible: boolean, px: number, top: number, labelGap: number): void {
    sp.node.visible = Boolean(line) && visible;
    if (!line) {
      sp.line = undefined;
      return;
    }
    if (!sp.node.visible) return;
    if (sp.line !== line) {
      sp.line = line;
      sp.text.text = line;
      this.cue('chatter', px);
      // Background in 2px "pixels", sized to the text in 4px steps (few cached textures).
      const bw = Math.ceil((sp.text.width + 10) / 4) * 2;
      const bh = Math.ceil((sp.text.height + 6) / 4) * 2;
      sp.box.texture = this.t(`speech-${bw}x${bh}`, () => drawSpeechBubble(bw, bh));
      sp.text.position.set(0, -6 - 3);
    }
    const zoom = this.cam.zoom;
    const half = sp.box.width / 2 + 2;
    const x = Math.min(Math.max(this.root.position.x + px * zoom, half), this.viewSize.w - half);
    const y = Math.max(this.root.position.y + top * zoom - labelGap, sp.box.height);
    sp.node.position.set(Math.round(x), Math.round(y));
    sp.node.zIndex = 3;
  }

  /** Move a walker along its path by `budget` tiles, turning to face each step. */
  private advance(w: Walker, budget: number): void {
    while (budget > 0 && w.path.length) {
      const next = w.path[0]!;
      const dx = next.x - w.pos.x;
      const dy = next.y - w.pos.y;
      const dist = Math.hypot(dx, dy);
      if (Math.abs(dx) > Math.abs(dy)) w.facing = dx > 0 ? 'right' : 'left';
      else if (dy !== 0) w.facing = dy > 0 ? 'down' : 'up';
      if (dist <= budget) {
        w.pos.x = next.x;
        w.pos.y = next.y;
        w.path.shift();
        budget -= dist;
      } else {
        w.pos.x += (dx / dist) * budget;
        w.pos.y += (dy / dist) * budget;
        budget = 0;
      }
    }
  }

  /**
   * Never permanently stuck: a walker without progress for a few seconds is routed again
   * (from the nearest tile with a way to its target), and put at its target if that fails.
   * A worker that somehow stands off its target without a path is put there as well.
   */
  private checkProgress(w: Walker, now: number): void {
    const walking = w.path.length > 0;
    const action = w.watch.update(now, Math.round(w.pos.x), Math.round(w.pos.y), walking);
    if (!w.target) return;
    if (action === 'repath') this.walkTo(w, w.target, w.arrive);
    else if (action === 'place' || (!walking && (w.pos.x !== w.target.x || w.pos.y !== w.target.y))) this.place(w, w.target, w.arrive);
  }

  /** Real, observed context for providers (no inference: only fields the scene already has). */
  private actorContext(w: Worker): DialogueFacts {
    const v = w.view;
    const ctx: DialogueFacts = { kind: v.kind, sessionId: v.sessionId, status: v.status };
    if (v.parentKey) ctx.parentKey = v.parentKey;
    if (v.lastWorkMs !== undefined) ctx.lastWorkMs = v.lastWorkMs;
    if (v.failure) ctx.recentFailure = { ...v.failure };
    if (v.lastTestPassAt !== undefined) ctx.lastTestPassAt = v.lastTestPassAt;
    const finishedAt = v.kind === 'session' ? v.turnCompletedAt : v.terminalAt;
    if (finishedAt !== undefined) ctx.finishedAt = finishedAt;
    const homeRoomId = w.deskId ? this.seatById.get(w.deskId)?.roomId : undefined;
    if (homeRoomId) ctx.homeRoomId = homeRoomId;
    return ctx;
  }

  private applyDirective(w: Worker, d: Resolved | undefined): void {
    if (!d || d.type === 'home') {
      w.perform = undefined;
      if (!w.target || w.target.x !== w.home.x || w.target.y !== w.home.y) this.walkTo(w, w.home, w.homeArrive);
      else if (!w.path.length && w.phase !== 'leaving') w.phase = restPhase(w.pos, w.home, w.homeArrive, w.phase); // sit back down
      if (d?.hurry && w.path.length) w.hurry = true;
      return;
    }
    if (d.type === 'hold') {
      // Its destination is taken: wait on the current tile (at the desk, keep sitting).
      w.perform = undefined;
      const here = { x: Math.round(w.pos.x), y: Math.round(w.pos.y) };
      const atHome = here.x === w.home.x && here.y === w.home.y;
      const stay = atHome ? w.home : here;
      if (!w.target || w.target.x !== stay.x || w.target.y !== stay.y) this.walkTo(w, stay, atHome ? w.homeArrive : 'standing');
      return;
    }
    const to = d.type === 'go' ? d.to : d.at;
    w.perform = d.type === 'do' ? d : undefined;
    // A destination at its own home (e.g. a stretch at the desk) keeps the home's resting phase.
    if (!w.target || w.target.x !== to.x || w.target.y !== to.y) this.walkTo(w, to, restPhase(to, w.home, w.homeArrive, 'standing'));
  }

  /** Route a worker (planRoute: walls, furniture and the layout edge are never crossed). */
  private walkTo(w: Walker, target: Point, arrive: Phase): void {
    const route = planRoute(w.pos, target, this.ok);
    if (route.place) {
      w.pos.x = route.place.x;
      w.pos.y = route.place.y;
    }
    w.path = route.path;
    w.target = { x: target.x, y: target.y };
    w.arrive = arrive;
    w.phase = route.path.length ? 'walking' : arrive;
  }

  /** Put a worker on a tile at once (recovery). */
  private place(w: Walker, at: Point, arrive: Phase): void {
    w.pos.x = at.x;
    w.pos.y = at.y;
    w.path = [];
    w.target = { x: at.x, y: at.y };
    w.arrive = arrive;
    w.phase = arrive;
  }

  private createWorker(v: WorkerView, at: Point): Worker {
    const role = v.kind === 'session' ? 'session' : v.kind === 'teammate' ? 'teammate' : 'subagent';
    const look = lookFor(v.key, role, v.sessionId);
    const node = new Container() as Container & { isWorker?: boolean };
    node.isWorker = true;
    const shadow = new Graphics();
    shadow.eventMode = 'none';
    const ring = new Graphics();
    ring.eventMode = 'none';
    ring.ellipse(0, -1, 8, 3).stroke({ color: 0xffe066, width: 1 });
    ring.visible = false;
    const sprite = new Sprite();
    sprite.eventMode = 'none';
    sprite.anchor.set(0.5, 1);
    node.addChild(shadow, ring, sprite);
    node.eventMode = this.editMode ? 'none' : 'static';
    node.cursor = 'pointer';
    node.hitArea = new Rectangle(-7, -CHAR_H, 14, CHAR_H);
    const bubble = new Sprite();
    bubble.eventMode = 'none';
    bubble.anchor.set(0.5, 1);
    this.fxLayer.addChild(bubble);
    const label = new Text({
      text: '',
      style: { fontFamily: LABEL_FONT, fontSize: 12, fill: '#ffffff', stroke: { color: '#1a1424', width: 3 }, align: 'center' },
      resolution: 2,
    });
    label.anchor.set(0.5, 1);
    this.overlay.addChild(label);
    const w: Worker = {
      view: v,
      look,
      lookKey: `${v.key}|${role}`,
      pos: { ...at },
      path: [],
      phase: 'walking',
      arrive: 'standing',
      deskId: null,
      facing: 'up',
      offset: hash(v.key) % 5000,
      node,
      sprite,
      shadow,
      ring,
      bubble,
      label,
      hovered: false,
      presAt: 0,
      watch: new ProgressWatch(),
      leaving: false,
      lastToolId: v.lastToolEnd?.id,
      lastStatus: v.status,
      lastTurn: v.turnCompletedAt,
      home: { ...at },
      homeArrive: 'standing',
      hurry: false,
      speech: this.createSpeech(),
    };
    node.on('pointertap', (e) => {
      e.stopPropagation();
      this.cb.onSelect(v.key);
    });
    node.on('pointerover', () => (w.hovered = true));
    node.on('pointerout', () => (w.hovered = false));
    this.items.addChild(node);
    return w;
  }

  private removeWorker(w: Worker): void {
    this.workers.delete(w.view.key);
    this.deptOf.delete(w.view.key);
    this.forgetActor(w.view.key);
    w.node.destroy({ children: true });
    w.bubble.destroy();
    w.label.destroy();
    w.speech.node.destroy({ children: true });
    // Character textures are per look; free them once nobody with this look is left.
    const prefix = `${w.lookKey}|`;
    for (const [k, t] of this.textures) {
      if (!k.startsWith(prefix)) continue;
      t.destroy(true);
      this.textures.delete(k);
    }
  }

  /** Sprite pose, flip, bubble and alpha for a worker this frame (written into the reused `po`). */
  private pose(w: Worker, now: number): { pose: Pose; flip: boolean; bubble?: BubbleKind; alpha: number } {
    const v = w.view;
    const t = now + w.offset;
    const out = this.po;
    let alpha = v.status === 'unknown' ? 0.65 : v.stale ? 0.85 : 1;
    if (w.phase === 'walking' || w.phase === 'leaving') {
      const f = (Math.floor(t / 125) % 4) as 0 | 1 | 2 | 3;
      const dir = w.facing === 'up' ? 'up' : w.facing === 'down' ? 'down' : 'side';
      if (w.phase === 'leaving' && w.path.length <= 1) alpha *= 0.7;
      out.pose = `walk_${dir}_${f}`;
      out.flip = w.facing === 'left';
      out.bubble = undefined;
      out.alpha = alpha;
      return out;
    }
    const seated = w.phase === 'seated';
    const celebrating = this.celebrating(v, now);
    // Alternating poses blink; with reduced motion they hold their "on" frame.
    const blink2 = (ms: number) => this.reduceMotion || Math.floor(t / ms) % 2 === 0;
    const pres = w.pres ?? this.presentation(w, now);
    let pose: Pose = seated ? 'sit' : 'stand';
    let flip = false;
    let bubble: BubbleKind | undefined;
    switch (v.status) {
      case 'working':
        // Desk animation follows the REAL running tool (workPresentation); "thinking" only when
        // the reducer says so. Without a desk, a thinking agent ponders; otherwise it stands by.
        if (seated) pose = seatedFrame(pres.seatedPose, this.reduceMotion ? 0 : t);
        else if (pres.mode === 'thinking') {
          pose = 'think';
          bubble = 'thinking';
        }
        break;
      case 'waiting_permission':
        pose = seated ? seatedFrame('sit_raise', this.reduceMotion ? 0 : t) : blink2(550) ? 'stand_raise' : 'stand';
        bubble = 'permission';
        break;
      case 'waiting_input':
        bubble = 'question';
        break;
      case 'completed':
        pose = seated ? seatedFrame('sit_cheer', this.reduceMotion ? 0 : t) : blink2(300) ? 'stand_cheer' : 'stand';
        bubble = 'done';
        break;
      case 'failed':
        pose = seated ? 'sit_slump' : 'stand_slump';
        bubble = 'failed';
        break;
      case 'unknown':
        bubble = 'unknown';
        break;
      case 'idle':
        if (celebrating) {
          pose = seated ? seatedFrame('sit_cheer', this.reduceMotion ? 0 : t) : blink2(300) ? 'stand_cheer' : 'stand';
          bubble = 'done';
        } else if (seated) {
          // Neutral idle variety at the desk (stretch, sip); per-worker rhythm, see poses.ts.
          pose = idleDeskPose(t, { sipping: this.director.isSipping(v.key, now), still: this.reduceMotion, variant: w.offset });
        } else if (!v.stale) {
          // Standing idle (no desk, or waiting for a free spot): an occasional glance around.
          const sp = idleStandPose(t, w.offset, this.reduceMotion);
          pose = sp.pose;
          flip = sp.flip;
        }
        break;
      default:
        break;
    }
    if (w.perform && (v.status === 'idle' || w.perform.verified) && !w.path.length) {
      const p = w.perform;
      const sp = spritePose(p.pose, p.face, { activity: p.activity, frame: this.reduceMotion ? 0 : Math.floor(t / 250) });
      pose = sp.pose;
      flip = sp.flip;
      // A speech line replaces the chat icon (one bubble at a time).
      bubble = bubble ?? (p.speech ? undefined : p.bubble);
    } else if (v.stale && !bubble) bubble = 'stale';
    out.pose = pose;
    out.flip = flip;
    out.bubble = bubble;
    out.alpha = alpha;
    return out;
  }

  private celebrating(v: WorkerView, now: number): boolean {
    return v.kind === 'session' && v.status === 'idle' && v.turnCompletedAt !== undefined && now - v.turnCompletedAt < CELEBRATE_MS;
  }

  /** Desk pose + monitor screen for the worker's REAL state (fixed local rules, see poses.ts). */
  private presentation(w: Worker, now: number): WorkPresentation {
    const v = w.view;
    const input: WorkInput = { status: v.status, stale: v.stale };
    if (v.statusDetail) input.detail = v.statusDetail;
    if (v.toolRunning && v.toolName) {
      input.toolName = v.toolName;
      if (v.toolSummary) input.toolSummary = v.toolSummary;
    }
    if (v.failureOpen && v.failure && now - v.failure.at < RECENT_FAILURE_MS) input.recentFailure = v.failure.kind;
    if (this.celebrating(v, now)) input.justFinished = true;
    return workPresentation(input);
  }

  /** Monitor screen for the desk's worker (its REAL state), or off without one. */
  private screenKind(w: Worker | undefined, now: number): ScreenKind {
    return w ? (w.pres ?? this.presentation(w, now)).screen : 'off';
  }

  /** Walk and draw the simulated visitors (sprite, icon bubble, hover label, simulated speech). */
  private drawGuests(now: number, dt: number): void {
    if (!this.guests.size) return;
    const zoom = this.cam.zoom;
    const ox = this.root.position.x;
    const oy = this.root.position.y;
    for (const g of this.guests.values()) {
      this.advance(g, SPEED * VISITOR_PACE * dt);
      const walking = g.path.length > 0;
      if (!walking && g.phase === 'walking') g.phase = g.arrive;
      const t = now + g.offset;
      const p = !walking ? g.perform : undefined;
      let pose: Pose;
      let flip = false;
      let bubble: BubbleKind | undefined;
      if (walking) {
        const f = (Math.floor(t / 125) % 4) as 0 | 1 | 2 | 3;
        pose = `walk_${g.facing === 'up' ? 'up' : g.facing === 'down' ? 'down' : 'side'}_${f}`;
        flip = g.facing === 'left';
      } else if (p) {
        const sp = spritePose(p.pose, p.face, { activity: p.activity, frame: this.reduceMotion ? 0 : Math.floor(t / 250) });
        pose = sp.pose;
        flip = sp.flip;
        bubble = p.speech ? undefined : p.bubble;
      } else {
        const sp = idleStandPose(t, g.offset, this.reduceMotion);
        pose = sp.pose;
        flip = sp.flip;
      }
      if (pose !== g.shownPose) {
        g.shownPose = pose;
        g.sprite.texture = this.t(`${g.lookKey}|${pose}`, () => drawCharacter(g.look, pose));
      }
      g.sprite.scale.x = flip ? -1 : 1;
      // Out through the door: hidden until the director lets it go (next behavior tick).
      const gone = g.leaving && !walking;
      const hidden = gone || Boolean(p?.hidden);
      const onCouch = p?.pose === 'couch';
      const px = g.pos.x * TILE + TILE / 2;
      const py = (g.pos.y + 1) * TILE - 1 - (onCouch ? 3 : 0);
      g.node.position.set(px, py);
      // Layered like a standing agent: in front of a chair it sits on (chairs facing up excepted).
      g.node.zIndex = onCouch ? (g.pos.y + 1) * TILE + 1 : py;
      g.node.visible = !hidden;
      g.node.alpha = g.leaving && g.path.length <= 1 ? 0.7 : 1;

      const headY = py - CHAR_H;
      g.bubble.visible = Boolean(bubble) && !hidden;
      if (bubble && !hidden) {
        if (bubble !== g.shownBubble) {
          g.shownBubble = bubble;
          g.bubble.texture = this.t(`bubble-${bubble}`, () => drawBubble(bubble));
        }
        g.bubble.position.set(px, headY - 1);
      }

      const sx = ox + px * zoom;
      const sy = oy + py * zoom;
      const onScreen = sx > -8 && sx < this.viewSize.w + 8 && sy > 0 && sy - CHAR_H * zoom < this.viewSize.h;
      const showLabel = onScreen && !hidden && !this.editMode && (g.hovered || this.showNames);
      g.label.visible = showLabel;
      if (showLabel) {
        const above = headY - (bubble ? BUBBLE_H + 1 : 1);
        const half = g.label.width / 2 + 2;
        g.label.position.set(Math.round(Math.min(Math.max(sx, half), this.viewSize.w - half)), Math.round(Math.max(oy + above * zoom, g.label.height)));
        g.label.zIndex = g.hovered ? 2 : 1;
      }
      const line = p && !this.editMode ? p.speech : undefined;
      this.showSpeech(g.speech, line, onScreen && !hidden, px, headY - (bubble ? BUBBLE_H + 1 : 1), showLabel ? g.label.height + 2 : 2);
    }
  }

  private frame(dtMs: number): void {
    if (!this.layout) return;
    const now = Date.now();
    if (now - this.lastReconcile > 500) this.reconcile(false);
    const sec = Math.floor(now / 1000);
    if (sec !== this.lastSec) {
      // Lighting and the wall clock change at most once a second.
      this.lastSec = sec;
      const sky = skyFor(this.hour());
      if (sky !== this.sky) {
        this.sky = sky;
        this.buildRoom();
      }
      this.drawClock(new Date(now));
      if (this.sound) {
        // Keyboard ambience follows the agents really typing at their desks right now.
        let typing = 0;
        for (const w of this.workers.values()) if (w.phase === 'seated' && w.pres && TYPING_SCREENS.has(w.pres.screen)) typing++;
        this.sound.ambience(typing, this.sky === 'night');
      }
    }
    const dt = Math.min(dtMs, 100) / 1000;
    const occupied = this.occupied;
    occupied.clear();
    const dark = DARKNESS[this.sky];

    if (this.camGoal) {
      this.cam = approach(this.cam, this.camGoal, dtMs);
      if (this.cam === this.camGoal) this.camGoal = undefined;
      this.applyCamera();
    }
    const zoom = this.cam.zoom;
    const ox = this.root.position.x;
    const oy = this.root.position.y;

    if (now - this.lastDirect > 200) {
      this.lastDirect = now;
      this.runBehaviors(now);
    }

    // (Deleting the current entry while iterating a Map is safe.)
    for (const w of this.workers.values()) {
      this.advance(w, SPEED * (w.hurry ? 1.9 : 1) * dt);
      if (!w.path.length) w.hurry = false;
      if (!w.path.length && w.phase === 'walking') w.phase = w.arrive;
      if (!w.path.length && w.phase === 'leaving') {
        this.removeWorker(w);
        continue;
      }
      // The desk monitor always reflects the agent's real status, even while it is away.
      if (w.deskId && !w.leaving) occupied.set(w.deskId, w);

      // The real-state presentation only changes with the view (and slowly with time).
      if (!w.pres || w.presView !== w.view || now - w.presAt >= 250) {
        w.pres = this.presentation(w, now);
        w.presView = w.view;
        w.presAt = now;
      }
      const { pose, flip, bubble, alpha } = this.pose(w, now);
      if (pose !== w.shownPose) {
        w.shownPose = pose;
        w.sprite.texture = this.t(`${w.lookKey}|${pose}`, () => drawCharacter(w.look, pose));
      }
      w.sprite.scale.x = flip ? -1 : 1;
      w.node.alpha = alpha;
      const seated = w.phase === 'seated';
      const px = w.pos.x * TILE + TILE / 2;
      const resting = !w.path.length && w.perform !== undefined;
      const onCouch = resting && w.perform!.pose === 'couch';
      const hidden = resting && Boolean(w.perform!.hidden);
      const py = (w.pos.y + 1) * TILE - (seated ? 0 : 1) - (onCouch ? 3 : 0);
      w.node.position.set(px, py);
      w.node.zIndex = seated ? py - 1 : onCouch ? (w.pos.y + 1) * TILE + 1 : py;
      w.node.visible = !hidden;
      const isSel = this.selected === w.view.key;
      if (w.shadowSeated !== seated) {
        w.shadowSeated = seated;
        w.shadow.clear();
        if (!seated) w.shadow.ellipse(0, -1, 5, 2).fill({ color: 0x000000, alpha: 0.28 });
      }
      w.ring.visible = isSel;
      if (isSel) w.ring.alpha = this.reduceMotion ? 0.9 : 0.6 + 0.4 * Math.sin(now / 200);

      const headY = py - CHAR_H + (seated ? 1 : 0);
      if (bubble && !hidden) {
        w.bubble.visible = true;
        if (bubble !== w.shownBubble) {
          w.shownBubble = bubble;
          w.bubble.texture = this.t(`bubble-${bubble}`, () => drawBubble(bubble));
        }
        const bob = !this.reduceMotion && (bubble === 'permission' || bubble === 'question') ? Math.round(Math.sin((now + w.offset) / 220) * 1.5) : 0;
        w.bubble.position.set(px, headY - 1 + bob);
        w.bubble.alpha = alpha;
      } else {
        w.bubble.visible = false;
      }

      const attention = w.view.status === 'waiting_permission' || w.view.status === 'waiting_input' || w.view.status === 'failed';
      const sx = ox + px * zoom;
      const sy = oy + py * zoom;
      const onScreen = sx > -8 && sx < this.viewSize.w + 8 && sy > 0 && sy - CHAR_H * zoom < this.viewSize.h;
      const showLabel = onScreen && !hidden && (isSel || w.hovered || ((this.showNames || attention) && w.phase !== 'leaving'));
      w.label.visible = showLabel;
      if (showLabel) {
        const name = w.view.simulated ? `SIM ${w.view.name}` : w.view.name;
        const text = isSel || w.hovered ? name : name.length > 14 ? name.slice(0, 13) + '…' : name;
        if (w.label.text !== text) w.label.text = text;
        const fill = isSel ? '#ffe066' : attention ? '#ffd6a0' : '#ffffff';
        if (fill !== w.labelFill) {
          w.labelFill = fill;
          w.label.style.fill = fill;
        }
        const above = headY - (bubble ? BUBBLE_H + 1 : 1);
        const half = w.label.width / 2 + 2;
        const maxX = this.viewSize.w - half;
        w.label.position.set(Math.round(Math.min(Math.max(ox + px * zoom, half), maxX)), Math.round(Math.max(oy + above * zoom, w.label.height)));
        w.label.zIndex = isSel || w.hovered ? 2 : 1;
      }

      // Simulated speech (local template line from the idle director / meetings).
      const line = resting && w.view.status === 'idle' && !this.editMode ? w.perform!.speech : undefined;
      this.showSpeech(w.speech, line, onScreen && !hidden, px, headY - (bubble ? BUBBLE_H + 1 : 1), showLabel ? w.label.height + 2 : 2);
    }
    this.drawGuests(now, dt);

    // monitors, their light and the QA build lamps (textures swapped only on change)
    for (const [deskId, d] of this.desks) {
      const w = occupied.get(deskId);
      const kind = this.screenKind(w, now);
      const anim = SCREEN_ANIMATION[kind];
      // With reduced motion every screen holds its first frame (no scrolling or flashing).
      const frame = !w || this.reduceMotion || anim.frames <= 1 ? 0 : Math.floor((now + w.offset) / anim.ms) % anim.frames;
      if (kind !== d.shownKind || frame !== d.shownFrame) {
        d.shownKind = kind;
        d.shownFrame = frame;
        const seed = SEEDED_SCREENS.has(kind) ? d.variant : 0;
        d.screen.texture = this.t(`screen-${kind}-${frame}-${seed}`, () => drawScreen(kind, frame, seed));
      }
      const color = SCREEN_LIGHT[kind];
      d.glow.visible = color !== undefined;
      if (color !== undefined) {
        d.glow.tint = color;
        const flicker = this.reduceMotion
          ? 1
          : FLICKER_SCREENS.has(kind)
            ? 0.85 + 0.15 * Math.sin((now + d.variant * 300) / 90)
            : kind === 'perm' || kind === 'ask'
              ? 0.75 + 0.25 * Math.sin(now / 180)
              : 1;
        d.glow.alpha = (0.1 + dark * 0.9) * flicker;
      }
      if (d.lamp) {
        const state = qaLampState(w?.view);
        const lit = state !== 'run' || this.reduceMotion || Math.floor(now / 400) % 2 === 0;
        const lamp = lit ? state : `${state}-off`;
        if (lamp !== d.shownLamp) {
          d.shownLamp = lamp;
          d.lamp.texture = this.t(`qa-${state}-${lit}`, () => drawQaLamp(state, lit));
        }
      }
    }

    for (const tl of this.toilets) {
      const occ = this.spotBusy.has(tl.id);
      if ((occ ? 1 : -1) !== tl.shown) {
        tl.shown = occ ? 1 : -1;
        tl.sprite.texture = this.t(occ ? 'toilet1' : 'toilet0', () => drawToilet(occ));
      }
    }
    for (const cm of this.coffees) {
      const busy = this.spotBusy.has(cm.id);
      const f = this.reduceMotion ? 0 : Math.floor(now / 300) % 2;
      const shown = busy ? f : -1;
      if (shown !== cm.shown) {
        cm.shown = shown;
        cm.sprite.texture = this.t(busy ? `coffee-busy${f}` : 'coffee-idle', () => drawCoffeeMachine(f, busy));
      }
    }

    // ambient animation (frozen with reduced motion)
    for (const a of this.animated) {
      const f = this.reduceMotion ? 0 : Math.floor((now + a.offset) / a.ms) % a.frames;
      if (f !== a.shown) {
        a.shown = f;
        a.sprite.texture = this.t(`${a.key}${f}`, () => a.make(f));
      }
    }

    // particles and collaboration flights (the layer is only cleared while something is drawn)
    if (this.fxDirty || this.particles.length || this.flights.length) {
      this.fx.clear();
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i]!;
        p.life -= dt;
        if (p.life <= 0) {
          this.particles.splice(i, 1);
          continue;
        }
        p.vy += p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        this.fx.rect(Math.round(p.x), Math.round(p.y), p.size, p.size).fill({ color: p.color, alpha: Math.min(1, (p.life / p.max) * 1.5) });
      }
      this.drawFlights();
      this.fxDirty = this.particles.length > 0 || this.flights.length > 0;
    }

    // Overlay labels only move with the camera.
    const lc = this.labelCam;
    if (lc.x !== ox || lc.y !== oy || lc.zoom !== zoom) {
      lc.x = ox;
      lc.y = oy;
      lc.zoom = zoom;
      const place = (l: Labelled) => {
        if (l.tile) l.position.set(Math.round(ox + (l.tile.x * TILE + 2) * zoom), Math.round(oy + (l.tile.y * TILE + 1) * zoom));
      };
      for (const l of this.zoneLabels) place(l);
      for (const l of this.roomLabels) place(l);
      if (this.boardBadge) place(this.boardBadge as Labelled);
    }
  }

  // ------------------------------------------------------------- pointer / camera / editing

  private tileAt(e: FederatedPointerEvent): Point {
    const p = this.root.toLocal(e.global);
    return { x: Math.floor(p.x / TILE), y: Math.floor(p.y / TILE) };
  }

  private startPress(e: FederatedPointerEvent, tile: Point | undefined, pan: boolean): void {
    this.press = { start: { x: e.global.x, y: e.global.y }, cam: { ...this.cam }, moved: false, tile, pan };
  }

  /** Margins around the office: drag to pan; a click deselects. */
  private onBackdropDown(e: FederatedPointerEvent): void {
    this.startPress(e, undefined, true);
  }

  private onFloorDown(e: FederatedPointerEvent): void {
    if (!this.layout) return;
    // Middle/right button always pans (also in edit mode).
    if (e.button === 1 || e.button === 2) {
      this.startPress(e, undefined, true);
      return;
    }
    if (!this.editMode) {
      // Drag pans the camera; a click (no drag) deselects and opens the room info.
      this.startPress(e, this.tileAt(e), true);
      return;
    }
    const tile = this.tileAt(e);
    const item = this.layout.items.find((i) => i.x === tile.x && i.y === tile.y);
    if (item) {
      const ghost = new Graphics();
      ghost.rect(0, 0, TILE, TILE).fill({ color: 0xffe066, alpha: 0.35 });
      ghost.position.set(tile.x * TILE, tile.y * TILE);
      this.editLayer.addChild(ghost);
      this.drag = { id: item.id, from: tile, ghost, moved: false };
    } else {
      this.cb.onTileClick(tile.x, tile.y);
    }
  }

  private onFloorMove(e: FederatedPointerEvent): void {
    const p = this.press;
    if (p) {
      const dx = e.global.x - p.start.x;
      const dy = e.global.y - p.start.y;
      if (!p.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) p.moved = true;
      if (p.moved && p.pan) {
        this.camTouched = true;
        this.camGoal = undefined;
        this.cam = panBy(p.cam, dx, dy, this.worldSize(), this.viewSize);
        this.applyCamera();
      }
      return;
    }
    if (!this.drag) return;
    const tile = this.tileAt(e);
    this.drag.ghost.position.set(tile.x * TILE, tile.y * TILE);
    if (tile.x !== this.drag.from.x || tile.y !== this.drag.from.y) this.drag.moved = true;
  }

  private onFloorUp(e: FederatedPointerEvent): void {
    const p = this.press;
    if (p) {
      this.press = undefined;
      if (!p.moved && !this.editMode && e.button !== 2 && e.button !== 1) {
        this.cb.onSelect(null);
        const room = p.tile && this.layout ? roomAt(this.layout, p.tile) : undefined;
        this.cb.onRoomClick?.(room?.id ?? null);
      }
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = undefined;
    d.ghost.destroy();
    const tile = this.tileAt(e);
    if (d.moved && (tile.x !== d.from.x || tile.y !== d.from.y)) this.cb.onItemMove(d.id, tile.x, tile.y);
    else this.cb.onTileClick(d.from.x, d.from.y);
  }

  /** Test/diagnostic hook: what the scene is currently showing. */
  debugSnapshot(): Array<{
    key: string;
    phase: Phase;
    deskId: string | null;
    status: AgentStatus;
    label: string;
    color: string;
    screen?: ScreenKind;
    activity?: string;
    speech?: string;
    meeting?: string;
  }> {
    return [...this.workers.values()].map((w) => {
      const out: ReturnType<OfficeScene['debugSnapshot']>[number] = {
        key: w.view.key,
        phase: w.phase,
        deskId: w.deskId,
        status: w.view.status,
        label: w.view.name,
        color: STATUS_META[w.view.status].color,
      };
      if (w.pres) out.screen = w.pres.screen;
      if (w.perform) out.activity = w.perform.activity;
      if (w.perform?.speech) out.speech = w.perform.speech;
      const m = this.meetings.meetingOf(w.view.key);
      if (m) out.meeting = m.id;
      return out;
    });
  }

  /** Test/diagnostic hook: collaboration flights in the air. */
  debugFlights(): Array<{ id: string; kind: CollabVisual['kind']; to: string }> {
    return this.flights.map((f) => ({ id: f.id, kind: f.kind, to: f.to }));
  }

  /** Test/diagnostic hook: simulated visitors (never agents) and what they are doing. */
  debugVisitors(): Array<{ id: string; x: number; y: number; visible: boolean; leaving: boolean; activity?: string; speech?: string; simulated: true }> {
    return [...this.guests.values()].map((g) => {
      const out: ReturnType<OfficeScene['debugVisitors']>[number] = { id: g.id, x: g.pos.x, y: g.pos.y, visible: g.node.visible, leaving: g.leaving, simulated: true };
      if (g.perform) out.activity = g.perform.activity;
      if (g.perform?.speech) out.speech = g.perform.speech;
      return out;
    });
  }
}
