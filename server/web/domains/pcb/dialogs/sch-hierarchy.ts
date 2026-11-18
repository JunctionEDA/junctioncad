// dialogs/sch-hierarchy — SCH_SHEET_LIST for the browser: every sheet instance of the project's schematic,
// from the root through each (sheet …) symbol, with the human-readable path ("/", "/Power/"), the page number
// its parent's instance data gives it, and the document, read once and given the drawing-sheet context
// (${SHEETPATH}, ${SHEETNAME}, ${#}, ${##}) eeschema would show on that page.  Sorted by page number like
// SCH_SHEET_LIST::SortByPageNumbers.  The open sheet is the live document, unsaved edits included.
import { E, appState, type DocEntry } from "./editor";
import { readDoc } from "./project";
import * as docMod from "../editor/doc";
import { repairPageNumbers, type PageSheet } from "../sim/sheet-pages";

export interface SheetInstance { docId: string; path: string; name: string; sheetPath: string; page: string; doc: KDoc; uuidPath: string[]; sheetItemId: string | null; parentDocId: string | null }

const topLevelSchematics = docMod.topLevelSchematics as () => { doc: DocEntry; name: string; uuid: string }[];
const projectTextVars = docMod.projectTextVars as () => Record<string, string> | null;
const ROOT_SHEET_NAME = docMod.ROOT_SHEET_NAME as string;

/** The sheet list (root first, then by page number). */
export async function sheetList(): Promise<SheetInstance[]> {
  const S = appState as unknown as { docs: DocEntry[]; docId: string | null; project: { name: string } | null };
  const tops = topLevelSchematics(); if (!tops.length) return [];
  const multi = tops.length > 1;
  const cache = new Map<string, KDoc>();
  const load = async (d: DocEntry): Promise<KDoc> => {
    if (d.docId === S.docId && E.kdoc) return E.kdoc;
    let doc = cache.get(d.docId); if (!doc) { doc = await readDoc(d.docId, "kicad_sch"); cache.set(d.docId, doc); }
    return doc;
  };
  const out: SheetInstance[] = [];
  const walk = async (d: DocEntry, name: string, sheetPath: string, page: string, uuidPath: string[], sheetItemId: string | null, parentDocId: string | null, depth: number): Promise<void> => {
    if (depth > 32) return;   // a recursive hierarchy: KiCad refuses it, we stop
    let doc: KDoc; try { doc = await load(d); } catch (e) { return; }
    out.push({ docId: d.docId, path: d.path, name, sheetPath, page, doc, uuidPath, sheetItemId, parentDocId });
    pageKeys.push({ uuids: [topUuid || String((doc as KDoc & { uuid?: string }).uuid || "")].concat(uuidPath), page: depth === 0 && !pageFromFile ? "" : page, virt: virt++ });
    const dir = d.path.split("/").slice(0, -1).join("/");
    for (const m of KiCadCanvas.movableItems(doc)) {
      if (m.kind !== "sheet" || !m.file) continue;
      const rel = dir ? `${dir}/${m.file}` : m.file;
      const child = S.docs.find((x) => x.docType === "kicad_sch" && x.path === rel) || S.docs.find((x) => x.docType === "kicad_sch" && x.path.split("/").pop() === m.file!.split("/").pop());
      if (!child) continue;
      const nm = m.name || m.file.replace(/\.kicad_sch$/, "");
      await walk(child, nm, sheetPath + nm + "/", m.page || "", uuidPath.concat(m.id), m.id, d.docId, depth + 1);
    }
  };
  // each top-level sheet (SCHEMATIC::GetTopLevelSheets), its page its own file's (sheet_instances (path "/" (page …))); with
  // several, the path starts with the top-level sheet's name and uuidPath stays below it, as KIID paths leave it out
  const pageKeys: PageSheet[] = []; let virt = 1, topUuid = "", pageFromFile = true;
  for (const t of tops) {
    const d = t.doc, livePage = E.kdoc && S.docId === d.docId ? (E.kdoc as KDoc & { pageNumber?: string }).pageNumber : "";
    let page = livePage || "";
    if (!page && multi) { try { page = String((await load(d) as KDoc & { pageNumber?: string }).pageNumber || ""); } catch (e) { page = ""; } }
    virt = 1; topUuid = t.uuid; pageFromFile = !!page;
    await walk(d, multi ? t.name : ROOT_SHEET_NAME, multi ? "/" + t.name + "/" : "/", page || "1", [], null, null, 0);
  }
  if (multi) {
    // SCHEMATIC::BuildSheetListSortedByPageNumbers, then RepairPageNumbers: the order and pages eeschema shows
    const { pages } = repairPageNumbers(pageKeys);
    out.forEach((x, i) => { x.page = pages[i]; });
    // the list re-sorted on the repaired pages (SCHEMATIC::RefreshHierarchy)
    const { order } = repairPageNumbers(pageKeys.map((k, i) => ({ ...k, page: pages[i] })));
    return order.map((i) => out[i]);
  }
  // pages without a number keep their place after the numbered ones (the first top-level sheet stays first)
  const num = (p: string): number => { const n = parseInt(p, 10); return isFinite(n) ? n : Infinity; };
  const rest = out.slice(1).map((s, i) => ({ s, i })).sort((a, b) => num(a.s.page) - num(b.s.page) || a.i - b.i).map((x) => x.s);
  const list = [out[0], ...rest];
  list.forEach((s, i) => { if (!s.page) s.page = String(i + 1); });
  return list;
}

/** A copy of an instance's document with the drawing-sheet context of that page (the live one is not touched). */
export function withSheetContext(s: SheetInstance, count: number): KDoc {
  const S = appState as unknown as { project: { name: string } | null };
  const d = Object.create(s.doc) as KDoc & Record<string, unknown>;
  d.fileName = s.path.split("/").pop(); d.filePath = s.path; d.projectName = S.project ? S.project.name : "";
  d.projectVars = projectTextVars(); d.sheetName = s.name; d.sheetPath = s.sheetPath; d.sheetCount = count; d.pageNumber = s.page;
  return d;
}
