// panels/index.ts — wires the panel models to the editor: publishes window.CollabPanels (see
// web/domains/pcb/panels-api.ts), keeps the models current as the app store changes (document opened / edited, the
// toolbar's own toggles), and watches the selection — the app's and the tool modules' — so the Properties
// pane and the Net Navigator follow it.
import type { PanelAction, PanelsApi } from "../../panels-api";
import { store } from "../appstore";
import { filterAllows } from "../selection";
import { E } from "../state";
import { toggleAttribute } from "../../dialogs/sync-units";
import { appearanceDispatch, appearanceDocOpened, applyAppearance, itemObjectHidden, publishAppearance } from "./appearance";
import { panelStore } from "./core";
import { hierarchyDispatch, loadSheets, publishHierarchy } from "./hierarchy";
import { netNavDispatch, netNavSignature, publishNetNav } from "./netnav";
import { addPropKey, browseProp, editPinMap, propGrid, removePropKey, renamePropKey, selectionSignature, setProp } from "./propgrid";
import { search, searchDispatch, searchTabs } from "./search";
import { colorPicker, type RGBA } from "../pcbdialogs/color-picker";
import { parseColor, rgba } from "../../canvas/colors";
import { netInspectorCmd, netInspectorModel, setFilter as netInspectorFilter } from "./netinsp";

function dispatch(a: PanelAction): void {
  try { if (appearanceDispatch(a) || hierarchyDispatch(a) || searchDispatch(a) || netNavDispatch(a)) return; console.warn("unknown panel action", a); }
  catch (e) { console.warn("panel action failed", a, e); }
}

const toRGBA = (c: string | null): RGBA | null => { if (!c) return null; const [r, g, b, a] = parseColor(c); return { r: r / 255, g: g / 255, b: b / 255, a }; };
const toCss = (c: RGBA): string => rgba(Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), Math.round(c.a * 1000) / 1000);
/** COLOR_SWATCH::GetNewSwatchColor: the swatch's colour through DIALOG_COLOR_PICKER; transparent black is UNSPECIFIED. */
export function pickColor(color: string | null, def: string | null, opacity: boolean, done: (c: string | null) => void): void {
  const d = toRGBA(def);
  colorPicker(toRGBA(color), opacity, (c) => {
    if (!d && c.a === 0 && !c.r && !c.g && !c.b) { done(null); return; }
    const css = toCss(c);
    done(def && css.toLowerCase() === toCss(d!).toLowerCase() ? null : css);
  }, d);
}

const api: PanelsApi = { pickColor, getState: panelStore.get, subscribe: panelStore.subscribe, dispatch, propGrid, setProp, renamePropKey, addPropKey, removePropKey, browseProp, editPinMap, searchTabs, search, netInspector: () => netInspectorModel(), netInspectorCmd, netInspectorFilter };
window.CollabPanels = api;

/** The select tool's gate for the tool modules' own picks (the app's picks go through filterAllows directly). */
E.pickAllowed = (it: KItem): boolean => !!it && filterAllows(it.kind, it) && !itemObjectHidden(it);
// sch-tools' Attributes toggles (SCH_EDIT_TOOL::SetAttribute) keep the other units of a multi-unit part in step
E.toggleAttribute = toggleAttribute;

// ---- follow the app store
let last = { docId: null as string | null, hasDoc: false, version: -1, hidden: null as unknown, toggles: null as unknown, active: "", pro: null as unknown, markers: null as unknown, docs: null as unknown };
let busy = false;
let shownDoc: string | null = null;   // the last document that was on screen (a switch passes through hasDoc = false)
store.subscribe((s: { document: { docId: string | null; hasDoc: boolean; version: number; hiddenLayers: unknown; docs: unknown }; toggles: unknown; viewport: { activeLayer: string } }) => {
  if (busy) return; busy = true; try { follow(s); } finally { busy = false; }
});
function follow(s: { document: { docId: string | null; hasDoc: boolean; version: number; hiddenLayers: unknown; docs: unknown }; toggles: unknown; viewport: { activeLayer: string } }): void {
  const d = s.document;
  const opened = d.hasDoc && (d.docId !== last.docId || !last.hasDoc);
  const prevDoc = shownDoc; if (d.hasDoc) shownDoc = d.docId;
  const changed = d.version !== last.version, hidden = d.hiddenLayers !== last.hidden, toggles = s.toggles !== last.toggles, active = s.viewport.activeLayer !== last.active;
  const pro = E.proSettings !== last.pro, markers = E.renderOpts.markers !== last.markers, docs = d.docs !== last.docs;
  last = { docId: d.docId, hasDoc: d.hasDoc, version: d.version, hidden: d.hiddenLayers, toggles: s.toggles, active: s.viewport.activeLayer, pro: E.proSettings, markers: E.renderOpts.markers, docs: d.docs };
  if (opened) { appearanceDocOpened(); last.markers = E.renderOpts.markers; void loadSheets(prevDoc && prevDoc !== d.docId ? prevDoc : null); publishNetNav(); return; }
  if (!d.hasDoc) return;
  if (changed || pro || markers) { applyAppearance(); last.markers = E.renderOpts.markers; }
  if (changed || hidden || toggles || active || pro) publishAppearance();
  if (docs) void loadSheets();   // a file joined the project (somebody drew a sheet): read it, then the tree is rebuilt
  if (changed || docs) { publishHierarchy(); publishNetNav(); }
}

// ---- follow the selection (the tool modules keep their own picks, which no store slice carries)
let selSig = "", navSig = "", hlSig = "";
setInterval(() => {
  if (!E.kdoc) return;
  const sig = selectionSignature(), nav = netNavSignature();
  if (sig !== selSig) { selSig = sig; panelStore.set({ selVersion: panelStore.get().selVersion + 1 }); if (E.DOC_TYPE === "kicad_sch") publishNetNav(); }
  if (nav !== navSig) { navSig = nav; publishNetNav(); }
  // the board's net highlight (PCB_NET_INSPECTOR_PANEL::OnBoardHighlightNetChanged follows it)
  const P = (window as unknown as { PcbTools?: { state: { highlightNet?: string | null } } }).PcbTools;
  const hl = E.highlightIds ? String(P && P.state.highlightNet || "") + ":" + (E.highlightIds as Set<string>).size : "";
  if (hl !== hlSig) { hlSig = hl; panelStore.set({ hlVersion: (panelStore.get().hlVersion || 0) + 1 }); }
}, 120);
