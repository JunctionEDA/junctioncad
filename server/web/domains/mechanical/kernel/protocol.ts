// protocol.ts — the messages between the page and the modelling worker (static/dist/cad-worker.js), and the
// shape of what comes back.  Typed arrays in a result are transferred, not copied.
//
//   page → worker   { t: "init", wasmUrl, module? }
//                   { t: "regen", seq, features, rollback, have }
//                   { t: "call", seq, service, args }
//   worker → page   { t: "ready", ms } | { t: "failed", message }
//                   { t: "progress", seq, index, total, featureId }
//                   { t: "regen", seq, result }
//                   { t: "call", seq, ok: true, value } | { t: "call", seq, ok: false, error }
//
// `seq` is the page's own counter: a reply carries the seq of the request it answers.  The worker handles one
// message at a time, in order; the page (kernel/client.ts) keeps only the newest regeneration it asked for.
import type { Json, JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { Frame, Vec3 } from "../core/geometry";

/** One feature as the worker needs it: the document's feature item without its place in the list. */
export interface FeatureInput { id: string; type: string; name: string; suppressed: boolean; params: JsonObject }

export type FeatureStatus = "ok" | "warning" | "error" | "suppressed" | "rolled-back";
export interface FeatureReport {
  id: string; status: FeatureStatus;
  /** why it failed, or the note it left */
  message?: string;
  /** how long evaluate took, when it ran this time */
  ms?: number;
  /** true when the result came from the cache (nothing before it, nor it, changed) */
  cached?: boolean;
}

/**
 * A body, tessellated.  Faces, edges and vertices are ranges of the buffers, in the same order as their
 * `names`: face i is triangles `indices[faces.start[i] .. + faces.count[i]]`, edge i is the line segments
 * `edges.positions[3 * edges.start[i] .. 3 * (start + count)]` (two points per segment).
 */
export interface BodyMesh {
  positions: Float32Array; normals: Float32Array; indices: Uint32Array;
  faces: { names: string[]; start: Uint32Array; count: Uint32Array };
  edges: { names: string[]; positions: Float32Array; start: Uint32Array; count: Uint32Array };
  vertices: { names: string[]; positions: Float32Array };
  /** xmin, ymin, zmin, xmax, ymax, zmax */
  bbox: [number, number, number, number, number, number];
}

export interface BodyResult {
  id: string; name: string; createdBy: string;
  /** changes whenever the body's shape does */
  rev: number;
  /** absent when the page said it already has this revision (`have`) */
  mesh?: BodyMesh;
  /** a body that is there to be referred to, not a part (the Board feature's board): kernel/types.ts Body.reference */
  reference?: true;
}

/** A sketch, ready to draw: its plane and every curve as a polyline in model space. */
export interface SketchView {
  featureId: string;
  frame: Frame;
  curves: { entity: string; construction: boolean; points: Float32Array }[];
  points: { entity: string; position: Vec3 }[];
  /** closed regions: the outer loop and its holes as polygons in the sketch plane (u, v pairs) */
  regions: { id: string; outer: Float32Array; holes: Float32Array[] }[];
  open: string[];
}

/**
 * Reference geometry a feature made (features/plane.ts, axis.ts, point.ts, helix.ts), ready to draw and pick.
 * One per feature: `featureId` is the feature that made it.
 */
export interface DatumView {
  featureId: string;
  kind: "plane" | "axis" | "point" | "curve";
  /** plane: its frame (a sketch on it uses this), and the square drawn `size` wide about `centre` */
  frame?: Frame; centre?: Vec3; size?: number;
  /** axis: a point on it and its direction; drawn `length` long, centred on `origin` */
  origin?: Vec3; dir?: Vec3; length?: number;
  /** point */
  at?: Vec3;
  /** curve: a polyline, x y z after x y z */
  points?: number[];
}

export interface RegenResult {
  features: FeatureReport[];
  bodies: BodyResult[];
  sketches: SketchView[];
  /** reference planes, axes, points and curves (absent from engines that know none) */
  datums?: DatumView[];
  /** the index of the first feature that was evaluated again; features.length when everything was cached */
  rebuiltFrom: number;
  ms: number;
}

export type ToWorker =
  | { t: "init"; wasmUrl: string; /** the kernel as the page compiled it, for every worker of the page (absent: the worker fetches it) */ module?: WebAssembly.Module | null }
  | { t: "regen"; seq: number; features: FeatureInput[]; /** how many features to build: the rollback bar's place */ rollback: number; /** body revisions the page holds */ have: number[] }
  | { t: "call"; seq: number; service: string; args: Json };

export type FromWorker =
  | { t: "ready"; ms: number }
  | { t: "failed"; message: string }
  | { t: "progress"; seq: number; index: number; total: number; featureId: string }
  | { t: "regen"; seq: number; result: RegenResult }
  | { t: "call"; seq: number; ok: true; value: Json }
  | { t: "call"; seq: number; ok: false; error: string };
