// kicad-dialogs/widgets.ts — widgets: notebook, treebook, grid
// The pieces KiCad's larger dialogs are made of (wxNotebook, PAGED_DIALOG's wxTreebook, WX_GRID with its
// add / delete / move buttons).  Their CSS travels with them so a dialog works wherever this file is loaded.
import type { GridApi, GridCellButton, GridColumn, GridOpts, NotebookApi, NotebookTab, TreebookApi, TreeSection } from "../../dialogs/dom";
import { esc, isList, str } from "./sexpr";
import { el } from "./shell";
import { bitmapButton, ensureIconCss, kicadIcon, setKicadIcon } from "../../../../shared/components/kicon-dom";
import { popupMenu } from "../../dialogs/dom";
import "../../../../shared/components/kselect";   // <k-select>, the themed drop-down these use in place of <select>

const WIDGET_CSS = `
.kd-overlay.kd-modeless { background: transparent; pointer-events: none; align-items: flex-start; justify-content: flex-end; padding: 96px 60px 0 0; }
.kd-overlay.kd-modeless .kd-dialog { pointer-events: auto; }
.kd-dialog.kd-wide { max-width: min(1180px, 96vw); }
.kd-dialog.kd-flush .kd-body { padding: 0; }
.kd-nb { display: flex; flex-direction: column; min-height: 0; }
.kd-nb-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line); padding: 0 6px; }
.kd-nb-tab { padding: 5px 14px; border: 1px solid transparent; border-bottom: none; border-radius: 4px 4px 0 0; cursor: pointer; color: var(--ink-2); margin-bottom: -1px; user-select: none; }
.kd-nb-tab.on { background: var(--bench); border-color: var(--line); color: var(--ink); font-weight: 600; }
.kd-nb-page { padding: 10px 4px 2px; min-height: 0; }
.kd-tb { display: grid; grid-template-columns: minmax(190px, max-content) 1fr; min-height: 420px; }
.kd-tb-tree { border-right: 1px solid var(--line); background: var(--panel); padding: 6px 0; overflow: auto; user-select: none; }
.kd-tb-node { padding: 3px 10px; cursor: default; white-space: nowrap; color: var(--ink); }
.kd-tb-node.child { padding-left: 26px; cursor: pointer; }
.kd-tb-node.parent { cursor: pointer; }
.kd-tb-node.parent::before, .kd-twist::before { content: ""; display: inline-block; width: 0; height: 0; margin: 0 5px 2px 1px; vertical-align: middle; border-style: solid; border-width: 5px 4px 0 4px; border-color: var(--ink-3) transparent transparent transparent; }
.kd-twist { display: inline-block; width: 14px; cursor: pointer; }
.kd-twist.shut::before { border-width: 4px 0 4px 5px; border-color: transparent transparent transparent var(--ink-3); margin-left: 2px; }
/* wxTreebook's selection: the selected-row colour with the normal text (readable in both themes), a lighter one on hover */
.kd-tb-node.child:hover, .kd-tb-node.parent:hover { background: var(--sel-soft); }
.kd-tb-node.on, .kd-tb-node.on:hover { background: var(--sel); color: var(--ink); }
.kd-tb-page { padding: 12px 16px; overflow: auto; max-height: 68vh; }
.kd-grid-wrap { border: 1px solid var(--line); overflow: auto; background: var(--panel); }
.kd-grid { border-collapse: collapse; width: 100%; font-size: 12px; }
.kd-grid th { position: sticky; top: 0; background: var(--bench); text-align: left; font-weight: 600; padding: 4px 6px; border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); white-space: nowrap; z-index: 1; }
.kd-grid td { border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); padding: 0; height: 22px; }
.kd-grid tr.sel td { background: color-mix(in srgb, var(--blue) 18%, transparent); }
.kd-grid td.ro { padding: 2px 6px; color: var(--ink-2); }
.kd-grid td.c { text-align: center; }
.kd-nowrap .kd-grid td.ro { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 420px; }
.kd-grid td.kd-icon-cell { width: 24px; }
.kd-grid .kd-cell-ic { border: 0; background: transparent; padding: 1px; display: inline-flex; cursor: pointer; border-radius: var(--r-1); vertical-align: middle; }
.kd-grid .kd-cell-ic:hover { background: var(--sel-soft); }
.kd-body .kd-grid td input[type=text], .kd-body .kd-grid td input[type=number], .kd-body .kd-grid td k-select { border: none; background: transparent; border-radius: 0; padding: 2px 6px; font-family: inherit; }
.kd-body .kd-grid td input[type=text]:focus, .kd-body .kd-grid td k-select:focus-within { outline: 2px solid var(--blue); outline-offset: -2px; background: var(--panel); }
.kd-grid td input[type=checkbox] { margin: 0; }
.kd-grid td.kd-btn-cell { position: relative; }
.kd-body .kd-grid td.kd-btn-cell input[type=text] { padding-right: 24px; }
.kd-grid .kd-cell-btn { position: absolute; top: 1px; right: 1px; bottom: 1px; width: 22px; padding: 0; display: flex; align-items: center; justify-content: center; border: 0; border-radius: var(--r-1); background: transparent; color: var(--ink-2); cursor: pointer; visibility: hidden; }
.kd-grid td.kd-btn-cell:focus-within .kd-cell-btn, .kd-grid tr:hover td.kd-btn-cell .kd-cell-btn { visibility: visible; }
.kd-grid .kd-cell-btn:hover { background: var(--sel-soft); }
.kd-grid .kd-cell-btn:active { background: var(--on); }
.kd-grid-btns { display: flex; gap: 4px; margin-top: 4px; align-items: center; }
.kd-grid-btns .btn { padding: 1px 7px; min-width: 26px; font-size: 13px; line-height: 18px; }
.kd-grid-btns .kd-gap { width: 16px; flex: none; }
.kd-grid-btns .kd-fill { flex: 1; }
.kd-sb { border: 1px solid var(--line); border-radius: 3px; padding: 14px 10px 8px; margin: 12px 0 8px; position: relative; }
.kd-sb > .kd-sb-t { position: absolute; top: -9px; left: 8px; background: var(--bench); padding: 0 4px; color: var(--ink-2); font-size: 12px; }
.kd-row { display: flex; gap: 8px; align-items: center; }
.kd-chk { display: flex; gap: 6px; align-items: center; color: var(--ink); margin: 3px 0; }
.kd-chk input { width: auto; margin: 0; }
`;
let cssDone = false;
export function ensureCss(): void { if (cssDone || typeof document === "undefined") return; cssDone = true; const st = document.createElement("style"); st.id = "kd-widget-css"; st.textContent = WIDGET_CSS; document.head.appendChild(st); }

/** wxNotebook: tabs = [{ label, build(page) }]; pages are built on first show.  -> { el, select(i), index() } */
export function notebook(host: HTMLElement, tabs: NotebookTab[], opts?: { selected?: number; onSelect?(i: number): void }): NotebookApi {
  ensureCss();
  const nb = el("div", "kd-nb"), bar = el("div", "kd-nb-tabs"), pages: HTMLElement[] = []; let cur = -1;
  const select = (i: number): void => { if (i === cur || !tabs[i]) return; cur = i;
    [...bar.children].forEach((t, j) => t.classList.toggle("on", j === i));
    pages.forEach((p, j) => { p.style.display = j === i ? "" : "none"; });
    if (!pages[i].dataset.built) { pages[i].dataset.built = "1"; tabs[i].build(pages[i]); }
    if (opts && opts.onSelect) opts.onSelect(i); };
  tabs.forEach((t, i) => { const tab = el("div", "kd-nb-tab", esc(t.label)); tab.addEventListener("click", () => select(i)); bar.appendChild(tab); const pg = el("div", "kd-nb-page"); pg.style.display = "none"; pages.push(pg); });
  nb.append(bar, ...pages); host.appendChild(nb); select((opts && opts.selected) || 0);
  return { el: nb, select, index: () => cur, pages };
}

/** PAGED_DIALOG's treebook: sections = [{ label, pages: [{ label, build(page) }] }].  -> { el, select(label), current() } */
export function treebook(host: HTMLElement, sections: TreeSection[], opts?: { selected?: string; onSelect?(label: string): void }): TreebookApi {
  ensureCss();
  // pages are keyed "Section/Page": two sections may each have a page of the same name (Preferences: "Grids" under both editors)
  const tb = el("div", "kd-tb"), tree = el("div", "kd-tb-tree"), pane = el("div", "kd-tb-page"), built = new Map<string, HTMLElement>(), nodes = new Map<string, HTMLElement>(); let cur: string | null = null;
  const pages = new Map<string, NotebookTab>(); for (const s of sections) for (const p of s.pages) pages.set(s.label + "/" + p.label, p);
  /** a "Section/Page" key, or a page label (the first page of that name) */
  const keyOf = (label: string): string | null => (pages.has(label) ? label : [...pages.entries()].find(([, p]) => p.label === label)?.[0] || null);
  const select = (label: string): void => { const key = keyOf(label); if (!key) return; const pg = pages.get(key)!; cur = pg.label;
    for (const [l, n] of nodes) n.classList.toggle("on", l === key);
    for (const [l, d] of built) d.style.display = l === key ? "" : "none";
    if (!built.has(key)) { const d = el("div"); built.set(key, d); pane.appendChild(d); pg.build(d); }
    if (opts && opts.onSelect) opts.onSelect(pg.label); };
  for (const s of sections) {
    const pn = el("div", "kd-tb-node parent", esc(s.label)); tree.appendChild(pn);
    pn.addEventListener("click", () => { if (s.pages[0]) select(s.label + "/" + s.pages[0].label); });
    for (const p of s.pages) { const key = s.label + "/" + p.label; const n = el("div", "kd-tb-node child", esc(p.label)); n.dataset.page = key; n.addEventListener("click", () => select(key)); nodes.set(key, n); tree.appendChild(n); }
  }
  tb.append(tree, pane); host.appendChild(tb);
  const first = (opts && opts.selected) || (sections[0] && sections[0].pages[0] && sections[0].label + "/" + sections[0].pages[0].label); if (first) select(first);
  return { el: tb, select, current: () => cur };
}

/**
 * WX_GRID: columns = [{ key, label, type: "text" | "bool" | "choice" | "ro", options, width, ro(row) }], rows = [{…}] (edited in place).
 * opts: { readOnly, height, onChange(row, key, value), onHeader(column), buttons: { add() -> row | null, remove: true, move: true }, onSelect(row, index) }
 * -> { el, rows, refresh(), selected(), select(i) }
 */
export function grid<R>(host: HTMLElement, columns: GridColumn<R>[], rows: R[], optsIn?: GridOpts<R>): GridApi<R> {
  ensureCss(); ensureIconCss(); const opts = optsIn || {};
  const wrap = el("div", "kd-grid-wrap"), table = el("table", "kd-grid"); if (opts.height) wrap.style.maxHeight = wrap.style.height = typeof opts.height === "number" ? opts.height + "px" : opts.height;
  // the grid cursor's row, plus the rows a Shift- or Ctrl-click added (wxGrid::GetSelectedRows, wxGridSelectRows)
  let sel = -1; let multi = new Set<number>();
  const api: GridApi<R> = { el: wrap, rows, columns, refresh, selected: () => sel, select, selectedRows: () => (sel >= 0 && !multi.has(sel) ? [...multi, sel] : [...multi]).filter((i) => i < rows.length).sort((a, b) => a - b), selectRows };
  const paint = (): void => { [...table.querySelectorAll("tbody tr")].forEach((tr, j) => tr.classList.toggle("sel", j === sel || multi.has(j))); };
  function select(i: number): void { sel = i; multi = new Set(); paint(); if (opts.onSelect) opts.onSelect(rows[i] || null, i); }
  function selectRows(list: number[]): void { multi = new Set(list.filter((i) => i >= 0 && i < rows.length)); sel = list.length ? list[list.length - 1] : -1; paint(); if (opts.onSelect) opts.onSelect(rows[sel] || null, sel); }
  /** a row click: Ctrl toggles the row into the selection, Shift extends it from the cursor, a plain click selects only it */
  function clickRow(i: number, ev: PointerEvent | MouseEvent): void {
    if (opts.multiSelect && (ev.ctrlKey || ev.metaKey)) { if (sel >= 0) multi.add(sel); if (multi.has(i) && multi.size > 1) multi.delete(i); else multi.add(i); sel = i; paint(); if (opts.onSelect) opts.onSelect(rows[i] || null, i); return; }
    if (opts.multiSelect && ev.shiftKey && sel >= 0) { const a = Math.min(sel, i), b = Math.max(sel, i); multi = new Set(); for (let k = a; k <= b; k++) multi.add(k); sel = i; paint(); if (opts.onSelect) opts.onSelect(rows[i] || null, i); return; }
    if (sel !== i || multi.size) select(i);
  }
  function refresh(): void {
    const cols = api.columns;
    // a column with a browse button keeps its width (the grid scrolls sideways instead of squeezing the text under it)
    table.innerHTML = `<thead${opts.noHeader ? ' style="display:none"' : ""}><tr>${cols.map((c) => `<th${c.width ? ` style="width:${c.width}px${c.button ? `;min-width:${c.width}px` : ""}"` : ""}>${esc(c.label)}${c.sort ? `<span class="ksort${c.sort === "desc" ? " desc" : ""}" data-sort-ind="${c.sort}" aria-hidden="true"></span>` : ""}</th>`).join("")}</tr></thead>`;
    const tb = el("tbody");
    rows.forEach((r, i) => {
      const tr = el("tr"); if (i === sel || multi.has(i)) tr.classList.add("sel");
      for (const c of cols) {
        const td = el("td"), ro = opts.readOnly || c.type === "ro" || (c.ro && c.ro(r)), v = (r as Record<string, unknown>)[c.key];   // a row is a plain record keyed by its columns
        if (c.render) c.render(td, r, !!ro, (value) => { (r as Record<string, unknown>)[c.key] = value; if (opts.onChange) opts.onChange(r, c.key, value, i); });
        else if (c.type === "icon") { td.className = "c kd-icon-cell"; const spec = c.icon ? c.icon(r) : null;
          if (spec) { const b = el("button", "kd-cell-ic") as HTMLButtonElement; b.type = "button"; b.title = spec.title; b.dataset.icon = spec.icon; b.dataset.col = c.key; b.appendChild(kicadIcon(spec.icon, 16)); b.tabIndex = -1;
            b.addEventListener("click", (ev) => { ev.stopPropagation(); if (spec.run) spec.run(); }); td.appendChild(b); } }
        else if (c.type === "bool") { td.className = "c"; const cb = el("input") as HTMLInputElement; cb.type = "checkbox"; cb.checked = !!v; cb.disabled = !!ro; cb.dataset.col = c.key; cb.addEventListener("change", () => { (r as Record<string, unknown>)[c.key] = cb.checked; if (opts.onChange) opts.onChange(r, c.key, cb.checked, i); }); td.appendChild(cb); }
        else if (ro) { td.className = "ro"; td.textContent = c.format ? c.format(v, r) : str(v); if (c.title) td.title = c.title(r); }
        else if (c.type === "choice") { const s = el("k-select") as HTMLSelectElement; s.dataset.col = c.key; for (const o of (typeof c.options === "function" ? c.options(r) : c.options!)) { const op = el("option") as HTMLOptionElement; op.value = isList(o) ? o[0] : o; op.textContent = isList(o) ? o[1] : o; s.appendChild(op); } s.value = str(v); s.addEventListener("change", () => { (r as Record<string, unknown>)[c.key] = s.value; if (opts.onChange) opts.onChange(r, c.key, s.value, i); }); td.appendChild(s); }
        else { const inp = el("input") as HTMLInputElement; inp.type = "text"; inp.value = c.format ? c.format(v, r) : str(v); inp.dataset.col = c.key; if (c.list) inp.setAttribute("list", c.list); inp.addEventListener("change", () => { (r as Record<string, unknown>)[c.key] = inp.value; if (opts.onChange) opts.onChange(r, c.key, inp.value, i); }); td.appendChild(inp);
          const cb = c.button ? c.button(r) : null; if (cb) cellButton(td, inp, cb); }
        tr.appendChild(td);
      }
      tr.addEventListener("pointerdown", (ev) => { if (ev.button === 2 && (i === sel || multi.has(i))) return; clickRow(i, ev); });
      tr.addEventListener("focusin", () => { if (sel !== i && !multi.has(i)) select(i); });
      if (opts.onContextMenu) tr.addEventListener("contextmenu", (ev) => { ev.preventDefault(); opts.onContextMenu!(ev, i); });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    if (opts.onHeader) [...table.querySelectorAll<HTMLElement>("th")].forEach((th, i) => { th.style.cursor = "pointer"; th.addEventListener("click", () => opts.onHeader!(cols[i], i)); });
  }
  wrap.appendChild(table); host.appendChild(wrap); refresh();
  installGridTricks(table, api, opts, () => sel, (i) => { sel = i; });
  const B = opts.buttons;
  if (B && !opts.readOnly) {
    // STD_BITMAP_BUTTONs with KiCad's small_plus / small_up / small_down / small_trash, as every WX_GRID dialog sets them
    const bar = el("div", "kd-grid-btns"); const mk = (icon: string, title: string, fn: () => void, role: string): HTMLElement => { const b = bitmapButton(icon, title, fn, { key: "grid-" + icon.replace(/^small_/, "") }); b.dataset.btn = role; bar.appendChild(b); return b; };
    if (B.add) mk("small_plus", B.addTitle || "Add", () => { const r = B.add!(); if (r) { rows.push(r); sel = rows.length - 1; multi = new Set(); refresh(); const f = table.querySelector<HTMLInputElement>("tbody tr:last-child input[type=text]"); if (f) f.focus(); if (opts.onChange) opts.onChange(r, null, null, sel); } }, "add");
    if (B.add) (B.afterAdd || []).forEach((x) => bar.appendChild(x));
    const movable = (i: number, j: number): boolean => !B.canMove || B.canMove(rows[i], rows[j]);
    if (B.move) { mk("small_up", "Move up", () => { if (sel > 0 && movable(sel, sel - 1)) { [rows[sel - 1], rows[sel]] = [rows[sel], rows[sel - 1]]; sel--; multi = new Set(); refresh(); if (opts.onChange) opts.onChange(rows[sel], null, null, sel); } }, "up");
      mk("small_down", "Move down", () => { if (sel >= 0 && sel < rows.length - 1 && movable(sel, sel + 1)) { [rows[sel + 1], rows[sel]] = [rows[sel], rows[sel + 1]]; sel++; multi = new Set(); refresh(); if (opts.onChange) opts.onChange(rows[sel], null, null, sel); } }, "down"); }
    if (B.remove) {
      if (B.gapBeforeRemove) bar.appendChild(el("span", "kd-gap"));
      // deleteRowHandler: every selected row goes (the rows a canRemove refuses stay), the cursor lands on the row after them
      mk("small_trash", B.removeTitle || "Delete", () => { removeRows(api.selectedRows()); }, "remove");
    }
    host.appendChild(bar); api.bar = bar;
  }
  function removeRows(list: number[]): void {
    const go = list.filter((i) => rows[i] && !(B && B.canRemove && !B.canRemove(rows[i]))).sort((a, b) => b - a); if (!go.length) return;
    const first = go[go.length - 1]; let gone: R | undefined;
    for (const i of go) gone = rows.splice(i, 1)[0];
    multi = new Set(); sel = Math.min(first, rows.length - 1); refresh(); if (opts.onChange && gone) opts.onChange(gone, null, null, -1);
  }
  api.removeRows = removeRows;
  return api;
}
/**
 * The browse button inside a text cell (wxComboCtrl with SetButtonBitmaps, as KiCad's GRID_CELL_FPID_EDITOR and
 * GRID_CELL_URL_EDITOR build it): shown at the cell's right edge while the cell is being edited (and under the
 * pointer), a click keeps the cell's editor and runs the button; a value the button sets is written and committed
 * at once (CommitPendingChanges).  Esc in an edited cell gives the committed text back instead of closing the dialog.
 */
function cellButton(td: HTMLElement, inp: HTMLInputElement, spec: GridCellButton): void {
  td.classList.add("kd-btn-cell");
  const b = el("button", "kd-cell-btn") as HTMLButtonElement; b.type = "button"; b.tabIndex = -1; b.dataset.cellBtn = inp.dataset.col || "";
  const ic = kicadIcon(spec.icon(inp.value), 16); b.appendChild(ic);
  const sync = (): void => { setKicadIcon(ic, spec.icon(inp.value)); b.title = spec.title(inp.value); b.dataset.icon = spec.icon(inp.value); };
  sync();
  inp.addEventListener("input", sync);
  b.addEventListener("pointerdown", (ev) => { ev.preventDefault(); if (document.activeElement !== inp) inp.focus(); });   // the cell stays in edit
  b.addEventListener("click", (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    spec.run(inp.value, (v) => { inp.value = v; inp.defaultValue = v; sync(); inp.dispatchEvent(new Event("change")); }, inp);
  });
  inp.addEventListener("focus", () => { inp.defaultValue = inp.value; });
  inp.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || inp.value === inp.defaultValue) return;
    ev.preventDefault(); ev.stopPropagation(); inp.value = inp.defaultValue; sync();   // wxGrid: Esc cancels the cell edit
  });
  td.appendChild(b);
}
/** wxStaticBoxSizer: a titled frame; returns the element to fill. */
export function staticBox(host: HTMLElement, title: string): HTMLElement { ensureCss(); const b = el("div", "kd-sb"); b.appendChild(el("span", "kd-sb-t", esc(title))); host.appendChild(b); return b; }

// ---------------------------------------------------------------- GRID_TRICKS (common/grid_tricks.cpp)
/** The block a grid trick works on: the selected rows (Select All) or the one cell. */
interface Block { r0: number; r1: number; c0: number; c1: number }
/** The text of a cell as GRID_TRICKS copies it (a checkbox is "1" or "0"). */
export function cellText(v: unknown, type?: string): string { return type === "bool" ? (v ? "1" : "0") : str(v); }
/** Clipboard text as GRID_TRICKS::paste_text reads it: rows by line, cells by tab. */
export function parseClip(text: string): string[][] { const lines = text.replace(/\r\n?/g, "\n").split("\n"); if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); return lines.map((l) => l.split("\t")); }
function installGridTricks<R>(table: HTMLElement, api: GridApi<R>, opts: GridOpts<R>, getSel: () => number, setSel: (i: number) => void): void {
  let all = false;
  const cols = (): GridColumn<R>[] => api.columns;
  const editable = (r: R, c: GridColumn<R>): boolean => !opts.readOnly && c.type !== "ro" && !(c.ro && c.ro(r));
  const block = (at: { r: number; c: number } | null): Block | null => {
    if (all && api.rows.length) return { r0: 0, r1: api.rows.length - 1, c0: 0, c1: cols().length - 1 };
    return at ? { r0: at.r, r1: at.r, c0: at.c, c1: at.c } : null;
  };
  const textOf = (b: Block): string => {
    const out: string[] = [];
    for (let r = b.r0; r <= b.r1; r++) { const row = api.rows[r] as Record<string, unknown>; const cells: string[] = []; for (let c = b.c0; c <= b.c1; c++) { const col = cols()[c]; cells.push(cellText(row[col.key], col.type)); } out.push(cells.join("\t")); }
    return out.join("\n");
  };
  const set = (r: number, c: number, v: string): boolean => {
    const row = api.rows[r], col = cols()[c]; if (!row || !col || !editable(row, col)) return false;
    const rec = row as Record<string, unknown>;
    if (col.type === "bool") rec[col.key] = v === "1" || /^true$/i.test(v);
    else if (col.type === "choice") { const o = typeof col.options === "function" ? col.options(row) : col.options || []; const vals = o.map((x) => (Array.isArray(x) ? x[0] : x)); if (!vals.includes(v)) return false; rec[col.key] = v; }
    else rec[col.key] = v;
    if (opts.onChange) opts.onChange(row, col.key, rec[col.key], r);
    return true;
  };
  const clear = (b: Block): void => { for (let r = b.r0; r <= b.r1; r++) for (let c = b.c0; c <= b.c1; c++) { const col = cols()[c]; if (col.type === "choice") continue; set(r, c, col.type === "bool" ? "0" : ""); } api.refresh(); markAll(); };
  const copy = (b: Block): void => { const t = textOf(b); if (navigator.clipboard) void navigator.clipboard.writeText(t).catch(() => undefined); };
  const paste = (at: { r: number; c: number }): void => {
    if (!navigator.clipboard || !navigator.clipboard.readText) return;
    void navigator.clipboard.readText().then((t) => {
      const data = parseClip(t), b = block(at); if (!b) return;
      const r0 = b.r0, c0 = b.c0;
      // a single value pasted over a block fills it; a table lands at the block's top-left cell
      if (data.length === 1 && data[0].length === 1 && (b.r1 > b.r0 || b.c1 > b.c0)) { for (let r = b.r0; r <= b.r1; r++) for (let c = b.c0; c <= b.c1; c++) set(r, c, data[0][0]); }
      else data.forEach((cells, dr) => cells.forEach((v, dc) => { if (r0 + dr < api.rows.length && c0 + dc < cols().length) set(r0 + dr, c0 + dc, v); }));
      api.refresh(); markAll();
    }).catch(() => undefined);
  };
  const markAll = (): void => { if (all) for (const tr of Array.from(table.querySelectorAll("tbody tr"))) tr.classList.add("sel"); };
  const selectAll = (): void => { all = true; markAll(); };
  const cellAt = (t: EventTarget | null): { r: number; c: number } | null => {
    const td = (t as Element | null)?.closest ? (t as Element).closest("td") : null; if (!td || !table.contains(td)) return null;
    const tr = td.parentElement as HTMLTableRowElement; const r = Array.from(tr.parentElement!.children).indexOf(tr), c = Array.from(tr.children).indexOf(td);
    return r >= 0 && c >= 0 ? { r, c } : null;
  };
  table.addEventListener("pointerdown", (ev) => { if ((ev as PointerEvent).button === 0 && all) { all = false; const s = getSel(); for (const [j, tr] of Array.from(table.querySelectorAll("tbody tr")).entries()) tr.classList.toggle("sel", j === s); } });
  table.addEventListener("contextmenu", (ev) => {
    // a grid with a menu of its own (LIB_TABLE_GRID_TRICKS, the fields grids…) shows that one instead
    if (opts.onContextMenu || ev.defaultPrevented) return;
    const at = cellAt(ev.target); if (!at) return;
    ev.preventDefault();
    if (!all && getSel() !== at.r) { setSel(at.r); api.select(at.r); }
    const b = block(at)!, row = api.rows[at.r], col = cols()[at.c];
    const canEdit = !opts.readOnly && !!row && !!col && (all || editable(row, col));
    const own = opts.cellMenu && row && col ? opts.cellMenu(row, col) : [];
    popupMenu((ev as MouseEvent).clientX, (ev as MouseEvent).clientY, [...own, ...(own.length ? [{ sep: true }] : []),
      { label: "Cut", key: "Ctrl+X", disabled: !canEdit, run: () => { copy(b); clear(b); } },
      { label: "Copy", key: "Ctrl+C", run: () => copy(b) },
      { label: "Paste", key: "Ctrl+V", disabled: !canEdit || !(navigator.clipboard && navigator.clipboard.readText), run: () => paste(at) },
      { label: "Delete", key: "Del", disabled: !canEdit, run: () => clear(b) },
      { sep: true },
      { label: "Select All", key: "Ctrl+A", run: selectAll },
    ]);
  });
  table.addEventListener("keydown", (ev) => {
    const t = ev.target as HTMLElement, inText = t.tagName === "INPUT" && (t as HTMLInputElement).type === "text";
    const mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase();
    if (inText && !all) return;   // the cell editor keeps its own clipboard keys
    const at = cellAt(t) || (getSel() >= 0 ? { r: getSel(), c: 0 } : null); if (!at) return;
    const b = block(at)!;
    if (mod && k === "a") { ev.preventDefault(); selectAll(); }
    else if (mod && k === "c") { ev.preventDefault(); copy(b); }
    else if (mod && k === "x" && !opts.readOnly) { ev.preventDefault(); copy(b); clear(b); }
    else if (mod && k === "v" && !opts.readOnly) { ev.preventDefault(); paste(at); }
    else if ((ev.key === "Delete" || ev.key === "Backspace") && all && !opts.readOnly) { ev.preventDefault(); clear(b); }
  });
}
