/**
 * Short office animations of verified collaboration events (TeamEvent, from collab.ts
 * collabVisuals). Nothing here is simulated or inferred: an interaction starts only for a
 * delegation or task handoff that Claude Code actually reported, and it only shows that the
 * event happened. It is not a message: no speech, only a pose and an optional icon bubble.
 *
 * - Briefing ('delegate'): the newly spawned subagent stops on a free tile next to its
 *   parent's desk on its way in, faces the parent and talks for at most `briefingMs`, then
 *   walks on to its own desk. The parent never leaves its desk. Skipped when the detour is
 *   long, when either agent is not in the office or when no tile next to the desk is free.
 *   Several children spawned in parallel get distinct tiles.
 * - Handoff ('handoff'): only when the task creator and the completer are both idle, the
 *   completer walks to a tile next to the creator's desk, talks for `handoffMs` and walks
 *   back. Otherwise nothing happens here (the scene's task-card flight still shows it).
 *
 * Real status always wins. A briefing holds a working subagent for a few seconds only and
 * ends at once on a permission prompt, a question, a failure or an unknown status; a handoff
 * ends as soon as either agent stops being idle. Everything is released at the latest
 * `maxHoldMs` after the event was received. Local and deterministic (injected RNG, `now`
 * passed in): no model, no network, no tokens.
 *
 * Register it before the meeting scheduler and idle life, so they see the actors it holds as
 * not idle and drop their own plans for them.
 */
import type { AgentStatus } from '@agent-office/core';
import type { Actor, BehaviorProvider, ChatIcon, Directive, Face, Point, TeamEvent, World } from './behavior';

export type TeamworkKind = 'briefing' | 'handoff';
export type TeamworkPhase = 'pending' | 'go' | 'talk';

export interface TeamworkOptions {
  /** Standing time next to the parent's desk after arriving (ms). At most about 3 s. */
  briefingMs: number;
  /** Talking time next to the creator's desk after arriving (ms). At most about 3 s. */
  handoffMs: number;
  /** Events whose agents are not in the office (or, for a handoff, not both idle) by then are dropped (ms after receipt). */
  startWithinMs: number;
  /** Hard cap: every interaction is released this long after its event was received (ms). */
  maxHoldMs: number;
  /** Longest extra walk a briefing may add to a subagent's way to its desk (tiles, Manhattan). */
  maxDetour: number;
  /** Longest walk to the creator's desk for a handoff (tiles, Manhattan). */
  maxHandoffWalk: number;
  /** Interactions waiting or running at once; further events are ignored (bounded memory). */
  maxActive: number;
}

export const DEFAULT_TEAMWORK_OPTIONS: TeamworkOptions = {
  briefingMs: 2_500,
  handoffMs: 3_000,
  startWithinMs: 4_000,
  maxHoldMs: 15_000,
  maxDetour: 12,
  maxHandoffWalk: 24,
  maxActive: 16,
};

/** Read-only view of an interaction (diagnostics and tests). Always caused by a verified event. */
export interface TeamworkInfo {
  /** Id of the TeamEvent that caused it. */
  eventId: string;
  kind: TeamworkKind;
  /** Agent that walks: the new subagent (briefing) or the task completer (handoff). */
  mover: string;
  /** Agent whose desk it walks to: the parent (briefing) or the task creator (handoff). */
  anchor: string;
  phase: TeamworkPhase;
  target?: Point;
  verified: true;
}

/** Statuses during which a briefing may hold a subagent; anything else ends it at once. */
const HOLDABLE: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['working', 'idle']);
/** Statuses that also send the subagent to its desk in a hurry. */
const ATTENTION: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['waiting_permission', 'waiting_input', 'failed', 'unknown']);

/** Tiles around a desk seat in preference order (side-on first: the talk pose reads best), facing the seat. */
const AROUND: ReadonlyArray<{ dx: number; dy: number; face: Face }> = [
  { dx: -1, dy: 0, face: 'right' },
  { dx: 1, dy: 0, face: 'left' },
  { dx: -1, dy: 1, face: 'right' },
  { dx: 1, dy: 1, face: 'left' },
  { dx: 0, dy: 1, face: 'up' },
  { dx: -1, dy: -1, face: 'right' },
  { dx: 1, dy: -1, face: 'left' },
  { dx: 0, dy: -1, face: 'down' },
];

const HANDOFF_ICONS: readonly ChatIcon[] = ['chat_idea', 'chat_dots', 'chat_heart'];
/** The handoff icon shows for the first part of the talk only. */
const ICON_MS = 1_600;
/** Released actors keep getting `home` (with their hurry flag) until home or for this long. */
const RELEASE_MS = 6_000;
const SEEN_MAX = 500;

interface Interaction {
  eventId: string;
  kind: TeamworkKind;
  mover: string;
  anchor: string;
  groupId: string;
  receivedAt: number;
  phase: TeamworkPhase;
  target?: Point;
  face?: Face;
  /** The anchor's home when the interaction started; a re-seat ends it. */
  anchorHome?: Point;
  arrivedAt?: number;
  bubble?: ChatIcon;
}

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const dist = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const tile = (p: Point) => `${p.x},${p.y}`;

export class TeamworkProvider implements BehaviorProvider {
  readonly name = 'teamwork';
  private world: World = { spots: [], chatTiles: [], rooms: [], night: false };
  private enabled = true;
  private lastNow: number | undefined;
  /** Mover key -> interaction (one per mover at a time). */
  private active = new Map<string, Interaction>();
  private released = new Map<string, { hurry: boolean; until: number }>();
  private seen = new Set<string>();
  /** Known free floor tiles (chat tiles and their right neighbours: never a desk seat or a spot). */
  private floor = new Set<string>();
  /** Meeting seats and presenter spots. */
  private seats = new Set<string>();

  constructor(
    private readonly rng: () => number = Math.random,
    private readonly o: TeamworkOptions = DEFAULT_TEAMWORK_OPTIONS,
  ) {}

  setWorld(world: World): void {
    this.world = world;
    this.floor = new Set(world.chatTiles.flatMap((t) => [tile(t), tile({ x: t.x + 1, y: t.y })]));
    this.seats = new Set(world.rooms.flatMap((r) => [...r.seats.map((s) => tile(s.at)), ...(r.presenter ? [tile(r.presenter.at)] : [])]));
    // A target the new layout blocks is given up.
    for (const it of [...this.active.values()]) if (it.target && !this.walkable(it.target)) this.release(it, false);
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) for (const it of [...this.active.values()]) this.release(it, false);
  }

  /** The actor was re-seated or left: running interactions with it end, unstarted ones are kept. */
  forget(actorKey: string): void {
    for (const it of [...this.active.values()]) if (it.phase !== 'pending' && (it.mover === actorKey || it.anchor === actorKey)) this.release(it, false);
    this.released.delete(actorKey);
  }

  onTeamEvents(events: readonly TeamEvent[], now: number): void {
    for (const ev of events) {
      if (this.seen.has(ev.id)) continue;
      this.seen.add(ev.id);
      if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
      if (!this.enabled || ev.from === ev.to || (ev.kind !== 'delegate' && ev.kind !== 'handoff')) continue;
      if (this.active.has(ev.to) || this.active.size >= this.o.maxActive) continue;
      const kind: TeamworkKind = ev.kind === 'delegate' ? 'briefing' : 'handoff';
      this.active.set(ev.to, { eventId: ev.id, kind, mover: ev.to, anchor: ev.from, groupId: `${kind}:${ev.from}`, receivedAt: now, phase: 'pending' });
    }
  }

  /** Interactions waiting for their agents or running, oldest first. */
  current(): TeamworkInfo[] {
    return [...this.active.values()]
      .sort((x, y) => x.receivedAt - y.receivedAt || x.mover.localeCompare(y.mover))
      .map((it) => {
        const info: TeamworkInfo = { eventId: it.eventId, kind: it.kind, mover: it.mover, anchor: it.anchor, phase: it.phase, verified: true };
        if (it.target) info.target = { ...it.target };
        return info;
      });
  }

  tick(now: number, actors: readonly Actor[]): Map<string, Directive> {
    this.lastNow = now;
    const byKey = new Map(actors.map((a) => [a.key, a]));
    for (const it of [...this.active.values()]) this.advance(it, now, byKey);

    const out = new Map<string, Directive>();
    for (const it of this.active.values()) {
      if (it.phase === 'pending' || !it.target) continue;
      out.set(it.mover, it.phase === 'go' ? { type: 'go', to: it.target } : this.talking(it, now));
    }
    for (const [k, r] of [...this.released]) {
      const a = byKey.get(k);
      if (!a || now >= r.until || (!a.moving && same(a.pos, a.home))) this.released.delete(k);
      else if (!out.has(k)) out.set(k, { type: 'home', hurry: r.hurry });
    }
    return out;
  }

  // ---------------------------------------------------------------- internals

  private walkable(p: Point): boolean {
    return this.world.isWalkable ? this.world.isWalkable(p) : true;
  }

  private release(it: Interaction, hurry: boolean): void {
    if (this.active.get(it.mover) === it) this.active.delete(it.mover);
    if (it.phase === 'pending') return; // never moved: nothing to undo
    const prev = this.released.get(it.mover);
    this.released.set(it.mover, { hurry: hurry || (prev?.hurry ?? false), until: (this.lastNow ?? it.receivedAt) + RELEASE_MS });
  }

  private advance(it: Interaction, now: number, byKey: ReadonlyMap<string, Actor>): void {
    if (!this.enabled || now - it.receivedAt >= this.o.maxHoldMs) return this.release(it, false);
    const mover = byKey.get(it.mover);
    const anchor = byKey.get(it.anchor);
    if (it.phase === 'pending') {
      if (!mover || !anchor || !this.canStart(it, mover, anchor) || !this.begin(it, mover, anchor, byKey)) {
        if (now - it.receivedAt >= this.o.startWithinMs) this.active.delete(it.mover);
        return;
      }
    }
    if (!mover || !anchor) return this.release(it, false);
    const stop = this.stopReason(it, mover, anchor);
    if (stop) return this.release(it, stop === 'hurry');
    if (it.phase === 'go' && !mover.moving && same(mover.pos, it.target!)) {
      it.phase = 'talk';
      it.arrivedAt = now;
    }
    if (it.phase === 'talk' && now - it.arrivedAt! >= (it.kind === 'briefing' ? this.o.briefingMs : this.o.handoffMs)) this.release(it, false);
  }

  private canStart(it: Interaction, mover: Actor, anchor: Actor): boolean {
    // A briefing happens on the way in: a subagent already settled at its desk is left alone.
    if (it.kind === 'briefing') return (!mover.ctx || HOLDABLE.has(mover.ctx.status)) && (mover.moving || !same(mover.pos, mover.home));
    // Handoffs are for two idle agents only, the creator sitting at its desk.
    return mover.idle && anchor.idle && !anchor.away && !anchor.moving && same(anchor.pos, anchor.home);
  }

  /** Why a running interaction must end now: 'hurry' (real status needs the agent), 'calm', or undefined. */
  private stopReason(it: Interaction, mover: Actor, anchor: Actor): 'hurry' | 'calm' | undefined {
    if (!same(anchor.home, it.anchorHome!)) return 'calm';
    if (it.kind === 'briefing') {
      const status = mover.ctx?.status;
      if (status === undefined || HOLDABLE.has(status)) return undefined;
      return ATTENTION.has(status) ? 'hurry' : 'calm';
    }
    if (!mover.idle) return !mover.ctx || mover.ctx.status !== 'idle' ? 'hurry' : 'calm';
    // The creator got busy or walked off: the completer heads back.
    if (!anchor.idle || anchor.moving || !same(anchor.pos, anchor.home)) return 'calm';
    return undefined;
  }

  /** Pick a free tile next to the anchor's desk; false when there is none or the walk is too long. */
  private begin(it: Interaction, mover: Actor, anchor: Actor, byKey: ReadonlyMap<string, Actor>): boolean {
    const taken = new Set<string>();
    for (const a of byKey.values()) {
      if (a.key === mover.key) continue;
      taken.add(tile(a.home));
      if (!a.moving) taken.add(tile(a.pos));
    }
    for (const other of this.active.values()) if (other !== it && other.target) taken.add(tile(other.target));
    const h = anchor.home;
    const options = AROUND.map((o, i) => ({ at: { x: h.x + o.dx, y: h.y + o.dy }, face: o.face, i }))
      .filter((c) => !same(c.at, mover.home) && !taken.has(tile(c.at)) && !this.seats.has(tile(c.at)) && this.walkable(c.at))
      .filter((c) =>
        it.kind === 'briefing'
          ? dist(mover.pos, c.at) + dist(c.at, mover.home) - dist(mover.pos, mover.home) <= this.o.maxDetour
          : dist(mover.pos, c.at) <= this.o.maxHandoffWalk,
      );
    if (!options.length) return false;
    // Known floor tiles first (never a free desk seat or a spot), then preference order.
    const rank = (c: { at: Point; i: number }) => (this.floor.size && !this.floor.has(tile(c.at)) ? 100 : 0) + c.i;
    const pick = options.reduce((best, c) => (rank(c) < rank(best) ? c : best));
    it.phase = 'go';
    it.target = pick.at;
    it.face = pick.face;
    it.anchorHome = { ...h };
    if (it.kind === 'handoff') it.bubble = HANDOFF_ICONS[Math.min(HANDOFF_ICONS.length - 1, Math.floor(this.rng() * HANDOFF_ICONS.length))];
    return true;
  }

  private talking(it: Interaction, now: number): Extract<Directive, { type: 'do' }> {
    const d: Extract<Directive, { type: 'do' }> = { type: 'do', at: it.target!, face: it.face!, pose: 'talk', activity: it.kind, groupId: it.groupId, verified: true };
    if (it.bubble && now - (it.arrivedAt ?? now) < ICON_MS) d.bubble = it.bubble;
    return d;
  }
}
