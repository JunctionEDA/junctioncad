// pcbdialogs/shape-modify — the Shape Modification sub-menu's actions (EDIT_TOOL::ModifyLines, SimplifyPolygons,
// BooleanPolygons): WX_UNIT_ENTRY_DIALOG for the fillet radius ("Fillet Lines", Radius:), the chamfer setback
// ("Chamfer Lines", Chamfer setback:) and the tolerance ("Simplify Shapes", Tolerance value:), each value remembered
// for the session as KiCad's statics are; the geometry is pcb-tools' (shape-modify.ts).  CONVERT_TOOL::OutsetItems with
// DIALOG_OUTSET_ITEMS (pcbnew/dialogs/dialog_outset_items_base.cpp): Outset, Round corners, Round outwards to grid
// multiples with its Grid size, Copy item layers / Layer, Copy item widths / Line width with Layer Default, Delete source
// items; the outset, width and grid entries are combos of KiCad's presets and the values used this session.
import { selectionIds } from "../gestures";
import { comboBox } from "../../../../shared/components/kcombo";
import { checkField, currentUnits, fmtLen, form, h, lenField, messageBox, openDialog, selectField, unitLabel } from "./ui";

interface Result { changes: KChange[]; label: string; message: string | null; select: string[] }
interface ShapeApi {
  modifyLines(doc: KDoc, ids: string[], op: string, value: number): Result | { error: string };
  simplifyPolygons(doc: KDoc, ids: string[], tol: number): Result;
  booleanPolygons(doc: KDoc, ids: string[], op: string): Result;
}
interface OutsetParams { outset: number; roundCorners: boolean; useSourceLayers: boolean; useSourceWidths: boolean; layer: string; lineWidth: number; gridRounding: number | null; deleteSourceItems: boolean }
interface OutsetApi { outsetItems(doc: KDoc, ids: string[], p: OutsetParams): Result; outsetDefaults(fpEditor: boolean, lineWidth: (layer: string) => number): OutsetParams }
const PT = (): { shapeModify: ShapeApi; outset: OutsetApi; layerStyle(layer: string): { line: number }; boardLayerName(doc: KDoc, l: string): string; applySelection?(ctx: ToolCtx, ids: string[]): void; unlockedIds?(ctx: ToolCtx, ids: string[], quiet: boolean): string[] } =>
  (window as unknown as { PcbTools: ReturnType<typeof PT> }).PcbTools;
// s_filletRadius (1 mm), the chamfer setback (1 mm) and s_toleranceValue (3 mm)
const remembered: Record<string, number> = { filletLines: 1, chamferLines: 1, simplifyPolygons: 3 };

/** WX_UNIT_ENTRY_DIALOG: one length; a value of zero or less does nothing. */
function unitEntry(title: string, caption: string, key: string, done: (v: number) => void): void {
  const f = lenField(remembered[key], { key: "unitEntry" });
  openDialog({ title, width: 360,
    build(body) { body.append(form([[caption, f.el, unitLabel()]])); setTimeout(() => { (f.input as HTMLInputElement).focus(); (f.input as HTMLInputElement).select(); }, 0); },
    ok() { const v = f.get(); if (!isFinite(v)) return false; remembered[key] = v; if (v > 0) done(v); return true; } });
}
function apply(ctx: ToolCtx, r: Result | { error: string }): void {
  if ("error" in r) { ctx.toast(r.error); return; }
  if (r.changes.length) ctx.commit(r.changes, r.label);
  const P = PT(); if (r.select.length && P.applySelection) P.applySelection(ctx, r.select);
  if (r.message) ctx.toast(r.message);
  ctx.requestRender();
}
const board = (ctx: ToolCtx): KDoc | null => (ctx.doc && ctx.doc.type === "pcb" && !ctx.viewOnly ? ctx.doc : null);

export function filletLines(ctx: ToolCtx): void {
  const doc = board(ctx); if (!doc) return; const ids = selectionIds();
  unitEntry("Fillet Lines", "Radius:", "filletLines", (v) => apply(ctx, PT().shapeModify.modifyLines(doc, ids, "filletLines", v)));
}
export function chamferLines(ctx: ToolCtx): void {
  const doc = board(ctx); if (!doc) return; const ids = selectionIds();
  unitEntry("Chamfer Lines", "Chamfer setback:", "chamferLines", (v) => apply(ctx, PT().shapeModify.modifyLines(doc, ids, "chamferLines", v)));
}
export function extendLines(ctx: ToolCtx): void {
  const doc = board(ctx); if (!doc) return;
  apply(ctx, PT().shapeModify.modifyLines(doc, selectionIds(), "extendLines", 0));
}
export function simplifyPolygons(ctx: ToolCtx): void {
  const doc = board(ctx); if (!doc) return; const ids = selectionIds();
  unitEntry("Simplify Shapes", "Tolerance value:", "simplifyPolygons", (v) => apply(ctx, PT().shapeModify.simplifyPolygons(doc, ids, v)));
}
export function booleanPolygons(op: "mergePolygons" | "subtractPolygons" | "intersectPolygons"): (ctx: ToolCtx) => void {
  return (ctx) => { const doc = board(ctx); if (!doc) return; apply(ctx, PT().shapeModify.booleanPolygons(doc, selectionIds(), op)); };
}

// DIALOG_OUTSET_ITEMS' statics: the presets and the values used this session (sorted, without repeats)
const OUTSET_PRESETS = [0.1, 0.11, 0.15, 0.25, 0.26, 0.5, 1.0, 2.0], WIDTH_PRESETS = [0.05, 0.1, 0.12, 0.15, 0.2], GRID_PRESETS = [0.01];
const recent = { outset: [] as number[], width: [] as number[], grid: [] as number[] };
let gridPersist = GRID_PRESETS[0];
const outsetParams: Record<"pcb" | "fp", OutsetParams | null> = { pcb: null, fp: null };
const optionList = (presets: number[], used: number[]): number[] => Array.from(new Set([...presets, ...used].map((v) => +v.toFixed(6)))).sort((a, b) => a - b);

/** CONVERT_TOOL::OutsetItems: pads and graphic shapes of the selection, outset into new shapes. */
export function outsetItems(ctx: ToolCtx): void {
  const doc = board(ctx); if (!doc) return;
  let ids = selectionIds().filter((id) => { const it = doc.items.get(id); return !!it && (it.kind === "pad" || /^gr_(line|rect|circle|arc|poly|curve)$/.test(it.kind)); });
  if (!ids.length) return;
  const P = PT();
  // FilterCollectorForLockedItems + ReportFilteredLockedItems: a locked item stops the action (a footprint holder's
  // items are never locked, BOARD_ITEM::IsLocked)
  if (!doc.fpEditor && P.unlockedIds) { ids = P.unlockedIds(ctx, ids, false); if (!ids.length) return; }
  const key = doc.fpEditor ? "fp" : "pcb";
  const prm = outsetParams[key] || (outsetParams[key] = P.outset.outsetDefaults(!!doc.fpEditor, (l) => P.layerStyle(l).line));
  const units = currentUnits();
  const combo = (f: { input: HTMLElement }, presets: number[], used: number[]): void => { comboBox(f.input as HTMLInputElement, () => optionList(presets, used).map((v) => fmtLen(v, units))); };
  const outset = lenField(prm.outset, { key: "outset" }); combo(outset, OUTSET_PRESETS, recent.outset);
  const roundCorners = checkField(prm.roundCorners, "Round corners (when possible)", { key: "roundCorners" });
  const grid = lenField(prm.gridRounding ?? gridPersist, { key: "gridSize" }); combo(grid, GRID_PRESETS, recent.grid);
  const enableGrid = (on: boolean): void => { (grid.input as HTMLInputElement).disabled = !on; };   // OnRoundToGridChecked
  const roundToGrid = checkField(prm.gridRounding !== null, "Round outwards to grid multiples (when possible)", { key: "roundToGrid", tip: "This is only possible for rectangular outsets.", onChange: enableGrid });
  const layers = Array.from(doc.layers.keys()).map((l): [string, string] => [l, P.boardLayerName(doc, l)]);
  if (!layers.some((l) => l[0] === prm.layer)) layers.unshift([prm.layer, prm.layer]);
  const layer = selectField<string>(prm.layer, layers, { key: "layer" });
  const enableLayer = (on: boolean): void => { (layer.input as HTMLElement & { disabled: boolean }).disabled = !on; };   // OnCopyLayersChecked
  const copyLayers = checkField(prm.useSourceLayers, "Copy item layers", { key: "copyLayers", onChange: (v) => enableLayer(!v) });
  const copyWidths = checkField(prm.useSourceWidths, "Copy item widths (if possible)", { key: "copyWidths", tip: "This is not possible for items like pads, which will still use the value below." });
  const width = lenField(prm.lineWidth, { key: "lineWidth" }); combo(width, WIDTH_PRESETS, recent.width);
  const layerDefault = h("button", { type: "button", class: "btn", "data-k": "layerDefault" }, "Layer Default");
  layerDefault.addEventListener("click", () => width.set(P.layerStyle(layer.get()).line));   // OnLayerDefaultClick
  const del = checkField(prm.deleteSourceItems, "Delete source items after outset", { key: "deleteSource", tip: "This is not possible for items like pads, which will still use the value below." });
  const rule = (): HTMLElement => h("hr", { style: "border:0;border-top:1px solid var(--line);margin:4px 0" });
  openDialog({ title: "Outset Items", width: 420,
    build(body) {
      body.append(form([["Outset:", outset.el, unitLabel()], roundCorners.el, roundToGrid.el, ["Grid size:", grid.el, unitLabel()], rule(),
        copyLayers.el, ["Layer:", layer.el], copyWidths.el, ["Line width:", width.el, h("span", { style: "display:flex;gap:6px;align-items:center" }, unitLabel(), layerDefault)], rule(), del.el]));
      enableGrid(roundToGrid.get()); enableLayer(!copyLayers.get());
    },
    ok() {
      if (!(width.get() > 0)) { messageBox("Error", "Line width must be a positive value."); return false; }
      Object.assign(prm, { layer: layer.get(), outset: outset.get(), roundCorners: roundCorners.get(), lineWidth: width.get(), useSourceLayers: copyLayers.get(), useSourceWidths: copyWidths.get(),
        gridRounding: roundToGrid.get() ? grid.get() : null, deleteSourceItems: del.get() });
      gridPersist = grid.get();
      const remember = (list: number[], v: number): void => { if (!list.some((x) => Math.abs(x - v) < 1e-9)) list.push(v); };
      remember(recent.outset, prm.outset); remember(recent.width, prm.lineWidth);
      if (prm.gridRounding !== null) remember(recent.grid, prm.gridRounding);   // only a grid that was used
      apply(ctx, P.outset.outsetItems(doc, ids, prm));
      return true;
    } });
}
