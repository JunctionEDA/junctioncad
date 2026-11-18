// drawing.ts — the engine behind the sketch tools that are drawn with two points (line, rectangle, circle):
// snapping, the rubber band, the size readout, and the commit.  A tool file under tools/ supplies the shape.
//
// A sketch tool is not a constraint solver.  It writes solved coordinates into the sketch (sketch/format.ts);
// snapping to existing points and to round numbers is what keeps outlines closed until a solver exists.
import type { ItemChange, JsonObject } from "../../../shared/itemdoc/itemdoc";
import { DEFAULT_PLANES, toWorld, type Frame, type PlaneRef, type Vec2, type Vec3 } from "../core/geometry";
import type { PartStudio } from "../ui/studio";
import { emptySketch, pointOf, type SketchData, type SketchEntity } from "./format";

/** A position in the sketch plane, and the existing point it snapped onto, if any. */
export interface Snap { p: Vec2; id?: string }

export interface TwoPointShape {
  /** the tool's id, as `studio.getState().sketch.tool` has it */
  id: string;
  /** The entities to add for points a and b, or null when they make nothing (a zero-size shape). */
  build(sketch: SketchData, a: Snap, b: Snap): { entities: { [id: string]: SketchEntity }; next?: Snap } | null;
  /** The rubber band: polylines in sketch coordinates. */
  preview(a: Vec2, b: Vec2): Vec2[][];
  /** The size readout shown at the pointer ("40 × 20"). */
  readout(a: Vec2, b: Vec2): string;
}

export const fmt = (v: number): string => (Math.round(v * 100) / 100).toString();

/** The sketch that is open, as the document has it now. */
export function openSketch(studio: PartStudio): { featureId: string; data: SketchData; frame: Frame } | null {
  const s = studio.getState(); if (!s.sketch) return null;
  const f = s.features.find((x) => x.id === s.sketch!.featureId); if (!f) return null;
  const plane = f.params.plane as unknown as PlaneRef | undefined;
  const frame = studio.view.sketchFrame(f.id) || (plane && plane.kind === "plane" && DEFAULT_PLANES[plane.plane] ? DEFAULT_PLANES[plane.plane].frame : null);
  if (!frame) return null;
  const data = (f.params.sketch as unknown as SketchData) || emptySketch();
  return { featureId: f.id, data: { ...emptySketch(), ...data, entities: data.entities || {}, constraints: data.constraints || {} }, frame };
}

/** The change that adds (or with null removes) entities of a sketch.  One change, so one undo step. */
export function sketchEntitiesChange(featureId: string, entities: { [id: string]: SketchEntity | null }): ItemChange {
  return { id: featureId, kind: "MODIFIED", typeName: "feature", props: Object.entries(entities).map(([id, e]) => (e ? { path: ["params", "sketch", "entities", id], value: e as JsonObject } : { path: ["params", "sketch", "entities", id], del: true })) };
}

/** Where the pointer is in the sketch, snapped: onto a point within reach, else the origin, else a round number. */
export function snapPointer(studio: PartStudio, ev: { clientX: number; clientY: number }, data: SketchData, frame: Frame): Snap | null {
  const raw = studio.view.planePoint(ev, frame); if (!raw) return null;
  const px = studio.viewport.pixelSize(), reach = 9 * px;
  let best: Snap | null = null, bestD = reach;
  for (const id of Object.keys(data.entities)) {
    const p = pointOf(data, id); if (!p) continue;
    const d = Math.hypot(p[0] - raw[0], p[1] - raw[1]);
    if (d < bestD) { bestD = d; best = { p, id }; }
  }
  if (best) return best;
  if (Math.hypot(raw[0], raw[1]) < reach) return { p: [0, 0] };
  // the smallest of 1, 2, 5 × 10ⁿ mm that is at least four pixels on screen: zoom in for finer positions
  const decade = Math.pow(10, Math.floor(Math.log10(px * 4)));
  const step = [1, 2, 5, 10].map((m) => m * decade).find((v) => v >= px * 4) || decade * 10;
  const round = (v: number) => { const r = Math.round(v / step) * step; return Math.round(r * 1e6) / 1e6; };
  return { p: [round(raw[0]), round(raw[1])] };
}

/** Take a two-point tool in hand: installs the pointer and key handling on the studio until another tool is chosen. */
export function startTwoPointTool(studio: PartStudio, shape: TwoPointShape): void {
  studio.setSketchTool(shape.id);
  let a: Snap | null = null, pressed: { x: number; y: number } | null = null, freshA = false;
  const hud = document.createElement("div");
  hud.className = "cad-hud";
  hud.style.cssText = "position:absolute;z-index:3;pointer-events:none;display:none;padding:1px 6px;border:1px solid var(--line);border-radius:var(--r-2);background:var(--panel);color:var(--ink);font:var(--fs-xs) var(--mono);white-space:nowrap";
  studio.viewport.host.appendChild(hud);
  const stillMine = () => studio.getState().sketch?.tool === shape.id;
  const clear = () => { studio.view.setOverlay(null); hud.style.display = "none"; };
  const stop = () => { clear(); hud.remove(); };

  const draw = (ev: PointerEvent) => {
    const sk = openSketch(studio); if (!sk) return;
    const b = snapPointer(studio, ev, sk.data, sk.frame); if (!b) return;
    const dots: Vec3[] = [toWorld(sk.frame, b.p)];
    const seg: number[] = [];
    if (a) {
      dots.push(toWorld(sk.frame, a.p));
      for (const line of shape.preview(a.p, b.p)) for (let i = 0; i + 1 < line.length; i++) seg.push(...toWorld(sk.frame, line[i]), ...toWorld(sk.frame, line[i + 1]));
      const h = studio.viewport.host.getBoundingClientRect();
      hud.textContent = shape.readout(a.p, b.p);
      hud.style.display = "block"; hud.style.left = ev.clientX - h.left + 14 + "px"; hud.style.top = ev.clientY - h.top + 14 + "px";
    } else hud.style.display = "none";
    studio.view.setOverlay(seg, dots);
  };
  const finish = (ev: PointerEvent) => {
    const sk = openSketch(studio); if (!sk || !a) return;
    const b = snapPointer(studio, ev, sk.data, sk.frame); if (!b) return;
    const made = shape.build(sk.data, a, b);
    if (!made) return;
    studio.commit([sketchEntitiesChange(sk.featureId, made.entities)]);
    a = made.next || null;
    freshA = false;
    draw(ev);
  };

  studio.view.pointerTool = {
    down: (ev) => {
      if (!stillMine()) { stop(); return; }
      pressed = { x: ev.clientX, y: ev.clientY };
      const sk = openSketch(studio);
      if (!sk) { studio.host.toast("The sketch is still loading. Try again in a moment."); return; }
      if (!a) { a = snapPointer(studio, ev, sk.data, sk.frame); freshA = true; draw(ev); }
      else finish(ev);
    },
    move: (ev) => { if (!stillMine()) { stop(); return; } draw(ev); },
    // press, drag, release draws the shape in one stroke
    up: (ev) => { if (a && freshA && pressed && Math.hypot(ev.clientX - pressed.x, ev.clientY - pressed.y) > 6) finish(ev); pressed = null; },
  };
  studio.keyHandler = (ev) => {
    if (!stillMine()) { stop(); return false; }
    if (ev.key === "Escape" && a) { a = null; clear(); return true; }   // a second Esc puts the tool down (studio.ts)
    if (ev.key === "Escape") { stop(); return false; }
    return false;
  };
}
