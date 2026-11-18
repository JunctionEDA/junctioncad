// infer.ts — what the pointer means while drawing: where it snaps, and which constraints that implies.
//
// A sketch tool asks `snap()` for every pointer position.  The answer is the place to use and the relations the
// sketcher will add if the person clicks there: onto an existing point (the new curve shares the point, which is
// how curves are joined), onto the origin, onto a curve or the midpoint of a line (a coincident or midpoint
// constraint), level with or square above the point the stroke started from (horizontal, vertical), square to
// or in line with the line before it in a chain, or touching a circle (tangent).  Each is reported as a hint
// so it can be drawn before the click.  Pure: the editor supplies the sketch and the size of a pixel.
import type { Vec2 } from "../core/geometry";
import type { SketchData } from "./format";
import type { Draft } from "./model";
import { ORIGIN, arcSweep, dist, mid, pointAt, resolveEntity, type Resolved } from "./refs";

export type HintKind = "point" | "origin" | "on" | "midpoint" | "horizontal" | "vertical" | "perpendicular" | "tangent" | "parallel";
export interface Hint { kind: HintKind; at: Vec2 }

export interface Snap {
  p: Vec2;
  /** an existing point to share */
  point?: string;
  origin?: boolean;
  /** a curve the position lies on */
  on?: string;
  /** a line whose midpoint this is */
  midpoint?: string;
  /** relations of the stroke from `from` to here */
  horizontal?: boolean; vertical?: boolean;
  perpendicularTo?: string; parallelTo?: string; tangentTo?: string;
  hints: Hint[];
  /** dashed guide lines to draw */
  guides: [Vec2, Vec2][];
}

export interface SnapContext {
  data: SketchData;
  /** millimetres per pixel */
  px: number;
  /** where the stroke being drawn started: gives horizontal, vertical and tangent */
  from?: Vec2;
  /** the line the stroke continues from (the previous one of a chain): gives perpendicular */
  after?: string;
  /** entities to ignore (the ones the tool is moving) */
  ignore?: ReadonlySet<string>;
  /** false: positions only, no relations to the stroke */
  relations?: boolean;
  /** false: do not round a free position to a tidy number */
  grid?: boolean;
}

/** The nearest point of a curve to `p`, and how far it is. */
export function nearestOn(r: Resolved, p: Vec2): { p: Vec2; d: number } | null {
  if (r.kind === "line") {
    const dx = r.b[0] - r.a[0], dy = r.b[1] - r.a[1], l2 = dx * dx + dy * dy; if (l2 < 1e-18) return null;
    const t = Math.min(1, Math.max(0, ((p[0] - r.a[0]) * dx + (p[1] - r.a[1]) * dy) / l2));
    const q: Vec2 = [r.a[0] + dx * t, r.a[1] + dy * t];
    return { p: q, d: dist(p, q) };
  }
  if (r.kind === "circle" || r.kind === "arc") {
    const d = dist(p, r.c); if (d < 1e-12 || !(r.r > 0)) return null;
    let q: Vec2 = [r.c[0] + ((p[0] - r.c[0]) * r.r) / d, r.c[1] + ((p[1] - r.c[1]) * r.r) / d];
    if (r.kind === "arc") {
      const { a0, a1 } = arcSweep(r.c, r.s, r.en);
      let t = Math.atan2(q[1] - r.c[1], q[0] - r.c[0]); while (t < a0) t += Math.PI * 2;
      if (t > a1) q = dist(p, r.s) < dist(p, r.en) ? r.s : r.en;
    }
    return { p: q, d: dist(p, q) };
  }
  return null;
}

/** 1, 2 or 5 × 10ⁿ mm, the smallest that is at least four pixels: free positions are rounded to it. */
export function gridStep(px: number): number {
  const decade = Math.pow(10, Math.floor(Math.log10(px * 4)));
  return [1, 2, 5, 10].map((m) => m * decade).find((v) => v >= px * 4) || decade * 10;
}
const roundTo = (v: number, step: number): number => { const r = Math.round(v / step) * step; return Math.round(r * 1e6) / 1e6; };

export function snap(raw: Vec2, ctx: SnapContext): Snap {
  const { data, px } = ctx, reach = 9 * px;
  const skip = ctx.ignore || new Set<string>();
  const out: Snap = { p: raw, hints: [], guides: [] };

  // 1. an existing point
  let best = reach, id: string | undefined;
  for (const [pid, e] of Object.entries(data.entities)) {
    if (e.type !== "point" || skip.has(pid)) continue;
    const d = Math.hypot(e.x - raw[0], e.y - raw[1]);
    if (d < best) { best = d; id = pid; }
  }
  if (id) { const p = pointAt(data, id)!; out.p = p; out.point = id; out.hints.push({ kind: "point", at: p }); return relate(out, ctx, true); }
  if (Math.hypot(raw[0], raw[1]) < reach) { out.p = [0, 0]; out.origin = true; out.hints.push({ kind: "origin", at: [0, 0] }); return relate(out, ctx, true); }

  // 2. the midpoint of a line, then anywhere on a curve
  let onBest = 7 * px, on: { id: string; p: Vec2; r: Resolved } | null = null;
  for (const cid of Object.keys(data.entities)) {
    if (skip.has(cid)) continue;
    const r = resolveEntity(data, cid); if (!r || r.kind === "point") continue;
    if (r.kind === "line") {
      const m = mid(r.a, r.b);
      if (dist(m, raw) < reach) { out.p = m; out.midpoint = cid; out.hints.push({ kind: "midpoint", at: m }); return relate(out, ctx, true); }
    }
    const n = nearestOn(r, raw);
    if (n && n.d < onBest) { onBest = n.d; on = { id: cid, p: n.p, r }; }
  }
  if (on) {
    out.p = on.p; out.on = on.id;
    // a stroke that just touches a circle is tangent to it
    if (ctx.from && ctx.relations !== false && (on.r.kind === "circle" || on.r.kind === "arc")) {
      const c = on.r.c, d = dist(ctx.from, c);
      if (d > on.r.r * 1.001) {
        const base = Math.atan2(ctx.from[1] - c[1], ctx.from[0] - c[0]), open = Math.acos(on.r.r / d);
        for (const t of [base + open, base - open]) {
          const tp: Vec2 = [c[0] + on.r.r * Math.cos(t), c[1] + on.r.r * Math.sin(t)];
          if (dist(tp, raw) < reach && (on.r.kind === "circle" || nearestOn(on.r, tp)!.d < 1e-9)) { out.p = tp; out.tangentTo = on.id; out.hints.push({ kind: "tangent", at: tp }); return out; }
        }
      }
    }
    out.hints.push({ kind: "on", at: on.p });
    return relate(out, ctx, true);
  }

  // 3. nothing near: a tidy number, unless the stroke lines up with something
  //    (the relation is judged where the pointer is, then what it leaves free is rounded)
  relate(out, ctx, false);
  if (ctx.grid !== false && !out.perpendicularTo) {
    const step = gridStep(px);
    out.p = [out.vertical ? out.p[0] : roundTo(out.p[0], step), out.horizontal ? out.p[1] : roundTo(out.p[1], step)];
    for (const h of out.hints) if (ctx.from && (h.kind === "horizontal" || h.kind === "vertical")) h.at = mid(ctx.from, out.p);
  }
  return out;
}

/** Add what the stroke from `ctx.from` to the snapped position implies.  `held`: the position is already fixed by a snap. */
function relate(s: Snap, ctx: SnapContext, held: boolean): Snap {
  const from = ctx.from;
  if (!from || ctx.relations === false) return s;
  const tol = 5 * ctx.px, p = s.p;
  const dx = p[0] - from[0], dy = p[1] - from[1];
  if (Math.hypot(dx, dy) < tol) return s;
  if (Math.abs(dy) < (held ? 1e-7 : tol)) {
    if (!held) s.p = [p[0], from[1]];
    s.horizontal = true; s.hints.push({ kind: "horizontal", at: mid(from, s.p) });
    return s;
  }
  if (Math.abs(dx) < (held ? 1e-7 : tol)) {
    if (!held) s.p = [from[0], p[1]];
    s.vertical = true; s.hints.push({ kind: "vertical", at: mid(from, s.p) });
    return s;
  }
  // square to the line this one continues from
  const prev = ctx.after ? resolveEntity(ctx.data, ctx.after) : null;
  if (prev && prev.kind === "line") {
    const ux = prev.b[0] - prev.a[0], uy = prev.b[1] - prev.a[1], ul = Math.hypot(ux, uy);
    if (ul > 1e-9) {
      const along = (dx * ux + dy * uy) / ul;   // how far the stroke runs along the previous line
      if (Math.abs(along) < (held ? 1e-7 : tol)) {
        if (!held) s.p = [p[0] - (ux / ul) * along, p[1] - (uy / ul) * along];
        s.perpendicularTo = ctx.after; s.hints.push({ kind: "perpendicular", at: from });
      }
    }
  }
  return s;
}

/**
 * The point of a draft that a snap stands for: the existing point it landed on, or a new point with the
 * constraint that keeps it where it snapped (on the origin, on a curve, at a midpoint).
 */
export function pointFor(draft: Draft, s: Snap): string {
  if (s.point && draft.data.entities[s.point]) return s.point;
  const id = draft.point(s.p);
  if (s.origin) draft.constrain("coincident", [id, ORIGIN]);
  else if (s.midpoint && draft.data.entities[s.midpoint]) draft.constrain("midpoint", [id, s.midpoint]);
  else if (s.on && draft.data.entities[s.on]) draft.constrain("coincident", [id, s.on]);
  return id;
}

/** The constraints a stroke's snap implies for the line that was drawn (horizontal, vertical, perpendicular, tangent). */
export function relateLine(draft: Draft, line: string, s: Snap): void {
  if (s.horizontal) draft.constrain("horizontal", [line]);
  else if (s.vertical) draft.constrain("vertical", [line]);
  else if (s.perpendicularTo && draft.data.entities[s.perpendicularTo]) draft.constrain("perpendicular", [s.perpendicularTo, line]);
  if (s.tangentTo && draft.data.entities[s.tangentTo]) draft.constrain("tangent", [line, s.tangentTo]);
}

/** The lines and arcs that end on a point (a circle or arc centred on it does not count). */
export function curvesAt(data: SketchData, point: string): string[] {
  return Object.keys(data.entities).filter((id) => {
    const e = data.entities[id];
    return (e.type === "line" && (e.a === point || e.b === point)) || (e.type === "arc" && (e.start === point || e.end === point));
  });
}
