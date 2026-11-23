/**
 * Which sound goes with what (pure, so the rules can be tested). Real cues follow observed agent
 * state only; simulated cues follow the office animation and never suggest real work.
 */
import type { AgentStatus } from '@agent-office/core';

export type SfxKind =
  /** Real: a new agent (session, subagent, teammate) walks in. */
  | 'arrive'
  /** Real: a turn finished or a subagent completed. */
  | 'done'
  /** Real: an agent now waits for a permission decision or an answer. */
  | 'attention'
  /** Real: an agent failed. */
  | 'failed'
  /** Real: a tool call failed. */
  | 'toolFail'
  /** Real, verified: a delegation, task handoff or completion flies between desks. */
  | 'handoff'
  /** Simulated: a visitor comes in. */
  | 'visitor'
  /** Simulated: someone gets a coffee. */
  | 'coffee'
  /** Simulated: someone leaves the restroom. */
  | 'flush'
  /** Simulated: a template speech line appears. */
  | 'chatter'
  /** Simulated: an agent spends office coins (game layer). */
  | 'coin';

export const REAL_CUES: readonly SfxKind[] = ['arrive', 'done', 'attention', 'failed', 'toolFail', 'handoff'];
export const SIMULATED_CUES: readonly SfxKind[] = ['visitor', 'coffee', 'flush', 'chatter', 'coin'];

/** Sound for a real status change, if any (none for a first sighting or an unchanged status). */
export function cueForStatus(prev: AgentStatus | undefined, next: AgentStatus): SfxKind | undefined {
  if (prev === undefined || prev === next) return undefined;
  switch (next) {
    case 'waiting_permission':
    case 'waiting_input':
      return 'attention';
    case 'failed':
      return 'failed';
    case 'completed':
      return 'done';
    default:
      return undefined;
  }
}

/** Shortest gap between two plays of the same sound (ms), so bursts of events stay pleasant. */
export const MIN_GAP_MS: Record<SfxKind, number> = {
  arrive: 400,
  done: 300,
  attention: 600,
  failed: 600,
  toolFail: 500,
  handoff: 300,
  visitor: 2_000,
  coffee: 3_000,
  flush: 3_000,
  chatter: 700,
  coin: 400,
};

/** At most this many effects start within any one second. */
export const MAX_PER_SECOND = 6;
