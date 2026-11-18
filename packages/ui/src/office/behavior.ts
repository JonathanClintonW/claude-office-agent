/**
 * Behavior contract shared by the scene and its behavior providers.
 *
 * Behavior providers drive the purely cosmetic, locally simulated part of the office:
 * idle life (idleLife.ts) and simulated meetings/group breaks (meetings.ts). They never
 * call any model, never invent real agent activity, and always yield to real status:
 * an actor whose real status is not idle is sent home. The only exception is a short
 * interaction triggered by a verified real event (see TeamEvent): it may hold a non-idle
 * actor for at most a few seconds and must end at once on a permission prompt, a
 * question or a failure.
 *
 * The scene asks providers in priority order. Actors claimed by a higher-priority provider
 * (any directive other than `home`) are passed to lower-priority providers with
 * `idle: false`, so those abort their own activity and never fight over an actor.
 */
import type { AgentKind, AgentStatus, RoomKind } from '@agent-office/core';

export interface Point {
  x: number;
  y: number;
}

export type Face = 'up' | 'down' | 'left' | 'right';

/** Icon-only speech bubbles. */
export type ChatIcon = 'chat_coffee' | 'chat_music' | 'chat_heart' | 'chat_laugh' | 'chat_idea' | 'chat_sun' | 'chat_moon' | 'chat_dots';

/** Semantic poses providers can request; the scene maps them to sprite poses. */
export type ActorPose = 'stand' | 'couch' | 'drink' | 'talk' | 'read' | 'eat' | 'stretch' | 'sit_meeting' | 'present' | 'wave';

export type SpotKind = 'coffee' | 'water' | 'snack' | 'toilet' | 'couch' | 'window' | 'books' | 'board' | 'whiteboard' | 'plant';

export interface Spot {
  id: string;
  kind: SpotKind;
  /** Tile the worker walks to (walkable). */
  at: Point;
  face: Face;
  roomId?: string;
}

export interface Seat {
  at: Point;
  face: Face;
}

/** A room derived from the layout (rooms are layout semantics, not Claude roles). */
export interface RoomInfo {
  id: string;
  name: string;
  kind: RoomKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Sittable/standable positions around tables (meeting and collaboration rooms). */
  seats: Seat[];
  capacity: number;
  /** Where a presenter stands (e.g. in front of a whiteboard), if any. */
  presenter?: Seat;
}

export interface World {
  spots: Spot[];
  /** Left tiles of horizontal walkable tile pairs where two workers can stand and chat. */
  chatTiles: Point[];
  rooms: RoomInfo[];
  night: boolean;
  /** Whether a worker can stand on a tile (set by the scene; absent in plain test worlds). */
  isWalkable?(p: Point): boolean;
}

/** Local, real-data-derived context that simulated behavior (e.g. dialogue) may use. */
export interface ActorContext {
  kind: AgentKind;
  sessionId: string;
  parentKey?: string;
  status: AgentStatus;
  /** Duration of the agent's most recent observed working stretch (ms), if known. */
  lastWorkMs?: number;
  /** Most recent failed tool, classified locally by rules (never by a model). */
  recentFailure?: { kind: 'test' | 'build' | 'tool'; at: number };
  /** When the agent last completed a turn (sessions) or finished (subagents). */
  finishedAt?: number;
  /** Room containing the actor's home desk, if any. */
  homeRoomId?: string;
}

export interface Actor {
  key: string;
  /** Real status allows simulated activity (idle and not stale/unknown) and no higher provider claimed it. */
  idle: boolean;
  /** Currently away from home on an activity from ANY provider. */
  away?: boolean;
  home: Point;
  pos: Point;
  moving: boolean;
  ctx?: ActorContext;
}

export type Directive =
  | { type: 'home'; hurry: boolean }
  | { type: 'go'; to: Point }
  | {
      type: 'do';
      at: Point;
      face: Face;
      pose: ActorPose;
      /** Free-form activity name for diagnostics/inspector (e.g. 'coffee', 'meeting'). */
      activity: string;
      bubble?: ChatIcon;
      /** Simulated speech from a LOCAL template (never a model, never real agent output). */
      speech?: string;
      hidden?: boolean;
      /** Shared id for group activities (meetings). */
      groupId?: string;
      /**
       * A short interaction triggered by a verified real event (TeamEvent): the scene shows
       * the pose even when the actor's real status is not idle. Speech is still shown only
       * for idle actors, and real status bubbles always win.
       */
      verified?: boolean;
    };

/**
 * A verified, real collaboration event observed between two agents (collab.ts
 * collabVisuals): a delegation (parent spawned the subagent), a task handoff (creator to
 * completer) or a completion (subagent back to its parent). Never inferred, never simulated.
 */
export interface TeamEvent {
  id: string;
  kind: 'delegate' | 'handoff' | 'complete';
  from: string;
  to: string;
  /** Time of the evidence (ms). */
  at: number;
  /** Sanitized, truncated task subject for handoffs, when the event carried one. */
  detail?: string;
}

export interface BehaviorProvider {
  readonly name: string;
  setWorld(world: World): void;
  setEnabled(on: boolean): void;
  /** Activity frequency multiplier from settings (1 = normal, 0.5 = half as often). */
  setFrequency?(multiplier: number): void;
  tick(now: number, actors: readonly Actor[]): Map<string, Directive>;
  forget(actorKey: string): void;
  /** Spot currently used (e.g. restroom door shows "occupied"). */
  isInUse?(spotId: string): boolean;
  /** Newly observed verified collaboration events (each id delivered once). */
  onTeamEvents?(events: readonly TeamEvent[], now: number): void;
}
