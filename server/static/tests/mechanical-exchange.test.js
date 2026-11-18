// Node test for the mechanical domain's import and export (web/domains/mechanical/kernel/ops/exchange-*.ts,
// services/export-*.ts, features/import-file.ts), with the real OpenCascade build: STEP and BREP round trips
// (volume and face count), the Import feature as a base for later features, mesh files (STL, 3MF, OBJ, GLB),
// flat drawings (DXF, SVG) and the product structure read from a STEP file's text.
// Run: node server/static/tests/mechanical-exchange.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const server = path.join(__dirname, "..", "..");
const repo = path.join(server, "..");
const esbuild = require(path.join(server, "node_modules", "esbuild"));

execFileSync(process.execPath, [path.join(server, "scripts", "gen-cad-registry.mjs")]);
// the kernel side, plus the exchange modules, in one bundle
const entry = `export * from "./kernel/index"; export * as Step from "./kernel/ops/exchange-step"; export * as Info from "./kernel/ops/exchange-stepinfo";
export * as Mesh from "./kernel/ops/exchange-mesh"; export * as Flat from "./kernel/ops/exchange-2d"; export * as Zip from "./kernel/ops/exchange-zip";
export { importNames } from "./features/import-file";`;
const bundle = esbuild.buildSync({ stdin: { contents: entry, resolveDir: path.join(server, "web", "domains", "mechanical"), loader: "ts" }, bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" });
const M = { exports: {} }; new Function("module", "exports", "require", bundle.outputFiles[0].text)(M, M.exports, require);
const K = M.exports;

// a promise of whatever fn returns, even when it throws at once
const quiet = async (fn) => fn();

let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")), print: () => {}, printErr: () => {} });
  kernel = new K.Kernel(oc);
  return kernel;
}

// files the Import feature reads, by document id (the worker would fetch /api/docs/{id}/content)
const files = new Map();
globalThis.__junctionProjectFile = (f) => files.get(f.docId) || null;

const rect = (x0, y0, x1, y1, p) => ({
  [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y0 }, [`${p}3`]: { type: "point", x: x1, y: y1 }, [`${p}4`]: { type: "point", x: x0, y: y1 },
  [`${p}a`]: { type: "line", a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: "line", a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: "line", a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: "line", a: `${p}4`, b: `${p}1` },
});
const sketch = (id, entities, plane = { kind: "plane", plane: "top" }) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, o = {}) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });
const importOf = (id, docId, o = {}) => ({ id, type: "import", name: id, suppressed: false, params: { file: { docId, path: `imports/${docId}`, name: docId }, split: "solids", ...o } });
// two parts: a plate with a hole, and a block beside it
const model = () => [
  sketch("s1", { ...rect(0, 0, 40, 20, "r"), hc: { type: "point", x: 10, y: 10 }, hole: { type: "circle", center: "hc", r: 3 } }),
  extrude("e1", "s1"),
  sketch("s2", rect(60, 0, 70, 10, "b")),
  extrude("e2", "s2", { depth: 5 }),
];
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const service = (name) => K.SERVICES.find((s) => s.name === name);
const call = (k, engine, name, args) => quiet(() => {
  const mine = []; k.scope = mine;
  return Promise.resolve(service(name).run({ oc: k.oc, k, state: engine.state, fail: (m) => new Error(m) }, args)).finally(() => { k.scope = null; for (const o of mine.reverse()) { try { o.delete(); } catch (e) { /* gone */ } } });
});
const facesOf = (k, shape) => k.withScope(() => k.sub(shape, "face").length);

test("the import feature and the export services are registered from their folders", () => {
  assert.ok(K.FEATURES.some((f) => f.type === "import" && f.toolbar === false));
  for (const s of ["export-step", "export-mesh", "export-outline"]) assert.ok(service(s), s);
});

test("STEP export → import: the same parts, volumes, face counts and names", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate(model(), 4);
  const [plate, block] = engine.state.bodies;
  const out = await call(k, engine, "export-step", { format: "step", schema: "AP242", names: { [block.id]: "Spacer block" }, colors: { [plate.id]: [0.8, 0.2, 0.1] } });
  assert.ok(out.data instanceof Uint8Array && out.bytes === out.data.length && out.parts === 2);
  const text = new TextDecoder().decode(out.data);
  assert.match(text, /^ISO-10303-21;/);
  assert.match(text, /AP242_MANAGED_MODEL_BASED_3D_ENGINEERING/);
  assert.match(text, /PRODUCT\('Part 1'/); assert.match(text, /PRODUCT\('Spacer block'/);
  assert.match(text, /COLOUR_RGB\('',0\.8\d*,0\.(19|2)\d*,0\.(09|1)\d*\)/);
  assert.match(text, /SI_UNIT\(\.MILLI\.,\.METRE\.\)/);

  files.set("two-parts.step", out.data);
  const back = new K.RegenEngine(k, K.FEATURES);
  const r = await quiet(() => back.regenerate([importOf("imp", "two-parts.step")], 1));
  assert.deepEqual(r.features.map((f) => f.status), ["ok"], JSON.stringify(r.features));
  assert.equal(back.state.bodies.length, 2);
  assert.deepEqual(back.state.bodies.map((b) => b.name), ["Part 1", "Spacer block"]);
  assert.deepEqual(back.state.bodies.map((b) => b.id), ["imp:s1", "imp:s2"]);
  near(k.volume(back.state.bodies[0].shape), k.volume(plate.shape), 1e-6);
  near(k.volume(back.state.bodies[1].shape), k.volume(block.shape), 1e-6);
  assert.equal(facesOf(k, back.state.bodies[0].shape), facesOf(k, plate.shape));
  assert.equal(facesOf(k, back.state.bodies[1].shape), 6);
  // index-based face names, unique per body, and edge / vertex names follow from them
  const names = back.state.bodies[0].topo.faces.map((f) => f.name);
  assert.deepEqual(names, names.map((_n, i) => `imp:s1:f${i + 1}`));
  assert.ok(back.state.bodies[0].topo.edges.every((e) => e.name.startsWith("edge(imp:s1:f")));
  assert.equal(r.bodies.length, 2); assert.ok(r.bodies[0].mesh.indices.length > 0, "imported bodies are tessellated for the viewport");
  engine.dispose(); back.dispose();
});

test("an import read before comes back from its cached B-rep: no file read, the same bodies, names and face places", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate(model(), 4);
  const out = await call(k, engine, "export-step", { format: "step", schema: "AP242" });
  files.set("cached.step", out.data);
  const kept = new Map(); let gets = 0, sets = 0, reads = 0;
  globalThis.__junctionImportCache = { get: async (key) => { gets++; return kept.get(key) || null; }, set: async (key, v) => { sets++; kept.set(key, JSON.parse(JSON.stringify(v))); } };
  const before = globalThis.__junctionProjectFile;
  globalThis.__junctionProjectFile = (f) => { reads++; return before(f); };
  try {
    // where each named face is: its centre, from the triangles the viewport would draw
    const places = (r) => r.bodies.map((b) => b.mesh.faces.names.map((name, i) => {
      const c = [0, 0, 0]; let n = 0;
      for (let t = b.mesh.faces.start[i]; t < b.mesh.faces.start[i] + b.mesh.faces.count[i]; t++) { const v = b.mesh.indices[t]; for (let a = 0; a < 3; a++) c[a] += b.mesh.positions[v * 3 + a]; n++; }
      return [name, ...c.map((x) => Math.round((x / n) * 1000) / 1000)];
    }));
    const first = new K.RegenEngine(k, K.FEATURES);
    const t0 = Date.now();
    const r1 = await quiet(() => first.regenerate([importOf("imp", "cached.step")], 1));
    const cold = Date.now() - t0;
    assert.deepEqual(r1.features.map((f) => f.status), ["ok"]);
    assert.deepEqual([reads, sets, kept.size], [1, 1, 1], "the first read fills the cache");
    const second = new K.RegenEngine(k, K.FEATURES);
    const t1 = Date.now();
    const r2 = await quiet(() => second.regenerate([importOf("imp", "cached.step")], 1));
    const warm = Date.now() - t1;
    assert.deepEqual(r2.features.map((f) => f.status), ["ok"], JSON.stringify(r2.features));
    assert.equal(reads, 1, "the file is not read again");
    assert.deepEqual(second.state.bodies.map((b) => [b.id, b.name]), first.state.bodies.map((b) => [b.id, b.name]));
    assert.deepEqual(places(r2), places(r1), "every face has the name it had, where it was");
    near(k.volume(second.state.bodies[0].shape), k.volume(first.state.bodies[0].shape), 1e-9);
    // a different split is a different entry; a cache that holds rubbish is passed over
    const one = new K.RegenEngine(k, K.FEATURES);
    await quiet(() => one.regenerate([importOf("imp", "cached.step", { split: "one" })], 1));
    assert.deepEqual([reads, kept.size], [2, 2]);
    for (const key of kept.keys()) kept.set(key, { v: 1, bodies: [{ brep: "not a shape", name: "x" }], sheets: 0 });
    const again = new K.RegenEngine(k, K.FEATURES);
    const r4 = await quiet(() => again.regenerate([importOf("imp", "cached.step")], 1));
    assert.deepEqual(r4.features.map((f) => f.status), ["ok"]); assert.equal(reads, 3); assert.equal(again.state.bodies.length, 2);
    console.log(`      (a two-part STEP: ${cold} ms read from the file, ${warm} ms from the cache)`);
    first.dispose(); second.dispose(); one.dispose(); again.dispose();
  } finally { delete globalThis.__junctionImportCache; globalThis.__junctionProjectFile = before; engine.dispose(); }
});

test("an imported body is a real base feature: a sketch on its face cuts it, and the names survive a rebuild", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate(model().slice(0, 2), 2);
  const plate = engine.state.bodies[0];
  files.set("plate.step", (await call(k, engine, "export-step", { format: "step" })).data);
  // the plate's top face: the face whose centre is highest
  const imp = new K.RegenEngine(k, K.FEATURES);
  await quiet(() => imp.regenerate([importOf("imp", "plate.step")], 1));
  const body = imp.state.bodies[0];
  const top = body.topo.faces.map((f) => ({ name: f.name, z: k.centre(f.shape, "face")[2] })).sort((a, b) => b.z - a.z)[0];
  assert.equal(body.id, "imp");
  const doc = [
    importOf("imp", "plate.step"),
    sketch("s", { c: { type: "point", x: 30, y: 10 }, pocket: { type: "circle", center: "c", r: 4 } }, { kind: "face", ref: { kind: "face", body: "imp", name: top.name } }),
    extrude("cut", "s", { operation: "remove", depth: 4, flip: true }),
  ];
  const r = await quiet(() => imp.regenerate(doc, 3));
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok", "ok"], JSON.stringify(r.features));
  near(k.volume(imp.state.bodies[0].shape), k.volume(plate.shape) - Math.PI * 16 * 4, 1e-6);
  // changing the pocket re-runs the sketch and the cut, not the import (cached), and the face is still found
  doc[1] = sketch("s", { c: { type: "point", x: 30, y: 10 }, pocket: { type: "circle", center: "c", r: 5 } }, doc[1].params.plane);
  const again = await quiet(() => imp.regenerate(doc, 3));
  assert.equal(again.rebuiltFrom, 1);
  assert.ok(again.features[0].cached);
  near(k.volume(imp.state.bodies[0].shape), k.volume(plate.shape) - Math.PI * 25 * 4, 1e-6);
  engine.dispose(); imp.dispose();
});

test("import failures say what to do; a missing file, a file that is not STEP", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  globalThis.fetch = undefined;
  let r = await quiet(() => engine.regenerate([importOf("a", "missing.step")], 1));
  assert.equal(r.features[0].status, "error");
  assert.match(r.features[0].message, /cannot be read here|no longer in this project/);
  files.set("junk.step", new TextEncoder().encode("hello, this is not a model"));
  r = await quiet(() => engine.regenerate([importOf("b", "junk.step")], 1));
  assert.equal(r.features[0].status, "error");
  assert.match(r.features[0].message, /not a STEP file/);
  r = await quiet(() => engine.regenerate([{ ...importOf("c", "x"), params: { file: null, split: "solids" } }], 1));
  assert.match(r.features[0].message, /Choose a file/);
  engine.dispose();
});

test("BREP export → import, and a STEP written in inches comes back in millimetres", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate(model(), 4);
  const total = engine.state.bodies.reduce((n, b) => n + k.volume(b.shape), 0);
  const brep = await call(k, engine, "export-step", { format: "brep" });
  assert.match(new TextDecoder().decode(brep.data.subarray(0, 40)), /CASCADE Topology/);
  files.set("both.brep", brep.data);
  const back = new K.RegenEngine(k, K.FEATURES);
  let r = await quiet(() => back.regenerate([{ ...importOf("b", "both.brep"), params: { file: { docId: "both.brep", path: "x/both.brep", format: "brep" }, split: "solids" } }], 1));
  assert.equal(r.features[0].status, "ok", r.features[0].message);
  assert.equal(back.state.bodies.length, 2);
  near(back.state.bodies.reduce((n, b) => n + k.volume(b.shape), 0), total, 1e-9);

  const inch = await call(k, engine, "export-step", { format: "step", unit: "in", schema: "AP214" });
  const text = new TextDecoder().decode(inch.data);
  assert.match(text, /CONVERSION_BASED_UNIT\('INCH'/);
  assert.match(text, /AUTOMOTIVE_DESIGN/);
  files.set("inch.step", inch.data);
  r = await quiet(() => back.regenerate([importOf("i", "inch.step", { split: "one" })], 1));
  assert.equal(r.features[0].status, "ok", r.features[0].message);
  assert.equal(back.state.bodies.length, 1);
  near(k.volume(back.state.bodies[0].shape), total, 1e-6);
  engine.dispose(); back.dispose();
});

test("mesh exports: STL encloses the solid's volume at every resolution; 3MF, OBJ and GLB are well formed", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate(model().slice(0, 2), 2);
  const exact = k.volume(engine.state.bodies[0].shape);
  const coarse = await call(k, engine, "export-mesh", { format: "stl", resolution: "coarse" });
  const fine = await call(k, engine, "export-mesh", { format: "stl", resolution: { deflection: 0.002, angleDeg: 3 } });
  assert.ok(fine.triangles > coarse.triangles, `${fine.triangles} > ${coarse.triangles}`);
  assert.equal(coarse.data.length, 84 + coarse.triangles * 50);
  const vc = K.Mesh.meshVolume(K.Mesh.readStl(coarse.data)), vf = K.Mesh.meshVolume(K.Mesh.readStl(fine.data));
  // the hole is a polygon, so the mesh holds a little more material than the solid; finer is closer
  assert.ok(Math.abs(vf - exact) < Math.abs(vc - exact) + 1e-9 && Math.abs(vf - exact) / exact < 1e-4, `${vc} ${vf} ${exact}`);
  const ascii = await call(k, engine, "export-mesh", { format: "stl-ascii", resolution: "coarse", unit: "in" });
  const atext = new TextDecoder().decode(ascii.data);
  assert.match(atext, /^solid Part_1\n/); assert.match(atext, /endsolid Part_1\n$/);
  near(K.Mesh.meshVolume(K.Mesh.readStl(ascii.data)) * 25.4 ** 3, vc, 1e-5);

  const three = await call(k, engine, "export-mesh", { format: "3mf", resolution: "medium", colors: { e1: [0.1, 0.5, 0.9] } });
  const entries = await K.Zip.unzip(three.data);
  assert.deepEqual(entries.map((e) => e.name), ["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]);
  const xml = new TextDecoder().decode(entries[2].data);
  assert.match(xml, /unit="millimeter"/); assert.match(xml, /<object id="2" name="Part 1"/); assert.match(xml, /displaycolor="#1A80E6"/);
  assert.equal((xml.match(/<triangle /g) || []).length, three.triangles);

  const obj = new TextDecoder().decode((await call(k, engine, "export-mesh", { format: "obj", resolution: "coarse" })).data);
  assert.match(obj, /^o Part 1$/m); assert.ok((obj.match(/^f /gm) || []).length === coarse.triangles);

  const glb = (await call(k, engine, "export-mesh", { format: "glb", resolution: "coarse" })).data;
  const v = new DataView(glb.buffer, glb.byteOffset);
  assert.equal(v.getUint32(0, true), 0x46546c67); assert.equal(v.getUint32(8, true), glb.length);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + v.getUint32(12, true))));
  assert.equal(json.meshes[0].name, "Part 1"); assert.equal(json.accessors[json.meshes[0].primitives[0].indices].count, coarse.triangles * 3);
  near(json.accessors[0].max[0], 0.04, 1e-6);   // metres
  engine.dispose();
});

test("flat drawings: a sketch and a planar face's outline as DXF and SVG", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const doc = model().slice(0, 2);
  await engine.regenerate(doc, 2);
  const d = K.Flat.sketchDrawing(doc[0].params.sketch, "Sketch 1");
  assert.deepEqual(d.curves.map((c) => c.kind).sort(), ["circle", "line", "line", "line", "line"]);
  const dxf = K.Flat.writeDxf(d);
  assert.match(dxf, /^999\nJunction DXF: Sketch 1\n0\nSECTION/);
  assert.equal((dxf.match(/\n0\nLINE\n/g) || []).length, 4); assert.equal((dxf.match(/\n0\nCIRCLE\n/g) || []).length, 1);
  assert.match(dxf, /\$INSUNITS\n70\n4\n/); assert.match(dxf, /\n0\nEOF\n$/);
  const svg = K.Flat.writeSvg(d);
  assert.match(svg, /width="42mm" height="22mm" viewBox="0 0 42 22"/);
  assert.match(svg, /<circle cx="11" cy="11" r="3"\/>/);

  // the plate's top face: four lines and the hole, exact
  const top = engine.state.bodies[0].topo.faces.find((f) => f.name === "e1:end:ra");
  const out = await call(k, engine, "export-outline", { face: { kind: "face", body: "e1", name: top.name } });
  assert.deepEqual(out.curves.map((c) => c.kind).sort(), ["circle", "line", "line", "line", "line"]);
  const b = K.Flat.drawingBounds(out);
  near(b[2] - b[0], 40, 1e-9); near(b[3] - b[1], 20, 1e-9);
  assert.equal(out.curves.find((c) => c.kind === "circle").r, 3);
  // a curved face is refused with a sentence
  await assert.rejects(call(k, engine, "export-outline", { face: { kind: "face", body: "e1", name: "e1:side:hole" } }), /not flat/);
  // an arc keeps its sweep
  const arc = { version: 1, constraints: {}, entities: { c: { type: "point", x: 0, y: 0 }, a: { type: "point", x: 10, y: 0 }, b: { type: "point", x: 0, y: 10 }, k: { type: "arc", center: "c", start: "a", end: "b" } } };
  const ad = K.Flat.sketchDrawing(arc);
  near(ad.curves[0].end - ad.curves[0].start, Math.PI / 2, 1e-12);
  assert.match(K.Flat.writeDxf(ad), /\n50\n0\n51\n90\n/);
  assert.match(K.Flat.writeSvg(ad, "mm", 1, { margin: 0 }), /<path d="M10 10A10 10 0 0 0 0 0"\/>/);
  engine.dispose();
});

test("STEP product structure: strings, assemblies and the names an import gives", async () => {
  assert.equal(K.Info.stepString("it''s \\X2\\00FC\\X0\\ber"), "it's über");
  assert.deepEqual(K.Info.stepArgs("'a,b',#12,(#1,#2),$,'it''s'"), ["'a,b'", "#12", "(#1,#2)", "$", "'it''s'"]);
  const text = `ISO-10303-21;\nHEADER;FILE_NAME('x','2026',(''),(''),'','Some CAD','');ENDSEC;DATA;
#1=PRODUCT('asm','Gearbox','',(#9));#2=PRODUCT_DEFINITION_FORMATION('','',#1);#3=PRODUCT_DEFINITION('','',#2,#8);
#11=PRODUCT('shaft','Shaft','',(#9));#12=PRODUCT_DEFINITION_FORMATION('','',#11);#13=PRODUCT_DEFINITION('','',#12,#8);
#21=PRODUCT('gear','Gear; spur (z=20)','',(#9));#22=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#21,.NOT_KNOWN.);#23=PRODUCT_DEFINITION('','',#22,#8);
#31=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','Shaft:1','',#3,#13,$);#32=NEXT_ASSEMBLY_USAGE_OCCURRENCE('2','Gear:1','',#3,#23,$);#33=NEXT_ASSEMBLY_USAGE_OCCURRENCE('3','Gear:2','',#3,#23,$);
#40=PRODUCT_DEFINITION_SHAPE('','',#3);#41=SHAPE_DEFINITION_REPRESENTATION(#40,#42);
ENDSEC;END-ISO-10303-21;`;
  const s = K.Info.stepStructure(text);
  assert.deepEqual(s.roots, [3]);
  assert.equal(s.system, "Some CAD");
  assert.deepEqual(K.Info.leafParts(s, 3).map((l) => l.name), ["Shaft", "Gear; spur (z=20)", "Gear; spur (z=20)"]);
  assert.equal(K.Info.rootName(s, 41), "Gearbox"); assert.equal(K.Info.rootName(s, 42), "Gearbox");
  const read = { shape: null, bodies: [], roots: [{ entity: 41, shape: null }], ms: 0 };
  const bytes = new TextEncoder().encode(text);
  assert.deepEqual(K.importNames(bytes, read, [3], "file"), ["Shaft", "Gear; spur (z=20)", "Gear; spur (z=20)"]);
  assert.deepEqual(K.importNames(bytes, read, [2], "file"), ["Gearbox 1", "Gearbox 2"]);
});

// A real assembly from the demos, and (with EXCHANGE_BIG=1, as it takes half a minute) the largest STEP file in
// the repository, about 25 MB: how long reading takes, and how much there is.
const demo = (rel) => { const p = path.join(repo, ...rel.split("/")); return fs.existsSync(p) ? p : null; };
for (const [label, rel] of [["an assembly (USB connector)", "demos/cm5_minima/CM5IO.3dshapes/USB3stacked.STEP"], ["a 25 MB module", "demos/cm5_minima/3d_lib/hailo8_m.2_key_m_2242_et_m2b_3d_model_2.1.STEP"]]) {
  const file = demo(rel), big = /25 MB/.test(label);
  test(`a real STEP file imports: ${label}`, { skip: !file ? "demo file not present" : big && !process.env.EXCHANGE_BIG ? "set EXCHANGE_BIG=1 to time a 25 MB file" : false }, async () => {
    const k = await boot();
    const bytes = new Uint8Array(fs.readFileSync(file));
    const t0 = Date.now();
    const s = K.Info.stepStructure(bytes);
    const structMs = Date.now() - t0;
    files.set(label, bytes);
    const engine = new K.RegenEngine(k, K.FEATURES);
    const t1 = Date.now();
    const r = await quiet(() => engine.regenerate([importOf("imp", label)], 1));
    const ms = Date.now() - t1;
    assert.equal(r.features[0].status === "error", false, r.features[0].message);
    const bodies = engine.state.bodies;
    assert.ok(bodies.length >= 1);
    const faces = bodies.reduce((n, b) => n + b.topo.faces.length, 0), tris = r.bodies.reduce((n, b) => n + b.mesh.indices.length / 3, 0);
    console.log(`# ${path.basename(file)}: ${(bytes.length / 1048576).toFixed(1)} MB, ${s.products.size} products, structure ${structMs} ms; import + names + tessellation ${ms} ms (read ${r.features[0].ms} ms): ${bodies.length} bodies, ${faces} faces, ${tris} triangles; names: ${bodies.slice(0, 4).map((b) => b.name).join(", ")}${bodies.length > 4 ? ", …" : ""}`);
    // and back out
    const t2 = Date.now();
    const out = await call(k, engine, "export-step", { format: "step" });
    console.log(`# re-exported as STEP: ${(out.bytes / 1048576).toFixed(1)} MB in ${Date.now() - t2} ms`);
    // placed parts (an assembly's) are written as one named product each, not as one-part assemblies
    const products = new TextDecoder("latin1").decode(out.data).match(/=\s*PRODUCT\('[^']*'/g) || [];
    assert.equal(products.length, bodies.length);
    assert.ok(products.some((p) => p.includes(bodies[0].name)), products[0]);
    engine.dispose();
  });
}

test("a STEP file opens as a part studio: the stored file's path, and the document that imports it", () => {
  const { load } = require("./cad-load");
  const A = load("platform/doctabs/api.ts"), R = load("domains/registry.ts"), F = load("domains/mechanical/document/format.ts"), I = load("shared/itemdoc/itemdoc.ts");
  const docs = [{ path: "models/bracket.step" }, { path: "models/Bracket 2.STEP" }, { path: "Bracket.jpart" }];
  assert.equal(A.freeFilePath("models", "bracket.step", docs), "models/bracket 3.step");
  assert.equal(A.freeFilePath("models/", "C:gear?.stp", []), "models/C_gear_.stp");
  assert.equal(A.freeFilePath("", "Bracket.jpart", docs), "Bracket 2.jpart");
  assert.equal(A.kindForFile("Case.STP").docType, "part_studio");
  assert.equal(A.kindForFile("board.kicad_pcb"), undefined);
  const text = R.partStudioImporting({ docId: "d1", path: "models/bracket.step", name: "bracket.step", bytes: 1234 }, "f-1");
  const doc = I.parseItemDoc(text, F.PART_STUDIO_KIND);
  assert.equal(I.serializeItemDoc(doc), text, "written the way the server folds it");
  const [feature] = F.featuresOf(doc);
  assert.equal(feature.featureType, "import"); assert.equal(feature.name, "bracket");
  assert.deepEqual(feature.params, { file: { docId: "d1", path: "models/bracket.step", name: "bracket.step", bytes: 1234, format: "step" }, split: "solids" });
  assert.equal(F.rollbackIndex(doc), 1);
  assert.ok(K.FEATURES.find((f) => f.type === "import").schema.every((s) => s.key in feature.params));
});
