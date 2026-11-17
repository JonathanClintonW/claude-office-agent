import type { InferencePluginMeta, MonitorMeta } from '@agent-office/core';
import type { ConnectionStatus } from '../transport';

interface Props {
  meta?: MonitorMeta;
  connection: ConnectionStatus;
  connectionDetail?: string;
  synced: boolean;
  isVSCode: boolean;
  onInstallHooks?(): void;
}

/** Tells the user exactly which data sources are live, so nothing shown is mistaken for more than it is. */
export function SourcesBanner(p: Props) {
  if (p.connection !== 'open') {
    return (
      <div className="banner bad" role="status">
        <strong>{p.synced ? 'Disconnected from the monitor.' : 'Waiting for the monitor…'}</strong>{' '}
        {p.synced ? 'Everything below is the last known state and may be outdated.' : (p.connectionDetail ?? 'Start it with "agent-office start".')}
      </div>
    );
  }
  if (!p.meta) return null;
  const dirs = p.meta.claudeDirs;
  const withHooks = dirs.filter((d) => d.hooks === 'installed' || d.hooks === 'partial');
  const disabled = dirs.filter((d) => d.hooksDisabled);
  const recentHook = p.meta.lastHookEventAt !== undefined;
  if (disabled.length) {
    return (
      <div className="banner warn" role="status">
        <strong>Hooks are disabled</strong> (<code>disableAllHooks</code>) in {disabled.map((d) => d.path).join(', ')}. Live activity is unavailable.
      </div>
    );
  }
  const scopes = (p.meta.plugins?.inference as InferencePluginMeta | undefined)?.hookScopes;
  if (scopes?.duplicateEvents.length) {
    return (
      <div className="banner warn" role="status">
        <strong>Agent Office hooks are installed in more than one scope</strong> ({scopes.scopes.map((s) => s.path).join(', ')}). Claude Code may deliver
        these events twice; the monitor drops exact duplicates. Remove one install with <code>agent-office uninstall-hooks</code> (add{' '}
        <code>--scope project --project &lt;dir&gt;</code> for the project copy).
      </div>
    );
  }
  if (!withHooks.length && !recentHook) {
    return (
      <div className="banner info" role="status">
        <strong>Limited data:</strong> Claude Code hooks are not installed in your user settings, so statuses come only from the session registry (idle/busy/waiting)
        and transcripts. Tool activity, permissions and tasks need hooks.{' '}
        {p.isVSCode && p.onInstallHooks ? (
          <button className="link" onClick={p.onInstallHooks}>
            Install hooks…
          </button>
        ) : (
          <>
            Run <code>agent-office install-hooks</code> (dry run) to review.
          </>
        )}
      </div>
    );
  }
  return null;
}
