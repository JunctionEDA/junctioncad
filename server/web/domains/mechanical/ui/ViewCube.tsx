// ViewCube.tsx — the view cube in the corner of the viewport: it turns with the model and says which way is up.
//
//   click a face, an edge or a corner     look at the model from there
//   the arrows around it                  turn the view 15° (Shift: 90°); the arrow keys do the same
//   the house                             the isometric view (Shift+7)
//   the frame                             zoom to fit (F)
//   the menu under it                     projection, display mode, section view, planes, named views, zoom
//
// The cube is page elements turned with CSS, not part of the WebGL scene: each face is a 3 × 3 grid whose middle
// cell is the face and whose rim cells are its edges and corners.  Faces carry `data-view` (top, front, …), and
// the element as a whole `v3-views`, which is what the viewport's own view buttons were called.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { cx } from "../../../shared/util";
import { namedViews } from "../document/appearance-items";
import { VIEW_MODES, displayOf } from "../inspect/appearance-display";
import { toggleSection } from "../inspect/section-pick";
import { sectionOf } from "../inspect/section-view";
import { useStore } from "../inspect/store";
import type { CameraState } from "../../../shared/viewport3d/viewport3d";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import type { PartStudio } from "./studio";
import { tipHandlers } from "./Tip";

const SIZE = 64;   // the cube's edge, in pixels
type V = [number, number, number];
/** The faces: which way each looks (its outward normal), and the model directions of its text's right and down. */
const FACES: { view: string; label: string; n: V; right: V; down: V }[] = [
  { view: "top", label: "Top", n: [0, 0, 1], right: [1, 0, 0], down: [0, -1, 0] },
  { view: "bottom", label: "Bottom", n: [0, 0, -1], right: [1, 0, 0], down: [0, 1, 0] },
  { view: "front", label: "Front", n: [0, -1, 0], right: [1, 0, 0], down: [0, 0, -1] },
  { view: "back", label: "Back", n: [0, 1, 0], right: [-1, 0, 0], down: [0, 0, -1] },
  { view: "right", label: "Right", n: [1, 0, 0], right: [0, 1, 0], down: [0, 0, -1] },
  { view: "left", label: "Left", n: [-1, 0, 0], right: [0, -1, 0], down: [0, 0, -1] },
];

/** Look at the model from the direction `from` (a face's normal, or the sum of two or three for an edge or corner). */
function lookFrom(studio: PartStudio, from: V): void {
  const dir = new THREE.Vector3(...from).negate();
  const flat = Math.abs(from[0]) < 1e-9 && Math.abs(from[1]) < 1e-9;
  studio.viewport.lookAlong(dir, flat ? new THREE.Vector3(0, from[2] > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1));
  studio.viewport.canvas.focus();
}

const MENU = '<path d="M5 7h14M5 12h14M5 17h14"/>';
const HOME = '<path d="M4 11l8-7 8 7"/><path d="M6.500 10v9h11v-9"/>';
const FIT = '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>';

export function ViewCube({ studio }: { studio: PartStudio }) {
  const cube = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const display = displayOf(studio), section = sectionOf(studio);
  const mode = useStore(display, (s) => s.mode);
  const perspective = useStore(display, (s) => s.perspective);
  const sectionOn = useStore(section, (s) => s.on);
  const planes = useStudio(studio, (s) => s.planesVisible);
  const sketch = useStudio(studio, (s) => !!s.sketch);
  const hasBodies = useStudio(studio, (s) => s.bodies.length > 0);
  useStudio(studio, (s) => s.features);

  // the cube follows the camera: its matrix is the camera's turn, with y flipped for the page (y runs down)
  useEffect(() => {
    const turn = () => {
      const el = cube.current; if (!el) return;
      const m = new THREE.Matrix4().makeRotationFromQuaternion(studio.viewport.camera.quaternion.clone().invert()).elements;
      // model (x, y, z) → camera (x, y, z) → page (x, −y, z): negate the second row
      el.style.transform = `matrix3d(${m[0]},${-m[1]},${m[2]},0,${m[4]},${-m[5]},${m[6]},0,${m[8]},${-m[9]},${m[10]},0,0,0,0,1)`;
    };
    studio.viewport.onFrame.push(turn);
    turn();
    return () => { const i = studio.viewport.onFrame.indexOf(turn); if (i >= 0) studio.viewport.onFrame.splice(i, 1); };
  }, [studio]);
  useEffect(() => {
    if (!menu) return;
    const away = () => setMenu(false);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); setMenu(false); } };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key, true); };
  }, [menu]);

  const half = SIZE / 2;
  const face = (f: (typeof FACES)[number]) => {
    // the face's own matrix in model space: its right, its down, its normal, and its middle half an edge out
    const t = `matrix3d(${f.right[0]},${f.right[1]},${f.right[2]},0,${f.down[0]},${f.down[1]},${f.down[2]},0,${f.n[0]},${f.n[1]},${f.n[2]},0,${f.n[0] * half},${f.n[1] * half},${f.n[2] * half},1)`;
    const cells: JSX.Element[] = [];
    for (let r = -1; r <= 1; r++) for (let c = -1; c <= 1; c++) {
      const from: V = [f.n[0] + c * f.right[0] + r * f.down[0], f.n[1] + c * f.right[1] + r * f.down[1], f.n[2] + c * f.right[2] + r * f.down[2]];
      const mid = r === 0 && c === 0;
      cells.push(
        <button key={`${r},${c}`} type="button" tabIndex={-1} aria-label={mid ? `${f.label} view` : "View from this edge or corner"} data-view={mid ? f.view : undefined} data-from={from.join(",")}
          className={cx("appearance-none border-0 m-0 p-0 bg-transparent cursor-pointer hover:bg-sel text-ink-2 hover:text-ink [font-family:inherit]", mid && "text-2xs font-semibold uppercase tracking-wide")}
          onClick={() => lookFrom(studio, from)}>{mid ? f.label : null}</button>,
      );
    }
    return (
      <div key={f.view} className="absolute grid grid-cols-[11px_1fr_11px] grid-rows-[11px_1fr_11px] bg-panel border border-line-2 [backface-visibility:hidden]" style={{ width: SIZE, height: SIZE, left: -half, top: -half, transform: t }} data-face={f.view}>{cells}</div>
    );
  };
  const turn = (yaw: number, pitch: number) => (ev: React.MouseEvent) => { const a = ((ev.shiftKey ? 90 : 15) * Math.PI) / 180; studio.viewport.rotateBy(yaw * a, pitch * a); studio.viewport.canvas.focus(); };
  const arrow = (label: string, d: string, cls: string, yaw: number, pitch: number) => (
    <button type="button" tabIndex={-1} className={cx("btn sm ghost absolute p-0 w-5 h-5 min-h-0 justify-center text-ink-3 hover:text-ink", cls)} aria-label={label} data-turn={label} {...tipHandlers({ title: label, shortcut: "arrow keys", hint: "15° a click; with Shift, 90°." })} onClick={turn(yaw, pitch)}>
      <Glyph svg={d} size={14} />
    </button>
  );
  const small = (label: string, svg: string, view: string, shortcut: string, run: () => void) => (
    <button type="button" tabIndex={-1} className="btn sm ghost p-0 w-6 h-6 min-h-0 justify-center text-ink-2" aria-label={label} data-view={view} {...tipHandlers({ title: label, shortcut })} onClick={() => { run(); studio.viewport.canvas.focus(); }}><Glyph svg={svg} size={15} /></button>
  );
  const views = namedViews(studio.doc);
  const row = (label: string, on: boolean | null, run: () => void, o: { key?: string; why?: string | null; attr?: string } = {}) => (
    <button type="button" key={label} role="menuitemcheckbox" aria-checked={!!on} aria-disabled={o.why ? true : undefined} data-view-item={o.attr || label}
      className={cx("appearance-none bg-transparent border-0 m-0 text-inherit [font-family:inherit] [font-size:inherit] flex w-full items-center gap-2 px-2.5 h-7 text-left hover:bg-sel-soft", o.why && "opacity-45")}
      onClick={() => { if (o.why) return; setMenu(false); run(); studio.viewport.canvas.focus(); }}>
      <span className="flex-none w-3.5 text-ink-2">{on ? <Glyph svg='<path d="M5 12.5l4.5 4.5L19 7.500"/>' size={13} /> : null}</span>
      <span className="flex-1">{label}</span>{o.key ? <span className="mono text-xs text-ink-3">{o.key}</span> : null}
    </button>
  );
  const head = (text: string) => <div key={text} className="px-2.5 pt-1.5 pb-0.5 text-2xs uppercase tracking-wide text-ink-3 mono">{text}</div>;
  return (
    <div className="cad-viewcube v3-views absolute top-2 right-2 z-[2] flex flex-col items-center select-none" onPointerDown={(ev) => ev.stopPropagation()} data-projection={perspective ? "perspective" : "orthographic"}>
      <div className="relative" style={{ width: SIZE + 56, height: SIZE + 52 }}>
        <div className="absolute left-1/2 top-1/2" style={{ perspective: 600 }}>
          <div ref={cube} className="[transform-style:preserve-3d]" data-cube>{FACES.map(face)}</div>
        </div>
        {arrow("Turn up", '<path d="M6 14l6-6 6 6"/>', "left-1/2 -ml-2.5 top-0", 0, -1)}
        {arrow("Turn down", '<path d="M6 10l6 6 6-6"/>', "left-1/2 -ml-2.5 bottom-0", 0, 1)}
        {arrow("Turn left", '<path d="M14 6l-6 6 6 6"/>', "left-0 top-1/2 -mt-2.5", -1, 0)}
        {arrow("Turn right", '<path d="M10 6l6 6-6 6"/>', "right-0 top-1/2 -mt-2.5", 1, 0)}
      </div>
      <div className="flex items-center gap-px rounded-sm border border-line bg-panel">
        {small("Isometric view", HOME, "iso", "Shift+7", () => studio.viewport.setView("iso"))}
        {small("Zoom to fit", FIT, "fit", "F", () => studio.fit())}
        <button type="button" tabIndex={-1} className={cx("btn sm ghost p-0 w-6 h-6 min-h-0 justify-center text-ink-2", menu && "on")} aria-label="View options" aria-haspopup="menu" aria-expanded={menu} data-view-menu {...tipHandlers({ title: "View options", hint: "Projection, display mode, section view, planes, named views." })} onClick={() => setMenu(!menu)}><Glyph svg={MENU} size={15} /></button>
      </div>
      {menu ? (
        <div className="cad-view-menu absolute right-0 top-full mt-1 z-[50] w-60 max-h-[70vh] overflow-y-auto py-1 rounded-md border border-line bg-panel shadow-panel text-base text-ink" role="menu">
          {head("Projection")}
          {row("Orthographic", !perspective, () => display.setPerspective(false))}
          {row("Perspective", perspective, () => display.setPerspective(true))}
          {head("Display")}
          {VIEW_MODES.map((m, i) => row(m.title, mode === m.id, () => display.setMode(m.id), { key: i === 0 ? "W cycles" : undefined, why: sketch ? "Finish the sketch first" : null }))}
          {head("Show")}
          {row("Planes", planes, () => studio.setPlanesVisible(!planes), { key: "P" })}
          {row("Section view", sectionOn, () => { void toggleSection(studio); }, { key: "X", why: sketch ? "Finish the sketch first" : hasBodies ? null : "Nothing to cut" })}
          {head("Zoom")}
          {row("Zoom to fit", null, () => studio.fit(), { key: "F" })}
          {row("Zoom to selection", null, () => studio.zoomToSelection(), { key: "Z" })}
          {row("View normal to", null, () => studio.normalTo(), { key: "N" })}
          {head("Views")}
          {(["front", "back", "left", "right", "top", "bottom", "iso"] as const).map((v, i) => row(v === "iso" ? "Isometric" : v[0].toUpperCase() + v.slice(1), null, () => studio.viewport.setView(v), { key: `Shift+${i + 1}`, attr: "std-" + v }))}
          {views.length ? head("Named views") : null}
          {views.map((v) => row(v.name, null, () => studio.viewport.setCameraState(v.camera as unknown as CameraState), { attr: "named-" + v.name }))}
        </div>
      ) : null}
    </div>
  );
}
