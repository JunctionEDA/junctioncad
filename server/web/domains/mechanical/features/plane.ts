// plane.ts — the Plane feature: a reference plane that sketches, mirrors and other features can use.
//
// Ways to place it: offset from a plane or flat face; through three points; midway between two planes or faces
// (the bisector when they meet at an angle); turned about an edge or axis lying in a plane; normal to a curve at
// a point along it; tangent to a cylindrical face.  Its frame is what a sketch on it uses: for an offset it keeps
// the base plane's axes; through a point (normal, tangent) the origin is that point; otherwise the origin is the
// point of the plane nearest the world origin, as for a face.
import { defineFeature } from "../core/feature";
import { add, cross, dot, isGeomRef, length, normalize, scale, sub, type Frame, type Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { alongCurve, axisOf, curveOf, faceInfo, frameFromNormal, onPlane, planeExtent, planeOf, pointOf, settleOrigin, shapeSize } from "../kernel/ops/ref-geom";
import { modelSize, rotateAbout } from "../kernel/ops/ref-datum";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PlaneParams {
  [key: string]: any;
  method: "offset" | "points" | "midplane" | "angle" | "normal" | "tangent";
  ref: RefTarget | null;
  distance: number;
  flip: boolean;
  points: RefTarget[];
  faces: RefTarget[];
  axis: RefTarget | null;
  angle: number;
  curve: RefTarget | null;
  position: number;
  cylinder: RefTarget | null;
}

const is = (...m: string[]) => (p: { [k: string]: unknown }) => m.includes(p.method as string);

export default defineFeature<PlaneParams>({
  type: "plane",
  title: "Plane",
  icon: '<path d="M3 15l5-8h13l-5 8z"/><path d="M12 11v9"/><path d="M10 18l2 2 2-2"/>',
  toolbarOrder: 60,
  toolbarSection: "reference", toolbarMenu: "Reference",
  defaults: () => ({ method: "offset", ref: null, distance: 10, flip: false, points: [], faces: [], axis: null, angle: 45, curve: null, position: 0, cylinder: null }),
  schema: [
    { key: "method", label: "Placed", kind: "enum", options: [
      { value: "offset", label: "Offset" }, { value: "points", label: "Three points" }, { value: "midplane", label: "Midplane" },
      { value: "angle", label: "At an angle" }, { value: "normal", label: "Normal to curve" }, { value: "tangent", label: "Tangent to cylinder" }] },
    { key: "ref", label: "From", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"], visible: is("offset", "angle") },
    { key: "distance", label: "Distance", kind: "number", unit: "mm", step: 1, visible: is("offset") },
    { key: "flip", label: "Opposite side", kind: "boolean", visible: is("offset") },
    { key: "points", label: "Points", kind: "refs", of: ["vertex", "edge"], datums: ["point"], hint: "Three vertices, points or round edges (their centres).", visible: is("points") },
    { key: "faces", label: "Between", kind: "refs", of: ["face"], planes: true, datums: ["plane"], hint: "Two planes or flat faces.", visible: is("midplane") },
    { key: "axis", label: "About", kind: "refs", of: ["edge"], single: true, datums: ["axis"], sketch: true, hint: "An edge or axis in the plane.", visible: is("angle") },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", step: 5, visible: is("angle", "tangent") },
    { key: "curve", label: "Curve", kind: "refs", of: ["edge"], single: true, datums: ["curve", "axis"], sketch: true, visible: is("normal") },
    { key: "position", label: "Along", kind: "number", unit: "none", min: 0, max: 1, step: 0.1, hint: "0 is the curve's start, 1 its end.", visible: is("normal") },
    { key: "cylinder", label: "Cylinder", kind: "refs", of: ["face"], single: true, visible: is("tangent") },
  ],

  evaluate(ctx: EvalContext, p: PlaneParams) {
    const around = modelSize(ctx);
    let frame: Frame, centre: Vec3, size = around;
    switch (p.method) {
      case "offset": {
        if (!Number.isFinite(p.distance)) throw ctx.fail("The distance must be a number.");
        const base = planeOf(ctx, p.ref, "plane to offset from");
        const shift = scale(base.normal, p.flip ? -p.distance : p.distance);
        frame = { ...base, origin: add(base.origin, shift) };
        const ext = planeExtent(ctx, p.ref!);
        centre = add(ext.centre || base.origin, shift);
        if (ext.size) size = ext.size * 1.2;
        break;
      }
      case "points": {
        const pts = (p.points || []).map((t) => pointOf(ctx, t));
        if (pts.length !== 3) throw ctx.fail("Pick three points.");
        const n = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
        if (length(n) < 1e-9 * Math.max(1, length(sub(pts[1], pts[0])) ** 2)) throw ctx.fail("The three points are in a line, so they do not fix a plane.");
        frame = settleOrigin(frameFromNormal(pts[0], n, sub(pts[1], pts[0])));
        centre = scale(add(add(pts[0], pts[1]), pts[2]), 1 / 3);
        size = Math.max(length(sub(pts[1], pts[0])), length(sub(pts[2], pts[0])), length(sub(pts[2], pts[1]))) * 1.4;
        break;
      }
      case "midplane": {
        if ((p.faces || []).length !== 2) throw ctx.fail("Pick two planes or flat faces.");
        const [a, b] = p.faces.map((t) => planeOf(ctx, t, "planes to go between"));
        const [ea, eb] = p.faces.map((t) => planeExtent(ctx, t));
        const ca = ea.centre || a.origin, cb = eb.centre || b.origin;
        const c = dot(a.normal, b.normal);
        if (Math.abs(c) > 1 - 1e-9) {
          // parallel: halfway between them, facing as the first does
          const n = a.normal, d = (dot(a.origin, n) + dot(b.origin, n)) / 2;
          frame = { ...a, origin: scale(n, d) };
        } else {
          // they meet: the plane that halves the angle between them, through their line of intersection
          const n = normalize(sub(a.normal, b.normal));
          const d1 = dot(a.origin, a.normal), d2 = dot(b.origin, b.normal), det = 1 - c * c;
          const on = add(scale(a.normal, (d1 - c * d2) / det), scale(b.normal, (d2 - c * d1) / det));
          frame = settleOrigin(frameFromNormal(on, n, cross(a.normal, b.normal)));
        }
        centre = onPlane(frame, scale(add(ca, cb), 0.5));
        size = Math.max(ea.size, eb.size, 0) * 1.2 || around;
        break;
      }
      case "angle": {
        const base = planeOf(ctx, p.ref, "plane to turn");
        const axis = axisOf(ctx, p.axis, "edge or axis to turn about");
        if (Math.abs(dot(axis.dir, base.normal)) > 1e-6) throw ctx.fail("The edge or axis must lie along the plane (at right angles to its normal).");
        if (!Number.isFinite(p.angle)) throw ctx.fail("The angle must be a number.");
        const n = rotateAbout(base.normal, axis.dir, (p.angle * Math.PI) / 180);
        frame = settleOrigin(frameFromNormal(axis.origin, n, axis.dir));
        centre = onPlane(frame, axis.origin);
        break;
      }
      case "normal": {
        const curve = curveOf(ctx, p.curve, "curve");
        const f = Number.isFinite(p.position) ? p.position : 0;
        const { at, tangent } = alongCurve(ctx, curve, f);
        frame = frameFromNormal(at, tangent);
        centre = at;
        size = Math.max(10, Math.min(around, shapeSize(ctx, curve) * 0.6));
        break;
      }
      case "tangent": {
        if (!p.cylinder || !isGeomRef(p.cylinder)) throw ctx.fail("Pick a cylindrical face.");
        const face = ctx.resolve(p.cylinder);
        const info = face.kind === "face" ? faceInfo(ctx, face.shape) : null;
        if (!info || !info.axis || !info.radius) throw ctx.fail("Pick a cylindrical face.");
        const ref = frameFromNormal(info.axis.origin, info.axis.dir);
        const a = ((Number.isFinite(p.angle) ? p.angle : 0) * Math.PI) / 180;
        const radial = add(scale(ref.x, Math.cos(a)), scale(ref.y, Math.sin(a)));
        const at = add(info.axis.origin, scale(radial, info.radius));
        frame = frameFromNormal(at, radial, info.axis.dir);
        centre = at;
        size = info.size * 1.1;
        break;
      }
      default:
        throw ctx.fail("Choose how to place the plane.");
    }
    ctx.setDatum({ featureId: ctx.feature.id, kind: "plane", frame, centre, size: Math.max(5, size) });
  },
});
