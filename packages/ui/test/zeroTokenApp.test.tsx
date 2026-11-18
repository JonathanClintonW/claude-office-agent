/**
 * Whole-app zero-inference run in jsdom. The real App and OfficeStore are fed by a local monitor
 * stand-in (same reducer; the REAL usage, history and git plugins in-process over temp directories),
 * and the PixiJS scene is a recorder (no WebGL in jsdom). Every network primitive throws when called
 * and no UI timer may outlive the unmount: the recorders are the evidence, not the token counter.
 *
 * Node built-ins come through process.getBuiltinModule and the plugins through runtime imports,
 * so the UI's DOM-only TypeScript program stays free of Node types.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createInitialState,
  defaultLayout,
  normalizeHookPayload,
  reduce,
  type ClientMessage,
  type MonitorEvent,
  type MonitorMeta,
  type OfficeLayout,
  type OfficeState,
  type ServerMessage,
} from '@agent-office/core';
import { App } from '../src/App';
import { StoreContext } from '../src/hooks';
import { OfficeStore } from '../src/store';
import type { HostInfo, Transport, TransportHandlers } from '../src/transport';

// Generous waits: the whole app renders here, and CI machines can be busy.
configure({ asyncUtilTimeout: 5000 });

const scene = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown[]]>,
  callbacks: null as null | { onSelect(k: string | null): void; onRoomClick?(id: string | null): void; onBoardClick(): void },
  instances: 0,
  destroyed: 0,
}));

vi.mock('../src/office/scene', () => {
  const record =
    (name: string, ret?: unknown) =>
    (...args: unknown[]) => {
      scene.calls.push([name, args]);
      return ret;
    };
  class FakeScene {
    constructor(_host: HTMLElement, cb: typeof scene.callbacks) {
      scene.callbacks = cb;
      scene.instances += 1;
    }
    init = () => Promise.resolve();
    destroy = () => {
      scene.destroyed += 1;
      scene.calls.push(['destroy', []]);
    };
    setLayout = record('setLayout');
    setWorkers = record('setWorkers');
    setSelected = record('setSelected');
    setShowNames = record('setShowNames');
    setEditMode = record('setEditMode');
    setIdleLife = record('setIdleLife');
    setVisitors = record('setVisitors');
    setSound = record('setSound');
    setOpenTasks = record('setOpenTasks');
    setHourOverride = record('setHourOverride');
    setAnimationFps = record('setAnimationFps');
    setReduceMotion = record('setReduceMotion');
    setRoomLabels = record('setRoomLabels');
    setIdleFrequency = record('setIdleFrequency');
    setDepartmentRules = record('setDepartmentRules');
    setActive = record('setActive');
    playCollabVisuals = record('playCollabVisuals');
    currentMeetings = () => [];
    focus = record('focus', true);
    fitView = record('fitView');
    zoomStep = record('zoomStep');
    panBy = record('panBy');
    centerOnTile = record('centerOnTile');
    getZoom = () => 2;
    minimapState = () => ({ zoom: 2, view: { x: 0, y: 0, w: 10, h: 8 }, workers: [] });
    roomOccupants = (id: string) => (id === 'research' ? [{ key: 'life-shop::ex1', name: 'Explore', status: 'working', simulated: false }] : []);
    roomDesks = () => ({ desks: 6, assigned: 1 });
    roomMeeting = () => undefined;
    startVisitorMeeting = () => 'ok';
  }
  return { OfficeScene: FakeScene };
});

const netCalls: string[] = [];
const restore: Array<() => void> = [];

function trap(obj: object, key: string, label: string): void {
  const o = obj as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(o, key);
  const orig = o[key];
  const fn = function (...args: unknown[]) {
    netCalls.push(`${label}(${String(args[0]).slice(0, 80)})`);
    throw new Error(`zero-token test: ${label} must not be called`);
  };
  Object.defineProperty(o, key, { value: fn, configurable: true, writable: true });
  restore.push(() => {
    if (had) Object.defineProperty(o, key, { value: orig, configurable: true, writable: true });
    else delete o[key];
  });
}

type Handle = ReturnType<typeof setTimeout>;
const realTimers = { setInterval, clearInterval, setTimeout, clearTimeout };
const uiTimers = new Map<Handle, { kind: string; where: string; done: boolean }>();
const UI_SRC = /packages[\\/]+ui[\\/]+src[\\/]+([^\s:)?]+)/;

/** File of the code that called the timer function (the frame right after this wrapper). */
const caller = () => UI_SRC.exec((new Error().stack ?? '').split('\n')[3] ?? '')?.[1];

function trackTimers(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.setInterval = function (fn: () => void, ms?: number) {
    const h = realTimers.setInterval(fn, ms);
    const where = caller();
    if (where) uiTimers.set(h, { kind: 'interval', where, done: false });
    return h;
  };
  g.setTimeout = function (fn: () => void, ms?: number) {
    const where = caller();
    const h: Handle = realTimers.setTimeout(() => {
      const t = uiTimers.get(h);
      if (t) t.done = true;
      fn();
    }, ms);
    if (where) uiTimers.set(h, { kind: 'timeout', where, done: false });
    return h;
  };
  const clear = (real: (h?: Handle) => void) =>
    function (h?: Handle) {
      const t = h !== undefined ? uiTimers.get(h) : undefined;
      if (t) t.done = true;
      real(h);
    };
  g.clearInterval = clear(realTimers.clearInterval);
  g.clearTimeout = clear(realTimers.clearTimeout);
  restore.push(() => Object.assign(globalThis, realTimers));
}

interface FsLike {
  mkdtempSync(prefix: string): string;
  mkdirSync(p: string, o: { recursive: true }): void;
  writeFileSync(p: string, data: string): void;
  rmSync(p: string, o: { recursive: true; force: true }): void;
}
interface PathLike {
  join(...parts: string[]): string;
}
const node = (id: string): unknown => (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown } }).process.getBuiltinModule(id);
const fs = node('node:fs') as FsLike;
const path = node('node:path') as PathLike;
const os = node('node:os') as { tmpdir(): string };
const url = node('node:url') as { fileURLToPath(u: string): string };

interface Plugin {
  name: string;
  start?(ctx: unknown): void | Promise<void>;
  stop?(): void | Promise<void>;
  onEvent?(ev: MonitorEvent, state: OfficeState): void;
  routes?: Record<string, (params: Record<string, unknown>) => unknown>;
  meta?(): unknown;
  scanNow?(): Promise<void>;
}

async function monitorPlugins(): Promise<{ usage: Plugin; history: Plugin; git: Plugin }> {
  // Not `new URL(relative, import.meta.url)`: Vite rewrites that pattern into an asset URL.
  const dir = url.fileURLToPath(import.meta.url.replace(/\/ui\/test\/[^/]+$/, '/monitor/src/plugins/')).replace(/\\/g, '/');
  const load = async (file: string, factory: string, opts?: unknown) => {
    const mod = (await import(/* @vite-ignore */ `${dir}${file}.ts`)) as Record<string, (o?: unknown) => Plugin>;
    return mod[factory]!(opts);
  };
  return { usage: await load('usage', 'usagePlugin'), history: await load('history', 'historyPlugin', { flushIntervalMs: 200 }), git: await load('git', 'gitPlugin') };
}

class LocalMonitor {
  state: OfficeState = createInitialState();
  layout: OfficeLayout = defaultLayout();
  private seq = 0;
  private routes = new Map<string, (p: Record<string, unknown>) => unknown>();
  private transports = new Set<FakeTransport>();
  rpcCalls: string[] = [];

  constructor(
    readonly plugins: Plugin[],
    private readonly ctx: Record<string, unknown>,
  ) {
    for (const p of plugins) for (const [r, h] of Object.entries(p.routes ?? {})) this.routes.set(`${p.name}.${r}`, h);
  }
  async start(): Promise<void> {
    for (const p of this.plugins) await p.start?.({ ...this.ctx, getState: () => this.state, getLayout: () => this.layout });
  }
  async stop(): Promise<void> {
    for (const p of [...this.plugins].reverse()) await p.stop?.();
  }
  meta(): MonitorMeta {
    const plugins: Record<string, unknown> = {};
    for (const p of this.plugins) if (p.meta) plugins[p.name] = p.meta();
    return { protocol: 1, monitorVersion: 'test', startedAt: Date.now(), claudeDirs: [], rejectedEvents: 0, spooledEventsReplayed: 0, plugins };
  }
  snapshot(): ServerMessage {
    return { type: 'snapshot', state: this.state, meta: this.meta(), layout: this.layout };
  }
  attach(t: FakeTransport): void {
    this.transports.add(t);
  }
  hook(payload: Record<string, unknown>, ts: number): void {
    const r = normalizeHookPayload({ v: 1, ts, payload }, Date.now());
    if (!r.ok) throw new Error(r.error);
    const ev = { ...r.event, seq: ++this.seq } as MonitorEvent;
    this.state = reduce(this.state, ev);
    for (const p of this.plugins) p.onEvent?.(ev, this.state);
    for (const t of this.transports) t.deliver({ type: 'events', events: [ev] });
  }
  async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.rpcCalls.push(method);
    const h = this.routes.get(method);
    if (!h) throw new Error(`unknown method ${method}`);
    return h(params);
  }
}

class FakeTransport implements Transport {
  readonly host: HostInfo = { kind: 'browser', workspaceFolders: [], canOpenFiles: false, canFocusClaude: false };
  private h?: TransportHandlers;
  inFlight = 0;
  disposed = false;
  constructor(private readonly monitor: LocalMonitor) {}
  connect(h: TransportHandlers): void {
    this.h = h;
    this.monitor.attach(this);
    h.onStatus('connecting');
    queueMicrotask(() => {
      h.onStatus('open');
      h.onMessage(this.monitor.snapshot());
    });
  }
  deliver(m: ServerMessage): void {
    if (!this.disposed) this.h?.onMessage(m);
  }
  send(msg: ClientMessage): void {
    if (msg.type === 'resync') this.deliver(this.monitor.snapshot());
    else if (msg.type === 'saveLayout') this.deliver({ type: 'layout', layout: msg.layout });
    else if (msg.type === 'rpc') {
      this.inFlight += 1;
      this.monitor.rpc(msg.method, msg.params ?? {}).then(
        (result) => this.deliver({ type: 'rpcResult', id: msg.id, ok: true, result }),
        (e: Error) => this.deliver({ type: 'rpcResult', id: msg.id, ok: false, error: e.message }),
      ).finally(() => (this.inFlight -= 1));
    }
  }
  openTranscript(): void {}
  focusClaude(): void {}
  installHooks(): void {}
  dispose(): void {
    this.disposed = true;
    this.h?.onStatus('closed');
  }
}

const S1 = 'life-shop';
const S2 = 'life-api';
const SHOP = 'c:\\work\\shop';
const API = 'c:\\work\\api-server';

function transcriptLines(): string {
  const asst = (id: string, model: string, tokens: [number, number, number, number]) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      cwd: SHOP,
      isSidechain: false,
      message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'SECRET-CONTENT' }], usage: { input_tokens: tokens[0], output_tokens: tokens[1], cache_creation_input_tokens: tokens[2], cache_read_input_tokens: tokens[3] } },
    });
  return [asst('msg-1', 'claude-opus-5-5', [120, 340, 50, 9000]), asst('msg-2', 'claude-opus-5-5', [80, 210, 0, 9100])].join('\n') + '\n';
}

function traffic(m: LocalMonitor, transcript: string): void {
  let t = Date.now() - 5 * 60_000;
  const h = (s: string, cwd: string, event: string, extra: Record<string, unknown> = {}) => m.hook({ session_id: s, cwd, transcript_path: s === S1 ? transcript : `${API}\\t.jsonl`, hook_event_name: event, ...extra }, (t += 500));
  h(S1, SHOP, 'SessionStart', { source: 'startup', model: 'claude-opus-5-5' });
  h(S1, SHOP, 'UserPromptSubmit', { prompt: '[dropped]' });
  for (const id of ['sp1', 'sp2']) h(S1, SHOP, 'PreToolUse', { tool_name: 'Agent', tool_use_id: id, tool_input: { subagent_type: 'Explore', description: `Look ${id}` } });
  for (const id of ['ex1', 'ex2']) h(S1, SHOP, 'SubagentStart', { agent_id: id, agent_type: 'Explore' });
  h(S1, SHOP, 'PreToolUse', { agent_id: 'ex1', agent_type: 'Explore', tool_name: 'Agent', tool_use_id: 'n1', tool_input: { subagent_type: 'test-runner', description: 'Run tests' } });
  h(S1, SHOP, 'SubagentStart', { agent_id: 'tr1', agent_type: 'test-runner' });
  h(S1, SHOP, 'PreToolUse', { agent_id: 'tr1', agent_type: 'test-runner', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } });
  h(S1, SHOP, 'PostToolUseFailure', { agent_id: 'tr1', agent_type: 'test-runner', tool_name: 'Bash', tool_use_id: 'b1', tool_input: {}, error: 'Exit code 1: 2 failing tests' });
  h(S1, SHOP, 'TaskCreated', { agent_id: 'tm-alice', task_id: 't1', task_subject: 'Fix totals', teammate_name: 'alice', team_name: 'shop' });
  h(S1, SHOP, 'TaskCompleted', { agent_id: 'tm-alice', task_id: 't1', task_subject: 'Fix totals', teammate_name: 'alice', team_name: 'shop' });
  h(S1, SHOP, 'TeammateIdle', { agent_id: 'tm-alice', teammate_name: 'alice', team_name: 'shop' });
  h(S1, SHOP, 'SubagentStop', { agent_id: 'ex2', agent_type: 'Explore', last_assistant_message: 'SECRET-ANSWER' });
  h(S1, SHOP, 'PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: `${SHOP}\\a.ts` } });
  h(S2, API, 'SessionStart', { source: 'startup' });
  h(S2, API, 'UserPromptSubmit', {});
  h(S2, API, 'PreToolUse', { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: `${API}\\x.ts` } });
  h(S2, API, 'PostToolUse', { tool_name: 'Read', tool_use_id: 'r1', tool_input: {}, tool_response: { success: true } });
  h(S2, API, 'Stop', { last_assistant_message: 'SECRET-ANSWER' });
}

/** A delegation happening now (recent evidence is what the office animates). */
function liveSpawn(m: LocalMonitor): void {
  const now = Date.now();
  const h = (event: string, extra: Record<string, unknown>, ts: number) => m.hook({ session_id: S2, cwd: API, hook_event_name: event, ...extra }, ts);
  h('UserPromptSubmit', {}, now - 400);
  h('PreToolUse', { tool_name: 'Agent', tool_use_id: 'pl-spawn', tool_input: { subagent_type: 'Plan', description: 'Plan the API change' } }, now - 300);
  h('SubagentStart', { agent_id: 'pl1', agent_type: 'Plan' }, now - 200);
}

const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'AGENT_OFFICE_HOME'] as const;
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const savedEnv: Partial<Record<string, string | undefined>> = {};
let sandbox = '';

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-test-ztapp-'));
  for (const k of ENV_KEYS) savedEnv[k] = env[k];
  env.HOME = env.USERPROFILE = path.join(sandbox, 'user');
  env.CLAUDE_CONFIG_DIR = path.join(sandbox, 'user', '.claude');
  env.AGENT_OFFICE_HOME = path.join(sandbox, 'user', '.agent-office');
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Worker', 'SharedWorker', 'RTCPeerConnection']) trap(g, k, k);
  trap(navigator, 'sendBeacon', 'navigator.sendBeacon');
  trap(window, 'open', 'window.open');
  trap(HTMLFormElement.prototype, 'submit', 'form.submit');
  trackTimers();
  // jsdom has no layout, so offsetParent is always null; model the browser closely enough for
  // the office's "only while visible" polling: null inside a hidden subtree, else the parent.
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      for (let e: HTMLElement | null = this; e; e = e.parentElement) if (e.hidden) return null;
      return this.parentElement;
    },
  });
  restore.push(() => {
    if (desc) Object.defineProperty(HTMLElement.prototype, 'offsetParent', desc);
  });
});

afterAll(() => {
  cleanup();
  for (const r of restore.splice(0).reverse()) r();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete env[k];
    else env[k] = savedEnv[k];
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const lastWorkers = () => {
  const calls = scene.calls.filter(([n]) => n === 'setWorkers');
  return (calls.at(-1)?.[1][0] ?? []) as Array<{ key: string; kind: string; parentKey?: string; agentType?: string }>;
};
const tab = (label: string) => within(screen.getByRole('navigation', { name: 'Views' })).getByRole('button', { name: new RegExp(`^${label}`) });
async function openTab(label: string): Promise<HTMLElement> {
  fireEvent.click(tab(label));
  await waitFor(() => expect(tab(label).getAttribute('aria-current')).toBe('page'));
  return document.querySelector('section.stage-page') as HTMLElement;
}

describe('the whole app runs with zero network calls (zero office inference)', () => {
  it('start-up, subagents, every tab, inspector, departments, analytics, history, replay and shutdown', async () => {
    const home = path.join(sandbox, 'office-home');
    const claude = path.join(sandbox, 'claude');
    const projectDir = path.join(claude, 'projects', 'c--work-shop');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    const transcript = path.join(projectDir, `${S1}.jsonl`);
    fs.writeFileSync(transcript, transcriptLines());

    const plugins = await monitorPlugins();
    const monitor = new LocalMonitor([plugins.usage, plugins.history, plugins.git], { home, claudeDirs: [claude], now: () => Date.now(), log: () => {} });
    await monitor.start();
    const transport = new FakeTransport(monitor);
    const store = new OfficeStore(transport);
    store.start();

    // ---- start-up
    const view = render(
      <StoreContext.Provider value={store}>
        <App />
      </StoreContext.Provider>,
    );
    await waitFor(() => expect(store.getSnapshot().synced).toBe(true));
    expect(scene.instances).toBe(1);
    expect(screen.getByTestId('office-canvas')).toBeTruthy();

    // ---- live traffic: parallel and nested subagents, teammates, a second project
    await act(async () => traffic(monitor, transcript));
    // ex2 finished minutes ago (event time), so it is past the 15 s linger and not shown.
    await waitFor(() => expect(lastWorkers().length).toBe(Object.keys(monitor.state.agents).length - 1));
    const workers = lastWorkers();
    expect(new Set(workers.map((w) => w.key)).size).toBe(workers.length);
    expect(workers.find((w) => w.key === `${S1}::tr1`)).toMatchObject({ kind: 'subagent', parentKey: `${S1}::ex1`, agentType: 'test-runner' });
    expect(workers.find((w) => w.key === `${S1}::tm-alice`)).toMatchObject({ kind: 'teammate' });
    // A delegation happening now flies from the parent's desk to the new subagent's desk.
    await act(async () => liveSpawn(monitor));
    await waitFor(() => expect(lastWorkers().some((w) => w.key === `${S2}::pl1` && w.parentKey === S2)).toBe(true));
    const flights = scene.calls.filter(([n]) => n === 'playCollabVisuals').flatMap(([, a]) => a[0] as Array<{ kind: string; from: string; to: string }>);
    expect(flights).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'delegate', from: S2, to: `${S2}::pl1` })]));

    // ---- inspector from the agent list
    const list = screen.getByRole('list', { name: 'Agents' });
    fireEvent.click(within(list).getAllByRole('button').find((b) => /test-runner/i.test(b.textContent ?? ''))!);
    const inspector = await screen.findByRole('region', { name: /Details for/ });
    expect(within(inspector).queryAllByText(/Exit code 1/).length).toBeGreaterThan(0);
    fireEvent.click(within(inspector).getByLabelText('Close details'));

    // ---- department rooms and mini-map navigation in the office
    await act(async () => scene.callbacks!.onRoomClick!('research'));
    const card = await screen.findByRole('dialog', { name: 'Research information' });
    expect(within(card).getByText(/Department room/)).toBeTruthy();
    fireEvent.click(within(card).getByLabelText('Close room information'));
    await waitFor(() => expect(screen.getByTestId('minimap')).toBeTruthy());
    fireEvent.click(screen.getByTestId('minimap'), { clientX: 10, clientY: 10 });
    expect(scene.calls.some(([n]) => n === 'centerOnTile')).toBe(true);

    // ---- every dashboard tab
    let page = await openTab('Tasks');
    expect(page.textContent).toMatch(/Fix totals/);
    page = await openTab('Errors');
    await waitFor(() => expect(page.textContent).toMatch(/Bash failed|failing tests/));
    page = await openTab('Git');
    await waitFor(() => expect(page.textContent?.trim().length).toBeGreaterThan(0));
    await plugins.usage.scanNow?.();
    page = await openTab('Analytics');
    // Token analytics come from the transcript, read by the real usage plugin.
    await waitFor(() => expect(within(page).getByRole('table', { name: 'Usage by session' }).textContent).toMatch(/shop|life-shop/i), { timeout: 5000 });
    page = await openTab('History');
    const sessions = await within(page).findByRole('table', { name: 'Recorded sessions' }, { timeout: 5000 });
    fireEvent.click(within(sessions).getAllByRole('button')[0]!);
    // Replay of the journaled events, through history.events.
    await within(page).findByRole('group', { name: 'Replay controls' }, { timeout: 5000 });
    fireEvent.click(within(page).getByLabelText('Next event'));
    fireEvent.click(within(page).getByLabelText('Play'));
    await new Promise((r) => realTimers.setTimeout(r, 350));
    fireEvent.click(within(page).getByLabelText('Pause'));
    page = await openTab('Team');
    expect(within(page).getAllByRole('article').length).toBeGreaterThan(0);
    page = await openTab('Settings');
    const rulesBefore = scene.calls.filter(([n]) => n === 'setDepartmentRules').length;
    fireEvent.click(within(page).getByRole('button', { name: /Add rule/i }));
    await waitFor(() => expect(scene.calls.filter(([n]) => n === 'setDepartmentRules').length).toBeGreaterThan(rulesBefore));
    await openTab('Office');
    expect(scene.calls.filter(([n]) => n === 'setActive').map(([, a]) => a[0])).toEqual(expect.arrayContaining([false, true]));

    // ---- a second of idle operation (the root clock and the mini-map poll tick)
    await new Promise((r) => realTimers.setTimeout(r, 1200));
    expect(monitor.rpcCalls).toEqual(expect.arrayContaining(['usage.summary', 'history.summary', 'history.sessions', 'history.events', 'git.repos']));

    // ---- shutdown: unmount the app, then stop the plugins
    await waitFor(() => expect(transport.inFlight).toBe(0));
    view.unmount();
    expect(scene.destroyed).toBe(scene.instances); // the office and the replay's office are both torn down
    transport.dispose();
    await monitor.stop();
    // Pending store RPC timeouts are settled by the answers above; everything else is cleared.
    const live = [...uiTimers.values()].filter((t) => !t.done).map((t) => `${t.kind} from ${t.where}`);
    const byFile: Record<string, number> = {};
    for (const t of uiTimers.values()) byFile[`${t.kind} ${t.where}`] = (byFile[`${t.kind} ${t.where}`] ?? 0) + 1;
    console.log(`[zero-token-app] ${JSON.stringify({ rpc: [...new Set(monitor.rpcCalls)].sort(), uiTimers: byFile, sceneCalls: scene.calls.length, netCalls: netCalls.length })}`);
    expect(live).toEqual([]);
    expect([...uiTimers.values()].some((t) => t.kind === 'interval')).toBe(true); // tracking was not vacuous
    expect(netCalls).toEqual([]);
  }, 30_000);

  it('the recorders are live (a call would have been caught)', () => {
    expect(() => (globalThis as unknown as { fetch: (u: string) => unknown }).fetch('https://example.invalid/')).toThrow(/must not be called/);
    expect(() => new (globalThis as unknown as { WebSocket: new (u: string) => unknown }).WebSocket('wss://example.invalid/')).toThrow(/must not be called/);
    expect(netCalls).toEqual(['fetch(https://example.invalid/)', 'WebSocket(wss://example.invalid/)']);
    netCalls.length = 0;
  });
});
