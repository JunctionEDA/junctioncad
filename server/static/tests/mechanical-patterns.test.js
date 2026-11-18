// Node test for reference geometry, mirror, patterns, sweep, loft, helix and variables in the part studio
// (web/domains/mechanical/features/{plane,axis,point,mirror,linear-pattern,circular-pattern,sweep,loft,helix}.ts,
// kernel/ops/{ref-*,pattern-*,sweep-*}.ts, document/variables.ts).  The real OpenCascade build runs here.
// Run: node server/static/tests/mechanical-patterns.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const server = path.join(__dirname, "..", "..");
const esbuild = require(path.join(server, "node_modules", "esbuild"));
const { load } = require("./cad-load");

execFileSync(process.execPath, [path.join(server, "scripts", "gen-cad-registry.mjs")]);
const bundle = esbuild.buildSync({ entryPoints: [path.join(server, "web", "domains", "mechanical", "kernel", "index.ts")], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" });
const M = { exports: {} }; new Function("module", "exports", "require", bundle.outputFiles[0].text)(M, M.exports, require);
const K = M.exports;
const V = load("domains/mechanical/document/variables.ts");
const I = load("shared/itemdoc/itemdoc.ts");

let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new K.Kernel(oc);
  return kernel;
}

// ---- document helpers
const rect = (x0, y0, x1, y1, p) => ({
  [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y0 }, [`${p}3`]: { type: "point", x: x1, y: y1 }, [`${p}4`]: { type: "point", x: x0, y: y1 },
  [`${p}a`]: { type: "line", a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: "line", a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: "line", a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: "line", a: `${p}4`, b: `${p}1` },
});
const circle = (x, y, r, p) => ({ [`${p}c`]: { type: "point", x, y }, [`${p}`]: { type: "circle", center: `${p}c`, r } });
const top = { kind: "plane", plane: "top" }, front = { kind: "plane", plane: "front" }, right = { kind: "plane", plane: "right" };
const sketch = (id, entities, plane = top) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, o = {}) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });
const feature = (id, type, params) => ({ id, type, name: id, suppressed: false, params });
const datum = (feature) => ({ kind: "datum", feature });

/** A 100 × 60 × 5 plate with one Ø6 hole at (10, 10), cut by its own extrude. */
const plate = () => [
  sketch("s1", rect(0, 0, 100, 60, "p")), extrude("e1", "s1", { depth: 5 }),
  sketch("s2", circle(10, 10, 3, "h"), top), extrude("cut", "s2", { operation: "remove", depth: 5 }),
];
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const statuses = (r) => r.features.map((f) => `${f.id}:${f.status}${f.message ? " (" + f.message + ")" : ""}`);
const allOk = (r) => assert.ok(r.features.every((f) => f.status === "ok"), statuses(r).join("\n"));
const vol = (k, e, id) => k.volume((id ? e.state.bodies.find((b) => b.id === id) : e.state.bodies[0]).shape);
const HOLE = Math.PI * 9 * 5;

async function run(features) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(features, features.length);
  return { k, engine, r };
}

test("the new features are registered", () => {
  const types = K.FEATURES.map((f) => f.type);
  for (const t of ["plane", "axis", "point", "mirror", "linear-pattern", "circular-pattern", "sweep", "loft", "helix"]) assert.ok(types.includes(t), t);
});

// ---------------------------------------------------------------- reference geometry

test("a plane offset from Top carries a sketch: the extrusion starts at the offset", async () => {
  const { k, engine, r } = await run([
    feature("pl", "plane", { method: "offset", ref: top, distance: 15, flip: false }),
    sketch("s", rect(0, 0, 10, 10, "r"), datum("pl")), extrude("e", "s", { depth: 5 }),
  ]);
  allOk(r);
  const d = r.datums.find((x) => x.featureId === "pl");
  assert.equal(d.kind, "plane");
  assert.deepEqual(d.frame.origin, [0, 0, 15]);
  assert.deepEqual(d.frame.normal, [0, 0, 1]);
  assert.deepEqual(r.bodies[0].mesh.bbox.map((v) => Math.round(v * 1e6) / 1e6), [0, 0, 15, 10, 10, 20]);
  near(vol(k, engine), 500);
  assert.equal(r.sketches[0].frame.origin[2], 15);
});

test("a plane offset from a face follows the face when the model changes", async () => {
  const base = (depth) => [sketch("s1", rect(0, 0, 20, 20, "r")), extrude("e1", "s1", { depth }), feature("pl", "plane", { method: "offset", ref: { kind: "face", body: "e1", name: "e1:end:ra" }, distance: 3 })];
  let { r } = await run(base(10));
  allOk(r);
  near(r.datums[0].frame.origin[2], 13);
  near(r.datums[0].centre[0], 10); near(r.datums[0].centre[1], 10);
  ({ r } = await run(base(4)));
  near(r.datums[0].frame.origin[2], 7);
});

test("planes through three points, midway between faces, at an angle, normal to a curve, tangent to a cylinder", async () => {
  const box = [sketch("s1", rect(0, 0, 40, 20, "r")), extrude("e1", "s1", { depth: 10 })];
  const v = (a, b, c) => ({ kind: "vertex", body: "e1", name: `vertex(${[a, b, c].sort().join("|")})` });
  const { r } = await run([
    ...box,
    feature("three", "plane", { method: "points", points: [v("e1:end:ra", "e1:side:ra", "e1:side:rd"), v("e1:end:ra", "e1:side:ra", "e1:side:rb"), v("e1:start:ra", "e1:side:rb", "e1:side:rc")] }),
    feature("mid", "plane", { method: "midplane", faces: [{ kind: "face", body: "e1", name: "e1:side:rd" }, { kind: "face", body: "e1", name: "e1:side:rb" }] }),
    feature("ang", "plane", { method: "angle", ref: top, axis: { kind: "edge", body: "e1", name: "edge(e1:side:ra|e1:start:ra)" }, angle: 90 }),
    sketch("path", { a: { type: "point", x: 0, y: 0 }, b: { type: "point", x: 0, y: 30 }, l: { type: "line", a: "a", b: "b" } }, front),
    feature("nrm", "plane", { method: "normal", curve: { kind: "sketch", feature: "path", entity: "l" }, position: 0.5 }),
    sketch("cs", circle(0, 0, 5, "c")), extrude("cyl", "cs", { depth: 8 }),
    feature("tan", "plane", { method: "tangent", cylinder: { kind: "face", body: "cyl", name: "cyl:side:c" }, angle: 0 }),
  ]);
  allOk(r);
  const by = (id) => r.datums.find((d) => d.featureId === id);
  // three points: (0,0,10), (40,0,10), (40,20,0) — a plane tilted about x
  const n = by("three").frame.normal;
  near(Math.abs(n[0]), 0); near(Math.abs(n[1]), 10 / Math.hypot(10, 20)); near(Math.abs(n[2]), 20 / Math.hypot(10, 20));
  // midway between the faces at x = 0 and x = 40
  near(Math.abs(by("mid").frame.normal[0]), 1); near(by("mid").frame.origin[0], 20);
  // Top turned 90° about the edge along x at y = 0: the Front plane
  near(Math.abs(by("ang").frame.normal[1]), 1); near(by("ang").frame.origin[1], 0);
  // normal to the vertical line in the middle: horizontal, at z = 15
  near(Math.abs(by("nrm").frame.normal[2]), 1); near(by("nrm").frame.origin[2], 15);
  // tangent to the cylinder of radius 5 about z: its normal is radial, 5 from the axis
  const t = by("tan");
  near(t.frame.normal[2], 0); near(Math.hypot(t.frame.origin[0], t.frame.origin[1]), 5);
});

test("axes and points: along an edge, through two points, where planes meet; at a vertex, at coordinates", async () => {
  const { r } = await run([
    sketch("s1", rect(0, 0, 40, 20, "r")), extrude("e1", "s1", { depth: 10 }),
    feature("ax1", "axis", { method: "reference", ref: { kind: "edge", body: "e1", name: "edge(e1:side:ra|e1:side:rb)" } }),
    feature("ax2", "axis", { method: "planes", planes: [front, right] }),
    feature("pt1", "point", { method: "reference", ref: { kind: "vertex", body: "e1", name: "vertex(e1:end:ra|e1:side:ra|e1:side:rb)" }, x: 0, y: 0, z: 5 }),
    feature("pt2", "point", { method: "coordinates", x: 1, y: 2, z: 3 }),
    feature("ax3", "axis", { method: "points", points: [datum("pt1"), datum("pt2")] }),
  ]);
  allOk(r);
  const by = (id) => r.datums.find((d) => d.featureId === id);
  near(Math.abs(by("ax1").dir[2]), 1); near(by("ax1").origin[0], 40); near(by("ax1").origin[2], 5);
  near(Math.abs(by("ax2").dir[2]), 1); near(by("ax2").origin[0], 0); near(by("ax2").origin[1], 0);
  assert.deepEqual(by("pt1").at, [40, 0, 15]);
  assert.deepEqual(by("pt2").at, [1, 2, 3]);
  assert.equal(by("ax3").kind, "axis");
});

test("a sketch on a reference plane that fails reports why", async () => {
  const { r } = await run([sketch("s", rect(0, 0, 10, 10, "r"), datum("nope"))]);
  assert.equal(r.features[0].status, "error");
  assert.match(r.features[0].message, /reference plane/);
});

// ---------------------------------------------------------------- linear and circular patterns

test("a 20 × 20 pattern is meshed for the screen in a fraction of the time a fixed tolerance takes", async () => {
  const k = await boot();
  const top = { kind: "plane", plane: "top" }, right = { kind: "plane", plane: "right" }, front = { kind: "plane", plane: "front" };
  const big = [sketch("s1", rect(0, 0, 200, 200, "r")), extrude("e1", "s1", { depth: 5 }),
    sketch("s2", circle(5, 5, 2, "h"), { kind: "face", ref: { kind: "face", body: "e1", name: "e1:end:ra" } }),
    extrude("cut", "s2", { operation: "remove", depth: 5, flip: true, endType: "throughAll" }),
    feature("lp", "linear-pattern", { of: "features", features: ["cut"], bodies: [], direction: right, spacing: 10, count: 20, flip: false, second: true, direction2: front, spacing2: -10, count2: 20, flip2: false, skip: "" })];
  void top;
  const build = async (quality) => {
    const engine = quality ? new K.RegenEngine(k, K.FEATURES, quality) : new K.RegenEngine(k, K.FEATURES);
    const t0 = Date.now();
    const r = await engine.regenerate(big, big.length, []);
    const total = Date.now() - t0, features = r.features.reduce((n, f) => n + (f.ms || 0), 0);
    const body = engine.state.bodies[0], q = K.qualityFor(k, body), mesh = r.bodies[0].mesh;
    engine.dispose();
    return { total, mesh: Math.round(total - features), triangles: mesh.indices.length / 3, faces: mesh.faces.names.length, status: r.features.map((f) => f.status).join(), q };
  };
  const fixed = await build(K.DEFAULT_QUALITY), now = await build(null);
  assert.equal(now.status, "ok,ok,ok,ok,ok"); assert.equal(now.faces, 406);
  // a 200 mm plate: a chord of 0.14 mm, and the loosest angle for a body of 406 faces
  assert.ok(Math.abs(now.q.linear - Math.hypot(200, 200, 5) * 0.0005) < 1e-9 && now.q.angular === 0.8, JSON.stringify(now.q));
  assert.ok(now.triangles < fixed.triangles / 2 && now.triangles > 406 * 4, `${now.triangles} triangles against ${fixed.triangles}`);
  assert.ok(now.mesh < fixed.mesh, `meshing ${now.mesh} ms against ${fixed.mesh} ms`);
  console.log(`      (400 holes: the rebuild ${fixed.total} ms with a fixed 0.05 mm / 0.3 rad, of which meshing ${fixed.mesh} ms and ${fixed.triangles} triangles; ${now.total} ms now, meshing ${now.mesh} ms and ${now.triangles} triangles)`);
  // a small part keeps the fine mesh: a 20 mm block with one hole
  const small = new K.RegenEngine(k, K.FEATURES);
  await small.regenerate([sketch("s1", { ...rect(0, 0, 20, 20, "r"), ...circle(10, 10, 2, "h") }), extrude("e1", "s1", { depth: 5 })], 2, []);
  const sq = K.qualityFor(k, small.state.bodies[0]);
  assert.ok(sq.angular === 0.3 && sq.linear < 0.02 && sq.linear >= 0.01, JSON.stringify(sq));
  small.dispose();
});

test("a 5 × 3 grid of a hole: one plate, fourteen more holes, every copy's faces named by its place", async () => {
  const t0 = Date.now();
  const { k, engine, r } = await run([...plate(), feature("lp", "linear-pattern", {
    of: "features", features: ["cut"], bodies: [], merge: false,
    direction: { kind: "edge", body: "e1", name: "edge(e1:end:pa|e1:side:pa)" }, spacing: 20, count: 5, flip: false,
    second: true, direction2: { kind: "edge", body: "e1", name: "edge(e1:end:pa|e1:side:pb)" }, spacing2: 20, count2: 3, flip2: false, skip: "",
  })]);
  allOk(r);
  assert.equal(r.bodies.length, 1);
  near(vol(k, engine), 100 * 60 * 5 - 15 * HOLE, 1e-6);
  const names = engine.state.bodies[0].topo.faces.map((f) => f.name);
  assert.equal(new Set(names).size, names.length, "face names are unique");
  assert.ok(names.includes("cut:side:h"), "the original hole keeps its name");
  assert.ok(names.includes("lp:i2.1:cut:side:h"), "the copy beside it");
  assert.ok(names.includes("lp:i5.3:cut:side:h"), "the far corner");
  assert.equal(names.filter((n) => /^lp:i\d\.\d:cut:side:h$/.test(n)).length, 14);
  const ms = Date.now() - t0;
  assert.ok(ms < 20000, `took ${ms} ms`);
});

test("skipped copies are left out, and a copy keeps its name when the count changes", async () => {
  const lp = (count, skip) => feature("lp", "linear-pattern", { of: "features", features: ["cut"], bodies: [], direction: right, spacing: 15, count, flip: false, second: false, skip });
  let { k, engine, r } = await run([...plate(), lp(4, "3")]);
  allOk(r);
  near(vol(k, engine), 100 * 60 * 5 - 3 * HOLE, 1e-6);
  let names = engine.state.bodies[0].topo.faces.map((f) => f.name);
  assert.ok(names.includes("lp:i2.1:cut:side:h") && names.includes("lp:i4.1:cut:side:h") && !names.includes("lp:i3.1:cut:side:h"));
  // where the second copy is does not depend on how many there are
  const at = (e) => k.centre(e.state.bodies[0].topo.faces.find((f) => f.name === "lp:i2.1:cut:side:h").shape, "face");
  const before = at(engine);
  ({ k, engine, r } = await run([...plate(), lp(6, "")]));
  allOk(r);
  near(vol(k, engine), 100 * 60 * 5 - 6 * HOLE, 1e-6);
  assert.deepEqual(at(engine).map((v) => Math.round(v * 1e6)), before.map((v) => Math.round(v * 1e6)));
});

test("a pattern regenerates from the pattern when the seed changes, and a later feature can refer to a copy", async () => {
  const lp = feature("lp", "linear-pattern", { of: "features", features: ["cut"], bodies: [], direction: right, spacing: 15, count: 3, flip: false, second: false, skip: "" });
  const pl = feature("pl", "plane", { method: "offset", ref: { kind: "face", body: "e1", name: "lp:i3.1:cut:side:h" }, distance: 0 });
  // a plane on a hole's wall is no plane: the copy's face resolves, and the plane says it needs a flat face
  const { r } = await run([...plate(), lp, pl]);
  assert.equal(r.features[5].status, "error");
  assert.match(r.features[5].message, /flat face/);
  const ax = feature("ax", "axis", { method: "reference", ref: { kind: "face", body: "e1", name: "lp:i3.1:cut:side:h" } });
  const r2 = (await run([...plate(), lp, ax])).r;
  allOk(r2);
  const a = r2.datums[0];
  near(a.origin[0], 40); near(a.origin[1], 10);   // the third hole, at x = 10 + 2 × 15
});

test("a circular pattern of a hole about a datum axis; equal spacing over part of a turn", async () => {
  const disc = [sketch("s1", circle(0, 0, 30, "d")), extrude("e1", "s1", { depth: 5 }), sketch("s2", circle(20, 0, 3, "h")), extrude("cut", "s2", { operation: "remove", depth: 5 }),
    feature("ax", "axis", { method: "reference", ref: { kind: "face", body: "e1", name: "e1:side:d" } })];
  const cp = (o) => feature("cp", "circular-pattern", { of: "features", features: ["cut"], bodies: [], axis: datum("ax"), count: 6, angle: 360, equal: true, flip: false, skip: "", ...o });
  let { k, engine, r } = await run([...disc, cp({})]);
  allOk(r);
  near(vol(k, engine), Math.PI * 900 * 5 - 6 * HOLE, 1e-6);
  const c = (name) => k.centre(engine.state.bodies[0].topo.faces.find((f) => f.name === name).shape, "face");
  const p4 = c("cp:i4.1:cut:side:h");   // half a turn round: at (−20, 0)
  near(p4[0], -20, 1e-6); near(p4[1], 0, 1e-6);
  ({ k, engine, r } = await run([...disc, cp({ count: 3, angle: 90, axis: top })]));
  allOk(r);
  const p3 = c("cp:i3.1:cut:side:h");   // the last of three over 90°: at (0, 20)
  near(p3[0], 0, 1e-6); near(p3[1], 20, 1e-6);
});

test("patterning bodies makes new bodies; joined, it makes one", async () => {
  const peg = [sketch("s1", circle(0, 0, 2, "c")), extrude("e1", "s1", { depth: 10 })];
  let { k, engine, r } = await run([...peg, feature("lp", "linear-pattern", { of: "bodies", features: [], bodies: ["e1"], merge: false, direction: right, spacing: 10, count: 4, flip: false, second: false, skip: "" })]);
  allOk(r);
  assert.equal(r.bodies.length, 4);
  assert.deepEqual(r.bodies.map((b) => b.id), ["e1", "lp:e1.i2.1", "lp:e1.i3.1", "lp:e1.i4.1"]);
  for (const b of engine.state.bodies) near(k.volume(b.shape), Math.PI * 4 * 10, 1e-6);
  assert.ok(engine.state.bodies[3].topo.faces.some((f) => f.name === "lp:i4.1:e1:side:c"));
  // joined: copies that overlap the original make one body with it
  ({ k, engine, r } = await run([...peg, sketch("s2", rect(-5, 20, 40, 30, "r")), extrude("bar", "s2", { depth: 2 }),
    feature("lp", "linear-pattern", { of: "bodies", features: [], bodies: ["e1"], merge: true, direction: right, spacing: 3, count: 4, flip: false, second: false, skip: "" })]));
  allOk(r);
  assert.equal(r.bodies.length, 2);
  assert.ok(vol(k, engine, "e1") > Math.PI * 4 * 10 * 2);
});

test("patterning a feature that made a new body copies the body", async () => {
  const { r } = await run([sketch("s1", circle(10, 0, 2, "c")), extrude("e1", "s1", { depth: 10 }),
    feature("cp", "circular-pattern", { of: "features", features: ["e1"], bodies: [], axis: top, count: 4, angle: 360, equal: true, flip: false, skip: "" })]);
  allOk(r);
  assert.equal(r.bodies.length, 4);
  // the middle of each copy, from its mesh: good to the mesh's chord tolerance (a circle is a polygon there)
  const c = (b) => [(b.mesh.bbox[0] + b.mesh.bbox[3]) / 2, (b.mesh.bbox[1] + b.mesh.bbox[4]) / 2].map((v) => { const r = Math.round(v * 1e2) / 1e2; return r === 0 ? 0 : r; });
  assert.deepEqual(r.bodies.map(c), [[10, 0], [0, 10], [-10, 0], [0, -10]]);
});

test("pattern errors read as sentences", async () => {
  const base = [...plate()];
  const lp = (o) => feature("lp", "linear-pattern", { of: "features", features: ["cut"], bodies: [], direction: right, spacing: 15, count: 3, flip: false, second: false, skip: "", ...o });
  for (const [o, re] of [[{ features: [] }, /Pick the features/], [{ direction: null }, /Pick the direction/], [{ count: 2.5 }, /whole number/], [{ features: ["later"] }, /not above this one/]]) {
    const { r } = await run([...base, lp(o)]);
    assert.equal(r.features[4].status, "error", JSON.stringify(o));
    assert.match(r.features[4].message, re);
  }
});

// ---------------------------------------------------------------- mirror

test("mirrored ribs: a rib added to a plate is mirrored across the plate's midplane", async () => {
  const feats = [
    sketch("s1", rect(-50, -30, 50, 30, "p")), extrude("e1", "s1", { depth: 5 }),
    sketch("s2", rect(10, -25, 14, 25, "r"), { kind: "face", ref: { kind: "face", body: "e1", name: "e1:end:pa" } }), extrude("rib", "s2", { operation: "add", depth: 12 }),
    feature("mid", "plane", { method: "midplane", faces: [{ kind: "face", body: "e1", name: "e1:side:pb" }, { kind: "face", body: "e1", name: "e1:side:pd" }] }),
    feature("mi", "mirror", { of: "features", features: ["rib"], bodies: [], merge: false, plane: datum("mid") }),
  ];
  const { k, engine, r } = await run(feats);
  allOk(r);
  assert.equal(r.bodies.length, 1);
  near(vol(k, engine), 100 * 60 * 5 + 2 * 4 * 50 * 12, 1e-6);
  const names = engine.state.bodies[0].topo.faces.map((f) => f.name);
  assert.equal(new Set(names).size, names.length);
  const top = names.find((n) => n.startsWith("mi:m:") && n.includes(":end:"));
  assert.ok(top, names.join(" "));
  const c = k.centre(engine.state.bodies[0].topo.faces.find((f) => f.name === top).shape, "face");
  near(c[0], -12, 1e-6); near(c[2], 17, 1e-6);
});

test("mirror a body: a new body, the image of the first; joined, one body", async () => {
  const L = [sketch("s1", { ...rect(5, 0, 25, 4, "a") }), extrude("e1", "s1", { depth: 3 })];
  let { k, engine, r } = await run([...L, feature("mi", "mirror", { of: "bodies", features: [], bodies: [], merge: false, plane: right })]);
  allOk(r);
  assert.equal(r.bodies.length, 2);
  near(k.volume(engine.state.bodies[1].shape), 20 * 4 * 3, 1e-6);
  const bb = r.bodies[1].mesh.bbox.map((v) => Math.round(v * 1e6) / 1e6);
  assert.deepEqual(bb, [-25, 0, 0, -5, 4, 3]);
  ({ k, engine, r } = await run([sketch("s1", rect(0, 0, 25, 4, "a")), extrude("e1", "s1", { depth: 3 }), feature("mi", "mirror", { of: "bodies", features: [], bodies: ["e1"], merge: true, plane: right })]));
  allOk(r);
  assert.equal(r.bodies.length, 1);
  near(vol(k, engine), 50 * 4 * 3, 1e-6);
});

// ---------------------------------------------------------------- sweep, loft, helix

const handlePath = () => sketch("path", {
  a: { type: "point", x: 0, y: 0 }, b: { type: "point", x: 0, y: 20 }, c: { type: "point", x: 40, y: 20 }, d: { type: "point", x: 40, y: 0 },
  o: { type: "point", x: 20, y: 20 }, l1: { type: "line", a: "a", b: "b" }, l2: { type: "line", a: "c", b: "d" },
  arc: { type: "arc", center: "o", start: "c", end: "b" },
}, front);

test("a swept handle: a circle carried along a line, an arc and a line, joined to a block", async () => {
  const feats = [
    sketch("s1", rect(-10, -10, 50, 10, "b")), extrude("e1", "s1", { depth: 5, flip: true }),
    handlePath(), sketch("prof", circle(0, 0, 3, "c")),
    feature("sw", "sweep", { profile: { sketch: "prof", regions: null }, path: [{ kind: "sketch", feature: "path", entity: "l1" }], operation: "new", targets: [] }),
  ];
  let { k, engine, r } = await run(feats);
  allOk(r);
  const L = 20 + 20 + Math.PI * 20;
  near(vol(k, engine, "sw"), Math.PI * 9 * L, 1e-3);
  const names = engine.state.bodies.find((b) => b.id === "sw").topo.faces.map((f) => f.name).sort();
  assert.ok(names.includes("sw:start:c") && names.includes("sw:end:c") && names.includes("sw:side:c"), names.join(" "));
  feats[4].params.operation = "add";
  ({ k, engine, r } = await run(feats));
  allOk(r);
  assert.equal(r.bodies.length, 1);
  near(vol(k, engine), 60 * 20 * 5 + Math.PI * 9 * L, 1e-3);
});

test("a path drawn with the line tool, with sharp corners: round or mitred corners, and a tube with a hole", async () => {
  const poly = sketch("path", { a: { type: "point", x: -20, y: 5 }, b: { type: "point", x: -20, y: 25 }, c: { type: "point", x: 20, y: 25 }, d: { type: "point", x: 20, y: 5 },
    l1: { type: "line", a: "a", b: "b" }, l2: { type: "line", a: "b", b: "c" }, l3: { type: "line", a: "c", b: "d" } }, front);
  const feats = (corners, prof) => [poly, feature("pn", "plane", { method: "normal", curve: { kind: "sketch", feature: "path", entity: "l1" }, position: 0 }),
    sketch("prof", prof, datum("pn")),
    feature("sw", "sweep", { profile: { sketch: "prof", regions: null }, path: [{ kind: "sketch", feature: "path", entity: "l2" }], corners, operation: "new", targets: [] })];
  const valid = (k, s) => new k.oc.BRepCheck_Analyzer(s, true, false).IsValid();
  for (const corners of ["round", "sharp"]) {
    const { k, engine, r } = await run(feats(corners, circle(0, 0, 3, "c")));
    allOk(r);
    const b = engine.state.bodies[0];
    assert.ok(valid(k, b.shape), corners);
    const v = k.volume(b.shape), straight = Math.PI * 9 * 80;
    assert.ok(Math.abs(v - straight) / straight < 0.03, `${corners}: ${v} vs ${straight}`);
    const names = b.topo.faces.map((f) => f.name);
    assert.ok(names.includes("sw:start:c") && names.includes("sw:end:c") && names.includes("sw:side:c~3"), names.join(" "));
  }
  const { k, engine, r } = await run(feats("round", { ...circle(0, 0, 3, "c"), ...circle(0, 0, 2, "i") }));
  allOk(r);
  const v = k.volume(engine.state.bodies[0].shape), tube = Math.PI * 5 * 80;
  assert.ok(Math.abs(v - tube) / tube < 0.03, `${v} vs ${tube}`);
  assert.ok(valid(k, engine.state.bodies[0].shape));
});

test("a sweep with its path in the profile's sketch, or with no path, says what to do", async () => {
  const { r } = await run([sketch("prof", circle(0, 0, 3, "c")), feature("sw", "sweep", { profile: { sketch: "prof", regions: null }, path: [], operation: "new", targets: [] })]);
  assert.match(r.features[1].message, /Pick the path/);
});

test("a loft from a square to a smaller square above it: ruled is a frustum", async () => {
  const feats = [
    sketch("a", rect(-10, -10, 10, 10, "a")),
    feature("pl", "plane", { method: "offset", ref: top, distance: 20 }),
    sketch("b", rect(-5, -5, 5, 5, "b"), datum("pl")),
    feature("lo", "loft", { profiles: ["a", "b"], ruled: true, operation: "new", targets: [] }),
  ];
  let { k, engine, r } = await run(feats);
  allOk(r);
  near(vol(k, engine), (20 / 3) * (400 + 100 + 200), 1e-6);
  const names = engine.state.bodies[0].topo.faces.map((f) => f.name);
  assert.ok(names.includes("lo:start") && names.includes("lo:end"), names.join(" "));
  assert.ok(names.filter((n) => n.startsWith("lo:side:")).length === 4, names.join(" "));
  feats[3].params.ruled = false;
  ({ k, engine, r } = await run(feats));
  allOk(r);
  assert.ok(vol(k, engine) > 0);
  const { r: r3 } = await run([feats[0], feature("lo", "loft", { profiles: ["a"], ruled: true, operation: "new", targets: [] })]);
  assert.match(r3.features[1].message, /two or more/);
});

test("a spring: a circle swept along a helix", async () => {
  const feats = [
    feature("hx", "helix", { axis: top, radius: 10, pitch: 8, turns: 3, start: 0, left: false }),
    feature("pn", "plane", { method: "normal", curve: datum("hx"), position: 0 }),
    sketch("prof", circle(0, 0, 1.5, "c"), datum("pn")),
    feature("sw", "sweep", { profile: { sketch: "prof", regions: null }, path: [datum("hx")], operation: "new", targets: [] }),
  ];
  const { k, engine, r } = await run(feats);
  allOk(r);
  const hx = r.datums.find((d) => d.featureId === "hx");
  assert.equal(hx.kind, "curve");
  near(hx.points[0], 10); near(hx.points[2], 0);
  near(hx.points[hx.points.length - 1], 24, 1e-6);   // three turns of 8
  const L = 3 * Math.hypot(2 * Math.PI * 10, 8);
  near(vol(k, engine), Math.PI * 2.25 * L, 0.01);
});

// ---------------------------------------------------------------- variables

test("expressions: units, operators, functions, variables, errors", () => {
  const e = (t, vars = {}) => V.evaluate(t, (n) => vars[n]);
  near(e("2 + 3 * 4"), 14);
  near(e("(2 + 3) * 4"), 20);
  near(e("2 ^ 3 ^ 2"), 512);
  near(e("-2 ^ 2"), -4);
  near(e("1 in"), 25.4);
  near(e("1.5cm + 2 mm"), 17);
  near(e("sin(30)"), 0.5);
  near(e("1 rad"), 180 / Math.PI);
  near(e("pi"), Math.PI);
  near(e("max(1, width / 2, 3)", { width: 10 }), 5);
  near(e("atan2(1, 1)"), 45);
  for (const bad of ["", "2 +", "foo", "1 / 0", "sqrt(", "2 $ 3", "nope(2)"]) assert.throws(() => e(bad), V.ExprError, bad);
  assert.ok(V.isPlainNumber("-1.5e3") && !V.isPlainNumber("2*3"));
  assert.equal(V.nameProblem("2x"), "A name starts with a letter and has only letters, digits and _.");
  assert.match(V.nameProblem("sin"), /function/);
  assert.match(V.nameProblem("w", ["w"]), /already/);
  assert.equal(V.nameProblem("wall_2"), null);
});

test("variables use each other; cycles and unknown names are errors on the variables in them", () => {
  const v = (id, name, expr) => ({ id, type: "variable", name, expr, order: id });
  const r = V.variableValues([v("1", "w", "40"), v("2", "half", "w / 2"), v("3", "a", "b + 1"), v("4", "b", "a + 1"), v("5", "c", "zz")]);
  assert.equal(r.values.get("w"), 40);
  assert.equal(r.values.get("half"), 20);
  assert.ok(r.errors.has("3") && r.errors.has("4") && r.errors.has("5"));
  assert.ok(!r.errors.has("1") && !r.errors.has("2"));
});

test("a feature's numbers follow the variables: resolved before the worker, and rewritten when a variable changes", () => {
  const doc = I.newItemDoc("part-studio", [
    { id: "studio", type: "studio", units: "mm", rollback: null },
    { id: "va", type: "variable", name: "depth", expr: "10", order: "a" },
    { id: "f1", type: "feature", featureType: "extrude", name: "Extrude 1", order: "b", params: { depth: 10, $expr: { depth: "depth * 2" } } },
  ]);
  const values = V.variableValues(V.variablesOf(doc)).values;
  const [inp] = V.resolveInputs([{ id: "f1", type: "extrude", name: "E", suppressed: false, params: doc.items.get("f1").params }], values);
  assert.equal(inp.params.depth, 20);
  // change the variable: the change carries the feature's new number
  let changes = V.setVariable(doc, "va", { expr: "4" });
  I.applyChanges(doc, changes);
  assert.equal(doc.items.get("f1").params.depth, 8);
  // rename it: expressions that used it follow
  changes = V.setVariable(doc, "va", { name: "d" });
  I.applyChanges(doc, changes);
  assert.equal(doc.items.get("f1").params.$expr.depth, "d * 2");
  assert.deepEqual(V.usersOf(doc, "d"), ["f1"]);
  const add = V.addVariable(doc, V.freeName(doc), "1 in");
  I.applyChanges(doc, add.changes);
  assert.equal(V.variablesOf(doc).length, 2);
  assert.equal(V.variablesOf(doc)[1].name, "v1");
  I.applyChanges(doc, V.deleteVariable(doc, "va"));
  assert.equal(V.variablesOf(doc).length, 1);
});
