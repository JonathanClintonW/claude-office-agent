import { STATUS_META, type Agent, type AgentStatus, type Source } from '@agent-office/core';

export function StatusPill({ status, stale }: { status: AgentStatus; stale?: boolean }) {
  const m = STATUS_META[status];
  return (
    <span className={`pill status-${status}`} style={{ ['--c' as string]: m.color }} title={m.description}>
      <span className="dot" />
      {m.label}
      {stale ? <span className="stale-tag" title="No events received for a while; status may be outdated"> · quiet</span> : null}
    </span>
  );
}

const SOURCE_LABEL: Record<Source, string> = {
  hook: 'hooks',
  registry: 'session registry',
  transcript: 'transcript',
  system: 'monitor',
};

export function SourceTag({ source }: { source: Source }) {
  return (
    <span className={`source source-${source}`} title={`Information from ${SOURCE_LABEL[source]}`}>
      {SOURCE_LABEL[source]}
    </span>
  );
}

export function KindBadge({ agent }: { agent: Agent }) {
  const label = agent.kind === 'session' ? 'session' : agent.kind === 'teammate' ? 'teammate' : 'subagent';
  return <span className={`badge kind-${agent.kind}`}>{label}</span>;
}

export function SimBadge() {
  return (
    <span className="badge sim" title="Simulated demo data from `agent-office simulate`; not a real agent">
      SIMULATED
    </span>
  );
}
