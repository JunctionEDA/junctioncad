// ops.ts — the sketch tools that change what is drawn: fillet, trim, extend, offset, mirror.  Each is a
// function on a `Draft` (sketch/model.ts) that returns null when it did its work, or a sentence saying why it
// could not.  They add the constraints that keep the result what it was meant to be (a fillet stays tangent,
// a trimmed end stays on the curve that cut it, a mirror stays a mirror).  Pure: no pointer, no solver.
import type { Vec2 } from "../core/geometry";
import type { SketchData, SketchEntity } from "./format";
import { curvesAt, nearestOn } from "./infer";
import type { Draft } from "./model";
import { arcSweep, dist, lineMeet, pointAt, pointsOf, resolveEntity, type Resolved } from "./refs";

const TOL = 1e-7;
const TAU = Math.PI * 2;
type Curve = Exclude<Resolved, { kind: "point" }>;

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const unit = (v: Vec2): Vec2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

// ---------------------------------------------------------------- where curves meet
/** Where the carriers of two curves meet: the infinite lines, the whole circles. */
export function carriersMeet(p: Curve, q: Curve): Vec2[] {
  if (p.kind === "line" && q.kind === "line") { const x = lineMeet(p.a, p.b, q.a, q.b); return x ? [x] : []; }
  if (p.kind !== "line" && q.kind !== "line") {
    const dx = q.c[0] - p.c[0], dy = q.c[1] - p.c[1], d = Math.hypot(dx, dy);
    if (d < TOL || d > p.r + q.r + TOL || d < Math.abs(p.r - q.r) - TOL) return [];
    const a = (d * d + p.r * p.r - q.r * q.r) / (2 * d), h2 = p.r * p.r - a * a;
    const mx = p.c[0] + (dx * a) / d, my = p.c[1] + (dy * a) / d;
    if (h2 <= TOL) return [[mx, my]];
    const h = Math.sqrt(h2);
    return [[mx - (dy * h) / d, my + (dx * h) / d], [mx + (dy * h) / d, my - (dx * h) / d]];
  }
  const line = (p.kind === "line" ? p : q) as Extract<Curve, { kind: "line" }>, circ = (p.kind === "line" ? q : p) as Exclude<Curve, { kind: "line" }>;
  const u = unit(sub(line.b, line.a));
  const s = (circ.c[0] - line.a[0]) * u[0] + (circ.c[1] - line.a[1]) * u[1];
  const f: Vec2 = [line.a[0] + u[0] * s, line.a[1] + u[1] * s], off = dist(circ.c, f);
  if (off > circ.r + TOL) return [];
  const h2 = circ.r * circ.r - off * off;
  if (h2 <= TOL) return [f];
  const h = Math.sqrt(h2);
  return [[f[0] - u[0] * h, f[1] - u[1] * h], [f[0] + u[0] * h, f[1] + u[1] * h]];
}

/** The start and end of a curve's own parameter: 0…1 along a line, the angles of an arc, 0…2π round a circle. */
function extent(k: Curve): [number, number] {
  if (k.kind === "line") return [0, 1];
  if (k.kind === "circle") return [0, TAU];
  const { a0, a1 } = arcSweep(k.c, k.s, k.en);
  return [a0, a1];
}
/** The parameter of a point on a curve's carrier (not limited to the curve's extent, but brought near it for an arc). */
export function paramOf(k: Curve, p: Vec2): number {
  if (k.kind === "line") { const d = sub(k.b, k.a), l2 = d[0] * d[0] + d[1] * d[1] || 1; return ((p[0] - k.a[0]) * d[0] + (p[1] - k.a[1]) * d[1]) / l2; }
  const [a0] = extent(k);
  let t = Math.atan2(p[1] - k.c[1], p[0] - k.c[0]);
  while (t < a0 - 1e-9) t += TAU; while (t >= a0 + TAU - 1e-9) t -= TAU;
  return t;
}
export function pointOn(k: Curve, t: number): Vec2 {
  return k.kind === "line" ? [k.a[0] + (k.b[0] - k.a[0]) * t, k.a[1] + (k.b[1] - k.a[1]) * t] : [k.c[0] + k.r * Math.cos(t), k.c[1] + k.r * Math.sin(t)];
}
/** Whether a parameter lies on the curve itself (ends included, within tolerance). */
function within(k: Curve, t: number): boolean {
  const [lo, hi] = extent(k), slack = TOL / (k.kind === "line" ? dist(k.a, k.b) || 1 : k.r);
  return t >= lo - slack && t <= hi + slack;
}

interface Cut { t: number; p: Vec2; by: string }
/** Where other curves cross this one (within both extents unless `carrier`), sorted along it. */
function cuts(data: SketchData, id: string, k: Curve, carrier = false): Cut[] {
  const out: Cut[] = [];
  for (const other of Object.keys(data.entities)) {
    if (other === id) continue;
    const o = resolveEntity(data, other); if (!o || o.kind === "point") continue;
    for (const p of carriersMeet(k, o)) {
      if (!within(o, paramOf(o, p))) continue;
      const t = paramOf(k, p);
      if (!carrier && !within(k, t)) continue;
      out.push({ t, p, by: other });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The point of the draft at a place: an existing one when there is one there, else a new one tied to the curve it lies on. */
function pointAtCut(d: Draft, cut: Cut): string {
  for (const [id, e] of Object.entries(d.data.entities)) if (e.type === "point" && Math.hypot(e.x - cut.p[0], e.y - cut.p[1]) < 1e-6 && pointsOf(d.data.entities[cut.by]).includes(id)) return id;
  const id = d.point(cut.p);
  d.constrain("coincident", [id, cut.by]);
  return id;
}
/** Delete a point if no curve uses it any more (with the constraints that named it). */
function dropIfLoose(d: Draft, point: string): void {
  if (!d.data.entities[point]) return;
  if (Object.values(d.data.entities).some((e) => pointsOf(e).includes(point))) return;
  d.remove([point]);
}

// ---------------------------------------------------------------- trim
/** Remove the stretch of a curve under `click`, up to the curves that cross it on either side. */
export function trim(d: Draft, id: string, click: Vec2): string | null {
  const k = resolveEntity(d.data, id);
  if (!k || k.kind === "point") return "Click a curve to trim.";
  const e = d.data.entities[id];
  const [lo, hi] = extent(k), tc = paramOf(k, click);
  const eps = TOL * 10 / (k.kind === "line" ? dist(k.a, k.b) || 1 : k.r);
  const all = cuts(d.data, id, k).filter((c) => k.kind === "circle" || (c.t > lo + eps && c.t < hi - eps));

  if (k.kind === "circle") {
    const u = all.filter((c, i) => i === 0 || c.t - all[i - 1].t > eps);
    if (u.length < 2) { d.remove([id]); return null; }
    // the stretch from u[i] round to u[i+1] that holds the click goes; the rest is an arc from its end to its start
    let i = u.findIndex((c, j) => { const next = j + 1 < u.length ? u[j + 1].t : u[0].t + TAU; const t = tc < c.t ? tc + TAU : tc; return t >= c.t && t <= next; });
    if (i < 0) i = u.length - 1;
    const from = u[(i + 1) % u.length], to = u[i];
    d.set(id, { type: "arc", center: (e as { center: string }).center, start: pointAtCut(d, from), end: pointAtCut(d, to), ...(e.construction ? { construction: true } : {}) });
    return null;
  }

  const below = all.filter((c) => c.t < tc).pop(), above = all.find((c) => c.t > tc);
  if (!below && !above) { d.remove([id]); return null; }
  const startKey = k.kind === "line" ? "a" : "start", endKey = k.kind === "line" ? "b" : "end";
  const ent = e as unknown as { [key: string]: string };
  const oldStart = ent[startKey], oldEnd = ent[endKey];
  if (below && above) {
    // the middle goes: this curve keeps the first part, a new curve is the last part
    const p1 = pointAtCut(d, below), p2 = pointAtCut(d, above);
    d.set(id, { ...e, [endKey]: p1 } as SketchEntity);
    if (k.kind === "line") d.line(p2, oldEnd, !!e.construction); else d.arc(k.e.center, p2, oldEnd, !!e.construction);
    return null;
  }
  if (below) { d.set(id, { ...e, [endKey]: pointAtCut(d, below) } as SketchEntity); dropIfLoose(d, oldEnd); }
  else { d.set(id, { ...e, [startKey]: pointAtCut(d, above!) } as SketchEntity); dropIfLoose(d, oldStart); }
  return null;
}

// ---------------------------------------------------------------- extend
/** Lengthen the end of a line or arc nearest `click` to the next curve it would meet. */
export function extend(d: Draft, id: string, click: Vec2): string | null {
  const k = resolveEntity(d.data, id);
  if (!k || k.kind === "point" || k.kind === "circle") return "Click near the end of a line or an arc to extend it.";
  const e = d.data.entities[id] as unknown as { [key: string]: string };
  const [lo, hi] = extent(k);
  const atEnd = k.kind === "line" ? dist(click, k.b) < dist(click, k.a) : dist(click, k.en) < dist(click, k.s);
  const eps = TOL * 10 / (k.kind === "line" ? dist(k.a, k.b) || 1 : k.r);
  const beyond = cuts(d.data, id, k, true).filter((c) => {
    if (k.kind === "line") return atEnd ? c.t > hi + eps : c.t < lo - eps;
    // round the circle past the end (or back past the start), short of coming all the way round
    return c.t > hi + eps && c.t < lo + TAU - eps;
  });
  if (!beyond.length) return "Nothing lies beyond that end to extend to.";
  const target = k.kind === "line" ? (atEnd ? beyond[0] : beyond[beyond.length - 1]) : atEnd ? beyond[0] : beyond[beyond.length - 1];
  const key = k.kind === "line" ? (atEnd ? "b" : "a") : atEnd ? "end" : "start";
  const old = e[key], p = pointAtCut(d, target);
  d.set(id, { ...(e as unknown as SketchEntity), [key]: p } as SketchEntity);
  dropIfLoose(d, old);
  return null;
}

// ---------------------------------------------------------------- fillet
/** Round the corner where two lines meet at `corner` with an arc of radius `r`, tangent to both. */
export function fillet(d: Draft, corner: string, r: number): string | null {
  if (!(r > 0)) return "The fillet radius must be more than zero.";
  const p = pointAt(d.data, corner);
  const lines = curvesAt(d.data, corner).filter((id) => d.data.entities[id].type === "line");
  if (!p || lines.length !== 2 || curvesAt(d.data, corner).length !== 2) return "Click a corner where two lines meet.";
  const far = lines.map((id) => { const e = d.data.entities[id] as { a: string; b: string }; return e.a === corner ? e.b : e.a; });
  const a = pointAt(d.data, far[0]), b = pointAt(d.data, far[1]);
  if (!a || !b) return "Click a corner where two lines meet.";
  const u = unit(sub(a, p)), v = unit(sub(b, p));
  const cos = u[0] * v[0] + u[1] * v[1], angle = Math.acos(Math.max(-1, Math.min(1, cos)));
  if (angle < 1e-6 || Math.PI - angle < 1e-6) return "Those lines do not make a corner.";
  const back = r / Math.tan(angle / 2);
  if (back > dist(a, p) - 1e-9 || back > dist(b, p) - 1e-9) return "That radius is too large for this corner.";
  const t1: Vec2 = [p[0] + u[0] * back, p[1] + u[1] * back], t2: Vec2 = [p[0] + v[0] * back, p[1] + v[1] * back];
  const bis = unit([u[0] + v[0], u[1] + v[1]]), reach = r / Math.sin(angle / 2);
  const c: Vec2 = [p[0] + bis[0] * reach, p[1] + bis[1] * reach];
  const q1 = d.point(t1), q2 = d.point(t2), centre = d.point(c);
  // What was said about the lines up to the corner is still meant up to the corner, not up to where the arc
  // now starts: a length becomes the distance from the far end to the sharp corner, and a reference to the
  // line's end at the corner becomes a reference to the corner itself.
  lines.forEach((id, i) => {
    const e = d.data.entities[id] as { a: string; b: string };
    const end = e.a === corner ? "start" : "end";
    for (const cid of d.constraintsOn(id)) {
      const k = d.data.constraints[cid];
      if (k.type === "distance" && k.refs.length === 1 && !k.refs[0].at) d.data.constraints[cid] = { ...k, refs: [{ entity: far[i] }, { entity: corner }] };
      else if (k.refs.some((r) => r.entity === id && r.at === end)) d.data.constraints[cid] = { ...k, refs: k.refs.map((r) => (r.entity === id && r.at === end ? { entity: corner } : r)) };
    }
  });
  const swap = (id: string, to: string) => { const e = d.data.entities[id] as { type: "line"; a: string; b: string }; d.set(id, { ...e, a: e.a === corner ? to : e.a, b: e.b === corner ? to : e.b }); };
  swap(lines[0], q1); swap(lines[1], q2);
  // counter-clockwise the short way round
  const ccw = (t1[0] - c[0]) * (t2[1] - c[1]) - (t1[1] - c[1]) * (t2[0] - c[0]) > 0;
  const arc = d.arc(centre, ccw ? q1 : q2, ccw ? q2 : q1, false);
  d.constrain("tangent", [lines[0], arc]); d.constrain("tangent", [lines[1], arc]);
  d.constrain("radius", [arc], { value: r });
  // dimensions that reached to the sharp corner still do: the corner stays as a point where the two lines would meet
  if (d.constraintsOn(corner).length) { d.constrain("coincident", [corner, lines[0]]); d.constrain("coincident", [corner, lines[1]]); }
  else d.remove([corner]);
  return null;
}

// ---------------------------------------------------------------- offset
/** The curves joined end to end with `id`, in order, each with whether the chain runs along its own direction. */
export function chainOf(data: SketchData, id: string, among?: ReadonlySet<string>): { id: string; forward: boolean }[] {
  const ends = (cid: string): [string, string] | null => { const e = data.entities[cid]; return e && e.type === "line" ? [e.a, e.b] : e && e.type === "arc" ? [e.start, e.end] : null; };
  const first = ends(id); if (!first) return data.entities[id] ? [{ id, forward: true }] : [];
  const used = new Set([id]);
  const walk = (from: string): { id: string; forward: boolean }[] => {
    const out: { id: string; forward: boolean }[] = [];
    let at = from;
    for (;;) {
      const next = curvesAt(data, at).filter((c) => !used.has(c) && (!among || among.has(c)) && ends(c));
      if (next.length !== 1) return out;
      const en = ends(next[0])!; used.add(next[0]);
      const forward = en[0] === at;
      out.push({ id: next[0], forward });
      at = forward ? en[1] : en[0];
      if (at === first[0] && from === first[1]) return out;   // came all the way round
    }
  };
  const after = walk(first[1]);
  const closed = after.length > 0 && (() => { const l = after[after.length - 1], en = ends(l.id)!; return (l.forward ? en[1] : en[0]) === first[0]; })();
  const before = closed ? [] : walk(first[0]).map((x) => ({ id: x.id, forward: !x.forward })).reverse();
  return [...before, { id, forward: true }, ...after];
}

/**
 * Offset curves by `distance` towards the side `toward` lies on.  Curves that join are offset as one outline,
 * and the corners are remade where the offset curves meet.  Each new line is parallel to its original, each new
 * arc shares its original's centre, and one distance dimension drives the offset.
 */
export function offset(d: Draft, ids: readonly string[], distance: number, toward: Vec2): string | null {
  if (!(distance > 0)) return "The offset distance must be more than zero.";
  const data = d.data, among = new Set(ids.filter((id) => { const e = data.entities[id]; return e && e.type !== "point"; }));
  if (!among.size) return "Select the curves to offset.";
  const done = new Set<string>();
  let made = 0;
  for (const id of among) {
    if (done.has(id)) continue;
    const e = data.entities[id];
    if (e.type === "circle") {
      done.add(id);
      const k = resolveEntity(data, id) as Extract<Curve, { kind: "circle" }>;
      const r = dist(toward, k.c) < k.r ? k.r - distance : k.r + distance;
      if (!(r > 1e-9)) return "That offset would shrink a circle to nothing.";
      d.circle(e.center, r, !!e.construction); made++;
      continue;
    }
    const chain = chainOf(data, id, among);
    for (const c of chain) done.add(c.id);
    // the side: left or right of the chain's direction, judged at the curve nearest `toward`
    let best = Infinity, left = true;
    for (const c of chain) {
      const k = resolveEntity(data, c.id) as Curve;
      const n = nearestOn(k, toward), dd = n ? n.d : Infinity;
      if (dd >= best) continue;
      best = dd;
      const onLeft = k.kind === "line" ? (k.b[0] - k.a[0]) * (toward[1] - k.a[1]) - (k.b[1] - k.a[1]) * (toward[0] - k.a[0]) > 0 : dist(toward, k.c) < k.r;
      left = c.forward ? onLeft : !onLeft;
    }
    // each curve moved over, as a carrier
    const moved: Curve[] = [];
    for (const c of chain) {
      const k = resolveEntity(data, c.id) as Curve;
      const s = (left ? 1 : -1) * (c.forward ? 1 : -1) * distance;   // to the left of the curve's own direction
      if (k.kind === "line") { const u = unit(sub(k.b, k.a)), n: Vec2 = [-u[1] * s, u[0] * s]; moved.push({ ...k, a: [k.a[0] + n[0], k.a[1] + n[1]], b: [k.b[0] + n[0], k.b[1] + n[1]] }); }
      else if (k.kind === "arc") {
        const r = k.r - s; if (!(r > 1e-9)) return "That offset would shrink an arc to nothing.";
        const f = r / k.r; moved.push({ ...k, r, s: [k.c[0] + (k.s[0] - k.c[0]) * f, k.c[1] + (k.s[1] - k.c[1]) * f], en: [k.c[0] + (k.en[0] - k.c[0]) * f, k.c[1] + (k.en[1] - k.c[1]) * f] });
      } else return "Offset works on lines, arcs and circles.";
    }
    const endOf = (k: Curve, forward: boolean, last: boolean): Vec2 => (k.kind === "line" ? (last === forward ? k.b : k.a) : k.kind === "arc" ? (last === forward ? k.en : k.s) : [0, 0]);
    const n = chain.length;
    const first = chain[0], lastC = chain[n - 1];
    const startId = (c: { id: string; forward: boolean }) => { const en = data.entities[c.id] as { a?: string; b?: string; start?: string; end?: string }; return c.forward ? (en.a ?? en.start)! : (en.b ?? en.end)!; };
    const endId = (c: { id: string; forward: boolean }) => startId({ id: c.id, forward: !c.forward });
    const closed = n > 1 && endId(lastC) === startId(first);
    // the joints: where neighbours' carriers meet, nearest to where the old joint went
    const joint: string[] = [];
    for (let i = 0; i <= n; i++) {
      if (i === n && closed) { joint.push(joint[0]); break; }
      const prev = i > 0 ? i - 1 : closed ? n - 1 : -1, next = i < n ? i : -1;
      const naive = next >= 0 ? endOf(moved[next], chain[next].forward, false) : endOf(moved[prev], chain[prev].forward, true);
      let at = naive;
      if (prev >= 0 && next >= 0) { let bestD = Infinity; for (const x of carriersMeet(moved[prev], moved[next])) { const dd = dist(x, naive); if (dd < bestD) { bestD = dd; at = x; } } }
      joint.push(d.point(at));
    }
    chain.forEach((c, i) => {
      const src = data.entities[c.id], from = joint[i], to = joint[i + 1];
      const a = c.forward ? from : to, b = c.forward ? to : from;
      if (src.type === "line") {
        const made = d.line(a, b, !!src.construction);
        d.constrain("parallel", [c.id, made]);
        if (i === chain.findIndex((x) => data.entities[x.id].type === "line")) d.constrain("distance", [c.id, made], { value: distance });
      } else if (src.type === "arc") d.arc(src.center, a, b, !!src.construction);
      made++;
    });
  }
  return made ? null : "Select the curves to offset.";
}

// ---------------------------------------------------------------- mirror
/** Copy entities to the other side of a line, and keep them its mirror image. */
export function mirror(d: Draft, ids: readonly string[], axis: string): string | null {
  const ax = resolveEntity(d.data, axis);
  if (!ax || ax.kind !== "line") return "Click a line to mirror about.";
  const u = unit(sub(ax.b, ax.a));
  const reflect = (p: Vec2): Vec2 => { const v = sub(p, ax.a), along = v[0] * u[0] + v[1] * u[1]; return [2 * (ax.a[0] + u[0] * along) - p[0], 2 * (ax.a[1] + u[1] * along) - p[1]]; };
  const curves = ids.filter((id) => id !== axis && d.data.entities[id]);
  if (!curves.length) return "Select what to mirror, then click the line to mirror about.";
  const twin = new Map<string, string>();
  const twinOf = (pid: string): string => {
    if (twin.has(pid)) return twin.get(pid)!;
    const p = pointAt(d.data, pid)!, q = reflect(p);
    // a point on the mirror line is its own image
    const id = dist(p, q) < 1e-7 ? pid : d.point(q);
    if (id !== pid) d.constrain("symmetric", [pid, id, axis]);
    twin.set(pid, id);
    return id;
  };
  let made = 0;
  for (const id of curves) {
    const e = d.data.entities[id];
    if (e.type === "point") { if (!Object.values(d.data.entities).some((x) => pointsOf(x).includes(id))) { twinOf(id); made++; } continue; }
    if (pointsOf(e).some((pid) => !pointAt(d.data, pid))) continue;
    if (e.type === "line") d.line(twinOf(e.a), twinOf(e.b), !!e.construction);
    else if (e.type === "circle") { const c = d.circle(twinOf(e.center), e.r, !!e.construction); d.constrain("equal", [id, c]); }
    else if (e.type === "arc") d.arc(twinOf(e.center), twinOf(e.end), twinOf(e.start), !!e.construction);   // a mirror turns the arc the other way round
    made++;
  }
  return made ? null : "Select what to mirror, then click the line to mirror about.";
}
