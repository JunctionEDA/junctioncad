// ref-geom.ts — turn what a feature stores (features/_refs.ts RefTarget) into geometry: a plane, an axis, a
// point, or a curve.  Reference features (plane, axis, point, helix), mirror and the patterns all read their
// references through here, so a face, an edge, a default plane and a reference feature are interchangeable
// wherever they make sense.
import { DEFAULT_PLANES, add, cross, dot, length, normalize, scale, sub, type Frame, type Vec3 } from "../../core/geometry";
import { isGeomRef } from "../../core/geometry";
import type { RefTarget } from "../../features/_refs";
import type { EvalContext, Shape } from "../types";
import { sketchEdge } from "./sweep-path";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Axis { origin: Vec3; dir: Vec3 }

const EPS = 1e-9;

/**
 * An edge's or a cylinder's direction made independent of how the kernel happened to orient it: the largest
 * component is positive.  The kernel may reverse an edge on a rebuild; a pattern along it must not turn round.
 */
export function canonical(d: Vec3): Vec3 {
  let i = 0;
  for (let a = 1; a < 3; a++) if (Math.abs(d[a]) > Math.abs(d[i]) + 1e-9) i = a;
  return d[i] < 0 ? scale(d, -1) : d;
}

/** A frame on a plane through `origin` with this normal; x follows `xHint` (or world X, or world Y) projected onto it. */
export function frameFromNormal(origin: Vec3, normal: Vec3, xHint?: Vec3): Frame {
  const n = normalize(normal);
  const tryX = (h: Vec3): Vec3 | null => { const p = sub(h, scale(n, dot(h, n))); return length(p) > 1e-6 ? normalize(p) : null; };
  const x = (xHint && tryX(xHint)) || tryX([1, 0, 0]) || tryX([0, 1, 0])!;
  return { origin, x, y: cross(n, x), normal: n };
}

/** The same plane with its origin moved to the point of the plane nearest the world origin (as face frames are). */
export function settleOrigin(f: Frame): Frame {
  const d = dot(f.origin, f.normal);
  return { ...f, origin: scale(f.normal, d) };
}

/** Project a point onto a plane. */
export function onPlane(f: Frame, p: Vec3): Vec3 { return sub(p, scale(f.normal, dot(sub(p, f.origin), f.normal))); }

/** Facts about an edge: its end points, and for a line its direction, for a circle its centre, axis and radius. */
export function edgeInfo(ctx: EvalContext, edge: Shape): { kind: "line" | "circle" | "other"; start: Vec3; end: Vec3; mid: Vec3; dir?: Vec3; centre?: Vec3; axis?: Vec3; radius?: number } {
  const oc = ctx.oc as any, k = ctx.k;
  const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)));
  const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
  const at = (u: number): Vec3 => { const p = ad.Value(u); const v = k.xyz(p); p.delete(); return v; };
  const start = at(u0), end = at(u1), mid = at((u0 + u1) / 2);
  const t = ad.GetType();
  if (t === oc.GeomAbs_CurveType.GeomAbs_Line) return { kind: "line", start, end, mid, dir: normalize(sub(end, start)) };
  if (t === oc.GeomAbs_CurveType.GeomAbs_Circle) {
    const c = ad.Circle(), ax = c.Axis(), loc = ax.Location(), d = ax.Direction();
    const out = { kind: "circle" as const, start, end, mid, centre: k.xyz(loc), axis: k.xyz(d), radius: c.Radius() };
    d.delete(); loc.delete(); ax.delete(); c.delete();
    return out;
  }
  return { kind: "other", start, end, mid };
}

/** Facts about a face: planar (its frame), cylindrical (its axis and radius), or other; and its centre of mass. */
export function faceInfo(ctx: EvalContext, face: Shape): { kind: "plane" | "cylinder" | "other"; centre: Vec3; frame?: Frame; axis?: Axis; radius?: number; size: number } {
  const oc = ctx.oc as any, k = ctx.k;
  const centre = k.centre(face, "face");
  const size = shapeSize(ctx, face);
  const frame = k.faceFrame(oc.TopoDS.Face(face));
  if (frame) return { kind: "plane", centre, frame, size };
  const ad = ctx.tmp(new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true));
  if (ad.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
    const cyl = ad.Cylinder(), ax = cyl.Axis(), loc = ax.Location(), d = ax.Direction();
    const axis = { origin: k.xyz(loc), dir: k.xyz(d) }, radius = cyl.Radius();
    d.delete(); loc.delete(); ax.delete(); cyl.delete();
    // put the axis origin level with the face's centre, so things drawn on it sit beside the face
    axis.origin = add(axis.origin, scale(axis.dir, dot(sub(centre, axis.origin), axis.dir)));
    return { kind: "cylinder", centre, axis, radius, size };
  }
  return { kind: "other", centre, size };
}

/** The diagonal of a shape's bounding box: how big to draw something that refers to it. */
export function shapeSize(ctx: EvalContext, shape: Shape): number {
  const oc = ctx.oc as any;
  const box = ctx.tmp(new oc.Bnd_Box());
  oc.BRepBndLib.Add(shape, box, false);
  if (box.IsVoid()) return 0;
  return Math.hypot(box.GetXMax() - box.GetXMin(), box.GetYMax() - box.GetYMin(), box.GetZMax() - box.GetZMin());
}

const NEED = { plane: "a plane or a flat face", axis: "an axis, a straight or round edge, or a cylindrical face", point: "a point or a vertex" };

/** A plane: a default plane, a reference plane, or a planar face. */
export function planeOf(ctx: EvalContext, t: RefTarget | null | undefined, what = "plane"): Frame {
  if (!t) throw ctx.fail(`Pick the ${what}.`);
  if (t.kind === "plane") { const p = DEFAULT_PLANES[t.plane]; if (!p) throw ctx.fail(`The ${what} is not one of Top, Front or Right.`); return p.frame; }
  if (t.kind === "datum") {
    const d = ctx.datum(t.feature);
    if (d.kind !== "plane" || !d.frame) throw ctx.fail(`The ${what} must be ${NEED.plane}.`);
    return d.frame;
  }
  if (isGeomRef(t) && t.kind === "face") {
    const f = faceInfo(ctx, ctx.resolve(t).shape);
    if (f.frame) return f.frame;
  }
  throw ctx.fail(`The ${what} must be ${NEED.plane}.`);
}

/** Where a plane-like reference is drawn and how big: for a face, its own centre and size. */
export function planeExtent(ctx: EvalContext, t: RefTarget): { centre: Vec3 | null; size: number } {
  if (isGeomRef(t) && t.kind === "face") { const r = ctx.resolve(t); return { centre: ctx.k.centre(r.shape, "face"), size: shapeSize(ctx, r.shape) }; }
  if (t.kind === "datum") { const d = ctx.datum(t.feature); return { centre: d.centre || null, size: d.size || 0 }; }
  return { centre: null, size: 0 };
}

/** An axis: a reference axis, a straight edge, the axis of a round edge or a cylindrical face, a plane's normal. */
export function axisOf(ctx: EvalContext, t: RefTarget | null | undefined, what = "axis"): Axis {
  if (!t) throw ctx.fail(`Pick the ${what}.`);
  if (t.kind === "plane") { const f = DEFAULT_PLANES[t.plane].frame; return { origin: f.origin, dir: f.normal }; }
  if (t.kind === "datum") {
    const d = ctx.datum(t.feature);
    if (d.kind === "axis" && d.origin && d.dir) return { origin: d.origin, dir: d.dir };
    if (d.kind === "plane" && d.frame) return { origin: d.centre || d.frame.origin, dir: d.frame.normal };
    throw ctx.fail(`The ${what} must be ${NEED.axis}.`);
  }
  if (t.kind === "sketch") {
    const e = edgeInfo(ctx, sketchEdge(ctx, t.feature, t.entity));
    if (e.kind === "line") return { origin: e.start, dir: canonical(e.dir!) };
    if (e.kind === "circle") return { origin: e.centre!, dir: canonical(e.axis!) };
    throw ctx.fail(`The ${what} must be ${NEED.axis}.`);
  }
  const r = ctx.resolve(t);
  if (r.kind === "edge") {
    const e = edgeInfo(ctx, r.shape);
    if (e.kind === "line") return { origin: e.start, dir: canonical(e.dir!) };
    if (e.kind === "circle") return { origin: e.centre!, dir: canonical(e.axis!) };
  } else if (r.kind === "face") {
    const f = faceInfo(ctx, r.shape);
    if (f.axis) return { origin: f.axis.origin, dir: canonical(f.axis.dir) };
    if (f.frame) return { origin: f.centre, dir: f.frame.normal };
  }
  throw ctx.fail(`The ${what} must be ${NEED.axis}.`);
}

/** A point: a reference point, a vertex, the centre of a round edge, the middle of an edge, the centre of a face. */
export function pointOf(ctx: EvalContext, t: RefTarget | null | undefined, what = "point"): Vec3 {
  if (!t) throw ctx.fail(`Pick the ${what}.`);
  if (t.kind === "plane") return DEFAULT_PLANES[t.plane].frame.origin;
  if (t.kind === "datum") {
    const d = ctx.datum(t.feature);
    if (d.kind === "point" && d.at) return d.at;
    if (d.kind === "axis" && d.origin) return d.origin;
    if (d.kind === "plane" && d.frame) return d.centre || d.frame.origin;
    throw ctx.fail(`The ${what} must be ${NEED.point}.`);
  }
  if (t.kind === "sketch") { const e = edgeInfo(ctx, sketchEdge(ctx, t.feature, t.entity)); return e.centre || e.mid; }
  const r = ctx.resolve(t);
  if (r.kind === "vertex") return ctx.k.vertexPoint(r.shape);
  if (r.kind === "edge") { const e = edgeInfo(ctx, r.shape); return e.centre || e.mid; }
  return ctx.k.centre(r.shape, "face");
}

/** A curve as a kernel edge: an edge of a body, a sketch curve, or a reference curve's wire. */
export function curveOf(ctx: EvalContext, t: RefTarget | null | undefined, what = "curve"): Shape {
  if (!t) throw ctx.fail(`Pick the ${what}.`);
  if (t.kind === "sketch") return sketchEdge(ctx, t.feature, t.entity);
  if (t.kind === "datum") { const d = ctx.datum(t.feature); if (d.kind === "curve" && d.shape) return d.shape; if (d.kind === "axis" && d.origin && d.dir) return lineEdge(ctx, d.origin, add(d.origin, scale(d.dir, d.length || 50))); }
  if (isGeomRef(t) && t.kind === "edge") return ctx.resolve(t).shape;
  throw ctx.fail(`The ${what} must be an edge or a curve.`);
}

export function lineEdge(ctx: EvalContext, a: Vec3, b: Vec3): Shape {
  const oc = ctx.oc as any, k = ctx.k;
  const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(k.pnt(a)), ctx.tmp(k.pnt(b))));
  return ctx.own(mk.Edge());
}

/** The point at a fraction (0 … 1, by length) along an edge or wire, and the curve's direction there. */
export function alongCurve(ctx: EvalContext, curve: Shape, fraction: number): { at: Vec3; tangent: Vec3 } {
  const oc = ctx.oc as any, k = ctx.k;
  const isWire = curve.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE;
  const ad = ctx.tmp(isWire ? new oc.BRepAdaptor_CompCurve(oc.TopoDS.Wire(curve), true) : new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(curve)));
  const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
  // by length: sample the curve and walk to the fraction
  const N = 64, pts: Vec3[] = [];
  for (let i = 0; i <= N; i++) { const p = ad.Value(u0 + ((u1 - u0) * i) / N); pts.push(k.xyz(p)); p.delete(); }
  const lens = [0]; for (let i = 1; i <= N; i++) lens.push(lens[i - 1] + length(sub(pts[i], pts[i - 1])));
  const want = Math.max(0, Math.min(1, fraction)) * lens[N];
  let i = 1; while (i < N && lens[i] < want) i++;
  const seg = lens[i] - lens[i - 1], f = seg > EPS ? (want - lens[i - 1]) / seg : 0;
  const u = u0 + ((u1 - u0) * (i - 1 + f)) / N;
  const p = ctx.tmp(new oc.gp_Pnt(0, 0, 0)), v = ctx.tmp(new oc.gp_Vec(0, 0, 0));
  ad.D1(u, p, v);
  let tangent = k.xyz(v);
  if (length(tangent) < EPS) tangent = sub(pts[Math.min(N, i)], pts[i - 1]);
  return { at: k.xyz(p), tangent: normalize(tangent) };
}

/** A polyline through a curve, for drawing it. */
export function sampleCurve(ctx: EvalContext, curve: Shape, n = 128): number[] {
  const oc = ctx.oc as any, k = ctx.k;
  const isWire = curve.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE;
  const ad = ctx.tmp(isWire ? new oc.BRepAdaptor_CompCurve(oc.TopoDS.Wire(curve), true) : new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(curve)));
  const u0 = ad.FirstParameter(), u1 = ad.LastParameter(), out: number[] = [];
  for (let i = 0; i <= n; i++) { const p = ad.Value(u0 + ((u1 - u0) * i) / n); out.push(p.X(), p.Y(), p.Z()); p.delete(); }
  return out;
}
