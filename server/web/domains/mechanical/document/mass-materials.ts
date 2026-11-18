// mass-materials.ts — materials in a part studio: a small library item in the document and which part is made
// of what.  Pure: reads the document and returns item changes, like edits.ts.
//
//   { id: "materials", type: "materials",
//     library: { "steel": { name: "Steel", density: 7.85, color: "#8c9198" }, … },
//     assign:  { "<body id>": "steel", … } }
//
// Densities are g/cm³.  `color` is how a part of that material is drawn when it has no colour of its own (see
// appearance-items.ts).  The item is written the first time a material is assigned, with the whole starter
// library in it, so a document carries the materials it uses and a person can add their own to `library`.
// Assignments are a map keyed by body id: two people giving different parts a material at once both win.
// A document without the item reads as the starter library with nothing assigned.
import { addedChange, clone, modifiedChange, type Item, type ItemChange, type ItemDoc, type JsonObject } from "../../../shared/itemdoc/itemdoc";

export const MATERIALS_ITEM_ID = "materials";

export interface Material extends JsonObject { name: string; density: number; color: string }

export interface MaterialsItem extends Item {
  type: "materials";
  library: { [id: string]: Material };
  assign: { [bodyId: string]: string };
}

/** What a new document's library holds.  Typical densities at room temperature, g/cm³. */
export const STARTER_MATERIALS: { readonly [id: string]: Material } = {
  "steel": { name: "Steel", density: 7.85, color: "#8c9198" },
  "stainless-steel": { name: "Stainless steel", density: 8.0, color: "#b4b8bd" },
  "aluminium": { name: "Aluminium 6061", density: 2.7, color: "#c3c8cf" },
  "brass": { name: "Brass", density: 8.5, color: "#c9a44c" },
  "copper": { name: "Copper", density: 8.96, color: "#c07a4f" },
  "titanium": { name: "Titanium", density: 4.43, color: "#9c9a95" },
  "abs": { name: "ABS", density: 1.04, color: "#e8e4da" },
  "pla": { name: "PLA", density: 1.24, color: "#e9e1cf" },
  "nylon": { name: "Nylon 6", density: 1.14, color: "#efeadf" },
  "polycarbonate": { name: "Polycarbonate", density: 1.2, color: "#d7e2e6" },
  "acrylic": { name: "Acrylic", density: 1.18, color: "#d4e6ec" },
  "fr4": { name: "FR-4", density: 1.85, color: "#55704a" },
  "rubber": { name: "Rubber", density: 1.1, color: "#3a3a3a" },
  "wood": { name: "Oak", density: 0.75, color: "#a8794c" },
};

const isMaterial = (m: unknown): m is Material => !!m && typeof m === "object" && typeof (m as Material).name === "string" && typeof (m as Material).density === "number" && (m as Material).density > 0;

/** The document's materials: its library (the starter one when it has none yet) and the assignments. */
export function materialsOf(doc: ItemDoc | null): { library: { [id: string]: Material }; assign: { [bodyId: string]: string }; stored: boolean } {
  const it = doc?.items.get(MATERIALS_ITEM_ID) as MaterialsItem | undefined;
  const library: { [id: string]: Material } = {};
  const src = it && it.library && typeof it.library === "object" ? it.library : STARTER_MATERIALS;
  for (const [id, m] of Object.entries(src)) if (isMaterial(m)) library[id] = m;
  const assign: { [bodyId: string]: string } = {};
  if (it && it.assign && typeof it.assign === "object") for (const [b, m] of Object.entries(it.assign)) if (typeof m === "string" && library[m]) assign[b] = m;
  return { library, assign, stored: !!it };
}

/** The material a body is made of, or null. */
export function materialOf(doc: ItemDoc | null, bodyId: string): (Material & { id: string }) | null {
  const { library, assign } = materialsOf(doc);
  const id = assign[bodyId];
  return id && library[id] ? { ...library[id], id } : null;
}

/** Densities (g/cm³) of every body that has a material: what the mass-properties service takes. */
export function densities(doc: ItemDoc | null): { [bodyId: string]: number } {
  const { library, assign } = materialsOf(doc);
  const out: { [bodyId: string]: number } = {};
  for (const [b, m] of Object.entries(assign)) out[b] = library[m].density;
  return out;
}

/** Changes that make `bodyIds` of material `materialId` (null: no material). */
export function assignMaterial(doc: ItemDoc, bodyIds: readonly string[], materialId: string | null): ItemChange[] {
  const now = doc.items.get(MATERIALS_ITEM_ID) as MaterialsItem | undefined;
  const base: MaterialsItem = now ? clone(now) : { id: MATERIALS_ITEM_ID, type: "materials", library: clone(STARTER_MATERIALS as { [id: string]: Material }), assign: {} };
  if (!base.assign || typeof base.assign !== "object") base.assign = {};
  if (materialId !== null && !materialsOf(doc).library[materialId] && !(base.library && base.library[materialId])) return [];
  for (const b of bodyIds) { if (materialId === null) delete base.assign[b]; else base.assign[b] = materialId; }
  if (!now) return materialId === null ? [] : [addedChange(base)];
  const c = modifiedChange(now, base);
  return c ? [c] : [];
}

/** Changes that add (or replace) a material in the document's library. */
export function defineMaterial(doc: ItemDoc, id: string, m: Material): ItemChange[] {
  if (!id || !isMaterial(m)) return [];
  const now = doc.items.get(MATERIALS_ITEM_ID) as MaterialsItem | undefined;
  const base: MaterialsItem = now ? clone(now) : { id: MATERIALS_ITEM_ID, type: "materials", library: clone(STARTER_MATERIALS as { [id: string]: Material }), assign: {} };
  base.library = { ...(base.library || {}), [id]: { name: m.name, density: m.density, color: m.color } };
  if (!now) return [addedChange(base)];
  const c = modifiedChange(now, base);
  return c ? [c] : [];
}
