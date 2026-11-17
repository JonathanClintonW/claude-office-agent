import type { ClientMessage, ServerMessage } from '@agent-office/core';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Capabilities that only exist inside a host such as VS Code. */
export interface HostInfo {
  kind: 'browser' | 'vscode';
  workspaceFolders: string[];
  showOnlyCurrentWorkspace?: boolean;
  canOpenFiles: boolean;
  canFocusClaude: boolean;
}

export interface TransportHandlers {
  onMessage(msg: ServerMessage): void;
  onStatus(status: ConnectionStatus, detail?: string): void;
  onHost?(host: HostInfo): void;
}

export interface Transport {
  readonly host: HostInfo;
  connect(h: TransportHandlers): void;
  send(msg: ClientMessage): void;
  /** Host actions (VS Code only); no-ops in the browser. */
  openTranscript(path: string): void;
  focusClaude(): void;
  installHooks(): void;
  dispose(): void;
}

declare global {
  interface Window {
    __AGENT_OFFICE__?: { token: string; wsPath?: string; wsUrl?: string };
    acquireVsCodeApi?: () => { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
  }
}

/** Standalone transport: WebSocket to the local monitor with exponential-backoff reconnect. */
export class WebSocketTransport implements Transport {
  readonly host: HostInfo = { kind: 'browser', workspaceFolders: [], canOpenFiles: false, canFocusClaude: false };
  private ws?: WebSocket;
  private handlers?: TransportHandlers;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly url: string) {}

  connect(h: TransportHandlers): void {
    this.handlers = h;
    this.open();
  }

  private open(): void {
    if (this.disposed) return;
    this.handlers?.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.handlers?.onStatus('open');
    };
    ws.onmessage = (e) => {
      try {
        this.handlers?.onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (this.disposed) return;
      this.attempt += 1;
      // ±30% jitter so open tabs do not reconnect in lockstep after a monitor restart.
      const delay = Math.round(Math.min(10_000, 500 * 2 ** Math.min(this.attempt, 5)) * (0.7 + Math.random() * 0.6));
      this.handlers?.onStatus('reconnecting', `Monitor unreachable; retrying in ${Math.round(delay / 1000)}s`);
      this.timer = setTimeout(() => this.open(), delay);
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  openTranscript(): void {}
  focusClaude(): void {}
  installHooks(): void {}

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.handlers?.onStatus('closed');
  }
}

/** VS Code webview transport: the extension host relays monitor traffic via postMessage. */
export class VSCodeTransport implements Transport {
  host: HostInfo = { kind: 'vscode', workspaceFolders: [], canOpenFiles: true, canFocusClaude: false };
  private api = window.acquireVsCodeApi!();
  private listener?: (e: MessageEvent) => void;

  connect(h: TransportHandlers): void {
    this.listener = (e: MessageEvent) => {
      const m = e.data as { type?: string; msg?: ServerMessage; status?: ConnectionStatus; detail?: string; host?: Partial<HostInfo> };
      if (!m || typeof m !== 'object') return;
      if (m.type === 'server' && m.msg) h.onMessage(m.msg);
      else if (m.type === 'connection' && m.status) h.onStatus(m.status, m.detail);
      else if (m.type === 'host' && m.host) {
        this.host = { ...this.host, ...m.host, kind: 'vscode' };
        h.onHost?.(this.host);
      }
    };
    window.addEventListener('message', this.listener);
    h.onStatus('connecting');
    this.api.postMessage({ type: 'ready' });
  }

  send(msg: ClientMessage): void {
    this.api.postMessage({ type: 'client', msg });
  }

  openTranscript(path: string): void {
    this.api.postMessage({ type: 'openTranscript', path });
  }

  focusClaude(): void {
    this.api.postMessage({ type: 'focusClaude' });
  }

  installHooks(): void {
    this.api.postMessage({ type: 'installHooks' });
  }

  dispose(): void {
    if (this.listener) window.removeEventListener('message', this.listener);
  }
}

export function createTransport(): Transport | { error: string } {
  if (typeof window.acquireVsCodeApi === 'function') return new VSCodeTransport();
  const cfg = window.__AGENT_OFFICE__;
  const token = cfg?.token ?? new URLSearchParams(location.search).get('token') ?? undefined;
  if (!token) return { error: 'No monitor token. Open the office from the URL printed by "agent-office start".' };
  const base = cfg?.wsUrl ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${cfg?.wsPath ?? '/ws'}`;
  return new WebSocketTransport(`${base}?token=${encodeURIComponent(token)}`);
}
