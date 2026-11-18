// viewer3d/ui.ts — the "3D Viewer" window: KiCad's EDA_3D_VIEWER_FRAME rebuilt as a floating,
// draggable, resizable panel over the board editor.  Menus follow 3d-viewer/3d_viewer/3d_menubar.cpp,
// the top toolbar toolbars_3d.cpp, the labels / tooltips / hotkeys / icons tools/eda_3d_actions.cpp, and
// the right-hand panel the rows of dialogs/appearance_controls_3D.cpp that the web viewer can draw.
import { BACKGROUND_BOTTOM, BACKGROUND_TOP, DEFAULT_LAYER_COLORS, EXTRA_LAYERS, LAYER_COLORS, RGBA, cloneLayerColors, css, setColorOverride, setLayerColors, stackupOverride, type LayerColors } from "./colors";
import { GRID3D_CHOICES, type Grid3D } from "./grid";
import ICONS from "./icons.json";
import { BoardStats, DEFAULT_VISIBILITY, Visibility } from "./scene";
import { Viewer } from "./viewer";
import { IS_MAC, keyName, menuKey } from "../../../shared/keys";
import { advance, switcherFor, type SwitcherKind } from "../editor/view-switcher-model";
import { fitMenu, type MenuAnchor } from "../../../shared/menufit";
import "../../../shared/components/kselect";   // <k-select>, the themed drop-down (Presets, Viewports)
import { closeMark, maximizeMark, menuArrow, menuCheck } from "../../../shared/components/kicon-dom";

/** Move a name to the front of an MRU. */
function toFront(list: string[], name: string): void { const i = list.indexOf(name); if (i >= 0) list.splice(i, 1); list.unshift(name); }
/** KeyNameFromKeyCode( PRESET_SWITCH_KEY / VIEWPORT_SWITCH_KEY ): WXK_RAW_CONTROL and WXK_ALT on macOS, WXK_CONTROL and WXK_SHIFT elsewhere. */
export function switchKeyName(kind: SwitcherKind): string {
  return keyName(kind === "preset" ? (IS_MAC ? "RawCtrl+X" : "Ctrl+X") : (IS_MAC ? "Alt+X" : "Shift+X")).slice(0, -2);
}

export interface OpenOptions {
  /** the board document to show (window.KiCadCanvas doc); null when no board is open */
  getDoc(): KDoc | null;
  /** board file name, for the title bar and the exported image's name */
  getName?(): string;
  /** called with a function to run whenever the document changes; returns the unsubscribe */
  subscribe?(onChange: () => void): () => void;
  toast?(text: string, ms?: number): void;
  /** select the part with this reference in the board editor and bring it into view */
  selectRef?(ref: string): void;
  /** DIALOG_COLOR_PICKER (the editor's themed picker): r, g, b, a in 0..1; `done` on OK only */
  pickColor?(current: { r: number; g: number; b: number; a: number }, allowOpacity: boolean, done: (c: { r: number; g: number; b: number; a: number }) => void, def: { r: number; g: number; b: number; a: number }): void;
  /** wxTextEntryDialog (themed); `ok` with the text on OK */
  textEntry?(title: string, caption: string, value: string, ok: (text: string) => void): void;
  /** EDA_LIST_DIALOG (themed): pick one of `items` */
  listPick?(title: string, header: string, label: string, items: string[], ok: (item: string) => void): void;
  /** IsOK(): a Yes / No question */
  confirm?(message: string, yes: () => void): void;
  /** ACTIONS::openPreferences, on the 3D Viewer pages */
  openPreferences?(): void;
  /** the board editor's actions this window's Help menu shares (listHotKeys, about) */
  runAction?(id: string): void;
  /** external links of the Help menu (tables.ts LINKS) */
  links?: Record<string, string>;
  /** Follow PCB Editor: is a board layer visible in the board editor */
  layerVisible?(layer: string): boolean;
  /** Follow PCB Plot Settings: the layers the plot dialog plots */
  plotLayers?(): Promise<string[] | null>;
  /** Use board stackup colors: the board's physical stackup (Board Setup), name / type / color per layer */
  stackupLayers?(): Promise<{ name: string; type?: string; color?: string }[] | null>;
  /** Use board stackup colors: the stackup's copper_finish (BOARD_STACKUP m_FinishType) */
  stackupFinish?(): Promise<string | null>;
  /** Use PCB editor copper colors: the board editor's colour of a layer (CSS) */
  editorColor?(layer: string): string | null;
}

interface IconDef { vb?: string; light?: string; dark?: string }
const ICON_SET = ICONS as Record<string, IconDef>;

/** An action of the viewer: KiCad's friendly name, tooltip, icon and default hotkey. */
interface Action { id: string; label: string; tip?: string; icon?: string; key?: string; run(): void; checked?(): boolean; disabled?: string }
type MenuItem = Action | "-" | { label: string; icon?: string; sub: MenuItem[] };

const STYLE_ID = "v3d-style";
const CSS = `
.v3d-win{position:fixed;z-index:55;display:flex;flex-direction:column;min-width:420px;min-height:300px;background:var(--bench);color:var(--ink);
  border:1px solid var(--line);border-radius:var(--r-3);box-shadow:var(--shadow-dialog);font:12px var(--font);outline:none;overflow:hidden}
.v3d-win.v3d-max{border-radius:0}
.v3d-title{display:flex;align-items:center;gap:8px;padding:6px 8px 6px 10px;background:var(--paper);border-bottom:1px solid var(--line);cursor:move;user-select:none;font-weight:600;flex:none}
.v3d-title .v3d-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v3d-title button{all:unset;cursor:pointer;color:var(--ink-2);width:22px;height:20px;display:grid;place-items:center;border-radius:var(--r-2);font-size:14px;line-height:1}
.v3d-title button:hover{background:var(--line);color:var(--ink)}
.v3d-menubar{display:flex;gap:0;padding:0 4px;background:var(--bench);border-bottom:1px solid var(--line);flex:none;user-select:none}
.v3d-menubar>button{all:unset;padding:4px 9px;cursor:default;border-radius:var(--r-2)}
.v3d-menubar>button:hover,.v3d-menubar>button.open{background:var(--accent);color:var(--on-accent)}
.v3d-menu{position:fixed;z-index:70;min-width:230px;padding:4px 0;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:var(--r-3);box-shadow:var(--shadow);font:12px var(--font);user-select:none}
.v3d-menu .v3d-mi{display:grid;grid-template-columns:22px 1fr auto 12px;align-items:center;gap:6px;padding:3px 10px 3px 6px;cursor:default;white-space:nowrap;position:relative}
.v3d-menu .v3d-mi:hover{background:var(--accent);color:var(--on-accent)}
.v3d-menu .v3d-mi.dis{color:var(--ink-3)}
.v3d-menu .v3d-mi.dis:hover{background:none;color:var(--ink-3)}
.v3d-menu .v3d-mi .k{color:var(--ink-3);font-size:11px;padding-left:18px}
.v3d-menu .v3d-mi:hover .k{color:var(--on-accent)}
.v3d-menu .v3d-mi .chk{width:16px;text-align:center}
.v3d-menu hr{border:0;border-top:1px solid var(--line);margin:4px 0}
.v3d-ic{display:block;width:24px;height:24px}
.v3d-menu .v3d-ic{width:18px;height:18px}
.v3d-ic .dk{display:none}
:root[data-theme="dark"] .v3d-ic .lt{display:none}
:root[data-theme="dark"] .v3d-ic .dk{display:inline}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .v3d-ic .lt{display:none}:root:not([data-theme="light"]) .v3d-ic .dk{display:inline}}
.v3d-toolbar{display:flex;align-items:center;gap:1px;padding:2px 4px;background:var(--bench);border-bottom:1px solid var(--line);flex:none;flex-wrap:wrap}
.v3d-toolbar button{all:unset;width:28px;height:28px;display:grid;place-items:center;border-radius:var(--r-2);cursor:pointer}
.v3d-toolbar button:hover{background:var(--line)}
.v3d-toolbar button.on{background:var(--line);box-shadow:inset 0 0 0 1px var(--blue)}
.v3d-toolbar button.dis{opacity:.35;cursor:default}
.v3d-toolbar button.dis:hover{background:none}
.v3d-toolbar .sep{width:1px;height:20px;background:var(--line);margin:0 4px}
.v3d-body{flex:1;display:flex;min-height:0}
.v3d-stage{flex:1;min-width:0;position:relative;overflow:hidden}
.v3d-msg{position:absolute;inset:0;display:grid;place-items:center;color:#1b1b1b;font-size:13px;text-align:center;padding:20px;pointer-events:none}
.v3d-side{width:212px;flex:none;border-left:1px solid var(--line);background:var(--bench);overflow:auto;padding:6px 0}
.v3d-side h4{margin:2px 10px 6px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2)}
.v3d-row{display:grid;grid-template-columns:18px 18px 1fr;align-items:center;gap:6px;padding:2px 10px;cursor:default}
.v3d-row:hover{background:var(--paper)}
.v3d-row .sw{width:14px;height:14px;border:1px solid var(--line-2);border-radius:var(--r-1);box-sizing:border-box}
.v3d-row input[type=checkbox]{margin:0;width:14px;height:14px}
.v3d-side hr{border:0;border-top:1px solid var(--line);margin:6px 0}
.v3d-row .sw{cursor:pointer}
.v3d-opt{display:flex;align-items:center;gap:6px;padding:2px 10px;font-size:11px}
.v3d-opt input{margin:0;width:14px;height:14px}
.v3d-label{margin:8px 10px 2px;font-size:11px;color:var(--ink-2)}
.v3d-side k-select.v3d-choice{display:block;margin:0 10px;width:calc(100% - 20px)}
.v3d-status{display:flex;gap:16px;padding:3px 10px;border-top:1px solid var(--line);background:var(--bench);color:var(--ink-2);font:11px var(--mono);flex:none;white-space:nowrap;overflow:hidden}
.v3d-status .grow{flex:1;overflow:hidden;text-overflow:ellipsis}
.v3d-status a.v3d-ref{color:inherit;text-decoration:underline dotted;cursor:pointer}
.v3d-status a.v3d-ref:hover{color:var(--ink)}
.v3d-grip{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;z-index:2;
  background:linear-gradient(135deg,transparent 50%,var(--ink-3) 50%,var(--ink-3) 58%,transparent 58%,transparent 70%,var(--ink-3) 70%,var(--ink-3) 78%,transparent 78%)}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style"); s.id = STYLE_ID; s.textContent = CSS; document.head.appendChild(s);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e;
}

/** One of KiCad's icons (light and dark variants; the theme picks, as the editor chrome's KIcon does). */
function icon(name: string | undefined): HTMLElement {
  const wrap = el("span"); const ic = name ? ICON_SET[name] : undefined;
  if (!ic) return wrap;
  wrap.innerHTML = `<svg class="v3d-ic" viewBox="${ic.vb || "0 0 24 24"}" aria-hidden="true"><g class="lt">${ic.light || ic.dark || ""}</g><g class="dk">${ic.dark || ic.light || ""}</g></svg>`;
  return wrap.firstElementChild as HTMLElement;
}

/** Does a keyboard event match a hotkey in KiCad's notation ("Shift+Z", "Left", "Home")? */
function keyMatches(ev: KeyboardEvent, key: string): boolean {
  const parts = key.split("+"); const k = parts[parts.length - 1];
  const want = { shift: parts.includes("Shift"), ctrl: parts.includes("Ctrl"), alt: parts.includes("Alt") };
  if (ev.shiftKey !== want.shift || (ev.ctrlKey || ev.metaKey) !== want.ctrl || ev.altKey !== want.alt) return false;
  const named: Record<string, string> = { Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown", Home: "Home" };
  if (named[k]) return ev.key === named[k];
  return ev.key.toUpperCase() === k.toUpperCase();
}

/** The status bar's line about the parts' 3D models.  With `pick`, each reference is a link that selects its part. */
function modelStatus(st: BoardStats, pick?: (ref: string) => void): Node[] {
  const out: Node[] = [document.createTextNode(`3D models: ${st.models} of ${st.bodies} parts`)];
  const list = (lead: string, refs: string[], what: string) => {
    if (!refs.length) return;
    out.push(document.createTextNode(`  —  ${lead} `));
    refs.slice(0, 8).forEach((ref, i) => {
      if (i) out.push(document.createTextNode(", "));
      if (!pick) { out.push(document.createTextNode(ref)); return; }
      const a = document.createElement("a"); a.href = "#"; a.className = "v3d-ref"; a.textContent = ref; a.title = `Select ${ref} in the board editor (${what})`;
      a.addEventListener("click", (ev) => { ev.preventDefault(); pick(ref); });
      out.push(a);
    });
    if (refs.length > 8) out.push(document.createTextNode(` and ${refs.length - 8} more`));
  };
  list("closest library model used for", st.replacedModels || [], "its own model is not in the library");
  list("drawn from the footprint for", st.generatedModels || [], "no model exists, so one was drawn from its pads, name and datasheet");
  list("plain shape for", st.missingModels, "no model could be found");
  return out;
}

/** EDA_3D_VIEWER_SETTINGS as the web keeps it (localStorage "kui.v3d"): the appearance, the layer presets and viewports. */
interface Preset3D { name: string; vis: Partial<Visibility>; colors: Record<string, RGBA> }
interface Viewport3D { name: string; q: number[]; cam: number[]; ortho: boolean }
export interface Settings3D { vis?: Partial<Visibility>; colors?: Record<string, RGBA>; bg?: [RGBA, RGBA]; grid?: Grid3D; presets?: Preset3D[]; viewports?: Viewport3D[]; preset?: string; useStackup?: boolean; useEditorCopper?: boolean }
const SETTINGS_KEY = "kui.v3d";
export function loadSettings3D(): Settings3D { try { const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); return v && typeof v === "object" ? v as Settings3D : {}; } catch { return {}; } }
function saveSettings3D(s: Settings3D): void { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* no storage */ } }
const FOLLOW_PCB = "Follow PCB Editor", FOLLOW_PLOT = "Follow PCB Plot Settings";

/**
 * BOARD_ADAPTER::GetVisibleLayers for a FOLLOW_PCB / FOLLOW_PLOT_SETTINGS preset: the 3D layers that follow from the
 * board layers shown (`on`), the models left as they are.
 */
export function visibilityFromLayers(on: (layer: string) => boolean, cur: Visibility): Visibility {
  const v: Visibility = { ...cur };
  v.copperTop = on("F.Cu"); v.copperBottom = on("B.Cu"); v.silkTop = on("F.SilkS"); v.silkBottom = on("B.SilkS");
  v.maskTop = on("F.Mask"); v.maskBottom = on("B.Mask"); v.paste = on("F.Paste") || on("B.Paste");
  v.extra = EXTRA_LAYERS.filter((x) => x.layers.some(on)).map((x) => x.key);
  return v;
}

/** "#rrggbb", "#rrggbbaa" or "rgb(a)(…)" to RGBA. */
function parseCss(c: string | null): RGBA | null {
  if (!c) return null;
  const hx = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
  if (hx) { const n = parseInt(hx[1], 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, hx[2] ? parseInt(hx[2], 16) / 255 : 1]; }
  const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/i.exec(c);
  return m ? [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] ? +m[4] : 1] : null;
}

export class ViewerWindow {
  readonly root: HTMLDivElement;
  readonly viewer: Viewer | null = null;
  private opts: OpenOptions;
  private actions = new Map<string, Action>();
  private toolButtons = new Map<string, HTMLButtonElement>();
  private nameEl: HTMLElement; private stage: HTMLDivElement; private side: HTMLDivElement; private statusEl: HTMLElement; private zoomEl: HTMLElement;
  private menu: HTMLElement[] = [];
  private menuButton: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private reloadTimer = 0;
  private restore: { left: string; top: string; width: string; height: string } | null = null;
  private onDocPointer = (ev: Event) => { if (this.menu.length && !this.menu.some((m) => m.contains(ev.target as Node)) && !(this.menuButton && this.menuButton.contains(ev.target as Node))) this.closeMenu(); };
  private onWinResize = () => this.clamp();
  closed = false;
  private settings: Settings3D = loadSettings3D();
  /** "Use board stackup colors": on unless turned off, as in KiCad (EDA_3D_VIEWER_SETTINGS use_stackup_colors defaults to true),
   *  so a board with a black mask in its Board Setup is drawn black. */
  private get useStackup(): boolean { return this.settings.useStackup !== false; }
  /** the layer preset shown in the Presets choice ("" when the appearance was changed since) */
  private presetName = "";
  /** APPEARANCE_CONTROLS_3D m_presetMRU / m_viewportMRU: names applied most recently first (this session) */
  private psMru: string[] = [];
  private vpMru: string[] = [];
  /** the open EDA_VIEW_SWITCHER */
  private switcher: { kind: SwitcherKind; items: string[]; sel: number; el: HTMLElement; list: HTMLElement; key: "Control" | "Shift" | "Alt" } | null = null;
  private presetSel: HTMLElement | null = null;
  private viewportSel: HTMLElement | null = null;
  /** the last build's statistics and time (tests) */
  lastBuildMs = 0;
  builds = 0;

  constructor(opts: OpenOptions) {
    ensureStyle();
    this.opts = opts;
    const root = this.root = el("div", "v3d-win"); root.tabIndex = -1; root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "3D Viewer");
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.max(480, Math.min(1100, Math.round(vw * 0.62))), h = Math.max(360, Math.min(820, Math.round(vh * 0.72)));
    root.style.width = w + "px"; root.style.height = h + "px";
    root.style.left = Math.max(8, Math.round((vw - w) / 2)) + "px"; root.style.top = Math.max(8, Math.round((vh - h) / 2)) + "px";

    // ---- title bar
    const title = el("div", "v3d-title"); title.appendChild(icon("three_d"));
    this.nameEl = el("span", "v3d-name"); title.appendChild(this.nameEl);
    const maxBtn = el("button", "v3d-maxbtn"); maxBtn.appendChild(maximizeMark()); maxBtn.title = "Maximize"; maxBtn.setAttribute("aria-label", "Maximize"); maxBtn.addEventListener("click", () => this.toggleMaximize());
    const closeBtn = el("button", "v3d-close"); closeBtn.appendChild(closeMark()); closeBtn.title = "Close"; closeBtn.setAttribute("aria-label", "Close"); closeBtn.addEventListener("click", () => this.close());
    title.append(maxBtn, closeBtn); root.appendChild(title);
    title.addEventListener("dblclick", (ev) => { if (!(ev.target as HTMLElement).closest("button")) this.toggleMaximize(); });
    this.bindDrag(title);

    this.stage = el("div", "v3d-stage"); this.side = el("div", "v3d-side");
    try {
      this.viewer = new Viewer(this.stage);
      this.viewer.useModels(true);
      this.viewer.onModels = (st) => this.statusEl.replaceChildren(...modelStatus(st, this.opts.selectRef));
      this.restoreSettings();
    }
    catch (e) { console.warn("3D viewer: WebGL is not available", e); const m = el("div", "v3d-msg", "The 3D viewer needs WebGL, which this browser could not start."); this.stage.appendChild(m); }
    this.defineActions();

    // ---- menu bar, toolbar
    const menubar = el("div", "v3d-menubar");
    for (const [label, items] of this.menus()) {
      const b = el("button", undefined, label);
      b.addEventListener("pointerdown", (ev) => { ev.preventDefault(); if (this.menuButton === b) this.closeMenu(); else this.openMenu(b, items); });
      b.addEventListener("pointerenter", () => { if (this.menuButton && this.menuButton !== b) this.openMenu(b, items); });
      menubar.appendChild(b);
    }
    root.appendChild(menubar);
    root.appendChild(this.buildToolbar());

    // ---- body: canvas + appearance panel, status bar
    const body = el("div", "v3d-body"); body.append(this.stage, this.side); root.appendChild(body);
    this.buildAppearance();
    const status = el("div", "v3d-status"); this.statusEl = el("span", "grow"); this.zoomEl = el("span");
    status.append(this.statusEl, this.zoomEl); root.appendChild(status);
    const grip = el("div", "v3d-grip"); root.appendChild(grip); this.bindResize(grip);

    // EDA_3D_CONTROLLER's context menu: a right click that did not drag (a right drag pans)
    let rdown: { x: number; y: number } | null = null;
    this.stage.addEventListener("pointerdown", (ev) => { if (ev.button === 2) rdown = { x: ev.clientX, y: ev.clientY }; }, true);
    this.stage.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const moved = rdown ? Math.hypot(ev.clientX - rdown.x, ev.clientY - rdown.y) > 4 : false; rdown = null;
      if (moved || !this.viewer) return;
      this.closeMenu(); this.showMenu(this.contextItems(), { at: { x: ev.clientX, y: ev.clientY } }, 0);
    });
    root.addEventListener("keydown", (ev) => this.onKey(ev));
    root.addEventListener("keyup", (ev) => this.onKeyUp(ev));
    root.addEventListener("focusout", (ev) => { if (!root.contains(ev.relatedTarget as Node | null)) this.closeSwitcher(false); });
    // keep the keyboard on the viewer while the pointer works in it (the board editor's keys must not fire)
    root.addEventListener("pointerdown", (ev) => { const t = ev.target as HTMLElement; if (!t.closest("input,select,k-select,textarea")) setTimeout(() => { if (!this.closed && !root.contains(document.activeElement)) root.focus({ preventScroll: true }); }, 0); }, true);
    document.addEventListener("pointerdown", this.onDocPointer, true);
    window.addEventListener("resize", this.onWinResize);
    document.body.appendChild(root);
    if (this.viewer) this.viewer.onFrame = () => { this.zoomEl.textContent = "Zoom " + this.viewer!.zoomLevel.toFixed(2); };
    this.syncToggles(); this.updateTitle();
    root.focus({ preventScroll: true });
    if (opts.subscribe) this.unsubscribe = opts.subscribe(() => this.scheduleReload());
    this.reload(true);
    if (this.useStackup || this.settings.useEditorCopper) void this.refreshOverrides();
  }

  // ---------------------------------------------------------------- actions

  private defineActions(): void {
    const v = this.viewer;
    const add = (a: Action) => { this.actions.set(a.id, a); };
    const vis = (key: keyof Visibility) => () => { if (v) { v.setVisibility({ [key]: !v.visibility[key] }); this.appearanceChanged(); } };
    add({ id: "reloadBoard", label: "Reload board", tip: "Reload board and refresh 3D view", icon: "import3d", run: () => this.reload(false) });
    add({ id: "copyToClipboard", label: "Copy 3D image to clipboard", tip: "Copy the current 3D image to the clipboard", icon: "copy", key: "Ctrl+C", run: () => { void this.copyImage(); } });
    add({ id: "exportImage", label: "Export Image...", tip: "Export the Current View as an image file", icon: "export_file", run: () => { void this.exportImage(); } });
    add({ id: "toggleRaytacing", label: "Use raytracing", tip: "Render current view using Raytracing", icon: "ray_tracing", run: () => {}, disabled: "Raytracing runs in the desktop app" });
    add({ id: "zoomRedraw", label: "Refresh", icon: "refresh", key: "F5", run: () => { if (v) v.requestRender(); } });
    add({ id: "zoomInCenter", label: "Zoom In", icon: "zoom_in", key: "+", run: () => { if (v) v.zoomIn(); } });
    add({ id: "zoomOutCenter", label: "Zoom Out", icon: "zoom_out", key: "-", run: () => { if (v) v.zoomOut(); } });
    add({ id: "zoomFitScreen", label: "Zoom to Fit", icon: "zoom_fit_in_page", key: "Home", run: () => { if (v) v.fit(); } });
    add({ id: "rotateXCW", label: "Rotate X Clockwise", icon: "rotate_cw_x", run: () => { if (v) v.rotate("x", true); } });
    add({ id: "rotateXCCW", label: "Rotate X Counterclockwise", icon: "rotate_ccw_x", run: () => { if (v) v.rotate("x", false); } });
    add({ id: "rotateYCW", label: "Rotate Y Clockwise", icon: "rotate_cw_y", run: () => { if (v) v.rotate("y", true); } });
    add({ id: "rotateYCCW", label: "Rotate Y Counterclockwise", icon: "rotate_ccw_y", run: () => { if (v) v.rotate("y", false); } });
    add({ id: "rotateZCW", label: "Rotate Z Clockwise", icon: "rotate_cw_z", key: "Shift+R", run: () => { if (v) v.rotate("z", true); } });
    add({ id: "rotateZCCW", label: "Rotate Z Counterclockwise", icon: "rotate_ccw_z", key: "R", run: () => { if (v) v.rotate("z", false); } });
    add({ id: "flipView", label: "Flip Board", tip: "Flip the board view", icon: "flip_board", key: "F", run: () => { if (v) v.flip(); } });
    add({ id: "moveLeft", label: "Move Board Left", icon: "left", key: "Left", run: () => { if (v) v.move(-1, 0); } });
    add({ id: "moveRight", label: "Move Board Right", icon: "right", key: "Right", run: () => { if (v) v.move(1, 0); } });
    add({ id: "moveUp", label: "Move Board Up", icon: "up", key: "Up", run: () => { if (v) v.move(0, 1); } });
    add({ id: "moveDown", label: "Move Board Down", icon: "down", key: "Down", run: () => { if (v) v.move(0, -1); } });
    add({ id: "toggleOrtho", label: "Toggle Orthographic Projection", tip: "Enable/disable orthographic projection", icon: "ortho", run: () => { if (v) { v.setOrtho(!v.ortho); this.syncToggles(); } }, checked: () => !!v && v.ortho });
    add({ id: "showLayersManager", label: "Show Appearance Manager", tip: "Show/hide the appearance manager", icon: "layers_manager", run: () => { this.side.style.display = this.side.style.display === "none" ? "" : "none"; this.syncToggles(); if (v) v.resize(); }, checked: () => this.side.style.display !== "none" });
    add({ id: "viewTop", label: "View Top", icon: "axis3d_top", key: "Z", run: () => { if (v) v.view("top"); } });
    add({ id: "viewBottom", label: "View Bottom", icon: "axis3d_bottom", key: "Shift+Z", run: () => { if (v) v.view("bottom"); } });
    add({ id: "viewRight", label: "View Right", icon: "axis3d_right", key: "X", run: () => { if (v) v.view("right"); } });
    add({ id: "viewLeft", label: "View Left", icon: "axis3d_left", key: "Shift+X", run: () => { if (v) v.view("left"); } });
    add({ id: "viewFront", label: "View Front", icon: "axis3d_front", key: "Y", run: () => { if (v) v.view("front"); } });
    add({ id: "viewBack", label: "View Back", icon: "axis3d_back", key: "Shift+Y", run: () => { if (v) v.view("back"); } });
    add({ id: "showTHT", label: "Show Through Hole 3D Models", tip: "Show 3D models for 'Through hole' type footprints", icon: "show_tht", key: "T", run: vis("tht"), checked: () => !!v && v.visibility.tht });
    add({ id: "showSMD", label: "Show SMD 3D Models", tip: "Show 3D models for 'Surface mount' type footprints", icon: "show_smt", key: "S", run: vis("smd"), checked: () => !!v && v.visibility.smd });
    add({ id: "showVirtual", label: "Show Unspecified 3D Models", tip: "Show 3D models for 'unspecified' type footprints", icon: "show_other", key: "V", run: vis("virtual"), checked: () => !!v && v.visibility.virtual });
    add({ id: "resetDefaults", label: "Reset to Default Settings", icon: "tools", run: () => this.resetDefaults() });
    // View > 3D Grid (EDA_3D_ACTIONS::noGrid … show1mmGrid, check items)
    const gridLabel: Record<number, [string, string]> = { 0: ["noGrid", "No 3D Grid"], 10: ["show10mmGrid", "3D Grid 10mm"], 5: ["show5mmGrid", "3D Grid 5mm"], 2.5: ["show2_5mmGrid", "3D Grid 2.5mm"], 1: ["show1mmGrid", "3D Grid 1mm"] };
    for (const g of GRID3D_CHOICES) add({ id: gridLabel[g][0], label: gridLabel[g][1], run: () => { if (v) { v.setGrid(g); this.save(); } }, checked: () => !!v && v.grid === g });
    add({ id: "toggleShowMissingModels", label: "Show parts without 3D model", tip: "Display a placeholder for footprints with missing 3D models", run: vis("missing"), checked: () => !!v && v.visibility.missing });
    add({ id: "showNotInPosFile", label: "Show 3D Models not in POS File", tip: "Show 3D models even if not found in .pos file", icon: "show_not_in_posfile", key: "P", run: vis("notInPos"), checked: () => !!v && v.visibility.notInPos });
    add({ id: "showDNP", label: "Show 3D Models marked DNP", tip: "Show 3D models even if marked 'Do Not Place'", icon: "show_dnp", key: "D", run: vis("dnp"), checked: () => !!v && v.visibility.dnp });
    add({ id: "showBBoxes", label: "Show Model Bounding Boxes", tip: "Show 3D model bounding boxes in realtime renderer", icon: "ortho", run: vis("bbox"), checked: () => !!v && v.visibility.bbox });
    add({ id: "openPreferences", label: "Preferences...", tip: "Show preferences for all open tools", icon: "preference", key: "Ctrl+,", run: () => { if (this.opts.openPreferences) this.opts.openPreferences(); }, disabled: this.opts.openPreferences ? undefined : "Preferences are set from the board editor" });
    // AddStandardHelpMenu
    const link = (id: string) => () => { const u = this.opts.links && this.opts.links[id]; if (u) window.open(u, "_blank", "noopener"); };
    add({ id: "help", label: "Help", tip: "Open product documentation in a web browser", icon: "help_online", run: link("help") });
    add({ id: "gettingStarted", label: "Getting Started with KiCad", tip: "Open \"Getting Started in KiCad\" guide for beginners", icon: "help", run: link("gettingStarted") });
    add({ id: "listHotKeys", label: "List Hotkeys...", tip: "Displays current hotkeys table and corresponding commands", icon: "hotkeys", key: "Ctrl+F1", run: () => { if (this.opts.runAction) this.opts.runAction("listHotKeys"); } });
    add({ id: "getInvolved", label: "Get Involved", tip: "Open \"Contribute to KiCad\" in a web browser", icon: "info", run: link("getInvolved") });
    add({ id: "donate", label: "Donate", tip: "Open \"Donate to KiCad\" in a web browser", run: link("donate") });
    add({ id: "reportBug", label: "Report Bug", tip: "Report a problem with KiCad", icon: "bug", run: link("reportBug") });
    add({ id: "about", label: "About Junction", icon: "about", run: () => { if (this.opts.runAction) this.opts.runAction("about"); } });
    add({ id: "close", label: "Close", icon: "exit", run: () => this.close() });
  }

  /** Run an action by KiCad's id (also the test seam). */
  run(id: string): boolean { const a = this.actions.get(id); if (!a || a.disabled) return false; a.run(); return true; }

  private menus(): [string, MenuItem[]][] {
    const a = (id: string): Action => this.actions.get(id) as Action;
    return [
      ["File", [a("exportImage"), "-", a("close")]],
      ["Edit", [a("copyToClipboard")]],
      ["View", [a("zoomInCenter"), a("zoomOutCenter"), a("zoomFitScreen"), a("zoomRedraw"), "-",
        { label: "3D Grid", icon: "grid", sub: [a("noGrid"), a("show10mmGrid"), a("show5mmGrid"), a("show2_5mmGrid"), a("show1mmGrid")] }, "-",
        a("viewTop"), a("viewBottom"), a("viewRight"), a("viewLeft"), a("viewFront"), a("viewBack"), "-",
        { label: "Rotate Board", icon: "rotate_cw", sub: [a("rotateXCW"), a("rotateXCCW"), "-", a("rotateYCW"), a("rotateYCCW"), "-", a("rotateZCW"), a("rotateZCCW")] },
        a("flipView"),
        { label: "Move Board", icon: "move", sub: [a("moveLeft"), a("moveRight"), a("moveUp"), a("moveDown")] }, "-",
        a("showLayersManager")]],
      ["Preferences", [a("toggleRaytacing"), a("toggleShowMissingModels"), a("openPreferences"), a("resetDefaults"), "-",
        { label: "Set Language", sub: [{ id: "languageEnglish", label: "English", run: () => {}, checked: () => true }] }]],
      ["Help", [a("help"), a("gettingStarted"), a("listHotKeys"), a("getInvolved"), a("donate"), a("reportBug"), "-", a("about")]],
    ];
  }

  /** EDA_3D_CONTROLLER's canvas context menu (eda_3d_controller.cpp:64-81). */
  private contextItems(): MenuItem[] {
    const a = (id: string): Action => this.actions.get(id) as Action;
    return [a("zoomInCenter"), a("zoomOutCenter"), "-",
      a("viewTop"), a("viewBottom"), a("viewRight"), a("viewLeft"), a("viewFront"), a("viewBack"), "-",
      { label: "Rotate Board", icon: "rotate_cw", sub: [a("rotateXCW"), a("rotateXCCW"), "-", a("rotateYCW"), a("rotateYCCW"), "-", a("rotateZCW"), a("rotateZCCW")] },
      a("flipView"),
      { label: "Move Board", icon: "move", sub: [a("moveLeft"), a("moveRight"), a("moveUp"), a("moveDown")] }];
  }

  private buildToolbar(): HTMLElement {
    const bar = el("div", "v3d-toolbar");
    // toolbars_3d.cpp TOOLBAR_LOC::TOP_MAIN, separators included
    const order = ["reloadBoard", "-", "copyToClipboard", "-", "toggleRaytacing", "-", "zoomRedraw", "zoomInCenter", "zoomOutCenter", "zoomFitScreen", "-",
      "rotateXCW", "rotateXCCW", "-", "rotateYCW", "rotateYCCW", "-", "rotateZCW", "rotateZCCW", "-", "flipView", "-",
      "moveLeft", "moveRight", "moveUp", "moveDown", "-", "toggleOrtho", "-", "showLayersManager"];
    for (const id of order) {
      if (id === "-") { bar.appendChild(el("span", "sep")); continue; }
      const a = this.actions.get(id); if (!a) continue;
      const b = el("button"); b.dataset.action = id; b.appendChild(icon(a.icon));
      b.title = a.disabled || ((a.tip || a.label) + (a.key ? "  (" + keyName(a.key) + ")" : "")); b.setAttribute("aria-label", a.label);
      if (a.disabled) b.classList.add("dis");
      b.addEventListener("click", () => { if (!a.disabled) a.run(); });
      this.toolButtons.set(id, b); bar.appendChild(b);
    }
    return bar;
  }

  private syncToggles(): void {
    for (const [id, b] of this.toolButtons) { const a = this.actions.get(id); if (a && a.checked) b.classList.toggle("on", a.checked()); }
    const v = this.viewer; if (!v) return;
    this.side.querySelectorAll<HTMLInputElement>("input[data-vis]").forEach((i) => { const k = i.dataset.vis || ""; i.checked = k.startsWith("x:") ? v.visibility.extra.includes(k.slice(2)) : !!v.visibility[k as keyof Visibility]; });
  }

  // ---------------------------------------------------------------- appearance panel

  private buildAppearance(): void {
    const side = this.side; side.replaceChildren(); const v = this.viewer;
    side.appendChild(el("h4", undefined, "Appearance"));
    const layers = el("div", "v3d-layers"); side.appendChild(layers);
    // APPEARANCE_CONTROLS_3D::OnLayerContextMenu: Show / Hide All Copper Layers, and Show / Hide All Inner Layers,
    // enabled when GetCopperLayerCount() > 2.  The inner layers' visibility is kept (copperInner) and saved with the
    // presets; the web viewer does not draw inner copper, so it has nothing to show or hide yet.
    layers.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const set = (vis: Partial<Visibility>) => () => { if (v) { v.setVisibility(vis); this.appearanceChanged(); } };
      const doc = this.opts.getDoc(), inner = !!doc && Array.isArray((doc as { copper?: string[] }).copper) && (doc as { copper: string[] }).copper.length > 2;
      const noInner = inner ? undefined : "The board has no inner copper layers";
      this.closeMenu();
      this.showMenu([{ id: "showAllCopper", label: "Show All Copper Layers", run: set({ copperTop: true, copperBottom: true, ...(inner ? { copperInner: true } : {}) }) },
        { id: "hideAllCopper", label: "Hide All Copper Layers", run: set({ copperTop: false, copperBottom: false, ...(inner ? { copperInner: false } : {}) }) }, "-",
        { id: "showAllInner", label: "Show All Inner Layers", run: set({ copperInner: true }), disabled: noInner },
        { id: "hideAllInner", label: "Hide All Inner Layers", run: set({ copperInner: false }), disabled: noInner }], { at: { x: ev.clientX, y: ev.clientY } }, 0);
    });
    const enabled = this.enabledLayers();
    // a swatch (left double click or middle click opens the colour picker), the eye checkbox, the label
    const swatchFor = (key: string, opacity: boolean): HTMLElement => {
      const sw = el("span", "sw"); sw.dataset.color = key; sw.title = "Left double click or middle click to change color";
      const paint = () => { const c = LAYER_COLORS[key]; sw.style.background = c[3] >= 1 ? css(c, 1) : `linear-gradient(${css(c)},${css(c)}),repeating-conic-gradient(#c0c0c0 0 25%,#fff 0 50%) 0 0/6px 6px`; };
      const open = (ev: Event) => {
        ev.preventDefault(); ev.stopPropagation();
        if (!this.opts.pickColor) return;
        const c = LAYER_COLORS[key], d = DEFAULT_LAYER_COLORS[key];
        this.opts.pickColor({ r: c[0], g: c[1], b: c[2], a: c[3] }, opacity, (n) => { setLayerColors({ [key]: [n.r, n.g, n.b, n.a] }); paint(); this.appearanceChanged(true); }, { r: d[0], g: d[1], b: d[2], a: d[3] });
      };
      sw.addEventListener("dblclick", open); sw.addEventListener("auxclick", (ev) => { if ((ev as MouseEvent).button === 1) open(ev); });
      sw.addEventListener("click", (ev) => ev.preventDefault());
      paint(); return sw;
    };
    const row = (host: HTMLElement, label: string, tip: string, sw: HTMLElement | null, checked: boolean, set: (on: boolean) => void, data?: string): void => {
      const r = el("label", "v3d-row"); r.title = tip;
      const cb = el("input"); cb.type = "checkbox"; cb.checked = checked; if (data) cb.dataset.vis = data;
      cb.addEventListener("change", () => { set(cb.checked); this.appearanceChanged(); });
      r.append(sw || el("span"), cb, el("span", undefined, label)); host.appendChild(r);
    };
    const visRow = (label: string, key: keyof Visibility, color: string | null, tip: string, opacity = false) =>
      row(layers, label, tip, color ? swatchFor(color, opacity) : null, v ? !!v.visibility[key] : !!DEFAULT_VISIBILITY[key], (on) => { if (v) v.setVisibility({ [key]: on }); }, key);
    const extraRow = (key: string) => {
      const x = EXTRA_LAYERS.find((e) => e.key === key); if (!x) return;
      const cur = v ? v.visibility.extra : DEFAULT_VISIBILITY.extra;
      row(layers, x.label, x.tip, swatchFor(key, false), cur.includes(key), (on) => { if (!v) return; const list = v.visibility.extra.filter((k) => k !== key); if (on) list.push(key); v.setVisibility({ extra: list }); }, "x:" + key);
    };
    // appearance_controls_3D.cpp s_layerSettings, in its order; the user layers only when the board enables them
    visRow("Board Body", "board", "board", "Show board body", true);
    visRow("Plated Barrels", "barrels", "copper", "Show barrels of plated through-holes and vias");
    visRow("F.Cu", "copperTop", "copper", "Show front copper / surface finish color");
    visRow("B.Cu", "copperBottom", "copper", "Show back copper / surface finish color");
    extraRow("adhesive");
    visRow("Solder Paste", "paste", "paste", "Show solder paste");
    visRow("F.Silkscreen", "silkTop", "silkTop", "Show front silkscreen");
    visRow("B.Silkscreen", "silkBottom", "silkBottom", "Show back silkscreen");
    visRow("F.Mask", "maskTop", "maskTop", "Show front solder mask", true);
    visRow("B.Mask", "maskBottom", "maskBottom", "Show back solder mask", true);
    for (const x of EXTRA_LAYERS) if (x.key !== "adhesive" && (!x.key.startsWith("User.") || !enabled || enabled.has(x.key))) extraRow(x.key);
    layers.appendChild(el("hr"));
    visRow("Through-hole Models", "tht", null, "Show 3D models for 'Through hole' type footprints");
    visRow("SMD Models", "smd", null, "Show 3D models for 'Surface mount' type footprints");
    visRow("Virtual Models", "virtual", null, "Show 3D models for 'unspecified' type footprints");
    visRow("Models not in POS File", "notInPos", null, "Show 3D models even if not found in .pos file");
    visRow("Models marked DNP", "dnp", null, "Show 3D models even if marked 'Do Not Place'");
    visRow("Model Bounding Boxes", "bbox", null, "Show 3D model bounding boxes in realtime renderer");
    layers.appendChild(el("hr"));
    const bg = (label: string, tip: string, which: 0 | 1) => {
      const r = el("label", "v3d-row"); r.title = tip;
      const sw = el("span", "sw"); sw.dataset.bg = which ? "bottom" : "top"; sw.title = "Left double click or middle click to change color";
      const cur = (): RGBA => (v ? (which ? v.background.bottom : v.background.top) : (which ? BACKGROUND_BOTTOM : BACKGROUND_TOP));
      const paint = () => { sw.style.background = css(cur(), 1); };
      const open = (ev: Event) => {
        ev.preventDefault(); ev.stopPropagation(); if (!v || !this.opts.pickColor) return;
        const c = cur(), d = which ? BACKGROUND_BOTTOM : BACKGROUND_TOP;
        this.opts.pickColor({ r: c[0], g: c[1], b: c[2], a: 1 }, false, (n) => { const x: RGBA = [n.r, n.g, n.b, 1]; if (which) v.setBackground(v.background.top, x); else v.setBackground(x, v.background.bottom); paint(); this.save(); }, { r: d[0], g: d[1], b: d[2], a: 1 });
      };
      sw.addEventListener("dblclick", open); sw.addEventListener("auxclick", (ev) => { if ((ev as MouseEvent).button === 1) open(ev); });
      paint(); r.append(sw, el("span"), el("span", undefined, label)); layers.appendChild(r);
    };
    bg("Background Start", "Background gradient start color", 0);
    bg("Background End", "Background gradient end color", 1);
    // the display options under the list (m_cbUseBoardStackupColors, m_cbUseBoardEditorCopperColors)
    const opt = (label: string, tip: string, key: "useStackup" | "useEditorCopper") => {
      const r = el("label", "v3d-opt"); r.title = tip; const cb = el("input"); cb.type = "checkbox"; cb.dataset.opt = key; cb.checked = key === "useStackup" ? this.useStackup : !!this.settings[key];
      cb.addEventListener("change", () => { this.settings[key] = cb.checked; this.save(); void this.refreshOverrides(); });
      r.append(cb, el("span", undefined, label)); side.appendChild(r);
    };
    opt("Use board stackup colors", "Use the colors of the board's physical stackup (Board Setup)", "useStackup");
    opt("Use PCB editor copper colors", "Use the board editor layer colors for copper layers (realtime renderer only)", "useEditorCopper");
    // Presets and Viewports (appearance_controls_3D_base.cpp m_cbLayerPresets / m_cbViewports)
    const choice = (label: string, id: string, fill: (sel: HTMLElement) => void, pick: (value: string, sel: HTMLElement) => void, tip: string): HTMLElement => {
      side.appendChild(el("div", "v3d-label", label));
      const sel = document.createElement("k-select"); sel.id = id; sel.title = tip; sel.className = "v3d-choice";
      fill(sel); sel.addEventListener("change", () => pick((sel as unknown as HTMLSelectElement).value, sel));
      side.appendChild(sel); return sel;
    };
    // the labels and tooltips name PRESET_SWITCH_KEY / VIEWPORT_SWITCH_KEY (include/dialogs/eda_view_switcher.h) by
    // KeyNameFromKeyCode: Ctrl and Shift, or on macOS the Control key and Option
    const pk = switchKeyName("preset"), vk = switchKeyName("viewport");
    this.presetSel = choice(`Presets (${pk}+Tab):`, "v3d-presets", (sel) => this.fillPresets(sel), (value) => this.onPreset(value),
      `Save and restore color and visibility combinations.\nUse ${pk}+Tab to activate selector.\nSuccessive Tabs while holding ${pk} down will cycle through presets in the popup.`);
    this.viewportSel = choice(`Viewports (${vk}+Tab):`, "v3d-viewports", (sel) => this.fillViewports(sel), (value) => this.onViewport(value),
      `Save and restore camera position and zoom.\nUse ${vk}+Tab to activate selector.\nSuccessive Tabs while holding ${vk} down will cycle through viewports in the popup.`);
  }

  /** The colours the two display options stand in (stackup, editor copper), then the board drawn again. */
  async refreshOverrides(): Promise<void> {
    const o: Partial<LayerColors> = {};
    if (this.useStackup && this.opts.stackupLayers) {
      try { const l = await this.opts.stackupLayers(), f = this.opts.stackupFinish ? await this.opts.stackupFinish() : null; if (l) Object.assign(o, stackupOverride(l, f)); } catch { /* no stackup */ }
    }
    if (this.settings.useEditorCopper && this.opts.editorColor) {
      for (const [key, layer] of [["copperTop", "F.Cu"], ["copperBottom", "B.Cu"]] as const) { const c = parseCss(this.opts.editorColor(layer)); if (c) o[key] = c; }
    }
    setColorOverride(o); this.reload(false);
  }

  /** The board's enabled layers by name (for the User.N rows), null before a board is shown. */
  private enabledLayers(): Set<string> | null {
    const d = this.opts.getDoc(); if (!d || !d.layers) return null;
    const out = new Set<string>(); for (const k of d.layers.keys()) out.add(k); return out;
  }

  private option(sel: HTMLElement, value: string, label: string): void { const o = document.createElement("option"); o.value = value; o.textContent = label; sel.appendChild(o); }

  private fillPresets(sel: HTMLElement): void {
    sel.replaceChildren();
    this.option(sel, "", "---");
    this.option(sel, FOLLOW_PCB, FOLLOW_PCB); this.option(sel, FOLLOW_PLOT, FOLLOW_PLOT);
    for (const p of this.settings.presets || []) this.option(sel, "p:" + p.name, p.name);
    this.option(sel, "-", "---"); this.option(sel, "save", "Save preset..."); this.option(sel, "delete", "Delete preset...");
    (sel as unknown as HTMLSelectElement).value = this.presetName === FOLLOW_PCB || this.presetName === FOLLOW_PLOT ? this.presetName : this.presetName ? "p:" + this.presetName : "";
  }

  private fillViewports(sel: HTMLElement): void {
    sel.replaceChildren();
    this.option(sel, "", "---");
    for (const p of this.settings.viewports || []) this.option(sel, "v:" + p.name, p.name);
    this.option(sel, "-", "---"); this.option(sel, "save", "Save viewport..."); this.option(sel, "delete", "Delete viewport...");
    (sel as unknown as HTMLSelectElement).value = "";
  }

  /** APPEARANCE_CONTROLS_3D::onLayerPresetChanged. */
  private onPreset(value: string): void {
    const v = this.viewer; if (!v) return;
    const refill = () => { if (this.presetSel) this.fillPresets(this.presetSel); };
    if (value === FOLLOW_PCB) { const on = this.opts.layerVisible; if (on) { v.setVisibility(visibilityFromLayers(on, v.visibility)); } this.presetName = FOLLOW_PCB; toFront(this.psMru, FOLLOW_PCB); this.afterPreset(); return; }
    if (value === FOLLOW_PLOT) {
      const get = this.opts.plotLayers;
      if (get) void get().then((list) => { if (!list || !this.viewer) return; const set = new Set(list); this.viewer.setVisibility(visibilityFromLayers((l) => set.has(l), this.viewer.visibility)); this.presetName = FOLLOW_PLOT; toFront(this.psMru, FOLLOW_PLOT); this.afterPreset(); });
      return;
    }
    if (value.startsWith("p:")) {
      const p = (this.settings.presets || []).find((x) => x.name === value.slice(2)); if (!p) return;
      v.setVisibility({ ...p.vis }); setLayerColors(p.colors); this.presetName = p.name; toFront(this.psMru, p.name); this.afterPreset(true); return;
    }
    if (value === "save") {
      // wxTextEntryDialog( "Layer preset name:", "Save Layer Preset" ); an existing name asks "Overwrite existing preset?"
      const ask = this.opts.textEntry; if (!ask) { refill(); return; }
      ask("Save Layer Preset", "Layer preset name:", "", (text) => {
        const name = text.trim(); if (!name || !this.viewer) { refill(); return; }
        const list = this.settings.presets = this.settings.presets || [];
        const put = () => { const at = list.findIndex((x) => x.name === name); const p: Preset3D = { name, vis: { ...this.viewer!.visibility }, colors: cloneLayerColors(LAYER_COLORS) };
          if (at >= 0) list[at] = p; else list.push(p); this.presetName = name; toFront(this.psMru, name); this.save(); refill(); };
        if (list.some((x) => x.name === name) && this.opts.confirm) this.opts.confirm("Overwrite existing preset?", put); else put();
      });
      refill(); return;
    }
    if (value === "delete") {
      const list = this.settings.presets || [];
      if (list.length && this.opts.listPick) this.opts.listPick("Delete Preset", "Presets", "Select preset:", list.map((x) => x.name), (name) => {
        this.settings.presets = list.filter((x) => x.name !== name); if (this.presetName === name) this.presetName = ""; this.save(); refill(); });
      refill(); return;
    }
    refill();
  }

  private afterPreset(colors = false): void { this.save(); if (colors) this.reload(false); const keep = this.presetName; this.buildAppearance(); this.presetName = keep; if (this.presetSel) this.fillPresets(this.presetSel); this.syncToggles(); }

  /** APPEARANCE_CONTROLS_3D::onViewportChanged. */
  private onViewport(value: string): void {
    const v = this.viewer; if (!v) return;
    const refill = () => { if (this.viewportSel) this.fillViewports(this.viewportSel); };
    if (value.startsWith("v:")) { const p = (this.settings.viewports || []).find((x) => x.name === value.slice(2)); if (p) { v.setCamera(p); this.syncToggles(); toFront(this.vpMru, p.name); } return; }
    if (value === "save") {
      const ask = this.opts.textEntry; if (!ask) { refill(); return; }
      ask("Save Viewport", "Viewport name:", "", (text) => {
        const name = text.trim(); if (!name || !this.viewer) { refill(); return; }
        const list = this.settings.viewports = this.settings.viewports || [];
        const c = this.viewer.getCamera(), p: Viewport3D = { name, q: c.q, cam: c.cam, ortho: c.ortho };
        const at = list.findIndex((x) => x.name === name); if (at >= 0) list[at] = p; else list.push(p);
        toFront(this.vpMru, name); this.save(); refill(); if (this.viewportSel) (this.viewportSel as unknown as HTMLSelectElement).value = "v:" + name;
      });
      refill(); return;
    }
    if (value === "delete") {
      const list = this.settings.viewports || [];
      if (list.length && this.opts.listPick) this.opts.listPick("Delete Viewport", "Viewports", "Select viewport:", list.map((x) => x.name), (name) => { this.settings.viewports = list.filter((x) => x.name !== name); this.save(); refill(); });
      refill(); return;
    }
    refill();
  }

  /** A row or swatch changed: the preset no longer describes what is shown; colours redraw the board. */
  private appearanceChanged(colors = false): void {
    this.presetName = ""; if (this.presetSel) this.fillPresets(this.presetSel);
    this.syncToggles(); this.save();
    if (colors) this.reload(false);
  }

  /** The appearance into "kui.v3d". */
  private save(): void {
    const v = this.viewer; if (!v) return;
    this.settings.vis = { ...v.visibility }; this.settings.bg = [v.background.top, v.background.bottom]; this.settings.grid = v.grid;
    this.settings.colors = cloneLayerColors(LAYER_COLORS); this.settings.preset = this.presetName;
    saveSettings3D(this.settings);
  }

  private restoreSettings(): void {
    const v = this.viewer, s = this.settings; if (!v) return;
    if (s.colors) setLayerColors(s.colors);
    if (s.vis) v.setVisibility({ ...DEFAULT_VISIBILITY, ...s.vis, extra: Array.isArray(s.vis.extra) ? s.vis.extra.slice() : DEFAULT_VISIBILITY.extra.slice() });
    if (s.bg && s.bg.length === 2) v.setBackground(s.bg[0], s.bg[1]);
    if (s.grid && GRID3D_CHOICES.includes(s.grid)) v.setGrid(s.grid);
    this.presetName = s.preset || "";
  }

  private resetDefaults(): void {
    const v = this.viewer; if (!v) return;
    setLayerColors(cloneLayerColors(DEFAULT_LAYER_COLORS));
    v.setVisibility({ ...DEFAULT_VISIBILITY, extra: DEFAULT_VISIBILITY.extra.slice() }); v.setBackground(BACKGROUND_TOP, BACKGROUND_BOTTOM); v.setOrtho(false); v.setGrid(0);
    this.presetName = ""; this.settings.useStackup = true; this.settings.useEditorCopper = false; this.save();
    this.buildAppearance(); this.syncToggles(); v.view("top"); this.reload(false);
  }

  // ---------------------------------------------------------------- menus

  private openMenu(button: HTMLElement, items: MenuItem[]): void {
    this.closeMenu(); this.menuButton = button; button.classList.add("open");
    const r = button.getBoundingClientRect(); this.showMenu(items, { below: r, gap: 0, noFlip: true }, 0);
  }

  private showMenu(items: MenuItem[], anchor: MenuAnchor, depth: number): void {
    while (this.menu.length > depth) { const m = this.menu.pop(); if (m) m.remove(); }
    const m = el("div", "v3d-menu");
    for (const it of items) {
      if (it === "-") { m.appendChild(el("hr")); continue; }
      const row = el("div", "v3d-mi");
      const ic = el("span"); const lab = el("span", undefined, it.label); const k = el("span", "k"); const arrow = el("span");
      if ("sub" in it) {
        ic.appendChild(icon(it.icon)); arrow.appendChild(menuArrow());
        row.addEventListener("pointerenter", () => { this.showMenu(it.sub, { row: row.getBoundingClientRect(), parent: m.getBoundingClientRect(), overlap: 2 }, depth + 1); });
      } else {
        row.dataset.action = it.id;
        if (it.checked) { ic.className = "chk"; ic.appendChild(menuCheck(it.checked())); } else ic.appendChild(icon(it.icon));
        if (it.key) k.textContent = menuKey(it.key);
        if (it.disabled) { row.classList.add("dis"); row.title = it.disabled; } else if (it.tip) row.title = it.tip;
        row.addEventListener("pointerenter", () => { while (this.menu.length > depth + 1) { const s = this.menu.pop(); if (s) s.remove(); } });
        row.addEventListener("click", () => { if (it.disabled) return; this.closeMenu(); it.run(); this.root.focus({ preventScroll: true }); });
      }
      row.append(ic, lab, k, arrow); m.appendChild(row);
    }
    document.body.appendChild(m); this.menu.push(m);
    fitMenu(m, anchor);   // on screen: flipped, slid or cut to the window and scrolled (web/shared/menufit.ts)
  }

  private closeMenu(): void {
    for (const m of this.menu) m.remove(); this.menu = [];
    if (this.menuButton) this.menuButton.classList.remove("open"); this.menuButton = null;
  }

  // ---------------------------------------------------------------- keyboard

  /** The MRU of a switcher: the names applied most recently first, then the rest in list order (as rebuilt on load). */
  private mru(kind: SwitcherKind): string[] {
    const all = kind === "viewport" ? (this.settings.viewports || []).map((x) => x.name) : [FOLLOW_PCB, FOLLOW_PLOT, ...(this.settings.presets || []).map((x) => x.name)];
    const list = kind === "viewport" ? this.vpMru : this.psMru;
    const out = list.filter((n) => all.includes(n)); for (const n of all) if (!out.includes(n)) out.push(n);
    list.splice(0, list.length, ...out); return out;
  }
  /** EDA_VIEW_SWITCHER: a borderless list centred on the window; false when the MRU is empty. */
  private openSwitcher(kind: SwitcherKind, shift: boolean): boolean {
    const items = this.mru(kind); if (!items.length) return false;
    const key: "Control" | "Shift" | "Alt" = kind === "preset" ? "Control" : IS_MAC ? "Alt" : "Shift";
    const el = document.createElement("div"); el.className = "vsw kview-switcher v3d-switcher"; el.setAttribute("role", "dialog"); el.dataset.switcher = kind;
    const title = document.createElement("div"); title.className = "vsw-title"; title.textContent = "View Preset Switcher";
    const list = document.createElement("div"); list.className = "vsw-list"; list.setAttribute("role", "listbox");
    el.append(title, list);
    // without key-state polling the Tab that opened the switcher is counted now
    this.switcher = { kind, items, sel: advance(0, items.length, shift, key), el, list, key };
    this.paintSwitcher(); document.body.append(el);
    const r = this.root.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.round(Math.max(4, Math.min(window.innerWidth - w - 4, r.left + (r.width - w) / 2))) + "px";
    el.style.top = Math.round(Math.max(4, Math.min(window.innerHeight - h - 4, r.top + (r.height - h) / 2))) + "px";
    return true;
  }
  private paintSwitcher(): void {
    const sw = this.switcher; if (!sw) return;
    sw.list.replaceChildren(...sw.items.map((name, i) => { const row = document.createElement("div"); row.className = "vsw-row kview-row" + (i === sw.sel ? " on" : ""); row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(i === sw.sel)); row.textContent = name; return row; }));
  }
  /** Releasing the switch key applies the row (wxID_OK); Esc or losing the focus cancels. */
  private closeSwitcher(apply: boolean): void {
    const sw = this.switcher; if (!sw) return; this.switcher = null; sw.el.remove();
    const name = sw.items[sw.sel]; if (!apply || name === undefined) return;
    if (sw.kind === "viewport") this.onViewport("v:" + name);
    else this.onPreset(name === FOLLOW_PCB || name === FOLLOW_PLOT ? name : "p:" + name);
  }
  private onKeyUp(ev: KeyboardEvent): void {
    const sw = this.switcher; if (!sw) return;
    if (ev.key === sw.key || (sw.key === "Control" && !ev.ctrlKey) || (sw.key === "Shift" && !ev.shiftKey) || (sw.key === "Alt" && !ev.altKey)) { ev.preventDefault(); ev.stopPropagation(); this.closeSwitcher(true); }
  }

  private onKey(ev: KeyboardEvent): void {
    const t = ev.target as HTMLElement;
    // the window owns the keyboard while it has the focus: nothing reaches the board editor's shortcuts
    ev.stopPropagation();
    if (this.switcher) {
      ev.preventDefault();
      const sw = this.switcher;
      if (ev.key === "Tab" || (sw.kind === "preset" && ev.code === "Backquote")) { sw.sel = advance(sw.sel, sw.items.length, ev.shiftKey, sw.key); this.paintSwitcher(); }
      else if (ev.key === "Escape") this.closeSwitcher(false);
      return;
    }
    // EDA_3D_VIEWER_FRAME::TryBefore: PRESET_SWITCH_KEY / VIEWPORT_SWITCH_KEY with Tab opens EDA_VIEW_SWITCHER over the
    // MRU (browsers keep Ctrl+Tab, so the preset switcher also opens on Ctrl+`, as in the board editor)
    let kind = switcherFor(ev);
    if (!kind && ev.code === "Backquote" && ev.ctrlKey && !ev.metaKey && !ev.altKey) kind = "preset";
    if (kind && !(t && /^(INPUT|SELECT|K-SELECT|TEXTAREA)$/.test(t.tagName)) && this.openSwitcher(kind, ev.shiftKey)) { ev.preventDefault(); return; }
    if (t && /^(INPUT|SELECT|K-SELECT|TEXTAREA)$/.test(t.tagName) && (t as HTMLInputElement).type !== "checkbox") return;
    if (ev.key === "Escape") { if (this.menu.length) { this.closeMenu(); ev.preventDefault(); } return; }
    if ((ev.key === "=" || ev.key === "+") && !ev.ctrlKey && !ev.metaKey) { this.run("zoomInCenter"); ev.preventDefault(); return; }
    if ((ev.key === "-" || ev.key === "_") && !ev.ctrlKey && !ev.metaKey) { this.run("zoomOutCenter"); ev.preventDefault(); return; }
    for (const a of this.actions.values()) {
      if (!a.key || a.disabled || a.key === "+" || a.key === "-" || !keyMatches(ev, a.key)) continue;
      ev.preventDefault(); a.run(); return;
    }
  }

  // ---------------------------------------------------------------- window management

  private bindDrag(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || (ev.target as HTMLElement).closest("button") || this.restore) return;
      const r = this.root.getBoundingClientRect(); const ox = ev.clientX - r.left, oy = ev.clientY - r.top;
      handle.setPointerCapture(ev.pointerId);
      const move = (e: PointerEvent) => {
        const x = Math.max(-r.width + 80, Math.min(window.innerWidth - 80, e.clientX - ox)), y = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - oy));
        this.root.style.left = x + "px"; this.root.style.top = y + "px";
      };
      const up = (e: PointerEvent) => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); handle.removeEventListener("pointercancel", up); try { handle.releasePointerCapture(e.pointerId); } catch { /* released */ } };
      handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up); handle.addEventListener("pointercancel", up);
    });
  }

  private bindResize(grip: HTMLElement): void {
    grip.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || this.restore) return; ev.preventDefault();
      const r = this.root.getBoundingClientRect(); const sx = ev.clientX, sy = ev.clientY;
      grip.setPointerCapture(ev.pointerId);
      const move = (e: PointerEvent) => {
        this.root.style.width = Math.max(420, Math.min(window.innerWidth - r.left, r.width + e.clientX - sx)) + "px";
        this.root.style.height = Math.max(300, Math.min(window.innerHeight - r.top, r.height + e.clientY - sy)) + "px";
        if (this.viewer) this.viewer.resize();
      };
      const up = (e: PointerEvent) => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); grip.removeEventListener("pointercancel", up); try { grip.releasePointerCapture(e.pointerId); } catch { /* released */ } };
      grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up); grip.addEventListener("pointercancel", up);
    });
  }

  toggleMaximize(): void {
    const s = this.root.style;
    if (this.restore) { s.left = this.restore.left; s.top = this.restore.top; s.width = this.restore.width; s.height = this.restore.height; this.restore = null; this.root.classList.remove("v3d-max"); }
    else { this.restore = { left: s.left, top: s.top, width: s.width, height: s.height }; s.left = "0"; s.top = "0"; s.width = "100vw"; s.height = "100vh"; this.root.classList.add("v3d-max"); }
    if (this.viewer) this.viewer.resize();
  }

  /** Keep the title bar reachable when the browser window shrinks. */
  private clamp(): void {
    if (this.restore) return;
    const r = this.root.getBoundingClientRect();
    if (r.left > window.innerWidth - 80) this.root.style.left = Math.max(0, window.innerWidth - 80) + "px";
    if (r.top > window.innerHeight - 30) this.root.style.top = Math.max(0, window.innerHeight - 30) + "px";
  }

  focus(): void { this.root.focus({ preventScroll: true }); }

  // ---------------------------------------------------------------- board

  private updateTitle(): void {
    const name = this.opts.getName ? this.opts.getName() : "";
    // EDA_3D_VIEWER_FRAME: "<board file> — 3D Viewer"
    this.nameEl.textContent = (name ? name + " — " : "") + "3D Viewer";
  }

  private setStatus(text: string): void { this.statusEl.textContent = text; }

  private scheduleReload(): void {
    if (this.closed) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => { this.reloadTimer = 0; this.reload(false); }, 350);
  }

  /** Rebuild the board from the current document (Reload board); `fit` also resets the camera. */
  reload(fit: boolean): void {
    if (this.closed || !this.viewer) return;
    const doc = this.opts.getDoc();
    this.updateTitle();
    if (!doc || doc.type !== "pcb") { this.setStatus("No board is open"); return; }
    const t0 = performance.now();
    try {
      const st = this.viewer.setDoc(doc, fit);
      this.lastBuildMs = performance.now() - t0; this.builds++;
      // EDA_3D_CANVAS reports "Reload time %.3f s" in its status bar
      this.setStatus(`Reload time ${(this.lastBuildMs / 1000).toFixed(3)} s` + (st.fallbackOutline ? "  —  no closed Edge.Cuts outline: using the board's bounding box" : ""));
    } catch (e) {
      console.warn("3D viewer: could not build the board", e);
      this.setStatus("Could not build the board: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  private fileStem(): string { const n = this.opts.getName ? this.opts.getName() : ""; return (n.split("/").pop() || "board").replace(/\.kicad_pcb$/, "") || "board"; }

  async exportImage(): Promise<Blob | null> {
    if (!this.viewer) return null;
    try {
      const blob = await this.viewer.snapshot("image/png");
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = this.fileStem() + ".png";
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      this.setStatus("Exported " + a.download);
      return blob;
    } catch (e) { this.setStatus("Export failed: " + (e instanceof Error ? e.message : String(e))); return null; }
  }

  async copyImage(): Promise<void> {
    if (!this.viewer) return;
    try {
      const blob = await this.viewer.snapshot("image/png");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      this.setStatus("Copied the 3D image to the clipboard");
    } catch (e) { this.setStatus("Copy failed: " + (e instanceof Error ? e.message : String(e))); }
  }

  close(): void {
    if (this.closed) return; this.closed = true;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    if (this.unsubscribe) this.unsubscribe();
    this.closeMenu();
    document.removeEventListener("pointerdown", this.onDocPointer, true);
    window.removeEventListener("resize", this.onWinResize);
    if (this.viewer) this.viewer.dispose();
    this.root.remove();
  }
}
