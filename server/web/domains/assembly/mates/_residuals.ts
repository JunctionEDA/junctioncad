// _residuals.ts — the pieces mates are made of: residuals between two connector frames, the values a mate
// leaves free, and the dialog fields mates share.  A mate file picks from these; see revolute.ts for the shape.
//
// A residual is zero when its condition holds.  Positions are millimetres; a difference of unit vectors is
// multiplied by `reach` (about the size of the assembly) so a solver step treats both kinds alike.  The frames
// are in assembly space with flip, offset and reorientation already applied (solver/frames.ts).
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { Frame, ParamField } from "../../mechanical/api";
import type { Transform } from "../document/format";
import { fromFrame } from "../solver/frames";
import { dot, poseOf, sub, transformOf } from "../solver/math";
import { placeAlone } from "../solver/solver";
import type { MateFrame, MateSolve, MateValue } from "../solver/types";

/** the two origins are one point (3) */
export function coincident(a: MateFrame, b: MateFrame, out: number[]): void { out.push(b.o[0] - a.o[0], b.o[1] - a.o[1], b.o[2] - a.o[2]); }
/** the primary axes point the same way (3 residuals, 2 conditions) */
export function sameZ(a: MateFrame, b: MateFrame, reach: number, out: number[]): void { out.push(reach * (b.z[0] - a.z[0]), reach * (b.z[1] - a.z[1]), reach * (b.z[2] - a.z[2])); }
/** the secondary axes point the same way: with sameZ, no rotation is left */
export function sameX(a: MateFrame, b: MateFrame, reach: number, out: number[]): void { out.push(reach * (b.x[0] - a.x[0]), reach * (b.x[1] - a.x[1]), reach * (b.x[2] - a.x[2])); }
/** b's origin is on a's primary axis (2) */
export function onAxis(a: MateFrame, b: MateFrame, out: number[]): void { const d = sub(b.o, a.o); out.push(dot(d, a.x), dot(d, a.y)); }
/** b's origin is in a's plane (1) */
export function inPlane(a: MateFrame, b: MateFrame, out: number[]): void { out.push(dot(sub(b.o, a.o), a.z)); }

/** how far b is turned about a's primary axis, radians in (−π, π] */
export const angleAboutZ = (a: MateFrame, b: MateFrame): number => Math.atan2(dot(b.x, a.y), dot(b.x, a.x));
export const alongZ = (a: MateFrame, b: MateFrame): number => dot(sub(b.o, a.o), a.z);
export const alongX = (a: MateFrame, b: MateFrame): number => dot(sub(b.o, a.o), a.x);

export const ANGLE: MateValue = { key: "angle", label: "Angle", unit: "deg", measure: angleAboutZ };
export const DISTANCE: MateValue = { key: "distance", label: "Distance", unit: "mm", measure: alongZ };

// ---------------------------------------------------------------- dialog fields mates share
export const OFFSET: ParamField = { key: "offset", label: "Offset", kind: "number", unit: "mm", hint: "The distance between the two connectors along their axis." };
export const ROTATION: ParamField = { key: "rotation", label: "Rotation", kind: "number", unit: "deg", hint: "Turn the second part about the connector's axis." };

/** The fields that limit a mate's values: a switch, then a lowest and a highest for each value. */
export function limitFields(values: MateValue[]): ParamField[] {
  const out: ParamField[] = [{ key: "limits", label: "Limits", kind: "boolean", hint: "Stop the motion at a lowest and a highest value." }];
  for (const v of values) {
    out.push({ key: v.key + "Min", label: `${v.label}, lowest`, kind: "number", unit: v.unit, visible: (p) => !!p.limits });
    out.push({ key: v.key + "Max", label: `${v.label}, highest`, kind: "number", unit: v.unit, visible: (p) => !!p.limits });
  }
  return out;
}
export function limitDefaults(values: MateValue[]): JsonObject {
  const out: JsonObject = { limits: false };
  for (const v of values) { out[v.key + "Min"] = v.unit === "deg" ? -90 : -10; out[v.key + "Max"] = v.unit === "deg" ? 90 : 10; }
  return out;
}

/** `place` for any mate with a `solve`: its second instance alone, moved as little as the mate allows. */
export function placeWith(s: MateSolve): (a: Frame, b: Frame, bNow: Transform, params: JsonObject) => Transform {
  return (a, b, bNow, params) => transformOf(placeAlone(s, fromFrame(a), fromFrame(b), poseOf(bNow), params));
}
