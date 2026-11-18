// model3d.test.js — the 3D Models tab's logic (web/domains/pcb/library/model3d.ts): FILENAME_RESOLVER::ValidateFileName, where a
// model path points, PANEL_FP_PROPERTIES_3D_MODEL's status problems, the configured path choices, the picker's
// filters, PANEL_PREVIEW_3D_MODEL's spin steps and the FPHOLDER preview board.
// Run: node server/static/tests/model3d.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const built = esbuild.buildSync({ entryPoints: [webPath("domains", "pcb", "library", "model3d.ts")], bundle: true, format: "cjs", target: "es2020", write: false });
const mod = { exports: {} }; new Function("exports", "module", "require", built.outputFiles[0].text)(mod.exports, mod, require); const M = mod.exports;

test("ValidateFileName follows FILENAME_RESOLVER's rules", () => {
  assert.equal(M.validateModelFileName("").ok, false);
  assert.equal(M.validateModelFileName("${KICAD10_3DMODEL_DIR}/R.3dshapes/R_0402.step").ok, true);
  assert.deepEqual(M.validateModelFileName(":MYLIB:R.step"), { ok: true, hasAlias: true });
  assert.equal(M.validateModelFileName("MY.LIB:R.step").ok, false, "a dot in the alias");
  assert.equal(M.validateModelFileName("lib:").ok, false, "ends with ':'");
  assert.equal(M.validateModelFileName("kicad-embed://model.step").ok, true);
  assert.equal(M.validateModelFileName("kicad-embed:///model.step").ok, false);
});

test("model paths resolve to the 3D library, the project, embedded files or vendors", () => {
  assert.deepEqual(M.modelTarget("${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0402_1005Metric.wrl"), { kind: "kicad", lib: "Resistor_SMD", name: "R_0402_1005Metric", ext: "wrl" });
  assert.equal(M.modelTarget("${KICAD9_3DMODEL_DIR}/X.3dshapes/Y.step").kind, "kicad");
  assert.deepEqual(M.modelTarget("${KIPRJMOD}/models/part.step"), { kind: "project", path: "models/part.step" });
  assert.deepEqual(M.modelTarget("models/part.step"), { kind: "project", path: "models/part.step" });
  assert.deepEqual(M.modelTarget("kicad-embed://a.step"), { kind: "embedded", name: "a.step" });
  assert.equal(M.modelTarget("${KICAD_COLLAB_3DMODELS}/x.3dshapes/y.step").kind, "vendor");
  assert.equal(M.modelTarget("/home/me/part.step").kind, "other");
});

test("status column problems", () => {
  const env = { projectFiles: ["models/part.step"], embedded: ["e.step"], libItems: (lib) => (lib === "R" ? new Set(["R_0402"]) : lib === "Slow" ? undefined : null) };
  assert.deepEqual(M.modelProblem("", env), { icon: "warning", text: "No filename entered" });
  assert.deepEqual(M.modelProblem("A.B:x.step", env), { icon: "error", text: "Illegal filename" });
  assert.equal(M.modelProblem("${KICAD10_3DMODEL_DIR}/R.3dshapes/R_0402.step", env).icon, "");
  assert.deepEqual(M.modelProblem("${KICAD10_3DMODEL_DIR}/R.3dshapes/R_9999.step", env), { icon: "error", text: "File not found" });
  assert.equal(M.modelProblem("${KICAD10_3DMODEL_DIR}/Slow.3dshapes/x.step", env), undefined, "a listing on its way");
  assert.equal(M.modelProblem("${KICAD10_3DMODEL_DIR}/Gone.3dshapes/x.step", env).icon, "", "an unreachable server says nothing");
  assert.equal(M.modelProblem("${KIPRJMOD}/models/part.wrl", env).icon, "", "the STEP sibling of a .wrl");
  assert.equal(M.modelProblem("kicad-embed://e.step", env).icon, "");
  assert.equal(M.modelProblem("kicad-embed://f.step", env).text, "File not found");
  assert.equal(M.modelProblem("/abs/x.step", env).text, "File not found");
});

test("configured paths and filters", () => {
  assert.deepEqual(M.configuredPathChoices(), ["Automatic", "${KIPRJMOD}", "${KICAD10_3DMODEL_DIR}"]);
  const f = M.modelFilterList();
  assert.match(f[0].label, /^All supported files \(\*\.stp;/);
  assert.equal(f[f.length - 1].exts, null);
  assert.ok(M.matchesFilter("a.STEP", f[0].exts));
  assert.ok(!M.matchesFilter("a.txt", f[0].exts));
  assert.ok(M.matchesFilter("a.txt", null));
});

test("spin and wheel steps", () => {
  assert.equal(M.stepScale(1, 1, false), 1.1);
  assert.equal(M.stepScale(1, -1, true), 0.98);
  assert.equal(M.stepScale(0.00005, -1, false), 1 / 10000);
  assert.equal(M.stepRotation(90, 1, false), 180);
  assert.equal(M.stepRotation(180, 1, false), -90);
  assert.equal(M.stepRotation(0, -1, true), -1);
  assert.equal(M.stepOffset(0, 1, false, "mm"), 0.5);
  assert.equal(M.stepOffset(0, 1, true, "mm"), 0.1);
  assert.equal(M.stepOffset(0, 1, false, "mil"), 0.635);
  assert.equal(M.stepOffset(999.9, 1, false, "mm"), 1000);
  assert.equal(M.formatScale(1), "1.0000");
  assert.equal(M.formatRotation(-0), "0.00°");
});

test("the preview board holds the footprint with the dialog's models", () => {
  const fp = '(footprint "R_0402" (version 20241229) (layer "F.Cu") (pad "1" smd rect (at -0.5 0) (size 0.5 0.5) (layers "F.Cu")) (model "${KICAD10_3DMODEL_DIR}/old.3dshapes/old.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))';
  const t = M.previewBoardText(fp, [{ file: "${KIPRJMOD}/new.step", show: false, opacity: 0.5, offset: [1, 2, 3], scale: [1, 1, 1], rotate: [0, 0, 90] }], 1.2);
  assert.match(t, /^\(kicad_pcb /);
  assert.match(t, /\(thickness 1\.2\)/);
  assert.ok(!t.includes("old.step"), "the footprint's own models are replaced");
  assert.match(t, /\(model "\$\{KIPRJMOD\}\/new\.step" \(hide yes\) \(opacity 0\.5\) \(offset \(xyz 1 2 3\)\)/);
  assert.match(t, /\(footprint "R_0402" \(at 0 0\) \(version/, "placed at the origin");
  const bare = M.previewBoardText(null, [{ file: "a.step", show: true, opacity: 1, offset: [0, 0, 0], scale: [1, 1, 1], rotate: [0, 0, 0] }]);
  assert.match(bare, /\(footprint "preview" \(at 0 0\) \(layer "F\.Cu"\)/); assert.match(bare, /\(layers\)\) \(model "a\.step"/);
  // balanced parentheses
  let d = 0; for (const c of t.replace(/"(?:[^"\\]|\\.)*"/g, "")) { if (c === "(") d++; else if (c === ")") d--; assert.ok(d >= 0); }
  assert.equal(d, 0);
});
