// symedit/selfilter.ts — the Symbol Editor's Selection Filter (PANEL_SCH_SELECTION_FILTER in a FRAME_SCH_SYMBOL_EDITOR,
// eeschema/widgets/panel_sch_selection_filter.cpp:69-80): Symbols, Wires, Labels, Images and Rule Areas are hidden and
// the rest laid out as All items | Locked items, Pins | Text, Graphics | Other items.  SCH_SELECTION_TOOL::
// itemPassesFilter: pins are Pins; fields, text and text boxes are Text; shapes are Graphics; anything else is Other
// items.  DOM-free: the node tests run it.

export interface SymSelFilter { lockedItems: boolean; pins: boolean; text: boolean; graphics: boolean; otherItems: boolean }
export type SymFilterKey = keyof SymSelFilter;
/** The grid in KiCad's order, two per row. */
export const SYM_FILTER_ROWS: [SymFilterKey | "all", string][] = [["all", "All items"], ["lockedItems", "Locked items"], ["pins", "Pins"], ["text", "Text"], ["graphics", "Graphics"], ["otherItems", "Other items"]];
export const SYM_FILTER_KINDS: SymFilterKey[] = ["pins", "text", "graphics", "otherItems"];
export const defaultSymFilter = (): SymSelFilter => ({ lockedItems: true, pins: true, text: true, graphics: true, otherItems: true });

const GRAPHICS = new Set(["rectangle", "circle", "arc", "polyline", "bezier", "ellipse", "ellipse_arc"]);
/** The filter class of a symbol item by its node type. */
export function symFilterClass(type: string): SymFilterKey {
  if (type === "pin") return "pins";
  if (type === "property" || type === "text" || type === "text_box") return "text";
  if (GRAPHICS.has(type)) return "graphics";
  return "otherItems";
}
export function symPasses(f: SymSelFilter, type: string): boolean { return f[symFilterClass(type)]; }
/** "All items" is checked when every kind is (SCH_SELECTION_FILTER_OPTIONS::All); Locked items is special and left out. */
export function symAllChecked(f: SymSelFilter): boolean { return SYM_FILTER_KINDS.every((k) => f[k]); }
/** PANEL_SCH_SELECTION_FILTER::OnFilterChanged / onPopupSelection ("Only <kind>"): neither touches Locked items. */
export function symSetFilter(f: SymSelFilter, key: SymFilterKey | "all" | `only:${SymFilterKey}`, on: boolean): SymSelFilter {
  const n = { ...f };
  if (key === "all") { for (const k of SYM_FILTER_KINDS) n[k] = on; return n; }
  if (key.startsWith("only:")) { const only = key.slice(5) as SymFilterKey; for (const k of SYM_FILTER_KINDS) n[k] = k === only; return n; }
  n[key as SymFilterKey] = on; return n;
}
