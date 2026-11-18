// pcbdialogs/filter-selection — Edit > Select > Filter Selected Items... (PCB_SELECTION_TOOL::filterSelection,
// DIALOG_FILTER_SELECTION, dialog_filter_selection_base.fbp): the "All items" three-state check box over KiCad's
// eight options in a two-column grid; OK re-selects the selected items the options include (itemIsIncludedByFilter).
// The options live as long as the session (PCB_SELECTION_TOOL's m_filterOpts).
import { selectionIds } from "../gestures";
import { checkField, h, openDialog, type Field } from "./ui";

type Opts = Record<string, boolean>;
interface PcbToolsApi { filterSelectionIds(doc: KDoc, ids: Iterable<string>, o: Opts): string[]; FILTER_SELECTION_DEFAULTS: Opts; applySelection?(ctx: ToolCtx, ids: string[]): void }
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;
let opts: Opts | null = null;

export function openFilterSelection(ctx: ToolCtx): void {
  const doc = ctx.doc as KDoc | null;
  if (!doc || doc.type !== "pcb") return;
  const o: Opts = { ...(opts || PT().FILTER_SELECTION_DEFAULTS) };
  const f = (k: string, label: string): Field<boolean> => checkField(!!o[k], label, { key: k });
  const fps = f("includeFootprints", "Include footprints"), texts = f("includePcbTexts", "Include text items"), locked = f("includeLockedFootprints", "Include locked footprints"),
    draw = f("includeItemsOnTechLayers", "Include drawings"), tracks = f("includeTracks", "Include tracks"), edges = f("includeBoardOutlineLayer", "Include board outline layer"),
    vias = f("includeVias", "Include vias"), zones = f("includeZones", "Include zones");
  const rest = [tracks, vias, zones, draw, edges, texts];
  const all = h("input", { type: "checkbox", "data-k": "allItems" }) as HTMLInputElement;
  // GetSuggestedAllItemsState: locked footprints count only while footprints are included
  const suggested = (): boolean | undefined => {
    let n = 0, of = 8;
    if (fps.get()) { n++; if (locked.get()) n++; } else of--;
    for (const c of rest) if (c.get()) n++;
    return n === 0 ? false : n === of ? true : undefined;
  };
  const showAll = (v: boolean | undefined): void => { all.indeterminate = v === undefined; all.checked = v === true; };
  const lockEnable = (): void => { (locked.input as HTMLInputElement).disabled = !fps.get(); locked.el.classList.toggle("disabled", !fps.get()); };
  // checkBoxClicked / allItemsClicked (wxCHK_ALLOW_3RD_STATE_FOR_USER: unchecked -> checked -> undetermined; only checked sets them all)
  let allState: boolean | undefined;
  all.addEventListener("click", () => {
    allState = allState === false ? true : allState === true ? undefined : false; showAll(allState);
    for (const c of [fps, locked, ...rest]) c.set(allState === true);
    lockEnable();
  });
  openDialog({ title: "Filter Selected Items", width: 440,
    build(body) {
      const g = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:3px 12px" });
      g.append(h("label", { class: "pd-check" }, all, "All items"), h("span"), fps.el, texts.el, locked.el, draw.el, tracks.el, edges.el, vias.el, zones.el);
      body.append(g);
      body.addEventListener("change", (ev) => { if (ev.target === all) return; lockEnable(); allState = suggested(); showAll(allState); });
      lockEnable(); allState = suggested(); showAll(allState);
    },
    ok() {
      const next: Opts = { includeFootprints: fps.get(), includeLockedFootprints: locked.get(), includeTracks: tracks.get(), includeVias: vias.get(), includeZones: zones.get(),
        includeItemsOnTechLayers: draw.get(), includeBoardOutlineLayer: edges.get(), includePcbTexts: texts.get() };
      opts = next;
      const kept = PT().filterSelectionIds(doc, selectionIds(), next);
      if (PT().applySelection) PT().applySelection!(ctx, kept);
      ctx.requestRender();
      return true;
    } });
}
