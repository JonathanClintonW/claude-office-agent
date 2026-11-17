# Simulation: idle life, dialogue and poses

Agent Office shows real Claude Code agents. On top of that, idle agents get a small
**simulated** office life: breaks, short walks, chats with template small talk. This page
describes all of it, so you can see exactly what is real and what is decoration.

Code: `packages/ui/src/office/idleLife.ts` (director), `dialogue.ts` (template library),
`poses.ts` (pose and desk-screen rules), `pixelArt.ts` (sprites). Tests:
`packages/ui/test/idleLife.test.ts`, `dialogue.test.ts`, `poses.test.ts`.

## Guarantees

- **Local only.** Nothing here calls a model, the Anthropic/Claude API or SDK, the Claude CLI
  or MCP. Nothing builds a prompt or opens a network connection. Every activity is chosen by
  fixed rules plus a random number generator. Every line of speech is copied verbatim from the
  table below.
- **Deterministic.** The director and the line picker take an injected RNG. The same seed,
  actors and clock always produce the same directives and lines. Tests check this.
- **Labeled.** `Directive.speech` holds simulated text only (`SPEECH_SOURCE = 'local-template'`).
  The scene draws it in a distinct "simulated" bubble: pale lavender with a dashed border
  (`SIM_SPEECH_STYLE`, `drawSpeechBubble()`), unlike the white status bubbles. The bubble comes
  with a legend. Simulated speech never looks like a Claude message and is never stored as one.
- **Real status always wins.**
  - Only actors whose real status allows it take part (`Actor.idle`: status `idle`, not stale,
    not just celebrating a finished turn, not claimed by another provider).
  - When an actor's real status changes, its activity is aborted the same tick. The actor
    hurries back to its desk, and a chat partner walks back calmly.
  - The desk monitor and the inspector show the real status the whole time.
- **Privacy.** Dialogue rules use only the generic facts listed below. They never use prompts,
  tool output, file names, file contents, commands or numbers. No template contains a digit, a
  path or a quote, and tests enforce this.
- **Honest content.**
  - A line about a failure needs an observed failure.
  - "Finally, the tests passed." needs an observed test-like command that succeeded *after* an
    observed test-like failure (`lastTestPassAt`). Finishing a turn is not a test result.
  - Generic positive replies ("Can't complain.") are never used while a real failure is
    recent.

## Priorities

1. **Real status.** It is never overridden. Agents that are working, waiting for permission or
   input, failed or unknown stay at, or return to, their desk.
2. **Higher-priority behavior providers** (short interactions for verified team events, and
   simulated meetings; see [COLLABORATION.md](COLLABORATION.md)). The scene asks
   providers in priority order. An actor claimed by a higher provider is passed to idle life
   with `idle: false`. Idle life then aborts its own activity without hurrying, because the
   real status did not change.
3. **Idle life (`IdleDirector`).** Within idle life:
   - At most `maxAwayShare` (default ½) of the idle actors are on an activity at once. A chat
     may take one extra person.
   - One actor per tile and per spot: restroom stall, coffee machine, window, shelf, lounge
     chair, doorway and so on.
   - At most `maxPerKind` (default 2) actors per activity kind at once. For chats this counts
     conversations, not people. The office never does the same thing all at once.
   - Idle life sends nobody into a room that already holds `maxPerRoom` (default 4) people who
     are away from their desks.
   - No actor repeats its previous activity, and chat partners must not have just chatted.
   - Actors that another provider has away (`Actor.away`) are never scheduled and never picked
     as a chat partner.
   - If a target or a chat partner is not reached within 45 s, the actor walks back calmly.
   - `setEnabled(false)` (the **Idle life** toggle, or the layout editor) sends everyone home.

## Activities

Spot activities need a `World` spot of the same kind (`buildWorld`). When a layout has no
such spot, the activity is skipped.

| Activity | Needs | Duration | What you see |
| --- | --- | --- | --- |
| `chat` | another idle agent at its desk and a free pair of chat tiles | 9–16 s | The two face each other and take turns: an opener, a reply, icons or small talk, and a closing line |
| `coffee` | `coffee` spot | 4–5 s | Stands at the machine with a coffee icon, then sips at the desk for 30 s |
| `water` | `water` spot | 4–6 s | Stands at the cooler, then turns round and drinks |
| `snack` | `snack` spot | 5–8 s | Grabs something, then turns round and eats (`eat` pose, with chewing pauses) |
| `books` | `books` spot | 8–14 s | Picks a book facing the shelf, then turns round and reads (`read` pose) |
| `board` | `board` spot | 4–7 s | Looks at the noticeboard, with an idea icon halfway |
| `whiteboard` | `whiteboard` spot | 5–8 s | Stands facing the whiteboard, with an idea icon halfway |
| `plant` | `plant` spot | 4–6 s | Waters the plant (watering-can sprite for activity `plant`) |
| `couch` | `couch` spot | 15–35 s | Sits on the couch, with an occasional music icon |
| `window` | `window` spot | 6–10 s | Looks out, with a sun or moon icon depending on the office lighting |
| `toilet` | `toilet` spot | 8–14 s | Hidden in the stall, whose door sign turns red. No speech, ever |
| `stretch` | nothing | 2.5–4 s | Stands up at the desk and stretches (`stretch` pose) |
| `walk` | a free chat tile 3–12 tiles away | 1.5–3 s | Walks there, looks around, walks back |
| `stroll` | the doorway of another department's room, at least 4 tiles away (never a restroom or the corridor) | 3–5 s | Walks to the doorway and looks into the room |
| `lounge` | a free lounge chair (a chair that is not at a table) | 12–25 s | Sits in the chair, now and then with a music icon |

Weights (relative chance among the activities that are possible right now): chat 5, coffee 2,
water 2, couch 2, snack 1.5, books 1.5, toilet 1.5, walk 1.5, stroll 1.5, lounge 1.5, window 1,
board 1, whiteboard 1, plant 1, stretch 1.

**Frequency.** `setFrequency(m)` uses the **Idle frequency** setting: low 0.5, normal 1,
high 2. It divides the first delay (12–40 s after becoming idle) and the pause between trips
(40–120 s) by `m`, and rescales waits that are already scheduled. Activity durations do not
change.

**Speech during activities.**
- Chats always get a script of template lines. The speakers alternate, and the last 300 ms of
  each 2.2 s turn is silent.
- Solo activities show one template line at the start, with a 35% chance by default
  (`soloSpeechChance`), for 2.6 s.
- Icon bubbles (coffee, music, sun or moon, idea, heart, laugh, dots) remain for variety and
  never appear together with a line.
- Standing gatherings of three or four idle agents (run by the meeting scheduler, see
  [COLLABORATION.md](COLLABORATION.md)) use the same table once everyone has arrived: an opener,
  a reply, then icons, pauses or small talk (25% of the middle turns by default) and a closing
  line, one speaker per 2.6 s turn. Seated meetings show icons only.

## Dialogue

### Facts a rule may use

All of these are observed locally by the monitor and reducer. None of them come from a model.

| Fact | Source | Used as |
| --- | --- | --- |
| `kind` | agent kind (session, subagent, teammate) | teammate greetings |
| `status` | reducer status | only actors that are really idle speak at all |
| `lastWorkMs` | length of the last observed working stretch | "long stretch" lines (20 min or more) |
| `recentFailure` | kind (`test`, `build`, `tool`) and time of the latest failed tool call, classified by local rules (`failureKind()` in `poses.ts`) | failure lines (failures in the last 20 min) |
| `lastTestPassAt` (optional) | time of the latest observed successful test-like command | "tests passed" lines, only after a test failure |
| `finishedAt` | when the agent last completed a turn or finished | "just finished" lines (finished in the last 3 min) |
| local hour and night mode | the local clock and the office lighting | greetings, window lines |

Rules only ever check these facts generically ("a test-like command failed recently"). A line
never names a file, command, tool, number, error or result.

### How a line is chosen

`pickLine(input)` is a pure function:
1. `candidateRules(input)` keeps the rules that apply. The rule must fit the role (`open`,
   `reply`, `small_talk`, `close`, `solo`). For replies, it must answer the opener's family.
   Its condition must hold.
2. One rule is drawn by weight with the injected RNG.
3. A line is drawn from that family, skipping the speaker's last 6 lines when the family has
   others.

A chat script has these turns:
1. The leader opens, based on the partner's context or the clock.
2. The partner replies, based on its own context.
3. Middle turns are icons or small talk (30% by default).
4. The last turn is a closing line.

### Full table

This is the complete vocabulary (`DIALOGUE_TABLE` and `DIALOGUE_RULES` in `dialogue.ts`). A
test checks that every line and condition below matches the code.

| Family | Roles | Weight | Condition (real facts only) | Lines |
| --- | --- | --- | --- | --- |
| `open_partner_failure` | open | 6 | partner had a failed tool call in the last 20 min (and no later test pass) | Another bug? / Rough patch? / Something acting up? |
| `open_partner_long` | open | 5 | partner's last working stretch was 20 min or longer | You've been at it a while. / Long session? / Time for a breather? |
| `open_partner_finished` | open | 5 | partner finished in the last 3 min | All done? / Wrapped up? / Finished for now? |
| `open_morning` | open | 2 | local time 05:00-10:59 | Morning! / Good morning! / Early start? |
| `open_late` | open | 2 | local time 20:00-04:59 | Working late? / Long night? / Still here? |
| `open_teammates` | open | 2 | both are agent-team teammates | Hey, teammate! / How's the team? |
| `open_generic` | open | 3 | always | How's your project going? / How's it going? / Busy day? / Taking a break too? |
| `open_coffee` | open | 1 | always | Coffee break? / Need a coffee? |
| `self_tests_passed` | reply, solo | 8 | a test-like command succeeded after a test-like failure, both in the last 20 min (needs lastTestPassAt); answers `open_partner_finished`, `open_generic`, `open_partner_failure`, `open_partner_long` | Finally, the tests passed. / The tests are happy again. |
| `self_test_failure` | reply, solo | 7 | a test-like command failed in the last 20 min (and no later pass); answers `open_generic`, `open_partner_long`, `open_partner_failure`, `open_late` | Those tests are giving me trouble. / The tests disagree with me. |
| `self_build_failure` | reply, solo | 7 | a build-like command failed in the last 20 min; answers `open_generic`, `open_partner_long`, `open_partner_failure`, `open_late` | The build is being stubborn. / Fighting the build. |
| `self_tool_failure` | reply, solo | 6 | another tool call failed in the last 20 min; answers `open_generic`, `open_partner_long`, `open_partner_failure`, `open_late` | Hit a snag earlier. / Something didn't cooperate. |
| `self_long_debug` | reply, solo | 6 | last working stretch was 20 min or longer and a failure was seen in the last 20 min; answers `open_generic`, `open_partner_long`, `open_partner_failure`, `open_late` | That was a long debugging session. / Long debugging session. |
| `self_long_work` | reply, solo | 5 | last working stretch was 20 min or longer, no recent failure; answers `open_generic`, `open_partner_long`, `open_late` | That was a long stretch. / Long one. Need a breather. |
| `self_just_finished` | reply, solo | 5 | finished in the last 3 min; answers `open_partner_finished`, `open_generic`, `open_morning`, `open_teammates`, `open_partner_long` | Done for now! / Just wrapped up. / Finished for now. |
| `reply_agree` | reply | 3 | answering a coffee suggestion; answers `open_coffee` | Sounds good. / Good idea. / Maybe later. |
| `reply_morning` | reply | 3 | answering a morning greeting; answers `open_morning` | Morning! / Hi there! |
| `reply_hey` | reply | 3 | answering a teammate greeting; answers `open_teammates` | Hey! / Hey there! |
| `reply_late` | reply | 3 | answering a late-hour question; answers `open_late` | Night owl, I guess. / Just a bit longer. |
| `reply_positive` | reply | 2 | answering "how is it going", no recent failure; answers `open_generic` | Can't complain. / Not bad, thanks. |
| `reply_neutral` | reply | 1 | fallback answer that asserts nothing; answers `open_generic`, `open_partner_long`, `open_partner_failure`, `open_partner_finished`, `open_late`, `open_coffee` | One step at a time. / Just taking a breather. / Taking it easy for now. |
| `small_talk` | small_talk | 1 | always | Ha, true. / Right? / Good point. / Makes sense. / This office is cozy. |
| `close_back` | close | 3 | always | Back to work! / Well, back to it. / Catch you later! / Good chat. |
| `close_late` | close | 2 | local time 20:00-04:59 | Don't stay too late! / Get some rest soon. |
| `act_coffee` | solo | 3 | getting coffee (not late) | I need some coffee. / Coffee time. / Fresh coffee, please. |
| `act_coffee_late` | solo | 3 | getting coffee, local time 20:00-04:59 | Late-night coffee. / One more coffee. |
| `act_water` | solo | 3 | at the water cooler | Staying hydrated. / Just some water. |
| `act_snack` | solo | 3 | at the snack spot | Snack time. / Just a quick bite. |
| `act_books` | solo | 3 | at a bookshelf | Some light reading. / Nice book collection. / Where was I? |
| `act_board` | solo | 3 | at the noticeboard | Anything new on the board? / Let's see what's posted. |
| `act_whiteboard` | solo | 3 | at a whiteboard | Interesting diagram. / Who drew this? / Hmm, let me think. |
| `act_plant` | solo | 3 | watering a plant | These plants look thirsty. / There you go, little plant. |
| `act_stretch` | solo | 3 | stretching | Time to stretch. / Ahh, much better. |
| `act_window_day` | solo | 3 | at a window, office not in night mode | Nice view. / A bit of daylight. |
| `act_window_night` | solo | 3 | at a window, office in night mode | Quiet night. / Look at the stars. |
| `act_couch` | solo | 3 | on the couch | Just resting my eyes. / A short break. |
| `act_walk` | solo | 3 | short walk | Stretching my legs. / Quick walk. |

### Rules for adding lines

These are enforced by `dialogue.test.ts`:
- Lines are at most 40 characters and end with `.`, `!` or `?`.
- No digits, paths, file-like names, code, quotes or brackets, and no mention of a model or
  prompt.
- Words about results or failures ("pass", "bug", "trouble", "debugging", …) appear only in
  families whose condition requires that evidence.
- Every opener must have at least one reply that always applies.
- Every line must also be listed in this file.

## Poses

`spritePose(pose, face, { activity, frame })` in `poses.ts` maps each semantic `ActorPose` to
a sprite pose that `drawCharacter()` draws. Simulated activities never reuse the poses that
signal real status: the raised hand (permission), the cheer (done) and the slump (failed).

| `ActorPose` | up | down | left / right |
| --- | --- | --- | --- |
| `stand` | `walk_up_0` | `stand` | `walk_side_0` (mirrored for left) |
| `stand` + activity `plant` | `water` | `water` | `water` |
| `couch` | `couch` | `couch` | `couch` |
| `drink` | `drink` | `drink` | `drink` |
| `talk` | `walk_up_0` | `talk_front` | `side_talk` |
| `read` | `read` | `read` | `read` |
| `eat` | `eat` | `eat` | `eat` |
| `stretch` | `stretch` | `stretch` | `stretch` |
| `sit_meeting` | `sit` | `sit_meeting` | `sit_meeting_side` |
| `present` | `present_up` | `present_front` | `present` |
| `wave` | `wave` / `wave1` (by frame) | same | same |

## Desk presentation for real states

`workPresentation({ status, detail, toolName, toolSummary, recentFailure, justFinished, stale })`
chooses the seated pose and the monitor screen for an agent's **real** state. It uses fixed
rules and the first match wins:

| Real state | Mode | Seated pose | Screen |
| --- | --- | --- | --- |
| `waiting_permission` | permission | `sit_raise` | `perm` |
| `waiting_input` | input | `sit` | `ask` |
| `failed` | failed | `sit_slump` | `fail` |
| `completed`, or idle within the celebration window | finishing | `sit_cheer` | `done` |
| `idle` | idle | `sit` | `saver` |
| `unknown` | unknown | `sit` | `noise` |
| `ended` | ended | `sit` | `off` |
| working, running Read / NotebookRead / WebFetch | reading | `sit_read` | `read` |
| working, running Grep / Glob / WebSearch / LS / ToolSearch | searching | `sit_read` | `search` |
| working, running Edit / Write / MultiEdit / NotebookEdit | editing | `type0` | `edit` |
| working, running Bash / PowerShell whose summary looks like a test runner | testing | `sit_lean` | `test` |
| working, running another Bash / PowerShell command after a recent failure | debugging | `sit_debug` | `debug` |
| working, running another Bash / PowerShell command | command | `type0` | `terminal` |
| working, running Agent / Task / BashOutput / TaskOutput / Monitor | waiting | `sit_lean` | `wait` |
| working, running any other tool (MCP, Skill, …) | tool | `sit` | `code` |
| working, no tool, recent failure or detail `Recovering from …` | debugging | `sit_debug` | `debug` |
| working, no tool, statusDetail exactly `Thinking`, not stale | thinking | `sit_think` | `think` |
| working, anything else (`Prompt received`, `Busy (session registry)`, …) | busy | `sit` | `busy` |

Animate seated poses with `seatedFrame(pose, t)`: typing every 170 ms, scrolling with the mouse,
the permission hand every 550 ms, the cheer every 300 ms. `SCREEN_ANIMATION` in `pixelArt.ts`
gives each screen's frame count and speed.

**The thinking rule.** The reducer sets statusDetail to exactly `Thinking` while a turn is in
progress after a tool call has finished, that is, while the model is working on its next step.
Only that value shows the thinking screen. A working agent with no running tool and any other
detail gets the neutral `busy` screen. An agent with no recent events (stale) is never shown as
thinking, and neither is mere inactivity.

**Test runs.** The `test` screen shows neutral progress dots only, with no green or red. The
outcome is unknown while a test runs, so the screen does not suggest one.

**Test-like and build-like commands.** `looksLikeTest()` and `looksLikeBuild()` are local
regular expressions over the sanitized command summary:
- Test-like: runner names (vitest, jest, pytest, mocha, phpunit, rspec, playwright test, …),
  `<tool> test` forms (npm, pnpm, yarn, go, cargo, dotnet, mvn, gradle, make, …) and phrases
  such as "run the unit tests".
- Build-like: build, compile, tsc and typecheck commands.

`failureKind(toolName, summary)` turns a failed tool call into `recentFailure.kind`: `test`,
`build` or `tool`.

## Verifying

```bash
npx vitest run --project ui idleLife dialogue poses meetings
```
