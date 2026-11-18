// split.ts — the Split feature: cut bodies in two with a plane (a default plane or a flat face), keeping both
// pieces as bodies or only the piece on one side.
//
// Which piece keeps the body's id: the first kept piece on the side the plane's normal points to ("Front"),
// else the first on the other side; the others become `<body id>.split<n>`.
// Names: the faces the body had keep their names (a face cut in two keeps it on both pieces); the new flat
// face on each piece is `<id>:cut`.
import { defineFeature } from "../core/feature";
import { dot, sub, type PlaneRef } from "../core/geometry";
import type { Body, EvalContext, Shape } from "../kernel/types";
import { scoped } from "../kernel/ops/combine";
import { planeFace, reachPast, solidCentre } from "../kernel/ops/shapes";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SplitParams { [key: string]: any; plane: PlaneRef; bodies: string[]; keep: "both" | "front" | "back" }

export default defineFeature<SplitParams>({
  type: "split",
  title: "Split",
  icon: '<path d="M4 9l8-4 8 4v8l-8 4-8-4z"/><path d="M3 13h18" stroke-dasharray="2 2"/>',
  toolbarOrder: 43,
  toolbarSection: "solid", toolbarMenu: "Boolean",
  defaults: () => ({ plane: { kind: "plane", plane: "front" }, bodies: [], keep: "both" }),
  schema: [
    { key: "plane", label: "Split with", kind: "plane" },
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "Leave empty for every body." },
    { key: "keep", label: "Keep", kind: "enum", options: [{ value: "both", label: "Both" }, { value: "front", label: "Front" }, { value: "back", label: "Back" }], hint: "Front is the side the plane's normal points to." },
  ],

  evaluate(ctx: EvalContext, p: SplitParams) {
    const k = ctx.k, oc = ctx.oc as any, id = ctx.feature.id;
    const frame = ctx.frameOf(p.plane);
    const bodies = scoped(ctx, p.bodies);
    if (!bodies.length) throw ctx.fail("There is no body to split.");
    const size = reachPast(k, bodies.map((b) => b.shape), frame.origin);
    const tool = planeFace(k, frame.origin, frame.normal, size, ctx.own);
    const cut = `${id}:cut`;
    let split = 0;
    for (const body of bodies) {
      const mk = ctx.own(new oc.BRepAlgoAPI_Splitter());
      const args = ctx.tmp(new oc.NCollection_List_TopoDS_Shape()); args.Append(body.shape);
      const tools = ctx.tmp(new oc.NCollection_List_TopoDS_Shape()); tools.Append(tool);
      mk.SetArguments(args); mk.SetTools(tools);
      mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
      if (!mk.IsDone() || mk.HasErrors()) throw ctx.fail(`${body.name} could not be split.`);
      const shape: Shape = ctx.own(mk.Shape());
      const pieces = k.solids(shape);
      if (pieces.length < 2) continue;   // the plane misses this body
      split++;
      const carried = k.carryNames(shape, mk, [...body.topo.faces, { name: cut, shape: tool }], id);
      const names = (f: any, i: number) => { const n = carried(f, i); return n && n.startsWith(cut) ? cut : n; };
      const side = (s: Shape) => dot(sub(solidCentre(k, s), frame.origin), frame.normal);
      const front = pieces.filter((s) => side(s) > 0), back = pieces.filter((s) => side(s) <= 0);
      const kept = p.keep === "front" ? front : p.keep === "back" ? back : [...front, ...back];
      if (!kept.length) { ctx.removeBody(body); continue; }
      const whole: Body = body;
      ctx.replaceBody(body, kept[0], names);
      kept.slice(1).forEach((s, n) => ctx.addBody(s, names, { suffix: `${whole.id}.split${n + 2}`, name: `${whole.name} (${n + 2})` }));
    }
    if (!split) throw ctx.fail("The plane does not cross any of the bodies.");
  },
});
