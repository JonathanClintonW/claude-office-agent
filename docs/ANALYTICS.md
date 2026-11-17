# Analytics, history and replay

Agent Office can show token usage, session history, performance metrics and a replay of the pixel office. All of it is computed locally from data that already exists on your machine.

- **No extra inference.** Nothing here calls Claude, the Anthropic API, an SDK, MCP or the Claude CLI, and nothing contacts a network host. Summaries are fixed sentence templates filled with counts.
- **Honest numbers.** Every figure names its source. Usage is never estimated as if it were observed, and nothing is counted twice. Office activity (events, animations) is never counted as Claude usage.
- **Privacy.** Prompts, message content, file contents, full tool output and secrets are never stored or displayed.

## Data sources

| Label in the UI | What it is | Where it comes from |
| --- | --- | --- |
| **Transcript-observed** | Token counts per API response, summed | `message.usage` of `assistant` records in Claude Code transcripts |
| **Reported by Claude Code** | Claude Code's own cost accounting | The latest `cost-state` record in a session transcript |
| **Estimate from your price table** | API-equivalent cost estimate | Observed tokens × the prices in *your* `pricing.json` |
| **Office events (observed)** | Counts of tool calls, tasks, turns, statuses | Hook, registry and transcript events received by the monitor |

Metrics are also tagged **observed** (a count of received events) or **derived** (computed from observed timestamps: durations, rates, shares).

## Usage (`usage` plugin)

### What is read

The plugin tracks every session in the monitor state (simulated `sim-` sessions excluded) plus sessions explicitly requested from the History view. For each one it reads:

- the main transcript `<claudeDir>/projects/<project>/<sessionId>.jsonl`. It takes the path the hooks reported if the file name matches the session id, or otherwise finds the file in the projects folders;
- every subagent transcript `<claudeDir>/projects/<project>/<sessionId>/subagents/agent-<id>.jsonl`. The agent type comes from the matching `.meta.json`.

Only these fields are kept, per API message: `message.id`, `message.model` and the four usage counters (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`). The plugin also keeps the record timestamp, the `cwd` (for the project) and the numeric fields of `cost-state`. Message content is never retained. Most lines, such as tool results and user turns, are discarded by a substring pre-filter without being parsed.

### Counting rules

- **Deduplication.** Usage is counted once per `message.id`. Streaming repeats the same id; for repeats the per-field maximum is kept, and only the difference is added.
- **Across files and sessions.** The deduplication is global. A message id that appears in several files, such as a sidechain copy in the main transcript or a resumed conversation, is counted once. It belongs to the first file that was read. Subagent files are read before the main file, so copies are attributed to their subagent. Skipped duplicates are reported as `crossSessionDuplicates`.
- **Attribution.**
  - Main transcript records are `main`.
  - Records in `subagents/agent-<id>.jsonl` belong to `<id>`.
  - Sidechain records in the main file belong to their `agentId`, or to `sidechain` if they have none.
- **Records that are not counted** (and are reported in `scan.skipped`):
  - assistant records without a `message.id` (they cannot be deduplicated);
  - placeholder models such as `<synthetic>` (not API calls);
  - unparsable lines;
  - lines larger than 16 MiB (skipped, not buffered).
- **Project.** A session's project is its `cwd`, from hooks or the registry, or else the transcript. It is grouped with `normalizePathKey` and labelled with the folder name.

### Incremental, bounded and time-boxed reads

- Each file is read from a byte offset, so only appended bytes are parsed. A file whose size and mtime are unchanged is never opened again.
- **Partial lines.** A partial last line, still being written, is carried over to the next read. Lines are split on newline bytes, so a multi-byte character is never cut. A final line without a newline is parsed tentatively. This is safe because counting is idempotent.
- **Truncation and replacement.** If a file shrinks, or its first 256 bytes change, it was truncated or replaced. The whole session is then recounted from zero, never added on top. These recounts are reported as `scan.resets`.
- **Time box.** Every `stat` and every read has a 2.5 s budget, because antivirus can block opening a growing file on Windows. A file that exceeds the budget is skipped for 60 s, and a file is never read twice at once.
- **Bounded passes.** A pass reads at most 16 MiB in total and 4 MiB per file, and yields to the event loop between files. Passes run every 15 s. While a backlog remains, they run every 250 ms until caught up. A 500 MB transcript is therefore read over a few dozen short passes, and the monitor stays responsive.

### Cost reported by Claude Code

The latest `cost-state` record of each **main** session transcript is kept as recorded: `totalCostUSD`, `totalAPIDuration` (in ms) and the numeric fields of `modelUsage` (`inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`). `cost-state` records in subagent files are ignored, because the session's own accounting already covers its subagents.

Totals across sessions are labelled "sum of the latest cost Claude Code recorded in N session transcripts". If Claude Code resets its running total, for example on a new process, the value shown is whatever it last wrote.

### RPC routes

| Method | Params | Result |
| --- | --- | --- |
| `usage.summary` | `{ refresh?: true }`: run one bounded pass first (≤ 8 s) | `UsageSummary`: totals; rows per session, agent, project and model; reported cost; estimate; pricing status; scan status |
| `usage.session` | `{ sessionId, refresh?: true }` | `UsageSessionDetail`, with per-agent rows. An unknown session is looked up and tracked on request |

Types are in `packages/core/src/contracts/analytics.ts`. `MonitorMeta.plugins.usage` publishes `{ sessionsTracked, filesTracked, lastScanAt, backlogBytes, pricing }`.

## Pricing file (`pricing.json`)

Agent Office ships **no prices** and never guesses them. Estimates appear only when you create `<home>/pricing.json`, where `<home>` is `AGENT_OFFICE_HOME`, by default `~/.agent-office`. Without the file the UI says **"No price table configured"**.

```json
{
  "version": 1,
  "currency": "USD",
  "note": "Copied from my provider's price page on 2026-11-01",
  "models": {
    "claude-example-model-1": { "inputPerMTok": 1.0, "outputPerMTok": 2.0, "cacheWritePerMTok": 1.5, "cacheReadPerMTok": 0.1 },
    "claude-example-*": { "inputPerMTok": 0.5, "outputPerMTok": 1.0 }
  }
}
```

The numbers above are illustrative only, not real prices. Fill in the prices you actually pay.

| Field | Rules |
| --- | --- |
| `version` | Must be `1` |
| `currency` | Three upper-case letters (ISO 4217), shown next to every estimate. Estimates are never mixed with the USD values reported by Claude Code |
| `note` | Optional text, up to 200 characters, shown with the estimates |
| `models` | 1 to 500 entries. Each key is an exact model id, or a prefix ending in `*`. An exact key wins; otherwise the longest matching prefix wins |
| `inputPerMTok`, `outputPerMTok` | Required. Price per million tokens, 0 to 100000 |
| `cacheWritePerMTok`, `cacheReadPerMTok` | Optional. If omitted, that model's cache tokens are excluded |

Validation is strict: an unknown field, such as a misspelled `inputPerMtok`, rejects the whole file. The UI then shows the error and no estimate. The file is re-read when its size or mtime changes, and is limited to 256 KiB.

An estimate is `Σ tokens × price / 1,000,000` per model. Tokens of models without a price entry, and cache tokens without a cache price, are left out. Such an estimate is marked **partial** and lists what was excluded. All cache-creation tokens use `cacheWritePerMTok`; the transcript's split between 5-minute and 1-hour cache writes is not priced separately.

## History (`history` plugin)

### Journal

- **Files.** Every sequenced monitor event except `Tick` is appended to `<home>/history/YYYY-MM-DD.jsonl`, one JSON event per line. The date is the UTC day the event was journaled. Lines are in the monitor's apply order, which is sequence order.
- **Writes.** `onEvent` only pushes the event onto an in-memory buffer and updates counters, in constant time. A timer appends the buffer asynchronously every second, and `stop()` flushes it. At most 50,000 events are buffered; beyond that, events are dropped and counted (`droppedEvents`).
- **Crashes.** A torn last line left by a crash is never merged with new records.
- **Privacy filter.** Events are already sanitized by the monitor, with secrets redacted and tool inputs reduced to short summaries. The journal additionally:
  - drops assistant message text (`lastMessage`), task and subagent descriptions, and transcript paths;
  - shortens error text to 200 characters, and notification text and reasons to 160.

  Prompts never reach the monitor at all.

### Session index

`<home>/history/index.json` holds one entry per session:

- first and last event time;
- `cwd`, project, title and model;
- whether it ended, and when;
- event count, agents (the main session plus distinct subagents and teammates);
- distinct and completed tasks;
- tool calls, tool errors, interrupts, permission prompts, turns and failed turns;
- the day files that hold its events.

The index is saved at most every 5 s and on stop. It is only a cache: if it is missing, corrupt, or older than the journal (after a crash), it is rebuilt from the journal on start.

### Retention

Cleanup runs at start, on the first flush of a new UTC day, and every 24 hours:

1. Day files older than **14 days** (today plus the 13 previous UTC days) are deleted.
2. While the journal exceeds **256 MiB**, the oldest remaining day files are deleted. Today's file is never deleted. If today's file alone reaches the cap, journaling pauses until the next day, and the dropped events are counted.
3. A session that loses its oldest days is marked **partial**. A session left with no days is removed from the index.

Both limits are options of `historyPlugin({ retentionDays, maxTotalBytes })`.

### RPC routes

| Method | Params | Result |
| --- | --- | --- |
| `history.sessions` | `{ project?, from?, to?, limit? }`: `project` is a path or project label; `from`/`to` are epoch ms and match sessions overlapping the range; `limit` is 1 to 1000, default 200 | `{ sessions, total, projects }`, newest first |
| `history.events` | `{ sessionId, from?, to?, cursor?, limit? }`: `limit` is 1 to 5000, default 2000 | `{ events, total, done, nextCursor?, capped? }` in journal order, plus monitor-restart events within the session's time range. At most 200,000 events per session are read back |
| `history.summary` | none | Day files and sizes, totals, retention settings, buffer and error counters |

Invalid parameters are ignored or rejected; they never cause a crash. `MonitorMeta.plugins.history` publishes `{ sessions, bufferedEvents, totalBytes, retentionDays, lastFlushAt, writeErrors, droppedEvents }`.

## Metric definitions

Metrics come from `packages/ui/src/analytics.ts`, which is pure and fully tested. Session metrics are computed from a session's journaled events. Live metrics are computed from the current office state.

| Metric | Kind | Definition |
| --- | --- | --- |
| Session duration | derived | First to last journaled event of the session; for a live session, until now when requested |
| Tasks completed | observed | Distinct tasks with a `TaskCompleted` event |
| Tasks left open | observed | Tasks still open when their session ended. Claude Code has no task-failure event, so these are never called "failed" |
| Tasks open | observed | Created and not completed, in a running session |
| Task duration | derived | `TaskCompleted` time minus `TaskCreated` time, when both were observed |
| Tool calls | observed | Distinct tool calls (by `tool_use_id`) across `PreToolUse`, `PostToolUse`, `PostToolUseFailure` and `PermissionDenied` |
| Tool errors | observed | `PostToolUseFailure` events that are not user interrupts, plus `PostToolUse` events with `success: false` |
| Interrupted / denied | observed | `PostToolUseFailure` events with `is_interrupt`, and `PermissionDenied` events |
| Outcome not observed | observed | Tool calls with a start but no completion event |
| Tool time | derived | `duration_ms` reported by Claude Code when present, otherwise completion time minus start time |
| Tool error rate | derived | Tool errors divided by tool calls with an observed outcome |
| Prompts / turns / failed turns | observed | `UserPromptSubmit` (the prompt text is never recorded), `Stop`, and `StopFailure` events |
| Time by status | derived | See below |
| Agent-time | derived | Status time summed over all agents of a session. Two agents working in parallel for one minute count as two minutes |
| Repeated errors | derived | Tool errors and failed turns grouped by tool and first error line, with digits replaced by `#`. Only groups seen at least twice are listed |
| Activity distribution | derived | Events, tool calls and errors per equal-width time bucket; tool calls per tool and per agent |

**Time by status.** The session's events are replayed through the same reducer the office uses. After every event, each agent's status is read; a status lasts until that agent's next status change. The open status at the end lasts until the last event, or until now for a live session when that is requested. Statuses map to these buckets:

- **working**;
- **waiting**, which combines waiting for permission and waiting for input;
- **idle**;
- **failed**, a failed turn until the next prompt;
- **unknown**.

Terminal statuses (completed, ended) end the measurement. The clock is the running maximum of event times, so an event delivered late with an older timestamp never produces negative time.

**Live state metrics** (Analytics → Office activity) use the reducer's own per-agent counters. Their tool-failure count includes user interrupts and is labelled accordingly. Simulated sessions are excluded.

### Summaries

Summaries are fixed templates filled with the counts above, for example:

> 3 tasks completed, 1 left open, 5 tool errors (2 repeated), 1 failed turn. Main agent working 12m 4s, waiting 1m 30s, idle 20m 0s over 33m 34s.

Clauses with a zero count are omitted. With no activity at all, the summary reads "No tasks or tool activity recorded."

## Replay

The History view replays a session's journaled events in the monitor's original apply order, through the same pure reducer as the live office (`packages/ui/src/replay.ts`).

- **Faithful.** The statuses, tools, tasks and subagents shown at time *t* are exactly what the office showed then. The tests check that the state at every position equals reducing the event prefix.
- **Reconstructed.** Walking, desk assignment, seating and animations are produced by the scene, and idle life is off. The view always shows the label **"Replay · movement reconstructed"**.
- **Replay clock.** Event times are not strictly monotone (async hooks, spool replays), so the replay clock of event *i* is the running maximum of the timestamps up to *i*. "State at *t*" means the state after every event whose replay clock is ≤ *t*. Scene effects such as celebrations and lingering finished agents are re-timed to the wall clock.
- **Fast seeking.** A checkpoint state is kept every 250 events. A seek replays at most 250 events from the nearest checkpoint, and playing forward applies only the new events.
- **Player.**
  - Play and pause.
  - Speed 1×, 2×, 4×, 8× or 16×.
  - Seek with the slider or the event-density bar (red marks errors, orange marks permission prompts, interrupts and restarts).
  - Step to the previous or next event.
  - Optionally skip quiet gaps longer than 30 s. This is labelled, and it jumps to one second before the next event.
- **Events panel.** The panel lists the events up to the selected time, using only sanitized summary fields.
- **Partial journals.** A replay starts from the session's first journaled event. Sessions that began before journaling started, or whose oldest days were removed by retention (marked *partial*), are replayed from the first event still on disk.

The History view loads at most 50,000 events per session and says when it shows fewer than were recorded.

## Known limitations

- Usage is known only for sessions whose transcripts are readable on this machine. Transcripts that Claude Code deletes or rotates away lose their history, because usage totals are kept in memory. After a monitor restart they are recomputed from the transcripts that still exist.
- Attribution follows first-read order. Copies of a message in two sessions, such as a resumed conversation, count toward the session that was read first.
- `cost-state` is read as Claude Code wrote it. Agent Office does not interpret the field semantics beyond the numbers listed above.
- History covers what this monitor observed. Hooks that were not installed, or events received while the monitor was down and not spooled, are absent.

## Tests

```bash
npx vitest run --project monitor usage history        # usage counting, pricing validation, journal, retention, RPC routes
npx vitest run --project ui analytics replay           # metric definitions, summaries, replay faithfulness and seeking
```
