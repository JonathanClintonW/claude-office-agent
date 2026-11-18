/**
 * End-to-end zero-token check in a real browser (installed Microsoft Edge, headless).
 *
 *  1. Starts an ISOLATED monitor (temp AGENT_OFFICE_HOME, CLAUDE_CONFIG_DIR and user profile, free port,
 *     --no-discovery) and sends SIMULATED traffic with `cli.cjs simulate --linger <s>`.
 *  2. Opens the UI and records every request (context.route('**'), 'request' events, CDP Network) and
 *     WebSocket (page events, CDP webSocketCreated). Non-loopback requests are aborted and counted.
 *  3. Clicks every nav tab and a worker on the canvas (via window.__officeScene), then stays idle.
 *  4. Asserts zero non-loopback and inference-host requests, no page errors or CSP violations, and
 *     meta.plugins.inference.officeInferenceCalls === 0 (when exposed).
 *  5. Measures idle page CPU (CDP TaskDuration delta / wall time), JS heap after GC, DOM nodes, listeners
 *     and DOM mutations per second by component; prints a JSON summary, exits non-zero on failure.
 *  Child processes and the temp dir are always cleaned up.
 *
 * Usage: node scripts/e2e-zero-token.cjs        (npm run e2e:zero-token)
 * Needs: packages/monitor/dist and packages/ui/dist (npm run build), Microsoft Edge.
 * Env:
 *   E2E_IDLE_SECONDS        idle window length (default 90)
 *   E2E_LINGER_SECONDS      how long simulated sessions stay idle (default idle + 120)
 *   E2E_MAX_IDLE_CPU        max main-thread busy share during idle, 0..1 (default 0.85)
 *   E2E_MAX_HEAP_GROWTH_MB  max JS heap growth over the idle window after GC (default 64)
 *   E2E_HIDDEN_SECONDS      also measure CPU this long with another tab open (office canvas hidden; default 15, 0 = off)
 *   E2E_FPS_EXPERIMENT_SECONDS  optional: measure idle CPU this long with the Pixi ticker capped at 30 fps
 *                           (runtime-only experiment in the page; default 0 = off)
 *   E2E_SCREENSHOT          write a PNG of the final page here
 *   E2E_KEEP_TEMP=1         keep the temp dir (for debugging)
 *   E2E_HEADED=1            show the browser
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const CLI = path.join(root, 'packages', 'monitor', 'dist', 'cli.cjs');
const UI_INDEX = path.join(root, 'packages', 'ui', 'dist', 'index.html');
const IDLE_SECONDS = num('E2E_IDLE_SECONDS', 90);
const LINGER_SECONDS = num('E2E_LINGER_SECONDS', IDLE_SECONDS + 120);
const MAX_IDLE_CPU = num('E2E_MAX_IDLE_CPU', 0.85);
const MAX_HEAP_GROWTH_MB = num('E2E_MAX_HEAP_GROWTH_MB', 64);
const HIDDEN_SECONDS = num('E2E_HIDDEN_SECONDS', 15);
const FPS_EXPERIMENT_SECONDS = num('E2E_FPS_EXPERIMENT_SECONDS', 0);
const TABS = ['Office', 'Tasks', 'Errors', 'Git', 'Analytics', 'History', 'Team', 'Settings'];
/** Hosts through which model inference is reachable (Anthropic, Claude apps, Bedrock, Vertex, Foundry, OpenAI). */
const INFERENCE_HOST = /(^|\.)(anthropic\.com|claude\.ai|claude\.com|openai\.com)$|bedrock|aiplatform\.googleapis\.com|vertex|claude|anthropic|services\.ai\.azure\.com/i;
const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:']);

function num(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

const log = (...a) => console.error('[e2e]', ...a);

function isLoopbackHost(h) {
  const x = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  return x === 'localhost' || x === '::1' || /^127\.\d+\.\d+\.\d+$/.test(x);
}

/** { network, loopback, inference, host } for a URL string. */
function classifyUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { network: false, loopback: true, inference: false, host: '' };
  }
  if (!NETWORK_PROTOCOLS.has(u.protocol)) return { network: false, loopback: true, inference: false, host: u.protocol };
  const host = u.hostname.toLowerCase();
  return { network: true, loopback: isLoopbackHost(host), inference: INFERENCE_HOST.test(host), host };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function get(port, p, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers }, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Child process with captured output; `alive()` until it exits. */
function child(name, args, env) {
  const p = spawn(process.execPath, args, { env, cwd: env.AGENT_OFFICE_HOME, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const out = [];
  const keep = (c) => {
    out.push(String(c));
    if (out.length > 400) out.splice(0, out.length - 400);
  };
  p.stdout.on('data', keep);
  p.stderr.on('data', keep);
  const exited = new Promise((r) => p.once('exit', (code, signal) => r({ code, signal })));
  return { name, p, out, exited, alive: () => p.exitCode === null && p.signalCode === null };
}

async function stopChild(c) {
  if (!c || !c.alive()) return;
  c.p.kill();
  const done = await Promise.race([c.exited, sleep(5000).then(() => null)]);
  if (done === null && c.alive() && process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(c.p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await Promise.race([c.exited, sleep(3000)]);
  }
}

async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

/** Main-thread busy share and ticker FPS over a window of `seconds` (page left untouched meanwhile). */
async function cpuWindow(page, cdp, seconds) {
  const fps = [];
  const m0 = await metrics(cdp);
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await page.waitForTimeout(Math.min(2500, Math.max(0, end - Date.now())));
    const f = await page.evaluate(() => (window.__officeScene && window.__officeScene.app && window.__officeScene.app.ticker ? window.__officeScene.app.ticker.FPS : null)).catch(() => null);
    if (typeof f === 'number') fps.push(f);
  }
  const m1 = await metrics(cdp);
  const wall = m1.Timestamp - m0.Timestamp;
  return {
    wallSeconds: Math.round(wall * 10) / 10,
    cpuTaskShare: Math.round(((m1.TaskDuration - m0.TaskDuration) / wall) * 1000) / 1000,
    scriptShare: Math.round(((m1.ScriptDuration - m0.ScriptDuration) / wall) * 1000) / 1000,
    tickerFps: fps.length ? Math.round(fps.reduce((s, x) => s + x, 0) / fps.length) : null,
  };
}

async function main() {
  const missing = [CLI, UI_INDEX].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(`e2e-zero-token: build output missing:\n  ${missing.join('\n  ')}\nRun "npm run build" first.`);
    return 2;
  }
  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch (e) {
    console.error(`e2e-zero-token: playwright-core is not installed (${e.message}).`);
    return 2;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-e2e-'));
  const dirs = { home: path.join(tmp, 'office-home'), claude: path.join(tmp, 'claude'), user: path.join(tmp, 'user') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  // Isolated environment: no real ~/.claude, ~/.agent-office or user profile; no credentials to misuse.
  const env = { ...process.env, AGENT_OFFICE_HOME: dirs.home, CLAUDE_CONFIG_DIR: dirs.claude, USERPROFILE: dirs.user, HOME: dirs.user };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/.test(k)) delete env[k];

  const summary = { ok: false, port: 0, idleSeconds: IDLE_SECONDS, failures: [], warnings: [] };
  const fail = (msg) => summary.failures.push(msg);
  let monitor;
  let sim;
  let browser;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await Promise.race([browser ? browser.close() : Promise.resolve(), sleep(10_000)]);
    } catch {
      /* already gone */
    }
    await stopChild(sim);
    await stopChild(monitor);
    if (process.env.E2E_KEEP_TEMP === '1') log(`temp dir kept: ${tmp}`);
    else {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (e) {
        log(`could not remove ${tmp}: ${e.message}`);
      }
    }
  };
  const onSignal = () => {
    log('interrupted, cleaning up');
    cleanup().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const watchdog = setTimeout(() => {
    log('global timeout, cleaning up');
    cleanup().finally(() => process.exit(1));
  }, (IDLE_SECONDS + HIDDEN_SECONDS + 2 * FPS_EXPERIMENT_SECONDS + 300) * 1000);

  try {
    const port = await freePort();
    summary.port = port;
    monitor = child('monitor', [CLI, 'start', '--port', String(port), '--home', dirs.home, '--no-discovery'], env);
    const t0 = Date.now();
    for (;;) {
      if (!monitor.alive()) throw new Error(`monitor exited early:\n${monitor.out.join('')}`);
      const h = await get(port, '/api/health');
      if (h.status === 200 && h.body.includes('"agent-office"')) break;
      if (Date.now() - t0 > 20_000) throw new Error(`monitor did not answer /api/health within 20 s:\n${monitor.out.join('')}`);
      await sleep(200);
    }
    summary.monitorStartMs = Date.now() - t0;
    const token = JSON.parse(fs.readFileSync(path.join(dirs.home, 'config.json'), 'utf8')).token;
    const state = async () => {
      const r = await get(port, '/api/state', { 'x-agent-office-token': token });
      return r.status === 200 ? JSON.parse(r.body) : undefined;
    };

    sim = child('simulate', [CLI, 'simulate', '--port', String(port), '--linger', String(LINGER_SECONDS)], env);
    log(`monitor on ${port}; SIMULATED traffic started (linger ${LINGER_SECONDS}s)`);

    try {
      browser = await chromium.launch({
        channel: 'msedge',
        headless: process.env.E2E_HEADED !== '1',
        args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--disable-sync'],
      });
    } catch (e) {
      summary.setupError = `could not launch Microsoft Edge (channel msedge): ${e.message.split('\n')[0]}`;
      throw new Error(summary.setupError);
    }
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
    const seen = []; // every URL any layer observed: { url, via, type }
    const blocked = [];
    const record = (url, via, type) => seen.push({ url, via, type });
    await context.route('**', (route) => {
      const req = route.request();
      record(req.url(), 'route', req.resourceType());
      const c = classifyUrl(req.url());
      if (c.network && !c.loopback) {
        blocked.push(req.url());
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    context.on('request', (req) => record(req.url(), 'request', req.resourceType()));
    context.on('serviceworker', (w) => record(w.url(), 'serviceworker', 'serviceworker'));
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const csp = [];
    let websockets = 0;
    let wsFrames = 0;
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('crash', () => pageErrors.push('page crashed'));
    page.on('console', (m) => {
      const text = m.text();
      if (/Content Security Policy|Refused to (connect|load|execute|frame)/i.test(text)) csp.push(text);
      else if (m.type() === 'error') consoleErrors.push(text);
    });
    page.on('websocket', (ws) => {
      websockets += 1;
      record(ws.url(), 'websocket', 'websocket');
      ws.on('framereceived', () => (wsFrames += 1));
      ws.on('framesent', () => (wsFrames += 1));
    });
    page.on('worker', (w) => record(w.url(), 'worker', 'worker'));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
    cdp.on('Network.requestWillBeSent', (e) => record(e.request.url, 'cdp', e.type || 'other'));
    cdp.on('Network.webSocketCreated', (e) => record(e.url, 'cdp-websocket', 'websocket'));

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForFunction(() => Boolean(window.__officeScene && window.__officeStore), null, { timeout: 30_000 });
    await page.waitForFunction(
      () => {
        const s = window.__officeStore.getSnapshot();
        return s.synced && s.connection === 'open' && Object.keys(s.state.agents).some((k) => k.startsWith('sim-'));
      },
      null,
      { timeout: 30_000 },
    );
    const loaded = await metrics(cdp);

    summary.tabs = [];
    for (const label of [...TABS.slice(1), TABS[0]]) {
      const before = pageErrors.length;
      const btn = page.locator('button.navtab').filter({ hasText: new RegExp(`^\\s*${label}`) }).first();
      let active = false;
      let rendered = false;
      try {
        await btn.click({ timeout: 5000 });
        await page.waitForTimeout(1200);
        active = (await btn.getAttribute('aria-current')) === 'page';
        rendered =
          label === 'Office'
            ? await page.locator('section.office:not([hidden]) canvas').count().then((n) => n > 0)
            : await page.locator('section.stage-page').innerText({ timeout: 2000 }).then((t) => t.trim().length > 0, () => false);
      } catch (e) {
        summary.warnings.push(`tab ${label}: ${e.message.split('\n')[0]}`);
      }
      summary.tabs.push({ label, active, rendered, newPageErrors: pageErrors.length - before });
      if (!active) fail(`nav tab "${label}" did not become active`);
      if (!rendered) fail(`nav tab "${label}" rendered nothing`);
    }

    summary.workerClick = { ok: false };
    for (let attempt = 1; attempt <= 12 && !summary.workerClick.ok; attempt++) {
      const target = await page.evaluate(() => {
        const s = window.__officeScene;
        const app = s && s.app;
        const workers = s && s.workers;
        if (!app || !(workers instanceof Map)) return { error: 'scene internals changed (app/workers not found)' };
        const r = app.canvas.getBoundingClientRect();
        const sw = app.renderer.screen.width;
        const sh = app.renderer.screen.height;
        const list = [...workers.values()].filter((w) => !w.leaving && w.node && w.node.visible && (!w.path || w.path.length === 0));
        list.sort((a, b) => Number(b.phase === 'seated') - Number(a.phase === 'seated'));
        for (const w of list) {
          const p = w.node.toGlobal({ x: 0, y: -10 });
          const x = r.left + (p.x * r.width) / sw;
          const y = r.top + (p.y * r.height) / sh;
          if (x > r.left + 2 && x < r.right - 2 && y > r.top + 2 && y < r.bottom - 2) return { key: w.view.key, name: w.view.name, x, y };
        }
        return { error: `no clickable worker among ${workers.size}` };
      });
      if (target.error) {
        summary.workerClick.lastError = target.error;
        await page.waitForTimeout(500);
        continue;
      }
      await page.mouse.move(target.x, target.y);
      await page.mouse.down();
      await page.mouse.up();
      try {
        await page.waitForSelector('section.inspector', { timeout: 2000 });
        summary.workerClick = { ok: true, method: 'canvas', attempts: attempt, key: target.key, inspector: await page.getAttribute('section.inspector', 'aria-label') };
      } catch {
        summary.workerClick.lastError = `click at ${Math.round(target.x)},${Math.round(target.y)} on ${target.key} opened no inspector`;
        await page.waitForTimeout(300);
      }
    }
    if (!summary.workerClick.ok) fail(`could not select a worker on the canvas: ${summary.workerClick.lastError}`);

    // Let the scripted scenario finish so the simulated sessions are really idle.
    await page
      .waitForFunction(
        () => {
          const a = Object.values(window.__officeStore.getSnapshot().state.agents).filter((x) => x.kind === 'session' && x.sessionId.startsWith('sim-'));
          return a.length >= 3 && a.every((x) => !['working', 'waiting_permission', 'waiting_input'].includes(x.status));
        },
        null,
        { timeout: 45_000 },
      )
      .catch(() => summary.warnings.push('simulated sessions were still active when the idle window started'));
    // DOM churn while idle (a proxy for React re-renders that reach the DOM), by component.
    await page.evaluate(() => {
      const by = {};
      const label = (n) => {
        const el = n && n.nodeType === 1 ? n : n && n.parentElement;
        const host = el && el.closest('[aria-label],[data-testid],[class]');
        if (!host) return 'other';
        const name = host.getAttribute('data-testid') || host.getAttribute('aria-label') || String(host.className).split(/s+/)[0];
        return `${host.tagName.toLowerCase()}:${String(name).slice(0, 40)}`;
      };
      const state = { records: 0, by };
      const mo = new MutationObserver((list) => {
        state.records += list.length;
        for (const r of list) {
          const k = label(r.target);
          by[k] = (by[k] || 0) + 1;
        }
      });
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      window.__e2eMutations = { state, stop: () => mo.disconnect() };
    });
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    const idle0 = await metrics(cdp);
    const activities = new Set();
    const fps = [];
    let maxAway = 0;
    const idleEnd = Date.now() + IDLE_SECONDS * 1000;
    log(`idle window: ${IDLE_SECONDS}s`);
    while (Date.now() < idleEnd) {
      await page.waitForTimeout(Math.min(5000, Math.max(0, idleEnd - Date.now())));
      const probe = await page
        .evaluate(() => {
          const s = window.__officeScene;
          if (!s || !(s.workers instanceof Map)) return { kinds: [], away: 0, fps: null };
          const ws = [...s.workers.values()];
          return { kinds: ws.map((w) => w.perform && w.perform.activity).filter(Boolean), away: ws.filter((w) => w.perform).length, fps: s.app && s.app.ticker ? s.app.ticker.FPS : null };
        })
        .catch(() => ({ kinds: [], away: 0, fps: null }));
      for (const k of probe.kinds) activities.add(k);
      maxAway = Math.max(maxAway, probe.away);
      if (typeof probe.fps === 'number') fps.push(probe.fps);
    }
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    const idle1 = await metrics(cdp);
    const mutations = await page
      .evaluate(() => {
        const m = window.__e2eMutations;
        if (!m) return null;
        m.stop();
        return m.state;
      })
      .catch(() => null);
    const wall = idle1.Timestamp - idle0.Timestamp;
    const share = (k) => Math.round(((idle1[k] - idle0[k]) / wall) * 1000) / 1000;
    summary.idle = {
      wallSeconds: Math.round(wall * 10) / 10,
      cpuTaskShare: share('TaskDuration'),
      scriptShare: share('ScriptDuration'),
      layoutShare: share('LayoutDuration'),
      recalcStyleShare: share('RecalcStyleDuration'),
      heapUsedMBStart: Math.round((idle0.JSHeapUsedSize / 1048576) * 10) / 10,
      heapUsedMBEnd: Math.round((idle1.JSHeapUsedSize / 1048576) * 10) / 10,
      heapGrowthMB: Math.round(((idle1.JSHeapUsedSize - idle0.JSHeapUsedSize) / 1048576) * 10) / 10,
      domNodesStart: idle0.Nodes,
      domNodesEnd: idle1.Nodes,
      listenersStart: idle0.JSEventListeners,
      listenersEnd: idle1.JSEventListeners,
      idleLifeActivitiesSeen: [...activities].sort(),
      maxWorkersAwayAtOnce: maxAway,
      workers: await page.evaluate(() => (window.__officeScene && window.__officeScene.workers instanceof Map ? window.__officeScene.workers.size : null)).catch(() => null),
      sceneDisplayObjects: await page
        .evaluate(() => {
          const app = window.__officeScene && window.__officeScene.app;
          if (!app) return null;
          let n = 0;
          const walk = (c) => {
            n += 1;
            for (const k of c.children || []) walk(k);
          };
          walk(app.stage);
          return n;
        })
        .catch(() => null),
      tickerFps: fps.length ? Math.round(fps.reduce((s, x) => s + x, 0) / fps.length) : null,
      domMutationsPerSecond: mutations ? Math.round((mutations.records / wall) * 10) / 10 : null,
      domMutationsTop: mutations
        ? Object.entries(mutations.by)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([k, n]) => `${k} ${Math.round((n / wall) * 10) / 10}/s`)
        : null,
    };
    const busyWall = idle0.Timestamp - loaded.Timestamp;
    summary.busyWindow = { wallSeconds: Math.round(busyWall * 10) / 10, cpuTaskShare: Math.round(((idle0.TaskDuration - loaded.TaskDuration) / busyWall) * 1000) / 1000 };
    if (summary.idle.cpuTaskShare > MAX_IDLE_CPU) fail(`idle main-thread CPU ${summary.idle.cpuTaskShare} > ${MAX_IDLE_CPU}`);
    if (summary.idle.heapGrowthMB > MAX_HEAP_GROWTH_MB) fail(`JS heap grew ${summary.idle.heapGrowthMB} MB during the idle window (> ${MAX_HEAP_GROWTH_MB})`);
    if (IDLE_SECONDS >= 60 && activities.size === 0) summary.warnings.push('no idle-life activity observed during the idle window');

    // Optional: the same idle office with the Pixi ticker capped at 30 fps (runtime-only experiment).
    if (FPS_EXPERIMENT_SECONDS > 0) {
      const capped = await page.evaluate(() => {
        const t = window.__officeScene && window.__officeScene.app && window.__officeScene.app.ticker;
        if (!t) return false;
        t.maxFPS = 30;
        return true;
      });
      if (capped) {
        summary.idleAt30fps = await cpuWindow(page, cdp, FPS_EXPERIMENT_SECONDS);
        await page.evaluate(() => (window.__officeScene.app.ticker.maxFPS = 0));
      }
    }
    // Another tab open: the office stays mounted (hidden) so its simulation is not reset.
    if (HIDDEN_SECONDS > 0) {
      await page.locator('button.navtab').filter({ hasText: /^\s*Settings/ }).first().click();
      await page.waitForTimeout(1000);
      summary.hiddenOffice = { tab: 'Settings', ...(await cpuWindow(page, cdp, HIDDEN_SECONDS)) };
      if (FPS_EXPERIMENT_SECONDS > 0) {
        // Experiment: same hidden office with the Pixi ticker stopped (what a visibility-aware scene would do).
        const stopped = await page.evaluate(() => {
          const t = window.__officeScene && window.__officeScene.app && window.__officeScene.app.ticker;
          if (!t) return false;
          t.stop();
          return true;
        });
        if (stopped) {
          summary.hiddenOfficeTickerStopped = await cpuWindow(page, cdp, Math.min(HIDDEN_SECONDS, FPS_EXPERIMENT_SECONDS));
          await page.evaluate(() => window.__officeScene.app.ticker.start());
        }
      }
      await page.locator('button.navtab').filter({ hasText: /^\s*Office/ }).first().click();
      await page.waitForTimeout(500);
    }

    const st = await state();
    if (!st) fail('GET /api/state failed');
    else {
      const agents = Object.keys(st.state.agents);
      summary.monitorState = { lastSeq: st.state.lastSeq, agents: agents.length, simulatedAgents: agents.filter((k) => k.startsWith('sim-')).length, rejectedEvents: st.meta.rejectedEvents };
      if (!summary.monitorState.simulatedAgents) fail('no simulated agents reached the monitor');
      const inf = st.meta.plugins && st.meta.plugins.inference;
      if (inf && typeof inf.officeInferenceCalls === 'number') {
        summary.inference = { guard: inf.guard, officeInferenceCalls: inf.officeInferenceCalls, externalRequests: inf.externalRequests, loopbackRequests: inf.loopbackRequests, processLaunches: inf.processLaunches };
        if (inf.officeInferenceCalls !== 0) fail(`meta.plugins.inference.officeInferenceCalls = ${inf.officeInferenceCalls}`);
        if (inf.externalRequests !== 0) fail(`meta.plugins.inference.externalRequests = ${inf.externalRequests}`);
      } else {
        summary.inference = 'not exposed by this build';
      }
    }
    if (!monitor.alive()) fail('the monitor process died during the run');

    const classified = seen.map((s) => ({ ...s, ...classifyUrl(s.url) }));
    const network = classified.filter((s) => s.network);
    const external = [...new Set(network.filter((s) => !s.loopback).map((s) => `${s.via}:${s.url}`))];
    const inference = [...new Set(classified.filter((s) => s.inference).map((s) => s.url))];
    const byVia = {};
    for (const s of seen) byVia[s.via] = (byVia[s.via] || 0) + 1;
    summary.network = {
      observed: byVia,
      uniqueUrls: new Set(network.map((s) => s.url.replace(/token=[^&]+/, 'token=***'))).size,
      websockets,
      wsFrames,
      externalRequests: external.length,
      inferenceRequests: inference.length,
      blockedByRoute: blocked.length,
      external: external.slice(0, 20),
    };
    if (external.length) fail(`${external.length} request(s) to non-loopback hosts`);
    if (inference.length) fail(`${inference.length} request(s) to inference hosts`);
    if (!byVia.route || byVia.route < 3) fail('interception saw almost no requests: the check would be vacuous');
    if (!websockets) fail('no WebSocket observed: the check would be vacuous');
    summary.pageErrors = pageErrors;
    summary.cspViolations = csp;
    summary.consoleErrors = consoleErrors.slice(0, 20);
    if (pageErrors.length) fail(`${pageErrors.length} page error(s)`);
    if (csp.length) fail(`${csp.length} CSP violation(s)`);
    if (consoleErrors.length) summary.warnings.push(`${consoleErrors.length} console error(s) (see consoleErrors)`);

    if (process.env.E2E_SCREENSHOT) await page.screenshot({ path: process.env.E2E_SCREENSHOT });
  } catch (e) {
    fail(`aborted: ${e.message}`);
    if (monitor && monitor.out.length) summary.monitorOutputTail = monitor.out.join('').split('\n').slice(-20);
  } finally {
    clearTimeout(watchdog);
    await cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  summary.ok = summary.failures.length === 0;
  console.log(JSON.stringify(summary, null, 2));
  console.log(summary.ok ? 'E2E ZERO-TOKEN PASS' : 'E2E ZERO-TOKEN FAIL');
  return summary.ok ? 0 : summary.setupError ? 2 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
