// symview/logic.ts — the Symbol Library Browser's list filtering and stepping (symbol_viewer_frame.cpp), as plain data.
import type { LibItem } from "../library/sources";

// ---------------------------------------------------------------- filters (SYMBOL_VIEWER_FRAME::ReCreateLibList / ReCreateSymbolList)
/** Every whitespace-separated token of the filter must occur in the text (case-insensitive). */
export function tokensMatch(filter: string, text: string): boolean {
  const t = text.toLowerCase();
  return filter.trim().toLowerCase().split(/\s+/).filter(Boolean).every((tok) => t.includes(tok));
}
/** The symbol filter reads the name, keywords and description (LIB_SYMBOL::GetSearchText). */
export const symbolSearchText = (it: LibItem): string => `${it.name} ${it.keywords || ""} ${it.description || ""}`;
/** The previous / next symbol of the list (SYMBOL_VIEWER_FRAME::onSelectNextSymbol / onSelectPreviousSymbol): it stops at the ends. */
export function stepSymbol(names: string[], cur: string, dir: 1 | -1): string {
  const i = names.indexOf(cur); if (i < 0) return names[0] || "";
  const j = i + dir; return j >= 0 && j < names.length ? names[j] : cur;
}

