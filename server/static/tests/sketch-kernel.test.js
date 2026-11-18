// Node test for the kernel side of the sketcher, on the real OpenCascade build: regions of a sketch whose curves
// cross become faces that extrude (features/sketch.ts with sketch/planar.ts), and the sketch-project service that
// the "Use edge" tool asks for the model's edges on a sketch plane.
// Run: node server/static/tests/sketch-kernel.test.js
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

const pt = (x, y) => ({ type: "point", x, y });
const rect = (x0, y0, x1, y1, p) => ({
  [`${p}1`]: pt(x0, y0), [`${p}2`]: pt(x1, y0), [`${p}3`]: pt(x1, y1), [`${p}4`]: pt(x0, y1),
  [`${p}a`]: { type: "line", a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: "line", a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: "line", a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: "line", a: `${p}4`, b: `${p}1` },
});
const sketch = (id, entities, plane = { kind: "plane", plane: "top" }, constraints = {}) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints } } });
const extrude = (id, sk, o = {}) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const volumes = (k, engine) => engine.state.bodies.map((b) => k.volume(b.shape)).sort((a, b) => a - b);

test("the solver is not in the worker bundle", () => {
  assert.ok(!/planegcs|GcsSystem/.test(bundle.outputFiles[0].text), "the kernel builds from solved coordinates and never solves");
  assert.ok(K.SERVICES.some((s) => s.name === "sketch-project"));
});

test("two circles that overlap: three regions, three solids, exact volumes", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate([
    sketch("s1", { ac: pt(0, 0), a: { type: "circle", center: "ac", r: 10 }, bc: pt(12, 0), b: { type: "circle", center: "bc", r: 10 } }),
    extrude("e1", "s1"),
  ], 2);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok"], r.features.map((f) => f.message).join());
  assert.deepEqual(r.sketches[0].regions.map((x) => x.id), ["a", "a~2", "a~3"]);
  assert.equal(r.bodies.length, 3);
  const [lens, m1, m2] = volumes(k, engine);
  const lensArea = 2 * 100 * Math.acos(6 / 10) - 12 * Math.sqrt(100 - 36);   // two circles of radius 10 whose centres are 12 apart
  near(lens, lensArea * 10, 1e-6); near(m1, (Math.PI * 100 - lensArea) * 10, 1e-6); near(m2, m1, 1e-9);
  // the faces swept by each stretch of a circle are named after the circle; the two of one body are told apart
  const names = engine.state.bodies.map((b) => b.topo.faces.map((f) => f.name).sort());
  for (const n of names) assert.equal(new Set(n).size, n.length, "face names are unique in a body: " + n.join());
  assert.ok(names.some((n) => n.includes("e1:side:a") && n.includes("e1:side:b")));
});

test("a plate cut by a line and a slot across its edge; only the picked regions when asked", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const plate = {
    ...rect(0, 0, 40, 20, "r"), q1: pt(15, -5), q2: pt(15, 25), cut: { type: "line", a: "q1", b: "q2" },
    // a slot that sticks out over the right-hand side
    s1: pt(32, 7), s2: pt(46, 7), s3: pt(46, 13), s4: pt(32, 13), c1: pt(32, 10), c2: pt(46, 10),
    sb: { type: "line", a: "s1", b: "s2" }, sr: { type: "arc", center: "c2", start: "s2", end: "s3" }, st: { type: "line", a: "s3", b: "s4" }, sl: { type: "arc", center: "c1", start: "s4", end: "s1" },
    hc: pt(7, 10), hole: { type: "circle", center: "hc", r: 3 }, guide: { type: "line", a: "r1", b: "r3", construction: true },
  };
  const r = await engine.regenerate([sketch("s1", plate), extrude("e1", "s1")], 2);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok"], r.features.map((f) => f.message).join());
  // left of the cut (with the hole), right of it less the slot's inner part, the slot inside the plate, the slot outside
  assert.equal(r.sketches[0].regions.length, 4);
  assert.equal(r.sketches[0].regions.filter((x) => x.holes.length === 1).length, 1);
  const total = volumes(k, engine).reduce((a, b) => a + b, 0);
  const slotOutside = 6 * 6 + Math.PI * 9 / 2;   // the part of the slot beyond x = 40
  near(total, (40 * 20 - Math.PI * 9 + slotOutside) * 10, 1e-6);
  near(volumes(k, engine)[2], (15 * 20 - Math.PI * 9) * 10, 1e-6);
  near(volumes(k, engine)[3], (25 * 20 - (8 * 6 + Math.PI * 9 / 2)) * 10, 1e-6);

  // one region picked by its id
  const left = r.sketches[0].regions.find((x) => x.holes.length === 1).id;
  const one = await engine.regenerate([sketch("s1", plate), extrude("e1", "s1", { profile: { sketch: "s1", regions: [left] } })], 2);
  assert.equal(one.bodies.length, 1);
  near(volumes(k, engine)[0], (15 * 20 - Math.PI * 9) * 10, 1e-6);
});

test("constraints in a sketch change nothing for the kernel: it builds from the coordinates", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const cons = { h: { type: "horizontal", refs: [{ entity: "ra" }] }, w: { type: "distance", refs: [{ entity: "ra" }], value: 999, label: { x: 1, y: 2 } }, odd: { type: "from-the-future", refs: [] } };
  const r = await engine.regenerate([sketch("s1", rect(0, 0, 40, 20, "r"), undefined, cons), extrude("e1", "s1")], 2);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok"]);
  near(volumes(k, engine)[0], 40 * 20 * 10);
});

test("sketch-project: the model's edges and corners on a sketch plane", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate([sketch("s1", { ...rect(0, 0, 40, 20, "r"), hc: pt(10, 10), hole: { type: "circle", center: "hc", r: 3 } }), extrude("e1", "s1")], 2);
  const svc = K.SERVICES.find((s) => s.name === "sketch-project");
  const call = (refs, frame) => svc.run({ oc: k.oc, k, state: engine.state, fail: (m) => new Error(m) }, { refs, frame });
  const top = { origin: [0, 0, 10], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
  const edge = (name) => ({ kind: "edge", body: "e1", name });
  const body = engine.state.bodies[0];
  // a straight edge of the top face, the hole's rim, a corner
  let a = call([edge("edge(e1:end:ra|e1:side:ra)"), edge("edge(e1:end:ra|e1:side:hole)"), { kind: "vertex", body: "e1", name: "vertex(e1:end:ra|e1:side:ra|e1:side:rb)" }], top);
  assert.equal(a.skipped.length, 0, JSON.stringify(a.skipped));
  assert.deepEqual(a.curves.map((c) => c.type), ["line", "circle", "point"]);
  assert.deepEqual([a.curves[0].a, a.curves[0].b].sort((p, q) => p[0] - q[0]), [[0, 0], [40, 0]]);
  assert.deepEqual(a.curves[1].c, [10, 10]); near(a.curves[1].r, 3);
  assert.deepEqual(a.curves[2].p, [40, 0]);
  assert.equal(a.curves[0].from.name, "edge(e1:end:ra|e1:side:ra)");
  // from the front (the XZ plane): an upright edge is a line, the hole's rim is seen edge-on, a bottom edge runs across
  const front = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], normal: [0, -1, 0] };
  const upright = body.topo.edges.find((e) => /side:ra\|.*side:rb|side:rb\|.*side:ra/.test(e.name)).name;
  a = call([edge(upright), edge("edge(e1:end:ra|e1:side:hole)")], front);
  assert.deepEqual(a.curves.map((c) => c.type), ["line", "line"]);
  assert.deepEqual([a.curves[0].a, a.curves[0].b].sort((p, q) => p[1] - q[1]), [[40, 0], [40, 10]]);
  assert.deepEqual([a.curves[1].a, a.curves[1].b].sort((p, q) => p[0] - q[0]), [[7, 10], [13, 10]]);
  // an edge straight towards the viewer is a point; a tilted circle is refused with a reason
  a = call([edge(upright)], top);
  assert.deepEqual(a.curves, [{ type: "point", p: [40, 0], from: edge(upright) }]);
  const s = Math.SQRT1_2;
  a = call([edge("edge(e1:end:ra|e1:side:hole)"), edge("nope")], { origin: [0, 0, 0], x: [1, 0, 0], y: [0, s, s], normal: [0, -s, s] });
  assert.equal(a.curves.length, 0);
  assert.match(a.skipped[0].why, /ellipse/); assert.match(a.skipped[1].why, /no longer exists/);
});
