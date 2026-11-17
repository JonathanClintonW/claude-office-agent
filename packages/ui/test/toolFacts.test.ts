import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-office/core';
import { toolFacts, WORK_STRETCH_GAP_MS } from '../src/view';

type Tool = Agent['tools'][number];

let n = 0;
function tool(p: Partial<Tool> & Pick<Tool, 'status'>): Tool {
  n += 1;
  return { id: `t${n}`, hasRealId: true, name: 'Bash', summary: 'ls', ...p };
}

describe('toolFacts (observed tool calls only)', () => {
  it('returns nothing for an agent without tools', () => {
    expect(toolFacts([])).toEqual({});
  });

  it('finds the latest finished tool and an open failure', () => {
    const ok = tool({ status: 'succeeded', startedAt: 1_000, endedAt: 2_000 });
    const bad = tool({ status: 'failed', name: 'Bash', summary: 'npm test', startedAt: 3_000, endedAt: 4_000 });
    const f = toolFacts([ok, bad]);
    expect(f.last).toBe(bad);
    expect(f.failure).toEqual({ kind: 'test', at: 4_000 });
    expect(f.failureOpen).toBe(true);
  });

  it('closes the failure once a later tool succeeds and records the test pass', () => {
    const bad = tool({ status: 'failed', name: 'Bash', summary: 'npm test', startedAt: 1_000, endedAt: 2_000 });
    const fix = tool({ status: 'succeeded', name: 'Edit', summary: 'src/a.ts', startedAt: 3_000, endedAt: 3_500 });
    const pass = tool({ status: 'succeeded', name: 'Bash', summary: 'npm test', startedAt: 4_000, endedAt: 9_000 });
    const f = toolFacts([bad, fix, pass]);
    expect(f.failure?.kind).toBe('test');
    expect(f.failureOpen).toBeUndefined();
    expect(f.lastTestPassAt).toBe(9_000);
  });

  it('ignores running, unknown and awaiting-permission tools for outcomes', () => {
    const run = tool({ status: 'running', startedAt: 5_000 });
    const unk = tool({ status: 'unknown', startedAt: 1_000, endedAt: 2_000 });
    const perm = tool({ status: 'awaiting_permission', startedAt: 3_000 });
    const f = toolFacts([unk, perm, run]);
    expect(f.last).toBeUndefined();
    expect(f.failure).toBeUndefined();
  });

  it('measures only the latest cluster of tool activity', () => {
    const old = tool({ status: 'succeeded', startedAt: 0, endedAt: 1_000 });
    const gap = WORK_STRETCH_GAP_MS + 10_000;
    const a = tool({ status: 'succeeded', startedAt: 1_000 + gap, endedAt: 2_000 + gap });
    const b = tool({ status: 'succeeded', startedAt: 30_000 + gap, endedAt: 61_000 + gap });
    expect(toolFacts([old, a, b]).lastWorkMs).toBe(60_000);
  });
});
