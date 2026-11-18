// Node test for what a click means while a dialog field listens (web/domains/mechanical/ui/fields.ts): clicks add,
// a click on something held takes it out, single fields are replaced and hand on to the next empty one, a
// selection made beforehand fills the first fields that take it, Tab goes round, Esc steps back.
// Run: node server/static/tests/cad-fields.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");
const F = load("domains/mechanical/ui/fields.ts");

const edge = (name, body = "b1") => ({ kind: "edge", body, name });
const face = (name, body = "b1") => ({ kind: "face", body, name });
const vertex = (name, body = "b1") => ({ kind: "vertex", body, name });
const top = { kind: "plane", plane: "top" };
const datumPlane = { kind: "datum", featureId: "pl1", datum: "plane" };
const datumAxis = { kind: "datum", featureId: "ax1", datum: "axis" };
const region = (id) => ({ kind: "sketch", featureId: "sk1", entity: null, region: id });
const curve = (id) => ({ kind: "sketch", featureId: "sk1", entity: id, region: null });

const EDGES = { key: "edges", label: "Edges or faces", kind: "refs", of: ["edge", "face"] };
const RADIUS = { key: "radius", label: "Radius", kind: "number", unit: "mm" };
const PLANE = { key: "plane", label: "Sketch plane", kind: "plane" };
const PROFILE = { key: "profile", label: "Sketch", kind: "profile" };
const AXIS = { key: "axis", label: "Axis", kind: "refs", of: ["edge"], single: true, datums: ["axis"], sketch: true };
const MIRROR = { key: "plane", label: "Mirror plane", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"] };
const BODIES = { key: "bodies", label: "Parts", kind: "bodies" };
const SEED = { key: "seed", label: "Faces", kind: "refs", of: ["face"] };

test("a many-valued field: a click adds, a click on what it holds takes it out", () => {
  let v;
  v = F.valueAfterPick(EDGES, v, edge("e1"));
  assert.deepEqual(v, [{ kind: "edge", body: "b1", name: "e1" }]);
  v = F.valueAfterPick(EDGES, v, edge("e2"));
  v = F.valueAfterPick(EDGES, v, face("f1"));
  assert.deepEqual(v.map((r) => r.name), ["e1", "e2", "f1"], "in the order clicked");
  v = F.valueAfterPick(EDGES, v, edge("e1"));
  assert.deepEqual(v.map((r) => r.name), ["e2", "f1"], "the first click's edge is out, the others stay");
  // the same name on another body is another thing
  v = F.valueAfterPick(EDGES, v, edge("e2", "b2"));
  assert.equal(v.length, 3);
});

test("a click the field cannot use changes nothing (undefined), so the selection is never dropped", () => {
  const held = [{ kind: "edge", body: "b1", name: "e1" }];
  assert.equal(F.valueAfterPick(EDGES, held, vertex("v1")), undefined);
  assert.equal(F.valueAfterPick(EDGES, held, top), undefined);
  assert.equal(F.valueAfterPick(PROFILE, null, edge("e1")), undefined);
  assert.equal(F.valueAfterPick(PLANE, top, edge("e1")), undefined);
  assert.equal(F.valueAfterPick(PLANE, top, datumAxis), undefined);
  assert.equal(F.valueAfterPick(RADIUS, 1, edge("e1")), undefined);
});

test("a box adds only: what the field already holds is not taken out by it", () => {
  const held = [{ kind: "edge", body: "b1", name: "e1" }];
  assert.equal(F.valueAfterPick(EDGES, held, edge("e1"), { addOnly: true }), undefined);
  assert.equal(F.valueAfterPick(EDGES, held, edge("e2"), { addOnly: true }).length, 2);
});

test("a field that holds one thing is replaced by the click", () => {
  assert.deepEqual(F.valueAfterPick(PLANE, { kind: "plane", plane: "top" }, { kind: "plane", plane: "front" }), { kind: "plane", plane: "front" });
  assert.deepEqual(F.valueAfterPick(PLANE, undefined, datumPlane), { kind: "datum", feature: "pl1" });
  assert.deepEqual(F.valueAfterPick(PLANE, undefined, face("f1")), { kind: "face", ref: { kind: "face", body: "b1", name: "f1" } });
  assert.deepEqual(F.valueAfterPick(AXIS, edge("e1"), datumAxis), { kind: "datum", feature: "ax1" });
  assert.deepEqual(F.valueAfterPick(AXIS, null, curve("l1")), { kind: "sketch", feature: "sk1", entity: "l1" });
  assert.deepEqual(F.valueAfterPick(MIRROR, null, top), { kind: "plane", plane: "top" });
  assert.ok(F.holdsOne(PLANE) && F.holdsOne(AXIS) && !F.holdsOne(EDGES) && !F.holdsOne(PROFILE));
});

test("a profile: the first click takes the sketch, clicks in its regions choose among them", () => {
  let v = F.valueAfterPick(PROFILE, null, region("r1"));
  assert.deepEqual(v, { sketch: "sk1", regions: null }, "all of it");
  v = F.valueAfterPick(PROFILE, v, region("r1"));
  assert.deepEqual(v.regions, ["r1"], "from all, a click leaves just that region");
  v = F.valueAfterPick(PROFILE, v, region("r2"));
  assert.deepEqual(v.regions, ["r1", "r2"]);
  v = F.valueAfterPick(PROFILE, v, region("r1"));
  assert.deepEqual(v.regions, ["r2"]);
  v = F.valueAfterPick(PROFILE, v, region("r2"));
  assert.equal(v.regions, null, "none left is all again");
});

test("bodies: a click on any face of a part adds the part; again takes it out", () => {
  let v = F.valueAfterPick(BODIES, [], face("f1", "b1"));
  v = F.valueAfterPick(BODIES, v, face("f9", "b2"));
  assert.deepEqual(v, ["b1", "b2"]);
  assert.deepEqual(F.valueAfterPick(BODIES, v, face("f2", "b1")), ["b2"]);
});

test("the filter a field sets, and how the status line says it", () => {
  assert.deepEqual(F.pickKindsFor(EDGES), ["edge", "face"]);
  assert.deepEqual(F.pickKindsFor(PLANE), ["plane", "face", "datum"]);
  assert.deepEqual(F.pickKindsFor(PROFILE), ["sketch"]);
  assert.deepEqual(F.pickKindsFor(MIRROR), ["face", "plane", "datum"]);
  assert.equal(F.pickKindsFor(RADIUS), null);
  assert.equal(F.pickKindsFor(undefined), null);
  assert.equal(F.describeKinds(["edge", "face"]), "edges and faces");
  assert.equal(F.describeKinds(["plane", "face", "datum"]), "planes, faces and reference geometry");
  assert.equal(F.describeKinds(["edge"]), "edges");
  assert.equal(F.describeKinds(null), "anything");
});

test("after a single field is filled, the next empty field that takes picks listens", () => {
  const schema = [PROFILE, AXIS, RADIUS, SEED];
  assert.equal(F.nextEmptyField(schema, {}, null), "profile");
  assert.equal(F.nextEmptyField(schema, { profile: { sketch: "sk1", regions: null } }, "profile"), "axis");
  assert.equal(F.nextEmptyField(schema, { profile: { sketch: "sk1", regions: null }, axis: { kind: "datum", feature: "ax1" } }, "axis"), "seed");
  assert.equal(F.nextEmptyField(schema, { profile: { sketch: "sk1", regions: null }, axis: { kind: "datum", feature: "ax1" }, seed: [face("f1")] }, "axis"), null, "all filled: nothing listens");
  // it goes round: an empty field before the one just filled is found too
  assert.equal(F.nextEmptyField(schema, { axis: { kind: "datum", feature: "ax1" }, seed: [face("f1")] }, "axis"), "profile");
  // a field the dialog does not show is not offered
  const hidden = [{ ...PROFILE, visible: () => false }, AXIS];
  assert.equal(F.nextEmptyField(hidden, {}, null), "axis");
});

test("Tab goes round the fields that take geometry", () => {
  const schema = [PROFILE, RADIUS, AXIS, SEED];
  assert.equal(F.neighbourField(schema, {}, null), "profile");
  assert.equal(F.neighbourField(schema, {}, "profile"), "axis");
  assert.equal(F.neighbourField(schema, {}, "seed"), "profile");
  assert.equal(F.neighbourField(schema, {}, "profile", true), "seed");
  assert.equal(F.neighbourField([RADIUS], {}, null), null);
});

test("what was selected before the tool was started fills the first fields that take it, each pick once", () => {
  // a fillet: every edge and face selected goes into its one field
  assert.deepEqual(F.fillFromSelection([EDGES, RADIUS], {}, [edge("e1"), vertex("v1"), edge("e2")]).edges.map((r) => r.name), ["e1", "e2"]);
  // a revolve: the sketch region is the profile, the edge is the axis
  const rev = F.fillFromSelection([PROFILE, AXIS], {}, [edge("e1"), region("r1")]);
  assert.deepEqual(rev.profile, { sketch: "sk1", regions: null });
  assert.deepEqual(rev.axis, { kind: "edge", body: "b1", name: "e1" });
  // a face is used by the first field that takes faces, and not again by the second
  const two = F.fillFromSelection([MIRROR, SEED], {}, [face("f1"), face("f2")]);
  assert.deepEqual(two.plane.name, "f1");
  assert.deepEqual(two.seed.map((r) => r.name), ["f2"]);
  // a plane for a sketch
  assert.deepEqual(F.fillFromSelection([PLANE], {}, [top]).plane, { kind: "plane", plane: "top" });
  assert.deepEqual(F.fillFromSelection([PLANE], {}, []), {}, "nothing selected, nothing filled");
});

test("what a field holds, item by item, with what to keep highlighted", () => {
  const names = { feature: (id) => ({ sk1: "Sketch 1", pl1: "Plane 1" })[id], body: (id) => ({ b1: "Part 1" })[id], faces: () => ["f1", "f2"] };
  const items = F.heldItems(EDGES, [edge("e1"), face("f1"), edge("e2")], names);
  assert.deepEqual(items.map((i) => i.label), ["Edge 1 of Part 1", "Face 1 of Part 1", "Edge 2 of Part 1"]);
  assert.deepEqual(items[0].pick, { kind: "edge", body: "b1", name: "e1" });
  assert.equal(F.heldItems(MIRROR, { kind: "plane", plane: "top" }, names)[0].label, "Top plane");
  assert.equal(F.heldItems(MIRROR, { kind: "datum", feature: "pl1" }, names)[0].label, "Plane 1");
  assert.equal(F.heldItems(PLANE, { kind: "face", ref: face("f1") }, names)[0].label, "Face of Part 1");
  assert.equal(F.heldItems(BODIES, ["b1", "gone"], names).map((i) => i.label).join(), "Part 1,Missing part");
  const held = F.heldPicks([EDGES, MIRROR, BODIES], { edges: [edge("e1")], plane: { kind: "plane", plane: "top" }, bodies: ["b1"] }, "edges", names);
  assert.deepEqual(held.active, [{ kind: "edge", body: "b1", name: "e1" }], "the listening field's picks");
  assert.deepEqual(held.other.map((p) => p.kind), ["plane", "face", "face"], "the others': the plane, and the chosen part's faces");
});

test("Esc puts the listening field down first, then cancels the dialog", () => {
  assert.equal(F.escapeStep({ field: "edges" }), "field");
  assert.equal(F.escapeStep({ field: null }), "dialog");
  assert.equal(F.escapeStep(null), null);
});

test("empty fields", () => {
  assert.ok(F.isEmpty(EDGES, []) && F.isEmpty(EDGES, undefined) && !F.isEmpty(EDGES, [edge("e1")]));
  assert.ok(F.isEmpty(PROFILE, null) && !F.isEmpty(PROFILE, { sketch: "sk1", regions: null }));
  assert.ok(F.takesPicks(EDGES) && F.takesPicks(PLANE) && F.takesPicks(PROFILE) && F.takesPicks(BODIES) && !F.takesPicks(RADIUS));
});
