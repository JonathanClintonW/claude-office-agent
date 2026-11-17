# Zero extra inference

This page covers what Agent Office guarantees about model inference, how the guarantee is enforced, and how to check it yourself.

## The guarantee

**Agent Office never causes model inference.** No code in this repository:
- calls the Claude API or any Anthropic, Claude, LLM or MCP SDK;
- contacts an inference host;
- launches the Claude CLI;
- writes prompts, or asks Claude Code to do anything.

The office only observes. It uses:
- the hook payloads that Claude Code sends to it;
- files that Claude Code writes, read without changing them;
- optionally, read-only local `git` status.

Every runtime connection goes to `127.0.0.1`.

The office also adds **no tokens to your own sessions**. Hooks can cost tokens: Claude Code can feed hook output into the model's context (for example `SessionStart` or `UserPromptSubmit` stdout, or `additionalContext`), and a blocking decision can force another model turn. Agent Office's hooks avoid all of this:
- The command forwarder is `async: true`. It writes nothing to stdout or stderr and always exits 0.
- HTTP hooks get an empty `204`.
- The installer writes only `command` (async) and `http` handlers. It never writes `prompt` or `agent` handlers, which run a model on every event at your expense, and never `mcp_tool` handlers.

### What this guarantee does not say

- **It does not say your Claude account used zero tokens.** Your own Claude Code sessions use tokens as usual. The office only shows the usage that those sessions report.
- It covers the office runtime (monitor, hook forwarder, browser UI, VS Code extension) and the repository's scripts. Developer tooling such as `npm install`, `vsce package` or Playwright browser downloads uses the network when you run it. None of that tooling calls a model.

## Audit

Every place where the code could reach the network, start a process or talk to Claude. Classes:
- **P**: passive and inference-free.
- **U**: explicit, user-initiated, and not inference.
- **X**: unnecessary inference. None found.
- **?**: unknown. None remaining.

| Component | Code | What it does | Destination | Class | Enforced by |
| --- | --- | --- | --- | --- | --- |
| Hook forwarder | `monitor/src/forwarder.ts` | `http.request` POST `/api/hook` with the pre-trimmed payload. Spools to disk if the monitor is down. Silent, exits 0. | `127.0.0.1:<port>` | P | Static allowlist (loopback-only URLs); `server.test` (no stdout/stderr, exit 0) |
| Hook installer | `monitor/src/hooks.ts` | Edits a settings file only after you approve it, and writes a backup first. Handlers are async `command` or `http` to `127.0.0.1`. | Local file | U | `assertPassiveHandler` runs at plan time; `hooks.test` |
| Spool | `monitor/src/spool.ts` | One small file per event in `~/.agent-office/spool` | Local disk | P | n/a |
| Monitor server | `monitor/src/server.ts` | HTTP and WebSocket server on `127.0.0.1` only. Host and Origin checks, token, empty `204` to hooks. | Loopback (inbound) | P | Static scan (no client primitives); runtime guard |
| Discovery | `monitor/src/discovery/*.ts` | Reads `~/.claude/sessions/<pid>.json` (whitelisted fields only) and the tail of transcripts (message content discarded). `process.kill(pid, 0)` checks liveness. | Local disk | P | Static scan; `server.test` |
| Persistence | `monitor/src/store.ts`, `config.ts` | JSON in `~/.agent-office` | Local disk | P | n/a |
| Plugins | `monitor/src/plugins/*.ts` | `inference`: guard counters, plus a read-only check of the settings files for duplicate hook scopes. `usage`, `history`: derived from events and transcripts. `git`: `execFile('git')`, read-only. | Local | P | Runtime guard (git allowed, anything else counted); `inference.test` calls every route |
| CLI | `monitor/src/cli.ts` | Health check and `simulate` POSTs. `--open` spawns `rundll32 url.dll,FileProtocolHandler`, `open` or `xdg-open` with the loopback URL. | `127.0.0.1`; OS browser | U | Static allowlist; the guard classes the opener as `browser` only for a loopback URL |
| Simulator | `monitor/src/simulate.ts` | Local templates. Sessions are prefixed `sim-` and labelled SIMULATED. | None | P | n/a |
| Extension connection | `vscode-extension/src/connection.ts` | Health check and WebSocket to the monitor. May run the monitor inside the extension host. | `127.0.0.1` | P | Static allowlist. The runtime guard is inactive in this host (see below). |
| Extension commands | `vscode-extension/src/extension.ts` | `executeCommand` for its own `agentOffice.*` commands. **Open Claude Code** runs `claude-vscode.focus`, `claude-vscode.editor.openLast` or `claude-vscode.sidebar.open`, which open the official UI and submit nothing. Read-only transcript view. | VS Code | U | The static scan accepts only these three Claude commands and fails on `vscode.lm`, chat participants, chat/Copilot commands, terminals and tasks |
| Webview | `vscode-extension/src/webview.ts` | Strict CSP: `default-src 'none'`, `connect-src 'none'`. Data arrives by `postMessage`. | None | P | CSP; `smoke:webview` |
| Browser UI | `ui/src/transport.ts` and the rest of `ui/src` | WebSocket to the serving origin. CSP `default-src 'self'`, `connect-src ws://127.0.0.1:* ws://localhost:*`. Fonts are bundled. The art is procedural, so no assets are fetched. | `127.0.0.1` | P | Static scan (only `transport.ts` may open sockets); CSP; e2e |
| Sound | `ui/src/audio/*.ts` | Music and effects synthesized with the Web Audio API in the page. No audio files, no fetch. Off by default. | None | U | Static scan |
| Pre-publish audit | `scripts/audit-publish.cjs` | `execFileSync('git')` with a temporary `GIT_DIR` | Local | U (dev) | Static allowlist |
| Webview smoke | `scripts/smoke-webview.cjs` | Local static server, `GET /api/state` on `127.0.0.1`, local headless Edge | `127.0.0.1` | U (dev) | Static allowlist |
| Extension smoke | `scripts/smoke-extension.cjs` | Loads the bundle with a mock `vscode` | None | U (dev) | Static scan |
| Zero-token e2e | `scripts/e2e-zero-token.cjs` | Isolated monitor child process, headless Edge, aborts any non-loopback request | `127.0.0.1` | U (dev) | Static allowlist |
| Screenshot capture | `scripts/capture-screenshots.cjs` | Isolated monitor child process fed with SIMULATED demo events, headless Edge that aborts any non-loopback request; transpiles `simulate.ts` with the local esbuild | `127.0.0.1` | U (dev) | Static allowlist |
| Lint | `scripts/lint.mjs` | Runs the local `tsc` | Local | U (dev) | Static allowlist |
| Build scripts | `packages/*/scripts/build.mjs` | esbuild (a local binary) | Local | U (dev) | Static scan |

Result: nothing in the runtime is unnecessary inference, and nothing is unknown. Every non-passive item is a deliberate user action.

## Enforcement

### 1. Static test: `packages/monitor/test/staticNoInference.test.ts`

The test scans every `.ts/.tsx/.js/.mjs/.cjs` file under `packages/*/src`, `packages/*/scripts` and `scripts/`. Each file goes through esbuild first, which removes comments and type-only imports. A lexer then separates string literals and regexes from code, so prose in comments, strings or JSX never counts as a call.

The test fails when a file:
- imports an Anthropic, Claude, LLM or MCP SDK (`@anthropic-ai/*`, `@modelcontextprotocol/*`, Bedrock, Vertex, OpenAI, LangChain and others);
- names a Claude inference host from the guard's `DEFAULT_INFERENCE_HOSTS`. Documentation links to `docs.anthropic.com` and `support.anthropic.com` are allowed, because they are user navigation;
- can start processes and contains a `claude` command string;
- uses `vscode.lm`, chat participants, chat or Copilot commands, or a Claude extension command other than the three UI-only ones above;
- uses a network or process primitive outside the allowlist. These are the `http`/`https` client, `fetch`, `WebSocket`, `net`/`tls`, `child_process`/`cluster`, HTTP libraries, browser automation, `process.getBuiltinModule`, and VS Code terminals, tasks and `openExternal`. Servers such as `http.createServer` and `WebSocketServer` are fine.

The allowlist is kept small (a test caps its size), and every entry carries a justification. In those files every URL literal must point to loopback. The test also fails when an entry is stale, that is, when its file no longer uses what it is allowed to use.

This test is the guarantee for the VS Code extension host, where the runtime guard does not run.

### 2. Runtime guard: `packages/monitor/src/inferenceGuard.ts`

The guard is installed by the `inference` plugin when the monitor starts, and released when it stops. It wraps `node:http` and `node:https` `request` and `get`, `globalThis.fetch`, `globalThis.WebSocket`, and `node:child_process` `spawn`, `exec`, `execFile` and `fork` together with their `Sync` variants. It also re-syncs ESM named imports, so `import { request } from 'node:http'` sees the wrapper.

What it does with each kind of call:

| Call | What happens |
| --- | --- |
| A request to an inference host or a Claude base URL | **Blocked.** The call throws `InferenceBlockedError`, or the `fetch` promise rejects, before any DNS lookup, socket or process exists. Counted in `officeInferenceCalls` and `blocked`. |
| A launch of Claude | **Blocked** and counted in the same way. |
| Any other non-loopback request | Allowed, counted in `externalRequests`, and recorded as `lastViolation`. Expected: 0. |
| Loopback (`127.0.0.0/8`, `localhost`, `::1`, local sockets) | Allowed and counted in `loopbackRequests`. |
| `git` | Allowed and counted in `processLaunches.git`. |
| The OS browser opener with a loopback URL | Allowed and counted in `processLaunches.browser`. |
| Any other process | Allowed and counted in `processLaunches.other`. Expected: 0. |

Inference hosts:
- `anthropic.com` and `*.anthropic.com`;
- `claude.ai` and `*.claude.ai`;
- Claude Platform on AWS: `aws-external-anthropic.*.api.aws`;
- Amazon Bedrock: `bedrock-runtime(-fips).*.amazonaws.com` and `bedrock-mantle.*.api.aws`;
- Vertex AI: `*aiplatform.googleapis.com`;
- Claude on Google Cloud: `claude.googleapis.com`;
- Microsoft Foundry: `*.services.ai.azure.com`.

More hosts come from the environment:
- every `ANTHROPIC_*BASE_URL`, matched by port, so a local LiteLLM-style proxy counts as inference;
- `AGENT_OFFICE_INFERENCE_HOSTS`, a comma-separated list of `host`, `*.host`, `host:port` or URLs.

A Claude launch is any of:
- `claude`, `claude.exe`, `claude.cmd` or a path ending in one of them;
- a command line that names `@anthropic-ai/claude-code` or `@anthropic-ai/claude-agent-sdk`;
- a shell or launcher (`cmd`, `sh`, `bash`, `powershell`, `node`, `npx` and so on) whose arguments run `claude`;
- a shell command line containing `claude`.

The guard records only the scheme, host and port of a request, or the executable name of a launch. It never stores paths, queries or arguments.

`install()`, `uninstall()`, `acquire()` (reference-counted, used by the plugin), `reset()` and `diagnostics()` are all idempotent. Uninstall restores the original functions. If another library wrapped a function after the guard, uninstall leaves that wrapper in place, and the guard's own wrapper becomes a pass-through.

**Where the guard runs:**
- **The CLI monitor** (`agent-office start`): active. The badge reads `Office inference calls: 0 · runtime verified`.
- **The VS Code extension host**, where `process.versions.electron` is set: inactive on purpose. That process is shared with every other extension, including the official Claude Code extension, so the office must not patch its globals. Diagnostics report `guard: 'inactive'`, `instrumented: []` and the reason. The badge reads `Office inference: static-checked`, and the static test covers this host.
- **Your own Claude Code sessions** are separate processes. The guard never touches them.

**Limits of the runtime guard.** It sees only calls made through the wrapped functions after it was installed. Code that kept a direct reference earlier, raw `net`/`tls` sockets, the `http.ClientRequest` constructor, worker threads and native addons are not intercepted. The static test forbids all of them outside the allowlist.

### 3. Hook installer

`planInstall` calls `assertPassiveHandler` on every handler it writes. Anything other than an async `command`, or an `http` handler to `127.0.0.1`, throws. `hooks.test.ts` checks this for both modes, and checks that your own `prompt`, `agent` and `mcp_tool` hooks are preserved and are never treated as ours.

### 4. Browser end-to-end

`npm run e2e:zero-token` runs the built office in headless Edge with an isolated home. It aborts and counts every non-loopback request, then asserts that `meta.plugins.inference` reports zero. See [VALIDATION.md](VALIDATION.md).

### 5. Content Security Policy

The served UI allows only `self` and loopback WebSockets. The VS Code webview has `connect-src 'none'`.

### 6. Runtime tests of every passive feature

- `packages/monitor/test/zeroTokenRuntime.test.ts` runs the monitor with every default plugin in-process, with discovery on and off, a long simulation, a burst, reconnections, every RPC route and ticks, while spies record every `http`/`https`/`net`/`tls`/`fetch`/`child_process` call. Only loopback connections and `git` may appear; no Claude launch.
- `packages/ui/test/zeroTokenUi.test.ts` replaces every network primitive the page could use (`fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`, workers, `RTCPeerConnection`, `sendBeacon`, `window.open`) with recorders that throw, then runs desk presentation, collaboration analysis, errors, analytics, department rules, a full replay, and two simulated hours of idle life, dialogue and meetings. It checks the simulation really ran and that every spoken line is verbatim from the template table.
- `packages/ui/test/zeroTokenApp.test.tsx` mounts the whole React app in jsdom against a local stand-in for the monitor that runs the real usage, history and git plugins in-process. With every network primitive throwing, it covers start-up, a live session with parallel and nested subagents and teammates, every dashboard tab, the inspector, mini-map navigation, department rules, token analytics from a transcript, history and replay, then unmount.

## How to verify

```bash
npx vitest run --project monitor staticNoInference     # static scan of every source file
npx vitest run --project monitor inference.test        # runtime guard: long monitored workload = 0 / 0, detection proofs
npx vitest run --project monitor zeroTokenRuntime      # monitor + plugins with network/process spies
npx vitest run --project ui zeroTokenUi                # UI simulation, analytics and replay with network recorders
npx vitest run --project ui zeroTokenApp               # the whole app in jsdom with network recorders
npx vitest run --project monitor hooks.test dedupe     # installer handler types, scope duplication, deduper
npm run build && npm run e2e:zero-token                # browser end-to-end
```

On Windows, filter by project and by a file-name fragment as shown above: full paths match no files with the multi-project config.

`inference.test.ts` installs the guard in the test process and runs a monitor with every default plugin. The workload is eight runs of the scripted three-session scenario, delivered directly, over HTTP and through the spool. The test then runs:
- discovery against a temporary Claude directory;
- every plugin RPC route, called directly, over WebSocket and over HTTP;
- every timer, with short intervals;
- two WebSocket clients.

It asserts `officeInferenceCalls === 0`, `externalRequests === 0` and no unexpected process launches. It then proves that detection works:
- `https://api.anthropic.com`, Bedrock, Vertex, Foundry and `claude.ai` requests (via `http`, `https` and `fetch`) are blocked and counted;
- a WebSocket to a configured inference host is blocked;
- twelve different ways of launching Claude are blocked and counted.

Every attempt also has a safety net, so nothing could leave the machine or run even if the guard failed: a local DNS lookup that fails, pre-aborted `fetch` signals, `--version` arguments and a working directory that does not exist.

**Check a running monitor** (read-only):

```powershell
$cfg = Get-Content "$env:USERPROFILE\.agent-office\config.json" | ConvertFrom-Json
(Invoke-RestMethod "http://127.0.0.1:$($cfg.port)/api/rpc/inference.diagnostics" -Headers @{ 'x-agent-office-token' = $cfg.token }).result
# OS view: every connection of the monitor process should be to 127.0.0.1
$monitorPid = (Get-NetTCPConnection -LocalPort $cfg.port -State Listen).OwningProcess
Get-NetTCPConnection -OwningProcess $monitorPid | Select-Object LocalAddress, RemoteAddress, State
```

```bash
TOKEN=$(node -p "require(require('os').homedir() + '/.agent-office/config.json').token")
curl -s -H "x-agent-office-token: $TOKEN" http://127.0.0.1:47821/api/rpc/inference.diagnostics
```

## What each number means

| Number | Meaning | Source |
| --- | --- | --- |
| **Observed Claude usage** | Tokens that Claude Code itself recorded for your sessions, such as the `usage` of the latest API call in a transcript. Shown as reported. Missing data is shown as not reported and is never estimated. | Transcripts and hooks |
| **Estimated API-equivalent cost** | Observed tokens multiplied by public per-token list prices: what the same tokens would cost on the pay-as-you-go API. It is an estimate and must always be labelled as one. It is not your bill. Subscriptions are flat-rate. Bedrock, Vertex and Foundry have their own pricing. Discounts and credits are invisible to the office. | Derived by the office |
| **Actual billing** | Available only in the Claude Console, your claude.ai account or your cloud provider's billing. The office cannot see it and never shows it. | Not available to the office |
| **Office inference calls** (`officeInferenceCalls`) | Attempts by the office's own process to reach an inference host or launch Claude. 0 by design. Any attempt is blocked, so even a non-zero value means nothing was sent. | Runtime guard |
| `externalRequests` | Non-loopback requests made by the office's process. Expected 0. | Runtime guard |
| `blocked`, `loopbackRequests`, `processLaunches` | Blocked attempts; local requests (hook forwarding, health checks, WebSockets); `git`, browser-opener and other launches. | Runtime guard |

## Hooks installed in two scopes

If Agent Office hooks are present both in user settings (`~/.claude/settings.json`) and in a project's `.claude/settings.local.json` or `.claude/settings.json`, Claude Code may run both handlers, and every event then arrives twice. Two sources of help:
- `detectDuplicateHookScopes` and `collectHookScopes` in `hooks.ts` work out which scopes hold our hooks. The `inference` plugin runs that check for the working directories of running sessions, and publishes the result as `meta.plugins.inference.hookScopes.duplicateEvents`.
- `createDeduper` in `dedupe.ts` drops the second copy. Two events count as copies only when their fingerprints match (session, agent, hook event, `tool_use_id`, tool, notification type, task id and a hash of the rest of the payload) and their capture times are within 2 s.
- Genuinely different events are never merged, and identical events minutes apart are kept. The one exception: two byte-identical payloads captured within the window cannot be told apart from a duplicate.

## Inference-free sources that are not used by default

- **Status line JSON.** Claude Code pipes a JSON document to the `statusLine` command on every refresh (model, session, workspace, cost and context figures). It costs no inference, because the command's output appears in the terminal status bar and never goes to the model. It is not used by default:
  - there is one `statusLine` per settings file, so it would replace yours;
  - it starts a process on every refresh;
  - it exists only in the terminal UI.

  It could become an opt-in that chains to your existing status line.
- **OpenTelemetry.** With `CLAUDE_CODE_ENABLE_TELEMETRY=1` and `OTEL_*` exporters, Claude Code exports token, cost and tool metrics and events, again without inference. It is not used by default:
  - it requires changing the environment of every Claude Code session;
  - it needs an OTLP receiver;
  - a mistake could ship telemetry to a remote collector;
  - hooks and transcripts already cover most of the same data.

  It could become an opt-in that is restricted to a `127.0.0.1` receiver.
- **Never used:**
  - `claude -p` and the Agent SDK;
  - the Claude API, including "free" endpoints such as token counting, which are still requests to `api.anthropic.com`;
  - typing `/cost` or `/usage` into a session, which would mean injecting input.
