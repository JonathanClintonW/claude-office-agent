import type { MonitorEvent, OfficeLayout, OfficeState } from '@agent-office/core';

/**
 * Monitor plugin contract. Plugins extend the monitor without editing
 * server.ts: they observe sequenced events, answer read-only RPC queries and publish meta.
 *
 * Plugins MUST be passive: no Claude/Anthropic calls, no spawning Claude, no prompts.
 */
export interface PluginContext {
  home: string;
  claudeDirs: readonly string[];
  now(): number;
  log(msg: string): void;
  getState(): OfficeState;
  getLayout(): OfficeLayout;
}

/** Read-only query handler. Params come from the UI: validate them. */
export type RpcHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export interface MonitorPlugin {
  /** Lowercase identifier; RPC methods are `<name>.<route>`. */
  name: string;
  start?(ctx: PluginContext): void | Promise<void>;
  stop?(): void | Promise<void>;
  /** Called after every sequenced event is applied. Must be fast and must not throw. */
  onEvent?(ev: MonitorEvent, state: OfficeState): void;
  routes?: Record<string, RpcHandler>;
  /** Published under `MonitorMeta.plugins[name]`. Must be cheap and JSON-serialisable. */
  meta?(): unknown;
}
