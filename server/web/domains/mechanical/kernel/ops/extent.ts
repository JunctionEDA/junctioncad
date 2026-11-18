// extent.ts — end conditions for a sweep that are not a plain length: up to a face, up to the next body in
// the way.  The sweep is first made long enough to pass everything (shapes.ts reachPast), then trimmed here.
//
// The face the sweep stops on is named like a cap made the plain way (`<feature>:end:<region>`), so a
// reference to it means the same thing whatever the end condition.
import type { Vec3 } from "../../core/geometry";
import type { NamedResult } from "../occ";
import type { EvalContext, NamedShape, Shape } from "../types";
import { compound, distance, planeFace } from "./shapes";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const relabel = (faces: readonly NamedShape[], name: string): NamedShape[] => faces.map((f) => ({ name, shape: f.shape }));

/**
 * Trim a long sweep at a plane: keep the part on the side of the plane where `start` lies.  Fails when the
 * sweep does not cross the plane.
 */
export function trimAtPlane(ctx: EvalContext, long: NamedResult, plane: { origin: Vec3; normal: Vec3 }, start: Vec3, endName: string, size: number): NamedResult {
  const k = ctx.k, oc = ctx.oc as Any;
  const side = (plane.normal[0] * (start[0] - plane.origin[0]) + plane.normal[1] * (start[1] - plane.origin[1]) + plane.normal[2] * (start[2] - plane.origin[2]));
  if (Math.abs(side) < 1e-7) throw ctx.fail("The sketch lies on the face to extrude up to. Pick a face away from the sketch.");
  const face = planeFace(k, plane.origin, plane.normal, size, ctx.own);
  const half = ctx.own(new oc.BRepPrimAPI_MakeHalfSpace(oc.TopoDS.Face(face), ctx.own(k.pnt(start))));
  const solid: Shape = ctx.own(half.Solid());
  const faces = k.namedFaces(long.shape, long.names, ctx.feature.id);
  const r = k.boolean("common", { shape: long.shape, faces }, { shape: solid, faces: relabel(k.namedFaces(solid, () => null, ctx.feature.id), endName) }, ctx.feature.id, ctx.own);
  const was = k.volume(long.shape), now = k.volume(r.shape);
  if (!k.solids(r.shape).length || Math.abs(was - now) <= 1e-9 * was) throw ctx.fail("The extrusion does not reach that face. Flip the direction or pick another face.");
  return r;
}

/**
 * Trim a long sweep at the bodies in its way.  Adding material (`into: false`), it stops at the first body it
 * meets; removing (`into: true`), it goes through material and stops where the material ends.  `startFace` is
 * where the sweep begins: only the pieces that touch it are kept.
 */
export function trimAtBodies(ctx: EvalContext, long: NamedResult, bodies: readonly { shape: Shape; topo: { faces: readonly NamedShape[] } }[], into: boolean, startFace: Shape, endName: string): NamedResult[] {
  const k = ctx.k, id = ctx.feature.id;
  if (!bodies.length) throw ctx.fail("There is no body for the extrusion to stop at.");
  const faces = k.namedFaces(long.shape, long.names, id);
  const other = bodies.length === 1 ? bodies[0].shape : compound(k, bodies.map((b) => b.shape), ctx.own);
  const otherFaces = relabel(bodies.flatMap((b) => b.topo.faces), endName);
  const r = k.boolean(into ? "common" : "cut", { shape: long.shape, faces }, { shape: other, faces: otherFaces }, id, ctx.own);
  const pieces = k.solids(r.shape).filter((s) => distance(k, s, startFace) < 1e-6);
  if (!pieces.length) throw ctx.fail(into ? "The extrusion does not start in a body: there is no material to cut up to." : "The extrusion starts inside a body. Use Remove, or start the sketch outside the body.");
  const was = k.volume(long.shape);
  if (pieces.length === 1 && Math.abs(k.volume(pieces[0]) - was) <= 1e-7 * was) throw ctx.fail("Nothing is in the way of the extrusion: there is no next face to stop at.");
  return pieces.map((shape) => ({ shape, names: r.names }));
}
