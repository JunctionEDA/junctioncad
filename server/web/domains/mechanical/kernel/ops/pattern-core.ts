// pattern-core.ts — what Linear pattern, Circular pattern, Curve pattern and Mirror share: copies of bodies, or
// copies of what earlier features did, placed by rigid transforms (or a reflection).
//
// Patterning features does not evaluate those features again per copy.  The model before and after each seed
// feature (ctx.history) says what the feature removed (before − after) and added (after − before) to each body
// it changed; those two shapes are the tools.  Each copy is the tool moved (sharing its geometry: a moved
// shape is a location, not a new surface), and every copy goes into ONE cut and ONE fuse per body.  A seed that
// made a new body has its body copied.  This is exact for features whose effect does not depend on where they
// are (holes, pockets, bosses, ribs cut or added through the same material); a feature whose result depends on
// the geometry under each copy (a fillet along edges that differ) is copied as the seed made it.
//
// Names (CONTRACT.md "Geometry names"): a face of a copy is `<pattern id>:<instance key>:<the seed face's name>`.
// The key names the copy by its place in the pattern, not by its order of evaluation (`i3.2`: third along the
// first direction, second along the second; `m` for a mirror), so a reference to the third hole stays on the
// third hole when the count changes.
import type { Vec3 } from "../../core/geometry";
import { ShapeIndex, type NamedResult } from "../occ";
import type { Body, EvalContext, FaceNamer, NamedShape, Shape } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A shape with names on its faces, in the seed's place. */
export interface Tool { shape: Shape; faces: NamedShape[] }
/** What the seeds did to one body (by id): material they removed and material they added. */
export interface Effect { bodyId: string; remove: Tool[]; add: Tool[] }
/** One copy: where it goes, and the key its names carry. */
export interface Instance { key: string; trsf: any }

const tiny = (ctx: EvalContext, s: Shape) => !s || s.IsNull() || ctx.k.volume(s) < 1e-9;

/** Tools from a body shape and its names. */
function toolOf(ctx: EvalContext, r: NamedResult): Tool | null {
  if (tiny(ctx, r.shape)) return null;
  return { shape: r.shape, faces: ctx.k.namedFaces(r.shape, r.names, ctx.feature.id) };
}

/**
 * What the seed features did: per body they changed, the tools that redo it; and the bodies they made anew.
 * Fails with a sentence when a seed is not earlier in the tree or did not build.
 */
export function seedEffects(ctx: EvalContext, featureIds: readonly string[], noun: string): { effects: Effect[]; created: Body[] } {
  const k = ctx.k, id = ctx.feature.id;
  if (!featureIds.length) throw ctx.fail(`Pick the features to ${noun}.`);
  const effects = new Map<string, Effect>();
  const created: Body[] = [];
  for (const fid of featureIds) {
    const h = ctx.history(fid);
    if (!h) throw ctx.fail(`A feature to ${noun} is not above this one in the list. Move it up, or pick another.`);
    if (h.status === "error") throw ctx.fail(`A feature to ${noun} failed, so there is nothing to copy. Fix it first.`);
    if (h.status === "suppressed") continue;
    const after = new Map(h.after.bodies.map((b) => [b.id, b]));
    const vanished = h.before.bodies.filter((b) => !after.has(b.id));
    for (const ab of h.after.bodies) {
      const bb = h.before.bodies.find((b) => b.id === ab.id);
      if (!bb) { created.push(ab); continue; }
      if (bb.rev === ab.rev) continue;
      const e = effects.get(ab.id) || { bodyId: ab.id, remove: [], add: [] };
      const removed = toolOf(ctx, k.boolean("cut", { shape: bb.shape, faces: bb.topo.faces }, { shape: ab.shape, faces: ab.topo.faces }, id, ctx.own));
      let addedR: NamedResult = k.boolean("cut", { shape: ab.shape, faces: ab.topo.faces }, { shape: bb.shape, faces: bb.topo.faces }, id, ctx.own);
      // material of bodies the seed merged into this one is not part of what it added
      for (const v of vanished) {
        if (tiny(ctx, addedR.shape)) break;
        addedR = k.boolean("cut", { shape: addedR.shape, faces: k.namedFaces(addedR.shape, addedR.names, id) }, { shape: v.shape, faces: v.topo.faces }, id, ctx.own);
      }
      const added = toolOf(ctx, addedR);
      if (removed) e.remove.push(removed);
      if (added) e.add.push(added);
      if (removed || added) effects.set(ab.id, e);
    }
  }
  return { effects: Array.from(effects.values()), created };
}

/** A copy of a tool, moved: its faces renamed `<feature>:<key>:<name>`. */
export function placeTool(ctx: EvalContext, tool: Tool, inst: Instance, reflect = false): Tool {
  const oc = ctx.oc as any;
  // a rigid move only sets a location (the copy shares the seed's surfaces); a reflection needs new geometry
  const mk = ctx.tmp(new oc.BRepBuilderAPI_Transform(tool.shape, inst.trsf, reflect, false));
  const shape = ctx.own(mk.Shape());
  const faces = tool.faces.map((f) => ({ name: `${ctx.feature.id}:${inst.key}:${f.name}`, shape: ctx.own(mk.ModifiedShape(f.shape)) }));
  return { shape, faces };
}

/** Names for a shape from a list of named faces of it. */
export function namerOf(ctx: EvalContext, faces: readonly NamedShape[]): FaceNamer {
  const index = new ShapeIndex<string>(ctx.k);
  for (const f of faces) index.add(f.shape, f.name);
  return (face) => index.get(face) ?? null;
}

/**
 * `base` with every tool cut out of it ("cut") or joined to it ("fuse"), in one boolean: the tools are the
 * operation's tool list, so they may overlap one another.  Names are carried as k.boolean carries them.
 */
export function booleanMany(ctx: EvalContext, op: "cut" | "fuse", base: { shape: Shape; faces: readonly NamedShape[] }, tools: readonly Tool[]): NamedResult {
  const oc = ctx.oc as any, k = ctx.k;
  const algo = ctx.own(op === "cut" ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Fuse());
  const args = ctx.tmp(new oc.NCollection_List_TopoDS_Shape()), list = ctx.tmp(new oc.NCollection_List_TopoDS_Shape());
  args.Append(base.shape);
  for (const t of tools) list.Append(t.shape);
  algo.SetArguments(args);
  algo.SetTools(list);
  algo.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!algo.IsDone() || algo.HasErrors()) throw ctx.fail(op === "cut" ? "The copies could not be cut from the body." : "The copies could not be joined to the body.");
  algo.SimplifyResult(true, true, 1e-4);
  const shape = ctx.own(algo.Shape());
  const inputs: NamedShape[] = [...base.faces];
  for (const t of tools) inputs.push(...t.faces);
  return { shape, names: k.carryNames(shape, algo, inputs, ctx.feature.id) };
}

/** Replace a body with a boolean's result; extra solids it fell into become bodies of their own. */
function settle(ctx: EvalContext, body: Body, r: NamedResult): Body | null {
  const solids = ctx.k.solids(r.shape);
  if (!solids.length) { ctx.removeBody(body); return null; }
  const next = ctx.replaceBody(body, solids[0], r.names);
  solids.slice(1).forEach((s, n) => ctx.addBody(s, r.names, { suffix: `${body.id}.piece${n + 2}`, name: `${body.name} (${n + 2})` }));
  return next;
}

/**
 * Copy what the seeds did to the instances: for each body a seed changed, one cut with every removal copy and
 * one fuse with every addition copy; each body a seed made is copied as a new body.  Returns how many copies
 * changed something.
 */
export function patternFeatures(ctx: EvalContext, featureIds: readonly string[], instances: readonly Instance[], o: { reflect?: boolean; noun: string }): void {
  const { effects, created } = seedEffects(ctx, featureIds, o.noun);
  if (!effects.length && !created.length) throw ctx.fail(`The features to ${o.noun} did not change the model.`);
  if (!instances.length) { ctx.warn("Nothing was copied: every copy is skipped."); return; }
  let missing = 0;
  for (const e of effects) {
    let body = ctx.body(e.bodyId);
    if (!body) { missing++; continue; }
    if (e.remove.length) {
      const tools = instances.flatMap((inst) => e.remove.map((t) => placeTool(ctx, t, inst, o.reflect)));
      body = settle(ctx, body, booleanMany(ctx, "cut", { shape: body.shape, faces: body.topo.faces }, tools)) || undefined;
      if (!body) continue;
    }
    if (e.add.length) {
      const tools = instances.flatMap((inst) => e.add.map((t) => placeTool(ctx, t, inst, o.reflect)));
      settle(ctx, body, booleanMany(ctx, "fuse", { shape: body.shape, faces: body.topo.faces }, tools));
    }
  }
  for (const b of created) copyBody(ctx, b, instances, o.reflect);
  if (missing) ctx.warn(`${missing === 1 ? "A body" : `${missing} bodies`} the features changed no longer exist${missing === 1 ? "s" : ""} here, so ${missing === 1 ? "it was" : "they were"} left out.`);
}

/** New bodies: copies of `body` at each instance. */
export function copyBody(ctx: EvalContext, body: Body, instances: readonly Instance[], reflect = false): Body[] {
  return instances.map((inst) => {
    const t = placeTool(ctx, { shape: body.shape, faces: body.topo.faces }, inst, reflect);
    return ctx.addBody(t.shape, namerOf(ctx, t.faces), { suffix: `${body.id}.${inst.key}`, name: `${body.name} (${inst.key})` });
  });
}

/** Copies of whole bodies; `merge` joins each copy to its original instead of making new bodies. */
export function patternBodies(ctx: EvalContext, bodyIds: readonly string[], instances: readonly Instance[], o: { reflect?: boolean; merge?: boolean }): void {
  const bodies = bodyIds.length ? bodyIds.map((id) => ctx.body(id)).filter((b): b is Body => !!b) : ctx.bodies().slice();
  if (!bodies.length) throw ctx.fail(bodyIds.length ? "The bodies to copy no longer exist." : "There is no body to copy.");
  if (bodyIds.length && bodies.length < bodyIds.length) ctx.warn("Some of the bodies to copy no longer exist.");
  if (!instances.length) { ctx.warn("Nothing was copied: every copy is skipped."); return; }
  for (const b of bodies) {
    if (!o.merge) { copyBody(ctx, b, instances, o.reflect); continue; }
    const tools = instances.map((inst) => placeTool(ctx, { shape: b.shape, faces: b.topo.faces }, inst, o.reflect));
    settle(ctx, b, booleanMany(ctx, "fuse", { shape: b.shape, faces: b.topo.faces }, tools));
  }
}

// ---------------------------------------------------------------- transforms

export function translation(ctx: EvalContext, v: Vec3): any {
  const oc = ctx.oc as any;
  const t = ctx.own(new oc.gp_Trsf());
  t.SetTranslation(ctx.tmp(ctx.k.vec(v)));
  return t;
}

/** A turn of `angle` radians about the axis through `origin` along `dir`, then a move by `then` (optional). */
export function rotation(ctx: EvalContext, origin: Vec3, dir: Vec3, angle: number, then?: Vec3): any {
  const oc = ctx.oc as any, k = ctx.k;
  const t = ctx.own(new oc.gp_Trsf());
  t.SetRotation(ctx.tmp(new oc.gp_Ax1(ctx.tmp(k.pnt(origin)), ctx.tmp(k.dir(dir)))), angle);
  if (then) {
    const m = ctx.tmp(new oc.gp_Trsf());
    m.SetTranslation(ctx.tmp(k.vec(then)));
    t.PreMultiply(m);
  }
  return t;
}

/** The reflection in the plane through `origin` with normal `normal`. */
export function reflection(ctx: EvalContext, origin: Vec3, normal: Vec3): any {
  const oc = ctx.oc as any, k = ctx.k;
  const t = ctx.own(new oc.gp_Trsf());
  t.SetMirror(ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt(origin)), ctx.tmp(k.dir(normal)))));
  return t;
}

/**
 * Which copies to leave out, from text like "3, 2.4": numbers count from 1 (the seed), a second number after a
 * dot is the place along the second direction.  Returns keys as patterns name them (`i3.1`, `i2.4`).
 */
export function skipKeys(text: unknown): Set<string> {
  const out = new Set<string>();
  for (const part of String(text || "").split(/[,;\s]+/)) {
    const m = part.match(/^(\d+)(?:\.(\d+))?$/);
    if (m) out.add(`i${Number(m[1])}.${m[2] ? Number(m[2]) : 1}`);
  }
  return out;
}
