// shell.ts — the project's own document, live: the order of the tabs and the empty folders, shared by everybody
// who has the project open.  The format and the pure parts are in elements.ts; the server makes the document
// (server/src/shell.rs).
//
// The document tabs keep one `ProjectShell` for as long as a project is open (`window.JunctionShell`); the Home
// tab reads the same one.  A project from before this has no such document until somebody first reorders a tab
// or makes a folder: `commit` asks the server for it then (`onNeedDoc`), so merely opening an old project adds
// nothing to it.
import { ItemDocSession } from "../../shared/itemdoc/sync";
import type { Item, ItemChange } from "../../shared/itemdoc/itemdoc";
import { SHELL_KIND } from "./elements";

export interface ShellState {
  /** the document's items; empty until it is loaded, and in a project that has no such document */
  items: Item[];
  /** the document is loaded and edits reach the others */
  live: boolean;
  /** bumped on every change */
  version: number;
}

export interface ShellOptions {
  signedIn: boolean;
  /** The project has no document of its own yet and an edit needs one: make it and answer with its id. */
  onNeedDoc(): Promise<string>;
  /** test seams */
  socketUrl?: string; fetchTicket?: () => Promise<string>; WebSocketImpl?: typeof WebSocket;
}

const EMPTY: ShellState = { items: [], live: false, version: 0 };

export class ProjectShell {
  private state: ShellState = EMPTY;
  private listeners = new Set<() => void>();
  private session: ItemDocSession | null = null;
  private docId: string | null = null;
  private waiting: ItemChange[][] = [];
  private closed = false;

  constructor(private readonly opts: ShellOptions) {}

  getState = (): ShellState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };

  /** The project's own document, once the project's list has one (null: it has none). */
  setDoc(docId: string | null): void {
    if (docId === this.docId || this.closed) return;
    this.docId = docId;
    if (this.session) { this.session.close(); this.session = null; }
    if (!docId) { this.publish(false); return; }
    const session = new ItemDocSession({
      docId, signedIn: this.opts.signedIn, expectKind: SHELL_KIND,
      onChange: () => { if (this.session === session) { this.flush(); this.publish(true); } },
      onStatus: (s) => { if (this.session === session) { this.flush(); this.publish(s.state === "live"); } },
      socketUrl: this.opts.socketUrl, fetchTicket: this.opts.fetchTicket, WebSocketImpl: this.opts.WebSocketImpl,
    });
    this.session = session;
    session.start();
  }

  /** Change the document.  In a project that has none yet it is made first; the changes follow when it has loaded. */
  commit(changes: ItemChange[]): void {
    if (!changes.length || this.closed) return;
    if (this.session && this.session.doc) { this.session.commit(changes, { undoable: false }); return; }
    this.waiting.push(changes);
    if (!this.docId) void this.opts.onNeedDoc().then((id) => this.setDoc(id)).catch((e) => { this.waiting.length = 0; console.warn(e); });
  }

  close(): void {
    this.closed = true;
    if (this.session) this.session.close();
    this.session = null; this.listeners.clear();
  }

  private flush(): void {
    const s = this.session;
    if (!s || !s.doc || !s.status.canEdit || !this.waiting.length) return;
    const all = this.waiting.splice(0);
    for (const changes of all) s.commit(changes, { undoable: false });
  }

  private publish(live: boolean): void {
    const doc = this.session && this.session.doc;
    this.state = { items: doc ? Array.from(doc.items.values()) : [], live: !!doc && live, version: this.state.version + 1 };
    for (const fn of Array.from(this.listeners)) fn();
  }
}

declare global { interface Window { JunctionShell?: ProjectShell } }
