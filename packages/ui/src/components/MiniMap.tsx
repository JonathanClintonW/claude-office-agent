import type { MouseEvent } from 'react';
import { STATUS_META, WALL_ROWS, type AgentStatus, type OfficeLayout } from '@agent-office/core';
import { ROOM_KIND_LABELS } from '../departments';
import { ROOM_STYLE } from '../office/roomArt';

export interface MiniMapWorker {
  key: string;
  /** Tile coordinates (may be fractional while walking). */
  x: number;
  y: number;
  status: AgentStatus;
  selected: boolean;
}

interface Props {
  layout: OfficeLayout;
  workers: readonly MiniMapWorker[];
  /** Visible area in tiles. */
  view?: { x: number; y: number; w: number; h: number };
  /** Centre the office view on a tile. */
  onNavigate(x: number, y: number): void;
  width?: number;
}

/** Client coordinates → tile coordinates on a map drawn into `rect`. */
export function clientToTile(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, cols: number, rows: number): { x: number; y: number } {
  const fx = rect.width ? (clientX - rect.left) / rect.width : 0.5;
  const fy = rect.height ? (clientY - rect.top) / rect.height : 0.5;
  return { x: Math.min(Math.max(fx, 0), 1) * cols, y: Math.min(Math.max(fy, 0), 1) * rows };
}

/** Overview of rooms and workers; click to move the office view there. */
export function MiniMap({ layout, workers, view, onNavigate, width = 168 }: Props) {
  const { cols, rows } = layout;
  const height = Math.round((width * rows) / cols);
  const click = (e: MouseEvent<SVGSVGElement>) => {
    const p = clientToTile(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), cols, rows);
    onNavigate(p.x, p.y);
  };
  return (
    <div className="minimap" aria-label="Mini-map">
      <svg
        role="button"
        aria-label="Mini-map: click to move the view"
        data-testid="minimap"
        width={width}
        height={height}
        viewBox={`0 0 ${cols} ${rows}`}
        shapeRendering="crispEdges"
        onClick={click}
      >
        <rect x={0} y={0} width={cols} height={WALL_ROWS} fill="#6b4a33" />
        <rect x={0} y={WALL_ROWS} width={cols} height={rows - WALL_ROWS} fill="#7d5c40" />
        {(layout.rooms ?? []).map((r) => (
          <rect key={r.id} data-room={r.id} x={r.x} y={r.y} width={r.w} height={r.h} fill={ROOM_STYLE[r.kind].accent} fillOpacity={0.45}>
            <title>{`${r.name} (${ROOM_KIND_LABELS[r.kind]})`}</title>
          </rect>
        ))}
        {(layout.walls ?? []).map((w) => (
          <rect key={`${w.x},${w.y}`} x={w.x} y={w.y} width={1} height={1} fill="#2a1c14" />
        ))}
        {layout.items
          .filter((i) => i.type === 'desk')
          .map((d) => (
            <rect key={d.id} x={d.x + 0.2} y={d.y + 0.2} width={0.6} height={0.6} fill="#c8a27a" fillOpacity={0.8} />
          ))}
        <rect x={layout.door.x} y={rows - 1} width={1} height={1} fill="#ffd166" />
        {workers.map((w) => (
          <circle
            key={w.key}
            data-worker={w.key}
            cx={w.x + 0.5}
            cy={w.y + 0.5}
            r={w.selected ? 0.9 : 0.6}
            fill={STATUS_META[w.status].color}
            stroke={w.selected ? '#ffe066' : '#17141f'}
            strokeWidth={w.selected ? 0.35 : 0.2}
          />
        ))}
        {view ? (
          <rect
            data-testid="minimap-view"
            x={Math.max(0, view.x)}
            y={Math.max(0, view.y)}
            width={Math.max(0, Math.min(cols, view.x + view.w) - Math.max(0, view.x))}
            height={Math.max(0, Math.min(rows, view.y + view.h) - Math.max(0, view.y))}
            fill="none"
            stroke="#ffffff"
            strokeWidth={0.3}
          />
        ) : null}
      </svg>
    </div>
  );
}
