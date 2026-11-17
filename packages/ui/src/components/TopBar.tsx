import { STATUS_META, statusCounts, type Agent, type AgentStatus } from '@agent-office/core';
import type { ConnectionStatus } from '../transport';
import type { Filters, WorkspaceOption } from '../view';

interface Props {
  agents: Agent[];
  connection: ConnectionStatus;
  connectionDetail?: string;
  filters: Filters;
  workspaces: WorkspaceOption[];
  showNames: boolean;
  idleLife: boolean;
  onIdleLife(v: boolean): void;
  editMode: boolean;
  unread: number;
  openTasks: number;
  onFilters(f: Filters): void;
  onShowNames(v: boolean): void;
  onToggleEdit(): void;
  onOpenTasks(): void;
  onOpenNotices(): void;
}

const SHOWN: AgentStatus[] = ['working', 'waiting_permission', 'waiting_input', 'idle', 'failed', 'unknown'];

export function TopBar(p: Props) {
  const counts = statusCounts(p.agents);
  const conn =
    p.connection === 'open'
      ? { cls: 'ok', text: 'Live' }
      : p.connection === 'connecting'
        ? { cls: 'warn', text: 'Connecting…' }
        : { cls: 'bad', text: 'Disconnected' };
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden />
        <strong className="title">Agent Office</strong>
        <span className="hud-clock" title="Local time (drives the office day/night lighting)">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <span className={`conn ${conn.cls}`} title={p.connectionDetail ?? ''}>
          <span className="dot" />
          {conn.text}
        </span>
      </div>
      <div className="counts" aria-label="Agent status counts">
        {SHOWN.map((s) =>
          counts[s] ? (
            <span key={s} className="count" style={{ ['--c' as string]: STATUS_META[s].color }} title={STATUS_META[s].description}>
              <span className="dot" />
              {counts[s]} {STATUS_META[s].label.toLowerCase()}
            </span>
          ) : null,
        )}
      </div>
      <div className="controls">
        <label className="ctl">
          <span>Workspace</span>
          <select value={p.filters.workspace} onChange={(e) => p.onFilters({ ...p.filters, workspace: e.target.value })}>
            <option value="all">All workspaces</option>
            {p.workspaces.map((w) => (
              <option key={w.key} value={w.key} title={w.key}>
                {w.label} ({w.count})
              </option>
            ))}
          </select>
        </label>
        <label className="ctl check">
          <input type="checkbox" checked={p.filters.showEnded} onChange={(e) => p.onFilters({ ...p.filters, showEnded: e.target.checked })} />
          <span>Ended</span>
        </label>
        <label className="ctl check">
          <input type="checkbox" checked={p.showNames} onChange={(e) => p.onShowNames(e.target.checked)} />
          <span>Names</span>
        </label>
        <label className="ctl check" title="Idle agents take coffee breaks, chat and wander. Cosmetic only: their real status is unchanged and they hurry back when work arrives.">
          <input type="checkbox" checked={p.idleLife} onChange={(e) => p.onIdleLife(e.target.checked)} />
          <span>Idle life</span>
        </label>
        <button className="btn" onClick={p.onOpenTasks} title="Task board">
          Tasks{p.openTasks ? <span className="num">{p.openTasks}</span> : null}
        </button>
        <button className="btn" onClick={p.onOpenNotices} title="Notifications">
          Alerts{p.unread ? <span className="num alert">{p.unread}</span> : null}
        </button>
        <button className={`btn ${p.editMode ? 'active' : ''}`} onClick={p.onToggleEdit} aria-pressed={p.editMode}>
          {p.editMode ? 'Done editing' : 'Edit layout'}
        </button>
      </div>
    </header>
  );
}
