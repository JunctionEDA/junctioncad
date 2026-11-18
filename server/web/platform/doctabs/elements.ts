// elements.ts — what a project is made of, as its tab bar and its Home tab show it.  Pure.
//
// An ELEMENT is one tab: a PCB (a KiCad project in a folder: pcbs.ts), a part studio, an assembly, or any later
// kind the registry lists with an editor of its own.  Everything else in the project is a FILE: a library, a 3D
// model, a STEP file, the sheets of a PCB.  The Home tab shows both, in folders; the tab bar shows the elements.
//
// The order of the tabs and the folders that hold nothing yet are the project's own, shared by everybody: they
// are items of the project's document (`project.jproj`, a JSON item document like a part studio):
//
//   { id: "project", type: "project" }
//   { id: "tab:<element key>", type: "tab", order: "<order key>" }      one per element somebody has placed
//   { id: "folder:<uuid>", type: "folder", path: "Enclosure/Fasteners" } a folder that exists although it is empty
//
// An element nobody has placed sorts after the placed ones, in the default order (PCBs, then the kinds in the
// registry's order, each by name), so a project nobody ever reordered needs no items at all.
import { DOCUMENT_KINDS, PCB_ELEMENT, documentKind, type ElementTint } from "../../domains/registry";
import { orderBetween, type Item, type ItemChange } from "../../shared/itemdoc/itemdoc";
import { baseOf, dirOf, inDir, pcbsOf, relativePath, type Pcb, type PcbDoc } from "./pcbs";

export interface ProjectElement<T extends PcbDoc = PcbDoc> {
  /** stable across renames: a document id (for a PCB, its project file's) */
  key: string;
  /** "pcb", or the document type of a part studio, an assembly, … */
  type: string;
  /** what the kind is called ("PCB", "Part Studio") */
  title: string;
  name: string;
  /** the folder it is in ("" at the project's root); for a PCB, the folder its own folder is in */
  folder: string;
  icon: string;
  tint?: ElementTint;
  /** the document, for a kind that is one document */
  doc?: T;
  pcb?: Pcb<T>;
  /** may be renamed, moved, duplicated and deleted from the shell (a PCB at the project's root may not) */
  managed: boolean;
}

export const SHELL_DOC_TYPE = "project_shell";
export const SHELL_KIND = "project";
/** The same text as server/src/shell.rs SHELL_TEXT (the server makes the document). */
export const newShellText = (): string => '{"junction":"project","version":1,"items":[\n{"id":"project","type":"project"}\n]}\n';

const stem = (path: string): string => baseOf(path).replace(/\.[^.]+$/, "");
const natural = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** The project's elements in the default order: PCBs by folder, then each kind the registry lists, by name. */
export function elementsOf<T extends PcbDoc>(docs: readonly T[], projectName = ""): ProjectElement<T>[] {
  const out: ProjectElement<T>[] = [];
  for (const pcb of pcbsOf(docs, projectName)) {
    out.push({ key: pcb.key, type: PCB_ELEMENT.type, title: PCB_ELEMENT.title, name: pcb.name, folder: dirOf(pcb.dir), icon: PCB_ELEMENT.icon, tint: PCB_ELEMENT.tint, pcb, managed: pcb.dir !== "" });
  }
  out.sort((a, b) => natural(a.name, b.name));
  for (const kind of DOCUMENT_KINDS) {
    if (!kind.bundle) continue;
    const of = docs.filter((d) => d.docType === kind.docType)
      .map((doc): ProjectElement<T> => ({ key: doc.docId, type: kind.docType, title: kind.title, name: stem(doc.path), folder: dirOf(doc.path), icon: kind.icon, tint: kind.tint, doc, managed: true }));
    out.push(...of.sort((a, b) => natural(a.name, b.name)));
  }
  return out;
}

const tabItemId = (key: string): string => "tab:" + key;

/** The elements in tab order: the placed ones by their order keys, then the rest as `elementsOf` has them. */
export function orderedElements<E extends { key: string }>(elements: readonly E[], shell: Iterable<Item> | null | undefined): E[] {
  const order = new Map<string, string>();
  for (const it of shell || []) if (it.type === "tab" && typeof it.order === "string" && it.id.startsWith("tab:")) order.set(it.id.slice(4), it.order);
  const placed = elements.filter((e) => order.has(e.key)), rest = elements.filter((e) => !order.has(e.key));
  placed.sort((a, b) => { const x = order.get(a.key)!, y = order.get(b.key)!; return x < y ? -1 : x > y ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  return [...placed, ...rest];
}

/**
 * The changes to the project's document that put the element `key` just before `before` (null: at the end),
 * given the tabs as they are now.  Elements nobody placed yet are placed where they stand first, so the move is
 * a move among neighbours everybody agrees on.  Empty when nothing would change.
 */
export function moveTabChanges(ordered: readonly { key: string }[], shell: Iterable<Item> | null | undefined, key: string, before: string | null): ItemChange[] {
  const from = ordered.findIndex((e) => e.key === key);
  if (from < 0 || before === key) return [];
  const rest = ordered.filter((e) => e.key !== key);
  let at = before === null ? rest.length : rest.findIndex((e) => e.key === before);
  if (at < 0) at = rest.length;
  if (at === from) return [];   // it is there already
  const have = new Map<string, Item>();
  for (const it of shell || []) if (it.type === "tab") have.set(it.id, it);
  const changes: ItemChange[] = [];
  const keys = new Map<string, string>();
  // every tab that stays gets a key if it has none, in the order on screen
  let last = "";
  for (const e of rest) {
    const it = have.get(tabItemId(e.key));
    let k = it && typeof it.order === "string" ? it.order : "";
    if (!k || k <= last) {
      k = orderBetween(last, null);
      changes.push(it ? { id: it.id, kind: "MODIFIED", typeName: "tab", props: [{ path: ["order"], value: k }] }
        : { id: tabItemId(e.key), kind: "ADDED", typeName: "tab", item: { id: tabItemId(e.key), type: "tab", order: k } });
    }
    keys.set(e.key, k); last = k;
  }
  const lo = at > 0 ? keys.get(rest[at - 1].key)! : null, hi = at < rest.length ? keys.get(rest[at].key)! : null;
  const k = orderBetween(lo, hi), id = tabItemId(key), it = have.get(id);
  changes.push(it ? { id, kind: "MODIFIED", typeName: "tab", props: [{ path: ["order"], value: k }] } : { id, kind: "ADDED", typeName: "tab", item: { id, type: "tab", order: k } });
  return changes;
}

/** The changes that forget the placement of elements that are gone (their documents were deleted). */
export function pruneTabChanges(elements: readonly { key: string }[], shell: Iterable<Item> | null | undefined): ItemChange[] {
  const alive = new Set(elements.map((e) => tabItemId(e.key)));
  const out: ItemChange[] = [];
  for (const it of shell || []) if (it.type === "tab" && !alive.has(it.id)) out.push({ id: it.id, kind: "REMOVED", typeName: "tab" });
  return out;
}

// ---------------------------------------------------------------- folders and the file tree

/** A file of the project that is not an element by itself, as the Home tab lists it. */
export interface FileKind { title: string; icon: string }
const FILE_KINDS: Record<string, FileKind> = {
  kicad_sch: { title: "Schematic sheet", icon: documentKind("kicad_sch")!.icon },
  kicad_pcb: { title: "Board", icon: documentKind("kicad_pcb")!.icon },
  kicad_pro: { title: "KiCad project file", icon: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 13h6"/><path d="M9 17h4"/>' },
  symbol_lib: { title: "Symbol library", icon: '<path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3z"/><path d="M5 17a3 3 0 013-3h11"/>' },
  footprint: { title: "Footprint", icon: '<rect x="4" y="8" width="5" height="8" rx="1"/><rect x="15" y="8" width="5" height="8" rx="1"/><path d="M9 12h6"/>' },
  lib_table: { title: "Library table", icon: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 10h16"/><path d="M10 5v14"/>' },
  model3d: { title: "3D model", icon: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>' },
  worksheet: { title: "Drawing sheet", icon: '<rect x="4" y="4" width="16" height="16"/><path d="M13 16h7"/><path d="M13 20v-4"/>' },
  design_rules: { title: "Design rules", icon: '<path d="M4 18L18 4l2 2L6 20z"/><path d="M14 8l2 2"/><path d="M10 12l2 2"/>' },
  spice_model: { title: "Simulation model", icon: '<path d="M3 12h4l2-6 4 12 2-6h6"/>' },
};
const OTHER_FILE: FileKind = { title: "File", icon: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>' };
export const FOLDER_ICON = '<path d="M3 7a1 1 0 011-1h5l2 2h8a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1z"/>';
export const HOME_ICON = '<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/>';

export function fileKind(docType: string, path: string): FileKind {
  if (docType === "model3d" && /\.(step|stp)$/i.test(path)) return { title: "STEP file", icon: FILE_KINDS.model3d.icon };
  return FILE_KINDS[docType] || OTHER_FILE;
}

/** One row of the Home tab's tree. */
export interface TreeRow<T extends PcbDoc = PcbDoc> {
  /** unique in the tree: "folder:<path>", "el:<key>" or "file:<docId>" */
  id: string;
  kind: "folder" | "element" | "file";
  name: string;
  /** the folder path of a folder row; the folder a file or element is in */
  path: string;
  depth: number;
  element?: ProjectElement<T>;
  doc?: T;
  /** the documents under a folder or inside a PCB */
  count?: number;
  /** a PCB or a folder that has rows under it */
  expandable?: boolean;
  /** inside a PCB: its own files (they move with the PCB, not one by one) */
  owned?: boolean;
}

export interface TreeOptions {
  /** folder row ids and PCB row ids that are open */
  open: ReadonlySet<string>;
  /** only rows whose name holds this (and the folders above them, all open) */
  filter?: string;
  sort?: "name" | "kind" | "modified";
  desc?: boolean;
  /** when each document last changed (ms), for sort "modified" */
  modified?: ReadonlyMap<string, number>;
  /** folders that exist although nothing is in them (the project document's folder items) */
  emptyFolders?: readonly string[];
}

/** The folders of the project that hold nothing yet, from the project's document. */
export function emptyFoldersOf(shell: Iterable<Item> | null | undefined): { id: string; path: string }[] {
  const out: { id: string; path: string }[] = [];
  for (const it of shell || []) if (it.type === "folder" && typeof it.path === "string" && it.path) out.push({ id: it.id, path: it.path });
  return out;
}

/** Every folder a person can put things in: the ones on the way to a file or an element, and the empty ones.  A PCB's own folder is not one. */
export function foldersOf(docs: readonly PcbDoc[], elements: readonly ProjectElement[], empty: readonly string[] = []): string[] {
  const pcbDirs = elements.filter((e) => e.pcb && e.pcb.dir).map((e) => e.pcb!.dir);
  const inPcb = (p: string) => pcbDirs.some((d) => p === d || inDir(p, d));
  const set = new Set<string>();
  const add = (dir: string) => { for (let d = dir; d; d = dirOf(d)) if (!inPcb(d)) set.add(d); };
  for (const d of docs) if (d.docType !== SHELL_DOC_TYPE) add(dirOf(d.path));
  for (const e of elements) add(e.folder);
  for (const f of empty) add(f);
  return Array.from(set).sort(natural);
}

/**
 * The Home tab's rows, top to bottom: folders first, then elements, then files, each by `sort`; the rows of an
 * open folder or PCB follow it, one level in.  A PCB's files are under the PCB, not under a folder of its own.
 * The project's own document is not shown.
 */
export function treeRows<T extends PcbDoc>(docs: readonly T[], elements: readonly ProjectElement<T>[], o: TreeOptions): TreeRow<T>[] {
  const needle = (o.filter || "").trim().toLowerCase();
  const empty = o.emptyFolders || [];
  const folders = foldersOf(docs, elements, empty);
  const pcbOwned = new Map<string, ProjectElement<T>>();
  for (const e of elements) if (e.pcb) for (const d of e.pcb.docs) pcbOwned.set(d.docId, e);
  const elementDocs = new Set(elements.filter((e) => e.doc).map((e) => e.doc!.docId));
  const loose = docs.filter((d) => d.docType !== SHELL_DOC_TYPE && !elementDocs.has(d.docId) && !(pcbOwned.has(d.docId) && pcbOwned.get(d.docId)!.pcb!.dir));
  // a PCB at the root owns every loose file there is: show them as the project's files, and the PCB as a row of its own
  const mod = (ids: string[]): number => Math.max(0, ...ids.map((id) => (o.modified && o.modified.get(id)) || 0));
  const dir = o.desc ? -1 : 1;
  const cmp = (a: { name: string; kindRank: number; at: number }, b: { name: string; kindRank: number; at: number }): number =>
    (o.sort === "modified" ? (b.at - a.at) : o.sort === "kind" ? (a.kindRank - b.kindRank || natural(a.name, b.name)) : natural(a.name, b.name)) * dir || natural(a.name, b.name);
  const matches = (name: string) => !needle || name.toLowerCase().includes(needle);
  const rows: TreeRow<T>[] = [];

  const pcbFiles = (e: ProjectElement<T>, depth: number): TreeRow<T>[] => {
    const pcb = e.pcb!;
    return pcb.docs.filter((d) => matches(baseOf(d.path)) || matches(d.path))
      .map((d) => ({ d, name: relativePath(pcb.dir, d.path), kindRank: 0, at: mod([d.docId]) }))
      .sort((a, b) => Number(b.d === pcb.schematic) - Number(a.d === pcb.schematic) || Number(pcb.boards.includes(b.d)) - Number(pcb.boards.includes(a.d)) || cmp(a, b))
      .map((x): TreeRow<T> => ({ id: "file:" + x.d.docId, kind: "file", name: x.name, path: dirOf(x.d.path), depth, doc: x.d, owned: true }));
  };

  const walk = (folder: string, depth: number): TreeRow<T>[] => {
    const out: TreeRow<T>[] = [];
    const subs = folders.filter((f) => dirOf(f) === folder).map((f) => ({ f, name: baseOf(f), kindRank: 0, at: mod(docs.filter((d) => inDir(d.path, f)).map((d) => d.docId)) })).sort(cmp);
    for (const s of subs) {
      const under = walk(s.f, depth + 1);
      const count = docs.filter((d) => inDir(d.path, s.f)).length;
      if (needle && !under.length && !matches(s.name)) continue;
      const id = "folder:" + s.f, open = !!needle || o.open.has(id);
      out.push({ id, kind: "folder", name: s.name, path: s.f, depth, count, expandable: under.length > 0 });
      if (open) out.push(...under);
    }
    const els = elements.filter((e) => e.folder === folder)
      .map((e) => ({ e, name: e.name, kindRank: e.pcb ? 0 : 1 + DOCUMENT_KINDS.findIndex((k) => k.docType === e.type), at: mod(e.pcb ? e.pcb.docs.map((d) => d.docId) : [e.doc!.docId]) })).sort(cmp);
    for (const x of els) {
      const e = x.e, id = "el:" + e.key;
      // a PCB in a folder of its own holds its files; a PCB at the root has them beside it
      const inner = e.pcb && e.pcb.dir ? pcbFiles(e, depth + 1) : [];
      if (needle && !matches(e.name) && !inner.length) continue;
      out.push({ id, kind: "element", name: e.name, path: e.folder, depth, element: e, doc: e.doc, count: e.pcb ? e.pcb.docs.length : undefined, expandable: inner.length > 0 });
      if (inner.length && (o.open.has(id) || (!!needle && !matches(e.name)))) out.push(...inner);
    }
    const files = loose.filter((d) => dirOf(d.path) === folder && matches(baseOf(d.path)))
      .map((d) => ({ d, name: baseOf(d.path), kindRank: 100, at: mod([d.docId]) })).sort(cmp);
    for (const x of files) out.push({ id: "file:" + x.d.docId, kind: "file", name: x.name, path: folder, depth, doc: x.d, owned: pcbOwned.has(x.d.docId) && (x.d.docType === "kicad_sch" || x.d.docType === "kicad_pcb" || x.d.docType === "kicad_pro") });
    return out;
  };
  rows.push(...walk("", 0));
  return rows;
}

/** "Enclosure", or "Enclosure 2" when the folder (or a file of that name) is there already. */
export function freeFolderPath(parent: string, name: string, docs: readonly { path: string }[], folders: readonly string[]): string {
  const clean = name.trim().replace(/\s+/g, " ").replace(/[\\/:*?"<>|]+/g, "_").replace(/^\.+|\.+$/g, "") || "Folder";
  const taken = new Set([...docs.map((d) => d.path.toLowerCase()), ...folders.map((f) => f.toLowerCase())]);
  const at = (n: string) => (parent ? parent + "/" : "") + n;
  const used = (p: string) => taken.has(p.toLowerCase()) || docs.some((d) => d.path.toLowerCase().startsWith(p.toLowerCase() + "/"));
  if (!used(at(clean))) return at(clean);
  for (let n = 2; ; n++) if (!used(at(`${clean} ${n}`))) return at(`${clean} ${n}`);
}

/** Why an element or folder name will not do, or null. */
export function nameProblem(name: string): string | null {
  const s = name.trim();
  if (!s) return "It needs a name.";
  if (/[\\/:*?"<>|]/.test(s) || s.startsWith(".") || s.endsWith(".")) return 'A name cannot contain \\ / : * ? " < > | or start or end with a dot.';
  if (s.length > 80) return "That name is too long (80 characters at most).";
  return null;
}

/** The element a tab id belongs to: its own key, any document of a PCB, or the BOM of a PCB ("bom:<key>"). */
export function elementOfTab<E extends ProjectElement>(elements: readonly E[], tabId: string | null): E | undefined {
  if (!tabId) return undefined;
  const key = tabId.startsWith("bom:") ? tabId.slice(4) : tabId;
  return elements.find((e) => e.key === key) || elements.find((e) => !!e.pcb && e.pcb.docs.some((d) => d.docId === key));
}

/** Which view of a PCB a tab id is. */
export function pcbViewOf(pcb: Pcb, tabId: string | null): "schematic" | "board" | "bom" | null {
  if (!tabId) return null;
  if (tabId === "bom:" + pcb.key) return "bom";
  const d = pcb.docs.find((x) => x.docId === tabId);
  return d ? (d.docType === "kicad_pcb" ? "board" : d.docType === "kicad_sch" ? "schematic" : null) : null;
}
