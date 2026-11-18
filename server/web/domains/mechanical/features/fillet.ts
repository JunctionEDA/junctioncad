// fillet.ts — the Fillet feature: round edges with a constant radius.  Pick edges, or faces to round every
// edge around them.  A chain of edges that meet smoothly (tangent) is rounded as one: picking one edge of a
// rounded outline rounds the whole outline.
//
// Names: the faces the body had keep their names; each rounding face is `<id>:from(<the edge's name>)`, and a
// blend at a corner where several fillets meet is `<id>:from(<the vertex's name>)`.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { edgesByBody } from "../kernel/ops/edges";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FilletParams { [key: string]: any; edges: GeomRef[]; radius: number }

export default defineFeature<FilletParams>({
  type: "fillet",
  title: "Fillet",
  icon: '<path d="M5 19V12a7 7 0 0 1 7-7h7"/><path d="M5 5h3M19 19v-3" stroke-dasharray="1.5 2"/>',
  toolbarOrder: 30,
  toolbarSection: "solid", toolbarMenu: "Fillet",
  defaults: () => ({ edges: [], radius: 1 }),
  schema: [
    { key: "edges", label: "Edges or faces", kind: "refs", of: ["edge", "face"], hint: "A face rounds every edge around it." },
    { key: "radius", label: "Radius", kind: "number", unit: "mm", min: 0.001, step: 0.5 },
  ],

  evaluate(ctx: EvalContext, p: FilletParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    if (!p.edges || !p.edges.length) throw ctx.fail("Pick the edges to round.");
    if (!(p.radius > 0)) throw ctx.fail("The radius must be more than zero.");
    for (const [body, edges] of edgesByBody(ctx, p.edges)) {
      const mk = ctx.own(new oc.BRepFilletAPI_MakeFillet(body.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational));
      for (const e of edges) mk.Add(p.radius, oc.TopoDS.Edge(e.shape));
      try { mk.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (x) { throw ctx.fail(`The fillet could not be built (${k.describe(x)}). Try a smaller radius.`); }
      if (!mk.IsDone()) throw ctx.fail(`The fillet on ${body.name} could not be built. Try a smaller radius, or fewer edges at once.`);
      const shape: Shape = ctx.own(mk.Shape());
      const solids = k.solids(shape);
      if (solids.length !== 1) throw ctx.fail("The fillet left a broken solid. Try a smaller radius.");
      const names = k.carryNames(shape, mk, body.topo.faces, id, [...edges, ...body.topo.vertices]);
      ctx.replaceBody(body, solids[0], names);
    }
  },
});
