// symview/frame.ts — SYMBOL_VIEWER_FRAME (eeschema/symbol_viewer_frame.cpp, toolbars_symbol_viewer.cpp): View >
// Symbol Library Browser.  The menu bar (File: Close; View: zoom, Show Pin Electrical Types / Show Pin Numbers), the
// toolbar (Display previous / next symbol, Refresh / Zoom In / Zoom Out / Zoom to Fit, the two pin toggles, the body
// style and unit choices, Show Datasheet and Add Symbol to Schematic), the Libraries and Symbols panes with their
// filters, the canvas and the message panel (Name, Parent, Description, Keywords).  The libraries are the chooser's
// (library/sources.ts): the project's own, then the official ones.  The symbol is drawn as the Symbol Editor draws one
// (KiCadCanvas.parseLibSymbol) without its hidden pins and fields.
import { h } from "../dialogs/dom";
import { E, isSch, toast } from "../dialogs/editor";
import { messageBox } from "../dialogs/sch-items";
import { ensureStyle, icon, meta, showMenu, closeMenus, type MenuEntry } from "../symedit/ui";
import { menuKey } from "../../../shared/keys";
import { projectDocs } from "../dialogs/project";
import { fetchItem, libraryIndex, officialLibraries, projectLibraries, type LibItem, type LibraryEntry, type SourceContext } from "../library/sources";
import { bodyStyleNames, symbolInfo, unitName } from "../library/core";
import "../../../shared/components/kselect";
import { stepSymbol, symbolSearchText, tokensMatch } from "./logic";

const K = (): KiCadCanvasApi => window.KiCadCanvas;
const KEEP = "kc-symview";
interface Kept { lib?: string; sym?: string; libW?: number; symW?: number; etypes?: boolean; pinNums?: boolean }
const kept = (): Kept => { try { return JSON.parse(localStorage.getItem(KEEP) || "{}") as Kept; } catch { return {}; } };
const keep = (k: Partial<Kept>): void => { try { localStorage.setItem(KEEP, JSON.stringify(Object.assign(kept(), k))); } catch { /* no storage */ } };

const S = {
  root: null as HTMLElement | null, libs: [] as LibraryEntry[], lib: "", items: [] as LibItem[], sym: "", libFilter: "", symFilter: "",
  node: null as SNode | null, unit: 1, body: 1, units: 1, bodies: 1, etypes: true, pinNums: true, view: { s: 12, px: 0, py: 0 }, raf: 0,
  onAdd: null as null | ((libId: string, symbol: string, unit: number) => void), loadSeq: 0, docCache: null as { key: string; doc: KDoc } | null,
};
let els: { menubar: HTMLElement; toolbar: HTMLElement; libList: HTMLElement; symList: HTMLElement; libFilter: HTMLInputElement; symFilter: HTMLInputElement; canvas: HTMLCanvasElement; msg: HTMLElement; empty: HTMLElement; libPane: HTMLElement; symPane: HTMLElement };

const CSS = `
#symview[hidden]{display:none !important}
#symview .sv-body{flex:1;display:flex;min-height:0}
#symview .sv-pane{flex:none;display:flex;flex-direction:column;min-height:0;background:var(--panel);border-right:1px solid var(--line)}
#symview .sv-cap{flex:none;padding:3px 8px;background:var(--bench);border-bottom:1px solid var(--line);font-weight:600}
#symview .sv-filter{margin:6px;height:24px;padding:2px 6px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:var(--r-1,3px);font:inherit}
#symview .sv-list{flex:1;overflow:auto;outline:none}
#symview .sv-row{padding:1px 8px;white-space:nowrap;cursor:default;user-select:none}
#symview .sv-row:hover{background:var(--sel-soft)}
#symview .sv-row.cur{background:var(--sel);color:var(--ink)}
#symview .sv-split{flex:none;width:5px;margin-left:-5px;cursor:col-resize;position:relative;z-index:1}
#symview .sv-centre{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
#symview .sv-hint{padding:6px 10px;color:var(--ink-3)}
`;
let styled = false;
function ensureCss(): void { ensureStyle(); if (styled) return; styled = true; document.head.append(h("style", { id: "symview-css" }, CSS)); }
const ctxOf = (): SourceContext => ({ docs: projectDocs() as unknown as SourceContext["docs"], doc: (E.kdoc as KDoc | null) || null });

// ---------------------------------------------------------------- open / close
export function isSymbolViewerOpen(): boolean { return !!S.root; }
/** SCH_EDIT_FRAME / SYMBOL_EDIT_FRAME showSymbolBrowser: the frame; `onAdd` takes Add Symbol to Schematic. */
export async function openSymbolViewer(opts?: { onAdd?: (libId: string, symbol: string, unit: number) => void }): Promise<void> {
  S.onAdd = opts && opts.onAdd ? opts.onAdd : null;
  if (S.root) { S.root.hidden = false; renderToolbar(); return; }
  ensureCss();
  const k = kept(); S.etypes = k.etypes !== false; S.pinNums = k.pinNums !== false;
  const root = h("div", { class: "se-root", id: "symview", role: "dialog", "aria-label": "Symbol Library Browser" }); S.root = root;
  document.body.append(root);
  layout(k);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", paint);
  renderToolbar(); paint();
  await loadLibraries(k.lib || "", k.sym || "");
}
export function closeSymbolViewer(): void {
  if (!S.root) return;
  keep({ lib: S.lib, sym: S.sym, libW: els.libPane.offsetWidth, symW: els.symPane.offsetWidth });
  S.root.remove(); S.root = null; S.node = null; S.docCache = null;
  window.removeEventListener("keydown", onKey, true); window.removeEventListener("resize", paint);
  closeMenus();
}

function layout(k: Kept): void {
  const root = S.root!;
  const menubar = h("div", { class: "se-menubar" }), toolbar = h("div", { class: "se-tb" });
  const libFilter = h("input", { class: "sv-filter", type: "search", placeholder: "Filter", id: "sv-lib-filter" }) as HTMLInputElement;
  const symFilter = h("input", { class: "sv-filter", type: "search", placeholder: "Filter", id: "sv-sym-filter",
    title: "Filter on symbol name, keywords and description.\nSearch terms are separated by spaces.  All search terms must match." }) as HTMLInputElement;
  const libList = h("div", { class: "sv-list", id: "sv-libs", tabindex: "0", role: "listbox" }), symList = h("div", { class: "sv-list", id: "sv-syms", tabindex: "0", role: "listbox" });
  const libPane = h("div", { class: "sv-pane", style: `width:${k.libW || 200}px` }, h("div", { class: "sv-cap" }, "Libraries"), libFilter, libList);
  const symPane = h("div", { class: "sv-pane", style: `width:${k.symW || 300}px` }, h("div", { class: "sv-cap" }, "Symbols"), symFilter, symList);
  const canvas = h("canvas", { id: "sv-canvas", tabindex: "0" }) as HTMLCanvasElement;
  const empty = h("div", { class: "se-empty" }, "");
  const msg = h("div", { class: "se-msg", id: "sv-msg" });
  const s1 = h("div", { class: "sv-split" }), s2 = h("div", { class: "sv-split" });
  root.append(menubar, toolbar, h("div", { class: "sv-body" }, libPane, s1, symPane, s2, h("div", { class: "sv-centre" }, h("div", { class: "se-canvas" }, canvas, empty), msg)));
  els = { menubar, toolbar, libList, symList, libFilter, symFilter, canvas, msg, empty, libPane, symPane };
  libFilter.addEventListener("input", () => { S.libFilter = libFilter.value; renderLibs(); });
  symFilter.addEventListener("input", () => { S.symFilter = symFilter.value; renderSyms(); });
  dragSplit(s1, libPane); dragSplit(s2, symPane);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  buildMenubar();
}
function dragSplit(el: HTMLElement, pane: HTMLElement): void {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault(); el.setPointerCapture(e.pointerId); let x = e.clientX;
    const mv = (ev: PointerEvent): void => { pane.style.width = Math.max(80, Math.min(600, pane.offsetWidth + ev.clientX - x)) + "px"; x = ev.clientX; paint(); };
    const up = (): void => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
  });
}

// ---------------------------------------------------------------- libraries and symbols
async function loadLibraries(lib: string, sym: string): Promise<void> {
  const ctx = ctxOf();
  const project = projectLibraries("symbol", ctx.docs).map((l): LibraryEntry => ({ name: l.name, description: "Project library", source: "project" }));
  S.libs = project; renderLibs();
  try { const off = await officialLibraries("symbol"); const names = new Set(project.map((l) => l.name)); S.libs = project.concat(off.libraries.filter((l) => !names.has(l.name))); }
  catch (e) { if (!project.length) els.empty.textContent = "The symbol libraries could not be loaded: " + ((e as Error).message || String(e)); }
  if (!S.root) return;
  const pick = S.libs.find((l) => l.name === lib) || S.libs[0];
  renderLibs();
  if (pick) await selectLib(pick.name, sym);
}
function visibleLibs(): LibraryEntry[] { return S.libs.filter((l) => !S.libFilter.trim() || tokensMatch(S.libFilter, l.name)); }
function visibleSyms(): LibItem[] { return S.items.filter((it) => !S.symFilter.trim() || tokensMatch(S.symFilter, symbolSearchText(it))); }
function renderLibs(): void {
  if (!S.root) return;
  els.libList.replaceChildren(...visibleLibs().map((l) => {
    const r = h("div", { class: "sv-row" + (l.name === S.lib ? " cur" : ""), role: "option", "data-lib": l.name, title: l.description || "" }, l.name);
    r.addEventListener("click", () => void selectLib(l.name, ""));
    return r;
  }));
  const cur = els.libList.querySelector(".cur"); if (cur) (cur as HTMLElement).scrollIntoView({ block: "nearest" });
}
function renderSyms(): void {
  if (!S.root) return;
  els.symList.replaceChildren(...visibleSyms().map((it) => {
    const r = h("div", { class: "sv-row" + (it.name === S.sym ? " cur" : ""), role: "option", "data-sym": it.name, title: it.description || "" }, it.name);
    r.addEventListener("click", () => void selectSym(it.name));
    r.addEventListener("dblclick", () => addToSchematic());
    return r;
  }));
  const cur = els.symList.querySelector(".cur"); if (cur) (cur as HTMLElement).scrollIntoView({ block: "nearest" });
}
async function selectLib(name: string, sym: string): Promise<void> {
  const entry = S.libs.find((l) => l.name === name); if (!entry) return;
  S.lib = name; S.items = []; renderLibs(); els.symList.replaceChildren(h("div", { class: "sv-hint" }, "Loading..."));
  const seq = ++S.loadSeq;
  try { S.items = (await libraryIndex("symbol", entry, ctxOf())).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); }
  catch (e) { if (seq === S.loadSeq) els.symList.replaceChildren(h("div", { class: "sv-hint" }, (e as Error).message || String(e))); return; }
  if (seq !== S.loadSeq || !S.root) return;
  const vis = visibleSyms();
  const pick = vis.find((it) => it.name === sym) || vis[0];
  renderSyms();
  if (pick) await selectSym(pick.name); else { S.sym = ""; S.node = null; S.docCache = null; renderMsg(); renderToolbar(); paint(); }
}
async function selectSym(name: string): Promise<void> {
  const it = S.items.find((x) => x.name === name); if (!it) return;
  S.sym = name; renderSyms();
  const seq = ++S.loadSeq;
  let got;
  try { got = await fetchItem("symbol", it, ctxOf()); } catch (e) { if (seq === S.loadSeq) { els.empty.textContent = (e as Error).message || String(e); S.node = null; paint(); } return; }
  if (seq !== S.loadSeq || !S.root || !got.symbol) return;
  const node = K().parse(got.symbol) as SNode;
  const info = symbolInfo(node);
  S.node = node; S.units = Math.max(1, info.units); S.bodies = bodyStyleNames(node).length; S.unit = 1; S.body = 1; S.docCache = null;
  keep({ lib: S.lib, sym: S.sym });
  renderMsg(); renderToolbar(); zoomFit();
}
const current = (): LibItem | null => S.items.find((x) => x.name === S.sym) || null;

// ---------------------------------------------------------------- the message panel (SYMBOL_VIEWER_FRAME::updatePreviewSymbol)
function renderMsg(): void {
  const it = current(); const info = S.node ? symbolInfo(S.node) : null;
  const cell = (k: string, v: string): HTMLElement => h("div", null, h("b", null, k), h("span", null, v));
  els.msg.replaceChildren(...(it && info ? [cell("Name", it.name), cell("Parent", it.extends || ""), cell("Description", info.description || it.description || ""), cell("Keywords", info.keywords || it.keywords || "")] : []));
}

// ---------------------------------------------------------------- menus and toolbar
const A = (id: string, run: () => void, enabled?: () => boolean, check?: () => boolean): MenuEntry => { const m = meta(id); return { id, label: m.label, icon: m.icon, key: m.key, tip: m.tip, run, enabled: enabled || (() => true), check }; };
const SEP: MenuEntry = { sep: true };
const hasSym = (): boolean => !!S.node;
const canAdd = (): boolean => !!S.node && (!!S.onAdd || (!!E.kdoc && isSch() && !E.viewOnly));
function menus(): [string, MenuEntry[]][] {
  return [
    ["File", [{ label: "Close", icon: "exit", tip: "Close Symbol Viewer", key: "Ctrl+W", run: closeSymbolViewer, enabled: () => true }]],
    ["View", [A("zoomInCenter", () => zoomBy(1.3)), A("zoomOutCenter", () => zoomBy(1 / 1.3)), A("zoomFitScreen", zoomFit), A("zoomRedraw", () => { S.docCache = null; paint(); }), SEP, SEP,
      A("showElectricalTypes", toggleTypes, undefined, () => S.etypes), A("showPinNumbers", togglePinNums, undefined, () => S.pinNums)]],
  ];
}
function buildMenubar(): void {
  els.menubar.innerHTML = "";
  for (const [name, items] of menus()) {
    const b = h("div", { class: "se-mb", "data-menu": name }, name);
    b.addEventListener("click", (ev) => { ev.stopPropagation(); const r = b.getBoundingClientRect(); showMenu(r.left, r.bottom, menus().find((m) => m[0] === name)![1], 0, { row: r, parent: r, overlap: 0 } as never); b.classList.add("open"); });
    els.menubar.append(b);
  }
}
function toggleTypes(): void { S.etypes = !S.etypes; keep({ etypes: S.etypes }); S.docCache = null; renderToolbar(); paint(); }
function togglePinNums(): void { S.pinNums = !S.pinNums; keep({ pinNums: S.pinNums }); S.docCache = null; renderToolbar(); paint(); }
function step(dir: 1 | -1): void { const n = stepSymbol(visibleSyms().map((i) => i.name), S.sym, dir); if (n && n !== S.sym) void selectSym(n); }
function renderToolbar(): void {
  if (!S.root) return;
  const tb = els.toolbar; tb.innerHTML = "";
  const btn = (id: string, run: () => void, enabled = true, on?: boolean): void => {
    const m = meta(id), b = h("button", { class: "se-btn" + (on ? " on" : ""), title: m.tip + (m.key ? ` (${menuKey(m.key)})` : ""), "data-id": id, "aria-label": m.label, "aria-pressed": on === undefined ? undefined : String(on) }, icon(m.icon)) as HTMLButtonElement;
    b.disabled = !enabled; b.addEventListener("click", () => run()); tb.append(b);
  };
  const sep = (): void => { tb.append(h("span", { class: "se-sep" })); };
  const names = visibleSyms().map((i) => i.name), i = names.indexOf(S.sym);
  btn("previousSymbol", () => step(-1), i > 0); btn("nextSymbol", () => step(1), i >= 0 && i < names.length - 1); sep();
  btn("zoomRedraw", () => { S.docCache = null; paint(); }); btn("zoomInCenter", () => zoomBy(1.3), hasSym()); btn("zoomOutCenter", () => zoomBy(1 / 1.3), hasSym()); btn("zoomFitScreen", zoomFit, hasSym()); sep();
  btn("showElectricalTypes", toggleTypes, true, S.etypes); btn("showPinNumbers", togglePinNums, true, S.pinNums); sep();
  // the body style choice: "Standard" / "Alternate" for a De Morgan symbol, else its own names (GetBodyStyleDescription)
  const body = h("k-select", { id: "sv-body", style: "width:150px" }) as HTMLElement & { value: string; disabled: boolean };
  if (S.bodies > 1 && S.node) { const bodyNames = bodyStyleNames(S.node); bodyNames.forEach((n, j) => body.append(h("option", { value: String(j + 1) }, n))); }
  body.value = String(S.body); body.toggleAttribute("disabled", S.bodies < 2);
  body.addEventListener("change", () => { S.body = +body.value || 1; S.docCache = null; paint(); });
  tb.append(body); sep();
  const unit = h("k-select", { id: "sv-unit", style: "width:150px" }) as HTMLElement & { value: string };
  if (S.units > 1) for (let u = 1; u <= S.units; u++) unit.append(h("option", { value: String(u) }, unitDisplayName(u)));
  unit.value = String(S.unit); unit.toggleAttribute("disabled", S.units < 2);
  unit.addEventListener("change", () => { S.unit = +unit.value || 1; S.docCache = null; paint(); });
  tb.append(unit); sep();
  btn("showDatasheet", showDatasheet, hasSym()); sep();
  btn("addSymbolToSchematic", addToSchematic, canAdd());
}
/** LIB_SYMBOL::GetUnitDisplayName: the unit's (unit_name …) when it has one, else "Unit A". */
function unitDisplayName(u: number): string {
  const n = S.node; if (n) for (const c of n) if (Array.isArray(c) && c[0] === "symbol") { const m = /_(\d+)_\d+$/.exec(String(c[1])); if (m && +m[1] === u) { const un = c.find((x) => Array.isArray(x) && x[0] === "unit_name") as SNode | undefined; if (un && un[1]) return String(un[1]); } }
  return unitName(u);
}
function showDatasheet(): void {
  const info = S.node ? symbolInfo(S.node) : null; const url = info ? info.datasheet.trim() : "";
  if (!url || url === "~") { toast("No datasheet defined."); return; }
  if (/^https?:/i.test(url)) window.open(url, "_blank", "noopener"); else toast("Datasheet: " + url);
}
function addToSchematic(): void {
  if (!canAdd() || !S.node) return;
  const it = current(); if (!it) return;
  const libId = it.id.includes(":") ? it.id : `${S.lib}:${it.name}`;
  const symbol = K().serialize(S.node), unit = S.unit, cb = S.onAdd;
  closeSymbolViewer();
  if (cb) { cb(libId, symbol, unit); return; }
  const L = window.KiCadLibrary as unknown as { placeSymbol(o: Record<string, unknown>): Promise<unknown> } | undefined;
  if (L) void L.placeSymbol({ libId, symbol, unit }).catch((e: Error) => messageBox(e.message));
}

// ---------------------------------------------------------------- canvas
function kdoc(): KDoc | null {
  const n = S.node; if (!n) return null;
  const key = [S.sym, S.unit, S.body, S.etypes, S.pinNums].join("§");
  if (S.docCache && S.docCache.key === key) return S.docCache.doc;
  let sym = n;
  if (!S.pinNums) {
    // SCH_RENDER_SETTINGS m_ShowPinNumbers off: the symbol drawn as if its pin numbers were hidden
    sym = (K().cloneNode as (x: SNode) => SNode)(n);
    const at = sym.findIndex((c) => Array.isArray(c) && c[0] === "pin_numbers");
    const hide: SNode = ["pin_numbers", ["hide", "yes"]];
    if (at >= 0) sym[at] = hide; else sym.splice(2, 0, hide);
  }
  const doc = K().parseLibSymbol(sym, { unit: S.unit, bodyStyle: S.body, showHiddenPins: false, showHiddenFields: false, showElectricalTypes: S.etypes });
  S.docCache = { key, doc }; return doc;
}
function resize(): void {
  const c = els.canvas, dpr = window.devicePixelRatio || 1, w = Math.max(1, c.clientWidth), hh = Math.max(1, c.clientHeight);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr); }
}
function paint(): void { if (S.raf) return; S.raf = requestAnimationFrame(() => { S.raf = 0; paintNow(); }); }
function paintNow(): void {
  if (!S.root) return; resize();
  const c = els.canvas, g = c.getContext("2d"); if (!g) return;
  const doc = kdoc(), dpr = window.devicePixelRatio || 1;
  els.empty.style.display = doc ? "none" : "flex";
  if (!doc) { g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = K().SCH.bg; g.fillRect(0, 0, c.width, c.height); return; }
  const v = S.view;
  K().render(doc, g, { ppm: 1, zoom: v.s, panX: v.px, panY: v.py, x0: 0, y0: 0, dpr }, { grid: 1.27, gridAxes: true, frame: false } as KRenderOpts);
}
function zoomFit(): void {
  const doc = kdoc(); const W = els.canvas.clientWidth || 800, H = els.canvas.clientHeight || 600;
  const bb = doc && doc.bbox ? doc.bbox : [-10, -10, 10, 10];
  const w = Math.max(5, bb[2] - bb[0]), hh = Math.max(5, bb[3] - bb[1]);
  const s = Math.min(W / (w * 1.4), H / (hh * 1.4), 200);
  S.view = { s, px: W / 2 - ((bb[0] + bb[2]) / 2) * s, py: H / 2 - ((bb[1] + bb[3]) / 2) * s };
  paint();
}
function zoomBy(f: number, at?: [number, number]): void {
  const W = els.canvas.clientWidth, H = els.canvas.clientHeight, [x, y] = at || [W / 2, H / 2], v = S.view;
  const s = Math.max(0.5, Math.min(2000, v.s * f)), k = s / v.s;
  S.view = { s, px: x - (x - v.px) * k, py: y - (y - v.py) * k }; paint();
}
function onWheel(e: WheelEvent): void {
  e.preventDefault(); const r = els.canvas.getBoundingClientRect(); const at: [number, number] = [e.clientX - r.left, e.clientY - r.top];
  if (e.ctrlKey || e.metaKey) { S.view.px -= e.deltaY; paint(); return; }
  if (e.shiftKey) { S.view.py -= e.deltaY; paint(); return; }
  zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, at);
}
function onDown(e: PointerEvent): void {
  if (e.button !== 1 && e.button !== 2) return;
  e.preventDefault(); els.canvas.setPointerCapture(e.pointerId); let x = e.clientX, y = e.clientY;
  const mv = (ev: PointerEvent): void => { S.view.px += ev.clientX - x; S.view.py += ev.clientY - y; x = ev.clientX; y = ev.clientY; paint(); };
  const up = (): void => { els.canvas.removeEventListener("pointermove", mv); els.canvas.removeEventListener("pointerup", up); };
  els.canvas.addEventListener("pointermove", mv); els.canvas.addEventListener("pointerup", up);
}

// ---------------------------------------------------------------- keys (SYMBOL_VIEWER_FRAME::OnCharHook)
function onKey(ev: KeyboardEvent): void {
  if (!S.root || S.root.hidden || document.querySelector(".kd-overlay")) return;
  const a = document.activeElement as HTMLElement | null, mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === "w") { ev.preventDefault(); ev.stopPropagation(); closeSymbolViewer(); return; }
  if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeMenus(); return; }
  if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
    const dir = ev.key === "ArrowUp" ? -1 : 1;
    if (a === els.libFilter || a === els.libList) {
      const libs = visibleLibs().map((l) => l.name), i = libs.indexOf(S.lib), j = i + dir;
      if (j >= 0 && j < libs.length) void selectLib(libs[j], "");
    } else step(dir as 1 | -1);
    ev.preventDefault(); ev.stopPropagation(); return;
  }
  if (ev.key === "Tab" && !mod) {
    if (a === els.libFilter) { ev.preventDefault(); els.symFilter.focus(); return; }
    if (a === els.symFilter) { ev.preventDefault(); els.canvas.focus(); return; }
  }
  if (a && (a.tagName === "INPUT" || a.tagName === "K-SELECT")) return;
  if (ev.key === "Home") { ev.preventDefault(); zoomFit(); }
  else if (ev.key === "F5") { ev.preventDefault(); S.docCache = null; paint(); }
  else if (ev.key.toLowerCase() === "d" && !mod) { ev.preventDefault(); showDatasheet(); }
  else if (ev.key === "Enter") { ev.preventDefault(); addToSchematic(); }
}
