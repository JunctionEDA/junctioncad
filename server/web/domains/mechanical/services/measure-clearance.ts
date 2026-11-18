// measure-clearance.ts — the "clearance" service: the smallest gap between placed solids, exact, and where it is.
//
//   await kernel.call("clearance", { shapes: [{ key, brep?, transform }], pairs: [[i, j]] })
//   → { missing: [keys], results: [{ a, b, distance, pa, pb }] }
//
// Same shapes as "interference" (measure-interference.ts), read once and kept by key.  A distance of 0 means the
// two touch or overlap: the interference check says by how much.
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { defineService } from "../kernel/service";
import { minDistance } from "./_measure-kernel";
import { placeAll, type PlacedShape } from "./measure-interference";

export default defineService({
  name: "clearance",
  run(ctx, args) {
    const a = (args || {}) as { shapes?: PlacedShape[]; pairs?: [number, number][] };
    const shapes = a.shapes || [];
    const pairs = a.pairs && a.pairs.length ? a.pairs : shapes.length === 2 ? [[0, 1] as [number, number]] : [];
    const { placed: solids, missing } = placeAll(ctx.k, shapes);
    if (missing.length) return { missing, results: [] } as unknown as Json;
    try {
      const results = pairs.filter(([i, j]) => solids[i] && solids[j] && i !== j).map(([i, j]) => {
        const d = minDistance(ctx.k, solids[i], solids[j]);
        return d ? { a: i, b: j, distance: d.distance, pa: d.a, pb: d.b } : { a: i, b: j, distance: null, error: "The distance could not be found." };
      });
      return { missing: [], results } as unknown as Json;
    } finally { for (const s of solids) { try { s.delete(); } catch (e) { /* gone */ } } }
  },
});
