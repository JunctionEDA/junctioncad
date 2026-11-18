// pcbdialogs/model3d — the 3D model pieces of Footprint Properties' 3D Models tab:
//   pick3DModel        PANEL_FP_PROPERTIES_3D_MODEL::pick3DModel's "Select 3D Model" picker, over KiCad's 3D model
//                      library (the server's ${KICAD10_3DMODEL_DIR}), the project's model files and the footprint's
//                      embedded files, with a preview of the highlighted file (panel_model_file_preview.cpp)
//   modelPreview       PANEL_PREVIEW_3D_MODEL's canvas and its button column: orthographic projection, board body,
//                      the six views, Reload board and 3D models, and the 3D Preview Options (board thickness)
//   stepper            the wxSpinButton beside each Scale / Rotation / Offset field, with the mouse-wheel steps
// The pure parts (path checks, steps, the preview board) are library/model3d.ts.
import * as M from "../../library/model3d";
// the loader is fetched when a preview opens: a static import would pull editor/actions.ts in while doc.ts loads
import type { EmbeddedViewer3D } from "../viewer3d-loader";
import { box, checkField, currentUnits, errorMessage, form, grid, gridButtons, h, iconButton, lenField, messageBox, numField, openDialog, selectField, unitLabel, unitName, type CellValue, type DialogApi, type Field } from "./ui";
import { colorPicker, type RGBA } from "./color-picker";
import { bitmapButton } from "../../../../shared/components/kicon-dom";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const parseDoc = (text: string): KDoc | null => { try { return KiCadCanvas.parseDoc(text, "kicad_pcb"); } catch { return null; } };
const store = { get(k: string): string { try { return localStorage.getItem(k) || ""; } catch { return ""; } }, set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* storage off */ } } };

// ---------------------------------------------------------------- KiCad's 3D library listings
const libLists = new Map<string, Set<string> | null>();
const libWait = new Map<string, Promise<Set<string> | null>>();
let libraries: Promise<string[]> | null = null;
/** The 3D model libraries of the server's ${KICAD10_3DMODEL_DIR} (Lib.3dshapes folders). */
export function modelLibraries(): Promise<string[]> {
  if (!libraries) libraries = fetch("/api/kicad-lib/list?kind=model", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : { libraries: [] })).then((j: Any) => (Array.isArray(j && j.libraries) ? j.libraries as string[] : [])).catch(() => []);
  libraries.then((l) => { if (!l.length) libraries = null; }).catch(() => { libraries = null; });
  return libraries;
}
/** A 3D library's model names: undefined until it arrives (then `done` runs), null when it cannot be listed. */
export function modelLibItems(lib: string, done?: () => void): Set<string> | null | undefined {
  if (libLists.has(lib)) return libLists.get(lib);
  let p = libWait.get(lib);
  if (!p) {
    p = fetch(`/api/kicad-lib/list?kind=model&lib=${encodeURIComponent(lib)}`, { credentials: "same-origin" })
      .then((r) => (r.status === 404 ? { items: [] } : r.ok ? r.json() : null)).then((j: Any) => (j && Array.isArray(j.items) ? new Set<string>(j.items) : null)).catch(() => null)
      .then((s) => { libLists.set(lib, s); libWait.delete(lib); return s; });
    libWait.set(lib, p);
  }
  if (done) void p.then(() => done());
  return undefined;
}

// ---------------------------------------------------------------- the 3D preview
export interface PreviewApi { el: HTMLElement; update(boardText: string): void; dispose(): void; thickness(): number }
/**
 * A 3D canvas showing a board text (an FPHOLDER board with the footprint).  `buttons` adds PANEL_PREVIEW_3D_MODEL's
 * column of STD_BITMAP_BUTTONs on its right; `reload` rebuilds the board text (the Reload button).
 */
export function modelPreview(opts: { buttons?: boolean; reload?(): void; key?: string; height?: string; board?: boolean; thickness?: number } = {}): PreviewApi {
  const host = h("div", { class: "pd-3dprev", "data-k": opts.key || "preview3d", style: `height:${opts.height || "100%"}` });
  const status = h("div", { class: "pd-3dprev-msg" }, "Loading 3D viewer...");
  host.append(status);
  let viewer: EmbeddedViewer3D | null = null, pending: string | null = null, gone = false, fit = true, thickness = opts.thickness && opts.thickness > 0 ? opts.thickness : 1.6, bodyShown = opts.board !== false;
  const draw = (text: string): void => {
    if (!viewer) { pending = text; return; }
    const doc = parseDoc(text); if (!doc) return;
    viewer.setDoc(doc, fit); fit = false; showBody();
  };
  // m_bpvBodyStyle: without the body only the copper and silkscreen layers are drawn
  const showBody = (): void => { if (viewer) viewer.setVisibility({ board: bodyShown, maskTop: bodyShown, maskBottom: bodyShown, paste: bodyShown }); };
  import("../viewer3d-loader").then((m) => m.loadViewer()).then((g) => {
    if (gone || !g.embed) return;
    status.remove();
    viewer = g.embed(host, { wheel: true }); viewer.useModels(true);
    if (pending !== null) { const t = pending; pending = null; draw(t); }
  }).catch(() => { status.textContent = "The 3D viewer could not be loaded."; });
  let el: HTMLElement = host;
  if (opts.buttons) {
    const btn = (icon: string, tip: string, fn: () => void, k: string): HTMLButtonElement => bitmapButton(icon, tip, fn, { key: k, cls: "pd-iconbtn" });
    const ortho = btn("ortho", "Enable/disable orthographic projection", () => { if (viewer) { viewer.setOrtho(!viewer.ortho); ortho.classList.toggle("on", viewer.ortho); } }, "prev-ortho");
    const body = btn("show_board_body", "Show or hide the board body\nIf hidden, show only copper and silkscreen layers.", () => { bodyShown = !bodyShown; body.classList.toggle("on", !bodyShown); showBody(); }, "prev-body");
    const view = (name: string, label: string): HTMLButtonElement => btn("axis3d_" + name, "View " + label, () => { if (viewer) viewer.view(name); }, "prev-" + name);
    const reload = btn("reload", "Reload board and 3D models", () => { fit = true; if (opts.reload) opts.reload(); }, "prev-reload");
    // PANEL_PREVIEW_3D_MODEL::View3DSettings: WX_UNIT_ENTRY_DIALOG "3D Preview Options" / "Board thickness:"
    const settings = btn("options_3drender", "", () => {
      const f = lenField(thickness, { key: "boardThickness", min: 0 });
      openDialog({ title: "3D Preview Options", width: 300, child: true, build(b) { b.append(h("div", { class: "pd-row" }, h("span", { class: "pd-lbl" }, "Board thickness:"), f.el, unitLabel())); setTimeout(() => (f.input as HTMLInputElement).select(), 0); },
        ok() { const v = f.get(); if (!(v > 0)) return false; thickness = v; if (opts.reload) opts.reload(); return true; } });
    }, "prev-settings");
    const col = h("div", { class: "pd-3dbtns" }, h("div", { style: "height:14px" }), ortho, body, h("div", { style: "height:20px" }),
      view("left", "Left"), view("right", "Right"), view("front", "Front"), view("back", "Back"), view("top", "Top"), view("bottom", "Bottom"), h("div", { style: "height:20px" }), reload, settings);
    el = h("div", { class: "pd-3dwrap" }, host, col);
  }
  return { el, update: draw, thickness: () => thickness, dispose() { gone = true; if (viewer) { viewer.dispose(); viewer = null; } } };
}

/** Run `fn` once `el` has left the page (a dialog closed): the previews give their WebGL context back. */
export function whenGone(el: HTMLElement, fn: () => void): void {
  const mo = new MutationObserver(() => { if (!el.isConnected) { mo.disconnect(); fn(); } });
  setTimeout(() => { if (!el.isConnected) { fn(); return; } mo.observe(document.body, { childList: true, subtree: true }); }, 0);
}

// ---------------------------------------------------------------- spin buttons
/**
 * A wxSpinButton beside a text control, and the control's mouse wheel (onMouseWheelScale / Rot / Offset): `step`
 * gives the next value for a direction and the Shift state.
 */
export function stepper<T extends number>(f: Field<T>, step: (v: number, sign: number, fine: boolean) => number, onChange?: () => void): HTMLElement {
  const input = f.input as HTMLInputElement;
  const bump = (sign: number, fine: boolean): void => { if (input.disabled) return; f.set(step(f.get(), sign, fine) as T); input.dispatchEvent(new Event("change", { bubbles: true })); if (onChange) onChange(); };
  const arrow = (d: string): SVGSVGElement => { const t = document.createElement("template"); t.innerHTML = `<svg viewBox="0 0 8 5" width="8" height="5" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`; return t.content.firstChild as SVGSVGElement; };
  const key = input.getAttribute("data-k") || "";
  const up = h("button", { type: "button", tabindex: "-1", "aria-label": "Increment", "data-k": key + "-up" }, arrow("M0 5L4 0L8 5Z"));
  const down = h("button", { type: "button", tabindex: "-1", "aria-label": "Decrement", "data-k": key + "-down" }, arrow("M0 0L8 0L4 5Z"));
  up.addEventListener("mousedown", (ev) => { ev.preventDefault(); bump(1, ev.shiftKey); });
  down.addEventListener("mousedown", (ev) => { ev.preventDefault(); bump(-1, ev.shiftKey); });
  input.addEventListener("wheel", (ev) => { if (document.activeElement !== input && !input.matches(":hover")) return; ev.preventDefault(); bump(ev.deltaY < 0 ? 1 : -1, ev.shiftKey); }, { passive: false });
  input.addEventListener("keydown", (ev) => { if (ev.key === "ArrowUp" || ev.key === "ArrowDown") { ev.preventDefault(); bump(ev.key === "ArrowUp" ? 1 : -1, ev.shiftKey); } });
  return h("span", { class: "pd-spin" }, input, h("span", { class: "arrows" }, up, down));
}

// ---------------------------------------------------------------- the picker
export interface PickOpts {
  /** the row's current value (a re-pick starts where that file is) */
  current?: string;
  /** the configured path choice ("Automatic" or a search path) */
  start?: string;
  projectFiles: string[];
  embedded: string[];
}
type Place = "lib" | "project" | "embedded";
const LAST_DIR = "kui.pcbnew.lastFootprint3dDir";

/** The "Select 3D Model" picker; resolves to the path the footprint stores (FILENAME_RESOLVER::ShortenPath) or null. */
export function pick3DModel(o: PickOpts): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false; const finish = (v: string | null): void => { if (!done) { done = true; prev.dispose(); resolve(v); } };
    // the start folder: the current file's, the configured path, the last one used, then the 3D library
    const cur = o.current ? M.modelTarget(o.current) : null;
    let place: Place = "lib", folder = "", file = "";
    if (cur && cur.kind === "kicad") { place = "lib"; folder = cur.lib; file = cur.name + "." + cur.ext; }
    else if (cur && cur.kind === "project" && M.projectModelFile(cur.path, o.projectFiles)) { place = "project"; const p = M.projectModelFile(cur.path, o.projectFiles)!; folder = p.split("/").slice(0, -1).join("/"); file = p.split("/").pop() || ""; }
    else if (cur && cur.kind === "embedded") { place = "embedded"; file = cur.name; }
    else {
      const start = o.start && o.start !== "Automatic" ? o.start : store.get(LAST_DIR);
      if (/KIPRJMOD/.test(start)) { place = "project"; folder = start.replace(/^\$\{KIPRJMOD\}\/?/, ""); }
      else if (/3DMODEL_DIR/.test(start)) { place = "lib"; folder = start.replace(/^\$\{[^}]+\}\/?/, "").replace(/\.3dshapes$/, ""); }
    }
    const filters = M.modelFilterList(); let filterIx = 0;
    const lookIn = h("k-select", { "data-k": "lookIn", style: "flex:1" });
    const places: [Place, string][] = [["lib", "${" + M.MODEL_DIR_VAR + "}  (KiCad's 3D model library)"], ["project", "${KIPRJMOD}  (this project's files)"]];
    if (o.embedded.length) places.push(["embedded", "Embedded files"]);
    for (const [v, l] of places) { const op = h("option", { value: v }, l); if (v === place) op.selected = true; lookIn.append(op); }
    const folderFilter = h("input", { type: "text", placeholder: "Filter", "data-k": "folderFilter" }) as HTMLInputElement;
    const fileFilter = h("input", { type: "text", placeholder: "Filter", "data-k": "fileFilter" }) as HTMLInputElement;
    const folderRows: Record<string, CellValue>[] = [], fileRows: Record<string, CellValue>[] = [];
    const folders = grid([{ label: "Folder", key: "name", type: "ro" }], folderRows, { height: "320px", key: "folders", onSelect: (i) => { const r = folders.rows()[i]; if (r && String(r.id) !== folder) { folder = String(r.id); file = ""; listFiles(); } } });
    const files = grid([{ label: "File", key: "name", type: "ro" }], fileRows, { height: "320px", key: "files", onSelect: (i) => { const r = files.rows()[i]; if (r) { file = String(r.name); nameIn.value = file; showPreview(); } } });
    const nameIn = h("input", { type: "text", "data-k": "fileName", style: "flex:1" }) as HTMLInputElement;
    const typeSel = h("k-select", { "data-k": "fileType", style: "flex:1;min-width:0" });
    filters.forEach((f, i) => { const op = h("option", { value: String(i) }, f.label); if (i === 0) op.selected = true; typeSel.append(op); });
    const prev = modelPreview({ key: "pickerPreview", board: false });   // panel_model_file_preview: the model alone
    const folderBox = h("div", { class: "pd-col", style: "display:flex;flex-direction:column;gap:4px;min-width:0" }, folderFilter, folders.el);
    let libs: string[] = [];
    const wild = (s: string, pat: string): boolean => !pat || s.toLowerCase().includes(pat.toLowerCase());
    const listFolders = (): void => {
      folderBox.style.display = place === "embedded" ? "none" : "flex";
      let names: { id: string; name: string }[] = [];
      if (place === "lib") names = libs.map((l) => ({ id: l, name: l + ".3dshapes" }));
      else if (place === "project") { const dirs = new Set<string>([""]); for (const p of o.projectFiles) dirs.add(p.split("/").slice(0, -1).join("/")); names = [...dirs].sort().map((d) => ({ id: d, name: d || "(project folder)" })); }
      const shown = names.filter((n) => wild(n.name, folderFilter.value));
      folders.setRows(shown.map((n) => ({ id: n.id, name: n.name })));
      const at = shown.findIndex((n) => n.id === folder);
      if (at >= 0) { folders.select(at); scrollSel(folders.el); } else if (place !== "embedded") { folder = ""; }
      listFiles();
    };
    const listFiles = (): void => {
      const exts = filters[filterIx].exts; let names: string[] = [];
      if (place === "embedded") names = o.embedded.slice();
      else if (place === "project") names = o.projectFiles.filter((p) => p.split("/").slice(0, -1).join("/") === folder).map((p) => p.split("/").pop() || "");
      else if (folder) {
        const items = modelLibItems(folder, () => { if (place === "lib") listFiles(); });
        if (items === undefined) { files.setRows([{ name: "Loading..." }]); return; }
        names = items ? [...items].map((n) => n + ".step") : [];
      }
      const shown = names.filter((n) => M.matchesFilter(n, exts) && wild(n, fileFilter.value)).sort((a, b) => a.localeCompare(b));
      files.setRows(shown.map((n) => ({ name: n })));
      const at = shown.indexOf(file); if (at >= 0) { files.select(at); scrollSel(files.el); }
    };
    const scrollSel = (el: HTMLElement): void => { const tr = el.querySelector("tr.sel") as HTMLElement | null; if (tr) tr.scrollIntoView({ block: "nearest" }); };
    const pathOf = (name: string): string | null => {
      if (!name) return null;
      if (place === "embedded") return o.embedded.includes(name) ? M.EMBED_PREFIX + name : null;
      if (place === "project") return "${KIPRJMOD}/" + (folder ? folder + "/" : "") + name;
      return folder ? "${" + M.MODEL_DIR_VAR + "}/" + folder + ".3dshapes/" + name : null;
    };
    const showPreview = (): void => {
      const p = pathOf(file); if (!p) return;
      prev.update(M.previewBoardText(null, [{ file: p, show: true, opacity: 1, offset: [0, 0, 0], scale: [1, 1, 1], rotate: [0, 0, 0] }], 1.6, [-15, -15, 15, 15]));
    };
    lookIn.addEventListener("change", () => { place = places[(lookIn as unknown as HTMLSelectElement).selectedIndex][0]; folder = ""; file = ""; nameIn.value = ""; folderFilter.value = ""; fileFilter.value = ""; listFolders(); });
    folderFilter.addEventListener("input", listFolders); fileFilter.addEventListener("input", listFiles);
    typeSel.addEventListener("change", () => { filterIx = (typeSel as unknown as HTMLSelectElement).selectedIndex; listFiles(); });
    nameIn.value = file;
    const accept = (): boolean => {
      const name = nameIn.value.trim(); const p = pathOf(name);
      if (!p) { messageBox("Select 3D Model", name ? `${name}\nFile not found.\nCheck the file name and try again.` : "Select a file.", [{ label: "OK" }]); return false; }
      store.set(LAST_DIR, place === "project" ? "${KIPRJMOD}/" + folder : place === "lib" && folder ? "${" + M.MODEL_DIR_VAR + "}/" + folder + ".3dshapes" : "");
      finish(p); return true;
    };
    let api: DialogApi | null = null;
    api = openDialog({ title: "Select 3D Model", width: 1000, child: true, okLabel: "Open", noEnter: true,
      build(body) {
        body.append(h("div", { class: "pd-row", style: "margin-bottom:6px" }, h("span", { class: "pd-lbl" }, "Look in:"), lookIn),
          h("div", { style: "display:grid;grid-template-columns:1fr 1.3fr 300px;gap:8px;min-height:340px" }, folderBox,
            h("div", { style: "display:flex;flex-direction:column;gap:4px;min-width:0" }, fileFilter, files.el),
            h("div", { style: "display:flex;flex-direction:column;gap:4px;min-width:0" }, h("span", { class: "pd-lbl" }, "Preview"), h("div", { style: "flex:1;min-height:300px;border:1px solid var(--line)" }, prev.el))),
          h("div", { class: "pd-row", style: "margin-top:8px" }, h("span", { class: "pd-lbl", style: "width:90px" }, "File name:"), nameIn),
          h("div", { class: "pd-row", style: "margin-top:4px" }, h("span", { class: "pd-lbl", style: "width:90px" }, "Files of type:"), typeSel));
        files.el.addEventListener("dblclick", () => { if (accept() && api) api.close(); });
        nameIn.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); if (accept() && api) api.close(); } });
        whenGone(body, () => finish(null));
        listFolders();
        if (place === "lib") void modelLibraries().then((l) => { libs = l; if (place === "lib") listFolders(); });
        if (file) showPreview();
        setTimeout(() => (place === "embedded" ? fileFilter : folderFilter).focus(), 0);
      },
      ok() { return accept(); },
      cancel() { finish(null); return true; } });
    if (!api) finish(null);
  });
}

/** Lengths in the editor's units for an Offset field (m_userUnits), with KiCad's offset steps. */
export function offsetField(mm: number, key: string, ro: boolean, units: () => string): { field: Field<number>; el: HTMLElement } {
  const f = lenField(mm, { ro, key });
  return { field: f, el: stepper(f, (v, s, fine) => M.stepOffset(v, s, fine, units())) };
}

// ---------------------------------------------------------------- the 3D Models tab
export interface Models3dOpts {
  ro: boolean;
  /** the footprint's models (FOOTPRINT::Models) */
  models: M.PreviewModel[] | Any[];
  /** the project's 3D model files (project-relative paths), for the picker and the status column */
  projectModels?(): string[];
  /** the footprint's embedded file names (PANEL_EMBEDDED_FILES), for the picker and the status column */
  embedded(): string[];
  /** the footprint in library form (at the origin, front side, unrotated), for the preview's dummy board */
  footprintText?(): string;
  previewKey: string;
  /** the footprint's extruded 3D body ((model (type extruded) …)), null for none */
  extruded?: FpExtruded | null;
  /** the frame's board thickness, the dummy board's starting thickness (panel_preview_3d_model.cpp: SetBoardThickness) */
  thickness?: number;
  /** the footprint's library and name (its library link): adds Use Closest Library Model */
  footprintId?(): { lib: string; name: string };
}
/** EXTRUDED_3D_BODY: layer "auto" (UNDEFINED_LAYER), "pad_bbox" (UNSELECTED_LAYER) or a layer name; color null = unspecified */
export interface FpExtruded { show: boolean; height: number; standoff: number; layer: string; material: "plastic" | "matte" | "metal" | "copper"; color: number[] | null }
/** m_extrusionLayers: UNDEFINED_LAYER, F_CrtYd, F_Fab, F_SilkS, UNSELECTED_LAYER */
const EXTRUSION_LAYERS: [string, string][] = [["auto", "Auto"], ["F.CrtYd", "Courtyard layer"], ["F.Fab", "Fabrication layer"], ["F.SilkS", "Silkscreen layer"], ["pad_bbox", "Pin bounding box"]];
const MATERIALS: [string, string][] = [["plastic", "Plastic"], ["matte", "Matte"], ["metal", "Metal"], ["copper", "Copper"]];
interface FpModelsApi { extrudedText(e: FpExtruded): string }
const extrudedSexpr = (e: FpExtruded | null): string => { const PT = (window as unknown as { PcbTools?: { fpModels?: FpModelsApi } }).PcbTools; return e && PT && PT.fpModels ? PT.fpModels.extrudedText(e) : ""; };
/**
 * PANEL_FP_PROPERTIES_3D_MODEL with its PANEL_PREVIEW_3D_MODEL: the model grid (status, file with its picker, Show),
 * add / browse / remove, the configured path choice, Configure Paths..., the Scale / Rotation / Offset / Opacity of the
 * selected model and the live preview.  Both DIALOG_FOOTPRINT_PROPERTIES (board) and the footprint editor's dialog use it.
 */
export function models3dPanel(o: Models3dOpts): { build(el: HTMLElement): void; models(): Any[]; extruded(): FpExtruded | null; validate(): string | null; dispose(): void } {
  const ro = o.ro;
  const host = { projectModels: o.projectModels, footprintText: o.footprintText };
  const models = o.models.map((x: Any) => ({ ...x, offset: x.offset.slice(), scale: x.scale.slice(), rotate: x.rotate.slice() }));
  const modelRows: Record<string, CellValue>[] = models.map((x: Any, i: number) => ({ i, file: x.file, show: x.show }));
  let modelSel = -1;
  const mf: Record<string, Field<number>> = {};
  for (const k of ["sx", "sy", "sz"]) mf[k] = numField(1, { ro, key: "model-" + k, digits: 4 });
  for (const k of ["rx", "ry", "rz"]) mf[k] = numField(0, { ro, key: "model-" + k, digits: 2 });
  for (const k of ["ox", "oy", "oz"]) mf[k] = lenField(0, { ro, key: "model-" + k });   // m_userUnits (PANEL_PREVIEW_3D_MODEL::formatOffsetValue)
  // the slider starts at KiCad's layout default of 50 until a model is selected
  const opacity = h("input", { type: "range", min: "0", max: "100", value: "50", disabled: ro, "data-k": "model-opacity", style: "width:100%" }) as HTMLInputElement;
  const fpEmbedded = o.embedded;
  const modelEnv = (): M.ModelEnv => ({ projectFiles: host.projectModels ? host.projectModels() : [], embedded: fpEmbedded(), libItems: (lib) => modelLibItems(lib, () => modelGrid.refresh()) });
  const saveModel = (): void => {
    const x = models[modelSel]; if (!x) return;
    x.scale = [mf.sx.get(), mf.sy.get(), mf.sz.get()]; x.rotate = [mf.rx.get(), mf.ry.get(), mf.rz.get()]; x.offset = [mf.ox.get(), mf.oy.get(), mf.oz.get()]; x.opacity = Number(opacity.value) / 100;
  };
  // the Extruded 3D Body box (PANEL_FP_PROPERTIES_3D_MODEL's m_extrusionSizer)
  const ex = o.extruded || null;
  const exEnable = checkField(!!ex, "Enable", { ro, key: "enableExtrusion", tip: "Enable extruded 3D model for this footprint" });
  const exShow = checkField(ex ? ex.show : true, "Show", { ro, key: "showExtrusion", tip: "Show extruded 3D model" });
  const exHeight = lenField(ex ? ex.height : NaN, { ro, key: "componentHeight", allowEmpty: true }), exStandoff = lenField(ex ? ex.standoff : NaN, { ro, key: "standoffHeight", allowEmpty: true });
  const exLayer = selectField<string>(ex ? ex.layer : "auto", EXTRUSION_LAYERS, { ro, key: "extrusionLayer" });
  const exMaterial = selectField<string>(ex ? ex.material : "plastic", MATERIALS, { ro, key: "extrusionMaterial" });
  let exColor: number[] | null = ex ? ex.color : null;
  const extruded = (): FpExtruded | null => (exEnable.get() ? { show: exShow.get(), height: exHeight.get(), standoff: isFinite(exStandoff.get()) ? exStandoff.get() : 0, layer: exLayer.get(), material: exMaterial.get() as FpExtruded["material"], color: exColor } : null);
  let preview: ReturnType<typeof modelPreview> | null = null;
  const updatePreview = (): void => {   // UpdateDummyFootprint
    if (!preview || !host.footprintText) return;
    saveModel();
    preview.update(M.previewBoardText(host.footprintText(), models.filter((x: Any) => x.file).map((x: Any) => ({ file: x.file, show: x.show, opacity: x.opacity, offset: x.offset, scale: x.scale, rotate: x.rotate })), preview.thickness(), undefined, extrudedSexpr(extruded())));
  };
  const showModel = (i: number): void => {
    saveModel(); modelSel = i; const x = models[i];
    const vals = x ? [...x.scale, ...x.rotate, ...x.offset] : [1, 1, 1, 0, 0, 0, 0, 0, 0];
    ["sx", "sy", "sz", "rx", "ry", "rz", "ox", "oy", "oz"].forEach((k, j) => mf[k].set(vals[j]));
    opacity.value = String(Math.round((x ? x.opacity : 0.5) * 100));
  };
  const status = (r: Record<string, CellValue>): { icon: string; title: string } | null => {
    const p = M.modelProblem(String(r.file || ""), modelEnv());
    return p && p.icon ? { icon: p.icon === "warning" ? "ercwarn" : "ercerr", title: p.text } : null;
  };
  const repick = (r: Record<string, CellValue>, _i: number, set: (v: string) => void): void => {
    void pick3DModel({ current: String(r.file || ""), start: pathChoice.get(), projectFiles: host.projectModels ? host.projectModels() : [], embedded: fpEmbedded() }).then((p) => { if (p) { set(p); syncModels(); modelGrid.refresh(); updatePreview(); } });
  };
  const modelGrid = grid([{ label: "", key: "status", type: "icon", width: "22px", icon: status }, { label: "3D Model(s)", key: "file", button: { icon: "small_refresh", title: "Select 3D Model", run: repick } },
    { label: "Show", key: "show", type: "check", width: "48px" }], modelRows, { ro, height: "150px", key: "models3d", onSelect: (i) => showModel(i), onChange: () => { syncModels(); modelGrid.refresh(); updatePreview(); } });
  const syncModels = (): void => {   // the grid's file / show cells and row order back into the model list
    saveModel();
    const next = modelGrid.rows().map((r) => { const x = typeof r.i === "number" && models[r.i as number] ? models[r.i as number] : { file: "", show: true, opacity: 1, offset: [0, 0, 0], scale: [1, 1, 1], rotate: [0, 0, 0] }; return { ...x, file: String(r.file || ""), show: !!r.show }; });
    models.splice(0, models.length, ...next); modelGrid.rows().forEach((r, i) => { r.i = i; });
  };
  // the configured path choice: the folder the picker opens on (updateConfiguredPathChoices)
  const pathChoice = selectField<string>("Automatic", M.configuredPathChoices().map((c): [string, string] => [c, c]), { ro, key: "configuredPath" });
  pathChoice.input.title = "Choose the folder used when opening the 3D model picker";

  const build = (el: HTMLElement): void => {
    const unitSpan = (k: string) => unitLabel(k === "deg" ? "" : k);
    // the Scale / Rotation / Offset boxes, each field with its wxSpinButton and mouse-wheel steps
    const units = (): string => currentUnits();
    const spin = (k: string): HTMLElement => stepper(mf[k], k[0] === "s" ? M.stepScale : k[0] === "r" ? M.stepRotation : (v, sg, fine) => M.stepOffset(v, sg, fine, units()), updatePreview);
    const xyz = (label: string, a: string, b: string, c: string, unit: string) => box(label, form([["X:", spin(a), unitSpan(unit)], ["Y:", spin(b), unitSpan(unit)], ["Z:", spin(c), unitSpan(unit)]]));
    // OnAdd3DModel: the picker, then a new row with the picked file
    const browse = (): void => {
      void pick3DModel({ start: pathChoice.get(), projectFiles: host.projectModels ? host.projectModels() : [], embedded: fpEmbedded() }).then((p) => {
        if (!p) return;
        modelGrid.rows().push({ i: -1, file: p, show: true }); modelGrid.refresh(); syncModels(); modelGrid.select(modelGrid.rows().length - 1); updatePreview();
      });
    };
    const bar = gridButtons(modelGrid, () => ({ i: -1, file: "", show: true }), { ro, addTip: "Add 3D model", delTip: "Remove 3D model", onChange: () => { syncModels(); modelGrid.refresh(); updatePreview(); } });
    // m_button3DShapeAdd, m_button3DShapeBrowse, a 20 px gap, m_button3DShapeRemove (panel_fp_properties_3d_model_base.cpp)
    const [addB, delB] = [bar.firstElementChild as HTMLElement, bar.lastElementChild as HTMLElement];
    const browseB = iconButton("folder", "Select 3D Model", browse, ro); browseB.setAttribute("data-k", "browse3d");
    bar.replaceChildren(addB, browseB, h("span", { style: "width:20px" }), delB);
    // Not in KiCad: the model KiCad's 3D library holds that comes closest to the selected row's file (or, with no
    // row, to the footprint's own name), for a part whose own model is not in the library.
    let closest: HTMLButtonElement | null = null;
    if (o.footprintId) {
      const fpId = o.footprintId;
      const b = h("button", { type: "button", class: "kbtn", disabled: ro, "data-k": "model-closest", title: "Find the model in KiCad's 3D library that comes closest to this footprint and use it" }, "Use Closest Library Model") as HTMLButtonElement;
      b.addEventListener("click", () => {
        syncModels();
        const cur = modelSel >= 0 && models[modelSel] ? String(models[modelSel].file || "") : "";
        const named = /([^/\\]+)\.3dshapes[/\\]([^/\\]+?)\.(?:step|stp|wrl|wrz)$/i.exec(cur);
        const own = fpId(); const lib = named ? named[1] : own.lib, item = named ? named[2] : own.name;
        if (!lib || !item) { errorMessage("The footprint has no library and name to look a model up by."); return; }
        b.disabled = true;
        fetch(`/api/kicad-lib/model-match?lib=${encodeURIComponent(lib)}&name=${encodeURIComponent(item)}`, { credentials: "same-origin" })
          .then((r) => (r.ok ? r.json() : r.status === 404 ? null : Promise.reject(new Error(String(r.status)))))
          .then((hit: { library?: string; name?: string } | null) => {
            if (!hit || !hit.library || !hit.name) { errorMessage(`KiCad's 3D library has no model close to ${lib}:${item}.`); return; }
            const file = "${KICAD10_3DMODEL_DIR}/" + hit.library + ".3dshapes/" + hit.name + ".step";
            const rows = modelGrid.rows();
            if (modelSel >= 0 && rows[modelSel]) rows[modelSel].file = file; else rows.push({ i: -1, file, show: true });
            modelGrid.refresh(); modelGrid.select(modelSel >= 0 ? modelSel : rows.length - 1); syncModels(); updatePreview();
          })
          .catch(() => errorMessage("The 3D library could not be reached. Try again in a moment."))
          .finally(() => { b.disabled = ro; });
      });
      closest = b;
    }
    const cfg = h("button", { type: "button", class: "kbtn", "data-k": "configure3dPaths" }, "Configure Paths...");
    cfg.addEventListener("click", () => { void import("../../dialogs/configure-paths").then((x) => x.configurePaths(() => updatePreview())); });
    preview = modelPreview({ buttons: true, reload: updatePreview, key: o.previewKey, thickness: o.thickness });
    // Extruded 3D Body: Enable / Show, Overall height / Standoff height, Extrusion source / Material with its colour
    const swatch = h("button", { type: "button", class: "pd-iconbtn", title: "Color of the extruded body. Overrides the material default.", "data-k": "extrusionColor", disabled: ro }, h("span", { class: "pd-swatch" })) as HTMLButtonElement;
    const paint = (): void => { const sp = swatch.firstChild as HTMLElement; sp.style.background = exColor ? `rgba(${Math.round(exColor[0] * 255)},${Math.round(exColor[1] * 255)},${Math.round(exColor[2] * 255)},${exColor[3]})` : "transparent"; };
    swatch.addEventListener("click", () => {
      const cur: RGBA | null = exColor ? { r: exColor[0], g: exColor[1], b: exColor[2], a: exColor[3] } : null;
      colorPicker(cur, true, (c) => { exColor = [c.r, c.g, c.b, c.a]; paint(); updatePreview(); });
    });
    paint();
    const exportBtn = h("button", { type: "button", class: "btn", title: "Export generated 3D model", "data-k": "exportExtruded", disabled: true }, "Export...") as HTMLButtonElement;
    const exSync = (): void => { const on = exEnable.get() && !ro; for (const c of [exShow.input, exHeight.input, exStandoff.input, exLayer.input, exMaterial.input]) (c as HTMLElement & { disabled: boolean }).disabled = !on; swatch.disabled = !on; };   // updateExtrusionControls
    exEnable.input.addEventListener("change", () => { exSync(); updatePreview(); });
    for (const c of [exShow.input, exHeight.input, exStandoff.input, exLayer.input, exMaterial.input]) c.addEventListener("change", updatePreview);
    exSync();
    const extrusionBox = box("Extruded 3D Body", h("div", { class: "pd-row" }, exEnable.el, exShow.el),
      h("div", { style: "display:grid;grid-template-columns:auto auto auto;gap:4px 24px;align-items:center" },
        form([["Overall height:", exHeight.el, unitLabel()], ["Standoff height:", exStandoff.el, unitLabel()]]),
        form([["Extrusion source:", exLayer.el], ["Material:", h("span", { class: "pd-inline", style: "gap:6px" }, exMaterial.el, swatch)]], true),
        exportBtn));
    ["sx", "sy", "sz", "rx", "ry", "rz", "ox", "oy", "oz"].forEach((k) => mf[k].input.addEventListener("change", updatePreview));
    opacity.addEventListener("input", updatePreview);
    el.append(modelGrid.el, h("div", { class: "pd-row", style: "margin:2px 0 6px" }, bar, ...(closest ? [closest] : []), h("span", { style: "flex:1" }), pathChoice.el, cfg), extrusionBox,
      h("div", { style: "display:flex;gap:8px;min-height:340px" },
        h("div", { style: "flex:none;width:220px;display:flex;flex-direction:column" }, xyz("Scale", "sx", "sy", "sz", ""), xyz("Rotation", "rx", "ry", "rz", "deg"), xyz("Offset", "ox", "oy", "oz", unitName()), box("Opacity", opacity)),
        h("div", { style: "flex:1;min-width:0;display:flex;flex-direction:column" }, h("div", { class: "pd-lbl", style: "padding:4px 0" }, "Preview"), h("div", { style: "flex:1;min-height:300px;display:flex" }, preview.el))));
    if (models.length) { modelGrid.select(0); }
    updatePreview();
  };
  return { build, models: () => { syncModels(); return models.filter((x: Any) => x.file); }, extruded,
    // PANEL_FP_PROPERTIES_3D_MODEL::Validate
    validate: () => {
      if (!exEnable.get()) return null;
      const hgt = exHeight.get(), so = exStandoff.get();
      if (!isFinite(hgt) || hgt <= 0) return "Component height must be greater than zero.";
      if (isFinite(so) && so >= hgt) return "Standoff height must be less than the overall height.";
      return null;
    },
    dispose: () => { if (preview) preview.dispose(); } };
}
