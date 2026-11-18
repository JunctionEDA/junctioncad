// dialogs/prefs.ts — the web editor's preferences (Preferences… dialog): stored in localStorage under "kui.prefs",
// applied live.  Defaults are KiCad's (common/settings/app_settings.cpp, eeschema/eeschema_settings.cpp).
import { E, GRID_CHOICES, gridListKey, isSch, requestRender, setToggle, setToggles, store, toolCtx, updateGridStatus } from "./editor";
import { syncCrosshairRadio, syncSchModes } from "../editor/panes";
import { publishUserOrigin } from "../editor/userorigin";
import { hotkeyCyclePopup } from "../editor/hotkey-popup";
import { effectiveTheme, subscribeTheme } from "../../../shared/theme";
import { PCB_DEFAULT_GRIDS, PCB_DEFAULT_GRID_IDX, PCB_GRID_OVERRIDES, SCH_GRID_OVERRIDES, gridPitchFor, schGridClassOfKind, schGridClassOfTool, type GridOverrides } from "./logic";
import { gridChoiceText, messageText, type GridDef, type IuScale } from "../../../shared/units";
import type { Units } from "../../../shared/store";
import { IS_MAC } from "../../../shared/keys";
import type { ScrollMod } from "../editor/wheel-model";

/** The KiCad frame whose window settings keep a grid list: eeschema, pcbnew, the symbol editor and the footprint editor each have their own. */
export type EditorId = "sch" | "pcb" | "sym" | "fp";
/** The internal-unit scale an editor formats with: the schematic and symbol editors use eeschema's, the board editors pcbnew's. */
export const scaleOf = (ed: EditorId): IuScale => (ed === "sch" || ed === "sym" ? "sch" : "pcb");
/** a built-in theme ("default", "classic", "dark") or a user theme's id ("user:…") */
export type SchThemeId = string;
/**
 * WINDOW_SETTINGS::grid: the grid list in KiCad's order (sizes in mm, square grids; names[i] is GRID::name, "" when
 * unnamed), last = grid.last_size (the grid the editor opens on), fast1 / fast2 = Alt+1 / Alt+2, axes = axes_enabled.
 */
export interface GridPrefs { sizes: number[]; names?: string[]; last?: number; fast1: number; fast2: number; overrides: GridOverrides; axes?: boolean }
import { clampGal, galDefaults, type GalPrefs } from "./gal-options";
import { isDarkBackground, type UserSchTheme } from "./color-themes";
export { GRID_MIN_SPACING_RANGE, GRID_THICKNESS_CHOICES, clampGal, type GalPrefs } from "./gal-options";
export interface Prefs {
  /**
   * COMMON_SETTINGS m_Input (common/settings/common_settings.cpp:245-318), Preferences > Common > Mouse and Touchpad:
   * center_on_zoom, auto_pan / auto_pan_acceleration, zoom_acceleration, zoom_speed / zoom_speed_auto, mouse_left /
   * middle / right, motion_pan_modifier, touchpad_mode, scroll_modifier_zoom / pan_h / pan_v, reverse_scroll_zoom /
   * pan_h and horizontal_pan
   */
  mouse: { autoZoomSpeed: boolean; zoomSpeed: number; middleDrag: "pan" | "zoom" | "none"; rightDrag: "pan" | "zoom" | "none"; centerOnZoom: boolean;
    autoPan: boolean; autoPanSpeed: number; zoomAccel: boolean; leftDrag: "select" | "dragSelected" | "dragAny"; motionPanMod: ScrollMod;
    touchpadMode: "native" | "scroll"; zoomMod: ScrollMod; panHMod: ScrollMod; panVMod: ScrollMod; reverseZoom: boolean; reversePanH: boolean; horizontalPan: boolean };
  schDisplay: { showHiddenPins: boolean; showHiddenFields: boolean; showPageLimits: boolean;
    /** PANEL_EESCHEMA_DISPLAY_OPTIONS (EESCHEMA_SETTINGS appearance / selection / cross_probing; PANEL_GAL_OPTIONS' grid and cursor are gal.sch) */
    defaultFont?: string; remappedPinNumbers?: boolean; selDrawChildren?: boolean; selFill?: boolean; selWidth?: number; highlightWidth?: number; collisionWidth?: number;
    highlightNetclass?: boolean; colorHighlightThickness?: number; colorHighlightOpacity?: number;
    crossProbeSelect?: boolean; crossProbeCenter?: boolean; crossProbeZoom?: boolean; crossProbeHighlight?: boolean; crossProbeFlash?: boolean };
  /** PANEL_SIMULATOR_PREFERENCES (SIM_PREFERENCES mouse_wheel_actions): what the wheel does over a plot, per modifier */
  sim: { vNone: SimWheel; vCtrl: SimWheel; vShift: SimWheel; vAlt: SimWheel; h: SimWheel };
  /** EESCHEMA_SETTINGS (panel_eeschema_editing_options): drawing.line_mode, input.drag_is_move (inverted),
   *  drawing.auto_start_wires, input.esc_clears_net_highlight, annotation.automatic, drawing.default_repeat_offset_x / _y
   *  (mm here, mils in KiCad's file) and drawing.repeat_label_increment */
  schEditing: { lineMode: "free" | "90" | "45"; mouseDragIsDrag: boolean; autoAnnotate: boolean; autoStartWires: boolean; escClearsNetHighlight: boolean;
    repeatX: number; repeatY: number; repeatIncrement: number;
    /** drawing.arc_edit_mode, drawing.auto_place_sheet_pins, input.allow_unconstrained_pin_swaps, drawing.default_sheet_border_color /
     *  _background_color (empty: the theme's), drawing.new_power_symbols, selection.select_pin_selects_symbol, autoplace_fields.*,
     *  appearance.footprint_preview and the rescue tool's never_show */
    arcEditMode?: "center" | "endpoints" | "radius"; autoPlaceSheetPins?: boolean; unconstrainedPinSwaps?: boolean; sheetBorder?: string; sheetBackground?: string;
    newPowerSymbols?: "default" | "global" | "local"; pinSelectsSymbol?: boolean; autoplaceFields?: boolean; autoplaceJustify?: boolean; autoplaceAlign?: boolean;
    footprintPreview?: boolean; neverShowRescue?: boolean };
  /** the schematic canvas colours (Preferences > Schematic Editor > Colors): a theme, and whether a dark UI swaps in the dark sheet */
  schColors: { theme: SchThemeId; followDark: boolean; /** the themes made with New Theme... (KiCad's colors/*.json) */ user: UserSchTheme[] };
  /** the inactive layer mode is not here: it is the project's ("board.high_contrast_mode", Appearance panel) */
  pcbDisplay: { showPadNumbers: boolean; showNetNames: boolean; showPageLimits: boolean;
    /** pcb_display.net_names_mode: 0 Do not show, 1 Show on pads, 2 Show on tracks, 3 Show on pads & tracks (default) */
    netNamesMode: number;
    /** pcb_display.track_clearance_mode: 0 do not show, 1 while routing, 2 with via while routing (default), 3 while routing and editing, 4 always */
    trackClearance: number;
    /** pcb_display.pad_clearance: Show pad clearance (on by default) */
    padClearance?: boolean;
    /** pcb_display.pad_use_via_color_for_normal_th_padstacks (off), force_show_fields_when_fp_selected (on), live_3d_refresh (off) */
    viaColorForTHPads?: boolean; forceShowFieldsWhenFPSelected?: boolean; live3DRefresh?: boolean;
    /** APP_SETTINGS_BASE cross_probing: on_selection, center_on_items, zoom_to_fit, auto_highlight (all on), flash_selection (off) */
    crossProbing?: { onSelection: boolean; centerOnItems: boolean; zoomToFit: boolean; autoHighlight: boolean; flashSelection: boolean } };
  /** SYMBOL_EDITOR_SETTINGS show_hidden_lib_pins / show_hidden_lib_fields / show_pin_electrical_type / show_pin_alt_icons
   *  (Preferences > Symbol Editor > Display Options, the same switches as the frame's View toggles) */
  symDisplay: { showHiddenPins: boolean; showHiddenFields: boolean; showETypes: boolean; showAltIcons: boolean };
  /** SYMBOL_EDITOR_SETTINGS defaults.* (mm here, mils in KiCad's file), repeat.pin_step / label_delta and
   *  drag_pins_along_with_edges (Preferences > Symbol Editor > Editing Options) */
  symEditing: { lineWidth: number; textSize: number; pinLength: number; pinNumSize: number; pinNameSize: number; pinPitch: number; labelDelta: number; dragPinsWithEdges: boolean };
  /** SYMBOL_EDITOR_SETTINGS use_eeschema_color_settings and color_theme (Preferences > Symbol Editor > Colors) */
  symColors: { useSch: boolean; theme: SchThemeId };
  /** EESCHEMA_SETTINGS drawing.field_names: the global Field Name Templates (Preferences > Schematic Editor) */
  schFieldNames: { name: string; visible: boolean; url: boolean }[];
  /** COMMON_SETTINGS appearance.hicontrast_dimming_factor (0.8) */
  common: { hcDimming: number };
  /** PCB Editor > Origins & Axes (PCBNEW_SETTINGS m_Display.m_DisplayOrigin, m_DisplayInvertXAxis / YAxis) */
  pcbOrigin: { origin: "page" | "aux" | "grid"; invertX: boolean; invertY: boolean };
  /**
   * PCB Editor > Editing Options (PCBNEW_SETTINGS): m_RotationAngle (degrees), m_TrackDragAction, m_CtrlClickHighlight,
   * m_Display.m_RatsnestThickness (pixels), m_ESCClearsNetHighlight, m_ShowCourtyardCollisions, m_AutoRefillZones.  The
   * angle snap mode, the arc editing mode and curved ratsnest lines are the board tools' own (toolbar and View menu too).
   */
  pcbEditing: { rotationAngle: number; trackDragAction: "move" | "drag" | "dragFree"; ctrlClickHighlight: boolean; ratsnestThickness: number;
    escClearsNetHighlight: boolean; showCourtyardCollisions: boolean; autoRefillZones: boolean };
  /** Footprint Editor > Editing Options (FOOTPRINT_EDITOR_SETTINGS): m_RotationAngle (degrees), apart from the board's */
  fpEditing: { rotationAngle: number };
  grids: Record<EditorId, GridPrefs>;
  /** the Display Options pages' Grid Display and Cursor boxes, per frame (the View menu's cursor modes write them too) */
  gal: Record<EditorId, GalPrefs>;
}
const MIL = 0.0254;
const IS_WIN = typeof navigator !== "undefined" && /Win/.test(navigator.platform || navigator.userAgent || "");
function schGrids(): GridPrefs { return { sizes: [100 * MIL, 50 * MIL, 25 * MIL, 10 * MIL], names: ["", "", "", ""], last: 1, fast1: 1, fast2: 2, overrides: { ...SCH_GRID_OVERRIDES }, axes: false }; }
function pcbGrids(): GridPrefs { return { sizes: PCB_GRID_SIZES.slice(), names: Array(PCB_GRID_SIZES.length).fill(""), last: PCB_DEFAULT_GRID_IDX, fast1: PCB_DEFAULT_GRID_IDX, fast2: PCB_DEFAULT_GRID_IDX + 1, overrides: { ...PCB_GRID_OVERRIDES }, axes: false }; }
/** APP_SETTINGS_BASE::DefaultGridSizeList for pcbnew and the footprint editor: 1000 mil down to 1 mil, then 5 mm down to 0.01 mm. */
const PCB_GRID_SIZES = PCB_DEFAULT_GRIDS;
/** SIM_MOUSE_WHEEL_ACTION (eeschema/sim/sim_preferences.h) */
export type SimWheel = "none" | "panLR" | "panRL" | "panUD" | "zoom" | "zoomH" | "zoomV";
/** SIM_MOUSE_WHEEL_ACTION_SET::GetMouseDefaults / GetTrackpadDefaults */
export const SIM_MOUSE_DEFAULTS = { vNone: "zoom" as SimWheel, vCtrl: "panLR" as SimWheel, vShift: "panUD" as SimWheel, vAlt: "none" as SimWheel, h: "none" as SimWheel };
export const SIM_TRACKPAD_DEFAULTS = { vNone: "panUD" as SimWheel, vCtrl: "zoom" as SimWheel, vShift: "panLR" as SimWheel, vAlt: "none" as SimWheel, h: "panLR" as SimWheel };
export const DEFAULT_PREFS: Prefs = {
  mouse: { autoZoomSpeed: true, zoomSpeed: IS_MAC ? 5 : 1, middleDrag: "pan", rightDrag: "pan", centerOnZoom: false, autoPan: false, autoPanSpeed: 5, zoomAccel: false, leftDrag: "dragSelected", motionPanMod: "",
    // TOUCHPAD_MODE: native gestures by default on Windows only
    touchpadMode: IS_WIN ? "native" : "scroll", zoomMod: "", panHMod: "ctrl", panVMod: "shift", reverseZoom: false, reversePanH: false, horizontalPan: true },
  schDisplay: { showHiddenPins: false, showHiddenFields: false, showPageLimits: true, defaultFont: "", remappedPinNumbers: false, selDrawChildren: true, selFill: false, selWidth: 3, highlightWidth: 2, collisionWidth: 4,
    highlightNetclass: true, colorHighlightThickness: 15, colorHighlightOpacity: 60, crossProbeSelect: true, crossProbeCenter: true, crossProbeZoom: true, crossProbeHighlight: true, crossProbeFlash: false },
  sim: SIM_MOUSE_DEFAULTS,
  schEditing: { lineMode: "90", mouseDragIsDrag: true, autoAnnotate: true, autoStartWires: true, escClearsNetHighlight: true, repeatX: 0, repeatY: 100 * 0.0254, repeatIncrement: 1,
    arcEditMode: "center", autoPlaceSheetPins: true, unconstrainedPinSwaps: false, sheetBorder: "", sheetBackground: "", newPowerSymbols: "default", pinSelectsSymbol: true,
    autoplaceFields: true, autoplaceJustify: true, autoplaceAlign: true, footprintPreview: true, neverShowRescue: false },
  schColors: { theme: "default", followDark: false, user: [] },
  pcbDisplay: { showPadNumbers: true, showNetNames: true, showPageLimits: true, netNamesMode: 3, trackClearance: 2, padClearance: true,
    viaColorForTHPads: false, forceShowFieldsWhenFPSelected: true, live3DRefresh: false,
    crossProbing: { onSelection: true, centerOnItems: true, zoomToFit: true, autoHighlight: true, flashSelection: false } },
  common: { hcDimming: 0.8 },
  symDisplay: { showHiddenPins: true, showHiddenFields: true, showETypes: true, showAltIcons: true },
  symEditing: { lineWidth: 0, textSize: 50 * 0.0254, pinLength: 100 * 0.0254, pinNumSize: 50 * 0.0254, pinNameSize: 50 * 0.0254, pinPitch: 100 * 0.0254, labelDelta: 1, dragPinsWithEdges: true },
  symColors: { useSch: true, theme: "default" },
  schFieldNames: [],
  pcbOrigin: { origin: "page", invertX: false, invertY: false },
  pcbEditing: { rotationAngle: 90, trackDragAction: "drag", ctrlClickHighlight: false, ratsnestThickness: 0.5, escClearsNetHighlight: true, showCourtyardCollisions: true, autoRefillZones: false },
  fpEditing: { rotationAngle: 90 },
  grids: {
    // APP_SETTINGS_BASE::DefaultGridSizeList and addParamsForWindow's defaultGridIdx (common/settings/app_settings.cpp):
    // eeschema / symbol_editor 100, 50, 25, 10 mil on 50 mil (index 1); pcbnew / footprint editor the 22 grids from
    // 1000 mil down to 0.01 mm on index 15 (0.5 mm), fast grids on that index and the next
    sch: schGrids(),
    pcb: pcbGrids(),
    sym: schGrids(),
    fp: pcbGrids(),
  },
  gal: { sch: galDefaults(), pcb: galDefaults(), sym: galDefaults(), fp: galDefaults() },
};
const KEY = "kui.prefs";
function merge<T>(def: T, got: unknown): T {
  if (Array.isArray(def)) return (Array.isArray(got) && got.length ? got : def) as T;
  if (def && typeof def === "object") { const out: Record<string, unknown> = {}; const g = (got && typeof got === "object" ? got : {}) as Record<string, unknown>; for (const [k, v] of Object.entries(def)) out[k] = merge(v, g[k]); return out as T; }
  return (typeof got === typeof def ? got : def) as T;
}
let cache: Prefs | null = null;
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
/** The board grid list and overrides the web editor kept before it took KiCad's list (no grid.last_size then). */
const LEGACY_PCB_SIZES = [0.25, 0.5, 1, 0.1, 0.05, 1.27, 0.635];
const OV_KEYS = ["connected", "wires", "vias", "text", "graphics"] as const;
/**
 * Settings saved before the grids kept grid.last_size: the editor opened the schematic on its second grid and the
 * board on its first.  An untouched old board list becomes KiCad's 22 grids with the same grid, fast grids and
 * override sizes picked again by value; a list the user changed is kept and opens on its first grid as before.
 */
function migrate(raw: unknown): unknown {
  // the old Mouse page (no left-drag setting yet) saved center_on_zoom = true although the wheel ignored it; the
  // browser cannot warp the pointer, so a centring zoom is opt-in here and those settings take the new default
  const mouse = raw && typeof raw === "object" ? (raw as { mouse?: Record<string, unknown> }).mouse : undefined;
  if (mouse && typeof mouse === "object" && !("leftDrag" in mouse)) delete mouse.centerOnZoom;
  const grids = raw && typeof raw === "object" ? (raw as { grids?: Record<string, Record<string, unknown>> }).grids : undefined;
  if (!grids || typeof grids !== "object") return raw;
  const sch = grids.sch; if (sch && typeof sch === "object" && typeof sch.last !== "number") sch.last = 1;
  const pcb = grids.pcb; if (!pcb || typeof pcb !== "object" || typeof pcb.last === "number") return raw;
  const sizes = Array.isArray(pcb.sizes) ? (pcb.sizes as unknown[]).map(Number) : [];
  if (sizes.length === LEGACY_PCB_SIZES.length && sizes.every((mm, i) => near(mm, LEGACY_PCB_SIZES[i]))) {
    const at = (i: unknown, fallback: number): number => { const mm = sizes[Number(i)]; const k = mm === undefined ? -1 : PCB_GRID_SIZES.findIndex((x) => near(x, mm)); return k >= 0 ? k : fallback; };
    pcb.sizes = PCB_GRID_SIZES.slice(); pcb.names = Array(PCB_GRID_SIZES.length).fill("");
    pcb.last = at(0, 15); pcb.fast1 = at(pcb.fast1, 15); pcb.fast2 = at(pcb.fast2, 16);
    const o = pcb.overrides as Record<string, unknown> | undefined;
    // the old overrides were all 0.25 mm: they take KiCad's sizes, keeping which ones are on
    if (o && typeof o === "object" && OV_KEYS.every((k) => near(Number(o[k + "Mm"]), 0.25))) for (const k of OV_KEYS) o[k + "Mm"] = (PCB_GRID_OVERRIDES as unknown as Record<string, number>)[k + "Mm"];
  } else pcb.last = 0;
  return raw;
}
/** names[] runs beside sizes[] (settings saved before grids had names have none) */
function normalize(p: Prefs): Prefs {
  for (const g of Object.values(p.grids)) { const n = g.names || []; g.names = g.sizes.map((_, i) => (typeof n[i] === "string" ? n[i] : "")); }
  for (const k of Object.keys(p.gal) as EditorId[]) p.gal[k] = clampGal(p.gal[k]);
  return p;
}
export function prefs(): Prefs {
  if (cache) return cache;
  let raw: unknown = null; try { raw = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { raw = null; }
  cache = normalize(merge(DEFAULT_PREFS, migrate(raw))); return cache;
}
export function savePrefs(p: Prefs): void {
  cache = normalize(merge(DEFAULT_PREFS, p)); try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* no storage */ }
  applyPrefs(true);
  // the Grids page's list selection is the current grid (PANEL_GRID_SETTINGS::TransferDataFromWindow sets grid.last_size)
  if (E.kdoc) { const mm = defaultGrid(); if (Math.abs(mm - E.gridPitch) > 1e-9) { E.gridPitch = mm; updateGridStatus(); requestRender(); } }
  // the Symbol Editor frame re-reads its own grids
  try { window.dispatchEvent(new Event("kc:prefs")); } catch (e) { /* no window */ }
}
export function clonePrefs(): Prefs { return JSON.parse(JSON.stringify(prefs())) as Prefs; }

/** The grids of one editor as KiCad's GRID list: size and name, in the list's order. */
export function gridDefs(g: GridPrefs): GridDef[] { return g.sizes.map((mm, i) => ({ mm, name: (g.names && g.names[i]) || "" })); }
/** GRID_MENU::BuildChoiceList's text for one grid, in the editor's current units ("1.2700 mm (50.00 mils)"). */
export function gridLabel(g: GridDef | number, ed: EditorId = editorId()): string {
  const units = (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units;
  return gridChoiceText(typeof g === "number" ? { mm: g } : g, units, (E.lastImperial === "in" ? "in" : "mil") as Units, scaleOf(ed));
}
/** COMMON_TOOLS::GridProperties: the Preferences page of each frame's grids. */
export const GRID_PAGE: Record<EditorId, string> = { sch: "Schematic Editor/Grids", pcb: "PCB Editor/Grids", sym: "Symbol Editor/Grids", fp: "Footprint Editor/Grids" };
/** The document's editor: the schematic, the board, or the Footprint Editor for a footprint (the Symbol Editor frame passes "sym" itself). */
export function editorId(): EditorId { return isSch() ? "sch" : E.DOC_TYPE === "footprint" ? "fp" : "pcb"; }
/** The grid the editor opens on (grid.last_size). */
export function defaultGrid(ed: EditorId = editorId()): number { const g = prefs().grids[ed]; return g.sizes[Math.max(0, Math.min(g.sizes.length - 1, g.last ?? 0))]; }
/** Remember the grid picked (KiCad saves grid.last_size with the window settings); nothing else is re-applied. */
export function rememberGrid(mm: number, ed: EditorId = editorId()): void {
  const p = prefs(), g = p.grids[ed], i = g.sizes.findIndex((x) => Math.abs(x - mm) < 1e-9); if (i < 0 || g.last === i) return;
  g.last = i; try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* no storage */ }
}

// ---- colour themes: the palettes and the switch live in web/domains/pcb/canvas/colors.ts (KiCadCanvas.setSchTheme); the painters
// rebuild geometry built under another theme.  Exports and plots keep KiCad Default unless they are told otherwise.
export const COLOR_THEMES: [SchThemeId, string][] = [["default", "KiCad Default"], ["classic", "KiCad Classic"], ["dark", "Dark"]];
/** The schematic theme the canvas should show: the chosen one, or the dark sheet while the UI is dark and the user asked to follow it. */
export function schThemeFor(p: Prefs, ui: "light" | "dark" = effectiveTheme()): SchThemeId {
  const t = schThemeList(p).some(([id]) => id === p.schColors.theme) ? p.schColors.theme : "default";
  return p.schColors.followDark && ui === "dark" ? "dark" : t;
}
/** Every theme the Theme list offers: the built-in ones (read-only), then the user's. */
export function schThemeList(p: Prefs): [SchThemeId, string][] { return [...COLOR_THEMES, ...(p.schColors.user || []).map((u) => [u.id, u.name] as [string, string])]; }
let followingUi = false;
/** the user themes' colours as last put into the canvas' table, to see an edit of the theme on show */
const registered = new Map<string, string>();
/** SETTINGS_MANAGER's colour settings: the user's themes go into the canvas' theme table (print and plot list them too). */
export function registerUserThemes(p: Prefs = prefs()): string[] {
  if (typeof KiCadCanvas === "undefined" || !KiCadCanvas.SCH_THEMES) return [];
  const changed: string[] = [], T = KiCadCanvas.SCH_THEMES;
  for (const u of p.schColors.user || []) {
    const stamp = JSON.stringify([u.name, u.colors]);
    if (registered.get(u.id) === stamp && T[u.id]) continue;
    T[u.id] = { name: u.name, dark: isDarkBackground(u.colors.bg || "#FFFFFF"), colors: { ...u.colors } }; registered.set(u.id, stamp); changed.push(u.id);
  }
  return changed;
}
function applyColorTheme(p: Prefs): void {
  if (typeof KiCadCanvas === "undefined" || !KiCadCanvas.setSchTheme) return;
  const changed = registerUserThemes(p), want = schThemeFor(p);
  // a theme on show whose colours were edited: the palette is filled again and the sheet's geometry rebuilt
  if (changed.includes(want) && KiCadCanvas.schTheme && KiCadCanvas.schTheme() === want) {
    KiCadCanvas.setSchTheme("default"); KiCadCanvas.setSchTheme(want);
    if (E.kdoc && E.kdoc.type === "sch") (E.kdoc as unknown as { schTheme?: string }).schTheme = "";
    requestRender();
  }
  if (KiCadCanvas.setSchTheme(want)) requestRender();
  // with "follow the app's dark mode" on, a UI theme change (menu, other tab, the system) swaps the sheet too
  if (!followingUi) { followingUi = true; subscribeTheme(() => applyColorTheme(prefs())); }
}

/** The pitch the cursor snaps to right now: the grid override of the active tool (or of the item being dragged), else the current grid. */
export function activeGridPitch(): number {
  const cur = E.gridPitch as number; if (!isSch()) return cur;
  const o = prefs().grids.sch.overrides; if (!o.enabled) return cur;
  let cls = schGridClassOfTool(String(E.tool));
  if (!cls && E.tool === "select") {
    const id = E.fdrag ? null : E.drag && E.drag.fp ? E.drag.fp.id : null;
    if (E.fdrag) cls = "text"; else { const it = id && E.kdoc ? E.kdoc.items.get(id) : null; if (it) cls = schGridClassOfKind(it.kind); }
  }
  return gridPitchFor(cls, o, cur);
}

/**
 * Push the preferences into the running editor.  `full` also sets the display toggles and the schematic's editing
 * modes (after OK in the dialog, and once when the page's first document opens) — otherwise a toolbar toggle made
 * since would be undone every time a sheet is entered.
 */
type PcbToolPrefState = { trackClearance?: number; padClearance?: boolean; rotationAngle?: number; fpRotationAngle?: number; trackDragAction?: string; showCourtyardCollisions?: boolean };
/** The board tools' copies of the preferences (they load lazily: dialogs/index.ts calls this again on "kc-pcb-tools"). */
export function applyPcbToolPrefs(p: Prefs = prefs()): void {
  const pcbS = CollabTools.pcb && (CollabTools.pcb.state as PcbToolPrefState); if (!pcbS) return;
  pcbS.trackClearance = p.pcbDisplay.trackClearance; pcbS.padClearance = p.pcbDisplay.padClearance !== false;
  pcbS.rotationAngle = p.pcbEditing.rotationAngle; pcbS.fpRotationAngle = p.fpEditing.rotationAngle; pcbS.trackDragAction = p.pcbEditing.trackDragAction;
  pcbS.showCourtyardCollisions = p.pcbEditing.showCourtyardCollisions;   // not LAYER_CONFLICTS_SHADOW's visibility: that is the Appearance eye's
}
export function applyPrefs(full = true): void {
  const p = prefs();
  // WX_VIEW_CONTROLS::LoadSettings: the wheel routing and the zoom controller (editor/wheel-model.ts) read these
  const m = p.mouse;
  E.wheel = { zoomMod: m.zoomMod, panHMod: m.panHMod, panVMod: m.panVMod, reverseZoom: m.reverseZoom, reversePanH: m.reversePanH, horizontalPan: m.horizontalPan,
    zoomAcceleration: m.zoomAccel, zoomSpeed: Math.max(1, Math.min(10, m.zoomSpeed)), zoomSpeedAuto: m.autoZoomSpeed, centerOnZoom: m.centerOnZoom, touchpadMode: m.touchpadMode };
  E.zoomController = null;
  E.middleDragPan = m.middleDrag !== "none"; E.rightDragPan = m.rightDrag !== "none";
  E.middleDrag = m.middleDrag; E.rightDrag = m.rightDrag; E.leftDrag = m.leftDrag; E.motionPanMod = m.motionPanMod;
  E.autoPan = m.autoPan; E.autoPanSpeed = m.autoPanSpeed;
  E.gridFor = activeGridPitch;
  applyColorTheme(p);
  E.pcbOrigin = p.pcbOrigin; publishUserOrigin();
  const ed = editorId(), g = p.grids[ed];
  if (E.kdoc) {
    const choices = gridDefs(g);
    GRID_CHOICES[gridListKey()] = choices;
    store.slice("viewport", { gridChoices: choices.map((c) => ({ ...c })) });
    E.renderOpts.gridAxes = !!g.axes;
    // PANEL_GAL_OPTIONS: GAL_DISPLAY_OPTIONS' grid look and the cursor
    const ga = p.gal[ed];
    Object.assign(E.renderOpts, { gridStyle: ga.style, gridMinSpacing: ga.minSpacing, gridLineWidth: ga.lineWidth, gridShowMajor: ga.showMajor });
    if (full) { E.crosshairMode = ga.crosshair; E.alwaysShowCursor = ga.alwaysShow; syncCrosshairRadio(); }
    if (!full) { /* grids and colours only */ }
    else if (isSch()) {
      E.renderOpts.showHiddenPins = p.schDisplay.showHiddenPins; E.renderOpts.showHiddenFields = p.schDisplay.showHiddenFields; E.renderOpts.pageLimits = p.schDisplay.showPageLimits;
      setToggles({ toggleHiddenPins: p.schDisplay.showHiddenPins, toggleHiddenFields: p.schDisplay.showHiddenFields });
      const sch = CollabTools.sch;
      if (sch) { try { const ctx = toolCtx(); sch.setLineMode(ctx, p.schEditing.lineMode); sch.setDragMode(ctx, p.schEditing.mouseDragIsDrag ? "drag" : "move"); const st = sch.state as { annotateAuto: boolean; autoStartWires: boolean; escClearsNetHighlight?: boolean; repeatOffset: [number, number]; repeatIncrement: number };
          st.annotateAuto = p.schEditing.autoAnnotate; st.autoStartWires = p.schEditing.autoStartWires; st.escClearsNetHighlight = p.schEditing.escClearsNetHighlight;
          st.repeatOffset = [p.schEditing.repeatX, p.schEditing.repeatY]; st.repeatIncrement = p.schEditing.repeatIncrement; syncSchModes(); } catch (e) { console.warn(e); } }
    } else {
      E.renderOpts.padNumbers = p.pcbDisplay.showPadNumbers; E.renderOpts.netNames = p.pcbDisplay.showNetNames; E.renderOpts.pageLimits = p.pcbDisplay.showPageLimits;
      E.renderOpts.netNamesMode = p.pcbDisplay.netNamesMode;
      (E.renderOpts as { hcDimming?: number }).hcDimming = p.common.hcDimming;
      E.renderOpts.ratsnestThickness = Math.max(0.5, Math.min(10, +p.pcbEditing.ratsnestThickness || 0.5));   // the spin control's 0.5..10
      E.escClearsHighlight = p.pcbEditing.escClearsNetHighlight; E.ctrlClickHighlight = p.pcbEditing.ctrlClickHighlight;
      applyPcbToolPrefs(p);
      setToggles({ showPadNumbers: p.pcbDisplay.showPadNumbers, showNetNames: p.pcbDisplay.showNetNames });
    }
    if (full) store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) });
  }
  setToggle("toggleGridOverrides", p.grids[ed].overrides.enabled);
  updateGridStatus(); requestRender();
}
/**
 * The View menu's crosshair modes and Always Show Crosshairs write the frame's cursor settings at once
 * (COMMON_TOOLS::CursorSmallCrosshairs ... galOpts.WriteConfig), without re-applying everything else.
 */
export function rememberCursor(c: Partial<Pick<GalPrefs, "crosshair" | "alwaysShow">>, ed: EditorId = editorId()): void {
  const p = prefs(); Object.assign(p.gal[ed], c);
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* no storage */ }
}
export function toggleGridOverrides(): boolean {
  const p = clonePrefs(), ed = editorId(); p.grids[ed].overrides.enabled = !p.grids[ed].overrides.enabled; savePrefs(p); return p.grids[ed].overrides.enabled;
}
/**
 * COMMON_TOOLS::GridFast1 / GridFast2 (Alt+1 / Alt+2) and GridFastCycle (Alt+4: fast grid 2 when on fast grid 1, else
 * fast grid 1).  The status bar's grid cell shows the change.
 */
export function fastGrid(n: 1 | 2 | "cycle"): number | null {
  const g = prefs().grids[editorId()];
  if (n === "cycle") { const cur = g.sizes.findIndex((s) => Math.abs(s - E.gridPitch) < 1e-9); n = cur === g.fast1 ? 2 : 1; }
  const idx = n === 1 ? g.fast1 : g.fast2, mm = g.sizes[idx]; if (!mm) return null;
  E.gridPitch = mm; rememberGrid(mm); updateGridStatus(); requestRender();
  // GridPreset( idx, aFromHotkey = true ) posts GridChangedByKeyEvent; only eeschema's SCH_EDITOR_CONTROL::GridFeedback
  // answers it, with the HOTKEY_CYCLE_POPUP "Grid" list of every grid (hotkey_feedback is on by default)
  // GRID::UserUnitsMessageText: each size in the frame's units only
  if (editorId() === "sch") { const u = (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units; hotkeyCyclePopup("Grid", g.sizes.map((x) => messageText(x, u, "sch")), idx); }
  return mm;
}
