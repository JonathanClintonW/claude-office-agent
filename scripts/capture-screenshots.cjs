/**
 * Capture the README screenshots (and a few short GIFs) from the real, built app with SIMULATED demo data.
 *
 *  1. Starts an ISOLATED monitor (temp AGENT_OFFICE_HOME, Claude config dir and user profile, free port,
 *     --no-discovery). Your real monitor, ~/.agent-office and Claude Code settings are never touched or shown.
 *  2. Feeds it the `showcase` scenario: via `cli.cjs simulate --scenario showcase` when the built CLI offers
 *     it, otherwise from packages/monitor/src/simulate.ts posted to the hook endpoint exactly as `simulate`
 *     does, and as a last resort four overlapping default `simulate` runs. Demo session ids start with `sim-`.
 *  3. Opens the office in headless Microsoft Edge (non-loopback requests aborted) at `?hour=14` with Idle
 *     frequency High, so idle life starts sooner. Only states that actually occur are captured: a shot whose
 *     state does not show up within its timeout is skipped and reported, never staged.
 *  4. Writes PNGs (and GIF89a animations unless --no-gif) and a JSON summary; always stops its own child
 *     processes and removes its temp directory.
 *
 * Usage: node scripts/capture-screenshots.cjs [--out docs/assets/screenshots] [--no-gif]
 *                                             [--only name,name] [--headed] [--keep-temp]
 * Needs: a build (packages/monitor/dist, packages/ui/dist) and Microsoft Edge. No network.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const CLI = path.join(root, 'packages', 'monitor', 'dist', 'cli.cjs');
const UI_INDEX = path.join(root, 'packages', 'ui', 'dist', 'index.html');
const VIEWPORT = { width: 1440, height: 900 };

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const OUT = path.resolve(root, argOf('--out') ?? path.join('docs', 'assets', 'screenshots'));
const GIFS = !argv.includes('--no-gif');
const ONLY = argOf('--only') ? new Set(argOf('--only').split(',').map((s) => s.trim())) : null;
const HEADED = argv.includes('--headed');
const KEEP_TEMP = argv.includes('--keep-temp');

const log = (...a) => console.error('[capture]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wanted = (name) => !ONLY || ONLY.has(name);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
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

/** Child node process with captured output; `alive()` until it exits. */
function child(name, args, env) {
  const p = spawn(process.execPath, args, { env, cwd: env.AGENT_OFFICE_HOME, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const out = [];
  const keep = (c) => {
    out.push(String(c));
    if (out.length > 200) out.splice(0, out.length - 200);
  };
  p.stdout.on('data', keep);
  p.stderr.on('data', keep);
  const exited = new Promise((r) => p.once('exit', (code, signal) => r({ code, signal })));
  return { name, p, out, exited, alive: () => p.exitCode === null && p.signalCode === null };
}

/** Stop a child this script started (only that PID and its own children). */
async function stopChild(c) {
  if (!c || !c.alive()) return;
  c.p.kill();
  const done = await Promise.race([c.exited, sleep(5000).then(() => null)]);
  if (done === null && c.alive() && process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(c.p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await Promise.race([c.exited, sleep(3000)]);
  }
}

/** POST one hook payload to the isolated monitor, exactly as `agent-office simulate` does. */
function postHook(port, token, payload) {
  const body = JSON.stringify({ v: 1, ts: Date.now(), payload });
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/hook', method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'x-agent-office-token': token } },
      (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      },
    );
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

/**
 * The showcase scenario straight from packages/monitor/src/simulate.ts (transpiled with the
 * project's own esbuild), for builds whose CLI does not offer `simulate --scenario showcase` yet.
 * Returns null when it is not available.
 */
function loadShowcaseFromSource(tmpDir) {
  try {
    const src = fs.readFileSync(path.join(root, 'packages', 'monitor', 'src', 'simulate.ts'), 'utf8');
    if (!/export function buildShowcaseScenario/.test(src)) return null;
    const { transformSync } = require('esbuild');
    const out = path.join(tmpDir, 'simulate-showcase.cjs');
    fs.writeFileSync(out, transformSync(src, { loader: 'ts', format: 'cjs', target: 'node20' }).code);
    const mod = require(out);
    return typeof mod.buildShowcaseScenario === 'function' ? { build: mod.buildShowcaseScenario } : null;
  } catch (e) {
    log(`showcase scenario unavailable from source: ${e.message}`);
    return null;
  }
}

function isLoopbackUrl(raw) {
  try {
    const u = new URL(raw);
    if (!['http:', 'https:', 'ws:', 'wss:', 'ftp:'].includes(u.protocol)) return true;
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return true;
  }
}

// PNG decoding (screenshots → RGBA)

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG (what the browser screenshot produces). */
function decodePng(buf) {
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error('unsupported PNG format');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? rows[dst + x - bpp] : 0;
      const b = y > 0 ? rows[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? rows[dst - stride + x - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rows[dst + x] = (v + pred) & 255;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rows.length; i += bpp, j += 3) {
    rgb[j] = rows[i];
    rgb[j + 1] = rows[i + 1];
    rgb[j + 2] = rows[i + 2];
  }
  return { width, height, rgb };
}

// GIF89a encoding

/** Median-cut palette (≤ maxColors) over a colour histogram. */
function medianCut(hist, maxColors) {
  const colors = [...hist.entries()].map(([c, n]) => ({ r: c >> 16, g: (c >> 8) & 255, b: c & 255, n }));
  if (colors.length <= maxColors) return colors.map((c) => [c.r, c.g, c.b]);
  let boxes = [colors];
  while (boxes.length < maxColors) {
    let best = -1;
    let bestRange = -1;
    let bestCh = 'r';
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (const ch of ['r', 'g', 'b']) {
        let lo = 255;
        let hi = 0;
        for (const c of box) {
          if (c[ch] < lo) lo = c[ch];
          if (c[ch] > hi) hi = c[ch];
        }
        const weight = Math.log2(2 + box.reduce((s, c) => s + c.n, 0));
        if ((hi - lo) * weight > bestRange) {
          bestRange = (hi - lo) * weight;
          best = i;
          bestCh = ch;
        }
      }
    });
    if (best < 0) break;
    const box = boxes[best].sort((x, y) => x[bestCh] - y[bestCh]);
    const total = box.reduce((s, c) => s + c.n, 0);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].n;
      if (acc >= total / 2) {
        cut = i + 1;
        break;
      }
    }
    boxes = [...boxes.slice(0, best), box.slice(0, cut), box.slice(cut), ...boxes.slice(best + 1)];
  }
  return boxes.map((box) => {
    const n = box.reduce((s, c) => s + c.n, 0) || 1;
    return [Math.round(box.reduce((s, c) => s + c.r * c.n, 0) / n), Math.round(box.reduce((s, c) => s + c.g * c.n, 0) / n), Math.round(box.reduce((s, c) => s + c.b * c.n, 0) / n)];
  });
}

/** GIF LZW compression of palette indices (min code size 8), packed into ≤255-byte sub-blocks. */
function lzw(indices) {
  const MIN = 8;
  const CLEAR = 1 << MIN;
  const EOI = CLEAR + 1;
  const out = [];
  let cur = 0;
  let nbits = 0;
  let size = MIN + 1;
  const emit = (code) => {
    cur |= code << nbits;
    nbits += size;
    while (nbits >= 8) {
      out.push(cur & 255);
      cur >>>= 8;
      nbits -= 8;
    }
  };
  let dict = new Map();
  let next = EOI + 1;
  emit(CLEAR);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size += 1;
    } else {
      emit(CLEAR);
      dict = new Map();
      next = EOI + 1;
      size = MIN + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(EOI);
  if (nbits > 0) out.push(cur & 255);
  const blocks = [];
  for (let i = 0; i < out.length; i += 255) {
    const chunk = out.slice(i, i + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return Buffer.from(blocks);
}

/**
 * Encode RGB frames as a looping GIF89a with one global palette (255 colours + transparency).
 * Frames after the first store only the changed rectangle, with unchanged pixels transparent.
 */
function encodeGif(frames, width, height, delaysMs) {
  const TRANSPARENT = 255;
  const hist = new Map();
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 3) {
      // 5 bits per channel for the histogram keeps median cut fast; mapping below uses full colour.
      const key = ((f[i] & 0xf8) << 16) | ((f[i + 1] & 0xf8) << 8) | (f[i + 2] & 0xf8);
      hist.set(key, (hist.get(key) || 0) + 1);
    }
  }
  const palette = medianCut(hist, 255);
  while (palette.length < 256) palette.push([0, 0, 0]);
  const cache = new Map();
  const nearest = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let idx = cache.get(key);
    if (idx !== undefined) return idx;
    let best = Infinity;
    idx = 0;
    for (let i = 0; i < 255; i++) {
      const p = palette[i];
      const d = (p[0] - r) ** 2 * 2 + (p[1] - g) ** 2 * 4 + (p[2] - b) ** 2 * 3;
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    cache.set(key, idx);
    return idx;
  };
  const parts = [];
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0xf7; // global colour table, 8 bits colour resolution, 256 entries
  parts.push(header, Buffer.from(palette.flat()));
  parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, 0x00, 0x00, 0x00]));
  let prev = null;
  frames.forEach((f, n) => {
    const idx = new Uint8Array(width * height);
    for (let i = 0, j = 0; j < idx.length; i += 3, j++) idx[j] = nearest(f[i], f[i + 1], f[i + 2]);
    let x0 = 0;
    let y0 = 0;
    let x1 = width - 1;
    let y1 = height - 1;
    if (prev) {
      x0 = width;
      y0 = height;
      x1 = -1;
      y1 = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const j = y * width + x;
          if (idx[j] !== prev[j]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) x0 = x1 = y0 = y1 = 0; // nothing changed: one transparent pixel
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const sub = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const j = (y0 + y) * width + x0 + x;
        sub[y * w + x] = prev && idx[j] === prev[j] ? TRANSPARENT : idx[j];
      }
    }
    const delay = Math.max(2, Math.round((delaysMs[n] ?? 100) / 10));
    const gce = Buffer.from([0x21, 0xf9, 0x04, prev ? 0x05 : 0x04, delay & 255, delay >> 8, TRANSPARENT, 0x00]);
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(x0, 1);
    desc.writeUInt16LE(y0, 3);
    desc.writeUInt16LE(w, 5);
    desc.writeUInt16LE(h, 7);
    parts.push(gce, desc, Buffer.from([8]), lzw(sub));
    prev = idx;
  });
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

async function main() {
  const missing = [CLI, UI_INDEX].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(`capture-screenshots: build output missing:\n  ${missing.join('\n  ')}\nRun "npm run build" first.`);
    return 2;
  }
  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch (e) {
    console.error(`capture-screenshots: playwright-core is not installed (${e.message}).`);
    return 2;
  }
  fs.mkdirSync(OUT, { recursive: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-shots-'));
  const dirs = { home: path.join(tmp, 'office-home'), config: path.join(tmp, 'claude-config'), user: path.join(tmp, 'user') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, AGENT_OFFICE_HOME: dirs.home, CLAUDE_CONFIG_DIR: dirs.config, USERPROFILE: dirs.user, HOME: dirs.user };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/.test(k)) delete env[k];

  const summary = { ok: false, scenario: '', out: path.relative(root, OUT).replace(/\\/g, '/'), files: [], skipped: [], warnings: [], blockedRequests: 0 };
  let monitor;
  const sims = [];
  let browser;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await Promise.race([browser ? browser.close() : Promise.resolve(), sleep(10_000)]);
    } catch {
      /* already closed */
    }
    for (const s of sims) await stopChild(s);
    await stopChild(monitor);
    if (KEEP_TEMP) log(`temp dir kept: ${tmp}`);
    else {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (e) {
        log(`could not remove the temp dir: ${e.message}`);
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
  }, 15 * 60_000);

  try {
    const port = await freePort();
    monitor = child('monitor', [CLI, 'start', '--port', String(port), '--home', dirs.home, '--no-discovery'], env);
    const t0 = Date.now();
    for (;;) {
      if (!monitor.alive()) throw new Error(`monitor exited early:\n${monitor.out.join('')}`);
      const h = await get(port, '/api/health');
      if (h.status === 200 && h.body.includes('"agent-office"')) break;
      if (Date.now() - t0 > 20_000) throw new Error('monitor did not answer /api/health within 20 s');
      await sleep(200);
    }
    log(`isolated monitor on 127.0.0.1:${port}`);

    browser = await chromium.launch({
      channel: 'msedge',
      headless: !HEADED,
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--disable-sync'],
    });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: 'block', reducedMotion: 'no-preference', colorScheme: 'dark' });
    await context.route('**', (route) => {
      if (isLoopbackUrl(route.request().url())) return route.continue();
      summary.blockedRequests += 1;
      return route.abort('blockedbyclient');
    });
    // A real user setting (Settings → Idle frequency: High), stored where the Settings view stores it.
    await context.addInitScript(() => {
      try {
        if (!localStorage.getItem('agent-office:settings')) localStorage.setItem('agent-office:settings', JSON.stringify({ idleFrequency: 'high' }));
      } catch {
        /* storage unavailable */
      }
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/?hour=14`, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForFunction(() => Boolean(window.__officeScene && window.__officeStore && window.__officeStore.getSnapshot().synced), null, { timeout: 30_000 });
    await page.mouse.move(VIEWPORT.width - 4, 4);

    const help = spawnSync(process.execPath, [CLI, '--help'], { env, encoding: 'utf8', windowsHide: true });
    const cliShowcase = /--scenario\b/.test(`${help.stdout}${help.stderr}`) && /showcase/.test(`${help.stdout}${help.stderr}`);
    const source = cliShowcase ? null : loadShowcaseFromSource(tmp);
    const showcase = cliShowcase || Boolean(source);
    summary.scenario = cliShowcase ? 'showcase (cli simulate --scenario showcase)' : source ? 'showcase (simulate.ts source, posted to /api/hook)' : 'default (4 overlapping cli simulate runs)';
    const linger = 600;
    const simArgs = (extra) => [CLI, 'simulate', '--port', String(port), '--home', dirs.home, '--linger', String(linger), ...extra];
    const simStart = Date.now();
    if (cliShowcase) sims.push(child('simulate', simArgs(['--scenario', 'showcase']), env));
    else if (source) {
      const token = JSON.parse(fs.readFileSync(path.join(dirs.home, 'config.json'), 'utf8')).token;
      const runId = Date.now().toString(36);
      const feed = (async () => {
        for (const s of source.build(runId)) {
          const wait = simStart + s.at - Date.now();
          if (wait > 0) await sleep(wait);
          if (cleaned) return;
          let status = await postHook(port, token, s.payload);
          if (status === 0) status = await postHook(port, token, s.payload); // one retry on a dropped connection
          if (status !== 204) summary.warnings.push(`demo event ${String(s.payload.hook_event_name)} rejected with HTTP ${status}`);
        }
      })();
      feed.catch((e) => summary.warnings.push(`demo feed stopped: ${e.message}`));
    } else {
      // The default scenario is short (about 17 s, 3 sessions): overlap four runs for a fuller office.
      sims.push(child('simulate-1', simArgs([]), env));
      for (const k of [1, 2, 3]) setTimeout(() => sims.push(child(`simulate-${k + 1}`, simArgs([]), env)), k * 5000);
    }
    log(`SIMULATED traffic started: ${summary.scenario}`);
    const since = () => Date.now() - simStart;

    const evaluate = (fn, arg) => page.evaluate(fn, arg).catch(() => null);
    const workers = () =>
      evaluate(() => {
        const s = window.__officeScene;
        const snap = window.__officeStore.getSnapshot();
        const meetings = s.currentMeetings();
        return [...s.workers.values()].map((w) => {
          const a = snap.state.agents[w.view.key];
          const m = meetings.find((x) => x.participants.includes(w.view.key));
          return {
            key: w.view.key,
            kind: a ? a.kind : '',
            status: w.view.status,
            phase: w.phase,
            x: w.pos.x,
            y: w.pos.y,
            moving: w.path.length > 0,
            leaving: w.leaving,
            activity: w.perform ? w.perform.activity : null,
            speech: w.perform && w.perform.speech ? w.perform.speech : null,
            meeting: m ? m.phase : null,
          };
        });
      }).then((x) => x || []);
    const meetings = () => evaluate(() => window.__officeScene.currentMeetings()).then((x) => x || []);
    const layout = await evaluate(() => {
      const l = window.__officeStore.getSnapshot().layout;
      return { cols: l.cols, rows: l.rows, rooms: (l.rooms || []).map((r) => ({ id: r.id, kind: r.kind, x: r.x, y: r.y, w: r.w, h: r.h })), items: l.items.map((i) => ({ type: i.type, x: i.x, y: i.y })) };
    });
    const roomOf = (kind) => layout.rooms.find((r) => r.kind === kind);
    const waitFor = async (what, test, timeoutMs, everyMs = 250) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const v = await test();
        if (v) return v;
        await sleep(everyMs);
      }
      log(`timed out waiting for ${what}`);
      return null;
    };
    const tab = async (label) => {
      await page.locator('button.navtab').filter({ hasText: new RegExp(`^\\s*${label}`) }).first().click();
      await sleep(900);
      await page.mouse.move(VIEWPORT.width - 4, 4);
    };
    /** Zoom to `zoom` (instantly) and centre on tile (x, y), then let the camera glide settle. */
    const camera = async (zoom, x, y) => {
      await evaluate(
        ({ zoom: z, x: cx, y: cy }) => {
          const s = window.__officeScene;
          for (let i = 0; i < 16 && s.getZoom() < z; i++) s.zoomStep(1);
          for (let i = 0; i < 16 && s.getZoom() > z; i++) s.zoomStep(-1);
          s.centerOnTile(cx, cy);
        },
        { zoom, x, y },
      );
      await sleep(900);
    };
    const fit = async () => {
      await evaluate(() => window.__officeScene.fitView());
      await sleep(900);
    };
    const officeBox = async () => page.locator('section.office canvas').first().boundingBox();
    const record = (name, file, what, at = since()) => {
      const size = fs.statSync(file).size;
      summary.files.push({ name: path.basename(file), bytes: size, at: `${(at / 1000).toFixed(1)}s`, shows: what });
      log(`wrote ${path.basename(file)} (${Math.round(size / 1024)} KB): ${what}`);
    };
    /** Save a PNG. With `verify`, retry a few times until the captured image passes the check. */
    const shot = async (name, what, opts = {}) => {
      if (!wanted(name)) return false;
      const file = path.join(OUT, `${name}.png`);
      for (let attempt = 0; attempt < (opts.verify ? 10 : 1); attempt++) {
        const buf = opts.element ? await page.locator(opts.element).first().screenshot({ animations: 'allow' }) : await page.screenshot({ clip: opts.clip, animations: 'allow' });
        if (opts.verify && !opts.verify(buf)) {
          await sleep(150);
          continue;
        }
        fs.writeFileSync(file, buf);
        record(name, file, what);
        return true;
      }
      return false;
    };
    const skip = (name, why) => {
      if (!wanted(name)) return;
      summary.skipped.push({ name, why });
      log(`skipped ${name}: ${why}`);
    };
    /**
     * Record `seconds` of the page region `clip` for a GIF from the browser's own screencast, with real timing.
     * Encoding is CPU-heavy, so it is deferred to `encodeGifs` to keep the demo feed and shot timing undisturbed.
     */
    const cdp = await context.newCDPSession(page);
    const gifJobs = [];
    const gif = async (name, what, clip, seconds, minFrameMs = 100) => {
      if (!GIFS || !wanted(name)) return;
      const raw = [];
      const onFrame = (f) => {
        raw.push({ ts: f.metadata.timestamp * 1000, data: f.data });
        cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      };
      cdp.on('Page.screencastFrame', onFrame);
      await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
      await sleep(seconds * 1000);
      await cdp.send('Page.stopScreencast').catch(() => {});
      cdp.off('Page.screencastFrame', onFrame);
      const picked = [];
      for (const f of raw) if (!picked.length || f.ts - picked[picked.length - 1].ts >= minFrameMs) picked.push(f);
      if (picked.length < 3) return skip(name, `too few frames captured (${picked.length})`);
      gifJobs.push({ name, what, clip, seconds, picked, at: since() });
      log(`recorded ${name} (${picked.length} frames; encoded at the end)`);
    };
    const encodeGifs = () => {
      for (const job of gifJobs.splice(0)) {
        const { clip, picked } = job;
        const frames = picked.map((f) => {
          const img = decodePng(Buffer.from(f.data, 'base64'));
          const crop = new Uint8Array(clip.width * clip.height * 3);
          for (let y = 0; y < clip.height; y++) {
            const from = ((clip.y + y) * img.width + clip.x) * 3;
            crop.set(img.rgb.subarray(from, from + clip.width * 3), y * clip.width * 3);
          }
          return crop;
        });
        const delays = picked.map((f, i) => (i + 1 < picked.length ? picked[i + 1].ts - f.ts : 1500));
        const file = path.join(OUT, `${job.name}.gif`);
        fs.writeFileSync(file, encodeGif(frames, clip.width, clip.height, delays));
        const fps = (picked.length - 1) / ((picked[picked.length - 1].ts - picked[0].ts) / 1000);
        record(job.name, file, `${job.what} (${frames.length} frames over ${job.seconds}s, ~${fps.toFixed(1)} fps, ${clip.width}x${clip.height})`, job.at);
      }
    };
    /** Pixels of the simulated-speech bubble fill colour in a screenshot (to verify a bubble is visible). */
    const bubblePixels = (png) => {
      const { rgb } = decodePng(png);
      let n = 0;
      for (let i = 0; i < rgb.length; i += 3) if (rgb[i] === 0xf1 && rgb[i + 1] === 0xec && rgb[i + 2] === 0xff) n++;
      return n;
    };
    /** Clip (page pixels) of at most w×h, centred on the office canvas. */
    const clipAround = async (w, h) => {
      const box = await officeBox();
      const cw = Math.min(w, Math.floor(box.width));
      const ch = Math.min(h, Math.floor(box.height));
      return { x: Math.round(box.x + (box.width - cw) / 2), y: Math.round(box.y + (box.height - ch) / 2), width: cw, height: ch };
    };

    await fit();
    if (GIFS && wanted('agents-arriving')) {
      const box = await officeBox();
      await gif('agents-arriving', 'SIMULATED sessions and their subagents walk in from the door to their desks', { x: Math.round(box.x), y: Math.round(box.y), width: Math.floor(box.width), height: Math.floor(box.height) }, 8, 125);
    }

    // Agents need ~15 s to walk from the door to a desk; the short default scenario cannot wait for
    // enough seated active agents, so it falls back to "many agents active, some still walking".
    const ACTIVE = new Set(['working', 'waiting_permission', 'waiting_input']);
    const inRoom = (w, r) => r && w.x >= r.x && w.x < r.x + r.w && w.y >= r.y && w.y < r.y + r.h;
    const seatedActive = (ws, room) => ws.filter((w) => ACTIVE.has(w.status) && w.phase === 'seated' && (!room || inRoom(w, room)));
    const busy =
      (await waitFor('agents working at their desks', async () => (seatedActive(await workers()).length >= (showcase ? 9 : 5) ? true : null), showcase ? 60_000 : 4000)) ||
      (await waitFor('a busy office', async () => ((await workers()).filter((w) => ACTIVE.has(w.status)).length >= 5 ? true : null), 20_000));
    if (busy) {
      await fit();
      await shot('office-overview', 'Whole office with SIMULATED sessions, subagents and teammates at work; the sidebar lists the agent tree');
      const dev = roomOf('development');
      if (dev && wanted('development-department')) {
        await waitFor('agents working in Development', async () => seatedActive(await workers(), dev).length >= 3, showcase ? 15_000 : 1000);
        await camera(3, dev.x + dev.w / 2, dev.y + dev.h / 2);
        await shot('development-department', 'Development department close-up: each desk monitor shows that agent’s real activity', { element: 'section.office' });
      } else if (!dev) skip('development-department', 'the layout has no development room');
      const research = roomOf('research');
      const qa = roomOf('qa');
      if (research && qa && wanted('subagents-at-work')) {
        const ok = await waitFor('subagents working in QA / Research', async () => seatedActive(await workers(), qa).length + seatedActive(await workers(), research).length >= 2, showcase ? 15_000 : 1000);
        if (ok) {
          await camera(2, (qa.x + research.x + research.w) / 2, (research.y + research.h / 2 + qa.y + qa.h / 2) / 2);
          await shot('subagents-at-work', 'QA & Testing and Research rooms with SIMULATED subagents placed by the default department rules', { element: 'section.office' });
        } else skip('subagents-at-work', 'no subagents were working at desks in QA or Research');
      } else if (!(research && qa)) skip('subagents-at-work', 'the layout has no QA/research rooms');
      await fit();
    } else {
      skip('office-overview', 'the office never had enough active agents');
      skip('development-department', 'the office never had enough active agents');
      skip('subagents-at-work', 'the office never had enough active agents');
    }

    if (wanted('inspector')) {
      const target = await waitFor('an agent waiting for permission', async () => (await workers()).find((w) => w.status === 'waiting_permission'), 45_000);
      if (target) {
        // Select it from the agent list (a real click), which opens the inspector in the sidebar.
        await page.locator('button.agent-row').filter({ hasText: /Needs permission/ }).first().click();
        await page.mouse.move(VIEWPORT.width - 4, 4);
        const opened = await page.waitForSelector('section.inspector', { timeout: 3000 }).then(() => true, () => false);
        if (opened) {
          await sleep(1200);
          await shot('inspector', 'Inspector for a SIMULATED session waiting for permission: pending request, current tool, timing and tasks');
          await page.locator('section.inspector button[aria-label="Close details"]').first().click().catch(() => {});
          await sleep(300);
          await fit();
        } else skip('inspector', 'selecting the agent did not open the inspector');
      } else skip('inspector', 'no agent was waiting for permission');
    }

    if (wanted('team-view')) {
      const ok = await waitFor('working teammates', async () => (await workers()).filter((w) => w.kind === 'teammate' && w.status === 'working').length >= 2, 30_000);
      if (ok) {
        await tab('Team');
        await shot('team-view', 'Team view: lead, subagents and teammates with verified links, parallel work and task handoffs (demo data)');
        await tab('Office');
      } else skip('team-view', 'teammates never worked in parallel');
    }
    if (wanted('tasks-board')) {
      const ok = await waitFor(
        'open and completed tasks',
        () =>
          evaluate(() => {
            const t = Object.values(window.__officeStore.getSnapshot().state.tasks);
            return t.some((x) => x.status === 'open' && !x.orphaned) && t.some((x) => x.status === 'completed');
          }),
        25_000,
      );
      if (ok) {
        await tab('Tasks');
        await shot('tasks-board', 'Task board built from TaskCreated / TaskCompleted hook events (demo data)');
        await tab('Office');
      } else skip('tasks-board', 'there were never both open and completed tasks');
    }
    if (wanted('errors-view')) {
      const ok = await waitFor('a failed turn', async () => (await workers()).some((w) => w.status === 'failed'), 45_000);
      if (ok) {
        await sleep(showcase ? 1500 : 500);
        await tab('Errors');
        await shot('errors-view', 'Errors view: failed tools and turns, permission waits and test-like failures, each with its evidence (demo data)');
        await tab('Office');
      } else skip('errors-view', 'no agent failed');
    }
    if (wanted('analytics-view')) {
      await tab('Analytics');
      await sleep(1500);
      await shot('analytics-view', 'Analytics view with demo data only: no transcripts exist, so token usage is shown as not reported rather than estimated');
      await tab('Office');
    }

    await waitFor(
      'the simulated sessions to finish',
      async () => {
        const ws = await workers();
        return ws.length > 0 && ws.every((w) => !['working', 'waiting_permission', 'waiting_input'].includes(w.status));
      },
      60_000,
      500,
    );
    await fit();
    const todo = new Set(['idle-chat', 'coffee-break', 'meeting-room', 'meeting-gathering', 'idle-chat-gif'].filter((n) => wanted(n.replace(/-gif$/, ''))));
    if (!GIFS) {
      todo.delete('meeting-gathering');
      todo.delete('idle-chat-gif');
    }
    const idleEnd = Date.now() + 300_000;
    while (todo.size && Date.now() < idleEnd) {
      const ws = await workers();
      const ms = await meetings();
      const gathering = ms.find((m) => m.phase === 'gathering');
      const seated = ms.find((m) => m.phase === 'meeting');
      const chat = ws.filter((w) => w.activity === 'chat' && !w.moving);
      const coffee = ws.find((w) => w.activity === 'coffee' && !w.moving);
      const roomById = (id) => layout.rooms.find((r) => r.id === id);
      if (todo.has('meeting-gathering') && gathering) {
        const r = roomById(gathering.roomId);
        if (r) {
          await camera(2, r.x + r.w / 2, r.y + r.h / 2);
          await gif('meeting-gathering', `Idle agents walk to the ${gathering.roomName} for a simulated meeting`, await clipAround(900, 640), 10, 125);
          todo.delete('meeting-gathering');
          await fit();
          continue;
        }
      }
      if (todo.has('meeting-room') && seated && seated.participants.length >= 2) {
        const r = roomById(seated.roomId);
        const arrived = ws.filter((w) => seated.participants.includes(w.key) && !w.moving).length;
        if (r && arrived >= 2) {
          await camera(3, r.x + r.w / 2, r.y + r.h / 2);
          await shot('meeting-room', `Simulated meeting in the ${seated.roomName} (${seated.participants.length} idle agents, icon bubbles only)`, { element: 'section.office' });
          todo.delete('meeting-room');
          await fit();
          continue;
        }
      }
      if ((todo.has('idle-chat') || todo.has('idle-chat-gif')) && chat.length >= 2) {
        const a = chat[0];
        await camera(4, a.x, a.y - 1);
        if (todo.has('idle-chat')) {
          const spoke = await waitFor('a simulated speech bubble', async () => (await workers()).some((w) => w.activity === 'chat' && w.speech), 6000, 100);
          // The bubble must really be in the image (a large patch of its fill colour), not just in the state.
          if (spoke && (await shot('idle-chat', 'Two idle agents chatting; the dashed lavender bubble is a local template line, labelled as simulated', { element: 'section.office', verify: (png) => bubblePixels(png) > 1500 }))) todo.delete('idle-chat');
        }
        if (todo.has('idle-chat-gif') && (await workers()).filter((w) => w.activity === 'chat').length >= 2) {
          await gif('idle-chat', 'Idle agents chat with simulated template lines (dashed lavender bubbles)', await clipAround(640, 400), 8, 125);
          todo.delete('idle-chat-gif');
        }
        await fit();
        continue;
      }
      if (todo.has('coffee-break') && coffee) {
        await camera(4, coffee.x, coffee.y - 1);
        const still = (await workers()).find((w) => w.key === coffee.key && w.activity === 'coffee');
        if (still) {
          await shot('coffee-break', 'An idle agent on a simulated coffee break at the break-room machine', { element: 'section.office' });
          todo.delete('coffee-break');
        }
        await fit();
        continue;
      }
      await sleep(250);
    }
    for (const n of todo) {
      if (n === 'idle-chat-gif') skip('idle-chat (gif)', 'no idle chat occurred within 5 minutes');
      else skip(n, 'the state did not occur within 5 minutes');
    }

    if (wanted('history-replay')) {
      await tab('History');
      const rows = 'table[aria-label="Recorded sessions"] button.link';
      const listed = await page.waitForSelector(rows, { timeout: 15_000 }).then(() => true, () => false);
      if (listed) {
        // Prefer the session with the most going on (subagents, tasks); otherwise the first one.
        const preferred = page.locator(rows).filter({ hasText: /checkout|webshop/i }).first();
        await ((await preferred.count()) ? preferred : page.locator(rows).first()).click();
        const replay = await page.waitForSelector('.hv-replay .hv-bars', { timeout: 15_000 }).then(() => true, () => false);
        if (replay) {
          await page.evaluate(() => document.querySelector('.hv-replay').scrollIntoView({ block: 'start' }));
          await sleep(500);
          const clock0 = await page.locator('.hv-clock').first().innerText().catch(() => '');
          const bars = await page.locator('.hv-bars').first().boundingBox();
          if (bars) await page.mouse.click(bars.x + bars.width * 0.4, bars.y + bars.height / 2);
          await page.mouse.move(VIEWPORT.width - 4, 4);
          await sleep(2000);
          const clock1 = await page.locator('.hv-clock').first().innerText().catch(() => '');
          if (clock1 === clock0) summary.warnings.push('history-replay: seeking did not move the replay clock');
          await shot('history-replay', 'History: replay of a recorded SIMULATED session through the same reducer (movement reconstructed), with its event list');
        } else skip('history-replay', 'the replay did not load');
      } else skip('history-replay', 'no recorded sessions were listed');
      await tab('Office');
    }

    if (gifJobs.length) {
      log(`encoding ${gifJobs.length} GIF(s)…`);
      encodeGifs();
    }

    if (pageErrors.length) summary.warnings.push(`${pageErrors.length} page error(s): ${pageErrors.slice(0, 3).join(' | ')}`);
    if (summary.blockedRequests) summary.warnings.push(`${summary.blockedRequests} non-loopback request(s) were blocked`);
    summary.ok = summary.files.length > 0;
  } catch (e) {
    summary.error = e.message;
    if (monitor && monitor.out.length) summary.monitorOutputTail = monitor.out.join('').split('\n').slice(-15);
  } finally {
    clearTimeout(watchdog);
    await cleanup();
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`capture-screenshots: ${e.stack || e}`);
    process.exit(2);
  },
);
