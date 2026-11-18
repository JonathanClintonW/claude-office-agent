import {
  createInitialState,
  defaultLayout,
  reduce,
  type MonitorMeta,
  type Notice,
  type OfficeLayout,
  type OfficeState,
  type ServerMessage,
} from '@agent-office/core';
import type { ConnectionStatus, HostInfo, Transport } from './transport';

export interface StoreSnapshot {
  state: OfficeState;
  meta?: MonitorMeta;
  layout: OfficeLayout;
  connection: ConnectionStatus;
  connectionDetail?: string;
  /** Snapshot received at least once: until then nothing is shown as live. */
  synced: boolean;
  host: HostInfo;
  lastError?: string;
  version: number;
}

type Listener = () => void;

/**
 * Client-side mirror of the monitor state. Applies the same reducer as the monitor to the
 * same sequenced events; any sequence gap triggers a full resync instead of guessing.
 */
export class OfficeStore {
  private snap: StoreSnapshot;
  private listeners = new Set<Listener>();
  private resyncRequested = false;
  private seenNotices = new Set<string>();
  private noticeListeners = new Set<(n: Notice[]) => void>();
  private rpcSeq = 0;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly transport: Transport) {
    this.snap = {
      state: createInitialState(),
      layout: defaultLayout(),
      connection: 'connecting',
      synced: false,
      host: transport.host,
      version: 0,
    };
  }

  start(): void {
    this.transport.connect({
      onMessage: (m) => this.onMessage(m),
      onStatus: (connection, connectionDetail) => {
        if (connection !== 'open') this.failPending('Disconnected from the monitor');
        this.patch({ connection, connectionDetail });
      },
      onHost: (host) => this.patch({ host }),
    });
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): StoreSnapshot => this.snap;

  /** Notices that arrive live (not those already present in a snapshot): used for toasts. */
  onNotices(l: (n: Notice[]) => void): () => void {
    this.noticeListeners.add(l);
    return () => this.noticeListeners.delete(l);
  }

  send: Transport['send'] = (m) => this.transport.send(m);

  /** Read-only query answered by a monitor plugin (`plugin.route`); never triggers model inference. */
  rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.snap.connection !== 'open') return Promise.reject(new Error('Not connected to the monitor'));
    const id = ++this.rpcSeq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Request timed out'));
      }, 25_000);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.transport.send({ type: 'rpc', id, method, params });
    });
  }

  private failPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
  get transportRef(): Transport {
    return this.transport;
  }

  private patch(p: Partial<StoreSnapshot>): void {
    this.snap = { ...this.snap, ...p, version: this.snap.version + 1 };
    for (const l of this.listeners) l();
  }

  onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'snapshot':
        this.resyncRequested = false;
        this.seenNotices = new Set(msg.state.notices.map((n) => n.id));
        this.patch({ state: msg.state, meta: msg.meta, layout: msg.layout, synced: true, lastError: undefined });
        break;
      case 'events': {
        if (!this.snap.synced) return;
        let state = this.snap.state;
        for (const ev of msg.events) {
          if (ev.seq <= state.lastSeq) continue; // duplicate delivery
          if (ev.seq !== state.lastSeq + 1) {
            this.requestResync();
            return;
          }
          state = reduce(state, ev);
        }
        const fresh = state.notices.filter((n) => !this.seenNotices.has(n.id));
        this.seenNotices = new Set(state.notices.map((n) => n.id));
        this.patch({ state });
        if (fresh.length) for (const l of this.noticeListeners) l(fresh);
        break;
      }
      case 'meta':
        this.patch({ meta: msg.meta });
        break;
      case 'layout':
        this.patch({ layout: msg.layout });
        break;
      case 'error':
        this.patch({ lastError: msg.message });
        break;
      case 'rpcResult': {
        const p = this.pending.get(msg.id);
        if (!p) break;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? 'Request failed'));
        break;
      }
    }
  }

  private requestResync(): void {
    if (this.resyncRequested) return;
    this.resyncRequested = true;
    this.transport.send({ type: 'resync' });
  }
}
