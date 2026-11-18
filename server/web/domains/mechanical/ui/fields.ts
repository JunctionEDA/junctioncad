// fields.ts — what a click in the viewport means while a dialog field is listening.  Pure: the part studio
// (studio.ts) applies what these functions return, and static/tests/cad-fields.test.js checks them.
//
// The rules, which are the ones a person's hands expect from a mature CAD program:
//
//   • while a field that takes geometry is active, every click ADDS to it; a click on something it already holds
//     takes that one out; a click on nothing changes nothing (it never drops the selection or closes the dialog);
//   • a field that holds one thing is replaced by the click, and then the next empty field becomes active;
//   • what was selected before the tool was started fills the first fields that can take it, each pick once;
//   • Esc first makes the active field stop listening, and only then cancels the dialog.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { ParamField } from "../core/feature";
import type { PlaneRef } from "../core/geometry";
import { pickKindsOf, sameTarget, targetOf, targetsIn, type PickLike, type RefTarget } from "../features/_refs";

type Value = JsonObject[string];
/** A pick as these functions need it; the viewport's Pick (viewport/modelview.ts) is one. */
export type FieldPick = PickLike;

/** A field that is filled by clicking in the model. */
export const takesPicks = (f: ParamField): boolean => f.kind === "refs" || f.kind === "plane" || f.kind === "profile" || f.kind === "bodies";

/** The kinds of thing the viewport offers while this field listens (its selection filter); null: everything. */
export function pickKindsFor(field: ParamField | undefined): string[] | null {
  if (!field) return null;
  if (field.kind === "refs") return pickKindsOf(field);
  if (field.kind === "plane") return ["plane", "face", "datum"];
  if (field.kind === "profile") return ["sketch"];
  if (field.kind === "bodies") return ["face"];
  return null;
}
/** The filter in words, for the status line: "edges and faces". */
export function describeKinds(kinds: readonly string[] | null): string {
  if (!kinds || !kinds.length) return "anything";
  const word: { [k: string]: string } = { face: "faces", edge: "edges", vertex: "vertices", plane: "planes", datum: "reference geometry", sketch: "sketches" };
  const names = kinds.map((k) => word[k] || k);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** True when the field holds nothing yet. */
export function isEmpty(field: ParamField, value: Value | undefined): boolean {
  if (field.kind === "refs") return !targetsIn(value).length;
  if (field.kind === "profile") return !value || !(value as { sketch?: string }).sketch;
  return false;   // a plane always has one; no bodies means every body
}

/**
 * The field's value after a click on `pick`, or undefined when the click means nothing to this field (the
 * value stays as it is).  Many-valued fields toggle; single ones are replaced.
 */
export function valueAfterPick(field: ParamField, value: Value | undefined, pick: FieldPick, o: { addOnly?: boolean } = {}): Value | undefined {
  if (field.kind === "refs") {
    const t = targetOf(field, pick); if (!t) return undefined;
    if (field.single) return t;
    const now = targetsIn(value), has = now.some((r) => sameTarget(r, t));
    if (has) return o.addOnly ? undefined : now.filter((r) => !sameTarget(r, t));
    return [...now, t];
  }
  if (field.kind === "bodies") {
    if (pick.kind !== "face" && pick.kind !== "edge" && pick.kind !== "vertex") return undefined;
    const now = Array.isArray(value) ? (value as string[]) : [];
    if (now.includes(pick.body)) return o.addOnly ? undefined : now.filter((b) => b !== pick.body);
    return [...now, pick.body];
  }
  if (field.kind === "profile") {
    // The first click on a sketch takes all of it.  Clicks inside its regions then choose among them: from
    // "all", a click leaves just that region; further clicks add and take away; none left is all again.
    if (pick.kind !== "sketch") return undefined;
    const cur = value as { sketch?: string; regions?: string[] | null } | null | undefined;
    if (!cur || cur.sketch !== pick.featureId || !pick.region) return { sketch: pick.featureId, regions: null };
    const now = Array.isArray(cur.regions) ? cur.regions : [];
    const next = now.includes(pick.region) ? (o.addOnly ? now : now.filter((r) => r !== pick.region)) : [...now, pick.region];
    return { sketch: pick.featureId, regions: next.length ? next : null };
  }
  if (field.kind === "plane") {
    if (pick.kind === "plane") return { kind: "plane", plane: pick.plane } as unknown as Value;
    if (pick.kind === "datum") return pick.datum === "plane" ? ({ kind: "datum", feature: pick.featureId } as unknown as Value) : undefined;
    if (pick.kind === "face") return { kind: "face", ref: { kind: "face", body: pick.body, name: pick.name } } as unknown as Value;
    return undefined;
  }
  return undefined;
}

/** A field holds one thing: after a click fills it, the next field should listen. */
export const holdsOne = (f: ParamField): boolean => f.kind === "plane" || (f.kind === "refs" && !!f.single);

/**
 * The field that should listen next: the first field after `after` (all of them when null) that takes picks and
 * is still empty, among the fields the dialog shows.  Null when every one is filled.
 */
export function nextEmptyField(schema: readonly ParamField[], params: JsonObject, after: string | null = null): string | null {
  const shown = schema.filter((f) => !f.visible || f.visible(params));
  const from = after ? shown.findIndex((f) => f.key === after) + 1 : 0;
  for (const f of [...shown.slice(from), ...shown.slice(0, from)]) {
    if (f.key === after) continue;
    if ((f.kind === "refs" || f.kind === "profile") && isEmpty(f, params[f.key])) return f.key;
  }
  return null;
}

/** The pick field before or after `key`, round the dialog: what Tab and Shift+Tab move to. */
export function neighbourField(schema: readonly ParamField[], params: JsonObject, key: string | null, back = false): string | null {
  const fields = schema.filter((f) => (!f.visible || f.visible(params)) && takesPicks(f));
  if (!fields.length) return null;
  const i = key ? fields.findIndex((f) => f.key === key) : -1;
  if (i < 0) return fields[back ? fields.length - 1 : 0].key;
  return fields[(i + (back ? fields.length - 1 : 1)) % fields.length].key;
}

/**
 * What the selection made before a tool was started fills: each pick goes to the first field that takes it, and
 * to no other.  Returns the parameters to lay over the defaults.
 */
export function fillFromSelection(schema: readonly ParamField[], params: JsonObject, picks: readonly FieldPick[]): JsonObject {
  const out: JsonObject = {};
  const left = picks.slice();
  for (const field of schema) {
    if (!takesPicks(field) || field.kind === "bodies") continue;
    if (field.visible && !field.visible({ ...params, ...out })) continue;
    let value: Value | undefined;
    for (let i = 0; i < left.length; ) {
      const v = valueAfterPick(field, value, left[i], { addOnly: true });
      if (v === undefined) { i++; continue; }
      value = v; left.splice(i, 1);
      if (holdsOne(field) || field.kind === "profile") break;
    }
    if (value !== undefined) out[field.key] = value;
  }
  return out;
}

/** One thing a field holds, with what the viewport must draw to show it. */
export interface HeldItem { key: string; label: string; pick: FieldPick | null; target?: RefTarget }

/** What a field holds, item by item: for the dialog's list and for the highlight kept on the model. */
export function heldItems(field: ParamField, value: Value | undefined, names: { feature(id: string): string | undefined; body(id: string): string | undefined; faces?(body: string): string[] }): HeldItem[] {
  if (field.kind === "refs") {
    const count: { [kind: string]: number } = {};
    return targetsIn(value).map((t, i) => {
      if (t.kind === "plane") return { key: `plane:${t.plane}`, label: `${String(t.plane)[0].toUpperCase()}${String(t.plane).slice(1)} plane`, pick: { kind: "plane", plane: t.plane } as FieldPick, target: t };
      if (t.kind === "datum") return { key: `datum:${t.feature}`, label: names.feature(String(t.feature)) || "Missing reference", pick: { kind: "datum", featureId: String(t.feature), datum: "plane" } as FieldPick, target: t };
      if (t.kind === "sketch") return { key: `sketch:${t.feature}:${t.entity}`, label: `Curve of ${names.feature(String(t.feature)) || "a sketch"}`, pick: { kind: "sketch", featureId: String(t.feature), entity: String(t.entity), region: null } as FieldPick, target: t };
      const kind = t.kind as "face" | "edge" | "vertex";
      count[kind] = (count[kind] || 0) + 1;
      const body = names.body(String(t.body));
      return { key: `${kind}:${t.body}:${t.name}:${i}`, label: `${kind[0].toUpperCase()}${kind.slice(1)} ${count[kind]}${body ? ` of ${body}` : ""}`, pick: { kind, body: String(t.body), name: String(t.name) } as FieldPick, target: t };
    });
  }
  if (field.kind === "bodies") return (Array.isArray(value) ? (value as string[]) : []).map((id) => ({ key: `body:${id}`, label: names.body(id) || "Missing part", pick: null }));
  if (field.kind === "plane") {
    const ref = value as unknown as PlaneRef | undefined;
    if (!ref) return [];
    if (ref.kind === "plane") return [{ key: `plane:${ref.plane}`, label: `${ref.plane[0].toUpperCase()}${ref.plane.slice(1)} plane`, pick: { kind: "plane", plane: ref.plane } }];
    if (ref.kind === "datum") return [{ key: `datum:${ref.feature}`, label: names.feature(ref.feature) || "A missing plane", pick: { kind: "datum", featureId: ref.feature, datum: "plane" } }];
    return [{ key: `face:${ref.ref.body}:${ref.ref.name}`, label: `Face${names.body(ref.ref.body) ? ` of ${names.body(ref.ref.body)}` : " of the model"}`, pick: { kind: "face", body: ref.ref.body, name: ref.ref.name } }];
  }
  return [];
}

/** Everything the dialog's fields hold, as picks to keep highlighted: the listening field's, and the others'. */
export function heldPicks(schema: readonly ParamField[], params: JsonObject, active: string | null, names: Parameters<typeof heldItems>[2]): { active: FieldPick[]; other: FieldPick[] } {
  const out = { active: [] as FieldPick[], other: [] as FieldPick[] };
  for (const f of schema) {
    if (f.visible && !f.visible(params)) continue;
    const into = f.key === active ? out.active : out.other;
    for (const item of heldItems(f, params[f.key], names)) if (item.pick) into.push(item.pick);
    if (f.kind === "bodies" && names.faces) for (const id of Array.isArray(params[f.key]) ? (params[f.key] as string[]) : []) for (const name of names.faces(id)) into.push({ kind: "face", body: id, name });
  }
  return out;
}

/** What Esc does while a dialog is open: put the listening field down first, then cancel the dialog. */
export const escapeStep = (editing: { field: string | null } | null): "field" | "dialog" | null => (!editing ? null : editing.field ? "field" : "dialog");
