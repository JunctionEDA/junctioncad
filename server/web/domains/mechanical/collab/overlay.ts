// overlay.ts — the other people, drawn in a 3D viewport: each person's pointer, what they are looking at, and
// what they have selected, all in their colour.
//
//   pointer     an arrow with a name tag where their pointer is on the model (the tag is the electronics
//               editor's: the person's colour, their name, a note when they are editing something), and a short
//               stalk from that point towards their eye, so one sees from which side they look at it
//   view        the corners of the rectangle of model space their window shows, at the point their camera turns
//               about, with a stalk towards their eye: an orthographic camera's "frustum".  Not drawn while
//               their view is one's own, near enough (following them, or both looking at the fitted model)
//   selection   their faces filled, their edges and sketch curves thick, their vertices dotted
//
// The pointer is moved every display frame towards where it was last said to be, so it glides; everything
// else is rebuilt only when it changes.  It reads body meshes and sketches through `OverlaySources` and holds
// no document state.
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { Viewport3D } from "../../../shared/viewport3d/viewport3d";
import { DEFAULT_PLANES, toWorld, type DefaultPlaneId } from "../core/geometry";
import type { BodyMesh, SketchView } from "../kernel/protocol";
import { brightness, type CamState, type Collaborator, type SelRef, type V3 } from "./presence";

export interface OverlaySources {
  mesh(bodyId: string): BodyMesh | null;
  sketch(featureId: string): SketchView | null;
  /** the name of what a person is editing, for their tag */
  editLabel?(person: Collaborator): string;
}

interface PersonObjects {
  group: THREE.Group;
  view: THREE.LineSegments;
  stalk: THREE.LineSegments;
  sel: THREE.Group;
  selKey: string;
  el: HTMLDivElement;
  tagKey: string;
  viewTag: HTMLDivElement;
  /** where the pointer is drawn, and where it is going (model space); null while it is off their canvas */
  shown: THREE.Vector3 | null;
  goal: THREE.Vector3 | null;
  hit: boolean;
  cam: CamState | null;
  /** the view rectangle is wanted (it is still hidden while their view is one's own) */
  viewOn: boolean;
  color: THREE.Color;
}

const PLANE_HALF = 30;

export class PeerOverlay {
  private readonly root = new THREE.Group();
  private readonly layer: HTMLDivElement;
  private readonly people = new Map<string, PersonObjects>();
  private readonly fat: LineMaterial[] = [];
  private raf = 0;
  private disposed = false;
  private hidden: string | null = null;
  private showViews = true;
  private sourcesRev = 0;
  private readonly frame = () => { for (const m of this.fat) m.resolution.set(this.viewport.width, this.viewport.height); this.place(); };

  constructor(private readonly viewport: Viewport3D, private readonly sources: OverlaySources) {
    this.root.renderOrder = 20;
    viewport.scene.add(this.root);
    this.layer = document.createElement("div");
    this.layer.className = "cad-peers";
    this.layer.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:3";
    viewport.host.appendChild(this.layer);
    viewport.onFrame.push(this.frame);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const cid of Array.from(this.people.keys())) this.remove(cid);
    this.viewport.scene.remove(this.root);
    this.layer.remove();
    const i = this.viewport.onFrame.indexOf(this.frame); if (i >= 0) this.viewport.onFrame.splice(i, 1);
    this.viewport.invalidate();
  }

  /** The meshes or sketches changed: selections are drawn again from the new ones. */
  sourcesChanged(): void { this.sourcesRev++; }

  /** Show these people.  `hideViewOf` is the key of the person being followed; `showViews` the view rectangles. */
  update(people: readonly Collaborator[], o: { hideViewOf: string | null; showViews: boolean }): void {
    if (this.disposed) return;
    this.hidden = o.hideViewOf; this.showViews = o.showViews;
    const keep = new Set<string>();
    for (const p of people) {
      keep.add(p.cid);
      let obj = this.people.get(p.cid);
      if (!obj) { obj = this.make(p); this.people.set(p.cid, obj); }
      if (p.color && obj.color.getStyle() !== new THREE.Color(p.color).getStyle()) this.recolor(obj, p.color);
      // the pointer
      const cur = p.state.cur;
      if (cur) {
        obj.goal = new THREE.Vector3(...cur.p); obj.hit = cur.hit;
        // a first sight, or a jump across the model, is shown at once
        if (!obj.shown || obj.shown.distanceTo(obj.goal) > 400 * this.viewport.pixelSize()) obj.shown = obj.goal.clone();
      } else { obj.goal = null; obj.shown = null; }
      const note = p.state.edit ? (this.sources.editLabel ? this.sources.editLabel(p) : "editing") : "";
      const tagKey = `${p.name}\u0000${p.color}\u0000${note}`;
      if (tagKey !== obj.tagKey) { obj.tagKey = tagKey; this.buildTag(obj, p, note); }
      // the view
      obj.cam = p.state.cam || null;
      this.buildView(obj, p);
      // the selection
      const selKey = JSON.stringify(p.state.sel || []) + "\u0000" + this.sourcesRev + "\u0000" + p.color;
      if (selKey !== obj.selKey) { obj.selKey = selKey; this.buildSelection(obj, p.state.sel || []); }
    }
    for (const cid of Array.from(this.people.keys())) if (!keep.has(cid)) this.remove(cid);
    this.place();
    this.wake();
    this.viewport.invalidate();
  }

  // ---------------------------------------------------------------- objects
  private fatMaterial(color: THREE.Color, width: number): LineMaterial {
    const m = new LineMaterial({ color: color.getHex(), linewidth: width, depthTest: false, transparent: true, opacity: 0.95 });
    m.resolution.set(this.viewport.width, this.viewport.height);
    this.fat.push(m);
    return m;
  }
  private dropFat(o: THREE.Object3D): void {
    o.traverse((x) => {
      const m = (x as LineSegments2).material as unknown;
      const i = this.fat.indexOf(m as LineMaterial); if (i >= 0) this.fat.splice(i, 1);
    });
  }

  private make(p: Collaborator): PersonObjects {
    const color = new THREE.Color(p.color || "#888");
    const group = new THREE.Group();
    const line = () => {
      const l = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6, depthTest: false }));
      l.renderOrder = 20; l.frustumCulled = false;
      return l;
    };
    const view = line(), stalk = line();
    (stalk.material as THREE.LineBasicMaterial).opacity = 0.9;
    const sel = new THREE.Group();
    group.add(sel, view, stalk);
    this.root.add(group);
    const el = document.createElement("div");
    el.className = "peer-cursor";
    el.dataset.peer = p.login;
    el.style.cssText = "position:absolute;left:0;top:0;will-change:transform;display:none";
    const viewTag = document.createElement("div");
    viewTag.className = "peer-view";
    viewTag.dataset.peerView = p.login;
    viewTag.style.cssText = "position:absolute;left:0;top:0;will-change:transform;display:none;font:var(--fs-2xs) var(--font-mono, monospace);text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;opacity:.8";
    this.layer.append(viewTag, el);
    return { group, view, stalk, sel, selKey: "", el, tagKey: "", viewTag, shown: null, goal: null, hit: false, cam: null, viewOn: false, color };
  }

  private recolor(obj: PersonObjects, css: string): void {
    obj.color.set(css);
    (obj.view.material as THREE.LineBasicMaterial).color.copy(obj.color);
    (obj.stalk.material as THREE.LineBasicMaterial).color.copy(obj.color);
    obj.selKey = ""; obj.tagKey = "";
  }

  private remove(cid: string): void {
    const obj = this.people.get(cid); if (!obj) return;
    this.people.delete(cid);
    this.clearSelection(obj);
    this.root.remove(obj.group);
    obj.view.geometry.dispose(); obj.stalk.geometry.dispose();
    (obj.view.material as THREE.Material).dispose(); (obj.stalk.material as THREE.Material).dispose();
    obj.el.remove(); obj.viewTag.remove();
  }

  /** The pointer's arrow and name tag: the person's colour, with text that reads on it. */
  private buildTag(obj: PersonObjects, p: Collaborator, note: string): void {
    const color = p.color || "var(--mark)";
    // the text is the theme's dark or light canvas colour (the same in both themes), whichever reads on theirs
    const text = brightness(p.color || "#888") > 0.6 ? "var(--canvas)" : "var(--silk)";
    obj.el.replaceChildren();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "18"); svg.setAttribute("height", "18"); svg.setAttribute("viewBox", "0 0 18 18");
    svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M1 1l5.2 14 2.3-5.5L14 7.2z");
    path.setAttribute("fill", color); path.setAttribute("stroke", "var(--paper)"); path.setAttribute("stroke-width", "1.2"); path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    const tag = document.createElement("div");
    tag.style.cssText = `position:absolute;left:14px;top:14px;padding:1px 5px;border-radius:var(--r-2);background:${color};color:${text};font:500 var(--fs-xs)/1.45 var(--font-sans, sans-serif);white-space:nowrap;box-shadow:0 0 0 1px var(--paper)`;
    tag.textContent = note ? `${p.name} · ${note}` : p.name;
    obj.el.append(svg, tag);
    obj.viewTag.textContent = `${p.name}'s view`;
    obj.viewTag.style.color = color;
  }

  /** The rectangle of model space a camera shows, and a stalk from its centre towards the eye. */
  private buildView(obj: PersonObjects, p: Collaborator): void {
    const cam = obj.cam;
    const on = !!cam && this.showViews && p.key !== this.hidden;
    obj.viewOn = on;
    obj.view.visible = on;
    if (!on || !cam) return;
    const q = new THREE.Quaternion(cam.q[0], cam.q[1], cam.q[2], cam.q[3]);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q), up = new THREE.Vector3(0, 1, 0).applyQuaternion(q), back = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const hh = 100 / cam.z, hw = hh * cam.a, c = new THREE.Vector3(...cam.t);
    const corner = (sx: number, sy: number) => c.clone().addScaledVector(right, sx * hw).addScaledVector(up, sy * hh);
    const a = corner(-1, -1), b = corner(1, -1), d = corner(1, 1), e = corner(-1, 1), eye = c.clone().addScaledVector(back, hh * 0.6);
    // corner ticks rather than a full frame: the rectangle is often larger than one's own window
    const pts: THREE.Vector3[] = [];
    const tick = (from: THREE.Vector3, to: THREE.Vector3) => { pts.push(from, from.clone().lerp(to, 0.18)); };
    tick(a, b); tick(b, a); tick(b, d); tick(d, b); tick(d, e); tick(e, d); tick(e, a); tick(a, e);
    pts.push(c, eye);
    const m = hh * 0.04;
    pts.push(c.clone().addScaledVector(right, -m), c.clone().addScaledVector(right, m), c.clone().addScaledVector(up, -m), c.clone().addScaledVector(up, m));
    obj.view.geometry.dispose();
    obj.view.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    obj.view.userData.corner = e;
  }

  private clearSelection(obj: PersonObjects): void {
    this.dropFat(obj.sel);
    for (const o of obj.sel.children.slice()) {
      obj.sel.remove(o);
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) x.dispose();
    }
  }

  private buildSelection(obj: PersonObjects, sel: readonly SelRef[]): void {
    this.clearSelection(obj);
    const segs: number[] = [], dots: number[] = [];
    const faces = new Map<string, number[]>();   // body → indices of face ranges
    const seg = (pts: ArrayLike<number>) => { for (let i = 0; i < pts.length; i++) segs.push(pts[i]); };
    const polyline = (pts: ArrayLike<number>) => { for (let i = 0; i + 5 < pts.length; i += 3) seg([pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5]]); };
    for (const s of sel) {
      if (s[0] === "p") {
        const plane = DEFAULT_PLANES[s[1] as DefaultPlaneId]; if (!plane) continue;
        const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => toWorld(plane.frame, [u * PLANE_HALF, v * PLANE_HALF]));
        for (let i = 0; i < 4; i++) seg([...c[i], ...c[(i + 1) % 4]]);
        continue;
      }
      if (s[0] === "s") {
        const view = this.sources.sketch(s[1]); if (!view) continue;
        const curve = s[2] ? view.curves.find((x) => x.entity === s[2]) : null;
        if (curve) polyline(curve.points);
        const pt = s[2] ? view.points.find((x) => x.entity === s[2]) : null;
        if (pt) dots.push(...pt.position);
        const region = s[3] ? view.regions.find((x) => x.id === s[3]) : null;
        if (region) for (const loop of [region.outer, ...region.holes]) {
          const n = loop.length / 2;
          for (let i = 0; i < n; i++) { const j = (i + 1) % n; seg([...toWorld(view.frame, [loop[i * 2], loop[i * 2 + 1]]), ...toWorld(view.frame, [loop[j * 2], loop[j * 2 + 1]])]); }
        }
        continue;
      }
      const mesh = this.sources.mesh(s[1]); if (!mesh) continue;
      if (s[0] === "f") { const i = mesh.faces.names.indexOf(s[2]); if (i >= 0) faces.set(s[1], [...(faces.get(s[1]) || []), i]); }
      else if (s[0] === "e") { const i = mesh.edges.names.indexOf(s[2]); if (i >= 0) seg(mesh.edges.positions.subarray(mesh.edges.start[i] * 3, (mesh.edges.start[i] + mesh.edges.count[i]) * 3)); }
      else { const i = mesh.vertices.names.indexOf(s[2]); if (i >= 0) dots.push(mesh.vertices.positions[i * 3], mesh.vertices.positions[i * 3 + 1], mesh.vertices.positions[i * 3 + 2]); }
    }
    for (const [body, list] of faces) {
      const mesh = this.sources.mesh(body)!;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
      g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      for (const i of list) g.addGroup(mesh.faces.start[i], mesh.faces.count[i], 0);
      const m = new THREE.Mesh(g, [new THREE.MeshBasicMaterial({ color: obj.color, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })]);
      m.renderOrder = 8;
      obj.sel.add(m);
    }
    if (segs.length >= 6) {
      const g = new LineSegmentsGeometry(); g.setPositions(segs);
      const l = new LineSegments2(g, this.fatMaterial(obj.color, 3.5));
      l.renderOrder = 9;
      obj.sel.add(l);
    }
    if (dots.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(dots, 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: obj.color, size: 9, sizeAttenuation: false, depthTest: false }));
      pts.renderOrder = 10;
      obj.sel.add(pts);
    }
  }

  // ---------------------------------------------------------------- every frame
  /** Put the tags where their points are on screen now, and stretch each pointer's stalk for the zoom. */
  private place(): void {
    const w = this.viewport.width, h = this.viewport.height, px = this.viewport.pixelSize();
    const tags: [number, number][] = [];
    for (const obj of this.people.values()) {
      const at = obj.shown;
      if (at) {
        const s = this.viewport.project(at);
        const inside = s.x > -40 && s.y > -40 && s.x < w + 40 && s.y < h + 40;
        obj.el.style.display = inside ? "" : "none";
        if (inside) obj.el.style.transform = `translate(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px)`;
      } else obj.el.style.display = "none";
      // the stalk: from the point towards their eye, a fixed length on screen
      const cam = obj.cam;
      obj.stalk.visible = !!at && !!cam;
      if (at && cam) {
        const back = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(cam.q[0], cam.q[1], cam.q[2], cam.q[3]));
        const end = at.clone().addScaledVector(back, 34 * px);
        let pos = obj.stalk.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
        if (!pos) { pos = new THREE.BufferAttribute(new Float32Array(6), 3); obj.stalk.geometry.setAttribute("position", pos); }
        pos.setXYZ(0, at.x, at.y, at.z); pos.setXYZ(1, end.x, end.y, end.z);
        pos.needsUpdate = true;
      }
      // a view that is one's own, near enough, would only draw one's own window's edge
      obj.view.visible = obj.viewOn && !!cam && !this.sameView(cam);
      const corner = obj.view.visible ? (obj.view.userData.corner as THREE.Vector3 | undefined) : undefined;
      if (corner) {
        const s = this.viewport.project(corner);
        const inside = s.x > 0 && s.y > 0 && s.x < w - 60 && s.y < h - 14;
        obj.viewTag.style.display = inside ? "" : "none";
        if (inside) {
          // tags that would lie on each other are stacked
          let x = s.x + 4, y = s.y + 3;
          while (tags.some((t) => Math.abs(t[0] - x) < 160 && Math.abs(t[1] - y) < 11)) y += 12;
          tags.push([x, y]);
          obj.viewTag.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
        }
      } else obj.viewTag.style.display = "none";
    }
  }

  /** Does a camera show about what this viewport shows: the same way round, the same place, about the same size? */
  private sameView(cam: CamState): boolean {
    const v = this.viewport, mine = v.camera;
    const q = new THREE.Quaternion(cam.q[0], cam.q[1], cam.q[2], cam.q[3]);
    if (mine.quaternion.angleTo(q) > 0.03) return false;
    const hh = 100 / mine.zoom, hw = (hh * v.width) / v.height, theirs = 100 / cam.z;
    if (theirs / hh < 0.75 || theirs / hh > 1.33 || (theirs * cam.a) / hw < 0.75 || (theirs * cam.a) / hw > 1.33) return false;
    const d = new THREE.Vector3(...cam.t).sub(v.target);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(mine.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(mine.quaternion);
    return Math.abs(d.dot(right)) < hw * 0.15 && Math.abs(d.dot(up)) < hh * 0.15;
  }

  /** Glide the pointers towards where they were last said to be. */
  private wake(): void {
    if (this.raf || this.disposed) return;
    const step = () => {
      this.raf = 0;
      if (this.disposed) return;
      let moving = false;
      const eps = this.viewport.pixelSize() * 0.3;
      for (const obj of this.people.values()) {
        if (!obj.shown || !obj.goal) continue;
        if (obj.shown.distanceTo(obj.goal) <= eps) { if (!obj.shown.equals(obj.goal)) { obj.shown.copy(obj.goal); moving = true; } continue; }
        obj.shown.lerp(obj.goal, 0.4); moving = true;
      }
      if (moving) { this.viewport.invalidate(); this.raf = requestAnimationFrame(step); }
    };
    this.raf = requestAnimationFrame(step);
  }
}
