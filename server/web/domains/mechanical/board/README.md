# The board in CAD

A board of the project (`.kicad_pcb`) inside a part studio, as real geometry that follows the board while it is
edited. This folder is the PCB → CAD direction. The other direction (CAD geometry driving the board's outline,
holes and keep-outs) is `mechanical/boardlink/`. A board that is both shown and driven has **one placement**,
this folder's: the link names the Board feature and takes its frame (CONTRACT.md "Boards").

## The pieces

| File | Where it runs | What |
|---|---|---|
| `../../pcb/exports/board-geometry.ts`, `board3d.ts` | page, worker, node | The electronics domain's documented exports: the board document, its outline, holes, parts, and the 3D viewer's meshes. Nothing else of `pcb/` is imported. |
| `source.ts` `BoardSource` | page | Joins the board on the collaboration socket, read-only: the stored file, then every op as it is made. |
| `model.ts` `BoardReader` | page, node | The board read item by item into outline pieces, holes and parts, with stable names. `update(ids)` costs the changed items. `snapshot()` is the board as plain JSON. |
| `snapshot.ts` | everywhere | The snapshot's types. No imports from the page or from `pcb/`. |
| `display.ts` `BoardDisplay` | page | The board as it looks, in the viewport: laminate, face images, a mesh per part. |
| `brep.ts` `buildBoard` | worker | The snapshot as named solids. |
| `placement.ts` | page, worker | The board's frame on a plane. |
| `link.ts` `BoardLink` | page | One per open part studio: sources, displays, the worker's input, the debounce. |
| `feed.ts` `BoardFeed` | page, node | The same input for everything that builds a part studio outside its own page (an assembly, Compare, the assistant, the board editor's enclosure): an input filter that supplies `$board`. |
| `ShownBoards.tsx` | page | The first part of the Board panel: the boards this studio shows. |
| `../features/board-reference.ts` | page, worker | The **Board** feature. |
| `../features/board-cutout.ts`, `board-standoffs.ts` | page, worker | **Opening** and **Standoffs**: features that hang off a board's faces. |
| `../services/board-placement.ts` | worker | Where the worker put each board (for a board on a face of the model). |
| `../panels/boardlink.tsx` | page | The Board panel (with `../boardlink/Panel.tsx`); importing `link.ts` through it is what starts the link. |
| `../../pcb/editor/cad-usage.ts` | board editor | "Used in Part Studio 1": from a board to the CAD documents that use it. |

## How a board edit reaches the model

```
board editor ──op──▶ server ──op──▶ BoardSource (page of the part studio)
                                      │ applyBoardChanges: the editor's own code, on this page's copy of the board
                                      ▼
                                    BoardReader.update(changed ids) ─▶ BoardDelta { components, outline, holes, artwork }
                                      │
              at once                 ├─▶ BoardDisplay.update: one mesh per changed footprint
              320 ms after the last   ├─▶ laminate retriangulated (only if outline or a drill changed), face images recomposed
              260 ms after the last   └─▶ BoardLink: snapshot() again; if its JSON differs from what the worker has,
                                           studio.scheduleRegen() → the Board feature and everything after it rebuild
```

- The board is **not stored** in the part studio. `BoardLink` adds it to the worker's input as the transient
  parameter `$board` (`studio.inputFilters`); the document holds only the feature's own parameters.
- An edit that does not change the snapshot (a track, a part lower than "Parts from", a drill narrower than
  "Holes from") updates the display and regenerates nothing.
- The board editor sends a dragged footprint's place every 150 ms; both waits are longer than that, so a drag
  moves the part in the display as it goes and regenerates once, when it ends.
- Until the board has been read, the Board feature fails with "The board has not been read yet", and features
  built on it fail with it; they rebuild as soon as it arrives.

## The board's frame

A snapshot is in the board's own frame: millimetres, **x to the right and y up as the board editor shows the
board's front**, z from the back face (0) to the front face (`thickness`). Its origin is the point `origin` of
the board document (`[x, y]` in the editor's millimetres, y down there). The Board feature stores that point in
its parameters the first time it reads the board (the middle of the outline, rounded to 0.1 mm) and keeps it: the
board does not shift in the part studio when its outline grows on one side.

`placement.ts boardFrame(plane, { x, y, z, angle, flip }, thickness)` puts that frame on a sketch plane: the back
face on the plane, lifted by `z`, turned by `angle` about the normal; `flip` turns the board over about its own
x axis so the front face lies on the plane.

## Names

The Board feature makes two **reference bodies** (`Body.reference`: `ctx.bodies()` leaves them out, so Extrude's
"every body" does not fuse with the board or cut it; `ctx.body(id)` and `ctx.resolve(ref)` still find them).
`<f>` is the feature's id.

| Geometry | Body | Face name |
|---|---|---|
| Front and back face of the laminate | `<f>:board` | `<f>:front`, `<f>:back` (a second separate outline: `<f>:front:2`, …) |
| A piece of the outline or of a cut-out | `<f>:board` | `<f>:edge:<uuid of the Edge.Cuts graphic>`; a rectangle's or polygon's sides are `…:<uuid>:0`, `:1`, … |
| The wall of a round hole | `<f>:board` | `<f>:hole:<hole>` |
| The four walls of a slot | `<f>:board` | `<f>:hole:<hole>:a` … `:d` |
| A part's envelope (a box, or a cylinder for a round part) | `<f>:parts` | `<f>:part:<part>:base` (on the board), `:top`, and the sides `:x+`, `:x-`, `:y+`, `:y-`, or `:side` for a cylinder |

- `<part>` is the **reference designator** (`J1`). Parts that share one (two unannotated `R?`) are
  `<ref>~<first 8 characters of the footprint's uuid>`.
- `<hole>` is `<part>:<pad number>` (`J3:2`), just `<part>` for a footprint with one drilled pad (`H1`), and
  `<part>:@<pad index>` when the pad number is empty or not unique in the footprint.
- A part's sides are named in the **footprint's own axes** (y down, as KiCad draws a footprint), so `J1:y+` is
  the same side of the connector whatever its rotation and wherever it is moved.
- Edges and vertices are named from the faces, as everywhere (CONTRACT.md, "Geometry names").

What survives: moving and rotating footprints, moving outline graphics, adding and removing anything else.
What does not: re-annotating (`J1` becomes `J2`: the reference is lost, as it should be, and the feature says
so), deleting and redrawing an outline graphic (new uuid), a part that gets a 3D model after having none (its
envelope changes size, its names stay).

## For the other direction (`mechanical/boardlink`) and for assemblies

Read a board through `BoardSource` (or share the one an open studio has: `boardLinkOf(studio).reader(docId)`).
A `BoardReader` gives, in board document coordinates (mm, y down):

```ts
reader.edges()        // EdgeSegment[]: every Edge.Cuts line, arc and circle with the uuid of its graphic
reader.components()   // BoardComponent[]: id (uuid), ref, value, lib, side, x, y, rot,
                      //   body (the 3D viewer's part: outline, solids, models), height, box (envelope in the
                      //   footprint's frame), courtyard [x0, y0, x1, y1], holes (PadHole[]: pad, x, y, w, h, plated)
reader.envelope(c)    // the envelope and height actually used: measured from the 3D model when it has loaded
reader.ruleAreas()    // keep-outs: id, name, layers, pts, what they keep out
reader.thickness      // from the board's (general (thickness …)); the stackup itself is not read
reader.partNames()    // uuid → the name used in geometry names
reader.snapshot({ origin, minHole, minHeight })   // all of it in the board's frame, as JSON (snapshot.ts)
chainOutline(reader.edges())                      // closed loops with their cut-outs, pieces kept
toFootprint(c, p) / fromFootprint(c, p)           // board point ↔ a footprint's own frame
```

Mounting holes are the holes of footprints whose `component.body` is null and that have one NPTH pad; there is
no flag for them, the names (`H1`) carry it.

**An assembly that instances a board** (`source: { kind: "board", docId }`, `assembly/sources/board.ts`) builds
it as a part studio of one Board feature with id `board` (so the names are the ones above with `board` for
`<f>`), from a `BoardFeed`, and draws a `BoardDisplay` per instance (`assembly/viewport/boards.ts`:
`display.update(reader, [0, 0], delta)` as changes arrive, `display.setFrame(frame)` for the instance's
transform). A mate connector on a board uses the names above (`board:hole:H1` for a fastener, `board:back` for
the seat).

**Building a part studio outside its page** (an assembly, Compare, the assistant, the board editor's
enclosure): the Board feature needs `$board` in its parameters. `BoardFeed.filter` supplies it:
`studioInputs(doc, { filters: [feed.filter] })` (CONTRACT.md "Building a part studio outside its page").
Without it the feature fails with "has not been read yet" and so do the features built on it.

## Performance, measured

`scripts/cad-board-ui.mjs` (two browsers, one dragging a connector in the board editor, the other watching the
part studio) and `node static/tests/mechanical-board.test.js` print these. The figures are ranges over several
runs on a shared machine that was busy with other builds and has no GPU (WebGL and the 2D canvas in software),
so read them as upper bounds.

| Step | Demo board (69 footprints, 163 vias) | Synthetic board (320 footprints) | When |
|---|---|---|---|
| Apply one footprint move to this page's copy of the board | 0.6 to 1.0 ms | 0.2 to 0.3 ms | per op |
| Read the changed footprint again | 0.2 to 0.3 ms | 0.1 ms | per op |
| **Display updated after the op arrived** (one part mesh) | 1 to 13 ms | median 0.5 to 5 ms, worst 2.5 to 77 ms | per op |
| Laminate retriangulated | 30 to 430 ms | 200 to 600 ms | 320 ms after the edits stop, only if the outline or a drill changed |
| One face image recomposed | 110 to 590 ms | 250 to 1300 ms (at the earlier 6 Mpx; now 4 Mpx) | 480 ms after the edits stop, only the face that changed |
| Worker: Board, then wall and Opening | 200 to 1000 ms | 200 to 480 ms | 260 ms after the edits stop, only if the snapshot changed |

The cost of a moved footprint in the first three rows does not depend on the size of the board: the reader looks
at one item and the display rebuilds one mesh. The steps that grow with the board run after the edits stop, and
the worker's share is off the page's thread. End to end, from the mouse button going up in one browser to the
part having moved in the other, the script saw 1.5 to 2.6 s on that machine, which is mostly the two software
renderers and the server sharing its cores; it is not a number to quote.

## Limits

- **Picking a face behind your own bodies.** The envelopes are picked through the display model, but a wall in
  front of a connector hides its face from the pointer. Add the Opening before the wall, or roll back above the
  wall to pick. There is no hide or section view yet.
- **Envelopes are boxes** (or cylinders): from the part's 3D model's extent when the model has loaded, else from
  the courtyard or fabrication outline, else from the pads. A connector that overhangs the board edge is right
  only with its model.
- **Vias are not in the solid**, and drills below "Holes from" (1.5 mm by default) are left out; all are in the
  display model. A hole that breaks the board edge or another hole is left out of the solid, with a note.
- **Thickness** is the board's `(general (thickness …))`. Copper and mask are images on the faces, not solids.
- **Opening** is a rectangle around the picked face's extent; no rounded corners, no profile from the connector.
- **Standoffs** need round holes and a board body (they look for its back face).
- **The stored `.jpart` cannot be rebuilt on its own**: the board comes from the live board document. A board
  that is deleted from the project leaves the feature failing, with its last parameters.
- **One reader per page and board**; a part's measured envelope is shared by every Board feature of that board.
- The part studio joins the board's collaboration session to watch it. It sends no presence, so the board
  editor's people list does not show it (seen in `scripts/cad-board-ui.mjs`).
