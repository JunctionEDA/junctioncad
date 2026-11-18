// solver.ts — the assembly solver: where every instance must be for all the mates to hold at once.
//
// How it works, in the order the code does it:
//
//   1. Weld.  A mate that leaves no freedom (Fastened: `solve.rigid`) joins its two instances into one rigid
//      group, which then has one pose to solve for instead of two: the reduced parameterisation of the most
//      common mate.  A group that holds a fixed instance is grounded and has no unknowns at all.
//   2. Split.  Groups tied together by the remaining mates form components that do not affect one another;
//      each is solved alone, and a component that already holds costs one evaluation.
//   3. Solve each component by Levenberg–Marquardt on the mates' residuals.  A group's unknowns are a small
//      translation and rotation of its current pose (six numbers); the Jacobian comes from the mates' own
//      residual functions by central differences, so a mate file is only its residuals.  The normal equations
//      are a skyline matrix ordered breadth-first along the mates (linear.ts): a chain of two hundred hinges
//      factors in well under a millisecond per iteration.  Steps are damped towards the smallest change, so
//      what is not constrained stays where it is.
//   4. Drag.  A pointer goal is a weak extra residual on one body; after it, a pass without the goal puts the
//      mates back exactly, so a drag can never pull a mate apart.
//   5. Report.  Each mate's residual and values; with `analyze`, the freedoms each body has left (the null
//      space of the Jacobian) and, when the mates cannot all hold, which ones conflict: the mates are added
//      one at a time in order and the ones that break a system that held are the ones reported.
//
// Limits are one-sided residuals (zero inside the range), so a part stops at its limit while it is dragged.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { Vec3 } from "../../mechanical/api";
import { frameInWorld, framePose } from "./frames";
import { EnvelopeMatrix, pivotedCholesky, rankOf } from "./linear";
import { add, applyPose, compose, cross, inverse, len, qconj, qexp, qlog, qmul, qnorm, qrot, sub, wrapAngle, type Pose } from "./math";
import type { BodyReport, DragGoal, MateFrame, MateReport, MateSolve, SolveOptions, SolveResult, SolverBody, SolverMate } from "./types";

/** below this (mm) a mate holds */
export const TOLERANCE = 1e-6;
/** above this (mm) after solving, a mate is reported as not satisfied */
export const FAILED = 1e-4;
const H = 1e-5;                 // the step of the central differences
const DRAG_WEIGHT = 0.05;       // a pointer goal against a mate: the mate wins
const ANALYZE_MAX = 480;        // unknowns in one component above which freedoms are not counted
const CONFLICT_MAX = 120;       // mates above which conflicts are named by residual only

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** A limit's residual: how far `v` is outside [min, max]; angles may be reached either way round. */
function outside(v: number, min: number, max: number, angle: boolean): number {
  if (min > max) { const t = min; min = max; max = t; }
  if (angle) {
    const turn = 2 * Math.PI;
    let best = Infinity, out = 0;
    for (const c of [v - turn, v, v + turn]) {
      const d = c < min ? c - min : c > max ? c - max : 0;
      if (Math.abs(d) < best) { best = Math.abs(d); out = d; }
    }
    return out;
  }
  return v < min ? v - min : v > max ? v - max : 0;
}

/** Every residual of one mate as the two frames stand: the mate's own, then its limits, then driven values. */
function evaluate(s: MateSolve, params: JsonObject, a: MateFrame, b: MateFrame, reach: number, drives: { key: string; value: number }[] | undefined, out: number[], limits = true): void {
  out.length = 0;
  s.residuals(a, b, params, reach, out);
  if (s.values) {
    if (limits && params.limits) {
      for (const v of s.values) {
        const angle = v.unit === "deg", k = angle ? Math.PI / 180 : 1;
        const lo = params[v.key + "Min"], hi = params[v.key + "Max"];
        if (typeof lo !== "number" && typeof hi !== "number") { out.push(0); continue; }
        out.push(outside(v.measure(a, b), num(lo, -Infinity) * k, num(hi, Infinity) * k, angle) * (angle ? reach : 1));
      }
    }
    if (drives) for (const d of drives) {
      const v = s.values.find((x) => x.key === d.key);
      if (v) out.push(v.unit === "deg" ? wrapAngle(v.measure(a, b) - d.value) * reach : v.measure(a, b) - d.value);
    }
  }
}

/** The frame moved by one unknown: k < 3 a translation of h · reach along a world axis, else a turn of h about that axis through `c`. */
function perturb(f: MateFrame, c: Vec3, k: number, h: number, reach: number): MateFrame {
  if (k < 3) { const o: Vec3 = [f.o[0], f.o[1], f.o[2]]; o[k] += h * reach; return { o, x: f.x, y: f.y, z: f.z, surface: f.surface, radius: f.radius }; }
  // a turn about a world axis only mixes the two other coordinates: no quaternion needed in the innermost loop
  const i = (k - 2) % 3, j = (k - 1) % 3, s = Math.sin(h), co = Math.cos(h);
  const turn = (v: Vec3): Vec3 => { const out: Vec3 = [v[0], v[1], v[2]]; out[i] = co * v[i] - s * v[j]; out[j] = s * v[i] + co * v[j]; return out; };
  const d = turn([f.o[0] - c[0], f.o[1] - c[1], f.o[2] - c[2]]);
  return { o: [c[0] + d[0], c[1] + d[1], c[2] + d[2]], x: turn(f.x), y: turn(f.y), z: turn(f.z), surface: f.surface, radius: f.radius };
}

interface Prepared { m: SolverMate; ia: number; ib: number; ga: number; gb: number; va: number; vb: number; drives?: { key: string; value: number }[] }

class Core {
  readonly index = new Map<string, number>();
  /** each body's pose within its group (its world pose once welding has snapped it) */
  readonly rel: Pose[];
  private readonly parent: number[];
  private readonly members: number[][];
  private readonly ground: boolean[];
  /** the pose of each group (indexed by its root body): the unknowns */
  readonly G: Pose[];
  readonly reports = new Map<string, MateReport>();
  readonly live: Prepared[] = [];
  /** mates between two grounded groups or inside one group: nothing to solve, only to check */
  private readonly checks: Prepared[] = [];
  readonly active: Prepared[] = [];
  private components: { groups: number[]; mates: Prepared[]; first: Int32Array; n: number }[] = [];
  private compOf = new Map<number, number>();
  iterations = 0;
  readonly reach: number;

  constructor(readonly bodies: readonly SolverBody[], mates: readonly SolverMate[], readonly opts: SolveOptions) {
    this.reach = opts.reach && opts.reach > 0 ? opts.reach : 100;
    bodies.forEach((b, i) => this.index.set(b.id, i));
    this.rel = bodies.map((b) => ({ p: [b.pose.p[0], b.pose.p[1], b.pose.p[2]], q: qnorm(b.pose.q) }));
    this.parent = bodies.map((_, i) => i);
    this.members = bodies.map((_, i) => [i]);
    this.ground = bodies.map((b) => !!b.fixed);
    this.G = bodies.map(() => ({ p: [0, 0, 0], q: [0, 0, 0, 1] }));
    for (const m of mates) {
      const ia = this.index.get(m.a.body), ib = this.index.get(m.b.body);
      if (ia === undefined || ib === undefined) { this.reports.set(m.id, { status: "error", residual: Infinity, message: "One of its instances is missing.", values: {} }); continue; }
      if (ia === ib) { this.reports.set(m.id, { status: "error", residual: Infinity, message: "A mate needs two different instances.", values: {} }); continue; }
      const why = m.solve.check ? m.solve.check(m.a.frame, m.b.frame, m.params) : null;
      if (why) { this.reports.set(m.id, { status: "error", residual: Infinity, message: why, values: {} }); continue; }
      const drives = opts.drives?.filter((d) => d.mate === m.id).map((d) => ({ key: d.key, value: d.value }));
      this.live.push({ m, ia, ib, ga: -1, gb: -1, va: -1, vb: -1, drives: drives && drives.length ? drives : undefined });
    }
  }

  private find(i: number): number { while (this.parent[i] !== i) { this.parent[i] = this.parent[this.parent[i]]; i = this.parent[i]; } return i; }
  private union(a: number, b: number): void {
    a = this.find(a); b = this.find(b); if (a === b) return;
    if (this.members[a].length < this.members[b].length) { const t = a; a = b; b = t; }
    this.parent[b] = a; this.members[a].push(...this.members[b]); this.members[b] = []; this.ground[a] = this.ground[a] || this.ground[b];
  }
  private moveGroup(root: number, delta: Pose): void { for (const i of this.members[root]) this.rel[i] = compose(delta, this.rel[i]); }
  worldPose(i: number): Pose { return compose(this.G[this.find(i)], this.rel[i]); }
  private frames(p: Prepared): [MateFrame, MateFrame] { return [frameInWorld(this.worldPose(p.ia), p.m.a.frame), frameInWorld(this.worldPose(p.ib), p.m.b.frame)]; }
  private residual(p: Prepared, scratch: number[]): number {
    const [a, b] = this.frames(p);
    evaluate(p.m.solve, p.m.params, a, b, this.reach, p.drives, scratch);
    let top = 0; for (const v of scratch) top = Math.max(top, Math.abs(v));
    return top;
  }

  /** Put instance b (or a, when b cannot move) where the two connector frames coincide. */
  private snap(p: Prepared): boolean {
    const ra = this.find(p.ia), rb = this.find(p.ib);
    if (ra === rb || (this.ground[ra] && this.ground[rb])) return false;
    const [a, b] = this.frames(p);
    if (!this.ground[rb]) this.moveGroup(rb, compose(framePose(a), inverse(framePose(b))));
    else this.moveGroup(ra, compose(framePose(b), inverse(framePose(a))));
    return true;
  }

  prepare(): void {
    const scratch: number[] = [];
    // 1. weld the rigid mates, in order
    const welded = new Set<Prepared>();
    for (const p of this.live) {
      if (!p.m.solve.rigid) continue;
      if (this.snap(p)) { this.union(p.ia, p.ib); welded.add(p); }
    }
    // a new mate starts from where it alone would put its second instance, when that satisfies it
    if (this.opts.seed) {
      const p = this.live.find((x) => x.m.id === this.opts.seed);
      if (p && !welded.has(p) && this.residual(p, scratch) > TOLERANCE) {
        const ra = this.find(p.ia), rb = this.find(p.ib);
        const moved = !this.ground[rb] ? rb : ra;
        const before = this.members[moved].map((i) => this.rel[i]);
        if (this.snap(p) && this.residual(p, scratch) > 1e-3) this.members[moved].forEach((i, k) => { this.rel[i] = before[k]; });   // coincident frames do not satisfy this mate (Tangent): leave it to the solver
      }
    }
    // 2. what is left to solve, and the components it falls into
    const comp = this.bodies.map((_, i) => i);
    const cfind = (i: number): number => { while (comp[i] !== i) { comp[i] = comp[comp[i]]; i = comp[i]; } return i; };
    for (const p of this.live) {
      if (welded.has(p)) continue;
      p.ga = this.find(p.ia); p.gb = this.find(p.ib);
      if (p.ga === p.gb || (this.ground[p.ga] && this.ground[p.gb])) { this.checks.push(p); continue; }
      this.active.push(p);
      if (!this.ground[p.ga] && !this.ground[p.gb]) comp[cfind(p.ga)] = cfind(p.gb);
    }
    for (const p of welded) { p.ga = this.find(p.ia); p.gb = this.find(p.ib); this.checks.push(p); }
    const byRoot = new Map<number, { groups: Set<number>; mates: Prepared[] }>();
    const entry = (g: number) => { const r = cfind(g); let e = byRoot.get(r); if (!e) { e = { groups: new Set(), mates: [] }; byRoot.set(r, e); } e.groups.add(g); return e; };
    for (const p of this.active) {
      const e = entry(this.ground[p.ga] ? p.gb : p.ga);
      if (!this.ground[p.ga]) e.groups.add(p.ga);
      if (!this.ground[p.gb]) e.groups.add(p.gb);
      e.mates.push(p);
    }
    const drag = this.opts.drag ? this.index.get(this.opts.drag.body) : undefined;
    if (drag !== undefined && !this.ground[this.find(drag)]) entry(this.find(drag));
    // 3. order each component's groups breadth-first so the normal equations have a narrow envelope
    for (const e of byRoot.values()) {
      const adj = new Map<number, number[]>();
      const groundedNear = new Set<number>();
      for (const g of e.groups) adj.set(g, []);
      for (const p of e.mates) {
        if (this.ground[p.ga]) groundedNear.add(p.gb); else if (this.ground[p.gb]) groundedNear.add(p.ga);
        else { adj.get(p.ga)!.push(p.gb); adj.get(p.gb)!.push(p.ga); }
      }
      const order: number[] = [], seen = new Set<number>();
      const starts = Array.from(e.groups).sort((p, q) => (groundedNear.has(q) ? 1 : 0) - (groundedNear.has(p) ? 1 : 0) || adj.get(p)!.length - adj.get(q)!.length || p - q);
      for (const s of starts) {
        if (seen.has(s)) continue;
        const queue = [s]; seen.add(s);
        while (queue.length) { const g = queue.shift()!; order.push(g); for (const h of adj.get(g)!.slice().sort((p, q) => adj.get(p)!.length - adj.get(q)!.length)) if (!seen.has(h)) { seen.add(h); queue.push(h); } }
      }
      const at = new Map<number, number>(); order.forEach((g, i) => at.set(g, i));
      const low = order.map((_, i) => i);
      for (const p of e.mates) {
        p.va = this.ground[p.ga] ? -1 : at.get(p.ga)!; p.vb = this.ground[p.gb] ? -1 : at.get(p.gb)!;
        if (p.va >= 0 && p.vb >= 0) { const lo = Math.min(p.va, p.vb); low[p.va] = Math.min(low[p.va], lo); low[p.vb] = Math.min(low[p.vb], lo); }
      }
      const n = order.length * 6, first = new Int32Array(n);
      for (let v = 0; v < order.length; v++) for (let k = 0; k < 6; k++) first[v * 6 + k] = low[v] * 6;
      const ci = this.components.length;
      for (const g of order) this.compOf.set(g, ci);
      this.components.push({ groups: order, mates: e.mates, first, n });
    }
  }

  private pivot(g: number): Vec3 {
    const c: Vec3 = [0, 0, 0]; const ms = this.members[g];
    for (const i of ms) { const b = this.bodies[i], p = b.centre ? applyPose(this.rel[i], b.centre) : this.rel[i].p; c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    return applyPose(this.G[g], [c[0] / ms.length, c[1] / ms.length, c[2] / ms.length]);
  }

  /** One component: Levenberg–Marquardt until the mates hold (and, with a goal, until the goal is as near as they allow). */
  private solveComponent(ci: number, goal: DragGoal | undefined, maxIterations: number): void {
    const c = this.components[ci], n = c.n, reach = this.reach;
    const A = new EnvelopeMatrix(n, c.first), L = new EnvelopeMatrix(n, c.first);
    const g = new Float64Array(n), d = new Float64Array(n), diag = new Float64Array(n), shift = new Float64Array(n);
    const r0: number[] = [], rp: number[] = [], rm: number[] = [];
    const goalBody = goal ? this.index.get(goal.body)! : -1;
    const goalVar = goal ? c.groups.indexOf(this.find(goalBody)) : -1;
    const cost = (): { cost: number; top: number } => {
      let sum = 0, top = 0;
      for (const p of c.mates) { const [a, b] = this.frames(p); evaluate(p.m.solve, p.m.params, a, b, reach, p.drives, r0); for (const v of r0) { sum += v * v; if (Math.abs(v) > top) top = Math.abs(v); } }
      if (goal && goalVar >= 0) for (const v of this.goalResidual(goal, goalBody)) sum += v * v;
      return { cost: sum, top };
    };
    let now = cost();
    // a goal pulls weakly along the freedoms the mates leave: damping must not drown it
    let lambda = goal && goalVar >= 0 ? 1e-7 : 1e-4;
    const J = new Float64Array(24 * 12);
    for (let iter = 0; iter < maxIterations; iter++) {
      if (now.top < TOLERANCE && (!(goal && goalVar >= 0) || now.cost < 1e-24)) break;
      this.iterations++;
      A.clear(); g.fill(0);
      const pivots = c.groups.map((gr) => this.pivot(gr));
      for (const p of c.mates) {
        const [a, b] = this.frames(p);
        evaluate(p.m.solve, p.m.params, a, b, reach, p.drives, r0);
        const m = r0.length;
        if (m > 24) throw new Error("A mate may not have more than 24 residuals.");
        for (let side = 0; side < 2; side++) {
          const v = side ? p.vb : p.va; if (v < 0) continue;
          for (let k = 0; k < 6; k++) {
            if (side) { evaluate(p.m.solve, p.m.params, a, perturb(b, pivots[v], k, H, reach), reach, p.drives, rp); evaluate(p.m.solve, p.m.params, a, perturb(b, pivots[v], k, -H, reach), reach, p.drives, rm); }
            else { evaluate(p.m.solve, p.m.params, perturb(a, pivots[v], k, H, reach), b, reach, p.drives, rp); evaluate(p.m.solve, p.m.params, perturb(a, pivots[v], k, -H, reach), b, reach, p.drives, rm); }
            for (let i = 0; i < m; i++) J[i * 12 + side * 6 + k] = (rp[i] - rm[i]) / (2 * H);
          }
        }
        // add Jᵀ·J and Jᵀ·r
        const cols: number[] = [];
        if (p.va >= 0) for (let k = 0; k < 6; k++) cols.push(p.va * 6 + k, k);
        if (p.vb >= 0) for (let k = 0; k < 6; k++) cols.push(p.vb * 6 + k, 6 + k);
        for (let x = 0; x < cols.length; x += 2) {
          const gx = cols[x], jx = cols[x + 1];
          let s = 0; for (let i = 0; i < m; i++) s += J[i * 12 + jx] * r0[i];
          g[gx] += s;
          for (let y = 0; y < cols.length; y += 2) {
            const gy = cols[y]; if (gy > gx) continue;
            const jy = cols[y + 1];
            let t = 0; for (let i = 0; i < m; i++) t += J[i * 12 + jx] * J[i * 12 + jy];
            A.add(gx, gy, t);
          }
        }
      }
      if (goal && goalVar >= 0) {
        // the goal's rows are simple enough to write down: a point's position, and (for the rings) the orientation
        const res = this.goalResidual(goal, goalBody), w = DRAG_WEIGHT;
        const x = sub(applyPose(this.worldPose(goalBody), goal.point), pivots[goalVar]);
        const rows: number[][] = [];
        for (let i = 0; i < 3; i++) {
          const e: Vec3 = [0, 0, 0]; e[i] = 1;
          const row = [0, 0, 0, 0, 0, 0]; row[i] = w * reach;
          for (let k = 0; k < 3; k++) { const ax: Vec3 = [0, 0, 0]; ax[k] = 1; row[3 + k] = w * cross(ax, x)[i]; }
          rows.push(row);
        }
        if (goal.rotation) for (let i = 0; i < 3; i++) { const row = [0, 0, 0, 0, 0, 0]; row[3 + i] = w * reach; rows.push(row); }
        rows.forEach((row, ri) => {
          for (let p = 0; p < 6; p++) {
            g[goalVar * 6 + p] += row[p] * res[ri];
            for (let q = 0; q <= p; q++) A.add(goalVar * 6 + p, goalVar * 6 + q, row[p] * row[q]);
          }
        });
      }
      A.diagonal(diag);
      let big = 0; for (let i = 0; i < n; i++) big = Math.max(big, diag[i]);
      // a floor under the damping: the freedoms nothing constrains must not amplify rounding in the gradient
      const mu = Math.max(big, 1) * 1e-9 + (goal && goalVar >= 0 ? 1e-4 * (DRAG_WEIGHT * reach) ** 2 : 0);
      const saved = c.groups.map((gr) => this.G[gr]);
      let accepted = false, stepSize = 0;
      for (let attempt = 0; attempt < 12; attempt++) {
        for (let i = 0; i < n; i++) shift[i] = lambda * diag[i] + mu * (1 + lambda * 1e4);
        if (!A.factor(L, shift)) { lambda *= 10; continue; }
        for (let i = 0; i < n; i++) d[i] = -g[i];
        L.solve(d);
        stepSize = 0;
        c.groups.forEach((gr, v) => {
          const u: Vec3 = [d[v * 6] * reach, d[v * 6 + 1] * reach, d[v * 6 + 2] * reach], w: Vec3 = [d[v * 6 + 3], d[v * 6 + 4], d[v * 6 + 5]];
          stepSize = Math.max(stepSize, len(u), len(w) * reach);
          const q = qexp(w), pv = pivots[v];
          const delta: Pose = { q, p: add(sub(pv, qrot(q, pv)), u) };
          this.G[gr] = compose(delta, saved[v]);
        });
        const next = cost();
        if (next.cost <= now.cost) { accepted = true; const gain = now.cost - next.cost; now = next; lambda = Math.max(lambda / 6, 1e-9); if (gain <= now.cost * 1e-8 + 1e-26) iter = maxIterations; break; }
        c.groups.forEach((gr, v) => { this.G[gr] = saved[v]; });
        lambda *= 8;
      }
      if (!accepted) break;
      if (stepSize < 1e-10) break;
    }
  }

  private goalResidual(goal: DragGoal, body: number): number[] {
    const pose = this.worldPose(body), w = DRAG_WEIGHT;
    const e = sub(applyPose(pose, goal.point), goal.target);
    const out = [w * e[0], w * e[1], w * e[2]];
    if (goal.rotation) { const r = qlog(qmul(pose.q, qconj(goal.rotation))); out.push(w * this.reach * r[0], w * this.reach * r[1], w * this.reach * r[2]); }
    return out;
  }

  run(): boolean {
    this.prepare();
    const max = this.opts.maxIterations ?? 60;
    const goal = this.opts.drag;
    const goalComp = goal && this.index.has(goal.body) ? this.compOf.get(this.find(this.index.get(goal.body)!)) : undefined;
    this.components.forEach((_, ci) => {
      if (ci === goalComp) { this.solveComponent(ci, goal, Math.max(4, max >> 1)); this.solveComponent(ci, undefined, max); }
      else this.solveComponent(ci, undefined, max);
    });
    // every mate's state as solved
    let ok = true;
    const scratch: number[] = [];
    for (const p of this.live) {
      const [a, b] = this.frames(p);
      evaluate(p.m.solve, p.m.params, a, b, this.reach, p.drives, scratch);
      let top = 0; for (const v of scratch) top = Math.max(top, Math.abs(v));
      const values: { [key: string]: number } = {};
      for (const v of p.m.solve.values || []) values[v.key] = v.unit === "deg" ? (v.measure(a, b) * 180) / Math.PI : v.measure(a, b);
      const good = top < FAILED;
      if (!good) ok = false;
      this.reports.set(p.m.id, good ? { status: "ok", residual: top, values } : { status: "conflict", residual: top, values, message: "This mate cannot hold together with the others." });
    }
    return ok;
  }

  /** The freedoms left: per body, and in all. */
  analyze(): { bodies: Map<string, BodyReport>; dof: number | null } {
    const out = new Map<string, BodyReport>();
    const groupDof = new Map<number, number | null>();
    let total: number | null = 0;
    const r0: number[] = [], rp: number[] = [], rm: number[] = [];
    for (const c of this.components) {
      const n = c.n;
      if (n > ANALYZE_MAX) { for (const g of c.groups) groupDof.set(g, null); total = null; continue; }
      const A = new Float64Array(n * n);
      const pivots = c.groups.map((gr) => this.pivot(gr));
      const J = new Float64Array(24 * 12);
      for (const p of c.mates) {
        const [a, b] = this.frames(p);
        evaluate(p.m.solve, p.m.params, a, b, this.reach, undefined, r0, false);
        const m = r0.length;
        for (let side = 0; side < 2; side++) {
          const v = side ? p.vb : p.va; if (v < 0) continue;
          for (let k = 0; k < 6; k++) {
            if (side) { evaluate(p.m.solve, p.m.params, a, perturb(b, pivots[v], k, H, this.reach), this.reach, undefined, rp, false); evaluate(p.m.solve, p.m.params, a, perturb(b, pivots[v], k, -H, this.reach), this.reach, undefined, rm, false); }
            else { evaluate(p.m.solve, p.m.params, perturb(a, pivots[v], k, H, this.reach), b, this.reach, undefined, rp, false); evaluate(p.m.solve, p.m.params, perturb(a, pivots[v], k, -H, this.reach), b, this.reach, undefined, rm, false); }
            for (let i = 0; i < m; i++) J[i * 12 + side * 6 + k] = (rp[i] - rm[i]) / (2 * H);
          }
        }
        const cols: number[] = [];
        if (p.va >= 0) for (let k = 0; k < 6; k++) cols.push(p.va * 6 + k, k);
        if (p.vb >= 0) for (let k = 0; k < 6; k++) cols.push(p.vb * 6 + k, 6 + k);
        for (let x = 0; x < cols.length; x += 2) for (let y = 0; y < cols.length; y += 2) {
          let t = 0; for (let i = 0; i < m; i++) t += J[i * 12 + cols[x + 1]] * J[i * 12 + cols[y + 1]];
          A[cols[x] * n + cols[y]] += t;
        }
      }
      const { nullspace } = pivotedCholesky(A, n, 1e-9);
      if (total !== null) total += nullspace.length;
      c.groups.forEach((g, v) => groupDof.set(g, rankOf(nullspace.map((vec) => vec.subarray(v * 6, v * 6 + 6)), 6)));
    }
    this.bodies.forEach((b, i) => {
      const g = this.find(i);
      if (this.ground[g]) { out.set(b.id, { grounded: true, dof: 0 }); return; }
      if (!groupDof.has(g)) { groupDof.set(g, 6); if (total !== null) total += 6; }
      out.set(b.id, { grounded: false, dof: groupDof.get(g)! });
    });
    return { bodies: out, dof: total };
  }

  grounded(i: number): boolean { return this.ground[this.find(i)]; }
}

function finish(core: Core, ok: boolean, analyze: boolean, t0: number, iterations: number): SolveResult {
  const poses = new Map<string, Pose>();
  core.bodies.forEach((b, i) => poses.set(b.id, core.worldPose(i)));
  let bodies = new Map<string, BodyReport>(), dof: number | null = null;
  if (analyze) { const a = core.analyze(); bodies = a.bodies; dof = a.dof; }
  else core.bodies.forEach((b, i) => bodies.set(b.id, { grounded: core.grounded(i), dof: null }));
  return { poses, mates: core.reports, bodies, ok, dof, iterations, ms: now() - t0 };
}

/**
 * Solve the mates.  Returns every body's pose, each mate's state and, with `analyze`, the freedoms left and
 * the conflicting mates.  When the mates cannot all hold and `analyze` is set, the poses returned satisfy the
 * ones that can, and the others are reported as conflicts; without it the poses are the best compromise found.
 */
export function solve(bodies: readonly SolverBody[], mates: readonly SolverMate[], opts: SolveOptions = {}): SolveResult {
  const t0 = now();
  const core = new Core(bodies, mates, opts);
  const ok = core.run();
  if (ok || !opts.analyze) return finish(core, ok, !!opts.analyze, t0, core.iterations);
  let iterations = core.iterations;
  // Which mates conflict?  Add them one at a time, the newest (the seed) last; one that breaks a system that
  // held until then is a conflict and is left out.
  const order = mates.filter((m) => core.live.some((p) => p.m === m));
  if (opts.seed) order.sort((p, q) => (p.id === opts.seed ? 1 : 0) - (q.id === opts.seed ? 1 : 0));
  let kept: SolverMate[] = [];
  const conflicts = new Set<string>();
  if (order.length > CONFLICT_MAX) {
    for (const [id, r] of core.reports) if (r.status === "conflict") conflicts.add(id);
    kept = order.filter((m) => !conflicts.has(m.id));
  } else {
    let state: readonly SolverBody[] = bodies;
    for (const m of order) {
      const trial = new Core(state, [...kept, m], { ...opts, drag: undefined, seed: opts.seed === m.id ? opts.seed : undefined });
      const good = trial.run();
      iterations += trial.iterations;
      if (good) { kept.push(m); state = bodies.map((b, i) => ({ ...b, pose: trial.worldPose(i) })); }
      else conflicts.add(m.id);
    }
  }
  const last = new Core(bodies, kept, { ...opts, drag: undefined });
  last.run();
  for (const [id, r] of core.reports) {
    if (r.status === "error") last.reports.set(id, r);
    else if (conflicts.has(id)) last.reports.set(id, { status: "conflict", residual: r.residual, values: r.values, message: "This mate conflicts with the mates before it: they cannot all hold. Suppress or delete one of them, or change its connectors." });
  }
  return finish(last, false, true, t0, iterations + last.iterations);
}

/**
 * Where one mate alone puts its second instance, staying as near to where it is as the mate's freedoms allow:
 * what MateDefinition.place answers.
 */
export function placeAlone(s: MateSolve, a: MateFrame, b: MateFrame, bNow: Pose, params: JsonObject): Pose {
  const inv = inverse(bNow);
  const local: MateFrame = { o: applyPose(inv, b.o), x: qrot(inv.q, b.x), y: qrot(inv.q, b.y), z: qrot(inv.q, b.z), surface: b.surface, radius: b.radius };
  const r = solve([{ id: "a", pose: { p: [0, 0, 0], q: [0, 0, 0, 1] }, fixed: true }, { id: "b", pose: bNow, fixed: false }],
    [{ id: "m", solve: s, a: { body: "a", frame: a }, b: { body: "b", frame: local }, params }]);
  return r.poses.get("b")!;
}
