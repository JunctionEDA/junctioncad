// ref-datum.ts — small arithmetic the reference features share: turning a vector about an axis, and how big the
// model is (what a reference plane or axis is drawn as wide as, when nothing it refers to says).
import { add, cross, dot, scale, type Vec3 } from "../../core/geometry";
import type { EvalContext } from "../types";
import { shapeSize } from "./ref-geom";

/** `v` turned by `angle` radians about the unit vector `axis` (right-handed). */
export function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
}

/** The size of the biggest body, or 50 mm when there is none. */
export function modelSize(ctx: EvalContext): number {
  let size = 0;
  for (const b of ctx.bodies()) size = Math.max(size, shapeSize(ctx, b.shape));
  return size > 1e-6 ? size : 50;
}
