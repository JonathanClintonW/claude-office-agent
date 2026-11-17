# Agent Office for Claude Code (VS Code extension)

A pixel-art office inside VS Code where each real Claude Code session, subagent and agent-team teammate is an animated worker. It is local-only and read-only: it never sends prompts, never answers permission requests and never calls a model. This extension is part of Claude Agent Office; see the `README.md` at the root of the repository for the full documentation.

## Install

The extension is built from this repository:

```bash
npm install
npm run package:vsix
code --install-extension packages/vscode-extension/agent-office.vsix
```

Then run **Agent Office: Open Office** from the command palette, or click the Agent Office item in the status bar.

## Commands

| Command | What it does |
| --- | --- |
| **Agent Office: Open Office** | Opens the office panel. |
| **Agent Office: Install Claude Code Hooks…** | Asks whether to install into your user settings or this workspace only, shows the planned change as a diff, and applies it only after you confirm. A backup of the settings file is written first; existing settings and hooks are preserved. |
| **Agent Office: Remove Claude Code Hooks…** | Removes only the Agent Office hooks, with the same review and backup. |
| **Agent Office: Restart Monitor** | Restarts the monitor that runs inside VS Code. |
| **Agent Office: Show Monitor Log** | Shows the monitor's log output. |

## What it shows

- **Workers.** Each worker's status comes from observed events: working, needs permission, needs input, idle, completed, failed, ended or unknown. Status is never guessed; when live data is missing it reads *unknown*.
- **Inspector.** Click a worker to see its current tool and any pending permission request, tool history with outcomes and durations, timing, tasks, recent log lines, git status for its directory, and the context size recorded in its transcript. **Open transcript (read-only)** opens the transcript in an editor. **Open Claude Code** (on a pending permission card) only focuses the official Claude Code extension; it cannot send text or answer the prompt.
- **Dashboard views.** Tasks, Errors, Git, Analytics, History with replay, Team and Settings, as in the browser version.
- **Notifications.** The status bar summarises the agents, and VS Code notifications appear when an agent needs permission or input, or a turn fails (setting `agentOffice.nativeNotifications`).
- **Simulated office life.** Idle agents take breaks, chat and meet. This is cosmetic and clearly labelled as simulated; real status always wins.
- **Layout editor.** Customise desks, furniture, walls, rooms and team zones. A zone can attract agents whose working directory matches it.

## How it connects

Each VS Code window connects to a running Agent Office monitor on `127.0.0.1`, or, with `agentOffice.autoStartMonitor` on, starts one inside its extension host. If the window that owns the monitor closes, another window takes over. The office runs in a webview with a strict Content Security Policy (`connect-src 'none'`); it receives its data from the extension through VS Code messaging.

## Data sources

1. **Claude Code hooks** (optional but recommended): the only source of tool activity, permission prompts, subagents and tasks. The hook is an async command that never blocks Claude Code, never prints output and always exits 0.
2. **Session registry:** Claude Code's `~/.claude/sessions/<pid>.json` files supply running sessions with their idle, busy or waiting state. Token files in the same folder are never read.
3. **Transcripts:** only the tail is read, for session titles, the model, last activity and the recorded token usage. Message content is not retained.

## Security and privacy

- **Network:** the monitor listens on `127.0.0.1` only, checks the `Host` and `Origin` headers and requires a locally generated token.
- **No data leaves the machine:** no cloud service, no account, no telemetry, and no model calls (the zero-inference guarantee is described in `docs/ZERO_TOKEN.md` in the repository).
- **Minimal data kept:** prompts and tool output are dropped in the hook process; tool inputs are reduced to short summaries with secrets redacted.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `agentOffice.port` | `47821` | Loopback port of the monitor |
| `agentOffice.autoStartMonitor` | `true` | Start the monitor inside VS Code when none is running |
| `agentOffice.claudeConfigDirs` | `[]` | Extra Claude config directories (`~/.claude` and `CLAUDE_CONFIG_DIR` are always included) |
| `agentOffice.showOnlyCurrentWorkspace` | `false` | Start filtered to this window's workspace |
| `agentOffice.nativeNotifications` | `true` | VS Code notifications for permission prompts, input requests and failures |

## License

MIT, © 2026 [JonathanClintonW](https://github.com/JonathanClintonW). See `LICENSE` and `THIRD_PARTY_NOTICES.md`.

Claude and Claude Code are products of Anthropic. This extension is an independent project and is not affiliated with, endorsed by or sponsored by Anthropic.
