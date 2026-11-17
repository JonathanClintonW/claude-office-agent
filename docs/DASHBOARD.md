# Developer dashboard

This page covers the agent **inspector**, the **task board**, the **Errors** view and the **Git** view. Analytics, History and replay are described in [ANALYTICS.md](ANALYTICS.md), the Team view in [COLLABORATION.md](COLLABORATION.md). All of them follow the same rules:

- **Read-only.** No control sends prompts, answers permission requests, or starts, resumes or stops Claude sessions.
- **Zero extra inference.** Error detection and summaries are plain rules over recorded events. Nothing calls a model, the Claude CLI, MCP or a network host.
- **Honest.** A missing value is shown as `Not reported` or `Unavailable`, never guessed. Heuristics carry a visible `heuristic` tag whose tooltip says what they are based on.
- **Private.** The dashboard never shows prompts, file contents, full tool output, secrets or author emails.

## Inspector (sidebar)

| Field | Source | When missing |
| --- | --- | --- |
| Current file | Target of the running tool, when it is a file tool (`Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `NotebookRead`) | `Not reported` |
| Last file | Most recent file-tool target in the retained tool history | hidden |
| Session duration / Lifetime | `firstSeenAt` → `endedAt`, or now. Labelled *observed*: the agent may have started before the monitor saw it | — |
| Recent errors | Last 5 tool calls that `failed`, were `denied` or `interrupted`, with times and the first line of the reported error | `Not reported` without hooks |
| Git | `git.status` RPC for the agent's cwd: branch, upstream ↑/↓, change counts, diff totals, last commit, potential conflicts | the reason (not a repo, git missing, not connected…) |
| Tasks tab | Task history (created, completed, who, duration) from `TaskCreated` / `TaskCompleted` | `No tasks…` |

Under the activity tab, a **Read-only monitoring** note states what the dashboard cannot do.

**Open Claude Code** appears only inside VS Code, and only on a pending permission card. It is labelled *navigation only*. It posts `{ type: 'focusClaude' }`, a message with no payload, to the extension. The extension then runs the official extension's public focus commands. No text can be attached, so the button cannot send a prompt or answer the permission.

## Task board (Tasks tab, or the cork board in the office)

The columns come straight from hook events:

| Column | Rule |
| --- | --- |
| Open | `TaskCreated` seen, no `TaskCompleted` |
| Completed | `TaskCompleted` seen |
| Open when session ended | The session ended while the task was open (`orphaned`), so the outcome is unknown |

**Sub-states (heuristic).** An open task can carry a `Running`, `Waiting` or `Blocked · heuristic` tag. The tag comes from the owning agent's live status: `working`, `waiting_input` or `waiting_permission`. The owner is the named teammate in the task's session, otherwise the creator. Claude Code does not report task progress, so the tag only says what the owner is doing now. It is never shown on completed or orphaned tasks.

Each card shows:
- subject and description;
- owner agent (click to inspect);
- project (cwd folder name);
- creation time;
- duration: *open for*, *took*, or *open … until the session ended*;
- last update, meaning the latest task event.

You can filter by session and by project. The board works as an inline page (`inline`) and as a modal dialog.

## Errors view

`packages/ui/src/errors.ts` is pure (`detectIssues(state, now)`) and unit-tested. Results are sorted by severity (error → warning → info), then by recency. You can filter by type, severity, project and *ongoing only*. Every item links to its agent.

| Type | Severity | Rule | Evidence |
| --- | --- | --- | --- |
| Turn / API failure | error | `StopFailure` notice. *Ongoing* while the agent's status is still `failed` | StopFailure hook |
| Tool failure | error | Tool status `failed` | PostToolUseFailure |
| Likely test failure (**heuristic**) | error | A failed `Bash`/`PowerShell` call whose command matches a test runner (`vitest`, `jest`, `pytest`, `go test`, `cargo test`, `npm test`, …), whose description says "run … tests", or whose error looks like runner output (`2 failed`, `Tests: 1 failed`, `AssertionError`) | PostToolUseFailure |
| Repeated failure | error | The same agent, tool and summary failed at least 3 times within 10 minutes | PostToolUseFailure |
| Blocked on permission | warning | Status `waiting_permission`, or a pending permission | PermissionRequest / Notification / registry |
| Waiting for input | warning | Status `waiting_input` | Notification / question tools / registry |
| Permission denied | warning | Tool status `denied` | PermissionDenied |
| Quiet agent (**heuristic**) | warning | The reducer's `stale` flag: no events for 5 minutes, or 20 while a tool runs. The status itself is unchanged | Monitor tick |
| Disconnected session | warning | Session ended with "Process exited…" or "Left the session registry…" (no `SessionEnd`). Subagents that ended with it are counted | Registry / PID liveness |
| Interrupted | info | Tool status `interrupted` | PostToolUseFailure (`is_interrupt`) |
| Unknown status | info | Agent status `unknown`, or tool outcomes never observed (grouped per agent) | — |

Only the retained history is analysed: 60 tool calls per agent and 200 notices. Agents pruned from the state are not listed.

## Git view and the `git` monitor plugin

`packages/monitor/src/plugins/git.ts` answers two read-only RPC methods. Their types are in `packages/core/src/contracts/git.ts`.

| Method | Params | Result |
| --- | --- | --- |
| `git.repos` | none | `GitReposResult`: repositories (root, name, agent keys, session ids, cwds) derived from the cwds of agents in the monitor state, plus `unresolved` directories with a reason, and `gitAvailable` |
| `git.status` | `{ cwd: string }` | `GitStatusResult`: on success, branch (name, detached, unborn, upstream, ahead/behind, gone), changed files (capped at 200) and counts, the last 10 commits (short hash, redacted subject, ISO author date), `diff --numstat` totals for unstaged and staged changes, and potential conflicts. On failure, `{ ok: false, problem: { code, message } }` |

### What runs

Every invocation is `execFile('git', args, { cwd, timeout, maxBuffer, windowsHide: true })`: no shell, 5 s timeout, 2 MiB output cap, at most 3 concurrent processes. Global options `--no-optional-locks -c core.fsmonitor=false -c core.quotepath=off -c color.ui=never -c log.showSignature=false` come first. That way `git status` never rewrites the index, and no fsmonitor hook or signature helper runs.

| Purpose | Subcommand |
| --- | --- |
| Repository root and cwd prefix | `rev-parse --show-toplevel --show-prefix` |
| Branch, upstream, ahead/behind, changes | `status --porcelain=v1 -b -z` |
| Line totals (no contents, no external diff or textconv) | `diff [--cached] --numstat --no-ext-diff --no-textconv --no-color` |
| Recent commits (no author identity) | `log -n10 --no-color --format=%h%x1f%aI%x1f%s%x1e` |

Only `rev-parse`, `status`, `log` and `diff` are allowed. Network subcommands (fetch, pull, push, remote, ls-remote, clone, submodule) are never issued. Ahead/behind is therefore relative to the **last locally known** upstream ref, and the UI says so.

### Validation and failure handling

**Validation.** `cwd` must be a string under 1024 characters. Its normalized form must equal the cwd of an agent currently in the monitor state. Any other path returns `not_tracked` without starting a process. The directory must exist and be absolute (`missing_dir` otherwise). On Windows, Git Bash paths (`/c/x`) are converted.

**Caching.** Status answers are cached for 5 s per repository and root lookups for 30 s per directory. Failures are cached for 5 s, and concurrent requests share one in-flight query.

**Degradation.** Each failure maps to a problem code:

| Code | Cause |
| --- | --- |
| `not_a_repo` | The directory is not inside a git work tree |
| `git_missing` | The git executable could not be started |
| `timeout` | A git command took longer than 5 s |
| `failed` | Anything else, with a sanitized first stderr line, for example a `safe.directory` ownership refusal or the output cap |

A failed `log` or `diff` makes only that part unavailable (`commitsProblem`, or `diff.* = null`). It is never shown as zero.

**Potential conflicts (heuristic).** A file counts as a potential conflict when edit tool calls (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) from **two or more sessions** targeted it inside the same repository. Failed, denied and interrupted edits are ignored. It is flagged *uncommitted* when git also reports the file as changed. This is not a git merge conflict, and it only covers the retained tool history. Targets are matched against git's root and against the root as the agents spell it, derived from `--show-prefix`. This handles Windows 8.3 short names and Git Bash paths.

**The Git view** lists every repository with its sessions and subagents (click to inspect), and refreshes every 20 s or on demand. For each repository it shows:
- the branch line;
- change counts and the changed-file list;
- diff totals;
- potential conflicts;
- recent commits.

It also lists the agent directories that are not repositories.

## Tests

```bash
npx vitest run --project monitor git.test                   # parsers + routes on a temporary repository
npx vitest run --project ui errors.test components.test     # detection rules, inspector, task board, Errors and Git views
```

The monitor tests create a temporary git repository in a temp dir, with a local upstream branch so no remote is needed. They drive `git.repos` and `git.status` through `createMonitor(...).rpc()` and are skipped when git is unavailable. They also record every `execFile` call. Each one must be `git` with an allowed subcommand, `windowsHide`, a timeout, an output cap and no shell. Further tests cover validation, caching, missing directories and a missing git executable (simulated with an empty `PATH`).

## Known limitations

- Ahead/behind can be stale, because the dashboard never fetches.
- Untracked directories are listed as one entry (`dir/`), as `git status` does by default.
- Potential conflicts and the Errors view only see the retained tool history.
- An agent cwd that is a symlink or junction may map to a root spelled differently. Conflict matching then relies on the `--show-prefix` alias.
- `git status` can be slow on very large repositories on Windows, and answers `timeout` after 5 s.
