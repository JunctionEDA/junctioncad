// transform.ts — the Transform feature: move or turn bodies, or copies of them.  Turns first (about a world
// axis or a straight edge), then moves.
//
// Names: every face keeps its name, on the body and on a copy.  A copy is a body of its own, `<id>:<body id>`.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { edgeAxis, WORLD_AXES, type Axis } from "../kernel/ops/axis";
import { moveNamed } from "../kernel/ops/shapes";
import { ShapeIndex } from "../kernel/occ";

export interface TransformParams {
  [key: string]: any;
  bodies: string[];
  dx: number; dy: number; dz: number;
  axis: "x" | "y" | "z" | "edge";
  axisEdge?: GeomRef | null;
  angle: number;
  copy: boolean;
}

export default defineFeature<TransformParams>({
  type: "transform",
  title: "Transform",
  icon: '<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  toolbarOrder: 44,
  toolbarSection: "solid", toolbarMenu: "Boolean",
  defaults: () => ({ bodies: [], dx: 0, dy: 0, dz: 0, axis: "z", axisEdge: null, angle: 0, copy: false }),
  schema: [
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "Click the bodies to move." },
    { key: "dx", label: "Move X", kind: "number", unit: "mm", step: 1 },
    { key: "dy", label: "Move Y", kind: "number", unit: "mm", step: 1 },
    { key: "dz", label: "Move Z", kind: "number", unit: "mm", step: 1 },
    { key: "angle", label: "Turn", kind: "number", unit: "deg", min: -360, max: 360, step: 15 },
    { key: "axis", label: "About", kind: "enum", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }, { value: "z", label: "Z" }, { value: "edge", label: "Edge" }], visible: (p) => !!p.angle },
    { key: "axisEdge", label: "Axis edge", kind: "refs", of: ["edge"], single: true, visible: (p) => !!p.angle && p.axis === "edge" },
    { key: "copy", label: "Copy", kind: "boolean", hint: "Keep the bodies where they are and move copies." },
  ],

  evaluate(ctx: EvalContext, p: TransformParams) {
    const k = ctx.k;
    if (!p.bodies || !p.bodies.length) throw ctx.fail("Pick the bodies to move.");
    const d: [number, number, number] = [Number(p.dx) || 0, Number(p.dy) || 0, Number(p.dz) || 0];
    const angle = Number(p.angle) || 0;
    if (!d[0] && !d[1] && !d[2] && !angle) throw ctx.fail("Enter a distance to move or an angle to turn.");
    const axis: Axis | undefined = angle ? (p.axis === "edge" ? edgeAxis(ctx, p.axisEdge) : WORLD_AXES[p.axis] || WORLD_AXES.z) : undefined;
    for (const bid of p.bodies) {
      const body = ctx.body(bid);
      if (!body) throw ctx.fail("A body to move is gone. Edit the feature and pick it again.");
      const index = new ShapeIndex<string>(k);
      for (const f of body.topo.faces) index.add(f.shape, f.name);
      const moved = moveNamed(k, body.shape, (f) => index.get(f) ?? null, { translate: d, axis, angle }, ctx.own);
      if (p.copy) ctx.addBody(moved.shape, moved.names, { suffix: body.id, name: `${body.name} copy` });
      else ctx.replaceBody(body, moved.shape, moved.names);
    }
  },
});
