// extrude.ts — the Extrude feature: sweep the closed regions of a sketch along the sketch's normal, as new
// bodies, added to the bodies they touch, removed from them, or intersected with them.
//
// End conditions: a depth ("blind"), a depth split evenly about the sketch ("symmetric"), through everything,
// up to a face, up to the next body in the way; an optional second direction, a draft angle, and a thin wall
// instead of a solid region.
//
// Names (CONTRACT.md "Geometry names"): caps `<id>:start:<region>` / `<id>:end:<region>`, sides
// `<id>:side:<sketch entity>`; a face the extrusion stops on is its end cap.  A thin wall's faces are
// `<id>:side:<entity>` on the outline and `<id>:side:<entity>:inner` / `:outer` offset from it.  Every end condition names the same faces the same way, so switching from a depth to
// "up to face" keeps the references later features hold.
import { defineFeature } from "../core/feature";
import { scale, type GeomRef, type Vec3 } from "../core/geometry";
import type { EvalContext, SketchRegion } from "../kernel/types";
import type { NamedResult } from "../kernel/occ";
import { combine, OPERATION_OPTIONS, scoped, type Operation, type Tool } from "../kernel/ops/combine";
import { draftFaces } from "../kernel/ops/draft";
import { trimAtBodies, trimAtPlane } from "../kernel/ops/extent";
import { moveNamed, reachPast } from "../kernel/ops/shapes";
import { thickWall } from "../kernel/ops/thick";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type EndType = "blind" | "symmetric" | "through" | "upToFace" | "upToNext";

export interface ExtrudeParams {
  [key: string]: any;
  /** the sketch, and which of its regions (null: all of them) */
  profile: { sketch: string; regions: string[] | null } | null;
  operation: Operation;
  /** how far the extrusion goes */
  endType: EndType;
  depth: number;
  /** the face "upToFace" stops at */
  face?: GeomRef | null;
  /** extrude against the sketch normal instead of along it */
  flip: boolean;
  /** a second extent on the other side of the sketch (blind or through all) */
  second?: boolean;
  secondType?: "blind" | "through";
  secondDepth?: number;
  /** taper the sides: degrees, positive narrows the extrusion as it goes */
  draft?: boolean;
  draftAngle?: number;
  /** a wall of this thickness along the region's outline instead of the whole region */
  thin?: boolean;
  thickness?: number;
  thinSide?: "inside" | "outside" | "both";
  /** the bodies Add, Remove and Intersect act on; empty means every body */
  targets: string[];
}

const END_OPTIONS = [
  { value: "blind", label: "Depth" }, { value: "symmetric", label: "Symmetric" }, { value: "through", label: "Through all" },
  { value: "upToFace", label: "Up to face" }, { value: "upToNext", label: "Up to next" },
];

export default defineFeature<ExtrudeParams>({
  type: "extrude",
  title: "Extrude",
  icon: '<path d="M5 14l7 4 7-4"/><path d="M5 14V9l7-4 7 4v5"/><path d="M5 9l7 4 7-4"/><path d="M12 13v5"/>',
  toolbarOrder: 20,
  defaults: () => ({
    profile: null, operation: "new", endType: "blind", depth: 10, face: null, flip: false,
    second: false, secondType: "blind", secondDepth: 10, draft: false, draftAngle: 3, thin: false, thickness: 1, thinSide: "inside", targets: [],
  }),
  schema: [
    { key: "profile", label: "Sketch to extrude", kind: "profile" },
    { key: "operation", label: "Result", kind: "enum", options: OPERATION_OPTIONS },
    { key: "endType", label: "End", kind: "enum", options: END_OPTIONS },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.001, step: 1, visible: (p) => p.endType === "blind" || p.endType === "symmetric" || !p.endType },
    { key: "face", label: "Up to", kind: "refs", of: ["face"], single: true, visible: (p) => p.endType === "upToFace" },
    { key: "flip", label: "Opposite direction", kind: "boolean", visible: (p) => p.endType !== "symmetric" },
    { key: "second", label: "Second direction", kind: "boolean", visible: (p) => p.endType !== "symmetric" },
    { key: "secondType", label: "Second end", kind: "enum", options: [{ value: "blind", label: "Depth" }, { value: "through", label: "Through all" }], visible: (p) => !!p.second && p.endType !== "symmetric" },
    { key: "secondDepth", label: "Second depth", kind: "number", unit: "mm", min: 0.001, step: 1, visible: (p) => !!p.second && p.endType !== "symmetric" && p.secondType !== "through" },
    { key: "draft", label: "Draft", kind: "boolean" },
    { key: "draftAngle", label: "Draft angle", kind: "number", unit: "deg", min: -45, max: 45, step: 0.5, hint: "Positive narrows the extrusion as it goes.", visible: (p) => !!p.draft },
    { key: "thin", label: "Thin wall", kind: "boolean" },
    { key: "thickness", label: "Wall", kind: "number", unit: "mm", min: 0.001, step: 0.5, visible: (p) => !!p.thin },
    { key: "thinSide", label: "Wall side", kind: "enum", options: [{ value: "inside", label: "Inside" }, { value: "outside", label: "Outside" }, { value: "both", label: "Both" }], visible: (p) => !!p.thin },
    { key: "targets", label: "Bodies to change", kind: "bodies", hint: "Leave empty for every body.", visible: (p) => p.operation !== "new" },
  ],

  evaluate(ctx: EvalContext, p: ExtrudeParams) {
    const k = ctx.k, id = ctx.feature.id;
    const end: EndType = p.endType || "blind";
    const op: Operation = p.operation || "new";
    if (!p.profile || !p.profile.sketch) throw ctx.fail("Pick a sketch to extrude.");
    if ((end === "blind" || end === "symmetric") && !(p.depth > 0)) throw ctx.fail("The depth must be more than zero.");
    if (end === "through" && (op === "new" || op === "add")) throw ctx.fail("Through all removes or intersects. To make material, use a depth or Up to face.");
    if (end === "upToFace" && (!p.face || !p.face.name)) throw ctx.fail("Pick the face to extrude up to.");
    const second = !!p.second && end !== "symmetric";
    if (second && p.secondType !== "through" && !(Number(p.secondDepth) > 0)) throw ctx.fail("The second depth must be more than zero.");
    if (p.thin && !(Number(p.thickness) > 0)) throw ctx.fail("The wall must be thicker than zero.");
    if (p.draft && !(Math.abs(Number(p.draftAngle)) > 0 && Math.abs(Number(p.draftAngle)) < 89)) throw ctx.fail("The draft angle must be between 0° and 89°.");

    const sketch = ctx.sketch(p.profile.sketch);
    const wanted = p.profile.regions;
    const regions = sketch.regions.filter((r) => !wanted || wanted.includes(r.id));
    if (!regions.length) throw ctx.fail(sketch.regions.length ? "The regions this feature used are gone from the sketch. Edit the feature and pick the sketch again." : "The sketch has no closed region to extrude. Close its outline first.");
    const n: Vec3 = scale(sketch.frame.normal, p.flip && end !== "symmetric" ? -1 : 1);
    const far = reachPast(k, ctx.bodies().map((b) => b.shape), sketch.frame.origin);
    const upFace = end === "upToFace" ? ctx.resolve(p.face as GeomRef) : null;
    if (upFace && upFace.kind !== "face") throw ctx.fail("Up to face needs a face.");

    // how far forward (along n) and back the extrusion reaches before any trimming
    const fwd = end === "blind" ? p.depth : end === "symmetric" ? p.depth / 2 : far;
    const back = end === "symmetric" ? p.depth / 2 : second ? (p.secondType === "through" ? far : Number(p.secondDepth)) : 0;

    const tools: Tool[] = [];
    for (const region of regions) {
      let t: NamedResult = p.thin
        ? thinPrism(ctx, region, Number(p.thickness), p.thinSide || "inside", scale(n, fwd + back))
        : k.prism(region.face, scale(n, fwd + back), id, region.id, region.edges, ctx.own);
      if (back) t = moveNamed(k, t.shape, t.names, { translate: scale(n, -back) }, ctx.own);
      if (p.draft) {
        const named = k.namedFaces(t.shape, t.names, id);
        const sides = named.filter((f) => !f.name.startsWith(`${id}:start:`) && !f.name.startsWith(`${id}:end:`)).map((f) => f.shape);
        // the neutral plane is the sketch; a positive angle narrows the extrusion away from it
        t = draftFaces(k, t.shape, named, sides, n, Number(p.draftAngle), { origin: sketch.frame.origin, normal: sketch.frame.normal }, id, ctx.own);
      }
      const endName = `${id}:end:${region.id}`;
      if (end === "upToFace" && upFace) {
        const frame = k.faceFrame(upFace.shape as any);
        if (frame) {
          const startPt = k.centre(region.face, "face");
          tools.push({ ...trimAtPlane(ctx, t, { origin: frame.origin, normal: frame.normal }, startPt, endName, far * 2), suffix: region.id });
        } else {
          for (const piece of trimAtBodies(ctx, t, [upFace.body], op === "remove", region.face, endName)) tools.push({ ...piece, suffix: region.id });
        }
      } else if (end === "upToNext") {
        const others = scoped(ctx, op === "new" ? [] : p.targets);
        for (const piece of trimAtBodies(ctx, t, others, op === "remove" || op === "intersect", region.face, endName)) tools.push({ ...piece, suffix: region.id });
      } else tools.push({ ...t, suffix: region.id });
    }
    combine(ctx, tools, op, p.targets);
  },
});

/**
 * A wall along a region's outline: the region's prism with both caps removed, hollowed by MakeThickSolid.  The
 * wall's faces offset from a side are `<side>:inner` (inside the outline) or `<side>:outer`.
 */
function thinPrism(ctx: EvalContext, region: SketchRegion, thickness: number, side: "inside" | "outside" | "both", along: Vec3): NamedResult {
  const k = ctx.k, id = ctx.feature.id;
  const solid = k.prism(region.face, along, id, region.id, region.edges, ctx.own);
  const named = k.namedFaces(solid.shape, solid.names, id);
  const caps = named.filter((f) => f.name.startsWith(`${id}:start:`) || f.name.startsWith(`${id}:end:`)).map((f) => f.shape);
  const wall = (offset: number, tag: string): NamedResult => {
    const r = thickWall(k, solid.shape, named, caps, offset, id, ctx.own);
    const from = `${id}:from(`;
    return { shape: r.shape, names: (f, i) => { const nm = r.names(f, i); return nm && nm.startsWith(from) && nm.endsWith(")") ? `${nm.slice(from.length, -1)}:${tag}` : nm; } };
  };
  if (side === "inside") return wall(-thickness, "inner");
  if (side === "outside") return wall(thickness, "outer");
  const a = wall(-thickness / 2, "inner"), b = wall(thickness / 2, "outer");
  const r = k.boolean("fuse", { shape: a.shape, faces: k.namedFaces(a.shape, a.names, id) }, { shape: b.shape, faces: k.namedFaces(b.shape, b.names, id) }, id, ctx.own);
  const solids = k.solids(r.shape);
  if (solids.length !== 1) throw ctx.fail("The wall could not be made. Try a thinner wall.");
  return { shape: solids[0], names: r.names };
}
