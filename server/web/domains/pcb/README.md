# Electronics (schematic and PCB)

Status: **shipped**. This is the web editor for KiCad projects: the schematic, symbol, board and footprint
editors and everything they use.

| Folder | What it holds |
|---|---|
| `canvas/` | Document model, parsing and drawing of schematics and boards (bundled as `static/kicad-canvas.js`) |
| `editor/` | The editor core: boot, document sync, selection, panels, board dialogs (`static/dist/editor.js`) |
| `tools/` | Schematic and board tools, KiCad dialogs and the properties panel (`static/sch-tools.js`, `pcb-tools.js`, …) |
| `dialogs/` | Dialogs shared by both editors |
| `symedit/`, `symview/` | Symbol editor and symbol viewer |
| `library/`, `parts/` | Library tables, choosers and vendor part search |
| `router/` | Autorouter and placement |
| `fab/` | Gerber, drill, placement, BOM, IPC-2581 and ODB++ writers |
| `viewer3d/` | 3D board viewer |
| `sim/`, `plugins/` | SPICE simulation, KiCad plugins and the Python runtime |
| `ai/`, `mcp/`, `harness/` | Design assistant tools, the headless editor behind the MCP endpoint, and the Python harness engine |
| `calculator/`, `importgfx/` | The PCB calculator and graphics import |
| `generated/` | Tables generated from the C++ sources by `server/scripts/gen_*.py`. Do not edit by hand |
| `*.ts` | KiCad action, menu and icon tables used by the app chrome |

The desktop app for this domain is the C++ tree at the repository root (`eeschema/`, `pcbnew/`, `common/`, …).
It stays where KiCad keeps it so the weekly upstream merge keeps working. See
[docs/ARCHITECTURE.md](../../../../docs/ARCHITECTURE.md).

Note: Tailwind scans `*.ts` at the top of this folder (`shared/styles/tailwind.css`). Put new files in a
subfolder.
