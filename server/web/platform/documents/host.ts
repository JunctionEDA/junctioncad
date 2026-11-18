// host.ts — how a document that is not KiCad's gets an editor: the contract between the app shell and a
// domain's editor bundle.
//
// The shell (today the electronics editor's boot code, web/domains/pcb/editor/dochost.ts) owns the page: the
// menu bar, the document tabs, the status bar, routing.  When a tab whose document type it does not draw itself
// is opened, it loads the bundle the domain registry names for that type (web/domains/registry.ts), which
// registers a DocumentEditorFactory here, and calls `open` with an empty element to fill.  Closing the tab, or
// switching to another, calls `close` on what `open` returned.  Nothing else is shared: an editor bundle brings
// its own code and talks to the server itself (web/shared/itemdoc/sync.ts for JSON item documents).
export interface DocumentHostContext {
  /** The element to draw in.  It fills the page between the menu bar and the document tabs; empty on entry. */
  el: HTMLElement;
  project: { projectId: string; name: string };
  doc: { docId: string; path: string; docType: string };
  /** every document of the project, for editors that read other documents (an assembly reads parts and boards) */
  docs: { docId: string; path: string; docType: string }[];
  /** false for a guest, who may only watch */
  signedIn: boolean;
  /** the id of the signed-in person, when there is one */
  userId: number | null;
  /** Show the connection in the status bar: "live", "offline" or "error", and a few words. */
  setConnection(state: "live" | "offline" | "error", text: string): void;
  /** A short message at the bottom of the window. */
  toast(text: string, ms?: number): void;
  /** Open another document of the project in its own editor (a tab switch). */
  openDoc(docId: string): void;
}

export interface DocumentEditor {
  /** Stop everything and leave `el` empty: sockets closed, workers stopped, listeners removed. */
  close(): void;
}

export interface DocumentEditorFactory {
  /** the server's document types this editor opens ("part_studio") */
  docTypes: string[];
  open(ctx: DocumentHostContext): DocumentEditor | Promise<DocumentEditor>;
}

declare global {
  interface Window { JunctionDocEditors?: DocumentEditorFactory[] }
}

/** Called by an editor bundle as it loads. */
export function registerDocumentEditor(factory: DocumentEditorFactory): void {
  const list = (window.JunctionDocEditors = window.JunctionDocEditors || []);
  for (const t of factory.docTypes) { const i = list.findIndex((f) => f.docTypes.includes(t)); if (i >= 0) list.splice(i, 1); }
  list.push(factory);
}

export function documentEditorFor(docType: string): DocumentEditorFactory | undefined {
  return (window.JunctionDocEditors || []).find((f) => f.docTypes.includes(docType));
}
