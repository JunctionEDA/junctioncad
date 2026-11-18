// linear-pattern.ts — the Linear pattern feature: copies of features or bodies in a row, or in a grid with a
// second direction, at a fixed spacing; any copy can be skipped.  The copies are placed by kernel/ops/
// pattern-core.ts, which cuts or joins all of them in one boolean per body.
import { defineFeature } from "../core/feature";
import { add, scale } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { axisOf } from "../kernel/ops/ref-geom";
import { skipKeys, translation, type Instance } from "../kernel/ops/pattern-core";
import { copyDefaults, copyFields, copyInstances, countOf, type CopyParams } from "./_pattern";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface LinearPatternParams extends CopyParams {
  [key: string]: any;
  direction: RefTarget | null; spacing: number; count: number; flip: boolean;
  second: boolean; direction2: RefTarget | null; spacing2: number; count2: number; flip2: boolean;
  skip: string;
}

const DIRECTION = { kind: "refs" as const, of: ["edge" as const, "face" as const], single: true, planes: true, datums: ["axis" as const, "plane" as const], sketch: true, hint: "A straight edge, a flat face or plane (its normal), or an axis." };

export default defineFeature<LinearPatternParams>({
  type: "linear-pattern",
  title: "Linear pattern",
  icon: '<rect x="3" y="9" width="5" height="5"/><rect x="10" y="9" width="5" height="5" stroke-dasharray="2 1.5"/><rect x="17" y="9" width="4" height="5" stroke-dasharray="2 1.5"/>',
  toolbarOrder: 70,
  toolbarSection: "pattern", toolbarMenu: "Pattern",
  defaults: () => ({ ...copyDefaults(), direction: null, spacing: 10, count: 3, flip: false, second: false, direction2: null, spacing2: 10, count2: 2, flip2: false, skip: "" }),
  schema: [
    ...copyFields("Copy"),
    { key: "direction", label: "Direction", ...DIRECTION },
    { key: "spacing", label: "Spacing", kind: "number", unit: "mm", step: 1 },
    { key: "count", label: "Count", kind: "number", unit: "none", min: 1, step: 1 },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
    { key: "second", label: "Second direction", kind: "boolean" },
    { key: "direction2", label: "Direction 2", ...DIRECTION, visible: (p) => !!p.second },
    { key: "spacing2", label: "Spacing 2", kind: "number", unit: "mm", step: 1, visible: (p) => !!p.second },
    { key: "count2", label: "Count 2", kind: "number", unit: "none", min: 1, step: 1, visible: (p) => !!p.second },
    { key: "flip2", label: "Opposite direction 2", kind: "boolean", visible: (p) => !!p.second },
    { key: "skip", label: "Skip", kind: "text", hint: "Copies to leave out, counting the original as 1: \"3\", or \"2.3\" for column 2, row 3." },
  ],

  evaluate(ctx: EvalContext, p: LinearPatternParams) {
    const n1 = countOf(ctx, p.count, "count");
    if (!Number.isFinite(p.spacing)) throw ctx.fail("The spacing must be a number.");
    const d1 = scale(axisOf(ctx, p.direction, "direction").dir, (p.flip ? -1 : 1) * p.spacing);
    let n2 = 1, d2: [number, number, number] = [0, 0, 0];
    if (p.second) {
      n2 = countOf(ctx, p.count2, "second count");
      if (!Number.isFinite(p.spacing2)) throw ctx.fail("The second spacing must be a number.");
      d2 = scale(axisOf(ctx, p.direction2, "second direction").dir, (p.flip2 ? -1 : 1) * p.spacing2);
    }
    if (n1 * n2 > 2500) throw ctx.fail("That is too many copies (at most 2500).");
    const skip = skipKeys(p.skip);
    const instances: Instance[] = [];
    for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
      if (!i && !j) continue;
      const key = `i${i + 1}.${j + 1}`;
      if (skip.has(key)) continue;
      instances.push({ key, trsf: translation(ctx, add(scale(d1, i), scale(d2, j))) });
    }
    if (n1 * n2 === 1) ctx.warn("A count of one makes no copies.");
    copyInstances(ctx, p, instances, "pattern");
  },
});
