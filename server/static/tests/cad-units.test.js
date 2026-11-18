// Node test for the units a part studio is worked in (web/domains/mechanical/document/units.ts): reading and
// setting them on the document, formatting lengths, angles, areas and volumes, what is typed into a field
// (bare numbers, explicit units, expressions, variables), and that an expression keeps the unit it was typed in.
// Run: node server/static/tests/cad-units.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");
const D = load("shared/itemdoc/itemdoc.ts");
const F = load("domains/mechanical/document/format.ts");
const U = load("domains/mechanical/document/units.ts");
const V = load("domains/mechanical/document/variables.ts");
const X = load("domains/mechanical/sketch/expr.ts");
const M = load("domains/mechanical/inspect/measure-format.ts");
const DM = load("domains/mechanical/sketch/dims.ts");

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);
const newDoc = () => D.parseItemDoc(F.newPartStudioText(), F.PART_STUDIO_KIND);
const inch = { length: "in", angle: "deg", places: 3 }, mm = U.DEFAULT_UNITS, rad = { length: "mm", angle: "rad", places: 3 };

test("a new part studio is in millimetres and degrees, three decimals", () => {
  assert.deepEqual(U.unitsOf(newDoc()), { length: "mm", angle: "deg", places: 3 });
  assert.deepEqual(U.unitsOf(null), U.DEFAULT_UNITS);
});

test("setting the units changes the studio item and nothing else, and survives the file", () => {
  const doc = newDoc();
  const changes = U.setUnits(doc, { length: "in", places: 4 });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].id, F.STUDIO_ITEM_ID);
  assert.deepEqual(changes[0].props.map((p) => p.path.join(".")).sort(), ["precision", "units"]);
  D.applyChanges(doc, changes);
  assert.deepEqual(U.unitsOf(doc), { length: "in", angle: "deg", places: 4 });
  const again = D.parseItemDoc(D.serializeItemDoc(doc), F.PART_STUDIO_KIND);
  assert.deepEqual(U.unitsOf(again), { length: "in", angle: "deg", places: 4 });
  assert.deepEqual(U.setUnits(doc, { length: "in" }), [], "no change, no edit");
  D.applyChanges(doc, U.setUnits(doc, { angle: "rad" }));
  assert.equal(U.unitsOf(doc).angle, "rad");
  // the rollback bar's place is untouched by a change of units
  assert.equal(F.studioOf(doc).rollback, null);
});

test("an unknown unit or a silly precision falls back to the defaults", () => {
  const doc = newDoc();
  D.applyChanges(doc, [{ id: F.STUDIO_ITEM_ID, kind: "MODIFIED", typeName: "studio", props: [{ path: ["units"], value: "furlong" }, { path: ["precision"], value: 99 }] }]);
  assert.deepEqual(U.unitsOf(doc), { length: "mm", angle: "deg", places: U.MAX_PLACES });
});

test("lengths, angles, areas and volumes are written in the document's units", () => {
  assert.equal(U.formatLength(25.4, mm), "25.4 mm");
  assert.equal(U.formatLength(25.4, inch), "1 in");
  assert.equal(U.formatLength(12.7, { ...inch, places: 1 }), "0.5 in");
  assert.equal(U.formatLength(1000, { length: "m", angle: "deg", places: 3 }), "1 m");
  assert.equal(U.formatLength(304.8, { length: "ft", angle: "deg", places: 3 }), "1 ft");
  assert.equal(U.formatLength(15, { length: "cm", angle: "deg", places: 3 }), "1.5 cm");
  assert.equal(U.formatLength(1 / 3, mm), "0.333 mm");
  assert.equal(U.formatLength(-0.00001, mm), "0 mm", "no minus zero");
  assert.equal(U.formatLength(10, mm, { unit: false }), "10");
  assert.equal(U.formatAngle(180, mm), "180°");
  assert.equal(U.formatAngle(180, rad), "3.142 rad");
  assert.equal(U.formatArea(645.16, inch), "1 in²");
  assert.equal(U.formatVolume(16387.064, inch), "1 in³");
  assert.equal(U.formatArea(100, mm), "100 mm²");
});

test("a field shows a stored number in the document's unit, with every digit that matters", () => {
  assert.equal(U.fieldText(25.4, "length", inch), "1");
  assert.equal(U.fieldText(25, "length", mm), "25");
  assert.equal(U.fieldText(10, "length", inch), "0.393701");
  assert.equal(U.fieldText(90, "angle", rad), "1.570796");
  assert.equal(U.fieldText(6, "none", inch), "6", "a count is a count in any unit");
  assert.equal(U.fieldUnit("length", inch), "in");
  assert.equal(U.fieldUnit("angle", mm), "°");
  assert.equal(U.fieldUnit("none", mm), "");
});

test("a bare number typed into a field is in the document's unit; a typed unit wins", () => {
  near(U.parseField("25", "length", mm).value, 25);
  assert.equal(U.parseField("25", "length", mm).isExpression, false);
  near(U.parseField("1", "length", inch).value, 25.4);
  assert.equal(U.parseField("1", "length", inch).isExpression, false);
  near(U.parseField("1 in", "length", mm).value, 25.4);
  near(U.parseField("25.4mm", "length", inch).value, 25.4);
  near(U.parseField("25.4 mm", "length", inch).value, 25.4);
  near(U.parseField("2 cm", "length", inch).value, 20);
  near(U.parseField("1 ft", "length", mm).value, 304.8);
  near(U.parseField("0.5 m", "length", mm).value, 500);
  near(U.parseField("1,5", "length", mm).value, 1.5, 1e-9);
  near(U.parseField("90", "angle", mm).value, 90);
  near(U.parseField("3.141592653589793", "angle", rad).value, 180, 1e-6);
  near(U.parseField("90 deg", "angle", rad).value, 90);
  near(U.parseField("4", "none", inch).value, 4);
  near(U.parseField("1\"", "length", mm).value, 25.4);
  assert.equal(U.parseField("", "length", mm), null);
  assert.equal(U.parseField("abc", "length", mm), null);
  assert.equal(U.parseField("1 +", "length", mm), null);
});

test("expressions: arithmetic takes the document's unit, mixed units add up, variables keep their own", () => {
  near(U.parseField("1/2", "length", inch).value, 12.7);
  assert.equal(U.parseField("1/2", "length", inch).isExpression, true);
  near(U.parseField("3/8 in + 2 mm", "length", mm).value, 9.525 + 2);
  near(U.parseField("2 + 1 mm", "length", inch).value, 50.8 + 1, 1e-9);
  near(U.parseField("(10 + 5) * 2", "length", mm).value, 30);
  near(U.parseField("2 * 1 in", "length", mm).value, 50.8);
  near(U.parseField("sqrt(16)", "length", inch).value, 4 * 25.4);
  // variables: one that carries a unit is that length whatever the document's unit; a plain one is a number
  const doc = newDoc();
  D.applyChanges(doc, V.addVariable(doc, "width", "40 mm").changes);
  D.applyChanges(doc, V.addVariable(doc, "n", "4").changes);
  D.applyChanges(doc, V.addVariable(doc, "wall", "width / 20").changes);
  const vv = V.variableValues(V.variablesOf(doc)), look = V.lookupOf(vv);
  assert.equal(vv.dims.get("width"), 1);
  assert.equal(vv.dims.get("n"), 0);
  assert.equal(vv.dims.get("wall"), 1);
  near(U.parseField("width / 2", "length", inch, look).value, 20);
  near(U.parseField("width + 1", "length", inch, look).value, 40 + 25.4);
  near(U.parseField("n", "length", inch, look).value, 4 * 25.4);
  near(U.parseField("n * 2", "none", inch, look).value, 8);
  near(U.parseField("wall * n", "length", inch, look).value, 8);
  assert.equal(U.parseField("height", "length", mm, look), null, "an unknown name is not a number");
});

test("an expression keeps the unit it was typed in when the worker's input is made", () => {
  const vv = V.variableValues([]);
  const inputs = [{ id: "a", type: "extrude", name: "E", suppressed: false, params: { depth: 0, angle: 0, [V.EXPR_KEY]: { depth: "1/2", angle: "pi / 2" }, [V.UNIT_KEY]: { depth: "in", angle: "rad" } } }];
  const out = V.resolveInputs(inputs, vv.values, vv.dims);
  near(out[0].params.depth, 12.7);
  near(out[0].params.angle, 90, 1e-9);
  // with no unit recorded, an expression is millimetres and degrees, as files written before units were
  const old = V.resolveInputs([{ id: "a", type: "extrude", name: "E", suppressed: false, params: { depth: 0, [V.EXPR_KEY]: { depth: "1/2" } } }], vv.values, vv.dims);
  near(old[0].params.depth, 0.5);
});

test("the sketcher's reader takes the document's unit for a bare number", () => {
  near(X.evaluate("2", "length", 25.4).value, 50.8);
  near(X.evaluate("2 mm", "length", 25.4).value, 2);
  near(X.evaluate("10 + 5 mm", "length").value, 15);
  near(X.evaluate("1 + 5 mm", "length", 25.4).value, 30.4);
  near(X.evaluate("3/8 in", "length", 1).value, 9.525);
  near(X.evaluate("45", "angle").value, 45);
  near(X.evaluate("pi/4 rad", "angle").value, 45, 1e-9);
  near(X.evaluate("1", "angle", 180 / Math.PI).value, 180 / Math.PI, 1e-9);
});

test("a sketch dimension's text follows the document's units", () => {
  const data = { version: 1, entities: { p1: { type: "point", x: 0, y: 0 }, p2: { type: "point", x: 25.4, y: 0 }, l1: { type: "line", a: "p1", b: "p2" } }, constraints: {} };
  const c = { type: "distance", refs: [{ entity: "l1", at: "start" }, { entity: "l1", at: "end" }], value: 25.4, driving: true };
  DM.setSketchUnits(mm);
  assert.equal(DM.dimensionText(data, c), "25.4");
  DM.setSketchUnits(inch);
  assert.equal(DM.dimensionText(data, c), "1");
  assert.equal(DM.lenText(50.8), "2 in");
  assert.equal(DM.typedFactor(false), 25.4);
  DM.setSketchUnits(mm);
});

test("the measure readout is written, and copied, in the document's units", () => {
  const edge = { kind: "edge", curve: "line", length: 50.8 };
  assert.equal(M.entityRows(edge)[0].text, "50.8 mm");
  assert.equal(M.entityRows(edge)[0].copy, "50.8");
  M.setMeasureUnits(inch);
  try {
    assert.equal(M.entityRows(edge)[0].text, "2 in");
    assert.equal(M.entityRows(edge)[0].copy, "2");
    const face = { kind: "face", surface: "plane", area: 645.16, perimeter: 101.6 };
    assert.equal(M.entityRows(face)[0].text, "1 in²");
    assert.equal(M.entityRows(face)[0].copy, "1");
    assert.equal(M.mm3(16387.064), "1 in³");
  } finally { M.setMeasureUnits(mm); }
});
