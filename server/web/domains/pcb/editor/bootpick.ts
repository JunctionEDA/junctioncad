// bootpick.ts — which document a project opens on.  Pure, so the page's early loader (boot.ts) can ask for that
// document while the editor's scripts are still downloading, and the editor (doc.ts) decides the same way.

export interface BootDoc { docId: string; path: string; docType: string }

/** The documents the editor shows: boards first, then schematics by path. */
export function editorDocs<T extends BootDoc>(docs: T[]): T[] {
  return docs.filter((d) => d.docType === "kicad_pcb" || d.docType === "kicad_sch")
    .sort((a, b) => (a.docType === "kicad_pcb" ? 0 : 1) - (b.docType === "kicad_pcb" ? 0 : 1) || a.path.localeCompare(b.path));
}

/**
 * The root sheet: the schematic named like the project file, else the one highest in the folder tree
 * (a top-level sheet beats a nested one).  `shown` is editorDocs(), `all` every document of the project.
 */
export function rootSchematicOf<T extends BootDoc>(shown: T[], all: BootDoc[]): T | undefined {
  const sch = shown.filter((d) => d.docType === "kicad_sch");
  const pro = all.find((d) => d.docType === "kicad_pro");
  const stem = pro && pro.path.split("/").pop()!.replace(/\.kicad_pro$/, "");
  return sch.find((d) => d.path.split("/").pop() === stem + ".kicad_sch")
    || sch.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.length - b.path.length)[0];
}

/**
 * A project opens on its root schematic, where a design starts and where KiCad's own project manager
 * leads first; the board is one click away (and ?doc= still opens exactly what a link names).  Only a
 * project with no schematic at all opens on the board.
 */
export function firstDoc<T extends BootDoc>(shown: T[], all: BootDoc[], wanted: string | null): T | null {
  return shown.find((d) => d.docId === wanted) || rootSchematicOf(shown, all) || shown.find((d) => d.docType === "kicad_pcb") || null;
}

/** localStorage: the documents (and projects that open on one) this browser has seen to be boards, space separated. */
export const BOARD_HINT = "kui.boardDocs";

/** A top-level sheet of the schematic (TOP_LEVEL_SHEET_INFO): its document, its name and the sheet uuid its
 *  symbols' instance paths start with ("" when the project file gives none: the file's own uuid). */
export interface TopLevelSheet<T> { doc: T; name: string; uuid: string }
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * SCHEMATIC::GetTopLevelSheets for the browser: the project file's schematic.top_level_sheets, in their order,
 * each resolved to its document (SCHEMATIC::TopLevelSheetFile: the filename beside the project file).  A KiCad 10
 * project may have several (an Altium project imports one per SchDoc); one without the list has the single root
 * sheet rootSchematicOf finds, named "Root" as SCH_EDIT_FRAME::OpenProjectFiles names it.  Entries whose file is
 * not in the project are skipped, as files-io.cpp skips a missing file.
 */
export function topLevelSheetsOf<T extends BootDoc>(pro: unknown, shown: T[], all: BootDoc[]): TopLevelSheet<T>[] {
  const sch = pro && typeof pro === "object" ? (pro as { schematic?: { top_level_sheets?: unknown } }).schematic : undefined;
  const list = sch && Array.isArray(sch.top_level_sheets) ? sch.top_level_sheets as { filename?: unknown; name?: unknown; uuid?: unknown }[] : [];
  const proDoc = all.find((d) => d.docType === "kicad_pro");
  const dir = proDoc ? proDoc.path.split("/").slice(0, -1).join("/") : "";
  const out: TopLevelSheet<T>[] = [];
  for (const e of list) {
    if (!e || typeof e.filename !== "string" || !e.filename) continue;
    const parts = [...(dir ? dir.split("/") : []), ...e.filename.replace(/\\/g, "/").split("/")].filter((p) => p && p !== ".");
    const norm: string[] = []; for (const p of parts) { if (p === "..") norm.pop(); else norm.push(p); }
    const path = norm.join("/");
    const doc = shown.find((d) => d.docType === "kicad_sch" && d.path === path);
    if (!doc || out.some((o) => o.doc === doc)) continue;
    out.push({ doc, name: typeof e.name === "string" ? e.name : "", uuid: typeof e.uuid === "string" && e.uuid !== NIL_UUID ? e.uuid : "" });
  }
  if (out.length) return out;
  const root = rootSchematicOf(shown, all);
  return root ? [{ doc: root, name: "Root", uuid: "" }] : [];
}
