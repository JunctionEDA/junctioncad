// model.ts — a part studio as an AI assistant reads and edits it: the feature types and their parameters taken
// from the feature registry, the feature tree as JSON, and a list of edits turned into the item changes that make
// them (document/edits.ts), validated against the registry first.
//
// Pure: no kernel, no network.  mcp/host.ts opens the document, commits what this plans and asks the kernel
// what the result is; the node test (static/tests/cad-history.test.js) drives this file directly.
import { applyChanges, invertChange, newId, type ItemChange, type ItemDoc, type Json, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { FeatureDefinition, ParamField } from "../core/feature";
import * as edits from "../document/edits";
import { featuresOf, nextName, orderAt, rollbackIndex, studioOf, type FeatureItem } from "../document/format";
import type { FeatureReport } from "../kernel/protocol";
import { emptySketch, type SketchData, type SketchEntity } from "../sketch/format";

type Defs = readonly FeatureDefinition[];
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ---------------------------------------------------------------- the feature types

function fieldDoc(f: ParamField): JsonObject {
  const out: JsonObject = { key: f.key, label: f.label, kind: f.kind };
  if (f.hint) out.hint = f.hint;
  switch (f.kind) {
    case "number": out.stores = "a number" + (f.unit === "deg" ? " (degrees)" : f.unit === "none" ? "" : " (millimetres)"); if (f.min !== undefined) out.min = f.min; if (f.max !== undefined) out.max = f.max; break;
    case "boolean": out.stores = "true or false"; break;
    case "text": out.stores = "a string"; break;
    case "enum": out.stores = "one of the options"; out.options = f.options.map((o) => o.value); break;
    case "profile": out.stores = "{ sketch: <id of an earlier sketch feature>, regions: null (all closed regions) or [region ids] }; the sketch's name, id or $ref alone is accepted too"; break;
    case "plane": out.stores = "{ kind: \"plane\", plane: \"top\" | \"front\" | \"right\" } or { kind: \"face\", ref: { kind: \"face\", body, name } }; \"top\", \"front\" or \"right\" alone is accepted too"; break;
    case "refs": out.stores = (f.single ? "one" : "a list of") + ` { kind: ${f.of.map((k) => `"${k}"`).join(" | ")}, body, name } (names from cad_get_bodies)`; break;
    case "bodies": out.stores = "a list of body ids; empty means every body"; break;
  }
  return out;
}

const SKETCH_NOTE = "A sketch stores solved 2D geometry in its plane (x, y in millimetres; top is the XY plane, front is XZ, right is YZ): params.sketch.entities is a map of points { type: \"point\", x, y } and curves that name points by id: { type: \"line\", a, b }, { type: \"circle\", center, r }, { type: \"arc\", center, start, end } (counter-clockwise). Curves that share a point id are joined; a closed loop of lines and arcs, or a circle, is a region an extrude can use, and a loop inside another is a hole. In cad_edit_features give `shapes` instead of writing entities by hand: { type: \"rectangle\", x1, y1, x2, y2 }, { type: \"circle\", cx, cy, r }, { type: \"polygon\", points: [[x, y], ...] } (closed), { type: \"line\", x1, y1, x2, y2 }.";

/** Every registered feature type with its defaults and the parameters its dialog has. */
export function featureTypes(defs: Defs): Json {
  return {
    feature_types: defs.map((d) => {
      const out: JsonObject = { type: d.type, title: d.title, defaults: d.defaults(), parameters: d.schema.map(fieldDoc) };
      if (d.type === "sketch") out.note = SKETCH_NOTE;
      return out;
    }),
    units: "Lengths are millimetres and angles degrees. Z is up.",
    names: "A body's id is the id of the feature that made it. Faces, edges and vertices have stable names (cad_get_bodies with names: true lists them); a feature refers to them as { kind, body, name }.",
  };
}

// ---------------------------------------------------------------- reading the tree

function sketchSummary(data: SketchData | undefined): JsonObject {
  const count: { [k: string]: number } = {};
  for (const e of Object.values((data && data.entities) || {})) count[e.type] = (count[e.type] || 0) + 1;
  return { points: count.point || 0, lines: count.line || 0, circles: count.circle || 0, arcs: count.arc || 0 };
}

export interface TreeOptions { entities?: boolean }

/** The feature tree as an assistant reads it.  `reports` are the kernel's, when the model was rebuilt. */
export function treeOf(doc: ItemDoc, reports: readonly FeatureReport[] | null, o: TreeOptions = {}): JsonObject {
  const features = featuresOf(doc), rollback = rollbackIndex(doc, features);
  const by = new Map((reports || []).map((r) => [r.id, r]));
  return {
    units: studioOf(doc).units,
    rollback_before: rollback < features.length ? features[rollback].name : null,
    features: features.map((f, i) => {
      const r = by.get(f.id);
      const out: JsonObject = { index: i, id: f.id, name: f.name, type: f.featureType };
      if (f.suppressed) out.suppressed = true;
      if (r) { out.status = r.status; if (r.message) out.message = r.message; } else if (i >= rollback) out.status = "rolled-back";
      if (f.featureType === "sketch" && !o.entities) {
        const { sketch, ...rest } = f.params as { sketch?: SketchData };
        out.params = { ...rest, sketch: sketchSummary(sketch) };
      } else out.params = f.params;
      return out;
    }),
  };
}

// ---------------------------------------------------------------- sketch shapes

/** Entities for the shapes an assistant gives, with short ids in sequence (p1, l1, c1): they appear in face names. */
export function shapesToEntities(shapes: unknown, into: { [id: string]: SketchEntity } = {}): { entities: { [id: string]: SketchEntity }; problems: string[] } {
  const out: { [id: string]: SketchEntity } = {}, problems: string[] = [];
  const counters: { [prefix: string]: number } = {};
  const id = (prefix: string): string => { for (;;) { const n = (counters[prefix] = (counters[prefix] || 0) + 1); const i = prefix + n; if (!(i in into) && !(i in out)) return i; } };
  const point = (x: number, y: number): string => { const i = id("p"); out[i] = { type: "point", x, y }; return i; };
  if (!Array.isArray(shapes)) return { entities: out, problems: ["shapes must be a list"] };
  shapes.forEach((s, n) => {
    const where = `shape ${n + 1}`;
    if (!isObject(s) || typeof s.type !== "string") { problems.push(`${where} needs a type`); return; }
    if (s.type === "rectangle") {
      if (![s.x1, s.y1, s.x2, s.y2].every(num)) { problems.push(`${where}: a rectangle needs x1, y1, x2, y2`); return; }
      const [x1, y1, x2, y2] = [s.x1, s.y1, s.x2, s.y2] as number[];
      if (x1 === x2 || y1 === y2) { problems.push(`${where}: the rectangle has no area`); return; }
      const pts = [point(x1, y1), point(x2, y1), point(x2, y2), point(x1, y2)];
      for (let i = 0; i < 4; i++) out[id("l")] = { type: "line", a: pts[i], b: pts[(i + 1) % 4] };
    } else if (s.type === "circle") {
      if (![s.cx, s.cy, s.r].every(num) || !((s.r as number) > 0)) { problems.push(`${where}: a circle needs cx, cy and a radius r above zero`); return; }
      out[id("c")] = { type: "circle", center: point(s.cx as number, s.cy as number), r: s.r as number };
    } else if (s.type === "polygon") {
      const pts = s.points;
      if (!Array.isArray(pts) || pts.length < 3 || !pts.every((p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]))) { problems.push(`${where}: a polygon needs points: [[x, y], ...] with at least three`); return; }
      const ids = (pts as number[][]).map((p) => point(p[0], p[1]));
      for (let i = 0; i < ids.length; i++) out[id("l")] = { type: "line", a: ids[i], b: ids[(i + 1) % ids.length] };
    } else if (s.type === "line") {
      if (![s.x1, s.y1, s.x2, s.y2].every(num)) { problems.push(`${where}: a line needs x1, y1, x2, y2`); return; }
      out[id("l")] = { type: "line", a: point(s.x1 as number, s.y1 as number), b: point(s.x2 as number, s.y2 as number) };
    } else problems.push(`${where}: unknown shape type "${s.type}" (rectangle, circle, polygon, line)`);
  });
  return { entities: out, problems };
}

function checkEntities(entities: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(entities)) return ["sketch.entities must be a map of id to entity"];
  const isPoint = (id: unknown) => typeof id === "string" && isObject(entities[id]) && (entities[id] as JsonObject).type === "point";
  for (const [id, e] of Object.entries(entities)) {
    if (e === null) continue;
    if (!isObject(e)) { problems.push(`entity ${id} is not an object`); continue; }
    if (e.type === "point") { if (!num(e.x) || !num(e.y)) problems.push(`point ${id} needs numbers x and y`); }
    else if (e.type === "line") { if (!isPoint(e.a) || !isPoint(e.b)) problems.push(`line ${id}: a and b must be ids of points in the sketch`); }
    else if (e.type === "circle") { if (!isPoint(e.center) || !num(e.r) || !(e.r > 0)) problems.push(`circle ${id}: center must be a point id and r above zero`); }
    else if (e.type === "arc") { if (!isPoint(e.center) || !isPoint(e.start) || !isPoint(e.end)) problems.push(`arc ${id}: center, start and end must be point ids`); }
  }
  return problems;
}

// ---------------------------------------------------------------- planning edits

export interface Plan {
  /** the item changes that make the edits, in order; empty when there is a problem */
  changes: ItemChange[];
  /** what undoes them, to be applied in this order */
  inverse: ItemChange[];
  /** one sentence per edit */
  done: string[];
  /** why nothing can be applied; empty when all is well */
  problems: string[];
  /** the document as it will be */
  after: ItemDoc;
}

const copyDoc = (doc: ItemDoc): ItemDoc => ({ ...doc, head: { ...doc.head }, items: new Map(doc.items) });

function validate(def: FeatureDefinition, params: JsonObject, features: FeatureItem[], selfIndex: number): string[] {
  const problems: string[] = [];
  for (const f of def.schema) {
    const v = params[f.key];
    if (v === undefined || v === null) continue;
    if (f.kind === "number") {
      if (!num(v)) problems.push(`${f.key} must be a number`);
      else if (f.min !== undefined && v < f.min) problems.push(`${f.key} must be at least ${f.min}`);
      else if (f.max !== undefined && v > f.max) problems.push(`${f.key} must be at most ${f.max}`);
    } else if (f.kind === "boolean") { if (typeof v !== "boolean") problems.push(`${f.key} must be true or false`); }
    else if (f.kind === "text") { if (typeof v !== "string") problems.push(`${f.key} must be a string`); }
    else if (f.kind === "enum") { if (!f.options.some((o) => o.value === v)) problems.push(`${f.key} must be one of ${f.options.map((o) => o.value).join(", ")}`); }
    else if (f.kind === "profile") {
      const id = isObject(v) ? v.sketch : null;
      const at = features.findIndex((x) => x.id === id);
      if (at < 0 || features[at].featureType !== "sketch") problems.push(`${f.key}.sketch must be the id of a sketch feature`);
      else if (selfIndex >= 0 && at >= selfIndex) problems.push(`${f.key}: the sketch "${features[at].name}" comes after this feature in the tree; a feature can only use what is above it`);
      if (isObject(v) && v.regions !== null && v.regions !== undefined && !(Array.isArray(v.regions) && v.regions.every((r) => typeof r === "string"))) problems.push(`${f.key}.regions must be null or a list of region ids`);
    } else if (f.kind === "plane") {
      const ok = isObject(v) && ((v.kind === "plane" && ["top", "front", "right"].includes(v.plane as string)) || (v.kind === "face" && isObject(v.ref) && typeof v.ref.name === "string"));
      if (!ok) problems.push(`${f.key} must be "top", "front", "right" or { kind: "face", ref: { kind: "face", body, name } }`);
    } else if (f.kind === "refs") {
      const list = f.single ? [v] : v;
      if (!Array.isArray(list) || !list.every((r) => isObject(r) && typeof r.name === "string" && f.of.includes(r.kind as never))) problems.push(`${f.key} must be ${f.single ? "a reference" : "a list of references"} { kind: ${f.of.join(" | ")}, body, name }`);
    } else if (f.kind === "bodies") { if (!Array.isArray(v) || !v.every((b) => typeof b === "string")) problems.push(`${f.key} must be a list of body ids`); }
  }
  if (def.type === "sketch") {
    const sk = params.sketch;
    if (!isObject(sk)) problems.push("a sketch needs params.sketch (or shapes)"); else problems.push(...checkEntities(sk.entities));
  }
  return problems;
}

/**
 * Turn a list of edits into item changes.  Each edit sees the document as the ones before it left it; if any is
 * wrong nothing is planned and every problem is listed.  The edits:
 *   { op: "add", type, name?, params?, ref?, after? | before? | index? }      sketch: plane?, shapes?
 *   { op: "set", feature, params? }                                            sketch: plane?, shapes?, entities?
 *   { op: "rename", feature, name } · { op: "delete", feature } · { op: "suppress", feature, suppressed }
 *   { op: "move", feature, index? | before? | after? } · { op: "rollback", before: feature | null }
 * `feature` is an id, an exact name, or "$ref" of an add earlier in the list.
 */
export function planEdits(doc: ItemDoc, defs: Defs, list: unknown): Plan {
  const work = copyDoc(doc);
  const changes: ItemChange[] = [], inverse: ItemChange[] = [], done: string[] = [], problems: string[] = [];
  const refs = new Map<string, string>();
  const empty = (): Plan => ({ changes: [], inverse: [], done: [], problems, after: doc });
  if (!Array.isArray(list) || !list.length) { problems.push("edits must be a list with at least one edit"); return empty(); }

  const take = (cs: ItemChange[]): void => {
    for (const c of cs) { const inv = invertChange(work, c); if (applyChanges(work, [c]).size) { changes.push(c); if (inv) inverse.unshift(inv); } }
  };
  const subst = (v: Json | undefined): Json | undefined => {
    if (typeof v === "string" && v.startsWith("$") && refs.has(v.slice(1))) return refs.get(v.slice(1))!;
    if (Array.isArray(v)) return v.map((x) => subst(x) as Json);
    if (isObject(v)) { const o: JsonObject = {}; for (const [k, x] of Object.entries(v)) o[k] = subst(x); return o; }
    return v;
  };

  list.forEach((raw, n) => {
    const e = raw as JsonObject;
    const where = `edit ${n + 1}` + (isObject(e) && typeof e.op === "string" ? ` (${e.op})` : "");
    const bad = (m: string): void => { problems.push(`${where}: ${m}`); };
    if (!isObject(e) || typeof e.op !== "string") { bad("needs an op"); return; }
    const features = featuresOf(work);
    const find = (key: unknown, what = "feature"): FeatureItem | null => {
      if (typeof key !== "string" || !key) { bad(`${what} is required: a feature's id or name`); return null; }
      const k = key.startsWith("$") && refs.has(key.slice(1)) ? refs.get(key.slice(1))! : key;
      const hit = features.find((f) => f.id === k) || features.find((f) => f.name === k) || features.find((f) => f.name.toLowerCase() === k.toLowerCase());
      if (!hit) bad(`there is no feature "${key}". The features are: ${features.map((f) => f.name).join(", ") || "(none)"}`);
      return hit || null;
    };
    /** params as given, with the shorthands a model may use made into what the document stores */
    const normal = (def: FeatureDefinition, base: JsonObject, given: JsonObject): JsonObject | null => {
      const params: JsonObject = { ...base, ...(subst(isObject(given.params) ? given.params : {}) as JsonObject) };
      for (const f of def.schema) {
        if (f.kind === "plane") {
          if (given.plane !== undefined && !(isObject(given.params) && f.key in given.params)) params[f.key] = subst(given.plane as Json);
          const pv = params[f.key];
          if (typeof pv === "string") params[f.key] = { kind: "plane", plane: pv.toLowerCase() };
        }
        const v = params[f.key];
        if (f.kind === "profile" && (typeof v === "string" || (isObject(v) && typeof v.sketch === "string"))) {
          const key = typeof v === "string" ? v : (v.sketch as string);
          const hit = features.find((x) => x.id === key) || features.find((x) => x.name === key) || features.find((x) => x.name.toLowerCase() === key.toLowerCase());
          params[f.key] = { sketch: hit ? hit.id : key, regions: isObject(v) && Array.isArray(v.regions) ? v.regions : null };
        }
      }
      if (def.type === "sketch") {
        const was = isObject(params.sketch) ? (params.sketch as SketchData) : emptySketch();
        let entities: { [id: string]: SketchEntity } = { ...(isObject(was.entities) ? was.entities : {}) };
        if (given.shapes !== undefined) {
          const made = shapesToEntities(given.shapes);
          if (made.problems.length) { made.problems.forEach(bad); return null; }
          entities = made.entities;                       // shapes replace what the sketch held
        }
        if (isObject(given.entities)) for (const [id, ent] of Object.entries(given.entities)) { if (ent === null) delete entities[id]; else entities[id] = ent as SketchEntity; }
        params.sketch = { version: was.version || 1, entities, constraints: isObject(was.constraints) ? was.constraints : {} };
      }
      return params;
    };
    const place = (moving?: string): number | null => {
      const rest = features.filter((f) => f.id !== moving);
      if (e.before !== undefined && e.before !== null) { const f = find(e.before, "before"); if (!f) return null; return rest.findIndex((x) => x.id === f.id); }
      if (e.after !== undefined && e.after !== null) { const f = find(e.after, "after"); if (!f) return null; return rest.findIndex((x) => x.id === f.id) + 1; }
      if (e.index !== undefined) { if (!num(e.index)) { bad("index must be a number"); return null; } return Math.max(0, Math.min(Math.round(e.index), rest.length)); }
      return -1;
    };

    switch (e.op) {
      case "add": {
        const def = defs.find((d) => d.type === e.type);
        if (!def) { bad(`unknown feature type "${String(e.type)}". The types are: ${defs.map((d) => d.type).join(", ")}`); return; }
        const params = normal(def, def.defaults(), e); if (!params) return;
        let at = place(); if (at === null) return;
        if (at < 0) at = rollbackIndex(work, features);
        const issues = validate(def, params, features, at);
        if (issues.length) { issues.forEach(bad); return; }
        const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : nextName(features, def.title);
        const feature: FeatureItem = { id: newId(), type: "feature", featureType: def.type, name, order: orderAt(features, at), params };
        take([{ id: feature.id, kind: "ADDED", typeName: "feature", item: feature }]);
        if (typeof e.ref === "string" && e.ref) refs.set(e.ref.replace(/^\$/, ""), feature.id);
        done.push(`added ${def.title.toLowerCase()} "${name}" (${feature.id})`);
        return;
      }
      case "set": {
        const f = find(e.feature); if (!f) return;
        const def = defs.find((d) => d.type === f.featureType);
        if (!def) { bad(`"${f.name}" is of a type this server does not know (${f.featureType})`); return; }
        const params = normal(def, f.params, e); if (!params) return;
        const issues = validate(def, params, features, features.findIndex((x) => x.id === f.id));
        if (issues.length) { issues.forEach(bad); return; }
        const cs = edits.setParams(work, f.id, params);
        if (!cs.length) { done.push(`"${f.name}" already has those parameters`); return; }
        const paths = cs.flatMap((c) => (c.kind === "MODIFIED" ? c.props.map((p) => p.path.slice(1, 4).join(".")) : []));
        take(cs);
        done.push(`set ${Array.from(new Set(paths)).slice(0, 8).join(", ")} of "${f.name}"`);
        return;
      }
      case "rename": {
        const f = find(e.feature); if (!f) return;
        if (typeof e.name !== "string" || !e.name.trim()) { bad("name is required"); return; }
        take(edits.renameFeature(work, f.id, e.name)); done.push(`renamed "${f.name}" to "${e.name.trim()}"`);
        return;
      }
      case "delete": {
        const f = find(e.feature); if (!f) return;
        const users = features.filter((x) => x.id !== f.id && JSON.stringify(x.params).includes(f.id)).map((x) => x.name);
        take(edits.deleteFeature(work, f.id));
        done.push(`deleted "${f.name}"` + (users.length ? ` (${users.join(", ")} used it and will report an error)` : ""));
        return;
      }
      case "suppress": {
        const f = find(e.feature); if (!f) return;
        const on = e.suppressed !== false;
        take(edits.suppressFeature(work, f.id, on)); done.push(`${on ? "suppressed" : "unsuppressed"} "${f.name}"`);
        return;
      }
      case "move": {
        const f = find(e.feature); if (!f) return;
        const at = place(f.id); if (at === null) return;
        if (at < 0) { bad("say where: index, before or after"); return; }
        take(edits.moveFeature(work, f.id, at)); done.push(`moved "${f.name}" to position ${at}`);
        return;
      }
      case "rollback": {
        if (e.before === null || e.before === undefined || e.before === "end") { take(edits.setRollback(work, null)); done.push("moved the rollback bar to the end"); return; }
        const f = find(e.before, "before"); if (!f) return;
        take(edits.setRollback(work, f.id)); done.push(`moved the rollback bar above "${f.name}"`);
        return;
      }
      default: bad(`unknown op "${e.op}" (add, set, rename, delete, suppress, move, rollback)`);
    }
  });
  if (problems.length) return empty();
  return { changes, inverse, done, problems, after: work };
}

/** What undoes `changes` on `doc` as it is now, and the document afterwards. */
export function applyRecorded(doc: ItemDoc, changes: readonly ItemChange[]): { applied: ItemChange[]; inverse: ItemChange[] } {
  const work = copyDoc(doc), applied: ItemChange[] = [], inverse: ItemChange[] = [];
  for (const c of changes) { const inv = invertChange(work, c); if (applyChanges(work, [c]).size) { applied.push(c); if (inv) inverse.unshift(inv); } }
  return { applied, inverse };
}
