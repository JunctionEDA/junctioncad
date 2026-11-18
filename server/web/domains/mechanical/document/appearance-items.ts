// appearance-items.ts — how parts look, and the views people named, as items of the part studio.  Pure: reads
// the document and returns item changes, like edits.ts.
//
//   { id: "appearance", type: "appearance",
//     bodies: { "<body id>": { color: "#3d7bd9", opacity: 0.5, faces: { "<face name>": "#d94a3d" } } } }
//   { id: <uuid>, type: "named-view", name: "Underside", order, camera: { quaternion, target, zoom, projection } }
//
// Colours are "#rrggbb" chosen by a person (data, not chrome).  A body with no colour is drawn in its material's
// colour, or the theme's.  Everything is keyed by body id and face name, so two people colouring different
// parts or faces at once both win; a face name is the stable name of CONTRACT.md "Geometry names", so a face
// keeps its colour across rebuilds as long as it keeps its name.  Hide, show and isolate are not stored: they
// are each person's own view.
import { addedChange, byOrder, clone, modifiedChange, newId, orderBetween, removedChange, type Item, type ItemChange, type ItemDoc, type JsonObject } from "../../../shared/itemdoc/itemdoc";

export const APPEARANCE_ITEM_ID = "appearance";

export interface BodyLook extends JsonObject { color?: string; opacity?: number; faces?: { [faceName: string]: string } }
export interface AppearanceItem extends Item { type: "appearance"; bodies: { [bodyId: string]: BodyLook } }

export interface CameraJson extends JsonObject { quaternion: number[]; target: number[]; zoom: number; projection: string }
export interface NamedViewItem extends Item { type: "named-view"; name: string; order: string; camera: CameraJson }

export const isColor = (c: unknown): c is string => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
const clampOpacity = (o: number) => Math.max(0.05, Math.min(1, o));

/** Every body's look as stored, cleaned: bad colours and opacities are dropped. */
export function looksOf(doc: ItemDoc | null): { [bodyId: string]: BodyLook } {
  const it = doc?.items.get(APPEARANCE_ITEM_ID) as AppearanceItem | undefined;
  const out: { [bodyId: string]: BodyLook } = {};
  if (!it || !it.bodies || typeof it.bodies !== "object") return out;
  for (const [id, raw] of Object.entries(it.bodies)) {
    if (!raw || typeof raw !== "object") continue;
    const look: BodyLook = {};
    if (isColor(raw.color)) look.color = raw.color.toLowerCase();
    if (typeof raw.opacity === "number" && Number.isFinite(raw.opacity)) look.opacity = clampOpacity(raw.opacity);
    if (raw.faces && typeof raw.faces === "object") {
      const faces: { [n: string]: string } = {};
      for (const [n, c] of Object.entries(raw.faces)) if (isColor(c)) faces[n] = c.toLowerCase();
      if (Object.keys(faces).length) look.faces = faces;
    }
    out[id] = look;
  }
  return out;
}

function edit(doc: ItemDoc, fn: (bodies: { [bodyId: string]: BodyLook }) => void): ItemChange[] {
  const now = doc.items.get(APPEARANCE_ITEM_ID) as AppearanceItem | undefined;
  const next: AppearanceItem = now ? clone(now) : { id: APPEARANCE_ITEM_ID, type: "appearance", bodies: {} };
  if (!next.bodies || typeof next.bodies !== "object") next.bodies = {};
  fn(next.bodies);
  for (const [id, look] of Object.entries(next.bodies)) {
    if (look && look.faces && !Object.keys(look.faces).length) delete look.faces;
    if (!look || !Object.keys(look).length) delete next.bodies[id];
  }
  if (!now) return Object.keys(next.bodies).length ? [addedChange(next)] : [];
  const c = modifiedChange(now, next);
  return c ? [c] : [];
}

/** Set (or with null, clear) the colour and opacity of whole bodies.  Keys left out are left alone. */
export function setBodyLook(doc: ItemDoc, bodyIds: readonly string[], patch: { color?: string | null; opacity?: number | null }): ItemChange[] {
  return edit(doc, (bodies) => {
    for (const id of bodyIds) {
      const look: BodyLook = { ...(bodies[id] || {}) };
      if (patch.color === null) delete look.color; else if (isColor(patch.color)) look.color = patch.color.toLowerCase();
      if (patch.opacity === null || patch.opacity === 1) delete look.opacity; else if (typeof patch.opacity === "number") look.opacity = clampOpacity(patch.opacity);
      bodies[id] = look;
    }
  });
}

/** Colour faces of a body (null clears them back to the body's colour). */
export function setFaceColor(doc: ItemDoc, faces: readonly { body: string; name: string }[], color: string | null): ItemChange[] {
  if (color !== null && !isColor(color)) return [];
  return edit(doc, (bodies) => {
    for (const f of faces) {
      const look: BodyLook = { ...(bodies[f.body] || {}) };
      const map = { ...(look.faces || {}) };
      if (color === null) delete map[f.name]; else map[f.name] = color.toLowerCase();
      look.faces = map;
      bodies[f.body] = look;
    }
  });
}

/** Forget every colour and opacity of these bodies, faces included. */
export function resetLook(doc: ItemDoc, bodyIds: readonly string[]): ItemChange[] {
  return edit(doc, (bodies) => { for (const id of bodyIds) delete bodies[id]; });
}

export const isNamedView = (i: Item | undefined): i is NamedViewItem => !!i && i.type === "named-view" && typeof i.name === "string" && !!i.camera && Array.isArray((i.camera as CameraJson).quaternion);

export function namedViews(doc: ItemDoc | null): NamedViewItem[] {
  if (!doc) return [];
  const out: NamedViewItem[] = [];
  for (const i of doc.items.values()) if (isNamedView(i)) out.push(i);
  return byOrder(out);
}

/** A new named view at the end of the list (a view with the same name is replaced). */
export function addNamedView(doc: ItemDoc, name: string, camera: CameraJson): ItemChange[] {
  const views = namedViews(doc), clean = name.trim() || `View ${views.length + 1}`;
  const same = views.find((v) => v.name === clean);
  if (same) { const c = modifiedChange(same, { ...same, camera: clone(camera) }); return c ? [c] : []; }
  const item: NamedViewItem = { id: newId(), type: "named-view", name: clean, order: orderBetween(views.length ? views[views.length - 1].order : null, null), camera: clone(camera) };
  return [addedChange(item)];
}

export function removeNamedView(doc: ItemDoc, id: string): ItemChange[] {
  const v = doc.items.get(id);
  return isNamedView(v) ? [removedChange(v)] : [];
}
