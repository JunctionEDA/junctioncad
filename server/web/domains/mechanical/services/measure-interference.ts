// measure-interference.ts — the "interference" service: which placed solids overlap, and by how much, exact.
//
//   await kernel.call("interference", { shapes: [{ key, brep?, transform }], pairs?: [[i, j]], mesh?: true })
//   → { missing: [keys], checked, clashes: [{ a, b, volume, centre, bbox, mesh? }], ms }
//
// `shapes` are solids as BRep text (from the "body-brep" service of the worker that built them) placed by a
// 3 × 4 transform.  The worker keeps what it read under `key`, so a shape is sent once: when a key is neither
// cached nor sent, the reply lists it in `missing` and checks nothing.  The broad phase compares exact boxes
// (only `pairs`, when given; the assembly side sends the pairs whose boxes overlap); the narrow phase is a
// boolean common of the two solids.  A pair whose common volume is below `tolerance` (mm³, default 1e-6) only
// touches and is not a clash.
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { defineService } from "../kernel/service";
import type { Shape } from "../kernel/types";
import { boxOf, cached, meshOf, placed, shapeFrom, volumeOf } from "./_measure-kernel";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PlacedShape { key: string; brep?: string; transform?: number[] | null }

/** Read and place the shapes; null and the missing keys when some were not sent. */
export function placeAll(k: any, shapes: readonly PlacedShape[]): { placed: Shape[]; missing: string[] } {
  const sent = new Map<string, string>();
  for (const s of shapes) if (s.brep) sent.set(s.key, s.brep);
  const missing = shapes.filter((s) => !sent.has(s.key) && !cached(s.key)).map((s) => s.key);
  if (missing.length) return { placed: [], missing: Array.from(new Set(missing)) };
  return { placed: shapes.map((s) => placed(k, shapeFrom(k, s.key, sent.get(s.key)), s.transform || null)), missing: [] };
}

const overlap = (a: number[], b: number[], gap = 0) => a[0] <= b[3] + gap && b[0] <= a[3] + gap && a[1] <= b[4] + gap && b[1] <= a[4] + gap && a[2] <= b[5] + gap && b[2] <= a[5] + gap;

export default defineService({
  name: "interference",
  run(ctx, args) {
    const t0 = Date.now();
    const a = (args || {}) as { shapes?: PlacedShape[]; pairs?: [number, number][] | null; mesh?: boolean; tolerance?: number };
    const shapes = a.shapes || [];
    const tol = typeof a.tolerance === "number" && a.tolerance >= 0 ? a.tolerance : 1e-6;
    const oc = ctx.oc as any, k = ctx.k;
    const { placed: solids, missing } = placeAll(k, shapes);
    if (missing.length) return { missing, checked: 0, clashes: [], ms: Date.now() - t0 } as unknown as Json;
    try {
      const boxes = solids.map((s) => boxOf(k, s));
      const pairs: [number, number][] = a.pairs && a.pairs.length ? a.pairs.filter(([i, j]) => i !== j && solids[i] && solids[j]) : [];
      if (!a.pairs) for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) pairs.push([i, j]);
      const clashes: Json[] = [];
      let checked = 0;
      for (const [i, j] of pairs) {
        if (!overlap(boxes[i], boxes[j])) continue;
        checked++;
        const range = new oc.Message_ProgressRange();
        const common = new oc.BRepAlgoAPI_Common(solids[i], solids[j], range);
        range.delete();
        try {
          common.Build();
          if (!common.IsDone() || common.HasErrors()) { clashes.push({ a: i, b: j, volume: null, error: "The kernel could not intersect these two." }); continue; }
          const shape = common.Shape();
          try {
            const { volume, centre } = volumeOf(k, shape);
            if (!(volume > tol)) continue;
            const c: { [k: string]: Json } = { a: i, b: j, volume, centre, bbox: boxOf(k, shape) };
            if (a.mesh) c.mesh = meshOf(k, shape) as unknown as Json;
            clashes.push(c);
          } finally { shape.delete(); }
        } finally { common.delete(); }
      }
      return { missing: [], checked, clashes, ms: Date.now() - t0 } as unknown as Json;
    } finally { for (const s of solids) { try { s.delete(); } catch (e) { /* gone */ } } }
  },
});
