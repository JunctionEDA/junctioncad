// geometry.ts — the small shared vocabulary of the mechanical domain: vectors, sketch-plane frames and the
// references a feature stores to geometry made by earlier features.  Pure (no DOM, no kernel), so the document
// code, the worker and the viewport all use the same definitions.  Lengths are millimetres, angles degrees.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => { const l = length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** A sketch plane's coordinate system: a point (u, v) of the sketch is origin + u·x + v·y; normal = x × y. */
export interface Frame { origin: Vec3; x: Vec3; y: Vec3; normal: Vec3 }

export const toWorld = (f: Frame, p: Vec2): Vec3 => [
  f.origin[0] + p[0] * f.x[0] + p[1] * f.y[0],
  f.origin[1] + p[0] * f.x[1] + p[1] * f.y[1],
  f.origin[2] + p[0] * f.x[2] + p[1] * f.y[2],
];
export const toPlane = (f: Frame, p: Vec3): Vec2 => { const d = sub(p, f.origin); return [dot(d, f.x), dot(d, f.y)]; };

/** The three planes every part studio starts with.  The ids are stored in documents: never rename one. */
export type DefaultPlaneId = "top" | "front" | "right";
export const DEFAULT_PLANES: Record<DefaultPlaneId, { title: string; frame: Frame }> = {
  top: { title: "Top", frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] } },
  front: { title: "Front", frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], normal: [0, -1, 0] } },
  right: { title: "Right", frame: { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], normal: [1, 0, 0] } },
};

export type GeomKind = "face" | "edge" | "vertex";

/**
 * A reference to a face, an edge or a vertex of a body, kept in a feature's parameters or a mate.  `name` is
 * the stable name the kernel gave the geometry (CONTRACT.md, "Geometry names"); it is looked up again on every
 * rebuild, first in `body` and then in every body, so a reference survives edits upstream as long as the name
 * does.  Never store a face index or a mesh id.
 */
export interface GeomRef extends JsonObject { kind: GeomKind; body: string; name: string }

/** Where a sketch lies: a default plane, a planar face of a body, or a reference plane (a `plane` feature). */
export type PlaneRef = { kind: "plane"; plane: DefaultPlaneId } | { kind: "face"; ref: GeomRef } | { kind: "datum"; feature: string };

export function isGeomRef(v: unknown): v is GeomRef {
  const r = v as GeomRef | null;
  return !!r && typeof r === "object" && typeof r.name === "string" && (r.kind === "face" || r.kind === "edge" || r.kind === "vertex");
}
