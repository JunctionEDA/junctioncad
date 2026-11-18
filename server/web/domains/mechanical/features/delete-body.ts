// delete-body.ts — the Delete body feature: take bodies out of the part studio from this point in the history
// on.  Earlier features still see them (a body used as a tool and then deleted).
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DeleteBodyParams { [key: string]: any; bodies: string[] }

export default defineFeature<DeleteBodyParams>({
  type: "delete-body",
  title: "Delete body",
  icon: '<path d="M4 9l8-4 8 4v8l-8 4-8-4z"/><path d="M9 11l6 6M15 11l-6 6"/>',
  toolbarOrder: 42,
  toolbarSection: "solid", toolbarMenu: "Boolean",
  defaults: () => ({ bodies: [] }),
  schema: [{ key: "bodies", label: "Bodies", kind: "bodies", hint: "Click the bodies to delete." }],

  evaluate(ctx: EvalContext, p: DeleteBodyParams) {
    if (!p.bodies || !p.bodies.length) throw ctx.fail("Pick the bodies to delete.");
    let gone = 0;
    for (const id of p.bodies) { const b = ctx.body(id); if (b) ctx.removeBody(b); else gone++; }
    if (gone === p.bodies.length) throw ctx.fail("The bodies to delete are already gone.");
    if (gone) ctx.warn(`${gone} of the bodies to delete ${gone === 1 ? "is" : "are"} already gone.`);
  },
});
