// editor/drawingsheet-model.ts — the pure part of editor/drawingsheet.ts: where the project file names the drawing
// sheet and which project document that name points at.

export interface WksDocEntry { docId: string; docType: string; path: string }
/** The project file's key for an editor's drawing sheet. */
export const wksKey = (sch: boolean): [string, string] => (sch ? ["schematic", "page_layout_descr_file"] : ["pcbnew", "page_layout_descr_file"]);

/** The drawing sheet file named in a project file (its JSON), "" when none. */
export function drawingSheetName(pro: string | null | undefined, sch: boolean): string {
  if (!pro) return "";
  try { const j = JSON.parse(pro) as Record<string, Record<string, unknown> | undefined>; const [a, b] = wksKey(sch); const v = j[a] && j[a]![b]; return typeof v === "string" ? v : ""; } catch { return ""; }
}

/** The project's drawing sheet files (docType "worksheet"), with their paths relative to the project's folder. */
export function projectWorksheets(docs: WksDocEntry[]): { docId: string; rel: string }[] {
  const pro = docs.find((d) => d.docType === "kicad_pro"), dir = pro ? pro.path.split("/").slice(0, -1).join("/") : "";
  return docs.filter((d) => d.docType === "worksheet").map((d) => ({ docId: d.docId, rel: dir && d.path.startsWith(dir + "/") ? d.path.slice(dir.length + 1) : d.path }));
}

/**
 * The project document a drawing sheet name points at: a path relative to the project ("sheets/a.kicad_wks"), the
 * same behind ${KIPRJMOD}/, or an absolute path that ends in one of the project's files.  Null for none.
 */
export function resolveWorksheet(name: string, sheets: { docId: string; rel: string }[]): { docId: string; rel: string } | null {
  const n = (name || "").replace(/\\/g, "/").replace(/^\$\{KIPRJMOD\}\//, "").replace(/^\.\//, "").trim();
  if (!n) return null;
  return sheets.find((s) => s.rel === n) || sheets.find((s) => n.endsWith("/" + s.rel)) || null;
}

