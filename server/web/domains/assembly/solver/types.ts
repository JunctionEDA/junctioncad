// types.ts — what the assembly solver is given and what it answers.  The solver knows nothing about documents,
// meshes or the viewport: bodies with poses, mates between connector frames, and options.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { Vec3 } from "../../mechanical/api";
import type { Pose, Quat } from "./math";

/**
 * A mate connector's coordinate system: an origin and three unit axes (right-handed, z is the primary axis).
 * In a body's own space when it is stored on a SolverMate; in assembly space when a mate's `residuals` sees it.
 * `surface` says what the connector was inferred from, and `radius` its radius when it has one: Tangent needs
 * both, the other mates ignore them.
 */
export interface MateFrame {
  o: Vec3; x: Vec3; y: Vec3; z: Vec3;
  surface?: "plane" | "cylinder" | "circle" | "line" | "point" | "other";
  radius?: number;
}

/** A scalar freedom a mate leaves: it can be measured, limited, driven (dragged, animated). */
export interface MateValue {
  /** stable key: limits are stored in the mate's params as `<key>Min` / `<key>Max` */
  key: string;
  label: string;
  unit: "mm" | "deg";
  /** the value as the two frames stand: millimetres, or radians in (−π, π] for an angle */
  measure(a: MateFrame, b: MateFrame): number;
}

/** What a mate file gives the solver (MateDefinition.solve, core/mate.ts). */
export interface MateSolve {
  /**
   * Append this mate's residuals to `out`: zero when the mate holds.  Positions are millimetres; multiply a
   * difference of unit vectors (an angular error) by `reach` so that both kinds are comparable.  The number of
   * residuals must not depend on the frames.  `a` and `b` are in assembly space, with the mate's flip, offset
   * and reorientation already applied (solver/frames.ts).
   */
  residuals(a: MateFrame, b: MateFrame, params: JsonObject, reach: number, out: number[]): void;
  /** the freedoms that have a value */
  values?: MateValue[];
  /** true when the mate leaves no freedom: the solver then welds the two instances into one rigid body */
  rigid?: boolean;
  /** Why these two connectors cannot take this mate ("Tangent needs a cylinder"), or null. */
  check?(a: MateFrame, b: MateFrame, params: JsonObject): string | null;
}

export interface SolverBody {
  id: string; pose: Pose; fixed: boolean;
  /**
   * The middle of the body's geometry, in its own space (default: its origin).  Steps turn a body about this
   * point, so "the smallest change" slides a part rather than swinging it about an origin that may be far from it.
   */
  centre?: Vec3;
}

export interface SolverMate {
  id: string;
  solve: MateSolve;
  /** the two connectors: the body's id and the frame in that body's own space */
  a: { body: string; frame: MateFrame };
  b: { body: string; frame: MateFrame };
  params: JsonObject;
}

export interface DragGoal {
  body: string;
  /** the grabbed point, in the body's own space */
  point: Vec3;
  /** where the pointer wants it, in assembly space */
  target: Vec3;
  /** also turn the body to this orientation (the rotation rings of the manipulator) */
  rotation?: Quat;
}

export interface SolveOptions {
  /** millimetres that one radian of angular error counts as; about the size of the assembly (default 100) */
  reach?: number;
  /** pull a body towards the pointer; the mates still hold */
  drag?: DragGoal;
  /** hold mate values at these numbers (mm or radians) during this solve: dragging a value, animating it */
  drives?: { mate: string; key: string; value: number }[];
  /** a mate just made or edited: its second instance is first put where that one mate wants it */
  seed?: string;
  /** count the freedoms left and find which mates conflict (slower: not for every frame of a drag) */
  analyze?: boolean;
  maxIterations?: number;
}

export type MateStatus = "ok" | "conflict" | "error";
export interface MateReport {
  status: MateStatus;
  /** the largest residual left, in millimetres */
  residual: number;
  message?: string;
  /** the mate's values as solved: millimetres or degrees */
  values: { [key: string]: number };
}

export interface BodyReport {
  /** true when the body cannot move: fixed, or welded to something fixed */
  grounded: boolean;
  /** the freedoms the mates leave it (0 to 6); null when not analysed */
  dof: number | null;
}

export interface SolveResult {
  /** every body's solved pose */
  poses: Map<string, Pose>;
  mates: Map<string, MateReport>;
  bodies: Map<string, BodyReport>;
  /** false when some mate could not be satisfied */
  ok: boolean;
  /** the freedoms of the whole assembly; null when not analysed */
  dof: number | null;
  iterations: number;
  ms: number;
}
