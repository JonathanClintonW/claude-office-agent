/**
 * Smoke test for the VS Code webview build, run in a real browser (installed Microsoft Edge).
 *
 * Serves packages/vscode-extension/media/ui using the exact HTML the extension generates
 * (strict CSP, nonce, <base>), stubs `acquireVsCodeApi` like the VS Code host, feeds it a
 * snapshot from the running monitor, and checks that the office renders without CSP
 * violations and that host actions are posted back.
 *
 * Usage: node scripts/smoke-webview.cjs   (requires `agent-office start` to be running)
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');

const root = path.join(__dirname, '..');
const media = path.join(root, 'packages', 'vscode-extension', 'media', 'ui');
const { buildWebviewHtml } = loadWebviewModule();

function loadWebviewModule() {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({ entryPoints: [path.join(root, 'packages/vscode-extension/src/webview.ts')], bundle: true, platform: 'node', format: 'cjs', write: false });
  const m = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}

function fetchState(cfg) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: cfg.port, path: '/api/state', headers: { 'x-agent-office-token': cfg.token } }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(b)) : reject(new Error(`state HTTP ${res.statusCode}`))));
      })
      .on('error', reject);
  });
}

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.env.AGENT_OFFICE_HOME || path.join(os.homedir(), '.agent-office'), 'config.json'), 'utf8'));
  const snapshot = await fetchState(cfg);
  const nonce = crypto.randomBytes(16).toString('base64');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') {
      const origin = `http://127.0.0.1:${server.address().port}`;
      let html = buildWebviewHtml(fs.readFileSync(path.join(media, 'index.html'), 'utf8'), { baseUri: `${origin}/`, cspSource: origin, nonce });
      // Host stub, equivalent to what VS Code provides plus the extension's replies.
      const stub = `<script nonce="${nonce}">
        window.__posted = [];
        const snapshot = ${JSON.stringify({ type: 'snapshot', ...snapshot })};
        window.acquireVsCodeApi = () => ({
          postMessage(m) {
            window.__posted.push(m);
            if (m.type === 'ready') setTimeout(() => {
              window.postMessage({ type: 'host', host: { workspaceFolders: ['c:\\\\work\\\\agent-office'], canOpenFiles: true, canFocusClaude: true } }, '*');
              window.postMessage({ type: 'connection', status: 'open' }, '*');
              window.postMessage({ type: 'server', msg: snapshot }, '*');
            }, 10);
          },
          getState() { return undefined; }, setState() {},
        });
      </script>`;
      html = html.replace('<base href', `${stub}\n    <base href`);
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(html);
    }
    const file = path.join(media, path.normalize(url.pathname));
    if (!file.startsWith(media + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || /Content Security Policy|Refused to/.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('canvas', { timeout: 15000 });
  await page.waitForTimeout(1500);
  const rows = await page.locator('.agent-row').count();
  await page.locator('.agent-row').first().click();
  const transcriptBtn = page.getByRole('button', { name: /Open transcript/ });
  const hasTranscript = (await transcriptBtn.count()) > 0;
  if (hasTranscript) await transcriptBtn.click();
  const posted = await page.evaluate(() => window.__posted.map((m) => m.type));
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
  await browser.close();
  server.close();

  const ok = rows > 0 && problems.length === 0 && posted.includes('ready') && (!hasTranscript || posted.includes('openTranscript'));
  console.log(JSON.stringify({ agentRows: rows, postedToHost: posted, problems }, null, 2));
  console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
