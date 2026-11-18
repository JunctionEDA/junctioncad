// Node test for the mechanical domain's kernel side (web/domains/mechanical/kernel, features/): the real
// OpenCascade build runs here, as it does in the browser's worker.  Sketch → Extrude end to end, booleans,
// geometry names across rebuilds, the regeneration cache, the rollback bar, suppression and feature errors.
// Run: node server/static/tests/mechanical-kernel.test.js
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

// ---- a small document: a 40 × 20 rectangle with a hole, extruded 10; a boss on top; a pocket
const rect = (x0, y0, x1, y1, p) => ({
  [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y0 }, [`${p}3`]: { type: "point", x: x1, y: y1 }, [`${p}4`]: { type: "point", x: x0, y: y1 },
  [`${p}a`]: { type: "line", a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: "line", a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: "line", a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: "line", a: `${p}4`, b: `${p}1` },
});
const sketch = (id, entities, plane = { kind: "plane", plane: "top" }) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, o = {}) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });
const base = () => [
  sketch("s1", { ...rect(0, 0, 40, 20, "r"), hc: { type: "point", x: 10, y: 10 }, hole: { type: "circle", center: "hc", r: 3 } }),
  extrude("e1", "s1"),
];
const volume = (k, engine, i = 0) => k.volume(engine.state.bodies[i].shape);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);

test("the feature and service lists are generated from the folders", async () => {
  // other feature types are added beside these by their own files
  for (const t of ["extrude", "sketch"]) assert.ok(K.FEATURES.some((f) => f.type === t), t);
  assert.ok(K.SERVICES.some((s) => s.name === "mass-properties"));
  for (const f of K.FEATURES) { assert.equal(typeof f.evaluate, "function"); assert.ok(f.title && f.defaults() && Array.isArray(f.schema)); }
});

test("sketch a rectangle with a hole, extrude it: one solid with the right volume and named geometry", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(base(), 2);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok"]);
  assert.equal(r.bodies.length, 1);
  near(volume(k, engine), (40 * 20 - Math.PI * 9) * 10, 1e-6);
  const body = engine.state.bodies[0];
  assert.equal(body.id, "e1");
  assert.deepEqual(body.topo.faces.map((f) => f.name).sort(), ["e1:end:ra", "e1:side:hole", "e1:side:ra", "e1:side:rb", "e1:side:rc", "e1:side:rd", "e1:start:ra"]);
  assert.equal(new Set(body.topo.edges.map((e) => e.name)).size, body.topo.edges.length, "edge names are unique");
  assert.equal(new Set(body.topo.vertices.map((e) => e.name)).size, body.topo.vertices.length, "vertex names are unique");
  assert.ok(body.topo.edges.some((e) => e.name === "edge(e1:end:ra|e1:side:ra)"));
  assert.ok(body.topo.vertices.some((v) => v.name === "vertex(e1:end:ra|e1:side:ra|e1:side:rb)"));

  // the mesh: every face and edge has a range, and the ranges cover the buffers
  const mesh = r.bodies[0].mesh;
  assert.equal(mesh.faces.names.length, 7);
  assert.deepEqual(mesh.faces.names.slice().sort(), body.topo.faces.map((f) => f.name).sort());
  assert.equal(Array.from(mesh.faces.count).reduce((a, b) => a + b, 0), mesh.indices.length);
  assert.equal(mesh.positions.length, mesh.normals.length);
  assert.deepEqual(mesh.edges.names.slice().sort(), body.topo.edges.map((e) => e.name).sort());
  assert.equal(Array.from(mesh.edges.count).reduce((a, b) => a + b, 0), mesh.edges.positions.length / 3);
  assert.equal(mesh.vertices.positions.length, body.topo.vertices.length * 3);
  assert.deepEqual(mesh.bbox.map((v) => Math.round(v * 1e6) / 1e6), [0, 0, 0, 40, 20, 10]);
  // the top face's triangles are at z = 10 and face up
  const top = mesh.faces.names.indexOf("e1:end:ra");
  for (let i = mesh.faces.start[top]; i < mesh.faces.start[top] + mesh.faces.count[top]; i++) { near(mesh.positions[mesh.indices[i] * 3 + 2], 10); near(mesh.normals[mesh.indices[i] * 3 + 2], 1); }

  // the sketch comes back ready to draw
  assert.equal(r.sketches.length, 1);
  assert.equal(r.sketches[0].regions.length, 1);
  assert.equal(r.sketches[0].regions[0].holes.length, 1);
  assert.equal(r.sketches[0].curves.length, 5);
  engine.dispose();
});

test("only what changed is rebuilt; names survive a parameter change", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const doc = base();
  let r = await engine.regenerate(doc, 2);
  const rev = r.bodies[0].rev, names = engine.state.bodies[0].topo.faces.map((f) => f.name).sort();
  assert.equal(r.rebuiltFrom, 0);

  r = await engine.regenerate(doc, 2, [rev]);
  assert.equal(r.rebuiltFrom, 2, "nothing changed: nothing is evaluated");
  assert.ok(r.features.every((f) => f.cached));
  assert.equal(r.bodies[0].rev, rev);
  assert.equal(r.bodies[0].mesh, undefined, "the page already has that mesh");

  doc[1] = extrude("e1", "s1", { depth: 25 });
  doc[1].name = "Renamed too";
  r = await engine.regenerate(doc, 2, [rev]);
  assert.equal(r.rebuiltFrom, 1, "the sketch is not evaluated again");
  assert.equal(r.features[0].cached, true);
  assert.notEqual(r.bodies[0].rev, rev);
  assert.ok(r.bodies[0].mesh);
  near(volume(k, engine), (40 * 20 - Math.PI * 9) * 25, 1e-6);
  assert.deepEqual(engine.state.bodies[0].topo.faces.map((f) => f.name).sort(), names);

  // a rename alone rebuilds nothing
  doc[0] = { ...doc[0], name: "Base outline" };
  r = await engine.regenerate(doc, 2, [r.bodies[0].rev]);
  assert.equal(r.rebuiltFrom, 2);
  engine.dispose();
});

test("a sketch on a face, Add and Remove: names carry through booleans and a reference survives an upstream edit", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const top = { kind: "face", ref: { kind: "face", body: "e1", name: "e1:end:ra" } };
  const doc = [
    ...base(),
    sketch("s2", rect(25, 5, 35, 15, "b"), top),
    extrude("e2", "s2", { operation: "add", depth: 5 }),
    sketch("s3", { pc: { type: "point", x: 30, y: 10 }, pocket: { type: "circle", center: "pc", r: 2 } }, { kind: "face", ref: { kind: "face", body: "e1", name: "e2:end:ba" } }),
    extrude("e3", "s3", { operation: "remove", depth: 3, flip: true }),
  ];
  let r = await engine.regenerate(doc, doc.length);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok", "ok", "ok", "ok", "ok"], JSON.stringify(r.features));
  assert.equal(r.bodies.length, 1, "the boss joined the base");
  assert.equal(r.bodies[0].id, "e1", "the body keeps the id of the feature that made it");
  near(volume(k, engine), (40 * 20 - Math.PI * 9) * 10 + 10 * 10 * 5 - Math.PI * 4 * 3, 1e-6);
  const names = engine.state.bodies[0].topo.faces.map((f) => f.name).sort();
  for (const n of ["e1:start:ra", "e1:end:ra", "e1:side:hole", "e2:end:ba", "e2:side:ba", "e3:side:pocket", "e3:end:pocket"]) assert.ok(names.includes(n), `${n} in ${names.join(", ")}`);
  assert.equal(new Set(names).size, names.length);
  // the frame of the sketch on the top face: its plane is z = 10 and its normal points up
  const s2 = r.sketches.find((s) => s.featureId === "s2");
  near(s2.frame.normal[2], 1); near(s2.frame.origin[2], 10);

  // make the base thicker: the face the second sketch sits on moves, and everything follows it
  doc[1] = extrude("e1", "s1", { depth: 14 });
  r = await engine.regenerate(doc, doc.length);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok", "ok", "ok", "ok", "ok"], JSON.stringify(r.features));
  assert.equal(r.rebuiltFrom, 1);
  near(volume(k, engine), (40 * 20 - Math.PI * 9) * 14 + 10 * 10 * 5 - Math.PI * 4 * 3, 1e-6);
  near(r.sketches.find((s) => s.featureId === "s3").frame.origin[2], 19);
  assert.deepEqual(engine.state.bodies[0].topo.faces.map((f) => f.name).sort(), names, "the same names after the edit");

  // a service reads the model the page is looking at
  const svc = K.SERVICES.find((s) => s.name === "mass-properties");
  const mp = svc.run({ oc: k.oc, k, state: engine.state, fail: (m) => new Error(m) }, { body: "e1" });
  near(mp.volume, volume(k, engine));
  engine.dispose();
});

test("the rollback bar, suppression, reorder and errors", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const doc = [...base(), sketch("s2", rect(50, 0, 60, 10, "b")), extrude("e2", "s2", { depth: 4 })];
  let r = await engine.regenerate(doc, 4);
  assert.equal(r.bodies.length, 2);
  assert.deepEqual(r.bodies.map((b) => b.id), ["e1", "e2"]);

  // roll back to after the first extrude, and forward again: nothing is evaluated either time
  r = await engine.regenerate(doc, 2);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok", "rolled-back", "rolled-back"]);
  assert.equal(r.bodies.length, 1);
  assert.equal(r.rebuiltFrom, 4);
  r = await engine.regenerate(doc, 4);
  assert.equal(r.rebuiltFrom, 4);
  assert.equal(r.bodies.length, 2);

  // suppress the first sketch: its extrude fails with a message, the rest still builds
  const sup = doc.map((f, i) => (i === 0 ? { ...f, suppressed: true } : f));
  r = await engine.regenerate(sup, 4);
  assert.deepEqual(r.features.map((f) => f.status), ["suppressed", "error", "ok", "ok"]);
  assert.match(r.features[1].message, /sketch/i);
  assert.deepEqual(r.bodies.map((b) => b.id), ["e2"]);

  // reorder: an extrude moved before its sketch fails the same way
  r = await engine.regenerate([doc[1], doc[0], doc[2], doc[3]], 4);
  assert.deepEqual(r.features.map((f) => f.status), ["error", "ok", "ok", "ok"]);

  // an unknown feature type and a bad parameter are errors, not crashes
  r = await engine.regenerate([...doc, { id: "x", type: "warp-drive", name: "x", suppressed: false, params: {} }, extrude("e9", "s2", { depth: 0 })], 6);
  assert.deepEqual(r.features.slice(4).map((f) => f.status), ["error", "error"]);
  assert.match(r.features[5].message, /depth/i);
  assert.equal(r.bodies.length, 2);

  // an open outline makes no region: the sketch warns and the extrude says what to do
  const open = { ...rect(0, 0, 10, 10, "o") }; delete open.od;
  r = await engine.regenerate([sketch("s", open), extrude("e", "s")], 2);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "error"]);
  assert.match(r.features[1].message, /closed/i);
  assert.deepEqual(r.sketches[0].open, ["oa", "ob", "oc"]);

  // a face that does not exist
  r = await engine.regenerate([...base(), sketch("s2", rect(0, 0, 1, 1, "b"), { kind: "face", ref: { kind: "face", body: "e1", name: "nope" } })], 3);
  assert.equal(r.features[2].status, "error");
  assert.match(r.features[2].message, /no longer exists/);
  engine.dispose();
});

test("Remove that splits a body makes two bodies; Remove that misses warns", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const doc = [sketch("s1", rect(0, 0, 40, 20, "r")), extrude("e1", "s1"), sketch("s2", rect(18, -5, 22, 25, "c")), extrude("e2", "s2", { operation: "remove", depth: 30 })];
  let r = await engine.regenerate(doc, 4);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok", "ok", "ok"], JSON.stringify(r.features));
  assert.equal(r.bodies.length, 2);
  assert.equal(r.bodies[0].id, "e1");
  near(volume(k, engine, 0) + volume(k, engine, 1), 36 * 20 * 10);
  doc[3] = extrude("e2", "s2", { operation: "remove", depth: 30, flip: true });
  r = await engine.regenerate(doc, 4);
  assert.equal(r.features[3].status, "warning");
  assert.equal(r.bodies.length, 1);
  engine.dispose();
});
