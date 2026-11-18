// scene.ts — an assembly in the 3D viewport: instances drawn from shared geometry, picking by geometry name,
// hover and selection, connector glyphs and the move manipulator.
//
// Instancing: a part's tessellation is uploaded once (one BufferGeometry per unique mesh) and every instance
// of it is a small object with its own matrix.  Moving an instance writes one matrix; nothing is rebuilt while
// dragging.  It draws what it is told and reports what the pointer is over; the editor (ui/assembly.ts) holds
// the state.
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { tokenColor, type Viewport3D } from "../../../shared/viewport3d/viewport3d";
import type { BodyMesh, Vec3 } from "../../mechanical/api";
import type { Transform } from "../document/format";
import type { MateFrame } from "../solver/types";
import type { SourcePiece } from "../sources/types";
import { Triad } from "./triad";

/** What the pointer is over: named geometry of one piece of one instance.  `point` is in assembly space. */
export interface AssemblyPick { instance: string; piece: string; kind: "face" | "edge" | "vertex"; name: string; point: Vec3 }
export const pickKey = (p: AssemblyPick | null): string => (p ? `${p.instance}|${p.piece}|${p.kind}|${p.name}` : "");

export interface DrawnInstance { id: string; pieces: readonly SourcePiece[]; hidden: boolean }
export interface ConnectorMark { frame: MateFrame; strong?: boolean }

interface Shared { mesh: THREE.BufferGeometry; edges: THREE.BufferGeometry; points: THREE.BufferGeometry; uses: number; shade: number }
interface PieceObjects { piece: SourcePiece; group: THREE.Group; mesh: THREE.Mesh; edges: THREE.LineSegments; points: THREE.Points }
interface InstanceObjects { id: string; group: THREE.Group; pieces: PieceObjects[]; hidden: boolean }

export function matrixOf(t: readonly number[], into = new THREE.Matrix4()): THREE.Matrix4 {
  return into.set(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], t[9], t[10], t[11], 0, 0, 0, 1);
}

export class AssemblyScene {
  private readonly root = new THREE.Group();
  private readonly highlight = new THREE.Group();
  private readonly marks = new THREE.Group();
  private readonly instances = new Map<string, InstanceObjects>();
  private readonly shared = new Map<BodyMesh, Shared>();
  private readonly raycaster = new THREE.Raycaster();
  private colors = { body: new THREE.Color(), edge: new THREE.Color(), hover: new THREE.Color(), select: new THREE.Color(), bad: new THREE.Color(), paper: new THREE.Color() };
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly selectedMaterial = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  private readonly markedMaterial = this.selectedMaterial.clone();
  private readonly edgeMaterial = new THREE.LineBasicMaterial();
  private readonly pointMaterial = new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, transparent: true, opacity: 0 });
  private fat: LineMaterial[] = [];
  private hover: AssemblyPick | null = null;
  private selection = new Set<string>();
  private marked = new Set<string>();
  private connectorMarks: ConnectorMark[] = [];
  private shades = 0;
  readonly triad: Triad;

  constructor(readonly viewport: Viewport3D) {
    viewport.scene.add(this.root, this.highlight, this.marks);
    for (let i = 0; i < 5; i++) this.materials.push(new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    this.triad = new Triad(viewport);
    viewport.onTheme.push(this.readColors);
    viewport.onFrame.push(this.onFrame);
    this.readColors();
  }

  private onFrame = (): void => {
    for (const m of this.fat) m.resolution.set(this.viewport.width, this.viewport.height);
    // connector glyphs keep their size on screen
    const s = this.viewport.pixelSize();
    for (const o of this.marks.children) o.scale.setScalar(s);
  };

  private readColors = (): void => {
    const ink = tokenColor("--ink"), paper = tokenColor("--paper"), mark = tokenColor("--mark");
    this.colors.paper.copy(paper);
    this.colors.body.copy(paper).lerp(ink, 0.22);
    this.colors.edge.copy(ink);
    this.colors.select.copy(mark);
    this.colors.hover.copy(mark).lerp(this.colors.body, 0.45);
    this.colors.bad.copy(tokenColor("--err"));
    // parts are told apart by a slightly different grey each, never by a hue: the chrome's rule holds here too
    this.materials.forEach((m, i) => m.color.copy(paper).lerp(ink, 0.14 + 0.05 * i));
    this.selectedMaterial.color.copy(this.colors.body).lerp(mark, 0.55);
    this.markedMaterial.color.copy(this.colors.body).lerp(this.colors.bad, 0.6);
    this.edgeMaterial.color.copy(this.colors.edge);
    this.triad.readColors();
    this.drawHighlight(); this.drawMarks();
  };

  // ---------------------------------------------------------------- instances
  private share(mesh: BodyMesh): Shared {
    let s = this.shared.get(mesh);
    if (!s) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
      g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      g.computeBoundingBox(); g.computeBoundingSphere();
      const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.BufferAttribute(mesh.edges.positions, 3)); eg.computeBoundingSphere();
      const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.BufferAttribute(mesh.vertices.positions, 3)); pg.computeBoundingSphere();
      s = { mesh: g, edges: eg, points: pg, uses: 0, shade: this.shades++ % this.materials.length };
      this.shared.set(mesh, s);
    }
    s.uses++;
    return s;
  }
  private unshare(mesh: BodyMesh): void {
    const s = this.shared.get(mesh);
    if (!s || --s.uses > 0) return;
    s.mesh.dispose(); s.edges.dispose(); s.points.dispose();
    this.shared.delete(mesh);
  }
  /** How many geometries are on the GPU, and how many objects draw them. */
  get stats(): { geometries: number; instances: number; pieces: number } { let pieces = 0; for (const i of this.instances.values()) pieces += i.pieces.length; return { geometries: this.shared.size, instances: this.instances.size, pieces }; }

  private materialFor(id: string, shade: number): THREE.Material { return this.marked.has(id) ? this.markedMaterial : this.selection.has(id) ? this.selectedMaterial : this.materials[shade]; }

  /** Show these instances.  One whose pieces are the same objects as before is left alone. */
  setInstances(list: readonly DrawnInstance[]): void {
    const seen = new Set<string>();
    for (const d of list) {
      seen.add(d.id);
      let o = this.instances.get(d.id);
      if (!o) { const group = new THREE.Group(); group.matrixAutoUpdate = false; this.root.add(group); o = { id: d.id, group, pieces: [], hidden: false }; this.instances.set(d.id, o); }
      const same = o.pieces.length === d.pieces.length && o.pieces.every((p, i) => p.piece === d.pieces[i]);
      if (!same) {
        // take the new geometry before letting the old go, so a mesh both use is not uploaded twice
        const fresh = d.pieces.map((piece) => ({ piece, s: this.share(piece.mesh) }));
        this.dropPieces(o);
        for (const { piece, s } of fresh) {
          const group = new THREE.Group(); group.matrixAutoUpdate = false;
          if (piece.transform) matrixOf(piece.transform, group.matrix);
          const mesh = new THREE.Mesh(s.mesh, this.materialFor(d.id, s.shade));
          mesh.userData.fit = true; mesh.userData.shade = s.shade;
          const edges = new THREE.LineSegments(s.edges, this.edgeMaterial);
          const points = new THREE.Points(s.points, this.pointMaterial);
          // a ghost is drawn by something else (a board's picture); it stays in the scene for the pointer
          if (piece.ghost) { mesh.visible = false; mesh.userData.fit = false; edges.visible = false; points.visible = false; }
          group.add(mesh, edges, points);
          o.group.add(group);
          o.pieces.push({ piece, group, mesh, edges, points });
        }
        o.group.updateMatrixWorld(true);
      }
      o.hidden = d.hidden; o.group.visible = !d.hidden;
    }
    for (const [id, o] of Array.from(this.instances)) if (!seen.has(id)) { this.dropPieces(o); this.root.remove(o.group); this.instances.delete(id); }
    this.drawHighlight();
    this.viewport.invalidate();
  }
  private dropPieces(o: InstanceObjects): void {
    for (const p of o.pieces) { o.group.remove(p.group); this.unshare(p.piece.mesh); }
    o.pieces = [];
  }

  /** Move instances: the fast path of a drag. */
  setTransforms(transforms: ReadonlyMap<string, readonly number[]>): void {
    for (const [id, t] of transforms) {
      const o = this.instances.get(id); if (!o) continue;
      matrixOf(t, o.group.matrix);
      o.group.updateMatrixWorld(true);
    }
    this.drawHighlight();
    this.viewport.invalidate();
  }
  transformOf(id: string): Transform | null {
    const o = this.instances.get(id); if (!o) return null;
    const e = o.group.matrix.elements;
    return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]];
  }
  /** The box of an instance in assembly space, or null when it draws nothing. */
  boxOf(id: string): THREE.Box3 | null {
    const o = this.instances.get(id); if (!o || !o.pieces.length) return null;
    const box = new THREE.Box3();
    for (const p of o.pieces) box.union(new THREE.Box3().copy(p.mesh.geometry.boundingBox!).applyMatrix4(p.mesh.matrixWorld));
    return box;
  }
  /** The box of everything that is shown. */
  box(): THREE.Box3 { const box = new THREE.Box3(); for (const [id, o] of this.instances) if (!o.hidden) { const b = this.boxOf(id); if (b) box.union(b); } return box; }

  // ---------------------------------------------------------------- selection, marks, hover
  private restyle(): void {
    for (const o of this.instances.values()) for (const p of o.pieces) {
      p.mesh.material = this.materialFor(o.id, p.mesh.userData.shade);
      // a ghost shows its edges while it is selected or marked: that is how a board instance looks chosen
      if (p.piece.ghost) p.edges.visible = this.selection.has(o.id) || this.marked.has(o.id);
    }
    this.viewport.invalidate();
  }
  setSelection(ids: Iterable<string>): void { this.selection = new Set(ids); this.restyle(); }
  /** Tint instances as a problem (interference, an error): an analysis tool's result. */
  setMarked(ids: Iterable<string>): void { this.marked = new Set(ids); this.restyle(); }
  setHover(p: AssemblyPick | null): void { if (pickKey(p) === pickKey(this.hover)) return; this.hover = p; this.drawHighlight(); }

  private fatMaterial(color: THREE.Color, width: number): LineMaterial {
    const m = new LineMaterial({ color: color.getHex(), linewidth: width, depthTest: false, transparent: true });
    m.resolution.set(this.viewport.width, this.viewport.height);
    this.fat.push(m);
    return m;
  }

  private drawHighlight(): void {
    for (const o of this.highlight.children.slice()) { this.highlight.remove(o); const m = o as THREE.Mesh; if (m.userData.own) m.geometry.dispose(); const mat = m.material as THREE.Material; const at = this.fat.indexOf(mat as LineMaterial); if (at >= 0) this.fat.splice(at, 1); mat.dispose(); }
    const p = this.hover;
    const inst = p && this.instances.get(p.instance), piece = inst && inst.pieces.find((x) => x.piece.id === p!.piece);
    if (p && piece) {
      const mesh = piece.piece.mesh, color = this.colors.hover;
      let made: THREE.Object3D | null = null;
      if (p.kind === "face") {
        const i = mesh.faces.names.indexOf(p.name);
        if (i >= 0) {
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", piece.mesh.geometry.getAttribute("position")); g.setIndex(piece.mesh.geometry.getIndex());
          g.setDrawRange(mesh.faces.start[i], mesh.faces.count[i]);
          made = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
        }
      } else if (p.kind === "edge") {
        const i = mesh.edges.names.indexOf(p.name);
        if (i >= 0 && mesh.edges.count[i] >= 2) {
          const g = new LineSegmentsGeometry(); g.setPositions(Array.from(mesh.edges.positions.subarray(mesh.edges.start[i] * 3, (mesh.edges.start[i] + mesh.edges.count[i]) * 3)));
          made = new LineSegments2(g, this.fatMaterial(color, 4)); made.renderOrder = 10;
        }
      } else {
        const i = mesh.vertices.names.indexOf(p.name);
        if (i >= 0) { made = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(mesh.vertices.positions[i * 3], mesh.vertices.positions[i * 3 + 1], mesh.vertices.positions[i * 3 + 2])]), new THREE.PointsMaterial({ color, size: 9, sizeAttenuation: false, depthTest: false })); made.renderOrder = 11; }
      }
      if (made) { made.userData.own = true; made.matrixAutoUpdate = false; made.matrix.copy(piece.mesh.matrixWorld); made.matrixWorld.copy(piece.mesh.matrixWorld); this.highlight.add(made); }
    }
    this.viewport.invalidate();
  }

  /** Mate connectors to show: the one under the pointer, the two of the mate being made or selected. */
  setConnectors(list: readonly ConnectorMark[]): void { this.connectorMarks = list.slice(); this.drawMarks(); }
  private drawMarks(): void {
    for (const o of this.marks.children.slice()) { this.marks.remove(o); (o as THREE.LineSegments).geometry.dispose(); ((o as THREE.LineSegments).material as THREE.Material).dispose(); }
    for (const c of this.connectorMarks) {
      // a ring in the connector's plane, a tick along its x, and its primary axis: 1 unit = 1 CSS pixel
      const pts: number[] = [], R = c.strong ? 13 : 11, N = 28;
      for (let i = 0; i < N; i++) { const a = (i / N) * 2 * Math.PI, b = ((i + 1) / N) * 2 * Math.PI; pts.push(Math.cos(a) * R, Math.sin(a) * R, 0, Math.cos(b) * R, Math.sin(b) * R, 0); }
      pts.push(0, 0, 0, R, 0, 0, 0, 0, 0, 0, 0, R * 2.2, -3, 0, R * 2.2 - 6, 0, 0, R * 2.2, 3, 0, R * 2.2 - 6, 0, 0, R * 2.2);
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: c.strong ? this.colors.select : this.colors.hover, depthTest: false, transparent: true }));
      const f = c.frame;
      l.matrixAutoUpdate = true;
      l.position.set(f.o[0], f.o[1], f.o[2]);
      l.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.x), new THREE.Vector3(...f.y), new THREE.Vector3(...f.z)));
      l.renderOrder = 14;
      l.scale.setScalar(this.viewport.pixelSize());
      this.marks.add(l);
    }
    this.viewport.invalidate();
  }

  // ---------------------------------------------------------------- picking
  /** What is under the pointer: a vertex before an edge before a face, the nearest instance first. */
  pick(ev: { clientX: number; clientY: number }, o: { only?: ReadonlySet<string>; faces?: boolean } = {}): AssemblyPick | null {
    const ray = this.viewport.ray(ev), px = this.viewport.pixelSize();
    const rc = this.raycaster; rc.ray.copy(ray); rc.near = 0; rc.far = Infinity;
    const at = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
    const meshes: THREE.Object3D[] = [], edges: THREE.Object3D[] = [], points: THREE.Object3D[] = [];
    const owner = new Map<THREE.Object3D, { inst: InstanceObjects; piece: PieceObjects }>();
    for (const inst of this.instances.values()) {
      if (inst.hidden || (o.only && !o.only.has(inst.id))) continue;
      for (const piece of inst.pieces) { meshes.push(piece.mesh); edges.push(piece.edges); points.push(piece.points); owner.set(piece.mesh, { inst, piece }); owner.set(piece.edges, { inst, piece }); owner.set(piece.points, { inst, piece }); }
    }
    let best: { pick: AssemblyPick; d: number } | null = null;
    const offer = (pick: AssemblyPick, d: number) => { if (!best || d < best.d) best = { pick, d }; };
    const face = rc.intersectObjects(meshes, false)[0];
    let faceD = Infinity;
    if (face && face.faceIndex != null) {
      const w = owner.get(face.object)!, mesh = w.piece.piece.mesh;
      faceD = face.distance;
      const i = rangeOf(mesh.faces.start, mesh.faces.count, face.faceIndex * 3);
      if (i >= 0) offer({ instance: w.inst.id, piece: w.piece.piece.id, kind: "face", name: mesh.faces.names[i], point: at(face.point) }, face.distance);
    }
    if (!o.faces) {
      const slack = 6 * px;
      rc.params.Line = { threshold: 5 * px };
      const edge = rc.intersectObjects(edges, false).filter((h) => h.distance <= faceD + slack).sort((p, q) => (p.distanceToRay ?? 0) - (q.distanceToRay ?? 0))[0];
      if (edge && edge.index != null) {
        const w = owner.get(edge.object)!, mesh = w.piece.piece.mesh;
        const i = rangeOf(mesh.edges.start, mesh.edges.count, edge.index);
        if (i >= 0) offer({ instance: w.inst.id, piece: w.piece.piece.id, kind: "edge", name: mesh.edges.names[i], point: at(edge.point) }, edge.distance - 1e4);
      }
      rc.params.Points = { threshold: 6 * px };
      const vertex = rc.intersectObjects(points, false).filter((h) => h.distance <= faceD + slack).sort((p, q) => (p.distanceToRay ?? 0) - (q.distanceToRay ?? 0))[0];
      if (vertex && vertex.index != null) {
        const w = owner.get(vertex.object)!;
        offer({ instance: w.inst.id, piece: w.piece.piece.id, kind: "vertex", name: w.piece.piece.mesh.vertices.names[vertex.index], point: at(vertex.point) }, vertex.distance - 2e4);
      }
    }
    return best ? (best as { pick: AssemblyPick }).pick : null;
  }

  dispose(): void {
    this.triad.dispose();
    for (const o of this.instances.values()) this.dropPieces(o);
    this.viewport.scene.remove(this.root, this.highlight, this.marks);
  }
}

/** The index of the range [start[i], start[i] + count[i]) that holds `at`, or -1. */
function rangeOf(start: Uint32Array, count: Uint32Array, at: number): number {
  for (let i = 0; i < start.length; i++) if (at >= start[i] && at < start[i] + count[i]) return i;
  return -1;
}
