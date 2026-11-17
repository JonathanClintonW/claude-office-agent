/**
 * Final say over behavior directives, applied by the scene after every provider has answered
 * (pure; no rendering, no randomness).
 *
 * 1. Real status wins. An actor whose real state does not allow simulated activity
 *    (`idle: false`) only ever gets `home`, except for providers that react to verified
 *    collaboration events (`trusted`), which may briefly move it (`go`) or hold it in a
 *    `verified` pose. When the real status needs attention (permission, question, failure,
 *    unknown), every actor goes home in a hurry, trusted or not.
 * 2. One worker per destination. A tile that another worker owns (its home, or a destination
 *    it was given first) is not handed out again: the newcomer waits where it stands (`hold`)
 *    until the tile is free. A busy actor whose verified detour is taken goes home instead.
 */
import type { AgentStatus } from '@agent-office/core';
import type { Directive, Point } from './behavior';

export interface ArbiterActor {
  key: string;
  /** Simulated activity allowed: really idle, not stale, not celebrating a finished turn. */
  idle: boolean;
  /** Real status, if known. */
  status?: AgentStatus;
  home: Point;
  /** Where the worker is heading or resting right now, if anywhere. */
  target?: Point;
}

export interface Claim {
  directive: Directive;
  /** The provider handles verified collaboration events and may move busy actors briefly. */
  trusted: boolean;
}

/** Hold position: stay on the current tile this tick. */
export type Resolved = Directive | { type: 'hold' };

/** Real statuses that always send the worker straight back to its desk. */
export const ATTENTION_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['waiting_permission', 'waiting_input', 'failed', 'unknown']);

const tile = (p: Point) => `${p.x},${p.y}`;
const same = (a: Point | undefined, b: Point) => a !== undefined && a.x === b.x && a.y === b.y;

function destination(d: Directive): Point | undefined {
  return d.type === 'go' ? d.to : d.type === 'do' ? d.at : undefined;
}

/**
 * How a worker rests on a tile: on its own home as its home says (seated at a desk, standing in
 * the lounge), anywhere else standing. Used both when a directive's destination is the home
 * (e.g. a stretch at the desk) and when a `home` directive finds the worker already there, so a
 * worker never ends up standing at its own desk.
 */
export function restPhase<P extends string>(at: Point, home: Point, homeArrive: P, elsewhere: P): P {
  return at.x === home.x && at.y === home.y ? homeArrive : elsewhere;
}

/** Whether the real state lets this claim stand. */
export function allowed(a: ArbiterActor, c: Claim): boolean {
  const d = c.directive;
  if (d.type === 'home') return true;
  if (a.idle) return true;
  if (a.status !== undefined && ATTENTION_STATUSES.has(a.status)) return false;
  return c.trusted && (d.type === 'go' || d.verified === true);
}

/**
 * Resolve each actor's directive. `claims` are the winning non-home directives (in provider
 * priority order), `homes` the home directives. Actors without either go home calmly.
 */
export function resolveDirectives(actors: readonly ArbiterActor[], claims: ReadonlyMap<string, Claim>, homes: ReadonlyMap<string, Directive>): Map<string, Resolved> {
  const out = new Map<string, Resolved>();
  const owner = new Map<string, string>();
  for (const a of actors) if (!owner.has(tile(a.home))) owner.set(tile(a.home), a.key);
  const byKey = new Map(actors.map((a) => [a.key, a]));
  const pending: Array<{ a: ArbiterActor; d: Directive; at: Point }> = [];

  for (const a of actors) {
    const home = homes.get(a.key);
    const homeDirective: Directive = home?.type === 'home' ? home : { type: 'home', hurry: false };
    const c = claims.get(a.key);
    if (!c) {
      out.set(a.key, homeDirective);
      continue;
    }
    if (!allowed(a, c)) {
      // A real status change (anything but idle) means hurry; stale or celebrating actors go calmly.
      const hurry = (a.status !== undefined && a.status !== 'idle') || (homeDirective.type === 'home' && homeDirective.hurry);
      out.set(a.key, { type: 'home', hurry });
      continue;
    }
    const at = destination(c.directive);
    if (!at) {
      out.set(a.key, c.directive);
      continue;
    }
    pending.push({ a, d: c.directive, at });
  }

  // Whoever is already heading to (or resting on) its destination keeps it; then priority order.
  const ordered = [...pending.filter((p) => same(p.a.target, p.at)), ...pending.filter((p) => !same(p.a.target, p.at))];
  for (const { a, d, at } of ordered) {
    const k = tile(at);
    const o = owner.get(k);
    if (o === undefined || o === a.key) {
      owner.set(k, a.key);
      out.set(a.key, d);
      continue;
    }
    // Taken. A busy actor (verified detour) goes on to its desk; an idle one waits its turn.
    out.set(a.key, byKey.get(a.key)!.idle ? { type: 'hold' } : { type: 'home', hurry: false });
  }
  return out;
}
