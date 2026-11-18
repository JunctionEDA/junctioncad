// components/kicon-dom.ts — KiCad's icon pack in the parts of the editor built without React: the icon itself (the web
// icon pack derived from resources/bitmaps_png, published by ui.js as window.KiCadIconFor; light and dark variants
// follow the theme, and an icon asked for before the pack is in fills in when it arrives), wxWidgets' BITMAP_BUTTON /
// STD_BITMAP_BUTTON (small_plus, small_up, small_down, small_trash, small_edit, small_refresh, small_folder,
// small_library, config…), the toggle kind the text formatting bars use (text_bold, text_italic, text_align_*…) and
// their separators.  Every plain-DOM dialog draws its bitmaps through here, never from text glyphs.
import type { IconSpec } from "../../domains/pcb/spec";
import { uniqueIconIds } from "./icon-ids";

interface IconGlobals { KiCadIconFor?: (name: string) => IconSpec | undefined; KiCadIconsReady?: Promise<void> }
const G = (): IconGlobals => (typeof window === "undefined" ? {} : window as unknown as IconGlobals);
const NS = "http://www.w3.org/2000/svg";
const CSS = `
.kic{flex:none;vertical-align:middle}
.kic .dk{display:none}
:root[data-theme="dark"] .kic .lt{display:none} :root[data-theme="dark"] .kic .dk{display:inline}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .kic .lt{display:none} :root:not([data-theme="light"]) .kic .dk{display:inline}}
:root[data-theme="dark"]{--kic-lt:none;--kic-dk:inline}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--kic-lt:none;--kic-dk:inline}}
.kbmp{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:24px;padding:0;border:1px solid var(--line);border-radius:var(--r-2,3px);background:var(--panel);color:var(--ink);cursor:pointer}
.kbmp>.kic{display:block}
.kbmp:hover:not(:disabled){border-color:var(--line-2);background:var(--paper)}
.kbmp:disabled{opacity:.4;cursor:default}
.kbmp.flat{border-color:transparent;background:transparent}
.kbmp.flat:hover:not(:disabled){border-color:var(--line)}
.kbmp.on,.kbmp[aria-pressed="true"]{background:var(--on,var(--sel-soft));border-color:var(--on-line,var(--sel))}
.kbmp-sep{flex:none;width:1px;height:18px;margin:0 4px;background:var(--line);align-self:center}
.kbmp-bar{display:flex;align-items:center;gap:2px;flex-wrap:wrap}
.ktw{display:inline-block;flex:none;width:12px;height:12px;position:relative;vertical-align:middle;cursor:pointer}
.ktw::before{content:"";position:absolute;left:2px;top:4px;border-style:solid;border-width:5px 4px 0 4px;border-color:var(--ink-3) transparent transparent transparent}
.ktw.shut::before{left:4px;top:2px;border-width:4px 0 4px 5px;border-color:transparent transparent transparent var(--ink-3)}
.ktw.leaf::before{display:none}
.kmarrow{display:inline-block;flex:none;width:8px;height:10px;position:relative;vertical-align:middle}
.kmarrow::before{content:"";position:absolute;left:2px;top:1px;border-style:solid;border-width:4px 0 4px 4px;border-color:transparent transparent transparent currentColor;opacity:.75}
.kmchk{display:inline-block;flex:none;width:16px;height:16px;position:relative;vertical-align:middle}
.kmchk.on::before{content:"";position:absolute;left:6px;top:2px;width:4px;height:9px;border:solid currentColor;border-width:0 2px 2px 0;transform:rotate(45deg)}
.kmchk.radio.on::before{left:5px;top:5px;width:6px;height:6px;border:0;border-radius:50%;background:currentColor;transform:none}
.ksort{display:inline-block;flex:none;width:8px;height:8px;position:relative;margin-left:4px;vertical-align:middle}
.ksort::before{content:"";position:absolute;left:0;top:1px;border-style:solid;border-width:0 4px 5px 4px;border-color:transparent transparent var(--ink-3) transparent}
.ksort.desc::before{border-width:5px 4px 0 4px;border-color:var(--ink-3) transparent transparent transparent}
.kcarrow{display:inline-block;flex:none;width:10px;height:10px;position:relative;vertical-align:middle}
.kcarrow::before{content:"";position:absolute;left:2px;top:1px;width:5px;height:5px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.kcarrow.l::before{left:3px;top:2px;transform:rotate(135deg)} .kcarrow.r::before{left:1px;top:2px;transform:rotate(-45deg)} .kcarrow.u::before{top:3px;transform:rotate(-135deg)}
.kind-on{display:inline-block;flex:none;width:10px;height:10px;position:relative;vertical-align:middle}
.kind-on::before{content:"";position:absolute;left:2px;top:1px;border-style:solid;border-width:4px 0 4px 6px;border-color:transparent transparent transparent rgb(64,72,255)}
.kgrid-chk{pointer-events:none;margin:0}
`;
let styled = false;
export function ensureIconCss(): void {
  if (styled || typeof document === "undefined") return; styled = true;
  const st = document.createElement("style"); st.id = "kicon-css"; st.textContent = CSS; document.head.appendChild(st);
}
function fill(el: SVGSVGElement, ic: IconSpec): void {
  el.setAttribute("viewBox", ic.vb || "0 0 24 24");
  el.innerHTML = uniqueIconIds(`<g class="lt">${ic.light || ic.dark || ""}</g><g class="dk">${ic.dark || ic.light || ""}</g>`);
  el.dataset.icon = el.dataset.want || "";
}

/** KiCad's icon `name` as an inline SVG, `size` px square (or `size` x `height` for a picture that is not square). */
export function kicadIcon(name: string, size = 16, height = size): SVGSVGElement {
  ensureIconCss();
  const el = document.createElementNS(NS, "svg") as SVGSVGElement;
  el.setAttribute("class", "kic kicon-dom"); el.setAttribute("aria-hidden", "true"); el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size)); el.setAttribute("height", String(height));
  setKicadIcon(el, name);
  return el;
}

/** Point an icon made by kicadIcon at another of KiCad's icons (TEXT_BUTTON_URL::UpdateButtonBitmaps). */
export function setKicadIcon(el: SVGSVGElement, name: string): void {
  if (el.dataset.want === name && el.dataset.icon === name) return;
  el.dataset.want = name; el.dataset.icon = name;
  const g = G(), ic = g.KiCadIconFor ? g.KiCadIconFor(name) : undefined;
  if (ic) { fill(el, ic); return; }
  if (g.KiCadIconsReady) void g.KiCadIconsReady.then(() => { if (el.dataset.want !== name) return; const i = G().KiCadIconFor?.(name); if (i) fill(el, i); }).catch(() => undefined);
}

export interface BmpOpts { id?: string; key?: string; flat?: boolean; disabled?: boolean; size?: number; cls?: string }
/** STD_BITMAP_BUTTON / BITMAP_BUTTON: a small themed button (.kbmp) showing one of KiCad's bitmaps; `title` is its tooltip (and accessible name). */
export function bitmapButton(icon: string, title: string, onClick: ((ev: MouseEvent) => void) | null, opts?: BmpOpts): HTMLButtonElement {
  ensureIconCss();
  const b = document.createElement("button");
  b.type = "button"; b.className = "kbmp" + (opts?.flat ? " flat" : "") + (opts?.cls ? " " + opts.cls : "");
  b.title = title; b.setAttribute("aria-label", title.split("\n")[0]); b.dataset.icon = icon;
  if (opts?.id) b.id = opts.id; if (opts?.key) b.dataset.k = opts.key; if (opts?.disabled) b.disabled = true;
  b.appendChild(kicadIcon(icon, opts?.size || 16));
  if (onClick) b.addEventListener("click", (ev) => onClick(ev));
  return b;
}

/** BITMAP_BUTTON with IsToggle / SetIsCheckButton: pressed state in aria-pressed; `onToggle` gets the new state. */
export function bitmapToggle(icon: string, title: string, on: boolean, onToggle?: (on: boolean) => void, opts?: BmpOpts): HTMLButtonElement & { setOn(v: boolean): void; isOn(): boolean } {
  const b = bitmapButton(icon, title, null, Object.assign({ flat: true }, opts)) as HTMLButtonElement & { setOn(v: boolean): void; isOn(): boolean };
  b.setOn = (v: boolean) => { b.setAttribute("aria-pressed", String(!!v)); b.classList.toggle("on", !!v); };
  b.isOn = () => b.getAttribute("aria-pressed") === "true";
  b.setOn(on);
  b.addEventListener("click", () => { if (b.disabled) return; b.setOn(!b.isOn()); if (onToggle) onToggle(b.isOn()); });
  return b;
}

/**
 * A group of BITMAP_BUTTONs that act as radio items (text alignment, label orientation): one is pressed.
 * `items` = [value, icon, tooltip]; returns the buttons in a bar with value() / set(v).
 */
export function bitmapRadio(items: [string, string, string][], value: string, onChange?: (v: string) => void, opts?: { key?: string }): { el: HTMLElement; buttons: HTMLButtonElement[]; value(): string; set(v: string): void } {
  ensureIconCss();
  let cur = value;
  const bar = document.createElement("span"); bar.className = "kbmp-bar"; if (opts?.key) bar.dataset.k = opts.key;
  const buttons = items.map(([v, icon, tip]) => {
    const b = bitmapButton(icon, tip, () => { set(v); if (onChange) onChange(v); }, { flat: true }); b.dataset.v = v; bar.appendChild(b); return b;
  });
  function set(v: string): void { cur = v; for (const b of buttons) { const on = b.dataset.v === v; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); } }
  set(cur);
  return { el: bar, buttons, value: () => cur, set };
}

/** The separator BITMAP_BUTTON KiCad puts between groups of a formatting bar (SetIsSeparator). */
export function bitmapSeparator(): HTMLSpanElement { ensureIconCss(); const s = document.createElement("span"); s.className = "kbmp-sep"; s.setAttribute("aria-hidden", "true"); return s; }

/**
 * A wxTreeCtrl / wxDataViewCtrl expander as the GTK theme draws it: a small filled triangle, pointing right when the
 * node is collapsed and down when it is open; a leaf keeps the space (`kids` false).  setExpander() flips it.
 */
export function treeExpander(open: boolean, kids = true): HTMLSpanElement {
  ensureIconCss();
  const s = document.createElement("span"); s.setAttribute("aria-hidden", "true"); s.dataset.twist = "";
  setExpander(s, open, kids);
  return s;
}
export function setExpander(s: HTMLElement, open: boolean, kids = true): void {
  s.className = "ktw" + (kids ? (open ? "" : " shut") : " leaf");
  if (kids) s.dataset.open = String(open); else delete s.dataset.open;
}
/** The sub-menu marker of a menu entry (GTK's menu arrow, drawn). */
export function menuArrow(): HTMLSpanElement { ensureIconCss(); const s = document.createElement("span"); s.className = "kmarrow"; s.setAttribute("aria-hidden", "true"); return s; }
/** A checkable (or radio) menu entry's indicator, drawn as the platform draws wxITEM_CHECK / wxITEM_RADIO. */
export function menuCheck(on: boolean, radio = false): HTMLSpanElement {
  ensureIconCss(); const s = document.createElement("span"); s.className = "kmchk" + (radio ? " radio" : "") + (on ? " on" : ""); s.dataset.check = on ? "on" : "off"; s.setAttribute("aria-hidden", "true"); return s;
}
/** The sort arrow wxGrid / wxDataViewCtrl draw in a sorted column's header (wxRendererNative::DrawHeaderButton). */
export function sortArrow(asc: boolean): HTMLSpanElement { ensureIconCss(); const s = document.createElement("span"); s.className = "ksort" + (asc ? "" : " desc"); s.dataset.sortInd = asc ? "asc" : "desc"; s.setAttribute("aria-hidden", "true"); return s; }
/** The drop-down arrow of a wxComboBox / wxChoice button. */
export function comboArrow(): HTMLSpanElement { ensureIconCss(); const s = document.createElement("span"); s.className = "kcarrow"; s.setAttribute("aria-hidden", "true"); return s; }
/** wxGridCellBoolRenderer: a read-only cell's check box. */
export function gridCheck(on: boolean): HTMLInputElement {
  ensureIconCss(); const c = document.createElement("input"); c.type = "checkbox"; c.checked = on; c.tabIndex = -1; c.className = "kgrid-chk"; c.setAttribute("aria-readonly", "true"); return c;
}
/** INDICATOR_ICON's ROW_ICON_PROVIDER right arrow (the active layer of the Appearance pane), drawn in its blue. */
export function indicatorArrow(): HTMLSpanElement { ensureIconCss(); const s = document.createElement("span"); s.className = "kind-on"; s.setAttribute("aria-hidden", "true"); return s; }
/** The close box of a frame's title bar, a wxAuiNotebook tab or a WX_INFOBAR, drawn (a cross in the text colour). */
export const CLOSE_MARK_SVG = '<svg class="kclose" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>';
export function closeMark(): SVGSVGElement {
  const t = document.createElement("template"); t.innerHTML = CLOSE_MARK_SVG; return t.content.firstChild as SVGSVGElement;
}
/** A frame title bar's maximize / restore box, drawn. */
export const MAXIMIZE_MARK_SVG = '<svg class="kmax" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>';
export function maximizeMark(): SVGSVGElement {
  const t = document.createElement("template"); t.innerHTML = MAXIMIZE_MARK_SVG; return t.content.firstChild as SVGSVGElement;
}
