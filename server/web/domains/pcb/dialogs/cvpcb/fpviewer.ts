// dialogs/cvpcb/fpviewer.ts — View Selected Footprint: DISPLAY_FOOTPRINTS_FRAME (cvpcb/display_footprints_frame.cpp), a
// non-modal window that follows CvPcb's selection: title "Footprint: %s", the top toolbar (zoom, 3D viewer, grid and
// zoom choices, automatic zoom) and the left one (select / measure, grid, polar coordinates, units, crosshair, pad
// numbers and the pad / text / graphic outline modes) from toolbars_display_footprints.cpp, the infobar errors of
// GetFootprint, the message panel (FOOTPRINT::GetMsgPanelInfo) and the status bar ("Lib: %s", cursor, delta, grid,
// zoom, units).  The canvas is the document renderer on a board holding the one footprint (library/preview.ts).
import { h } from "../dom";
import { icon, showMenu, closeMenus, type MenuEntry } from "../../symedit/ui";
import { hotkeyKey, keyName, shiftedPunctCombo } from "../../../../shared/keys";
import { gridChoiceText, loadUnits, messageText, saveUnits, unitsMsg, type UnitsSettings } from "../../../../shared/units";
import { PCB_DEFAULT_GRIDS } from "../logic";
import { ZOOM_LIST } from "../../tables";
import { PCB_CURSOR, PCB_GRID_AXES } from "../../canvas/colors";
import { emptyPreviewDoc, footprintPreviewDoc } from "../../library/preview";
import { show3DViewerOn } from "../../editor/viewer3d-loader";
import * as L from "./logic";
import { cvMeta, cvWindow, loadSettings, raiseWindow, saveSettings, type CvLib } from "./widgets";
import { closeMark } from "../../../../shared/components/kicon-dom";

export interface FpViewerHost {
  /** GetSelectedFootprint, else the selected symbol's FPID. */
  selectedFootprint(): string;
  info(fpid: string): L.FpInfo | null;
  lib(name: string): CvLib | null;
  docs(): unknown[];
  onClose(): void;
}
export interface FpViewer { update(): void; close(): void; front(): void }

const K = (): KiCadCanvasApi => window.KiCadCanvas;
type Render = (doc: KDoc, ctx: CanvasRenderingContext2D, view: KView, opts: Record<string, unknown>) => void;
/** Zoom 1 is the footprint at its real size on a 96 dpi screen. */
const PPM_PER_ZOOM = 96 / 25.4;
const fetched = new Map<string, Promise<string>>();

async function loadFootprintText(fpid: string, lib: CvLib): Promise<string> {
  const key = fpid; let p = fetched.get(key);
  if (!p) {
    const { name } = L.parseFpid(fpid);
    p = (async () => {
      if (lib.source === "official") {
        const r = await fetch(`/api/libs/footprints/${encodeURIComponent(lib.name)}/${encodeURIComponent(name)}`, { credentials: "same-origin" });
        if (!r.ok) throw new Error(r.status === 404 ? "not found" : `HTTP ${r.status}`);
        const j = await r.json() as { footprint?: string }; if (!j.footprint) throw new Error("empty"); return j.footprint;
      }
      const d = (lib.docs || []).find((x) => x.path.split("/").pop()!.replace(/\.kicad_mod$/i, "") === name);
      if (!d) throw new Error("not found");
      const r = await fetch(`/api/docs/${d.docId}/content`, { credentials: "same-origin" }); if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    })();
    p.catch(() => fetched.delete(key)); fetched.set(key, p);
  }
  return p;
}

export function openFpViewer(host: FpViewerHost): FpViewer {
  const cfg = loadSettings(); const vs = cfg.footprint_viewer;
  let units: UnitsSettings = loadUnits("cvpcb");
  let tool: "select" | "measure" | "zoom" = "select";
  let doc: KDoc = emptyPreviewDoc(), shown = "", bbox: [number, number, number, number] | null = null, raw = "";
  let ppm = PPM_PER_ZOOM * (vs.zoom || 1), cx = 0, cy = 0;      // view centre (mm)
  let cursor: [number, number] | null = null, origin: [number, number] = [0, 0];
  let measure: { a: [number, number]; b: [number, number]; done: boolean } | null = null;
  let zoomRect: { a: [number, number]; b: [number, number] } | null = null;
  let token = 0;
  const groupCur: Record<string, string> = {};

  const win = cvWindow({ id: "cv-fpviewer", title: "Footprint Viewer", geomKey: "cvpcb-fpviewer", width: 720, height: 560, cls: "cv-viewer", offset: 40, onCloseBox: () => close() });
  const canvas = h("canvas", { id: "cv-fpcanvas" }) as HTMLCanvasElement;
  const cwrap = h("div", { class: "cv-canvas", tabindex: "0" }, canvas);
  const info = h("div", { class: "se-info", id: "cv-fpinfo", role: "alert" });
  const msg = h("div", { class: "se-msg", id: "cv-fpmsg" });
  const st = { lib: h("span", { id: "cv-fplib" }), z: h("span"), xy: h("span"), d: h("span"), grid: h("span"), units: h("span") };
  const status = h("div", { class: "cv-vstatus" }, st.lib, st.z, st.xy, st.d, st.grid, st.units);
  const tbTop = h("div", { class: "se-tb", role: "toolbar", id: "cv-fptb" }), tbLeft = h("div", { class: "se-tbv se-tbl", role: "toolbar", id: "cv-fptbl" });
  win.body.append(tbTop, info, h("div", { class: "cv-vmain" }, tbLeft, cwrap), msg, status);

  const save = () => { vs.zoom = ppm / PPM_PER_ZOOM; saveSettings(Object.assign(loadSettings(), { footprint_viewer: vs })); };
  const gridMm = () => PCB_DEFAULT_GRIDS[Math.max(0, Math.min(PCB_DEFAULT_GRIDS.length - 1, vs.grid_idx))]!;

  // ------------------------------------------------------------ drawing
  const view = (): KView => { const r = cwrap.getBoundingClientRect(); return { ppm, zoom: 1, panX: 0, panY: 0, x0: cx - r.width / 2 / ppm, y0: cy - r.height / 2 / ppm, dpr: window.devicePixelRatio || 1 }; };
  const toWorld = (ev: MouseEvent): [number, number] => { const r = cwrap.getBoundingClientRect(); return [cx + (ev.clientX - r.left - r.width / 2) / ppm, cy + (ev.clientY - r.top - r.height / 2) / ppm]; };
  const snap = (p: [number, number]): [number, number] => { const g = gridMm(); return [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g]; };
  let pending = false;
  const paint = () => {
    pending = false;
    const r = cwrap.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), hh = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== hh) { canvas.width = w; canvas.height = hh; }
    const g = canvas.getContext("2d"); if (!g) return;
    const v = view();
    (K().render as unknown as Render)(doc, g, v, { frame: false, grid: vs.show_grid ? gridMm() : 0, hidden: new Set<string>(), padNumbers: vs.show_pad_number, outlinePads: !vs.show_pad_fill, sketchText: !vs.show_text_fill, sketchGraphics: !vs.show_graphic_fill });
    const sx = (x: number) => (x - v.x0) * ppm * dpr, sy = (y: number) => (y - v.y0) * ppm * dpr;
    g.save(); g.lineWidth = dpr;
    if (measure) {
      g.strokeStyle = PCB_GRID_AXES; g.fillStyle = PCB_GRID_AXES; g.beginPath(); g.moveTo(sx(measure.a[0]), sy(measure.a[1])); g.lineTo(sx(measure.b[0]), sy(measure.b[1])); g.stroke();
      const dist = Math.hypot(measure.b[0] - measure.a[0], measure.b[1] - measure.a[1]);
      // a canvas font cannot name a CSS variable: the theme's monospace family, resolved
      const mono = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace";
      g.font = `${12 * dpr}px ${mono}`; g.fillText(messageText(dist, units.units, "pcb"), sx(measure.b[0]) + 6 * dpr, sy(measure.b[1]) - 6 * dpr);
    }
    if (zoomRect) { g.strokeStyle = PCB_GRID_AXES; g.setLineDash([4 * dpr, 4 * dpr]); const x = sx(Math.min(zoomRect.a[0], zoomRect.b[0])), y = sy(Math.min(zoomRect.a[1], zoomRect.b[1])); g.strokeRect(x, y, Math.abs(zoomRect.b[0] - zoomRect.a[0]) * ppm * dpr, Math.abs(zoomRect.b[1] - zoomRect.a[1]) * ppm * dpr); g.setLineDash([]); }
    if (cursor) {
      // KICURSOR crosshair: small (a short cross), full (window-wide), 45° (diagonals)
      g.strokeStyle = PCB_CURSOR; const x = sx(cursor[0]), y = sy(cursor[1]); g.beginPath();
      if (vs.crosshair === "full") { g.moveTo(0, y); g.lineTo(w, y); g.moveTo(x, 0); g.lineTo(x, hh); }
      else if (vs.crosshair === "45") { const L2 = Math.max(w, hh); g.moveTo(x - L2, y - L2); g.lineTo(x + L2, y + L2); g.moveTo(x - L2, y + L2); g.lineTo(x + L2, y - L2); }
      else { const a = 8 * dpr; g.moveTo(x - a, y); g.lineTo(x + a, y); g.moveTo(x, y - a); g.lineTo(x, y + a); }
      g.stroke();
    }
    g.restore();
    updateStatus();
  };
  const redraw = () => { if (!pending) { pending = true; requestAnimationFrame(paint); } };
  const fit = () => {
    const r = cwrap.getBoundingClientRect(); const b = bbox || [-5, -5, 5, 5];
    const bw = Math.max(0.5, b[2] - b[0]), bh = Math.max(0.5, b[3] - b[1]);
    ppm = Math.max(0.05, Math.min((r.width * 0.84) / bw, (r.height * 0.84) / bh)); cx = (b[0] + b[2]) / 2; cy = (b[1] + b[3]) / 2; save(); renderTop(); redraw();
  };
  const zoomBy = (f: number, at?: [number, number]) => {
    const n = Math.max(0.05, Math.min(PPM_PER_ZOOM * 400, ppm * f));
    if (at) { cx = at[0] - (at[0] - cx) * ppm / n; cy = at[1] - (at[1] - cy) * ppm / n; }
    ppm = n; save(); renderTop(); redraw();
  };

  // ------------------------------------------------------------ status bar and message panel
  const updateStatus = () => {
    st.z.textContent = `Z ${(ppm / PPM_PER_ZOOM).toFixed(2)}`;
    const u = units.units;
    if (cursor) {
      const p = cursor;
      if (vs.polar) { const r = Math.hypot(p[0] - origin[0], p[1] - origin[1]), th = Math.atan2(-(p[1] - origin[1]), p[0] - origin[0]) * 180 / Math.PI; st.xy.textContent = `r ${messageText(r, u, "pcb", false)}  θ ${th.toFixed(1)}`; }
      else st.xy.textContent = `X ${messageText(p[0], u, "pcb", false)}  Y ${messageText(p[1], u, "pcb", false)}`;
      const dx = p[0] - origin[0], dy = p[1] - origin[1];
      st.d.textContent = `dx ${messageText(dx, u, "pcb", false)}  dy ${messageText(dy, u, "pcb", false)}  dist ${messageText(Math.hypot(dx, dy), u, "pcb", false)}`;
    } else { st.xy.textContent = ""; st.d.textContent = ""; }
    st.grid.textContent = `grid ${messageText(gridMm(), u, "pcb", false)}`;
    st.units.textContent = unitsMsg(u);
  };
  const msgPanel = () => {
    msg.replaceChildren();
    if (!raw) return;
    const n = K().parse(raw); if (!n) return;
    const prop = (k: string) => { for (const p of K().kids(n, "property")) if (String(p[1]) === k) return String(p[2] ?? ""); return ""; };
    const one = (k: string) => { const c = K().kid(n, k); return c ? String(c[1] ?? "") : ""; };
    const attr = K().kid(n, "attr"); const flags = attr ? attr.slice(1).map(String) : [];
    const attrs: string[] = []; if (flags.includes("board_only")) attrs.push("not in schematic"); if (flags.includes("exclude_from_pos_files")) attrs.push("exclude from pos files"); if (flags.includes("exclude_from_bom")) attrs.push("exclude from BOM"); if (flags.includes("dnp")) attrs.push("DNP");
    const model = K().kid(n, "model");
    const item = (a: string, b: string) => msg.append(h("div", null, h("b", null, a), h("span", null, b)));
    item(prop("Reference"), prop("Value"));
    item("Board Side", "Front"); item("Rotation", "0");
    item("Status: ", "Attributes: " + attrs.join(", "));
    item(`Footprint: ${shown}`, `3D-Shape: ${model ? String(model[1]) : "<none>"}`);
    item(`Doc: ${one("descr") || prop("Description")}`, `Keywords: ${one("tags")}`);
  };

  // ------------------------------------------------------------ InitDisplay: the selected footprint
  const showError = (text: string) => { info.replaceChildren(h("span", null, text), h("span", { class: "se-x", title: "Dismiss", onclick: () => info.classList.remove("show") }, closeMark())); info.classList.add("show"); };
  const update = () => {
    const fpid = host.selectedFootprint();
    if (fpid === shown) return;
    shown = fpid; const my = ++token;
    info.classList.remove("show"); info.replaceChildren();
    doc = emptyPreviewDoc(); bbox = null; raw = ""; measure = null;
    if (fpid) win.setTitle(`Footprint: ${fpid}`);
    const fi = fpid ? host.info(fpid) : null;
    st.lib.textContent = fi ? `Lib: ${fi.lib}` : "";
    msgPanel(); redraw();
    if (!fpid) return;
    const p = L.parseFpid(fpid);
    if (!p.valid) { showError(`Footprint ID '${fpid}' is not valid.`); return; }
    const lib = host.lib(p.lib);
    if (!lib) { showError(`Library '${p.lib}' is not in the footprint library table.`); return; }
    if (!fi) { showError(`Footprint '${fpid}' not found.`); return; }
    loadFootprintText(fpid, lib).then((text) => {
      if (my !== token) return;
      raw = text; doc = footprintPreviewDoc(fpid, text);
      let b: [number, number, number, number] | null = null;
      for (const it of doc.items.values()) { const ib = it.bbox; if (!ib) continue; b = b ? [Math.min(b[0], ib[0]), Math.min(b[1], ib[1]), Math.max(b[2], ib[2]), Math.max(b[3], ib[3])] : [ib[0], ib[1], ib[2], ib[3]]; }
      bbox = b; msgPanel();
      // updateView: zoom to fit when "Automatically zoom to fit" is on, else centre the footprint at the same zoom
      if (vs.autozoom) fit(); else { if (b) { cx = (b[0] + b[2]) / 2; cy = (b[1] + b[3]) / 2; } redraw(); }
    }, (e: Error) => { if (my === token) showError(e.message === "not found" ? `Footprint '${fpid}' not found.` : `Error loading footprint: ${e.message}`); });
  };

  // ------------------------------------------------------------ actions
  const setUnits = (u: "mm" | "in" | "mil") => { units = { units: u, lastImperial: u === "mm" ? units.lastImperial : u }; saveUnits("cvpcb", units); renderTop(); renderLeft(); redraw(); };
  const A: Record<string, () => void> = {
    zoomRedraw: () => redraw(), zoomInCenter: () => zoomBy(1.3), zoomOutCenter: () => zoomBy(1 / 1.3), zoomFitScreen: () => fit(),
    zoomTool: () => { tool = tool === "zoom" ? "select" : "zoom"; renderTop(); renderLeft(); },
    // the 3D viewer opens (or is focused) above this window
    show3DViewer: () => { void show3DViewerOn({ getDoc: () => (raw ? doc : null), getName: () => shown }).then(() => { const w = document.querySelector<HTMLElement>(".v3d-win"); if (w) raiseWindow(w); }); },
    fpAutoZoom: () => { vs.autozoom = !vs.autozoom; save(); renderTop(); if (vs.autozoom) fit(); },
    selectionTool: () => { tool = "select"; measure = null; renderTop(); renderLeft(); redraw(); },
    measureTool: () => { tool = "measure"; measure = null; renderTop(); renderLeft(); redraw(); },
    toggleGrid: () => { vs.show_grid = !vs.show_grid; save(); renderLeft(); redraw(); },
    togglePolarCoords: () => { vs.polar = !vs.polar; save(); renderLeft(); redraw(); },
    millimetersUnits: () => setUnits("mm"), inchesUnits: () => setUnits("in"), milsUnits: () => setUnits("mil"),
    cursorSmallCrosshairs: () => { vs.crosshair = "small"; save(); renderLeft(); redraw(); }, cursorFullCrosshairs: () => { vs.crosshair = "full"; save(); renderLeft(); redraw(); }, cursor45Crosshairs: () => { vs.crosshair = "45"; save(); renderLeft(); redraw(); },
    showPadNumbers: () => { vs.show_pad_number = !vs.show_pad_number; save(); renderLeft(); redraw(); },
    padDisplayMode: () => { vs.show_pad_fill = !vs.show_pad_fill; save(); renderLeft(); redraw(); },
    textOutlines: () => { vs.show_text_fill = !vs.show_text_fill; save(); renderLeft(); redraw(); },
    graphicsOutlines: () => { vs.show_graphic_fill = !vs.show_graphic_fill; save(); renderLeft(); redraw(); },
  };
  const checked = (id: string): boolean | undefined => {
    switch (id) {
      case "zoomTool": return tool === "zoom"; case "fpAutoZoom": return vs.autozoom; case "selectionTool": return tool === "select"; case "measureTool": return tool === "measure";
      case "toggleGrid": return vs.show_grid; case "togglePolarCoords": return vs.polar;
      case "millimetersUnits": return units.units === "mm"; case "inchesUnits": return units.units === "in"; case "milsUnits": return units.units === "mil";
      case "cursorSmallCrosshairs": return vs.crosshair === "small"; case "cursorFullCrosshairs": return vs.crosshair === "full"; case "cursor45Crosshairs": return vs.crosshair === "45";
      // KiCad's toggles show the "on" state of the option they name: pad numbers shown, outlines (= not filled)
      case "showPadNumbers": return vs.show_pad_number; case "padDisplayMode": return !vs.show_pad_fill; case "textOutlines": return !vs.show_text_fill; case "graphicsOutlines": return !vs.show_graphic_fill;
    }
    return undefined;
  };
  const button = (id: string): HTMLButtonElement => {
    const m = cvMeta(id); const on = checked(id); const run = A[id];
    const b = h("button", { class: "se-btn" + (on ? " on" : ""), "data-act": id, title: m.tip + (m.key ? ` (${keyName(m.key)})` : ""), "aria-label": m.label, "aria-pressed": on === undefined ? undefined : String(on) }, icon(m.icon)) as HTMLButtonElement;
    if (!run) b.disabled = true; else b.addEventListener("click", () => run());
    return b;
  };
  type Item = { id?: string; sep?: boolean; control?: string; group?: string; items?: { id: string }[] };
  const spec = (loc: string): Item[] => { const t = (window as unknown as { KiCadUiToolbars?: Record<string, Record<string, Item[]>> }).KiCadUiToolbars; return (t && t.fpviewer && t.fpviewer[loc]) || []; };
  /** ACTION_TOOLBAR::AddGroup: the group's checked (or last used) action, a corner triangle, the palette of the others. */
  const group = (name: string, ids: string[], vertical: boolean): HTMLElement => {
    const curId = ids.find((i) => checked(i)) || groupCur[name] || ids[0]!;
    const b = button(curId); const wrap = h("span", { class: "se-group", "data-group": name }, b);
    const arrow = h("button", { class: "se-garrow", title: name, "aria-label": name });
    arrow.innerHTML = '<svg viewBox="0 0 6 6"><path d="M6 0V6H0z" fill="currentColor"/></svg>';
    arrow.addEventListener("click", (ev) => {
      ev.stopPropagation(); for (const o of Array.from(document.querySelectorAll(".se-palette"))) o.remove();
      const pal = h("div", { class: "se-palette" + (vertical ? "" : " col"), role: "menu" });
      for (const id of ids) { const pb = button(id); pb.addEventListener("click", () => { groupCur[name] = id; pal.remove(); }); pal.append(pb); }
      document.body.append(pal); const r = wrap.getBoundingClientRect(); pal.style.left = (vertical ? r.right + 2 : r.left) + "px"; pal.style.top = (vertical ? r.top : r.bottom + 2) + "px";
      setTimeout(() => document.addEventListener("pointerdown", function away(e) { if (!pal.contains(e.target as Node)) { pal.remove(); document.removeEventListener("pointerdown", away, true); } }, true), 0);
    });
    wrap.append(arrow); return wrap;
  };
  const control = (name: string): HTMLElement | null => {
    if (name === "gridSelect") {
      const s = h("k-select", { id: "cv-fpgrid", "aria-label": "Grid" }) as HTMLSelectElement;
      PCB_DEFAULT_GRIDS.forEach((mm, i) => s.append(h("option", { value: String(i) }, gridChoiceText({ mm }, units.units, units.lastImperial, "pcb"))));
      s.value = String(vs.grid_idx); s.addEventListener("change", () => { vs.grid_idx = Number(s.value); save(); redraw(); });
      return s;
    }
    if (name === "zoomSelect") {
      const s = h("k-select", { id: "cv-fpzoom", "aria-label": "Zoom" }) as HTMLSelectElement;
      s.append(h("option", { value: "auto" }, "Zoom Auto"));
      const z = ppm / PPM_PER_ZOOM; let pick = "auto";
      for (const f of ZOOM_LIST.pcb) { s.append(h("option", { value: String(f) }, `Zoom ${f.toFixed(2)}`)); if (Math.abs(f - z) / f < 0.01) pick = String(f); }
      s.value = pick; s.addEventListener("change", () => { if (s.value === "auto") fit(); else { ppm = Number(s.value) * PPM_PER_ZOOM; save(); redraw(); } });
      return s;
    }
    return null;
  };
  const fill = (host2: HTMLElement, items: Item[], vertical: boolean) => {
    host2.replaceChildren();
    for (const it of items) {
      if (it.sep) host2.append(h("span", { class: "se-sep" }));
      else if (it.control) { const c = control(it.control); if (c) host2.append(c); }
      else if (it.group && it.items) host2.append(group(it.group, it.items.map((x) => x.id), vertical));
      else if (it.id) host2.append(button(it.id));
    }
  };
  const renderTop = () => fill(tbTop, spec("top"), false);
  const renderLeft = () => fill(tbLeft, spec("left"), true);

  // ------------------------------------------------------------ mouse and keys
  let pan: { x: number; y: number; cx: number; cy: number; moved: boolean; button: number } | null = null;
  cwrap.addEventListener("pointerdown", (ev) => {
    cwrap.focus({ preventScroll: true }); closeMenus();
    if (ev.button === 1 || ev.button === 2) { pan = { x: ev.clientX, y: ev.clientY, cx, cy, moved: false, button: ev.button }; cwrap.setPointerCapture(ev.pointerId); ev.preventDefault(); return; }
    if (ev.button !== 0) return;
    const p = snap(toWorld(ev));
    if (tool === "measure") { if (!measure || measure.done) measure = { a: p, b: p, done: false }; else measure.done = true; redraw(); }
    else if (tool === "zoom") { zoomRect = { a: toWorld(ev), b: toWorld(ev) }; cwrap.setPointerCapture(ev.pointerId); }
  });
  cwrap.addEventListener("pointermove", (ev) => {
    if (pan) { const dx = ev.clientX - pan.x, dy = ev.clientY - pan.y; if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true; cx = pan.cx - dx / ppm; cy = pan.cy - dy / ppm; }
    cursor = snap(toWorld(ev));
    if (measure && !measure.done) measure.b = cursor;
    if (zoomRect) zoomRect.b = toWorld(ev);
    redraw();
  });
  cwrap.addEventListener("pointerup", (ev) => {
    if (pan) { const p = pan; pan = null; if (p.button === 2 && !p.moved) showMenu(ev.clientX, ev.clientY, ctxMenu()); return; }
    if (zoomRect) {
      const z = zoomRect; zoomRect = null; const w = Math.abs(z.b[0] - z.a[0]), hh = Math.abs(z.b[1] - z.a[1]);
      if (w > 0.01 && hh > 0.01) { const r = cwrap.getBoundingClientRect(); cx = (z.a[0] + z.b[0]) / 2; cy = (z.a[1] + z.b[1]) / 2; ppm = Math.min(r.width / w, r.height / hh); save(); renderTop(); }
      redraw();
    }
  });
  cwrap.addEventListener("dblclick", (ev) => { if (ev.button === 1) fit(); });
  cwrap.addEventListener("auxclick", (ev) => { if (ev.button === 1 && ev.detail === 2) fit(); });
  cwrap.addEventListener("contextmenu", (ev) => ev.preventDefault());
  cwrap.addEventListener("pointerleave", () => { cursor = null; redraw(); });
  cwrap.addEventListener("wheel", (ev) => { ev.preventDefault(); zoomBy(ev.deltaY < 0 ? 1.2 : 1 / 1.2, toWorld(ev)); }, { passive: false });
  const ctxMenu = (): MenuEntry[] => {
    const a = (id: string): MenuEntry => { const m = cvMeta(id); return { id, label: m.label, icon: m.icon, key: m.key, run: A[id], enabled: () => !!A[id] }; };
    return [a("zoomInCenter"), a("zoomOutCenter"), a("zoomFitScreen"), { sep: true },
      { label: "Zoom", icon: "zoom_selection", sub: ZOOM_LIST.pcb.map((f) => ({ label: `Zoom ${f.toFixed(2)}`, check: () => Math.abs(ppm / PPM_PER_ZOOM - f) / f < 0.01, run: () => { ppm = f * PPM_PER_ZOOM; save(); renderTop(); redraw(); }, enabled: () => true })) },
      { label: "Grid", icon: "grid_select", sub: PCB_DEFAULT_GRIDS.map((mm, i) => ({ label: gridChoiceText({ mm }, units.units, units.lastImperial, "pcb"), check: () => vs.grid_idx === i, run: () => { vs.grid_idx = i; save(); renderTop(); redraw(); }, enabled: () => true })) }];
  };
  // the event in the spec's notation, as editor/hotkeys.ts comboOf spells it: Shift is part of typing a printable
  // character (Ctrl+Shift+= is "Ctrl++"), Alt matches the physical key (keys.ts hotkeyKey)
  const comboOf = (ev: KeyboardEvent): string => {
    let k = hotkeyKey(ev); if (!k || k === "Control" || k === "Shift" || k === "Alt" || k === "Meta") return "";
    const letter = k.length === 1 && /[a-z]/i.test(k); if (letter) k = k.toUpperCase();
    const printable = k.length === 1 && !letter && !/[0-9]/.test(k);
    return [ev.ctrlKey || ev.metaKey ? "Ctrl" : "", ev.shiftKey && !printable ? "Shift" : "", ev.altKey ? "Alt" : "", k].filter(Boolean).join("+");
  };
  const hot = (id: string, ev: KeyboardEvent): boolean => { const k = cvMeta(id).key; if (!k) return false; return comboOf(ev) === k || shiftedPunctCombo(ev) === k; };
  win.root.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.target && (ev.target as HTMLElement).tagName === "K-SELECT") return;
    if (ev.key === "Escape") { if (measure || zoomRect) { measure = null; zoomRect = null; redraw(); } else if (tool !== "select") A.selectionTool!(); ev.preventDefault(); return; }
    if (ev.key === " " && cursor) { origin = cursor; redraw(); ev.preventDefault(); return; }   // ACTIONS::resetLocalCoords
    for (const id of ["zoomIn", "zoomOut", "zoomFitScreen", "zoomRedraw", "toggleUnits", "togglePolarCoords", "measureTool", "toggleGrid", "show3DViewer"]) if (hot(id, ev)) {
      ev.preventDefault();
      if (id === "zoomIn") zoomBy(1.3, cursor || undefined); else if (id === "zoomOut") zoomBy(1 / 1.3, cursor || undefined);
      else if (id === "toggleUnits") setUnits(units.units === "mm" ? (units.lastImperial === "in" ? "in" : "mil") : "mm");
      else A[id]!();
      return;
    }
  });
  win.root.addEventListener("cv-resize", () => redraw());
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => redraw()).observe(cwrap);

  const close = () => { token++; for (const o of Array.from(document.querySelectorAll(".se-palette"))) o.remove(); win.close(); host.onClose(); };
  renderTop(); renderLeft(); update(); redraw();
  return { update, close, front: () => win.front() };
}
