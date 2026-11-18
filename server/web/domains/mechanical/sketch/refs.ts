// refs.ts — what a constraint's references mean: the point or the curve a `SketchRef` names, and the small
// measurements the solver, the dimension drawing and the tools all take from a sketch.  Pure.
//
// What the sketcher writes into the sketch format (sketch/format.ts), beyond what that file spells out.  All of
// it is additive: a reader that does not know a key keeps it.
//
//   • `{ entity: "$origin" }` in a constraint's refs is the sketch origin, a point fixed at (0, 0).  It is not
//     stored as an entity.  Ids made by the sketcher never start with "$".
//   • A reference means a point when the entity is a point or `at` is given, else the whole curve.  So
//     "coincident" of a point and a curve puts the point on the curve; "horizontal" / "vertical" take a line or
//     two points; "symmetric" takes two points and then the line or point they mirror about; "tangent" of two
//     curves that end on the same point is tangency at that point.
//   • "collinear" (two lines) is a constraint type beside the reserved ones.
//   • A "distance" dimension is: one line (its length); two points; a point and a line (square to the line);
//     two lines (parallel, the gap between them).  `axis: "x" | "y"` on it makes it the horizontal or vertical
//     distance instead of the straight one.  A circle or arc stands for its centre with `at: "center"`.
//   • "angle" (two lines) is the angle at the corner where they meet, in degrees, 0…180.
//   • `value` is always millimetres or degrees; `expr` is kept only when what was typed was more than a number.
//   • An entity drawn from the model with the Use tool carries `from: GeomRef` (the edge or vertex it copies)
//     and is held by a "fix" constraint.  It is a copy: it does not follow the model.
//   • "fix" pins what it refers to at the coordinates stored in the sketch.
import type { Vec2 } from "../core/geometry";
import type { SketchArc, SketchCircle, SketchConstraint, SketchData, SketchEntity, SketchLine, SketchRef } from "./format";

export const ORIGIN = "$origin";

/** A reference, resolved: a point (with its entity id) or a whole curve. */
export type Resolved =
  | { kind: "point"; id: string; p: Vec2 }
  | { kind: "line"; id: string; e: SketchLine; a: Vec2; b: Vec2 }
  | { kind: "circle"; id: string; e: SketchCircle; c: Vec2; r: number }
  | { kind: "arc"; id: string; e: SketchArc; c: Vec2; s: Vec2; en: Vec2; r: number };

export function pointAt(data: SketchData, id: string): Vec2 | null {
  if (id === ORIGIN) return [0, 0];
  const p = data.entities[id];
  return p && p.type === "point" && Number.isFinite(p.x) && Number.isFinite(p.y) ? [p.x, p.y] : null;
}

/** The point ids a curve is built on, in a fixed order (line: a, b; circle: center; arc: center, start, end). */
export function pointsOf(e: SketchEntity | undefined): string[] {
  if (!e) return [];
  if (e.type === "line") return [e.a, e.b];
  if (e.type === "circle") return [e.center];
  if (e.type === "arc") return [e.center, e.start, e.end];
  return [];
}

export function resolveEntity(data: SketchData, id: string): Resolved | null {
  if (id === ORIGIN) return { kind: "point", id, p: [0, 0] };
  const e = data.entities[id]; if (!e) return null;
  if (e.type === "point") { const p = pointAt(data, id); return p ? { kind: "point", id, p } : null; }
  if (e.type === "line") { const a = pointAt(data, e.a), b = pointAt(data, e.b); return a && b ? { kind: "line", id, e, a, b } : null; }
  if (e.type === "circle") { const c = pointAt(data, e.center); return c && e.r > 0 ? { kind: "circle", id, e, c, r: e.r } : null; }
  if (e.type === "arc") {
    const c = pointAt(data, e.center), s = pointAt(data, e.start), en = pointAt(data, e.end);
    return c && s && en ? { kind: "arc", id, e, c, s, en, r: Math.hypot(s[0] - c[0], s[1] - c[1]) } : null;
  }
  return null;
}

/** What a reference names.  `at` picks a point of a curve; without it the whole entity is meant. */
export function resolve(data: SketchData, ref: SketchRef): Resolved | null {
  if (!ref || typeof ref.entity !== "string") return null;
  if (!ref.at) return resolveEntity(data, ref.entity);
  const e = data.entities[ref.entity]; if (!e) return null;
  let id: string | undefined;
  if (e.type === "line") id = ref.at === "start" ? e.a : ref.at === "end" ? e.b : undefined;
  else if (e.type === "circle") id = ref.at === "center" ? e.center : undefined;
  else if (e.type === "arc") id = ref.at === "start" ? e.start : ref.at === "end" ? e.end : e.center;
  else if (e.type === "point") id = ref.entity;
  if (!id) return null;
  const p = pointAt(data, id);
  return p ? { kind: "point", id, p } : null;
}

/** Every entity id a constraint touches, directly or through a curve's points. */
export function entitiesOf(data: SketchData, c: SketchConstraint): string[] {
  const out = new Set<string>();
  for (const ref of c.refs || []) { const r = resolve(data, ref); if (r) out.add(r.id); if (ref && ref.entity) out.add(ref.entity); }
  return Array.from(out);
}

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** The angle of an arc's sweep, counter-clockwise from start to end, in (0, 2π]. */
export function arcSweep(c: Vec2, s: Vec2, en: Vec2): { a0: number; a1: number } {
  const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]); let a1 = Math.atan2(en[1] - c[1], en[0] - c[0]);
  if (a1 <= a0 + 1e-12) a1 += Math.PI * 2;
  return { a0, a1 };
}

/** Where two infinite lines meet, or null when they are parallel. */
export function lineMeet(a1: Vec2, b1: Vec2, a2: Vec2, b2: Vec2): Vec2 | null {
  const d1x = b1[0] - a1[0], d1y = b1[1] - a1[1], d2x = b2[0] - a2[0], d2y = b2[1] - a2[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12 * (Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y) + 1e-300)) return null;
  const t = ((a2[0] - a1[0]) * d2y - (a2[1] - a1[1]) * d2x) / den;
  return [a1[0] + d1x * t, a1[1] + d1y * t];
}

/**
 * The two lines of an angle dimension, each turned to run away from the corner (the point where they meet), so
 * the angle between them is the one a person reads at that corner.  Returns the point ids in order and the
 * signed angle from the first direction to the second, in radians.
 */
export function angleFrame(l1: Extract<Resolved, { kind: "line" }>, l2: Extract<Resolved, { kind: "line" }>): { p: [string, string, string, string]; at: Vec2; d1: Vec2; d2: Vec2; angle: number } {
  const x = lineMeet(l1.a, l1.b, l2.a, l2.b);
  const away = (l: Extract<Resolved, { kind: "line" }>): { from: string; to: string; d: Vec2 } => {
    const flip = !!x && dist(l.b, x) < dist(l.a, x) - 1e-9;
    const from = flip ? l.b : l.a, to = flip ? l.a : l.b;
    return { from: flip ? l.e.b : l.e.a, to: flip ? l.e.a : l.e.b, d: [to[0] - from[0], to[1] - from[1]] };
  };
  const u = away(l1), v = away(l2);
  const angle = Math.atan2(u.d[0] * v.d[1] - u.d[1] * v.d[0], u.d[0] * v.d[0] + u.d[1] * v.d[1]);
  return { p: [u.from, u.to, v.from, v.to], at: x || l1.a, d1: u.d, d2: v.d, angle };
}

/** The value a dimension shows for the sketch as it is now (mm, or degrees for an angle); null when its references are gone. */
export function measure(data: SketchData, c: SketchConstraint): number | null {
  const r = (c.refs || []).map((ref) => resolve(data, ref));
  if (r.some((x) => !x)) return null;
  const [a, b] = r as Resolved[];
  if (c.type === "radius" || c.type === "diameter") {
    if (!a || (a.kind !== "circle" && a.kind !== "arc")) return null;
    return c.type === "radius" ? a.r : a.r * 2;
  }
  if (c.type === "angle") {
    if (!a || !b || a.kind !== "line" || b.kind !== "line") return null;
    return (Math.abs(angleFrame(a, b).angle) * 180) / Math.PI;
  }
  if (c.type === "distance") {
    if (a && !b && a.kind === "line") return axisDistance(a.a, a.b, c.axis as string | undefined);
    if (!a || !b) return null;
    if (a.kind === "point" && b.kind === "point") return axisDistance(a.p, b.p, c.axis as string | undefined);
    const pl = a.kind === "point" && b.kind === "line" ? [a, b] as const : a.kind === "line" && b.kind === "point" ? [b, a] as const : null;
    if (pl) return pointLineDistance(pl[0].p, pl[1].a, pl[1].b);
    if (a.kind === "line" && b.kind === "line") return pointLineDistance(b.a, a.a, a.b);
  }
  return null;
}

function axisDistance(a: Vec2, b: Vec2, axis: string | undefined): number {
  return axis === "x" ? Math.abs(b[0] - a[0]) : axis === "y" ? Math.abs(b[1] - a[1]) : dist(a, b);
}
export function pointLineDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const l = dist(a, b); if (l < 1e-12) return dist(p, a);
  return Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / l;
}

/** True for the constraint types that carry a value and are drawn as dimensions. */
export const isDimension = (c: SketchConstraint): boolean => c.type === "distance" || c.type === "radius" || c.type === "diameter" || c.type === "angle";
