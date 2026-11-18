// cvpcb.test.js — Assign Footprints (KiCad's CvPcb) against cvpcb/*.cpp and common/footprint_filter.cpp: the list rows
// (formatSymbolDesc, FOOTPRINTS_LISTBOX), FOOTPRINT_FILTER with EDA_COMBINED_MATCHER( CTX_LIBITEM ), the status lines
// (DisplayStatus), CVPCB_CONTROL::ToNA, the association undo / redo lists, the equivalence files and
// AutomaticFootprintMatching, DIALOG_CONFIG_EQUFILES' paths, and the CvPcb toolbar / actions in the generated specs.
// Run: node server/static/tests/cvpcb.test.js
"use strict";
const path = require("path"), assert = require("assert");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const L = load(["dialogs", "cvpcb", "logic.ts"]);
const UI = require(webPath("generated", "kicad-ui-spec.json"));
const MENU = require(webPath("generated", "kicad-menu-spec.json"));

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }
const fp = (lib, name, pads, desc = "", keywords = "") => ({ lib, name, pads, desc, keywords });
const LIST = [
  fp("Capacitor_THT", "C_Disc_D5.0mm_W2.5mm_P5.00mm", 2, "C, Disc series", "C disc capacitor"),
  fp("Capacitor_THT", "CP_Radial_D5.0mm_P2.00mm", 2, "CP, Radial series", "CP radial electrolytic"),
  fp("Resistor_SMD", "R_0603_1608Metric", 2, "Resistor SMD 0603", "resistor"),
  fp("Package_DIP", "DIP-8_W7.62mm", 8, "8-lead DIP", "THT DIP DIL PDIP 2.54mm 7.62mm 300mil"),
  fp("Package_SO", "SOIC-8_3.9x4.9mm_P1.27mm", 8, "SOIC, 8 Pin", "SOIC SO"),
];

test("formatSymbolDesc: '%3d ', reference right-aligned in 8, ' - ', value right-aligned in 16, ' : ' footprint", () => {
  assert.strictEqual(L.formatSymbolDesc(1, "C1", "100n", "Capacitor_SMD:C_0603"), "  1       C1 -             100n : Capacitor_SMD:C_0603");
  assert.strictEqual(L.formatSymbolDesc(123, "R10000000", "x", ""), "123 R10000000 -                x : ");
  assert.strictEqual(L.formatFootprintRow(7, "Lib", "Name"), "  7 Lib:Name");
});
test("StrNumCmp orders numbers by value; libraries pinned first, each group ignoring case", () => {
  assert.ok(L.strNumCmp("R2", "R10") < 0); assert.ok(L.strNumCmp("a", "B", true) < 0); assert.ok(L.strNumCmp("a", "B") > 0);
  assert.deepStrictEqual(L.libraryOrder(["b", "A", "c10", "c9"], new Set(["c10"])).map((x) => (x.pinned ? "☆ " : "") + x.name), ["☆ c10", "A", "b", "c9"]);
});
test("LIB_ID: both parts needed; '$noname' is no footprint", () => {
  assert.ok(L.parseFpid("Lib:Name").valid); assert.ok(!L.parseFpid("Name").valid); assert.ok(!L.parseFpid("Lib:").valid); assert.ok(L.parseFpid("").empty);
  assert.strictEqual(L.cleanFpid("$noname"), ""); assert.strictEqual(L.cleanFpid(" L:N "), "L:N");
});
test("no filter: every footprint of every library", () => {
  assert.strictEqual(L.filterFootprints(LIST, { flags: 0, lib: "", sym: null, text: "" }).length, LIST.length);
});
test("FILTERING_BY_LIBRARY: only with a library selected (an empty name passes all)", () => {
  assert.strictEqual(L.filterFootprints(LIST, { flags: L.FILTER_LIBRARY, lib: "", sym: null, text: "" }).length, 5);
  assert.deepStrictEqual(L.filterFootprints(LIST, { flags: L.FILTER_LIBRARY, lib: "Package_SO", sym: null, text: "" }).map((f) => f.name), ["SOIC-8_3.9x4.9mm_P1.27mm"]);
});
test("FILTERING_BY_PIN_COUNT: the numbered pad count must equal the symbol's pin count; unknown pads never pass", () => {
  const sym = { pins: 8, filters: [] };
  assert.deepStrictEqual(L.filterFootprints(LIST, { flags: L.FILTER_PIN_COUNT, lib: "", sym, text: "" }).map((f) => f.lib), ["Package_DIP", "Package_SO"]);
  assert.strictEqual(L.filterFootprints([fp("X", "Y", -1)], { flags: L.FILTER_PIN_COUNT, lib: "", sym: { pins: 2, filters: [] }, text: "" }).length, 0);
  // no symbol selected: the pin filter is not applied
  assert.strictEqual(L.filterFootprints(LIST, { flags: L.FILTER_PIN_COUNT, lib: "", sym: null, text: "" }).length, 5);
});
test("FILTERING_BY_COMPONENT_FP_FILTERS: anchored wildcards on the lower-cased name, with the library when the pattern has ':'", () => {
  const f = (filters) => L.filterFootprints(LIST, { flags: L.FILTER_FP_FILTERS, lib: "", sym: { pins: 2, filters }, text: "" }).map((x) => x.name);
  assert.deepStrictEqual(f(["CP_*"]), ["CP_Radial_D5.0mm_P2.00mm"]);
  assert.deepStrictEqual(f(["C_*", "R_*"]), ["C_Disc_D5.0mm_W2.5mm_P5.00mm", "R_0603_1608Metric"]);
  assert.deepStrictEqual(f(["Package_SO:*"]), ["SOIC-8_3.9x4.9mm_P1.27mm"]);
  assert.deepStrictEqual(f(["DIP?8*"]), ["DIP-8_W7.62mm"]);
  assert.strictEqual(f([]).length, 5, "a symbol without filters lists everything");
});
test("search text: every white-space term must score (regex /…/, wildcard, substring) over lib, name, lib:name, keywords, description", () => {
  const t = (text) => L.filterFootprints(LIST, { flags: 0, lib: "", sym: null, text }).map((x) => x.name);
  assert.deepStrictEqual(t("0603"), ["R_0603_1608Metric"]);
  assert.deepStrictEqual(t("electrolytic radial"), ["CP_Radial_D5.0mm_P2.00mm"]);
  assert.deepStrictEqual(t("soic*1.27"), ["SOIC-8_3.9x4.9mm_P1.27mm"]);
  assert.deepStrictEqual(t("/^dip-\\d/"), ["DIP-8_W7.62mm"]);
  assert.deepStrictEqual(t("package_so:"), ["SOIC-8_3.9x4.9mm_P1.27mm"]);
  assert.strictEqual(t("nothing-like-this").length, 0);
});
test("ScoreTerms: equality 8x, a match at 0 2x, elsewhere 1x", () => {
  const m = L.libItemMatcher("dip");
  const s = L.scoreTerms(m, [["dip", 4], ["dip-8", 8], ["x dip", 1]]);
  assert.strictEqual(s, 8 * 4 + 2 * 8 + 1);
});
test("DisplayStatus line 1 and line 2", () => {
  assert.strictEqual(L.filterStatus(0, null, "", "", 15), "No Filtering: 15 matching footprints");
  assert.strictEqual(L.filterStatus(7, { pins: 2, filters: ["C_*", "CP_*"] }, "Capacitor_THT", "disc", 3), "Filtered by Keywords (C_*, CP_*), Pin Count (2), Library (Capacitor_THT), Search Text (disc): 3 matching footprints");
  assert.strictEqual(L.filterStatus(L.FILTER_LIBRARY, null, "", "", 9), "Filtered by Library: 9 matching footprints");
  assert.strictEqual(L.footprintStatus(LIST[2]), "Description: Resistor SMD 0603;  Keywords: resistor");
  assert.strictEqual(L.footprintStatus(null), "");
});
test("ToNA: next after the first selected (first of all with none); previous before it (none with no selection)", () => {
  assert.strictEqual(L.toNA([2, 5, 9], [5], "next"), 9);
  assert.strictEqual(L.toNA([2, 5, 9], [], "next"), 2);
  assert.strictEqual(L.toNA([2, 5, 9], [9], "next"), null);
  assert.strictEqual(L.toNA([2, 5, 9], [6, 3], "prev"), 2);
  assert.strictEqual(L.toNA([2, 5, 9], [], "prev"), null);
  assert.strictEqual(L.toNA([], [1], "next"), null);
});
test("CVPCB_UNDO_REDO_ENTRIES: one entry per action, undo reverses it, redo re-applies, a new action clears redo", () => {
  const h = new L.AssocHistory();
  h.record({ index: 0, old: "", now: "A:a" }, true); h.record({ index: 1, old: "B:b", now: "A:a" }, false);
  assert.ok(h.canUndo() && !h.canRedo());
  assert.deepStrictEqual(h.undo(), [{ index: 0, old: "A:a", now: "" }, { index: 1, old: "A:a", now: "B:b" }]);
  assert.ok(!h.canUndo() && h.canRedo());
  assert.deepStrictEqual(h.redo(), [{ index: 0, old: "", now: "A:a" }, { index: 1, old: "B:b", now: "A:a" }]);
  h.undo(); h.record({ index: 2, old: "", now: "X:x" }, true);
  assert.ok(!h.canRedo());
});
test("RedoAssociation adds the undo item through AssociateFootprint, which clears the rest of the redo list", () => {
  const h = new L.AssocHistory();
  h.record({ index: 0, old: "", now: "A:a" }, true); h.record({ index: 1, old: "", now: "B:b" }, true);
  h.undo(); h.undo(); assert.strictEqual(h.redoList.length, 2);
  assert.deepStrictEqual(h.redo(), [{ index: 0, old: "", now: "A:a" }]);
  assert.ok(!h.canRedo() && h.canUndo());
});
test("AssocHistory.remap: entries follow their symbols to the rebuilt rows; a symbol that is gone drops out", () => {
  const h = new L.AssocHistory();
  h.record({ index: 4, old: "x:p8", now: "" }, true); h.record({ index: 2, old: "", now: "y:c" }, true); h.record({ index: 3, old: "", now: "z:z" }, false);
  h.undo();
  h.remap((i) => (i === 4 ? 92 : i === 2 ? 7 : -1));
  assert.deepStrictEqual(h.undoList, [[{ index: 92, old: "x:p8", now: "" }]]);
  assert.deepStrictEqual(h.redoList, [[{ index: 7, old: "y:c", now: "" }]]);
  assert.deepStrictEqual(h.undo(), [{ index: 92, old: "", now: "x:p8" }]);
});
test("equivalence files: quoted value and footprint per line, spaces in the value become '_', sorted by value descending", () => {
  const e = L.parseEquFile("# comment\n'100 nF' 'Capacitor_SMD:C_0603'\n'LM358' 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm'\nbroken 'x'\n'only'\n");
  assert.deepStrictEqual(e, [{ value: "100_nF", fpid: "Capacitor_SMD:C_0603" }, { value: "LM358", fpid: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" }]);
  assert.deepStrictEqual(L.sortEquivalences(e).map((x) => x.value), ["LM358", "100_nF"]);
});
test("AutomaticFootprintMatching: unique value, filters among duplicates, first existing candidate, missing footprints reported, lone filter", () => {
  const exists = (id) => LIST.find((f) => f.lib + ":" + f.name === id) || null;
  const eq = L.sortEquivalences([
    { value: "LM358", fpid: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" }, { value: "LM358", fpid: "Package_DIP:DIP-8_W7.62mm" },
    { value: "10k", fpid: "Resistor_SMD:R_0603_1608Metric" }, { value: "1u", fpid: "Nope:Missing" },
  ]);
  const syms = [
    { ref: "U1", value: "lm358", fpid: "", filters: ["DIP*"] },
    { ref: "U2", value: "LM358", fpid: "", filters: [] },
    { ref: "R1", value: "10K", fpid: "", filters: [] },
    { ref: "R2", value: "10k", fpid: "Already:There", filters: [] },
    { ref: "C1", value: "1u", fpid: "", filters: ["Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm"] },
  ];
  const r = L.autoAssociate(syms, eq, exists);
  assert.deepStrictEqual(r.assign, [{ index: 0, fpid: "Package_DIP:DIP-8_W7.62mm" }, { index: 1, fpid: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm" }, { index: 2, fpid: "Resistor_SMD:R_0603_1608Metric" }, { index: 4, fpid: "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm" }]);
  assert.deepStrictEqual(r.warnings, ["Component C1: footprint Nope:Missing not found in any of the project footprint libraries."]);
});
test("DIALOG_CONFIG_EQUFILES: ${VAR}/relative entries with unix separators, project paths, move up / down", () => {
  assert.strictEqual(L.equEntryFor("/proj/lib/a.equ", [["KIPRJMOD", "/proj"]]), "${KIPRJMOD}/lib/a.equ");
  assert.strictEqual(L.equEntryFor("C:\\x\\a.equ", [["KIPRJMOD", "/proj"]]), "C:/x/a.equ");
  assert.strictEqual(L.equProjectPath("${KIPRJMOD}/lib/a.equ"), "lib/a.equ");
  assert.strictEqual(L.equProjectPath("a.equ"), "a.equ");
  assert.strictEqual(L.equProjectPath("/abs/a.equ"), null);
  assert.strictEqual(L.equProjectPath("${KICAD10_FOOTPRINT_DIR}/a.equ"), null);
  assert.deepStrictEqual(L.moveRows(["a", "b", "c", "d"], [1, 2], -1), { list: ["b", "c", "a", "d"], sel: [0, 1] });
  assert.deepStrictEqual(L.moveRows(["a", "b", "c"], [0], -1).list, ["a", "b", "c"]);
  assert.deepStrictEqual(L.moveRows(["a", "b", "c"], [0, 1], 1), { list: ["c", "a", "b"], sel: [1, 2] });
});
test("type-ahead: the footprint name after the line number; the next row starting with the key", () => {
  assert.strictEqual(L.typeAheadFootprint(["  1 C_0603", "  2 R_0603"], "r"), 1);
  assert.strictEqual(L.typeAheadFrom(["C1", "R1", "R2", "U1"], "r", 1), 2);
  assert.strictEqual(L.typeAheadFrom(["C1", "R1", "R2", "U1"], "r", 2), 1);
});
test("the generated specs carry the CvPcb toolbar (toolbars_cvpcb.cpp) and its actions (cvpcb_actions.cpp)", () => {
  const top = UI.toolbars.cvpcb.top.map((it) => it.sep ? "|" : it.control || it.id);
  assert.deepStrictEqual(top, ["saveAssociationsToSchematic", "|", "showFootprintLibTable", "|", "showFootprintViewer", "|", "gotoPreviousNA", "gotoNextNA", "|", "undo", "redo", "autoAssociate", "deleteAll", "|", "footprintFilter"]);
  const a = MENU.actions;
  assert.strictEqual(a["CVPCB_ACTIONS::saveAssociationsToSchematic"].key, "Ctrl+S");
  assert.strictEqual(a["CVPCB_ACTIONS::saveAssociationsToSchematic"].tip, "Save footprint assignments in 'footprint' fields of schematic symbols");
  assert.strictEqual(a["CVPCB_ACTIONS::gotoNextNA"].icon, "right");
  assert.strictEqual(a["CVPCB_ACTIONS::FilterFPbyFPFilters"].tip, "Filter footprint list by footprint filters defined in the symbol");
  assert.strictEqual(a["CVPCB_ACTIONS::deleteAssoc"].key, "Del");
  assert.strictEqual(a["CVPCB_ACTIONS::associate"].key, "Enter");
  for (const ic of ["show_footprint", "delete_association", "module_pin_filtered_list", "module_library_list", "module_filtered_list", "small_folder", "small_edit", "small_trash"]) assert.ok(UI.icons[ic], "icon " + ic);
  const left = UI.toolbars.fpviewer.left.map((it) => it.sep ? "|" : it.group || it.id);
  assert.deepStrictEqual(left, ["selectionTool", "measureTool", "|", "toggleGrid", "togglePolarCoords", "Units", "Crosshair modes", "|", "showPadNumbers", "padDisplayMode", "textOutlines", "graphicsOutlines"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
