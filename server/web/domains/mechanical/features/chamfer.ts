// chamfer.ts — the Chamfer feature: bevel edges by one distance, two distances, or a distance and an angle.
// Pick edges, or faces to bevel every edge around them.  With two distances or an angle, the first distance
// is measured on the picked face, or for a picked edge on the first of its two faces; "Swap sides" turns it.
//
// Names: the faces the body had keep their names; each bevel is `<id>:from(<the edge's name>)`.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext, NamedShape, Shape } from "../kernel/types";
import { edgesByBody } from "../kernel/ops/edges";
import { facesOfEdge } from "../kernel/ops/shapes";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ChamferParams {
  [key: string]: any;
  edges: GeomRef[];
  chamferType: "equal" | "two" | "angle";
  distance: number;
  distance2: number;
  angle: number;
  flip: boolean;
}

export default defineFeature<ChamferParams>({
  type: "chamfer",
  title: "Chamfer",
  icon: '<path d="M5 19v-8l6-6h8"/><path d="M5 5h3M19 19v-3" stroke-dasharray="1.5 2"/>',
  toolbarOrder: 31,
  toolbarSection: "solid", toolbarMenu: "Fillet",
  defaults: () => ({ edges: [], chamferType: "equal", distance: 1, distance2: 2, angle: 45, flip: false }),
  schema: [
    { key: "edges", label: "Edges or faces", kind: "refs", of: ["edge", "face"], hint: "A face bevels every edge around it." },
    { key: "chamferType", label: "Type", kind: "enum", options: [{ value: "equal", label: "Distance" }, { value: "two", label: "Two distances" }, { value: "angle", label: "Distance, angle" }] },
    { key: "distance", label: "Distance", kind: "number", unit: "mm", min: 0.001, step: 0.5 },
    { key: "distance2", label: "Second distance", kind: "number", unit: "mm", min: 0.001, step: 0.5, visible: (p) => p.chamferType === "two" },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", min: 0.1, max: 89.9, step: 5, visible: (p) => p.chamferType === "angle" },
    { key: "flip", label: "Swap sides", kind: "boolean", visible: (p) => p.chamferType !== "equal" },
  ],

  evaluate(ctx: EvalContext, p: ChamferParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const type = p.chamferType || "equal";
    if (!p.edges || !p.edges.length) throw ctx.fail("Pick the edges to bevel.");
    if (!(p.distance > 0)) throw ctx.fail("The distance must be more than zero.");
    if (type === "two" && !(p.distance2 > 0)) throw ctx.fail("The second distance must be more than zero.");
    if (type === "angle" && !(p.angle > 0 && p.angle < 90)) throw ctx.fail("The angle must be between 0° and 90°.");
    for (const [body, edges] of edgesByBody(ctx, p.edges)) {
      const mk = ctx.own(new oc.BRepFilletAPI_MakeChamfer(body.shape));
      for (const e of edges) {
        const edge = oc.TopoDS.Edge(e.shape);
        if (type === "equal") { mk.Add(p.distance, edge); continue; }
        // the face the first distance is measured on
        const around = facesOfEdge(k, body.topo.faces, e.shape).sort((a, b) => (a.name < b.name ? -1 : 1));
        if (around.length < 2) throw ctx.fail("An edge to bevel does not lie between two faces.");
        let ref: NamedShape = e.face && around.some((f) => f.shape.IsSame(e.face!.shape)) ? around.find((f) => f.shape.IsSame(e.face!.shape))! : around[0];
        if (p.flip) ref = around.find((f) => f !== ref)!;
        const face = oc.TopoDS.Face(ref.shape);
        if (type === "two") mk.Add(p.distance, p.distance2, edge, face);
        else mk.AddDA(p.distance, (p.angle * Math.PI) / 180, edge, face);
      }
      try { mk.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (x) { throw ctx.fail(`The chamfer could not be built (${k.describe(x)}). Try a smaller distance.`); }
      if (!mk.IsDone()) throw ctx.fail(`The chamfer on ${body.name} could not be built. Try a smaller distance, or fewer edges at once.`);
      const shape: Shape = ctx.own(mk.Shape());
      const solids = k.solids(shape);
      if (solids.length !== 1) throw ctx.fail("The chamfer left a broken solid. Try a smaller distance.");
      ctx.replaceBody(body, solids[0], k.carryNames(shape, mk, body.topo.faces, id, [...edges, ...body.topo.vertices]));
    }
  },
});
