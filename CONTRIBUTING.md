# Contributing to Claude Agent Office

Thanks for your interest! Bug reports, ideas and pull requests are welcome. This page covers how to set up the project, which checks to run, and the rules every change has to follow.

## Setup

You need Node.js 20 or newer and npm. The browser checks also need an installed Microsoft Edge (they drive it through `playwright-core`).

```bash
git clone <repository-url>
cd <repository-folder>
npm install
npm run build
```

## Run it

```bash
npm start                         # monitor + office on http://127.0.0.1:47821/
npm run simulate -- --linger 120  # in a second terminal: SIMULATED demo traffic
```

For UI work, run the Vite dev server against a monitor that accepts its origin:

```bash
npx agent-office start --dev
npm run dev:ui                    # http://127.0.0.1:5173
```

To try changes without touching your real data, start a throwaway monitor with its own data directory and port, for example `npx agent-office start --port 47900 --home <temp-dir> --no-discovery`, and point `simulate` at it with the same `--port` and `--home`.

## Checks

Run these before opening a pull request:

| Command | What it checks |
| --- | --- |
| `npm run typecheck` | TypeScript (strict) for every package, tests included |
| `npm run lint` | Stricter TypeScript flags plus repository rules (no `console.log` in sources, no non-loopback URLs in sources, no focused or unexplained skipped tests, no `@ts-ignore`) |
| `npm test` | Unit and integration tests for core, monitor, UI and the VS Code extension, including the static zero-inference scan |
| `npm run e2e:zero-token` | Needs a build. Runs the office in headless Edge against an isolated monitor and fails on any non-loopback request or inference call |
| `npm run smoke:webview` | Needs a build. Loads the webview bundle under the extension's Content Security Policy |
| `npm run smoke:extension` | Needs a build. Activates the bundled extension against a mock VS Code API |
| `npm run audit:publish -- "<your-name>"` | Scans the files that would be published for secrets, local paths, usernames and the local token |

[docs/VALIDATION.md](docs/VALIDATION.md) explains what each check proves and how to run it without touching your real `~/.agent-office`, `~/.claude` or monitor port. If you change something visible, you can refresh the README images with `node scripts/capture-screenshots.cjs` (it uses an isolated monitor and SIMULATED data only).

## Rules for changes

- **TypeScript, strict.** Keep `npm run typecheck` and `npm run lint` clean. Shared logic belongs in `packages/core` and should stay pure.
- **No model calls, ever.** No Anthropic, Claude, LLM or MCP SDKs, no inference hosts, no launching the Claude CLI, no `prompt` or `agent` hooks. The static scan in `packages/monitor/test/staticNoInference.test.ts` enforces this; a file that needs network or process access must be added to its allowlist with a justification.
- **No network beyond loopback.** Everything binds to and talks to `127.0.0.1`. No telemetry, no remote assets (fonts and art are bundled or procedural), no update checks.
- **Observe, never control.** Hooks must stay passive (async, silent, exit 0). Nothing may send prompts, answer permission requests or steer a session.
- **Real versus simulated.** Real status comes only from observed events and is never guessed: a missing value is `unknown`. Anything simulated (idle life, meetings, template dialogue, demo sessions) must be labelled as such and must never override or imitate real agent output. Demo sessions use the `sim-` prefix.
- **Privacy.** Never store or display prompts, file contents, full tool output or secrets. Do not commit secrets, tokens, personal data or absolute paths from your machine; use neutral paths such as `C:\demo\project` in tests and fixtures.
- **Tests with changes.** Add or update tests for behaviour changes, and keep documentation in `docs/` in step (for example, `docs/SIMULATION.md` must list every dialogue template line; a test checks it).
- **No new runtime dependencies** without discussing them in an issue first.

## Issues and pull requests

- **Bugs:** describe what you expected and what happened, your OS, Node.js and Claude Code versions, and whether hooks are installed (`npx agent-office status`). Do not paste transcripts, prompts, tokens or your `config.json`.
- **Features:** open an issue first for anything larger than a small fix, so the approach can be agreed before you invest time.
- **Pull requests:** keep them focused, explain the motivation, list the checks you ran, and include screenshots for visible changes (made with SIMULATED data).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
