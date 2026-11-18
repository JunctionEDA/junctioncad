// Node test for live collaboration in the 3D documents (web/domains/mechanical/collab, web/platform/doctabs/room):
// the presence state, the rebase of a dialog's draft, comment anchors and pins, the project room against a
// scripted socket, and the document session under concurrent edits: several sessions on a small sequencing
// server, with random interleavings of edits, reorders, deletes, undo and time offline, must all end on the
// document the server's own fold of the ops gives.
// Run: node server/static/tests/mechanical-collab.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");
const D = load("shared/itemdoc/itemdoc.ts");
const S = load("shared/itemdoc/sync.ts");
const P = load("domains/mechanical/collab/presence.ts");
const M = load("domains/mechanical/collab/merge.ts");
const A = load("domains/mechanical/collab/anchor.ts");
const C = load("domains/mechanical/collab/comments.ts");
const RA = load("platform/doctabs/roomapi.ts");
const R = load("platform/doctabs/room.ts");

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
/** Two points (or a pin) are the same to a nanometre. */
const near = (got, want, why) => { assert.ok(got && want && got.length === want.length && got.every((v, i) => Math.abs(v - want[i]) < 1e-6), `${why || "point"}: ${got} is not ${want}`); };

// ---------------------------------------------------------------- presence
test("a presence state is read back as sent; bad parts are dropped, a watcher is nobody", () => {
  const st = { cad: 1, key: "7:room-a", col: "#e83e8c", cam: P.packCam([0.1234567, 0, 0, 0.9923], [1.23456, -2, 3], 1.5, 1.7777), cur: { p: [1, 2, 3], hit: true },
    sel: [["f", "body", "face-name"], ["p", "top"], ["s", "sk", "l1", ""]], feat: "f1", edit: { id: "f1", kind: "dialog", name: "Extrude 1" }, fol: "9:room-b", ts: 12 };
  const back = P.parsePresence(JSON.parse(JSON.stringify(st)));
  assert.deepEqual(back, st);
  assert.deepEqual(back.cam.q, [0.12346, 0, 0, 0.9923]);
  assert.deepEqual(back.cam.t, [1.235, -2, 3]);
  assert.equal(P.parsePresence({ room: 1, tab: "x" }), null);
  assert.equal(P.parsePresence({ cursor: [1, 2] }), null);
  assert.equal(P.parsePresence(null), null);
  const odd = P.parsePresence({ cad: 1, cam: { q: [0, 0, 0], t: [0, 0, 0], z: 1, a: 1 }, cur: { p: ["x", 0, 0] }, sel: [["f", "b"], ["q", "x"], "no", ["e", "b", "n"]], edit: { id: 4 }, col: "red; background:url(x)" });
  assert.deepEqual(odd, { cad: 1, sel: [["e", "b", "n"]] });
});

test("a state too large for the server is cut down: the selection goes first, the camera never", () => {
  const sel = Array.from({ length: 300 }, (_, i) => ["e", "body-" + i, "edge(" + "x".repeat(120) + i + ")"]);
  const st = { cad: 1, cam: P.packCam([0, 0, 0, 1], [0, 0, 0], 1, 1), sel, edit: { id: "f", kind: "sketch", name: "Sketch 1" } };
  const fit = P.fitPresence(st);
  assert.ok(JSON.stringify(fit).length <= P.PRESENCE_LIMIT);
  assert.ok(fit.sel.length > 0 && fit.sel.length <= P.MAX_SEL);
  assert.deepEqual(fit.cam, st.cam);
  assert.equal(P.fitPresence({ cad: 1, sel: [["f", "b", "n"]] }).sel.length, 1);
});

test("the people in a document: only those who said they are here; the colour and key they have on every tab", () => {
  const peers = [
    { clientId: "2:web-b", userId: 2, login: "bob", name: "Bob Stone", color: "#111111", state: { cad: 1, key: "2:room-b", col: "#e83e8c", feat: "f1" } },
    { clientId: "2:room-b", userId: 2, login: "bob", name: "Bob Stone", color: "#e83e8c", state: { room: 1, tab: "d1", rev: 0 } },
    { clientId: "3:web-c", userId: 3, login: "carol", name: null, color: "#222222" },
    { clientId: "1:web-a", userId: 1, login: "ada", name: "Ada", color: "#333333", state: { cad: 1 } },
  ];
  const people = P.collaboratorsOf(peers);
  assert.deepEqual(people.map((p) => [p.name, p.key, p.color]), [["Ada", "1:web-a", "#333333"], ["Bob Stone", "2:room-b", "#e83e8c"]]);
  assert.equal(P.initials("Bob Stone"), "BS"); assert.equal(P.initials("ada"), "A"); assert.equal(P.initials("  "), "?"); assert.equal(P.initials("cad-ui-bob"), "CB");
  assert.equal(P.nameList(["Ada"]), "Ada"); assert.equal(P.nameList(["Ada", "Bob"]), "Ada and Bob"); assert.equal(P.nameList(["A", "B", "C", "D"]), "A, B and 2 others");
  assert.ok(P.brightness("#ffffff") > 0.9 && P.brightness("#000") === 0);
});

test("following: the zoom that shows everything they see, in a window of another shape", () => {
  assert.equal(P.followZoom(2, 1.5, 1.5), 2);
  assert.equal(P.followZoom(2, 2, 1), 1);       // my window is narrower: zoom out so their width fits
  assert.equal(P.followZoom(2, 1, 2), 2);       // mine is wider: their height decides
  assert.ok(P.sameCam(P.packCam([0, 0, 0, 1], [1, 2, 3], 1, 1), P.packCam([0, 0, 0, 1], [1, 2, 3.0000001], 1, 1)));
  assert.ok(!P.sameCam(P.packCam([0, 0, 0, 1], [1, 2, 3], 1, 1), P.packCam([0, 0, 0, 1], [1, 2, 3.01], 1, 1)));
});

// ---------------------------------------------------------------- the draft's rebase
test("a draft is rebased on what the others committed: theirs where I did not type, mine where I did, conflicts named", () => {
  const base = { name: "Extrude 1", params: { depth: 10, flip: false, operation: "new", targets: ["a"], profile: { sketch: "s1", regions: null } } };
  const mine = D.clone(base); mine.params.flip = true; mine.params.depth = 11;
  const theirs = D.clone(base); theirs.params.depth = 22; theirs.params.operation = "add"; theirs.name = "Base"; theirs.params.targets = ["a", "b"];
  const r = M.rebase(base, mine, theirs);
  assert.deepEqual(r.merged, { name: "Base", params: { depth: 11, flip: true, operation: "add", targets: ["a", "b"], profile: { sketch: "s1", regions: null } } });
  assert.deepEqual(r.taken.map((t) => t.path.join(".")).sort(), ["name", "params.operation", "params.targets"]);
  assert.deepEqual(r.conflicts, [{ path: ["params", "depth"], base: 10, mine: 11, theirs: 22 }]);
  assert.equal(mine.params.depth, 11, "the inputs are not changed");
  // committing the merged draft against the new document sends only what I changed
  const sent = D.diffProps(theirs, r.merged).map((p) => p.path.join(".") + "=" + p.value).sort();
  assert.deepEqual(sent, ["params.depth=11", "params.flip=true"]);
  // both typed the same: no conflict, nothing to take
  const same = M.rebase(base, { ...D.clone(base), name: "X" }, { ...D.clone(base), name: "X" });
  assert.equal(same.conflicts.length + same.taken.length, 0);
  assert.equal(M.isDirty(base, base), false); assert.equal(M.isDirty(base, mine), true);
});

test("the rebase merges a sketch entity by entity, and keys that came and went", () => {
  const base = { name: "S", params: { sketch: { entities: { p1: { type: "point", x: 0, y: 0 }, p2: { type: "point", x: 5, y: 0 }, l1: { type: "line", a: "p1", b: "p2" } } }, old: 1 } };
  const mine = D.clone(base); mine.params.sketch.entities.p1.x = 1; mine.params.sketch.entities.m1 = { type: "point", x: 9, y: 9 };
  const theirs = D.clone(base); theirs.params.sketch.entities.p2.x = 6; delete theirs.params.sketch.entities.l1; theirs.params.sketch.entities.t1 = { type: "point", x: 3, y: 3 }; delete theirs.params.old; theirs.params.fresh = { a: 1 };
  const r = M.rebase(base, mine, theirs);
  assert.deepEqual(Object.keys(r.merged.params.sketch.entities).sort(), ["m1", "p1", "p2", "t1"]);
  assert.equal(r.merged.params.sketch.entities.p1.x, 1); assert.equal(r.merged.params.sketch.entities.p2.x, 6);
  assert.equal("old" in r.merged.params, false); assert.deepEqual(r.merged.params.fresh, { a: 1 });
  assert.equal(r.conflicts.length, 0);
  // they deleted what I changed: mine stays, and it is a conflict
  const gone = D.clone(base); delete gone.params.sketch.entities.p1;
  const c = M.rebase(base, mine, gone);
  assert.deepEqual(c.conflicts.map((k) => [k.path.join("."), k.theirs]), [["params.sketch.entities.p1", undefined]]);
  assert.equal(c.merged.params.sketch.entities.p1.x, 1);
  assert.equal(M.showValue(12.34567), "12.346"); assert.equal(M.showValue(true), "on"); assert.equal(M.showValue([1, 2]), "2 items"); assert.equal(M.showValue(undefined), "nothing");
});

// ---------------------------------------------------------------- comment anchors and pins
test("a comment's anchor: a feature by its id, geometry by its stable name, a point in two integers", () => {
  for (const p of [[0, 0, 0], [12.345, -0.001, 29999.999], [-33000, 33000, -0.5], [1e-4, 5, 5]]) {
    const { x, y } = A.packPoint3(p);
    assert.ok(Number.isSafeInteger(x) && Number.isSafeInteger(y));
    const back = A.unpackPoint3(x, y);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(back[k] - p[k]) <= 0.0005 + 1e-9, `${p} → ${back}`);
  }
  const far = A.packPoint3([1e9, -1e9, 1e9]);
  near(A.unpackPoint3(far.x, far.y), [33554.431, -33554.431, 33554.431], "a point beyond ±33 m is held at the limit");
  assert.deepEqual(A.packPoint3(null), { x: 0, y: 0 }); assert.equal(A.unpackPoint3(0, 0), null);
  assert.notEqual(A.unpackPoint3(A.packPoint3([0, 0, 0]).x, 0), null, "the origin is a point, not 'no point'");
  const face = { kind: "face", body: "f1", name: "f1:end:l1" };
  const a = A.anchorFor(face, "Face of Part 1", "f1");
  assert.deepEqual(a, { kind: "item", id: "face:f1:end:l1", label: "Face of Part 1", item: "f1" });
  assert.deepEqual(A.targetOf(a), face);
  assert.deepEqual(A.targetOf(A.anchorFor({ kind: "feature", featureId: "abc" }, "Extrude 1")), { kind: "feature", featureId: "abc" });
  assert.deepEqual(A.targetOf({ kind: "item", id: "edge:e|f", item: "b" }), { kind: "edge", body: "b", name: "e|f" });
  // a name the server has no room for is pinned to the feature that made the body
  const long = A.anchorFor({ kind: "vertex", body: "f1", name: "v".repeat(400) }, "Vertex", "f1");
  assert.deepEqual(A.targetOf(long), { kind: "feature", featureId: "f1" });
  assert.equal(A.anchorFor({ kind: "vertex", body: "f1", name: "v".repeat(400) }, "Vertex", null), null);
  assert.equal(A.targetOf({ kind: "net", id: "GND" }), null); assert.equal(A.targetOf(null), null);
  assert.equal(A.targetKey(face), "face:f1:f1:end:l1");
});

/** A 10 × 10 square plate at z = 2 with a named top face of two triangles, a ring face around a hole, one edge, one vertex. */
function plate() {
  const positions = new Float32Array([0, 0, 2, 10, 0, 2, 10, 10, 2, 0, 10, 2,   20, 0, 0, 30, 0, 0, 30, 10, 0, 20, 10, 0, 24, 4, 0, 26, 4, 0, 26, 6, 0, 24, 6, 0]);
  const ring = [4, 5, 9, 4, 9, 8, 5, 6, 10, 5, 10, 9, 6, 7, 11, 6, 11, 10, 7, 4, 8, 7, 8, 11];
  return {
    positions, normals: new Float32Array(positions.length), indices: new Uint32Array([0, 1, 2, 0, 2, 3, ...ring]),
    faces: { names: ["top", "ring"], start: new Uint32Array([0, 6]), count: new Uint32Array([6, ring.length]) },
    edges: { names: ["front"], positions: new Float32Array([0, 0, 2, 4, 0, 2, 4, 0, 2, 10, 0, 2]), start: new Uint32Array([0]), count: new Uint32Array([4]) },
    vertices: { names: ["corner"], positions: new Float32Array([10, 10, 2]) },
    bbox: [0, 0, 0, 30, 10, 2],
  };
}

test("a pin sits on its geometry: the middle of a face (on the face, even around a hole), of an edge, a vertex", () => {
  const m = plate();
  near(C.geometryPoint(m, "face", "top"), [5, 5, 2]);
  const ring = C.geometryPoint(m, "face", "ring");
  const inHole = ring[0] > 24 && ring[0] < 26 && ring[1] > 4 && ring[1] < 6;
  assert.ok(!inHole && ring[0] >= 20 && ring[0] <= 30 && ring[2] === 0, `on the ring, not in its hole: ${ring}`);
  near(C.geometryPoint(m, "edge", "front"), [5, 0, 2]);
  near(C.geometryPoint(m, "vertex", "corner"), [10, 10, 2]);
  assert.equal(C.geometryPoint(m, "face", "gone"), null);
});

test("a pin follows its face, stays where the thread started when the face is gone, and finds a merged body's face", () => {
  const m = plate();
  const src = (meshes, features = ["f1"]) => ({ mesh: (id) => meshes[id] || null, meshes: () => Object.values(meshes), bodiesOf: (f) => (f === "f1" ? Object.values(meshes) : []), hasFeature: (f) => features.includes(f) });
  const at = A.packPoint3([1, 1, 2]);
  const onFace = { id: 1, parentId: null, x: at.x, y: at.y, anchor: { kind: "item", id: "face:top", item: "b1" } };
  const pin = (got, point, lost, why) => { assert.ok(got, why); near(got.point, point, why); assert.equal(got.lost, lost, why); };
  pin(C.pinPoint(onFace, src({ b1: m })), [5, 5, 2], false);
  pin(C.pinPoint(onFace, src({ other: m })), [5, 5, 2], false, "the body was merged into another: the name is looked for everywhere");
  const moved = plate(); for (let i = 2; i < 12; i += 3) moved.positions[i] = 7;
  pin(C.pinPoint(onFace, src({ b1: moved })), [5, 5, 7], false);
  pin(C.pinPoint(onFace, src({})), [1, 1, 2], true);
  assert.equal(C.pinPoint({ ...onFace, x: 0, y: 0 }, src({})), null);
  const onFeature = { id: 2, parentId: null, x: 0, y: 0, anchor: { kind: "item", id: "f1" } };
  pin(C.pinPoint(onFeature, src({ b1: m })), [15, 5, 2], false);
  assert.equal(C.pinPoint(onFeature, src({ b1: m }, [])), null);
  pin(C.pinPoint({ ...onFeature, x: at.x, y: at.y }, src({}, [])), [1, 1, 2], true);
});

test("the comment store follows the socket's news of threads", async () => {
  const taps = new Set();
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ comments: [{ id: 1, parentId: null, body: "first", resolved: false }] }) });
  try {
    const store = new C.CommentStore("d1", { taps });
    await tick();
    assert.equal(store.getState().comments.length, 1);
    const say = (comment) => { for (const t of taps) t({ type: "comment", docId: "d1", comment }); };
    say({ action: "added", comment: { id: 3, parentId: 1, body: "reply" } });
    say({ action: "added", comment: { id: 2, parentId: null, body: "second" } });
    assert.deepEqual(store.getState().comments.map((c) => c.id), [1, 2, 3]);
    say({ action: "updated", comment: { id: 1, parentId: null, body: "first", resolved: true } });
    assert.equal(store.getState().comments[0].resolved, true);
    store.openThread(1);
    say({ action: "deleted", comment: { id: 1 } });
    assert.deepEqual(store.getState().comments.map((c) => c.id), [2], "a deleted thread takes its replies with it");
    assert.equal(store.getState().open, null);
    store.dispose();
    assert.equal(taps.size, 0);
  } finally { global.fetch = realFetch; }
});

// ---------------------------------------------------------------- the project room
test("the room's documents and tabs: the same few for everybody, a sheet counts as the schematic", () => {
  const docs = [{ docId: "s", docType: "kicad_sch" }, { docId: "s2", docType: "kicad_sch" }, { docId: "b", docType: "kicad_pcb" }, ...["e", "c", "a", "d", "f"].map((id) => ({ docId: id, docType: id === "f" ? "assembly" : "part_studio" }))];
  assert.deepEqual(RA.roomDocs(docs), ["a", "c", "d", "e"]);
  assert.deepEqual(RA.roomDocs(docs.slice(0, 3)), []);
  // lists that differ by one new or deleted document still share a room
  assert.ok(RA.roomDocs(docs).some((id) => RA.roomDocs(docs.filter((d) => d.docId !== "a")).includes(id)));
  const m = (tab) => ({ key: "k", userId: 1, login: "l", name: "n", color: "#fff", tab });
  const tabs = ["s", "b", "a"];
  assert.equal(RA.tabOf(m("a"), docs, tabs, "s"), "a"); assert.equal(RA.tabOf(m("s2"), docs, tabs, "s"), "s"); assert.equal(RA.tabOf(m("zz"), docs, tabs, "s"), null); assert.equal(RA.tabOf(m(null), docs, tabs, "s"), null);
  assert.deepEqual(RA.parseRoomPresence({ room: 1, tab: "a", col: "#aabbcc" }), { room: 1, tab: "a", col: "#aabbcc" });
  // the server's notice that the project's documents changed (src/http.rs notify_docs), as the tabs read it
  const notice = { type: "docs", docId: "d1", projectId: "p", n: "n1", change: "renamed", from: "A.jpart", doc: { docId: "d2", path: "B.jpart", docType: "part_studio" }, by: { userId: 2, login: "bob", name: "Bob Stone" } };
  assert.deepEqual(RA.parseDocsNotice(notice), { n: "n1", projectId: "p", note: { what: "renamed", name: "A to B" }, by: { userId: 2, login: "bob", name: "Bob Stone" } });
  assert.equal(RA.parseDocsNotice({ ...notice, change: "added", by: { userId: 3, login: "cy", name: null } }).by.name, "cy");
  assert.equal(RA.parseDocsNotice({ ...notice, change: "exploded" }), null);
  assert.equal(RA.parseDocsNotice({ type: "versions" }), null);
  assert.equal(RA.parseRoomPresence({ cad: 1 }), null);
  assert.equal(RA.noteText("Ada", { what: "renamed", name: "A to B" }), "Ada renamed A to B");
  // two people the server gave one colour: exactly one of them takes another, the first nobody has
  const ada = { key: "1:room-a", color: "#e05d44" }, bob = { key: "2:room-b", color: "#e05d44" }, cy = { key: "3:room-c", color: "#4477ee" };
  assert.equal(RA.pickColor(ada, [bob, cy]), "#e05d44"); assert.equal(RA.pickColor(bob, [ada, cy]), "#22aa66"); assert.equal(RA.pickColor(cy, [ada, bob]), "#4477ee");
  assert.equal(RA.pickColor(bob, [ada, ...RA.ROOM_COLORS.map((color, i) => ({ key: "9:" + i, color }))]), "#e05d44", "every colour taken: keep one's own");
});

class FakeSocket {
  constructor() { this.sent = []; this.readyState = 0; FakeSocket.last = this; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.onclose && this.onclose({}); }
  say(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
}

test("the room joins the project's item documents, says which tab this person is on, and hears where the others are", async () => {
  const news = [];
  const room = new R.ProjectRoom({ signedIn: true, socketUrl: "ws://test", fetchTicket: async () => "t", WebSocketImpl: FakeSocket, onDocsChanged: () => news.push("look") });
  let changes = 0; room.subscribe(() => changes++);
  room.setTab("p1");
  room.setDocs([{ docId: "sch", docType: "kicad_sch" }]);
  await tick();
  assert.equal(room.getState().live, false, "no part studio or assembly: no room, no socket");
  room.setDocs([{ docId: "sch", docType: "kicad_sch" }, { docId: "p1", docType: "part_studio" }, { docId: "p0", docType: "part_studio" }]);
  await tick(); await tick();
  const sock = FakeSocket.last;
  assert.equal(sock.sent[0].type, "hello");
  sock.say({ type: "hello_ok", clientId: "1:room-me", color: "#abcdef" });
  assert.deepEqual(sock.sent.slice(1).map((m) => [m.type, m.docId]), [["join_doc", "p0"], ["join_doc", "p1"]]);
  sock.say({ type: "doc_info", docId: "p0", role: "editor", peers: [] });
  sock.say({ type: "snapshot", docId: "p0", seq: 0, file: "{}" });
  const said = sock.sent[sock.sent.length - 1];
  assert.deepEqual([said.type, said.docId, said.state.room, said.state.tab], ["presence", "p0", 1, "p1"]);
  assert.deepEqual(room.getState().me, { key: "1:room-me", color: "#abcdef" });
  assert.equal(room.getState().live, true);
  const bob = { clientId: "2:room-bob", userId: 2, login: "bob", name: "Bob", color: "#e83e8c" };
  // Bob's watcher, Bob's editor session (not a watcher), and our own echo
  sock.say({ type: "presence", docId: "p0", peers: { "2:room-bob": { user: bob, state: { room: 1, tab: "sch", rev: 0 } }, "2:web-bob": { user: { ...bob, clientId: "2:web-bob" }, state: { cad: 1 } }, "1:room-me": { user: {}, state: { room: 1, tab: "p1", rev: 0 } } } });
  assert.deepEqual(room.getState().members, [{ key: "2:room-bob", userId: 2, login: "bob", name: "Bob", color: "#e83e8c", tab: "sch" }]);
  sock.say({ type: "presence", docId: "p0", peers: { "2:room-bob": { state: { room: 1, tab: "p0", rev: 0 } } } });
  assert.equal(room.getState().members[0].tab, "p0");
  // somebody whose key sorts first has our colour: we take another and say so; they keep theirs
  sock.say({ type: "presence", docId: "p0", peers: { "0:room-zed": { user: { clientId: "0:room-zed", userId: 9, login: "zed", name: "Zed", color: "#abcdef" }, state: { room: 1, tab: null, rev: 0 } } } });
  assert.equal(room.getState().me.color, "#e05d44", "the first colour nobody here has");
  assert.equal(sock.sent[sock.sent.length - 1].state.col, "#e05d44");
  sock.say({ type: "presence", docId: "p0", peers: { "0:room-zed": null } });
  assert.deepEqual(news, [], "nothing changed in the project yet");
  // the server says a document was added: the watcher passes the notice on (roomapi.ts tellDocsChanged), and
  // the room itself asks for nothing
  sock.say({ type: "docs", docId: "p0", projectId: "p", n: "n-7", change: "added", doc: { docId: "p9", path: "Part Studio 3.jpart", docType: "part_studio" }, by: { userId: 2, login: "bob", name: "Bob" } });
  assert.deepEqual(news, []);
  sock.say({ type: "presence", docId: "p0", peers: { "3:room-c": { user: { clientId: "3:room-c", userId: 3, login: "carol", name: "Carol", color: "#111" }, state: { room: 1, tab: null } } } });
  // a new document that sorts first is joined on the same socket
  room.setDocs([{ docId: "p1", docType: "part_studio" }, { docId: "p0", docType: "part_studio" }, { docId: "a0", docType: "assembly" }]);
  assert.deepEqual(sock.sent.filter((m) => m.type === "join_doc").map((m) => m.docId), ["p0", "p1", "a0"]);
  sock.say({ type: "peer_left", docId: "p0", clientId: "2:room-bob" });
  assert.deepEqual(room.getState().members.map((m) => m.login), ["carol"]);
  sock.say({ type: "presence", docId: "p0", peers: { "3:room-c": null } });
  assert.deepEqual(room.getState().members, []);
  assert.ok(changes > 3);
  room.close();
  assert.equal(sock.readyState, 3);
});

// ---------------------------------------------------------------- the session's taps
test("a session shows its taps who made an op, the news it does not handle itself, and its own edits", async () => {
  const s = new S.ItemDocSession({ docId: "d1", signedIn: true, socketUrl: "ws://test", fetchTicket: async () => "t", WebSocketImpl: FakeSocket, onChange() {} });
  const seen = [];
  s.taps.add((msg) => seen.push(msg.type + (msg.type === "op" ? ":" + msg.author.login + ":" + s.doc.items.has("a") : "")));
  s.start(); await tick(); await tick();
  const sock = FakeSocket.last;
  sock.say({ type: "hello_ok", clientId: "1:web-x" });
  sock.say({ type: "doc_info", docId: "d1", role: "editor", peers: [{ clientId: "2:web-b", userId: 2, login: "bob", color: "#fff" }, { clientId: "2:room-b7x", userId: 2, login: "bob", color: "#000" }] });
  sock.say({ type: "snapshot", docId: "d1", seq: 0, file: '{"junction":"part-studio","version":1,"items":[{"id":"a","type":"feature","name":"A"}]}' });
  sock.say({ type: "presence", docId: "d1", peers: { "2:room-b7x": { user: { clientId: "2:room-b7x", userId: 2, login: "bob", color: "#000" }, state: { room: 1, tab: "d1", rev: 0 } } } });
  sock.say({ type: "peer_joined", docId: "d1", peer: { clientId: "3:room-c", userId: 3, login: "carol", color: "#000" } });
  assert.deepEqual(s.peerList().map((p) => p.clientId), ["2:web-b"], "a project room's watcher is not somebody in the document");
  assert.ok(S.isRoomWatcher("room-abc") && S.isRoomWatcher("12:room-9z") && !S.isRoomWatcher("12:web-room-1") && !S.isRoomWatcher("12:web-abc"));
  sock.say({ type: "op", docId: "d1", seq: 1, author: { clientId: "2:web-b", login: "bob" }, changes: [{ id: "a", kind: "REMOVED" }] });
  sock.say({ type: "comment", docId: "d1", comment: { action: "added", comment: { id: 1 } } });
  sock.say({ type: "op", docId: "other", seq: 9, author: { login: "x" }, changes: [] });
  s.commit([{ id: "n", kind: "ADDED", typeName: "feature", item: { id: "n", type: "feature" } }]);
  assert.deepEqual(seen, ["doc_info", "snapshot", "presence", "peer_joined", "op:bob:true", "comment", "local_op"], "a tap sees an op before it is applied, and nothing of another document");
  s.close();
});

// ---------------------------------------------------------------- sessions under concurrent edits
// A sequencing server in a few lines, as doc_actor.rs does it for these documents: an op gets the next seq, is
// acknowledged to its sender and sent to the others; a client op id seen before is acknowledged again and not
// applied twice; a join with sinceSeq gets the ops since, a join without gets a snapshot and the ops after it.
// Every socket has an outbox (client → server) and an inbox (server → client), each first in first out like a
// TCP stream; the test delivers one message at a time from a queue chosen at random, which is every interleaving
// a network can produce.
const START = '{"junction":"part-studio","version":1,"items":[\n' + [
  '{"id":"studio","rollback":null,"type":"studio","units":"mm"}',
  '{"featureType":"sketch","id":"s1","name":"Sketch 1","order":"F","params":{"sketch":{"entities":{"p1":{"type":"point","x":0,"y":0},"p2":{"type":"point","x":5,"y":0},"l1":{"type":"line","a":"p1","b":"p2"}}}},"type":"feature"}',
  '{"featureType":"extrude","id":"e1","name":"Extrude 1","order":"K","params":{"depth":10,"flip":false},"type":"feature"}',
  '{"featureType":"sketch","id":"s2","name":"Sketch 2","order":"P","params":{"sketch":{"entities":{}}},"type":"feature"}',
  '{"featureType":"extrude","id":"e2","name":"Extrude 2","order":"U","params":{"depth":4,"flip":false},"type":"feature"}',
].join(",\n") + "\n]}\n";

function network(seed) {
  let x = seed >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const hub = { ops: [], seen: new Map(), socks: new Set(), online: new Map() };
  class Sock {
    constructor() { this.readyState = 0; this.out = []; this.inn = []; this.joined = false; hub.socks.add(this); Sock.made.push(this); setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen && this.onopen(); } }, 0); }
    send(text) { if (this.readyState === 1) this.out.push(JSON.parse(text)); }
    close() { if (this.readyState === 3) return; this.readyState = 3; hub.socks.delete(this); this.out = []; this.inn = []; this.onclose && this.onclose({}); }
  }
  Sock.made = [];
  const serve = (sock, m) => {
    const head = hub.ops.length;
    if (m.type === "hello") sock.inn.push({ type: "hello_ok", clientId: "u:" + String(m.clientId).replace(/^u:/, "") }), (sock.cid = "u:" + String(m.clientId).replace(/^u:/, ""));
    else if (m.type === "join_doc" || m.type === "resync") {
      sock.joined = true;
      sock.inn.push({ type: "doc_info", docId: "d", role: "editor", headSeq: head, peers: [] });
      // the edits since, when the client says where it is (and the server still has them: one time in four it
      // does not); else the file as some snapshot folded it, and the edits after that snapshot
      if (m.type === "join_doc" && typeof m.sinceSeq === "number" && m.sinceSeq <= head && rnd() < 0.75) sock.inn.push({ type: "ops", docId: "d", from: m.sinceSeq + 1, ops: hub.ops.slice(m.sinceSeq) });
      else {
        const at = Math.floor(rnd() * (head + 1)), folded = D.parseItemDoc(START);
        for (const op of hub.ops.slice(0, at)) D.applyChanges(folded, op.changes);
        sock.inn.push({ type: "snapshot", docId: "d", seq: at, file: D.serializeItemDoc(folded), thenOps: hub.ops.slice(at) });
      }
    } else if (m.type === "op") {
      const key = sock.cid + " " + m.clientOpId;      // the server's index is per client: two clients may count alike
      const was = hub.seen.get(key);
      if (was) { sock.inn.push({ type: "ack", docId: "d", clientOpId: m.clientOpId, seq: was }); return; }
      const op = { seq: head + 1, author: { clientId: sock.cid, login: sock.cid }, changes: m.changes };
      hub.ops.push(op); hub.seen.set(key, op.seq);
      sock.inn.push({ type: "ack", docId: "d", clientOpId: m.clientOpId, seq: op.seq });
      for (const other of hub.socks) if (other !== sock && other.joined && other.readyState === 1) other.inn.push({ type: "op", docId: "d", ...op });
    }
  };
  /** Deliver one waiting message, from a queue chosen at random.  False when nothing waits. */
  const step = () => {
    const queues = [];
    for (const s of hub.socks) { if (s.readyState !== 1) continue; if (s.out.length) queues.push(() => serve(s, s.out.shift())); if (s.inn.length) queues.push(() => s.onmessage({ data: JSON.stringify(s.inn.shift()) })); }
    if (!queues.length) return false;
    queues[Math.floor(rnd() * queues.length)]();
    return true;
  };
  return { hub, Sock, rnd, step };
}

async function scenario(seed, people, steps) {
  const net = network(seed), { rnd } = net;
  const online = people.map(() => true);
  const sessions = people.map((_, i) => new S.ItemDocSession({ docId: "d", signedIn: true, expectKind: "part-studio", socketUrl: "ws://test", WebSocketImpl: net.Sock, onChange() {},
    fetchTicket: async () => { if (!online[i]) throw new Error("offline"); return "t"; } }));
  for (const s of sessions) s.start();
  const drain = async () => { for (let quiet = 0; quiet < 3;) { if (net.step()) quiet = 0; else { quiet++; await tick(1); } } };
  await tick(2); await drain();
  for (const s of sessions) assert.ok(s.doc && s.status.canEdit, "everybody joined");

  const ids = ["s1", "e1", "s2", "e2"];
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let made = 0;
  const edit = (i) => {
    const s = sessions[i], id = pick(ids), item = s.doc.items.get(id), r = rnd();
    const mod = (props) => s.commit([{ id, kind: "MODIFIED", typeName: "feature", props }]);
    if (r < 0.30) mod([{ path: ["params", "depth"], value: Math.floor(rnd() * 50) }]);                          // the same parameter as the others
    else if (r < 0.40) mod([{ path: ["params", "by" + i], value: made++ }]);                                      // a parameter of one's own
    else if (r < 0.50) mod([{ path: ["name"], value: "N" + i + "-" + made++ }]);
    else if (r < 0.62) mod([{ path: ["order"], value: D.orderBetween(pick(["", "F", "K", "P"]), pick(["U", "Z", ""])) }]);   // a reorder
    else if (r < 0.74) { const k = pick(["p1", "p2", "q" + i, "l1"]); mod([rnd() < 0.3 ? { path: ["params", "sketch", "entities", k], del: true } : { path: ["params", "sketch", "entities", k], value: { type: "point", x: made++, y: i } }]); }
    else if (r < 0.82) { if (item) s.commit([{ id, kind: "REMOVED", typeName: "feature" }]); }                    // a delete
    else if (r < 0.90) { if (!item) s.commit([{ id, kind: "ADDED", typeName: "feature", item: { id, type: "feature", featureType: "extrude", name: "Back " + i, order: pick(["G", "M", "R"]), params: { depth: made++ } } }]); }
    else if (r < 0.96) s.undo(); else s.redo();
  };
  for (let n = 0; n < steps; n++) {
    const i = Math.floor(rnd() * people.length), r = rnd();
    if (r < 0.45) edit(i);
    else if (r < 0.93) net.step();
    else if (online[i] && r < 0.965) { online[i] = false; const ws = sessions[i].ws; if (ws) ws.close(); }      // the network drops
    else if (!online[i]) { online[i] = true; void sessions[i].connect(); await tick(1); }                         // and comes back
  }
  for (let i = 0; i < people.length; i++) if (!online[i]) { online[i] = true; void sessions[i].connect(); }
  await tick(2); await drain();
  // what the server's fold gives (itemdoc.rs applies the same rules to the stored file)
  const folded = D.parseItemDoc(START);
  for (const op of net.hub.ops) D.applyChanges(folded, op.changes);
  const want = D.serializeItemDoc(folded);
  for (let i = 0; i < sessions.length; i++) {
    assert.equal(sessions[i].unsaved, 0, `seed ${seed}: ${people[i]} has sent everything`);
    assert.equal(D.serializeItemDoc(sessions[i].doc), want, `seed ${seed}: ${people[i]} holds the server's document after ${net.hub.ops.length} ops`);
  }
  for (const s of sessions) s.close();
  return net.hub.ops.length;
}

test("two and three sessions editing at once, in every order a network can deliver, end on the server's document", async () => {
  let ops = 0;
  for (let seed = 1; seed <= 80; seed++) ops += await scenario(seed, ["ada", "bob"], 160);
  for (let seed = 101; seed <= 140; seed++) ops += await scenario(seed, ["ada", "bob", "carol"], 220);
  assert.ok(ops > 2000, `${ops} ops in all`);
});

test("an edit the server stored just before the connection dropped is not put back on top of what others did after it", async () => {
  for (const how of ["tail", "snapshot"]) {
    const net = network(how === "tail" ? 3 : 4);
    const [a, b] = [0, 1].map(() => new S.ItemDocSession({ docId: "d", signedIn: true, expectKind: "part-studio", socketUrl: "ws://test", WebSocketImpl: net.Sock, onChange() {}, fetchTicket: async () => "t" }));
    const all = async () => { for (let quiet = 0; quiet < 3;) { if (net.step()) quiet = 0; else { quiet++; await tick(1); } } };
    a.start(); b.start(); await tick(2); await all();
    if (how === "tail") { b.commit([{ id: "s2", kind: "MODIFIED", props: [{ path: ["name"], value: "first" }] }]); await all(); }   // so that A has a place to catch up from
    // A sets the depth; the server stores it, and the connection drops before A hears so
    a.commit([{ id: "e1", kind: "MODIFIED", props: [{ path: ["params", "depth"], value: 11 }] }]);
    const sock = a.ws;
    while (sock.out.length) net.step();
    assert.equal(net.hub.ops[net.hub.ops.length - 1].changes[0].props[0].value, 11, "stored");
    sock.close();
    assert.equal(a.unsaved, 1, "A does not know");
    // B, who saw it, sets the depth after it
    await all();
    b.commit([{ id: "e1", kind: "MODIFIED", props: [{ path: ["params", "depth"], value: 22 }] }]);
    await all();
    void a.connect(); await tick(2); await all();
    assert.equal(a.unsaved, 0);
    assert.equal(b.doc.items.get("e1").params.depth, 22);
    assert.equal(a.doc.items.get("e1").params.depth, 22, `${how}: B's later value stands for A too`);
    a.close(); b.close();
  }
});

test("the cases by name: delete against edit, reorder against edit, an edit made offline", async () => {
  const net = network(7);
  const online = [true, true];
  const [a, b] = [0, 1].map((i) => new S.ItemDocSession({ docId: "d", signedIn: true, expectKind: "part-studio", socketUrl: "ws://test", WebSocketImpl: net.Sock, onChange() {}, fetchTicket: async () => { if (!online[i]) throw new Error("offline"); return "t"; } }));
  const all = async () => { for (let quiet = 0; quiet < 3;) { if (net.step()) quiet = 0; else { quiet++; await tick(1); } } };
  a.start(); b.start(); await tick(2); await all();
  const depth = (s, id) => s.doc.items.get(id) && s.doc.items.get(id).params.depth;
  // delete against edit, both before either hears of the other: the delete wins on both sides, whatever the order
  a.commit([{ id: "e1", kind: "MODIFIED", props: [{ path: ["params", "depth"], value: 33 }] }]);
  b.commit([{ id: "e1", kind: "REMOVED" }]);
  await all();
  assert.equal(a.doc.items.has("e1"), false); assert.equal(b.doc.items.has("e1"), false);
  // ... and the editor's undo stack still holds the way back for a later restore of the item
  b.undo(); await all();
  assert.equal(depth(a, "e1"), 10, "the deleter's undo restores the feature as it was when it was deleted");
  // reorder against edit: different paths of one item, both hold
  a.commit([{ id: "e2", kind: "MODIFIED", props: [{ path: ["order"], value: "H" }] }]);
  b.commit([{ id: "e2", kind: "MODIFIED", props: [{ path: ["params", "depth"], value: 9 }] }]);
  await all();
  for (const s of [a, b]) assert.deepEqual([s.doc.items.get("e2").order, depth(s, "e2")], ["H", 9]);
  // offline: A edits two features while B edits one of them and renames the other
  online[0] = false; a.ws.close();
  a.commit([{ id: "e1", kind: "MODIFIED", props: [{ path: ["params", "depth"], value: 41 }] }]);
  a.commit([{ id: "e2", kind: "MODIFIED", props: [{ path: ["params", "flip"], value: true }] }]);
  b.commit([{ id: "e1", kind: "MODIFIED", props: [{ path: ["name"], value: "Tall" }] }]);
  b.commit([{ id: "e2", kind: "MODIFIED", props: [{ path: ["params", "depth"], value: 2 }] }]);
  await all();
  assert.equal(a.unsaved, 2); assert.equal(depth(b, "e1"), 10);
  online[0] = true; void a.connect(); await tick(2); await all();
  for (const s of [a, b]) assert.deepEqual([s.doc.items.get("e1").name, depth(s, "e1"), depth(s, "e2"), s.doc.items.get("e2").params.flip], ["Tall", 41, 2, true]);
  assert.equal(a.unsaved, 0);
  a.close(); b.close();
});
