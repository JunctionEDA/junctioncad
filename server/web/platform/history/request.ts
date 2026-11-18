// history/request.ts — asking the editor of a document to show a point of that document's history.
//
// The electronics editor's History pane lists the edits of every document of the project, also of the ones a
// domain's own editor draws.  Picking such an edit opens the document's tab; the request waits here until that
// editor (another bundle, loaded on demand) is up and takes it.  One request at a time: a newer one replaces it.
export interface HistoryRequest { docId: string; seq: number; label?: string }

declare global {
  interface Window { JunctionHistoryRequest?: HistoryRequest | null }
}
const EVENT = "junction-history-request";

/** Ask for a point of a document's history to be shown by that document's editor. */
export function askHostedHistory(req: HistoryRequest): void {
  window.JunctionHistoryRequest = req;
  window.dispatchEvent(new CustomEvent(EVENT));
}

/**
 * Take the requests for `docId`: one already waiting is handed over at once, later ones as they come.
 * Returns what stops listening.
 */
export function onHostedHistory(docId: string, take: (req: HistoryRequest) => void): () => void {
  const look = () => {
    const req = window.JunctionHistoryRequest;
    if (!req || req.docId !== docId) return;
    window.JunctionHistoryRequest = null;
    take(req);
  };
  window.addEventListener(EVENT, look);
  look();
  return () => window.removeEventListener(EVENT, look);
}
