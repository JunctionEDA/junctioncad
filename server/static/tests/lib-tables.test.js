// lib-tables.test.js — the Symbol / Footprint Libraries dialogs' table logic (web/domains/pcb/library/libtable.ts): the plugin
// lists of PANEL_SYM_LIB_TABLE / PANEL_FP_LIB_TABLE, the Add Existing menu, format guessing, FixIllegalChars,
// VerifyTable, the options string, clipboard rows and the path substitutions.
// Run: node server/static/tests/lib-tables.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const built = esbuild.buildSync({ entryPoints: [webPath("domains", "pcb", "library", "libtable.ts")], bundle: true, format: "cjs", target: "es2020", write: false });
const mod = { exports: {} }; new Function("exports", "module", "require", built.outputFiles[0].text)(mod.exports, mod, require); const T = mod.exports;

test("Add Existing menus follow the plugin registries", () => {
  const sym = T.addExistingMenu("symbol").map((e) => e.label);
  assert.deepEqual(sym.slice(0, 3), ["KiCad (.kicad_sym)", "KiCad (folder with .kicad_sym files)", "Legacy (.lib)"]);
  assert.equal(sym[sym.indexOf("Database (.kicad_dbl)") + 1], "New Database Library...");
  assert.equal(sym[sym.length - 1], "Table");
  const fp = T.addExistingMenu("footprint").map((e) => e.label);
  assert.equal(fp[0], "KiCad (folder with *.kicad_mod files)");
  assert.ok(fp.includes("Legacy (*.mod, *.emp)"));
  assert.ok(fp.includes("gEDA / Lepton EDA (folder with *.fp files)"));
  assert.equal(fp[fp.length - 1], "Table");
  assert.ok(T.formatChoices("symbol").includes("CADSTAR Schematic Archive"));
  assert.deepEqual(T.formatChoices("footprint", "Odd").slice(-1), ["Odd"]);
});
test("format from the path", () => {
  assert.equal(T.guessFormat("symbol", "lib/x.kicad_sym"), "KiCad");
  assert.equal(T.guessFormat("symbol", "lib/old.lib"), "Legacy");
  assert.equal(T.guessFormat("symbol", "a/b.kicad_dbl"), "Database");
  assert.equal(T.guessFormat("symbol", "nested/sym-lib-table"), "Table");
  assert.equal(T.guessFormat("footprint", "x.pretty"), "KiCad");
  assert.equal(T.guessFormat("footprint", "x.lbr"), "Eagle");
  assert.equal(T.guessFormat("footprint", "x.unknown"), "");
});
test("nicknames", () => {
  assert.equal(T.fixIllegalChars("a:b\\c d"), "a_b_c d");
  assert.equal(T.nicknameFor("symbol", "lib/My Lib.kicad_sym", "KiCad"), "My Lib");
  assert.equal(T.nicknameFor("footprint", "lib/Conn.pretty", "KiCad"), "Conn");
  assert.equal(T.nicknameFor("footprint", "lib/old.mod", "Legacy"), "old");
});
test("VerifyTable", () => {
  const row = (nickname, uri) => ({ enabled: true, visible: false, nickname, uri, type: "KiCad", options: "", descr: "" });
  assert.deepEqual(T.verifyRows([row("a", ""), row(" b ", " ${KIPRJMOD}/b.kicad_sym ")], true).rows.map((r) => [r.nickname, r.uri]), [["b", "${KIPRJMOD}/b.kicad_sym"]]);
  assert.equal(T.verifyRows([row("", "x")], true).error, "Library must have a nickname.");
  assert.equal(T.verifyRows([row("a:b", "x")], true).error, "Illegal character ':' in nickname 'a:b'.");
  const dup = T.verifyRows([row("a", "x"), row("a", "y")], true); assert.equal(dup.error, "Multiple libraries cannot share the same nickname ('a')."); assert.equal(dup.row, 1);
  assert.equal(T.verifyRows([row("a", "x")], false).rows[0].visible, true, "footprint tables never save a hidden flag");
});
test("options string", () => {
  const m = T.parseOptions("b=2|a|c=x\\|y");
  assert.deepEqual([...m], [["a", ""], ["b", "2"], ["c", "x|y"]]);
  assert.equal(T.formatOptions(m), "a|b=2|c=x\\|y");
});
test("clipboard rows", () => {
  const rows = [];
  const blank = () => ({ enabled: true, visible: true, nickname: "", uri: "", type: "KiCad", options: "", descr: "" });
  T.applyPaste(rows, T.pasteCells("A,${KIPRJMOD}/a.kicad_sym\nB,${KIPRJMOD}/b.kicad_sym\n"), 0, 2, blank);
  assert.deepEqual(rows.map((r) => [r.nickname, r.uri]), [["A", "${KIPRJMOD}/a.kicad_sym"], ["B", "${KIPRJMOD}/b.kicad_sym"]]);
  assert.equal(T.copyRows(rows.slice(0, 1), false), "1\tA\t${KIPRJMOD}/a.kicad_sym\tKiCad\t\t");
});
test("project paths and substitutions", () => {
  assert.equal(T.projectPath("${KIPRJMOD}/lib/x.pretty/"), "lib/x.pretty");
  assert.equal(T.projectPath("${KICAD10_FOOTPRINT_DIR}/x.pretty"), null);
  assert.deepEqual(T.pathSubstitutions("footprint", ["${MYLIBS}/a.pretty", "$(OLD)/b"]), ["KICAD10_3DMODEL_DIR", "KICAD10_FOOTPRINT_DIR", "KIPRJMOD", "MYLIBS", "OLD"]);
  const paths = ["lib/fp.pretty/R.kicad_mod", "lib/s.kicad_sym", "sub/sym-lib-table", "a.lbr"];
  assert.deepEqual(T.projectCandidates("footprint", { type: "KiCad", folder: true }, paths), ["lib/fp.pretty"]);
  assert.deepEqual(T.projectCandidates("symbol", { type: "KiCad" }, paths), ["lib/s.kicad_sym"]);
  assert.deepEqual(T.projectCandidates("symbol", { type: "Table" }, paths), ["sub/sym-lib-table"]);
  const r = { enabled: true, visible: true, nickname: "fp", uri: "${KIPRJMOD}/lib/fp.pretty", type: "KiCad", options: "", descr: "" };
  assert.equal(T.projectLibraryExists("footprint", r, paths), true);
  assert.equal(T.projectLibraryExists("footprint", { ...r, uri: "${KIPRJMOD}/gone.pretty" }, paths), false);
  assert.equal(T.projectLibraryExists("footprint", { ...r, uri: "${KICAD10_FOOTPRINT_DIR}/x.pretty" }, paths), null);
});
