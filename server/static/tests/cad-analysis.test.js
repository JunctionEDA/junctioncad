// Node test for the inspection and analysis tools of the mechanical and assembly domains: the measure, mass
// properties, interference, clearance and body-brep worker services on the real kernel, the inertia arithmetic,
// and the pure page-side logic (the measure readout, the appearance and material items, the section plane, the
// assembly's broad phase and its combined bill of materials).
// Run: node server/static/tests/cad-analysis.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load, server } = require("./cad-load");

const K = load("domains/mechanical/kernel/index.ts");
const MM = load("domains/mechanical/services/_mass-math.ts");

let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new K.Kernel(oc);
  return kernel;
}

const rect = (x0, y0, x1, y1, p) => ({
  [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y0 }, [`${p}3`]: { type: "point", x: x1, y: y1 }, [`${p}4`]: { type: "point", x: x0, y: y1 },
  [`${p}a`]: { type: "line", a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: "line", a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: "line", a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: "line", a: `${p}4`, b: `${p}1` },
});
const sketch = (id, entities, plane = { kind: "plane", plane: "top" }) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, o = {}) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });
/** a 40 × 20 × 10 block with a 3 mm hole at (10, 10) */
const plate = () => [sketch("s1", { ...rect(0, 0, 40, 20, "r"), hc: { type: "point", x: 10, y: 10 }, hole: { type: "circle", center: "hc", r: 3 } }), extrude("e1", "s1")];
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const nearV = (a, b, eps = 1e-6) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i], eps)); };

async function model(features) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(features, features.length);
  assert.ok(r.features.every((f) => f.status === "ok"), JSON.stringify(r.features));
  const call = async (name, args) => {
    const svc = K.SERVICES.find((s) => s.name === name);
    assert.ok(svc, `service ${name}`);
    // as the worker does: wrappers handed out during the call are deleted after it
    const mine = []; k.scope = mine;
    try { return JSON.parse(JSON.stringify(await svc.run({ oc: k.oc, k, state: engine.state, fail: (m) => new Error(m) }, args))); }
    finally { k.scope = null; for (const o of mine.reverse()) { try { o.delete(); } catch (e) { /* gone */ } } }
  };
  return { k, engine, call };
}
const face = (name, body = "e1") => ({ kind: "face", body, name });
const edge = (name, body = "e1") => ({ kind: "edge", body, name });

test("the analysis services are registered", () => {
  for (const n of ["measure", "mass-properties", "interference", "clearance", "body-brep"]) assert.ok(K.SERVICES.some((s) => s.name === n), n);
});

test("measure one thing: exact area, perimeter, length, radius, axis and position from the B-rep", async () => {
  const { call } = await model(plate());
  const top = (await call("measure", { items: [face("e1:end:ra")] })).items[0];
  assert.equal(top.surface, "plane");
  near(top.area, 800 - 9 * Math.PI); near(top.perimeter, 120 + 6 * Math.PI);
  nearV(top.normal, [0, 0, 1]);
  nearV(top.centroid.slice(2), [10]);

  const hole = (await call("measure", { items: [face("e1:side:hole")] })).items[0];
  assert.equal(hole.surface, "cylinder");
  near(hole.radius, 3); near(Math.abs(hole.axis[2]), 1); nearV(hole.center, [10, 10, 5]);
  near(hole.area, 2 * Math.PI * 3 * 10);
  near(hole.perimeter, 2 * 2 * Math.PI * 3, 1e-6);   // the two circles, not the seam

  const long = (await call("measure", { items: [edge("edge(e1:end:ra|e1:side:ra)")] })).items[0];
  assert.equal(long.curve, "line"); near(long.length, 40); near(Math.abs(long.direction[0]), 1);
  const ring = (await call("measure", { items: [edge("edge(e1:end:ra|e1:side:hole)")] })).items[0];
  assert.equal(ring.curve, "circle"); near(ring.radius, 3); assert.equal(ring.closed, true); near(ring.length, 6 * Math.PI); nearV(ring.center, [10, 10, 10]);

  const v = (await call("measure", { items: [{ kind: "vertex", body: "e1", name: "vertex(e1:end:ra|e1:side:ra|e1:side:rb)" }] })).items[0];
  nearV(v.point, [40, 0, 10]);

  const totals = await call("measure", { items: [face("e1:end:ra"), face("e1:start:ra"), face("e1:side:ra")] });
  near(totals.totals.area, 2 * (800 - 9 * Math.PI) + 400);
  assert.equal(totals.pair, undefined);
});

test("measure two things: shortest distance, centre to centre, angle and the gap between parallel planes", async () => {
  const { call } = await model(plate());
  const caps = (await call("measure", { items: [face("e1:end:ra"), face("e1:start:ra")] })).pair;
  near(caps.min.distance, 10); near(caps.normalDistance, 10); near(caps.angle, 0);
  near(Math.abs(caps.min.a[2] - caps.min.b[2]), 10);

  const sides = (await call("measure", { items: [face("e1:side:ra"), face("e1:side:rb")] })).pair;
  near(sides.angle, 90); near(sides.min.distance, 0);
  assert.equal(sides.normalDistance, undefined);

  // a point to a hole: centre to centre is square to the hole's axis
  const toHole = (await call("measure", { items: [{ kind: "vertex", body: "e1", name: "vertex(e1:end:ra|e1:side:ra|e1:side:rd)" }, face("e1:side:hole")] })).pair;
  near(toHole.centre.distance, Math.hypot(10, 10));
  near(toHole.min.distance, Math.hypot(10, 10) - 3, 1e-5);

  // a default plane: the top face is 10 above Top; an edge along X lies at 90° to the Right plane
  const toTop = (await call("measure", { items: [face("e1:end:ra"), { kind: "plane", plane: "top" }] })).pair;
  near(toTop.min.distance, 10); near(toTop.normalDistance, 10);
  const lineToRight = (await call("measure", { items: [edge("edge(e1:end:ra|e1:side:ra)"), { kind: "plane", plane: "right" }] })).pair;
  near(lineToRight.angle, 90);
  const lineToTop = (await call("measure", { items: [edge("edge(e1:end:ra|e1:side:ra)"), { kind: "plane", plane: "top" }] })).pair;
  near(lineToTop.angle, 0);

  // two parallel edges: the distance between the lines
  const edges = (await call("measure", { items: [edge("edge(e1:end:ra|e1:side:ra)"), edge("edge(e1:end:ra|e1:side:rc)")] }));
  near(edges.pair.normalDistance, 20); near(edges.totals.length, 80);

  await assert.rejects(call("measure", { items: [face("gone")] }), /no longer in the model/);
});

test("mass properties: volume, area, mass, centre, inertia tensor, principal moments and box against the formulas", async () => {
  const { call } = await model([sketch("s1", rect(0, 0, 40, 20, "r")), extrude("e1", "s1")]);
  const r = await call("mass-properties", { bodies: null, density: { e1: 7.85 } });
  const p = r.parts[0];
  near(p.volume, 8000); near(p.area, 2 * (800 + 400 + 200)); nearV(p.centre, [20, 10, 5]);
  nearV(p.bbox, [0, 0, 0, 40, 20, 10], 1e-6);
  const m = 8000 * 7.85e-6;
  near(p.mass, m);
  near(p.inertia.xx, (m * (20 * 20 + 10 * 10)) / 12, 1e-6); near(p.inertia.yy, (m * (40 * 40 + 10 * 10)) / 12, 1e-6); near(p.inertia.zz, (m * (40 * 40 + 20 * 20)) / 12, 1e-6);
  for (const k of ["xy", "xz", "yz"]) assert.ok(Math.abs(p.inertia[k]) < 1e-9, k);
  nearV(r.total.principal.moments, [p.inertia.xx, p.inertia.yy, p.inertia.zz].sort((a, b) => a - b), 1e-6);
  // the old one-body form still answers
  const one = await call("mass-properties", { body: "e1" });
  near(one.volume, 8000); assert.equal(one.parts[0].mass, null); assert.equal(one.total.mass, null);
  await assert.rejects(call("mass-properties", { body: "nope" }), /no longer exists/);
});

test("mass properties of two bodies: the parallel-axis theorem about the common centre", async () => {
  const { call } = await model([sketch("s1", rect(0, 0, 10, 10, "a")), extrude("e1", "s1"), sketch("s2", rect(20, 0, 30, 10, "b")), extrude("e2", "s2")]);
  const r = await call("mass-properties", { density: { e1: 1, e2: 1 } });
  assert.equal(r.parts.length, 2);
  const m = 1000e-6, ic = (m * 200) / 12;
  near(r.total.mass, 2 * m); nearV(r.total.centre, [15, 5, 5]);
  near(r.total.inertia.xx, 2 * ic, 1e-6); near(r.total.inertia.yy, 2 * ic + 2 * m * 100, 1e-6); near(r.total.inertia.zz, 2 * ic + 2 * m * 100, 1e-6);
  nearV(r.total.bbox, [0, 0, 0, 30, 10, 10], 1e-6);
  // one body without a material: no total mass, the centre is by volume
  const half = await call("mass-properties", { density: { e1: 2 } });
  assert.equal(half.total.mass, null); nearV(half.total.centre, [15, 5, 5]);
});

test("inertia arithmetic: a rotated tensor's principal moments, and combining is order-free", () => {
  const c = Math.cos(0.3), s = Math.sin(0.3);
  // diag(1, 4, 9) turned 0.3 rad about z: R D Rᵀ
  const t = { xx: c * c * 1 + s * s * 4, yy: s * s * 1 + c * c * 4, zz: 9, xy: c * s * (1 - 4), xz: 0, yz: 0 };
  const p = MM.principal(t);
  nearV(p.moments, [1, 4, 9], 1e-9);
  near(Math.abs(p.axes[0][0]), c, 1e-9); near(Math.abs(p.axes[0][1]), s, 1e-9);
  const parts = [{ mass: 2, centre: [1, 2, 3], inertia: t }, { mass: 3, centre: [-1, 0, 4], inertia: MM.ZERO_TENSOR }];
  const a = MM.combine(parts), b = MM.combine(parts.slice().reverse());
  for (const k of ["xx", "yy", "zz", "xy", "xz", "yz"]) near(a.inertia[k], b.inertia[k], 1e-12);
  nearV(a.centre, [(2 - 3) / 5, 4 / 5, (6 + 12) / 5], 1e-12);
});

test("interference: shapes go between workers as BRep text, overlapping placements give the exact common volume", async () => {
  const { call } = await model(plate());
  const { bodies } = await call("body-brep", {});
  assert.equal(bodies.length, 1); assert.ok(bodies[0].brep.length > 100); nearV(bodies[0].bbox, [0, 0, 0, 40, 20, 10], 1e-6);
  const brep = bodies[0].brep;
  const at = (x) => [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0];
  // a fresh worker has not seen the key: it asks for the text
  const ask = await call("interference", { shapes: [{ key: "plate-test-1", transform: at(0) }, { key: "plate-test-1", transform: at(30) }] });
  assert.deepEqual(ask.missing, ["plate-test-1"]);
  const r = await call("interference", { shapes: [{ key: "plate-test-1", brep, transform: at(0) }, { key: "plate-test-1", transform: at(30) }], mesh: true });
  assert.equal(r.missing.length, 0); assert.equal(r.checked, 1); assert.equal(r.clashes.length, 1);
  // x 30 … 40 of the first plate, less the half of the second plate's hole that reaches into it
  near(r.clashes[0].volume, (10 * 20 - 4.5 * Math.PI) * 10, 1e-6);
  nearV(r.clashes[0].bbox.map((v) => Math.round(v * 1e3) / 1e3), [30, 0, 0, 40, 20, 10]);
  assert.ok(r.clashes[0].mesh.indices.length >= 3 && r.clashes[0].mesh.positions.length % 3 === 0);
  // apart, and face to face: no clash
  const apart = await call("interference", { shapes: [{ key: "plate-test-1", transform: at(0) }, { key: "plate-test-1", transform: at(45) }] });
  assert.equal(apart.clashes.length, 0); assert.equal(apart.checked, 0);
  const touching = await call("interference", { shapes: [{ key: "plate-test-1", transform: at(0) }, { key: "plate-test-1", transform: at(40) }] });
  assert.equal(touching.clashes.length, 0); assert.equal(touching.checked, 1);
  // only the listed pairs are checked
  const listed = await call("interference", { shapes: [{ key: "plate-test-1", transform: at(0) }, { key: "plate-test-1", transform: at(30) }, { key: "plate-test-1", transform: at(35) }], pairs: [[0, 2]] });
  assert.equal(listed.clashes.length, 1); assert.deepEqual([listed.clashes[0].a, listed.clashes[0].b], [0, 2]);
});

test("clearance: the smallest gap between two placed solids, and where it is", async () => {
  const { call } = await model(plate());
  const { bodies } = await call("body-brep", { bodies: ["e1"] });
  const quarter = [0, -1, 0, 70, 1, 0, 0, 0, 0, 0, 1, 0];   // turned 90° about z, then moved to x = 70
  const r = await call("clearance", { shapes: [{ key: "plate-test-2", brep: bodies[0].brep, transform: null }, { key: "plate-test-2", transform: quarter }] });
  // turned, the copy spans x 50 … 70: a 10 mm gap to the first plate's end at x = 40
  near(r.results[0].distance, 10, 1e-7);
  near(r.results[0].pa[0], 40, 1e-7); near(r.results[0].pb[0], 50, 1e-7);
});


// ---------------------------------------------------------------- the assembly: broad phase and the checks through the worker
const AI = load("domains/assembly/services/interference.ts");

test("the broad phase: boxes carried by transforms, and only the pairs whose boxes overlap", () => {
  const turned = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];   // 90° about z
  assert.deepEqual(AI.worldBox([0, 0, 0, 40, 20, 10], turned).map((v) => Math.round(v * 1e9) / 1e9), [-20, 0, 0, 0, 40, 10]);
  const boxes = [[0, 0, 0, 10, 10, 10], [5, 5, 5, 15, 15, 15], [20, 0, 0, 30, 10, 10], [9, 20, 0, 12, 30, 10], [10, 0, 10, 20, 10, 20]];
  // boxes that only touch are candidates: the kernel decides whether they overlap
  assert.deepEqual(AI.candidatePairs(boxes), [[0, 1], [0, 4], [1, 4], [2, 4]]);
  // the same as checking every pair, with or without a gap
  for (const gap of [0, 3, 10]) {
    const all = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; if (a[0] <= b[3] + gap && b[0] <= a[3] + gap && a[1] <= b[4] + gap && b[1] <= a[4] + gap && a[2] <= b[5] + gap && b[2] <= a[5] + gap) all.push([i, j]); }
    assert.deepEqual(AI.candidatePairs(boxes, gap), all, `gap ${gap}`);
  }
  assert.notEqual(AI.textHash("abc"), AI.textHash("abd"));
  assert.equal(AI.textHash("abc"), AI.textHash("abc"));
});

test("interference of assembly instances, through the worker services: keys first, BRep text only when asked", async () => {
  const { call } = await model(plate());
  const { bodies } = await call("body-brep", {});
  const sent = [];
  const worker = async (service, args) => { sent.push(args.shapes.filter((s) => s.brep).length); return call(service, args); };
  const at = (x, y = 0) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, 0];
  const key = `doc:e1:${AI.textHash(bodies[0].brep)}`;
  const shape = (instance, t) => ({ instance, key, brep: bodies[0].brep, bbox: bodies[0].bbox, transform: t });
  const r = await AI.checkInterference([shape("i1", at(0)), shape("i2", at(30)), shape("i3", at(0, 100)), shape("i4", at(35, 5))], worker);
  assert.equal(r.candidates, 3);   // i1–i2, i1–i4, i2–i4; i3 is far away
  assert.deepEqual(r.clashes.map((c) => `${c.a}|${c.b}`).sort(), ["i1|i2", "i1|i4", "i2|i4"]);
  near(r.clashes.find((c) => c.a === "i1" && c.b === "i2").volume, (10 * 20 - 4.5 * Math.PI) * 10, 1e-6);
  assert.deepEqual(sent, [0, 4], "the text went once, after the worker asked for it");
  sent.length = 0;
  await AI.checkInterference([shape("i1", at(0)), shape("i2", at(30))], worker);
  assert.deepEqual(sent, [0], "a shape the worker has is not sent again");
  const g = await AI.clearance(shape("i1", at(0)), shape("i3", at(0, 100)), worker);
  near(g.distance, 80, 1e-9);
  assert.deepEqual((await AI.checkInterference([shape("i1", at(0)), shape("i3", at(0, 100))], worker)).clashes, []);
});

// ---------------------------------------------------------------- the combined bill of materials
require(path.join(server, "static", "kicad-canvas.js"));
const PB = load("domains/pcb/parts/bom-export.ts");
const BOM = load("domains/assembly/services/bom.ts");
const fp = (lib, ref, val, x, extra = "") => `  (footprint "${lib}" (layer "F.Cu") (uuid "u-${ref}") (at ${x} 10)
    (property "Reference" "${ref}" (at 0 -1.5 0) (layer "F.SilkS") (uuid "r-${ref}") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "${val}" (at 0 1.5 0) (layer "F.Fab") (uuid "v-${ref}") (effects (font (size 1 1) (thickness 0.15))))${extra}
  )`;
const boardText = `(kicad_pcb (version 20240108) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
${fp("Resistor_SMD:R_0603_1608Metric", "R2", "10k", 20, ` (property "LCSC" "C25804" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "l-R2"))`)}
${fp("Resistor_SMD:R_0603_1608Metric", "R1", "10k", 10, ` (property "LCSC" "C25804" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "l-R1"))`)}
${fp("Capacitor_SMD:C_0402_1005Metric", "C1", "100n", 30, ` (property "MPN" "GRM155R71C104KA88D" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "m-C1"))`)}
${fp("MountingHole:MountingHole_3.2mm_M3", "H1", "MountingHole", 40, " (attr exclude_from_bom)")}
)`;

test("the electronics domain's documented export: a board's BOM lines, grouped as its BOM window groups them", () => {
  const lines = PB.electronicBom(boardText, "kicad_pcb", globalThis.KiCadCanvas);
  assert.deepEqual(lines.map((l) => [l.refs.join(" "), l.quantity, l.value]), [["C1", 1, "100n"], ["R1 R2", 2, "10k"]]);
  assert.equal(lines[1].vendor, "lcsc"); assert.equal(lines[1].vendorId, "C25804"); assert.equal(lines[0].mpn, "GRM155R71C104KA88D");
  assert.ok(!lines.some((l) => l.refs.includes("H1")), "a footprint excluded from the BOM stays out");
});

test("the combined bill of materials: parts by body with quantities, then each board and its parts times the boards", () => {
  const inst = (id, name, source, o = {}) => ({ id, type: "instance", name, order: id, source, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], ...o });
  const docs = [{ docId: "P", path: "mech/Bracket.jpart", docType: "part_studio" }, { docId: "B", path: "Controller.kicad_pcb", docType: "kicad_pcb" }, { docId: "Q", path: "Spacer.jpart", docType: "part_studio" }];
  const instances = [
    inst("a", "Bracket <1>", { kind: "part", docId: "P", body: "e1" }), inst("b", "Bracket <2>", { kind: "part", docId: "P", body: "e1" }),
    inst("c", "Lid <1>", { kind: "part", docId: "P", body: "e2" }), inst("d", "Controller <1>", { kind: "board", docId: "B" }),
    inst("e", "Controller <2>", { kind: "board", docId: "B" }), inst("f", "Spacer <1>", { kind: "part", docId: "Q", body: "s1" }),
    inst("g", "Bracket <3>", { kind: "part", docId: "P", body: "e1" }, { suppressed: true }),
  ];
  const rows = BOM.combinedBom({
    instances, docs,
    parts: { P: { e1: { name: "Bracket", material: "Steel" }, e2: { name: "Lid" } } },
    boards: { B: PB.electronicBom(boardText, "kicad_pcb", globalThis.KiCadCanvas) },
  });
  assert.deepEqual(rows.map((r) => [r.item, r.kind, r.name, r.description, r.quantity]), [
    ["1", "part", "Bracket", "Bracket", 2], ["2", "part", "Lid", "Bracket", 1], ["3", "part", "Spacer", "Spacer", 1],
    ["4", "board", "Controller", "Board", 2], ["4.1", "component", "100n", "100n", 2], ["4.2", "component", "10k", "10k", 4],
  ]);
  assert.equal(rows[0].material, "Steel"); assert.deepEqual(rows[0].instances, ["a", "b"]);
  assert.equal(rows[5].refs, "R1 R2"); assert.equal(rows[5].vendorPart, "lcsc C25804");
  const csv = BOM.bomCsv(rows).split("\r\n");
  assert.equal(csv[0], "Item,Type,Name,Description,Quantity,References,Footprint,MPN,Manufacturer,Vendor part,Material");
  assert.equal(csv[1], "1,Part,Bracket,Bracket,2,,,,,,Steel");
  assert.equal(csv[6], "4.2,Electronic part,10k,10k,4,R1 R2,Resistor_SMD:R_0603_1608Metric,,,lcsc C25804,");
  // a board that could not be read says why; a quote in a name is escaped
  const bad = BOM.combinedBom({ instances: [inst("x", 'Odd "name" <1>', { kind: "part", docId: "Z", body: "q" }), inst("y", "B", { kind: "board", docId: "B" })], docs, boards: { B: { error: "The board has no stored file yet." } } });
  assert.equal(bad[1].note, "The board has no stored file yet.");
  assert.ok(BOM.bomCsv(bad).includes('"Odd ""name"""'));
});

// ---------------------------------------------------------------- the page's pure parts: readout, document items, section plane
const F = load("domains/mechanical/inspect/measure-format.ts");
const AP = load("domains/mechanical/document/appearance-items.ts");
const MAT = load("domains/mechanical/document/mass-materials.ts");
const SP = load("domains/mechanical/inspect/section-plane.ts");
const ID = load("shared/itemdoc/itemdoc.ts");

test("the measure readout: rows, units, and what a click copies", () => {
  assert.equal(F.num(12.5), "12.5"); assert.equal(F.num(-0.0001), "0"); assert.equal(F.num(3), "3"); assert.equal(F.copyNum(1 / 3), "0.333333333");
  assert.equal(F.kg(0.2477), "247.7 g"); assert.equal(F.kg(2.5), "2.5 kg");
  const circle = F.readout({ items: [{ kind: "edge", curve: "circle", closed: true, radius: 3, length: 6 * Math.PI, center: [1, 2, 3], centroid: [1, 2, 3] }], totals: {} });
  assert.equal(circle.title, "Circle");
  assert.deepEqual(circle.rows.slice(0, 3).map((r) => [r.label, r.text]), [["Circumference", "18.85 mm"], ["Radius", "3 mm"], ["Diameter", "6 mm"]]);
  const pair = F.readout({ items: [{ kind: "face", surface: "plane", centroid: [0, 0, 0] }, { kind: "vertex", point: [3, 4, 0], centroid: [3, 4, 0] }], pair: { min: { distance: 5, a: [0, 0, 0], b: [3, 4, 0] }, centre: { distance: 5, a: [0, 0, 0], b: [3, 4, 0] } }, totals: {} });
  assert.equal(pair.title, "Plane face and vertex");
  assert.deepEqual(pair.rows.map((r) => r.key), ["min", "min.dx", "min.dy", "min.dz"], "centre to centre is left out when it is the same distance");
  assert.equal(pair.rows[1].copy, "3");
  const many = F.readout({ items: [{ kind: "face", area: 2, centroid: [0, 0, 0] }, { kind: "face", area: 3, centroid: [0, 0, 0] }, { kind: "face", area: 4, centroid: [0, 0, 0] }], totals: { area: 9 } });
  assert.deepEqual(many.rows.map((r) => [r.label, r.text]), [["Total area", "9 mm²"]]);
});

test("appearance and materials are items of the part studio: changes, merging by body and face, cleaning", () => {
  const doc = ID.newItemDoc("part-studio", [{ id: "studio", type: "studio", units: "mm", rollback: null }]);
  const apply = (changes) => ID.applyChanges(doc, changes);
  apply(AP.setBodyLook(doc, ["b1"], { color: "#AABBCC" }));
  apply(AP.setBodyLook(doc, ["b2"], { opacity: 0.3 }));
  apply(AP.setFaceColor(doc, [{ body: "b1", name: "f:end:r" }], "#112233"));
  assert.deepEqual(AP.looksOf(doc), { b1: { color: "#aabbcc", faces: { "f:end:r": "#112233" } }, b2: { opacity: 0.3 } });
  // a change to one body touches only that body's path, so two people's edits to different bodies both land
  const c = AP.setBodyLook(doc, ["b2"], { color: "#000000" })[0];
  assert.equal(c.kind, "MODIFIED"); assert.ok(c.props.every((p) => p.path[0] === "bodies" && p.path[1] === "b2"), JSON.stringify(c.props));
  assert.deepEqual(AP.setBodyLook(doc, ["b1"], { color: "red" }), [], "a colour that is not #rrggbb is refused");
  apply(AP.setFaceColor(doc, [{ body: "b1", name: "f:end:r" }], null));
  apply(AP.resetLook(doc, ["b2"]));
  assert.deepEqual(AP.looksOf(doc), { b1: { color: "#aabbcc" } });
  apply(AP.setBodyLook(doc, ["b1"], { opacity: 5 }));
  assert.equal(AP.looksOf(doc).b1.opacity, 1);
  // named views
  apply(AP.addNamedView(doc, "Top", { quaternion: [0, 0, 0, 1], target: [0, 0, 0], zoom: 1, projection: "orthographic" }));
  apply(AP.addNamedView(doc, "", { quaternion: [0, 0, 0, 1], target: [1, 0, 0], zoom: 2, projection: "perspective" }));
  apply(AP.addNamedView(doc, "Top", { quaternion: [0, 0, 1, 0], target: [0, 0, 0], zoom: 3, projection: "orthographic" }));
  const views = AP.namedViews(doc);
  assert.deepEqual(views.map((v) => [v.name, v.camera.zoom]), [["Top", 3], ["View 2", 2]]);
  apply(AP.removeNamedView(doc, views[0].id));
  assert.equal(AP.namedViews(doc).length, 1);
  // materials: the starter library until something is assigned, then the item with the library in it
  assert.equal(MAT.materialsOf(doc).stored, false);
  assert.deepEqual(MAT.assignMaterial(doc, ["b1"], "unobtainium"), []);
  const add = MAT.assignMaterial(doc, ["b1", "b2"], "steel");
  assert.equal(add[0].kind, "ADDED"); assert.equal(add[0].item.library.aluminium.density, 2.7);
  apply(add);
  assert.deepEqual(MAT.densities(doc), { b1: 7.85, b2: 7.85 });
  apply(MAT.defineMaterial(doc, "peek", { name: "PEEK", density: 1.3, color: "#c8b48c" }));
  apply(MAT.assignMaterial(doc, ["b2"], "peek"));
  assert.equal(MAT.materialOf(doc, "b2").name, "PEEK");
  apply(MAT.assignMaterial(doc, ["b1"], null));
  assert.deepEqual(MAT.densities(doc), { b2: 1.3 });
  // a reader keeps the items: they survive the file round trip
  const again = ID.parseItemDoc(ID.serializeItemDoc(doc), "part-studio");
  assert.deepEqual(MAT.densities(again), { b2: 1.3 }); assert.deepEqual(AP.looksOf(again), AP.looksOf(doc));
});

test("the section plane: which side is kept, the offset, flip, and the model's extent along the normal", () => {
  const p = SP.clipPlane({ origin: [0, 0, 0], normal: [0, 0, 1], offset: 5, flip: false });
  const V = (x, y, z) => ({ x, y, z });
  assert.ok(p.distanceToPoint(V(0, 0, 4)) > 0, "below the plane is kept");
  assert.ok(p.distanceToPoint(V(0, 0, 6)) < 0, "above it is cut away");
  const f = SP.clipPlane({ origin: [0, 0, 0], normal: [0, 0, 1], offset: 5, flip: true });
  assert.ok(f.distanceToPoint(V(0, 0, 6)) > 0 && f.distanceToPoint(V(0, 0, 4)) < 0);
  assert.deepEqual(SP.extentAlong([[0, 0, 0, 40, 20, 10], [50, 0, 0, 60, 10, 30]], [0, 0, 0], [0, -1, 0]), [-20, 0]);
  assert.deepEqual(SP.extentAlong([[0, 0, 0, 40, 20, 10]], [0, 0, 10], [0, 0, 1]), [-10, 0]);
});
