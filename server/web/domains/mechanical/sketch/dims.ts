// dims.ts — how a dimension is drawn: its witness lines, its dimension line or arc, its arrows and where its
// text sits, all in sketch coordinates.  Pure, so the painter, the picking and the tests agree.
import type { Vec2 } from "../core/geometry";
import { DEFAULT_UNITS, angleFactor, angleSuffix, lengthFactor, num, type Units } from "../document/units";
import type { SketchConstraint, SketchData } from "./format";
import { angleFrame, dist, measure, mid, resolve, type Resolved } from "./refs";

export interface DimensionDrawing {
  lines: [Vec2, Vec2][];
  /** counter-clockwise from a0 to a1 */
  arcs: { c: Vec2; r: number; a0: number; a1: number }[];
  arrows: { at: Vec2; dir: Vec2 }[];
  label: Vec2;
  text: string;
}

// The units the open sketch is shown in.  The sketch editor sets them from the document when a sketch is opened
// and when the document's units change; everything that writes a sketch number for a person reads them here.
let shown: Units = DEFAULT_UNITS;
export function setSketchUnits(u: Units): void { shown = u; }
export const sketchUnits = (): Units => shown;
/** A length of the sketch (mm) as a number in the document's unit. */
export const lenNum = (v: number): string => num(v / lengthFactor(shown.length), shown.places);
/** An angle of the sketch (degrees) as a number in the document's unit. */
export const angNum = (v: number): string => num(v / angleFactor(shown.angle), shown.angle === "deg" ? Math.min(shown.places, 3) : Math.max(shown.places, 3));
export const lenText = (v: number): string => `${lenNum(v)} ${shown.length}`;
export const angText = (v: number): string => `${angNum(v)}${angleSuffix(shown.angle)}`;
/** What a bare number typed into the sketch is worth, in millimetres or degrees. */
export const typedFactor = (angle: boolean): number => (angle ? angleFactor(shown.angle) : lengthFactor(shown.length));

export const fmt = (v: number): string => { const r = Math.round(v * 1000) / 1000; return (Object.is(r, -0) ? 0 : r).toString(); };

/** The text of a dimension: its value as the sketch has it now, in brackets when it is a reference dimension. */
export function dimensionText(data: SketchData, c: SketchConstraint): string {
  const driven = c.driving === false;
  const v = driven || typeof c.value !== "number" ? measure(data, c) : c.value;
  if (v === null) return "?";
  const body = c.type === "radius" ? `R ${lenNum(v)}` : c.type === "diameter" ? `Ø ${lenNum(v)}` : c.type === "angle" ? angText(v) : lenNum(v);
  return driven ? `(${body})` : body;
}

/** The two points a distance dimension spans, whatever it refers to. */
export function distanceEnds(data: SketchData, c: SketchConstraint): [Vec2, Vec2] | null {
  const r = (c.refs || []).map((ref) => resolve(data, ref));
  if (r.some((x) => !x)) return null;
  const [a, b] = r as Resolved[];
  if (a && !b && a.kind === "line") return [a.a, a.b];
  if (!a || !b) return null;
  if (a.kind === "point" && b.kind === "point") return [a.p, b.p];
  const foot = (p: Vec2, l: Extract<Resolved, { kind: "line" }>): Vec2 => {
    const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1], t = ((p[0] - l.a[0]) * dx + (p[1] - l.a[1]) * dy) / (dx * dx + dy * dy || 1);
    return [l.a[0] + dx * t, l.a[1] + dy * t];
  };
  if (a.kind === "point" && b.kind === "line") return [a.p, foot(a.p, b)];
  if (a.kind === "line" && b.kind === "point") return [b.p, foot(b.p, a)];
  if (a.kind === "line" && b.kind === "line") { const m = mid(b.a, b.b); return [foot(m, a), m]; }
  return null;
}

/** Where a new dimension's text goes when nobody has placed it: beside what it measures, `gap` away. */
export function defaultLabel(data: SketchData, c: SketchConstraint, gap: number): Vec2 {
  const r = (c.refs || []).map((ref) => resolve(data, ref));
  const a = r[0];
  if ((c.type === "radius" || c.type === "diameter") && a && (a.kind === "circle" || a.kind === "arc")) return [a.c[0] + (a.r + gap) * Math.SQRT1_2, a.c[1] + (a.r + gap) * Math.SQRT1_2];
  if (c.type === "angle" && a && r[1] && a.kind === "line" && r[1].kind === "line") {
    const f = angleFrame(a, r[1]);
    const u = unit(f.d1), v = unit(f.d2), b = unit([u[0] + v[0], u[1] + v[1]]);
    const reach = Math.min(dist(a.a, a.b), dist(r[1].a, r[1].b)) * 0.5 + gap;
    return [f.at[0] + b[0] * reach, f.at[1] + b[1] * reach];
  }
  const ends = distanceEnds(data, c);
  if (!ends) return [0, 0];
  const m = mid(ends[0], ends[1]);
  if (c.axis === "x") return [m[0], Math.min(ends[0][1], ends[1][1]) - gap];
  if (c.axis === "y") return [Math.max(ends[0][0], ends[1][0]) + gap, m[1]];
  const d = unit([ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]]);
  // on the side away from the sketch origin's quadrant is as good a guess as any: below a horizontal line, right of a vertical one
  let n: Vec2 = [d[1], -d[0]];
  if (n[1] > 1e-9 || (Math.abs(n[1]) <= 1e-9 && n[0] < 0)) n = [-n[0], -n[1]];
  return [m[0] + n[0] * gap, m[1] + n[1] * gap];
}

const unit = (v: Vec2): Vec2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

/** Everything to draw for one dimension, or null when its references are gone.  `px` is millimetres per pixel. */
export function drawDimension(data: SketchData, c: SketchConstraint, px: number): DimensionDrawing | null {
  const text = dimensionText(data, c);
  const label: Vec2 = c.label && Number.isFinite(c.label.x) && Number.isFinite(c.label.y) ? [c.label.x, c.label.y] : defaultLabel(data, c, 28 * px);
  const out: DimensionDrawing = { lines: [], arcs: [], arrows: [], label, text };
  const r = (c.refs || []).map((ref) => resolve(data, ref));
  if (!r.length || r.some((x) => !x)) return null;
  const a = r[0] as Resolved, b = r[1] as Resolved | undefined;
  const over = 6 * px;

  if (c.type === "radius" || c.type === "diameter") {
    if (a.kind !== "circle" && a.kind !== "arc") return null;
    let d = unit([label[0] - a.c[0], label[1] - a.c[1]]);
    if (dist(label, a.c) < 1e-9) d = [Math.SQRT1_2, Math.SQRT1_2];
    const rim: Vec2 = [a.c[0] + d[0] * a.r, a.c[1] + d[1] * a.r];
    const from: Vec2 = c.type === "diameter" ? [a.c[0] - d[0] * a.r, a.c[1] - d[1] * a.r] : a.c;
    const far = dist(label, a.c) > a.r ? label : rim;
    out.lines.push([from, far]);
    out.arrows.push({ at: rim, dir: dist(label, a.c) > a.r ? [-d[0], -d[1]] : d });
    if (c.type === "diameter") out.arrows.push({ at: from, dir: dist(label, a.c) > a.r ? d : [-d[0], -d[1]] });
    return out;
  }

  if (c.type === "angle") {
    if (!b || a.kind !== "line" || b.kind !== "line") return null;
    const f = angleFrame(a, b);
    const rad = Math.max(dist(label, f.at), 8 * px);
    const t1 = Math.atan2(f.d1[1], f.d1[0]), t2 = Math.atan2(f.d2[1], f.d2[0]);
    let a0 = f.angle >= 0 ? t1 : t2, a1 = f.angle >= 0 ? t2 : t1;
    if (a1 < a0) a1 += Math.PI * 2;
    out.arcs.push({ c: f.at, r: rad, a0, a1 });
    // witness lines out to the arc where a line stops short of it
    for (const [l, d] of [[a, f.d1], [b, f.d2]] as const) {
      const u = unit(d as Vec2), reach = Math.max(dist(l.a, f.at), dist(l.b, f.at));
      if (reach < rad) out.lines.push([[f.at[0] + u[0] * reach, f.at[1] + u[1] * reach], [f.at[0] + u[0] * (rad + over), f.at[1] + u[1] * (rad + over)]]);
    }
    const tip = (t: number): Vec2 => [f.at[0] + rad * Math.cos(t), f.at[1] + rad * Math.sin(t)];
    out.arrows.push({ at: tip(a0), dir: [Math.sin(a0), -Math.cos(a0)] }, { at: tip(a1), dir: [-Math.sin(a1), Math.cos(a1)] });
    return out;
  }

  if (c.type !== "distance") return null;
  const ends = distanceEnds(data, c);
  if (!ends) return null;
  const [p, q] = ends;
  let d: Vec2;   // the direction of the dimension line
  if (c.axis === "x") d = [1, 0];
  else if (c.axis === "y") d = [0, 1];
  else d = dist(p, q) < 1e-12 ? [1, 0] : unit([q[0] - p[0], q[1] - p[1]]);
  const n: Vec2 = [-d[1], d[0]];
  // the dimension line passes through the label; each end is the measured point slid along the normal onto it
  const off = (x: Vec2) => (label[0] - x[0]) * n[0] + (label[1] - x[1]) * n[1];
  const p2: Vec2 = [p[0] + n[0] * off(p), p[1] + n[1] * off(p)], q2: Vec2 = [q[0] + n[0] * off(q), q[1] + n[1] * off(q)];
  for (const [x, x2] of [[p, p2], [q, q2]] as const) {
    const l = dist(x, x2); if (l < 1e-12) continue;
    const u: Vec2 = [(x2[0] - x[0]) / l, (x2[1] - x[1]) / l];
    out.lines.push([[x[0] + u[0] * Math.min(3 * px, l), x[1] + u[1] * Math.min(3 * px, l)], [x2[0] + u[0] * over, x2[1] + u[1] * over]]);
  }
  // the line runs on to the text when the text sits outside the span
  const s = (x: Vec2) => (x[0] - p2[0]) * d[0] + (x[1] - p2[1]) * d[1];
  const sq = s(q2), sl = s(label);
  const lo = Math.min(0, sq, sl), hi = Math.max(0, sq, sl);
  out.lines.push([[p2[0] + d[0] * lo, p2[1] + d[1] * lo], [p2[0] + d[0] * hi, p2[1] + d[1] * hi]]);
  const fwd: Vec2 = sq >= 0 ? d : [-d[0], -d[1]];
  out.arrows.push({ at: p2, dir: [-fwd[0], -fwd[1]] }, { at: q2, dir: fwd });
  return out;
}
