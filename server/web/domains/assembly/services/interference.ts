// interference.ts — the assembly's interference and clearance checks, as pure logic over placed shapes.
//
// The geometry work is the mechanical worker's ("interference" and "clearance" services,
// mechanical/services/measure-interference.ts): exact booleans and distances between solids sent as BRep text.
// What happens here: every instance's box is carried into the assembly by its transform, the pairs whose boxes
// overlap are found by sorting along X (the broad phase), only those pairs are sent, a shape's text is sent only
// when the checking worker says it lacks it, and the answer is turned back into instance ids.  `call` is the
// worker's `kernel.call`, so a node test runs this against the real kernel and the page against its worker.
import { apply } from "../core/transform";
import type { Transform } from "../document/format";

export type Box = [number, number, number, number, number, number];

/** One solid of the assembly: an instance's body, its exact box in the body's own space and its placement. */
export interface InstanceShape {
  instance: string;
  /** names the shape in the checking worker: same key, same shape (the document, the body and a hash of the text) */
  key: string;
  brep: string;
  bbox: Box;
  transform: Transform;
}

export interface Clash { a: string; b: string; volume: number | null; centre?: number[]; bbox?: number[]; mesh?: { positions: number[]; indices: number[] }; error?: string }
export interface InterferenceResult { clashes: Clash[]; candidates: number; checked: number; ms: number }

export type KernelCall = (service: string, args: unknown) => Promise<unknown>;

/** A box carried by a rigid transform: the box of its eight corners. */
export function worldBox(b: readonly number[], t: Transform): Box {
  const out: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = apply(t, [i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]]);
    for (let a = 0; a < 3; a++) { out[a] = Math.min(out[a], p[a]); out[a + 3] = Math.max(out[a + 3], p[a]); }
  }
  return out;
}

/** The pairs (i < j) whose boxes overlap or come within `gap`: sort and sweep along X, then test Y and Z. */
export function candidatePairs(boxes: readonly Box[], gap = 0): [number, number][] {
  const order = boxes.map((_, i) => i).sort((i, j) => boxes[i][0] - boxes[j][0]);
  const out: [number, number][] = [];
  const active: number[] = [];
  for (const i of order) {
    const b = boxes[i];
    for (let k = active.length - 1; k >= 0; k--) if (boxes[active[k]][3] + gap < b[0]) active.splice(k, 1);
    for (const j of active) {
      const c = boxes[j];
      if (b[1] <= c[4] + gap && c[1] <= b[4] + gap && b[2] <= c[5] + gap && c[2] <= b[5] + gap) out.push(i < j ? [i, j] : [j, i]);
    }
    active.push(i);
  }
  return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

/** A short, stable hash of BRep text: part of a shape's key. */
export function textHash(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 + c, 2246822519) ^ (h2 >>> 13); }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36);
}

/** Send keys first; send the text of the shapes the worker says it lacks; ask once more. */
async function withShapes<T extends { missing?: string[] }>(shapes: readonly InstanceShape[], call: KernelCall, service: string, extra: object): Promise<T> {
  const args = (send: Set<string>) => ({ ...extra, shapes: shapes.map((s) => ({ key: s.key, transform: s.transform, ...(send.has(s.key) ? { brep: s.brep } : {}) })) });
  let r = (await call(service, args(new Set()))) as T;
  if (r.missing && r.missing.length) r = (await call(service, args(new Set(r.missing)))) as T;
  if (r.missing && r.missing.length) throw new Error("The checking worker could not read every part.");
  return r;
}

/** Which instances overlap, and by how much (mm³).  `mesh: true` also returns each clash's triangles. */
export async function checkInterference(shapes: readonly InstanceShape[], call: KernelCall, o: { mesh?: boolean } = {}): Promise<InterferenceResult> {
  const t0 = Date.now();
  // the solids of one instance (a board's laminate and its parts) are not checked against each other; two
  // instances may share a key (the same body placed twice)
  const pairs = candidatePairs(shapes.map((s) => worldBox(s.bbox, s.transform))).filter(([i, j]) => shapes[i].instance !== shapes[j].instance);
  if (!pairs.length) return { clashes: [], candidates: 0, checked: 0, ms: Date.now() - t0 };
  const r = await withShapes<{ missing: string[]; checked: number; clashes: { a: number; b: number; volume: number | null; centre?: number[]; bbox?: number[]; mesh?: Clash["mesh"]; error?: string }[] }>(shapes, call, "interference", { pairs, mesh: !!o.mesh });
  const clashes: Clash[] = r.clashes.map((c) => ({ ...c, a: shapes[c.a].instance, b: shapes[c.b].instance }));
  return { clashes, candidates: pairs.length, checked: r.checked, ms: Date.now() - t0 };
}

/** The smallest gap between two instances (0 when they touch or overlap), and where it is in the assembly. */
export async function clearance(a: InstanceShape, b: InstanceShape, call: KernelCall): Promise<{ distance: number; pa: number[]; pb: number[] }> {
  const r = await withShapes<{ missing: string[]; results: { distance: number | null; pa?: number[]; pb?: number[]; error?: string }[] }>([a, b], call, "clearance", { pairs: [[0, 1]] });
  const x = r.results[0];
  if (!x || x.distance === null || !x.pa || !x.pb) throw new Error(x && x.error ? x.error : "The distance could not be found.");
  return { distance: x.distance, pa: x.pa, pb: x.pb };
}

/** "Bracket <1> and Bracket <2>": a clash as a person reads it. */
export function clashTitle(c: Pick<Clash, "a" | "b">, names: (id: string) => string): string { return `${names(c.a)} and ${names(c.b)}`; }
