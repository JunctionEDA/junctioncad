// shapes.ts — small kernel helpers the solid features share: moving a named shape, bounding boxes, which
// faces an edge lies on, which pieces of a result touch a face.  Worker side; every function takes the Kernel.
//
// Names: a helper that makes a new shape from a named one returns a NamedResult whose namer gives each face of
// the new shape the name its source face had (CONTRACT.md, "Geometry names").
import type { Vec3 } from "../../core/geometry";
import { ShapeIndex, type Kernel, type Keep, type NamedResult } from "../occ";
import type { FaceNamer, NamedShape, Shape } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** A rigid motion: a rotation about an axis through `origin` (degrees), then a translation. */
export interface Motion { translate?: Vec3; axis?: { origin: Vec3; dir: Vec3 }; angle?: number }

/** The kernel transformation of a motion; the caller deletes it (pass it through `keep`). */
export function trsfOf(k: Kernel, m: Motion, keep: Keep): Any {
  const oc = k.oc as Any;
  const t = keep(new oc.gp_Trsf());
  if (m.axis && m.angle) {
    const ax = keep(new oc.gp_Ax1(keep(k.pnt(m.axis.origin)), keep(k.dir(m.axis.dir))));
    t.SetRotation(ax, (m.angle * Math.PI) / 180);
  }
  if (m.translate && (m.translate[0] || m.translate[1] || m.translate[2])) {
    const tr = keep(new oc.gp_Trsf());
    tr.SetTranslation(keep(k.vec(m.translate)));
    t.PreMultiply(tr);
  }
  return t;
}

/**
 * Move a shape and keep the names of its faces: each face of the result is called what the face it came from
 * was called.  `names` names the faces of the input.
 */
export function moveNamed(k: Kernel, shape: Shape, names: FaceNamer, m: Motion, keep: Keep): NamedResult {
  const oc = k.oc as Any;
  const t = trsfOf(k, m, keep);
  const mk = keep(new oc.BRepBuilderAPI_Transform(shape, t, true, false));
  const out: Shape = keep(mk.Shape());
  const index = new ShapeIndex<string>(k);
  k.sub(shape, "face").forEach((f, i) => {
    const n = names(f as Any, i);
    if (n !== null) index.add(keep(mk.ModifiedShape(f)), n);
  });
  return { shape: out, names: (f) => index.get(f) ?? null };
}

/** The axis-aligned box around shapes, or null when there are none: [xmin, ymin, zmin, xmax, ymax, zmax]. */
export function bbox(k: Kernel, shapes: readonly Shape[]): [number, number, number, number, number, number] | null {
  if (!shapes.length) return null;
  const oc = k.oc as Any;
  const box = new oc.Bnd_Box();
  try {
    for (const s of shapes) oc.BRepBndLib.Add(s, box, false);
    if (box.IsVoid()) return null;
    return [box.GetXMin(), box.GetYMin(), box.GetZMin(), box.GetXMax(), box.GetYMax(), box.GetZMax()];
  } finally { box.delete(); }
}

/** A length that reaches past everything in `shapes` from `from`: what "through all" extrudes by. */
export function reachPast(k: Kernel, shapes: readonly Shape[], from: Vec3): number {
  const b = bbox(k, shapes);
  if (!b) return 1000;
  let far = 0;
  for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) far = Math.max(far, Math.hypot(x - from[0], y - from[1], z - from[2]));
  return far * 1.1 + 10;
}

/** The faces of a body that an edge lies on (one or two). */
export function facesOfEdge(k: Kernel, faces: readonly NamedShape[], edge: Shape): NamedShape[] {
  return faces.filter((f) => k.sub(f.shape, "edge").some((e) => e.IsSame(edge)));
}

/** The distinct edges of the named faces, as the body names them. */
export function edgesOfFaces(k: Kernel, edges: readonly NamedShape[], faces: readonly Shape[]): NamedShape[] {
  const index = new ShapeIndex<NamedShape>(k);
  for (const e of edges) index.add(e.shape, e);
  const out: NamedShape[] = [], seen = new Set<string>();
  for (const f of faces) for (const e of k.sub(f, "edge")) { const n = index.get(e); if (n && !seen.has(n.name)) { seen.add(n.name); out.push(n); } }
  return out;
}

/** The centre of mass of a solid. */
export function solidCentre(k: Kernel, shape: Shape): Vec3 {
  const oc = k.oc as Any;
  const g = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(shape, g, true, false, false);
  const c = g.CentreOfMass(); const out = k.xyz(c); c.delete(); g.delete();
  return out;
}

/** The shortest distance between two shapes. */
export function distance(k: Kernel, a: Shape, b: Shape): number {
  const oc = k.oc as Any;
  const d = new oc.BRepExtrema_DistShapeShape();
  const range = new oc.Message_ProgressRange();
  try { d.LoadS1(a); d.LoadS2(b); d.Perform(range); return d.IsDone() ? d.Value() : Infinity; } finally { d.delete(); range.delete(); }
}

/** One compound of several shapes (the caller owns it). */
export function compound(k: Kernel, shapes: readonly Shape[], keep: Keep): Shape {
  const oc = k.oc as Any;
  const c = keep(new oc.TopoDS_Compound());
  const b = keep(new oc.TopoDS_Builder());
  b.MakeCompound(c);
  for (const s of shapes) b.Add(c, s);
  return c;
}

/** A planar face as large as `size` around a point, square to `normal`: a cutting tool for a plane. */
export function planeFace(k: Kernel, origin: Vec3, normal: Vec3, size: number, keep: Keep): Shape {
  const oc = k.oc as Any;
  const pln = keep(new oc.gp_Pln(keep(k.pnt(origin)), keep(k.dir(normal))));
  const mk = keep(new oc.BRepBuilderAPI_MakeFace(pln, -size, size, -size, size));
  if (!mk.IsDone()) throw new Error("planeFace: the face could not be made");
  return keep(mk.Face());
}
