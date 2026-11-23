/**
 * Pizza parties: a team break paid with office coins.
 *
 * A BehaviorProvider that now and then lets one team (a lead session with its subagents and
 * teammates, i.e. actors sharing `ctx.sessionId`) order pizza: when at least three of them sit
 * idle at their desks with enough coins between them, the scene's funding callback charges the
 * team, the members walk to free seats around a table in a break, meeting or collaboration
 * room, eat and chat in icon bubbles, then walk back one after another.
 *
 * It is an office animation only:
 * - local and deterministic (injected RNG and `now`), no model, no network, no speech;
 * - no funding callback (coin game off) means no parties;
 * - real status always wins: a member that is no longer idle leaves at once, in a hurry when it
 *   got real work. The party goes on while at least two members remain, otherwise it ends;
 * - one party per team and per room, never a seat another actor stands on or calls home, never
 *   a room a non-member is in.
 *
 * No rendering here: the scene feeds actors in, applies the returned directives and draws the
 * pizza box at `PartyInfo.table`. Run it after the teamwork provider and before meetings.
 */
import type { RoomKind } from '@agent-office/core';
import type { Actor, ActorPose, BehaviorProvider, ChatIcon, Directive, Point, RoomInfo, Seat, World } from './behavior';
import { roomSeats } from './meetings';

/** 'gathering': walking to seats; 'eating': pizza is served; 'ending': leaving one after another. */
export type PartyPhase = 'gathering' | 'eating' | 'ending';

/** Public, read-only view of a pizza party (for display; always simulated). */
export interface PartyInfo {
  /** Also the `groupId` of every member's directives. */
  id: string;
  sessionId: string;
  roomId: string;
  roomName: string;
  members: string[];
  /** Tile for the pizza box: the rounded centroid of the members' seats (the table they surround). */
  table: Point;
  phase: PartyPhase;
  createdAt: number;
  startedAt?: number;
  endsAt?: number;
  simulated: true;
}

/** Charges the members' coins; true when paid, false when the team cannot pay or is cooling down. */
export type PartyFunding = (memberKeys: string[], sessionId: string, now: number) => boolean;

export interface PartyOptions {
  /** Coins the members must hold together before a party is offered to the funding callback. */
  price: number;
  /** Fewest idle members a party needs to start (never below 2). */
  minMembers: number;
  maxMembers: number;
  /** How long the pizza lasts once everyone has arrived (ms). */
  eatMs: [number, number];
  /** Members that have not arrived by then are released (ms after creation). */
  arrivalTimeout: number;
  /** Pause between two looks for a team that could throw a party (ms). */
  checkEveryMs: number;
  /** Venues in preference order. */
  roomKinds: RoomKind[];
  /** Rooms another activity is using right now (e.g. a meeting still gathering): no party starts there. */
  roomBusy?: (roomId: string) => boolean;
}

export const DEFAULT_PARTY_OPTIONS: PartyOptions = {
  price: 240,
  minMembers: 3,
  maxMembers: 6,
  eatMs: [20_000, 30_000],
  arrivalTimeout: 30_000,
  checkEveryMs: 5_000,
  roomKinds: ['break', 'meeting', 'collaboration'],
};

const ACTIVITY = 'party';
const ICONS: readonly ChatIcon[] = ['chat_laugh', 'chat_heart', 'chat_music'];
/** Each member switches between eating and talking every TURN_MS, on its own beat. */
const TURN_MS = 3_000;
/** A talk turn may show an icon bubble for its first BUBBLE_MS. */
const BUBBLE_MS = 1_600;
const DEPARTURE_STAGGER = 900;
/** A team whose payment was refused is not asked again for this many checks. */
const RETRY_CHECKS = 6;

interface Member {
  key: string;
  seat: Seat;
  arrived: boolean;
  /** Order of joining (stable per party). */
  n: number;
  /** 'ending' phase: when this member leaves. */
  leaveAt?: number;
}

interface Party {
  id: string;
  sessionId: string;
  room: RoomInfo;
  table: Point;
  phase: PartyPhase;
  createdAt: number;
  startedAt?: number;
  endsAt?: number;
  seed: number;
  members: Map<string, Member>;
}

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const dist = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const tile = (p: Point) => `${p.x},${p.y}`;
const inside = (r: RoomInfo, p: Point) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
const centroid = (seats: readonly Seat[]): Point => ({
  x: Math.round(seats.reduce((s, x) => s + x.at.x, 0) / seats.length),
  y: Math.round(seats.reduce((s, x) => s + x.at.y, 0) / seats.length),
});
const coins = (a: Actor) => a.ctx?.coins ?? 0;

/** Small integer hash (FNV-1a style) so poses and bubbles do not depend on tick rate or RNG draws. */
function hash(...parts: number[]): number {
  let h = 2166136261;
  for (const p of parts) {
    h ^= p | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/**
 * The `n` seats that lie closest together (one end of a table rather than across the room).
 * Among equally tight groups, prefer one whose centre is not itself a seat, so the box lands on the table.
 */
function cluster(free: readonly Seat[], n: number, seatTiles: ReadonlySet<string>): Seat[] {
  let best: Seat[] = [];
  let bestScore = Infinity;
  for (const anchor of free) {
    const pick = [...free].sort((a, b) => dist(a.at, anchor.at) - dist(b.at, anchor.at)).slice(0, n);
    const spread = pick.reduce((s, a) => s + pick.reduce((t, b) => t + dist(a.at, b.at), 0), 0);
    const score = spread + (seatTiles.has(tile(centroid(pick))) ? 0.5 : 0);
    if (score < bestScore) [best, bestScore] = [pick, score];
  }
  return best;
}

/** Take the seat nearest to `home` out of `free`; seats are never shared. */
function nearest(free: Seat[], home: Point): Seat {
  let best = 0;
  for (let s = 1; s < free.length; s++) if (dist(free[s]!.at, home) < dist(free[best]!.at, home)) best = s;
  return free.splice(best, 1)[0]!;
}

export class PartyPlanner implements BehaviorProvider {
  readonly name = 'party';
  private world: World = { spots: [], chatTiles: [], rooms: [], night: false };
  private enabled = true;
  private paused = false;
  private pay: PartyFunding | null = null;
  private nextCheck: number | undefined;
  private seq = 0;
  private parties = new Map<string, Party>(); // party id -> party
  private memberOf = new Map<string, Party>(); // actor key -> party
  private departing = new Map<string, boolean>(); // actor key -> hurry
  private retryAt = new Map<string, number>(); // session id -> earliest next attempt

  constructor(
    private readonly rng: () => number = Math.random,
    private readonly o: PartyOptions = DEFAULT_PARTY_OPTIONS,
  ) {}

  /** Who pays for parties; null (the default, coin game off) means no parties at all. */
  setFunding(pay: PartyFunding | null): void {
    this.pay = pay;
  }

  setWorld(world: World): void {
    this.world = world;
    // The world is also rebuilt when only the time of day changes: parties whose seats still exist go on.
    for (const p of [...this.parties.values()]) {
      const room = world.rooms.find((r) => r.id === p.room.id);
      const seats = new Set(room?.seats.map((s) => tile(s.at)));
      if (room && [...p.members.values()].every((m) => seats.has(tile(m.seat.at)))) p.room = room;
      else this.end(p);
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) for (const p of [...this.parties.values()]) this.end(p);
  }

  /** 0 = no new parties; any other value keeps the usual check interval (parties are paid, not frequent). */
  setFrequency(multiplier: number): void {
    this.paused = !(multiplier > 0);
  }

  forget(actorKey: string): void {
    this.leave(actorKey, false);
    this.departing.delete(actorKey);
  }

  /** Parties in progress (gathering, eating or ending), oldest first. */
  currentParties(): PartyInfo[] {
    return [...this.parties.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map((p) => this.info(p));
  }

  partyOf(actorKey: string): PartyInfo | undefined {
    const p = this.memberOf.get(actorKey);
    return p ? this.info(p) : undefined;
  }

  tick(now: number, actors: readonly Actor[]): Map<string, Directive> {
    const byKey = new Map(actors.map((a) => [a.key, a]));
    for (const k of [...this.memberOf.keys()]) if (!byKey.has(k)) this.leave(k, false);
    for (const k of [...this.departing.keys()]) {
      const a = byKey.get(k);
      if (!a || (!a.moving && same(a.pos, a.home))) this.departing.delete(k);
    }

    // Real status wins: a member that is no longer idle leaves at once, in a hurry only for real
    // work (calmly when a higher-priority provider claimed it).
    for (const a of actors) {
      const hurry = a.ctx?.status !== 'idle';
      if (this.memberOf.has(a.key) && !a.idle) this.leave(a.key, hurry);
      else if (!a.idle && hurry && this.departing.has(a.key)) this.departing.set(a.key, true);
    }

    for (const p of [...this.parties.values()]) this.advance(p, now, byKey);

    this.nextCheck ??= now + this.o.checkEveryMs;
    if (now >= this.nextCheck) {
      this.nextCheck = now + this.o.checkEveryMs;
      if (this.pay && this.enabled && !this.paused) this.tryStart(now, actors, this.pay);
    }

    const out = new Map<string, Directive>();
    for (const a of actors) {
      const p = this.memberOf.get(a.key);
      const m = p?.members.get(a.key);
      out.set(a.key, p && m ? this.directive(p, m, a, now) : { type: 'home', hurry: this.departing.get(a.key) ?? false });
    }
    return out;
  }

  private info(p: Party): PartyInfo {
    const out: PartyInfo = {
      id: p.id,
      sessionId: p.sessionId,
      roomId: p.room.id,
      roomName: p.room.name,
      members: [...p.members.keys()],
      table: { ...p.table },
      phase: p.phase,
      createdAt: p.createdAt,
      simulated: true,
    };
    if (p.startedAt !== undefined) out.startedAt = p.startedAt;
    if (p.endsAt !== undefined) out.endsAt = p.endsAt;
    return out;
  }

  /** Arrival, serving, timeout, end and staggered departure. */
  private advance(p: Party, now: number, byKey: ReadonlyMap<string, Actor>): void {
    const members = [...p.members.values()];
    if (p.phase === 'gathering') {
      for (const m of members) {
        const a = byKey.get(m.key);
        if (a && !a.moving && same(a.pos, m.seat.at)) m.arrived = true;
      }
      if (members.every((m) => m.arrived)) {
        this.serve(p, now);
      } else if (now - p.createdAt >= this.o.arrivalTimeout) {
        for (const m of members) if (!m.arrived) this.leave(m.key, false);
        if (this.parties.has(p.id)) this.serve(p, now);
      }
    } else if (p.phase === 'eating' && now >= (p.endsAt ?? now)) {
      p.phase = 'ending';
      members.sort((x, y) => hash(p.seed, x.n, 5) - hash(p.seed, y.n, 5) || x.n - y.n);
      members.forEach((m, i) => (m.leaveAt = now + i * DEPARTURE_STAGGER));
    }
    if (p.phase === 'ending') for (const m of members) if (m.leaveAt !== undefined && now >= m.leaveAt) this.leave(m.key, false);
  }

  private serve(p: Party, now: number): void {
    if (p.members.size < 2) {
      this.end(p);
      return;
    }
    const [lo, hi] = this.o.eatMs;
    p.phase = 'eating';
    p.startedAt = now;
    p.endsAt = now + lo + this.rng() * (hi - lo);
  }

  /** Remove one member; before the end phase the party needs two to go on. */
  private leave(actorKey: string, hurry: boolean): void {
    const p = this.memberOf.get(actorKey);
    if (!p) return;
    this.memberOf.delete(actorKey);
    p.members.delete(actorKey);
    this.departing.set(actorKey, hurry || (this.departing.get(actorKey) ?? false));
    if (p.phase === 'ending' ? p.members.size === 0 : p.members.size < 2) this.end(p);
  }

  /** Immediate end: everyone still at the party walks back calmly. */
  private end(p: Party): void {
    this.parties.delete(p.id);
    for (const k of p.members.keys()) {
      this.memberOf.delete(k);
      this.departing.set(k, this.departing.get(k) ?? false);
    }
    p.members.clear();
  }

  private tryStart(now: number, actors: readonly Actor[], pay: PartyFunding): void {
    const min = Math.max(2, this.o.minMembers);
    const busy = new Set([...this.parties.values()].map((p) => p.sessionId));
    const teams = new Map<string, Actor[]>();
    for (const a of actors) {
      const c = a.ctx;
      if (!c || c.coins === undefined || !a.idle || a.away || a.moving || !same(a.pos, a.home) || busy.has(c.sessionId)) continue;
      if ((this.retryAt.get(c.sessionId) ?? 0) > now) continue;
      (teams.get(c.sessionId) ?? teams.set(c.sessionId, []).get(c.sessionId)!).push(a);
    }
    for (const [sessionId, team] of teams) {
      const ranked = team.sort((x, y) => coins(y) - coins(x) || x.key.localeCompare(y.key)).slice(0, Math.max(min, this.o.maxMembers));
      // A smaller group is fine when no room seats everyone, as long as it can still pay.
      for (let n = ranked.length; n >= min; n--) {
        const group = ranked.slice(0, n);
        if (group.reduce((s, a) => s + coins(a), 0) < this.o.price) break;
        const venue = this.venue(group, actors);
        if (!venue) continue;
        if (pay(group.map((a) => a.key), sessionId, now)) this.create(now, sessionId, venue.room, venue.seats, group);
        else this.retryAt.set(sessionId, now + this.o.checkEveryMs * RETRY_CHECKS);
        break;
      }
    }
  }

  /** The first free room (by kind preference, then distance to the members' desks) and a seat per member. */
  private venue(group: readonly Actor[], actors: readonly Actor[]): { room: RoomInfo; seats: Seat[] } | undefined {
    const keys = new Set(group.map((a) => a.key));
    const taken = new Set<string>();
    for (const a of actors) taken.add(tile(a.pos)).add(tile(a.home));
    for (const p of this.parties.values()) for (const m of p.members.values()) taken.add(tile(m.seat.at));
    const used = new Set([...this.parties.values()].map((p) => p.room.id));
    const spread = (r: RoomInfo) => group.reduce((s, a) => s + dist(a.home, { x: r.x + r.w / 2, y: r.y + r.h / 2 }), 0);
    const rooms = this.world.rooms
      // A non-member in the room may be in a meeting or on a break there.
      .filter(
        (r) => this.o.roomKinds.includes(r.kind) && !used.has(r.id) && !this.o.roomBusy?.(r.id) && !actors.some((a) => !keys.has(a.key) && inside(r, a.pos)),
      )
      .sort((a, b) => this.o.roomKinds.indexOf(a.kind) - this.o.roomKinds.indexOf(b.kind) || spread(a) - spread(b) || a.id.localeCompare(b.id));
    for (const room of rooms) {
      const all = roomSeats(room);
      const free = all.filter((s) => !taken.has(tile(s.at)));
      if (free.length < group.length) continue;
      const chosen = cluster(free, group.length, new Set(all.map((s) => tile(s.at))));
      return { room, seats: group.map((a) => nearest(chosen, a.home)) };
    }
    return undefined;
  }

  private create(now: number, sessionId: string, room: RoomInfo, seats: Seat[], group: readonly Actor[]): void {
    const all = roomSeats(room);
    const centre = centroid(seats);
    const p: Party = {
      id: `party-${room.id}-${++this.seq}`,
      sessionId,
      room,
      // Seats on one side of a long table can centre on a seat: use the whole table's centre then.
      table: all.some((s) => same(s.at, centre)) ? centroid(all) : centre,
      phase: 'gathering',
      createdAt: now,
      seed: Math.floor(this.rng() * 2 ** 31),
      members: new Map(),
    };
    group.forEach((a, i) => {
      p.members.set(a.key, { key: a.key, seat: seats[i]!, arrived: false, n: i });
      this.memberOf.set(a.key, p);
    });
    this.parties.set(p.id, p);
  }

  private directive(p: Party, m: Member, a: Actor, now: number): Directive {
    if (p.phase === 'gathering' && !m.arrived && !(!a.moving && same(a.pos, m.seat.at))) return { type: 'go', to: m.seat.at };
    const base = { type: 'do' as const, at: m.seat.at, face: m.seat.face, activity: ACTIVITY, groupId: p.id };
    if (p.phase !== 'eating') return { ...base, pose: 'stand' };
    // Everyone starts with a bite, then each member switches between eating and talking on its own beat.
    const t = now - (p.startedAt ?? now) + (hash(p.seed, m.n, 1) % TURN_MS);
    const turn = Math.floor(t / TURN_MS);
    const pose: ActorPose = turn % 2 === 0 ? 'eat' : 'talk';
    const h = hash(p.seed, m.n, turn, 2);
    if (pose === 'talk' && t % TURN_MS < BUBBLE_MS && h % 100 < 40) return { ...base, pose, bubble: ICONS[(h >>> 8) % ICONS.length]! };
    return { ...base, pose };
  }
}
