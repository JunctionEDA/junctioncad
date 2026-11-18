// Hierarchy.tsx — the schematic Hierarchy navigator (eeschema/widgets/hierarchy_pane.cpp): the tree of
// sheets, each "name (page N)", the sheet on screen highlighted.  A click opens the sheet; the right-click
// menu is KiCad's: Edit Page Number, Rename, Delete Top-Level Sheet, New Top-Level Sheet, Expand All, Collapse All.
import { useState } from "react";
import type { HierNode } from "../../../domains/pcb/panels-api";
import { useApp } from "../../store";
import { cx } from "../../util";
import { KIcon } from "../Icon";
import { ContextMenu, Twist, pdispatch, useContextMenu, usePanels, type MenuItem } from "./widgets";

// The pane body (the `.kbody` contract): scrolls, sheet-coloured, 12px type.
const BODY = "kbody ktree overflow-auto min-h-0 flex-auto py-1 bg-paper text-sm";
const NODE = "node flex items-center h-[20px] pr-1.5 cursor-default whitespace-nowrap hover:bg-panel cur:bg-sel cur:font-semibold";

// LAYER_BRIGHTENED of the default schematic theme (builtin_color_themes.h CSS_COLOR( 255, 0, 255, 1 )), until the
// editor publishes the current theme's
const BRIGHTENED = "#FF00FF";

function allPaths(n: HierNode, out: string[] = []): string[] { if (n.children.length) out.push(n.path); for (const c of n.children) allPaths(c, out); return out; }

export function HierarchyPane() {
  const root = usePanels((s) => s.hierarchy.root);
  const marked = usePanels((s) => s.hierarchy.marked);
  const markColor = usePanels((s) => s.hierarchy.markColor) || BRIGHTENED;
  const viewOnly = useApp((s) => s.viewOnly);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const menu = useContextMenu();
  const toggle = (p: string) => { const n = new Set(closed); if (n.has(p)) n.delete(p); else n.add(p); setClosed(n); };
  // HIERARCHY_PANE::onContextMenu: a sheet's own entries (Delete Top-Level Sheet on a top-level one), then New
  // Top-Level Sheet, then Expand / Collapse All; a click beside the rows has only the last three.
  const common: MenuItem[] = [
    { label: "New Top-Level Sheet", run: () => pdispatch({ t: "hierNewTop" }), disabled: viewOnly, title: "Create a new top-level sheet" },
    "-",
    { label: "Expand All", run: () => setClosed(new Set()) },
    { label: "Collapse All", run: () => setClosed(new Set(root ? allPaths(root) : [])) },
  ];
  const items = (n: HierNode): MenuItem[] => [
    { label: "Edit Page Number", run: () => pdispatch({ t: "hierPage", path: n.path }), disabled: viewOnly || !n.docId },
    // the project root is hidden (wxTR_HIDE_ROOT), so a top-level sheet is never isProjectRoot: Rename is offered
    { label: "Rename", run: () => pdispatch({ t: "hierRename", path: n.path }), disabled: viewOnly, title: "Change name of this sheet" },
    ...(n.parentDocId ? [] : [{ label: "Delete Top-Level Sheet", run: () => pdispatch({ t: "hierDeleteTop", path: n.path }), disabled: viewOnly, title: "Remove this top-level sheet from the project" } satisfies MenuItem]),
    "-",
    ...common,
  ];
  const row = (n: HierNode, depth: number): JSX.Element => {
    const open = !closed.has(n.path);
    return (
      <div key={n.path}>
        {/* a sheet holding the highlighted net: LAYER_BRIGHTENED text (the schematic theme's "brightened") */}
        <div className={cx(NODE, n.current && "cur", !n.docId && "text-ink-3")} style={{ paddingLeft: 4 + depth * 14, color: marked && marked.includes(n.path) ? markColor : undefined }}
          data-doc={n.docId || undefined} data-path={n.path} data-net-mark={marked && marked.includes(n.path) ? "" : undefined} title={n.file}
          onClick={() => pdispatch({ t: "hierOpen", path: n.path })} onContextMenu={(ev) => { ev.stopPropagation(); menu.open(ev, items(n)); }}>
          <Twist open={open} leaf={!n.children.length} onToggle={() => toggle(n.path)} />
          {/* HIERARCHY_PANE's image list: tree_sel on the sheet being edited, tree_nosel on the others */}
          <span className="flex-none mr-1 inline-flex" data-icon={n.current ? "tree_sel" : "tree_nosel"}><KIcon name={n.current ? "tree_sel" : "tree_nosel"} size={16} /></span>
          <span>{n.name}{n.page ? ` (page ${n.page})` : ""}</span>
        </div>
        {open ? n.children.map((c) => row(c, depth + 1)) : null}
      </div>
    );
  };
  return (
    <div className={BODY} id="hier" onContextMenu={(ev) => menu.open(ev, common)}>
      {/* several top-level sheets hang under the hidden project root (wxTR_HIDE_ROOT), each a row of its own */}
      {root ? (root.virtual ? root.children.map((c) => row(c, 0)) : row(root, 0)) : <p className="note px-2">No schematic sheets in this project.</p>}
      <ContextMenu at={menu.at} onClose={menu.close} />
    </div>
  );
}
