# Architecture

Junction has three programs in one repository:

| Program | Where | Language | What it is |
|---|---|---|---|
| Desktop app | the KiCad tree at the root | C++ (wxWidgets) | KiCad plus live collaboration (`common/collab`, `eeschema/collab`, `pcbnew/collab`) |
| Server | `server/src`, `server/protocol`, `server/migrations` | Rust (axum, Postgres) | Projects, accounts, sharing, the collaboration socket, version history, GitHub sync, the MCP endpoint |
| Browser app | `server/web`, built into `server/static` | TypeScript, React | The home page and project list, and the web editors |

They share one document model: files made of items with stable ids, synchronized item by item over the
collaboration protocol (`server/protocol`, [COLLABORATION.md](../COLLABORATION.md)). KiCad's own files are
one kind; part studios (`.jpart`) and assemblies (`.jasm`) are JSON item documents (`server/src/itemdoc.rs`,
`server/web/shared/itemdoc`) on the same path. A project's documents are tabs in the browser.

## Platform and domains

Junction is meant to cover more than electronics (see [ROADMAP.md](ROADMAP.md)). The code is split into
**platform** (what every kind of project shares) and **domains** (one per kind of design work).

| | Platform | Electronics domain (`pcb`) | Future domains |
|---|---|---|---|
| Browser | `server/web/platform` (home, sharing, the project shell (Home tab and document tabs), landing, onboarding, GitHub, review, time tracking, admin) and `server/web/shared` (UI kit, store, theme, styles, JSON item documents, the 3D viewport) | `server/web/domains/pcb` | `server/web/domains/mechanical` (part studios, in progress: see its `CONTRACT.md`), `assembly` (a stub), and `{physics,silicon,robotics,manufacturing}` with a README each and no code yet |
| Server | see the table below | see the table below | |
| Desktop | `common/` (with `common/collab`) | `eeschema/`, `pcbnew/`, `cvpcb/`, `gerbview/`, `pagelayout_editor/`, `pcb_calculator/`, `3d-viewer/` | |

`server/web/domains/registry.ts` lists the domains, the files each opens and the domains each reads.
`server/web/README.md` has the rules for imports between the areas.

### Server modules

The Rust server is one crate and has not been split into folders. This is which module belongs where:

| Platform | Electronics-specific |
|---|---|
| `main`, `http`, `pages`, `ws`, `relay`, `presence_lane`, `doc_actor`, `persist`, `error`, `lenient_json`, `itemdoc` and `itemmerge` (JSON item documents and their three-way merge), `dockind` (how each document type behaves for history, merging, folding and thumbnails) | `kicadlib`, `libs`, `projectlibs` (KiCad libraries) |
| `auth`, `oauth`, `access` (accounts, sign-in, roles) | `parts/`, `datasheet` (vendor parts, datasheets) |
| `versions`, `proposals`, `github`, `github/`, `github_app` | `merge`, `compact` (KiCad s-expression merge and journal folding) |
| `mcp` (the MCP endpoint), `admin`, `timetrack`, `exports`, `plugins`, `registry` | `ai`, `mcp_host`, `pcm`, `fonts`, `templates` |

Splitting it into `src/platform` and `src/domains/pcb` is a roadmap item. `merge`, `versions` and `compact`
understand KiCad's s-expressions directly, so the split starts with putting a per-domain document interface
in front of them.

## Why the C++ tree stays where KiCad keeps it

Every Monday `.github/workflows/upstream-sync.yml` merges KiCad's master into Junction's master
([tools/upstream-sync](../tools/upstream-sync/README.md)). Junction stays current with KiCad only because that
merge is mostly automatic. Moving `pcbnew/` or `eeschema/` under a new folder would turn every upstream change to
those files into a rename conflict, and the top-level `CMakeLists.txt` would conflict every week. So the desktop
code keeps KiCad's layout:

- Put new desktop behaviour in new files (as `*/collab/` does) and small hooks, not edits spread through
  KiCad's files.
- To delete a file KiCad has upstream, also add it to `tools/upstream-sync/ours.txt`. Otherwise the merge brings
  it back.
- `.github/`, the root Markdown files and other Junction-owned paths are in `ours.txt` too, so upstream changes
  to them are dropped.

## Build outputs

- `server/static/*.js` and `server/static/dist/*` are built by `npm run build` from `server/web` and committed,
  so `cargo run` works without Node. CI checks that they match the source.
- `server/web/domains/pcb/generated/*` is generated from the C++ sources by `server/scripts/gen_*.py`. The weekly
  sync regenerates it (`tools/upstream-sync/regen_web.sh`).
- `static/dist/mechanical.js`, `assembly.js` and `cad-worker.js` are the part studio editor, the assembly editor
  and the modelling worker, loaded when such a tab is first opened. The kernel's `.wasm` is copied to
  `static/dist/pyodide` by the build and is not committed.

## Checks

`.github/workflows/ci.yml` runs on every pull request and every push to master. It type-checks, builds and tests
the browser app, builds and tests the Rust server, runs the Python harness tests and lints the workflows. When a
pull request touches the C++ tree it also builds the desktop app on Linux. Releases (`release.yml`) and the
upstream sync have their own workflows.
