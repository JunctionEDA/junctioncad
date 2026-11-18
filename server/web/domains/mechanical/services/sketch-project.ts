// sketch-project.ts — what an edge or a vertex of the model looks like on a sketch plane, for the sketcher's
// "Use edge" tool: `await kernel.call("sketch-project", { refs: [GeomRef, …], frame })`.
//
// The answer is in sketch-plane coordinates, as the curves a sketch can hold:
//   { type: "point", p }                               a vertex
//   { type: "line", a, b }                             a straight edge (or a circle seen edge-on)
//   { type: "circle", c, r }                           a full circular edge that lies parallel to the plane
//   { type: "arc", c, s, e }                           part of one; counter-clockwise from s to e
// An edge that would project to anything else (an ellipse, a spline) is reported in `skipped` with the reason.
import { toPlane, type Frame, type GeomRef, type Vec2, type Vec3 } from "../core/geometry";
import { resolveRef } from "../kernel/regen";
import { defineService } from "../kernel/service";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Projected =
  | { type: "point"; p: Vec2; from: GeomRef }
  | { type: "line"; a: Vec2; b: Vec2; from: GeomRef }
  | { type: "circle"; c: Vec2; r: number; from: GeomRef }
  | { type: "arc"; c: Vec2; s: Vec2; e: Vec2; from: GeomRef };

export default defineService({
  name: "sketch-project",
  run(ctx, args) {
    const a = args as unknown as { refs?: GeomRef[]; frame?: Frame } | null;
    if (!a || !Array.isArray(a.refs) || !a.frame) throw ctx.fail("Nothing to project.");
    const oc = ctx.oc as any, k = ctx.k, frame = a.frame;
    const n = frame.normal;
    const flat = (p: Vec3): Vec2 => { const q = toPlane(frame, p); return [Math.round(q[0] * 1e9) / 1e9, Math.round(q[1] * 1e9) / 1e9]; };
    const curves: Projected[] = [], skipped: { ref: GeomRef; why: string }[] = [];
    for (const ref of a.refs) {
      let found;
      try { found = resolveRef(ctx.state, ref); } catch (e) { skipped.push({ ref, why: k.describe(e) }); continue; }
      if (found.kind === "vertex") { curves.push({ type: "point", p: flat(k.vertexPoint(found.shape)), from: ref }); continue; }
      if (found.kind !== "edge") { skipped.push({ ref, why: "Pick an edge or a vertex." }); continue; }
      const ad = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(found.shape));
      try {
        const t0 = ad.FirstParameter(), t1 = ad.LastParameter();
        const at = (t: number): Vec3 => { const p = ad.Value(t), v = k.xyz(p); p.delete(); return v; };
        const type = ad.GetType();
        const is = (name: string) => type === oc.GeomAbs_CurveType[name];   // this build's enums are strings
        if (is("GeomAbs_Line")) {
          const p = flat(at(t0)), q = flat(at(t1));
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-7) curves.push({ type: "point", p, from: ref });   // an edge square to the plane
          else curves.push({ type: "line", a: p, b: q, from: ref });
        } else if (is("GeomAbs_Circle")) {
          const circ = ad.Circle(), loc = circ.Location(), axis = circ.Axis(), dir = axis.Direction();
          const c = k.xyz(loc), d: Vec3 = [dir.X(), dir.Y(), dir.Z()], r = circ.Radius();
          loc.delete(); dir.delete(); axis.delete(); circ.delete();
          const along = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
          const full = Math.abs(t1 - t0) >= Math.PI * 2 - 1e-9;
          if (Math.abs(Math.abs(along) - 1) < 1e-9) {
            if (full) curves.push({ type: "circle", c: flat(c), r, from: ref });
            else { const s = flat(at(t0)), e = flat(at(t1)); curves.push(along > 0 ? { type: "arc", c: flat(c), s, e, from: ref } : { type: "arc", c: flat(c), s: e, e: s, from: ref }); }
          } else if (Math.abs(along) < 1e-9 && full) {
            // seen edge-on: the diameter that lies in the plane's direction
            const t: Vec3 = [n[1] * d[2] - n[2] * d[1], n[2] * d[0] - n[0] * d[2], n[0] * d[1] - n[1] * d[0]];
            curves.push({ type: "line", a: flat([c[0] - t[0] * r, c[1] - t[1] * r, c[2] - t[2] * r]), b: flat([c[0] + t[0] * r, c[1] + t[1] * r, c[2] + t[2] * r]), from: ref });
          } else skipped.push({ ref, why: "That circular edge is tilted to the sketch plane; it would project to an ellipse, which sketches do not hold yet." });
        } else skipped.push({ ref, why: "Only straight and circular edges can be used in a sketch yet." });
      } finally { ad.delete(); }
    }
    return { curves, skipped } as any;
  },
});
