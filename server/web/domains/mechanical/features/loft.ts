// loft.ts — the Loft feature: a solid through two or more profiles, in the order picked, as a new body, added,
// or removed.  Each profile is a sketch's closed region (its outer loop).  Ruled joins the profiles with straight
// sections; smooth passes one surface through all of them.  Faces: `<id>:start`, `<id>:end` (the first and last
// profile), and `<id>:side:<entity>` for the face that leaves each curve of the first profile.
import { defineFeature } from "../core/feature";
import { ShapeIndex, type NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { applyOperation, operationFields, type Operation } from "../kernel/ops/sweep-apply";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface LoftParams { [key: string]: any; profiles: string[]; ruled: boolean; operation: Operation; targets: string[] }

export default defineFeature<LoftParams>({
  type: "loft",
  title: "Loft",
  icon: '<rect x="4" y="16" width="16" height="4"/><ellipse cx="12" cy="5" rx="4" ry="1.8"/><path d="M4 16L8 5M20 16L16 5"/>',
  toolbarOrder: 25,
  toolbarSection: "solid", toolbarMenu: "Sweep",
  defaults: () => ({ profiles: [], ruled: false, operation: "new", targets: [] }),
  schema: [
    { key: "profiles", label: "Profiles", kind: "features", types: ["sketch"], hint: "Two or more sketches, in the order the loft passes through them." },
    { key: "ruled", label: "Ruled", kind: "boolean", hint: "Straight between profiles, instead of one smooth surface through them." },
    ...operationFields,
  ],

  evaluate(ctx: EvalContext, p: LoftParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const ids = Array.isArray(p.profiles) ? p.profiles : [];
    if (ids.length < 2) throw ctx.fail("Pick two or more sketches to loft through.");
    const ts = ctx.tmp(new oc.BRepOffsetAPI_ThruSections(true, !!p.ruled, 1e-6));
    ts.CheckCompatibility(false);
    let first: { entity: string; edge: any }[] = [];
    ids.forEach((sid, i) => {
      const s = ctx.sketch(sid);
      if (!s.regions.length) throw ctx.fail("A sketch to loft through has no closed region.");
      if (s.regions.length > 1) ctx.warn("A sketch has several regions: the loft uses the first.");
      const r = s.regions[0];
      if (i === 0) first = r.edges;
      ts.AddWire(oc.BRepTools.OuterWire(r.face));
    });
    ts.Build(ctx.tmp(new oc.Message_ProgressRange()));
    if (!ts.IsDone()) throw ctx.fail("The loft could not be built. Profiles with the same number of curves, drawn the same way round, loft best.");
    const shape = ctx.own(ts.Shape());
    const solids = k.solids(shape);
    if (!solids.length || k.volume(shape) <= 1e-9) throw ctx.fail("The loft has no volume. Put the profiles on different planes.");
    const named = new ShapeIndex<string>(k);
    const cap = (s: any, name: string) => { if (s && !s.IsNull()) named.add(ctx.own(s), name); };
    cap(ts.FirstShape(), `${id}:start`);
    cap(ts.LastShape(), `${id}:end`);
    for (const e of first) for (const side of k.list(ts.Generated(e.edge))) if (!named.has(side)) named.add(side, `${id}:side:${e.entity}`);
    const tool: NamedResult = { shape: solids.length === 1 ? solids[0] : shape, names: (f) => named.get(f) ?? null };
    applyOperation(ctx, [tool], p.operation, p.targets);
  },
});
