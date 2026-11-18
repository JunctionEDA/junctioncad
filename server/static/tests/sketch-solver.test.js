// Node test for the sketch constraint solver (web/domains/mechanical/sketch/solver): the real PlaneGCS build
// runs here, as it does in the page.  Each constraint type, dimensions, conflicts, degrees of freedom, dragging.
// Run: node server/static/tests/sketch-solver.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./sketch-load");

const L = load("domains/mechanical/sketch/solver/load.ts");
const R = load("domains/mechanical/sketch/refs.ts");

const pt = (x, y) => ({ type: "point", x, y });
const sketch = (entities, constraints = {}) => ({ version: 1, entities, constraints });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const P = (r, id) => [r.data.entities[id].x, r.data.entities[id].y];

/** A rough quadrilateral: p1..p4 and l1..l4 round it, counter-clockwise from the lower left. */
const quad = () => ({
  p1: pt(1, 2), p2: pt(38, 3), p3: pt(41, 22), p4: pt(-2, 19),
  l1: { type: "line", a: "p1", b: "p2" }, l2: { type: "line", a: "p2", b: "p3" }, l3: { type: "line", a: "p3", b: "p4" }, l4: { type: "line", a: "p4", b: "p1" },
});
const rectConstraints = () => ({
  h1: { type: "horizontal", refs: [{ entity: "l1" }] }, v2: { type: "vertical", refs: [{ entity: "l2" }] },
  h3: { type: "horizontal", refs: [{ entity: "l3" }] }, v4: { type: "vertical", refs: [{ entity: "l4" }] },
});

test("a rectangle: horizontal and vertical, then dimensions and the origin make it fully constrained", async () => {
  const s = await L.loadSolver();
  let r = s.solve(sketch(quad(), rectConstraints()));
  assert.ok(r.ok);
  assert.equal(r.dof, 4);
  near(P(r, "p1")[1], P(r, "p2")[1]); near(P(r, "p2")[0], P(r, "p3")[0]); near(P(r, "p3")[1], P(r, "p4")[1]); near(P(r, "p4")[0], P(r, "p1")[0]);

  const k = { ...rectConstraints(),
    w: { type: "distance", refs: [{ entity: "l1" }], value: 60 },
    h: { type: "distance", refs: [{ entity: "p1" }, { entity: "p4" }], value: 25, axis: "y" },
    o: { type: "coincident", refs: [{ entity: "p1" }, { entity: "$origin" }] } };
  r = s.solve(sketch(quad(), k));
  assert.ok(r.ok);
  assert.equal(r.dof, 0);
  assert.deepEqual(P(r, "p1"), [0, 0]); assert.deepEqual(P(r, "p2"), [60, 0]); assert.deepEqual(P(r, "p3"), [60, 25]); assert.deepEqual(P(r, "p4"), [0, 25]);
  assert.equal(R.measure(r.data, k.w), 60);
  assert.equal(R.measure(r.data, k.h), 25);
  // every entity is settled
  assert.equal(s.defined(r.data, r.dof).size, 8);
});

test("which entities are settled when the sketch is not", async () => {
  const s = await L.loadSolver();
  const k = { ...rectConstraints(), o: { type: "coincident", refs: [{ entity: "p1" }, { entity: "$origin" }] }, w: { type: "distance", refs: [{ entity: "l1" }], value: 60 } };
  const r = s.solve(sketch(quad(), k));
  assert.equal(r.dof, 1);
  const d = s.defined(r.data, r.dof);
  assert.deepEqual(Array.from(d).sort(), ["l1", "p1", "p2"]);
});

test("conflicting and redundant constraints are named, and the sketch is left as it was", async () => {
  const s = await L.loadSolver();
  const k = { ...rectConstraints(), w: { type: "distance", refs: [{ entity: "l1" }], value: 60 }, w2: { type: "distance", refs: [{ entity: "l3" }], value: 50 } };
  const before = sketch(quad(), k);
  const r = s.solve(before);
  assert.equal(r.ok, false);
  assert.ok(r.conflicting.includes("w") && r.conflicting.includes("w2"), r.conflicting.join());
  assert.equal(r.data, before);
  const red = s.solve(sketch(quad(), { ...rectConstraints(), par: { type: "parallel", refs: [{ entity: "l1" }, { entity: "l3" }] } }));
  assert.ok(red.ok);
  assert.ok(red.redundant.length >= 1 && red.redundant.every((id) => ["par", "h1", "h3"].includes(id)), red.redundant.join());
});

test("parallel, perpendicular, equal, collinear, midpoint, symmetric", async () => {
  const s = await L.loadSolver();
  const e = { ...quad(), m: pt(15, 9), q1: pt(50, 0), q2: pt(70, 2), lq: { type: "line", a: "q1", b: "q2" } };
  const r = s.solve(sketch(e, {
    a: { type: "parallel", refs: [{ entity: "l1" }, { entity: "l3" }] },
    b: { type: "perpendicular", refs: [{ entity: "l1" }, { entity: "l2" }] },
    c: { type: "equal", refs: [{ entity: "l2" }, { entity: "l4" }] },
    d: { type: "midpoint", refs: [{ entity: "m" }, { entity: "l1" }] },
    f: { type: "collinear", refs: [{ entity: "l1" }, { entity: "lq" }] },
    g: { type: "symmetric", refs: [{ entity: "lq", at: "start" }, { entity: "lq", at: "end" }, { entity: "m" }] },
  }));
  assert.ok(r.ok);
  const v = (a, b) => { const p = P(r, a), q = P(r, b); return [q[0] - p[0], q[1] - p[1]]; };
  const cross = (u, w) => u[0] * w[1] - u[1] * w[0], dot = (u, w) => u[0] * w[0] + u[1] * w[1];
  near(cross(v("p1", "p2"), v("p3", "p4")), 0, 1e-5);
  near(dot(v("p1", "p2"), v("p2", "p3")), 0, 1e-5);
  near(Math.hypot(...v("p2", "p3")), Math.hypot(...v("p4", "p1")));
  near(P(r, "m")[0], (P(r, "p1")[0] + P(r, "p2")[0]) / 2); near(P(r, "m")[1], (P(r, "p1")[1] + P(r, "p2")[1]) / 2);
  near(cross(v("p1", "p2"), v("p1", "q1")), 0, 1e-5); near(cross(v("p1", "p2"), v("p1", "q2")), 0, 1e-5);
  near(P(r, "m")[0], (P(r, "q1")[0] + P(r, "q2")[0]) / 2); near(P(r, "m")[1], (P(r, "q1")[1] + P(r, "q2")[1]) / 2);
});

test("circles and arcs: radius, diameter, concentric, equal, point on curve, tangent", async () => {
  const s = await L.loadSolver();
  const e = {
    c1: pt(0, 0), c2: pt(30, 1), k1: { type: "circle", center: "c1", r: 5 }, k2: { type: "circle", center: "c2", r: 7 },
    a: pt(-20, 12), b: pt(40, 13), l: { type: "line", a: "a", b: "b" },
    ac: pt(60, 0), as: pt(70, 0), ae: pt(60, 10.5), arc: { type: "arc", center: "ac", start: "as", end: "ae" },
  };
  const r = s.solve(sketch(e, {
    d: { type: "diameter", refs: [{ entity: "k1" }], value: 24 },
    q: { type: "equal", refs: [{ entity: "k1" }, { entity: "k2" }] },
    t: { type: "tangent", refs: [{ entity: "l" }, { entity: "k1" }] },
    h: { type: "horizontal", refs: [{ entity: "l" }] },
    on: { type: "coincident", refs: [{ entity: "b" }, { entity: "k2" }] },
    ar: { type: "radius", refs: [{ entity: "arc" }], value: 8 },
    eq: { type: "equal", refs: [{ entity: "arc" }, { entity: "k2" }] },
  }));
  assert.equal(r.ok, false, "the arc cannot have radius 8 and equal a circle of radius 12");
  const k = {
    d: { type: "diameter", refs: [{ entity: "k1" }], value: 24 },
    q: { type: "equal", refs: [{ entity: "k1" }, { entity: "k2" }] },
    t: { type: "tangent", refs: [{ entity: "l" }, { entity: "k1" }] },
    h: { type: "horizontal", refs: [{ entity: "l" }] },
    on: { type: "coincident", refs: [{ entity: "b" }, { entity: "k2" }] },
    ar: { type: "radius", refs: [{ entity: "arc" }], value: 8 },
    cc: { type: "concentric", refs: [{ entity: "arc" }, { entity: "k2" }] },
  };
  const ok = s.solve(sketch(e, k));
  assert.ok(ok.ok);
  const E = ok.data.entities;
  near(E.k1.r, 12); near(E.k2.r, 12);
  near(Math.abs(E.a.y - E.c1.y), 12, 1e-5);
  near(Math.hypot(E.b.x - E.c2.x, E.b.y - E.c2.y), 12, 1e-5);
  near(Math.hypot(E.as.x - E.ac.x, E.as.y - E.ac.y), 8, 1e-5); near(Math.hypot(E.ae.x - E.ac.x, E.ae.y - E.ac.y), 8, 1e-5);
  near(E.ac.x, E.c2.x); near(E.ac.y, E.c2.y);
  assert.equal(R.measure(ok.data, k.d), 24);
});

test("a line and an arc that share an end stay tangent on the side they were drawn", async () => {
  const s = await L.loadSolver();
  // a line along +x that runs into an arc turning left (counter-clockwise), drawn a little off tangent
  const e = { a: pt(0, 0), b: pt(20, 0.6), c: pt(20.4, 10), en: pt(30, 10.3), l: { type: "line", a: "a", b: "b" }, arc: { type: "arc", center: "c", start: "b", end: "en" } };
  const r = s.solve(sketch(e, { t: { type: "tangent", refs: [{ entity: "l" }, { entity: "arc" }] }, f: { type: "fix", refs: [{ entity: "a" }] }, h: { type: "horizontal", refs: [{ entity: "l" }] } }));
  assert.ok(r.ok);
  const E = r.data.entities;
  near(E.b.y, 0); near(E.c.x, E.b.x, 1e-5);
  assert.ok(E.c.y > 5, "the centre stayed above the line");
  assert.ok(E.b.x > 10, "the line was not turned round");
});

test("an angle is the one at the corner, and keeps its side", async () => {
  const s = await L.loadSolver();
  const e = { o: pt(0, 0), a: pt(30, 0), b: pt(20, 18), l1: { type: "line", a: "o", b: "a" }, l2: { type: "line", a: "b", b: "o" } };
  const k = { f: { type: "fix", refs: [{ entity: "l1" }] }, ang: { type: "angle", refs: [{ entity: "l1" }, { entity: "l2" }], value: 30 }, len: { type: "distance", refs: [{ entity: "l2" }], value: 20 } };
  near(R.measure(sketch(e), k.ang), Math.atan2(18, 20) * 180 / Math.PI);
  const r = s.solve(sketch(e, k));
  assert.ok(r.ok); assert.equal(r.dof, 0);
  near(r.data.entities.b.x, 20 * Math.cos(Math.PI / 6), 1e-5); near(r.data.entities.b.y, 10, 1e-5);
});

test("dragging: a point follows the pointer as far as the constraints allow", async () => {
  const s = await L.loadSolver();
  const k = { ...rectConstraints(), o: { type: "coincident", refs: [{ entity: "p1" }, { entity: "$origin" }] }, w: { type: "distance", refs: [{ entity: "l1" }], value: 60 } };
  const start = s.solve(sketch(quad(), k)).data;
  const r = s.solve(start, { drag: [{ point: "p3", to: [90, 33] }] });
  assert.ok(r.ok);
  assert.deepEqual(P(r, "p3"), [60, 33]);   // x is held by the width, y is free
  assert.deepEqual(P(r, "p4"), [0, 33]);
  // a circle's rim drags its radius
  const c = s.solve(sketch({ c: pt(0, 0), k: { type: "circle", center: "c", r: 5 } }, { f: { type: "fix", refs: [{ entity: "c" }] } }), { drag: [{ curve: "k", radius: 9 }] });
  near(c.data.entities.k.r, 9);
  // a fixed point does not move
  const f = s.solve(sketch({ a: pt(3, 4) }, { f: { type: "fix", refs: [{ entity: "a" }] } }), { drag: [{ point: "a", to: [10, 10] }] });
  assert.deepEqual(P(f, "a"), [3, 4]);
});

test("a reference dimension, an unknown constraint and a constraint on something deleted are left out", async () => {
  const s = await L.loadSolver();
  const r = s.solve(sketch(quad(), {
    ref: { type: "distance", refs: [{ entity: "l1" }], value: 999, driving: false },
    odd: { type: "something-new", refs: [{ entity: "l1" }] },
    gone: { type: "horizontal", refs: [{ entity: "nope" }] },
  }));
  assert.ok(r.ok);
  assert.deepEqual(r.skipped.sort(), ["gone", "odd"]);
  assert.equal(r.dof, 8);
});

test("a plate of fifty holes: 157 constraints, solved and timed", async () => {
  const s = await L.loadSolver();
  const e = { ...quad() }, k = { ...rectConstraints(), o: { type: "coincident", refs: [{ entity: "p1" }, { entity: "$origin" }] }, w: { type: "distance", refs: [{ entity: "l1" }], value: 200 }, h: { type: "distance", refs: [{ entity: "l2" }], value: 100 } };
  for (let i = 0; i < 50; i++) {
    e["c" + i] = pt(10 + (i % 10) * 18 + 0.3, 10 + Math.floor(i / 10) * 18 - 0.2); e["k" + i] = { type: "circle", center: "c" + i, r: 3 + (i % 3) * 0.1 };
    k["d" + i] = { type: "diameter", refs: [{ entity: "k" + i }], value: 6 };
    k["x" + i] = { type: "distance", refs: [{ entity: "p1" }, { entity: "c" + i }], value: 10 + (i % 10) * 18, axis: "x" };
    k["y" + i] = { type: "distance", refs: [{ entity: "p1" }, { entity: "c" + i }], value: 10 + Math.floor(i / 10) * 18, axis: "y" };
  }
  const r = s.solve(sketch(e, k));
  assert.ok(r.ok); assert.equal(r.dof, 0);
  near(r.data.entities.c37.x, 10 + 7 * 18); near(r.data.entities.c37.y, 10 + 3 * 18); near(r.data.entities.k37.r, 3);
  // one pass from the solved state is what a drag step costs (the time is printed, and only loosely checked:
  // the machine running the tests may be busy)
  const step = s.solve(r.data, { drag: [{ point: "p3", to: [205, 103] }] });
  assert.ok(step.ok);
  assert.ok(step.ms < 2000, `a drag step took ${step.ms} ms`);
  console.log(`    fifty holes, 157 constraints: ${r.ms.toFixed(1)} ms to solve from rough, ${step.ms.toFixed(1)} ms per drag step`);
});
