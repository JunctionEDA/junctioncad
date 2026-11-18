// render.ts — a shaded picture of the bodies of a part studio without a browser: a small software rasteriser
// (orthographic camera, depth buffer, flat shading, the bodies' edges drawn over the faces) and a PNG writer.
//
// The tool host runs in Node, where there is no WebGL.  An assistant needs the picture to check its own work
// ("is the hole where I meant it"), not for beauty, so this draws what the viewport draws in its simplest form:
// each body's triangles lit from the camera, its edges as dark lines, a small axis triad in the corner.  It is
// drawn at twice the size asked for and averaged down, which is all the anti-aliasing it has.
import type { BodyMesh } from "../kernel/protocol";
import { cross, dot, normalize, sub, type Vec3 } from "../core/geometry";

declare function require(name: string): any;   // eslint-disable-line @typescript-eslint/no-explicit-any

export type ViewName = "iso" | "top" | "bottom" | "front" | "back" | "left" | "right";
/** `dir` is the way the camera looks, `up` what is up on the picture. */
export const VIEWS: Record<ViewName, { dir: Vec3; up: Vec3 }> = {
  iso: { dir: [-1, 1, -1], up: [0, 0, 1] },       // from the front right, above (the viewport's Iso)
  top: { dir: [0, 0, -1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, 1], up: [0, -1, 0] },
  front: { dir: [0, 1, 0], up: [0, 0, 1] },
  back: { dir: [0, -1, 0], up: [0, 0, 1] },
  right: { dir: [-1, 0, 0], up: [0, 0, 1] },
  left: { dir: [1, 0, 0], up: [0, 0, 1] },
};

export interface RenderOptions {
  width?: number; height?: number;
  view?: ViewName;
  /** a view direction of its own (the way the camera looks), instead of a named view */
  direction?: Vec3;
  edges?: boolean;
  /** one colour per mesh, 0xRRGGBB; the default palette otherwise */
  colors?: number[];
  background?: number;
}

export interface Picture { width: number; height: number; rgba: Uint8Array }

const PALETTE = [0x9db4cf, 0xd3b58f, 0xa7c9a1, 0xcfa3b8, 0xb0a8d6, 0xc9c48f];

/** Draw the meshes.  The picture is framed on them with a margin; with nothing to draw it is the background. */
export function renderMeshes(meshes: readonly BodyMesh[], o: RenderOptions = {}): Picture {
  const W = Math.max(64, Math.min(2000, Math.round(o.width || 900))), H = Math.max(64, Math.min(2000, Math.round(o.height || 700)));
  const S = 2, w = W * S, h = H * S;
  const view = o.direction ? { dir: o.direction, up: Math.abs(normalize(o.direction)[2]) > 0.99 ? ([0, 1, 0] as Vec3) : ([0, 0, 1] as Vec3) } : VIEWS[o.view || "iso"] || VIEWS.iso;
  const d = normalize(view.dir), right = normalize(cross(d, view.up)), up = cross(right, d);
  const bg = o.background ?? 0xf3f4f6;
  const color = new Uint8Array(w * h * 3), depth = new Float32Array(w * h).fill(Infinity);
  for (let i = 0; i < w * h; i++) { color[i * 3] = bg >> 16; color[i * 3 + 1] = (bg >> 8) & 255; color[i * 3 + 2] = bg & 255; }

  // the extent of everything on the picture plane
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      const p: Vec3 = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
      const x = dot(p, right), y = dot(p, up), z = dot(p, d);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
  }
  const any = Number.isFinite(x0);
  if (!any) { x0 = y0 = z0 = -10; x1 = y1 = z1 = 10; }
  const margin = 0.08;
  const span = Math.max((x1 - x0) / (w * (1 - 2 * margin)), (y1 - y0) / (h * (1 - 2 * margin)), 1e-9);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const px = (x: number) => (x - cx) / span + w / 2, py = (y: number) => h / 2 - (y - cy) / span;
  const zr = Math.max(z1 - z0, 1e-6);

  const light = normalize([-d[0] + 0.35 * right[0] + 0.5 * up[0], -d[1] + 0.35 * right[1] + 0.5 * up[1], -d[2] + 0.35 * right[2] + 0.5 * up[2]]);
  meshes.forEach((m, mi) => {
    const base = (o.colors && o.colors[mi] !== undefined ? o.colors[mi] : PALETTE[mi % PALETTE.length]);
    const br = base >> 16, bgc = (base >> 8) & 255, bb = base & 255;
    const P = m.positions, I = m.indices;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a: Vec3 = [P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2]], b: Vec3 = [P[I[t + 1] * 3], P[I[t + 1] * 3 + 1], P[I[t + 1] * 3 + 2]], c: Vec3 = [P[I[t + 2] * 3], P[I[t + 2] * 3 + 1], P[I[t + 2] * 3 + 2]];
      const n = normalize(cross(sub(b, a), sub(c, a)));
      const lit = 0.38 + 0.62 * Math.abs(dot(n, light));
      const r = Math.round(br * lit), g = Math.round(bgc * lit), bl = Math.round(bb * lit);
      const ax = px(dot(a, right)), ay = py(dot(a, up)), az = dot(a, d), bx = px(dot(b, right)), by = py(dot(b, up)), bz = dot(b, d), cx2 = px(dot(c, right)), cy2 = py(dot(c, up)), cz = dot(c, d);
      const area = (bx - ax) * (cy2 - ay) - (cx2 - ax) * (by - ay);
      if (Math.abs(area) < 1e-9) continue;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx2))), maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx2)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy2))), maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy2)));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const sx = x + 0.5, sy = y + 0.5;
          const w0 = ((bx - sx) * (cy2 - sy) - (cx2 - sx) * (by - sy)) / area, w1 = ((cx2 - sx) * (ay - sy) - (ax - sx) * (cy2 - sy)) / area, w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const z = w0 * az + w1 * bz + w2 * cz, i = y * w + x;
          if (z < depth[i]) { depth[i] = z; color[i * 3] = r; color[i * 3 + 1] = g; color[i * 3 + 2] = bl; }
        }
      }
    }
  });

  /** A line with a depth test: it shows where it is not behind a face (a little bias keeps it in front of its own). */
  const line = (a: Vec3, b: Vec3, rgb: number, tested: boolean, thick: number): void => {
    const ax = px(dot(a, right)), ay = py(dot(a, up)), az = dot(a, d), bx = px(dot(b, right)), by = py(dot(b, up)), bz = dot(b, d);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
    const bias = zr * 0.004;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
      for (let oy = 0; oy < thick; oy++) for (let ox = 0; ox < thick; ox++) {
        const xi = Math.round(x) + ox, yi = Math.round(y) + oy;
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
        const i = yi * w + xi;
        if (tested && z - bias > depth[i]) continue;
        color[i * 3] = rgb >> 16; color[i * 3 + 1] = (rgb >> 8) & 255; color[i * 3 + 2] = rgb & 255;
      }
    }
  };
  if (o.edges !== false) {
    for (const m of meshes) {
      const E = m.edges.positions;
      for (let i = 0; i + 5 < E.length; i += 6) line([E[i], E[i + 1], E[i + 2]], [E[i + 3], E[i + 4], E[i + 5]], 0x1f2933, true, S);
    }
  }
  // the axis triad, bottom left: X red, Y green, Z blue, as the viewport draws them
  {
    const len = Math.min(w, h) * 0.07 * span;
    const ox = (x0 + x1) / 2 - (w / 2 - w * 0.07) * span, oy = (y0 + y1) / 2 - (h / 2 - h * 0.09) * span;
    const origin: Vec3 = [right[0] * ox + up[0] * oy, right[1] * ox + up[1] * oy, right[2] * ox + up[2] * oy];
    const axes: [Vec3, number][] = [[[1, 0, 0], 0xd64545], [[0, 1, 0], 0x3f9b4b], [[0, 0, 1], 0x3d6fd6]];
    for (const [v, rgb] of axes) line(origin, [origin[0] + v[0] * len, origin[1] + v[1] * len, origin[2] + v[2] * len], rgb, false, S + 1);
  }

  // average the 2 × 2 blocks down
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let oy = 0; oy < S; oy++) for (let ox = 0; ox < S; ox++) { const i = ((y * S + oy) * w + x * S + ox) * 3; r += color[i]; g += color[i + 1]; b += color[i + 2]; }
    const o4 = (y * W + x) * 4, n = S * S;
    rgba[o4] = r / n; rgba[o4 + 1] = g / n; rgba[o4 + 2] = b / n; rgba[o4 + 3] = 255;
  }
  return { width: W, height: H, rgba };
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG file of the picture (Node only: it uses node:zlib). */
export function encodePng(pic: Picture): Uint8Array {
  const zlib = require("node:zlib");
  const { width: w, height: h, rgba } = pic;
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const data: Uint8Array = zlib.deflateSync(raw, { level: 6 });
  const chunk = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const head = new Uint8Array(13), hv = new DataView(head.buffer);
  hv.setUint32(0, w); hv.setUint32(4, h); head[8] = 8; head[9] = 6; head[10] = 0; head[11] = 0; head[12] = 0;
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", data), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
