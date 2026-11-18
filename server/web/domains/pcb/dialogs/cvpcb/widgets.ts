// dialogs/cvpcb/widgets.ts — the pieces the CvPcb frames are built from: a non-modal top-level window (KIWAY_PLAYER:
// a title bar that drags it, a resize grip, its geometry kept per user), a virtual list (wxListCtrl with
// wxLC_VIRTUAL: only the rows in view exist, so every footprint of every library can be listed), the per-user
// settings (CVPCB_SETTINGS) and a themed three-button question (HandleUnsavedChanges).
import { h } from "../dom";
import { trapTab } from "../../tools/kicad-dialogs/shell";
import { actionByName } from "../../menuspec";
import { closeMark } from "../../../../shared/components/kicon-dom";

/** A footprint library of the frame's list: an official one or one of the project (fp-lib-table row or *.pretty folder). */
export interface CvLib { name: string; pinned: boolean; source: "official" | "project"; descr: string; uri: string; docs?: { docId: string; path: string }[] }
/** The metadata of a CvPcb action, then a common or board one ("save", "undo", "showPadNumbers"). */
export function cvMeta(id: string): { label: string; tip: string; icon: string | null; key: string } {
  const m = actionByName("CVPCB_ACTIONS::" + id) || actionByName("ACTIONS::" + id) || actionByName("PCB_ACTIONS::" + id);
  return { label: m ? m.label : id, tip: m ? m.tip || m.label : id, icon: m ? m.icon : null, key: m && m.key ? m.key : "" };
}

// ---------------------------------------------------------------- settings (common/settings/cvpcb_settings.cpp)
export interface CvpcbSettings {
  filter_footprint: number; filter_footprint_text: string; libraries_pane_width: number; footprints_pane_width: number;
  footprint_viewer: { autozoom: boolean; zoom: number; show_pad_fill: boolean; show_pad_number: boolean; show_text_fill: boolean; show_graphic_fill: boolean; grid_idx: number; show_grid: boolean; crosshair: "small" | "full" | "45"; polar: boolean };
}
const KEY = "kui.cvpcb";
export const DEFAULT_SETTINGS: CvpcbSettings = {
  filter_footprint: 0, filter_footprint_text: "", libraries_pane_width: 0, footprints_pane_width: 0,
  footprint_viewer: { autozoom: true, zoom: 1, show_pad_fill: true, show_pad_number: true, show_text_fill: true, show_graphic_fill: true, grid_idx: 15, show_grid: true, crosshair: "small", polar: false },
};
export function loadSettings(): CvpcbSettings {
  const d = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CvpcbSettings;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null") as Partial<CvpcbSettings> | null;
    if (raw && typeof raw === "object") {
      if (typeof raw.filter_footprint === "number") d.filter_footprint = raw.filter_footprint & 7;
      if (typeof raw.filter_footprint_text === "string") d.filter_footprint_text = raw.filter_footprint_text;
      if (typeof raw.libraries_pane_width === "number") d.libraries_pane_width = raw.libraries_pane_width;
      if (typeof raw.footprints_pane_width === "number") d.footprints_pane_width = raw.footprints_pane_width;
      if (raw.footprint_viewer && typeof raw.footprint_viewer === "object") Object.assign(d.footprint_viewer, raw.footprint_viewer);
    }
  } catch (e) { /* defaults */ }
  return d;
}
export function saveSettings(s: CvpcbSettings): void { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* no storage */ } }

// ---------------------------------------------------------------- a top-level window
export interface CvWindow { root: HTMLElement; body: HTMLElement; setTitle(t: string): void; close(): void; front(): void }
const open = new Set<HTMLElement>();
/**
 * Bring one of the CvPcb windows, or the 3D viewer opened from the footprint viewer (.v3d-win, a bundle of its own),
 * to the front: the one raised gets cv-top, every other loses it.
 */
export function raiseWindow(el: HTMLElement): void {
  for (const f of [...open, ...Array.from(document.querySelectorAll<HTMLElement>(".v3d-win"))]) f.classList.toggle("cv-top", f === el);
}
let v3dHooked = false;
/** A click into the 3D viewer raises it above the CvPcb windows, as a click into one of them raises that one. */
function hook3D(): void {
  if (v3dHooked) return; v3dHooked = true;
  document.addEventListener("pointerdown", (ev) => { const w = ev.target instanceof Element ? ev.target.closest<HTMLElement>(".v3d-win") : null; if (w) raiseWindow(w); }, true);
}
export function cvWindow(o: { id: string; title: string; geomKey: string; width: number; height: number; cls?: string; onCloseBox(): void; offset?: number }): CvWindow {
  const x = h("span", { class: "cv-x", title: "Close" }, closeMark());
  const titleText = h("span", null, o.title);
  const title = h("div", { class: "cv-title" }, titleText, x);
  const body = h("div", { style: "flex:1;display:flex;flex-direction:column;min-height:0" });
  const root = h("div", { class: "cv-frame" + (o.cls ? " " + o.cls : ""), id: o.id, role: "dialog", "aria-label": o.title, tabindex: "-1" }, title, body);
  const grip = h("div", { class: "cv-grip", title: "Resize" }); root.append(grip);
  const vw = window.innerWidth, vh = window.innerHeight;
  let g: { x: number; y: number; w: number; h: number } | null = null;
  try { g = JSON.parse(localStorage.getItem("kui.geom." + o.geomKey) || "null"); } catch (e) { g = null; }
  const w = Math.min(vw - 8, g && g.w > 0 ? g.w : o.width), hh = Math.min(vh - 8, g && g.h > 0 ? g.h : o.height);
  const left = g ? Math.max(0, Math.min(vw - 80, g.x)) : Math.max(0, Math.round((vw - w) / 2) + (o.offset || 0));
  const top = g ? Math.max(0, Math.min(vh - 40, g.y)) : Math.max(0, Math.round((vh - hh) / 2) + (o.offset || 0));
  Object.assign(root.style, { left: left + "px", top: top + "px", width: w + "px", height: hh + "px" });
  const save = () => { const r = root.getBoundingClientRect(); try { localStorage.setItem("kui.geom." + o.geomKey, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })); } catch (e) { /* no storage */ } };
  let drag: [number, number] | null = null;
  title.addEventListener("pointerdown", (ev) => { if (ev.target === x || ev.button !== 0) return; const r = root.getBoundingClientRect(); drag = [ev.clientX - r.left, ev.clientY - r.top]; title.setPointerCapture(ev.pointerId); });
  title.addEventListener("pointermove", (ev) => { if (!drag) return; root.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - drag[0])) + "px"; root.style.top = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - drag[1])) + "px"; });
  title.addEventListener("pointerup", () => { if (drag) save(); drag = null; });
  let size: [number, number, number, number] | null = null;
  grip.addEventListener("pointerdown", (ev) => { ev.preventDefault(); const r = root.getBoundingClientRect(); size = [ev.clientX, ev.clientY, r.width, r.height]; grip.setPointerCapture(ev.pointerId); });
  grip.addEventListener("pointermove", (ev) => { if (!size) return; const r = root.getBoundingClientRect(); root.style.width = Math.max(520, Math.min(window.innerWidth - r.left, size[2] + ev.clientX - size[0])) + "px"; root.style.height = Math.max(300, Math.min(window.innerHeight - r.top, size[3] + ev.clientY - size[1])) + "px"; root.dispatchEvent(new Event("cv-resize")); });
  grip.addEventListener("pointerup", () => { if (size) save(); size = null; });
  x.addEventListener("click", () => o.onCloseBox());
  const front = () => raiseWindow(root);
  hook3D();
  root.addEventListener("pointerdown", front, true);
  document.body.append(root); open.add(root); front();
  return { root, body, setTitle(t) { titleText.textContent = t; root.setAttribute("aria-label", t); }, close() { open.delete(root); root.remove(); }, front };
}

// ---------------------------------------------------------------- a virtual list
export const ROW_H = 18;
export interface VListOpts {
  id: string; count(): number; text(i: number): string; cls(i: number): string; title?(i: number): string | undefined;
  down(i: number, ev: MouseEvent): void; dbl?(i: number): void; ctx?(i: number, ev: MouseEvent): void; empty?(): string;
}
export interface VList { el: HTMLElement; refresh(): void; scrollTo(i: number): void; page(): number }
export function vlist(o: VListOpts): VList {
  const sizer = h("div", { class: "cv-sizer" });
  const el = h("div", { class: "cv-list", id: o.id, tabindex: "0", role: "listbox" }, sizer);
  let rows: HTMLElement[] = [];
  const emptyEl = h("div", { class: "cv-empty" });
  const draw = () => {
    const n = o.count(); sizer.style.height = n * ROW_H + "px";
    const first = Math.max(0, Math.floor(el.scrollTop / ROW_H) - 2), last = Math.min(n, Math.ceil((el.scrollTop + el.clientHeight) / ROW_H) + 2);
    const want = Math.max(0, last - first);
    while (rows.length > want) rows.pop()!.remove();
    while (rows.length < want) { const r = h("div", { class: "cv-row", role: "option" }); el.append(r); rows.push(r); }
    for (let k = 0; k < want; k++) {
      const i = first + k, r = rows[k]!;
      r.style.top = i * ROW_H + "px"; r.dataset.i = String(i);
      const t = o.text(i); if (r.textContent !== t) r.textContent = t;
      r.className = "cv-row " + o.cls(i);
      const tt = o.title ? o.title(i) : undefined; if (tt) r.title = tt; else r.removeAttribute("title");
    }
    const msg = !n && o.empty ? o.empty() : "";
    if (msg) { emptyEl.textContent = msg; if (!emptyEl.parentNode) el.append(emptyEl); } else emptyEl.remove();
  };
  const rowAt = (ev: MouseEvent): number => { const r = el.getBoundingClientRect(); const i = Math.floor((ev.clientY - r.top + el.scrollTop) / ROW_H); return i >= 0 && i < o.count() ? i : -1; };
  el.addEventListener("scroll", draw);
  el.addEventListener("mousedown", (ev) => { if (ev.button !== 0) return; const i = rowAt(ev); if (i >= 0) o.down(i, ev); });
  el.addEventListener("dblclick", (ev) => { const i = rowAt(ev); if (i >= 0 && o.dbl) o.dbl(i); });
  el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); if (!o.ctx) return; const i = rowAt(ev); o.ctx(i, ev); });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => draw()).observe(el);
  return {
    el, refresh: draw,
    scrollTo(i: number) { if (i < 0) return; const top = i * ROW_H; if (top < el.scrollTop) el.scrollTop = top; else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight; draw(); },
    page() { return Math.max(1, Math.floor(el.clientHeight / ROW_H) - 1); },
  };
}

// ---------------------------------------------------------------- questions
/** A themed message box with the buttons given; resolves the index of the one pressed (Esc = `cancel`). */
export function askBox(title: string, message: string, buttons: string[], primary: number, cancel: number): Promise<number> {
  return new Promise((resolve) => {
    const done = (i: number) => { ov.remove(); resolve(i); };
    const btns = buttons.map((b, i) => h("button", { class: "btn" + (i === primary ? " primary" : ""), "data-btn": String(i), onclick: () => done(i) }, b));
    const dlg = h("div", { class: "kd-dialog", style: "width:440px;min-width:0" }, h("div", { class: "kd-title" }, h("span", null, title)),
      h("div", { class: "kd-body" }, h("p", { style: "margin:4px 0;white-space:pre-wrap", id: "cv-ask-text" }, message)), h("div", { class: "kd-foot" }, h("span", { class: "spacer" }), ...btns));
    const ov = h("div", { class: "kd-overlay kd-prompt cv-ask", style: "z-index:80" }, dlg);
    ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Tab") trapTab(ev, ov); if (ev.key === "Escape") { ev.preventDefault(); done(cancel); } else if (ev.key === "Enter" && !(ev.target instanceof HTMLButtonElement)) { ev.preventDefault(); done(primary); } });
    document.body.append(ov); btns[primary]!.focus();
  });
}
/** wxMessageBox / DisplayErrorMessage. */
export function messageBox(title: string, message: string): Promise<void> { return askBox(title, message, ["OK"], 0, 0).then(() => undefined); }
