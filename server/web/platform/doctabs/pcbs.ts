// pcbs.ts — the PCBs of a project, and what each one's editor may see.  Pure.
//
// A project holds any number of PCBs.  **A PCB is a KiCad project in a folder**: the folder of a `.kicad_pro`
// with the schematic sheets, the board, the library tables and the libraries under it.  A project from before
// there could be several (its KiCad files at the root, with or without a project file) is one PCB whose folder is
// the root; nothing about it changes.
//
// The schematic and board editor works on ONE PCB at a time and must never see another's files: it finds "the"
// project file, "the" root sheet, "the" board and the library tables by looking through the project's documents,
// in more than a hundred places.  So the shell hands it `scopedDocs()`: the documents of that PCB alone, with
// their paths relative to the PCB's folder, exactly as if the folder were the whole project.  What the editor
// then makes (a sheet, a library, `fp-lib-table`) is put back under the folder by `fullPath()` on its way to the
// server (web/domains/pcb/editor/pcbscope.ts).  The document ids are the project's own, so everything addressed
// by id (content, edits, comments, history) needs no translation.
//
// Which documents belong to which PCB:
//   · a document belongs to the PCB whose folder is the longest one that contains it;
//   · a schematic or board outside every PCB folder: with exactly one project file in the project it belongs to
//     that PCB (a repository whose sheets sit beside the project folder); otherwise such files are a PCB at the root;
//   · anything else outside every PCB folder (a part studio, a STEP model, a shared library) belongs to no PCB and
//     every PCB sees it, at a path that starts with "../".
export interface PcbDoc { docId: string; path: string; docType: string; hasPreview?: boolean }

export interface Pcb<T extends PcbDoc = PcbDoc> {
  /** stable for as long as the PCB lives, whatever it is renamed to: the id of its project file (else of its root sheet, else of its board) */
  key: string;
  /** its folder: "" for a PCB at the project's root */
  dir: string;
  /** what people call it: the folder's name; at the root, the project file's name */
  name: string;
  pro: T | null;
  /** the root sheet (the one named like the project file, else the highest in the folder tree) */
  schematic: T | null;
  /** every board of the PCB, the one named like the project file first */
  boards: T[];
  /** every schematic sheet, the root sheet first */
  sheets: T[];
  /** every document that belongs to it */
  docs: T[];
}

const KICAD_DESIGN = (t: string): boolean => t === "kicad_sch" || t === "kicad_pcb" || t === "kicad_pro";
export const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const stemOf = (path: string): string => baseOf(path).replace(/\.[^.]+$/, "");
export const inDir = (path: string, dir: string): boolean => dir === "" || path.startsWith(dir + "/");
const depth = (path: string): number => path.split("/").length;
const byPath = (a: PcbDoc, b: PcbDoc): number => a.path.localeCompare(b.path, undefined, { numeric: true });

/** The PCBs of a project, in the order of their folders.  `projectName` names a PCB at the root that has no project file. */
export function pcbsOf<T extends PcbDoc>(docs: readonly T[], projectName = ""): Pcb<T>[] {
  const pros = docs.filter((d) => d.docType === "kicad_pro");
  const dirs = Array.from(new Set(pros.map((d) => dirOf(d.path))));
  const owner = (d: PcbDoc): string | null => {
    let best: string | null = null;
    for (const dir of dirs) if (inDir(d.path, dir) && (best === null || dir.length > best.length)) best = dir;
    return best;
  };
  const strays = docs.filter((d) => (d.docType === "kicad_sch" || d.docType === "kicad_pcb") && owner(d) === null);
  // strays with one project file ride with it; with none, or with several, they are a PCB at the root
  const adopt = strays.length > 0 && dirs.length === 1;
  if (strays.length && !adopt) dirs.push("");
  const out: Pcb<T>[] = [];
  for (const dir of dirs) {
    const mine = docs.filter((d) => owner(d) === dir || (adopt && strays.includes(d)));
    // several project files in one folder: the first by name speaks for it
    const pro = pros.filter((d) => dirOf(d.path) === dir).sort(byPath)[0] || null;
    const stem = pro ? stemOf(pro.path) : null;
    const sch = mine.filter((d) => d.docType === "kicad_sch");
    const root = (stem !== null && sch.find((d) => baseOf(d.path) === stem + ".kicad_sch"))
      || sch.slice().sort((a, b) => depth(a.path) - depth(b.path) || a.path.length - b.path.length)[0] || null;
    const boards = mine.filter((d) => d.docType === "kicad_pcb").sort((a, b) => Number(stemOf(b.path) === stem) - Number(stemOf(a.path) === stem) || byPath(a, b));
    if (!pro && !root && !boards.length) continue;
    out.push({
      key: (pro || root || boards[0])!.docId, dir, name: dir ? baseOf(dir) : stem || projectName || "PCB",
      pro, schematic: root, boards, sheets: root ? [root, ...sch.filter((d) => d !== root).sort(byPath)] : [], docs: mine,
    });
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir, undefined, { numeric: true }));
}

/** The PCB a document belongs to (by id), or undefined: a part studio, a model, a file of no PCB. */
export function pcbOfDoc<T extends PcbDoc>(pcbs: readonly Pcb<T>[], docId: string): Pcb<T> | undefined {
  return pcbs.find((p) => p.docs.some((d) => d.docId === docId));
}

/** A project path as the editor of the PCB in `dir` sees it: relative to that folder. */
export function relativePath(dir: string, path: string): string {
  if (!dir) return path;
  if (inDir(path, dir)) return path.slice(dir.length + 1);
  const from = dir.split("/"), to = path.split("/");
  let same = 0;
  while (same < from.length && same < to.length - 1 && from[same] === to[same]) same++;
  return "../".repeat(from.length - same) + to.slice(same).join("/");
}

/** The project path of what the editor of the PCB in `dir` calls `rel`.  Null when it would leave the project. */
export function fullPath(dir: string, rel: string): string | null {
  const out = dir ? dir.split("/") : [];
  for (const part of rel.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!out.length) return null; out.pop(); } else out.push(part);
  }
  return out.length ? out.join("/") : null;
}

/**
 * The project's documents as the schematic and board editor may see them while it works on `pcb`: that PCB's own
 * documents and the ones that belong to no PCB, each with its path relative to the PCB's folder.  No document of
 * another PCB is in the list.  With `pcb` null (no PCB is open) the list has the documents of no PCB only.
 *
 * A project whose only PCB is at the root gets the very list it was given.
 */
export function scopedDocs<T extends PcbDoc>(docs: readonly T[], pcbs: readonly Pcb<T>[], pcb: Pcb<T> | null): T[] {
  if (pcb && !pcb.dir && pcbs.length === 1) return docs.slice();
  const owned = new Set<string>();
  for (const p of pcbs) if (p !== pcb) for (const d of p.docs) owned.add(d.docId);
  const dir = pcb ? pcb.dir : "";
  const out: T[] = [];
  for (const d of docs) {
    if (owned.has(d.docId) || d.docType === "project_shell") continue;   // the project's own document is the shell's
    // a schematic, board or project file is only ever seen from inside its own PCB
    if (KICAD_DESIGN(d.docType) && !(pcb && pcb.docs.includes(d))) continue;
    const path = relativePath(dir, d.path);
    out.push(path === d.path ? d : { ...d, path });
  }
  return out;
}

/** The sub-tabs of a PCB tab. */
export type PcbView = "schematic" | "board" | "bom";
export const bomTabId = (pcb: { key: string }): string => "bom:" + pcb.key;
export const HOME_TAB = "home";
