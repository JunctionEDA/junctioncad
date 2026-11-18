// api.ts — adding, renaming, moving, copying and deleting the documents and folders of an open project, over the
// endpoints every client uses (server/src/http.rs: POST /api/projects/{id}/docs, POST /api/docs/{id}/snapshots,
// PATCH and DELETE /api/docs/{id}) and the shell's own (server/src/shell.rs: PCBs, folders, copies, the file list).
// Pure helpers are separate from the network calls so they can be tested.
//
// Every path here is a path in the whole project.  The requests go through the browser's own fetch (rawfetch.ts),
// not the one the schematic and board editor wraps to stay inside its PCB.
import type { DocEntry } from "../../shared/store";
import { DOCUMENT_KINDS, type DocumentKind } from "../../domains/registry";
import { rawFetch } from "../documents/rawfetch";

const base = (path: string): string => path.split("/").pop() || path;
/** A document's name as its tab shows it: the file name without its folder and extension. */
export const stemOf = (path: string): string => base(path).replace(/\.[^.]+$/, "");

/** "Part Studio 2.jpart": the first name of that kind no document of the project has (whatever the letter case). */
export function freeName(kind: DocumentKind, docs: readonly { path: string }[]): string {
  const taken = new Set(docs.map((d) => base(d.path).toLowerCase()));
  for (let n = 1; ; n++) { const name = `${kind.newName || kind.title} ${n}${kind.ext}`; if (!taken.has(name.toLowerCase())) return name; }
}

/** "PCB 2": the first such name no folder or file at the project's root has (whatever the letter case). */
export function freeElementName(stem: string, docs: readonly { path: string }[]): string {
  const taken = new Set(docs.map((d) => d.path.split("/")[0].toLowerCase().replace(/\.[^.]+$/, "")));
  for (let n = 1; ; n++) { const name = `${stem} ${n}`; if (!taken.has(name.toLowerCase())) return name; }
}

/** "Lid copy", "Lid copy 2": a name for a copy that nothing beside the original has. */
export function copyName(name: string, taken: readonly string[]): string {
  const have = new Set(taken.map((t) => t.toLowerCase()));
  const stem = name.replace(/ copy( \d+)?$/i, "");
  for (let n = 1; ; n++) { const c = n === 1 ? `${stem} copy` : `${stem} copy ${n}`; if (!have.has(c.toLowerCase())) return c; }
}

/** The path a document gets when its tab is renamed to `name`, or why that name will not do. */
export function renamedPath(doc: { path: string }, name: string, docs: readonly { docId?: string; path: string }[]): { path: string } | { error: string } {
  const stem = name.trim().replace(/\s+/g, " ");
  if (!stem) return { error: "A document needs a name." };
  if (/[\\/:*?"<>|]/.test(stem) || stem.startsWith(".")) return { error: 'A name cannot contain \\ / : * ? " < > | or start with a dot.' };
  const ext = (/\.[^.\/]+$/.exec(doc.path) || [""])[0];
  const dir = doc.path.includes("/") ? doc.path.slice(0, doc.path.lastIndexOf("/") + 1) : "";
  const path = dir + stem + ext;
  if (path === doc.path) return { path };
  if (docs.some((d) => d.path !== doc.path && d.path.toLowerCase() === path.toLowerCase())) return { error: `This project already has “${stem}${ext}”.` };
  return { path };
}

async function call(path: string, init: RequestInit): Promise<unknown> {
  const r = await rawFetch()(path, init);
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(t || `${r.status} ${r.statusText}`); }
  return (r.headers.get("content-type") || "").includes("json") ? r.json() : r.text();
}
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The project's documents as the server has them now. */
export async function fetchDocs(projectId: string): Promise<DocEntry[]> {
  const info = (await call(`/api/projects/${projectId}/info`, { headers: { "content-type": "application/json" } })) as { docs: DocEntry[] };
  return info.docs || [];
}

/** Make a new, empty document of a kind; returns its id.  The document's first snapshot is the kind's empty file. */
export async function createDocument(projectId: string, kind: DocumentKind, docs: readonly DocEntry[], folder = ""): Promise<string> {
  if (kind.newText === undefined) throw new Error(`A ${kind.title} cannot be created here.`);
  const made = (await call(`/api/projects/${projectId}/docs`, json({ path: (folder ? folder + "/" : "") + freeName(kind, docs) }))) as { docId: string };
  await call(`/api/docs/${made.docId}/snapshots?seq=0`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: kind.newText });
  return made.docId;
}

/** "models/bracket.step", or "models/bracket 2.step" when the project has that (whatever the letter case). */
export function freeFilePath(folder: string, name: string, docs: readonly { path: string }[]): string {
  const clean = (base(name).replace(/[\\/:*?"<>|]+/g, "_").trim() || "file").replace(/^\.+/, "_");
  const dir = folder ? folder.replace(/\/+$/, "") + "/" : "";
  const dot = clean.lastIndexOf("."), stem = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : "";
  const taken = new Set(docs.map((d) => d.path.toLowerCase()));
  for (let n = 1; ; n++) { const p = `${dir}${n === 1 ? stem : `${stem} ${n}`}${ext}`; if (!taken.has(p.toLowerCase())) return p; }
}

/**
 * Store a file in the project as it is (its bytes become the document's first snapshot): a STEP model, say.
 * `onProgress` hears the upload's progress, 0 to 1.  Returns the new document.
 */
export async function uploadFile(projectId: string, folder: string, name: string, data: Blob, onProgress?: (done: number) => void): Promise<DocEntry> {
  let docs = await fetchDocs(projectId);
  let made: { docId: string; path: string; docType: string; existing?: boolean } | null = null;
  for (let tries = 0; tries < 3 && !made; tries++) {
    const r = (await call(`/api/projects/${projectId}/docs`, json({ path: freeFilePath(folder, name, docs) }))) as { docId: string; path: string; docType: string; existing?: boolean };
    if (!r.existing) made = r; else docs = await fetchDocs(projectId);   // somebody took the name meanwhile
  }
  if (!made) throw new Error(`“${name}” could not be added to the project.`);
  await new Promise<void>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", `/api/docs/${made!.docId}/snapshots?seq=0`);
    x.setRequestHeader("content-type", "application/octet-stream");
    x.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(x.responseText || `${x.status} ${x.statusText}`)));
    x.onerror = () => reject(new Error(`“${name}” could not be uploaded.`));
    x.send(data);
  });
  return { docId: made.docId, path: made.path, docType: made.docType };
}

/** Make a document of `kind` from a file (kind.fromFile): store the file, then the document that uses it.  Returns the new document's id. */
export async function documentFromFile(projectId: string, kind: DocumentKind, file: File, onProgress?: (done: number) => void): Promise<string> {
  const from = kind.fromFile;
  if (!from) throw new Error(`A ${kind.title} cannot be made from a file.`);
  if (!from.accept.some((ext) => file.name.toLowerCase().endsWith(ext))) throw new Error(`“${file.name}” is not a ${from.title} (${from.accept.join(", ")}).`);
  const stored = await uploadFile(projectId, from.folder, file.name, file, onProgress);
  const docs = await fetchDocs(projectId);
  const stem = stemOf(stored.path);
  const path = freeFilePath("", stem + kind.ext, docs);
  const made = (await call(`/api/projects/${projectId}/docs`, json({ path }))) as { docId: string };
  const text = from.text({ docId: stored.docId, path: stored.path, name: base(stored.path), bytes: file.size });
  await call(`/api/docs/${made.docId}/snapshots?seq=0`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: text });
  return made.docId;
}

/** The kind a dropped or chosen file makes, by its extension. */
export function kindForFile(name: string): DocumentKind | undefined {
  const lower = name.toLowerCase();
  return DOCUMENT_KINDS.find((k) => k.fromFile && k.fromFile.accept.some((ext) => lower.endsWith(ext)));
}

export async function renameDocument(doc: DocEntry, path: string): Promise<void> {
  await call(`/api/docs/${doc.docId}`, { ...json({ path }), method: "PATCH" });
}

export async function deleteDocument(doc: DocEntry): Promise<void> {
  await call(`/api/docs/${doc.docId}`, { method: "DELETE", headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------- the shell's own routes (server/src/shell.rs)

/** A file of the project as the Home tab lists it. */
export interface ProjectFile extends DocEntry { bytes: number | null; updatedAt: string | null; updatedBy: { login: string; name: string | null } | null }

export async function fetchFiles(projectId: string): Promise<ProjectFile[]> {
  const r = (await call(`/api/projects/${projectId}/files`, { headers: { "content-type": "application/json" } })) as { files: ProjectFile[] };
  return r.files || [];
}

/** The project's own document (tab order, folders, the room), made if the project has none.  Returns its id. */
export async function ensureShellDoc(projectId: string): Promise<string> {
  return ((await call(`/api/projects/${projectId}/shell`, json({}))) as { docId: string }).docId;
}

/** A new PCB: a KiCad project in a folder of its own.  Returns its folder and the documents made. */
export async function createPcb(projectId: string, name: string, folder = "", o: { stem?: string; only?: string[] } = {}): Promise<{ dir: string; name: string; docs: DocEntry[] }> {
  return (await call(`/api/projects/${projectId}/pcbs`, json({ name, folder, ...o }))) as { dir: string; name: string; docs: DocEntry[] };
}

/** Rename or move a folder with everything in it (a PCB is renamed this way). */
export async function moveFolder(projectId: string, from: string, to: string, o: { stems?: boolean } = {}): Promise<void> {
  await call(`/api/projects/${projectId}/folders/move`, json({ from, to, ...o }));
}

export async function deleteFolder(projectId: string, path: string): Promise<void> {
  await call(`/api/projects/${projectId}/folders/delete`, json({ path }));
}

/** A copy of one document at `path`.  Returns the copy. */
export async function duplicateDocument(projectId: string, docId: string, path: string): Promise<DocEntry> {
  return ((await call(`/api/projects/${projectId}/duplicate`, json({ docId, path }))) as { docs: DocEntry[] }).docs[0];
}

/** A copy of a folder with everything in it.  Returns the copies (`from`: the document each was copied from). */
export async function duplicateFolder(projectId: string, folder: string, to: string, o: { stems?: boolean } = {}): Promise<(DocEntry & { from: string })[]> {
  return ((await call(`/api/projects/${projectId}/duplicate`, json({ folder, to, ...o }))) as { docs: (DocEntry & { from: string })[] }).docs;
}

/** Move one document to another folder, keeping its name. */
export async function moveDocument(doc: DocEntry, folder: string): Promise<void> {
  await renameDocument(doc, (folder ? folder + "/" : "") + base(doc.path));
}
