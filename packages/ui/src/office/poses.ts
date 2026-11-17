/**
 * Pose and desk-presentation rules (pure; no rendering, no randomness).
 *
 * - spritePose(): semantic ActorPose from a behavior provider → sprite pose drawn by
 *   drawCharacter(). Simulated activities only ever get dedicated poses; they never reuse the
 *   poses that signal real status (raised hand = permission, cheer = done, slump = failed).
 * - workPresentation(): desk animation + monitor screen for an agent's REAL status, chosen by
 *   fixed local rules from observed data (status, statusDetail, running tool name/summary,
 *   recent failure kind). "Thinking" is shown only when the reducer's statusDetail is exactly
 *   'Thinking' (a model turn in progress after a tool finished), never from inactivity.
 */
import type { AgentStatus } from '@agent-office/core';
import type { ActorPose, Face } from './behavior';
import type { Pose, ScreenKind } from './pixelArt';

/** Every semantic pose of the behavior contract (checked against ActorPose at compile time). */
export const ACTOR_POSES = ['stand', 'couch', 'drink', 'talk', 'read', 'eat', 'stretch', 'sit_meeting', 'present', 'wave'] as const satisfies readonly ActorPose[];
type MissingActorPose = Exclude<ActorPose, (typeof ACTOR_POSES)[number]>;
// Fails to compile if ActorPose gains a member that ACTOR_POSES (and spritePose) do not cover.
const ACTOR_POSES_COMPLETE: [MissingActorPose] extends [never] ? true : never = true;
void ACTOR_POSES_COMPLETE;

export const FACES: readonly Face[] = ['up', 'down', 'left', 'right'];

export interface SpritePose {
  pose: Pose;
  /** Mirror horizontally (side views facing left). */
  flip: boolean;
}

export interface SpritePoseOptions {
  /** Directive.activity, for activity-specific sprites (e.g. 'plant' → watering can). */
  activity?: string;
  /** Animation frame counter (e.g. Math.floor(t / 250)); used by 'wave'. */
  frame?: number;
}

/** Map a provider's semantic pose + facing to a sprite pose that drawCharacter() supports. */
export function spritePose(pose: ActorPose, face: Face, opts: SpritePoseOptions = {}): SpritePose {
  const side = face === 'left' || face === 'right';
  const flip = face === 'left';
  switch (pose) {
    case 'stand':
      if (opts.activity === 'plant') return { pose: 'water', flip };
      return { pose: face === 'up' ? 'walk_up_0' : face === 'down' ? 'stand' : 'walk_side_0', flip };
    case 'couch':
      return { pose: 'couch', flip: false };
    case 'drink':
      return { pose: 'drink', flip: false };
    case 'talk':
      return { pose: side ? 'side_talk' : face === 'up' ? 'walk_up_0' : 'talk_front', flip };
    case 'read':
      return { pose: 'read', flip: false };
    case 'eat':
      return { pose: 'eat', flip: false };
    case 'stretch':
      return { pose: 'stretch', flip: false };
    case 'sit_meeting':
      return { pose: side ? 'sit_meeting_side' : face === 'up' ? 'sit' : 'sit_meeting', flip };
    case 'present':
      return { pose: side ? 'present' : face === 'up' ? 'present_up' : 'present_front', flip };
    case 'wave':
      return { pose: (opts.frame ?? 0) % 2 ? 'wave1' : 'wave', flip: false };
  }
}

/**
 * Animate a seated desk pose over time (t in ms, include a per-worker offset). Speeds match
 * the scene's existing blink rates: typing 170 ms, permission 550 ms, cheer 300 ms.
 */
export function seatedFrame(pose: Pose, t: number): Pose {
  switch (pose) {
    case 'type0':
    case 'type1':
      return Math.floor(t / 170) % 2 === 0 ? 'type0' : 'type1';
    case 'sit_read':
    case 'sit_read1':
      return Math.floor(t / 900) % 3 === 2 ? 'sit_read1' : 'sit_read';
    case 'sit_raise':
      return Math.floor(t / 550) % 2 === 0 ? 'sit_raise' : 'sit';
    case 'sit_cheer':
      return Math.floor(t / 300) % 2 === 0 ? 'sit_cheer' : 'sit';
    default:
      return pose;
  }
}

// ------------------------------------------------------------------ idle variety (simulated, neutral poses only)

/** Seated poses an idle agent cycles through at its desk. None of them signals a real state. */
export const IDLE_DESK_POSES = ['sit', 'sit_stretch', 'sit_sip'] as const satisfies readonly Pose[];

export interface IdleDeskOptions {
  /** Just back from a coffee run: sips every few seconds. */
  sipping?: boolean;
  /** Reduced motion: hold the plain sitting pose (sipping still shows the mug). */
  still?: boolean;
  /** Per-worker number (e.g. a hash) so idle agents do not move in sync. */
  variant?: number;
}

/**
 * Idle at the desk (t in ms, include a per-worker offset): mostly sitting, with a stretch and a
 * sip in each cycle. The cycle length (12-16 s) and an extra stretch depend on `variant`.
 */
export function idleDeskPose(t: number, opts: IdleDeskOptions = {}): (typeof IDLE_DESK_POSES)[number] {
  if (opts.sipping) return t % 5000 < 2600 ? 'sit_sip' : 'sit';
  if (opts.still) return 'sit';
  const v = Math.abs(Math.floor(opts.variant ?? 0));
  const period = 12_000 + (v % 5) * 1_000;
  const c = ((t % period) + period) % period;
  if (c < 700) return 'sit_stretch';
  if (c > period * 0.5 && c < period * 0.5 + 1_400) return 'sit_sip';
  if (v % 3 === 0 && c > period * 0.8 && c < period * 0.8 + 600) return 'sit_stretch';
  return 'sit';
}

const STAND: SpritePose = Object.freeze({ pose: 'stand', flip: false });
const GLANCE_RIGHT: SpritePose = Object.freeze({ pose: 'walk_side_0', flip: false });
const GLANCE_LEFT: SpritePose = Object.freeze({ pose: 'walk_side_0', flip: true });

/**
 * Idle and standing (no desk, or waiting for a free spot): facing the room, with a glance to
 * each side now and then. `still` (reduced motion) just stands.
 */
export function idleStandPose(t: number, variant = 0, still = false): SpritePose {
  if (still) return STAND;
  const v = Math.abs(Math.floor(variant));
  const period = 7_000 + (v % 4) * 900;
  const c = ((t % period) + period) % period;
  if (c > period / 2 && c < period / 2 + 1_000) return v % 2 ? GLANCE_LEFT : GLANCE_RIGHT;
  if (c > period - 1_200) return v % 2 ? GLANCE_RIGHT : GLANCE_LEFT;
  return STAND;
}

// ------------------------------------------------------------------ tool classification (local rules)

export type ToolCategory = 'read' | 'search' | 'edit' | 'test' | 'build' | 'command' | 'wait' | 'other';

const READ_TOOLS = new Set(['Read', 'NotebookRead', 'WebFetch']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'LS', 'ToolSearch']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** Tools whose only job is waiting on other work (subagents, background shells). */
const WAIT_TOOLS = new Set(['Agent', 'Task', 'BashOutput', 'TaskOutput', 'AgentOutputTool', 'Monitor']);

const TEST_RUNNER = /\b(vitest|jest|pytest|py\.test|mocha|phpunit|pest|rspec|karma|jasmine|nextest|ctest|tox|nose2|unittest|invoke-pester|pester)\b|\bplaywright\s+test\b|\bcypress\s+run\b/i;
const TEST_COMMAND =
  /\b(npm|pnpm|yarn|bun|deno|go|cargo|dotnet|mvn|mvnw|gradle|gradlew|make|mix|swift|flutter|dart|composer|rake|rails|sbt|lein|stack|cabal|zig\s+build|php\s+artisan)\s+(run\s+)?(test|tests|t)\b/i;
const TEST_PHRASE = /\b(run|runs|running|rerun|re-run|execute|executing)\b(\s+\S+){0,3}?\s+(tests?|specs?)\b|\b(unit|integration|e2e|end-to-end|regression|smoke|component)\s+tests?\b|\btest\s+suite\b/i;
const BUILD =
  /\b(build|builds|compile|compiling|tsc|typecheck|type-check|webpack|rollup|esbuild|msbuild|cmake|make|vite\s+build|gradle\s+assemble|mvn\s+(package|compile|install)|cargo\s+(build|check)|go\s+build|dotnet\s+build)\b/i;

/** Does a (sanitized) shell command summary look like a test run? Local heuristic. */
export function looksLikeTest(summary: string | undefined): boolean {
  return !!summary && (TEST_RUNNER.test(summary) || TEST_COMMAND.test(summary) || TEST_PHRASE.test(summary));
}

/** Does a (sanitized) shell command summary look like a build/compile/typecheck? Local heuristic. */
export function looksLikeBuild(summary: string | undefined): boolean {
  return !!summary && !looksLikeTest(summary) && BUILD.test(summary);
}

/** Category of a tool call from its name and sanitized summary. */
export function classifyTool(toolName: string | undefined, summary?: string): ToolCategory {
  if (!toolName) return 'other';
  if (READ_TOOLS.has(toolName)) return 'read';
  if (SEARCH_TOOLS.has(toolName)) return 'search';
  if (EDIT_TOOLS.has(toolName)) return 'edit';
  if (SHELL_TOOLS.has(toolName)) return looksLikeTest(summary) ? 'test' : looksLikeBuild(summary) ? 'build' : 'command';
  if (WAIT_TOOLS.has(toolName)) return 'wait';
  return 'other';
}

/** Local rule for ActorContext.recentFailure.kind from a failed tool call. */
export function failureKind(toolName: string, summary?: string): 'test' | 'build' | 'tool' {
  const c = classifyTool(toolName, summary);
  return c === 'test' ? 'test' : c === 'build' ? 'build' : 'tool';
}

// ------------------------------------------------------------------ desk presentation for real states

export type WorkMode =
  | 'reading'
  | 'searching'
  | 'editing'
  | 'testing'
  | 'debugging'
  | 'command'
  | 'waiting'
  | 'tool'
  | 'thinking'
  | 'busy'
  | 'permission'
  | 'input'
  | 'finishing'
  | 'failed'
  | 'idle'
  | 'unknown'
  | 'ended';

/** Seated pose (animate with seatedFrame) and monitor screen per mode. */
export const WORK_MODES: Readonly<Record<WorkMode, { seatedPose: Pose; screen: ScreenKind }>> = {
  reading: { seatedPose: 'sit_read', screen: 'read' },
  searching: { seatedPose: 'sit_read', screen: 'search' },
  editing: { seatedPose: 'type0', screen: 'edit' },
  testing: { seatedPose: 'sit_lean', screen: 'test' },
  debugging: { seatedPose: 'sit_debug', screen: 'debug' },
  command: { seatedPose: 'type0', screen: 'terminal' },
  waiting: { seatedPose: 'sit_lean', screen: 'wait' },
  tool: { seatedPose: 'sit', screen: 'code' },
  thinking: { seatedPose: 'sit_think', screen: 'think' },
  busy: { seatedPose: 'sit', screen: 'busy' },
  permission: { seatedPose: 'sit_raise', screen: 'perm' },
  input: { seatedPose: 'sit', screen: 'ask' },
  finishing: { seatedPose: 'sit_cheer', screen: 'done' },
  failed: { seatedPose: 'sit_slump', screen: 'fail' },
  idle: { seatedPose: 'sit', screen: 'saver' },
  unknown: { seatedPose: 'sit', screen: 'noise' },
  ended: { seatedPose: 'sit', screen: 'off' },
};

/** The only statusDetail that may be presented as "thinking" (set by the reducer after a tool finishes). */
export const THINKING_DETAIL = 'Thinking';

export interface WorkInput {
  status: AgentStatus;
  /** Reducer statusDetail, verbatim. */
  detail?: string;
  /** Name of the tool that is currently running, if any. */
  toolName?: string;
  /** Sanitized summary of that tool call (falls back to `detail`, which the reducer sets to it). */
  toolSummary?: string;
  /** Kind of a recent failed tool call (see failureKind), if the caller considers it recent. */
  recentFailure?: 'test' | 'build' | 'tool';
  /** Idle session inside the scene's celebration window right after a real turn completion. */
  justFinished?: boolean;
  /** No events for a while (reducer `stale`): never presented as thinking. */
  stale?: boolean;
}

export interface WorkPresentation {
  seatedPose: Pose;
  screen: ScreenKind;
  mode: WorkMode;
}

/**
 * Desk animation and monitor screen for a REAL state. Precedence: waiting for permission /
 * input, failed, finished, idle, unknown, ended; then (working) the running tool's category;
 * then debugging (recent failure or "Recovering from …" detail); then thinking (detail exactly
 * 'Thinking', not stale); otherwise a neutral "busy" screen.
 */
export function workPresentation(input: WorkInput): WorkPresentation {
  const p = (mode: WorkMode): WorkPresentation => ({ mode, ...WORK_MODES[mode] });
  switch (input.status) {
    case 'waiting_permission':
      return p('permission');
    case 'waiting_input':
      return p('input');
    case 'failed':
      return p('failed');
    case 'completed':
      return p('finishing');
    case 'idle':
      return p(input.justFinished ? 'finishing' : 'idle');
    case 'unknown':
      return p('unknown');
    case 'ended':
      return p('ended');
    case 'working':
      break;
  }
  if (input.toolName) {
    switch (classifyTool(input.toolName, input.toolSummary ?? input.detail)) {
      case 'read':
        return p('reading');
      case 'search':
        return p('searching');
      case 'edit':
        return p('editing');
      case 'test':
        return p('testing');
      case 'build':
      case 'command':
        return p(input.recentFailure ? 'debugging' : 'command');
      case 'wait':
        return p('waiting');
      case 'other':
        return p('tool');
    }
  }
  if (input.recentFailure || input.detail?.startsWith('Recovering from ')) return p('debugging');
  if (input.detail === THINKING_DETAIL && !input.stale) return p('thinking');
  return p('busy');
}
