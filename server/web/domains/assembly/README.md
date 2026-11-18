# Assemblies

Status: **in progress, usable**. An assembly (`.jasm`) places parts of the project's part studios, and other
assemblies, as instances; mates tie them together; a solver keeps the mates while parts are dragged and while
the part studios change. A board of the project is placed like a part and follows the board editor.

**Read [../mechanical/CONTRACT.md](../mechanical/CONTRACT.md)** first: the item document format, how a change
is committed and synced, geometry names. This file covers what the assembly adds.

## Layout

```
document/format.ts     the .jasm format: instances, mates                                   (shared)
document/edits.ts      every edit as item changes; groups, explicit connectors, named positions
core/mate.ts           the mate contract        core/tool.ts   the toolbar contract         (shared)
core/transform.ts      3 × 4 placement matrices                                             (shared)
mates/                 ONE FILE PER MATE TYPE   (_residuals.ts: what they are made of)
tools/                 ONE FILE PER TOOLBAR TOOL
solver/                math.ts (poses), frames.ts (connector frames), linear.ts, solver.ts, types.ts
connectors/infer.ts    implicit mate connectors from a part's tessellation
model/problem.ts       document + geometry → the solver's input → what to tell a person about each mate
sources/               where an instance's geometry comes from: part.ts, subassembly.ts, board.ts,
                       manager.ts (the open source documents), kernels.ts (worker pool), cache.ts (IndexedDB)
services/, panels/     interference and the bill of materials: the logic (pure), and their panels
viewport/scene.ts      instances drawn from shared geometry, picking, connector glyphs     triad.ts  the manipulator
viewport/boards.ts     board instances as they look (the mechanical domain's BoardDisplay)
ui/assembly.ts         AssemblyEditor: the object every tool and panel is handed
ui/*.tsx               the frame, the instance tree, the mates list, the mate and Insert dialogs
generated/             written by scripts/gen-cad-registry.mjs; not committed
```

Tests: `static/tests/assembly-solver.test.js` (the solver and every mate, in node),
`assembly-model.test.js` (connectors from the real kernel, edits, an assembly following a rebuilt part),
`assembly-doc.test.js` (the format), `cad-analysis.test.js` (interference and the bill of materials),
`scripts/cad-assembly-ui.mjs` (the real app in Chromium, two people), `scripts/cad-analysis-ui.mjs` (the
panels) and `scripts/cad-e2e.mjs` (a board fastened in a tray, a hinged lid, a clash found).

## What a person can do

- **Insert** parts of any part studio of the project (one, several, the whole studio), other assemblies, and
  the project's boards.  A part studio is read and built without opening its tab, with its variables applied
  and the boards of its Board features supplied (mechanical `studioInputs`), so a studio that shows a board
  offers the board's bodies too.
- **Instance tree**: rename, hide, suppress, fix, group, copy in a row, replace, delete; each row says how many
  freedoms its mates leave it.
- **Drag** an instance in the viewport, or use the manipulator on the selected one (arrows slide, arcs turn, in
  round steps; Alt for free). Every step goes through the solver, so mates hold and limits stop the motion.
- **Mates**: Fastened, Revolute, Slider, Planar, Cylindrical, Pin slot, Ball, Parallel, Tangent. Pick a mate,
  then click a connector on each of two instances: connectors are inferred under the pointer (face centres,
  hole and shaft axes, circle centres, edge midpoints, corners). Offset, rotation, flip, a quarter turn, limits.
  A mate's value can be typed or animated in its dialog. Nothing is stored until Done.
- **Explicit mate connectors** (Connector tool): a connector kept on a part with its own offset, turn and flip.
- **Named positions**, an **exploded view** (a way of looking: not stored), undo and redo.
- **Interference** (exact overlap volumes between parts and boards, drawn on the model, the clashing instances
  marked; clearance between two) and the **bill of materials** (parts with quantities, and under each board
  its electronic parts; CSV), as docked panels.
- Two people can edit one assembly at once; an assembly open in one window follows a part studio or a board
  edited in another, live.

## For tools and panels (interference, bill of materials, …)

A tool is a file under `tools/` (`defineAssemblyTool`, `core/tool.ts`); its `run(assembly)` gets the
`AssemblyEditor`. There is no panel registry: a tool opens a panel with `assembly.showPanel(...)`.
`tools/interference.ts` and `tools/bom.ts` are the examples: `services/interference-sources.ts` is all they
need of the editor (no session, no worker of their own).

```ts
assembly.placed(): PlacedInstance[]
  // every instance that is not suppressed, as it stands on screen (solved; not exploded):
  //   item       the InstanceItem (id, name, source, fixed, hidden, group)
  //   transform  12 numbers, rows of a 3 × 4 matrix: the instance in assembly space
  //   status     "ready" | "loading" | "error"   (wait for "ready": subscribe and look again)
  //   pieces     [{ id, name, mesh: BodyMesh, transform }]   transform: the PIECE in assembly space
  // A part instance has one piece (the body); a sub-assembly instance has one per part inside it.
  // `mesh` is the mechanical domain's BodyMesh (positions, normals, indices, named faces/edges/vertices,
  // bbox in the mesh's own space).  The same mesh object is shared by every instance of the same part:
  // key work on it (a BVH, a volume) by the object, e.g. in a WeakMap.

assembly.getState()                 // instances, mates, groups, selection, instanceInfo[id].dof, mateInfo[id], dof, …
assembly.subscribe(fn)              // called after every change of state (document, sources, selection)
assembly.transformOf(instanceId)    // one solved placement

assembly.sources.handle(kind, docId)   // the open source document of an instance (kind = item.source.kind):
  .snapshot()                          //   { status, pieces, version }
  .kernel?.()                          //   the KernelClient whose worker holds that source's B-rep, or null
  .ensureKernel?.()                    //   the same, built first when no worker holds it: what an analysis tool awaits
  .doc?.()                             //   a part studio's ItemDoc (its materials, its names)
  .features?.()                        //   { features, rollback }: the source as worker input
  .board?.()                           //   a board source: its reader, and its changes as they arrive
// B-rep.  Each part studio has its own worker (one model per worker), so `kernel().call("mass-properties",
// { body: piece.id })` answers about ONE studio's bodies (piece.id is the body id for a part instance).
// A worker exists only while that studio was built in this session: after a reload the meshes come from the
// cache and kernel() is null until the studio changes; `await ensureKernel()` builds it in the pool when you
// need the B-rep.  A question that needs bodies of two sources in one kernel (exact interference) reads each
// source's bodies as BRep text ("body-brep") and sends them to one of those workers; mesh-level work needs none
// of this.

assembly.scene.setMarked(instanceIds)  // tint instances as a problem (clear with [])
assembly.select(ids)                   // select instances, mates, …
assembly.showPanel({ id, title, side: "right" | "left" | "bottom", render: (assembly) => <ReactNode> })   // "bottom": under the viewport, for a table
assembly.closePanel(id)
assembly.ask({ title, fields: [{ key, label, kind: "number" | "text", value, unit? }], accept(values) })
assembly.commit(changes)               // item changes (document/edits.ts builds them); undoable, shared
assembly.host                          // DocumentHostContext: project, docs, toast(), openDoc()
```

In a panel, read state with `useAssembly(assembly, (s) => s.instances)` (`ui/parts.tsx`).
`window.JunctionAssembly` is the open editor, for tests and the console.

## The document

`document/format.ts` has the instance and mate items. `document/edits.ts` adds, all optional and all ignored by
a reader that does not know them:

- `group` items and an instance's `group` key (a folder in the list);
- `connector` items (an explicit mate connector owned by an instance: `ref`, `flip`, `offset`, `rotation`) and a
  mate end's `connector` key naming one;
- `position` items (`transforms` by instance id).

A mate's `params` may carry, whatever its type: `offset` (mm along the connector's axis; also `offsetX/Y/Z`),
`rotation` (degrees about it), `reorient` (quarter turns of the second connector), `limits` with
`<value>Min` / `<value>Max` (`angle`, `distance`). `solver/frames.ts` applies them; a mate file does not.

**The document stores solved placements.** After a drag, a mate or a change of a part upstream, an editor
writes the instances' new transforms (the last case without an undo step). A viewer's window solves for itself
and shows the same thing.

## Mates and the solver

A mate file gives `solve: { residuals(a, b, params, reach, out), values?, rigid?, check? }`
(`solver/types.ts`). `mates/revolute.ts` is the example: eight lines of residuals from `_residuals.ts`.
The solver (`solver/solver.ts`, the header says how): welds Fastened parts into rigid groups, splits what is
left into independent components, and solves each by Levenberg–Marquardt on a skyline matrix ordered along
the mates. It reports each mate's residual and values, the freedoms each instance has left (the null space),
and, when the mates cannot all hold, which ones conflict (the later ones: they are added in order).

Measured in node on a loaded machine (`assembly-solver.test.js` prints them): a drag step of 100 separately
hinged lids about 2 ms; of one chain of 300 hinges about 40 ms; a full solve with freedoms of 100 hinges 6 ms.
The solver runs on the page's thread; it has not needed a worker.

## Sources

`source: { kind, docId, … }` on an instance; a kind is a `SourceProvider` (`sources/types.ts`) listed in
`sources/manager.ts`. A provider opens a source document and offers **pieces**: a mesh with stable names, an id
(what a mate's `ref.body` names) and a place.

- `part`: a body of a part studio. The handle joins the studio's session, so every edit arrives; it builds in
  a pooled worker (`kernels.ts`, three kept), or not at all when the cache has this content (`cache.ts`).
- `assembly`: another assembly, rigid. Its own stored placements are used; piece ids are
  `<its instance id>/<piece id>`. An assembly that contains itself is refused.
- `board`: a board of the project. The handle reads the board live (the mechanical domain's `BoardFeed`) and
  builds it in a pooled worker by the same code as a Board feature in a part studio: pieces `board:board` (the
  laminate) and `board:parts` (the parts' envelopes), with the names of
  [`../mechanical/board/README.md`](../mechanical/board/README.md) and `board` as the feature id:
  `board:front`, `board:back`, `board:edge:<uuid>`, `board:hole:H1`, `board:part:J1:top`. They do not change
  when the board is edited. The pieces are **ghosts** (`SourcePiece.ghost`): `viewport/boards.ts` draws the board
  as it looks at the instance's placement, a moved footprint at a time, and the solids are there for the
  pointer, the connectors and the interference check. The geometry is in the sheet's own coordinates (x right,
  y up, z from the back face), so Insert places a new board with its middle at the assembly's origin.
- A part studio that holds a Board feature is built with its board, so "Board 1" and "Board 1 parts" are
  offered among its parts, already where the studio puts them.

## Limits

- **STEP files** (`kind: "file"`) have no provider (import the file into a part studio and instance that).
- **A board** inserted before it has been read lands with the sheet's origin, not its middle, at the origin.
  Its part envelopes come from the footprints (courtyards), refined by the 3D models as they load.
- **Interference** does not look inside sub-assemblies yet.
- **Connectors come from the tessellation**, not the B-rep: planes, cylinders, circles, lines and points are
  recognised; a cone, a sphere or a spline face gives its middle and average normal. Tangent works for a plane
  with a cylinder and for two cylinders only.
- **Angles are in (−180°, 180°]**: a limit cannot span more than one turn, and there is no screw, gear, rack or
  linear relation between mates.
- **Copy in a row** makes plain instances: it is not a pattern that follows its seed.
- **The exploded view** is one slider from the middle; there are no stored explode steps.
- **Sub-assemblies are rigid**: their inner freedoms cannot be moved from outside.
- **Freedoms are not counted** for a single connected group of more than 80 moving instances (it still solves).
- **Replace** keeps the mates' names; a mate whose geometry the new part lacks says so and must be re-picked.
- **Versions**: `source.version` is carried and ignored; every instance follows its source live.
- **Presence** (who is dragging what) is not drawn. Two people dragging the same instance: the last drop wins.
- **Each part studio in use costs a worker** while it is being built or was built this session (three kept);
  a project with dozens of studios edited at once has not been profiled.
- The solver's result for under-held assemblies is "the nearest placement": after a part changes upstream, mate
  values are kept where possible (a lid open 45° stays at 45°), but a free part is otherwise left where it was.
