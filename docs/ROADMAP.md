# Roadmap

**Goal:** one collaborative system for designing physical products end to end. That means electronics,
mechanical CAD, assemblies, physics simulation, chip design, robotics simulation and manufacturing (CAM). It runs
in the browser with Figma-style live collaboration, and as a desktop app.

**Today:** Junction does electronics (schematic and PCB), in the browser and in a native desktop app built on
KiCad, with live collaboration, version history, review, GitHub sync and an MCP server for AI assistants. See
[ARCHITECTURE.md](ARCHITECTURE.md) for how the code is laid out.

Phases are in order. Each ends when its "done when" holds, not on a date. Within a phase, items can run in
parallel.

---

## Phase 0: Foundation (in progress)

Make the repository ready to hold more than one domain without slowing down electronics.

- [x] Split the browser app into `shared/`, `platform/` and `domains/pcb/`, with a folder and README for every
      planned domain (`server/web/domains/registry.ts`).
- [x] CI on every pull request: web type-check, build and tests, Rust build, tests and clippy, harness tests,
      workflow lint, and a desktop build when C++ changes.
- [x] Remove KiCad leftovers that nothing builds or ships, and keep them removed through the upstream sync.
- [ ] Work down `static/tests/known-failures.txt` to empty, then make `cargo fmt` and clippy warnings fail CI.
- [ ] Stop `shared/` and `platform/` importing from `domains/pcb` (the menu bar, toolbars and docks are KiCad's
      today). The chrome gets its menus, toolbars and panels from the active domain through an interface.
- [ ] Split the Rust crate into `platform` and `domains/pcb` modules behind a document interface (see below).

**Done when** a new domain can be added as a folder under `server/web/domains` and a module in the server
without editing the electronics code.

## Phase 1: A domain-neutral platform

Collaboration, history and sharing work today because the server understands KiCad's s-expressions item by item
(`merge.rs`, `versions.rs`, `compact.rs`). Every new domain needs the same features, so they have to be built
once against an interface instead of once per file format.

- **Document interface.** Each domain tells the platform how to split its documents into items with stable ids,
  apply a change, diff two versions, merge three, and draw a thumbnail. KiCad's current code becomes the first
  implementation. Decide whether new domains keep this item-sync model or use a CRDT (Yjs or Automerge) for their
  own documents. Recommendation: keep one change protocol on the wire and let each domain's document type choose.
- **Projects hold many kinds of documents.** A project holds any number of PCBs (each a schematic and a board,
  a KiCad project in a folder of its own), part studios and assemblies, as tabs after a Home tab that lists
  everything (`server/web/platform/doctabs`, `server/web/platform/projecthome`,
  `server/web/domains/registry.ts`), and documents follow
  each other live: a board in a part studio, a part studio driving a board, both placed in an assembly. Still to
  do: simulations and toolpaths (a part that a toolpath machines).
- **JSON item documents.** New domains' documents are JSON files of items with stable ids, edited by item
  changes over the existing op path and folded into the stored file by the server (`server/src/itemdoc.rs`,
  `server/web/shared/itemdoc`). Storage, roles, live co-editing, version history, branch merge and comments
  work for them (`server/src/dockind.rs` says how each document kind behaves); Compare, thumbnails and MCP tools
  are per domain, and part studios have them.
- **Compute jobs.** Simulation, meshing, synthesis and toolpath generation are too heavy for a browser tab. Add
  a job queue on the server: a job takes a document version, runs a sandboxed worker and stores the result as a
  version-linked artifact, with progress shown to everyone in the project.
- **Large files.** Meshes, STEP files, GDS layouts and simulation results go to object storage, not Postgres rows.
- **Per-domain AI tools.** The MCP endpoint lists each domain's tools, so an assistant works on an assembly the
  same way it works on a board today.

**Done when** sharing, roles, presence, comments, version history and GitHub sync work for a test document type
that is not KiCad's, with no special cases in the platform.

## Phase 2: Desktop app on Electron

The desktop app today is the native KiCad build. The browser app is the one place every domain will exist, so
the cross-domain desktop app should be the browser app in Electron.

- An Electron shell that loads the browser app, with native menus, file associations, an auto-updater, and
  signed builds for macOS, Windows and Linux (the release workflows already sign and launch-test three platforms).
- Offline work. The server is Rust, so it can run beside the app as a local process, with SQLite in place of
  Postgres, and sync with the hosted server when online.
- Open local files and folders (KiCad projects, STEP) directly.
- Decide what happens to the native KiCad desktop app. Recommendation: keep shipping it for electronics while
  web parity grows (the weekly upstream sync keeps it current). Decide again when the web editor covers what
  people use the native one for.

**Done when** the Electron app is released next to the native one and works offline on a KiCad project.

## Phase 3: Mechanical CAD (`domains/mechanical`)

This comes first because boards need enclosures, and the 3D viewer already ships an OpenCascade build
(`occt-import-js`).

Where it stands: part studios are documents and tabs, with the kernel in a worker and a feature registry with
regeneration and caching. [server/web/domains/mechanical/CONTRACT.md](../server/web/domains/mechanical/CONTRACT.md)
is the contract everything is built against, and lists the limits.

- [x] Sketches with constraints and dimensions (PlaneGCS), then extrude, revolve, sweep, loft, fillet, chamfer,
  draft, shell, hole, booleans, patterns, mirror, reference geometry and variables.
- [x] Live collaboration on the feature tree beyond item sync: presence, Follow, who has which feature open,
  comments pinned to faces.
- [x] STEP and BREP import as a base feature; STEP, STL, 3MF, OBJ, GLB, DXF and SVG export.
- [x] Measure, section view, mass properties, appearance.
- [x] Version history, Compare, branches and merging, thumbnails and AI (MCP) tools for part studios.
- [ ] View a STEP file without importing it; ellipses and splines in sketches; threads; meshes refined on zoom.

**Done when** a team can model a simple enclosure together and export it as STEP: `server/scripts/cad-e2e.mjs`
does this, with two people, in the real app.

## Phase 4: Assemblies (`domains/assembly`)

Where it stands ([server/web/domains/assembly/README.md](../server/web/domains/assembly/README.md)):

- [x] Place parts, sub-assemblies and boards in one scene. A board comes from the electronics domain and follows
  its changes (move a connector on the board and the assembly, and the opening cut for it in a part studio,
  update).
- [x] Mates and joints with a solver, interference and clearance checks, an exploded view, and a combined BOM
  across mechanical and electronic parts.
- [x] Electrical-mechanical links: the board outline, mounting holes and keep-outs with height limits driven
  from the enclosure, a height check in the board editor, connector cut-outs and standoffs driven from the board.
- [ ] An earlier version of an assembly on screen, Compare, thumbnails and AI tools for assemblies; interference
  inside sub-assemblies; screw, gear and rack relations; STEP files placed directly.

**Done when** a board and its enclosure stay in step as either one changes: they do, both ways
(`server/scripts/cad-e2e.mjs`).

## Phase 5: Manufacturing and CAM (`domains/manufacturing`)

- 2.5D milling (pocket, profile, drill, engrave) for flat parts and board outlines, with a tool library and
  material-removal preview, written as G-code for common controllers.
- 3D-print slicing, run as a server job (for example CuraEngine as a separate process).
- Setup sheets, and a manufacturing pack for each project. The electronics domain's Gerber, drill, placement and
  BOM export already exists and stays in the electronics domain.

**Done when** a part designed in phase 3 can be machined from Junction's output.

## Phase 6: Physics simulation (`domains/physics`)

- Thermal analysis of a board first: copper and power dissipation are already known.
- Static structural and thermal analysis of parts and assemblies: meshing with Gmsh, solving with an FEM solver
  such as Elmer or CalculiX as server jobs, results drawn in the 3D view.
- Rigid-body dynamics for assemblies (Rapier or MuJoCo in the browser).

**Done when** a team can load an assembly, run a structural study and comment on the results together.

## Phase 7: Robotics simulation (`domains/robotics`)

- A robot built from an assembly, with joints, actuators and sensors. Import and export URDF and MJCF.
- MuJoCo (WebAssembly) simulation in the browser, with controllers written in Python in the runtime the harness
  already uses.
- Electronics in the loop: the board's power budget and sensor wiring checked against the robot's actuators and
  sensors.

**Done when** a robot designed in Junction can be simulated walking, rolling or grasping in the browser.

## Phase 8: IC and chip design (`domains/silicon`)

This is last because it shares the least with the other domains and needs the most compute.

- Verilog editing with simulation (Icarus Verilog or Verilator as server jobs), waveforms in the browser.
- RTL-to-GDS on open PDKs (SkyWater SKY130, GF180) with Yosys and OpenROAD as server jobs. Layout view and DRC
  and LVS results in the browser.
- The electronics domain uses the chip's pinout and package: a custom chip gets a symbol and footprint.

**Done when** a small design goes from Verilog to a GDS that passes DRC, made and reviewed together in Junction.

---

## Throughout

- **Licences.** Junction is GPLv3. Check every engine and library before it is added. Run AGPL tools only as
  separate server processes.
- **Performance budget.** Every domain's editor opens a typical document in the browser within the time the
  electronics editor takes today. CI should measure this.
- **Tests.** Each domain lands with tests in CI from its first commit.
- **The upstream KiCad sync keeps running.** None of this may move or rename the C++ tree (see
  [ARCHITECTURE.md](ARCHITECTURE.md)).

## Open decisions

| Decision | Options | Leaning |
|---|---|---|
| Sync model for new domains | Extend KiCad's item sync to all domains / CRDT per domain behind one protocol | Decided for mechanical and assembly: the item sync, with JSON items and last-writer-wins per path |
| Native KiCad desktop app long term | Keep it / retire it for Electron | Keep it until the web editor reaches parity |
| Where heavy compute runs | Hosted workers / the user's own machine (Electron) / both | Both, with the same job interface |
| Geometry kernel | OpenCascade (WASM) / a newer kernel | Decided: OpenCascade, through npm `replicad-opencascadejs` (LGPL-2.1) |
