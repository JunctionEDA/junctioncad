// Search.tsx — KiCad's Search pane (common/widgets/search_pane.cpp): a search box with the settings button
// (SEARCH_PANE_MENU: Zoom to Selection, Pan to Selection, Search Hidden Fields, Search Metadata — kept per editor as
// APP_SETTINGS_BASE::SEARCH_PANE), one tab per handler (Footprints / Zones / Nets / Ratsnest / Text on a board;
// Symbols / Power / Text / Labels on a schematic) and the handler's columns in a SEARCH_PANE_LISTVIEW: proportional,
// resizable columns with the handler's alignment, a click on a header sorts by it (again: the other way), several
// rows can be selected (Shift / Ctrl, Ctrl+A, Up / Down with Shift) and their items are selected on the canvas,
// Ctrl+C or the context menu's Copy puts the selected rows on the clipboard, Enter or a double click opens the
// item's properties.
import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchOpts, SearchResult, SearchRow, SelectionZoom } from "../../../domains/pcb/panels-api";
import { useApp } from "../../store";
import { cx } from "../../util";
import { KIcon, SortArrow } from "../Icon";
import { rowsAsText } from "../../../domains/pcb/editor/panels/search-model";
import { ContextMenu, panels, pdispatch, useContextMenu, usePanels, type MenuItem } from "./widgets";

interface PaneSettings { zoom: SelectionZoom; hidden: boolean; metadata: boolean }
// APP_SETTINGS_BASE: search_pane.selection_zoom PAN, search_hidden_fields true, search_metadata false
const DEFAULTS: PaneSettings = { zoom: "pan", hidden: true, metadata: false };
const settingsKey = (editor: string) => "kui.search." + editor;
function loadSettings(editor: string): PaneSettings {
  try { const v = JSON.parse(localStorage.getItem(settingsKey(editor)) || "null") as Partial<PaneSettings> | null; return Object.assign({}, DEFAULTS, v || {}); } catch (e) { return Object.assign({}, DEFAULTS); }
}
function saveSettings(editor: string, s: PaneSettings): void { try { localStorage.setItem(settingsKey(editor), JSON.stringify(s)); } catch (e) { /* no storage */ } }

function toClipboard(text: string): void { try { if (navigator.clipboard && navigator.clipboard.writeText) void navigator.clipboard.writeText(text).catch(() => {}); } catch (e) { /* no clipboard */ } }

export function SearchPane() {
  const editor = useApp((s) => s.document.editor);
  const docV = useApp((s) => s.document.version);
  const docId = useApp((s) => s.document.docId);
  const units = useApp((s) => s.viewport.units);
  const shown = useApp((s) => !!s.panes.search);
  const hierV = usePanels((s) => s.hierarchy.version);
  const [tab, setTab] = useState("");
  const [q, setQ] = useState("");
  const [settings, setSettings] = useState<PaneSettings>(() => loadSettings(editor || "pcb"));
  useEffect(() => { setSettings(loadSettings(editor || "pcb")); }, [editor]);
  // m_sortCol / m_sortAscending of each tab's list (-1: the handler's own order)
  const [sorts, setSorts] = useState<Record<string, { col: number; asc: boolean }>>({});
  const [sel, setSel] = useState<string[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const [widths, setWidths] = useState<Record<string, number[]>>({});
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const menu = useContextMenu();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tabs = useMemo(() => { const p = panels(); return p && editor ? p.searchTabs() : []; }, [editor, docId]);
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0] ? tabs[0].id : "";
  const sort = sorts[active] || { col: -1, asc: true };
  const result: SearchResult = useMemo(() => {
    const p = panels();
    const opts: SearchOpts = { hidden: settings.hidden, metadata: settings.metadata, sortCol: sort.col, ascending: sort.asc };
    return p && active && shown ? p.search(active, q, opts) : { tab: active, rows: [], total: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, q, docV, docId, units, shown, hierV, settings.hidden, settings.metadata, sort.col, sort.asc]);
  useEffect(() => { if (shown && box.current) box.current.focus(); }, [shown]);
  useEffect(() => { setSel([]); setFocus(null); anchor.current = null; }, [active]);
  const def = tabs.find((t) => t.id === active);
  const rows = result.rows;
  const index = (key: string | null) => (key === null ? -1 : rows.findIndex((r) => r.key === key));

  /** OnUpdateUI → SelectItems: the selected rows' items become the canvas selection. */
  const select = (keys: string[], foc: string | null) => {
    setSel(keys); setFocus(foc);
    const picked = rows.filter((r) => keys.includes(r.key));
    pdispatch({ t: "searchSelect", rows: picked, zoom: settings.zoom });
  };
  const clickRow = (ev: React.MouseEvent, r: SearchRow) => {
    const multi = ev.ctrlKey || ev.metaKey;
    if (ev.shiftKey && anchor.current !== null && index(anchor.current) >= 0) {
      const a = index(anchor.current), b = index(r.key), [lo, hi] = a < b ? [a, b] : [b, a];
      select(rows.slice(lo, hi + 1).map((x) => x.key), r.key);
    } else if (multi) {
      anchor.current = r.key;
      select(sel.includes(r.key) ? sel.filter((k) => k !== r.key) : sel.concat(r.key), r.key);
    } else { anchor.current = r.key; select([r.key], r.key); }
  };
  const activate = (r: SearchRow) => pdispatch({ t: "searchActivate", row: r, zoom: settings.zoom });
  const copySel = () => toClipboard(rowsAsText(rows.filter((r) => sel.includes(r.key))));
  const onListKey = (ev: React.KeyboardEvent) => {
    const mod = ev.ctrlKey || ev.metaKey, k = ev.key;
    if (mod && !ev.altKey && k.toLowerCase() === "a") { ev.preventDefault(); ev.stopPropagation(); select(rows.map((r) => r.key), focus); return; }
    if (mod && !ev.altKey && k.toLowerCase() === "c") { ev.preventDefault(); ev.stopPropagation(); copySel(); return; }
    if (k === "ArrowDown" || k === "ArrowUp") {
      ev.preventDefault(); ev.stopPropagation(); if (!rows.length) return;
      let f = index(focus); if (f < 0) f = 0;
      const n = k === "ArrowDown" ? Math.min(rows.length - 1, f + 1) : Math.max(0, f - 1);
      if (n === f && sel.length) return;
      const key = rows[n].key;
      if (ev.shiftKey) select(sel.includes(key) ? sel : sel.concat(key), key); else { anchor.current = key; select([key], key); }
      const el = list.current && list.current.querySelector<HTMLElement>(`[data-search-row="${CSS.escape(key)}"]`); if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
      return;
    }
    if (k === "Enter") { ev.preventDefault(); ev.stopPropagation(); const r = rows[index(focus)]; if (r) activate(r); return; }
    if (k !== "Escape") ev.stopPropagation();
  };
  const clickHeader = (i: number) => {
    // OnColClicked: the same column flips the order, another one sorts ascending by it; the selection is kept
    const n = sort.col === i ? { col: i, asc: !sort.asc } : { col: i, asc: true };
    setSorts(Object.assign({}, sorts, { [active]: n }));
  };
  // RefreshColumnNames: each column is its proportion × a tenth of the list's width; a drag on a divider resizes it
  const [listW, setListW] = useState(300);
  useEffect(() => {
    const el = list.current; if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setListW(el.clientWidth || 300)); ro.observe(el); setListW(el.clientWidth || 300);
    return () => ro.disconnect();
  }, [shown]);
  const colW = def ? (widths[active] || def.props.map((p) => Math.max(24, Math.floor(listW / 10) * p))) : [];
  const dragCol = (ev: React.PointerEvent<HTMLElement>, i: number) => {
    ev.preventDefault(); ev.stopPropagation();
    const el = ev.currentTarget, x0 = ev.clientX, start = colW.slice(); el.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => { const w = start.slice(); w[i] = Math.max(16, start[i] + e.clientX - x0); setWidths((m) => Object.assign({}, m, { [active]: w })); };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
  };
  const setting = (s: Partial<PaneSettings>) => { const n = Object.assign({}, settings, s); setSettings(n); saveSettings(editor || "pcb", n); };
  const gearMenu = (): MenuItem[] => [
    { label: "Zoom to Selection", title: "Toggle zooming to selections in the search pane", icon: "zoom_fit_to_objects", check: settings.zoom === "zoom", run: () => setting({ zoom: settings.zoom === "zoom" ? "none" : "zoom" }) },
    { label: "Pan to Selection", title: "Toggle panning to selections in the search pane", icon: "zoom_center_on_screen", check: settings.zoom === "pan", run: () => setting({ zoom: settings.zoom === "pan" ? "none" : "pan" }) },
    "-",
    // BITMAPS::invisible_text: KiCad registers no artwork for it (common/bitmap_info.cpp, resources/bitmaps_png), so
    // its menu shows the image-not-found placeholder; the icon pack has nothing to draw
    { label: "Search Hidden Fields", check: settings.hidden, run: () => setting({ hidden: !settings.hidden }) },
    { label: "Search Metadata", title: "Search library links, descriptions and keywords", icon: "library", check: settings.metadata, run: () => setting({ metadata: !settings.metadata }) },
  ];
  const openGear = () => { const b = gear.current; if (!b) return; const r = b.getBoundingClientRect(); menu.open({ clientX: r.left, clientY: r.bottom, preventDefault() { /* a click */ } }, gearMenu()); };
  const align = (i: number) => (def ? def.align[i] : "left");
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm" id="search">
      <div className="flex flex-none items-center gap-1 px-1.5 py-1 bg-bench">
        <input ref={box} id="searchBox" type="search" placeholder="Search" value={q} spellCheck={false} onChange={(ev) => setQ(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === "ArrowDown" && list.current) { ev.preventDefault(); list.current.focus(); return; } if (ev.key !== "Escape") ev.stopPropagation(); }}
          className="flex-auto min-w-0 bg-panel border border-line rounded-xs py-0.5 px-1.5 text-ink text-sm" />
        {/* m_menuButton: BITMAPS::config, pops SEARCH_PANE_MENU */}
        <button ref={gear} type="button" className="tbtn flex-none flex items-center justify-center w-6 h-6 p-0 bg-transparent border border-transparent rounded-xs hover:bg-panel hover:border-line" title="Search settings"
          data-search-menu onPointerDown={(ev) => { ev.preventDefault(); openGear(); }}><KIcon name="config" size={16} /></button>
      </div>
      <div className="ktabs flex flex-none border-b border-line bg-bench">
        {tabs.map((t) => <button type="button" key={t.id} data-stab={t.id} className={cx("bg-transparent border-0 border-b-2 border-b-transparent py-1 px-3 text-sm text-ink-2 on:text-ink on:border-b-blue on:bg-paper", t.id === active && "on")} onClick={() => setTab(t.id)}>{t.label}</button>)}
        <span className="ml-auto self-center pr-2 text-ink-3 text-xs" data-search-count>{result.total > rows.length ? `${rows.length} of ${result.total}` : `${result.total}`}</span>
      </div>
      <div ref={list} className="flex-auto min-h-0 overflow-auto outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-blue)]" tabIndex={0} data-search-list onKeyDown={onListKey}
        onContextMenu={(ev) => menu.open(ev, [{ label: "Copy", run: copySel }])}>{/* SEARCH_PANE_LISTVIEW::OnContextMenu: a plain wxID_COPY, always enabled */}
        <table className="border-collapse text-sm table-fixed select-none" style={{ width: colW.reduce((a, b) => a + b, 0) || undefined }} data-search-table={active}>
          <colgroup>{colW.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
          <thead>
            <tr>{def ? def.columns.map((c, i) => (
              <th key={c} data-search-col={i} aria-sort={sort.col === i ? (sort.asc ? "ascending" : "descending") : undefined}
                className="sticky top-0 z-[1] relative px-2 py-0.5 font-semibold whitespace-nowrap overflow-hidden text-ellipsis bg-bench border-b border-r border-line cursor-default select-none hover:bg-panel"
                style={{ textAlign: align(i) }} onClick={() => clickHeader(i)}>
                {c}{sort.col === i ? <SortArrow asc={sort.asc} /> : null}
                <span className="absolute right-0 top-0 bottom-0 w-[5px] cursor-col-resize" data-col-split={i} onPointerDown={(ev) => dragCol(ev, i)} onClick={(ev) => ev.stopPropagation()} />
              </th>)) : null}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-search-row={r.key} aria-selected={sel.includes(r.key)}
                className={cx("cursor-default", sel.includes(r.key) ? "cur bg-sel" : "hover:bg-panel", focus === r.key && "outline outline-1 -outline-offset-1 outline-blue/50")}
                onMouseDown={(ev) => { if (ev.button === 2 && sel.includes(r.key)) return; if (ev.button === 0 || ev.button === 2) clickRow(ev, r); }}
                onDoubleClick={() => activate(r)}>
                {r.cells.map((c, i) => <td key={i} className="px-2 py-px whitespace-nowrap border-r border-line-soft overflow-hidden text-ellipsis" style={{ textAlign: align(i) }} title={c}>{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ContextMenu at={menu.at} onClose={menu.close} />
    </div>
  );
}
