/**
 * Mode B: simulated meetings, group breaks and social gatherings.
 *
 * A BehaviorProvider that now and then gathers idle agents:
 * - seated: 2–5 agents in a meeting, collaboration or break room walk to unique seats, sit
 *   together (with an optional presenter at the whiteboard in meeting/collaboration rooms)
 *   and walk back to their desks one after another;
 * - standing ("social"): 3–4 agents stand in a small circle in a common area (break room,
 *   collaboration area, coffee corner, water cooler, lounge) for a coffee chat, a group chat
 *   or a pretend team discussion, then wave and leave one after another. Two-person chats
 *   are idle life's (idleLife.ts), not this module's.
 *
 * It is an office animation only:
 * - local and deterministic (injected RNG and `now`), no model, no network, no tokens;
 * - seated meetings show icon bubbles only; social gatherings show icons and now and then a
 *   verbatim line from the local template table (dialogue.ts pickLine). Nothing is generated
 *   and nothing is real agent output; the scene draws template lines as simulated speech;
 * - real status always wins: the moment an actor is not idle (real work, a prompt, or a
 *   higher-priority provider) it leaves at once, in a hurry when its real status changed.
 *   The meeting goes on while at least two participants remain, otherwise it ends;
 * - one activity per room, one actor per seat or tile, never a tile another actor stands on
 *   or calls home.
 *
 * No rendering here: the scene feeds actors in and applies the returned directives.
 * Run it after the teamwork provider and before idle life (see docs/COLLABORATION.md).
 */
import type { Actor, ActorPose, BehaviorProvider, ChatIcon, Directive, Face, Point, RoomInfo, Seat, SpotKind, World } from './behavior';
import { pickLine, type DialogueFamily, type DialogueRole } from './dialogue';

export const MEETING_ROOM_KINDS = ['meeting', 'collaboration', 'break'] as const;
export type MeetingRoomKind = (typeof MEETING_ROOM_KINDS)[number];
/** Seated meetings are named after their room kind; standing gatherings are 'social'. */
export type MeetingKind = MeetingRoomKind | 'social';
/** 'gathering': walking to seats; 'meeting': under way; 'ending': leaving one after another. */
export type MeetingPhase = 'gathering' | 'meeting' | 'ending';
/** Flavour of a social gathering (decides icons and the activity name). */
export type SocialTopic = 'coffee' | 'chat' | 'discussion';

/** Public, read-only view of a simulated meeting (for display; always simulated). */
export interface MeetingInfo {
  /** Also the `groupId` of every participant's directives. */
  id: string;
  /** Room id, or `spot:<id>` for a gathering at a spot outside any room. */
  roomId: string;
  roomName: string;
  kind: MeetingKind;
  /** Social gatherings only. */
  topic?: SocialTopic;
  /** Actor keys, presenter included. */
  participants: string[];
  presenter?: string;
  phase: MeetingPhase;
  createdAt: number;
  startedAt?: number;
  endsAt?: number;
  simulated: true;
}

export interface MeetingOptions {
  /** Delay before the first gathering attempt (ms), at frequency 1. */
  firstDelay: [number, number];
  /** Pause between gathering attempts (ms), at frequency 1. */
  interval: [number, number];
  /** How long participants stay once everyone has arrived (ms). */
  duration: Record<MeetingRoomKind, [number, number]>;
  /** Participants that have not arrived by then are released (ms after creation). */
  arrivalTimeout: number;
  /** 2–5 by default; never below 2. */
  minParticipants: number;
  maxParticipants: number;
  /** Meetings and gatherings running at the same time (one per room at most). */
  maxConcurrent: number;
  /** Pause before a room hosts another meeting (ms). */
  roomCooldown: number;
  /** Pause before an actor joins another meeting (ms). */
  actorCooldown: number;
  /** Chance that a meeting/collaboration room with a presenter spot gets a presenter. */
  presenterChance: number;
  /** At most this share of idle actors are in meetings at once. */
  maxShare: number;
  /** Chance that a slot hosts a standing social gathering instead of a seated meeting (when both are possible; 0 = never). */
  socialChance: number;
  /** Size of a social gathering: 3–4 by default, never below 3. */
  socialSize: [number, number];
  /** How long a social gathering lasts once everyone has arrived (ms). */
  socialDuration: [number, number];
  /** Chance that a middle turn of a social gathering is a template small-talk line (else an icon or a pause). */
  socialSpeechChance: number;
  /** Gap between two participants leaving at the end (ms). */
  departureStagger: number;
  /** Local hour (0-23) for time-of-day template lines. Default: the local clock. */
  hourOf?: (now: number) => number;
  /** Rooms another activity is using right now (e.g. a pizza party): no meeting or gathering starts there. */
  roomBusy?: (roomId: string) => boolean;
}

export const DEFAULT_MEETING_OPTIONS: MeetingOptions = {
  firstDelay: [20_000, 45_000],
  interval: [45_000, 120_000],
  // A few minutes, like a real meeting (real work still pulls anyone out at once).
  duration: { meeting: [120_000, 240_000], collaboration: [90_000, 180_000], break: [60_000, 120_000] },
  arrivalTimeout: 30_000,
  minParticipants: 2,
  maxParticipants: 5,
  maxConcurrent: 2,
  roomCooldown: 30_000,
  actorCooldown: 120_000,
  presenterChance: 0.5,
  maxShare: 0.6,
  socialChance: 0.4,
  socialSize: [3, 4],
  socialDuration: [16_000, 30_000],
  socialSpeechChance: 0.25,
  departureStagger: 900,
};

const ACTIVITY: Record<MeetingRoomKind, string> = { meeting: 'meeting', collaboration: 'huddle', break: 'group_break' };
const SOCIAL_ACTIVITY: Record<SocialTopic, string> = { coffee: 'coffee_chat', chat: 'group_chat', discussion: 'team_discussion' };
const ICONS: Record<MeetingRoomKind, ChatIcon[]> = {
  meeting: ['chat_idea', 'chat_dots', 'chat_heart', 'chat_laugh'],
  collaboration: ['chat_idea', 'chat_dots', 'chat_laugh'],
  break: ['chat_coffee', 'chat_music', 'chat_laugh', 'chat_heart', 'chat_dots'],
};
const SOCIAL_ICONS: Record<SocialTopic, ChatIcon[]> = {
  coffee: ['chat_coffee', 'chat_laugh', 'chat_heart', 'chat_dots'],
  chat: ['chat_laugh', 'chat_music', 'chat_heart', 'chat_dots'],
  discussion: ['chat_idea', 'chat_dots', 'chat_idea', 'chat_laugh'],
};
/** One bubble "turn" (ms); a bubble shows for the first BUBBLE_MS of a turn. */
const TURN_MS = 2_400;
const BUBBLE_MS = 1_600;
/** Social gatherings: one speaker per turn, silent for the last SOCIAL_GAP_MS so speakers alternate visibly. */
const SOCIAL_TURN_MS = 2_600;
const SOCIAL_GAP_MS = 400;
/** Social gatherings wave goodbye this long before leaving. */
const WAVE_MS = 700;
/** A social circle is centred at most this far (tiles, Manhattan) from its anchor. */
const SOCIAL_RADIUS = 5;
/** Spots outside department rooms that can host a social gathering. */
const SOCIAL_SPOTS: Partial<Record<SpotKind, { name: string; topic: SocialTopic }>> = {
  coffee: { name: 'Coffee corner', topic: 'coffee' },
  water: { name: 'Water cooler', topic: 'coffee' },
  snack: { name: 'Snack bar', topic: 'coffee' },
  couch: { name: 'Lounge', topic: 'chat' },
};
/** Room kinds whose spots count as common areas (break and collaboration rooms are venues of their own). */
const COMMON_ROOMS: ReadonlySet<string> = new Set(['reception', 'corridor', 'office']);
/** Places around the centre of a social circle in preference order, facing the centre. */
const RING: ReadonlyArray<{ dx: number; dy: number; face: Face }> = [
  { dx: -1, dy: 0, face: 'right' },
  { dx: 1, dy: 0, face: 'left' },
  { dx: 0, dy: -1, face: 'down' },
  { dx: 0, dy: 1, face: 'up' },
  { dx: -1, dy: -1, face: 'right' },
  { dx: 1, dy: -1, face: 'left' },
  { dx: -1, dy: 1, face: 'right' },
  { dx: 1, dy: 1, face: 'left' },
];

interface Participant {
  key: string;
  role: 'attendee' | 'presenter';
  seat: Seat;
  arrived: boolean;
  /** Order of joining (stable per meeting). */
  n: number;
  /** 'ending' phase: when this participant leaves. */
  leaveAt?: number;
}

/** One turn of a social gathering: a speaker with a template line, an icon, or nothing. */
interface SocialTurn {
  speaker: string;
  speech?: string;
  icon?: ChatIcon;
}

/** Where a social gathering can take place. */
interface Venue {
  /** Room id, or `spot:<id>` outside rooms; one activity per key. */
  key: string;
  name: string;
  topic: SocialTopic;
  anchor: Point;
  room?: RoomInfo;
  spotId?: string;
}

interface Meeting {
  id: string;
  /** Map key: the room id (or `spot:<id>`). */
  key: string;
  name: string;
  kind: MeetingKind;
  topic?: SocialTopic;
  /** Seated meetings: the room; social gatherings: the room they are in, if any. */
  room?: RoomInfo;
  /** Signature of the venue when the meeting was created (world changes end it). */
  sig: string;
  phase: MeetingPhase;
  createdAt: number;
  startedAt?: number;
  endsAt?: number;
  seed: number;
  participants: Map<string, Participant>;
  script?: SocialTurn[];
}

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const dist = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const tile = (p: Point) => `${p.x},${p.y}`;
const inside = (r: RoomInfo, p: Point) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

/** Small integer hash (FNV-1a style) so bubbles do not depend on tick rate or RNG draws. */
function hash(...parts: number[]): number {
  let h = 2166136261;
  for (const p of parts) {
    h ^= p | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

function isMeetingKind(kind: string): kind is MeetingRoomKind {
  return (MEETING_ROOM_KINDS as readonly string[]).includes(kind);
}

/** Unique attendee seats of a room (deduplicated by tile, presenter tile excluded). */
export function roomSeats(room: RoomInfo): Seat[] {
  const used = new Set<string>(room.presenter ? [tile(room.presenter.at)] : []);
  const out: Seat[] = [];
  for (const s of room.seats) {
    const k = tile(s.at);
    if (used.has(k)) continue;
    used.add(k);
    out.push(s);
  }
  return out;
}

/** Presenters only in meeting/collaboration rooms that define a presenter spot. */
function presenterPossible(room: RoomInfo): boolean {
  return room.kind !== 'break' && room.presenter !== undefined;
}

function signature(room: RoomInfo): string {
  return JSON.stringify([room.kind, room.x, room.y, room.w, room.h, room.capacity, room.seats, room.presenter ?? null]);
}

export class MeetingScheduler implements BehaviorProvider {
  readonly name = 'meetings';
  private world: World = { spots: [], chatTiles: [], rooms: [], night: false };
  /** Known free floor tiles (chat tiles and their right neighbours: never a desk seat or a spot). */
  private floor: Point[] = [];
  private floorSet = new Set<string>();
  /** Seats and presenter spots of every room: never part of a social circle. */
  private seatTiles = new Set<string>();
  private enabled = true;
  private frequency = 1;
  private nextAt: number | undefined;
  private lastNow: number | undefined;
  private seq = 0;
  private meetings = new Map<string, Meeting>(); // room id (or spot:<id>) -> meeting
  private actorRoom = new Map<string, string>(); // actor key -> meeting key
  private departing = new Map<string, boolean>(); // actor key -> hurry
  private actorCooldown = new Map<string, number>();
  private roomCooldown = new Map<string, number>();

  constructor(
    private readonly rng: () => number = Math.random,
    private readonly o: MeetingOptions = DEFAULT_MEETING_OPTIONS,
  ) {}

  setWorld(world: World): void {
    const now = this.lastNow ?? 0;
    this.world = world;
    const seen = new Set<string>();
    this.floor = [];
    for (const t of world.chatTiles) {
      for (const p of [t, { x: t.x + 1, y: t.y }]) {
        if (seen.has(tile(p))) continue;
        seen.add(tile(p));
        this.floor.push(p);
      }
    }
    this.floorSet = seen;
    this.seatTiles = new Set(world.rooms.flatMap((r) => [...r.seats.map((x) => tile(x.at)), ...(r.presenter ? [tile(r.presenter.at)] : [])]));
    // Meetings whose room or spot is gone or changed end; unchanged ones keep going (the world
    // is also rebuilt when only the time of day changes).
    for (const m of [...this.meetings.values()]) {
      const sig = this.venueSignature(m);
      if (sig === undefined || sig !== m.sig || (m.kind === 'social' && ![...m.participants.values()].every((p) => this.walkable(p.seat.at)))) {
        this.end(m, now, false);
        continue;
      }
      if (m.room) m.room = world.rooms.find((r) => r.id === m.room!.id) ?? m.room;
    }
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) for (const m of [...this.meetings.values()]) this.end(m, this.lastNow ?? 0, false);
    this.nextAt = undefined;
  }

  /** 1 = normal, 0.5 = half as often, 2 = twice as often, 0 = no new meetings. */
  setFrequency(multiplier: number): void {
    const next = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 0;
    const prev = this.frequency;
    if (next === prev) return;
    this.frequency = next;
    if (prev > 0 && next > 0 && this.nextAt !== undefined && this.lastNow !== undefined) {
      this.nextAt = this.lastNow + Math.max(0, this.nextAt - this.lastNow) * (prev / next);
    } else if (next > 0) {
      this.nextAt = undefined;
    }
  }

  forget(actorKey: string): void {
    this.leave(actorKey, this.lastNow ?? 0);
    this.departing.delete(actorKey);
    this.actorCooldown.delete(actorKey);
  }

  /** Simulated meetings and gatherings in progress (gathering, meeting or ending), oldest first. */
  currentMeetings(): MeetingInfo[] {
    return [...this.meetings.values()].sort((x, y) => x.createdAt - y.createdAt || x.key.localeCompare(y.key)).map((m) => this.info(m));
  }

  meetingOf(actorKey: string): MeetingInfo | undefined {
    const key = this.actorRoom.get(actorKey);
    const m = key ? this.meetings.get(key) : undefined;
    return m ? this.info(m) : undefined;
  }

  tick(now: number, actors: readonly Actor[]): Map<string, Directive> {
    this.lastNow = now;
    const byKey = new Map(actors.map((a) => [a.key, a]));
    for (const k of [...this.actorRoom.keys()]) if (!byKey.has(k)) this.leave(k, now);
    for (const k of [...this.departing.keys()]) if (!byKey.has(k)) this.departing.delete(k);
    for (const k of [...this.actorCooldown.keys()]) if (!byKey.has(k)) this.actorCooldown.delete(k);
    if (this.nextAt === undefined) this.nextAt = now + this.scaled(this.between(this.o.firstDelay));

    // 1. Departures from earlier ticks are released once they are back at their desk.
    for (const k of [...this.departing.keys()]) {
      const a = byKey.get(k);
      if (a && !a.moving && same(a.pos, a.home)) this.departing.delete(k);
    }

    // 2. Real status wins: anyone no longer idle leaves at once (also on the way back), in a
    //    hurry when its real status changed; calmly when a higher-priority provider claimed it.
    for (const a of actors) {
      const hurry = !a.ctx || a.ctx.status !== 'idle';
      if (this.actorRoom.has(a.key) && (!a.idle || !this.enabled)) {
        this.leave(a.key, now);
        this.departing.set(a.key, hurry);
      } else if (!a.idle && hurry && this.departing.has(a.key)) {
        this.departing.set(a.key, true);
      }
    }

    // 3. Advance meetings: arrival, start, timeout, end, staggered departure.
    for (const m of [...this.meetings.values()]) {
      if (m.phase === 'gathering') {
        for (const p of m.participants.values()) {
          const a = byKey.get(p.key);
          if (a && !a.moving && same(a.pos, p.seat.at)) p.arrived = true;
        }
        const all = [...m.participants.values()];
        if (all.every((p) => p.arrived)) {
          this.begin(m, now, byKey);
        } else if (now - m.createdAt >= this.o.arrivalTimeout) {
          for (const p of all) if (!p.arrived) this.leave(p.key, now, false);
          if (this.meetings.get(m.key) === m) this.begin(m, now, byKey);
        }
      } else if (m.phase === 'meeting') {
        if (m.endsAt !== undefined && now >= m.endsAt) this.wrapUp(m, now);
      }
      if (m.phase === 'ending') {
        for (const p of [...m.participants.values()]) if (p.leaveAt !== undefined && now >= p.leaveAt) this.leave(p.key, now, false);
      }
    }

    // 4. Maybe gather a new meeting.
    if (this.enabled && this.frequency > 0 && now >= this.nextAt) {
      this.tryStart(now, actors);
      this.nextAt = now + this.scaled(this.between(this.o.interval));
    }

    // 5. Directives. Non-idle actors are never in a meeting at this point, so they get 'home'.
    const out = new Map<string, Directive>();
    for (const a of actors) {
      const key = this.actorRoom.get(a.key);
      const m = key ? this.meetings.get(key) : undefined;
      const p = m?.participants.get(a.key);
      if (m && p && a.idle && this.enabled) {
        out.set(a.key, this.directive(m, p, a, now));
        continue;
      }
      out.set(a.key, { type: 'home', hurry: this.departing.get(a.key) ?? false });
    }
    return out;
  }

  private between([a, b]: [number, number]): number {
    return a + this.rng() * (b - a);
  }

  private scaled(ms: number): number {
    return this.frequency > 0 ? ms / this.frequency : ms;
  }

  private hour(now: number): number {
    return this.o.hourOf ? this.o.hourOf(now) : new Date(now).getHours();
  }

  private walkable(p: Point): boolean {
    return this.world.isWalkable ? this.world.isWalkable(p) : true;
  }

  private info(m: Meeting): MeetingInfo {
    const participants = [...m.participants.values()];
    const presenter = participants.find((p) => p.role === 'presenter');
    const out: MeetingInfo = {
      id: m.id,
      roomId: m.key,
      roomName: m.name,
      kind: m.kind,
      participants: participants.map((p) => p.key),
      phase: m.phase,
      createdAt: m.createdAt,
      simulated: true,
    };
    if (m.topic) out.topic = m.topic;
    if (presenter) out.presenter = presenter.key;
    if (m.startedAt !== undefined) out.startedAt = m.startedAt;
    if (m.endsAt !== undefined) out.endsAt = m.endsAt;
    return out;
  }

  /** The venue's signature in the current world (undefined: the venue is gone). */
  private venueSignature(m: Meeting): string | undefined {
    if (m.room) {
      const room = this.world.rooms.find((r) => r.id === m.room!.id);
      return room ? signature(room) : undefined;
    }
    const spotId = m.key.startsWith('spot:') ? m.key.slice(5) : undefined;
    const spot = spotId ? this.world.spots.find((s) => s.id === spotId) : undefined;
    return spot ? JSON.stringify([spot.kind, spot.at]) : undefined;
  }

  /** Fewest participants a meeting needs: social gatherings need three to begin, then two. */
  private minimum(m: Meeting): number {
    return m.kind === 'social' && m.phase === 'gathering' ? 3 : 2;
  }

  private begin(m: Meeting, now: number, byKey: ReadonlyMap<string, Actor>): void {
    if (m.participants.size < this.minimum(m)) {
      this.end(m, now, false);
      return;
    }
    m.phase = 'meeting';
    m.startedAt = now;
    m.endsAt = now + this.between(m.kind === 'social' ? this.o.socialDuration : this.o.duration[m.kind]);
    if (m.kind === 'social') m.script = this.socialScript(m, byKey, now);
  }

  /** Natural end: participants leave one after another, in an order fixed by the meeting seed. */
  private wrapUp(m: Meeting, now: number): void {
    m.phase = 'ending';
    const first = m.kind === 'social' ? WAVE_MS : 0;
    const order = [...m.participants.values()].sort((x, y) => hash(m.seed, x.n, 5) - hash(m.seed, y.n, 5) || x.n - y.n);
    order.forEach((p, i) => {
      p.leaveAt = now + first + i * Math.max(0, this.o.departureStagger);
    });
  }

  /**
   * Remove one participant. While gathering or under way the meeting ends for everyone if too
   * few remain; while ending, the others keep their own departure times.
   */
  private leave(actorKey: string, now: number, hurry?: boolean): void {
    const key = this.actorRoom.get(actorKey);
    this.actorRoom.delete(actorKey);
    if (hurry !== undefined) this.departing.set(actorKey, hurry || (this.departing.get(actorKey) ?? false));
    const m = key ? this.meetings.get(key) : undefined;
    if (!m) return;
    m.participants.delete(actorKey);
    this.actorCooldown.set(actorKey, now + this.o.actorCooldown);
    if (m.phase === 'ending' ? m.participants.size === 0 : m.participants.size < this.minimum(m)) this.end(m, now, false);
  }

  /** Immediate end: everyone still in the meeting walks back at once. */
  private end(m: Meeting, now: number, hurry: boolean): void {
    if (this.meetings.get(m.key) !== m) return;
    this.meetings.delete(m.key);
    this.roomCooldown.set(m.key, now + this.o.roomCooldown);
    for (const k of m.participants.keys()) {
      this.actorRoom.delete(k);
      this.departing.set(k, hurry || (this.departing.get(k) ?? false));
      this.actorCooldown.set(k, now + this.o.actorCooldown);
    }
    m.participants.clear();
  }

  /** Tiles nobody else may get: other actors' homes and positions, and every seat or tile in use by a meeting. */
  private takenTiles(actors: readonly Actor[]): Set<string> {
    const taken = new Set<string>();
    for (const a of actors) {
      taken.add(tile(a.home));
      if (!a.moving) taken.add(tile(a.pos));
    }
    for (const m of this.meetings.values()) for (const p of m.participants.values()) taken.add(tile(p.seat.at));
    return taken;
  }

  private tryStart(now: number, actors: readonly Actor[]): void {
    if (this.meetings.size >= Math.max(0, this.o.maxConcurrent)) return;
    const idleCount = actors.filter((a) => a.idle).length;
    const inMeetings = this.actorRoom.size;
    const minP = Math.max(2, this.o.minParticipants);
    const maxP = Math.max(minP, this.o.maxParticipants);
    // A small office (two idle agents) may still meet; larger ones keep most agents free.
    const allowed = Math.min(Math.max(minP, Math.floor(idleCount * this.o.maxShare)), idleCount) - inMeetings;
    if (allowed < minP) return;

    const eligible = actors.filter(
      (a) =>
        a.idle &&
        !a.away &&
        !a.moving &&
        same(a.pos, a.home) &&
        !this.actorRoom.has(a.key) &&
        !this.departing.has(a.key) &&
        (this.actorCooldown.get(a.key) ?? 0) <= now,
    );
    if (eligible.length < minP) return;
    const taken = this.takenTiles(actors);

    const rooms = this.world.rooms.filter((r) => {
      if (!isMeetingKind(r.kind) || this.meetings.has(r.id) || (this.roomCooldown.get(r.id) ?? 0) > now || this.o.roomBusy?.(r.id)) return false;
      return this.roomCapacity(r, taken) >= minP;
    });
    const socialMin = Math.max(3, Math.floor(this.o.socialSize[0]));
    const venues = this.o.socialChance > 0 && eligible.length >= socialMin && allowed >= socialMin ? this.socialVenues(now, taken, socialMin) : [];
    if (!rooms.length && !venues.length) return;
    // Only draw for the choice when both kinds are possible.
    if (venues.length && (!rooms.length || this.rng() < this.o.socialChance)) {
      this.startSocial(now, venues, eligible, Math.min(eligible.length, allowed), taken);
      return;
    }

    const room = rooms[Math.min(rooms.length - 1, Math.floor(this.rng() * rooms.length))]!;
    const kind = room.kind as MeetingRoomKind;
    const seats = roomSeats(room).filter((s) => !taken.has(tile(s.at)));
    const withPresenter = presenterPossible(room) && !taken.has(tile(room.presenter!.at)) && this.rng() < this.o.presenterChance;
    const positions = seats.length + (withPresenter ? 1 : 0);

    const cap = Math.min(room.capacity > 0 ? room.capacity : positions, positions, maxP, eligible.length, allowed);
    if (cap < minP) return;
    const n = minP + Math.min(cap - minP, Math.floor(this.rng() * (cap - minP + 1)));
    const picked = this.shuffle(eligible).slice(0, n);

    const m: Meeting = {
      id: `meeting-${room.id}-${++this.seq}`,
      key: room.id,
      name: room.name,
      room,
      kind,
      sig: signature(room),
      phase: 'gathering',
      createdAt: now,
      seed: Math.floor(this.rng() * 2 ** 31),
      participants: new Map(),
    };
    const free = [...seats];
    picked.forEach((a, i) => {
      let seat: Seat;
      let role: Participant['role'] = 'attendee';
      if (withPresenter && i === 0) {
        seat = room.presenter!;
        role = 'presenter';
      } else {
        seat = this.nearest(free, a.home);
      }
      m.participants.set(a.key, { key: a.key, role, seat, arrived: false, n: i });
      this.actorRoom.set(a.key, room.id);
    });
    this.meetings.set(room.id, m);
  }

  /** Deterministic shuffle (Fisher-Yates with the injected RNG). */
  private shuffle<T>(list: readonly T[]): T[] {
    const pool = [...list];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool;
  }

  /** Take the free seat nearest to `home` out of `free`; seats are never shared. */
  private nearest(free: Seat[], home: Point): Seat {
    let best = 0;
    for (let s = 1; s < free.length; s++) if (dist(free[s]!.at, home) < dist(free[best]!.at, home)) best = s;
    return free.splice(best, 1)[0]!;
  }

  /** Most people a room can host: free unique seats plus a presenter spot, bounded by capacity (<= 0: no extra bound). */
  private roomCapacity(room: RoomInfo, taken: ReadonlySet<string>): number {
    const seats = roomSeats(room).filter((s) => !taken.has(tile(s.at))).length;
    const positions = seats + (presenterPossible(room) && !taken.has(tile(room.presenter!.at)) ? 1 : 0);
    return Math.min(room.capacity > 0 ? room.capacity : positions, positions);
  }

  /** Common areas that can host a circle of `min` right now. */
  private socialVenues(now: number, taken: ReadonlySet<string>, min: number): Venue[] {
    if (!this.floor.length) return [];
    const out: Venue[] = [];
    const keys = new Set<string>();
    const add = (v: Venue) => {
      if (keys.has(v.key) || this.meetings.has(v.key) || (this.roomCooldown.get(v.key) ?? 0) > now || (v.room && this.o.roomBusy?.(v.room.id)) || !this.circle(v, min, taken)) return;
      keys.add(v.key);
      out.push(v);
    };
    for (const r of this.world.rooms) {
      if (r.kind !== 'break' && r.kind !== 'collaboration') continue;
      const spots = this.world.spots.filter((s) => s.roomId === r.id);
      const drink = spots.find((s) => s.kind === 'coffee' || s.kind === 'water' || s.kind === 'snack');
      const board = spots.find((s) => s.kind === 'whiteboard');
      const at = (r.kind === 'collaboration' ? (board ?? drink) : drink)?.at ?? { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
      add({ key: r.id, name: r.name, topic: r.kind === 'collaboration' ? 'discussion' : drink ? 'coffee' : 'chat', anchor: at, room: r });
    }
    for (const s of this.world.spots) {
      const kind = SOCIAL_SPOTS[s.kind];
      if (!kind) continue;
      const room = s.roomId ? this.world.rooms.find((r) => r.id === s.roomId) : undefined;
      if (room && !COMMON_ROOMS.has(room.kind)) continue;
      add(room ? { key: room.id, name: room.name, topic: kind.topic, anchor: s.at, room } : { key: `spot:${s.id}`, name: kind.name, topic: kind.topic, anchor: s.at, spotId: s.id });
    }
    return out;
  }

  /** A free floor tile near the venue's anchor with `n` free places around it (the centre stays empty). */
  private circle(v: Venue, n: number, taken: ReadonlySet<string>): Seat[] | undefined {
    const usable = (p: Point) =>
      this.floorSet.has(tile(p)) && !taken.has(tile(p)) && !this.seatTiles.has(tile(p)) && (!v.room || inside(v.room, p)) && this.walkable(p);
    const centres = this.floor
      .filter((c) => dist(c, v.anchor) <= SOCIAL_RADIUS && usable(c))
      .sort((a, b) => dist(a, v.anchor) - dist(b, v.anchor) || a.y - b.y || a.x - b.x);
    for (const c of centres) {
      const ring = RING.map((o) => ({ at: { x: c.x + o.dx, y: c.y + o.dy }, face: o.face })).filter((s) => usable(s.at));
      if (ring.length >= n) return ring.slice(0, n);
    }
    return undefined;
  }

  private startSocial(now: number, venues: Venue[], eligible: readonly Actor[], budget: number, taken: ReadonlySet<string>): void {
    const v = venues[Math.min(venues.length - 1, Math.floor(this.rng() * venues.length))]!;
    const lo = Math.max(3, Math.floor(this.o.socialSize[0]));
    const hi = Math.max(lo, Math.floor(this.o.socialSize[1]));
    const cap = Math.min(hi, budget);
    let n = lo + Math.min(cap - lo, Math.floor(this.rng() * (cap - lo + 1)));
    let places = this.circle(v, n, taken);
    while (!places && n > lo) places = this.circle(v, --n, taken);
    if (!places) return;
    const picked = this.shuffle(eligible).slice(0, n);
    const m: Meeting = {
      id: `social-${v.key}-${++this.seq}`,
      key: v.key,
      name: v.name,
      kind: 'social',
      topic: v.topic,
      sig: v.room ? signature(v.room) : JSON.stringify([this.world.spots.find((s) => s.id === v.spotId)?.kind, v.anchor]),
      phase: 'gathering',
      createdAt: now,
      seed: Math.floor(this.rng() * 2 ** 31),
      participants: new Map(),
    };
    if (v.room) m.room = v.room;
    const free = [...places];
    picked.forEach((a, i) => {
      m.participants.set(a.key, { key: a.key, role: 'attendee', seat: this.nearest(free, a.home), arrived: false, n: i });
      this.actorRoom.set(a.key, v.key);
    });
    this.meetings.set(v.key, m);
  }

  /**
   * Turns of a social gathering, fixed when it begins: an opener, a reply, then icons, pauses
   * and now and then small talk, and a closing line. Every line is a verbatim local template
   * (dialogue.ts); rules see only the speakers' real, local context and the clock.
   */
  private socialScript(m: Meeting, byKey: ReadonlyMap<string, Actor>, now: number): SocialTurn[] {
    const keys = this.shuffle([...m.participants.keys()]);
    const turns = Math.max(3, Math.floor(((m.endsAt ?? now) - now) / SOCIAL_TURN_MS));
    const hour = this.hour(now);
    const night = this.world.night;
    const said: string[] = [];
    const icons = SOCIAL_ICONS[m.topic ?? 'chat'];
    const icon = (): ChatIcon => icons[Math.min(icons.length - 1, Math.floor(this.rng() * icons.length))]!;
    const say = (role: DialogueRole, speaker: string, listener: string, after?: DialogueFamily) => {
      const line = pickLine({
        role,
        activity: 'chat',
        self: byKey.get(speaker)?.ctx,
        partner: byKey.get(listener)?.ctx,
        after,
        now,
        hour,
        night,
        rng: this.rng,
        avoid: said,
      });
      if (line) said.push(line.text);
      return line;
    };
    const turn = (speaker: string, line: ReturnType<typeof say>): SocialTurn => (line ? { speaker, speech: line.text } : { speaker, icon: icon() });
    const [a, b] = [keys[0]!, keys[1] ?? keys[0]!];
    const open = say('open', a, b);
    const script: SocialTurn[] = [turn(a, open), turn(b, say('reply', b, a, open?.family))];
    let prev = b;
    for (let i = 2; i < turns; i++) {
      const others = keys.filter((k) => k !== prev);
      const speaker = others[Math.min(others.length - 1, Math.floor(this.rng() * others.length))] ?? prev;
      if (i === turns - 1) {
        script.push(turn(speaker, say('close', speaker, prev)));
      } else {
        const r = this.rng();
        if (r < this.o.socialSpeechChance) script.push(turn(speaker, say('small_talk', speaker, prev)));
        else if (r < this.o.socialSpeechChance + 0.45) script.push({ speaker, icon: icon() });
        else script.push({ speaker });
      }
      prev = speaker;
    }
    return script;
  }

  private directive(m: Meeting, p: Participant, a: Actor, now: number): Directive {
    if (m.phase === 'gathering' && !p.arrived && !(!a.moving && same(a.pos, p.seat.at))) return { type: 'go', to: p.seat.at };
    if (m.kind === 'social') return this.socialDirective(m, p, now);
    const presenting = p.role === 'presenter';
    const base = { type: 'do' as const, at: p.seat.at, face: p.seat.face, activity: ACTIVITY[m.kind], groupId: m.id };
    if (m.phase !== 'meeting') {
      // Waiting for the others, or about to leave: seated (or standing at the whiteboard), no bubbles.
      return { ...base, pose: (presenting ? 'stand' : 'sit_meeting') as ActorPose };
    }
    const pose: ActorPose = presenting ? 'present' : 'sit_meeting';
    const bubble = this.bubbleFor(m, p.key, now);
    return bubble ? { ...base, pose, bubble } : { ...base, pose };
  }

  private socialDirective(m: Meeting, p: Participant, now: number): Directive {
    const base = { type: 'do' as const, at: p.seat.at, face: p.seat.face, activity: SOCIAL_ACTIVITY[m.topic ?? 'chat'], groupId: m.id };
    if (m.phase === 'gathering') return { ...base, pose: 'stand' };
    if (m.phase === 'ending') return { ...base, pose: p.leaveAt !== undefined && p.leaveAt - now <= WAVE_MS ? 'wave' : 'stand' };
    const t = now - (m.startedAt ?? now);
    const i = Math.floor(t / SOCIAL_TURN_MS);
    const step = m.script?.[i];
    if (step && step.speaker === p.key && t % SOCIAL_TURN_MS < SOCIAL_TURN_MS - SOCIAL_GAP_MS) {
      if (step.speech !== undefined) return { ...base, pose: 'talk', speech: step.speech };
      if (step.icon) return { ...base, pose: 'talk', bubble: step.icon };
      return { ...base, pose: 'talk' };
    }
    // Listeners at a coffee chat take a sip now and then.
    if (m.topic === 'coffee' && hash(m.seed, i, p.n, 7) % 4 === 0) return { ...base, pose: 'drink' };
    return { ...base, pose: 'stand' };
  }

  /** Occasional icon bubble; one speaker per turn, presenter speaks most. Never text. */
  private bubbleFor(m: Meeting, actorKey: string, now: number): ChatIcon | undefined {
    const t = now - (m.startedAt ?? now);
    if (t % TURN_MS >= BUBBLE_MS) return undefined;
    const turn = Math.floor(t / TURN_MS);
    if (hash(m.seed, turn, 1) % 100 >= 60) return undefined; // quiet turn
    const keys = [...m.participants.keys()];
    const presenter = [...m.participants.values()].find((x) => x.role === 'presenter')?.key;
    const speaker = presenter && hash(m.seed, turn, 2) % 3 !== 0 ? presenter : keys[hash(m.seed, turn, 3) % keys.length];
    if (speaker !== actorKey) return undefined;
    const kind = m.kind as MeetingRoomKind;
    const icons = kind === 'break' ? [...ICONS.break, this.world.night ? 'chat_moon' : 'chat_sun'] : ICONS[kind];
    return icons[hash(m.seed, turn, 4) % icons.length] as ChatIcon;
  }
}
