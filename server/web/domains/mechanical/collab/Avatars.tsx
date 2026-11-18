// Avatars.tsx — the people in a 3D document as avatars over the viewport (click one to follow), and the frame
// that says whose view one is following.  Used by the part studio's overlay and, through attach.tsx, by any
// other editor with a viewport.
import type { RoomMember } from "../../../platform/doctabs/roomapi";
import { cx } from "../../../shared/util";
import type { Collab } from "./collab";
import { brightness, initials, type Collaborator } from "./presence";
import { useStore } from "./store";

const NONE: Collaborator[] = [];
const NOBODY: RoomMember[] = [];

/** The theme's dark or light canvas colour (the same in both themes), whichever reads on a person's colour. */
export const inkOn = (color: string): string => (brightness(color || "#888") > 0.6 ? "var(--canvas)" : "var(--silk)");

/** The people in the document as avatars (click one to follow), then, dimmed, the people on other tabs. */
export function Avatars({ collab }: { collab: Collab }) {
  const people = useStore(collab, (s) => s.people, NONE);
  const elsewhere = useStore(collab, (s) => s.elsewhere, NOBODY);
  const follow = useStore(collab, (s) => s.follow, null);
  const away = elsewhere.filter((m) => m.tab);
  if (!people.length && !away.length) return null;
  const shown = people.slice(0, 6), shownAway = away.slice(0, Math.max(0, 8 - shown.length));
  const more = people.length - shown.length + away.length - shownAway.length;
  const pick = (key: string) => { collab.follow(follow === key ? null : key); collab.host.viewport.canvas.focus(); };
  const base = "grid place-items-center w-6 h-6 rounded-full text-2xs font-semibold border border-paper cursor-pointer";
  // under the viewport's own view buttons (an assembly), or beside the part studio's view cube, which stands in their corner
  const ownButtons = !!collab.host.viewport.host.querySelector(".v3-views");
  return (
    <div className={cx("cad-avatars absolute z-[3] flex items-center gap-1", ownButtons ? "right-2 top-10" : "right-[136px] top-2")} role="group" aria-label="People in this project">
      {shown.map((p) => (
        <button key={p.cid} type="button" data-avatar={p.login} aria-pressed={follow === p.key}
          className={cx(base, follow === p.key && "outline outline-2 outline-offset-1 outline-ink")}
          style={{ background: p.color || "var(--mark)", color: inkOn(p.color) }}
          title={follow === p.key ? `Following ${p.name}. Click to stop` : `${p.name}. Click to follow`}
          onClick={() => pick(p.key)}>{initials(p.name)}</button>
      ))}
      {shownAway.map((m) => (
        <button key={m.key} type="button" data-avatar-elsewhere={m.login} className={cx(base, "opacity-45 hover:opacity-100")}
          style={{ background: m.color || "var(--mark)", color: inkOn(m.color) }}
          title={`${m.name} is on another tab. Click to go there and follow`}
          onClick={() => pick(m.key)}>{initials(m.name)}</button>
      ))}
      {more > 0 ? <span className="px-1 text-xs text-ink-2 font-mono">+{more}</span> : null}
    </div>
  );
}

/** A frame in the followed person's colour around the viewport, and a way to stop. */
export function FollowFrame({ collab }: { collab: Collab }) {
  const people = useStore(collab, (s) => s.people, NONE);
  const follow = useStore(collab, (s) => s.follow, null);
  const p = follow ? people.find((x) => x.key === follow) : null;
  if (!follow) return null;
  const color = p?.color || "var(--mark)";
  return (
    <>
      <div className="absolute inset-0 z-[3] pointer-events-none" style={{ boxShadow: `inset 0 0 0 2px ${color}` }} data-following={p ? p.login : "pending"} />
      <div className="absolute left-1/2 top-0 z-[3] -translate-x-1/2 flex items-center gap-2 pl-2 pr-1 h-6 rounded-b-sm text-xs font-medium" style={{ background: color, color: inkOn(p?.color || "") }}>
        <span>{p ? `Following ${p.name}` : "Following…"}</span>
        <button type="button" className="px-1.5 h-4.5 rounded-xs bg-transparent border border-current cursor-pointer text-2xs uppercase font-mono" style={{ color: "inherit" }} data-follow-stop onClick={() => collab.follow(null)}>Stop</button>
      </div>
    </>
  );
}
