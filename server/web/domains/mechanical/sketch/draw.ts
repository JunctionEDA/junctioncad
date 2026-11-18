// draw.ts — the engine behind every sketch tool that draws a shape by clicking points: line, rectangles,
// circle, arcs, slot, point.  A tool file under tools/ names a `ShapeSpec` (sketch/shapes.ts); this supplies
// what they all share:
//   • snapping with inference (sketch/infer.ts) and the hints that show what a click will tie together;
//   • the rubber band;
//   • numeric input: the measures of the shape being drawn are shown at the pointer, and typing a number sets
//     the first of them (Tab moves to the next, Enter draws the shape).  A typed measure becomes a driving
//     dimension, as it would had it been added afterwards;
//   • one undo step per shape, and chaining (a line starts where the last one ended).
//
// It replaces the two-point engine in sketch/drawing.ts, which knew nothing of constraints.
import type { Vec2 } from "../core/geometry";
import type { PartStudio } from "../ui/studio";
import { angText, lenText, typedFactor } from "./dims";
import { sketchEditor } from "./editor";
import { tryEvaluate } from "./expr";
import type { SketchData } from "./format";
import { snap, type Snap, type SnapContext } from "./infer";
import type { Draft } from "./model";
import { dist } from "./refs";

/** A measure of the shape being drawn, shown at the pointer; typing a value fixes it. */
export interface Field { key: string; label: string; unit: "mm" | "deg"; value: number }
export type Typed = { [key: string]: number };

export interface ShapeSpec {
  /** the tool's id */
  id: string;
  /** how many clicks make one shape */
  clicks: number;
  /** what to do next, given how many points are down */
  hint(n: number): string;
  /** press, drag, release draws a two-click shape in one stroke */
  drag?: boolean;
  /** how the next point snaps (the start of the stroke, the line it continues from, …) */
  context?(pts: Snap[], data: SketchData, chain: string | null): Partial<SnapContext>;
  /** Whether a click may be the next point; a string is why not. */
  accept?(pts: Snap[], next: Snap, data: SketchData): true | string;
  /** the measures to show, with the pointer at `cursor` */
  fields?(pts: Snap[], cursor: Vec2): Field[];
  /** where the pointer has to be for the typed measures to hold */
  constrain?(pts: Snap[], cursor: Vec2, typed: Typed): Vec2;
  /** the rubber band: polylines in sketch coordinates */
  preview(pts: Snap[], cursor: Snap, data: SketchData): Vec2[][];
  /** Add the shape to the draft.  False: the points make nothing.  `next` starts the following shape (a chain). */
  build(draft: Draft, pts: Snap[], typed: Typed, chain: string | null): { next?: Snap[]; chain?: string } | false;
  /** the tool was reset (a shape was finished or abandoned) */
  reset?(): void;
}


export function startDrawTool(studio: PartStudio, spec: ShapeSpec): void {
  const ed = sketchEditor(studio);
  if (!ed.getState().open) return;
  ed.select([]);
  let pts: Snap[] = [];
  let typed: Typed = {};
  let buffer = "", field = 0;
  let chain: string | null = null;
  let pressed: { x: number; y: number; fresh: boolean } | null = null;
  let cursor: Snap | null = null;

  const hud = document.createElement("div");
  hud.className = "cad-hud";
  hud.style.cssText = "position:absolute;z-index:3;pointer-events:none;display:none;gap:6px;padding:2px 6px;border:1px solid var(--line);border-radius:var(--r-2);background:var(--panel);color:var(--ink);font:var(--fs-xs) var(--mono);white-space:nowrap;box-shadow:var(--shadow)";
  studio.viewport.host.appendChild(hud);

  const reset = (next: Snap[] = [], nextChain: string | null = null) => { pts = next; chain = nextChain; typed = {}; buffer = ""; field = 0; spec.reset?.(); ed.setHint(spec.hint(pts.length)); };

  const at = (ev: { clientX: number; clientY: number }): Snap | null => {
    const raw = ed.planePoint(ev); if (!raw) return null;
    const data = ed.getState().data;
    let s = snap(raw, { data, px: ed.px, ...(spec.context ? spec.context(pts, data, chain) : {}) });
    if (pts.length && spec.constrain && Object.keys(typed).length) {
      const p = spec.constrain(pts, s.p, typed);
      // a typed measure moves the point off whatever it snapped onto; the direction it took is kept
      if (dist(p, s.p) > 1e-9) s = { p, hints: s.hints.filter((h) => h.kind === "horizontal" || h.kind === "vertical" || h.kind === "perpendicular"), guides: [], horizontal: s.horizontal, vertical: s.vertical, perpendicularTo: s.perpendicularTo };
    }
    return s;
  };

  const fields = (): Field[] => (pts.length && spec.fields && cursor ? spec.fields(pts, cursor.p) : []);
  const show = (ev: { clientX: number; clientY: number } | null) => {
    if (!cursor) { ed.setPreview(null); hud.style.display = "none"; return; }
    const data = ed.getState().data;
    ed.setPreview({ lines: pts.length ? spec.preview(pts, cursor, data) : [], points: [cursor.p, ...pts.map((p) => p.p)], hints: cursor.hints, guides: cursor.guides });
    const fs = fields();
    if (!fs.length || !ev) { hud.style.display = "none"; return; }
    hud.replaceChildren(...fs.map((f, i) => {
      const el = document.createElement("span");
      const typing = i === field && buffer !== "", fixed = f.key in typed;
      el.dataset.field = f.key;
      el.textContent = `${f.label} ${typing ? buffer : (f.unit === "deg" ? angText : lenText)(fixed ? typed[f.key] : f.value)}`;
      el.style.cssText = typing ? "outline:1px solid var(--blue);outline-offset:1px;border-radius:2px" : fixed ? "font-weight:600" : i === field ? "" : "color:var(--ink-3)";
      return el;
    }));
    const h = studio.viewport.host.getBoundingClientRect();
    hud.style.display = "flex"; hud.style.left = ev.clientX - h.left + 16 + "px"; hud.style.top = ev.clientY - h.top + 18 + "px";
  };

  const place = (s: Snap): boolean => {
    const ok = spec.accept ? spec.accept(pts, s, ed.getState().data) : true;
    if (ok !== true) { studio.host.toast(ok, 3000); return false; }
    pts = [...pts, s];
    if (pts.length < spec.clicks) { buffer = ""; field = 0; typed = {}; ed.setHint(spec.hint(pts.length)); return true; }
    let made: { next?: Snap[]; chain?: string } | false = false;
    const done = ed.edit((d) => { made = spec.build(d, pts, typed, chain); return made ? undefined : false; });
    const m = made as { next?: Snap[]; chain?: string } | false;
    if (done && m) reset(m.next || [], m.chain || null);
    else pts = pts.slice(0, -1);   // the click made nothing (a zero-length line): wait for another
    return done;
  };

  /** Take what is in the typing buffer as the value of the active field. */
  const takeBuffer = (): boolean => {
    if (buffer === "") return true;
    const fs = fields(), f = fs[field]; if (!f) { buffer = ""; return true; }
    const v = tryEvaluate(buffer, f.unit === "deg" ? "angle" : "length", typedFactor(f.unit === "deg"));
    if (!v || (f.unit === "mm" && !(v.value > 0))) { studio.host.toast(f.unit === "mm" ? "Type a length, like 25 or 1.5 in." : "Type an angle in degrees.", 2500); return false; }
    typed = { ...typed, [f.key]: v.value }; buffer = "";
    return true;
  };

  ed.useTool(spec.id, {
    down(ev) {
      pressed = { x: ev.clientX, y: ev.clientY, fresh: pts.length === 0 };
      if (!takeBuffer()) return;
      const s = at(ev); if (!s) return;
      cursor = s;
      place(s);
      cursor = at(ev);
      show(ev);
    },
    move(ev) { cursor = at(ev); show(ev); },
    up(ev) {
      const p = pressed; pressed = null;
      if (spec.drag && p && p.fresh && pts.length === 1 && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 6) { const s = at(ev); if (s) { place(s); cursor = at(ev); show(ev); } }
    },
    key(ev) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
      const fs = fields(), last = ed.lastPointer;
      const refresh = () => { if (last) cursor = at(last); show(last); };
      if (ev.key === "Escape") {
        if (buffer !== "" || Object.keys(typed).length) { buffer = ""; typed = {}; field = 0; refresh(); return true; }
        if (pts.length) { reset(); refresh(); return true; }
        return false;   // the editor puts the tool down
      }
      if (ev.key === "Enter") {
        if (!pts.length) return false;
        if (!takeBuffer()) return true;
        if (Object.keys(typed).length && last) { const s = at(last); if (s) { cursor = s; place(s); } refresh(); return true; }
        reset(); refresh();   // Enter with nothing typed ends a chain
        return true;
      }
      if (!fs.length) return false;
      if (ev.key === "Tab") { if (takeBuffer()) field = (field + (ev.shiftKey ? fs.length - 1 : 1)) % fs.length; refresh(); return true; }
      if (ev.key === "Backspace") { if (buffer === "") return pts.length > 0; buffer = buffer.slice(0, -1); refresh(); return true; }
      // a value starts with a digit, a point, a minus or a bracket; once started, anything printable is part of it
      if (ev.key.length === 1 && (buffer !== "" ? /[0-9a-z.+\-*/^()"' °]/i.test(ev.key) : /[0-9.(]/.test(ev.key))) { buffer += ev.key; refresh(); return true; }
      return false;
    },
    stop() { hud.remove(); ed.setPreview(null); },
  }, spec.hint(0));
}

