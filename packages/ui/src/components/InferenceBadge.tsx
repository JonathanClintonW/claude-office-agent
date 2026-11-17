// Zero-extra-inference indicator in the nav row.
import { ZERO_INFERENCE_STATIC_TEST, type InferenceDiagnostics, type MonitorMeta } from '@agent-office/core';
import './InferenceBadge.css';

export type InferenceBadgeTone = 'ok' | 'static' | 'warn' | 'bad';

export interface InferenceBadgeModel {
  tone: InferenceBadgeTone;
  label: string;
  title: string;
}

const SCOPE =
  'This counts only what Agent Office itself does. It is not your Claude usage: your own Claude Code sessions use tokens as usual.';
const STATIC_LINE = `Static check: ${ZERO_INFERENCE_STATIC_TEST} fails if any office code can call a model, reach an inference host or launch Claude.`;

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** The plugin meta comes from the monitor: accept it only if it has the expected shape. */
function diagnostics(meta?: MonitorMeta): InferenceDiagnostics | undefined {
  const d = meta?.plugins?.inference as Partial<InferenceDiagnostics> | undefined;
  if (!d || typeof d !== 'object' || (d.guard !== 'active' && d.guard !== 'inactive')) return undefined;
  return { ...d, instrumented: Array.isArray(d.instrumented) ? d.instrumented.filter((x) => typeof x === 'string') : [] } as InferenceDiagnostics;
}

function violationLine(d: InferenceDiagnostics): string | undefined {
  const v = d.lastViolation;
  if (!v || typeof v.kind !== 'string' || typeof v.target !== 'string') return undefined;
  const at = typeof v.at === 'number' ? ` at ${new Date(v.at).toLocaleTimeString()}` : '';
  return `Last: ${v.kind} to ${v.target}${at}.`;
}

/** What the badge says. "Runtime verified" appears only while the runtime guard reports itself active. */
export function inferenceBadgeModel(meta?: MonitorMeta): InferenceBadgeModel {
  const d = diagnostics(meta);
  const calls = count(d?.officeInferenceCalls);
  if (d && calls > 0) {
    return {
      tone: 'bad',
      label: `Office inference calls: ${calls} · blocked`,
      title: [
        `The runtime guard blocked ${calls} attempt${calls === 1 ? '' : 's'} by the office itself to reach a model or launch Claude. Nothing was sent.`,
        violationLine(d),
        'This should never happen: please report it.',
        SCOPE,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
  if (d?.guard === 'active') {
    const external = count(d.externalRequests);
    return {
      tone: external > 0 ? 'warn' : 'ok',
      label: `Office inference calls: 0 · runtime verified${external > 0 ? ` · ${external} external` : ''}`,
      title: [
        `Runtime guard active in the monitor process. Instrumented: ${d.instrumented.join(', ') || 'none'}.`,
        'Requests to Claude inference hosts and launches of Claude are blocked and counted.',
        `External (non-loopback) requests: ${external}${external > 0 ? ' (expected 0).' : '.'}`,
        external > 0 ? violationLine(d) : undefined,
        SCOPE,
        STATIC_LINE,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
  const reason = d ? d.inactiveReason : 'This monitor does not report a runtime guard.';
  return {
    tone: 'static',
    label: 'Office inference: static-checked',
    title: ['The runtime guard is not active in this host.', reason, STATIC_LINE, SCOPE].filter(Boolean).join('\n'),
  };
}

export function InferenceBadge({ meta }: { meta?: MonitorMeta }) {
  const m = inferenceBadgeModel(meta);
  return (
    <span className={`inference-badge tone-${m.tone}`} title={m.title} data-testid="inference-badge">
      <span className="dot" aria-hidden="true" />
      {m.label}
    </span>
  );
}
