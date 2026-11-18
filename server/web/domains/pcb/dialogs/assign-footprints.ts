// dialogs/assign-footprints.ts — Tools → Assign Footprints… : KiCad's CvPcb (cvpcb/cvpcb_mainframe.cpp), a non-modal
// frame titled "Assign Footprints" beside the schematic.  Menu bar (cvpcb/menubar.cpp), the top toolbar from KiCad's
// own config (toolbars_cvpcb.cpp, through web/domains/pcb/generated/kicad-ui-spec.json) with its "Footprint Filters:" control,
// the Footprint Libraries / Symbol : Footprint Assignments / Filtered Footprints panes with resizable splitters, three
// status lines (DisplayStatus) and Apply, Save Schematic & Continue / OK / Cancel.  The assignments live in the frame
// (with CvPcb's own undo / redo) until Save to Schematic, Apply or OK writes them to the symbols' Footprint fields.
// View Selected Footprint opens DISPLAY_FOOTPRINTS_FRAME (cvpcb/fpviewer.ts); Preferences > Manage Footprint
// Association Files… DIALOG_CONFIG_EQUFILES (cvpcb/equfiles.ts).  The DOM-free rules are in cvpcb/logic.ts.
import { E, appState, toast, toolCtx } from "./editor";
import { h } from "./dom";
import { libPins, refCmp, str, symbolRows, type SymRow } from "./logic";
import { projectJson, loadProject, readDoc, submitDocOp } from "./project";
import { openPreferences } from "./preferences";
import * as L from "./cvpcb/logic";
import { ensureCvStyle } from "./cvpcb/style";
import { askBox, cvMeta, cvWindow, loadSettings, messageBox, saveSettings, vlist, type CvLib, type CvWindow, type VList } from "./cvpcb/widgets";
import { openFpViewer, type FpViewer } from "./cvpcb/fpviewer";
import { openEquFiles, readEquivalences } from "./cvpcb/equfiles";
import { closeMenus, icon, showMenu, type MenuEntry } from "../symedit/ui";
import { keyName } from "../../../shared/keys";
import { appClipboard } from "../editor/tools";
import { LINKS, LOCAL_LABELS } from "../tables";
import * as src from "../library/sources";
import * as core from "../library/core";
import { manageLibraries } from "./lib-tables";

interface Member { docId: string; id: string }
interface Row { ref: string; value: string; fp: string; orig: string; pins: number; filters: string[]; members: Member[]; editable: boolean }
type Focus = "lib" | "sym" | "fp";

const OFFICIAL_URI = (lib: string) => "${KICAD10_FOOTPRINT_DIR}/" + lib + ".pretty";
const fpKey = (fp: L.FpInfo) => fp.lib + ":" + fp.name;
/** Every document of the project (project.ts projectDocs lists only the schematics and boards the editor opens). */
const allDocs = () => (appState.project ? appState.project.docs : []) as { docId: string; path: string; docType: string }[];

let current: { close(force?: boolean): Promise<boolean>; front(): void } | null = null;
/** true while the frame is up (the rig and the editor's own Esc order ask). */
export function assignFootprintsOpen(): boolean { return !!current; }

export function openAssignFootprints(): void {
  if (!E.kdoc) return;
  if (current) { current.front(); return; }
  ensureCvStyle();
  const ro = !!E.viewOnly, here = appState.docId || "", docs = new Map<string, KDoc>([[here, E.kdoc as KDoc]]);
  const cfg = loadSettings();
  const K = KiCadCanvas;

  // ------------------------------------------------------------ the netlist (one row per reference, every sheet)
  let rows: Row[] = [];
  const build = () => {
    const byRef = new Map<string, Row>(), out: Row[] = [];
    for (const [docId, d] of docs) for (const r of symbolRows(d, docId, !ro) as SymRow[]) {
      const members = r.ids.map((id) => ({ docId, id }));
      const prev = r.ref && !/\?$/.test(r.ref) ? byRef.get(r.ref) : undefined; if (prev) { prev.members.push(...members); continue; }
      const it = d.items.get(r.id)!; const lid = K.kid(it.node, "lib_name") || K.kid(it.node, "lib_id"); const lib = lid ? K.resolveLib(d, str(lid[1])) : null;
      // the netlist COMPONENT's footprint filters and pin count come from the library symbol
      let filters: string[] = [];
      if (lib) for (const p of K.kids(lib, "property")) if (str(p[1]) === "ki_fp_filters") filters = str(p[2]).split(/\s+/).filter(Boolean);
      const old = rows.find((x) => x.members[0]!.docId === docId && x.members[0]!.id === r.id);
      const fp0 = L.cleanFpid(str(r.values.Footprint));
      const row: Row = { ref: r.ref, value: str(r.values.Value), fp: old ? old.fp : fp0, orig: old ? old.orig : fp0, pins: new Set(libPins(lib).map((p) => p.number)).size, filters, members, editable: r.editable };
      out.push(row); if (r.ref) byRef.set(r.ref, row);
    }
    out.sort((a, b) => refCmp(a.ref, b.ref));
    rows = out;
  };

  // ------------------------------------------------------------ state
  let libs: CvLib[] = [], curLib = "", all: L.FpInfo[] = [], byId = new Map<string, L.FpInfo>(), loaded = false, loadMsg = "Loading footprint libraries...";
  let fpList: L.FpInfo[] = [], fpSel = -1;
  let sel: number[] = [], cur = -1, anchor = -1;
  let flags = cfg.filter_footprint, filterText = cfg.filter_footprint_text;
  let focus: Focus = "sym", modified = false, savedMsg = "", autoMsg = "";
  const history = new L.AssocHistory();
  let viewer: FpViewer | null = null;
  let win: CvWindow | null = null;
  let symList: VList, libList: VList, fpListBox: VList;
  let statusEls: HTMLElement[] = [];
  let tbHost: HTMLElement, filterInput: HTMLInputElement;
  const libRows = () => libs.map((l) => (l.pinned ? L.PIN_GLYPH : "") + l.name);

  const symbol = (): Row | null => (sel.length ? rows[Math.min(...sel)] || null : null);
  const symFilter = (r: Row | null): L.SymFilterInfo | null => (r ? { pins: r.pins, filters: r.filters } : null);
  const selectedFp = (): L.FpInfo | null => (fpSel >= 0 ? fpList[fpSel] || null : null);
  const missing = (r: Row) => loaded && !byId.has(r.fp);

  // ------------------------------------------------------------ footprint list
  /** FOOTPRINTS_LISTBOX::SetFootprints: refilter, keep the old selection when it survives, else the first row. */
  const setFootprints = () => {
    const old = selectedFp(); const oldKey = old ? fpKey(old) : null;
    fpList = L.filterFootprints(all, { flags, lib: curLib, sym: symFilter(symbol()), text: filterText });
    const k = oldKey ? fpList.findIndex((f) => fpKey(f) === oldKey) : -1;
    fpSel = fpList.length ? (k >= 0 ? k : 0) : -1;
  };
  /** SetSelectedFootprint: the row of that LIB_ID, compared ignoring case. */
  const setSelectedFootprint = (fpid: string) => { const id = fpid.toLowerCase(); const k = fpList.findIndex((f) => fpKey(f).toLowerCase() === id); if (k >= 0) fpSel = k; };

  // ------------------------------------------------------------ status lines
  const libUri = (name: string): string => { const l = libs.find((x) => x.name === name); return l ? l.uri : ""; };
  const displayStatus = () => {
    if (!statusEls.length) return;
    const s = symbol();
    statusEls[0]!.textContent = autoMsg || (loaded ? L.filterStatus(flags, symFilter(s), curLib, filterText, fpList.length) : loadMsg);
    const fp = selectedFp();
    statusEls[1]!.textContent = savedMsg || L.footprintStatus(fp);
    let lib = "";
    if (fp) lib = fp.lib; else if (focus === "sym") { if (s) lib = L.parseFpid(s.fp).lib; } else if (focus === "lib") lib = curLib;
    const uri = lib ? libUri(lib) : "";
    statusEls[2]!.textContent = uri ? `Library location: ${uri}` : "";
    updateToolbar();
  };

  // ------------------------------------------------------------ cross-probing (SendComponentSelectionToSch)
  const crossProbe = (clear = false) => {
    if (appState.docId !== here) return;   // the editor shows another sheet now: nothing of it to select
    const ids: string[] = [];
    if (!clear) for (const i of sel) for (const m of rows[i]?.members || []) if (m.docId === here) ids.push(m.id);
    try { toolCtx().setSelection(ids); } catch (e) { /* best effort */ }
  };

  // ------------------------------------------------------------ the viewer follows the selection (RefreshFootprintViewer)
  let viewerPending = false;
  const refreshViewer = () => { if (!viewer || viewerPending) return; viewerPending = true; requestAnimationFrame(() => { viewerPending = false; if (viewer) viewer.update(); displayStatus(); }); };

  const refreshAll = () => { symList.refresh(); libList.refresh(); fpListBox.refresh(); displayStatus(); };
  /** OnSelectComponent: refilter, show the symbol's own footprint, refresh the viewer, cross-probe. */
  const onSelectComponent = () => {
    savedMsg = ""; autoMsg = "";
    setFootprints();
    const s = symbol(); if (s && L.parseFpid(s.fp).valid) setSelectedFootprint(s.fp);
    fpListBox.refresh(); if (fpSel >= 0) fpListBox.scrollTo(fpSel);
    refreshViewer(); crossProbe(); refreshAll();
  };
  const setSelectedComponent = (i: number) => { if (i < 0) { sel = []; cur = -1; } else { sel = [i]; cur = i; anchor = i; symList.scrollTo(i); } onSelectComponent(); };

  // ------------------------------------------------------------ associations
  const markRow = () => { symList.refresh(); displayStatus(); };
  /** CVPCB_MAINFRAME::AssociateFootprint. */
  const associateFootprint = (index: number, fpid: string, newEntry: boolean, addUndo = true): boolean => {
    const r = rows[index]; if (!r || ro || !r.editable) return false;
    const p = L.parseFpid(fpid);
    if (fpid && !p.valid) { void messageBox("Error", `'${fpid}' is not a valid footprint.`); return false; }
    const old = r.fp; r.fp = fpid; modified = true;
    if (addUndo) history.record({ index, old, now: fpid }, newEntry);
    markRow();
    return true;
  };
  const applyAssociations = (list: L.Association[]) => { for (const a of list) { const r = rows[a.index]; if (r) { r.fp = a.now; modified = true; } } markRow(); onSelectComponent(); };
  const act: Partial<Record<string, () => void>> = {};
  act.associate = () => {
    if (ro) return;
    const fp = selectedFp(); if (!fp) return;
    const fpid = fpKey(fp);
    let first = true; for (const i of sel) { associateFootprint(i, fpid, first); first = false; }
    act.gotoNextNA!();
  };
  act.deleteAssoc = () => { if (ro) return; let first = true; for (const i of sel) { associateFootprint(i, "", first); first = false; } onSelectComponent(); };
  act.deleteAll = () => {
    if (ro) return;
    void askBox("Confirmation", "Delete all associations?", ["Yes", "No"], 0, 1).then((b) => {
      if (b !== 0) return;
      sel = []; let first = true;
      rows.forEach((_r, i) => { associateFootprint(i, "", first); first = false; });
      setSelectedComponent(rows.length ? 0 : -1);
    });
  };
  act.undo = () => { const e = history.undo(); if (e) applyAssociations(e); };
  act.redo = () => { const e = history.redo(); if (e) applyAssociations(e); };
  const unassigned = () => rows.map((r, i) => (r.fp ? -1 : i)).filter((i) => i >= 0);
  act.gotoNextNA = () => { const i = L.toNA(unassigned(), sel, "next"); if (i !== null) setSelectedComponent(i); };
  act.gotoPreviousNA = () => { const i = L.toNA(unassigned(), sel, "prev"); if (i !== null) setSelectedComponent(i); };
  // clipboard (CVPCB_ASSOCIATION_TOOL::CopyAssoc / CutAssoc / PasteAssoc): the LIB_ID as text
  const clipText = async (): Promise<string> => { try { if (navigator.clipboard && navigator.clipboard.readText) { const t = await navigator.clipboard.readText(); if (t) return t; } } catch (e) { /* permission: the page's buffer */ } return appClipboard.get(); };
  act.copy = () => {
    let id = "";
    if (focus === "fp") { const fp = selectedFp(); id = fp ? fpKey(fp) : ""; } else { const s = symbol(); id = s ? s.fp : ""; }
    if (!L.parseFpid(id).valid) return;
    appClipboard.set(id);
  };
  act.cut = () => {
    if (ro || focus !== "sym") return;
    const s = symbol(); if (!s || !sel.length || !L.parseFpid(s.fp).valid) return;
    appClipboard.set(s.fp); associateFootprint(Math.min(...sel), "", true); onSelectComponent();
  };
  act.paste = () => {
    if (ro || !sel.length) return;
    const idx = sel.slice();
    void clipText().then((t) => {
      const text = t.trim(); const p = L.parseFpid(text); if (!text || text.includes("\n") || p.empty) return;
      let first = true; for (const i of idx) { associateFootprint(i, text, first); first = false; }
      onSelectComponent();
    });
  };
  act.autoAssociate = () => { if (!ro) void autoAssociate(); };
  act.saveAssociationsToSchematic = () => { void save(false); };
  act.showFootprintViewer = () => {
    if (viewer) { viewer.front(); viewer.update(); return; }
    viewer = openFpViewer({
      selectedFootprint: () => { const fp = selectedFp(); if (fp) return fpKey(fp); const s = symbol(); return s ? s.fp : ""; },
      info: (fpid) => byId.get(fpid) || null, lib: (name) => libs.find((l) => l.name === name) || null, docs: () => allDocs(),
      onClose: () => { viewer = null; },
    });
  };
  act.showEquFileTable = () => { void openEquFiles(); };
  // InvokePcbLibTableEditor: the project's fp-lib-table; saving it reloads the libraries (KiwayMailIn MAIL_RELOAD_LIB)
  act.showFootprintLibTable = () => { void manageLibraries("footprint", { readOnly: !!E.viewOnly, onSaved: () => { if (current) void loadLibraries(); } }); };
  act.openPreferences = () => openPreferences();
  // Preferences > Configure Paths... (DIALOG_CONFIGURE_PATHS through the frame's common tools)
  act.configurePaths = () => { void import("./configure-paths").then((m) => m.configurePaths(() => { /* nothing to reload here */ })); };
  act.close = () => { void doClose(false); };
  const setFilter = (bit: number) => { flags ^= bit; cfg.filter_footprint = flags; saveSettings(cfg); renderToolbar(); onSelectComponent(); };
  act.FilterFPbyFPFilters = () => setFilter(L.FILTER_FP_FILTERS);
  act.filterFPbyPin = () => setFilter(L.FILTER_PIN_COUNT);
  act.FilterFPbyLibrary = () => setFilter(L.FILTER_LIBRARY);

  // CVPCB_MAINFRAME::AutomaticFootprintMatching
  const autoAssociate = async () => {
    const { list, errors } = await readEquivalences();
    if (errors.length) await messageBox("Equivalence File Load Error", errors.join("\n\n"));
    const sorted = L.sortEquivalences(list);
    const res = L.autoAssociate(rows.map((r) => ({ ref: r.ref, value: r.value, fpid: r.fp, filters: r.filters })), sorted, (id) => byId.get(id) || null);
    let first = true; for (const a of res.assign) { if (associateFootprint(a.index, a.fpid, first)) first = false; }
    autoMsg = `${sorted.length} footprint/symbol equivalences found.`;
    symList.refresh(); displayStatus();
    if (res.warnings.length) await messageBox("CvPcb Warning", res.warnings.join("\n\n"));
  };

  // ------------------------------------------------------------ writing back (SaveFootprintAssociation)
  const save = async (andFiles: boolean): Promise<boolean> => {
    if (ro) return true;
    const sch = CollabTools.sch as SchToolModule & { fieldsTableChanges(doc: KDoc, edits: { id: string; values: Record<string, string> }[]): KChange[] };
    const byDoc = new Map<string, { id: string; values: Record<string, string> }[]>();
    for (const r of rows) if (r.fp !== r.orig) for (const m of r.members) { const l = byDoc.get(m.docId) || []; l.push({ id: m.id, values: { Footprint: r.fp } }); byDoc.set(m.docId, l); }
    try {
      for (const [docId, edits] of byDoc) {
        if (!docs.has(docId)) continue;
        // the sheet the editor shows now (which may no longer be the one the frame opened on) goes through its own
        // undo history; any other sheet as it stands on the server now, through a side session
        if (docId === appState.docId && E.kdoc) { const ch = sch.fieldsTableChanges(E.kdoc as KDoc, edits); if (ch.length) toolCtx().commit(ch, "assign footprints"); docs.set(docId, E.kdoc as KDoc); continue; }
        const d = await readDoc(docId, "kicad_sch"); const ch = sch.fieldsTableChanges(d, edits); if (!ch.length) continue;
        await submitDocOp(docId, ch); docs.set(docId, await readDoc(docId, "kicad_sch"));
      }
    } catch (e) { await messageBox("Error", "Could not assign the footprints: " + (e as Error).message); return false; }
    for (const r of rows) r.orig = r.fp;
    modified = false;
    // the web commits every change to the shared document at once: "saving the schematic" is that commit
    if (andFiles) savedMsg = "Schematic saved";
    displayStatus();
    return true;
  };

  // ------------------------------------------------------------ closing (canCloseWindow / doCloseWindow)
  const doClose = async (force: boolean): Promise<boolean> => {
    if (!force && modified && !ro) {
      const b = await askBox("Save Changes?", "Symbol to Footprint links have been modified. Save changes?", ["Save", "Discard Changes", "Cancel"], 0, 2);
      if (b === 2) return false;
      if (b === 0 && !(await save(false))) return false;
    }
    if (viewer) { viewer.close(); viewer = null; }
    modified = false;
    crossProbe(true);
    closeMenus();
    if (win) win.close();
    window.removeEventListener("kc-doc-saved", onLibChanged as EventListener);
    current = null;
    return true;
  };

  // ------------------------------------------------------------ toolbar (CVPCB_TOOLBAR_SETTINGS::DefaultToolbarConfig)
  const enabled = (id: string): boolean => {
    switch (id) {
      case "saveAssociationsToSchematic": return !ro && modified;
      case "undo": return !ro && history.canUndo();
      case "redo": return !ro && history.canRedo();
      case "autoAssociate": case "deleteAll": return !ro && rows.length > 0;
      case "showFootprintLibTable": return !!appState.project;
    }
    return !!act[id];
  };
  const checked = (id: string): boolean => (id === "FilterFPbyFPFilters" ? !!(flags & L.FILTER_FP_FILTERS) : id === "filterFPbyPin" ? !!(flags & L.FILTER_PIN_COUNT) : id === "FilterFPbyLibrary" ? !!(flags & L.FILTER_LIBRARY) : false);
  const tbButton = (id: string, toggle = false): HTMLButtonElement => {
    const m = cvMeta(id); const run = act[id];
    const b = h("button", { class: "se-btn" + (toggle && checked(id) ? " on" : ""), "data-act": id, title: m.tip + (m.key ? ` (${keyName(m.key)})` : "") + (run ? "" : " — runs in the KiCad desktop app"), "aria-label": m.label, "aria-pressed": toggle ? String(checked(id)) : undefined }, icon(m.icon)) as HTMLButtonElement;
    b.disabled = !enabled(id);
    b.addEventListener("click", () => { if (!b.disabled && act[id]) act[id]!(); });
    return b;
  };
  const renderToolbar = () => {
    if (!tbHost) return;
    tbHost.replaceChildren();
    const spec = (window as unknown as { KiCadUiToolbars?: Record<string, Record<string, { id?: string; sep?: boolean; control?: string }[]>> }).KiCadUiToolbars;
    const items = (spec && spec.cvpcb && spec.cvpcb.top) || [];
    for (const it of items) {
      if (it.sep) tbHost.append(h("span", { class: "se-sep" }));
      else if (it.control === "footprintFilter") {
        // footprintFilterFactory: AppendSpacer( 15 ), the bold label, three toggles, a separator, the filter text
        tbHost.append(h("span", { style: "width:15px;flex:none" }), h("span", { class: "cv-flabel" }, "Footprint Filters:"),
          tbButton("FilterFPbyFPFilters", true), tbButton("filterFPbyPin", true), tbButton("FilterFPbyLibrary", true), h("span", { class: "se-sep" }), filterInput);
      } else if (it.id) tbHost.append(tbButton(it.id));
    }
  };
  const updateToolbar = () => {
    if (!tbHost) return;
    for (const b of Array.from(tbHost.querySelectorAll<HTMLButtonElement>("button[data-act]"))) {
      const id = b.dataset.act!; b.disabled = !enabled(id);
      if (b.hasAttribute("aria-pressed")) { const on = checked(id); b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }
    }
  };

  // ------------------------------------------------------------ menus (doReCreateMenuBar, setupUIConditions)
  const mi = (id: string, en?: () => boolean, label?: string): MenuEntry => { const m = cvMeta(id); const run = act[id]; return { id, label: label || m.label, icon: m.icon, key: m.key, tip: m.tip, run, enabled: run ? (en || (() => enabled(id))) : () => false }; };
  const dispatch = (id: string) => { const app = (window as unknown as { CollabApp?: { dispatch(a: unknown): void } }).CollabApp; if (app) app.dispatch({ type: "action", id, anchor: null }); };
  const link = (id: string): MenuEntry => { const m = cvMeta(id); return { id, label: m.label !== id ? m.label : (LOCAL_LABELS[id] || id), icon: m.icon, run: () => { window.open(LINKS[id], "_blank", "noopener"); }, enabled: () => !!LINKS[id] }; };
  const S: MenuEntry = { sep: true };
  const menus = (): [string, MenuEntry[]][] => [
    ["File", [mi("saveAssociationsToSchematic"), S, { id: "close", label: "Close", icon: "exit", tip: "Close Assign Footprints", key: "Ctrl+W", run: act.close, enabled: () => true }]],
    ["Edit", [mi("undo"), mi("redo"), S, mi("cut", () => !ro && focus === "sym" && !!symbol() && L.parseFpid(symbol()!.fp).valid), mi("copy", () => true), mi("paste", () => !ro && sel.length > 0)]],
    ["Preferences", [mi("configurePaths"), mi("showFootprintLibTable", () => !!appState.project), mi("showEquFileTable", () => !ro && !!appState.project), mi("openPreferences", () => true), S, { label: "Set Language" }]],
    ["Help", [link("help"), link("gettingStarted"), { ...mi("listHotKeys"), run: () => dispatch("listHotKeys"), enabled: () => true }, link("getInvolved"), link("donate"), link("reportBug"), S,
      { id: "about", label: LOCAL_LABELS.about || "About", icon: "about", run: () => dispatch("about"), enabled: () => true }]],
  ];
  const renderMenubar = (mb: HTMLElement) => {
    for (const [label, _items] of menus()) {
      const b = h("div", { class: "se-mb", role: "menuitem", "data-menu": label }, label);
      const openIt = () => { const r = b.getBoundingClientRect(); closeMenus(); b.classList.add("open"); showMenu(r.left, r.bottom, menus().find((m) => m[0] === label)![1], 0, { below: r, gap: 0, noFlip: true }); };
      b.addEventListener("click", (ev) => { ev.stopPropagation(); if (b.classList.contains("open")) closeMenus(); else openIt(); });
      b.addEventListener("pointerenter", () => { if (document.querySelector(".se-mb.open") && !b.classList.contains("open")) openIt(); });
      mb.append(b);
    }
  };
  // context menus (CVPCB_MAINFRAME::setupEventHandlers: m_symbolsContextMenu / m_footprintContextMenu)
  const symMenu = (): MenuEntry[] => [mi("showFootprintViewer", () => true), S, mi("cut", () => !ro && !!symbol() && L.parseFpid(symbol()!.fp).valid), mi("copy", () => true), mi("paste", () => !ro && sel.length > 0), S, mi("deleteAssoc", () => !ro && sel.length > 0)];
  const fpMenu = (): MenuEntry[] => [mi("showFootprintViewer", () => true)];

  // ------------------------------------------------------------ focus (SetFocusedControl)
  const panes: Record<Focus, HTMLElement> = {} as Record<Focus, HTMLElement>;
  const setFocus = (f: Focus) => {
    focus = f;
    for (const k of ["lib", "sym", "fp"] as Focus[]) panes[k].classList.toggle("cv-focus", k === f);
    const l = f === "lib" ? libList : f === "sym" ? symList : fpListBox;
    if (document.activeElement !== l.el) l.el.focus({ preventScroll: true });
    displayStatus();
  };
  const ORDER: Focus[] = ["lib", "sym", "fp"];

  // ------------------------------------------------------------ lists
  symList = vlist({
    id: "cv-syms", count: () => rows.length,
    text: (i) => { const r = rows[i]!; return L.formatSymbolDesc(i + 1, r.ref, r.value, r.fp); },
    cls: (i) => (sel.includes(i) ? "sel" : missing(rows[i]!) ? "warn" : "") + (i === cur && focus === "sym" ? " cur" : ""),
    down: (i, ev) => {
      setFocus("sym");
      if (ev.shiftKey && anchor >= 0) { const a = Math.min(anchor, i), b = Math.max(anchor, i); sel = []; for (let k = a; k <= b; k++) sel.push(k); }
      else if (ev.ctrlKey || ev.metaKey) { sel = sel.includes(i) ? sel.filter((k) => k !== i) : [...sel, i].sort((a, b) => a - b); anchor = i; }
      else { sel = [i]; anchor = i; }
      cur = i; onSelectComponent();
    },
    ctx: (i, ev) => { setFocus("sym"); if (i >= 0 && !sel.includes(i)) { sel = [i]; cur = anchor = i; onSelectComponent(); } showMenu(ev.clientX, ev.clientY, symMenu()); },
    empty: () => "No symbols on the schematic.",
  });
  const pickLib = (i: number) => { const l = libs[i]; if (!l) return; curLib = l.name; libList.scrollTo(i); onSelectComponent(); };
  libList = vlist({
    id: "cv-libs", count: () => libs.length, text: (i) => libRows()[i]!,
    cls: (i) => (libs[i]!.name === curLib ? "sel" : ""), title: (i) => libs[i]!.descr || undefined,
    down: (i) => { setFocus("lib"); pickLib(i); },
    empty: () => (loaded ? "Footprint libraries are not available on this server." : "Loading footprint libraries..."),
  });
  const pickFp = (i: number) => { if (i < 0 || i >= fpList.length) return; fpSel = i; savedMsg = ""; fpListBox.scrollTo(i); fpListBox.refresh(); refreshViewer(); displayStatus(); };
  fpListBox = vlist({
    id: "cv-fps", count: () => fpList.length,
    text: (i) => L.formatFootprintRow(i + 1, fpList[i]!.lib, fpList[i]!.name), cls: (i) => (i === fpSel ? "sel" : ""), title: (i) => fpList[i]!.desc || undefined,
    down: (i) => { setFocus("fp"); pickFp(i); }, dbl: (i) => { pickFp(i); act.associate!(); },
    ctx: (i, ev) => { setFocus("fp"); if (i >= 0) pickFp(i); showMenu(ev.clientX, ev.clientY, fpMenu()); },
    empty: () => (loaded ? (libs.length ? "" : "Footprint libraries are not available on this server.") : "Loading footprint libraries..."),
  });

  // ------------------------------------------------------------ keyboard (CVPCB_CONTROL::Main, the listboxes' OnChar, the hotkeys)
  const moveIn = (f: Focus, to: number, ext: boolean) => {
    if (f === "sym") {
      if (!rows.length) return; const i = Math.max(0, Math.min(rows.length - 1, to));
      if (ext && anchor >= 0) { const a = Math.min(anchor, i), b = Math.max(anchor, i); sel = []; for (let k = a; k <= b; k++) sel.push(k); } else { sel = [i]; anchor = i; }
      cur = i; symList.scrollTo(i); onSelectComponent();
    } else if (f === "lib") { if (libs.length) pickLib(Math.max(0, Math.min(libs.length - 1, to))); }
    else if (fpList.length) pickFp(Math.max(0, Math.min(fpList.length - 1, to)));
  };
  const posOf = (f: Focus) => (f === "sym" ? (cur >= 0 ? cur : -1) : f === "lib" ? libs.findIndex((l) => l.name === curLib) : fpSel);
  const countOf = (f: Focus) => (f === "sym" ? rows.length : f === "lib" ? libs.length : fpList.length);
  const pageOf = (f: Focus) => (f === "sym" ? symList : f === "lib" ? libList : fpListBox).page();
  const onKey = (ev: KeyboardEvent) => {
    ev.stopPropagation();
    if (document.querySelector(".se-menu")) { if (ev.key === "Escape") { ev.preventDefault(); closeMenus(); } return; }
    const t = ev.target as HTMLElement; const typing = t === filterInput;
    const mod = ev.ctrlKey || ev.metaKey, k = ev.key;
    const run = (id: string) => { ev.preventDefault(); if (enabled(id) && act[id]) act[id]!(); };
    if (mod && !ev.altKey) {
      const c = k.toLowerCase();
      if (c === "s" && !ev.shiftKey) return run("saveAssociationsToSchematic");
      if (c === "w" && !ev.shiftKey) { ev.preventDefault(); act.close!(); return; }
      if (typing) return;
      if (c === "z" && !ev.shiftKey) return run("undo");
      if (c === "y" || (c === "z" && ev.shiftKey)) return run("redo");
      if (c === "x") { ev.preventDefault(); act.cut!(); return; }
      if (c === "c") { ev.preventDefault(); act.copy!(); return; }
      if (c === "v") { ev.preventDefault(); act.paste!(); return; }
      return;
    }
    if (k === "Escape") { ev.preventDefault(); act.close!(); return; }
    if (typing) { if (k === "Enter") { ev.preventDefault(); clearTimeout(filterTimer); applyFilterText(); } else if (k === "Tab") { ev.preventDefault(); setFocus(ev.shiftKey ? "fp" : "lib"); } return; }
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "K-SELECT")) return;
    if (k === "Tab" || k === "ArrowRight" || k === "ArrowLeft") {
      ev.preventDefault(); const right = k === "ArrowRight" || (k === "Tab" && !ev.shiftKey);
      setFocus(ORDER[(ORDER.indexOf(focus) + (right ? 1 : 2)) % 3]!); return;
    }
    if (k === "Enter") return run("associate");
    if (k === "Delete") { if (focus === "sym") run("deleteAssoc"); return; }
    const p = posOf(focus), n = countOf(focus), ext = ev.shiftKey && focus === "sym";
    if (k === "ArrowDown") { ev.preventDefault(); moveIn(focus, p < 0 ? 0 : p + 1, ext); return; }
    if (k === "ArrowUp") { ev.preventDefault(); moveIn(focus, p < 0 ? 0 : p - 1, ext); return; }
    if (k === "Home") { ev.preventDefault(); moveIn(focus, 0, ext); return; }
    if (k === "End") { ev.preventDefault(); moveIn(focus, n - 1, ext); return; }
    if (k === "PageDown") { ev.preventDefault(); moveIn(focus, (p < 0 ? 0 : p) + pageOf(focus), ext); return; }
    if (k === "PageUp") { ev.preventDefault(); moveIn(focus, (p < 0 ? 0 : p) - pageOf(focus), ext); return; }
    if (k.length === 1 && !ev.altKey && /\S/.test(k)) {
      // type-ahead: the footprint name after the line number, the library nickname, the symbol reference
      let i = -1;
      if (focus === "fp") i = L.typeAheadFootprint(fpList.map((f, j) => L.formatFootprintRow(j + 1, f.lib, f.name).replace(/^(\s*\d+ )[^:]*:/, "$1")), k);
      else if (focus === "lib") i = L.typeAheadFrom(libs.map((l) => l.name), k, p);
      else i = L.typeAheadFrom(rows.map((r) => r.ref), k, p);
      if (i >= 0) { ev.preventDefault(); moveIn(focus, i, false); }
    }
  };

  // ------------------------------------------------------------ the filter text (debounced 200 ms, Enter applies at once)
  let filterTimer = 0;
  const applyFilterText = () => { filterText = filterInput.value; cfg.filter_footprint_text = filterText; saveSettings(cfg); onSelectComponent(); };
  filterInput = h("input", { type: "text", class: "cv-ftext", id: "cv-filter", "aria-label": "Footprint filter text", value: filterText, spellcheck: "false" }) as HTMLInputElement;
  filterInput.addEventListener("input", () => { clearTimeout(filterTimer); filterTimer = window.setTimeout(applyFilterText, 200); });

  // ------------------------------------------------------------ the window
  build();
  win = cvWindow({ id: "cvpcb", title: "Assign Footprints", geomKey: "cvpcb", width: Math.min(1180, window.innerWidth - 40), height: Math.min(720, window.innerHeight - 60), onCloseBox: () => { void doClose(false); } });
  const mb = h("div", { class: "se-menubar", role: "menubar" }); renderMenubar(mb);
  tbHost = h("div", { class: "se-tb", role: "toolbar", id: "cv-toolbar" });
  const W = win.root.getBoundingClientRect().width;
  const libW = cfg.libraries_pane_width > 20 ? cfg.libraries_pane_width : Math.round(W * 0.2), fpW = cfg.footprints_pane_width > 20 ? cfg.footprints_pane_width : Math.round(W * 0.3);
  const pane = (f: Focus, caption: string, list: VList, w?: number) => { const p = h("div", { class: "cv-pane" + (w ? "" : " cv-center"), "data-pane": f, style: w ? `width:${w}px` : "" }, h("div", { class: "cv-cap" }, caption), list.el); panes[f] = p; list.el.addEventListener("focus", () => { if (focus !== f) setFocus(f); }); return p; };
  const libPane = pane("lib", "Footprint Libraries", libList, libW), symPane = pane("sym", "Symbol : Footprint Assignments", symList), fpPane = pane("fp", "Filtered Footprints", fpListBox, fpW);
  const splitter = (target: HTMLElement, side: "left" | "right") => {
    const s = h("div", { class: "cv-split", role: "separator", "aria-orientation": "vertical" });
    let from: [number, number] | null = null;
    s.addEventListener("pointerdown", (ev) => { ev.preventDefault(); from = [ev.clientX, target.getBoundingClientRect().width]; s.setPointerCapture(ev.pointerId); s.classList.add("drag"); });
    s.addEventListener("pointermove", (ev) => { if (!from) return; const d = ev.clientX - from[0]; const total = win!.root.getBoundingClientRect().width; target.style.width = Math.max(20, Math.min(total - 140, from[1] + (side === "left" ? d : -d))) + "px"; });
    s.addEventListener("pointerup", () => { if (!from) return; from = null; s.classList.remove("drag"); cfg.libraries_pane_width = Math.round(libPane.getBoundingClientRect().width); cfg.footprints_pane_width = Math.round(fpPane.getBoundingClientRect().width); saveSettings(cfg); });
    return s;
  };
  statusEls = [h("div", { id: "cv-status1" }), h("div", { id: "cv-status2" }), h("div", { id: "cv-status3" })];
  const btn = (label: string, cls: string, fn: () => void, id: string) => { const b = h("button", { class: "btn " + cls, id }, label); b.addEventListener("click", fn); return b; };
  const bottom = h("div", { class: "cv-bottom" }, h("div", { class: "cv-status" }, ...statusEls),
    h("div", { class: "cv-buttons" },
      btn("Apply, Save Schematic & Continue", "cv-apply", () => { void save(true); }, "cv-apply"),
      btn("Cancel", "", () => { void doClose(false); }, "cv-cancel"),
      btn("OK", "primary", () => { void save(false).then((ok) => { if (ok) void doClose(true); }); }, "cv-ok")));
  if (ro) for (const b of Array.from(bottom.querySelectorAll<HTMLButtonElement>("#cv-apply, #cv-ok"))) b.disabled = true;
  win.body.append(mb, tbHost, h("div", { class: "cv-main" }, libPane, splitter(libPane, "left"), symPane, splitter(fpPane, "right"), fpPane), bottom);
  win.root.addEventListener("keydown", onKey);
  renderToolbar();
  current = { close: (force?: boolean) => doClose(!!force), front: () => win && win.front() };

  // the first unassigned symbol is selected on open (readwrite_dlgs.cpp ReadNetListAndFpFiles)
  // (SetSelection only when firstUnassigned >= 0: with every symbol assigned nothing is selected)
  const firstUn = rows.findIndex((r) => !r.fp);
  sel = firstUn >= 0 ? [firstUn] : []; cur = anchor = sel.length ? sel[0]! : -1;
  setFocus("sym"); onSelectComponent(); if (cur >= 0) symList.scrollTo(cur);

  // ------------------------------------------------------------ the footprint libraries (LoadFootprintFiles, BuildLibrariesList)
  const pinnedLibs = (): Set<string> => {
    const out = new Set<string>();
    try { for (const n of JSON.parse(localStorage.getItem("kui.fpedit.pinned") || "[]") as string[]) out.add(n); } catch (e) { /* none */ }
    const pro = projectJson(); const l = pro.libraries; const p = l && typeof l === "object" && !Array.isArray(l) ? (l as Record<string, unknown>).pinned_footprint_libs : null;
    if (Array.isArray(p)) for (const n of p) if (typeof n === "string") out.add(n);
    return out;
  };
  const loadLibraries = async () => {
    loaded = false; loadMsg = "Loading footprint libraries..."; displayStatus();
    const entries: CvLib[] = [];
    try { const t = await src.officialLibraries("footprint"); for (const l of t.libraries) entries.push({ name: l.name, pinned: false, source: "official", descr: l.description || "", uri: OFFICIAL_URI(l.name) }); } catch (e) { /* the server offers none */ }
    // the project's own libraries: its fp-lib-table rows that point into the project, then *.pretty folders it does not name
    const pdocs = allDocs();
    const table = pdocs.find((d) => d.path === "fp-lib-table");
    let tableRows: { name: string; uri: string }[] = [];
    if (table) { try { const r = await fetch(`/api/docs/${table.docId}/content`, { credentials: "same-origin" }); if (r.ok) tableRows = src.libTableRows(await r.text()); } catch (e) { /* no table */ } }
    const covered = new Set<string>();
    for (const row of tableRows) {
      const dir = src.projectRelativeUri(row.uri); if (dir === null) continue;
      const files = pdocs.filter((d) => /\.kicad_mod$/i.test(d.path) && d.path.slice(0, d.path.lastIndexOf("/")) === dir);
      covered.add(dir); const i = entries.findIndex((e) => e.name === row.name); const e: CvLib = { name: row.name, pinned: false, source: "project", descr: "", uri: row.uri, docs: files };
      if (i >= 0) entries[i] = e; else entries.push(e);
    }
    for (const pl of src.projectLibraries("footprint", pdocs)) {
      const dir = pl.docs[0] ? pl.docs[0].path.slice(0, pl.docs[0].path.lastIndexOf("/")) : ""; if (covered.has(dir)) continue;
      const e: CvLib = { name: pl.name, pinned: false, source: "project", descr: "", uri: "${KIPRJMOD}/" + dir, docs: pl.docs }; const i = entries.findIndex((x) => x.name === pl.name);
      if (i >= 0) entries[i] = e; else entries.push(e);
    }
    const pins = pinnedLibs();
    const order = L.libraryOrder(entries.map((e) => e.name), pins);
    const byName = new Map(entries.map((e) => [e.name, e]));
    libs = order.map((o) => Object.assign(byName.get(o.name)!, { pinned: o.pinned }));
    libList.refresh();
    // every footprint of every library (FOOTPRINT_LIST_IMPL::ReadFootprintFiles), eight libraries at a time
    const lists = new Map<string, L.FpInfo[]>(); let done = 0, next = 0, lastPaint = 0;
    const publish = () => { all = []; for (const l of libs) { const f = lists.get(l.name); if (f) all.push(...f); } all.sort(L.fpInfoCmp); byId = new Map(all.map((f) => [fpKey(f), f])); };
    const worker = async () => {
      while (next < libs.length) {
        const l = libs[next++]!; let out: L.FpInfo[] = [];
        try {
          if (l.source === "official") out = (await src.officialIndex("footprint", l.name)).map((f) => ({ lib: l.name, name: f.name, desc: f.description || "", keywords: f.keywords || "", pads: typeof f.pads === "number" ? f.pads : -1 }));
          else out = await Promise.all((l.docs || []).map(async (d) => {
            const name = d.path.split("/").pop()!.replace(/\.kicad_mod$/i, "");
            try { const r = await fetch(`/api/docs/${d.docId}/content`, { credentials: "same-origin" }); const fi = core.footprintInfo(await r.text()); return { lib: l.name, name, desc: fi.description, keywords: fi.keywords, pads: fi.pads }; }
            catch (e) { return { lib: l.name, name, desc: "", keywords: "", pads: -1 }; }
          }));
        } catch (e) { out = []; }
        lists.set(l.name, out); done++;
        loadMsg = `Loading footprint libraries... (${done} of ${libs.length})`;
        const now = performance.now(); if (now - lastPaint > 400 && current) { lastPaint = now; publish(); setFootprints(); fpListBox.refresh(); displayStatus(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, libs.length) }, worker));
    if (!current) return;
    publish(); loaded = true; onSelectComponent();
  };
  void loadLibraries();
  // KiwayMailIn MAIL_RELOAD_LIB: the library table changed
  const onLibChanged = (ev: CustomEvent) => { const id = ev.detail && (ev.detail.savedDocId || ev.detail.docId); const t = allDocs().find((d) => d.path === "fp-lib-table"); if (t && id === t.docId) void loadLibraries(); };
  window.addEventListener("kc-doc-saved", onLibChanged as EventListener);
  void loadProject().then(() => { if (current) { const pins = pinnedLibs(); if (libs.some((l) => l.pinned !== pins.has(l.name))) { const o = L.libraryOrder(libs.map((l) => l.name), pins); const m = new Map(libs.map((l) => [l.name, l])); libs = o.map((x) => Object.assign(m.get(x.name)!, { pinned: x.pinned })); libList.refresh(); } } });

  // the other sheets of the project
  const others = allDocs().filter((d) => d.docType === "kicad_sch" && d.docId !== here);
  if (others.length) void Promise.all(others.map((d) => readDoc(d.docId, "kicad_sch").then((od) => { docs.set(d.docId, od); }, () => { /* left out */ }))).then(() => {
    if (!current) return;
    const before = rows, keep = sel.map((i) => rows[i]?.ref); build();
    // the rows are rebuilt and re-sorted: the undo / redo entries follow their symbols to the new rows
    const key = (r: Row) => r.members[0]!.docId + "\u0000" + r.members[0]!.id;
    const now = new Map(rows.map((r, i) => [key(r), i]));
    history.remap((i) => { const r = before[i]; const j = r ? now.get(key(r)) : undefined; return j === undefined ? -1 : j; });
    sel = keep.map((r) => rows.findIndex((x) => x.ref === r)).filter((i) => i >= 0);
    if (!sel.length) { const f = rows.findIndex((r) => !r.fp); if (f >= 0) sel = [f]; }
    cur = anchor = sel.length ? sel[0]! : -1; onSelectComponent(); if (cur >= 0) symList.scrollTo(cur);
  });
}
