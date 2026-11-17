// Team view: real collaboration from observed Claude Code events, kept apart from the
// office simulation (simulated meetings and gatherings), which is described at the bottom.
import { useMemo, useState } from 'react';
import { displayName, type Agent, type OfficeState } from '@agent-office/core';
import { SimBadge, StatusPill } from '../components/common';
import { TeamGraph } from '../components/TeamGraph';
import { ago, clock } from '../hooks';
import { collabSignals, isCollaborative, parallelWork, teams, type CollabSignal, type Team, type TeamRelation } from '../office/collab';
import type { MeetingInfo } from '../office/meetings';
import type { ViewProps } from './types';
import './team.css';

const FEED_LIMIT = 40;
const TASKS_PER_TEAM = 8;

export interface TeamViewProps extends ViewProps {
  /** Optional live simulated meetings from the office scene (MeetingScheduler.currentMeetings()). */
  meetings?: readonly MeetingInfo[];
}

/** Display names, unique within each team (several subagents of one type often share a short id). */
type Names = Readonly<Record<string, string>>;

function nameOf(state: OfficeState, names: Names, key: string | undefined): string {
  const a = key ? state.agents[key] : undefined;
  return a ? (names[a.key] ?? displayName(a)) : 'unknown agent';
}

function AgentLink({ state, names, k, onSelect }: { state: OfficeState; names: Names; k: string | undefined; onSelect(key: string): void }) {
  const a = k ? state.agents[k] : undefined;
  if (!a) return <span className="muted">unknown agent</span>;
  return (
    <button className="link" onClick={() => onSelect(a.key)} title="Open in the inspector">
      {names[a.key] ?? displayName(a)}
    </button>
  );
}

function SourceLabel({ simulated }: { simulated: boolean }) {
  return simulated ? (
    <span className="team-tag sim" title="From `agent-office simulate` demo data, not a real Claude Code session">
      Demo data
    </span>
  ) : (
    <span className="team-tag real" title="Derived from events Claude Code actually reported">
      Real agent event
    </span>
  );
}

function Confidence({ s }: { s: Pick<CollabSignal, 'confidence' | 'note'> }) {
  return (
    <span className={`team-tag ${s.confidence}`} title={s.note}>
      {s.confidence}
    </span>
  );
}

const KIND_TEXT: Record<Agent['kind'], string> = { session: 'lead', subagent: 'subagent', teammate: 'teammate' };

/** How a member is linked to its parent, in words (the evidence is in the note). */
function relationText(rel: TeamRelation): string {
  if (rel.confidence === 'inferred') return 'assumed to belong to';
  switch (rel.kind) {
    case 'delegation':
      return 'delegated by';
    case 'nested_delegation':
      return 'nested, delegated by';
    case 'teammate':
      return 'teammate of';
    case 'subagent':
      return 'started in the session of';
  }
}

function kindCounts(team: Team): string {
  const sub = team.members.filter((m) => m.agent.kind === 'subagent').length;
  const tm = team.members.filter((m) => m.agent.kind === 'teammate').length;
  const parts = [sub ? `${sub} ${sub === 1 ? 'subagent' : 'subagents'}` : '', tm ? `${tm} ${tm === 1 ? 'teammate' : 'teammates'}` : ''].filter(Boolean);
  return `${team.members.length} ${team.members.length === 1 ? 'member' : 'members'}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

/** One row per member: its link to the parent, the evidence behind it, and its real status. */
function MemberTable({ team, state, names, onSelect }: { team: Team; state: OfficeState; names: Names; onSelect(key: string): void }) {
  const relByChild = new Map(team.relations.map((r) => [r.to, r]));
  const parallel = team.working.length >= 2;
  return (
    <div className="team-members-wrap">
      <table className="team-members small" aria-label="Members and evidence">
      <thead>
        <tr>
          <th scope="col">Member</th>
          <th scope="col">Link</th>
          <th scope="col">Evidence</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {team.members.map((m) => {
          const rel = relByChild.get(m.key);
          const working = parallel && team.working.includes(m.key);
          return (
            <tr key={m.key} className={rel?.confidence === 'inferred' ? 'inferred' : undefined} data-key={m.key}>
              <td>
                <span className="team-indent" style={{ ['--depth' as string]: Math.max(0, m.depth - 1) }} aria-hidden />
                <AgentLink state={state} names={names} k={m.key} onSelect={onSelect} /> <span className="muted tiny">{KIND_TEXT[m.agent.kind]}</span>
              </td>
              <td>
                {rel ? (
                  <>
                    {relationText(rel)} <AgentLink state={state} names={names} k={rel.from} onSelect={onSelect} /> <Confidence s={rel} />
                  </>
                ) : (
                  <span className="muted">no parent in view</span>
                )}
              </td>
              <td className="team-evidence">{rel?.note ?? <span className="muted">not observed</span>}</td>
              <td>
                <StatusPill status={m.agent.status} stale={m.agent.stale} />
                {working ? (
                  <span className="team-tag parallel" title="Reported as working at the same time as other agents of this session">
                    ∥ parallel
                  </span>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
      </table>
    </div>
  );
}

function TeamCard({ team, state, names, now, onSelect }: { team: Team; state: OfficeState; names: Names; now: number; onSelect(key: string): void }) {
  const lead = team.lead;
  const tasks = [...team.tasks].reverse().slice(0, TASKS_PER_TEAM);
  const parallel = team.working.length >= 2;
  return (
    <article className={`card team-card${team.active ? '' : ' ended'}`} aria-label={`Team ${lead ? nameOf(state, names, lead.key) : team.sessionId}`}>
      <header className="team-head">
        {lead ? <AgentLink state={state} names={names} k={lead.key} onSelect={onSelect} /> : <span className="muted">Session not in view</span>}
        {lead ? <StatusPill status={lead.status} stale={lead.stale} /> : null}
        {team.simulated ? <SimBadge /> : null}
        {team.teamNames.map((n) => (
          <span key={n} className="badge kind-teammate" title="Team name reported by agent-team hook events">
            {n}
          </span>
        ))}
        <span className="muted small">
          {kindCounts(team)} · active {ago(team.lastActivityAt, now)}
        </span>
        {parallel ? (
          <span className="team-tag parallel" title="Agents of this session reported as working at the same time">
            ∥ {team.working.length} working in parallel
          </span>
        ) : null}
        {team.partial ? (
          <span className="team-tag inferred" title="Some links are inferred or the session itself is missing">
            partial
          </span>
        ) : null}
      </header>

      <TeamGraph team={team} onSelectAgent={onSelect} />

      {team.members.length ? <MemberTable team={team} state={state} names={names} onSelect={onSelect} /> : null}

      {tasks.length ? (
        <div className="team-tasks">
          <div className="card-title">Task links</div>
          <ul>
            {tasks.map((t) => (
              <li key={t.taskKey} className={`team-task${t.handoff ? ' handoff' : ''}`}>
                <span className="team-task-subject">{t.subject ?? `Task #${t.taskId}`}</span>
                <span className="muted small">
                  {t.createdBy ? (
                    <>
                      created by <AgentLink state={state} names={names} k={t.createdBy} onSelect={onSelect} />
                    </>
                  ) : (
                    'creator not observed'
                  )}
                  {t.status === 'completed' ? (
                    t.completedBy ? (
                      <>
                        {' · completed by '}
                        <AgentLink state={state} names={names} k={t.completedBy} onSelect={onSelect} />
                      </>
                    ) : (
                      ' · completed'
                    )
                  ) : t.orphaned ? (
                    ' · open at session end'
                  ) : (
                    ' · open'
                  )}
                </span>
                {t.handoff ? <span className="team-tag handoff">handoff</span> : null}
              </li>
            ))}
          </ul>
          {team.tasks.length > tasks.length ? <p className="muted tiny">+{team.tasks.length - tasks.length} older tasks on the Tasks tab</p> : null}
        </div>
      ) : null}
    </article>
  );
}

function FeedRow({ s, state, names, now, onSelect }: { s: CollabSignal; state: OfficeState; names: Names; now: number; onSelect(key: string): void }) {
  return (
    <li className={`team-feed-row kind-${s.kind}`}>
      <span className="team-feed-time muted small" title={clock(s.at)}>
        {ago(s.at, now)}
      </span>
      <SourceLabel simulated={s.simulated} />
      <span className="team-feed-label">{s.label}</span>
      <span className="team-feed-who small">
        <AgentLink state={state} names={names} k={s.from} onSelect={onSelect} />
        <span className="muted" aria-hidden>
          {' → '}
        </span>
        <AgentLink state={state} names={names} k={s.to} onSelect={onSelect} />
      </span>
      {s.subject ? <span className="team-feed-subject small">“{s.subject}”</span> : null}
      <Confidence s={s} />
    </li>
  );
}

const MEETING_LABEL: Record<string, string> = {
  meeting: 'Meeting',
  collaboration: 'Huddle',
  break: 'Group break',
  coffee: 'Coffee chat',
  chat: 'Group chat',
  discussion: 'Pretend team discussion',
};
const PHASE_LABEL: Record<MeetingInfo['phase'], string> = { gathering: 'gathering', meeting: 'in progress', ending: 'wrapping up' };

function SimulationSection({ meetings, state, names }: { meetings?: readonly MeetingInfo[]; state: OfficeState; names: Names }) {
  return (
    <section className="team-sim" aria-label="Office simulation">
      <h3>
        Office simulation <span className="team-tag sim">Office simulation</span>
      </h3>
      <p className="small">
        <strong>Simulated office activity, not Claude Code activity.</strong> When agents are idle, the office scene sometimes:
      </p>
      <ul className="team-sim-kinds small">
        <li>seats two to five of them in a meeting, collaboration or break room (meetings, huddles and group breaks);</li>
        <li>
          gathers three or four of them standing in a common area: a coffee chat, a group chat in the break room or a pretend team
          discussion in the collaboration area;
        </li>
        <li>lets two of them chat, fetch a coffee or take a short walk.</li>
      </ul>
      <p className="small">
        This is a local animation. No model is called and no tokens are spent. Bubbles are icons, and the occasional short line comes
        from a fixed list of local templates (dashed lavender bubbles), never from a model or an agent. None of it says anything about
        real work, tasks or messages. Real status always wins, so an agent that gets work, a permission prompt or a question leaves at
        once. The simulation pauses while the office view is hidden.
      </p>
      {meetings && meetings.length ? (
        <ul className="team-sim-list small">
          {meetings.map((m) => (
            <li key={m.id}>
              <span className="team-tag sim">simulated</span> {MEETING_LABEL[m.kind === 'social' ? (m.topic ?? 'chat') : m.kind] ?? 'Meeting'} · {m.roomName}{' '}
              · {PHASE_LABEL[m.phase] ?? m.phase} · {m.participants.map((k) => nameOf(state, names, k)).join(', ')}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Live simulated meetings and gatherings are shown in the office scene. Nothing on this page depends on them.</p>
      )}
    </section>
  );
}

export function TeamView(props: TeamViewProps) {
  const { snap, now, onSelectAgent, meetings } = props;
  const state = snap.state;
  const [showEnded, setShowEnded] = useState(false);
  const all = useMemo(() => teams(state), [state]);
  const names = useMemo<Names>(() => Object.assign({}, ...all.map((t) => t.names)), [all]);
  const signals = useMemo(() => collabSignals(state), [state]);
  const live = useMemo(() => parallelWork(state), [state]);

  const visible = all.filter((t) => showEnded || t.active);
  const sessions = new Set(visible.map((t) => t.sessionId));
  const collaborative = visible.filter(isCollaborative);
  const solo = visible.filter((t) => !isCollaborative(t));
  const feed = signals.filter((s) => sessions.has(s.sessionId)).reverse().slice(0, FEED_LIMIT);
  const hiddenEnded = all.length - visible.length;
  const noAgents = Object.keys(state.agents).length === 0;

  return (
    <section className="page team-page" aria-label="Team">
      <h2>Team</h2>
      <p className="muted small">
        Who works with whom, from real Claude Code events only: subagent delegation, agent-team teammates and task handoffs. Solid
        links were reported by hooks. Dashed links are inferred, and each one says why. The office simulation at the bottom of this
        page is separate and never feeds into it.
      </p>
      <div className="team-toolbar">
        <span className="team-legend small" aria-label="Legend">
          <span className="team-line solid" aria-hidden /> verified
          <span className="team-line dashed" aria-hidden /> inferred
          <span className="team-line handoff" aria-hidden /> task handoff
        </span>
        <label className="ctl check small">
          <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} />
          <span>Include ended sessions{hiddenEnded && !showEnded ? ` (${hiddenEnded})` : ''}</span>
        </label>
      </div>

      <h3>Teams</h3>
      {noAgents ? (
        <p className="empty muted">
          {snap.synced ? 'No agents yet.' : 'Waiting for the monitor…'} Teams appear when a Claude Code session delegates to subagents, runs
          agent-team teammates or hands off tasks.
        </p>
      ) : collaborative.length === 0 ? (
        <p className="empty muted">
          No delegation, teammates or task handoffs observed{showEnded ? '' : ' in live sessions'}. Subagents and tasks need the Claude
          Code hooks.
        </p>
      ) : (
        <div className="team-list">
          {collaborative.map((t) => (
            <TeamCard key={t.sessionId} team={t} state={state} names={names} now={now} onSelect={onSelectAgent} />
          ))}
        </div>
      )}
      {solo.length ? (
        <p className="team-solo small">
          <span className="muted">Working solo: </span>
          {solo.map((t, i) => (
            <span key={t.sessionId}>
              {i ? ', ' : ''}
              {t.lead ? <AgentLink state={state} names={names} k={t.lead.key} onSelect={onSelectAgent} /> : t.sessionId}
            </span>
          ))}
        </p>
      ) : null}

      <section className="team-feed" aria-label="Real agent events">
        <h3>
          Real agent events <span className="team-tag real">Real agent event</span>
        </h3>
        <p className="muted small">Real Claude Code events only, newest first. Nothing in this list is simulated.</p>
        {live.filter((g) => sessions.has(g.sessionId)).map((g) => (
          <p key={g.sessionId} className="team-live small">
            <SourceLabel simulated={g.simulated} /> <span className="team-tag parallel">live</span> {g.keys.length} agents of{' '}
            <AgentLink state={state} names={names} k={g.leadKey} onSelect={onSelectAgent} /> working in parallel:{' '}
            {g.keys.map((k, i) => (
              <span key={k}>
                {i ? ', ' : ''}
                <AgentLink state={state} names={names} k={k} onSelect={onSelectAgent} />
              </span>
            ))}
          </p>
        ))}
        {feed.length ? (
          <ol className="team-feed-list">
            {feed.map((s) => (
              <FeedRow key={s.id} s={s} state={state} names={names} now={now} onSelect={onSelectAgent} />
            ))}
          </ol>
        ) : (
          <p className="muted small">No delegations, handoffs or completions yet.</p>
        )}
        <p className="team-anim small">
          <span className="team-tag verified" title="Office animation of an event listed above">
            Animation of a verified event
          </span>{' '}
          In the office, a verified delegation also sends the new subagent past its parent&apos;s desk for a short briefing (about three
          seconds) on its way to its own desk. A verified task handoff between two idle agents walks the completer over to the
          creator&apos;s desk for a few seconds. These animations only show that the event happened. They are not messages: nothing is
          said, and they never happen without a verified event. A permission prompt, a question or a failure ends them at once.
        </p>
      </section>

      <SimulationSection meetings={meetings} state={state} names={names} />
    </section>
  );
}
