// sweep-path.ts — curves as kernel edges and wires: one sketch curve as an edge (it need not be on a closed
// loop, as a path or an axis line seldom is), and a path for Sweep made of picked sketch curves, body edges and
// reference curves, chained end to end.
import { toWorld, length, sub, type Vec3 } from "../../core/geometry";
import { isGeomRef } from "../../core/geometry";
import type { RefTarget } from "../../features/_refs";
import { curvePoints, pointOf, type SketchData } from "../../sketch/format";
import type { EvalContext, Shape } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TOL = 1e-6;

/** The end points of a sketch curve in the sketch plane, or null for a closed curve (a circle). */
function curveEnds(data: SketchData, id: string): [[number, number], [number, number]] | null {
  const e = data.entities[id] as any;
  if (!e) return null;
  if (e.type === "line") { const a = pointOf(data, e.a), b = pointOf(data, e.b); return a && b ? [a, b] : null; }
  if (e.type === "arc") { const a = pointOf(data, e.start), b = pointOf(data, e.end); return a && b ? [a, b] : null; }
  if (e.type === "circle" || e.type === "point") return null;
  const pts = curvePoints(data, e);
  if (pts.length < 2) return null;
  const a = pts[0], b = pts[pts.length - 1];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < TOL ? null : [a, b];
}

/** One sketch curve as a kernel edge (a polyline wire for curve kinds this file does not know). */
export function sketchEdge(ctx: EvalContext, sketchId: string, entity: string): Shape {
  const oc = ctx.oc as any, k = ctx.k;
  const s = ctx.sketch(sketchId), data = s.data, frame = s.frame;
  const e = data.entities[entity] as any;
  if (!e || e.type === "point") throw ctx.fail("A sketch curve this feature uses is gone. Edit the feature and pick it again.");
  const P = (p: [number, number]) => ctx.tmp(k.pnt(toWorld(frame, p)));
  if (e.type === "line") {
    const a = pointOf(data, e.a), b = pointOf(data, e.b);
    if (!a || !b || Math.hypot(a[0] - b[0], a[1] - b[1]) < TOL) throw ctx.fail("A sketch line this feature uses has no length.");
    return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(P(a), P(b))).Edge());
  }
  if (e.type === "circle" || e.type === "arc") {
    const c = pointOf(data, e.center);
    if (!c) throw ctx.fail("A sketch arc this feature uses has no centre.");
    const start = e.type === "arc" ? pointOf(data, e.start) : null, end = e.type === "arc" ? pointOf(data, e.end) : null;
    const r = e.type === "circle" ? e.r : start ? Math.hypot(start[0] - c[0], start[1] - c[1]) : 0;
    if (!(r > 0)) throw ctx.fail("A sketch circle or arc this feature uses has no radius.");
    const circ = ctx.tmp(new oc.gp_Circ(ctx.tmp(new oc.gp_Ax2(P(c), ctx.tmp(k.dir(frame.normal)), ctx.tmp(k.dir(frame.x)))), r));
    if (e.type === "circle") return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(circ)).Edge());
    const a0 = Math.atan2(start![1] - c[1], start![0] - c[0]); let a1 = Math.atan2(end![1] - c[1], end![0] - c[0]);
    if (a1 <= a0) a1 += Math.PI * 2;
    return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(circ, a0, a1)).Edge());
  }
  // a kind this version does not build exactly: follow its drawn polyline
  const pts = curvePoints(data, e);
  if (pts.length < 2) throw ctx.fail("A sketch curve this feature uses cannot be built.");
  const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
  for (let i = 1; i < pts.length; i++) {
    if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) < TOL) continue;
    mw.Add(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(P(pts[i - 1]), P(pts[i]))).Edge());
  }
  return ctx.own(mw.Wire());
}

/**
 * The sketch curves joined end to end with the picked ones, construction curves aside: picking one curve of a
 * path picks the path.
 */
export function chainOf(data: SketchData, picked: readonly string[]): string[] {
  const ids = Object.keys(data.entities).filter((id) => { const e = data.entities[id] as any; return e.type !== "point" && !e.construction && curveEnds(data, id); });
  const ends = new Map(ids.map((id) => [id, curveEnds(data, id)!]));
  const key = (p: [number, number]) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const at = new Map<string, string[]>();
  for (const [id, [a, b]] of ends) for (const p of [a, b]) { const kk = key(p); if (!at.has(kk)) at.set(kk, []); at.get(kk)!.push(id); }
  const out = new Set<string>();
  const todo = picked.filter((id) => ends.has(id) || data.entities[id]);
  while (todo.length) {
    const id = todo.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const e = ends.get(id);
    if (!e) continue;   // a closed curve stands alone
    for (const p of e) for (const next of at.get(key(p)) || []) if (!out.has(next)) todo.push(next);
  }
  return Array.from(out);
}

/** Order edges so each one starts where the one before it ended (as far as they connect); report the gaps. */
function orderEdges(ctx: EvalContext, edges: Shape[]): Shape[] {
  const oc = ctx.oc as any, k = ctx.k;
  const ends = edges.map((e) => {
    const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e)));
    const a = ad.Value(ad.FirstParameter()), b = ad.Value(ad.LastParameter());
    const out: [Vec3, Vec3] = [k.xyz(a), k.xyz(b)]; a.delete(); b.delete();
    return out;
  });
  const near = (p: Vec3, q: Vec3) => length(sub(p, q)) < 1e-4;
  const degree = (i: number, which: 0 | 1) => ends.filter((e, j) => j !== i && (near(e[0], ends[i][which]) || near(e[1], ends[i][which]))).length;
  let start = ends.findIndex((_, i) => degree(i, 0) === 0 || degree(i, 1) === 0);
  if (start < 0) start = 0;
  const used = new Set<number>([start]), order = [start];
  let tip = degree(start, 0) === 0 ? ends[start][1] : ends[start][0];
  while (order.length < edges.length) {
    const next = ends.findIndex((e, j) => !used.has(j) && (near(e[0], tip) || near(e[1], tip)));
    if (next < 0) throw ctx.fail("The path's curves do not join end to end. Pick curves that make one chain.");
    used.add(next); order.push(next);
    tip = near(ends[next][0], tip) ? ends[next][1] : ends[next][0];
  }
  return order.map((i) => edges[i]);
}

/** A path: picked sketch curves (with the curves chained to them), body edges and reference curves, as one wire. */
export function pathWire(ctx: EvalContext, targets: readonly RefTarget[]): Shape {
  const oc = ctx.oc as any, k = ctx.k;
  if (!targets.length) throw ctx.fail("Pick the path: a sketch curve, an edge or a curve.");
  const edges: Shape[] = [];
  const bySketch = new Map<string, string[]>();
  for (const t of targets) {
    if (t.kind === "sketch") { bySketch.set(t.feature, [...(bySketch.get(t.feature) || []), t.entity]); continue; }
    if (t.kind === "datum") {
      const d = ctx.datum(t.feature);
      if (d.kind !== "curve" || !d.shape) throw ctx.fail("The path must be made of curves and edges.");
      edges.push(...k.sub(d.shape, "edge"));
      continue;
    }
    if (isGeomRef(t) && t.kind === "edge") { edges.push(ctx.resolve(t).shape); continue; }
    throw ctx.fail("The path must be made of curves and edges.");
  }
  for (const [sketchId, picked] of bySketch) {
    const s = ctx.sketch(sketchId);
    for (const id of chainOf(s.data, picked)) {
      const e = sketchEdge(ctx, sketchId, id);
      if (e.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE) edges.push(...k.sub(e, "edge")); else edges.push(e);
    }
  }
  const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
  for (const e of orderEdges(ctx, edges)) {
    mw.Add(oc.TopoDS.Edge(e));
    if (!mw.IsDone()) throw ctx.fail("The path's curves do not join end to end. Pick curves that make one chain.");
  }
  return ctx.own(mw.Wire());
}
