import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentKeyFor,
  createInitialState,
  defaultLayout,
  normalizeHookPayload,
  reduce,
  type GitReposResult,
  type GitStatusOk,
  type OfficeState,
} from '@agent-office/core';
import { Inspector } from '../src/components/Inspector';
import { NotificationCenter } from '../src/components/Notifications';
import { TaskBoard } from '../src/components/TaskBoard';
import { StoreContext } from '../src/hooks';
import type { OfficeStore, StoreSnapshot } from '../src/store';
import type { HostInfo } from '../src/transport';
import { ErrorsView } from '../src/views/ErrorsView';
import { GitView } from '../src/views/GitView';

afterEach(cleanup);

const T = Date.now() - 60_000;
const host: HostInfo = { kind: 'browser', workspaceFolders: [], canOpenFiles: false, canFocusClaude: false };
const vscodeHost: HostInfo = { ...host, kind: 'vscode', canOpenFiles: true, canFocusClaude: true };

function build(events: Array<[string, number, Record<string, unknown>, string?]>): OfficeState {
  let s = createInitialState();
  let seq = 0;
  for (const [name, ts, extra, sid] of events) {
    const r = normalizeHookPayload({ session_id: sid ?? 'sess-1', cwd: 'c:\\work\\app', transcript_path: 'c:\\t\\sess-1.jsonl', hook_event_name: name, ...extra }, ts);
    if (!r.ok) throw new Error(r.error);
    s = reduce(s, { ...r.event, seq: ++seq });
  }
  return s;
}

const scenario = build([
  ['SessionStart', T, { source: 'startup', model: 'claude-opus-5-5' }],
  ['UserPromptSubmit', T + 100, {}],
  ['PreToolUse', T + 200, { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'c:\\work\\app\\src\\index.ts' } }],
  ['PostToolUse', T + 450, { tool_name: 'Read', tool_use_id: 'r1', tool_input: {}, duration_ms: 250 }],
  ['PreToolUse', T + 500, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test', description: 'Run tests' } }],
  ['PostToolUseFailure', T + 900, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {}, error: 'Exit code 1' }],
  ['PreToolUse', T + 1000, { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { subagent_type: 'Explore', description: 'Find tests' } }],
  ['SubagentStart', T + 1100, { agent_id: 'ex1', agent_type: 'Explore' }],
  ['TaskCreated', T + 1200, { task_id: '1', task_subject: 'Fix failing test' }],
  ['TaskCreated', T + 1300, { task_id: '2', task_subject: 'Update docs' }],
  ['TaskCompleted', T + 1400, { task_id: '2', task_subject: 'Update docs' }],
  ['PreToolUse', T + 1500, { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'c:\\work\\app\\src\\a.ts' } }],
  ['PermissionRequest', T + 1600, { tool_name: 'Edit', tool_input: { file_path: 'c:\\work\\app\\src\\a.ts' } }],
  ['SessionStart', T + 1700, {}, 'sess-2'],
  ['TaskCreated', T + 1800, { task_id: '9', task_subject: 'Never finished' }, 'sess-2'],
  ['SessionEnd', T + 1900, { reason: 'other' }, 'sess-2'],
]);

function renderInspector(key: string, h: HostInfo = host, extra: Partial<Parameters<typeof Inspector>[0]> = {}) {
  const props = {
    agent: scenario.agents[key]!,
    state: scenario,
    now: Date.now(),
    host: h,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onOpenTranscript: vi.fn(),
    onFocusClaude: vi.fn(),
    ...extra,
  };
  render(<Inspector {...props} />);
  return props;
}

describe('Inspector', () => {
  it('shows live activity: status, current tool, pending permission and subagents', () => {
    const p = renderInspector('sess-1');
    expect(screen.getByRole('heading', { name: /app · sess-1/ })).toBeTruthy();
    expect(screen.getByText('Needs permission')).toBeTruthy();
    expect(screen.getByText('Current tool')).toBeTruthy();
    expect(screen.getByText('Permission requested')).toBeTruthy();
    // the child subagent is listed and navigable
    fireEvent.click(screen.getByRole('button', { name: /Explore · ex1/ }));
    expect(p.onSelect).toHaveBeenCalledWith(agentKeyFor('sess-1', 'ex1'));
  });

  it('never fabricates token usage', () => {
    renderInspector('sess-1');
    expect(screen.getByText(/never estimated/)).toBeTruthy();
  });

  it('lists tool history with outcomes, durations and expandable errors', () => {
    renderInspector('sess-1');
    fireEvent.click(screen.getByRole('tab', { name: /Tools \(4\)/ }));
    const list = screen.getByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.className)).toEqual(['tool tool-awaiting_permission', 'tool tool-running', 'tool tool-failed', 'tool tool-succeeded']);
    expect(within(rows[3]!).getByText('250 ms')).toBeTruthy();
    fireEvent.click(within(rows[2]!).getByRole('button'));
    expect(within(rows[2]!).getByText('Exit code 1')).toBeTruthy();
  });

  it('shows tasks and the event log for the agent', () => {
    renderInspector('sess-1');
    fireEvent.click(screen.getByRole('tab', { name: /Tasks \(2\)/ }));
    expect(screen.getByText('Fix failing test')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Log/ }));
    expect(screen.getByText(/Permission requested for Edit/)).toBeTruthy();
  });

  it('offers host actions only inside VS Code', () => {
    const p = renderInspector('sess-1', vscodeHost);
    fireEvent.click(screen.getByRole('button', { name: /Open transcript/ }));
    expect(p.onOpenTranscript).toHaveBeenCalledWith('c:\\t\\sess-1.jsonl');
    fireEvent.click(screen.getByRole('button', { name: /Open Claude Code/ }));
    expect(p.onFocusClaude).toHaveBeenCalled();
    cleanup();
    renderInspector('sess-1', host);
    expect(screen.queryByRole('button', { name: /Open transcript/ })).toBeNull();
  });

  it('explains ended agents', () => {
    renderInspector('sess-2');
    expect(screen.getAllByText('Ended').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Session ended \(other\)/).length).toBeGreaterThanOrEqual(1);
  });
});

describe('TaskBoard', () => {
  it('groups tasks into open, completed and open-at-session-end', () => {
    render(<TaskBoard state={scenario} sessionKeys={new Set(['sess-1', 'sess-2'])} now={Date.now()} onSelect={vi.fn()} onClose={vi.fn()} />);
    const col = (title: RegExp) => screen.getByRole('heading', { name: title }).parentElement!;
    expect(within(col(/^Open \d/)).getByText('Fix failing test')).toBeTruthy();
    expect(within(col(/^Completed/)).getByText('Update docs')).toBeTruthy();
    expect(within(col(/^Open when session ended/)).getByText('Never finished')).toBeTruthy();
  });

  it('shows owner, project, times and a labeled heuristic sub-state from the owner status', () => {
    render(<TaskBoard state={scenario} sessionKeys={new Set(['sess-1', 'sess-2'])} now={Date.now()} onSelect={vi.fn()} onClose={vi.fn()} />);
    const card = screen.getByText('Fix failing test').closest('article')!;
    // sess-1 is waiting for a permission decision → Blocked, explicitly a heuristic
    const tag = within(card).getByText(/Blocked · heuristic/);
    expect(tag.getAttribute('title')).toMatch(/^Heuristic: the owning agent is waiting for a permission decision/);
    expect(within(card).getByText('app')).toBeTruthy();
    expect(within(card).getByText(/^open for /)).toBeTruthy();
    expect(within(card).getByRole('button', { name: /app · sess-1/ })).toBeTruthy();
    // completed and orphaned tasks never get a sub-state
    const done = screen.getByText('Update docs').closest('article')!;
    expect(within(done).queryByText(/heuristic/)).toBeNull();
    expect(within(done).getByText(/^took /)).toBeTruthy();
    const orphan = screen.getByText('Never finished').closest('article')!;
    expect(within(orphan).queryByText(/heuristic/)).toBeNull();
    expect(within(orphan).getByText(/until the session ended/)).toBeTruthy();
  });

  it('marks an open task Running only while its owner is working, and filters by project and session', () => {
    const s = build([
      ['SessionStart', T, {}, 'p1'],
      ['UserPromptSubmit', T + 10, {}, 'p1'],
      ['TaskCreated', T + 20, { task_id: '1', task_subject: 'Alpha task' }, 'p1'],
      ['SessionStart', T, { cwd: 'c:\\work\\other' }, 'p2'],
      ['TaskCreated', T + 30, { task_id: '1', task_subject: 'Beta task', cwd: 'c:\\work\\other' }, 'p2'],
    ]);
    const onSelect = vi.fn();
    render(<TaskBoard inline state={s} sessionKeys={new Set(['p1', 'p2'])} now={Date.now()} onSelect={onSelect} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull(); // page mode
    expect(within(screen.getByText('Alpha task').closest('article')!).getByText(/Running · heuristic/)).toBeTruthy();
    // p2 is idle: no sub-state is claimed
    expect(within(screen.getByText('Beta task').closest('article')!).queryByText(/heuristic/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Filter by project'), { target: { value: 'c:\\work\\other' } });
    expect(screen.queryByText('Alpha task')).toBeNull();
    expect(screen.getByText('Beta task')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter by project'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Filter by session'), { target: { value: 'p1' } });
    expect(screen.getByText('Alpha task')).toBeTruthy();
    expect(screen.queryByText('Beta task')).toBeNull();
  });

  it('works as a modal dialog', () => {
    const onClose = vi.fn();
    render(<TaskBoard state={scenario} sessionKeys={new Set(['sess-1'])} now={Date.now()} onSelect={vi.fn()} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Task board' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close task board' }));
    expect(onClose).toHaveBeenCalled();
  });
});

const gitOk: GitStatusOk = {
  ok: true,
  cwd: 'c:\\work\\app',
  root: 'C:/work/app',
  name: 'app',
  branch: { name: 'feature/login', detached: false, initial: false, upstream: 'origin/feature/login', ahead: 2, behind: 1 },
  files: [
    { path: 'src/a.ts', kind: 'modified', staged: false, unstaged: true, code: ' M' },
    { path: 'src/new.ts', kind: 'added', staged: true, unstaged: false, code: 'A ' },
    { path: 'notes.md', kind: 'untracked', staged: false, unstaged: true, code: '??' },
  ],
  filesTruncated: false,
  counts: { modified: 1, added: 1, deleted: 0, renamed: 0, untracked: 1, unmerged: 0, total: 3 },
  commits: [{ hash: 'abc1234', subject: 'Fix the login form', date: new Date(Date.now() - 3600_000).toISOString() }],
  diff: { unstaged: { files: 1, insertions: 12, deletions: 3, binaryFiles: 0 }, staged: null },
  conflicts: [{ path: 'src/a.ts', uncommitted: true, sessions: [{ sessionId: 'sess-1', agentKeys: ['sess-1'], toolNames: ['Edit'] }, { sessionId: 'sess-2', agentKeys: ['sess-2'], toolNames: ['Write'] }] }],
  checkedAt: Date.now(),
  agentKeys: ['sess-1', 'sess-2'],
  sessionIds: ['sess-1', 'sess-2'],
  cwds: ['c:\\work\\app'],
};

function fakeStore(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const rpc = vi.fn(async (method: string, params: Record<string, unknown> = {}) => handler(method, params));
  return { store: { rpc } as unknown as OfficeStore, rpc };
}

function snapOf(state: OfficeState, connection: StoreSnapshot['connection'] = 'open'): StoreSnapshot {
  return { state, layout: defaultLayout(), connection, synced: true, host, version: 1 };
}

describe('Inspector dashboard additions', () => {
  it('shows the current file, observed duration, recent errors and a read-only note', () => {
    renderInspector('sess-1');
    // current tool is the Edit awaiting permission
    expect(screen.getByText('Current file').nextElementSibling!.textContent).toBe('src\\a.ts');
    expect(screen.getByText('Last file').nextElementSibling!.textContent).toMatch(/^src\\index\.ts/);
    expect(screen.getByText('Session duration').nextElementSibling!.textContent).toMatch(/observed, not ended/);
    const errors = screen.getByRole('list', { name: 'Recent errors' });
    expect(within(errors).getByText('Bash')).toBeTruthy();
    expect(within(errors).getByText(/Exit code 1/)).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/Read-only monitoring.*cannot send prompts/);
  });

  it('says "Not reported" when the data is missing', () => {
    renderInspector('sess-2');
    expect(screen.getByText('Current file').nextElementSibling!.textContent).toBe('Not reported');
    expect(screen.getByText(/No failed, denied or interrupted tool calls/)).toBeTruthy();
    expect(screen.getByText(/Unavailable \(not connected to the monitor\)/)).toBeTruthy();
  });

  it('labels Open Claude Code as navigation only and offers no control that could steer Claude', () => {
    renderInspector('sess-1', vscodeHost);
    const btn = screen.getByRole('button', { name: /Open Claude Code/ });
    expect(btn.getAttribute('title')).toMatch(/^Navigation only/);
    expect(screen.getByText(/Navigation only: switches to the Claude Code panel/)).toBeTruthy();
    const names = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    for (const n of names) expect(n).not.toMatch(/send|submit|reply|approve|allow|deny|resume|continue|start|stop|prompt|run/i);
  });

  it('shows the git branch, changes and potential conflicts for the agent cwd via rpc', async () => {
    const { store, rpc } = fakeStore(() => gitOk);
    render(
      <StoreContext.Provider value={store}>
        <Inspector agent={scenario.agents['sess-1']!} state={scenario} now={Date.now()} host={host} onSelect={vi.fn()} onClose={vi.fn()} onOpenTranscript={vi.fn()} onFocusClaude={vi.fn()} />
      </StoreContext.Provider>,
    );
    expect(await screen.findByText('feature/login')).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('git.status', { cwd: 'c:\\work\\app' });
    expect(screen.getByText(/↑2 ↓1/)).toBeTruthy();
    expect(screen.getByText('1 modified · 1 added · 1 untracked')).toBeTruthy();
    expect(screen.getByText(/unstaged \+12 −3 in 1 file · staged Unavailable/)).toBeTruthy();
    expect(screen.getByText('Fix the login form')).toBeTruthy();
    expect(screen.getByText('Potential conflicts')).toBeTruthy();
    expect(screen.getAllByText('heuristic')[0]!.getAttribute('title')).toMatch(/not a git merge conflict/);
  });

  it('shows why git data is unavailable', async () => {
    const { store } = fakeStore(() => ({ ok: false, cwd: 'c:\\work\\app', problem: { code: 'not_a_repo', message: 'Not a git repository' }, checkedAt: Date.now() }));
    render(
      <StoreContext.Provider value={store}>
        <Inspector agent={scenario.agents['sess-1']!} state={scenario} now={Date.now()} host={host} onSelect={vi.fn()} onClose={vi.fn()} onOpenTranscript={vi.fn()} onFocusClaude={vi.fn()} />
      </StoreContext.Provider>,
    );
    expect(await screen.findByText('Not a git repository')).toBeTruthy();
  });

  it('shows task history with creation, completion and duration', () => {
    renderInspector('sess-1');
    fireEvent.click(screen.getByRole('tab', { name: /Tasks \(2\)/ }));
    const done = screen.getByText('Update docs').closest('li')!;
    expect(within(done).getByText(/Created .* · took /)).toBeTruthy();
    const open = screen.getByText('Fix failing test').closest('li')!;
    expect(within(open).getByText(/open for /)).toBeTruthy();
  });
});

describe('ErrorsView', () => {
  it('lists rule-based problems sorted by severity, links them to agents and filters them', () => {
    const onSelectAgent = vi.fn();
    render(<ErrorsView snap={snapOf(scenario)} now={Date.now()} onSelectAgent={onSelectAgent} />);
    const list = screen.getByRole('list', { name: 'Detected problems' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]!.className).toMatch(/sev-error/);
    expect(rows[rows.length - 1]!.className).not.toMatch(/sev-error/);
    const test = within(list).getByText('Likely test failure (Bash)').closest('li')!;
    expect(within(test).getAllByText('heuristic').length).toBeGreaterThan(0);
    expect(within(list).getByText('Waiting for permission: Edit')).toBeTruthy();
    fireEvent.click(within(test).getByRole('button', { name: /app · sess-1/ }));
    expect(onSelectAgent).toHaveBeenCalledWith('sess-1');

    fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'permission_blocked' } });
    expect(within(screen.getByRole('list', { name: 'Detected problems' })).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'disconnected' } });
    expect(screen.getByText('Nothing matches these filters.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: /warning/ }));
    for (const r of within(screen.getByRole('list', { name: 'Detected problems' })).getAllByRole('listitem')) expect(r.className).toMatch(/sev-warning/);
  });

  it('says so when nothing was detected', () => {
    render(<ErrorsView snap={snapOf(createInitialState())} now={Date.now()} onSelectAgent={vi.fn()} />);
    expect(screen.getByText('No problems detected in the retained history.')).toBeTruthy();
  });
});

describe('GitView', () => {
  const repos: GitReposResult = {
    checkedAt: Date.now(),
    gitAvailable: true,
    repos: [{ root: 'C:/work/app', name: 'app', agentKeys: ['sess-1', 'sess-2', agentKeyFor('sess-1', 'ex1')], sessionIds: ['sess-1', 'sess-2'], cwds: ['c:\\work\\app'] }],
    unresolved: [{ cwd: 'c:\\scratch', agentKeys: ['sess-2'], problem: { code: 'not_a_repo', message: 'Not a git repository' } }],
    truncated: false,
  };

  it('lists repositories with their sessions, changes, commits and potential conflicts', async () => {
    const { store, rpc } = fakeStore((method) => (method === 'git.repos' ? repos : gitOk));
    const onSelectAgent = vi.fn();
    render(
      <StoreContext.Provider value={store}>
        <GitView snap={snapOf(scenario)} now={Date.now()} onSelectAgent={onSelectAgent} />
      </StoreContext.Provider>,
    );
    const card = await screen.findByRole('article', { name: 'Repository app' });
    expect(await within(card).findByText('feature/login')).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('git.repos', {});
    expect(rpc).toHaveBeenCalledWith('git.status', { cwd: 'c:\\work\\app' });
    expect(within(card).getByText('Fix the login form')).toBeTruthy();
    expect(within(card).getByText('Changed files (3)')).toBeTruthy();
    expect(within(card).getByText('Potential conflicts')).toBeTruthy();
    expect(within(card).getByText('uncommitted')).toBeTruthy();
    fireEvent.click(within(card).getAllByRole('button', { name: /Explore · ex1/ })[0]!);
    expect(onSelectAgent).toHaveBeenCalledWith(agentKeyFor('sess-1', 'ex1'));
    expect(screen.getByText(/Not a git repository/)).toBeTruthy();
    expect(screen.getByText(/Nothing is fetched, pulled or pushed/)).toBeTruthy();
  });

  it('is unavailable without a monitor connection and never calls rpc then', () => {
    const { store, rpc } = fakeStore(() => repos);
    render(
      <StoreContext.Provider value={store}>
        <GitView snap={snapOf(scenario, 'closed')} now={Date.now()} onSelectAgent={vi.fn()} />
      </StoreContext.Provider>,
    );
    expect(screen.getByText('Unavailable: not connected to the monitor.')).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reports a missing git executable', async () => {
    const { store } = fakeStore(() => ({ ...repos, gitAvailable: false, repos: [], unresolved: [{ cwd: 'c:\\work\\app', agentKeys: ['sess-1'], problem: { code: 'git_missing', message: 'git is not installed or not on PATH' } }] }));
    render(
      <StoreContext.Provider value={store}>
        <GitView snap={snapOf(scenario)} now={Date.now()} onSelectAgent={vi.fn()} />
      </StoreContext.Provider>,
    );
    expect(await screen.findByText(/Git is not available on this machine \(the git executable/)).toBeTruthy();
  });
});

describe('NotificationCenter', () => {
  it('lists failures and permission requests, newest first', () => {
    const onSelect = vi.fn();
    render(<NotificationCenter state={scenario} read={new Set()} now={Date.now()} onSelect={onSelect} onMarkAll={vi.fn()} onClose={vi.fn()} />);
    const titles = screen.getAllByText(/failed|Permission requested/).map((e) => e.textContent);
    expect(titles).toEqual(['Permission requested: Edit', 'Bash failed']);
    fireEvent.click(screen.getAllByRole('button', { name: /app · sess-1/ })[0]!);
    expect(onSelect).toHaveBeenCalledWith('sess-1');
  });
});
