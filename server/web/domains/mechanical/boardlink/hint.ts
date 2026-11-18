// hint.ts — "show me this over there": a note one editor leaves for the other when a tab switch is a jump from
// a board item to what drives it in the part studio, or back.  It lives in sessionStorage (this tab only) and
// is taken once by the editor of the document it names.
const KEY = "junction.boardlink.focus";

export interface FocusHint {
  /** the document that should act on it */
  doc: string;
  link?: string;
  drive?: string;
  /** part studio side: something of the board to draw in the model (a component as a wire box), as line segments: x, y, z of each end */
  box?: number[];
  /** and what to say about it */
  note?: string;
}

export function leaveHint(hint: FocusHint): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(hint)); } catch (e) { /* storage blocked: the tab still switches */ }
}

/** The hint for `docId`, removed; null when there is none (or it is for another document). */
export function takeHint(docId: string): FocusHint | null {
  try {
    const raw = sessionStorage.getItem(KEY); if (!raw) return null;
    const h = JSON.parse(raw) as FocusHint;
    if (!h || h.doc !== docId) return null;
    sessionStorage.removeItem(KEY);
    return h;
  } catch (e) { return null; }
}
