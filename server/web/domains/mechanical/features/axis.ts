// axis.ts — the Axis feature: a reference axis for circular patterns, planes at an angle and the like.
// Along a straight edge, the axis of a round edge or a cylindrical face, a plane's normal, through two points, or
// where two planes meet.
import { defineFeature } from "../core/feature";
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { axisOf, planeOf, pointOf, shapeSize, type Axis } from "../kernel/ops/ref-geom";
import { modelSize } from "../kernel/ops/ref-datum";
import { isGeomRef } from "../core/geometry";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AxisParams { [key: string]: any; method: "reference" | "points" | "planes"; ref: RefTarget | null; points: RefTarget[]; planes: RefTarget[]; flip: boolean }

const is = (...m: string[]) => (p: { [k: string]: unknown }) => m.includes(p.method as string);

export default defineFeature<AxisParams>({
  type: "axis",
  title: "Axis",
  icon: '<path d="M12 2v20" stroke-dasharray="3 2"/><path d="M8 7a6 3 0 1 0 8 0"/>',
  toolbarOrder: 61,
  toolbarSection: "reference", toolbarMenu: "Reference",
  defaults: () => ({ method: "reference", ref: null, points: [], planes: [], flip: false }),
  schema: [
    { key: "method", label: "Placed", kind: "enum", options: [{ value: "reference", label: "Along" }, { value: "points", label: "Two points" }, { value: "planes", label: "Two planes" }] },
    { key: "ref", label: "Along", kind: "refs", of: ["edge", "face"], single: true, planes: true, datums: ["axis", "plane"], sketch: true, hint: "A straight or round edge, a cylindrical face, or a plane (its normal).", visible: is("reference") },
    { key: "points", label: "Points", kind: "refs", of: ["vertex", "edge"], datums: ["point"], visible: is("points") },
    { key: "planes", label: "Planes", kind: "refs", of: ["face"], planes: true, datums: ["plane"], visible: is("planes") },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: AxisParams) {
    let axis: Axis, len = modelSize(ctx);
    if (p.method === "points") {
      const pts = (p.points || []).map((t) => pointOf(ctx, t));
      if (pts.length !== 2) throw ctx.fail("Pick two points.");
      const d = sub(pts[1], pts[0]);
      if (length(d) < 1e-9) throw ctx.fail("The two points are the same point.");
      axis = { origin: scale(add(pts[0], pts[1]), 0.5), dir: normalize(d) };
      len = length(d) * 1.4;
    } else if (p.method === "planes") {
      if ((p.planes || []).length !== 2) throw ctx.fail("Pick two planes or flat faces.");
      const [a, b] = p.planes.map((t) => planeOf(ctx, t, "planes"));
      const d = cross(a.normal, b.normal);
      if (length(d) < 1e-9) throw ctx.fail("The two planes are parallel, so they do not meet.");
      const c = dot(a.normal, b.normal), d1 = dot(a.origin, a.normal), d2 = dot(b.origin, b.normal), det = 1 - c * c;
      axis = { origin: add(scale(a.normal, (d1 - c * d2) / det), scale(b.normal, (d2 - c * d1) / det)), dir: normalize(d) };
    } else {
      axis = axisOf(ctx, p.ref, "edge, face or plane to follow");
      if (p.ref && isGeomRef(p.ref)) {
        const r = ctx.resolve(p.ref);
        const s = shapeSize(ctx, r.shape);
        if (s > 1e-6) { len = s * 1.3; }
        if (r.kind === "edge") axis = { ...axis, origin: centreOfEdgeAxis(ctx, r.shape, axis) };
      }
    }
    if (p.flip) axis = { ...axis, dir: scale(axis.dir, -1) };
    ctx.setDatum({ featureId: ctx.feature.id, kind: "axis", origin: axis.origin, dir: axis.dir, length: Math.max(10, len) });
  },
});

/** Put a straight edge's axis origin at the edge's middle, so the axis is drawn over the edge. */
function centreOfEdgeAxis(ctx: EvalContext, edge: any, axis: Axis): Vec3 {
  const c = ctx.k.centre(edge, "edge");
  return add(axis.origin, scale(axis.dir, dot(sub(c, axis.origin), axis.dir)));
}
