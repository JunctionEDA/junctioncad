// ref-geometry.ts — the "ref-geometry" service: what named faces, edges and vertices looked like just BEFORE a
// feature was built.
//
// A feature consumes what it is given: the edge a fillet rounds is not an edge of the model after it.  While
// that fillet's dialog is open its edges must still be drawn as chosen (and be there to click, to take one
// out), so the page asks for them as they were:
//
//   await kernel.call("ref-geometry", { feature: "<feature id>", refs: [{ kind, body, name }, …] })
//   → { items: [{ kind, body, name, segments?: number[], triangles?: number[], at?: [x, y, z] }] }
//
// `segments` are point pairs (an edge), `triangles` point triples (a face).  A reference that was not there
// before the feature either is left out.
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { defineService } from "../kernel/service";
import { tessellate } from "../kernel/tessellate";
import type { Body } from "../kernel/types";
import type { BodyMesh } from "../kernel/protocol";

interface Ref { kind: "face" | "edge" | "vertex"; body: string; name: string }

export default defineService({
  name: "ref-geometry",
  run(ctx, args) {
    const a = (args || {}) as unknown as { feature?: string; refs?: Ref[] };
    const state = a.feature && ctx.before ? ctx.before(a.feature) : null;
    const items: Json[] = [];
    if (!state || !Array.isArray(a.refs)) return { items };
    const meshes = new Map<string, BodyMesh>();
    const meshOf = (b: Body): BodyMesh => { let m = meshes.get(b.id); if (!m) { m = tessellate(ctx.k, b); meshes.set(b.id, m); } return m; };
    for (const ref of a.refs) {
      // in its own body first, then in any (a body merged into another keeps its faces' names), as ctx.resolve does
      const home = state.bodies.find((b) => b.id === ref.body);
      for (const b of home ? [home, ...state.bodies.filter((x) => x !== home)] : state.bodies) {
        const m = meshOf(b);
        if (ref.kind === "edge") {
          const i = m.edges.names.indexOf(ref.name); if (i < 0) continue;
          items.push({ kind: ref.kind, body: ref.body, name: ref.name, segments: Array.from(m.edges.positions.subarray(m.edges.start[i] * 3, (m.edges.start[i] + m.edges.count[i]) * 3)) });
        } else if (ref.kind === "face") {
          const i = m.faces.names.indexOf(ref.name); if (i < 0) continue;
          const t: number[] = [];
          for (let k = m.faces.start[i]; k < m.faces.start[i] + m.faces.count[i]; k++) { const at = m.indices[k] * 3; t.push(m.positions[at], m.positions[at + 1], m.positions[at + 2]); }
          items.push({ kind: ref.kind, body: ref.body, name: ref.name, triangles: t });
        } else {
          const i = m.vertices.names.indexOf(ref.name); if (i < 0) continue;
          items.push({ kind: ref.kind, body: ref.body, name: ref.name, at: [m.vertices.positions[i * 3], m.vertices.positions[i * 3 + 1], m.vertices.positions[i * 3 + 2]] });
        }
        break;
      }
    }
    return { items };
  },
});
