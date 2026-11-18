// Node test for the sketcher's own logic (web/domains/mechanical/sketch): expressions, editing a sketch as a
// draft, inference while drawing, the constraint and dimension tools' rules, the shapes the drawing tools make,
// and fillet, trim, extend, offset and mirror — each result put through the real solver.
// Run: node server/static/tests/sketch-ops.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./sketch-load");

const X = load("domains/mechanical/sketch/expr.ts");
const M = load("domains/mechanical/sketch/model.ts");
const I = load("domains/mechanical/sketch/infer.ts");
const C = load("domains/mechanical/sketch/constrain.ts");
const D = load("domains/mechanical/sketch/dimension.ts");
const Dims = load("domains/mechanical/sketch/dims.ts");
const O = load("domains/mechanical/sketch/ops.ts");
const S = load("domains/mechanical/sketch/shapes.ts");
const R = load("domains/mechanical/sketch/refs.ts");
const P = load("domains/mechanical/sketch/planar.ts");
const L = load("domains/mechanical/sketch/solver/load.ts");

const pt = (x, y) => ({ type: "point", x, y });
const sketch = (entities = {}, constraints = {}) => ({ version: 1, entities, constraints });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const types = (data, map = "entities") => { const n = {}; for (const e of Object.values(data[map])) n[e.type] = (n[e.type] || 0) + 1; return n; };
const xy = (data, id) => [data.entities[id].x, data.entities[id].y];
const has = (data, x, y, eps = 1e-6) => Object.values(data.entities).some((e) => e.type === "point" && Math.abs(e.x - x) < eps && Math.abs(e.y - y) < eps);
const snapAt = (p, extra = {}) => ({ p, hints: [], guides: [], ...extra });
/** A 40 × 20 box from the origin: p1…p4 counter-clockwise, lines a (bottom), b (right), c (top), d (left). */
const box = () => ({
  p1: pt(0, 0), p2: pt(40, 0), p3: pt(40, 20), p4: pt(0, 20),
  a: { type: "line", a: "p1", b: "p2" }, b: { type: "line", a: "p2", b: "p3" }, c: { type: "line", a: "p3", b: "p4" }, d: { type: "line", a: "p4", b: "p1" },
});
const solved = async (data) => { const s = await L.loadSolver(); const r = s.solve(data); assert.ok(r.ok, "the result solves: " + JSON.stringify({ conflicting: r.conflicting })); return r; };

test("expressions: arithmetic, units, functions, and what is refused", () => {
  const len = (t) => X.evaluate(t, "length").value, ang = (t) => X.evaluate(t, "angle").value;
  assert.equal(len("40"), 40); assert.equal(len(" 12.5 mm "), 12.5); assert.equal(len("1 in"), 25.4); assert.equal(len("2cm"), 20);
  assert.equal(len("3/8 in"), 9.525); assert.equal(len("1 in + 4.6"), 30); assert.equal(len("(10 + 5) * 2"), 30); assert.equal(len("2^3"), 8);
  assert.equal(len("10 mm / 4"), 2.5); assert.equal(len("2 * 3 mm"), 6); assert.equal(len("-(2 - 5)"), 3); assert.equal(len("0,5"), 0.5);
  near(len("sqrt(2) * 10"), 14.142135624, 1e-8); assert.equal(len('1"'), 25.4); assert.equal(len("1 ft"), 304.8);
  assert.equal(ang("45"), 45); assert.equal(ang("90 deg / 4"), 22.5); near(ang("pi/4 rad"), 45, 1e-9);
  assert.equal(X.evaluate("40", "length").isExpression, false); assert.equal(X.evaluate("20 * 2", "length").isExpression, true);
  for (const bad of ["", "abc", "1 +", "(2", "1 / 0", "5 mm * 2 mm", "2 furlongs"]) assert.equal(X.tryEvaluate(bad, "length"), null, bad);
  assert.throws(() => X.evaluate("oops", "length"), /not something/);
});

test("a draft: deleting takes what hangs on it, and the change lists only what differs", () => {
  const before = sketch({ ...box(), hc: pt(10, 10), hole: { type: "circle", center: "hc", r: 3 } }, {
    h: { type: "horizontal", refs: [{ entity: "a" }] }, w: { type: "distance", refs: [{ entity: "a" }], value: 40 },
    on: { type: "coincident", refs: [{ entity: "hc" }, { entity: "$origin" }] }, corner: { type: "fix", refs: [{ entity: "p3" }] },
  });
  const d = new M.Draft(before);
  d.remove(["a"]);
  assert.deepEqual(Object.keys(d.data.entities).sort(), ["b", "c", "d", "hc", "hole", "p1", "p2", "p3", "p4"], "its points are still used by its neighbours");
  assert.deepEqual(Object.keys(d.data.constraints).sort(), ["corner", "on"]);
  d.remove(["hole"]);
  assert.ok(!d.data.entities.hc && !d.data.constraints.on, "a circle takes its centre and what was tied to it");
  d.remove(["p3"]);
  assert.deepEqual(Object.keys(d.data.entities).sort(), ["d", "p1", "p4"], "a point takes the curves that end on it, and the points they leave loose");
  assert.equal(before.entities.a.type, "line", "the original is untouched");
  const change = M.sketchChange("f1", before, d.data);
  assert.equal(change.kind, "MODIFIED");
  assert.deepEqual(change.props.filter((p) => p.del).map((p) => p.path.join(".")).sort(), ["a", "b", "c", "hc", "hole", "p2", "p3"].map((i) => "params.sketch.entities." + i).concat(["corner", "h", "on", "w"].map((i) => "params.sketch.constraints." + i)).sort());
  assert.equal(M.sketchChange("f1", before, new M.Draft(before).data), null);

  const e = new M.Draft(sketch(box()));
  const k1 = e.constrain("horizontal", ["a"]), k2 = e.constrain("horizontal", ["a"]);
  assert.equal(k1, k2, "the same constraint is not added twice");
  assert.notEqual(e.constrain("distance", ["a"], { value: 40 }), e.constrain("distance", ["a"], { value: 40 }));
  e.merge("p2", "p4");
  assert.equal(e.data.entities.a.b, "p4"); assert.equal(e.data.entities.b.a, "p4"); assert.ok(!e.data.entities.p2);
});

test("inference: where the pointer snaps and what the click will tie together", () => {
  const data = sketch({ ...box(), cc: pt(80, 0), k: { type: "circle", center: "cc", r: 10 } });
  const ctx = { data, px: 0.1 };
  let s = I.snap([39.6, 0.3], ctx);
  assert.equal(s.point, "p2"); assert.deepEqual(s.p, [40, 0]); assert.equal(s.hints[0].kind, "point");
  s = I.snap([0.3, -0.2], { data: sketch(), px: 0.1 });
  assert.ok(s.origin); assert.deepEqual(s.p, [0, 0]);
  s = I.snap([20.4, 0.2], ctx);
  assert.equal(s.midpoint, "a"); assert.deepEqual(s.p, [20, 0]);
  s = I.snap([31, 20.3], ctx);
  assert.equal(s.on, "c"); near(s.p[1], 20); near(s.p[0], 31);
  s = I.snap([80 + 10.2 * Math.SQRT1_2, 10.2 * Math.SQRT1_2], ctx);
  assert.equal(s.on, "k"); near(Math.hypot(s.p[0] - 80, s.p[1]), 10);
  // free space: a tidy number, and level with or square above where the stroke started
  s = I.snap([57.13, 43.38], ctx);
  assert.deepEqual(s.p, [57, 43.5]);
  s = I.snap([70.2, 40.2], { ...ctx, from: [50, 40] });
  assert.ok(s.horizontal); assert.deepEqual(s.p, [70, 40]);
  s = I.snap([50.3, 61], { ...ctx, from: [50, 40] });
  assert.ok(s.vertical); assert.deepEqual(s.p, [50, 61]);
  // square to the line before it in a chain
  const slant = sketch({ a1: pt(0, 0), a2: pt(30, 30), l: { type: "line", a: "a1", b: "a2" } });
  s = I.snap([40.2, 20.1], { data: slant, px: 0.1, from: [30, 30], after: "l" });
  assert.equal(s.perpendicularTo, "l"); near((s.p[0] - 30) + (s.p[1] - 30), 0, 1e-9);
  // a stroke that just touches a circle is tangent to it
  const tp = [80 - 10 * 0.25, 10 * Math.sqrt(1 - 0.0625)];   // the tangent point seen from (40, 0): cos = r / d = 0.25
  s = I.snap([tp[0] + 0.2, tp[1] + 0.1], { ...ctx, from: [40, 0] });
  assert.equal(s.tangentTo, "k"); near(s.p[0], tp[0], 1e-9); near(s.p[1], tp[1], 1e-9);
  // the point a snap stands for, and the constraints that hold it there
  const d = new M.Draft(data);
  assert.equal(I.pointFor(d, I.snap([39.6, 0.3], ctx)), "p2");
  const m = I.pointFor(d, I.snap([20.4, 0.2], ctx));
  assert.deepEqual(Object.values(d.data.constraints).map((c) => c.type + ":" + c.refs.map((r) => r.entity).join()), ["midpoint:" + m + ",a"]);
  assert.equal(I.gridStep(0.1), 0.5); assert.equal(I.gridStep(0.3), 2); assert.equal(I.gridStep(0.02), 0.1);
});

test("the constraint tools: what a selection makes for each kind", () => {
  const data = sketch({ ...box(), c1: pt(10, 10), k1: { type: "circle", center: "c1", r: 3 }, c2: pt(30, 10), k2: { type: "circle", center: "c2", r: 4 } });
  const plan = (kind, ...sel) => C.plan(kind, data, sel);
  const made = (p) => p.add.map((c) => c.type + ":" + c.refs.join());
  assert.equal(plan("coincident", "p1"), "more");
  assert.deepEqual(made(plan("coincident", "p1", "c1")), ["coincident:p1,c1"]);
  assert.deepEqual(made(plan("coincident", "k1", "p1")), ["coincident:p1,k1"]);
  assert.ok(plan("coincident", "a", "b").error);
  assert.deepEqual(made(plan("horizontal", "a", "c")), ["horizontal:a", "horizontal:c"]);
  assert.equal(plan("horizontal", "c1"), "more");
  assert.deepEqual(made(plan("vertical", "c1", "c2")), ["vertical:c1,c2"]);
  assert.deepEqual(made(plan("parallel", "a", "c")), ["parallel:a,c"]);
  assert.deepEqual(made(plan("perpendicular", "a", "b")), ["perpendicular:a,b"]);
  assert.ok(plan("parallel", "a", "k1").error);
  assert.deepEqual(made(plan("equal", "a", "b", "c")), ["equal:a,b", "equal:a,c"]);
  assert.deepEqual(made(plan("equal", "k1", "k2")), ["equal:k1,k2"]);
  assert.ok(plan("equal", "a", "k1").error);
  assert.deepEqual(made(plan("tangent", "k1", "a")), ["tangent:a,k1"]);
  assert.ok(plan("tangent", "a", "b").error);
  assert.deepEqual(made(plan("midpoint", "a", "c1")), ["midpoint:c1,a"]);
  assert.deepEqual(made(plan("concentric", "k1", "k2")), ["concentric:k1,k2"]);
  assert.equal(plan("symmetric", "c1", "c2"), "more");
  assert.deepEqual(made(plan("symmetric", "c1", "c2", "b")), ["symmetric:c1,c2,b"]);
  assert.deepEqual(made(plan("symmetric", "c1", "c2", "$origin")), ["symmetric:c1,c2,$origin"]);
  assert.deepEqual(made(plan("fix", "p1", "k1")), ["fix:p1", "fix:k1"]);
  for (const kind of Object.keys(C.NEEDS)) assert.equal(C.plan(kind, data, []), "more");
});

test("the Dimension tool: what is picked, and where the text is put, decide the dimension", () => {
  const data = sketch({ ...box(), q: pt(60, 30), c1: pt(10, 10), k1: { type: "circle", center: "c1", r: 3 }, a1: pt(70, 0), a2: pt(80, 0), a3: pt(70, 10), arc: { type: "arc", center: "a1", start: "a2", end: "a3" },
    s1: pt(0, 40), s2: pt(30, 60), slant: { type: "line", a: "s1", b: "s2" } });
  const c = (picks, at) => D.candidate(data, picks, at);
  const show = (k) => k && k.type + (k.axis ? "/" + k.axis : "") + ":" + k.refs.map((r) => r.entity + (r.at ? "@" + r.at : "")).join();
  assert.equal(show(c(["a"], [20, -10])), "distance:a");
  assert.equal(show(c(["k1"], [20, 20])), "diameter:k1");
  assert.equal(show(c(["arc"], [90, 10])), "radius:arc");
  assert.equal(show(c(["slant"], [15, 70])), "distance/x:slant", "above a slanted line: its horizontal extent");
  assert.equal(show(c(["slant"], [-10, 50])), "distance/y:slant", "beside it: its vertical extent");
  assert.equal(show(c(["slant"], [40, 70])), "distance:slant", "off its corner: its length");
  assert.equal(show(c(["p1", "q"], [30, -10])), "distance/x:p1,q");
  assert.equal(show(c(["p1", "q"], [70, 15])), "distance/y:p1,q");
  assert.equal(show(c(["p1", "q"], [80, 50])), "distance:p1,q");
  assert.equal(show(c(["p1", "p2"], [20, -10])), "distance:p1,p2", "level points: the plain distance");
  assert.equal(show(c(["k1", "d"], [5, 30])), "distance:k1@center,d", "a circle stands for its centre");
  assert.equal(show(c(["k1", "arc"], [40, -10])), "distance/x:k1@center,arc@center");
  assert.equal(show(c(["a", "c"], [50, 10])), "distance:a,c", "parallel lines: the distance between them");
  assert.equal(show(c(["a", "b"], [35, 5])), "angle:a,b");
  assert.equal(c(["p1"], [5, 5]), null);
  // how they are drawn
  const w = { type: "distance", refs: [{ entity: "a" }], value: 40, label: { x: 20, y: -8 } };
  const dw = Dims.drawDimension(data, w, 0.1);
  assert.equal(dw.text, "40"); assert.equal(dw.arrows.length, 2); assert.equal(dw.lines.length, 3);
  assert.deepEqual(dw.arrows.map((x) => x.at), [[0, -8], [40, -8]]);
  assert.equal(Dims.dimensionText(data, { type: "diameter", refs: [{ entity: "k1" }], value: 6 }), "Ø 6");
  assert.equal(Dims.dimensionText(data, { type: "radius", refs: [{ entity: "arc" }], driving: false }), "(R 10)");
  assert.equal(Dims.dimensionText(data, { type: "angle", refs: [{ entity: "a" }, { entity: "b" }], value: 90 }), "90°");
  near(R.measure(data, { type: "distance", refs: [{ entity: "k1", at: "center" }, { entity: "d" }] }), 10);
  near(R.measure(data, { type: "angle", refs: [{ entity: "a" }, { entity: "b" }] }), 90);
  const da = Dims.drawDimension(data, { type: "angle", refs: [{ entity: "a" }, { entity: "b" }], value: 90, label: { x: 30, y: 8 } }, 0.1);
  assert.equal(da.arcs.length, 1); near(da.arcs[0].a1 - da.arcs[0].a0, Math.PI / 2);
});

test("the shapes the drawing tools make solve, with the freedoms a person expects", async () => {
  const s = await L.loadSolver();
  const make = (spec, pts, typed = {}, from = sketch()) => { const d = new M.Draft(from); assert.ok(spec.build(d, pts, typed, null), spec.id + " builds"); return d.data; };
  const dof = (data) => { const r = s.solve(data); assert.ok(r.ok, "solves"); return s.solve(r.data).dof; };

  let d = make(S.line, [snapAt([0, 0], { origin: true }), snapAt([30, 0], { horizontal: true })], { length: 30 });
  assert.deepEqual(types(d, "constraints"), { coincident: 1, horizontal: 1, distance: 1 }); assert.equal(dof(d), 0);

  d = make(S.rectangle, [snapAt([40, 30]), snapAt([10, 10])]);
  assert.deepEqual(types(d), { point: 4, line: 4 }); assert.deepEqual(types(d, "constraints"), { horizontal: 2, vertical: 2 }); assert.equal(dof(d), 4);
  assert.equal(P.findRegions(d).regions.length, 1);
  d = make(S.rectangle, [snapAt([0, 0], { origin: true }), snapAt([40, 20])], { width: 40, height: 20 });
  assert.equal(dof(d), 0);

  d = make(S.centerRectangle, [snapAt([0, 0], { origin: true }), snapAt([20, 10])]);
  assert.deepEqual(types(d), { point: 5, line: 5 }); assert.equal(dof(d), 2, "a rectangle about the origin has a width and a height");
  assert.equal(P.findRegions(d).regions.length, 1, "the construction diagonal cuts nothing");
  const wide = s.solve(d, { drag: [{ point: Object.keys(d.entities).find((id) => d.entities[id].x === 20 && d.entities[id].y === 10), to: [35, 12] }] });
  assert.ok(has(wide.data, -35, -12, 1e-5), "dragging a corner keeps it centred");

  d = make(S.circle, [snapAt([5, 5]), snapAt([8, 9])], { diameter: 10 });
  assert.equal(Object.values(d.entities).find((e) => e.type === "circle").r, 5); assert.equal(dof(d), 2);

  d = make(S.arc3, [snapAt([10, 0]), snapAt([-10, 0]), snapAt([0, 10])]);
  let arc = R.resolveEntity(d, Object.keys(d.entities).find((id) => d.entities[id].type === "arc"));
  near(arc.c[0], 0); near(arc.c[1], 0); assert.deepEqual(arc.s, [10, 0]); assert.equal(dof(d), 5);
  d = make(S.arc3, [snapAt([10, 0]), snapAt([-10, 0]), snapAt([0, -10])]);
  arc = R.resolveEntity(d, Object.keys(d.entities).find((id) => d.entities[id].type === "arc"));
  assert.deepEqual(arc.s, [-10, 0], "through a point below, the arc runs the other way round");

  // a tangent arc off the end of a line
  const stub = sketch({ a: pt(0, 0), b: pt(20, 0), l: { type: "line", a: "a", b: "b" } });
  assert.match(String(S.arcTangent.accept([], snapAt([50, 50]), stub)), /end of a line/);
  assert.equal(S.arcTangent.accept([], snapAt([20, 0], { point: "b" }), stub), true);
  d = make(S.arcTangent, [snapAt([20, 0], { point: "b" }), snapAt([30, 10])], {}, stub);
  arc = R.resolveEntity(d, Object.keys(d.entities).find((id) => d.entities[id].type === "arc"));
  near(arc.c[0], 20); near(arc.c[1], 10); assert.equal(arc.e.start, "b");
  assert.deepEqual(types(d, "constraints"), { tangent: 1 });
  const pulled = s.solve(d, { drag: [{ point: "a", to: [0, 6] }] });
  const pa = R.resolveEntity(pulled.data, arc.id), pl = R.resolveEntity(pulled.data, "l");
  near((pl.b[0] - pl.a[0]) * (pa.c[0] - pl.b[0]) + (pl.b[1] - pl.a[1]) * (pa.c[1] - pl.b[1]), 0, 1e-5);   // still tangent after a drag
  assert.deepEqual(S.tangentArc([0, 0], [1, 0], [10, -10]), { c: [0, -10], ccw: false });
  assert.equal(S.tangentArc([0, 0], [1, 0], [10, 0]), null);

  d = make(S.slot, [snapAt([0, 0]), snapAt([30, 0], { horizontal: true }), snapAt([30, 5])], { width: 10 });
  assert.deepEqual(types(d), { point: 6, line: 3, arc: 2 }); assert.deepEqual(types(d, "constraints"), { tangent: 4, equal: 1, horizontal: 1, radius: 1 });
  assert.equal(dof(d), 3, "a level slot of a set width can still move and change length");
  assert.equal(P.findRegions(d).regions.length, 1);

  const ca = S.centerArc();
  ca.preview([snapAt([0, 0]), snapAt([10, 0])], snapAt([8, 6]), sketch());
  d = make(ca, [snapAt([0, 0]), snapAt([10, 0]), snapAt([0, 12])]);
  arc = R.resolveEntity(d, Object.keys(d.entities).find((id) => d.entities[id].type === "arc"));
  assert.deepEqual(arc.s, [10, 0]); near(arc.en[0], 0); near(arc.en[1], 10);
});

test("fillet: a tangent arc with its radius, and what was said about the corner still holds", async () => {
  const k = { h: { type: "horizontal", refs: [{ entity: "a" }] }, v: { type: "vertical", refs: [{ entity: "b" }] }, w: { type: "distance", refs: [{ entity: "a" }], value: 40 }, o: { type: "coincident", refs: [{ entity: "p1" }, { entity: "$origin" }] } };
  const d = new M.Draft(sketch(box(), k));
  assert.equal(O.fillet(d, "p2", 5), null);
  assert.deepEqual(types(d.data), { point: 7, line: 4, arc: 1 });
  assert.ok(has(d.data, 35, 0) && has(d.data, 40, 5) && has(d.data, 35, 5));
  assert.deepEqual(d.data.constraints.w.refs, [{ entity: "p1" }, { entity: "p2" }], "the width still runs to the sharp corner");
  assert.equal(types(d.data, "constraints").tangent, 2); assert.equal(types(d.data, "constraints").radius, 1);
  const r = await solved(d.data);
  assert.ok(has(r.data, 35, 0) && has(r.data, 40, 5), "nothing moved: the fillet was built where the constraints want it");
  // a bigger radius, set through its dimension, moves the tangent points
  const rid = Object.keys(d.data.constraints).find((id) => d.data.constraints[id].type === "radius");
  const bigger = await solved({ ...d.data, constraints: { ...d.data.constraints, [rid]: { ...d.data.constraints[rid], value: 8 } } });
  assert.ok(has(bigger.data, 32, 0, 1e-5) && has(bigger.data, 40, 8, 1e-5) && has(bigger.data, 40, 0, 1e-5));
  // a corner nothing refers to goes
  const plain = new M.Draft(sketch(box()));
  assert.equal(O.fillet(plain, "p3", 4), null);
  assert.ok(!plain.data.entities.p3);
  assert.equal(P.findRegions(plain.data).regions.length, 1, "the outline is still closed");
  assert.match(O.fillet(new M.Draft(sketch(box())), "p1", 30), /too large/);
  assert.match(O.fillet(new M.Draft(sketch(box())), "p1", 0), /more than zero/);
  assert.match(O.fillet(new M.Draft(sketch({ a: pt(0, 0) })), "a", 2), /corner where two lines meet/);
});

test("trim and extend", async () => {
  // a line across the box, sticking out at both ends
  const data = sketch({ ...box(), q1: pt(15, -5), q2: pt(15, 25), cut: { type: "line", a: "q1", b: "q2" } });
  let d = new M.Draft(data);
  assert.equal(O.trim(d, "cut", [15, 23]), null);
  assert.ok(has(d.data, 15, 20) && !has(d.data, 15, 25));
  assert.equal(O.trim(d, "cut", [15, -2]), null);
  assert.ok(has(d.data, 15, 0) && !has(d.data, 15, -5));
  assert.deepEqual(types(d.data, "constraints"), { coincident: 2 });
  assert.equal(P.findRegions(d.data).regions.length, 2);
  await solved(d.data);
  // the middle of a side, between two crossing lines: the side becomes two
  const two = sketch({ ...box(), q1: pt(10, -5), q2: pt(10, 5), q3: pt(30, -5), q4: pt(30, 5), u: { type: "line", a: "q1", b: "q2" }, w: { type: "line", a: "q3", b: "q4" } });
  d = new M.Draft(two);
  assert.equal(O.trim(d, "a", [20, 0]), null);
  assert.equal(types(d.data).line, 7);
  const pieces = Object.values(d.data.entities).filter((e) => e.type === "line" && [e.a, e.b].every((p) => d.data.entities[p].y === 0)).map((e) => [d.data.entities[e.a].x, d.data.entities[e.b].x]);
  assert.deepEqual(pieces.sort((p, q) => p[0] - q[0]), [[0, 10], [30, 40]]);
  // a curve nothing crosses goes altogether
  d = new M.Draft(sketch({ s1: pt(0, 0), s2: pt(5, 5), lone: { type: "line", a: "s1", b: "s2" } }));
  O.trim(d, "lone", [2, 2]);
  assert.deepEqual(d.data.entities, {});
  // a circle cut by a line becomes an arc: the side that was clicked goes
  const round = sketch({ c: pt(0, 0), k: { type: "circle", center: "c", r: 10 }, q1: pt(-20, 0), q2: pt(20, 0), l: { type: "line", a: "q1", b: "q2" } }, { dia: { type: "diameter", refs: [{ entity: "k" }], value: 20 } });
  d = new M.Draft(round);
  assert.equal(O.trim(d, "k", [0, 10]), null);
  assert.equal(d.data.entities.k.type, "arc");
  const arc = R.resolveEntity(d.data, "k");
  assert.deepEqual(arc.s, [-10, 0]); assert.deepEqual(arc.en, [10, 0]);   // counter-clockwise through the bottom
  const r = await solved(d.data);
  near(R.resolveEntity(r.data, "k").r, 10);
  assert.ok(d.data.constraints.dia, "its diameter is still dimensioned");
  // extend: to the next curve beyond the end that was clicked
  d = new M.Draft(sketch({ ...box(), s1: pt(10, 10), s2: pt(20, 10), stub: { type: "line", a: "s1", b: "s2" } }));
  assert.equal(O.extend(d, "stub", [19, 10]), null);
  assert.ok(has(d.data, 40, 10) && has(d.data, 10, 10) && !has(d.data, 20, 10));
  assert.equal(O.extend(d, "stub", [11, 10]), null);
  assert.ok(has(d.data, 0, 10));
  assert.deepEqual(types(d.data, "constraints"), { coincident: 2 });
  assert.match(O.extend(new M.Draft(sketch({ s1: pt(0, 0), s2: pt(5, 0), l: { type: "line", a: "s1", b: "s2" } })), "l", [5, 0]), /Nothing lies beyond/);
  // an arc runs on round its circle
  d = new M.Draft(sketch({ c: pt(0, 0), s: pt(10, 0), e: pt(0, 10), arc: { type: "arc", center: "c", start: "s", end: "e" }, w1: pt(-12, -5), w2: pt(-5, 12), wall: { type: "line", a: "w1", b: "w2" } }));
  assert.equal(O.extend(d, "arc", [0.5, 10]), null);
  const ext = R.resolveEntity(d.data, "arc");
  assert.ok(ext.en[0] < -1 && Math.abs(Math.hypot(...ext.en) - 10) < 1e-9, JSON.stringify(ext.en));
});

test("offset: an outline moves over as one, corners remade, and stays driven by one distance", async () => {
  let d = new M.Draft(sketch(box()));
  assert.deepEqual(O.chainOf(d.data, "a").map((c) => c.id).sort(), ["a", "b", "c", "d"]);
  assert.equal(O.offset(d, ["a", "b", "c", "d"], 3, [20, 10]), null);
  assert.deepEqual(types(d.data), { point: 8, line: 8 });
  for (const c of [[3, 3], [37, 3], [37, 17], [3, 17]]) assert.ok(has(d.data, c[0], c[1]), "inside corner " + c);
  assert.deepEqual(types(d.data, "constraints"), { parallel: 4, distance: 1 });
  const found = P.findRegions(d.data);
  assert.equal(found.regions.length, 1, "a frame: the inner outline is a hole in the outer"); near(found.regions[0].holes[0].area, 34 * 14);
  // the distance drives it
  const id = Object.keys(d.data.constraints).find((k) => d.data.constraints[k].type === "distance");
  const fixed = { ...d.data.constraints, f: { type: "fix", refs: [{ entity: "a" }, { entity: "c" }] }, [id]: { ...d.data.constraints[id], value: 5 } };
  const r = await solved({ ...d.data, constraints: fixed });
  assert.ok(Object.values(r.data.entities).some((e) => e.type === "point" && Math.abs(e.y - 5) < 1e-5), "the offset line moved to 5 from its original");
  // outwards
  d = new M.Draft(sketch(box()));
  O.offset(d, ["a", "b", "c", "d"], 2, [50, 10]);
  assert.ok(has(d.data, -2, -2) && has(d.data, 42, 22));
  // a line and an arc that join; and a circle, which keeps its centre
  const round = sketch({ a: pt(0, 0), b: pt(20, 0), c: pt(20, 10), e: pt(30, 10), l: { type: "line", a: "a", b: "b" }, arc: { type: "arc", center: "c", start: "b", end: "e" }, kc: pt(60, 0), k: { type: "circle", center: "kc", r: 5 } });
  d = new M.Draft(round);
  assert.equal(O.offset(d, ["l", "arc"], 2, [10, 5]), null);
  assert.ok(has(d.data, 0, 2) && has(d.data, 20, 2) && has(d.data, 28, 10));
  assert.equal(Object.values(d.data.entities).filter((x) => x.type === "arc" && x.center === "c").length, 2, "the offset arc shares the centre");
  assert.equal(O.offset(d, ["k"], 2, [70, 0]), null);
  assert.deepEqual(Object.values(d.data.entities).filter((x) => x.type === "circle").map((x) => x.r).sort(), [5, 7]);
  assert.equal(O.offset(d, ["k"], 1, [61, 0]), null);
  assert.ok(Object.values(d.data.entities).some((x) => x.type === "circle" && x.r === 4));
  assert.match(O.offset(new M.Draft(round), ["k"], 9, [60, 0]), /nothing/);
  assert.match(O.offset(new M.Draft(round), [], 2, [0, 0]), /Select/);
});

test("mirror: copies that stay mirror images", async () => {
  const data = sketch({ m1: pt(0, -10), m2: pt(0, 30), axis: { type: "line", a: "m1", b: "m2", construction: true },
    a: pt(0, 0), b: pt(10, 0), l: { type: "line", a: "a", b: "b" }, c: pt(20, 10), k: { type: "circle", center: "c", r: 4 },
    ac: pt(10, 20), as: pt(15, 20), ae: pt(10, 25), arc: { type: "arc", center: "ac", start: "as", end: "ae" } });
  const d = new M.Draft(data);
  assert.equal(O.mirror(d, ["l", "k", "arc", "axis"], "axis"), null);
  assert.deepEqual(types(d.data), { point: 13, line: 3, circle: 2, arc: 2 });
  assert.ok(has(d.data, -10, 0) && has(d.data, -20, 10) && has(d.data, -15, 20) && has(d.data, -10, 25));
  const copy = Object.keys(d.data.entities).find((id) => d.data.entities[id].type === "line" && id !== "l" && id !== "axis");
  assert.ok([d.data.entities[copy].a, d.data.entities[copy].b].includes("a"), "a point on the mirror line is shared, not copied");
  const marc = R.resolveEntity(d.data, Object.keys(d.data.entities).find((id) => d.data.entities[id].type === "arc" && id !== "arc"));
  assert.deepEqual(marc.s, [-10, 25]); assert.deepEqual(marc.en, [-15, 20]);   // turned the other way round
  assert.deepEqual(types(d.data, "constraints"), { symmetric: 5, equal: 1 });
  // move the original, and the image follows
  const s = await L.loadSolver();
  const r = s.solve({ ...d.data, constraints: { ...d.data.constraints, f: { type: "fix", refs: [{ entity: "axis" }] } } }, { drag: [{ point: "c", to: [26, 14] }] });
  assert.ok(r.ok && has(r.data, 26, 14, 1e-4) && has(r.data, -26, 14, 1e-4));
  assert.match(O.mirror(new M.Draft(data), ["l"], "k"), /line to mirror about/);
  assert.match(O.mirror(new M.Draft(data), ["axis"], "axis"), /Select what to mirror/);
});
