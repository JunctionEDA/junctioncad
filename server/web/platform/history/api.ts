// history/api.ts — the server's version history, branches and merges, as plain calls (server/src/versions.rs).
//
// The electronics editor has its own client for these endpoints, tied to its store (web/domains/pcb/editor/
// versions.ts).  This one is for every other domain's editor: it knows nothing of what a document holds, only
// that a project has versions (one point per document), runs of edits between them, and branches.
//
//   timeline(projectId)                    versions, runs of edits, each document's head
//   docAt(docId, seq)                      a document at a point: the stored file and the ops to lay over it
//   itemDocAt(docId, seq, kind)            the same for a JSON item document, already built (shared/itemdoc)
//   saveVersion · renameVersion · deleteVersion · restore
//   branches · createBranch · deleteBranch · merge (dryRun gives the plan and its conflicts)
import { applyChanges, parseItemDoc, type ItemChange, type ItemDoc } from "../../shared/itemdoc/itemdoc";

export interface Person { id: number; login?: string | null; name?: string | null; avatarUrl?: string | null }
export interface VersionDoc { docId: string; path: string; snapSeq: number; seq: number }
export interface Version { id: string; name: string | null; description: string; kind: "named" | "auto"; createdAt: string; author: Person | null; docs: VersionDoc[] }
/** One person working on one document without a long pause, or a restore or a merge that rewrote it. */
export interface Run { docId: string; path: string; from: number; to: number; count: number; kind: "edit" | "restore" | "merge"; author: Person; startedAt: string; endedAt: string }
export interface TimelineDoc { docId: string; path: string; docType: string; head: number; floor: number }
export interface Timeline { projectId: string; parentId: string | null; branchName: string | null; docs: TimelineDoc[]; versions: Version[]; runs: Run[]; keptDays: number; signedIn: boolean }

export interface DocRef { docId: string; path: string; docType: string }
export interface Branch { projectId: string; name: string; description: string; createdAt: string; updatedAt: string; mergedAt: string | null; createdBy: Person | null; ahead: number; behind: number; docs: DocRef[] }
export interface Branches { main: { projectId: string; name: string; docs: DocRef[] }; current: string; canEdit: boolean; branches: Branch[] }

/** What one side did at the place of a conflict (server/src/itemmerge.rs `Did`). */
export interface Did { did: "removed" | "replaced" | "set" | "unset" | "changed"; value?: unknown }
export interface MergeConflict { id: string; label: string; item?: string; path?: string[] | null; incoming?: Did; current?: Did }
export interface MergeDoc { path: string; docType: string; action: "none" | "merge" | "take" | "add"; ops: number; changes: number; conflicts: MergeConflict[]; changedHere: boolean }
export interface MergePlan { direction: "into_main" | "from_main"; branch: string; docs: MergeDoc[]; conflicts: number; nothing: boolean; canMerge: boolean; reason: string | null }
export type Side = "incoming" | "current";

export class HistoryError extends Error { status = 0; code = ""; }

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let r: Response;
  try { r = await fetch(path, { method, credentials: "same-origin", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) { throw new HistoryError("The server could not be reached."); }
  let json: unknown = null;
  try { json = await r.json(); } catch (e) { /* no body */ }
  if (!r.ok) {
    const j = json as { message?: string; error?: string } | null;
    const err = new HistoryError((j && j.message) || (r.status === 401 ? "Sign in to do that." : r.status === 403 ? "You do not have access to do that." : `The server answered ${r.status}.`));
    err.status = r.status; err.code = (j && j.error) || "";
    throw err;
  }
  return json as T;
}

export const timeline = (projectId: string): Promise<Timeline> => call(`/api/projects/${projectId}/timeline`);

export interface DocAt { docId: string; path: string; docType: string; seq: number; head: number; snapSeq: number; file: string; ops: { seq: number; changes: unknown[] }[] }
export const docAt = (docId: string, seq: number | "head"): Promise<DocAt> => call(`/api/docs/${docId}/at/${seq}`);

/** A JSON item document as it was at `seq`: the stored file with the edits up to there applied. */
export async function itemDocAt(docId: string, seq: number | "head", expectKind?: string): Promise<{ doc: ItemDoc; seq: number; head: number }> {
  const at = await docAt(docId, seq);
  const doc = parseItemDoc(at.file, expectKind);
  for (const op of at.ops) if (op.seq <= at.seq) applyChanges(doc, op.changes as ItemChange[]);
  return { doc, seq: at.seq, head: at.head };
}

export const saveVersion = (projectId: string, name: string, description = "", at?: { docId: string; seq: number }): Promise<{ id: string; name: string; githubPush?: boolean }> =>
  call(`/api/projects/${projectId}/versions`, "POST", { name, description, at });
export const renameVersion = (projectId: string, versionId: string, name: string, description?: string): Promise<unknown> =>
  call(`/api/projects/${projectId}/versions/${versionId}`, "PATCH", { name, description });
export const deleteVersion = (projectId: string, versionId: string): Promise<unknown> => call(`/api/projects/${projectId}/versions/${versionId}`, "DELETE");

export interface Restored { restored: string; docs: { docId: string; path: string; seq: number }[] }
/** Restore a kept version (the whole project), or a point of the timeline (`scope: "document"` restores that file alone). */
export const restore = (projectId: string, what: { versionId: string } | { at: { docId: string; seq: number }; scope?: "document" | "project"; label?: string }): Promise<Restored> =>
  call(`/api/projects/${projectId}/restore`, "POST", what);

export const branches = (projectId: string): Promise<Branches> => call(`/api/projects/${projectId}/branches`);
/** Start a branch of the main line: from a kept version, a point of the timeline, or as it is now. */
export const createBranch = (mainProjectId: string, name: string, from: { versionId?: string; at?: { docId: string; seq: number }; description?: string } = {}): Promise<{ projectId: string; name: string }> =>
  call(`/api/projects/${mainProjectId}/branches`, "POST", { name, description: from.description || "", versionId: from.versionId, at: from.at });
export const deleteBranch = (projectId: string, branchProjectId: string): Promise<unknown> => call(`/api/projects/${projectId}/branches/${branchProjectId}`, "DELETE");

export interface MergeOptions {
  /** make the receiving side read exactly as the other one */
  replace?: boolean;
  /** who has the last word on a conflict not named in `choices` */
  prefer?: Side;
  /** conflict id → the side that wins it */
  choices?: { [conflictId: string]: Side };
}
/** What merging would do, and where the two sides touched the same thing.  Called on the branch. */
export const mergePlan = (branchProjectId: string, direction: MergePlan["direction"]): Promise<MergePlan> =>
  call(`/api/projects/${branchProjectId}/merge`, "POST", { direction, dryRun: true });
export const merge = (branchProjectId: string, direction: MergePlan["direction"], o: MergeOptions = {}): Promise<{ merged: boolean; summary: MergePlan }> =>
  call(`/api/projects/${branchProjectId}/merge`, "POST", { direction, mode: o.replace ? "replace" : "merge", prefer: o.prefer || "incoming", choices: o.choices || {} });

// ---------------------------------------------------------------- words

export const personName = (p: Person | null | undefined): string => (p ? p.name || p.login || "someone" : "someone");

/** "3 min ago", "yesterday 14:02", "12 Mar 2026". */
export function when(iso: string, now = Date.now()): string {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 50) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  const d = new Date(t), today = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === today.toDateString()) return `today ${hm}`;
  if (s < 86400 * 2 && new Date(now - 86400000).toDateString() === d.toDateString()) return `yesterday ${hm}`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" }) + ` ${hm}`;
}

/** How one side of a conflict reads, in a few words. */
export function didText(d: Did | undefined): string {
  if (!d) return "changed";
  switch (d.did) {
    case "removed": return "deleted";
    case "replaced": return "replaced";
    case "unset": return "cleared";
    case "changed": return "changed inside";
    case "set": { const v = typeof d.value === "string" ? d.value : JSON.stringify(d.value); return v.length > 60 ? v.slice(0, 57) + "…" : v; }
  }
}

/** One row of the history list: a kept version, or a run of edits of the open document. */
export type Entry =
  | { kind: "version"; key: string; at: string; version: Version; here: VersionDoc | null }
  | { kind: "run"; key: string; at: string; run: Run };

/** The list a History panel shows for one document, newest first: every kept version, and the document's own runs of edits. */
export function entriesFor(t: Timeline, docId: string): Entry[] {
  const out: Entry[] = [];
  for (const v of t.versions) out.push({ kind: "version", key: "v" + v.id, at: v.createdAt, version: v, here: v.docs.find((d) => d.docId === docId) || null });
  for (const r of t.runs) if (r.docId === docId) out.push({ kind: "run", key: `r${r.docId}:${r.to}`, at: r.endedAt, run: r });
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.kind === b.kind ? 0 : a.kind === "version" ? -1 : 1));
}
