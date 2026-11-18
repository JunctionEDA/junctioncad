// export-convert.ts — a BREP file rewritten as STEP, before it is stored with the project.
//
// The server stores 3D models by extension (.step, .stp; server/src/http.rs allowed_file), so an imported BREP
// file is converted here, exactly (both are B-rep), and stored as STEP.  The page sends the file's bytes:
//
//   const r = await kernel.call("export-convert", { data: <Uint8Array>, name: "bracket.brep" });   // r.data is STEP
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { readBrep, sniffFormat, writeStep } from "../kernel/ops/exchange-step";
import { defineService } from "../kernel/service";

export default defineService({
  name: "export-convert",
  run(ctx, raw) {
    const a = (raw || {}) as unknown as { data?: Uint8Array; name?: string };
    if (!(a.data instanceof Uint8Array)) throw ctx.fail("No file was sent.");
    const name = a.name || "file";
    if (sniffFormat(name, a.data.subarray(0, 64)) !== "brep") throw ctx.fail(`“${name}” is not a BREP file.`);
    const t0 = Date.now();
    const read = readBrep(ctx.k, a.data);
    try {
      const stem = name.replace(/\.[^.]+$/, "");
      const data = writeStep(ctx.k, read.bodies.map((shape, i) => ({ id: String(i), shape, name: read.bodies.length > 1 ? `${stem} ${i + 1}` : stem })), { schema: "AP214" });
      return { data, bytes: data.length, ms: Date.now() - t0, name: `${stem}.step` } as unknown as Json;
    } finally {
      for (const s of new Set([read.shape, ...read.bodies])) { try { s.delete(); } catch (e) { /* gone */ } }
    }
  },
});
