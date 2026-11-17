import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { displayName, type Notice, type ServerMessage } from '@agent-office/core';
import {
  applyPlan,
  describePlan,
  findNodeExecutable,
  FORWARDER_FILE,
  installForwarder,
  loadOrCreateConfig,
  planInstall,
  planUninstall,
  projectSettingsPath,
  resolveAppHome,
  resolveClaudeDirs,
  userSettingsPath,
  type HookPlan,
} from '@agent-office/monitor';
import { MonitorConnection, type LinkStatus } from './connection';
import { buildWebviewHtml, isAllowedTranscript, parseWebviewMessage, summarize } from './webview';

let connection: MonitorConnection | undefined;
const panels = new Set<vscode.WebviewPanel>();

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('Agent Office');
  const log = (m: string) => out.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`);
  const settings = () => vscode.workspace.getConfiguration('agentOffice');
  const home = resolveAppHome();
  const cfg = loadOrCreateConfig(home, { port: settings().get<number>('port', 47821) });
  const claudeDirs = () => resolveClaudeDirs([...cfg.claudeConfigDirs, ...settings().get<string[]>('claudeConfigDirs', [])]);
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'ui');

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'agentOffice.open';
  status.show();
  const refreshStatus = () => {
    const s = summarize(connection?.mirror?.state, connection?.status === 'open');
    status.text = s.text;
    status.tooltip = s.tooltip;
    status.backgroundColor = s.attention ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  };

  const post = (msg: unknown) => {
    for (const p of panels) void p.webview.postMessage(msg);
  };
  const lastNative = new Map<string, number>();
  const nativeNotify = (notices: Notice[]) => {
    if (!settings().get<boolean>('nativeNotifications', true)) return;
    for (const n of notices) {
      if (n.severity === 'info') continue;
      const last = lastNative.get(n.agentKey) ?? 0;
      if (Date.now() - last < 10_000) continue;
      lastNative.set(n.agentKey, Date.now());
      const agent = connection?.mirror?.state.agents[n.agentKey];
      const who = agent ? displayName(agent) : n.sessionId;
      const text = `${n.title} (${who})`;
      const show = n.severity === 'error' ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
      const actions = n.kind === 'permission' || n.kind === 'input_needed' ? ['Open Claude Code', 'Show in office'] : ['Show in office'];
      void show(text, ...actions).then((choice) => {
        if (choice === 'Open Claude Code') void focusClaude();
        if (choice === 'Show in office') void vscode.commands.executeCommand('agentOffice.open');
      });
    }
  };

  connection = new MonitorConnection({
    home,
    port: cfg.port,
    token: cfg.token,
    claudeDirs: claudeDirs(),
    autoStart: settings().get<boolean>('autoStartMonitor', true),
    log,
    onMessage: (msg: ServerMessage) => {
      post({ type: 'server', msg });
      refreshStatus();
    },
    onStatus: (s: LinkStatus, detail?: string) => {
      post({ type: 'connection', status: s, detail });
      refreshStatus();
      log(`connection: ${s}${detail ? ` (${detail})` : ''}`);
    },
    onNotices: nativeNotify,
  });
  connection.start();
  refreshStatus();

  const hostInfo = () => ({
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    showOnlyCurrentWorkspace: settings().get<boolean>('showOnlyCurrentWorkspace', false),
    canOpenFiles: true,
    canFocusClaude: Boolean(vscode.extensions.getExtension('anthropic.claude-code')),
  });

  async function focusClaude(): Promise<void> {
    const cmds = await vscode.commands.getCommands(true);
    // Supported, public commands of the official extension; this only opens its UI.
    const cmd = ['claude-vscode.focus', 'claude-vscode.editor.openLast', 'claude-vscode.sidebar.open'].find((c) => cmds.includes(c));
    if (cmd) await vscode.commands.executeCommand(cmd);
    else void vscode.window.showInformationMessage('The Claude Code extension is not installed in this window.');
  }

  function openPanel(): void {
    const existing = [...panels][0];
    if (existing) {
      existing.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('agentOffice', 'Agent Office', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    });
    const index = join(mediaRoot.fsPath, 'index.html');
    if (!existsSync(index)) {
      panel.webview.html = '<html><body><p>Agent Office UI is missing from this build.</p></body></html>';
    } else {
      panel.webview.html = buildWebviewHtml(readFileSync(index, 'utf8'), {
        baseUri: panel.webview.asWebviewUri(mediaRoot).toString(),
        cspSource: panel.webview.cspSource,
        nonce: randomBytes(16).toString('base64'),
      });
    }
    panels.add(panel);
    panel.onDidDispose(() => panels.delete(panel));
    panel.webview.onDidReceiveMessage(async (raw) => {
      const m = parseWebviewMessage(raw);
      if (!m) return;
      switch (m.type) {
        case 'ready': {
          void panel.webview.postMessage({ type: 'host', host: hostInfo() });
          void panel.webview.postMessage({ type: 'connection', status: connection?.status ?? 'connecting', detail: connection?.detail });
          const mirror = connection?.mirror;
          if (mirror) void panel.webview.postMessage({ type: 'server', msg: { type: 'snapshot', ...mirror } });
          break;
        }
        case 'client':
          connection?.send(m.msg);
          break;
        case 'openTranscript': {
          if (!isAllowedTranscript(m.path, claudeDirs())) {
            void vscode.window.showWarningMessage('Agent Office only opens transcripts inside your Claude config directory.');
            return;
          }
          try {
            const size = statSync(m.path).size;
            if (size > 25 * 1024 * 1024) {
              const ok = await vscode.window.showWarningMessage(`This transcript is ${(size / 1048576).toFixed(0)} MB. Open anyway?`, 'Open');
              if (ok !== 'Open') return;
            }
            await vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true, preserveFocus: false });
          } catch (e) {
            // e.g. the transcript was deleted since the agent was seen
            void vscode.window.showWarningMessage(`Agent Office could not open the transcript: ${(e as Error).message}`);
          }
          break;
        }
        case 'focusClaude':
          await focusClaude();
          break;
        case 'installHooks':
          await vscode.commands.executeCommand('agentOffice.installHooks');
          break;
      }
    });
  }

  async function reviewAndApply(plan: HookPlan, verb: string, beforeApply?: () => void): Promise<boolean> {
    if (!plan.changed) {
      void vscode.window.showInformationMessage(`No changes needed in ${plan.settingsPath}.`);
      return false;
    }
    const doc = await vscode.workspace.openTextDocument({ content: describePlan(plan), language: 'diff' });
    await vscode.window.showTextDocument(doc, { preview: true });
    const warn = plan.warnings.length ? `\n\nWarnings:\n${plan.warnings.join('\n')}` : '';
    const choice = await vscode.window.showWarningMessage(
      `${verb} Agent Office hooks in ${plan.settingsPath}? A timestamped backup is written first. Other settings and hooks are preserved.${warn}`,
      { modal: true },
      verb,
    );
    if (choice !== verb) return false;
    beforeApply?.();
    const r = applyPlan(plan);
    void vscode.window.showInformationMessage(`Updated ${plan.settingsPath}${r.backupPath ? ` (backup: ${r.backupPath})` : ''}. Claude Code picks up hook changes automatically.`);
    log(`${verb}: ${plan.settingsPath}${r.backupPath ? ` backup=${r.backupPath}` : ''}`);
    return true;
  }

  async function pickSettingsFile(): Promise<string | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const items: Array<vscode.QuickPickItem & { path: string }> = claudeDirs().map((d) => ({
      label: 'All Claude Code sessions (user settings)',
      description: userSettingsPath(d),
      path: userSettingsPath(d),
    }));
    if (folder) {
      items.push({ label: `Only this workspace (${folder.name})`, description: projectSettingsPath(folder.uri.fsPath), path: projectSettingsPath(folder.uri.fsPath) });
    }
    const pick = await vscode.window.showQuickPick(items, { title: 'Where should Agent Office hooks be configured?' });
    return pick?.path;
  }

  context.subscriptions.push(
    out,
    status,
    vscode.commands.registerCommand('agentOffice.open', openPanel),
    vscode.commands.registerCommand('agentOffice.showLog', () => out.show()),
    vscode.commands.registerCommand('agentOffice.restartMonitor', async () => {
      await connection?.restart();
      void vscode.window.showInformationMessage('Agent Office monitor restarted.');
    }),
    vscode.commands.registerCommand('agentOffice.installHooks', async () => {
      try {
        const settingsPath = await pickSettingsFile();
        if (!settingsPath) return;
        let nodePath = findNodeExecutable();
        let mode: 'command' | 'http' = 'command';
        if (!nodePath) {
          const c = await vscode.window.showWarningMessage(
            'Node.js was not found on PATH. Use HTTP hooks instead? (SessionStart cannot be captured without Node.js; the session registry still detects new sessions.)',
            { modal: true },
            'Use HTTP hooks',
          );
          if (c !== 'Use HTTP hooks') return;
          mode = 'http';
          nodePath = undefined;
        }
        const bundled = vscode.Uri.joinPath(context.extensionUri, 'dist', FORWARDER_FILE).fsPath;
        const plan = planInstall({ settingsPath, mode, nodePath, forwarderPath: join(home, 'bin', FORWARDER_FILE), home, port: cfg.port, token: cfg.token });
        // The forwarder is copied only after confirmation, right before the settings change.
        await reviewAndApply(plan, 'Install', () => {
          if (nodePath) installForwarder(bundled, home);
        });
      } catch (e) {
        void vscode.window.showErrorMessage(`Agent Office: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('agentOffice.uninstallHooks', async () => {
      try {
        const settingsPath = await pickSettingsFile();
        if (!settingsPath) return;
        await reviewAndApply(planUninstall(settingsPath), 'Remove');
      } catch (e) {
        void vscode.window.showErrorMessage(`Agent Office: ${(e as Error).message}`);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => post({ type: 'host', host: hostInfo() })),
    { dispose: () => void connection?.dispose() },
  );
}

export async function deactivate(): Promise<void> {
  await connection?.dispose();
  connection = undefined;
}
