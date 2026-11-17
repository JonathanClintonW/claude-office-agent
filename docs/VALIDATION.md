# Testing and validation

This page lists every check in the repository: what it proves, how to run it safely, and the numbers measured with it. All measurements come from a single development machine (Windows 11, Intel i5-10210U at 1.6 GHz with 4 cores and 8 threads, Node.js 24.21, TypeScript 7.0.2, Vitest 5.1, Microsoft Edge 157 headless with SwiftShader software rendering). Treat them as orders of magnitude, not as benchmarks.

> **Keep checks away from your real data.** Never point a check at your real `~/.agent-office` or `~/.claude`, or at port 47821, unless you mean to. Every check that starts a monitor creates its own temporary directories, a free port and an isolated environment.

## Commands at a glance

| Check | Command | Needs a build | Touches real user directories |
| --- | --- | --- | --- |
| Typecheck | `npm run typecheck` | no | no |
| Lint (strict TypeScript and repository rules) | `npm run lint` | no | no |
| All unit and integration tests | `npm test` | no | no |
| One project or file | `npx vitest run --project monitor zeroTokenRuntime` | no | no |
| Performance tests | `npx vitest run perf` | no | no |
| Zero-token runtime test | `npx vitest run --project monitor zeroTokenRuntime` | no | no (sandboxed) |
| Zero-token browser end-to-end test | `npm run e2e:zero-token` | yes | no (sandboxed) |
| Webview smoke test | `npm run smoke:webview` | yes | reads `config.json` under `AGENT_OFFICE_HOME`, then connects to that monitor |
| Extension smoke test | `npm run smoke:extension` | yes | no |
| Pre-publish audit | `npm run audit:publish -- "name" "company"` | no | reads the token in `~/.agent-office/config.json` to look for it (never prints it) |
| Screenshot capture | `node scripts/capture-screenshots.cjs` | yes | no (sandboxed) |

> **Windows and Vitest filters.** With the multi-project root configuration, a full path such as `npx vitest run packages/core/test/perf.test.ts` matches no files on Windows ("No test files found"). Filter by project and by a file-name fragment instead: `npx vitest run --project core perf`.

## What each check proves

### Typecheck

`npm run typecheck` runs `tsc -p packages/<pkg> --noEmit` for `core`, `monitor`, `ui` and `vscode-extension`. Each package's `test/` folder is part of its program, so tests are typechecked too. `packages/core` compiles with `types: []` (no DOM and no Node), so core code and tests must declare any platform global they use.

### Lint: `scripts/lint.mjs`

`npm run lint` needs no extra dependencies.

1. **Stricter TypeScript.** Runs `tsc -p packages/<pkg> --noEmit --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch` for each of the four packages, in parallel, with the local `node_modules/typescript` compiler.
2. **Code rules** over `packages/*/{src,test,scripts}` and `scripts/`. A tokenizer separates code, comments, strings and regular-expression literals, so prose and string contents never trigger a rule.

   | Rule | What fails |
   | --- | --- |
   | `no-debugger` | a `debugger` statement anywhere |
   | `no-focused-tests` | `describe/it/test/suite/bench(.x)*.only` in a test |
   | `no-unexplained-skip` | `.skip(` in a test without a comment on the same or the previous line. `.skipIf()` and `.runIf()` are allowed. |
   | `no-console-log` | `console.log/info/debug/trace/dir/table` in `packages/*/src`. `console.error` and `console.warn` are allowed for error paths, and the CLI is exempt. Escape hatch: `// lint-allow-console: <reason>`. |
   | `no-external-urls` | an `http(s)://` or `ws(s)://` URL in `packages/*/src` whose host is not loopback. Allowed: URLs in comments, links to documentation hosts, dynamic hosts (covered by the runtime tests) and simulated tool inputs in the demo scenario. Escape hatch: `// lint-allow-url: <reason>`. |
   | `no-ts-suppress` | `@ts-ignore` or `@ts-nocheck` (use `@ts-expect-error <reason>`) |

3. **Documentation and repository hygiene.**

   | Rule | What fails |
   | --- | --- |
   | `docs-links` | a relative link or image path in `README.md`, `CONTRIBUTING.md`, `docs/**/*.md` or `packages/*/README.md` that does not resolve to a file with the exact letter case, or that points into `node_modules` or build output. `--anchors` also checks `#fragments` against the target's headings. |
   | `no-internal-notes` | development-process markers left in sources, scripts, docs and manifests |

Options: `--rules-only`, `--tsc-only`, `--anchors`, `--json` (machine-readable) and `--root <dir>` (lint another tree). Exit codes: 0 clean, 1 findings, 2 internal error.

### Unit and integration tests

`npm test` (`vitest run`) runs four projects: `core`, `monitor`, `ui` (jsdom) and `vscode-extension`. Monitor tests start real monitors on ephemeral ports with temporary home directories. Highlights:

- `packages/core/test/state.test.ts`: the reducer: session lifecycle, permissions, failures and interrupts, out-of-order delivery, nested subagents, concurrent sessions, tasks and teammates, discovery sources, staleness, restore and pruning.
- `packages/monitor/test/server.test.ts`, `lifecycle.integration.test.ts`: HTTP security (Host, Origin, token), WebSocket mirrors, the demo scenario end to end, the hook forwarder process, persistence, slow transcript I/O, read-only discovery and the subagent lifecycle through the real monitor.
- `packages/monitor/test/hooks.test.ts`, `dedupe.test.ts`: the hook installer (only passive handlers, backups, user hooks preserved) and duplicate-scope handling.
- `packages/monitor/test/staticNoInference.test.ts`, `inference.test.ts`, `zeroTokenRuntime.test.ts`, `packages/ui/test/zeroTokenUi.test.ts`, `zeroTokenApp.test.tsx`: the zero-inference guarantee (see [ZERO_TOKEN.md](ZERO_TOKEN.md)).
- `packages/ui/test/dialogue.test.ts`: every template line follows the content rules and is listed verbatim in [SIMULATION.md](SIMULATION.md).

### Performance tests

These are bounded to a few seconds each. Thresholds are generous so that a slow CI machine passes; each test prints one line of measurements (`[perf:core] …`, `[perf:monitor] …`, `[perf:ui] …`). Use `--reporter=verbose` to see them.

| File | What it checks |
| --- | --- |
| `packages/core/test/perf.test.ts` | Reducer throughput on about 54k events over 50 concurrent sessions (150 agents). Per-event cost stays flat over time because history is capped. Caps hold: tools ≤ 60 per agent, log ≤ 1500, notices ≤ 200, pending spawns ≤ 20. The agent table goes back under `maxAgents` (400) on Tick, live agents are never dropped, and after the prune window only live agents and their tasks remain. Also measures per-event cost on a full state at 50, 200 and 400 agents. |
| `packages/monitor/test/perf.test.ts` | HTTP ingest of a burst of 3,075 events (25 ordered sessions posting concurrently) with 6 WebSocket clients. Every client converges to a state deep-equal to the monitor's, with zero sequence gaps, with and without the default plugins. Also measures snapshot size and latency at 300 agents. |
| `packages/ui/test/perf.test.ts` | `filterAgents`, `toWorkerViews` and `workspaceOptions` with 300 agents; `OfficeStore` applying 2,000 live events in batches of 20 without a resync; `IdleDirector.tick` with 200 actors over 1,500 ticks with real status flips. |

### Zero-token runtime test: `packages/monitor/test/zeroTokenRuntime.test.ts`

This test runs in-process. It installs spies on `child_process` (`spawn`, `exec`, `execFile`, `fork` and their Sync variants), `http`/`https` `request`/`get`, `net.connect`/`createConnection`, `tls.connect`, global `fetch` and global `WebSocket`. The spies go in before the monitor modules are imported, and `syncBuiltinESMExports()` makes ESM named imports and module-level `promisify(execFile)` go through them too.

Positive controls prove the spies see ESM-imported built-ins, `fetch` and `http`. The test then runs `defaultPlugins()` twice, once with discovery off and once with discovery on against a temporary Claude directory that holds a registry entry, a transcript and subagent metadata. Each run:

1. ingests 12 full runs of the demo scenario;
2. posts a burst of about 3,000 events over HTTP while one WebSocket client disconnects, another joins mid-burst and requests a resync, and a third reconnects;
3. calls every RPC route the plugins register (`inference.diagnostics`, `usage.summary`, `usage.session`, `history.sessions`, `history.events`, `history.summary`, `git.repos`, `git.status`) directly, over WebSocket and over HTTP;
4. waits through 1.5 s of 100 ms ticks plus the registry, transcript, meta and spool timers.

It asserts: no process launch other than `git` and no Claude launch; no non-loopback connection; the reconnected client deep-equals the monitor state; no sequence gaps; `officeInferenceCalls` and `externalRequests` stay at 0; no plugin failed to start or stop. `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and `AGENT_OFFICE_HOME` point to a sandbox for the whole file, and the spies are restored afterwards.

### Zero-token browser end-to-end test: `scripts/e2e-zero-token.cjs`

```bash
npm run build                 # the e2e uses packages/monitor/dist and packages/ui/dist
npm run e2e:zero-token        # about 2.5 minutes with the default 90 s idle window
```

1. Starts an isolated monitor child process (`cli.cjs start --port <free> --home <temp> --no-discovery`) whose environment has a temporary `AGENT_OFFICE_HOME`, `CLAUDE_CONFIG_DIR` and `USERPROFILE`/`HOME`, with Anthropic and Claude credentials removed. It waits for `/api/health`.
2. Sends SIMULATED traffic with `cli.cjs simulate --port <port> --linger <s>`.
3. Opens `http://127.0.0.1:<port>/` in headless Edge. Every request is intercepted at the context level (`context.route('**')`, aborting anything that is not loopback); context `request` events, CDP `Network.requestWillBeSent` and `webSocketCreated`, and page `websocket` and `worker` events are recorded too.
4. Clicks every tab (Office, Tasks, Errors, Git, Analytics, History, Team, Settings), checks that each becomes `aria-current="page"` and renders content.
5. Clicks a worker on the canvas (its screen position comes from `window.__officeScene`) and checks that the inspector opens.
6. Waits for the scenario to finish, then stays idle. Page CPU is the CDP `Performance.getMetrics` `TaskDuration` delta divided by wall time; the JS heap is measured after a forced GC at both ends. Idle-life activities are sampled.
7. Asserts zero non-loopback and zero inference-host requests, no page errors, no CSP violations, `officeInferenceCalls === 0` and `externalRequests === 0` (read from `/api/state` with the temporary token), that simulated agents arrived, that the monitor is still alive, and that the interception was not vacuous (at least 3 routed requests and 1 WebSocket).
8. Prints a JSON summary and exits 0 on pass, 1 on failure or 2 on a setup error (missing build or Edge). It always stops its child processes and removes the temporary directory.

| Variable | Effect |
| --- | --- |
| `E2E_IDLE_SECONDS` | Idle window length (default 90) |
| `E2E_LINGER_SECONDS` | How long the simulated sessions linger (default idle + 120) |
| `E2E_MAX_IDLE_CPU` | Maximum idle main-thread CPU share (default 0.85) |
| `E2E_MAX_HEAP_GROWTH_MB` | Maximum heap growth (default 64) |
| `E2E_HIDDEN_SECONDS` | CPU measurement with another tab open (default 15, 0 = off) |
| `E2E_FPS_EXPERIMENT_SECONDS` | Opt-in experiments: the visible office with the ticker capped at 30 fps, the hidden office with the ticker stopped |
| `E2E_SCREENSHOT` | Path for a screenshot of the final page |
| `E2E_KEEP_TEMP=1` | Keep the temporary directory |
| `E2E_HEADED=1` | Show the browser |

### Smoke tests and the publish audit

- `npm run smoke:webview` serves the webview build under the extension's Content Security Policy in headless Edge, stubs `acquireVsCodeApi`, and feeds it the snapshot of the monitor named by `AGENT_OFFICE_HOME`/`config.json`. To keep it away from your own monitor, start a throwaway one first (`npx agent-office start --port <p> --home <tmp> --no-discovery`) and run the smoke test with `AGENT_OFFICE_HOME=<tmp>`.
- `npm run smoke:extension` activates the bundled extension against a mock `vscode` API.
- `npm run audit:publish -- "extra term" …` lists the files git would publish (using a temporary `GIT_DIR`, so no repository is created in the project) and scans them for secret-shaped strings, local paths, the OS username, the local token and any extra terms you pass.

### Screenshot capture: `scripts/capture-screenshots.cjs`

`node scripts/capture-screenshots.cjs [--out docs/assets/screenshots] [--no-gif] [--only name,name]` regenerates the README images from the built app. Like the e2e test, it starts an isolated monitor (temporary home, Claude config directory and profile, free port, `--no-discovery`) and drives headless Edge with every non-loopback request aborted. It feeds the **showcase** demo scenario (`agent-office simulate --scenario showcase`). It waits for each state through `window.__officeScene` and `window.__officeStore` and skips (and reports) any shot whose state does not occur in time, so it never stages UI. GIFs are recorded from the browser's own screencast and encoded by the script itself (GIF89a, median-cut palette, LZW), with no extra dependencies.

## Measured results

### Test suite

| Command | Result |
| --- | --- |
| `npm run typecheck` | core, monitor, ui and vscode-extension: all exit 0 |
| `npm run lint` | clean: strict TypeScript in all 4 packages plus the repository rules |
| `npm test` | 45 files, 650 tests passed (core 115, monitor 121, ui 406, vscode-extension 8) |
| `npm run e2e:zero-token` (90 s idle, 15 s hidden) | **PASS** |
| `npm run smoke:webview` (throwaway monitor on another port, temporary home, showcase demo) | **PASS**: 11 agent rows, no problems |
| `npm run smoke:extension` | **PASS** |
| `npm run audit:publish` | 195 publishable files: no secrets, local paths, usernames or tokens (6 lines listed for review, all fake redaction-test fixtures) |
| `npm run package:vsix` | `agent-office.vsix`, 55 files, 561 KB, including LICENSE, third-party notices and the licence texts of every bundled package and font |
| Clean install of the publishable files (temporary directory) | `npm ci --prefer-offline` 21 s, `npm run build` 7 s, typecheck, lint and `npm test` pass; `npx agent-office` prints a build hint before the first build and works after it; the monitor started from the copy with an isolated home served the office and needed no API key or account |

### Browser end-to-end details

- **Tabs and click:** all 8 tabs became active and rendered; the canvas worker click opened the inspector on the first attempt.
- **Network:** **0 external and 0 inference requests** (12 routed requests, 19 seen by CDP, 1 WebSocket with 94 frames).
- **Errors:** 0 page errors, 0 CSP violations, 0 console errors.
- **Runtime guard:** active, `officeInferenceCalls` 0, `externalRequests` 0, process launches: git 0, browser 0, other 0.
- **Idle office (visible):** main-thread CPU share 0.159 (script 0.071) with 5 workers; the ticker ran at about 8 fps because software rendering is GPU-bound. Heap 11.0 → 11.5 MB after GC; event listeners 219 → 213 (no growth). Simulated activities seen: a group break, a snack, a walk.
- **Hidden office** (Settings tab open): CPU share 0.028, because the scene stops its ticker while another view is shown.
- **Busy window** (scenario plus tab clicks): CPU share 0.170.

### Performance measurements

| Measurement | Result |
| --- | --- |
| Normalize 54,475 hook payloads | 221 ms |
| Reduce 54,475 events, 150 agents | about 1.1 s, roughly **50,000 events/s** (20 µs per event); 10k-event chunks took 175–228 ms, so cost does not grow with history |
| Reduce 14,375 events, 750 agents | about 186 µs per event |
| One event on a full state (log 1500, notices 200) | 50 agents: 12 µs · 200 agents: 26 µs · 400 agents: 93 µs |
| Agent cap on Tick | 750 → 400 agents, then 125 live agents after the prune window; tasks 1000 → 500; Tick takes 1.5 ms |
| Monitor HTTP burst (3,075 events, 25 concurrent sessions, 6 WebSocket clients) | about 2,000 requests/s without plugins and 2,200 with the default plugins; all clients converged within 1.6 s with 0 gaps and 0 duplicates |
| Snapshot at 300 agents (26,400 events) | 3.1 MB; `JSON.stringify` 25 ms, `GET /api/state` 66 ms, WebSocket snapshot 61 ms |
| UI with 300 agents (average / p95) | `filterAgents(all)` 0.09 / 0.13 ms · `filterAgents(workspace)` 1.76 / 4.7 ms · `toWorkerViews` 0.75 / 1.19 ms · `workspaceOptions` 0.62 / 1.09 ms |
| `OfficeStore`, 2,000 live events in 100 batches | 1.9 ms per batch on average (p95 3.3 ms), exact convergence, no resync |
| `IdleDirector.tick`, 200 actors, 1,500 ticks | 0.40 ms average, p95 0.80 ms; all activity kinds occurred, at most 32 of 200 away at once |
| Office scene `frame()` with 5–6 workers | about 1.4 ms of JavaScript per frame (sprite canvases are CPU-backed, so building a sprite never forces a GPU readback) |
| Zero-token runtime, both discovery modes | 6,328 `http.request`, 48 `net.connect`/`createConnection`, 2 `fetch`, 1 `execFile` (git), all loopback; guard: 0 inference calls, 0 external requests |

### Known performance limitations

- The React root re-renders once per second (a shared clock for relative times), which accounts for part of the idle CPU.
- The monitor writes `state.json` synchronously (atomic rename) at most every 2 s while events flow; a 3 MB state takes about 25 ms to serialise.
- Static floor, wall and furniture layers are redrawn every frame rather than cached as textures. The default frame rate is 30 fps (Settings → Animation FPS).
- Per-event reducer cost grows with the number of agents (about 90 µs per event at 400 agents).
- The full-state snapshot grows with agent history: about 3 MB at 300 agents. It would pass the 8 MB slow-consumer limit at roughly 750 agents with full histories.

## Limits of these checks

- **Browser CPU.** The e2e measures main-thread `TaskDuration` in the renderer only. Raster and GPU work happen in the GPU process, and under headless SwiftShader the visible office is GPU-bound at about 8–15 fps, so visible-office CPU here understates a real GPU browser running at 30–60 fps.
- **Walking speed in headless runs.** The scene caps its time step at 100 ms per frame, so under slow software rendering workers walk a little slower than on a real GPU. Screenshot timing accounts for this.
- **Network coverage.** The e2e covers requests made by the page. Edge's own browser-level background traffic is reduced with `--disable-background-networking` and related switches, but it is outside the page and not asserted on. Process-level coverage comes from `zeroTokenRuntime.test.ts` (in-process) and from the runtime guard counters of the e2e's monitor child, read through `/api/state`.
- **Spy reach.** The runtime spies see everything that goes through the public built-in module objects and globals. They cannot see native addons or `process.binding`; neither is used in the codebase, and the static scan covers imports.
- **Scene internals.** The canvas worker click and the screenshot timing rely on scene internals (`__officeScene.app`, `.workers`, `node.toGlobal`, `debugSnapshot()`). If those are renamed, the scripts fail loudly instead of falling back silently.
- **Thresholds** are intentionally generous to avoid flaky CI; a regression shows first in the printed numbers.
