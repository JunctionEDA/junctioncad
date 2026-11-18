// components/libtree-preview.ts — LIB_TREE's hover preview (common/widgets/lib_tree.cpp showPreview / onIdle): after
// the pointer rests on a symbol or footprint row for HOVER_PREVIEW_DEBOUNCE_MS, a 240 x 200 popup beside the tree
// draws it, and follows the pointer from row to row.  It hides when the pointer leaves the tree, on scroll, a click, a right-click and a key.
// The row's owner says whether a row has a preview (HasPreview: an item other than the one being edited) and draws it.
const PREVIEW_W = 240, PREVIEW_H = 200, DEBOUNCE_MS = 400;

const CSS = `.ltp { position: fixed; z-index: 70; width: ${PREVIEW_W}px; height: ${PREVIEW_H}px; background: var(--panel); border: 1px solid var(--line-2); box-shadow: var(--shadow); pointer-events: none; }
.ltp canvas { display: block; width: 100%; height: 100%; }`;
let styled = false;
function ensureCss(): void { if (styled || typeof document === "undefined") return; styled = true; const st = document.createElement("style"); st.id = "libtree-preview-css"; st.textContent = CSS; document.head.appendChild(st); }

export interface TreePreviewOpts {
  /** the row under the pointer that has a preview, with a key naming it; null for none */
  rowAt(target: Element): { row: HTMLElement; key: string } | null;
  /** draws the row's item into the canvas; false when it cannot (the popup stays hidden) */
  draw(canvas: HTMLCanvasElement, key: string): Promise<boolean> | boolean;
  /** the tree's selected row (onHoverPreview skips it); a row with the "cur" class when left out */
  selected?(row: HTMLElement): boolean;
}

/** Binds the hover preview to a tree's scrolling list; returns the way to hide it (for a menu that opens). */
export function bindTreePreview(list: HTMLElement, o: TreePreviewOpts): { hide(): void } {
  ensureCss();
  let pop: HTMLDivElement | null = null, timer = 0, hoverKey: string | null = null, shownKey: string | null = null, mouseY = 0, seq = 0;
  const hide = (): void => { if (timer) { clearTimeout(timer); timer = 0; } hoverKey = null; shownKey = null; seq++; if (pop) pop.style.display = "none"; };
  const show = async (key: string): Promise<void> => {
    const my = ++seq;
    if (!pop) { pop = document.createElement("div"); pop.className = "ltp"; pop.dataset.k = "treePreview"; pop.append(document.createElement("canvas")); document.body.append(pop); }
    const r = list.getBoundingClientRect();
    pop.style.left = Math.round(Math.min(window.innerWidth - PREVIEW_W - 2, r.right - 10)) + "px";
    pop.style.top = Math.round(Math.max(2, Math.min(window.innerHeight - PREVIEW_H - 2, mouseY - PREVIEW_H / 2))) + "px";
    const moving = pop.style.display === "block" && pop.style.visibility === "visible";
    if (!moving) { pop.style.visibility = "hidden"; pop.style.display = "block"; }
    let ok = false;
    try { ok = await o.draw(pop.querySelector("canvas")!, key); } catch { ok = false; }
    if (my !== seq || !pop) return;
    if (ok) { pop.style.visibility = "visible"; pop.dataset.key = key; shownKey = key; } else { pop.style.display = "none"; shownKey = null; }
  };
  // LIB_TREE::onIdle: while a preview shows it moves straight to the next row that has one (showPreview does nothing
  // for a row without one, so the shown preview stays); otherwise the pointer has to rest on a row for the debounce,
  // restarted by every move, and onHoverPreview leaves out the tree's selected row.
  list.addEventListener("pointermove", (ev) => {
    mouseY = ev.clientY;
    if (ev.buttons) return;
    const hit = o.rowAt(ev.target as Element);
    const key = hit ? hit.key : null;
    if (shownKey) { if (key && key !== shownKey) { hoverKey = key; shownKey = key; void show(key); } return; }
    if (timer) { clearTimeout(timer); timer = 0; }
    hoverKey = key;
    if (!key || !hit) return;
    const row = hit.row;
    timer = window.setTimeout(() => {
      timer = 0;
      if (hoverKey !== key || !row.isConnected) return;
      if ((o.selected ? o.selected(row) : row.classList.contains("cur"))) return;
      void show(key);
    }, DEBOUNCE_MS);
  });
  list.addEventListener("pointerleave", hide);
  list.addEventListener("scroll", hide, { passive: true });
  list.addEventListener("contextmenu", hide);
  list.addEventListener("pointerdown", hide);
  list.addEventListener("keydown", hide);
  return { hide };
}
