// combine.ts — what Extrude, Revolve and Hole do with the solids they make: keep them as new bodies, add them
// to the bodies they touch, remove them from bodies, or keep only where they overlap.  One place, so every
// feature that makes material treats the "merge scope" (the bodies it may change) the same way.
//
// Names are carried through every boolean (Kernel.boolean / carryNames): the body being changed goes first, so
// a face it had keeps its name; the tool's faces keep the names the feature gave them.
import type { NamedResult } from "../occ";
import type { Body, EvalContext, NamedShape, Shape } from "../types";

export type Operation = "new" | "add" | "remove" | "intersect";

export const OPERATION_OPTIONS = [
  { value: "new", label: "New" }, { value: "add", label: "Add" }, { value: "remove", label: "Remove" }, { value: "intersect", label: "Intersect" },
];

export interface Tool extends NamedResult {
  /** tells apart several bodies one feature makes ("new"), e.g. the region id */
  suffix?: string;
}

/** The bodies a feature may change: those listed, or every body when the list is empty. */
export function scoped(ctx: EvalContext, targets: readonly string[] | null | undefined): Body[] {
  const all = ctx.bodies();
  if (!targets || !targets.length) return all.slice();
  const out = all.filter((b) => targets.includes(b.id));
  if (!out.length) throw ctx.fail("The bodies this feature should change are gone. Edit it and pick them again.");
  return out;
}

const changedVolume = (ctx: EvalContext, before: Shape, after: Shape) => {
  const was = ctx.k.volume(before), now = ctx.k.volume(after);
  return Math.abs(was - now) > 1e-9 * Math.max(1, was);
};

/** The faces of a tool with their names settled: what booleans take as input. */
export function toolFaces(ctx: EvalContext, t: NamedResult): NamedShape[] { return ctx.k.namedFaces(t.shape, t.names, ctx.feature.id); }

/** Several tools as one (they may overlap), names kept. */
export function fuseTools(ctx: EvalContext, tools: readonly Tool[]): Tool {
  let acc: Tool = tools[0];
  for (const t of tools.slice(1)) {
    const r = ctx.k.boolean("fuse", { shape: acc.shape, faces: toolFaces(ctx, acc) }, { shape: t.shape, faces: toolFaces(ctx, t) }, ctx.feature.id, ctx.own);
    acc = { shape: r.shape, names: r.names };
  }
  return acc;
}

/** Replace a body by the solids of a result: the first keeps the body's id, the others become bodies of their own. */
function replaceWithPieces(ctx: EvalContext, body: Body, r: NamedResult): Body | null {
  const solids = ctx.k.solids(r.shape);
  if (!solids.length) { ctx.removeBody(body); return null; }
  const next = ctx.replaceBody(body, solids[0], r.names);
  solids.slice(1).forEach((s: Shape, n: number) => ctx.addBody(s, r.names, { suffix: `${body.id}.piece${n + 2}`, name: `${body.name} (${n + 2})` }));
  return next;
}

/**
 * Apply the tools a feature made to the model.  `targets` is the merge scope (empty: every body).
 *   new        each tool becomes a body
 *   add        each tool joins every body in scope it touches into one; touching none, it becomes a body
 *   remove     the tools are cut from every body in scope (a body cut in two becomes two bodies)
 *   intersect  every body in scope that a tool reaches keeps only what lies inside the tools
 */
export function combine(ctx: EvalContext, tools: readonly Tool[], op: Operation, targets: readonly string[] | null | undefined): void {
  const k = ctx.k, id = ctx.feature.id;
  if (!tools.length) return;
  if (op === "new") {
    tools.forEach((t) => ctx.addBody(t.shape, t.names, { suffix: tools.length > 1 ? t.suffix : undefined }));
    return;
  }
  if (op === "remove") {
    const bodies = scoped(ctx, targets);
    if (!bodies.length) throw ctx.fail("There is no body to remove material from.");
    let changed = false;
    for (const start of bodies) {
      let body: Body | null = start;
      for (const t of tools) {
        if (!body) break;
        const r = k.boolean("cut", { shape: body.shape, faces: body.topo.faces }, { shape: t.shape, faces: toolFaces(ctx, t) }, id, ctx.own);
        if (!changedVolume(ctx, body.shape, r.shape)) continue;   // this tool does not reach into this body
        changed = true;
        body = replaceWithPieces(ctx, body, r);
      }
    }
    if (!changed) ctx.warn("Nothing was removed: the new shape does not reach into a body.");
    return;
  }
  if (op === "intersect") {
    const bodies = scoped(ctx, targets);
    if (!bodies.length) throw ctx.fail("There is no body to intersect with.");
    const tool = fuseTools(ctx, tools);
    const faces = toolFaces(ctx, tool);
    let changed = false;
    for (const body of bodies) {
      const r = k.boolean("common", { shape: body.shape, faces: body.topo.faces }, { shape: tool.shape, faces }, id, ctx.own);
      if (!k.solids(r.shape).length) continue;   // they do not overlap: the body is left alone
      if (!changedVolume(ctx, body.shape, r.shape)) continue;
      changed = true;
      replaceWithPieces(ctx, body, r);
    }
    if (!changed) ctx.warn("Nothing changed: the new shape does not overlap a body.");
    return;
  }
  // add: each tool joins every body it touches into one; touching none, it becomes a body of its own
  const inScope = new Set(scoped(ctx, targets).map((b) => b.id));
  tools.forEach((t) => {
    let host: Body | null = null;
    for (const body of ctx.bodies().filter((b) => inScope.has(b.id))) {
      const r: NamedResult = host
        ? k.boolean("fuse", { shape: host.shape, faces: host.topo.faces }, { shape: body.shape, faces: body.topo.faces }, id, ctx.own)
        : k.boolean("fuse", { shape: body.shape, faces: body.topo.faces }, { shape: t.shape, faces: toolFaces(ctx, t) }, id, ctx.own);
      const solids = k.solids(r.shape);
      if (solids.length !== 1) continue;   // they do not touch: both stay as they are
      if (host) { ctx.removeBody(body); host = ctx.replaceBody(host, solids[0], r.names); }
      else host = ctx.replaceBody(body, solids[0], r.names);
    }
    if (!host) ctx.addBody(t.shape, t.names, { suffix: tools.length > 1 ? t.suffix : undefined });
  });
}
