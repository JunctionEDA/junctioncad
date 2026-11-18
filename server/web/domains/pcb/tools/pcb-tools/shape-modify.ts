// pcb-tools/shape-modify.ts — EDIT_TOOL's Shape Modification sub-menu on board graphics (pcbnew/tools/edit_tool.cpp,
// item_modification_routine.cpp):
//   ModifyLines        Fillet Lines, Chamfer Lines and Extend Lines to Meet: rectangles and polygons are taken apart
//                      into their edges first, then every pair of lines is handed to the routine (LINE_FILLET_ROUTINE
//                      adds a tangent arc at a shared corner, LINE_CHAMFER_ROUTINE a setback segment,
//                      LINE_EXTENSION_ROUTINE runs two lines to where they meet); lines that shrink to nothing go
//   SimplifyPolygons   SHAPE_POLY_SET::SimplifyOutlines( tolerance ) on graphic polygons and zones
//   BooleanPolygons    Merge / Subtract / Intersect Polygons (POLYGON_*_ROUTINE): the last added shape is the basis
//                      and the property donor, the others are combined into it, every source goes and each outline
//                      of the result becomes a new polygon; a subtract that leaves nothing is run again largest first
// Plain node editing; the changes come back with the routine's commit label and status message.
import { FillRule, differenceD, intersectD, unionD, type PathsD } from "clipper2-ts";
import type { BoardDoc, PcbChange, Pt } from "./types";
import { addedChange, removedChange, replacedChange } from "./changes";
import { closedShapeLoop } from "./convert";
import { K } from "./state";
import { clone, isList, layerOf, pt, r6 } from "./util";

export interface ShapeModifyResult { changes: PcbChange[]; label: string; message: string | null; select: string[] }
const EPS = 1e-6;
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const len = (v: Pt) => Math.hypot(v[0], v[1]);
const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
const strokeOf = (n: SNode): SNode => clone(K.kid(n, "stroke") || ["stroke", ["width", 0.1], ["type", "default"]]);
const lineOf = (a: Pt, b: Pt, like: SNode): SNode => ["gr_line", ["start", r6(a[0]), r6(a[1])], ["end", r6(b[0]), r6(b[1])], strokeOf(like), ["layer", layerOf(like)], ["uuid", K.newUuid()]];

interface Line { id: string | null; a: Pt; b: Pt; like: SNode; deleted: boolean; changed: boolean; item: KItem | null; fresh: SNode | null }

/** GetSharedEndpoints: which ends of the two lines meet (0 start, 1 end), or null. */
function shared(A: Line, B: Line): [0 | 1, 0 | 1] | null {
  if (same(A.a, B.a)) return [0, 0]; if (same(A.a, B.b)) return [0, 1]; if (same(A.b, B.a)) return [1, 0]; if (same(A.b, B.b)) return [1, 1];
  return null;
}
const endOf = (L: Line, e: 0 | 1): Pt => (e ? L.b : L.a);
const setEnd = (L: Line, e: 0 | 1, p: Pt): void => { if (e) L.b = p; else L.a = p; L.changed = true; if (len(sub(L.b, L.a)) < EPS) L.deleted = true; };

/** LINE_FILLET_ROUTINE::ProcessLinePair: the arc of radius r tangent to both lines at their shared corner. */
function filletPair(A: Line, B: Line, r: number, out: SNode[]): boolean | null {
  const s = shared(A, B); if (!s) return null;
  const P = endOf(A, s[0]), fa = endOf(A, (1 - s[0]) as 0 | 1), fb = endOf(B, (1 - s[1]) as 0 | 1);
  const ua = sub(fa, P), ub = sub(fb, P), la = len(ua), lb = len(ub);
  if (la < EPS || lb < EPS) return null;
  const u: Pt = [ua[0] / la, ua[1] / la], v: Pt = [ub[0] / lb, ub[1] / lb];
  const theta = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
  if (theta < 1e-9 || Math.abs(theta - Math.PI) < 1e-9) return null;   // parallel: seg_a.Angle( seg_b ).IsHorizontal()
  const t = r / Math.tan(theta / 2);
  if (t > la + EPS || t > lb + EPS) return false;   // the arc's ends must lie on the lines
  const T1: Pt = [P[0] + u[0] * t, P[1] + u[1] * t], T2: Pt = [P[0] + v[0] * t, P[1] + v[1] * t];
  const bis: Pt = [u[0] + v[0], u[1] + v[1]], lbis = len(bis), d = r / Math.sin(theta / 2) - r;
  const M: Pt = [P[0] + bis[0] / lbis * d, P[1] + bis[1] / lbis * d];
  out.push(["gr_arc", ["start", r6(T1[0]), r6(T1[1])], ["mid", r6(M[0]), r6(M[1])], ["end", r6(T2[0]), r6(T2[1])], strokeOf(A.like), ["layer", layerOf(A.like)], ["uuid", K.newUuid()]]);
  setEnd(A, s[0], T1); setEnd(B, s[1], T2);
  return true;
}
/** LINE_CHAMFER_ROUTINE::ProcessLinePair with a symmetric setback (ComputeChamferPoints). */
function chamferPair(A: Line, B: Line, setback: number, out: SNode[]): boolean | null {
  const s = shared(A, B); if (!s) return null;
  const P = endOf(A, s[0]), fa = endOf(A, (1 - s[0]) as 0 | 1), fb = endOf(B, (1 - s[1]) as 0 | 1);
  const ua = sub(fa, P), ub = sub(fb, P), la = len(ua), lb = len(ub);
  if (la < EPS || lb < EPS || setback > la + EPS || setback > lb + EPS) return false;
  const T1: Pt = [P[0] + ua[0] / la * setback, P[1] + ua[1] / la * setback], T2: Pt = [P[0] + ub[0] / lb * setback, P[1] + ub[1] / lb * setback];
  out.push(lineOf(T1, T2, A.like));
  setEnd(A, s[0], T1); setEnd(B, s[1], T2);
  return true;
}
/** LINE_EXTENSION_ROUTINE::ProcessLinePair: both lines run to where their lines cross, from their far ends. */
function extendPair(A: Line, B: Line): boolean | null {
  const r = sub(A.b, A.a), q = sub(B.b, B.a), den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-12) return null;   // parallel
  const w = sub(B.a, A.a), t = (w[0] * q[1] - w[1] * q[0]) / den, u = (w[0] * r[1] - w[1] * r[0]) / den;
  if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) return null;   // already intersecting
  const X: Pt = [A.a[0] + r[0] * t, A.a[1] + r[1] * t];
  const extend = (L: Line, k: number): void => {
    if (k >= -EPS && k <= 1 + EPS) return;   // already on the line
    const far = len(sub(X, L.a)) < len(sub(X, L.b)) ? L.b : L.a;
    L.a = far; L.b = X; L.changed = true;
  };
  extend(A, t); extend(B, u);
  return true;
}

/** The lines the routines work on: the selected lines, and rectangles and polygons broken into theirs. */
function linesOf(doc: BoardDoc, ids: string[], changes: PcbChange[]): Line[] {
  const lines: Line[] = [];
  for (const id of ids) {
    const it = doc.items.get(id); if (!it) continue;
    if (it.kind === "gr_line") { const a = pt(it.node, "start"), b = pt(it.node, "end"); if (a && b) lines.push({ id, a, b, like: it.node, deleted: false, changed: false, item: it, fresh: null }); continue; }
    if (it.kind !== "gr_rect" && it.kind !== "gr_poly") continue;
    const loop = closedShapeLoop(it) as Pt[] | null; if (!loop || loop.length < 2) continue;
    changes.push(removedChange(it));
    loop.forEach((p, i) => lines.push({ id: null, a: p, b: loop[(i + 1) % loop.length], like: it.node, deleted: false, changed: true, item: null, fresh: null }));
  }
  return lines;
}

const LINE_MSG: Record<string, [string, string, string]> = {
  filletLines: ["Fillet Lines", "Unable to fillet the selected lines.", "Some of the lines could not be filleted."],
  chamferLines: ["Chamfer Lines", "Unable to chamfer the selected lines.", "Some of the lines could not be chamfered."],
  extendLines: ["Extend Lines to Meet", "Unable to extend the selected lines to meet.", "Some of the lines could not be extended to meet."],
};
/**
 * EDIT_TOOL::ModifyLines for filletLines (value: radius), chamferLines (value: setback) and extendLines.  null with
 * `error` when the selection does not qualify (the info-bar message KiCad shows).
 */
export function modifyLines(doc: BoardDoc, ids: string[], op: "filletLines" | "chamferLines" | "extendLines", value: number): ShapeModifyResult | { error: string } {
  const changes: PcbChange[] = [];
  const lines = linesOf(doc, ids, changes);
  if (op === "extendLines" && lines.length !== 2) return { error: "Exactly two lines must be selected to extend them." };
  if (lines.length < 2) return { error: "A shape with at least two lines must be selected." };
  const added: SNode[] = [];
  let ok = 0, fail = 0;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i], B = lines[j]; if (A.deleted || B.deleted) continue;
    const r = op === "filletLines" ? filletPair(A, B, value, added) : op === "chamferLines" ? chamferPair(A, B, value, added) : extendPair(A, B);
    if (r === true) ok++; else if (r === false) fail++;
  }
  const select: string[] = [];
  for (const L of lines) {
    if (L.item) {
      if (L.deleted) changes.push(removedChange(L.item));
      else if (L.changed) { const n = clone(L.item.node); const s = K.kid(n, "start"), e = K.kid(n, "end"); s!.splice(1, 2, r6(L.a[0]), r6(L.a[1])); e!.splice(1, 2, r6(L.b[0]), r6(L.b[1])); changes.push(replacedChange(L.item, n)); select.push(L.item.id); }
    } else if (!L.deleted) { const c = addedChange(doc, lineOf(L.a, L.b, L.like)); changes.push(c); select.push(c.id); }
  }
  for (const n of added) { const c = addedChange(doc, n); changes.push(c); select.push(c.id); }
  const [label, none, some] = LINE_MSG[op];
  const message = ok === 0 ? none : fail > 0 || ok < lines.length - 1 ? some : null;
  return { changes: ok ? changes : [], label, message, select: ok ? select : [] };
}

/** SHAPE_LINE_CHAIN::Simplify( tolerance ) on a closed outline: drop points closer than the tolerance to the line through their neighbours. */
export function simplifyLoop(pts: Pt[], tol: number): Pt[] {
  let out = pts.slice();
  for (let changed = true; changed && out.length > 3;) {
    changed = false;
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const a = out[(i + out.length - 1) % out.length], p = out[i], b = out[(i + 1) % out.length];
      const ab = sub(b, a), L = len(ab);
      const d = L < EPS ? len(sub(p, a)) : Math.abs(ab[0] * (p[1] - a[1]) - ab[1] * (p[0] - a[0])) / L;
      if (d < tol) { out.splice(i, 1); changed = true; i--; }
    }
  }
  return out;
}
/** EDIT_TOOL::SimplifyPolygons on gr_poly and zone outlines (teardrop areas sit out). */
export function simplifyPolygons(doc: BoardDoc, ids: string[], tol: number): ShapeModifyResult {
  const changes: PcbChange[] = [];
  for (const id of ids) {
    const it = doc.items.get(id); if (!it) continue;
    const n = clone(it.node); let did = false;
    const fix = (ptsNode: SNode | null): void => {
      if (!ptsNode || ptsNode.some((c) => isList(c) && c[0] === "arc")) return;
      const pts = (ptsNode.slice(1).filter((c) => isList(c) && c[0] === "xy") as SNode[]).map((c) => [K.num(c[1]), K.num(c[2])] as Pt);
      if (pts.length < 4) return;
      const s = simplifyLoop(pts, tol); if (s.length === pts.length) return;
      ptsNode.splice(1, ptsNode.length - 1, ...s.map((p) => ["xy", r6(p[0]), r6(p[1])])); did = true;
    };
    if (it.kind === "gr_poly") fix(K.kid(n, "pts"));
    else if (it.kind === "zone" && !K.kid(n, "attr")) for (const p of K.kids(n, "polygon")) fix(K.kid(p, "pts"));
    if (did) changes.push(replacedChange(it, n));
  }
  return { changes, label: "Simplify Polygons", message: null, select: [] };
}

const BOOL: Record<string, [string, string, string]> = {
  mergePolygons: ["Merge Polygons", "Unable to merge the selected polygons.", "Some of the polygons could not be merged."],
  subtractPolygons: ["Subtract Polygons", "Unable to subtract the selected polygons.", "Some of the polygons could not be subtracted."],
  intersectPolygons: ["Intersect Polygons", "Unable to intersect the selected polygons.", "Some of the polygons could not be intersected."],
};
/** EDIT_TOOL::BooleanPolygons; `ids` in selection order (the last added is the basis). */
export function booleanPolygons(doc: BoardDoc, ids: string[], op: "mergePolygons" | "subtractPolygons" | "intersectPolygons"): ShapeModifyResult {
  const items = ids.map((id) => doc.items.get(id)).filter((it): it is KItem => !!it && (it.kind === "gr_poly" || it.kind === "gr_rect" || it.kind === "gr_circle"));
  const [label, none] = BOOL[op];
  if (items.length < 2) return { changes: [], label, message: none, select: [] };
  // the last one added goes to the front: the basis and the property donor
  const order = [items[items.length - 1], ...items.slice(0, -1)];
  const paths = (it: KItem): PathsD => { const l = closedShapeLoop(it) as Pt[] | null; return l ? [l.map(([x, y]) => ({ x, y }))] : []; };
  const run = (list: KItem[]): PathsD => {
    let work = paths(list[0]);
    for (const it of list.slice(1)) {
      const p = paths(it);
      work = op === "mergePolygons" ? unionD(work, p, FillRule.NonZero, 6) : op === "subtractPolygons" ? differenceD(work, p, FillRule.NonZero, 6) : intersectD(work, p, FillRule.NonZero, 6);
    }
    return work;
  };
  let result = run(order);
  if (op === "subtractPolygons" && !result.length) {
    // not commutative: try again with the largest shape first
    const area = (it: KItem) => { const b = it.bbox; return b ? (b[2] - b[0]) * (b[3] - b[1]) : 0; };
    result = run(items.slice().sort((a, b) => area(b) - area(a)));
  }
  const donor = order[0].node;
  const changes: PcbChange[] = order.map((it) => removedChange(it)), select: string[] = [];
  // SHAPE_POLY_SET::UnitSet( i ) per outline: the outer contours (positive orientation in clipper's sense) each a polygon
  const outers = result.filter((p) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x * p[i].y - p[i].x * p[j].y); return a > 0; });
  for (const p of outers.length ? outers : result) {
    if (p.length < 3) continue;
    const n: SNode = ["gr_poly", ["pts", ...p.map((q) => ["xy", r6(q.x), r6(q.y)])], strokeOf(donor), clone(K.kid(donor, "fill") || ["fill", "no"]), ["layer", layerOf(donor)], ["uuid", K.newUuid()]];
    const c = addedChange(doc, n); changes.push(c); select.push(c.id);
  }
  if (!select.length) return { changes: [], label, message: none, select: [] };
  return { changes, label, message: null, select };
}
export const shapeModifyApi = { modifyLines, simplifyPolygons, booleanPolygons, simplifyLoop };
