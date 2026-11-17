import { describe, expect, it } from 'vitest';
import { normalizeHookPayload, pretrimHookPayload, type MonitorEvent } from '@agent-office/core';
import { createDeduper, hookFingerprint } from '../src/dedupe';

const T = Date.parse('2026-11-17T10:00:00Z');
const payload = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: 'sess-1',
  cwd: 'c:\\work\\app',
  transcript_path: 'c:\\t\\sess-1.jsonl',
  permission_mode: 'default',
  hook_event_name: event,
  ...extra,
});
/** What the command forwarder POSTs: a pre-trimmed payload in an envelope with its capture time. */
const envelope = (p: Record<string, unknown>, ts: number) => ({ v: 1, ts, payload: pretrimHookPayload(p) });
const normalized = (raw: unknown, at: number): MonitorEvent => {
  const r = normalizeHookPayload(raw, at);
  if (!r.ok) throw new Error(r.error);
  return r.event;
};

describe('hook deduper', () => {
  it('drops the second copy delivered by hooks installed in two scopes (forwarder envelopes)', () => {
    const d = createDeduper({ windowMs: 2000 });
    const p = payload('PreToolUse', { tool_name: 'Read', tool_use_id: 'toolu_1', tool_input: { file_path: 'c:\\work\\app\\a.ts' } });
    expect(d.isDuplicate(envelope(p, T), T + 40)).toBe(false);
    expect(d.isDuplicate(envelope(p, T + 35), T + 900)).toBe(true);
  });

  it('drops duplicated raw HTTP-hook payloads using the arrival time', () => {
    const d = createDeduper();
    const p = payload('Stop', { last_assistant_message: 'Done.' });
    expect(d.isDuplicate(p, T)).toBe(false);
    expect(d.isDuplicate({ ...p }, T + 5)).toBe(true);
  });

  it('works on normalized events too, including spooled copies that arrive later with the original capture time', () => {
    const d = createDeduper();
    const p = payload('TaskCreated', { task_id: '7', task_subject: 'Fix it' });
    expect(d.isDuplicate(normalized(envelope(p, T), T + 10), T + 10)).toBe(false);
    // spool replay 10 s later: same capture time
    expect(d.isDuplicate(normalized(envelope(p, T + 3), T + 10_000), T + 10_000)).toBe(true);
  });

  it('never merges two tool uses without ids but with different inputs', () => {
    const d = createDeduper();
    const a = payload('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    const b = payload('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run lint' } });
    expect(d.isDuplicate(a, T)).toBe(false);
    expect(d.isDuplicate(b, T + 1)).toBe(false);
    // the same holds for normalized events (the summary differs)
    const n = createDeduper();
    expect(n.isDuplicate(normalized(a, T), T)).toBe(false);
    expect(n.isDuplicate(normalized(b, T + 1), T + 1)).toBe(false);
  });

  it('keeps events that differ only in ids: tool_use_id, task id, agent id, session', () => {
    const d = createDeduper();
    const base = { tool_name: 'Read', tool_input: { file_path: 'x' } };
    const inputs = [
      payload('PreToolUse', { ...base, tool_use_id: 'toolu_a' }),
      payload('PreToolUse', { ...base, tool_use_id: 'toolu_b' }),
      payload('PreToolUse', { ...base, tool_use_id: 'toolu_a', agent_id: 'sub-1' }),
      { ...payload('PreToolUse', { ...base, tool_use_id: 'toolu_a' }), session_id: 'sess-2' },
      payload('TaskCompleted', { task_id: '1' }),
      payload('TaskCompleted', { task_id: '2' }),
    ];
    for (const p of inputs) expect(d.isDuplicate(p, T)).toBe(false);
  });

  it('keeps an identical Notification repeated minutes apart, and drops it only inside the window', () => {
    const d = createDeduper({ windowMs: 2000 });
    const n = payload('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    expect(d.isDuplicate(envelope(n, T), T)).toBe(false);
    expect(d.isDuplicate(envelope(n, T + 120_000), T + 120_000)).toBe(false);
    expect(d.isDuplicate(envelope(n, T + 120_500), T + 120_600)).toBe(true);
    expect(d.isDuplicate(envelope(n, T + 300_000), T + 300_000)).toBe(false);
  });

  it('distinguishes notification types and hook events with otherwise equal payloads', () => {
    const d = createDeduper();
    expect(d.isDuplicate(payload('Notification', { notification_type: 'permission_prompt' }), T)).toBe(false);
    expect(d.isDuplicate(payload('Notification', { notification_type: 'idle_prompt' }), T)).toBe(false);
    expect(d.isDuplicate(payload('PreCompact'), T)).toBe(false);
    expect(d.isDuplicate(payload('PostCompact'), T)).toBe(false);
  });

  it('ignores key order and treats non-hook input as never duplicate', () => {
    const d = createDeduper();
    expect(d.isDuplicate({ hook_event_name: 'Stop', session_id: 's', cwd: 'c' }, T)).toBe(false);
    expect(d.isDuplicate({ cwd: 'c', session_id: 's', hook_event_name: 'Stop' }, T)).toBe(true);
    for (const junk of [null, 'x', 42, [], {}, { hook_event_name: 'Stop' }]) expect(d.isDuplicate(junk, T)).toBe(false);
    const tick = { seq: 0, ts: T, source: 'system', sessionId: '*', kind: 'Tick' };
    expect(d.isDuplicate(tick, T)).toBe(false);
    expect(d.isDuplicate(tick, T)).toBe(false);
  });

  it('forgets fingerprints after the retention period and bounds its memory', () => {
    const d = createDeduper({ windowMs: 1000, retainMs: 5000, maxEntries: 3 });
    for (let i = 0; i < 10; i++) d.isDuplicate(payload('PreToolUse', { tool_name: 'Read', tool_use_id: `t${i}` }), T + i);
    expect(d.size).toBeLessThanOrEqual(3);
    d.isDuplicate(payload('Stop'), T + 100);
    d.isDuplicate(payload('SessionEnd'), T + 60_000);
    expect(d.size).toBe(1);
    d.clear();
    expect(d.size).toBe(0);
  });

  it('fingerprints retain no payload content', () => {
    // Assembled at runtime so no secret-shaped literal is in the source (not a real key).
    const secret = ['sk', 'ant', 'api03', 'SECRETSECRETSECRET'].join('-');
    const fp = hookFingerprint(payload('UserPromptSubmit', { prompt: `use ${secret}` }))!;
    expect(fp.key).not.toContain('SECRET');
    expect(fp.key.startsWith('r|sess-1|')).toBe(true);
  });
});
