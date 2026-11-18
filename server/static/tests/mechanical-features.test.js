// Node test for the solid features of the part studio (web/domains/mechanical/features and kernel/ops): the
// real OpenCascade build runs here, as in the browser's worker.  Extrude end conditions, Revolve, Fillet,
// Chamfer, Shell, Draft, Hole, Boolean, Delete body, Split, Transform; that each names its faces, fails with a
// message a person can act on, and that names survive an edit upstream.
// Run: node server/static/tests/mechanical-features.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const server = path.join(__dirname, "..", "..");
const esbuild = require(path.join(server, "node_modules", "esbuild"));

execFileSync(process.execPath, [path.join(server, "scripts", "gen-cad-registry.mjs")]);
const bundle = esbuild.buildSync({ entryPoints: [path.join(server, "web", "domains", "mechanical", "kernel", "index.ts")], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" });
const M = { exports: {} }; new Function("module", "exports", "require", bundle.outputFiles[0].text)(M, M.exports, require);
const K = M.exports;

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
const circle = (x, y, r, p) => ({ [`${p}c`]: { type: "point", x, y }, [p]: { type: "circle", center: `${p}c`, r } });
const top = { kind: "plane", plane: "top" };
const onFace = (body, name) => ({ kind: "face", ref: { kind: "face", body, name } });
const face = (body, name) => ({ kind: "face", body, name });
const sketch = (id, entities, plane = top) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
const feat = (type, id, params) => ({ id, type, name: id, suppressed: false, params });
const extrude = (id, sk, o = {}) => feat("extrude", id, { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const statuses = (r) => r.features.map((f) => f.status);
const okAll = (r) => assert.ok(r.features.every((f) => f.status === "ok"), JSON.stringify(r.features.filter((f) => f.status !== "ok")));
const vol = (k, engine, i = 0) => k.volume(engine.state.bodies[i].shape);
const totalVol = (k, engine) => engine.state.bodies.reduce((a, b) => a + k.volume(b.shape), 0);
const names = (engine, i = 0) => engine.state.bodies[i].topo.faces.map((f) => f.name).sort();
const unique = (engine) => { for (const b of engine.state.bodies) for (const g of ["faces", "edges", "vertices"]) assert.equal(new Set(b.topo[g].map((x) => x.name)).size, b.topo[g].length, `${g} names are unique in ${b.id}`); };
async function run(doc, n = doc.length) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(doc, n);
  return { k, engine, r };
}

test("every feature of this slice is registered with a dialog schema", async () => {
  const types = K.FEATURES.map((f) => f.type);
  for (const t of ["extrude", "revolve", "fillet", "chamfer", "shell", "draft", "hole", "boolean", "delete-body", "split", "transform"]) assert.ok(types.includes(t), t);
  for (const f of K.FEATURES) for (const field of f.schema) assert.ok(field.key && field.label && field.kind, `${f.type}.${field.key}`);
});

// ---------------------------------------------------------------- Extrude
test("extrude: symmetric, second direction, through all, intersect", async () => {
  const base = [sketch("s1", rect(0, 0, 40, 20, "r"))];
  let { k, engine, r } = await run([...base, extrude("e1", "s1", { endType: "symmetric", depth: 10 })]);
  okAll(r);
  assert.deepEqual(r.bodies[0].mesh.bbox.map((v) => Math.round(v * 1e6) / 1e6), [0, 0, -5, 40, 20, 5]);
  assert.ok(names(engine).includes("e1:start:ra") && names(engine).includes("e1:end:ra"));
  engine.dispose();

  ({ k, engine, r } = await run([...base, extrude("e1", "s1", { depth: 10, second: true, secondDepth: 4 })]));
  okAll(r);
  assert.deepEqual(r.bodies[0].mesh.bbox.map((v) => Math.round(v * 1e6) / 1e6), [0, 0, -4, 40, 20, 10]);
  near(vol(k, engine), 40 * 20 * 14);
  engine.dispose();

  // through all: a slot through a block 10 thick from a sketch on its top face, going down
  const slot = [...base, extrude("e1", "s1"), sketch("s2", rect(18, -5, 22, 25, "c"), onFace("e1", "e1:end:ra")), extrude("e2", "s2", { operation: "remove", endType: "through", flip: true })];
  ({ k, engine, r } = await run(slot));
  okAll(r);
  assert.equal(r.bodies.length, 2, "cut in two");
  near(totalVol(k, engine), 36 * 20 * 10);
  engine.dispose();

  // through all must not make material
  ({ engine, r } = await run([...base, extrude("e1", "s1", { endType: "through" })]));
  assert.equal(r.features[1].status, "error");
  assert.match(r.features[1].message, /Through all/);
  engine.dispose();

  // intersect: a block intersected with a cylinder standing on it keeps only the overlap
  const isect = [...base, extrude("e1", "s1"), sketch("s2", circle(10, 10, 5, "k")), extrude("e2", "s2", { operation: "intersect", depth: 30 })];
  ({ k, engine, r } = await run(isect));
  okAll(r);
  assert.equal(r.bodies.length, 1);
  near(vol(k, engine), Math.PI * 25 * 10, 1e-4);
  engine.dispose();
});

// a plate at z 0..5 and a lid at z 20..25 (made 0..25, then its lower 20 removed)
const plateAndLid = () => [
  sketch("s1", rect(0, 0, 40, 40, "r")), extrude("plate", "s1", { depth: 5 }),
  sketch("s2", rect(50, 0, 90, 40, "l")), extrude("lid", "s2", { depth: 25 }),
  sketch("s3", rect(49, -1, 91, 41, "x")), extrude("gap", "s3", { operation: "remove", depth: 20, targets: ["lid"] }),
];

test("extrude: up to face and up to next stop where they should and name the stopping face as the end cap", async () => {
  // move the lid over the plate with Transform? not needed: put the post under the lid instead
  const doc = plateAndLid();
  const post = sketch("s4", circle(70, 20, 3, "p"), top);
  let { k, engine, r } = await run([...doc, post, extrude("e4", "s4", { endType: "upToFace", face: face("lid", "gap:end:xa") })]);
  okAll(r);
  const made = engine.state.bodies.find((b) => b.id === "e4");
  near(k.volume(made.shape), Math.PI * 9 * 20, 1e-4);
  assert.ok(made.topo.faces.some((f) => f.name === "e4:end:p"), made.topo.faces.map((f) => f.name).join(", "));
  engine.dispose();

  // up to next: the same post finds the lid by itself, and Add joins it to the lid it touches
  ({ k, engine, r } = await run([...doc, post, extrude("e4", "s4", { endType: "upToNext", operation: "add" })]));
  okAll(r);
  near(k.volume(engine.state.bodies.find((b) => b.id === "lid").shape), 40 * 40 * 5 + Math.PI * 9 * 20, 1e-4);
  engine.dispose();

  // up to next with nothing in the way says so
  ({ engine, r } = await run([sketch("s1", rect(0, 0, 10, 10, "r")), extrude("e1", "s1"), sketch("s2", circle(5, 5, 1, "p"), onFace("e1", "e1:end:ra")), extrude("e2", "s2", { endType: "upToNext", operation: "add" })]));
  assert.equal(r.features[3].status, "error");
  assert.match(r.features[3].message, /Nothing is in the way/);
  engine.dispose();

  // a face behind the sketch is not reached
  ({ engine, r } = await run([...doc, sketch("s4", circle(20, 20, 3, "p"), onFace("plate", "plate:end:ra")), extrude("e4", "s4", { endType: "upToFace", face: face("plate", "plate:start:ra") })]));
  assert.equal(r.features[r.features.length - 1].status, "error");
  assert.match(r.features[r.features.length - 1].message, /does not reach|lies on/);
  engine.dispose();
});

test("extrude: draft narrows the extrusion; thin makes a wall", async () => {
  let { k, engine, r } = await run([sketch("s1", rect(0, 0, 20, 20, "r")), extrude("e1", "s1", { depth: 10, draft: true, draftAngle: 5 })]);
  okAll(r);
  const t = Math.tan((5 * Math.PI) / 180) * 10;
  const a = 20, b = 20 - 2 * t;   // a frustum of square section
  near(vol(k, engine), (10 / 3) * (a * a + a * b + b * b), 1e-4);
  assert.ok(names(engine).includes("e1:side:ra"));
  engine.dispose();

  const thin = (o) => [sketch("s1", rect(0, 0, 20, 10, "r")), extrude("e1", "s1", { depth: 5, thin: true, thickness: 1, ...o })];
  ({ k, engine, r } = await run(thin({ thinSide: "inside" })));
  okAll(r);
  near(vol(k, engine), (20 * 10 - 18 * 8) * 5, 1e-4);
  const n = names(engine);
  for (const x of ["e1:side:ra", "e1:side:ra:inner", "e1:start:ra", "e1:end:ra"]) assert.ok(n.includes(x), `${x} in ${n.join(", ")}`);
  unique(engine);
  engine.dispose();
  ({ k, engine, r } = await run(thin({ thinSide: "outside" })));
  okAll(r);
  near(vol(k, engine), (22 * 12 - 20 * 10) * 5, 1e-4);
  engine.dispose();
  ({ k, engine, r } = await run(thin({ thinSide: "both" })));
  okAll(r);
  near(vol(k, engine), (21 * 11 - 19 * 9) * 5, 1e-4);
  engine.dispose();
});
// ---------------------------------------------------------------- Revolve
const revolve = (id, sk, o = {}) => feat("revolve", id, { profile: { sketch: sk, regions: null }, operation: "new", axisType: "line", axisEdge: null, endType: "full", angle: 180, flip: false, targets: [], ...o });
// a 10 × 20 rectangle from x = 5 to 15 on the front plane (x, z), with a loose line on the z axis
const ring = () => sketch("s1", { ...rect(5, 0, 15, 20, "r"), o1: { type: "point", x: 0, y: -5 }, o2: { type: "point", x: 0, y: 25 }, ax: { type: "line", a: "o1", b: "o2" } }, { kind: "plane", plane: "front" });

test("revolve: full, angle, symmetric about a sketch line; Remove; a profile across the axis fails", async () => {
  const tube = Math.PI * (15 * 15 - 5 * 5) * 20;
  let { k, engine, r } = await run([ring(), revolve("v1", "s1")]);
  assert.deepEqual(statuses(r), ["ok", "ok"], JSON.stringify(r.features));
  near(vol(k, engine), tube, 1e-4);
  const n = names(engine);
  for (const x of ["v1:side:ra", "v1:side:rb", "v1:side:rc", "v1:side:rd"]) assert.ok(n.includes(x), `${x} in ${n.join(", ")}`);
  assert.ok(!n.some((x) => x.includes(":start:")), "a full revolve has no caps");
  unique(engine);
  engine.dispose();

  ({ k, engine, r } = await run([ring(), revolve("v1", "s1", { endType: "angle", angle: 90 })]));
  near(vol(k, engine), tube / 4, 1e-4);
  assert.ok(names(engine).includes("v1:start:ra") && names(engine).includes("v1:end:ra"));
  const b1 = r.bodies[0].mesh.bbox;
  engine.dispose();
  ({ k, engine, r } = await run([ring(), revolve("v1", "s1", { endType: "symmetric", angle: 90 })]));
  near(vol(k, engine), tube / 4, 1e-4);
  // symmetric about the sketch: the bounding box straddles the sketch plane (y = 0)
  const b2 = r.bodies[0].mesh.bbox;
  assert.ok(b2[1] < -1 && b2[4] > 1, JSON.stringify(b2));
  assert.notDeepEqual(b1, b2);
  engine.dispose();

  // about the sketch's own vertical axis (x = 0 on the front plane is the same line)
  ({ k, engine, r } = await run([ring(), revolve("v1", "s1", { axisType: "y" })]));
  near(vol(k, engine), tube, 1e-4);
  engine.dispose();

  // a groove: revolve-remove a small square from a block's edge
  const doc = [sketch("b", rect(-20, -20, 20, 20, "q")), extrude("e1", "b", { depth: 20 }), sketch("g", { ...rect(18, 5, 21, 10, "g"), o1: { type: "point", x: 0, y: 0 }, o2: { type: "point", x: 0, y: 30 }, ax: { type: "line", a: "o1", b: "o2" } }, { kind: "plane", plane: "front" }), revolve("v2", "g", { operation: "remove" })];
  ({ k, engine, r } = await run(doc));
  okAll(r);
  assert.ok(vol(k, engine) < 40 * 40 * 20 && vol(k, engine) > 40 * 40 * 20 - 3 * 5 * 2 * Math.PI * 21);
  engine.dispose();

  // across the axis
  const bad = sketch("s1", { ...rect(-5, 0, 15, 20, "r"), o1: { type: "point", x: 0, y: -5 }, o2: { type: "point", x: 0, y: 25 }, ax: { type: "line", a: "o1", b: "o2", construction: true } }, { kind: "plane", plane: "front" });
  // (a construction line: an ordinary line across the outline would cut it into two regions, sketch/planar.ts)
  ({ engine, r } = await run([bad, revolve("v1", "s1")]));
  assert.equal(r.features[1].status, "error");
  assert.match(r.features[1].message, /crosses the axis/);
  engine.dispose();
  // no axis line
  ({ engine, r } = await run([sketch("s1", rect(5, 0, 15, 20, "r")), revolve("v1", "s1")]));
  assert.match(r.features[1].message, /Draw a line/);
  engine.dispose();
});

// ---------------------------------------------------------------- Fillet, Chamfer
const block = () => [sketch("s1", rect(0, 0, 40, 20, "r")), extrude("e1", "s1")];
const fillet = (id, edges, radius = 2) => feat("fillet", id, { edges, radius });
const chamfer = (id, edges, o = {}) => feat("chamfer", id, { edges, chamferType: "equal", distance: 2, distance2: 3, angle: 30, flip: false, ...o });
const edge = (body, name) => ({ kind: "edge", body, name });

test("fillet: edges and faces, names from the edge, survive an upstream edit; too big a radius fails", async () => {
  const doc = [...block(), fillet("f1", [edge("e1", "edge(e1:side:ra|e1:side:rb)")], 3)];
  let { k, engine, r } = await run(doc);
  okAll(r);
  near(vol(k, engine), 40 * 20 * 10 - (9 - (Math.PI * 9) / 4) * 10, 1e-4);
  const round = "f1:from(edge(e1:side:ra|e1:side:rb))";
  assert.ok(names(engine).includes(round), names(engine).join(", "));
  unique(engine);
  // a later feature refers to the fillet's face: a sketch on the top face, then make the base taller
  doc[1] = extrude("e1", "s1", { depth: 25 });
  r = await engine.regenerate(doc, doc.length);
  okAll(r);
  assert.ok(names(engine).includes(round), "the rounding keeps its name when the extrusion changes");
  near(vol(k, engine), 40 * 20 * 25 - (9 - (Math.PI * 9) / 4) * 25, 1e-4);
  engine.dispose();

  // a face: all four edges of the top
  ({ k, engine, r } = await run([...block(), fillet("f1", [face("e1", "e1:end:ra")], 1)]));
  okAll(r);
  assert.equal(names(engine).filter((n) => n.startsWith("f1:from(")).length >= 4, true);
  engine.dispose();

  // tangent chains: fillet the four vertical edges, then pick one top edge: the whole top outline is rounded
  const verticals = ["ra|e1:side:rb", "rb|e1:side:rc", "rc|e1:side:rd", "ra|e1:side:rd"].map((s) => edge("e1", `edge(e1:side:${s})`));
  ({ k, engine, r } = await run([...block(), fillet("f1", verticals, 3), fillet("f2", [edge("e1", "edge(e1:end:ra|e1:side:ra)")], 1)]));
  okAll(r);
  assert.ok(names(engine).filter((n) => n.startsWith("f2:from(")).length >= 1);
  const top = engine.state.bodies[0].topo.edges.filter((e) => e.name.includes("e1:end:ra"));
  assert.ok(top.every((e) => e.name.includes("f2:")), "every edge of the top now borders the f2 rounding: " + top.map((e) => e.name).join(", "));
  engine.dispose();

  ({ engine, r } = await run([...block(), fillet("f1", [edge("e1", "edge(e1:side:ra|e1:side:rb)")], 30)]));
  assert.equal(r.features[2].status, "error");
  assert.match(r.features[2].message, /smaller radius/);
  engine.dispose();
  ({ engine, r } = await run([...block(), fillet("f1", [])]));
  assert.match(r.features[2].message, /Pick the edges/);
  engine.dispose();
});

test("chamfer: equal, two distances, distance and angle", async () => {
  const e = [edge("e1", "edge(e1:end:ra|e1:side:ra)")];
  let { k, engine, r } = await run([...block(), chamfer("c1", e)]);
  okAll(r);
  near(vol(k, engine), 40 * 20 * 10 - 2 * 2 / 2 * 40, 1e-4);
  assert.ok(names(engine).includes("c1:from(edge(e1:end:ra|e1:side:ra))"));
  engine.dispose();
  ({ k, engine, r } = await run([...block(), chamfer("c1", e, { chamferType: "two", distance: 2, distance2: 4 })]));
  okAll(r);
  near(vol(k, engine), 40 * 20 * 10 - 2 * 4 / 2 * 40, 1e-4);
  engine.dispose();
  ({ k, engine, r } = await run([...block(), chamfer("c1", e, { chamferType: "angle", distance: 2, angle: 45 })]));
  okAll(r);
  near(vol(k, engine), 40 * 20 * 10 - 2 * 2 / 2 * 40, 1e-3);
  engine.dispose();
});

// ---------------------------------------------------------------- Shell, Draft
test("shell: open box inward and outward, closed hollow; draft tilts faces and keeps their names", async () => {
  const doc = [...block(), feat("shell", "sh", { faces: [face("e1", "e1:end:ra")], thickness: 2, outward: false, bodies: [] })];
  let { k, engine, r } = await run(doc);
  okAll(r);
  near(vol(k, engine), 40 * 20 * 10 - 36 * 16 * 8, 1e-4);
  const n = names(engine);
  assert.ok(n.includes("sh:from(e1:side:ra)") && n.includes("sh:from(e1:start:ra)") && n.includes("e1:side:ra"), n.join(", "));
  unique(engine);
  // names survive an upstream edit
  doc[1] = extrude("e1", "s1", { depth: 15 });
  r = await engine.regenerate(doc, doc.length);
  okAll(r);
  near(vol(k, engine), 40 * 20 * 15 - 36 * 16 * 13, 1e-4);
  assert.deepEqual(names(engine), n);
  engine.dispose();

  ({ k, engine, r } = await run([...block(), feat("shell", "sh", { faces: [face("e1", "e1:end:ra")], thickness: 2, outward: true, bodies: [] })]));
  okAll(r);
  near(vol(k, engine), 44 * 24 * 12 - 40 * 20 * 10, 1e-3);
  engine.dispose();

  ({ k, engine, r } = await run([...block(), feat("shell", "sh", { faces: [], thickness: 1, outward: false, bodies: ["e1"] })]));
  okAll(r);
  near(vol(k, engine), 40 * 20 * 10 - 38 * 18 * 8, 1e-4);
  engine.dispose();

  ({ engine, r } = await run([...block(), feat("shell", "sh", { faces: [face("e1", "e1:end:ra")], thickness: 11, outward: false, bodies: [] })]));
  assert.equal(r.features[2].status, "error");
  engine.dispose();

  // draft the four sides 5° about the base, pulling up: a frustum
  const sides = ["ra", "rb", "rc", "rd"].map((s) => face("e1", `e1:side:${s}`));
  ({ k, engine, r } = await run([sketch("s1", rect(0, 0, 20, 20, "r")), extrude("e1", "s1"), feat("draft", "d1", { faces: sides, neutral: { kind: "plane", plane: "top" }, angle: 5, flip: false })]));
  okAll(r);
  const t = Math.tan((5 * Math.PI) / 180) * 10, a = 20, b = 20 - 2 * t;
  near(vol(k, engine), (10 / 3) * (a * a + a * b + b * b), 1e-4);
  assert.ok(["e1:side:ra", "e1:side:rb", "e1:side:rc", "e1:side:rd"].every((x) => names(engine).includes(x)));
  engine.dispose();
  // with the bottom face as the neutral plane the pull is its normal, down: wider at the top; reversed, narrower
  ({ k, engine, r } = await run([sketch("s1", rect(0, 0, 20, 20, "r")), extrude("e1", "s1"), feat("draft", "d1", { faces: sides, neutral: onFace("e1", "e1:start:ra"), angle: 5, flip: false })]));
  okAll(r);
  assert.ok(vol(k, engine) > 20 * 20 * 10);
  engine.dispose();
  ({ k, engine, r } = await run([sketch("s1", rect(0, 0, 20, 20, "r")), extrude("e1", "s1"), feat("draft", "d1", { faces: sides, neutral: onFace("e1", "e1:start:ra"), angle: 5, flip: true })]));
  okAll(r);
  near(vol(k, engine), (10 / 3) * (a * a + a * b + b * b), 1e-4);
  engine.dispose();
});

// ---------------------------------------------------------------- Hole
const hole = (id, sk, o = {}) => feat("hole", id, { points: { sketch: sk, regions: null }, holeType: "simple", standard: "M3", fit: "normal", diameter: 3.4, cboreDiameter: 6.5, cboreDepth: 3.3, csinkDiameter: 6.9, csinkAngle: 90, endType: "through", depth: 10, tipAngle: 118, flip: false, targets: [], ...o });

test("hole: through, blind, counterbore, countersink, tapped; at circle centres and loose points; names survive edits", async () => {
  const pts = sketch("hp", { ...circle(10, 10, 1, "h"), lp: { type: "point", x: 30, y: 10 } }, onFace("e1", "e1:end:ra"));
  const doc = [...block(), pts, hole("h1", "hp")];
  let { k, engine, r } = await run(doc);
  okAll(r);
  const d = 3.4;
  near(vol(k, engine), 40 * 20 * 10 - 2 * Math.PI * (d / 2) ** 2 * 10, 1e-4);
  const n = names(engine);
  assert.ok(n.includes("h1:hc:wall") && n.includes("h1:lp:wall"), n.join(", "));
  unique(engine);
  // the plate gets thicker and the circle moves: the holes follow, with the same names
  doc[1] = extrude("e1", "s1", { depth: 12 });
  doc[2] = sketch("hp", { ...circle(12, 8, 1, "h"), lp: { type: "point", x: 30, y: 10 } }, onFace("e1", "e1:end:ra"));
  r = await engine.regenerate(doc, doc.length);
  okAll(r);
  near(vol(k, engine), 40 * 20 * 12 - 2 * Math.PI * (d / 2) ** 2 * 12, 1e-4);
  assert.deepEqual(names(engine), n);
  engine.dispose();

  // blind with a flat floor
  ({ k, engine, r } = await run([...block(), pts, hole("h1", "hp", { endType: "blind", depth: 4, tipAngle: 180, standard: "custom", diameter: 2 })]));
  okAll(r);
  near(vol(k, engine), 40 * 20 * 10 - 2 * Math.PI * 4, 1e-4);
  assert.ok(names(engine).includes("h1:hc:floor"));
  engine.dispose();
  // blind with a drill point: a little more than the cylinder
  ({ k, engine, r } = await run([...block(), pts, hole("h1", "hp", { endType: "blind", depth: 4, standard: "custom", diameter: 2 })]));
  okAll(r);
  const cone = (Math.PI / 3) * 1 * (1 / Math.tan((59 * Math.PI) / 180));
  near(vol(k, engine), 40 * 20 * 10 - 2 * (Math.PI * 4 + cone), 1e-4);
  engine.dispose();

  // counterbore M3: 6.5 × 3.3 over a 3.4 hole
  ({ k, engine, r } = await run([...block(), pts, hole("h1", "hp", { holeType: "cbore" })]));
  okAll(r);
  near(vol(k, engine), 40 * 20 * 10 - 2 * (Math.PI * 3.25 ** 2 * 3.3 + Math.PI * 1.7 ** 2 * (10 - 3.3)), 1e-4);
  assert.ok(names(engine).includes("h1:hc:cbore") && names(engine).includes("h1:hc:cbore-floor"));
  engine.dispose();
  // countersink M3: 6.9 at 90°
  ({ k, engine, r } = await run([...block(), pts, hole("h1", "hp", { holeType: "csink" })]));
  okAll(r);
  const h = (6.9 - 3.4) / 2;
  const frustum = (Math.PI * h / 3) * (3.45 ** 2 + 3.45 * 1.7 + 1.7 ** 2);
  near(vol(k, engine), 40 * 20 * 10 - 2 * (frustum + Math.PI * 1.7 ** 2 * (10 - h)), 1e-4);
  assert.ok(names(engine).includes("h1:hc:csink"));
  engine.dispose();
  // tapped M3: the 2.5 tap drill
  ({ k, engine, r } = await run([...block(), pts, hole("h1", "hp", { fit: "tapped" })]));
  okAll(r);
  near(vol(k, engine), 40 * 20 * 10 - 2 * Math.PI * 1.25 ** 2 * 10, 1e-4);
  engine.dispose();
  // no points
  ({ engine, r } = await run([...block(), sketch("hp", rect(1, 1, 2, 2, "z"), onFace("e1", "e1:end:ra")), hole("h1", "hp")]));
  assert.match(r.features[3].message, /no point/);
  engine.dispose();
});

// ---------------------------------------------------------------- Boolean, Delete, Split, Transform
test("boolean, delete body, split, transform", async () => {
  const two = [sketch("s1", rect(0, 0, 20, 20, "a")), extrude("A", "s1"), sketch("s2", rect(10, 10, 30, 30, "b")), extrude("B", "s2", { depth: 20 })];
  let { k, engine, r } = await run([...two, feat("boolean", "u", { operation: "union", targets: [], tools: [], keepTools: false })]);
  okAll(r);
  assert.equal(r.bodies.length, 1);
  assert.equal(r.bodies[0].id, "A");
  near(vol(k, engine), 400 * 10 + 400 * 20 - 100 * 10, 1e-6);
  engine.dispose();
  ({ k, engine, r } = await run([...two, feat("boolean", "u", { operation: "subtract", targets: ["A"], tools: ["B"], keepTools: false })]));
  okAll(r);
  assert.deepEqual(r.bodies.map((b) => b.id), ["A"]);
  near(vol(k, engine), 400 * 10 - 100 * 10, 1e-6);
  engine.dispose();
  ({ k, engine, r } = await run([...two, feat("boolean", "u", { operation: "intersect", targets: ["A"], tools: ["B"], keepTools: true })]));
  okAll(r);
  assert.deepEqual(r.bodies.map((b) => b.id), ["A", "B"]);
  near(vol(k, engine), 100 * 10, 1e-6);
  engine.dispose();
  ({ engine, r } = await run([...two, feat("boolean", "u", { operation: "subtract", targets: ["A"], tools: ["A"], keepTools: false })]));
  assert.equal(r.features[4].status, "error");
  engine.dispose();

  ({ engine, r } = await run([...two, feat("delete-body", "d", { bodies: ["B"] })]));
  okAll(r);
  assert.deepEqual(r.bodies.map((b) => b.id), ["A"]);
  engine.dispose();

  // split the 40 × 20 block with the right plane moved... the right plane is x = 0, so split a block across it
  const across = [sketch("s1", rect(-10, 0, 30, 20, "r")), extrude("e1", "s1")];
  ({ k, engine, r } = await run([...across, feat("split", "sp", { plane: { kind: "plane", plane: "right" }, bodies: [], keep: "both" })]));
  okAll(r);
  assert.equal(r.bodies.length, 2);
  assert.equal(r.bodies[0].id, "e1");
  near(vol(k, engine, 0), 30 * 20 * 10, 1e-6);
  near(vol(k, engine, 1), 10 * 20 * 10, 1e-6);
  assert.ok(names(engine, 0).includes("sp:cut") && names(engine, 1).includes("sp:cut"));
  unique(engine);
  engine.dispose();
  ({ k, engine, r } = await run([...across, feat("split", "sp", { plane: { kind: "plane", plane: "right" }, bodies: [], keep: "back" })]));
  okAll(r);
  assert.equal(r.bodies.length, 1);
  near(vol(k, engine), 10 * 20 * 10, 1e-6);
  engine.dispose();
  ({ engine, r } = await run([...block(), feat("split", "sp", { plane: { kind: "plane", plane: "right" }, bodies: [], keep: "both" })]));
  assert.match(r.features[2].message, /does not cross/);
  engine.dispose();

  // transform: move and turn keeps names; a copy is a second body
  ({ k, engine, r } = await run([...block(), feat("transform", "t", { bodies: ["e1"], dx: 5, dy: 0, dz: 7, axis: "z", angle: 90, copy: false })]));
  okAll(r);
  assert.deepEqual(r.bodies[0].mesh.bbox.map((v) => Math.round(v * 1e6) / 1e6), [-15, 0, 7, 5, 40, 17]);
  assert.deepEqual(names(engine), ["e1:end:ra", "e1:side:ra", "e1:side:rb", "e1:side:rc", "e1:side:rd", "e1:start:ra"]);
  engine.dispose();
  ({ k, engine, r } = await run([...block(), feat("transform", "t", { bodies: ["e1"], dx: 0, dy: 30, dz: 0, axis: "z", angle: 0, copy: true }), sketch("s9", circle(10, 40, 2, "k"), onFace("t:e1", "e1:end:ra")), hole("h9", "s9")]));
  okAll(r);
  assert.deepEqual(r.bodies.map((b) => b.id), ["e1", "t:e1"]);
  near(vol(k, engine, 0), 8000);
  near(vol(k, engine, 1), 8000 - Math.PI * 1.7 ** 2 * 10, 1e-4);
  engine.dispose();
});

// ---------------------------------------------------------------- an enclosure, end to end
test("an enclosure: box, shell, fillets, bosses with holes; edit the box and everything follows", async () => {
  const W = 60, D = 40, H = 25;
  const bossSketch = { ...circle(8, 8, 3.5, "b1"), ...circle(W - 8, 8, 3.5, "b2"), ...circle(8, D - 8, 3.5, "b3"), ...circle(W - 8, D - 8, 3.5, "b4") };
  const doc = (w = W) => [
    sketch("s1", rect(0, 0, w, D, "r")), extrude("box", "s1", { depth: H }),
    fillet("round", ["ra|box:side:rb", "rb|box:side:rc", "rc|box:side:rd", "ra|box:side:rd"].map((s) => edge("box", `edge(box:side:${s})`)), 5),
    feat("shell", "sh", { faces: [face("box", "box:end:ra")], thickness: 2, outward: false, bodies: [] }),
    sketch("s2", bossSketch, onFace("box", "sh:from(box:start:ra)")),
    extrude("boss", "s2", { operation: "add", endType: "blind", depth: 15 }),
    sketch("s3", bossSketch, onFace("box", "boss:end:b1")),
    hole("holes", "s3", { endType: "blind", depth: 12, fit: "tapped" }),
  ];
  let { k, engine, r } = await run(doc());
  okAll(r);
  assert.equal(r.bodies.length, 1);
  const n = names(engine);
  for (const x of ["holes:b1c:wall", "holes:b4c:wall", "boss:side:b1", "round:from(edge(box:side:ra|box:side:rb))", "sh:from(box:side:ra)"]) assert.ok(n.includes(x), `${x} in ${n.join(", ")}`);
  unique(engine);
  const v1 = vol(k, engine);
  // wider box: rebuilds from the extrude, every reference holds
  r = await engine.regenerate(doc(80), 8);
  okAll(r);
  assert.ok(vol(k, engine) > v1);
  assert.ok(names(engine).includes("holes:b4c:wall"));
  engine.dispose();
});
// END
