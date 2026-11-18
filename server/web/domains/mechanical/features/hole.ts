// hole.ts — the Hole feature: simple, counterbored or countersunk holes, through or to a depth, at the points
// of a sketch.  A hole goes at every point of the sketch that is on no curve, and at the centre of every circle,
// drilling into the material from the sketch's plane (against its normal: a sketch on a face drills into the
// body).  Standard metric sizes come from a table (kernel/ops/holes.ts): clearance holes for a bolt (close,
// normal, loose fit) or the tap drill for a thread.
//
// Names: `<id>:<point id>:wall`, `:floor`, `:cbore`, `:cbore-floor`, `:csink`; the point id is the sketch point
// the hole stands on (a circle's centre point), so a hole keeps its names when the sketch is edited.
import { defineFeature } from "../core/feature";
import { scale, toWorld, type Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { combine, type Tool } from "../kernel/ops/combine";
import { holeTool, METRIC, standardHole, type HoleFit, type HoleKind, type HoleSize } from "../kernel/ops/holes";
import { reachPast } from "../kernel/ops/shapes";
import { scoped } from "../kernel/ops/combine";
import { pointOf } from "../sketch/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HoleParams {
  [key: string]: any;
  /** the sketch whose points place the holes */
  points: { sketch: string; regions: string[] | null } | null;
  holeType: HoleKind;
  /** "custom", or a size of the metric table ("M3") */
  standard: string;
  fit: HoleFit;
  diameter: number;
  cboreDiameter: number;
  cboreDepth: number;
  csinkDiameter: number;
  csinkAngle: number;
  endType: "through" | "blind";
  depth: number;
  tipAngle: number;
  flip: boolean;
  targets: string[];
}

const custom = (p: { [k: string]: any }) => !p.standard || p.standard === "custom";

export default defineFeature<HoleParams>({
  type: "hole",
  title: "Hole",
  icon: '<ellipse cx="12" cy="6" rx="6" ry="2"/><path d="M6 6v4l3 2v7M18 6v4l-3 2v7"/><path d="M9 19c0 .8 1.3 1.5 3 1.5s3-.7 3-1.5"/>',
  toolbarOrder: 36,
  defaults: () => ({
    points: null, holeType: "simple", standard: "M3", fit: "normal", diameter: 3.4, cboreDiameter: 6.5, cboreDepth: 3.3, csinkDiameter: 6.9, csinkAngle: 90,
    endType: "through", depth: 10, tipAngle: 118, flip: false, targets: [],
  }),
  schema: [
    { key: "points", label: "Sketch with points", kind: "profile", hint: "A hole goes at each loose point and at the centre of each circle." },
    { key: "holeType", label: "Type", kind: "enum", options: [{ value: "simple", label: "Simple" }, { value: "cbore", label: "Counterbore" }, { value: "csink", label: "Countersink" }] },
    { key: "standard", label: "Size", kind: "enum", options: [{ value: "custom", label: "Custom" }, ...Object.keys(METRIC).map((m) => ({ value: m, label: m }))] },
    { key: "fit", label: "For", kind: "enum", options: [{ value: "close", label: "Close" }, { value: "normal", label: "Normal" }, { value: "loose", label: "Loose" }, { value: "tapped", label: "Tapped" }], hint: "Close, normal or loose clearance for a bolt; Tapped drills for a thread.", visible: (p) => !custom(p) },
    { key: "diameter", label: "Diameter", kind: "number", unit: "mm", min: 0.01, step: 0.1, visible: custom },
    { key: "cboreDiameter", label: "Counterbore Ø", kind: "number", unit: "mm", min: 0.01, step: 0.1, visible: (p) => custom(p) && p.holeType === "cbore" },
    { key: "cboreDepth", label: "Counterbore depth", kind: "number", unit: "mm", min: 0.01, step: 0.1, visible: (p) => custom(p) && p.holeType === "cbore" },
    { key: "csinkDiameter", label: "Countersink Ø", kind: "number", unit: "mm", min: 0.01, step: 0.1, visible: (p) => custom(p) && p.holeType === "csink" },
    { key: "csinkAngle", label: "Countersink angle", kind: "number", unit: "deg", min: 1, max: 179, step: 1, visible: (p) => custom(p) && p.holeType === "csink" },
    { key: "endType", label: "End", kind: "enum", options: [{ value: "through", label: "Through all" }, { value: "blind", label: "Depth" }] },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.01, step: 1, visible: (p) => p.endType === "blind" },
    { key: "tipAngle", label: "Drill point", kind: "number", unit: "deg", min: 1, max: 180, step: 1, hint: "180 for a flat bottom.", visible: (p) => p.endType === "blind" },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
    { key: "targets", label: "Bodies to drill", kind: "bodies", hint: "Leave empty for every body." },
  ],

  evaluate(ctx: EvalContext, p: HoleParams) {
    const k = ctx.k, id = ctx.feature.id;
    if (!p.points || !p.points.sketch) throw ctx.fail("Pick a sketch whose points place the holes.");
    const sketch = ctx.sketch(p.points.sketch);
    const data = sketch.data;
    // loose points and circle centres
    const used = new Set<string>();
    for (const e of Object.values(data.entities)) {
      if (e.type === "line") { used.add(e.a); used.add(e.b); }
      else if (e.type === "arc") { used.add(e.center); used.add(e.start); used.add(e.end); }
    }
    const at: string[] = [];
    for (const [eid, e] of Object.entries(data.entities).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (e.type === "point" && !used.has(eid) && !Object.values(data.entities).some((c) => c.type === "circle" && c.center === eid && c.construction)) {
        if (!at.includes(eid)) at.push(eid);
      }
    }
    if (!at.length) throw ctx.fail("The sketch has no point to put a hole at. Draw a circle (or a point) where each hole goes.");

    let size: HoleSize | null;
    if (custom(p)) size = { diameter: p.diameter, cboreDiameter: p.cboreDiameter, cboreDepth: p.cboreDepth, csinkDiameter: p.csinkDiameter, csinkAngle: p.csinkAngle };
    else {
      size = standardHole(p.standard, p.fit || "normal");
      if (!size) throw ctx.fail(`The size table has no ${p.standard}. Pick another size, or Custom.`);
    }
    const kind: HoleKind = p.holeType || "simple";
    const through = p.endType !== "blind";
    if (!through && !(p.depth > 0)) throw ctx.fail("The depth must be more than zero.");
    const dir: Vec3 = scale(sketch.frame.normal, p.flip ? 1 : -1);
    const bodies = scoped(ctx, p.targets);
    if (!bodies.length) throw ctx.fail("There is no body to drill.");

    const tools: Tool[] = at.map((pid) => {
      const q = pointOf(data, pid)!;
      const w = toWorld(sketch.frame, q);
      const depth = through ? reachPast(k, bodies.map((b) => b.shape), w) : p.depth;
      return { ...holeTool(k, { kind, size: size!, depth, through, tipAngle: p.tipAngle || 118 }, w, dir, sketch.frame.x, `${id}:${pid}`, ctx.own), suffix: pid };
    });
    combine(ctx, tools, "remove", p.targets);
  },
});
