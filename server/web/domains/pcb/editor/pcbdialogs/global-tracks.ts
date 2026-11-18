// pcbdialogs/global-tracks — Edit > Edit Track & Via Properties... (GLOBAL_EDIT_TOOL::EditTracksAndVias,
// DIALOG_GLOBAL_EDIT_TRACKS_AND_VIAS, dialog_global_edit_tracks_and_vias_base.fbp "Set Track and Via Properties"):
// Scope (Tracks; Vias with the four via types under it as a three-state parent), Filter Items (net, net class,
// layer, track width, via diameter, selected items only) and the Action: the specified values (Layer, Track width,
// Via size, Via annular rings, Via protection features, each starting at "-- leave unchanged --") or the net class
// / custom rule values.  Apply writes one "Edit Track & Via Properties" commit and keeps the dialog; Apply and
// Close does the same and closes.  The net and net class filters are remembered for the session (g_netFilter,
// g_netclassFilter).
import { E } from "../state";
import { pcbState, selectionIds } from "../gestures";
import { IPC4761 } from "./track-via-model";
import { box, checkField, h, lenField, openDialog, selectField, unitLabel, type Field } from "./ui";

interface Job { scope: Record<string, boolean>; filter: Record<string, unknown>; specified: boolean; values: Record<string, unknown>; settings: unknown }
interface PcbToolsApi {
  globalTrackViaChanges(doc: KDoc, job: Job): KChange[]; designSettings(src: unknown): { netclasses: Record<string, unknown> };
  boardLayerName(doc: KDoc, name: string): string; expandGroups?(doc: KDoc, ids: string[]): string[];
}
interface Sizes { trackWidths: number[]; vias: { diameter: number; drill: number }[] }
interface SizesApi { state: { sizes: Sizes }; trackWidthLabels(s: Sizes, u: string, li: string): string[]; viaSizeLabels(s: Sizes, u: string, li: string): string[] }
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;
const PS = (): SizesApi => (KiCadCanvas as unknown as { pcbSizes: SizesApi }).pcbSizes;
/** INDETERMINATE_ACTION (include/widgets/ui_common.h) */
export const LEAVE = "-- leave unchanged --";
const memory = { net: "", netclass: "" };

export function openGlobalEditTracks(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("Edit Track & Via Properties needs a board"); return; }
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  const settings = PT().designSettings(E.proSettings || null);
  const st = pcbState();
  const selection = (): Set<string> => { const ids = selectionIds(); return new Set(PT().expandGroups ? PT().expandGroups!(doc, ids) : ids); };
  const nodup = (f: Field<unknown>): void => { f.input.setAttribute("data-nopersist", ""); };

  // ---- Scope
  const tracks = checkField(true, "Tracks", { key: "tracks" });
  const vias = checkField(true, "Vias", { key: "vias" });
  const kinds = { throughVias: checkField(true, "Through vias", { key: "throughVias" }), microVias: checkField(true, "Microvias", { key: "microVias" }),
    blindVias: checkField(true, "Blind vias", { key: "blindVias" }), buriedVias: checkField(true, "Buried vias", { key: "buriedVias" }) };
  const kindList = Object.values(kinds);
  // onVias: the parent sets all four; updateViasCheckbox: the parent shows none / all / some
  vias.input.addEventListener("change", () => { for (const k of kindList) k.set(vias.get()); });
  const updateVias = (): void => { const n = kindList.filter((k) => k.get()).length; const v = vias.input as HTMLInputElement; v.indeterminate = n > 0 && n < 4; v.checked = n === 4; };
  for (const k of kindList) k.input.addEventListener("change", updateVias);

  // ---- Filter Items
  const nets = Array.from(new Set(Array.from((doc as unknown as { nets?: Map<number, string> }).nets?.values() || []).filter((n) => n))).sort();
  const hl = (st as { highlightNet?: unknown } | null)?.highlightNet;
  const netOpt = checkField(false, "Filter items by net:", { key: "netFilterOpt" });
  const net = selectField<string>(memory.net && nets.includes(memory.net) ? memory.net : typeof hl === "string" && nets.includes(hl) ? hl : nets[0] || "", nets.map((n): [string, string] => [n, n]),
    { key: "netFilter", onChange: (v) => { memory.net = v; netOpt.set(true); } });   // OnNetFilterSelect
  const classes = ["Default", ...Object.keys(settings.netclasses).filter((n) => n !== "Default")];
  const ncOpt = checkField(false, "Filter items by net class:", { key: "netclassFilterOpt" });
  const nc = selectField<string>(memory.netclass && classes.includes(memory.netclass) ? memory.netclass : "Default", classes.map((n): [string, string] => [n, n]),
    { key: "netclassFilter", onChange: (v) => { memory.netclass = v; ncOpt.set(true); } });
  const copper = (doc as unknown as { copper?: string[] }).copper || ["F.Cu", "B.Cu"];
  const layerOpts = copper.map((l): [string, string] => [l, PT().boardLayerName(doc, l)]);
  const layerOpt = checkField(false, "Filter items by layer:", { key: "layerFilterOpt" });
  const layer = selectField<string>(copper.includes(ctx.activeLayer || "") ? ctx.activeLayer! : copper[0], layerOpts, { key: "layerFilter", onChange: () => layerOpt.set(true) });
  const widthOpt = checkField(false, "Filter tracks by width:", { key: "filterByTrackWidth" });
  const width = lenField(0, { key: "trackWidthFilter", onChange: () => widthOpt.set(true) });
  const diaOpt = checkField(false, "Filter vias by diameter:", { key: "filterByViaSize" });
  const dia = lenField(0, { key: "viaSizeFilter", onChange: () => diaOpt.set(true) });
  const selOnly = checkField(false, "Selected items only", { key: "selectedItemsFilter" });
  // OnTrackWidthText / OnViaSizeText: typing (wxEVT_TEXT) ticks the filter, not only leaving the field
  width.input.addEventListener("input", () => widthOpt.set(true));
  dia.input.addEventListener("input", () => diaOpt.set(true));
  for (const f of [net, nc, layer]) nodup(f as Field<unknown>);

  // ---- Action
  const radio = (label: string, key: string): Field<boolean> => {
    const input = h("input", { type: "radio", name: "gtv-action", "data-k": key }) as HTMLInputElement;
    return { el: h("label", { class: "pd-check" }, input, label), input, get: () => input.checked, set: (v) => { input.checked = v; } };
  };
  const specified = radio("Set to specified values:", "setToSpecifiedValues");
  const rules = radio("Set to net class / custom rule values", "setToDesignRuleValues");
  specified.set(true);
  const sizes = PS().state.sizes, units = E.units === "in" || E.units === "mil" ? E.units : "mm", li = E.lastImperial === "in" ? "in" : "mil";
  // UpdateTrackWidthSelectBox( …, false, false ) + INDETERMINATE_ACTION, which TransferDataToWindow selects
  const twLabels = PS().trackWidthLabels(sizes, units, li).slice(1), vsLabels = PS().viaSizeLabels(sizes, units, li).slice(1);
  const trackW = selectField<number>(-1, [...twLabels.map((l, i): [number, string] => [i, l]), [-1, LEAVE]], { key: "trackWidth" });
  const viaS = selectField<number>(-1, [...vsLabels.map((l, i): [number, string] => [i, l]), [-1, LEAVE]], { key: "viaSizes" });
  const rings = selectField<number>(-1, [[0, "All copper layers"], [1, "Start, end, and connected layers"], [2, "Connected layers only"], [3, "Start and end layers only"], [-1, LEAVE]], { key: "annularRings" });
  const prot = selectField<number>(-1, [...IPC4761.map(([name], i): [number, string] => [i, name]), [-1, LEAVE]], { key: "protectionFeatures" });
  prot.input.title = "Select which protection feature according to IPC-4761 the via should have.";
  const newLayer = selectField<string>("", [["", LEAVE], ...layerOpts], { key: "layerCtrl" });
  for (const f of [trackW, viaS, rings, prot, newLayer]) nodup(f as Field<unknown>);
  const actionRows: [string, Field<unknown>][] = [["Layer:", newLayer as Field<unknown>], ["Track width:", trackW as Field<unknown>], ["Via size:", viaS as Field<unknown>],
    ["Via annular rings:", rings as Field<unknown>], ["Via protection features:", prot as Field<unknown>]];
  const labels: HTMLElement[] = [];
  const actionGrid = h("div", { style: "display:grid;grid-template-columns:max-content minmax(240px,1fr);gap:6px 10px;align-items:center;margin:6px 0 8px 25px" });
  for (const [l, f] of actionRows) { const lab = h("label", null, l); labels.push(lab); actionGrid.append(lab, f.el); }
  // onActionButtonChange: Layer, Track width, Via size and Via annular rings follow the action; the protection
  // features choice stays enabled, as KiCad leaves it
  const sync = (): void => { const on = specified.get(); actionRows.slice(0, 4).forEach(([, f], i) => { (f.input as HTMLElement & { disabled: boolean }).disabled = !on; labels[i].classList.toggle("pd-dim", !on); }); };

  const apply = (): void => {
    const s = selection();
    const job: Job = {
      scope: { tracks: tracks.get(), throughVias: kinds.throughVias.get(), microVias: kinds.microVias.get(), blindVias: kinds.blindVias.get(), buriedVias: kinds.buriedVias.get() },
      filter: { net: netOpt.get() ? net.get() : null, netclass: ncOpt.get() ? nc.get() : null, layer: layerOpt.get() ? layer.get() : null,
        trackWidth: widthOpt.get() ? width.get() : null, viaDiameter: diaOpt.get() ? dia.get() : null, selection: selOnly.get() ? s : null },
      specified: specified.get(), settings,
      values: { layer: newLayer.get() || null, trackWidth: trackW.get() >= 0 ? sizes.trackWidths[trackW.get() + 1] : null,
        via: viaS.get() >= 0 ? sizes.vias[viaS.get() + 1] : null, annular: rings.get() >= 0 ? rings.get() : null, protection: prot.get() >= 0 ? prot.get() : null },
    };
    const changes = PT().globalTrackViaChanges(doc, job);
    if (changes.length) ctx.commit(changes, "Edit Track & Via Properties");
    ctx.requestRender();
  };

  openDialog({ title: "Set Track and Via Properties", width: 760, okLabel: "Apply and Close", cancelLabel: "Close", persist: true,
    extra: [{ label: "Apply", fn: apply }],
    build(body) {
      const filters = h("div", { style: "display:grid;grid-template-columns:max-content minmax(160px,1fr) max-content;gap:3px 6px;align-items:center" });
      filters.append(netOpt.el, net.el, h("span"), ncOpt.el, nc.el, h("span"), layerOpt.el, layer.el, h("span"),
        widthOpt.el, width.el, unitLabel(), diaOpt.el, dia.el, unitLabel());
      const scope = box("Scope", tracks.el, h("div", { style: "height:10px" }), vias.el, ...kindList.map((k) => h("div", { style: "margin-left:20px" }, k.el)));
      body.append(h("div", { style: "display:grid;grid-template-columns:1fr 2fr;gap:0 10px;align-items:stretch" }, scope, box("Filter Items", filters, h("div", { style: "height:5px" }), selOnly.el)),
        box("Action", specified.el, actionGrid, rules.el));
      body.addEventListener("change", sync);
      updateVias(); sync();
    },
    restored() { updateVias(); sync(); },
    ok() { apply(); return true; } });
}
