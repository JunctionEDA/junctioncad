// NetInspector.tsx — the board's Net Inspector pane (pcbnew/widgets/net_inspector_panel.cpp's layout: a "Filter"
// search box, a separator and the "Configure netlist inspector" button over a multi-select data view), with
// PCB_NET_INSPECTOR_PANEL's menus: the configure menu, the header menu (Auto-fit / Show-Hide columns) and the row
// menu.  A double click (or Enter) highlights the selected nets (OnNetsListItemActivated).  The model is
// editor/panels/netinsp.ts behind window.CollabPanels.
import { useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from "react";
import type { NetInspColumn, NetInspModel, NetInspRow } from "../../../domains/pcb/panels-api";
import { useApp } from "../../store";
import { cx } from "../../util";
import { popupMenu, type PopItem } from "../../../domains/pcb/dialogs/dom";
import { KIcon, SortArrow, TreeExpander } from "../Icon";
import { moveColumn, orderColumns } from "./columns";
import { panels, usePanels } from "./widgets";

const EMPTY: NetInspModel = { columns: [], rows: [], settings: { filter_by_net_name: true, filter_by_netclass: true, group_by_netclass: false, group_by_net_chain: false, custom_group_rules: [],
  show_zero_pad_nets: false, show_unconnected_nets: false, show_time_domain_details: false, sorting_column: -1, sort_order_asc: true, col_hidden: {}, expanded_rows: [] }, highlighted: false, highlightNets: [] };
const LAST_STATIC_COL = 10;
const cmd = (c: Parameters<NonNullable<ReturnType<typeof panels>>["netInspectorCmd"]>[0]) => { const p = panels(); if (p) p.netInspectorCmd(c); };

/** generateShowHideColumnMenu: the static columns after Name, a separator, then the layer columns. */
function showHideItems(cols: NetInspColumn[]): PopItem[] {
  const out: PopItem[] = [];
  for (const c of cols) { if (c.id === 0) continue; if (c.id === LAST_STATIC_COL + 1) out.push({ sep: true }); out.push({ label: c.label, check: true, checked: !c.hidden, run: () => cmd({ t: "column", col: c.id }) }); }
  return out;
}

export function NetInspectorPane() {
  const docV = useApp((s) => s.document.version);
  const docId = useApp((s) => s.document.docId);
  const units = useApp((s) => s.viewport.units);
  const shown = useApp((s) => !!s.panes.netinsp);
  const ver = usePanels((s) => s.selVersion);
  const hlVer = usePanels((s) => s.hlVersion || 0);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [widths, setWidthsState] = useState<Record<number, number>>({});
  const [drag, setDrag] = useState<{ col: number; over: number | null } | null>(null);
  const anchor = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const model: NetInspModel = useMemo(() => { const p = panels(); return p && shown ? p.netInspector() : EMPTY; },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docV, docId, units, shown, ver, hlVer, q]);
  const s = model.settings;
  // NET_INSPECTOR_PANEL settings col_widths: restored once per document, saved after each resize
  const savedW = useRef("");
  useEffect(() => {
    const key = docId + ":" + JSON.stringify(s.col_widths || {});
    if (savedW.current === key) return;
    savedW.current = key;
    const w: Record<number, number> = {};
    for (const [k, v] of Object.entries(s.col_widths || {})) if (v > 0) w[+k] = v;
    setWidthsState(w);
  }, [docId, s.col_widths]);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  const setWidths = (f: (w: Record<number, number>) => Record<number, number>, persist = true) => {
    const n = f(widthsRef.current);
    widthsRef.current = n;
    setWidthsState(n);
    if (persist) { savedW.current = docId + ":" + JSON.stringify(n); cmd({ t: "colWidths", widths: n }); }
  };
  // the view's column order (wxDATAVIEW_COL_REORDERABLE, saved as col_order)
  const cols = orderColumns(model.columns, s.col_order).filter((c) => !c.hidden);
  // PCB_NET_INSPECTOR_PANEL::OnBoardHighlightNetChanged: select the highlighted nets' rows and reveal them,
  // or unselect everything when the board highlight goes away.
  const hlKey = model.highlightNets.join("\n");
  useEffect(() => {
    if (!shown) return;
    if (!model.highlightNets.length) { setSel([]); return; }
    const want = new Set(model.highlightNets);
    const keys = model.rows.filter((r) => !r.group && r.nets.some((n) => want.has(n))).map((r) => r.key);
    setSel(keys);
    if (keys.length) requestAnimationFrame(() => {
      const el = bodyRef.current && bodyRef.current.querySelector(`[data-netinsp-row="${CSS.escape(keys[0])}"]`);
      if (el) (el as HTMLElement).scrollIntoView({ block: "nearest" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlKey, hlVer, shown]);
  const selRows = model.rows.filter((r) => sel.includes(r.key));
  const nets = (rows: NetInspRow[]) => Array.from(new Set(rows.flatMap((r) => r.nets)));

  const configMenu = (ev: RMouseEvent) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const one = selRows.length === 1 ? selRows[0] : null;
    popupMenu(r.left, r.bottom, [
      { label: "Filter by Net Name", check: true, checked: s.filter_by_net_name, run: () => cmd({ t: "toggle", key: "filter_by_net_name" }) },
      { label: "Filter by Netclass", check: true, checked: s.filter_by_netclass, run: () => cmd({ t: "toggle", key: "filter_by_netclass" }) },
      { sep: true },
      { label: "Group by Netclass", check: true, checked: s.group_by_netclass, run: () => cmd({ t: "toggle", key: "group_by_netclass" }) },
      { label: "Group by Net Chain", check: true, checked: s.group_by_net_chain, run: () => cmd({ t: "toggle", key: "group_by_net_chain" }) },
      { sep: true },
      { label: "Add Custom Group...", run: () => cmd({ t: "addGroup" }) },
      { label: "Remove Selected Custom Group", disabled: !one || !one.group, run: () => one && cmd({ t: "removeGroup", key: one.key }) },
      { label: "Remove All Custom Groups", disabled: !s.custom_group_rules.length, run: () => cmd({ t: "removeGroups" }) },
      { sep: true },
      { label: "Show Zero Pad Nets", check: true, checked: s.show_zero_pad_nets, run: () => cmd({ t: "toggle", key: "show_zero_pad_nets" }) },
      { label: "Show Unconnected Nets", check: true, checked: s.show_unconnected_nets, run: () => cmd({ t: "toggle", key: "show_unconnected_nets" }) },
      { sep: true },
      { label: "Show Time Domain Details", check: true, checked: s.show_time_domain_details, run: () => cmd({ t: "toggle", key: "show_time_domain_details" }) },
      { sep: true },
      { label: "Save Net Inspector Report...", run: () => cmd({ t: "report" }) },
      { sep: true },
      { label: "Show / Hide Columns", sub: showHideItems(model.columns) },
    ]);
  };
  const headerMenu = (ev: RMouseEvent, col: number) => {
    ev.preventDefault();
    popupMenu(ev.clientX, ev.clientY, [
      { label: "Auto-fit Column", run: () => setWidths((w) => { const n = Object.assign({}, w); delete n[col]; return n; }) },
      { label: "Auto-fit All Columns", run: () => setWidths(() => ({})) },
      { sep: true },
      ...showHideItems(model.columns),
    ]);
  };
  const rowMenu = (ev: RMouseEvent, row: NetInspRow) => {
    ev.preventDefault();
    let cur = selRows;
    if (!sel.includes(row.key)) { setSel([row.key]); cur = [row]; }
    const one = cur.length === 1 ? cur[0] : null, multi = cur.length > 1 || !!(one && one.group);
    popupMenu(ev.clientX, ev.clientY, [
      { label: multi ? "Highlight Selected Nets" : "Highlight Selected Net", disabled: !cur.length, run: () => cmd({ t: "highlight", nets: nets(cur) }) },
      { label: "Clear Net Highlighting", disabled: !model.highlighted, run: () => cmd({ t: "clearHighlight" }) },
      { sep: true },
      { label: "Rename Selected Net...", disabled: !one || multi, run: () => one && cmd({ t: "rename", net: one.nets[0] }) },
      { label: multi ? "Delete Selected Nets" : "Delete Selected Net", disabled: !cur.length, run: () => cmd({ t: "delete", nets: nets(cur), group: one && one.group ? one.cells[0] : undefined }) },
      { sep: true },
      { label: "Add Net...", run: () => cmd({ t: "addNet" }) },
      { sep: true },
      { label: "Remove Selected Custom Group", disabled: !one || !one.group, run: () => one && cmd({ t: "removeGroup", key: one.key }) },
    ]);
  };
  const click = (ev: RMouseEvent, row: NetInspRow) => {
    if (ev.shiftKey && anchor.current) {
      const keys = model.rows.map((r) => r.key), a = keys.indexOf(anchor.current), b = keys.indexOf(row.key);
      if (a >= 0 && b >= 0) { setSel(keys.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
    }
    anchor.current = row.key;
    if (ev.ctrlKey || ev.metaKey) setSel((cur) => (cur.includes(row.key) ? cur.filter((k) => k !== row.key) : [...cur, row.key]));
    else setSel([row.key]);
  };
  const resize = (ev: React.PointerEvent, col: number) => {
    ev.preventDefault(); ev.stopPropagation();
    const th = (ev.currentTarget as HTMLElement).parentElement!, w0 = th.getBoundingClientRect().width, x0 = ev.clientX;
    const move = (m: PointerEvent) => setWidths((w) => Object.assign({}, w, { [col]: Math.max(30, w0 + m.clientX - x0) }), false);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setWidths((w) => w); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  // header drag: a press that moves more than a few pixels drags the column instead of sorting
  const dragged = useRef(false);
  const headerDown = (ev: React.PointerEvent, col: number) => {
    if (ev.button !== 0) return;
    const x0 = ev.clientX, y0 = ev.clientY, row = (ev.currentTarget as HTMLElement).parentElement!;
    dragged.current = false;
    let over: number | null = null;
    const move = (m: PointerEvent) => {
      if (!dragged.current && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return;
      dragged.current = true;
      over = null;
      for (const th of Array.from(row.children) as HTMLElement[]) {
        const r = th.getBoundingClientRect();
        if (m.clientX >= r.left && m.clientX < r.right) over = +(th.dataset.col || 0);
      }
      setDrag({ col, over });
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      setDrag(null);
      if (dragged.current && over !== null && over !== col) cmd({ t: "colOrder", order: moveColumn(orderColumns(model.columns, s.col_order).map((c) => c.id), col, over) });
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const sortCol = s.sorting_column >= 0 ? s.sorting_column : 0;
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm" id="netInspector">
      <div className="flex flex-none items-center gap-1 px-1.5 py-1 bg-bench">
        <input id="netInspectorFilter" type="search" placeholder="Filter" value={q} spellCheck={false}
          onChange={(ev) => { setQ(ev.target.value); const p = panels(); if (p) p.netInspectorFilter(ev.target.value); }}
          onKeyDown={(ev) => { if (ev.key !== "Escape") ev.stopPropagation(); }}
          className="flex-auto min-w-0 bg-panel border border-line rounded-xs py-0.5 px-1.5 text-ink text-sm" />
        <span className="self-stretch w-px bg-line mx-0.5" />
        <button type="button" id="netInspectorConfig" title="Configure netlist inspector" className="flex-none p-0.5 border-0 rounded-xs bg-transparent hover:bg-panel" onClick={configMenu}><KIcon name="config" size={16} /></button>
      </div>
      <div className="flex-auto min-h-0 overflow-auto" tabIndex={0} ref={bodyRef}
        onKeyDown={(ev) => { if (ev.key === "Enter" && selRows.length) { ev.preventDefault(); ev.stopPropagation(); cmd({ t: "highlight", nets: nets(selRows) }); } }}>
        <table className="w-max min-w-full border-collapse text-sm" data-netinsp-table>
          <thead>
            <tr>{cols.map((c) => (
              <th key={c.id} data-col={c.id} style={widths[c.id] ? { width: widths[c.id], minWidth: widths[c.id] } : undefined}
                className={cx("sticky top-0 z-[1] relative px-2 py-0.5 font-semibold whitespace-nowrap bg-bench border-b border-r border-line cursor-default select-none hover:bg-paper", c.center ? "text-center" : "text-left",
                  drag && drag.col === c.id && "opacity-60", drag && drag.over === c.id && drag.col !== c.id && "shadow-[inset_2px_0_0_var(--accent)]")}
                onPointerDown={(ev) => headerDown(ev, c.id)}
                onClick={() => { if (dragged.current) { dragged.current = false; return; } cmd({ t: "sort", col: c.id }); }} onContextMenu={(ev) => headerMenu(ev, c.id)}>
                {c.label}{sortCol === c.id ? <SortArrow asc={!!s.sort_order_asc} /> : null}
                <span className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize" onPointerDown={(ev) => resize(ev, c.id)} onClick={(ev) => ev.stopPropagation()} />
              </th>))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((r) => (
              <tr key={r.key} data-netinsp-row={r.key} className={cx("cursor-default hover:bg-panel cur:bg-sel", sel.includes(r.key) && "cur")}
                onClick={(ev) => click(ev, r)} onDoubleClick={() => cmd({ t: "highlight", nets: nets(selRows.length && sel.includes(r.key) ? selRows : [r]) })} onContextMenu={(ev) => rowMenu(ev, r)}>
                {cols.map((c) => { const i = model.columns.indexOf(c); return (
                  <td key={c.id} className={cx("px-2 py-px whitespace-nowrap border-r border-line-soft overflow-hidden text-ellipsis", c.center ? "text-center" : "text-left", r.zero[i] && "text-ink-3", r.group && c.id === 0 && "font-semibold")}
                    style={c.id === 0 ? { paddingLeft: 4 + r.level * 16 } : undefined}>
                    {c.id === 0 && r.group ? <button type="button" className="inline-block w-3.5 mr-1 p-0 border-0 bg-transparent text-ink-2" data-expand={r.key} onClick={(ev) => { ev.stopPropagation(); cmd({ t: "expand", key: r.key }); }} aria-label={r.expanded ? "Collapse" : "Expand"}><TreeExpander open={!!r.expanded} /></button> : null}
                    {r.cells[i]}
                  </td>); })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
