# Office layout, rooms, departments and camera

The office is a grid of 16 px tiles. Rows 0–1 are the back wall (windows, clock, task board);
the floor starts at row 2. Everything here is local and deterministic: rooms and departments are
layout semantics and your own rules, never a verified Claude role, and nothing calls a model.

## Layout model (`packages/core/src/layout.ts`)

```jsonc
{
  "version": 1,
  "name": "Department office",
  "cols": 44, "rows": 30,             // 10–48 × 8–32
  "door": { "x": 18 },                 // entrance on the bottom row
  "items": [{ "id": "desk-1", "type": "desk", "x": 2, "y": 3 }],
  "zones": [],                         // coloured rugs with an optional workspaceMatch
  "walls": [{ "x": 16, "y": 2 }],      // optional: interior wall tiles
  "rooms": [{ "id": "dev", "name": "Development", "kind": "development", "x": 0, "y": 2, "w": 16, "h": 9 }] // optional
}
```

- **Backward compatible.** `walls` and `rooms` are optional. A version-1 layout saved by an older
  version (items, zones, door only) validates to exactly the same object, without those keys, so
  `~/.agent-office/layout.json` files keep loading unchanged.
- **Walls** are single tiles. They block walking; a gap in a wall line is a doorway.
- **Rooms** are named rectangles with a kind from `ROOM_KINDS` (`office`, `development`, `qa`,
  `devops`, `security`, `research`, `collaboration`, `meeting`, `break`, `restroom`, `reception`,
  `corridor`). They set the floor finish, the label, the room info card and department desk
  preference. Zones keep working on top of rooms.

### Validation (`validateLayout`)

Strict, because layouts come from the UI and are written to disk by the monitor:

- bounds for size, door, items, zones, walls (≤ 1200) and rooms (≤ 40); integer coordinates;
- ids match `[A-Za-z0-9_-]{1,40}` and are unique; unknown fields are dropped; names are truncated;
- no two floor items on one tile, no item on a wall, no wall on the door tile;
- the tile below each desk (its chair) is free of furniture and walls and is not the door;
- rooms stay inside the floor and never overlap; room kinds must be known;
- **reachability:** when a layout has interior walls, every desk chair must be reachable on foot
  from the door. (Wall-less layouts are not checked, so older saved layouts never start failing.)

### Furniture

| Type | Notes |
| --- | --- |
| `desk` | The only agent seat. The worker sits on the tile below, facing the monitor, which always shows the real status. |
| `plant`, `cooler`, `bookshelf`, `couch`, `printer`, `lamp`, `toilet`, `coffee` | Original furniture. Restroom stalls (`toilet`) show red while an idle agent is inside. |
| `board` | Task board on the back wall (row 1). Click it for the task board. |
| `server` | Server rack with blinking LEDs (frozen with reduced motion). |
| `console` | Console desk with two monitors. Decorative feeds themed by room: CCTV in security, graphs in devops, dashboards elsewhere. Never agent status. |
| `whiteboard`, `screen` | Presenter spots for meetings and research. |
| `table`, `chair` | Adjacent table tiles join into one table; chairs turn to face an adjacent table and become room seats. |
| `snack` | Vending machine (a `snack` idle spot). |
| `reception` | Reception counter; adjacent pieces join, the middle piece has a bell. |
| `noticeboard` | Standing pinboard (a `board` idle spot). |

## Default office (44 × 30)

`defaultLayout()` builds the default office from an ASCII plan (`layoutFromMap`). The original
23 × 14 open office is still available as `openOfficeLayout()` (**Small open office** in the editor).

```
   x: 0         1         2         3         4
      01234567890123456789012345678901234567890123
y 2   P............R.P#P.........#P......S#VVVVVVP   Development | QA & Testing | Research | DevOps · Servers
y 3   ..DD..DD..DD...C#.DD..DD..O#.DD..DD.#.......
y 6   ..DD..DD..DD...S#.DD..DD...#.DD..W..#.......
y 9   ..DD..DD..DD...P#R.........#........#.......
y10   P...............#.........P#SSS..SSS#......P
y11   ########..##########..#########..#######..##   doorways into the corridor
y12   P...........O....................O.........P   Corridor
y14   ####..#####P............P##.############..##
y15   ZZ.......P#......W....DD.#P...Y...P#.KNC...P   Security | Collaboration | Meeting room | Break room
y18   ..........#.hXXXh.hXXXh..#.hXXXXXh.#.....hh.
y22   ###########P............P################.##
y23   .T.T.#OP....................PO#P.W.........P   Restrooms | Reception | Huddle room
y25   .....#..............QQQ.......#...hXXXh.....
y29   P...P#P...........@..........P#P...........P   @ = main door
```

Legend: `#` wall, `D` desk, `P` plant, `C` cooler, `S` bookshelf, `U` couch, `R` printer, `L` lamp,
`T` restroom stall, `K` coffee, `V` server rack, `W` whiteboard, `Y` presentation screen, `X` table,
`h` meeting chair, `N` snack machine, `Q` reception, `O` noticeboard, `Z` console.

42 desks: development 18, QA 8, research 6, devops 4, security 4, collaboration 2. Tests check that
every desk chair, room and furniture item is reachable from the door with A*.

## Departments (`packages/ui/src/departments.ts`)

`departmentFor(agent, settings.departmentRules)` returns the department of the first rule whose
pattern is a case-insensitive substring of the rule's field. Fields are real, observed values:
`agentType` (subagent type), `cwd` (`/` and `\` match alike) or `name` (display name). Unmatched
agents go to **development**. Edit the rules under **Settings → Departments** (add, edit, reorder,
remove, reset, and a "try it" box). This is a local seating heuristic, and the UI says so.

### Desk assignment (`assignDesks` in `office/grid.ts`)

Existing assignments are kept. A new agent prefers, in order:

1. a desk in a room of its department (if that room is full: desks outside department rooms
   first, then desks in other departments' rooms, nearest to the full department first);
2. a desk in a zone whose `workspaceMatch` fits its `cwd` (sessions without a match avoid other
   workspaces' zones);
3. the free desk nearest its parent (subagents and teammates);
4. the first free desk; otherwise it waits in the lounge (reception, break room, corridor,
   collaboration or outside any room).

Layouts without rooms simply skip the department step. When an agent's department changes (rules edited,
or its type became known), the scene frees its desk and seats it again.

## Behavior world (`office/world.ts`)

`buildWorld(layout, windowXs, night)` is pure and only uses tiles reachable from the door:

- **spots:** `coffee`, `water` (cooler), `snack`, `toilet`, `couch`, `window`, `books` (bookshelf),
  `board` (noticeboard or task board), `whiteboard`, `plant`. Each has an access tile, a face
  towards the furniture and the `roomId` it is in.
- **chatTiles:** pairs of free tiles, never on desk seats, spots or walls.
- **rooms:** one `RoomInfo` per layout room. `seats` are meeting chairs next to a table (facing
  it); meeting and collaboration rooms with tables but no chairs get standing seats around the
  tables. `capacity = seats.length`. `presenter` stands in front of the room's screen (preferred)
  or whiteboard, facing the audience.

Default office: meeting room 12 seats, huddle room 8, collaboration 16, break room 4.

## Rendering (`office/scene.ts`, `office/roomArt.ts`)

- The whole floor is one texture: room finishes (carpet, vinyl, raised floor, checker tiles,
  small tiles, marble) and the classic wood elsewhere.
- Interior walls are blocks drawn in the furniture layer, so they hide workers standing behind them.
- Room labels follow **Settings → Room labels**.
- **QA build lamps** sit on QA desk monitors. They show the seated agent's most recent real tool
  result: amber while a tool runs, then green (succeeded) or red (failed); off when nothing was
  observed. Research desks get a book stack. All department dressing is decoration; the main
  monitor always shows the real status.
- **Reduce motion:** no particles, no bubble bobbing, no blinking or flashing (screens, lamps and
  LEDs hold one frame, the selection ring stops pulsing), and the camera jumps instead of gliding.
  **Animation FPS** caps the renderer's frame rate.

## Camera

The canvas fills the office pane; the camera moves the office inside it.

| Action | How |
| --- | --- |
| Zoom | Mouse wheel (around the pointer), **+ / −** buttons, `+` / `-` keys |
| Fit the whole office | **Fit** button or `0` |
| Pan | Drag empty floor or the margin; arrow keys. In edit mode: right/middle-drag, margins or keys |
| Navigate | Click the mini-map (**Settings → Mini-map**) |
| Room info | Click a room's floor: name, kind, desks in use and who is in it right now |

Zoom steps are 0.5×, 0.75×, then whole steps 1×–2× and half steps above (2.5×, 3×, 3.5×, 4×, 5×,
6×, 8×), so art pixels stay square. **Fit** picks the largest zoom that shows the whole office (quarter steps below 2×,
half steps above), so the first view fills the pane. The camera stays clamped to the
office. Selecting an agent who is off screen (for example from the agent list) pans to them.

### Focusing from other views

```tsx
const office = useRef<OfficeViewHandle>(null);
<OfficeView ref={office} … />           // office.current?.focus(agentKey), fit(), zoomIn(), zoomOut()
<OfficeView focusRequest={{ key, seq }} … />  // focuses again whenever seq changes
```

`OfficeScene.focus(agentKey)` centres the camera on the worker (at least 2× zoom) and returns
false if that agent is not in the office.

## Editing (`layoutEdit.ts`, `components/LayoutEditor.tsx`)

- **Furniture** and **Rooms & departments** tools place items; drag an item to move it.
- **Wall** / **Erase wall** place and remove wall tiles; **Erase** removes furniture, then walls.
- **Rooms:** add (first free, wall-free rectangle), name, kind, bounds, **Wall in** (walls on the ring
  around the room, leaving a doorway towards the office door) and remove.
- Every edit goes through `validateLayout`; errors appear in the editor.
- **Reset to default** loads the department office; **Small open office** loads the original.

## Behavior providers

`OfficeScene.runBehaviors` is the single place where simulated behavior reaches workers. It
builds actors from real status (plus an `ActorContext` with kind, session, parent, status,
finish time and home room), asks providers in priority order (an actor claimed by one provider
is offered to the next ones with `idle: false`), and applies the winning directive. The order is: interactions for verified team events
(`TeamworkProvider`), simulated meetings (`MeetingScheduler`), then idle life (`IdleDirector`);
see [COLLABORATION.md](COLLABORATION.md). Add more with `scene.addBehaviorProvider(provider, first)`. `World` is pushed to every
provider whenever the layout or the time of day changes.
