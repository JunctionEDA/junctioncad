// thick.ts — hollow a solid into a wall of constant thickness (BRepOffsetAPI_MakeThickSolid), with some faces
// removed to open it.  Used by Shell, and by Extrude's thin option (a prism with both caps removed is a wall
// along the sketch's outline).
//
// Names: the faces the solid had keep their names; each face of the new wall is `<feature>:from(<the face it
// was offset from>)`; an opening's rim keeps the name of the face that was removed there.
import type { Kernel, Keep, NamedResult } from "../occ";
import { FeatureError, type NamedShape, type Shape } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/**
 * `offset` < 0 puts the wall inside the solid's faces, > 0 outside.  `open` are faces of `shape` to remove.
 */
export function thickWall(k: Kernel, shape: Shape, named: readonly NamedShape[], open: readonly Shape[], offset: number, featureId: string, keep: Keep): NamedResult {
  const oc = k.oc as Any;
  if (!(Math.abs(offset) > 1e-7)) throw new FeatureError("The wall must be thicker than zero.");
  if (!open.length) return closedWall(k, shape, named, offset, featureId, keep);
  const list = keep(new oc.NCollection_List_TopoDS_Shape());
  for (const f of open) list.Append(f);
  const mk = keep(new oc.BRepOffsetAPI_MakeThickSolid());
  const range = keep(new oc.Message_ProgressRange());
  try {
    mk.MakeThickSolidByJoin(shape, list, offset, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, true, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false, range);
    mk.Build(range);
  } catch (e) {
    throw new FeatureError(`The wall could not be made: ${k.describe(e)}. Try a thinner wall.`);
  }
  if (!mk.IsDone()) throw new FeatureError("The wall could not be made. Try a thinner wall, or remove fewer faces.");
  const out: Shape = keep(mk.Shape());
  const solids = k.solids(out);
  if (!solids.length) throw new FeatureError("The wall could not be made. Try a thinner wall.");
  const was = k.volume(shape), now = k.volume(solids.length === 1 ? solids[0] : out);
  if (!(now > 0) || (offset < 0 && now >= was - 1e-9)) throw new FeatureError("The wall could not be made: the result is empty. Try a thinner wall.");
  return { shape: solids.length === 1 ? solids[0] : out, names: k.carryNames(out, mk, named, featureId) };
}

/** A hollow with no opening: the solid less its own offset (inward), or its offset less itself (outward). */
function closedWall(k: Kernel, shape: Shape, named: readonly NamedShape[], offset: number, featureId: string, keep: Keep): NamedResult {
  const oc = k.oc as Any;
  const mk = keep(new oc.BRepOffsetAPI_MakeOffsetShape());
  const range = keep(new oc.Message_ProgressRange());
  try {
    mk.PerformByJoin(shape, offset, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, true, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false, range);
  } catch (e) {
    throw new FeatureError(`The wall could not be made: ${k.describe(e)}. Try a thinner wall.`);
  }
  if (!mk.IsDone()) throw new FeatureError("The wall could not be made. Try a thinner wall.");
  const off: Shape = keep(mk.Shape());
  // the offset faces are the new wall: `<feature>:from(<face>)`
  const carried = k.carryNames(off, mk, named, featureId);
  const offFaces = k.namedFaces(off, (f, i) => { const n = carried(f, i); return n && !n.startsWith(`${featureId}:`) ? `${featureId}:from(${n})` : n; }, featureId);
  const r = offset < 0
    ? k.boolean("cut", { shape, faces: named }, { shape: off, faces: offFaces }, featureId, keep)
    : k.boolean("cut", { shape: off, faces: offFaces }, { shape, faces: named }, featureId, keep);
  const solids = k.solids(r.shape);
  if (solids.length !== 1) throw new FeatureError("The wall could not be made. Try a thinner wall.");
  return { shape: solids[0], names: r.names };
}
