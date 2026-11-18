// circular-pattern.ts — the Circular pattern feature: copies of features or bodies turned about an axis.  With
// equal spacing the copies share the angle (all the way round: 360° / count; less than a full turn: from the
// original to the last copy); without, the angle is between neighbours.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { axisOf } from "../kernel/ops/ref-geom";
import { rotation, skipKeys, type Instance } from "../kernel/ops/pattern-core";
import { copyDefaults, copyFields, copyInstances, countOf, type CopyParams } from "./_pattern";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CircularPatternParams extends CopyParams {
  [key: string]: any;
  axis: RefTarget | null; count: number; angle: number; equal: boolean; flip: boolean; skip: string;
}

export default defineFeature<CircularPatternParams>({
  type: "circular-pattern",
  title: "Circular pattern",
  icon: '<circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="4.5" r="2"/><circle cx="19" cy="15" r="2" stroke-dasharray="2 1.5"/><circle cx="5" cy="15" r="2" stroke-dasharray="2 1.5"/>',
  toolbarOrder: 71,
  toolbarSection: "pattern", toolbarMenu: "Pattern",
  defaults: () => ({ ...copyDefaults(), axis: null, count: 4, angle: 360, equal: true, flip: false, skip: "" }),
  schema: [
    ...copyFields("Copy"),
    { key: "axis", label: "Axis", kind: "refs", of: ["edge", "face"], single: true, planes: true, datums: ["axis", "plane"], sketch: true, hint: "An axis, a round or straight edge, a cylindrical face, or a plane (about its normal)." },
    { key: "count", label: "Count", kind: "number", unit: "none", min: 1, step: 1 },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", step: 15 },
    { key: "equal", label: "Equal spacing", kind: "boolean", hint: "Spread the copies over the angle, instead of the angle between each." },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
    { key: "skip", label: "Skip", kind: "text", hint: "Copies to leave out, counting the original as 1: \"3, 5\"." },
  ],

  evaluate(ctx: EvalContext, p: CircularPatternParams) {
    const n = countOf(ctx, p.count, "count");
    if (!Number.isFinite(p.angle) || p.angle === 0) throw ctx.fail("The angle must be a number other than zero.");
    const axis = axisOf(ctx, p.axis, "axis");
    const full = Math.abs(Math.abs(p.angle) - 360) < 1e-9 || Math.abs(p.angle) > 360;
    const step = (p.equal ? (full ? p.angle / n : n > 1 ? p.angle / (n - 1) : 0) : p.angle) * (p.flip ? -1 : 1) * (Math.PI / 180);
    const skip = skipKeys(p.skip);
    const instances: Instance[] = [];
    for (let i = 1; i < n; i++) {
      const key = `i${i + 1}.1`;
      if (skip.has(key)) continue;
      instances.push({ key, trsf: rotation(ctx, axis.origin, axis.dir, step * i) });
    }
    if (n === 1) ctx.warn("A count of one makes no copies.");
    copyInstances(ctx, p, instances, "pattern");
  },
});
