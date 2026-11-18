// viewer3d/scene.ts — the three.js objects of one board: the body (the Edge.Cuts outline with its
// cut-outs and drilled holes, extruded to the stackup thickness), the two faces carrying the composed
// layer images (textures.ts), the hole barrels and the placeholder component bodies (bodies.ts).
//
// Everything is merged into a handful of meshes — two faces, the board edge, the barrels and one mesh
// per body class — so a board with thousands of tracks and holes is still half a dozen draw calls.
//
// Model space: millimetres, X right, Y up (the document's Y is down, so it is negated), Z towards the
// viewer of the front side; the board is centred on the origin with its front face at z = 0.
import * as THREE from "three";
import { Body, BodyClass, boardBodies } from "./bodies";
import { ModelRef, ModelStore, placeMesh } from "./models";
import { EXTRA_LAYERS, RGBA, colorStamp, layerColor } from "./colors";
import { BoardShape, Hole, Pt, assignHoles, boardHoles, boardShape, polyArea } from "./outline";
import { FaceComposer, FaceLayers, Side, TextureExtent, textureExtent } from "./textures";

/** The rows of the Appearance panel (KiCad: 3d-viewer/dialogs/appearance_controls_3D.cpp). */
export interface Visibility {
  board: boolean; barrels: boolean; copperTop: boolean; copperBottom: boolean; paste: boolean;
  /** the inner copper layers (APPEARANCE_CONTROLS_3D Show / Hide All Inner Layers); not drawn by the web viewer */
  copperInner?: boolean;
  silkTop: boolean; silkBottom: boolean; maskTop: boolean; maskBottom: boolean;
  tht: boolean; smd: boolean; virtual: boolean;
  /** LAYER_3D_MODELS_NOT_IN_POS ("Models not in POS File") and LAYER_3D_MODELS_MARKED_DNP ("Models marked DNP") */
  notInPos: boolean; dnp: boolean;
  /** EDA_3D_ACTIONS::toggleShowMissingModels: the stand-in solids of parts whose model is missing */
  missing: boolean;
  /** LAYER_3D_BOUNDING_BOXES ("Model Bounding Boxes") */
  bbox: boolean;
  /** the extra board layers shown (colors.ts EXTRA_LAYERS keys: Adhesive, User.Drawings … User.45) */
  extra: string[];
}

export const DEFAULT_VISIBILITY: Visibility = {
  board: true, barrels: true, copperTop: true, copperBottom: true, paste: true,
  silkTop: true, silkBottom: true, maskTop: true, maskBottom: true,
  tht: true, smd: true, virtual: true,
  // render.show_footprints_not_in_posfile true, render.show_footprints_dnp false, render.opengl_show_model_bbox false;
  // render.show_missing_models is false in KiCad, whose placeholder is a bare box: the web's stand-ins are on
  notInPos: true, dnp: false, missing: true, bbox: false,
  extra: EXTRA_LAYERS.filter((l) => l.on).map((l) => l.key),
};

export interface BoardStats { outlines: number; cutouts: number; holes: number; holesPainted: number; bodies: number; models: number; missingModels: string[]; replacedModels: string[]; generatedModels?: string[]; fallbackOutline: boolean; texture: [number, number]; thickness: number }

/** Accumulates indexed triangles with per-vertex normals, colours and (optionally) texture coordinates. */
class MeshData {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; uv: number[] = []; idx: number[] = [];
  private tmp = new THREE.Color();

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, c?: RGBA, u?: number, v?: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z); this.nrm.push(nx, ny, nz);
    if (c) { this.tmp.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace); this.col.push(this.tmp.r, this.tmp.g, this.tmp.b); }
    if (u !== undefined && v !== undefined) this.uv.push(u, v);
    return i;
  }

  /** A triangle wound so that it faces (nx, ny, nz). */
  tri(a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
    const p = this.pos; const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az, vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
    const d = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    if (d >= 0) this.idx.push(a, b, c); else this.idx.push(a, c, b);
  }

  get empty(): boolean { return this.idx.length === 0; }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    if (this.col.length) g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    if (this.uv.length) g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** A vertical wall along a closed loop (model XY), facing outwards from the loop or into it. */
function wall(m: MeshData, loop: Pt[], zTop: number, zBot: number, color: RGBA, inward: boolean, smoothAbout?: Pt): void {
  const ccw = polyArea(loop) > 0; const n = loop.length;
  // for a counter-clockwise loop the outside is to the right of the direction of travel
  const sign = (ccw ? 1 : -1) * (inward ? -1 : 1);
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n]; const dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy); if (l < 1e-9) continue;
    const fx = sign * dy / l, fy = -sign * dx / l;
    let nax = fx, nay = fy, nbx = fx, nby = fy;
    if (smoothAbout) {   // a round barrel: shade it smoothly with radial normals
      const ra = Math.hypot(a[0] - smoothAbout[0], a[1] - smoothAbout[1]) || 1, rb = Math.hypot(b[0] - smoothAbout[0], b[1] - smoothAbout[1]) || 1;
      const k = inward ? -1 : 1;
      nax = k * (a[0] - smoothAbout[0]) / ra; nay = k * (a[1] - smoothAbout[1]) / ra; nbx = k * (b[0] - smoothAbout[0]) / rb; nby = k * (b[1] - smoothAbout[1]) / rb;
    }
    const v0 = m.vertex(a[0], a[1], zTop, nax, nay, 0, color), v1 = m.vertex(b[0], b[1], zTop, nbx, nby, 0, color);
    const v2 = m.vertex(b[0], b[1], zBot, nbx, nby, 0, color), v3 = m.vertex(a[0], a[1], zBot, nax, nay, 0, color);
    m.tri(v0, v1, v2, fx, fy, 0); m.tri(v0, v2, v3, fx, fy, 0);
  }
}

function triangulate(contour: Pt[], holes: Pt[][]): number[][] {
  const c2 = contour.map((p) => new THREE.Vector2(p[0], p[1])), h2 = holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
  return THREE.ShapeUtils.triangulateShape(c2, h2);
}

/** A flat cap over a polygon with holes at height z, facing +Z (up = true) or −Z; `faces` reuses a triangulation of the same loops. */
function cap(m: MeshData, contour: Pt[], holes: Pt[][], z: number, up: boolean, color: RGBA | undefined, uvOf?: (p: Pt) => [number, number], faces = triangulate(contour, holes)): void {
  const all: Pt[] = contour.concat(...holes);
  const base = m.pos.length / 3; const nz = up ? 1 : -1;
  for (const p of all) { const t = uvOf ? uvOf(p) : undefined; m.vertex(p[0], p[1], z, 0, 0, nz, color, t ? t[0] : undefined, t ? t[1] : undefined); }
  for (const f of faces) m.tri(base + f[0], base + f[1], base + f[2], 0, 0, nz);
}

/** The inward offset of a convex loop by d (null when the loop is not convex enough to shrink cleanly). */
function insetLoop(loop: Pt[], d: number): Pt[] | null {
  const n = loop.length; if (n < 3 || d <= 0) return null;
  const ccw = polyArea(loop) > 0; const out: Pt[] = [];
  const nrm = (a: Pt, b: Pt): Pt => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return ccw ? [-dy / l, dx / l] : [dy / l, -dx / l]; };
  for (let i = 0; i < n; i++) {
    const p = loop[i], n1 = nrm(loop[(i + n - 1) % n], p), n2 = nrm(p, loop[(i + 1) % n]);
    const k = 1 + n1[0] * n2[0] + n1[1] * n2[1]; if (k < 0.2) return null;
    out.push([p[0] + d * (n1[0] + n2[0]) / k, p[1] + d * (n1[1] + n2[1]) / k]);
  }
  return polyArea(out) * polyArea(loop) > 0 ? out : null;
}

/** A vertical prism from z0 (on the board) to z1 (its top; sgn: the direction the part grows), the top edge bevelled by `bevel`. */
function prismSolid(m: MeshData, loop: Pt[], z0: number, z1: number, sgn: number, color: RGBA, round: boolean, bevel: number): void {
  if (loop.length < 3 || Math.abs(z1 - z0) < 1e-6) { if (loop.length >= 3) cap(m, loop, [], z1, sgn > 0, color); return; }
  let centre: Pt | undefined;
  if (round) { let sx = 0, sy = 0; for (const p of loop) { sx += p[0]; sy += p[1]; } centre = [sx / loop.length, sy / loop.length]; }
  const b = Math.min(bevel, Math.abs(z1 - z0) * 0.45);
  const inner = b > 0.01 ? insetLoop(loop, b) : null;
  if (!inner) { wall(m, loop, z1, z0, color, false, centre); cap(m, loop, [], z1, sgn > 0, color); return; }
  const zb = z1 - sgn * b;
  wall(m, loop, zb, z0, color, false, centre);
  // the bevel band: outward and up, half and half
  const ccw = polyArea(loop) > 0, n = loop.length, k = Math.SQRT1_2;
  for (let i = 0; i < n; i++) {
    const a = loop[i], c = loop[(i + 1) % n], ia = inner[i], ic = inner[(i + 1) % n];
    const dx = c[0] - a[0], dy = c[1] - a[1], l = Math.hypot(dx, dy); if (l < 1e-9) continue;
    let ox = (ccw ? dy : -dy) / l, oy = (ccw ? -dx : dx) / l;
    let ax = ox, ay = oy, cx = ox, cy = oy;
    if (centre) { const ra = Math.hypot(a[0] - centre[0], a[1] - centre[1]) || 1, rc = Math.hypot(c[0] - centre[0], c[1] - centre[1]) || 1; ax = (a[0] - centre[0]) / ra; ay = (a[1] - centre[1]) / ra; cx = (c[0] - centre[0]) / rc; cy = (c[1] - centre[1]) / rc; }
    const v0 = m.vertex(a[0], a[1], zb, ax * k, ay * k, sgn * k, color), v1 = m.vertex(c[0], c[1], zb, cx * k, cy * k, sgn * k, color);
    const v2 = m.vertex(ic[0], ic[1], z1, cx * k, cy * k, sgn * k, color), v3 = m.vertex(ia[0], ia[1], z1, ax * k, ay * k, sgn * k, color);
    ox *= k; oy *= k;
    m.tri(v0, v1, v2, ox, oy, sgn * k); m.tri(v0, v2, v3, ox, oy, sgn * k);
  }
  cap(m, inner, [], z1, sgn > 0, color);
}

/** A horizontal cylinder from a to b (model XY) with its axis at height z, smooth-shaded, both ends capped. */
function cylinderSolid(m: MeshData, a: Pt, b: Pt, r: number, z: number, color: RGBA, seg = 18): void {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); if (l < 1e-6 || r <= 0) return;
  const ux = dx / l, uy = dy / l, px = -uy, py = ux;   // axis and the horizontal perpendicular
  const ring = (c: Pt): number[] => { const ids: number[] = []; for (let i = 0; i < seg; i++) { const t = 2 * Math.PI * i / seg, ct = Math.cos(t), st = Math.sin(t); ids.push(m.vertex(c[0] + r * ct * px, c[1] + r * ct * py, z + r * st, ct * px, ct * py, st, color)); } return ids; };
  const ra = ring(a), rb = ring(b);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg, t = 2 * Math.PI * (i + 0.5) / seg, nx = Math.cos(t) * px, ny = Math.cos(t) * py, nz = Math.sin(t);
    m.tri(ra[i], rb[i], rb[j], nx, ny, nz); m.tri(ra[i], rb[j], ra[j], nx, ny, nz);
  }
  for (const [c, sgn] of [[a, -1], [b, 1]] as [Pt, number][]) {
    const mid = m.vertex(c[0], c[1], z, sgn * ux, sgn * uy, 0, color); const ids: number[] = [];
    for (let i = 0; i < seg; i++) { const t = 2 * Math.PI * i / seg; ids.push(m.vertex(c[0] + r * Math.cos(t) * px, c[1] + r * Math.cos(t) * py, z + r * Math.sin(t), sgn * ux, sgn * uy, 0, color)); }
    for (let i = 0; i < seg; i++) m.tri(mid, ids[i], ids[(i + 1) % seg], sgn * ux, sgn * uy, 0);
  }
}

/**
 * A section swept horizontally from a to b (model XY).  `outer` is the section as [offset across the axis,
 * z] pairs; `inner` (point for point) hollows it into a tube whose inside is drawn too.  Ends are closed
 * on request: a ring between the two loops when hollow, the whole section otherwise.
 */
function sweepSolid(m: MeshData, a: Pt, b: Pt, outer: Pt[], inner: Pt[] | null, color: RGBA, smooth: boolean, capA: boolean, capB: boolean): void {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); if (l < 1e-6 || outer.length < 3) return;
  const ux = dx / l, uy = dy / l, px = -uy, py = ux;
  const at = (c: Pt, p: Pt): [number, number, number] => [c[0] + p[0] * px, c[1] + p[0] * py, p[1]];
  const skin = (loop: Pt[], out: number): void => {
    const n = loop.length; let cu = 0, cz = 0; for (const p of loop) { cu += p[0]; cz += p[1]; } cu /= n; cz /= n;
    // each edge's normal in the section plane, pointing away from the middle of the loop (towards it for the inside of a tube)
    const en: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const p = loop[i], q = loop[(i + 1) % n]; let nu = q[1] - p[1], nz = -(q[0] - p[0]); const ln = Math.hypot(nu, nz) || 1; nu /= ln; nz /= ln;
      if (nu * ((p[0] + q[0]) / 2 - cu) + nz * ((p[1] + q[1]) / 2 - cz) < 0) { nu = -nu; nz = -nz; }
      en.push([nu * out, nz * out]);
    }
    const vn = (i: number, e: number): Pt => {
      if (!smooth) return en[e];
      const p = en[(i + n - 1) % n], q = en[i]; const su = p[0] + q[0], sz = p[1] + q[1], ln = Math.hypot(su, sz);
      return ln < 0.2 ? en[e] : [su / ln, sz / ln];
    };
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, p = loop[i], q = loop[j], np = vn(i, i), nq = vn(j, i), f = en[i];
      const pa = at(a, p), qa = at(a, q), pb = at(b, p), qb = at(b, q);
      const v0 = m.vertex(pa[0], pa[1], pa[2], np[0] * px, np[0] * py, np[1], color), v1 = m.vertex(qa[0], qa[1], qa[2], nq[0] * px, nq[0] * py, nq[1], color);
      const v2 = m.vertex(qb[0], qb[1], qb[2], nq[0] * px, nq[0] * py, nq[1], color), v3 = m.vertex(pb[0], pb[1], pb[2], np[0] * px, np[0] * py, np[1], color);
      m.tri(v0, v1, v2, f[0] * px, f[0] * py, f[1]); m.tri(v0, v2, v3, f[0] * px, f[0] * py, f[1]);
    }
  };
  skin(outer, 1);
  if (inner && inner.length === outer.length) skin(inner, -1);
  for (const [c, sgn, on] of [[a, -1, capA], [b, 1, capB]] as [Pt, number, boolean][]) {
    if (!on) continue;
    const nx = sgn * ux, ny = sgn * uy, n = outer.length;
    const ring = (loop: Pt[]): number[] => loop.map((p) => { const v = at(c, p); return m.vertex(v[0], v[1], v[2], nx, ny, 0, color); });
    const o = ring(outer);
    if (inner && inner.length === n) { const i2 = ring(inner); for (let i = 0; i < n; i++) { const j = (i + 1) % n; m.tri(o[i], o[j], i2[j], nx, ny, 0); m.tri(o[i], i2[j], i2[i], nx, ny, 0); } }
    else {
      let cu = 0, cz = 0; for (const p of outer) { cu += p[0]; cz += p[1]; }
      const v = at(c, [cu / n, cz / n]), mid = m.vertex(v[0], v[1], v[2], nx, ny, 0, color);
      for (let i = 0; i < n; i++) m.tri(mid, o[i], o[(i + 1) % n], nx, ny, 0);
    }
  }
}

function material(opts: THREE.MeshPhongMaterialParameters): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial(Object.assign({ shininess: 18, specular: new THREE.Color(0x222222) }, opts));
}

/** Everything the board meshes depend on, as a string: two documents with equal signatures share geometry. */
function shapeSignature(shape: BoardShape, holes: Hole[], thickness: number): string {
  const f = (v: number) => Math.round(v * 1e4);
  const parts: (number | string)[] = [f(thickness)];
  for (const o of shape.outlines) { parts.push("o"); for (const p of o.contour) parts.push(f(p[0]), f(p[1])); for (const c of o.cutouts) { parts.push("c"); for (const p of c) parts.push(f(p[0]), f(p[1])); } }
  for (const h of holes) parts.push("h", f(h.x), f(h.y), f(h.r), h.pts.length, h.plated ? 1 : 0);
  return parts.join(",");
}

/** The axis-aligned box of the vertices `m` gained from float offset `from` on, as 12 line segments into `out` (Model Bounding Boxes). */
function boxOf(out: MeshData, m: MeshData, from: number): void {
  if (m.pos.length <= from) return;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = from; i < m.pos.length; i += 3) { const x = m.pos[i], y = m.pos[i + 1], z = m.pos[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (let i = 0; i < 4; i++) { const [ax, ay] = c[i], [bx, by] = c[(i + 1) % 4];
    out.pos.push(ax, ay, z0, bx, by, z0, ax, ay, z1, bx, by, z1, ax, ay, z0, ax, ay, z1); }
}

/**
 * The laminate as triangles: the two faces (with texture coordinates from `uvOf`), the edge with the walls of
 * cut-outs and unplated holes, and the plated barrels.  Front face at z = 0, back at −thickness.
 */
function slabInto(out: { top: MeshData; bottom: MeshData; edge: MeshData; barrels: MeshData }, shape: BoardShape, perOutline: Hole[][], thickness: number, toModel: (p: Pt) => Pt, uvOf: (p: Pt) => [number, number]): { cutouts: number; drilled: number } {
  let cutouts = 0, drilled = 0;
  shape.outlines.forEach((o, i) => {
    const contour = o.contour.map(toModel); const cuts = o.cutouts.map((c) => c.map(toModel)); cutouts += cuts.length;
    const drills = perOutline[i]; drilled += drills.length;
    const holeLoops = cuts.concat(drills.map((h) => h.pts.map(toModel)));
    const faces = triangulate(contour, holeLoops);   // the costly step on a board with thousands of holes: once for both faces
    cap(out.top, contour, holeLoops, 0, true, undefined, uvOf, faces);
    cap(out.bottom, contour, holeLoops, -thickness, false, undefined, uvOf, faces);
    wall(out.edge, contour, 0, -thickness, layerColor("board"), false);
    for (const c of cuts) wall(out.edge, c, 0, -thickness, layerColor("board"), true);
    for (const h of drills) {
      const loop = h.pts.map(toModel); const centre = toModel([h.x, h.y]);
      if (h.plated) wall(out.barrels, loop, 0, -thickness, layerColor("copper"), true, centre);
      else wall(out.edge, loop, 0, -thickness, layerColor("board"), true, centre);
    }
  });
  return { cutouts, drilled };
}

/** The laminate of a board as four geometries (null when empty), for a caller that draws the board itself (exports/board3d.ts). */
export function slabGeometries(shape: BoardShape, perOutline: Hole[][], thickness: number, toModel: (p: Pt) => Pt, uvOf: (p: Pt) => [number, number]): { top: THREE.BufferGeometry | null; bottom: THREE.BufferGeometry | null; edge: THREE.BufferGeometry | null; barrels: THREE.BufferGeometry | null } {
  const d = { top: new MeshData(), bottom: new MeshData(), edge: new MeshData(), barrels: new MeshData() };
  slabInto(d, shape, perOutline, thickness, toModel, uvOf);
  const g = (m: MeshData) => (m.empty ? null : m.geometry());
  return { top: g(d.top), bottom: g(d.bottom), edge: g(d.edge), barrels: g(d.barrels) };
}

/** A footprint's loaded models, placed as KiCad's viewer places them, added to `m`; false when none has loaded. */
function addBodyModels(m: MeshData, body: Body, models: ModelStore | null, toModel: (p: Pt) => Pt, thickness: number, lift: number): boolean {
  if (!models) return false;
  let drawn = false; const [px, py] = toModel([body.x, body.y]);
  const at = { x: px, y: py, z: body.back ? -thickness - lift : lift, rot: body.rot, back: body.back };
  for (const ref of body.models) {
    const mesh = models.get(ref.url); if (!mesh || mesh === "missing") continue;
    const base = m.pos.length / 3; const c: RGBA = [0, 0, 0, 1];
    placeMesh(mesh, ref, at, (x, y, z, nx, ny, nz, i) => { c[0] = mesh.col[i * 3]; c[1] = mesh.col[i * 3 + 1]; c[2] = mesh.col[i * 3 + 2]; m.vertex(x, y, z, nx, ny, nz, c); });
    // a mirror in the model's scale turns its triangles inside out
    const flip = ref.scale[0] * ref.scale[1] * ref.scale[2] < 0;
    for (let i = 0; i < mesh.idx.length; i += 3) m.idx.push(base + mesh.idx[i], base + mesh.idx[i + (flip ? 2 : 1)], base + mesh.idx[i + (flip ? 1 : 2)]);
    drawn = true;
  }
  return drawn;
}

/** A footprint's stand-in solids (parts.ts), or the plain prism over its outline, added to `m`. */
function addBodySolids(m: MeshData, body: Body, toModel: (p: Pt) => Pt, thickness: number, lift: number): void {
  if (body.solids && body.solids.length) {
    // heights are from the face the part sits on: up from the front, down from the back
    const sgn = body.back ? -1 : 1, zOf = (h: number) => (body.back ? -thickness - lift - h : lift + h);
    for (const so of body.solids) {
      if (so.k === "prism") prismSolid(m, so.pts.map(toModel), zOf(so.z0), zOf(so.z1), sgn, so.color, !!so.round, so.bevel || 0);
      else if (so.k === "sweep") { const sec = (loop: Pt[]): Pt[] => loop.map((p) => [p[0], zOf(p[1])] as Pt); sweepSolid(m, toModel(so.a), toModel(so.b), sec(so.outer), so.inner ? sec(so.inner) : null, so.color, !!so.smooth, !!so.capA, !!so.capB); }
      else cylinderSolid(m, toModel(so.a), toModel(so.b), so.r, zOf(so.z), so.color);
    }
    return;
  }
  const pts = body.pts.map(toModel);
  const z0 = body.back ? -thickness - lift : lift, z1 = body.back ? -thickness - lift - body.height : lift + body.height;
  const round = pts.length > 8; let centre: Pt | undefined;
  if (round) { let sx = 0, sy = 0; for (const p of pts) { sx += p[0]; sy += p[1]; } centre = [sx / pts.length, sy / pts.length]; }
  wall(m, pts, z0, z1, body.color, false, centre);
  cap(m, pts, [], z1, !body.back, body.color);
  cap(m, pts, [], z0, body.back, body.color);
}

/** The triangles of one part, on its own: what the merged class meshes of a BoardScene are made of. */
export interface PartTriangles { positions: Float32Array; normals: Float32Array; colors: Float32Array; indices: Uint32Array; /** drawn from the part's real 3D model, not a stand-in */ real: boolean }

/**
 * One part as triangles in the scene's model space (front face of the board at z = 0, back at −thickness, parts
 * `lift` above the laminate): its loaded 3D model when `models` has one, the stand-in solids otherwise.  For a
 * caller that keeps a mesh per footprint instead of BoardScene's merged ones (exports/board3d.ts).
 */
export function partTriangles(body: Body, thickness: number, models: ModelStore | null, toModel: (p: Pt) => Pt = (p) => p, lift = 0.04): PartTriangles {
  const m = new MeshData();
  const real = addBodyModels(m, body, models, toModel, thickness, lift);
  if (!real) addBodySolids(m, body, toModel, thickness, lift);
  return { positions: new Float32Array(m.pos), normals: new Float32Array(m.nrm), colors: new Float32Array(m.col), indices: new Uint32Array(m.idx), real };
}

export class BoardScene {
  readonly group = new THREE.Group();
  readonly stats: BoardStats;
  /** half extents of the board in model space, for fitting the camera */
  readonly size: { w: number; h: number; t: number };
  private composer: FaceComposer;
  private extent: TextureExtent;
  private painted: Hole[];
  private faceCanvas: Record<Side, HTMLCanvasElement | null> = { F: null, B: null };
  private texture: Record<Side, THREE.CanvasTexture | null> = { F: null, B: null };
  private faces: Record<Side, THREE.Mesh | null> = { F: null, B: null };
  private edge: THREE.Mesh | null = null;
  private barrels: THREE.Mesh | null = null;
  private bodies: Record<BodyClass, THREE.Mesh | null> = { tht: null, smd: null, virtual: null };
  private bboxMesh: THREE.LineSegments | null = null;
  private faceKey: Record<Side, string> = { F: "", B: "" };
  private signature = "";
  private released = false;
  private bodyList: Body[] = [];
  private toModel: (p: Pt) => Pt = (p) => p;
  private thickness = 1.6;
  /** Where the board file's origin (0, 0) is in this scene: what places solids given in board coordinates (Viewer.setExtras). */
  origin(): Pt { return this.toModel([0, 0]); }
  private models: ModelStore | null = null;
  private vis: Visibility;
  /** true when this scene took its board meshes from the one it replaced (tests) */
  readonly reusedGeometry: boolean;

  /** `prev` is the scene being replaced: its board meshes are taken over when outline and holes are unchanged. */
  constructor(doc: KDoc, maxTextureSize: number, anisotropy: number, vis: Visibility, prev?: BoardScene | null, models?: ModelStore | null) {
    const thickness = Math.max(0.1, Number((doc as KDoc & { thickness?: number }).thickness) || 1.6);
    const shape: BoardShape = boardShape(doc);
    const holes = boardHoles(doc);
    const { perOutline, rest } = assignHoles(shape, holes);
    this.painted = rest;
    const b = shape.bbox; const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    this.size = { w: b[2] - b[0], h: b[3] - b[1], t: thickness };
    const toModel = (p: Pt): Pt => [p[0] - cx, cy - p[1]];
    this.extent = textureExtent(b, Math.min(maxTextureSize, 8192));
    const e = this.extent;
    // texture coordinates of a model point: the face images are drawn in document space (Y down), CanvasTexture flips Y
    const uvOf = (p: Pt): [number, number] => [(p[0] + cx - e.x0) / e.w, 1 - ((cy - p[1]) - e.y0) / e.h];
    this.composer = new FaceComposer(doc, e);

    // An edit that leaves the outline and the drills alone (most do: a track, a zone, silkscreen) keeps the
    // board's meshes; only the face images are composed again.
    this.signature = shapeSignature(shape, holes, thickness);
    const reuse = prev && prev.signature === this.signature ? prev.releaseGeometry() : null;
    const top = new MeshData(), bottom = new MeshData(), edge = new MeshData(), barrels = new MeshData();
    let cutouts = 0, drilled = 0;
    if (reuse) { cutouts = prev ? prev.stats.cutouts : 0; drilled = prev ? prev.stats.holes : 0; }
    else { const n = slabInto({ top, bottom, edge, barrels }, shape, perOutline, thickness, toModel, uvOf); cutouts = n.cutouts; drilled = n.drilled; }

    for (const side of ["F", "B"] as Side[]) {
      const data = side === "F" ? top : bottom; const geometry = reuse ? reuse[side] : data.empty ? null : data.geometry(); if (!geometry) continue;
      const canvas = this.composer.compose(side, this.faceLayers(side, vis), this.painted);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = Math.max(1, Math.min(8, anisotropy)); tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
      this.faceCanvas[side] = canvas; this.texture[side] = tex; this.faceKey[side] = JSON.stringify(this.faceLayers(side, vis));
      // drawn from both sides: the triangulator drops collinear outline points, and the hairline cracks that
      // leaves along long edges then show the inside of the opposite face instead of the bright background
      const mesh = new THREE.Mesh(geometry, material({ map: tex, alphaTest: 0.02, shininess: 30, specular: new THREE.Color(0x2a2a2a), side: THREE.DoubleSide }));
      mesh.name = side === "F" ? "face-front" : "face-back";
      this.faces[side] = mesh; this.group.add(mesh);
    }
    const edgeGeo = reuse ? reuse.edge : edge.empty ? null : edge.geometry(), barrelGeo = reuse ? reuse.barrels : barrels.empty ? null : barrels.geometry();
    if (edgeGeo) { this.edge = new THREE.Mesh(edgeGeo, material({ vertexColors: true })); this.edge.name = "board-edge"; this.group.add(this.edge); }
    if (barrelGeo) { this.barrels = new THREE.Mesh(barrelGeo, material({ vertexColors: true, shininess: 60, specular: new THREE.Color(0x554422) })); this.barrels.name = "barrels"; this.group.add(this.barrels); }

    this.bodyList = boardBodies(doc, true); this.toModel = toModel; this.thickness = thickness; this.models = models || null; this.vis = vis;
    this.stats = { outlines: shape.outlines.length, cutouts, holes: drilled, holesPainted: rest.length, bodies: this.bodyList.length, models: 0, missingModels: [], replacedModels: [],
      fallbackOutline: shape.fallback, texture: [e.width, e.height], thickness };
    this.reusedGeometry = !!reuse;
    this.buildBodies();
    this.applyVisibility(vis, false);
  }

  /** Every model the board's footprints name (for ModelStore.want). */
  modelRefs(): ModelRef[] { const out: ModelRef[] = []; for (const b of this.bodyList) out.push(...b.models); return out; }

  /** Change where models come from (null: stand-ins only) and draw the parts again. */
  useStore(models: ModelStore | null): void { this.models = models; this.refreshBodies(); }

  /** Draw the parts again: with the real model where one has loaded, the stand-in solids otherwise. Called when models arrive. */
  refreshBodies(): void { this.buildBodies(); this.applyVisibility(this.vis, false); }

  private buildBodies(): void {
    for (const cls of ["tht", "smd", "virtual"] as BodyClass[]) {
      const old = this.bodies[cls]; if (!old) continue;
      this.group.remove(old); old.geometry.dispose(); (old.material as THREE.Material).dispose(); this.bodies[cls] = null;
    }
    const data: Record<BodyClass, MeshData> = { tht: new MeshData(), smd: new MeshData(), virtual: new MeshData() };
    const lift = 0.04;   // parts sit on the pads, a copper-and-mask thickness above the laminate
    let real = 0; const missing: string[] = []; const replaced: string[] = []; const generated: string[] = [];
    const v = this.vis, bbox = new MeshData();
    for (const body of this.bodyList) {
      if ((body.dnp && !v.dnp) || (body.notInPos && !v.notInPos)) continue;
      const m = data[body.cls], at = m.pos.length;
      if (this.addModels(m, body, lift)) {
        real++;
        // drawn with a model other than the one its footprint (or, when it names none, its own name) asks for
        if (this.models && body.models.some((r) => { const mm = this.models!.get(r.url); return !!mm && mm !== "missing" && this.models!.replacement(r.url) !== undefined; })) replaced.push(body.ref);
        if (v.bbox) boxOf(bbox, m, at);
        continue;
      }
      // no model named, or none of those named can be had (still on their way does not count as missing)
      const isMissing = !body.models.length || (!!this.models && body.models.every((r) => this.models!.get(r.url) === "missing"));
      // then a model drawn from the footprint itself (server/src/modelgen), before the stand-in
      if (isMissing && this.models && body.gen) {
        const g = this.models.get(body.gen.url);
        if (g === undefined) this.models.want([body.gen]);
        else if (g !== "missing" && this.addModels(m, { ...body, models: [body.gen] }, lift)) { real++; generated.push(body.ref); if (v.bbox) boxOf(bbox, m, at); continue; }
      }
      if (isMissing) { missing.push(body.ref); if (!v.missing) continue; }
      this.addBody(m, body, this.toModel, this.thickness, lift);
      if (v.bbox) boxOf(bbox, m, at);
    }
    if (this.bboxMesh) { this.group.remove(this.bboxMesh); this.bboxMesh.geometry.dispose(); (this.bboxMesh.material as THREE.Material).dispose(); this.bboxMesh = null; }
    if (bbox.pos.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(bbox.pos, 3));
      // EDA_3D_VIEWER_SETTINGS opengl_selection_color's neighbour: KiCad draws the boxes in a light yellow-green
      this.bboxMesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x00ff00 })); this.bboxMesh.name = "bbox"; this.group.add(this.bboxMesh);
    }
    for (const cls of ["tht", "smd", "virtual"] as BodyClass[]) {
      if (data[cls].empty) continue;
      const mesh = new THREE.Mesh(data[cls].geometry(), material({ vertexColors: true, shininess: 40, specular: new THREE.Color(0x333333) }));
      mesh.name = "bodies-" + cls; this.bodies[cls] = mesh; this.group.add(mesh);
    }
    this.stats.models = real; this.stats.missingModels = missing; this.stats.replacedModels = replaced; this.stats.generatedModels = generated;
  }

  /** The footprint's loaded models, placed as KiCad's viewer places them; false when none has loaded. */
  private addModels(m: MeshData, body: Body, lift: number): boolean { return addBodyModels(m, body, this.models, this.toModel, this.thickness, lift); }

  /** Hand the board's geometries to the scene that replaces this one; dispose() then leaves them alone. */
  private releaseGeometry(): { F: THREE.BufferGeometry | null; B: THREE.BufferGeometry | null; edge: THREE.BufferGeometry | null; barrels: THREE.BufferGeometry | null } {
    this.released = true;
    const g = (m: THREE.Mesh | null) => (m ? m.geometry : null);
    return { F: g(this.faces.F), B: g(this.faces.B), edge: g(this.edge), barrels: g(this.barrels) };
  }

  private addBody(m: MeshData, body: Body, toModel: (p: Pt) => Pt, thickness: number, lift: number): void { addBodySolids(m, body, toModel, thickness, lift); }

  private faceLayers(side: Side, v: Visibility): FaceLayers {
    return side === "F" ? { body: v.board, copper: v.copperTop, mask: v.maskTop, silk: v.silkTop, paste: v.paste, extra: v.extra }
      : { body: v.board, copper: v.copperBottom, mask: v.maskBottom, silk: v.silkBottom, paste: v.paste, extra: v.extra };
  }

  /** Show / hide per the Appearance panel; the face images are recomposed only when their layers changed. */
  applyVisibility(v: Visibility, recompose = true): void {
    const parts = (x: Visibility): string => `${x.notInPos}${x.dnp}${x.missing}${x.bbox}`;
    const rebuild = recompose && parts(v) !== parts(this.vis);
    this.vis = { ...v };
    if (rebuild) this.buildBodies();
    for (const side of ["F", "B"] as Side[]) {
      const mesh = this.faces[side], canvas = this.faceCanvas[side], tex = this.texture[side]; if (!mesh || !canvas || !tex) continue;
      const layers = this.faceLayers(side, v); const key = JSON.stringify(layers) + colorStamp();
      if (recompose && key !== this.faceKey[side]) { this.composer.compose(side, layers, this.painted, canvas); tex.needsUpdate = true; this.faceKey[side] = key; }
      mesh.visible = layers.body || layers.copper || layers.mask || layers.silk || layers.paste || !!(layers.extra && layers.extra.length);
    }
    if (this.edge) this.edge.visible = v.board;
    if (this.barrels) this.barrels.visible = v.barrels;
    for (const cls of ["tht", "smd", "virtual"] as BodyClass[]) { const b = this.bodies[cls]; if (b) b.visible = v[cls]; }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh; if (!mesh.isMesh) return;
      if (!this.released || mesh.name.startsWith("bodies-")) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) mat.dispose();
    });
    for (const side of ["F", "B"] as Side[]) { const t = this.texture[side]; if (t) t.dispose(); const c = this.faceCanvas[side]; if (c) c.width = c.height = 1; }
    this.composer.dispose();
  }
}
