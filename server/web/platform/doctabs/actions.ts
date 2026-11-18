// actions.ts — what a person does to a project's elements, folders and files, whichever place they do it from:
// the tab bar, the tab manager or the Home tab.  Each action talks to the server (api.ts), refreshes the list and
// says what happened; none of them knows which of the three called it.
//
// Deleting waits a few seconds before it reaches the server: the thing is hidden at once and a toast offers
// Undo.  (The server deletes a document with its history, for good; there is nothing to undo afterwards.)
import { DOCUMENT_KINDS, PCB_ELEMENT, documentKind, type DocumentKind } from "../../domains/registry";
import { newId, type ItemChange } from "../../shared/itemdoc/itemdoc";
import type { DocEntry } from "../../shared/store";
import { toast } from "../home/ui";
import {
  copyName, createDocument, createPcb, deleteDocument, deleteFolder, documentFromFile, duplicateDocument, duplicateFolder, freeElementName,
  kindForFile, moveDocument, moveFolder, renameDocument, renamedPath, uploadFile,
} from "./api";
import { emptyFoldersOf, freeFolderPath, nameProblem, type ProjectElement } from "./elements";
import { baseOf, dirOf, inDir } from "./pcbs";
import type { ProjectShell } from "./shell";

export interface ShellContext {
  projectId: string;
  /** every document of the project, with its path in the project */
  docs: readonly DocEntry[];
  elements: readonly ProjectElement<DocEntry>[];
  shell: ProjectShell | null;
  /** fetch the list again; open the tab `open` when it is there */
  refresh(open?: string): Promise<void>;
  /** the tab that is open, and how to open another */
  current: string | null;
  openTab(id: string): void;
}

const say = (e: unknown): void => toast((e as Error).message || "That did not work.", { kind: "err" });
/** Run an action; what goes wrong is said, not thrown. */
export async function attempt(what: () => Promise<void>): Promise<boolean> {
  try { await what(); return true; } catch (e) { say(e); return false; }
}

// ---------------------------------------------------------------- what is on its way out
let hidden: ReadonlySet<string> = new Set();
const hiddenSubs = new Set<() => void>();
/** The ids waiting to be deleted (element keys, document ids, "folder:<path>"): hidden everywhere meanwhile. */
export const pendingDeletes = { get: (): ReadonlySet<string> => hidden, subscribe: (fn: () => void): (() => void) => { hiddenSubs.add(fn); return () => { hiddenSubs.delete(fn); }; } };
const setHidden = (next: Set<string>): void => { hidden = next; for (const fn of Array.from(hiddenSubs)) fn(); };
const UNDO_MS = 6000;
const flushers = new Set<() => void>();
if (typeof window !== "undefined") window.addEventListener("pagehide", () => { for (const f of Array.from(flushers)) f(); });

/** Hide `id` now, delete it in a moment unless Undo is pressed. */
function deleteLater(ctx: ShellContext, id: string, label: string, run: (keepalive: boolean) => Promise<void>): void {
  setHidden(new Set(hidden).add(id));
  let done = false;
  const finish = (undo: boolean, leaving = false): void => {
    if (done) return; done = true;
    clearTimeout(timer); flushers.delete(leave);
    const back = (): void => { const next = new Set(hidden); next.delete(id); setHidden(next); };
    if (undo) { back(); return; }
    void run(leaving).then(() => ctx.refresh()).catch(say).finally(back);
  };
  const leave = (): void => finish(false, true);
  flushers.add(leave);
  const timer = setTimeout(() => finish(false), UNDO_MS);
  toast(`Deleted ${label}`, { ms: UNDO_MS, action: { label: "Undo", run: () => finish(true) } });
}

// ---------------------------------------------------------------- elements

/** The kinds "+" offers: a PCB, then every kind of document the registry says can be made. */
export interface Creatable { type: string; title: string; icon: string; tint?: string; summary: string; kind?: DocumentKind }
export function creatables(summaries: Record<string, string>): Creatable[] {
  return [
    { type: PCB_ELEMENT.type, title: PCB_ELEMENT.title, icon: PCB_ELEMENT.icon, tint: PCB_ELEMENT.tint, summary: PCB_ELEMENT.summary },
    ...DOCUMENT_KINDS.filter((k) => k.newName && k.newText !== undefined).map((k) => ({ type: k.docType, title: k.title, icon: k.icon, tint: k.tint, summary: summaries[k.docType] || "", kind: k })),
  ];
}

/** Make a new element of a kind in `folder` and open it. */
export function createElement(ctx: ShellContext, type: string, folder = ""): Promise<boolean> {
  return attempt(async () => {
    if (type === PCB_ELEMENT.type) {
      const made = await createPcb(ctx.projectId, freeElementName(PCB_ELEMENT.newName, ctx.docs), folder);
      const sch = made.docs.find((d) => d.docType === "kicad_sch") || made.docs[0];
      await ctx.refresh(sch.docId);
      return;
    }
    const kind = documentKind(type);
    if (!kind) throw new Error("Junction cannot make that here.");
    await ctx.refresh(await createDocument(ctx.projectId, kind, ctx.docs, folder));
  });
}

const siblingsOf = (ctx: ShellContext, folder: string): string[] =>
  [...ctx.elements.filter((e) => e.folder === folder).map((e) => e.name), ...ctx.docs.filter((d) => dirOf(d.path) === folder).map((d) => baseOf(d.path))];

/** Rename an element.  A PCB is its folder: the folder is renamed, and with it the PCB's own three files (server/src/shell.rs restem). */
export function renameElement(ctx: ShellContext, el: ProjectElement<DocEntry>, name: string): Promise<boolean> {
  return attempt(async () => {
    const to = name.trim().replace(/\s+/g, " ");
    if (to === el.name) return;
    const bad = nameProblem(to); if (bad) throw new Error(bad);
    if (el.pcb) {
      if (!el.pcb.dir) throw new Error("This PCB is the project's own KiCad files: rename the project instead.");
      await moveFolder(ctx.projectId, el.pcb.dir, (el.folder ? el.folder + "/" : "") + to, { stems: true });
    } else {
      const path = renamedPath(el.doc!, to, ctx.docs);
      if ("error" in path) throw new Error(path.error);
      await renameDocument(el.doc!, path.path);
    }
    await ctx.refresh();
  });
}

/** A copy of an element beside it, opened. */
export function duplicateElement(ctx: ShellContext, el: ProjectElement<DocEntry>): Promise<boolean> {
  return attempt(async () => {
    const name = copyName(el.name, siblingsOf(ctx, el.folder).map((n) => n.replace(/\.[^.]+$/, "")));
    const at = (el.folder ? el.folder + "/" : "") + name;
    if (el.pcb) {
      if (!el.pcb.dir) throw new Error("This PCB is the project's own KiCad files and cannot be copied inside the project. Make a new PCB instead.");
      const made = await duplicateFolder(ctx.projectId, el.pcb.dir, at, { stems: true });
      const root = el.pcb.schematic || el.pcb.boards[0];
      const open = root ? made.find((d) => d.from === root.docId) : undefined;
      await ctx.refresh(open ? open.docId : undefined);
    } else {
      const ext = (/\.[^./]+$/.exec(el.doc!.path) || [""])[0];
      const made = await duplicateDocument(ctx.projectId, el.doc!.docId, at + ext);
      await ctx.refresh(made.docId);
    }
    toast(`Copied ${el.name} to ${name}`);
  });
}

/** Put an element in a folder ("" is the project's root). */
export function moveElement(ctx: ShellContext, el: ProjectElement<DocEntry>, folder: string): Promise<boolean> {
  return attempt(async () => {
    if (folder === el.folder) return;
    if (el.pcb) {
      if (!el.pcb.dir) throw new Error("This PCB is the project's own KiCad files and stays at the project's root.");
      if (folder === el.pcb.dir || inDir(folder, el.pcb.dir)) throw new Error("A PCB cannot be moved into itself.");
      await moveFolder(ctx.projectId, el.pcb.dir, (folder ? folder + "/" : "") + baseOf(el.pcb.dir));
    } else await moveDocument(el.doc!, folder);
    forgetFolder(ctx, folder);
    await ctx.refresh();
  });
}

/** Delete an element (after the caller's confirmation), with a few seconds to undo it. */
export function deleteElement(ctx: ShellContext, el: ProjectElement<DocEntry>): void {
  if (el.pcb && !el.pcb.dir) { toast("This PCB is the project's own KiCad files. Delete the project to delete it.", { kind: "err" }); return; }
  // leave the tab that is going away
  const mine = el.pcb ? el.pcb.docs.some((d) => d.docId === ctx.current) || ctx.current === "bom:" + el.key : ctx.current === el.key;
  if (mine) ctx.openTab("home");
  deleteLater(ctx, el.key, el.name, async (keepalive) => {
    if (el.pcb) await deleteFolder(ctx.projectId, el.pcb.dir);
    else if (keepalive) await fetch(`/api/docs/${el.doc!.docId}`, { method: "DELETE", keepalive: true, headers: { "content-type": "application/json" } }).then(() => undefined);
    else await deleteDocument(el.doc!);
  });
}

// ---------------------------------------------------------------- folders

const folderItem = (ctx: ShellContext, path: string) => emptyFoldersOf(ctx.shell ? ctx.shell.getState().items : []).find((f) => f.path === path);

/** A folder that has something in it needs no item of its own any more. */
function forgetFolder(ctx: ShellContext, path: string): void {
  const it = path && folderItem(ctx, path);
  if (it && ctx.shell) ctx.shell.commit([{ id: it.id, kind: "REMOVED", typeName: "folder" }]);
}

/** A new, empty folder inside `parent`.  Returns its path. */
export function newFolder(ctx: ShellContext, parent: string, name: string, folders: readonly string[]): string | null {
  const bad = nameProblem(name);
  if (bad) { toast(bad, { kind: "err" }); return null; }
  if (!ctx.shell) return null;
  const path = freeFolderPath(parent, name, ctx.docs, folders);
  const id = "folder:" + newId();
  ctx.shell.commit([{ id, kind: "ADDED", typeName: "folder", item: { id, type: "folder", path } }]);
  return path;
}

/** The changes that keep the empty folders' items right when `from` becomes `to` (or goes away: `to` null). */
function folderItemChanges(ctx: ShellContext, from: string, to: string | null): ItemChange[] {
  const out: ItemChange[] = [];
  for (const f of emptyFoldersOf(ctx.shell ? ctx.shell.getState().items : [])) {
    if (f.path !== from && !inDir(f.path, from)) continue;
    out.push(to === null ? { id: f.id, kind: "REMOVED", typeName: "folder" } : { id: f.id, kind: "MODIFIED", typeName: "folder", props: [{ path: ["path"], value: to + f.path.slice(from.length) }] });
  }
  return out;
}

/** Rename or move a folder with everything in it. */
export function relocateFolder(ctx: ShellContext, from: string, to: string): Promise<boolean> {
  return attempt(async () => {
    if (from === to) return;
    const bad = nameProblem(baseOf(to)); if (bad) throw new Error(bad);
    if (to === from || inDir(to, from)) throw new Error("A folder cannot be moved into itself.");
    if (ctx.docs.some((d) => inDir(d.path, from))) await moveFolder(ctx.projectId, from, to);
    else if (ctx.docs.some((d) => d.path.toLowerCase() === to.toLowerCase() || inDir(d.path.toLowerCase(), to.toLowerCase()))) throw new Error(`This project already has “${to}”.`);
    const changes = folderItemChanges(ctx, from, to);
    if (changes.length && ctx.shell) ctx.shell.commit(changes);
    await ctx.refresh();
  });
}

/** Delete a folder and everything in it (after the caller's confirmation), with a few seconds to undo it. */
export function removeFolder(ctx: ShellContext, path: string): void {
  const inside = ctx.docs.filter((d) => inDir(d.path, path));
  if (inside.some((d) => d.docId === ctx.current)) ctx.openTab("home");
  deleteLater(ctx, "folder:" + path, baseOf(path), async () => {
    if (inside.length) await deleteFolder(ctx.projectId, path);
    const changes = folderItemChanges(ctx, path, null);
    if (changes.length && ctx.shell) ctx.shell.commit(changes);
  });
}

// ---------------------------------------------------------------- files

/** The server lets these be renamed, moved and deleted one by one; a PCB's own schematic, board and project file move with the PCB. */
export const fileIsLoose = (d: { docType: string }): boolean => d.docType !== "kicad_sch" && d.docType !== "kicad_pcb" && d.docType !== "kicad_pro" && d.docType !== "project_shell";

export function renameFile(ctx: ShellContext, doc: DocEntry, name: string): Promise<boolean> {
  return attempt(async () => {
    const ext = (/\.[^./]+$/.exec(doc.path) || [""])[0];
    const stem = name.trim().toLowerCase().endsWith(ext.toLowerCase()) && ext ? name.trim().slice(0, -ext.length) : name;
    const path = renamedPath(doc, stem, ctx.docs);
    if ("error" in path) throw new Error(path.error);
    if (path.path === doc.path) return;
    await renameDocument(doc, path.path);
    await ctx.refresh();
  });
}

export function moveFile(ctx: ShellContext, doc: DocEntry, folder: string): Promise<boolean> {
  return attempt(async () => {
    if (dirOf(doc.path) === folder) return;
    await moveDocument(doc, folder);
    forgetFolder(ctx, folder);
    await ctx.refresh();
  });
}

export function duplicateFile(ctx: ShellContext, doc: DocEntry): Promise<boolean> {
  return attempt(async () => {
    const ext = (/\.[^./]+$/.exec(doc.path) || [""])[0], folder = dirOf(doc.path);
    const name = copyName(baseOf(doc.path).slice(0, baseOf(doc.path).length - ext.length), siblingsOf(ctx, folder).map((n) => n.replace(/\.[^.]+$/, "")));
    await duplicateDocument(ctx.projectId, doc.docId, (folder ? folder + "/" : "") + name + ext);
    await ctx.refresh();
    toast(`Copied ${baseOf(doc.path)} to ${name}${ext}`);
  });
}

export function deleteFile(ctx: ShellContext, doc: DocEntry): void {
  deleteLater(ctx, doc.docId, baseOf(doc.path), async (keepalive) => {
    if (keepalive) await fetch(`/api/docs/${doc.docId}`, { method: "DELETE", keepalive: true, headers: { "content-type": "application/json" } }).then(() => undefined);
    else await deleteDocument(doc);
  });
}

// ---------------------------------------------------------------- files coming in

export interface IncomingFile { path: string; file: File }
const KICAD_DESIGN = /\.(kicad_pro|kicad_sch|kicad_pcb)$/i;
const ext = (name: string): string => (/\.([^./]+)$/.exec(name) || ["", ""])[1].toLowerCase();
/** The file types a project stores (server/src/http.rs allowed_file). */
const STORED = new Set(["kicad_pro", "kicad_sch", "kicad_pcb", "kicad_prl", "kicad_sym", "kicad_mod", "kicad_dru", "kicad_wks", "step", "stp", "wrl", "wrz", "lib", "sub", "cir", "mod", "model", "sp", "spice", "ibs", "in", "equ", "wbk", "jpart", "jasm"]);
const storable = (name: string): boolean => STORED.has(ext(name)) || /^(sym-lib-table|fp-lib-table|design-block-lib-table)$/.test(baseOf(name));

/** What a set of dropped or chosen files will become, before anything is sent. */
export interface ImportPlan {
  /** STEP files: each opens as a part studio that imports it */
  models: IncomingFile[];
  /** KiCad projects among the files: one new PCB each (a folder with a project file), or the files joining `into` */
  pcbs: { name: string; files: { rel: string; file: File }[]; make: string[] }[];
  /** files that join a PCB that is there already, or go in a folder as they are */
  loose: { folder: string; file: File; name: string }[];
  /** what a project cannot hold */
  refused: string[];
}

/**
 * Sort incoming files.  `into`: the folder they were dropped on (a PCB's folder, a folder of the Home tab, or
 * "" for the project).  `intoPcb` says that folder is a PCB: KiCad files then join it.  Otherwise each KiCad
 * project among the files (a `.kicad_pro` with what lies beside and under it) becomes a PCB, and a schematic or
 * board that comes with no project file becomes a PCB named after it, with the missing files made empty.
 */
export function planImport(files: readonly IncomingFile[], into: string, intoPcb: boolean): ImportPlan {
  const plan: ImportPlan = { models: [], pcbs: [], loose: [], refused: [] };
  const norm = files.map((f) => ({ path: f.path.replace(/\\/g, "/").replace(/^\/+/, ""), file: f.file })).filter((f) => !/(^|\/)\.[^/]+\//.test("/" + f.path));
  const rest: IncomingFile[] = [];
  for (const f of norm) {
    if (!storable(f.path)) { plan.refused.push(baseOf(f.path)); continue; }
    if (ext(f.path) === "kicad_prl") continue;   // a person's own window state: never part of a project
    rest.push(f);
  }
  const kicad = rest.filter((f) => !/\.(step|stp)$/i.test(f.path) || rest.some((x) => KICAD_DESIGN.test(x.path) && inDir(f.path, dirOf(x.path))));
  const hasDesign = kicad.some((f) => KICAD_DESIGN.test(f.path));
  for (const f of rest) if (!kicad.includes(f)) plan.models.push(f);
  if (!hasDesign || intoPcb) {
    // nothing that makes a PCB (or a PCB to join): the files go where they were dropped, STEP files as part studios
    for (const f of kicad) {
      if (/\.(step|stp)$/i.test(f.path) && !intoPcb) { plan.models.push(f); continue; }
      const sub = dirOf(f.path).split("/").slice(norm.every((x) => x.path.includes("/")) ? 1 : 0).join("/");
      plan.loose.push({ folder: [into, sub].filter(Boolean).join("/"), file: f.file, name: baseOf(f.path) });
    }
    return plan;
  }
  // one PCB per folder that holds a project file; design files in a folder with none make one of their own
  const proDirs = Array.from(new Set(kicad.filter((f) => /\.kicad_pro$/i.test(f.path)).map((f) => dirOf(f.path)))).sort((a, b) => b.length - a.length);
  const groups = new Map<string, IncomingFile[]>();
  for (const f of kicad) {
    let home = proDirs.find((d) => inDir(f.path, d));
    if (home === undefined) home = KICAD_DESIGN.test(f.path) ? dirOf(f.path) : proDirs.length ? undefined : (kicad.find((x) => KICAD_DESIGN.test(x.path)) ? dirOf(kicad.find((x) => KICAD_DESIGN.test(x.path))!.path) : undefined);
    if (home === undefined) { plan.loose.push({ folder: [into, dirOf(f.path)].filter(Boolean).join("/"), file: f.file, name: baseOf(f.path) }); continue; }
    if (!groups.has(home)) groups.set(home, []);
    groups.get(home)!.push(f);
  }
  for (const [home, list] of groups) {
    const pro = list.find((f) => /\.kicad_pro$/i.test(f.path) && dirOf(f.path) === home);
    const lead = pro || list.find((f) => /\.kicad_sch$/i.test(f.path) && dirOf(f.path) === home) || list.find((f) => KICAD_DESIGN.test(f.path))!;
    const stem = baseOf(lead.path).replace(/\.[^.]+$/, "");
    const have = (re: RegExp) => list.some((f) => re.test(f.path) && dirOf(f.path) === home);
    // what is missing is made empty, named like the rest, so the PCB is a whole KiCad project
    const make = [have(/\.kicad_pro$/i) ? "" : "kicad_pro", have(/\.kicad_sch$/i) ? "" : "kicad_sch", have(/\.kicad_pcb$/i) ? "" : "kicad_pcb"].filter(Boolean);
    plan.pcbs.push({ name: stem, make, files: list.map((f) => ({ rel: home ? f.path.slice(home.length + 1) : f.path, file: f.file })) });
  }
  return plan;
}

/**
 * Take files into the project (a drop, or "Import file").  A STEP file becomes a part studio that imports it;
 * KiCad files join the PCB they were dropped on or make a new one; libraries and models go in as files.
 * `onProgress` hears what is being sent.
 */
export async function importFiles(ctx: ShellContext, files: readonly IncomingFile[], into: string, intoPcb: boolean, onProgress?: (text: string | null) => void): Promise<boolean> {
  const plan = planImport(files, into, intoPcb);
  const total = plan.models.length + plan.loose.length + plan.pcbs.reduce((n, p) => n + p.files.length, 0);
  if (!total) { toast(plan.refused.length ? `Junction cannot keep ${plan.refused.slice(0, 3).join(", ")}${plan.refused.length > 3 ? "…" : ""} in a project.` : "There was nothing to import.", { kind: "err" }); return false; }
  let sent = 0, open: string | undefined;
  const step = (name: string) => onProgress?.(`Uploading ${name} (${++sent} of ${total})…`);
  const ok = await attempt(async () => {
    for (const p of plan.pcbs) {
      const taken = [...ctx.docs.map((d) => d.path.split("/")[0]), ...ctx.elements.map((e) => e.name)].map((n) => n.toLowerCase());
      let name = p.name; for (let n = 2; taken.includes(name.toLowerCase()); n++) name = `${p.name} ${n}`;
      let dir = (into ? into + "/" : "") + name;
      if (p.make.length) { const made = await createPcb(ctx.projectId, name, into, { stem: p.name, only: p.make }); dir = made.dir; }
      for (const f of p.files) {
        step(baseOf(f.rel));
        const made = await uploadFile(ctx.projectId, [dir, dirOf(f.rel)].filter(Boolean).join("/"), baseOf(f.rel), f.file);
        if (!open && /\.kicad_sch$/i.test(f.rel) && !f.rel.includes("/")) open = made.docId;
      }
    }
    for (const f of plan.loose) { step(f.name); await uploadFile(ctx.projectId, f.folder, f.name, f.file); }
    for (const f of plan.models) {
      const kind = kindForFile(f.file.name);
      if (!kind) { await uploadFile(ctx.projectId, into || "models", baseOf(f.path), f.file); continue; }
      step(baseOf(f.path));
      open = await documentFromFile(ctx.projectId, kind, f.file);
    }
  });
  onProgress?.(null);
  await ctx.refresh(ok && open && total <= 40 ? open : undefined).catch(() => {});
  if (ok) toast(`Imported ${total === 1 ? "one file" : total + " files"}${plan.refused.length ? `; ${plan.refused.length} left out (not files a project holds)` : ""}`);
  return ok;
}

/** Ask for files with the browser's own dialog; `folder`: a whole folder (a KiCad project as it lies on disk), keeping where each file is in it. */
export function pickFiles(accept: string, multiple: boolean, folder = false): Promise<IncomingFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = multiple; if (accept) input.accept = accept; input.hidden = true; input.dataset.docOpenFile = folder ? "folder" : "";
    if (folder) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.addEventListener("change", () => {
      const list = Array.from(input.files || []).map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file }));
      input.remove(); resolve(list);
    });
    input.addEventListener("cancel", () => { input.remove(); resolve([]); });
    document.body.append(input); input.click();
  });
}
