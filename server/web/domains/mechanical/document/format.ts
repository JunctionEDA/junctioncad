// format.ts — the part studio document: a `.jpart` file.
//
// It is a JSON item document (web/shared/itemdoc/itemdoc.ts) whose `junction` kind is "part-studio".  Its items:
//
//   feature   one step of the history tree
//             { id, type: "feature", featureType, name, order, suppressed?, params }
//             `featureType` names a registered feature (features/*.ts), `params` is that feature's own data,
//             `order` is an order key (itemdoc.ts orderBetween): the tree is the features sorted by it.
//   studio    one item, id "studio": settings of the whole document
//             { id: "studio", type: "studio", units: "mm", rollback: <feature id> | null }
//             `rollback` is the first feature that is NOT built (the rollback bar sits above it); null is the end.
//
// Unknown item types and unknown keys are kept as they are: a later version (variables, materials, configurations)
// adds items, and an older client must not drop them.  Lengths are millimetres whatever `units` says: `units`
// only chooses how lengths are shown.
import { byOrder, newItemDoc, orderBetween, serializeItemDoc, type Item, type ItemDoc, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { FeatureInput } from "../kernel/protocol";

export const PART_STUDIO_KIND = "part-studio";
export const PART_STUDIO_EXT = ".jpart";
export const STUDIO_ITEM_ID = "studio";

export interface FeatureItem extends Item {
  type: "feature";
  featureType: string;
  name: string;
  order: string;
  suppressed?: boolean;
  params: JsonObject;
}

export interface StudioItem extends Item {
  type: "studio";
  /** the length unit the document is worked in; document/units.ts reads it with `angleUnits` and `precision` */
  units: "mm" | "cm" | "m" | "in" | "ft";
  rollback: string | null;
}

export const isFeature = (i: Item | undefined): i is FeatureItem => !!i && i.type === "feature" && typeof i.featureType === "string";

/** The features in tree order. */
export function featuresOf(doc: ItemDoc): FeatureItem[] {
  const out: FeatureItem[] = [];
  for (const i of doc.items.values()) if (isFeature(i)) out.push(i);
  return byOrder(out);
}

export function studioOf(doc: ItemDoc): StudioItem {
  const s = doc.items.get(STUDIO_ITEM_ID);
  return { id: STUDIO_ITEM_ID, type: "studio", units: "mm", rollback: null, ...(s || {}) } as StudioItem;
}

/** How many features are built: the index of the rollback bar.  A bar on a feature that is gone is at the end. */
export function rollbackIndex(doc: ItemDoc, features: FeatureItem[] = featuresOf(doc)): number {
  const at = studioOf(doc).rollback;
  const i = at ? features.findIndex((f) => f.id === at) : -1;
  return i < 0 ? features.length : i;
}

/** The features as the worker takes them. */
export function featureInputs(features: FeatureItem[]): FeatureInput[] {
  return features.map((f) => ({ id: f.id, type: f.featureType, name: f.name, suppressed: !!f.suppressed, params: f.params || {} }));
}

/** The text of a new, empty part studio: what is uploaded as the document's first snapshot. */
export function newPartStudioText(): string {
  const studio: StudioItem = { id: STUDIO_ITEM_ID, type: "studio", units: "mm", rollback: null };
  return serializeItemDoc(newItemDoc(PART_STUDIO_KIND, [studio]));
}

/** An order key for a feature placed at `index` of the tree (0 is the top; features.length the end). */
export function orderAt(features: FeatureItem[], index: number, moving?: string): string {
  const rest = features.filter((f) => f.id !== moving);
  const i = Math.max(0, Math.min(index, rest.length));
  return orderBetween(i > 0 ? rest[i - 1].order : null, i < rest.length ? rest[i].order : null);
}

/** "Extrude 3": the first free name with that stem. */
export function nextName(features: FeatureItem[], stem: string): string {
  const taken = new Set(features.map((f) => f.name));
  for (let n = 1; ; n++) if (!taken.has(`${stem} ${n}`)) return `${stem} ${n}`;
}
