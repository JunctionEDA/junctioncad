// Node test for the assembly's model layer with the real kernel: implicit mate connectors inferred from a part's
// tessellation (connectors/infer.ts), the document edits (document/edits.ts), and the path from a document to
// the solver and back (model/problem.ts), including an assembly following a part that is rebuilt.
// Run: node server/static/tests/assembly-model.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load, server } = require("./cad-load");
const K = load("domains/mechanical/kernel/index.ts");
const D = load("shared/itemdoc/itemdoc.ts");
const F = load("domains/assembly/document/format.ts");
const E = load("domains/assembly/document/edits.ts");
const C = load("domains/assembly/connectors/infer.ts");
const P = load("domains/assembly/model/problem.ts");
const M = load("domains/assembly/solver/math.ts");
const G = load("domains/assembly/generated/page.ts");

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
const sketch = (id, entities) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane: { kind: "plane", plane: "top" }, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, depth) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth, flip: false, targets: [] } });
/** a 100 × 60 box with a ⌀6 hole at (10, 10), and a 100 × 60 × 5 lid; `height` is the box's */
async function build(features) { const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES); const r = await engine.regenerate(features, features.length); const out = {}; for (const b of r.bodies) out[b.id] = b.mesh; engine.dispose(); return out; }
const box = (height) => build([sketch("s1", { ...rect(0, 0, 100, 60, "r"), hc: { type: "point", x: 10, y: 10 }, hole: { type: "circle", center: "hc", r: 3 } }), extrude("box", "s1", height)]);
const lid = () => build([sketch("s2", rect(0, 0, 100, 60, "q")), extrude("lid", "s2", 5)]);
const nearV = (a, b, eps = 1e-4, what = "") => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= eps, `${what}[${i}] ${v} is not ${b[i]}`));

test("implicit connectors: a flat face, a hole, a circular edge, a straight edge, a vertex", async () => {
  const mesh = (await box(40)).box;
  const top = C.connectorOf(mesh, { kind: "face", name: "box:end:ra" });
  assert.equal(top.surface, "plane"); nearV(top.o, [50, 30, 40]); nearV(top.z, [0, 0, 1]);
  nearV(M.cross(top.x, top.y), top.z, 1e-9, "right-handed");
  const bottom = C.connectorOf(mesh, { kind: "face", name: "box:start:ra" });
  nearV(bottom.z, [0, 0, -1], 1e-6, "the outward normal"); nearV(bottom.o, [50, 30, 0]);
  const hole = C.connectorOf(mesh, { kind: "face", name: "box:side:hole" });
  assert.equal(hole.surface, "cylinder"); assert.ok(Math.abs(hole.radius - 3) < 1e-4, `radius ${hole.radius}`);
  nearV(hole.o, [10, 10, 20]); nearV(hole.z, [0, 0, 1]);
  const rim = C.connectorOf(mesh, { kind: "edge", name: "edge(box:end:ra|box:side:hole)" });
  assert.equal(rim.surface, "circle"); nearV(rim.o, [10, 10, 40]); nearV(rim.z, [0, 0, 1]); assert.ok(Math.abs(rim.radius - 3) < 1e-4);
  const back = C.connectorOf(mesh, { kind: "edge", name: "edge(box:end:ra|box:side:rc)" });
  assert.equal(back.surface, "line"); nearV(back.o, [50, 60, 40]); nearV(back.z, [1, 0, 0]);
  const corner = C.connectorOf(mesh, { kind: "vertex", name: "vertex(box:end:ra|box:side:ra|box:side:rb)" });
  assert.equal(corner.surface, "point"); nearV(corner.o, [100, 0, 40]);
  assert.equal(C.connectorOf(mesh, { kind: "face", name: "no-such-face" }), null);
  assert.equal(C.connectorOf(mesh, { kind: "face", name: "box:end:ra" }), top, "cached per mesh");
  assert.match(C.describeConnector(hole, "face"), /Cylinder ⌀6/);
});

const part = (docId, body) => ({ kind: "part", docId, body });
function assembly() {
  const doc = D.parseItemDoc(F.newAssemblyText(), F.ASSEMBLY_KIND);
  const commit = (changes) => D.applyChanges(doc, changes);
  return { doc, commit };
}

test("edits: insert, names, flags, groups, copies, positions, and a delete that takes the mates with it", () => {
  const { doc, commit } = assembly();
  const ins = E.insertInstances(doc, [{ source: part("d1", "box"), name: "Box" }, { source: part("d2", "lid"), name: "Lid" }, { source: part("d2", "lid"), name: "Lid" }]);
  commit(ins.changes);
  assert.deepEqual(F.instancesOf(doc).map((i) => i.name), ["Box", "Lid", "Lid 2"]);
  const [b, l1, l2] = ins.items.map((i) => i.id);
  commit(E.setFixed(doc, [b], true)); commit(E.setHidden(doc, [l2], true)); commit(E.setSuppressed(doc, [l2], true)); commit(E.renameItem(doc, l1, "  Cover "));
  assert.deepEqual([doc.items.get(b).fixed, doc.items.get(l2).hidden, doc.items.get(l2).suppressed, doc.items.get(l1).name], [true, true, true, "Cover"]);
  commit(E.setHidden(doc, [l2], false));
  assert.equal("hidden" in doc.items.get(l2), false, "a cleared flag is removed, not stored as false");
  const mate = E.addMate(doc, { mateType: "revolute", name: "Hinge", a: { instance: b, ref: { kind: "edge", body: "box", name: "e" } }, b: { instance: l1, ref: { kind: "edge", body: "lid", name: "f" } }, params: {} });
  commit(mate.changes);
  commit(E.updateMate(doc, mate.item.id, { params: { limits: true, angleMin: -90, angleMax: 0 } }));
  assert.equal(F.matesOf(doc)[0].params.angleMin, -90);
  // placements: only what changed is written, and numbers are rounded to a nanometre
  const t = F.IDENTITY.slice(); t[3] = 12.3456789012345; t[0] = 1 - 1e-13;
  const changes = E.setTransforms(doc, new Map([[l1, t], [b, F.IDENTITY]]));
  assert.equal(changes.length, 1); commit(changes);
  assert.deepEqual(doc.items.get(l1).transform.slice(0, 4), [1, 0, 0, 12.345678901]);
  assert.equal(E.setTransforms(doc, new Map([[l1, t]])).length, 0, "the same placement again changes nothing");
  // groups
  const g = E.groupInstances(doc, [l1, l2]); commit(g.changes);
  assert.equal(E.groupsOf(doc)[0].name, "Group 1"); assert.equal(doc.items.get(l2).group, g.group.id);
  // copies in a row
  const copies = E.copyInstances(doc, [l1], 3, [0, 0, 10]); commit(copies.changes);
  assert.deepEqual(copies.items.map((i) => [i.name, i.transform[11]]), [["Cover 2", 10], ["Cover 3", 20], ["Cover 4", 30]]);
  // a named position, then delete the lid: the mate and the saved placement go with it; the group stays
  const pos = E.savePosition(doc, new Map([[l1, t], [l2, F.IDENTITY]])); commit(pos.changes);
  commit(E.deleteItems(doc, [l1]));
  assert.equal(F.matesOf(doc).length, 0); assert.equal(doc.items.has(l1), false);
  assert.deepEqual(Object.keys(E.positionsOf(doc)[0].transforms), [l2]);
  commit(E.deleteItems(doc, [g.group.id]));
  assert.equal(E.groupsOf(doc).length, 0); assert.equal("group" in doc.items.get(l2), false, "ungrouped, not deleted");
});

test("a lid hinged on a box from real geometry; the assembly follows when the box is made taller", async () => {
  const lidMesh = (await lid()).lid;
  let boxMesh = (await box(40)).box;
  const { doc, commit } = assembly();
  const ins = E.insertInstances(doc, [{ source: part("d1", "box"), name: "Box", fixed: true }, { source: part("d2", "lid"), name: "Lid", transform: [1, 0, 0, 150, 0, 1, 0, 20, 0, 0, 1, 80] }]);
  commit(ins.changes);
  const [b, l] = ins.items.map((i) => i.id);
  const geometry = { frame: (inst, ref) => C.connectorOf(inst.id === b ? boxMesh : lidMesh, ref) };
  // the hinge: the box's back top edge to the lid's back bottom edge
  const hinge = E.addMate(doc, { mateType: "revolute", name: "Hinge", params: { ...G.MATES.find((m) => m.type === "revolute").defaults(), limits: true, angleMin: -110, angleMax: 0 },
    a: { instance: b, ref: { kind: "edge", body: "box", name: "edge(box:end:ra|box:side:rc)" } }, b: { instance: l, ref: { kind: "edge", body: "lid", name: "edge(lid:side:qc|lid:start:qa)" } } });
  commit(hinge.changes);
  const run = (opts) => { const p = P.buildProblem(F.instancesOf(doc), F.matesOf(doc), new Map(), G.MATES, geometry); return P.solveProblem(p, { analyze: true, reach: P.reachOf(p.mates), ...opts }); };
  let s = run({ seed: hinge.item.id });
  assert.equal(s.result.ok, true); assert.equal(s.mates.get(hinge.item.id).state, "ok"); assert.equal(s.result.dof, 1);
  nearV(s.result.poses.get(l).p, [0, 0, 40], 1e-4, "the lid sits on the box");
  assert.ok(Math.abs(s.mates.get(hinge.item.id).values.angle) < 1e-3, "closed");
  commit(E.setTransforms(doc, new Map([[l, M.transformOf(s.result.poses.get(l))]])));
  // open the lid 40° and store that: the placements, and the mate's value with them
  s = run({ drives: [{ mate: hinge.item.id, key: "angle", value: (-40 * Math.PI) / 180 }] });
  commit(E.setTransforms(doc, new Map([[l, M.transformOf(s.result.poses.get(l))]])));
  const problem = P.buildProblem(F.instancesOf(doc), F.matesOf(doc), new Map(), G.MATES, geometry);
  const values = P.measureMates(problem, s.result.poses);
  const stored = E.setMateValues(doc, values);
  assert.equal(stored.length, 1); commit(stored);
  assert.ok(Math.abs(F.matesOf(doc)[0].values.angle + 40) < 1e-5, JSON.stringify(F.matesOf(doc)[0].values));
  assert.equal(E.setMateValues(doc, values).length, 0, "the same values again change nothing");
  // the box grows from 40 to 65 in its part studio: the same names, new geometry
  boxMesh = (await box(65)).box;
  s = run({});
  assert.equal(s.result.ok, true);
  assert.ok(s.result.iterations > 0, "the stored placement no longer satisfies the hinge");
  // what the editor does then: aim at the stored value, so the lid keeps its angle and only rises
  s = run({ drives: [{ mate: hinge.item.id, key: "angle", value: (F.matesOf(doc)[0].values.angle * Math.PI) / 180 }] });
  assert.equal(s.result.ok, true);
  assert.ok(Math.abs(s.mates.get(hinge.item.id).values.angle + 40) < 1e-4);
  nearV(M.applyPose(s.result.poses.get(l), [50, 60, 0]), [50, 60, 65], 1e-4, "the hinge line went up with the box");
  s = run({ drives: [{ mate: hinge.item.id, key: "angle", value: 0 }] });
  nearV(s.result.poses.get(l).p, [0, 0, 65], 1e-4, "closed, the lid sits on the taller box");
  commit(E.setTransforms(doc, new Map([[l, M.transformOf(s.result.poses.get(l))]])));
  // the edge is removed upstream (here: a mate that names geometry that is not there)
  commit(E.updateMate(doc, hinge.item.id, { a: { instance: b, ref: { kind: "edge", body: "box", name: "edge(gone)" } } }));
  s = run({});
  assert.equal(s.mates.get(hinge.item.id).state, "error"); assert.match(s.mates.get(hinge.item.id).message, /no longer exists/);
  assert.equal(s.result.dof, 6, "the lid is free again");
  // a suppressed instance makes its mates inactive; an unknown mate type is kept and not enforced
  commit(E.updateMate(doc, hinge.item.id, { a: { instance: b, ref: { kind: "edge", body: "box", name: "edge(box:end:ra|box:side:rc)" } } }));
  commit(E.setSuppressed(doc, [l], true));
  assert.equal(run({}).mates.get(hinge.item.id).state, "inactive");
  commit(E.setSuppressed(doc, [l], false)); commit(E.updateMate(doc, hinge.item.id, { mateType: "from-the-future" }));
  assert.equal(run({}).mates.get(hinge.item.id).state, "unknown-type");
});

test("an explicit connector is its geometry's frame, flipped, moved and turned", async () => {
  const boxMesh = (await box(40)).box;
  const { doc, commit } = assembly();
  const ins = E.insertInstances(doc, [{ source: part("d1", "box"), name: "Box" }]); commit(ins.changes);
  const c = E.addConnector(doc, { instance: ins.items[0].id, ref: { kind: "face", body: "box", name: "box:end:ra" }, offset: [10, 0, 5], flip: true }); commit(c.changes);
  const geometry = { frame: (_i, ref) => C.connectorOf(boxMesh, ref) };
  const f = P.endFrame({ instance: ins.items[0].id, ref: c.item.ref, connector: c.item.id }, ins.items[0], new Map([[c.item.id, c.item]]), geometry);
  nearV(f.z, [0, 0, -1], 1e-9, "flipped"); nearV(f.o, [60, 30, 35], 1e-4, "moved along its own (flipped) axes");
  assert.equal(P.endFrame({ instance: "x", ref: c.item.ref, connector: "gone" }, ins.items[0], new Map(), geometry), null);
});
