// board-cutout.ts — the Opening feature: cut a rectangular opening through the bodies in front of a flat face.
//
// Made for "the enclosure wall needs a hole where the USB connector is": pick the face of the connector's
// envelope that looks at the wall (a face of a Board feature's parts body), give the clearance around it and how
// far to cut.  The opening is the face's own extent grown by the clearance, swept straight out of the face.  As
// the reference is by name (`…:part:J1:y+`), the opening follows the connector when the board is edited.
// It works on any flat face, not only a board's.
import type { TopoDS_Face } from "replicad-opencascadejs";
import { defineFeature } from "../core/feature";
import { toPlane, toWorld, type GeomRef, type Vec2, type Vec3 } from "../core/geometry";
import { ShapeIndex } from "../kernel/occ";
import type { Body, EvalContext, NamedShape } from "../kernel/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BoardCutoutParams {
  [key: string]: any;
  /** the flat face the opening is in front of */
  face: GeomRef | null;
  /** how much wider than the face the opening is, on every side */
  clearance: number;
  /** how far the cut reaches out of the face */
  depth: number;
  /** how far it starts behind the face, so a wall that touches the face is cut cleanly */
  back: number;
  /** the bodies to cut; empty means every body (reference bodies are never cut) */
  targets: string[];
}

export default defineFeature<BoardCutoutParams>({
  type: "board-cutout",
  title: "Opening",
  icon: '<path d="M4 5h16v14H4z"/><rect x="9" y="10" width="6" height="4" rx="0.5"/>',
  toolbarOrder: 16,
  toolbarSection: "board", toolbarMenu: "Board",
  defaults: () => ({ face: null, clearance: 0.5, depth: 10, back: 1, targets: [] }),
  schema: [
    { key: "face", label: "In front of", kind: "refs", of: ["face"], single: true, hint: "A flat face: the side of a connector that looks at the wall." },
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", min: 0, step: 0.1 },
    { key: "depth", label: "Reach", kind: "number", unit: "mm", min: 0.001, step: 1, hint: "How far out of the face the cut goes." },
    { key: "back", label: "Start behind", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "Start the cut this far behind the face, for a part that reaches into the wall." },
    { key: "targets", label: "Bodies to cut", kind: "bodies", hint: "Leave empty for every body." },
  ],

  evaluate(ctx: EvalContext, p: BoardCutoutParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    if (!p.face) throw ctx.fail("Pick the flat face the opening is in front of.");
    if (!(p.depth > 0)) throw ctx.fail("The reach must be more than zero.");
    const clearance = Math.max(0, Number(p.clearance) || 0), back = Math.max(0, Number(p.back) || 0);
    const r = ctx.resolve(p.face);
    if (r.kind !== "face") throw ctx.fail("Pick a face.");
    const frame = k.faceFrame(r.shape as TopoDS_Face);
    if (!frame) throw ctx.fail("The opening needs a flat face. Pick a planar one.");

    // the face's extent in its own plane: its corners, or its bounding box when it has none (a disc)
    let pts: Vec2[] = k.sub(r.shape, "vertex").map((v) => toPlane(frame, k.vertexPoint(v)));
    if (pts.length < 3) {
      const box = ctx.tmp(new oc.Bnd_Box());
      oc.BRepBndLib.Add(r.shape, box, false);
      const lo = ctx.tmp(box.CornerMin()), hi = ctx.tmp(box.CornerMax());
      const a = k.xyz(lo), b = k.xyz(hi);
      pts = [];
      for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) pts.push(toPlane(frame, [x, y, z]));
    }
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const q of pts) { u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); v0 = Math.min(v0, q[1]); v1 = Math.max(v1, q[1]); }
    u0 -= clearance; v0 -= clearance; u1 += clearance; v1 += clearance;
    if (!(u1 - u0 > 1e-6) || !(v1 - v0 > 1e-6)) throw ctx.fail("The face is too small to make an opening from.");

    // the tool: that rectangle, from `back` behind the face to `depth` in front of it
    const n = frame.normal;
    const at = (u: number, v: number): Vec3 => { const w = toWorld(frame, [u, v]); return [w[0] - n[0] * back, w[1] - n[1] * back, w[2] - n[2] * back]; };
    const corners = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
    const sideNames = ["v-", "u+", "v+", "u-"];
    const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
    const sides: { edge: any; name: string }[] = [];
    corners.forEach((c, i) => {
      const e = ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(k.pnt(c)), ctx.tmp(k.pnt(corners[(i + 1) % 4])))).Edge());
      mw.Add(e);
      sides.push({ edge: ctx.tmp(mw.Edge()), name: `${id}:side:${sideNames[i]}` });
    });
    const pln = ctx.tmp(new oc.gp_Pln(ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(corners[0])), ctx.tmp(k.dir(n)), ctx.tmp(k.dir(frame.x))))));
    const mf = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(pln, ctx.tmp(mw.Wire()), true));
    if (!mf.IsDone()) throw ctx.fail("The opening could not be built.");
    const len = back + p.depth;
    const prism = ctx.own(new oc.BRepPrimAPI_MakePrism(ctx.tmp(mf.Face()), ctx.tmp(k.vec([n[0] * len, n[1] * len, n[2] * len])), false, true));
    prism.Build();
    if (!prism.IsDone()) throw ctx.fail("The opening could not be built.");
    const tool = ctx.own(prism.Shape());
    const named = new ShapeIndex<string>(k);
    named.add(ctx.tmp(prism.FirstShape()), `${id}:start`);
    named.add(ctx.tmp(prism.LastShape()), `${id}:end`);
    for (const s of sides) for (const f of k.list(prism.Generated(s.edge))) if (!named.has(f)) named.add(f, s.name);
    const toolFaces: NamedShape[] = k.namedFaces(tool, (f) => named.get(f) ?? null, id);

    const wanted = Array.isArray(p.targets) ? p.targets : [];
    const targets: Body[] = wanted.length ? wanted.map((b) => ctx.body(b)).filter((b): b is Body => !!b && !b.reference) : ctx.bodies().slice();
    if (!targets.length) throw ctx.fail("There is no body to cut the opening in.");
    let changed = false;
    for (const body of targets) {
      const res = k.boolean("cut", { shape: body.shape, faces: body.topo.faces }, { shape: tool, faces: toolFaces }, id, ctx.own);
      const was = k.volume(body.shape), now = k.volume(res.shape);
      if (Math.abs(was - now) <= 1e-9 * Math.max(1, was)) continue;   // the opening does not reach this body
      changed = true;
      const solids = k.solids(res.shape);
      if (!solids.length) { ctx.removeBody(body); continue; }
      ctx.replaceBody(body, solids[0], res.names);
      solids.slice(1).forEach((s, i) => ctx.addBody(s, res.names, { suffix: `${body.id}.piece${i + 2}`, name: `${body.name} (${i + 2})` }));
    }
    if (!changed) ctx.warn("Nothing was cut: the opening does not reach a body. Give it more reach.");
  },
});
