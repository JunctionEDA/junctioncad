// problem.ts — from the document to the solver and back: which instances are bodies, which mates are active,
// where each mate's connectors are on its parts, and what to tell a person about each mate afterwards.
//
// Pure: the geometry is asked for through an interface, so the node tests feed it meshes straight from the
// kernel and the editor feeds it what the source documents have loaded (sources/manager.ts).
import type { GeomRef } from "../../mechanical/api";
import type { MateDefinition } from "../core/mate";
import type { ConnectorItem } from "../document/edits";
import { transformOf as storedTransform, type InstanceItem, type MateConnector, type MateItem } from "../document/format";
import { flipped, frameInWorld, prepareA, prepareB, shifted, turned } from "../solver/frames";
import { poseOf, type Pose } from "../solver/math";
import { solve } from "../solver/solver";
import type { MateFrame, SolveOptions, SolveResult, SolverBody, SolverMate } from "../solver/types";

export interface Geometry {
  /**
   * The connector frame of named geometry of an instance, in the instance's own space.  null: the instance has
   * no geometry of that name (it was deleted or renamed upstream).  undefined: the instance's source is still
   * loading, so nothing can be said yet.
   */
  frame(instance: InstanceItem, ref: GeomRef): MateFrame | null | undefined;
  /** The middle of an instance's geometry in its own space, when known: the point the solver turns it about. */
  centre?(instance: InstanceItem): [number, number, number] | null;
}

export type MateState = "ok" | "conflict" | "error" | "suppressed" | "inactive" | "pending" | "unknown-type";
export interface MateInfo {
  state: MateState;
  /** why, in a sentence a person can act on */
  message?: string;
  /** the mate's values as solved (mm, degrees) */
  values: { [key: string]: number };
}

export interface Problem {
  bodies: SolverBody[];
  mates: SolverMate[];
  /** what is already known about the mates that are not handed to the solver */
  info: Map<string, MateInfo>;
}

/** One end of a mate as a frame in its instance's space: through an explicit connector when it names one. */
export function endFrame(end: MateConnector, instance: InstanceItem, connectors: ReadonlyMap<string, ConnectorItem>, geometry: Geometry): MateFrame | null | undefined {
  const explicit = typeof end.connector === "string" ? connectors.get(end.connector) : undefined;
  if (typeof end.connector === "string" && !explicit) return null;
  let f = geometry.frame(instance, explicit ? explicit.ref : end.ref);
  if (!f) return f;
  if (explicit) {
    if (explicit.flip) f = flipped(f);
    const o = explicit.offset;
    if (Array.isArray(o) && o.length === 3 && o.some((v) => v)) f = shifted(f, [o[0], o[1], o[2]]);
    if (explicit.rotation) f = turned(f, (explicit.rotation * Math.PI) / 180);
  }
  return f;
}

/**
 * The solver's input.  `poses` overrides stored placements (a drag in progress, a draft).  A suppressed
 * instance is not a body; its mates are inactive.  A mate whose geometry is gone is an error and is left out.
 */
export function buildProblem(
  instances: readonly InstanceItem[], mates: readonly MateItem[], connectors: ReadonlyMap<string, ConnectorItem>,
  defs: readonly MateDefinition[], geometry: Geometry, poses?: ReadonlyMap<string, Pose>,
): Problem {
  const byId = new Map<string, InstanceItem>();
  const bodies: SolverBody[] = [];
  for (const i of instances) {
    byId.set(i.id, i);
    if (i.suppressed) continue;
    const centre = geometry.centre ? geometry.centre(i) : null;
    bodies.push({ id: i.id, pose: poses?.get(i.id) || poseOf(storedTransform(i)), fixed: !!i.fixed, ...(centre ? { centre } : {}) });
  }
  const out: SolverMate[] = [];
  const info = new Map<string, MateInfo>();
  const say = (m: MateItem, state: MateState, message?: string) => info.set(m.id, { state, message, values: {} });
  for (const m of mates) {
    if (m.suppressed) { say(m, "suppressed"); continue; }
    const def = defs.find((d) => d.type === m.mateType);
    if (!def || !def.solve) { say(m, "unknown-type", `This Junction does not know the mate type “${m.mateType}”. It is kept as it is and not enforced.`); continue; }
    const ia = byId.get(m.a?.instance), ib = byId.get(m.b?.instance);
    if (!ia || !ib) { say(m, "error", "One of the instances this mate joined has been deleted. Edit the mate and pick its connectors again, or delete it."); continue; }
    if (ia.suppressed || ib.suppressed) { say(m, "inactive", `${ia.suppressed ? ia.name : ib.name} is suppressed, so this mate is not applied.`); continue; }
    const fa = endFrame(m.a, ia, connectors, geometry), fb = endFrame(m.b, ib, connectors, geometry);
    if (fa === undefined || fb === undefined) { say(m, "pending", "Waiting for the part to load."); continue; }
    if (!fa || !fb) { const lost = !fa ? ia : ib; say(m, "error", `The face, edge or point this mate used on ${lost.name} no longer exists. Edit the mate and pick it again.`); continue; }
    const params = m.params || {};
    out.push({ id: m.id, solve: def.solve, a: { body: ia.id, frame: prepareA(fa, !!m.a.flip, params) }, b: { body: ib.id, frame: prepareB(fb, !!m.b.flip, params) }, params });
  }
  return { bodies, mates: out, info };
}

export interface Solved { result: SolveResult; mates: Map<string, MateInfo> }

/** Solve a problem and merge what the solver says about each mate with what was known before it ran. */
export function solveProblem(p: Problem, opts: SolveOptions = {}): Solved {
  const result = solve(p.bodies, p.mates, opts);
  const mates = new Map(p.info);
  for (const [id, r] of result.mates) mates.set(id, { state: r.status, message: r.message, values: r.values });
  return { result, mates };
}

/** Every active mate's values (mm, degrees) as the bodies stand in `poses`: what is stored with the placements. */
export function measureMates(p: Problem, poses: ReadonlyMap<string, Pose>): Map<string, { [key: string]: number }> {
  const out = new Map<string, { [key: string]: number }>();
  for (const m of p.mates) {
    const pa = poses.get(m.a.body), pb = poses.get(m.b.body), values = m.solve.values;
    if (!pa || !pb || !values || !values.length) continue;
    const a = frameInWorld(pa, m.a.frame), b = frameInWorld(pb, m.b.frame);
    const v: { [key: string]: number } = {};
    for (const x of values) v[x.key] = x.unit === "deg" ? (x.measure(a, b) * 180) / Math.PI : x.measure(a, b);
    out.set(m.id, v);
  }
  return out;
}

/** A sensible `reach` for the solver: about the size of what is being assembled. */
export function reachOf(mates: readonly SolverMate[]): number {
  let top = 0;
  for (const m of mates) for (const e of [m.a, m.b]) top = Math.max(top, Math.abs(e.frame.o[0]), Math.abs(e.frame.o[1]), Math.abs(e.frame.o[2]));
  return Math.min(1000, Math.max(20, top));
}
