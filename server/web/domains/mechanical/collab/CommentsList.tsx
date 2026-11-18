// CommentsList.tsx — the Comments panel of a part studio: the threads of the document, open or resolved, each
// with what it is pinned to.  The cards are the electronics editor's (platform/review/review.css).
import { useState } from "react";
import { ago, cx } from "../../../shared/util";
import { useStudio } from "../ui/hooks";
import type { PartStudio } from "../ui/studio";
import type { Pick } from "../viewport/modelview";
import { showAnchor } from "./CommentPins";
import { pinPoint, type Composing, type PlatformComment } from "./comments";
import { useStore } from "./hooks";
import type { StudioCollab } from "./studio-collab";

type Tab = "open" | "resolved" | "all";
const NONE: PlatformComment[] = [];

/** What a comment started now would be about: the picked face, edge or vertex, else the selected feature. */
export function commentTarget(studio: PartStudio, c: StudioCollab, pick?: Pick | null): Composing | null {
  const s = studio.getState();
  const p = pick !== undefined ? pick : s.selection.find((x) => x.kind === "face" || x.kind === "edge" || x.kind === "vertex") || null;
  if (p && (p.kind === "face" || p.kind === "edge" || p.kind === "vertex")) {
    const made = c.meshes.get(p.body)?.createdBy || null;
    const of = s.bodies.find((b) => b.id === p.body)?.name || s.features.find((f) => f.id === made)?.name || "the model";
    return { target: { kind: p.kind, body: p.body, name: p.name }, point: p.point, label: `${p.kind === "face" ? "Face" : p.kind === "edge" ? "Edge" : "Vertex"} of ${of}`, createdBy: made };
  }
  if (pick === undefined && s.selectedFeature) {
    const f = s.features.find((x) => x.id === s.selectedFeature);
    if (f) return { target: { kind: "feature", featureId: f.id }, point: null, label: f.name, createdBy: null };
  }
  return null;
}

/** Start a comment: on what is selected, or (nothing selected) on the next thing clicked in the viewport. */
export function startComment(studio: PartStudio, c: StudioCollab): void {
  const now = commentTarget(studio, c);
  if (now) { c.comments.compose(now); return; }
  const done = () => { studio.view.pointerTool = null; studio.keyHandler = null; c.comments.setPicking(false); };
  if (c.comments.getState().picking) { done(); return; }
  c.comments.setPicking(true);
  studio.view.pointerTool = {
    up: (ev) => {
      const pick = studio.view.pick(ev);
      const target = pick ? commentTarget(studio, c, pick) : null;
      if (!target) { studio.host.toast("Click a face, an edge or a vertex of the model.", 2500); return; }
      done(); c.comments.compose(target);
    },
  };
  studio.keyHandler = (ev) => { if (ev.key !== "Escape") return false; done(); return true; };
  studio.viewport.canvas.focus();
}

export function CommentsList({ c }: { c: StudioCollab }) {
  const comments = useStore(c.comments, (s) => s.comments, NONE);
  const open = useStore(c.comments, (s) => s.open, null);
  const loaded = useStore(c.comments, (s) => s.loaded, false);
  const error = useStore(c.comments, (s) => s.error, null);
  const role = useStudio(c.studio, (s) => s.status.role);
  const sketch = useStudio(c.studio, (s) => !!s.sketch);
  useStudio(c.studio, (s) => s.bodies);
  const [tab, setTab] = useState<Tab>("open");
  const canComment = c.studio.host.signedIn && (role === "editor" || role === "commenter");
  const roots = comments.filter((x) => !x.parentId);
  const nOpen = roots.filter((x) => !x.resolved).length, nResolved = roots.length - nOpen;
  const shown = roots.filter((x) => (tab === "all" ? true : tab === "open" ? !x.resolved : x.resolved)).sort((a, b) => b.id - a.id);
  return (
    <div className="px-2 py-1.5 text-sm" id="cadComments" data-threads={roots.length}>
      <div className="cmt-tabs">
        <div className="seg" role="group" aria-label="Show">
          <button type="button" className={cx(tab === "open" && "on")} data-tab="open" onClick={() => setTab("open")}>Open<b>{nOpen}</b></button>
          <button type="button" className={cx(tab === "resolved" && "on")} data-tab="resolved" onClick={() => setTab("resolved")}>Resolved<b>{nResolved}</b></button>
          <button type="button" className={cx(tab === "all" && "on")} data-tab="all" onClick={() => setTab("all")}>All</button>
        </div>
        <span className="flex-1" />
        <button type="button" className="btn sm" data-add-comment disabled={!canComment || sketch}
          title={!canComment ? "Sign in with comment access to comment" : sketch ? "Finish the sketch first" : "Comment on the selected face, edge, vertex or feature; or click one after this"}
          onClick={() => startComment(c.studio, c)}>+ Add</button>
      </div>
      {error && !shown.length ? <p className="note m-0 text-err">{error}</p> : null}
      {shown.map((r) => {
        const replies = comments.filter((x) => x.parentId === r.id);
        const last = replies.length ? replies[replies.length - 1] : null;
        const pin = pinPoint(r, c.pins);
        const gone = !pin || pin.lost;
        return (
          <div key={r.id} className={cx("thread cmt-card", r.resolved && "resolved", open === r.id && "open")} data-thread={r.id}
            onClick={() => { c.comments.openThread(open === r.id ? null : r.id); if (open !== r.id) showAnchor(c, r); }}>
            <div className="top"><span className={cx("cmt-anchor", gone && r.anchor && "gone")} data-anchor={r.anchor ? "item" : "spot"}><i />{r.anchor?.label || "On the model"}</span><span className="when">{ago((last || r).createdAt)}</span></div>
            <div className="text">{r.body}</div>
            <div className="foot"><span>{r.authorLogin}{replies.length ? ` · ${replies.length} ${replies.length === 1 ? "reply" : "replies"}` : ""}</span><span>{r.resolved ? "resolved" : ""}</span></div>
          </div>
        );
      })}
      {loaded && !shown.length && !error ? <p className="note m-0">{roots.length
        ? (tab === "open" ? "No open comments on this part studio." : "No resolved comments on this part studio.")
        : "No comments yet. Select a face, an edge or a feature and choose Comment."}</p> : null}
      {!loaded ? <p className="note m-0">Loading…</p> : null}
    </div>
  );
}
