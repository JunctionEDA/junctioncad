// panels-api.ts — the contract between the docked panels (React, web/shared/components/panes) and the
// editor bundle's panel models (web/domains/pcb/editor/panels/*).  The editor publishes `window.CollabPanels`:
// a small observable store with the Appearance state, the hierarchy tree and the net navigator,
// plus on-demand models (the property grid of the selection, search rows) and one dispatch() for
// every panel intent.  Types only: both bundles import this file, neither imports the other.

// ---------------------------------------------------------------- Appearance (pcbnew/widgets/appearance_controls.cpp)
import type { NetInspCmd, NetInspModel } from "./editor/panels/netinsp";
export type { NetInspCmd, NetInspModel, NetInspColumn, NetInspRow } from "./editor/panels/netinsp";
export interface LayerInfo { key: string; name: string; color: string; defaultColor: string; visible: boolean; copper: boolean; tip: string }

/** One row of the Objects tab (APPEARANCE_SETTING); a spacer row has only `spacer`. */
export interface ObjectRow { id: string; label: string; tip: string; spacer?: boolean; visible?: boolean; opacity?: number; canHide?: boolean;
  /** the row's colour in the user's theme and the theme default: rows with one show a COLOR_SWATCH */
  color?: string; defaultColor?: string }

export interface NetRow { name: string; code: number; color: string | null; visible: boolean; netclass: string }
export interface NetClassRow { name: string; color: string | null; visible: boolean; /** NETCLASS::GetSchematicColor (null: unspecified) */ schColor?: string | null }

export type InactiveMode = "normal" | "dim" | "hide";
export type NetColorMode = "all" | "ratsnest" | "off";
export type RatsnestMode = "all" | "visible" | "none";

export interface AppearanceState {
  /** the Footprint Editor's panel (m_isFpEditor): no Nets tab, only s_allowedInFpEditor objects */
  fpEditor?: boolean;
  layers: LayerInfo[]; active: string;
  objects: ObjectRow[];
  nets: NetRow[]; netClasses: NetClassRow[];
  inactive: InactiveMode; flip: boolean; netColorMode: NetColorMode; ratsnestMode: RatsnestMode;
  /** built-in presets first, then the user's; `preset` is the one the current visibility matches (null = unsaved) */
  presets: string[]; builtinPresets: string[]; preset: string | null;
  viewports: string[]; viewport: string | null;
}

export type LayerMenuCmd = "showAllCu" | "hideAllCu" | "hideAllButActive" | "showAllNonCu" | "hideAllNonCu" | "showAll" | "hideAll"
  | "frontAssembly" | "front" | "inner" | "back" | "backAssembly";
export type NetCmd = "highlight" | "select" | "unselect" | "showAll" | "hideOthers";

// ---------------------------------------------------------------- Properties (PROPERTIES_PANEL / PROPERTY_MANAGER)
export type PropType = "text" | "longtext" | "length" | "coord" | "angle" | "time" | "number" | "int" | "bool" | "enum" | "color";
export interface PropRow {
  /** stable id: "<group>/<name>" */
  id: string; name: string; type: PropType;
  /** display text in the current units ("" when mixed); booleans are "1" / "0" */
  value: string; mixed: boolean; readOnly: boolean;
  choices?: [string, string][];
  /** the name may be edited in the label column (a footprint's own field, a custom property) */
  keyEditable?: boolean;
  /** the value editor carries a browse button: PG_FPID_EDITOR ("footprint") or PG_URL_EDITOR ("url") */
  browse?: "footprint" | "url";
  /** an enum row edited with a NET_SELECTOR (the board's nets, with a filter entry) */
  netSelector?: boolean;
  /** an editable combo's list in the current units (a track's Width: Board Setup's predefined track widths) */
  suggest?: string[];
}
/** add: the category's "+" button and context-menu entry; "Edit Pin Map..." is SCH_PROPERTIES_PANEL's small_edit button */
export interface PropGroup { name: string; rows: PropRow[]; add?: PropGroupButton }
export type PropGroupButton = "Add Field" | "Add Custom Property" | "Edit Pin Map...";
export interface PropGrid {
  /** the caption line: "Footprint R1", "3 items selected", "No objects selected" */
  title: string; count: number; groups: PropGroup[]; readOnly: boolean; note?: string;
}

// ---------------------------------------------------------------- Search (SEARCH_PANE and its handlers)
/** A handler's columns with their proportions (tenths of the list's width) and alignment (wxLIST_FORMAT_LEFT / CENTER / RIGHT). */
export interface SearchTab { id: string; label: string; columns: string[]; props: number[]; align: ("left" | "center" | "right")[] }
export interface SearchRow { key: string; ids: string[]; cells: string[]; docId?: string; /** the texts the query matches (else the cells) */ match?: string[] }
export interface SearchResult { tab: string; rows: SearchRow[]; total: number }
/** APP_SETTINGS_BASE::SEARCH_PANE plus the list's sort column (-1: the handler's own order). */
export interface SearchOpts { hidden: boolean; metadata: boolean; sortCol: number; ascending: boolean }
export type SelectionZoom = "zoom" | "pan" | "none";

// ---------------------------------------------------------------- Hierarchy (HIERARCHY_PANE)
export interface HierNode {
  /** sheet path of uuids ("/" for the root) */
  path: string; name: string; page: string; docId: string | null; file: string;
  /** the document holding this sheet's (sheet …) symbol and that symbol's uuid (null for the root) */
  parentDocId: string | null; sheetId: string | null;
  current: boolean; children: HierNode[];
  /** the hidden project root above several top-level sheets (wxTR_HIDE_ROOT): only its children are drawn */
  virtual?: boolean;
  /** a top-level sheet of a schematic with several (SCHEMATIC::GetTopLevelSheets): its path names it */
  topLevel?: boolean;
}

// ---------------------------------------------------------------- Net navigator (eeschema/net_navigator.cpp)
export interface NetNavNode { key: string; label: string; ids?: string[]; children?: NetNavNode[]; bold?: boolean; /** starts folded (wxTreeCtrl nodes are collapsed until expanded) */ collapsed?: boolean }
export interface NetNavState { root: NetNavNode | null; version: number; selected?: string | null; filter?: string; filterEnabled?: boolean; wildcard?: boolean }

// ---------------------------------------------------------------- the store
export interface PanelsState {
  appearance: AppearanceState;
  /** marked: the paths of the sheets holding the highlighted net (HIERARCHY_PANE::UpdateNetHighlight), drawn in
   *  markColor: the schematic theme's LAYER_BRIGHTENED */
  hierarchy: { root: HierNode | null; version: number; marked?: string[]; markColor?: string };
  netNav: NetNavState;
  /** bumped when the selection (the app's or a tool module's) or the units change: the Properties pane re-reads */
  selVersion: number;
  /** bumped when the board's net highlight changes */
  hlVersion?: number;
}

export type PanelAction =
  | { t: "layerVisible"; key: string; on: boolean }
  | { t: "layerActive"; key: string }
  | { t: "layerColor"; key: string; color: string | null }
  | { t: "layerMenu"; cmd: LayerMenuCmd }
  | { t: "objVisible"; id: string; on: boolean }
  | { t: "objOpacity"; id: string; value: number }
  | { t: "objColor"; id: string; color: string | null }
  | { t: "showNetInspector" }
  | { t: "boardSetup"; page: string }
  | { t: "inactive"; mode: InactiveMode }
  | { t: "flip"; on: boolean }
  | { t: "netVisible"; name: string; on: boolean }
  | { t: "netColor"; name: string; color: string | null }
  | { t: "netCmd"; cmd: NetCmd; name: string }
  | { t: "classVisible"; name: string; on: boolean }
  | { t: "classColor"; name: string; color: string | null }
  | { t: "classCmd"; cmd: NetCmd; name: string }
  | { t: "netColorMode"; mode: NetColorMode }
  | { t: "ratsnestMode"; mode: RatsnestMode }
  | { t: "preset"; name: string }
  | { t: "presetSave" } | { t: "presetDelete" }
  | { t: "viewport"; name: string }
  | { t: "viewportSave" } | { t: "viewportDelete" }
  | { t: "hierOpen"; path: string }
  | { t: "hierRename"; path: string }
  | { t: "hierPage"; path: string }
  | { t: "hierNewTop" }
  | { t: "hierDeleteTop"; path: string }
  | { t: "searchSelect"; rows: SearchRow[]; zoom: SelectionZoom }
  | { t: "searchActivate"; row: SearchRow; zoom: SelectionZoom }
  | { t: "netNavSelect"; ids: string[]; key?: string }
  | { t: "netNavFilter"; text?: string; wildcard?: boolean }
  | { t: "netNavRefresh" }
  | { t: "netNavFind"; net: string };

export interface PanelsApi {
  getState(): PanelsState;
  subscribe(fn: () => void): () => void;
  dispatch(a: PanelAction): void;
  /** The property grid of the current selection. */
  propGrid(): PropGrid;
  /** Commit one property for every selected item; returns an error text (shown under the row) or null. */
  setProp(id: string, text: string): string | null;
  /** Rename a row's property (label column edit); `pending`: the row was just added and goes again if left blank. */
  renamePropKey(id: string, name: string, pending: boolean): boolean;
  /** Add a blank field / custom property to the selection; the new row's id. */
  addPropKey(kind: "field" | "custom"): string | null;
  /** SCH_PROPERTIES_PANEL's "Edit Pin Map..." category button: the symbol's Properties dialog at its Pin Map page */
  editPinMap(): void;
  /** Remove a footprint field or a custom property from the selection. */
  removePropKey(id: string): boolean;
  /** The browse button of a row with `browse` (PG_FPID_EDITOR / PG_URL_EDITOR::OnEvent): the footprint chooser, whose
   *  choice is committed like setProp, or the datasheet opened. */
  browseProp(id: string): void;
  /** DIALOG_COLOR_PICKER over the pane (COLOR_SWATCH::GetNewSwatchColor): `done` gets the css colour picked, or null
   *  when it was cleared (no default) or set back to the default; nothing on Cancel. */
  pickColor(color: string | null, def: string | null, opacity: boolean, done: (c: string | null) => void): void;
  searchTabs(): SearchTab[];
  search(tab: string, query: string, opts?: SearchOpts): SearchResult;
  /** The board's Net Inspector pane: its columns and rows (editor/panels/netinsp.ts). */
  netInspector(): NetInspModel;
  netInspectorCmd(c: NetInspCmd): void;
  netInspectorFilter(text: string): void;
}

declare global {
  interface Window { CollabPanels?: PanelsApi }
}
