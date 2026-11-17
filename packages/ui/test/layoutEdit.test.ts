import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultLayout, openOfficeLayout, reachableTiles, validateLayout, type OfficeLayout } from '@agent-office/core';
import { addRoom, addZone, applyTool, moveItem, removeRoom, removeZone, resizeLayout, updateRoom, updateZone, wallInRoom, type EditResult } from '../src/layoutEdit';
import { LayoutEditor, TOOL_GROUPS } from '../src/components/LayoutEditor';

afterEach(cleanup);

const layoutOf = (r: EditResult): OfficeLayout => {
  if (!r.ok) throw new Error(r.error);
  return r.layout;
};

describe('layout editing (classic office)', () => {
  const base = openOfficeLayout();

  it('places, moves and erases furniture with validation', () => {
    const placed = applyTool(base, 'plant', 7, 12);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const plant = placed.layout.items.find((i) => i.x === 7 && i.y === 12)!;
    expect(plant.type).toBe('plant');

    const moved = moveItem(placed.layout, plant.id, 7, 13);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const erased = applyTool(moved.layout, 'erase', 7, 13);
    expect(erased.ok && erased.layout.items.length).toBe(base.items.length);
  });

  it('rejects edits that would break the room', () => {
    const desk = base.items.find((i) => i.type === 'desk')!;
    // blocking a desk chair
    expect(applyTool(base, 'plant', desk.x, desk.y + 1)).toMatchObject({ ok: false, error: expect.stringContaining('chair is blocked') });
    // furniture on the wall, board on the floor, door off the bottom row
    expect(applyTool(base, 'desk', 3, 1).ok).toBe(false);
    expect(applyTool(base, 'board', 3, 5).ok).toBe(false);
    expect(applyTool(base, 'door', 3, 5).ok).toBe(false);
    // blocking the door
    expect(applyTool(base, 'plant', base.door.x, base.rows - 1).ok).toBe(false);
    expect(applyTool(base, 'erase', 0, 9).ok).toBe(false);
  });

  it('moves the door along the bottom row', () => {
    const r = applyTool(base, 'door', 3, base.rows - 1);
    expect(r.ok && r.layout.door.x).toBe(3);
  });

  it('resizes and drops out-of-bounds content', () => {
    const r = resizeLayout(base, 12, 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.items.every((i) => i.x < 12 && i.y < 10)).toBe(true);
    expect(r.layout.door.x).toBeLessThan(12);
    expect(validateLayout(r.layout).ok).toBe(true);
    expect(resizeLayout(base, 2, 10).ok).toBe(false);
  });

  it('adds, edits and removes zones', () => {
    const added = addZone(base);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const z = added.layout.zones[0]!;
    const edited = updateZone(added.layout, z.id, { name: 'Acme', workspaceMatch: 'work\\acme' });
    expect(edited.ok && edited.layout.zones[0]).toMatchObject({ name: 'Acme', workspaceMatch: 'work\\acme' });
    expect(updateZone(added.layout, z.id, { w: 500 }).ok).toBe(false);
    const removed = removeZone(added.layout, z.id);
    expect(removed.ok && removed.layout.zones).toEqual([]);
  });

  it('places every new furniture type', () => {
    let l = base;
    const types = ['server', 'whiteboard', 'screen', 'table', 'chair', 'snack', 'reception', 'noticeboard', 'console'] as const;
    types.forEach((t, i) => (l = layoutOf(applyTool(l, t, 1 + i, 12))));
    for (const t of types) expect(l.items.some((i) => i.type === t)).toBe(true);
  });
});

describe('walls', () => {
  const base = openOfficeLayout();

  it('places and erases wall tiles', () => {
    const walled = layoutOf(applyTool(base, 'wall', 7, 12));
    expect(walled.walls).toEqual([{ x: 7, y: 12 }]);
    expect(applyTool(walled, 'wall', 7, 12)).toEqual({ ok: false, error: 'There is already a wall here' });
    const unwalled = layoutOf(applyTool(walled, 'unwall', 7, 12));
    expect(unwalled.walls).toBeUndefined();
    expect(applyTool(unwalled, 'unwall', 7, 12)).toEqual({ ok: false, error: 'No wall here' });
    // the generic eraser removes walls too
    expect(layoutOf(applyTool(walled, 'erase', 7, 12)).walls).toBeUndefined();
  });

  it('refuses walls on furniture, the back wall, chairs and the door, and furniture on walls', () => {
    const desk = base.items.find((i) => i.type === 'desk')!;
    expect(applyTool(base, 'wall', desk.x, desk.y)).toEqual({ ok: false, error: 'Remove the furniture here first' });
    expect(applyTool(base, 'wall', 3, 1).ok).toBe(false);
    expect(applyTool(base, 'wall', desk.x, desk.y + 1)).toMatchObject({ ok: false, error: expect.stringContaining('blocked by a wall') });
    expect(applyTool(base, 'wall', base.door.x, base.rows - 1)).toMatchObject({ ok: false, error: 'a wall blocks the door' });
    const walled = layoutOf(applyTool(base, 'wall', 7, 12));
    expect(applyTool(walled, 'plant', 7, 12)).toEqual({ ok: false, error: 'Remove the wall here first' });
    expect(moveItem(walled, 'plant-1', 7, 12)).toMatchObject({ ok: false });
  });

  it('refuses walls that cut desks off from the door', () => {
    // close the row in front of the door: desks above are no longer reachable
    let l: EditResult = { ok: true, layout: base };
    for (let x = 0; x < base.cols && l.ok; x++) {
      if (x === base.door.x) continue;
      const next = applyTool(l.layout, 'wall', x, 11);
      if (!next.ok && next.error.includes('furniture')) continue;
      l = next;
    }
    // the last gap left is at the door column; closing it must fail
    expect(l.ok).toBe(true);
    const closed = applyTool(layoutOf(l), 'wall', base.door.x, 11);
    expect(closed).toMatchObject({ ok: false, error: expect.stringContaining('cannot be reached from the door') });
  });

  it('keeps walls and rooms consistent when resizing', () => {
    const big = defaultLayout();
    const r = resizeLayout(big, 36, big.rows);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.walls!.every((w) => w.x < 36)).toBe(true);
    expect(r.layout.rooms!.every((room) => room.x + room.w <= 36)).toBe(true);
    expect(r.layout.rooms!.find((room) => room.id === 'huddle')!.w).toBe(5); // clipped
    expect(r.layout.rooms!.some((room) => room.id === 'devops')).toBe(false); // entirely outside
    // cropping that seals a room with desks off from the door is refused
    expect(resizeLayout(big, 30, big.rows)).toMatchObject({ ok: false, error: expect.stringContaining('cannot be reached from the door') });
  });
});

describe('rooms', () => {
  it('adds a room in free space, edits it and removes it', () => {
    const base = openOfficeLayout();
    const added = layoutOf(addRoom(base, 'qa'));
    const room = added.rooms![0]!;
    expect(room).toMatchObject({ kind: 'qa', w: 6, h: 4 });
    const second = layoutOf(addRoom(added));
    expect(second.rooms).toHaveLength(2);
    expect(second.rooms![1]!.x).toBeGreaterThanOrEqual(room.x + room.w);
    const edited = layoutOf(updateRoom(second, room.id, { name: 'Testing', kind: 'security', w: 3 }));
    expect(edited.rooms![0]).toMatchObject({ name: 'Testing', kind: 'security', w: 3 });
    expect(updateRoom(second, room.id, { x: second.rooms![1]!.x - 1 })).toMatchObject({ ok: false, error: expect.stringContaining('overlaps') });
    expect(updateRoom(second, room.id, { kind: 'castle' as never }).ok).toBe(false);
    expect(updateRoom(second, 'nope', { w: 1 })).toEqual({ ok: false, error: 'Unknown room' });
    const removed = layoutOf(removeRoom(layoutOf(removeRoom(second, room.id)), second.rooms![1]!.id));
    expect(removed.rooms).toBeUndefined();
    expect(removeRoom(removed, 'nope').ok).toBe(false);
  });

  it('reports when there is no free floor for another room', () => {
    expect(addRoom(defaultLayout())).toMatchObject({ ok: false, error: expect.stringContaining('No free floor') });
  });

  it('walls a room in, leaving a doorway towards the office door', () => {
    const withRoom = layoutOf(addRoom(openOfficeLayout(), 'meeting'));
    const base = layoutOf(updateRoom(withRoom, withRoom.rooms![0]!.id, { x: 2, y: 11, w: 4, h: 2 }));
    const room = base.rooms![0]!;
    // the classic office has plants/couches/lamps there: wall-in skips furniture tiles
    const walled = layoutOf(wallInRoom(base, room.id));
    expect(walled.walls!.length).toBeGreaterThan(3);
    const reach = reachableTiles(walled);
    let inside = 0;
    for (let y = room.y; y < room.y + room.h; y++) for (let x = room.x; x < room.x + room.w; x++) if (reach.has(`${x},${y}`)) inside++;
    expect(inside).toBeGreaterThan(0); // the doorway lets people in
    expect(wallInRoom(walled, 'nope')).toEqual({ ok: false, error: 'Unknown room' });
  });
});

describe('LayoutEditor', () => {
  const props = (draft: OfficeLayout) => ({
    draft,
    tool: 'desk' as const,
    dirty: false,
    onTool: vi.fn(),
    onChange: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
  });

  it('offers wall, room and new furniture tools', () => {
    const p = props(defaultLayout());
    render(createElement(LayoutEditor, p));
    for (const label of ['Wall', 'Erase wall', 'Server rack', 'Whiteboard', 'Meeting chair', 'Table', 'Snacks', 'Reception', 'Noticeboard', 'Console', 'Screen']) {
      expect(screen.getByRole('radio', { name: label }), label).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('radio', { name: 'Wall' }));
    expect(p.onTool).toHaveBeenCalledWith('wall');
    const all = TOOL_GROUPS.flatMap((g) => g.tools.map(([t]) => t));
    expect(new Set(all).size).toBe(all.length);
  });

  it('edits rooms through the form', () => {
    const draft = defaultLayout();
    const p = props(draft);
    render(createElement(LayoutEditor, p));
    const meeting = within(screen.getByTestId('room-meeting'));
    fireEvent.change(meeting.getByLabelText('Room kind'), { target: { value: 'break' } });
    const r1 = p.onChange.mock.calls.at(-1)![0] as EditResult;
    expect(r1.ok && r1.layout.rooms!.find((r) => r.id === 'meeting')!.kind).toBe('break');
    fireEvent.change(meeting.getByLabelText('Room name'), { target: { value: 'Board room' } });
    const r2 = p.onChange.mock.calls.at(-1)![0] as EditResult;
    expect(r2.ok && r2.layout.rooms!.find((r) => r.id === 'meeting')!.name).toBe('Board room');
    fireEvent.click(meeting.getByText('Remove'));
    const r3 = p.onChange.mock.calls.at(-1)![0] as EditResult;
    expect(r3.ok && r3.layout.rooms!.some((r) => r.id === 'meeting')).toBe(false);
    fireEvent.click(screen.getByText('Small open office'));
    const r4 = p.onChange.mock.calls.at(-1)![0] as EditResult;
    expect(r4.ok && r4.layout.cols).toBe(23);
  });
});
