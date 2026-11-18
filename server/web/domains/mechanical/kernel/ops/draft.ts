// draft.ts — tilt faces of a solid by an angle about a neutral plane (BRepOffsetAPI_DraftAngle), keeping the
// names of every face.  Used by the Draft feature and by Extrude's draft option.
import type { Vec3 } from "../../core/geometry";
import type { Kernel, Keep, NamedResult } from "../occ";
import { FeatureError, type NamedShape, type Shape } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/**
 * Draft `faces` of `shape` (whose faces are `named`): each turns by `angle` degrees about its line on the
 * neutral plane.  With a positive angle the solid narrows on the side of the neutral plane `pull` points to
 * (a box drafted with pull +Z about its base gets smaller toward the top), as a moulded part releases.
 */
export function draftFaces(k: Kernel, shape: Shape, named: readonly NamedShape[], faces: readonly Shape[], pull: Vec3, angle: number, neutral: { origin: Vec3; normal: Vec3 }, featureId: string, keep: Keep): NamedResult {
  const oc = k.oc as Any;
  if (!faces.length) throw new FeatureError("Pick the faces to draft.");
  if (!(Math.abs(angle) > 1e-9) || Math.abs(angle) >= 89) throw new FeatureError("The draft angle must be between 0° and 89°.");
  const mk = keep(new oc.BRepOffsetAPI_DraftAngle(shape));
  const dir = keep(k.dir(pull));
  const pln = keep(new oc.gp_Pln(keep(k.pnt(neutral.origin)), keep(k.dir(neutral.normal))));
  for (const f of faces) {
    mk.Add(oc.TopoDS.Face(f), dir, (angle * Math.PI) / 180, pln, true);
    if (!mk.AddDone()) throw new FeatureError("A face cannot be drafted about that plane. Faces must cross or touch the neutral plane, and not lie parallel to it.");
  }
  mk.Build();
  if (!mk.IsDone()) throw new FeatureError("The draft could not be built. Try a smaller angle.");
  const out: Shape = keep(mk.Shape());
  // DraftAngle reports a tilted face as "generated" from the face it was; for naming it is the same face
  const none = keep(new oc.NCollection_List_TopoDS_Shape());
  const history = {
    Modified: (s: Shape) => { const m = mk.Modified(s); return m.Size() ? m : mk.Generated(s); },
    Generated: () => none,
    IsDeleted: (s: Shape) => mk.IsDeleted(s),
  };
  return { shape: out, names: k.carryNames(out, history, named, featureId) };
}
