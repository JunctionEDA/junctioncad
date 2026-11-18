// Node test for JSON item documents (web/shared/itemdoc): the file format, the change rules (which the server
// repeats in src/itemdoc.rs), order keys, and the session's behaviour against a scripted socket.
// Run: node server/static/tests/itemdoc.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");
const D = load("shared/itemdoc/itemdoc.ts");
const S = load("shared/itemdoc/sync.ts");

const FILE = '{"junction":"part-studio","version":1,"items":[\n{"id":"a","name":"Sketch 1","type":"feature"},\n{"featureType":"extrude","id":"b","params":{"depth":5},"type":"feature"}\n]}\n';

test("a file reads and writes back byte for byte; other head keys and item keys are kept", () => {
  const doc = D.parseItemDoc(FILE, "part-studio");
  assert.equal(doc.kind, "part-studio"); assert.equal(doc.items.size, 2);
  assert.equal(D.serializeItemDoc(doc), FILE);
  const odd = D.parseItemDoc('{"junction":"x","version":1,"future":{"k":1},"items":[{"id":"q","type":"new-thing","zz":[1,{"b":2,"a":1}]},{"no":"id"}]}');
  assert.equal(D.serializeItemDoc(odd), '{"future":{"k":1},"junction":"x","version":1,"items":[\n{"id":"q","type":"new-thing","zz":[1,{"a":1,"b":2}]}\n]}\n');
  assert.throws(() => D.parseItemDoc("(kicad_pcb)"), /not a Junction document/);
  assert.throws(() => D.parseItemDoc(FILE, "assembly"), /part-studio, not a assembly|not a/);
  assert.throws(() => D.parseItemDoc('{"junction":"x","version":99,"items":[]}'), /newer/);
});

test("changes: add replaces, modify sets and deletes paths, remove removes, unknown ids do nothing (the server's rules, itemdoc.rs)", () => {
  const doc = D.parseItemDoc(FILE);
  const before = doc.items.get("b");
  const touched = D.applyChanges(doc, [
    { id: "b", kind: "MODIFIED", props: [{ path: ["params", "depth"], value: 12 }, { path: ["params", "draft", "angle"], value: 3 }, { path: ["name"], value: "Extrude 1" }] },
    { id: "c", kind: "ADDED", typeName: "feature", item: { type: "feature", featureType: "fillet" } },
    { id: "a", kind: "REMOVED" },
    { id: "zz", kind: "MODIFIED", props: [{ path: ["name"], value: "nobody" }] },
    { id: "b", kind: "MODIFIED", props: [{ path: ["params", "draft"], del: true }, { path: ["id"], value: "hijack" }] },
  ]);
  assert.deepEqual(Array.from(touched).sort(), ["a", "b", "c"]);
  assert.deepEqual(doc.items.get("b"), { id: "b", type: "feature", featureType: "extrude", name: "Extrude 1", params: { depth: 12 } });
  assert.deepEqual(doc.items.get("c"), { id: "c", type: "feature", featureType: "fillet" });
  assert.equal(doc.items.has("a"), false);
  assert.deepEqual(before.params, { depth: 5 }, "an item taken before a change is not mutated");
  // the same text the Rust fold writes for these ops (src/itemdoc.rs folds_added_modified_removed)
  assert.equal(D.serializeItemDoc(doc).split("\n").length, 5);
});

test("diffProps sends only the paths that differ, descending into objects and not into arrays", () => {
  const a = { id: "f", type: "feature", name: "E", params: { depth: 5, flip: false, sketch: { entities: { p1: { type: "point", x: 0, y: 0 }, p2: { type: "point", x: 1, y: 0 } } }, list: [1, 2] } };
  const b = { id: "f", type: "feature", name: "E", params: { depth: 8, sketch: { entities: { p1: { type: "point", x: 0, y: 0 }, p3: { type: "point", x: 2, y: 2 } } }, list: [1, 2, 3] } };
  const c = D.modifiedChange(a, b);
  assert.deepEqual(c.props.map((p) => p.path.join(".") + (p.del ? " del" : "")).sort(), ["params.depth", "params.flip del", "params.list", "params.sketch.entities.p2 del", "params.sketch.entities.p3"]);
  assert.equal(D.modifiedChange(a, JSON.parse(JSON.stringify(a))), null);
  const doc = D.newItemDoc("x", [a]);
  D.applyChanges(doc, [c]);
  assert.deepEqual(doc.items.get("f"), b);
});

test("invertChange undoes each kind of change", () => {
  const doc = D.parseItemDoc(FILE);
  const text = D.serializeItemDoc(doc);
  const changes = [
    { id: "b", kind: "MODIFIED", props: [{ path: ["params", "depth"], value: 9 }, { path: ["params", "new"], value: 1 }] },
    { id: "a", kind: "REMOVED" },
    { id: "n", kind: "ADDED", typeName: "feature", item: { type: "feature" } },
    { id: "b", kind: "ADDED", typeName: "feature", item: { type: "feature", replaced: true } },
  ];
  const undo = [];
  for (const c of changes) { const inv = D.invertChange(doc, c); D.applyChanges(doc, [c]); undo.unshift(inv); }
  assert.notEqual(D.serializeItemDoc(doc), text);
  D.applyChanges(doc, undo);
  assert.equal(D.serializeItemDoc(doc), text);
});

test("order keys: always between their neighbours, however many are asked for", () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const keys = [D.orderBetween(null, null)];
  for (let i = 0; i < 3000; i++) {
    const at = Math.floor(rnd() * (keys.length + 1));
    const k = D.orderBetween(at > 0 ? keys[at - 1] : null, at < keys.length ? keys[at] : null);
    if (at > 0) assert.ok(k > keys[at - 1], `${k} after ${keys[at - 1]}`);
    if (at < keys.length) assert.ok(k < keys[at], `${k} before ${keys[at]}`);
    assert.notEqual(k[k.length - 1], "0");
    keys.splice(at, 0, k);
  }
  // always at the front, always at the end: keys grow slowly
  let lo = D.orderBetween(null, null), hi = lo;
  for (let i = 0; i < 200; i++) { const a = D.orderBetween(null, lo); assert.ok(a < lo); lo = a; const z = D.orderBetween(hi, null); assert.ok(z > hi); hi = z; }
  assert.ok(lo.length < 60 && hi.length < 60);
  assert.deepEqual(D.byOrder([{ id: "b", order: "V" }, { id: "a", order: "V" }, { id: "c", order: "A" }]).map((i) => i.id), ["c", "a", "b"]);
});

// ---- the session, against a scripted socket
class FakeSocket {
  constructor() { this.sent = []; this.readyState = 0; FakeSocket.last = this; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.onclose && this.onclose({}); }
  say(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
}
const tick = () => new Promise((r) => setTimeout(r, 5));
async function session(extra = {}) {
  const events = [];
  const s = new S.ItemDocSession({ docId: "d1", signedIn: true, expectKind: "part-studio", socketUrl: "ws://test", fetchTicket: async () => "ticket", WebSocketImpl: FakeSocket,
    onChange: (ids, origin) => events.push([origin, ids ? Array.from(ids).sort().join(",") : "*"]), onStatus: (st) => events.push(["status", st.text]), onNotice: (t) => events.push(["notice", t]), ...extra });
  s.start(); await tick(); await tick();
  const sock = FakeSocket.last;
  return { s, sock, events };
}

test("a session joins, loads the snapshot and the edits since, and applies remote ops in order", async () => {
  const { s, sock, events } = await session();
  assert.deepEqual(sock.sent[0], { type: "hello", proto: 1, token: "ticket", clientId: sock.sent[0].clientId, linkToken: null, client: "web" });
  sock.say({ type: "hello_ok", clientId: "u1:web-x" });
  assert.deepEqual(sock.sent[1], { type: "join_doc", docId: "d1" });
  sock.say({ type: "doc_info", docId: "d1", role: "editor", headSeq: 2, peers: [] });
  sock.say({ type: "snapshot", docId: "d1", seq: 0, file: FILE, thenOps: [{ seq: 1, changes: [{ id: "b", kind: "MODIFIED", props: [{ path: ["params", "depth"], value: 6 }] }] }, { seq: 2, changes: [{ id: "a", kind: "REMOVED" }] }] });
  assert.equal(s.doc.items.get("b").params.depth, 6);
  assert.equal(s.doc.items.has("a"), false);
  assert.equal(s.status.canEdit, true);
  sock.say({ type: "op", docId: "d1", seq: 3, author: {}, changes: [{ id: "b", kind: "MODIFIED", props: [{ path: ["name"], value: "From Bob" }] }] });
  assert.equal(s.doc.items.get("b").name, "From Bob");
  sock.say({ type: "op", docId: "d1", seq: 3, author: {}, changes: [{ id: "b", kind: "MODIFIED", props: [{ path: ["name"], value: "replayed" }] }] });
  assert.equal(s.doc.items.get("b").name, "From Bob", "an op already applied is skipped");
  sock.say({ type: "op", docId: "d1", seq: 9, author: {}, changes: [{ id: "b", kind: "REMOVED" }] });
  assert.ok(s.doc.items.has("b"), "an op after a gap is not applied");
  assert.deepEqual(sock.sent[sock.sent.length - 1], { type: "resync", docId: "d1" });
  assert.deepEqual(events.filter((e) => e[0] === "load" || e[0] === "remote"), [["load", "*"], ["remote", "b"]]);
  s.close();
});

test("a local edit is applied at once, sent, kept until acknowledged, and stays on top of what arrives before its ack", async () => {
  const { s, sock } = await session();
  sock.say({ type: "hello_ok", clientId: "c" }); sock.say({ type: "doc_info", docId: "d1", role: "editor", peers: [] });
  sock.say({ type: "snapshot", docId: "d1", seq: 4, file: FILE, thenOps: [] });
  assert.ok(s.commit([{ id: "b", kind: "MODIFIED", props: [{ path: ["params", "depth"], value: 20 }] }]));
  assert.equal(s.doc.items.get("b").params.depth, 20);
  const op = sock.sent[sock.sent.length - 1];
  assert.equal(op.type, "op"); assert.deepEqual(op.changes[0].props, [{ path: ["params", "depth"], value: 20 }]);
  assert.equal(s.unsaved, 1);
  // somebody else's edit to the same path is sequenced first: ours, still unacknowledged, stays the last word here
  sock.say({ type: "op", docId: "d1", seq: 5, author: {}, changes: [{ id: "b", kind: "MODIFIED", props: [{ path: ["params", "depth"], value: 7 }, { path: ["name"], value: "theirs" }] }] });
  assert.equal(s.doc.items.get("b").params.depth, 20);
  assert.equal(s.doc.items.get("b").name, "theirs", "their edit to another path is kept");
  sock.say({ type: "ack", docId: "d1", clientOpId: op.clientOpId, seq: 6 });
  assert.equal(s.unsaved, 0);
  sock.say({ type: "op", docId: "d1", seq: 7, author: {}, changes: [{ id: "b", kind: "MODIFIED", props: [{ path: ["params", "depth"], value: 1 }] }] });
  assert.equal(s.doc.items.get("b").params.depth, 1, "after the ack the next writer wins");
  // undo and redo are ordinary edits
  assert.ok(s.canUndo);
  s.undo();
  assert.equal(s.doc.items.get("b").params.depth, 5);
  assert.deepEqual(sock.sent[sock.sent.length - 1].changes[0].props, [{ path: ["params", "depth"], value: 5 }]);
  s.redo();
  assert.equal(s.doc.items.get("b").params.depth, 20);
  s.close();
});

test("an edit made while the socket is down is sent again after the reconnect; a viewer cannot edit", async () => {
  const { s, sock } = await session();
  sock.say({ type: "hello_ok", clientId: "c" }); sock.say({ type: "doc_info", docId: "d1", role: "editor", peers: [] });
  sock.say({ type: "snapshot", docId: "d1", seq: 4, file: FILE, thenOps: [] });
  sock.readyState = 3;
  s.commit([{ id: "a", kind: "REMOVED" }]);
  assert.equal(s.unsaved, 1);
  sock.onclose({});
  await new Promise((r) => setTimeout(r, 1100));   // the first retry is a second later
  await tick();
  const again = FakeSocket.last;
  assert.notEqual(again, sock);
  again.say({ type: "hello_ok", clientId: "c" });
  assert.deepEqual(again.sent[1], { type: "join_doc", docId: "d1", sinceSeq: 4 });
  again.say({ type: "doc_info", docId: "d1", role: "editor", peers: [] });
  const resent = again.sent.find((m) => m.type === "op");
  assert.deepEqual(resent.changes, [{ id: "a", kind: "REMOVED" }]);
  again.say({ type: "ops", docId: "d1", from: 5, ops: [] });
  again.say({ type: "ack", docId: "d1", clientOpId: resent.clientOpId, seq: 5 });
  assert.equal(s.unsaved, 0);
  s.close();

  const v = await session();
  v.sock.say({ type: "hello_ok", clientId: "c" }); v.sock.say({ type: "doc_info", docId: "d1", role: "viewer", peers: [] });
  v.sock.say({ type: "snapshot", docId: "d1", seq: 4, file: FILE, thenOps: [] });
  assert.equal(v.s.commit([{ id: "a", kind: "REMOVED" }]), false);
  assert.ok(v.s.doc.items.has("a"));
  assert.ok(v.events.some((e) => e[0] === "notice" && /view-only/.test(e[1])));
  v.s.close();
});
