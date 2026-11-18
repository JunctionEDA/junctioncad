// viewer3d/models.ts — the real 3D models of the parts on a board.
//
// A footprint names its model the way KiCad does: (model "${KICAD10_3DMODEL_DIR}/Button_Switch_SMD.3dshapes/
// SW_Push_SPST_NO_Alps_SKRK.step" (offset (xyz …)) (scale (xyz …)) (rotate (xyz …))).  The path's library and
// name are looked up in KiCad's own 3D library first (the server's /api/kicad-lib/model reads the STEP file from
// where the KiCad project publishes it); a vendor part's footprint points at ${KICAD_COLLAB_3DMODELS} and its
// model comes from the vendor through /api/parts/model.step.  A STEP file is solid geometry, not triangles, so it
// is tessellated here by OpenCascade compiled to WebAssembly (occt-import-js), in a worker, on first use.
// A model KiCad's library does not have is answered by the server with the closest one it does have (a footprint
// variant's base package, the same name in another library, another make of the same connector family), and a
// footprint that names no model at all is looked up under its own name the same way.  A kicad-embed://<file> model is
// the footprint's own (embedded_files …) copy (EMBEDDED_FILES::GetTemporaryFileName), read from the file's data, which a
// board KiCad saved keeps in the board's (embedded_files …) instead (BOARD::FixupEmbeddedData).
// A footprint whose model cannot be had even so keeps the stand-in solids of parts.ts.
//
// footprintModels / placeMesh are pure (no DOM), for the node tests; ModelStore is the browser half.

import { decodeEmbedded, embeddedFileData } from "../library/embedded-file";

export type V3 = [number, number, number];

/** One (model …) of a footprint. */
export interface ModelRef {
  /** where the STEP file is read from; also the key the tessellated mesh is kept under */
  url: string;
  /** "kicad" for KiCad's 3D library, "vendor" for a vendor part's model, "project" for a model file kept in the project,
   *  "embedded" for a file embedded in the footprint */
  source: "kicad" | "vendor" | "project" | "embedded" | "generated";
  /** Library/Name as the footprint wrote it, for messages */
  name: string;
  offset: V3; scale: V3; rotate: V3;
  /** the footprint names no model: this one is looked up under the footprint's own library name */
  guess?: boolean;
  /** a generated model: the footprint (as s-expression text) the server draws it from (POST /api/models/generate) */
  footprint?: string;
}

// The parts of a footprint the model generator reads (server/src/modelgen/footprint.rs): pads, outlines, fields.
const GEN_KEEP = new Set(["layer", "at", "attr", "property", "fp_text", "descr", "tags", "pad", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly"]);
const GEN_LAYERS = /^[FB]\.(Fab|CrtYd|SilkS)$/;
function genText(n: unknown): string { return Array.isArray(n) ? "(" + n.map(genText).join(" ") + ")" : JSON.stringify(String(n)); }
function fnv(s: string): string { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); }

/**
 * The model drawn for a footprint that has none anywhere (server/src/modelgen): from its pads, outline, name and
 * datasheet, the last stop before the plain stand-in shape.  Null for a footprint with no pads.
 */
export function generatedModel(node: SNode): ModelRef | null {
  if (!node.some((c) => Array.isArray(c) && c[0] === "pad")) return null;
  const keep = node.filter((c, i) => i < 2 || (Array.isArray(c) && GEN_KEEP.has(String(c[0])) && (!/^fp_/.test(String(c[0])) || (() => { const l = (c as SNode).find((k) => Array.isArray(k) && k[0] === "layer") as SNode | undefined; return !!l && GEN_LAYERS.test(String(l[1])); })())));
  const text = genText(keep);
  return { url: `/api/models/generate#${fnv(text)}${text.length}`, source: "generated", name: "generated", offset: [0, 0, 0], scale: [1, 1, 1], rotate: [0, 0, 0], footprint: text };
}

/** A tessellated model in its own frame: millimetres, Z up, per-vertex normals and colours (linear 0..1 RGB as in the file). */
export interface ModelMesh { pos: Float32Array; nrm: Float32Array; col: Float32Array; idx: Uint32Array }

const VENDOR_FIELDS: [string, string][] = [["LCSC", "lcsc"], ["Mouser", "mouser"], ["DigiKey", "digikey"]];
const num = (v: unknown, d = 0): number => { const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN; return isFinite(n) ? n : d; };
const kid = (node: SNode, name: string): SNode | null => { for (const c of node) if (Array.isArray(c) && c[0] === name) return c as SNode; return null; };
function xyzOf(node: SNode, name: string, d: number): V3 {
  const k = kid(node, name); const v = k ? kid(k, "xyz") : null;
  return v ? [num(v[1], d), num(v[2], d), num(v[3], d)] : [d, d, d];
}
function fieldOf(node: SNode, name: string): string {
  for (const c of node) if (Array.isArray(c) && c[0] === "property" && String(c[1]).toLowerCase() === name.toLowerCase()) return String(c[2] ?? "").trim();
  return "";
}

/**
 * A model file kept in the project (a part import, or the models archived into the project folder): the footprint names
 * it ${KIPRJMOD}/<path>.  The page that knows the project says where such a file is read from, through
 * globalThis.KiCadProjectModel(path without extension) -> URL or null; a footprint may name the .wrl where the project
 * keeps the .step, as with KiCad's own library.
 */
function projectModel(path: string): string | null {
  const fn = (globalThis as { KiCadProjectModel?: (stem: string) => string | null }).KiCadProjectModel;
  // a path that is absolute on the machine it was picked on (a file dialog writes those): the project may still hold
  // that file, when the path points into a checkout of its repository; the page matches it by the end of the path
  const abs = /^((?:[A-Za-z]:)?[\/\\].+)\.(?:step|stp|wrl|wrz)$/i.exec(path);
  if (abs) { try { return typeof fn === "function" ? fn(abs[1].replace(/\\/g, "/")) || null : null; } catch { return null; } }
  const m = /^\$[{(]KIPRJMOD[})][\/\\](.+)\.(?:step|stp|wrl|wrz)$/i.exec(path); if (!m) return null;
  // a library shared with other projects sits beside the project folder (${KIPRJMOD}/../lib/…) and is kept under that
  // same path; ".." anywhere but at the front is not a path the project keeps
  const stem = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
  if (stem.replace(/^(?:\.\.\/)+/, "").split("/").includes("..")) return null;
  try { return typeof fn === "function" ? fn(stem) || null : null; } catch { return null; }
}

/**
 * kicad-embed://<name>.step|stp: the footprint's embedded copy as an object URL, one per file content.
 * `boardFiles` is the board's own (embedded_files …), where a board KiCad saved keeps the data of its footprints' files
 * (BOARD::FixupEmbeddedData reads it from there).
 */
const embedUrls = new Map<string, string | null>();
function embeddedModel(node: SNode, path: string, boardFiles: SNode | null): string | null {
  const m = /^kicad-embed:\/\/([^/\\]+\.(?:step|stp))$/i.exec(path); if (!m) return null;
  const b64 = embeddedFileData(node, m[1], boardFiles); if (!b64) return null;
  const key = m[1] + "\n" + b64.length + b64.slice(0, 48) + b64.slice(-48) + b64.slice(b64.length >> 1, (b64.length >> 1) + 48);
  if (embedUrls.has(key)) return embedUrls.get(key)!;
  let url: string | null = null;
  const bytes = decodeEmbedded(b64);
  if (bytes && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/step" }));
  embedUrls.set(key, url); return url;
}

/** Where KiCad's library model `lib`/`name` is read from; the server answers a missing one with its closest replacement. */
export const kicadModelUrl = (lib: string, name: string): string => `/api/kicad-lib/model?lib=${encodeURIComponent(lib)}&name=${encodeURIComponent(name)}&fallback=1`;

/**
 * The models a footprint names, in file order; hidden ones and paths that name no library file are left out.
 * With `guess` (the default), a footprint that names no model at all gets one looked up under its own
 * "Library:Name", which is where KiCad's library keeps the model of a footprint of its own.
 */
export function footprintModels(node: SNode, guess = true, boardFiles: SNode | null = null): ModelRef[] {
  const out: ModelRef[] = []; let named = false;
  for (const c of node) {
    if (!Array.isArray(c) || c[0] !== "model") continue;
    named = true;
    const hide = kid(c as SNode, "hide"); if (hide && String(hide[1]) !== "no") continue;
    const path = String(c[1] ?? "");
    const emb = /^kicad-embed:\/\//i.test(path) ? embeddedModel(node, path, boardFiles) : null;
    if (emb) { out.push({ name: path.slice("kicad-embed://".length), offset: xyzOf(c as SNode, "offset", 0), scale: xyzOf(c as SNode, "scale", 1), rotate: xyzOf(c as SNode, "rotate", 0), source: "embedded", url: emb }); continue; }
    const own = projectModel(path);
    if (own) { out.push({ name: path.replace(/^\$[{(]KIPRJMOD[})][\/\\]/i, ""), offset: xyzOf(c as SNode, "offset", 0), scale: xyzOf(c as SNode, "scale", 1), rotate: xyzOf(c as SNode, "rotate", 0), source: "project", url: own }); continue; }
    const m = /([^\/\\${}]+)\.3dshapes[\/\\]([^\/\\]+)\.(?:step|stp|wrl|wrz)$/i.exec(path);
    const ref = { name: m ? `${m[1]}/${m[2]}` : path.replace(/^.*[\/\\]/, ""), offset: xyzOf(c as SNode, "offset", 0), scale: xyzOf(c as SNode, "scale", 1), rotate: xyzOf(c as SNode, "rotate", 0) };
    const foreign = foreignModel(node, path, ref);
    if (foreign) { if (!out.some((o) => o.url === foreign.url)) out.push(foreign); continue; }
    if (!m) continue;
    if (/KICAD_COLLAB_3DMODELS/.test(path)) {
      const hit = VENDOR_FIELDS.map(([f, v]) => [v, fieldOf(node, f)]).find(([, id]) => id); if (!hit) continue;
      // the server lines the vendor's file up for the entry Junction wrote (parts/step_fit.rs), so the entry is read
      // as KiCad reads it, here as on the desktop and in a downloaded library
      out.push({ ...ref, source: "vendor", url: `/api/parts/model.step?vendor=${hit[0]}&id=${encodeURIComponent(hit[1])}&fit=4` });
    } else out.push({ ...ref, source: "kicad", url: kicadModelUrl(m[1], m[2]) });
  }
  if (!named && guess) { const g = guessedModel(node); if (g) out.push(g); }
  return out;
}

/** Fields a footprint keeps its LCSC part number in (easyeda2kicad writes "LCSC Part", JLC's tools "LCSC Part #" or "JLCPCB Part #"). */
const LCSC_FIELDS = ["LCSC", "LCSC Part", "LCSC Part #", "LCSC PN", "LCSC P/N", "LCSC Part No.", "LCSC Part Number", "LCSC#", "JLCPCB Part #", "JLCPCB Part", "JLCPCB PN", "JLCPCB P/N", "JLC", "JLCPCB"];
function lcscOf(node: SNode): string {
  for (const f of LCSC_FIELDS) { const v = fieldOf(node, f); if (/^C\d{1,9}$/i.test(v)) return v.toUpperCase(); }
  return "";
}

/**
 * A model under a path variable that is not KiCad's own library (${EASYEDA2KICAD}/easyeda2kicad.3dshapes/…, a
 * personal ${MY_3D}/…): the file sits on the machine of whoever made the board, so the server never has it.
 * The project may keep a copy (the same folder and file name anywhere in it); else, for a part with an LCSC number,
 * the vendor's own STEP model of that part is drawn.  easyeda2kicad bakes the part's offset into the .wrl it writes
 * and leaves the .step at (offset 0 0 0) in the vendor's frame, so for a .wrl, or a .step nobody moved, the
 * vendor's own placement on its footprint is used (the footprint has the vendor's origin); a .step someone lined up
 * by hand keeps their offset and rotation.  Null for KiCad's library paths and paths without a variable.
 */
function foreignModel(node: SNode, path: string, ref: Omit<ModelRef, "url" | "source">): ModelRef | null {
  const v = /^\$[{(]([A-Za-z0-9_]+)[})][\/\\](.+)$/.exec(path); if (!v) return null;
  if (/^(KICAD\d*_3DMODEL_DIR|KISYS3DMOD|KICAD_COLLAB_3DMODELS|KIPRJMOD)$/.test(v[1])) return null;
  const tail = v[2].replace(/\\/g, "/").replace(/^\.\//, "");
  const stem = tail.replace(/\.(?:step|stp|wrl|wrz)$/i, "");
  if (stem !== tail && !stem.split("/").includes("..")) {
    const fn = (globalThis as { KiCadProjectModel?: (stem: string) => string | null }).KiCadProjectModel;
    let own: string | null = null;
    try { own = typeof fn === "function" ? fn(stem) || (stem.includes("/") ? fn("/" + stem) : null) || null : null; } catch { own = null; }
    if (own) return { ...ref, name: tail, source: "project", url: own };
  }
  const lcsc = lcscOf(node); if (!lcsc) return null;
  const url = `/api/parts/model.step?vendor=lcsc&id=${encodeURIComponent(lcsc)}`;
  // easyeda2kicad's .step is the vendor's file as it is, placed by the entry's own numbers (KiCad does the same with
  // the author's copy, and the desktop app with the server's: /api/parts/model-file?as=raw)
  if (/\.(?:step|stp)$/i.test(path)) return { ...ref, source: "vendor", url };
  // the file lined up for the vendor's entry (fit=4) and that entry's offset and turn applied by the store (placed=1)
  return { ...ref, offset: [0, 0, 0], rotate: [0, 0, 0], source: "vendor", url: url + "&fit=4&placed=1" };
}

/** The model to try for a footprint that names none: its own "Library:Name" in KiCad's 3D library (or the closest to it). */
export function guessedModel(node: SNode): ModelRef | null {
  const m = /^([^:\/\\${}]+):([^:\/\\]+)$/.exec(String(node[1] ?? "")); if (!m) return null;
  return { name: `${m[1]}/${m[2]}`, offset: [0, 0, 0], scale: [1, 1, 1], rotate: [0, 0, 0], source: "kicad", url: kicadModelUrl(m[1], m[2]), guess: true };
}

/** Where a footprint stands, for placeMesh: model space is millimetres with Y up and Z out of the front face. */
export interface Placement { x: number; y: number; z: number; rot: number; back: boolean }

/**
 * A model's vertices and normals where KiCad's viewer puts them (3d-viewer/3d_rendering: the footprint's matrix is
 * translate · rotateZ(orientation) · [flipped: rotateY(180°) · rotateZ(180°)], the model's is translate(offset) ·
 * rotateZ(-rz) · rotateY(-ry) · rotateX(-rx) · scale).  `each` receives every vertex as (x, y, z, nx, ny, nz, i).
 */
export function placeMesh(mesh: ModelMesh, ref: ModelRef, at: Placement, each: (x: number, y: number, z: number, nx: number, ny: number, nz: number, i: number) => void): void {
  const rad = Math.PI / 180;
  const rx = -ref.rotate[0] * rad, ry = -ref.rotate[1] * rad, rz = -ref.rotate[2] * rad, ro = at.rot * rad;
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz), co = Math.cos(ro), so = Math.sin(ro);
  const turn = (x: number, y: number, z: number): V3 => {
    let t = y * cx - z * sx; z = y * sx + z * cx; y = t;            // about X
    t = x * cy + z * sy; z = -x * sy + z * cy; x = t;               // about Y
    t = x * cz - y * sz; y = x * sz + y * cz; x = t;                // about Z
    return [x, y, z];
  };
  const stand = (x: number, y: number, z: number): V3 => {
    if (at.back) { y = -y; z = -z; }                                // rotateY(180°) · rotateZ(180°): half a turn about X
    return [x * co - y * so, x * so + y * co, z];
  };
  const [sxk, syk, szk] = ref.scale; const p = mesh.pos, n = mesh.nrm;
  for (let i = 0; i < p.length / 3; i++) {
    let [x, y, z] = turn(p[i * 3] * sxk, p[i * 3 + 1] * syk, p[i * 3 + 2] * szk);
    [x, y, z] = stand(x + ref.offset[0], y + ref.offset[1], z + ref.offset[2]);
    // a normal under a non-uniform scale takes the inverse scale; then the same turns
    let [nx, ny, nz] = turn(n[i * 3] / (sxk || 1), n[i * 3 + 1] / (syk || 1), n[i * 3 + 2] / (szk || 1));
    [nx, ny, nz] = stand(nx, ny, nz);
    const l = Math.hypot(nx, ny, nz) || 1;
    each(x + at.x, y + at.y, z + at.z, nx / l, ny / l, nz / l, i);
  }
}

/** A footprint's pad in its own frame (the file's pad (at), millimetres, Y down), as viewer3d/parts.ts localPads gives it. */
export interface FitPad { num: string; x: number; y: number; w: number; h: number; drill: boolean }
export interface ModelFit { ok: boolean; checked: string[]; off: { pad: string; mm: number }[] }

/**
 * Does a model's pins land on the footprint's pads?  Pin 1 alone says little (a header's model turned half a turn
 * about pin 1 still has a pin there), so the pad farthest from pin 1 is checked too: both need a pin of the model
 * on them.  A pin is the model where it meets the board: below the face it sits on for a through-hole pad (the lead
 * through the hole), the bottom 0.3 mm of the part for a surface pad.  Worked in the footprint's own frame, so the
 * footprint's angle does not enter (KiCad turns the model with the footprint).
 */
export function modelFit(mesh: ModelMesh, ref: ModelRef, back: boolean, pads: FitPad[], tol = 0.2): ModelFit | null {
  const real = pads.filter((p) => p.num !== "" && (p.w > 0 || p.h > 0));
  const one = real.find((p) => p.num === "1") || real.slice().sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }))[0];
  if (!one) return null;
  let far: FitPad | null = null, dmax = 0.3;
  for (const p of real) { const d = Math.hypot(p.x - one.x, p.y - one.y); if (d > dmax) { dmax = d; far = p; } }
  if (!far) return null;     // one pad, or every pad on the same spot: nothing to line up
  const lead: number[] = [], foot: number[] = [];
  placeMesh(mesh, ref, { x: 0, y: 0, z: 0, rot: 0, back }, (x, y, z) => {
    const up = back ? -z : z;     // height above the face the part sits on
    if (up < -0.25) lead.push(x, -y); else if (up <= 0.3) foot.push(x, -y);
  });
  const miss = (p: FitPad): number => {
    const pts = p.drill && lead.length ? lead : foot; let best = Infinity;
    for (let i = 0; i < pts.length; i += 2) { const d = Math.hypot(pts[i] - p.x, pts[i + 1] - p.y); if (d < best) best = d; }
    return Math.max(0, best - (Math.max(p.w, p.h) / 2 + tol));
  };
  const off = [one, far].map((p) => ({ pad: p.num, mm: Math.round(miss(p) * 100) / 100 })).filter((o) => o.mm > 0);
  return { ok: !off.length, checked: [one.num, far.num], off };
}

/** The turn about the model's Z (90, 180 or 270 degrees, added to its rotate) that puts its pins on the pads, or null when none does. */
export function modelTurn(mesh: ModelMesh, ref: ModelRef, back: boolean, pads: FitPad[]): number | null {
  for (const d of [180, 90, 270]) {
    const r: ModelRef = { ...ref, rotate: [ref.rotate[0], ref.rotate[1], ((ref.rotate[2] + d + 180) % 360 + 360) % 360 - 180] };
    const f = modelFit(mesh, r, back, pads); if (f && f.ok) return d;
  }
  return null;
}

/** occt-import-js's result for one STEP file, flattened into one mesh. */
export function flattenOcct(result: { success?: boolean; meshes?: any[] }): ModelMesh | null {
  if (!result || !result.success || !Array.isArray(result.meshes)) return null;
  let nv = 0, ni = 0;
  for (const m of result.meshes) { nv += m.attributes.position.array.length / 3; ni += m.index.array.length; }
  if (!nv || !ni) return null;
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let v0 = 0, i0 = 0;
  for (const m of result.meshes) {
    const p = m.attributes.position.array, n = m.attributes.normal ? m.attributes.normal.array : null, ix = m.index.array; const count = p.length / 3;
    pos.set(p, v0 * 3); if (n) nrm.set(n, v0 * 3);
    const base: number[] = Array.isArray(m.color) ? m.color : [0.6, 0.6, 0.62];
    for (let i = 0; i < count; i++) { col[(v0 + i) * 3] = base[0]; col[(v0 + i) * 3 + 1] = base[1]; col[(v0 + i) * 3 + 2] = base[2]; }
    // a face of the solid with a colour of its own: its triangles' corners take it (faces do not share corners)
    for (const f of m.brep_faces || []) {
      if (!Array.isArray(f.color)) continue;
      for (let t = f.first; t <= f.last; t++) for (let k = 0; k < 3; k++) { const vi = v0 + ix[t * 3 + k]; col[vi * 3] = f.color[0]; col[vi * 3 + 1] = f.color[1]; col[vi * 3 + 2] = f.color[2]; }
    }
    for (let i = 0; i < ix.length; i++) idx[i0 + i] = v0 + ix[i];
    v0 += count; i0 += ix.length;
  }
  return { pos, nrm, col, idx };
}

/** "x,y,z" as the server's X-Model-Offset / X-Model-Rotate headers write it. */
function headerXyz(v: string | null): V3 | null {
  const n = String(v ?? "").split(",").map(Number);
  return n.length === 3 && n.every(isFinite) ? [n[0], n[1], n[2]] : null;
}

/**
 * A vendor model the server lined up for its footprint entry (/api/parts/model.step?fit=4, parts/step_fit.rs) with
 * that entry's offset and turn (X-Model-Offset / X-Model-Rotate) applied, for a footprint whose own entry has none
 * (models.ts foreignModel).  Without the headers the model is left as it is.
 */
export function vendorPlaced(mesh: ModelMesh, headers: { get(name: string): string | null }): ModelMesh {
  const offset = headerXyz(headers.get("x-model-offset")), rotate = headerXyz(headers.get("x-model-rotate"));
  if (!offset || !rotate) return mesh;
  const pos = new Float32Array(mesh.pos.length), nrm = new Float32Array(mesh.nrm.length);
  placeMesh(mesh, { url: "", source: "vendor", name: "", offset, rotate, scale: [1, 1, 1] }, { x: 0, y: 0, z: 0, rot: 0, back: false }, (x, y, z, nx, ny, nz, i) => {
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z; nrm[i * 3] = nx; nrm[i * 3 + 1] = ny; nrm[i * 3 + 2] = nz;
  });
  return { pos, nrm, col: mesh.col, idx: mesh.idx };
}

// ---------------------------------------------------------------- the browser half

const RUNTIME = "/static/pyodide/";
const WORKER = `
let occt = null;
self.onmessage = async (e) => {
  const { id, bytes, base } = e.data;
  try {
    if (!occt) { importScripts(base + "occt-import-js.js"); occt = await occtimportjs({ locateFile: (f) => base + f }); }
    const r = occt.ReadStepFile(new Uint8Array(bytes), { linearUnit: "millimeter", linearDeflectionType: "absolute_value", linearDeflection: 0.02, angularDeflection: 0.5 });
    self.postMessage({ id, result: r });
  } catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};`;

export type ModelState = ModelMesh | "missing";

/** Fetches and tessellates models, one at a time, and keeps them for the life of the page. */
export class ModelStore {
  private have = new Map<string, ModelState>();
  private swapped = new Map<string, string>();
  private generated = new Map<string, string>();
  private bodies = new Map<string, string>();
  private asked = new Map<string, Promise<void>>();
  private worker: Worker | null = null;
  private waiting = new Map<number, (r: { result?: any; error?: string }) => void>();
  private seq = 0;
  private dead = false;
  private listeners = new Set<() => void>();

  /** `fn` is called each time a model asked for has come in or turned out to be missing; returns the way to stop. */
  listen(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  /** The mesh when it is here, "missing" when it cannot be had, undefined while unknown or on its way. */
  get(url: string): ModelState | undefined { return this.have.get(url); }

  /** "Library/Name" of the model the server gave in place of the one asked for, when it had to. */
  replacement(url: string): string | undefined { return this.swapped.get(url); }

  /** The package family of a model drawn by the generator (server/src/modelgen), for messages. */
  generatedFamily(url: string): string | undefined { return this.generated.get(url); }

  /** Ask for these models; those not seen before are fetched in the background. */
  want(refs: ModelRef[]): void {
    for (const r of refs) {
      if (r.footprint) this.bodies.set(r.url, r.footprint);
      if (!this.have.has(r.url) && !this.asked.has(r.url)) this.asked.set(r.url, this.load(r.url));
    }
  }

  /** Resolves when everything asked for so far has arrived or failed. */
  async settled(): Promise<void> { while (this.asked.size) await Promise.all(Array.from(this.asked.values())); }

  private async load(url: string): Promise<void> {
    let state: ModelState = "missing";
    try {
      const body = this.bodies.get(url);
      const resp = body !== undefined
        ? await fetch("/api/models/generate", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ footprint: body }) })
        : await fetch(url, { credentials: "same-origin" });
      if (resp.ok) {
        const bytes = await resp.arrayBuffer();
        const mesh = flattenOcct(await this.tessellate(bytes));
        if (mesh) { state = /[?&]placed=1(?:&|$)/.test(url) ? vendorPlaced(mesh, resp.headers) : mesh; const rep = resp.headers.get("x-model-replacement"); if (rep) this.swapped.set(url, rep); const gen = resp.headers.get("x-model-generated"); if (gen) this.generated.set(url, gen); }
      }
    } catch { /* stays missing: the stand-in solid is drawn */ }
    this.have.set(url, state); this.asked.delete(url);
    for (const fn of Array.from(this.listeners)) fn();
  }

  private tessellate(bytes: ArrayBuffer): Promise<any> {
    if (this.dead) return Promise.resolve(null);
    if (!this.worker) {
      try {
        const blob = new Blob([WORKER], { type: "application/javascript" });
        this.worker = new Worker(URL.createObjectURL(blob));
        this.worker.onmessage = (e: MessageEvent) => { const done = this.waiting.get(e.data.id); if (done) { this.waiting.delete(e.data.id); done(e.data); } };
        this.worker.onerror = () => { this.dead = true; for (const done of this.waiting.values()) done({ error: "worker" }); this.waiting.clear(); };
      } catch { this.dead = true; return Promise.resolve(null); }
    }
    const id = ++this.seq; const base = new URL(RUNTIME, location.href).href;
    return new Promise((resolve) => {
      this.waiting.set(id, (r) => resolve(r.error ? null : r.result));
      this.worker!.postMessage({ id, bytes, base }, [bytes]);
    });
  }
}

let shared: ModelStore | null = null;
/** The page's one model store (models are the same for every board and every rebuild). */
export function modelStore(): ModelStore { return shared || (shared = new ModelStore()); }
