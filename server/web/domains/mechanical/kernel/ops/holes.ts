// holes.ts — hole sizes and the solid a hole removes.
//
// The size table is ISO metric: clearance holes for bolts (ISO 273 close, normal and loose), tap drills for
// coarse threads, counterbores for socket head cap screws (ISO 4762) and countersinks for countersunk screws
// (ISO 10642, 90°).  Pure data plus one kernel function; the Hole feature (features/hole.ts) uses both and the
// dialog shows the sizes the table gives.
import type { Vec3 } from "../../core/geometry";
import { ShapeIndex, type Kernel, type Keep, type NamedResult } from "../occ";
import { FeatureError } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface MetricSize {
  /** tap drill for the coarse thread */
  tap: number;
  /** clearance hole: close, normal, loose (ISO 273) */
  clearance: [number, number, number];
  /** counterbore for a socket head cap screw: diameter and depth */
  cbore: [number, number];
  /** countersink diameter at the surface, 90° */
  csink: number;
}

export const METRIC: { [size: string]: MetricSize } = {
  M2: { tap: 1.6, clearance: [2.2, 2.4, 2.6], cbore: [4.3, 2.2], csink: 4.0 },
  "M2.5": { tap: 2.05, clearance: [2.7, 2.9, 3.1], cbore: [5.0, 2.7], csink: 5.0 },
  M3: { tap: 2.5, clearance: [3.2, 3.4, 3.6], cbore: [6.5, 3.3], csink: 6.9 },
  M4: { tap: 3.3, clearance: [4.3, 4.5, 4.8], cbore: [8.0, 4.4], csink: 9.2 },
  M5: { tap: 4.2, clearance: [5.3, 5.5, 5.8], cbore: [10.0, 5.4], csink: 11.5 },
  M6: { tap: 5.0, clearance: [6.4, 6.6, 7.0], cbore: [11.0, 6.5], csink: 13.7 },
  M8: { tap: 6.8, clearance: [8.4, 9.0, 10.0], cbore: [15.0, 8.6], csink: 18.3 },
  M10: { tap: 8.5, clearance: [10.5, 11.0, 12.0], cbore: [18.0, 10.8], csink: 22.8 },
  M12: { tap: 10.2, clearance: [13.0, 13.5, 14.5], cbore: [20.0, 13.0], csink: 27.3 },
};

export type HoleFit = "close" | "normal" | "loose" | "tapped";
export type HoleKind = "simple" | "cbore" | "csink";

export interface HoleSize { diameter: number; cboreDiameter: number; cboreDepth: number; csinkDiameter: number; csinkAngle: number }

/** The sizes of a standard hole, or null for a size the table does not have. */
export function standardHole(size: string, fit: HoleFit): HoleSize | null {
  const m = METRIC[size];
  if (!m) return null;
  const diameter = fit === "tapped" ? m.tap : m.clearance[fit === "close" ? 0 : fit === "loose" ? 2 : 1];
  return { diameter, cboreDiameter: m.cbore[0], cboreDepth: m.cbore[1], csinkDiameter: m.csink, csinkAngle: 90 };
}

export interface HoleShape {
  kind: HoleKind;
  size: HoleSize;
  /** depth of the full diameter, from the surface; Infinity-like values are clipped by the caller */
  depth: number;
  through: boolean;
  /** the drill point's included angle for a blind hole, degrees (118 for a twist drill; 180 for a flat floor) */
  tipAngle: number;
}

/**
 * The solid one hole removes, at `at`, drilling along `dir`; `across` is any direction square to `dir`.  Faces:
 * `<prefix>:wall`, `:floor` (a blind hole's tip or flat bottom), `:cbore`, `:cbore-floor`, `:csink`, `:top`.
 */
export function holeTool(k: Kernel, h: HoleShape, at: Vec3, dir: Vec3, across: Vec3, prefix: string, keep: Keep): NamedResult {
  const oc = k.oc as Any;
  const r = h.size.diameter / 2;
  if (!(r > 0)) throw new FeatureError("The hole's diameter must be more than zero.");
  if (!(h.depth > 0)) throw new FeatureError("The hole's depth must be more than zero.");
  // the half profile in (radius, depth) and the name of the face each segment sweeps
  const pts: [number, number][] = [[0, 0]];
  const roles: (string | null)[] = [];
  const to = (p: [number, number], role: string | null) => { pts.push(p); roles.push(role); };
  if (h.kind === "cbore") {
    const rc = h.size.cboreDiameter / 2, dc = h.size.cboreDepth;
    if (!(rc > r)) throw new FeatureError("The counterbore must be wider than the hole.");
    if (!(dc > 0 && dc < h.depth)) throw new FeatureError("The counterbore must be shallower than the hole.");
    to([rc, 0], "top"); to([rc, dc], "cbore"); to([r, dc], "cbore-floor");
  } else if (h.kind === "csink") {
    const rs = h.size.csinkDiameter / 2, half = ((h.size.csinkAngle || 90) * Math.PI) / 360;
    if (!(rs > r)) throw new FeatureError("The countersink must be wider than the hole.");
    if (!(half > 0 && half < Math.PI / 2)) throw new FeatureError("The countersink angle must be between 0° and 180°.");
    const dc = (rs - r) / Math.tan(half);
    if (!(dc < h.depth)) throw new FeatureError("The countersink is deeper than the hole.");
    to([rs, 0], "top"); to([r, dc], "csink");
  } else to([r, 0], "top");
  to([r, h.depth], "wall");
  const tip = h.through || !(h.tipAngle < 180) ? 0 : r / Math.tan(((h.tipAngle || 118) * Math.PI) / 360);
  to([0, h.depth + tip], "floor");
  roles.push(null);   // back up the axis

  const world = (p: [number, number]): Vec3 => [at[0] + across[0] * p[0] + dir[0] * p[1], at[1] + across[1] * p[0] + dir[1] * p[1], at[2] + across[2] * p[0] + dir[2] * p[1]];
  const mw = keep(new oc.BRepBuilderAPI_MakeWire());
  const edges: { role: string; edge: Any }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = world(pts[i]), b = world(pts[(i + 1) % pts.length]);
    const mk = keep(new oc.BRepBuilderAPI_MakeEdge(keep(k.pnt(a)), keep(k.pnt(b))));
    mw.Add(mk.Edge());
    if (!mw.IsDone()) throw new FeatureError("The hole's profile could not be built.");
    const role = roles[i];
    if (role) edges.push({ role, edge: keep(mw.Edge()) });
  }
  const face = keep(new oc.BRepBuilderAPI_MakeFace(keep(mw.Wire()), true));
  if (!face.IsDone()) throw new FeatureError("The hole's profile could not be built.");
  const ax = keep(new oc.gp_Ax1(keep(k.pnt(at)), keep(k.dir(dir))));
  const rev = keep(new oc.BRepPrimAPI_MakeRevol(face.Face(), ax, true));
  rev.Build(keep(new oc.Message_ProgressRange()));
  if (!rev.IsDone()) throw new FeatureError("The hole could not be built.");
  const shape = keep(rev.Shape());
  const named = new ShapeIndex<string>(k);
  for (const e of edges) for (const s of k.list(rev.Generated(e.edge))) if (!named.has(s)) named.add(s, `${prefix}:${e.role}`);
  return { shape, names: (f) => named.get(f) ?? null };
}
