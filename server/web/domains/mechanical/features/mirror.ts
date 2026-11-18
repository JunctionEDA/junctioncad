// mirror.ts — the Mirror feature: features or bodies reflected in a plane or a flat face.  Mirrored features are
// cut from or joined to the bodies their originals changed; mirrored bodies are new bodies, or joined to their
// originals.  Faces of the mirror image are named `<mirror id>:m:<the original face's name>`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { planeOf } from "../kernel/ops/ref-geom";
import { reflection } from "../kernel/ops/pattern-core";
import { copyDefaults, copyFields, copyInstances, type CopyParams } from "./_pattern";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MirrorParams extends CopyParams { [key: string]: any; plane: RefTarget | null }

export default defineFeature<MirrorParams>({
  type: "mirror",
  title: "Mirror",
  icon: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 6L4 18h5z"/><path d="M15 6l5 12h-5z"/>',
  toolbarOrder: 72,
  toolbarSection: "pattern", toolbarMenu: "Pattern",
  defaults: () => ({ ...copyDefaults(), plane: null }),
  schema: [
    ...copyFields("Mirror"),
    { key: "plane", label: "Mirror plane", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"] },
  ],

  evaluate(ctx: EvalContext, p: MirrorParams) {
    const frame = planeOf(ctx, p.plane, "mirror plane");
    copyInstances(ctx, p, [{ key: "m", trsf: reflection(ctx, frame.origin, frame.normal) }], "mirror", true);
  },
});
