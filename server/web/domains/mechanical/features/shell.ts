// shell.ts — the Shell feature: hollow a body into walls of one thickness, opening it where faces are removed.
// The walls go inside the body's faces (the outside stays where it was) or outside them.
//
// Names: the outer faces keep theirs; each wall face is `<id>:from(<the face it is offset from>)`; the rim
// of an opening keeps the name of the face that was removed there.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { Body, EvalContext, Shape } from "../kernel/types";
import { thickWall } from "../kernel/ops/thick";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ShellParams { [key: string]: any; faces: GeomRef[]; thickness: number; outward: boolean; bodies: string[] }

export default defineFeature<ShellParams>({
  type: "shell",
  title: "Shell",
  icon: '<path d="M4 9l8-4 8 4v8l-8 4-8-4z"/><path d="M7 10.5l5-2.5 5 2.5v5l-5 2.5-5-2.5z"/>',
  toolbarOrder: 33,
  defaults: () => ({ faces: [], thickness: 2, outward: false, bodies: [] }),
  schema: [
    { key: "faces", label: "Faces to remove", kind: "refs", of: ["face"], hint: "The openings. Leave empty and pick a body for a closed hollow body." },
    { key: "bodies", label: "Hollow body", kind: "bodies", hint: "Only when no face is removed: the bodies to hollow.", visible: (p) => !(Array.isArray(p.faces) && p.faces.length) },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0.001, step: 0.5 },
    { key: "outward", label: "Walls outside", kind: "boolean", hint: "Grow the walls out from the faces instead of in." },
  ],

  evaluate(ctx: EvalContext, p: ShellParams) {
    const k = ctx.k, id = ctx.feature.id;
    if (!(p.thickness > 0)) throw ctx.fail("The thickness must be more than zero.");
    const open = new Map<Body, Shape[]>();
    for (const ref of p.faces || []) {
      const r = ctx.resolve(ref);
      if (r.kind !== "face") throw ctx.fail("Pick faces to remove.");
      open.set(r.body, [...(open.get(r.body) || []), r.shape]);
    }
    if (!open.size) {
      if (!p.bodies || !p.bodies.length) throw ctx.fail("Pick the faces to remove, or a body to hollow.");
      for (const b of p.bodies) { const body = ctx.body(b); if (!body) throw ctx.fail("A body to hollow is gone. Pick it again."); open.set(body, []); }
    }
    for (const [body, faces] of open) {
      const r = thickWall(k, body.shape, body.topo.faces, faces, p.outward ? p.thickness : -p.thickness, id, ctx.own);
      ctx.replaceBody(body, r.shape, r.names);
    }
  },
});
