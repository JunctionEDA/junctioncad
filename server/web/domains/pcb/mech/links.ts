// mech/links.ts — the part studios of the project, watched from the board editor.
//
// A part studio drives a board through a "board-link" item (mechanical/boardlink/format.ts) that holds the
// board geometry it asks for.  This opens a live session (shared/itemdoc/sync.ts) on every part studio of the
// project while a board is open, and reports the links that name that board whenever one changes.  The same
// sessions carry the one edit the board editor makes to a part studio: breaking a link.
//
// Nothing here runs the kernel; reading a link is reading JSON.
import type { ItemDoc } from "../../../shared/itemdoc/itemdoc";
import { ItemDocSession } from "../../../shared/itemdoc/sync";
import { PART_STUDIO_KIND, linksOf, removeDrive, removeLink, type BoardLinkItem } from "../../mechanical/api";
import type { LinkSource } from "./boarditems";

export interface ProjectDoc { docId: string; path: string; docType: string }
const STUDIO_DOC_TYPE = "part_studio";
/** more part studios than this are not all watched, and nothing is then released for want of a link */
const MAX_STUDIOS = 12;
const nameOf = (path: string) => (path.split("/").pop() || path).replace(/\.[^.]+$/, "");

interface Watched { doc: ProjectDoc; session: ItemDocSession; loaded: boolean; failed: boolean; /** counts the changes of the document */ version: number }

export class LinkWatch {
  private watched = new Map<string, Watched>();
  private listeners = new Set<() => void>();
  private truncated = false;
  boardId = "";

  /** whether the person is signed in (what a reader of another document of the project needs to know) */
  signedIn = false;
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private notify(): void { for (const fn of Array.from(this.listeners)) { try { fn(); } catch (e) { console.warn(e); } } }

  /** Watch the part studios among `docs` for links to `boardId`.  Calling it again with the same board keeps the sessions. */
  start(boardId: string, docs: readonly ProjectDoc[], signedIn: boolean): void {
    this.signedIn = signedIn;
    const studios = docs.filter((d) => d.docType === STUDIO_DOC_TYPE);
    this.truncated = studios.length > MAX_STUDIOS;
    const want = new Map(studios.slice(0, MAX_STUDIOS).map((d) => [d.docId, d]));
    if (boardId !== this.boardId) { this.stop(); this.boardId = boardId; }
    let changed = false;
    for (const [id, w] of Array.from(this.watched)) if (!want.has(id)) { w.session.close(); this.watched.delete(id); changed = true; }
    for (const [id, doc] of want) {
      const old = this.watched.get(id);
      if (old) { old.doc = doc; continue; }
      const w: Watched = { doc, loaded: false, failed: false, version: 0, session: null as unknown as ItemDocSession };
      w.session = new ItemDocSession({
        docId: id, signedIn, expectKind: PART_STUDIO_KIND,
        onChange: () => { w.loaded = true; w.failed = false; w.version++; this.notify(); },
        onStatus: (s) => { if (s.state === "error" && !w.loaded) { w.failed = true; this.notify(); } },
      });
      this.watched.set(id, w);
      w.session.start();
      changed = true;
    }
    if (changed) this.notify();
  }

  stop(): void {
    for (const w of this.watched.values()) w.session.close();
    this.watched.clear(); this.boardId = "";
  }

  /** Every part studio of the project has been read: a driven item no link asks for has really lost its link. */
  get complete(): boolean {
    if (this.truncated) return false;
    for (const w of this.watched.values()) if (!w.loaded) return false;
    return true;
  }
  get studioCount(): number { return this.watched.size; }

  /** The links that drive the open board, in a fixed order. */
  sources(): LinkSource[] {
    const out: LinkSource[] = [];
    for (const w of this.watched.values()) {
      const doc = w.session.doc; if (!w.loaded || !doc) continue;
      for (const link of linksOf(doc, this.boardId)) out.push({ link, studio: nameOf(w.doc.path), studioDoc: w.doc.docId });
    }
    return out.sort((a, b) => (a.link.id < b.link.id ? -1 : a.link.id > b.link.id ? 1 : 0));
  }

  /** A number that changes whenever that part studio's document does. */
  version(studioDocId: string): number { return this.watched.get(studioDocId)?.version || 0; }
  /** The part studio document a link lives in, as it is now. */
  studioDoc(studioDocId: string): ItemDoc | null { return this.watched.get(studioDocId)?.session.doc || null; }
  canEdit(studioDocId: string): boolean { return !!this.watched.get(studioDocId)?.session.status.canEdit; }

  /** Stop a drive (or, with no drive, the whole link) from driving the board: an edit of the part studio. */
  breakLink(studioDocId: string, link: BoardLinkItem, driveId?: string): boolean {
    const w = this.watched.get(studioDocId); if (!w || !w.session.doc) return false;
    const changes = driveId ? removeDrive(w.session.doc, link.id, driveId) : removeLink(w.session.doc, link.id);
    return w.session.commit(changes);
  }
  /** Take the last break back (the session's own undo). */
  undoBreak(studioDocId: string): boolean { return !!this.watched.get(studioDocId)?.session.undo(); }
}
