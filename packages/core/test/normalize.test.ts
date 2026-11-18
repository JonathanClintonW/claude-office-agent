import { describe, expect, it } from 'vitest';
import { HOOK_EVENTS, normalizeHookPayload } from '../src/events';
import { pretrimHookPayload, redactSecrets, summarizeToolInput } from '../src/sanitize';
import { CWD, SESSION, hook } from './helpers';

const NOW = 1_800_000_000_000;

// Fake credentials are assembled at runtime so no secret-shaped literal exists in the
// source (keeps secret scanners and push protection quiet). None of these are real.
const FAKE = {
  anthropic: ['sk', 'ant', 'api03', 'x'.repeat(26)].join('-'),
  anthropicShort: ['sk', 'ant', 'api03', 'A'.repeat(16)].join('-'),
  github: ['gh', 'p_', 'a'.repeat(36)].join(''),
  aws: ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join(''),
  jwt: ['ey' + 'JhbGciOiJub25lIn0', 'ey' + 'JzdWIiOiJ0ZXN0In0', 'c2lnbmF0dXJlMTIz'].join('.'),
  pemBegin: ['-----BEGIN', 'RSA PRIVATE', 'KEY-----'].join(' '),
  pemEnd: ['-----END', 'RSA PRIVATE', 'KEY-----'].join(' '),
};

describe('normalizeHookPayload: validation', () => {
  it('rejects non-objects and missing identifiers', () => {
    expect(normalizeHookPayload(null, NOW).ok).toBe(false);
    expect(normalizeHookPayload([], NOW).ok).toBe(false);
    expect(normalizeHookPayload('x', NOW).ok).toBe(false);
    expect(normalizeHookPayload({ hook_event_name: 'Stop' }, NOW)).toEqual({ ok: false, error: 'missing or invalid session_id' });
    expect(normalizeHookPayload({ session_id: SESSION }, NOW)).toEqual({ ok: false, error: 'missing or invalid hook_event_name' });
  });

  it('rejects identifiers that could be used for injection or path tricks', () => {
    for (const bad of ['', '../etc', 'a b', 'x'.repeat(200), '<script>', 'a/b', 'a\\b']) {
      expect(normalizeHookPayload(hook('Stop', {}, bad), NOW).ok, bad).toBe(false);
    }
    expect(normalizeHookPayload(hook('Stop', { agent_id: '../../x' }), NOW).ok).toBe(false);
    expect(normalizeHookPayload(hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'bad id' }), NOW).ok).toBe(false);
  });

  it('requires agent_id for subagent lifecycle events', () => {
    expect(normalizeHookPayload(hook('SubagentStart', { agent_type: 'Explore' }), NOW)).toMatchObject({ ok: false });
    expect(normalizeHookPayload(hook('SubagentStop', {}), NOW)).toMatchObject({ ok: false });
  });

  it('requires tool_name for tool events and task_id for task events', () => {
    expect(normalizeHookPayload(hook('PreToolUse', {}), NOW).ok).toBe(false);
    expect(normalizeHookPayload(hook('PermissionRequest', { tool_name: '' }), NOW).ok).toBe(false);
    expect(normalizeHookPayload(hook('TaskCreated', { task_subject: 'x' }), NOW).ok).toBe(false);
    const r = normalizeHookPayload(hook('TaskCreated', { task_id: 7, task_subject: 'x' }), NOW);
    expect(r.ok && r.event.kind === 'TaskCreated' && r.event.taskId).toBe('7');
  });

  it('accepts every subscribed hook event with a minimal valid payload', () => {
    const extras: Record<string, Record<string, unknown>> = {
      SubagentStart: { agent_id: 'a1', agent_type: 'Explore' },
      SubagentStop: { agent_id: 'a1', agent_type: 'Explore' },
      PreToolUse: { tool_name: 'Read', tool_input: { file_path: 'c:\\x\\y.ts' }, tool_use_id: 'toolu_1' },
      PostToolUse: { tool_name: 'Read', tool_input: {}, tool_use_id: 'toolu_1', tool_response: {} },
      PostToolUseFailure: { tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_2', error: 'exit 1' },
      PermissionRequest: { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } },
      PermissionDenied: { tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_3', reason: 'nope' },
      TaskCreated: { task_id: 't1', task_subject: 'Write tests' },
      TaskCompleted: { task_id: 't1', task_subject: 'Write tests' },
    };
    for (const e of HOOK_EVENTS) {
      const r = normalizeHookPayload(hook(e, extras[e] ?? {}), NOW);
      expect(r.ok, `${e}: ${r.ok ? '' : r.error}`).toBe(true);
      if (r.ok) expect(r.event.kind).toBe(e);
    }
  });

  it('maps unrecognised hook events to UnknownHook instead of rejecting them', () => {
    const r = normalizeHookPayload(hook('FutureEvent'), NOW);
    expect(r.ok && r.event.kind).toBe('UnknownHook');
  });

  it('keeps Windows paths verbatim and extracts common fields', () => {
    const r = normalizeHookPayload(hook('Stop', { agent_type: 'Plan' }), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event).toMatchObject({ sessionId: SESSION, cwd: CWD, permissionMode: 'default', agentType: 'Plan', source: 'hook', ts: NOW });
    expect(r.event.transcriptPath).toContain('\\.claude\\projects\\');
  });
});

describe('normalizeHookPayload: forwarder envelope and timestamps', () => {
  it('uses the forwarder capture time when plausible', () => {
    const r = normalizeHookPayload({ v: 1, ts: NOW - 5000, payload: hook('Stop') }, NOW);
    expect(r.ok && r.event.ts).toBe(NOW - 5000);
  });

  it('falls back to receive time for implausible timestamps (clock skew, garbage)', () => {
    for (const ts of [NOW + 10 * 60_000, NOW - 30 * 24 * 3600_000, 'x', Number.NaN]) {
      const r = normalizeHookPayload({ v: 1, ts, payload: hook('Stop') }, NOW);
      expect(r.ok && r.event.ts).toBe(NOW);
    }
  });
});

describe('normalizeHookPayload: data minimisation', () => {
  it('never retains prompts, tool responses or file contents', () => {
    const secret = FAKE.anthropic;
    const prompt = normalizeHookPayload(hook('UserPromptSubmit', { prompt: `my key is ${secret}` }), NOW);
    expect(JSON.stringify(prompt)).not.toContain(secret);
    expect(JSON.stringify(prompt)).not.toContain('my key');

    const write = normalizeHookPayload(
      hook('PostToolUse', {
        tool_name: 'Write',
        tool_use_id: 'toolu_9',
        tool_input: { file_path: 'c:\\app\\.env', content: `API_KEY=${secret}` },
        tool_response: { filePath: 'c:\\app\\.env', success: true, content: 'FILE BODY' },
      }),
      NOW,
    );
    const s = JSON.stringify(write);
    expect(s).not.toContain(secret);
    expect(s).not.toContain('FILE BODY');
    expect(s).toContain('.env');
    expect(write.ok && write.event.kind === 'PostToolUse' && write.event.success).toBe(true);
  });

  it('redacts secrets inside Bash commands and errors', () => {
    const r = normalizeHookPayload(
      hook('PostToolUseFailure', {
        tool_name: 'Bash',
        tool_use_id: 'toolu_5',
        tool_input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" https://u:hunter2@example.com/?token=xyz' },
        error: `failed with GITHUB_TOKEN=${FAKE.github}`,
      }),
      NOW,
    );
    const s = JSON.stringify(r);
    expect(s).not.toContain('abcdefghijklmnop1234');
    expect(s).not.toContain('hunter2');
    expect(s).not.toContain(FAKE.github);
  });

  it('bounds the length of free text', () => {
    const r = normalizeHookPayload(hook('Stop', { last_assistant_message: 'x'.repeat(10_000) }), NOW);
    expect(r.ok && r.event.kind === 'Stop' && r.event.lastMessage!.length).toBeLessThanOrEqual(600);
  });

  it('counts running background tasks without keeping their details', () => {
    const r = normalizeHookPayload(
      hook('Stop', { background_tasks: [{ status: 'running', command: 'npm run dev' }, { status: 'completed' }, { status: 'running' }] }),
      NOW,
    );
    expect(r.ok && r.event.kind === 'Stop' && r.event.backgroundRunning).toBe(2);
    expect(JSON.stringify(r)).not.toContain('npm run dev');
  });
});

describe('summarizeToolInput', () => {
  it('summarises common tools without content', () => {
    expect(summarizeToolInput('Edit', { file_path: 'c:\\a\\b\\server.ts', old_string: 'SECRET', new_string: 'X' })).toEqual({
      summary: 'Edit server.ts',
      target: 'c:\\a\\b\\server.ts',
    });
    expect(summarizeToolInput('Bash', { command: 'npm test', description: 'Run tests' })).toEqual({ summary: 'Run tests', target: 'npm test' });
    expect(summarizeToolInput('Agent', { description: 'Find usages', subagent_type: 'Explore', prompt: 'long prompt' })).toEqual({
      summary: 'Delegate: Find usages',
      target: 'Explore',
    });
    expect(summarizeToolInput('WebFetch', { url: 'https://example.com/a/b?api_key=123#frag' }).target).toBe('https://example.com/a/b?…');
    expect(summarizeToolInput('mcp__github__create_issue', { title: 't', body: 'b' })).toMatchObject({
      summary: 'github › create_issue',
      mcpServer: 'github',
    });
    expect(
      summarizeToolInput('TodoWrite', { todos: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }] }).summary,
    ).toBe('Todo list: 3 items (1 done, 1 active)');
  });

  it('tolerates hostile or malformed input', () => {
    expect(summarizeToolInput('Read', null).summary).toBe('Read');
    expect(summarizeToolInput('Bash', ['x']).summary).toBe('Bash');
    expect(summarizeToolInput('Unknown', { a: 1, b: 2 }).summary).toBe('Unknown (a, b)');
  });
});

describe('redactSecrets', () => {
  it.each([
    [`export ANTHROPIC_API_KEY=${FAKE.anthropicShort}`, FAKE.anthropicShort.slice(0, 17)],
    ['mysql --password=hunter2 -u root', 'hunter2'],
    ['{"client_secret": "s3cr3t-value"}', 's3cr3t-value'],
    ['git clone https://user:tok3n@github.com/x/y', 'tok3n'],
    [`aws ${FAKE.aws}`, FAKE.aws],
    [`jwt ${FAKE.jwt}`, 'c2lnbmF0dXJl'],
    [`${FAKE.pemBegin}\nMIIabc\n${FAKE.pemEnd}`, 'MIIabc'],
  ])('redacts secret #%#', (input, leaked) => {
    expect(redactSecrets(input)).not.toContain(leaked);
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('npm run build && git status')).toBe('npm run build && git status');
  });
});

describe('pretrimHookPayload', () => {
  it('drops unused heavy fields and bounds strings', () => {
    const out = pretrimHookPayload({
      session_id: SESSION,
      hook_event_name: 'PostToolUse',
      prompt: 'secret prompt',
      tool_response: { success: true, stdout: 'x'.repeat(100_000) },
      tool_input: { content: 'y'.repeat(100_000), nested: { deep: { deeper: { deepest: 'z' } } } },
      permission_suggestions: [{ a: 1 }],
    });
    expect(out.prompt).toBeUndefined();
    expect(out.permission_suggestions).toBeUndefined();
    expect(out.tool_response).toEqual({ success: true });
    expect(JSON.stringify(out).length).toBeLessThan(5000);
    expect(normalizeHookPayload(out, NOW).ok).toBe(false); // tool_name missing in this synthetic payload
    expect(normalizeHookPayload({ ...out, tool_name: 'Write' }, NOW).ok).toBe(true);
  });
});
