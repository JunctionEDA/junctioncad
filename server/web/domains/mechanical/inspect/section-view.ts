// section-view.ts — the section view: every part cut by a plane on the graphics card, with the cut faces capped
// and hatched, so dragging the plane stays at frame rate (no kernel booleans).
//
// The plane is a default plane or a picked planar face, moved along its normal by an offset, and flipped to
// keep the other side.  The parts' materials clip at it (appearance-display.ts `setClip`); the caps use the
// stencil buffer: for each part, its back faces add one and its front faces take one away where they are not
// clipped, so the stencil is non-zero exactly where the plane passes inside the solid, and a quad on the plane is
// drawn there (and resets the stencil for the next part).  Picking skips what is cut away (`view.pickClip`).
import * as THREE from "three";
import { DEFAULT_PLANES, type DefaultPlaneId, type Vec3 } from "../core/geometry";
import type { PartStudio } from "../ui/studio";
import { displayOf } from "./appearance-display";
import { clipPlane, extentAlong } from "./section-plane";
import { Store, perStudio } from "./store";

export { clipPlane, extentAlong };

export type SectionPlane = DefaultPlaneId | "face";

export interface SectionState {
  on: boolean;
  plane: SectionPlane;
  /** the face it was taken from, when `plane` is "face" */
  face: { body: string; name: string } | null;
  /** a point of the base plane and its unit normal (the side that is cut away, before `flip`) */
  origin: Vec3; normal: Vec3;
  /** how far the plane is moved along the normal from `origin`, mm */
  offset: number;
  /** the model's extent along the normal, relative to `origin`: the offset slider's ends */
  range: [number, number];
  flip: boolean;
  hatch: boolean;
}

let hatchTexture: THREE.Texture | null = null;
/** Diagonal hatching as a texture the cap's colour is multiplied by: light ground, darker lines. */
function hatch(): THREE.Texture {
  if (hatchTexture) return hatchTexture;
  const n = 32, data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = (x + y) % 16, line = d < 2;
    const v = line ? 120 : 235, o = (y * n + x) * 4;
    data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  hatchTexture = t;
  return t;
}

export class SectionView extends Store<SectionState> {
  private readonly group = new THREE.Group();
  private parts: { back: THREE.Mesh; front: THREE.Mesh; cap: THREE.Mesh }[] = [];

  constructor(readonly studio: PartStudio) {
    super({ on: false, plane: "front", face: null, origin: [0, 0, 0], normal: DEFAULT_PLANES.front.frame.normal, offset: 0, range: [-50, 50], flip: false, hatch: true });
    studio.viewport.scene.add(this.group);
    displayOf(studio).onApplied.push(() => { if (this.state.on) this.rebuild(); });
  }

  /** The boxes of the parts on screen. */
  private boxes(): number[][] {
    const d = displayOf(this.studio);
    return this.studio.getState().bodies.filter((b) => b.mesh && d.isVisible(b.id)).map((b) => b.mesh!.bbox.slice());
  }

  /** Turn the section on at a default plane (through the middle of the model) or at a planar face. */
  open(plane: SectionPlane = this.state.plane, face?: { body: string; name: string; origin: Vec3; normal: Vec3 }): void {
    let origin: Vec3 = [0, 0, 0], normal: Vec3;
    if (plane === "face" && face) { origin = face.origin; normal = face.normal; }
    else { const p = DEFAULT_PLANES[(plane === "face" ? "front" : plane) as DefaultPlaneId]; normal = p.frame.normal; plane = plane === "face" ? "front" : plane; }
    const range = extentAlong(this.boxes(), origin, normal);
    // the plane starts through the middle of the model; at a face, what lies in front of the face is cut away
    const offset = Math.max(range[0], Math.min(range[1], (range[0] + range[1]) / 2));
    this.set({ on: true, plane, face: face ? { body: face.body, name: face.name } : null, origin, normal, range, offset, flip: plane === "face" ? false : this.state.flip });
    this.update(true);
  }
  close(): void { this.set({ on: false }); this.update(true); }
  setOffset(offset: number): void { this.set({ offset }); this.update(false); }
  setFlip(flip: boolean): void { this.set({ flip }); this.update(false); }
  setHatch(on: boolean): void { this.set({ hatch: on }); this.update(true); }

  /** The plane in force, or null when the section is off. */
  plane(): THREE.Plane | null { return this.state.on ? clipPlane(this.state) : null; }

  private update(rebuild: boolean): void {
    const plane = this.plane();
    displayOf(this.studio).setClip(plane ? [plane] : []);
    this.studio.view.pickClip = plane ? (p) => plane.distanceToPoint(new THREE.Vector3(...p)) >= -1e-6 : null;
    if (rebuild || !this.parts.length) this.rebuild();
    else this.placeCaps(plane);
    this.studio.viewport.invalidate();
  }

  private clear(): void {
    for (const p of this.parts) { this.group.remove(p.back, p.front, p.cap); for (const m of [p.back, p.front, p.cap]) (m.material as THREE.Material).dispose(); p.cap.geometry.dispose(); }
    this.parts = [];
  }

  /** The stencil writers and the cap of every visible part. */
  private rebuild(): void {
    this.clear();
    const plane = this.plane();
    if (!plane) return;
    const display = displayOf(this.studio);
    const boxes = this.boxes();
    const size = Math.max(1, ...boxes.map((b) => Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]))) * 4;
    let order = 50;
    for (const b of this.studio.getState().bodies) {
      const o = this.studio.view.bodyObjects(b.id);
      if (!o || !b.mesh || !display.isVisible(b.id)) continue;
      const writer = (side: THREE.Side, op: THREE.StencilOp) => new THREE.MeshBasicMaterial({
        side, clippingPlanes: [plane], colorWrite: false, depthWrite: false, depthTest: false,
        stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op,
      });
      const back = new THREE.Mesh(o.mesh.geometry, writer(THREE.BackSide, THREE.IncrementWrapStencilOp));
      const front = new THREE.Mesh(o.mesh.geometry, writer(THREE.FrontSide, THREE.DecrementWrapStencilOp));
      back.renderOrder = order; front.renderOrder = order;
      const color = display.colorOf(b.id).multiplyScalar(0.8);
      const capMat = new THREE.MeshBasicMaterial({
        color, side: THREE.DoubleSide, map: this.state.hatch ? hatch() : null,
        stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
      });
      const capGeo = new THREE.PlaneGeometry(size, size);
      // lines about 9 pixels apart at the zoom the section was opened at (the texture has two lines a tile)
      const uv = capGeo.getAttribute("uv") as THREE.BufferAttribute, reps = Math.max(4, Math.min(2000, size / (18 * this.studio.viewport.pixelSize())));
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * reps, uv.getY(i) * reps);
      const cap = new THREE.Mesh(capGeo, capMat);
      // drawn where the stencil is set, and it sets it back to zero there for the next part
      cap.renderOrder = order + 1;
      for (const m of [back, front, cap]) { m.raycast = () => {}; m.matrixAutoUpdate = true; }
      this.group.add(back, front, cap);
      this.parts.push({ back, front, cap });
      order += 2;
    }
    this.placeCaps(plane);
  }

  /** Put every cap on the plane, centred on the model, facing the side that is cut away. */
  private placeCaps(plane: THREE.Plane | null): void {
    if (!plane) return;
    const boxes = this.boxes();
    const c = new THREE.Vector3();
    if (boxes.length) { for (const b of boxes) c.add(new THREE.Vector3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2)); c.divideScalar(boxes.length); }
    const at = plane.projectPoint(c, new THREE.Vector3());
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal.clone().negate());
    for (const p of this.parts) {
      p.cap.position.copy(at); p.cap.quaternion.copy(q);
      ((p.back.material as THREE.Material).clippingPlanes as THREE.Plane[] | null) = [plane];
      ((p.front.material as THREE.Material).clippingPlanes as THREE.Plane[] | null) = [plane];
    }
  }
}

export const sectionOf = (studio: PartStudio): SectionView => perStudio(studio, "section-view", (s) => new SectionView(s));
