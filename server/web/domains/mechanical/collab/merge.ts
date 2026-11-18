// merge.ts — keeping a draft that is open in a dialog in step with what other people commit meanwhile.  Pure.
//
// A dialog edits a copy of a feature and commits the difference when it is accepted.  If the feature changed in
// the document while the dialog was open, committing "the draft as it is" would put back the old value of every
// parameter the other person changed: their edit would be lost without a word.  So the draft is rebased each
// time the document's feature changes, value by value at the granularity the document merges at (object keys;
// an array is one value):
//
//   they changed it, I did not      the draft takes their value (the dialog and the preview show it)
//   both changed it to the same     nothing to do
//   both changed it, differently    the draft keeps mine, and the conflict is reported so the dialog can say whose
//                                   value will be replaced and offer theirs
//   I changed it, they did not      mine stays
import { clone, diffProps, getPath, stableJson, type Json, type JsonObject } from "../../../shared/itemdoc/itemdoc";

export interface Conflict {
  path: string[];
  /** the value when the dialog opened (or when the last rebase left it), undefined when there was none */
  base: Json | undefined;
  mine: Json | undefined;
  theirs: Json | undefined;
}

export interface Rebase<T> {
  merged: T;
  /** paths the draft took from the document */
  taken: { path: string[]; value: Json | undefined }[];
  conflicts: Conflict[];
}

const same = (a: Json | undefined, b: Json | undefined): boolean => (a === undefined || b === undefined ? a === b : stableJson(a) === stableJson(b));
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Set (undefined: remove) the value at a path of object keys, making the objects on the way. */
export function setAt(root: JsonObject, path: readonly string[], value: Json | undefined): void {
  let at = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = at[path[i]];
    if (isObject(next)) at = next;
    else { if (value === undefined) return; const made: JsonObject = {}; at[path[i]] = made; at = made; }
  }
  if (value === undefined) delete at[path[path.length - 1]]; else at[path[path.length - 1]] = clone(value);
}

/**
 * Rebase `mine` (a draft made from `base`) onto `theirs` (what `base` has become).  None of the three is changed.
 */
export function rebase<T extends JsonObject>(base: T, mine: T, theirs: T): Rebase<T> {
  const merged = clone(mine) as T;
  const out: Rebase<T> = { merged, taken: [], conflicts: [] };
  for (const p of diffProps(base, theirs)) {
    const theirValue = p.del ? undefined : p.value;
    const baseValue = getPath(base, p.path), myValue = getPath(mine, p.path);
    if (same(myValue, theirValue)) continue;
    if (same(myValue, baseValue)) { setAt(merged, p.path, theirValue); out.taken.push({ path: p.path, value: theirValue }); }
    else out.conflicts.push({ path: p.path, base: baseValue, mine: myValue, theirs: theirValue });
  }
  return out;
}

/** True when `mine` differs from `base` anywhere: the person has typed something. */
export function isDirty(base: JsonObject, mine: JsonObject): boolean { return diffProps(base, mine).length > 0; }

/** A value as a person reads it in a sentence: numbers and short texts as they are, the rest summarised. */
export function showValue(v: Json | undefined): string {
  if (v === undefined || v === null) return "nothing";
  if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "string") return v.length > 24 ? v.slice(0, 23) + "…" : v;
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? "item" : "items"}`;
  return "a new value";
}
