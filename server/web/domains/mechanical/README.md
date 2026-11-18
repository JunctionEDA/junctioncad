# Mechanical CAD

Status: **in progress, usable**. The part studio: a parametric modeller in the browser, on OpenCascade
compiled to WebAssembly, with the history tree synchronized item by item like every other document.

**Read [CONTRACT.md](CONTRACT.md) before adding anything.** It is the one entry point: the document formats,
the feature, tool, panel and service registries (one file each, found by folder, no shared index to edit), the
worker protocol, the geometry naming scheme and its limits, how changes are committed and synced, how a part
studio is built outside its own page, how to run and test, and the limits in one place. The board in a part
studio and the part studio driving a board have READMEs of their own ([board/](board/README.md),
[boardlink/](boardlink/README.md)).

**What works.** A project holds part studios (`.jpart`) beside its schematic and board, as tabs. In a part
studio:

- a sketcher with a constraint solver: lines, rectangles, circles, arcs, slots; trim, extend, fillet, offset,
  mirror; constraints and driving dimensions with expressions; edges of the model used in a sketch;
- solid features: extrude, revolve, sweep, loft, fillet, chamfer, draft, shell, hole, boolean, split, transform,
  delete body; linear and circular patterns and mirror; reference planes, axes, points, a helix; variables;
- a feature list with edit, rename, suppress, reorder, delete, a rollback bar and an error state per feature;
  regeneration in a worker that rebuilds only from the first changed feature;
- a board of the project in the model, following the board editor live, with openings and standoffs that hang
  off it; and the other way: the model driving the board's outline, mounting holes and keep-outs;
- measure, section view, mass properties with materials, appearance and display modes;
- STEP and BREP import; STEP, STL, 3MF, OBJ, GLB, DXF and SVG export;
- live co-editing with presence, Follow and comments pinned to geometry; undo;
- version history, Compare, branches and merging, thumbnails, and tools for an AI assistant.

**What does not, yet.** CONTRACT.md lists the limits in one place.

**Layout.**

```
core/        the contracts: feature.ts, tool.ts, geometry.ts
document/    the .jpart format, every edit as item changes, variables, materials; inputs.ts (a document as worker input)
sketch/      the sketcher: format, solver, tools, dimensions, regions
kernel/      worker side: OpenCascade helpers (ops/), regeneration, tessellation, the protocol, the page's client
features/    one file per feature type
tools/       one file per toolbar tool
panels/      one file per docked panel
services/    one file per worker service
viewport/    bodies, planes, sketches, reference geometry, highlighting and picking, on shared/viewport3d
ui/          the part studio controller and its React frame: toolbar, docks, feature dialog
collab/      presence, Follow, two people in one feature, comments
inspect/     measure, section, mass properties, appearance
board/       a board of the project in a part studio (README.md)
boardlink/   a part studio driving a board (README.md)
history/ compare/ mcp/ thumbnail.ts   the part studio's side of the platform's history, Compare, assistant tools, thumbnails
api.ts       what other domains may import
index.tsx    the bundle's entry (static/dist/mechanical.js); kernel/worker.ts is static/dist/cad-worker.js
generated/   written by scripts/gen-cad-registry.mjs; not committed
```

**Kernel.** npm `replicad-opencascadejs` (OpenCascade, LGPL-2.1 with the Open CASCADE exception): bindings
only. The 23 MB `.wasm` is fetched the first time a part studio regenerates, compiled once per page and
shared by its workers.

**What it gets from the platform.** Projects, sharing and roles, the collaboration socket, storage, version
history, branches, comments, thumbnails and the AI (MCP) connection come from `server/web/platform`,
`server/web/shared` and the server, through `shared/itemdoc` (CONTRACT.md says exactly how).
Its entry in [`../registry.ts`](../registry.ts) says which files it opens.

See [docs/ROADMAP.md](../../../../docs/ROADMAP.md) for the order things are built in.
