// Usage plugin (observed transcript usage, cost-state, optional pricing).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInitialState,
  defaultLayout,
  normalizeHookPayload,
  reduce,
  type OfficeState,
  type UsageSessionDetail,
  type UsageSummary,
} from '@agent-office/core';
import { loadOrCreateConfig } from '../src/config';
import type { PluginContext } from '../src/plugin';
import { estimateCost, matchPrice, readChunk, usagePlugin, validatePriceTable, type ChunkReader, type UsagePluginOptions } from '../src/plugins/usage';
import { createMonitor } from '../src/server';
import { freePort, sleep, tempDir } from './helpers';

const SID = 'sess-usage-1';

function asst(id: string | undefined, usage: Partial<Record<'in' | 'out' | 'cw' | 'cr', number>>, extra: Record<string, unknown> = {}, model = 'claude-test-1'): string {
  const message: Record<string, unknown> = {
    model,
    role: 'assistant',
    content: [{ type: 'text', text: 'SECRET-CONTENT do not keep' }],
    usage: {
      input_tokens: usage.in ?? 0,
      output_tokens: usage.out ?? 0,
      cache_creation_input_tokens: usage.cw ?? 0,
      cache_read_input_tokens: usage.cr ?? 0,
    },
  };
  if (id) message.id = id;
  return JSON.stringify({ type: 'assistant', timestamp: '2026-11-17T10:00:00.000Z', cwd: 'c:\\work\\app', isSidechain: false, message, ...extra });
}

function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, cwd: 'c:\\work\\app' });
}

describe('usage plugin', () => {
  let home: ReturnType<typeof tempDir>;
  let claudeDir: string;
  let projectDir: string;
  let transcript: string;
  let state: OfficeState;

  function ctx(): PluginContext {
    return { home: home.path, claudeDirs: [claudeDir], now: () => Date.now(), log: () => {}, getState: () => state, getLayout: defaultLayout };
  }

  function knowSession(sessionId = SID, withPath = true): void {
    const r = normalizeHookPayload(
      {
        session_id: sessionId,
        hook_event_name: 'SessionStart',
        cwd: 'c:\\work\\app',
        ...(withPath ? { transcript_path: join(projectDir, `${sessionId}.jsonl`) } : {}),
      },
      Date.now(),
    );
    if (!r.ok) throw new Error(r.error);
    state = reduce(state, { ...r.event, seq: state.lastSeq + 1 });
  }

  async function started(o: UsagePluginOptions = {}) {
    const p = usagePlugin({ autoScan: false, ...o });
    await p.start!(ctx());
    return p;
  }

  const summary = async (p: ReturnType<typeof usagePlugin>) => (await p.routes!.summary!({})) as UsageSummary;
  const detail = async (p: ReturnType<typeof usagePlugin>, sessionId = SID) => (await p.routes!.session!({ sessionId })) as UsageSessionDetail;

  beforeEach(() => {
    home = tempDir('usage');
    claudeDir = join(home.path, 'claude');
    projectDir = join(claudeDir, 'projects', 'c--work-app');
    mkdirSync(projectDir, { recursive: true });
    transcript = join(projectDir, `${SID}.jsonl`);
    state = createInitialState();
  });
  afterEach(() => home.cleanup());

  it('sums assistant usage once per message id, keeping the per-field maximum of streaming repeats', async () => {
    writeFileSync(
      transcript,
      [
        userLine('a prompt that must never be stored'),
        asst('m1', { in: 10, out: 5 }),
        asst('m1', { in: 10, out: 50, cw: 100 }), // streaming repeat with final counts
        asst('m1', { in: 10, out: 7 }), // a smaller repeat never lowers or double counts
        asst('m2', { in: 1, out: 2, cr: 300 }),
        '',
      ].join('\n'),
    );
    knowSession();
    const p = await started();
    await p.scanNow();
    const s = await summary(p);
    expect(s.source).toBe('transcript');
    expect(s.total).toEqual({ inputTokens: 11, outputTokens: 52, cacheCreationTokens: 100, cacheReadTokens: 300, messages: 2 });
    expect(s.byModel.map((m) => m.model)).toEqual(['claude-test-1']);
    expect(s.sessions[0]).toMatchObject({ sessionId: SID, project: 'app', complete: true, inState: true });
    expect(s.byProject[0]).toMatchObject({ label: 'app', sessions: 1 });
    expect(JSON.stringify(s)).not.toMatch(/SECRET-CONTENT|never be stored/);
    // A second pass over an unchanged file adds nothing.
    await p.scanNow();
    expect((await summary(p)).total.messages).toBe(2);
    expect(p.meta!()).toMatchObject({ sessionsTracked: 1, filesTracked: 1, backlogBytes: 0, pricing: 'none' });
    await p.stop!();
  });

  it('reads only appended bytes and completes a partial last line on the next pass', async () => {
    const reads: number[] = [];
    const spy: ChunkReader = (file, offset, max, head) => {
      reads.push(offset);
      return readChunk(file, offset, max, head);
    };
    const first = asst('m1', { in: 5, out: 5 }) + '\n';
    const second = asst('m2', { in: 7, out: 3 });
    writeFileSync(transcript, first + second.slice(0, 40)); // m2 is still being written
    knowSession();
    const p = await started({ reader: spy });
    await p.scanNow();
    expect((await summary(p)).total).toMatchObject({ inputTokens: 5, messages: 1 });
    appendFileSync(transcript, second.slice(40) + '\n' + userLine('x') + '\n');
    await p.scanNow();
    expect((await summary(p)).total).toMatchObject({ inputTokens: 12, outputTokens: 8, messages: 2 });
    expect(reads).toEqual([0, Buffer.byteLength(first + second.slice(0, 40))]);
    await p.stop!();
  });

  it('counts a complete final line without a newline exactly once', async () => {
    writeFileSync(transcript, asst('m1', { in: 4, out: 4 }));
    knowSession();
    const p = await started();
    await p.scanNow();
    expect((await summary(p)).total.messages).toBe(1);
    await p.scanNow();
    appendFileSync(transcript, '\n' + asst('m2', { in: 1, out: 1 }) + '\n');
    await p.scanNow();
    expect((await summary(p)).total).toMatchObject({ inputTokens: 5, outputTokens: 5, messages: 2 });
    await p.stop!();
  });

  it('attributes subagent transcripts to their agent and deduplicates sidechain copies', async () => {
    const sub = join(projectDir, SID, 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'agent-ab12.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'look around' }));
    writeFileSync(join(sub, 'agent-ab12.jsonl'), [asst('s1', { in: 100, out: 10 }, { isSidechain: true }), asst('s2', { in: 50, out: 5 }, { isSidechain: true }, 'claude-small-1'), ''].join('\n'));
    writeFileSync(
      transcript,
      [
        asst('m1', { in: 10, out: 1 }),
        // Older layouts also copied subagent messages into the main file as sidechain records.
        asst('s1', { in: 100, out: 10 }, { isSidechain: true }),
        '',
      ].join('\n'),
    );
    knowSession();
    const p = await started();
    await p.scanNow();
    const d = await detail(p);
    expect(d.tracked).toBe(true);
    expect(d.total).toMatchObject({ inputTokens: 160, outputTokens: 16, messages: 3 });
    expect(d.subagents).toBe(1);
    const main = d.agents.find((a) => a.kind === 'main')!;
    expect(main.total).toMatchObject({ inputTokens: 10, messages: 1 });
    const explore = d.agents.find((a) => a.agent === 'ab12' || a.agent === 'sidechain')!;
    expect(d.agents.reduce((n, a) => n + a.total.messages, 0)).toBe(3);
    expect(Object.keys(d.byModel).sort()).toEqual(['claude-small-1', 'claude-test-1']);
    expect(d.subagentTotal.messages).toBe(2);
    expect(explore).toBeDefined();
    expect(d.agents.find((a) => a.agent === 'ab12')?.agentType).toBe('Explore');
    await p.stop!();
  });

  it('recounts from zero when a transcript is truncated or replaced (never double counts)', async () => {
    writeFileSync(transcript, [asst('m1', { in: 10 }), asst('m2', { in: 20 }), ''].join('\n'));
    knowSession();
    const p = await started();
    await p.scanNow();
    expect((await summary(p)).total.inputTokens).toBe(30);

    writeFileSync(transcript, asst('m3', { in: 3 }) + '\n'); // shorter: truncated
    await p.scanNow();
    let s = await summary(p);
    expect(s.total).toMatchObject({ inputTokens: 3, messages: 1 });
    expect(s.scan.resets).toBe(1);

    // Replaced by different, longer content: the first bytes differ.
    writeFileSync(transcript, [JSON.stringify({ type: 'summary', note: 'different head' }), asst('m4', { in: 4 }), asst('m5', { in: 5 }), ''].join('\n'));
    await p.scanNow();
    s = await summary(p);
    expect(s.total).toMatchObject({ inputTokens: 9, messages: 2 });
    expect(s.scan.resets).toBe(2);
    await p.stop!();
  });

  it('keeps the latest cost-state of the main transcript as "reported by Claude Code"', async () => {
    const sub = join(projectDir, SID, 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'agent-x1.jsonl'), JSON.stringify({ type: 'cost-state', totalCostUSD: 99 }) + '\n');
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'cost-state', totalCostUSD: 0.5, totalAPIDuration: 1000, timestamp: '2026-11-17T10:00:00.000Z' }),
        asst('m1', { in: 1 }),
        JSON.stringify({
          type: 'cost-state',
          totalCostUSD: 1.25,
          totalAPIDuration: 4200,
          timestamp: '2026-11-17T10:05:00.000Z',
          modelUsage: { 'claude-test-1': { inputTokens: 1, outputTokens: 2, costUSD: 1.25, junk: 'x' } },
        }),
        '',
      ].join('\n'),
    );
    knowSession();
    const p = await started();
    await p.scanNow();
    const d = await detail(p);
    expect(d.reported).toEqual({
      source: 'claude-code',
      totalCostUSD: 1.25,
      totalAPIDurationMs: 4200,
      at: Date.parse('2026-11-17T10:05:00.000Z'),
      modelUsage: { 'claude-test-1': { inputTokens: 1, outputTokens: 2, costUSD: 1.25 } },
    });
    const s = await summary(p);
    expect(s.reported).toEqual({ source: 'claude-code', sessions: 1, totalCostUSD: 1.25 });
    expect(s.byProject[0]).toMatchObject({ reportedCostUSD: 1.25, reportedSessions: 1 });
    expect(s.estimate).toBeUndefined(); // reported cost is never turned into an estimate
    await p.stop!();
  });

  it('estimates cost only from a valid user price table, and says so when none exists', async () => {
    writeFileSync(
      transcript,
      [asst('m1', { in: 1_000_000, out: 500_000, cw: 200_000, cr: 2_000_000 }), asst('m2', { in: 1_000_000 }, {}, 'claude-small-1'), asst('m3', { in: 10 }, {}, 'other-model'), ''].join('\n'),
    );
    knowSession();
    const p = await started();
    await p.scanNow();
    let s = await summary(p);
    expect(s.pricing).toEqual({ state: 'none', message: 'no price table configured', file: 'pricing.json' });
    expect(s.estimate).toBeUndefined();
    expect(s.sessions[0]!.estimate).toBeUndefined();

    writeFileSync(
      join(home.path, 'pricing.json'),
      JSON.stringify({
        version: 1,
        currency: 'USD',
        note: 'test prices',
        models: {
          'claude-test-1': { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.25 },
          'claude-*': { inputPerMTok: 1, outputPerMTok: 1 },
        },
      }),
    );
    s = await summary(p);
    expect(s.pricing).toMatchObject({ state: 'ok', currency: 'USD', models: 2, note: 'test prices' });
    // test-1: 1M*2 + 0.5M*10 + 0.2M*2.5 + 2M*0.25 = 2 + 5 + 0.5 + 0.5 = 8 ; small-1 via claude-*: 1M*1 = 1
    expect(s.estimate!.amount).toBeCloseTo(9, 9);
    expect(s.estimate).toMatchObject({ source: 'price-table', currency: 'USD', partial: true, unpricedModels: ['other-model'], unpricedCacheModels: [] });
    expect(s.byModel.find((m) => m.model === 'claude-test-1')!.estimate!.amount).toBeCloseTo(8, 9);

    writeFileSync(join(home.path, 'pricing.json'), JSON.stringify({ version: 1, currency: 'USD', models: { 'claude-test-1': { inputPerMtok: 1 } } }));
    s = await summary(p);
    expect(s.pricing.state).toBe('invalid');
    expect(s.pricing.state === 'invalid' && s.pricing.error).toMatch(/unknown field "inputPerMtok"/);
    expect(s.estimate).toBeUndefined();
    await p.stop!();
  });

  it('validates price tables strictly and matches exact ids before the longest prefix', () => {
    expect(validatePriceTable([]).ok).toBe(false);
    expect(validatePriceTable({ version: 2, currency: 'USD', models: { a: { inputPerMTok: 1, outputPerMTok: 1 } } })).toMatchObject({ ok: false });
    expect(validatePriceTable({ version: 1, currency: 'usd', models: { a: { inputPerMTok: 1, outputPerMTok: 1 } } })).toMatchObject({ ok: false });
    expect(validatePriceTable({ version: 1, currency: 'USD', models: {} })).toMatchObject({ ok: false });
    expect(validatePriceTable({ version: 1, currency: 'USD', models: { a: { inputPerMTok: -1, outputPerMTok: 1 } } })).toMatchObject({ ok: false });
    expect(validatePriceTable({ version: 1, currency: 'USD', models: { a: { inputPerMTok: 1 } } })).toMatchObject({ ok: false });
    expect(validatePriceTable({ version: 1, currency: 'USD', extra: 1, models: { a: { inputPerMTok: 1, outputPerMTok: 1 } } })).toMatchObject({ ok: false });
    expect(validatePriceTable({ version: 1, currency: 'USD', models: { 'bad key!': { inputPerMTok: 1, outputPerMTok: 1 } } })).toMatchObject({ ok: false });
    const r = validatePriceTable({
      version: 1,
      currency: 'EUR',
      models: { 'claude-*': { inputPerMTok: 1, outputPerMTok: 1 }, 'claude-big-*': { inputPerMTok: 3, outputPerMTok: 3 }, 'claude-big-2': { inputPerMTok: 5, outputPerMTok: 5 } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(matchPrice(r.table, 'claude-big-2')!.inputPerMTok).toBe(5);
    expect(matchPrice(r.table, 'claude-big-3')!.inputPerMTok).toBe(3);
    expect(matchPrice(r.table, 'claude-x')!.inputPerMTok).toBe(1);
    expect(matchPrice(r.table, 'gpt')).toBeUndefined();
    const e = estimateCost({ 'claude-x': { inputTokens: 1e6, outputTokens: 0, cacheCreationTokens: 5, cacheReadTokens: 0 } }, r.table);
    expect(e).toMatchObject({ currency: 'EUR', amount: 1, partial: true, unpricedCacheModels: ['claude-x'] });
  });

  it('skips records it cannot count honestly: no message id, synthetic models, unparsable lines', async () => {
    writeFileSync(
      transcript,
      [asst(undefined, { in: 5 }), asst('syn', { in: 9 }, {}, '<synthetic>'), '{"type":"assistant", broken', asst('ok', { in: 1 }), ''].join('\n'),
    );
    knowSession();
    const p = await started();
    await p.scanNow();
    const s = await summary(p);
    expect(s.total).toMatchObject({ inputTokens: 1, messages: 1 });
    expect(s.scan.skipped).toMatchObject({ noMessageId: 1, unparsableLines: 1 });
    await expect(p.routes!.session!({ sessionId: '../etc' })).rejects.toThrow('invalid sessionId');
    await p.stop!();
  });

  it('skips oversized unterminated lines without buffering them and resumes at the next line', async () => {
    const huge = asst('big', { in: 1000 }, { pad: 'x'.repeat(2000) });
    writeFileSync(transcript, asst('m1', { in: 1 }) + '\n' + huge.slice(0, 1500));
    knowSession();
    const p = await started({ maxLineBytes: 1000 });
    await p.scanNow();
    appendFileSync(transcript, huge.slice(1500) + '\n' + asst('m2', { in: 2 }) + '\n');
    await p.scanNow();
    const s = await summary(p);
    expect(s.total).toMatchObject({ inputTokens: 3, messages: 2 });
    expect(s.scan.skipped.oversizedLines).toBe(1);
    await p.stop!();
  });

  it('bounds the bytes read per pass and catches up over several passes', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push(asst(`m${i}`, { in: 1, out: 2 }), userLine('tool output '.repeat(20)));
    writeFileSync(transcript, lines.join('\n') + '\n');
    knowSession();
    const p = await started({ maxBytesPerPass: 4096, maxBytesPerFile: 4096 });
    await p.scanNow();
    let s = await summary(p);
    expect(s.scan.backlogBytes).toBeGreaterThan(0);
    expect(s.sessions[0]!.complete).toBe(false);
    for (let i = 0; i < 50 && s.scan.backlogBytes > 0; i++) {
      await p.scanNow();
      s = await summary(p);
    }
    expect(s.sessions[0]!.complete).toBe(true);
    expect(s.total).toMatchObject({ inputTokens: 40, outputTokens: 80, messages: 40 });
    await p.stop!();
  });

  it('time-boxes slow reads: a pass never waits on a stuck file, which is retried after a cooldown', async () => {
    writeFileSync(transcript, asst('m1', { in: 1 }) + '\n');
    knowSession();
    let calls = 0;
    const slow: ChunkReader = async (file, offset, max, head) => {
      calls += 1;
      if (calls === 1) await sleep(400);
      return readChunk(file, offset, max, head);
    };
    // The cooldown leaves room for a loaded machine between the timed-out pass and the summary.
    const p = await started({ reader: slow, readTimeoutMs: 50, cooldownMs: 300 });
    const t0 = Date.now();
    await p.scanNow();
    expect(Date.now() - t0).toBeLessThan(350);
    let s = await summary(p);
    expect(s.total.messages).toBe(0);
    expect(s.scan.slowFiles).toBe(1);
    await sleep(600);
    await p.scanNow();
    s = await summary(p);
    expect(s.total.messages).toBe(1);
    await p.stop!();
  });

  it('finds the transcript of a session without a path and tracks historical sessions on request', async () => {
    writeFileSync(transcript, asst('m1', { in: 3 }) + '\n');
    writeFileSync(join(projectDir, 'old-session.jsonl'), asst('o1', { in: 7 }) + '\n');
    knowSession(SID, false);
    const p = await started();
    await p.scanNow();
    expect((await detail(p)).total.inputTokens).toBe(3);
    const old = await detail(p, 'old-session');
    expect(old).toMatchObject({ tracked: true, transcriptFound: true, inState: false, complete: true });
    expect(old.total.inputTokens).toBe(7);
    const none = await detail(p, 'missing-session');
    expect(none).toMatchObject({ transcriptFound: false, complete: false });
    expect(none.total.messages).toBe(0);
    await p.stop!();
  });

  it('serves usage.summary through the monitor RPC and publishes meta', async () => {
    writeFileSync(transcript, asst('m1', { in: 2, out: 3 }) + '\n');
    const port = await freePort();
    const token = loadOrCreateConfig(home.path, { port }).token;
    const monitor = createMonitor({
      home: home.path,
      port,
      token,
      claudeDirs: [claudeDir],
      discovery: false,
      persist: false,
      plugins: [usagePlugin({ autoScan: false })],
      tickIntervalMs: 3_600_000,
    });
    await monitor.start();
    try {
      monitor.ingestHook({ session_id: SID, hook_event_name: 'SessionStart', cwd: 'c:\\work\\app', transcript_path: transcript });
      const s = (await monitor.rpc('usage.summary', { refresh: true })) as UsageSummary;
      expect(s.total).toMatchObject({ inputTokens: 2, outputTokens: 3, messages: 1 });
      expect(monitor.getMeta().plugins?.usage).toMatchObject({ sessionsTracked: 1, pricing: 'none' });
      const d = (await monitor.rpc('usage.session', { sessionId: SID })) as UsageSessionDetail;
      expect(d.agents.map((a) => a.kind)).toEqual(['main']);
    } finally {
      await monitor.stop();
    }
  });
});
