// constrain.ts — the constraint tools: from what is selected to the constraints to add.
//
// A constraint tool works both ways round, as in the sketchers people know: select first and press the tool
// (the constraint is made at once), or press the tool and then click the things to tie together.  `plan` is
// the rule for each kind: what it needs, and what a selection makes.  Pure, apart from `runConstraintTool`.
import type { PartStudio } from "../ui/studio";
import { sketchEditor } from "./editor";
import type { SketchData } from "./format";
import type { Ref } from "./model";
import { resolveEntity, type Resolved } from "./refs";

export type ConstraintKind = "coincident" | "horizontal" | "vertical" | "parallel" | "perpendicular" | "tangent" | "equal" | "midpoint" | "concentric" | "collinear" | "symmetric" | "fix";

/** What each kind asks for, as shown in the hint line while its tool is in hand. */
export const NEEDS: Record<ConstraintKind, string> = {
  coincident: "Click two points, or a point and a curve to put it on.",
  horizontal: "Click a line, or two points to put level.",
  vertical: "Click a line, or two points to put one above the other.",
  parallel: "Click two lines.",
  perpendicular: "Click two lines.",
  tangent: "Click a line and a circle or arc, or two circles or arcs.",
  equal: "Click two lines, or two circles or arcs.",
  midpoint: "Click a point and a line.",
  concentric: "Click two circles or arcs.",
  collinear: "Click two lines.",
  symmetric: "Click two points, then the line (or point) they mirror about.",
  fix: "Click what to pin where it is.",
};

export type Plan = { add: { type: string; refs: Ref[] }[] } | "more" | { error: string };

/** The constraints a selection makes for a kind; "more" while the selection is still short. */
export function plan(kind: ConstraintKind, data: SketchData, selection: readonly string[]): Plan {
  const r = selection.map((id) => resolveEntity(data, id)).filter((x): x is Resolved => !!x);
  const points = r.filter((x) => x.kind === "point"), lines = r.filter((x) => x.kind === "line"), rounds = r.filter((x) => x.kind === "circle" || x.kind === "arc");
  const n = r.length;
  const one = (type: string, ...refs: Ref[]): Plan => ({ add: [{ type, refs }] });
  const pairs = (type: string, list: Resolved[]): Plan => ({ add: list.slice(1).map((x) => ({ type, refs: [list[0].id, x.id] })) });
  const wrong: Plan = { error: NEEDS[kind] };
  if (!n) return "more";

  switch (kind) {
    case "coincident":
      if (n === 1) return "more";
      if (n !== 2) return wrong;
      if (points.length === 2) return one("coincident", points[0].id, points[1].id);
      if (points.length === 1) return one("coincident", points[0].id, r.find((x) => x.kind !== "point")!.id);
      return wrong;
    case "horizontal": case "vertical":
      if (lines.length && lines.length === n) return { add: lines.map((l) => ({ type: kind, refs: [l.id] })) };
      if (points.length === n) return n === 1 ? "more" : n === 2 ? one(kind, points[0].id, points[1].id) : wrong;
      return wrong;
    case "parallel": case "perpendicular": case "collinear":
      if (lines.length !== n) return wrong;
      if (n === 1) return "more";
      return kind === "perpendicular" && n > 2 ? wrong : pairs(kind, lines);
    case "equal":
      if (n === 1) return points.length ? wrong : "more";
      if (lines.length === n) return pairs("equal", lines);
      if (rounds.length === n) return pairs("equal", rounds);
      return wrong;
    case "tangent":
      if (points.length) return wrong;
      if (n === 1) return "more";
      if (n !== 2 || lines.length === 2) return wrong;
      return one("tangent", lines.length ? lines[0].id : rounds[0].id, lines.length ? rounds[0].id : rounds[1].id);
    case "concentric":
      if (rounds.length !== n) return wrong;
      return n === 1 ? "more" : n === 2 ? one("concentric", rounds[0].id, rounds[1].id) : wrong;
    case "midpoint":
      if (n === 1) return rounds.length ? wrong : "more";
      if (n === 2 && points.length === 1 && lines.length === 1) return one("midpoint", points[0].id, lines[0].id);
      return wrong;
    case "symmetric":
      if (rounds.length) return wrong;
      if (n < 3) return lines.length > 1 ? wrong : "more";
      if (n === 3 && points.length === 2 && lines.length === 1) return one("symmetric", points[0].id, points[1].id, lines[0].id);
      if (n === 3 && points.length === 3) return one("symmetric", r[0].id, r[1].id, r[2].id);
      return wrong;
    case "fix":
      return { add: r.map((x) => ({ type: "fix", refs: [x.id] })) };
  }
  return wrong;
}

/** Run a constraint tool: at once on a selection that fits, else take it in hand and wait for clicks. */
export function runConstraintTool(studio: PartStudio, kind: ConstraintKind, toolId: string): void {
  const ed = sketchEditor(studio);
  if (!ed.getState().open) return;
  const apply = (): "done" | "more" | "wrong" => {
    const s = ed.getState();
    const p = plan(kind, s.data, s.selection.filter((id) => !(id in s.data.constraints)));
    if (p === "more") return "more";
    if ("error" in p) return "wrong";
    ed.select([]);
    ed.edit((d) => { for (const c of p.add) d.constrain(c.type, c.refs); });
    return "done";
  };
  // select first, then the tool
  if (ed.getState().selection.length && apply() === "done") { if (ed.getState().tool !== "select") ed.useSelect(); return; }
  ed.select([]);
  ed.useTool(toolId, {
    move(ev) { const t = ed.hit(ev, { boxes: false }); ed.setHover(t ? t.id : null); },
    down(ev) {
      const t = ed.hit(ev, { boxes: false });
      if (!t) { ed.select([]); return; }
      ed.select([...ed.getState().selection.filter((id) => id !== t.id), t.id]);
      const r = apply();
      // a click that cannot be part of this constraint starts the picking again from that click
      if (r === "wrong") { ed.select([t.id]); if (apply() === "wrong") { ed.select([]); studio.host.toast(NEEDS[kind], 3000); } }
    },
    stop() { ed.setHover(null); },
  }, NEEDS[kind]);
}
