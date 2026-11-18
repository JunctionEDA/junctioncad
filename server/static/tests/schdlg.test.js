// schdlg.test.js — schematic dialogs parity: Sheet Pin Properties (DIALOG_SHEET_PIN_PROPERTIES) and the logic behind
// the simulator, library-link, update-from-PCB, setup and preference pages added with it.
// Run: node server/static/tests/schdlg.test.js
"use strict";
const path = require("path"), assert = require("assert");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const K = globalThis.KiCadCanvas;
const L = load(["dialogs", "sch-items-logic.ts"]);

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }

const SHEET = `(sheet (at 100 50) (size 40 30) (uuid "s")
  (property "Sheetname" "sub" (at 100 49 0) (effects (font (size 1.27 1.27))))
  (pin "VPP" input (at 100 60 180) (uuid "p1") (effects (font (size 1.524 1.524)) (justify left)))
  (pin "CLK/IN" output (at 140 70 0) (uuid "p2") (effects (font (face "Arial") (size 1.27 1.27) (italic yes)) (justify right))))`;

test("readSheetPin: name, shape token, text width as size, face, bold / italic", () => {
  const n = K.parse(SHEET), pins = L.kids(n, "pin");
  assert.deepEqual(L.readSheetPin(pins[0]), { text: "VPP", shape: "input", font: L.KICAD_FONT, size: 1.524, bold: false, italic: false, color: null });
  const b = L.readSheetPin(pins[1]); assert.equal(b.shape, "output"); assert.equal(b.font, "Arial"); assert.equal(b.italic, true);
});
test("writeSheetPin: escapes '/', writes the shape in place (no (shape …)), size w = h, bold", () => {
  const n = K.parse(SHEET), pin = L.kids(n, "pin")[0];
  L.writeSheetPin(pin, { text: "A/B", shape: "tri_state", font: L.KICAD_FONT, size: 2, bold: true, italic: false, color: null });
  const out = K.serialize(pin);
  assert.ok(/^\(pin "A\{slash\}B" tri_state/.test(out), out);
  assert.ok(!/\(shape/.test(out));
  assert.ok(/\(size 2 2\)/.test(out), out); assert.ok(/\(bold yes\)/.test(out), out);
});
test("sheetPinNameError: an empty or blank name is refused", () => {
  assert.equal(L.sheetPinNameError("  "), "Sheet pin name can not be empty.");
  assert.equal(L.sheetPinNameError("X"), null);
});
test("sheetPinAt: a left-edge pin reads rightwards into the sheet, a right-edge one leftwards", () => {
  const n = K.parse(SHEET);
  assert.equal(L.sheetPinAt(n, [100.5, 60]), 0);
  assert.equal(L.sheetPinAt(n, [103, 60.3]), 0);
  assert.equal(L.sheetPinAt(n, [98, 60]), -1);
  assert.equal(L.sheetPinAt(n, [138, 70]), 1);
  assert.equal(L.sheetPinAt(n, [141.5, 70]), -1);
  assert.equal(L.sheetPinAt(n, [120, 55]), -1);
});


// ---------------------------------------------------------------- simulator logic
const SL = load(["sim", "sim-logic.ts"]);
test("SPICE_VALUE: parse with SPICE prefixes, ToSpiceString normalised", () => {
  assert.equal(SL.parseSpiceValue("10u"), 10e-6); assert.equal(SL.parseSpiceValue("1Meg"), 1e6); assert.equal(SL.parseSpiceValue("2.2k"), 2200);
  assert.equal(SL.parseSpiceValue("5m"), 5e-3); assert.ok(Number.isNaN(SL.parseSpiceValue("abc")));
  assert.equal(SL.toSpiceString(1e-6), "1u"); assert.equal(SL.toSpiceString(4700), "4.7k"); assert.equal(SL.toSpiceString(1e7), "10Meg"); assert.equal(SL.toSpiceString(0.25), "250m");
  assert.equal(SL.spiceText("1000"), "1k");
});
test("SPICE_VALUE::ToString with a format: auto range, fixed range, degrees", () => {
  assert.equal(SL.formatValue(0.0012345, { precision: 3, range: "~V" }), "1.23mV");
  assert.equal(SL.formatValue(2500, { precision: 2, range: "KHz" }), "2.5KHz");
  assert.equal(SL.formatValue(190, { precision: 1, range: "°" }), "-170.0°");
  assert.deepEqual(SL.formatFromString(""), { precision: 3, range: "~V" });
  assert.equal(SL.formatToString(SL.updateUnits({ precision: 4, range: "~V" }, "s")), "4~s");
});
test("DIALOG_SIM_COMMAND: .tran with optional fields, uic defaulting the max step", () => {
  assert.equal(SL.tranCommand({ step: "1u", final: "1m", initial: "", maxStep: "", uic: false }), ".tran 1u 1m");
  assert.equal(SL.tranCommand({ step: "1u", final: "1m", initial: "", maxStep: "", uic: true }), ".tran 1u 1m 0 1u uic");
  assert.equal(SL.tranCommand({ step: "10u", final: "1m", initial: "0.1m", maxStep: "5u", uic: false }), ".tran 10u 1m 100u 5u");
});
test("DIALOG_SIM_COMMAND: .ac / .dc / .noise / .pz / fft and their errors", () => {
  assert.equal(SL.acCommand({ scale: "dec", points: "10", fStart: "1", fStop: "1Meg" }), ".ac dec 10 1 1Meg");
  assert.equal(SL.dcCommand({ src1: { type: "V", source: "V1", start: "0", stop: "5", incr: "0.1" }, src2: null }), ".dc V1 0 5 100m");
  assert.deepEqual(SL.dcCommand({ src1: { type: "V", source: "V1", start: "0", stop: "5", incr: "1" }, src2: { type: "V", source: "V1", start: "0", stop: "1", incr: "1" } }), { error: "Source 1 and Source 2 must be different." });
  assert.deepEqual(SL.dcCommand({ src1: { type: "V", source: "", start: "0", stop: "5", incr: "1" }, src2: null }), { error: "A DC source must be specified." });
  assert.equal(SL.noiseCommand({ meas: "/out", ref: "", src: "V1", scale: "dec", points: "10", fStart: "1", fStop: "1k", saveAll: false }), ".noise v(/out) V1 dec 10 1 1k");
  assert.deepEqual(SL.noiseCommand({ meas: "/out", ref: "", src: "V1", scale: "dec", points: "10", fStart: "", fStop: "1k", saveAll: false }), { error: "A frequency range must be specified." });
  assert.equal(SL.pzCommand({ input: "in", inputRef: "0", output: "out", outputRef: "0", func: "vol", find: "pz" }), ".pz in 0 out 0 vol pz");
  assert.equal(SL.fftCommand({ signals: ["V(a)", "V(b)"], linearize: true }), "linearize V(a) V(b)\nfft V(a) V(b)");
});
test("parseCommand round-trips the pages; CommandToSimType", () => {
  assert.equal(SL.commandToSimType(".tran 1u 1m"), "TRAN"); assert.equal(SL.commandToSimType(".op"), "OP"); assert.equal(SL.commandToSimType("linearize v(a)\nfft v(a)"), "FFT"); assert.equal(SL.commandToSimType(".foo"), "Custom");
  const t = SL.parseCommand(".tran 1u 1m 0 1u uic").tran; assert.deepEqual(t, { step: "1u", final: "1m", initial: "0", maxStep: "1u", uic: true });
  const d = SL.parseCommand(".dc V1 0 5 0.1 TEMP 0 100 10").dc; assert.equal(d.src1.source, "V1"); assert.equal(d.src1.incr, "100m"); assert.equal(d.src2.type, "TEMP");
  const n = SL.parseCommand(".noise v(/out,/ref) V1 oct 5 10 100k 1").noise; assert.deepEqual(n, { meas: "/out", ref: "/ref", src: "V1", scale: "oct", points: "5", fStart: "10", fStop: "100k", saveAll: true });
  assert.deepEqual(SL.parseCommand(".ac lin 100 1k 10k").ac, { scale: "lin", points: "100", fStart: "1k", fStop: "10k" });
});
test("the circuit, signals list and vector names", () => {
  const c = SL.readCircuit(".title t\nV1 /in 0 DC 1\nR1 /in /out 1k\nC1 /out 0 1u\nQ1 /c /b 0 BC547\n.subckt X a b\nR9 a b 1\n.ends\n.save v(/x)\n.end\n");
  assert.deepEqual(c.items.map((i) => i.name), ["V1", "R1", "C1", "Q1"]);
  assert.deepEqual(c.nets, ["/b", "/c", "/in", "/out", "0"]);
  const s = SL.signalsFor("TRAN", c, SL.DEFAULT_OPTIONS);
  assert.ok(s.includes("V(/out)") && !s.includes("V(0)") && s.includes("I(R1)") && s.includes("I(Q1:c)") && !s.includes("Ic(Q1)") && s.includes("P(R1)") && s.includes("V(/X)"));
  assert.ok(SL.signalsFor("AC", c, SL.DEFAULT_OPTIONS).includes("V(/out) (gain)"));
  assert.deepEqual(SL.vectorToSignal("r1#branch"), { signal: "I(r1)", kind: "I" });
  assert.deepEqual(SL.vectorToSignal("r1:power"), { signal: "P(r1)", kind: "P" });
  assert.deepEqual(SL.vectorToSignal("v(/out)"), { signal: "V(/out)", kind: "V" });
  assert.equal(SL.signalExpr("P(R1)"), "r1:power"); assert.equal(SL.signalExpr("Ic(Q1)"), "@q1[ic]");
});
test("ngspice ASCII raw: real and complex plots, lookup by signal", () => {
  const raw = "Title: t\nDate: x\nPlotname: Transient Analysis\nFlags: real\nNo. Variables: 3\nNo. Points: 2\nVariables:\n\t0\ttime\ttime\n\t1\tv(/out)\tvoltage\n\t2\ti(r1)\tcurrent\nValues:\n 0\t0.0\n\t1.5\n\t-2e-3\n\n 1\t1e-6\n\t2.5\n\t-1e-3\n" +
    "Title: t\nPlotname: AC Analysis\nFlags: complex\nNo. Variables: 2\nNo. Points: 1\nVariables:\n\t0\tfrequency\tfrequency\n\t1\tv(/out)\tvoltage\nValues:\n 0\t1.0,0.0\n\t0.0,1.0\n";
  const p = SL.parseRaw(raw); assert.equal(p.length, 2);
  assert.deepEqual(Array.from(SL.findVector(p[0], "V(/out)").re), [1.5, 2.5]);
  assert.deepEqual(Array.from(SL.findVector(p[0], "I(R1)").re), [-2e-3, -1e-3]);
  const v = SL.findVector(p[1], "V(/out)"); assert.ok(p[1].complex);
  assert.equal(Math.round(SL.acPart(v, "phase")[0]), 90); assert.equal(SL.acPart(v, "gain")[0], 0);
  assert.equal(SL.interpolate([0, 1, 2], [0, 10, 20], 1.5), 15);
});
test("measurements: units, meas line, rows from the signal grid", () => {
  assert.equal(SL.measurementUnits("MAX V(/out)", "TRAN"), "V"); assert.equal(SL.measurementUnits("MAX_AT V(/out)", "AC"), "Hz");
  assert.equal(SL.measurementUnits("INTEG P(R1)", "TRAN"), "J"); assert.equal(SL.measurementUnits("RMS I(R1)", "TRAN"), "A");
  assert.equal(SL.measCommand("AVG P(R1)", "TRAN", 2), "meas TRAN meas_result_2 AVG R1:power");
  assert.equal(SL.measurementFor("MAX", "V(/out) (gain)"), "MAX vdb(/out)"); assert.equal(SL.measurementFor("MAX", "V(/out) (phase)"), null);
});
test("workbook options <-> command lines; user signals; E series", () => {
  const cmds = SL.commandsFromOptions(".tran 1u 1m", SL.DEFAULT_OPTIONS); assert.deepEqual(cmds, [".tran 1u 1m", ".kicad adjustpaths", ".save all", ".probe alli", ".probe allp"]);
  assert.deepEqual(SL.optionsFromCommands(cmds), { command: ".tran 1u 1m", options: SL.DEFAULT_OPTIONS });
  assert.equal(SL.userSignalLet(0, "V(/a)-V(/b)*P(R1)"), "let user0 = v(/a)-v(/b)*r1:power");
  assert.equal(SL.snapToSeries(4600, 24), 4700); assert.equal(SL.eSeries(96).length, 96);
});

const PL = load(["sim", "plot.ts"]);
test("plot: tick labels with SI prefixes and units, 1-2-5 steps", () => {
  assert.equal(PL.tickLabel(0.002, "s", 0.01), "2ms"); assert.equal(PL.tickLabel(0, "V", 2), "0V");
  assert.equal(PL.tickLabel(-0.4, "V", 2), "-400mV"); assert.equal(PL.tickLabel(1000, "Hz", 1e6), "1KHz");
  assert.equal(PL.tickLabel(-45, "°", 180), "-45°");
  assert.equal(PL.niceStep(10, 10), 1); assert.equal(PL.niceStep(0.01, 5), 0.002); assert.equal(PL.niceStep(7, 2), 5);
});
test("signals list: no duplicate power rows from .probe p() directives", () => {
  const c = SL.readCircuit(".title x\n.save all\n.probe alli\n.probe p(R1)\nR1 a 0 1k\nV1 a 0 dc 1\n.end\n");
  const s = SL.signalsFor("TRAN", c, SL.DEFAULT_OPTIONS);
  assert.equal(s.filter((x) => x === "P(R1)").length, 1, s.join(","));
});

const BA = load(["dialogs", "update-from-pcb-logic.ts"]);
const sym = (o) => Object.assign({ key: "/a", keys: ["/a"], ref: "R1", power: false, value: "1k", footprint: "R:R_0603", dnp: false, inBom: true, inPos: true, onBoard: true, fields: new Map(), pins: new Map([["1", "/IN"]]) }, o);
const ALL = { relink: false, references: true, footprints: true, values: true, netNames: true, attributes: true, otherFields: true };
test("back-annotation: value, footprint, reference, attributes, fields, net label; report lines", () => {
  const fp = BA.fpData(K.parse('(footprint "R:R_0805" (path "/a") (property "Reference" "R5") (property "Value" "2k2") (property "MPN" "X1") (property "ki_fp_filters" "R_*") (attr smd dnp exclude_from_bom) (pad "1" smd rect (net 3 "/VIN")))'));
  assert.equal(fp.fpid, "R:R_0805"); assert.equal(fp.dnp, true); assert.ok(!fp.fields.has("ki_fp_filters"));
  const r = BA.backAnnotate([sym({ fields: new Map([["Old", "x"]]) })], [fp], ALL);
  const t = r.lines.map((l) => l.text);
  assert.ok(t.includes("Change R1 reference designator to 'R5'."), t.join("\n"));
  assert.ok(t.includes("Change R1 footprint assignment from 'R:R_0603' to 'R:R_0805'."));
  assert.ok(t.includes("Change R1 value from '1k' to '2k2'."));
  assert.ok(t.includes("Change R1 'Do not populate' from 'false' to 'true'."));
  assert.ok(t.includes("Change R1 'Exclude from bill of materials' from 'false' to 'true'."));
  assert.ok(t.includes("Add R1 field 'MPN' with value 'X1'.")); assert.ok(t.includes("Delete R1 field 'Old.'"));
  assert.ok(t.includes("Change R1 pin 1 net label from '/IN' to '/VIN'."));
  assert.equal(r.edits[0].ref, "R5"); assert.equal(r.labels[0].to, "/VIN");
});
test("back-annotation: unmatched footprints and symbols, nothing selected, re-link by reference", () => {
  const fp = { ref: "R9", path: "/zz", fpid: "R:R", value: "1k", dnp: false, excludeFromBom: false, excludeFromPos: false, fields: new Map(), pads: new Map() };
  const r = BA.backAnnotate([sym()], [fp], ALL);
  assert.deepEqual(r.lines.map((l) => l.severity + ":" + l.text), ["error:Cannot find symbol for footprint 'R9'.", "warning:Footprint 'R1' is not present on PCB. Corresponding symbols in schematic must be manually deleted (if desired)."]);
  assert.equal(BA.backAnnotate([sym()], [fp], { relink: false, references: false, footprints: false, values: false, netNames: false, attributes: false, otherFields: false }).lines[0].text, "Select at least one property to back annotate.");
  const rl = BA.backAnnotate([sym({ ref: "R9" })], [fp], Object.assign({}, ALL, { relink: true, references: false }));
  assert.deepEqual(rl.relinks, [{ fpRef: "R9", path: "/a" }]);
});
// a quad gate: units 1..4 each with pins (in, out); unit 2's nets on the board are unit 1's and the other way round
const quadUnits = () => { const unitPins = new Map([[1, ["1", "2"]], [2, ["3", "4"]]]), pinTypes = new Map([["1", "input"], ["2", "output"], ["3", "input"], ["4", "output"]]);
  return [{ key: "/u1", unit: 1, unitPins, pinTypes }, { key: "/u2", unit: 2, unitPins, pinTypes }]; };
test("back-annotation: a gate swap on the board is a unit swap with 'Prefer symbol unit swaps', labels otherwise", () => {
  const s = sym({ ref: "U1", keys: ["/u1", "/u2"], key: "/u1", pins: new Map([["1", "/A"], ["2", "/B"], ["3", "/C"], ["4", "/D"]]), units: quadUnits() });
  const fp = { ref: "U1", path: "/u1", fpid: "P:SO8", value: "1k", dnp: false, excludeFromBom: false, excludeFromPos: false, fields: new Map(), pads: new Map([["1", "/C"], ["2", "/D"], ["3", "/A"], ["4", "/B"]]) };
  const o = Object.assign({}, ALL, { footprints: false, values: false, references: false, attributes: false, otherFields: false });
  const r = BA.backAnnotate([s], [fp], Object.assign({}, o, { unitSwaps: true }));
  assert.deepStrictEqual(r.lines.map((l) => l.text), ["Swap U1 unit A with unit B."]);
  assert.deepStrictEqual(r.unitEdits, [{ key: "/u1", unit: 2 }, { key: "/u2", unit: 1 }]); assert.equal(r.labels.length, 0);
  const off = BA.backAnnotate([s], [fp], Object.assign({}, o, { unitSwaps: false }));
  assert.equal(off.unitEdits.length, 0); assert.equal(off.labels.length, 4);
});
test("back-annotation: two pads trading nets are a pin swap, only reported without unconstrained pin swaps", () => {
  const s = sym({ ref: "U1", keys: ["/u1"], key: "/u1", pins: new Map([["1", "/A"], ["2", "/B"]]), units: [{ key: "/u1", unit: 1, unitPins: new Map([[1, ["1", "2"]]]), pinTypes: new Map([["1", "input"], ["2", "input"]]) }] });
  const fp = { ref: "U1", path: "/u1", fpid: "P:X", value: "1k", dnp: false, excludeFromBom: false, excludeFromPos: false, fields: new Map(), pads: new Map([["1", "/B"], ["2", "/A"]]) };
  const o = Object.assign({}, ALL, { footprints: false, values: false, references: false, attributes: false, otherFields: false, pinSwaps: true });
  const no = BA.backAnnotate([s], [fp], o);
  assert.ok(no.lines[0].text.startsWith("Would swap U1 pins 1 and 2 to match PCB, but unconstrained pin swaps are disabled"), no.lines[0].text);
  assert.equal(no.pinSwaps.length, 0); assert.equal(no.labels.length, 2);   // the labels change as without the option
  const yes = BA.backAnnotate([s], [fp], Object.assign({}, o, { allowPinSwaps: true }));
  assert.deepStrictEqual(yes.lines.map((l) => l.text), ["Swap U1 pins 1 and 2 to match PCB."]);
  assert.deepStrictEqual(yes.pinSwaps, [{ key: "/u1", a: "1", b: "2" }]); assert.equal(yes.labels.length, 0);
  const lib = K.parse('(symbol "X:G" (symbol "G_1_1" (pin input line (at 0 0 0) (length 2.54) (name "A") (number "1")) (pin input line (at 0 5 180) (length 5.08) (name "B") (number "2"))))');
  assert.deepStrictEqual([...BA.libUnitPins(lib).unitPins.get(1)], ["2", "1"]);   // by x, then y downwards
  assert.ok(BA.swapLibPins(lib, 1, "1", "2"));
  assert.ok(/\(at 0 5 180\) \(length 5.08\) \(name "A"\)/.test(K.serialize(lib).replace(/\s+/g, " ")), K.serialize(lib));
});

// ---- Import Sheet / paste: references compared by number (SCH_REFERENCE_LIST), Import Sheet's reset annotation
const CB = load(["tools", "sch-tools", "clipboard.ts"]);
test("assignPastedRef: #PWR1 is taken by #PWR01; the next free number counts the zero-padded ones", () => {
  const used = new Set(["#PWR01", "#PWR02", "R1"]);
  const n = K.parse('(symbol (lib_id "power:GND") (at 0 0 0) (property "Reference" "#PWR1" (at 0 0 0)))');
  const S = CB.S || null; void S;
  CB.assignPastedRef(null, n, used);
  const ref = K.str(L.kids(n, "property")[0][2]);
  assert.ok(ref === "#PWR?" || ref === "#PWR3", ref);
});

// ---------------------------------------------------------------- Schematic Setup pages
const SP = load(["dialogs", "schematic-setup-logic.ts"]);
test("annotation: separator choice and settings round-trip", () => {
  assert.equal(SP.separatorChoice(undefined, undefined), 0);
  assert.equal(SP.separatorChoice(49, 95), 6); assert.equal(SP.separatorChoice(65, 46), 1);
  const sch = { subpart_first_id: 49, subpart_id_separator: 45, annotation: { sort_order: 1, method: 2 }, annotate_start_num: 7 };
  const a = SP.annotationOf(sch);
  assert.deepEqual(a, { notation: 5, sortY: true, method: 2, startNum: 7, reuse: true, suffixes: false, incrementPasted: true });
  a.notation = 3; a.sortY = false; a.suffixes = true; SP.writeAnnotation(sch, a);
  assert.equal(sch.subpart_first_id, 65); assert.equal(sch.subpart_id_separator, 95);
  assert.deepEqual(sch.annotation, { sort_order: 0, method: 2, reused_sheet_suffixes: true, increment_pasted_suffix: true });
});
test("compare symbols: KiCad's defaults, file values win", () => {
  const p = SP.parityOf({ compare_symbols: { extra_fields: true, missing_fields: false } });
  assert.equal(p.extra_fields, true); assert.equal(p.missing_fields, false); assert.equal(p.field_texts, true); assert.equal(p.dnp_flags, false);
  assert.equal(Object.keys(p).length, 12);
});
test("net chains: rows from the root sheet, class assignments written back", () => {
  const K = globalThis.KiCadCanvas;
  const top = K.parseAll(`(kicad_sch (version 20250000) (net_chain "SIG" (from "U1" "3") (to "J1" "1") (net_class "HS") (color 255 0 0 1) (nets "A" "B")) (net_chain "CLK" (from "U1" "4") (to "J1" "2")))`)[0];
  const st = { chains: SP.chainsOf(top, { SIG: "fast", GONE: "fast", OLD: "dropped" }), classes: ["fast"] };
  assert.equal(st.chains.length, 2); assert.deepEqual(st.chains[0].nets, ["A", "B"]); assert.equal(st.chains[0].netClass, "HS");
  assert.equal(st.chains[0].color, "rgba(255, 0, 0, 1)"); assert.equal(st.chains[0].chainClass, "fast"); assert.equal(st.chains[1].chainClass, "");
  st.chains[1].chainClass = "fast";
  assert.deepEqual(SP.chainClassesJson(st, { SIG: "fast", GONE: "fast", OLD: "dropped" }), { GONE: "fast", SIG: "fast", CLK: "fast" });
  assert.equal(SP.chainClassError(["a", "a"]), "Duplicate class name 'a' on row 2."); assert.equal(SP.chainClassError(["a", " "]), "Class on row 2 cannot have an empty name.");
  assert.equal(SP.validChainName("a b"), false); assert.equal(SP.validChainName("ok_1"), true);
});
test("import settings: only the chosen sections are copied", () => {
  const to = { schematic: { drawing: { default_text_size: 50, field_names: [{ name: "Keep" }] }, bus_aliases: { X: ["a"] } }, erc: { pin_map: [[0]] }, text_variables: { V: "1" } };
  const from = { schematic: { drawing: { default_text_size: 60, junction_size_choice: 1, field_names: [{ name: "Other" }] }, annotation: { method: 1 }, annotate_start_num: 100, bus_aliases: { Y: ["b"] } }, erc: { rule_severities: { a: "ignore" }, pin_map: [[1]] }, net_settings: { classes: [{ name: "Default" }], netclass_patterns: [] }, text_variables: { W: "2" } };
  SP.importSections(to, from, ["formatting", "annotation", "severities"]);
  assert.deepEqual(to.schematic.drawing, { default_text_size: 60, junction_size_choice: 1, field_names: [{ name: "Keep" }] });
  assert.deepEqual(to.schematic.annotation, { method: 1 }); assert.equal(to.schematic.annotate_start_num, 100);
  assert.deepEqual(to.schematic.bus_aliases, { X: ["a"] }); assert.deepEqual(to.erc.pin_map, [[0]]); assert.deepEqual(to.erc.rule_severities, { a: "ignore" });
  assert.deepEqual(to.text_variables, { V: "1" });
  SP.importSections(to, from, ["fieldNames", "textVars", "netClasses"]);
  assert.deepEqual(to.schematic.drawing.field_names, [{ name: "Other" }]); assert.deepEqual(to.text_variables, { W: "2" }); assert.deepEqual(to.net_settings.classes, [{ name: "Default" }]);
});
test("embedded files: the root sheet's list and font flag", () => {
  const e = SP.embeddedOf(`(kicad_sch (embedded_fonts yes) (lib_symbols (symbol "x" (embedded_files (file (name "lib.pdf"))))) (embedded_files (file (name "a.pdf") (type datasheet)) (file (name "b \\"x\\".step"))) (symbol (file (name "no"))))`);
  assert.deepEqual(e.files, ["a.pdf", 'b \\"x\\".step']); assert.equal(e.fonts, true);
});

// ---------------------------------------------------------------- Symbol Library Browser
const SV = load(["symview", "logic.ts"]);
test("symbol viewer: filters need every token, stepping stops at the ends", () => {
  assert.equal(SV.tokensMatch("op dual", "LM358 dual opamp"), true); assert.equal(SV.tokensMatch("op quad", "LM358 dual opamp"), false);
  assert.equal(SV.tokensMatch("  ", "x"), true);
  assert.equal(SV.symbolSearchText({ name: "R", keywords: "res", description: "Resistor", source: "official" }), "R res Resistor");
  assert.equal(SV.stepSymbol(["a", "b", "c"], "b", 1), "c"); assert.equal(SV.stepSymbol(["a", "b", "c"], "c", 1), "c");
  assert.equal(SV.stepSymbol(["a", "b", "c"], "a", -1), "a"); assert.equal(SV.stepSymbol(["a", "b"], "zz", 1), "a");
});

module.exports = { test, load, K };
const DL = load(["dialogs", "logic.ts"]);
test("pushFindHistory: newest first, repeats move up, empty skipped, capped at 10", () => {
  let l = [];
  for (const s of ["a", "b", "", "c", "a"]) l = DL.pushFindHistory(l, s);
  assert.deepStrictEqual(l, ["a", "c", "b"]);
  for (let i = 0; i < 20; i++) l = DL.pushFindHistory(l, "x" + i);
  assert.strictEqual(l.length, DL.FIND_HISTORY_MAX); assert.strictEqual(l[0], "x19");
});
test("hyperlink combo: page entries map to #<page>, the separator restores the text", () => {
  const pages = [["1", "Root"], ["2", "sub"]];
  assert.deepStrictEqual(L.hyperlinkChoices(pages), ["Page 1 (Root)", "Page 2 (sub)", "---", "file://...", "http://...", "https://..."]);
  assert.strictEqual(L.hyperlinkPick("Page 2 (sub)", pages, ""), "#2");
  assert.strictEqual(L.hyperlinkPick("---", pages, "https://x"), "https://x");
  assert.strictEqual(L.hyperlinkPick("file://...", pages, ""), "file://");
  assert.strictEqual(L.hyperlinkPick("https://...", pages, ""), "https://");
});
const KDT = load(["components", "kdate.ts"]);
test("date picker: ISO parse / format, Monday-first month grid, month steps clamp the day", () => {
  assert.strictEqual(KDT.parseIso("2024-02-30"), null); assert.strictEqual(KDT.parseIso("x"), null);
  assert.strictEqual(KDT.isoOf(KDT.parseIso("2024-2-9")), "2024-02-09");
  const g = KDT.monthGrid(2024, 1);   // February 2024 starts on a Thursday
  assert.strictEqual(g.length, 42); assert.strictEqual(KDT.isoOf(g[0].date), "2024-01-29"); assert.strictEqual(g[0].inMonth, false); assert.strictEqual(KDT.isoOf(g[3].date), "2024-02-01");
  assert.strictEqual(KDT.isoOf(KDT.addMonths(KDT.parseIso("2024-01-31"), 1)), "2024-02-29");
  assert.strictEqual(KDT.isoOf(KDT.addMonths(KDT.parseIso("2024-01-15"), -1)), "2023-12-15");
});
test("root sheet page number travels as a document-settings change", () => {
  const c = DL.rootPageChange("7");
  assert.ok(DL.isDocPropsChange(c)); assert.deepStrictEqual(c.docProps, { pageNumber: "7" });
  const d = K.parseDoc('(kicad_sch (version 20250114) (uuid "r") (paper "A4") (lib_symbols) (sheet_instances (path "/" (page "1"))))', "kicad_sch");
  assert.strictEqual(d.pageNumber, "1"); assert.ok(K.applyDocProps(d, c.docProps)); assert.strictEqual(d.pageNumber, "7"); assert.strictEqual(d.paper, "A4");
});

// ---- symbol chooser (LIB_TREE / PANEL_SYMBOL_CHOOSER)
const LC = load(["library", "core.ts"]);
test("pushRecentSearch: newest first, no duplicates, empty ignored, at most 10", () => {
  let l = [];
  for (const q of ["a", "b", "a", "", "  "]) l = LC.pushRecentSearch(l, q);
  assert.deepStrictEqual(l, ["a", "b"]);
  for (let i = 0; i < 15; i++) l = LC.pushRecentSearch(l, "q" + i);
  assert.strictEqual(l.length, 10); assert.strictEqual(l[0], "q14");
});
test("bodyStyleNames: De Morgan is Standard / Alternate, custom names are the symbol's own", () => {
  assert.deepStrictEqual(LC.bodyStyleNames('(symbol "X:G" (symbol "G_1_1") (symbol "G_1_2"))'), ["Standard", "Alternate"]);
  assert.deepStrictEqual(LC.bodyStyleNames('(symbol "X:G" (body_styles "A" "B" "C") (symbol "G_1_1") (symbol "G_1_2") (symbol "G_1_3"))'), ["A", "B", "C"]);
  assert.deepStrictEqual(LC.bodyStyleNames('(symbol "X:G" (body_styles "Big" "Small") (symbol "G_1_1") (symbol "G_1_2"))'), ["Big", "Small"]);
  assert.deepStrictEqual(LC.bodyStyleNames('(symbol "X:G" (symbol "G_1_1"))'), ["Standard"]);
});
test("symbolInstance: the chosen body style goes into (body_style N)", () => {
  const lib = K.parse('(symbol "X:G" (property "Reference" "U" (at 0 0 0)) (symbol "G_1_1" (pin input line (at 0 0 0) (length 2) (name "A") (number "1"))) (symbol "G_1_2" (pin input line (at 0 0 0) (length 2) (name "A") (number "1"))))');
  const n = LC.symbolInstance({ libId: "X:G", symbol: lib, at: [0, 0], unit: 1, bodyStyle: 2, uuid: "u" });
  assert.ok(/\(body_style 2\)/.test(K.serialize(n)));
  assert.ok(/\(body_style 1\)/.test(K.serialize(LC.symbolInstance({ libId: "X:G", symbol: lib, at: [0, 0], uuid: "u" }))));
});

// ---- Symbol Fields Table filter scope (BOM_FILTER_SCOPE)
const DLG = load(["dialogs", "logic.ts"]);
test("bomRows: the filter matches the Reference, the shown columns, or every column", () => {
  const row = (ref, value, fp) => ({ id: ref, ids: [ref], ref, values: { Reference: ref, Value: value, Footprint: fp }, dnp: false, excludeBom: false, excludeBoard: false, excludeSim: false, excludePos: false, sheet: "", editable: true });
  const rows = [row("U1", "LM358", "DIP-8"), row("R1", "10k", "R_0603"), row("R2", "10k", "R_0805")];
  const preset = Object.assign(JSON.parse(JSON.stringify(DLG.BOM_PRESETS[0])), { group_symbols: false });
  preset.fields_ordered = [{ name: "Reference", label: "Reference", show: true, group_by: false }, { name: "Value", label: "Value", show: true, group_by: true }, { name: "Footprint", label: "Footprint", show: false, group_by: false }];
  const refs = (p) => DLG.bomRows(rows, p).map((r) => r.rows[0].ref).sort();
  assert.deepStrictEqual(refs(Object.assign({}, preset, { filter_string: "10k" })), []);
  assert.deepStrictEqual(refs(Object.assign({}, preset, { filter_string: "10k", filter_scope: "visible" })), ["R1", "R2"]);
  assert.deepStrictEqual(refs(Object.assign({}, preset, { filter_string: "0805", filter_scope: "visible" })), []);
  assert.deepStrictEqual(refs(Object.assign({}, preset, { filter_string: "0805", filter_scope: "all" })), ["R2"]);
  assert.deepStrictEqual(refs(Object.assign({}, preset, { filter_string: "u1" })), ["U1"]);
});

// ---- Pin Table grouping (PIN_TABLE_DATA_MODEL::RebuildRows / GetValue / SetValue)
const SM = load(["symedit", "model.ts"]);
test("groupPinRows: by name, by selection; grouped values and renumbering", () => {
  const pin = (number, name, type) => ({ count: 1, number, name, type, shape: "line", orient: 0, numSize: 1.27, nameSize: 1.27, length: 2.54, x: 0, y: 0, visible: true, unit: 1, body: 1, node: null });
  const pins = [pin("1", "GND", "power_in"), pin("10", "A", "input"), pin("2", "GND", "power_in"), pin("3", "B", "output")];
  const byName = SM.groupPinRows(pins, "name");
  assert.strictEqual(byName.length, 3);
  assert.strictEqual(byName[0].count, 2); assert.strictEqual(byName[0].number, "1, 2"); assert.strictEqual(byName[0].type, "power_in");
  const sel = SM.groupPinRows(pins, "selection", new Set([pins[1], pins[3]]));
  assert.strictEqual(sel.length, 3); assert.strictEqual(sel[0].number, "3, 10"); assert.strictEqual(sel[0].type, SM.PIN_MIXED); assert.strictEqual(sel[0].name, SM.PIN_MIXED);
  const all = pins.slice(), g = byName[0];
  SM.setPinGroupValue(g, "number", "5, 6, 7", (like, n) => { const p = Object.assign({}, like, { number: n }); all.push(p); return p; }, (p) => all.splice(all.indexOf(p), 1));
  assert.deepStrictEqual(g.pins.map((p) => p.number), ["5", "6", "7"]); assert.strictEqual(all.length, 5);
  SM.setPinGroupValue(g, "number", "5", () => null, (p) => all.splice(all.indexOf(p), 1));
  assert.strictEqual(all.length, 3);
  SM.setPinGroupValue(sel[0], "type", "bidirectional", null, null); assert.ok(sel[0].pins.every((p) => p.type === "bidirectional"));
  SM.setPinGroupValue(sel[0], "name", SM.PIN_MIXED, null, null); assert.strictEqual(pins[1].name, "A");
});
test("Import Sheet: the sheet file relative to the current sheet, the group name made unique", () => {
  const I = load(["dialogs", "logic.ts"]);
  {
    assert.strictEqual(I.relativeSheetPath("top.kicad_sch", "pic_sockets.kicad_sch"), "pic_sockets.kicad_sch");
    assert.strictEqual(I.relativeSheetPath("sub/a.kicad_sch", "b.kicad_sch"), "../b.kicad_sch");
    assert.strictEqual(I.relativeSheetPath("sub/a.kicad_sch", "sub/c/b.kicad_sch"), "c/b.kicad_sch");
    assert.strictEqual(I.sheetBaseName("sub/pic_sockets.kicad_sch"), "pic_sockets");
  }
  const C = load(["tools", "sch-tools", "clipboard.ts"]);
  const doc = { items: new Map([["1", { kind: "group", node: ["group", "pic"] }], ["2", { kind: "group", node: ["group", "pic1"] }]]) };
  assert.strictEqual(C.uniqueGroupName(doc, "x"), "x");
  assert.strictEqual(C.uniqueGroupName(doc, "pic"), "pic2");
});
test("compareSymbols: LIB_SYMBOL::Compare's report with the parity settings", () => {
  const D = load(["dialogs", "diff-symbol-logic.ts"]);
  const LIB = `(symbol "Device:R" (pin_numbers (hide yes)) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "ki_keywords" "R res resistor" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "ki_fp_filters" "R_*" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`;
  const lib = K.parse(LIB), parity = {};
  const inst = (val, extra = "") => K.parse(`(symbol (lib_id "Device:R") (at 100 50 0) (unit 1)
    (property "Reference" "R1" (at 102.032 50 90) (effects (font (size 1.27 1.27))))
    (property "Value" "${val}" (at 100 50 90) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at 98.222 50 90) (effects (font (size 1.27 1.27)) (hide yes))) ${extra})`);
  assert.deepStrictEqual(D.compareSymbols(lib, lib, parity, inst("R")), []);
  assert.deepStrictEqual(D.compareSymbols(lib, lib, parity, inst("10k")), ["Field 'Value' differs: 10k; R."]);
  // extra fields are only reported when the setting asks for them
  const ex = inst("R", '(property "MPN" "x" (at 0 0 0) (effects (font (size 1.27 1.27))))');
  assert.deepStrictEqual(D.compareSymbols(lib, lib, parity, ex), []);
  assert.deepStrictEqual(D.compareSymbols(lib, lib, { extra_fields: true }, ex), ["Extra field in schematic symbol: MPN."]);
  // field positions: library Y up, placed fields relative to the symbol
  assert.deepStrictEqual(D.compareSymbols(lib, lib, { field_positions: true }, inst("R")), []);
  const sch = K.parse(LIB.replace('(at 0 -3.81 90) (length 1.27)', '(at 0 -3.81 90) (length 2.54)').replace("(end 1.016 2.54)", "(end 1.016 3.54)"));
  const out = D.compareSymbols(sch, lib, parity, inst("R"));
  assert.deepStrictEqual(out, ["Graphic item differs: Rectangle, width 2.032 mm height 6.080 mm; Rectangle, width 2.032 mm height 5.080 mm.",
    "Pin 2 differs: Pin 2 [Passive, Line]; Pin 2 [Passive, Line]"]);
  const noPin = K.parse(LIB.replace(/\(pin passive line \(at 0 -3\.81[^\n]*\n?/, "").replace(/\)\)\)\)\)\)$/, ")))))"));
  assert.ok(D.compareSymbols(noPin, lib, parity, inst("R")).includes("Missing pin in schematic symbol: Pin 2 [Passive, Line]."));
  const flags = K.parse(LIB.replace("(on_board yes)", "(on_board no)").replace('"R res resistor"', '"R"'));
  assert.deepStrictEqual(D.compareSymbols(flags, lib, parity, inst("R")), ["Symbol keywords differ.", "Exclude from board settings differ."]);
  assert.deepStrictEqual(D.compareSymbols(flags, lib, { exclude_from_board_flags: false }, inst("R")), ["Symbol keywords differ."]);
  // the diff's schematic side: unrotated at the origin, fields moved with it
  const o = D.instanceAtOrigin(K.parse(`(symbol (lib_id "Device:R") (at 100 50 90) (mirror x) (property "Value" "R" (at 103 50 0)))`));
  assert.strictEqual(K.serialize(o).replace(/\s+/g, " "), '(symbol (lib_id "Device:R") (at 0 0 0) (property "Value" "R" (at 3 0 0)))');
});
process.on("exit", () => { console.log(`schdlg: ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1; });
