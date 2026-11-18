// components/libtree-filter.ts — LIB_TREE's filter row (common/widgets/lib_tree.cpp:80-165) for the editor trees:
//   a wxSearchCtrl (the magnifier opens the recent-searches menu, a themed cancel button clears the text), a
//   vertical rule, and the config button whose menu is Sort by Best Match / Sort Alphabetically, Expand All /
//   Collapse All.  The sort mode is kept per tree for this viewer.  Every menu goes through dialogs/dom popupMenu
//   (menufit.ts).
import { popupMenu, type PopItem } from "../../domains/pcb/dialogs/dom";
import { kicadIcon } from "./kicon-dom";
import { pushRecentSearch, recentSearches, type SortMode } from "../../domains/pcb/library/libtree";

export interface LibTreeFilterOpts {
  /** the tree's key: recent searches and the sort mode are kept under it */
  key: string;
  id?: string;
  onText(text: string): void;
  onSort(mode: SortMode): void;
  expandAll(): void;
  collapseAll(): void;
  /** keys the filter box passes to the tree (Up / Down / Enter / numpad + and -) */
  onKey?(ev: KeyboardEvent): void;
}
export interface LibTreeFilter { el: HTMLElement; input: HTMLInputElement; value(): string; set(text: string): void; sort(): SortMode; remember(): void }

const CSS = `
.ltf { display: flex; align-items: center; gap: 4px; padding: 2px; }
.ltf-box { flex: 1; min-width: 0; display: flex; align-items: center; gap: 2px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-2); padding: 0 2px; height: 24px; }
.ltf-box:focus-within { border-color: var(--blue); }
.ltf-box input { flex: 1; min-width: 0; border: 0 !important; outline: 0 !important; background: transparent !important; color: var(--ink); font: inherit; font-size: var(--fs-sm); padding: 2px 2px !important; height: 20px; box-shadow: none !important; margin: 0 !important; border-radius: 0 !important; }
.ltf-box input::-webkit-search-cancel-button { display: none; }
.ltf-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: var(--r-1); background: transparent; color: var(--ink-2); cursor: default; }
.ltf-btn:hover { background: var(--sel-soft); color: var(--ink); }
.ltf-cancel { visibility: hidden; }
.ltf-box.has-text .ltf-cancel { visibility: visible; }
.ltf-sep { flex: none; width: 1px; align-self: stretch; margin: 3px 0; background: var(--line); }
.ltf-cfg { width: 24px; height: 24px; }
`;
let styled = false;
function ensureCss(): void { if (styled || typeof document === "undefined") return; styled = true; const st = document.createElement("style"); st.id = "libtree-filter-css"; st.textContent = CSS; document.head.appendChild(st); }
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string>, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.append(...kids); return e;
};
const SORT_KEY = (k: string): string => `kui.libtree.${k}.sort`;
export function loadSortMode(key: string): SortMode { try { return localStorage.getItem(SORT_KEY(key)) === "alpha" ? "alpha" : "best"; } catch { return "best"; } }

export function libTreeFilter(o: LibTreeFilterOpts): LibTreeFilter {
  ensureCss();
  let mode = loadSortMode(o.key);
  const input = el("input", { type: "text", placeholder: "Filter", spellcheck: "false", autocomplete: "off", "aria-label": "Filter", ...(o.id ? { id: o.id } : {}) });
  const glass = el("button", { type: "button", class: "ltf-btn ltf-search", title: "Recent searches", tabindex: "-1", "data-k": "recentSearches" });
  // wxSearchCtrl's glass and cancel bitmaps: a magnifier and a cross drawn in the ink colour
  glass.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/></svg>';
  const cancel = el("button", { type: "button", class: "ltf-btn ltf-cancel", title: "Clear", tabindex: "-1", "data-k": "clearFilter" });
  cancel.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="6" fill="currentColor" opacity=".55"/><path d="M4 4l4 4M8 4l-4 4" stroke="var(--panel)" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const box = el("div", { class: "ltf-box" }, glass, input, cancel);
  const cfg = el("button", { type: "button", class: "ltf-btn ltf-cfg", title: "", "data-k": "treeConfig" }, kicadIcon("config", 16));
  const row = el("div", { class: "ltf" }, box, el("span", { class: "ltf-sep" }), cfg);
  const changed = (): void => { box.classList.toggle("has-text", !!input.value); o.onText(input.value); };
  const remember = (): void => { pushRecentSearch(o.key, input.value); };
  input.addEventListener("input", changed);
  cancel.addEventListener("click", () => { input.value = ""; changed(); input.focus(); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && input.value) { ev.preventDefault(); ev.stopPropagation(); input.value = ""; changed(); return; }
    const nav = ev.key === "ArrowUp" || ev.key === "ArrowDown" || ev.key === "Enter" || ev.code === "NumpadAdd" || ev.code === "NumpadSubtract";
    if (nav) { remember(); if (o.onKey) o.onKey(ev); }
  });
  // the search menu: the recent searches, or one disabled "recent searches" row
  glass.addEventListener("click", () => {
    remember();
    const list = recentSearches(o.key);
    const items: PopItem[] = list.length ? list.map((t) => ({ label: t, run: () => { input.value = t; changed(); input.focus(); } })) : [{ label: "recent searches", disabled: true }];
    const r = glass.getBoundingClientRect(); const m = popupMenu(r.left, r.bottom + 2, items); m.dataset.k = "recentSearchesMenu";
  });
  cfg.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const set = (m: SortMode) => (): void => { mode = m; try { localStorage.setItem(SORT_KEY(o.key), m); } catch { /* no storage */ } o.onSort(m); };
    const r = cfg.getBoundingClientRect();
    const menu = popupMenu(r.left, r.bottom + 2, [
      { label: "Sort by Best Match", check: true, checked: mode === "best", run: set("best") },
      { label: "Sort Alphabetically", check: true, checked: mode === "alpha", run: set("alpha") },
      { sep: true },
      { label: "Expand All", run: o.expandAll },
      { label: "Collapse All", run: o.collapseAll },
    ]);
    menu.dataset.k = "treeConfigMenu";
  });
  return { el: row, input, value: () => input.value, set(t) { input.value = t; box.classList.toggle("has-text", !!t); }, sort: () => mode, remember };
}
