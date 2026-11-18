// exchange-step.ts — STEP and BREP files in and out of the kernel (worker side).
//
// What this kernel build has, checked against replicad_single.d.ts (OpenCascade 8.0):
//   • STEPControl_Writer / STEPControl_Reader: plain shapes, AP214 or AP242, any length unit.
//   • STEPCAFControl_Writer + an XDE document (TDocStd_Document, XCAFDoc_ShapeTool / ColorTool, TDataStd_Name):
//     one named product per part, with a surface colour.  Used for export.
//   • NOT STEPCAFControl_Reader: names and colours are not read back by the kernel.  Product names come from
//     reading the file's text instead (exchange-stepinfo.ts).
//   • BREP: BRepToolsWrapper.Write / Read (OpenCascade's own text format).  BRep_Builder is not bound, so
//     BRepTools.Read cannot be used; the wrapper can.
//   • NOT IGES (no IGESControl_* classes in this build).
//
// The kernel reads and writes files on Emscripten's in-memory file system (`oc.FS`).  A file is written there,
// handed to OpenCascade and removed at once, so one copy of a large file lives in the wasm heap only while it
// is being read or written.
import type { Kernel } from "../occ";
import type { Shape } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export type LengthUnit = "mm" | "cm" | "m" | "in";
/** millimetres per unit */
export const UNIT_MM: Record<LengthUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };
/** the names OpenCascade's `write.step.unit` takes */
const STEP_UNIT: Record<LengthUnit, string> = { mm: "MM", cm: "CM", m: "M", in: "INCH" };

export interface ExportPart {
  id: string;
  name: string;
  shape: Shape;
  /** sRGB, 0..1 */
  color?: [number, number, number] | null;
}

export interface StepWriteOptions {
  /** the application protocol: AP214 (the common default) or AP242 (managed model based 3D engineering) */
  schema?: "AP214" | "AP242";
  unit?: LengthUnit;
  /** false writes plain shapes (one STEP shape per part, no names or colours) */
  names?: boolean;
}

let seq = 0;
const tmpName = (ext: string) => `/junction-exchange-${Date.now().toString(36)}-${++seq}.${ext}`;

function readOut(oc: Any, file: string): Uint8Array {
  try { return oc.FS.readFile(file) as Uint8Array; } finally { try { oc.FS.unlink(file); } catch (x) { /* not written */ } }
}

/** OpenCascade's write statics are global: set the ones this export needs, every time. */
function setWriteStatics(oc: Any, o: StepWriteOptions): void {
  oc.Interface_Static.SetCVal("write.step.schema", o.schema === "AP242" ? "AP242DIS" : "AP214IS");
  oc.Interface_Static.SetCVal("write.step.unit", STEP_UNIT[o.unit || "mm"]);
  oc.Interface_Static.SetCVal("write.step.product.name", "Junction part");
}

/**
 * A STEP file of the parts.  With `names` (the default) every part is its own named product, with its colour
 * when it has one; the file opens in other CAD tools as a list of named parts.
 */
export function writeStep(k: Kernel, parts: readonly ExportPart[], o: StepWriteOptions = {}): Uint8Array {
  const oc = k.oc as Any;
  if (!parts.length) throw new Error("There is nothing to export.");
  const file = tmpName("step");
  const trash: Any[] = [];
  const t = <T>(x: T): T => { trash.push(x); return x; };
  try {
    if (o.names === false) {
      const w = t(new oc.STEPControl_Writer());
      setWriteStatics(oc, o);
      for (const p of parts) {
        const range = t(new oc.Message_ProgressRange());
        const status = w.Transfer(p.shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, range);
        if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error(`“${p.name}” could not be written to STEP.`);
      }
      if (w.Write(file) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error("The STEP file could not be written.");
      return readOut(oc, file);
    }
    const doc = t(new oc.TDocStd_Document(t(new oc.TCollection_ExtendedString("XmlXCAF", true))));
    const main = t(doc.Main());
    const shapes = t(oc.XCAFDoc_DocumentTool.ShapeTool(main));
    const colors = t(oc.XCAFDoc_DocumentTool.ColorTool(main));
    // the document's own unit: the writer converts from it to write.step.unit
    oc.XCAFDoc_DocumentTool.SetLengthUnit(doc, 0.001);
    for (const p of parts) {
      const flat = placed(oc, p.shape);
      if (flat !== p.shape) t(flat);
      const label = t(shapes.AddShape(flat, false, false));
      oc.TDataStd_Name.Set(label, t(new oc.TCollection_ExtendedString(p.name || "Part", true)));
      if (p.color) {
        const c = t(new oc.Quantity_Color());
        const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
        // Argb2color reads sRGB bytes and stores linear RGB, which is what the writer expects
        oc.Quantity_Color.Argb2color((byte(p.color[0]) << 16) | (byte(p.color[1]) << 8) | byte(p.color[2]), c);
        colors.SetColor(label, c, oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
      }
    }
    const w = t(new oc.STEPCAFControl_Writer());
    // after the writer: making the first one initialises the STEP statics, which would undo these
    setWriteStatics(oc, o);
    w.SetNameMode(true); w.SetColorMode(true);
    // Perform, not Transfer: Transfer's "multi" argument cannot be passed as null from here, and anything else
    // writes every part to a file of its own
    if (!w.Perform(doc, file, t(new oc.Message_ProgressRange()))) throw new Error("The STEP file could not be written.");
    return readOut(oc, file);
  } finally {
    for (const x of trash.reverse()) { try { x.delete(); } catch (e) { /* owned elsewhere */ } }
  }
}

/**
 * The shape with its placement moved into its geometry.  XDE writes a shape that carries a placement (an
 * imported assembly's parts do) as an assembly of one unnamed component; a part should be one named product.
 * Returns `shape` itself when it has no placement, else a new shape the caller deletes.
 */
function placed(oc: Any, shape: Shape): Shape {
  const loc = shape.Location();
  try {
    if (loc.IsIdentity()) return shape;
    const bare = new oc.TopLoc_Location();
    const base = shape.Located(bare, false), trsf = loc.Transformation();
    const mk = new oc.BRepBuilderAPI_Transform(base, trsf, true, false);
    const out = mk.Shape();
    mk.delete(); trsf.delete(); base.delete(); bare.delete();
    return out;
  } finally { loc.delete(); }
}

/** OpenCascade's own BREP text format: exact geometry, nothing else.  Several parts go in one compound. */
export function writeBrep(k: Kernel, parts: readonly ExportPart[]): Uint8Array {
  const oc = k.oc as Any;
  if (!parts.length) throw new Error("There is nothing to export.");
  let shape: Shape = parts[0].shape, made: Any = null;
  if (parts.length > 1) {
    const builder = new oc.TopoDS_Builder();
    made = new oc.TopoDS_Compound();
    builder.MakeCompound(made);
    for (const p of parts) builder.Add(made, p.shape);
    builder.delete();
    shape = made;
  }
  try { return new TextEncoder().encode(oc.BRepToolsWrapper.Write(shape) as string); } finally { if (made) made.delete(); }
}

export interface ReadResult {
  /** the shape that was read, with its placement applied */
  shape: Shape;
  /** the solids of it, or its shells when it has no solid (a surface model), or itself */
  bodies: Shape[];
  /** for STEP: one entry per transferred root, with the STEP entity number it came from */
  roots: { entity: number; shape: Shape }[];
  ms: number;
}

/**
 * Read a STEP file.  The caller owns every shape in the result (delete them, or hand them to the model).
 * Lengths come out in millimetres whatever the file's unit.
 */
export function readStep(k: Kernel, bytes: Uint8Array): ReadResult {
  const oc = k.oc as Any;
  const t0 = Date.now();
  const file = tmpName("step");
  oc.FS.writeFile(file, bytes);
  const reader = new oc.STEPControl_Reader();
  try {
    const status = reader.ReadFile(file);
    try { oc.FS.unlink(file); } catch (x) { /* gone */ }
    if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error("This is not a STEP file OpenCascade can read (it may be damaged, or another format).");
    const n = reader.NbRootsForTransfer();
    const model = reader.StepModel();
    const roots: ReadResult["roots"] = [];
    for (let i = 1; i <= n; i++) {
      const range = new oc.Message_ProgressRange();
      const ok = reader.TransferRoot(i, range);
      range.delete();
      if (!ok) continue;
      const ent = reader.RootForTransfer(i);
      const entity = model.IdentLabel(ent);
      ent.delete();
      roots.push({ entity, shape: reader.Shape(reader.NbShapes()) });
    }
    model.delete();
    if (!roots.length) throw new Error("The STEP file has no shape in it.");
    const shape = roots.length === 1 ? roots[0].shape : compound(oc, roots.map((r) => r.shape));
    return { shape, bodies: bodiesOf(k, shape), roots, ms: Date.now() - t0 };
  } finally {
    try { oc.FS.unlink(file); } catch (x) { /* gone */ }
    reader.delete();
  }
}

/** Read OpenCascade's BREP text format. */
export function readBrep(k: Kernel, bytes: Uint8Array): ReadResult {
  const oc = k.oc as Any;
  const t0 = Date.now();
  let shape: Shape;
  try { shape = oc.BRepToolsWrapper.Read(new TextDecoder().decode(bytes)); } catch (e) { throw new Error("This is not a BREP file OpenCascade can read."); }
  if (!shape || shape.IsNull()) throw new Error("The BREP file has no shape in it.");
  return { shape, bodies: bodiesOf(k, shape), roots: [], ms: Date.now() - t0 };
}

function compound(oc: Any, shapes: Shape[]): Shape {
  const builder = new oc.TopoDS_Builder();
  const c = new oc.TopoDS_Compound();
  builder.MakeCompound(c);
  for (const s of shapes) builder.Add(c, s);
  builder.delete();
  return c;
}

/** What becomes a body: each solid; with no solid, each shell (a surface model); with neither, the shape. */
export function bodiesOf(k: Kernel, shape: Shape): Shape[] {
  const outer = k.scope; k.scope = null;   // the caller owns these, not whoever is running
  try {
    const solids = k.sub(shape, "solid");
    if (solids.length) return solids;
    const shells = k.sub(shape, "shell");
    if (shells.length) return shells;
    return [shape];
  } finally { k.scope = outer; }
}

/** Which format a file is, from its name and, failing that, its first bytes. */
export function sniffFormat(name: string, head: Uint8Array): "step" | "brep" | "stl" | null {
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || ["", ""])[1].toLowerCase();
  if (ext === "step" || ext === "stp") return "step";
  if (ext === "brep" || ext === "brp") return "brep";
  if (ext === "stl") return "stl";
  const text = new TextDecoder().decode(head.subarray(0, 64));
  if (text.startsWith("ISO-10303-21")) return "step";
  if (/^\s*DBRep_DrawableShape/.test(text) || /^\s*CASCADE Topology/.test(text)) return "brep";
  if (/^solid\s/.test(text)) return "stl";
  return null;
}
