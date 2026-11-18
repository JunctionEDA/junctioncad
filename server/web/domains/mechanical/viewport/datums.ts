// datums.ts — reference planes, axes, points and curves in the viewport: drawn, picked and highlighted.
// ModelView (modelview.ts) owns one DatumLayer and asks it about the pointer; this file holds no document state.
import * as THREE from "three";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { Vec3 } from "../core/geometry";
import type { DatumView } from "../kernel/protocol";

export interface DatumHit { featureId: string; datum: DatumView["kind"]; point: Vec3; d: number }
type Fat = (color: THREE.Color, width: number, o?: Partial<{ dashed: boolean; depthTest: boolean }>) => LineMaterial;

interface Drawn { view: DatumView; group: THREE.Group; quad?: THREE.Mesh; segments?: number[]; at?: THREE.Vector3 }

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

/** The four corners of a reference plane's square. */
function corners(d: DatumView): THREE.Vector3[] {
  const f = d.frame!, c = v3(d.centre || f.origin), s = (d.size || 50) / 2;
  const x = v3(f.x), y = v3(f.y);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => c.clone().addScaledVector(x, u * s).addScaledVector(y, v * s));
}

/** Line segments (point pairs) that draw a datum: a plane's outline, an axis, a curve. */
function segmentsOf(d: DatumView): number[] {
  const out: number[] = [];
  const push = (a: THREE.Vector3, b: THREE.Vector3) => out.push(a.x, a.y, a.z, b.x, b.y, b.z);
  if (d.kind === "plane" && d.frame) { const c = corners(d); for (let i = 0; i < 4; i++) push(c[i], c[(i + 1) % 4]); }
  else if (d.kind === "axis" && d.origin && d.dir) { const o = v3(d.origin), dir = v3(d.dir), h = (d.length || 50) / 2; push(o.clone().addScaledVector(dir, -h), o.clone().addScaledVector(dir, h)); }
  else if (d.kind === "curve" && d.points) for (let i = 0; i + 5 < d.points.length; i += 3) out.push(...d.points.slice(i, i + 6));
  return out;
}

export class DatumLayer {
  readonly group = new THREE.Group();
  private drawn = new Map<string, Drawn>();
  private color = new THREE.Color();
  private hidden = new Set<string>();

  /** Which datums (by feature id) are not drawn and not picked: a person hid them in the feature list. */
  setHidden(ids: ReadonlySet<string>): void {
    this.hidden = new Set(ids);
    for (const [id, d] of this.drawn) d.group.visible = !this.hidden.has(id);
  }
  /** The reference planes on screen, with the corners of their rectangles (for their name labels). */
  planes(): { featureId: string; corners: THREE.Vector3[]; normal: THREE.Vector3; shown: boolean }[] {
    const out: { featureId: string; corners: THREE.Vector3[]; normal: THREE.Vector3; shown: boolean }[] = [];
    for (const [id, d] of this.drawn) if (d.view.kind === "plane" && d.view.frame) out.push({ featureId: id, corners: corners(d.view), normal: v3(d.view.frame.normal), shown: !this.hidden.has(id) });
    return out;
  }
  /** The box of a datum, for zooming to it. */
  boxOf(featureId: string): THREE.Box3 | null {
    const d = this.drawn.get(featureId); if (!d) return null;
    const b = new THREE.Box3();
    if (d.segments) for (let i = 0; i + 2 < d.segments.length; i += 3) b.expandByPoint(new THREE.Vector3(d.segments[i], d.segments[i + 1], d.segments[i + 2]));
    if (d.at) b.expandByPoint(d.at);
    return b.isEmpty() ? null : b;
  }

  constructor(private readonly fat: Fat) {}

  /** Show these datums (the result of a regeneration). */
  set(views: readonly DatumView[], color: THREE.Color): void {
    this.clear();
    this.color.copy(color);
    for (const d of views) {
      const sub = new THREE.Group();
      sub.visible = !this.hidden.has(d.featureId);
      this.group.add(sub);
      const drawn: Drawn = { view: d, group: sub };
      if (d.kind === "plane" && d.frame) {
        const g = new THREE.BufferGeometry().setFromPoints(corners(d)); g.setIndex([0, 1, 2, 0, 2, 3]);
        const quad = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
        quad.userData.datum = d.featureId;
        sub.add(quad);
        drawn.quad = quad;
      }
      if (d.kind === "point" && d.at) {
        drawn.at = v3(d.at);
        const p = new THREE.Points(new THREE.BufferGeometry().setFromPoints([drawn.at]), new THREE.PointsMaterial({ color, size: 7, sizeAttenuation: false, depthTest: false }));
        p.renderOrder = 6; sub.add(p);
      }
      const seg = segmentsOf(d);
      if (seg.length >= 6) {
        drawn.segments = seg;
        const g = new LineSegmentsGeometry(); g.setPositions(seg);
        const line = new LineSegments2(g, this.fat(color, d.kind === "plane" ? 1 : 1.5, { dashed: d.kind === "axis", depthTest: d.kind === "plane" }));
        line.computeLineDistances();
        line.renderOrder = 4;
        sub.add(line);
      }
      this.drawn.set(d.featureId, drawn);
    }
  }

  private clear(): void {
    for (const o of this.group.children.slice()) { this.group.remove(o); o.traverse((x) => { (x as THREE.Mesh).geometry?.dispose(); }); }
    this.drawn.clear();
  }

  /** The frame of a reference plane, for a sketch on it before the worker has said. */
  view(featureId: string): DatumView | undefined { return this.drawn.get(featureId)?.view; }

  /**
   * The datum under the pointer.  Points, axes and curves are found within a few pixels of the ray (`px` is the
   * size of a pixel at the target); planes by the ray crossing their square.  `planes` asks for planes too.
   */
  pick(ray: THREE.Ray, px: number, rc: THREE.Raycaster, want: (kind: DatumView["kind"]) => boolean, planes: boolean): DatumHit | null {
    let best: DatumHit | null = null;
    const offer = (h: DatumHit) => { if (!best || h.d < best.d) best = h; };
    const closest = new THREE.Vector3(), onSeg = new THREE.Vector3();
    for (const [id, dr] of this.drawn) {
      const k = dr.view.kind;
      if (!want(k) || this.hidden.has(id)) continue;
      if (k === "point" && dr.at) {
        if (ray.distanceSqToPoint(dr.at) < (7 * px) ** 2) offer({ featureId: id, datum: k, point: [dr.at.x, dr.at.y, dr.at.z], d: ray.origin.distanceTo(dr.at) - 1e9 });
      } else if ((k === "axis" || k === "curve") && dr.segments) {
        const s = dr.segments;
        for (let i = 0; i + 5 < s.length; i += 6) {
          const a = new THREE.Vector3(s[i], s[i + 1], s[i + 2]), b = new THREE.Vector3(s[i + 3], s[i + 4], s[i + 5]);
          const d2 = ray.distanceSqToSegment(a, b, closest, onSeg);
          if (d2 < (6 * px) ** 2) offer({ featureId: id, datum: k, point: [onSeg.x, onSeg.y, onSeg.z], d: ray.origin.distanceTo(onSeg) - 1e8 });
        }
      } else if (k === "plane" && planes && dr.quad) {
        const hit = rc.intersectObject(dr.quad, false)[0];
        if (hit) offer({ featureId: id, datum: k, point: [hit.point.x, hit.point.y, hit.point.z], d: hit.distance });
      }
    }
    return best;
  }

  /** Objects that draw a datum highlighted, for ModelView's highlight group. */
  highlight(featureId: string, color: THREE.Color, strong: boolean): THREE.Object3D[] {
    const dr = this.drawn.get(featureId);
    if (!dr || this.hidden.has(featureId)) return [];
    const out: THREE.Object3D[] = [];
    if (dr.quad) {
      const m = new THREE.Mesh(dr.quad.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: strong ? 0.3 : 0.18, side: THREE.DoubleSide, depthWrite: false }));
      out.push(m);
    }
    if (dr.segments) {
      const g = new LineSegmentsGeometry(); g.setPositions(dr.segments);
      const l = new LineSegments2(g, this.fat(color, strong ? 3 : 2.5, { depthTest: false }));
      l.renderOrder = 10; l.userData.own = true;
      out.push(l);
    }
    if (dr.at) {
      const p = new THREE.Points(new THREE.BufferGeometry().setFromPoints([dr.at]), new THREE.PointsMaterial({ color, size: 10, sizeAttenuation: false, depthTest: false }));
      p.renderOrder = 11; p.userData.own = true;
      out.push(p);
    }
    return out;
  }

  get colorNow(): THREE.Color { return this.color; }
}
