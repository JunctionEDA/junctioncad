// axis.ts — an axis a feature turns about: a line of a sketch, one of a sketch's own axes, a straight model
// edge, or one of the world axes.  Worker side.
import { normalize, sub, toWorld, type GeomRef, type Vec3 } from "../../core/geometry";
import { pointOf } from "../../sketch/format";
import type { EvalContext, SketchGeometry } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface Axis { origin: Vec3; dir: Vec3 }

/** The line of a straight edge, or a FeatureError when the edge is curved. */
export function edgeAxis(ctx: EvalContext, ref: GeomRef | null | undefined): Axis {
  if (!ref || !ref.name) throw ctx.fail("Pick a straight edge for the axis.");
  const r = ctx.resolve(ref);
  if (r.kind !== "edge") throw ctx.fail("The axis must be an edge.");
  const oc = ctx.oc as Any;
  const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(r.shape)));
  if (ad.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) throw ctx.fail("The axis edge must be straight.");
  const a = ctx.tmp(ad.Value(ad.FirstParameter())), b = ctx.tmp(ad.Value(ad.LastParameter()));
  const pa = ctx.k.xyz(a), pb = ctx.k.xyz(b);
  return { origin: pa, dir: normalize(sub(pb, pa)) };
}

/**
 * The axis of a sketch line: the line named by `entity`, or else the one line of the sketch that is
 * construction geometry or on no closed loop (a centre line drawn for the purpose).
 */
export function sketchLineAxis(ctx: EvalContext, sketch: SketchGeometry, entity?: string | null): { axis: Axis; entity: string } {
  const data = sketch.data;
  let id = entity && data.entities[entity] && data.entities[entity].type === "line" ? entity : null;
  if (!id) {
    const candidates = Object.keys(data.entities).sort().filter((e) => {
      const x = data.entities[e];
      return x.type === "line" && (x.construction || sketch.open.includes(e));
    });
    if (!candidates.length) throw ctx.fail("Draw a line in the sketch to turn about (a line that is not part of the outline), or choose another axis.");
    if (candidates.length > 1) ctx.warn(`The sketch has ${candidates.length} loose lines; the first one is the axis.`);
    id = candidates[0];
  }
  const line = data.entities[id] as { a: string; b: string };
  const a = pointOf(data, line.a), b = pointOf(data, line.b);
  if (!a || !b || (a[0] === b[0] && a[1] === b[1])) throw ctx.fail("The axis line has no length.");
  const pa = toWorld(sketch.frame, a), pb = toWorld(sketch.frame, b);
  return { axis: { origin: pa, dir: normalize(sub(pb, pa)) }, entity: id };
}

export const WORLD_AXES: { [k: string]: Axis } = {
  x: { origin: [0, 0, 0], dir: [1, 0, 0] },
  y: { origin: [0, 0, 0], dir: [0, 1, 0] },
  z: { origin: [0, 0, 0], dir: [0, 0, 1] },
};
