// library/libtree.ts — LIB_TREE's filter and order for the editor trees (the Symbol Editor's and the Footprint
// Editor's), without the DOM (node tests: static/tests/libtree.test.js):
//   score        LIB_TREE_NODE_ITEM::UpdateScore: every term must match (name, keywords, description, library),
//                a number term also matches the pin / pad count (as SYMBOL_VIEWER_FRAME's filter adds it)
//   sort         LIB_TREE_NODE::Compare: pinned libraries first, then with "Sort by Best Match" exact matches, then
//                the higher score; otherwise (and for ties) the name
//   recent       LIB_TREE::updateRecentSearchMenu: up to RECENT_SEARCHES_MAX searches per tree, newest first
import { searchScore } from "./core";

export type SortMode = "best" | "alpha";
export const RECENT_SEARCHES_MAX = 10;

export interface TreeItem { name: string; desc?: string; keywords?: string; pins?: number; lib: string }

/** The item's score for the filter text; 0 leaves it out, 1 for an empty filter. */
export function treeScore(item: TreeItem, query: string): { score: number; exact: boolean } {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 1, exact: false };
  let score = 1, exact = false;
  for (const t of terms) {
    let s = searchScore({ name: item.name, description: item.desc, keywords: item.keywords, library: item.lib }, t);
    if (/^\d+$/.test(t) && item.pins !== undefined && Number(t) === item.pins) s += 1;   // a number matches the pin count too
    if (!s) return { score: 0, exact: false };
    if (item.name.toLowerCase() === t.toLowerCase() || (item.lib + ":" + item.name).toLowerCase() === t.toLowerCase()) exact = true;
    score += s;
  }
  return { score, exact };
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** A library's items that pass the filter, in the tree's order. */
export function filterItems<T extends TreeItem>(items: T[], query: string, mode: SortMode): T[] {
  const scored = items.map((it) => ({ it, ...treeScore(it, query) })).filter((x) => x.score > 0);
  if (mode === "best" && query.trim()) scored.sort((a, b) => (a.exact !== b.exact ? (a.exact ? -1 : 1) : b.score - a.score || byName(a.it.name, b.it.name)));
  else scored.sort((a, b) => byName(a.it.name, b.it.name));
  return scored.map((x) => x.it);
}

/** The libraries' order: pinned first, then (best match with a filter) the library holding the better match. */
export function sortLibraries<L extends { name: string; pinned?: boolean; best?: number; exact?: boolean; rank?: number }>(libs: L[], query: string, mode: SortMode): L[] {
  const useScore = mode === "best" && !!query.trim();
  return libs.slice().sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (useScore) {
      if (!!a.exact !== !!b.exact) return a.exact ? -1 : 1;
      if ((a.best || 0) !== (b.best || 0)) return (b.best || 0) - (a.best || 0);
    }
    if ((a.rank || 0) !== (b.rank || 0)) return (b.rank || 0) - (a.rank || 0);
    return byName(a.name, b.name);
  });
}

/** The best score and exact flag among a library's passing items (the library node's own score). */
export function libraryScore(items: TreeItem[], query: string): { best: number; exact: boolean } {
  let best = 0, exact = false;
  for (const it of items) { const s = treeScore(it, query); if (s.score > best) best = s.score; exact = exact || s.exact; }
  return { best, exact };
}

const recents = new Map<string, string[]>();
/** updateRecentSearchMenu: the text joins the tree's recent searches (newest first, no repeats); returns the list. */
export function pushRecentSearch(key: string, text: string): string[] {
  const list = recents.get(key) || [];
  const t = text.trim();
  if (t) {
    const at = list.indexOf(t); if (at >= 0) list.splice(at, 1);
    if (list.length >= RECENT_SEARCHES_MAX) list.pop();
    list.unshift(t);
  }
  recents.set(key, list);
  return list.slice();
}
export const recentSearches = (key: string): string[] => (recents.get(key) || []).slice();
