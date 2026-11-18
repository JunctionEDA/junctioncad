// infer.ts — implicit mate connectors: the coordinate system a face, an edge or a vertex of a part offers a mate.
//
// A mate stores which geometry it uses by stable name (a GeomRef); the frame is worked out here from the part's
// tessellation every time the part changes, so a mate follows its part.  What each kind of geometry gives:
//
//   a flat face        its centre (the middle of its extent in the plane), z along the outward normal
//   a cylindrical face the middle of its axis, z along the axis: a hole or a shaft           (radius kept)
//   a circular edge    the circle's centre, z along its axis                                 (radius kept)
//   a straight edge    its midpoint, z along it
//   a vertex           the point, with the part's own axes
//   anything else      the middle of the face or edge, z along the average normal or the chord
//
// The frame is in the part's own space.  It is deterministic: the same geometry always gives the same frame
// (x is the part axis least along z, made perpendicular), so a rebuild that does not move a face does not turn
// a mate.  Pure: no kernel, no three.js; results are cached per mesh.
import type { BodyMesh, GeomRef, Vec3 } from "../../mechanical/api";
import { frameFromAxis } from "../solver/frames";
import { add, addScaled, cross, dot, len, perpendicular, scale, sub, unit } from "../solver/math";
import type { MateFrame } from "../solver/types";

const cache = new WeakMap<BodyMesh, Map<string, MateFrame | null>>();

/** The connector frame of named geometry of a mesh, or null when the mesh has nothing of that name. */
export function connectorOf(mesh: BodyMesh, ref: Pick<GeomRef, "kind" | "name">): MateFrame | null {
  let byName = cache.get(mesh);
  if (!byName) { byName = new Map(); cache.set(mesh, byName); }
  const key = ref.kind + ":" + ref.name;
  if (byName.has(key)) return byName.get(key)!;
  const f = ref.kind === "face" ? faceFrame(mesh, ref.name) : ref.kind === "edge" ? edgeFrame(mesh, ref.name) : vertexFrame(mesh, ref.name);
  const out = f ? tidy(f) : null;
  byName.set(key, out);
  return out;
}

/** What a connector sits on, in a few words, for a dialog. */
export function describeConnector(f: MateFrame, kind: GeomRef["kind"]): string {
  switch (f.surface) {
    case "plane": return "Flat face";
    case "cylinder": return `Cylinder ⌀${fmt(2 * (f.radius || 0))}`;
    case "circle": return `Circular edge ⌀${fmt(2 * (f.radius || 0))}`;
    case "line": return "Straight edge";
    case "point": return "Vertex";
    default: return kind === "face" ? "Face" : kind === "edge" ? "Edge" : "Vertex";
  }
}
const fmt = (v: number): string => String(Math.round(v * 1000) / 1000);

/** Numbers from a float32 mesh carry noise in the seventh digit: round it away so equal things are equal. */
function tidy(f: MateFrame): MateFrame {
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  const ax = (v: Vec3): Vec3 => unit(v.map((c) => (Math.abs(c) < 2e-6 ? 0 : Math.abs(Math.abs(c) - 1) < 2e-6 ? Math.sign(c) : c)) as Vec3);
  const z = ax(f.z);
  let x = ax(f.x); x = unit(addScaled(x, z, -dot(x, z)));
  return { o: [r(f.o[0]), r(f.o[1]), r(f.o[2])], x, y: cross(z, x), z, surface: f.surface, radius: f.radius === undefined ? undefined : r(f.radius) };
}

/** An axis direction with a fixed sense: its largest component is positive. */
function canonical(d: Vec3): Vec3 {
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
  const lead = az >= ax - 1e-9 && az >= ay - 1e-9 ? d[2] : ay >= ax - 1e-9 ? d[1] : d[0];
  return lead < 0 ? scale(d, -1) : d;
}

function faceFrame(mesh: BodyMesh, name: string): MateFrame | null {
  const fi = mesh.faces.names.indexOf(name);
  if (fi < 0) return null;
  const start = mesh.faces.start[fi], count = mesh.faces.count[fi];
  const seen = new Set<number>();
  for (let i = start; i < start + count; i++) seen.add(mesh.indices[i]);
  if (!seen.size) return null;
  const ids = Array.from(seen), P = mesh.positions, N = mesh.normals;
  const pt = (i: number): Vec3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const nm = (i: number): Vec3 => unit([N[i * 3], N[i * 3 + 1], N[i * 3 + 2]]);
  const sum: Vec3 = [0, 0, 0];
  for (const i of ids) { const n = nm(i); sum[0] += n[0]; sum[1] += n[1]; sum[2] += n[2]; }
  const mean = len(sum) > 1e-6 * ids.length ? unit(sum) : null;

  if (mean && ids.every((i) => dot(nm(i), mean) > 1 - 1e-6)) {
    const x = perpendicular(mean), y = cross(mean, x);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, h = 0;
    for (const i of ids) { const p = pt(i), u = dot(p, x), v = dot(p, y); if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; h += dot(p, mean); }
    const o = add(add(scale(x, (u0 + u1) / 2), scale(y, (v0 + v1) / 2)), scale(mean, h / ids.length));
    return { o, x, y, z: mean, surface: "plane" };
  }

  // a cylinder: every normal is at right angles to one direction, and the points are one radius from its line
  const axis = leastDirection(ids.map(nm));
  if (axis) {
    const d = canonical(axis.dir), u = perpendicular(d), v = cross(d, u);
    // p = c + r·n in the plane across the axis: least squares for (cu, cv, r)
    let s11 = 0, s13 = 0, s23 = 0, s33 = 0, b1 = 0, b2 = 0, b3 = 0, t0 = Infinity, t1 = -Infinity;
    for (const i of ids) {
      const p = pt(i), n = nm(i), pu = dot(p, u), pv = dot(p, v), nu = dot(n, u), nv = dot(n, v), t = dot(p, d);
      s11 += 1; s13 += nu; s23 += nv; s33 += nu * nu + nv * nv; b1 += pu; b2 += pv; b3 += pu * nu + pv * nv;
      if (t < t0) t0 = t; if (t > t1) t1 = t;
    }
    // [s11 0 s13; 0 s11 s23; s13 s23 s33] · [cu cv r] = [b1 b2 b3]
    const det = s11 * (s11 * s33 - s23 * s23) - s13 * s13 * s11;
    if (Math.abs(det) > 1e-12) {
      const r = (s11 * s11 * b3 - s11 * s13 * b1 - s11 * s23 * b2) / det;
      const cu = (b1 - s13 * r) / s11, cv = (b2 - s23 * r) / s11;
      let worst = 0;
      for (const i of ids) { const p = pt(i), n = nm(i); worst = Math.max(worst, Math.hypot(dot(p, u) - cu - r * dot(n, u), dot(p, v) - cv - r * dot(n, v))); }
      if (Math.abs(r) > 1e-6 && worst < 1e-3 * Math.max(1, Math.abs(r))) {
        const o = add(add(scale(u, cu), scale(v, cv)), scale(d, (t0 + t1) / 2));
        return { ...frameFromAxis(o, d), surface: "cylinder", radius: Math.abs(r) };
      }
    }
  }

  const c: Vec3 = [0, 0, 0];
  for (const i of ids) { const p = pt(i); c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return { ...frameFromAxis(scale(c, 1 / ids.length), mean || [0, 0, 1]), surface: "other" };
}

/** The unit direction every one of `normals` is at right angles to, when there is one (and only one). */
function leastDirection(normals: Vec3[]): { dir: Vec3 } | null {
  // the smallest eigenvector of Σ n·nᵀ, by Jacobi rotations on the 3 × 3 matrix
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const n of normals) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i][j] += n[i] * n[j];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      off += Math.abs(a[p][q]);
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
    }
    if (off < 1e-14 * normals.length) break;
  }
  const ev = [a[0][0], a[1][1], a[2][2]];
  const order = [0, 1, 2].sort((p, q) => ev[p] - ev[q]);
  const n = normals.length;
  if (ev[order[0]] > 1e-6 * n || ev[order[1]] < 1e-3 * n) return null;   // not perpendicular to one direction, or flat
  return { dir: unit([v[0][order[0]], v[1][order[0]], v[2][order[0]]]) };
}

function edgeFrame(mesh: BodyMesh, name: string): MateFrame | null {
  const ei = mesh.edges.names.indexOf(name);
  if (ei < 0) return null;
  const E = mesh.edges.positions, start = mesh.edges.start[ei], count = mesh.edges.count[ei];
  const pts: Vec3[] = [];
  for (let i = start; i < start + count; i++) {
    const p: Vec3 = [E[i * 3], E[i * 3 + 1], E[i * 3 + 2]];
    const last = pts[pts.length - 1];
    if (!last || len(sub(p, last)) > 1e-7) pts.push(p);
  }
  if (pts.length < 2) return pts.length ? { ...frameFromAxis(pts[0], [0, 0, 1]), surface: "point" } : null;
  const first = pts[0];
  let far = pts[1], reach = 0;
  for (const p of pts) { const d = len(sub(p, first)); if (d > reach) { reach = d; far = p; } }
  const dir = unit(sub(far, first));
  // straight: every point is on the line through the two that are furthest apart
  if (pts.every((p) => len(cross(sub(p, first), dir)) < 1e-5 * Math.max(1, reach))) {
    let t0 = Infinity, t1 = -Infinity;
    for (const p of pts) { const t = dot(sub(p, first), dir); if (t < t0) t0 = t; if (t > t1) t1 = t; }
    return { ...frameFromAxis(addScaled(first, dir, (t0 + t1) / 2), canonical(dir)), surface: "line" };
  }
  // a circle or an arc: three well-spread points give a centre and an axis that every other point agrees with
  if (pts.length >= 3) {
    const a = pts[0], b = pts[Math.floor(pts.length / 3)], c = pts[Math.floor((2 * pts.length) / 3)];
    const ab = sub(b, a), ac = sub(c, a), n = cross(ab, ac), nn = dot(n, n);
    if (nn > 1e-12) {
      // circumcentre of a triangle
      const centre = add(a, scale(add(scale(cross(n, ab), dot(ac, ac)), scale(cross(ac, n), dot(ab, ab))), 1 / (2 * nn)));
      const r = len(sub(a, centre)), axis = unit(n);
      if (pts.every((p) => Math.abs(len(sub(p, centre)) - r) < 1e-4 * Math.max(1, r) && Math.abs(dot(sub(p, centre), axis)) < 1e-4 * Math.max(1, r))) {
        return { ...frameFromAxis(centre, canonical(axis)), surface: "circle", radius: r };
      }
    }
  }
  const mid = pts[Math.floor(pts.length / 2)], prev = pts[Math.max(0, Math.floor(pts.length / 2) - 1)];
  return { ...frameFromAxis(mid, len(sub(mid, prev)) > 1e-9 ? canonical(unit(sub(mid, prev))) : [0, 0, 1]), surface: "other" };
}

function vertexFrame(mesh: BodyMesh, name: string): MateFrame | null {
  const i = mesh.vertices.names.indexOf(name);
  if (i < 0) return null;
  const V = mesh.vertices.positions;
  return { o: [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], surface: "point" };
}
