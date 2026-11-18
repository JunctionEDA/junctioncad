// measure-session.ts — measuring in the part studio: whatever is selected is measured by the worker (the
// "measure" service, exact from the B-rep), the readout in the corner of the viewport shows it, and while the
// Measure tool is on the measurement is also drawn on the model as dimension lines.  A measurement can be pinned:
// it stays on the model, and is measured again after every rebuild, until it is unpinned.
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { tokenColor } from "../../../shared/viewport3d/viewport3d";
import type { Vec3 } from "../core/geometry";
import type { MeasureItem, MeasureResult } from "../services/measure-entities";
import type { PartStudio } from "../ui/studio";
import type { Pick } from "../viewport/modelview";
import { DIMS_LAYER, DIM_LABEL, DIM_LIVE, DIM_PINNED } from "./measure-classes";
import { copyNum, mm, mm2, readout } from "./measure-format";
import { Store, perStudio } from "./store";

export interface Pin { id: number; items: MeasureItem[]; result: MeasureResult | null; title: string }

export interface MeasureState {
  /** the Measure tool is on: dimension lines are drawn for the selection */
  active: boolean;
  items: MeasureItem[];
  result: MeasureResult | null;
  error: string;
  busy: boolean;
  pins: Pin[];
}

/** The picks a measurement takes: faces, edges, vertices and default planes. */
export function measureItems(picks: readonly Pick[]): MeasureItem[] {
  const out: MeasureItem[] = [];
  for (const p of picks) {
    if (p.kind === "face" || p.kind === "edge" || p.kind === "vertex") out.push({ kind: p.kind, body: p.body, name: p.name });
    else if (p.kind === "plane") out.push({ kind: "plane", plane: p.plane });
  }
  return out;
}

/** One dimension on the model: a line from a to b (none when they are the same point) and its label. */
export interface Dim { a: Vec3; b: Vec3; text: string; copy: string; dashed?: boolean }

/** The dimensions a measurement draws. */
export function dimsOf(r: MeasureResult | null): Dim[] {
  if (!r || !r.items.length) return [];
  const out: Dim[] = [];
  if (r.items.length === 2 && r.pair) {
    const p = r.pair;
    if (p.min) out.push({ a: p.min.a, b: p.min.b, text: mm(p.min.distance), copy: copyNum(p.min.distance) });
    if (p.centre && p.min && Math.abs(p.centre.distance - p.min.distance) > 1e-6) out.push({ a: p.centre.a, b: p.centre.b, text: `⊙ ${mm(p.centre.distance)}`, copy: copyNum(p.centre.distance), dashed: true });
    return out;
  }
  if (r.items.length === 1) {
    const e = r.items[0];
    if (e.point) return [{ a: e.point, b: e.point, text: `${mm(e.point[0])}, ${mm(e.point[1])}, ${mm(e.point[2])}`.replace(/ mm/g, ""), copy: e.point.map(copyNum).join(", ") }];
    if (e.kind === "edge" && e.start && e.end && e.curve === "line") return [{ a: e.start, b: e.end, text: mm(e.length || 0), copy: copyNum(e.length || 0) }];
    if (e.radius !== undefined && e.center) return [{ a: e.center, b: e.center, text: `⌀ ${mm(2 * e.radius)}`, copy: copyNum(2 * e.radius) }];
    if (e.kind === "edge") return [{ a: e.centroid, b: e.centroid, text: mm(e.length || 0), copy: copyNum(e.length || 0) }];
    if (e.kind === "face") return [{ a: e.centroid, b: e.centroid, text: mm2(e.area || 0), copy: copyNum(e.area || 0) }];
  }
  return out;
}

export class MeasureSession extends Store<MeasureState> {
  private seq = 0;
  private timer = 0;
  private lastSelection: unknown = null;
  private lastBodies: unknown = null;
  private nextPin = 1;
  private readonly overlay: DimensionOverlay;

  constructor(readonly studio: PartStudio) {
    super({ active: false, items: [], result: null, error: "", busy: false, pins: [] });
    this.overlay = new DimensionOverlay(studio);
    studio.subscribe(() => {
      const s = studio.getState();
      const selChanged = s.selection !== this.lastSelection, rebuilt = s.bodies !== this.lastBodies;
      if (!selChanged && !rebuilt) return;
      this.lastSelection = s.selection; this.lastBodies = s.bodies;
      if (selChanged) { const items = measureItems(s.selection); this.set({ items, result: items.length ? this.state.result : null, error: "" }); if (!items.length) this.draw(); }
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.measure(rebuilt), 30);
    });
  }

  setActive(on: boolean): void { this.set({ active: on }); this.draw(); }

  private async measure(rebuilt: boolean): Promise<void> {
    const seq = ++this.seq, items = this.state.items;
    if (rebuilt && this.state.pins.length) void this.remeasurePins();
    if (!items.length || !this.studio.getState().bodies.length && !items.every((i) => i.kind === "plane")) { this.set({ result: null, busy: false, error: "" }); this.draw(); return; }
    this.set({ busy: true });
    try {
      const result = await this.studio.kernel.call<Json>("measure", { items } as unknown as Json) as unknown as MeasureResult;
      if (seq !== this.seq) return;
      this.set({ result, busy: false, error: "" });
    } catch (e) {
      if (seq !== this.seq) return;
      this.set({ result: null, busy: false, error: e instanceof Error ? e.message : String(e) });
    }
    this.draw();
  }

  private async remeasurePins(): Promise<void> {
    const pins = await Promise.all(this.state.pins.map(async (p) => {
      try { return { ...p, result: await this.studio.kernel.call<Json>("measure", { items: p.items } as unknown as Json) as unknown as MeasureResult }; }
      catch (e) { return { ...p, result: null }; }
    }));
    // keep only the pins that are still there
    this.set({ pins: pins.filter((p) => this.state.pins.some((q) => q.id === p.id)) });
    this.draw();
  }

  /** Keep the current measurement on the model. */
  pin(): void {
    const s = this.state; if (!s.result || !s.items.length) return;
    this.set({ pins: [...s.pins, { id: this.nextPin++, items: s.items, result: s.result, title: readout(s.result).title }] });
    this.draw();
  }
  unpin(id: number | null): void { this.set({ pins: id === null ? [] : this.state.pins.filter((p) => p.id !== id) }); this.draw(); }

  private draw(): void {
    const s = this.state;
    const dims: { dim: Dim; pinned: boolean }[] = [];
    for (const p of s.pins) for (const d of dimsOf(p.result)) dims.push({ dim: d, pinned: true });
    if (s.active) for (const d of dimsOf(s.result)) dims.push({ dim: d, pinned: false });
    this.overlay.draw(dims);
  }
}

/** Dimension lines in model space and their labels as HTML over the canvas, kept in place every frame. */
class DimensionOverlay {
  private readonly group = new THREE.Group();
  private readonly box: HTMLDivElement;
  private labels: { el: HTMLElement; at: THREE.Vector3 }[] = [];
  private mats: LineMaterial[] = [];

  constructor(private readonly studio: PartStudio) {
    const vp = studio.viewport;
    vp.scene.add(this.group);
    this.box = document.createElement("div");
    this.box.className = DIMS_LAYER;
    vp.host.appendChild(this.box);
    vp.onFrame.push(() => this.place());
  }

  draw(dims: { dim: Dim; pinned: boolean }[]): void {
    for (const o of this.group.children.slice()) { this.group.remove(o); (o as THREE.Mesh).geometry.dispose(); }
    for (const m of this.mats) m.dispose();
    this.mats = []; this.box.replaceChildren(); this.labels = [];
    const vp = this.studio.viewport;
    const mark = tokenColor("--mark"), ink = tokenColor("--ink-2");
    for (const { dim, pinned } of dims) {
      const color = pinned ? ink : mark;
      const a = new THREE.Vector3(...dim.a), b = new THREE.Vector3(...dim.b);
      if (a.distanceTo(b) > 1e-9) {
        const g = new LineSegmentsGeometry(); g.setPositions([a.x, a.y, a.z, b.x, b.y, b.z]);
        const m = new LineMaterial({ color: color.getHex(), linewidth: 2, depthTest: false, transparent: true, dashed: !!dim.dashed, dashSize: vp.pixelSize() * 6, gapSize: vp.pixelSize() * 4 });
        m.resolution.set(vp.width, vp.height);
        this.mats.push(m);
        const l = new LineSegments2(g, m); l.renderOrder = 20; if (dim.dashed) l.computeLineDistances();
        l.raycast = () => {};
        this.group.add(l);
        const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.PointsMaterial({ color, size: 7, sizeAttenuation: false, depthTest: false }));
        dots.renderOrder = 21; dots.raycast = () => {};
        this.group.add(dots);
      }
      const el = document.createElement("button");
      el.type = "button";
      el.className = DIM_LABEL + " " + (pinned ? DIM_PINNED : DIM_LIVE);
      el.textContent = dim.text;
      el.title = "Click to copy";
      el.dataset.copy = dim.copy;
      el.onclick = () => copyText(dim.copy, this.studio);
      this.box.appendChild(el);
      this.labels.push({ el, at: a.clone().add(b).multiplyScalar(0.5) });
    }
    this.place();
    vp.invalidate();
  }

  private place(): void {
    const vp = this.studio.viewport;
    for (const m of this.mats) m.resolution.set(vp.width, vp.height);
    for (const l of this.labels) { const p = vp.project(l.at); l.el.style.left = `${p.x}px`; l.el.style.top = `${p.y}px`; }
  }
}

/** Put a value on the clipboard and say so. */
export function copyText(text: string, studio: PartStudio): void {
  const done = () => studio.host.toast(`Copied ${text}`, 1400);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, () => fallback(text) && done()); return; }
  } catch (e) { /* below */ }
  if (fallback(text)) done();
}
function fallback(text: string): boolean {
  const t = document.createElement("textarea");
  t.value = text; t.style.cssText = "position:fixed;left:-1000px;top:0";
  document.body.appendChild(t); t.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
  t.remove();
  return ok;
}

export const measureOf = (studio: PartStudio): MeasureSession => perStudio(studio, "measure-session", (s) => new MeasureSession(s));
