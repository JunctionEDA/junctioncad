// export-mesh.ts — the part studio's parts as a triangle mesh: STL (binary or ASCII), 3MF, OBJ or GLB.
//
//   const r = await kernel.call("export-mesh", { format: "stl", resolution: { deflection: 0.02, angleDeg: 15 }, unit: "mm" });
//   r.data (Uint8Array, transferred), r.bytes, r.triangles, r.ms
//
// The parts are tessellated here, in the worker, at the resolution asked for; the page stays responsive.
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { exportParts, type ExportSelection } from "../kernel/ops/exchange-export";
import { RESOLUTIONS, meshOf, triangleCount, write3mf, writeGlb, writeObj, writeStlAscii, writeStlBinary, type MeshPart, type MeshResolution } from "../kernel/ops/exchange-mesh";
import { UNIT_MM, type LengthUnit } from "../kernel/ops/exchange-step";
import { defineService } from "../kernel/service";

interface Args extends ExportSelection { format?: "stl" | "stl-ascii" | "3mf" | "obj" | "glb"; resolution?: MeshResolution | keyof typeof RESOLUTIONS; unit?: LengthUnit }

export default defineService({
  name: "export-mesh",
  async run(ctx, raw) {
    const a = (raw || {}) as unknown as Args;
    const t0 = Date.now();
    const res = typeof a.resolution === "string" ? RESOLUTIONS[a.resolution] : a.resolution || RESOLUTIONS.medium;
    if (!res) throw ctx.fail("Choose a resolution.");
    const parts = exportParts(ctx, a);
    let meshes: MeshPart[];
    try { meshes = parts.map((p) => meshOf(ctx.k, p.shape, res, p.name, p.color)); } catch (e) { throw ctx.fail(e instanceof Error ? e.message : ctx.k.describe(e)); }
    const meshMs = Date.now() - t0;
    const unit = a.unit || "mm", scale = 1 / UNIT_MM[unit];
    let data: Uint8Array;
    switch (a.format || "stl") {
      case "stl": data = writeStlBinary(meshes, scale); break;
      case "stl-ascii": data = writeStlAscii(meshes, scale); break;
      case "3mf": data = await write3mf(meshes, unit, scale); break;
      case "obj": data = writeObj(meshes, scale); break;
      case "glb": data = writeGlb(meshes); break;
      default: throw ctx.fail(`Junction cannot write “${a.format}” files.`);
    }
    return { data, bytes: data.length, triangles: triangleCount(meshes), meshMs, ms: Date.now() - t0, parts: parts.length } as unknown as Json;
  },
});
