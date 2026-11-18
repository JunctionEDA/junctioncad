// People.tsx — who is in this document and in the rest of the project: the list in the Collaborators panel,
// laid out as the electronics editor's Collaborators pane is (a dot in the person's colour, the name, Follow).
import { cx } from "../../../shared/util";
import type { RoomMember } from "../../../platform/doctabs/roomapi";
import { useStore } from "./hooks";
import type { Collaborator } from "./presence";
import type { StudioCollab } from "./studio-collab";

// the electronics editor's .peer row: flex, centred, 8px gap, 4px pad, panel fill on hover
const PEER = "peer flex items-center gap-2 p-1 rounded-xs hover:bg-panel";
const DOT = "dot flex-none w-2.5 h-2.5 rounded-full";
const WHO = "who flex-1 min-w-0";

const NONE: Collaborator[] = [];
const NOBODY: RoomMember[] = [];

/** What a person is doing, in a few words. */
export function doing(p: Collaborator, featureName: (id: string) => string | undefined): string {
  const e = p.state.edit;
  if (e) return `${e.kind === "sketch" ? "sketching" : e.isNew ? "adding" : "editing"} ${e.name || featureName(e.id) || "a feature"}`;
  if (p.state.feat) { const n = featureName(p.state.feat); if (n) return `on ${n}`; }
  return "";
}

export function People({ c }: { c: StudioCollab }) {
  const people = useStore(c.collab, (s) => s.people, NONE);
  const elsewhere = useStore(c.collab, (s) => s.elsewhere, NOBODY);
  const follow = useStore(c.collab, (s) => s.follow, null);
  const followers = useStore(c.collab, (s) => s.followers, NONE);
  const showViews = useStore(c.collab, (s) => s.showViews, true);
  const myColor = useStore(c.collab, (s) => s.myColor, "");
  const studio = c.studio;
  const featureName = (id: string) => studio.getState().features.find((f) => f.id === id)?.name;
  const tabName = (docId: string | null): string => {
    const d = docId ? studio.host.docs.find((x) => x.docId === docId) : null;
    if (!d) return "another tab";
    if (d.docType === "kicad_sch") return "the schematic";
    if (d.docType === "kicad_pcb") return "the board";
    return (d.path.split("/").pop() || d.path).replace(/\.[^.]+$/, "");
  };
  const button = (key: string, name: string) => (
    <button type="button" className="btn sm flex-none" data-follow={key} aria-pressed={follow === key} title={follow === key ? `Stop following ${name}` : `See what ${name} sees`}
      onClick={() => c.collab.follow(follow === key ? null : key)}>{follow === key ? "Following" : "Follow"}</button>
  );
  return (
    <div className="px-2 py-1.5 text-sm" id="cadPeers" data-people={people.length}>
      <div className={PEER}>
        <span className={DOT} style={{ background: myColor || "var(--mark)" }} />
        <span className={cx(WHO, "truncate")}>You{followers.length ? <span className="text-ink-3"> · followed by {followers.map((f) => f.name).join(", ")}</span> : null}</span>
      </div>
      {people.map((p) => {
        const note = doing(p, featureName);
        return (
          <div className={PEER} key={p.cid} data-peer={p.login}>
            <span className={DOT} style={{ background: p.color || "var(--mark)" }} />
            <span className={cx(WHO, "flex flex-col leading-tight")}>
              <span className="truncate">{p.name}</span>
              {note ? <span className="truncate text-xs text-ink-3" data-peer-doing>{note}</span> : null}
            </span>
            {button(p.key, p.name)}
          </div>
        );
      })}
      {elsewhere.map((m) => (
        <div className={PEER} key={m.key} data-peer-elsewhere={m.login}>
          <span className={cx(DOT, "opacity-50")} style={{ background: m.color || "var(--mark)" }} />
          <span className={cx(WHO, "flex flex-col leading-tight")}>
            <span className="truncate text-ink-2">{m.name}</span>
            <span className="truncate text-xs text-ink-3">{m.tab ? `in ${tabName(m.tab)}` : "in the project"}</span>
          </span>
          {m.tab ? button(m.key, m.name) : null}
        </div>
      ))}
      {!people.length && !elsewhere.length ? <p className="note m-0 px-1 pt-1">No one else is here right now. Share the project to work on it together.</p> : null}
      {people.length ? (
        <label className="flex items-center gap-1.5 px-1 pt-1.5 text-xs text-ink-2 cursor-default" title="A rectangle in each person's colour marks what their window shows.">
          <input type="checkbox" checked={showViews} onChange={(ev) => c.collab.setShowViews(ev.target.checked)} />
          Show where the others are looking
        </label>
      ) : null}
    </div>
  );
}
