// panels/search.ts — KiCad's Search pane (common/widgets/search_pane.cpp with the handlers in
// pcbnew/widgets/search_handlers.cpp and eeschema/widgets/search_handlers.cpp): one tab per handler with
// the handler's columns, a filter box matching any cell, and rows that select and zoom to their item.
// The schematic tabs cover every sheet of the project (the sheets that are not open come from the
// hierarchy's cache); a row on another sheet opens that sheet first.
import type { PanelAction, SearchOpts, SearchResult, SearchRow, SearchTab, SelectionZoom } from "../../panels-api";
import { openSelectionProperties } from "../pointer";
import { openBoardSetup } from "../pcbdialogs/board-setup";
import { centerOn } from "../comments";
import { openDoc } from "../doc";
import { E } from "../state";
import { fitBox } from "../view";
import { layerDisplayName, netClassOf } from "./appearance";
import { KC, currentDocId, isSchDoc, kdoc, pcbTools, tctx } from "./core";
import { pageOfDoc, schDocs, sheetDoc } from "./hierarchy";
import { drillCells, drillLines, groupLeafIds, groupName, itemFields, searchTexts, sortRows } from "./search-model";

interface PropsHelpers { formatLength(mm: number, unit: string): string; netNameOf(doc: KDoc, n: SNode): string; yes(n: SNode, k: string, d: boolean): boolean }
const H = (): PropsHelpers => (window.CollabTools.props as unknown as { helpers: PropsHelpers }).helpers;
const len = (v: number) => H().formatLength(v, String(E.units || "mm"));

type Col = [string, number, "left" | "center" | "right"];
const tab = (id: string, label: string, cols: Col[]): SearchTab => ({ id, label, columns: cols.map((c) => c[0]), props: cols.map((c) => c[1]), align: cols.map((c) => c[2]) });
const L = "left" as const, C = "center" as const, R = "right" as const;
// m_columns of each handler: name, proportion, wxLIST_FORMAT (pcbnew/widgets/search_handlers.cpp)
const PCB_TABS: SearchTab[] = [
  tab("footprints", "Footprints", [["Reference", 2, L], ["Value", 6, L], ["Layer", 2, C], ["X", 3, C], ["Y", 3, C], ["Library Link", 8, L], ["Library Description", 10, L]]),
  tab("zones", "Zones", [["Name", 6, L], ["Net", 6, L], ["Layer", 3, C], ["Priority", 2, C], ["X", 3, C], ["Y", 3, C], ["Area", 3, R]]),
  tab("nets", "Nets", [["Name", 6, L], ["Class", 6, L]]),
  tab("ratsnest", "Ratsnest", [["Name", 6, L], ["Class", 6, L]]),
  tab("text", "Text", [["Type", 2, L], ["Text", 12, L], ["Layer", 3, C], ["X", 3, C], ["Y", 3, C]]),
  tab("groups", "Groups", [["Type", 2, L], ["Name", 6, L], ["X", 3, C], ["Y", 3, C]]),
  tab("drills", "Drills", [["Count", 2, R], ["Shape", 3, L], ["X Size", 3, C], ["Y Size", 3, C], ["Plated", 2, C], ["Via/Pad", 2, C], ["Start Layer", 4, C], ["Stop Layer", 4, C]]),
];
// eeschema/widgets/search_handlers.cpp
const SCH_TABS: SearchTab[] = [
  tab("symbols", "Symbols", [["Reference", 2, L], ["Value", 6, L], ["Footprint", 10, L], ["Page", 1, C], ["X", 3, C], ["Y", 3, C], ["Excl. Sim", 2, C], ["Excl. BOM", 2, C], ["Excl. Board", 2, C],
    ["Excl. Pos Files", 2, C], ["DNP", 2, C], ["Library Link", 8, L], ["Library Description", 10, L]]),
  tab("power", "Power", [["Reference", 2, L], ["Value", 6, L], ["Page", 1, C], ["X", 3, C], ["Y", 3, C]]),
  tab("text", "Text", [["Type", 2, L], ["Text", 12, L], ["Page", 1, C], ["X", 3, C], ["Y", 3, C]]),
  tab("labels", "Labels", [["Type", 2, L], ["Name", 6, L], ["Page", 2, C], ["X", 3, C], ["Y", 3, C]]),
  tab("groups", "Groups", [["Name", 6, L], ["Page", 2, C], ["X", 3, C], ["Y", 3, C]]),
];
export function searchTabs(): SearchTab[] { return isSchDoc() ? SCH_TABS : PCB_TABS; }

/** EDA_SEARCH_MATCH_MODE::PERMISSIVE, near enough: a case-insensitive substring, or a * / ? wildcard over the whole cell. */
export function matcher(query: string): (cells: string[]) => boolean {
  const q = query.trim().toLowerCase(); if (!q) return () => true;
  if (/[*?]/.test(q)) { const re = new RegExp("^" + q.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i"); return (cells) => cells.some((c) => re.test(c)); }
  return (cells) => cells.some((c) => c.toLowerCase().includes(q));
}
const field = (n: SNode, name: string): string => { const K = KC(); const p = K.kids(n, "property").find((q) => K.str(q[1]) === name); return p ? K.str(p[2]) : ""; };
function polyArea(pts: [number, number][]): number { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a) / 2; }

const DEFAULT_OPTS: SearchOpts = { hidden: false, metadata: false, sortCol: -1, ascending: true };
function pcbRows(tab: string, doc: KDoc, o: SearchOpts): SearchRow[] {
  const K = KC(), rows: SearchRow[] = [];
  if (tab === "footprints") {
    for (const it of doc.items.values()) { if (it.kind !== "footprint") continue; const [x, y] = K.atOf(it.node);
      const lib = K.str(it.node[1]), descr = K.str((K.kid(it.node, "descr") || [])[1]), tags = K.str((K.kid(it.node, "tags") || [])[1]);
      rows.push({ key: it.id, ids: [it.id], cells: [it.ref || field(it.node, "Reference"), it.value || field(it.node, "Value"), layerDisplayName(doc, it.layer || "F.Cu"), len(x), len(y), lib, descr],
        match: searchTexts(itemFields(it.node as unknown[]), [lib, descr, tags], o) }); }
    rows.sort((a, b) => a.cells[0].localeCompare(b.cells[0], undefined, { numeric: true }));
  } else if (tab === "zones") {
    for (const it of doc.items.values()) { if (it.kind !== "zone") continue; const n = it.node;
      const poly = K.kid(n, "polygon"), pts = poly ? K.ptsOf(poly) : []; const s = K.kid(n, "layer"), m = K.kid(n, "layers");
      const layers = s ? layerDisplayName(doc, K.str(s[1])) : m ? m.slice(1).map((l) => layerDisplayName(doc, K.str(l))).join(", ") : "";
      rows.push({ key: it.id, ids: [it.id], cells: [K.str((K.kid(n, "name") || [])[1]), H().netNameOf(doc, n), layers, String(K.num((K.kid(n, "priority") || [])[1], 0)), pts[0] ? len(pts[0][0]) : "", pts[0] ? len(pts[0][1]) : "", (polyArea(pts)).toFixed(4).replace(/\.?0+$/, "") + " mm²"] }); }
  } else if (tab === "nets" || tab === "ratsnest") {
    const P = pcbTools(); if (!P) return rows;
    let names = P.boardNets(doc).map((n) => n.name);
    if (tab === "ratsnest") { const rat = (window.CollabTools.pcb as unknown as { ratsnest?(d: KDoc): { net: string }[] }).ratsnest; const open = new Set((rat ? rat(doc) : []).map((l) => l.net)); names = names.filter((n) => open.has(n)); }
    for (const name of names) rows.push({ key: "net:" + name, ids: [], cells: [name, netClassOf(name)] });
  } else if (tab === "text") {
    for (const it of doc.items.values()) {
      if (it.kind !== "gr_text" && it.kind !== "gr_text_box" && it.kind !== "dimension") continue; const n = it.node;
      const t = it.kind === "dimension" ? K.kid(n, "gr_text") : n; const at = it.kind === "dimension" ? (t ? K.atOf(t) : [0, 0, 0]) : K.atOf(n);
      const b = it.bbox; const x = K.kid(it.kind === "dimension" && t ? t : n, "at") ? at[0] : b ? (b[0] + b[2]) / 2 : 0, y = K.kid(it.kind === "dimension" && t ? t : n, "at") ? at[1] : b ? (b[1] + b[3]) / 2 : 0;
      rows.push({ key: it.id, ids: [it.id], cells: [it.kind === "gr_text" ? "Text" : it.kind === "gr_text_box" ? "Textbox" : "Dimension", t ? K.str(t[1]) : "", layerDisplayName(doc, K.str((K.kid(n, "layer") || [])[1])), len(x), len(y)] });
    }
  } else if (tab === "groups") {
    // generators (tuning patterns) are internal, not user-facing grouping
    const groups = new Map<string, unknown[]>(); for (const it of doc.items.values()) if (it.kind === "group") groups.set(it.id, it.node as unknown[]);
    for (const it of doc.items.values()) {
      if (it.kind !== "group") continue; const b = KC().bboxOf(doc, groupLeafIds(it.node as unknown[], groups));
      rows.push({ key: it.id, ids: [it.id], cells: ["Group", groupName(it.node as unknown[]), b ? len((b[0] + b[2]) / 2) : "", b ? len((b[1] + b[3]) / 2) : ""] });
    }
  } else if (tab === "drills") {
    const copper = (doc as unknown as { copper?: string[] }).copper || [];
    // KiCad selects the pads and vias of the row; the web selects the vias and the footprints that hold the pads
    for (const d of drillLines(doc.items.values() as Iterable<{ id: string; kind: string; node: unknown[] }>, copper))
      rows.push({ key: "drill:" + [d.xSize, d.ySize, d.slot, d.plated, d.pad, d.start, d.stop].join("|"), ids: d.ids, cells: drillCells(d, len, (l) => layerDisplayName(doc, l)) });
  }
  return rows;
}

const yn = (b: boolean) => (b ? "X" : "");
const LABEL_TYPES: Record<string, string> = { label: "Local", global_label: "Global", hierarchical_label: "Hierarchical", netclass_flag: "Directive", directive_label: "Directive" };
/** The symbol's library keywords (ki_keywords of its lib_symbols entry), for "Search Metadata". */
function symbolKeywords(doc: KDoc, lib: string): string {
  const K = KC(), def = doc.lib && doc.lib.get(lib); if (!def) return "";
  const kw = K.kids(def, "property").find((q) => K.str(q[1]) === "ki_keywords"); return kw ? K.str(kw[2]) : "";
}
function schRows(tab: string, o: SearchOpts): SearchRow[] {
  const K = KC(), rows: SearchRow[] = [];
  for (const d of schDocs()) {
    const doc = sheetDoc(d.docId); if (!doc) continue; const page = pageOfDoc(d.docId); const here = d.docId === currentDocId();
    for (const it of doc.items.values()) {
      const n = it.node, at = () => K.atOf(n); const row = (cells: string[], match?: string[]) => rows.push({ key: d.docId + ":" + it.id, ids: [it.id], cells, docId: here ? undefined : d.docId, match });
      if (it.kind === "symbol") {
        const lib = K.str((K.kid(n, "lib_id") || [])[1]); const ref = field(n, "Reference"); const power = ref.startsWith("#") || /^power:/.test(lib);
        const match = (): string[] => searchTexts(itemFields(n as unknown[]), [lib, field(n, "Description"), symbolKeywords(doc, lib)], o);
        if (tab === "symbols" && !power) row([ref, field(n, "Value"), field(n, "Footprint"), page, len(at()[0]), len(at()[1]), yn(H().yes(n, "exclude_from_sim", false)), yn(!H().yes(n, "in_bom", true)), yn(!H().yes(n, "on_board", true)), yn(!H().yes(n, "in_pos_files", true)), yn(H().yes(n, "dnp", false)), lib, field(n, "Description")], match());
        if (tab === "power" && power) row([ref, field(n, "Value"), page, len(at()[0]), len(at()[1])], match());
      } else if (tab === "text" && (it.kind === "text" || it.kind === "text_box")) row([it.kind === "text" ? "Text" : "Text Box", K.str(n[1]), page, len(at()[0]), len(at()[1])]);
      else if (tab === "labels" && LABEL_TYPES[it.kind]) row([LABEL_TYPES[it.kind], K.str(n[1]), page, len(at()[0]), len(at()[1])]);
      else if (tab === "groups" && it.kind === "group") {
        const groups = new Map<string, unknown[]>(); for (const g of doc.items.values()) if (g.kind === "group") groups.set(g.id, g.node as unknown[]);
        const b = K.bboxOf(doc, groupLeafIds(n as unknown[], groups));
        row([groupName(n as unknown[]), page, b ? len((b[0] + b[2]) / 2) : "", b ? len((b[1] + b[3]) / 2) : ""]);
      }
    }
  }
  const col = tab === "text" || tab === "labels" ? 1 : 0;
  if (tab !== "groups") rows.sort((a, b) => a.cells[col].localeCompare(b.cells[col], undefined, { numeric: true }));
  return rows;
}

const MAX_ROWS = 500;
export function search(tab: string, query: string, opts?: SearchOpts): SearchResult {
  const doc = kdoc(); if (!doc) return { tab, rows: [], total: 0 };
  const o = opts || DEFAULT_OPTS;
  let rows: SearchRow[] = [];
  try { rows = isSchDoc() ? schRows(tab, o) : pcbRows(tab, doc, o); } catch (e) { console.warn(e); }
  const m = matcher(query); rows = rows.filter((r) => m(r.match || r.cells));
  if (o.sortCol >= 0) rows = sortRows(rows, o.sortCol, o.ascending);
  return { tab, rows: rows.slice(0, MAX_ROWS), total: rows.length };
}

/**
 * SEARCH_HANDLER::SelectItems: select the rows' items, then (APP_SETTINGS_BASE::SEARCH_PANE::selection_zoom) zoom to
 * the selection (zoomFitSelection), centre it (centerSelection) or leave the view alone.
 */
function selectAndShow(ids: string[], zoom: SelectionZoom): void {
  const doc = kdoc(); if (!doc) return;
  if (!ids.length) { const P0 = pcbTools(); if (P0) P0.state.sel.clear(); (tctx() as unknown as { setSelection(ids: string[]): void }).setSelection([]); return; }
  const ctx = tctx() as unknown as { setSelection(ids: string[]): void };
  const P = pcbTools(); if (P) P.state.sel.clear();
  if (window.CollabTools.sch && isSchDoc()) window.CollabTools.sch.select(null);
  ctx.setSelection(ids);
  const b = KC().bboxOf(doc, ids); if (!b) return;
  const w = Math.max(b[2] - b[0], 1), h = Math.max(b[3] - b[1], 1);
  E.viewTouched = true;
  if (zoom === "zoom") fitBox([b[0], b[1], w, h], isSchDoc() ? 0.25 : 0.35); else if (zoom === "pan") centerOn((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
}

export function searchDispatch(a: PanelAction): boolean {
  if (a.t !== "searchSelect" && a.t !== "searchActivate") return false;
  const rows = a.t === "searchSelect" ? a.rows : [a.row];
  const after = a.t === "searchActivate" ? () => { setTimeout(() => openSelectionProperties(), 0); } : () => {};
  if (rows.some((r) => r.key.startsWith("net:"))) {
    // NETS_SEARCH_HANDLER::SelectItems highlights every selected net; ActivateItem opens Board Setup at Net Classes
    if (a.t === "searchActivate") { void openBoardSetup(tctx() as never, "netclasses"); return true; }
    const doc = kdoc(), P = pcbTools(); if (!doc || !P) return true;
    const ids = new Set<string>(); for (const r of rows) for (const id of P.netItemIds(doc, r.key.slice(4))) ids.add(id);
    tctx().setHighlight(ids.size ? ids : null); P.state.highlightNet = rows.length ? rows[0].key.slice(4) : null;
    return true;
  }
  // a schematic row on another sheet opens that sheet first (KiCad selects the hits of the current sheet path)
  const away = rows.find((r) => r.docId);
  if (away) {
    const d = schDocs().find((x) => x.docId === away.docId); if (!d) return true;
    const ids = rows.filter((r) => r.docId === away.docId).flatMap((r) => r.ids);
    void (openDoc(d) as Promise<void>).then(() => { setTimeout(() => { selectAndShow(ids, a.zoom); after(); }, 50); });
    return true;
  }
  selectAndShow(Array.from(new Set(rows.flatMap((r) => r.ids))), a.zoom); after();
  return true;
}
