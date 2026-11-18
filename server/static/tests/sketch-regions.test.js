// Node test for the region finder that copes with crossing curves (web/domains/mechanical/sketch/planar.ts):
// the same answers as sketch/profiles.ts where curves only join end to end, and regions where they cross.
// Run: node server/static/tests/sketch-regions.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");

const P = load("domains/mechanical/sketch/planar.ts");
const Old = load("domains/mechanical/sketch/profiles.ts");

const sketch = (entities) => ({ version: 1, entities, constraints: {} });
const pt = (x, y) => ({ type: "point", x, y });
function rect(prefix, x0, y0, x1, y1) {
  const e = {};
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].forEach((c, i) => { e[`${prefix}p${i}`] = pt(c[0], c[1]); });
  for (let i = 0; i < 4; i++) e[`${prefix}l${i}`] = { type: "line", a: `${prefix}p${i}`, b: `${prefix}p${(i + 1) % 4}` };
  return e;
}
const circle = (id, x, y, r) => ({ [`${id}c`]: pt(x, y), [id]: { type: "circle", center: `${id}c`, r } });
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const areas = (r) => r.regions.map((x) => x.outer.area - x.holes.reduce((s, h) => s + h.area, 0)).sort((a, b) => a - b);
const circleArea = (r) => { const n = 64; return 0.5 * n * r * r * Math.sin(2 * Math.PI / n); };   // of the 64-gon the finder samples

test("outlines that do not cross: the same regions and ids as profiles.ts", () => {
  const cases = [
    sketch({ ...rect("a", 0, 0, 40, 20) }),
    sketch({ ...rect("a", 0, 0, 40, 20), ...circle("h", 10, 10, 4), ...circle("i", 30, 10, 4) }),
    sketch({ ...rect("a", 0, 0, 40, 20), ...rect("b", 5, 5, 35, 15), ...circle("c", 20, 10, 3) }),   // a ring, and an island in its hole
    sketch({ ...rect("a", 0, 0, 10, 10), ...rect("b", 20, 0, 30, 10) }),
    sketch({ ...rect("a", 0, 0, 10, 10), x1: pt(50, 0), x2: pt(60, 5), stray: { type: "line", a: "x1", b: "x2" } }),
  ];
  for (const s of cases) {
    const a = P.findRegions(s), b = Old.findRegions(s);
    assert.deepEqual(a.regions.map((r) => r.id), b.regions.map((r) => r.id));
    assert.deepEqual(a.open, b.open);
    a.regions.forEach((r, i) => {
      near(r.outer.area, b.regions[i].outer.area);
      assert.equal(r.holes.length, b.regions[i].holes.length);
      assert.ok(r.outer.edges.every((e) => !e.span), "whole curves carry no span");
      assert.deepEqual(r.outer.edges.map((e) => e.entity).sort(), b.regions[i].outer.edges.map((e) => e.entity).sort());
    });
  }
  // an arc and its chord, joined by position rather than by id
  const d = sketch({ c: pt(0, 0), s: pt(10, 0), e: pt(-10, 0), arc: { type: "arc", center: "c", start: "s", end: "e" }, a: pt(-10, 0), b: pt(10, 0), chord: { type: "line", a: "a", b: "b" } });
  const r = P.findRegions(d);
  assert.equal(r.regions.length, 1);
  near(r.regions[0].outer.area, Old.findRegions(d).regions[0].outer.area);
});

test("two circles that overlap enclose three regions", () => {
  const r = P.findRegions(sketch({ ...circle("a", 0, 0, 10), ...circle("b", 12, 0, 10) }));
  assert.equal(r.regions.length, 3);
  assert.deepEqual(r.regions.map((x) => x.id), ["a", "a~2", "a~3"]);
  const [lens, m1, m2] = areas(r);
  near(m1, m2);
  near(lens + m1, circleArea(10), 5e-3);
  assert.ok(r.regions.every((x) => x.outer.edges.every((e) => e.span && e.span[1] > e.span[0])));
});

test("a line across a rectangle splits it; the ends that stick out are dropped", () => {
  const s = sketch({ ...rect("a", 0, 0, 40, 20), q1: pt(15, -5), q2: pt(15, 25), cut: { type: "line", a: "q1", b: "q2" } });
  const r = P.findRegions(s);
  assert.deepEqual(areas(r), [300, 500]);
  assert.deepEqual(r.open, []);
  const cutEdge = r.regions[0].outer.edges.find((e) => e.entity === "cut");
  near(cutEdge.span[0], 5 / 30); near(cutEdge.span[1], 25 / 30);
  // a line that only pokes in encloses nothing more
  const poke = P.findRegions(sketch({ ...rect("a", 0, 0, 40, 20), q1: pt(15, -5), q2: pt(15, 10), cut: { type: "line", a: "q1", b: "q2" } }));
  assert.deepEqual(areas(poke), [800]);
  assert.deepEqual(poke.open, ["cut"]);
});

test("T-junctions, a tangent line, and construction geometry", () => {
  // a wall from the middle of one side to the middle of the other, ending exactly on them
  const t = P.findRegions(sketch({ ...rect("a", 0, 0, 40, 20), q1: pt(20, 0), q2: pt(20, 20), wall: { type: "line", a: "q1", b: "q2" } }));
  assert.deepEqual(areas(t), [400, 400]);
  // a D shape: a circle cut by a chord
  const d = P.findRegions(sketch({ ...circle("k", 0, 0, 10), q1: pt(0, -10), q2: pt(0, 10), chord: { type: "line", a: "q1", b: "q2" } }));
  assert.equal(d.regions.length, 2); near(areas(d)[0], areas(d)[1]);
  // a line tangent to a circle touches it and splits nothing
  const tan = P.findRegions(sketch({ ...circle("k", 0, 0, 10), q1: pt(-20, 10), q2: pt(20, 10), l: { type: "line", a: "q1", b: "q2" } }));
  assert.equal(tan.regions.length, 1); near(tan.regions[0].outer.area, circleArea(10));
  // construction geometry cuts nothing
  const c = P.findRegions(sketch({ ...rect("a", 0, 0, 40, 20), q1: pt(15, -5), q2: pt(15, 25), cut: { type: "line", a: "q1", b: "q2", construction: true } }));
  assert.deepEqual(areas(c), [800]);
});

test("a slot: two lines and two arcs that are tangent where they join", () => {
  const e = {
    c1: pt(0, 0), c2: pt(30, 0), a: pt(0, -5), b: pt(30, -5), c: pt(30, 5), d: pt(0, 5),
    bottom: { type: "line", a: "a", b: "b" }, right: { type: "arc", center: "c2", start: "b", end: "c" },
    top: { type: "line", a: "c", b: "d" }, left: { type: "arc", center: "c1", start: "d", end: "a" },
  };
  const r = P.findRegions(sketch(e));
  assert.equal(r.regions.length, 1);
  near(r.regions[0].outer.area, 300 + circleArea(5), 5e-3);
  assert.ok(r.regions[0].outer.edges.every((x) => !x.span));
  // with a hole through it and a circle overlapping one end
  const more = P.findRegions(sketch({ ...e, ...circle("h", 15, 0, 2), ...circle("z", 38, 0, 6) }));
  assert.equal(more.regions.length, 3);
  assert.equal(more.regions.filter((x) => x.holes.length === 1).length, 1);
});

test("a grid of crossing lines", () => {
  const e = {};
  for (let i = 0; i <= 4; i++) {
    e[`hp${i}a`] = pt(-1, i * 10); e[`hp${i}b`] = pt(41, i * 10); e[`h${i}`] = { type: "line", a: `hp${i}a`, b: `hp${i}b` };
    e[`vp${i}a`] = pt(i * 10, -1); e[`vp${i}b`] = pt(i * 10, 41); e[`v${i}`] = { type: "line", a: `vp${i}a`, b: `vp${i}b` };
  }
  const r = P.findRegions(sketch(e));
  assert.equal(r.regions.length, 16);
  for (const a of areas(r)) near(a, 100);
  assert.equal(new Set(r.regions.map((x) => x.id)).size, 16);
});
