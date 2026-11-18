import { existsSync } from 'node:fs';
import { TERMINAL_STATUSES, type HookScopeReport, type InferencePluginMeta } from '@agent-office/core';
import { collectHookScopes } from '../hooks';
import { acquireInferenceGuard, inferenceGuardDiagnostics, type InferenceGuardOptions } from '../inferenceGuard';
import type { MonitorPlugin, PluginContext } from '../plugin';

export interface InferencePluginOptions {
  /** Install the runtime guard on start (default true). It still refuses to patch the VS Code extension host. */
  guard?: boolean;
  /** Passed to the guard (tests use `versions` to simulate the VS Code extension host). */
  guardOptions?: InferenceGuardOptions;
  /** How often to re-check which settings files hold Agent Office hooks (default 60 s). */
  hookScopeIntervalMs?: number;
}

/**
 * Publishes InferenceDiagnostics as `meta.plugins.inference` and owns the runtime guard's
 * lifetime in the monitor process. Also reports Agent Office hooks installed in more than one
 * settings scope (user + project), which makes Claude Code deliver every hook event twice.
 */
export function inferencePlugin(opts: InferencePluginOptions = {}): MonitorPlugin {
  let release: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let ctx: PluginContext | undefined;
  let hookScopes: HookScopeReport | undefined;

  const refreshScopes = (): HookScopeReport | undefined => {
    if (!ctx) return hookScopes;
    try {
      // Project scopes are the working directories of sessions that are still running.
      const cwds = new Set<string>();
      for (const a of Object.values(ctx.getState().agents)) {
        if (a.kind === 'session' && a.cwd && !TERMINAL_STATUSES.has(a.status) && !a.sessionId.startsWith('sim-')) cwds.add(a.cwd);
      }
      hookScopes = collectHookScopes(ctx.claudeDirs, [...cwds].filter((d) => existsSync(d)).slice(0, 50), ctx.now());
    } catch (e) {
      ctx.log(`hook scope check failed: ${(e as Error).message}`);
    }
    return hookScopes;
  };

  const meta = (): InferencePluginMeta => {
    const m: InferencePluginMeta = inferenceGuardDiagnostics();
    if (hookScopes) m.hookScopes = hookScopes;
    return m;
  };

  return {
    name: 'inference',
    start(c) {
      ctx = c;
      if (opts.guard !== false) release = acquireInferenceGuard({ log: (m) => c.log(m), ...opts.guardOptions });
      refreshScopes();
      timer = setInterval(refreshScopes, opts.hookScopeIntervalMs ?? 60_000);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      release?.();
      release = undefined;
      ctx = undefined;
    },
    meta,
    routes: {
      /** Current guard counters plus a fresh hook-scope check. */
      diagnostics: () => {
        refreshScopes();
        return meta();
      },
    },
  };
}
