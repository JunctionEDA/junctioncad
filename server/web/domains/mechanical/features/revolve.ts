// revolve.ts — the Revolve feature: turn the closed regions of a sketch about an axis, all the way round, by
// an angle, or by an angle split evenly either side of the sketch; as new bodies, or added to, removed from or
// intersected with the bodies in scope.
//
// The axis is a line of the sketch (a construction line, or a line that is not part of a closed outline), the
// sketch's own horizontal or vertical axis, or a straight edge of the model.
//
// Names (CONTRACT.md "Geometry names"), as Extrude's: the faces swept by sketch curves are
// `<id>:side:<entity>`, the caps of a partial revolve `<id>:start:<region>` and `<id>:end:<region>`.
import { defineFeature } from "../core/feature";
import { cross, dot, isGeomRef, scale, sub, toWorld, type GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { ShapeIndex, type NamedResult } from "../kernel/occ";
import { edgeAxis, sketchLineAxis, type Axis } from "../kernel/ops/axis";
import { axisOf } from "../kernel/ops/ref-geom";
import type { RefTarget } from "./_refs";
import { combine, OPERATION_OPTIONS, type Operation, type Tool } from "../kernel/ops/combine";
import { moveNamed } from "../kernel/ops/shapes";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RevolveParams {
  [key: string]: any;
  profile: { sketch: string; regions: string[] | null } | null;
  operation: Operation;
  /** "line": a loose line of the sketch; "x" / "y": the sketch's own axes; "edge": what `axisEdge` names */
  axisType: "line" | "x" | "y" | "edge";
  /** a straight model edge, or (a RefTarget, features/_refs.ts) a line of any sketch or a reference axis */
  axisEdge?: GeomRef | RefTarget | null;
  endType: "full" | "angle" | "symmetric";
  angle: number;
  flip: boolean;
  targets: string[];
}

export default defineFeature<RevolveParams>({
  type: "revolve",
  title: "Revolve",
  icon: '<ellipse cx="12" cy="7" rx="7" ry="2.5"/><path d="M5 7v10c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V7"/><path d="M12 3v18" stroke-dasharray="2 2"/>',
  toolbarOrder: 22,
  defaults: () => ({ profile: null, operation: "new", axisType: "line", axisEdge: null, endType: "full", angle: 180, flip: false, targets: [] }),
  schema: [
    { key: "profile", label: "Sketch to revolve", kind: "profile" },
    { key: "operation", label: "Result", kind: "enum", options: OPERATION_OPTIONS },
    { key: "axisType", label: "Axis", kind: "enum", options: [{ value: "line", label: "Sketch line" }, { value: "x", label: "Sketch X" }, { value: "y", label: "Sketch Y" }, { value: "edge", label: "Picked" }], hint: "Sketch line: a line drawn in the sketch that is not part of the outline. Picked: an edge, a line of any sketch or a reference axis you click." },
    { key: "axisEdge", label: "Axis", kind: "refs", of: ["edge"], single: true, sketch: true, datums: ["axis"], hint: "A straight edge, a line of a sketch (one among several, a construction line too), or a reference axis.", visible: (p) => p.axisType === "edge" },
    { key: "endType", label: "End", kind: "enum", options: [{ value: "full", label: "Full" }, { value: "angle", label: "Angle" }, { value: "symmetric", label: "Symmetric" }] },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", min: 0.01, max: 360, step: 5, visible: (p) => p.endType !== "full" },
    { key: "flip", label: "Opposite direction", kind: "boolean", visible: (p) => p.endType === "angle" },
    { key: "targets", label: "Bodies to change", kind: "bodies", hint: "Leave empty for every body.", visible: (p) => p.operation !== "new" },
  ],

  evaluate(ctx: EvalContext, p: RevolveParams) {
    const k = ctx.k, oc = ctx.oc as any, id = ctx.feature.id;
    if (!p.profile || !p.profile.sketch) throw ctx.fail("Pick a sketch to revolve.");
    const full = p.endType === "full" || Number(p.angle) >= 360;
    if (!full && !(Number(p.angle) > 0 && Number(p.angle) <= 360)) throw ctx.fail("The angle must be more than 0° and at most 360°.");
    const sketch = ctx.sketch(p.profile.sketch);
    const wanted = p.profile.regions;
    const regions = sketch.regions.filter((r) => !wanted || wanted.includes(r.id));
    if (!regions.length) throw ctx.fail(sketch.regions.length ? "The regions this feature used are gone from the sketch. Edit the feature and pick the sketch again." : "The sketch has no closed region to revolve. Close its outline first.");

    let axis: Axis;
    if (p.axisType === "edge") axis = !p.axisEdge || isGeomRef(p.axisEdge) ? edgeAxis(ctx, p.axisEdge as GeomRef | null) : axisOf(ctx, p.axisEdge, "axis");
    else if (p.axisType === "x") axis = { origin: sketch.frame.origin, dir: sketch.frame.x };
    else if (p.axisType === "y") axis = { origin: sketch.frame.origin, dir: sketch.frame.y };
    else axis = sketchLineAxis(ctx, sketch).axis;
    if (p.flip && p.endType === "angle") axis = { origin: axis.origin, dir: scale(axis.dir, -1) };

    // the profile must lie on one side of the axis, or the solid would pass through itself
    const side = cross(axis.dir, sketch.frame.normal);
    let lo = 0, hi = 0;
    for (const r of regions) for (const q of r.region.outer.polygon) { const d = dot(sub(toWorld(sketch.frame, q), axis.origin), side); lo = Math.min(lo, d); hi = Math.max(hi, d); }
    if (lo < -1e-6 && hi > 1e-6) throw ctx.fail("The profile crosses the axis. Move the axis to the edge of the profile, or split the profile.");
    if (Math.abs(dot(axis.dir, sketch.frame.normal)) > 1 - 1e-9) throw ctx.fail("The axis is square to the sketch; pick an axis that lies in the sketch's plane.");

    const ax = ctx.tmp(new oc.gp_Ax1(ctx.tmp(k.pnt(axis.origin)), ctx.tmp(k.dir(axis.dir))));
    const angle = full ? 360 : Number(p.angle);
    const tools: Tool[] = [];
    for (const r of regions) {
      const mk = ctx.own(full ? new oc.BRepPrimAPI_MakeRevol(r.face, ax, true) : new oc.BRepPrimAPI_MakeRevol(r.face, ax, (angle * Math.PI) / 180, true));
      mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
      if (!mk.IsDone()) throw ctx.fail("The profile could not be revolved.");
      const shape = ctx.own(mk.Shape());
      const named = new ShapeIndex<string>(k);
      if (!full) {
        named.add(ctx.own(mk.FirstShape()), `${id}:start:${r.id}`);
        named.add(ctx.own(mk.LastShape()), `${id}:end:${r.id}`);
      }
      for (const e of r.edges) for (const s of k.list(mk.Generated(e.edge))) if (!named.has(s)) named.add(s, `${id}:side:${e.entity}`);
      let t: NamedResult = { shape, names: (f) => named.get(f) ?? null };
      if (p.endType === "symmetric" && !full) t = moveNamed(k, t.shape, t.names, { axis, angle: -angle / 2 }, ctx.own);
      tools.push({ ...t, suffix: r.id });
    }
    combine(ctx, tools, p.operation || "new", p.targets);
  },
});
