// helix.ts — the Helix feature: a reference curve, a helix about an axis, for Sweep to follow (springs, threads).
// It starts at `start` degrees from the axis' reference direction, at the axis origin, and climbs `pitch` per turn.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { axisOf, frameFromNormal, sampleCurve } from "../kernel/ops/ref-geom";
import { rotateAbout } from "../kernel/ops/ref-datum";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HelixParams { [key: string]: any; axis: RefTarget | null; radius: number; pitch: number; turns: number; start: number; left: boolean }

export default defineFeature<HelixParams>({
  type: "helix",
  title: "Helix",
  icon: '<path d="M6 4c12 0 12 4 0 4s-0 4 12 4-0 4-12 4 0 4 12 4"/>',
  toolbarOrder: 63,
  toolbarSection: "reference", toolbarMenu: "Reference",
  defaults: () => ({ axis: null, radius: 10, pitch: 5, turns: 4, start: 0, left: false }),
  schema: [
    { key: "axis", label: "Axis", kind: "refs", of: ["edge", "face"], single: true, planes: true, datums: ["axis", "plane"], sketch: true, hint: "An axis, a round edge or cylindrical face, or a plane (along its normal)." },
    { key: "radius", label: "Radius", kind: "number", unit: "mm", min: 0.001, step: 1 },
    { key: "pitch", label: "Pitch", kind: "number", unit: "mm", min: 0.001, step: 1 },
    { key: "turns", label: "Turns", kind: "number", unit: "none", min: 0.01, step: 1 },
    { key: "start", label: "Start angle", kind: "number", unit: "deg", step: 15 },
    { key: "left", label: "Left-handed", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: HelixParams) {
    const oc = ctx.oc as any, k = ctx.k;
    if (!(p.radius > 0)) throw ctx.fail("The radius must be more than zero.");
    if (!(p.pitch > 0)) throw ctx.fail("The pitch must be more than zero.");
    if (!(p.turns > 0) || p.turns > 500) throw ctx.fail("The number of turns must be more than zero (and at most 500).");
    const axis = axisOf(ctx, p.axis, "axis");
    const f = frameFromNormal(axis.origin, axis.dir);
    const x = rotateAbout(f.x, f.normal, ((Number(p.start) || 0) * Math.PI) / 180);
    const ax3 = ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(axis.origin)), ctx.tmp(k.dir(axis.dir)), ctx.tmp(k.dir(x))));
    // geometry objects are reference-counted by the edges that use them: they are not deleted here
    const surface = new oc.Geom_CylindricalSurface(ax3, p.radius);
    // on the cylinder's (angle, height) plane a helix is a straight line
    const du = (p.left ? -1 : 1) * 2 * Math.PI, dv = p.pitch;
    const line = new oc.Geom2d_Line(ctx.tmp(new oc.gp_Pnt2d(0, 0)), ctx.tmp(new oc.gp_Dir2d(du, dv)));
    const len = p.turns * Math.hypot(du, dv);
    const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(line, surface, 0, len));
    if (!mk.IsDone()) throw ctx.fail("The helix could not be built.");
    const edge = ctx.own(mk.Edge());
    oc.BRepLib.BuildCurves3d(edge);
    const wire = ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeWire(edge)).Wire());
    ctx.setDatum({ featureId: ctx.feature.id, kind: "curve", shape: wire, points: sampleCurve(ctx, wire, Math.min(4000, Math.ceil(p.turns * 48))) });
  },
});
