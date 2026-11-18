// export-outline.ts — the outline of a planar face as a flat drawing (lines, circles, arcs and polylines in the
// face's own plane), which the page writes as DXF or SVG (kernel/ops/exchange-2d.ts).
//
//   const d = await kernel.call("export-outline", { face: { kind: "face", body, name } });
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { isGeomRef } from "../core/geometry";
import { faceOutline } from "../kernel/ops/exchange-2d";
import { resolveRef } from "../kernel/regen";
import { defineService } from "../kernel/service";

export default defineService({
  name: "export-outline",
  run(ctx, raw) {
    const ref = (raw as { face?: unknown } | null)?.face;
    if (!isGeomRef(ref) || ref.kind !== "face") throw ctx.fail("Pick a flat face to export its outline.");
    const r = resolveRef(ctx.state, ref);
    const frame = ctx.k.faceFrame(r.shape as never);
    if (!frame) throw ctx.fail("That face is not flat. Pick a flat face, or export a sketch.");
    const drawing = faceOutline(ctx.k, r.shape, frame);
    return { ...drawing, frame, body: r.body.name } as unknown as Json;
  },
});
