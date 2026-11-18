// feat-common.test.js — the common frames and dialogs against KiCad: Page Settings' custom size limits (UNIT_BINDER::Validate with MIN_PAGE_SIZE_MILS / MAX_PAGE_SIZE_*_MILS) and the drawing
// sheet file kept in the project file (schematic / pcbnew page_layout_descr_file).
// Run: node server/static/tests/feat-common.test.js
"use strict";
const path = require("path"), assert = require("assert");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }

const L = load(["dialogs", "logic.ts"]), W = load(["editor", "drawingsheet-model.ts"]);
const G = load(["dialogs", "gal-options.ts"]), M = load(["dialogs", "maintenance.ts"]), T = load(["dialogs", "color-themes.ts"]), C = load(["calculator", "model.ts"]);

test("Page Settings: the custom size is 1000 mils at least, under 120000 mils (eeschema) / 48000 mils (pcbnew)", () => {
  assert.strictEqual(L.pageSizeError("Width", 25.4, true, "mm"), null);
  assert.match(L.pageSizeError("Width", 20, true, "mil"), /^Width must be at least 1000 mils\.$/);
  assert.match(L.pageSizeError("Height", 1300, false, "mm"), /^Height must be less than 1219\.2 mm\.$/);
  assert.strictEqual(L.pageSizeError("Height", 1300, true, "mm"), null, "the schematic allows up to 3048 mm");
  assert.match(L.pageSizeError("Height", 3100, true, "in"), /less than 120 in/);
});
test("drawing sheet file: read from the editor's key of the project file, resolved to a project document", () => {
  const pro = JSON.stringify({ schematic: { page_layout_descr_file: "sheets/my.kicad_wks" }, pcbnew: { page_layout_descr_file: "${KIPRJMOD}/board.kicad_wks" } });
  assert.strictEqual(W.drawingSheetName(pro, true), "sheets/my.kicad_wks");
  assert.strictEqual(W.drawingSheetName(pro, false), "${KIPRJMOD}/board.kicad_wks");
  assert.strictEqual(W.drawingSheetName("{}", true), ""); assert.strictEqual(W.drawingSheetName("not json", true), "");
  const docs = [{ docId: "p", docType: "kicad_pro", path: "proj/demo.kicad_pro" }, { docId: "a", docType: "worksheet", path: "proj/sheets/my.kicad_wks" }, { docId: "b", docType: "worksheet", path: "proj/board.kicad_wks" }, { docId: "s", docType: "kicad_sch", path: "proj/demo.kicad_sch" }];
  const ws = W.projectWorksheets(docs);
  assert.deepStrictEqual(ws.map((x) => x.rel), ["sheets/my.kicad_wks", "board.kicad_wks"]);
  assert.strictEqual(W.resolveWorksheet("sheets/my.kicad_wks", ws).docId, "a");
  assert.strictEqual(W.resolveWorksheet("${KIPRJMOD}/board.kicad_wks", ws).docId, "b");
  assert.strictEqual(W.resolveWorksheet("/home/me/proj/board.kicad_wks", ws).docId, "b", "an absolute path ending in a project file");
  assert.strictEqual(W.resolveWorksheet("", ws), null); assert.strictEqual(W.resolveWorksheet("other.kicad_wks", ws), null);
  assert.deepStrictEqual(W.wksKey(true), ["schematic", "page_layout_descr_file"]); assert.deepStrictEqual(W.wksKey(false), ["pcbnew", "page_layout_descr_file"]);
});

test("Display Options: PANEL_GAL_OPTIONS' defaults and ranges (app_settings.cpp, panel_gal_options.cpp)", () => {
  assert.deepStrictEqual(G.galDefaults(), { style: "dots", lineWidth: 1, minSpacing: 10, showMajor: true, crosshair: "small", alwaysShow: true });
  assert.strictEqual(G.GRID_THICKNESS_CHOICES.length, 20); assert.strictEqual(G.GRID_THICKNESS_CHOICES[0], 0.5); assert.strictEqual(G.GRID_THICKNESS_CHOICES[19], 10);
  const c = G.clampGal({ style: "bogus", lineWidth: 2.3, minSpacing: 900, showMajor: false, crosshair: "45", alwaysShow: false });
  assert.deepStrictEqual(c, { style: "dots", lineWidth: 2.5, minSpacing: 200, showMajor: false, crosshair: "45", alwaysShow: false });
  assert.strictEqual(G.clampGal({ style: "lines", lineWidth: NaN, minSpacing: 1 }).lineWidth, 1);
  assert.strictEqual(G.clampGal({ style: "lines", lineWidth: NaN, minSpacing: 1 }).minSpacing, 5);
});
test("Maintenance: dialog state, histories and program settings are told apart; designs, guide and clipboard are kept", () => {
  const keys = ["kd.geom.plot", "kd.state.find", "pd.state.track", "kui.prefs", "kui.v3d", "kc.drc.options", "kicad.fab.preset", "kicad-collab:lib-recent:sym", "kui.pcbFindHistory", "kc.plugins.recommended.seen.p1", "kui.boardDocs", "kc.onboard.mini", "kc.guide", "kui.clipboard", "admin.range", "other"];
  assert.deepStrictEqual(M.dialogStateKeys(keys), ["kd.geom.plot", "kd.state.find", "pd.state.track", "kc.plugins.recommended.seen.p1"]);
  assert.deepStrictEqual(M.dontShowAgainKeys(keys), ["kc.plugins.recommended.seen.p1"]);
  assert.deepStrictEqual(M.historyKeys(keys), ["kicad-collab:lib-recent:sym", "kui.pcbFindHistory"]);
  assert.deepStrictEqual(M.programSettingKeys(keys), ["kd.geom.plot", "kd.state.find", "pd.state.track", "kui.prefs", "kui.v3d", "kc.drc.options", "kicad.fab.preset", "kicad-collab:lib-recent:sym", "kui.pcbFindHistory", "kc.plugins.recommended.seen.p1"]);
});

test("Colors: New Theme names (FOOTPRINT_NAME_VALIDATOR, Theme already exists!) and ids", () => {
  assert.strictEqual(T.themeNameError("Mine", ["KiCad Default"]), null);
  assert.strictEqual(T.themeNameError("kicad default", ["KiCad Default"]), "Theme already exists!");
  assert.match(T.themeNameError("a/b", []), /illegal character '\/'/);
  assert.match(T.themeNameError("  ", []), /required/);
  assert.strictEqual(T.userThemeId("My Theme", []), "user:my-theme");
  assert.strictEqual(T.userThemeId("My Theme", ["user:my-theme"]), "user:my-theme-2");
  const u = T.newUserTheme(" Night ", { bg: "#000000", wire: "#00FF00" }, []);
  assert.deepStrictEqual(u, { id: "user:night", name: "Night", colors: { bg: "#000000", wire: "#00FF00" } });
});
test("Colors: validateSave finds items drawn in the background colour (all but Sheet backgrounds)", () => {
  assert.deepStrictEqual(T.hiddenByBackground({ bg: "#F5F4EF", wire: "#f5f4ef", body: "#F5F4EF", sheetBg: "#F5F4EF", bus: "#000084" }).sort(), ["body", "wire"]);
  assert.deepStrictEqual(T.hiddenByBackground({ bg: "#F5F4EF", wire: "rgba(245,244,239,0.5)" }), []);
  assert.ok(T.sameColor("#0000ff", "rgb(0, 0, 255)"));
  assert.ok(T.isDarkBackground("#1C1D20")); assert.ok(!T.isDarkBackground("#F5F4EF"));
  assert.ok(T.SCH_COLOR_ITEMS.some(([k, n]) => k === "bg" && n === "Background"));
});
test("Colors: createSwatches' 48 layers (all SCH layers but g_excludedLayers), sorted by LayerName, Axes marked", () => {
  const names = T.SCH_COLOR_ITEMS.map(([, n]) => n);
  assert.strictEqual(names.length, 48);
  assert.deepStrictEqual(names.slice(0, 5), ["Anchors", "Axes (symbol editor only)", "Background", "Bus junctions", "Buses"]);
  assert.strictEqual(names[names.length - 1], "Wires");
  for (const n of ["Sheet references", "Shape fills", "Sheet backgrounds", "ERC warnings", "ERC errors", "ERC exclusions", "Helper items", "Cursor", "Drag net collisions", "Operating point voltages", "Operating point currents"]) assert.ok(names.includes(n), n);
  for (const n of ["Schematic text && graphics backgrounds", "Net color highlight"]) assert.ok(!names.includes(n), n);
  assert.deepStrictEqual(names.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), names);
  assert.strictEqual(T.schExtraColors("classic").ercWarn, "rgba(0,255,0,0.8)"); assert.strictEqual(T.schExtraColors("default").ercWarn, "rgba(209,146,0,0.8)");
});

const close = (a, b, rel = 1e-6) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel, `${a} != ${b}`);
test("Calculator: track width matches KiCad's qa test_track_width_calculations", () => {
  const mil = 2.54e-5;
  close(C.trackCurrentFromWidth(20 * mil, 1.378 * mil, 10, false), 1.4164291025677085);
  close(C.trackCurrentFromWidth(20 * mil, 1.378 * mil, 10, true), 1.513124408404138);
  close(C.trackCurrentFromWidth(20 * mil, 2.756 * mil, 10, true), 2.208736063285966);
  const w = C.trackWidthFromCurrent(3, 35e-6, 10, false);
  close(C.trackCurrentFromWidth(w, 35e-6, 10, false), 3);
  const e = C.trackElectrical(1, 0.2e-3, 35e-6, 20e-3);
  close(e.resistance, 1.72e-8 * 20e-3 / (0.2e-3 * 35e-6)); close(e.loss, e.vdrop);
});
test("Calculator: via size, fusing current, wavelength (panel formulas)", () => {
  const v = C.viaSize({ hole: 0.4e-3, plating: 0.035e-3, length: 1.6e-3, pad: 0.6e-3, clearance: 1e-3, z0: 50, current: 1, rho: 1.72e-8, er: 4.5, deltaT: 10, riseTime: 1 });
  close(v.resistance, 1.72e-8 * 1.6e-3 / (Math.PI * 0.435e-3 * 0.035e-3));
  close(v.capacitance, 55.51 * 4.5 * 1.6e-3 * 0.6e-3 / 0.4e-3);
  assert.strictEqual(v.padTooBig, false);
  assert.ok(C.viaSize({ hole: 0.4e-3, plating: 35e-6, length: 1.6e-3, pad: 1e-3, clearance: 1e-3, z0: 50, current: 1, rho: 1.72e-8, er: 4.5, deltaT: 10, riseTime: 1 }).padTooBig);
  const f = C.fusingCurrent({ ambient: 25, melting: 1084, width: 0.1e-3, thickness: 0.035e-3, current: 10, time: 0.01 }, "current");
  const back = C.fusingCurrent({ ambient: 25, melting: 1084, width: 0.1e-3, thickness: 0.035e-3, current: f.value, time: 0 }, "time");
  close(back.value, 0.01, 1e-9);
  assert.ok(isNaN(C.fusingCurrent({ ambient: 2000, melting: 1084, width: 1, thickness: 1, current: 1, time: 1 }, "current").value), "melting below ambient is an Error");
  const wl = C.wavelength(1e9, 4, 1); close(wl.vacuum, 0.299792458); close(wl.medium, 0.149896229); close(wl.period, 1e-9);
});
test("Calculator: E-series decades, board classes, color code columns, unit selectors, %g", () => {
  assert.deepStrictEqual(C.eSeries(3), [100, 220, 470]);
  assert.deepStrictEqual(C.eSeries(6), [100, 150, 220, 330, 470, 680]);
  assert.strictEqual(C.eSeries(96).length, 96); assert.strictEqual(C.eSeries(48)[1], 105); assert.strictEqual(C.eSeries(1)[0], 100);
  assert.strictEqual(C.BOARD_CLASSES.length, 6); close(C.BOARD_CLASSES[2][2], 0.45e-3); assert.strictEqual(C.BOARD_CLASSES[0][2], null);
  assert.deepStrictEqual(C.colorCodeColumns(0).map((c) => c.label), ["1st Band", "2nd Band", "3rd Band", "Multiplier", "Tolerance"]);
  assert.deepStrictEqual(C.colorCodeColumns(1).map((c) => c.label), ["1st Band", "2nd Band", "3rd Band", "4th Band", "Multiplier", "Tolerance"]);
  assert.deepStrictEqual(C.colorCodeColumns(1).map((c) => c.bitmap), ["color_code_value_and_name", "color_code_value", "color_code_value", "color_code_value", "color_code_multiplier", "color_code_tolerance"]);
  assert.deepStrictEqual(C.LEN_CABLE_UNITS.map((u) => u[0]), ["cm", "m", "km", "inch", "feet"]);
  assert.deepStrictEqual(C.TIME_UNITS.map((u) => u[0]), ["ns", "ps"]); assert.deepStrictEqual(C.SPEED_UNITS.map((u) => u[0]), ["m/s", "ft/s", "km/h", "mi/h"]);
  assert.deepStrictEqual(C.RESISTOR_UNITS.map((u) => u[0]), ["Ω", "kΩ"]); assert.strictEqual(C.THICKNESS_UNITS[5][0], "oz/ft²");
  assert.deepStrictEqual(C.DIELECTRIC_CONSTANTS[0], ["4.5", "FR4"]); assert.deepStrictEqual(C.RESISTIVITIES[1], ["1.72e-8", "copper"]);
  assert.strictEqual(C.fmtG(1.72e-8), "1.72e-08"); assert.strictEqual(C.fmtG(0.2), "0.2"); assert.strictEqual(C.fmtG(1234567), "1.23457e+06"); assert.strictEqual(C.fmtG(12.5), "12.5");
});

let Rn = null; try { Rn = load(["canvas", "render.ts"]); } catch (e) { Rn = null; }
test("Grid: GAL's grid tick and minor line width (graphics_abstraction_layer.cpp:150-162, .h:1462)", () => {
  assert.ok(Rn && Rn.gridTick, "canvas/render.ts loads");
  assert.strictEqual(Rn.gridTick({}), 10); assert.strictEqual(Rn.gridTick({ gridShowMajor: false }), 0);
  assert.strictEqual(Rn.autoSparsePitch(1, 0, 3), 4, "show major off thins by 2");
  assert.strictEqual(Rn.autoSparsePitch(1, 10, 3), 10);
  assert.strictEqual(Rn.gridMinorPx({ gridLineWidth: 0.5 }, 1), 1, "0.5 px is clamped to 1 px");
  assert.strictEqual(Rn.gridMinorPx({}, 1), 1); assert.strictEqual(Rn.gridMinorPx({}, 2), 2);
  assert.strictEqual(Rn.gridMinorPx({ gridLineWidth: 2 }, 1), 2); assert.strictEqual(Rn.gridMinorPx({ gridLineWidth: 1.5 }, 2), 3);
});

const V = load(["viewer3d", "colors.ts"]);
test("3D: Use board stackup colors reads BOARD_ADAPTER's tables, mixes every dielectric and takes the finish", () => {
  const near = (a, b) => assert.ok(a.every((x, i) => Math.abs(x - b[i]) < 1e-6), JSON.stringify(a) + " vs " + JSON.stringify(b));
  near(V.stackupColor("Green", "mask"), [20 / 255, 51 / 255, 36 / 255, 0.83]);
  near(V.stackupColor("Red", "mask"), [181 / 255, 19 / 255, 21 / 255, 0.83]);
  near(V.stackupColor("White", "silk"), [245 / 255, 245 / 255, 245 / 255, 1]);
  near(V.stackupColor(undefined, "silk"), [245 / 255, 245 / 255, 245 / 255, 1]);
  near(V.stackupColor("Light Green", "mask"), [91 / 255, 168 / 255, 12 / 255, 0.83]);
  near(V.stackupColor("#102030C0", "board"), [16 / 255, 32 / 255, 48 / 255, 0xC0 / 255]);
  near(V.stackupColor("Mystery", "board"), [0, 0, 0, 1]);
  const one = V.stackupOverride([{ name: "dielectric 1", type: "core", color: "FR4 natural" }]);
  near(one.board, [109 / 255, 116 / 255, 75 / 255, 0.83 + 0.17 * 0.83 / 2]);
  const two = V.stackupOverride([{ name: "dielectric 1", type: "core", color: "FR4 natural" }, { name: "dielectric 2", type: "prepreg", color: "Polyimide" }]);
  const a1 = 0.83 + 0.17 * 0.83 / 2, pi = [205 / 255, 130 / 255, 0], fr = [109 / 255, 116 / 255, 75 / 255], f = 1 - 0.68;
  near(two.board, [pi[0] * (1 - f) + fr[0] * f, pi[1] * (1 - f) + fr[1] * f, pi[2] * (1 - f) + fr[2] * f, a1 + (1 - a1) * 0.68 / 2]);
  near(V.stackupOverride([], "ENIG").copper, [178 / 255, 156 / 255, 0, 1]);
  near(V.stackupOverride([], "HAL lead-free").copper, [160 / 255, 160 / 255, 160 / 255, 1]);
  near(V.stackupOverride([], "Immersion silver").copper, [213 / 255, 213 / 255, 213 / 255, 1]);
  near(V.stackupOverride([], "OSP").copper, [184 / 255, 115 / 255, 50 / 255, 1]);
  assert.strictEqual(V.stackupOverride([], "None").copper, undefined);
  assert.strictEqual(V.stackupOverride([], "User defined").copper, undefined);
});

console.log(`feat-common: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
