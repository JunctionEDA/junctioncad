// edits.ts — every edit of a part studio, as the item changes that make it.
//
// Each function reads the document and returns changes; none applies or sends anything.  The caller commits them
// through the document's session (`studio.commit(changes)`, which is ItemDocSession.commit), and that is the one
// way a part studio changes: applied locally, sent to the server, shown to everyone else, undoable.
// A tool or an agent that needs an edit this file lacks builds its own changes with the same helpers.
import { addedChange, modifiedChange, newId, removedChange, type ItemChange, type ItemDoc, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { FeatureDefinition } from "../core/feature";
import { STUDIO_ITEM_ID, featuresOf, isFeature, nextName, orderAt, rollbackIndex, studioOf, type FeatureItem, type StudioItem } from "./format";

/** Changes that set the rollback bar before `featureId` (null: the end). */
export function setRollback(doc: ItemDoc, featureId: string | null): ItemChange[] {
  const now = doc.items.get(STUDIO_ITEM_ID) as StudioItem | undefined;
  if (!now) return [addedChange({ ...studioOf(doc), rollback: featureId })];
  const c = modifiedChange(now, { ...now, rollback: featureId });
  return c ? [c] : [];
}

/**
 * A new feature of a registered type, inserted at the rollback bar (the end, when the bar is at the end), with
 * the type's default parameters overlaid by `params`.  Returns the changes and the new item.
 */
export function addFeature(doc: ItemDoc, def: FeatureDefinition, params: JsonObject = {}, name?: string): { changes: ItemChange[]; feature: FeatureItem } {
  const features = featuresOf(doc);
  const at = rollbackIndex(doc, features);
  const feature: FeatureItem = {
    id: newId(), type: "feature", featureType: def.type, name: name || nextName(features, def.title),
    order: orderAt(features, at), params: { ...def.defaults(), ...params },
  };
  // the bar stays where it is: right below the new feature, so the feature is built
  return { changes: [addedChange(feature)], feature };
}

/** Replace a feature's parameters; only the paths that differ are sent. */
export function setParams(doc: ItemDoc, featureId: string, params: JsonObject): ItemChange[] {
  const f = doc.items.get(featureId);
  if (!isFeature(f)) return [];
  const c = modifiedChange(f, { ...f, params });
  return c ? [c] : [];
}

/** Change one path inside a feature's parameters (`["sketch", "entities", id]`); `undefined` removes it. */
export function setParamPath(doc: ItemDoc, featureId: string, path: string[], value: JsonObject[string] | undefined): ItemChange[] {
  const f = doc.items.get(featureId);
  if (!isFeature(f)) return [];
  return [{ id: featureId, kind: "MODIFIED", typeName: "feature", props: [value === undefined ? { path: ["params", ...path], del: true } : { path: ["params", ...path], value }] }];
}

export function renameFeature(doc: ItemDoc, featureId: string, name: string): ItemChange[] {
  const f = doc.items.get(featureId), n = name.trim();
  if (!isFeature(f) || !n || n === f.name) return [];
  return [{ id: featureId, kind: "MODIFIED", typeName: "feature", props: [{ path: ["name"], value: n }] }];
}

export function suppressFeature(doc: ItemDoc, featureId: string, suppressed: boolean): ItemChange[] {
  const f = doc.items.get(featureId);
  if (!isFeature(f) || !!f.suppressed === suppressed) return [];
  return [{ id: featureId, kind: "MODIFIED", typeName: "feature", props: [suppressed ? { path: ["suppressed"], value: true } : { path: ["suppressed"], del: true }] }];
}

/** Move a feature so that it sits at `index` of the tree as it will be without it (0 is the top). */
export function moveFeature(doc: ItemDoc, featureId: string, index: number): ItemChange[] {
  const features = featuresOf(doc);
  const from = features.findIndex((f) => f.id === featureId);
  if (from < 0) return [];
  const rest = features.filter((f) => f.id !== featureId);
  const to = Math.max(0, Math.min(index, rest.length));
  if (to === from) return [];
  return [{ id: featureId, kind: "MODIFIED", typeName: "feature", props: [{ path: ["order"], value: orderAt(features, to, featureId) }] }];
}

/** Delete a feature.  A rollback bar that sat on it moves to the feature below. */
export function deleteFeature(doc: ItemDoc, featureId: string): ItemChange[] {
  const f = doc.items.get(featureId);
  if (!isFeature(f)) return [];
  const out: ItemChange[] = [];
  if (studioOf(doc).rollback === featureId) {
    const features = featuresOf(doc), i = features.findIndex((x) => x.id === featureId);
    out.push(...setRollback(doc, features[i + 1] ? features[i + 1].id : null));
  }
  out.push(removedChange(f));
  return out;
}
