// triad.ts — the move manipulator: three arrows to slide an instance along its axes and three arcs to turn it
// about them.  It keeps its size on screen, is hit-tested in screen space, and turns pointer motion into a
// distance along an axis or an angle about one, snapped to round steps.  It moves nothing itself: the editor
// feeds what it reports to the solver, so a manipulated part still obeys its mates.
import * as THREE from "three";
import { tokenColor, type Viewport3D } from "../../../shared/viewport3d/viewport3d";
import type { Vec3 } from "../../mechanical/api";
import type { Pose } from "../solver/math";

export interface TriadHandle { kind: "move" | "turn"; axis: 0 | 1 | 2 }

const ARROW = 86, ARC = 58;   // CSS pixels
const TOKENS = ["--err", "--wire", "--blue"];

/** A round step no smaller than `min`: 1, 2 or 5 times a power of ten. */
export function niceStep(min: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(min, 1e-9))));
  for (const k of [1, 2, 5, 10]) if (k * p >= min) return k * p;
  return 10 * p;
}

export class Triad {
  private readonly group = new THREE.Group();
  private readonly lines: THREE.LineSegments[] = [];
  private pose: Pose | null = null;
  private active: TriadHandle | null = null;

  constructor(private readonly viewport: Viewport3D) {
    for (let a = 0; a < 3; a++) {
      const u = [0, 0, 0], v = [0, 0, 0], w = [0, 0, 0];
      u[a] = 1; v[(a + 1) % 3] = 1; w[(a + 2) % 3] = 1;
      const pts: number[] = [];
      const p = (s: number, t: number, r: number) => pts.push(u[0] * s + v[0] * t + w[0] * r, u[1] * s + v[1] * t + w[1] * r, u[2] * s + v[2] * t + w[2] * r);
      // the arrow along this axis
      p(14, 0, 0); p(ARROW, 0, 0);
      p(ARROW, 0, 0); p(ARROW - 11, 4, 0); p(ARROW, 0, 0); p(ARROW - 11, -4, 0); p(ARROW, 0, 0); p(ARROW - 11, 0, 4); p(ARROW, 0, 0); p(ARROW - 11, 0, -4);
      // the arc that turns about this axis: a quarter circle between the other two
      const N = 16;
      for (let i = 0; i < N; i++) { const t0 = (i / N) * (Math.PI / 2), t1 = ((i + 1) / N) * (Math.PI / 2); p(0, Math.cos(t0) * ARC, Math.sin(t0) * ARC); p(0, Math.cos(t1) * ARC, Math.sin(t1) * ARC); }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ depthTest: false, transparent: true }));
      l.renderOrder = 20;
      this.lines.push(l); this.group.add(l);
    }
    this.group.visible = false;
    viewport.scene.add(this.group);
    viewport.onFrame.push(this.onFrame);
    this.readColors();
  }

  private onFrame = (): void => { if (this.group.visible) this.group.scale.setScalar(this.viewport.pixelSize()); };
  readColors(): void { this.lines.forEach((l, a) => { const m = l.material as THREE.LineBasicMaterial; m.color.copy(tokenColor(TOKENS[a])); m.opacity = !this.active || this.active.axis === a ? 1 : 0.35; }); }

  /** Show the manipulator at a pose (its axes are the pose's), or hide it. */
  setPose(pose: Pose | null): void {
    this.pose = pose;
    this.group.visible = !!pose;
    if (pose) { this.group.position.set(pose.p[0], pose.p[1], pose.p[2]); this.group.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]); this.group.scale.setScalar(this.viewport.pixelSize()); }
    this.viewport.invalidate();
  }
  get shown(): Pose | null { return this.pose; }
  setActive(h: TriadHandle | null): void { this.active = h; this.readColors(); this.viewport.invalidate(); }

  private axis(a: number): THREE.Vector3 { const v = new THREE.Vector3(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0); return v.applyQuaternion(this.group.quaternion); }
  private origin(): THREE.Vector3 { return this.group.position.clone(); }

  /** The handle under the pointer, or null. */
  hit(ev: { clientX: number; clientY: number }): TriadHandle | null {
    if (!this.pose) return null;
    const r = this.viewport.canvas.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top, px = this.viewport.pixelSize();
    const o = this.origin();
    let best: { h: TriadHandle; d: number } | null = null;
    const offer = (h: TriadHandle, world: THREE.Vector3) => { const s = this.viewport.project(world); const d = Math.hypot(s.x - mx, s.y - my); if (d < 8 && (!best || d < best.d)) best = { h, d }; };
    for (let a = 0 as 0 | 1 | 2; a < 3; a = (a + 1) as 0 | 1 | 2) {
      const u = this.axis(a), v = this.axis((a + 1) % 3), w = this.axis((a + 2) % 3);
      for (let i = 0; i <= 12; i++) offer({ kind: "move", axis: a }, o.clone().addScaledVector(u, (20 + (i / 12) * (ARROW - 20)) * px));
      for (let i = 0; i <= 12; i++) { const t = (i / 12) * (Math.PI / 2); offer({ kind: "turn", axis: a }, o.clone().addScaledVector(v, Math.cos(t) * ARC * px).addScaledVector(w, Math.sin(t) * ARC * px)); }
      if (a === 2) break;
    }
    return best ? (best as { h: TriadHandle }).h : null;
  }

  /**
   * Start dragging a handle.  The returned function turns a pointer event into how far the handle has gone
   * since the start: millimetres along the axis, or radians about it; snapped unless `free`.
   */
  begin(h: TriadHandle, ev: { clientX: number; clientY: number }): { axis: Vec3; origin: Vec3; measure(ev: { clientX: number; clientY: number }, free: boolean): number } {
    const o = this.origin(), a = this.axis(h.axis);
    const along = (e: { clientX: number; clientY: number }): number | null => {
      // the point of the axis nearest the pointer's ray
      const ray = this.viewport.ray(e), w = ray.origin.clone().sub(o), ad = a.dot(ray.direction), den = 1 - ad * ad;
      if (den < 1e-6) return null;
      return (w.dot(a) - w.dot(ray.direction) * ad) / den;
    };
    const u = this.axis((h.axis + 1) % 3), v = this.axis((h.axis + 2) % 3);
    const angle = (e: { clientX: number; clientY: number }): number | null => {
      const ray = this.viewport.ray(e), den = ray.direction.dot(a);
      if (Math.abs(den) > 0.12) {
        const t = o.clone().sub(ray.origin).dot(a) / den, p = ray.origin.clone().addScaledVector(ray.direction, t).sub(o);
        return Math.atan2(p.dot(v), p.dot(u));
      }
      // seen edge-on, the arc's plane cannot be hit: use the pointer's place across the screen instead
      const s0 = this.viewport.project(o), r = this.viewport.canvas.getBoundingClientRect();
      const side = new THREE.Vector3().crossVectors(a, ray.direction).normalize();
      const s1 = this.viewport.project(o.clone().add(side));
      const dir = new THREE.Vector2(s1.x - s0.x, s1.y - s0.y).normalize();
      return ((e.clientX - r.left - s0.x) * dir.x + (e.clientY - r.top - s0.y) * dir.y) / 80;
    };
    const start = h.kind === "move" ? along(ev) : angle(ev);
    const px = this.viewport.pixelSize();
    const step = h.kind === "move" ? niceStep(8 * px) : (5 * Math.PI) / 180;
    return {
      axis: [a.x, a.y, a.z], origin: [o.x, o.y, o.z],
      measure: (e, free) => {
        const now = h.kind === "move" ? along(e) : angle(e);
        if (now === null || start === null) return 0;
        let d = now - start;
        if (h.kind === "turn") { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; }
        return free ? d : Math.round(d / step) * step;
      },
    };
  }

  dispose(): void { this.viewport.scene.remove(this.group); for (const l of this.lines) { l.geometry.dispose(); (l.material as THREE.Material).dispose(); } }
}
