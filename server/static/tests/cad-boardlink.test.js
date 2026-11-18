// Node test for the board link, part studio side (web/domains/mechanical/boardlink): the one coordinate
// transform between a model and a board, the ids of driven items, the link item and its edits, and the solver
// run on the real OpenCascade kernel against a small enclosure.
// Run: node server/static/tests/cad-boardlink.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load, server } = require("./cad-load");

const T = load("domains/mechanical/boardlink/transform.ts");
const I = load("domains/mechanical/boardlink/ids.ts");
const F = load("domains/mechanical/boardlink/format.ts");
const S = load("domains/mechanical/boardlink/solve.ts");
const D = load("shared/itemdoc/itemdoc.ts");
const K = load("domains/mechanical/kernel/index.ts");

const TOP = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

// ---------------------------------------------------------------- transform
test("model → board: millimetres to whole nanometres, Y flipped once, heights along the normal", () => {
  const pl = { frame: TOP, anchor: [100, 80], rotation: 0 };
  assert.deepEqual(T.modelToBoard(pl, [0, 0, 0]), { x: 100e6, y: 80e6, w: 0 });
  // +X of the model is +X of the sheet; +Y of the model is UP the sheet, which is −Y in KiCad
  assert.deepEqual(T.modelToBoard(pl, [10, 0, 0]), { x: 110e6, y: 80e6, w: 0 });
  assert.deepEqual(T.modelToBoard(pl, [0, 10, 0]), { x: 100e6, y: 70e6, w: 0 });
  assert.deepEqual(T.modelToBoard(pl, [1.2345678, -2.5, 7]), { x: 101234568, y: 82500000, w: 7 });
  assert.ok(Object.is(T.mmToNm(-0.0000000001), 0), "no negative zero");
});

test("model → board: a lifted plane, a rotation, a tilted frame; and back again", () => {
  const lifted = T.liftFrame(TOP, 5);
  assert.deepEqual(lifted.origin, [0, 0, 5]);
  near(T.modelToBoard({ frame: lifted, anchor: [0, 0], rotation: 0 }, [3, 4, 6.6]).w, 1.6);
  // 90° counter-clockwise seen from the front: model +X goes up the sheet
  const rot = { frame: TOP, anchor: [50, 50], rotation: 90 };
  assert.deepEqual(T.modelToBoard(rot, [10, 0, 0]), { x: 50e6, y: 40e6, w: 0 });
  assert.deepEqual(T.modelToBoard(rot, [0, 10, 0]), { x: 40e6, y: 50e6, w: 0 });
  // the Front plane (XZ, normal −Y): model Z is up the sheet, model −Y is the height
  const front = { frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], normal: [0, -1, 0] }, anchor: [0, 0], rotation: 0 };
  assert.deepEqual(T.modelToBoard(front, [2, -3, 4]), { x: 2e6, y: -4e6, w: 3 });
  for (const pl of [rot, front, { frame: T.liftFrame(TOP, 2), anchor: [12.5, -7], rotation: 33 }]) {
    for (const p of [[0, 0, 0], [7.25, -3.5, 2], [-40, 18, 9.75]]) {
      const b = T.modelToBoard(pl, p), back = T.boardToModel(pl, b.x, b.y, b.w);
      for (let i = 0; i < 3; i++) near(back[i], p[i], 1e-6);
    }
  }
});

test("model → the board's 3D space is a rigid motion: right-handed, front face at z = 0", () => {
  const pl = { frame: T.liftFrame(TOP, 5), anchor: [100, 80], rotation: 30 };
  const o = T.modelToBoard3D(pl, 1.6, [0, 0, 5]), ex = T.modelToBoard3D(pl, 1.6, [1, 0, 5]), ey = T.modelToBoard3D(pl, 1.6, [0, 1, 5]), ez = T.modelToBoard3D(pl, 1.6, [0, 0, 6]);
  assert.deepEqual(o.map((v) => Math.round(v * 1e6) / 1e6), [100, -80, -1.6]);   // the back face is at −thickness
  const d = (a) => [a[0] - o[0], a[1] - o[1], a[2] - o[2]];
  const [x, y, z] = [d(ex), d(ey), d(ez)];
  const cross = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  for (let i = 0; i < 3; i++) near(cross[i], z[i], 1e-12);          // x × y = z: no mirror
  // and it agrees with the sheet transform: X as the sheet, Y negated
  const b = T.modelToBoard(pl, [7, 3, 5]), m = T.modelToBoard3D(pl, 1.6, [7, 3, 5]);
  near(m[0], b.x / 1e6, 1e-6); near(m[1], -b.y / 1e6, 1e-6);
  const n = T.directionToBoard3D(pl, [0, 0, 1]);
  assert.deepEqual(n.map((v) => Math.round(v * 1e9) / 1e9), [0, 0, 1]);
});

// ---------------------------------------------------------------- ids
test("driven ids are stable, distinct and recognisable", () => {
  const a = I.drivenId("link", "d1", "outline", 0);
  assert.equal(a, I.drivenId("link", "d1", "outline", 0));
  assert.match(a, /^6a756e63-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  const many = new Set();
  for (const l of ["a", "b"]) for (const d of ["d1", "d2"]) for (const r of ["outline", "hole", "group"]) for (let n = 0; n < 200; n++) many.add(I.drivenId(l, d, r, n));
  assert.equal(many.size, 2 * 2 * 3 * 200);
  assert.ok(I.isDrivenId(a));
  assert.ok(!I.isDrivenId("3f0c2a10-7a57-4c1e-9b0a-0a0a0a0a0a0a"));
});

// ---------------------------------------------------------------- the link item
test("a link is an item of the part studio; its edits are item changes that touch only what changed", () => {
  const doc = D.newItemDoc("part-studio", [{ id: "studio", type: "studio", units: "mm", rollback: null }]);
  D.applyChanges(doc, F.addLink("L", "board-doc", { kind: "plane", plane: "top" }));
  assert.equal(F.linksOf(doc).length, 1);
  assert.equal(F.linksOf(doc, "other").length, 0);
  D.applyChanges(doc, F.addDrive(doc, "L", "o", "outline", { kind: "sketch", feature: "s1" }));
  D.applyChanges(doc, F.addDrive(doc, "L", "h", "holes", { kind: "faces", refs: [{ kind: "face", body: "b", name: "f" }] }));
  D.applyChanges(doc, F.addDrive(doc, "L", "k", "keepout", { kind: "faces", refs: [] }));
  D.applyChanges(doc, F.addDrive(doc, "L", "k2", "keepout", { kind: "sketch", feature: "s9" }));
  const link = F.linksOf(doc)[0];
  assert.deepEqual(F.drivesOf(link).map((d) => `${d.id}:${d.name}`), ["o:Board outline", "h:Mounting holes", "k:Keep-out", "k2:Keep-out 2"]);
  assert.equal(link.drives.k.mode, "ceiling"); assert.equal(link.drives.k2.mode, "height"); assert.equal(link.drives.h.diameter, 3.2);

  const edit = F.setDrive(doc, "L", "o", { inset: 0.5 });
  assert.deepEqual(edit[0].props, [{ path: ["drives", "o", "inset"], value: 0.5 }]);
  D.applyChanges(doc, edit);
  // a new answer for one drive sends that drive only
  const solved = { ...F.emptySolved(), frame: TOP, drives: { o: { kind: "outline", curves: [["l", 0, 0, 1, 1]] } } };
  D.applyChanges(doc, F.setSolved(doc, "L", solved));
  const again = F.setSolved(doc, "L", { ...solved, drives: { ...solved.drives, h: { kind: "holes", holes: [[1, 2, 3]], pad: 0 } } });
  assert.deepEqual(again[0].props.map((p) => p.path.join(".")), ["solved.drives.h"]);
  assert.deepEqual(F.setSolved(doc, "L", solved).length ? "changed" : "same", "same");
  D.applyChanges(doc, again);
  D.applyChanges(doc, F.removeDrive(doc, "L", "h"));
  const after = F.linksOf(doc)[0];
  assert.ok(!after.drives.h && !after.solved.drives.h && after.solved.drives.o);
  assert.deepEqual(F.placementOf(after), { frame: TOP, anchor: [100, 100], rotation: 0 });
  // a link placed by a Board feature: the answer carries where that feature's origin is on the sheet, and
  // that is what the board editor reads, whatever the link's own anchor and turn say
  const placed = { ...after, feature: "bf", anchor: [1, 2], rotation: 30, solved: { ...after.solved, anchor: [134, 84], rotation: 0 } };
  assert.deepEqual(F.placementOf(placed), { frame: TOP, anchor: [134, 84], rotation: 0 });
  const made = F.addLink("L9", "board-doc", { kind: "plane", plane: "top" }, "bf")[0].item;
  assert.equal(made.feature, "bf"); assert.equal(F.readLink(made).feature, "bf");
  assert.equal(F.addLink("L8", "board-doc", { kind: "plane", plane: "top" })[0].item.feature, undefined);

  // unknown keys survive, a foreign item is not a link, and a half-written link reads with defaults
  assert.equal(F.readLink({ id: "x", type: "feature" }), null);
  const loose = F.readLink({ id: "x", type: "board-link", board: "b", future: 1 });
  assert.equal(loose.future, 1); assert.deepEqual(loose.anchor, [100, 100]); assert.deepEqual(loose.solved.drives, {});
});

test("a keep-out's limit: a number, nothing, or the room under a face on a board of some thickness", () => {
  const k = { kind: "keepout", loops: [], side: "top", mode: "height", max: 4, gap: 0, clearance: 0 };
  assert.equal(F.keepoutLimit(k, 1.6), 4);
  assert.equal(F.keepoutLimit({ ...k, mode: "none" }, 1.6), 0);
  near(F.keepoutLimit({ ...k, mode: "ceiling", gap: 10, clearance: 0.5 }, 1.6), 7.9);
  near(F.keepoutLimit({ ...k, mode: "ceiling", side: "bottom", gap: -5, clearance: 0.5 }, 1.6), 4.5);
  assert.equal(F.keepoutLimit({ ...k, mode: "ceiling", gap: 1, clearance: 0.5 }, 1.6), 0);
});

test("polylines are chained into closed loops whatever their order and direction", () => {
  const mm = (a) => a.map((v) => v * 1e6);
  const loops = S.chainLoops([[0, 0, 10, 0], [10, 10, 0, 10], [10, 0, 10, 10], [0, 10, 0, 0], [50, 50, 60, 50, 60, 60], [50, 50, 60, 60]].map(mm));
  assert.equal(loops.length, 2);
  assert.deepEqual(loops[0], mm([0, 0, 10, 0, 10, 10, 0, 10]));
  assert.equal(loops[1].length, 6);
});

// ---------------------------------------------------------------- the solver on the real kernel
let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new K.Kernel(oc);
  return kernel;
}
const rect = (x0, y0, x1, y1, p) => ({
  [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y0 }, [`${p}3`]: { type: "point", x: x1, y: y1 }, [`${p}4`]: { type: "point", x: x0, y: y1 },
  [`${p}a`]: { type: "line", a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: "line", a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: "line", a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: "line", a: `${p}4`, b: `${p}1` },
});
const circle = (id, x, y, r) => ({ [`${id}c`]: { type: "point", x, y }, [id]: { type: "circle", center: `${id}c`, r } });
const sketch = (id, entities, plane = { kind: "plane", plane: "top" }) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, o = {}) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });

// An enclosure tray: a 60 × 40 × 12 block, a pocket that leaves a 2 mm floor and walls, four bosses standing
// 5 mm above the floor, and a rib across the open top (a "lid" feature) 10 mm above the floor.
const tray = (w = 60) => [
  sketch("s1", rect(0, 0, w, 40, "r")), extrude("e1", "s1", { depth: 12 }),
  sketch("s2", rect(2, 2, w - 2, 38, "p"), { kind: "face", ref: { kind: "face", body: "e1", name: "e1:end:ra" } }),
  extrude("e2", "s2", { operation: "remove", depth: 10, flip: true }),
  sketch("s3", { ...circle("b1", 8, 8, 3), ...circle("b2", w - 8, 8, 3), ...circle("b3", w - 8, 32, 3), ...circle("b4", 8, 32, 3) }),
  extrude("e3", "s3", { operation: "add", depth: 7 }),
  sketch("s4", rect(20, 0, 30, 40, "k"), { kind: "face", ref: { kind: "face", body: "e1", name: "e1:end:ra" } }),
  extrude("e4", "s4", { operation: "add", depth: 2, flip: true }),
];
const service = (k, engine) => ({ oc: k.oc, k, state: engine.state, fail: (m) => new Error(m) });
const solve = (k, engine, link) => k.withScope(() => S.solveLink(service(k, engine), F.readLink(link)));
const linkItem = (o = {}) => ({ id: "L", type: "board-link", board: "pcb", plane: { kind: "plane", plane: "top" }, lift: 0, anchor: [100, 100], rotation: 0, drives: {}, solved: F.emptySolved(), ...o });
const faceRef = (name) => ({ kind: "face", body: "e1", name });
const bbox = (curves) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of curves) { const pts = c[0] === "c" ? [c[1] - c[3], c[2] - c[3], c[1] + c[3], c[2] + c[3]] : c.slice(1); for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); } }
  return [x0, y0, x1, y1];
};

test("the tray builds, and its faces have the names the tests below pick", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(tray(), 8);
  assert.deepEqual(r.features.map((f) => `${f.id}:${f.status}`), ["s1:ok", "e1:ok", "s2:ok", "e2:ok", "s3:ok", "e3:ok", "s4:ok", "e4:ok"], JSON.stringify(r.features.map((f) => f.message)));
  const names = engine.state.bodies[0].topo.faces.map((f) => f.name);
  for (const n of ["e2:end:pa", "e3:end:b1", "e4:end:ka"]) assert.ok(names.includes(n), `${n} in ${names.join(" ")}`);
});

test("an outline from a sketch: four lines in nanometres, Y down", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate(tray(), 8);
  const s = solve(k, engine, linkItem({ drives: { o: { kind: "outline", name: "o", order: "V", source: { kind: "sketch", feature: "s2" }, inset: 0, cutouts: true } } }));
  assert.deepEqual(s.errors, {});
  assert.deepEqual(s.frame, TOP);
  const curves = s.drives.o.curves;
  assert.equal(curves.length, 4);
  assert.ok(curves.every((c) => c[0] === "l" && c.slice(1).every(Number.isInteger)));
  // the sketch is on the top face (z = 12), whose frame may differ from the model's; whatever it is, the loop
  // is the pocket: 56 × 36 mm, and it lands inside the tray's footprint seen from above
  const b = bbox(curves);
  assert.equal(b[2] - b[0], 56e6); assert.equal(b[3] - b[1], 36e6);
  assert.deepEqual(b, [102e6, 62e6, 158e6, 98e6]);    // x 2…58 → 102…158; y 2…38 → sheet 100 − 38 … 100 − 2
});

test("an outline from the floor face, inset by a clearance: the pocket's boundary alone, corners rounded by the offset", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate(tray(), 8);
  const drive = { kind: "outline", name: "o", order: "V", source: { kind: "faces", refs: [faceRef("e2:end:pa")] }, inset: 0, cutouts: false };
  let s = solve(k, engine, linkItem({ drives: { o: drive } }));
  assert.deepEqual(s.errors, {});
  // the floor has four holes where the bosses stand; they are not part of the board's outline
  assert.equal(s.drives.o.curves.length, 4);
  assert.deepEqual(bbox(s.drives.o.curves), [102e6, 62e6, 158e6, 98e6]);
  // with the holes kept (cutouts): four circles more
  s = solve(k, engine, linkItem({ drives: { o: { ...drive, cutouts: true } } }));
  assert.equal(s.drives.o.curves.filter((c) => c[0] === "c").length, 4);
  assert.deepEqual(s.drives.o.curves.filter((c) => c[0] === "c").map((c) => c[3]), [3e6, 3e6, 3e6, 3e6]);
  // 1 mm clearance: 54 × 34, straight sides (an inward offset of a convex corner stays sharp)
  s = solve(k, engine, linkItem({ drives: { o: { ...drive, inset: 1 } } }));
  assert.deepEqual(s.errors, {});
  assert.deepEqual(bbox(s.drives.o.curves), [103e6, 63e6, 157e6, 97e6]);
  assert.equal(s.drives.o.curves.filter((c) => c[0] === "l").length, 4);
  // outwards, the corners become arcs through three points
  s = solve(k, engine, linkItem({ drives: { o: { ...drive, inset: -1 } } }));
  assert.equal(s.drives.o.curves.filter((c) => c[0] === "a").length, 4);
  assert.deepEqual(bbox(s.drives.o.curves.filter((c) => c[0] === "l")), [101e6, 61e6, 159e6, 99e6]);
  // far too much
  s = solve(k, engine, linkItem({ drives: { o: { ...drive, inset: 30 } } }));
  assert.match(s.errors.o, /inset|offset/);
});

test("mounting holes from boss tops and from a sketch's circles; the board on the bosses", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate(tray(), 8);
  const bosses = ["b1", "b2", "b3", "b4"].map((b) => faceRef(`e3:end:${b}`));
  // the board lies on the boss tops: the plane is one of them
  let s = solve(k, engine, linkItem({ plane: { kind: "face", ref: bosses[0] }, drives: { h: { kind: "holes", name: "h", order: "V", source: { kind: "faces", refs: bosses }, diameter: 3.2, pad: 0 } } }));
  assert.deepEqual(s.errors, {});
  assert.deepEqual(s.frame.origin, [0, 0, 7]); assert.deepEqual(s.frame.normal, [0, 0, 1]);
  const at = s.drives.h.holes.map((h) => { const m = T.boardToModel(F.placementOf({ ...linkItem(), solved: s }), h[0], h[1], 0); return m.map((v) => Math.round(v * 1e6) / 1e6).join(","); });
  assert.deepEqual(at, ["8,8,7", "52,8,7", "52,32,7", "8,32,7"]);
  assert.ok(s.drives.h.holes.every((h) => h[2] === 3.2e6));
  // from the sketch: the circles' own diameter, in entity order
  s = solve(k, engine, linkItem({ drives: { h: { kind: "holes", name: "h", order: "V", source: { kind: "sketch", feature: "s3" }, diameter: 0, pad: 6 } } }));
  assert.deepEqual(s.drives.h.holes, [[108e6, 92e6, 6e6], [152e6, 92e6, 6e6], [152e6, 68e6, 6e6], [108e6, 68e6, 6e6]]);
  assert.equal(s.drives.h.pad, 6e6);
  // a flat face has no diameter of its own
  s = solve(k, engine, linkItem({ drives: { h: { kind: "holes", name: "h", order: "V", source: { kind: "faces", refs: bosses }, diameter: 0, pad: 0 } } }));
  assert.match(s.errors.h, /diameter/);
  // a bore gives its own
  s = solve(k, engine, linkItem({ drives: { h: { kind: "holes", name: "h", order: "V", source: { kind: "faces", refs: [faceRef("e3:side:b1")] }, diameter: 0, pad: 0 } } }));
  assert.deepEqual(s.drives.h.holes, [[108e6, 92e6, 6e6]]);
});

test("a keep-out under the rib: its polygon, its side, and the room left on a board that stands on the bosses", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate(tray(), 8);
  const link = linkItem({ plane: { kind: "face", ref: faceRef("e2:end:pa") }, lift: 5, drives: { k: { kind: "keepout", name: "Rib", order: "V", source: { kind: "faces", refs: [faceRef("e4:end:ka")] }, mode: "ceiling", maxHeight: 0, clearance: 0.5, side: "top" } } });
  const s = solve(k, engine, link);
  assert.deepEqual(s.errors, {});
  assert.deepEqual(s.frame.origin, [0, 0, 7]);                       // the floor (z = 2) plus 5
  const ko = s.drives.k;
  assert.equal(ko.side, "top"); assert.equal(ko.mode, "ceiling");
  near(ko.gap, 3, 1e-6);                                              // the rib's underside is at z = 10
  near(F.keepoutLimit(ko, 1.6), 0.9, 1e-6);                           // 3 − 1.6 − 0.5
  assert.equal(ko.loops.length, 1);
  const xs = ko.loops[0].filter((_, i) => i % 2 === 0), ys = ko.loops[0].filter((_, i) => i % 2 === 1);
  // the rib crosses the pocket: x 20…30; its underside is cut by the walls' tops? no: it spans the opening, y 2…38 at least
  assert.equal(Math.max(...xs) - Math.min(...xs), 10e6);
  assert.ok(Math.max(...ys) - Math.min(...ys) >= 36e6);
  // a sketch region with a fixed height on the back of the board
  const s2 = solve(k, engine, linkItem({ drives: { k: { kind: "keepout", name: "Conn", order: "V", source: { kind: "sketch", feature: "s4" }, mode: "height", maxHeight: 2, clearance: 0, side: "bottom" } } }));
  assert.equal(s2.drives.k.side, "bottom"); assert.equal(F.keepoutLimit(s2.drives.k, 1.6), 2);
  assert.equal(s2.drives.k.loops[0].length, 8);
});

test("the board follows the model: widen the tray and the outline and the holes move; lose a reference and the last answer stays", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate(tray(60), 8);
  const link = linkItem({ drives: {
    o: { kind: "outline", name: "o", order: "V", source: { kind: "faces", refs: [faceRef("e2:end:pa")] }, inset: 0.5, cutouts: false },
    h: { kind: "holes", name: "h", order: "W", source: { kind: "sketch", feature: "s3" }, diameter: 3.2, pad: 0 },
  } });
  const a = solve(k, engine, link);
  assert.deepEqual(bbox(a.drives.o.curves), [102.5e6, 62.5e6, 157.5e6, 97.5e6]);
  await engine.regenerate(tray(80), 8);
  const b = solve(k, engine, { ...link, solved: a });
  assert.deepEqual(b.errors, {});
  assert.deepEqual(bbox(b.drives.o.curves), [102.5e6, 62.5e6, 177.5e6, 97.5e6]);
  assert.deepEqual(b.drives.h.holes.map((h) => h[0]), [108e6, 172e6, 172e6, 108e6]);
  // the same model solves to the same answer: nothing to send
  assert.equal(D.stableJson(solve(k, engine, { ...link, solved: b })), D.stableJson(b));
  // roll back above the pocket: the floor is gone; the outline keeps its last geometry and says why
  await engine.regenerate(tray(80), 2);
  const c = solve(k, engine, { ...link, solved: b });
  assert.match(c.errors.o, /no longer exists/);
  assert.match(c.errors.h, /not built/);
  assert.deepEqual(c.drives.o, b.drives.o); assert.deepEqual(c.drives.h, b.drives.h);
  // a plane that is lost holds everything
  const d = solve(k, engine, { ...link, plane: { kind: "face", ref: faceRef("gone") }, solved: b });
  assert.ok(d.errors.plane); assert.deepEqual(d.drives, b.drives); assert.deepEqual(d.frame, b.frame);
});

test("the service takes link items and answers by link id", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate(tray(), 8);
  const svc = K.SERVICES.find((s) => s.name === "boardlink-solve");
  assert.ok(svc, "registered from services/");
  const out = k.withScope(() => svc.run(service(k, engine), { links: [linkItem({ drives: { o: { kind: "outline", name: "o", order: "V", source: { kind: "sketch", feature: "s1" }, inset: 0, cutouts: false } } }), { id: "x", type: "feature" }] }));
  assert.deepEqual(Object.keys(out), ["L"]);
  assert.equal(out.L.drives.o.curves.length, 4);
});
