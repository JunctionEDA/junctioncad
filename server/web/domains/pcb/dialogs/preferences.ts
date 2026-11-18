// dialogs/preferences.ts — Preferences → Preferences… (Ctrl+,) in both editors: KiCad's paged dialog with the panels
// that mean something in a browser.  Common > Mouse and Touchpad (common/dialogs/panel_mouse_settings), Hotkeys
// (panel_hotkeys_editor, read-only here); Schematic Editor > Display Options, Grids, Editing Options, Colors;
// PCB Editor > Display Options, Grids, Origins & Axes, Editing Options.  Everything is kept in localStorage (prefs.ts) and applied on OK.
import { trapTab } from "../tools/kicad-dialogs/shell";
import { E, isSch, requestRender, setToggles, store, toast } from "./editor";
import { colorPicker, fromHex, toHex } from "../editor/pcbdialogs/color-picker";
import { IS_MAC, keyName, modName } from "../../../shared/keys";
import { hotkeysPanel } from "./hotkeys-panel";
import type { UserHotkeys } from "../menuspec";
import { KD, checkbox, h, popupMenu, promptText, select, textInput } from "./dom";
import { SCH_COLOR_ITEMS, hiddenByBackground, newUserTheme, schExtraColors, sameColor, themeNameError, type UserSchTheme } from "./color-themes";
import { colorSwatch, colorText, parseColor, type RGBA } from "../../../shared/components/colorswatch";
import { lenField, messageBox } from "../editor/pcbdialogs/ui";
import { loadUnits, messageText, unitName } from "../../../shared/units";
import { DEFAULT_PREFS, SIM_MOUSE_DEFAULTS, SIM_TRACKPAD_DEFAULTS, schThemeList, GRID_MIN_SPACING_RANGE, GRID_THICKNESS_CHOICES, clonePrefs, editorId, gridLabel, savePrefs, scaleOf, type EditorId, type GalPrefs, type Prefs, type SimWheel } from "./prefs";
import { clearDialogState, clearDontShowAgain, clearFileHistory, resetProgramSettings } from "./maintenance";
import { askConfirm } from "../../../shared/components/msgbox";
import type { Units } from "../../../shared/store";
import { getThemeMode, setThemeMode, type ThemeMode } from "../../../shared/theme";
import { getInactiveMode, setInactiveMode } from "../editor/panels/appearance";
import { wakatimePage, type WakaPage } from "./wakatime";
import { cleanFieldTemplates, fieldTemplatesPage, symColorsPage, symDisplayPage, symEditingPage } from "./preferences-sym";
import { assignScrollMod, type ScrollMod } from "../editor/wheel-model";
import { bitmapButton, kicadIcon } from "../../../shared/components/kicon-dom";

const MIL = 0.0254;


const units = (): Units => (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units;
/** A length typed in a grid field: a number in the user units, or with its own unit ("25 mil", "0.5mm", "0.1 in"). */
function parseUserLen(text: string): number | null {
  const m = /^\s*([0-9]*[.,]?[0-9]+)\s*(mm|mils?|in|"|th)?\s*$/i.exec(text); if (!m) return null;
  const v = parseFloat(m[1].replace(",", ".")), u = (m[2] || units()).toLowerCase();
  return u === "mm" ? v : u === "in" || u === '"' ? v * 25.4 : v * MIL;
}
/**
 * DIALOG_GRID_SETTINGS ("Grid Settings"): Name (optional), X and Y in the user units, Linked.  It opens over the
 * Preferences dialog; OK checks the range (0.001 to 1000 mm).  The web editor's grids are square, so Y follows X.
 */
export function gridSettingsDialog(grid: { mm: number; name: string } | null, ed: EditorId): Promise<{ mm: number; name: string } | null> {
  return new Promise((resolve) => {
    const u = units(), show = (mm: number): string => messageText(mm, u, scaleOf(ed), false).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    const name = h("input", { type: "text", id: "kd-grid-name", value: grid ? grid.name : "" });
    const x = h("input", { type: "text", id: "kd-grid-x", value: grid ? show(grid.mm) : "" }), y = h("input", { type: "text", id: "kd-grid-y", value: grid ? show(grid.mm) : "", disabled: true });
    const linked = h("input", { type: "checkbox", id: "kd-grid-linked", checked: true, disabled: true });
    x.addEventListener("input", () => { y.value = x.value; });
    const unit = (): HTMLElement => h("span", { class: "ro" }, u === "mil" ? "mils" : u);
    const body = h("div", { class: "kd-body" }, h("div", { class: "kv", style: "grid-template-columns:max-content 1fr max-content;align-items:center" },
      h("label", { for: "kd-grid-name" }, "Name:"), name, h("span", { class: "ro" }, "(optional)"),
      h("label", { for: "kd-grid-x" }, "X:"), x, unit(),
      h("span"), h("label", { class: "kd-chk", title: "The web editor's grids are square: Y is always X" }, linked, "Linked"), h("span"),
      h("label", { for: "kd-grid-y" }, "Y:"), y, unit()));
    const done = (ok: boolean): void => {
      if (!ok) { ov.remove(); resolve(null); return; }
      const mm = parseUserLen(x.value);
      if (mm === null || mm < 0.001 || mm > 1000) { messageBox("Error", "Grid size X out of range."); x.focus(); return; }
      ov.remove(); resolve({ mm: +mm.toFixed(6), name: name.value.trim() });
    };
    const okB = h("button", { class: "btn primary", type: "button", onclick: () => done(true) }, "OK"), cancel = h("button", { class: "btn", type: "button", onclick: () => done(false) }, "Cancel");
    const dlg = h("div", { class: "kd-dialog", role: "dialog", "aria-label": "Grid Settings", style: "width:360px;min-width:0" }, h("div", { class: "kd-title" }, h("span", null, "Grid Settings")), body, h("div", { class: "kd-foot" }, cancel, okB));
    const ov = h("div", { class: "kd-overlay kd-prompt", style: "z-index:70" }, dlg);
    ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Tab") trapTab(ev, ov); if (ev.key === "Enter") { ev.preventDefault(); done(true); } else if (ev.key === "Escape") { ev.preventDefault(); done(false); } });
    document.body.append(ov); name.focus();
  });
}

/** pcb-tools.js's arc editing mode (APP_SETTINGS m_ArcEditMode, also switched from the Arc toolbar group and Ctrl+Space). */
type ArcEditTools = { arcEditMode(): number; setArcEditMode(m: number): void; angleSnapMode?(): string; setAngleSnap?(ctx: null, mode: string): string };
/** The board's curved ratsnest flag (PCB_DISPLAY_OPTIONS m_DisplayRatsnestLinesCurved, also View > Curved Ratsnest Lines). */
const ratsnestState = (): { curvedRatsnest: boolean; setCurvedRatsnest(on: boolean): void } | null => { const k = (window as unknown as { KiCadCanvas?: { pcbSizes?: { state?: { curvedRatsnest: boolean; setCurvedRatsnest(on: boolean): void } } } }).KiCadCanvas; return (k && k.pcbSizes && k.pcbSizes.state) || null; };
const pcbTools = (): ArcEditTools | null => { const t = (window as unknown as { PcbTools?: Partial<ArcEditTools> }).PcbTools; return t && t.arcEditMode && t.setArcEditMode ? (t as ArcEditTools) : null; };

/** The edits of an open Preferences dialog, kept when a page is reset (the dialog is rebuilt around them). */
interface Staged { view?: SchView; p: Prefs; uiMode: ThemeMode; arcEdit: number; hv45?: boolean; curved?: boolean; contrast: ReturnType<typeof getInactiveMode>; hotkeys?: UserHotkeys }
/** PAGED_DIALOG's g_lastPage: the page the dialog was last closed on, for the next opening in this session. */
let lastPage: string | null = null;
/** The defaults a page's Reset to Defaults puts back (RESETTABLE_PANEL::ResetPanel of that page only). */
export function resetPage(key: string, st: Staged): void {
  const d = JSON.parse(JSON.stringify(DEFAULT_PREFS)) as Prefs;
  switch (key) {
    case "Common/Common": st.uiMode = "system"; st.p.common = d.common; break;
    case "Common/Mouse and Touchpad": st.p.mouse = d.mouse; break;
    case "Symbol Editor/Grids": st.p.grids.sym = d.grids.sym; break;
    case "Symbol Editor/Display Options": st.p.symDisplay = d.symDisplay; st.p.gal.sym = d.gal.sym; break;
    case "Symbol Editor/Editing Options": st.p.symEditing = d.symEditing; break;
    case "Symbol Editor/Colors": st.p.symColors = d.symColors; break;
    case "Schematic Editor/Field Name Templates": st.p.schFieldNames = d.schFieldNames; break;
    case "Schematic Editor/Display Options": st.p.schDisplay = d.schDisplay; st.p.gal.sch = d.gal.sch; st.view = Object.assign({}, SCH_VIEW_DEFAULTS); break;
    case "Schematic Editor/Simulator": st.p.sim = d.sim; break;
    case "Schematic Editor/Grids": st.p.grids.sch = d.grids.sch; break;
    case "Schematic Editor/Editing Options": st.p.schEditing = d.schEditing; break;
    case "Schematic Editor/Colors": st.p.schColors = { ...d.schColors, user: st.p.schColors.user }; break;
    case "Footprint Editor/Display Options": st.p.gal.fp = d.gal.fp; break;
    case "Footprint Editor/Grids": st.p.grids.fp = d.grids.fp; break;
    case "Footprint Editor/Editing Options": st.p.fpEditing = d.fpEditing; break;
    case "PCB Editor/Display Options": st.p.pcbDisplay = { ...d.pcbDisplay, showPageLimits: st.p.pcbDisplay.showPageLimits }; st.p.gal.pcb = d.gal.pcb; break;
    case "PCB Editor/Grids": st.p.grids.pcb = d.grids.pcb; break;
    case "PCB Editor/Origins & Axes": st.p.pcbOrigin = d.pcbOrigin; break;
    case "PCB Editor/Editing Options": st.p.pcbEditing = d.pcbEditing; st.p.pcbDisplay.showPageLimits = d.pcbDisplay.showPageLimits; st.arcEdit = 0; st.hv45 = true; st.curved = false; break;
    default: break;
  }
}

/** Preferences…; `page` is a page label or "Section/Page" ("PCB Editor/Grids"); without one, the page last used. */
export function openPreferences(page?: string, staged?: Staged): void {
  const p: Prefs = staged ? staged.p : clonePrefs();
  let uiMode: ThemeMode = staged ? staged.uiMode : getThemeMode();
  // the schematic's View options (EESCHEMA_SETTINGS appearance): the same settings as View > Show …, live in the render options
  const view: SchView = staged && staged.view ? staged.view : schViewNow();
  let arcEdit = staged ? staged.arcEdit : pcbTools() ? pcbTools()!.arcEditMode() : 0;
  // m_AngleSnapMode != LEADER_MODE::DIRECT, and the curved ratsnest: the board tools' live state, written back on OK when changed
  const snap0 = pcbTools() && pcbTools()!.angleSnapMode ? pcbTools()!.angleSnapMode!() : "45";
  let hv45 = staged && staged.hv45 !== undefined ? staged.hv45 : snap0 !== "free";
  const curved0 = !!(ratsnestState() && ratsnestState()!.curvedRatsnest);
  let curved = staged && staged.curved !== undefined ? staged.curved : curved0;
  // the inactive layer mode is the open board's project setting (.kicad_prl "board.high_contrast_mode"), not a user preference
  let contrast = staged ? staged.contrast : getInactiveMode();
  let waka: WakaPage | null = null;
  // PANEL_PCBNEW_ACTION_PLUGINS: the plugin actions in the person's order, saved to their account on OK
  const plug = (window as unknown as { KcPlugins?: PluginHost }).KcPlugins;
  const plugRows0: PluginRow[] = plug ? plug.actionPluginRows("pcb") : [];
  const plugRows: PluginRow[] = plugRows0.map((r) => Object.assign({}, r));
  let hk: ReturnType<typeof hotkeysPanel> | null = null, body0: HTMLElement | null = null;
  const pageKey = (): string => { const n = body0 && body0.querySelector<HTMLElement>(".kd-tb-node.child.on"); return (n && n.dataset.page) || ""; };
  // the frame it was opened from: its grid list's selection is the grid in use (the Symbol Editor keeps its own)
  const here: EditorId | null = document.getElementById("symedit") ? null : E.kdoc ? editorId() : null;
  // PANEL_GRID_SETTINGS: the grid list (its selection is the current grid, grid.last_size), Add / Edit / Move / Remove
  // through DIALOG_GRID_SETTINGS, the fast grids, the overrides and the axes.  Every list shows the grids as
  // GRID_MENU::BuildChoiceList does, in the user units with the other system in brackets.
  const gridsPage = (ed: EditorId) => (pg: HTMLElement) => {
    const g = p.grids[ed], o = g.overrides, pre = `kd-pref-${ed}`;
    g.names = g.sizes.map((_, i) => (g.names && g.names[i]) || "");
    if (ed === here) { const at = g.sizes.findIndex((mm) => Math.abs(mm - E.gridPitch) < 1e-9); if (at >= 0) g.last = at; }
    const cols = h("div", { style: "display:grid;grid-template-columns:260px 1fr;gap:20px" }), L = h("div"), R = h("div"); cols.append(L, R); pg.append(cols);
    const list = h("k-select", { size: 12, id: `${pre}-gridlist`, style: "width:100%;height:230px" });
    const text = (i: number): string => gridLabel({ mm: g.sizes[i], name: g.names![i] }, ed);
    const choices = () => g.sizes.map((_, i) => [String(i), text(i)] as [string, string]);
    const fast1 = select(choices(), String(g.fast1), (v) => { g.fast1 = +v; }, { id: `${pre}-fast1` }), fast2 = select(choices(), String(g.fast2), (v) => { g.fast2 = +v; }, { id: `${pre}-fast2` });
    const ovSel: Record<string, HTMLSelectElement> = {};
    const fill = (sel?: number) => {
      const cur = sel ?? Math.max(0, Math.min(g.sizes.length - 1, g.last ?? 0));
      list.replaceChildren(...g.sizes.map((_, i) => h("option", { value: String(i) }, text(i)))); list.selectedIndex = cur; g.last = cur;
      for (const [sel2, idx] of [[fast1, g.fast1], [fast2, g.fast2]] as [HTMLSelectElement, number][]) { sel2.replaceChildren(...choices().map(([v, l]) => h("option", { value: v }, l))); sel2.value = String(Math.max(0, Math.min(idx, g.sizes.length - 1))); }
      for (const [k, s2] of Object.entries(ovSel)) { const mm = (o as unknown as Record<string, number>)[k + "Mm"]; const at = g.sizes.findIndex((x) => Math.abs(x - mm) < 1e-6); s2.replaceChildren(...g.sizes.map((x, i) => h("option", { value: String(x) }, text(i)))); s2.value = String(g.sizes[at >= 0 ? at : 0]); (o as unknown as Record<string, number>)[k + "Mm"] = g.sizes[at >= 0 ? at : 0]; }
    };
    list.addEventListener("change", () => { g.last = list.selectedIndex; });
    const exists = (mm: number, skip: number): boolean => g.sizes.some((x, i) => i !== skip && Math.abs(x - mm) < 1e-6);
    const dup = (mm: number): void => { messageBox("Error", `Grid size '${messageText(mm, units(), scaleOf(ed))}' already exists.`); };
    const add = (): void => { void gridSettingsDialog(null, ed).then((r) => { if (!r) return; if (exists(r.mm, -1)) { dup(r.mm); return; }
      const row = list.selectedIndex < 0 ? g.sizes.length : list.selectedIndex; g.sizes.splice(row, 0, r.mm); g.names!.splice(row, 0, r.name);
      if (g.fast1 >= row) g.fast1++; if (g.fast2 >= row) g.fast2++; fill(row); }); };
    const edit = (): void => { const row = list.selectedIndex; if (row < 0) return;
      void gridSettingsDialog({ mm: g.sizes[row], name: g.names![row] }, ed).then((r) => { if (!r) return; if (exists(r.mm, row)) { dup(r.mm); return; } g.sizes[row] = r.mm; g.names![row] = r.name; fill(row); }); };
    const swap = (i: number, j: number): void => { [g.sizes[i], g.sizes[j]] = [g.sizes[j], g.sizes[i]]; [g.names![i], g.names![j]] = [g.names![j], g.names![i]]; };
    list.addEventListener("dblclick", edit);
    // PANEL_GRID_SETTINGS' STD_BITMAP_BUTTONs: small_plus, edit, small_up, small_down, then small_trash apart
    L.append(h("div", { style: "font-weight:600;margin-bottom:6px" }, "Grids"), list, h("div", { class: "kd-grid-btns", style: "display:flex;gap:5px;margin-top:6px" },
      bitmapButton("small_plus", "Add", add, { id: `${pre}-gridadd` }),
      bitmapButton("edit", "Edit", edit, { id: `${pre}-gridedit` }),
      bitmapButton("small_up", "Move up", () => { const i = list.selectedIndex; if (i > 0) { swap(i - 1, i); fill(i - 1); } }, { id: `${pre}-gridup` }),
      bitmapButton("small_down", "Move down", () => { const i = list.selectedIndex; if (i >= 0 && i < g.sizes.length - 1) { swap(i + 1, i); fill(i + 1); } }, { id: `${pre}-griddown` }),
      h("span", { style: "flex:1" }),
      bitmapButton("small_trash", "Remove", () => { const i = list.selectedIndex; if (i < 0 || g.sizes.length <= 1) return; g.sizes.splice(i, 1); g.names!.splice(i, 1);
        g.fast1 = Math.min(g.fast1 > i ? g.fast1 - 1 : g.fast1, g.sizes.length - 1); g.fast2 = Math.min(g.fast2 > i ? g.fast2 - 1 : g.fast2, g.sizes.length - 1); fill(i !== 0 ? i - 1 : 0); }, { id: `${pre}-griddel` })));
    const fb = KD().staticBox(R, "Fast Grid Switching");
    fb.append(h("div", { style: "display:grid;grid-template-columns:max-content minmax(0,240px) max-content;gap:6px 10px;align-items:center" }, h("label", null, "Grid 1:"), fast1, h("span", { class: "ro" }, `(${keyName("Alt+1")})`), h("label", null, "Grid 2:"), fast2, h("span", { class: "ro" }, `(${keyName("Alt+2")})`)));
    const ob = KD().staticBox(R, "Grid Overrides"), og = h("div", { style: "display:grid;grid-template-columns:max-content minmax(0,240px);gap:6px 10px;align-items:center" });
    const ov = (key: "connected" | "wires" | "vias" | "text" | "graphics", label: string) => { const s2 = select([], "", (v) => { (o as unknown as Record<string, number>)[key + "Mm"] = +v; }, { id: `${pre}-ov-${key}` }); ovSel[key] = s2;
      og.append(checkbox(label, o[key], (on) => { o[key] = on; }, { id: `${pre}-ovon-${key}` }), s2); };
    // PANEL_GRID_SETTINGS relabels the overrides for the board editor, and the footprint editor has no wires or vias
    if (ed === "fp") ov("connected", "Pads:");
    else { ov("connected", ed === "pcb" ? "Footprints/pads:" : "Connected items:"); ov("wires", ed === "pcb" ? "Tracks:" : "Wires:"); }
    if (ed === "pcb") ov("vias", "Vias:");
    ov("text", "Text:"); ov("graphics", "Graphics:");
    ob.append(og); KD().staticBox(R, "Grid Display").append(checkbox("Show grid axes", !!g.axes, (on) => { g.axes = on; }, { id: `${pre}-gridaxes` })); fill();
  };
  // PANEL_GAL_OPTIONS, the left column of the Schematic and Footprint Editor Display Options pages: the grid's look and
  // the cursor of that frame (the PCB and Symbol Editor pages are built on their own branches of this dialog)
  const galPanel = (host: HTMLElement, ed: EditorId): void => {
    const g = p.gal[ed], pre = `kd-pref-${ed}-gal`;
    const radios = (name: string, rows: [string, string][], value: string, set: (v: string) => void): HTMLElement => h("div", { style: "display:flex;flex-direction:column;gap:4px" },
      ...rows.map(([v, l]) => { const r = h("input", { type: "radio", name: `${pre}-${name}`, id: `${pre}-${name}-${v}` }) as HTMLInputElement; r.checked = v === value;
        r.addEventListener("change", () => { if (r.checked) set(v); }); return h("label", { class: "kd-row", style: "gap:6px" }, r, l); }));
    const R = GRID_MIN_SPACING_RANGE;
    const spacing = h("input", { type: "number", min: String(R.min), max: String(R.max), step: String(R.step), value: String(g.minSpacing), id: `${pre}-spacing`, style: "width:80px" }) as HTMLInputElement;
    spacing.addEventListener("change", () => { const v = Math.round(+spacing.value); if (spacing.value.trim() !== "" && isFinite(v)) g.minSpacing = Math.max(R.min, Math.min(R.max, v)); spacing.value = String(g.minSpacing); });
    KD().staticBox(host, "Grid Display").append(h("div", { style: "display:grid;grid-template-columns:max-content max-content max-content;gap:6px 10px;align-items:center" },
      h("label", { style: "align-self:start" }, "Style:"), radios("style", [["dots", "Dots"], ["lines", "Lines"], ["crosses", "Small crosses"]], g.style, (v) => { g.style = v as GalPrefs["style"]; }), h("span"),
      h("label", null, "Grid thickness:"), select(GRID_THICKNESS_CHOICES.map((w) => [String(w), w.toFixed(1)] as [string, string]), String(g.lineWidth), (v) => { g.lineWidth = +v; }, { id: `${pre}-thickness`, style: "width:80px" }), h("span", { class: "ro" }, "pixels"),
      h("label", null, "Minimum grid spacing:"), spacing, h("span", { class: "ro" }, "pixels")),
      h("div", { style: "margin-top:6px" }, checkbox("Show major grid", g.showMajor, (on) => { g.showMajor = on; }, { id: `${pre}-major` })));
    KD().staticBox(host, "Cursor").append(radios("cursor", [["small", "Small crosshairs"], ["full", "Full window crosshairs"], ["45", "45 degree crosshairs"]], g.crosshair, (v) => { g.crosshair = v as GalPrefs["crosshair"]; }),
      h("div", { style: "margin-top:6px" }, checkbox("Always show crosshairs", g.alwaysShow, (on) => { g.alwaysShow = on; }, { id: `${pre}-always` })));
  };
  // PANEL_EESCHEMA_COLOR_SETTINGS: the Theme list (the built-in themes read-only, then the user's, then New Theme...),
  // a swatch per item over the theme's background, each with Copy / Paste / Revert to saved color on a right click
  let bgConfirmed = false;
  const colorsPage = (pg: HTMLElement): void => {
    const sc = p.schColors, saved = JSON.parse(JSON.stringify(sc.user)) as UserSchTheme[];
    const NEW = "__new__";
    const userOf = (id: string): UserSchTheme | undefined => sc.user.find((u) => u.id === id);
    const colorsOf = (id: string): Record<string, string> => { const u = userOf(id); return u ? { ...KiCadCanvas.schThemeColors("default"), ...schExtraColors("default"), ...u.colors } : { ...KiCadCanvas.schThemeColors(id), ...schExtraColors(id) }; };
    const choices = (): [string, string][] => [...schThemeList(p).map(([id, n]) => [id, userOf(id) ? n : `${n} (read-only)`] as [string, string]), [NEW, "New Theme..."]];
    const theme = select(choices(), sc.theme, (v) => {
      if (v !== NEW) { sc.theme = v; paint(); return; }
      theme.value = sc.theme;
      void promptText("Add Color Theme", "New theme name:", "", (name) => { const err = themeNameError(name, schThemeList(p).map(([, n]) => n)); if (err) { messageBox("Add Color Theme", err); return false; } return true; }).then((name) => {
        if (name === null) return;
        const u = newUserTheme(name, colorsOf(sc.theme), schThemeList(p).map(([id]) => id)); sc.user.push(u); sc.theme = u.id;
        // OnThemeChanged saves the new theme's file at once, so its colours are the saved ones Revert goes back to
        saved.push(JSON.parse(JSON.stringify(u)) as UserSchTheme);
        theme.replaceChildren(...choices().map(([v2, l]) => h("option", { value: v2 }, l))); theme.value = u.id; paint();
      });
    }, { id: "kd-pref-theme", style: "width:260px" });
    let copied: RGBA | null = null;
    const grid = h("div", { id: "kd-pref-swatches", style: "display:grid;grid-template-columns:repeat(2,max-content minmax(0,1fr));gap:5px 10px;align-items:center;margin-top:12px" });
    const paint = (): void => {
      const C = colorsOf(sc.theme), u = userOf(sc.theme), bg = C.bg || "#FFFFFF";
      grid.replaceChildren();
      for (const [k, label] of SCH_COLOR_ITEMS) {
        const sw = colorSwatch(parseColor(C[k]), { opacity: true, readOnly: !u, key: `sch-color-${k}`, title: label.replace("&&", "&"),
          onChange: (c) => { if (!u || !c) return; u.colors[k] = colorText(c); if (k === "wire") u.colors.busEntry = u.colors[k]; if (k === "bg") paint(); } });
        // COLOR_SWATCH::SetSwatchBackground: a translucent colour is shown over the theme's background
        sw.el.style.boxShadow = `0 0 0 2px ${bg}`;
        sw.el.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          const was = (saved.find((x) => x.id === sc.theme)?.colors || {})[k], cur = u ? u.colors[k] : C[k];
          popupMenu(ev.clientX, ev.clientY, [
            { label: "Copy color", icon: "copy", run: () => { copied = parseColor(cur); } },
            ...(u && copied ? [{ label: "Paste color", icon: "paste", run: () => { u.colors[k] = colorText(copied!); paint(); } }] : []),
            ...(u && was && !sameColor(was, cur) ? [{ label: "Revert to saved color", icon: "undo", run: () => { u.colors[k] = was; paint(); } }] : []),
          ]);
        });
        grid.append(sw.el, h("span", null, label.replace("&&", "&")));
      }
    };
    pg.append(h("div", { class: "kd-row", style: "gap:8px" }, h("label", { style: "color:var(--ink-2)" }, "Theme:"), theme),
      h("div", { style: "margin-top:8px" }, checkbox("Follow the app's dark mode for the schematic sheet", sc.followDark, (on) => { sc.followDark = on; }, { id: "kd-pref-followdark", title: "While the user interface is dark, draw the schematic with the Dark theme" })),
      grid,
      h("p", { class: "kd-note", style: "margin-top:10px" }, "Built-in themes are read-only: choose New Theme... to make an editable copy.  Right-click a color to copy, paste or revert it.  Changes are applied when the dialog is closed with OK; plots and exports use KiCad Default unless told otherwise."));
    paint();
  };
  /** A Display Options page's two columns: PANEL_GAL_OPTIONS on the left, the frame's own options on the right. */
  const displayCols = (pg: HTMLElement, ed: EditorId): [HTMLElement, HTMLElement] => {
    const L = h("div"), R = h("div"); pg.append(h("div", { style: "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px" }, L, R)); galPanel(L, ed); return [L, R];
  };
  KD().open({ title: "Preferences", width: 900, cls: "kd-wide kd-flush",
    // PAGED_DIALOG::onResetButton: only the page on show goes back to its defaults, and nothing is saved before OK
    extra: [{ label: "Reset to Defaults", fn: () => {
      const key = pageKey();
      if (key === "Common/Hotkeys") { if (hk) hk.resetToDefaults(); return; }
      if (key === "Common/WakaTime") return;   // nothing local to reset: the key is removed with Remove Key
      const st: Staged = { view, p, uiMode, arcEdit, hv45, curved, contrast, hotkeys: hk ? hk.staged() : undefined };
      resetPage(key, st); KD().close(); openPreferences(key, st);
    } }],
    cancel() { lastPage = pageKey() || lastPage; },
    build(body) {
      body0 = body;
      KD().treebook(body, [
        { label: "Common", pages: [
          { label: "Common", build(pg) {
            // panel_common_settings' "User Interface" box: the web's light / dark chrome (web/shared/theme.ts)
            const ui = KD().staticBox(pg, "User Interface");
            ui.append(h("div", { class: "kd-row" }, h("label", { style: "color:var(--ink-2)" }, "Appearance:"),
              select([["light", "Light"], ["dark", "Dark"], ["system", "System"]], uiMode, (v) => { uiMode = v as ThemeMode; }, { id: "kd-pref-uitheme", style: "width:160px" })),
              h("p", { class: "kd-note", style: "margin:8px 0 0" }, "System follows the light or dark setting of your computer.  Also in Preferences > Appearance."));
            // panel_common_settings' Appearance box: m_highContrastCtrl (0..1, step 0.1)
            const ap = KD().staticBox(pg, "Appearance");
            const dim = h("input", { type: "number", min: "0", max: "1", step: "0.1", value: String(p.common.hcDimming), id: "kd-pref-hcdim", style: "width:80px" }) as HTMLInputElement;
            dim.addEventListener("change", () => { const v = Math.max(0, Math.min(1, +dim.value)); if (isFinite(v)) { p.common.hcDimming = v; dim.value = String(v); } });
            ap.append(h("div", { class: "kd-row" }, h("label", { style: "color:var(--ink-2)" }, "High-contrast mode dimming factor:"), dim));
          } },
          { label: "Mouse and Touchpad", build(pg) { mousePage(pg, p); } },
          { label: "Hotkeys", build(pg) { hk = hotkeysPanel(pg, staged && staged.hotkeys); } },
          // not a KiCad panel: Junction's WakaTime heartbeats (the desktop app has the same page)
          { label: "WakaTime", build(pg) { waka = wakatimePage(pg, (host, title) => KD().staticBox(host, title)); } },
          // PANEL_MAINTENANCE: the settings KiCad keeps in its files are this browser's storage here
          { label: "Maintenance", build(pg) {
            // panel_maintenance_base: a column of buttons, no box (the 3D cache duration has no browser counterpart)
            const row = (label: string, id: string, fn: () => void, title?: string): HTMLElement => { const b = h("button", { type: "button", class: "btn", id, title }, label) as HTMLButtonElement; b.addEventListener("click", fn); return h("div", { style: "margin:0 0 8px" }, b); };
            pg.append(
              row("Clear \"Open Recent\" History", "kd-pref-clearhistory", () => { clearFileHistory(); toast("File history cleared."); },
                "The web editor has no Open Recent menu; this clears the histories this browser keeps (board Find, the library choosers' recently used)"),
              row("Reset \"Don't Show Again\" Dialogs", "kd-pref-cleardontshow", () => { clearDontShowAgain(); toast("\"Don't show again\" dialogs reset."); }),
              row("Reset All Dialogs to Defaults", "kd-pref-resetdialogs", () => { clearDialogState(); toast("All dialogs reset to defaults."); }),
              row("Reset All Program Settings to Defaults", "kd-pref-resetall", () => {
                void askConfirm("Reset All Program Settings", "Reset every preference, dialog setting, panel layout and hotkey this browser keeps to its default?  Your designs and projects are not changed.  The page reloads afterwards.", { ok: "Reset", danger: true })
                  .then((yes) => { if (!yes) return; KD().close(); resetProgramSettings(); location.reload(); });
              }),
              h("p", { class: "kd-note", style: "margin:4px 0 0" }, "These settings are kept in this browser only; other browsers and computers keep their own."));
          } },
        ] },
        // PANEL_SYM_EDIT_GRIDS: the Symbol Editor's own window settings
        { label: "Symbol Editor", pages: [
          { label: "Display Options", build(pg) { const [, R] = displayCols(pg, "sym"); symDisplayPage(R, p); } },
          { label: "Grids", build: gridsPage("sym") },
          { label: "Editing Options", build(pg) { symEditingPage(pg, p); } },
          { label: "Colors", build(pg) { symColorsPage(pg, p); } },
        ] },
        { label: "Schematic Editor", pages: [
          { label: "Display Options", build(pg) { const [L, R] = displayCols(pg, "sch"); schDisplayPage(L, R, p, view); } },
          { label: "Grids", build: gridsPage("sch") },
          { label: "Editing Options", build(pg) { schEditingPage(pg, p); } },
          { label: "Colors", build(pg) { colorsPage(pg); } },
          { label: "Field Name Templates", build(pg) { fieldTemplatesPage(pg, p); } },
          { label: "Simulator", build(pg) { simulatorPage(pg, p); } },
        ] },
        // PANEL_FP_GRIDS: the Footprint Editor's own window settings
        { label: "Footprint Editor", pages: [
          { label: "Display Options", build(pg) { displayCols(pg, "fp"); } },
          { label: "Grids", build: gridsPage("fp") },
          { label: "Editing Options", build(pg) {
            // PANEL_EDIT_OPTIONS( isFootprintEditor ): FOOTPRINT_EDITOR_SETTINGS' own rotation step, m_sizerBoardEdit
            // hidden, and Ctrl only toggles the selection (m_rbHighlightNet hidden); the options book shows the empty fpPage
            const e = p.fpEditing;
            const ed = KD().staticBox(pg, "Editing Options");
            const rot = textInput(String(e.rotationAngle), (v) => { const n = parseFloat(v); if (isFinite(n) && n > 0 && n <= 360) e.rotationAngle = n; }, { id: "kd-pref-fp-rotstep", style: "width:80px" });
            rot.title = "Set increment (in degrees) for context menu and hotkey rotation.";
            ed.append(h("div", { style: "display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 8px;align-items:center" },
              h("label", { style: "color:var(--ink-2);white-space:nowrap" }, "Step for rotate commands:"), h("div", { class: "kd-row", style: "gap:6px" }, rot, h("span", null, "deg"))));
            KD().staticBox(pg, "Left Click Mouse Commands").append(...leftClickCommands("Toggle selection"));
          } },
        ] },
        { label: "PCB Editor", pages: [
          { label: "Display Options", build(pg) {
            // panel_display_options (PCB Editor page): PANEL_GAL_OPTIONS on the left; Clearance Outlines, Annotations
            // and the rest on the right
            const d = p.pcbDisplay;
            const [, R] = displayCols(pg, "pcb");
            const row = (label: string, ...ctl: Node[]) => h("div", { class: "kd-row", style: "margin-bottom:6px;gap:6px" }, h("label", { style: "color:var(--ink-2)" }, label), ...ctl);
            // panel_display_options_base: Pads, Clearance Outlines, then the PCB Editor page's Annotations, Selection &
            // Highlighting and Cross-probing (with Refresh 3D view automatically under it)
            const xp = d.crossProbing || (d.crossProbing = { onSelection: true, centerOnItems: true, zoomToFit: true, autoHighlight: true, flashSelection: false });
            const pd = KD().staticBox(R, "Pads");
            pd.append(checkbox("Use via color for normal through hole padstacks", !!d.viaColorForTHPads, (on) => { d.viaColorForTHPads = on; }, { id: "kd-pref-viacolorthpads" }));
            const cl = KD().staticBox(R, "Clearance Outlines");
            cl.append(row("Tracks:", select([["0", "Do not show clearances"], ["1", "Show when routing"], ["2", "Show when routing w/ via clearance at end"], ["3", "Show when routing and editing"], ["4", "Show always"]], String(d.trackClearance), (v) => { d.trackClearance = +v; }, { id: "kd-pref-trackclearance", style: "width:320px" })),
              checkbox("Show pad clearance", d.padClearance !== false, (on) => { d.padClearance = on; }, { id: "kd-pref-padclearance" }));
            const ap = KD().staticBox(R, "Annotations");
            // m_ShowNetNamesOption: the choice index is pcb_display.net_names_mode
            ap.append(row("Net names:", select([["0", "Do not show"], ["1", "Show on pads"], ["2", "Show on tracks"], ["3", "Show on pads & tracks"]], String(d.netNamesMode), (v) => { d.netNamesMode = +v; d.showNetNames = +v !== 0; }, { id: "kd-pref-netnamesmode", style: "width:220px" })),
              checkbox("Show pad numbers", d.showPadNumbers, (on) => { d.showPadNumbers = on; }, { id: "kd-pref-padnumbers" }));
            const sh = KD().staticBox(R, "Selection & Highlighting");
            sh.append(checkbox("Show all fields when parent footprint is selected", d.forceShowFieldsWhenFPSelected !== false, (on) => { d.forceShowFieldsWhenFPSelected = on; }, { id: "kd-pref-forceshowfields" }));
            const cp = KD().staticBox(R, "Cross-probing");
            cp.append(checkbox("Select/highlight objects corresponding to schematic selection", xp.onSelection, (on) => { xp.onSelection = on; }, { id: "kd-pref-xp-onselection" }),
              checkbox("Center view on cross-probed items", xp.centerOnItems, (on) => { xp.centerOnItems = on; }, { id: "kd-pref-xp-center" }),
              checkbox("Zoom to fit cross-probed items", xp.zoomToFit, (on) => { xp.zoomToFit = on; }, { id: "kd-pref-xp-zoom" }),
              checkbox("Highlight cross-probed nets", xp.autoHighlight, (on) => { xp.autoHighlight = on; }, { id: "kd-pref-xp-highlight" }),
              checkbox("Flash cross-probed selection", xp.flashSelection, (on) => { xp.flashSelection = on; }, { id: "kd-pref-xp-flash" }),
              checkbox("Refresh 3D view automatically", !!d.live3DRefresh, (on) => { d.live3DRefresh = on; }, { id: "kd-pref-live3drefresh" }));
          } },
          { label: "Grids", build: gridsPage("pcb") },
          { label: "Origins & Axes", build(pg) {
            // panel_pcbnew_display_origin: where the status bar counts from, and which way each axis increases
            const o = p.pcbOrigin;
            const group = (title: string, name: string, rows: [string, string][], value: string, set: (v: string) => void) => {
              const box = h("div", { style: "margin-bottom:12px" }, h("div", { style: "margin-bottom:4px" }, title));
              for (const [v, label] of rows) {
                const r = h("input", { type: "radio", name, value: v, id: `kd-pref-${name}-${v}` }) as HTMLInputElement; r.checked = v === value;
                r.addEventListener("change", () => { if (r.checked) set(v); });
                box.append(h("label", { class: "kd-row", style: "margin-left:16px;gap:6px" }, r, label));
              }
              pg.append(box);
            };
            group("Display Origin", "origin", [["page", "Page origin"], ["aux", "Drill/place file origin"], ["grid", "Grid origin"]], o.origin, (v) => { o.origin = v as "page" | "aux" | "grid"; });
            group("X Axis", "xaxis", [["right", "Increases right"], ["left", "Increases left"]], o.invertX ? "left" : "right", (v) => { o.invertX = v === "left"; });
            group("Y Axis", "yaxis", [["up", "Increases up"], ["down", "Increases down"]], o.invertY ? "up" : "down", (v) => { o.invertY = v === "up"; });
          } },
          { label: "Editing Options", build(pg) {
            // panel_edit_options (PCB): Editing Options and Left Click Mouse Commands on the left, Ratsnest and
            // Miscellaneous on the right (the board page of m_optionsBook)
            const e = p.pcbEditing;
            const L = h("div", { style: "flex:1 1 360px;min-width:0" }), R = h("div", { style: "flex:1 1 260px;min-width:0" });
            pg.append(h("div", { style: "display:flex;gap:16px;flex-wrap:wrap" }, L, R));
            const row = (label: string, ...ctl: Node[]) => h("div", { class: "kd-row", style: "margin-bottom:6px;gap:6px" }, h("label", { style: "color:var(--ink-2)" }, label), ...ctl);
            const ed = KD().staticBox(L, "Editing Options");
            const rot = textInput(String(e.rotationAngle), (v) => { const n = parseFloat(v); if (isFinite(n) && n > 0 && n <= 360) e.rotationAngle = n; }, { id: "kd-pref-rotstep", style: "width:80px" });
            rot.title = "Set increment (in degrees) for context menu and hotkey rotation.";
            const grid = (...rows: [string, Node][]) => h("div", { style: "display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 8px;align-items:center;margin-top:6px" },
              ...rows.flatMap(([l, c]) => [h("label", { style: "color:var(--ink-2);white-space:nowrap" }, l), c]));
            ed.append(checkbox("Constrain actions to H, V, 45 degrees", hv45, (on) => { hv45 = on; }, { id: "kd-pref-hv45" }),
              grid(["Step for rotate commands:", h("div", { class: "kd-row", style: "gap:6px" }, rot, h("span", null, "deg"))],
                ["Arc editing mode:", select([["0", "Keep center, adjust radius"], ["1", "Keep endpoints or direction of starting point"], ["2", "Keep center and radius, adjust endpoints"]], String(arcEdit), (v) => { arcEdit = +v; }, { id: "kd-pref-arcedit", style: "width:100%" })],
                ["Track mouse-drag mode:", select([["move", "Move"], ["drag", "Drag (45 degree mode)"], ["dragFree", "Drag (free angle)"]], e.trackDragAction, (v) => { e.trackDragAction = v as typeof e.trackDragAction; }, { id: "kd-pref-trackdrag", style: "width:100%" })]));
            // Left Click Mouse Commands (m_mouseCmdsWinLin / m_mouseCmdsOSX): fixed rows, and Ctrl's choice
            const lc = KD().staticBox(L, "Left Click Mouse Commands");
            const radio = (v: boolean, label: string) => { const r = h("input", { type: "radio", name: "kd-pref-ctrlclick", id: `kd-pref-ctrlclick-${v ? "hl" : "toggle"}` }) as HTMLInputElement; r.checked = e.ctrlClickHighlight === v; r.addEventListener("change", () => { if (r.checked) e.ctrlClickHighlight = v; }); return h("label", { class: "kd-row", style: "gap:6px" }, r, label); };
            lc.append(...leftClickCommands(h("div", null, radio(false, "Toggle selection"), radio(true, "Highlight net (for pads/tracks)"))));
            const rb = KD().staticBox(R, "Ratsnest");
                        // wxSpinCtrlDouble( 0.5, 10, 0.5, 0.5 ) with 1 digit: a typed value is clamped to the range and rounded
            const thick = h("input", { type: "number", min: "0.5", max: "10", step: "0.5", value: String(e.ratsnestThickness), id: "kd-pref-ratsthick", style: "width:80px" }) as HTMLInputElement;
            thick.addEventListener("change", () => { const n = parseFloat(thick.value); if (!isFinite(n)) { thick.value = String(e.ratsnestThickness); return; }
              e.ratsnestThickness = Math.round(Math.max(0.5, Math.min(10, n)) * 10) / 10; thick.value = String(e.ratsnestThickness); });
            rb.append(checkbox("Show ratsnest with curved lines", curved, (on) => { curved = on; }, { id: "kd-pref-curvedrats" }), row("Ratsnest line thickness:", thick));
            const misc = KD().staticBox(R, "Miscellaneous");
            misc.append(checkbox("<ESC> clears net highlighting", e.escClearsNetHighlight, (on) => { e.escClearsNetHighlight = on; }, { id: "kd-pref-escclears" }),
              checkbox("Show page limits", p.pcbDisplay.showPageLimits, (on) => { p.pcbDisplay.showPageLimits = on; }, { id: "kd-pref-pagelimits", title: "Draw an outline to show the sheet size." }),
              checkbox("Show courtyard collisions when moving/dragging", e.showCourtyardCollisions, (on) => { e.showCourtyardCollisions = on; }, { id: "kd-pref-courtyard" }),
              checkbox("Automatically refill zones", e.autoRefillZones, (on) => { e.autoRefillZones = on; }, { id: "kd-pref-autorefill", title: "If checked, zones will be re-filled after each edit operation" }));
          } },
          { label: "Action Plugins", build(pg) { actionPluginsPage(pg, plugRows, plug); } },
        ] },
      ], { selected: page || lastPage || "Mouse and Touchpad" });
    },
    ok() {
      // PANEL_MOUSE_SETTINGS::TransferDataFromWindow: one modifier per vertical scroll action
      if (!scrollModsValid(p.mouse)) { toast("Only one action can be assigned to each vertical scroll setting", 4000); return false; }
      p.schFieldNames = cleanFieldTemplates(p.schFieldNames);
      // PANEL_EESCHEMA_COLOR_SETTINGS::validateSave: a user theme with items in the background colour asks first
      const ut = p.schColors.user.find((u) => u.id === p.schColors.theme);
      if (ut && !bgConfirmed && hiddenByBackground(ut.colors).length) {
        const okBtn = body0 && body0.closest(".kd-dialog")?.querySelector<HTMLButtonElement>(".kd-foot .btn.primary");
        void askConfirm("Warning", "Some items have the same color as the background\nand they will not be seen on the screen.  Are you\nsure you want to use these colors?", { ok: "Yes", cancel: "No" })
          .then((yes) => { if (yes && okBtn) { bgConfirmed = true; okBtn.click(); } });
        return false;
      }
      lastPage = pageKey() || lastPage; if (hk) hk.apply(); if (uiMode !== getThemeMode()) setThemeMode(uiMode); savePrefs(p); applySchView(view, p); if (contrast !== getInactiveMode()) setInactiveMode(contrast); if (pcbTools() && arcEdit !== pcbTools()!.arcEditMode()) pcbTools()!.setArcEditMode(arcEdit);
      // PANEL_EDIT_OPTIONS::TransferDataFromWindow: m_AngleSnapMode = checked ? DEG45 : DIRECT (only when the box changed, so a 90 degree mode stays)
      const t = pcbTools(); if (t && t.setAngleSnap && hv45 !== (snap0 !== "free")) t.setAngleSnap(null, hv45 ? "45" : "free");
      const rs = ratsnestState(); if (rs && curved !== curved0) rs.setCurvedRatsnest(curved); toast("Preferences saved");
      if (plug && JSON.stringify(plugRows.map((r) => [r.id, r.visible])) !== JSON.stringify(plugRows0.map((r) => [r.id, r.visible]))) void plug.saveActionOrder(plugRows.map((r) => [r.id, r.visible] as [string, boolean]));
      if (waka) waka.apply().catch((e) => toast(`WakaTime settings were not saved: ${e instanceof Error ? e.message : String(e)}`)); } });
}

/** isScrollModSetValid: zoom, pan left / right and pan up / down each on a different modifier. */
export function scrollModsValid(m: Prefs["mouse"]): boolean { return m.zoomMod !== m.panHMod && m.panHMod !== m.panVMod && m.panVMod !== m.zoomMod; }

/**
 * PANEL_MOUSE_SETTINGS (common/dialogs/panel_mouse_settings_base.cpp): Pan and Zoom, Drag Gestures and Scroll
 * Gestures, with the radio grid of modifiers per vertical-scroll action and the two reset buttons.
 */
/**
 * PANEL_EDIT_OPTIONS' Left Click Mouse Commands (m_mouseCmdsWinLin / m_mouseCmdsOSX): the note and the fixed rows, the
 * Ctrl row showing `ctrl` (the board editor's Toggle selection / Highlight net choice).  The modifier names come from
 * keys.ts, in the order each of KiCad's two panels writes them ("Ctrl+Shift", "Shift+Cmd").  With `ctrl` null, the rows of
 * PANEL_EESCHEMA_EDITING_OPTIONS' m_leftClickCmdsBook (no Click or Ctrl row, no colons).
 */
function leftClickCommands(ctrl: Node | string | null): HTMLElement[] {
  const ctrlK = modName("Ctrl"), shiftK = modName("Shift"), altK = modName("Alt");
  // PANEL_EESCHEMA_EDITING_OPTIONS (ctrl null) lists Long Click, Shift and Ctrl+Shift only, without colons
  const c = ctrl === null ? "" : ":";
  const cmds: [string, Node | string][] = [...(ctrl === null ? [] : [["Click:", "Select item(s)"] as [string, string]]), [`Long Click${c}`, "Clarify selection from menu"], [`${shiftK}${c}`, "Add item(s) to selection"],
    [(IS_MAC ? `${shiftK}+${ctrlK}` : `${ctrlK}+${shiftK}`) + c, "Remove item(s) from selection"], ...(ctrl === null ? [] : [[`${ctrlK}:`, ctrl] as [string, Node | string]])];
  if (IS_MAC) cmds.push([`${altK}${c}`, "Clarify selection from menu"]);
  const note = IS_MAC ? `Left click (and drag) actions depend on 3 modifier keys:\n${altK}, ${shiftK} and ${ctrlK}` : `Left click (and drag) actions depend on 2 modifier keys:\n${shiftK} and ${ctrlK}`;
  return [h("div", { style: "font-style:italic;color:var(--ink-3);font-size:var(--fs-sm);margin-bottom:6px;white-space:pre-line" }, note),
    h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;align-items:start" }, ...cmds.flatMap(([k, v]) => [h("span", null, k), typeof v === "string" ? h("span", null, v) : v]))];
}

function mousePage(pg: HTMLElement, p: Prefs): void {
  const m = p.mouse;
  const pz = KD().staticBox(pg, "Pan and Zoom");
  const zoomSlider = h("input", { type: "range", min: "1", max: "10", step: "1", value: String(m.zoomSpeed), id: "kd-pref-zoomspeed", disabled: m.autoZoomSpeed, style: "width:160px" }) as HTMLInputElement;
  zoomSlider.addEventListener("input", () => { m.zoomSpeed = +zoomSlider.value; });
  const panSlider = h("input", { type: "range", min: "1", max: "10", step: "1", value: String(m.autoPanSpeed), id: "kd-pref-autopanspeed", style: "width:160px" }) as HTMLInputElement;
  panSlider.addEventListener("input", () => { m.autoPanSpeed = +panSlider.value; });
  // wxGridBagSizer: (0,0) center, (0,2) auto pan, (1,0..2) acceleration, (2,0) zoom speed, (2,2) auto pan speed
  pz.append(h("div", { style: "display:grid;grid-template-columns:max-content 30px max-content;gap:4px 0;align-items:center" },
    checkbox("Center and warp cursor on zoom", m.centerOnZoom, (on) => { m.centerOnZoom = on; }, { id: "kd-pref-centerzoom" }), h("span"),
    checkbox("Automatically pan while moving object", m.autoPan, (on) => { m.autoPan = on; }, { id: "kd-pref-autopan" }),
    h("div", { style: "grid-column:1 / span 3" }, checkbox("Use zoom acceleration", m.zoomAccel, (on) => { m.zoomAccel = on; }, { id: "kd-pref-zoomaccel" })),
    h("div", { class: "kd-row", style: "margin-top:6px" }, h("label", { style: "color:var(--ink-2)" }, "Zoom speed:"), zoomSlider,
      checkbox("Automatic", m.autoZoomSpeed, (on) => { m.autoZoomSpeed = on; zoomSlider.disabled = on; }, { id: "kd-pref-zoomauto" })), h("span"),
    h("div", { class: "kd-row", style: "margin-top:6px" }, h("label", { style: "color:var(--ink-2)" }, "Auto pan speed:"), panSlider)));
  const dg = KD().staticBox(pg, "Drag Gestures");
  const drag3: [string, string][] = [["pan", "Pan"], ["zoom", "Zoom"], ["none", "None"]];
  dg.append(h("div", { style: "display:grid;grid-template-columns:max-content 340px;gap:6px 10px;align-items:center" },
    h("label", null, "Left button drag:"), select([["select", "Draw selection rectangle"], ["dragSelected", "Drag selected objects; otherwise draw selection rectangle"], ["dragAny", "Drag any object (selected or not)"]],
      m.leftDrag, (v) => { m.leftDrag = v as Prefs["mouse"]["leftDrag"]; }, { id: "kd-pref-left" }),
    h("label", null, "Middle button drag:"), select(drag3, m.middleDrag, (v) => { m.middleDrag = v as Prefs["mouse"]["middleDrag"]; }, { id: "kd-pref-middle" }),
    h("label", null, "Right button drag:"), select(drag3, m.rightDrag, (v) => { m.rightDrag = v as Prefs["mouse"]["rightDrag"]; }, { id: "kd-pref-right" }),
    h("label", null, "Pan on mouse movement with key:"), select([["", "None"], ["alt", modName("Alt")], ["ctrl", modName("Ctrl")], ["shift", modName("Shift")]], m.motionPanMod, (v) => { m.motionPanMod = v as ScrollMod; }, { id: "kd-pref-motionpan" })));
  const sg = KD().staticBox(pg, "Scroll Gestures");
  const touch = select([["native", "Native gestures (recommended)"], ["scroll", "Configurable scroll gestures"]], m.touchpadMode, (v) => { m.touchpadMode = v as "native" | "scroll"; }, { id: "kd-pref-touchpad" });
  sg.append(h("div", { class: "kd-row" }, h("label", { style: "white-space:nowrap" }, "Touchpad navigation:"), touch),
    h("p", { class: "kd-note", style: "margin:4px 0 8px" }, "Native gestures use two-finger movement to pan and pinch to zoom. Mouse wheel mappings remain active in both modes."),
    h("div", { style: "margin-bottom:4px" }, "Vertical touchpad or scroll wheel movement:"));
  // m_scrollWarning: BITMAPS::small_warning with the message as its tooltip (and, here, beside it)
  const warn = h("div", { class: "kd-note", id: "kd-pref-scrollwarn", title: "Only one action can be assigned to each column", style: "color:var(--err);display:none;align-items:center;gap:5px" }, kicadIcon("small_warning", 16), "Only one action can be assigned to each column");
  const grid = h("div", { id: "kd-pref-scrollgrid", style: "display:grid;grid-template-columns:max-content repeat(4, 42px) max-content;gap:4px 0;align-items:center;justify-items:center" });
  // panel_mouse_settings.cpp: the column labels are Cmd and Option on macOS
  const MODS: [ScrollMod, string][] = [["", "--"], ["ctrl", modName("Ctrl")], ["shift", modName("Shift")], ["alt", modName("Alt")]];
  const radios: Record<string, HTMLInputElement[]> = {};
  const reverse: Record<string, HTMLInputElement> = {};
  const rowKey = { zoom: "zoomMod", panv: "panVMod", panh: "panHMod" } as const;
  const sync = () => {
    for (const [row, key] of Object.entries(rowKey)) radios[row]!.forEach((r, i) => { r.checked = m[key] === MODS[i]![0]; });
    reverse.zoom!.checked = m.reverseZoom; reverse.panh!.checked = m.reversePanH; hzPan.checked = m.horizontalPan;
    warn.style.display = scrollModsValid(m) ? "none" : "flex";
  };
  grid.append(h("span"), ...MODS.map(([, l]) => h("label", { style: "color:var(--ink-2)" }, l)), h("span"));
  for (const [row, label] of [["zoom", "Zoom:"], ["panv", "Pan up/down:"], ["panh", "Pan left/right:"]] as const) {
    radios[row] = MODS.map(([mod]) => {
      const r = h("input", { type: "radio", name: `kd-pref-scroll-${row}`, "data-mod": mod || "none", id: `kd-pref-${row}-${mod || "none"}` }) as HTMLInputElement;
      r.addEventListener("change", () => {
        const cur = { zoom: m.zoomMod, panh: m.panHMod, panv: m.panVMod }; const next = assignScrollMod(cur, row, mod);
        m.zoomMod = next.zoom; m.panHMod = next.panh; m.panVMod = next.panv; sync();
      });
      return r;
    });
    let rev: Node = h("span");
    if (row !== "panv") { const cb = h("input", { type: "checkbox", id: `kd-pref-${row}-reverse` }) as HTMLInputElement; reverse[row] = cb;
      cb.addEventListener("change", () => { if (row === "zoom") m.reverseZoom = cb.checked; else m.reversePanH = cb.checked; }); rev = h("label", { class: "kd-chk", style: "justify-self:start;margin-left:8px" }, cb, "Reverse"); }
    grid.append(h("label", { style: "justify-self:end;padding-right:8px" }, label), ...radios[row]!, rev);
  }
  const hzPan = h("input", { type: "checkbox", id: "kd-pref-hpan" }) as HTMLInputElement;
  hzPan.addEventListener("change", () => { m.horizontalPan = hzPan.checked; });
  // onMouseDefaults / onTrackpadDefaults
  const setMods = (zoom: ScrollMod, panh: ScrollMod, panv: ScrollMod, hpan: boolean) => { m.zoomMod = zoom; m.panHMod = panh; m.panVMod = panv; m.reverseZoom = false; m.reversePanH = false; m.horizontalPan = hpan; sync(); };
  sg.append(grid, warn, h("label", { class: "kd-chk", style: "margin-top:8px" }, hzPan, "Pan left/right with horizontal movement"),
    h("div", { class: "kd-row", style: "margin-top:10px;gap:8px" },
      h("button", { class: "btn", type: "button", id: "kd-pref-mousedefaults", onclick: () => setMods("", "ctrl", "shift", false) }, "Reset to Mouse Defaults"),
      h("button", { class: "btn", type: "button", id: "kd-pref-trackpaddefaults", onclick: () => { m.touchpadMode = "scroll"; touch.value = "scroll"; setMods("ctrl", "shift", "", true); } }, "Reset to Configurable Touchpad Defaults")));
  sync();
}

/** One row of the Action Plugins grid. */
interface PluginRow { id: string; name: string; plugin: string; description: string; visible: boolean; icon: string | null }
/** What the Action Plugins page asks of the plugin host (plugins/host.ts, window.KcPlugins). */
interface PluginHost { actionPluginRows(editor?: string): PluginRow[]; saveActionOrder(rows: [string, boolean][]): Promise<void>; openManager?: (tab?: "installed" | "browse" | "official" | "project" | "publish" | "review") => void; refresh?: () => Promise<void>; pluginErrors?: () => { plugin: string; text: string }[] }
/**
 * PANEL_PCBNEW_ACTION_PLUGINS (pcbnew/dialogs/panel_pcbnew_action_plugins.cpp): the grid of the board editor's
 * plugin actions (Action with its icon, or BITMAPS::puzzle_piece for one without, Show Button, Plugin, Description)
 * in the order the toolbar and Tools > External Plugins show them; Move Up / Move Down (small_up / small_down;
 * WX_GRID::OnMoveRowUp/Down keep the moved row selected); Open Plugin Directory (small_folder: the folder the
 * plugins are installed in is the Plugin and Content Manager's Installed list here); Reload Plugins (small_refresh);
 * Show Plugin Errors (small_warning), shown only when a plugin has failed, as KiCad hides it with no errors.
 */
function actionPluginsPage(pg: HTMLElement, rows: PluginRow[], plug: PluginHost | undefined): void {
  let sel = rows.length ? 0 : -1;
  const tb = h("tbody", { id: "kd-pref-plugins" });
  const fill = (): void => {
    tb.replaceChildren(...rows.map((r, i) => {
      const box = h("input", { type: "checkbox", "data-show": r.id, "aria-label": `Show ${r.name} button` }) as HTMLInputElement; box.checked = r.visible;
      box.addEventListener("change", () => { r.visible = box.checked; });
      const icon = r.icon ? h("img", { src: r.icon, alt: "", width: "20", height: "20", style: "width:20px;height:20px;object-fit:contain;flex:none" }) : kicadIcon("puzzle_piece", 20);
      if (r.icon) icon.addEventListener("error", () => icon.replaceWith(kicadIcon("puzzle_piece", 20)), { once: true });
      const tr = h("tr", { "data-action": r.id, class: i === sel ? "sel" : "" },
        h("td", null, h("span", { style: "display:inline-flex;align-items:center;gap:6px;padding:1px 4px" }, icon, r.name)),
        h("td", { style: "text-align:center" }, box), h("td", { class: "ro" }, r.plugin), h("td", { class: "ro" }, r.description));
      tr.addEventListener("click", (ev) => { if ((ev.target as HTMLElement).tagName === "INPUT") return; sel = i; fill(); });
      return tr;
    }));
    up.disabled = sel <= 0; down.disabled = sel < 0 || sel >= rows.length - 1;
    const errs = plug && plug.pluginErrors ? plug.pluginErrors() : [];
    errBtn.style.display = errs.length ? "" : "none";
  };
  const move = (d: number): void => { const j = sel + d; if (sel < 0 || j < 0 || j >= rows.length) return; const t = rows[sel]!; rows[sel] = rows[j]!; rows[j] = t; sel = j; fill(); };
  // PANEL_PCBNEW_ACTION_PLUGINS: m_moveUpButton / m_moveDownButton draw BITMAPS::small_up / small_down
  const up = bitmapButton("small_up", "Move Up", () => move(-1), { id: "kd-pref-plugin-up" }), down = bitmapButton("small_down", "Move Down", () => move(1), { id: "kd-pref-plugin-down" });
  const dir = bitmapButton("small_folder", "Open Plugin Directory", () => { if (plug && plug.openManager) plug.openManager("installed"); }, { id: "kd-pref-plugin-dir" });
  const reload = bitmapButton("small_refresh", "Reload Plugins", () => {
    if (!plug || !plug.refresh) return;
    reload.disabled = true;
    void plug.refresh().then(() => {
      // the order and the boxes on screen are kept; plugins that came or went join or leave the list
      const was = new Map(rows.map((r) => [r.id, r] as [string, PluginRow])), fresh = plug.actionPluginRows("pcb");
      const kept = rows.filter((r) => fresh.some((f) => f.id === r.id)).map((r) => Object.assign(fresh.find((f) => f.id === r.id)!, { visible: r.visible }));
      const added = fresh.filter((f) => !was.has(f.id));
      rows.splice(0, rows.length, ...kept, ...added); sel = rows.length ? Math.min(Math.max(sel, 0), rows.length - 1) : -1; fill();
    }).finally(() => { reload.disabled = false; });
  }, { id: "kd-pref-plugin-reload" });
  const errBtn = bitmapButton("small_warning", "Show Plugin Errors", () => {
    const errs = plug && plug.pluginErrors ? plug.pluginErrors() : [];
    messageBox("Plugin Errors", errs.length ? errs.map((e) => `${e.plugin}:\n${e.text}`).join("\n\n") : "No plugin reported an error.");
  }, { id: "kd-pref-plugin-errors" });
  if (!plug) for (const b of [dir, reload]) b.disabled = true;
  const th = (t: string, w?: number) => h("th", w ? { style: `width:${w}px` } : null, t);
  const table = h("table", { class: "kd-grid", style: "width:100%" }, h("thead", null, h("tr", null, th("Action"), th("Show Button", 100), th("Plugin"), th("Description"))), tb);
  pg.append(h("div", { class: "kd-grid-wrap", style: "height:380px;overflow:auto" }, table),
    rows.length ? "" : h("p", { class: "kd-note", style: "margin:8px 0 0" }, "No plugin adds an action to the PCB Editor.  Install plugins from the Plugin and Content Manager."),
    h("div", { class: "kd-grid-btns", style: "margin-top:5px" }, up, down, h("span", { style: "width:15px" }), dir, reload, errBtn));
  fill();
}

// ---------------------------------------------------------------- Schematic Editor > Display Options
/** The View-menu settings the page shows (their render option, KiCad's default). */
interface SchView { directiveLabels: boolean; ercErrors: boolean; ercWarnings: boolean; ercExclusions: boolean; simExclusions: boolean; opVoltages: boolean; opCurrents: boolean; pinAltIcons: boolean }
const SCH_VIEW_DEFAULTS: SchView = { directiveLabels: true, ercErrors: true, ercWarnings: true, ercExclusions: false, simExclusions: true, opVoltages: true, opCurrents: true, pinAltIcons: true };
const VIEW_KEYS: [keyof SchView, string, string][] = [["directiveLabels", "showDirectiveLabels", "toggleDirectiveLabels"], ["ercErrors", "showErcErrors", "toggleERCErrors"], ["ercWarnings", "showErcWarnings", "toggleERCWarnings"],
  ["ercExclusions", "showErcExclusions", "toggleERCExclusions"], ["simExclusions", "markSimExclusions", "markSimExclusions"], ["opVoltages", "showOpVoltages", "toggleOPVoltages"], ["opCurrents", "showOpCurrents", "toggleOPCurrents"], ["pinAltIcons", "showPinAltIcons", "togglePinAltIcons"]];
function schViewNow(): SchView {
  const ro = (E.renderOpts || {}) as Record<string, unknown>, v = Object.assign({}, SCH_VIEW_DEFAULTS);
  for (const [k, key] of VIEW_KEYS) if (ro[key] !== undefined) (v as unknown as Record<string, boolean>)[k] = !!ro[key];
  return v;
}
function applySchView(v: SchView, p: Prefs): void {
  const ro = E.renderOpts as Record<string, unknown>; const tog: Record<string, boolean> = {};
  for (const [k, key, id] of VIEW_KEYS) { const on = (v as unknown as Record<string, boolean>)[k]; ro[key] = on; tog[id] = on; }
  setToggles(tog);
  try { KiCadCanvas.setSchDisplay({ pinAltIcons: v.pinAltIcons }, E.kdoc && isSch() ? E.kdoc : null); } catch { /* no schematic */ }
  store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); (E as unknown as { renderFull: boolean }).renderFull = true; requestRender();
}
/** PANEL_EESCHEMA_DISPLAY_OPTIONS: PANEL_GAL_OPTIONS (galPanel) and Cross-probing on the left, Appearance and Selection && Highlighting on the right. */
function schDisplayPage(L: HTMLElement, R: HTMLElement, p: Prefs, v: SchView): void {
  const d = p.schDisplay, D = DEFAULT_PREFS.schDisplay;
  const val = <K extends keyof Prefs["schDisplay"]>(k: K): NonNullable<Prefs["schDisplay"][K]> => (d[k] ?? D[k]) as NonNullable<Prefs["schDisplay"][K]>;
  const cb = (label: string, on: boolean, set: (on: boolean) => void, id: string, title?: string): HTMLElement => checkbox(label, on, set, { id: "kd-pref-" + id, title });
  const vcb = (label: string, k: keyof SchView, id: string, title?: string): HTMLElement => cb(label, !!v[k], (on) => { (v as unknown as Record<string, boolean>)[k] = on; }, id, title);
  const spin = (k: "selWidth" | "highlightWidth" | "collisionWidth" | "colorHighlightThickness" | "colorHighlightOpacity", min: number, max: number, step: number, id: string): HTMLInputElement => {
    const i = h("input", { type: "number", min: String(min), max: String(max), step: String(step), value: String(val(k)), id: "kd-pref-" + id, style: "width:80px" }) as HTMLInputElement;
    i.addEventListener("change", () => { const x = Math.max(min, Math.min(max, +i.value)); if (isFinite(x)) { (d as Record<string, unknown>)[k] = x; i.value = String(x); } });
    return i;
  };
  const head = (host: HTMLElement, title: string): HTMLElement => { const box = h("div", { style: "margin-bottom:10px" }); box.append(h("div", { style: "font-weight:600;margin:4px 0 2px" }, title), h("div", { style: "border-top:1px solid var(--line);margin:0 0 6px" })); host.append(box); return box; };
  const grid = (...rows: [string, HTMLElement, string?][]): HTMLElement => h("div", { style: "display:grid;grid-template-columns:max-content max-content max-content;gap:4px 8px;align-items:center;margin:4px 0 4px 4px" }, ...rows.flatMap(([l, c, u]) => [h("label", null, l), c, h("span", { class: "ro" }, u || "")]));
  // PANEL_GAL_OPTIONS is the left column's top (displayCols)
  const cp = head(L, "Cross-probing");
  cp.append(cb("Select/highlight objects corresponding to PCB selection", val("crossProbeSelect"), (on) => { d.crossProbeSelect = on; }, "xpselect", "Highlight symbols corresponding to selected footprints"),
    cb("Center view on cross-probed items", val("crossProbeCenter"), (on) => { d.crossProbeCenter = on; }, "xpcenter", "Ensures that cross-probed symbols are visible in the current view"),
    cb("Zoom to fit cross-probed items", val("crossProbeZoom"), (on) => { d.crossProbeZoom = on; }, "xpzoom"),
    cb("Highlight cross-probed nets", val("crossProbeHighlight"), (on) => { d.crossProbeHighlight = on; }, "xphighlight", "Highlight nets when they are highlighted in the PCB editor"),
    cb("Flash cross-probed selection", val("crossProbeFlash"), (on) => { d.crossProbeFlash = on; }, "xpflash", "Temporarily flash the newly cross-probed selection 3 times"));
  // Appearance
  const ap = head(R, "Appearance");
  ap.append(h("div", { class: "kd-row", style: "margin:0 0 4px" }, h("label", null, "Default font:"), select([["", "KiCad Font"]], val("defaultFont"), (x) => { d.defaultFont = x; }, { id: "kd-pref-defaultfont", style: "width:180px" })),
    cb("Show hidden pins", d.showHiddenPins, (on) => { d.showHiddenPins = on; }, "hiddenpins"),
    cb("Show original pin numbers when remapped", val("remappedPinNumbers"), (on) => { d.remappedPinNumbers = on; }, "remappedpins"),
    cb("Show hidden fields", d.showHiddenFields, (on) => { d.showHiddenFields = on; }, "hiddenfields"),
    vcb("Show directive labels", "directiveLabels", "directivelabels"), vcb("Show ERC errors", "ercErrors", "ercerrors"), vcb("Show ERC warnings", "ercWarnings", "ercwarnings"),
    vcb("Show ERC exclusions", "ercExclusions", "ercexclusions"), vcb("Mark items which are excluded from simulation", "simExclusions", "simexclusions"),
    vcb("Show OP voltages", "opVoltages", "opvoltages"), vcb("Show OP currents", "opCurrents", "opcurrents"), vcb("Show pin alternate mode indicator icons", "pinAltIcons", "pinalticons"),
    cb("Show page limits", d.showPageLimits, (on) => { d.showPageLimits = on; }, "sch-pagelimits"));
  const se = head(R, "Selection && Highlighting".replace("&&", "&"));
  se.append(cb("Draw selected child items", val("selDrawChildren"), (on) => { d.selDrawChildren = on; }, "selchildren"), cb("Fill selected shapes", val("selFill"), (on) => { d.selFill = on; }, "selfill"),
    grid(["Selection thickness:", spin("selWidth", 0, 50, 1, "selwidth")], ["Highlight thickness:", spin("highlightWidth", 0, 50, 1, "hlwidth")], ["Net collision marker width:", spin("collisionWidth", 1, 50, 1, "collisionwidth")]),
    h("div", { class: "ro", style: "margin:0 0 6px 4px" }, "(selection color can be edited in the \"Colors\" page)"),
    cb("Highlight netclass colors", val("highlightNetclass"), (on) => { d.highlightNetclass = on; }, "hlnetclass"),
    grid(["Color highlight thickness:", spin("colorHighlightThickness", 0, 50, 1, "colhlthick")], ["Color highlight opacity:", spin("colorHighlightOpacity", 0, 100, 1, "colhlopacity"), "%"]));
}

// ---------------------------------------------------------------- Schematic Editor > Simulator
const SIM_ACTIONS: [SimWheel, string][] = [["none", "No action"], ["panLR", "Pan left/right"], ["panRL", "Pan right/left"], ["panUD", "Pan up/down"], ["zoom", "Zoom"], ["zoomH", "Zoom horizontally"], ["zoomV", "Zoom vertically"]];
const SIM_H_ACTIONS: [SimWheel, string][] = [["none", "No action"], ["panLR", "Pan left/right"], ["zoomH", "Zoom horizontally"]];
/** PANEL_SIMULATOR_PREFERENCES: Scroll Gestures (vertical by modifier, horizontal) and the two reset buttons. */
function simulatorPage(pg: HTMLElement, p: Prefs): void {
  const box = KD().staticBox(pg, "Scroll Gestures");
  const host = h("div");
  const draw = (): void => {
    host.replaceChildren();
    const s = p.sim;
    const row = (mod: string, key: keyof Prefs["sim"], acts: [SimWheel, string][]): HTMLElement[] => [h("label", null, mod), select(acts, s[key], (v) => { s[key] = v as SimWheel; }, { id: "kd-pref-sim-" + key, style: "width:200px" })];
    host.append(h("div", { style: "font-weight:600;margin:2px 0 6px" }, "Vertical Touchpad or Scroll Wheel Movement"),
      h("div", { style: "display:grid;grid-template-columns:max-content max-content;gap:4px 12px;align-items:center;margin-left:8px" },
        h("span", { class: "ro" }, "Modifier"), h("span", { class: "ro" }, "Action"),
        ...row("None:", "vNone", SIM_ACTIONS), ...row(IS_MAC ? "Cmd:" : "Ctrl:", "vCtrl", SIM_ACTIONS), ...row("Shift:", "vShift", SIM_ACTIONS), ...row(IS_MAC ? "Option:" : "Alt:", "vAlt", SIM_ACTIONS)),
      h("div", { style: "font-weight:600;margin:12px 0 6px" }, "Horizontal Touchpad Movement"),
      h("div", { style: "display:grid;grid-template-columns:max-content max-content;gap:4px 12px;align-items:center;margin-left:8px" },
        h("span", { class: "ro" }, "Modifier"), h("span", { class: "ro" }, "Action"), ...row("Any:", "h", SIM_H_ACTIONS)),
      h("div", { style: "display:flex;gap:8px;margin-top:12px" },
        h("button", { class: "btn", type: "button", id: "kd-pref-sim-mouse", onclick: () => { p.sim = Object.assign({}, SIM_MOUSE_DEFAULTS); draw(); } }, "Reset to Mouse Defaults"),
        h("button", { class: "btn", type: "button", id: "kd-pref-sim-trackpad", onclick: () => { p.sim = Object.assign({}, SIM_TRACKPAD_DEFAULTS); draw(); } }, "Reset to Trackpad Defaults")));
  };
  box.append(host); draw();
}

// ---------------------------------------------------------------- Schematic Editor > Editing Options
/** PANEL_EESCHEMA_EDITING_OPTIONS: Editing, Defaults for New Objects, Selection and the left click commands on the
 *  left; Symbol Field Automatic Placement, Repeated Items and Dialog Preferences on the right. */
function schEditingPage(pg: HTMLElement, p: Prefs): void {
  const se = p.schEditing, D = DEFAULT_PREFS.schEditing;
  const v = <K extends keyof Prefs["schEditing"]>(k: K): NonNullable<Prefs["schEditing"][K]> => (se[k] ?? D[k]) as NonNullable<Prefs["schEditing"][K]>;
  const flag = (label: string, k: "mouseDragIsDrag" | "autoStartWires" | "escClearsNetHighlight" | "autoAnnotate" | "autoPlaceSheetPins" | "unconstrainedPinSwaps" | "pinSelectsSymbol" | "autoplaceFields" | "autoplaceJustify" | "autoplaceAlign" | "footprintPreview" | "neverShowRescue", id: string, title?: string): HTMLElement =>
    checkbox(label, !!v(k), (on) => { (se as Record<string, unknown>)[k] = on; }, { id: "kd-pref-" + id, title });
  const L = h("div", { style: "flex:1;min-width:0" }), R = h("div", { style: "flex:1;min-width:0" });
  pg.append(h("div", { style: "display:flex;gap:16px" }, L, R));
  const row = (label: string, ctl: HTMLElement): HTMLElement => h("div", { class: "kd-row", style: "margin-bottom:6px" }, h("label", { style: "color:var(--ink-2);min-width:130px" }, label), ctl);
  const ed = KD().staticBox(L, "Editing");
  ed.append(row("Line drawing mode:", select([["free", "Free Angle"], ["90", "90 deg Angle"], ["45", "45 deg Angle"]], se.lineMode, (x) => { se.lineMode = x as "free" | "90" | "45"; }, { id: "kd-pref-linemode", style: "width:200px" })),
    row("Arc editing mode:", select([["center", "Keep center, adjust radius"], ["endpoints", "Keep endpoints or direction of starting point"], ["radius", "Keep center and radius, adjust endpoints"]], v("arcEditMode"), (x) => { se.arcEditMode = x as "center" | "endpoints" | "radius"; }, { id: "kd-pref-sch-arcedit", style: "width:200px" })),
    flag("Mouse drag performs Drag (G) operation", "mouseDragIsDrag", "dragmode", "If unchecked, mouse drag will perform move (M) operation"),
    flag("Automatically start wires on unconnected pins", "autoStartWires", "autowires", "When enabled, you can start wiring by clicking on unconnected pins even when the wire tool is not active"),
    flag("<ESC> clears net highlighting", "escClearsNetHighlight", "escnet", "First <ESC> in selection tool clears selection, next clears net highlighting"),
    flag("Automatically annotate symbols", "autoAnnotate", "autoannotate"),
    flag("Automatically place sheet pins", "autoPlaceSheetPins", "autosheetpins", "Place pins for hierarchical labels when placing sheets or design blocks as sheets."),
    flag("Allow unconstrained pin swaps", "unconstrainedPinSwaps", "pinswaps", "Allows swapping symbol pins' positions. May cause invalid design changes; use with caution."));
  // Defaults for New Objects: COLOR_SWATCHes (an unset colour is the theme's)
  const swatch = (k: "sheetBorder" | "sheetBackground", id: string): HTMLElement => {
    const b = h("button", { type: "button", class: "btn", id: "kd-pref-" + id, style: "width:48px;height:20px;padding:0" }) as HTMLButtonElement;
    const paint = (): void => { const c = v(k); b.style.background = c || "transparent"; b.title = c || "Default"; };
    b.addEventListener("click", () => { const cur = v(k) ? fromHex(v(k)) : null; colorPicker(cur, true, (c) => { se[k] = toHex(c); paint(); }); });
    paint(); return b;
  };
  const dn = KD().staticBox(L, "Defaults for New Objects");
  dn.append(row("Sheet border:", swatch("sheetBorder", "sheetborder")), row("Sheet background:", swatch("sheetBackground", "sheetbg")),
    row("Power symbols:", select([["default", "Default"], ["global", "Global"], ["local", "Local"]], v("newPowerSymbols"), (x) => { se.newPowerSymbols = x as "default" | "global" | "local"; }, { id: "kd-pref-powertype", style: "width:120px" })));
  const sl = KD().staticBox(L, "Selection");
  sl.append(flag("Clicking on a pin selects the symbol", "pinSelectsSymbol", "pinselects", "In schematic editor:\nIf enabled, clicking on a pin select the parent symbol.\nIf disabled, clicking on a pin select only the pin."));
  const lc = KD().staticBox(L, "Left Click Mouse Commands");
  lc.append(...schLeftClick());
  const ap = KD().staticBox(R, "Symbol Field Automatic Placement");
  ap.append(flag("Automatically place symbol fields", "autoplaceFields", "autoplace"), flag("Allow field autoplace to change justification", "autoplaceJustify", "autoplacejustify"),
    flag("Always align autoplaced fields to the 50 mil grid", "autoplaceAlign", "autoplacealign"));
  // Repeated Items: the pitches through UNIT_BINDER in the schematic editor's units, the label step a spin control
  const su = loadUnits("eeschema").units, uname = unitName(su);
  const pitch = (id: string, mm: number, set: (x: number) => void): HTMLInputElement => { const f = lenField(mm, { units: su, onChange: set }); f.input.id = id; f.input.style.width = "90px"; return f.input as HTMLInputElement; };
  const inc = h("input", { type: "number", id: "kd-pref-repeatinc", min: "-100000", max: "100000", step: "1", value: String(se.repeatIncrement), style: "width:90px" }) as HTMLInputElement;
  inc.addEventListener("change", () => { const x = Math.round(+inc.value); if (isFinite(x)) { se.repeatIncrement = Math.max(-100000, Math.min(100000, x)); inc.value = String(se.repeatIncrement); } });
  const ri = KD().staticBox(R, "Repeated Items");
  ri.append(h("div", { style: "display:grid;grid-template-columns:max-content max-content max-content;gap:6px 8px;align-items:center" },
    h("label", null, "Horizontal pitch:"), pitch("kd-pref-repeatx", se.repeatX, (x) => { se.repeatX = x; }), h("span", { class: "ro" }, uname),
    h("label", null, "Vertical pitch:"), pitch("kd-pref-repeaty", se.repeatY, (x) => { se.repeatY = x; }), h("span", { class: "ro" }, uname),
    h("label", null, "Label increment:"), inc, h("span", null)));
  const dp = KD().staticBox(R, "Dialog Preferences");
  dp.append(flag("Show footprint previews in Symbol Chooser", "footprintPreview", "fppreview"), flag("Never show Rescue Symbols tool", "neverShowRescue", "neverrescue"));
}
/** the schematic's "Left Click Mouse Commands" page: KiCad lists Long Click, Shift, Ctrl+Shift (and Option on a Mac). */
function schLeftClick(): HTMLElement[] {
  const ctrlK = modName("Ctrl"), shiftK = modName("Shift"), altK = modName("Alt");
  const cmds: [string, string][] = [["Long Click", "Clarify selection from menu"], [shiftK, "Add item(s) to selection"], [IS_MAC ? `${shiftK}+${ctrlK}` : `${ctrlK}+${shiftK}`, "Remove item(s) from selection"]];
  if (IS_MAC) cmds.push([altK, "Clarify selection from menu"]);
  const note = IS_MAC ? `Left click (and drag) actions depend on 3 modifier keys:\n${altK}, ${shiftK} and ${ctrlK}` : `Left click (and drag) actions depend on 2 modifier keys:\n${shiftK} and ${ctrlK}`;
  return [h("div", { style: "white-space:pre-line;margin:2px 0 6px" }, note),
    h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:3px 16px;margin-left:8px" }, ...cmds.flatMap(([k, d]) => [h("span", null, k), h("span", null, d)]))];
}
