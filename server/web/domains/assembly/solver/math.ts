// math.ts — the arithmetic the assembly solver and the mates stand on: vectors, unit quaternions and rigid
// poses.  Pure, no three.js: it runs the same in the page, in a worker and in node tests.
//
// A pose is a position and a unit quaternion [x, y, z, w]; a document Transform (document/format.ts) is the same
// thing as the rows of a 3 × 4 matrix.  `poseOf` and `transformOf` convert between them.
import type { Vec3 } from "../../mechanical/api";
import type { Transform } from "../document/format";

export type Quat = [number, number, number, number];
export interface Pose { p: Vec3; q: Quat }

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: Vec3): Vec3 => { const l = len(a); return l > 1e-300 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]; };
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** A unit vector at right angles to `n`: the world axis least along it, made perpendicular. */
export function perpendicular(n: Vec3): Vec3 {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const e: Vec3 = ax <= ay + 1e-9 && ax <= az + 1e-9 ? [1, 0, 0] : ay <= az + 1e-9 ? [0, 1, 0] : [0, 0, 1];
  return unit(addScaled(e, n, -dot(e, n)));
}

export function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export function qnorm(q: Quat): Quat { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; }
/** Rotate a vector by a unit quaternion. */
export function qrot(q: Quat, v: Vec3): Vec3 {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
/** The rotation of `angle` radians about a unit axis. */
export function qaxis(axis: Vec3, angle: number): Quat { const s = Math.sin(angle / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]; }
/** The rotation whose rotation vector (axis × angle) is `w`. */
export function qexp(w: Vec3): Quat {
  const a = len(w);
  if (a < 1e-12) return qnorm([w[0] / 2, w[1] / 2, w[2] / 2, 1]);
  const s = Math.sin(a / 2) / a;
  return [w[0] * s, w[1] * s, w[2] * s, Math.cos(a / 2)];
}
/** The rotation vector of a unit quaternion (the shorter way round). */
export function qlog(q: Quat): Vec3 {
  const sgn = q[3] < 0 ? -1 : 1;
  const s = Math.hypot(q[0], q[1], q[2]);
  if (s < 1e-12) return [2 * sgn * q[0], 2 * sgn * q[1], 2 * sgn * q[2]];
  const a = 2 * Math.atan2(s, sgn * q[3]);
  return [(sgn * q[0] / s) * a, (sgn * q[1] / s) * a, (sgn * q[2] / s) * a];
}

/** The quaternion of the rotation whose matrix columns are x, y, z (a right-handed orthonormal frame). */
export function qfromAxes(x: Vec3, y: Vec3, z: Vec3): Quat {
  const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
  return qnorm(q);
}

export function poseOf(t: readonly number[]): Pose {
  // the stored matrix may have drifted a little from a pure rotation: make its axes orthonormal again
  const x = unit([t[0], t[4], t[8]]);
  let y: Vec3 = [t[1], t[5], t[9]];
  y = unit(addScaled(y, x, -dot(y, x)));
  const z = cross(x, y);
  return { p: [t[3], t[7], t[11]], q: qfromAxes(x, y, z) };
}
export function transformOf(pose: Pose): Transform {
  const x = qrot(pose.q, [1, 0, 0]), y = qrot(pose.q, [0, 1, 0]), z = qrot(pose.q, [0, 0, 1]);
  return [x[0], y[0], z[0], pose.p[0], x[1], y[1], z[1], pose.p[1], x[2], y[2], z[2], pose.p[2]];
}
/** a ∘ b: apply b, then a. */
export function compose(a: Pose, b: Pose): Pose { return { p: add(a.p, qrot(a.q, b.p)), q: qnorm(qmul(a.q, b.q)) }; }
export function inverse(a: Pose): Pose { const q = qconj(a.q); return { p: scale(qrot(q, a.p), -1), q }; }
export const applyPose = (a: Pose, v: Vec3): Vec3 => add(a.p, qrot(a.q, v));
export const identityPose = (): Pose => ({ p: [0, 0, 0], q: [0, 0, 0, 1] });

/** How far apart two placements are: the larger of the distance moved (mm) and the angle turned × `reach` (mm). */
export function poseDistance(a: Pose, b: Pose, reach = 100): number {
  return Math.max(len(sub(a.p, b.p)), len(qlog(qmul(b.q, qconj(a.q)))) * reach);
}

/** An angle brought into (−π, π]. */
export function wrapAngle(a: number): number { a = a % (2 * Math.PI); if (a > Math.PI) a -= 2 * Math.PI; if (a <= -Math.PI) a += 2 * Math.PI; return a; }
