// exchange-2d.ts — flat drawings for laser cutters, routers and board outlines: DXF and SVG of a sketch or of
// a planar face's outline.
//
// A drawing is a list of 2D curves in a plane's own coordinates (millimetres): lines, circles and arcs stay
// exact; any other edge (a spline, an ellipse) is a polyline within the chord tolerance.  The writers are pure.
// `faceOutline` (worker) reads a face; `sketchDrawing` (pure) reads a sketch's entities.
import type { Frame, Vec2, Vec3 } from "../../core/geometry";
import { pointOf, type SketchData } from "../../sketch/format";
import type { Kernel } from "../occ";
import type { Shape } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Curve2D =
  | { kind: "line"; a: Vec2; b: Vec2 }
  | { kind: "circle"; c: Vec2; r: number }
  /** counter-clockwise from `start` to `end`, angles in radians */
  | { kind: "arc"; c: Vec2; r: number; start: number; end: number }
  | { kind: "poly"; points: Vec2[]; closed?: boolean };

export interface Drawing { curves: Curve2D[]; /** what it was made from, for the file's name and comments */ title?: string }

const TAU = Math.PI * 2;
const norm = (a: number): number => ((a % TAU) + TAU) % TAU;

/** A sketch's curves (construction geometry left out), in the sketch plane's coordinates. */
export function sketchDrawing(s: SketchData, title?: string): Drawing {
  const curves: Curve2D[] = [];
  for (const id of Object.keys(s.entities).sort()) {
    const e = s.entities[id] as any;
    if (!e || e.construction) continue;
    if (e.type === "line") { const a = pointOf(s, e.a), b = pointOf(s, e.b); if (a && b) curves.push({ kind: "line", a, b }); }
    else if (e.type === "circle") { const c = pointOf(s, e.center); if (c && e.r > 0) curves.push({ kind: "circle", c, r: e.r }); }
    else if (e.type === "arc") {
      const c = pointOf(s, e.center), a = pointOf(s, e.start), b = pointOf(s, e.end);
      if (c && a && b) curves.push({ kind: "arc", c, r: Math.hypot(a[0] - c[0], a[1] - c[1]), start: Math.atan2(a[1] - c[1], a[0] - c[0]), end: Math.atan2(b[1] - c[1], b[0] - c[0]) });
    }
  }
  return { curves, title };
}

/** The bounding box of a drawing: [xmin, ymin, xmax, ymax]. */
export function drawingBounds(d: Drawing): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const pt = (p: Vec2) => { if (p[0] < b[0]) b[0] = p[0]; if (p[1] < b[1]) b[1] = p[1]; if (p[0] > b[2]) b[2] = p[0]; if (p[1] > b[3]) b[3] = p[1]; };
  for (const c of d.curves) {
    if (c.kind === "line") { pt(c.a); pt(c.b); }
    else if (c.kind === "circle") { pt([c.c[0] - c.r, c.c[1] - c.r]); pt([c.c[0] + c.r, c.c[1] + c.r]); }
    else if (c.kind === "arc") {
      const sweep = norm(c.end - c.start) || TAU;
      pt([c.c[0] + c.r * Math.cos(c.start), c.c[1] + c.r * Math.sin(c.start)]);
      pt([c.c[0] + c.r * Math.cos(c.start + sweep), c.c[1] + c.r * Math.sin(c.start + sweep)]);
      for (let q = 0; q < 4; q++) { const a = (q * Math.PI) / 2; if (norm(a - c.start) <= sweep) pt([c.c[0] + c.r * Math.cos(a), c.c[1] + c.r * Math.sin(a)]); }
    } else for (const p of c.points) pt(p);
  }
  if (!Number.isFinite(b[0])) return [0, 0, 0, 0];
  return b;
}

const f = (x: number): string => { const r = Math.round(x * 1e6) / 1e6; return Object.is(r, -0) ? "0" : String(r); };
const DXF_UNITS: Record<string, number> = { mm: 4, cm: 5, m: 6, in: 1 };

/**
 * DXF (AutoCAD R12 ASCII, which every laser and CAM tool reads): LINE, CIRCLE, ARC and POLYLINE on layer 0.
 * `scale` converts millimetres to the file's unit; `$INSUNITS` says which unit that is.
 */
export function writeDxf(d: Drawing, unit: "mm" | "cm" | "m" | "in" = "mm", scale = 1): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => { out.push(String(code), typeof value === "number" ? f(value) : value); };
  const [x0, y0, x1, y1] = drawingBounds(d);
  g(999, `Junction DXF${d.title ? ": " + d.title.replace(/[\r\n]/g, " ") : ""}`);
  g(0, "SECTION"); g(2, "HEADER");
  g(9, "$ACADVER"); g(1, "AC1009");
  g(9, "$INSUNITS"); g(70, DXF_UNITS[unit] ?? 4);
  g(9, "$MEASUREMENT"); g(70, unit === "in" ? 0 : 1);
  g(9, "$EXTMIN"); g(10, x0 * scale); g(20, y0 * scale); g(30, 0);
  g(9, "$EXTMAX"); g(10, x1 * scale); g(20, y1 * scale); g(30, 0);
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LAYER"); g(70, 1); g(0, "LAYER"); g(2, "0"); g(70, 0); g(62, 7); g(6, "CONTINUOUS"); g(0, "ENDTAB");
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  const deg = (a: number) => (norm(a) * 180) / Math.PI;
  for (const c of d.curves) {
    if (c.kind === "line") { g(0, "LINE"); g(8, "0"); g(10, c.a[0] * scale); g(20, c.a[1] * scale); g(30, 0); g(11, c.b[0] * scale); g(21, c.b[1] * scale); g(31, 0); }
    else if (c.kind === "circle") { g(0, "CIRCLE"); g(8, "0"); g(10, c.c[0] * scale); g(20, c.c[1] * scale); g(30, 0); g(40, c.r * scale); }
    else if (c.kind === "arc") { g(0, "ARC"); g(8, "0"); g(10, c.c[0] * scale); g(20, c.c[1] * scale); g(30, 0); g(40, c.r * scale); g(50, deg(c.start)); g(51, deg(c.end)); }
    else {
      g(0, "POLYLINE"); g(8, "0"); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, c.closed ? 1 : 0);
      for (const p of c.points) { g(0, "VERTEX"); g(8, "0"); g(10, p[0] * scale); g(20, p[1] * scale); g(30, 0); }
      g(0, "SEQEND"); g(8, "0");
    }
  }
  g(0, "ENDSEC"); g(0, "EOF");
  return out.join("\n") + "\n";
}

/**
 * SVG at true size (width and height in the unit, a viewBox in the same unit), y up as in the plane: the
 * drawing is flipped so it reads the way the sketch does.  Strokes only; closed outlines are not filled.
 */
export function writeSvg(d: Drawing, unit: "mm" | "cm" | "m" | "in" = "mm", scale = 1, o: { stroke?: number; margin?: number } = {}): string {
  const [x0, y0, x1, y1] = drawingBounds(d).map((v) => v * scale);
  const m = (o.margin ?? 1) * scale, w = Math.max(x1 - x0, 1e-6) + 2 * m, h = Math.max(y1 - y0, 1e-6) + 2 * m;
  const X = (x: number) => f(x * scale - x0 + m), Y = (y: number) => f(y1 + m - y * scale);
  const paths: string[] = [];
  for (const c of d.curves) {
    if (c.kind === "line") paths.push(`<line x1="${X(c.a[0])}" y1="${Y(c.a[1])}" x2="${X(c.b[0])}" y2="${Y(c.b[1])}"/>`);
    else if (c.kind === "circle") paths.push(`<circle cx="${X(c.c[0])}" cy="${Y(c.c[1])}" r="${f(c.r * scale)}"/>`);
    else if (c.kind === "arc") {
      const sweep = norm(c.end - c.start) || TAU;
      const pa = [c.c[0] + c.r * Math.cos(c.start), c.c[1] + c.r * Math.sin(c.start)], pb = [c.c[0] + c.r * Math.cos(c.start + sweep), c.c[1] + c.r * Math.sin(c.start + sweep)];
      // counter-clockwise with y up is clockwise with y down: sweep flag 0
      paths.push(`<path d="M${X(pa[0])} ${Y(pa[1])}A${f(c.r * scale)} ${f(c.r * scale)} 0 ${sweep > Math.PI ? 1 : 0} 0 ${X(pb[0])} ${Y(pb[1])}"/>`);
    } else if (c.points.length > 1) paths.push(`<path d="M${c.points.map((p) => `${X(p[0])} ${Y(p[1])}`).join("L")}${c.closed ? "Z" : ""}"/>`);
  }
  const u = unit === "m" ? "" : unit;   // SVG has no metre unit: plain user units then
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}${u}" height="${f(h)}${u}" viewBox="0 0 ${f(w)} ${f(h)}">\n` +
    (d.title ? `<title>${d.title.replace(/[<&]/g, "")}</title>\n` : "") +
    `<g fill="none" stroke="#000" stroke-width="${f((o.stroke ?? 0.1) * scale)}" stroke-linecap="round" stroke-linejoin="round">\n${paths.join("\n")}\n</g>\n</svg>\n`;
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const onPlane = (fr: Frame, p: Vec3): Vec2 => { const d = sub3(p, fr.origin); return [dot3(d, fr.x), dot3(d, fr.y)]; };

/**
 * The outline of a planar face — its outer boundary and its holes — in the plane `frame` (the face's own,
 * from Kernel.faceFrame, unless given).  Lines, circles and arcs are exact; other edges are polylines.
 */
export function faceOutline(k: Kernel, face: Shape, frame?: Frame | null, tolerance = 0.01): Drawing {
  const oc = k.oc as any;
  const fr = frame || k.faceFrame(face as any);
  if (!fr) throw new Error("Only a flat face can be exported as a drawing.");
  const curves: Curve2D[] = [];
  const T = oc.GeomAbs_CurveType;
  for (const edge of k.sub(face, "edge")) {
    if (oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(edge))) continue;
    const ad = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
    try {
      const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
      const at = (u: number): Vec2 => { const p = ad.Value(u); const out = onPlane(fr, [p.X(), p.Y(), p.Z()]); p.delete(); return out; };
      const type = ad.GetType();
      if (type === T.GeomAbs_Line) { curves.push({ kind: "line", a: at(u0), b: at(u1) }); continue; }
      if (type === T.GeomAbs_Circle) {
        const circ = ad.Circle(), loc = circ.Location(), r = circ.Radius();
        const c = onPlane(fr, [loc.X(), loc.Y(), loc.Z()]);
        loc.delete(); circ.delete();
        if (Math.abs(u1 - u0 - TAU) < 1e-9) { curves.push({ kind: "circle", c, r }); continue; }
        const a = at(u0), b = at(u1), mid = at((u0 + u1) / 2);
        let start = Math.atan2(a[1] - c[1], a[0] - c[0]), end = Math.atan2(b[1] - c[1], b[0] - c[0]);
        const am = Math.atan2(mid[1] - c[1], mid[0] - c[0]);
        // the arc runs counter-clockwise from start to end when the middle lies on that sweep; else the other way
        if (norm(am - start) > norm(end - start)) [start, end] = [end, start];
        curves.push({ kind: "arc", c, r, start, end });
        continue;
      }
      // anything else: enough points that no chord strays further than the tolerance
      const { k: kappa, len } = curvature(ad, u0, u1);
      const n = Math.max(8, Math.min(2000, Math.ceil(len / Math.sqrt((8 * tolerance) / Math.max(1e-9, kappa)))));
      const points: Vec2[] = [];
      for (let i = 0; i <= n; i++) points.push(at(u0 + ((u1 - u0) * i) / n));
      curves.push({ kind: "poly", points });
    } finally { ad.delete(); }
  }
  return { curves };
}

/** A rough largest curvature (1/mm) and the length (mm) of a curve, from points along it (only to choose a step). */
function curvature(ad: any, u0: number, u1: number): { k: number; len: number } {
  const pts: Vec3[] = [];
  for (let i = 0; i <= 16; i++) { const p = ad.Value(u0 + ((u1 - u0) * i) / 16); pts.push([p.X(), p.Y(), p.Z()]); p.delete(); }
  let k = 0;
  for (let i = 1; i < 16; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const ab = Math.hypot(...sub3(b, a)), bc = Math.hypot(...sub3(c, b)), ca = Math.hypot(...sub3(a, c));
    const s = (ab + bc + ca) / 2, area = Math.sqrt(Math.max(0, s * (s - ab) * (s - bc) * (s - ca)));
    if (ab * bc * ca > 0) k = Math.max(k, (4 * area) / (ab * bc * ca));
  }
  const len = pts.slice(1).reduce((n, p, i) => n + Math.hypot(...sub3(p, pts[i])), 0);
  return { k: Math.max(k, 1e-6), len };
}
