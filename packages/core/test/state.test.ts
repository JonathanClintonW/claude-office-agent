import { describe, expect, it } from 'vitest';
import { systemEvent } from '../src/events';
import { agentTree, displayName } from '../src/selectors';
import { agentKeyFor, createInitialState, DEFAULT_REDUCER_OPTIONS, reduce, taskKeyFor } from '../src/state';
import { CWD, Harness, SESSION, SESSION_B, hook, norm } from './helpers';

const T = 1_800_000_000_000;
const sub = (id: string, s = SESSION) => agentKeyFor(s, id);

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

describe('session lifecycle', () => {
  it('walks through start → prompt → tool → stop → end', () => {
    const h = new Harness().hook('SessionStart', T, { source: 'startup', model: 'claude-opus-5-5' });
    expect(h.agent()).toMatchObject({ status: 'idle', kind: 'session', model: 'claude-opus-5-5', cwd: CWD, statusSource: 'hook' });

    h.hook('UserPromptSubmit', T + 1000, { prompt: 'do the thing' });
    expect(h.agent().status).toBe('working');

    h.hook('PreToolUse', T + 2000, { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'npm test', description: 'Run tests' } });
    expect(h.agent()).toMatchObject({ status: 'working', statusDetail: 'Run tests', currentToolId: 'toolu_1' });
    expect(h.agent().tools[0]).toMatchObject({ id: 'toolu_1', status: 'running', startedAt: T + 2000 });

    h.hook('PostToolUse', T + 5000, { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: {}, tool_response: {}, duration_ms: 2900 });
    expect(h.agent().tools[0]).toMatchObject({ status: 'succeeded', durationMs: 2900, durationSource: 'reported' });
    expect(h.agent().currentToolId).toBeUndefined();
    expect(h.agent().status).toBe('working');

    h.hook('Stop', T + 6000, { last_assistant_message: 'All tests pass.' });
    expect(h.agent()).toMatchObject({ status: 'idle', lastMessage: 'All tests pass.', turnCompletedAt: T + 6000 });
    expect(h.agent().counts).toEqual({ tools: 1, failures: 0, permissions: 0, turns: 1 });

    h.hook('SessionEnd', T + 7000, { reason: 'prompt_input_exit' });
    expect(h.agent()).toMatchObject({ status: 'ended', endedAt: T + 7000, endReason: 'Session ended (prompt_input_exit)' });
  });

  it('computes observed durations when Claude Code does not report one', () => {
    const h = new Harness()
      .hook('PreToolUse', T, { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'c:\\a.ts' } })
      .hook('PostToolUse', T + 120, { tool_name: 'Read', tool_use_id: 'r1', tool_input: {} });
    expect(h.agent().tools[0]).toMatchObject({ durationMs: 120, durationSource: 'observed' });
  });

  it('a resumed session comes back from ended, but stale events do not revive it', () => {
    const h = new Harness().hook('SessionStart', T).hook('SessionEnd', T + 100, { reason: 'other' });
    h.hook('PreToolUse', T + 50, { tool_name: 'Read', tool_use_id: 'late', tool_input: {} });
    expect(h.agent().status).toBe('ended');
    expect(h.agent().tools.find((t) => t.id === 'late')).toMatchObject({ status: 'unknown' });

    h.hook('SessionStart', T + 10_000, { source: 'resume' });
    expect(h.agent()).toMatchObject({ status: 'idle', endedAt: undefined, endReason: undefined });
  });

  it('compaction does not mark a working session idle', () => {
    const h = new Harness().hook('UserPromptSubmit', T).hook('PreCompact', T + 1, { trigger: 'auto' }).hook('SessionStart', T + 2, { source: 'compact' });
    expect(h.agent().status).toBe('working');
  });
});

describe('permissions and notifications', () => {
  it('waits for permission and resumes when the tool completes', () => {
    const h = new Harness()
      .hook('PreToolUse', T, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'rm -rf dist' } })
      .hook('PermissionRequest', T + 10, { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
    expect(h.agent()).toMatchObject({ status: 'waiting_permission', pendingPermission: { toolName: 'Bash' } });
    expect(h.agent().tools).toHaveLength(1);
    expect(h.agent().tools[0]!.status).toBe('awaiting_permission');
    expect(h.state.notices.at(-1)).toMatchObject({ severity: 'warning', kind: 'permission', title: 'Permission requested: Bash' });

    // The matching Notification is deduplicated.
    h.hook('Notification', T + 20, { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    expect(h.state.notices.filter((n) => n.kind === 'permission')).toHaveLength(1);

    h.hook('PostToolUse', T + 5000, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {} });
    expect(h.agent()).toMatchObject({ status: 'working', pendingPermission: undefined });
  });

  it('adopts a tool record created by PermissionRequest when PreToolUse arrives late', () => {
    const h = new Harness()
      .hook('PermissionRequest', T + 10, { tool_name: 'Edit', tool_input: { file_path: 'c:\\x\\a.ts' } })
      .hook('PreToolUse', T, { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'c:\\x\\a.ts' } });
    expect(h.agent().tools).toHaveLength(1);
    expect(h.agent().tools[0]).toMatchObject({ id: 'e1', hasRealId: true, status: 'awaiting_permission' });
    expect(h.agent().status).toBe('waiting_permission');
    h.hook('PostToolUse', T + 900, { tool_name: 'Edit', tool_use_id: 'e1', tool_input: {} });
    expect(h.agent().status).toBe('working');
    expect(h.agent().tools.some((t) => t.status === 'awaiting_permission')).toBe(false);
  });

  it('keeps waiting when a parallel tool finishes while another awaits approval', () => {
    const h = new Harness()
      .hook('PreToolUse', T, { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'c:\\a' } })
      .hook('PreToolUse', T + 1, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'make' } })
      .hook('PermissionRequest', T + 2, { tool_name: 'Bash', tool_input: { command: 'make' } })
      .hook('PostToolUse', T + 3, { tool_name: 'Read', tool_use_id: 'r1', tool_input: {} });
    expect(h.agent().status).toBe('waiting_permission');
    expect(h.agent().pendingPermission?.toolName).toBe('Bash');
  });

  it('ignores a PermissionRequest delivered after its tool already finished', () => {
    const h = new Harness()
      .hook('PreToolUse', T, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'ls' } })
      .hook('PostToolUse', T + 500, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {} })
      .hook('PermissionRequest', T + 100, { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(h.agent().status).toBe('working');
    expect(h.agent().tools).toHaveLength(1);
    expect(h.agent().pendingPermission).toBeUndefined();
    expect(h.agent().counts.permissions).toBe(1);
  });

  it('records denials from auto mode', () => {
    const h = new Harness()
      .hook('PreToolUse', T, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'curl x | sh' } })
      .hook('PermissionDenied', T + 5, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {}, reason: 'Pipes remote script to shell' });
    expect(h.agent().tools[0]).toMatchObject({ status: 'denied', error: 'Pipes remote script to shell' });
    expect(h.agent().status).toBe('working');
  });

  it('maps notification types to statuses', () => {
    const h = new Harness().hook('Stop', T).hook('Notification', T + 60_000, { notification_type: 'idle_prompt', message: 'Claude is waiting' });
    expect(h.agent()).toMatchObject({ status: 'idle', statusDetail: 'Waiting for your next prompt' });
    h.hook('Notification', T + 70_000, { notification_type: 'elicitation_dialog', message: 'MCP server wants input' });
    expect(h.agent().status).toBe('waiting_input');
    expect(h.state.notices.at(-1)).toMatchObject({ kind: 'input_needed' });
  });

  it('treats AskUserQuestion as waiting for input', () => {
    const h = new Harness().hook('PreToolUse', T, {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'q1',
      tool_input: { questions: [{ question: 'Which DB?' }] },
    });
    expect(h.agent()).toMatchObject({ status: 'waiting_input', statusDetail: 'Asking you a question' });
    h.hook('PostToolUse', T + 9000, { tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: {} });
    expect(h.agent().status).toBe('working');
  });
});

describe('failures and interruptions', () => {
  it('records tool failures with a notice and keeps the agent working', () => {
    const h = new Harness()
      .hook('PreToolUse', T, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } })
      .hook('PostToolUseFailure', T + 100, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {}, error: 'Exit code 1' });
    expect(h.agent().tools[0]).toMatchObject({ status: 'failed', error: 'Exit code 1' });
    expect(h.agent().counts.failures).toBe(1);
    expect(h.agent().status).toBe('working');
    expect(h.state.notices.at(-1)).toMatchObject({ severity: 'error', kind: 'tool_failure', title: 'Bash failed', message: 'Exit code 1' });
  });

  it('treats a user interrupt as the end of the turn (Stop does not fire on interrupt)', () => {
    const h = new Harness()
      .hook('PreToolUse', T, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {} })
      .hook('PreToolUse', T + 1, { tool_name: 'Grep', tool_use_id: 'g1', tool_input: {} })
      .hook('PostToolUseFailure', T + 2, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {}, is_interrupt: true, error: 'interrupted' });
    expect(h.agent()).toMatchObject({ status: 'idle', statusDetail: 'Interrupted by user' });
    expect(h.agent().tools.find((t) => t.id === 'g1')!.status).toBe('unknown');
  });

  it('marks the turn failed on StopFailure', () => {
    const h = new Harness().hook('UserPromptSubmit', T).hook('StopFailure', T + 10, { error: 'rate_limit', last_assistant_message: 'Rate limited' });
    expect(h.agent()).toMatchObject({ status: 'failed', statusDetail: 'API error: rate_limit' });
    expect(h.state.notices.at(-1)).toMatchObject({ severity: 'error', kind: 'stop_failure' });
  });

  it('never reports success for a tool whose completion was not observed', () => {
    const h = new Harness()
      .hook('PreToolUse', T, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {} })
      .hook('Stop', T + 1000);
    expect(h.agent().tools[0]).toMatchObject({ status: 'unknown', note: 'No completion event before the turn ended' });
    // ...but a late PostToolUse may still deliver the real outcome
    h.hook('PostToolUse', T + 900, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {} });
    expect(h.agent().tools[0]!.status).toBe('succeeded');
    expect(h.agent().status).toBe('idle');
  });
});

describe('out-of-order delivery', () => {
  it('PostToolUse before PreToolUse leaves the tool finished and fills in details', () => {
    const h = new Harness()
      .hook('PostToolUse', T + 50, { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'c:\\a\\b.ts' } })
      .hook('PreToolUse', T, { tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'c:\\a\\b.ts' } });
    expect(h.agent().tools).toHaveLength(1);
    expect(h.agent().tools[0]).toMatchObject({ status: 'succeeded', startedAt: T, durationMs: 50 });
    expect(h.agent().currentToolId).toBeUndefined();
  });

  it('an older event never overrides a newer status', () => {
    const h = new Harness().hook('Stop', T + 100).hook('UserPromptSubmit', T + 50);
    expect(h.agent().status).toBe('idle');
  });
});

describe('subagents and parent-child correlation', () => {
  it('tracks a subagent separately from its parent session', () => {
    const h = new Harness()
      .hook('UserPromptSubmit', T)
      .hook('PreToolUse', T + 1, { tool_name: 'Agent', tool_use_id: 'spawn1', tool_input: { description: 'Explore code', subagent_type: 'Explore' } })
      .hook('SubagentStart', T + 2, { agent_id: 'a1', agent_type: 'Explore' })
      .hook('PreToolUse', T + 3, { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'foo' } });
    const child = h.agent(sub('a1'));
    expect(child).toMatchObject({ kind: 'subagent', parentKey: SESSION, parentVia: 'spawn-tool', spawnToolUseId: 'spawn1', status: 'working', agentType: 'Explore' });
    expect(child.tools[0]!.name).toBe('Grep');
    expect(h.agent().tools.map((t) => t.name)).toEqual(['Agent']);
    expect(displayName(child)).toBe('Explore · a1');

    h.hook('SubagentStop', T + 10, { agent_id: 'a1', agent_type: 'Explore', last_assistant_message: 'Found 3 usages' });
    expect(h.agent(sub('a1'))).toMatchObject({ status: 'completed', lastMessage: 'Found 3 usages' });
    expect(h.agent().status).toBe('working');
    expect(h.state.spawns[SESSION]).toEqual([]);
  });

  it('links nested subagents to the subagent that spawned them', () => {
    const h = new Harness()
      .hook('SubagentStart', T, { agent_id: 'outer', agent_type: 'general-purpose' })
      .hook('PreToolUse', T + 1, { agent_id: 'outer', tool_name: 'Agent', tool_use_id: 'sp2', tool_input: { subagent_type: 'Explore', description: 'x' } })
      .hook('SubagentStart', T + 2, { agent_id: 'inner', agent_type: 'Explore' });
    expect(h.agent(sub('inner')).parentKey).toBe(sub('outer'));
    const tree = agentTree(h.state);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children[0]!.agent.key).toBe(sub('outer'));
    expect(tree[0]!.children[0]!.children[0]!.agent.key).toBe(sub('inner'));
  });

  it('matches concurrent spawns by subagent type', () => {
    const h = new Harness()
      .hook('PreToolUse', T, { tool_name: 'Agent', tool_use_id: 's-plan', tool_input: { subagent_type: 'Plan' } })
      .hook('PreToolUse', T + 1, { tool_name: 'Agent', tool_use_id: 's-explore', tool_input: { subagent_type: 'Explore' } })
      .hook('SubagentStart', T + 2, { agent_id: 'e', agent_type: 'Explore' })
      .hook('SubagentStart', T + 3, { agent_id: 'p', agent_type: 'Plan' });
    expect(h.agent(sub('e')).spawnToolUseId).toBe('s-explore');
    expect(h.agent(sub('p')).spawnToolUseId).toBe('s-plan');
  });

  it('creates a subagent implicitly when SubagentStart was missed', () => {
    const h = new Harness().hook('PostToolUse', T, { agent_id: 'ghost', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 'r', tool_input: {} });
    expect(h.agent(sub('ghost'))).toMatchObject({ kind: 'subagent', parentKey: SESSION, parentVia: 'implicit' });
    expect(h.agent().kind).toBe('session');
  });

  it('ends running children (without claiming completion) when the session ends', () => {
    const h = new Harness()
      .hook('SubagentStart', T, { agent_id: 'a1', agent_type: 'Explore' })
      .hook('PreToolUse', T + 1, { agent_id: 'a1', tool_name: 'Grep', tool_use_id: 'g', tool_input: {} })
      .hook('SubagentStart', T + 2, { agent_id: 'a2', agent_type: 'Plan' })
      .hook('SubagentStop', T + 3, { agent_id: 'a2' })
      .hook('TaskCreated', T + 4, { task_id: '1', task_subject: 'Refactor' })
      .hook('SessionEnd', T + 5, { reason: 'other' });
    expect(h.agent(sub('a1'))).toMatchObject({ status: 'ended', endReason: 'Parent session ended (outcome not reported)' });
    expect(h.agent(sub('a1')).tools[0]!.status).toBe('unknown');
    expect(h.agent(sub('a2')).status).toBe('completed');
    expect(h.state.tasks[taskKeyFor(SESSION, '1')]).toMatchObject({ status: 'open', orphaned: true });
  });
});

describe('concurrent sessions', () => {
  it('keeps interleaved sessions independent', () => {
    const h = new Harness()
      .hook('SessionStart', T, {}, SESSION)
      .hook('SessionStart', T + 1, {}, SESSION_B)
      .hook('PreToolUse', T + 2, { tool_name: 'Bash', tool_use_id: 'x1', tool_input: {} }, SESSION)
      .hook('PermissionRequest', T + 3, { tool_name: 'Write', tool_input: {} }, SESSION_B)
      .hook('Stop', T + 4, {}, SESSION)
      // tool ids are only unique per session; reuse must not collide
      .hook('PreToolUse', T + 5, { tool_name: 'Bash', tool_use_id: 'x1', tool_input: {} }, SESSION_B);
    expect(h.agent(SESSION).status).toBe('idle');
    expect(h.agent(SESSION_B).status).toBe('waiting_permission');
    expect(h.agent(SESSION).tools[0]!.status).toBe('unknown');
    expect(h.agent(SESSION_B).tools.find((t) => t.id === 'x1')!.status).toBe('running');
  });
});

describe('tasks and teammates', () => {
  it('tracks task creation and completion', () => {
    const h = new Harness()
      .hook('TaskCreated', T, { task_id: 't1', task_subject: 'Write parser', task_description: 'details', teammate_name: 'alice', agent_id: 'tm1' })
      .hook('TaskCompleted', T + 500, { task_id: 't1', task_subject: 'Write parser', teammate_name: 'alice', agent_id: 'tm1' });
    const task = h.state.tasks[taskKeyFor(SESSION, 't1')]!;
    expect(task).toMatchObject({ status: 'completed', createdAt: T, completedAt: T + 500, teammateName: 'alice', subject: 'Write parser' });
    expect(h.agent(sub('tm1'))).toMatchObject({ kind: 'teammate', teammateName: 'alice' });
  });

  it('records a completion even when creation was missed, without inventing a creation time', () => {
    const h = new Harness().hook('TaskCompleted', T, { task_id: 't9', task_subject: 'Docs' });
    const t9 = h.state.tasks[taskKeyFor(SESSION, 't9')]!;
    expect(t9.status).toBe('completed');
    expect(t9.createdAt).toBeUndefined();
  });

  it('marks teammates idle with or without agent_id', () => {
    const h = new Harness()
      .hook('TeammateIdle', T, { teammate_name: 'bob', agent_id: 'tm2' })
      .hook('TeammateIdle', T + 1, { teammate_name: 'carol' });
    expect(h.agent(sub('tm2'))).toMatchObject({ kind: 'teammate', status: 'idle', teammateName: 'bob' });
    expect(h.agent(sub('teammate:carol'))).toMatchObject({ kind: 'teammate', status: 'idle' });
  });
});

describe('discovery sources', () => {
  const reg = (ts: number, extra: Record<string, unknown>) =>
    systemEvent({ kind: 'RegistryStatus', pid: 4242, alive: true, ...extra } as never, { ts, sessionId: SESSION, cwd: CWD, source: 'registry' });

  it('uses registry status for sessions without hook data', () => {
    const h = new Harness().apply(reg(T, { status: 'busy', name: 'demo-1', entrypoint: 'claude-vscode' }));
    expect(h.agent()).toMatchObject({ status: 'working', statusSource: 'registry', pid: 4242, registryName: 'demo-1', entrypoint: 'claude-vscode' });
    h.apply(reg(T + 10, { status: 'waiting', waitingFor: 'input needed' }));
    expect(h.agent().status).toBe('waiting_input');
  });

  it('does not let coarse "busy" override a more specific hook status', () => {
    const h = new Harness()
      .hook('PreToolUse', T, { tool_name: 'Bash', tool_use_id: 'b', tool_input: {} })
      .hook('PermissionRequest', T + 1, { tool_name: 'Bash', tool_input: {} })
      .apply(reg(T + 2, { status: 'busy' }));
    expect(h.agent().status).toBe('waiting_permission');
  });

  it('detects crashed sessions through the registry', () => {
    const h = new Harness()
      .hook('SubagentStart', T, { agent_id: 'a1' })
      .apply(systemEvent({ kind: 'RegistryStatus', pid: 4242, alive: false }, { ts: T + 100, sessionId: SESSION, source: 'registry' }));
    expect(h.agent()).toMatchObject({ status: 'ended', endReason: 'Process exited (no SessionEnd received)' });
    expect(h.agent(sub('a1')).status).toBe('ended');

    const h2 = new Harness().hook('UserPromptSubmit', T).apply(systemEvent({ kind: 'RegistryGone', pid: 1 }, { ts: T + 5, sessionId: SESSION, source: 'registry' }));
    expect(h2.agent().status).toBe('ended');
  });

  it('transcript discovery never invents a live status', () => {
    const h = new Harness().apply(
      systemEvent(
        { kind: 'TranscriptSeen', title: 'Fix login bug', model: 'claude-sonnet-5-5', lastActivityAt: T - 1000, usage: { inputTokens: 10, cacheReadTokens: 2000, cacheCreationTokens: 5, outputTokens: 50, at: T - 1000 } },
        { ts: T, sessionId: SESSION, cwd: CWD, source: 'transcript' },
      ),
    );
    expect(h.agent()).toMatchObject({ status: 'unknown', title: 'Fix login bug', statusSource: 'transcript', usageSource: 'transcript' });
    expect(h.agent().usage?.cacheReadTokens).toBe(2000);

    const h2 = new Harness().apply(systemEvent({ kind: 'TranscriptSeen', live: false }, { ts: T, sessionId: SESSION, source: 'transcript' }));
    expect(h2.agent().status).toBe('ended');

    // Hook-backed sessions keep their status; transcript only adds metadata.
    const h3 = new Harness().hook('UserPromptSubmit', T).apply(systemEvent({ kind: 'TranscriptSeen', title: 'T' }, { ts: T + 1, sessionId: SESSION, source: 'transcript' }));
    expect(h3.agent()).toMatchObject({ status: 'working', title: 'T' });
  });

  it('transcript subagent metadata fills gaps only', () => {
    const h = new Harness().apply(
      systemEvent({ kind: 'TranscriptSubagentSeen', finished: true, description: 'Search docs', spawnToolUseId: 'tu1' }, { ts: T, sessionId: SESSION, agentId: 'ax', agentType: 'web-fetch', source: 'transcript' }),
    );
    expect(h.agent(sub('ax'))).toMatchObject({ status: 'completed', parentVia: 'transcript', description: 'Search docs', spawnToolUseId: 'tu1' });

    const h2 = new Harness()
      .hook('SubagentStart', T, { agent_id: 'ay' })
      .apply(systemEvent({ kind: 'TranscriptSubagentSeen', finished: true }, { ts: T + 1, sessionId: SESSION, agentId: 'ay', source: 'transcript' }));
    expect(h2.agent(sub('ay')).status).toBe('working');
  });
});

describe('staleness, restore and pruning', () => {
  const tick = (ts: number) => systemEvent({ kind: 'Tick' }, { ts, sessionId: '*' });

  it('flags working agents that go quiet, without changing their status', () => {
    const h = new Harness().hook('UserPromptSubmit', T).apply(tick(T + DEFAULT_REDUCER_OPTIONS.staleAfterMs + 1));
    expect(h.agent()).toMatchObject({ status: 'working', stale: true });
    h.hook('PreToolUse', T + DEFAULT_REDUCER_OPTIONS.staleAfterMs + 2, { tool_name: 'Read', tool_use_id: 'r', tool_input: {} });
    expect(h.agent().stale).toBeUndefined();
  });

  it('allows long-running tools more time and never flags idle sessions', () => {
    const h = new Harness()
      .hook('PreToolUse', T, { tool_name: 'Bash', tool_use_id: 'b', tool_input: {} })
      .hook('Stop', T, {}, SESSION_B)
      .apply(tick(T + DEFAULT_REDUCER_OPTIONS.staleAfterMs + 1));
    expect(h.agent(SESSION).stale).toBeUndefined();
    expect(h.agent(SESSION_B).stale).toBeUndefined();
    h.apply(tick(T + DEFAULT_REDUCER_OPTIONS.staleToolAfterMs + 1));
    expect(h.agent(SESSION).stale).toBe(true);
    expect(h.agent(SESSION_B).stale).toBeUndefined();
  });

  it('marks restored live agents unknown until fresh evidence arrives', () => {
    const h = new Harness()
      .hook('PreToolUse', T, { tool_name: 'Bash', tool_use_id: 'b', tool_input: {} })
      .hook('SessionEnd', T, {}, SESSION_B)
      .apply(systemEvent({ kind: 'Restored' }, { ts: T + 10, sessionId: '*' }));
    expect(h.agent()).toMatchObject({ status: 'unknown', lastKnownStatus: 'working' });
    expect(h.agent().tools[0]!.status).toBe('unknown');
    expect(h.agent(SESSION_B).status).toBe('ended');
    // the live registry may then confirm the current state
    h.apply(systemEvent({ kind: 'RegistryStatus', pid: 1, alive: true, status: 'idle' }, { ts: T - 5000, sessionId: SESSION, source: 'registry' }));
    expect(h.agent().status).toBe('idle');
  });

  it('prunes old ended sessions together with their subagents and tasks', () => {
    const h = new Harness()
      .hook('SubagentStart', T, { agent_id: 'a1' })
      .hook('TaskCreated', T, { task_id: '1' })
      .hook('SessionEnd', T + 1)
      .hook('SessionStart', T + 1, {}, SESSION_B)
      .apply(tick(T + DEFAULT_REDUCER_OPTIONS.pruneAfterMs + 10));
    expect(Object.keys(h.state.agents)).toEqual([SESSION_B]);
    expect(h.state.tasks).toEqual({});
  });
});

describe('reducer properties', () => {
  const script: Array<[string, number, Record<string, unknown>, string?]> = [
    ['SessionStart', T, { source: 'startup' }],
    ['UserPromptSubmit', T + 1, {}],
    ['PreToolUse', T + 2, { tool_name: 'Agent', tool_use_id: 's1', tool_input: { subagent_type: 'Explore' } }],
    ['SubagentStart', T + 3, { agent_id: 'a1', agent_type: 'Explore' }],
    ['PreToolUse', T + 4, { agent_id: 'a1', tool_name: 'Grep', tool_use_id: 'g1', tool_input: {} }],
    ['PermissionRequest', T + 5, { tool_name: 'Bash', tool_input: {} }, SESSION_B],
    ['PostToolUse', T + 6, { agent_id: 'a1', tool_name: 'Grep', tool_use_id: 'g1', tool_input: {} }],
    ['SubagentStop', T + 7, { agent_id: 'a1' }],
    ['PostToolUse', T + 8, { tool_name: 'Agent', tool_use_id: 's1', tool_input: {} }],
    ['TaskCreated', T + 9, { task_id: 'k', task_subject: 'x' }],
    ['Stop', T + 10, {}],
  ];

  it('is pure: never mutates the previous state', () => {
    let s = deepFreeze(createInitialState());
    let seq = 0;
    for (const [e, ts, extra, sid] of script) {
      s = deepFreeze(reduce(s, { ...norm(hook(e, extra, sid), ts), seq: ++seq }));
    }
    expect(s.agents[SESSION]!.status).toBe('idle');
  });

  it('is deterministic: replaying the same events yields identical state', () => {
    const a = new Harness();
    const b = new Harness();
    for (const [e, ts, extra, sid] of script) {
      a.hook(e, ts, extra, sid);
      b.hook(e, ts, extra, sid);
    }
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it('bounds memory: tool history, log and notices are capped', () => {
    const h = new Harness();
    for (let i = 0; i < 2000; i++) {
      h.hook('PostToolUseFailure', T + i, { tool_name: 'Bash', tool_use_id: `b${i}`, tool_input: {}, error: 'x' });
    }
    expect(h.agent().tools.length).toBe(DEFAULT_REDUCER_OPTIONS.maxToolsPerAgent);
    expect(h.state.log.length).toBe(DEFAULT_REDUCER_OPTIONS.maxLog);
    expect(h.state.notices.length).toBe(DEFAULT_REDUCER_OPTIONS.maxNotices);
    expect(new Set(h.state.notices.map((n) => n.id)).size).toBe(h.state.notices.length);
    expect(h.agent().counts.tools).toBe(2000);
  });
});

describe('task re-creation', () => {
  it('reopens a task id that is created again after completion', () => {
    const h = new Harness()
      .hook('TaskCreated', T, { task_id: '1', task_subject: 'A' })
      .hook('TaskCompleted', T + 100, { task_id: '1' })
      .hook('TaskCreated', T + 5000, { task_id: '1', task_subject: 'B' });
    const t = h.state.tasks[taskKeyFor(SESSION, '1')]!;
    expect(t).toMatchObject({ status: 'open', createdAt: T + 5000, subject: 'B' });
    expect(t.completedAt).toBeUndefined();
  });

  it('treats a late duplicate TaskCreated as the same task', () => {
    const h = new Harness()
      .hook('TaskCompleted', T + 100, { task_id: '2' })
      .hook('TaskCreated', T, { task_id: '2' });
    expect(h.state.tasks[taskKeyFor(SESSION, '2')]).toMatchObject({ status: 'completed', createdAt: T });
  });
});
