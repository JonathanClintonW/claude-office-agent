# Collaboration and meetings

Agent Office shows two different kinds of "working together". They are kept apart in the code and in the UI:

| | Real collaboration | Office simulation |
| --- | --- | --- |
| Code | `packages/ui/src/office/collab.ts`, `teamwork.ts`, the Team tab | `packages/ui/src/office/meetings.ts`, `idleLife.ts`, the office scene |
| Data | Fields the reducer set from observed hook, registry and transcript events | None: a local animation of agents that are really idle |
| UI label | **Real agent event** (or **Demo data** for `sim-` demo sessions) | **Office simulation** |
| Implementation | Pure functions over `OfficeState`, plus short animations of verified events | Deterministic state machines with an injected random number generator and clock |

Neither side calls a model, an API, the Claude CLI or MCP, or contacts any network host. Neither one produces or displays text written by an agent; prompts, tool input and tool output are never read.

## Real collaboration (`collab.ts`)

### Signals

`collabSignals(state)` returns every collaboration fact that can be derived from one state snapshot, oldest first. Each `CollabSignal` has an `id`, a `kind`, `from` and `to` agent keys, the time of the evidence, a generic label, the session, `source: 'real'`, a `confidence` of `verified` or `inferred`, an optional `note`, and `simulated` for demo sessions. Task signals add the task key and, when the task has one, its subject.

| `kind` | Evidence in state | `from` → `to` | Confidence |
| --- | --- | --- | --- |
| `delegation` | `parentVia: 'spawn-tool'` and the parent is the session: a `SubagentStart` matched to the spawning `Agent`/`Task` call | lead → subagent | verified |
| `nested_delegation` | `parentVia: 'spawn-tool'` and the parent is a subagent | subagent → subagent | verified |
| `subagent_started` | `parentVia: 'session'`: `SubagentStart` seen in the session, spawning call not observed | session → subagent | verified |
| `subagent_started` | `parentVia: 'implicit'`: the agent was seen only through its own events, with no `SubagentStart` | session → subagent | **inferred** |
| `subagent_started` / `teammate` | `parentVia: 'transcript'`: found in transcript metadata | session → agent | **inferred** (partial) |
| `teammate` | `kind: 'teammate'`, set by the reducer only from `TeammateIdle` and from task events that carry `teammate_name` | lead → teammate | verified |
| `task_handoff` | A completed task whose creator and completer differ, both in state | creator → completer | verified |
| `delegated_complete` | A subagent `completed` (`SubagentStop`). A session ending its children gives `ended`, which does not count | child → parent | verified from a hook; inferred when the link itself is inferred |
| `parallel_work` | Two or more non-stale agents of one session `working` at the same time | first → second worker, plus every participant | verified |

If a reported parent is no longer in state (it was pruned), the link is inferred and the note says so. If neither the parent nor the session is in state, no signal is produced, and missing data never produces a signal.

**Labels** are fixed, generic strings such as "Subagent delegated", "Task handoff detected", "Subagent started" or "Delegated work completed". The only free text is a task subject, included only when the task in state has one and passed through `safeText` again (secrets redacted, whitespace collapsed, truncated). Inferred signals always carry a note that explains why.

### Diffs and de-duplication

- `diffSignals(prev, next)` returns the signals whose `id` is in `next` but not in `prev`, plus a `parallel_work` signal when a session goes from fewer than two working agents to two or more. Running it over consecutive states never repeats an id for one continuous fact.
- Ids are stable by design: a completion is keyed on the agent and its confidence (a duplicate `SubagentStop` is not a second completion), a handoff on the task instance (a task id created again after it completed counts as a new task), and an implicit link that a later `SubagentStart` upgrades gets a new, verified id.
- `CollabFeed` is a stateful helper for live streams. Its first `push` only primes it; after that it never emits an id twice, even when evidence disappears and comes back (pruning, resync). Its memory is bounded.

### Teams

`teams(state)` returns one `Team` per session, live sessions first, then by most recent activity: the lead, its members depth-first (children follow their parent; nested subagents have `depth > 1`), the relations with their evidence, the session's tasks (with a `handoff` flag), the agents working right now, unique display names, team names, and `partial`, `active` and `simulated` flags.

- A relation's `label` is the edge label: `delegated`, `nested`, `started`, `teammate` or `inferred`.
- A relation's `basis` names the evidence: `spawn-tool`, `session`, `team-event`, `transcript`, `implicit` or `missing-parent`.
- `partial` is true when any relation is inferred or the session agent itself is missing; `isCollaborative(team)` is true when the team has members or a task handoff.
- `relationOf(state, agent)` gives the same classification for a single agent (used by the inspector), and `parallelWork(state)` lists the sessions with agents working in parallel.

### Team tab

`views/TeamView.tsx` and `components/TeamGraph.tsx` show:

- **Team cards**, one per collaborative session:
  - a graph with the lead at the top and subagents and teammates indented under whoever spawned them, solid edges for verified links and dashed edges for inferred ones, task handoffs as amber arrows, node colours by status, and a `∥` marker on agents working in parallel. Clicking a node, or pressing Enter or Space on it, selects that agent;
  - a **members table** with one row per member: the link to its parent ("delegated by …", "nested, delegated by …", "teammate of …", or "assumed to belong to …" with an *inferred* tag), the evidence note, the real status and a parallel-work flag. Display names are unique within a team (`Team.names`);
  - the session's tasks, with handoffs marked.
- **Solo sessions**, listed compactly as "Working solo".
- **Real agent events**, a feed of live parallel work, delegations, handoffs and completions, newest first, each with its source label and confidence.
- **Office simulation**, a separate section that explains the simulated office activity (meetings, standing gatherings, idle chats and breaks) and lists the meetings and gatherings currently running. It states plainly that this is not Claude Code activity.
- **Ended sessions**, hidden until you tick "Include ended sessions".

### Animations of verified events

`collabVisuals(prev, next, { now, maxAgeMs })` turns verified signals that are new between two consecutive states into short scene effects:

| `kind` | From → to | What the office shows |
| --- | --- | --- |
| `delegate` | parent desk → child desk | a sheet of paper flies over |
| `handoff` | creator desk → completer desk | a task card flies over, with the task subject (at most 40 characters) when there is one |
| `complete` | child desk → parent desk | the paper flies back with a small green check |

Effects are produced only when the signal is verified (never inferred), a previous state exists (the first snapshot produces nothing), both agents are in the new state, and the evidence is recent (15 s by default), so a resync never replays history. Each effect has a stable id, and the scene skips effects whose agents are not on screen. Effects are skipped with reduced motion.

### Verified-event interactions (`teamwork.ts`)

`TeamworkProvider` is the highest-priority behavior provider. It adds a short interaction to the same verified events, and only to those; nothing here is simulated or inferred:

- **Briefing** (a verified `delegate` event): on its way in, the new subagent stops on a free tile next to its parent's desk, faces the parent and takes a talking pose for about 2.5 s, then walks on to its own desk. The parent never leaves its desk. It is skipped when the detour would be longer than 12 tiles, when either agent is not in the office, or when no tile next to the desk is free; subagents spawned in parallel get distinct tiles. A permission prompt, a question, a failure or an unknown status ends it at once and sends the subagent to its desk in a hurry.
- **Handoff** (a verified `handoff` event): only when the task's creator and completer are both idle and the creator is at its desk, the completer walks over, talks for about 3 s with an icon bubble (never speech) and walks back. It ends as soon as either agent stops being idle. Otherwise only the task-card flight shows the handoff.

Every interaction is released at the latest 15 s after its event was received, events are de-duplicated by id, and at most 16 run or wait at once.

## Office simulation: meetings and gatherings (`meetings.ts`)

`MeetingScheduler` is a behavior provider (`name: 'meetings'`). From time to time it gathers idle agents:

- **Seated meetings** (`kind` `meeting`, `collaboration` or `break`): two to five agents walk to a meeting, collaboration (huddle) or break room, take unique seats and sit together. Meeting and collaboration rooms with a screen or whiteboard sometimes get a presenter; break rooms never do. Bubbles are icons only.
- **Standing gatherings** (`kind: 'social'`, `topic` `coffee`, `chat` or `discussion`): three or four agents stand in a small circle in a break or collaboration room, or at a coffee machine, water cooler, snack machine or couch outside the department rooms, for a coffee chat, a group chat or a pretend team discussion. Once everyone has arrived, bubbles are icons and, now and then, a verbatim line from the local template table ([SIMULATION.md](SIMULATION.md)), drawn as simulated speech in the dashed lavender bubble. Nothing is generated.

How a meeting runs:

1. **Selection.** Only actors that are really idle, not away on another activity, not walking, at their desk and past their cooldown are picked. At most `maxShare` (60 %) of the idle actors are in meetings at once, a room or venue hosts one activity at a time, and at most `maxConcurrent` (2) run at once.
2. **Seats.** Seated meetings use the room's seats (deduplicated by tile, presenter tile excluded), each attendee taking the nearest free one; never more participants than seats. Standing gatherings use free tiles around a centre near the venue. Seats and tiles are reserved across rooms and concurrent meetings, and never a tile another actor stands on or calls home.
3. **Arrival.** Participants walk to their seat or tile. Those that have not arrived within 30 s are released. A seated meeting needs two participants; a standing gathering needs three to start and continues with two.
4. **Meeting.** Participants sit (or stand, the presenter presents) for a few minutes: 2–4 min in a meeting room, 1.5–3 min for a huddle in a collaboration room, 1–2 min for a group break (16–30 s for standing gatherings). One speaker per turn; bubbles come from a hash of the meeting seed and the turn, so they do not depend on the frame rate.
5. **Departure** (phase `ending`). Participants leave one after another, 900 ms apart; standing ones wave goodbye first. Each walks back to its desk and waits for a cooldown before joining another meeting.

**Interruptions.** Real status always wins. The moment an actor is not idle (real work, a permission prompt, a question, or a claim by a higher-priority provider) it gets a `home` directive. It hurries only when its real status is no longer idle; when another provider claimed it, it walks back calmly. The meeting continues while enough participants remain; otherwise it ends for everyone, and the rest walk back calmly.

**Cleanup.** `forget(key)` removes an actor. `setWorld(world)` ends meetings whose room or venue disappeared or changed; meetings in unchanged rooms keep going, because the world is also rebuilt when only the time of day changes. `setEnabled(false)` (the **Idle life** toggle, or the layout editor) ends every meeting.

**Frequency.** `setFrequency(m)` divides the waiting times between meetings by `m` (the **Idle frequency** setting: low 0.5, normal 1, high 2); with `m` at 0, no new meetings start. With the defaults, the first meeting is planned 20–45 s after start and later ones every 45–120 s, at frequency 1.

**Determinism.** `new MeetingScheduler(rng, options)` takes the random number generator and options, and `now` is passed into `tick`, so the same seed and inputs give identical directives. `currentMeetings()` returns read-only `MeetingInfo` records (`id`, room or venue, `kind`, participants, presenter, `phase` of `gathering`, `meeting` or `ending`, times, `simulated: true`); the Team tab lists them under **Office simulation**.

## How the scene combines behavior providers

`OfficeScene` runs its behavior providers about every 200 ms, in priority order: verified-event interactions (`TeamworkProvider`), then meetings (`MeetingScheduler`), then idle life (`IdleDirector`). Each provider sees the real-status gate (an actor is idle only when its status is `idle`, it is not stale and it is not celebrating a just-finished turn) and returns a directive per actor: walk somewhere, perform an activity, or go home. An actor claimed by a higher-priority provider is offered to the lower ones with `idle: false`, so they drop their own plans for it. `setWorld`, `setEnabled`, `setFrequency` and `forget` reach every provider, and `scene.addBehaviorProvider(provider, first)` registers another one.

## Tests

```bash
npx vitest run --project ui collab.test teamwork meetings.test team.test
```

- `collab.test.ts`: delegation, nested delegation, teammates and task handoffs (with and without a subject, and with sanitisation); inferred links and their upgrade to verified; no signals from missing data and no duplicates across diffs or with `CollabFeed`; parallel-work transitions, `collabVisuals` and `teams`.
- `teamwork.test.ts`: briefings next to the parent's desk (distinct tiles for parallel spawns, skipped detours and missing agents, an immediate end on a permission prompt, question, failure or unknown status, the hard cap); handoffs only between idle agents with an icon and no text, early ends and give-ups; lifecycle and de-duplication.
- `meetings.test.ts`: capacity and unique seats; the eligibility filter and room kinds; arrival, meeting and staggered departure; presenters and break rooms; standing gatherings and their template lines; interruptions and the arrival timeout; cleanup, frequency and determinism.
- `team.test.tsx`: graph nodes, nesting and edge labels; the members table with its links, evidence and inferred tags; the "Real agent event" and "Office simulation" labels; privacy; node clicks and keyboard selection; empty states, ended sessions, demo sessions and the live meetings list.
