// types.ts — the model the kernel builds and the context a feature's `evaluate` works in.
// Worker side.  The page sees none of these objects: it gets the tessellated result (protocol.ts).
import type { OpenCascadeInstance, TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "replicad-opencascadejs";
import type { Frame, GeomKind, GeomRef, PlaneRef, Vec3 } from "../core/geometry";
import type { Region } from "../sketch/profiles";
import type { SketchData } from "../sketch/format";
import type { Kernel } from "./occ";
import type { DatumView } from "./protocol";

/** The OpenCascade bindings (npm replicad-opencascadejs): `new oc.BRepPrimAPI_MakePrism(face, vec)` and so on. */
export type OC = OpenCascadeInstance;
export type Shape = TopoDS_Shape;

/** A face, edge or vertex of a body with its stable name (CONTRACT.md, "Geometry names"). */
export interface NamedShape { name: string; shape: Shape }
export interface BodyTopo { faces: NamedShape[]; edges: NamedShape[]; vertices: NamedShape[] }

/** A solid (or sheet) in the part studio. */
export interface Body {
  /** stable across rebuilds: the id of the feature that made it, plus a suffix when that feature made several */
  id: string;
  name: string;
  /** changes whenever the shape does: the page keeps a mesh per revision and is sent only the ones it lacks */
  rev: number;
  shape: Shape;
  topo: BodyTopo;
  /** the feature that made the body */
  createdBy: string;
  /**
   * Reference geometry (a board from the electronics editor, an imported envelope): it can be picked, measured
   * and named in a feature's parameters, but `ctx.bodies()` leaves it out, so a feature that acts on "every
   * body" does not fuse with it or cut it.
   */
  reference?: boolean;
}

/** A sketch as later features see it: where it lies and the closed regions it encloses, as kernel faces. */
export interface SketchGeometry {
  featureId: string;
  frame: Frame;
  data: SketchData;
  regions: SketchRegion[];
  /** curves that are on no closed loop (see sketch/profiles.ts) */
  open: string[];
}
export interface SketchRegion {
  id: string;
  region: Region;
  face: TopoDS_Face;
  /** the face's edges and the sketch entity each came from: what names the sides of an extrusion */
  edges: { entity: string; edge: TopoDS_Edge }[];
}

/** Reference geometry (a plane, an axis, a point, a curve) a feature made; `shape` is a curve's wire. */
export type Datum = DatumView & { shape?: Shape };

/** Everything that exists after some feature has run.  Treated as immutable: a feature gets a working copy. */
export interface ModelState {
  bodies: Body[];
  sketches: { [featureId: string]: SketchGeometry };
  /** reference geometry by the id of the feature that made it */
  datums?: { [featureId: string]: Datum };
}

/** An error a person can act on.  Anything else a feature throws is reported as an internal error. */
export class FeatureError extends Error {
  constructor(message: string) { super(message); this.name = "FeatureError"; }
}

/** How to name the faces of a shape a feature made: called with each face, returns its name or null. */
export type FaceNamer = (face: TopoDS_Face, index: number) => string | null;

export interface Resolved { kind: GeomKind; body: Body; shape: Shape; name: string }

/** What `evaluate` gets.  Everything a feature may do to the model goes through here. */
export interface EvalContext {
  /** the raw OpenCascade bindings */
  readonly oc: OC;
  /** helpers over them: sub-shapes, history, extrusion and booleans that keep names, error text (occ.ts) */
  readonly k: Kernel;
  readonly feature: { id: string; type: string; name: string };

  /** The bodies as they are now, in creation order, without reference bodies (see Body.reference). */
  bodies(): readonly Body[];
  /** Every body, reference bodies included. */
  allBodies(): readonly Body[];
  body(id: string): Body | undefined;
  /**
   * Add a body.  `names` gives every face its stable name (a face it returns null for gets a fallback name);
   * edge and vertex names follow from the faces.  `suffix` tells apart several bodies made by one feature.
   */
  addBody(shape: Shape, names: FaceNamer, o?: { suffix?: string; name?: string; reference?: boolean }): Body;
  /** Replace a body's shape (after a boolean, a fillet, …), keeping its id and name. */
  replaceBody(body: Body, shape: Shape, names: FaceNamer): Body;
  removeBody(body: Body): void;

  /** The sketch a feature made, or a FeatureError that says why there is none. */
  sketch(featureId: string): SketchGeometry;
  setSketch(sketch: SketchGeometry): void;

  /** The reference geometry an earlier feature made, or a FeatureError that says why there is none. */
  datum(featureId: string): Datum;
  setDatum(datum: Datum): void;
  /**
   * The model just before and just after an earlier feature ran, or null when it is not earlier in the tree.
   * What patterns and mirrors read to find what a feature added and removed.
   */
  history(featureId: string): { before: ModelState; after: ModelState; status: string } | null;

  /** Find the geometry a stored reference names, or throw a FeatureError that says the reference was lost. */
  resolve(ref: GeomRef): Resolved;
  /** The coordinate system of a sketch plane: a default plane or a planar face. */
  frameOf(plane: PlaneRef): Frame;

  /** Keep a kernel object alive for as long as this feature's result is cached; it is deleted with the cache entry. */
  own<T extends { delete(): void }>(obj: T): T;
  /** Delete a kernel object when this evaluation ends. */
  tmp<T extends { delete(): void }>(obj: T): T;
  /** `throw ctx.fail("Pick a sketch to extrude.")` */
  fail(message: string): FeatureError;
  /** Attach a note to the feature without failing it ("2 curves are not on a closed loop"). */
  warn(message: string): void;
}

export type { Frame, GeomRef, PlaneRef, Vec3 };
