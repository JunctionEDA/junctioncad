// mech/boarditems.ts — the board items a board link asks for, as KiCad s-expressions, and the changes that
// make a board hold exactly those.  Pure: no DOM, no canvas, no network (static/tests/pcb-mech.test.js).
//
// What a link's drives become on the board (mechanical/boardlink/format.ts `Solved`, in nanometres):
//   outline   gr_line / gr_arc / gr_circle on Edge.Cuts
//   holes     one footprint per hole: an NPTH pad (or a plated pad when the drive gives it copper)
//   keepout   a rule area (zone with keepout) on the copper layer of its side, named with its height limit
// and, per drive, a group that holds them, named after the part studio.  Every item is `(locked yes)` and has
// an id that is a function of the link, the drive and its place in it (mechanical/boardlink/ids.ts), so:
//   • any browser reconciling the board writes the same items (no duplicates when two people have it open);
//   • an item is recognisably driven by its id alone, with or without the part studio at hand.
import { DRIVE_TITLES, drivenId, drivesOf, isDrivenId, keepoutLimit, type BoardLinkItem, type Curve, type SolvedKeepout } from "../../mechanical/api";

export interface DrivenItem {
  id: string;
  /** the s-expression's head: gr_line, gr_arc, gr_circle, footprint, zone, group */
  kind: string;
  /** the wire type name of the change (canvas/edit.ts PCB_TYPE_NAMES) */
  typeName: string;
  /** the item alone, as it stands in a board file */
  sexpr: string;
  /** a group's member ids */
  members?: string[];
  link: string; drive: string;
}

export interface LinkSource { link: BoardLinkItem; /** the part studio's name, for the names people see */ studio: string; /** its document id */ studioDoc: string }

const EDGE = "Edge.Cuts", EDGE_WIDTH = 0.05;
/** nanometres → the millimetres a board file holds, without float noise ("12.5", "0.000001"). */
export function mm(nm: number): string {
  const v = Math.round(nm), neg = v < 0, a = Math.abs(v);
  const whole = Math.floor(a / 1e6), frac = String(a % 1e6).padStart(6, "0").replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : String(whole);
  return neg && text !== "0" ? "-" + text : text;
}
const q = (s: string): string => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
const stroke = `(stroke (width ${EDGE_WIDTH}) (type default))`;

function curveSexpr(c: Curve, id: string): { kind: string; sexpr: string } {
  if (c[0] === "l") return { kind: "gr_line", sexpr: `(gr_line (start ${mm(c[1])} ${mm(c[2])}) (end ${mm(c[3])} ${mm(c[4])}) ${stroke} (locked yes) (layer ${q(EDGE)}) (uuid ${q(id)}))` };
  if (c[0] === "c") return { kind: "gr_circle", sexpr: `(gr_circle (center ${mm(c[1])} ${mm(c[2])}) (end ${mm(c[1] + c[3])} ${mm(c[2])}) ${stroke} (fill no) (locked yes) (layer ${q(EDGE)}) (uuid ${q(id)}))` };
  // an arc keeps one winding in the file (pcbnew: from start to end the angle grows, clockwise on the sheet)
  let [, ax, ay, mx, my, bx, by] = c;
  if ((mx - ax) * (by - my) - (my - ay) * (bx - mx) < 0) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; }
  return { kind: "gr_arc", sexpr: `(gr_arc (start ${mm(ax)} ${mm(ay)}) (mid ${mm(mx)} ${mm(my)}) (end ${mm(bx)} ${mm(by)}) ${stroke} (locked yes) (layer ${q(EDGE)}) (uuid ${q(id)}))` };
}

const font = "(effects (font (size 1 1) (thickness 0.15)))";

/** A mounting hole as a footprint: one pad, a courtyard ring, hidden reference and value. */
export function holeSexpr(id: string, x: number, y: number, drill: number, pad: number, ref: string, sub: (role: string) => string): string {
  const plated = pad > drill, size = plated ? pad : drill, r = size / 2 + 250000;
  const name = `MountingHole_${mm(drill)}mm${plated ? "_Pad" : ""}`;
  return `(footprint ${q("MountingHole:" + name)} (locked yes) (layer "F.Cu") (uuid ${q(id)}) (at ${mm(x)} ${mm(y)})`
    + ` (descr ${q(`Mounting hole ${mm(drill)} mm, placed by the enclosure`)}) (tags "mounting hole")`
    + ` (property "Reference" ${q(ref)} (at 0 ${mm(-r - 1000000)} 0) (layer "F.SilkS") (hide yes) (uuid ${q(sub("ref"))}) ${font})`
    + ` (property "Value" ${q(name)} (at 0 ${mm(r + 1000000)} 0) (layer "F.Fab") (hide yes) (uuid ${q(sub("value"))}) ${font})`
    + ` (attr board_only exclude_from_pos_files exclude_from_bom)`
    + ` (fp_circle (center 0 0) (end ${mm(r)} 0) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid ${q(sub("crtyd"))}))`
    + (plated
      ? ` (pad "1" thru_hole circle (at 0 0) (size ${mm(pad)} ${mm(pad)}) (drill ${mm(drill)}) (layers "*.Cu" "*.Mask") (uuid ${q(sub("pad"))}))`
      : ` (pad "" np_thru_hole circle (at 0 0) (size ${mm(drill)} ${mm(drill)}) (drill ${mm(drill)}) (layers "*.Cu" "*.Mask") (uuid ${q(sub("pad"))}))`)
    + ")";
}

/** What a keep-out is called on the board: its limit first, so it reads in the rule area's label. */
export function keepoutName(name: string, k: SolvedKeepout, thickness: number): string {
  const limit = keepoutLimit(k, thickness);
  return k.mode === "none" || limit <= 0 ? `No components: ${name}` : `Height ≤ ${Math.round(limit * 100) / 100} mm: ${name}`;
}

export function keepoutSexpr(id: string, loop: number[], k: SolvedKeepout, name: string, thickness: number): string {
  const none = k.mode === "none" || keepoutLimit(k, thickness) <= 0;
  let pts = "";
  for (let i = 0; i + 1 < loop.length; i += 2) pts += ` (xy ${mm(loop[i])} ${mm(loop[i + 1])})`;
  return `(zone (locked yes) (layer ${q(k.side === "bottom" ? "B.Cu" : "F.Cu")}) (uuid ${q(id)}) (name ${q(keepoutName(name, k, thickness))}) (hatch edge 0.5)`
    + ` (connect_pads (clearance 0)) (min_thickness 0.25)`
    + ` (keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints ${none ? "not_allowed" : "allowed"}))`
    + ` (placement (enabled no) (sheetname ""))`
    + ` (fill (thermal_gap 0.5) (thermal_bridge_width 0.5) (island_removal_mode 0))`
    + ` (polygon (pts${pts})))`;
}

export function groupSexpr(id: string, name: string, members: string[]): string {
  return `(group ${q(name)} (uuid ${q(id)}) (locked yes) (members ${members.slice().sort().map(q).join(" ")}))`;
}

export const groupName = (studio: string, drive: string): string => `${drive} (driven by ${studio})`;

/** Every board item the links ask for, in a fixed order. */
export function desiredItems(sources: readonly LinkSource[], thickness: number): DrivenItem[] {
  const out: DrivenItem[] = [];
  let holeN = 0;
  for (const { link, studio } of sources) {
    for (const drive of drivesOf(link)) {
      const solved = link.solved.drives[drive.id];
      if (!solved || solved.kind !== drive.kind) continue;
      const base = { link: link.id, drive: drive.id };
      const members: string[] = [];
      const push = (id: string, kind: string, typeName: string, sexpr: string) => { out.push({ id, kind, typeName, sexpr, ...base }); members.push(id); };
      if (solved.kind === "outline") {
        solved.curves.forEach((c, n) => { const id = drivenId(link.id, drive.id, "outline", n); const s = curveSexpr(c, id); push(id, s.kind, "PCB_SHAPE", s.sexpr); });
      } else if (solved.kind === "holes") {
        solved.holes.forEach((h, n) => {
          const id = drivenId(link.id, drive.id, "hole", n);
          push(id, "footprint", "FOOTPRINT", holeSexpr(id, h[0], h[1], h[2], solved.pad || 0, `MH${++holeN}`, (role) => drivenId(link.id, drive.id, "hole-" + role, n)));
        });
      } else {
        solved.loops.forEach((loop, n) => { const id = drivenId(link.id, drive.id, "keepout", n); push(id, "zone", "ZONE", keepoutSexpr(id, loop, solved, drive.name || DRIVE_TITLES.keepout, thickness)); });
      }
      if (!members.length) continue;
      const gid = drivenId(link.id, drive.id, "group", 0);
      out.push({ id: gid, kind: "group", typeName: "PCB_GROUP", sexpr: groupSexpr(gid, groupName(studio, drive.name || DRIVE_TITLES[drive.kind]), members), members: members.slice().sort(), ...base });
    }
  }
  return out;
}

/** A change as the board's collaboration path carries it (canvas/types.ts OutChange). */
export interface BoardChange { id: string; kind: "ADDED" | "MODIFIED" | "REMOVED"; typeName: string; sexpr?: string; properties?: unknown[]; groupMembers?: string[]; padNets?: Record<string, string> }

export interface BoardItemView { id: string; kind: string; typeName: string; sexpr: string; /** a group's member ids */ members?: string[] }

/** The group id of every drive of these links, solved or not: the drives that are alive. */
export function liveGroups(sources: readonly LinkSource[]): Set<string> {
  const out = new Set<string>();
  for (const { link } of sources) for (const id of Object.keys(link.drives)) out.add(drivenId(link.id, id, "group", 0));
  return out;
}

export interface BoardView {
  /** every driven item on the board (ids that start with the driven prefix) */
  driven(): Iterable<BoardItemView>;
  /** an s-expression as the board's own writer would print it, so two spellings of one item compare equal */
  normalise(sexpr: string): string;
  /** a board item's s-expression wrapped as a change fragment */
  wrap(sexpr: string): string;
  /** the same item with its lock taken off */
  unlocked(sexpr: string): string;
}

export interface Reconciled {
  changes: BoardChange[];
  /** items no link asks for any more: left on the board, unlocked */
  released: string[];
  added: number; modified: number; removed: number;
}

/**
 * The changes that make the board's driven items be `desired`.
 *   • a desired item that is missing is added; one that differs is replaced;
 *   • an item of a drive that is alive (its group is in `live`) but no longer asks for it — a hole that was
 *     deleted in the model — is removed;
 *   • an item whose drive is gone (the link was broken, here or in the part studio) stays and is unlocked,
 *     and its group goes, so nothing calls it driven any more: breaking a link never deletes a board outline.
 *     That is only decided when `complete` says every part studio of the project has been read; until then
 *     items nobody asks for are left alone.
 */
export function reconcile(desired: readonly DrivenItem[], board: BoardView, live: ReadonlySet<string>, complete: boolean): Reconciled {
  const out: Reconciled = { changes: [], released: [], added: 0, modified: 0, removed: 0 };
  const want = new Map(desired.map((d) => [d.id, d]));
  const have = new Map<string, BoardItemView>();
  for (const it of board.driven()) if (isDrivenId(it.id)) have.set(it.id, it);
  const change = (d: DrivenItem, kind: "ADDED" | "MODIFIED"): BoardChange => {
    const c: BoardChange = { id: d.id, kind, typeName: d.typeName, sexpr: board.wrap(d.sexpr) };
    if (d.members) c.groupMembers = d.members;
    if (d.kind === "footprint") c.padNets = {};
    return c;
  };
  // members before the groups that name them
  for (const d of desired) {
    const cur = have.get(d.id);
    if (!cur) { out.changes.push(change(d, "ADDED")); out.added++; }
    else if (board.normalise(cur.sexpr) !== board.normalise(d.sexpr)) { out.changes.push(change(d, "MODIFIED")); out.modified++; }
  }
  // which drive each leftover belongs to, as the board's own groups say
  const groupOf = new Map<string, string>();
  for (const it of have.values()) if (it.kind === "group") for (const m of it.members || []) groupOf.set(m, it.id);
  const remove = (it: BoardItemView) => { out.changes.push({ id: it.id, kind: "REMOVED", typeName: it.typeName, properties: [] }); };
  for (const it of have.values()) {
    if (want.has(it.id)) continue;
    const group = it.kind === "group" ? it.id : groupOf.get(it.id);
    if (group && live.has(group)) { remove(it); out.removed++; continue; }
    if (!complete) continue;
    if (it.kind === "group") { remove(it); out.released.push(it.id); continue; }
    const free = board.unlocked(it.sexpr);
    if (board.normalise(free) !== board.normalise(it.sexpr)) { out.changes.push({ id: it.id, kind: "MODIFIED", typeName: it.typeName, sexpr: board.wrap(free), ...(it.kind === "footprint" ? { padNets: {} } : {}) }); out.released.push(it.id); }
  }
  return out;
}
