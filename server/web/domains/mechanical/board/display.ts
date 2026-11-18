// display.ts — a board in the part studio's viewport, looking like the board: the laminate with its holes, the
// two faces as images composed from the copper, mask and silkscreen, and every part as its 3D model (or the
// stand-in the 3D viewer draws while there is none).  The pieces are the 3D viewer's own (pcb/exports/board3d.ts).
//
// It is built to follow a board that is being edited:
//   • each footprint is a mesh of its own, so a moved footprint rebuilds one small mesh, at once;
//   • the laminate is triangulated again only when the outline or a drill changed, and a face image is composed
//     again only when something drawn on that face changed, both a moment after the edits stop and one face at
//     a time (they are the costly steps, and a dragged footprint would otherwise pay for them on every step).
//
// Nothing here is pickable: picking and references go to the feature's solids (brep.ts), which are drawn
// invisible underneath.
import * as THREE from "three";
import type { Viewport3D } from "../../../shared/viewport3d/viewport3d";
import { assignHoles, boardHoles, boardShape, type Hole, type Pt } from "../../pcb/exports/board-geometry";
import { FaceComposer, layerColor, modelStore, partTriangles, slabGeometries, textureExtent, type FaceLayers, type ModelStore, type Side, type TextureExtent } from "../../pcb/exports/board3d";
import type { Frame } from "../core/geometry";
import { toFootprint, type BoardComponent, type BoardDelta, type BoardReader, type Measured, type PartBox } from "./model";

const FACE_LAYERS: FaceLayers = { body: true, copper: true, mask: true, silk: true, paste: true, extra: [] };
/** how long after the last edit the laminate is redone, and then each stale face image, ms */
const SETTLE_MS = 320, FACE_MS = 480;
/** pixels a face image may have: sharp enough to read the silkscreen, small enough to compose in a blink */
const FACE_BUDGET = 4e6;

const now = (): number => performance.now();

export interface DisplayStats {
  /** meshes rebuilt by the last update, and how long that took */
  parts: number; partsMs: number;
  /** the last laminate rebuild and the last composition of one face image, ms (0 when not yet done) */
  slabMs: number; facesMs: number;
  slabBuilds: number; faceBuilds: number;
  /** of faceBuilds, the compositions of the back face */
  backBuilds: number;
  /** parts drawn from their real 3D model */
  realModels: number;
}

export class BoardDisplay {
  /** in the scene; its matrix is the board's frame */
  readonly group = new THREE.Group();
  /** the 3D viewer's model space: front face at z = 0 */
  private readonly inner = new THREE.Group();
  private readonly partsGroup = new THREE.Group();
  private readonly partMaterial = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 40, specular: new THREE.Color(0x333333) });
  private readonly parts = new Map<string, { mesh: THREE.Mesh; modelKey: string; real: boolean }>();
  private slab: THREE.Mesh[] = [];
  private faces: Record<Side, { mesh: THREE.Mesh; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } | null> = { F: null, B: null };
  private extent: TextureExtent | null = null;
  private painted: Hole[] = [];
  private reader: BoardReader | null = null;
  private origin: Pt = [0, 0];
  private thickness = 0;
  private slabDirty = false;
  private faceDirty: Record<Side, boolean> = { F: false, B: false };
  private timer = 0; private faceTimer = 0;
  private stopModels: (() => void) | null = null;
  private store: ModelStore | null = null;
  private disposed = false;
  readonly stats: DisplayStats = { parts: 0, partsMs: 0, slabMs: 0, facesMs: 0, slabBuilds: 0, faceBuilds: 0, backBuilds: 0, realModels: 0 };
  /** A part's real size is known (or no longer is): the Board feature's envelopes should follow. */
  onMeasured: () => void = () => {};

  constructor(private readonly viewport: Viewport3D) {
    this.group.matrixAutoUpdate = false;
    this.group.name = "board-display";
    this.inner.add(this.partsGroup);
    this.group.add(this.inner);
    viewport.scene.add(this.group);
    try { this.store = modelStore(); this.stopModels = this.store.listen(() => this.modelsArrived()); } catch (e) { this.store = null; }
  }

  /** Where the board is: its frame in model space (placement.ts). */
  setFrame(frame: Frame): void {
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...frame.x), new THREE.Vector3(...frame.y), new THREE.Vector3(...frame.normal)).setPosition(new THREE.Vector3(...frame.origin));
    if (m.equals(this.group.matrix)) return;
    this.group.matrix.copy(m); this.group.matrixWorldNeedsUpdate = true;
    this.viewport.invalidate();
  }
  setVisible(on: boolean): void { if (this.group.visible !== on) { this.group.visible = on; this.viewport.invalidate(); } }

  private toModel = (p: Pt): Pt => [p[0] - this.origin[0], this.origin[1] - p[1]];

  /**
   * Follow the board.  `delta` is what the reader says changed (null: draw everything again, as after a change
   * of origin).  Parts are redrawn now; the laminate and the faces a moment after the edits stop.
   */
  update(reader: BoardReader, origin: Pt, delta: BoardDelta | null): void {
    if (this.disposed) return;
    const t0 = now();
    const moved = origin[0] !== this.origin[0] || origin[1] !== this.origin[1] || reader !== this.reader;
    const thick = reader.thickness;
    const all = !delta || delta.all || moved || thick !== this.thickness;
    this.reader = reader; this.origin = [origin[0], origin[1]];
    if (thick !== this.thickness) { this.thickness = thick; this.inner.position.z = thick; this.inner.updateMatrix(); }
    let n = 0;
    if (all) {
      const seen = new Set<string>();
      for (const c of reader.components()) { seen.add(c.id); this.drawPart(c); n++; }
      for (const id of Array.from(this.parts.keys())) if (!seen.has(id)) this.dropPart(id);
      this.slabDirty = this.faceDirty.F = this.faceDirty.B = true;
    } else {
      for (const id of delta.components) { const c = reader.component(id); if (c) this.drawPart(c); else this.dropPart(id); n++; }
      if (delta.outline || delta.holes) this.slabDirty = true;
      if (delta.front) this.faceDirty.F = true;
      if (delta.back) this.faceDirty.B = true;
    }
    this.stats.parts = n; this.stats.partsMs = now() - t0;
    if (!this.slab.length) { this.settle(); this.composeNext(); }   // the first time there is nothing to keep on screen meanwhile
    else {
      if (this.slabDirty) { clearTimeout(this.timer); this.timer = window.setTimeout(() => this.settle(), SETTLE_MS); }
      if (this.faceDirty.F || this.faceDirty.B) { clearTimeout(this.faceTimer); this.faceTimer = window.setTimeout(() => this.composeNext(), FACE_MS); }
    }
    this.viewport.invalidate();
  }

  // ---------------------------------------------------------------- parts
  private modelKey(c: BoardComponent): string {
    if (!c.body || !this.store) return "";
    return c.body.models.map((r) => { const s = this.store!.get(r.url); return `${r.url}:${s === undefined ? "?" : s === "missing" ? "-" : "+"}`; }).join("|");
  }
  private dropPart(id: string): void {
    const p = this.parts.get(id); if (!p) return;
    this.partsGroup.remove(p.mesh); p.mesh.geometry.dispose(); this.parts.delete(id);
    if (p.real) this.stats.realModels--;
    if (this.reader && this.reader.setMeasured(id, null)) this.onMeasured();
  }
  private drawPart(c: BoardComponent): void {
    const old = this.parts.get(c.id);
    if (old) { this.partsGroup.remove(old.mesh); old.mesh.geometry.dispose(); this.parts.delete(c.id); if (old.real) this.stats.realModels--; }
    if (!c.body) return;
    if (this.store) this.store.want(c.body.models);
    const t = partTriangles(c.body, this.thickness, this.store, this.toModel);
    if (!t.indices.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(t.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(t.normals, 3));
    g.setAttribute("color", new THREE.BufferAttribute(t.colors, 3));
    g.setIndex(new THREE.BufferAttribute(t.indices, 1));
    const mesh = new THREE.Mesh(g, this.partMaterial);
    mesh.name = `part:${c.ref}`;
    this.partsGroup.add(mesh);
    const modelKey = this.modelKey(c);
    this.parts.set(c.id, { mesh, modelKey, real: t.real });
    if (t.real) this.stats.realModels++;
    if (this.reader && this.reader.setMeasured(c.id, t.real ? this.measure(c, t.positions, modelKey) : null)) this.onMeasured();
  }
  /** The extent of a part's model in its footprint's frame, and how far it stands off the board. */
  private measure(c: BoardComponent, pos: Float32Array, modelKey: string): Measured {
    const box: PartBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    let h = 0;
    const back = c.side === "back", [ox, oy] = this.origin, t = this.thickness;
    for (let i = 0; i < pos.length; i += 3) {
      const [lx, ly] = toFootprint(c, [pos[i] + ox, oy - pos[i + 1]]);
      if (lx < box.x0) box.x0 = lx; if (lx > box.x1) box.x1 = lx; if (ly < box.y0) box.y0 = ly; if (ly > box.y1) box.y1 = ly;
      const z = back ? -t - pos[i + 2] : pos[i + 2];
      if (z > h) h = z;
    }
    const r = (v: number) => Math.round(v * 1e3) / 1e3;
    return { key: `${modelKey}|${c.side}`, box: { x0: r(box.x0), y0: r(box.y0), x1: r(box.x1), y1: r(box.y1) }, height: r(h) };
  }
  /** A model was fetched (or turned out to be missing): redraw the parts that were waiting for it. */
  private modelsArrived(): void {
    if (this.disposed || !this.reader) return;
    let any = false;
    for (const c of this.reader.components()) { const p = this.parts.get(c.id); if (p && p.modelKey !== this.modelKey(c)) { this.drawPart(c); any = true; } }
    if (any) this.viewport.invalidate();
  }

  /** Resolves when every part model asked for so far has arrived or turned out to be missing (tests wait on it). */
  async modelsSettled(): Promise<void> { if (this.store) await this.store.settled(); }

  // ---------------------------------------------------------------- the laminate and its faces
  private settle(): void {
    clearTimeout(this.timer); this.timer = 0;
    if (this.disposed || !this.reader) return;
    if (this.slabDirty) this.buildSlab();
    this.viewport.invalidate();
  }

  private buildSlab(): void {
    const reader = this.reader!, t0 = now();
    this.slabDirty = false;
    const shape = boardShape(reader.doc), holes = boardHoles(reader.doc);
    const { perOutline, rest } = assignHoles(shape, holes);
    this.painted = rest;
    const max = Math.min(this.viewport.renderer.capabilities.maxTextureSize || 4096, 8192);
    const e = textureExtent(shape.bbox, max, FACE_BUDGET);
    const resized = !this.extent || this.extent.width !== e.width || this.extent.height !== e.height || this.extent.x0 !== e.x0 || this.extent.y0 !== e.y0;
    this.extent = e;
    const [ox, oy] = this.origin;
    const uvOf = (p: Pt): [number, number] => [(p[0] + ox - e.x0) / e.w, 1 - ((oy - p[1]) - e.y0) / e.h];
    const g = slabGeometries(shape, perOutline, this.thickness, this.toModel, uvOf);
    for (const m of this.slab) { this.inner.remove(m); m.geometry.dispose(); if (!m.userData.face) (m.material as THREE.Material).dispose(); }
    this.slab = [];
    const phong = (o: THREE.MeshPhongMaterialParameters) => new THREE.MeshPhongMaterial({ shininess: 18, specular: new THREE.Color(0x222222), ...o });
    if (resized) { for (const side of ["F", "B"] as Side[]) { const f = this.faces[side]; if (f) { f.texture.dispose(); (f.mesh.material as THREE.Material).dispose(); f.canvas.width = f.canvas.height = 1; this.faces[side] = null; } } this.faceDirty.F = this.faceDirty.B = true; }
    for (const side of ["F", "B"] as Side[]) {
      const geo = side === "F" ? g.top : g.bottom; if (!geo) continue;
      let f = this.faces[side];
      if (!f) {
        const canvas = document.createElement("canvas"); canvas.width = e.width; canvas.height = e.height;
        const ctx = canvas.getContext("2d");
        if (ctx) { const c = layerColor("maskTop"); ctx.fillStyle = `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`; ctx.fillRect(0, 0, e.width, e.height); }
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = Math.min(8, this.viewport.renderer.capabilities.getMaxAnisotropy());
        const mesh = new THREE.Mesh(geo, phong({ map: texture, shininess: 30, side: THREE.DoubleSide }));
        f = this.faces[side] = { mesh, canvas, texture };
      } else f.mesh.geometry = geo;
      f.mesh.userData.face = true; f.mesh.userData.fit = true; f.mesh.name = side === "F" ? "board-front" : "board-back";
      this.inner.add(f.mesh); this.slab.push(f.mesh);
    }
    if (g.edge) { const m = new THREE.Mesh(g.edge, phong({ vertexColors: true })); m.name = "board-edge"; this.inner.add(m); this.slab.push(m); }
    if (g.barrels) { const m = new THREE.Mesh(g.barrels, phong({ vertexColors: true, shininess: 60, specular: new THREE.Color(0x554422) })); m.name = "board-barrels"; this.inner.add(m); this.slab.push(m); }
    this.stats.slabMs = now() - t0; this.stats.slabBuilds++;
  }

  /**
   * Compose one stale face image, and come back for the other: a face is the costliest thing here (every layer
   * of the board painted again), so the two are separate tasks and edits arriving between them are not held up.
   */
  private composeNext(): void {
    clearTimeout(this.faceTimer); this.faceTimer = 0;
    const reader = this.reader, e = this.extent;
    if (this.disposed || !reader || !e) return;
    if (this.slabDirty) { this.faceTimer = window.setTimeout(() => this.composeNext(), SETTLE_MS); return; }   // the laminate first: it may resize the images
    const side: Side | null = this.faceDirty.F ? "F" : this.faceDirty.B ? "B" : null;
    if (!side) return;
    this.faceDirty[side] = false;
    const f = this.faces[side];
    if (f) {
      const t0 = now();
      let composer: FaceComposer | null = null;
      try { composer = new FaceComposer(reader.doc, e); composer.compose(side, FACE_LAYERS, this.painted, f.canvas); f.texture.needsUpdate = true; }
      catch (err) { console.warn("a board face could not be drawn", err); }
      if (composer) composer.dispose();
      this.stats.facesMs = now() - t0; this.stats.faceBuilds++; if (side === "B") this.stats.backBuilds++;
      this.viewport.invalidate();
    }
    if (this.faceDirty.F || this.faceDirty.B) this.faceTimer = window.setTimeout(() => this.composeNext(), 30);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer); clearTimeout(this.faceTimer);
    if (this.stopModels) this.stopModels();
    this.viewport.scene.remove(this.group);
    for (const p of this.parts.values()) p.mesh.geometry.dispose();
    this.parts.clear();
    this.partMaterial.dispose();
    for (const m of this.slab) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    for (const side of ["F", "B"] as Side[]) { const f = this.faces[side]; if (f) { f.texture.dispose(); f.canvas.width = f.canvas.height = 1; } }
    this.viewport.invalidate();
  }
}
