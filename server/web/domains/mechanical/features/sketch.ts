// sketch.ts — the Sketch feature: 2D curves on a plane or a planar face, and the closed regions they enclose.
//
// It solves nothing.  The document stores the curves where they are, already solved by the sketcher in the page
// (sketch/format.ts, sketch/solver); this turns them into kernel wires and faces that later features extrude,
// revolve or sweep.  Regions come from sketch/planar.ts, so curves that cross enclose regions too.  Its editor
// is sketch/editor.ts with the tools in tools/sketch-*.ts.
import type { TopoDS_Edge } from "replicad-opencascadejs";
import { defineFeature } from "../core/feature";
import { toWorld, type PlaneRef } from "../core/geometry";
import { emptySketch, pointOf, type SketchData } from "../sketch/format";
import { findRegions, type SpanEdge } from "../sketch/planar";
import type { Loop } from "../sketch/profiles";
import type { EvalContext, SketchRegion } from "../kernel/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SketchParams { [key: string]: any; plane: PlaneRef; sketch: SketchData }

export default defineFeature<SketchParams>({
  type: "sketch",
  title: "Sketch",
  icon: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
  toolbarOrder: 10,
  toolbarSection: "sketch",
  defaults: () => ({ plane: { kind: "plane", plane: "top" }, sketch: emptySketch() }),
  schema: [{ key: "plane", label: "Sketch plane", kind: "plane" }],

  evaluate(ctx: EvalContext, params: SketchParams) {
    const oc = ctx.oc as any, k = ctx.k;
    const data: SketchData = params.sketch && params.sketch.entities ? params.sketch : emptySketch();
    const frame = ctx.frameOf(params.plane);
    const found = findRegions(data);
    const normal = ctx.tmp(k.dir(frame.normal)), xdir = ctx.tmp(k.dir(frame.x));
    const origin = ctx.tmp(k.pnt(frame.origin));
    const plane = ctx.tmp(new oc.gp_Pln(ctx.tmp(new oc.gp_Ax3(origin, normal, xdir))));

    // one kernel edge per curve of a loop, running the way the loop runs
    // (a loop edge with a `span` is only that stretch of its curve: the curve was cut where another crosses it)
    const edgeFor = ({ entity, reversed, span }: SpanEdge): TopoDS_Edge => {
      const e = data.entities[entity];
      let edge: any;
      if (e.type === "line") {
        const p = pointOf(data, e.a)!, q = pointOf(data, e.b)!;
        const on = (t: number): [number, number] => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        const from = span ? on(span[0]) : p, to = span ? on(span[1]) : q;
        const a = reversed ? to : from, b = reversed ? from : to;
        edge = new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(k.pnt(toWorld(frame, a))), ctx.tmp(k.pnt(toWorld(frame, b)))).Edge();
      } else if (e.type === "circle" || e.type === "arc") {
        const c = pointOf(data, e.center)!;
        const circle = e.type === "circle";
        const start = circle ? null : pointOf(data, e.start)!, end = circle ? null : pointOf(data, e.end)!;
        const r = circle ? e.r : Math.hypot(start![0] - c[0], start![1] - c[1]);
        if (!(r > 0)) throw ctx.fail("The sketch has a circle or arc with no radius.");
        const circ = ctx.tmp(new oc.gp_Circ(ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt(toWorld(frame, c))), normal, xdir)), r));
        if (span) edge = new oc.BRepBuilderAPI_MakeEdge(circ, span[0], span[1]).Edge();
        else if (circle) edge = new oc.BRepBuilderAPI_MakeEdge(circ).Edge();
        else {
          // by angle, counter-clockwise from start to end, so an end point slightly off the circle still closes
          const a0 = Math.atan2(start![1] - c[1], start![0] - c[0]); let a1 = Math.atan2(end![1] - c[1], end![0] - c[0]);
          if (a1 <= a0) a1 += Math.PI * 2;
          edge = new oc.BRepBuilderAPI_MakeEdge(circ, a0, a1).Edge();
        }
        if (reversed) { const flipped = oc.TopoDS.Edge(ctx.tmp(edge.Reversed())); ctx.tmp(edge); edge = flipped; }
      } else throw ctx.fail("The sketch has a curve this version cannot build.");
      return ctx.own(edge);
    };
    const wireFor = (loop: Loop, edges: { entity: string; edge: TopoDS_Edge }[] | null): any => {
      const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
      for (const le of loop.edges) {
        mw.Add(edgeFor(le));
        if (!mw.IsDone()) throw ctx.fail("A sketch loop could not be closed.");
        if (edges) edges.push({ entity: le.entity, edge: ctx.own(mw.Edge()) });   // the edge as the wire holds it: what the kernel's history speaks of
      }
      return ctx.own(mw.Wire());
    };

    const regions: SketchRegion[] = [];
    for (const region of found.regions) {
      const edges: { entity: string; edge: TopoDS_Edge }[] = [];
      const mf = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(plane, wireFor(region.outer, edges), true));
      for (const hole of region.holes) mf.Add(oc.TopoDS.Wire(ctx.tmp(wireFor(hole, edges).Reversed())));
      if (!mf.IsDone()) throw ctx.fail("A closed region of the sketch could not be made into a face.");
      regions.push({ id: region.id, region, face: ctx.own(mf.Face()), edges });
    }
    ctx.setSketch({ featureId: ctx.feature.id, frame, data, regions, open: found.open });
  },
});
