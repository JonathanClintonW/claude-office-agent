import { defaultLayout, MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS, openOfficeLayout, ROOM_KINDS, WALL_ROWS, type OfficeLayout, type Room, type RoomKind, type Zone } from '@agent-office/core';
import { ROOM_KIND_LABELS } from '../departments';
import {
  addRoom,
  addZone,
  removeRoom,
  removeZone,
  resizeLayout,
  updateRoom,
  updateZone,
  wallInRoom,
  type EditResult,
  type EditTool,
} from '../layoutEdit';
import '../office.css';

interface Props {
  draft: OfficeLayout;
  tool: EditTool;
  error?: string;
  dirty: boolean;
  onTool(t: EditTool): void;
  onChange(r: EditResult): void;
  onSave(): void;
  onCancel(): void;
}

export const TOOL_GROUPS: Array<{ label: string; tools: Array<[EditTool, string]> }> = [
  {
    label: 'Furniture',
    tools: [
      ['desk', 'Desk'],
      ['plant', 'Plant'],
      ['couch', 'Couch'],
      ['bookshelf', 'Shelf'],
      ['cooler', 'Cooler'],
      ['printer', 'Printer'],
      ['coffee', 'Coffee'],
      ['toilet', 'Restroom'],
      ['lamp', 'Lamp'],
      ['board', 'Task board'],
    ],
  },
  {
    label: 'Rooms & departments',
    tools: [
      ['table', 'Table'],
      ['chair', 'Meeting chair'],
      ['whiteboard', 'Whiteboard'],
      ['screen', 'Screen'],
      ['server', 'Server rack'],
      ['console', 'Console'],
      ['snack', 'Snacks'],
      ['reception', 'Reception'],
      ['noticeboard', 'Noticeboard'],
    ],
  },
  {
    label: 'Structure',
    tools: [
      ['wall', 'Wall'],
      ['unwall', 'Erase wall'],
      ['door', 'Door'],
      ['erase', 'Erase'],
    ],
  },
];

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange(v: number): void }) {
  return (
    <label className="ctl num-field">
      <span>{label}</span>
      <input type="number" value={value} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function LayoutEditor({ draft, tool, error, dirty, onTool, onChange, onSave, onCancel }: Props) {
  const desks = draft.items.filter((i) => i.type === 'desk').length;
  const rooms = draft.rooms ?? [];
  const zone = (z: Zone, patch: Partial<Zone>) => onChange(updateZone(draft, z.id, patch));
  const room = (r: Room, patch: Partial<Omit<Room, 'id'>>) => onChange(updateRoom(draft, r.id, patch));
  return (
    <section className="editor" aria-label="Layout editor">
      <h2>Edit layout</h2>
      <p className="muted small">
        Pick a tool and click a tile. Drag existing furniture to move it. Workers sit on the tile below (in front of) their desk. Walls block walking; leave a
        gap for a doorway.
      </p>
      {TOOL_GROUPS.map((g) => (
        <div key={g.label} className="tool-group">
          <h3 className="tool-group-title">{g.label}</h3>
          <div className="tool-grid" role="radiogroup" aria-label={`${g.label} tools`}>
            {g.tools.map(([t, label]) => (
              <button key={t} role="radio" aria-checked={tool === t} className={`btn ${tool === t ? 'active' : ''}`} onClick={() => onTool(t)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="editor-row">
        <label className="ctl">
          <span>Name</span>
          <input className="text" value={draft.name} maxLength={60} onChange={(e) => onChange({ ok: true, layout: { ...draft, name: e.target.value } })} />
        </label>
      </div>
      <div className="editor-row">
        <NumberField label="Columns" value={draft.cols} min={MIN_COLS} max={MAX_COLS} onChange={(v) => onChange(resizeLayout(draft, v, draft.rows))} />
        <NumberField label="Rows" value={draft.rows} min={MIN_ROWS} max={MAX_ROWS} onChange={(v) => onChange(resizeLayout(draft, draft.cols, v))} />
        <span className="muted small">
          {desks} desks · {(draft.walls ?? []).length} wall tiles
        </span>
      </div>

      <h3>Rooms</h3>
      <p className="muted small">
        Rooms give an area a floor, a label and a kind. Desks in a department room are preferred for agents your department rules map there (a local
        heuristic, not a Claude role). Rooms may not overlap.
      </p>
      {rooms.map((r) => (
        <div key={r.id} className="zone-edit room-edit" data-testid={`room-${r.id}`}>
          <div className="editor-row">
            <input className="text" aria-label="Room name" value={r.name} maxLength={40} onChange={(e) => room(r, { name: e.target.value })} />
            <select aria-label="Room kind" value={r.kind} onChange={(e) => room(r, { kind: e.target.value as RoomKind })}>
              {ROOM_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ROOM_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="editor-row">
            <NumberField label="x" value={r.x} min={0} max={draft.cols - 1} onChange={(v) => room(r, { x: v })} />
            <NumberField label="y" value={r.y} min={WALL_ROWS} max={draft.rows - 1} onChange={(v) => room(r, { y: v })} />
            <NumberField label="w" value={r.w} min={1} max={draft.cols} onChange={(v) => room(r, { w: v })} />
            <NumberField label="h" value={r.h} min={1} max={draft.rows} onChange={(v) => room(r, { h: v })} />
          </div>
          <div className="editor-row">
            <button className="btn small" title="Build walls around the room, leaving a doorway towards the office door" onClick={() => onChange(wallInRoom(draft, r.id))}>
              Wall in
            </button>
            <button className="btn danger small" onClick={() => onChange(removeRoom(draft, r.id))}>
              Remove
            </button>
          </div>
        </div>
      ))}
      <button className="btn small" onClick={() => onChange(addRoom(draft))}>
        Add room
      </button>

      <h3>Zones</h3>
      <p className="muted small">Desks inside a zone with a workspace match are preferred for sessions whose directory contains that text (e.g. <code>projects\my-app</code>).</p>
      {draft.zones.map((z) => (
        <div key={z.id} className="zone-edit">
          <div className="editor-row">
            <input className="text" aria-label="Zone name" value={z.name} maxLength={40} onChange={(e) => zone(z, { name: e.target.value })} />
            <input type="color" aria-label="Zone colour" value={z.color} onChange={(e) => zone(z, { color: e.target.value })} />
            <button className="btn danger small" onClick={() => onChange(removeZone(draft, z.id))}>
              Remove
            </button>
          </div>
          <div className="editor-row">
            <NumberField label="x" value={z.x} min={0} max={draft.cols - 1} onChange={(v) => zone(z, { x: v })} />
            <NumberField label="y" value={z.y} min={2} max={draft.rows - 1} onChange={(v) => zone(z, { y: v })} />
            <NumberField label="w" value={z.w} min={1} max={draft.cols} onChange={(v) => zone(z, { w: v })} />
            <NumberField label="h" value={z.h} min={1} max={draft.rows} onChange={(v) => zone(z, { h: v })} />
          </div>
          <input
            className="text wide"
            aria-label="Workspace match"
            placeholder="Workspace match (optional)"
            value={z.workspaceMatch ?? ''}
            onChange={(e) => zone(z, { workspaceMatch: e.target.value || undefined })}
          />
        </div>
      ))}
      <button className="btn small" onClick={() => onChange(addZone(draft))}>
        Add zone
      </button>

      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      <div className="editor-actions">
        <button className="btn primary" onClick={onSave} disabled={!dirty}>
          Save layout
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" onClick={() => onChange({ ok: true, layout: defaultLayout() })}>
          Reset to default
        </button>
        <button className="btn" title="The original single-room office (23×14)" onClick={() => onChange({ ok: true, layout: openOfficeLayout() })}>
          Small open office
        </button>
      </div>
    </section>
  );
}
