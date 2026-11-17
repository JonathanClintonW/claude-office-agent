/**
 * Subagent lifecycle through the REAL monitor: createMonitor with defaultPlugins(), hook payloads
 * POSTed over HTTP on a random port, WebSocket mirrors (MirrorClient, and the UI's own OfficeStore
 * over its WebSocketTransport), then the UI's pure view functions (toWorkerViews, departmentFor,
 * assignDesks) and the history/replay path on the mirrored state.
 *
 * Covered, in one ordered stream:
 *  - a spawn linked to its Agent tool call (parentVia spawn-tool, spawnToolUseId);
 *  - three parallel subagents of the same type, matched to their spawn calls in order;
 *  - a nested subagent spawned by a subagent;
 *  - agent-team teammates: TaskCreated/TaskCompleted with teammate_name, TeammateIdle with and
 *    without agent_id;
 *  - two sessions in different projects that reuse the same agent_id (keys stay per session);
 *  - duplicate delivery: an identical envelope POSTed twice and a spooled copy of a delivered event
 *    are dropped by the deduper and counted in meta.duplicatesDropped;
 *  - SessionEnd while children are still running (children end, open tasks are orphaned);
 *  - a mirror that disconnects and one that joins mid-stream converge to the monitor's state;
 *  - a monitor restart on the same port and home: the UI transport reconnects on its own and the
 *    store converges again; history survives the restart;
 *  - stop() clears every interval and timeout the monitor and its plugins created.
 *
 * Meeting participation, capacity and interruption are unit-tested in
 * packages/ui/test/meetings.test.ts and are not repeated here.
 *
 * The UI modules are imported at runtime (non-literal specifiers) so the monitor's Node-only
 * TypeScript program does not pull in DOM-typed UI sources; the shapes used are declared below.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentKeyFor, defaultLayout, TOKEN_HEADER, type Agent, type MonitorEvent, type MonitorMeta, type OfficeLayout, type OfficeState, type ServerMessage } from '@agent-office/core';
import { loadOrCreateConfig } from '../src/config';
import { defaultPlugins } from '../src/plugins';
import { createMonitor, type Monitor } from '../src/server';
import { appendToSpool } from '../src/spool';
import { freePort, http, MirrorClient, sleep, tempDir } from './helpers';

// ---------------------------------------------------------------- UI shapes (runtime imports)

interface UiWorkerView {
  key: string;
  name: string;
  kind: Agent['kind'];
  sessionId: string;
  parentKey?: string;
  agentType?: string;
  cwd?: string;
  status: Agent['status'];
}
interface UiDepartmentRule {
  id: string;
  department: string;
  field: 'agentType' | 'cwd' | 'name';
  pattern: string;
}
interface UiSeat {
  deskId: string;
  roomKind?: string;
}
interface UiSnapshot {
  state: OfficeState;
  meta?: MonitorMeta;
  connection: string;
  synced: boolean;
}
interface UiStore {
  start(): void;
  subscribe(l: () => void): () => void;
  getSnapshot(): UiSnapshot;
  rpc<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}
interface UiTransport {
  dispose(): void;
}
interface UiModules {
  view: {
    toWorkerViews(agents: readonly Agent[]): UiWorkerView[];
    filterAgents(state: OfficeState, filters: { workspace: string; showEnded: boolean }, folders: readonly string[]): Agent[];
    workspaceOptions(state: OfficeState, folders: readonly string[]): Array<{ key: string; count: number }>;
  };
  departments: { departmentFor(subject: { agentType?: string; cwd?: string; name?: string }, rules: readonly UiDepartmentRule[]): string };
  settings: { defaultSettings(): { departmentRules: UiDepartmentRule[] } };
  grid: {
    seatsOf(layout: OfficeLayout): UiSeat[];
    assignDesks(prev: ReadonlyMap<string, string | null>, agents: ReadonlyArray<{ key: string; parentKey?: string; cwd?: string; department?: string }>, seats: readonly UiSeat[]): Map<string, string | null>;
  };
  store: { OfficeStore: new (transport: UiTransport) => UiStore };
  transport: { WebSocketTransport: new (url: string) => UiTransport };
  replay: {
    fetchSessionEvents(rpc: (m: string, p: Record<string, unknown>) => Promise<unknown>, sessionId: string): Promise<{ events: MonitorEvent[]; total: number; truncated: boolean }>;
    buildReplay(events: readonly MonitorEvent[]): { cursor: { state: OfficeState }; events: readonly MonitorEvent[] };
  };
}

async function loadUi(): Promise<UiModules> {
  const base = join(__dirname, '..', '..', 'ui', 'src').replace(/\\/g, '/');
  const load = (p: string) => import(/* @vite-ignore */ `${base}/${p}.ts`);
  return {
    view: await load('view'),
    departments: await load('departments'),
    settings: await load('settings'),
    grid: await load('office/grid'),
    store: await load('store'),
    transport: await load('transport'),
    replay: await load('replay'),
  } as UiModules;
}

// ---------------------------------------------------------------- timer tracking (monitor sources only)

type Handle = ReturnType<typeof setTimeout>;
interface Tracked {
  kind: 'interval' | 'timeout';
  where: string;
  done: boolean;
}
const tracked = new Map<Handle, Tracked>();
const FROM_MONITOR = /packages[\\/]+monitor[\\/]+src[\\/]+([^\s:)]+)/;
const realTimers = { setInterval, clearInterval, setTimeout, clearTimeout };

function trackTimers(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const origin = (): string | undefined => {
    const stack = new Error().stack ?? '';
    // Frames: [0] Error, [1] origin, [2] the wrapper, [3] the code that called the timer function.
    return FROM_MONITOR.exec(stack.split('\n')[3] ?? '')?.[1];
  };
  g.setInterval = function (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) {
    const h = realTimers.setInterval(fn, ms, ...args);
    const where = origin();
    if (where) tracked.set(h, { kind: 'interval', where, done: false });
    return h;
  };
  g.setTimeout = function (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) {
    const where = origin();
    const h: Handle = realTimers.setTimeout(
      (...a: unknown[]) => {
        const t = tracked.get(h);
        if (t) t.done = true;
        fn(...a);
      },
      ms,
      ...args,
    );
    if (where) tracked.set(h, { kind: 'timeout', where, done: false });
    return h;
  };
  g.clearInterval = function (h?: Handle) {
    const t = h && tracked.get(h);
    if (t) t.done = true;
    return realTimers.clearInterval(h);
  };
  g.clearTimeout = function (h?: Handle) {
    const t = h && tracked.get(h);
    if (t) t.done = true;
    return realTimers.clearTimeout(h);
  };
}

function restoreTimers(): void {
  Object.assign(globalThis, realTimers);
}

const liveTimers = () => [...tracked.values()].filter((t) => !t.done).map((t) => `${t.kind} from ${t.where}`);

// ---------------------------------------------------------------- traffic

const SHOP = 'c:\\work\\shop';
const API = 'c:\\work\\api-server';
const S1 = 'life-shop-0001';
const S2 = 'life-api-0002';

class Poster {
  t = Date.now() - 10 * 60_000;
  constructor(
    private readonly port: () => number,
    private readonly token: string,
  ) {}
  envelope(session: string, cwd: string, event: string, extra: Record<string, unknown> = {}, dt = 200) {
    this.t += dt;
    return { v: 1, ts: this.t, payload: { session_id: session, cwd, transcript_path: `${cwd}\\.t\\${session}.jsonl`, permission_mode: 'default', hook_event_name: event, ...extra } };
  }
  async send(body: unknown): Promise<number> {
    const r = await http(this.port(), { method: 'POST', path: '/api/hook', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: this.token }, body: JSON.stringify(body) });
    return r.status;
  }
  async post(session: string, cwd: string, event: string, extra: Record<string, unknown> = {}): Promise<ReturnType<Poster['envelope']>> {
    const env = this.envelope(session, cwd, event, extra);
    expect(await this.send(env)).toBe(204);
    return env;
  }
}

const tool = async (p: Poster, s: string, cwd: string, id: string, name: string, input: Record<string, unknown>, who: Record<string, unknown> = {}) => {
  await p.post(s, cwd, 'PreToolUse', { tool_name: name, tool_use_id: id, tool_input: input, ...who });
  await p.post(s, cwd, 'PostToolUse', { tool_name: name, tool_use_id: id, tool_input: input, tool_response: { success: true }, ...who });
};

async function until(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Fields of an agent that must agree between the monitor, a mirror and a replay. */
const shape = (a: Agent | undefined) => (a ? { key: a.key, kind: a.kind, parentKey: a.parentKey, parentVia: a.parentVia, status: a.status, agentType: a.agentType, teammateName: a.teammateName, sessionId: a.sessionId } : undefined);

// ---------------------------------------------------------------- test

const sandbox = tempDir('life-sandbox');
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'AGENT_OFFICE_HOME'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const summary: Record<string, unknown> = {};

describe('subagent lifecycle through the real monitor (HTTP ingest, WebSocket mirrors, UI views)', () => {
  let ui: UiModules;
  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const home = join(sandbox.path, 'user');
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
    process.env.AGENT_OFFICE_HOME = join(home, '.agent-office');
    ui = await loadUi();
    trackTimers();
  });

  afterAll(() => {
    restoreTimers();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    sandbox.cleanup();
    console.log(`[lifecycle] ${JSON.stringify(summary)}`);
  });

  it('spawns, parallel and nested subagents, teammates, two projects, duplicates, SessionEnd, reconnects and a restart', async () => {
    const home = join(sandbox.path, 'office-home');
    const claude = join(sandbox.path, 'claude');
    mkdirSync(claude, { recursive: true });
    const port = await freePort();
    const token = loadOrCreateConfig(home, { port }).token;
    const logs: string[] = [];
    // No periodic Tick or spool drain during the run: every sequenced event below is one this test sent,
    // so sequence deltas are exact (the duplicate checks count them).
    const make = () =>
      createMonitor({ home, port, token, claudeDirs: [claude], discovery: false, plugins: defaultPlugins(), tickIntervalMs: 3_600_000, metaIntervalMs: 200, spoolIntervalMs: 3_600_000, log: (m) => logs.push(m) });
    let monitor: Monitor = make();
    await monitor.start();
    const p = new Poster(() => monitor.port, token);
    const clients: MirrorClient[] = [];
    const mirror = async () => {
      const c = new MirrorClient(monitor.port, token);
      clients.push(c);
      await c.opened();
      await c.waitFor((x) => x.messages.some((m) => m.type === 'snapshot'), 5000);
      return c;
    };
    // The UI's own store and transport (Node's global WebSocket), reconnecting by itself.
    const transport = new ui.transport.WebSocketTransport(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const store = new ui.store.OfficeStore(transport);
    const statuses: string[] = [];
    store.subscribe(() => {
      const c = store.getSnapshot().connection;
      if (statuses.at(-1) !== c) statuses.push(c);
    });
    store.start();
    const storeConverged = (timeoutMs = 10_000) =>
      until(() => {
        const s = store.getSnapshot();
        return s.synced && s.connection === 'open' && s.state.lastSeq === monitor.getState().lastSeq;
      }, timeoutMs, 'UI store to converge');

    try {
      const a = await mirror();
      await storeConverged();

      // ---- session 1 (shop): a linked spawn, three parallel Explore subagents, one nested subagent
      await p.post(S1, SHOP, 'SessionStart', { source: 'startup', model: 'claude-opus-5-5' });
      await p.post(S1, SHOP, 'UserPromptSubmit', { prompt: '[dropped]' });
      for (const id of ['sp1', 'sp2', 'sp3']) {
        await p.post(S1, SHOP, 'PreToolUse', { tool_name: 'Agent', tool_use_id: id, tool_input: { subagent_type: 'Explore', description: `Explore part ${id}` } });
      }
      for (const id of ['ex1', 'ex2', 'ex3']) await p.post(S1, SHOP, 'SubagentStart', { agent_id: id, agent_type: 'Explore' });
      for (const id of ['ex1', 'ex2', 'ex3']) {
        await tool(p, S1, SHOP, `${id}-g`, 'Grep', { pattern: 'total' }, { agent_id: id, agent_type: 'Explore' });
      }
      // ex1 spawns a nested test-runner while ex2 and ex3 keep working.
      await p.post(S1, SHOP, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'nest1', tool_input: { subagent_type: 'test-runner', description: 'Run tests' }, agent_id: 'ex1', agent_type: 'Explore' });
      await p.post(S1, SHOP, 'SubagentStart', { agent_id: 'tr1', agent_type: 'test-runner' });
      await p.post(S1, SHOP, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'tr1-b', tool_input: { command: 'npm test' }, agent_id: 'tr1', agent_type: 'test-runner' });

      // ---- agent team: teammates create, complete and go idle
      await p.post(S1, SHOP, 'TaskCreated', { agent_id: 'tm-alice', task_id: 't1', task_subject: 'Implement totals', teammate_name: 'alice', team_name: 'shop-team' });
      await p.post(S1, SHOP, 'TaskCreated', { task_id: 't2', task_subject: 'Write docs', teammate_name: 'bob', team_name: 'shop-team' });
      await tool(p, S1, SHOP, 'al-e', 'Edit', { file_path: `${SHOP}\\src\\totals.ts` }, { agent_id: 'tm-alice' });
      await p.post(S1, SHOP, 'TaskCompleted', { agent_id: 'tm-alice', task_id: 't1', task_subject: 'Implement totals', teammate_name: 'alice', team_name: 'shop-team' });
      await p.post(S1, SHOP, 'TeammateIdle', { agent_id: 'tm-alice', teammate_name: 'alice', team_name: 'shop-team' });
      await p.post(S1, SHOP, 'TeammateIdle', { teammate_name: 'bob', team_name: 'shop-team' });

      // ---- session 2 (another project) reuses agent_id ex1: a different agent
      await p.post(S2, API, 'SessionStart', { source: 'startup', model: 'claude-sonnet-5-5' });
      await p.post(S2, API, 'UserPromptSubmit', {});
      await p.post(S2, API, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'sp9', tool_input: { subagent_type: 'security-auditor', description: 'Review auth' } });
      await p.post(S2, API, 'SubagentStart', { agent_id: 'ex1', agent_type: 'security-auditor' });
      await tool(p, S2, API, 's2-r', 'Read', { file_path: `${API}\\src\\auth.ts` }, { agent_id: 'ex1', agent_type: 'security-auditor' });

      // ---- a mirror joins mid-stream, the first one drops out
      const b = await mirror();
      a.close();

      // ---- duplicate delivery: identical envelopes (two hook scopes) and a spooled copy
      const seqBefore = monitor.getState().lastSeq;
      const dupStop = p.envelope(S1, SHOP, 'SubagentStop', { agent_id: 'ex2', agent_type: 'Explore', last_assistant_message: 'Mapped part 2' });
      expect(await p.send(dupStop)).toBe(204);
      expect(await p.send(dupStop)).toBe(204);
      const dupTool = p.envelope(S2, API, 'PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 's2-x', tool_input: {}, error: 'Exit code 1', agent_id: 'ex1' });
      expect(await p.send(dupTool)).toBe(204);
      expect(await p.send(dupTool)).toBe(204);
      expect(await p.send(dupTool)).toBe(204);
      // A forwarder whose POST timed out after delivery spools the same envelope.
      expect(appendToSpool(home, JSON.stringify(dupStop))).toBe(true);
      await monitor.scanNow();
      const applied = monitor.getState().log.filter((l) => l.seq > seqBefore).map((l) => l.kind);
      expect(new Set(applied)).toEqual(new Set(['SubagentStop', 'PostToolUseFailure']));
      expect(monitor.getState().lastSeq - seqBefore).toBe(2);
      expect(monitor.getMeta().duplicatesDropped).toBe(4);

      // ---- SessionEnd for session 1 while ex1, ex3, tr1 and the teammates are still around
      await p.post(S1, SHOP, 'SubagentStop', { agent_id: 'ex3', agent_type: 'Explore', last_assistant_message: 'Mapped part 3' });
      await p.post(S1, SHOP, 'SessionEnd', { reason: 'prompt_input_exit' });

      // Every hook event that reached the monitor is in the mirror that joined mid-stream.
      const c = await mirror();
      await b.waitFor((x) => x.state.lastSeq === monitor.getState().lastSeq);
      await c.waitFor((x) => x.state.lastSeq === monitor.getState().lastSeq);
      await storeConverged();
      const st = monitor.getState();
      expect(b.state).toEqual(st);
      expect(c.state).toEqual(st);
      expect(store.getSnapshot().state).toEqual(st);
      for (const x of clients) expect(x.gaps).toBe(0);

      // ---- associations and parent links
      const k1 = (id?: string) => agentKeyFor(S1, id);
      const k2 = (id?: string) => agentKeyFor(S2, id);
      const ag = st.agents;
      const s1Agents = Object.values(ag).filter((x) => x.sessionId === S1);
      const s2Agents = Object.values(ag).filter((x) => x.sessionId === S2);
      expect(s1Agents.map((x) => x.key).sort()).toEqual([k1(), k1('ex1'), k1('ex2'), k1('ex3'), k1('teammate:bob'), k1('tm-alice'), k1('tr1')].sort());
      expect(s2Agents.map((x) => x.key).sort()).toEqual([k2(), k2('ex1')].sort());
      // Three same-type spawns from one parent: the parent is certain, which call started which
      // subagent is not, so a tool-use id is only kept when it is unambiguous (never guessed twice).
      const parallelIds: string[] = [];
      for (const id of ['ex1', 'ex2', 'ex3']) {
        expect(ag[k1(id)]).toMatchObject({ kind: 'subagent', parentKey: k1(), parentVia: 'spawn-tool', agentType: 'Explore', cwd: SHOP });
        const use = ag[k1(id)]!.spawnToolUseId;
        if (use !== undefined) parallelIds.push(use);
      }
      expect(new Set(parallelIds).size).toBe(parallelIds.length);
      for (const use of parallelIds) expect(['sp1', 'sp2', 'sp3']).toContain(use);
      summary.parallelSpawnIds = parallelIds;
      expect(ag[k1('tr1')]).toMatchObject({ kind: 'subagent', parentKey: k1('ex1'), parentVia: 'spawn-tool', spawnToolUseId: 'nest1', agentType: 'test-runner' });
      expect(ag[k1('tm-alice')]).toMatchObject({ kind: 'teammate', teammateName: 'alice', teamName: 'shop-team', parentKey: k1() });
      expect(ag[k1('teammate:bob')]).toMatchObject({ kind: 'teammate', teammateName: 'bob', teamName: 'shop-team', parentKey: k1() });
      expect(ag[k2('ex1')]).toMatchObject({ kind: 'subagent', parentKey: k2(), parentVia: 'spawn-tool', spawnToolUseId: 'sp9', agentType: 'security-auditor', cwd: API });
      expect(ag[k2('ex1')]!.counts.failures).toBe(1); // the triplicated failure counted once
      // SessionEnd ended the whole session-1 tree; session 2 is untouched.
      expect(ag[k1()]!.status).toBe('ended');
      for (const id of ['ex1', 'tr1', 'tm-alice', 'teammate:bob']) {
        expect(ag[k1(id)]).toMatchObject({ status: 'ended', endReason: 'Parent session ended (outcome not reported)' });
      }
      for (const id of ['ex2', 'ex3']) expect(ag[k1(id)]!.status).toBe('completed');
      expect(ag[k1('tr1')]!.tools.find((t) => t.id === 'tr1-b')!.status).toBe('unknown'); // running Bash: outcome never observed
      expect(ag[k2()]!.status).toBe('working');
      expect(ag[k2('ex1')]!.status).not.toBe('ended');
      expect(st.tasks[`${S1}#t1`]).toMatchObject({ status: 'completed', teammateName: 'alice', completedBy: k1('tm-alice') });
      expect(st.tasks[`${S1}#t2`]).toMatchObject({ status: 'open', orphaned: true, teammateName: 'bob' });
      expect(st.spawns[S1]).toBeUndefined();

      // ---- UI views over the mirrored state: one view per agent, departments, desks
      const mirrored = store.getSnapshot().state;
      const all = ui.view.filterAgents(mirrored, { workspace: 'all', showEnded: true }, []);
      const views = ui.view.toWorkerViews(all);
      expect(views.length).toBe(Object.keys(mirrored.agents).length);
      expect(new Set(views.map((v) => v.key)).size).toBe(views.length);
      for (const v of views) {
        const a2 = mirrored.agents[v.key]!;
        expect(v).toMatchObject({ kind: a2.kind, sessionId: a2.sessionId, status: a2.status });
        expect(v.parentKey).toBe(a2.parentKey);
        if (v.parentKey) expect(mirrored.agents[v.parentKey]?.sessionId).toBe(v.sessionId); // never linked across sessions
      }
      const rules = ui.settings.defaultSettings().departmentRules;
      const dept = (key: string) => {
        const v = views.find((x) => x.key === key)!;
        return ui.departments.departmentFor({ agentType: v.agentType, cwd: v.cwd, name: v.name }, rules);
      };
      expect(dept(k1('ex1'))).toBe('research');
      expect(dept(k1('tr1'))).toBe('qa');
      expect(dept(k2('ex1'))).toBe('security');
      expect(dept(k1())).toBe('development');
      const live = ui.view.toWorkerViews(ui.view.filterAgents(mirrored, { workspace: 'all', showEnded: false }, []));
      expect(live.map((v) => v.key).sort()).toEqual([k2(), k2('ex1')].sort());
      const seats = ui.grid.seatsOf(defaultLayout());
      const desks = ui.grid.assignDesks(new Map(), views.map((v) => ({ key: v.key, parentKey: v.parentKey, cwd: v.cwd, department: dept(v.key) })), seats);
      expect(desks.size).toBe(views.length);
      const taken = [...desks.values()].filter((d): d is string => d !== null);
      expect(new Set(taken).size).toBe(taken.length); // never two agents at one desk
      const roomOf = (key: string) => seats.find((s) => s.deskId === desks.get(key))?.roomKind;
      if (seats.some((s) => s.roomKind === 'research')) expect(roomOf(k1('ex1'))).toBe('research');
      if (seats.some((s) => s.roomKind === 'qa')) expect(roomOf(k1('tr1'))).toBe('qa');

      // ---- history and replay of session 1, through the UI's RPC path
      const hist = await store.rpc<{ sessions: Array<{ sessionId: string; cwd?: string; agents: number; ended: boolean }> }>('history.sessions', {});
      const h1 = hist.sessions.find((x) => x.sessionId === S1);
      const h2 = hist.sessions.find((x) => x.sessionId === S2);
      expect(h1).toMatchObject({ cwd: SHOP, ended: true });
      // History counts agents like the reducer, including the teammate known only by name.
      expect(h1!.agents).toBe(s1Agents.length);
      summary.historyAgentsSession1 = { history: h1!.agents, live: s1Agents.length };
      expect(h2).toMatchObject({ cwd: API, agents: 2, ended: false });
      const loaded = await ui.replay.fetchSessionEvents((m, prm) => store.rpc(m, prm), S1);
      expect(loaded.truncated).toBe(false);
      const replayed = ui.replay.buildReplay(loaded.events).cursor.state;
      expect(Object.keys(replayed.agents).sort()).toEqual(s1Agents.map((x) => x.key).sort());
      for (const x of s1Agents) expect(shape(replayed.agents[x.key])).toEqual(shape(x));

      // ---- monitor restart on the same port and home: the UI transport reconnects by itself
      const beforeRestart = monitor.getState();
      await monitor.stop();
      expect(liveTimers()).toEqual([]);
      await until(() => store.getSnapshot().connection !== 'open', 5000, 'UI store to notice the disconnect');
      monitor = make();
      for (let attempt = 0; ; attempt++) {
        try {
          await monitor.start();
          break;
        } catch (e) {
          if (attempt >= 20) throw e;
          await monitor.stop().catch(() => undefined);
          monitor = make();
          await sleep(100);
        }
      }
      await storeConverged(15_000);
      const restored = monitor.getState();
      expect(Object.keys(restored.agents).sort()).toEqual(Object.keys(beforeRestart.agents).sort());
      expect(restored.agents[k2()]).toMatchObject({ status: 'unknown', lastKnownStatus: 'working' }); // unverified after a restart
      expect(restored.agents[k1()]!.status).toBe('ended');
      // Live traffic after the restart is applied on top and mirrored again.
      await p.post(S2, API, 'UserPromptSubmit', { prompt: '[dropped again]' });
      await p.post(S2, API, 'SubagentStop', { agent_id: 'ex1', agent_type: 'security-auditor' });
      await storeConverged();
      expect(store.getSnapshot().state).toEqual(monitor.getState());
      expect(monitor.getState().agents[k2()]!.status).toBe('working');
      expect(monitor.getState().agents[k2('ex1')]!.status).toBe('completed');
      const hist2 = await store.rpc<{ sessions: Array<{ sessionId: string }> }>('history.sessions', {});
      expect(hist2.sessions.map((x) => x.sessionId)).toEqual(expect.arrayContaining([S1, S2]));
      expect(statuses).toEqual(expect.arrayContaining(['open', 'reconnecting']));
      expect(logs.filter((l) => /failed to (start|stop)|onEvent failed/i.test(l))).toEqual([]);

      summary.lifecycle = {
        lastSeq: monitor.getState().lastSeq,
        agents: Object.keys(monitor.getState().agents).length,
        duplicatesDropped: 4,
        storeStatuses: statuses,
        trackedTimers: tracked.size,
      };
    } finally {
      transport.dispose();
      for (const x of clients) x.close();
      await monitor.stop();
    }
    // stop() leaves no interval or timeout from the monitor or its plugins running.
    expect(liveTimers()).toEqual([]);
    expect([...tracked.values()].some((t) => t.kind === 'interval')).toBe(true); // the tracking was not vacuous
  }, 60_000);

  it('stop() is idempotent and a stopped monitor accepts no connections', async () => {
    const home = join(sandbox.path, 'office-home-2');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.keep'), '');
    const port = await freePort();
    const token = loadOrCreateConfig(home, { port }).token;
    const monitor = createMonitor({ home, port, token, claudeDirs: [], discovery: false, plugins: defaultPlugins(), tickIntervalMs: 100 });
    await monitor.start();
    const c = new MirrorClient(port, token);
    await c.opened();
    await c.waitFor((x) => x.messages.some((m: ServerMessage) => m.type === 'snapshot'));
    await monitor.stop();
    await monitor.stop();
    expect(liveTimers()).toEqual([]);
    await expect(http(port, { path: '/api/health' })).rejects.toThrow();
    c.close();
  });
});
