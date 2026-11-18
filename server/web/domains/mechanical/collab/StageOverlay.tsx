// StageOverlay.tsx — what collaboration puts over the viewport: the avatars of the people in the document
// (click one to follow), the frame that says whose view one is following, and the notices of the edit guard:
// who else has this feature open, whose values conflict with mine, and a deleted feature offered back.
import { cx } from "../../../shared/util";
import { useStudio } from "../ui/hooks";
import { Avatars, FollowFrame } from "./Avatars";
import { useStore } from "./hooks";
import type { DraftConflict, Rescue } from "./guard";
import { showValue } from "./merge";
import { nameList, type Collaborator } from "./presence";
import type { StudioCollab } from "./studio-collab";

const NONE: Collaborator[] = [];
const NO_CONFLICTS: DraftConflict[] = [];


function ConflictRow({ c, k }: { c: StudioCollab; k: DraftConflict }) {
  return (
    <div className="callout warn m-0 flex flex-col gap-1" role="alert" data-conflict={k.path.join(".")}>
      <span>{k.by} changed {k.label} to <b className="font-mono">{showValue(k.theirs)}</b> while you were editing it. Done will replace it with yours (<b className="font-mono">{showValue(k.mine)}</b>).</span>
      <span className="flex gap-1.5">
        <button type="button" className="btn sm" data-take-theirs onClick={() => c.guard.takeTheirs(k)}>Use {k.by}'s</button>
        <button type="button" className="btn sm ghost" data-keep-mine onClick={() => c.guard.keepMine(k)}>Keep mine</button>
      </span>
    </div>
  );
}

function RescueRow({ c, r }: { c: StudioCollab; r: Rescue }) {
  const canEdit = useStudio(c.studio, (s) => s.canEdit);
  const what = r.was === "dialog" ? "while you were editing it" : r.was === "sketch" ? "while you had it open" : "just after you changed it";
  return (
    <div className="callout err m-0 flex flex-col gap-1" role="alert" data-rescue={r.item.id}>
      <span>{r.by} deleted <b>{r.item.name}</b> {what}. {r.was === "dialog" ? "What you entered is kept." : "Your copy is kept."}</span>
      <span className="flex gap-1.5">
        {canEdit ? <button type="button" className="btn sm" data-restore onClick={() => c.guard.restore()}>Put it back</button> : null}
        <button type="button" className="btn sm ghost" data-dismiss onClick={() => c.guard.dismissRescue()}>Dismiss</button>
      </span>
    </div>
  );
}

function Notices({ c }: { c: StudioCollab }) {
  const people = useStore(c.collab, (s) => s.people, NONE);
  const conflicts = useStore(c.guard, (s) => s.conflicts, NO_CONFLICTS);
  const rescue = useStore(c.guard, (s) => s.rescue, null);
  const editingId = useStudio(c.studio, (s) => (s.editing && !s.editing.isNew ? s.editing.draft.id : null));
  const dialog = useStudio(c.studio, (s) => !!s.editing);
  const sketchId = useStudio(c.studio, (s) => s.sketch?.featureId || null);
  const openId = editingId || sketchId;
  const others = openId ? people.filter((p) => p.state.edit && p.state.edit.id === openId) : [];
  if (!others.length && !conflicts.length && !rescue) return null;
  const names = nameList(others.map((p) => p.name));
  return (
    <div className={cx("cad-collab-notes absolute top-2 z-[4] w-[320px] max-w-[calc(100%-16px)] flex flex-col gap-1.5 text-sm", dialog ? "left-[316px]" : "left-2")}>
      {others.length ? (
        <div className="callout m-0 flex items-center gap-2" role="status" data-also-editing={others.map((p) => p.login).join(" ")}>
          <span className="flex flex-none -space-x-1">{others.slice(0, 3).map((p) => <i key={p.cid} className="block w-3 h-3 rounded-full border border-paper" style={{ background: p.color || "var(--mark)" }} />)}</span>
          <span>{editingId
            ? `${names} ${others.length === 1 ? "has" : "have"} this feature open too. What each of you changes is merged field by field; you will see their changes here when they are done.`
            : `${names} ${others.length === 1 ? "is" : "are"} in this sketch too. You both draw in it: every line and point is merged as it is made.`}</span>
        </div>
      ) : null}
      {conflicts.map((k) => <ConflictRow key={k.path.join("\u0000")} c={c} k={k} />)}
      {rescue ? <RescueRow c={c} r={rescue} /> : null}
    </div>
  );
}

export function StageOverlay({ c }: { c: StudioCollab }) {
  return (
    <>
      <FollowFrame collab={c.collab} />
      <Avatars collab={c.collab} />
      <Notices c={c} />
    </>
  );
}
