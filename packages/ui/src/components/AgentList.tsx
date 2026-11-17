import { agentTree, describeParentLink, displayName, isSimulated, type Agent, type OfficeState, type TreeNode } from '@agent-office/core';
import { ago } from '../hooks';
import { KindBadge, SimBadge, StatusPill } from './common';
import { Portrait } from './Portrait';

interface Props {
  state: OfficeState;
  agents: Agent[];
  selected: string | null;
  now: number;
  onSelect(key: string): void;
}

function Row({ node, depth, p }: { node: TreeNode; depth: number; p: Props }) {
  const a = node.agent;
  const current = a.currentToolId ? a.tools.find((t) => t.id === a.currentToolId) : undefined;
  return (
    <>
      <li>
        <button
          className={`agent-row ${p.selected === a.key ? 'selected' : ''}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => p.onSelect(a.key)}
          aria-current={p.selected === a.key}
        >
          <Portrait agent={a} scale={1} />
          <span className="agent-row-body">
          <span className="agent-row-top">
            <span className="agent-name" title={depth > 0 ? `${displayName(a)}\n${describeParentLink(a) ?? ''}`.trim() : displayName(a)}>
              {depth > 0 ? '└ ' : ''}
              {displayName(a)}
            </span>
            <StatusPill status={a.status} stale={a.stale} />
          </span>
          <span className="agent-row-sub">
            <KindBadge agent={a} />
            {isSimulated(a) ? <SimBadge /> : null}
            <span className="muted ellipsis" title={a.statusDetail}>
              {current ? `${current.name}: ${current.summary}` : (a.statusDetail ?? '')}
            </span>
            <span className="muted nowrap">{ago(a.lastEventAt, p.now)}</span>
          </span>
          </span>
        </button>
      </li>
      {node.children.map((c) => (
        <Row key={c.agent.key} node={c} depth={depth + 1} p={p} />
      ))}
    </>
  );
}

export function AgentList(p: Props) {
  const keys = new Set(p.agents.map((a) => a.key));
  const tree = agentTree(p.state, (a) => keys.has(a.key));
  if (!tree.length) {
    return (
      <div className="empty">
        <p>No agents to show.</p>
        <p className="muted">Start a Claude Code session, or check the data sources banner above.</p>
      </div>
    );
  }
  return (
    <ul className="agent-list" aria-label="Agents">
      {tree.map((n) => (
        <Row key={n.agent.key} node={n} depth={0} p={p} />
      ))}
    </ul>
  );
}
