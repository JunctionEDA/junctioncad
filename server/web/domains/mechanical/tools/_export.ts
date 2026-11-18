// _export.ts — what the Export dialog offers and how one export runs: the formats, their options, the file's
// name, and the call into the worker (services/export-*.ts) or, for a sketch, the drawing written here.
import type { GeomRef } from "../core/geometry";
import { sketchDrawing, writeDxf, writeSvg, type Drawing } from "../kernel/ops/exchange-2d";
import { RESOLUTIONS } from "../kernel/ops/exchange-mesh";
import { UNIT_MM, type LengthUnit } from "../kernel/ops/exchange-step";
import type { SketchData } from "../sketch/format";
import type { PartStudio } from "../ui/studio";

export type FormatId = "step" | "stl" | "3mf" | "obj" | "glb" | "brep" | "dxf" | "svg";
export interface Format { id: FormatId; label: string; ext: string; mime: string; kind: "solid" | "mesh" | "flat"; hint: string }

export const FORMATS: readonly Format[] = [
  { id: "step", label: "STEP", ext: ".step", mime: "model/step", kind: "solid", hint: "Exact solids, with part names and colours, for any CAD tool" },
  { id: "stl", label: "STL", ext: ".stl", mime: "model/stl", kind: "mesh", hint: "Triangles, for 3D printing" },
  { id: "3mf", label: "3MF", ext: ".3mf", mime: "model/3mf", kind: "mesh", hint: "Triangles with part names, units and colours, for 3D printing" },
  { id: "obj", label: "OBJ", ext: ".obj", mime: "model/obj", kind: "mesh", hint: "Triangles with normals, for rendering" },
  { id: "glb", label: "glTF", ext: ".glb", mime: "model/gltf-binary", kind: "mesh", hint: "Binary glTF, for the web and rendering" },
  { id: "brep", label: "BREP", ext: ".brep", mime: "application/octet-stream", kind: "solid", hint: "OpenCascade's own exact format" },
  { id: "dxf", label: "DXF", ext: ".dxf", mime: "application/dxf", kind: "flat", hint: "A sketch or a flat face, for laser cutting and board outlines" },
  { id: "svg", label: "SVG", ext: ".svg", mime: "image/svg+xml", kind: "flat", hint: "A sketch or a flat face, at true size" },
];
export const formatOf = (id: FormatId): Format => FORMATS.find((f) => f.id === id) || FORMATS[0];

export type Source = { kind: "sketch"; featureId: string } | { kind: "face"; ref: GeomRef };

export interface ExportOptions {
  format: FormatId;
  /** the parts to export; empty: every part */
  bodies: string[];
  schema: "AP214" | "AP242";
  unit: LengthUnit;
  resolution: "coarse" | "medium" | "fine" | "custom";
  deflection: number;
  angle: number;
  ascii: boolean;
  /** for DXF and SVG */
  source: Source | null;
  /** the file name, without the extension */
  name: string;
}

export const DEFAULTS: Omit<ExportOptions, "bodies" | "source" | "name"> = { format: "step", schema: "AP214", unit: "mm", resolution: "medium", deflection: RESOLUTIONS.medium.deflection, angle: RESOLUTIONS.medium.angleDeg, ascii: false };
const PREFS = "junction.cad.export";

/** The options the dialog opens with: the last ones used, the selected parts, the selected sketch or face. */
export function initialOptions(studio: PartStudio): ExportOptions {
  let saved: Partial<ExportOptions> = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS) || "{}"); } catch (e) { saved = {}; }
  const s = studio.getState();
  const bodies = Array.from(new Set(s.selection.flatMap((p) => ("body" in p ? [p.body] : []))));
  const face = s.selection.find((p) => p.kind === "face");
  const sketchPick = s.selection.find((p) => p.kind === "sketch");
  const selectedSketch = sketchPick && sketchPick.kind === "sketch" ? sketchPick.featureId : s.selectedFeature && s.features.find((f) => f.id === s.selectedFeature && f.featureType === "sketch") ? s.selectedFeature : null;
  const source: Source | null = selectedSketch ? { kind: "sketch", featureId: selectedSketch } : face && face.kind === "face" ? { kind: "face", ref: { kind: "face", body: face.body, name: face.name } } : (() => { const sk = s.features.slice(0, s.rollback).filter((f) => f.featureType === "sketch").pop(); return sk ? { kind: "sketch" as const, featureId: sk.id } : null; })();
  const pick = <K extends keyof ExportOptions>(k: K, ok: (v: unknown) => boolean): ExportOptions[K] => (ok(saved[k]) ? saved[k] : (DEFAULTS as ExportOptions)[k]) as ExportOptions[K];
  const format: FormatId = selectedSketch || (face && s.selection.length === 1) ? (saved.format === "svg" ? "svg" : "dxf") : pick("format", (v) => FORMATS.some((f) => f.id === v));
  return {
    format, bodies, source,
    schema: pick("schema", (v) => v === "AP214" || v === "AP242"),
    unit: pick("unit", (v) => typeof v === "string" && v in UNIT_MM),
    resolution: pick("resolution", (v) => v === "coarse" || v === "medium" || v === "fine" || v === "custom"),
    deflection: pick("deflection", (v) => typeof v === "number" && v > 0),
    angle: pick("angle", (v) => typeof v === "number" && v > 0 && v <= 90),
    ascii: pick("ascii", (v) => typeof v === "boolean"),
    name: defaultName(studio, bodies),
  };
}

export function saveOptions(o: ExportOptions): void {
  const { format, schema, unit, resolution, deflection, angle, ascii } = o;
  try { localStorage.setItem(PREFS, JSON.stringify({ format, schema, unit, resolution, deflection, angle, ascii })); } catch (e) { /* private window */ }
}

/** The document's name, or the one part's name when one part is exported. */
export function defaultName(studio: PartStudio, bodies: readonly string[]): string {
  const doc = (studio.host.doc.path.split("/").pop() || "part").replace(/\.[^.]+$/, "");
  if (bodies.length === 1) { const b = studio.getState().bodies.find((x) => x.id === bodies[0]); if (b) return `${doc} - ${b.name}`; }
  return doc;
}

/** A file name a file system takes, with the format's extension. */
export function fileName(name: string, f: Format): string {
  const clean = name.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim() || "export";
  return clean.toLowerCase().endsWith(f.ext) ? clean : clean + f.ext;
}

/** Why the options cannot be exported, or null. */
export function problem(studio: PartStudio, o: ExportOptions): string | null {
  const s = studio.getState(), f = formatOf(o.format);
  if (f.kind === "flat") {
    if (!o.source) return "Choose a sketch, or select a flat face before opening Export.";
    if (o.source.kind === "sketch" && !s.features.some((x) => x.id === (o.source as { featureId: string }).featureId)) return "That sketch no longer exists.";
    return null;
  }
  if (!s.bodies.length) return "There are no parts to export yet.";
  if (o.bodies.length && !o.bodies.some((id) => s.bodies.some((b) => b.id === id))) return "Choose at least one part.";
  if (f.kind === "mesh" && o.resolution === "custom" && !(o.deflection > 0 && o.angle > 0 && o.angle <= 90)) return "The deflection must be more than 0, and the angle between 0 and 90°.";
  return null;
}

export interface ExportResult { data: Uint8Array | string; name: string; mime: string; bytes: number; ms: number; triangles?: number }

/** Run one export: the worker writes solids and meshes; a sketch's drawing is written here. */
export async function runExport(studio: PartStudio, o: ExportOptions): Promise<ExportResult> {
  const f = formatOf(o.format);
  const t0 = performance.now();
  const name = fileName(o.name, f);
  const bodies = o.bodies.filter((id) => studio.getState().bodies.some((b) => b.id === id));
  if (f.kind === "solid") {
    const r = await studio.kernel.call<{ data: Uint8Array; bytes: number } & Record<string, never>>("export-step", { format: o.format === "brep" ? "brep" : "step", schema: o.schema, unit: o.unit, bodies } as never);
    return { data: r.data, name, mime: f.mime, bytes: r.bytes, ms: performance.now() - t0 };
  }
  if (f.kind === "mesh") {
    const resolution = o.resolution === "custom" ? { deflection: o.deflection, angleDeg: o.angle } : o.resolution;
    const format = o.format === "stl" && o.ascii ? "stl-ascii" : o.format;
    const r = await studio.kernel.call<{ data: Uint8Array; bytes: number; triangles: number } & Record<string, never>>("export-mesh", { format, resolution, unit: o.unit, bodies } as never);
    return { data: r.data, name, mime: f.mime, bytes: r.bytes, ms: performance.now() - t0, triangles: r.triangles };
  }
  const drawing = await drawingOf(studio, o.source!);
  const scale = 1 / UNIT_MM[o.unit];
  const text = o.format === "dxf" ? writeDxf(drawing, o.unit, scale) : writeSvg(drawing, o.unit, scale);
  return { data: text, name, mime: f.mime, bytes: new TextEncoder().encode(text).length, ms: performance.now() - t0 };
}

export async function drawingOf(studio: PartStudio, source: Source): Promise<Drawing> {
  if (source.kind === "sketch") {
    const f = studio.getState().features.find((x) => x.id === source.featureId);
    const data = f && (f.params.sketch as unknown as SketchData | undefined);
    if (!f || !data) throw new Error("That sketch no longer exists.");
    const d = sketchDrawing(data, f.name);
    if (!d.curves.length) throw new Error(`“${f.name}” has nothing drawn in it.`);
    return d;
  }
  return (await studio.kernel.call("export-outline", { face: source.ref })) as unknown as Drawing;
}
