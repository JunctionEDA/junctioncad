# Mechanical CAD: the contract

This is the document to read before adding anything to the mechanical or assembly domains. It says what the
formats and interfaces are, how to add a feature, a tool, a panel, a worker service or a mate without editing a
shared file, how the pieces built by different people fit together, and where each piece of future work belongs.

It is the one entry point. The parts with a README of their own are linked from here and not repeated:

| Part | README |
|---|---|
| Assemblies: instances, mates, the solver, sources | [`../assembly/README.md`](../assembly/README.md) |
| A board shown in a part studio (PCB → CAD) | [`board/README.md`](board/README.md) |
| A part studio driving a board (CAD → PCB), the part studio's half | [`boardlink/README.md`](boardlink/README.md) |
| … and the board editor's half | [`../pcb/mech/README.md`](../pcb/mech/README.md) |

Everything here is implemented and tested unless a line says otherwise. The limits are listed at the end; read
them before promising something to a user.

## The picture

```
project (Postgres: documents, snapshots, ops)
 ├─ *.kicad_sch, *.kicad_pcb      drawn by the electronics editor (web/domains/pcb)
 ├─ *.jpart   part studio         drawn by web/domains/mechanical   (static/dist/mechanical.js)
 ├─ *.jasm    assembly            drawn by web/domains/assembly     (static/dist/assembly.js)
 └─ models/*.step                 files an Import feature reads

page                                             worker (static/dist/cad-worker.js)
 document tabs (web/platform/doctabs)             OpenCascade (occ-kernel.wasm; compiled once per page,
 └─ PartStudio (ui/studio.ts)                       handed to every worker)
     ├─ ItemDocSession  ⇄ /ws ⇄ server             RegenEngine (kernel/regen.ts)
     ├─ KernelClient    ⇄ postMessage ⇄             ├─ features/*.ts  evaluate()
     ├─ ModelView on Viewport3D (three.js)          └─ services/*.ts  run()
     ├─ SketchEditor (sketch/editor.ts, PlaneGCS)
     └─ React: toolbar (by mode), docks, the feature's or sketch's dialog, view cube, status bar
```

A part studio is a list of features. The page holds the document and sends the feature list to the worker; the
worker runs each feature's `evaluate` in order on the kernel and sends back triangles, edge lines and names; the
page draws them. The page never touches the kernel and the worker never touches the document.

Three things cross between documents, and each has one place:

```
board (.kicad_pcb) ──read live──▶ Board feature in a part studio      board/        (BoardLink on the page, BoardFeed elsewhere)
part studio ──link item, solved──▶ the board's outline, holes, keep-outs   boardlink/ + pcb/mech/
part studio, board, assembly ──read live──▶ instances of an assembly   assembly/sources/
```

## Where things are

| Path (under `server/web/`) | What |
|---|---|
| `shared/itemdoc/itemdoc.ts` | JSON item documents: file format, item changes, order keys. Pure. |
| `shared/itemdoc/sync.ts` | `ItemDocSession`: a live document over the collaboration socket, with undo. |
| `shared/viewport3d/viewport3d.ts` | `Viewport3D`: canvas, camera, orbit/pan/zoom, standard views, theme colours. |
| `platform/documents/host.ts` | How the shell hands a document to a domain's editor. |
| `platform/doctabs/`, `platform/projecthome/` | The project shell: the tab bar, the Home tab, what a PCB is (`pcbs.ts`); `room.ts` is who is on which tab. See "Document tabs and the shell". |
| `platform/history/`, `platform/review/renderers.ts`, `platform/mcp/host.ts` | Version history, Compare, the assistant's tools: what a domain plugs into. |
| `domains/registry.ts` | Which document kinds exist, which bundle opens them, what a new one contains. |
| `domains/mechanical/core/` | Contracts: `feature.ts`, `tool.ts`, `geometry.ts`. |
| `domains/mechanical/document/` | The `.jpart` format (`format.ts`), every edit as item changes (`edits.ts`), the document's units (`units.ts`), variables, materials, appearance, and **`inputs.ts`: a document as the worker's input**. |
| `domains/mechanical/sketch/` | The sketcher: format, the solver (PlaneGCS), tools, dimensions, painting, regions. |
| `domains/mechanical/kernel/` | Worker side: OpenCascade helpers (`occ.ts`, `ops/`), regeneration, tessellation, protocol, the page's client. |
| `domains/mechanical/features/` | **One file per feature type.** |
| `domains/mechanical/tools/` | **One file per toolbar tool.** |
| `domains/mechanical/panels/` | **One file per docked panel.** |
| `domains/mechanical/services/` | **One file per worker service.** |
| `domains/mechanical/viewport/` | Bodies, the default planes and their name labels (`planes.ts`), sketches, reference geometry, highlighting, picking and box selection. |
| `domains/mechanical/ui/` | The part studio controller (`studio.ts`) and its React frame: the toolbar and everything that can be started (`commands.ts`), the dialogs (`DialogShell`, `FeatureDialog`, `SketchDialog`; `fields.ts` is what a click means to a field), the feature list, the view cube, the status bar, the tool search and menus (`Overlays.tsx`), the docks (`panels.ts`), a person's preferences (`prefs.ts`). |
| `domains/mechanical/collab/` | Presence, Follow, two people in one feature, comments pinned to geometry. |
| `domains/mechanical/inspect/` | Measure, section view, mass properties, appearance and display modes. |
| `domains/mechanical/board/` | A board in a part studio: reading it live, its picture, its solids, `BoardFeed`. |
| `domains/mechanical/boardlink/` | The link item with which a part studio drives a board. |
| `domains/mechanical/history/`, `compare/`, `mcp/`, `thumbnail.ts` | The part studio's side of the platform's history, Compare, assistant tools and thumbnails. |
| `domains/mechanical/api.ts` | What other domains may import from this one. |
| `domains/assembly/` | The assembly editor: see its README. |
| `domains/pcb/mech/` | The board editor's side of the board link. |
| `domains/pcb/exports/` | What the electronics domain offers the others (the board as geometry, as 3D pieces). |

Server: `server/src/itemdoc.rs` (the document types and the fold), `dockind.rs` (how each document type behaves
for history, merging, folding and thumbnails), `itemmerge.rs` (the three-way merge), `http.rs` (`doc_type_for`,
`allowed_file`, `doc_is_movable`, and `notify_docs`: the notice that a project's documents changed),
`compact.rs`, `pcm.rs` (serves the `.wasm`), `pages.rs` and `main.rs` (serve the bundles), `mcp.rs` (the
assistant's tool catalogue).

## Adding things without colliding

Features, tools, panels, services and mates are **found by folder**. `scripts/gen-cad-registry.mjs` lists the
files of `features/`, `tools/`, `panels/`, `services/` (mechanical) and `mates/`, `tools/` (assembly) and writes
`generated/page.ts` and `generated/worker.ts`, which are not committed. `npm run check`, `npm run build` and the
tests run it first. So:

- **Add a file with a default export. Do not edit an index, a toolbar or a list.**
- A file whose name starts with `_` or ends in `.test.ts` is skipped: use `_helpers.ts` for code shared by a few
  files of one folder.
- After adding a file, run `npm run gen:cad` (or `npm run check`) so the type-checker sees it.

### Which folder for which piece of work

| Work | Put new files in | Registers through |
|---|---|---|
| A sketch tool, a constraint, a new entity kind | `mechanical/sketch/`, `mechanical/tools/sketch-*.ts` | tools (group `sketch`); the sketch format below |
| A feature | `mechanical/features/<type>.ts`; shared kernel code in `mechanical/kernel/ops/` | features (`toolbarSection`, `toolbarMenu`) |
| Something that lives as long as a studio is open (a link to another document, a presence layer) | a file a panel or tool imports, pushing onto `studioExtensions` (`ui/studio.ts`) | studio extensions |
| Data a feature needs that is not in the document | an input filter (`studio.inputFilters`), and the same data outside the page (see "Building a part studio outside its page") | `document/inputs.ts` |
| A measurement, a check, an export | `mechanical/services/`, `mechanical/tools/`, `mechanical/panels/` | services, tools, panels |
| A mate, an assembly tool, a kind of instance source | `assembly/mates/`, `assembly/tools/`, `assembly/sources/` | mates, assembly tools, the provider list in `sources/manager.ts` |
| New data in a `.jpart` (as variables, materials, appearance and board links are) | new item types (see "Unknown items"), in a new file under `mechanical/document/` or the folder that owns them | — |

### Shared files: do not edit without need

A change to one of these touches everybody. If you must change one, make the change additive (a new optional
field, a new method) and say so in your pull request.

- `shared/itemdoc/itemdoc.ts`, `shared/itemdoc/sync.ts` and their mirror `server/src/itemdoc.rs`
- `shared/viewport3d/viewport3d.ts`
- `platform/documents/host.ts`, `platform/doctabs/*`, `domains/registry.ts`
- `mechanical/core/*`, `mechanical/kernel/{types,protocol,regen,occ,tessellate,worker,client,load,wasm}.ts`
- `mechanical/document/{format,edits,inputs}.ts`, `mechanical/sketch/{format,profiles,planar}.ts`
- `mechanical/ui/{studio.ts,PartStudioView.tsx,Toolbar.tsx,commands.ts,fields.ts,DialogShell.tsx,panels.ts,FeatureDialog.tsx,FeatureList.tsx}`,
  `mechanical/viewport/{modelview,planes}.ts`, `mechanical/document/units.ts`, `mechanical/api.ts`
- `assembly/core/*`, `assembly/document/format.ts`, `assembly/sources/types.ts`, `assembly/ui/assembly.ts`
- `scripts/gen-cad-registry.mjs`, `server/package.json` (the `build:cad` and `test` entries), `static/app.html`
- `web/domains/pcb/editor/{dochost,doc,home}.ts` (the shell's side of the tabs)

Likely needs, and where they go instead of an edit:

- *A new dialog field kind*: add a member to `ParamField` in `core/feature.ts` and a `case` in
  `ui/FeatureDialog.tsx`. Additive; coordinate if two people need one at once.
- *A new kernel helper*: a new file under `kernel/ops/`, taking the `Kernel` as an argument. Do not grow `occ.ts`.
- *A new pick kind in the viewport*: additive member of `Pick` in `viewport/modelview.ts`.
- *A feature that needs its own editor* (as Sketch has `openSketch` / `finishSketch`): tools in `tools/` drive
  it; if `studio.ts` lacks a method you need, add one rather than special-casing the feature inside existing ones.
- *A global for tests and the console*: `window.Junction<YourThing>`, a name nobody else has. Two slices once
  both took `JunctionBoardLink`; the page is one page for every tab. In use: `JunctionPartStudio`,
  `JunctionSketch`, `JunctionCadCollab`, `JunctionBoardLink` (a studio's boards), `JunctionBoardMech` (the board
  editor's link side), `JunctionAssembly`, `JunctionRoom`.

## Documents

### JSON item documents (`shared/itemdoc/itemdoc.ts`)

Both new document kinds are one JSON object:

```json
{"junction":"part-studio","version":1,"items":[
{"id":"studio","rollback":null,"type":"studio","units":"mm"},
{"featureType":"sketch","id":"3f0c…","name":"Sketch 1","order":"V","params":{…},"type":"feature"}
]}
```

- `junction` is the kind (`"part-studio"`, `"assembly"`), `version` the format version (1).
- `items` is unordered. Every item has a stable string `id`, unique in the document, and a `type`.
- The file is written one item per line, in id order, with sorted keys, so a line diff shows the items that
  changed. Never compare files byte for byte: the server and the browser print numbers differently.
- **Unknown items.** A reader keeps item types and keys it does not know, and writes them back. Add data by
  adding item types or keys, never by changing the meaning of an existing key. Bump `version` only for a change
  an old reader would get wrong, and then old readers refuse the file.
- **Order.** A list whose members are separate items keeps each member's place in a string `order` key
  (`orderBetween(a, b)` gives a key between two others; `byOrder(items)` sorts, ties by id). Moving a member
  changes one key.

### Changes

A document changes only by item changes, the same wire shape KiCad documents use (`id`, `kind`), so the existing
collaboration path carries them unchanged:

```ts
{ id, kind: "ADDED",    typeName, item }      // the whole item; an existing id is replaced
{ id, kind: "MODIFIED", typeName, props }     // props: [{ path: ["params","depth"], value }, { path, del: true }]
{ id, kind: "REMOVED",  typeName }
```

Applied in the server's sequence order; **the last writer of a path wins**; a change to an id that is not there
does nothing (a delete beats a concurrent modify). A path is a list of object keys; arrays are single values.
So design data as maps keyed by id wherever two people might edit different members at once (the sketch does).

Helpers: `addedChange(item)`, `removedChange(item)`, `modifiedChange(before, after)` (sends only the paths that
differ), `diffProps`, `invertChange`, `applyChanges`.

### How a change is committed and synced

```ts
studio.commit(changes)        // PartStudio → ItemDocSession.commit
```

`commit` applies the changes locally at once, journals them, sends one `op` over `/ws`, and pushes one undo
step. The server sequences and stores the op and broadcasts it to everyone else in the document; their sessions
apply it and their models regenerate. An op that is not acknowledged yet is replayed after a reconnect, and
stays on top of whatever arrives before its ack. `studio.undo()` / `redo()` send ordinary changes, so everyone
sees an undo. A viewer's `commit` returns false with a notice.

**Use `document/edits.ts`** for the edits it has (`addFeature`, `setParams`, `setParamPath`, `renameFeature`,
`suppressFeature`, `moveFeature`, `deleteFeature`, `setRollback`); each returns changes and applies nothing.
Build your own changes the same way for anything else. Never mutate `session.doc` directly.

A dialog does not commit while it is open: it edits a draft (`studio.getState().editing.draft`) that the worker
previews, and Done commits once.

What the platform gives these documents:

| Works | How |
|---|---|
| Storage, roles (viewer / commenter / editor), share links | the existing `documents`, `ops`, `snapshots` tables and `access.rs` |
| Live co-editing, item by item, property by property | the existing `/ws` op path |
| Presence: who is here, pointers, views, selections, Follow | `mechanical/collab/` over `session.setPresence` / `peerList()`; see "Collaboration" |
| Comments pinned to a feature, a face, an edge or a vertex | the platform's comments (`/api/docs/{id}/comments`), anchored by geometry name; see "Collaboration" |
| Tabs appearing, renaming and going for everybody without a reload | the server's `docs` notice (below); who is on which tab is the project room (`platform/doctabs/room.ts`) |
| The stored file kept current | `compact.rs` folds the ops into a snapshot on the server (`itemdoc.rs`), with no client involved |
| Project archive, clone, GitHub sync | they read the folded file like any other; a pull with changes on both sides merges item by item (`itemmerge.rs`) |
| Create, rename, delete from the tabs | `POST /api/projects/{id}/docs`, `PATCH` / `DELETE /api/docs/{id}` |
| Version history, restore, looking at an earlier version | the History drawer (`platform/history`); the part studio's host is `mechanical/history` |
| Compare two versions | the Compare window with the domain's renderer (`platform/review/renderers.ts`, `mechanical/compare`) |
| Branches and merging, conflicts put to a choice | `versions.rs` with `itemmerge.rs`; the drawer's merge dialog |
| Thumbnails | `platform/documents/thumbnail.ts`, `mechanical/thumbnail.ts` (part studios) |
| MCP tools for an AI assistant | `mechanical/mcp` (part studios) |

| Does not work yet | |
|---|---|
| An earlier version of an assembly on screen, comparing assemblies, MCP tools and thumbnails for assemblies | the assembly editor has a History tool for versions and branches but no read-only view of another state, and registers no compare renderer; the server side is the same as for a part studio |

**The `docs` notice.** When a document of a project is created, renamed or deleted (`http.rs` `create_doc`,
`move_doc`, `delete_doc`), the server sends every open document of that project
`{ type: "docs", docId, projectId, n, change: "added" | "renamed" | "deleted", from, doc: { docId, path, docType },
by: { userId, login, name } }`. A page may hear it on several sockets (its editor's, the room's);
`platform/doctabs/roomapi.ts tellDocsChanged` hands each notice on once, as the window event the tabs listen
for. So a document made by anything (the tabs, an upload, an assistant) appears for everybody at once, and no
page polls.

### Platform features, and how another kind of document gets them

The server asks `server/src/dockind.rs` how a document type behaves (journalled as ops or stored whole, who
folds its journal, how a branch merges, how two files merge, whether its picture can stand for the project). A
new JSON item document kind is one line there and gets history, branches, merging and GitHub sync with it.

- **History** (`platform/history/`): `api.ts` is the server's versions, timeline, branches and merge as plain
  calls; `HistoryDrawer.tsx` is the drawer, handed a `HistoryHost` (`viewing`, `view(at | null)`, `compare?`,
  `canEdit`, `navigate`, `toast`). The part studio's host is `mechanical/history/index.tsx`: `view` fetches the
  document at that point (`itemDocAt`) and calls `studio.showPast(doc, label)`; `showPast(null)` brings the live
  document back. While a past document is on screen `studio.getState().past` is set, `canEdit` is false and
  `commit` refuses. The toolbar button is `tools/history.ts`. `platform/history/request.ts` lets another editor
  (the electronics History pane) ask for a point to be shown.
- **Merging** (`server/src/itemmerge.rs`): each side's work since the two last met becomes one net effect per
  item (added or replaced whole, removed, or paths set or deleted). Different items never conflict, nor do
  different paths of one item; the same path set to the same value is not a conflict; the same path set
  differently, or a path inside a path the other side set, conflicts at the shorter path; removed against
  changed conflicts on the item. `POST /api/projects/{branch}/merge` reports the conflicts (`dryRun`) and takes
  `choices: { <conflict id>: "incoming" | "current" }`. So, again: keep data that two people may change apart in
  maps keyed by id, not in arrays.
- **Compare** (`platform/review/renderers.ts`): `registerCompareRenderer({ docTypes, mount(ctx) })` from the
  domain's bundle; `ctx` has an empty element, the two files as text (`ctx.a.text`, `ctx.b.text`) and
  `setSummary`. The part studio's (`mechanical/compare/`) is `diff.ts` (features matched by id, parameters named
  by the registry's labels) and the worker service `compare-versions` (both versions built by engines of their
  own, compared by booleans: common, added, removed, each tessellated).
- **Thumbnails** (`platform/documents/thumbnail.ts`): `new ThumbnailPusher(docId, () => canvas | null)`, then
  `dirty()` when the document changes. `mechanical/thumbnail.ts` draws the bodies into a render target on the
  viewport's own WebGL context.
- **AI tools** (`platform/mcp/host.ts`): a domain's `mcp/host.ts` exports an `McpDomainTools` table and
  `mcp/tools.json` lists the tools; add the table to `domains/mcp-tools.ts` and the JSON to `DOMAIN_TOOLS` in
  `server/src/mcp.rs`. They run in the same Node host as the electronics tools (`npm run build:mcp`). The part
  studio's are `cad_feature_types` (from the feature registry), `cad_get_features`, `cad_get_bodies`,
  `cad_edit_features`, `cad_render_view`, `cad_create_part_studio`; edits are planned and validated in
  `mcp/model.ts` against each feature's `schema`, so a new feature type is editable by an assistant with no
  further work as long as its parameters are described by its schema.
- **Interface state of a tool or panel**: `studio.setUi({ myKey: value })` keeps it in `getState().ui` and
  redraws the toolbar, so a tool's `active` can read it (the History button does).

### The part studio (`.jpart`, `document/format.ts`)

```ts
// one step of the history tree
{ id, type: "feature", featureType: "extrude", name: "Extrude 1", order: "V", suppressed?: true, params: {…} }
// one item, id "studio"
{ id: "studio", type: "studio", units: "mm", angleUnits?: "deg", precision?: 3, rollback: <feature id> | null }
```

- The tree is the feature items sorted by `order`.
- `featureType` names a registered feature; `params` is that feature's own data, described by its schema.
- `rollback` is the first feature that is **not** built (the bar sits above it); `null` is the end. It is in the
  document, so it is shared and stored. A bar on a feature that no longer exists reads as the end.
- Lengths are millimetres and angles degrees, whatever the units say. `units` (mm, cm, m, in, ft), `angleUnits`
  (deg, rad) and `precision` (decimal places) say how the document is read and written: see "Units".
- Feature ids are UUIDs. A body's id is the id of the feature that made it (with a suffix when one feature
  made several), so body ids survive rebuilds.

### The sketch (`sketch/format.ts`), stored in a sketch feature's `params`

```ts
params: {
  plane: { kind: "plane", plane: "top" | "front" | "right" } | { kind: "face", ref: GeomRef } | { kind: "datum", feature },
  sketch: {
    version: 1,
    entities: {                                  // a map, keyed by short ids
      p1: { type: "point", x: 0, y: 0 },         // sketch-plane coordinates, mm
      l1: { type: "line", a: "p1", b: "p2" },    // curves refer to points by id
      c1: { type: "circle", center: "p3", r: 5 },
      a1: { type: "arc", center: "p3", start: "p4", end: "p5" },   // counter-clockwise from start to end
    },
    constraints: {                               // a map
      k1: { type: "horizontal", refs: [{ entity: "l1" }] },
      d1: { type: "distance", refs: [{ entity: "l1", at: "start" }, { entity: "l1", at: "end" }], value: 40,
            driving: true, expr: "width", label: { x: 20, y: -5 } },
    },
  },
}
```

Rules that are fixed:

- **Points are entities and curves refer to them by id.** Two curves that share a point id are joined there. A
  rectangle is four points and four lines.
- **The document always stores solved coordinates.** The sketcher solves every edit before committing it (the
  solver is PlaneGCS compiled to WebAssembly, embedded in the page's bundle; `sketch/solver`) and writes the
  resulting positions and radii into the entities; the kernel builds geometry from the entities alone and never
  solves. A reader that does not know a constraint type keeps it and ignores it.
- A dimension is a constraint with a `value` (mm, or degrees for an angle). `driving: false` is a reference
  dimension. `expr` is the text it was typed as (`sketch/expr.ts`: arithmetic, units, variables). `label` is
  where its text sits.
- `construction: true` on an entity keeps it out of profiles. `from: GeomRef` on an entity says which edge of
  the model it was projected from (Use edge).
- Constraint type names: `coincident`, `horizontal`, `vertical`, `parallel`, `perpendicular`, `tangent`,
  `equal`, `midpoint`, `concentric`, `collinear`, `symmetric`, `fix`, `distance`, `radius`, `diameter`, `angle`.
  `sketch/refs.ts` says what their references mean.
- A sketch edit is one `MODIFIED` change on the feature item with one prop per entity or constraint that
  changed (`sketch/model.ts` `Draft`; the editor's `edit((draft) => …)` is the one way a tool changes a sketch).
- New entity kinds (ellipse, spline, text) are new `type` values; `sketch/format.ts curvePoints`,
  `features/sketch.ts edgeFor` and the solver's translation are the places that must learn them.

Sketch planes: `top` is XY (normal +Z), `front` is XZ (normal −Y), `right` is YZ (normal +X). The ids are
stored; never rename them. On a face, the frame comes from `Kernel.faceFrame`: the normal points out of the
solid, x is the surface's own first direction, and the origin is the point of the plane nearest the world origin.

**Regions** (`sketch/planar.ts`, with `sketch/profiles.ts` for the types): the closed regions of the planar
arrangement of the sketch's curves, so curves may cross: two overlapping circles enclose three regions, a line
across a rectangle splits it. A region's id is made from the curves on its boundary; treat it as opaque. A
`profile` parameter is `{ sketch, regions: null | string[] }`: `null` is every region. In a dialog, the first
click on a sketch takes all of it; clicks inside its regions then choose among them (from "all", a click leaves
just that region, further clicks add and take away, "All" puts every region back).

**The sketcher** (`sketch/editor.ts`, one `SketchEditor` per studio, `window.JunctionSketch` while a sketch is
open) owns the pointer and the keys while a sketch is open and draws the sketch itself on a 2D canvas over the
viewport. Its tools are the toolbar while a sketch is open (see "The toolbar"); the sketch has a dialog of its
own (`ui/SketchDialog.tsx`: the plane, which can be changed; ✓ and ✗); the Sketch panel in the right dock lists
the dimensions and constraints; the status bar says how the sketch stands. Esc and a right click put a tool
down, Esc again clears the selection; neither ever leaves the sketch. ✓ (Finish sketch) keeps it; ✗ (Cancel
sketch) puts it back as it was when it was opened, and takes a sketch made by that visit away again, as one
undoable step (`studio.cancelSketch`).

- **Starting one.** Sketch with a plane or a flat face selected starts drawing at once. With nothing selected
  the dialog asks for the plane, and a click on one (in the model, on its row in the feature list, or on Top /
  Front / Right in the dialog) starts drawing; ✓ takes the plane shown (Top).
- **The view.** Opening a sketch turns the view to face its plane when the person likes it so (a preference,
  `ui/prefs.ts sketchNormal`, in the sketch's dialog; N does it at any time), and finishing turns it back to
  where it was.
- **Features from inside a sketch.** Extrude and Revolve are in the sketch toolbar, and Shift+E / Shift+W work in
  a sketch: the feature takes that sketch (`studio.startFeature` finishes the sketch and uses it as the profile).

- Drawing tools (`sketch/shapes.ts`, engine `sketch/draw.ts`): line, rectangle, centre rectangle, circle, three
  kinds of arc, slot, point; inference while drawing (`sketch/infer.ts`); a measure typed while drawing becomes
  a dimension.
- Modify (`sketch/ops.ts`): fillet, trim, extend, offset, mirror, construction, and **Use edge**
  (`sketch/modify.ts`, the `sketch-project` service): an edge or a corner of the model drawn in the sketch,
  projected onto its plane and fixed there. Any edge of the model as it is at that point of the tree can be
  used, including a Board feature's outline and hole rims when the Board feature comes before the sketch (its
  solids are hidden under the board's picture but are there for the pointer).
- Constraints (`sketch/constrain.ts`) and dimensions (`sketch/dimension.ts`): select then press, or press then
  click. The status line says under-constrained with the freedoms left, fully constrained, or names what
  conflicts.

## Features

## Features

### The registry API (`core/feature.ts`)

```ts
export interface FeatureDefinition<P> {
  type: string;                 // stable id, stored as featureType: never rename
  title: string;                // "Extrude"; new features are named "Extrude 1", …
  icon?: string;                // inline SVG markup, 24×24 stroke glyph, currentColor
  defaults(): P;                // parameters of a new feature (a fresh object each call)
  schema: ParamField[];         // the dialog's fields, in order
  evaluate(ctx: EvalContext, params: P): void | Promise<void>;   // runs in the worker
  toolbar?: boolean;            // false: no toolbar button
  toolbarOrder?: number;
  toolbarSection?: "sketch" | "solid" | "pattern" | "reference" | "board";   // which part of the toolbar ("solid")
  toolbarMenu?: string;         // features of one section with the same menu share a drop-down ("Fillet")
}
```

`ParamField` is `{ key, label, hint?, visible?(params) }` plus one of:

| `kind` | Stores | Dialog |
|---|---|---|
| `number` (`unit`, `min`, `max`, `step`) | a number (mm, degrees) | a number field showing the document's unit; takes a unit typed with the number, expressions and variables; ↑ ↓ and dragging the label step it |
| `boolean` | a boolean | a checkbox |
| `text` | a string | a text field |
| `enum` (`options`) | a string | a segmented control, or a select above four options |
| `profile` | `{ sketch: <feature id>, regions: null \| string[] }` | a list of earlier sketches; click one in the viewport, then its regions to choose among them |
| `plane` | a `PlaneRef` | Top / Front / Right (buttons, their rows in the feature list, or the planes in the model), or click a planar face or a reference plane |
| `refs` (`of: GeomKind[]`, `single?`, `datums?`, `planes?`, `sketch?`) | `GeomRef[]` (or one); a `RefTarget` (`features/_refs.ts`) for a default plane, reference geometry or a sketch curve | a list that listens: click faces, edges or vertices in the viewport to add, again to take out; with the options, reference geometry, the default planes (also buttons) and sketch curves |
| `features` (`types?`, `exclude?`) | `string[]` of earlier feature ids, in the order picked | a list of the earlier features |
| `bodies` | `string[]` of body ids; empty means every body | click a body |
| `document` (`docTypes`) | another document's id | a list of the project's documents of those types |

A number field accepts an expression (see "Variables") and units (see "Units").

**How a field that takes geometry behaves** (`ui/fields.ts`, pure and tested by `cad-fields.test.js`;
`studio.ts` applies it). While a field listens (it is outlined; `editing.field`), the viewport's filter is the
kinds it takes, the pre-highlight is exactly what a click will take, and
- a click adds; a click on something the field holds takes it out; a click on nothing changes nothing;
- a selection box adds only; × takes one thing out, Clear all;
- a field that holds one thing is replaced by the click, and the next empty field then listens;
- what was selected before the tool was started fills the first fields that take it, each pick once;
- Tab goes round the fields that take geometry; Esc puts the listening field down, then cancels; Enter accepts;
- a click in the model while no field listens goes to the first field that takes it (never to a selection the
  dialog cannot use).

What the fields hold stays highlighted while the dialog is open (`view.setMarks`): the listening field's as a
selection, the others' quieter. A feature consumes what it is given (a filleted edge is not an edge of the
preview), so the page asks the worker what such a pick looked like before the feature (the `ref-geometry`
service) and keeps drawing it; a click on it takes it out. The dialog's frame is `ui/DialogShell.tsx`: it is
dragged by its title, folds to it, and the next dialog opens where the last was left; ✓ and ✗ are at the right
of the title for every dialog. Editing a feature that is not the last, **Final** shows the model with the later
features built (`studio.setFinal`).

A feature file is bundled into both the page and the worker. **It must not touch the DOM, three.js or React at
module level**, and `evaluate` must use only its context.

### `EvalContext` (`kernel/types.ts`)

```ts
ctx.oc                         // the raw OpenCascade bindings (typed: OpenCascadeInstance)
ctx.k                          // helpers: sub(), list(), prism(), boolean(), carryNames(), faceFrame(), volume(), …
ctx.feature                    // { id, type, name }
ctx.bodies(), ctx.body(id)     // bodies() leaves out reference bodies (a Board feature's board); body(id) finds any
ctx.allBodies()
ctx.addBody(shape, names, { suffix?, name?, reference? })   // names: (face, index) => string | null
ctx.datum(id), ctx.setDatum(d) // reference planes, axes, points, curves
ctx.history(id)                // the model just before and just after an earlier feature (patterns, mirror)
ctx.replaceBody(body, shape, names)                // keeps the body's id and name
ctx.removeBody(body)
ctx.sketch(featureId)          // SketchGeometry: frame, regions (kernel faces with their edges), open curves
ctx.setSketch(sketch)
ctx.resolve(ref)               // GeomRef → { kind, body, shape, name }, or a FeatureError
ctx.frameOf(planeRef)
ctx.own(obj)                   // delete obj when this feature's cached result is dropped
ctx.tmp(obj)                   // delete obj when evaluate returns
throw ctx.fail("Pick an edge to fillet.")          // a message a person can act on
ctx.warn("…")                  // a note on the feature; it still succeeds
```

Rules:

- The model a feature sees is a working copy. If `evaluate` throws, the model stays as the feature found it,
  the feature shows the message, and later features still run.
- **Name every face you make**, through `ctx.k.carryNames(resultShape, builder, inputFaces, ctx.feature.id)` for
  an operation with history (any `BRepBuilderAPI_MakeShape`: fillet, chamfer, shell, booleans), or with your own
  `FaceNamer`. Edge and vertex names follow from the faces automatically.
- Kernel objects are embind handles. `ctx.k.sub()` and `ctx.k.list()` track what they hand out; anything you
  make with `new oc.X()` goes through `ctx.tmp()` or `ctx.own()`. A shape you pass to `addBody` /
  `replaceBody` is owned for you.
- Do not keep state between evaluations in module variables: results are cached and replayed.
- Parameters are JSON. Validate them and fail with a sentence, not an exception from the kernel.

### Worked example: a Fillet feature

Create `features/fillet.ts`. Nothing else changes: the toolbar button, the dialog, the regeneration, the sync
and the undo all come from this file.

```ts
// fillet.ts — round the picked edges of a body.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";

export interface FilletParams { [key: string]: any; edges: GeomRef[]; radius: number }

export default defineFeature<FilletParams>({
  type: "fillet",
  title: "Fillet",
  icon: '<path d="M5 19V11a6 6 0 0 1 6-6h8"/>',
  toolbarOrder: 30,
  defaults: () => ({ edges: [], radius: 1 }),
  schema: [
    { key: "edges", label: "Edges", kind: "refs", of: ["edge"] },
    { key: "radius", label: "Radius", kind: "number", unit: "mm", min: 0.001 },
  ],
  evaluate(ctx: EvalContext, p: FilletParams) {
    if (!p.edges.length) throw ctx.fail("Pick the edges to round.");
    if (!(p.radius > 0)) throw ctx.fail("The radius must be more than zero.");
    const oc = ctx.oc as any;
    // group the picked edges by the body they are on
    const byBody = new Map<string, ReturnType<EvalContext["resolve"]>[]>();
    for (const ref of p.edges) { const r = ctx.resolve(ref); byBody.set(r.body.id, [...(byBody.get(r.body.id) || []), r]); }
    for (const [bodyId, edges] of byBody) {
      const body = ctx.body(bodyId)!;
      const mk = ctx.own(new oc.BRepFilletAPI_MakeFillet(body.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational));
      for (const e of edges) mk.Add(p.radius, oc.TopoDS.Edge(e.shape));
      mk.Build();
      if (!mk.IsDone()) throw ctx.fail("The fillet could not be built. Try a smaller radius.");
      const shape = ctx.own(mk.Shape());
      // old faces keep their names; each new blend face is named after the edge it replaced
      const names = ctx.k.carryNames(shape, mk, body.topo.faces, ctx.feature.id, edges.map((e) => ({ name: e.name, shape: e.shape })));
      ctx.replaceBody(body, shape, names);
    }
  },
});
```

Then `npm run gen:cad && npm run check`, and add a case to `static/tests/mechanical-kernel.test.js` (or a test
file of your own: copy its first twenty lines for the loader).

(Check the enum and constructor names against `node_modules/replicad-opencascadejs/dist/replicad_single.d.ts`
before relying on them: the example has not been run.)

### Regeneration (`kernel/regen.ts`)

- The worker is sent every feature and the number to build (`rollback`).
- A feature is evaluated again only if it, or a feature before it, changed: id, type, `suppressed` or `params`.
  A rename changes nothing. Editing feature 10 of 20 evaluates 10 to 20.
- Results beyond the rollback bar stay cached while nothing before them changes, so moving the bar is free.
- A suppressed feature is skipped; one that depended on it fails with its own message.
- Each feature reports `ok`, `warning`, `error`, `suppressed` or `rolled-back`, a message, and its time.
- A body has a `rev` that changes when its shape does. The page says which revisions it holds and is sent
  meshes only for the others.
- While a dialog is open the page sends the draft in place of (or inserted among) the document's features, and
  while a sketch is open it sends the list rolled back to that sketch. That is local: the document's `rollback`
  is not touched.
- A body may be a **reference body** (`Body.reference`, `BodyResult.reference`): there to be referred to and
  drawn, not a part. Features that act on "every body" leave it alone, mass properties leave it out by default,
  the Parts panel marks it, and the board editor's enclosure does not draw it.

### Building a part studio outside its page (`document/inputs.ts`)

A part studio is built in many places besides its own tab: an assembly drawing an instance, Compare, the
history view, the assistant's host, the board editor's enclosure, the interference check. **All of them turn the
document into the worker's input with one function**, so they all build the same model:

```ts
import { studioInputs, BoardFeed } from "mechanical/api";
const feed = new BoardFeed({ signedIn, changed: () => rebuild() });       // only if the studio may hold a Board feature
const { features, rollback } = studioInputs(doc, { filters: [feed.filter] });
const result = await kernel.regenerate(features, rollback);
```

`studioInputs` takes the features in order, replaces numbers typed as expressions by their values under the
document's variables (`document/variables.ts resolveInputs`), then runs the input filters. A filter supplies
what a feature needs that is not in the document. There is one today: a Board feature's board (`$board`),
which is read live from the board document and never stored. On the studio's own page the filter is
`board/link.ts` (which also draws the board); everywhere else it is `board/feed.ts` `BoardFeed`, which opens the
boards it meets on the collaboration socket, read-only, and calls `changed` when a board arrives or an edit of
it changes what a feature is built from. A caller that builds once awaits `feed.settled()` first.

| Who builds a part studio | Where | How |
|---|---|---|
| Its own page | `ui/studio.ts regen` | `studioInputs` with `studio.inputFilters` (the dialog's draft laid over the features) |
| An assembly instance of a part | `assembly/sources/part.ts` | `studioInputs` + a `BoardFeed` per studio; rebuilt when the studio or its boards change |
| The interference check, the bill of materials | `assembly/services/interference-sources.ts` | nothing of its own: the editor's handles and workers (`handle.ensureKernel()`) |
| Compare | `compare/index.tsx` | `studioInputs` + a `BoardFeed` per side, awaited |
| An earlier version on screen | `studio.showPast(doc)` | the page's own path |
| The assistant | `mcp/host.ts` | `studioInputs` + a `BoardFeed` on the host's socket |
| The board editor's 3D enclosure | `pcb/mech/enclosure.ts` | `studioInputs` + a `BoardFeed`; reference bodies are not drawn |
| Thumbnails, exports | the page | the page's own model |

A board is not part of a version: an earlier version of a part studio is built with the board as it is now.

## Geometry names

Features and mates refer to faces, edges and vertices by **name**, never by index:

```ts
interface GeomRef { kind: "face" | "edge" | "vertex"; body: string; name: string }
```

`ctx.resolve(ref)` looks the name up on every rebuild, in `ref.body` first and then in every body (a body that
was merged into another keeps its faces' names).

How names are made:

| Geometry | Name |
|---|---|
| Extrude cap | `<feature id>:start:<region id>`, `<feature id>:end:<region id>` |
| Extrude side | `<feature id>:side:<sketch entity id>` (the curve that swept it) |
| A face an operation left alone or modified | the name it had |
| One named face split into several | the first keeps the name; the others get `name~2`, `name~3`, … |
| A face generated from a named input (a fillet from an edge) | `<feature id>:from(<that name>)` |
| A face with no history | `<feature id>:new#<n>` |
| A face an extrusion stops on (up to face, up to next) | its end cap, `<feature id>:end:<region id>` |
| Thin extrude wall offset from a side | `<feature id>:side:<entity>:inner` / `:outer` |
| Revolve | as Extrude: `:side:<entity>`, and `:start:` / `:end:<region>` when not a full turn |
| Shell or thin wall face | `<feature id>:from(<the face it is offset from>)`; an opening's rim keeps the removed face's name |
| Drafted face, moved or copied body (Transform) | the name it had |
| Hole | `<feature id>:<sketch point id>:wall`, `:floor`, `:cbore`, `:cbore-floor`, `:csink` |
| Split | the new flat face on each piece is `<feature id>:cut` |
| Edge | `edge(<face>\|<face>)`: the names of the faces it lies between, sorted |
| Vertex | `vertex(<face>\|<face>\|<face>)`: the faces that meet there, sorted |
| Several edges or vertices with the same faces | `…~2`, `…~3` |

Names are opaque strings to everything but the kernel helpers. Do not parse them.

**What is stable.** A reference survives any change upstream that keeps the creating feature, the sketch entity
and the face's identity: changing a depth, moving sketch points, adding features in between, adding or removing
material elsewhere on the body. Tested: `static/tests/mechanical-kernel.test.js`.

**What is not, honestly:**

- `~n` and `#n` suffixes are assigned in geometric order (by centre of mass: x, then y, then z). They appear
  when one face is split into several, and when several edges lie between the same two faces (a slot cut across
  a face meets it in two edges with the same pair of names). An edit that moves such siblings past each other
  can swap their names, and a reference to one may then jump to the other.
- When a boolean merges two coplanar faces, the merged face keeps the name of the body being changed; the
  tool's cap name disappears. A reference to the lost name fails with "no longer exists".
- Deleting and redrawing a sketch curve gives it a new entity id, so the faces it sweeps get new names.
- Redrawing a region so that a different curve has the smallest id changes the region id, and the cap names.
- A sketch on a face takes its x direction from the surface's own parametrisation, which is stable for planes
  made by Extrude but is not guaranteed for every operation; a sketch may turn in its plane after an upstream
  feature is replaced by a different kind.
- Names are unique within a body, not across bodies made by patterns or copies: a pattern feature must add the
  instance to the names it makes.
- There is no persistent-id service beyond this: no geometric matching of a lost reference to the nearest
  survivor.

## The worker

### Protocol (`kernel/protocol.ts`)

```
page → worker   { t: "init", wasmUrl, module? }      // module: the kernel as the page compiled it
                { t: "regen", seq, features: FeatureInput[], rollback: number, have: number[] }
                { t: "call", seq, service: string, args: Json }
worker → page   { t: "ready", ms } | { t: "failed", message }
                { t: "progress", seq, index, total, featureId }
                { t: "regen", seq, result: RegenResult }
                { t: "call", seq, ok: true, value } | { t: "call", seq, ok: false, error }
```

`FeatureInput` is `{ id, type, name, suppressed, params }`. `RegenResult` is
`{ features: FeatureReport[], bodies: BodyResult[], sketches: SketchView[], rebuiltFrom, ms }`. A `BodyResult`
is `{ id, name, createdBy, rev, mesh? }`, and a `BodyMesh` is typed arrays, transferred:

```ts
positions, normals: Float32Array; indices: Uint32Array;
faces:    { names: string[]; start, count: Uint32Array }              // ranges of `indices`
edges:    { names: string[]; positions: Float32Array; start, count }  // line segments, two points each
vertices: { names: string[]; positions: Float32Array }
bbox:     [xmin, ymin, zmin, xmax, ymax, zmax]
```

Messages are handled one at a time, in order; a regeneration is skipped when a newer one is already waiting.
`KernelClient` (`kernel/client.ts`) is the page's end: `regenerate(features, rollback)` resolves with the
result, or null when a newer request overtook it; `call(service, args)` resolves with the service's JSON.
Nothing is loaded until the first regeneration: opening a board never fetches the kernel. The kernel's module
is compiled once per page (`kernel/wasm.ts`, retried when a download is cut short) and handed to every worker
the page starts, so an assembly's second and third worker do not download or compile 23 MB again.

**Meshes** (`kernel/tessellate.ts qualityFor`). A body is meshed for the screen with a chord tolerance of half a
thousandth of its diagonal (between 0.01 and 0.5 mm) and an angular tolerance of 0.3 rad, loosened to 0.5 on a
body of more than 150 faces and 0.8 on one of more than 300. The angle is what decides how many segments a
small hole or fillet gets, and the mesher's time grows faster than the number of points on a face's
boundaries: a 200 mm plate with 400 holes took 4.0 s to mesh at the former fixed 0.05 mm / 0.3 rad and 0.6 s
now (the whole rebuild 5.8 s → 1.8 s; measured in node). Exports mesh at their own resolution.

### Services (`kernel/service.ts`)

A question about the model that is not a feature (measure, section, mass properties, export) is a file under
`services/`:

```ts
export default defineService({
  name: "mass-properties",
  run(ctx, args) { /* ctx.oc, ctx.k, ctx.state.bodies, throw ctx.fail("…") */ return { volume, area, centre }; },
});
// page:  const mass = await studio.kernel.call("mass-properties", { body: bodyId });
```

`ctx.state` is the model the page is showing (after the last regeneration). The result is JSON, and may hold
typed arrays (an exported file): they are transferred (`kernel/ops/exchange-export.ts transferables`).

`ctx.before(featureId)` is the model just before a feature was built (null when it is not built; present only
in the page's own worker).

Services today: `mass-properties`, `measure-entities`, `measure-clearance`, `interference` and `clearance`
(shapes sent as BRep text, for the assembly), `body-brep`, `export-step`, `export-mesh`, `export-outline`,
`export-convert`, `sketch-project`, `compare-versions`, `board-placement`, `boardlink-solve`, `ref-geometry`
(what named faces, edges and vertices looked like before a feature consumed them).

### The kernel

`replicad-opencascadejs` 1.2.1 from npm: OpenCascade 7 compiled to WebAssembly, LGPL-2.1 with the Open CASCADE
exception (the same kernel licence the desktop app already links; compatible with GPLv3). Only its bindings are
used, not the replicad library. The `.wasm` is 23 MB (about 7 MB compressed), copied to
`static/dist/pyodide/occ-kernel.wasm` by `scripts/build-python.mjs` (that folder is not committed and is served
from disk at `/static/pyodide/`), and fetched by the worker on first use. Its JavaScript half is bundled into
`cad-worker.js`.

The build exposes a subset of OpenCascade (about 500 classes): primitives, sweeps, booleans, fillet, chamfer,
offset, thick solid, draft, loft, pipe, STEP read and write, `GProp`, `BRepExtrema`. It does **not** expose
`TopTools_IndexedMapOfShape`, `TopExp::MapShapesAndAncestors` or `TShape()`; use `Kernel.sub()` and `ShapeIndex`
(hash + `IsSame`) instead. Check the `.d.ts` before designing around a class. Overloads are real overloads
(`new oc.BRepPrimAPI_MakePrism(face, vec, false, true)`), not the `_1`, `_2` suffixes of older opencascade.js.

## The toolbar and panels

### The frame (`ui/PartStudioView.tsx`)

```
the toolbar            the tools of the mode the studio is in
left dock │ viewport │ right dock      over the viewport: the dialog of the feature or sketch being edited (top left,
                                       movable), the view cube (top right), the measure readout (bottom right)
the status bar         kernel and hints · how the open sketch stands · what a click picks · the units · ?
```

### The toolbar (`ui/Toolbar.tsx`, `ui/commands.ts`)

Drawn from the registries; nothing is listed by hand. It shows the tools of the **mode** and nothing else
(`data-mode` on `.cad-toolbar`):

```
model    undo redo delete │ Sketch │ Extrude Revolve Sweep▾ Fillet▾ Shell Hole Boolean▾ │ Pattern▾ │ Reference▾ │ Board▾ │ Measure Section Comment │ Planes Display Perspective │ History Import Export
sketch   undo redo │ Line Rectangle▾ Circle Arc▾ Slot Point Construction │ Sketch fillet Trim Extend Offset Mirror Use edge │ Dimension │ the twelve constraints │ Extrude Revolve │          ✓ Finish sketch  ✗
dialog   <icon> <name>  <what the listening field wants> │ Planes Display Perspective │                                   ✓  ✗
view     (no edit rights) Measure Section Comment │ Planes Display Perspective │ History Import Export
```

- A **feature** says which section it is in (`toolbarSection`, "solid" when absent) and, when it is one of a
  family, which drop-down it shares (`toolbarMenu`): Sweep ▾ holds Sweep and Loft; Fillet ▾ Fillet, Chamfer and
  Draft; Boolean ▾ Boolean, Split, Delete body and Transform; Pattern ▾ Linear pattern, Circular pattern and
  Mirror; Reference ▾ Plane, Axis, Point and Helix; Board ▾ Board, Opening and Standoffs. A family of one is a
  plain button. Order inside a section is `toolbarOrder`.
- A **tool** (`core/tool.ts`) names its group (`edit`, `sketch`, `feature`, `inspect`, `view`, `file`) and may
  name a `menu` the same way. Tools in `sketch` are the sketch toolbar, in the parts their `order` puts them in
  (draw below 100, modify below 200, constraints below 300, dimension from 300); Rectangle ▾ and Arc ▾ are
  families. A tool with `button: false` has no button (Select, Hide, Isolate) but is in the tool search.
- A **family is a split button**: its face runs the variant used last (kept in the browser, `ui/prefs.ts`), its
  caret opens the list. In the DOM the face is `[data-tool][data-variant]`, the caret `[data-menu][data-items]`.
- **Every button has a tooltip** with its name, its key and one line on what it does (`ui/Tip.tsx`; a tool's
  `hint`, a feature's line in `commands.ts FEATURE_HINTS`). Buttons carry no `title`.
- **The tool search** (`ui/Overlays.tsx CommandPalette`): S opens it at the pointer, Ctrl/Cmd+K in the middle;
  it lists everything `commands.ts allCommands` returns for the mode. **?** opens the sheet of keys, read from
  the same registries.
- **The bar does not scroll sideways** in a window of ordinary width. When the buttons do not fit, the tools
  lose their labels (`data-density="1"`), then the features (`"2"`); in a sketch the constraints fold into one
  drop-down. In a script, click a button with `scripts/cad-chrome.mjs` `tool(page, "Chamfer")`, which opens the
  drop-down when the button is in one.

```ts
export default defineTool({
  id: "measure", title: "Measure", hint: "Click two things", icon: "<path …/>",
  group: "inspect", order: 10, key: "m",
  disabled: (studio) => (studio.getState().bodies.length ? null : "Nothing to measure"),
  active: (studio) => false,
  run: (studio) => { … },
});
```

**Keys.** `key` runs the tool wherever the keyboard is in the part studio except in a field being typed into
(`studio.ts onKey`, `onKeyElsewhere`). While a sketch is open the sketcher gets every key first and looks only
among the `sketch` tools, so a letter may mean one thing in a sketch and another outside it. Taken today:

| | Outside a sketch | In a sketch |
|---|---|---|
| M | Measure | Mirror |
| X | Section view | Extend |
| H / I | Hide / Isolate the selected parts | Horizontal / Coincident |
| F / Z | Zoom to fit / to the selection | Sketch fillet / — |
| W, P, N, S, ? | Display mode, planes on and off, view normal to, tool search, the sheet of keys | the same |
| Shift+1 … 7 | Front, back, left, right, top, bottom, isometric | the same |
| ← ↑ → ↓ | Turn the view 15° (Shift: 90°) | — |
| Shift+S E W F C H P | Sketch, Extrude, Revolve, Fillet, Chamfer, Hole, Plane (`studio.ts FEATURE_KEYS`) | the same, but Sketch; Extrude and Revolve take the open sketch |
| L R C A, Q, T O U, V B E D | — | Line, Rectangle, Circle, Arc; Construction; Trim, Offset, Use edge; Vertical, Parallel, Equal, Dimension |
| Del, Esc, Enter, Tab, F2, Ctrl+Z / Y, Ctrl+K | delete the selected features; step back (field → dialog → selection); accept the dialog; the next field; rename; undo / redo; tool search | delete; put the tool down, then clear the selection; accept a typed value; —; —; undo / redo; tool search |

Do not give a tool outside the `sketch` group a letter another such tool has (`static/tests/mechanical-doc.test.js`
checks it), nor one of the letters `studio.ts` takes itself (F, Z, N, S). The assembly's keys are its own
(I Insert, F Fix, E Explode).

A tool that takes over the pointer sets `studio.view.pointerTool = { down, move, up }` and `studio.keyHandler`,
and draws its rubber band with `studio.view.setOverlay(segments, dots)`.

### Panels and docks (`core/tool.ts`, `ui/panels.ts`)

```ts
export default definePanel({
  id: "mass-properties", title: "Mass properties", side: "right", order: 20,
  open: false,                                       // or (studio) => boolean; open when absent
  count: (studio) => 3,                              // a number beside the title (null: none)
  visible: (studio) => true,                         // in its dock only while this holds
  render: (studio) => <MassProperties studio={studio} />,
});
```

A panel is a React component that reads the studio with `useStudio(studio, (s) => s.bodies)` (`ui/hooks.ts`).
`side: "overlay"` is drawn over the viewport with no frame (the measure readout, the section controls).

- **Every panel folds** by its header, and each dock folds to a rail; what a person chose is remembered in the
  browser. A panel the person has not touched follows `open`: the Board panel unfolds when the part studio has a
  Board feature or a link. `showPanel(id)` (`ui/panels.ts`) unfolds a panel from a tool (Comment does).
- **A folded panel stays mounted**: some panels keep a part of the studio alive (the Collaborators panel the
  collaboration layer, the Sketch panel the sketch editor). A panel whose content costs something to keep
  current asks `usePanelOpen(studio, id)` and does nothing while folded (mass properties does).
- Left dock: Features, Parts. Right dock: Sketch (while a sketch is open), Variables, Mass properties (folded),
  Appearance (folded), Board (unfolds itself), Collaborators, Comments (folded).
- **The feature list** (`ui/FeatureList.tsx`) starts with the **default geometry** (Origin, Top, Front, Right:
  rows that select and hide like any other, and that a listening plane field takes a click on), then the
  features. A box filters by name; Ctrl and Shift select several; F2 or a second slow click renames; the eye
  hides and shows a plane, a sketch or reference geometry (`studio.setVisible`: this person's view, kept in the
  browser per document, never in the document); the pointer over a row lights up what the feature made and the
  pointer over the model marks the row that made the face; the rollback bar is always there to drag and says
  how many features are below it; the menu has Edit, Rename, Suppress, Roll back to here, Roll to end, Hide,
  Zoom to, what it uses and what uses it, Delete (several at once); a failed feature's mark shows its message
  and a click looks at it. **Parts** (`panels/parts.tsx`): click selects the part, the eye hides it, the menu
  isolates, zooms, opens Appearance, deletes.
- In a script, `scripts/cad-chrome.mjs` `openPanel(page, id)` unfolds one.

### `PartStudio` (`ui/studio.ts`)

What tools, panels and dialogs are handed:

```ts
studio.getState()              // StudioState: features, rollback, reports, bodies, sketches, selection, hover,
                               //   editing, sketch, kernel, peers, canEdit, canUndo, canRedo, units, visibility,
                               //   selectedFeature(s), hoverFeature, …
studio.subscribe(fn)
studio.doc                     // the ItemDoc (read only; change it with commit)
studio.commit(changes)         // see "How a change is committed"
studio.undo(), studio.redo()
studio.kernel.call(name, args)
studio.view                    // ModelView: pick(ev), planePoint(ev, frame), setOverlay, setFilter, sketchFrame, pointerTool,
                               //   setMarks, boxOf(picks), normalOf(pick), picksOfFeature(id), planeLayer
studio.viewport                // Viewport3D: fit(), setView(), lookAlong(), rotateBy(), ray(ev), project(p), pixelSize(), scene
studio.select(picks), studio.selectFeature(id, add?), studio.selectFeatures(ids), studio.pickFromList(pick)
studio.startFeature(type), studio.editFeature(id), studio.setDraft(patch), studio.acceptFeature(), studio.cancelFeature()
studio.setField(key), studio.fillField(key, pick), studio.clearField(key, index?), studio.setFinal(on), studio.pickFilter()
studio.openSketch(id), studio.finishSketch(), studio.cancelSketch(), studio.setSketchTool(id), studio.setSketchPlane(ref)
studio.isVisible(id), studio.setVisible(ids, on), studio.setPlanesVisible(on)   // "origin", "top", "front", "right", feature ids
studio.setUnits({ length?, angle?, places? })
studio.fit(), studio.zoomToSelection(), studio.zoomToFeature(id), studio.normalTo()
studio.host                    // DocumentHostContext: project, doc, docs, toast(), openDoc()
studio.inputFilters            // what is added to the worker's input before every regeneration (never stored)
studio.onRegen                 // called after every regeneration whose result was shown
studio.scheduleRegen()         // an input filter's data changed: build again
studio.showPast(doc, label)    // an earlier version in place of the live document (null: back)
studio.setUi({ key: value })   // interface state of a tool or panel, kept in getState().ui
```

`studioExtensions.push((studio) => stop)` registers something that lives as long as each studio is open.

`window.JunctionPartStudio` is the open studio, for tests and the console.

### Picking (`viewport/modelview.ts`)

```ts
type Pick =
  | { kind: "face" | "edge" | "vertex"; body: string; name: string; point: Vec3 }
  | { kind: "plane"; plane: "top" | "front" | "right"; point: Vec3 }
  | { kind: "sketch"; featureId: string; entity: string | null; region: string | null; point: Vec3 }
  | { kind: "datum"; featureId: string; datum: "plane" | "axis" | "point" | "curve"; point: Vec3 };
```

A vertex wins over an edge wins over a face when the pointer is within a few pixels; a body wins over a sketch
wins over a plane. A body that is drawn in another way (`view.bodyStyle` returns `faces: false`: a Board
feature's solids under the board's picture) is still found by the pointer; anything that sets a body's
visibility (display modes do) must ask `bodyStyle` first. Hover and selection are highlighted from the same picks. Turn a pick into a stored reference
with `{ kind, body, name }`. A plane or reference geometry a person has hidden is neither drawn nor picked.

- **A drag with the left button on nothing draws a box** (`view.onBox`): from left to right it takes the faces
  and edges wholly inside it, from right to left (dashed) whatever it touches, of the kinds the filter allows;
  what is behind other geometry counts too. Shift or Ctrl adds to the selection; into a listening field it
  adds only.
- **A right click that did not turn the view** (`view.onContext`) opens the menu for what is under it
  (`ui/Overlays.tsx ContextMenu`); in a sketch it first puts the tool down.
- **The default planes** (`viewport/planes.ts`) are translucent rectangles that reach a little past the model
  on their two axes and grow with it, each with its name as page text inside a corner (upright, the corner
  that is in view, fading as the plane turns edge-on). Reference planes are labelled with their feature's name.

Viewport navigation: right-drag turns, middle-drag or Shift / Ctrl + right-drag slides, the wheel zooms about
the pointer, a double click with the middle button or F fits. The **view cube** (`ui/ViewCube.tsx`, top right;
the element is also `.v3-views`, and its faces and the two buttons under it carry `data-view`) turns the view
from a face, an edge or a corner, by 15° with its arrows, and its menu has the projection, the display modes,
the section view, the planes, zoom and the named views. Model space is millimetres, Z up.
Colours come from the theme tokens (`tokenColor("--mark")`); do not write colour literals.

## Collaboration (`mechanical/collab/`, `platform/doctabs/room.ts`)

Everything here sits on the document session and changes nothing on the server.

**Presence.** `collab/collab.ts` (`Collab`) sends a small state on the session's presence lane, at most twenty
times a second and only when it changed (`collab/presence.ts`): `cam` (orientation, target, zoom, aspect), `cur`
(the model point under the pointer), `sel` (picks as `["f"|"e"|"v", body, name]`, `["p", plane]`,
`["s", sketch, entity, region]`), `feat` (the selected row), `edit` (`{ id, kind: "dialog" | "sketch", isNew?,
name? }`), `fol` (whom this person follows), and `key` / `col` (the person's window and colour, the same on every
tab). `collab/overlay.ts` draws the others in the viewport; `panels/collab.tsx` lists them; `ui/slots.ts`
`addFeatureRowSlot` is how they get into the feature list (a slot is a component at the right end of every row;
use it for your own marks too). The part studio's layer is `studioCollab(studio)` (`collab/studio-collab.ts`):
`{ collab, guard, comments, meshes }`, alive while the Collaborators panel is mounted;
`window.JunctionCadCollab` is the open one, for tests.

- A feature with an editor of its own needs nothing: presence reads `studio.getState().editing` and `.sketch`.
- Another 3D editor gets presence with one call, `mountViewportCollab({ session, viewport, ctx, local, subscribe })`
  (exported from `mechanical/api.ts`; the assembly uses it): avatars, pointers, views, Follow. Pass `sources`
  to have other people's selected faces and edges drawn on your meshes.
- Presence never rebuilds anything. A window that is hidden does not rebuild on other people's edits; it
  rebuilds once when it is shown again (`studio.scheduleRegen`).

**Follow.** `collab.follow(key)` eases the camera to the other person's each time theirs moves; turning, panning
or zooming one's own view, a standard-view button, or starting to edit stops it. When the person goes to another
tab the follower is taken there and the follow carries over (to an editor that has presence).

**Two people in one feature** (`collab/guard.ts`, `collab/merge.ts`). The document merges per path, so:

- a dialog's draft is rebased whenever its feature changes in the document: values the other person changed and
  this one did not appear in the open dialog and its preview; a value both changed stays this person's, and the
  dialog says whose value Done will replace and offers theirs;
- a feature deleted under an open dialog or sketch, or while an edit to it was on its way (or was made offline),
  is offered back with this person's values ("Put it back": an `ADDED` of the item, for everybody);
- two people in one sketch both draw: entities are separate paths. Two people moving the same point at once: the
  later one wins, and both see it happen.

Do not commit "the draft as it is" from code that keeps a draft: diff against what the document holds now, after
a rebase (`rebase(base, mine, theirs)`), or the other person's edit is undone without a word.

**The session** (`shared/itemdoc/sync.ts`) has two additions for this: `session.taps` (a set of listeners shown
every message for the document before it is handled, and the session's own edits as `local_op`) and
`session.peerList()`. It also recognises an op of its own in the catch-up after a reconnect (the server stored it,
the ack was lost), so that op is not put back on top of what others did after it; `static/tests/mechanical-collab`
runs several sessions against a sequencing server in every delivery order and checks they end on the server's fold.

**The project room** (`platform/doctabs/room.ts`, started by the tabs; `projectRoom()` in `roomapi.ts` for a
bundle) is who is in the project and on which tab. Presence on the server is per document, so every page opens
one more socket, joins the project's first four part studios and assemblies (by id) with it, and says there
which tab the person is on (a document id, `home`, or `bom:<PCB key>`). The room joins the project's own document
first (`project.jproj`, see "Document tabs and the shell"), so every project that has one has a room; an older
project with neither that document, a part studio nor an assembly has none, and nobody is shown on its tabs.
That the project's documents changed is not the room's business: the server says so (the `docs` notice, under
"How a change is committed and synced").

**Comments** (`collab/comments.ts`, `collab/anchor.ts`). A thread's anchor is the platform's `{ kind: "item",
id, label, item }`: `id` is a feature id, or `face:<name>` / `edge:<name>` / `vertex:<name>` with the body id in
`item`. The pin is drawn at the middle of that geometry as it is now, so it follows rebuilds; `x`, `y` carry
the point the thread was started at (micrometres, packed: `packPoint3`), where the pin stays when the geometry
is gone. A name over 300 characters falls back to the feature that made the body. The project's review list
(`/api/projects/{id}/comments`) includes these threads; the electronics editor's Comments pane lists them under
their document but cannot jump to the geometry.

Not done: a thread on a sketch entity or on an assembly instance; mentions; a pin hidden behind the model is
still drawn; the presence of a person on a schematic or board tab is their tab only, not their pointer.

## Document tabs and the shell

A project is a set of **elements**, each one tab: any number of PCBs, part studios and assemblies, after a first
tab, **Home**, that is always there. Everything else in the project is a file: a library, a 3D model, a STEP
file, the sheets of a PCB. The shell is `platform/doctabs` (the tab bar and what both it and Home do),
`platform/projecthome` (Home) and, on the electronics editor's side, `pcb/editor/{dochost,doc,pcbscope}.ts`.

| File | What |
|---|---|
| `platform/doctabs/pcbs.ts` | **Which PCBs a project holds and what each one's editor may see.** Pure. Read it first. |
| `platform/doctabs/elements.ts` | Elements, their order, folders, the rows of Home's tree. Pure. |
| `platform/doctabs/actions.ts` | Create, rename, duplicate, move, delete (with a few seconds to undo), import: the same ones for the bar and for Home. |
| `platform/doctabs/api.ts`, `server/src/shell.rs` | The requests, and the routes that answer them. |
| `platform/doctabs/shell.ts`, `useshell.ts` | The project's own document, live; the project as the React parts read it (`useProjectShell()`). |
| `platform/doctabs/DocTabs.tsx`, `platform/projecthome/ProjectHome.tsx` | The bar (with the tab manager and "+"); Home. |
| `pcb/editor/pcbscope.ts` | The PCB the schematic and board editor is on, and what keeps it inside that PCB. |
| `pcb/parts/bomview.ts` | A PCB's bill of materials as a view. |

### Elements, and what a PCB is

- `domains/registry.ts` lists the document kinds: `docType`, `ext`, `title`, `icon`, `tint`, and for kinds a
  domain's own editor draws, `bundle`, `newName` and `newText`. A new kind of document is an entry there, two
  lines in `server/src/http.rs` (`doc_type_for`, `allowed_file`) and one in `itemdoc.rs` (`is_item_doc`). It then
  has a tab, a row on Home, a place in "+" and in Home's create buttons, with nothing else to write.
  `PCB_ELEMENT` in the same file describes the one kind of element that is more than one document.
- **A PCB is a KiCad project in a folder of its own**: `<name>/<name>.kicad_pro`, `.kicad_sch`, `.kicad_pcb`, its
  other sheets, its `fp-lib-table`, its libraries. Its name is the folder's. The folder is a valid KiCad project
  on disk and in a GitHub repository. `POST /api/projects/{id}/pcbs` makes one; renaming, moving, copying and
  deleting a PCB are folder operations (`/folders/move`, `/duplicate`, `/folders/delete`), and a rename or a
  copy gives the PCB's own three files the new name (`shell.rs` `restem`), so a board is always called what its
  PCB is called wherever boards are listed by file name (the assembly's Insert, a part studio's Board feature
  and board link).
- **A project from before** (KiCad's files at the project's root) is one PCB whose folder is the root. Nothing
  about it changes and nothing is added to it: its editor gets the very document list it always got, it opens on
  its root schematic, and the shell does not offer to rename, move or delete it. More PCBs can be added beside it.
- Which document belongs to which PCB (`pcbsOf`): the PCB whose folder is the longest that contains it. A
  schematic or board outside every PCB folder rides with the project's only PCB, or, when there are several,
  makes a PCB at the root. A part studio, a model or a library outside every PCB folder belongs to none.
- A PCB's `key` is the id of its project file: it survives a rename, and is what the tab order and
  `bom:<key>` are keyed by.

### One PCB at a time: how the editor is kept inside it

The schematic and board editor finds "the" project file, root sheet, board, rules and library tables by
looking through the project's documents, in more than a hundred places, and remembers a good deal per project.
Pairing a schematic with another PCB's board would be silent and serious, so the rule is structural:

- `state.project.docs` (and `state.docs`, and `store.project.docs`) is the **scoped view**: the documents of the
  bound PCB and of no other, with paths relative to its folder, plus what belongs to no PCB at `../…`
  (`scopedDocs`). Inside it, `fp-lib-table` is the PCB's own and `${KIPRJMOD}` is the PCB's folder.
  `state.project.allDocs` is the whole project with real paths: **shell code and other domains read `allDocs`**
  (`DocumentHostContext.docs` is `allDocs`). Document ids are the same in both.
- The editor names files it makes as it sees them. `installPathScope` wraps `fetch` for exactly two requests
  (`POST /api/projects/{id}/docs`, `PATCH /api/docs/{id}`) and puts the folder in front of `path` on the way out
  and takes it off the answer. Shell code sends real paths through `rawFetch()` (`platform/documents/rawfetch.ts`).
  A new project-level request that carries a path needs the same treatment there.
- **One PCB per page.** Opening a document of another PCB than the one this page has bound loads the page again
  at that document (`bindPcb` answers `"reload"`), and so does the bound PCB being renamed under the page.
  Moving between the views of one PCB, or between a PCB and a part studio, an assembly or Home, stays in the
  page. This costs a second when switching PCBs and removes a class of stale-cache bugs; lifting it means
  auditing every per-project cache of the editor.
- The assistant's electronics tools are narrowed the same way (`pcb/mcp/host.ts` `scopeToPcb`): a call names its
  PCB in `document` (`"Motor driver/board"`, or a path as `get_project` lists it); one that names none works on
  the PCB used last and says so in its result (`pcb`, `pcbs`). The other domains' tools see the whole project.
- Server routes that pick a board or schematic for a whole project (`preview.svg`, `first-doc`) only choose a
  picture or a first guess the editor checks; `board-items` takes `?doc=`.

### Tabs

- The bar shows Home, then one tab per element in the project's order. A PCB's tab holds its views:
  **Schematic** (any sheet of it; a caret lists the sheets when there are several), **Board** (one per board),
  **BOM**, and, on the board, **3D** and **Outputs** (the 3D viewer and the fabrication outputs, which are the
  board editor's own dialogs). The views show on the open PCB's tab, and always in a project with one PCB.
- A tab id is what `openDoc` takes, what the address carries (`/p/<project>/edit?doc=<id>`) and what the room
  says: a document id, `home`, or `bom:<PCB key>`. A link to a sheet or board opens its PCB on that view. With
  no `doc`, a project with a PCB at its root opens on that PCB's root schematic and any other project on Home.
- Home and the BOM are opened like documents: `dochost.ts` gives the `cad` view to the editor registered for
  `@home` (`ProjectHome.tsx`) or `@bom` (`bomview.ts`). A view of the shell's own is a `registerDocumentEditor`
  with a doc type that starts with `@` and no bundle.
- Each sheet and board remembers where it was being looked at (`doc.ts` `viewMemo`), for the page's life.
- **The project's own document**, `project.jproj` (type `project_shell`, a JSON item document like a part studio),
  holds what is shared about the shell: `{ id: "tab:<key>", type: "tab", order }` for each tab somebody placed,
  and `{ id: "folder:<uuid>", type: "folder", path }` for a folder that is still empty. A blank project is made
  with it; an older project gets it the first time somebody reorders a tab or makes a folder (`POST …/shell`).
  It is also what the project room joins first, so every project that has it shows who is on which tab.
- Folders are paths. A part studio in `Enclosure/` is `Enclosure/Lid.jpart`; tabs of one folder stand together
  in the bar behind the folder's name. A PCB's own folder is not a folder to put things in.
- Opening a hosted kind: the shell leaves the KiCad document, shows the `cad` view, loads the bundle once, and
  calls the `DocumentEditorFactory` it registered (`platform/documents/host.ts`):

```ts
registerDocumentEditor({
  docTypes: ["part_studio"],
  open(ctx) { /* ctx.el, ctx.project, ctx.doc, ctx.docs, ctx.signedIn, ctx.setConnection, ctx.toast, ctx.openDoc */
    return { close() { … } };
  },
});
```

- The menu bar shows the project name and role in the `cad` view and no KiCad menus. A domain that needs menus
  should get them through an interface on the menu bar, not by importing into `shared/` (see the roadmap).

### Testing the shell

`node static/tests/project-shell.test.js` covers the model: PCBs and the scoped view (including "no PCB's editor
sees another's files"), paths both ways, binding, tab order, Home's tree, what dropped files become.
`cargo test shell` covers the folder routes' planning. `scripts/shell-ui.mjs` is two people in the browser: a
blank project, two PCBs, a part studio and an assembly, an imported KiCad folder, the views of a PCB, **Update PCB
from Schematic in one PCB leaving the other's board alone**, reorder, rename, duplicate, folders, the tab manager,
delete and undo, deep links, and a project from before. Its header says how to start the server for it
(`KC_LIBS_FOOTPRINTS_URL=$PWD/scripts/fixtures/shell-ui/footprints`). `scripts/shell-mcp.mjs` calls the
assistant's tools over `/mcp` in a project with two PCBs: each reads and edits the PCB it names and no other.

### Not done

- Opening another PCB reloads the page (above). Deleting is undone within six seconds or not at all: the server
  deletes a document with its history.
- A PCB at the project's root cannot be renamed, moved, duplicated or deleted from the shell.
- Home's rows are dragged onto folders; tab order is changed in the tab bar, not on Home.
- A project from before has no room (nobody is shown on its tabs) until it has the project's own document, a
  part studio or an assembly.
- The desktop app sees a multi-PCB project as folders of KiCad projects; it has not been taught to pick one.
- GitHub sync carries the folders as they are (paths are paths to it); it has not been run against a project
  with several PCBs.

## Boards (`board/`, `boardlink/`, `../pcb/mech/`)

Two directions, each with its README; what joins them is here.

- **PCB → CAD.** The Board feature (`features/board-reference.ts`) shows a board of the project in a part
  studio as two reference bodies with stable names (`<feature>:front`, `:hole:H1`, `:part:J1:top`, …) under a
  picture of the board as it looks, and follows the board while it is edited. Opening and Standoffs hang off
  those names. [`board/README.md`](board/README.md).
- **CAD → PCB.** A `board-link` item per board says what the model drives on it: the outline, mounting holes,
  keep-outs with height limits. The part studio's page solves the drives into board geometry and stores the
  answer in the link; the board editor writes the items. [`boardlink/README.md`](boardlink/README.md),
  [`../pcb/mech/README.md`](../pcb/mech/README.md).
- **One placement.** A board that is both shown in a part studio and driven by it lies in one place: where its
  Board feature puts it. The link names the feature (`feature: <id>`); its own `plane`, `lift`, `anchor` and
  `rotation` are then not used. The worker takes the frame the feature was built with, and the feature's
  `origin` as the sheet point at that frame's origin (`boardlink/solve.ts`); the answer carries them
  (`solved.frame`, `solved.anchor`, `solved.rotation`), which is what the board editor reads (`placementOf`).
  In the Board panel either way is one step: **Link this board** on a studio that shows the board makes a link
  placed by the feature; **Show the board in the model** on a link without one adds a Board feature exactly
  where the link has the board (the link's plane and lift, its sheet anchor as the feature's origin, the
  opposite turn) and hands the placement to it. A link with no Board feature keeps its own four values.
- **One panel.** "Board" in the right dock lists the boards the studio shows and the board it drives.
- The loop is closed and stable: the tray drives the outline, the outline changes the board, the Board feature
  is rebuilt from the board, the link is solved again and gives the same answer.

## Assemblies (`.jasm`)

[`../assembly/README.md`](../assembly/README.md) is the contract: the document, mates and the solver, sources,
what a tool is handed. In short:

```ts
{ id: "assembly", type: "assembly", units: "mm" }
{ id, type: "instance", name, order, source, transform, fixed?, suppressed?, hidden?, group? }
{ id, type: "mate", mateType: "fastened", name, order, a, b, params, suppressed? }
```

- `source` is `{ kind: "part", docId, body }`, `{ kind: "board", docId }` or `{ kind: "assembly", docId }`
  (`{ kind: "file" }` is carried and has no provider). An instance copies no geometry: the assembly follows the
  source document, live.
- `transform` is twelve numbers, the rows of a 3 × 4 matrix. **The document stores solved placements.**
- A mate ties connector `a` to connector `b`: `{ instance, ref: GeomRef, flip? }`, by the geometry names above.
- **A part studio that holds a Board feature** is built with its board (see "Building a part studio outside its
  page"), so its board bodies can be instanced like any part.
- **A board itself** (`sources/board.ts`) is built by the same code as a Board feature, as a studio of one Board
  feature with id `board` on the Top plane and the sheet's origin as its origin: pieces `board:board` and
  `board:parts`, faces `board:front`, `board:back`, `board:hole:H1`, `board:part:J1:top`. The pieces are ghosts:
  the editor draws the board as it looks (`viewport/boards.ts`) and the solids are there for the pointer, the
  mates and the checks. Insert puts a new one with its middle at the origin.
- **Interference and the bill of materials** (`tools/interference.ts`, `tools/bom.ts`) read the editor's own
  instances, placements, source handles and workers (`assembly.placed()`, `handle.ensureKernel()`), open as
  docked panels (`assembly.showPanel`; the table at the bottom), and mark the instances that clash
  (`scene.setMarked`). Parts and boards are checked exactly; the parts inside a sub-assembly are not yet.

## Running and testing

```sh
cd server
npm ci
npm run check                      # generates the registries, then tsc
npm run build                      # every bundle; the outputs under static/ are committed
node scripts/ci-web-tests.mjs      # all web tests, including the ones below
cargo test --locked && cargo clippy --locked --all-targets
```

Tests, each runnable alone with `node static/tests/<name>.test.js`:

| Test | Covers |
|---|---|
| `itemdoc`, `doctabs` | file format, change rules, order keys, the session against a scripted socket; the tabs |
| `mechanical-doc` | the `.jpart` format, every edit, sketch helpers, region finding, the toolbar's keys |
| `cad-units`, `cad-fields` | the document's units: formatting, what is typed into a field, expressions that keep their unit; what a click means to a listening dialog field |
| `mechanical-kernel` | **the real kernel in node**: sketch → extrude, booleans, names across rebuilds, cache, rollback, errors |
| `mechanical-features`, `mechanical-patterns` | every solid feature; reference geometry, patterns, sweep, loft, variables |
| `mechanical-collab` | presence, the draft's rebase, comment anchors, the project room, the `docs` notice, sessions under concurrent edits |
| `mechanical-board`, `cad-boardlink`, `pcb-mech` | the board reader and its solids; the link, its transform and solver; the board editor's reconciler and check |
| `mechanical-exchange`, `cad-analysis` | import (with its cache) and every export; measure, section, mass, interference, the bill of materials |
| `assembly-doc`, `assembly-solver`, `assembly-model` | the `.jasm` format; every mate and the solver; connectors, an assembly following a rebuilt part |
| `cad-history`, `cad-mcp` | the feature diff and the 3D diff; the assistant's planning and a plan built in the real kernel |
| `cargo test itemdoc`, `itemmerge`, `dockind` | the server's fold, merge rules, and what each document kind answers |

`static/tests/cad-load.js` bundles a module for a node test: `const { load } = require("./cad-load"); const F =
load("domains/mechanical/document/format.ts");`. New test files must be added to the `for t in …` list of the
`test` script in `package.json` to run in CI.

To run the app: Postgres, then

```sh
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db JWT_SECRET=dev PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 \
  KC_DEV_LOGIN=1 cargo run
```

**Browser scripts**, against such a server (Playwright, and `psql` to make their test users; each header says
what it needs):

```sh
E2E_PG_URL=postgres://user:pass@127.0.0.1:5432/db E2E_JWT_SECRET=dev E2E_BASE=http://127.0.0.1:8099 SHOTS=/tmp/shots \
  node scripts/cad-e2e.mjs
```

| Script | What a person does in it |
|---|---|
| **`cad-e2e`** | **the whole story, two people, one project**: a constrained tray, shell, fillet, patterned bosses, the board in the tray, the tray driving the board, an opening following a connector, an assembly with a hinged lid and the board, interference, the bill of materials, measure, versions compared, STEP. Run it after any change that crosses folders. |
| `cad-ui` | tabs, sketch, extrude, picking, two people editing, rollback, the stored file |
| `cad-ux-ui` | **how it feels**: planes labelled and hidden, the toolbar following the mode, the tool search, units and typed conversions, a fillet's field that keeps adding, dialogs that stay put, the feature list, the view cube, box selection, the menus (with `SHOTS`: light and dark, 1500 and 1100 px) |
| `cad-sketch-ui` | the sketcher: every tool, constraints, dimensions, conflicts |
| `cad-features-ui`, `cad-patterns-ui` | the solid features; reference geometry, patterns, sweep, variables |
| `cad-collab-ui` | presence, Follow, two people in one dialog, the live tab list, comments (`ONLY=tabs,comments`) |
| `cad-board-ui`, `cad-boardlink-ui` | a board in a part studio following the board editor; a part studio driving a board |
| `cad-assembly-ui`, `cad-analysis-ui`, `cad-exchange-ui` | assemblies and mates; inspection, interference, the bill of materials; import and export |
| `cad-history-ui`, `cad-history-mcp`, `cad-history-github` | history, compare, branches; the assistant's tools over `/mcp`; GitHub sync against `scripts/fake-github.mjs` |

`scripts/cad-chrome.mjs` is what they share about the chrome (`tool`, `toolTitles`, `toolbarMode`, `openPanel`,
`viewFrom`, `sketchOn`); `scripts/cad-ux-lib.mjs` has signing in, a new part studio, and where a named face or
edge is on screen. Each script makes its own users (distinct `github_id`s: give a new script its own range; two
scripts with one id see each other's user and fail in ways that look like presence bugs).

The server embeds the browser bundles when it is compiled, so a change under `server/web` does not show in a
server that is already built: `npm run build`, then `cargo build`. While working, `scripts/cad-static-proxy.mjs`
stands in front of a built server and answers the bundle requests from `server/static` on disk: start the
server on another port with `PUBLIC_URL` set to the proxy's address, then `PORT=8099
UPSTREAM=http://127.0.0.1:18099 node scripts/cad-static-proxy.mjs` and point the browser or the scripts at it.

With `KC_DEV_LOGIN=1`, `/auth/dev?jwt=<token>&next=/` signs a browser in with a JWT signed by `JWT_SECRET`
(`{ sub: <users.id>, login, iat, exp }`, HS256); insert the user row first. In a browser test, wait on
`window.JunctionPartStudio.getState()` (for example `kernel.state === "ready"`) rather than on timers, and
start Chromium with `--use-gl=swiftshader --enable-unsafe-swiftshader` when there is no GPU.

## Reference geometry, patterns and variables

Features `plane`, `axis`, `point` and `helix` make **datums**: reference geometry kept in the model
(`ModelState.datums`, by feature id), sent to the page as `RegenResult.datums` (`DatumView`: a plane's frame,
centre and size; an axis' origin, direction and length; a point; a curve as a polyline), drawn and picked by
`viewport/datums.ts` as `Pick { kind: "datum", featureId, datum }`.

- A sketch can lie on a reference plane: `PlaneRef` has a third member `{ kind: "datum", feature }`, and
  `frameOf` resolves it. Selecting a reference plane and pressing Sketch starts one there.
- In `evaluate`: `ctx.datum(id)`, `ctx.setDatum(d)`, and `ctx.history(id)`, the model just before and just after
  an earlier feature (what patterns and mirrors read).
- A `refs` field may also take `datums: ["plane" | "axis" | "point" | "curve"]`, `planes: true` (the default
  planes, also offered as buttons) and `sketch: true` (sketch curves). Those picks are stored as the `RefTarget`s
  of `features/_refs.ts`: `{ kind: "plane", plane }`, `{ kind: "datum", feature }`, `{ kind: "sketch", feature,
  entity }`, besides GeomRefs. `kernel/ops/ref-geom.ts` turns any of them into a plane, axis, point or curve.
  A straight edge's or a cylinder's direction is made canonical (its largest component positive), because the
  kernel may reverse an edge on a rebuild.
- A `features` field stores earlier feature ids in the order picked (`types` / `exclude` filter the list).

**Patterns and Mirror** (`linear-pattern`, `circular-pattern`, `mirror`; `kernel/ops/pattern-core.ts`) copy
bodies, or what earlier features did: the seed's effect on each body is read from `ctx.history` as two tools,
removed (before − after) and added (after − before); every copy is that tool moved, and all copies go into one
cut and one fuse per body. A seed that made a body has the body copied. A copy's faces are named
`<pattern id>:<key>:<seed face name>`, the key naming the copy by its place: `i<n>.<m>` (n-th along the first
direction, m-th along the second, the seed is `i1.1`; a circular pattern uses `i<n>.1`), `m` for a mirror.
Exact for features whose effect does not depend on where they are; a copy of, say, a fillet keeps the seed's
shape. **Sweep** and **Loft** name faces `<id>:start…`, `<id>:end…`, `<id>:side:<sketch entity>`.

**Units** (`document/units.ts`; `studio.getState().units`; the control at the right of the status bar). The
studio item's `units`, `angleUnits` and `precision` say how the document is read and written, for everybody
working on it; the model stays millimetres and degrees, and changing them moves nothing. Everything that writes
a number for a person formats through `units.ts` (`formatLength`, `formatAngle`, `formatArea`, `formatVolume`):
dialogs, sketch dimensions (`sketch/dims.ts setSketchUnits`), the measure readout and what it copies, mass
properties (`inspect/measure-format.ts setMeasureUnits`). Everything typed goes through `parseField`: a bare
number is in the document's unit, a unit typed with it wins ("1 in", "25.4 mm", "3/8 in + 2 mm": a unit follows
a whole product), and expressions and variables work as below. The expression reader knows whether a value
carries a unit, so a variable `width = 40 mm` is 40 mm in a document in inches while `n = 4` is a plain number
that takes the unit of the field it is used in. A stored expression records the unit its bare numbers were
typed in, `params.$unit = { <key>: "in" }` (absent: mm, degrees), so changing the document's units never
changes a size; a sketch dimension's `expr` and a variable's are read in the document's units as they are now.

**Variables** are items `{ id, type: "variable", name, expr, order }` (`document/variables.ts`, the Variables
panel). A number field accepts an expression; the feature keeps the number and the text under
`params.$expr = { <key>: "<text>" }`. The page evaluates every `$expr` again before each regeneration
(`resolveInputs`, in `studio.ts`), and editing a variable rewrites the stored numbers that depend on it in the same
change. A reader of a `.jpart` that does not know variables sees plain numbers. Everything else that builds a part
studio applies them through `studioInputs` (see "Building a part studio outside its page").

**Import** (`features/import-file.ts`, the Import tool, "+" › Open STEP file…) reads a STEP or BREP file stored
with the project into real bodies; faces are named `<feature>:s<solid>:f<face>` by their place in the file.
What was read is kept in the browser as BREP (`kernel/ops/exchange-cache.ts`, IndexedDB, keyed by the file's
document id, size and path; the newest six): the next evaluation in that browser reads the BREP back and does
not download the file. Measured on the 4.4 MB, 22-part demo STEP in Chromium (software WebGL, a busy machine;
`scripts/cad-exchange-ui.mjs` prints it): the Import feature 7.6 s reading the file, 0.5 s from the kept B-rep;
from page load to the model on screen 14.4 s and 7.0 s.

## Limits, in one place

- **Sketcher.** No ellipse, spline or text. Use edge takes straight and circular edges, and what it draws does
  not follow the model afterwards (the source is recorded as `from`). A sketch cannot use a feature that comes
  after it in the tree: to project a board's outline, the Board feature must come first.
- **Regions** come from the curves as drawn: a region id may change when the curves around it are redrawn, and a
  feature that listed it then says its regions are gone.
- **Solid features.** Not done: up to face with an offset, up to a vertex or body; a fillet with a variable
  radius or one that stops tangent propagation; hole threads (a tapped hole is its tap drill); thicken and
  offset face. "Up to face" on a curved face stops at that face's body. Revolve's axis is a loose line of its
  sketch, the sketch's X or Y, or anything picked: an edge, a line of any sketch, a reference axis.
- **Patterns** copy what a feature did, moved; a copy of a feature whose shape depends on where it is (a fillet
  meeting other geometry) keeps the seed's shape.
- **Geometry names** have the limits listed under "Geometry names".
- **One kernel thread per worker, no cancellation.** A long evaluation blocks the next; the page stays responsive.
- **Meshes** are per body, not per view: a small hole on a large part with hundreds of faces is an octagon when
  zoomed into (see "Meshes"); there is no refinement on zoom.
- **Kernel memory** is released per cached feature; a very long session on a very large model has not been profiled.
- **Import.** The cache is per browser: every collaborator's browser reads a file once. A file replaced under
  the same document id and size would be served from the cache; uploads never do that. Reading a large STEP for
  the first time is as slow as it was (the 24 MB module of the demos took about a minute and a half to first
  draw before the cache existed; with it only the first read in a browser pays that, and that file has not been
  timed again).
- **Boards.** See the READMEs. Here: a board is not part of a version (an earlier version shows the board as it
  is now); outside the studio's own page part envelopes come from the footprints, not the 3D models, so a tall
  connector's box may differ slightly between an assembly and the studio (names do not); a board lying parts
  side down can be shown but the height limits of a link assume the front faces away from the plane.
- **Assemblies.** See the README. Here: the parts inside a sub-assembly are not checked for interference; a
  board inserted before it has been read is placed at the sheet's origin, not its middle; no earlier version on
  screen, no Compare, no MCP tools, no thumbnail.
- **Collaboration.** Edits merge per path, last writer wins; two direct commits to one parameter: the later one
  wins, silently. No lock on a feature someone else has open, by design. Not done: a thread on a sketch entity
  or an assembly instance; mentions; a pin hidden behind the model is still drawn. Who is on which tab is only
  shown in projects that have the project's own document (every project made blank, and any project once a tab
  was reordered or a folder made), a part studio or an assembly.
- **Merging** keeps the journal's rule that a delete beats a modify: a conflict "removed here, changed there"
  resolved for the changed side keeps the item only on the side that still has it. Arrays merge as one value.
- **The assistant's picture** (`cad_render_view`) is a software render: flat shading, no sketches or planes.
- **Bundles:** `mechanical.js` and `assembly.js` each bundle three.js and React, loaded on demand. Sharing them
  with `viewer3d.js` and `ui.js` is not done.
- **Windows narrower than about 1000 px:** the toolbar scrolls sideways; the docks fold by hand, not by
  themselves; nothing is laid out for phones.
- **The part studio's interface, not done:** folders in the feature list; renaming a part (its name is the
  kernel's); lists of surfaces and curves (there are no surface bodies); undo and redo do not bring back the
  selection or an open dialog; the mouse buttons cannot be remapped; the kernel's download shows a spinner, not
  how far it is; a plane's name is drawn over the model when its corner is behind it; inference lines cannot be
  turned off (constraint marks can); a sketch dimension's expression with bare numbers, and a variable's, follow
  the document's units when those change (a feature's number field does not: it records its unit); the section
  view's offset field is in millimetres whatever the units; the highlight of what a dialog's fields hold cannot
  be had for a feature that is suppressed or failed before it was built.
