# Robotics simulation

Status: **planned**. This folder is the place for this domain's web code. Nothing is here yet, and nothing in the
build depends on it.

**Scope.** Robots described from assemblies, with joints, actuators, sensors and controller code simulated together.

**First milestone.** Import a URDF model and run it in a physics scene in the browser.

**Candidate engines.** MuJoCo (Apache 2.0, has a WebAssembly build) for dynamics; URDF/MJCF import; controllers in the Python runtime the harness already uses. Check every library's licence against Junction's GPLv3 before it is added.

**What it gets from the platform.** Projects, sharing and roles, live presence, comments, version history,
GitHub sync and the AI (MCP) connection come from `server/web/platform` and `server/web/shared`, so a domain's
editor only has to supply its documents, its view and its tools. Its entry in
[`../registry.ts`](../registry.ts) says which files it opens and which other domains it reads.

See [docs/ROADMAP.md](../../../../docs/ROADMAP.md) for the order these are built in.
