// transform.ts — placement arithmetic for assemblies: 3 × 4 matrices as twelve numbers, row by row.
import type { Frame, Vec3 } from "../../mechanical/api";
import type { Transform } from "../document/format";

/** a · b: apply b, then a. */
export function multiply(a: Transform, b: Transform): Transform {
  const o = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
  }
  return o as Transform;
}

/** The inverse of a rigid transform (a rotation and a translation). */
export function invert(t: Transform): Transform {
  const r = [t[0], t[4], t[8], t[1], t[5], t[9], t[2], t[6], t[10]];   // the rotation, transposed
  const x = -(r[0] * t[3] + r[1] * t[7] + r[2] * t[11]), y = -(r[3] * t[3] + r[4] * t[7] + r[5] * t[11]), z = -(r[6] * t[3] + r[7] * t[7] + r[8] * t[11]);
  return [r[0], r[1], r[2], x, r[3], r[4], r[5], y, r[6], r[7], r[8], z];
}

export function apply(t: Transform, p: Vec3): Vec3 {
  return [t[0] * p[0] + t[1] * p[1] + t[2] * p[2] + t[3], t[4] * p[0] + t[5] * p[1] + t[6] * p[2] + t[7], t[8] * p[0] + t[9] * p[1] + t[10] * p[2] + t[11]];
}

/** The transform that takes the world axes onto a frame: columns x, y, normal, and the origin. */
export function fromFrame(f: Frame): Transform {
  return [f.x[0], f.y[0], f.normal[0], f.origin[0], f.x[1], f.y[1], f.normal[1], f.origin[1], f.x[2], f.y[2], f.normal[2], f.origin[2]];
}
