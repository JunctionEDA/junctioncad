// Node test for the part studio document (web/domains/mechanical/document, sketch): the file format, every
// edit as item changes, and the closed regions of a sketch.  No kernel here; mechanical-kernel.test.js has it.
// Run: node server/static/tests/mechanical-doc.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");
const D = load("shared/itemdoc/itemdoc.ts");
const F = load("domains/mechanical/document/format.ts");
const E = load("domains/mechanical/document/edits.ts");
const SK = load("domains/mechanical/sketch/format.ts");
const P = load("domains/mechanical/sketch/profiles.ts");
const R = load("domains/registry.ts");

const def = (type, title, defaults = {}) => ({ type, title, schema: [], defaults: () => ({ ...defaults }), evaluate() {} });
const SKETCH = def("sketch", "Sketch", { plane: { kind: "plane", plane: "top" }, sketch: SK.emptySketch() });
const EXTRUDE = def("extrude", "Extrude", { depth: 10 });
const names = (doc) => F.featuresOf(doc).map((f) => f.name);
function studio() {
  const doc = D.parseItemDoc(F.newPartStudioText(), F.PART_STUDIO_KIND);
  const add = (d, params) => { const r = E.addFeature(doc, d, params); D.applyChanges(doc, r.changes); return r.feature; };
  return { doc, add, apply: (changes) => D.applyChanges(doc, changes) };
}

test("a new part studio is the registry's text, with the studio item and no features", () => {
  assert.equal(F.newPartStudioText(), R.documentKind("part_studio").newText);
  const doc = D.parseItemDoc(F.newPartStudioText(), F.PART_STUDIO_KIND);
  assert.deepEqual(F.studioOf(doc), { id: "studio", type: "studio", units: "mm", rollback: null });
  assert.deepEqual(F.featuresOf(doc), []);
  assert.equal(F.rollbackIndex(doc), 0);
});

test("features are added in order with default parameters and numbered names", () => {
  const s = studio();
  const sk = s.add(SKETCH), ex = s.add(EXTRUDE, { profile: { sketch: "x", regions: null } });
  s.add(SKETCH);
  assert.deepEqual(names(s.doc), ["Sketch 1", "Extrude 1", "Sketch 2"]);
  assert.equal(sk.type, "feature"); assert.equal(sk.featureType, "sketch");
  assert.deepEqual(ex.params, { depth: 10, profile: { sketch: "x", regions: null } });
  assert.match(sk.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(F.featureInputs(F.featuresOf(s.doc))[1], { id: ex.id, type: "extrude", name: "Extrude 1", suppressed: false, params: ex.params });
  // the file survives a round trip
  assert.deepEqual(names(D.parseItemDoc(D.serializeItemDoc(s.doc))), names(s.doc));
});

test("rename, suppress, change parameters: one small change each", () => {
  const s = studio(); const ex = s.add(EXTRUDE);
  let c = E.renameFeature(s.doc, ex.id, "  Base  ");
  assert.deepEqual(c, [{ id: ex.id, kind: "MODIFIED", typeName: "feature", props: [{ path: ["name"], value: "Base" }] }]);
  s.apply(c);
  assert.deepEqual(E.renameFeature(s.doc, ex.id, "Base"), []);
  assert.deepEqual(E.renameFeature(s.doc, ex.id, " "), []);
  s.apply(E.suppressFeature(s.doc, ex.id, true));
  assert.equal(F.featuresOf(s.doc)[0].suppressed, true);
  s.apply(E.suppressFeature(s.doc, ex.id, false));
  assert.equal("suppressed" in F.featuresOf(s.doc)[0], false);
  c = E.setParams(s.doc, ex.id, { depth: 12, flip: true });
  assert.deepEqual(c[0].props, [{ path: ["params", "depth"], value: 12 }, { path: ["params", "flip"], value: true }]);
  s.apply(c);
  s.apply(E.setParamPath(s.doc, ex.id, ["sketch", "entities", "p1"], { type: "point", x: 1, y: 2 }));
  assert.deepEqual(F.featuresOf(s.doc)[0].params, { depth: 12, flip: true, sketch: { entities: { p1: { type: "point", x: 1, y: 2 } } } });
  s.apply(E.setParamPath(s.doc, ex.id, ["sketch", "entities", "p1"], undefined));
  assert.deepEqual(F.featuresOf(s.doc)[0].params.sketch, { entities: {} });
});

test("reorder moves one feature by changing one key", () => {
  const s = studio(); const a = s.add(SKETCH), b = s.add(EXTRUDE), c = s.add(SKETCH), d = s.add(EXTRUDE);
  const move = (id, to) => { const ch = E.moveFeature(s.doc, id, to); assert.ok(ch.length <= 1); if (ch.length) assert.deepEqual(ch[0].props.map((p) => p.path), [["order"]]); s.apply(ch); return F.featuresOf(s.doc).map((f) => f.id); };
  assert.deepEqual(move(d.id, 0), [d.id, a.id, b.id, c.id]);
  assert.deepEqual(move(d.id, 3), [a.id, b.id, c.id, d.id]);
  assert.deepEqual(move(a.id, 2), [b.id, c.id, a.id, d.id]);
  assert.deepEqual(move(a.id, 2), [b.id, c.id, a.id, d.id], "moving to where it is changes nothing");
  assert.deepEqual(E.moveFeature(s.doc, a.id, 2), []);
  assert.deepEqual(move(c.id, 99), [b.id, a.id, d.id, c.id]);
});

test("the rollback bar: new features go in at the bar, and deleting the feature it sits on moves it down", () => {
  const s = studio(); const a = s.add(SKETCH), b = s.add(EXTRUDE), c = s.add(SKETCH);
  s.apply(E.setRollback(s.doc, b.id));
  assert.equal(F.rollbackIndex(s.doc), 1);
  const n = s.add(EXTRUDE);
  assert.deepEqual(F.featuresOf(s.doc).map((f) => f.id), [a.id, n.id, b.id, c.id]);
  assert.equal(F.rollbackIndex(s.doc), 2, "the new feature is above the bar, so it is built");
  s.apply(E.deleteFeature(s.doc, b.id));
  assert.equal(F.studioOf(s.doc).rollback, c.id);
  s.apply(E.deleteFeature(s.doc, c.id));
  assert.equal(F.studioOf(s.doc).rollback, null);
  assert.equal(F.rollbackIndex(s.doc), 2);
  assert.deepEqual(E.setRollback(s.doc, null), []);
  // a bar left on a feature somebody else deleted reads as the end
  s.apply(E.setRollback(s.doc, "gone"));
  assert.equal(F.rollbackIndex(s.doc), 2);
});

test("unknown items and keys are kept", () => {
  const doc = D.parseItemDoc('{"junction":"part-studio","version":1,"items":[{"id":"v1","type":"variable","name":"width","value":40},{"id":"f","type":"feature","featureType":"warp","name":"W","order":"V","params":{},"later":true}]}');
  assert.deepEqual(F.featuresOf(doc).map((f) => f.featureType), ["warp"]);
  const out = D.parseItemDoc(D.serializeItemDoc(doc));
  assert.equal(out.items.get("v1").value, 40);
  assert.equal(out.items.get("f").later, true);
});

// ---- sketches
const sketchOf = (...parts) => ({ version: 1, entities: Object.assign({}, ...parts), constraints: {} });

test("sketch tools write points and curves that share points", () => {
  const empty = SK.emptySketch();
  const rect = SK.rectangleEntities(empty, [0, 0], [40, 20]);
  const ids = Object.keys(rect);
  assert.equal(ids.filter((i) => rect[i].type === "point").length, 4);
  const lines = ids.filter((i) => rect[i].type === "line").map((i) => rect[i]);
  assert.equal(lines.length, 4);
  for (const l of lines) { assert.equal(rect[l.a].type, "point"); assert.equal(rect[l.b].type, "point"); }
  const sk = sketchOf(rect);
  const line = SK.lineEntities(sk, [0, 0], [5, 5], { a: lines[0].a });
  assert.equal(Object.keys(line.entities).length, 2, "an existing point is used, not copied");
  assert.equal(line.a, lines[0].a);
  const circle = SK.circleEntities(sk, [10, 10], 3);
  assert.deepEqual(Object.values(circle).map((e) => e.type).sort(), ["circle", "point"]);
  // deleting a line takes the points nothing else uses; deleting a corner takes both lines that end there
  const full = sketchOf(rect, line.entities);
  const lineId = Object.keys(line.entities).find((i) => line.entities[i].type === "line");
  assert.deepEqual(SK.withOrphanPoints(full, [lineId]).sort(), [lineId, line.b].sort());
  const gone = SK.withOrphanPoints(sketchOf(rect), [lines[0].a]);
  assert.equal(gone.filter((i) => rect[i].type === "line").length, 2);
  assert.equal(gone.filter((i) => rect[i].type === "point").length, 1);
});

test("regions: closed loops, holes, islands inside holes; open chains and branches make none", () => {
  const rect = (x0, y0, x1, y1, p) => ({
    [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y0 }, [`${p}3`]: { type: "point", x: x1, y: y1 }, [`${p}4`]: { type: "point", x: x0, y: y1 },
    [`${p}a`]: { type: "line", a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: "line", a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: "line", a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: "line", a: `${p}4`, b: `${p}1` },
  });
  const circle = (x, y, r, p) => ({ [`${p}c`]: { type: "point", x, y }, [p]: { type: "circle", center: `${p}c`, r } });
  let r = P.findRegions(sketchOf(rect(0, 0, 40, 20, "r")));
  assert.equal(r.regions.length, 1); assert.equal(r.regions[0].id, "ra"); assert.equal(r.regions[0].outer.area, 800);
  assert.deepEqual(r.regions[0].outer.edges.map((e) => e.entity + (e.reversed ? "'" : "")), ["ra", "rb", "rc", "rd"]);
  // drawn the other way round, the loop still comes out counter-clockwise
  r = P.findRegions(sketchOf(rect(0, 20, 40, 0, "r")));
  assert.equal(r.regions[0].outer.area, 800);
  assert.ok(r.regions[0].outer.edges.every((e) => e.reversed));
  // a hole, and an island inside the hole
  r = P.findRegions(sketchOf(rect(0, 0, 40, 20, "r"), circle(10, 10, 5, "h"), circle(10, 10, 2, "i"), circle(100, 100, 1, "z")));
  assert.deepEqual(r.regions.map((x) => `${x.id}:${x.holes.length}`), ["i:0", "ra:1", "z:0"]);
  // two points at the same place close a loop without sharing an id
  const split = rect(0, 0, 10, 10, "s"); split.s9 = { type: "point", x: 0, y: 0 }; split.sd = { type: "line", a: "s4", b: "s9" };
  assert.equal(P.findRegions(sketchOf(split)).regions.length, 1);
  // open, branching and construction geometry
  const open = rect(0, 0, 10, 10, "o"); delete open.od;
  r = P.findRegions(sketchOf(open));
  assert.deepEqual([r.regions.length, r.open], [0, ["oa", "ob", "oc"]]);
  const branch = rect(0, 0, 10, 10, "b"); branch.bx = { type: "point", x: 20, y: 20 }; branch.be = { type: "line", a: "b1", b: "bx" };
  assert.equal(P.findRegions(sketchOf(branch)).regions.length, 0);
  const cons = rect(0, 0, 10, 10, "k"); cons.ka.construction = true;
  assert.equal(P.findRegions(sketchOf(cons)).regions.length, 0);
  // an arc closes a D shape: a half disc of radius 5 on a chord
  const d = { a: { type: "point", x: 0, y: -5 }, b: { type: "point", x: 0, y: 5 }, c: { type: "point", x: 0, y: 0 }, chord: { type: "line", a: "b", b: "a" }, arc: { type: "arc", center: "c", start: "a", end: "b" } };
  r = P.findRegions(sketchOf(d));
  assert.equal(r.regions.length, 1);
  assert.ok(Math.abs(r.regions[0].outer.area - Math.PI * 25 / 2) < 0.1);
});

// ---------------------------------------------------------------- a document as the worker's input
test("studioInputs: the one way a part studio becomes worker input: variables applied, then the filters", () => {
  const IN = load("domains/mechanical/document/inputs.ts");
  const { doc, add, apply } = studio();
  add(SKETCH);
  const ex = add(EXTRUDE, { depth: 10, $expr: { depth: "height * 2" } });
  apply([{ id: "v1", kind: "ADDED", typeName: "variable", item: { id: "v1", type: "variable", name: "height", expr: "7", order: "V" } }]);
  const plain = IN.studioInputs(doc);
  assert.equal(plain.rollback, 2);
  assert.deepEqual(plain.features.map((f) => f.type), ["sketch", "extrude"]);
  assert.equal(plain.features[1].params.depth, 14, "the number follows the variable, whatever was stored");
  assert.equal(F.featuresOf(doc)[1].params.depth, 10, "and the document is not touched");
  // a filter adds what is not in the document (a Board feature's board); it sees the resolved numbers
  const seen = [];
  const withBoard = IN.studioInputs(doc, { filters: [(inputs) => { seen.push(inputs[1].params.depth); return inputs.map((f) => (f.id === ex.id ? { ...f, params: { ...f.params, $extra: 1 } } : f)); }] });
  assert.deepEqual(seen, [14]);
  assert.equal(withBoard.features[1].params.$extra, 1);
  assert.equal(F.featuresOf(doc)[1].params.$extra, undefined);
  // a page lays a draft over the features and says where the bar is
  const draft = IN.studioInputs(doc, { features: F.featuresOf(doc).slice(0, 1), rollback: 1 });
  assert.deepEqual([draft.features.length, draft.rollback], [1, 1]);
});

// ---------------------------------------------------------------- the toolbar's keys and sections
test("tools: no two tools outside a sketch share a key, nor two inside one; every feature names a known toolbar section", () => {
  const fs = require("node:fs"), path = require("node:path");
  const root = path.join(__dirname, "..", "..", "web", "domains", "mechanical");
  const keys = { sketch: new Map(), model: new Map() };
  for (const file of fs.readdirSync(path.join(root, "tools"))) {
    if (file.startsWith("_") || !/\.tsx?$/.test(file)) continue;
    const text = fs.readFileSync(path.join(root, "tools", file), "utf8");
    const key = /\bkey: "([^"]+)"/.exec(text), group = /\bgroup: "([^"]+)"/.exec(text);
    if (!key || !group) continue;
    const where = group[1] === "sketch" ? keys.sketch : keys.model, k = key[1].toLowerCase();
    assert.ok(!where.has(k), `${file} and ${where.get(k)} both take the key ${k} ${group[1] === "sketch" ? "in a sketch" : "outside a sketch"}`);
    where.set(k, file);
  }
  assert.ok(keys.sketch.size >= 10 && keys.model.size >= 4);
  const sections = new Set(["sketch", "solid", "pattern", "reference", "board"]);
  const menus = new Map();
  for (const file of fs.readdirSync(path.join(root, "features"))) {
    if (file.startsWith("_") || !/\.ts$/.test(file)) continue;
    const text = fs.readFileSync(path.join(root, "features", file), "utf8");
    const section = /toolbarSection: "([^"]+)"/.exec(text), menu = /toolbarMenu: "([^"]+)"/.exec(text);
    if (section) assert.ok(sections.has(section[1]), `${file}: ${section[1]}`);
    if (menu) menus.set(menu[1], (menus.get(menu[1]) || 0) + 1);
  }
  // the families a person finds under one button
  assert.deepEqual(Object.fromEntries([...menus].sort()), { Board: 3, Boolean: 4, Fillet: 3, Pattern: 3, Reference: 4, Sweep: 2 });
});

