// Node test for the board in CAD (web/domains/mechanical/board, features/board-*.ts, web/domains/pcb/exports):
// reading a board document into names that survive edits, following it change by change, building the Board
// feature's solids on the real OpenCascade kernel, and the features that hang off the board (Opening, Standoffs)
// following a moved connector and a moved mounting hole.  The demo board of server/seed is read too.
// Run: node server/static/tests/mechanical-board.test.js   (needs static/kicad-canvas.js, as the other board tests)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { load, server } = require("./cad-load");

require(path.join(__dirname, "..", "kicad-canvas.js"));
const C = globalThis.KiCadCanvas;
const G = load("domains/pcb/exports/board-geometry.ts");
const M = load("domains/mechanical/board/model.ts");
const P = load("domains/mechanical/board/placement.ts");
const K = load("domains/mechanical/kernel/index.ts");

let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new K.Kernel(oc);
  return kernel;
}
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);

// ---- a 60 × 40 board at (100, 50) with a rounded corner, a round cut-out, four mounting holes, a connector at
// the right edge, a tall part on the back, a low resistor, and two parts that share a designator
const HEAD = `(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.6))
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user) (31 "F.CrtYd" user) (29 "B.CrtYd" user) (35 "F.Fab" user) (36 "B.Fab" user))
 (net 0 "") (net 1 "GND")`;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const edge = (n, body) => `${body} (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "${uuid(n)}"))`;
const OUTLINE = [
  edge(1, `(gr_line (start 100 50) (end 155 50)`),
  edge(2, `(gr_arc (start 155 50) (mid 158.535534 51.464466) (end 160 55)`),
  edge(3, `(gr_line (start 160 55) (end 160 90)`),
  edge(4, `(gr_line (start 160 90) (end 100 90)`),
  edge(5, `(gr_line (start 100 90) (end 100 50)`),
  edge(6, `(gr_circle (center 130 70) (end 134 70)`),
].join("\n");
const hole = (n, ref, x, y) => `(footprint "MountingHole:MountingHole_3.2mm_M3" (layer "F.Cu") (uuid "${uuid(n)}") (at ${x} ${y})
  (property "Reference" "${ref}" (at 0 -4 0) (layer "F.SilkS") (uuid "${uuid(n + 500)}") (effects (font (size 1 1) (thickness 0.15))))
  (attr exclude_from_pos_files exclude_from_bom)
  (pad "" np_thru_hole circle (at 0 0) (size 3.2 3.2) (drill 3.2) (layers "*.Cu" "*.Mask") (uuid "${uuid(n + 700)}")))`;
const part = (n, ref, lib, at, layer, attr, w, h, pads) => {
  const s = layer === "B.Cu" ? "B" : "F";
  return `(footprint "${lib}" (layer "${layer}") (uuid "${uuid(n)}") (at ${at})
  (property "Reference" "${ref}" (at 0 -3 0) (layer "${s}.SilkS") (uuid "${uuid(n + 500)}") (effects (font (size 1 1) (thickness 0.15))))
  (attr ${attr})
  (fp_rect (start ${-w / 2} ${-h / 2}) (end ${w / 2} ${h / 2}) (stroke (width 0.05) (type default)) (fill no) (layer "${s}.CrtYd") (uuid "${uuid(n + 600)}"))
  ${pads})`;
};
const smd = (num, x, y, s = "F") => `(pad "${num}" smd rect (at ${x} ${y}) (size 1 1) (layers "${s}.Cu" "${s}.Mask") (net 1 "GND") (uuid "${uuid(9000 + Math.round(Math.abs(x * 97 + y * 13)) + Number(num))}"))`;
const tht = (num, x, y, d = 1) => `(pad "${num}" thru_hole circle (at ${x} ${y}) (size ${d + 0.8} ${d + 0.8}) (drill ${d}) (layers "*.Cu" "*.Mask") (net 1 "GND") (uuid "${uuid(8000 + Math.round(Math.abs(x * 97 + y * 13)) + Number(num))}"))`;
const BOARD = `${HEAD}
${OUTLINE}
${hole(11, "H1", 104, 54)}
${hole(12, "H2", 104, 86)}
${hole(13, "H3", 156, 86)}
${hole(14, "H4", 150, 54)}
${part(21, "J1", "Connector_USB:USB_C_Receptacle_Test", "155.5 70 90", "F.Cu", "smd", 9.5, 8, smd(1, -3, -3) + smd(2, 3, -3) + tht(3, -4.3, 1, 2.2) + tht(4, 4.3, 1, 2.2))}
${part(22, "J2", "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical", "112 70", "F.Cu", "through_hole", 3, 5.6, tht(1, 0, -1.27) + tht(2, 0, 1.27))}
${part(23, "U5", "Package_TO_SOT_SMD:Test_Back", "120 60", "B.Cu", "smd", 12, 12, smd(1, -2, 0, "B") + smd(2, 2, 0, "B"))}
${part(24, "R1", "Resistor_SMD:R_0603_1608Metric", "140 60", "F.Cu", "smd", 3, 1.6, smd(1, -0.8, 0) + smd(2, 0.8, 0))}
${part(25, "C?", "Capacitor_SMD:C_0603_1608Metric", "140 80", "F.Cu", "smd", 3, 1.6, smd(1, -0.8, 0) + smd(2, 0.8, 0))}
${part(26, "C?", "Capacitor_SMD:C_0603_1608Metric", "145 80", "F.Cu", "smd", 3, 1.6, smd(1, -0.8, 0) + smd(2, 0.8, 0))}
)`;

const OPTS = { origin: [130, 70], minHole: 1.5, minHeight: 1.5 };
const read = () => new M.BoardReader(G.parseBoard(BOARD));
const idOf = (reader, ref) => reader.components().find((c) => c.ref === ref).id;
/** Move a footprint as an editor would: change it there, send the change, apply it here. */
function moveRemote(reader, ref, x, y) {
  const far = G.parseBoard(BOARD);
  // bring the far copy to this reader's state for the item, then move it
  const id = idOf(reader, ref);
  const item = far.items.get(id);
  C.moveItem(far, item, x, y, 1e6);
  const change = C.replaceChange(far, item);
  const touched = G.applyBoardChanges(reader.doc, [change]);
  return { delta: reader.update(touched), change };
}

test("a board is read into an outline, holes and parts with names that mean something", () => {
  const r = read();
  assert.equal(r.thickness, 1.6);
  assert.deepEqual(r.centre(), [130, 70]);
  const s = r.snapshot(OPTS);
  assert.equal(s.fallback, false); assert.equal(s.open, 0); assert.equal(s.skippedHoles, 0);
  assert.equal(s.outlines.length, 1);
  // every piece of the outline is named after its Edge.Cuts graphic, in whatever order it was chained
  assert.deepEqual(s.outlines[0].outer.map((e) => e.n).sort(), [1, 2, 3, 4, 5].map(uuid));
  assert.deepEqual(s.outlines[0].outer.map((e) => e.k).sort(), ["a", "l", "l", "l", "l"]);
  assert.deepEqual(s.outlines[0].cuts.map((c) => c.map((e) => `${e.k}:${e.n}`)), [[`c:${uuid(6)}`]]);
  // the board's frame: x right, y up, about the origin given
  const top = s.outlines[0].outer.find((e) => e.n === uuid(1));
  assert.deepEqual([top.a, top.b].sort((p, q) => p[0] - q[0]), [[-30, 20], [25, 20]]);
  // holes are named by footprint and pad; the 1 mm header drills are below "Holes from"
  assert.deepEqual(s.holes.map((h) => h.n).sort(), ["H1", "H2", "H3", "H4", "J1:3", "J1:4"]);
  const h1 = s.holes.find((h) => h.n === "H1");
  assert.deepEqual([h1.x, h1.y, h1.d, h1.plated], [-26, 16, 3.2, false]);
  // parts tall enough to matter: the connector and the header on the front, U5 on the back; R1 and the capacitors are too low
  assert.deepEqual(s.parts.map((p) => `${p.n}:${p.back ? "back" : "front"}`).sort(), ["J1:front", "J2:front", "U5:back"]);
  // with everything asked for, parts that share a designator are told apart by their footprint's id
  const all = r.snapshot({ ...OPTS, minHole: 0, minHeight: 0 });
  assert.equal(all.holes.length, 8);
  assert.deepEqual(all.parts.map((p) => p.n).filter((n) => n.startsWith("C?")).sort(), [`C?~${uuid(25).slice(0, 8)}`, `C?~${uuid(26).slice(0, 8)}`].sort());
  assert.ok(all.parts.some((p) => p.n === "R1"));
});

test("a part's envelope is in its footprint's frame, so its sides keep their names when it turns", () => {
  const r = read();
  const j1 = r.snapshot(OPTS).parts.find((p) => p.n === "J1");
  // J1 is 9.5 × 8 (less the courtyard clearance), turned 90°: on the board it is 7.5 wide and 9 tall
  const xs = j1.pts.map((p) => p[0]), ys = j1.pts.map((p) => p[1]);
  near(Math.max(...xs) - Math.min(...xs), 7.5, 1e-3); near(Math.max(...ys) - Math.min(...ys), 9, 1e-3);
  // side i runs from corner i to corner i + 1 in the footprint's own order: SIDE_NAMES
  assert.deepEqual(Array.from(M.SIDE_NAMES), ["y-", "x+", "y+", "x-"]);
  const c = r.components().find((x) => x.ref === "J1");
  const back = (p) => M.toFootprint(c, [p[0] + 130, 70 - p[1]]).map((v) => Math.round(v * 1e3) / 1e3);
  assert.deepEqual(j1.pts.map(back), [[-4.5, -3.75], [4.5, -3.75], [4.5, 3.75], [-4.5, 3.75]]);
});

test("following the board: a change touches only what it changed, and names stay", () => {
  const r = read();
  const before = r.snapshot(OPTS);
  // a moved resistor is too low to be in the solids: the snapshot is the same, so nothing is rebuilt
  let { delta } = moveRemote(r, "R1", 141, 61);
  assert.deepEqual([delta.all, delta.outline, delta.holes, delta.artwork, Array.from(delta.components)], [false, false, false, true, [idOf(r, "R1")]]);
  assert.deepEqual([delta.front, delta.back], [true, false], "a surface-mount part on the front leaves the back face's image alone");
  assert.deepEqual(r.snapshot(OPTS), before);
  // a moved mounting hole: the hole keeps its name and is somewhere else
  ({ delta } = moveRemote(r, "H3", 152, 84));
  assert.equal(delta.holes, true); assert.equal(delta.outline, false);
  assert.deepEqual([delta.front, delta.back], [true, true], "a drill is on both faces");
  const s = r.snapshot(OPTS);
  assert.deepEqual(s.holes.map((h) => h.n).sort(), before.holes.map((h) => h.n).sort());
  const h3 = s.holes.find((h) => h.n === "H3");
  assert.deepEqual([h3.x, h3.y], [22, -14]);
  // a moved connector: its envelope and its two drills move, everything else is as it was
  ({ delta } = moveRemote(r, "J1", 155.5, 62));
  assert.deepEqual(Array.from(delta.components), [idOf(r, "J1")]);
  const s2 = r.snapshot(OPTS);
  const y = (snap) => snap.parts.find((p) => p.n === "J1").pts.reduce((a, p) => a + p[1], 0) / 4;
  near(y(s2) - y(s), 8, 1e-6);
  assert.deepEqual(s2.parts.filter((p) => p.n !== "J1"), s.parts.filter((p) => p.n !== "J1"));
  // an outline edit is seen as one
  const far = G.parseBoard(BOARD), line = far.items.get(uuid(4));
  C.moveItem(far, line, (line.x || 0), (line.y || 0) + 0, 1e6);
  const rm = { id: uuid(6), kind: "REMOVED" };
  delta = r.update(G.applyBoardChanges(r.doc, [rm]));
  assert.equal(delta.outline, true);
  assert.equal(r.snapshot(OPTS).outlines[0].cuts.length, 0);
});

test("an outline that does not close falls back to a box, and a hole that breaks the edge is left out", () => {
  const open = G.parseBoard(BOARD.replace(/\(gr_line \(start 100 90\) \(end 100 50\)[^\n]*\n/, "").replace(/\(gr_circle[^\n]*\n/, ""));
  const s = new M.BoardReader(open).snapshot(OPTS);
  assert.equal(s.fallback, true);
  assert.equal(s.outlines[0].outer.length, 4);
  const edgy = G.parseBoard(BOARD.replace('(at 104 54)', '(at 100.5 54)'));
  const s2 = new M.BoardReader(edgy).snapshot(OPTS);
  assert.equal(s2.skippedHoles, 1);
  assert.ok(!s2.holes.some((h) => h.n === "H1"));
});

test("where the board lies: its frame on a plane, turned, lifted and flipped", () => {
  const top = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
  const f = P.boardFrame(top, { x: 10, y: 5, z: 3, angle: 90, flip: false }, 1.6);
  assert.deepEqual(f.origin, [10, 5, 3]);
  assert.deepEqual(f.x.map((v) => Math.round(v * 1e9) / 1e9 + 0), [0, 1, 0]);
  assert.deepEqual(f.y.map((v) => Math.round(v * 1e9) / 1e9 + 0), [-1, 0, 0]);
  assert.deepEqual(f.normal, [0, 0, 1]);
  // flipped: the front face lies on the plane, the back face is one thickness up, and the frame is still right-handed
  const g = P.boardFrame(top, { x: 0, y: 0, z: 0, angle: 0, flip: true }, 1.6);
  assert.deepEqual(g.origin, [0, 0, 1.6]);
  assert.deepEqual(g.normal.map((v) => Math.round(v * 1e9) / 1e9 + 0), [0, 0, -1]);
  assert.deepEqual(g.y.map((v) => Math.round(v * 1e9) / 1e9 + 0), [0, -1, 0]);
});

// ---------------------------------------------------------------- the kernel
const boardFeature = (snapshot, o = {}) => ({ id: "b1", type: "board-reference", name: "Board 1", suppressed: false, params: { board: "doc-1", plane: { kind: "plane", plane: "top" }, x: 0, y: 0, z: 0, angle: 0, flip: false, origin: [130, 70], minHole: 1.5, minHeight: 1.5, $board: snapshot, ...o } });
const rect = (x0, y0, x1, y1, p) => ({
  [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y0 }, [`${p}3`]: { type: "point", x: x1, y: y1 }, [`${p}4`]: { type: "point", x: x0, y: y1 },
  [`${p}a`]: { type: "line", a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: "line", a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: "line", a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: "line", a: `${p}4`, b: `${p}1` },
});
// an enclosure around the board: a ring of wall, 2 mm thick, 1 mm clear of the board, from 6 below it to 12 above
const wall = () => [
  { id: "s1", type: "sketch", name: "s1", suppressed: false, params: { plane: { kind: "plane", plane: "top" }, sketch: { version: 1, entities: { ...rect(-33, -23, 33, 23, "o"), ...rect(-31, -21, 31, 21, "i") }, constraints: {} } } },
  { id: "e1", type: "extrude", name: "e1", suppressed: false, params: { profile: { sketch: "s1", regions: null }, operation: "new", endType: "blind", depth: 12, flip: false, targets: [] } },
];
const opening = (o = {}) => ({ id: "c1", type: "board-cutout", name: "Opening 1", suppressed: false, params: { face: { kind: "face", body: "b1:parts", name: "b1:part:J1:y+" }, clearance: 0.5, depth: 6, back: 0, targets: [], ...o } });
const standoffs = (o = {}) => ({ id: "p1", type: "board-standoffs", name: "Standoffs 1", suppressed: false, params: { holes: ["H1", "H2", "H3", "H4"].map((h) => ({ kind: "face", body: "b1:board", name: `b1:hole:${h}` })), height: 5, diameter: 6, bore: 2.5, operation: "new", ...o } });
const bodyOf = (engine, id) => engine.state.bodies.find((b) => b.id === id);
function bbox(k, shape) {
  const oc = k.oc, box = new oc.Bnd_Box();
  oc.BRepBndLib.Add(shape, box, false);
  const a = box.CornerMin(), b = box.CornerMax(), out = [a.X(), a.Y(), a.Z(), b.X(), b.Y(), b.Z()].map((v) => Math.round(v * 1e3) / 1e3 + 0);
  a.delete(); b.delete(); box.delete();
  return out;
}

test("the Board feature builds the laminate with its holes and an envelope per part, all named", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const snap = read().snapshot(OPTS);
  const r = await engine.regenerate([boardFeature(snap)], 1);
  assert.deepEqual(r.features.map((f) => [f.status, f.message]), [["ok", undefined]]);
  assert.deepEqual(r.bodies.map((b) => [b.id, b.name]), [["b1:board", "Board 1"], ["b1:parts", "Board 1 parts"]]);
  const board = bodyOf(engine, "b1:board"), parts = bodyOf(engine, "b1:parts");
  assert.equal(board.reference, true); assert.equal(parts.reference, true);
  // 60 × 40 less the corner outside the arc, the cut-out, four M3 holes and J1's two drills, 1.6 thick
  const area = 60 * 40 - (25 - Math.PI * 25 / 4) - Math.PI * 16 - 4 * Math.PI * 1.6 * 1.6 - 2 * Math.PI * 1.1 * 1.1;
  near(k.volume(board.shape), area * 1.6, 1e-6);
  const names = board.topo.faces.map((f) => f.name).sort();
  assert.deepEqual(names, ["b1:back", "b1:front", ...[1, 2, 3, 4, 5, 6].map((n) => `b1:edge:${uuid(n)}`), "b1:hole:H1", "b1:hole:H2", "b1:hole:H3", "b1:hole:H4", "b1:hole:J1:3", "b1:hole:J1:4"].sort());
  // the back face lies on the plane, the front is one thickness up; parts stand on their own side
  assert.deepEqual(bbox(k, board.shape), [-30, -20, 0, 30, 20, 1.6]);
  const pn = parts.topo.faces.map((f) => f.name).sort();
  for (const p of ["J1", "J2", "U5"]) for (const s of ["base", "top", "x+", "x-", "y+", "y-"]) assert.ok(pn.includes(`b1:part:${p}:${s}`), `${p}:${s}`);
  assert.equal(pn.length, 18);
  const zs = bbox(k, parts.shape);
  assert.ok(zs[2] < 0 && zs[5] > 1.6, "U5 hangs below the board, the connectors stand above it");
  assert.equal(new Set(board.topo.edges.map((e) => e.name)).size, board.topo.edges.length, "edge names are unique");
  // without the board (the page has not read it yet) the feature says so
  const waiting = await engine.regenerate([boardFeature(undefined)], 1);
  assert.equal(waiting.features[0].status, "error"); assert.match(waiting.features[0].message, /not been read yet/);
});

test("placement: on another plane, turned, lifted, and parts side down", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const snap = read().snapshot(OPTS);
  await engine.regenerate([boardFeature(snap, { z: 6, angle: 90 })], 1);
  assert.deepEqual(bbox(k, bodyOf(engine, "b1:board").shape), [-20, -30, 6, 20, 30, 7.6]);
  await engine.regenerate([boardFeature(snap, { plane: { kind: "plane", plane: "front" }, y: 10 })], 1);
  assert.deepEqual(bbox(k, bodyOf(engine, "b1:board").shape), [-30, -1.6, -10, 30, 0, 30]);
  await engine.regenerate([boardFeature(snap, { flip: true })], 1);
  const board = bodyOf(engine, "b1:board");
  assert.deepEqual(bbox(k, board.shape), [-30, -20, 0, 30, 20, 1.6]);
  const front = k.faceFrame(board.topo.faces.find((f) => f.name === "b1:front").shape);
  assert.deepEqual(front.normal.map((v) => Math.round(v) + 0), [0, 0, -1], "the front face looks down");
  near(k.volume(board.shape), k.volume(board.shape));
});

test("a board on a face of the model: the worker says where it put it", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const snap = read().snapshot(OPTS);
  // a block 10 tall; the board lies on its top face, lifted 2
  const block = [
    { id: "s7", type: "sketch", name: "s7", suppressed: false, params: { plane: { kind: "plane", plane: "top" }, sketch: { version: 1, entities: rect(-40, -30, 40, 30, "q"), constraints: {} } } },
    { id: "e7", type: "extrude", name: "e7", suppressed: false, params: { profile: { sketch: "s7", regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [] } },
  ];
  const r = await engine.regenerate([...block, boardFeature(snap, { plane: { kind: "face", ref: { kind: "face", body: "e7", name: "e7:end:qa" } }, z: 2 })], 3);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok", "ok"]);
  const box = bbox(k, bodyOf(engine, "b1:board").shape);
  assert.deepEqual([box[2], box[5]], [12, 13.6]);
  const service = K.SERVICES.find((s) => s.name === "board-placement");
  const placed = service.run({ oc: k.oc, k, state: engine.state, fail: (m) => new Error(m) }, {});
  assert.deepEqual(Object.keys(placed), ["b1"]);
  assert.equal(placed.b1.thickness, 1.6);
  assert.deepEqual(placed.b1.frame.normal.map((v) => Math.round(v) + 0), [0, 0, 1]);
  near(placed.b1.frame.origin[2], 12);
});

test("reference bodies are left alone by features that act on every body", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const snap = read().snapshot(OPTS);
  // a block that overlaps the board, added to "every body"
  const block = [
    { id: "s9", type: "sketch", name: "s9", suppressed: false, params: { plane: { kind: "plane", plane: "top" }, sketch: { version: 1, entities: rect(-5, -5, 5, 5, "q"), constraints: {} } } },
    { id: "e9", type: "extrude", name: "e9", suppressed: false, params: { profile: { sketch: "s9", regions: null }, operation: "add", endType: "blind", depth: 5, flip: false, targets: [] } },
    { id: "e8", type: "extrude", name: "e8", suppressed: false, params: { profile: { sketch: "s9", regions: null }, operation: "remove", endType: "blind", depth: 1, flip: false, targets: [] } },
  ];
  const r = await engine.regenerate([boardFeature(snap), ...block], 4);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok", "ok", "ok"]);
  assert.deepEqual(r.bodies.map((b) => b.id), ["b1:board", "b1:parts", "e9"]);
  const area = 60 * 40 - (25 - Math.PI * 25 / 4) - Math.PI * 16 - 4 * Math.PI * 1.6 * 1.6 - 2 * Math.PI * 1.1 * 1.1;
  near(k.volume(bodyOf(engine, "b1:board").shape), area * 1.6, 1e-6);
  near(k.volume(bodyOf(engine, "e9").shape), 100 * 4, 1e-6);
});

test("an opening in the enclosure wall follows the connector when it is moved on the board", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const reader = read();
  const list = (snap) => [boardFeature(snap, { z: 4 }), ...wall(), opening()];
  let r = await engine.regenerate(list(reader.snapshot(OPTS)), 4);
  assert.deepEqual(r.features.map((f) => [f.status, f.message]), [["ok", undefined], ["ok", undefined], ["ok", undefined], ["ok", undefined]]);
  const wallVolume = (66 * 46 - 62 * 42) * 12;
  // J1's face that looks out of the board is 9 wide and 3.5 tall (its height); with 0.5 clearance the cut is 10 × 4.5 through 2 of wall
  const j1 = reader.snapshot(OPTS).parts.find((p) => p.n === "J1");
  const cut = (9 + 1) * (j1.h + 1) * 2;
  near(k.volume(bodyOf(engine, "e1").shape), wallVolume - cut, 1e-6);
  const holeBox = (engine) => {
    const faces = bodyOf(engine, "e1").topo.faces.filter((f) => f.name.startsWith("c1:side:"));
    assert.equal(faces.length, 4, "the opening leaves four named walls in the enclosure");
    const ys = [], zs = [];
    for (const f of faces) for (const v of k.sub(f.shape, "vertex")) { const p = k.vertexPoint(v); ys.push(p[1]); zs.push(p[2]); }
    return [Math.min(...ys), Math.max(...ys), Math.min(...zs), Math.max(...zs)].map((v) => Math.round(v * 1e3) / 1e3);
  };
  // the opening is centred on the connector (board y = 0), and sits on the board's front face (4 + 1.6) less the clearance
  assert.deepEqual(holeBox(engine), [-5, 5, 5.1, Math.round((5.6 + j1.h + 0.5) * 1e3) / 1e3]);
  const namesBefore = bodyOf(engine, "e1").topo.faces.map((f) => f.name).sort();

  // somebody drags the connector 8 mm along the edge in the board editor
  moveRemote(reader, "J1", 155.5, 62);
  r = await engine.regenerate(list(reader.snapshot(OPTS)), 4);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok", "ok", "ok"]);
  assert.equal(r.rebuiltFrom, 0);
  assert.deepEqual(holeBox(engine), [3, 13, 5.1, Math.round((5.6 + j1.h + 0.5) * 1e3) / 1e3]);
  near(k.volume(bodyOf(engine, "e1").shape), wallVolume - cut, 1e-6);
  assert.deepEqual(bodyOf(engine, "e1").topo.faces.map((f) => f.name).sort(), namesBefore, "every face of the enclosure keeps its name");

  // an edit that changes nothing the features use rebuilds nothing
  moveRemote(reader, "R1", 139, 61);
  r = await engine.regenerate(list(reader.snapshot(OPTS)), 4);
  assert.equal(r.rebuiltFrom, 4);
  assert.ok(r.features.every((f) => f.cached));
});

test("standoffs sit under the mounting holes and follow a hole that is moved", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const reader = read();
  const list = (snap) => [boardFeature(snap, { z: 5 }), standoffs()];
  let r = await engine.regenerate(list(reader.snapshot(OPTS)), 2);
  assert.deepEqual(r.features.map((f) => [f.status, f.message]), [["ok", undefined], ["ok", undefined]]);
  const posts = () => engine.state.bodies.filter((b) => b.createdBy === "p1");
  assert.equal(posts().length, 4);
  for (const p of posts()) near(k.volume(p.shape), Math.PI * (9 - 1.5625) * 5, 1e-6);
  const h3 = () => bbox(k, bodyOf(engine, "p1:b1:hole:H3").shape);
  // H3 is at (26, -16) on the board; its post reaches from the plane up to the board's back face at 5
  assert.deepEqual(h3(), [23, -19, 0, 29, -13, 5]);
  assert.deepEqual(bodyOf(engine, "p1:b1:hole:H3").topo.faces.map((f) => f.name).sort(), ["bore", "foot", "side", "top"].map((s) => `p1:post(b1:hole:H3):${s}`));
  moveRemote(reader, "H3", 152, 84);
  r = await engine.regenerate(list(reader.snapshot(OPTS)), 2);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok"]);
  assert.deepEqual(h3(), [19, -17, 0, 25, -11, 5]);
  // a hole that is deleted from the board is a reference that no longer exists
  const id = idOf(reader, "H4");
  reader.update(G.applyBoardChanges(reader.doc, [{ id, kind: "REMOVED" }]));
  r = await engine.regenerate(list(reader.snapshot(OPTS)), 2);
  assert.equal(r.features[1].status, "error"); assert.match(r.features[1].message, /no longer exists/);
});

// ---------------------------------------------------------------- the demo board of server/seed
function demoBoard() {
  const zip = fs.readFileSync(path.join(server, "seed", "devboard-demo.zip"));
  // the one entry wanted, straight from the central directory (no unzip dependency)
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < zip.readUInt16LE(eocd + 10); i++) {
    const nameLen = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLen);
    if (name.endsWith(".kicad_pcb")) {
      const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20), local = zip.readUInt32LE(at + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return (method === 0 ? data : zlib.inflateRawSync(data)).toString("utf8");
    }
    at += 46 + nameLen + extra + comment;
  }
  throw new Error("the seed has no board");
}

test("the demo board: read, built on the kernel, and followed", async () => {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const t0 = Date.now();
  const reader = new M.BoardReader(G.parseBoard(demoBoard()));
  const tRead = Date.now() - t0;
  assert.ok(reader.components().length >= 60, `${reader.components().length} footprints`);
  const opts = { origin: reader.centre(), minHole: 0.9, minHeight: 1.5 };
  const snap = reader.snapshot(opts);
  assert.equal(snap.fallback, false);
  assert.ok(snap.parts.some((p) => p.n === "USB1"), "the USB connector has an envelope");
  assert.ok(snap.holes.some((h) => h.n === "J1:1"), "the header's drills are named by pad");
  let r = await engine.regenerate([boardFeature(snap, { origin: opts.origin })], 1);
  assert.deepEqual(r.features.map((f) => f.status), ["ok"]);
  const first = r.ms;
  const board = bodyOf(engine, "b1:board");
  assert.ok(board.topo.faces.some((f) => f.name === "b1:hole:J1:1"));
  // one footprint moved: the reader looks at one item
  const usb = reader.components().find((c) => c.ref === "USB1");
  const item = reader.doc.items.get(usb.id);
  const t1 = process.hrtime.bigint();
  C.moveItem(reader.doc, item, usb.x, usb.y - 3, 1e6);
  const delta = reader.update([usb.id]);
  const snap2 = reader.snapshot(opts);
  const tUpdate = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.deepEqual(Array.from(delta.components), [usb.id]);
  assert.notDeepEqual(snap2.parts.find((p) => p.n === "USB1"), snap.parts.find((p) => p.n === "USB1"));
  r = await engine.regenerate([boardFeature(snap2, { origin: opts.origin })], 1);
  assert.deepEqual(r.features.map((f) => f.status), ["ok"]);
  console.log(`  demo board: ${reader.components().length} footprints, ${snap.holes.length} holes and ${snap.parts.length} envelopes in the solid; read ${tRead} ms, one moved footprint ${tUpdate.toFixed(2)} ms to re-read, feature rebuild ${first} ms then ${r.ms} ms`);
});
