// editor/drawingsheet.ts — the project's drawing sheet file (BASE_SCREEN::m_DrawingSheetFileName, saved in the
// .kicad_pro as schematic.page_layout_descr_file / pcbnew.page_layout_descr_file): which .kicad_wks of the project
// a document's page frame is drawn from.  An empty name (or one not in the project) is KiCad's built-in sheet.
import { E } from "./state";
import { state } from "./appstore";
import { requestRender } from "./view";

import { drawingSheetName, projectWorksheets as worksheetsOf, resolveWorksheet, type WksDocEntry } from "./drawingsheet-model";
export { drawingSheetName, resolveWorksheet, wksKey } from "./drawingsheet-model";
/** The open project's drawing sheet files. */
export const projectWorksheets = (): { docId: string; rel: string }[] => worksheetsOf((state as unknown as { docs?: WksDocEntry[] }).docs || []);

/** Each fetched sheet file: its text (to tell a changed file from the same one) and the parsed sheet. */
const cache = new Map<string, { text: string; sheet: unknown }>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
/** Fetch a sheet file afresh; a text that changed replaces the parsed sheet and redraws whatever shows it. */
function load(docId: string): void {
  if (loading.has(docId)) return;
  loading.add(docId);
  fetch(`/api/docs/${docId}/content?v=${Date.now()}`, { credentials: "same-origin", cache: "no-store" }).then((r) => (r.ok ? r.text() : "")).then((t) => {
    loading.delete(docId);
    const was = cache.get(docId);
    if (was && was.text === t) return;
    let sheet: unknown = null; try { sheet = t ? KiCadCanvas.parseDrawingSheet(t) : null; } catch (e) { sheet = null; }
    cache.set(docId, { text: t, sheet });
    if (E.kdoc) { applyDrawingSheet(E.kdoc as KDoc & { drawingSheet?: unknown }); requestRender(); }
    for (const fn of listeners) fn();
  }, () => { loading.delete(docId); if (!cache.has(docId)) cache.set(docId, { text: "", sheet: null }); });
}
/** The parsed drawing sheet of a project document, fetched once (null while it loads). */
function sheetOf(docId: string): unknown {
  const c = cache.get(docId);
  if (c) return c.sheet;
  load(docId);
  return null;
}
/**
 * Read a sheet file again (the file changed, or may have): the one named, or every one fetched.  The sheet in use
 * stays on the canvas until the new text is in, and nothing is redrawn when the text is the same.
 */
export function forgetWorksheet(docId?: string): void { for (const id of docId ? [docId] : [...cache.keys()]) load(id); }
/** Called whenever a sheet file's new text comes in (Page Settings' preview); returns the unsubscribe. */
export function onWorksheetChange(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
if (typeof window !== "undefined") {
  // the server's "saved" notice goes to every open document of the project: a collaborator saved that sheet file
  window.addEventListener("kc-doc-saved", ((ev: CustomEvent) => {
    const id = ev.detail && String(ev.detail.savedDocId || ev.detail.docId || "");
    if (id && cache.has(id)) forgetWorksheet(id);
  }) as EventListener);
  // a file written without a save notice (a snapshot upload, the desktop sync) is seen when the tab is shown again
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && cache.size) forgetWorksheet(); });
}

/** Put the project's drawing sheet on a document (or KiCad's default when it names none, or it cannot be had). */
export function applyDrawingSheet(d: KDoc & { drawingSheet?: unknown }): void {
  const sch = d.type === "sch";
  const ws = resolveWorksheet(drawingSheetName(E.proSettings as string | null, sch), projectWorksheets());
  d.drawingSheet = ws ? sheetOf(ws.docId) : null;
}
/** The parsed sheet of a project worksheet when it has loaded (Page Settings' preview), loading it otherwise. */
export function worksheetNow(docId: string): unknown { return sheetOf(docId); }
