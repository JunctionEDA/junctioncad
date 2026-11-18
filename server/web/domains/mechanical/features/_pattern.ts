// _pattern.ts — the fields every pattern and the mirror share: copy features or bodies, and which.
import type { ParamField } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { patternBodies, patternFeatures, type Instance } from "../kernel/ops/pattern-core";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Feature types that make no material, so there is nothing of them to copy. */
export const NOT_COPYABLE = ["sketch", "plane", "axis", "point", "helix"];

export interface CopyParams { of: "features" | "bodies"; features: string[]; bodies: string[]; merge: boolean }

export const copyDefaults = (): CopyParams => ({ of: "features", features: [], bodies: [], merge: false });

export const copyFields = (verb: string): ParamField[] => [
  { key: "of", label: verb, kind: "enum", options: [{ value: "features", label: "Features" }, { value: "bodies", label: "Bodies" }] },
  { key: "features", label: "Features", kind: "features", exclude: NOT_COPYABLE, hint: "The features whose result is copied, as they are in the list above this one.", visible: (p) => p.of !== "bodies" },
  { key: "bodies", label: "Bodies", kind: "bodies", hint: "Leave empty for every body.", visible: (p) => p.of === "bodies" },
  { key: "merge", label: "Join to the original", kind: "boolean", hint: "Join each copy to the body it copies, instead of making new bodies.", visible: (p) => p.of === "bodies" },
];

/** Run the copy part of a pattern, once its instances are known. */
export function copyInstances(ctx: EvalContext, p: CopyParams & { [k: string]: any }, instances: Instance[], noun: string, reflect = false): void {
  if (p.of === "bodies") patternBodies(ctx, Array.isArray(p.bodies) ? p.bodies : [], instances, { reflect, merge: !!p.merge });
  else patternFeatures(ctx, Array.isArray(p.features) ? p.features : [], instances, { reflect, noun });
}

/** A whole number of copies, at least one, with a sentence when it is not. */
export function countOf(ctx: EvalContext, n: unknown, what: string): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1 || Math.round(v) !== v) throw ctx.fail(`The ${what} must be a whole number, one or more.`);
  if (v > 2000) throw ctx.fail(`The ${what} is too large (at most 2000).`);
  return v;
}
