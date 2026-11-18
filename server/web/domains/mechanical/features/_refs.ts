// _refs.ts — what a `refs` field stores when it takes more than faces, edges and vertices: reference geometry
// (a plane, axis, point or curve feature), a default plane, or a sketch curve.  Pure: the page turns picks into
// these (ui/studio.ts), the worker turns them into geometry (kernel/ops/ref-geom.ts).
//
// Stored shapes (JSON, in a feature's params):
//   { kind: "face" | "edge" | "vertex", body, name }     a GeomRef, as everywhere else
//   { kind: "plane", plane: "top" | "front" | "right" }   a default plane
//   { kind: "datum", feature: <feature id> }               the plane, axis, point or curve that feature made
//   { kind: "sketch", feature: <sketch id>, entity }       one curve of a sketch
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { ParamField } from "../core/feature";
import { isGeomRef, type DefaultPlaneId, type GeomRef } from "../core/geometry";

export type DatumKind = "plane" | "axis" | "point" | "curve";
export type DefaultPlaneTarget = JsonObject & { kind: "plane"; plane: DefaultPlaneId };
export type DatumTarget = JsonObject & { kind: "datum"; feature: string };
export type SketchCurveTarget = JsonObject & { kind: "sketch"; feature: string; entity: string };
export type RefTarget = GeomRef | DefaultPlaneTarget | DatumTarget | SketchCurveTarget;

/** The picks a viewport can hand a field, in the shape this file needs (modelview.ts Pick is a superset). */
export type PickLike =
  | { kind: "face" | "edge" | "vertex"; body: string; name: string }
  | { kind: "plane"; plane: DefaultPlaneId }
  | { kind: "datum"; featureId: string; datum: DatumKind }
  | { kind: "sketch"; featureId: string; entity: string | null; region: string | null };

type RefsField = Extract<ParamField, { kind: "refs" }>;

/** What a pick means for a `refs` field, or null when the field does not take it. */
export function targetOf(field: RefsField, p: PickLike): RefTarget | null {
  if (p.kind === "face" || p.kind === "edge" || p.kind === "vertex") return field.of.includes(p.kind) ? { kind: p.kind, body: p.body, name: p.name } : null;
  if (p.kind === "plane") return field.planes ? { kind: "plane", plane: p.plane } : null;
  if (p.kind === "datum") return field.datums && field.datums.includes(p.datum) ? { kind: "datum", feature: p.featureId } : null;
  if (p.kind === "sketch") return field.sketch && p.entity ? { kind: "sketch", feature: p.featureId, entity: p.entity } : null;
  return null;
}

/** The pick kinds a `refs` field listens to, for the viewport's filter. */
export function pickKindsOf(field: RefsField): string[] {
  const out: string[] = [...field.of];
  if (field.planes) out.push("plane");
  if (field.datums && field.datums.length) out.push("datum");
  if (field.sketch) out.push("sketch");
  return out;
}

export function sameTarget(a: RefTarget, b: RefTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (isGeomRef(a) && isGeomRef(b)) return a.body === b.body && a.name === b.name;
  if (a.kind === "plane") return a.plane === (b as DefaultPlaneTarget).plane;
  if (a.kind === "datum") return a.feature === (b as DatumTarget).feature;
  return a.feature === (b as SketchCurveTarget).feature && a.entity === (b as SketchCurveTarget).entity;
}

/** The targets a field's value holds (one, many, or none). */
export function targetsIn(value: unknown): RefTarget[] {
  const all = Array.isArray(value) ? value : value ? [value] : [];
  return all.filter((v): v is RefTarget => !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string");
}

/** A word for what a list of targets holds, for the dialog ("2 edges", "Top plane", "Plane 1"). */
export function describeTargets(targets: readonly RefTarget[], featureName: (id: string) => string | undefined): string {
  if (targets.length === 1) {
    const t = targets[0];
    if (t.kind === "plane") return `${t.plane[0].toUpperCase()}${t.plane.slice(1)} plane`;
    if (t.kind === "datum") return featureName(t.feature) || "missing reference";
    if (t.kind === "sketch") return `a curve of ${featureName(t.feature) || "a sketch"}`;
    return `1 ${t.kind}`;
  }
  const kinds = new Set(targets.map((t) => (isGeomRef(t) ? t.kind : t.kind === "sketch" ? "curve" : "reference")));
  return `${targets.length} ${kinds.size === 1 ? Array.from(kinds)[0] + "s" : "items"}`;
}
