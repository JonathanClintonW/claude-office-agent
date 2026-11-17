import { join, resolve, sep } from 'node:path';
import { RPC_METHOD, STATUS_META, TERMINAL_STATUSES, type ClientMessage, type OfficeState } from '@agent-office/core';

/**
 * Turn the built UI's index.html into webview HTML: a <base> pointing at the extension's
 * media folder (so Vite's relative asset URLs resolve), a strict CSP and a script nonce.
 * No network access is allowed from the webview: all data arrives via postMessage.
 */
export function buildWebviewHtml(indexHtml: string, opts: { baseUri: string; cspSource: string; nonce: string }): string {
  const csp = [
    "default-src 'none'",
    `img-src ${opts.cspSource} data: blob:`,
    `style-src ${opts.cspSource} 'unsafe-inline'`,
    `script-src ${opts.cspSource} 'nonce-${opts.nonce}'`,
    `font-src ${opts.cspSource}`,
    'worker-src blob:',
    "connect-src 'none'",
  ].join('; ');
  const base = opts.baseUri.endsWith('/') ? opts.baseUri : `${opts.baseUri}/`;
  return indexHtml
    .replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">\n    <base href="${base}">`)
    .replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${opts.nonce}"`);
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'client'; msg: ClientMessage }
  | { type: 'openTranscript'; path: string }
  | { type: 'focusClaude' }
  | { type: 'installHooks' };

/** Validate untrusted messages coming from the webview. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'focusClaude':
    case 'installHooks':
      return { type: m.type };
    case 'openTranscript':
      return typeof m.path === 'string' && m.path.length < 2048 ? { type: 'openTranscript', path: m.path } : undefined;
    case 'client': {
      const c = m.msg as Record<string, unknown> | undefined;
      if (c?.type === 'resync') return { type: 'client', msg: { type: 'resync' } };
      if (c?.type === 'rpc' && typeof c.id === 'number' && Number.isInteger(c.id) && typeof c.method === 'string' && RPC_METHOD.test(c.method)) {
        const params = c.params && typeof c.params === 'object' && !Array.isArray(c.params) ? (c.params as Record<string, unknown>) : {};
        return { type: 'client', msg: { type: 'rpc', id: c.id, method: c.method, params } };
      }
      if (c?.type === 'saveLayout' && c.layout && typeof c.layout === 'object') {
        return { type: 'client', msg: { type: 'saveLayout', layout: c.layout as never } };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Only transcripts under a watched Claude config dir's `projects` folder may be opened. */
export function isAllowedTranscript(path: string, claudeDirs: readonly string[]): boolean {
  if (!path.toLowerCase().endsWith('.jsonl')) return false;
  const abs = resolve(path);
  const ci = process.platform === 'win32';
  const norm = (p: string) => (ci ? p.toLowerCase() : p);
  return claudeDirs.some((d) => norm(abs).startsWith(norm(join(resolve(d), 'projects') + sep)));
}

export interface StatusSummary {
  text: string;
  tooltip: string;
  attention: boolean;
}

export function summarize(state: OfficeState | undefined, connected: boolean): StatusSummary {
  if (!connected || !state) return { text: '$(organization) Agent Office: offline', tooltip: 'Not connected to the Agent Office monitor', attention: false };
  const live = Object.values(state.agents).filter((a) => !TERMINAL_STATUSES.has(a.status));
  const working = live.filter((a) => a.status === 'working').length;
  const waiting = live.filter((a) => a.status === 'waiting_permission' || a.status === 'waiting_input').length;
  const failed = live.filter((a) => a.status === 'failed').length;
  const parts = [`${working} working`];
  if (waiting) parts.push(`${waiting} need${waiting === 1 ? 's' : ''} you`);
  if (failed) parts.push(`${failed} failed`);
  const tooltip = live.length
    ? Object.entries(
        live.reduce<Record<string, number>>((acc, a) => {
          acc[a.status] = (acc[a.status] ?? 0) + 1;
          return acc;
        }, {}),
      )
        .map(([s, n]) => `${n} ${STATUS_META[s as keyof typeof STATUS_META].label.toLowerCase()}`)
        .join(', ')
    : 'No active agents';
  return { text: `$(organization) ${parts.join(' · ')}`, tooltip: `Agent Office: ${tooltip}`, attention: waiting > 0 || failed > 0 };
}
