// pcbdialogs/fab-reports — File > Export > Footprint Association (.cmp) File... (BOARD_EDITOR_CONTROL::ExportCmpFile),
// File > Fabrication Outputs > IPC-D-356 Netlist File... (GenD356File with its "Do not export unconnected pads" file
// dialog option), Footprint Report... (GenFootprintsReport) and the legacy BOM (GenBOMFileFromBoard).  KiCad's save
// dialogs become a browser download of the same file name.
import type { KiCadFabApi } from "../../fab/index";
import { E } from "../state";
import { fabContext, loadFab } from "../fab-outputs";
import { loadPrefs, saveBlob, savePrefs } from "./plot-out";
import { checkField, h, messageBox, openDialog, textField } from "./ui";

async function prepared(ctx: ToolCtx, what: string): Promise<{ fab: KiCadFabApi; fctx: NonNullable<Awaited<ReturnType<typeof fabContext>>>; board: string } | null> {
  if (!E.kdoc || E.kdoc.type !== "pcb") { ctx.toast(`${what} is made from a board: open the PCB editor first`); return null; }
  let fab: KiCadFabApi;
  try { fab = await loadFab(); } catch (e) { console.warn(e); ctx.toast(`${what} could not be made`); return null; }
  const fctx = await fabContext(); if (!fctx) return null;
  const variant = String((E as { currentVariant?: string }).currentVariant || ""); if (variant) fctx.variant = variant;
  return { fab, fctx, board: fctx.projectName || "board" };
}

/** ExportCmpFile */
export async function exportCmpFile(ctx: ToolCtx): Promise<void> {
  const p = await prepared(ctx, "A footprint association file"); if (!p) return;
  saveBlob(p.fab.reports.cmp(p.fctx), `${p.board}.cmp`);
}
/** GenBOMFileFromBoard */
export async function generateBomLegacy(ctx: ToolCtx): Promise<void> {
  const p = await prepared(ctx, "A bill of materials"); if (!p) return;
  const text = p.fab.reports.legacyBom(p.fctx);
  if (text === null) { ctx.toast("Cannot export BOM: there are no footprints on the PCB."); return; }
  saveBlob(text, `${p.board}.csv`);
}
/** GenFootprintsReport: the report in the user units, the upper-left corner of the board's physical items */
export async function generateFootprintReport(ctx: ToolCtx): Promise<void> {
  const p = await prepared(ctx, "A footprint report"); if (!p) return;
  let x0 = Infinity, y0 = Infinity;
  for (const it of p.fctx.doc.items.values()) if (it.bbox) { x0 = Math.min(x0, it.bbox[0]); y0 = Math.min(y0, it.bbox[1]); }
  const name = `${p.board}.rpt`;
  saveBlob(p.fab.reports.footprintReport(p.fctx, E.units !== "in" && E.units !== "mil", [isFinite(x0) ? x0 : 0, isFinite(y0) ? y0 : 0]), name);
  messageBox("Footprint Report", `Footprint report file created:\n'${name}'.`);
}
/** GenD356File: the file name and D365_CUSTOMIZE_HOOK's "Do not export unconnected pads" */
export async function generateD356(ctx: ToolCtx): Promise<void> {
  const p = await prepared(ctx, "An IPC-D-356 netlist"); if (!p) return;
  const pref = loadPrefs("kicad.d356", { skipUnconnected: false });
  const file = textField(`${p.board}.d356`, { key: "outputFile" });
  const skip = checkField(pref.skipUnconnected, "Do not export unconnected pads", { key: "skipUnconnected" });
  openDialog({ title: "Generate IPC-D-356 netlist file", width: 460, okLabel: "Save",
    build(body) { file.el.style.flex = "1"; body.append(h("div", { style: "display:flex;gap:8px;align-items:center" }, h("label", null, "File:"), file.el), h("div", { style: "margin-top:8px" }, skip.el)); },
    ok() {
      savePrefs("kicad.d356", { skipUnconnected: skip.get() });
      const n = file.get().trim().replace(/\\/g, "/").split("/").pop() || `${p.board}.d356`;
      saveBlob(p.fab.reports.d356(p.fctx, skip.get()), /\.d356$/i.test(n) ? n : n + ".d356");
      ctx.toast(`IPC-D-356 netlist file created:\n'${n}'.`);
    } });
}
