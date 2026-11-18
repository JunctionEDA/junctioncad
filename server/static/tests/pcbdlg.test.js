// pcbdlg.test.js — the board dialogs' models: Set Track and Via Properties (pcb-tools/global-tracks.ts) and
// Filter Selected Items (pcb-tools/filter-selection.ts).
// Run: node server/static/tests/pcbdlg.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { webPath } = require("./web-path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, T = globalThis.PcbTools;

const BOARD = `(kicad_pcb (version 20241229) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (4 "In1.Cu" signal) (25 "Edge.Cuts" user) (5 "F.SilkS" user))
  (net 0 "") (net 1 "GND") (net 2 "VCC")
  (footprint "Lib:R" (layer "F.Cu") (uuid "fp1") (at 10 10) (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS") (uuid "r1") (effects (font (size 1 1) (thickness 0.15)))))
  (footprint "Lib:R" (layer "F.Cu") (locked yes) (uuid "fp2") (at 20 10) (property "Reference" "R2" (at 0 0 0) (layer "F.SilkS") (uuid "r2") (effects (font (size 1 1) (thickness 0.15)))))
  (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))
  (segment (start 0 1) (end 5 1) (width 0.2) (layer "B.Cu") (net 2) (uuid "s2"))
  (via (at 1 1) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (via micro (at 2 2) (size 0.3) (drill 0.1) (layers "F.Cu" "In1.Cu") (net 1) (uuid "v2"))
  (gr_line (start 0 0) (end 30 0) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "e1"))
  (gr_line (start 0 5) (end 30 5) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "g1"))
  (gr_text "hi" (at 3 3 0) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))
  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z1") (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))
  (target plus (at 5 5) (size 5) (width 0.1) (layer "Edge.Cuts") (uuid "tg"))
)`;
const doc = () => K.parseDoc(BOARD, "kicad_pcb");
const settings = () => T.designSettings({ net_settings: { classes: [{ name: "Default", track_width: 0.3, via_diameter: 0.7, via_drill: 0.35, microvia_diameter: 0.25, microvia_drill: 0.12, clearance: 0.2 }] } });
const ALL = { tracks: true, throughVias: true, microVias: true, blindVias: true, buriedVias: true };
const run = (job) => new Map(T.globalTrackViaChanges(doc(), Object.assign({ scope: ALL, filter: {}, specified: true, values: {}, settings: settings() }, job)).map((c) => [c.id, c]));
// a MODIFIED change carries the item as the board text it becomes
const nodeOf = (c) => { const t = K.parse(c.sexpr); return t[t.length - 1]; };
const kidv = (n, k, i = 1) => K.kid(n, k)[i];

test("specified track width and via size, net filter", () => {
  const m = run({ filter: { net: "GND" }, values: { trackWidth: 0.5, via: { diameter: 1.0, drill: 0.5 } } });
  assert.deepEqual([...m.keys()].sort(), ["s1", "v1", "v2"]);
  assert.equal(kidv(nodeOf(m.get("s1")), "width"), 0.5);
  assert.equal(kidv(nodeOf(m.get("v1")), "size"), 1); assert.equal(kidv(nodeOf(m.get("v1")), "drill"), 0.5);
  // a microvia takes the net class's uvia sizes (SetTrackSegmentWidth)
  assert.equal(kidv(nodeOf(m.get("v2")), "size"), 0.25); assert.equal(kidv(nodeOf(m.get("v2")), "drill"), 0.12);
});
test("scope, layer and width filters, leave unchanged", () => {
  assert.deepEqual([...run({ scope: { tracks: true }, values: { trackWidth: 0.5 } }).keys()].sort(), ["s1", "s2"]);
  assert.deepEqual([...run({ filter: { layer: "B.Cu" }, values: { trackWidth: 0.5 } }).keys()], ["s2"]);
  assert.deepEqual([...run({ filter: { trackWidth: 0.25 }, values: { trackWidth: 0.5 } }).keys()], ["s1"]);
  assert.deepEqual([...run({ scope: { microVias: true }, filter: { viaDiameter: 0.8 }, values: { via: { diameter: 1, drill: 0.5 } } }).keys()], []);
  assert.equal(run({ values: {} }).size, 0, "nothing specified changes nothing");
  assert.deepEqual([...run({ filter: { selection: new Set(["s2"]) }, values: { trackWidth: 0.5 } }).keys()], ["s2"]);
});
test("layer, annular rings and protection on vias", () => {
  const m = run({ values: { layer: "In1.Cu", annular: 2, protection: 3 } });
  assert.equal(kidv(nodeOf(m.get("s1")), "layer"), "In1.Cu");
  const v = K.serialize(nodeOf(m.get("v1")));
  assert.ok(v.includes("(remove_unused_layers yes)") && v.includes("(keep_end_layers no)"), v);
  assert.ok(/\(tenting/.test(v), v);
  assert.ok(!K.serialize(nodeOf(m.get("v1"))).includes("In1.Cu"), "a via keeps its layers");
});
test("net class values", () => {
  const m = run({ specified: false });
  assert.equal(kidv(nodeOf(m.get("s1")), "width"), 0.3);
  assert.equal(kidv(nodeOf(m.get("v1")), "size"), 0.7); assert.equal(kidv(nodeOf(m.get("v1")), "drill"), 0.35);
  assert.equal(kidv(nodeOf(m.get("v2")), "size"), 0.25);
});
test("Filter Selected Items: KiCad's eight options", () => {
  const d = doc(), all = [...d.items.keys()], D = T.FILTER_SELECTION_DEFAULTS;
  const keep = (o) => T.filterSelectionIds(d, all, Object.assign({}, D, o)).sort();
  assert.ok(keep({}).includes("fp2") && keep({}).includes("tg"));
  assert.deepEqual(keep({ includeLockedFootprints: false }).filter((i) => i.startsWith("fp")), ["fp1"]);
  assert.deepEqual(keep({ includeFootprints: false }).filter((i) => i.startsWith("fp")), []);
  const edgeOff = keep({ includeBoardOutlineLayer: false });
  assert.ok(!edgeOff.includes("e1") && !edgeOff.includes("tg") && edgeOff.includes("g1"));
  const off = Object.fromEntries(Object.keys(D).map((k) => [k, false]));
  assert.deepEqual(keep(Object.assign({}, off, { includeVias: true })), ["v1", "v2"]);
  assert.deepEqual(keep(Object.assign({}, off, { includePcbTexts: true })), ["t1"]);
  assert.deepEqual(keep(Object.assign({}, off, { includeZones: true, includeTracks: true })), ["s1", "s2", "z1"]);
});
test("Zone Manager: automatically assign zone priorities", () => {
  const Z = (net, name, x0, y0, x1, y1, prio) => `(zone (net ${net}) (net_name "${name}") (layer "F.Cu") (uuid "z${name}")${prio ? ` (priority ${prio})` : ""} (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy ${x0} ${y0}) (xy ${x1} ${y0}) (xy ${x1} ${y1}) (xy ${x0} ${y1}))))`;
  const board = (zones, extra = "") => K.parseDoc(`(kicad_pcb (version 20241229) (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) (net 0 "") (net 1 "GND") (net 2 "VCC") ${zones} ${extra})`, "kicad_pcb");
  // the small VCC zone inside the big GND one, both without pads: the smaller zone wins
  let d = board(Z(1, "GND", 0, 0, 50, 50, 1) + Z(2, "VCC", 10, 10, 20, 20, 0));
  let p = T.autoZonePriorities(d);
  assert.ok(p.get("zVCC") > p.get("zGND"), JSON.stringify([...p]));
  // already in that order: nothing changes
  assert.equal(T.autoZonePriorities(board(Z(1, "GND", 0, 0, 50, 50, 0) + Z(2, "VCC", 10, 10, 20, 20, 1))), null);
  // GND vias in the overlap outnumber the VCC ones: GND goes on top
  const vias = [11, 12, 13, 14].map((x, i) => `(via (at ${x} 15) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v${i}"))`).join(" ");
  d = board(Z(1, "GND", 0, 0, 50, 50, 0) + Z(2, "VCC", 10, 10, 20, 20, 1), vias);
  p = T.autoZonePriorities(d);
  assert.ok(p.get("zGND") > p.get("zVCC"), JSON.stringify([...p]));
  // apart: no overlap, no change
  assert.equal(T.autoZonePriorities(board(Z(1, "GND", 0, 0, 5, 5, 0) + Z(2, "VCC", 10, 10, 20, 20, 1))), null);
});

test("Footprint Properties 3D Models: models and the extruded body read and written", () => {
  const M = T.fpModels;
  const fp = K.parse(`(footprint "Lib:C" (layer "F.Cu") (uuid "f") (at 0 0) (descr "d") (property "Reference" "C1" (at 0 0 0) (layer "F.SilkS") (uuid "r"))
    (model "\${KICAD10_3DMODEL_DIR}/A.3dshapes/a.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
    (embedded_files (file (name "a.pdf") (type datasheet) (data |abc|)) (file (name "b.step") (type model) (data |def|))))`);
  const models = M.readModels(fp);
  assert.equal(models.length, 1);
  assert.equal(M.readExtruded(fp), null);
  const before = K.serialize(fp);
  assert.equal(M.writeModels(fp, models, null), false, "unchanged models leave the node alone");
  assert.equal(K.serialize(fp), before);
  models[0].show = false;
  assert.ok(M.writeModels(fp, models, { show: true, height: 3, standoff: 0.5, layer: "F.CrtYd", material: "metal", color: null }));
  const t = K.serialize(fp);
  assert.match(t, /\(model "\$\{KICAD10_3DMODEL_DIR\}\/A\.3dshapes\/a\.step" \(hide yes\)/);
  assert.match(t, /\(model \(type extruded\) \(uuid "[^"]+"\) \(hide no\) \(overall_height 3\) \(body_pcb_gap 0\.5\) \(layer "F\.CrtYd"\) \(material metal\) \(color unspecified\)/);
  assert.ok(t.indexOf("(type extruded)") < t.indexOf("a.step"), "the body goes before the file models");
  const e = M.readExtruded(fp);
  assert.equal(e.height, 3); assert.equal(e.material, "metal"); assert.equal(e.layer, "F.CrtYd");
  // removing the body
  assert.ok(M.writeModels(fp, M.readModels(fp), null));
  assert.equal(M.readExtruded(fp), null);
  // embedded files: only removal
  assert.deepEqual(M.embeddedFileNames(fp), ["a.pdf", "b.step"]);
  assert.ok(M.keepEmbeddedFiles(fp, ["b.step"]));
  assert.deepEqual(M.embeddedFileNames(fp), ["b.step"]);
  assert.ok(M.keepEmbeddedFiles(fp, []));
  assert.equal(K.kid(fp, "embedded_files"), null);
});

test("Constraints Resolution: board setup, net class and custom rules in EvalRules order", () => {
  const d = doc(), s = settings();
  s.minTrackWidth = 0.1; s.minViaDiameter = 0.4; s.minThroughDrill = 0.2; s.minViaAnnular = 0.1;
  T.setCustomRules('(version 1)\n(rule wide (constraint track_width (min 0.3mm) (opt 0.4mm)) (condition "A.NetName == \'GND\'"))\n(rule other (constraint track_width (min 1mm)) (condition "A.NetName == \'VCC\'"))');
  try {
    const p = T.inspectConstraints(d, "s1", s);
    assert.equal(p.length, 1); assert.equal(p[0].title, "Track Width");
    const t = p[0].lines.join("\n");
    assert.match(t, /Checking board setup constraints track width: min 0\.1 mm\.\nUnconditional constraint applied\./);
    assert.match(t, /Checking netclass 'Default' track width: opt 0\.3 mm\.\nConstraint applied\./);
    assert.match(t, /Checking rule 'wide': min 0\.3 mm; opt 0\.4 mm; max <i>undefined<\/i>\.\nChecking rule condition 'A\.NetName == 'GND''\.\nRule applied; overrides previous constraints\./);
    assert.match(t, /Checking rule 'other'[^\n]*\n[^\n]*\nCondition not satisfied; rule ignored\./);
    assert.equal(p[0].resolved, "Resolved width constraints: min 0.3 mm; opt 0.4 mm; max <i>undefined</i>.");
    // a microvia: the micro-via board setup constraint and the uvia net class sizes
    const v = T.inspectConstraints(d, "v2", s);
    assert.deepEqual(v.map((x) => x.title), ["Via Diameter", "Via Annular Width", "Hole Size"]);
    assert.match(v[0].lines.join("\n"), /Checking netclass 'Default' uvia via diameter: opt 0\.25 mm\./);
    assert.match(T.inspectConstraints(d, "v1", s)[0].lines.join("\n"), /micro-via via diameter: min 0\.2 mm\.\nMembership not satisfied; constraint ignored\./);
    assert.equal(T.inspectConstraints(d, "fp1", s), null);
  } finally { T.setCustomRules(null); }
});

test("Compare Footprint with Library: FootprintNeedsUpdate's report lines", () => {
  const lib = `(footprint "Lib:R" (version 20241229) (layer "F.Cu") (attr smd)
    (fp_line (start -1 -1) (end 1 -1) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "l1"))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "p1"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "p2")))`;
  // the board copy: placed and rotated (children keep footprint coordinates; a pad's angle is the board's), which
  // the comparison takes back out
  const placed = (body) => K.parse(`(footprint "Lib:R" (layer "F.Cu") (uuid "b") (at 10 20 90) (attr smd)
    (fp_line (start -1 -1) (end 1 -1) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "x1"))
    ${body})`);
  const same = placed(`(pad "1" smd rect (at -1 0 90) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "q1")) (pad "2" smd rect (at 1 0 90) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "q2"))`);
  assert.deepEqual(T.footprintDiffLines(same, K.parse(lib)), []);
  const bigger = placed(`(pad "1" smd rect (at -1 0 90) (size 1.2 1) (layers "F.Cu" "F.Mask") (uuid "q1")) (pad "2" smd rect (at 1 0 90) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "q2"))`);
  assert.deepEqual(T.footprintDiffLines(bigger, K.parse(lib)), ["Pad 1 size differs on layer F.Cu."]);
  const one = placed(`(pad "1" smd rect (at -1 0 90) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "q1"))`);
  assert.deepEqual(T.footprintDiffLines(one, K.parse(lib)), ["Pad count differs."]);
  const dnp = K.parse(K.serialize(same).replace("(attr smd)", "(attr smd dnp)").replace("(uuid \"b\")", "(uuid \"b\") (clearance 0.3)"));
  assert.deepEqual(T.footprintDiffLines(dnp, K.parse(lib)), ["'Do not populate' settings differ.", "Pad clearance overridden."]);
});

test("Shape Modification: fillet, chamfer, extend, simplify and polygon booleans", () => {
  const M = T.shapeModify;
  const B = (body) => K.parseDoc(`(kicad_pcb (version 20241229) (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user)) ${body})`, "kicad_pcb");
  const L = (id, a, b) => `(gr_line (start ${a}) (end ${b}) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "${id}"))`;
  const nodes = (r) => r.changes.filter((c) => c.kind !== "REMOVED").map(nodeOf);
  // a right-angle corner at (10, 0): the 2 mm fillet's arc runs from (8, 0) to (10, 2)
  let d = B(L("a", "0 0", "10 0") + L("b", "10 0", "10 10"));
  let r = M.modifyLines(d, ["a", "b"], "filletLines", 2);
  assert.equal(r.label, "Fillet Lines"); assert.equal(r.message, null);
  const arc = nodes(r).find((n) => n[0] === "gr_arc");
  assert.deepEqual([K.kid(arc, "start").slice(1), K.kid(arc, "end").slice(1)], [[8, 0], [10, 2]]);
  const mid = K.kid(arc, "mid").slice(1); assert.ok(Math.abs(Math.hypot(mid[0] - 8, mid[1] - 2) - 2) < 1e-4, "the arc's middle is on the 2 mm circle");
  // too large a radius: nothing changes
  r = M.modifyLines(d, ["a", "b"], "filletLines", 50); assert.equal(r.changes.length, 0); assert.equal(r.message, "Unable to fillet the selected lines.");
  // chamfer a rectangle: its four edges and four chamfers
  d = B(`(gr_rect (start 0 0) (end 10 10) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "r"))`);
  r = M.modifyLines(d, ["r"], "chamferLines", 1);
  assert.equal(nodes(r).filter((n) => n[0] === "gr_line").length, 8);
  assert.ok(r.changes.some((c) => c.kind === "REMOVED" && c.id === "r"));
  // extend two lines to meet; a single line is refused
  d = B(L("a", "0 0", "5 0") + L("b", "10 2", "10 8"));
  r = M.modifyLines(d, ["a", "b"], "extendLines", 0);
  const ends = nodes(r).map((n) => [K.kid(n, "start").slice(1), K.kid(n, "end").slice(1)]);
  assert.deepEqual(ends, [[[0, 0], [10, 0]], [[10, 8], [10, 0]]]);
  assert.deepEqual(M.modifyLines(d, ["a"], "extendLines", 0), { error: "Exactly two lines must be selected to extend them." });
  // simplify drops the collinear point
  d = B(`(gr_poly (pts (xy 0 0) (xy 5 0.001) (xy 10 0) (xy 10 10) (xy 0 10)) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "p"))`);
  r = M.simplifyPolygons(d, ["p"], 0.1);
  assert.equal(K.kids(K.kid(nodes(r)[0], "pts"), "xy").length, 4);
  // merge two overlapping squares into one polygon; subtract a hole-free bite
  d = B(`(gr_rect (start 0 0) (end 10 10) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "r1")) (gr_rect (start 5 5) (end 15 15) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "r2"))`);
  r = M.booleanPolygons(d, ["r1", "r2"], "mergePolygons");
  assert.equal(r.label, "Merge Polygons"); assert.equal(nodes(r).length, 1); assert.equal(K.kids(K.kid(nodes(r)[0], "pts"), "xy").length, 8);
  assert.equal(r.changes.filter((c) => c.kind === "REMOVED").length, 2);
  r = M.booleanPolygons(d, ["r2", "r1"], "subtractPolygons");   // r1 last: r1 minus r2
  assert.equal(K.kids(K.kid(nodes(r)[0], "pts"), "xy").length, 6);
  r = M.booleanPolygons(d, ["r1", "r2"], "intersectPolygons");
  assert.equal(K.kids(K.kid(nodes(r)[0], "pts"), "xy").length, 4);
});

// ---- PCB_BARCODE: the 2D symbologies against matrices Zint (thirdparty/zint) produced for the same input
const esbuild = require("esbuild");
const crypto = require("node:crypto");
const loadTs = (file) => { const out = esbuild.buildSync({ entryPoints: [webPath(file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" }); const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const BC = loadTs("canvas/barcode2d.ts");
// [kind, text, ecc (0 L .. 3 H), rows, sha1 of the rows joined as 0/1]
const ZINT = [
  ["qr", "HELLO", 0, 21, "aad4c593e8a43f86"],
  ["qr", "https://kicad.org/download/linux/", 3, 33, "83c088ea4dd90fc8"],
  ["qr", "PART-0001-ABCDEFGHIJKLMNOP-0123456789 PART-0001-ABCDEFGHIJKLMNOP-0123456789 PART-0001-ABCDEFGHIJKLMNOP", 1, 37, "22aefc1d7630e1f6"],
  ["qr", "KiCad ".repeat(40), 1, 61, "a1c0f76304a9b82e"],   // version 11: version information blocks
  ["qr", "Ünïcödé ✓", 0, 21, "14564b4432edb757"],          // ECI 26 + UTF-8 bytes
  ["mqr", "12345", 0, 11, "6b995ec0217fc2bf"],
  ["mqr", "AB-12", 1, 13, "a522a42245028571"],
  ["mqr", "kicad", 2, 17, "941406af31f3c614"],
  ["dm", "12345", 0, 10, "1ddcecb7d09905c7"],
  ["dm", "R1 10k 0603", 0, 14, "4b81097b653594b8"],
  ["dm", "0123456789ABCD", 0, 8, "ee04ec6aaef79d43"],          // 8x32: two data regions
  ["dm", "KICAD PCB BARCODE TEST 2026", 0, 20, "7a030a379e5c9644"],   // C40 run: 20x20 where ASCII needs 22x22
  ["dm", "SN:00012345 LOT:ABC-77", 0, 12, "dd1f147e7932a905"],        // 12x26 rectangle
  ["dm", "x" + "y".repeat(100), 0, 36, "4eda45a5baa2cad4"],           // Text encodation
];
test("barcode2d: QR, Micro QR and Data Matrix modules match Zint", () => {
  for (const [k, text, ecc, rows, sha] of ZINT) {
    const r = k === "qr" ? BC.qrCode(text, ecc) : k === "mqr" ? BC.microQrCode(text, ecc) : BC.dataMatrix(text);
    assert.ok(r.rows, k + " " + text + ": " + r.error);
    assert.equal(r.rows.length, rows, k + " " + text);
    const h = crypto.createHash("sha1").update(r.rows.map((row) => row.map((b) => (b ? "1" : "0")).join("")).join("")).digest("hex").slice(0, 16);
    assert.equal(h, sha, k + " " + JSON.stringify(text));
  }
  assert.match(BC.microQrCode("x".repeat(40), 0).error, /too long/);
  assert.match(BC.microQrCode("12", 3).error, /level H not available/);
});
test("barcode item: the QR modules are drawn, scaled to (size)", () => {
  const d = K.parseDoc(`(kicad_pcb (version 20250914) (generator "pcbnew") (layers (0 "F.Cu" signal) (5 "F.SilkS" user))
    (barcode (at 10 10 0) (layer "F.SilkS") (size 21 21) (text "HELLO") (text_height 1) (type qr) (ecc_level L) (hide yes) (knockout no) (uuid "b1")))`, "kicad_pcb");
  const it = [...d.items.values()].find((i) => i.kind === "barcode");
  assert.ok(it.geom.length > 50);
  const xs = it.geom.flatMap((g) => g.pts.map((p) => p[0]));
  assert.equal(Math.min(...xs), -0.5); assert.equal(Math.max(...xs), 20.5);   // 21 modules of 1 mm about x = 10
});
const IPC = loadTs("fab/ipc2581.ts");
test("ipc2581: function mode sections follow Table 4 and ResolveSections", () => {
  const S = (mode, req) => IPC.sectionKeyString(IPC.resolveSections("C", mode, new Set(req)).included);
  assert.equal(S("USERDEF", IPC.recommendedSections("USERDEF")), "KBCASUMPLRDOIEF");
  assert.equal(S("FABRICATION", IPC.recommendedSections("FABRICATION")), "KSUMLROIEFY");
  assert.equal(S("BOM", []), "B");
  assert.equal(S("ASSEMBLY", ["K", "P"]), "KBCAUPLRO");
  assert.deepEqual(IPC.resolveSections("C", "USERDEF", new Set(["A"])).conflicts, ["Cannot export assembly data without outer copper layers."]);
  assert.match(IPC.resolveSections("B", "USERDEF", new Set(["A", "O"])).conflicts[0], /cannot be exported without component packages in IPC-2581B/);
  assert.deepEqual(IPC.resolveSections("C", "USERDEF", new Set()).conflicts, ["No IPC-2581 content selected."]);
});
test("ipc2581: a board's file", () => {
  const FAB = loadTs("fab/index.ts");
  const d = K.parseDoc(`(kicad_pcb (version 20241229) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
    (net 0 "") (net 1 "GND")
    (gr_rect (start 0 0) (end 20 10) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)) (uuid "e1"))
    (footprint "R:R_0603" (layer "F.Cu") (uuid "f1") (at 5 5) (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS") (uuid "p1")) (property "Value" "10k" (at 0 0 0) (layer "F.Fab") (uuid "p2"))
      (attr smd) (pad "1" smd rect (at -0.8 0) (size 0.8 0.9) (layers "F.Cu" "F.Mask") (net 1 "GND") (uuid "a1")) (pad "2" smd roundrect (at 0.8 0) (size 0.8 0.9) (roundrect_rratio 0.25) (layers "F.Cu" "F.Mask") (uuid "a2")))
    (via (at 10 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
    (segment (start 4.2 5) (end 10 5) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1")))`, "kicad_pcb");
  const r = FAB.ipc2581({ doc: d, projectName: "demo", date: new Date(2026, 0, 2, 3, 4, 5) }, { rev: "C", inch: false, precision: 6, mode: "USERDEF", sections: IPC.recommendedSections("USERDEF"), anonymizeNets: false, omitRefDes: false, internalId: "", mpn: "", mfg: "", distPn: "", dist: "N/A", bomRev: "" });
  assert.deepEqual(r.errors, []);
  const x = r.xml;
  assert.match(x, /<FunctionMode mode="USERDEF" sectionKey="KBCASUMPLRDOIEF"\/>/);
  // padstacks (addPadStack): the package's two pads, then the via; each layer feature Pad names its padstack
  assert.match(x, /<Step name="demo" type="BOARD">\s*<NonstandardAttribute name="FOOTPRINT_COUNT" type="INTEGER" value="1"\/>\s*<PadStackDef name="PADSTACK_3">/);
  assert.match(x, /<PadStackDef name="PADSTACK_1">\s*<PadstackPadDef layerRef="F.Cu" padUse="REGULAR">\s*<Location x="0.0" y="0.0"\/>\s*<StandardPrimitiveRef id="RECT_\d+"\/>\s*<\/PadstackPadDef>\s*<\/PadStackDef>/);   // F.Mask is no board layer here
  assert.match(x, /<PadStackDef name="PADSTACK_3">\s*<PadstackHoleDef name="PH300000" diameter="0.3" platingStatus="VIA" plusTol="0.0" minusTol="0.0" x="0.0" y="0.0"\/>\s*<PadstackPadDef layerRef="F.Cu" padUse="REGULAR">\s*<Location x="0.0" y="0.0"\/>\s*<UserPrimitiveRef id="UCIRCLE_\d+"\/>/);
  assert.match(x, /<EntryUser id="UCIRCLE_\d+">\s*<UserSpecial>\s*<Circle diameter="0.6">\s*<LineDesc lineWidth="0.1" lineEnd="ROUND"\/>\s*<FillDesc fillProperty="HOLLOW"\/>/);
  assert.match(x, /<Pad padstackDefRef="PADSTACK_1">/); assert.match(x, /<Pad padstackDefRef="PADSTACK_3">/);
  assert.ok(x.indexOf("<PadStackDef") < x.indexOf("<Datum"), "the padstacks open the Step");
  const noK = FAB.ipc2581({ doc: d, projectName: "demo" }, { rev: "C", inch: false, precision: 6, mode: "USERDEF", sections: new Set(["O"]), anonymizeNets: false, omitRefDes: false, internalId: "", mpn: "", mfg: "", distPn: "", dist: "", bomRev: "" }).xml;
  assert.doesNotMatch(noK, /PadStackDef|padstackDefRef/);
  assert.match(x, /<Component refDes="R1" packageRef="R_R_0603" part="R_R_0603_10k" layerRef="F.Cu" mountType="SMT">/);
  assert.match(x, /<RectCenter width="0.8" height="0.9"\/>/);
  assert.match(x, /<RectRound width="0.8" height="0.9" radius="0.2"/);
  assert.match(x, /<Set net="GND">/);
  assert.match(x, /<PinRef componentRef="R1" pin="1"\/>/);
  assert.match(x, /<Hole name="H1" diameter="0.3" platingStatus="VIA" plusTol="0.0" minusTol="0.0" x="10.0" y="-5.0"\/>/);
  assert.match(x, /<BomItem OEMDesignNumberRef="R_R_0603_10k" quantity="1" pinCount="2" category="ELECTRICAL">/);
  assert.match(x, /<Profile>\s*<Polygon>\s*<PolyBegin x="0.0" y="0.0"\/>/);
  const anon = FAB.ipc2581({ doc: d, projectName: "demo" }, { rev: "B", inch: true, precision: 4, mode: "FABRICATION", sections: IPC.recommendedSections("FABRICATION"), anonymizeNets: true, omitRefDes: true, internalId: "", mpn: "", mfg: "", distPn: "", dist: "", bomRev: "" }).xml;
  assert.match(anon, /<IPC-2581 revision="B"/); assert.match(anon, /<FunctionMode mode="FABRICATION" level="3"/);
  assert.match(anon, /<Set net="NET_1">/); assert.doesNotMatch(anon, /GND|<Component |<BomItem /);
  assert.match(anon, /diameter="0.0118"/);
  // FABRICATION requires the physical netlist (PhyNetGroup): anonymised names take the _PHY suffix
  assert.match(anon, /<FunctionMode mode="FABRICATION" level="3" sectionKey="[A-Z]*Y[A-Z]*"/);
  assert.match(anon, /<PhyNetGroup name="NETS">\s*<PhyNet name="NET_1_PHY">/);
  const phy = FAB.ipc2581({ doc: d, projectName: "demo" }, { rev: "C", inch: false, precision: 6, mode: "USERDEF", sections: new Set(["O", "G", "Y"]), anonymizeNets: false, omitRefDes: false, internalId: "", mpn: "", mfg: "", distPn: "", dist: "", bomRev: "" }).xml;
  assert.match(phy, /sectionKey="OGY"/);
  // pads first, then vias; a pad on F.Cu with its mask open is EXPOSED, the tented through via COVERED and a net end
  assert.match(phy, /<PhyNet name="GND_PHY">\s*<PhyNetPoint x="4.2" y="-5.0" layerRef="F.Cu" netNode="END" exposure="EXPOSED">\s*<StandardPrimitiveRef id="RECT_\d+"\/>\s*<\/PhyNetPoint>\s*<PhyNetPoint x="10.0" y="-5.0" layerRef="F.Cu" secondaryLayerRef="B.Cu" netNode="END" exposure="COVERED" via="true">\s*<StandardPrimitiveRef id="CIRCLE_\d+"\/>/);
  assert.ok(phy.indexOf("<PhyNetGroup") < phy.indexOf("<LayerFeature"), "PhyNetGroup before the layer features");
});
test("fab reports: .cmp, legacy BOM, footprint report and IPC-D-356A", () => {
  const FAB = loadTs("fab/index.ts");
  const d = K.parseDoc(`(kicad_pcb (version 20241229) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (1 "F.Mask" user))
    (net 0 "") (net 1 "GND") (net 2 "/very/long/hierarchical/net")
    (footprint "R:R_0603" (layer "F.Cu") (uuid "f1") (at 5 5) (path "/a1") (property "Reference" "R2" (at 0 0 0) (layer "F.SilkS") (uuid "p1")) (property "Value" "10k" (at 0 0 0) (layer "F.Fab") (uuid "p2"))
      (attr smd) (pad "1" smd rect (at -0.8 0) (size 0.8 0.9) (layers "F.Cu" "F.Mask") (net 1 "GND") (uuid "a1")) (pad "2" smd roundrect (at 0.8 0) (size 0.8 0.9) (roundrect_rratio 0.25) (layers "F.Cu" "F.Mask") (net 2 "/very/long/hierarchical/net") (uuid "a2")))
    (footprint "R:R_0603" (layer "F.Cu") (uuid "f2") (at 9 5) (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS") (uuid "p3")) (property "Value" "10k" (at 0 0 0) (layer "F.Fab") (uuid "p4")) (attr smd))
    (footprint "C:C_THT" (layer "F.Cu") (uuid "f3") (at 2 2 90) (property "Reference" "C1" (at 0 0 0) (layer "F.SilkS") (uuid "p5")) (property "Value" "1u" (at 0 0 0) (layer "F.Fab") (uuid "p6")) (attr through_hole)
      (pad "1" thru_hole circle (at 0 0 90) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (net 1 "GND") (uuid "a3")))
    (via (at 10 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1")))`, "kicad_pcb");
  const ctx = { doc: d, projectName: "demo", date: new Date(2026, 0, 2, 3, 4, 5) };
  const cmp = FAB.reports.cmp(ctx);
  assert.match(cmp, /^Cmp-Mod V01 Created by PcbNew   date = 2026-01-02T03:04:05/);
  assert.match(cmp, /\nBeginCmp\nTimeStamp = f1\nPath = \/a1\nReference = R2;\nValeurCmp = 10k;\nIdModule  = R:R_0603;\nEndCmp\n/);
  assert.ok(cmp.endsWith("\nEndListe\n"));
  assert.equal(FAB.reports.legacyBom(ctx), '"Id";"Designator";"Footprint";"Quantity";"Designation";"Supplier and ref";\n1;"C1";"C_THT";1;"1u";;;\n2;"R1, R2";"R_0603";2;"10k";;;\n');
  const rpt = FAB.reports.footprintReport(ctx, true, [0, 0]);
  assert.match(rpt, /\$MODULE C1\nreference C1\nvalue 1u\nfootprint C:C_THT\nattribut none\nposition  2\.000000  2\.000000  orientation 90\.00\nlayer front\n\$PAD "1"\nShape Circle Layer both\nposition  0\.000000  0\.000000 size  1\.600000  1\.600000 orientation 90\.00\ndrill  0\.800000\n/);
  assert.ok(rpt.indexOf("$MODULE C1") < rpt.indexOf("$MODULE R1") && rpt.indexOf("$MODULE R1") < rpt.indexOf("$MODULE R2"));
  const dn = FAB.reports.d356(ctx, false).split("\n");
  assert.equal(dn[0], "P  JOB   demo".padEnd(80));
  assert.equal(dn[5], "P  IMAGE PRIMARY".padEnd(80));
  assert.equal(dn[6], "P  NNAMEM0000 /very/long/hierarchical/net".padEnd(80));
  assert.ok(dn.includes("317GND              VIA        MD0118PA00X+003937Y-001969X0236Y0000R000 S3      "), dn.join("\n"));
  assert.ok(dn.includes("327GND              R2    -1          A01X+001654Y-001969X0315Y0354R000 S2      "), dn.join("\n"));
  assert.ok(dn.includes("327M0000            R2    -2          A01X+002283Y-001969X0315Y0354R000 S2      "));
  assert.ok(dn.includes("317GND              C1    -1    D0315PA00X+000787Y-000787X0630Y0000R270 S0      "), dn.join("\n"));
  assert.equal(dn[dn.length - 2], "999".padEnd(80));
  assert.equal(FAB.reports.d356(ctx, true).includes("R1"), false);
});

test("Outset Items: rectangles, circles, lines, arcs and pads", () => {
  const O = T.outset;
  const B = (body) => K.parseDoc(`(kicad_pcb (version 20241229) (layers (0 "F.Cu" signal) (25 "Edge.Cuts" user) (37 "F.SilkS" user)) ${body})`, "kicad_pcb");
  const nodes = (r) => r.changes.filter((c) => c.kind !== "REMOVED").map(nodeOf);
  const at = (n, k) => K.kid(n, k).slice(1).map((v) => +(+v).toFixed(4));
  const P = (o) => Object.assign(O.outsetDefaults(false, () => 0.05), o);
  assert.deepEqual(O.outsetDefaults(true, () => 0.05), { outset: 0.25, roundCorners: false, useSourceLayers: false, useSourceWidths: true, layer: "F.CrtYd", lineWidth: 0.05, gridRounding: 0.01, deleteSourceItems: false });
  // a square rectangle, outset 1 without rounding, copying its layer and width
  let d = B(`(gr_rect (start 0 0) (end 10 5) (stroke (width 0.2) (type default)) (fill no) (layer "F.SilkS") (uuid "r"))`);
  let r = O.outsetItems(d, ["r"], P({ roundCorners: false }));
  assert.equal(r.label, "Outset Items"); assert.equal(r.message, null);
  let n = nodes(r)[0];
  assert.equal(n[0], "gr_rect"); assert.deepEqual([at(n, "start"), at(n, "end")], [[-1, -1], [11, 6]]);
  assert.equal(K.kid(n, "layer")[1], "F.SilkS"); assert.equal(+K.kid(K.kid(n, "stroke"), "width")[1], 0.2);
  // rounded: four sides and four corner arcs of radius 1
  r = O.outsetItems(d, ["r"], P({}));
  assert.deepEqual(nodes(r).map((x) => x[0]).sort(), ["gr_arc", "gr_arc", "gr_arc", "gr_arc", "gr_line", "gr_line", "gr_line", "gr_line"]);
  const a0 = nodes(r).find((x) => x[0] === "gr_arc");
  assert.deepEqual([at(a0, "start"), at(a0, "end")], [[10, -1], [11, 0]]);
  // grid rounding outwards; a given layer and width
  r = O.outsetItems(d, ["r"], P({ outset: 0.33, roundCorners: false, gridRounding: 0.5, useSourceLayers: false, useSourceWidths: false, lineWidth: 0.12 }));
  n = nodes(r)[0]; assert.deepEqual([at(n, "start"), at(n, "end")], [[-0.5, -0.5], [10.5, 5.5]]);
  assert.equal(K.kid(n, "layer")[1], "Edge.Cuts"); assert.equal(+K.kid(K.kid(n, "stroke"), "width")[1], 0.12);
  // a circle grows; without rounding it becomes its square
  d = B(`(gr_circle (center 5 5) (end 7 5) (stroke (width 0.1) (type default)) (fill no) (layer "F.SilkS") (uuid "c"))`);
  n = nodes(O.outsetItems(d, ["c"], P({ outset: 0.5 })))[0]; assert.deepEqual([n[0], at(n, "center"), at(n, "end")], ["gr_circle", [5, 5], [7.5, 5]]);
  n = nodes(O.outsetItems(d, ["c"], P({ outset: 0.5, roundCorners: false })))[0]; assert.deepEqual([n[0], at(n, "start"), at(n, "end")], ["gr_rect", [2.5, 2.5], [7.5, 7.5]]);
  // a line: the stadium (two lines, two half circles), or its box as a polygon; delete the source when asked
  d = B(`(gr_line (start 0 0) (end 10 0) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "l"))`);
  r = O.outsetItems(d, ["l"], P({ deleteSourceItems: true }));
  const st = nodes(r);
  assert.deepEqual(st.map((x) => x[0]).sort(), ["gr_arc", "gr_arc", "gr_line", "gr_line"]);
  assert.deepEqual(st.filter((x) => x[0] === "gr_line").map((x) => [at(x, "start"), at(x, "end")]), [[[0, -1], [10, -1]], [[10, 1], [0, 1]]]);
  assert.deepEqual(at(st.find((x) => x[0] === "gr_arc"), "mid"), [-1, 0]);
  assert.ok(r.changes.some((c) => c.kind === "REMOVED" && c.id === "l"));
  n = nodes(O.outsetItems(d, ["l"], P({ roundCorners: false })))[0];
  assert.deepEqual(K.kids(K.kid(n, "pts"), "xy").map((x) => x.slice(1).map(Number)), [[-1, -1], [-1, 1], [11, 1], [11, -1]]);
  assert.equal(O.outsetItems(d, ["l"], P({ outset: 0 })).message, "Unable to outset the selected items.");
  // an arc: outer, inner and two end caps
  d = B(`(gr_arc (start 10 0) (mid 7.071068 7.071068) (end 0 10) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "a"))`);
  const arcs = nodes(O.outsetItems(d, ["a"], P({ outset: 1 })));
  assert.equal(arcs.length, 4);
  assert.deepEqual([at(arcs[0], "start"), at(arcs[0], "end")], [[11, 0], [0, 11]]);
  assert.deepEqual([at(arcs[2], "start"), at(arcs[2], "end")], [[0, 9], [9, 0]]);
  assert.deepEqual(O.arcThrough([10, 0], [7.071068, 7.071068], [0, 10]).angle.toFixed(3), "90.000");
  // footprint editor pads: a rotated rectangle without rounding is a polygon; a circle a circle; a roundrect gets arcs
  const fp = K.parseDoc(`(footprint "X" (version 20241229) (generator "pcbnew") (layer "F.Cu")
    (pad "1" smd rect (at 0 0 90) (size 2 1) (layers "F.Cu") (uuid "p1"))
    (pad "2" thru_hole circle (at 5 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu") (uuid "p2"))
    (pad "3" smd roundrect (at 10 0) (size 2 1) (roundrect_rratio 0.25) (layers "F.Cu") (uuid "p3")))`, "footprint");
  const pid = (num) => [...fp.items.values()].find((i) => i.kind === "pad" && i.node[1] === num).id;
  r = O.outsetItems(fp, [pid("1")], O.outsetDefaults(true, () => 0.05));
  n = nodes(r)[0]; assert.equal(n[0], "gr_poly"); assert.equal(K.kid(n, "layer")[1], "F.CrtYd");
  assert.deepEqual(K.kids(K.kid(n, "pts"), "xy").map((x) => x.slice(1).map((v) => +(+v).toFixed(4))), [[-0.75, 1.25], [-0.75, -1.25], [0.75, -1.25], [0.75, 1.25]]);
  n = nodes(O.outsetItems(fp, [pid("2")], P({ outset: 0.2, useSourceLayers: true })))[0]; assert.deepEqual([n[0], at(n, "end"), K.kid(n, "layer")[1]], ["gr_circle", [6, 0], "F.Cu"]);
  r = O.outsetItems(fp, [pid("3")], P({ outset: 0.25, deleteSourceItems: true }));
  assert.equal(nodes(r).filter((x) => x[0] === "gr_arc").length, 4); assert.ok(!r.changes.some((c) => c.kind === "REMOVED"), "a pad is never deleted");
});

test("Board Statistics: counts, minimums, drill lines and the fab areas", () => {
  const S = T.boardStats;
  const d = K.parseDoc(`(kicad_pcb (version 20241229) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
    (net 0 "") (net 1 "A") (net 2 "B")
    (footprint "X:T" (layer "F.Cu") (uuid "f1") (at 5 5) (attr through_hole)
      (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (net 1 "A") (uuid "p1"))
      (pad "2" thru_hole oval (at 3 0) (size 1.6 2.4) (drill oval 0.8 1.6) (layers "*.Cu" "*.Mask") (property pad_prop_castellated) (net 2 "B") (uuid "p2")))
    (footprint "X:S" (layer "B.Cu") (uuid "f2") (at 15 5) (attr smd) (pad "1" smd rect (at 0 0) (size 1 1) (layers "B.Cu") (uuid "p3")))
    (footprint "X:L" (layer "F.Cu") (uuid "f3") (at 15 15))
    (segment (start 0 10) (end 10 10) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))
    (segment (start 0 10.75) (end 10 10.75) (width 0.2) (layer "F.Cu") (net 2) (uuid "s2"))
    (segment (start 0 10.4) (end 10 10.4) (width 0.2) (layer "B.Cu") (net 2) (uuid "s3"))
    (via (at 12 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
    (via (at 14 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 2) (uuid "v2"))
    (gr_rect (start 0 0) (end 20 20) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "e")))`, "kicad_pcb");
  let s = S.boardStatsData(d, { excludeNoPads: false });
  assert.deepEqual(s.footprints, [{ title: "THT:", front: 1, back: 0 }, { title: "SMD:", front: 0, back: 1 }, { title: "Unspecified:", front: 1, back: 0 }]);
  assert.deepEqual(s.pads.map((p) => p.count), [2, 1, 0, 0, 0]); assert.equal(s.padTotal, 3); assert.equal(s.padProps[0].count, 1);
  assert.deepEqual(s.vias.map((v) => v.count), [2, 0, 0, 0]);
  assert.equal(s.minTrackWidth, 0.2);
  // s1 / s2 on F.Cu: 0.75 apart, less 0.125 and 0.1 of copper; the vias are 2 mm apart less 0.6
  assert.ok(Math.abs(s.minClearance - 0.525) < 1e-9, String(s.minClearance));
  assert.equal(s.minDrill, 0.3);
  assert.deepEqual(s.drills.map((x) => [x.count, x.shape, x.x, x.y, x.plated, x.pad, x.start, x.stop]), [[2, "Round", 0.3, 0.3, true, false, "F.Cu", "B.Cu"], [1, "Round", 0.8, 0.8, true, true, "F.Cu", "B.Cu"], [1, "Slot", 0.8, 1.6, true, true, "F.Cu", "B.Cu"]]);
  assert.deepEqual([s.hasOutline, s.width, s.height], [true, 20, 20]);
  s = S.boardStatsData(d, { excludeNoPads: true });
  assert.equal(s.footprints[2].front, 0);
  // the areas: board 400 mm², less the holes when asked
  const FAB = loadTs("fab/index.ts");
  const ctx = { doc: d, projectName: "demo", date: new Date(2026, 0, 1) };
  const a = FAB.api.statAreas(ctx, { subtractHolesFromBoard: false, subtractHolesFromCopper: false, courtyards: T.courtyards });
  assert.ok(Math.abs(a.boardArea - 400) < 1e-6 && a.hasOutline);
  const b = FAB.api.statAreas(ctx, { subtractHolesFromBoard: true, subtractHolesFromCopper: true, courtyards: T.courtyards });
  const holes = 2 * Math.PI * 0.15 * 0.15 + Math.PI * 0.4 * 0.4 + (0.8 * 0.8 + Math.PI * 0.4 * 0.4);
  assert.ok(Math.abs(400 - b.boardArea - holes) < 0.01, `${400 - b.boardArea} vs ${holes}`);
  assert.ok(a.frontCopper > 5 && b.frontCopper < a.frontCopper, `${a.frontCopper} ${b.frontCopper}`);
  // footprint areas: each plated pad's copper grown by the default clearance (0.2) on both sides, no courtyards here:
  // a 2.0 circle and a 2.0 x 2.8 oval
  const fpArea = Math.PI + (2.0 * 0.8 + Math.PI);
  assert.ok(Math.abs(a.frontCourtyard - fpArea) < 0.05 && Math.abs(a.backCourtyard - fpArea) < 0.05, `${a.frontCourtyard} ${a.backCourtyard} vs ${fpArea}`);
  // a blind via's drill comes off only the outer layer it reaches
  const bl = K.parseDoc(`(kicad_pcb (version 20241229) (generator "pcbnew") (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
    (net 0 "") (net 1 "A")
    (via blind (at 5 5) (size 0.6) (drill 0.3) (layers "F.Cu" "In1.Cu") (net 1) (uuid "v1"))
    (segment (start 4 5) (end 6 5) (width 0.5) (layer "B.Cu") (net 1) (uuid "s1"))
    (gr_rect (start 0 0) (end 10 10) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "e")))`, "kicad_pcb");
  const bctx = { doc: bl, projectName: "demo", date: new Date(2026, 0, 1) };
  const b0 = FAB.api.statAreas(bctx, { subtractHolesFromBoard: false, subtractHolesFromCopper: false });
  const b1 = FAB.api.statAreas(bctx, { subtractHolesFromBoard: false, subtractHolesFromCopper: true });
  assert.ok(Math.abs(b0.frontCopper - b1.frontCopper - Math.PI * 0.15 * 0.15) < 0.005, `front ${b0.frontCopper} ${b1.frontCopper}`);
  assert.ok(Math.abs(b0.backCopper - b1.backCopper) < 1e-9, `back ${b0.backCopper} ${b1.backCopper}`);
});
