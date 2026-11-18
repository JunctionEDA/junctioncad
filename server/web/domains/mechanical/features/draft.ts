// draft.ts — the Draft feature: tilt faces by an angle about a neutral plane, so a moulded or cast part
// releases from its tool.  The neutral plane is a flat face (or a default plane); the faces turn about where they
// cross it, and the pull direction is the plane's normal ("Opposite direction" reverses it).
//
// Names: a drafted face keeps its name (it is the same face, tilted).
import { defineFeature } from "../core/feature";
import { scale, type GeomRef, type PlaneRef } from "../core/geometry";
import type { Body, EvalContext, Shape } from "../kernel/types";
import { draftFaces } from "../kernel/ops/draft";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DraftParams { [key: string]: any; faces: GeomRef[]; neutral: PlaneRef; angle: number; flip: boolean }

export default defineFeature<DraftParams>({
  type: "draft",
  title: "Draft",
  icon: '<path d="M6 20l3-15h6l3 15z"/><path d="M3 20h18"/>',
  toolbarOrder: 32,
  toolbarSection: "solid", toolbarMenu: "Fillet",
  defaults: () => ({ faces: [], neutral: { kind: "plane", plane: "top" }, angle: 3, flip: false }),
  schema: [
    { key: "faces", label: "Faces to draft", kind: "refs", of: ["face"] },
    { key: "neutral", label: "Neutral plane", kind: "plane", hint: "The faces turn about where they meet this plane." },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", min: 0.01, max: 45, step: 0.5 },
    { key: "flip", label: "Opposite direction", kind: "boolean", hint: "Pull the other way: the part narrows toward the other side." },
  ],

  evaluate(ctx: EvalContext, p: DraftParams) {
    const k = ctx.k, id = ctx.feature.id;
    if (!p.faces || !p.faces.length) throw ctx.fail("Pick the faces to draft.");
    if (!(p.angle > 0 && p.angle < 89)) throw ctx.fail("The angle must be between 0° and 89°.");
    const frame = ctx.frameOf(p.neutral);
    const byBody = new Map<Body, Shape[]>();
    for (const ref of p.faces) {
      const r = ctx.resolve(ref);
      if (r.kind !== "face") throw ctx.fail("Pick faces to draft.");
      byBody.set(r.body, [...(byBody.get(r.body) || []), r.shape]);
    }
    const pull = p.flip ? scale(frame.normal, -1) : frame.normal;
    for (const [body, faces] of byBody) {
      const r = draftFaces(k, body.shape, body.topo.faces, faces, pull, p.angle, { origin: frame.origin, normal: frame.normal }, id, ctx.own);
      const solids = k.solids(r.shape);
      if (solids.length !== 1) throw ctx.fail("The draft left a broken solid. Try a smaller angle.");
      ctx.replaceBody(body, solids[0], r.names);
    }
  },
});
