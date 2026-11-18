// Appearance.tsx — the board's Appearance manager (pcbnew/widgets/appearance_controls.cpp): the
// Layers / Objects / Nets tabs, their display-option sections, and the Presets and Viewports
// choices under them.  The model lives in the editor bundle (web/domains/pcb/editor/panels/appearance.ts) and
// every control here goes through CollabPanels.dispatch.  The schematic has no such pane in KiCad;
// its minimal version lists the layers and the items.  `#layers` keeps its id: pcb-tools.js
// watches it to know when a document's layer list was rebuilt.
import { Select } from "../Select";
import { useState } from "react";
import type { LayerInfo, LayerMenuCmd, NetClassRow, NetCmd, NetRow } from "../../../domains/pcb/panels-api";
import { dispatch, useApp, type ItemSummary } from "../../store";
import { cx } from "../../util";
import { KIcon } from "../Icon";
import { Collapsible, ContextMenu, Swatch, pdispatch, pickColor, useContextMenu, usePanels, type MenuItem } from "./widgets";
import { IS_MAC, keyName } from "../../keys";
import { menuMeta } from "../../../domains/pcb/menuspec";
import { unescapeString } from "../../../domains/pcb/dialogs/sch-items-logic";

// A list row (`.layer`): flex, centred, 8px gap, 3px/4px padding, 2px radius; callers add the hover fill.
const ROW = "layer flex items-center gap-2 py-[3px] px-1 rounded-xs";
// The right-aligned mono count (`.layer .cnt`); `font: 11px var(--mono)` also reset weight and leading.
const CNT = "cnt ml-auto text-ink-3 text-xs font-mono font-normal leading-[normal]";

function fpName(fp: ItemSummary, sch: boolean): string {
  return sch ? (fp.ref ? `${fp.ref}  ${fp.value || ""}`.trim() : (fp.lib || "?").split(":").pop()!) : (fp.lib || "?").split(":").pop()!;
}

function SchLayers() {
  const layers = useApp((s) => s.document.layers);
  const hidden = useApp((s) => s.document.hiddenLayers);
  const notice = useApp((s) => s.document.notice);
  if (notice) return <p className="note">{notice}</p>;
  if (!layers.length) return <p className="note">Nothing to show yet.</p>;
  return (
    <>
      {layers.map((l) => (
        <label className={cx(ROW, "hover:bg-panel")} key={l.key}>
          <input type="checkbox" className="m-0 accent-blue" data-lkey={l.key} checked={!hidden.includes(l.key)} onChange={(ev) => dispatch({ type: "setLayerVisible", key: l.key, visible: ev.target.checked })} />
          <span className="sw w-3.5 h-3.5 rounded-xs border border-black/40 flex-none" style={{ background: l.color }} /><span>{l.name}</span><span className={CNT}>{l.count}</span>
        </label>
      ))}
    </>
  );
}

function SchObjects() {
  const items = useApp((s) => s.document.items);
  const sheets = useApp((s) => s.document.sheets);
  const sch = useApp((s) => s.document.editor === "sch");
  const primary = useApp((s) => s.selection.primary);
  const [q, setQ] = useState("");
  const ql = q.toLowerCase();
  const list = items.filter((fp) => !ql || fpName(fp, sch).toLowerCase().includes(ql)).sort((a, b) => fpName(a, sch).localeCompare(fpName(b, sch)));
  return (
    <>
      <input id="objSearch" placeholder={sch ? "Filter symbols…" : "Filter footprints…"} value={q} onChange={(ev) => setQ(ev.target.value)}
        className="w-full mb-1.5 bg-canvas border border-line rounded-md py-1 px-1.5 text-ink" />
      <div id="objList">
        {sch && sheets.length ? (
          <>
            <div className={cx(ROW, "hover:bg-panel")}><span className="muted">Sheets</span><span className={CNT}>{sheets.length}</span></div>
            {sheets.map((sh) => (
              <div className={cx(ROW, "hover:bg-panel cursor-pointer pl-3.5")} key={sh.id} data-sheet={sh.file} onClick={() => dispatch({ type: "enterSheet", file: sh.file })}>
                <span>{sh.name || sh.file}</span><span className={CNT} title="Enter Sheet"><KIcon name="enter_sheet" size={16} /></span>
              </div>
            ))}
          </>
        ) : null}
        <div className={cx(ROW, "hover:bg-panel")}><span className="muted">{sch ? "Symbols" : "Footprints"}</span><span className={CNT}>{list.length}/{items.length}</span></div>
        {list.slice(0, 300).map((fp) => (
          // the selected row's fill used to be an inline style, which also beat the hover fill: keep both states
          <div className={cx(ROW, "cursor-pointer pl-3.5", primary && primary.id === fp.id ? "bg-panel-2 hover:bg-panel-2" : "hover:bg-panel")} key={fp.id} data-fp={fp.id}
            onClick={() => dispatch({ type: "selectItem", id: fp.id })}>
            <span>{fpName(fp, sch)}</span><span className={CNT}>{Math.round(fp.rot || 0)}°</span>
          </div>
        ))}
      </div>
    </>
  );
}


// ================================================================ board
/** The eye of a row (KiCad's BITMAP_TOGGLE with visibility / visibility_off). */
function Eye({ on, onChange, title, k }: { on: boolean; onChange: (on: boolean) => void; title?: string; k?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} data-eye={k} title={title} className={cx("eye flex-none w-4 h-4 p-0 border-0 bg-transparent cursor-pointer [&_svg]:w-4 [&_svg]:h-4", !on && "opacity-60")}
      onClick={(ev) => { ev.stopPropagation(); onChange(!on); }}>
      <KIcon name={on ? "visibility" : "visibility_off"} size={16} />
    </button>
  );
}
const ROW2 = "flex items-center gap-1.5 h-[20px] px-1 whitespace-nowrap";
const RADIO = "flex items-center gap-1 mr-2.5";

// APPEARANCE_CONTROLS::rebuildLayerContextMenu: each entry with its KiCad bitmap
const LAYER_MENU: ([LayerMenuCmd, string, string] | "-")[] = [
  ["showAllCu", "Show All Copper Layers", "show_all_copper_layers"], ["hideAllCu", "Hide All Copper Layers", "show_no_copper_layers"], "-",
  ["hideAllButActive", "Hide All Layers But Active", "select_w_layer"], "-",
  ["showAllNonCu", "Show All Non Copper Layers", "show_no_copper_layers"], ["hideAllNonCu", "Hide All Non Copper Layers", "show_all_copper_layers"], "-",
  ["showAll", "Show All Layers", "show_all_layers"], ["hideAll", "Hide All Layers", "show_no_layers"], "-",
  ["frontAssembly", "Show Only Front Assembly Layers", "show_front_assembly_layers"], ["front", "Show Only Front Layers", "show_all_front_layers"],
  ["inner", "Show Only Inner Layers", "show_all_copper_layers"], ["back", "Show Only Back Layers", "show_all_back_layers"], ["backAssembly", "Show Only Back Assembly Layers", "show_back_assembly_layers"],
];
/** "Inactive layers (%s):" — the label carries the action's hotkey when it has one (KeyNameFromKeyCode). */
function hotkeyLabel(text: string, action: string): string {
  const meta = menuMeta("pcb", action), k = meta && meta.key;
  return k ? `${text} (${keyName(k)}):` : `${text}:`;
}
const SWATCH_TIP = "Double click or middle click for color change, right click for menu";

function LayersTab() {
  const layers = usePanels((s) => s.appearance.layers);
  const active = usePanels((s) => s.appearance.active);
  const inactive = usePanels((s) => s.appearance.inactive);
  const flip = usePanels((s) => s.appearance.flip);
  const notice = useApp((s) => s.document.notice);
  const menu = useContextMenu();
  const hasInner = layers.some((l) => l.copper && l.key !== "F.Cu" && l.key !== "B.Cu");
  const items: MenuItem[] = LAYER_MENU.filter((m) => m === "-" || m[0] !== "inner" || hasInner).map((m) => m === "-" ? "-" : { label: m[1], icon: m[2], run: () => pdispatch({ t: "layerMenu", cmd: m[0] }) });
  const swatch = (l: LayerInfo) => pickColor({ title: `${l.name} color`, color: l.color, def: l.defaultColor, set: (c) => pdispatch({ t: "layerColor", key: l.key, color: c }) });
  return (
    <>
      <div id="layers" className="flex-auto min-h-0 overflow-auto bg-paper py-0.5" onContextMenu={(ev) => menu.open(ev, items)}>
        {notice ? <p className="note px-2">{notice}</p> : !layers.length ? <p className="note px-2">Nothing to show yet.</p> : layers.map((l) => (
          <div key={l.key} className={cx("layer", ROW2, "cursor-default hover:bg-panel cur:bg-sel", l.key === active && "cur")} data-layer={l.key} title={l.tip}
            onClick={() => pdispatch({ t: "layerActive", key: l.key })}>
            <span className="arrow inline-block w-2.5 flex-none leading-none">{l.key === active ? <span className="kind-on" aria-hidden="true" /> : null}</span>
            <Swatch color={l.color} title={SWATCH_TIP} onPick={() => swatch(l)} />
            <Eye on={l.visible} k={l.key} title="Show or hide this layer" onChange={(on) => pdispatch({ t: "layerVisible", key: l.key, on })} />
            <span className="lname">{l.name}</span>
          </div>
        ))}
      </div>
      <Collapsible title="Layer Display Options" id="layerOpts">
        <div className="mb-1" data-label="inactive">{hotkeyLabel("Inactive layers", "highContrastModeCycle")}</div>
        <div className="flex mb-1.5">
          {([["normal", "Normal", "Inactive layers will be shown in full color"], ["dim", "Dim", "Inactive layers will be dimmed"], ["hide", "Hide", "Inactive layers will be hidden"]] as const).map(([m, label, tip]) => (
            <label className={RADIO} key={m} title={tip}><input type="radio" className="m-0 accent-blue" name="kInactive" data-inactive={m} checked={inactive === m} onChange={() => pdispatch({ t: "inactive", mode: m })} />{label}</label>
          ))}
        </div>
        <label className="flex items-center gap-1.5"><input type="checkbox" className="m-0 accent-blue" data-flip checked={flip} onChange={(ev) => pdispatch({ t: "flip", on: ev.target.checked })} />Flip board view</label>
      </Collapsible>
      <ContextMenu at={menu.at} onClose={menu.close} />
    </>
  );
}

function ObjectsTab() {
  const objects = usePanels((s) => s.appearance.objects);
  return (
    <div id="objects" className="flex-auto min-h-0 overflow-auto bg-paper py-0.5">
      {objects.map((o, i) => o.spacer ? <div key={"sp" + i} className="h-2.5" /> : (
        <div key={o.id} className={cx(ROW2, "hover:bg-panel")} data-object={o.id}>
          {/* rebuildObjects: a COLOR_SWATCH where the theme has a colour for the layer, else a spacer of its width */}
          {o.color ? <span data-object-swatch={o.id} className="flex"><Swatch color={o.color} small title={SWATCH_TIP}
            onPick={() => pickColor({ title: `${o.label} color`, color: o.color!, def: o.defaultColor || null, set: (c) => pdispatch({ t: "objColor", id: o.id, color: c }) })} /></span>
            : <span className="w-3 flex-none" />}
          {o.canHide ? <Eye on={!!o.visible} k={o.id} title={`Show or hide ${o.label.toLowerCase()}`} onChange={(on) => pdispatch({ t: "objVisible", id: o.id, on })} /> : <span className="w-4 flex-none" />}
          <span className="flex-auto min-w-0 overflow-hidden text-ellipsis" title={o.tip}>{o.label}</span>
          {o.opacity !== undefined ? (
            <input type="range" min={0} max={100} step={1} value={Math.round(o.opacity * 100)} data-opacity={o.id} title={`Set opacity of ${o.label.toLowerCase()}`}
              className="kslider flex-none w-[84px]" onChange={(ev) => pdispatch({ t: "objOpacity", id: o.id, value: +ev.target.value / 100 })} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function netMenu(n: NetRow, pick: () => void): MenuItem[] {
  const cmd = (c: NetCmd) => () => pdispatch({ t: "netCmd", cmd: c, name: n.name });
  const shown = unescapeString(n.name);   // NET_GRID_TABLE::Rebuild: UnescapeString( net->GetNetname() )
  return [
    { label: "Set Net Color", run: pick }, { label: "Clear Net Color", run: () => pdispatch({ t: "netColor", name: n.name, color: null }), disabled: !n.color }, "-",
    { label: `Highlight ${shown}`, run: cmd("highlight") }, { label: `Select Tracks and Vias in ${shown}`, run: cmd("select") }, { label: `Unselect Tracks and Vias in ${shown}`, run: cmd("unselect") }, "-",
    { label: "Show All Nets", run: cmd("showAll") }, { label: "Hide All Other Nets", run: cmd("hideOthers") },
  ];
}
/** buildNetClassMenu: the Default class has no colour of its own, so no colour entries (isDefaultClass). */
function classMenu(c: NetClassRow, pick: () => void): MenuItem[] {
  const cmd = (k: NetCmd) => () => pdispatch({ t: "classCmd", cmd: k, name: c.name });
  const colors: MenuItem[] = c.name === "Default" ? [] : [
    { label: "Set Netclass Color", run: pick },
    // ID_USE_SCHEMATIC_NET_COLOR: the class's schematic colour as its board colour; disabled while it has none
    { label: "Use Color from Schematic", run: () => pdispatch({ t: "classColor", name: c.name, color: c.schColor || null }), disabled: !c.schColor },
    { label: "Clear Netclass Color", run: () => pdispatch({ t: "classColor", name: c.name, color: null }), disabled: !c.color }, "-"];
  return [
    ...colors,
    { label: `Highlight Nets in ${c.name}`, run: cmd("highlight") }, { label: `Select Tracks and Vias in ${c.name}`, run: cmd("select") }, { label: `Unselect Tracks and Vias in ${c.name}`, run: cmd("unselect") }, "-",
    { label: "Show All Netclasses", run: cmd("showAll") }, { label: "Hide All Other Netclasses", run: cmd("hideOthers") },
  ];
}

/** A BITMAP_BUTTON in a heading row (padding 2, 16 px bitmap). */
function HeadButton({ icon, title, k, onClick }: { icon: string; title: string; k: string; onClick: () => void }) {
  return <button type="button" className="tbtn flex-none flex items-center justify-center w-5 h-5 p-0 bg-transparent border border-transparent rounded-xs hover:bg-panel hover:border-line" title={title} data-head-btn={k}
    onClick={onClick}><KIcon name={icon} size={16} /></button>;
}

function NetsTab() {
  const nets = usePanels((s) => s.appearance.nets);
  const classes = usePanels((s) => s.appearance.netClasses);
  const colorMode = usePanels((s) => s.appearance.netColorMode);
  const ratsMode = usePanels((s) => s.appearance.ratsnestMode);
  const [q, setQ] = useState("");
  const menu = useContextMenu();
  const ql = q.trim().toLowerCase();
  const list = ql ? nets.filter((n) => unescapeString(n.name).toLowerCase().includes(ql)) : nets;
  const netColor = (n: NetRow) => () => pickColor({ title: `${unescapeString(n.name)} color`, color: n.color, def: null, set: (c) => pdispatch({ t: "netColor", name: n.name, color: c }) });
  const classColor = (c: NetClassRow) => () => pickColor({ title: `${c.name} color`, color: c.color, def: null, set: (v) => pdispatch({ t: "classColor", name: c.name, color: v }) });
  return (
    <>
      <div id="nets" className="flex flex-col flex-auto min-h-0 bg-paper">
        <div className="flex flex-none items-center px-1.5 pt-1"><span className="flex-auto font-semibold">Nets</span>
          <HeadButton icon="list_nets" title="Show the Net Inspector" k="netInspector" onClick={() => pdispatch({ t: "showNetInspector" })} /></div>
        <div className="flex-none px-1.5 py-1"><input id="netFilter" type="search" placeholder="Filter nets" value={q} onChange={(ev) => setQ(ev.target.value)} className="w-full bg-panel border border-line rounded-xs py-0.5 px-1.5 text-ink text-sm" /></div>
        <div className="knets flex-[3_1_0] min-h-[60px] overflow-auto border-y border-line">
          {list.length ? list.slice(0, 600).map((n) => (
            <div key={n.name} className={cx(ROW2, "hover:bg-panel")} data-net={n.name} onContextMenu={(ev) => menu.open(ev, netMenu(n, netColor(n)))}>
              <Swatch color={n.color} title="Double click (or middle click) to change color; right click for more actions" onPick={netColor(n)} />
              <Eye on={n.visible} k={n.name} title={(n.visible ? "Click to hide ratsnest for " : "Click to show ratsnest for ") + unescapeString(n.name)} onChange={(on) => pdispatch({ t: "netVisible", name: n.name, on })} />
              <span className="overflow-hidden text-ellipsis">{unescapeString(n.name)}</span>
            </div>
          )) : <p className="note px-2">{nets.length ? "No nets match the filter." : "This board has no nets yet."}</p>}
        </div>
        <div className="flex flex-none items-center px-1.5 pt-1.5 pb-0.5"><span className="flex-auto font-semibold">Net Classes</span>
          <HeadButton icon="options_generic" title="Configure net classes" k="netClasses" onClick={() => pdispatch({ t: "boardSetup", page: "netclasses" })} /></div>
        <div className="kclasses flex-[1_1_0] min-h-[44px] overflow-auto">
          {classes.map((c) => (
            <div key={c.name} className={cx(ROW2, "hover:bg-panel")} data-netclass={c.name} onContextMenu={(ev) => menu.open(ev, classMenu(c, classColor(c)))}>
              {/* the Default class can't have an override colour: its swatch is hidden but keeps its space */}
              {c.name === "Default" ? <span className="w-[18px] flex-none" /> : <Swatch color={c.color} title="Left double click or middle click for color change, right click for menu" onPick={classColor(c)} />}
              <Eye on={c.visible} k={c.name} title={`Show or hide ratsnest for nets in ${c.name}`} onChange={(on) => pdispatch({ t: "classVisible", name: c.name, on })} />
              <span className="overflow-hidden text-ellipsis">{c.name}</span>
            </div>
          ))}
        </div>
      </div>
      <Collapsible title="Net Display Options" id="netOpts">
        <div className="mb-1" title="Choose when to show net and netclass colors" data-label="netcolors">{hotkeyLabel("Net colors", "netColorModeCycle")}</div>
        <div className="flex mb-1.5">
          {([["all", "All", "Net and netclass colors are shown on all copper items"], ["ratsnest", "Ratsnest", "Net and netclass colors are shown on the ratsnest only"], ["off", "None", "Net and netclass colors are not shown"]] as const).map(([m, label, tip]) => (
            <label className={RADIO} key={m} title={tip}><input type="radio" className="m-0 accent-blue" name="kNetColor" data-netcolor={m} checked={colorMode === m} onChange={() => pdispatch({ t: "netColorMode", mode: m })} />{label}</label>
          ))}
        </div>
        <div className="mb-1" title="Choose which ratsnest lines to display" data-label="ratsnest">{hotkeyLabel("Ratsnest display", "ratsnestModeCycle")}</div>
        <div className="flex">
          {([["all", "All", "Show ratsnest lines to items on all layers"], ["visible", "Visible layers", "Show ratsnest lines to items on visible layers"], ["none", "None", "Hide all ratsnest lines"]] as const).map(([m, label, tip]) => (
            <label className={RADIO} key={m} title={tip}><input type="radio" className="m-0 accent-blue" name="kRats" data-rats={m} checked={ratsMode === m} onChange={() => pdispatch({ t: "ratsnestMode", mode: m })} />{label}</label>
          ))}
        </div>
      </Collapsible>
      <ContextMenu at={menu.at} onClose={menu.close} />
    </>
  );
}

const SELECT = "flex-1 min-w-0 text-sm";
// include/dialogs/eda_view_switcher.h: on macOS the physical Control key (WXK_RAW_CONTROL, Cmd+Tab is the system's
// application switcher) and Option; elsewhere Ctrl and Shift.  APPEARANCE_CONTROLS::rebuildLayerPresetsWidget /
// rebuildViewportsWidget write the labels with KeyNameFromKeyCode over the form's "Ctrl+Tab" / "Alt+Tab".
const PRESET_SWITCH_KEY = IS_MAC ? "RawCtrl" : "Ctrl";
// browsers keep Ctrl+Tab for their own tabs, so Ctrl+` opens the preset switcher too (editor/view-switcher.ts); the
// label stays KiCad's (APPEARANCE_CONTROLS: "Presets (%s+Tab):") and the tooltip names the browser's key
const PRESET_SWITCH_STEP = "`";
const VIEWPORT_SWITCH_KEY = IS_MAC ? "Alt" : "Shift";
function PresetsAndViewports() {
  const presets = usePanels((s) => s.appearance.presets);
  const builtin = usePanels((s) => s.appearance.builtinPresets);
  const preset = usePanels((s) => s.appearance.preset);
  const viewports = usePanels((s) => s.appearance.viewports);
  const viewport = usePanels((s) => s.appearance.viewport);
  const user = presets.filter((p) => !builtin.includes(p));
  return (
    // one row (KiCad stacks two labelled combos; in a narrow dock that footer crowded the layer list out): the
    // labels are short and their tooltips carry KiCad's labels with the switch keys
    <div className="flex flex-none items-center gap-1.5 px-1.5 py-1 border-t border-line bg-bench">
      <span className="flex-none text-ink-2" data-label="presets" title={`Presets (${keyName(PRESET_SWITCH_KEY + "+Tab")}, or ${keyName(PRESET_SWITCH_KEY + "+" + PRESET_SWITCH_STEP)} in a browser)`}>Preset</span>
      {/* rebuildLayerPresetsWidget: the built-in presets, then "---" and the user's own (both alphabetical), then
          "---", Save, Delete; no preset matching what is shown selects that last separator (count - 3) */}
      <Select id="presetSel" className={SELECT} title="Layer presets" value={preset && presets.includes(preset) ? preset : "\u0001sep"}
        options={[...builtin.map((p) => ({ value: p, label: p })), ...(user.length ? [{ value: "\u0001sepUser", label: "---", sep: true }, ...user.map((p) => ({ value: p, label: p }))] : []),
          { value: "\u0001sep", label: "---", sep: true }, { value: "\u0001save", label: "Save preset..." }, { value: "\u0001delete", label: "Delete preset...", disabled: !user.length }]}
        onChange={(v) => { if (v === "\u0001save") pdispatch({ t: "presetSave" }); else if (v === "\u0001delete") pdispatch({ t: "presetDelete" }); else if (v && !v.startsWith("\u0001")) pdispatch({ t: "preset", name: v }); }} />
      <span className="flex-none text-ink-2 ml-1" data-label="viewports" title={`Viewports (${keyName(VIEWPORT_SWITCH_KEY + "+Tab")})`}>View</span>
      {/* rebuildViewportsWidget: the saved viewports, "---", Save, Delete; the separator while none is current */}
      <Select id="viewportSel" className={SELECT} title="Viewports" value={viewport && viewports.includes(viewport) ? viewport : "\u0001sep"}
        options={[...viewports.map((p) => ({ value: p, label: p })),
          { value: "\u0001sep", label: "---", sep: true }, { value: "\u0001save", label: "Save viewport..." }, { value: "\u0001delete", label: "Delete viewport...", disabled: !viewports.length }]}
        onChange={(v) => { if (v === "\u0001save") pdispatch({ t: "viewportSave" }); else if (v === "\u0001delete") pdispatch({ t: "viewportDelete" }); else if (v && !v.startsWith("\u0001")) pdispatch({ t: "viewport", name: v }); }} />
    </div>
  );
}

const TABS = "ktabs flex flex-none border-b border-line bg-bench";
const TAB = "flex-1 bg-transparent border-0 border-b-2 border-b-transparent py-1 px-0 text-sm text-ink-2 on:text-ink on:border-b-blue on:bg-paper";

function BoardAppearance() {
  const [tab0, setTab] = useState<"layers" | "objects" | "nets">("layers");
  // the Footprint Editor's panel has no Nets page (m_notebook->RemovePage( 2 ))
  const fpEditor = usePanels((s) => !!s.appearance.fpEditor);
  const tab = fpEditor && tab0 === "nets" ? "layers" : tab0;
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm">
      <div className={TABS}>
        {(fpEditor ? ["layers", "objects"] as const : ["layers", "objects", "nets"] as const).map((t) => (
          <button type="button" key={t} className={cx(TAB, tab === t && "on")} data-atab={t} onClick={() => setTab(t)}>{t === "layers" ? "Layers" : t === "objects" ? "Objects" : "Nets"}</button>
        ))}
      </div>
      <div className={cx("flex flex-col flex-auto min-h-0", tab !== "layers" && "hidden")}><LayersTab /></div>
      {tab === "objects" ? <ObjectsTab /> : null}
      {tab === "nets" ? <NetsTab /> : null}
      <PresetsAndViewports />
    </div>
  );
}

// ================================================================ schematic (minimal)
function SchAppearance() {
  const [tab, setTab] = useState<"layers" | "objects">("layers");
  return (
    <div className="kbody overflow-auto py-1.5 px-2 min-h-0 flex-auto bg-paper text-sm">
      <div className={cx(TABS, "-mt-1.5 -mx-2 mb-1.5")}>
        {(["layers", "objects"] as const).map((t) => (
          <button type="button" key={t} className={cx(TAB, tab === t && "on")} data-atab={t} onClick={() => setTab(t)}>{t === "layers" ? "Layers" : "Objects"}</button>
        ))}
      </div>
      <div id="layers" hidden={tab !== "layers"}><SchLayers /></div>
      <div id="objects" hidden={tab !== "objects"}>{tab === "objects" ? <SchObjects /> : null}</div>
    </div>
  );
}

export function AppearancePane() {
  const editor = useApp((s) => s.document.editor);
  return editor === "pcb" ? <BoardAppearance /> : <SchAppearance />;
}
