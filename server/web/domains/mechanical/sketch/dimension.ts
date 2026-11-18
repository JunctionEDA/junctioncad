// dimension.ts — the Dimension tool: click what to measure, click where the text goes, type the value.
//
// What is clicked decides the kind, and for a distance between two points where the pointer is decides the
// direction, as on a drawing board:
//   a line                         its length                    (or the horizontal / vertical extent of a slanted line)
//   two points, or centres         the distance between them     beside them: aligned; above or below: horizontal;
//                                                                left or right: vertical
//   a point and a line             the distance square to the line
//   two parallel lines             the distance between them
//   two lines that meet            the angle at the corner
//   a circle                       its diameter                  an arc: its radius
// The dimension is added driving, with the value the sketch has now, and opened for typing.  One that would
// over-constrain the sketch is added as a reference dimension instead (shown in brackets), which a person can
// still turn into a driving one by typing into it.
import type { Vec2 } from "../core/geometry";
import type { PartStudio } from "../ui/studio";
import { sketchEditor } from "./editor";
import type { SketchConstraint, SketchData, SketchRef } from "./format";
import { measure, resolveEntity, type Resolved } from "./refs";

const HINT = "Click a line, a circle, or two things to measure between; then click where the text goes.";

/** A circle or an arc stands for its centre when a distance is measured to it. */
const asPoint = (r: Resolved): SketchRef => (r.kind === "circle" || r.kind === "arc" ? { entity: r.id, at: "center" } : { entity: r.id });
const placeOf = (r: Resolved): Vec2 | null => (r.kind === "point" ? r.p : r.kind === "circle" || r.kind === "arc" ? r.c : null);

/** Horizontal, vertical or aligned, from where the text is relative to the two points. */
function axisFor(a: Vec2, b: Vec2, at: Vec2): "x" | "y" | undefined {
  const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
  if (dx < 1e-9 || dy < 1e-9) return undefined;   // already level or upright: the plain distance is the one meant
  const inX = at[0] >= Math.min(a[0], b[0]) && at[0] <= Math.max(a[0], b[0]), inY = at[1] >= Math.min(a[1], b[1]) && at[1] <= Math.max(a[1], b[1]);
  if (inX && !inY) return "x";
  if (inY && !inX) return "y";
  return undefined;
}

/** The dimension that the picked entities and the text position make, without a value; null when they make none (yet). */
export function candidate(data: SketchData, picks: readonly string[], at: Vec2): SketchConstraint | null {
  const r = picks.map((id) => resolveEntity(data, id));
  if (!r.length || r.some((x) => !x)) return null;
  const [a, b] = r as Resolved[];
  const label = { x: at[0], y: at[1] };
  if (!b) {
    if (a.kind === "circle") return { type: "diameter", refs: [{ entity: a.id }], label };
    if (a.kind === "arc") return { type: "radius", refs: [{ entity: a.id }], label };
    if (a.kind === "line") { const axis = axisFor(a.a, a.b, at); return { type: "distance", refs: [{ entity: a.id }], label, ...(axis ? { axis } : {}) }; }
    return null;
  }
  if (a.kind === "line" && b.kind === "line") {
    const ux = a.b[0] - a.a[0], uy = a.b[1] - a.a[1], vx = b.b[0] - b.a[0], vy = b.b[1] - b.a[1];
    const parallel = Math.abs(ux * vy - uy * vx) < 1e-6 * Math.hypot(ux, uy) * Math.hypot(vx, vy);
    return { type: parallel ? "distance" : "angle", refs: [{ entity: a.id }, { entity: b.id }], label };
  }
  const line = a.kind === "line" ? a : b.kind === "line" ? b : null;
  if (line) { const other = line === a ? b : a; return { type: "distance", refs: [asPoint(other), { entity: line.id }], label }; }
  const p = placeOf(a), q = placeOf(b);
  if (!p || !q) return null;
  const axis = axisFor(p, q, at);
  return { type: "distance", refs: [asPoint(a), asPoint(b)], label, ...(axis ? { axis } : {}) };
}

export function runDimensionTool(studio: PartStudio, toolId: string): void {
  const ed = sketchEditor(studio);
  if (!ed.getState().open) return;
  // what was selected before the tool was taken is what to measure
  const pre = ed.getState().selection.filter((id) => !!resolveEntity(ed.getState().data, id)).slice(0, 2);
  let picks: string[] = pre;
  ed.select(picks);
  const preview = (at: Vec2 | null) => {
    const data = ed.getState().data, c = at ? candidate(data, picks, at) : null;
    ed.setPreview(c ? { dimension: { ...c, value: measure(data, c) ?? 0 } } : null);
  };
  const place = (at: Vec2): void => {
    const data = ed.getState().data, c = candidate(data, picks, at);
    if (!c) return;
    const value = measure(data, c);
    if (value === null) return;
    c.value = Math.round(value * 1e6) / 1e6;
    let id = "";
    let driven = false;
    ed.edit((d) => {
      id = d.constrain(c.type, c.refs, c);
      // would it fight what is already there?
      const before = ed.getState(), check = ed.check(d.data);
      if (check && before.health === "ok" && (!check.ok || check.dof >= before.dof)) { d.data.constraints[id] = { ...d.data.constraints[id], driving: false }; driven = true; }
    });
    picks = []; ed.select([]); ed.setPreview(null);
    if (driven) { studio.host.toast("The sketch already settles that, so the dimension was added as a reference (in brackets).", 4500); return; }
    if (id && ed.getState().data.constraints[id]) ed.editDimension(id);
  };
  ed.useTool(toolId, {
    move(ev) {
      if (ed.typing) return;
      const t = ed.hit(ev, { boxes: false }); ed.setHover(t ? t.id : null);
      preview(ed.planePoint(ev));
    },
    down(ev) {
      if (ed.typing) return;
      const at = ed.planePoint(ev); if (!at) return;
      const t = ed.hit(ev, { boxes: false });
      const data = ed.getState().data;
      if (t && picks.length < 2 && !picks.includes(t.id)) {
        // a second pick has to make something with the first; otherwise the click is where the text goes
        if (!picks.length || candidate(data, [...picks, t.id], at)) { picks = [...picks, t.id]; ed.select(picks); preview(at); return; }
      }
      if (picks.length && candidate(data, picks, at)) place(at);
      else if (!t) { picks = []; ed.select([]); preview(null); }
    },
    key(ev) {
      if (ev.key === "Escape" && picks.length) { picks = []; ed.select([]); ed.setPreview(null); return true; }
      return false;
    },
    stop() { ed.setPreview(null); ed.setHover(null); },
  }, HINT);
  if (picks.length && ed.lastPointer) preview(ed.planePoint(ed.lastPointer));
}
