// pcbdialogs/cleanup-graphics — Tools > Cleanup Graphics... (DIALOG_CLEANUP_GRAPHICS, dialog_cleanup_graphics_base.fbp):
// Merge lines into rectangles, Delete redundant graphics, Fix discontinuities in board outlines with its Tolerance.
// Every checkbox reruns the dry run into "Changes to be applied:"; OK ("Update PCB") applies them as one
// "Cleanup Graphics" commit.  Selecting a change highlights its items on the board.  In the footprint editor the
// outline fix is not offered and "Merge overlapping graphics into pads" is (GRAPHICS_CLEANER::mergePads: PAD::Recombine
// on every pad outside a net-tie pad group); OK is "Update Footprint" there.
import { E } from "../state";
import { checkField, form, h, lenField, openDialog, unitLabel } from "./ui";

interface Opts { mergeRects: boolean; deleteRedundant: boolean; fixBoardOutlines: boolean; tolerance: number }
interface Plan { items: { text: string; ids: string[] }[]; changes: KChange[] }
interface PcbToolsApi { graphicsCleanup(doc: KDoc, o: Opts, dryRun: boolean): Plan; applySelection?(ctx: ToolCtx, ids: string[]): void; fpPads: { recombinePadChanges(doc: KDoc, padId: string, dryRun?: boolean): { changes: KChange[]; merged: string[] } } }
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;

/** s_defaultTolerance: 2 mm, then whatever the last OK used, for the session. */
let lastTolerance = 2;

export function openCleanupGraphics(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("Cleanup Graphics needs a board"); return; }
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  const setHl = (ids: string[] | null): void => { const c = ctx as ToolCtx & { setHighlight?(s: Set<string> | null): void }; if (c.setHighlight) c.setHighlight(ids && ids.length ? new Set(ids) : null); ctx.requestRender(); };
  const rects = checkField(false, "Merge lines into rectangles", { key: "createRectangles" });
  const redundant = checkField(false, "Delete redundant graphics", { key: "deleteRedundant" });
  const outlines = checkField(false, "Fix discontinuities in board outlines", { key: "fixBoardOutlines" });
  const fpEd = !!doc.fpEditor;
  const mergePads = checkField(false, "Merge overlapping graphics into pads", { key: "mergePads" });
  /** FOOTPRINT::MapPadNumbersToNetTieGroups: the pad numbers that sit in a net-tie group */
  const netTiePads = (): Set<string> => {
    const hdr = (doc as KDoc & { fp?: SNode }).fp; const g = hdr ? (hdr.find((c) => Array.isArray(c) && c[0] === "net_tie_pad_groups") as SNode | undefined) : undefined;
    return new Set(g ? g.slice(1).flatMap((x) => String(x).split(/[,\s]+/).filter(Boolean)) : []);
  };
  /** mergePads over the pads: each pad with the shapes PAD::Recombine would take in */
  const padMerges = (dry: boolean): { ids: string[]; changes: KChange[] }[] => {
    if (!fpEd || !mergePads.get()) return [];
    const tie = netTiePads(), out: { ids: string[]; changes: KChange[] }[] = [];
    for (const it of doc.items.values()) {
      if (it.kind !== "pad" || tie.has(String(it.node[1]))) continue;
      const r = PT().fpPads.recombinePadChanges(doc, it.id, dry);
      if (r.merged.length) out.push({ ids: [...r.merged, it.id], changes: r.changes });
    }
    return out;
  };
  const tol = lenField(lastTolerance, { key: "tolerance", min: 0 });
  tol.input.setAttribute("data-nopersist", "");   // TransferDataToWindow sets it from s_defaultTolerance
  const list = h("div", { class: "pd-report", style: "height:250px;min-height:0", "data-k": "changes" });
  const opts = (): Opts => ({ mergeRects: rects.get(), deleteRedundant: redundant.get(), fixBoardOutlines: !fpEd && outlines.get(), tolerance: tol.get() });
  const dryRun = (): void => {
    setHl(null);
    const items = PT().graphicsCleanup(doc, opts(), true).items.concat(padMerges(true).map((m) => ({ text: "Merge overlapping shapes into pad", ids: m.ids })));
    list.replaceChildren(...items.map((it) => {
      const row = h("div", { class: "ln action", tabindex: "0" }, it.text);
      row.addEventListener("click", () => { for (const r of Array.from(list.children)) r.classList.toggle("sel", r === row); setHl(it.ids); });
      return row;
    }));
  };
  openDialog({ title: "Cleanup Graphics", width: 680, okLabel: fpEd ? "Update Footprint" : "Update PCB", persist: true,
    build(body) {
      body.append(fpEd
        ? h("div", { style: "display:flex;flex-direction:column;gap:2px" }, rects.el, redundant.el, mergePads.el,
          h("div", { class: "pd-lbl", style: "margin-left:22px;font-style:italic;font-size:11px" }, "(Pads which appear in a Net Tie pad group will not be considered for merging.)"))
        : h("div", { style: "display:flex;flex-direction:column;gap:2px" }, rects.el, redundant.el, outlines.el,
          h("div", { style: "margin-left:22px" }, form([["Tolerance:", tol.el, unitLabel()]]))),
        h("div", { class: "pd-lbl", style: "margin:10px 0 4px" }, "Changes to be applied:"), list);
      body.addEventListener("change", (ev) => { if (!list.contains(ev.target as Node)) dryRun(); });
      dryRun();
    },
    restored() { dryRun(); },
    cancel() { setHl(null); return true; },
    ok() {
      lastTolerance = tol.get();
      setHl(null);
      const sel = PT().applySelection; if (sel) sel(ctx, []);   // ACTIONS::selectionClear
      const plan = PT().graphicsCleanup(doc, opts(), false);
      // the pad merges after the shape cleanup, leaving out a pad whose shapes the cleanup already changes
      const touched = new Set(plan.changes.map((c) => (c as { id?: string }).id));
      const merges = padMerges(false).filter((m) => !m.ids.some((id) => touched.has(id)));
      const changes = plan.changes.concat(...merges.map((m) => m.changes));
      if (changes.length) ctx.commit(changes, "Cleanup Graphics");
      ctx.requestRender();
      return true;
    } });
}
