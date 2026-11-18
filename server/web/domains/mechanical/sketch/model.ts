// model.ts — editing a sketch as data: a `Draft` is a private copy of a sketch that a tool changes freely
// (add a line, tie two things together, delete a curve with everything that hung on it) before the editor solves
// it and commits the difference as one change.  Pure: no solver, no DOM.
import type { ItemChange, Json, JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { Vec2 } from "../core/geometry";
import { SKETCH_VERSION, type SketchConstraint, type SketchData, type SketchEntity, type SketchRef } from "./format";
import { ORIGIN, pointsOf } from "./refs";

/** A sketch read from a document, with the maps a reader may rely on. */
export function normalise(data: SketchData | undefined | null): SketchData {
  const d = data || ({} as SketchData);
  return { ...d, version: d.version || SKETCH_VERSION, entities: d.entities || {}, constraints: d.constraints || {} };
}

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The one change that turns sketch `before` into `after`: a prop per entity or constraint that differs. */
export function sketchChange(featureId: string, before: SketchData, after: SketchData): ItemChange | null {
  const props: { path: string[]; value?: Json; del?: true }[] = [];
  for (const map of ["entities", "constraints"] as const) {
    const a = before[map] || {}, b = after[map] || {};
    for (const id of Object.keys(b)) if (!same(a[id], b[id])) props.push({ path: ["params", "sketch", map, id], value: b[id] as JsonObject });
    for (const id of Object.keys(a)) if (!(id in b)) props.push({ path: ["params", "sketch", map, id], del: true });
  }
  return props.length ? ({ id: featureId, kind: "MODIFIED", typeName: "feature", props } as ItemChange) : null;
}

export type Ref = string | SketchRef;
const ref = (r: Ref): SketchRef => (typeof r === "string" ? { entity: r } : r);

export class Draft {
  data: SketchData;
  /** new curves and points are construction geometry */
  construction = false;
  private n = 0;

  constructor(from: SketchData) {
    this.data = { ...from, entities: { ...from.entities }, constraints: { ...from.constraints } };
  }

  /** A short id no entity or constraint of the sketch has. */
  id(prefix: string): string {
    for (;;) {
      const id = prefix + Math.random().toString(36).slice(2, 7) + (this.n++).toString(36);
      if (!(id in this.data.entities) && !(id in this.data.constraints)) return id;
    }
  }

  point(p: Vec2): string { const id = this.id("p"); this.data.entities[id] = { type: "point", x: p[0], y: p[1] }; return id; }
  private curve(prefix: string, e: SketchEntity, construction?: boolean): string {
    const id = this.id(prefix);
    this.data.entities[id] = (construction ?? this.construction) ? ({ ...e, construction: true } as SketchEntity) : e;
    return id;
  }
  line(a: string, b: string, construction?: boolean): string { return this.curve("l", { type: "line", a, b }, construction); }
  circle(center: string, r: number, construction?: boolean): string { return this.curve("c", { type: "circle", center, r }, construction); }
  /** counter-clockwise from start to end */
  arc(center: string, start: string, end: string, construction?: boolean): string { return this.curve("a", { type: "arc", center, start, end }, construction); }

  set(id: string, e: SketchEntity): void { this.data.entities[id] = e; }
  move(id: string, p: Vec2): void { const e = this.data.entities[id]; if (e && e.type === "point") this.data.entities[id] = { ...e, x: p[0], y: p[1] }; }

  /** Add a constraint.  Returns its id, or the id of one that already says the same. */
  constrain(type: string, refs: Ref[], extra: Partial<SketchConstraint> = {}): string {
    const c: SketchConstraint = { type, refs: refs.map(ref), ...extra };
    if (c.value === undefined) {
      const key = (x: SketchConstraint) => x.type + "|" + x.refs.map((r) => r.entity + (r.at ? "@" + r.at : "")).sort().join("|");
      for (const [id, x] of Object.entries(this.data.constraints)) if (x.value === undefined && key(x) === key(c)) return id;
    }
    const id = this.id(c.value === undefined ? "k" : "d");
    this.data.constraints[id] = c;
    return id;
  }
  unconstrain(id: string): void { delete this.data.constraints[id]; }

  /**
   * Delete entities and constraints.  A point takes the curves built on it; a curve takes the points nothing
   * else uses; and a constraint goes when something it refers to has gone.
   */
  remove(ids: readonly string[]): void {
    const d = this.data, gone = new Set<string>();
    for (const id of ids) { if (id in d.constraints) delete d.constraints[id]; else if (id in d.entities) gone.add(id); }
    if (!gone.size) return;
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, e] of Object.entries(d.entities)) if (!gone.has(id) && pointsOf(e).some((p) => gone.has(p))) { gone.add(id); grew = true; }
    }
    const used = new Set<string>(), was = new Set<string>();
    for (const [id, e] of Object.entries(d.entities)) for (const p of pointsOf(e)) (gone.has(id) ? was : used).add(p);
    for (const p of was) if (!used.has(p)) gone.add(p);
    for (const id of gone) delete d.entities[id];
    this.dropDangling();
  }

  /** Remove the constraints that refer to something that is no longer there. */
  dropDangling(): void {
    const d = this.data;
    for (const [id, c] of Object.entries(d.constraints)) {
      if (!Array.isArray(c.refs) || c.refs.some((r) => !r || (r.entity !== ORIGIN && !(r.entity in d.entities)))) delete d.constraints[id];
    }
  }

  /** The constraints that mention an entity (by whole or by one of its points). */
  constraintsOn(entity: string): string[] {
    return Object.entries(this.data.constraints).filter(([, c]) => (c.refs || []).some((r) => r.entity === entity)).map(([id]) => id);
  }

  /** Point every use of point `from` at point `to` instead (curves and constraints), and delete `from`. */
  merge(from: string, to: string): void {
    if (from === to) return;
    const d = this.data;
    for (const [id, e] of Object.entries(d.entities)) {
      if (e.type === "line" && (e.a === from || e.b === from)) d.entities[id] = { ...e, a: e.a === from ? to : e.a, b: e.b === from ? to : e.b };
      else if (e.type === "circle" && e.center === from) d.entities[id] = { ...e, center: to };
      else if (e.type === "arc" && (e.center === from || e.start === from || e.end === from)) d.entities[id] = { ...e, center: e.center === from ? to : e.center, start: e.start === from ? to : e.start, end: e.end === from ? to : e.end };
    }
    for (const [id, c] of Object.entries(d.constraints)) if ((c.refs || []).some((r) => r.entity === from)) d.constraints[id] = { ...c, refs: c.refs.map((r) => (r.entity === from ? { ...r, entity: to } : r)) };
    delete d.entities[from];
  }
}
