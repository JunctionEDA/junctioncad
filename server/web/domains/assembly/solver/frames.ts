// frames.ts — connector frames: moving them with a body, and applying what a mate stores about its two ends
// (flip, offset, rotation, reorientation) before the solver sees them.
//
// The parameters every mate may carry, all optional, applied here so that no mate file repeats them:
//
//   connector.flip        turn the connector over: z and y change sign (a half turn about x)
//   params.offsetX/Y/Z    move connector a's frame along its own axes, mm ("offset" in the dialog is Z)
//   params.rotation       then turn it about its z, degrees
//   params.reorient       quarter turns of connector b about its z (0 to 3): which way the second part faces
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { Frame, Vec3 } from "../../mechanical/api";
import { add, addScaled, applyPose, cross, qfromAxes, qrot, scale, unit, type Pose } from "./math";
import type { MateFrame } from "./types";

export function frameInWorld(pose: Pose, f: MateFrame): MateFrame {
  return { o: applyPose(pose, f.o), x: qrot(pose.q, f.x), y: qrot(pose.q, f.y), z: qrot(pose.q, f.z), surface: f.surface, radius: f.radius };
}
/** The frame as a pose: the placement that takes the world axes onto it. */
export function framePose(f: MateFrame): Pose { return { p: [f.o[0], f.o[1], f.o[2]], q: qfromAxes(f.x, f.y, f.z) }; }
export function frameOfPose(p: Pose): MateFrame { return { o: [p.p[0], p.p[1], p.p[2]], x: qrot(p.q, [1, 0, 0]), y: qrot(p.q, [0, 1, 0]), z: qrot(p.q, [0, 0, 1]) }; }

export function flipped(f: MateFrame): MateFrame { return { ...f, y: scale(f.y, -1), z: scale(f.z, -1) }; }
/** Turn a frame about its own z by `angle` radians. */
export function turned(f: MateFrame, angle: number): MateFrame {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { ...f, x: add(scale(f.x, c), scale(f.y, s)), y: add(scale(f.y, c), scale(f.x, -s)) };
}
export function shifted(f: MateFrame, d: Vec3): MateFrame { return { ...f, o: addScaled(addScaled(addScaled(f.o, f.x, d[0]), f.y, d[1]), f.z, d[2]) }; }

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Connector a of a mate as the solver takes it: flipped, offset and turned as the mate says. */
export function prepareA(f: MateFrame, flip: boolean | undefined, params: JsonObject): MateFrame {
  let out = flip ? flipped(f) : f;
  const d: Vec3 = [num(params.offsetX), num(params.offsetY), num(params.offsetZ) + num(params.offset)];
  if (d[0] || d[1] || d[2]) out = shifted(out, d);
  const r = num(params.rotation);
  if (r) out = turned(out, (r * Math.PI) / 180);
  return out;
}
/** Connector b of a mate as the solver takes it. */
export function prepareB(f: MateFrame, flip: boolean | undefined, params: JsonObject): MateFrame {
  let out = flip ? flipped(f) : f;
  const q = Math.round(num(params.reorient)) % 4;
  if (q) out = turned(out, (q * Math.PI) / 2);
  return out;
}

/** A mechanical-domain Frame (origin, x, y, normal) as a connector frame, and back. */
export function fromFrame(f: Frame): MateFrame { return { o: f.origin, x: f.x, y: f.y, z: f.normal }; }
export function toFrame(f: MateFrame): Frame { return { origin: f.o, x: f.x, y: f.y, normal: f.z }; }

/** A frame from an origin and a primary axis; x is chosen at right angles to it, the same way every time. */
export function frameFromAxis(o: Vec3, z: Vec3, xHint?: Vec3): MateFrame {
  const zz = unit(z);
  let x: Vec3;
  if (xHint && Math.abs(xHint[0] * zz[0] + xHint[1] * zz[1] + xHint[2] * zz[2]) < 0.999) x = unit(addScaled(xHint, zz, -(xHint[0] * zz[0] + xHint[1] * zz[1] + xHint[2] * zz[2])));
  else {
    const ax = Math.abs(zz[0]), ay = Math.abs(zz[1]), az = Math.abs(zz[2]);
    const e: Vec3 = ax <= ay + 1e-9 && ax <= az + 1e-9 ? [1, 0, 0] : ay <= az + 1e-9 ? [0, 1, 0] : [0, 0, 1];
    x = unit(addScaled(e, zz, -(e[0] * zz[0] + e[1] * zz[1] + e[2] * zz[2])));
  }
  return { o, x, y: cross(zz, x), z: zz };
}
