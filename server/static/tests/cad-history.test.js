// Node test for what the platform features need from the mechanical domain and from the shared history client:
// the feature-level diff of two versions of a part studio (web/domains/mechanical/compare/diff.ts), the 3D diff
// by kernel booleans (services/compare-versions.ts, on the real OpenCascade build), and the history list a
// drawer shows (web/platform/history/api.ts).
// Run: node server/static/tests/cad-history.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load, server } = require("./cad-load");

const D = load("domains/mechanical/compare/diff.ts");
const K = load("domains/mechanical/kernel/index.ts");
const F = load("domains/mechanical/document/format.ts");
const I = load("shared/itemdoc/itemdoc.ts");
const H = load("platform/history/api.ts");

const rect = (x0, y0, x1, y1) => ({
  p1: { type: "point", x: x0, y: y0 }, p2: { type: "point", x: x1, y: y0 }, p3: { type: "point", x: x1, y: y1 }, p4: { type: "point", x: x0, y: y1 },
  l1: { type: "line", a: "p1", b: "p2" }, l2: { type: "line", a: "p2", b: "p3" }, l3: { type: "line", a: "p3", b: "p4" }, l4: { type: "line", a: "p4", b: "p1" },
});
const sketch = (id, name, order, entities) => ({ id, type: "feature", featureType: "sketch", name, order, params: { plane: { kind: "plane", plane: "top" }, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, name, order, sk, o = {}) => ({ id, type: "feature", featureType: "extrude", name, order, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });
const studio = (items, rollback = null) => I.newItemDoc("part-studio", [{ id: "studio", type: "studio", units: "mm", rollback }, ...items]);
const plate = () => studio([sketch("s1", "Sketch 1", "F", { ...rect(0, 0, 40, 20), pc: { type: "point", x: 10, y: 10 }, c1: { type: "circle", center: "pc", r: 3 } }), extrude("e1", "Extrude 1", "V", "s1")]);
const edit = (doc, changes) => { const d = I.parseItemDoc(I.serializeItemDoc(doc)); I.applyChanges(d, changes); return d; };
const modified = (id, ...props) => ({ id, kind: "MODIFIED", props });

test("two versions that read the same have no changes", () => {
  const d = D.diffStudios(plate(), plate(), K.FEATURES);
  assert.deepEqual(d.changes, []);
  assert.deepEqual(d.counts, { added: 0, removed: 0, modified: 0 });
  assert.equal(D.countsText(d), "");
});

test("a changed parameter is named by its dialog's label, with units, before and after", () => {
  const a = plate();
  const b = edit(a, [modified("e1", { path: ["params", "depth"], value: 25 }, { path: ["params", "operation"], value: "add" }, { path: ["params", "flip"], value: true }, { path: ["name"], value: "Base" })]);
  const d = D.diffStudios(a, b, K.FEATURES);
  assert.equal(d.changes.length, 1);
  const c = d.changes[0];
  assert.equal(c.category, "modified"); assert.equal(c.label, "Base"); assert.equal(c.id, "e1");
  assert.deepEqual(c.props.slice().sort((x, y) => x.name.localeCompare(y.name)), [
    { name: "Depth", before: "10 mm", after: "25 mm" },
    { name: "Name", before: "Extrude 1", after: "Base" },
    { name: "Opposite direction", before: "no", after: "yes" },
    { name: "Result", before: "New", after: "Add" },
  ]);
  assert.match(c.detail, /^Extrude: /);
});

test("features are matched by id: added, removed, and a sketch's geometry entity by entity", () => {
  const a = plate();
  const b = edit(a, [
    { id: "s2", kind: "ADDED", item: sketch("s2", "Boss sketch", "k", { q1: { type: "point", x: 30, y: 10 }, c2: { type: "circle", center: "q1", r: 5 } }) },
    { id: "e2", kind: "ADDED", item: extrude("e2", "Boss", "r", "s2", { operation: "add", depth: 30 }) },
    modified("s1", { path: ["params", "sketch", "entities", "c1", "r"], value: 4 }, { path: ["params", "sketch", "entities", "p3", "x"], value: 50 }, { path: ["params", "sketch", "entities", "pc"], del: true },
      { path: ["params", "sketch", "entities", "n1"], value: { type: "point", x: 1, y: 2 } }),
  ]);
  const d = D.diffStudios(a, b, K.FEATURES);
  assert.deepEqual(d.counts, { added: 2, removed: 0, modified: 1 });
  assert.deepEqual(d.changes.filter((c) => c.category === "added").map((c) => [c.label, c.detail]), [["Boss sketch", "Sketch, position 3"], ["Boss", "Extrude, position 4"]]);
  const s = d.changes.find((c) => c.id === "s1");
  const row = (name) => s.props.find((p) => p.name === name);
  assert.deepEqual(row("Sketch circle c1"), { name: "Sketch circle c1", before: "circle at (10, 10), radius 3", after: "circle at pc, radius 4" });
  assert.deepEqual(row("Sketch point p3"), { name: "Sketch point p3", before: "point (40, 20)", after: "point (50, 20)" });
  assert.deepEqual(row("Sketch point pc"), { name: "Sketch point pc", before: "point (10, 10)", after: "—" });
  assert.deepEqual(row("Sketch point n1"), { name: "Sketch point n1", before: "—", after: "point (1, 2)" });
  // the other way round the additions are removals
  const back = D.diffStudios(b, a, K.FEATURES);
  assert.deepEqual(back.counts, { added: 0, removed: 2, modified: 1 });
  assert.equal(D.countsText(back), "2 removed, 1 modified");
});

test("a move is a change of position; an insertion above is not a move of what is below", () => {
  const a = studio([sketch("s1", "Sketch 1", "F", rect(0, 0, 10, 10)), sketch("s2", "Sketch 2", "V", rect(0, 0, 5, 5)), extrude("e1", "Extrude 1", "k", "s1")]);
  const inserted = edit(a, [{ id: "s0", kind: "ADDED", item: sketch("s0", "Sketch 0", "5", rect(0, 0, 1, 1)) }]);
  assert.deepEqual(D.diffStudios(a, inserted, K.FEATURES).changes.map((c) => c.category + ":" + c.label), ["added:Sketch 0"]);
  const moved = edit(a, [modified("s2", { path: ["order"], value: "z" })]);
  const d = D.diffStudios(a, moved, K.FEATURES);
  assert.equal(d.changes.length, 1);
  assert.deepEqual(d.changes[0].props, [{ name: "Position in the tree", before: "2", after: "3" }]);
  // the rollback bar and suppression
  const rolled = edit(a, [modified("studio", { path: ["rollback"], value: "e1" }), modified("s2", { path: ["suppressed"], value: true })]);
  const r = D.diffStudios(a, rolled, K.FEATURES);
  assert.deepEqual(r.changes.map((c) => [c.label, c.props[0].name, c.props[0].before, c.props[0].after]), [["Sketch 2", "Suppressed", "no", "yes"], ["Rollback bar", "Rollback bar", "the end", "above Extrude 1"]]);
});

test("a profile reads as the sketch's name, and a feature type the registry lacks still diffs", () => {
  const a = studio([sketch("s1", "Sketch 1", "F", rect(0, 0, 10, 10)), sketch("s2", "Other", "G", rect(0, 0, 5, 5)), extrude("e1", "Extrude 1", "k", "s1"),
    { id: "x1", type: "feature", featureType: "from-the-future", name: "Warp 1", order: "z", params: { amount: 3, how: { mode: "soft" } } }]);
  const b = edit(a, [modified("e1", { path: ["params", "profile", "sketch"], value: "s2" }), modified("x1", { path: ["params", "amount"], value: 4 }, { path: ["params", "how", "mode"], value: "hard" })]);
  const d = D.diffStudios(a, b, K.FEATURES);
  assert.deepEqual(d.changes.find((c) => c.id === "e1").props, [{ name: "Sketch to extrude", before: "Sketch 1", after: "Other" }]);
  assert.deepEqual(d.changes.find((c) => c.id === "x1").props, [{ name: "amount", before: "3", after: "4" }, { name: "how", before: '{"mode":"soft"}', after: '{"mode":"hard"}' }]);
});

// ---------------------------------------------------------------- the 3D diff, in the real kernel

let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new K.Kernel(oc);
  return kernel;
}
async function compare(a, b) {
  const k = await boot();
  const svc = K.SERVICES.find((s) => s.name === "compare-versions");
  assert.ok(svc, "the compare-versions service is registered");
  const side = (doc) => { const f = F.featuresOf(doc); return { features: F.featureInputs(f), rollback: F.rollbackIndex(doc, f) }; };
  const mine = []; k.scope = mine;
  try { return await svc.run({ oc: k.oc, k, state: { bodies: [], sketches: {} }, fail: (m) => new Error(m) }, { a: side(a), b: side(b) }); }
  finally { k.scope = null; for (const o of mine.reverse()) { try { o.delete(); } catch (e) { /* gone */ } } }
}
const near = (x, y, eps = 1e-3) => assert.ok(Math.abs(x - y) < eps * Math.max(1, Math.abs(y)), `${x} is not ${y}`);
const PLATE = (40 * 20 - Math.PI * 9) * 10;

test("the 3D diff: material added by a deeper plate and a boss, nothing removed", async () => {
  const a = plate();
  const b = edit(a, [modified("e1", { path: ["params", "depth"], value: 25 }),
    { id: "s2", kind: "ADDED", item: sketch("s2", "Boss sketch", "k", { q1: { type: "point", x: 30, y: 10 }, c2: { type: "circle", center: "q1", r: 5 } }) },
    { id: "e2", kind: "ADDED", item: extrude("e2", "Boss", "r", "s2", { operation: "add", depth: 32 }) }]);
  const r = await compare(a, b);
  near(r.a.volume, PLATE); near(r.b.volume, PLATE * 2.5 + Math.PI * 25 * 7);
  near(r.volumes.common, PLATE); near(r.volumes.added, PLATE * 1.5 + Math.PI * 25 * 7); assert.equal(r.volumes.removed, 0);
  assert.equal(r.removed, null, "no mesh for nothing");
  assert.ok(r.common.indices.length > 0 && r.added.indices.length > 0 && r.added.edges.length > 0);
  assert.ok(r.added.positions instanceof Float32Array && r.added.indices instanceof Uint32Array);
  // the added solid sits on top of the old plate
  let zmin = Infinity; for (let i = 2; i < r.added.positions.length; i += 3) zmin = Math.min(zmin, r.added.positions[i]);
  near(zmin, 10);
  assert.deepEqual(r.b.reports.map((x) => x.status), ["ok", "ok", "ok", "ok"]);
});

test("the 3D diff: a hole moved is material removed in one place and added in another", async () => {
  const a = plate();
  const b = edit(a, [modified("s1", { path: ["params", "sketch", "entities", "pc", "x"], value: 30 })]);
  const r = await compare(a, b);
  const hole = Math.PI * 9 * 10;
  near(r.volumes.added, hole); near(r.volumes.removed, hole); near(r.volumes.common, PLATE - hole);
  near(r.a.volume, r.b.volume);
  // what was added fills the old hole (around x = 10), what was removed is the new one (around x = 30)
  const centreX = (m) => { let s = 0; for (let i = 0; i < m.positions.length; i += 3) s += m.positions[i]; return s / (m.positions.length / 3); };
  near(centreX(r.added), 10, 0.05); near(centreX(r.removed), 30, 0.05);
});

test("the 3D diff: a part studio of several parts is compared as a whole (a second part added beside the first)", async () => {
  const a = edit(plate(), [
    { id: "s2", kind: "ADDED", item: sketch("s2", "Block sketch", "k", { b1: { type: "point", x: 60, y: 0 }, b2: { type: "point", x: 70, y: 0 }, b3: { type: "point", x: 70, y: 10 }, b4: { type: "point", x: 60, y: 10 }, ba: { type: "line", a: "b1", b: "b2" }, bb: { type: "line", a: "b2", b: "b3" }, bc: { type: "line", a: "b3", b: "b4" }, bd: { type: "line", a: "b4", b: "b1" } }) },
    { id: "e2", kind: "ADDED", item: extrude("e2", "Block", "r", "s2", { operation: "new", depth: 5 }) }]);
  const b = edit(a, [modified("e2", { path: ["params", "depth"], value: 8 })]);
  const r = await compare(a, b);
  assert.deepEqual([r.a.bodies, r.b.bodies], [2, 2]);
  near(r.a.volume, PLATE + 500); near(r.b.volume, PLATE + 800);
  near(r.volumes.common, PLATE + 500); near(r.volumes.added, 300); assert.equal(r.volumes.removed, 0);
});

test("the 3D diff: the same version twice, an empty version, and a version that fails", async () => {
  const a = plate();
  const same = await compare(a, plate());
  assert.equal(same.added, null); assert.equal(same.removed, null); near(same.volumes.common, PLATE);
  const none = await compare(studio([]), a);
  assert.equal(none.common, null); assert.equal(none.removed, null); near(none.volumes.added, PLATE); assert.equal(none.a.bodies, 0);
  const broken = await compare(a, edit(a, [modified("s1", { path: ["suppressed"], value: true })]));
  assert.equal(broken.b.reports[1].status, "error"); assert.equal(broken.b.bodies, 0);
  near(broken.volumes.removed, PLATE); assert.equal(broken.added, null);
});

// ---------------------------------------------------------------- the history list

test("the history list of a document: every kept version and that document's runs, newest first", () => {
  const who = { id: 1, login: "ada", name: "Ada" };
  const t = {
    projectId: "p", parentId: null, branchName: null, keptDays: 30, signedIn: true,
    docs: [{ docId: "d1", path: "Part.jpart", docType: "part_studio", head: 9, floor: 0 }, { docId: "d2", path: "b.kicad_pcb", docType: "kicad_pcb", head: 3, floor: 0 }],
    versions: [
      { id: "v1", name: "First", description: "", kind: "named", createdAt: "2026-03-01T10:00:00Z", author: who, docs: [{ docId: "d1", path: "Part.jpart", snapSeq: 0, seq: 4 }] },
      { id: "v2", name: "Before restoring \"First\"", description: "", kind: "auto", createdAt: "2026-03-01T12:00:00Z", author: who, docs: [{ docId: "d2", path: "b.kicad_pcb", snapSeq: 0, seq: 3 }] },
    ],
    runs: [
      { docId: "d1", path: "Part.jpart", from: 1, to: 4, count: 4, kind: "edit", author: who, startedAt: "2026-03-01T09:00:00Z", endedAt: "2026-03-01T09:30:00Z" },
      { docId: "d2", path: "b.kicad_pcb", from: 1, to: 3, count: 3, kind: "edit", author: who, startedAt: "2026-03-01T09:40:00Z", endedAt: "2026-03-01T09:45:00Z" },
      { docId: "d1", path: "Part.jpart", from: 5, to: 9, count: 5, kind: "edit", author: who, startedAt: "2026-03-01T11:00:00Z", endedAt: "2026-03-01T11:30:00Z" },
    ],
  };
  const e = H.entriesFor(t, "d1");
  assert.deepEqual(e.map((x) => x.kind === "version" ? `v:${x.version.name}:${x.here ? x.here.seq : "-"}` : `r:${x.run.to}`), ["v:Before restoring \"First\":-", "r:9", "v:First:4", "r:4"]);
  assert.equal(H.entriesFor(t, "d2").filter((x) => x.kind === "run").length, 1);
});

test("how a conflict's sides and a time read", () => {
  assert.equal(H.didText({ did: "set", value: 28 }), "28");
  assert.equal(H.didText({ did: "set", value: "add" }), "add");
  assert.equal(H.didText({ did: "removed" }), "deleted");
  assert.equal(H.didText({ did: "changed" }), "changed inside");
  assert.equal(H.didText({ did: "set", value: { a: "x".repeat(100) } }).length, 58);
  const now = Date.parse("2026-03-02T12:00:00Z");
  assert.equal(H.when("2026-03-02T11:59:40Z", now), "just now");
  assert.equal(H.when("2026-03-02T11:40:00Z", now), "20 min ago");
  assert.equal(H.personName({ id: 1, login: "ada" }), "ada");
  assert.equal(H.personName(null), "someone");
});
