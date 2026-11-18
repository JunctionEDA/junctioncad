// CommentPins.tsx — comment threads in the viewport: a pin on the geometry each thread is about, the thread
// that is open beside its pin (the electronics editor's thread panel: same parts, same classes), and the box a
// new comment is written in.
//
// A pin is placed every frame from where its geometry is now (comments.ts pinPoint), so it turns with the model
// and follows its face through rebuilds.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { ago, cx } from "../../../shared/util";
import { useStudio } from "../ui/hooks";
import type { PartStudio } from "../ui/studio";
import { targetOf } from "./anchor";
import { pinPoint, type PlatformComment } from "./comments";
import { useStore } from "./hooks";
import type { V3 } from "./presence";
import type { StudioCollab } from "./studio-collab";

const NONE: PlatformComment[] = [];

/** Run `fn` before every frame of the studio's viewport, and once now. */
function useFrame(studio: PartStudio, fn: () => void): void {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => {
    const run = () => ref.current();
    studio.viewport.onFrame.push(run);
    run();
    return () => { const i = studio.viewport.onFrame.indexOf(run); if (i >= 0) studio.viewport.onFrame.splice(i, 1); };
  }, [studio]);
  useEffect(() => { ref.current(); });
}

/** Select what a thread is pinned to, so it lights up in the viewport and the feature list. */
export function showAnchor(c: StudioCollab, root: PlatformComment): void {
  const t = targetOf(root.anchor); if (!t) return;
  if (t.kind === "feature") { if (c.pins.hasFeature(t.featureId)) c.studio.selectFeature(t.featureId); return; }
  const pin = pinPoint(root, c.pins);
  if (pin && !pin.lost && !c.studio.getState().sketch && !c.studio.getState().editing) c.studio.select([{ kind: t.kind, body: t.body, name: t.name, point: pin.point }]);
}

function Thread({ c, root, all, canComment, me }: { c: StudioCollab; root: PlatformComment; all: PlatformComment[]; canComment: boolean; me: number | null }) {
  const [text, setText] = useState("");
  const busy = useStore(c.comments, (s) => s.busy, false);
  const error = useStore(c.comments, (s) => s.error, null);
  const replies = all.filter((x) => x.parentId === root.id);
  const pin = pinPoint(root, c.pins);
  const send = async () => { const body = text.trim(); if (body && (await c.comments.reply(root.id, body))) setText(""); };
  return (
    <div className="cad-thread flex flex-col w-[300px] max-h-[360px] overflow-hidden rounded-md border border-line bg-panel shadow-panel text-sm" data-thread-open={root.id} onPointerDown={(ev) => ev.stopPropagation()}>
      <div className="cmt-head">
        <span className={cx("cmt-anchor", pin && pin.lost && "gone")}><i />{root.anchor?.label || "On the model"}</span>
        <span className="cmt-state">{root.resolved ? "resolved" : ""}</span>
        <button type="button" className="cmt-x" aria-label="Close" onClick={() => c.comments.openThread(null)}>×</button>
      </div>
      {pin && pin.lost ? <div className="cmt-gone">What this was pinned to is no longer in the model. The pin stays where the thread was started.</div> : null}
      <div className="cmt-list">
        {[root, ...replies].map((m) => (
          <div className="cmt-item" key={m.id} data-comment={m.id}>
            <div className="meta"><b>{m.authorLogin}</b><span>{ago(m.createdAt)}</span>
              <span className="acts">{me !== null && m.authorId === me ? <button type="button" className="del" onClick={() => void c.comments.remove(m.id)}>delete</button> : null}</span>
            </div>
            <p className="cbody">{m.body}</p>
          </div>
        ))}
      </div>
      {canComment ? (
        <form className="cmt-form" onSubmit={(ev) => { ev.preventDefault(); void send(); }}>
          <textarea value={text} placeholder="Reply…" aria-label="Reply" onChange={(ev) => setText(ev.target.value)}
            onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); void send(); } }} />
          {error ? <p className="m-0 mt-1 text-err text-xs" role="alert">{error}</p> : null}
          <div className="row">
            <button type="button" className="btn sm" data-resolve onClick={() => void c.comments.resolve(root.id, !root.resolved)}>{root.resolved ? "Reopen" : "Resolve"}</button>
            <span className="grow" />
            <button type="submit" className="btn sm primary" disabled={busy || !text.trim()}>Reply</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function Composer({ c }: { c: StudioCollab }) {
  const composing = useStore(c.comments, (s) => s.composing, null);
  const busy = useStore(c.comments, (s) => s.busy, false);
  const error = useStore(c.comments, (s) => s.error, null);
  const [text, setText] = useState("");
  useEffect(() => { setText(""); }, [composing]);
  if (!composing) return null;
  const send = async () => { const body = text.trim(); if (body) await c.comments.post(body); };
  return (
    <form className="cad-compose flex flex-col w-[280px] rounded-md border border-line bg-panel shadow-panel text-sm" data-compose onPointerDown={(ev) => ev.stopPropagation()}
      onSubmit={(ev) => { ev.preventDefault(); void send(); }}>
      <div className="cmt-head"><span className="cmt-anchor"><i />{composing.label}</span><button type="button" className="cmt-x" aria-label="Cancel" onClick={() => c.comments.compose(null)}>×</button></div>
      <div className="cmt-form">
        <textarea autoFocus value={text} placeholder="Write a comment…" aria-label="Comment" onChange={(ev) => setText(ev.target.value)}
          onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Escape") c.comments.compose(null); if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); void send(); } }} />
        {error ? <p className="m-0 mt-1 text-err text-xs" role="alert">{error}</p> : null}
        <div className="row"><span className="hint grow">Ctrl + Enter posts</span><button type="submit" className="btn sm primary" disabled={busy || !text.trim()}>Comment</button></div>
      </div>
    </form>
  );
}

export function CommentPins({ c }: { c: StudioCollab }) {
  const comments = useStore(c.comments, (s) => s.comments, NONE);
  const open = useStore(c.comments, (s) => s.open, null);
  const composing = useStore(c.comments, (s) => s.composing, null);
  const picking = useStore(c.comments, (s) => s.picking, false);
  const role = useStudio(c.studio, (s) => s.status.role);
  // the pins move with the model's rebuilds as well as with the camera
  useStudio(c.studio, (s) => s.bodies); useStudio(c.studio, (s) => s.features);
  const canComment = c.studio.host.signedIn && (role === "editor" || role === "commenter");
  const layer = useRef<HTMLDivElement>(null);
  const roots = comments.filter((x) => !x.parentId && (!x.resolved || x.id === open));
  const points = new Map<string, V3>();
  const lost = new Set<number>();
  for (const r of roots) { const pin = pinPoint(r, c.pins); if (pin) { points.set("pin:" + r.id, pin.point); if (pin.lost) lost.add(r.id); } }
  if (composing && composing.point) points.set("compose", composing.point);
  const place = () => {
    const el = layer.current; if (!el) return;
    const w = c.studio.viewport.width, h = c.studio.viewport.height;
    for (const node of Array.from(el.children) as HTMLElement[]) {
      const p = points.get(node.dataset.at || "");
      if (!p) { node.style.display = "none"; continue; }
      const s = c.studio.viewport.project(new THREE.Vector3(...p));
      const pop = node.dataset.pop === "1";
      // a pin may leave the window; a panel is kept inside it
      const x = pop ? Math.max(8, Math.min(w - 312, s.x + 14)) : s.x, y = pop ? Math.max(8, Math.min(h - 200, s.y - 10)) : s.y;
      node.style.display = !pop && (s.x < 0 || s.y < 0 || s.x > w || s.y > h) ? "none" : "";
      node.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
    }
  };
  useFrame(c.studio, place);
  const openRoot = open !== null ? roots.find((r) => r.id === open) : undefined;
  return (
    <>
      <div ref={layer} className="cad-pins absolute inset-0 z-[3] overflow-hidden pointer-events-none">
        {roots.map((r, i) => points.has("pin:" + r.id) ? (
          <button key={r.id} type="button" data-at={"pin:" + r.id} data-pin={r.id} data-pin-lost={lost.has(r.id) || undefined}
            className={cx("absolute left-0 top-0 -ml-2.5 -mt-6 w-5 h-5 grid place-items-center rounded-[50%_50%_50%_2px] border border-paper text-2xs font-semibold font-mono cursor-pointer pointer-events-auto", (r.resolved || lost.has(r.id)) && "opacity-55", open === r.id && "outline outline-2 outline-offset-1 outline-ink")}
            style={{ background: "var(--mark)", color: "var(--canvas)" }}
            title={`${r.authorLogin}: ${r.body.slice(0, 80)}`}
            onClick={() => { c.comments.openThread(open === r.id ? null : r.id); if (open !== r.id) showAnchor(c, r); }}>{i + 1}</button>
        ) : null)}
        {openRoot && points.has("pin:" + openRoot.id) ? (
          <div data-at={"pin:" + openRoot.id} data-pop="1" className="absolute left-0 top-0 pointer-events-auto">
            <Thread c={c} root={openRoot} all={comments} canComment={canComment} me={c.studio.host.userId} />
          </div>
        ) : null}
        {composing && composing.point ? (
          <div data-at="compose" data-pop="1" className="absolute left-0 top-0 pointer-events-auto"><Composer c={c} /></div>
        ) : null}
      </div>
      {openRoot && !points.has("pin:" + openRoot.id) ? (
        <div className="absolute right-2 bottom-2 z-[4]"><Thread c={c} root={openRoot} all={comments} canComment={canComment} me={c.studio.host.userId} /></div>
      ) : null}
      {composing && !composing.point ? <div className="absolute right-2 bottom-2 z-[4]"><Composer c={c} /></div> : null}
      {picking ? <div className="absolute left-1/2 bottom-3 z-[3] -translate-x-1/2 px-2 py-0.5 rounded-sm border border-line bg-panel text-ink-2 text-xs pointer-events-none" role="status" data-comment-picking>Click a face, an edge or a vertex to comment on it. Esc cancels.</div> : null}
    </>
  );
}
