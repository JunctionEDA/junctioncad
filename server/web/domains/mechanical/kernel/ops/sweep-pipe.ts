// sweep-pipe.ts — one closed sketch region swept along a path, with its faces named.
//
// A smooth path goes through MakePipe, which sweeps the region's face in one go.  A path with sharp corners (a
// polyline drawn with the line tool) makes MakePipe fail, so it falls back to MakePipeShell, which sweeps each
// loop of the region with a transition at every corner (rounded or mitred) and closes it into a solid; holes
// are then cut from the outer loop's solid.  Faces: `<id>:start:<region>`, `<id>:end:<region>`, and
// `<id>:side:<entity>` for what each profile curve swept (`~2`, `~3` past each corner).
import { length, sub, type Vec3 } from "../../core/geometry";
import { ShapeIndex, type NamedResult } from "../occ";
import type { EvalContext, NamedShape, Shape, SketchRegion } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const solidOk = (ctx: EvalContext, s: Shape | null) => !!s && !s.IsNull() && ctx.k.volume(s) > 1e-9;

export function sweepRegion(ctx: EvalContext, spine: Shape, r: SketchRegion, corners: "round" | "sharp"): NamedResult {
  const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
  const named = new ShapeIndex<string>(k);
  const sideNames = (history: any) => { for (const e of r.edges) for (const side of k.list(history.Generated(e.edge))) if (!named.has(side)) named.add(side, `${id}:side:${e.entity}`); };

  // smooth paths: one pipe of the whole face
  let pipe: any = null;
  try {
    pipe = ctx.tmp(new oc.BRepOffsetAPI_MakePipe(oc.TopoDS.Wire(spine), r.face));
    pipe.Build(ctx.tmp(new oc.Message_ProgressRange()));
  } catch (e) { pipe = null; }
  if (pipe && pipe.IsDone()) {
    const shape = ctx.own(pipe.Shape());
    if (solidOk(ctx, shape)) {
      named.add(ctx.own(pipe.FirstShape()), `${id}:start:${r.id}`);
      named.add(ctx.own(pipe.LastShape()), `${id}:end:${r.id}`);
      sideNames(pipe);
      return { shape, names: (f) => named.get(f) ?? null };
    }
  }

  // paths with corners: each loop on its own, with a transition at the corners
  const mode = corners === "sharp" ? oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner : oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner;
  const outer = oc.BRepTools.OuterWire(r.face);
  const loops = k.sub(r.face, "wire");
  const sweepLoop = (wire: Shape): Shape => {
    const ps = ctx.tmp(new oc.BRepOffsetAPI_MakePipeShell(oc.TopoDS.Wire(spine)));
    ps.SetMode(false);
    ps.SetTransitionMode(mode);
    ps.Add(wire, false, false);
    ps.Build(ctx.tmp(new oc.Message_ProgressRange()));
    if (!ps.IsDone() || !ps.MakeSolid()) throw ctx.fail("The profile could not be swept along the path. Try a smaller profile, or round the path's corners.");
    sideNames(ps);
    let s = ctx.own(ps.Shape());
    if (k.volume(s) < 0) { const rev = ctx.own(s.Reversed()); s = rev; }
    return s;
  };
  let shape = sweepLoop(outer);
  if (!solidOk(ctx, shape)) throw ctx.fail("The sweep has no volume. Put the profile across the start of the path.");
  // the two caps: the faces nobody named, the one nearer the path's start is the start
  const ends = pathEnds(ctx, spine);
  const capNames = (s: Shape) => {
    for (const f of k.sub(s, "face")) {
      if (named.has(f)) continue;
      const c = k.centre(f, "face");
      named.add(f, length(sub(c, ends[0])) <= length(sub(c, ends[1])) ? `${id}:start:${r.id}` : `${id}:end:${r.id}`);
    }
  };
  capNames(shape);
  let current: NamedResult = { shape, names: (f) => named.get(f) ?? null };
  for (const hole of loops.filter((w) => !w.IsSame(outer))) {
    const tool = sweepLoop(hole);
    const toolFaces: NamedShape[] = k.sub(tool, "face").map((f, i) => ({ name: named.get(f) ?? `${id}:hole#${i + 1}`, shape: f }));
    current = k.boolean("cut", { shape: current.shape, faces: k.namedFaces(current.shape, current.names, id) }, { shape: tool, faces: toolFaces }, id, ctx.own);
  }
  return current;
}

function pathEnds(ctx: EvalContext, spine: Shape): [Vec3, Vec3] {
  const oc = ctx.oc as any, k = ctx.k;
  const ad = ctx.tmp(new oc.BRepAdaptor_CompCurve(oc.TopoDS.Wire(spine), true));
  const a = ad.Value(ad.FirstParameter()), b = ad.Value(ad.LastParameter());
  const out: [Vec3, Vec3] = [k.xyz(a), k.xyz(b)]; a.delete(); b.delete();
  return out;
}
