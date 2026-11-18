// section-plane.ts — the arithmetic of a section plane: where it is and which side it keeps, and how far the
// model reaches along its normal.  Pure (three.js maths only); tested in static/tests/cad-analysis.test.js.
import * as THREE from "three";
import type { Vec3 } from "../core/geometry";

/** A section plane as three.js wants it: keeps the points with distanceToPoint ≥ 0. */
export function clipPlane(s: { origin: Vec3; normal: Vec3; offset: number; flip: boolean }): THREE.Plane {
  const n = new THREE.Vector3(...s.normal).normalize().multiplyScalar(s.flip ? -1 : 1);
  const at = new THREE.Vector3(...s.origin).addScaledVector(new THREE.Vector3(...s.normal).normalize(), s.offset);
  // the side the normal points to is cut away
  return new THREE.Plane(n.clone().negate(), n.dot(at));
}

/** The extent of boxes along a direction, measured from `origin`. */
export function extentAlong(boxes: readonly (readonly number[])[], origin: Vec3, normal: Vec3): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const b of boxes) for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]];
    const d = (p[0] - origin[0]) * normal[0] + (p[1] - origin[1]) * normal[1] + (p[2] - origin[2]) * normal[2];
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  return Number.isFinite(lo) ? [lo, hi] : [-50, 50];
}
