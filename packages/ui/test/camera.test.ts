import { createElement, createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentKeyFor, createInitialState, defaultLayout, normalizeHookPayload, openOfficeLayout, reduce, type OfficeState } from '@agent-office/core';
import {
  approach,
  centerOn,
  clampCamera,
  fitCamera,
  fitZoom,
  isVisible,
  keyAction,
  KEY_PAN,
  MAX_ZOOM,
  MIN_ZOOM,
  OVERSCROLL,
  panBy,
  rootTransform,
  screenToWorld,
  snapZoom,
  stepZoom,
  visibleRect,
  WheelZoom,
  worldToScreen,
  ZOOM_STEPS,
  zoomAt,
  type Camera,
} from '../src/office/camera';
import { clientToTile, MiniMap } from '../src/components/MiniMap';

afterEach(cleanup);

const world = { w: 44 * 16, h: 30 * 16 + 6 }; // default office in world px
const view = { w: 1000, h: 600 };

describe('zoom steps', () => {
  it('keeps pixels crisp: whole steps from 1×, half steps only above 2×', () => {
    for (const z of ZOOM_STEPS) {
      if (z >= 1 && z <= 2) expect(Number.isInteger(z), String(z)).toBe(true);
      if (z > 2) expect(Number.isInteger(z * 2), String(z)).toBe(true);
    }
    expect([...ZOOM_STEPS].sort((a, b) => a - b)).toEqual(ZOOM_STEPS);
  });

  it('steps in and out and stays at the ends', () => {
    expect(stepZoom(1, 1)).toBe(2);
    expect(stepZoom(2, 1)).toBe(2.5);
    expect(stepZoom(2, -1)).toBe(1);
    expect(stepZoom(1.3, 1)).toBe(2);
    expect(stepZoom(1.3, -1)).toBe(1);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(snapZoom(1.9)).toBe(2);
    expect(snapZoom(100)).toBe(MAX_ZOOM);
  });

  it('fits the office like the original view: quarter steps below 2×, half steps above', () => {
    expect(fitZoom(world, { w: 1500, h: 900 })).toBe(1.75);
    expect(fitZoom(world, { w: 1600, h: 1100 })).toBe(2);
    expect(fitZoom(world, { w: 3000, h: 2000 })).toBe(4);
    expect(fitZoom(world, { w: 2600, h: 1800 })).toBe(3.5);
    expect(fitZoom(world, { w: 300, h: 200 })).toBe(MIN_ZOOM);
    expect(fitZoom({ w: 10, h: 10 }, { w: 5000, h: 5000 })).toBe(MAX_ZOOM);
    const classic = { w: 23 * 16, h: 14 * 16 + 6 };
    expect(fitZoom(classic, { w: 1000, h: 800 })).toBe(2.5);
    // from a fitted in-between zoom, +/- land on crisp steps
    expect(stepZoom(1.75, 1)).toBe(2);
    expect(stepZoom(1.75, -1)).toBe(1);
    const z = fitZoom(world, view);
    expect(world.w * z).toBeLessThanOrEqual(view.w);
    expect(world.h * z).toBeLessThanOrEqual(view.h);
    expect(fitCamera(world, view)).toEqual({ x: world.w / 2, y: world.h / 2, zoom: z });
  });
});

describe('camera transforms', () => {
  const cam: Camera = { x: 300, y: 200, zoom: 2 };

  it('round-trips world and screen coordinates with whole-pixel offsets', () => {
    const t = rootTransform(cam, view);
    expect(Number.isInteger(t.x) && Number.isInteger(t.y)).toBe(true);
    for (const p of [
      { x: 0, y: 0 },
      { x: 300, y: 200 },
      { x: 17.5, y: 99 },
    ]) {
      const back = screenToWorld(cam, view, worldToScreen(cam, view, p));
      expect(back.x).toBeCloseTo(p.x);
      expect(back.y).toBeCloseTo(p.y);
    }
    expect(worldToScreen(cam, view, { x: 300, y: 200 })).toEqual({ x: 500, y: 300 });
  });

  it('zooms around the pointer, keeping the world point under it fixed', () => {
    const big = { w: 4000, h: 4000 };
    const c = { x: 1000, y: 1000, zoom: 2 };
    const anchor = { x: 800, y: 150 };
    const before = screenToWorld(c, view, anchor);
    const z = zoomAt(c, 4, anchor, big, view);
    expect(z.zoom).toBe(4);
    const after = screenToWorld(z, view, anchor);
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  });

  it('pans with the pointer and keeps the office on screen', () => {
    const c = { x: 352, y: 243, zoom: 3 };
    const moved = panBy(c, 30, -60, world, view);
    expect(moved.x).toBeCloseTo(352 - 10);
    expect(moved.y).toBeCloseTo(243 + 20);
    const far = panBy(c, -100000, -100000, world, view);
    const r = visibleRect(far, view);
    expect(r.x + r.w).toBeLessThanOrEqual(world.w + OVERSCROLL / 3 + 1e-6);
    expect(r.y + r.h).toBeLessThanOrEqual(world.h + OVERSCROLL / 3 + 1e-6);
  });

  it('centres a small office and limits how far it can be dragged away', () => {
    const small = { w: 368, h: 230 };
    const c = clampCamera({ x: 9999, y: -9999, zoom: 1 }, small, view);
    expect(c.x).toBe(small.w / 2 + OVERSCROLL);
    expect(c.y).toBe(small.h / 2 - OVERSCROLL);
    expect(clampCamera({ x: 0, y: 0, zoom: 99 }, small, view).zoom).toBe(MAX_ZOOM);
  });

  it('centres on a point (focus) and reports visibility', () => {
    const c = centerOn({ x: 0, y: 0, zoom: 1 }, { x: 300, y: 250 }, world, view, 3);
    expect(c).toEqual({ x: 300, y: 250, zoom: 3 });
    expect(isVisible(c, view, { x: 300, y: 250 })).toBe(true);
    expect(isVisible(c, view, { x: 0, y: 0 })).toBe(false);
    // 150 world px right of centre at 3× is 450 screen px: inside a 24px margin; 160 (480px) is not
    expect(isVisible(c, view, { x: 300 + 150, y: 250 }, 24)).toBe(true);
    expect(isVisible(c, view, { x: 300 + 160, y: 250 }, 24)).toBe(false);
  });

  it('eases towards a goal and lands exactly on it', () => {
    const goal = { x: 500, y: 100, zoom: 2 };
    let c: Camera = { x: 0, y: 0, zoom: 2 };
    let steps = 0;
    while (c !== goal && steps < 200) {
      c = approach(c, goal, 16);
      steps++;
    }
    expect(c).toBe(goal);
    expect(steps).toBeGreaterThan(3);
    expect(approach({ x: 0, y: 0, zoom: 1 }, goal, 0)).not.toBe(goal);
  });
});

describe('camera input', () => {
  it('maps keys to camera actions', () => {
    expect(keyAction('ArrowLeft')).toEqual({ type: 'pan', dx: KEY_PAN, dy: 0 });
    expect(keyAction('ArrowDown')).toEqual({ type: 'pan', dx: 0, dy: -KEY_PAN });
    expect(keyAction('+')).toEqual({ type: 'zoom', dir: 1 });
    expect(keyAction('=')).toEqual({ type: 'zoom', dir: 1 });
    expect(keyAction('-')).toEqual({ type: 'zoom', dir: -1 });
    expect(keyAction('0')).toEqual({ type: 'fit' });
    expect(keyAction('a')).toBeUndefined();
  });

  it('turns mouse notches and trackpad deltas into single zoom steps', () => {
    const w = new WheelZoom(50);
    expect(w.push(-100, 0, 0)).toBe(1);
    expect(w.push(3, 1, 10)).toBe(0); // 3 lines = 48px
    expect(w.push(1, 1, 20)).toBe(-1);
    expect(w.push(10, 0, 30)).toBe(0);
    expect(w.push(-10, 0, 1000)).toBe(0); // stale delta forgotten
    expect(w.push(-45, 0, 1010)).toBe(1);
  });
});

describe('MiniMap', () => {
  it('converts clicks to tiles, clamped to the map', () => {
    const rect = { left: 10, top: 20, width: 176, height: 120 };
    expect(clientToTile(10 + 88, 20 + 60, rect, 44, 30)).toEqual({ x: 22, y: 15 });
    expect(clientToTile(-50, 999, rect, 44, 30)).toEqual({ x: 0, y: 30 });
  });

  it('draws rooms, walls and workers and navigates on click', () => {
    const layout = defaultLayout();
    const onNavigate = vi.fn();
    render(
      createElement(MiniMap, {
        layout,
        workers: [
          { key: 'a', x: 3, y: 4, status: 'working', selected: true },
          { key: 'b', x: 20, y: 25, status: 'idle', selected: false },
        ],
        view: { x: 10, y: 5, w: 20, h: 10 },
        onNavigate,
        width: 176,
      }),
    );
    const svg = screen.getByTestId('minimap');
    expect(svg.querySelectorAll('[data-room]')).toHaveLength(layout.rooms!.length);
    expect(svg.querySelectorAll('[data-worker]')).toHaveLength(2);
    expect(svg.querySelector('[data-worker="a"]')!.getAttribute('stroke')).toBe('#ffe066');
    expect(screen.getByTestId('minimap-view').getAttribute('width')).toBe('20');
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 176, height: 120, right: 176, bottom: 120, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(svg, { clientX: 44, clientY: 30 });
    expect(onNavigate).toHaveBeenCalledWith(11, 7.5);
  });

  it('works for layouts without rooms or walls', () => {
    render(createElement(MiniMap, { layout: openOfficeLayout(), workers: [], onNavigate: () => {} }));
    const svg = screen.getByTestId('minimap');
    expect(svg.querySelectorAll('[data-room]')).toHaveLength(0);
    expect(screen.queryByTestId('minimap-view')).toBeNull();
  });
});

// OfficeView with the scene mocked: no WebGL in jsdom.

const sceneMock = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown[]]>,
  callbacks: null as null | { onRoomClick?(id: string | null): void; onSelect(k: string | null): void },
}));

vi.mock('../src/office/scene', () => {
  const record =
    (name: string, ret?: unknown) =>
    (...args: unknown[]) => {
      sceneMock.calls.push([name, args]);
      return ret;
    };
  class FakeScene {
    constructor(_host: HTMLElement, cb: typeof sceneMock.callbacks) {
      sceneMock.callbacks = cb;
    }
    init = () => Promise.resolve();
    destroy = record('destroy');
    setLayout = record('setLayout');
    setWorkers = record('setWorkers');
    setSelected = record('setSelected');
    setShowNames = record('setShowNames');
    setEditMode = record('setEditMode');
    setIdleLife = record('setIdleLife');
    setVisitors = record('setVisitors');
    setSound = record('setSound');
    setOpenTasks = record('setOpenTasks');
    setHourOverride = record('setHourOverride');
    setAnimationFps = record('setAnimationFps');
    setReduceMotion = record('setReduceMotion');
    setRoomLabels = record('setRoomLabels');
    setIdleFrequency = record('setIdleFrequency');
    setDepartmentRules = record('setDepartmentRules');
    setActive = record('setActive');
    playCollabVisuals = record('playCollabVisuals');
    currentMeetings = () => [];
    focus = record('focus', true);
    fitView = record('fitView');
    zoomStep = record('zoomStep');
    panBy = record('panBy');
    centerOnTile = record('centerOnTile');
    getZoom = () => 2;
    minimapState = () => ({ zoom: 2, view: { x: 0, y: 0, w: 10, h: 8 }, workers: [{ key: 'a', x: 3, y: 4, status: 'idle', selected: false }] });
    roomOccupants = (id: string) =>
      id === 'meeting'
        ? [
            { key: 'b', name: 'Bob', status: 'idle', simulated: false, inMeeting: true },
            { key: 'c', name: 'Cy', status: 'idle', simulated: false },
          ]
        : [{ key: 'a', name: 'Alice', status: 'working', simulated: false }];
    roomDesks = () => ({ desks: 12, assigned: 3 });
    roomMeeting = (id: string) =>
      id === 'meeting'
        ? { who: 'agents', kind: 'meeting', phase: 'meeting', people: 2, endsAt: Date.now() + 3 * 60_000 }
        : id === 'huddle'
          ? { who: 'visitors', kind: 'meeting', phase: 'gathering', people: 3 }
          : undefined;
    startVisitorMeeting = record('startVisitorMeeting', 'ok');
  }
  return { OfficeScene: FakeScene };
});

describe('OfficeView', () => {
  const called = (name: string) => sceneMock.calls.filter(([n]) => n === name).map(([, a]) => a);
  const baseProps = () => ({
    layout: defaultLayout(),
    workers: [],
    selected: null,
    showNames: false,
    editMode: false,
    idleLife: true,
    openTasks: 0,
    onSelect: vi.fn(),
    onBoardClick: vi.fn(),
    onTileClick: vi.fn(),
    onItemMove: vi.fn(),
  });

  beforeEach(async () => {
    sceneMock.calls.length = 0;
    const { updateSettings, defaultSettings } = await import('../src/settings');
    updateSettings({ ...defaultSettings(), animationFps: 30, reduceMotion: true, roomLabels: false, minimap: true, idleFrequency: 'high' });
  });

  it('passes display settings to the scene and wires the camera controls and keys', async () => {
    const { OfficeView } = await import('../src/components/OfficeView');
    render(createElement(OfficeView, baseProps()));
    expect(called('setAnimationFps')).toEqual([[30]]);
    expect(called('setReduceMotion')).toEqual([[true]]);
    expect(called('setRoomLabels')).toEqual([[false]]);
    expect(called('setIdleFrequency')).toEqual([[2]]);
    expect(called('setVisitors')).toEqual([[true]]);
    expect(called('setDepartmentRules')).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    fireEvent.click(screen.getByLabelText('Zoom out'));
    fireEvent.click(screen.getByLabelText('Fit office'));
    expect(called('zoomStep')).toEqual([[1], [-1]]);
    expect(called('fitView')).toHaveLength(1);
    const canvas = screen.getByTestId('office-canvas');
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    fireEvent.keyDown(canvas, { key: '+' });
    fireEvent.keyDown(canvas, { key: '0' });
    fireEvent.keyDown(canvas, { key: 'ArrowUp', ctrlKey: true }); // ignored
    expect(called('panBy')).toEqual([[-KEY_PAN, 0]]);
    expect(called('zoomStep').at(-1)).toEqual([1]);
    expect(called('fitView')).toHaveLength(2);
  });

  it('shows a room card with honest wording, occupants and desk use', async () => {
    const parent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body });
    try {
      const { OfficeView } = await import('../src/components/OfficeView');
      const props = baseProps();
      render(createElement(OfficeView, props));
      expect(screen.queryByRole('dialog')).toBeNull();
      await act(async () => sceneMock.callbacks!.onRoomClick!('qa'));
      const card = screen.getByRole('dialog');
      expect(card.textContent).toContain('QA & Testing');
      expect(card.textContent).toMatch(/not by a Claude role/);
      expect(card.textContent).toContain('3 of 12 desks in use');
      fireEvent.click(within(card).getByText('Alice'));
      expect(props.onSelect).toHaveBeenCalledWith('a');
      fireEvent.click(screen.getByLabelText('Close room information'));
      expect(screen.queryByRole('dialog')).toBeNull();
      // the mini-map follows the setting and navigates the scene
      const map = screen.getByTestId('minimap');
      map.getBoundingClientRect = () => ({ left: 0, top: 0, width: 168, height: 115, right: 168, bottom: 115, x: 0, y: 0, toJSON: () => ({}) });
      fireEvent.click(map, { clientX: 84, clientY: 0 });
      expect(called('centerOnTile').at(-1)).toEqual([22, 0]);
      await act(async () => sceneMock.callbacks!.onRoomClick!('corridor'));
      expect(screen.getByRole('dialog').textContent).not.toMatch(/Claude role/); // not a department
      expect(screen.getByRole('dialog').textContent).not.toMatch(/simulated/); // no meeting here
      // a room with a simulated meeting says so, labelled as simulated, and marks who is in it
      await act(async () => sceneMock.callbacks!.onRoomClick!('meeting'));
      const meeting = screen.getByRole('dialog').textContent ?? '';
      expect(meeting).toContain('simulated');
      expect(meeting).toMatch(/Meeting · in progress · 2 agents · about 3 min left/);
      expect(meeting).toMatch(/Bob\s*in the meeting · Idle/);
      expect(meeting).not.toMatch(/Cy\s*in the meeting/);
      expect(within(screen.getByRole('dialog')).queryByText('Hold a simulated meeting here')).toBeNull(); // one is on
      // visitors meeting: said so, counted as visitors, never as agents
      await act(async () => sceneMock.callbacks!.onRoomClick!('huddle'));
      expect(screen.getByRole('dialog').textContent).toMatch(/simulated\s*Visitor meeting · gathering · 3 visitors/);
      // a free meeting room offers to bring visitors in for a meeting
      await act(async () => sceneMock.callbacks!.onRoomClick!('break'));
      fireEvent.click(within(screen.getByRole('dialog')).getByText('Hold a simulated meeting here'));
      expect(called('startVisitorMeeting')).toEqual([['break']]);
      expect(screen.getByRole('dialog').textContent).toContain('Visitors are on their way.');
      // not offered in rooms that are not for meetings
      await act(async () => sceneMock.callbacks!.onRoomClick!('qa'));
      expect(within(screen.getByRole('dialog')).queryByText('Hold a simulated meeting here')).toBeNull();
    } finally {
      if (parent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', parent);
    }
  });

  it('pauses when inactive, keeps the debug handle opt-in and plays verified collaboration effects', async () => {
    const { OfficeView } = await import('../src/components/OfficeView');
    const T = Date.now();
    let seq = 0;
    const step = (s: OfficeState, name: string, ts: number, extra: Record<string, unknown>) => {
      const r = normalizeHookPayload({ session_id: 's1', cwd: 'c:\\work\\app', hook_event_name: name, ...extra }, ts);
      if (!r.ok) throw new Error(r.error);
      return reduce(s, { ...r.event, seq: ++seq });
    };
    const s1 = step(createInitialState(), 'SessionStart', T - 300, { source: 'startup' });
    const s2 = step(
      step(s1, 'PreToolUse', T - 200, { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { subagent_type: 'Explore', description: 'Find tests' } }),
      'SubagentStart',
      T - 100,
      { agent_id: 'ex1', agent_type: 'Explore' },
    );
    const w = window as unknown as { __officeScene?: unknown };
    w.__officeScene = 'previous';
    const { rerender, unmount } = render(createElement(OfficeView, { ...baseProps(), active: false, debugHandle: false, collabState: s1 }));
    await act(async () => {});
    expect(called('setActive')).toEqual([[false]]);
    expect(w.__officeScene).toBe('previous'); // not replaced when the handle is off
    // simulated speech is labelled as such while idle life is on
    expect(screen.getByText(/simulated small talk \(local templates\), not agent output/)).toBeTruthy();
    // while paused, observed states only advance the baseline (no burst of old effects later)
    rerender(createElement(OfficeView, { ...baseProps(), active: false, debugHandle: false, collabState: s2 }));
    expect(called('playCollabVisuals')).toEqual([]);
    rerender(createElement(OfficeView, { ...baseProps(), active: true, debugHandle: false, collabState: s2 }));
    expect(called('setActive').at(-1)).toEqual([true]);
    const s3 = step(s2, 'SubagentStop', T, { agent_id: 'ex1' });
    rerender(createElement(OfficeView, { ...baseProps(), active: true, debugHandle: false, collabState: s3 }));
    const played = called('playCollabVisuals');
    expect(played).toHaveLength(1);
    expect((played[0]![0] as Array<{ kind: string; from: string; to: string }>).map((v) => [v.kind, v.from, v.to])).toEqual([
      ['complete', agentKeyFor('s1', 'ex1'), agentKeyFor('s1')],
    ]);
    unmount();
    expect(w.__officeScene).toBe('previous');
    delete w.__officeScene;
  });

  it('focuses agents through focusRequest and the ref handle', async () => {
    const { OfficeView } = await import('../src/components/OfficeView');
    const ref = createRef<import('../src/components/OfficeView').OfficeViewHandle>();
    const { rerender } = render(createElement(OfficeView, { ...baseProps(), ref, focusRequest: { key: 'x', seq: 1 } }));
    expect(called('focus')).toEqual([['x']]);
    rerender(createElement(OfficeView, { ...baseProps(), ref, focusRequest: { key: 'x', seq: 2 } }));
    expect(called('focus')).toEqual([['x'], ['x']]);
    expect(ref.current!.focus('y')).toBe(true);
    ref.current!.zoomIn();
    ref.current!.fit();
    expect(called('focus').at(-1)).toEqual(['y']);
    expect(called('zoomStep').at(-1)).toEqual([1]);
    expect(called('fitView')).toHaveLength(1);
  });
});
