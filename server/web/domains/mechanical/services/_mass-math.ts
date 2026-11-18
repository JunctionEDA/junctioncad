// _mass-math.ts — pure arithmetic for mass properties: inertia tensors, their combination about a common centre
// (the parallel-axis theorem) and principal moments.  No kernel, no DOM: used by the worker services and tested
// on its own (static/tests/cad-analysis.test.js).
//
// Conventions.  Lengths are millimetres, masses kilograms, densities grams per cubic centimetre (water is 1), so
// an inertia is kg·mm².  A tensor is the symmetric matrix J with J.xx = ∫(y² + z²) dm and the products of
// inertia stored as matrix entries, J.xy = −∫x·y dm (the sign a mechanics textbook writes in the matrix).
import type { Vec3 } from "../core/geometry";

export interface Tensor { xx: number; yy: number; zz: number; xy: number; xz: number; yz: number }

export const ZERO_TENSOR: Tensor = { xx: 0, yy: 0, zz: 0, xy: 0, xz: 0, yz: 0 };

/** kg per mm³ for a density in g/cm³. */
export const KG_PER_MM3 = 1e-6;

export function scaleTensor(t: Tensor, s: number): Tensor {
  return { xx: t.xx * s, yy: t.yy * s, zz: t.zz * s, xy: t.xy * s, xz: t.xz * s, yz: t.yz * s };
}

/**
 * The tensor from the moments about six axes through the centre: x, y, z and the three diagonals (x+y)/√2,
 * (x+z)/√2, (y+z)/√2.  Moment about a unit axis n is nᵀ J n, so J.xy = I(x+y) − (J.xx + J.yy) / 2.
 */
export function tensorFromAxisMoments(m: { x: number; y: number; z: number; xy: number; xz: number; yz: number }): Tensor {
  return { xx: m.x, yy: m.y, zz: m.z, xy: m.xy - (m.x + m.y) / 2, xz: m.xz - (m.x + m.z) / 2, yz: m.yz - (m.y + m.z) / 2 };
}

/** The same tensor about a point `d` away from the centre of mass (parallel-axis theorem). */
export function shiftTensor(t: Tensor, mass: number, d: Vec3): Tensor {
  const [x, y, z] = d;
  return { xx: t.xx + mass * (y * y + z * z), yy: t.yy + mass * (x * x + z * z), zz: t.zz + mass * (x * x + y * y), xy: t.xy - mass * x * y, xz: t.xz - mass * x * z, yz: t.yz - mass * y * z };
}

export interface MassPart { mass: number; centre: Vec3; inertia: Tensor }

/** Several parts as one: total mass, the common centre of mass and the inertia about it. */
export function combine(parts: readonly MassPart[]): MassPart {
  const mass = parts.reduce((s, p) => s + p.mass, 0);
  if (!(mass > 0)) return { mass: 0, centre: [0, 0, 0], inertia: { ...ZERO_TENSOR } };
  const c: Vec3 = [0, 0, 0];
  for (const p of parts) for (let i = 0; i < 3; i++) c[i] += (p.centre[i] * p.mass) / mass;
  let t: Tensor = { ...ZERO_TENSOR };
  for (const p of parts) {
    const s = shiftTensor(p.inertia, p.mass, [p.centre[0] - c[0], p.centre[1] - c[1], p.centre[2] - c[2]]);
    t = { xx: t.xx + s.xx, yy: t.yy + s.yy, zz: t.zz + s.zz, xy: t.xy + s.xy, xz: t.xz + s.xz, yz: t.yz + s.yz };
  }
  return { mass, centre: c, inertia: t };
}

/**
 * Principal moments (ascending) and their axes (unit vectors, the columns of the rotation), by Jacobi rotations
 * of the symmetric 3 × 3 matrix.  Exact to rounding for any tensor a solid can have.
 */
export function principal(t: Tensor): { moments: Vec3; axes: [Vec3, Vec3, Vec3] } {
  const a = [[t.xx, t.xy, t.xz], [t.xy, t.yy, t.yz], [t.xz, t.yz, t.zz]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const scale = Math.max(1e-300, Math.abs(t.xx) + Math.abs(t.yy) + Math.abs(t.zz));
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15 * scale) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const tt = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(tt * tt + 1), s = tt * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  const moments = order.map((i) => a[i][i]) as Vec3;
  const axes = order.map((i) => [v[0][i], v[1][i], v[2][i]] as Vec3) as [Vec3, Vec3, Vec3];
  return { moments, axes };
}

/** The union of boxes [xmin, ymin, zmin, xmax, ymax, zmax]; null for none. */
export function unionBox(boxes: readonly (readonly number[])[]): [number, number, number, number, number, number] | null {
  if (!boxes.length) return null;
  const out: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let i = 0; i < 3; i++) { out[i] = Math.min(out[i], b[i]); out[i + 3] = Math.max(out[i + 3], b[i + 3]); }
  return out;
}
