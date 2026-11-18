// edges.ts — the edges a fillet or chamfer acts on, from what was picked: edges, and every edge of picked
// faces; grouped by the body they are on.
import type { GeomRef } from "../../core/geometry";
import type { Body, EvalContext, NamedShape } from "../types";
import { edgesOfFaces } from "./shapes";

export interface PickedEdge extends NamedShape {
  /** the picked face this edge came from, when a face was picked */
  face?: NamedShape;
}

export function edgesByBody(ctx: EvalContext, refs: readonly GeomRef[]): Map<Body, PickedEdge[]> {
  const out = new Map<Body, PickedEdge[]>();
  const add = (body: Body, e: PickedEdge) => {
    const list = out.get(body) || [];
    if (!list.some((x) => x.name === e.name)) list.push(e);
    out.set(body, list);
  };
  for (const ref of refs) {
    const r = ctx.resolve(ref);
    if (r.kind === "edge") add(r.body, { name: r.name, shape: r.shape });
    else if (r.kind === "face") {
      const face = { name: r.name, shape: r.shape };
      for (const e of edgesOfFaces(ctx.k, r.body.topo.edges, [r.shape])) add(r.body, { ...e, face });
    } else throw ctx.fail("Pick edges or faces, not points.");
  }
  return out;
}
