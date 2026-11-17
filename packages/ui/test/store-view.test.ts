import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  defaultLayout,
  normalizeHookPayload,
  reduce,
  type ClientMessage,
  type MonitorEvent,
  type MonitorMeta,
  type Notice,
  type OfficeState,
  type ServerMessage,
} from '@agent-office/core';
import { OfficeStore } from '../src/store';
import type { HostInfo, Transport, TransportHandlers } from '../src/transport';
import { filterAgents, toWorkerViews, workspaceOptions } from '../src/view';

class FakeTransport implements Transport {
  host: HostInfo = { kind: 'browser', workspaceFolders: [], canOpenFiles: false, canFocusClaude: false };
  sent: ClientMessage[] = [];
  h?: TransportHandlers;
  connect(h: TransportHandlers) {
    this.h = h;
  }
  send(m: ClientMessage) {
    this.sent.push(m);
  }
  emit(m: ServerMessage) {
    this.h!.onMessage(m);
  }
  openTranscript() {}
  focusClaude() {}
  installHooks() {}
  dispose() {}
}

const meta: MonitorMeta = { protocol: 1, monitorVersion: 't', startedAt: 0, claudeDirs: [], rejectedEvents: 0, spooledEventsReplayed: 0 };

let seq = 0;
function ev(raw: Record<string, unknown>, ts = Date.now()): MonitorEvent {
  const r = normalizeHookPayload({ session_id: 's1', cwd: 'c:\\work\\app', ...raw }, ts);
  if (!r.ok) throw new Error(r.error);
  return { ...r.event, seq: ++seq };
}

describe('OfficeStore', () => {
  it('applies sequenced events on top of the snapshot', () => {
    seq = 0;
    const t = new FakeTransport();
    const store = new OfficeStore(t);
    store.start();
    t.emit({ type: 'snapshot', state: createInitialState(), meta, layout: defaultLayout() });
    t.emit({ type: 'events', events: [ev({ hook_event_name: 'SessionStart' }), ev({ hook_event_name: 'UserPromptSubmit' })] });
    expect(store.getSnapshot().state.agents.s1!.status).toBe('working');
    expect(store.getSnapshot().synced).toBe(true);
  });

  it('ignores duplicates and requests a resync on a sequence gap instead of guessing', () => {
    seq = 0;
    const t = new FakeTransport();
    const store = new OfficeStore(t);
    store.start();
    t.emit({ type: 'snapshot', state: createInitialState(), meta, layout: defaultLayout() });
    const e1 = ev({ hook_event_name: 'SessionStart' });
    t.emit({ type: 'events', events: [e1] });
    t.emit({ type: 'events', events: [e1] }); // duplicate
    expect(store.getSnapshot().state.lastSeq).toBe(1);
    seq = 5;
    t.emit({ type: 'events', events: [ev({ hook_event_name: 'UserPromptSubmit' })] });
    expect(t.sent).toEqual([{ type: 'resync' }]);
    expect(store.getSnapshot().state.agents.s1!.status).toBe('idle'); // unchanged until resync
  });

  it('ignores events before the first snapshot', () => {
    seq = 0;
    const t = new FakeTransport();
    const store = new OfficeStore(t);
    store.start();
    t.emit({ type: 'events', events: [ev({ hook_event_name: 'SessionStart' })] });
    expect(store.getSnapshot().state.agents).toEqual({});
  });

  it('reports only live notices to listeners (not those already in the snapshot)', () => {
    seq = 0;
    let s: OfficeState = createInitialState();
    const failure = ev({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'x', tool_input: {}, error: 'boom' });
    s = reduce(s, failure);
    const t = new FakeTransport();
    const store = new OfficeStore(t);
    const got: Notice[][] = [];
    store.onNotices((n) => got.push(n));
    store.start();
    t.emit({ type: 'snapshot', state: s, meta, layout: defaultLayout() });
    t.emit({ type: 'events', events: [ev({ hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: {} })] });
    expect(got).toHaveLength(1);
    expect(got[0]!.map((n) => n.kind)).toEqual(['permission']);
  });
});

describe('view helpers', () => {
  function stateWith(): OfficeState {
    seq = 0;
    let s = createInitialState();
    s = reduce(s, ev({ hook_event_name: 'SessionStart', cwd: 'C:\\Work\\Acme\\api' }));
    s = reduce(s, ev({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore', cwd: 'C:\\Work\\Acme\\api' }));
    s = reduce(s, ev({ hook_event_name: 'SessionStart', session_id: 's2', cwd: 'c:\\other' }));
    s = reduce(s, ev({ hook_event_name: 'SessionEnd', session_id: 's3', cwd: 'c:\\gone' }, Date.now() - 60_000));
    return s;
  }

  it('groups agents by VS Code workspace folder (case-insensitive on Windows)', () => {
    const s = stateWith();
    const opts = workspaceOptions(s, ['c:\\work\\acme']);
    const acme = opts.find((o) => o.label === 'acme')!;
    expect(acme.count).toBe(1);
    const filtered = filterAgents(s, { workspace: acme.key, showEnded: false }, ['c:\\work\\acme']);
    // the subagent inherits its session's workspace
    expect(filtered.map((a) => a.key).sort()).toEqual(['s1', 's1::a1']);
  });

  it('hides long-ended agents unless requested', () => {
    const s = stateWith();
    expect(filterAgents(s, { workspace: 'all', showEnded: false }, []).some((a) => a.sessionId === 's3')).toBe(false);
    expect(filterAgents(s, { workspace: 'all', showEnded: true }, []).some((a) => a.sessionId === 's3')).toBe(true);
  });

  it('builds worker views with simulation and terminal markers', () => {
    const s = stateWith();
    const views = toWorkerViews(Object.values(s.agents));
    expect(views.find((v) => v.key === 's1::a1')).toMatchObject({ kind: 'subagent', parentKey: 's1', simulated: false });
    expect(views.find((v) => v.key === 's3')!.terminalAt).toBeDefined();
  });
});
