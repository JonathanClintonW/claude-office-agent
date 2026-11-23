import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { STATUS_META, type OfficeLayout, type OfficeState } from '@agent-office/core';
import type { SoundSink } from '../audio/engine';
import { isDepartmentKind, ROOM_KIND_LABELS } from '../departments';
import { keyAction } from '../office/camera';
import { collabVisuals } from '../office/collab';
import type { MeetingInfo } from '../office/meetings';
import { OfficeScene, type MiniMapState, type RoomMeeting, type RoomOccupant, type SceneCallbacks, type WorkerView } from '../office/scene';
import type { MeetingRequest } from '../office/visitors';
import { IDLE_FREQUENCY_MULTIPLIER, useSettings } from '../settings';
import { economy, officeEarnings, topEarner } from '../economy';
import { MiniMap } from './MiniMap';
import '../office.css';

/** Imperative controls for other views (e.g. "show in office"). */
export interface OfficeViewHandle {
  /** Centre the camera on a worker; false if that agent is not in the office. */
  focus(agentKey: string): boolean;
  fit(): void;
  zoomIn(): void;
  zoomOut(): void;
  /** Simulated meetings in the office right now (always simulated). */
  currentMeetings(): MeetingInfo[];
}

type DebugWindow = { __officeScene?: OfficeScene };

interface Props {
  layout: OfficeLayout;
  workers: WorkerView[];
  selected: string | null;
  showNames: boolean;
  editMode: boolean;
  idleLife: boolean;
  openTasks: number;
  onSelect(key: string | null): void;
  onBoardClick(): void;
  onTileClick(x: number, y: number): void;
  onItemMove(id: string, x: number, y: number): void;
  /** Optional: centre the camera on an agent whenever `seq` changes. */
  focusRequest?: { key: string; seq: number } | null;
  /** Optional imperative handle (React 19 ref prop). */
  ref?: Ref<OfficeViewHandle>;
  /** False pauses rendering and simulation (the office is hidden behind another view). Default true. */
  active?: boolean;
  /** Expose the scene as `window.__officeScene` for tests/diagnostics. Default true. */
  debugHandle?: boolean;
  /** Office coins (also needs the Settings switch). Off for replays. Default true. */
  economy?: boolean;
  /**
   * Real office state: verified collaboration events between two snapshots (delegation,
   * task handoff, completion) fly a small paper/card/check between the agents' desks.
   */
  collabState?: OfficeState;
  /** Clock for collabState evidence (a replay's position); default: now. */
  collabNow?: number;
  /** Fixed lighting hour (e.g. a replay's time); otherwise `?hour=` or the local clock. */
  hourOverride?: number | null;
  /** Where office sounds go (the live office only; replays stay silent). */
  sound?: SoundSink;
}

interface RoomCard {
  occupants: RoomOccupant[];
  desks: { desks: number; assigned: number };
  /** Simulated meeting or gathering in the room right now (office animation). */
  meeting?: RoomMeeting;
}

/** Rooms where a meeting can be held (and the room card offers to start one). */
const MEETING_ROOM_KINDS = new Set(['meeting', 'collaboration', 'break']);
const MEETING_LABEL: Record<string, string> = {
  meeting: 'Meeting',
  collaboration: 'Huddle',
  break: 'Group break',
  coffee: 'Coffee chat',
  chat: 'Group chat',
  discussion: 'Team discussion',
};
const MEETING_PHASE: Record<RoomMeeting['phase'], string> = { gathering: 'gathering', meeting: 'in progress', ending: 'wrapping up' };
const REQUEST_NOTE: Record<Exclude<MeetingRequest, 'ok'>, string> = {
  disabled: 'Visitors are off. Turn on Idle life (top bar) and Simulated visitors (Settings).',
  already: 'A visitor meeting is already on in another room.',
  busy: 'Agents are meeting here right now.',
  'no-seats': 'No free seats here right now.',
};

/** "Meeting · in progress · 3 agents · about 2 min left" for the room card. */
function meetingSummary(m: RoomMeeting, now: number): string {
  const kind = MEETING_LABEL[m.kind === 'social' ? (m.topic ?? 'chat') : m.kind] ?? 'Meeting';
  const what = m.who === 'visitors' ? `Visitor ${kind.toLowerCase()}` : kind;
  const noun = m.who === 'visitors' ? (m.people === 1 ? 'visitor' : 'visitors') : m.people === 1 ? 'agent' : 'agents';
  const parts = [what, MEETING_PHASE[m.phase] ?? m.phase, `${m.people} ${noun}`];
  if (m.phase === 'meeting' && m.endsAt !== undefined) {
    const min = Math.round((m.endsAt - now) / 60_000);
    parts.push(min >= 1 ? `about ${min} min left` : 'ending soon');
  }
  return parts.join(' · ');
}

/** `?hour=0..23` forces the lighting (preview/testing). */
function urlHour(): number | null {
  const q = new URLSearchParams(location.search);
  if (!q.has('hour')) return null;
  const hour = Number(q.get('hour'));
  return Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : null;
}

/** React host for the imperative PixiJS scene, plus camera controls, mini-map and room info. */
export function OfficeView({ ref, ...p }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<OfficeScene | null>(null);
  const cbs = useRef<Props>(p);
  cbs.current = p;
  const [settings] = useSettings();
  const [mini, setMini] = useState<MiniMapState | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [card, setCard] = useState<RoomCard | null>(null);
  const [zoom, setZoom] = useState<number | undefined>();
  /** Answer to "Hold a simulated meeting here" for the open room card. */
  const [requestNote, setRequestNote] = useState<string | null>(null);
  const visitorsOn = p.idleLife && settings.visitors && !p.editMode;
  const meetingShown = Boolean(card?.meeting);
  useEffect(() => setRequestNote(null), [roomId, meetingShown]);

  useEffect(() => {
    const callbacks: SceneCallbacks = {
      onSelect: (k) => cbs.current.onSelect(k),
      onBoardClick: () => cbs.current.onBoardClick(),
      onTileClick: (x, y) => cbs.current.onTileClick(x, y),
      onItemMove: (id, x, y) => cbs.current.onItemMove(id, x, y),
      onRoomClick: (id) => setRoomId(id),
    };
    const s = new OfficeScene(host.current!, callbacks);
    scene.current = s;
    let cancelled = false;
    const dbg = window as unknown as DebugWindow;
    const previous = dbg.__officeScene;
    const expose = p.debugHandle !== false;
    // setActive (effect below) runs before init() resolves, so a hidden office never starts its ticker.
    s.init()
      .then(() => {
        if (cancelled) return;
        if (expose) dbg.__officeScene = s;
      })
      .catch((e) => console.error('Office scene failed to start', e));
    s.setHourOverride(p.hourOverride ?? urlHour());
    s.setLayout(p.layout);
    s.setWorkers(p.workers);
    return () => {
      cancelled = true;
      if (expose && dbg.__officeScene === s) dbg.__officeScene = previous;
      s.destroy();
      scene.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => scene.current?.setActive(p.active !== false), [p.active]);
  useEffect(() => scene.current?.setHourOverride(p.hourOverride ?? urlHour()), [p.hourOverride]);
  // Verified collaboration events → desk-to-desk effects (only between consecutive states).
  const prevState = useRef<OfficeState | undefined>(undefined);
  useEffect(() => {
    const next = p.collabState;
    const prev = prevState.current;
    prevState.current = next;
    if (!next || !prev || prev === next || p.active === false) return;
    const visuals = collabVisuals(prev, next, { now: p.collabNow ?? Date.now() });
    if (visuals.length) scene.current?.playCollabVisuals(visuals);
  }, [p.collabState, p.active]);

  useEffect(() => scene.current?.setLayout(p.layout), [p.layout]);
  useEffect(() => scene.current?.setWorkers(p.workers), [p.workers]);
  useEffect(() => scene.current?.setSelected(p.selected), [p.selected]);
  useEffect(() => scene.current?.setShowNames(p.showNames), [p.showNames]);
  useEffect(() => {
    scene.current?.setEditMode(p.editMode);
    if (p.editMode) setRoomId(null);
  }, [p.editMode]);
  useEffect(() => scene.current?.setIdleLife(p.idleLife), [p.idleLife]);
  useEffect(() => scene.current?.setVisitors(settings.visitors), [settings.visitors]);
  useEffect(() => scene.current?.setEconomy(p.economy !== false && settings.coins ? economy : null), [p.economy, settings.coins]);
  // The crown goes to the office-wide top earner (same rule as the inspector and the Shop tab).
  const officeState = useRef(p.collabState);
  officeState.current = p.collabState;
  useEffect(() => {
    const on = p.economy !== false && settings.coins;
    const tick = () => {
      const state = officeState.current;
      scene.current?.setTopEarner(on && state ? topEarner(officeEarnings(state, Date.now())) : undefined);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [p.economy, settings.coins]);
  useEffect(() => scene.current?.setSound(p.sound ?? null), [p.sound]);
  useEffect(() => scene.current?.setOpenTasks(p.openTasks), [p.openTasks]);
  useEffect(() => scene.current?.setAnimationFps(settings.animationFps), [settings.animationFps]);
  useEffect(() => scene.current?.setReduceMotion(settings.reduceMotion), [settings.reduceMotion]);
  useEffect(() => scene.current?.setRoomLabels(settings.roomLabels), [settings.roomLabels]);
  useEffect(() => scene.current?.setIdleFrequency(IDLE_FREQUENCY_MULTIPLIER[settings.idleFrequency]), [settings.idleFrequency]);
  useEffect(() => scene.current?.setDepartmentRules(settings.departmentRules), [settings.departmentRules]);
  useEffect(() => {
    if (p.focusRequest) scene.current?.focus(p.focusRequest.key);
  }, [p.focusRequest?.seq, p.focusRequest?.key]);

  useImperativeHandle(
    ref,
    () => ({
      focus: (k) => scene.current?.focus(k) ?? false,
      fit: () => scene.current?.fitView(),
      zoomIn: () => scene.current?.zoomStep(1),
      zoomOut: () => scene.current?.zoomStep(-1),
      currentMeetings: () => scene.current?.currentMeetings() ?? [],
    }),
    [],
  );

  const room = roomId ? p.layout.rooms?.find((r) => r.id === roomId) : undefined;
  useEffect(() => {
    if (roomId && !room) setRoomId(null);
  }, [roomId, room]);

  // Poll the scene for the zoom readout, mini-map and open room card (only while visible).
  useEffect(() => {
    const showMini = settings.minimap;
    if (!showMini) setMini(null);
    const tick = () => {
      const s = scene.current;
      if (!s || !host.current || host.current.offsetParent === null) return;
      setZoom(s.getZoom());
      if (showMini) {
        const next = s.minimapState();
        setMini((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      }
      if (roomId) {
        const next: RoomCard = { occupants: s.roomOccupants(roomId), desks: s.roomDesks(roomId) };
        const meeting = s.roomMeeting(roomId);
        if (meeting) next.meeting = meeting;
        setCard(next);
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [settings.minimap, roomId]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const a = keyAction(e.key);
    const s = scene.current;
    if (!a || !s) {
      if (e.key === 'Escape' && roomId) setRoomId(null);
      return;
    }
    e.preventDefault();
    if (a.type === 'pan') s.panBy(a.dx, a.dy);
    else if (a.type === 'zoom') s.zoomStep(a.dir);
    else s.fitView();
  };

  return (
    <div className="office-view">
      <div
        className="office-canvas office-camera"
        ref={host}
        data-testid="office-canvas"
        tabIndex={0}
        role="application"
        aria-label="Office floor. Drag or use the arrow keys to pan, mouse wheel or plus and minus to zoom, 0 to fit."
        onKeyDown={onKeyDown}
      />
      <div className="cam-controls" role="toolbar" aria-label="Camera">
        <button className="btn small icon" aria-label="Zoom out" title="Zoom out (-)" onClick={() => scene.current?.zoomStep(-1)}>
          −
        </button>
        <span className="cam-zoom small" aria-live="polite">
          {zoom !== undefined ? `${zoom}×` : ''}
        </span>
        <button className="btn small icon" aria-label="Zoom in" title="Zoom in (+)" onClick={() => scene.current?.zoomStep(1)}>
          +
        </button>
        <button className="btn small" aria-label="Fit office" title="Fit the whole office (0)" onClick={() => scene.current?.fitView()}>
          Fit
        </button>
      </div>
      {p.idleLife && !p.editMode ? (
        <div
          className="sim-legend small"
          title={`Idle agents' small talk, meetings and breaks${settings.visitors ? ', and the visitors' : ''} are a local simulation. Nothing here is generated by a model or sent anywhere.`}
        >
          <span className="sim-legend-swatch" aria-hidden="true" />
          Dashed lavender bubbles: simulated small talk (local templates), not agent output
          {settings.visitors ? '. Lavender badge: simulated visitor' : ''}
        </div>
      ) : null}
      {settings.minimap && mini ? (
        <MiniMap layout={p.layout} workers={mini.workers} view={mini.view} onNavigate={(x, y) => scene.current?.centerOnTile(x, y)} />
      ) : null}
      {room && !p.editMode ? (
        <div className="room-card" role="dialog" aria-label={`${room.name} information`}>
          <div className="room-card-head">
            <strong>{room.name}</strong>
            <span className="pill">{ROOM_KIND_LABELS[room.kind]}</span>
            <button className="btn small icon" aria-label="Close room information" onClick={() => setRoomId(null)}>
              ×
            </button>
          </div>
          {isDepartmentKind(room.kind) ? (
            <p className="muted small">Department room. Agents are seated here by your local department rules (Settings), not by a Claude role.</p>
          ) : null}
          {card && card.desks.desks ? (
            <p className="small">
              {card.desks.assigned} of {card.desks.desks} desks in use
            </p>
          ) : null}
          {card?.meeting ? (
            <p
              className="small room-meeting"
              title={
                card.meeting.who === 'visitors'
                  ? 'Simulated visitors, not agents. They make room as soon as agents need it.'
                  : 'An office animation for idle agents. It is not real Claude Code work; an agent that gets work leaves at once.'
              }
            >
              <span className="sim-tag">simulated</span> {meetingSummary(card.meeting, Date.now())}
            </p>
          ) : MEETING_ROOM_KINDS.has(room.kind) ? (
            <div className="room-meeting-start">
              <button
                className="btn small"
                disabled={!visitorsOn}
                title={visitorsOn ? 'A few simulated visitors (not agents) come in and meet here for a few minutes.' : REQUEST_NOTE.disabled}
                onClick={() => {
                  const r = scene.current?.startVisitorMeeting(room.id) ?? 'disabled';
                  setRequestNote(r === 'ok' ? 'Visitors are on their way.' : REQUEST_NOTE[r]);
                }}
              >
                Hold a simulated meeting here
              </button>
              {requestNote ? <p className="muted small">{requestNote}</p> : null}
            </div>
          ) : null}
          {card && card.occupants.length ? (
            <ul className="room-occupants">
              {card.occupants.map((o) => (
                <li key={o.key}>
                  <button className="link" onClick={() => p.onSelect(o.key)}>
                    {o.simulated ? 'SIM ' : ''}
                    {o.name}
                  </button>
                  <span className="small">
                    {o.inMeeting ? <span className="room-occupant-meeting">in the meeting · </span> : null}
                    <span style={{ color: STATUS_META[o.status].color }}>{STATUS_META[o.status].label}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No agents in this room right now.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
