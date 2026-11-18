// NetNavigator.tsx — the schematic Net Navigator (eeschema/net_navigator.cpp, SCH_EDIT_FRAME::createNetNavigatorPanel):
// a "Filter nets" search box with the gear menu (Wildcard Search / Regex Search) above the tree.  With nothing
// highlighted the tree is "Nets" > every net > its sheets > its items; with a net highlighted the root is that net
// and the filter is disabled.  A click on an item changes to its sheet and centres on it; a sheet node changes
// sheet; a net name does nothing.  The model is web/domains/pcb/editor/panels/netnav.ts.
import { useEffect, useState } from "react";
import type { NetNavNode } from "../../../domains/pcb/panels-api";
import { cx } from "../../util";
import { KIcon } from "../Icon";
import { ContextMenu, Twist, pdispatch, usePanels, type MenuAt, type MenuItem } from "./widgets";

/** The net a tree node belongs to: a net node ("net:NAME"), or the net above a sheet / item node; "" for the "Nets" root. */
export function navNetOf(key: string): string {
  if (key.startsWith("net:")) return key.slice(4);
  const m = /^(?:sheet|item):(.*?)\|/.exec(key); return m ? m[1] : "";
}

export function NetNavigatorPane() {
  const nav = usePanels((s) => s.netNav);
  const root = nav.root;
  // a node's fold state differs from its default (wxTreeCtrl: collapsed until expanded) when its key is in here
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<MenuAt | null>(null);
  useEffect(() => { pdispatch({ t: "netNavRefresh" }); }, []);   // wxEVT_SHOW: a stale navigator rebuilds when shown
  // the selected node is shown: its ancestors open (EnsureVisible)
  useEffect(() => {
    if (!nav.selected || !root) return;
    const path: NetNavNode[] = [];
    const walk = (n: NetNavNode): boolean => { if (n.key === nav.selected) return true; for (const c of n.children || []) if (walk(c)) { path.push(n); return true; } return false; };
    if (!walk(root)) return;
    const next = new Set(flipped); let changed = false;
    for (const n of path) { const open = n.collapsed ? next.has(n.key) : !next.has(n.key); if (!open) { if (next.has(n.key)) next.delete(n.key); else next.add(n.key); changed = true; } }
    if (changed) setFlipped(next);
    const el = document.querySelector(`#netnav [data-nav="${CSS.escape(nav.selected)}"]`); if (el && "scrollIntoView" in el) (el as HTMLElement).scrollIntoView({ block: "nearest" });
  }, [nav.selected, nav.version]);   // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (k: string) => { const n = new Set(flipped); if (n.has(k)) n.delete(k); else n.add(k); setFlipped(n); };
  const isOpen = (n: NetNavNode) => (n.collapsed ? flipped.has(n.key) : !flipped.has(n.key));
  /** ExpandAll / CollapseAll (then the root expanded again): every node's fold state from its default. */
  const foldAll = (open: boolean) => {
    const next = new Set<string>();
    const walk = (n: NetNavNode, depth: number) => { if ((n.children || []).length) { const want = open || depth === 0; if (!!n.collapsed === want) next.add(n.key); } for (const c of n.children || []) walk(c, depth + 1); };
    if (root) walk(root, 0); setFlipped(next);
  };
  /** SCH_EDIT_FRAME::showNetNavigatorMenu: on a row or the empty space; Find in Net Inspector needs a net. */
  const navMenu = (ev: React.MouseEvent, key: string | null) => {
    ev.preventDefault(); ev.stopPropagation();
    const net = key ? navNetOf(key) : root && root.key.startsWith("net:") ? navNetOf(root.key) : "";
    const items: MenuItem[] = [
      { label: "Expand All", run: () => foldAll(true) }, { label: "Collapse All", run: () => foldAll(false) },
      { label: "Find in Net Inspector", disabled: !net, run: () => pdispatch({ t: "netNavFind", net }) },
    ];
    setMenu({ x: ev.clientX, y: ev.clientY, items });
  };
  /** onNetNavigatorKey: Esc clears the filter and refreshes. */
  const escClears = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); pdispatch({ t: "netNavFilter", text: "" }); return; }
    if (ev.currentTarget.tagName === "INPUT") ev.stopPropagation();
  };
  const row = (n: NetNavNode, depth: number): JSX.Element => {
    const kids = n.children || [], open = isOpen(n);
    return (
      <div key={n.key}>
        <div className={cx("node flex items-center h-[20px] pr-1.5 cursor-default whitespace-nowrap hover:bg-panel cur:bg-sel", n.bold && "font-semibold", nav.selected === n.key && "cur")} style={{ paddingLeft: 4 + depth * 14 }} data-nav={n.key}
          onClick={() => { if (depth > 0) pdispatch({ t: "netNavSelect", ids: n.ids || [], key: n.key }); }}
          onDoubleClick={() => { if (kids.length) toggle(n.key); }} onContextMenu={(ev) => navMenu(ev, n.key)}>
          <Twist open={open} leaf={!kids.length} onToggle={() => toggle(n.key)} />
          <span>{n.label}</span>
        </div>
        {open ? kids.map((c) => row(c, depth + 1)) : null}
      </div>
    );
  };
  const wildcard = nav.wildcard !== false;
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm">
      <div className="flex-none flex items-center gap-0.5 p-0.5">
        <input id="netNavFilter" type="search" placeholder="Filter nets" value={nav.filter || ""} disabled={nav.filterEnabled === false} spellCheck={false}
          onChange={(ev) => pdispatch({ t: "netNavFilter", text: ev.target.value })} onKeyDown={escClears}
          className="flex-1 min-w-0 bg-panel border border-line rounded-xs py-0.5 px-1.5 text-ink text-sm disabled:opacity-50" />
        {/* m_netNavigatorMenuButton: BITMAPS::config, AppendRadioItem Wildcard Search / Regex Search */}
        <button type="button" id="netNavGear" title="Search mode" className="flex-none w-[22px] h-[22px] grid place-items-center text-ink-2 hover:bg-panel rounded-xs"
          onClick={(ev) => { const r = (ev.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom, items: [
            { label: "Wildcard Search", radio: true, check: wildcard, run: () => pdispatch({ t: "netNavFilter", wildcard: true }) },
            { label: "Regex Search", radio: true, check: !wildcard, run: () => pdispatch({ t: "netNavFilter", wildcard: false }) }] }); }}>
          <KIcon name="config" size={16} />
        </button>
      </div>
      <div className="ktree overflow-auto min-h-0 flex-auto py-1 outline-none" id="netnav" tabIndex={-1} onKeyDown={escClears} onContextMenu={(ev) => navMenu(ev, null)}>
        {root ? row(root, 0) : null}
      </div>
      <ContextMenu at={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
