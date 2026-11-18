// exchange-mesh.ts — triangle-mesh files: STL (binary and ASCII), 3MF, OBJ and glTF binary (GLB).
//
// `meshOf` tessellates a shape at the export's resolution in the worker; everything else here is pure and
// works on plain typed arrays, so it is tested in node without the kernel.  Lengths are millimetres in, and
// are scaled to the file's unit on the way out.
import type { Kernel } from "../occ";
import type { Shape } from "../types";
import { zip } from "./exchange-zip";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MeshPart {
  name: string;
  /** x, y, z per vertex, millimetres */
  positions: Float32Array;
  normals?: Float32Array;
  /** three vertex indices per triangle, counter-clockwise seen from outside */
  indices: Uint32Array;
  /** sRGB, 0..1 */
  color?: [number, number, number] | null;
}

/** How finely curved faces are cut into triangles: the largest gap between mesh and surface, and the largest angle between neighbouring triangles. */
export interface MeshResolution { deflection: number; angleDeg: number }
export const RESOLUTIONS: Record<"coarse" | "medium" | "fine", MeshResolution> = {
  coarse: { deflection: 0.1, angleDeg: 30 },
  medium: { deflection: 0.02, angleDeg: 15 },
  fine: { deflection: 0.005, angleDeg: 5 },
};

/**
 * Tessellate a shape for export.  Any triangulation already on the shape (the viewport's) is dropped first, so
 * a coarse export really is coarse.
 */
export function meshOf(k: Kernel, shape: Shape, r: MeshResolution, name: string, color?: [number, number, number] | null): MeshPart {
  const oc = k.oc as any;
  if (!(r.deflection > 0)) throw new Error("The deflection must be more than zero.");
  if (!(r.angleDeg > 0 && r.angleDeg <= 90)) throw new Error("The angle must be between 0 and 90 degrees.");
  oc.BRepTools.Clean(shape, true);
  const heap = (): ArrayBuffer => oc.wasmMemory.buffer;
  const m = oc.ReplicadMeshExtractor.extract(shape, r.deflection, (r.angleDeg * Math.PI) / 180, false);
  try {
    const positions = new Float32Array(heap(), m.getVerticesPtr(), m.getVerticesSize()).slice();
    const normals = new Float32Array(heap(), m.getNormalsPtr(), m.getNormalsSize()).slice();
    const indices = new Uint32Array(heap(), m.getTrianglesPtr(), m.getTrianglesSize()).slice();
    return { name, positions, normals, indices, color };
  } finally { m.delete(); oc.BRepTools.Clean(shape, true); }
}

export const triangleCount = (parts: readonly MeshPart[]): number => parts.reduce((n, p) => n + p.indices.length / 3, 0);

function faceNormal(p: Float32Array, a: number, b: number, c: number, out: Float32Array, at: number): void {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  out[at] = nx; out[at + 1] = ny; out[at + 2] = nz;
}

/** Binary STL: every part's triangles in one solid.  `scale` converts millimetres to the file's unit. */
export function writeStlBinary(parts: readonly MeshPart[], scale = 1, header = "Junction STL"): Uint8Array {
  const n = triangleCount(parts);
  const out = new Uint8Array(84 + n * 50);
  out.set(new TextEncoder().encode(header.slice(0, 79)), 0);
  const v = new DataView(out.buffer);
  v.setUint32(80, n, true);
  const nrm = new Float32Array(3);
  let at = 84;
  for (const part of parts) {
    const p = part.positions, ix = part.indices;
    for (let t = 0; t < ix.length; t += 3) {
      faceNormal(p, ix[t], ix[t + 1], ix[t + 2], nrm, 0);
      v.setFloat32(at, nrm[0], true); v.setFloat32(at + 4, nrm[1], true); v.setFloat32(at + 8, nrm[2], true);
      for (let j = 0; j < 3; j++) { const i = ix[t + j] * 3, o = at + 12 + j * 12; v.setFloat32(o, p[i] * scale, true); v.setFloat32(o + 4, p[i + 1] * scale, true); v.setFloat32(o + 8, p[i + 2] * scale, true); }
      at += 50;
    }
  }
  return out;
}

const num = (x: number): string => { const s = x.toPrecision(7); return s.includes("e") ? String(+s) : String(+s); };
const safeName = (s: string): string => s.replace(/[\r\n]+/g, " ").trim() || "part";

/** ASCII STL: one `solid` per part. */
export function writeStlAscii(parts: readonly MeshPart[], scale = 1): Uint8Array {
  const lines: string[] = [];
  const nrm = new Float32Array(3);
  for (const part of parts) {
    const name = safeName(part.name).replace(/\s+/g, "_");
    lines.push(`solid ${name}`);
    const p = part.positions, ix = part.indices;
    for (let t = 0; t < ix.length; t += 3) {
      faceNormal(p, ix[t], ix[t + 1], ix[t + 2], nrm, 0);
      lines.push(`  facet normal ${num(nrm[0])} ${num(nrm[1])} ${num(nrm[2])}`, "    outer loop");
      for (let j = 0; j < 3; j++) { const i = ix[t + j] * 3; lines.push(`      vertex ${num(p[i] * scale)} ${num(p[i + 1] * scale)} ${num(p[i + 2] * scale)}`); }
      lines.push("    endloop", "  endfacet");
    }
    lines.push(`endsolid ${name}`);
  }
  return new TextEncoder().encode(lines.join("\n") + "\n");
}

/** Wavefront OBJ: one object per part, with normals, and a material per coloured part (in the same text: no .mtl). */
export function writeObj(parts: readonly MeshPart[], scale = 1): Uint8Array {
  const out: string[] = ["# Junction OBJ export"];
  let base = 1;
  for (const part of parts) {
    out.push(`o ${safeName(part.name)}`);
    const p = part.positions, nm = part.normals;
    for (let i = 0; i < p.length; i += 3) out.push(`v ${num(p[i] * scale)} ${num(p[i + 1] * scale)} ${num(p[i + 2] * scale)}`);
    const hasN = !!nm && nm.length === p.length;
    if (hasN) for (let i = 0; i < nm!.length; i += 3) out.push(`vn ${num(nm![i])} ${num(nm![i + 1])} ${num(nm![i + 2])}`);
    const ix = part.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] + base, b = ix[t + 1] + base, c = ix[t + 2] + base;
      out.push(hasN ? `f ${a}//${a} ${b}//${b} ${c}//${c}` : `f ${a} ${b} ${c}`);
    }
    base += p.length / 3;
  }
  return new TextEncoder().encode(out.join("\n") + "\n");
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const UNIT_3MF: Record<string, string> = { mm: "millimeter", cm: "centimeter", m: "meter", in: "inch" };
const hex = (c: [number, number, number]): string => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0")).join("").toUpperCase();

/** 3MF (the 3D printing consortium's format): one object per part, in the file's unit, as a ZIP package. */
export async function write3mf(parts: readonly MeshPart[], unit: "mm" | "cm" | "m" | "in" = "mm", scale = 1): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const colored = parts.filter((p) => p.color);
  const chunks: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="${UNIT_3MF[unit] || "millimeter"}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`,
    '<metadata name="Application">Junction</metadata>',
    "<resources>",
  ];
  if (colored.length) chunks.push(`<basematerials id="1">${parts.map((p) => `<base name="${xml(safeName(p.name))}" displaycolor="${hex(p.color || [0.7, 0.7, 0.7])}"/>`).join("")}</basematerials>`);
  parts.forEach((part, n) => {
    const id = n + 2, p = part.positions, ix = part.indices;
    chunks.push(`<object id="${id}" name="${xml(safeName(part.name))}" type="model"${colored.length ? ` pid="1" pindex="${n}"` : ""}><mesh><vertices>`);
    const vs: string[] = [];
    for (let i = 0; i < p.length; i += 3) vs.push(`<vertex x="${num(p[i] * scale)}" y="${num(p[i + 1] * scale)}" z="${num(p[i + 2] * scale)}"/>`);
    chunks.push(vs.join(""), "</vertices><triangles>");
    const ts: string[] = [];
    for (let t = 0; t < ix.length; t += 3) ts.push(`<triangle v1="${ix[t]}" v2="${ix[t + 1]}" v3="${ix[t + 2]}"/>`);
    chunks.push(ts.join(""), "</triangles></mesh></object>");
  });
  chunks.push("</resources>", "<build>", ...parts.map((_p, n) => `<item objectid="${n + 2}"/>`), "</build>", "</model>");
  return zip([
    { name: "[Content_Types].xml", data: enc.encode('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>') },
    { name: "_rels/.rels", data: enc.encode('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>') },
    { name: "3D/3dmodel.model", data: enc.encode(chunks.join("\n")) },
  ]);
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * glTF 2.0 binary (GLB): one mesh and node per part, with its colour.  glTF is in metres with Y up, so the
 * model (millimetres, Z up) is scaled by 0.001 and turned on a root node; viewers show it upright.
 */
export function writeGlb(parts: readonly MeshPart[], o: { defaultColor?: [number, number, number] } = {}): Uint8Array {
  const views: { buffer: 0; byteOffset: number; byteLength: number; target?: number }[] = [];
  const accessors: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [], nodes: Record<string, unknown>[] = [], materials: Record<string, unknown>[] = [];
  const blobs: Uint8Array[] = [];
  let length = 0;
  const add = (data: Uint8Array, target: number): number => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) { blobs.push(new Uint8Array(pad)); length += pad; }
    views.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength, target });
    blobs.push(data); length += data.byteLength;
    return views.length - 1;
  };
  parts.forEach((part) => {
    const p = part.positions;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const pos = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) { const x = p[i + a] * 0.001; pos[i + a] = x; if (x < min[a]) min[a] = x; if (x > max[a]) max[a] = x; }
    const attributes: Record<string, number> = {};
    accessors.push({ bufferView: add(new Uint8Array(pos.buffer), 34962), componentType: 5126, count: p.length / 3, type: "VEC3", min, max });
    attributes.POSITION = accessors.length - 1;
    if (part.normals && part.normals.length === p.length) {
      accessors.push({ bufferView: add(new Uint8Array(part.normals.slice().buffer), 34962), componentType: 5126, count: p.length / 3, type: "VEC3" });
      attributes.NORMAL = accessors.length - 1;
    }
    accessors.push({ bufferView: add(new Uint8Array(part.indices.slice().buffer), 34963), componentType: 5125, count: part.indices.length, type: "SCALAR" });
    const c = part.color || o.defaultColor || [0.72, 0.74, 0.78];
    materials.push({ name: safeName(part.name), pbrMetallicRoughness: { baseColorFactor: [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), 1], metallicFactor: 0.1, roughnessFactor: 0.6 } });
    meshes.push({ name: safeName(part.name), primitives: [{ attributes, indices: accessors.length - 1, material: materials.length - 1 }] });
    nodes.push({ name: safeName(part.name), mesh: meshes.length - 1 });
  });
  // the root turns Z up into Y up: a quarter turn about −X
  const s = Math.SQRT1_2;
  nodes.push({ name: "Junction export", rotation: [-s, 0, 0, s], children: parts.map((_p, i) => i) });
  const json = {
    asset: { version: "2.0", generator: "Junction" }, scene: 0, scenes: [{ nodes: [nodes.length - 1] }],
    nodes, meshes, materials, accessors, bufferViews: views, buffers: [{ byteLength: length }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) { const j = new Uint8Array(jsonBytes.length + jpad).fill(0x20); j.set(jsonBytes); jsonBytes = j; }
  const bpad = (4 - (length % 4)) % 4;
  const binLength = length + bpad;
  const out = new Uint8Array(12 + 8 + jsonBytes.length + 8 + binLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, out.length, true);
  v.setUint32(12, jsonBytes.length, true); v.setUint32(16, 0x4e4f534a, true); out.set(jsonBytes, 20);
  let at = 20 + jsonBytes.length;
  v.setUint32(at, binLength, true); v.setUint32(at + 4, 0x004e4942, true); at += 8;
  for (const b of blobs) { out.set(b, at); at += b.length; }
  return out;
}

/** Read a binary or ASCII STL back into a part (for tests, and for STL import). */
export function readStl(data: Uint8Array, name = "STL"): MeshPart {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const isBinary = data.length >= 84 && 84 + v.getUint32(80, true) * 50 === data.length;
  const pos: number[] = [];
  if (isBinary) {
    const n = v.getUint32(80, true);
    for (let t = 0; t < n; t++) for (let j = 0; j < 3; j++) { const o = 84 + t * 50 + 12 + j * 12; pos.push(v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true)); }
  } else {
    const text = new TextDecoder().decode(data);
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) pos.push(+m[1], +m[2], +m[3]);
  }
  const positions = Float32Array.from(pos);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { name, positions, indices };
}

/** The volume a closed mesh encloses (divergence theorem), in cubic millimetres. */
export function meshVolume(part: MeshPart): number {
  const p = part.positions, ix = part.indices;
  let v = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}
