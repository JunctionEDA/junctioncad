// Node test for the assembly document (web/domains/assembly): the file format, the mate registry and the one
// mate that needs no solver.
// Run: node server/static/tests/assembly-doc.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");
const D = load("shared/itemdoc/itemdoc.ts");
const F = load("domains/assembly/document/format.ts");
const T = load("domains/assembly/core/transform.ts");
const G = load("domains/assembly/generated/page.ts");
const R = load("domains/registry.ts");

test("a new assembly is the registry's text", () => {
  assert.equal(F.newAssemblyText(), R.documentKind("assembly").newText);
  const doc = D.parseItemDoc(F.newAssemblyText(), F.ASSEMBLY_KIND);
  assert.deepEqual([F.instancesOf(doc), F.matesOf(doc)], [[], []]);
});

test("instances and mates read back in order; a bad transform reads as the identity", () => {
  const ref = (name) => ({ kind: "face", body: "e1", name });
  const doc = D.newItemDoc(F.ASSEMBLY_KIND, [
    { id: "assembly", type: "assembly", units: "mm" },
    { id: "i2", type: "instance", name: "Lid", order: "h", source: { kind: "part", docId: "d1", body: "e2" }, transform: [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 12] },
    { id: "i1", type: "instance", name: "Base", order: "V", source: { kind: "part", docId: "d1", body: "e1" }, transform: [1, 0, 0], fixed: true },
    { id: "i3", type: "instance", name: "Main board", order: "p", source: { kind: "board", docId: "d2" }, transform: F.IDENTITY },
    { id: "m1", type: "mate", mateType: "fastened", name: "Lid on base", order: "V", a: { instance: "i1", ref: ref("e1:end:ra") }, b: { instance: "i2", ref: ref("e2:start:rb"), flip: true }, params: {} },
    { id: "m2", type: "mate", mateType: "from-the-future", name: "?", order: "h", a: { instance: "i1", ref: ref("x") }, b: { instance: "i3", ref: ref("y") }, params: { k: 1 } },
    { id: "x", type: "explode-step" },
  ]);
  const back = D.parseItemDoc(D.serializeItemDoc(doc), F.ASSEMBLY_KIND);
  assert.deepEqual(F.instancesOf(back).map((i) => i.name), ["Base", "Lid", "Main board"]);
  assert.deepEqual(F.matesOf(back).map((m) => m.mateType), ["fastened", "from-the-future"]);
  assert.deepEqual(F.transformOf(F.instancesOf(back)[0]), F.IDENTITY);
  assert.equal(F.transformOf(F.instancesOf(back)[1])[11], 12);
  assert.equal(back.items.get("x").type, "explode-step", "an item type this version does not know is kept");
});

test("the mate registry is generated from mates/, and Fastened puts connector b on connector a", () => {
  assert.ok(G.MATES.some((m) => m.type === "fastened"));
  for (const m of G.MATES) { assert.equal(typeof m.place, "function"); assert.ok(m.title && m.defaults() && Array.isArray(m.schema) && m.freedom); }
  const fastened = G.MATES.find((m) => m.type === "fastened");
  // a: the top of a base at z = 10; b: the underside of a lid that sits rotated a quarter turn and far away
  const a = { origin: [20, 10, 10], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
  const bNow = [0, -1, 0, 100, 1, 0, 0, 50, 0, 0, 1, 7];
  const local = { origin: [3, 4, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
  const world = (t, f) => ({ origin: T.apply(t, f.origin), x: T.apply([...t.slice(0, 3), 0, ...t.slice(4, 7), 0, ...t.slice(8, 11), 0], f.x), y: T.apply([...t.slice(0, 3), 0, ...t.slice(4, 7), 0, ...t.slice(8, 11), 0], f.y), normal: T.apply([...t.slice(0, 3), 0, ...t.slice(4, 7), 0, ...t.slice(8, 11), 0], f.normal) });
  const placed = fastened.place(a, world(bNow, local), bNow, {});
  const after = world(placed, local);
  for (const k of ["origin", "x", "y", "normal"]) after[k].forEach((v, i) => assert.ok(Math.abs(v - a[k][i]) < 1e-9, `${k}[${i}] ${v} is not ${a[k][i]}`));
  // and the arithmetic it stands on
  const inv = T.multiply(bNow, T.invert(bNow));
  inv.forEach((v, i) => assert.ok(Math.abs(v - F.IDENTITY[i]) < 1e-12));
});
