// measure-entities.ts — the "measure" service: exact quantities of the faces, edges, vertices and default planes
// a person picked, read from the B-rep (not the display mesh), and what two of them say together.
//
//   await kernel.call("measure", { items: [{ kind: "face", body, name }, { kind: "plane", plane: "top" }] })
//   → { items: EntityInfo[], pair?: PairInfo, totals: { area?, length? } }
//
// One thing: its own quantities (a vertex's position, an edge's length and radius, a face's area, perimeter and
// radius).  Two things: the shortest distance between them with where it is, centre to centre, the angle
// between their directions and the distance between parallel planes or axes.  Several faces or edges: the sum
// of their areas or lengths.
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { DEFAULT_PLANES, type DefaultPlaneId, type GeomRef } from "../core/geometry";
import { defineService } from "../kernel/service";
import type { Shape } from "../kernel/types";
import { resolveRef } from "../kernel/regen";
import { boxOf, measureEntity, minDistance, pairInfo, planeFace, type EntityInfo, type PairInfo } from "./_measure-kernel";

export type MeasureItem = GeomRef | { kind: "plane"; plane: DefaultPlaneId };
export interface MeasureResult { items: EntityInfo[]; pair?: PairInfo; totals: { area?: number; length?: number } }

export const MAX_ITEMS = 40;

export default defineService({
  name: "measure",
  run(ctx, args) {
    const items = ((args as { items?: MeasureItem[] } | null)?.items || []).slice(0, MAX_ITEMS);
    if (!items.length) return { items: [], totals: {} };
    const k = ctx.k;
    const made: Shape[] = [];
    try {
      // a default plane is a face as large as the model, so the distance to it is a distance to the plane
      let size = 1000;
      if (items.some((i) => i.kind === "plane")) for (const b of ctx.state.bodies) { const box = boxOf(k, b.shape); size = Math.max(size, 4 * Math.max(...box.map(Math.abs))); }
      const shapes: Shape[] = [];
      const infos: EntityInfo[] = items.map((it) => {
        if (it.kind === "plane") {
          const p = DEFAULT_PLANES[(it as { plane: DefaultPlaneId }).plane];
          if (!p) throw ctx.fail("That plane is not one of Top, Front or Right.");
          const f = planeFace(k, p.frame.origin, p.frame.normal, size); made.push(f); shapes.push(f);
          return { kind: "plane", surface: "plane", origin: p.frame.origin, normal: p.frame.normal, centroid: p.frame.origin } as EntityInfo;
        }
        let r;
        try { r = resolveRef(ctx.state, it as GeomRef); } catch (e) { throw ctx.fail("Something picked is no longer in the model. Pick it again."); }
        shapes.push(r.shape);
        return measureEntity(k, r.shape, r.kind);
      });
      const out: MeasureResult = { items: infos, totals: {} };
      if (infos.length === 2) out.pair = pairInfo(infos[0], infos[1], minDistance(k, shapes[0], shapes[1]));
      const faces = infos.filter((i) => i.kind === "face"), edges = infos.filter((i) => i.kind === "edge");
      if (faces.length > 1) out.totals.area = faces.reduce((s, f) => s + (f.area || 0), 0);
      if (edges.length > 1) out.totals.length = edges.reduce((s, e) => s + (e.length || 0), 0);
      return out as unknown as Json;
    } finally { for (const s of made) { try { s.delete(); } catch (e) { /* gone */ } } }
  },
});
