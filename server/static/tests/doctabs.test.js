// Node test for the document tabs' pure parts (web/platform/doctabs/api.ts, elements.ts) and the domain registry's
// document kinds (web/domains/registry.ts): which elements get a tab and in what order, new names, renames.
// The project shell's own model (several PCBs, folders, tab order) is in project-shell.test.js.
// Run: node server/static/tests/doctabs.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");
const A = load("platform/doctabs/api.ts");
const R = load("domains/registry.ts");

const docs = [
  { docId: "pro", path: "amp.kicad_pro", docType: "kicad_pro" },
  { docId: "asm", path: "Product.jasm", docType: "assembly" },
  { docId: "p10", path: "Part Studio 10.jpart", docType: "part_studio" },
  { docId: "p2", path: "Part Studio 2.jpart", docType: "part_studio" },
  { docId: "sub", path: "power.kicad_sch", docType: "kicad_sch" },
  { docId: "root", path: "amp.kicad_sch", docType: "kicad_sch" },
  { docId: "pcb", path: "amp.kicad_pcb", docType: "kicad_pcb" },
  { docId: "fp", path: "lib.pretty/R.kicad_mod", docType: "footprint" },
  { docId: "step", path: "case.step", docType: "model3d" },
];

test("tabs: one per element (a PCB with its schematic and board inside it, then part studios and assemblies by name); libraries and models have none", () => {
  const E = load("platform/doctabs/elements.ts");
  const tabs = E.elementsOf(docs, "Amplifier");
  assert.deepEqual(tabs.map((t) => `${t.title}:${t.name}=${t.key}`), ["PCB:amp=pro", "Part Studio:Part Studio 2=p2", "Part Studio:Part Studio 10=p10", "Assembly:Product=asm"]);
  // the PCB's views: its root sheet (the sheets under it), its board
  assert.equal(tabs[0].pcb.schematic.docId, "root");
  assert.deepEqual(tabs[0].pcb.sheets.map((d) => d.docId), ["root", "sub"]);
  assert.deepEqual(tabs[0].pcb.boards.map((d) => d.docId), ["pcb"]);
  // two boards in one KiCad project: the one named like the project first, both views of the one PCB tab
  const two = E.elementsOf([...docs, { docId: "pcb2", path: "panel.kicad_pcb", docType: "kicad_pcb" }], "Amplifier");
  assert.deepEqual(two.filter((t) => t.pcb).map((t) => t.pcb.boards.map((d) => d.path)), [["amp.kicad_pcb", "panel.kicad_pcb"]]);
});

test("the registry says which kinds can be created, which bundle opens them and what a new one holds", () => {
  const part = R.documentKind("part_studio"), asm = R.documentKind("assembly");
  assert.equal(part.ext, ".jpart"); assert.equal(part.bundle, "/static/dist/mechanical.js");
  assert.equal(asm.ext, ".jasm"); assert.equal(asm.bundle, "/static/dist/assembly.js");
  assert.equal(R.documentKind("kicad_pcb").bundle, undefined, "the shell draws KiCad's documents itself");
  assert.equal(R.documentKind("footprint"), undefined);
  assert.deepEqual(R.DOCUMENT_KINDS.filter((k) => k.newName).map((k) => k.docType), ["part_studio", "assembly"]);
  for (const k of [part, asm]) { const doc = JSON.parse(k.newText); assert.equal(typeof doc.junction, "string"); assert.ok(Array.isArray(doc.items)); }
  assert.equal(R.domainForFile("Enclosure.jpart").id, "mechanical");
  assert.equal(R.domainForFile("Product.jasm").id, "assembly");
  assert.deepEqual(R.DOMAINS.filter((d) => d.status !== "planned").map((d) => d.id), ["pcb", "mechanical", "assembly"]);
});

test("a new document takes the first free name, whatever the letter case of the ones there", () => {
  const part = R.documentKind("part_studio");
  assert.equal(A.freeName(part, []), "Part Studio 1.jpart");
  assert.equal(A.freeName(part, [{ path: "part studio 1.JPART" }, { path: "cad/Part Studio 2.jpart" }]), "Part Studio 3.jpart");
});

test("renaming keeps the folder and the extension and refuses names a file cannot have", () => {
  const doc = { docId: "p2", path: "cad/Part Studio 2.jpart" };
  assert.deepEqual(A.renamedPath(doc, "  Enclosure   lid ", docs), { path: "cad/Enclosure lid.jpart" });
  assert.deepEqual(A.renamedPath(doc, "Part Studio 2", docs), { path: "cad/Part Studio 2.jpart" });
  assert.match(A.renamedPath(doc, "", docs).error, /needs a name/);
  assert.match(A.renamedPath(doc, "a/b", docs).error, /cannot contain/);
  assert.match(A.renamedPath(doc, ".hidden", docs).error, /dot/);
  assert.match(A.renamedPath({ path: "Part Studio 2.jpart" }, "part studio 10", docs).error, /already has/);
  assert.equal(A.stemOf("cad/Enclosure lid.jpart"), "Enclosure lid");
});
