// shapes.ts — the shapes the drawing tools make: for each, how many clicks, the rubber band, the measures that
// can be typed, and the entities and constraints it adds.  The engine is sketch/draw.ts; a tool file under
// tools/ is a title, an icon, a key and one of these.
//
// Every shape is built already constrained the way a person means it: a rectangle's sides are horizontal and
// vertical, a slot's ends are tangent to its sides, a tangent arc is tangent to the curve it leaves.  What is
// left free is its size and place, for dimensions.
import type { Vec2 } from "../core/geometry";
import type { ShapeSpec, Typed } from "./draw";
import type { SketchData } from "./format";
import { curvesAt, pointFor, relateLine, type Snap } from "./infer";
import type { Draft } from "./model";
import { arcSweep, dist, pointAt, resolveEntity } from "./refs";

const TAU = Math.PI * 2;
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: Vec2): number => Math.hypot(a[0], a[1]);
const held = (p: Vec2, point?: string): Snap => ({ p, point, hints: [], guides: [] });
const ring = (c: Vec2, r: number, a0 = 0, a1 = TAU): Vec2[] => {
  const n = Math.max(8, Math.ceil((Math.abs(a1 - a0) / TAU) * 72)), out: Vec2[] = [];
  for (let i = 0; i <= n; i++) { const t = a0 + ((a1 - a0) * i) / n; out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
  return out;
};
const deg = (v: Vec2): number => { const a = (Math.atan2(v[1], v[0]) * 180) / Math.PI; return a < 0 ? a + 360 : a; };

// ---------------------------------------------------------------- line
export const line: ShapeSpec = {
  id: "sketch-line", clicks: 2,
  hint: (n) => (n ? "Click the end of the line, or type its length. Esc or Enter ends the chain." : "Click where the line starts."),
  context: (pts, _data, chain) => (pts.length ? { from: pts[0].p, after: chain || undefined } : {}),
  fields: (pts, c) => { const v = sub(c, pts[0].p); return [{ key: "length", label: "L", unit: "mm", value: len(v) }, { key: "angle", label: "∠", unit: "deg", value: deg(v) }]; },
  constrain: (pts, c, typed) => {
    const from = pts[0].p, v = sub(c, from);
    let u: Vec2 = len(v) > 1e-12 ? [v[0] / len(v), v[1] / len(v)] : [1, 0];
    if (typed.angle !== undefined) { const t = (typed.angle * Math.PI) / 180; u = [Math.cos(t), Math.sin(t)]; }
    const l = typed.length !== undefined ? typed.length : Math.max(0, v[0] * u[0] + v[1] * u[1]);
    return [from[0] + u[0] * l, from[1] + u[1] * l];
  },
  preview: (pts, c) => [[pts[0].p, c.p]],
  build(d, pts, typed, chain) {
    if (dist(pts[0].p, pts[1].p) < 1e-7) return false;
    const a = pointFor(d, pts[0]), existing = !!pts[1].point;
    const b = pointFor(d, pts[1]);
    if (a === b) return false;
    const id = d.line(a, b);
    relateLine(d, id, pts[1]);
    if (typed.angle !== undefined) {
      const t = ((typed.angle % 180) + 180) % 180;
      if (t === 0) d.constrain("horizontal", [id]); else if (t === 90) d.constrain("vertical", [id]);
      else if (chain && d.data.entities[chain]) d.constrain("angle", [chain, id], { value: angleBetween(d.data, chain, id) });
    }
    if (typed.length !== undefined) d.constrain("distance", [id], { value: typed.length });
    // a line that lands on an existing point has closed something: the chain ends there
    return existing ? {} : { next: [held(pts[1].p, b)], chain: id };
  },
};
function angleBetween(data: SketchData, l1: string, l2: string): number {
  const a = resolveEntity(data, l1), b = resolveEntity(data, l2);
  if (!a || !b || a.kind !== "line" || b.kind !== "line") return 0;
  const u = sub(a.a, a.b), v = sub(b.b, b.a);   // both away from the corner they share
  return Math.round(((Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180) / Math.PI) * 1e6) / 1e6;
}

// ---------------------------------------------------------------- rectangles
function box(d: Draft, corners: Vec2[], use: (string | undefined)[], typed: Typed): string[] {
  const p = corners.map((c, i) => use[i] || d.point(c));
  const l = [0, 1, 2, 3].map((i) => d.line(p[i], p[(i + 1) % 4]));
  d.constrain("horizontal", [l[0]]); d.constrain("vertical", [l[1]]); d.constrain("horizontal", [l[2]]); d.constrain("vertical", [l[3]]);
  if (typed.width !== undefined) d.constrain("distance", [l[0]], { value: typed.width });
  if (typed.height !== undefined) d.constrain("distance", [l[1]], { value: typed.height });
  return p;
}
const size = (a: Vec2, b: Vec2, typed: Typed, full: number): Vec2 => [
  a[0] + (b[0] < a[0] ? -1 : 1) * (typed.width !== undefined ? typed.width / full : Math.abs(b[0] - a[0])),
  a[1] + (b[1] < a[1] ? -1 : 1) * (typed.height !== undefined ? typed.height / full : Math.abs(b[1] - a[1])),
];

export const rectangle: ShapeSpec = {
  id: "sketch-rectangle", clicks: 2, drag: true,
  hint: (n) => (n ? "Click the opposite corner, or type width and height (Tab between them)." : "Click a corner, or drag from corner to corner."),
  context: () => ({ relations: false }),
  fields: (pts, c) => [{ key: "width", label: "W", unit: "mm", value: Math.abs(c[0] - pts[0].p[0]) }, { key: "height", label: "H", unit: "mm", value: Math.abs(c[1] - pts[0].p[1]) }],
  constrain: (pts, c, typed) => size(pts[0].p, c, typed, 1),
  preview: (pts, c) => { const a = pts[0].p, b = c.p; return [[a, [b[0], a[1]], b, [a[0], b[1]], a]]; },
  build(d, pts, typed) {
    const a = pts[0].p, b = pts[1].p;
    if (Math.abs(b[0] - a[0]) < 1e-7 || Math.abs(b[1] - a[1]) < 1e-7) return false;
    // counter-clockwise from the lower left, whichever corners were clicked
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    const corners: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const at = (s: Snap) => corners.findIndex((c) => dist(c, s.p) < 1e-9);
    const use: (string | undefined)[] = [];
    use[at(pts[0])] = pointFor(d, pts[0]); use[at(pts[1])] = pointFor(d, pts[1]);
    box(d, corners, use, typed);
    return {};
  },
};

export const centerRectangle: ShapeSpec = {
  id: "sketch-center-rectangle", clicks: 2, drag: true,
  hint: (n) => (n ? "Click a corner, or type width and height." : "Click the centre of the rectangle."),
  context: () => ({ relations: false }),
  fields: (pts, c) => [{ key: "width", label: "W", unit: "mm", value: 2 * Math.abs(c[0] - pts[0].p[0]) }, { key: "height", label: "H", unit: "mm", value: 2 * Math.abs(c[1] - pts[0].p[1]) }],
  constrain: (pts, c, typed) => size(pts[0].p, c, typed, 2),
  preview: (pts, c) => { const o = pts[0].p, w = Math.abs(c.p[0] - o[0]), h = Math.abs(c.p[1] - o[1]); return [[[o[0] - w, o[1] - h], [o[0] + w, o[1] - h], [o[0] + w, o[1] + h], [o[0] - w, o[1] + h], [o[0] - w, o[1] - h]], [[o[0] - w, o[1] - h], [o[0] + w, o[1] + h]]]; },
  build(d, pts, typed) {
    const o = pts[0].p, w = Math.abs(pts[1].p[0] - o[0]), h = Math.abs(pts[1].p[1] - o[1]);
    if (w < 1e-7 || h < 1e-7) return false;
    const corners: Vec2[] = [[o[0] - w, o[1] - h], [o[0] + w, o[1] - h], [o[0] + w, o[1] + h], [o[0] - w, o[1] + h]];
    const use: (string | undefined)[] = [];
    const i = corners.findIndex((c) => dist(c, pts[1].p) < 1e-9);
    if (i >= 0) use[i] = pointFor(d, pts[1]);
    const p = box(d, corners, use, typed);
    // the centre is the middle of a diagonal, which is what keeps it the centre when the rectangle is resized
    const diagonal = d.line(p[0], p[2], true);
    d.constrain("midpoint", [pointFor(d, pts[0]), diagonal]);
    return {};
  },
};

// ---------------------------------------------------------------- circle
export const circle: ShapeSpec = {
  id: "sketch-circle", clicks: 2, drag: true,
  hint: (n) => (n ? "Click a point on the circle, or type its diameter." : "Click the centre of the circle."),
  context: () => ({ relations: false }),
  fields: (pts, c) => [{ key: "diameter", label: "Ø", unit: "mm", value: 2 * dist(c, pts[0].p) }],
  constrain: (pts, c, typed) => { const o = pts[0].p, v = sub(c, o), l = len(v) || 1; return typed.diameter !== undefined ? [o[0] + (v[0] / l) * typed.diameter / 2, o[1] + (v[1] / l) * typed.diameter / 2] : c; },
  preview: (pts, c) => [ring(pts[0].p, dist(c.p, pts[0].p)), [pts[0].p, c.p]],
  build(d, pts, typed) {
    const r = dist(pts[0].p, pts[1].p);
    if (r < 1e-7) return false;
    const id = d.circle(pointFor(d, pts[0]), Math.round(r * 1e6) / 1e6);
    if (pts[1].point) d.constrain("coincident", [pts[1].point, id]);
    else if (pts[1].origin) d.constrain("coincident", ["$origin", id]);
    else if (pts[1].on) { const on = d.data.entities[pts[1].on]; if (on && on.type === "line") d.constrain("tangent", [pts[1].on, id]); }
    if (typed.diameter !== undefined) d.constrain("diameter", [id], { value: typed.diameter });
    return {};
  },
};

// ---------------------------------------------------------------- arcs
/** The centre of the circle through three points, or null when they are in line. */
export function circumcentre(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}
/** True when going counter-clockwise round `c` from `s` to `e` passes `m`. */
function ccwThrough(c: Vec2, s: Vec2, e: Vec2, m: Vec2): boolean {
  const { a0, a1 } = arcSweep(c, s, e);
  let t = Math.atan2(m[1] - c[1], m[0] - c[0]); while (t < a0) t += TAU;
  return t <= a1;
}

export const arc3: ShapeSpec = {
  id: "sketch-arc-3point", clicks: 3,
  hint: (n) => (n === 0 ? "Click where the arc starts." : n === 1 ? "Click where the arc ends." : "Click a point the arc passes through."),
  context: () => ({ relations: false }),
  preview(pts, c) {
    if (pts.length < 2) return [[pts[0].p, c.p]];
    const o = circumcentre(pts[0].p, pts[1].p, c.p);
    if (!o) return [[pts[0].p, pts[1].p]];
    const ccw = ccwThrough(o, pts[0].p, pts[1].p, c.p), s = ccw ? pts[0].p : pts[1].p, e = ccw ? pts[1].p : pts[0].p, { a0, a1 } = arcSweep(o, s, e);
    return [ring(o, dist(o, s), a0, a1)];
  },
  build(d, pts) {
    const o = circumcentre(pts[0].p, pts[1].p, pts[2].p);
    if (!o || dist(pts[0].p, pts[1].p) < 1e-7) return false;
    const a = pointFor(d, pts[0]), b = pointFor(d, pts[1]);
    if (a === b) return false;
    const ccw = ccwThrough(o, pts[0].p, pts[1].p, pts[2].p);
    const id = d.arc(d.point(o), ccw ? a : b, ccw ? b : a);
    if (pts[2].point) d.constrain("coincident", [pts[2].point, id]);
    return {};
  },
};

export function centerArc(): ShapeSpec {
  // which way round the pointer has gone since the start point was placed
  let lastAngle: number | null = null, swept = 0;
  const track = (o: Vec2, s: Vec2, c: Vec2) => {
    const t = Math.atan2(c[1] - o[1], c[0] - o[0]) - Math.atan2(s[1] - o[1], s[0] - o[0]);
    if (lastAngle !== null) { let dt = t - lastAngle; while (dt > Math.PI) dt -= TAU; while (dt < -Math.PI) dt += TAU; swept += dt; }
    lastAngle = t;
    swept = Math.max(-TAU * 0.999, Math.min(TAU * 0.999, swept));
  };
  const endOn = (o: Vec2, s: Vec2, c: Vec2): Vec2 => { const r = dist(o, s), v = sub(c, o), l = len(v) || 1; return [o[0] + (v[0] / l) * r, o[1] + (v[1] / l) * r]; };
  return {
    id: "sketch-arc-center", clicks: 3,
    hint: (n) => (n === 0 ? "Click the centre of the arc." : n === 1 ? "Click where the arc starts." : "Move round the centre and click where the arc ends."),
    context: () => ({ relations: false }),
    reset: () => { lastAngle = null; swept = 0; },
    fields: (pts, c) => (pts.length === 1 ? [{ key: "radius", label: "R", unit: "mm", value: dist(c, pts[0].p) }] : []),
    constrain: (pts, c, typed) => { if (pts.length !== 1 || typed.radius === undefined) return c; const o = pts[0].p, v = sub(c, o), l = len(v) || 1; return [o[0] + (v[0] / l) * typed.radius, o[1] + (v[1] / l) * typed.radius]; },
    preview(pts, c) {
      if (pts.length < 2) return [ring(pts[0].p, dist(c.p, pts[0].p)), [pts[0].p, c.p]];
      const o = pts[0].p, s = pts[1].p;
      track(o, s, c.p);
      const a0 = Math.atan2(s[1] - o[1], s[0] - o[0]);
      return [ring(o, dist(o, s), a0, a0 + swept), [o, s], [o, endOn(o, s, c.p)]];
    },
    build(d, pts) {
      const o = pts[0].p, s = pts[1].p, r = dist(o, s);
      if (r < 1e-7) return false;
      track(o, s, pts[2].p);
      const e = endOn(o, s, pts[2].p);
      if (dist(e, s) < 1e-7) return false;
      const centre = pointFor(d, pts[0]), start = pointFor(d, pts[1]);
      const end = pts[2].point && dist(pts[2].p, e) < 1e-6 ? pts[2].point : d.point(e);
      if (start === end || start === centre) return false;
      d.arc(centre, swept >= 0 ? start : end, swept >= 0 ? end : start);
      return {};
    },
  };
}

/** The direction a curve is going as it arrives at one of its end points (pointing out of the curve), or null. */
export function leavingDirection(data: SketchData, curve: string, point: string): Vec2 | null {
  const r = resolveEntity(data, curve), p = pointAt(data, point);
  if (!r || !p) return null;
  if (r.kind === "line") { const other = r.e.a === point ? r.b : r.e.b === point ? r.a : null; if (!other) return null; const v = sub(p, other), l = len(v); return l > 1e-12 ? [v[0] / l, v[1] / l] : null; }
  if (r.kind === "arc") {
    const v = sub(p, r.c), l = len(v); if (l < 1e-12) return null;
    // counter-clockwise from start to end: at the end it runs on counter-clockwise, at the start it runs back clockwise
    if (r.e.end === point) return [-v[1] / l, v[0] / l];
    if (r.e.start === point) return [v[1] / l, -v[0] / l];
  }
  return null;
}
/** The arc that leaves `s` in direction `t` and ends at `e`: its centre and whether it turns counter-clockwise. */
export function tangentArc(s: Vec2, t: Vec2, e: Vec2): { c: Vec2; ccw: boolean } | null {
  const n: Vec2 = [-t[1], t[0]], v = sub(e, s), side = v[0] * n[0] + v[1] * n[1];
  if (Math.abs(side) < 1e-9 * (len(v) + 1)) return null;   // straight ahead: no arc
  const k = (v[0] * v[0] + v[1] * v[1]) / (2 * side);
  return { c: [s[0] + n[0] * k, s[1] + n[1] * k], ccw: side > 0 };
}
/** The curve a tangent arc would leave from, when `point` is the free end of exactly one line or arc. */
function tangentSource(data: SketchData, point: string | undefined): { curve: string; t: Vec2 } | null {
  if (!point) return null;
  for (const curve of curvesAt(data, point)) { const t = leavingDirection(data, curve, point); if (t) return { curve, t }; }
  return null;
}

export const arcTangent: ShapeSpec = {
  id: "sketch-arc-tangent", clicks: 2,
  hint: (n) => (n ? "Click where the arc ends." : "Click the end of a line or an arc to leave it smoothly."),
  context: () => ({ relations: false }),
  accept: (pts, next, data) => (pts.length || tangentSource(data, next.point) ? true : "Start a tangent arc on the end of a line or an arc."),
  preview(pts, c, data) {
    const src = tangentSource(data, pts[0].point), a = src && tangentArc(pts[0].p, src.t, c.p);
    if (!a) return [[pts[0].p, c.p]];
    const s = a.ccw ? pts[0].p : c.p, e = a.ccw ? c.p : pts[0].p, { a0, a1 } = arcSweep(a.c, s, e);
    return [ring(a.c, dist(a.c, s), a0, a1)];
  },
  build(d, pts) {
    const src = tangentSource(d.data, pts[0].point), a = src && tangentArc(pts[0].p, src.t, pts[1].p);
    if (!src || !a || dist(pts[0].p, pts[1].p) < 1e-7) return false;
    const start = pts[0].point!, existing = !!pts[1].point, end = pointFor(d, pts[1]);
    if (start === end) return false;
    const id = d.arc(d.point(a.c), a.ccw ? start : end, a.ccw ? end : start);
    d.constrain("tangent", [src.curve, id]);
    return existing ? {} : { next: [held(pts[1].p, end)] };
  },
};

// ---------------------------------------------------------------- slot, point
export const slot: ShapeSpec = {
  id: "sketch-slot", clicks: 3,
  hint: (n) => (n === 0 ? "Click the centre of one end of the slot." : n === 1 ? "Click the centre of the other end." : "Move out to set the width and click, or type it."),
  context: (pts) => (pts.length === 1 ? { from: pts[0].p } : { relations: false }),
  fields: (pts, c) => (pts.length === 2 ? [{ key: "width", label: "W", unit: "mm", value: 2 * slotRadius(pts[0].p, pts[1].p, c) }] : [{ key: "length", label: "L", unit: "mm", value: dist(c, pts[0].p) }]),
  constrain(pts, c, typed) {
    if (pts.length === 1 && typed.length !== undefined) { const v = sub(c, pts[0].p), l = len(v) || 1; return [pts[0].p[0] + (v[0] / l) * typed.length, pts[0].p[1] + (v[1] / l) * typed.length]; }
    if (pts.length === 2 && typed.width !== undefined) { const u = sub(pts[1].p, pts[0].p), l = len(u) || 1; return [pts[1].p[0] - (u[1] / l) * typed.width / 2, pts[1].p[1] + (u[0] / l) * typed.width / 2]; }
    return c;
  },
  preview(pts, c) {
    if (pts.length < 2) return [[pts[0].p, c.p]];
    const g = slotGeometry(pts[0].p, pts[1].p, slotRadius(pts[0].p, pts[1].p, c.p));
    return g ? [[g.a, g.b], ring(pts[1].p, g.r, g.t - Math.PI / 2, g.t + Math.PI / 2), [g.c, g.d], ring(pts[0].p, g.r, g.t + Math.PI / 2, g.t + Math.PI * 1.5), [pts[0].p, pts[1].p]] : [[pts[0].p, pts[1].p]];
  },
  build(d, pts, typed) {
    const r = slotRadius(pts[0].p, pts[1].p, pts[2].p), g = slotGeometry(pts[0].p, pts[1].p, r);
    if (!g || r < 1e-7) return false;
    const c1 = pointFor(d, pts[0]), c2 = pointFor(d, pts[1]);
    if (c1 === c2) return false;
    const a = d.point(g.a), b = d.point(g.b), c = d.point(g.c), e = d.point(g.d);
    const bottom = d.line(a, b), right = d.arc(c2, b, c), top = d.line(c, e), left = d.arc(c1, e, a);
    d.constrain("tangent", [bottom, right]); d.constrain("tangent", [right, top]); d.constrain("tangent", [top, left]); d.constrain("tangent", [left, bottom]);
    d.constrain("equal", [left, right]);
    const axis = d.line(c1, c2, true);
    if (pts[1].horizontal) d.constrain("horizontal", [axis]); else if (pts[1].vertical) d.constrain("vertical", [axis]);
    if (typed.width !== undefined) d.constrain("radius", [right], { value: typed.width / 2 });
    return {};
  },
};
function slotRadius(c1: Vec2, c2: Vec2, p: Vec2): number {
  const u = sub(c2, c1), l = len(u); if (l < 1e-12) return 0;
  return Math.abs(u[0] * (p[1] - c1[1]) - u[1] * (p[0] - c1[0])) / l;
}
function slotGeometry(c1: Vec2, c2: Vec2, r: number): { a: Vec2; b: Vec2; c: Vec2; d: Vec2; r: number; t: number } | null {
  const u = sub(c2, c1), l = len(u); if (l < 1e-9 || r < 1e-9) return null;
  const n: Vec2 = [-u[1] / l, u[0] / l];
  return { a: [c1[0] - n[0] * r, c1[1] - n[1] * r], b: [c2[0] - n[0] * r, c2[1] - n[1] * r], c: [c2[0] + n[0] * r, c2[1] + n[1] * r], d: [c1[0] + n[0] * r, c1[1] + n[1] * r], r, t: Math.atan2(u[1], u[0]) };
}

export const point: ShapeSpec = {
  id: "sketch-point", clicks: 1,
  hint: () => "Click to place a point.",
  preview: () => [],
  build(d, pts) { if (pts[0].point) return false; pointFor(d, pts[0]); return {}; },
};
