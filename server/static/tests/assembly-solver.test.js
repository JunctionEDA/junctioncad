// Node test for the assembly solver (web/domains/assembly/solver) and every mate type (mates/*.ts): each mate
// holds after a solve from a scrambled start and leaves exactly the freedoms it says; welding, loops, limits,
// offsets, flips, driven values, dragging, conflicts, and the speed of a few hundred instances.
// Run: node server/static/tests/assembly-solver.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");
const S = load("domains/assembly/solver/solver.ts");
const M = load("domains/assembly/solver/math.ts");
const FR = load("domains/assembly/solver/frames.ts");
const LIN = load("domains/assembly/solver/linear.ts");
const G = load("domains/assembly/generated/page.ts");

const mate = (type) => G.MATES.find((m) => m.type === type);
const frame = (o, z = [0, 0, 1], extra = {}) => ({ ...FR.frameFromAxis(o, z), ...extra });
const pose = (p = [0, 0, 0], axis = [0, 0, 1], deg = 0) => ({ p, q: M.qaxis(M.unit(axis), (deg * Math.PI) / 180) });
const body = (id, p, fixed = false) => ({ id, pose: p || pose(), fixed });
/** a mate as the solver takes it: flip, offset and reorientation applied the way the editor does */
const mk = (id, type, a, fa, b, fb, params = {}, flips = {}) => {
  const def = mate(type), p = { ...def.defaults(), ...params };
  return { id, solve: def.solve, a: { body: a, frame: FR.prepareA(fa, flips.a, p) }, b: { body: b, frame: FR.prepareB(fb, flips.b, p) }, params: p };
};
const world = (r, m, side) => FR.frameInWorld(r.poses.get(m[side].body), m[side].frame);
const near = (a, b, eps = 1e-6, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} is not ${b}`);
const nearV = (a, b, eps = 1e-6, what = "") => a.forEach((v, i) => near(v, b[i], eps, `${what}[${i}]`));
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const scrambled = () => ({ p: [rnd() * 80, rnd() * 80, rnd() * 80], q: M.qnorm([rnd(), rnd(), rnd(), rnd() + 0.8]) });

test("the arithmetic: quaternions, poses and transforms agree", () => {
  const p = scrambled(), q = scrambled();
  const t = M.transformOf(p), back = M.poseOf(t);
  nearV(back.p, p.p, 1e-12); near(Math.abs(M.dot4 ? 0 : back.q[0] * p.q[0] + back.q[1] * p.q[1] + back.q[2] * p.q[2] + back.q[3] * p.q[3]), 1, 1e-12);
  const v = [3, -4, 5];
  nearV(M.applyPose(M.compose(p, q), v), M.applyPose(p, M.applyPose(q, v)), 1e-10);
  nearV(M.applyPose(M.compose(M.inverse(p), p), v), v, 1e-10);
  nearV(M.qlog(M.qexp([0.3, -0.2, 0.5])), [0.3, -0.2, 0.5], 1e-12);
  near(M.poseDistance(p, p), 0, 1e-9);
});

test("the factorisations: a skyline Cholesky solves, a pivoted one finds the rank and the null space", () => {
  // a chain's matrix: tridiagonal, positive definite
  const n = 6, first = new Int32Array([0, 0, 1, 2, 3, 4]);
  const A = new LIN.EnvelopeMatrix(n, first), L = new LIN.EnvelopeMatrix(n, first);
  for (let i = 0; i < n; i++) { A.add(i, i, 4); if (i) A.add(i, i - 1, -1); }
  assert.ok(A.factor(L, new Float64Array(n)));
  const b = Float64Array.from([1, 2, 3, 4, 5, 6]), x = Float64Array.from(b);
  L.solve(x);
  for (let i = 0; i < n; i++) near(4 * x[i] - (i ? x[i - 1] : 0) - (i < n - 1 ? x[i + 1] : 0), b[i], 1e-12);
  // rank 2 in 4 dimensions
  const rows = [[1, 2, 0, 1], [0, 1, 1, 0]], D = new Float64Array(16);
  for (const r of rows) for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) D[i * 4 + j] += r[i] * r[j];
  const { rank, nullspace } = LIN.pivotedCholesky(D, 4);
  assert.equal(rank, 2); assert.equal(nullspace.length, 2);
  for (const v of nullspace) for (const r of rows) near(r[0] * v[0] + r[1] * v[1] + r[2] * v[2] + r[3] * v[3], 0, 1e-9);
});

test("every mate type registers a solver hook", () => {
  assert.deepEqual(G.MATES.map((m) => m.type).sort(), ["ball", "cylindrical", "fastened", "parallel", "pin-slot", "planar", "revolute", "slider", "tangent"]);
  for (const m of G.MATES) { assert.equal(typeof m.solve.residuals, "function", m.type); assert.equal(typeof m.place, "function"); }
});

// each mate, from a scrambled start: it holds, and it leaves exactly the freedoms it declares
for (const [type, extra] of [["fastened", {}], ["revolute", {}], ["slider", {}], ["planar", {}], ["cylindrical", {}], ["pin-slot", {}], ["ball", {}], ["parallel", {}]]) {
  test(`${type}: holds after a solve and leaves the freedoms it declares`, () => {
    const def = mate(type);
    for (let round = 0; round < 4; round++) {
      const fa = frame([10, 5, 20], [0, 0.6, 0.8]), fb = frame([-3, 4, 2], [1, 0, 0]);
      const m = mk("m", type, "base", fa, "part", fb, extra);
      const r = S.solve([body("base", pose([5, 5, 5], [1, 1, 0], 30), true), body("part", scrambled())], [m], { analyze: true, seed: round % 2 ? "m" : undefined });
      assert.equal(r.ok, true, `${type} round ${round}: residual ${r.mates.get("m").residual}`);
      assert.equal(r.mates.get("m").status, "ok");
      assert.equal(r.dof, def.freedom.translation + def.freedom.rotation, `${type}: freedoms`);
      assert.equal(r.bodies.get("part").dof, r.dof);
      assert.deepEqual(r.bodies.get("base"), { grounded: true, dof: 0 });
      const A = world(r, m, "a"), B = world(r, m, "b");
      if (["fastened", "revolute", "ball"].includes(type)) nearV(B.o, A.o, 1e-5, "origin");
      if (type !== "ball") nearV(B.z, A.z, 1e-6, "axis");
      if (["fastened", "slider"].includes(type)) nearV(B.x, A.x, 1e-6, "x");
      if (["slider", "cylindrical"].includes(type)) { const d = M.sub(B.o, A.o); near(M.len(M.cross(d, A.z)), 0, 1e-5, "on the axis"); }
      if (type === "planar") near(M.dot(M.sub(B.o, A.o), A.z), 0, 1e-5, "in the plane");
      if (type === "pin-slot") { const d = M.sub(B.o, A.o); near(M.dot(d, A.z), 0, 1e-5); near(M.dot(d, A.y), 0, 1e-5); }
    }
  });
}

test("tangent: a cylinder on a flat face, two cylinders, and a pair it refuses", () => {
  const plane = frame([0, 0, 10], [0, 0, 1], { surface: "plane" }), cyl = frame([0, 0, 0], [0, 1, 0], { surface: "cylinder", radius: 4 });
  const m = mk("m", "tangent", "base", plane, "roller", cyl);
  const r = S.solve([body("base", pose(), true), body("roller", scrambled())], [m], { analyze: true });
  assert.equal(r.ok, true);
  const B = world(r, m, "b");
  near(B.o[2], 14, 1e-5, "the axis is one radius above the face"); near(B.z[2], 0, 1e-6, "and parallel to it");
  assert.equal(r.dof, 4);
  const c2 = frame([0, 0, 0], [0, 0, 1], { surface: "cylinder", radius: 6 });
  const m2 = mk("m2", "tangent", "base", { ...c2 }, "roller", cyl);
  const r2 = S.solve([body("base", pose(), true), body("roller", pose([30, 3, 2], [1, 0, 0], 70))], [m2], { analyze: true });
  assert.equal(r2.ok, true);
  const A2 = world(r2, m2, "a"), B2 = world(r2, m2, "b"), n = M.cross(A2.z, B2.z);
  near(Math.abs(M.dot(M.sub(B2.o, A2.o), n)) / M.len(n), 10, 1e-5, "axes r1 + r2 apart");
  assert.equal(r2.dof, 5);
  const bad = S.solve([body("base", pose(), true), body("roller", pose())], [mk("m3", "tangent", "base", plane, "roller", { ...plane })]);
  assert.equal(bad.mates.get("m3").status, "error"); assert.match(bad.mates.get("m3").message, /flat faces/);
});

test("a lid on a box with a hinge: one freedom, an angle, limits that stop a drag", () => {
  // box 100 × 60 × 40, fixed; the hinge runs along the back top edge (y = 60, z = 40), axis x
  const hingeBox = frame([50, 60, 40], [1, 0, 0]), hingeLid = frame([50, 60, 0], [1, 0, 0]);
  const bodies = () => [body("box", pose(), true), body("lid", pose([0, 0, 40]))];
  const m = mk("hinge", "revolute", "box", hingeBox, "lid", hingeLid, { limits: true, angleMin: -110, angleMax: 0 });
  let r = S.solve(bodies(), [m], { analyze: true });
  assert.equal(r.ok, true); assert.equal(r.dof, 1, "a limit is a stop, not a constraint"); assert.equal(r.bodies.get("lid").dof, 1);
  near(r.mates.get("hinge").values.angle, 0, 1e-6, "closed");
  // drag the lid's front edge up and back: it turns about the hinge (a negative angle about +x)
  const grab = [50, 0, 0];
  r = S.solve(bodies(), [m], { drag: { body: "lid", point: grab, target: [50, 60, 100] } });
  assert.equal(r.ok, true);
  near(r.mates.get("hinge").values.angle, -90, 0.05, "the front edge straight above the hinge");
  nearV(M.applyPose(r.poses.get("lid"), [50, 60, 0]), [50, 60, 40], 1e-5, "the hinge line has not moved");
  // drag far past the limit: it stops at 110°
  r = S.solve([body("box", pose(), true), { id: "lid", pose: r.poses.get("lid"), fixed: false }], [m], { drag: { body: "lid", point: grab, target: [50, 200, 20] } });
  assert.equal(r.ok, true);
  near(r.mates.get("hinge").values.angle, -110, 0.01, "stopped at the limit");
  // and the other way, to far below the box: it stops closed
  let state = r.poses.get("lid");
  for (const target of [[50, 60, 110], [50, 0, 60], [50, -40, -90]]) { r = S.solve([body("box", pose(), true), { id: "lid", pose: state, fixed: false }], [m], { drag: { body: "lid", point: grab, target } }); state = r.poses.get("lid"); }
  assert.equal(r.ok, true);
  near(r.mates.get("hinge").values.angle, 0, 0.01, "stopped closed");
  // a driven value: the angle set to 45° open
  r = S.solve(bodies(), [m], { drives: [{ mate: "hinge", key: "angle", value: (-45 * Math.PI) / 180 }] });
  near(r.mates.get("hinge").values.angle, -45, 1e-4);
});

test("offset, rotation, flip and reorient change where the second part sits", () => {
  const top = frame([0, 0, 10], [0, 0, 1]), under = frame([0, 0, 0], [0, 0, 1]);
  const run = (params, flips) => { const m = mk("m", "fastened", "a", top, "b", under, params, flips); const r = S.solve([body("a", pose(), true), body("b", scrambled())], [m]); assert.ok(r.ok); return r.poses.get("b"); };
  nearV(run({}).p, [0, 0, 10], 1e-9);
  nearV(run({ offset: 5 }).p, [0, 0, 15], 1e-9);
  nearV(M.qrot(run({ rotation: 90 }).q, [1, 0, 0]), [0, 1, 0], 1e-9, "turned a quarter");
  nearV(M.qrot(run({}, { b: true }).q, [0, 0, 1]), [0, 0, -1], 1e-9, "flipped: upside down");
  nearV(M.qrot(run({ reorient: 1 }).q, [1, 0, 0]), [0, -1, 0], 1e-9, "reoriented a quarter the other way");
  // a planar offset is the distance between the planes
  const m = mk("p", "planar", "a", top, "b", under, { offset: 2.5 });
  const r = S.solve([body("a", pose(), true), body("b", pose([7, 8, 30], [1, 0, 0], 20))], [m]);
  near(r.poses.get("b").p[2], 12.5, 1e-6); near(r.poses.get("b").p[0], 7, 1e-3, "it stays where it was in the plane");
});

test("fastened parts are welded: a fixed part and a stack on it need no iteration; unfixed, they move as one", () => {
  const bodies = [body("a", pose(), true)], mates = [];
  for (let i = 1; i <= 20; i++) { bodies.push(body("b" + i, scrambled())); mates.push(mk("m" + i, "fastened", i === 1 ? "a" : "b" + (i - 1), frame([0, 0, 10]), "b" + i, frame([0, 0, 0]))); }
  const r = S.solve(bodies, mates, { analyze: true });
  assert.equal(r.ok, true); assert.equal(r.iterations, 0); assert.equal(r.dof, 0);
  nearV(r.poses.get("b20").p, [0, 0, 200], 1e-9);
  assert.equal(r.bodies.get("b20").grounded, true);
  // nothing fixed: the stack has the six freedoms of one body, and a drag moves all of it
  bodies[0].fixed = false;
  const free = S.solve(bodies, mates, { analyze: true, drag: { body: "b20", point: [0, 0, 0], target: [50, 0, 200] } });
  assert.equal(free.dof, 6);
  near(M.len(M.sub(M.applyPose(free.poses.get("b20"), [0, 0, 0]), [50, 0, 200])), 0, 1e-4, "the grabbed point is under the pointer");
  near(M.len(M.sub(free.poses.get("b20").p, free.poses.get("a").p)), 200, 1e-6, "still one stack");
});

test("a four-bar linkage: a loop with redundant hinges has one freedom and follows a drag", () => {
  // ground at A (0,0) and D (100,0); crank AB 30, coupler BC 100, rocker DC 30: a parallelogram in the XY plane
  const z = [0, 0, 1];
  const bodies = () => [body("ground", pose(), true), body("crank", pose([0, 0, 0], z, 90)), body("coupler", pose([0, 30, 0])), body("rocker", pose([100, 0, 0], z, 90))];
  const mates = [
    mk("A", "revolute", "ground", frame([0, 0, 0]), "crank", frame([0, 0, 0])),
    mk("B", "revolute", "crank", frame([30, 0, 0]), "coupler", frame([0, 0, 0])),
    mk("C", "revolute", "coupler", frame([100, 0, 0]), "rocker", frame([30, 0, 0])),
    mk("D", "revolute", "ground", frame([100, 0, 0]), "rocker", frame([0, 0, 0])),
  ];
  let r = S.solve(bodies(), mates, { analyze: true });
  assert.equal(r.ok, true); assert.equal(r.dof, 1, "three planar hinges too many, but they agree");
  for (const id of ["crank", "coupler", "rocker"]) assert.equal(r.bodies.get(id).dof, 1, id);
  // pull the crank's tip round to 45°
  const c = Math.SQRT1_2 * 30;
  r = S.solve(bodies(), mates, { drag: { body: "crank", point: [30, 0, 0], target: [c, c, 0] } });
  assert.equal(r.ok, true);
  near(r.mates.get("A").values.angle, 45, 0.05);
  near(r.mates.get("D").values.angle, 45, 0.05, "the rocker follows");
  nearV(M.qrot(r.poses.get("coupler").q, [1, 0, 0]), [1, 0, 0], 1e-4, "the coupler stays level");
  for (const m of mates) assert.ok(r.mates.get(m.id).residual < 1e-5);
});

test("conflicting mates are named, and the rest still hold", () => {
  const top = frame([0, 0, 10]);
  const mates = [
    mk("first", "fastened", "base", top, "part", frame([0, 0, 0])),
    mk("hinge", "revolute", "base", frame([40, 0, 10], [1, 0, 0]), "arm", frame([0, 0, 0], [1, 0, 0])),
    mk("second", "fastened", "base", frame([0, 0, 30]), "part", frame([0, 0, 0])),      // the same part, somewhere else
    mk("pin", "ball", "base", frame([40, 5, 10]), "arm", frame([0, 0, 0])),              // the hinge's point, moved off its axis
  ];
  const r = S.solve([body("base", pose(), true), body("part", scrambled()), body("arm", scrambled())], mates, { analyze: true });
  assert.equal(r.ok, false);
  assert.deepEqual(mates.map((m) => r.mates.get(m.id).status), ["ok", "ok", "conflict", "conflict"]);
  assert.match(r.mates.get("second").message, /conflicts/);
  nearV(r.poses.get("part").p, [0, 0, 10], 1e-6, "the first fastened mate holds");
  nearV(r.poses.get("arm").p, [40, 0, 10], 1e-5, "and the hinge");
  assert.equal(r.bodies.get("arm").dof, 1);
  // limits nothing can meet are a conflict too
  const lim = [mk("slide", "slider", "base", frame([0, 0, 0]), "s", frame([0, 0, 0]), { limits: true, distanceMin: 5, distanceMax: 8 }), mk("stop", "planar", "base", frame([0, 0, 20]), "s", frame([0, 0, 0]))];
  const r2 = S.solve([body("base", pose(), true), body("s", pose([0, 0, 6]))], lim, { analyze: true });
  assert.deepEqual([r2.ok, r2.mates.get("slide").status, r2.mates.get("stop").status], [false, "ok", "conflict"]);
  near(r2.mates.get("slide").values.distance, 6, 2.001, "inside its limits");
});

test("a mate with a missing instance or to itself is an error, and is left out", () => {
  const r = S.solve([body("a", pose(), true), body("b", pose([1, 2, 3]))], [mk("gone", "fastened", "a", frame([0, 0, 0]), "zz", frame([0, 0, 0])), mk("self", "ball", "b", frame([0, 0, 0]), "b", frame([1, 0, 0]))], { analyze: true });
  assert.deepEqual([r.mates.get("gone").status, r.mates.get("self").status], ["error", "error"]);
  assert.equal(r.ok, true); assert.equal(r.dof, 6);
  nearV(r.poses.get("b").p, [1, 2, 3], 1e-12);
});

test("what is not constrained stays where it is; what already holds is not touched", () => {
  const start = pose([12, 34, 5], [0, 0, 1], 25);
  const m = mk("m", "planar", "base", frame([0, 0, 5]), "p", frame([0, 0, 0]));
  const r = S.solve([body("base", pose(), true), body("p", start), body("loose", pose([9, 9, 9]))], [m], { analyze: true });
  assert.equal(r.iterations, 0);
  nearV(r.poses.get("p").p, start.p, 1e-12); nearV(r.poses.get("loose").p, [9, 9, 9], 1e-12);
  assert.equal(r.bodies.get("loose").dof, 6); assert.equal(r.dof, 9);
});

test("a single mate's place() moves the second part as little as the mate allows", () => {
  const def = mate("revolute");
  const a = { origin: [0, 0, 10], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
  const bNow = [0, -1, 0, 30, 1, 0, 0, 5, 0, 0, 1, 0];                        // turned a quarter, off to the side
  const b = { origin: [30, 5, 0], x: [0, 1, 0], y: [-1, 0, 0], normal: [0, 0, 1] };   // its connector at its own origin
  const t = def.place(a, b, bNow, def.defaults());
  nearV([t[3], t[7], t[11]], [0, 0, 10], 1e-6, "the origins meet");
  nearV([t[0], t[4], t[8]], [0, 1, 0], 1e-6, "and it keeps the quarter turn it had");
});

test("speed: a few hundred instances solve at interactive rates", () => {
  const z = [0, 0, 1];
  // 1. a chain of 300 links, hinged end to end, hanging from a fixed base; drag the far end
  const N = 300, bodies = [body("b0", pose(), true)], mates = [];
  for (let i = 1; i <= N; i++) { bodies.push(body("b" + i, pose([(i - 1) * 10, 0, 0]))); mates.push(mk("m" + i, "revolute", "b" + (i - 1), frame([i === 1 ? 0 : 10, 0, 0], z), "b" + i, frame([0, 0, 0], z))); }
  let state = bodies, worst = 0, total = 0;
  const steps = 12;
  for (let s = 1; s <= steps; s++) {
    const r = S.solve(state, mates, { drag: { body: "b" + N, point: [10, 0, 0], target: [N * 10 - s * 6, s * 25, 0] }, maxIterations: 16 });
    assert.equal(r.ok, true, `step ${s}: the chain came apart`);
    worst = Math.max(worst, r.ms); total += r.ms;
    state = bodies.map((b) => ({ ...b, pose: r.poses.get(b.id) }));
  }
  const tip = M.applyPose(state[N].pose, [10, 0, 0]);
  assert.ok(M.len(M.sub(tip, [N * 10 - steps * 6, steps * 25, 0])) < 1, `the tip follows the pointer: ${tip}`);
  console.log(`    chain of ${N} hinges: ${(total / steps).toFixed(1)} ms per drag step on average, ${worst.toFixed(1)} ms worst`);
  // about 40 ms on an idle machine; the bound is loose because CI machines are shared
  assert.ok(total / steps < 500, `a drag step of a ${N}-hinge chain took ${(total / steps).toFixed(1)} ms`);
  // 2. the common shape: 100 lids each hinged to its own fixed box, 200 instances; dragging one solves one
  const many = [], hinges = [];
  for (let i = 0; i < 100; i++) {
    many.push(body("box" + i, pose([i * 120, 0, 0]), true), body("lid" + i, pose([i * 120, 0, 40])));
    hinges.push(mk("h" + i, "revolute", "box" + i, frame([50, 60, 40], [1, 0, 0]), "lid" + i, frame([50, 60, 0], [1, 0, 0]), { limits: true, angleMin: -120, angleMax: 120 }));
  }
  const t0 = performance.now();
  let r;
  for (let s = 1; s <= 20; s++) r = S.solve(many, hinges, { drag: { body: "lid57", point: [50, 0, 0], target: [57 * 120 + 50, s * 2, 40 + s * 2] }, maxIterations: 16 });
  const per = (performance.now() - t0) / 20;
  assert.equal(r.ok, true);
  console.log(`    100 hinged lids: ${per.toFixed(2)} ms per drag step`);
  assert.ok(per < 60, `${per} ms`);
  const full = S.solve(many, hinges, { analyze: true });
  assert.equal(full.dof, 100);
  console.log(`    100 hinged lids, full solve with freedoms counted: ${full.ms.toFixed(1)} ms`);
});
