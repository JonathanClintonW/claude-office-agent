import type { MonitorEvent } from './events';
import type { OfficeLayout } from './layout';
import type { OfficeState } from './state';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47821;
export const TOKEN_HEADER = 'x-agent-office-token';

export type HooksInstallState = 'installed' | 'partial' | 'not_installed' | 'unreadable';

export interface ClaudeDirStatus {
  path: string;
  hooks: HooksInstallState;
  /** Events our hooks are registered for (subset of HOOK_EVENTS). */
  hookEvents: string[];
  registryAvailable: boolean;
  transcriptsAvailable: boolean;
  /** settings.json has `disableAllHooks: true`. */
  hooksDisabled?: boolean;
}

export interface MonitorMeta {
  protocol: number;
  monitorVersion: string;
  startedAt: number;
  claudeDirs: ClaudeDirStatus[];
  lastHookEventAt?: number;
  lastRegistryScanAt?: number;
  lastTranscriptScanAt?: number;
  rejectedEvents: number;
  spooledEventsReplayed: number;
  /** Hook events dropped because an identical copy arrived (hooks installed in two scopes). */
  duplicatesDropped?: number;
  /** Contributions from monitor plugins, keyed by plugin name (see contracts/). */
  plugins?: Record<string, unknown>;
}

export type ServerMessage =
  | { type: 'snapshot'; state: OfficeState; meta: MonitorMeta; layout: OfficeLayout }
  | { type: 'events'; events: MonitorEvent[] }
  | { type: 'meta'; meta: MonitorMeta }
  | { type: 'layout'; layout: OfficeLayout }
  | { type: 'error'; message: string }
  | { type: 'rpcResult'; id: number; ok: boolean; result?: unknown; error?: string };

export type ClientMessage =
  | { type: 'resync' }
  | { type: 'saveLayout'; layout: OfficeLayout }
  /** Read-only query answered by a monitor plugin route (`<plugin>.<route>`). */
  | { type: 'rpc'; id: number; method: string; params?: Record<string, unknown> };

/** Valid RPC method names: `plugin.route`. */
export const RPC_METHOD = /^[a-z][a-zA-Z0-9]{0,30}\.[a-z][a-zA-Z0-9]{0,40}$/;

/** Forwarder → monitor envelope. */
export interface HookEnvelope {
  v: 1;
  ts: number;
  payload: Record<string, unknown>;
}
