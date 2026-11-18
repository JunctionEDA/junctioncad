// Node test for the project shell's pure parts: which PCBs a project holds and what each one's editor may see
// (web/platform/doctabs/pcbs.ts), the elements and their tab order, the Home tab's tree (elements.ts), what
// dropped files become (actions.ts planImport), and the paths the editor sends (web/domains/pcb/editor/pcbscope.ts).
//
// The point of most of it: in a project with several PCBs, nothing of one PCB may be mistaken for another's.
// Run: node server/static/tests/project-shell.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");
const P = load("platform/doctabs/pcbs.ts");
const E = load("platform/doctabs/elements.ts");
const A = load("platform/doctabs/api.ts");
const I = load("shared/itemdoc/itemdoc.ts");
const B = load("domains/pcb/editor/bootpick.ts");
const fs = require("node:fs");
const path = require("node:path");

let n = 0;
const types = { kicad_pro: "kicad_pro", kicad_sch: "kicad_sch", kicad_pcb: "kicad_pcb", kicad_sym: "symbol_lib", kicad_mod: "footprint", jpart: "part_studio", jasm: "assembly", step: "model3d", jproj: "project_shell", kicad_dru: "design_rules" };
const doc = (p) => ({ docId: "d" + (++n) + ":" + p, path: p, docType: /lib-table$/.test(p) ? "lib_table" : types[p.split(".").pop()] || "other" });
const paths = (docs) => docs.map((d) => d.path);
const byPath = (docs, p) => docs.find((d) => d.path === p);

// A project made in Junction: two PCBs, each a KiCad project in its folder, parts beside them.
const multi = () => [
  doc("project.jproj"),
  doc("Motor driver/Motor driver.kicad_pro"), doc("Motor driver/Motor driver.kicad_sch"), doc("Motor driver/Motor driver.kicad_pcb"),
  doc("Motor driver/power.kicad_sch"), doc("Motor driver/fp-lib-table"), doc("Motor driver/lib.pretty/R.kicad_mod"), doc("Motor driver/Motor driver.kicad_dru"),
  doc("Sensor/Sensor.kicad_pro"), doc("Sensor/Sensor.kicad_sch"), doc("Sensor/Sensor.kicad_pcb"), doc("Sensor/fp-lib-table"), doc("Sensor/sym-lib-table"),
  doc("Lid.jpart"), doc("Enclosure/Base.jpart"), doc("Product.jasm"), doc("models/case.step"),
];
// A project from before: KiCad's files at the root.
const legacy = () => [doc("amp.kicad_pro"), doc("amp.kicad_sch"), doc("power.kicad_sch"), doc("amp.kicad_pcb"), doc("fp-lib-table"), doc("lib.pretty/R.kicad_mod"), doc("Lid.jpart"), doc("models/case.step")];

test("a PCB is a KiCad project in a folder: each has its own project file, root sheet, board and files", () => {
  const docs = multi(), pcbs = P.pcbsOf(docs, "Rover");
  assert.deepEqual(pcbs.map((p) => [p.dir, p.name]), [["Motor driver", "Motor driver"], ["Sensor", "Sensor"]]);
  const [motor, sensor] = pcbs;
  assert.equal(motor.schematic.path, "Motor driver/Motor driver.kicad_sch");
  assert.deepEqual(paths(motor.boards), ["Motor driver/Motor driver.kicad_pcb"]);
  assert.deepEqual(paths(motor.sheets), ["Motor driver/Motor driver.kicad_sch", "Motor driver/power.kicad_sch"]);
  assert.equal(motor.key, motor.pro.docId, "the key is the project file's id: it survives a rename");
  assert.equal(sensor.schematic.path, "Sensor/Sensor.kicad_sch");
  // every KiCad file belongs to exactly one PCB; the parts and the model to none
  for (const d of docs) {
    const owners = pcbs.filter((p) => p.docs.includes(d));
    assert.equal(owners.length, /^(Motor driver|Sensor)\//.test(d.path) ? 1 : 0, d.path);
  }
  assert.equal(P.pcbOfDoc(pcbs, byPath(docs, "Sensor/Sensor.kicad_pcb").docId), sensor);
  assert.equal(P.pcbOfDoc(pcbs, byPath(docs, "Lid.jpart").docId), undefined);
});

test("THE RULE: the editor of one PCB sees no schematic, board, project file, rules or library table of another", () => {
  const docs = multi(), pcbs = P.pcbsOf(docs, "Rover");
  for (const pcb of pcbs) {
    const other = pcbs.find((p) => p !== pcb);
    const seen = P.scopedDocs(docs, pcbs, pcb);
    for (const d of seen) assert.ok(!other.docs.some((o) => o.docId === d.docId), `${pcb.name} sees ${d.path} of ${other.name}`);
    // what the editor looks for by type or by name finds this PCB's, and only one of each
    assert.equal(seen.filter((d) => d.docType === "kicad_pro").length, 1);
    assert.equal(seen.find((d) => d.docType === "kicad_pro").docId, pcb.pro.docId);
    assert.equal(seen.find((d) => d.docType === "kicad_pcb").docId, pcb.boards[0].docId);
    assert.equal(seen.filter((d) => d.path === "fp-lib-table").length, 1);
    assert.equal(seen.find((d) => d.path === "fp-lib-table").docId, byPath(docs, pcb.dir + "/fp-lib-table").docId);
    // and the editor's own choice of root sheet and first document (bootpick.ts) is this PCB's root sheet
    const shown = B.editorDocs(seen);
    assert.equal(B.rootSchematicOf(shown, seen).docId, pcb.schematic.docId);
    assert.equal(B.firstDoc(shown, seen, null).docId, pcb.schematic.docId);
    assert.deepEqual(shown.filter((d) => d.docType === "kicad_pcb").map((d) => d.docId), pcb.boards.map((d) => d.docId));
  }
  const motor = P.scopedDocs(docs, pcbs, pcbs[0]);
  assert.deepEqual(paths(motor).sort(), ["../Enclosure/Base.jpart", "../Lid.jpart", "../Product.jasm", "../models/case.step", "Motor driver.kicad_dru", "Motor driver.kicad_pcb", "Motor driver.kicad_pro", "Motor driver.kicad_sch", "fp-lib-table", "lib.pretty/R.kicad_mod", "power.kicad_sch"].sort(),
    "its own files as if its folder were the project; what belongs to no PCB at ../; the project's own document not at all");
  assert.equal(P.scopedDocs(docs, pcbs, pcbs[1]).some((d) => d.docType === "design_rules"), false, "the other PCB's custom rules are not Sensor's");
  // the ids are the project's own: nothing addressed by id needs translating
  assert.equal(motor.find((d) => d.path === "power.kicad_sch").docId, byPath(docs, "Motor driver/power.kicad_sch").docId);
  // with no PCB open, the editor sees no KiCad design at all
  assert.deepEqual(P.scopedDocs(docs, pcbs, null).filter((d) => /^kicad_/.test(d.docType)), []);
});

test("a project from before (KiCad's files at the root) is one PCB and reads exactly as it did", () => {
  const docs = legacy(), pcbs = P.pcbsOf(docs, "Amplifier");
  assert.equal(pcbs.length, 1);
  assert.deepEqual([pcbs[0].dir, pcbs[0].name, pcbs[0].schematic.path, pcbs[0].boards[0].path], ["", "amp", "amp.kicad_sch", "amp.kicad_pcb"]);
  const seen = P.scopedDocs(docs, pcbs, pcbs[0]);
  assert.deepEqual(seen, docs, "the same documents, the same paths, the same order");
  for (let i = 0; i < docs.length; i++) assert.equal(seen[i], docs[i], "the very same entries");
  // no project file at all (an old upload): still one PCB, named after the project
  const bare = [doc("main.kicad_sch"), doc("main.kicad_pcb"), doc("sub/x.kicad_sch")];
  const one = P.pcbsOf(bare, "Old thing");
  assert.deepEqual(one.map((p) => [p.dir, p.name, p.schematic.path]), [["", "Old thing", "main.kicad_sch"]]);
  assert.deepEqual(P.scopedDocs(bare, one, one[0]), bare);
  // the root sheet is the one the editor itself picks, for every shape of project
  for (const set of [docs, bare, [doc("b.kicad_pro"), doc("a.kicad_sch"), doc("b.kicad_sch"), doc("x/c.kicad_sch")]]) {
    const p = P.pcbsOf(set, "x")[0];
    assert.equal(p.schematic.docId, B.rootSchematicOf(B.editorDocs(set), set).docId);
  }
});

test("a PCB added to a project that has one at its root: two PCBs, neither sees the other's design", () => {
  const docs = [...legacy(), doc("Panel/Panel.kicad_pro"), doc("Panel/Panel.kicad_sch"), doc("Panel/Panel.kicad_pcb")];
  const pcbs = P.pcbsOf(docs, "Amplifier");
  assert.deepEqual(pcbs.map((p) => p.dir), ["", "Panel"]);
  const root = P.scopedDocs(docs, pcbs, pcbs[0]), panel = P.scopedDocs(docs, pcbs, pcbs[1]);
  assert.deepEqual(paths(root), paths(legacy()), "the root PCB keeps everything it had, at the same paths");
  assert.deepEqual(paths(panel).sort(), ["Panel.kicad_pcb", "Panel.kicad_pro", "Panel.kicad_sch"]);
  assert.equal(root.filter((d) => d.docType === "kicad_pcb").length, 1);
  assert.equal(panel.filter((d) => d.docType === "kicad_pcb")[0].docId, byPath(docs, "Panel/Panel.kicad_pcb").docId);
});

test("sheets beside a single project folder ride with it; with several PCBs, loose sheets are a PCB of their own", () => {
  const repo = [doc("hw/hw.kicad_pro"), doc("hw/hw.kicad_sch"), doc("hw/hw.kicad_pcb"), doc("common/power.kicad_sch"), doc("lib/x.kicad_sym")];
  const one = P.pcbsOf(repo, "Repo");
  assert.equal(one.length, 1);
  assert.deepEqual(paths(P.scopedDocs(repo, one, one[0])).sort(), ["../common/power.kicad_sch", "../lib/x.kicad_sym", "hw.kicad_pcb", "hw.kicad_pro", "hw.kicad_sch"]);
  const two = [...repo, doc("b/b.kicad_pro"), doc("b/b.kicad_sch")];
  assert.deepEqual(P.pcbsOf(two, "Repo").map((p) => [p.dir, p.sheets.length]), [["", 1], ["b", 1], ["hw", 1]]);
});

test("paths: what the editor of a PCB calls a file, and where that is in the project", () => {
  assert.equal(P.relativePath("A", "A/sub/x.kicad_sch"), "sub/x.kicad_sch");
  assert.equal(P.relativePath("A", "models/case.step"), "../models/case.step");
  assert.equal(P.relativePath("boards/A", "boards/lib/x.kicad_sym"), "../lib/x.kicad_sym");
  assert.equal(P.relativePath("boards/A", "Lid.jpart"), "../../Lid.jpart");
  assert.equal(P.relativePath("", "a/b.kicad_sch"), "a/b.kicad_sch");
  assert.equal(P.relativePath("A", "AB/x.kicad_sch"), "../AB/x.kicad_sch", "a folder whose name merely starts the same is another folder");
  assert.equal(P.fullPath("A", "fp-lib-table"), "A/fp-lib-table");
  assert.equal(P.fullPath("A", "./lib.pretty//R.kicad_mod"), "A/lib.pretty/R.kicad_mod");
  assert.equal(P.fullPath("A", "../models/case.step"), "models/case.step");
  assert.equal(P.fullPath("A", "../../etc"), null, "never outside the project");
  assert.equal(P.fullPath("", "x.kicad_sch"), "x.kicad_sch");
  for (const [dir, p] of [["A", "A/x/y.z"], ["A/B", "C/d.e"], ["A", "q.r"], ["", "s/t.u"]]) assert.equal(P.fullPath(dir, P.relativePath(dir, p)), p, "there and back");
});

test("the editor's two requests that carry a path are put under the PCB's folder and answered as it sees them", () => {
  const S = load("domains/pcb/editor/pcbscope.ts");
  assert.equal(S.outgoingPath("Motor driver", "sub/new.kicad_sch"), "Motor driver/sub/new.kicad_sch");
  assert.equal(S.outgoingPath("Motor driver", "fp-lib-table"), "Motor driver/fp-lib-table");
  assert.equal(S.outgoingPath("Motor driver", "../models/a.step"), "models/a.step");
  assert.equal(S.outgoingPath("Motor driver", "../../x"), null);
  assert.equal(S.outgoingPath("", "fp-lib-table"), "fp-lib-table", "a PCB at the root: untouched");
  assert.equal(S.incomingPath("Motor driver", "Motor driver/sub/new.kicad_sch"), "sub/new.kicad_sch");
  // binding: one PCB per page; another PCB of the same project means the page loads again
  const docs = multi(), pcbs = P.pcbsOf(docs, "Rover");
  assert.equal(S.bindPcb("proj", pcbs[0]), "bound");
  assert.equal(S.bindPcb("proj", pcbs[0]), "same");
  assert.equal(S.bindPcb("proj", pcbs[1]), "reload");
  assert.equal(S.boundPcb().key, pcbs[0].key, "a refused binding changes nothing");
  const v = S.viewOf(docs, "proj", "Rover");
  assert.equal(v.pcb.key, pcbs[0].key);
  assert.ok(v.docs.every((d) => !pcbs[1].docs.some((o) => o.docId === d.docId)));
  S.unbindPcb();
  assert.deepEqual(S.viewOf(docs, "proj", "Rover").docs.filter((d) => /^kicad_/.test(d.docType)), []);
  // another project binds freely; a project of one PCB at its root gets its own list back
  const old = legacy(), oldPcbs = P.pcbsOf(old, "Amp");
  assert.equal(S.bindPcb("other", oldPcbs[0]), "bound");
  assert.equal(S.viewOf(old, "other", "Amp").docs, old);
  // the folder moved under the editor (the PCB was renamed): the next document of it loads the page again
  S.unbindPcb(); assert.equal(S.bindPcb("p3", pcbs[0]), "bound");
  const renamed = docs.map((d) => (d.path.startsWith("Motor driver/") ? { ...d, path: "Drive/" + d.path.slice(13).replace(/^Motor driver\./, "Drive.") } : d));
  const after = S.viewOf(renamed, "p3", "Rover");
  assert.equal(after.pcb.dir, "Drive"); assert.equal(S.boundPcb().dir, "Drive");
  assert.equal(S.bindPcb("p3", after.pcb), "reload");
});

test("elements: one tab per PCB, part studio and assembly; a PCB at the root is not the shell's to rename or delete", () => {
  const els = E.elementsOf(multi(), "Rover");
  assert.deepEqual(els.map((e) => `${e.type}:${e.name}:${e.folder}`), ["pcb:Motor driver:", "pcb:Sensor:", "part_studio:Base:Enclosure", "part_studio:Lid:", "assembly:Product:"]);
  assert.ok(els.every((e) => e.managed));
  const old = E.elementsOf(legacy(), "Amplifier");
  assert.deepEqual(old.map((e) => [e.type, e.name, e.managed]), [["pcb", "amp", false], ["part_studio", "Lid", true]]);
  assert.deepEqual(E.elementsOf([doc("project.jproj")], "Empty"), [], "a blank project has no elements");
  // a tab id (a sheet, a board, the BOM) finds its PCB; which view it is
  const docs = multi(), list = E.elementsOf(docs, "Rover"), motor = list[0];
  assert.equal(E.elementOfTab(list, byPath(docs, "Motor driver/power.kicad_sch").docId), motor);
  assert.equal(E.elementOfTab(list, "bom:" + motor.key), motor);
  assert.equal(E.elementOfTab(list, byPath(docs, "Sensor/Sensor.kicad_pcb").docId), list[1]);
  assert.equal(E.elementOfTab(list, "home"), undefined);
  assert.equal(E.pcbViewOf(motor.pcb, byPath(docs, "Motor driver/power.kicad_sch").docId), "schematic");
  assert.equal(E.pcbViewOf(motor.pcb, byPath(docs, "Motor driver/Motor driver.kicad_pcb").docId), "board");
  assert.equal(E.pcbViewOf(motor.pcb, "bom:" + motor.key), "bom");
  assert.equal(E.pcbViewOf(motor.pcb, byPath(docs, "Sensor/Sensor.kicad_pcb").docId), null);
});

test("tab order is the project's: a move is a few changes to its document, and everybody sorts the same way", () => {
  const els = E.elementsOf(multi(), "Rover"), keys = (l) => l.map((e) => e.name);
  const shell = I.parseItemDoc(E.newShellText(), E.SHELL_KIND);
  const items = () => Array.from(shell.items.values());
  assert.deepEqual(keys(E.orderedElements(els, items())), ["Motor driver", "Sensor", "Base", "Lid", "Product"], "nobody placed anything: the default order");
  // drag "Product" to the front
  let ch = E.moveTabChanges(E.orderedElements(els, items()), items(), els[4].key, els[0].key);
  assert.ok(ch.length > 0); I.applyChanges(shell, ch);
  assert.deepEqual(keys(E.orderedElements(els, items())), ["Product", "Motor driver", "Sensor", "Base", "Lid"]);
  // drag "Motor driver" to the end
  ch = E.moveTabChanges(E.orderedElements(els, items()), items(), els[0].key, null); I.applyChanges(shell, ch);
  assert.deepEqual(keys(E.orderedElements(els, items())), ["Product", "Sensor", "Base", "Lid", "Motor driver"]);
  assert.equal(ch.length, 1, "once every tab has a key, a move changes one item");
  // drag "Lid" between "Product" and "Sensor"
  ch = E.moveTabChanges(E.orderedElements(els, items()), items(), els[3].key, els[1].key); I.applyChanges(shell, ch);
  assert.deepEqual(keys(E.orderedElements(els, items())), ["Product", "Lid", "Sensor", "Base", "Motor driver"]);
  // dropping a tab where it is changes nothing
  const now = E.orderedElements(els, items());
  assert.deepEqual(E.moveTabChanges(now, items(), now[1].key, now[2].key), []);
  assert.deepEqual(E.moveTabChanges(now, items(), now[4].key, null), []);
  assert.deepEqual(E.moveTabChanges(now, items(), now[1].key, now[1].key), []);
  // a new element nobody placed goes after the placed ones; a deleted one's placement is forgotten
  const more = E.elementsOf([...multi().slice(0, 4), doc("Zed.jpart")], "Rover");
  assert.equal(E.orderedElements([...els, more[more.length - 1]], items()).pop().name, "Zed");
  assert.equal(E.pruneTabChanges(els.slice(1), items()).length, 1);
  // the file the server makes and the one this module describes are the same text
  const rs = fs.readFileSync(path.join(__dirname, "..", "..", "src", "shell.rs"), "utf8");
  const m = /pub const SHELL_TEXT: &str = "((?:[^"\\]|\\.)*)";/.exec(rs);
  assert.equal(JSON.parse('"' + m[1] + '"'), E.newShellText());
});

test("the Home tab's tree: folders, elements and files; a PCB holds its own files; search opens what it finds", () => {
  const docs = multi(), els = E.elementsOf(docs, "Rover");
  const names = (rows) => rows.map((r) => `${"  ".repeat(r.depth)}${r.kind[0]}:${r.name}`);
  const closed = E.treeRows(docs, els, { open: new Set() });
  assert.deepEqual(names(closed), ["f:Enclosure", "f:models", "e:Lid", "e:Motor driver", "e:Product", "e:Sensor"], "folders, then elements, each by name");
  assert.ok(!closed.some((r) => r.name === "project.jproj"), "the project's own document is not a file to manage");
  const motor = els[0];
  const open = E.treeRows(docs, els, { open: new Set(["el:" + motor.key, "folder:Enclosure"]) });
  // inside a PCB: its root sheet, its board, then the rest by name
  assert.deepEqual(names(open), ["f:Enclosure", "  e:Base", "f:models", "e:Lid", "e:Motor driver",
    "  f:Motor driver.kicad_sch", "  f:Motor driver.kicad_pcb", "  f:fp-lib-table", "  f:lib.pretty/R.kicad_mod", "  f:Motor driver.kicad_dru", "  f:Motor driver.kicad_pro", "  f:power.kicad_sch",
    "e:Product", "e:Sensor"]);
  assert.equal(open.find((r) => r.name === "Motor driver").count, 7);
  assert.ok(open.filter((r) => r.depth === 1 && r.kind === "file").every((r) => r.owned));
  // search: the folder above a hit is shown, open; a hit inside a PCB opens the PCB
  assert.deepEqual(names(E.treeRows(docs, els, { open: new Set(), filter: "case" })), ["f:models", "  f:case.step"]);
  assert.deepEqual(names(E.treeRows(docs, els, { open: new Set(), filter: "power" })), ["e:Motor driver", "  f:power.kicad_sch"]);
  assert.deepEqual(names(E.treeRows(docs, els, { open: new Set(), filter: "sens" })), ["e:Sensor"]);
  assert.deepEqual(E.treeRows(docs, els, { open: new Set(), filter: "nothing like it" }), []);
  // sort by last change, newest first
  const modified = new Map([[byPath(docs, "Product.jasm").docId, 300], [byPath(docs, "Sensor/Sensor.kicad_pcb").docId, 200], [byPath(docs, "Lid.jpart").docId, 100]]);
  assert.deepEqual(E.treeRows(docs, els, { open: new Set(), sort: "modified", modified }).filter((r) => r.kind === "element").map((r) => r.name), ["Product", "Sensor", "Lid", "Motor driver"]);
  // folders: the ones on the way to something, and the empty ones; never a PCB's own folder or one inside it
  assert.deepEqual(E.foldersOf(docs, els, ["Spare/Deep"]), ["Enclosure", "models", "Spare", "Spare/Deep"]);
  assert.deepEqual(E.emptyFoldersOf([{ id: "folder:1", type: "folder", path: "Spare" }, { id: "tab:x", type: "tab", order: "V" }]), [{ id: "folder:1", path: "Spare" }]);
  assert.equal(E.freeFolderPath("", "Enclosure", docs, E.foldersOf(docs, els)), "Enclosure 2");
  assert.equal(E.freeFolderPath("", "motor driver", docs, []), "motor driver 2", "a PCB's folder is taken too");
  assert.equal(E.freeFolderPath("Enclosure", "Screws", docs, []), "Enclosure/Screws");
  assert.equal(E.nameProblem("Fine name"), null);
  assert.match(E.nameProblem("a/b"), /cannot contain/); assert.match(E.nameProblem(" "), /needs a name/); assert.match(E.nameProblem("x."), /dot/);
  // a project from before: its KiCad files are the project's own files, the PCB a row beside them
  const old = legacy(), oldEls = E.elementsOf(old, "Amplifier");
  const rows = E.treeRows(old, oldEls, { open: new Set(["folder:lib.pretty", "folder:models"]) });
  assert.ok(rows.some((r) => r.kind === "element" && r.name === "amp") && rows.some((r) => r.kind === "file" && r.name === "amp.kicad_sch" && r.owned));
  assert.ok(rows.some((r) => r.kind === "file" && r.name === "fp-lib-table" && !r.owned), "a library table can be managed on its own");
});

test("the tree stays quick with a few hundred files", () => {
  const docs = [doc("project.jproj")];
  for (let p = 0; p < 6; p++) { docs.push(doc(`PCB ${p}/PCB ${p}.kicad_pro`), doc(`PCB ${p}/PCB ${p}.kicad_sch`), doc(`PCB ${p}/PCB ${p}.kicad_pcb`)); for (let i = 0; i < 40; i++) docs.push(doc(`PCB ${p}/lib.pretty/F${i}.kicad_mod`)); }
  for (let i = 0; i < 60; i++) docs.push(doc(`parts/group ${i % 6}/Part ${i}.jpart`));
  for (let i = 0; i < 80; i++) docs.push(doc(`models/m${i}.step`));
  const t0 = process.hrtime.bigint();
  const els = E.elementsOf(docs, "Big");
  const all = new Set([...E.foldersOf(docs, els).map((f) => "folder:" + f), ...els.map((e) => "el:" + e.key)]);
  const rows = E.treeRows(docs, els, { open: all });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(els.length, 66);
  assert.ok(rows.length > 400, `${rows.length} rows`);
  assert.ok(ms < 400, `${docs.length} files took ${ms.toFixed(0)} ms`);
});

test("names: a new PCB, a copy", () => {
  assert.equal(A.freeElementName("PCB", []), "PCB 1");
  assert.equal(A.freeElementName("PCB", [{ path: "PCB 1/PCB 1.kicad_pro" }, { path: "pcb 2.jpart" }]), "PCB 3");
  assert.equal(A.copyName("Lid", ["Lid"]), "Lid copy");
  assert.equal(A.copyName("Lid", ["Lid", "lid copy"]), "Lid copy 2");
  assert.equal(A.copyName("Lid copy 2", ["Lid", "Lid copy", "Lid copy 2"]), "Lid copy 3");
});

test("dropped files: a STEP file is a part studio, a KiCad project is a PCB, loose KiCad files join the PCB they land on", () => {
  // actions.ts imports the home view's toasts (React); only its planning is under test
  const X = load("platform/doctabs/actions.ts");
  const f = (p) => ({ path: p, file: { name: p.split("/").pop(), size: 1 } });
  let plan = X.planImport([f("bracket.step")], "", false);
  assert.deepEqual([plan.models.length, plan.pcbs.length, plan.loose.length, plan.refused], [1, 0, 0, []]);
  // a KiCad project folder, dropped whole: one PCB, its files at the same places inside it, nothing made up
  plan = X.planImport([f("amp/amp.kicad_pro"), f("amp/amp.kicad_sch"), f("amp/amp.kicad_pcb"), f("amp/sub/power.kicad_sch"), f("amp/fp-lib-table"), f("amp/lib.pretty/R.kicad_mod"), f("amp/3d/part.step"), f("amp/amp.kicad_prl"), f("amp/notes.txt")], "", false);
  assert.equal(plan.pcbs.length, 1);
  assert.deepEqual([plan.pcbs[0].name, plan.pcbs[0].make], ["amp", []]);
  assert.deepEqual(plan.pcbs[0].files.map((x) => x.rel).sort(), ["3d/part.step", "amp.kicad_pcb", "amp.kicad_pro", "amp.kicad_sch", "fp-lib-table", "lib.pretty/R.kicad_mod", "sub/power.kicad_sch"]);
  assert.deepEqual(plan.refused, ["notes.txt"]); assert.equal(plan.models.length, 0, "a model inside a KiCad project is that project's file");
  // a schematic alone: a PCB named after it, with the project file and the board made empty beside it
  plan = X.planImport([f("blinker.kicad_sch")], "", false);
  assert.deepEqual([plan.pcbs[0].name, plan.pcbs[0].make], ["blinker", ["kicad_pro", "kicad_pcb"]]);
  // two projects in one drop: two PCBs, each with its own files
  plan = X.planImport([f("a/a.kicad_pro"), f("a/a.kicad_sch"), f("b/b.kicad_pro"), f("b/b.kicad_pcb"), f("b/lib/x.kicad_sym")], "", false);
  assert.deepEqual(plan.pcbs.map((p) => [p.name, p.files.map((x) => x.rel).sort(), p.make]), [["a", ["a.kicad_pro", "a.kicad_sch"], ["kicad_pcb"]], ["b", ["b.kicad_pcb", "b.kicad_pro", "lib/x.kicad_sym"], ["kicad_sch"]]]);
  // onto a PCB: the files join it, no new PCB
  plan = X.planImport([f("extra.kicad_sch"), f("mine.kicad_sym")], "Motor driver", true);
  assert.equal(plan.pcbs.length, 0);
  assert.deepEqual(plan.loose.map((x) => `${x.folder}/${x.name}`), ["Motor driver/extra.kicad_sch", "Motor driver/mine.kicad_sym"]);
  // a library with no design: a file in the folder it was dropped on
  plan = X.planImport([f("mine.kicad_sym")], "Enclosure", false);
  assert.deepEqual([plan.pcbs.length, plan.loose.map((x) => `${x.folder}/${x.name}`)], [0, ["Enclosure/mine.kicad_sym"]]);
});
