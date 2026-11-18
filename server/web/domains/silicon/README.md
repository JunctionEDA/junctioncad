# IC and chip design

Status: **planned**. This folder is the place for this domain's web code. Nothing is here yet, and nothing in the
build depends on it.

**Scope.** RTL entry and simulation, synthesis, floorplanning, place and route, layout and sign-off checks on open process design kits.

**First milestone.** Edit Verilog, simulate it, and run synthesis on the server, with the results shown beside the source.

**Candidate engines.** Yosys (ISC), OpenROAD (BSD), Magic (BSD-style), KLayout (GPL), Verilator (LGPL/Artistic) and Icarus Verilog (GPL), with SkyWater SKY130 or GF180 PDKs. Check every library's licence against Junction's GPLv3 before it is added.

**What it gets from the platform.** Projects, sharing and roles, live presence, comments, version history,
GitHub sync and the AI (MCP) connection come from `server/web/platform` and `server/web/shared`, so a domain's
editor only has to supply its documents, its view and its tools. Its entry in
[`../registry.ts`](../registry.ts) says which files it opens and which other domains it reads.

See [docs/ROADMAP.md](../../../../docs/ROADMAP.md) for the order these are built in.
