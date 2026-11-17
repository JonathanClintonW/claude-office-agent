/**
 * SIMULATED dialogue for idle life and simulated visitors.
 *
 * A fixed, local template library: no model, no network, no prompt, no Claude API/CLI/MCP.
 * Every line an idle worker can "say" is listed verbatim in DIALOGUE_TABLE below (and in
 * docs/SIMULATION.md) so the whole vocabulary can be audited.
 *
 * Honesty rules:
 * - Lines are cosmetic small talk, rendered by the scene in a distinct "simulated" bubble.
 *   They are never real agent output and never shown as a Claude message.
 * - Rules may only look at real, locally observed facts (ActorContext: status, length of the
 *   last working stretch, the kind of the most recent failure, when the agent finished, its
 *   kind) plus the local clock, and only generically: a template never contains file names,
 *   numbers, tool output, prompts or invented results. "Finally, the tests passed." is only
 *   possible when the caller observed a successful test-like run after a test-like failure.
 * - Picking is deterministic for a given RNG.
 */
import type { ActorContext } from './behavior';

/** Marker for consumers: every line from this module is simulated, local template text. */
export const SPEECH_SOURCE = 'local-template' as const;

export type DialogueRole =
  /** First line of a chat (the leader, about the partner or the time of day). */
  | 'open'
  /** Answer to the opener (the partner, about itself). */
  | 'reply'
  /** Optional filler in the middle of a chat. */
  | 'small_talk'
  /** Last line of a chat. */
  | 'close'
  /** A single line during a solo activity. */
  | 'solo';

export type DialogueFamily =
  | 'open_partner_failure'
  | 'open_partner_long'
  | 'open_partner_finished'
  | 'open_morning'
  | 'open_late'
  | 'open_teammates'
  | 'open_generic'
  | 'open_coffee'
  | 'self_tests_passed'
  | 'self_test_failure'
  | 'self_build_failure'
  | 'self_tool_failure'
  | 'self_long_debug'
  | 'self_long_work'
  | 'self_just_finished'
  | 'reply_agree'
  | 'reply_morning'
  | 'reply_hey'
  | 'reply_late'
  | 'reply_positive'
  | 'reply_neutral'
  | 'small_talk'
  | 'close_back'
  | 'close_late'
  | 'act_coffee'
  | 'act_coffee_late'
  | 'act_water'
  | 'act_snack'
  | 'act_books'
  | 'act_board'
  | 'act_whiteboard'
  | 'act_plant'
  | 'act_stretch'
  | 'act_window_day'
  | 'act_window_night'
  | 'act_couch'
  | 'act_walk'
  | 'visit_open'
  | 'visit_reply'
  | 'visit_close'
  | 'visit_reception'
  | 'visit_room';

/** The complete vocabulary. Nothing outside this table can ever be returned. */
export const DIALOGUE_TABLE: Readonly<Record<DialogueFamily, readonly string[]>> = {
  open_partner_failure: ['Another bug?', 'Rough patch?', 'Something acting up?'],
  open_partner_long: ["You've been at it a while.", 'Long session?', 'Time for a breather?'],
  open_partner_finished: ['All done?', 'Wrapped up?', 'Finished for now?'],
  open_morning: ['Morning!', 'Good morning!', 'Early start?'],
  open_late: ['Working late?', 'Long night?', 'Still here?'],
  open_teammates: ['Hey, teammate!', "How's the team?"],
  open_generic: ["How's your project going?", "How's it going?", 'Busy day?', 'Taking a break too?'],
  open_coffee: ['Coffee break?', 'Need a coffee?'],
  self_tests_passed: ['Finally, the tests passed.', 'The tests are happy again.'],
  self_test_failure: ['Those tests are giving me trouble.', 'The tests disagree with me.'],
  self_build_failure: ['The build is being stubborn.', 'Fighting the build.'],
  self_tool_failure: ['Hit a snag earlier.', "Something didn't cooperate."],
  self_long_debug: ['That was a long debugging session.', 'Long debugging session.'],
  self_long_work: ['That was a long stretch.', 'Long one. Need a breather.'],
  self_just_finished: ['Done for now!', 'Just wrapped up.', 'Finished for now.'],
  reply_agree: ['Sounds good.', 'Good idea.', 'Maybe later.'],
  reply_morning: ['Morning!', 'Hi there!'],
  reply_hey: ['Hey!', 'Hey there!'],
  reply_late: ['Night owl, I guess.', 'Just a bit longer.'],
  reply_positive: ["Can't complain.", 'Not bad, thanks.'],
  reply_neutral: ['One step at a time.', 'Just taking a breather.', 'Taking it easy for now.'],
  small_talk: ['Ha, true.', 'Right?', 'Good point.', 'Makes sense.', 'This office is cozy.'],
  close_back: ['Back to work!', 'Well, back to it.', 'Catch you later!', 'Good chat.'],
  close_late: ["Don't stay too late!", 'Get some rest soon.'],
  act_coffee: ['I need some coffee.', 'Coffee time.', 'Fresh coffee, please.'],
  act_coffee_late: ['Late-night coffee.', 'One more coffee.'],
  act_water: ['Staying hydrated.', 'Just some water.'],
  act_snack: ['Snack time.', 'Just a quick bite.'],
  act_books: ['Some light reading.', 'Nice book collection.', 'Where was I?'],
  act_board: ['Anything new on the board?', "Let's see what's posted."],
  act_whiteboard: ['Interesting diagram.', 'Who drew this?', 'Hmm, let me think.'],
  act_plant: ['These plants look thirsty.', 'There you go, little plant.'],
  act_stretch: ['Time to stretch.', 'Ahh, much better.'],
  act_window_day: ['Nice view.', 'A bit of daylight.'],
  act_window_night: ['Quiet night.', 'Look at the stars.'],
  act_couch: ['Just resting my eyes.', 'A short break.'],
  act_walk: ['Stretching my legs.', 'Quick walk.'],
  visit_open: ['First time here?', 'Are you visiting too?', 'Here for a meeting?'],
  visit_reply: ['Yes, just looking around.', 'Just dropping by.', 'Yes, I have a meeting soon.'],
  visit_close: ['Nice meeting you!', 'Enjoy your visit!', 'See you around!'],
  visit_reception: ["Hi, I'm here for a visit.", 'Checking in.', 'Where do I sign in?'],
  visit_room: ['Nice setup in here.', 'So this is where it happens.', 'What a nice room.'],
};

/** Real-data facts a rule may use. `lastTestPassAt` is optional and only set by callers that observed it. */
export interface DialogueFacts extends ActorContext {
  /** Time of the most recent observed successful test-like command, if the caller tracks it. */
  lastTestPassAt?: number;
}

export interface DialogueInput {
  role: DialogueRole;
  /** Activity being done (idle-life ActivityKind, e.g. 'coffee'; 'chat' for chats). */
  activity: string;
  /** The speaker's real context. */
  self?: DialogueFacts;
  /** The other chat participant's real context. */
  partner?: DialogueFacts;
  /** Family of the line being answered (role 'reply'). */
  after?: DialogueFamily;
  now: number;
  /** Local hour 0-23. */
  hour: number;
  /** Night lighting in the office (window lines); derived from `hour` when omitted. */
  night?: boolean;
  /**
   * The speaker is a simulated visitor (visitors.ts): no real context, so only rules marked
   * for visitors apply. Agents never get the visitor lines.
   */
  visitor?: boolean;
  rng: () => number;
  /** Recently said lines to avoid (variety); ignored when a family has nothing else. */
  avoid?: readonly string[];
}

export interface DialogueLine {
  text: string;
  family: DialogueFamily;
  /** Always true: local template text, never a real message. */
  simulated: true;
}

/** Thresholds used by the rules (exported for docs/tests). */
export const DIALOGUE_THRESHOLDS = {
  /** "Just finished": the agent finished at most this long ago. */
  justFinishedMs: 3 * 60_000,
  /** "Long working stretch": the last observed working stretch was at least this long. */
  longWorkMs: 20 * 60_000,
  /** A failure older than this is no longer talked about. */
  recentFailureMs: 20 * 60_000,
} as const;

// ------------------------------------------------------------------ fact helpers (generic only)

function failureOf(f: DialogueFacts | undefined, now: number): 'test' | 'build' | 'tool' | undefined {
  const r = f?.recentFailure;
  if (!r || now - r.at < 0 || now - r.at > DIALOGUE_THRESHOLDS.recentFailureMs) return undefined;
  return r.kind;
}

/** Tests passed (observed) after an observed test failure, both recent. */
export function testsPassedAfterFailure(f: DialogueFacts | undefined, now: number): boolean {
  const pass = f?.lastTestPassAt;
  return failureOf(f, now) === 'test' && pass !== undefined && pass > f!.recentFailure!.at && pass <= now;
}

/** Kind of a recent failure that has not been superseded by a later observed test pass. */
export function openFailure(f: DialogueFacts | undefined, now: number): 'test' | 'build' | 'tool' | undefined {
  return testsPassedAfterFailure(f, now) ? undefined : failureOf(f, now);
}

export function justFinished(f: DialogueFacts | undefined, now: number): boolean {
  const at = f?.finishedAt;
  return at !== undefined && now >= at && now - at <= DIALOGUE_THRESHOLDS.justFinishedMs;
}

export function longWork(f: DialogueFacts | undefined): boolean {
  return (f?.lastWorkMs ?? 0) >= DIALOGUE_THRESHOLDS.longWorkMs;
}

const isMorning = (h: number) => h >= 5 && h < 11;
const isLate = (h: number) => h >= 20 || h < 5;
const isNight = (c: DialogueInput) => c.night ?? (c.hour >= 19 || c.hour < 5);

// ------------------------------------------------------------------ rules

export interface DialogueRule {
  family: DialogueFamily;
  roles: readonly DialogueRole[];
  /** Plain-language condition, mirrored in docs/SIMULATION.md. */
  when: string;
  /** Relative weight among the rules that apply. */
  weight: number;
  /** For replies: the opener families this rule can answer. */
  after?: readonly DialogueFamily[];
  /** Who may say it: agents only (default), simulated visitors only, or both. */
  speakers?: 'agents' | 'visitors' | 'both';
  test: (c: DialogueInput) => boolean;
}

const ANSWERS_HOW: readonly DialogueFamily[] = ['open_generic', 'open_partner_long', 'open_partner_failure', 'open_late'];
const always = () => true;
const act = (activity: string) => (c: DialogueInput) => c.activity === activity;

/** Every rule, in table order. Auditable: conditions only use the facts listed in DialogueFacts and the clock. */
export const DIALOGUE_RULES: readonly DialogueRule[] = [
  // chat openers (leader, about the partner / the clock)
  { family: 'open_partner_failure', roles: ['open'], weight: 6, when: 'partner had a failed tool call in the last 20 min (and no later test pass)', test: (c) => openFailure(c.partner, c.now) !== undefined },
  { family: 'open_partner_long', roles: ['open'], weight: 5, when: "partner's last working stretch was 20 min or longer", test: (c) => longWork(c.partner) },
  { family: 'open_partner_finished', roles: ['open'], weight: 5, when: 'partner finished in the last 3 min', test: (c) => justFinished(c.partner, c.now) },
  { family: 'open_morning', roles: ['open'], weight: 2, when: 'local time 05:00-10:59', test: (c) => isMorning(c.hour) },
  { family: 'open_late', roles: ['open'], weight: 2, when: 'local time 20:00-04:59', test: (c) => isLate(c.hour) },
  { family: 'open_teammates', roles: ['open'], weight: 2, when: 'both are agent-team teammates', test: (c) => c.self?.kind === 'teammate' && c.partner?.kind === 'teammate' },
  { family: 'open_generic', roles: ['open'], weight: 3, when: 'always', test: always },
  { family: 'open_coffee', roles: ['open'], weight: 1, when: 'always', test: always },

  // the speaker's own (real) context: chat replies and solo lines
  {
    family: 'self_tests_passed',
    roles: ['reply', 'solo'],
    weight: 8,
    when: 'a test-like command succeeded after a test-like failure, both in the last 20 min (needs lastTestPassAt)',
    after: ['open_partner_finished', 'open_generic', 'open_partner_failure', 'open_partner_long'],
    test: (c) => testsPassedAfterFailure(c.self, c.now),
  },
  { family: 'self_test_failure', roles: ['reply', 'solo'], weight: 7, when: 'a test-like command failed in the last 20 min (and no later pass)', after: ANSWERS_HOW, test: (c) => openFailure(c.self, c.now) === 'test' },
  { family: 'self_build_failure', roles: ['reply', 'solo'], weight: 7, when: 'a build-like command failed in the last 20 min', after: ANSWERS_HOW, test: (c) => openFailure(c.self, c.now) === 'build' },
  { family: 'self_tool_failure', roles: ['reply', 'solo'], weight: 6, when: 'another tool call failed in the last 20 min', after: ANSWERS_HOW, test: (c) => openFailure(c.self, c.now) === 'tool' },
  {
    family: 'self_long_debug',
    roles: ['reply', 'solo'],
    weight: 6,
    when: 'last working stretch was 20 min or longer and a failure was seen in the last 20 min',
    after: ANSWERS_HOW,
    test: (c) => longWork(c.self) && failureOf(c.self, c.now) !== undefined,
  },
  {
    family: 'self_long_work',
    roles: ['reply', 'solo'],
    weight: 5,
    when: 'last working stretch was 20 min or longer, no recent failure',
    after: ['open_generic', 'open_partner_long', 'open_late'],
    test: (c) => longWork(c.self) && failureOf(c.self, c.now) === undefined,
  },
  {
    family: 'self_just_finished',
    roles: ['reply', 'solo'],
    weight: 5,
    when: 'finished in the last 3 min',
    after: ['open_partner_finished', 'open_generic', 'open_morning', 'open_teammates', 'open_partner_long'],
    test: (c) => justFinished(c.self, c.now),
  },

  // generic replies (never contradict a real failure)
  { family: 'reply_agree', roles: ['reply'], weight: 3, when: 'answering a coffee suggestion', after: ['open_coffee'], test: always },
  { family: 'reply_morning', roles: ['reply'], weight: 3, when: 'answering a morning greeting', after: ['open_morning'], test: always },
  { family: 'reply_hey', roles: ['reply'], weight: 3, when: 'answering a teammate greeting', after: ['open_teammates'], test: always },
  { family: 'reply_late', roles: ['reply'], weight: 3, when: 'answering a late-hour question', after: ['open_late'], test: always },
  { family: 'reply_positive', roles: ['reply'], weight: 2, when: 'answering "how is it going", no recent failure', after: ['open_generic'], test: (c) => failureOf(c.self, c.now) === undefined },
  {
    family: 'reply_neutral',
    roles: ['reply'],
    weight: 1,
    when: 'fallback answer that asserts nothing',
    after: ['open_generic', 'open_partner_long', 'open_partner_failure', 'open_partner_finished', 'open_late', 'open_coffee'],
    test: always,
  },

  // filler and closing lines
  { family: 'small_talk', roles: ['small_talk'], weight: 1, when: 'always', speakers: 'both', test: always },
  { family: 'close_back', roles: ['close'], weight: 3, when: 'always', test: always },
  { family: 'close_late', roles: ['close'], weight: 2, when: 'local time 20:00-04:59', test: (c) => isLate(c.hour) },

  // solo activity lines (the generic ones are shared with simulated visitors)
  { family: 'act_coffee', roles: ['solo'], weight: 3, when: 'getting coffee (not late)', speakers: 'both', test: (c) => c.activity === 'coffee' && !isLate(c.hour) },
  { family: 'act_coffee_late', roles: ['solo'], weight: 3, when: 'getting coffee, local time 20:00-04:59', speakers: 'both', test: (c) => c.activity === 'coffee' && isLate(c.hour) },
  { family: 'act_water', roles: ['solo'], weight: 3, when: 'at the water cooler', speakers: 'both', test: act('water') },
  { family: 'act_snack', roles: ['solo'], weight: 3, when: 'at the snack spot', speakers: 'both', test: act('snack') },
  { family: 'act_books', roles: ['solo'], weight: 3, when: 'at a bookshelf', speakers: 'both', test: act('books') },
  { family: 'act_board', roles: ['solo'], weight: 3, when: 'at the noticeboard', speakers: 'both', test: act('board') },
  { family: 'act_whiteboard', roles: ['solo'], weight: 3, when: 'at a whiteboard', speakers: 'both', test: act('whiteboard') },
  { family: 'act_plant', roles: ['solo'], weight: 3, when: 'watering a plant', test: act('plant') },
  { family: 'act_stretch', roles: ['solo'], weight: 3, when: 'stretching', test: act('stretch') },
  { family: 'act_window_day', roles: ['solo'], weight: 3, when: 'at a window, office not in night mode', speakers: 'both', test: (c) => c.activity === 'window' && !isNight(c) },
  { family: 'act_window_night', roles: ['solo'], weight: 3, when: 'at a window, office in night mode', speakers: 'both', test: (c) => c.activity === 'window' && isNight(c) },
  { family: 'act_couch', roles: ['solo'], weight: 3, when: 'on the couch', speakers: 'both', test: act('couch') },
  // A stroll to another department's doorway is a short walk too.
  { family: 'act_walk', roles: ['solo'], weight: 3, when: 'short walk', test: (c) => c.activity === 'walk' || c.activity === 'stroll' },

  // simulated visitors only (no real context exists for them)
  { family: 'visit_open', roles: ['open'], weight: 1, when: 'a visitor starts a chat with another visitor', speakers: 'visitors', test: always },
  { family: 'visit_reply', roles: ['reply'], weight: 1, when: "a visitor answers another visitor's opener", speakers: 'visitors', after: ['visit_open'], test: always },
  { family: 'visit_close', roles: ['close'], weight: 1, when: 'a visitor ends a chat', speakers: 'visitors', test: always },
  { family: 'visit_reception', roles: ['solo'], weight: 3, when: 'a visitor checks in at reception', speakers: 'visitors', test: act('reception') },
  { family: 'visit_room', roles: ['solo'], weight: 3, when: 'a visitor looks around a room', speakers: 'visitors', test: act('visit') },
];

/** The rule may be said by this speaker (agents by default; visitors only where marked). */
function speakerFits(r: DialogueRule, c: DialogueInput): boolean {
  const who = r.speakers ?? 'agents';
  return who === 'both' || (who === 'visitors') === Boolean(c.visitor);
}

/** Rules that apply to an input, in table order (pure; useful for audits and tests). */
export function candidateRules(c: DialogueInput): DialogueRule[] {
  return DIALOGUE_RULES.filter(
    (r) =>
      speakerFits(r, c) && r.roles.includes(c.role) && (c.role !== 'reply' || !r.after || (c.after !== undefined && r.after.includes(c.after))) && r.test(c),
  );
}

export function candidateFamilies(c: DialogueInput): DialogueFamily[] {
  return candidateRules(c).map((r) => r.family);
}

/**
 * Pick one simulated line. Weighted by rule, then uniform within the family, skipping lines in
 * `avoid` when possible. Returns undefined when no rule applies (e.g. a restroom visit).
 */
export function pickLine(c: DialogueInput): DialogueLine | undefined {
  const rules = candidateRules(c);
  if (!rules.length) return undefined;
  const total = rules.reduce((s, r) => s + r.weight, 0);
  let r = c.rng() * total;
  let rule = rules[rules.length - 1]!;
  for (const x of rules) {
    if ((r -= x.weight) < 0) {
      rule = x;
      break;
    }
  }
  const all = DIALOGUE_TABLE[rule.family];
  const fresh = all.filter((t) => !c.avoid?.includes(t));
  const pool = fresh.length ? fresh : all;
  const text = pool[Math.min(pool.length - 1, Math.floor(c.rng() * pool.length))]!;
  return { text, family: rule.family, simulated: true };
}

/** Every line that can ever be produced. */
export function allDialogueLines(): string[] {
  return [...new Set(Object.values(DIALOGUE_TABLE).flat())];
}

/** True if `text` is a verbatim template line. */
export function isTemplateLine(text: string): boolean {
  return Object.values(DIALOGUE_TABLE).some((lines) => lines.includes(text));
}
