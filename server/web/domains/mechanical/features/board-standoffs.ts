// board-standoffs.ts — the Standoffs feature: a post under each picked hole of a board, from the board's back
// face down, with a bore for the screw.
//
// Pick the walls of the board's mounting holes (faces of a Board feature's board body, named after the footprint
// and pad: `…:hole:H1`).  Each post is coaxial with its hole, so when the hole is moved on the board the post
// moves with it; a hole that is deleted fails the feature with the usual "no longer exists".
import { defineFeature } from "../core/feature";
import type { GeomRef, Vec3 } from "../core/geometry";
import { ShapeIndex } from "../kernel/occ";
import type { Body, EvalContext, NamedShape } from "../kernel/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BoardStandoffsParams {
  [key: string]: any;
  /** the walls of the holes */
  holes: GeomRef[];
  height: number;
  /** outer diameter of a post */
  diameter: number;
  /** diameter of the screw bore; 0 for a solid post */
  bore: number;
  /** "new": each post is a body; "add": posts join the bodies they touch */
  operation: "new" | "add";
}

export default defineFeature<BoardStandoffsParams>({
  type: "board-standoffs",
  title: "Standoffs",
  icon: '<path d="M3 7h18"/><path d="M7 7v10h3V7"/><path d="M14 7v10h3V7"/><path d="M4 17h16"/>',
  toolbarOrder: 17,
  toolbarSection: "board", toolbarMenu: "Board",
  defaults: () => ({ holes: [], height: 5, diameter: 6, bore: 2.5, operation: "new" }),
  schema: [
    { key: "holes", label: "Holes", kind: "refs", of: ["face"], hint: "The walls of the board's mounting holes." },
    { key: "height", label: "Height", kind: "number", unit: "mm", min: 0.001, step: 1 },
    { key: "diameter", label: "Diameter", kind: "number", unit: "mm", min: 0.001, step: 0.5 },
    { key: "bore", label: "Bore", kind: "number", unit: "mm", min: 0, step: 0.1, hint: "The screw hole down the middle; 0 for none." },
    { key: "operation", label: "Result", kind: "enum", options: [{ value: "new", label: "New" }, { value: "add", label: "Add" }] },
  ],

  evaluate(ctx: EvalContext, p: BoardStandoffsParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const refs = Array.isArray(p.holes) ? p.holes : [];
    if (!refs.length) throw ctx.fail("Pick the holes to put standoffs under.");
    if (!(p.height > 0) || !(p.diameter > 0)) throw ctx.fail("The height and the diameter must be more than zero.");
    const bore = Math.max(0, Number(p.bore) || 0);
    if (bore >= p.diameter) throw ctx.fail("The bore must be narrower than the post.");

    const posts: { shape: any; faces: NamedShape[]; key: string }[] = [];
    for (const ref of refs) {
      const r = ctx.resolve(ref);
      if (r.kind !== "face") throw ctx.fail("Pick the wall of a hole.");
      const ad = ctx.tmp(new oc.BRepAdaptor_Surface(r.shape, true));
      if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) throw ctx.fail("A standoff needs a round hole: pick the wall of one.");
      const cyl = ctx.tmp(ad.Cylinder()), axis = ctx.tmp(cyl.Axis()), loc = ctx.tmp(axis.Location()), dirO = ctx.tmp(axis.Direction());
      const c = k.xyz(loc), d = k.xyz(dirO);
      // down means out of the board's back face, which the board body names
      const backFace = r.body.topo.faces.find((f) => f.name === `${r.body.createdBy}:back`);
      const bf = backFace ? k.faceFrame(backFace.shape as any) : null;
      if (!bf) throw ctx.fail("Pick the wall of a hole of a board (a Board feature's body).");
      const n = bf.normal;
      // the point of the hole's axis on the back face
      const t = ((bf.origin[0] - c[0]) * n[0] + (bf.origin[1] - c[1]) * n[1] + (bf.origin[2] - c[2]) * n[2]) / (d[0] * n[0] + d[1] * n[1] + d[2] * n[2] || 1);
      const base: Vec3 = [c[0] + d[0] * t, c[1] + d[1] * t, c[2] + d[2] * t];
      const ax = ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt(base)), ctx.tmp(k.dir(n)), ctx.tmp(k.dir(bf.x))));
      const pln = ctx.tmp(new oc.gp_Pln(ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(base)), ctx.tmp(k.dir(n)), ctx.tmp(k.dir(bf.x))))));
      const ring = (radius: number): { wire: any; edge: any } => {
        const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
        mw.Add(ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(new oc.gp_Circ(ax, radius)))).Edge()));
        return { wire: ctx.tmp(mw.Wire()), edge: ctx.tmp(mw.Edge()) };
      };
      const outer = ring(p.diameter / 2);
      const mf = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(pln, outer.wire, true));
      const inner = bore > 0 ? ring(bore / 2) : null;
      if (inner) mf.Add(oc.TopoDS.Wire(ctx.tmp(inner.wire.Reversed())));
      if (!mf.IsDone()) throw ctx.fail("A standoff could not be built.");
      const prism = ctx.own(new oc.BRepPrimAPI_MakePrism(ctx.tmp(mf.Face()), ctx.tmp(k.vec([n[0] * p.height, n[1] * p.height, n[2] * p.height])), false, true));
      prism.Build();
      if (!prism.IsDone()) throw ctx.fail("A standoff could not be built.");
      const shape = prism.Shape();
      // named after the hole, so a post keeps its faces' names whichever order the holes were picked in
      const key = `${id}:post(${r.name})`;
      const named = new ShapeIndex<string>(k);
      named.add(ctx.tmp(prism.FirstShape()), `${key}:top`);
      named.add(ctx.tmp(prism.LastShape()), `${key}:foot`);
      for (const f of k.list(prism.Generated(outer.edge))) named.add(f, `${key}:side`);
      if (inner) for (const f of k.list(prism.Generated(inner.edge))) named.add(f, `${key}:bore`);
      posts.push({ shape, faces: k.namedFaces(shape, (f) => named.get(f) ?? null, id), key: r.name });
    }

    const namerOf = (faces: NamedShape[]) => { const ix = new ShapeIndex<string>(k); for (const f of faces) ix.add(f.shape, f.name); return (f: any) => ix.get(f) ?? null; };
    for (const post of posts) {
      let host: Body | null = null;
      if (p.operation === "add") {
        for (const body of ctx.bodies()) {
          const res = host
            ? k.boolean("fuse", { shape: host.shape, faces: host.topo.faces }, { shape: body.shape, faces: body.topo.faces }, id, ctx.own)
            : k.boolean("fuse", { shape: body.shape, faces: body.topo.faces }, { shape: post.shape, faces: post.faces }, id, ctx.own);
          const solids = k.solids(res.shape);
          if (solids.length !== 1) continue;   // they do not touch
          if (host) { ctx.removeBody(body); host = ctx.replaceBody(host, solids[0], res.names); }
          else host = ctx.replaceBody(body, solids[0], res.names);
        }
      }
      if (host) ctx.tmp(post.shape);
      else ctx.addBody(post.shape, namerOf(post.faces), { suffix: post.key, name: "Standoff" });
    }
  },
});
