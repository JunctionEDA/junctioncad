// panes.test.js — the docked panes' pure models: the Search pane's field / metadata matching (EDA_SEARCH_DATA
// searchAllFields / searchMetadata), StrNumCmp sorting and CopySelectionToClipboard text; more panes below.
// Run: node server/static/tests/panes.test.js
"use strict";
const path = require("path"), assert = require("assert");
const { webPath } = require("./web-path");
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [webPath(file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const S = load("editor/panels/search-model.ts");
const PT = load("components/panes/prop-text.ts");
const SF = load("symedit/selfilter.ts");
const COL = load("components/panes/columns.ts");
const NAV = load("components/panes/prop-nav.ts");
const SP = load("symedit/props.ts");
const SM = load("symedit/model.ts");
const VX = load("editor/pcbdialogs/vertex-model.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("docked panes under node");

const FP = ["footprint", "Lib:R_0805",
  ["property", "Reference", "R1", ["at", 0, 0]],
  ["property", "Value", "10k", ["at", 0, 0]],
  ["property", "MPN", "RC0805", ["at", 0, 0], ["hide", "yes"]],
  ["property", "Old", "legacy", ["effects", ["font"], "hide"]],
  ["property", "Shown", "visible", ["hide", "no"]]];
test("itemFields reads fields and their hidden flags", () => {
  const f = S.itemFields(FP);
  assert.deepStrictEqual(f.map((x) => [x.name, x.hidden]), [["Reference", false], ["Value", false], ["MPN", true], ["Old", true], ["Shown", false]]);
});
test("legacy fp_text reference / value are fields", () => {
  const f = S.itemFields(["footprint", "x", ["fp_text", "reference", "U3", ["at", 0, 0], "hide"], ["fp_text", "value", "LM358", ["at", 0, 0]], ["fp_text", "user", "note"]]);
  assert.deepStrictEqual(f, [{ name: "Reference", value: "U3", hidden: true }, { name: "Value", value: "LM358", hidden: false }]);
});
test("searchTexts: hidden fields only with Search Hidden Fields, metadata only with Search Metadata", () => {
  const f = S.itemFields(FP), meta = ["Lib:R_0805", "Resistor SMD", "resistor"];
  assert.deepStrictEqual(S.searchTexts(f, meta, { hidden: false, metadata: false }), ["R1", "10k", "visible"]);
  assert.deepStrictEqual(S.searchTexts(f, meta, { hidden: true, metadata: false }), ["R1", "10k", "RC0805", "legacy", "visible"]);
  assert.deepStrictEqual(S.searchTexts(f, meta, { hidden: false, metadata: true }), ["R1", "10k", "visible", "Lib:R_0805", "Resistor SMD", "resistor"]);
});
test("strNumCmp orders digit runs by value, ignoring case", () => {
  assert.ok(S.strNumCmp("R2", "R10") < 0);
  assert.ok(S.strNumCmp("r10", "R9") > 0);
  assert.strictEqual(S.strNumCmp("abc", "ABC"), 0);
  assert.ok(S.strNumCmp("C1", "C1a") < 0);
});
test("sortRows sorts by a column either way, stable, first column when none", () => {
  const rows = [{ cells: ["R10", "b"] }, { cells: ["R2", "a"] }, { cells: ["C1", "b"] }];
  assert.deepStrictEqual(S.sortRows(rows, 0, true).map((r) => r.cells[0]), ["C1", "R2", "R10"]);
  assert.deepStrictEqual(S.sortRows(rows, 0, false).map((r) => r.cells[0]), ["R10", "R2", "C1"]);
  assert.deepStrictEqual(S.sortRows(rows, 1, true).map((r) => r.cells[0]), ["R2", "R10", "C1"]);
  assert.deepStrictEqual(S.sortRows(rows, -1, true).map((r) => r.cells[0]), ["C1", "R2", "R10"]);
});
test("rowsAsText: tab-separated cells, a newline after each row", () => {
  assert.strictEqual(S.rowsAsText([{ cells: ["R1", "10k", "F.Cu"] }, { cells: ["R2", "", "B.Cu"] }]), "R1\t10k\tF.Cu\nR2\t\tB.Cu\n");
});

test("Properties colour cells keep the alpha (PGPROPERTY_COLOR4D)", () => {
  assert.strictEqual(PT.colorText([255, 0, 0], 1), "#ff0000");
  assert.strictEqual(PT.colorText([255, 0, 0], 0.5), "rgba(255,0,0,0.5)");
  assert.deepStrictEqual(PT.parseColorText("#FF000080"), [255, 0, 0, 0.502]);
  assert.deepStrictEqual(PT.parseColorText("rgba(10, 20, 30, 0.25)"), [10, 20, 30, 0.25]);
  assert.deepStrictEqual(PT.parseColorText("#00ff00"), [0, 255, 0, 1]);
  assert.strictEqual(PT.parseColorText("red"), null);
});

test("Symbol Editor selection filter: KiCad's rows and itemPassesFilter classes", () => {
  assert.deepStrictEqual(SF.SYM_FILTER_ROWS.map((r) => r[1]), ["All items", "Locked items", "Pins", "Text", "Graphics", "Other items"]);
  assert.strictEqual(SF.symFilterClass("pin"), "pins");
  assert.strictEqual(SF.symFilterClass("property"), "text");
  assert.strictEqual(SF.symFilterClass("text_box"), "text");
  assert.strictEqual(SF.symFilterClass("bezier"), "graphics");
  assert.strictEqual(SF.symFilterClass("something"), "otherItems");
});
test("Symbol Editor selection filter: Only <kind>, All items", () => {
  let f = SF.symSetFilter(SF.defaultSymFilter(), "only:graphics", true);
  assert.deepStrictEqual(f, { lockedItems: true, pins: false, text: false, graphics: true, otherItems: false });
  assert.ok(!SF.symAllChecked(f) && SF.symPasses(f, "arc") && !SF.symPasses(f, "pin"));
  f = SF.symSetFilter(f, "all", true); assert.ok(SF.symAllChecked(f));
  f = SF.symSetFilter(f, "text", false); assert.ok(!SF.symPasses(f, "property") && !SF.symAllChecked(f));
  // Locked items is special: All items neither sets it nor depends on it (SCH_SELECTION_FILTER_OPTIONS::All).
  f = SF.symSetFilter(SF.defaultSymFilter(), "lockedItems", false); assert.ok(SF.symAllChecked(f));
  f = SF.symSetFilter(f, "all", false); assert.strictEqual(f.lockedItems, false);
  f = SF.symSetFilter(f, "all", true); assert.ok(f.lockedItems === false && SF.symAllChecked(f));
  f = SF.symSetFilter(SF.defaultSymFilter(), "all", false); assert.strictEqual(f.lockedItems, true);
});

test("net inspector column order: saved order first, unnamed columns after in model order", () => {
  const cols = [0, 1, 2, 3, 4].map((id) => ({ id }));
  assert.deepStrictEqual(COL.orderColumns(cols, []).map((c) => c.id), [0, 1, 2, 3, 4]);
  assert.deepStrictEqual(COL.orderColumns(cols, [2, 0, 1]).map((c) => c.id), [2, 0, 1, 3, 4]);
  assert.deepStrictEqual(COL.orderColumns(cols, [9, 3]).map((c) => c.id), [3, 0, 1, 2, 4]);
});
test("net inspector header drop moves the column to the target's slot", () => {
  assert.deepStrictEqual(COL.moveColumn([0, 1, 2, 3], 2, 0), [2, 0, 1, 3]);
  assert.deepStrictEqual(COL.moveColumn([0, 1, 2, 3], 0, 2), [1, 2, 0, 3]);
  assert.deepStrictEqual(COL.moveColumn([0, 1, 2, 3], 1, 1), [0, 1, 2, 3]);
  assert.deepStrictEqual(COL.moveColumn([0, 1, 2, 3], 5, 1), [0, 1, 2, 3]);
});

test("properties keys: Enter / Down / Up / Tab moves (PROPERTIES_PANEL::onCharHook)", () => {
  const k = (key, shiftKey = false) => NAV.propNavOf({ key, shiftKey, ctrlKey: false, altKey: false, metaKey: false });
  assert.deepStrictEqual([k("Enter"), k("ArrowDown"), k("ArrowUp"), k("Tab"), k("Tab", true), k("a")], ["next", "next", "prev", "tab", "backtab", null]);
  const cells = [{ readOnly: false }, { readOnly: true }, { readOnly: false }];
  assert.strictEqual(NAV.navTarget(cells, 0, "next"), 1);
  assert.strictEqual(NAV.navTarget(cells, 0, "tab"), 2);
  assert.strictEqual(NAV.navTarget(cells, 2, "tab"), 0);
  assert.strictEqual(NAV.navTarget(cells, 0, "backtab"), 2);
});
test("symbol editor fields: add, rename, set and remove a user field", () => {
  const sym = SM.node('(symbol "R" (property "Reference" "R" (at 0 0 0)) (property "Value" "R" (at 0 0 0)) (property "Footprint" "" (at 0 0 0)) (property "Datasheet" "" (at 0 0 0)) (property "ki_keywords" "res" (at 0 0 0)) (symbol "R_0_1"))');
  assert.deepStrictEqual(SP.userFieldNames(sym), []);
  assert.strictEqual(SP.addSymbolField(sym), "Field0");
  assert.strictEqual(SP.addSymbolField(sym), "Field1");
  assert.deepStrictEqual(SP.userFieldNames(sym), ["Field0", "Field1"]);
  assert.ok(!SP.renameSymbolField(sym, "Field0", "Value"), "a mandatory name is refused");
  assert.ok(!SP.renameSymbolField(sym, "Field0", "Field1"), "a name in use is refused");
  assert.ok(!SP.renameSymbolField(sym, "Reference", "X"), "a mandatory field keeps its name");
  assert.ok(SP.renameSymbolField(sym, "Field0", "MPN"));
  assert.ok(SP.setSymbolProp(sym, "MPN", "RC0805"));
  const rows = SP.symbolRows(sym, sym).filter((r) => r.group === "Fields").map((r) => r.name + "=" + r.value + (r.key ? "*" : ""));
  assert.deepStrictEqual(rows, ["Reference=R", "Value=R", "Footprint=", "Datasheet=", "Keywords=res", "MPN=RC0805*", "Field1=*"]);
  assert.ok(!SP.removeSymbolField(sym, "Value"));
  assert.ok(SP.removeSymbolField(sym, "Field1"));
  assert.deepStrictEqual(SP.userFieldNames(sym), ["MPN"]);
  // the new field sits after the last property, hidden
  const f = sym.find((c) => Array.isArray(c) && c[1] === "MPN");
  assert.ok(sym.indexOf(f) < sym.findIndex((c) => Array.isArray(c) && c[0] === "symbol"));
});

test("vertex editor: zone rows cover every outline, an edit unfills the zone", () => {
  const zone = ["zone", ["net", 0], ["fill", "yes"], ["polygon", ["pts", ["xy", 0, 0], ["xy", 10, 0], ["xy", 10, 5]]], ["polygon", ["pts", ["xy", 2, 1], ["xy", 3, 1], ["xy", 3, 2]]], ["filled_polygon", ["layer", "F.Cu"], ["pts", ["xy", 0, 0]]]];
  assert.ok(VX.hasEditableCorners("zone", zone));
  assert.ok(!VX.hasEditableCorners("zone", ["zone", ["attr", ["teardrop", ["type", "padvia"]]]]), "a teardrop is not edited");
  assert.ok(VX.hasEditableCorners("gr_poly", ["gr_poly"]) && !VX.hasEditableCorners("gr_rect", ["gr_rect"]));
  const rows = VX.vertexRows(zone);
  assert.deepStrictEqual(rows.map((r) => [r.x, r.y]), [[0, 0], [10, 0], [10, 5], [2, 1], [3, 1], [3, 2]]);
  assert.ok(!VX.setVertex(zone, 1, 0, 10), "an unchanged value is no edit");
  assert.ok(VX.setVertex(zone, 4, 1, 1.25));
  assert.deepStrictEqual(VX.vertexRows(zone)[4], { list: 1, at: 1, x: 3, y: 1.25 });
  assert.ok(!zone.some((c) => Array.isArray(c) && c[0] === "filled_polygon"), "filled areas dropped");
  assert.deepStrictEqual(zone.find((c) => Array.isArray(c) && c[0] === "fill"), ["fill"]);
  assert.ok(!VX.setVertex(zone, 9, 0, 1), "no such corner");
});
test("vertex editor: parseCellValue wants a digit in the leading number", () => {
  assert.deepStrictEqual(["12.5", "-0.3 mm", ".5", "", "abc", "mm", "-", "+,7"].map(VX.hasLeadingDigit), [true, true, true, false, false, false, false, true]);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
