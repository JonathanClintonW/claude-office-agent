import { request } from 'node:http';
import WebSocket from 'ws';
import {
  reduce,
  type ClientMessage,
  type MonitorMeta,
  type Notice,
  type OfficeLayout,
  type OfficeState,
  type ServerMessage,
} from '@agent-office/core';
import { createMonitor, defaultPlugins, type Monitor } from '@agent-office/monitor';

export type LinkStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface Mirror {
  state: OfficeState;
  meta: MonitorMeta;
  layout: OfficeLayout;
}

export interface ConnectionOptions {
  home: string;
  port: number;
  token: string;
  claudeDirs: string[];
  autoStart: boolean;
  log(msg: string): void;
  onMessage(msg: ServerMessage): void;
  onStatus(status: LinkStatus, detail?: string): void;
  /** Notices that arrived live (not part of a snapshot). */
  onNotices?(notices: Notice[]): void;
}

export function checkHealth(port: number, timeoutMs = 800): Promise<'ours' | 'foreign' | 'none'> {
  return new Promise((done) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => done(body.includes('"agent-office"') ? 'ours' : 'foreign'));
    });
    req.on('error', () => done('none'));
    req.on('timeout', () => {
      req.destroy();
      done('foreign');
    });
    req.end();
  });
}

/**
 * Connects to the local monitor, starting one inside this VS Code window when none is
 * running. Several windows coordinate through the port: whoever binds it first serves,
 * the others are clients and take over if that window closes.
 */
export class MonitorConnection {
  private ws?: WebSocket;
  private embedded?: Monitor;
  private disposed = false;
  private attempt = 0;
  private timer?: NodeJS.Timeout;
  private seen = new Set<string>();
  private resyncRequested = false;
  mirror?: Mirror;
  status: LinkStatus = 'connecting';
  detail?: string;

  constructor(private readonly o: ConnectionOptions) {}

  get ownsMonitor(): boolean {
    return Boolean(this.embedded);
  }

  start(): void {
    void this.connect();
  }

  private setStatus(s: LinkStatus, detail?: string): void {
    this.status = s;
    this.detail = detail;
    this.o.onStatus(s, detail);
  }

  private schedule(): void {
    if (this.disposed) return;
    this.attempt += 1;
    // ±30% jitter so VS Code windows do not reconnect in lockstep after a monitor restart.
    const delay = Math.round(Math.min(15_000, 500 * 2 ** Math.min(this.attempt, 5)) * (0.7 + Math.random() * 0.6));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    const health = await checkHealth(this.o.port);
    // dispose() may have run while the health check was pending: never start a monitor after it.
    if (this.disposed) return;
    if (health === 'ours') return this.openSocket();
    if (health === 'foreign') {
      this.setStatus('reconnecting', `Port ${this.o.port} is used by another program. Change "agentOffice.port".`);
      return this.schedule();
    }
    if (this.o.autoStart && !this.embedded) {
      const m = createMonitor({
        home: this.o.home,
        port: this.o.port,
        token: this.o.token,
        claudeDirs: this.o.claudeDirs,
        plugins: defaultPlugins(),
        log: (msg) => this.o.log(`[monitor] ${msg}`),
      });
      try {
        await m.start();
        if (this.disposed) {
          await m.stop();
          return;
        }
        this.embedded = m;
        this.o.log(`Started monitor in this window on 127.0.0.1:${this.o.port}`);
        return this.openSocket();
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        this.o.log(`Could not start monitor (${code ?? (e as Error).message}); another window probably did. Connecting instead.`);
        if (code === 'EADDRINUSE') {
          this.attempt = 0;
          return this.schedule();
        }
      }
    }
    this.setStatus('reconnecting', this.o.autoStart ? 'Monitor unavailable; retrying' : 'Monitor not running. Start it with "agent-office start" or enable agentOffice.autoStartMonitor.');
    this.schedule();
  }

  private openSocket(): void {
    if (this.disposed) return;
    // Never keep two sockets: a stale one would deliver every event twice.
    this.ws?.close();
    const ws = new WebSocket(`ws://127.0.0.1:${this.o.port}/ws?token=${encodeURIComponent(this.o.token)}`);
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.setStatus('open');
    });
    ws.on('message', (data) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(data)) as ServerMessage;
      } catch {
        return;
      }
      this.track(msg);
      this.o.onMessage(msg);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.disposed) return;
      this.setStatus('reconnecting', 'Lost connection to the monitor; retrying');
      this.schedule();
    });
    ws.on('error', (e) => this.o.log(`WebSocket error: ${e.message}`));
  }

  /** Keep a local mirror (for the status bar and late-opened webviews) using the shared reducer. */
  private track(msg: ServerMessage): void {
    switch (msg.type) {
      case 'snapshot':
        this.mirror = { state: msg.state, meta: msg.meta, layout: msg.layout };
        this.seen = new Set(msg.state.notices.map((n) => n.id));
        this.resyncRequested = false;
        break;
      case 'events': {
        if (!this.mirror) return;
        let s = this.mirror.state;
        for (const ev of msg.events) {
          if (ev.seq <= s.lastSeq) continue;
          if (ev.seq !== s.lastSeq + 1) {
            if (!this.resyncRequested) {
              this.resyncRequested = true;
              this.send({ type: 'resync' });
            }
            return;
          }
          s = reduce(s, ev);
        }
        this.mirror = { ...this.mirror, state: s };
        const fresh = s.notices.filter((n) => !this.seen.has(n.id));
        this.seen = new Set(s.notices.map((n) => n.id));
        if (fresh.length) this.o.onNotices?.(fresh);
        break;
      }
      case 'meta':
        if (this.mirror) this.mirror = { ...this.mirror, meta: msg.meta };
        break;
      case 'layout':
        if (this.mirror) this.mirror = { ...this.mirror, layout: msg.layout };
        break;
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async restart(): Promise<void> {
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = undefined;
    if (this.embedded) {
      await this.embedded.stop();
      this.embedded = undefined;
    }
    this.attempt = 0;
    this.setStatus('connecting');
    await this.connect();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.timer);
    this.ws?.close();
    if (this.embedded) await this.embedded.stop();
    this.embedded = undefined;
    this.setStatus('closed');
  }
}
