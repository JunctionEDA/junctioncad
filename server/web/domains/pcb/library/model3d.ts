// library/model3d.ts — the 3D model side of Footprint Properties, without the DOM (node tests: static/tests/model3d.test.js):
//   FILENAME_RESOLVER::ValidateFileName and where a model path points (KiCad's 3D library, the project, an embedded
//   file, a vendor's model), PANEL_FP_PROPERTIES_3D_MODEL::validateModelExists' four problems, the configured path
//   choices, the picker's file filters, PANEL_PREVIEW_3D_MODEL's spin / wheel steps, and the FPHOLDER board the
//   previews draw a footprint on.

/** Where a model path points, after its ${VAR} / alias is looked at. */
export type ModelTarget =
  | { kind: "kicad"; lib: string; name: string; ext: string }
  | { kind: "project"; path: string }
  | { kind: "embedded"; name: string }
  | { kind: "vendor" }
  | { kind: "other" };

export const EMBED_PREFIX = "kicad-embed://";
/** The versioned 3D library variable this server stands in for (ENV_VAR::GetVersionedEnvVarName( "3DMODEL_DIR" )). */
export const MODEL_DIR_VAR = "KICAD10_3DMODEL_DIR";
const MODEL_DIR_RE = /^\$[{(]KICAD\d*_3DMODEL_DIR[})][\/\\]/;
const PRJ_RE = /^\$[{(]KIPRJMOD[})][\/\\]?/;

/** FILENAME_RESOLVER::ValidateFileName (the Unix build: no forbidden characters beyond the alias rules). */
export function validateModelFileName(name: string): { ok: boolean; hasAlias: boolean } {
  if (!name) return { ok: false, hasAlias: false };
  if (name.startsWith("file://") || name.startsWith(EMBED_PREFIX)) {
    const n = name.startsWith("file://") ? 7 : EMBED_PREFIX.length;
    return { ok: name.length > n && name[n] !== "/", hasAlias: false };
  }
  const aliasStart = name.startsWith(":") ? 1 : 0;
  const aliasEnd = name.indexOf(":", aliasStart);
  if (aliasEnd === name.length - 1) return { ok: false, hasAlias: false };   // names may not end with ':'
  if (aliasEnd >= 0) {
    if (aliasEnd === aliasStart) return { ok: false, hasAlias: false };
    const alias = name.slice(aliasStart, aliasEnd);
    if (/[{}[\]()%~<>"='`;:.,&?/\\|$]/.test(alias)) return { ok: false, hasAlias: false };
    return { ok: !name.slice(aliasEnd + 1).includes("\0"), hasAlias: true };
  }
  return { ok: !name.includes("\0"), hasAlias: false };
}

/** Where a footprint's model path is read from on the server. */
export function modelTarget(path: string): ModelTarget {
  const p = path.trim();
  if (p.startsWith(EMBED_PREFIX)) return { kind: "embedded", name: p.slice(EMBED_PREFIX.length) };
  if (/KICAD_COLLAB_3DMODELS/.test(p)) return { kind: "vendor" };
  if (MODEL_DIR_RE.test(p)) {
    const m = /^([^\/\\]+)\.3dshapes[\/\\]([^\/\\]+)\.([A-Za-z0-9.]+)$/.exec(p.replace(MODEL_DIR_RE, ""));
    return m ? { kind: "kicad", lib: m[1], name: m[2], ext: m[3].toLowerCase() } : { kind: "other" };
  }
  if (PRJ_RE.test(p)) return { kind: "project", path: p.replace(PRJ_RE, "").replace(/\\/g, "/").replace(/^\.\//, "") };
  // a relative path is looked for beside the project first (FILENAME_RESOLVER::ResolvePath)
  if (!/^\$|^[A-Za-z]:[\\/]|^[\\/]|^:|^[a-z]+:\/\//.test(p) && p) return { kind: "project", path: p.replace(/\\/g, "/").replace(/^\.\//, "") };
  return { kind: "other" };
}

export interface ModelEnv {
  /** the project's model files (project-relative paths) */
  projectFiles: string[];
  /** the footprint's embedded file names */
  embedded: string[];
  /** a KiCad 3D library's model names (without extension), null when the library could not be listed here */
  libItems(lib: string): Set<string> | null | undefined;
}
export type ModelProblem = { icon: "" | "warning" | "error"; text: string };

/** The project file a project path names: the file itself, or its STEP sibling for a .wrl (the project keeps the STEP). */
export function projectModelFile(path: string, files: string[]): string | null {
  const low = path.toLowerCase();
  const hit = files.find((f) => f.toLowerCase() === low); if (hit) return hit;
  const stem = low.replace(/\.(wrl|step|stp)$/i, "");
  return files.find((f) => /\.(step|stp)$/i.test(f) && f.toLowerCase().replace(/\.(step|stp)$/i, "") === stem) || null;
}

/** PANEL_FP_PROPERTIES_3D_MODEL::updateValidateStatus; undefined while a library listing is still on its way. */
export function modelProblem(path: string, env: ModelEnv): ModelProblem | undefined {
  if (!path) return { icon: "warning", text: "No filename entered" };
  if (!validateModelFileName(path).ok) return { icon: "error", text: "Illegal filename" };
  const t = modelTarget(path);
  const missing: ModelProblem = { icon: "error", text: "File not found" };
  switch (t.kind) {
    case "embedded": return env.embedded.includes(t.name) ? { icon: "", text: "" } : missing;
    case "vendor": return { icon: "", text: "" };
    case "project": return projectModelFile(t.path, env.projectFiles) ? { icon: "", text: "" } : missing;
    case "kicad": {
      const items = env.libItems(t.lib);
      if (items === undefined) return undefined;
      if (items === null) return { icon: "", text: "" };   // KiCad's library server is out of reach: nothing to say
      return items.has(t.name) ? { icon: "", text: "" } : missing;
    }
    default: return missing;
  }
}

/** PANEL_FP_PROPERTIES_3D_MODEL::updateConfiguredPathChoices: "Automatic", then each 3D search path. */
export function configuredPathChoices(extra: string[] = []): string[] {
  const out = ["Automatic", "${KIPRJMOD}", "${" + MODEL_DIR_VAR + "}"];
  for (const p of extra) if (p && !out.includes(p)) out.push(p);
  return out;
}

/** The picker's file type filters (S3D_CACHE::GetFileFilters with "All supported files" in front). */
export const MODEL_FILTERS: { label: string; exts: string[] }[] = [
  { label: "STEP (*.stp;*.STP;*.step;*.STEP;*.stpZ;*.stpz;*.STPZ;*.step.gz;*.stp.gz)", exts: ["stp", "step", "stpz", "step.gz", "stp.gz"] },
  { label: "VRML 1.0/2.0 (*.wrl;*.WRL)", exts: ["wrl"] },
  { label: "IGES (*.igs;*.IGS;*.iges;*.IGES)", exts: ["igs", "iges"] },
  { label: "X3D (*.x3d;*.X3D)", exts: ["x3d"] },
  { label: "IDF 2.0/3.0 (*.idf;*.IDF;*.emn;*.EMN)", exts: ["idf", "emn"] },
];
export function modelFilterList(): { label: string; exts: string[] | null }[] {
  const all = MODEL_FILTERS.flatMap((f) => f.exts);
  return [{ label: `All supported files (${all.map((e) => "*." + e).join(";")})`, exts: all }, ...MODEL_FILTERS, { label: "All files (*.*)", exts: null }];
}
export function matchesFilter(file: string, exts: string[] | null): boolean {
  if (!exts) return true;
  const low = file.toLowerCase();
  return exts.some((e) => low.endsWith("." + e));
}

// ---------------------------------------------------------------- PANEL_PREVIEW_3D_MODEL steps
export const MAX_SCALE = 10000, MAX_ROTATION = 180, MAX_OFFSET = 1000;
export function normalizeRotation(r: number): number {
  let n = r % (2 * MAX_ROTATION);
  if (n <= -MAX_ROTATION) n += 2 * MAX_ROTATION; else if (n > MAX_ROTATION) n -= 2 * MAX_ROTATION;
  return n === 0 ? 0 : n;
}
/** doIncrementScale / onMouseWheelScale: 0.1 a step, 0.02 with Shift, kept within 1/MAX_SCALE..MAX_SCALE. */
export function stepScale(v: number, sign: number, fine: boolean): number {
  const x = (isFinite(v) ? v : 1) + (fine ? 0.02 : 0.1) * sign;
  return Math.min(MAX_SCALE, Math.max(1 / MAX_SCALE, Math.round(x * 1e6) / 1e6));
}
/** doIncrementRotation: 90° a step, 1° with Shift, normalized to (-180, 180]. */
export function stepRotation(v: number, sign: number, fine: boolean): number {
  return normalizeRotation((isFinite(v) ? v : 0) + (fine ? 1 : 90) * sign);
}
/** doIncrementOffset: 0.5 mm (0.1 fine), or 25 mil (5 fine) in inch and mil units, within ±MAX_OFFSET mm. */
export function stepOffset(mm: number, sign: number, fine: boolean, units: string): number {
  const imperial = units === "in" || units === "mil" || units === "inch" || units === "mils";
  const step = imperial ? 25.4 * (fine ? 5 : 25) / 1000 : fine ? 0.1 : 0.5;
  const x = (isFinite(mm) ? mm : 0) + step * sign;
  return Math.min(MAX_OFFSET, Math.max(-MAX_OFFSET, Math.round(x * 1e6) / 1e6));
}
export const formatScale = (v: number): string => v.toFixed(4);
export const formatRotation = (v: number): string => (v === 0 ? 0 : v).toFixed(2) + "°";

// ---------------------------------------------------------------- the preview's board
export interface PreviewModel { file: string; show: boolean; opacity: number; offset: number[]; scale: number[]; rotate: number[] }
const q = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const n6 = (v: number): string => { const t = (Math.round((isFinite(v) ? v : 0) * 1e6) / 1e6).toString(); return t === "-0" ? "0" : t; };
/** One (model …) node as the footprint writes it (FOOTPRINT::Format). */
export function modelSexpr(m: PreviewModel): string {
  return `(model ${q(m.file)}${m.show ? "" : " (hide yes)"}${m.opacity < 1 ? ` (opacity ${n6(m.opacity)})` : ""} (offset (xyz ${m.offset.map(n6).join(" ")})) (scale (xyz ${m.scale.map(n6).join(" ")})) (rotate (xyz ${m.rotate.map(n6).join(" ")})))`;
}
/** Drop a footprint's own (model …) children from its text, keeping everything else as written. */
export function stripModels(fpText: string): string {
  let out = "", i = 0;
  while (i < fpText.length) {
    const at = fpText.indexOf("(model", i);
    if (at < 0 || !/[\s"]/.test(fpText[at + 6] || "")) { out += fpText.slice(i, at < 0 ? undefined : at + 6); if (at < 0) break; i = at + 6; continue; }
    out += fpText.slice(i, at);
    let depth = 0, j = at, inStr = false;
    for (; j < fpText.length; j++) {
      const c = fpText[j];
      if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === "(") depth++; else if (c === ")") { depth--; if (depth === 0) { j++; break; } }
    }
    i = j;
  }
  return out;
}
/**
 * PANEL_PREVIEW_3D_MODEL's dummy board (BOARD_USE::FPHOLDER): the footprint at the origin, not flipped, with the
 * dialog's model list in place of its own, on a board of the given thickness.  `fpText` null: a bare footprint
 * holding the models only (the picker's preview of one file).
 */
/** `extra`: more footprint children for the preview, such as the extruded 3D body's (model (type extruded) …). */
export function previewBoardText(fpText: string | null, models: PreviewModel[], thickness = 1.6, outline?: [number, number, number, number], extra = ""): string {
  // the bare holder: the 3D viewer draws a footprint's models when it is a part (two pads and a courtyard; bodies.ts)
  const bare = '(footprint "preview" (layer "F.Cu") (attr smd) (fp_rect (start -0.5 -0.5) (end 0.5 0.5) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))'
    + ' (pad "1" smd rect (at 0 0) (size 0.01 0.01) (layers)) (pad "2" smd rect (at 0 0) (size 0.01 0.01) (layers)))';
  const body = fpText ? stripModels(fpText).trim() : bare;
  const close = body.lastIndexOf(")");
  const fp = body.slice(0, close) + (extra ? " " + extra : "") + (models.length ? " " + models.map(modelSexpr).join(" ") : "") + ")";
  // the footprint editor writes no placement; the board wants it at the origin on the front
  const head = fp.slice(0, Math.max(0, fp.search(/\((?:property|pad|fp_|attr|descr|tags|zone|group|model|embedded)\b/)) || fp.length);
  const placed = /\(at\s/.test(head) ? fp : fp.replace(/^\(footprint\s+("(?:[^"\\]|\\.)*"|\S+)/, (m) => m + " (at 0 0)");
  return `(kicad_pcb (version 20250114) (generator "pcbnew") (generator_version "10.0") (general (thickness ${n6(thickness)}) (legacy_teardrops no))`
    + ` (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (9 "F.Adhes" user "F.Adhesive") (11 "B.Adhes" user "B.Adhesive") (13 "F.Paste" user) (15 "B.Paste" user)`
    + ` (5 "F.SilkS" user "F.Silkscreen") (7 "B.SilkS" user "B.Silkscreen") (1 "F.Mask" user) (3 "B.Mask" user) (17 "Dwgs.User" user "User.Drawings")`
    + ` (19 "Cmts.User" user "User.Comments") (25 "Edge.Cuts" user) (27 "Margin" user) (31 "F.CrtYd" user "F.Courtyard") (29 "B.CrtYd" user "B.Courtyard")`
    + ` (35 "F.Fab" user) (33 "B.Fab" user))`
    + ` (net 0 "") ${placed}${outline ? ` (gr_rect (start ${n6(outline[0])} ${n6(outline[1])}) (end ${n6(outline[2])} ${n6(outline[3])}) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts"))` : ""})`;
}
