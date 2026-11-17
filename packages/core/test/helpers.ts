import { normalizeHookPayload, type MonitorEvent } from '../src/events';
import { createInitialState, reduce, type OfficeState } from '../src/state';

export const SESSION = '11111111-2222-3333-4444-555555555555';
export const SESSION_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
export const CWD = 'c:\\work\\demo';

/** Build a raw hook payload the way Claude Code sends it. */
export function hook(event: string, extra: Record<string, unknown> = {}, sessionId = SESSION): Record<string, unknown> {
  return {
    session_id: sessionId,
    transcript_path: `C:\\Users\\dev\\.claude\\projects\\c--work-demo\\${sessionId}.jsonl`,
    cwd: CWD,
    permission_mode: 'default',
    hook_event_name: event,
    ...extra,
  };
}

export function norm(raw: unknown, ts: number): MonitorEvent {
  const r = normalizeHookPayload(raw, ts);
  if (!r.ok) throw new Error(`normalize failed: ${r.error}`);
  return r.event;
}

/** Apply a sequence of [payload, ts] pairs, assigning sequence numbers like the monitor. */
export class Harness {
  state: OfficeState = createInitialState();
  seq = 0;

  hook(event: string, ts: number, extra: Record<string, unknown> = {}, sessionId = SESSION): this {
    return this.apply(norm(hook(event, extra, sessionId), ts));
  }

  apply(ev: MonitorEvent): this {
    this.state = reduce(this.state, { ...ev, seq: ++this.seq });
    return this;
  }

  agent(key: string = SESSION) {
    const a = this.state.agents[key];
    if (!a) throw new Error(`no agent ${key}; have ${Object.keys(this.state.agents).join(', ')}`);
    return a;
  }
}
