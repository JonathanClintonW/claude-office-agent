import { describe, expect, it } from 'vitest';
import doc from '../../../docs/SIMULATION.md?raw';
import type { ActorContext } from '../src/office/behavior';
import {
  allDialogueLines,
  candidateFamilies,
  DIALOGUE_RULES,
  DIALOGUE_TABLE,
  isTemplateLine,
  pickLine,
  SPEECH_SOURCE,
  type DialogueFacts,
  type DialogueFamily,
  type DialogueInput,
  type DialogueRole,
} from '../src/office/dialogue';

function seeded(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const NOW = 10_000_000;
const MIN = 60_000;
const ctx = (over: Partial<DialogueFacts> = {}): DialogueFacts => ({ kind: 'session', sessionId: 's', status: 'idle', ...over });
const inp = (over: Partial<DialogueInput> = {}): DialogueInput => ({ role: 'solo', activity: 'coffee', now: NOW, hour: 14, rng: seeded(), ...over });
const families = Object.keys(DIALOGUE_TABLE) as DialogueFamily[];

const FAILURE_GATED: DialogueFamily[] = ['open_partner_failure', 'self_test_failure', 'self_build_failure', 'self_tool_failure', 'self_long_debug'];

describe('dialogue table', () => {
  it('is complete: every family has lines and exactly one rule, every rule a family', () => {
    for (const f of families) {
      expect(DIALOGUE_TABLE[f].length, f).toBeGreaterThan(0);
      expect(DIALOGUE_RULES.filter((r) => r.family === f), f).toHaveLength(1);
    }
    for (const r of DIALOGUE_RULES) {
      expect(families).toContain(r.family);
      expect(r.when.length).toBeGreaterThan(0);
      for (const a of r.after ?? []) expect(a.startsWith('open_'), a).toBe(true);
    }
    expect(SPEECH_SOURCE).toBe('local-template');
  });

  it('contains only short, generic lines: no numbers, names, paths, code or quotes', () => {
    for (const line of allDialogueLines()) {
      expect(line.length, line).toBeLessThanOrEqual(40);
      expect(line, line).not.toMatch(/\d/);
      expect(line, line).not.toMatch(/[/\\`"<>{}[\]@#$%^*_=|~]/);
      expect(line, line).not.toMatch(/\w\.\w/); // file.ext, dotted names
      expect(line, line).not.toMatch(/claude|anthropic|model|prompt/i);
      expect(line, line).toMatch(/[.!?]$/);
    }
  });

  it('only mentions results or failures in families gated by real evidence', () => {
    for (const f of families)
      for (const line of DIALOGUE_TABLE[f]) {
        if (/pass/i.test(line)) expect(f, line).toBe('self_tests_passed');
        if (/bug|fail|trouble|stubborn|snag|cooperate|disagree|acting up|rough|debugging|fighting/i.test(line)) expect(FAILURE_GATED, line).toContain(f);
      }
  });

  it('includes the reference lines', () => {
    const lines = allDialogueLines();
    for (const l of [
      'Coffee break?',
      'Another bug?',
      'That was a long debugging session.',
      'Finally, the tests passed.',
      'Back to work!',
      'I need some coffee.',
      'Those tests are giving me trouble.',
      "How's your project going?",
      'Done for now!',
    ])
      expect(lines).toContain(l);
    expect(isTemplateLine('Back to work!')).toBe(true);
    expect(isTemplateLine('Fixed the bug in app.ts')).toBe(false);
  });

  it('is documented verbatim in docs/SIMULATION.md', () => {
    for (const line of allDialogueLines()) expect(doc, line).toContain(line);
    for (const r of DIALOGUE_RULES) {
      expect(doc, r.family).toContain(`\`${r.family}\``);
      expect(doc, r.when).toContain(r.when);
    }
  });
});

describe('dialogue rules (context → family)', () => {
  it('uses only the activity without real context', () => {
    expect(candidateFamilies(inp())).toEqual(['act_coffee']);
    expect(candidateFamilies(inp({ hour: 23 }))).toEqual(['act_coffee_late']);
    expect(candidateFamilies(inp({ activity: 'toilet' }))).toEqual([]);
    expect(pickLine(inp({ activity: 'toilet' }))).toBeUndefined();
    // a stroll to another department is a short walk; sitting in a lounge chair stays silent
    expect(candidateFamilies(inp({ activity: 'stroll' }))).toEqual(['act_walk']);
    expect(candidateFamilies(inp({ activity: 'lounge' }))).toEqual([]);
  });

  it('talks about a recent test failure, but not an old or superseded one', () => {
    const fam = (self: DialogueFacts) => candidateFamilies(inp({ self }));
    const recent = ctx({ recentFailure: { kind: 'test', at: NOW - 5 * MIN } });
    expect(fam(recent)).toContain('self_test_failure');
    expect(fam(recent)).not.toContain('self_build_failure');
    expect(fam(recent)).not.toContain('self_tests_passed');
    expect(fam(ctx({ recentFailure: { kind: 'test', at: NOW - 30 * MIN } }))).not.toContain('self_test_failure');
    expect(fam(ctx({ recentFailure: { kind: 'test', at: NOW + MIN } }))).not.toContain('self_test_failure');
    expect(fam(ctx({ recentFailure: { kind: 'build', at: NOW - MIN } }))).toContain('self_build_failure');
    expect(fam(ctx({ recentFailure: { kind: 'tool', at: NOW - MIN } }))).toContain('self_tool_failure');
  });

  it('says the tests passed only after an observed pass that followed a test failure', () => {
    const fam = (self: DialogueFacts) => candidateFamilies(inp({ self }));
    const fixed = ctx({ recentFailure: { kind: 'test', at: NOW - 10 * MIN }, lastTestPassAt: NOW - MIN });
    expect(fam(fixed)).toContain('self_tests_passed');
    expect(fam(fixed)).not.toContain('self_test_failure');
    expect(fam(ctx({ recentFailure: { kind: 'test', at: NOW - MIN }, lastTestPassAt: NOW - 10 * MIN }))).not.toContain('self_tests_passed');
    expect(fam(ctx({ lastTestPassAt: NOW - MIN }))).not.toContain('self_tests_passed'); // no failure before: nothing "finally"
    expect(fam(ctx({ finishedAt: NOW - MIN }))).not.toContain('self_tests_passed'); // finishing is not a test result
  });

  it('recognizes long working stretches, with and without failures', () => {
    const fam = (self: DialogueFacts) => candidateFamilies(inp({ self }));
    expect(fam(ctx({ lastWorkMs: 25 * MIN, recentFailure: { kind: 'tool', at: NOW - MIN } }))).toContain('self_long_debug');
    expect(fam(ctx({ lastWorkMs: 25 * MIN }))).toContain('self_long_work');
    expect(fam(ctx({ lastWorkMs: 25 * MIN }))).not.toContain('self_long_debug');
    expect(fam(ctx({ lastWorkMs: 5 * MIN }))).not.toContain('self_long_work');
  });

  it('knows when an agent just finished', () => {
    expect(candidateFamilies(inp({ self: ctx({ finishedAt: NOW - MIN }) }))).toContain('self_just_finished');
    expect(candidateFamilies(inp({ self: ctx({ finishedAt: NOW - 10 * MIN }) }))).not.toContain('self_just_finished');
  });

  it('opens chats from the partner and the clock', () => {
    const open = (over: Partial<DialogueInput>) => candidateFamilies(inp({ role: 'open', activity: 'chat', ...over }));
    expect(open({ partner: ctx() })).toEqual(['open_generic', 'open_coffee']);
    expect(open({ partner: ctx({ recentFailure: { kind: 'test', at: NOW - MIN } }) })).toContain('open_partner_failure');
    expect(open({ partner: ctx({ lastWorkMs: 40 * MIN }) })).toContain('open_partner_long');
    expect(open({ partner: ctx({ finishedAt: NOW - MIN }) })).toContain('open_partner_finished');
    expect(open({ hour: 22 })).toContain('open_late');
    expect(open({ hour: 8 })).toContain('open_morning');
    expect(open({ hour: 14 })).not.toContain('open_late');
    expect(open({ self: ctx({ kind: 'teammate' }), partner: ctx({ kind: 'teammate' }) })).toContain('open_teammates');
    expect(open({ self: ctx({ kind: 'teammate' }), partner: ctx() })).not.toContain('open_teammates');
    expect(candidateFamilies(inp({ role: 'close', hour: 23 }))).toEqual(['close_back', 'close_late']);
  });

  it('answers coherently and never denies a real failure', () => {
    const reply = (after: DialogueFamily, self?: DialogueFacts) => candidateFamilies(inp({ role: 'reply', activity: 'chat', after, self }));
    const failing = ctx({ recentFailure: { kind: 'test', at: NOW - MIN } });
    expect(reply('open_partner_failure', failing)).toEqual(['self_test_failure', 'reply_neutral']);
    expect(reply('open_generic', failing)).not.toContain('reply_positive');
    expect(reply('open_generic', ctx())).toContain('reply_positive');
    expect(reply('open_coffee', ctx())).toEqual(['reply_agree', 'reply_neutral']);
    expect(reply('open_morning')).toContain('reply_morning');
  });

  it('picks window lines from night mode (or the hour)', () => {
    expect(candidateFamilies(inp({ activity: 'window', night: true }))).toEqual(['act_window_night']);
    expect(candidateFamilies(inp({ activity: 'window', night: false, hour: 23 }))).toEqual(['act_window_day']);
    expect(candidateFamilies(inp({ activity: 'window', hour: 23 }))).toEqual(['act_window_night']);
  });
});

describe('pickLine', () => {
  const ROLES: DialogueRole[] = ['open', 'reply', 'small_talk', 'close', 'solo'];
  const ACTIVITIES = ['chat', 'coffee', 'water', 'snack', 'toilet', 'couch', 'window', 'books', 'board', 'whiteboard', 'plant', 'stretch', 'walk', 'stroll', 'lounge'];
  const OPENERS = families.filter((f) => f.startsWith('open_'));

  const randomFacts = (r: () => number): ActorContext | undefined => {
    if (r() < 0.2) return undefined;
    const kinds = ['test', 'build', 'tool'] as const;
    const f: DialogueFacts = ctx({ kind: r() < 0.3 ? 'teammate' : 'session' });
    if (r() < 0.4) f.recentFailure = { kind: kinds[Math.floor(r() * 3)]!, at: NOW - Math.floor(r() * 40 * MIN) };
    if (r() < 0.3) f.lastTestPassAt = NOW - Math.floor(r() * 30 * MIN);
    if (r() < 0.4) f.lastWorkMs = Math.floor(r() * 60 * MIN);
    if (r() < 0.4) f.finishedAt = NOW - Math.floor(r() * 10 * MIN);
    return f;
  };

  it('never returns text outside the table, and only from applicable families', () => {
    const r = seeded(99);
    for (let i = 0; i < 3000; i++) {
      const c = inp({
        role: ROLES[Math.floor(r() * ROLES.length)]!,
        activity: ACTIVITIES[Math.floor(r() * ACTIVITIES.length)]!,
        self: randomFacts(r),
        partner: randomFacts(r),
        after: r() < 0.9 ? OPENERS[Math.floor(r() * OPENERS.length)] : undefined,
        hour: Math.floor(r() * 24),
        rng: r,
      });
      const line = pickLine(c);
      if (!line) {
        expect(candidateFamilies(c)).toEqual([]);
        continue;
      }
      expect(line.simulated).toBe(true);
      expect(DIALOGUE_TABLE[line.family]).toContain(line.text);
      expect(candidateFamilies(c)).toContain(line.family);
    }
  });

  it('always has an answer for any opener it produced', () => {
    const r = seeded(5);
    for (let i = 0; i < 1000; i++) {
      const leader = randomFacts(r);
      const partner = randomFacts(r);
      const hour = Math.floor(r() * 24);
      const open = pickLine(inp({ role: 'open', activity: 'chat', self: leader, partner, hour, rng: r }))!;
      expect(open).toBeDefined();
      const reply = pickLine(inp({ role: 'reply', activity: 'chat', after: open.family, self: partner, partner: leader, hour, rng: r }));
      expect(reply, open.family).toBeDefined();
    }
  });

  it('avoids recently said lines when the family has others', () => {
    const all = DIALOGUE_TABLE.act_coffee;
    for (let i = 0; i < 20; i++) expect(pickLine(inp({ avoid: all.slice(1), rng: seeded(i) }))!.text).toBe(all[0]);
    expect(all).toContain(pickLine(inp({ avoid: all }))!.text);
  });

  it('is deterministic for a seeded RNG', () => {
    const seq = (seed: number) => {
      const r = seeded(seed);
      return Array.from({ length: 50 }, () => pickLine(inp({ role: 'open', activity: 'chat', partner: ctx({ lastWorkMs: 30 * MIN }), rng: r }))!.text).join('|');
    };
    expect(seq(1)).toBe(seq(1));
    expect(seq(1)).not.toBe(seq(2));
  });
});
