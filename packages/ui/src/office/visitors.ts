/**
 * SIMULATED visitors: people who are not agents and walk through the office, so it has some
 * life even when no Claude Code agent is idle, or none is running at all. A visitor comes in
 * through the office door, usually checks in at reception, makes one to three stops (looks
 * around a room, gets a coffee, water or a snack, uses the restroom, looks out of a window,
 * reads the noticeboard, sits down for a bit), now and then chats with another visitor, and
 * leaves through the door again.
 *
 * Purely cosmetic, local and deterministic for an injected RNG. Guarantees:
 * - Never an agent. Visitors have their own ids (`visitor-<n>`). The scene keeps them out of
 *   the agent list, the mini-map, room cards and every count, they cannot be selected, and
 *   they wear a lavender visitor badge.
 * - Agents always win. The scene passes the tiles agents stand on or are heading to (`taken`).
 *   A visitor never picks such a tile, and moves on at once when an agent wants its tile.
 * - One visitor per tile and per spot, at most `maxVisitors` in the office at once.
 * - SIMULATED speech: only verbatim lines from the local template table (the visitor rules in
 *   dialogue.ts), drawn by the scene in the dashed lavender "simulated" bubble.
 * - setEnabled(false) sends every visitor out and stops arrivals; setFrequency(m) makes
 *   arrivals m times as frequent. At night visitors come less often.
 *
 * No rendering here: the scene feeds the visitors' bodies in and applies the directives.
 */
import type { RoomKind } from '@agent-office/core';
import type { ChatIcon, Directive, Face, Point, SpotKind, World } from './behavior';
import { pickLine, type DialogueFamily, type DialogueRole } from './dialogue';
import { lookAround } from './idleLife';
import { roomSeats } from './meetings';
import type { OfficeWorld } from './world';

export type VisitorActivity =
  | 'reception'
  | 'visit'
  | 'chat'
  /** A small group of visitors sits together in a meeting, collaboration or break room. */
  | 'meeting'
  | 'toilet'
  | 'coffee'
  | 'water'
  | 'snack'
  | 'window'
  | 'board'
  | 'books'
  | 'whiteboard'
  | 'couch'
  | 'lounge';

/** Stops at a World spot of the same kind. */
const SPOT_STOPS = ['toilet', 'coffee', 'water', 'snack', 'window', 'board', 'books', 'whiteboard', 'couch'] as const satisfies readonly (VisitorActivity & SpotKind)[];
type SpotStop = (typeof SPOT_STOPS)[number];

/** Stops a visitor can plan after reception (chats happen on the way; meetings are group visits). */
export type PlannedStop = Exclude<VisitorActivity, 'reception' | 'chat' | 'meeting'>;

/** Rooms where a group of visitors can hold a meeting. */
const MEETING_ROOMS: ReadonlySet<RoomKind> = new Set<RoomKind>(['meeting', 'collaboration', 'break']);
const MEETING_ICONS: ChatIcon[] = ['chat_idea', 'chat_dots', 'chat_laugh', 'chat_heart', 'chat_idea'];
/** One bubble turn in a visitor meeting; a bubble shows for the first MEETING_BUBBLE_MS. */
const MEETING_TURN_MS = 2_400;
const MEETING_BUBBLE_MS = 1_600;
/** Members that have not sat down by then are let go (the rest start without them). */
const MEETING_ARRIVAL_MS = 60_000;
/** Gap between two members leaving at the end. */
const MEETING_STAGGER_MS = 900;

/** Why a meeting could not be started on request. */
export type MeetingRequest = 'ok' | 'disabled' | 'already' | 'busy' | 'no-seats';

/** Read-only view of the visitors' meeting (always simulated, never agents). */
export interface VisitorMeetingInfo {
  id: string;
  roomId: string;
  roomName: string;
  roomKind: RoomKind;
  phase: 'gathering' | 'meeting' | 'ending';
  visitors: readonly string[];
  startedAt?: number;
  endsAt?: number;
  simulated: true;
}

const STOP_WEIGHT: Record<PlannedStop, number> = {
  visit: 4,
  coffee: 2,
  water: 1.5,
  toilet: 1.5,
  snack: 1,
  window: 1,
  board: 1,
  books: 1,
  whiteboard: 0.5,
  couch: 1,
  lounge: 1,
};

const DURATION: Record<VisitorActivity, [number, number]> = {
  reception: [4_000, 7_000],
  visit: [4_000, 8_000],
  chat: [8_000, 13_000],
  toilet: [6_000, 10_000],
  coffee: [4_000, 5_000],
  water: [3_000, 5_000],
  snack: [4_000, 6_000],
  window: [5_000, 8_000],
  board: [3_000, 6_000],
  books: [6_000, 10_000],
  whiteboard: [4_000, 6_000],
  couch: [10_000, 20_000],
  lounge: [8_000, 16_000],
  meeting: [120_000, 240_000], // see VisitorOptions.meetingDuration
};

/** Rooms a visitor never walks into to look around (reception has its own stop). */
const NO_VISIT: ReadonlySet<RoomKind> = new Set<RoomKind>(['restroom', 'corridor', 'reception']);

const CHAT_ICONS: ChatIcon[] = ['chat_coffee', 'chat_heart', 'chat_laugh', 'chat_idea', 'chat_dots'];
const SPEAK_MS = 2_200;
const SPEAK_GAP_MS = 300;
const SOLO_SPEECH_MS = 2_600;
/** Give up a stop (or a chat partner) not reached in this time. */
const GO_TIMEOUT_MS = 45_000;
/** A visitor whose planned stops all stay taken for this long goes home. */
const GIVE_UP_MS = 30_000;
const SAID_MEMORY = 6;

export interface VisitorOptions {
  /** At most this many visitors in the office at once. */
  maxVisitors: number;
  /** Delay before the first visitor arrives (ms). */
  firstArrival: [number, number];
  /** Time between arrivals (ms), divided by the frequency multiplier. */
  arrivalGap: [number, number];
  /** Stops after reception (inclusive range). */
  stops: [number, number];
  /** Chance (0..1) that a visitor checks in at reception first (when there is one). */
  receptionChance: number;
  /** Chance (0..1) that a visitor between stops chats with another free visitor. */
  chatChance: number;
  /** Pause between two stops (ms). */
  pause: [number, number];
  /** Chance (0..1) of one simulated line at the start of a solo stop. Default 0.4. */
  soloSpeechChance?: number;
  /** Chance (0..1) that a middle chat turn is small talk instead of an icon. Default 0.35. */
  smallTalkChance?: number;
  /** Arrivals are this many times rarer while the office is in night mode. Default 2. */
  nightFactor?: number;
  /** Chance (0..1) that an arrival is a small group coming for a meeting (when a room is free). */
  meetingChance: number;
  /** Size of a visitor meeting (inclusive). On top of `maxVisitors`; one meeting at a time. */
  meetingSize: [number, number];
  /** How long a visitor meeting lasts once everyone has sat down (ms). */
  meetingDuration: [number, number];
  /** Local hour (0-23) for time-of-day lines. Default: the local clock. */
  hourOf?: (now: number) => number;
}

export const DEFAULT_VISITOR_OPTIONS: VisitorOptions = {
  maxVisitors: 3,
  firstArrival: [3_000, 10_000],
  arrivalGap: [20_000, 50_000],
  stops: [1, 3],
  receptionChance: 0.8,
  chatChance: 0.5,
  pause: [1_200, 3_500],
  meetingChance: 0.3,
  meetingSize: [2, 3],
  meetingDuration: [120_000, 240_000],
};

/** The world as visitors see it: the behavior world, its extras, and the office door. */
export interface VisitorWorld extends World, Partial<Pick<OfficeWorld, 'lounges' | 'counters'>> {
  /** Tile just outside the office door, where visitors arrive and leave. */
  door: Point;
}

/** Where the scene shows a visitor right now. */
export interface VisitorBody {
  id: string;
  /** Rounded tile. */
  pos: Point;
  moving: boolean;
}

type DoDirective = Extract<Directive, { type: 'do' }>;

export type VisitorDirective =
  /** Walk to a tile. */
  | { type: 'go'; to: Point }
  /** Do an activity there (same shape as the agents' simulated activities). */
  | DoDirective
  /** Stand where you are (between two stops). */
  | { type: 'wait' }
  /** Walk out through the door; the visitor is gone once it gets there. */
  | { type: 'leave'; to: Point };

/** Read-only snapshot for diagnostics and tests. */
export interface VisitorInfo {
  id: string;
  /** Seed for the visitor's look. */
  look: string;
  phase: 'between' | 'going' | 'doing' | 'leaving';
  activity?: VisitorActivity;
  /** Stops still planned. */
  plan: readonly VisitorActivity[];
  simulated: true;
}

interface ChatTurn {
  speech?: string;
  icon?: ChatIcon;
}

interface Stop {
  kind: VisitorActivity;
  phase: 'go' | 'do';
  target: Point;
  face: Face;
  spotId?: string;
  partner?: string;
  leader?: boolean;
  startedAt: number;
  doAt?: number;
  doneAt?: number;
  seed: number;
  script?: ChatTurn[];
  speech?: string;
  /** Meetings: this member's place in the group and the group size (who "talks" when). */
  slot?: number;
  size?: number;
}

interface VisitorMeeting {
  id: string;
  roomId: string;
  roomName: string;
  roomKind: RoomKind;
  members: string[];
  phase: 'gathering' | 'meeting' | 'ending';
  createdAt: number;
  startedAt?: number;
  endsAt?: number;
}

interface Visitor {
  id: string;
  look: string;
  plan: VisitorActivity[];
  stop?: Stop;
  leaving: boolean;
  chatted: boolean;
  /** Set for members of a visitor meeting: when they get up at the end. */
  leaveAt?: number;
  /** No new stop before this time. */
  nextAt: number;
  /** Since when no planned stop had a free place (visitors give up after GIVE_UP_MS). */
  freeSince?: number;
  said: string[];
}

const key = (p: Point) => `${p.x},${p.y}`;
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const dist = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export class VisitorDirector {
  readonly name = 'visitors';
  private visitors = new Map<string, Visitor>();
  private reserved = new Map<string, string>(); // resource -> visitor id
  private world: VisitorWorld = { spots: [], chatTiles: [], rooms: [], night: false, door: { x: 0, y: 0 } };
  private worldSig = '';
  /** Free-standing tiles per room a visitor can walk into and look around from. */
  private visitTiles = new Map<string, Point[]>();
  private enabled = true;
  private freq = 1;
  private seq = 0;
  private nextArrival: number | undefined;
  private lastNow: number | undefined;
  /** Rooms not to visit this tick (see tick). */
  private busyRooms: ReadonlySet<string> = new Set();
  /** Agents' tiles as of the last tick (for meetings requested between ticks). */
  private lastTaken: ReadonlySet<string> = new Set();
  /** The visitors' meeting, if one is on (one at a time). */
  private meeting?: VisitorMeeting;
  private meetingSeq = 0;

  constructor(
    private readonly rng: () => number = Math.random,
    private readonly o: VisitorOptions = DEFAULT_VISITOR_OPTIONS,
  ) {}

  setWorld(world: VisitorWorld): void {
    const sig = JSON.stringify([world.spots, world.chatTiles, world.rooms, world.lounges ?? [], world.counters ?? [], world.door]);
    const changed = sig !== this.worldSig;
    this.world = world;
    this.worldSig = sig;
    if (!changed) return; // only the lighting changed
    this.visitTiles.clear();
    for (const t of world.chatTiles)
      for (const p of [t, { x: t.x + 1, y: t.y }]) {
        const room = world.rooms.find((r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h);
        if (!room || NO_VISIT.has(room.kind)) continue;
        const list = this.visitTiles.get(room.id) ?? [];
        if (!list.some((q) => same(q, p))) list.push(p);
        this.visitTiles.set(room.id, list);
      }
    // Spots may have moved: running stops end and everyone picks a new one (a meeting ends).
    this.meeting = undefined;
    for (const v of this.visitors.values()) if (v.stop) this.endStop(v, this.lastNow ?? 0);
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.nextArrival = undefined; // the first visitor comes soon after switching on
      return;
    }
    this.meeting = undefined;
    for (const v of this.visitors.values()) {
      if (v.stop) this.endStop(v, this.lastNow ?? 0);
      v.leaving = true;
    }
  }

  /** Arrival frequency multiplier from settings (1 = normal, 0.5 = half as often). */
  setFrequency(multiplier: number): void {
    const m = Number.isFinite(multiplier) && multiplier > 0 ? Math.min(10, Math.max(0.1, multiplier)) : 1;
    if (m === this.freq) return;
    const now = this.lastNow;
    if (now !== undefined && this.nextArrival !== undefined && this.nextArrival > now) this.nextArrival = now + ((this.nextArrival - now) * this.freq) / m;
    this.freq = m;
  }

  /** A visitor is using this spot (e.g. the restroom door shows "occupied"). */
  isInUse(spotId: string): boolean {
    for (const v of this.visitors.values()) if (v.stop?.spotId === spotId && v.stop.phase === 'do') return true;
    return false;
  }

  /** Seed of a visitor's look (stable for the visit). */
  lookOf(id: string): string | undefined {
    return this.visitors.get(id)?.look;
  }

  /** The visitors' meeting, if one is on. */
  currentMeeting(): VisitorMeetingInfo | undefined {
    const m = this.meeting;
    if (!m) return undefined;
    const info: VisitorMeetingInfo = { id: m.id, roomId: m.roomId, roomName: m.roomName, roomKind: m.roomKind, phase: m.phase, visitors: [...m.members], simulated: true };
    if (m.startedAt !== undefined) info.startedAt = m.startedAt;
    if (m.endsAt !== undefined) info.endsAt = m.endsAt;
    return info;
  }

  /**
   * Start a visitor meeting in `roomId` now (the room card's button). Visitors walk in through
   * the door and sit down. Agents still win: no seat an agent uses or wants is taken.
   */
  requestMeeting(roomId: string): MeetingRequest {
    if (!this.enabled) return 'disabled';
    if (this.meeting) return 'already';
    if (this.busyRooms.has(roomId)) return 'busy';
    return this.startMeeting(this.lastNow ?? 0, this.lastTaken, roomId) ? 'ok' : 'no-seats';
  }

  /** A group of 2-3 visitors comes in and takes free seats around one table. */
  private startMeeting(now: number, taken: ReadonlySet<string>, roomId?: string): boolean {
    if (this.meeting) return false;
    const rooms = this.world.rooms.filter((r) => MEETING_ROOMS.has(r.kind) && !this.busyRooms.has(r.id) && (!roomId || r.id === roomId));
    // Requested: that room; otherwise a random free one.
    for (let tries = rooms.length; tries > 0; tries--) {
      const room = rooms.splice(Math.min(rooms.length - 1, Math.floor(this.rng() * rooms.length)), 1)[0]!;
      const cx = room.x + (room.w - 1) / 2;
      const cy = room.y + (room.h - 1) / 2;
      const seats = roomSeats(room)
        .filter((s) => !taken.has(key(s.at)) && !this.reserved.has(`tile:${key(s.at)}`))
        .sort((a, b) => Math.abs(a.at.x - cx) + Math.abs(a.at.y - cy) - (Math.abs(b.at.x - cx) + Math.abs(b.at.y - cy)));
      const [lo, hi] = this.o.meetingSize;
      const n = Math.min(seats.length, Math.max(2, Math.floor(lo + this.rng() * (hi - lo + 1))));
      if (n < 2) continue;
      const m: VisitorMeeting = { id: `visitor-meeting-${++this.meetingSeq}`, roomId: room.id, roomName: room.name, roomKind: room.kind, members: [], phase: 'gathering', createdAt: now };
      const seed = this.rng();
      for (let i = 0; i < n; i++) {
        const seat = seats[i]!;
        const id = `visitor-${++this.seq}`;
        this.reserved.set(`tile:${key(seat.at)}`, id);
        const stop: Stop = { kind: 'meeting', phase: 'go', target: { ...seat.at }, face: seat.face, startedAt: now, seed, slot: i, size: n };
        this.visitors.set(id, { id, look: `${this.seq}-${Math.floor(this.rng() * 1e6)}`, plan: [], stop, leaving: false, chatted: true, nextAt: now, said: [] });
        m.members.push(id);
      }
      this.meeting = m;
      return true;
    }
    return false;
  }

  /** Gathering, the meeting itself, and members getting up one after another. Agents win at once. */
  private advanceMeeting(now: number, taken: ReadonlySet<string>, arrived: (v: Visitor) => boolean): void {
    const m = this.meeting;
    if (!m) return;
    const members = m.members.map((id) => this.visitors.get(id)).filter((v): v is Visitor => Boolean(v?.stop?.kind === 'meeting'));
    const release = (v: Visitor) => {
      v.stop = undefined;
      v.nextAt = now;
      this.release(v.id);
    };
    // An agent wants a seat, or agents meet in this room now: the visitors make room.
    if (this.busyRooms.has(m.roomId) || members.some((v) => taken.has(key(v.stop!.target)))) {
      for (const v of members) release(v);
      this.meeting = undefined;
      return;
    }
    if (m.phase === 'gathering') {
      const seated = members.filter(arrived);
      const late = now - m.createdAt > MEETING_ARRIVAL_MS;
      if (seated.length === members.length || (late && seated.length >= 2)) {
        for (const v of members) if (!seated.includes(v)) release(v);
        m.members = seated.map((v) => v.id);
        m.phase = 'meeting';
        m.startedAt = now;
        m.endsAt = now + this.between(this.o.meetingDuration);
        seated.forEach((v, i) => {
          v.stop!.phase = 'do';
          v.stop!.doAt = now;
          v.stop!.doneAt = m.endsAt;
          v.stop!.slot = i;
          v.stop!.size = seated.length;
        });
      } else if (late) {
        for (const v of members) release(v);
        this.meeting = undefined;
        return;
      }
    }
    if (m.phase === 'meeting' && m.endsAt !== undefined && now >= m.endsAt) {
      m.phase = 'ending';
      members.forEach((v, i) => (v.leaveAt = now + i * MEETING_STAGGER_MS));
    }
    if (m.phase === 'ending') for (const v of members) if (v.leaveAt !== undefined && now >= v.leaveAt) release(v);
    if (!m.members.some((id) => this.visitors.get(id)?.stop?.kind === 'meeting')) this.meeting = undefined;
  }

  currentVisitors(): VisitorInfo[] {
    return [...this.visitors.values()].map((v) => {
      const info: VisitorInfo = {
        id: v.id,
        look: v.look,
        phase: v.leaving ? 'leaving' : !v.stop ? 'between' : v.stop.phase === 'go' ? 'going' : 'doing',
        plan: [...v.plan],
        simulated: true,
      };
      if (v.stop) info.activity = v.stop.kind;
      return info;
    });
  }

  private between([a, b]: [number, number]): number {
    return a + this.rng() * (b - a);
  }

  private hour(now: number): number {
    return this.o.hourOf ? this.o.hourOf(now) : new Date(now).getHours();
  }

  private release(id: string): void {
    for (const [r, owner] of [...this.reserved]) if (owner === id) this.reserved.delete(r);
  }

  /** End the visitor's stop (and its chat partner's) and pause briefly before the next one. */
  private endStop(v: Visitor, now: number): void {
    const partner = v.stop?.partner;
    v.stop = undefined;
    v.nextAt = now + this.between(this.o.pause);
    this.release(v.id);
    if (partner) {
      const p = this.visitors.get(partner);
      if (p?.stop?.partner === v.id) {
        p.stop = undefined;
        p.nextAt = now + this.between(this.o.pause);
        this.release(partner);
      }
    }
  }

  private remember(v: Visitor, text: string): void {
    v.said.push(text);
    if (v.said.length > SAID_MEMORY) v.said.shift();
  }

  /** Which planned stops this world offers at all (ignoring who is using them right now). */
  private offered(): PlannedStop[] {
    const out: PlannedStop[] = [];
    if (this.visitTiles.size) out.push('visit');
    for (const k of SPOT_STOPS) if (this.world.spots.some((s) => s.kind === k)) out.push(k);
    if (this.world.lounges?.length) out.push('lounge');
    return out;
  }

  private makePlan(): VisitorActivity[] {
    const plan: VisitorActivity[] = [];
    if (this.world.counters?.length && this.rng() < this.o.receptionChance) plan.push('reception');
    const pool = this.offered();
    const [lo, hi] = this.o.stops;
    let n = Math.max(0, Math.floor(lo + this.rng() * (hi - lo + 1)));
    while (n-- > 0 && pool.length) {
      const total = pool.reduce((s, k) => s + STOP_WEIGHT[k], 0);
      let r = this.rng() * total;
      let i = pool.length - 1;
      for (let j = 0; j < pool.length; j++) if ((r -= STOP_WEIGHT[pool[j]!]) < 0) {
        i = j;
        break;
      }
      plan.push(pool.splice(i, 1)[0]!);
    }
    return plan;
  }

  /**
   * One step. `taken`: tiles ("x,y") agents stand on or are heading to. `busyRooms`: room ids
   * a visitor should not walk into to look around (e.g. a meeting is on there).
   */
  tick(now: number, bodies: readonly VisitorBody[], taken: ReadonlySet<string>, busyRooms: ReadonlySet<string> = new Set()): Map<string, VisitorDirective> {
    this.busyRooms = busyRooms;
    this.lastTaken = taken;
    this.lastNow = now;
    const out = new Map<string, VisitorDirective>();
    const byId = new Map(bodies.map((b) => [b.id, b]));
    const door = this.world.door;
    const posOf = (v: Visitor) => byId.get(v.id)?.pos ?? door;
    const movingOf = (v: Visitor) => byId.get(v.id)?.moving ?? false;

    // Arrivals: now and then a small group for a meeting, otherwise one visitor.
    if (this.nextArrival === undefined) this.nextArrival = now + this.between(this.o.firstArrival) / this.freq;
    if (this.enabled && now >= this.nextArrival) {
      const meetingIds = new Set(this.meeting?.members ?? []);
      const active = [...this.visitors.values()].filter((v) => !v.leaving && !meetingIds.has(v.id)).length;
      if (!this.meeting && this.rng() < this.o.meetingChance && this.startMeeting(now, taken)) {
        // a group came in
      } else if (active < this.o.maxVisitors) {
        const plan = this.makePlan();
        if (plan.length) {
          const id = `visitor-${++this.seq}`;
          this.visitors.set(id, { id, look: `${this.seq}-${Math.floor(this.rng() * 1e6)}`, plan, leaving: false, chatted: false, nextAt: now, said: [] });
        }
      }
      const night = this.world.night ? (this.o.nightFactor ?? 2) : 1;
      this.nextArrival = now + (this.between(this.o.arrivalGap) * night) / this.freq;
    }

    this.advanceMeeting(now, taken, (v) => byId.has(v.id) && !movingOf(v) && same(posOf(v), v.stop!.target));

    // Advance running stops; drop visitors that walked out.
    for (const v of [...this.visitors.values()]) {
      const at = posOf(v);
      const moving = movingOf(v);
      if (v.leaving) {
        if (byId.has(v.id) && !moving && same(at, door)) this.visitors.delete(v.id);
        continue;
      }
      const s = v.stop;
      if (!s || s.kind === 'meeting') continue; // meetings advance together (advanceMeeting)
      // An agent wants this tile: the visitor moves on at once (real activity wins).
      if (taken.has(key(s.target))) {
        this.endStop(v, now);
        v.nextAt = now;
        continue;
      }
      if (s.phase === 'go' && now - s.startedAt > GO_TIMEOUT_MS) {
        this.endStop(v, now);
        continue;
      }
      const arrived = !moving && same(at, s.target);
      if (s.phase === 'go' && arrived) {
        if (s.kind === 'chat') {
          const p = s.partner ? this.visitors.get(s.partner) : undefined;
          const ps = p?.stop;
          const partnerHere = p && ps && !movingOf(p) && same(posOf(p), ps.target);
          if (s.leader && p && ps && partnerHere && ps.phase === 'go') {
            const doneAt = now + this.between(DURATION.chat);
            const script = this.chatScript(v, p, doneAt - now, now);
            for (const st of [s, ps]) {
              st.phase = 'do';
              st.doAt = now;
              st.doneAt = doneAt;
              st.script = script;
            }
          }
        } else {
          s.phase = 'do';
          s.doAt = now;
          s.doneAt = now + this.between(DURATION[s.kind]);
          s.speech = this.soloLine(v, s.kind, now);
        }
      }
      if (s.phase === 'do' && s.doneAt !== undefined && now >= s.doneAt) this.endStop(v, now);
    }

    // Start the next stop (or a chat, or head out) for visitors standing between stops.
    const standing = new Set<string>();
    for (const v of this.visitors.values()) if (byId.has(v.id) && !movingOf(v)) standing.add(key(posOf(v)));
    for (const v of this.visitors.values()) {
      if (v.leaving || v.stop) continue;
      const at = posOf(v);
      // Standing where an agent is heading: go on now.
      if (taken.has(key(at))) v.nextAt = Math.min(v.nextAt, now);
      if (now < v.nextAt || movingOf(v)) continue;
      if (!this.enabled) {
        v.leaving = true;
        continue;
      }
      const free = (p: Point) => !taken.has(key(p)) && !this.reserved.has(`tile:${key(p)}`) && (!standing.has(key(p)) || same(p, at));
      if (this.tryChat(v, now, free, posOf)) continue;
      // The first planned stop with a free place; the others wait for later.
      for (let i = 0; i < v.plan.length && !v.stop; i++) if (this.startStop(v, v.plan[i]!, at, now, free)) v.plan.splice(i, 1);
      if (v.stop) continue;
      v.freeSince ??= now;
      if (!v.plan.length || now - v.freeSince > GIVE_UP_MS) v.leaving = true;
      else v.nextAt = now + this.between(this.o.pause);
    }

    // Directives.
    for (const v of this.visitors.values()) {
      if (v.leaving) {
        out.set(v.id, { type: 'leave', to: { ...door } });
        continue;
      }
      const s = v.stop;
      if (!s) {
        out.set(v.id, { type: 'wait' });
        continue;
      }
      if (s.phase === 'go') {
        const arrived = byId.has(v.id) && !movingOf(v) && same(posOf(v), s.target);
        out.set(v.id, arrived ? this.doing(s, now, true) : { type: 'go', to: { ...s.target } });
        continue;
      }
      out.set(v.id, this.doing(s, now, false));
    }
    return out;
  }

  /** Pick a concrete place for a planned stop and head there; false when none is free. */
  private startStop(v: Visitor, kind: VisitorActivity, from: Point, now: number, free: (p: Point) => boolean): boolean {
    const seed = this.rng();
    const nearest = <T extends { at: Point }>(list: T[]): T | undefined => list.reduce<T | undefined>((b, x) => (!b || dist(x.at, from) < dist(b.at, from) ? x : b), undefined);
    let place: { at: Point; face: Face; spotId?: string } | undefined;
    if (kind === 'reception') {
      place = nearest((this.world.counters ?? []).filter((c) => free(c.at)));
    } else if (kind === 'visit') {
      const here = this.world.rooms.find((r) => from.x >= r.x && from.x < r.x + r.w && from.y >= r.y && from.y < r.y + r.h)?.id;
      const rooms = [...this.visitTiles].filter(([id, tiles]) => id !== here && !this.busyRooms.has(id) && this.meeting?.roomId !== id && tiles.some(free));
      if (rooms.length) {
        const [roomId, tiles] = rooms[Math.min(rooms.length - 1, Math.floor(this.rng() * rooms.length))]!;
        const open = tiles.filter(free);
        const at = open[Math.min(open.length - 1, Math.floor(this.rng() * open.length))]!;
        const r = this.world.rooms.find((x) => x.id === roomId)!;
        const dx = r.x + (r.w - 1) / 2 - at.x;
        const dy = r.y + (r.h - 1) / 2 - at.y;
        place = { at, face: Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy < 0 ? 'up' : 'down' };
      }
    } else if (kind === 'lounge') {
      place = nearest((this.world.lounges ?? []).filter((l) => free(l.at)));
    } else if (kind !== 'chat') {
      const spot = nearest(this.world.spots.filter((s) => s.kind === (kind as SpotStop) && !this.reserved.has(`spot:${s.id}`) && free(s.at)));
      if (spot) place = { at: spot.at, face: spot.face, spotId: spot.id };
    }
    if (!place) return false;
    this.reserved.set(`tile:${key(place.at)}`, v.id);
    if (place.spotId) this.reserved.set(`spot:${place.spotId}`, v.id);
    v.stop = { kind, phase: 'go', target: { ...place.at }, face: place.face, startedAt: now, seed };
    if (place.spotId) v.stop.spotId = place.spotId;
    v.freeSince = undefined;
    return true;
  }

  /**
   * Maybe start a chat with another visitor (once per visit each). The other one is standing
   * between stops or still on its way to one; that stop is then put back at the front of its
   * plan for after the chat.
   */
  private tryChat(v: Visitor, now: number, free: (p: Point) => boolean, posOf: (v: Visitor) => Point): boolean {
    if (v.chatted) return false;
    const others = [...this.visitors.values()].filter(
      (b) => b !== v && !b.leaving && !b.chatted && (!b.stop || (b.stop.phase === 'go' && b.stop.kind !== 'chat' && b.stop.kind !== 'meeting')),
    );
    if (!others.length || this.rng() >= this.o.chatChance) return false;
    const a = posOf(v);
    const b = others.reduce((best, o) => (dist(posOf(o), a) < dist(posOf(best), a) ? o : best));
    const bp = posOf(b);
    const mid = { x: Math.round((a.x + bp.x) / 2), y: Math.round((a.y + bp.y) / 2) };
    const tile = this.world.chatTiles
      .filter((t) => free(t) && free({ x: t.x + 1, y: t.y }))
      .reduce<Point | undefined>((best, t) => (!best || dist(t, mid) < dist(best, mid) ? t : best), undefined);
    if (!tile) return false;
    if (b.stop) {
      b.plan.unshift(b.stop.kind);
      b.stop = undefined;
      this.release(b.id);
    }
    const right = { x: tile.x + 1, y: tile.y };
    const [left, rightV] = a.x <= bp.x ? [v, b] : [b, v];
    this.reserved.set(`tile:${key(tile)}`, left.id);
    this.reserved.set(`tile:${key(right)}`, rightV.id);
    const seed = this.rng();
    left.stop = { kind: 'chat', phase: 'go', target: tile, face: 'right', partner: rightV.id, leader: left === v, startedAt: now, seed };
    rightV.stop = { kind: 'chat', phase: 'go', target: right, face: 'left', partner: left.id, leader: rightV === v, startedAt: now, seed };
    v.chatted = true;
    b.chatted = true;
    return true;
  }

  private doing(s: Stop, now: number, waiting: boolean): DoDirective {
    const base = { type: 'do' as const, at: { ...s.target }, face: s.face, activity: s.kind };
    const t = now - (s.doAt ?? now);
    const len = (s.doneAt ?? now) - (s.doAt ?? now);
    const line = !waiting && s.speech !== undefined && t < SOLO_SPEECH_MS ? s.speech : undefined;
    const say = (d: DoDirective): DoDirective => {
      if (line === undefined) return d;
      const { bubble: _icon, ...rest } = d;
      return { ...rest, speech: line };
    };
    switch (s.kind) {
      case 'chat': {
        if (waiting) return { ...base, pose: 'stand' };
        const turn = Math.floor(t / SPEAK_MS);
        const speaking = (turn % 2 === 0) === Boolean(s.leader);
        if (!speaking || t % SPEAK_MS >= SPEAK_MS - SPEAK_GAP_MS) return { ...base, pose: 'stand' };
        const step = s.script?.[turn];
        if (!step) return { ...base, pose: 'stand' };
        if (step.speech !== undefined) return { ...base, pose: 'talk', speech: step.speech };
        return { ...base, pose: 'talk', bubble: step.icon ?? 'chat_dots' };
      }
      case 'reception':
        return say({ ...base, pose: 'stand', bubble: !waiting && t > len / 2 && t < len / 2 + 1_500 ? 'chat_dots' : undefined });
      case 'visit':
        return say({ ...base, face: waiting ? s.face : lookAround(s.face, s.seed, t), pose: 'stand' });
      case 'toilet':
        return waiting ? { ...base, pose: 'stand' } : { ...base, pose: 'stand', hidden: true };
      case 'coffee':
        return say({ ...base, pose: 'stand', bubble: !waiting && t < 1_600 ? 'chat_coffee' : undefined });
      case 'water':
        return say(!waiting && t > len / 2 ? { ...base, face: 'down', pose: 'drink' } : { ...base, pose: 'stand' });
      case 'snack':
        if (waiting || t < len * 0.3) return say({ ...base, pose: 'stand' });
        return say({ ...base, face: 'down', pose: Math.floor(t / 700) % 3 === 2 ? 'stand' : 'eat' });
      case 'window':
        return say({ ...base, pose: 'stand', bubble: !waiting && t < 2_200 ? (this.world.night ? 'chat_moon' : 'chat_sun') : undefined });
      case 'board':
      case 'whiteboard':
        return say({ ...base, pose: 'stand', bubble: !waiting && t > len / 2 && t < len / 2 + 1_600 ? 'chat_idea' : undefined });
      case 'books':
        if (waiting || t < len * 0.25) return say({ ...base, pose: 'stand' });
        return say({ ...base, face: 'down', pose: 'read' });
      case 'couch':
        return say({ ...base, pose: 'couch', bubble: !waiting && t % 7_000 < 1_800 ? 'chat_music' : undefined });
      case 'lounge':
        return say({ ...base, pose: 'sit_meeting' });
      case 'meeting': {
        // Seated at the table; one person "talks" per turn (icons only, like the agents' meetings).
        if (waiting || s.size === undefined || s.slot === undefined) return { ...base, pose: 'sit_meeting' };
        const turn = Math.floor(t / MEETING_TURN_MS);
        const speaker = Math.floor((s.seed * 997 + turn * 7.31) % s.size);
        const talking = speaker === s.slot && t % MEETING_TURN_MS < MEETING_BUBBLE_MS;
        return talking ? { ...base, pose: 'sit_meeting', bubble: MEETING_ICONS[(turn + Math.floor(s.seed * 10)) % MEETING_ICONS.length]! } : { ...base, pose: 'sit_meeting' };
      }
    }
  }

  /** Maybe one simulated line at the start of a solo stop (never in the restroom). */
  private soloLine(v: Visitor, kind: VisitorActivity, now: number): string | undefined {
    if (kind === 'toilet' || kind === 'chat') return undefined;
    const chance = kind === 'reception' ? Math.max(0.7, this.o.soloSpeechChance ?? 0.4) : (this.o.soloSpeechChance ?? 0.4);
    if (this.rng() >= chance) return undefined;
    const line = pickLine({ role: 'solo', activity: kind, visitor: true, now, hour: this.hour(now), night: this.world.night, rng: this.rng, avoid: v.said });
    if (line) this.remember(v, line.text);
    return line?.text;
  }

  /** Opener, reply, icons or small talk, and a closing line; all local visitor templates. */
  private chatScript(leader: Visitor, follower: Visitor, durationMs: number, now: number): ChatTurn[] {
    const turns = Math.max(2, Math.floor(durationMs / SPEAK_MS));
    const hour = this.hour(now);
    const say = (turn: number, role: DialogueRole, after?: DialogueFamily) => {
      const who = turn % 2 === 0 ? leader : follower;
      const line = pickLine({ role, activity: 'chat', visitor: true, after, now, hour, night: this.world.night, rng: this.rng, avoid: who.said });
      if (line) this.remember(who, line.text);
      return line;
    };
    const icon = (): ChatTurn => ({ icon: CHAT_ICONS[Math.floor(this.rng() * CHAT_ICONS.length) % CHAT_ICONS.length]! });
    const script: ChatTurn[] = [];
    const open = say(0, 'open');
    script.push(open ? { speech: open.text } : icon());
    const reply = say(1, 'reply', open?.family);
    script.push(reply ? { speech: reply.text } : icon());
    for (let i = 2; i < turns; i++) {
      if (i === turns - 1 && turns >= 4) {
        const close = say(i, 'close');
        script.push(close ? { speech: close.text } : icon());
        continue;
      }
      const small = this.rng() < (this.o.smallTalkChance ?? 0.35) ? say(i, 'small_talk') : undefined;
      script.push(small ? { speech: small.text } : icon());
    }
    return script;
  }
}
