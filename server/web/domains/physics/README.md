# Physics simulation

Status: **planned**. This folder is the place for this domain's web code. Nothing is here yet, and nothing in the
build depends on it.

**Scope.** Structural and thermal analysis (finite elements) of parts and assemblies, and rigid-body dynamics.

**First milestone.** Steady-state thermal analysis of a board, using the copper and component power the electronics domain already knows.

**Candidate engines.** Gmsh (GPL) for meshing; an FEM solver such as Elmer or CalculiX (GPL) run on the server; Rapier or MuJoCo (Apache 2.0) for rigid bodies. Check every library's licence against Junction's GPLv3 before it is added.

**What it gets from the platform.** Projects, sharing and roles, live presence, comments, version history,
GitHub sync and the AI (MCP) connection come from `server/web/platform` and `server/web/shared`, so a domain's
editor only has to supply its documents, its view and its tools. Its entry in
[`../registry.ts`](../registry.ts) says which files it opens and which other domains it reads.

See [docs/ROADMAP.md](../../../../docs/ROADMAP.md) for the order these are built in.
