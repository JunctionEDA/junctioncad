// planes.ts — the default geometry of a part studio in the viewport: the origin and the Top, Front and Right
// planes, each a translucent rectangle with its name on it, and the name labels of reference planes.
//
//   • A plane is as large as the model needs: its rectangle reaches a little past the model's box on its two
//     axes (never smaller than `MIN_HALF`), and grows and shrinks as the model does.
//   • A label is text in the page, not in the scene: always upright and the same size, anchored inside one
//     corner of its plane, and fading out as the plane turns edge-on (where the corner says nothing).
//   • Each of the four can be hidden on its own (the feature list's eye); a hidden plane is not picked.
//
// ModelView (modelview.ts) owns one PlaneLayer; it holds no document state.
import * as THREE from "three";
import type { Viewport3D } from "../../../shared/viewport3d/viewport3d";
import { DEFAULT_PLANES, type DefaultPlaneId, type Frame, type Vec3 } from "../core/geometry";

/** The ids of the default geometry, as the feature list and the hidden set know them. */
export type DefaultGeometryId = "origin" | DefaultPlaneId;
export const DEFAULT_GEOMETRY: readonly { id: DefaultGeometryId; title: string }[] = [
  { id: "origin", title: "Origin" }, { id: "top", title: "Top" }, { id: "front", title: "Front" }, { id: "right", title: "Right" },
];

const MIN_HALF = 30;
const GROW = 1.2;

interface PlaneObjects { id: DefaultPlaneId; quad: THREE.Mesh; outline: THREE.LineLoop; half: [number, number] }
interface Label { key: string; el: HTMLSpanElement; corners: THREE.Vector3[]; normal: THREE.Vector3; visible: boolean }

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);
const corner = (f: Frame, u: number, v: number) => v3(f.origin).addScaledVector(v3(f.x), u).addScaledVector(v3(f.y), v);

export class PlaneLayer {
  readonly group = new THREE.Group();
  private planes: PlaneObjects[] = [];
  private origin: THREE.Points;
  private labels = new Map<string, Label>();
  private readonly layer: HTMLDivElement;
  private hidden = new Set<string>();
  private marked = new Set<string>();
  private color = new THREE.Color();

  constructor(private readonly viewport: Viewport3D) {
    for (const id of Object.keys(DEFAULT_PLANES) as DefaultPlaneId[]) {
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
      const quad = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.045, side: THREE.DoubleSide, depthWrite: false }));
      quad.userData.plane = id;
      const og = new THREE.BufferGeometry(); og.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
      const outline = new THREE.LineLoop(og, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6 }));
      this.group.add(quad, outline);
      this.planes.push({ id, quad, outline, half: [0, 0] });
    }
    this.origin = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]), new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, depthTest: false }));
    this.origin.renderOrder = 6;
    this.group.add(this.origin);
    this.layer = document.createElement("div");
    this.layer.className = "cad-plane-labels";
    this.layer.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:1";
    viewport.host.appendChild(this.layer);
    this.setExtent(null);
    viewport.onFrame.push(this.place);
  }

  dispose(): void {
    this.layer.remove();
    const i = this.viewport.onFrame.indexOf(this.place); if (i >= 0) this.viewport.onFrame.splice(i, 1);
  }

  setColor(c: THREE.Color): void {
    this.color.copy(c);
    for (const p of this.planes) { (p.quad.material as THREE.MeshBasicMaterial).color.copy(c); (p.outline.material as THREE.LineBasicMaterial).color.copy(c); }
    (this.origin.material as THREE.PointsMaterial).color.copy(c);
  }

  /** Size the planes for a model that fills `box` (null: no model yet). */
  setExtent(box: THREE.Box3 | null): void {
    const reach = (axis: THREE.Vector3): number => {
      if (!box || box.isEmpty()) return MIN_HALF;
      const lo = box.min.dot(axis), hi = box.max.dot(axis);
      return Math.max(MIN_HALF, Math.max(Math.abs(lo), Math.abs(hi)) * GROW);
    };
    for (const p of this.planes) {
      const f = DEFAULT_PLANES[p.id].frame;
      // the frames' axes are world axes, so the box's reach along one is the dot with its corners' extremes
      const hx = reach(v3(f.x).set(Math.abs(f.x[0]), Math.abs(f.x[1]), Math.abs(f.x[2]))), hy = reach(v3(f.y).set(Math.abs(f.y[0]), Math.abs(f.y[1]), Math.abs(f.y[2])));
      if (p.half[0] === hx && p.half[1] === hy) continue;
      p.half = [hx, hy];
      const pts = [corner(f, -hx, -hy), corner(f, hx, -hy), corner(f, hx, hy), corner(f, -hx, hy)];
      for (const o of [p.quad, p.outline]) {
        const a = o.geometry.getAttribute("position") as THREE.BufferAttribute;
        pts.forEach((q, i) => a.setXYZ(i, q.x, q.y, q.z));
        a.needsUpdate = true;
        o.geometry.computeBoundingSphere(); o.geometry.computeBoundingBox();
      }
      // the name sits inside the corner at the top left of the plane as its own axes have it
      this.setLabel("plane:" + p.id, DEFAULT_PLANES[p.id].title, pts, v3(f.normal));
    }
    this.apply();
  }
  /** How far a default plane reaches from the origin along its two axes. */
  halfOf(id: DefaultPlaneId): [number, number] { return this.planes.find((p) => p.id === id)?.half || [MIN_HALF, MIN_HALF]; }

  /** A name for a rectangle in the scene (a default plane, a reference plane), given its four corners in order. */
  setLabel(key: string, text: string, corners: readonly THREE.Vector3[], normal: THREE.Vector3): void {
    let l = this.labels.get(key);
    if (!l) {
      const el = document.createElement("span");
      el.className = "cad-plane-label mono text-xs text-ink-2 select-none [text-shadow:0_0_3px_var(--color-paper),0_0_3px_var(--color-paper)] data-[on]:text-ink data-[on]:font-semibold";
      el.style.cssText = "position:absolute;left:0;top:0;white-space:nowrap;will-change:transform,opacity";
      el.dataset.planeLabel = key;
      this.layer.appendChild(el);
      l = { key, el, corners: [], normal: new THREE.Vector3(), visible: true };
      this.labels.set(key, l);
    }
    if (l.el.textContent !== text) l.el.textContent = text;
    l.corners = corners.map((c) => c.clone()); l.normal.copy(normal).normalize();
    this.viewport.invalidate();
  }
  /** Drop the labels whose key starts with `prefix` and is not in `keep`. */
  pruneLabels(prefix: string, keep: ReadonlySet<string>): void {
    for (const [key, l] of Array.from(this.labels)) if (key.startsWith(prefix) && !keep.has(key)) { l.el.remove(); this.labels.delete(key); }
  }
  setLabelVisible(key: string, on: boolean): void { const l = this.labels.get(key); if (l && l.visible !== on) { l.visible = on; this.viewport.invalidate(); } }
  /** Draw these labels strongly (the plane under the pointer, the selected ones). */
  setMarked(keys: ReadonlySet<string>): void {
    this.marked = new Set(keys);
    for (const l of this.labels.values()) l.el.toggleAttribute("data-on", this.marked.has(l.key));
  }

  /** Which of the default geometry is hidden. */
  setHidden(ids: ReadonlySet<string>): void { this.hidden = new Set(ids); this.apply(); }
  isShown(id: DefaultGeometryId): boolean { return !this.hidden.has(id); }
  private apply(): void {
    for (const p of this.planes) { const on = !this.hidden.has(p.id); p.quad.visible = on; p.outline.visible = on; this.setLabelVisible("plane:" + p.id, on); }
    this.origin.visible = !this.hidden.has("origin");
    this.viewport.invalidate();
  }

  /** The default plane's rectangle, for the highlight (null when it is hidden). */
  quadOf(id: DefaultPlaneId): THREE.Mesh | null { const p = this.planes.find((x) => x.id === id); return p && p.quad.visible ? p.quad : null; }
  /** The rectangles the pointer can hit. */
  pickable(): THREE.Object3D[] { return this.planes.filter((p) => p.quad.visible).map((p) => p.quad); }

  /** Put every label where its corner is on screen now.  Called before each frame. */
  private place = (): void => {
    if (!this.labels.size) return;
    const view = new THREE.Vector3(0, 0, -1).applyQuaternion(this.viewport.camera.quaternion);
    for (const l of this.labels.values()) {
      const facing = Math.abs(l.normal.dot(view));
      // edge-on, the rectangle is a sliver and a name at its corner would float over nothing
      const alpha = l.visible ? Math.max(0, Math.min(1, (facing - 0.1) / 0.25)) : 0;
      if (alpha <= 0.01) { if (l.el.style.display !== "none") l.el.style.display = "none"; continue; }
      // The name sits inside a corner of the rectangle: the corner highest on screen among those in view, so it
      // reads like a tab on the plane and is not lost when the plane runs off the edge of the viewport.
      const at = l.corners.map((c) => this.viewport.project(c));
      const W = this.viewport.width, H = this.viewport.height;
      let pick = -1;
      for (let i = 0; i < at.length; i++) {
        if (at[i].x < 6 || at[i].x > W - 6 || at[i].y < 6 || at[i].y > H - 6) continue;
        if (pick < 0 || at[i].y < at[pick].y - 0.5 || (Math.abs(at[i].y - at[pick].y) <= 0.5 && at[i].x < at[pick].x)) pick = i;
      }
      if (pick < 0) { if (l.el.style.display !== "none") l.el.style.display = "none"; continue; }
      const a = at[pick], b = at[(pick + 2) % at.length];
      // a few pixels in from the corner, towards the opposite one, whichever way the plane is turned on screen
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const w = l.el.offsetWidth || 40, h = l.el.offsetHeight || 14;
      const inX = (dx / len) * 8, inY = (dy / len) * 8;
      const x = a.x + inX - (dx < 0 ? w : 0), y = a.y + inY - (dy < 0 ? h : 0);
      l.el.style.display = "";
      l.el.style.opacity = String(Math.round(alpha * 100) / 100);
      l.el.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    }
  };
}
