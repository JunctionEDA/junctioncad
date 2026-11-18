// snapshot.ts — a board as plain data in its own frame: what board/model.ts BoardReader.snapshot() returns.
//
// It is the Board feature's input in the worker (features/board-reference.ts builds solids from it with
// board/brep.ts), so this file imports nothing from the page or from the electronics domain.  README.md
// describes the frame and the names.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";

export type Pt = [number, number];

export interface SnapshotOptions {
  /** the point of the board document (mm, Y down) that is the board frame's origin */
  origin: Pt;
  /** drills narrower than this are left out of the solid, mm */
  minHole: number;
  /** parts lower than this get no envelope, mm */
  minHeight: number;
}

/** A piece of an outline loop.  `n` is its stable name (the Edge.Cuts graphic's uuid, with an index for a polygon's sides). */
export type SnapSeg = { n: string } & (
  | { k: "l"; a: Pt; b: Pt }
  | { k: "a"; a: Pt; b: Pt; m: Pt }
  | { k: "c"; c: Pt; r: number }
);
export interface SnapOutline { outer: SnapSeg[]; cuts: SnapSeg[][] }
export interface SnapHole {
  /** stable name: "H1" for a one-pad footprint, "J3:2" for pad 2 of J3, "J3:@4" when the pad number is not unique */
  n: string;
  part: string; pad: string;
  x: number; y: number;
  /** diameter (the narrow way of a slot) */
  d: number;
  /** a slot: its size as KiCad gives it and its turn in degrees (KiCad's sense, in the document) */
  slot?: { w: number; h: number; rot: number };
  plated: boolean;
  /** which outline it is in */
  outline: number;
}
export interface SnapPart {
  /** stable name: the reference designator (see partNames) */
  n: string; ref: string;
  back: boolean;
  /** how far it stands off its face */
  h: number;
  /** the envelope's outline: four corners in the footprint's own order, so side i runs from pts[i] to pts[i + 1] */
  pts: Pt[];
  round?: { x: number; y: number; r: number };
}
export interface BoardSnapshot {
  v: 1;
  thickness: number;
  outlines: SnapOutline[];
  holes: SnapHole[];
  parts: SnapPart[];
  /** true when the board has no closed outline and the box around its contents stands in */
  fallback: boolean;
  /** Edge.Cuts pieces that are on no closed loop */
  open: number;
  /** drills left out because they break the edge or each other */
  skippedHoles: number;
}
/** The snapshot as a feature parameter. */
export type BoardSnapshotJson = BoardSnapshot & JsonObject;

/** The names of a rectangular envelope's four sides, in the order of its corners (the footprint's own axes, Y down as KiCad draws it). */
export const SIDE_NAMES = ["y-", "x+", "y+", "x-"] as const;

export function circleThrough(a: Pt, b: Pt, c: Pt): { x: number; y: number; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { x, y, r: Math.hypot(a[0] - x, a[1] - y) };
}
