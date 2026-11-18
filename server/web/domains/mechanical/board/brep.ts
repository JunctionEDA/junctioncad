// brep.ts — a board snapshot as solids: the laminate with its cut-outs and holes, and a box or cylinder for each
// part that stands tall enough to matter.  Worker side; called by features/board-reference.ts.
//
// Every face gets a name made from what it is on the board, never from where it is or in which order it was
// built, so a reference to "the wall of H2's hole" or "the side of J1 that faces the edge" survives the board
// being edited (README.md lists the names).
import type { Frame, Vec3 } from "../core/geometry";
import { ShapeIndex } from "../kernel/occ";
import type { EvalContext, FaceNamer, Shape } from "../kernel/types";
import { SIDE_NAMES, type BoardSnapshot, type Pt, type SnapSeg } from "./snapshot";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BoardSolids {
  /** the laminate: one solid per closed outline, as one shape; null when the snapshot has no outline */
  board: { shape: Shape; names: FaceNamer } | null;
  /** the parts' envelopes as one shape; null when there are none */
  parts: { shape: Shape; names: FaceNamer; count: number } | null;
}

/** Signed area of a loop from its corner points (arcs by their end and middle points): positive when counter-clockwise. */
function loopArea(loop: readonly SnapSeg[]): number {
  const pts: Pt[] = [];
  for (const s of loop) { if (s.k === "c") return 1; pts.push(s.a); if (s.k === "a") pts.push(s.m); }
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}
/** The same loop run the other way. */
function reversed(loop: readonly SnapSeg[]): SnapSeg[] {
  return loop.slice().reverse().map((s) => (s.k === "c" ? s : { ...s, a: s.b, b: s.a }));
}
const ccw = (loop: readonly SnapSeg[]): readonly SnapSeg[] => (loopArea(loop) < 0 ? reversed(loop) : loop);

/**
 * Build the solids of `snap` placed by `frame`: a board point (x, y) at height z above the back face is
 * frame.origin + x·frame.x + y·frame.y + z·frame.normal.  Face names start with `prefix` (the feature's id).
 */
export function buildBoard(ctx: EvalContext, snap: BoardSnapshot, frame: Frame, prefix: string): BoardSolids {
  const oc = ctx.oc as any, k = ctx.k;
  const at = (p: Pt, z: number): Vec3 => [
    frame.origin[0] + p[0] * frame.x[0] + p[1] * frame.y[0] + z * frame.normal[0],
    frame.origin[1] + p[0] * frame.x[1] + p[1] * frame.y[1] + z * frame.normal[1],
    frame.origin[2] + p[0] * frame.x[2] + p[1] * frame.y[2] + z * frame.normal[2],
  ];
  const pnt = (p: Pt, z: number) => ctx.tmp(k.pnt(at(p, z)));
  const normal = ctx.tmp(k.dir(frame.normal)), xdir = ctx.tmp(k.dir(frame.x));
  const planeAt = (z: number) => ctx.tmp(new oc.gp_Pln(ctx.tmp(new oc.gp_Ax3(pnt([0, 0], z), normal, xdir))));
  const names = new ShapeIndex<string>(k);

  // one kernel edge for a piece of a loop, at height z
  const edgeOf = (s: SnapSeg, z: number): any => {
    if (s.k === "l") return ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(pnt(s.a, z), pnt(s.b, z))).Edge());
    if (s.k === "c") return ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(new oc.gp_Circ(ctx.tmp(new oc.gp_Ax2(pnt(s.c, z), normal, xdir)), s.r)))).Edge());
    const arc = ctx.tmp(new oc.GC_MakeArcOfCircle(pnt(s.a, z), pnt(s.m, z), pnt(s.b, z)));
    if (!arc.IsDone()) return ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(pnt(s.a, z), pnt(s.b, z))).Edge());   // three points in a line
    return ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(arc.Value()))).Edge());
  };
  // a closed wire, and each of its edges as the wire holds it (what the prism's history speaks of) with its name
  const wireOf = (loop: readonly SnapSeg[], z: number, sides: { edge: any; name: string }[], name: (s: SnapSeg, i: number) => string): any => {
    const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
    loop.forEach((s, i) => {
      mw.Add(edgeOf(s, z));
      if (!mw.IsDone()) throw ctx.fail("The board outline could not be closed into a solid. Check the Edge.Cuts layer of the board.");
      sides.push({ edge: ctx.tmp(mw.Edge()), name: name(s, i) });
    });
    return ctx.tmp(mw.Wire());
  };
  // sweep a face along the normal and name what comes out
  const sweep = (face: any, height: number, sides: { edge: any; name: string }[], first: string, last: string): Shape => {
    const v = ctx.tmp(k.vec([frame.normal[0] * height, frame.normal[1] * height, frame.normal[2] * height]));
    const prism = ctx.tmp(new oc.BRepPrimAPI_MakePrism(face, v, false, true));
    prism.Build();
    if (!prism.IsDone()) throw ctx.fail("A solid of the board could not be built.");
    names.add(ctx.tmp(prism.FirstShape()), first);
    names.add(ctx.tmp(prism.LastShape()), last);
    for (const s of sides) for (const f of k.list(prism.Generated(s.edge))) if (!names.has(f)) names.add(f, s.name);
    return prism.Shape();
  };
  // several solids become one shape; the body the feature adds owns it
  const compound = (shapes: Shape[]): Shape => {
    if (shapes.length === 1) return shapes[0];
    const b = ctx.tmp(new oc.TopoDS_Builder()), c = new oc.TopoDS_Compound();
    b.MakeCompound(c);
    for (const s of shapes) { b.Add(c, s); ctx.tmp(s); }
    return c;
  };
  const namer: FaceNamer = (f) => names.get(f) ?? null;

  // ---- the laminate
  const slabs: Shape[] = [];
  snap.outlines.forEach((ol, oi) => {
    const sides: { edge: any; name: string }[] = [];
    const tag = oi ? `:${oi + 1}` : "";
    const mf = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(planeAt(0), wireOf(ccw(ol.outer), 0, sides, (s) => `${prefix}:edge:${s.n}`), true));
    for (const cut of ol.cuts) mf.Add(oc.TopoDS.Wire(ctx.tmp(wireOf(ccw(cut), 0, sides, (s) => `${prefix}:edge:${s.n}`).Reversed())));
    for (const h of snap.holes) {
      if (h.outline !== oi) continue;
      let loop: SnapSeg[];
      if (h.slot) {
        // a stadium: two straight sides and two half circles
        const long = Math.max(h.slot.w, h.slot.h), r = Math.min(h.slot.w, h.slot.h) / 2, d = (long - 2 * r) / 2;
        // the long axis as viewer3d/outline.ts ovalPoints turns it (in the document, Y down), seen in the board's Y-up frame
        const a = (h.slot.rot * Math.PI) / 180;
        const [ux, uy] = h.slot.w > h.slot.h ? [Math.cos(a), Math.sin(a)] : [Math.sin(a), -Math.cos(a)];
        const px = -uy, py = ux;
        const P = (u: number, v: number): Pt => [h.x + u * ux + v * px, h.y + u * uy + v * py];
        loop = [
          { k: "l", n: "a", a: P(-d, -r), b: P(d, -r) },
          { k: "a", n: "b", a: P(d, -r), m: P(d + r, 0), b: P(d, r) },
          { k: "l", n: "c", a: P(d, r), b: P(-d, r) },
          { k: "a", n: "d", a: P(-d, r), m: P(-d - r, 0), b: P(-d, -r) },
        ];
      } else loop = [{ k: "c", n: "", c: [h.x, h.y], r: h.d / 2 }];
      mf.Add(oc.TopoDS.Wire(ctx.tmp(wireOf(ccw(loop), 0, sides, (s) => `${prefix}:hole:${h.n}${s.n ? ":" + s.n : ""}`).Reversed())));
    }
    if (!mf.IsDone()) throw ctx.fail("The board outline could not be made into a face. Check the Edge.Cuts layer of the board.");
    slabs.push(sweep(ctx.tmp(mf.Face()), snap.thickness, sides, `${prefix}:back${tag}`, `${prefix}:front${tag}`));
  });

  // ---- the parts
  const boxes: Shape[] = [];
  for (const p of snap.parts) {
    if (!(p.h > 0)) continue;
    const z = p.back ? 0 : snap.thickness, height = p.back ? -p.h : p.h;
    const sides: { edge: any; name: string }[] = [];
    let loop: SnapSeg[];
    if (p.round) loop = [{ k: "c", n: "side", c: [p.round.x, p.round.y], r: p.round.r }];
    else {
      if (p.pts.length !== 4) continue;
      loop = p.pts.map((a, i): SnapSeg => ({ k: "l", n: SIDE_NAMES[i], a, b: p.pts[(i + 1) % 4] }));
    }
    const wire = wireOf(ccw(loop), z, sides, (s) => `${prefix}:part:${p.n}:${s.n}`);
    const mf = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(planeAt(z), wire, true));
    if (!mf.IsDone()) continue;
    boxes.push(sweep(ctx.tmp(mf.Face()), height, sides, `${prefix}:part:${p.n}:base`, `${prefix}:part:${p.n}:top`));
  }

  return {
    board: slabs.length ? { shape: compound(slabs), names: namer } : null,
    parts: boxes.length ? { shape: compound(boxes), names: namer, count: boxes.length } : null,
  };
}
