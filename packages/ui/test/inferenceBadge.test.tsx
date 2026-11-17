import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { InferenceDiagnostics, MonitorMeta } from '@agent-office/core';
import { InferenceBadge, inferenceBadgeModel } from '../src/components/InferenceBadge';

afterEach(cleanup);

const meta = (inference?: Partial<InferenceDiagnostics>): MonitorMeta => ({
  protocol: 1,
  monitorVersion: '0.1.0',
  startedAt: 0,
  claudeDirs: [],
  rejectedEvents: 0,
  spooledEventsReplayed: 0,
  ...(inference ? { plugins: { inference } } : {}),
});
const active: Partial<InferenceDiagnostics> = { guard: 'active', instrumented: ['http', 'https', 'fetch', 'child_process'], officeInferenceCalls: 0, externalRequests: 0 };

describe('InferenceBadge', () => {
  it('says "runtime verified" only while the runtime guard is active, and lists what it instruments', () => {
    render(<InferenceBadge meta={meta(active)} />);
    const b = screen.getByTestId('inference-badge');
    expect(b.textContent).toBe('Office inference calls: 0 · runtime verified');
    expect(b.className).toContain('tone-ok');
    expect(b.getAttribute('title')).toContain('Instrumented: http, https, fetch, child_process');
    expect(b.getAttribute('title')).toContain('not your Claude usage');
  });

  it('falls back to "static-checked" when the guard is inactive (VS Code host) or not reported', () => {
    for (const m of [meta({ guard: 'inactive', instrumented: [], officeInferenceCalls: 0, externalRequests: 0, inactiveReason: 'Inside the VS Code extension host.' }), meta(), undefined]) {
      const model = inferenceBadgeModel(m);
      expect(model.label).toBe('Office inference: static-checked');
      expect(model.tone).toBe('static');
      expect(model.title).toContain('runtime guard is not active in this host');
      expect(model.title).toContain('packages/monitor/test/staticNoInference.test.ts');
      expect(model.label).not.toMatch(/verified/);
    }
    expect(inferenceBadgeModel(meta({ guard: 'inactive', instrumented: [], officeInferenceCalls: 0, externalRequests: 0, inactiveReason: 'Inside the VS Code extension host.' })).title).toContain('VS Code extension host');
  });

  it('turns red when the office itself attempted inference, and amber on external requests', () => {
    const bad = inferenceBadgeModel(meta({ ...active, officeInferenceCalls: 2, lastViolation: { at: Date.now(), kind: 'inference:https', target: 'https://api.anthropic.com' } }));
    expect(bad).toMatchObject({ tone: 'bad', label: 'Office inference calls: 2 · blocked' });
    expect(bad.title).toContain('https://api.anthropic.com');
    const warn = inferenceBadgeModel(meta({ ...active, externalRequests: 3 }));
    expect(warn).toMatchObject({ tone: 'warn', label: 'Office inference calls: 0 · runtime verified · 3 external' });
  });

  it('never claims anything about the user account and ignores malformed plugin data', () => {
    for (const junk of [{ guard: 'yes' }, 'x', 42, null]) {
      expect(inferenceBadgeModel({ ...meta(), plugins: { inference: junk } }).tone).toBe('static');
    }
    for (const m of [meta(active), meta(), meta({ ...active, officeInferenceCalls: 1 })]) {
      expect(inferenceBadgeModel(m).title).not.toMatch(/your account (used|consumed) (0|zero|no)/i);
      expect(inferenceBadgeModel(m).label).not.toMatch(/token/i);
    }
  });
});
