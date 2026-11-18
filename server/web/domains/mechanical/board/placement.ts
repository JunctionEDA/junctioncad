// placement.ts — where a Board feature puts its board: the board's own frame in model space.
//
// Pure arithmetic, used by the worker (features/board-reference.ts) and by the page (board/link.ts, for the
// display model on a default plane, where it need not wait for the worker).
import { cross, type Frame, type Vec3 } from "../core/geometry";

export interface Placement { x: number; y: number; z: number; angle: number; flip: boolean }

/**
 * The board's frame on a plane.  A board point (x, y) at height h above its back face is
 * origin + x·frame.x + y·frame.y + h·frame.normal.  Unflipped, the back face lies on the plane (lifted by z) and
 * the front, with its parts, looks along the plane's normal.  Flipped, the board is turned over about its own
 * x axis and its front face lies on the plane instead.
 */
export function boardFrame(plane: Frame, p: Placement, thickness: number): Frame {
  const a = ((Number(p.angle) || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const mix = (u: Vec3, v: Vec3, ku: number, kv: number): Vec3 => [ku * u[0] + kv * v[0], ku * u[1] + kv * v[1], ku * u[2] + kv * v[2]];
  const x = mix(plane.x, plane.y, c, s);
  let y = mix(plane.x, plane.y, -s, c);
  let n: Vec3 = [plane.normal[0], plane.normal[1], plane.normal[2]];
  const dx = Number(p.x) || 0, dy = Number(p.y) || 0;
  let dz = Number(p.z) || 0;
  if (p.flip) { y = [-y[0], -y[1], -y[2]]; n = cross(x, y); dz += thickness; }
  const o = plane.origin, pn = plane.normal;
  return {
    origin: [o[0] + dx * plane.x[0] + dy * plane.y[0] + dz * pn[0], o[1] + dx * plane.x[1] + dy * plane.y[1] + dz * pn[1], o[2] + dx * plane.x[2] + dy * plane.y[2] + dz * pn[2]],
    x, y, normal: n,
  };
}

/**
 * The frames the Board features of the worker's model were last built with, by feature id.  A frame is a pure
 * function of the feature's parameters and of the model before it, and a feature is evaluated again whenever
 * either changes, so an entry is current for as long as its feature's result is.  Read by
 * services/board-placement.ts.
 */
export const builtFrames = new Map<string, { frame: Frame; thickness: number }>();
