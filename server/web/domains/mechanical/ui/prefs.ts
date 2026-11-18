// prefs.ts — how one person likes the part studio to behave: kept in this browser, never in the document.
//
//   sketchNormal      opening a sketch turns the view to face its plane (and finishing turns it back)
//   showConstraints   the constraint glyphs of the open sketch are drawn
//   toolVariant       the variant each drop-down of the toolbar used last (Rectangle ▾ → Centre rectangle)
//
// Also here: what a person has hidden or shown in one document (planes, sketches, reference geometry), which is a
// way of looking and so is theirs alone, like the docks' folds (ui/panels.ts).
import { useSyncExternalStore } from "react";

export interface Prefs { sketchNormal: boolean; showConstraints: boolean; toolVariant: { [menu: string]: string } }
const DEFAULTS: Prefs = { sketchNormal: true, showConstraints: true, toolVariant: {} };
const KEY = "junction.cad.prefs";

function read(): Prefs {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "{}"); return v && typeof v === "object" ? { ...DEFAULTS, ...v, toolVariant: { ...(v.toolVariant || {}) } } : DEFAULTS; } catch { return DEFAULTS; }
}
let prefs: Prefs = read();
const listeners = new Set<() => void>();

export const getPrefs = (): Prefs => prefs;
export function setPrefs(patch: Partial<Prefs>): void {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode: it lasts as long as the page */ }
  for (const fn of Array.from(listeners)) fn();
}
export const subscribePrefs = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
/** React: one preference; re-renders when it changes. */
export function usePref<K extends keyof Prefs>(key: K): Prefs[K] { return useSyncExternalStore(subscribePrefs, () => prefs[key]); }

// ---------------------------------------------------------------- what is hidden or shown, per document
/** id → shown.  An id that is absent follows its default (planes shown; a sketch shown until a feature uses it). */
export type Visibility = { readonly [id: string]: boolean };
const visKey = (docId: string | number): string => `junction.cad.visible.${docId}`;

export function readVisibility(docId: string | number): Visibility {
  try { const v = JSON.parse(localStorage.getItem(visKey(docId)) || "{}"); return v && typeof v === "object" ? (v as Visibility) : {}; } catch { return {}; }
}
export function writeVisibility(docId: string | number, v: Visibility): void {
  try { if (Object.keys(v).length) localStorage.setItem(visKey(docId), JSON.stringify(v)); else localStorage.removeItem(visKey(docId)); } catch { /* private mode */ }
}
