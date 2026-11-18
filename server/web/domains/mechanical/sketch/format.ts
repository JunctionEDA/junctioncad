// format.ts — the sketch data format: what a `sketch` feature stores in `params.sketch`.
//
// A sketch is a set of entities, a set of constraints and nothing else.  Both are maps keyed by short ids, not
// arrays, so that an edit is a change at one path (`params.sketch.entities.<id>`) and two people drawing in the
// same sketch do not overwrite each other (shared/itemdoc: the last writer of a *path* wins).
//
// Entities
//   point   { type: "point", x, y }                 coordinates in the sketch plane, millimetres
//   line    { type: "line", a, b }                  a and b are point ids
//   circle  { type: "circle", center, r }           center is a point id
//   arc     { type: "arc", center, start, end }     point ids; drawn counter-clockwise from start to end
// Every curve refers to points by id.  Two curves that share a point id are joined there: that is how a
// rectangle is four lines and four points, and it is what a constraint solver wants (a point is two unknowns).
// `construction: true` marks geometry that guides the sketch and makes no profile.
//
// Constraints (and dimensions, which are constraints with a `value`)
//   { type, refs, value?, driving?, expr?, label? }
// `type` is open: "coincident", "horizontal", "vertical", "parallel", "perpendicular", "tangent", "equal",
// "midpoint", "fix", "distance", "radius", "diameter", "angle", … are the names reserved for a solver to
// implement.  `refs` name what the constraint ties together: an entity, or one of its points.
// Nothing here solves constraints.  THE DOCUMENT ALWAYS STORES SOLVED COORDINATES: whoever edits a sketch (a
// tool, a solver) writes the resulting point positions and radii into the entities, and the kernel builds
// geometry from the entities alone.  A reader that does not know a constraint type keeps it and ignores it.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { Vec2 } from "../core/geometry";

export const SKETCH_VERSION = 1;

export interface SketchPoint extends JsonObject { type: "point"; x: number; y: number; construction?: boolean }
export interface SketchLine extends JsonObject { type: "line"; a: string; b: string; construction?: boolean }
export interface SketchCircle extends JsonObject { type: "circle"; center: string; r: number; construction?: boolean }
export interface SketchArc extends JsonObject { type: "arc"; center: string; start: string; end: string; construction?: boolean }
export type SketchEntity = SketchPoint | SketchLine | SketchCircle | SketchArc;
export type SketchCurve = SketchLine | SketchCircle | SketchArc;

/** What a constraint points at: a whole entity, or a named point of a curve. */
export interface SketchRef extends JsonObject { entity: string; at?: "start" | "end" | "center" }

export interface SketchConstraint extends JsonObject {
  type: string;
  refs: SketchRef[];
  /** a dimension's value: millimetres, or degrees for an angle */
  value?: number;
  /** false for a reference (driven) dimension, which is shown and not enforced; absent means driving */
  driving?: boolean;
  /** the expression the value was typed as ("width / 2"), once variables exist */
  expr?: string;
  /** where the dimension's text sits, in sketch coordinates */
  label?: { x: number; y: number };
}

export interface SketchData extends JsonObject {
  version: number;
  entities: { [id: string]: SketchEntity };
  constraints: { [id: string]: SketchConstraint };
}

export const emptySketch = (): SketchData => ({ version: SKETCH_VERSION, entities: {}, constraints: {} });

/** A short id that is unique in its sketch.  Entity ids appear in geometry names, so they stay short. */
export function newSketchId(sketch: SketchData, prefix = "e"): string {
  for (;;) {
    const id = prefix + Math.random().toString(36).slice(2, 8);
    if (!(id in sketch.entities) && !(id in sketch.constraints)) return id;
  }
}

export function pointOf(sketch: SketchData, id: string): Vec2 | null {
  const p = sketch.entities[id];
  return p && p.type === "point" && Number.isFinite(p.x) && Number.isFinite(p.y) ? [p.x, p.y] : null;
}

/**
 * New entities for a line between two positions, keyed by id.  `use` names existing points to end on instead of
 * making new ones (the line then shares them: that is how a chain of lines, or a line snapped to a corner, is joined).
 */
export function lineEntities(sketch: SketchData, a: Vec2, b: Vec2, use: { a?: string; b?: string } = {}): { entities: { [id: string]: SketchEntity }; a: string; b: string } {
  const out: { [id: string]: SketchEntity } = {};
  const scratch: SketchData = { ...sketch, entities: { ...sketch.entities } };
  const id = (prefix: string) => { const i = newSketchId(scratch, prefix); scratch.entities[i] = { type: "point", x: 0, y: 0 }; return i; };
  const pa = use.a && sketch.entities[use.a] ? use.a : id("p"), pb = use.b && sketch.entities[use.b] ? use.b : id("p");
  if (pa !== use.a) out[pa] = { type: "point", x: a[0], y: a[1] };
  if (pb !== use.b) out[pb] = { type: "point", x: b[0], y: b[1] };
  out[id("l")] = { type: "line", a: pa, b: pb };
  return { entities: out, a: pa, b: pb };
}

/** New entities for an axis-aligned rectangle between two corners: four points and four lines that share them. */
export function rectangleEntities(sketch: SketchData, a: Vec2, b: Vec2): { [id: string]: SketchEntity } {
  const out: { [id: string]: SketchEntity } = {};
  const scratch: SketchData = { ...sketch, entities: { ...sketch.entities } };
  const id = (prefix: string) => { const i = newSketchId(scratch, prefix); scratch.entities[i] = { type: "point", x: 0, y: 0 }; return i; };
  const corners: Vec2[] = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  const pts = corners.map(() => id("p"));
  corners.forEach((c, i) => { out[pts[i]] = { type: "point", x: c[0], y: c[1] }; });
  for (let i = 0; i < 4; i++) out[id("l")] = { type: "line", a: pts[i], b: pts[(i + 1) % 4] };
  return out;
}

/** New entities for a circle: its centre point and the circle. */
export function circleEntities(sketch: SketchData, center: Vec2, r: number): { [id: string]: SketchEntity } {
  const out: { [id: string]: SketchEntity } = {};
  const scratch: SketchData = { ...sketch, entities: { ...sketch.entities } };
  const pc = newSketchId(scratch, "p"); scratch.entities[pc] = { type: "point", x: 0, y: 0 };
  out[pc] = { type: "point", x: center[0], y: center[1] };
  out[newSketchId(scratch, "c")] = { type: "circle", center: pc, r };
  return out;
}

/** Points along a curve, for drawing and for inside/outside tests.  A line gives its two ends. */
export function curvePoints(sketch: SketchData, e: SketchEntity, segmentsPerTurn = 64): Vec2[] {
  if (e.type === "line") { const a = pointOf(sketch, e.a), b = pointOf(sketch, e.b); return a && b ? [a, b] : []; }
  if (e.type === "circle") {
    const c = pointOf(sketch, e.center); if (!c || !(e.r > 0)) return [];
    const out: Vec2[] = [];
    for (let i = 0; i <= segmentsPerTurn; i++) { const t = (i / segmentsPerTurn) * Math.PI * 2; out.push([c[0] + e.r * Math.cos(t), c[1] + e.r * Math.sin(t)]); }
    return out;
  }
  if (e.type === "arc") {
    const c = pointOf(sketch, e.center), s = pointOf(sketch, e.start), en = pointOf(sketch, e.end); if (!c || !s || !en) return [];
    const r = Math.hypot(s[0] - c[0], s[1] - c[1]); if (!(r > 0)) return [];
    const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]); let a1 = Math.atan2(en[1] - c[1], en[0] - c[0]);
    if (a1 <= a0) a1 += Math.PI * 2;
    const n = Math.max(2, Math.ceil(((a1 - a0) / (Math.PI * 2)) * segmentsPerTurn));
    const out: Vec2[] = [];
    for (let i = 0; i <= n; i++) { const t = a0 + ((a1 - a0) * i) / n; out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
    out[0] = s; out[out.length - 1] = en;
    return out;
  }
  return [];
}

/** The ids to delete when these entities go: the entities themselves and the points nothing else uses any more. */
export function withOrphanPoints(sketch: SketchData, ids: readonly string[]): string[] {
  const gone = new Set(ids);
  // deleting a point deletes the curves that end on it
  for (const [id, e] of Object.entries(sketch.entities)) {
    if (e.type === "line" && (gone.has(e.a) || gone.has(e.b))) gone.add(id);
    if (e.type === "circle" && gone.has(e.center)) gone.add(id);
    if (e.type === "arc" && (gone.has(e.center) || gone.has(e.start) || gone.has(e.end))) gone.add(id);
  }
  const used = new Set<string>();
  for (const [id, e] of Object.entries(sketch.entities)) {
    if (gone.has(id)) continue;
    if (e.type === "line") { used.add(e.a); used.add(e.b); }
    if (e.type === "circle") used.add(e.center);
    if (e.type === "arc") { used.add(e.center); used.add(e.start); used.add(e.end); }
  }
  const wasUsed = new Set<string>();
  for (const id of gone) { const e = sketch.entities[id]; if (!e) continue; if (e.type === "line") { wasUsed.add(e.a); wasUsed.add(e.b); } if (e.type === "circle") wasUsed.add(e.center); if (e.type === "arc") { wasUsed.add(e.center); wasUsed.add(e.start); wasUsed.add(e.end); } }
  for (const p of wasUsed) if (!used.has(p)) gone.add(p);
  return Array.from(gone).filter((id) => id in sketch.entities);
}
