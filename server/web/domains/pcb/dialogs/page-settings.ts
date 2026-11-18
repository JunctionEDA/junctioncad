// dialogs/page-settings.ts — File → Page Settings… (common/dialogs/dialog_page_settings.cpp), for both editors.
// OK sends one document-level change (see project.ts) carrying the new (paper …) and (title_block …).
import { E, applyChanges, isSch, publishUndo, redoStack, sendOp, toast, undoStack } from "./editor";
import { KD, checkbox, h, select, textInput } from "./dom";
import { datePicker } from "../../../shared/components/kdate";
import { PAPER_FORMATS, isoDate, rootPageChange, pageSettingsChange, pageSettingsOf, pageSizeError, type PageSettings } from "./logic";
import { currentDocEntry, projectDocs, readDoc, saveProject, sub, submitDocOp } from "./project";
import { bitmapButton } from "../../../shared/components/kicon-dom";
import { lenField, listDialog, messageBox } from "../editor/pcbdialogs/ui";
import { loadUnits, unitName } from "../../../shared/units";
import { applyDrawingSheet, drawingSheetName, forgetWorksheet, onWorksheetChange, projectWorksheets, resolveWorksheet, wksKey, worksheetNow } from "../editor/drawingsheet";
import { requestRender } from "../editor/view";

type TbKey = "date" | "rev" | "title" | "company" | `comment${number}`;
const ROWS: [TbKey, string][] = [["date", "Issue Date:"], ["rev", "Revision:"], ["title", "Title:"], ["company", "Company:"],
  ...Array.from({ length: 9 }, (_, i) => [`comment${i + 1}`, `Comment${i + 1}:`] as [TbKey, string])];
const getTb = (p: PageSettings, k: TbKey): string => (k.startsWith("comment") ? p.comments[+k.slice(7) - 1] || "" : p[k as "date" | "rev" | "title" | "company"]);
const setTb = (p: PageSettings, k: TbKey, v: string): void => { if (k.startsWith("comment")) p.comments[+k.slice(7) - 1] = v; else p[k as "date" | "rev" | "title" | "company"] = v; };

/** Commit page settings on the open document: applied locally, sent as an op, undoable. */
export function commitPageSettings(next: PageSettings): boolean {
  if (!E.kdoc) return false;
  const before = pageSettingsChange(pageSettingsOf(E.kdoc)), after = pageSettingsChange(next);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  applyChanges([after]); sendOp([after]);
  undoStack.push({ label: "page settings", changes: [after], inverse: [before] }); if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0; publishUndo();
  return true;
}

/** The root sheet's page number on the open (root) document, as one undoable step. */
export function commitRootPage(page: string): boolean {
  const d = E.kdoc as (KDoc & { pageNumber?: string }) | null; if (!d) return false;
  const was = String(d.pageNumber || "1"); if (was === page) return false;
  const after = rootPageChange(page), before = rootPageChange(was);
  applyChanges([after]); sendOp([after]);
  undoStack.push({ label: "change sheet page number", changes: [after], inverse: [before] }); if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0; publishUndo();
  return true;
}

/**
 * DIALOG_PAGES_SETTINGS::UpdateDrawingSheetExample: the page as it will be, scaled into the preview, with the real
 * drawing sheet (the chosen .kicad_wks or KiCad's own) and the title block text drawn by the canvas painter.
 */
function drawPreview(cv: HTMLCanvasElement, p: PageSettings, wks: unknown): void {
  const c = cv.getContext("2d"); if (!c) return;
  const fmt = PAPER_FORMATS.find((f) => f.type === p.paper) || PAPER_FORMATS[1];
  let w = p.paper === "User" ? p.width : fmt.w, hh = p.paper === "User" ? p.height : fmt.h; if (p.portrait && p.paper !== "User") [w, hh] = [hh, w];
  const W = cv.width, H = cv.height, s = Math.min((W - 12) / w, (H - 12) / hh), x0 = Math.round((W - w * s) / 2), y0 = Math.round((H - hh * s) / 2);
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H);
  // the page: white, with a shadow line as KiCad's preview bitmap has
  c.fillStyle = "#808080"; c.fillRect(x0 + 2, y0 + 2, w * s, hh * s);
  c.fillStyle = "#ffffff"; c.fillRect(x0, y0, w * s, hh * s);
  const cur = E.kdoc as (KDoc & Record<string, unknown>) | null;
  const tb: Record<string, string> = { title: p.title, date: p.date, rev: p.rev, company: p.company };
  p.comments.forEach((v, i) => { tb["comment" + (i + 1)] = v; });
  const doc = { ...(cur || {}), type: isSch() ? "sch" : "pcb", items: new Map(), page: [w, hh], paper: p.paper, portrait: p.portrait, titleBlock: tb, drawingSheet: wks || null } as unknown as KDoc;
  const api = KiCadCanvas as unknown as { drawDrawingSheet?(ctx: CanvasRenderingContext2D, doc: KDoc, s: number, minW: number, pageLimits?: boolean): void };
  if (!api.drawDrawingSheet) return;
  c.save(); c.setTransform(s, 0, 0, s, x0, y0);
  try { api.drawDrawingSheet(c, doc, s, 1 / s, false); } catch (e) { console.warn("page preview", e); }
  c.restore();
}

export function openPageSettings(): void {
  const doc = E.kdoc as KDoc & { sheetCount?: number; pageNumber?: string; paper?: string; portrait?: boolean; titleBlock?: Record<string, string> } | null;
  if (!doc) return;
  const ro = !!E.viewOnly, sch = isSch(), p = pageSettingsOf(doc), exportTo = new Set<TbKey>(); let exportPaper = false;
  const others = sch ? projectDocs().filter((d) => d.docType === "kicad_sch" && d.docId !== (currentDocEntry() || { docId: "" }).docId) : [];
  // the custom size is in the editor's own units (m_customSizeX / Y are UNIT_BINDERs)
  const units = loadUnits(sch ? "eeschema" : "pcbnew").units;
  // the drawing sheet file (BASE_SCREEN::m_DrawingSheetFileName, kept in the project file)
  const wksName0 = drawingSheetName(E.proSettings as string | null, sch), sheets = projectWorksheets();
  let wksName = wksName0;
  const wksDoc = (): unknown => { const ws = resolveWorksheet(wksName, sheets); return ws ? worksheetNow(ws.docId) : null; };
  let preview: HTMLCanvasElement | null = null; const redraw = () => { if (preview) drawPreview(preview, p, wksDoc()); };
  let wF: ReturnType<typeof lenField> | null = null, hF: ReturnType<typeof lenField> | null = null;
  KD().open({ title: "Page Settings", width: 820, cls: "kd-wide", readOnly: ro,
    build(body) {
      const custom = () => p.paper === "User";
      wF = lenField(p.width, { units, key: "userSizeX", onChange: (v) => { p.width = v; redraw(); } });
      hF = lenField(p.height, { units, key: "userSizeY", onChange: (v) => { p.height = v; redraw(); } });
      const wIn = wF.input as HTMLInputElement, hIn = hF.input as HTMLInputElement; wIn.id = "kd-ps-width"; hIn.id = "kd-ps-height";
      wIn.disabled = hIn.disabled = ro || !custom();
      const orient = select(["Landscape", "Portrait"], p.portrait ? "Portrait" : "Landscape", (v) => { p.portrait = v === "Portrait"; redraw(); }, { id: "kd-ps-orient", disabled: ro || custom() });
      // a standard paper shows its nominal size in the (disabled) custom fields, as the desktop dialog does
      const showSize = () => { if (custom()) return; const f = PAPER_FORMATS.find((x) => x.type === p.paper); if (!f) return; p.width = p.portrait ? f.h : f.w; p.height = p.portrait ? f.w : f.h; wF!.set(p.width); hF!.set(p.height); };
      orient.addEventListener("change", showSize);
      const size = select(PAPER_FORMATS.map((f) => [f.type, f.label] as [string, string]), p.paper, (v) => {
        p.paper = v; const c = custom(); wIn.disabled = hIn.disabled = ro || !c; orient.disabled = ro || c; if (c) { p.portrait = false; orient.value = "Landscape"; } showSize(); redraw(); }, { id: "kd-ps-size", disabled: ro });
      showSize();
      const uname = unitName(units);
      // Drawing Sheet: m_textCtrlFilePicker and m_browseButton (small_folder); in the browser the files to pick
      // from are the project's own .kicad_wks documents (OnWksFileSelection), "(KiCad default)" clears it
      const file = textInput(wksName, (v) => { wksName = v.trim(); redraw(); }, { id: "kd-ps-wks", disabled: ro, placeholder: "(KiCad default)" });
      file.style.flex = "1"; file.style.minWidth = "0";
      const browse = bitmapButton("small_folder", "Select Drawing Sheet File", () => {
        const items = [["", "(KiCad default)"], ...sheets.map((x) => [x.rel, x.rel])];
        listDialog("Select Drawing Sheet File", ["Drawing sheet files (*.kicad_wks)"], items.map((r) => [r[1]]), (row) => {
          const hit = items.find((r) => r[1] === row[0]); wksName = hit ? hit[0] : ""; file.value = wksName; redraw();
        }, { select: wksName || "(KiCad default)", listLabel: "Drawing sheets in this project:", child: true });
      }, { id: "kd-ps-wksbrowse", disabled: ro });
      const left = h("div", { style: "width:250px;flex:none" },
        h("h3", null, "Paper"),
        h("div", { style: "display:grid;gap:4px" }, h("label", null, "Size:"), size, h("label", { style: "margin-top:6px" }, "Orientation:"), orient,
          h("label", { style: "margin-top:6px" }, "Custom paper size:"),
          h("div", { class: "kv", style: "grid-template-columns:max-content 1fr max-content" }, h("label", { for: "kd-ps-height" }, "Height:"), hIn, h("span", { class: "ro" }, uname), h("label", { for: "kd-ps-width" }, "Width:"), wIn, h("span", { class: "ro" }, uname))),
        others.length ? checkbox("Export to other sheets", false, (on) => { exportPaper = on; }, { disabled: ro, id: "kd-ps-export-paper" }) : null,
        h("h3", null, "Preview"), (preview = h("canvas", { width: 240, height: 172, id: "kd-ps-preview", style: "border:1px solid var(--line);background:var(--panel);display:block" })),
        h("h3", null, "Drawing Sheet"), h("div", { class: "kd-row", style: "gap:4px" }, h("label", { for: "kd-ps-wks" }, "File:"), file, browse));
      const tb = h("div", { class: "kv", style: `grid-template-columns:max-content 1fr${others.length ? " max-content" : ""};align-items:center` });
      for (const [k, label] of ROWS) {
        const inp = textInput(getTb(p, k), (v) => { setTb(p, k, v); redraw(); }, { id: "kd-ps-" + k, disabled: ro });
        let ctl: HTMLElement = inp;
        if (k === "date") {
          inp.style.flex = "1"; inp.style.minWidth = "90px";
          // m_PickDate (wxDatePickerCtrl, today) and m_ApplyDate "<<<", which copies it as FormatISODate
          const pick = datePicker(isoDate(new Date()), { id: "kd-ps-datepick", disabled: ro });
          const set = h("button", { class: "btn sm", type: "button", title: "Use the date on the right", disabled: ro, id: "kd-ps-dateset", onclick: () => { const v = pick.value || isoDate(new Date()); inp.value = v; setTb(p, k, v); } }, "<<<");
          ctl = h("div", { class: "kd-row" }, inp, set, pick.el);
        }
        tb.append(h("label", null, label), ctl);
        if (others.length) tb.append(checkbox("Export to other sheets", false, (on) => { if (on) exportTo.add(k); else exportTo.delete(k); }, { disabled: ro }));
      }
      const right = h("div", { style: "flex:1;min-width:0" }, h("h3", null, "Title Block"),
        h("div", { class: "kd-row", style: "justify-content:space-between;margin-bottom:8px;color:var(--ink-2)" }, h("span", null, `Number of sheets: ${doc.sheetCount || 1}`), h("span", null, `Sheet number: ${doc.pageNumber || "1"}`)), tb);
      body.append(h("div", { style: "display:flex;gap:22px" }, left, right)); redraw();
      // DIALOG_PAGES_SETTINGS reads the sheet file when it opens: read the project's sheet files again, and draw the
      // preview again whenever one comes in (still loading, or changed by a collaborator while the dialog is up)
      const off = onWorksheetChange(() => { if (preview && preview.isConnected) redraw(); else off(); });
      for (const ws of sheets) forgetWorksheet(ws.docId);
    },
    ok() {
      if (ro) return;
      if (p.paper === "User" && wF && hF) {
        p.width = wF.get(); p.height = hF.get();
        for (const [label, mm, f] of [["Width", p.width, wF], ["Height", p.height, hF]] as const) {
          const err = pageSizeError(label, mm, sch, units as "mm" | "mil" | "in");
          if (err) { messageBox("Error", err); (f.input as HTMLInputElement).focus(); (f.input as HTMLInputElement).select(); return false; }
        }
      }
      // the drawing sheet file is the project's (LocalPrjConfigChanged): saved in the .kicad_pro
      if (wksName !== wksName0) {
        const [a, b] = wksKey(sch);
        void saveProject((pro) => { sub(pro, a)[b] = wksName; }, "drawing sheet file").then(() => { if (E.kdoc) { applyDrawingSheet(E.kdoc as KDoc & { drawingSheet?: unknown }); requestRender(); } },
          (e: Error) => toast("The drawing sheet file was not saved: " + e.message, 4000));
      }
      const changed = commitPageSettings(p);
      if (changed) toast("Page settings updated");
      if (others.length && (exportTo.size || exportPaper)) {
        const keys = [...exportTo], withPaper = exportPaper;
        Promise.all(others.map(async (d) => {
          const od = await readDoc(d.docId, "kicad_sch"); const op = pageSettingsOf(od as unknown as Parameters<typeof pageSettingsOf>[0]);
          for (const k of keys) setTb(op, k, getTb(p, k));
          if (withPaper) { op.paper = p.paper; op.portrait = p.portrait; op.width = p.width; op.height = p.height; }
          await submitDocOp(d.docId, [pageSettingsChange(op)]);
        })).then(() => toast(`Exported to ${others.length} other sheet${others.length === 1 ? "" : "s"}`), (e: Error) => toast("Export to other sheets failed: " + e.message, 4000));
      }
    } });
}
