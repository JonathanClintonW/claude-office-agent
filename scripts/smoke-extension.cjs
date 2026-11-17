/**
 * Loads the bundled extension (dist/extension.cjs) with a minimal mock of the `vscode`
 * API and runs activate(): verifies the bundle is self-contained, commands are registered,
 * and the extension connects to a running monitor (as a client) and fills the status bar.
 *
 * Usage: node scripts/smoke-extension.cjs   (with `agent-office start` running)
 */
const Module = require('module');
const path = require('path');

const registered = [];
const statusItems = [];
const messages = [];
const config = { port: 47821, autoStartMonitor: false, claudeConfigDirs: [], showOnlyCurrentWorkspace: false, nativeNotifications: true };

const vscodeMock = {
  window: {
    createOutputChannel: () => ({ appendLine: (l) => messages.push(l), show() {}, dispose() {} }),
    createStatusBarItem: () => {
      const item = { text: '', tooltip: '', show() {}, dispose() {} };
      statusItems.push(item);
      return item;
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    createWebviewPanel: () => {
      throw new Error('not used');
    },
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d) }),
    workspaceFolders: [{ uri: { fsPath: path.join(__dirname, '..') }, name: 'workspace' }],
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: (id) => {
      registered.push(id);
      return { dispose() {} };
    },
    getCommands: async () => [],
    executeCommand: async () => undefined,
  },
  extensions: { getExtension: () => undefined },
  StatusBarAlignment: { Left: 1 },
  ViewColumn: { Active: -1 },
  ThemeColor: class {},
  Uri: { joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p) }), file: (p) => ({ fsPath: p }) },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeMock;
  return origLoad.call(this, request, ...rest);
};

(async () => {
  const extDir = path.join(__dirname, '..', 'packages', 'vscode-extension');
  const ext = require(path.join(extDir, 'dist', 'extension.cjs'));
  const subscriptions = [];
  ext.activate({ extensionUri: { fsPath: extDir }, subscriptions });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !/working|idle|needs/.test(statusItems[0]?.text ?? '')) await new Promise((r) => setTimeout(r, 100));
  const expected = ['agentOffice.open', 'agentOffice.installHooks', 'agentOffice.uninstallHooks', 'agentOffice.restartMonitor', 'agentOffice.showLog'];
  const missing = expected.filter((c) => !registered.includes(c));
  console.log('commands:', registered.join(', '));
  console.log('status bar:', statusItems[0]?.text, '|', statusItems[0]?.tooltip);
  console.log('log:', messages.slice(-3).join(' / '));
  const ok = missing.length === 0 && /working|idle|needs/.test(statusItems[0]?.text ?? '');
  await ext.deactivate();
  console.log('after deactivate:', statusItems[0]?.text);
  console.log(ok ? 'EXTENSION SMOKE PASS' : `EXTENSION SMOKE FAIL ${missing.join(',')}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
