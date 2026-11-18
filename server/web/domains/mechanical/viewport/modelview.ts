// modelview.ts — a part studio in the 3D viewport: bodies with their edges, the default planes and origin,
// sketches, hover and selection highlighting, and picking of faces, edges and vertices by their stable names.
//
// It draws what it is given and reports what the pointer is over; it holds no document state.  The part studio
// controller (ui/studio.ts) feeds it regeneration results and listens to `onPick` / `onHover`.
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { tokenColor, type Viewport3D } from "../../../shared/viewport3d/viewport3d";
import { DEFAULT_PLANES, toPlane, type DefaultPlaneId, type Frame, type Vec2, type Vec3 } from "../core/geometry";
import type { BodyResult, DatumView, SketchView } from "../kernel/protocol";
import { DatumLayer } from "./datums";
import { PlaneLayer } from "./planes";

/** Something in the viewport that can be hovered or selected. */
export type Pick =
  | { kind: "face" | "edge" | "vertex"; body: string; name: string; point: Vec3 }
  | { kind: "plane"; plane: DefaultPlaneId; point: Vec3 }
  | { kind: "sketch"; featureId: string; entity: string | null; region: string | null; point: Vec3 }
  /** reference geometry: the plane, axis, point or curve a feature made (viewport/datums.ts) */
  | { kind: "datum"; featureId: string; datum: DatumView["kind"]; point: Vec3 };

export const pickKey = (p: Pick): string => (p.kind === "plane" ? `plane:${p.plane}` : p.kind === "datum" ? `datum:${p.featureId}` : p.kind === "sketch" ? `sketch:${p.featureId}:${p.entity || ""}:${p.region || ""}` : `${p.kind}:${p.body}:${p.name}`);

export type PickKind = Pick["kind"];

interface BodyObjects { rev: number; group: THREE.Group; mesh: THREE.Mesh; edges: THREE.LineSegments; points: THREE.Points; result: BodyResult }
interface SketchObjects { group: THREE.Group; view: SketchView; lines: LineSegments2; fills: THREE.Mesh[] }

export class ModelView {
  private readonly root = new THREE.Group();
  /** the origin and the default planes, with their name labels (viewport/planes.ts) */
  readonly planeLayer: PlaneLayer;
  private readonly highlight = new THREE.Group();
  private readonly overlay = new THREE.Group();
  private readonly bodies = new Map<string, BodyObjects>();
  private readonly sketches = new Map<string, SketchObjects>();
  private readonly raycaster = new THREE.Raycaster();
  private colors = { body: new THREE.Color(), edge: new THREE.Color(), hover: new THREE.Color(), select: new THREE.Color(), held: new THREE.Color(), sketch: new THREE.Color(), plane: new THREE.Color(), dim: new THREE.Color() };
  private bodyMaterial = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  private edgeMaterial = new THREE.LineBasicMaterial();
  private pointMaterial = new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, transparent: true, opacity: 0 });
  private fat: LineMaterial[] = [];
  private hover: Pick | null = null;
  private selection: Pick[] = [];
  /** what the open dialog holds: the active field's picks, and the other fields' */
  private marks: { active: Pick[]; other: Pick[] } = { active: [], other: [] };
  /** drawn as hovered besides what the pointer is over (the geometry of the feature row under the pointer) */
  private featureHover: Pick[] = [];
  private hiddenItems = new Set<string>();
  private datumNames = new Map<string, string>();
  private band: HTMLDivElement | null = null;
  /**
   * What the dialog's picks looked like when they were last on screen.  A feature consumes what it is given (a
   * filleted edge is gone from the preview), and the pick must stay drawn all the same.
   */
  private held = new Map<string, { segments?: number[]; triangles?: Float32Array; at?: Vec3 }>();
  private filter: Set<PickKind> | null = null;
  private activeSketch: string | null = null;
  private hiddenSketch: string | null = null;
  /**
   * How a body is drawn, asked when its meshes are made: `faces: false` / `edges: false` leave them undrawn (the
   * body is still picked and highlighted).  For reference bodies something else draws (a board's display model).
   */
  bodyStyle: ((body: BodyResult) => { faces?: boolean; edges?: boolean } | null) | null = null;
  /** The pointer moved onto something else (or nothing). */
  onHover: (pick: Pick | null) => void = () => {};
  /** A left click, with what was under it. */
  onPick: (pick: Pick | null, ev: PointerEvent) => void = () => {};
  /** A left drag on nothing drew a box: what it took (left to right: wholly inside; right to left: touched). */
  onBox: (picks: Pick[], ev: PointerEvent) => void = () => {};
  /** A right click that was not a drag, with what was under it. */
  onContext: (pick: Pick | null, ev: PointerEvent) => void = () => {};
  /** While set, left-button pointer events go here instead of picking (a sketch tool is drawing). */
  pointerTool: { down?(ev: PointerEvent): void; move?(ev: PointerEvent): void; up?(ev: PointerEvent): void } | null = null;
  /** Called after `setBodies` changed what is drawn (appearance and section views re-dress the new meshes). */
  onBodies: (() => void)[] = [];
  /** While set, a face, edge or vertex hit at a point it rejects is not picked (the part a section view cuts away). */
  pickClip: ((point: Vec3) => boolean) | null = null;
  private downAt: { x: number; y: number; boxing: boolean } | null = null;
  private rightAt: { x: number; y: number } | null = null;
  private readonly datums = new DatumLayer((c, w, o) => this.fatMaterial(c, w, o));

  constructor(readonly viewport: Viewport3D) {
    this.planeLayer = new PlaneLayer(viewport);
    viewport.scene.add(this.root, this.planeLayer.group, this.highlight, this.overlay, this.datums.group);
    viewport.onTheme.push(() => this.readColors());
    viewport.onFrame.push(() => { for (const m of this.fat) m.resolution.set(viewport.width, viewport.height); });
    this.readColors();
    const c = viewport.canvas;
    c.addEventListener("pointermove", this.onMove);
    c.addEventListener("pointerdown", this.onDown);
    c.addEventListener("pointerup", this.onUp);
    c.addEventListener("pointerleave", () => this.setHover(null, true));
    c.addEventListener("pointerdown", this.onRightDown);
    c.addEventListener("pointerup", this.onRightUp);
  }

  private fatMaterial(color: THREE.Color, width: number, o: Partial<{ dashed: boolean; depthTest: boolean }> = {}): LineMaterial {
    const m = new LineMaterial({ color: color.getHex(), linewidth: width, dashed: !!o.dashed, dashSize: 2, gapSize: 1.5, depthTest: o.depthTest !== false, transparent: true });
    m.resolution.set(this.viewport.width, this.viewport.height);
    this.fat.push(m);
    return m;
  }

  private readColors(): void {
    const ink = tokenColor("--ink"), paper = tokenColor("--paper");
    this.colors.body.copy(paper).lerp(ink, 0.22);
    this.colors.edge.copy(ink);
    // --mark is the theme's colour for annotations on a canvas; the chrome's own selection colour is a neutral
    // that would not show on a grey solid
    this.colors.select.copy(tokenColor("--mark"));
    this.colors.hover.copy(this.colors.select).lerp(this.colors.body, 0.45);
    // what a dialog holds in a field that is not listening: still the selection colour, but quieter
    this.colors.held.copy(this.colors.select).lerp(this.colors.body, 0.3);
    this.colors.sketch.copy(tokenColor("--ink-2"));
    this.colors.plane.copy(tokenColor("--ink-3"));
    this.colors.dim.copy(ink).lerp(paper, 0.6);
    this.bodyMaterial.color.copy(this.colors.body);
    this.edgeMaterial.color.copy(this.colors.edge);
    this.planeLayer.setColor(this.colors.plane);
    for (const s of this.sketches.values()) this.styleSketch(s);
    this.datums.group.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material & { color?: THREE.Color }; if (m && m.color) m.color.copy(this.colors.plane); });
    this.drawHighlight();
  }

  // ---------------------------------------------------------------- default planes, origin, what is hidden
  /**
   * What a person has hidden: "origin", "top", "front", "right", and the feature ids of reference geometry.
   * Hidden things are neither drawn nor picked.
   */
  setHiddenItems(ids: ReadonlySet<string>): void {
    this.hiddenItems = new Set(ids);
    this.planeLayer.setHidden(ids);
    this.datums.setHidden(ids);
    this.labelDatums();
    this.drawHighlight();
  }
  /** The names of the reference planes (their features' names), drawn on them. */
  setDatumNames(names: ReadonlyMap<string, string>): void { this.datumNames = new Map(names); this.labelDatums(); }
  private labelDatums(): void {
    const keep = new Set<string>();
    for (const p of this.datums.planes()) {
      const key = "datum:" + p.featureId; keep.add(key);
      this.planeLayer.setLabel(key, this.datumNames.get(p.featureId) || "Plane", p.corners, p.normal);
      this.planeLayer.setLabelVisible(key, p.shown);
    }
    this.planeLayer.pruneLabels("datum:", keep);
  }

  // ---------------------------------------------------------------- bodies
  /** Show these bodies (the result of a regeneration).  A body whose revision is unchanged is left as it is. */
  setBodies(results: readonly BodyResult[]): void {
    const seen = new Set<string>();
    for (const r of results) {
      seen.add(r.id);
      const old = this.bodies.get(r.id);
      if (old && old.rev === r.rev) { old.result = r; continue; }
      if (old) this.removeBody(old);
      if (!r.mesh) continue;
      const m = r.mesh;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
      g.setIndex(new THREE.BufferAttribute(m.indices, 1));
      g.computeBoundingBox(); g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.bodyMaterial);
      mesh.userData.fit = true;
      const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.BufferAttribute(m.edges.positions, 3));
      const edges = new THREE.LineSegments(eg, this.edgeMaterial);
      const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.BufferAttribute(m.vertices.positions, 3));
      const points = new THREE.Points(pg, this.pointMaterial);
      const style = this.bodyStyle ? this.bodyStyle(r) : null;
      if (style && style.faces === false) { mesh.visible = false; mesh.userData.fit = false; }
      if (style && style.edges === false) edges.visible = false;
      const group = new THREE.Group(); group.add(mesh, edges, points);
      this.root.add(group);
      this.bodies.set(r.id, { rev: r.rev, group, mesh, edges, points, result: r });
    }
    for (const [id, b] of Array.from(this.bodies)) if (!seen.has(id)) { this.removeBody(b); this.bodies.delete(id); }
    this.planeLayer.setExtent(this.bodiesBox());
    this.drawHighlight();
    this.viewport.invalidate();
    for (const fn of this.onBodies) fn();
  }
  /** The three.js objects that draw a body (its triangles, edge lines and vertex points), for display options. */
  bodyObjects(id: string): { group: THREE.Group; mesh: THREE.Mesh; edges: THREE.LineSegments; points: THREE.Points; result: BodyResult } | undefined {
    const b = this.bodies.get(id);
    return b ? { group: b.group, mesh: b.mesh, edges: b.edges, points: b.points, result: b.result } : undefined;
  }
  private removeBody(b: BodyObjects): void {
    this.root.remove(b.group);
    b.mesh.geometry.dispose(); b.edges.geometry.dispose(); b.points.geometry.dispose();
  }
  /** Show the reference planes, axes, points and curves of a regeneration. */
  setDatums(views: readonly DatumView[]): void { this.datums.set(views, this.colors.plane); this.datums.setHidden(this.hiddenItems); this.labelDatums(); this.drawHighlight(); this.viewport.invalidate(); }

  /** The box of every body's mesh (empty when there is none). */
  bodiesBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const b of this.bodies.values()) { const bb = b.result.mesh?.bbox; if (bb) { box.expandByPoint(new THREE.Vector3(bb[0], bb[1], bb[2])); box.expandByPoint(new THREE.Vector3(bb[3], bb[4], bb[5])); } }
    return box;
  }

  /** True when at least one body is on screen. */
  get hasBodies(): boolean { return this.bodies.size > 0; }

  // ---------------------------------------------------------------- sketches
  /** Show these sketches.  `active` is the one being edited: it is drawn stronger and its regions are filled. */
  setSketches(views: readonly SketchView[], visible: ReadonlySet<string>, active: string | null): void {
    this.activeSketch = active;
    for (const s of this.sketches.values()) { this.root.remove(s.group); s.lines.geometry.dispose(); for (const f of s.fills) f.geometry.dispose(); }
    this.sketches.clear();
    for (const v of views) {
      if (!visible.has(v.featureId) && v.featureId !== active) continue;
      const group = new THREE.Group();
      const seg: number[] = [];
      for (const c of v.curves) for (let i = 0; i + 5 < c.points.length; i += 3) seg.push(c.points[i], c.points[i + 1], c.points[i + 2], c.points[i + 3], c.points[i + 4], c.points[i + 5]);
      const lg = new LineSegmentsGeometry(); lg.setPositions(seg.length ? seg : [0, 0, 0, 0, 0, 0]);
      const lines = new LineSegments2(lg, this.fatMaterial(this.colors.sketch, 1.5, { depthTest: false }));
      lines.renderOrder = 5; lines.visible = seg.length > 0;
      lines.userData.fit = seg.length > 0;
      group.add(lines);
      const fills: THREE.Mesh[] = [];
      for (const r of v.regions) {
        const shape = new THREE.Shape(pairs(r.outer).map(([x, y]) => new THREE.Vector2(x, y)));
        for (const h of r.holes) shape.holes.push(new THREE.Path(pairs(h).map(([x, y]) => new THREE.Vector2(x, y))));
        const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
        fill.applyMatrix4(frameMatrix(v.frame));
        fill.userData.region = r.id;
        fills.push(fill); group.add(fill);
      }
      group.visible = v.featureId !== this.hiddenSketch;
      this.root.add(group);
      const s: SketchObjects = { group, view: v, lines, fills };
      this.sketches.set(v.featureId, s);
      this.styleSketch(s);
    }
    this.drawHighlight();
    this.viewport.invalidate();
  }
  private styleSketch(s: SketchObjects): void {
    const active = s.view.featureId === this.activeSketch;
    (s.lines.material as LineMaterial).color.copy(active ? this.colors.edge : this.colors.sketch);
    (s.lines.material as LineMaterial).linewidth = active ? 2 : 1.5;
    for (const f of s.fills) (f.material as THREE.MeshBasicMaterial).color.copy(this.colors.edge);
  }
  /**
   * Keep a sketch but do not draw it (null: draw them all).  The sketch editor draws the open sketch itself
   * (sketch/paint.ts), so that it follows a drag without waiting for the worker; its frame is still answered.
   */
  setSketchHidden(featureId: string | null): void {
    this.hiddenSketch = featureId;
    for (const s of this.sketches.values()) s.group.visible = s.view.featureId !== featureId;
    this.viewport.invalidate();
  }
  /** The frame of a sketch on screen, or null. */
  sketchFrame(featureId: string): Frame | null { return this.sketches.get(featureId)?.view.frame || null; }

  // ---------------------------------------------------------------- hover and selection
  /** Restrict picking to these kinds (null: everything). */
  setFilter(kinds: readonly PickKind[] | null): void { this.filter = kinds ? new Set(kinds) : null; }
  setSelection(picks: readonly Pick[]): void { this.selection = picks.slice(); this.drawHighlight(); }
  /**
   * What the open dialog's fields hold, kept drawn while the dialog is open: `active` (the field that is
   * listening) as a selection, `other` quieter.
   */
  setMarks(active: readonly Pick[], other: readonly Pick[]): void {
    this.marks = { active: active.slice(), other: other.slice() };
    if (!active.length && !other.length) this.held.clear();
    this.drawHighlight();
  }
  /** Is this pick's geometry in the model on screen, or kept from before the feature consumed it? */
  hasGeometry(p: Pick): boolean {
    if (p.kind !== "face" && p.kind !== "edge" && p.kind !== "vertex") return true;
    if (this.held.has(pickKey(p))) return true;
    const mesh = this.bodies.get(p.body)?.result.mesh; if (!mesh) return false;
    return (p.kind === "face" ? mesh.faces.names : p.kind === "edge" ? mesh.edges.names : mesh.vertices.names).includes(p.name);
  }
  /** Keep what a pick looked like before the open dialog's feature consumed it (the "ref-geometry" service's answer). */
  hold(p: Pick, g: { segments?: number[]; triangles?: number[]; at?: Vec3 }): void {
    this.held.set(pickKey(p), { segments: g.segments, triangles: g.triangles ? new Float32Array(g.triangles) : undefined, at: g.at });
    this.drawHighlight();
  }
  /** Geometry to draw as hovered besides what is under the pointer (null or empty: none). */
  setFeatureHover(picks: readonly Pick[] | null): void {
    if (!this.featureHover.length && !(picks && picks.length)) return;
    this.featureHover = picks ? picks.slice() : []; this.drawHighlight();
  }
  /** The faces a feature made, by the names it gave them (and its sketch, plane or axis), as picks. */
  picksOfFeature(featureId: string): Pick[] {
    const out: Pick[] = [];
    const pre = featureId + ":";
    for (const [id, b] of this.bodies) {
      const mesh = b.result.mesh; if (!mesh) continue;
      mesh.faces.names.forEach((name) => { if (name.startsWith(pre)) out.push({ kind: "face", body: id, name, point: [0, 0, 0] }); });
    }
    if (this.sketches.has(featureId)) { const v = this.sketches.get(featureId)!.view; for (const c of v.curves) out.push({ kind: "sketch", featureId, entity: c.entity, region: null, point: [0, 0, 0] }); }
    if (this.datums.view(featureId)) out.push({ kind: "datum", featureId, datum: this.datums.view(featureId)!.kind, point: [0, 0, 0] });
    return out;
  }
  /** The feature whose name a face, edge or vertex carries first: who made it, as far as the names say. */
  featureOf(p: Pick, ids: readonly string[]): string | null {
    if (p.kind === "sketch" || p.kind === "datum") return p.featureId;
    if (p.kind === "plane") return null;
    let best: string | null = null, at = Infinity;
    for (const id of ids) { const i = p.name.indexOf(id); if (i >= 0 && i < at) { at = i; best = id; } }
    return best;
  }
  /** The box around these picks in the model, for zooming to them (null: nothing with a place). */
  boxOf(picks: readonly Pick[]): THREE.Box3 | null {
    const box = new THREE.Box3(), v = new THREE.Vector3();
    for (const p of picks) {
      if (p.kind === "plane") continue;
      if (p.kind === "datum") { const b = this.datums.boxOf(p.featureId); if (b) box.union(b); continue; }
      if (p.kind === "sketch") { const sk = this.sketches.get(p.featureId); if (sk) for (const c of sk.view.curves) if (!p.entity || c.entity === p.entity) for (let i = 0; i + 2 < c.points.length; i += 3) box.expandByPoint(v.set(c.points[i], c.points[i + 1], c.points[i + 2])); continue; }
      const b = this.bodies.get(p.body), mesh = b?.result.mesh; if (!b || !mesh) continue;
      if (p.kind === "face") {
        const i = mesh.faces.names.indexOf(p.name); if (i < 0) continue;
        for (let k = mesh.faces.start[i]; k < mesh.faces.start[i] + mesh.faces.count[i]; k++) { const at = mesh.indices[k] * 3; box.expandByPoint(v.set(mesh.positions[at], mesh.positions[at + 1], mesh.positions[at + 2])); }
      } else if (p.kind === "edge") {
        const i = mesh.edges.names.indexOf(p.name); if (i < 0) continue;
        for (let k = mesh.edges.start[i]; k < mesh.edges.start[i] + mesh.edges.count[i]; k++) box.expandByPoint(v.set(mesh.edges.positions[k * 3], mesh.edges.positions[k * 3 + 1], mesh.edges.positions[k * 3 + 2]));
      } else { const i = mesh.vertices.names.indexOf(p.name); if (i >= 0) box.expandByPoint(v.set(mesh.vertices.positions[i * 3], mesh.vertices.positions[i * 3 + 1], mesh.vertices.positions[i * 3 + 2])); }
    }
    return box.isEmpty() ? null : box;
  }
  /** The direction a flat pick faces (a planar face's outward normal, a plane's, a sketch's), or null. */
  normalOf(p: Pick): { normal: Vec3; up: Vec3 | null } | null {
    if (p.kind === "plane") { const f = DEFAULT_PLANES[p.plane].frame; return { normal: f.normal, up: f.y }; }
    if (p.kind === "sketch") { const f = this.sketches.get(p.featureId)?.view.frame; return f ? { normal: f.normal, up: f.y } : null; }
    if (p.kind === "datum") { const f = this.datums.view(p.featureId)?.frame; return f ? { normal: f.normal, up: f.y } : null; }
    if (p.kind !== "face") return null;
    const mesh = this.bodies.get(p.body)?.result.mesh; if (!mesh) return null;
    const i = mesh.faces.names.indexOf(p.name); if (i < 0 || !mesh.faces.count[i]) return null;
    // flat when every corner of the face has the same normal
    const first = mesh.indices[mesh.faces.start[i]] * 3, n: Vec3 = [mesh.normals[first], mesh.normals[first + 1], mesh.normals[first + 2]];
    for (let k = mesh.faces.start[i]; k < mesh.faces.start[i] + mesh.faces.count[i]; k++) { const at = mesh.indices[k] * 3; if (mesh.normals[at] * n[0] + mesh.normals[at + 1] * n[1] + mesh.normals[at + 2] * n[2] < 0.999) return null; }
    return { normal: n, up: null };
  }
  /** Show what is under the pointer as hovered: for whoever has taken the pointer over but still wants the pre-highlight. */
  hoverAt(ev: { clientX: number; clientY: number }): void { this.setHover(this.pick(ev), true); }
  private setHover(p: Pick | null, tell: boolean): void {
    if ((p ? pickKey(p) : "") === (this.hover ? pickKey(this.hover) : "")) return;
    this.hover = p; this.drawHighlight();
    if (tell) this.onHover(p);
  }

  private drawHighlight(): void {
    for (const o of this.highlight.children.slice()) { this.highlight.remove(o); const m = o as THREE.Mesh; if (m.userData.own) m.geometry.dispose(); }
    const selected = new Set(this.selection.map(pickKey));
    const draw = (p: Pick, color: THREE.Color, strong: boolean, keep = false) => {
      if (p.kind === "plane") {
        const quad = this.planeLayer.quadOf(p.plane);
        if (quad) { const m = new THREE.Mesh(quad.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: strong ? 0.3 : 0.18, side: THREE.DoubleSide, depthWrite: false })); this.highlight.add(m); }
        return;
      }
      if (p.kind === "datum") { for (const o of this.datums.highlight(p.featureId, color, strong)) this.highlight.add(o); return; }
      if (p.kind === "sketch") {
        const s = this.sketches.get(p.featureId); if (!s) return;
        if (p.region) { const f = s.fills.find((x) => x.userData.region === p.region); if (f) { const m = new THREE.Mesh(f.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: strong ? 0.45 : 0.3, side: THREE.DoubleSide, depthWrite: false, depthTest: false })); m.position.copy(f.position); m.quaternion.copy(f.quaternion); m.scale.copy(f.scale); this.highlight.add(m); } }
        const c = p.entity ? s.view.curves.find((x) => x.entity === p.entity) : null;
        if (c) this.addFat(Array.from(polylineSegments(c.points)), color, 3.5);
        const pt = p.entity ? s.view.points.find((x) => x.entity === p.entity) : null;
        if (pt) this.addDot(pt.position, color);
        return;
      }
      const key = pickKey(p), b = this.bodies.get(p.body), mesh = b?.result.mesh;
      const face = (triangles: THREE.BufferAttribute | Float32Array, index: THREE.BufferAttribute | null, start: number, count: number) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", triangles instanceof Float32Array ? new THREE.BufferAttribute(triangles, 3) : triangles);
        if (index) { g.setIndex(index); g.setDrawRange(start, count); }
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: strong ? 0.6 : 0.4, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
        this.highlight.add(m);
      };
      if (p.kind === "face") {
        const i = mesh ? mesh.faces.names.indexOf(p.name) : -1;
        if (i >= 0 && b && mesh) {
          face(b.mesh.geometry.getAttribute("position") as THREE.BufferAttribute, b.mesh.geometry.getIndex(), mesh.faces.start[i], mesh.faces.count[i]);
          if (keep && !this.held.has(key)) {
            const t = new Float32Array(mesh.faces.count[i] * 3);
            for (let k = 0; k < mesh.faces.count[i]; k++) { const at = mesh.indices[mesh.faces.start[i] + k] * 3; t[k * 3] = mesh.positions[at]; t[k * 3 + 1] = mesh.positions[at + 1]; t[k * 3 + 2] = mesh.positions[at + 2]; }
            this.held.set(key, { triangles: t });
          }
        } else { const h = keep ? this.held.get(key) : undefined; if (h && h.triangles) face(h.triangles, null, 0, 0); }
      } else if (p.kind === "edge") {
        const i = mesh ? mesh.edges.names.indexOf(p.name) : -1;
        if (i >= 0 && mesh) {
          const seg = Array.from(mesh.edges.positions.subarray(mesh.edges.start[i] * 3, (mesh.edges.start[i] + mesh.edges.count[i]) * 3));
          this.addFat(seg, color, 4);
          if (keep) this.held.set(key, { segments: seg });
        } else { const h = keep ? this.held.get(key) : undefined; if (h && h.segments) this.addFat(h.segments, color, 4); }
      } else {
        const i = mesh ? mesh.vertices.names.indexOf(p.name) : -1;
        if (i >= 0 && mesh) { const at: Vec3 = [mesh.vertices.positions[i * 3], mesh.vertices.positions[i * 3 + 1], mesh.vertices.positions[i * 3 + 2]]; this.addDot(at, color); if (keep) this.held.set(key, { at }); }
        else { const h = keep ? this.held.get(key) : undefined; if (h && h.at) this.addDot(h.at, color); }
      }
    };
    for (const p of this.marks.other) draw(p, this.colors.held, false, true);
    for (const p of this.marks.active) { draw(p, this.colors.select, true, true); selected.add(pickKey(p)); }
    for (const p of this.selection) draw(p, this.colors.select, true);
    for (const p of this.featureHover) if (!selected.has(pickKey(p))) draw(p, this.colors.hover, false);
    if (this.hover && !selected.has(pickKey(this.hover))) draw(this.hover, this.colors.hover, false);
    // the pointer over something the dialog holds: it is what a click would take out
    else if (this.hover && this.held.has(pickKey(this.hover))) draw(this.hover, this.colors.hover, true, true);
    // the names of the planes that are under the pointer or chosen stand out
    const labels = new Set<string>();
    for (const p of [...this.selection, ...this.marks.active, ...this.marks.other, ...this.featureHover, ...(this.hover ? [this.hover] : [])]) {
      if (p.kind === "plane") labels.add("plane:" + p.plane); else if (p.kind === "datum") labels.add("datum:" + p.featureId);
    }
    this.planeLayer.setMarked(labels);
    this.viewport.invalidate();
  }
  private addFat(segments: number[], color: THREE.Color, width: number): void {
    if (segments.length < 6) return;
    const g = new LineSegmentsGeometry(); g.setPositions(segments);
    const l = new LineSegments2(g, this.fatMaterial(color, width, { depthTest: false }));
    l.renderOrder = 10; l.userData.own = true;
    this.highlight.add(l);
  }
  private addDot(at: Vec3, color: THREE.Color): void {
    const p = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...at)]), new THREE.PointsMaterial({ color, size: 9, sizeAttenuation: false, depthTest: false }));
    p.renderOrder = 11; p.userData.own = true;
    this.highlight.add(p);
  }

  /** Lines drawn over everything, in model space, as point pairs: a tool's rubber band.  Null clears them. */
  setOverlay(segments: number[] | null, dots: Vec3[] = []): void {
    for (const o of this.overlay.children.slice()) { this.overlay.remove(o); (o as THREE.Mesh).geometry.dispose(); }
    if (segments && segments.length >= 6) {
      const g = new LineSegmentsGeometry(); g.setPositions(segments);
      const l = new LineSegments2(g, this.fatMaterial(this.colors.select, 2, { depthTest: false })); l.renderOrder = 12;
      this.overlay.add(l);
    }
    for (const d of dots) { const p = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...d)]), new THREE.PointsMaterial({ color: this.colors.select, size: 8, sizeAttenuation: false, depthTest: false })); p.renderOrder = 13; this.overlay.add(p); }
    this.viewport.invalidate();
  }

  // ---------------------------------------------------------------- picking
  /** What is under the pointer: a vertex before an edge before a face, a body before a sketch before a plane. */
  pick(ev: { clientX: number; clientY: number }): Pick | null {
    const ray = this.viewport.ray(ev), px = this.viewport.pixelSize();
    const rc = this.raycaster; rc.ray.copy(ray); rc.near = 0; rc.far = Infinity;
    const want = (k: PickKind) => !this.filter || this.filter.has(k);
    const at = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
    let best: { pick: Pick; d: number } | null = null;
    const offer = (pick: Pick, d: number, bias: number) => { if (!best || d - bias < best.d) best = { pick, d: d - bias }; };
    const kept = (h: THREE.Intersection) => !this.pickClip || this.pickClip(at(h.point));

    // What the open dialog holds and its preview has consumed (a filleted edge) is still there to be clicked:
    // a click on it takes it out of the field, as a click on any chosen thing does.
    const gone = this.pickHeld(ray, px);
    if (gone && want(gone.kind)) return gone;

    let faceD = Infinity;
    for (const [id, b] of this.bodies) {
      const mesh = b.result.mesh; if (!mesh) continue;
      const hit = rc.intersectObject(b.mesh, false).find(kept);
      if (hit && hit.faceIndex != null) {
        faceD = Math.min(faceD, hit.distance);
        const i = rangeOf(mesh.faces.start, mesh.faces.count, hit.faceIndex * 3);
        if (i >= 0 && want("face")) offer({ kind: "face", body: id, name: mesh.faces.names[i], point: at(hit.point) }, hit.distance, 0);
      }
    }
    // edges and vertices win over the face behind them when the pointer is within a few pixels, unless hidden by a nearer face
    const slack = 6 * px;
    for (const [id, b] of this.bodies) {
      const mesh = b.result.mesh; if (!mesh) continue;
      if (want("edge")) {
        rc.params.Line = { threshold: 5 * px };
        const hit = rc.intersectObject(b.edges, false).filter(kept).sort((p, q) => (p.distanceToRay ?? 0) - (q.distanceToRay ?? 0))[0];
        if (hit && hit.index != null && hit.distance <= faceD + slack) {
          const i = rangeOf(mesh.edges.start, mesh.edges.count, hit.index);
          if (i >= 0) offer({ kind: "edge", body: id, name: mesh.edges.names[i], point: at(hit.point) }, hit.distance, 1e4);
        }
      }
      if (want("vertex")) {
        rc.params.Points = { threshold: 6 * px };
        const hit = rc.intersectObject(b.points, false).filter(kept).sort((p, q) => (p.distanceToRay ?? 0) - (q.distanceToRay ?? 0))[0];
        if (hit && hit.index != null && hit.distance <= faceD + slack) offer({ kind: "vertex", body: id, name: mesh.vertices.names[hit.index], point: at(hit.point) }, hit.distance, 2e4);
      }
    }
    // reference points, axes and curves win over the face behind them, as edges do
    if (want("datum")) {
      const h = this.datums.pick(ray, px, rc, (k) => k !== "plane", false);
      if (h && h.d + (h.datum === "point" ? 1e9 : 1e8) <= faceD + slack) offer({ kind: "datum", featureId: h.featureId, datum: h.datum, point: h.point }, h.d, 0);
      // a reference plane lying on the face under the pointer is drawn over it, so it is what is picked there
      const hp = faceD < Infinity ? this.datums.pick(ray, px, rc, (k) => k === "plane", true) : null;
      if (hp && Math.abs(hp.d - faceD) <= slack) offer({ kind: "datum", featureId: hp.featureId, datum: hp.datum, point: hp.point }, hp.d, 5e3);
    }
    if (best) return (best as { pick: Pick }).pick;

    if (want("sketch")) {
      let found: { pick: Pick; d: number } | null = null;
      for (const [id, s] of this.sketches) {
        const p2 = this.planePoint(ev, s.view.frame); if (!p2) continue;
        const w = new THREE.Vector3(...worldOf(s.view.frame, p2));
        let entity: string | null = null, near = 6 * px;
        for (const c of s.view.curves) { const d = distanceToPolyline(w, c.points); if (d < near) { near = d; entity = c.entity; } }
        for (const pt of s.view.points) { const d = w.distanceTo(new THREE.Vector3(...pt.position)); if (d < 7 * px) { near = -1; entity = pt.entity; } }
        let region: string | null = null;
        if (!entity) for (const r of s.view.regions) if (inside(p2, r.outer) && !r.holes.some((h) => inside(p2, h))) region = r.id;
        if (entity || region) { const d = ray.origin.distanceTo(w); if (!found || d < found.d) found = { pick: { kind: "sketch", featureId: id, entity, region, point: at(w) }, d }; }
      }
      if (found) return (found as { pick: Pick }).pick;
    }
    if (want("datum")) {
      const h = this.datums.pick(ray, px, rc, (k) => k === "plane", true);
      if (h) return { kind: "datum", featureId: h.featureId, datum: h.datum, point: h.point };
    }
    if (want("plane")) {
      const hit = rc.intersectObjects(this.planeLayer.pickable(), false)[0];
      if (hit) return { kind: "plane", plane: hit.object.userData.plane, point: at(hit.point) };
    }
    return null;
  }

  /** The dialog's pick under the pointer that is no longer in the model (drawn from `held`), or null. */
  private pickHeld(ray: THREE.Ray, px: number): Pick | null {
    if (!this.held.size) return null;
    let best: { pick: Pick; d: number } | null = null;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), on = new THREE.Vector3(), hit = new THREE.Vector3();
    for (const p of [...this.marks.active, ...this.marks.other]) {
      if (p.kind !== "edge" && p.kind !== "face" && p.kind !== "vertex") continue;
      const h = this.held.get(pickKey(p)); if (!h) continue;
      const mesh = this.bodies.get(p.body)?.result.mesh;
      const names = mesh ? (p.kind === "edge" ? mesh.edges.names : p.kind === "face" ? mesh.faces.names : mesh.vertices.names) : [];
      if (names.includes(p.name)) continue;   // still in the model: the ordinary pick finds it
      if (h.segments) {
        for (let i = 0; i + 5 < h.segments.length; i += 6) {
          a.set(h.segments[i], h.segments[i + 1], h.segments[i + 2]); b.set(h.segments[i + 3], h.segments[i + 4], h.segments[i + 5]);
          if (ray.distanceSqToSegment(a, b, undefined, on) < (6 * px) ** 2) { const d = ray.origin.distanceTo(on) - 1e6; if (!best || d < best.d) best = { pick: { ...p, point: [on.x, on.y, on.z] }, d }; }
        }
      } else if (h.at) {
        if (ray.distanceSqToPoint(a.set(...h.at)) < (7 * px) ** 2) { const d = ray.origin.distanceTo(a) - 2e6; if (!best || d < best.d) best = { pick: { ...p, point: h.at }, d }; }
      } else if (h.triangles) {
        const t = h.triangles;
        for (let i = 0; i + 8 < t.length; i += 9) {
          a.set(t[i], t[i + 1], t[i + 2]); b.set(t[i + 3], t[i + 4], t[i + 5]); c.set(t[i + 6], t[i + 7], t[i + 8]);
          if (ray.intersectTriangle(a, b, c, false, hit)) { const d = ray.origin.distanceTo(hit); if (!best || d < best.d) best = { pick: { ...p, point: [hit.x, hit.y, hit.z] }, d }; }
        }
      }
    }
    return best ? best.pick : null;
  }

  /** Where the pointer's ray meets a sketch plane, in the plane's own coordinates; null when it runs along it. */
  planePoint(ev: { clientX: number; clientY: number }, frame: Frame): Vec2 | null {
    const ray = this.viewport.ray(ev);
    const n = new THREE.Vector3(...frame.normal), o = new THREE.Vector3(...frame.origin);
    const denom = ray.direction.dot(n);
    if (Math.abs(denom) < 1e-9) return null;
    const t = o.clone().sub(ray.origin).dot(n) / denom;
    const p = ray.origin.clone().addScaledVector(ray.direction, t);
    return toPlane(frame, [p.x, p.y, p.z]);
  }

  private onMove = (ev: PointerEvent): void => {
    if (this.viewport.navigating) return;
    if (this.pointerTool) { this.pointerTool.move?.(ev); return; }
    const d = this.downAt;
    if (d && (d.boxing || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) >= 5)) {
      // a drag with the left button draws a selection box: solid from left to right (inside), dashed the other way (touching)
      d.boxing = true;
      this.setHover(null, true);
      this.showBand(d.x, d.y, ev.clientX, ev.clientY);
      return;
    }
    this.setHover(this.pick(ev), true);
  };
  private onDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    this.viewport.canvas.focus();
    if (this.pointerTool) { this.pointerTool.down?.(ev); return; }
    this.downAt = { x: ev.clientX, y: ev.clientY, boxing: false };
    try { this.viewport.canvas.setPointerCapture(ev.pointerId); } catch (e) { /* a synthetic event */ }
  };
  private onUp = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    if (this.pointerTool) { this.pointerTool.up?.(ev); return; }
    const d = this.downAt; this.downAt = null;
    try { this.viewport.canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* not captured */ }
    if (!d) return;
    if (d.boxing) { this.showBand(0, 0, 0, 0, true); this.onBox(this.boxPicks(d.x, d.y, ev.clientX, ev.clientY), ev); return; }
    this.onPick(this.pick(ev), ev);
  };
  // a right click that does not turn the view is a question about what is under it
  private onRightDown = (ev: PointerEvent): void => { if (ev.button === 2) this.rightAt = { x: ev.clientX, y: ev.clientY }; };
  private onRightUp = (ev: PointerEvent): void => {
    if (ev.button !== 2) return;
    const d = this.rightAt; this.rightAt = null;
    if (d && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 4) this.onContext(this.pointerTool ? null : this.pick(ev), ev);
  };

  private showBand(x0: number, y0: number, x1: number, y1: number, off = false): void {
    if (off) { this.band?.remove(); this.band = null; return; }
    if (!this.band) {
      this.band = document.createElement("div");
      this.band.className = "cad-select-box absolute z-[2] pointer-events-none border border-blue bg-sel-soft/40";
      this.viewport.host.appendChild(this.band);
    }
    const r = this.viewport.canvas.getBoundingClientRect(), b = this.band;
    b.style.left = `${Math.min(x0, x1) - r.left}px`; b.style.top = `${Math.min(y0, y1) - r.top}px`;
    b.style.width = `${Math.abs(x1 - x0)}px`; b.style.height = `${Math.abs(y1 - y0)}px`;
    b.style.borderStyle = x1 < x0 ? "dashed" : "solid";
    b.dataset.crossing = x1 < x0 ? "1" : "";
  }

  /**
   * What a selection box takes.  Drawn from left to right it takes what lies wholly inside it; from right to
   * left, whatever it touches.  Faces and edges (and vertices when the filter asks for them alone), of the
   * kinds the filter allows; what is behind other geometry counts too, as in a wireframe.
   */
  boxPicks(x0: number, y0: number, x1: number, y1: number): Pick[] {
    const crossing = x1 < x0;
    const r = this.viewport.canvas.getBoundingClientRect();
    const lx = Math.min(x0, x1) - r.left, hx = Math.max(x0, x1) - r.left, ly = Math.min(y0, y1) - r.top, hy = Math.max(y0, y1) - r.top;
    this.viewport.project(new THREE.Vector3());   // places the camera
    const cam = this.viewport.activeCamera;
    const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const w = this.viewport.width, h = this.viewport.height;
    /** a model point on screen, into `out` at `at` */
    const put = (x: number, y: number, z: number, out: Float32Array, at: number): void => {
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
      out[at] = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw + 1) / 2 * w; out[at + 1] = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) / 2 * h;
    };
    const inside = (x: number, y: number): boolean => x >= lx && x <= hx && y >= ly && y <= hy;
    /** does the segment a–b pass through the box? (Liang–Barsky) */
    const crosses = (ax: number, ay: number, bx: number, by: number): boolean => {
      let t0 = 0, t1 = 1;
      const dx = bx - ax, dy = by - ay;
      for (const [p, q] of [[-dx, ax - lx], [dx, hx - ax], [-dy, ay - ly], [dy, hy - ay]]) {
        if (p === 0) { if (q < 0) return false; continue; }
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      }
      return true;
    };
    const mx = (lx + hx) / 2, my = (ly + hy) / 2;
    /** is the middle of the box inside the triangle? (a box wholly inside a large face touches it) */
    const covers = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean => {
      const d1 = (mx - bx) * (ay - by) - (ax - bx) * (my - by), d2 = (mx - cx) * (by - cy) - (bx - cx) * (my - cy), d3 = (mx - ax) * (cy - ay) - (cx - ax) * (my - ay);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    };
    const want = (k: PickKind) => !this.filter || this.filter.has(k);
    const vertices = !!this.filter && this.filter.has("vertex") && !this.filter.has("edge") && !this.filter.has("face");
    const out: Pick[] = [];
    for (const [id, b] of this.bodies) {
      const mesh = b.result.mesh; if (!mesh || !b.group.visible || !b.mesh.layers.test(this.raycaster.layers)) continue;
      const P = mesh.positions, n = P.length / 3, xy = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) put(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], xy, i * 2);
      if (want("face")) for (let f = 0; f < mesh.faces.names.length; f++) {
        let all = true, any = false;
        for (let k = mesh.faces.start[f], e = k + mesh.faces.count[f]; k + 2 < e + 0 && !(crossing && any); k += 3) {
          const i0 = mesh.indices[k] * 2, i1 = mesh.indices[k + 1] * 2, i2 = mesh.indices[k + 2] * 2;
          const in0 = inside(xy[i0], xy[i0 + 1]), in1 = inside(xy[i1], xy[i1 + 1]), in2 = inside(xy[i2], xy[i2 + 1]);
          if (!(in0 && in1 && in2)) all = false;
          if (in0 || in1 || in2) any = true;
          else if (crossing && (crosses(xy[i0], xy[i0 + 1], xy[i1], xy[i1 + 1]) || crosses(xy[i1], xy[i1 + 1], xy[i2], xy[i2 + 1]) || crosses(xy[i2], xy[i2 + 1], xy[i0], xy[i0 + 1]) || covers(xy[i0], xy[i0 + 1], xy[i1], xy[i1 + 1], xy[i2], xy[i2 + 1]))) any = true;
          if (!crossing && !all) break;
        }
        if (mesh.faces.count[f] && (crossing ? any : all)) out.push({ kind: "face", body: id, name: mesh.faces.names[f], point: [0, 0, 0] });
      }
      const E = mesh.edges.positions, exy = new Float32Array(4);
      if (want("edge")) for (let e = 0; e < mesh.edges.names.length; e++) {
        let all = true, any = false;
        for (let k = mesh.edges.start[e], end = k + mesh.edges.count[e]; k + 1 < end + 0; k += 2) {
          put(E[k * 3], E[k * 3 + 1], E[k * 3 + 2], exy, 0); put(E[k * 3 + 3], E[k * 3 + 4], E[k * 3 + 5], exy, 2);
          const in0 = inside(exy[0], exy[1]), in1 = inside(exy[2], exy[3]);
          if (!(in0 && in1)) all = false;
          if (in0 || in1 || (crossing && crosses(exy[0], exy[1], exy[2], exy[3]))) any = true;
          if (crossing ? any : !all) break;
        }
        if (mesh.edges.count[e] && (crossing ? any : all)) out.push({ kind: "edge", body: id, name: mesh.edges.names[e], point: [0, 0, 0] });
      }
      const V = mesh.vertices.positions;
      if (vertices) for (let i = 0; i < mesh.vertices.names.length; i++) { put(V[i * 3], V[i * 3 + 1], V[i * 3 + 2], exy, 0); if (inside(exy[0], exy[1])) out.push({ kind: "vertex", body: id, name: mesh.vertices.names[i], point: [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]] }); }
    }
    return out;
  }

  dispose(): void {
    const c = this.viewport.canvas;
    c.removeEventListener("pointermove", this.onMove); c.removeEventListener("pointerdown", this.onDown); c.removeEventListener("pointerup", this.onUp);
    c.removeEventListener("pointerdown", this.onRightDown); c.removeEventListener("pointerup", this.onRightUp);
    this.showBand(0, 0, 0, 0, true);
    this.planeLayer.dispose();
    this.viewport.scene.remove(this.root, this.planeLayer.group, this.highlight, this.overlay, this.datums.group);
  }
}

// ---------------------------------------------------------------- small geometry helpers
function pairs(a: Float32Array): Vec2[] { const out: Vec2[] = []; for (let i = 0; i + 1 < a.length; i += 2) out.push([a[i], a[i + 1]]); return out; }
function* polylineSegments(p: Float32Array): Generator<number> { for (let i = 0; i + 5 < p.length; i += 3) { yield p[i]; yield p[i + 1]; yield p[i + 2]; yield p[i + 3]; yield p[i + 4]; yield p[i + 5]; } }
function worldOf(f: Frame, p: Vec2): Vec3 { return [f.origin[0] + p[0] * f.x[0] + p[1] * f.y[0], f.origin[1] + p[0] * f.x[1] + p[1] * f.y[1], f.origin[2] + p[0] * f.x[2] + p[1] * f.y[2]]; }
function frameMatrix(f: Frame): THREE.Matrix4 {
  return new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.x), new THREE.Vector3(...f.y), new THREE.Vector3(...f.normal)).setPosition(new THREE.Vector3(...f.origin));
}
/** The index of the range [start[i], start[i] + count[i]) that holds `at`, or -1. */
function rangeOf(start: Uint32Array, count: Uint32Array, at: number): number {
  for (let i = 0; i < start.length; i++) if (at >= start[i] && at < start[i] + count[i]) return i;
  return -1;
}
function distanceToPolyline(p: THREE.Vector3, pts: Float32Array): number {
  let best = Infinity;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), line = new THREE.Line3(), c = new THREE.Vector3();
  for (let i = 0; i + 5 < pts.length; i += 3) {
    a.set(pts[i], pts[i + 1], pts[i + 2]); b.set(pts[i + 3], pts[i + 4], pts[i + 5]);
    line.set(a, b).closestPointToPoint(p, true, c);
    best = Math.min(best, c.distanceTo(p));
  }
  return best;
}
function inside(p: Vec2, poly: Float32Array): boolean {
  let inn = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const ax = poly[i], ay = poly[i + 1], bx = poly[j], by = poly[j + 1];
    if ((ay > p[1]) !== (by > p[1]) && p[0] < ((bx - ax) * (p[1] - ay)) / (by - ay) + ax) inn = !inn;
  }
  return inn;
}
