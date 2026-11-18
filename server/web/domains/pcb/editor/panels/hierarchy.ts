// panels/hierarchy.ts — the Schematic Hierarchy navigator's model (eeschema/widgets/hierarchy_pane.cpp): the
// tree of sheets with their names and page numbers.  eeschema has every sheet loaded; the browser has one
// document open, so the other sheet files are read (and cached, parsed) to follow their (sheet …) symbols.
// The same cache gives the Search pane its other sheets.  Rename / Edit Page Number edit the sheet symbol in
// the PARENT sheet — where KiCad keeps the Sheetname field and the instance's page — as an ordinary op.
import type { HierNode, PanelAction } from "../../panels-api";
import { store } from "../appstore";
import { requestRender } from "../view";
import { enterSheet, openDoc, publishDocs, rootSchematic, topLevelSchematics, topLevelSheetsChanged } from "../doc";
import { E } from "../state";
import { api, toast } from "../util";
import { selectionIds } from "../gestures";
import { applyHighlight, preferInstance } from "../schnets";
import { loadProject, onProjectChanged, projectJson, saveProject, sub } from "../../dialogs/project";
import { confirmBox } from "../../dialogs/dom";
import { commitRootPage } from "../../dialogs/page-settings";
import { repairPageNumbers, type PageSheet } from "../../sim/sheet-pages";
import { KC, currentDocId, isSchDoc, kdoc, openDocs, panelStore, projectId, projectName, textEntry, type DocEntryLite, tctx } from "./core";

interface SheetRef { id: string; name: string; file: string; page: string }
interface SheetDoc { doc: KDoc; sheets: SheetRef[]; page: string }

const cache = new Map<string, SheetDoc>();   // docId -> parsed sheet (not the open one: that is always read live)
let cacheProject = "";
let loading: Promise<void> | null = null;
let live: { docId: string; doc: KDoc } | null = null;   // the sheet on screen, as last read: kept when another sheet opens

function sheetsOf(doc: KDoc): SheetRef[] {
  const out: SheetRef[] = [];
  for (const m of KC().movableItems(doc)) if (m.kind === "sheet" && m.file) out.push({ id: m.id, name: m.name || "", file: m.file, page: String((m as { page?: string }).page || "") });
  return out;
}
function entry(docId: string): SheetDoc | null {
  if (docId === currentDocId()) { const d = kdoc(); if (!d || !isSchDoc()) return null; live = { docId, doc: d }; return { doc: d, sheets: sheetsOf(d), page: String((d as unknown as { pageNumber?: string }).pageNumber || "1") }; }
  return cache.get(docId) || null;
}
/** A parsed sheet of the project by document id (the open one live, the others from the cache). */
export function sheetDoc(docId: string): KDoc | null { const e = entry(docId); return e ? e.doc : null; }
export function schDocs(): DocEntryLite[] { return openDocs().filter((d) => d.docType === "kicad_sch"); }

/** Read the sheets that are not open (again after `stale`), then rebuild the tree. */
export function loadSheets(stale?: string | null): Promise<void> {
  if (cacheProject !== projectId()) { cache.clear(); cacheProject = projectId(); }
  if (stale) {   // the sheet that was just left: what was on screen is newer than what the server would send back right now
    if (live && live.docId === stale && stale !== currentDocId()) cache.set(stale, { doc: live.doc, sheets: sheetsOf(live.doc), page: String((live.doc as unknown as { pageNumber?: string }).pageNumber || "1") });
    else cache.delete(stale);
  }
  const want = schDocs().filter((d) => d.docId !== currentDocId() && !cache.has(d.docId));
  if (!want.length) { publishHierarchy(); return Promise.resolve(); }
  if (loading) return loading;
  const pid = projectId();
  loading = Promise.all(want.map(async (d) => {
    try {
      const r = await fetch(`/api/docs/${d.docId}/content?v=${Date.now()}`); if (!r.ok) return;
      const doc = KC().parseDoc(await r.text(), "kicad_sch");
      if (pid === projectId()) cache.set(d.docId, { doc, sheets: sheetsOf(doc), page: String((doc as unknown as { pageNumber?: string }).pageNumber || "1") });
    } catch (e) { /* unreadable sheet: it shows without children */ }
  })).then(() => { loading = null; publishHierarchy(); });
  return loading;
}

function resolveChild(parent: DocEntryLite, file: string): DocEntryLite | null {
  const dir = parent.path.split("/").slice(0, -1).join("/"), rel = dir ? `${dir}/${file}` : file, base = file.split("/").pop();
  const docs = schDocs();
  return docs.find((d) => d.path === rel || d.path === file) || docs.find((d) => d.path.split("/").pop() === base) || null;
}

/** The pages eeschema shows once the schematic is loaded (RepairPageNumbers: a page stored twice, like the "#" every
 *  top-level sheet of an Altium import has, is renumbered), written onto the tree's nodes. */
function repairPages(tree: HierNode, topUuid: (n: HierNode) => string): HierNode {
  const nodes: HierNode[] = [], list: PageSheet[] = [];
  const walk = (n: HierNode, uuids: string[], virt: { n: number }): void => {
    nodes.push(n); list.push({ uuids, page: n.page, virt: virt.n++ });
    for (const c of n.children) walk(c, uuids.concat(c.sheetId || ""), virt);
  };
  for (const top of tree.virtual ? tree.children : [tree]) walk(top, [topUuid(top)], { n: 1 });
  const { pages } = repairPageNumbers(list);
  nodes.forEach((n, i) => { n.page = pages[i]; });
  return tree;
}
const fileUuid = (docId: string | null): string => { const e = docId ? entry(docId) : null; return String((e && (e.doc as unknown as { uuid?: string }).uuid) || ""); };

function build(): HierNode | null {
  const root = (store.get().project ? rootSchematic() : null) as DocEntryLite | null; if (!root) return null;
  const cur = currentDocId();
  const rootEntry = entry(root.docId);
  const stem = root.path.split("/").pop()!.replace(/\.kicad_sch$/, "");
  const walk = (doc: DocEntryLite, path: string, depth: number): HierNode[] => {
    const e = entry(doc.docId); if (!e || depth > 8) return [];
    return e.sheets.map((sh) => {
      const child = resolveChild(doc, sh.file); const p = path + sh.id + "/";
      return { path: p, name: sh.name || sh.file.replace(/\.kicad_sch$/, ""), page: sh.page, docId: child ? child.docId : null, file: sh.file, parentDocId: doc.docId, sheetId: sh.id,
        current: !!child && child.docId === cur, children: child ? walk(child, p, depth + 1) : [] };
    });
  };
  // the project root itself is hidden (wxTR_HIDE_ROOT): the tree starts at the top-level sheets, each named by its
  // schematic.top_level_sheets entry, else by its file (HIERARCHY_PANE::UpdateHierarchyTree)
  const tops = topLevelSchematics();
  if (tops.length > 1) {
    const children = tops.map((t): HierNode => {
      const d = t.doc as unknown as DocEntryLite, e = entry(d.docId), p = "/" + (t.uuid || d.docId) + "/";
      return { path: p, name: t.name || d.path.split("/").pop()!.replace(/\.kicad_sch$/, ""), page: e ? e.page : "", docId: d.docId, file: d.path.split("/").pop() || "", parentDocId: null, sheetId: null,
        current: d.docId === cur, children: walk(d, p, 0), topLevel: true };
    });
    const uuidOf = new Map(tops.map((t) => [t.doc.docId, t.uuid]));
    return repairPages({ path: "", name: projectName() || "Schematic", page: "", docId: null, file: "", parentDocId: null, sheetId: null, current: false, children, virtual: true },
      (n) => uuidOf.get(n.docId || "") || fileUuid(n.docId));
  }
  const tl = topLevelEntry(root.path);
  return repairPages({ path: "/", name: (tl && typeof tl.name === "string" && tl.name) || stem || projectName() || "Schematic", page: rootEntry ? rootEntry.page : "1", docId: root.docId, file: root.path.split("/").pop() || "", parentDocId: null, sheetId: null,
    current: root.docId === cur, children: walk(root, "/", 0) }, () => fileUuid(root.docId));
}

export function publishHierarchy(): void {
  let root: HierNode | null = null;
  try { root = build(); } catch (e) { console.warn(e); }
  // the top-level sheet on screen shows its repaired page in the title block's ${#}, as eeschema does after loading
  const d = kdoc() as (KDoc & { pageNumber?: string }) | null, cur = root && root.virtual ? root.children.find((c) => c.current) : null;
  if (d && cur && cur.page && d.pageNumber !== cur.page) { d.pageNumber = cur.page; requestRender(); }
  const h = panelStore.get().hierarchy;
  panelStore.set({ hierarchy: { root, version: h.version + 1, marked: h.marked, markColor: h.markColor } });
}

/** The human sheet path of a tree path ("/" for the root, "/Sub/Inner/" below it), as the net map names instances;
 *  with several top-level sheets the top-level sheet's name comes first ("/Top/Sub/"). */
function humanOf(path: string): string {
  const root = panelStore.get().hierarchy.root;
  if (!root || path === "/") return "/";
  const chain: HierNode[] = [];
  const walk = (n: HierNode): boolean => { if (n.path === path) return true; for (const c of n.children) { chain.push(c); if (walk(c)) return true; chain.pop(); } return false; };
  if (!walk(root)) return "/";
  return "/" + chain.map((n) => n.name + "/").join("");
}
function find(path: string): HierNode | null {
  const walk = (n: HierNode | null): HierNode | null => { if (!n) return null; if (n.path === path) return n; for (const c of n.children) { const r = walk(c); if (r) return r; } return null; };
  return walk(panelStore.get().hierarchy.root);
}

/** The page number each hierarchy path carries, by document id (the Search pane's Page column). */
export function pageOfDoc(docId: string): string {
  const walk = (n: HierNode | null): string | null => { if (!n) return null; if (n.docId === docId) return n.page; for (const c of n.children) { const r = walk(c); if (r) return r; } return null; };
  return walk(panelStore.get().hierarchy.root) || "";
}

/** Edit a sheet symbol where it lives: open its parent sheet if another one is on screen, then commit. */
async function editSheetSymbol(node: HierNode, label: string, edit: (n: SNode) => boolean | void): Promise<void> {
  if (!node.parentDocId || !node.sheetId) return;
  if (E.viewOnly) { toast("View-only access"); return; }
  if (currentDocId() !== node.parentDocId) {
    const parent = schDocs().find((d) => d.docId === node.parentDocId); if (!parent) return;
    await openDoc(parent);
  }
  const doc = kdoc(), it = doc ? doc.items.get(node.sheetId) : null;
  if (!doc || !it) { toast("That sheet is not on this page any more"); return; }
  const n = KC().cloneNode(it.node);
  if (edit(n) === false) return;
  tctx().commit([KC().replaceChange(doc, Object.assign({}, it, { node: n, geom: [], bbox: null }))], label);
  publishHierarchy();
}

function setSheetName(n: SNode, name: string): boolean {
  const K = KC();
  for (const p of K.kids(n, "property")) if (K.str(p[1]) === "Sheetname" || K.str(p[1]) === "Sheet name") { if (K.str(p[2]) === name) return false; p[2] = name; return true; }
  return false;
}
function setSheetPage(n: SNode, page: string): boolean {
  const K = KC(); const inst = K.kid(n, "instances"); if (!inst) return false;
  let changed = false;
  for (const proj of K.kids(inst, "project")) for (const path of K.kids(proj, "path")) {
    const pg = K.kid(path, "page");
    if (pg) { if (K.str(pg[1]) !== page) { pg[1] = page; changed = true; } } else { path.push(["page", page]); changed = true; }
  }
  return changed;
}

/** The project file's schematic.top_level_sheets entry (TOP_LEVEL_SHEET_INFO) for this root schematic file. */
function topLevelEntry(file: string, pro: Record<string, unknown> = projectJson()): Record<string, unknown> | null {
  const sch = pro.schematic as Record<string, unknown> | undefined, list = sch && Array.isArray(sch.top_level_sheets) ? sch.top_level_sheets as Record<string, unknown>[] : [];
  const base = file.split("/").pop();
  return list.find((e) => e && (e.filename === file || e.filename === base)) || null;
}
/**
 * HIERARCHY_PANE's Rename, then renameSheet: a sub-sheet's Sheetname field in its parent sheet; a top-level sheet's
 * name, which SCH_EDIT_FRAME::SaveProjectLocalSettings keeps in the project file's schematic.top_level_sheets.
 */
async function rename(path: string): Promise<void> {
  const node = find(path); if (!node) return;
  const name = await textEntry("Rename", "Change name of this sheet", node.name); if (name === null) return;
  const nm = name.trim(); if (!nm || nm === node.name) return;
  if (node.sheetId) { await editSheetSymbol(node, "renaming sheet", (n) => setSheetName(n, nm)); return; }
  if (E.viewOnly) { toast("View-only access"); return; }
  // the top-level sheet renamed: the one this row stands for (one of several), else the root sheet
  const root = ((node.docId && schDocs().find((d) => d.docId === node.docId)) || (store.get().project ? rootSchematic() : null)) as DocEntryLite | null; if (!root) return;
  try {
    await saveProject((pro) => {
      const list = sub(pro, "schematic").top_level_sheets;
      const e = topLevelEntry(root.path, pro);
      if (e) e.name = nm;
      else if (Array.isArray(list)) list.push({ uuid: "00000000-0000-0000-0000-000000000000", name: nm, filename: node.file });
      else sub(pro, "schematic").top_level_sheets = [{ uuid: "00000000-0000-0000-0000-000000000000", name: nm, filename: node.file }];
    }, "rename sheet");
  } catch (e) { toast(`Could not rename the sheet: ${(e as Error).message}`, 5000); return; }
  topLevelSheetsChanged();
  publishHierarchy();
}
async function editPage(path: string): Promise<void> {
  const node = find(path); if (!node) return;
  // SCH_SHEET_PATH::PathHumanReadable( false ): the root file's stem, then each sheet name, each closed by '/'
  // (with several top-level sheets: the stem of the top-level sheet's file, then the names below it)
  const root = panelStore.get().hierarchy.root, top = root && root.virtual ? root.children.find((c) => path.startsWith(c.path)) : root;
  const stem = top ? top.file.replace(/\.kicad_sch$/, "") : "", names = namesTo(path);
  const human = stem + "/" + (root && root.virtual ? names.slice(1) : names).map((n) => n + "/").join("");
  if (E.viewOnly) { toast("View-only access"); return; }
  const page = await textEntry("Edit Sheet Page Number", `Enter page number for sheet path${human.length > 20 ? "\n" + human : " " + human}`, node.page, { alnum: true }); if (page === null) return;
  const pg = page.trim(); if (!pg || pg === node.page) return;
  if (!node.sheetId) {
    // the root sheet has no sheet symbol: its page is the root file's own (sheet_instances (path "/" (page …)))
    if (!node.docId) return;
    if (currentDocId() !== node.docId) { const d = schDocs().find((x) => x.docId === node.docId); if (!d) return; await openDoc(d); }
    if (currentDocId() === node.docId && commitRootPage(pg)) publishHierarchy();
    return;
  }
  await editSheetSymbol(node, "change sheet page number", (n) => setSheetPage(n, pg));
}
/**
 * SCH_EDIT_TOOL::EditPageNumber (Edit > Edit Sheet Page Number..., the sheet context menu): RequestSelection( {
 * SCH_SHEET_T } ) drops everything but sheets, so the one selected sheet's instance under the sheet on screen, else
 * the sheet on screen itself; nothing for more than one selected sheet.
 */
export function editPageNumber(): boolean {
  const doc = kdoc(); if (!doc || !isSchDoc()) return false;
  const sheets = [...new Set<string>(selectionIds())].map((id) => doc.items.get(id)).filter((it): it is KItem => !!it && it.kind === "sheet");
  if (sheets.length > 1) return true;
  const cur = currentDocId(), sel = sheets[0];
  const walk = (n: HierNode | null, ok: (x: HierNode) => boolean): HierNode | null => { if (!n) return null; if (ok(n)) return n; for (const c of n.children) { const r = walk(c, ok); if (r) return r; } return null; };
  const root = panelStore.get().hierarchy.root;
  const node = sel ? walk(root, (x) => x.sheetId === sel.id && x.parentDocId === cur) : walk(root, (x) => x.current);
  if (node) void editPage(node.path);
  return true;
}
function namesTo(path: string): string[] {
  const out: string[] = [];
  const walk = (n: HierNode, acc: string[]): boolean => { if (n.path === path) { out.push(...acc); return true; } for (const c of n.children) if (walk(c, acc.concat(c.name))) return true; return false; };
  const root = panelStore.get().hierarchy.root; if (root) walk(root, []);
  return out;
}

export function hierarchyDispatch(a: PanelAction): boolean {
  switch (a.t) {
    case "hierOpen": {
      const n = find(a.path); if (!n) return true;
      if (!n.docId) {   // a file this page has not heard of: enterSheet reads the file list again (or makes the file, as eeschema would)
        const parent = schDocs().find((x) => x.docId === n.parentDocId);
        preferInstance(humanOf(a.path));
        void enterSheet(n.file, parent ? parent.path : undefined);
        return true;
      }
      // the SCH_SHEET_PATH the row stands for: a sheet used twice shows as the instance that was clicked
      preferInstance(humanOf(a.path));
      if (n.docId !== currentDocId()) { const d = schDocs().find((x) => x.docId === n.docId); if (d) void openDoc(d); }
      else applyHighlight();   // the same file as another instance: the net map's listeners take the new instance
      return true;
    }
    case "hierRename": void rename(a.path); return true;
    case "hierPage": void editPage(a.path); return true;
    case "hierNewTop": void newTopLevelSheet(); return true;
    case "hierDeleteTop": void deleteTopLevelSheet(a.path); return true;
    default: return false;
  }
}

/** SCHEMATIC::GetPageNumbersAndNames: every sheet instance's page number with its sheet name, in hierarchy order
 *  (the hyperlink destinations DIALOG_TEXT_PROPERTIES offers as "#<page>"). */
export function pageNumbersAndNames(): [string, string][] {
  const out: [string, string][] = [];
  // SCH_SHEET_PATH::size() == 1 is "<root sheet>", every other sheet its name
  const walk = (n: HierNode | null, root: boolean): void => { if (!n) return; if (n.page && !out.some((x) => x[0] === n.page)) out.push([n.page, root ? "<root sheet>" : n.name]); for (const c of n.children) walk(c, false); };
  // built here rather than read from the pane's store, which is empty until the hierarchy pane has been shown
  let tree: HierNode | null = null; try { tree = build(); } catch { tree = null; }
  const t = tree || panelStore.get().hierarchy.root;
  // several top-level sheets: each is a path of size 1 under the hidden project root
  if (t && t.virtual) for (const c of t.children) walk(c, true); else walk(t, true);
  return out;
}

// The project file changed (a collaborator renamed a top-level sheet, or added one from the desktop): the top-level
// sheets, their sheet paths and the local net names on them follow, as SCH_EDIT_FRAME reloads them.
let topSig = "";
onProjectChanged(() => {
  let sig = ""; try { sig = topLevelSchematics().map((t) => t.doc.docId + ":" + t.name + ":" + t.uuid).join(","); } catch (e) { sig = ""; }
  if (sig === topSig) return;
  topSig = sig; topLevelSheetsChanged(); publishHierarchy(); void loadSheets();
});

/** The sheet instance whose page number is `page` (SCH_NAVIGATE_TOOL::HypertextCommand's "#<page>"): its document and
 *  hierarchy path, every top-level sheet included.  Null when no sheet has that page. */
export function sheetOfPage(page: string): { docId: string; human: string } | null {
  let tree: HierNode | null = null; try { tree = build(); } catch { tree = null; }
  const t = tree || panelStore.get().hierarchy.root; if (!t) return null;
  let hit: HierNode | null = null; const chain: HierNode[] = [], names: string[] = [];
  const walk = (n: HierNode): boolean => { if (!n.virtual && n.page === page && n.docId) { hit = n; names.push(...chain.map((c) => c.name)); return true; } for (const c of n.children) { chain.push(c); if (walk(c)) return true; chain.pop(); } return false; };
  walk(t);
  const h = hit as HierNode | null;
  return h && h.docId ? { docId: h.docId, human: "/" + names.map((x) => x + "/").join("") } : null;
}

// ---------------------------------------------------------------- top-level sheets (HIERARCHY_PANE::onContextMenu)
const NIL = "00000000-0000-0000-0000-000000000000";
interface TopEntry { uuid: string; name: string; filename: string }
/** The project file's top-level sheet list as it would be saved: the root sheet listed when the file has no list yet
 *  (SCH_EDIT_FRAME::SaveProjectLocalSettings writes every top-level sheet). */
function topEntries(pro: Record<string, unknown>): TopEntry[] {
  const s = sub(pro as never, "schematic") as Record<string, unknown>;
  if (!Array.isArray(s.top_level_sheets)) s.top_level_sheets = [];
  const list = s.top_level_sheets as TopEntry[];
  if (!list.length) {
    const root = (store.get().project ? rootSchematic() : null) as DocEntryLite | null, e = root ? entry(root.docId) : null;
    if (root) list.push({ uuid: String((e && (e.doc as unknown as { uuid?: string }).uuid) || NIL), name: "Root", filename: relToPro(root.path) });
  }
  return list;
}
function proDir(): string { const pro = openDocs().find((d) => d.docType === "kicad_pro") || ((store.get().project as { docs?: DocEntryLite[] } | null)?.docs || []).find((d) => d.docType === "kicad_pro"); return pro ? pro.path.split("/").slice(0, -1).join("/") : ""; }
function relToPro(path: string): string { const dir = proDir(); return dir && path.startsWith(dir + "/") ? path.slice(dir.length + 1) : path; }

/** NEW_TOP_LEVEL_SHEET: a new empty sheet file named after the sheet (spaces to underscores, lower case), on the lowest
 *  unused page number, added to the project's top-level sheets. */
async function newTopLevelSheet(): Promise<void> {
  if (E.viewOnly) { toast("View-only access"); return; }
  const name = await textEntry("New Top-Level Sheet", "Enter name for new top-level sheet:", "Untitled"); if (name === null || !name) return;
  let filename = name.replace(/ /g, "_").toLowerCase(); if (!filename.endsWith(".kicad_sch")) filename += ".kicad_sch";
  const dir = proDir(), path = dir ? `${dir}/${filename}` : filename;
  if (schDocs().some((d) => d.path === path)) { toast(`'${filename}' already exists in this project.`, 4000); return; }
  const used = new Set(pageNumbersAndNames().map((p) => p[0])); let n = 1; while (used.has(String(n))) n++;
  const project = store.get().project as { projectId?: string; docs?: DocEntryLite[] } | null;
  if (!project || !project.projectId) return;
  const uuid = KC().newUuid();
  try {
    await loadProject();
    const res = await api(`/api/projects/${project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path, docType: "kicad_sch" }) }) as { docId?: string; path?: string; existing?: boolean };
    if (!res || !res.docId) throw new Error("no document id returned");
    if (!res.existing) await api(`/api/docs/${res.docId}/snapshots?seq=0`, { method: "POST", headers: { "content-type": "text/plain" },
      body: `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "10.99") (uuid "${uuid}") (paper "A4") (lib_symbols) (sheet_instances (path "/" (page "${n}"))) (embedded_fonts no))\n` });
    const docEntry: DocEntryLite = { docId: res.docId, path: res.path || path, docType: "kicad_sch" };
    for (const list of [openDocs(), project.docs]) if (Array.isArray(list) && !list.some((d) => d.docId === docEntry.docId)) list.push(docEntry);
    await saveProject((pro) => { topEntries(pro as never).push({ uuid, name, filename: relToPro(docEntry.path) }); }, "new top-level sheet");
    publishDocs(); topLevelSheetsChanged(); await loadSheets();
  } catch (e) { toast(`Could not create the sheet: ${(e as Error).message}`, 5000); }
}

/** DELETE_TOP_LEVEL_SHEET: take a top-level sheet out of the project's top-level sheets (SCHEMATIC::RemoveTopLevelSheet;
 *  its file stays in the project), never the last one. */
async function deleteTopLevelSheet(path: string): Promise<void> {
  const node = find(path); if (!node || node.parentDocId) return;
  if (E.viewOnly) { toast("View-only access"); return; }
  if (!(await confirmBox("Delete Top-Level Sheet", `Delete top-level sheet '${node.name}'?\n\nThis cannot be undone.`, "Yes"))) return;
  const tops = topLevelSchematics();
  if (tops.length <= 1) { toast("Cannot delete the last top-level sheet.", 4000); return; }
  const gone = tops.find((t) => t.doc.docId === node.docId); if (!gone) return;
  try {
    await saveProject((pro) => {
      const list = topEntries(pro as never), file = relToPro(gone.doc.path);
      const i = list.findIndex((e) => e && (e.filename === file || e.filename === gone.doc.path.split("/").pop())); if (i >= 0) list.splice(i, 1);
    }, "delete top-level sheet");
  } catch (e) { toast(`Could not delete the sheet: ${(e as Error).message}`, 5000); return; }
  topLevelSheetsChanged(); publishHierarchy();
  // the sheet on screen was that one (or below it): the first top-level sheet left takes its place
  const left = topLevelSchematics();
  if (left.length && currentDocId() === gone.doc.docId) void openDoc(left[0].doc);
}
