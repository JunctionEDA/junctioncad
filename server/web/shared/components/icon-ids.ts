// components/icon-ids.ts — the ids inside one drawn copy of a KiCad icon.  The icon pack keeps the ids a drawing
// points at (a gradient's xlink:href, fill:url(#…), marker-end:url(#…)), named after the icon and theme
// (gen_kicad_ui.py clean_svg: k-<icon>-<l|d>-r<n>).  The same icon drawn twice would repeat them, and url(#…)
// finds the first in the page, which may sit in a hidden menu or the other theme's group, where Chrome paints
// nothing; so every copy gets its own.
// one counter for the page: several bundles (ui.js, the dialogs, the editors) carry their own copy of this module
const G = globalThis as unknown as { __kcIconIdSeq?: number };
const REF = /\b(k-[A-Za-z0-9_]+-[ld]-r\d+)\b/g;
/** The icon markup with its referenced ids (and the references to them) made unique to this copy. */
export function uniqueIconIds(markup: string): string {
  if (markup.indexOf("-r") < 0 || !REF.test(markup)) return markup;
  REF.lastIndex = 0;
  const n = (G.__kcIconIdSeq = (G.__kcIconIdSeq || 0) + 1).toString(36);
  return markup.replace(REF, (id) => `${id}-u${n}`);
}
