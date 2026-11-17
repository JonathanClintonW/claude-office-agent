import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TERMINAL_STATUSES, type OfficeLayout } from '@agent-office/core';
import { AgentList } from './components/AgentList';
import { InferenceBadge } from './components/InferenceBadge';
import { Inspector } from './components/Inspector';
import { LayoutEditor } from './components/LayoutEditor';
import { NavTabs } from './components/NavTabs';
import { NotificationCenter, Toasts } from './components/Notifications';
import { OfficeView, type OfficeViewHandle } from './components/OfficeView';
import { detectIssues } from './errors';
import { SourcesBanner } from './components/SourcesBanner';
import { TaskBoard } from './components/TaskBoard';
import { TopBar } from './components/TopBar';
import { useNow, useOffice, usePersistentState, useStoreInstance } from './hooks';
import { applyTool, moveItem, type EditResult, type EditTool } from './layoutEdit';
import { filterAgents, toWorkerViews, workspaceKey, workspaceOptions, type Filters } from './view';
import { AnalyticsView } from './views/AnalyticsView';
import { ErrorsView } from './views/ErrorsView';
import { GitView } from './views/GitView';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';
import { TeamView } from './views/TeamView';
import type { ViewId, ViewProps } from './views/types';

type Panel = 'none' | 'notices';

export function App() {
  const store = useStoreInstance();
  const snap = useOffice();
  const now = useNow(1000);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('none');
  const [view, setView] = usePersistentState<ViewId>('view', 'office');
  const [filters, setFilters] = usePersistentState<Filters>('filters', { workspace: 'all', showEnded: false });
  const [showNames, setShowNames] = usePersistentState('showNames', false);
  const [idleLife, setIdleLife] = usePersistentState('idleLife', true);
  const [readIds, setReadIds] = usePersistentState<string[]>('readNotices', []);
  const [draft, setDraft] = useState<OfficeLayout | null>(null);
  const [tool, setTool] = useState<EditTool>('desk');
  const [editError, setEditError] = useState<string | undefined>();
  const folders = snap.host.workspaceFolders;
  const transport = store.transportRef;

  // In VS Code, optionally start filtered to this window's workspace.
  useEffect(() => {
    if (snap.host.kind === 'vscode' && snap.host.showOnlyCurrentWorkspace && folders.length === 1 && filters.workspace === 'all') {
      const opts = workspaceOptions(snap.state, folders);
      const mine = opts.find((o) => o.key.toLowerCase() === folders[0]!.toLowerCase().replace(/\//g, '\\'));
      if (mine) setFilters({ ...filters, workspace: mine.key });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.host]);

  // Ended agents linger 15 s (filterAgents uses the clock), so re-filter on a coarse 5 s clock too.
  const lingerClock = Math.floor(now / 5000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const agents = useMemo(() => filterAgents(snap.state, filters, folders), [snap.state, filters, folders, lingerClock]);
  const workers = useMemo(() => toWorkerViews(agents), [agents]);
  const workspaces = useMemo(() => workspaceOptions(snap.state, folders), [snap.state, folders]);
  const sessionKeys = useMemo(() => new Set(agents.filter((a) => a.kind === 'session').map((a) => a.sessionId)), [agents]);
  const openTasks = Object.values(snap.state.tasks).filter((t) => t.status === 'open' && !t.orphaned && sessionKeys.has(t.sessionId)).length;
  const read = useMemo(() => new Set(readIds), [readIds]);
  const unread = snap.state.notices.filter((n) => n.severity !== 'info' && !read.has(n.id)).length;
  const sel = selected ? snap.state.agents[selected] : undefined;
  // Ongoing errors (failed agents, blocked permissions…) for the Errors tab badge; refreshed every 5 s.
  const ongoingErrors = useMemo(
    () => detectIssues(snap.state, Date.now()).filter((i) => i.severity === 'error' && i.ongoing).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snap.state, lingerClock],
  );
  const office = useRef<OfficeViewHandle>(null);

  const select = useCallback(
    (key: string | null) => {
      setSelected(key);
      if (key && filters.workspace !== 'all') {
        const a = snap.state.agents[key];
        if (a && workspaceKey(snap.state, a, folders) !== filters.workspace) setFilters({ ...filters, workspace: 'all' });
      }
    },
    [filters, folders, setFilters, snap.state],
  );

  const applyEdit = (r: EditResult) => {
    if (r.ok) {
      setDraft(r.layout);
      setEditError(undefined);
    } else setEditError(r.error);
  };

  const editing = draft !== null;
  const layoutDirty = useMemo(() => draft !== null && JSON.stringify(draft) !== JSON.stringify(snap.layout), [draft, snap.layout]);
  const toggleEdit = () => {
    if (editing) {
      setDraft(null);
      setEditError(undefined);
    } else {
      setDraft(snap.layout);
      setSelected(null);
    }
  };

  return (
    <div className="app">
      <TopBar
        agents={agents.filter((a) => !TERMINAL_STATUSES.has(a.status))}
        connection={snap.connection}
        connectionDetail={snap.connectionDetail}
        filters={filters}
        workspaces={workspaces}
        showNames={showNames}
        editMode={editing}
        unread={unread}
        openTasks={openTasks}
        onFilters={setFilters}
        onShowNames={setShowNames}
        idleLife={idleLife}
        onIdleLife={setIdleLife}
        onToggleEdit={toggleEdit}
        onOpenTasks={() => setView('tasks')}
        onOpenNotices={() => setPanel('notices')}
      />
      <SourcesBanner
        meta={snap.meta}
        connection={snap.connection}
        connectionDetail={snap.connectionDetail}
        synced={snap.synced}
        isVSCode={snap.host.kind === 'vscode'}
        onInstallHooks={() => transport.installHooks()}
      />
      {snap.lastError ? <div className="banner warn">{snap.lastError}</div> : null}
      <div className="navrow">
        <NavTabs view={view} onView={setView} badges={{ tasks: openTasks || undefined, errors: ongoingErrors || undefined }} />
        <InferenceBadge meta={snap.meta} />
      </div>
      <main className="main">
        {view !== 'office' ? (
          <section className="stage-page">
            {(() => {
              const props: ViewProps = { snap, now, onSelectAgent: (k) => select(k) };
              switch (view) {
                case 'tasks':
                  return <TaskBoard inline state={snap.state} sessionKeys={sessionKeys} now={now} onSelect={(k) => select(k)} onClose={() => setView('office')} />;
                case 'errors':
                  return <ErrorsView {...props} />;
                case 'git':
                  return <GitView {...props} />;
                case 'analytics':
                  return <AnalyticsView {...props} />;
                case 'history':
                  return <HistoryView {...props} />;
                case 'team':
                  return <TeamView {...props} meetings={office.current?.currentMeetings() ?? []} />;
                case 'settings':
                  return <SettingsView {...props} />;
                default:
                  return null;
              }
            })()}
          </section>
        ) : null}
        {/* The office stays mounted (hidden) so the simulation is not reset when switching views. */}
        <section className={`office ${snap.connection !== 'open' ? 'offline' : ''}`} hidden={view !== 'office'}>
          <OfficeView
            ref={office}
            active={view === 'office'}
            collabState={snap.state}
            layout={draft ?? snap.layout}
            workers={workers}
            selected={selected}
            showNames={showNames}
            editMode={editing}
            idleLife={idleLife}
            openTasks={openTasks}
            onSelect={select}
            onBoardClick={() => setView('tasks')}
            onTileClick={(x, y) => draft && applyEdit(applyTool(draft, tool, x, y))}
            onItemMove={(id, x, y) => draft && applyEdit(moveItem(draft, id, x, y))}
          />
          {!snap.synced ? <div className="office-overlay">Waiting for the monitor…</div> : null}
        </section>
        <aside className="sidebar">
          {draft ? (
            <LayoutEditor
              draft={draft}
              tool={tool}
              error={editError}
              dirty={layoutDirty}
              onTool={setTool}
              onChange={applyEdit}
              onSave={() => {
                store.send({ type: 'saveLayout', layout: draft });
                setDraft(null);
              }}
              onCancel={() => {
                setDraft(null);
                setEditError(undefined);
              }}
            />
          ) : sel ? (
            <Inspector
              key={sel.key}
              agent={sel}
              state={snap.state}
              now={now}
              host={snap.host}
              onSelect={select}
              onClose={() => setSelected(null)}
              onOpenTranscript={(p) => transport.openTranscript(p)}
              onFocusClaude={() => transport.focusClaude()}
            />
          ) : (
            <AgentList state={snap.state} agents={agents} selected={selected} now={now} onSelect={select} />
          )}
        </aside>
      </main>
      {panel === 'notices' ? (
        <NotificationCenter
          state={snap.state}
          read={read}
          now={now}
          onSelect={select}
          onMarkAll={() => setReadIds(snap.state.notices.map((n) => n.id))}
          onClose={() => {
            setReadIds(snap.state.notices.map((n) => n.id));
            setPanel('none');
          }}
        />
      ) : null}
      <Toasts state={snap.state} onSelect={select} />
    </div>
  );
}
