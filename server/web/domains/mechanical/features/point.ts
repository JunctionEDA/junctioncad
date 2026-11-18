// point.ts — the Point feature: a reference point.  At a vertex, the centre of a round edge, the middle of an
// edge or the centre of a face (each with an optional offset), or at typed coordinates.
import { defineFeature } from "../core/feature";
import { add } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { pointOf } from "../kernel/ops/ref-geom";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PointParams { [key: string]: any; method: "reference" | "coordinates"; ref: RefTarget | null; x: number; y: number; z: number }

export default defineFeature<PointParams>({
  type: "point",
  title: "Point",
  icon: '<circle cx="12" cy="12" r="2.5"/><path d="M12 3v5M12 16v5M3 12h5M16 12h5"/>',
  toolbarOrder: 62,
  toolbarSection: "reference", toolbarMenu: "Reference",
  defaults: () => ({ method: "reference", ref: null, x: 0, y: 0, z: 0 }),
  schema: [
    { key: "method", label: "Placed", kind: "enum", options: [{ value: "reference", label: "On geometry" }, { value: "coordinates", label: "Coordinates" }] },
    { key: "ref", label: "At", kind: "refs", of: ["vertex", "edge", "face"], single: true, datums: ["point", "axis", "plane"], sketch: true, hint: "A vertex, an edge (its middle, or a circle's centre) or a face (its centre).", visible: (p) => p.method !== "coordinates" },
    { key: "x", label: "X", kind: "number", unit: "mm", hint: "Offset from the reference, or the coordinate." },
    { key: "y", label: "Y", kind: "number", unit: "mm" },
    { key: "z", label: "Z", kind: "number", unit: "mm" },
  ],

  evaluate(ctx: EvalContext, p: PointParams) {
    const off: [number, number, number] = [Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0];
    const at = p.method === "coordinates" ? off : add(pointOf(ctx, p.ref, "vertex, edge or face"), off);
    ctx.setDatum({ featureId: ctx.feature.id, kind: "point", at });
  },
});
