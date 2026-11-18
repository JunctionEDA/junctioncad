// export-step.ts — the part studio's parts as a STEP or BREP file.
//
//   const r = await kernel.call("export-step", { format: "step", schema: "AP242", unit: "mm", bodies: null });
//   r.data  — the file (Uint8Array, transferred), r.bytes, r.ms, r.parts
//
// STEP writes one named product per part (an XDE document), with its colour when one is given; `plain: true`
// writes bare shapes.  BREP is OpenCascade's own exact format, every part in one compound.
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { exportParts, type ExportSelection } from "../kernel/ops/exchange-export";
import { writeBrep, writeStep, type LengthUnit } from "../kernel/ops/exchange-step";
import { defineService } from "../kernel/service";

interface Args extends ExportSelection { format?: "step" | "brep"; schema?: "AP214" | "AP242"; unit?: LengthUnit; plain?: boolean }

export default defineService({
  name: "export-step",
  run(ctx, raw) {
    const a = (raw || {}) as unknown as Args;
    const t0 = Date.now();
    const parts = exportParts(ctx, a);
    let data: Uint8Array;
    try {
      data = a.format === "brep" ? writeBrep(ctx.k, parts) : writeStep(ctx.k, parts, { schema: a.schema, unit: a.unit, names: !a.plain });
    } catch (e) { throw ctx.fail(e instanceof Error ? e.message : ctx.k.describe(e)); }
    return { data, bytes: data.length, ms: Date.now() - t0, parts: parts.length } as unknown as Json;
  },
});
