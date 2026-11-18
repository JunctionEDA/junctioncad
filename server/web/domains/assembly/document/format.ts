// format.ts — the assembly document: a `.jasm` file.
//
// A JSON item document (web/shared/itemdoc/itemdoc.ts) whose `junction` kind is "assembly".  Its items:
//
//   assembly   one item, id "assembly": settings of the whole document  { id, type: "assembly", units }
//   instance   one placed occurrence of something another document defines
//              { id, type: "instance", name, order, source, transform, fixed?, suppressed?, hidden? }
//   mate       a relation between two instances
//              { id, type: "mate", mateType, name, order, a, b, params, suppressed? }
//
// An instance does not copy geometry.  `source` says where it comes from and the assembly follows that document:
//   { kind: "part", docId, body }      a body of a part studio (`body` is the body's stable id)
//   { kind: "board", docId }           a board of the project, as the electronics domain's 3D model of it
//   { kind: "assembly", docId }        another assembly, as a rigid sub-assembly
//   { kind: "file", docId }            a model file of the project (STEP)
// `version` (optional, on any source) pins the instance to a kept version of that document; absent means "live".
//
// `transform` places the instance in the assembly: twelve numbers, the rows of a 3 × 4 matrix (a rotation and a
// translation in millimetres), so [1,0,0,0, 0,1,0,0, 0,0,1,0] is "where the source put it".  It is what the mate
// solver writes: THE DOCUMENT ALWAYS STORES SOLVED PLACEMENTS, so a reader that cannot solve mates still shows
// the assembly correctly.  `fixed: true` pins an instance; the solver never moves it.
//
// A mate ties a connector on instance `a` to one on instance `b`.  A connector is a reference to geometry of the
// instance's source — the same stable names features use (mechanical/CONTRACT.md, "Geometry names") — from
// which a coordinate system is derived (a planar face: its centre and normal; a circular edge: its centre and
// axis; a vertex: the point).  `mateType` names a registered mate (mates/*.ts); `params` is that mate's own data
// (an offset, limits).  Unknown item types, mate types and keys are kept as they are.
import { byOrder, newItemDoc, serializeItemDoc, type Item, type ItemDoc, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { GeomRef } from "../../mechanical/api";

export const ASSEMBLY_KIND = "assembly";
export const ASSEMBLY_EXT = ".jasm";
export const ASSEMBLY_ITEM_ID = "assembly";

/** The rows of a 3 × 4 placement matrix. */
export type Transform = [number, number, number, number, number, number, number, number, number, number, number, number];
export const IDENTITY: Transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export type InstanceSource =
  | { kind: "part"; docId: string; body: string; version?: string }
  | { kind: "board"; docId: string; version?: string }
  | { kind: "assembly"; docId: string; version?: string }
  | { kind: "file"; docId: string; version?: string };

export interface InstanceItem extends Item {
  type: "instance";
  name: string;
  order: string;
  source: InstanceSource & JsonObject;
  transform: number[];
  fixed?: boolean;
  suppressed?: boolean;
  hidden?: boolean;
  /** the id of the group item (a folder in the instance list, document/edits.ts) this instance is in */
  group?: string;
}

/** One end of a mate: geometry of an instance's source, and which way its axis points. */
export interface MateConnector extends JsonObject {
  instance: string;
  ref: GeomRef;
  /** turn the connector's axis round (the other side of the face) */
  flip?: boolean;
  /** the id of an explicit connector item (document/edits.ts) this end uses; `ref` is then that connector's geometry */
  connector?: string;
}

export interface MateItem extends Item {
  type: "mate";
  mateType: string;
  name: string;
  order: string;
  a: MateConnector;
  b: MateConnector;
  params: JsonObject;
  suppressed?: boolean;
  /**
   * The values the mate had when the placements were last stored (an angle in degrees, a distance in mm, by the
   * mate type's value keys).  Written with the transforms.  When a part changes upstream and the stored
   * placements no longer satisfy the mates, every reader re-solves towards these, so a lid left open at 45° is
   * still at 45° and two people's windows agree.
   */
  values?: { [key: string]: number };
}

export interface AssemblyItem extends Item { type: "assembly"; units: "mm" | "in" }

export const isInstance = (i: Item | undefined): i is InstanceItem => !!i && i.type === "instance" && !!i.source;
export const isMate = (i: Item | undefined): i is MateItem => !!i && i.type === "mate" && typeof i.mateType === "string";

export function instancesOf(doc: ItemDoc): InstanceItem[] { const out: InstanceItem[] = []; for (const i of doc.items.values()) if (isInstance(i)) out.push(i); return byOrder(out); }
export function matesOf(doc: ItemDoc): MateItem[] { const out: MateItem[] = []; for (const i of doc.items.values()) if (isMate(i)) out.push(i); return byOrder(out); }

/** A transform as stored is twelve finite numbers; anything else reads as "where the source put it". */
export function transformOf(i: InstanceItem): Transform {
  const t = i.transform;
  return Array.isArray(t) && t.length === 12 && t.every((v) => typeof v === "number" && Number.isFinite(v)) ? (t.slice() as Transform) : (IDENTITY.slice() as Transform);
}

/** The text of a new, empty assembly: what is uploaded as the document's first snapshot. */
export function newAssemblyText(): string {
  const head: AssemblyItem = { id: ASSEMBLY_ITEM_ID, type: "assembly", units: "mm" };
  return serializeItemDoc(newItemDoc(ASSEMBLY_KIND, [head]));
}
