// _measure-kernel.ts — what the measuring services read from the B-rep: exact lengths, areas, radii, axes and
// distances (never from the display mesh), shapes shipped between workers as BRep text, placements and boxes.
// Worker side; shared by measure-entities.ts, mass-properties.ts, measure-interference.ts, measure-clearance.ts
// and measure-body-brep.ts.  Every kernel object made here is deleted before the function returns.
import { cross, dot, length, normalize, sub, type Vec3 } from "../core/geometry";
import type { Kernel } from "../kernel/occ";
import type { Shape } from "../kernel/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** Collects kernel objects and deletes them all at once. */
export class Bin {
  private readonly items: { delete(): void }[] = [];
  add<T>(o: T): T { if (o && typeof (o as Any).delete === "function") this.items.push(o as Any); return o; }
  empty(): void { for (const o of this.items.splice(0).reverse()) { try { o.delete(); } catch (e) { /* already gone */ } } }
}

export type CurveType = "line" | "circle" | "ellipse" | "bspline" | "other";
export type SurfaceType = "plane" | "cylinder" | "cone" | "sphere" | "torus" | "other";

/** What one face, edge, vertex or default plane is, as the measure readout needs it.  Millimetres. */
export interface EntityInfo {
  kind: "face" | "edge" | "vertex" | "plane";
  /** a vertex's position */
  point?: Vec3;
  /** an edge's length */
  length?: number;
  curve?: CurveType;
  /** a straight edge's ends and its unit direction */
  start?: Vec3; end?: Vec3; direction?: Vec3;
  /** a circle, an arc, a cylinder or a sphere: its centre (for a cylinder, a point of the axis) and radius */
  center?: Vec3; radius?: number;
  /** the axis of a circle or a cylinder (unit) */
  axis?: Vec3;
  /** true for an arc that is a whole circle */
  closed?: boolean;
  /** a face's area and the length of its boundary (seams of closed surfaces are not boundary) */
  area?: number; perimeter?: number;
  surface?: SurfaceType;
  /** a planar face or default plane: a point of it and its outward normal */
  origin?: Vec3; normal?: Vec3;
  /** the centre of mass of the face or edge (a vertex's point) */
  centroid: Vec3;
}

const xyz = (p: Any): Vec3 => [p.X(), p.Y(), p.Z()];

function linear(k: Kernel, s: Shape, bin: Bin): { length: number; centroid: Vec3 } {
  const oc = k.oc as Any;
  const g = bin.add(new oc.GProp_GProps());
  oc.BRepGProp.LinearProperties(s, g, true, false);
  return { length: g.Mass(), centroid: xyz(bin.add(g.CentreOfMass())) };
}

export function measureEntity(k: Kernel, shape: Shape, kind: "face" | "edge" | "vertex"): EntityInfo {
  const oc = k.oc as Any;
  const bin = new Bin();
  try {
    if (kind === "vertex") { const p = k.vertexPoint(shape); return { kind, point: p, centroid: p }; }
    if (kind === "edge") {
      const edge = oc.TopoDS.Edge(shape);
      const lin = linear(k, edge, bin);
      const out: EntityInfo = { kind, length: lin.length, centroid: lin.centroid, curve: "other" };
      const ad = bin.add(new oc.BRepAdaptor_Curve(edge));
      const t = ad.GetType(), T = oc.GeomAbs_CurveType;
      const a = xyz(bin.add(ad.Value(ad.FirstParameter()))), b = xyz(bin.add(ad.Value(ad.LastParameter())));
      if (t === T.GeomAbs_Line) {
        out.curve = "line"; out.start = a; out.end = b; out.direction = normalize(sub(b, a));
      } else if (t === T.GeomAbs_Circle) {
        const c = bin.add(ad.Circle()), ax = bin.add(c.Axis());
        out.curve = "circle"; out.center = xyz(bin.add(c.Location())); out.radius = c.Radius(); out.axis = xyz(bin.add(ax.Direction()));
        out.closed = length(sub(a, b)) < 1e-7 && lin.length > Math.PI * c.Radius();
        if (!out.closed) { out.start = a; out.end = b; }
      } else if (t === T.GeomAbs_Ellipse) out.curve = "ellipse";
      else if (t === T.GeomAbs_BSplineCurve || t === T.GeomAbs_BezierCurve) out.curve = "bspline";
      return out;
    }
    const face = oc.TopoDS.Face(shape);
    const g = bin.add(new oc.GProp_GProps());
    oc.BRepGProp.SurfaceProperties(face, g, false, false);
    const out: EntityInfo = { kind, area: g.Mass(), centroid: xyz(bin.add(g.CentreOfMass())), surface: "other" };
    // the boundary: every edge of the face once, without the seam a closed surface is cut along
    let perimeter = 0;
    for (const e of k.sub(face, "edge")) { const edge = oc.TopoDS.Edge(e); if (oc.BRep_Tool.IsClosed(edge, face)) continue; perimeter += linear(k, edge, bin).length; }
    out.perimeter = perimeter;
    const ad = bin.add(new oc.BRepAdaptor_Surface(face, true));
    const t = ad.GetType(), T = oc.GeomAbs_SurfaceType;
    if (t === T.GeomAbs_Plane) {
      const f = k.faceFrame(face);
      out.surface = "plane";
      if (f) { out.normal = f.normal; out.origin = out.centroid; }
    } else if (t === T.GeomAbs_Cylinder) {
      const c = bin.add(ad.Cylinder()), ax = bin.add(c.Axis());
      out.surface = "cylinder"; out.radius = c.Radius(); out.axis = xyz(bin.add(ax.Direction()));
      // the point of the axis level with the face's centroid
      const p = xyz(bin.add(ax.Location()));
      out.center = add3(p, scale3(out.axis, dot(sub(out.centroid, p), out.axis)));
    } else if (t === T.GeomAbs_Sphere) {
      const s = bin.add(ad.Sphere());
      out.surface = "sphere"; out.radius = s.Radius(); out.center = xyz(bin.add(s.Location()));
    } else if (t === T.GeomAbs_Cone) out.surface = "cone";
    else if (t === T.GeomAbs_Torus) out.surface = "torus";
    return out;
  } finally { bin.empty(); }
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** A default plane as a finite face big enough for the model (`size` mm a side), and its description. */
export function planeFace(k: Kernel, origin: Vec3, normal: Vec3, size: number): Shape {
  const oc = k.oc as Any;
  const bin = new Bin();
  try {
    const pln = bin.add(new oc.gp_Pln(bin.add(k.pnt(origin)), bin.add(k.dir(normal))));
    const mk = bin.add(new oc.BRepBuilderAPI_MakeFace(pln, -size, size, -size, size));
    return mk.Face();
  } finally { bin.empty(); }
}

/** The shortest distance between two shapes and where it is on each; 0 when they touch or cross. */
export function minDistance(k: Kernel, a: Shape, b: Shape): { distance: number; a: Vec3; b: Vec3 } | null {
  const oc = k.oc as Any;
  const bin = new Bin();
  try {
    const d = bin.add(new oc.BRepExtrema_DistShapeShape());
    d.LoadS1(a); d.LoadS2(b);
    d.Perform(bin.add(new oc.Message_ProgressRange()));
    if (!d.IsDone() || d.NbSolution() < 1) return null;
    return { distance: d.Value(), a: xyz(bin.add(d.PointOnShape1(1))), b: xyz(bin.add(d.PointOnShape2(1))) };
  } finally { bin.empty(); }
}

/** What two measured things say together.  Angles in degrees. */
export interface PairInfo {
  min?: { distance: number; a: Vec3; b: Vec3 };
  /** between the centres (a circle's, a sphere's, a vertex) or, for a cylinder, its axis */
  centre?: { distance: number; a: Vec3; b: Vec3 };
  /** between two directions (lines, plane normals, axes), 0 … 90 */
  angle?: number;
  /** between two parallel planes, or two parallel lines or axes */
  normalDistance?: number;
}

/** A thing's direction for angles: a line's, a plane's normal, an axis.  `line` is true when it has no sense. */
function directionOf(e: EntityInfo): { v: Vec3; plane: boolean } | null {
  if (e.direction) return { v: e.direction, plane: false };
  if (e.normal) return { v: e.normal, plane: true };
  if (e.axis) return { v: e.axis, plane: false };
  return null;
}

/** The point of a thing that "centre to centre" uses: a centre when it has one, else its centroid. */
function centreOf(e: EntityInfo): Vec3 { return e.point || e.center || e.centroid; }

/** The point of the line (p, v) nearest q. */
function onLine(p: Vec3, v: Vec3, q: Vec3): Vec3 { return add3(p, scale3(v, dot(sub(q, p), v))); }

export function pairInfo(a: EntityInfo, b: EntityInfo, min: PairInfo["min"] | null): PairInfo {
  const out: PairInfo = {};
  if (min) out.min = min;
  // centres: a cylinder's centre is its axis, so the distance from a point to it is measured square to the axis
  const isAxis = (e: EntityInfo) => e.surface === "cylinder" && !!e.axis && !!e.center;
  let ca = centreOf(a), cb = centreOf(b);
  if (isAxis(a) && isAxis(b)) {
    const pa = a.center!, va = a.axis!, pb = b.center!;
    if (length(cross(va, b.axis!)) < 1e-9) { ca = pa; cb = onLine(pb, b.axis!, pa); }
  } else if (isAxis(a)) ca = onLine(a.center!, a.axis!, cb);
  else if (isAxis(b)) cb = onLine(b.center!, b.axis!, ca);
  const d = length(sub(cb, ca));
  if (!(a.kind === "plane" || b.kind === "plane") || a.point || b.point) out.centre = { distance: d, a: ca, b: cb };
  const da = directionOf(a), db = directionOf(b);
  if (da && db) {
    const c = Math.min(1, Math.abs(dot(da.v, db.v)));
    // a line against a plane: the angle to the plane, not to its normal
    let ang = (Math.acos(c) * 180) / Math.PI;
    if (da.plane !== db.plane) ang = 90 - ang;
    out.angle = Math.abs(ang) < 1e-9 ? 0 : ang;
    const parallel = length(cross(da.v, db.v)) < 1e-9;
    if (parallel && da.plane && db.plane) {
      const oa = a.origin || a.centroid, ob = b.origin || b.centroid;
      out.normalDistance = Math.abs(dot(sub(ob, oa), da.v));
    } else if (parallel && !da.plane && !db.plane) {
      const pa = a.start || a.center || a.centroid, pb = b.start || b.center || b.centroid;
      out.normalDistance = length(sub(pb, onLine(pa, da.v, pb)));
    }
  }
  return out;
}

// ---------------------------------------------------------------- shapes between workers, placements, boxes

/** Shapes read from BRep text, kept by a key the caller chooses (document, body and revision). */
const cache = new Map<string, Shape>();
const CACHE_MAX = 48;

/** A shape from BRep text, or from the cache when `brep` is absent and the key was seen before. */
export function shapeFrom(k: Kernel, key: string, brep: string | undefined): Shape {
  const oc = k.oc as Any;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  if (typeof brep !== "string" || !brep) throw new Error(`The shape "${key}" was not sent.`);
  const s: Shape = oc.BRepToolsWrapper.Read(brep);
  if (!s || s.IsNull()) throw new Error(`The shape "${key}" could not be read.`);
  cache.set(key, s);
  while (cache.size > CACHE_MAX) { const [old, sh] = cache.entries().next().value as [string, Shape]; cache.delete(old); try { sh.delete(); } catch (e) { /* gone */ } }
  return s;
}

/** Whether the cache holds a key (the page sends BRep text only for keys the worker lacks). */
export function cached(key: string): boolean { return cache.has(key); }

export function brepOf(k: Kernel, shape: Shape): string { return (k.oc as Any).BRepToolsWrapper.Write(shape); }

/** A shape moved by a rigid 3 × 4 placement (twelve numbers, row by row).  The caller deletes the result. */
export function placed(k: Kernel, shape: Shape, t: readonly number[] | null | undefined): Shape {
  const oc = k.oc as Any;
  if (!t || t.length !== 12 || !t.every((v) => Number.isFinite(v))) t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const bin = new Bin();
  try {
    const trsf = bin.add(new oc.gp_Trsf());
    trsf.SetValues(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], t[9], t[10], t[11]);
    const mk = bin.add(new oc.BRepBuilderAPI_Transform(shape, trsf, false, false));
    return mk.Shape();
  } finally { bin.empty(); }
}

/** The tight box of a shape from its exact geometry: [xmin, ymin, zmin, xmax, ymax, zmax]. */
export function boxOf(k: Kernel, shape: Shape): [number, number, number, number, number, number] {
  const oc = k.oc as Any;
  const bin = new Bin();
  try {
    const b = bin.add(new oc.Bnd_Box());
    oc.BRepBndLib.AddOptimal(shape, b, false, false);
    if (b.IsVoid()) return [0, 0, 0, 0, 0, 0];
    return [b.GetXMin(), b.GetYMin(), b.GetZMin(), b.GetXMax(), b.GetYMax(), b.GetZMax()];
  } finally { bin.empty(); }
}

export function volumeOf(k: Kernel, shape: Shape): { volume: number; centre: Vec3 } {
  const oc = k.oc as Any;
  const bin = new Bin();
  try {
    const g = bin.add(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(shape, g, true, false, false);
    return { volume: g.Mass(), centre: xyz(bin.add(g.CentreOfMass())) };
  } finally { bin.empty(); }
}

/** Triangles of a shape as plain arrays (for a clash volume the page highlights). */
export function meshOf(k: Kernel, shape: Shape, linear = 0.1): { positions: number[]; indices: number[] } {
  const oc = k.oc as Any;
  const heap = (): ArrayBuffer => oc.wasmMemory.buffer;
  const m = oc.ReplicadMeshExtractor.extract(shape, linear, 0.3, false);
  try {
    const positions = Array.from(new Float32Array(heap(), m.getVerticesPtr(), m.getVerticesSize()), (v) => Math.round(v * 1e4) / 1e4);
    const indices = Array.from(new Uint32Array(heap(), m.getTrianglesPtr(), m.getTrianglesSize()));
    return { positions, indices };
  } finally { m.delete(); }
}
