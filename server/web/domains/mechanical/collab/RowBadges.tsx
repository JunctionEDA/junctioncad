// RowBadges.tsx — what collaboration adds to a row of the feature list (ui/slots.ts): a dot for each person who
// has the feature selected, a ringed dot with a pencil for each person who has it open, and the number of open
// comment threads on it.
import { targetOf } from "./anchor";
import type { PlatformComment } from "./comments";
import { useCollab, useStore } from "./hooks";
import type { Collaborator } from "./presence";
import type { PartStudio } from "../ui/studio";

const NONE: Collaborator[] = [];
const NO_COMMENTS: PlatformComment[] = [];

export function RowPeople({ studio, featureId }: { studio: PartStudio; featureId: string }) {
  const c = useCollab(studio);
  const people = useStore(c?.collab, (s) => s.people, NONE);
  const editing = people.filter((p) => p.state.edit && p.state.edit.id === featureId);
  const looking = people.filter((p) => p.state.feat === featureId && !editing.includes(p));
  if (!editing.length && !looking.length) return null;
  return (
    <span className="flex flex-none items-center gap-0.5" data-row-people={[...editing, ...looking].map((p) => p.login).join(" ")}>
      {editing.map((p) => (
        <span key={p.cid} className="flex items-center gap-0.5 pl-0.5 pr-1 h-4 rounded-full text-2xs font-mono border" data-row-editing={p.login}
          style={{ borderColor: p.color || "var(--mark)" }} title={`${p.name} is ${p.state.edit!.kind === "sketch" ? "drawing in this sketch" : "editing this feature"}`}>
          <i className="block w-2 h-2 rounded-full" style={{ background: p.color || "var(--mark)" }} />
          <svg width={9} height={9} viewBox="0 0 24 24" aria-hidden="true" className="fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round]" strokeWidth={2.4}><path d="M4 20l1-5L16 4l4 4L9 19z" /></svg>
        </span>
      ))}
      {looking.map((p) => <i key={p.cid} className="block w-2 h-2 rounded-full" data-row-selected={p.login} style={{ background: p.color || "var(--mark)" }} title={`${p.name} has this selected`} />)}
    </span>
  );
}

export function RowComments({ studio, featureId }: { studio: PartStudio; featureId: string }) {
  const c = useCollab(studio);
  const comments = useStore(c?.comments, (s) => s.comments, NO_COMMENTS);
  const threads = comments.filter((x) => { if (x.parentId || x.resolved) return false; const t = targetOf(x.anchor); return !!t && t.kind === "feature" && t.featureId === featureId; });
  if (!threads.length || !c) return null;
  return (
    <button type="button" className="flex flex-none items-center gap-0.5 px-1 h-4 rounded-xs border-0 text-2xs font-mono font-semibold cursor-pointer" data-row-comments={threads.length}
      style={{ background: "var(--mark)", color: "var(--canvas)" }} title={`${threads.length} open ${threads.length === 1 ? "comment" : "comments"}`}
      onClick={(ev) => { ev.stopPropagation(); c.comments.openThread(threads[threads.length - 1].id); }}>{threads.length}</button>
  );
}
