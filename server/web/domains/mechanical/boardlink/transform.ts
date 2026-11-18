// transform.ts — THE coordinate transform between a part studio and a board.  Everything that crosses the two
// goes through `modelToBoard` / `boardToModel`; nothing else converts.
//
// Part studio (model space): millimetres, right-handed, Z up.
// Board (KiCad): nanometres as integers, X to the right, Y DOWN the sheet, seen from the front (F.Cu) side.
//
// A placement says where the board lies in the model:
//   frame     the plane of the board's BACK face (the face that rests on the standoffs): a point of the model
//             is origin + u·x + v·y + w·normal.  `normal` points from the back of the board to its front, so
//             w is the height above the back face (w = thickness is the front face, where top-side parts stand).
//   anchor    where the frame's origin lands on the KiCad sheet, millimetres (x right, y down).
//   rotation  degrees, counter-clockwise as seen from the front of the board, applied about the frame's origin.
//
//   board X [nm] = (anchor.x + u·cos r − v·sin r) · 1e6
//   board Y [nm] = (anchor.y − (u·sin r + v·cos r)) · 1e6        ← the one place the Y axis is flipped
//
// Seen from the front the frame's (x, y, normal) is right-handed with y up; KiCad's sheet has y down, so the
// map is a mirror in v and a loop that runs counter-clockwise in the model runs clockwise on the sheet.  Arcs
// are therefore passed as start / mid / end, never as centre + angles.
import type { Frame, Vec3 } from "../core/geometry";

export const NM_PER_MM = 1e6;

export interface Placement {
  frame: Frame;
  /** millimetres on the KiCad sheet */
  anchor: [number, number];
  /** degrees, counter-clockwise seen from the front */
  rotation: number;
}

/** A point of the board: sheet position in nanometres and height above the board's back face in millimetres. */
export interface BoardPoint { x: number; y: number; w: number }

export const mmToNm = (mm: number): number => { const v = Math.round(mm * NM_PER_MM); return v === 0 ? 0 : v; };   // never −0
export const nmToMm = (nm: number): number => nm / NM_PER_MM;

/** A frame moved `lift` millimetres along its normal (a board standing on standoffs above the face it was placed on). */
export function liftFrame(f: Frame, lift: number): Frame {
  return lift ? { ...f, origin: [f.origin[0] + f.normal[0] * lift, f.origin[1] + f.normal[1] * lift, f.origin[2] + f.normal[2] * lift] } : f;
}

/** Model space → board.  x and y are whole nanometres. */
export function modelToBoard(pl: Placement, p: Vec3): BoardPoint {
  const f = pl.frame;
  const d0 = p[0] - f.origin[0], d1 = p[1] - f.origin[1], d2 = p[2] - f.origin[2];
  const u = d0 * f.x[0] + d1 * f.x[1] + d2 * f.x[2];
  const v = d0 * f.y[0] + d1 * f.y[1] + d2 * f.y[2];
  const w = d0 * f.normal[0] + d1 * f.normal[1] + d2 * f.normal[2];
  const r = (pl.rotation || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: mmToNm(pl.anchor[0] + u * c - v * s), y: mmToNm(pl.anchor[1] - (u * s + v * c)), w };
}

/** Board → model space: a sheet position in nanometres and a height above the back face in millimetres. */
export function boardToModel(pl: Placement, x: number, y: number, w = 0): Vec3 {
  const f = pl.frame;
  const a = nmToMm(x) - pl.anchor[0], b = -(nmToMm(y) - pl.anchor[1]);
  const r = (pl.rotation || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const u = a * c + b * s, v = -a * s + b * c;
  return [
    f.origin[0] + u * f.x[0] + v * f.y[0] + w * f.normal[0],
    f.origin[1] + u * f.x[1] + v * f.y[1] + w * f.normal[1],
    f.origin[2] + u * f.x[2] + v * f.y[2] + w * f.normal[2],
  ];
}

/**
 * Model space → the board's own right-handed 3D space, for drawing a model around a board: millimetres, X as
 * on the sheet, Y UP the sheet (−KiCad Y), Z the height above the board's FRONT face (the back face is at
 * −thickness).  A rigid motion: no mirror, so triangles keep their winding.
 */
export function modelToBoard3D(pl: Placement, thickness: number, p: Vec3): Vec3 {
  const f = pl.frame;
  const d0 = p[0] - f.origin[0], d1 = p[1] - f.origin[1], d2 = p[2] - f.origin[2];
  const u = d0 * f.x[0] + d1 * f.x[1] + d2 * f.x[2];
  const v = d0 * f.y[0] + d1 * f.y[1] + d2 * f.y[2];
  const w = d0 * f.normal[0] + d1 * f.normal[1] + d2 * f.normal[2];
  const r = (pl.rotation || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [pl.anchor[0] + u * c - v * s, -pl.anchor[1] + (u * s + v * c), w - thickness];
}

/** The same motion for a direction (a normal). */
export function directionToBoard3D(pl: Placement, n: Vec3): Vec3 {
  const f = pl.frame;
  const u = n[0] * f.x[0] + n[1] * f.x[1] + n[2] * f.x[2];
  const v = n[0] * f.y[0] + n[1] * f.y[1] + n[2] * f.y[2];
  const w = n[0] * f.normal[0] + n[1] * f.normal[1] + n[2] * f.normal[2];
  const r = (pl.rotation || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [u * c - v * s, u * s + v * c, w];
}
