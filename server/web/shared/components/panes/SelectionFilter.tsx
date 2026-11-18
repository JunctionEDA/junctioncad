// SelectionFilter.tsx — panel_pcbnew_selection_filter_base / panel_sch_selection_filter_base: which item
// kinds the select tool picks.  The same two-column grid as KiCad, "All items" and "Locked items" on the
// first row; a right-click on a kind offers "Only <kind>".  The grid takes three columns when the dock is wide
// enough (two otherwise), and the pane folds to its caption (Dock.tsx), which then says what it lets through.
import { FILTERS } from "../../../domains/pcb/tables";
import { dispatch, useApp } from "../../store";
import { ContextMenu, useContextMenu } from "./widgets";

// `kcb` / `kbody` / `kfilter` / `kfgrid` stay as plain hooks; the utilities carry the styling.
const CB = "kcb flex items-center gap-1.5 py-px whitespace-nowrap min-w-0 overflow-hidden text-ellipsis";
const CB_INPUT = "m-0 accent-blue";

export function SelectionFilterPane() {
  const editor = useApp((s) => s.document.editor);
  const filter = useApp((s) => s.filter);
  const menu = useContextMenu();
  const list = editor ? FILTERS[editor] : [];
  const all = list.every(([k]) => filter[k] !== false);
  return (
    <div className="kbody kfilter overflow-auto min-h-0 flex-auto bg-paper px-2 py-1.5 text-sm">
      <div className="kfgrid d-grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-x-2 gap-y-0.5">
        <label className={`${CB} all`} title="All items"><input type="checkbox" className={CB_INPUT} data-f="all" checked={all} onChange={(ev) => dispatch({ type: "setFilter", key: "all", on: ev.target.checked })} /> All</label>
        <label className={`${CB} locked`} title="Allow selection of locked items"><input type="checkbox" className={CB_INPUT} data-f="lockedItems" checked={filter.lockedItems !== false} onChange={(ev) => dispatch({ type: "setFilter", key: "lockedItems", on: ev.target.checked })} /> Locked</label>
        {list.map(([k, l]) => (
          <label className={CB} key={k} onContextMenu={(ev) => menu.open(ev, [{ label: `Only ${l.toLowerCase()}`, run: () => dispatch({ type: "setFilter", key: "only:" + k, on: true }) }])}>
            <input type="checkbox" className={CB_INPUT} data-f={k} checked={filter[k] !== false} onChange={(ev) => dispatch({ type: "setFilter", key: k, on: ev.target.checked })} /> {l}
          </label>
        ))}
      </div>
      <ContextMenu at={menu.at} onClose={menu.close} />
    </div>
  );
}

/** The folded Selection Filter's caption: "All items", "Nothing", or how many kinds it lets through. */
export function FilterSummary() {
  const editor = useApp((s) => s.document.editor);
  const filter = useApp((s) => s.filter);
  const list = editor ? FILTERS[editor] : [];
  const on = list.filter(([k]) => filter[k] !== false).length;
  const locked = filter.lockedItems === false ? ", not locked" : "";
  return <span data-filter-summary="">{on === list.length ? "All items" + locked : on === 0 ? "Nothing" : `${on} of ${list.length} kinds${locked}`}</span>;
}
