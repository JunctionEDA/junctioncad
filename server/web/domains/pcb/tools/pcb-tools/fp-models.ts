// pcb-tools/fp-models.ts — what PANEL_FP_PROPERTIES_3D_MODEL reads from and writes to a footprint node: its 3D models
// ((model "file" (hide yes) (opacity …) (offset (xyz …)) (scale (xyz …)) (rotate (xyz …)))) and its extruded 3D body
// (format( FOOTPRINT* )'s (model (type extruded) (uuid …) (hide …) (overall_height …) (body_pcb_gap …) (layer …)
// (material …) (color …) (offset …) (scale …) (rotate …))), and PANEL_EMBEDDED_FILES' file list.  A model the person
// did not change keeps its node as it was.  Works on a board footprint and on the Footprint Editor's header alike.
import { K } from "./state";
import { isList, r6 } from "./util";

export interface FpModel { file: string; show: boolean; opacity: number; offset: number[]; scale: number[]; rotate: number[] }
/** EXTRUDED_3D_BODY: layer "auto" (UNDEFINED_LAYER), "pad_bbox" (UNSELECTED_LAYER) or a layer name; color null = unspecified */
export interface FpExtruded { show: boolean; height: number; standoff: number; layer: string; material: "plastic" | "matte" | "metal" | "copper"; color: number[] | null; uuid?: string; offset?: number[]; scale?: number[]; rotate?: number[] }

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);
const yes = (n: SNode | null) => !!n && (n.length < 2 || str(n[1]) !== "no");
const qs = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
function xyz(n: SNode | null, key: string, d: number): number[] { const k = n ? K.kid(n, key) : null; const v = k ? K.kid(k, "xyz") : null; return v ? [num(v[1], d), num(v[2], d), num(v[3], d)] : [d, d, d]; }
const isFileModel = (c: unknown): c is SNode => isList(c) && c[0] === "model" && typeof c[1] === "string";
const isExtruded = (c: unknown): c is SNode => isList(c) && c[0] === "model" && isList(c[1]) && (c[1] as SNode)[0] === "type" && str((c[1] as SNode)[1]) === "extruded";

export function readModels(fp: SNode): FpModel[] {
  return fp.filter(isFileModel).map((m) => {
    const hide = K.kid(m, "hide"), op = K.kid(m, "opacity");
    return { file: str(m[1]), show: !(hide ? yes(hide) : m.includes("hide")), opacity: op ? num(op[1], 1) : 1, offset: xyz(m, "offset", 0), scale: xyz(m, "scale", 1), rotate: xyz(m, "rotate", 0) };
  });
}
export function readExtruded(fp: SNode): FpExtruded | null {
  const m = fp.find(isExtruded); if (!m) return null;
  const c = K.kid(m, "color"), l = K.kid(m, "layer"), mat = str((K.kid(m, "material") || [])[1]);
  return { show: !yes(K.kid(m, "hide")), height: num((K.kid(m, "overall_height") || [])[1], 0), standoff: num((K.kid(m, "body_pcb_gap") || [])[1], 0),
    layer: l ? str(l[1]) : "auto", material: (mat === "matte" || mat === "metal" || mat === "copper" ? mat : "plastic"),
    color: c && typeof c[1] === "number" ? [num(c[1], 0), num(c[2], 0), num(c[3], 0), num(c[4], 1)] : null, uuid: str((K.kid(m, "uuid") || [])[1]) || undefined,
    offset: xyz(m, "offset", 0), scale: xyz(m, "scale", 1), rotate: xyz(m, "rotate", 0) };
}
const xyzT = (v: number[]) => `(xyz ${v.map((x) => r6(x)).join(" ")})`;
export function modelText(m: FpModel): string {
  return `(model ${qs(m.file)}${m.show ? "" : " (hide yes)"}${m.opacity !== 1 ? ` (opacity ${m.opacity.toFixed(4)})` : ""} (offset ${xyzT(m.offset)}) (scale ${xyzT(m.scale)}) (rotate ${xyzT(m.rotate)}))`;
}
export function extrudedText(e: FpExtruded): string {
  const col = e.color ? `(color ${e.color.map((x) => r6(x)).join(" ")})` : "(color unspecified)";
  return `(model (type extruded) (uuid ${qs(e.uuid || K.newUuid())}) (hide ${e.show ? "no" : "yes"}) (overall_height ${r6(e.height)}) (body_pcb_gap ${r6(e.standoff)})`
    + ` (layer ${e.layer === "auto" || e.layer === "pad_bbox" ? e.layer : qs(e.layer)}) (material ${e.material}) ${col}`
    + ` (offset ${xyzT(e.offset || [0, 0, 0])}) (scale ${xyzT(e.scale || [1, 1, 1])}) (rotate ${xyzT(e.rotate || [0, 0, 0])}))`;
}
const modelSig = (m: FpModel) => JSON.stringify([m.file, m.show, +m.opacity.toFixed(4), m.offset.map(r6), m.scale.map(r6), m.rotate.map(r6)]);
const extSig = (e: FpExtruded | null) => (e ? JSON.stringify([e.show, r6(e.height), r6(e.standoff), e.layer, e.material, e.color && e.color.map(r6)]) : "");

/**
 * The footprint node with these models and this extruded body (null: none), in place.  Unchanged models keep their
 * nodes; the body goes before the file models (the writer's order); true when anything changed.
 */
export function writeModels(fp: SNode, models: FpModel[], extruded: FpExtruded | null): boolean {
  let did = false;
  const before = readModels(fp);
  if (models.map(modelSig).join() !== before.map(modelSig).join()) {
    const old = fp.filter(isFileModel);
    const bySig = new Map<string, SNode>(); old.forEach((n, i) => bySig.set(modelSig(before[i]), n));
    const at = old.length ? fp.indexOf(old[0]) : -1;
    for (const n of old) fp.splice(fp.indexOf(n), 1);
    const fresh = models.filter((m) => m.file).map((m) => bySig.get(modelSig(m)) || (K.parse(modelText(m)) as SNode));
    fp.splice(at > 0 ? Math.min(at, fp.length) : fp.length, 0, ...fresh);
    did = true;
  }
  const e0 = readExtruded(fp);
  if (extSig(extruded) !== extSig(e0)) {
    const i = fp.findIndex(isExtruded);
    if (!extruded) { if (i > 0) fp.splice(i, 1); }
    else {
      const node = K.parse(extrudedText({ ...e0, ...extruded, uuid: (e0 && e0.uuid) || extruded.uuid, offset: (e0 && e0.offset) || extruded.offset, scale: (e0 && e0.scale) || extruded.scale, rotate: (e0 && e0.rotate) || extruded.rotate })) as SNode;
      if (i > 0) fp[i] = node;
      else { const first = fp.findIndex(isFileModel); fp.splice(first > 0 ? first : fp.length, 0, node); }
    }
    did = true;
  }
  return did;
}
/** PANEL_EMBEDDED_FILES: the names of the footprint's (embedded_files (file (name …) …)). */
export function embeddedFileNames(fp: SNode): string[] {
  const ef = K.kid(fp, "embedded_files"); return ef ? K.kids(ef, "file").map((f: SNode) => str((K.kid(f, "name") || [])[1])) : [];
}
/** Only removal happens in the dialog: the files not in `keep` go, and an empty list drops (embedded_files). */
export function keepEmbeddedFiles(fp: SNode, keep: string[]): boolean {
  const ef = K.kid(fp, "embedded_files"); if (!ef) return false;
  const names = new Set(keep); let did = false;
  for (let j = ef.length - 1; j >= 1; j--) { const c = ef[j]; if (isList(c) && c[0] === "file" && !names.has(str((K.kid(c, "name") || [])[1]))) { ef.splice(j, 1); did = true; } }
  if (!K.kids(ef, "file").length) { fp.splice(fp.indexOf(ef), 1); did = true; }
  return did;
}
/**
 * PANEL_EMBEDDED_FILES::TransferDataFromWindow for the files added in the dialog: each (file …) form replaces the file of
 * its name or joins (embedded_files …), which is made before the 3D models (format( FOOTPRINT* )) when there is none.
 */
export function addEmbeddedFiles(fp: SNode, files: string[]): boolean {
  if (!files.length) return false;
  let ef = K.kid(fp, "embedded_files");
  if (!ef) { ef = ["embedded_files"]; const m = fp.findIndex((c, j) => j > 1 && isList(c) && c[0] === "model"); fp.splice(m > 0 ? m : fp.length, 0, ef); }
  for (const text of files) {
    const node = K.parse(text) as SNode, name = str((K.kid(node, "name") || [])[1]);
    const i = ef.findIndex((c: unknown, j: number) => j > 0 && isList(c) && c[0] === "file" && str((K.kid(c as SNode, "name") || [])[1]) === name);
    if (i > 0) ef[i] = node; else ef.push(node);
  }
  return true;
}
export const fpModelsApi = { readModels, readExtruded, writeModels, modelText, extrudedText, embeddedFileNames, keepEmbeddedFiles, addEmbeddedFiles };
