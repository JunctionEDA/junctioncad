// tessellate.ts — a body as triangles and line segments for the viewport, with the ranges that belong to each
// named face and edge.  Uses the mesh extractors compiled into the kernel build (one call per body, the
// buffers read straight out of the wasm heap).
import type { BodyMesh } from "./protocol";
import type { Kernel } from "./occ";
import type { Body } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Chord tolerance in millimetres and angular tolerance in radians. */
export interface MeshQuality { linear: number; angular: number }
/** The finest a body is ever meshed (what a small, simple part gets). */
export const DEFAULT_QUALITY: MeshQuality = { linear: 0.05, angular: 0.3 };

/**
 * How finely to mesh this body for the screen.  A fixed tolerance is wrong at both ends: too coarse for a
 * watch part, and on a large part with hundreds of small features (a 20 × 20 pattern of holes) it spends
 * seconds on roundness nobody can see at the size the part is looked at.  So:
 *
 *   linear   half a thousandth of the body's diagonal, between 0.01 and 0.5 mm (a 100 mm part: 0.05 mm)
 *   angular  0.3 rad; 0.5 on a body of more than 150 faces and 0.8 on one of more than 300.  The angle is what
 *            decides how many segments a SMALL hole or fillet gets (the chord limit only bites on large radii),
 *            and the mesher's time grows faster than the number of points on a face's boundaries.
 *
 * Measured on a 200 mm plate with 400 holes (static/tests/mechanical-patterns.test.js prints it): 4.0 s of
 * meshing at the fixed 0.05 mm / 0.3 rad, 0.7 s with this.
 */
export function qualityFor(k: Kernel, body: Body): MeshQuality {
  const oc = k.oc as any;
  let diagonal = 0;
  const box = new oc.Bnd_Box();
  try {
    oc.BRepBndLib.Add(body.shape, box, false);
    if (!box.IsVoid()) diagonal = Math.hypot(box.GetXMax() - box.GetXMin(), box.GetYMax() - box.GetYMin(), box.GetZMax() - box.GetZMin());
  } catch (e) { /* a shape with no box: the default below */ } finally { box.delete(); }
  const faces = body.topo.faces.length;
  return {
    linear: diagonal > 0 ? Math.min(0.5, Math.max(0.01, diagonal * 0.0005)) : DEFAULT_QUALITY.linear,
    angular: faces > 300 ? 0.8 : faces > 150 ? 0.5 : DEFAULT_QUALITY.angular,
  };
}

export function tessellate(k: Kernel, body: Body, q: MeshQuality = qualityFor(k, body)): BodyMesh {
  const oc = k.oc as any;
  const heap = (): ArrayBuffer => oc.wasmMemory.buffer;

  // ---- faces
  const m = oc.ReplicadMeshExtractor.extract(body.shape, q.linear, q.angular, false);
  const positions = new Float32Array(heap(), m.getVerticesPtr(), m.getVerticesSize()).slice();
  const normals = new Float32Array(heap(), m.getNormalsPtr(), m.getNormalsSize()).slice();
  const indices = new Uint32Array(heap(), m.getTrianglesPtr(), m.getTrianglesSize()).slice();
  const groups = new Uint32Array(heap(), m.getFaceGroupsPtr(), m.getFaceGroupsSize()).slice();
  m.delete();

  // The extractor walks the faces in the explorer's order and tags each group with the face's hash.  Names are
  // matched by hash, and by position among the faces that share one.
  const order = <T extends { name: string; shape: any }>(named: T[], raw: Uint32Array | Int32Array) => {
    const byHash = new Map<number, T[]>();
    for (const n of named) { const h = k.hash(n.shape); if (!byHash.has(h)) byHash.set(h, []); byHash.get(h)!.push(n); }
    const names: string[] = [], start: number[] = [], count: number[] = [];
    const merged = new Map<string, number>();
    for (let i = 0; i + 2 < raw.length; i += 3) {
      const candidates = byHash.get(raw[i + 2]);
      const hit = candidates && candidates.length ? (candidates.length > 1 ? candidates.shift()! : candidates[0]) : null;
      const name = hit ? hit.name : `?${i / 3}`;
      // one face may come back as more than one group (it was visited through two shells): keep the first range
      if (merged.has(name)) continue;
      merged.set(name, names.length);
      names.push(name); start.push(raw[i]); count.push(raw[i + 1]);
    }
    return { names, start: Uint32Array.from(start), count: Uint32Array.from(count) };
  };
  const faces = order(body.topo.faces, groups);

  // ---- edges
  const em = oc.ReplicadEdgeMeshExtractor.extract(body.shape, q.linear, q.angular);
  const lines = new Float32Array(heap(), em.getLinesPtr(), em.getLinesSize()).slice();
  const edgeGroups = new Int32Array(heap(), em.getEdgeGroupsPtr(), em.getEdgeGroupsSize()).slice();
  em.delete();
  const edges = { ...order(body.topo.edges, edgeGroups), positions: lines };

  // ---- vertices
  const vpos = new Float32Array(body.topo.vertices.length * 3);
  body.topo.vertices.forEach((v, i) => { const p = k.vertexPoint(v.shape); vpos[i * 3] = p[0]; vpos[i * 3 + 1] = p[1]; vpos[i * 3 + 2] = p[2]; });

  const bbox: BodyMesh["bbox"] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) { const v = positions[i + a]; if (v < bbox[a]) bbox[a] = v; if (v > bbox[a + 3]) bbox[a + 3] = v; }
  if (!positions.length) bbox.fill(0);

  return { positions, normals, indices, faces, edges, vertices: { names: body.topo.vertices.map((v) => v.name), positions: vpos }, bbox };
}
