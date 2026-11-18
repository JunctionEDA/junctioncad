// multi-top-level.test.js — a KiCad 10 schematic with several top-level sheets (schematic.top_level_sheets in the
// project file; an Altium project imports one per SchDoc).  The browser's netlist must name nets, sheet paths and
// components the way eeschema does: each top-level sheet's path carries its name ("/Main/", "/Main/child/"), so the
// same local label on two top-level sheets stays two nets while global labels join them.  The expected netlist is
// kicad-cli's (`kicad-cli sch export netlist`) for qa/data/eeschema/multi_top_level.
// Run: node server/static/tests/multi-top-level.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js")); require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, N = K.pcbNetlist, sch = globalThis.CollabTools.sch;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("several top-level schematic sheets under node");

const DIR = path.join(__dirname, "..", "..", "..", "qa", "data", "eeschema", "multi_top_level");
const pro = JSON.parse(fs.readFileSync(path.join(DIR, "multi.kicad_pro"), "utf8"));
const read = (f) => { const doc = K.parseDoc(fs.readFileSync(path.join(DIR, f), "utf8"), "kicad_sch"); return { doc, uuid: String(doc.uuid || ""), file: f }; };
const files = { "multi.kicad_sch": read("multi.kicad_sch"), "second.kicad_sch": read("second.kicad_sch"), "child.kicad_sch": read("child.kicad_sch") };
const helpers = { symbolPins: sch._.symbolPins, isPower: (d, it) => sch._.isPowerSymbol(d, String((K.kid(it.node, "lib_id") || [])[1])) };

// editor/bootpick.ts topLevelSheetsOf, as the editor resolves the project file (the module is bundled in the editor,
// so the same rules are spelled out here against the file)
const tops = pro.schematic.top_level_sheets.map((t) => ({ sheet: files[t.filename], name: t.name, uuid: t.uuid }));
const nl = N.buildNetlist(tops, (f) => files[f] || null, helpers, "multi");

// kicad-cli's netlist: every net with its (ref, pin) nodes, every component with its sheet path
const ref = K.parse(fs.readFileSync(path.join(DIR, "multi.kicad-cli.net"), "utf8"));
const kid = (n, k) => n.find((c) => Array.isArray(c) && c[0] === k), kids = (n, k) => n.filter((c) => Array.isArray(c) && c[0] === k);
const str = (n) => (n ? String(n[1]) : "");
const refNets = new Map();
for (const net of kids(kid(ref, "nets"), "net")) refNets.set(str(kid(net, "name")), kids(net, "node").map((nd) => str(kid(nd, "ref")) + "." + str(kid(nd, "pin"))).sort());
const refComps = new Map(kids(kid(ref, "components"), "comp").map((c) => [str(kid(c, "ref")), str(kid(kid(c, "sheetpath"), "names"))]));

test("the sheet instances: each top-level sheet in its own path, its sub-sheet below it", () => {
  assert.deepStrictEqual(nl.instances.map((i) => i.human), ["/Main/", "/Second/", "/Main/child/"]);
  assert.deepStrictEqual(nl.instances.map((i) => i.uuidPath.length), [1, 1, 2]);
});
test("net names and members match kicad-cli: the local SIG twice, the global SHARED once", () => {
  const got = new Map(); for (const [name, nodes] of nl.nets) got.set(name, nodes.map((n) => n.ref + "." + n.pin).sort());
  assert.deepStrictEqual(Array.from(got.keys()).sort(), Array.from(refNets.keys()).sort());
  for (const [name, nodes] of refNets) assert.deepStrictEqual(got.get(name), nodes, name);
});
test("components carry kicad-cli's sheet paths and their own sheet's references", () => {
  const got = new Map(nl.components.map((c) => [c.ref, c.sheetName]));
  assert.deepStrictEqual(Array.from(got.entries()).sort(), Array.from(refComps.entries()).sort());
});
test("one root sheet still names its nets from \"/\" (no top-level name in the path)", () => {
  const one = N.buildNetlist(files["multi.kicad_sch"], (f) => files[f] || null, helpers, "multi");
  assert.deepStrictEqual(one.instances.map((i) => i.human), ["/", "/child/"]);
  assert.ok(one.nets.has("/SIG") && one.nets.has("/child/IN"), Array.from(one.nets.keys()).join(", "));
});

// SCH_SHEET_LIST::RepairPageNumbers after SortByPageNumbers (sim/sheet-pages.ts, bundled here on the fly): the Altium
// eDP adapter stores page "#" on both top-level sheets; eeschema 2.2.0 shows it6251_core as page 1 and power as "#"
// (the tie goes to the path hash, and power's is lower)
const SP = (() => {
  const out = require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", "domains", "pcb", "sim", "sheet-pages.ts")], bundle: true, format: "cjs", platform: "node", write: false, logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
})();
test("page numbers repaired as eeschema shows them: a duplicate \"#\" renumbered by sort order", () => {
  const r = SP.repairPageNumbers([{ uuids: ["8c64ea52-1828-45f5-b8fd-d99a1e5ce683"], page: "#", virt: 1 }, { uuids: ["4e140f21-2b6b-4ad5-bc34-36c658be1c1b"], page: "#", virt: 1 }]);
  assert.deepStrictEqual(r.pages, ["1", "#"]);
  assert.deepStrictEqual(SP.repairPageNumbers([{ uuids: ["a"], page: "", virt: 1 }, { uuids: ["a", "b"], page: "", virt: 2 }]).pages, ["1", "2"], "all empty: numbered in order");
  assert.deepStrictEqual(SP.repairPageNumbers([{ uuids: ["a"], page: "1", virt: 1 }, { uuids: ["a", "b"], page: "1", virt: 2 }, { uuids: ["a", "c"], page: "2", virt: 3 }]).pages, ["1", "3", "2"], "a duplicate takes the lowest unused number");
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
