// compare-versions.ts — the 3D difference between two versions of a part studio.
//
// Both versions are built here, side by side, by regeneration engines of their own (the engine the page's
// viewport uses is left alone), and their bodies are compared by booleans: what both have, what only the newer
// has (material added), what only the older had (material removed).  Each of the three comes back tessellated,
// with its volume.  The page (compare/index.tsx) draws them in the Compare window.
//
//   await kernel.call("compare-versions", { a: { features, rollback }, b: { features, rollback } })
import { stableJson, type Json } from "../../../shared/itemdoc/itemdoc";
import { FEATURES } from "../generated/worker";
import { RegenEngine } from "../kernel/regen";
import { compound } from "../kernel/ops/shapes";
import { defineService } from "../kernel/service";
import { DEFAULT_QUALITY } from "../kernel/tessellate";
import type { FeatureInput, FeatureReport } from "../kernel/protocol";
import type { Kernel } from "../kernel/occ";
import type { Shape } from "../kernel/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CompareSideInput { features: FeatureInput[]; rollback: number }
/** Triangles and edge segments, without names: nothing here is picked. */
export interface PlainMesh { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edges: Float32Array }
export interface CompareResult {
  a: { reports: FeatureReport[]; bodies: number; volume: number };
  b: { reports: FeatureReport[]; bodies: number; volume: number };
  /** what both versions have, what only `b` has, what only `a` had; null when there is none */
  common: PlainMesh | null; added: PlainMesh | null; removed: PlainMesh | null;
  volumes: { common: number; added: number; removed: number };
  ms: number;
}

function meshOf(k: Kernel, shape: Shape): PlainMesh {
  const oc = k.oc as any, heap = (): ArrayBuffer => oc.wasmMemory.buffer;
  const m = oc.ReplicadMeshExtractor.extract(shape, DEFAULT_QUALITY.linear, DEFAULT_QUALITY.angular, false);
  const positions = new Float32Array(heap(), m.getVerticesPtr(), m.getVerticesSize()).slice();
  const normals = new Float32Array(heap(), m.getNormalsPtr(), m.getNormalsSize()).slice();
  const indices = new Uint32Array(heap(), m.getTrianglesPtr(), m.getTrianglesSize()).slice();
  m.delete();
  const em = oc.ReplicadEdgeMeshExtractor.extract(shape, DEFAULT_QUALITY.linear, DEFAULT_QUALITY.angular);
  const edges = new Float32Array(heap(), em.getLinesPtr(), em.getLinesSize()).slice();
  em.delete();
  return { positions, normals, indices, edges };
}

export default defineService({
  name: "compare-versions",
  async run(ctx, args) {
    const { a, b } = (args || {}) as unknown as { a?: CompareSideInput; b?: CompareSideInput };
    if (!a || !b || !Array.isArray(a.features) || !Array.isArray(b.features)) throw ctx.fail("compare-versions needs two versions.");
    const k = ctx.k, oc = ctx.oc as any, t0 = Date.now();
    const scope = k.scope;                       // the worker's list for this call: the engines replace it while they run
    const made: { delete(): void }[] = [];
    const keep = <T extends { delete(): void }>(o: T): T => { made.push(o); return o; };
    const ea = new RegenEngine(k, FEATURES), eb = new RegenEngine(k, FEATURES);
    try {
      const same = stableJson(a as unknown as Json) === stableJson(b as unknown as Json);
      const ra = await ea.regenerate(a.features, a.rollback);
      const rb = same ? ra : await eb.regenerate(b.features, b.rollback);
      k.scope = scope;
      const sideB = same ? ea : eb;
      /** every body of a version as one shape (null when it has none) */
      const whole = (engine: RegenEngine): Shape | null => {
        // the parts, not what is only there to be referred to: a board shown in the studio is not part of a version
        const bodies = engine.state.bodies.filter((body) => !body.reference);
        if (!bodies.length) return null;
        if (bodies.length === 1) return bodies[0].shape;
        return compound(k, bodies.map((body) => body.shape), keep);
      };
      const boolean = (op: "cut" | "common", x: Shape, y: Shape): Shape => {
        const range = new oc.Message_ProgressRange();
        const algo = keep(new (op === "cut" ? oc.BRepAlgoAPI_Cut : oc.BRepAlgoAPI_Common)(x, y, range));
        range.delete();
        algo.Build();
        if (!algo.IsDone() || algo.HasErrors()) throw ctx.fail("The two versions could not be compared solid against solid.");
        return keep(algo.Shape());
      };
      const A = whole(ea), B = whole(sideB);
      const volume = (s: Shape | null): number => (s ? Math.max(0, k.volume(s)) : 0);
      const va = volume(A), vb = volume(B);
      let common: Shape | null = null, added: Shape | null = null, removed: Shape | null = null;
      if (A && B && same) common = A;
      else if (A && B) { common = boolean("common", A, B); added = boolean("cut", B, A); removed = boolean("cut", A, B); }
      else { added = B; removed = A; }
      // a sliver of numerical noise is not a difference
      const eps = 1e-7 * Math.max(1, va, vb);
      const part = (s: Shape | null): { mesh: PlainMesh | null; volume: number } => { const v = volume(s); return s && v > eps ? { mesh: meshOf(k, s), volume: v } : { mesh: null, volume: 0 }; };
      const c = part(common), ad = part(added), rm = part(removed);
      const result: CompareResult = {
        a: { reports: ra.features, bodies: ea.state.bodies.length, volume: va }, b: { reports: rb.features, bodies: sideB.state.bodies.length, volume: vb },
        common: c.mesh, added: ad.mesh, removed: rm.mesh, volumes: { common: c.volume, added: ad.volume, removed: rm.volume }, ms: Date.now() - t0,
      };
      return result as unknown as Json;
    } finally {
      k.scope = scope;
      for (const o of made.reverse()) { try { o.delete(); } catch (x) { /* already gone */ } }
      ea.dispose(); eb.dispose();
    }
  },
});
