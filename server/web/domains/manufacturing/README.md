# Manufacturing and CAM

Status: **planned**. This folder is the place for this domain's web code. Nothing is here yet, and nothing in the
build depends on it.

**Scope.** Toolpaths for milling, turning and cutting, slicing for 3D printing, tool libraries, simulation of material removal and setup sheets.

**First milestone.** 2.5D milling toolpaths (pocket, profile, drill) for a board outline or a flat part, written as G-code. The electronics domain's existing fabrication outputs (Gerber, drill, placement) stay where they are.

**Candidate engines.** OpenCAMLib (LGPL) for toolpath algorithms; CuraEngine (AGPL, run as a separate server process) or a similar slicer for printing. Check every library's licence against Junction's GPLv3 before it is added.

**What it gets from the platform.** Projects, sharing and roles, live presence, comments, version history,
GitHub sync and the AI (MCP) connection come from `server/web/platform` and `server/web/shared`, so a domain's
editor only has to supply its documents, its view and its tools. Its entry in
[`../registry.ts`](../registry.ts) says which files it opens and which other domains it reads.

See [docs/ROADMAP.md](../../../../docs/ROADMAP.md) for the order these are built in.
