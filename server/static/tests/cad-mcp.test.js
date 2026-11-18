// Node test for the mechanical domain's AI tools (web/domains/mechanical/mcp): the feature types taken from the
// registry, edits planned into item changes and validated, the plan run through the real kernel (a sketch and an
// extrude give the solid the numbers say), undo, and the picture drawn without a browser.
// Run: node server/static/tests/cad-mcp.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { load, server } = require("./cad-load");

const M = load("domains/mechanical/mcp/model.ts");
const R = load("domains/mechanical/mcp/render.ts");
const K = load("domains/mechanical/kernel/index.ts");
const F = load("domains/mechanical/document/format.ts");
const I = load("shared/itemdoc/itemdoc.ts");

const emptyDoc = () => I.parseItemDoc(F.newPartStudioText(), "part-studio");
const apply = (doc, plan) => { I.applyChanges(doc, plan.changes); return doc; };
const BLOCK = [
  { op: "add", type: "sketch", ref: "s", plane: "top", shapes: [{ type: "rectangle", x1: 0, y1: 0, x2: 40, y2: 20 }, { type: "circle", cx: 10, cy: 10, r: 3 }] },
  { op: "add", type: "extrude", params: { profile: "$s", depth: 10 } },
];

let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new K.Kernel(oc);
  return kernel;
}
async function build(doc) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const features = F.featuresOf(doc);
  const result = await engine.regenerate(F.featureInputs(features), F.rollbackIndex(doc, features));
  return { k, engine, result };
}

test("the feature types come from the registry, with what each parameter stores", () => {
  const t = M.featureTypes(K.FEATURES);
  const types = t.feature_types.map((f) => f.type);
  assert.deepEqual(types.slice().sort(), K.FEATURES.map((f) => f.type).sort());
  const extrude = t.feature_types.find((f) => f.type === "extrude");
  assert.deepEqual(extrude.defaults, K.FEATURES.find((f) => f.type === "extrude").defaults());
  const depth = extrude.parameters.find((p) => p.key === "depth");
  assert.equal(depth.kind, "number"); assert.match(depth.stores, /millimetres/); assert.equal(depth.min, 0.001);
  assert.deepEqual(extrude.parameters.find((p) => p.key === "operation").options, ["new", "add", "remove", "intersect"]);
  assert.match(t.feature_types.find((f) => f.type === "sketch").note, /rectangle/);
});

test("a sketch and an extrude are planned as two added features, the extrude using the sketch by its ref", () => {
  const doc = emptyDoc();
  const plan = M.planEdits(doc, K.FEATURES, BLOCK);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.changes.length, 2);
  assert.ok(plan.changes.every((c) => c.kind === "ADDED"));
  const [sketch, extrude] = plan.changes.map((c) => c.item);
  assert.equal(sketch.name, "Sketch 1"); assert.equal(extrude.name, "Extrude 1");
  assert.ok(sketch.order < extrude.order, "the extrude comes after the sketch");
  assert.deepEqual(extrude.params.profile, { sketch: sketch.id, regions: null });
  assert.deepEqual(sketch.params.plane, { kind: "plane", plane: "top" });
  const e = sketch.params.sketch.entities;
  assert.deepEqual(Object.keys(e).sort(), ["c1", "l1", "l2", "l3", "l4", "p1", "p2", "p3", "p4", "p5"]);
  assert.deepEqual(e.l4, { type: "line", a: "p4", b: "p1" });
  assert.deepEqual(e.c1, { type: "circle", center: "p5", r: 3 });
  // the document is not touched by planning
  assert.equal(F.featuresOf(doc).length, 0);
  assert.equal(F.featuresOf(plan.after).length, 2);
  assert.match(plan.done[0], /added sketch "Sketch 1"/);
});

test("the plan builds in the real kernel: the block's volume, and what a failing feature says", async () => {
  const doc = apply(emptyDoc(), M.planEdits(emptyDoc(), K.FEATURES, BLOCK));
  const { k, engine, result } = await build(doc);
  assert.deepEqual(result.features.map((f) => f.status), ["ok", "ok"]);
  assert.ok(Math.abs(k.volume(engine.state.bodies[0].shape) - (40 * 20 - Math.PI * 9) * 10) < 1e-6);
  const tree = M.treeOf(doc, result.features);
  assert.deepEqual(tree.features.map((f) => [f.index, f.name, f.type, f.status]), [[0, "Sketch 1", "sketch", "ok"], [1, "Extrude 1", "extrude", "ok"]]);
  assert.deepEqual(tree.features[0].params.sketch, { points: 5, lines: 4, circles: 1, arcs: 0 });
  assert.equal(M.treeOf(doc, null, { entities: true }).features[0].params.sketch.entities.p1.type, "point");

  // deepen it, cut a pocket from the top face, then break it
  const more = M.planEdits(doc, K.FEATURES, [
    { op: "set", feature: "Extrude 1", params: { depth: 25 } },
    { op: "add", type: "sketch", ref: "p", name: "Pocket sketch", plane: { kind: "face", ref: { kind: "face", body: engine.state.bodies[0].id, name: engine.state.bodies[0].topo.faces.find((f) => /:end:/.test(f.name)).name } }, shapes: [{ type: "circle", cx: 30, cy: 10, r: 4 }] },
    { op: "add", type: "extrude", name: "Pocket", params: { profile: "Pocket sketch", operation: "remove", depth: 5, flip: true } },
  ]);
  assert.deepEqual(more.problems, []);
  assert.equal(more.changes[0].kind, "MODIFIED");
  assert.deepEqual(more.changes[0].props, [{ path: ["params", "depth"], value: 25 }], "only the parameter that differs is sent");
  apply(doc, more);
  const second = await build(doc);
  assert.deepEqual(second.result.features.map((f) => f.status), ["ok", "ok", "ok", "ok"]);
  const expect = (40 * 20 - Math.PI * 9) * 25 - Math.PI * 16 * 5;
  assert.ok(Math.abs(second.k.volume(second.engine.state.bodies[0].shape) - expect) < 1e-4, `${second.k.volume(second.engine.state.bodies[0].shape)} is not ${expect}`);

  const broken = M.planEdits(doc, K.FEATURES, [{ op: "suppress", feature: "Sketch 1", suppressed: true }]);
  apply(doc, broken);
  const third = await build(doc);
  assert.equal(third.result.features[1].status, "error");
  assert.match(third.result.features[1].message, /sketch/i);
  // what undoes the last edit puts it back
  I.applyChanges(doc, broken.inverse);
  assert.equal((await build(doc)).result.features[1].status, "ok");
});

test("edits are checked against the registry and nothing is planned when one is wrong", () => {
  const doc = apply(emptyDoc(), M.planEdits(emptyDoc(), K.FEATURES, BLOCK));
  const p = M.planEdits(doc, K.FEATURES, [
    { op: "set", feature: "Extrude 1", params: { depth: -4 } },
    { op: "set", feature: "Extrude 1", params: { operation: "weld" } },
    { op: "add", type: "lathe" },
    { op: "set", feature: "No such" },
    { op: "add", type: "extrude", params: { profile: "Extrude 1" } },
    { op: "add", type: "sketch", shapes: [{ type: "circle", cx: 0, cy: 0, r: 0 }] },
    { op: "add", type: "extrude", params: { profile: "Sketch 1" }, index: 0 },
    { op: "fly" },
  ]);
  assert.equal(p.changes.length, 0);
  assert.equal(p.problems.length, 8);
  assert.match(p.problems[0], /edit 1 \(set\): depth must be at least 0.001/);
  assert.match(p.problems[1], /operation must be one of new, add, remove/);
  assert.match(p.problems[2], /unknown feature type "lathe"\. The types are: /);
  assert.match(p.problems[3], /there is no feature "No such"\. The features are: Sketch 1, Extrude 1/);
  assert.match(p.problems[4], /profile\.sketch must be the id of a sketch feature/);
  assert.match(p.problems[5], /radius r above zero/);
  assert.match(p.problems[6], /comes after this feature/);
  assert.match(p.problems[7], /unknown op "fly"/);
});

test("rename, move, rollback, delete, and the inverse that takes a whole plan back", () => {
  const doc = apply(emptyDoc(), M.planEdits(emptyDoc(), K.FEATURES, BLOCK));
  const before = I.serializeItemDoc(doc);
  const p = M.planEdits(doc, K.FEATURES, [
    { op: "add", type: "sketch", name: "Second", shapes: [{ type: "polygon", points: [[0, 0], [10, 0], [0, 10]] }], before: "Extrude 1" },
    { op: "rename", feature: "Extrude 1", name: "Base" },
    { op: "move", feature: "Second", index: 0 },
    { op: "rollback", before: "Base" },
    { op: "set", feature: "Sketch 1", entities: { p5: { type: "point", x: 30, y: 10 }, extra: { type: "point", x: 1, y: 1 } } },
    { op: "delete", feature: "Second" },
  ]);
  assert.deepEqual(p.problems, []);
  apply(doc, p);
  const features = F.featuresOf(doc);
  assert.deepEqual(features.map((f) => f.name), ["Sketch 1", "Base"]);
  assert.equal(F.rollbackIndex(doc), 1);
  assert.equal(features[0].params.sketch.entities.p5.x, 30);
  assert.ok(features[0].params.sketch.entities.extra && features[0].params.sketch.entities.c1, "entities patch single ids");
  I.applyChanges(doc, p.inverse);
  assert.equal(I.serializeItemDoc(doc), before);
  // undoing through applyRecorded gives the changes that redo it
  const again = M.applyRecorded(doc, p.changes);
  I.applyChanges(doc, again.applied);
  I.applyChanges(doc, again.inverse);
  assert.equal(I.serializeItemDoc(doc), before);
});

test("a picture of the block: a PNG with the body, its edges and the background", async () => {
  const doc = apply(emptyDoc(), M.planEdits(emptyDoc(), K.FEATURES, BLOCK));
  const { result } = await build(doc);
  const meshes = result.bodies.map((b) => b.mesh);
  for (const view of ["iso", "top", "front", "right"]) {
    const pic = R.renderMeshes(meshes, { width: 400, height: 300, view });
    assert.equal(pic.rgba.length, 400 * 300 * 4);
    const at = (x, y) => Array.from(pic.rgba.slice((y * 400 + x) * 4, (y * 400 + x) * 4 + 3));
    assert.deepEqual(at(2, 2), [0xf3, 0xf4, 0xf6], `${view}: the corner is background`);
    let body = 0, dark = 0;
    for (let i = 0; i < pic.rgba.length; i += 4) { const [r, g, b] = [pic.rgba[i], pic.rgba[i + 1], pic.rgba[i + 2]]; if (b > r + 15 && b > 90) body++; if (r < 70 && g < 80 && b < 90) dark++; }
    assert.ok(body > 400 * 300 * 0.15, `${view}: the body covers a good part of the picture (${body})`);
    assert.ok(dark > 200, `${view}: edges are drawn (${dark})`);
    if (view === "top") {
      // seen from above the hole at (10, 10) shows the background through the block
      const sx = Math.round(200 + (10 - 20) * (400 * 0.84 / 40)), sy = 150;
      assert.deepEqual(at(sx, sy), [0xf3, 0xf4, 0xf6], "the hole is a hole");
    }
  }
  const png = R.encodePng(R.renderMeshes(meshes, { width: 320, height: 240 }));
  assert.deepEqual(Array.from(png.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(Buffer.from(png.slice(12, 16)).toString(), "IHDR");
  assert.equal(new DataView(png.buffer).getUint32(16), 320);
  // the pixel data inflates to height rows of a filter byte and width RGBA pixels
  const idat = png.slice(8 + 25 + 8, png.length - 12 - 4);
  assert.equal(zlib.inflateSync(idat).length, 240 * (320 * 4 + 1));
  if (process.env.SHOTS) fs.writeFileSync(path.join(process.env.SHOTS, "cad-mcp-block.png"), R.encodePng(R.renderMeshes(meshes, { width: 900, height: 675 })));
});

test("the catalog lists the tools the host has, and every one is described", () => {
  const tools = JSON.parse(fs.readFileSync(path.join(server, "web", "domains", "mechanical", "mcp", "tools.json"), "utf8"));
  const host = fs.readFileSync(path.join(server, "web", "domains", "mechanical", "mcp", "host.ts"), "utf8");
  for (const t of tools) {
    assert.match(t.name, /^cad_/);
    assert.ok(host.includes(`${t.name}:`), `${t.name} has a function in mcp/host.ts`);
    assert.ok(t.description.length > 80 && t.input_schema.type === "object");
    if (t.input_schema.properties.project) assert.ok(t.input_schema.required.includes("project"));
  }
  assert.ok(tools.find((t) => t.name === "cad_edit_features").write);
});
