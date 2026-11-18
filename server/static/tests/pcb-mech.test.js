// Node test for the board link, board side (web/domains/pcb/mech): the KiCad items a link asks for, the
// reconciler run against a real board document (static/kicad-canvas.js), and the enclosure height check.
// Run: node server/static/tests/pcb-mech.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { load } = require("./cad-load");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;

const B = load("domains/pcb/mech/boarditems.ts");
const C = load("domains/pcb/mech/check.ts");
const F = load("domains/mechanical/boardlink/format.ts");
const I = load("domains/mechanical/boardlink/ids.ts");

const HEAD = `(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.6))
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (25 "Edge.Cuts" user) (31 "F.CrtYd" user) (35 "F.Fab" user))
 (net 0 "")`;
const boardDoc = (items = "") => K.parseDoc(`${HEAD}\n${items})`);

const TOP = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
const drive = (kind, o = {}) => ({ ...F.defaultDrive(kind, { kind: "sketch", feature: "s" }, F.DRIVE_TITLES[kind], "V"), ...o });
const rectCurves = (x0, y0, x1, y1) => [["l", x0, y0, x1, y0], ["l", x1, y0, x1, y1], ["l", x1, y1, x0, y1], ["l", x0, y1, x0, y0]].map((c) => c.map((v) => (typeof v === "number" ? v * 1e6 : v)));
function link(o = {}) {
  return F.readLink({
    id: "L", type: "board-link", board: "pcb", plane: { kind: "plane", plane: "top" }, lift: 0, anchor: [100, 100], rotation: 0,
    drives: { o: drive("outline", { order: "A" }), h: drive("holes", { order: "B" }), k: drive("keepout", { order: "C", name: "Lid rib", mode: "height", maxHeight: 4 }) },
    solved: { v: 1, frame: TOP, errors: {}, drives: {
      o: { kind: "outline", curves: rectCurves(100, 60, 160, 100) },
      h: { kind: "holes", holes: [[108e6, 68e6, 3.2e6], [152e6, 92e6, 3.2e6]], pad: 0 },
      k: { kind: "keepout", loops: [[120e6, 60e6, 130e6, 60e6, 130e6, 100e6, 120e6, 100e6]], side: "top", mode: "height", max: 4, gap: 0, clearance: 0 },
    } },
    ...o,
  });
}
const src = (l = link()) => [{ link: l, studio: "Enclosure", studioDoc: "studio-doc" }];

/** The reconciler's view of a canvas document, as mech/sync.ts builds it. */
function view(doc) {
  const TYPE = { footprint: "FOOTPRINT", zone: "ZONE", group: "PCB_GROUP" };
  return {
    *driven() { for (const it of doc.items.values()) if (I.isDrivenId(it.id)) yield { id: it.id, kind: it.kind, typeName: TYPE[it.kind] || "PCB_SHAPE", sexpr: K.serialize(it.node), members: it.kind === "group" ? K.groupMemberIds(it.node) : undefined }; },
    normalise: (s) => JSON.stringify(K.parse(s)),
    wrap: (s) => K.wrapFragment(doc, s),
    unlocked: (s) => { const n = K.parse(s); for (let i = n.length - 1; i > 0; i--) if (n[i] === "locked" || (Array.isArray(n[i]) && n[i][0] === "locked")) n.splice(i, 1); return K.serialize(n); },
  };
}
function apply(doc, r) { for (const c of r.changes) assert.ok(K.applyChange(doc, c, 1e6), `the board takes ${c.kind} ${c.typeName} ${c.id}`); K.computeBBox(doc); }
const run = (doc, sources, complete = true) => { const want = B.desiredItems(sources, doc.thickness || 1.6); const r = B.reconcile(want, view(doc), B.liveGroups(sources), complete); apply(doc, r); return r; };
const kinds = (doc) => { const n = {}; for (const it of doc.items.values()) if (I.isDrivenId(it.id)) n[it.kind] = (n[it.kind] || 0) + 1; return n; };
const locked = (it) => { const l = K.kid(it.node, "locked"); return l ? K.str(l[1]) !== "no" : it.node.includes("locked"); };

test("nanometres are written as the millimetres a board file holds", () => {
  assert.equal(B.mm(12500000), "12.5"); assert.equal(B.mm(0), "0"); assert.equal(B.mm(-0), "0");
  assert.equal(B.mm(1), "0.000001"); assert.equal(B.mm(-102345678), "-102.345678"); assert.equal(B.mm(3000000), "3");
});

test("what a link asks for: Edge.Cuts shapes, hole footprints, a rule area, and a group per drive, all locked and with driven ids", () => {
  const items = B.desiredItems(src(), 1.6);
  assert.deepEqual(items.map((i) => i.kind), ["gr_line", "gr_line", "gr_line", "gr_line", "group", "footprint", "footprint", "group", "zone", "group"]);
  assert.ok(items.every((i) => I.isDrivenId(i.id)));
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  for (const i of items) { const n = K.parse(i.sexpr); assert.equal(n[0], i.kind); assert.equal(K.str(K.kid(n, "uuid")[1]), i.id); assert.ok(K.kid(n, "locked"), `${i.kind} is locked`); }
  const line = K.parse(items[0].sexpr);
  assert.deepEqual([K.kid(line, "start").slice(1), K.kid(line, "end").slice(1), K.str(K.kid(line, "layer")[1])], [[100, 60], [160, 60], "Edge.Cuts"]);
  const fp = K.parse(items[5].sexpr), pad = K.kid(fp, "pad");
  assert.deepEqual(K.kid(fp, "at").slice(1), [108, 68]);
  assert.equal(K.str(pad[2]), "np_thru_hole"); assert.deepEqual(K.kid(pad, "drill").slice(1), [3.2]);
  assert.ok(K.kid(fp, "attr").includes("board_only"));
  const zone = K.parse(items[8].sexpr);
  assert.equal(K.str(K.kid(zone, "name")[1]), "Height ≤ 4 mm: Lid rib");
  assert.equal(K.str(K.kid(K.kid(zone, "keepout"), "footprints")[1]), "allowed");
  assert.equal(K.kids(K.kid(K.kid(zone, "polygon"), "pts"), "xy").length, 4);
  const group = K.parse(items[4].sexpr);
  assert.equal(K.str(group[1]), "Board outline (driven by Enclosure)");
  assert.deepEqual(K.kid(group, "members").slice(1).map(K.str), items.slice(0, 4).map((i) => i.id).sort());
  // the same link gives the same items: two browsers write the same board
  assert.deepEqual(B.desiredItems(src(), 1.6), items);
});

test("arcs keep the board file's winding, circles their radius, plated holes their pad, and a no-go area forbids footprints", () => {
  const l = link({ solved: { v: 1, frame: TOP, errors: {}, drives: {
    o: { kind: "outline", curves: [["a", 10e6, 0, 2928932, 2928932, 0, 10e6], ["a", 0, 10e6, 2928932, 2928932, 10e6, 0], ["c", 50e6, 50e6, 5e6]] },
    h: { kind: "holes", holes: [[0, 0, 3e6]], pad: 6e6 },
    k: { kind: "keepout", loops: [[0, 0, 1e6, 0, 1e6, 1e6]], side: "bottom", mode: "none", max: 0, gap: 0, clearance: 0 },
  } } });
  const items = B.desiredItems(src(l), 1.6);
  const [a1, a2, circle] = items.slice(0, 3).map((i) => K.parse(i.sexpr));
  // the same arc given both ways round is written once
  assert.deepEqual(K.kid(a1, "start").slice(1), K.kid(a2, "start").slice(1));
  assert.deepEqual(K.kid(a1, "end").slice(1), K.kid(a2, "end").slice(1));
  assert.deepEqual([K.kid(circle, "center").slice(1), K.kid(circle, "end").slice(1)], [[50, 50], [55, 50]]);
  const pad = K.kid(K.parse(items.find((i) => i.kind === "footprint").sexpr), "pad");
  assert.equal(K.str(pad[2]), "thru_hole"); assert.deepEqual(K.kid(pad, "size").slice(1), [6, 6]); assert.deepEqual(K.kid(pad, "drill").slice(1), [3]);
  const zone = K.parse(items.find((i) => i.kind === "zone").sexpr);
  assert.equal(K.str(K.kid(zone, "layer")[1]), "B.Cu");
  assert.equal(K.str(K.kid(K.kid(zone, "keepout"), "footprints")[1]), "not_allowed");
  assert.equal(K.str(K.kid(zone, "name")[1]), "No components: Lid rib");
});

test("a keep-out under a face names the room left on this board's thickness", () => {
  const k = { kind: "keepout", loops: [[0, 0, 1e6, 0, 1e6, 1e6]], side: "top", mode: "ceiling", max: 0, gap: 6, clearance: 0.5 };
  assert.equal(B.keepoutName("Lid", k, 1.6), "Height ≤ 3.9 mm: Lid");
  assert.equal(B.keepoutName("Lid", k, 0.8), "Height ≤ 4.7 mm: Lid");
  assert.equal(B.keepoutName("Lid", { ...k, gap: 2 }, 1.6), "No components: Lid");
});

test("reconcile on an empty board adds everything; a second pass has nothing to do", () => {
  const doc = boardDoc();
  const r = run(doc, src());
  assert.deepEqual([r.added, r.modified, r.removed, r.released.length], [10, 0, 0, 0]);
  assert.deepEqual(kinds(doc), { gr_line: 4, footprint: 2, zone: 1, group: 3 });
  for (const it of doc.items.values()) if (I.isDrivenId(it.id)) assert.ok(locked(it), `${it.kind} is locked on the board`);
  // what the canvas made of the items compares equal to what was asked: no write loop
  assert.equal(run(doc, src()).changes.length, 0);
  // the outline is a closed board outline to the board's own geometry
  const edges = Array.from(doc.items.values()).filter((it) => it.kind === "gr_line");
  assert.deepEqual(edges.map((e) => e.bbox && e.bbox.map((v) => Math.round(v))).sort()[0].length, 4);
});

test("the board follows the model: a moved outline is modified in place, a deleted hole is removed, a new one added", () => {
  const doc = boardDoc();
  run(doc, src());
  const ids = (kind) => Array.from(doc.items.values()).filter((it) => I.isDrivenId(it.id) && it.kind === kind).map((it) => it.id).sort();
  const before = ids("gr_line");
  // the tray got 20 mm wider: two of the four edges move, a third stretches
  const wider = link(); wider.solved.drives.o = { kind: "outline", curves: rectCurves(100, 60, 180, 100) };
  let r = run(doc, src(wider));
  assert.deepEqual([r.added, r.modified, r.removed], [0, 3, 0]);
  assert.deepEqual(ids("gr_line"), before, "the same items, moved");
  // one hole fewer
  const fewer = link(); fewer.solved.drives.o = wider.solved.drives.o; fewer.solved.drives.h = { kind: "holes", holes: [[108e6, 68e6, 3.2e6]], pad: 0 };
  r = run(doc, src(fewer));
  assert.deepEqual([r.added, r.modified, r.removed], [0, 1, 1]);   // the hole goes, its group loses a member
  assert.equal(kinds(doc).footprint, 1);
  // and three
  const more = link(); more.solved.drives.o = wider.solved.drives.o; more.solved.drives.h = { kind: "holes", holes: [[108e6, 68e6, 3.2e6], [1e6, 1e6, 3.2e6], [2e6, 2e6, 3.2e6]], pad: 0 };
  r = run(doc, src(more));
  assert.deepEqual([r.added, r.modified, r.removed], [2, 1, 0]);
  assert.equal(run(doc, src(more)).changes.length, 0);
});

test("somebody edits a driven item on the board: the next pass puts it back", () => {
  const doc = boardDoc();
  run(doc, src());
  const edge = Array.from(doc.items.values()).find((it) => it.kind === "gr_line" && I.isDrivenId(it.id));
  K.kid(edge.node, "end")[1] = 999;
  const r = run(doc, src());
  assert.deepEqual([r.added, r.modified, r.removed], [0, 1, 0]);
  assert.equal(r.changes[0].id, edge.id);
  // deleted outright: added again
  doc.items.delete(edge.id);
  assert.deepEqual(run(doc, src()).added, 1);
});

test("breaking a link releases what it made: the items stay, unlocked, and their group goes", () => {
  const doc = boardDoc();
  run(doc, src());
  const broken = link(); delete broken.drives.o; delete broken.solved.drives.o;
  // until every part studio has been read nothing is judged to have lost its link
  assert.equal(run(doc, src(broken), false).changes.length, 0);
  const r = run(doc, src(broken), true);
  assert.equal(r.released.length, 5);                       // four edges and their group
  assert.deepEqual([r.added, r.modified, r.removed], [0, 0, 0]);
  const edges = Array.from(doc.items.values()).filter((it) => it.kind === "gr_line");
  assert.equal(edges.length, 4);
  assert.ok(edges.every((e) => !locked(e)), "the outline is the board's own again");
  assert.deepEqual(kinds(doc), { gr_line: 4, footprint: 2, zone: 1, group: 2 });
  assert.equal(run(doc, src(broken), true).changes.length, 0);
  // the whole link gone (the part studio was unlinked): everything is released, nothing is deleted
  const all = run(doc, [], true);
  assert.equal(all.removed, 0);
  assert.deepEqual(kinds(doc), { gr_line: 4, footprint: 2, zone: 1 });
  assert.ok(Array.from(doc.items.values()).filter((it) => I.isDrivenId(it.id)).every((it) => !locked(it)));
  assert.equal(run(doc, [], true).changes.length, 0);
});

test("a drive whose model reference is lost keeps its last geometry on the board", () => {
  const doc = boardDoc();
  run(doc, src());
  const stale = link(); stale.solved.errors = { o: "A face this was taken from no longer exists." };
  assert.equal(run(doc, src(stale)).changes.length, 0);
});

// ---------------------------------------------------------------- the height check
const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const part = (ref, x, y, height, o = {}) => ({ id: "fp-" + ref, ref, back: false, pts: sq(x, y, 2), height, source: "estimate", ...o });

test("the keep-outs of a board come from its links, with the limit a board of that thickness leaves", () => {
  const l = link();
  l.drives.c = drive("keepout", { name: "Lid", mode: "ceiling", clearance: 0.5 });
  l.solved.drives.c = { kind: "keepout", loops: [[0, 0, 10e6, 0, 10e6, 10e6, 0, 10e6]], side: "top", mode: "ceiling", max: 0, gap: 8, clearance: 0.5 };
  const areas = C.keepoutAreas(src(l), 1.6, (a, b, n) => I.drivenId(a, b, "keepout", n));
  assert.deepEqual(areas.map((a) => [a.name, a.side, Math.round(a.limit * 100) / 100, a.loop.length]), [["Lid rib", "top", 4, 4], ["Lid", "top", 5.9, 4]]);
  assert.equal(areas[0].zone, I.drivenId("L", "k", "keepout", 0));
  assert.deepEqual(areas[0].loop[0], [120, 60]);
});

test("a tall component in a keep-out clashes; a short one, one beside it, or one on the other side does not", () => {
  const areas = C.keepoutAreas(src(), 1.6, () => "zone");
  const parts = [part("C1", 124, 70, 6.5), part("R1", 124, 80, 0.5), part("C2", 140, 70, 9), part("U1", 119, 90, 4.4), part("C3", 124, 64, 9, { back: true }), part("J1", 126, 62, 12, { source: "field" })];
  const clashes = C.heightClashes(parts, areas);
  assert.deepEqual(clashes.map((c) => c.ref), ["J1", "C1", "U1"]);     // worst first; U1 straddles the edge
  assert.equal(clashes[0].over, 8); assert.equal(clashes[0].limit, 4);
  assert.equal(C.clashText(clashes[0]), "J1 is 12 mm tall: “Lid rib” allows 4 mm (8 mm over)");
  assert.match(C.clashText(clashes[1]), /C1 is 6.5 mm tall \(estimated\)/);
  // the room over a part that fits
  assert.deepEqual(C.headroom(parts[1], areas).map((r) => r.room), [3.5]);
  assert.deepEqual(C.headroom(parts[2], areas), []);
  // a no-go area takes anything
  const none = [{ ...areas[0], limit: 0 }];
  assert.equal(C.heightClashes([part("R9", 124, 80, 0.3)], none).length, 1);
  assert.match(C.clashText(C.heightClashes([part("R9", 124, 80, 0.3)], none)[0]), /no components may stand/);
});

test("polygons overlap when they cross, or one holds the other", () => {
  assert.ok(C.polysOverlap(sq(0, 0, 10), sq(5, 5, 10)));
  assert.ok(C.polysOverlap(sq(0, 0, 10), sq(4, 4, 2)));
  assert.ok(C.polysOverlap(sq(4, 4, 2), sq(0, 0, 10)));
  assert.ok(!C.polysOverlap(sq(0, 0, 10), sq(11, 0, 5)));
  assert.ok(C.pointInPoly([1, 1], sq(0, 0, 2)) && !C.pointInPoly([3, 1], sq(0, 0, 2)));
});

test("a Height field is read as people write it", () => {
  assert.equal(C.parseHeight("5"), 5); assert.equal(C.parseHeight("5.2mm"), 5.2); assert.equal(C.parseHeight(" 5,2 mm "), 5.2);
  assert.equal(C.parseHeight("tall"), null); assert.equal(C.parseHeight(""), null); assert.equal(C.parseHeight("0"), null);
});
