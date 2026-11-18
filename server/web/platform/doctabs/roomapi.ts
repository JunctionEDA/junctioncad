// roomapi.ts — the project room as the rest of the page sees it, and its pure parts.
//
// The project room (room.ts) is how the people who have one project open know about each other across its
// tabs: which tab each person is on, and that somebody added, renamed or deleted a document.  The shell starts
// one per page (DocTabs); a domain's editor bundle reads it through `projectRoom()`, because a bundle that
// imported room.ts would get a second copy of it.
import type { DocEntry } from "../../shared/store";

export interface RoomMember {
  /** the person's window: stable for as long as their page lives, the same whatever tab they are on */
  key: string;
  userId: number;
  login: string;
  name: string;
  /** the colour they have on every tab */
  color: string;
  /** the tab they are on: a document id, "home", or "bom:<PCB key>"; null before they have said */
  tab: string | null;
}

/** What somebody did to the project's documents, for the line that tells the others. */
export interface DocsNote { what: "added" | "renamed" | "deleted"; name: string }

export interface RoomState {
  /** false until the room has joined a document (a project with no part studio or assembly has no room) */
  live: boolean;
  me: { key: string; color: string } | null;
  /** everybody else in the project who can be seen from here */
  members: RoomMember[];
}

export interface ProjectRoomApi {
  getState(): RoomState;
  subscribe(fn: () => void): () => void;
}

/**
 * The server's notice that a document of the project was added, renamed or deleted (src/http.rs notify_docs).
 * It is sent to every open document of the project, so a page may hear it on several sockets (its editor's, the
 * room's): `tellDocsChanged` hands each notice on once, as a window event the document tabs listen for.
 */
export interface DocsNotice { n: string; projectId: string; note: DocsNote; by: { userId: number; login: string; name: string } }
export const DOCS_EVENT = "junction-project-docs";

const stem = (path: string): string => (path.split("/").pop() || path).replace(/\.[^.]+$/, "");

export function parseDocsNotice(msg: unknown): DocsNotice | null {
  const m = msg as { type?: unknown; n?: unknown; projectId?: unknown; change?: unknown; from?: unknown; doc?: { path?: unknown }; by?: { userId?: unknown; login?: unknown; name?: unknown } } | null;
  if (!m || m.type !== "docs" || typeof m.n !== "string" || typeof m.projectId !== "string" || !m.doc || typeof m.doc.path !== "string") return null;
  if (m.change !== "added" && m.change !== "renamed" && m.change !== "deleted") return null;
  const name = m.change === "renamed" && typeof m.from === "string" ? `${stem(m.from)} to ${stem(m.doc.path)}` : stem(m.doc.path);
  const login = m.by && typeof m.by.login === "string" ? m.by.login : "";
  return { n: m.n, projectId: m.projectId, note: { what: m.change, name: name.slice(0, 120) }, by: { userId: m.by && typeof m.by.userId === "number" ? m.by.userId : 0, login, name: (m.by && typeof m.by.name === "string" && m.by.name) || login || "Someone" } };
}

const told: string[] = [];
/** A socket of this page was sent a `docs` notice: tell the page, unless another socket already did. */
export function tellDocsChanged(msg: unknown): void {
  const notice = parseDocsNotice(msg);
  if (!notice || told.includes(notice.n) || typeof window === "undefined") return;
  told.push(notice.n); if (told.length > 50) told.shift();
  window.dispatchEvent(new CustomEvent(DOCS_EVENT, { detail: notice }));
}

declare global {
  interface Window { JunctionRoom?: ProjectRoomApi }
}

/** The page's project room, or null (the shell has not started one: no project is open). */
export function projectRoom(): ProjectRoomApi | null { return (typeof window !== "undefined" && window.JunctionRoom) || null; }

/** What a room's watcher says on the presence lane of the documents it has joined. */
export interface RoomPresence { room: 1; tab: string | null; col?: string; ts?: number }

export function parseRoomPresence(raw: unknown): RoomPresence | null {
  if (!raw || typeof raw !== "object" || (raw as { room?: unknown }).room !== 1) return null;
  const r = raw as { tab?: unknown };
  const out: RoomPresence = { room: 1, tab: typeof r.tab === "string" ? r.tab : null };
  const col = (raw as { col?: unknown }).col;
  if (typeof col === "string" && /^#[0-9a-fA-F]{6}$/.test(col)) out.col = col;
  return out;
}

/**
 * The colours the server hands out (src/ws.rs PEER_COLORS), one per socket from a counter, so two people in a
 * project often get the same one.  The room settles that among the people it can see (`pickColor`).
 */
export const ROOM_COLORS: readonly string[] = ["#e05d44", "#4477ee", "#22aa66", "#d4a017", "#9b59b6", "#e67e22", "#16a2b8", "#e83e8c"];

/**
 * The colour a person should have, given what the others have: their own unless somebody whose key sorts before
 * theirs has it too, and then the first that nobody has (their own again when every colour is taken).  Everybody
 * applies the same rule, so of two people with one colour exactly one changes.
 */
export function pickColor(mine: { key: string; color: string }, others: readonly { key: string; color: string }[]): string {
  if (!others.some((o) => o.color === mine.color && o.key < mine.key)) return mine.color;
  const taken = new Set(others.map((o) => o.color));
  return ROOM_COLORS.find((c) => !taken.has(c)) || mine.color;
}

/**
 * The document types whose sessions carry a room: the JSON item documents (no KiCad client ever joins one).  The
 * project's own document (server/src/shell.rs) is one, and the room's first choice: every project that has it
 * has a room, whatever else it holds.
 */
export const ROOM_DOC_TYPES: readonly string[] = ["project_shell", "part_studio", "assembly"];
/** How many documents a room joins at most. */
export const ROOM_DOCS_MAX = 4;

/**
 * The documents a room joins: the first few item documents in id order.  Everybody picks by the same rule, so
 * two people whose lists differ by a document that was just added or deleted still share one, and the news
 * of the change reaches them through it.
 */
export function roomDocs(docs: readonly Pick<DocEntry, "docId" | "docType">[]): string[] {
  const first = (d: Pick<DocEntry, "docType">): number => (d.docType === "project_shell" ? 0 : 1);
  return docs.filter((d) => ROOM_DOC_TYPES.includes(d.docType)).sort((a, b) => first(a) - first(b) || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0)).map((d) => d.docId).slice(0, ROOM_DOCS_MAX);
}

/** The tab a member is shown on: their document's own tab, or the schematic's tab for any sheet of it. */
export function tabOf(member: RoomMember, docs: readonly Pick<DocEntry, "docId" | "docType">[], tabIds: readonly string[], rootDocId: string | null): string | null {
  if (!member.tab) return null;
  if (tabIds.includes(member.tab)) return member.tab;
  const doc = docs.find((d) => d.docId === member.tab);
  return doc && doc.docType === "kicad_sch" && rootDocId && tabIds.includes(rootDocId) ? rootDocId : null;
}

/** "Ada added Part Studio 2", for the toast the others get. */
export function noteText(who: string, note: DocsNote): string { return `${who} ${note.what} ${note.name}`; }
