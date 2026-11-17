/**
 * "Office life" for idle agents: coffee runs, snacks, reading, noticeboards, whiteboards,
 * watering plants, stretching, short walks, strolls to another department's doorway, sitting
 * in a lounge chair, chats, couch breaks, restroom trips.
 *
 * Purely cosmetic, local and deterministic for an injected RNG; only for actors whose real
 * status allows it (`Actor.idle`). Guarantees:
 * - Real status always wins: when `idle` turns false the activity is aborted and the actor goes
 *   home, in a hurry when the real status changed (also when it was already walking back) and
 *   calmly when another provider claimed it or idle life was switched off. No further
 *   simulated directive follows until the actor is idle again. The desk monitor and the
 *   inspector show the real status the whole time.
 * - Actors that another provider has away (`Actor.away`) are never scheduled or picked as a
 *   chat partner.
 * - At most `maxAwayShare` of the idle actors are away at once (a chat may take one extra).
 * - One actor per tile and per spot (restroom stall, coffee machine, chat tile, lounge chair,
 *   doorway); at most `maxPerKind` actors per activity kind (chats: conversations), no actor
 *   repeats its previous activity, and idle life sends nobody into a room that already holds
 *   `maxPerRoom` people who are away from their desks.
 * - SIMULATED speech: `Directive.speech` only ever contains verbatim lines from the local
 *   template table in dialogue.ts (no model, no network, never real agent output). The scene
 *   renders it in a distinct "simulated" bubble. Icon bubbles are still used for variety.
 * - setEnabled(false) sends everyone home; setFrequency(m) scales delays and cooldowns by 1/m.
 *
 * No rendering here: the scene feeds actors in and applies the returned directives.
 */
import type { RoomKind } from '@agent-office/core';
import type { Actor, BehaviorProvider, ChatIcon, Directive, Face, Point, SpotKind, World } from './behavior';
import { pickLine, type DialogueFamily, type DialogueRole } from './dialogue';
import type { OfficeWorld } from './world';

// Contract types live in behavior.ts; re-exported for existing imports.
export type { Actor, ChatIcon, Directive, Face, Point, Spot, World } from './behavior';
export { buildWorld } from './world';

export type ActivityKind =
  | 'chat'
  | 'coffee'
  | 'water'
  | 'toilet'
  | 'couch'
  | 'window'
  | 'snack'
  | 'books'
  | 'board'
  | 'whiteboard'
  | 'plant'
  | 'stretch'
  | 'walk'
  | 'stroll'
  | 'lounge';

/** Activities done at a World spot of the same kind; skipped when the world has none. */
export const SPOT_ACTIVITIES = ['coffee', 'water', 'snack', 'toilet', 'couch', 'window', 'books', 'board', 'whiteboard', 'plant'] as const satisfies readonly (ActivityKind &
  SpotKind)[];

export const ACTIVITY_KINDS: readonly ActivityKind[] = ['chat', ...SPOT_ACTIVITIES, 'stretch', 'walk', 'stroll', 'lounge'];

/** Rooms a stroll never peeks into (the actor's own room is skipped too). */
const NO_STROLL: ReadonlySet<RoomKind> = new Set<RoomKind>(['restroom', 'corridor']);

type DoDirective = Extract<Directive, { type: 'do' }>;

interface ChatTurn {
  /** Simulated line from the local template table. */
  speech?: string;
  icon?: ChatIcon;
}

interface Activity {
  kind: ActivityKind;
  phase: 'go' | 'do' | 'back';
  target: Point;
  face: Face;
  spotId?: string;
  partner?: string;
  leader?: boolean;
  startedAt: number;
  doAt?: number;
  doneAt?: number;
  seed: number;
  /** Chat: script shared by both participants; turn i is spoken by the leader when i is even. */
  script?: ChatTurn[];
  /** Solo: one simulated template line shown at the start of the 'do' phase. */
  speech?: string;
}

interface ActorState {
  nextAt: number;
  wasIdle: boolean;
  hurry: boolean;
  activity?: Activity;
  sipUntil?: number;
  /** Last activity started (never repeated immediately). */
  lastKind?: ActivityKind;
  /** Recently said lines (avoided for variety). */
  said: string[];
}

export interface DirectorOptions {
  /** Delay after becoming idle before the first trip (ms). */
  firstDelay: [number, number];
  /** Pause between trips (ms). */
  cooldown: [number, number];
  /** At most this share of idle agents are away at once. */
  maxAwayShare: number;
  /** At most this many actors per activity kind at once (chat: conversations). Default 2. */
  maxPerKind?: number;
  /**
   * Idle life sends nobody into a room that already holds this many people away from their
   * desks (any provider; idle-life trips count from the moment they start). Default 4.
   */
  maxPerRoom?: number;
  /** Only these activities may start (default: all). */
  activities?: readonly ActivityKind[];
  /** Chance (0..1) that a solo activity includes one simulated line. Default 0.35. */
  soloSpeechChance?: number;
  /** Chance (0..1) that a middle chat turn is a small-talk line instead of an icon. Default 0.3. */
  smallTalkChance?: number;
  /** Local hour (0-23) for time-of-day dialogue. Default: the local clock. */
  hourOf?: (now: number) => number;
}

export const DEFAULT_DIRECTOR_OPTIONS: DirectorOptions = {
  firstDelay: [12_000, 40_000],
  cooldown: [40_000, 120_000],
  maxAwayShare: 0.5,
};

export const DEFAULT_MAX_PER_KIND = 2;
export const DEFAULT_MAX_PER_ROOM = 4;

const DURATION: Record<ActivityKind, [number, number]> = {
  chat: [9_000, 16_000],
  coffee: [4_000, 5_000],
  water: [4_000, 6_000],
  toilet: [8_000, 14_000],
  couch: [15_000, 35_000],
  window: [6_000, 10_000],
  snack: [5_000, 8_000],
  books: [8_000, 14_000],
  board: [4_000, 7_000],
  whiteboard: [5_000, 8_000],
  plant: [4_000, 6_000],
  stretch: [2_500, 4_000],
  walk: [1_500, 3_000],
  stroll: [3_000, 5_000],
  lounge: [12_000, 25_000],
};

const WEIGHT: Record<ActivityKind, number> = {
  chat: 5,
  coffee: 2,
  water: 2,
  toilet: 1.5,
  couch: 2,
  window: 1,
  snack: 1.5,
  books: 1.5,
  board: 1,
  whiteboard: 1,
  plant: 1,
  stretch: 1,
  walk: 1.5,
  stroll: 1.5,
  lounge: 1.5,
};

const CHAT_ICONS: ChatIcon[] = ['chat_coffee', 'chat_music', 'chat_heart', 'chat_laugh', 'chat_idea', 'chat_dots'];
/** One chat turn; the last SPEAK_GAP_MS of each turn is silent so speakers visibly alternate. */
const SPEAK_MS = 2_200;
const SPEAK_GAP_MS = 300;
/** How long a solo line stays up at the start of an activity. */
const SOLO_SPEECH_MS = 2_600;
/** Give up (calmly) if the target or the chat partner is not reached in time. */
const GO_TIMEOUT_MS = 45_000;
/** Manhattan distance range for short walks. */
const WALK_RANGE: [number, number] = [3, 12];
/** A stroll goes at least this far (Manhattan) from the desk. */
const STROLL_MIN = 4;
/** Walks and strolls: how long each glance lasts while looking around. */
const LOOK_MS = 1_100;
const SAID_MEMORY = 6;

const key = (p: Point) => `${p.x},${p.y}`;
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const dist = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** The behavior world, with the optional extras buildWorld adds (lounge seats, doorways). */
type LifeWorld = World & Partial<Pick<OfficeWorld, 'lounges' | 'doorways'>>;

/** Everything about a world that activities depend on (not the lighting). */
function signature(w: LifeWorld): string {
  return JSON.stringify([w.spots, w.chatTiles, w.rooms, w.lounges ?? [], w.doorways ?? []]);
}

/** Glance sequence while standing somewhere for a walk or stroll: ahead, aside, ahead, the other side. */
export function lookAround(face: Face, seed: number, t: number): Face {
  const sides: readonly Face[] = face === 'up' || face === 'down' ? (seed < 0.5 ? ['left', 'right'] : ['right', 'left']) : ['down', face === 'left' ? 'right' : 'left'];
  const step = Math.floor(t / LOOK_MS) % 4;
  return step === 1 ? sides[0]! : step === 3 ? sides[1]! : face;
}

export class IdleDirector implements BehaviorProvider {
  readonly name = 'idle';
  private states = new Map<string, ActorState>();
  private reserved = new Map<string, string>(); // resource -> actor key
  private world: LifeWorld = { spots: [], chatTiles: [], rooms: [], night: false };
  private worldSig = '';
  private roomKinds = new Map<string, RoomKind>();
  /** People away from their desks per room id, counted each tick before trips start. */
  private load = new Map<string, number>();
  private enabled = true;
  private freq = 1;
  private lastNow: number | undefined;

  constructor(
    private readonly rng: () => number = Math.random,
    private readonly o: DirectorOptions = DEFAULT_DIRECTOR_OPTIONS,
  ) {}

  setWorld(world: LifeWorld): void {
    const sig = signature(world);
    const changed = sig !== this.worldSig;
    this.world = world;
    this.worldSig = sig;
    this.roomKinds = new Map(world.rooms.map((r) => [r.id, r.kind]));
    // Spots may have moved: everyone walks home (calmly) and starts fresh. A world that only
    // differs in lighting keeps the running activities.
    if (changed) for (const [k, st] of this.states) if (st.activity) this.abort(k, st, false);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) for (const [k, st] of this.states) if (st.activity) this.abort(k, st, false);
  }

  /**
   * Activity frequency multiplier (settings: low 0.5, normal 1, high 2). Delays and cooldowns
   * are divided by it; pending waits are rescaled immediately. Durations are unchanged.
   */
  setFrequency(multiplier: number): void {
    const m = Number.isFinite(multiplier) && multiplier > 0 ? Math.min(10, Math.max(0.1, multiplier)) : 1;
    if (m === this.freq) return;
    const now = this.lastNow;
    if (now !== undefined) for (const st of this.states.values()) if (!st.activity && st.nextAt > now) st.nextAt = now + ((st.nextAt - now) * this.freq) / m;
    this.freq = m;
  }

  get frequency(): number {
    return this.freq;
  }

  /** Spot occupied (e.g. restroom door shows "occupied"). */
  isInUse(spotId: string): boolean {
    if (!this.reserved.has(`spot:${spotId}`)) return false;
    for (const s of this.states.values()) if (s.activity?.spotId === spotId && s.activity.phase === 'do') return true;
    return false;
  }

  /** Recently fetched coffee: sips at the desk for a while. */
  isSipping(actorKey: string, now: number): boolean {
    return (this.states.get(actorKey)?.sipUntil ?? 0) > now;
  }

  activityOf(actorKey: string): ActivityKind | undefined {
    return this.states.get(actorKey)?.activity?.kind;
  }

  forget(actorKey: string): void {
    const st = this.states.get(actorKey);
    if (st?.activity) this.abort(actorKey, st);
    this.states.delete(actorKey);
  }

  private between([a, b]: [number, number]): number {
    return a + this.rng() * (b - a);
  }

  /** A delay scaled by the frequency multiplier. */
  private delay(range: [number, number]): number {
    return this.between(range) / this.freq;
  }

  private hour(now: number): number {
    return this.o.hourOf ? this.o.hourOf(now) : new Date(now).getHours();
  }

  private release(k: string): void {
    for (const [r, owner] of [...this.reserved]) if (owner === k) this.reserved.delete(r);
  }

  private abort(k: string, st: ActorState, hurry = true): void {
    const partner = st.activity?.partner;
    st.activity = undefined;
    if (hurry) st.hurry = true;
    this.release(k);
    if (this.lastNow !== undefined) st.nextAt = this.lastNow + this.delay(this.o.cooldown);
    if (partner) {
      const ps = this.states.get(partner);
      if (ps?.activity && ps.activity.partner === k) {
        // The partner just heads back calmly.
        ps.activity = { ...ps.activity, phase: 'back', partner: undefined };
        this.release(partner);
      }
    }
  }

  private remember(st: ActorState, text: string): void {
    st.said.push(text);
    if (st.said.length > SAID_MEMORY) st.said.shift();
  }

  /** Actors per activity kind right now (chats count conversations). */
  private countKind(kind: ActivityKind): number {
    let n = 0;
    for (const st of this.states.values()) if (st.activity?.kind === kind) n++;
    return kind === 'chat' ? Math.ceil(n / 2) : n;
  }

  tick(now: number, actors: readonly Actor[]): Map<string, Directive> {
    this.lastNow = now;
    const out = new Map<string, Directive>();
    const byKey = new Map(actors.map((a) => [a.key, a]));
    for (const k of [...this.states.keys()]) if (!byKey.has(k)) this.forget(k);

    for (const a of actors) {
      let st = this.states.get(a.key);
      if (!st) {
        st = { nextAt: now + this.delay(this.o.firstDelay), wasIdle: a.idle, hurry: false, said: [] };
        this.states.set(a.key, st);
      }
      if (!a.idle || !this.enabled) {
        // Real status (or a higher-priority provider) wins. Hurry only when the real status
        // changed, also for an actor already on its way back; one merely claimed by another
        // provider (still really idle) or sent home by the idle-life switch goes calmly.
        const real = a.ctx ? a.ctx.status !== 'idle' : !a.idle;
        if (st.activity) this.abort(a.key, st, real);
        else if (real && (a.moving || !same(a.pos, a.home))) st.hurry = true;
        st.wasIdle = false;
        out.set(a.key, { type: 'home', hurry: st.hurry });
        if (!a.moving && same(a.pos, a.home)) st.hurry = false;
        continue;
      }
      if (!st.wasIdle) {
        st.wasIdle = true;
        st.nextAt = now + this.delay(this.o.firstDelay);
      }
      if (!a.moving && same(a.pos, a.home)) st.hurry = false;
    }

    // Advance running activities.
    for (const a of actors) {
      const st = this.states.get(a.key)!;
      const act = st.activity;
      if (!act || !a.idle || !this.enabled) continue;
      if (act.phase === 'go' && now - act.startedAt > GO_TIMEOUT_MS) {
        this.abort(a.key, st, false);
        continue;
      }
      const arrived = !a.moving && same(a.pos, act.target);
      if (act.phase === 'go' && arrived) {
        if (act.kind === 'chat') {
          const p = act.partner ? this.states.get(act.partner)?.activity : undefined;
          const pa = act.partner ? byKey.get(act.partner) : undefined;
          const partnerHere = p && pa && !pa.moving && same(pa.pos, p.target);
          if (act.leader && partnerHere && p.phase === 'go') {
            const doneAt = now + this.between(DURATION.chat);
            const script = this.chatScript(a, pa, doneAt - now, now);
            act.phase = 'do';
            act.doAt = now;
            act.doneAt = doneAt;
            act.script = script;
            p.phase = 'do';
            p.doAt = now;
            p.doneAt = doneAt;
            p.script = script;
          }
        } else {
          act.phase = 'do';
          act.doAt = now;
          act.doneAt = now + this.between(DURATION[act.kind]);
          act.speech = this.soloLine(a, st, act.kind, now);
        }
      }
      if (act.phase === 'do' && act.doneAt !== undefined && now >= act.doneAt) {
        act.phase = 'back';
        this.release(a.key);
        if (act.kind === 'coffee') st.sipUntil = now + 30_000;
      }
      if (act.phase === 'back' && !a.moving && same(a.pos, a.home)) {
        st.activity = undefined;
        st.nextAt = now + this.delay(this.o.cooldown);
      }
    }

    // Start new activities.
    const idleActors = actors.filter((a) => a.idle);
    const away = () => idleActors.filter((a) => this.states.get(a.key)?.activity || a.away).length;
    const maxAway = Math.max(1, Math.floor(idleActors.length * this.o.maxAwayShare));
    if (this.enabled) {
      this.countLoad(actors);
      for (const a of idleActors) {
        const st = this.states.get(a.key)!;
        // Another provider has this actor away: leave it alone.
        if (st.activity || now < st.nextAt || a.moving || a.away || !same(a.pos, a.home)) continue;
        if (away() >= maxAway) break;
        this.start(a, st, now, idleActors);
      }
    }

    // Emit directives for idle actors.
    for (const a of actors) {
      if (out.has(a.key)) continue;
      const st = this.states.get(a.key)!;
      const act = st.activity;
      if (!act || act.phase === 'back') {
        out.set(a.key, { type: 'home', hurry: st.hurry });
        continue;
      }
      if (act.phase === 'go') {
        const arrived = !a.moving && same(a.pos, act.target);
        out.set(a.key, arrived ? this.doing(act, now, true) : { type: 'go', to: act.target });
        continue;
      }
      out.set(a.key, this.doing(act, now, false));
    }
    return out;
  }

  private doing(act: Activity, now: number, waiting: boolean): DoDirective {
    const base = { type: 'do' as const, at: act.target, face: act.face, activity: act.kind };
    const t = now - (act.doAt ?? now);
    const len = (act.doneAt ?? now) - (act.doAt ?? now);
    // Solo lines replace the icon bubble while they are up.
    const line = !waiting && act.speech !== undefined && t < SOLO_SPEECH_MS ? act.speech : undefined;
    const say = (d: DoDirective): DoDirective => {
      if (line === undefined) return d;
      const { bubble: _icon, ...rest } = d;
      return { ...rest, speech: line };
    };
    switch (act.kind) {
      case 'chat': {
        if (waiting) return { ...base, pose: 'stand' };
        const turn = Math.floor(t / SPEAK_MS);
        const speaking = (turn % 2 === 0) === Boolean(act.leader);
        // Short pause at the end of each turn so bubbles visibly alternate.
        const talking = speaking && t % SPEAK_MS < SPEAK_MS - SPEAK_GAP_MS;
        if (!talking) return { ...base, pose: 'stand' };
        if (act.script) {
          const step = act.script[turn];
          if (!step) return { ...base, pose: 'stand' }; // script over: quiet until the chat ends
          if (step.speech !== undefined) return { ...base, pose: 'talk', speech: step.speech };
          if (step.icon) return { ...base, pose: 'talk', bubble: step.icon };
        }
        const icon = CHAT_ICONS[Math.abs(Math.floor(act.seed * 1000) + turn) % CHAT_ICONS.length]!;
        return { ...base, pose: 'talk', bubble: icon };
      }
      case 'toilet':
        return waiting ? { ...base, pose: 'stand' } : { ...base, pose: 'stand', hidden: true };
      case 'couch':
        return say({ ...base, pose: 'couch', bubble: !waiting && t % 7000 < 1800 ? 'chat_music' : undefined });
      case 'water':
        return say(!waiting && t > len / 2 ? { ...base, face: 'down', pose: 'drink' } : { ...base, pose: 'stand' });
      case 'coffee':
        return say({ ...base, pose: 'stand', bubble: !waiting && t < 1600 ? 'chat_coffee' : undefined });
      case 'window':
        return say({ ...base, pose: 'stand', bubble: !waiting && t < 2200 ? (this.world.night ? 'chat_moon' : 'chat_sun') : undefined });
      case 'snack':
        // Grab something facing the counter, then turn round and eat (with chewing pauses).
        if (waiting || t < len * 0.3) return say({ ...base, pose: 'stand' });
        return say({ ...base, face: 'down', pose: Math.floor(t / 700) % 3 === 2 ? 'stand' : 'eat' });
      case 'books':
        // Pick a book facing the shelf, then turn round and read.
        if (waiting || t < len * 0.25) return say({ ...base, pose: 'stand' });
        return say({ ...base, face: 'down', pose: 'read' });
      case 'board':
      case 'whiteboard':
        return say({ ...base, pose: 'stand', bubble: !waiting && t > len / 2 && t < len / 2 + 1600 ? 'chat_idea' : undefined });
      case 'plant':
        // The scene shows a watering can for activity 'plant' (poses.ts spritePose).
        return say({ ...base, pose: 'stand' });
      case 'stretch':
        return say({ ...base, pose: !waiting && t < len - 500 ? 'stretch' : 'stand' });
      case 'walk':
      case 'stroll':
        // Stands there and looks around (a stroll looks into another department's room).
        return say({ ...base, face: waiting ? act.face : lookAround(act.face, act.seed, t), pose: 'stand' });
      case 'lounge':
        // Sits in a lounge chair; now and then hums along to some music.
        return say({ ...base, pose: 'sit_meeting', bubble: !waiting && t % 9000 > 5000 && t % 9000 < 6400 ? 'chat_music' : undefined });
    }
  }

  /** Maybe one simulated template line for a solo activity (never for the restroom). */
  private soloLine(a: Actor, st: ActorState, kind: ActivityKind, now: number): string | undefined {
    if (kind === 'toilet' || kind === 'chat') return undefined;
    if (this.rng() >= (this.o.soloSpeechChance ?? 0.35)) return undefined;
    const line = pickLine({ role: 'solo', activity: kind, self: a.ctx, now, hour: this.hour(now), night: this.world.night, rng: this.rng, avoid: st.said });
    if (line) this.remember(st, line.text);
    return line?.text;
  }

  /**
   * Conversation for one chat: opener (leader, about the partner / the clock), reply (partner,
   * about itself), icons or small talk, and a closing line. All lines are local templates.
   */
  private chatScript(leader: Actor, follower: Actor | undefined, durationMs: number, now: number): ChatTurn[] {
    const turns = Math.max(2, Math.floor(durationMs / SPEAK_MS));
    const hour = this.hour(now);
    const night = this.world.night;
    const say = (turn: number, role: DialogueRole, after?: DialogueFamily) => {
      const lead = turn % 2 === 0;
      const st = this.states.get(lead ? leader.key : (follower?.key ?? ''));
      const line = pickLine({
        role,
        activity: 'chat',
        self: lead ? leader.ctx : follower?.ctx,
        partner: lead ? follower?.ctx : leader.ctx,
        after,
        now,
        hour,
        night,
        rng: this.rng,
        avoid: st?.said,
      });
      if (line && st) this.remember(st, line.text);
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
      if (this.rng() < (this.o.smallTalkChance ?? 0.3)) {
        const small = say(i, 'small_talk');
        if (small) {
          script.push({ speech: small.text });
          continue;
        }
      }
      script.push(icon());
    }
    return script;
  }

  /** Room id containing a tile, if any. */
  private roomIdAt(p: Point): string | undefined {
    for (const r of this.world.rooms) if (p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h) return r.id;
    return undefined;
  }

  /** People away from their desks per room: idle-life trips by destination, others where they stand. */
  private countLoad(actors: readonly Actor[]): void {
    this.load.clear();
    if (!this.world.rooms.length) return;
    const add = (roomId: string | undefined) => {
      if (roomId) this.load.set(roomId, (this.load.get(roomId) ?? 0) + 1);
    };
    for (const a of actors) {
      const act = this.states.get(a.key)?.activity;
      if (act) {
        // A stretch at one's own desk does not crowd the room.
        if (act.phase !== 'back' && !same(act.target, a.home)) add(this.roomIdAt(act.target));
      } else if (a.away || !same(a.pos, a.home)) add(this.roomIdAt(a.pos));
    }
  }

  /** Room `roomId` can take `n` more people (rooms without an id always can). */
  private fits(roomId: string | undefined, n = 1): boolean {
    return !roomId || (this.load.get(roomId) ?? 0) + n <= (this.o.maxPerRoom ?? DEFAULT_MAX_PER_ROOM);
  }

  private occupy(roomId: string | undefined, n = 1): void {
    if (roomId) this.load.set(roomId, (this.load.get(roomId) ?? 0) + n);
  }

  private tileFree(p: Point): boolean {
    return !this.reserved.has(`tile:${key(p)}`);
  }

  /** Unreserved chat tiles for a short walk, preferably at a moderate distance from home. */
  private walkTiles(home: Point): Point[] {
    const free = this.world.chatTiles.filter((t) => this.tileFree(t) && !same(t, home) && this.fits(this.roomIdAt(t)));
    const near = free.filter((t) => dist(t, home) >= WALK_RANGE[0] && dist(t, home) <= WALK_RANGE[1]);
    return near.length ? near : free.filter((t) => dist(t, home) >= 2);
  }

  /** Free doorways of other rooms (not the actor's own, not restrooms or corridors) for a stroll. */
  private strollTargets(a: Actor): Array<{ roomId: string; at: Point; face: Face }> {
    const doors = this.world.doorways;
    if (!doors?.length) return [];
    const own = a.ctx?.homeRoomId ?? this.roomIdAt(a.home);
    return doors.filter((d) => {
      const kind = this.roomKinds.get(d.roomId);
      return kind !== undefined && !NO_STROLL.has(kind) && d.roomId !== own && dist(d.at, a.home) >= STROLL_MIN && this.tileFree(d.at) && this.fits(d.roomId);
    });
  }

  private start(a: Actor, st: ActorState, now: number, idle: readonly Actor[]): void {
    const cap = this.o.maxPerKind ?? DEFAULT_MAX_PER_KIND;
    const allowed = (k: ActivityKind) => (!this.o.activities || this.o.activities.includes(k)) && k !== st.lastKind && this.countKind(k) < cap;
    const freeSpots = (kind: SpotKind) =>
      this.world.spots.filter((s) => s.kind === kind && !this.reserved.has(`spot:${s.id}`) && this.tileFree(s.at) && this.fits(s.roomId ?? this.roomIdAt(s.at)));
    const chatTiles = allowed('chat')
      ? this.world.chatTiles.filter((t) => this.tileFree(t) && this.tileFree({ x: t.x + 1, y: t.y }) && this.fits(this.roomIdAt(t), 2))
      : [];
    const partners = allowed('chat')
      ? idle.filter((b) => {
          if (b.key === a.key || b.moving || b.away || !same(b.pos, b.home)) return false;
          const bs = this.states.get(b.key);
          // Any idle colleague sitting at their desk is up for a chat (unless just back from a break or a chat).
          return bs && !bs.activity && bs.wasIdle && bs.lastKind !== 'chat' && bs.nextAt <= now + 60_000;
        })
      : [];
    const options: Array<[ActivityKind, number]> = [];
    if (partners.length && chatTiles.length) options.push(['chat', WEIGHT.chat]);
    // Spot kinds the world does not have are simply skipped.
    for (const k of SPOT_ACTIVITIES) if (allowed(k) && freeSpots(k).length) options.push([k, WEIGHT[k]]);
    if (allowed('stretch')) options.push(['stretch', WEIGHT.stretch]);
    const walkTiles = allowed('walk') ? this.walkTiles(a.home) : [];
    if (walkTiles.length) options.push(['walk', WEIGHT.walk]);
    const strolls = allowed('stroll') ? this.strollTargets(a) : [];
    if (strolls.length) options.push(['stroll', WEIGHT.stroll]);
    const lounges = allowed('lounge') ? (this.world.lounges ?? []).filter((l) => this.tileFree(l.at) && this.fits(l.roomId ?? this.roomIdAt(l.at))) : [];
    if (lounges.length) options.push(['lounge', WEIGHT.lounge]);
    if (!options.length) {
      st.nextAt = now + this.delay(this.o.cooldown);
      return;
    }
    const total = options.reduce((s, [, w]) => s + w, 0);
    let r = this.rng() * total;
    let kind: ActivityKind = options[0]![0];
    for (const [k, w] of options) {
      if ((r -= w) <= 0) {
        kind = k;
        break;
      }
    }
    const seed = this.rng();
    if (kind === 'chat') {
      const b = partners.reduce((best, p) => (dist(p.home, a.home) < dist(best.home, a.home) ? p : best));
      const mid = { x: Math.round((a.home.x + b.home.x) / 2), y: Math.round((a.home.y + b.home.y) / 2) };
      const tile = chatTiles.reduce<Point | undefined>((best, t) => (!best || dist(t, mid) < dist(best, mid) ? t : best), undefined);
      if (!tile) {
        st.nextAt = now + this.delay(this.o.cooldown);
        return;
      }
      const right = { x: tile.x + 1, y: tile.y };
      // Whoever is further left takes the left tile; they face each other.
      const [leftKey, rightKey] = a.home.x <= b.home.x ? [a.key, b.key] : [b.key, a.key];
      this.reserved.set(`tile:${key(tile)}`, leftKey);
      this.reserved.set(`tile:${key(right)}`, rightKey);
      const mk = (target: Point, face: Face, partner: string, leader: boolean): Activity => ({ kind: 'chat', phase: 'go', target, face, partner, leader, startedAt: now, seed });
      const ls = this.states.get(leftKey)!;
      const rs = this.states.get(rightKey)!;
      ls.activity = mk(tile, 'right', rightKey, leftKey === a.key);
      rs.activity = mk(right, 'left', leftKey, rightKey === a.key);
      ls.lastKind = 'chat';
      rs.lastKind = 'chat';
      this.occupy(this.roomIdAt(tile), 2);
      return;
    }
    st.lastKind = kind;
    if (kind === 'stretch') {
      // In place, next to the desk.
      st.activity = { kind, phase: 'go', target: { ...a.home }, face: 'down', startedAt: now, seed };
      return;
    }
    if (kind === 'walk') {
      const tile = walkTiles[Math.min(walkTiles.length - 1, Math.floor(this.rng() * walkTiles.length))]!;
      this.reserved.set(`tile:${key(tile)}`, a.key);
      this.occupy(this.roomIdAt(tile));
      const looks: Face[] = ['left', 'right', 'down'];
      st.activity = { kind, phase: 'go', target: tile, face: looks[Math.floor(seed * looks.length)] ?? 'down', startedAt: now, seed };
      return;
    }
    if (kind === 'stroll') {
      // Pick another room, then the entrance of it nearest to the desk; look in from there.
      const roomIds = [...new Set(strolls.map((d) => d.roomId))];
      const roomId = roomIds[Math.min(roomIds.length - 1, Math.floor(this.rng() * roomIds.length))]!;
      const door = strolls.filter((d) => d.roomId === roomId).reduce((best, d) => (dist(d.at, a.home) < dist(best.at, a.home) ? d : best));
      this.reserved.set(`tile:${key(door.at)}`, a.key);
      this.occupy(roomId);
      st.activity = { kind, phase: 'go', target: { ...door.at }, face: door.face, startedAt: now, seed };
      return;
    }
    if (kind === 'lounge') {
      const seat = lounges.reduce((best, l) => (dist(l.at, a.home) < dist(best.at, a.home) ? l : best));
      this.reserved.set(`tile:${key(seat.at)}`, a.key);
      this.occupy(seat.roomId ?? this.roomIdAt(seat.at));
      st.activity = { kind, phase: 'go', target: { ...seat.at }, face: seat.face, startedAt: now, seed };
      return;
    }
    const spot = freeSpots(kind).reduce((best, s) => (dist(s.at, a.home) < dist(best.at, a.home) ? s : best));
    this.reserved.set(`spot:${spot.id}`, a.key);
    this.reserved.set(`tile:${key(spot.at)}`, a.key);
    this.occupy(spot.roomId ?? this.roomIdAt(spot.at));
    st.activity = { kind, phase: 'go', target: spot.at, face: spot.face, spotId: spot.id, startedAt: now, seed };
  }
}
