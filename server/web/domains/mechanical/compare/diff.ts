// compare/diff.ts — what changed between two versions of a part studio, feature by feature.
//
// Features are matched by id (a feature keeps its id for life), so a rename or a move is a change to a feature,
// not a removal and an addition.  For a feature both versions have, the parameters that differ are listed by the
// labels its dialog shows (from the feature registry), with the values before and after as a person reads them.
// A sketch's geometry is compared entity by entity.  Pure: no kernel; the volumes come from compare-versions.
import { diffProps, getPath, type ItemDoc, type Json, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { FeatureDefinition, ParamField } from "../core/feature";
import { featuresOf, rollbackIndex, type FeatureItem } from "../document/format";
import type { SketchData, SketchEntity } from "../sketch/format";

export type Category = "added" | "removed" | "modified";
export interface ParamChange { name: string; before: string; after: string }
export interface FeatureChange {
  key: string;
  category: Category;
  /** the feature's id, or "studio" for a change to the part studio itself (the rollback bar) */
  id: string;
  label: string;
  /** one line under the label: the type, and for a modified feature what changed */
  detail: string;
  props: ParamChange[];
}
export interface StudioDiff { changes: FeatureChange[]; counts: Record<Category, number> }

type Defs = readonly FeatureDefinition[];
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const round = (n: number): string => String(Math.round(n * 1000) / 1000);

function entityText(e: SketchEntity | undefined, data: SketchData | undefined): string {
  if (!e) return "—";
  const at = (id: string): string => { const p = data && data.entities[id]; return p && p.type === "point" ? `(${round(p.x)}, ${round(p.y)})` : id; };
  switch (e.type) {
    case "point": return `point (${round(e.x)}, ${round(e.y)})`;
    case "line": return `line ${at(e.a)} to ${at(e.b)}`;
    case "circle": return `circle at ${at(e.center)}, radius ${round(e.r)}`;
    case "arc": return `arc about ${at(e.center)}, ${at(e.start)} to ${at(e.end)}`;
    default: return JSON.stringify(e);
  }
}

/** A parameter's value as its dialog would say it. */
export function valueText(v: Json | undefined, field: ParamField | undefined, doc: ItemDoc): string {
  if (v === undefined || v === null) return "—";
  if (field) {
    if (field.kind === "number" && typeof v === "number") return round(v) + (field.unit === "deg" ? "°" : field.unit === "none" ? "" : " mm");
    if (field.kind === "boolean") return v ? "yes" : "no";
    if (field.kind === "enum") { const o = field.options.find((x) => x.value === v); return o ? o.label : String(v); }
    if (field.kind === "profile" && isObject(v)) {
      const f = doc.items.get(String(v.sketch)) as FeatureItem | undefined;
      const regions = Array.isArray(v.regions) ? `, ${v.regions.length} region${v.regions.length === 1 ? "" : "s"}` : "";
      return (f ? f.name : "a sketch that is gone") + regions;
    }
    if (field.kind === "plane" && isObject(v)) return v.kind === "plane" ? `${String(v.plane)[0].toUpperCase()}${String(v.plane).slice(1)} plane` : "a face";
    if (field.kind === "refs") { const n = Array.isArray(v) ? v.length : 1; return `${n} ${field.of.join(" or ")}${n === 1 ? "" : "s"}`; }
    if (field.kind === "bodies" && Array.isArray(v)) return v.length ? `${v.length} bod${v.length === 1 ? "y" : "ies"}` : "every body";
  }
  if (typeof v === "number") return round(v);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  const text = JSON.stringify(v);
  return text.length > 80 ? text.slice(0, 77) + "…" : text;
}

function paramChanges(a: FeatureItem, b: FeatureItem, def: FeatureDefinition | undefined, docA: ItemDoc, docB: ItemDoc, rankA: number, rankB: number): ParamChange[] {
  const out: ParamChange[] = [];
  const seen = new Set<string>();
  let entities = 0;
  for (const p of diffProps(a, b)) {
    const [head, key, ...rest] = p.path;
    if (head === "id" || head === "type") continue;
    if (head === "name") { out.push({ name: "Name", before: a.name, after: b.name }); continue; }
    if (head === "suppressed") { out.push({ name: "Suppressed", before: a.suppressed ? "yes" : "no", after: b.suppressed ? "yes" : "no" }); continue; }
    if (head === "order") { if (rankA !== rankB) out.push({ name: "Position in the tree", before: String(rankA + 1), after: String(rankB + 1) }); continue; }
    if (head === "featureType") { out.push({ name: "Type", before: a.featureType, after: b.featureType }); continue; }
    if (head !== "params") { const k = p.path.join("."); if (!seen.has(k)) { seen.add(k); out.push({ name: k, before: valueText(getPath(a, p.path), undefined, docA), after: valueText(getPath(b, p.path), undefined, docB) }); } continue; }
    // sketch geometry: one row per entity
    if (key === "sketch" && rest[0] === "entities" && rest[1]) {
      const id = rest[1], k = `entity:${id}`;
      if (seen.has(k)) continue; seen.add(k);
      if (++entities > 40) continue;
      const sa = a.params.sketch as SketchData | undefined, sb = b.params.sketch as SketchData | undefined;
      const ea = sa && sa.entities ? sa.entities[id] : undefined, eb = sb && sb.entities ? sb.entities[id] : undefined;
      out.push({ name: `Sketch ${(ea || eb || { type: "entity" }).type} ${id}`, before: entityText(ea, sa), after: entityText(eb, sb) });
      continue;
    }
    // any other parameter: the whole value of its key, by the dialog's label
    const k = `param:${key}`;
    if (seen.has(k)) continue; seen.add(k);
    const field = def ? def.schema.find((f) => f.key === key) : undefined;
    out.push({ name: field ? field.label : key, before: valueText(a.params[key], field, docA), after: valueText(b.params[key], field, docB) });
  }
  if (entities > 40) out.push({ name: "Sketch geometry", before: "", after: `… and ${entities - 40} more entities` });
  return out;
}

/** The changes that turn version `a` of a part studio into version `b`. */
export function diffStudios(a: ItemDoc, b: ItemDoc, defs: Defs): StudioDiff {
  const fa = featuresOf(a), fb = featuresOf(b);
  const inA = new Map(fa.map((f) => [f.id, f])), inB = new Map(fb.map((f) => [f.id, f]));
  const title = (f: FeatureItem): string => { const d = defs.find((x) => x.type === f.featureType); return d ? d.title : f.featureType; };
  // a feature's place among the features both versions have: a move shows, an insertion above it does not
  const commonA = fa.filter((f) => inB.has(f.id)).map((f) => f.id), commonB = fb.filter((f) => inA.has(f.id)).map((f) => f.id);
  const changes: FeatureChange[] = [];
  for (const f of fb) {
    const was = inA.get(f.id);
    if (!was) { changes.push({ key: "added:" + f.id, category: "added", id: f.id, label: f.name, detail: `${title(f)}, position ${fb.indexOf(f) + 1}`, props: [] }); continue; }
    const def = defs.find((x) => x.type === f.featureType);
    const props = paramChanges(was, f, def, a, b, commonA.indexOf(f.id), commonB.indexOf(f.id));
    if (!props.length) continue;
    changes.push({ key: "modified:" + f.id, category: "modified", id: f.id, label: f.name, detail: `${title(f)}: ${props.slice(0, 3).map((p) => p.name.toLowerCase()).join(", ")}${props.length > 3 ? `, +${props.length - 3}` : ""}`, props });
  }
  for (const f of fa) if (!inB.has(f.id)) changes.push({ key: "removed:" + f.id, category: "removed", id: f.id, label: f.name, detail: title(f), props: [] });
  const ra = rollbackIndex(a, fa), rb = rollbackIndex(b, fb);
  const barAt = (features: FeatureItem[], i: number): string => (i >= features.length ? "the end" : `above ${features[i].name}`);
  if (barAt(fa, ra) !== barAt(fb, rb)) changes.push({ key: "modified:studio", category: "modified", id: "studio", label: "Rollback bar", detail: `now ${barAt(fb, rb)}`, props: [{ name: "Rollback bar", before: barAt(fa, ra), after: barAt(fb, rb) }] });
  const counts: Record<Category, number> = { added: 0, removed: 0, modified: 0 };
  for (const c of changes) counts[c.category]++;
  return { changes, counts };
}

export function countsText(d: StudioDiff): string {
  const parts: string[] = [];
  if (d.counts.added) parts.push(`${d.counts.added} added`);
  if (d.counts.removed) parts.push(`${d.counts.removed} removed`);
  if (d.counts.modified) parts.push(`${d.counts.modified} modified`);
  return parts.join(", ");
}
