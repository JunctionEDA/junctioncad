// history/index.tsx — version history in the part studio: the drawer (web/platform/history/HistoryDrawer.tsx)
// beside the viewport, and an earlier version of the part on screen.
//
// Looking at an earlier version asks the server for the document at that point (the stored file and the edits
// up to there), builds it with the same code the live session uses, and hands it to the studio in place of the
// live document (`studio.showPast`).  The kernel regenerates from it, so what is on screen is the part as it
// was, feature tree and all, and nothing can be edited until "Back to current".  Restoring goes to the server,
// which puts that state at the head of the document for everyone; the live session reloads by itself.
//
// The state of this piece of interface (drawer open, which point is on screen) is kept in the studio's `ui`
// bag under "history", so the toolbar button and anything else can read it.
import { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HistoryDrawer, type HistoryHost, type Viewing } from "../../../platform/history/HistoryDrawer";
import { itemDocAt } from "../../../platform/history/api";
import { onHostedHistory } from "../../../platform/history/request";
import { PART_STUDIO_KIND } from "../document/format";
import { useStudio } from "../ui/hooks";
import type { PartStudio, StudioState } from "../ui/studio";

export interface HistoryUi { open: boolean; viewing: Viewing | null; loading: boolean }
const NONE: HistoryUi = { open: false, viewing: null, loading: false };
export const historyUi = (s: StudioState): HistoryUi => ((s.ui && (s.ui.history as HistoryUi)) || NONE);
const put = (studio: PartStudio, patch: Partial<HistoryUi>): void => studio.setUi({ history: { ...historyUi(studio.getState()), ...patch } });

interface Mounted { root: Root; el: HTMLElement; host: HTMLElement }
const mounted = new WeakMap<PartStudio, Mounted>();
let asked = 0;

/** Show the part as it was at a point of its history; null brings the live document back. */
export async function viewPast(studio: PartStudio, at: Viewing | null): Promise<void> {
  mount(studio);
  const mine = ++asked;
  if (!at) { studio.showPast(null); put(studio, { viewing: null, loading: false }); return; }
  put(studio, { viewing: at, loading: true });
  try {
    const got = await itemDocAt(studio.host.doc.docId, at.seq, PART_STUDIO_KIND);
    if (mine !== asked) return;
    studio.showPast(got.doc, at.label);
    put(studio, { loading: false });
  } catch (e) {
    if (mine !== asked) return;
    studio.showPast(null); put(studio, { viewing: null, loading: false });
    studio.host.toast(`That version could not be shown: ${e instanceof Error ? e.message : String(e)}`, 5000);
  }
}

export function toggleHistory(studio: PartStudio, open?: boolean): void {
  mount(studio);
  put(studio, { open: open === undefined ? !historyUi(studio.getState()).open : open });
}

function compare(studio: PartStudio, at: Viewing): void {
  const review = (window as unknown as { CollabReview?: { openCompare?(o: unknown): void } }).CollabReview;
  const docId = studio.host.doc.docId;
  if (!review || !review.openCompare) { studio.host.toast("Compare is not available in this build."); return; }
  review.openCompare({ docId, a: { kind: "at", docId, seq: at.seq, label: at.label }, b: { kind: "at", docId, seq: "head", label: "Current" } });
}

function Overlay({ studio, canvasHost }: { studio: PartStudio; canvasHost: HTMLElement }) {
  const ui = useStudio(studio, historyUi);
  const past = useStudio(studio, (s) => s.past);
  const canEdit = useStudio(studio, (s) => s.status.canEdit);
  // the viewport gives the drawer its room, so the view buttons stay reachable
  useEffect(() => { canvasHost.style.right = ui.open ? "20rem" : "0"; }, [canvasHost, ui.open]);
  const host: HistoryHost = {
    projectId: studio.host.project.projectId, doc: studio.host.doc, canEdit, signedIn: studio.host.signedIn,
    viewing: ui.viewing,
    view: (at) => { void viewPast(studio, at); },
    compare: (at) => compare(studio, at),
    toast: (text, ms) => studio.host.toast(text, ms),
    navigate: (url) => { window.location.assign(url); },
    close: () => toggleHistory(studio, false),
  };
  return (
    <>
      {ui.viewing ? (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[3] flex items-center gap-2 px-2.5 py-1 rounded-sm border border-line bg-panel shadow-panel text-sm pointer-events-auto" style={{ marginLeft: ui.open ? "-10rem" : 0 }} role="status" data-history-banner>
          <span className="w-2 h-2 rounded-full bg-warn flex-none" />
          <span className="truncate max-w-80">{ui.loading ? "Opening " : "Viewing "}<b>{ui.viewing.label}</b>{past ? " · read-only" : ""}</span>
          {!ui.open ? <button type="button" className="btn sm" onClick={() => toggleHistory(studio, true)}>History</button> : null}
          <button type="button" className="btn sm primary" data-history-back onClick={() => { void viewPast(studio, null); }}>Back to current</button>
        </div>
      ) : null}
      {ui.open ? <div className="absolute top-0 right-0 bottom-0 z-[3]"><HistoryDrawer host={host} /></div> : null}
    </>
  );
}

function mount(studio: PartStudio): void {
  if (mounted.has(studio)) return;
  const canvasHost = studio.viewport.canvas.parentElement as HTMLElement | null;
  const stage = canvasHost && canvasHost.parentElement;
  if (!canvasHost || !stage) return;
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:3";
  stage.appendChild(el);
  const root = createRoot(el);
  mounted.set(studio, { root, el, host: canvasHost });
  root.render(<Overlay studio={studio} canvasHost={canvasHost} />);
}

/**
 * Show a point of the history somebody asked for from outside this editor (the electronics editor's History
 * pane lists every document's edits): once the document has loaded, the drawer opens on that point.
 */
export function followHistoryRequests(studio: PartStudio): () => void {
  return onHostedHistory(studio.host.doc.docId, (req) => {
    const go = () => { toggleHistory(studio, true); void viewPast(studio, { seq: req.seq, label: req.label || `edit ${req.seq}` }); };
    if (studio.getState().loaded) { go(); return; }
    const off = studio.subscribe(() => { if (studio.getState().loaded) { off(); go(); } });
  });
}

/** Called when the part studio closes. */
export function disposeHistory(studio: PartStudio): void {
  const m = mounted.get(studio); if (!m) return;
  mounted.delete(studio);
  m.host.style.right = "0";
  m.root.unmount(); m.el.remove();
}
