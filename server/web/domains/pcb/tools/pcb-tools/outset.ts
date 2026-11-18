// pcb-tools/outset.ts — CONVERT_TOOL::OutsetItems with OUTSET_ROUTINE (pcbnew/tools/convert_tool.cpp,
// item_modification_routine.cpp): exact outsets of pads (rectangle, rounded rectangle, oval, circle) and of graphic
// rectangles, circles, lines and arcs, made as new graphic shapes.
//   rectangle  inflated by the outset; with "Round corners" its corner radius grows by the outset (a rounded result is
//              drawn as its lines and arcs, a square one as a rectangle, rounded outwards to the grid when asked)
//   circle     the radius grows; without "Round corners" the circle's square box is made instead
//   line       the stadium around it (two lines and two arcs), or its square-ended box as a polygon
//   arc        the outer arc, the inner arc and two half-circle end caps (when the radius is at least the outset)
//   pad        its box inflated, with the pad's corner radius (+ the outset) when rounding, turned by the pad angle
// A source is deleted after a successful outset when asked (pads never are: they belong to their footprint).
import type { BoardDoc, PcbChange, Pt } from "./types";
import { addedChange, removedChange } from "./changes";
import { K } from "./state";
import { r6, rotator } from "./util";
import { strokeNode } from "./nodes";

export interface OutsetParams {
  outset: number; roundCorners: boolean; useSourceLayers: boolean; useSourceWidths: boolean;
  layer: string; lineWidth: number; gridRounding: number | null; deleteSourceItems: boolean;
}
/** convert_tool.cpp's two static PARAMETERS: the footprint editor's and the board editor's */
export function outsetDefaults(fpEditor: boolean, lineWidth: (layer: string) => number): OutsetParams {
  return fpEditor
    ? { outset: 0.25, roundCorners: false, useSourceLayers: false, useSourceWidths: true, layer: "F.CrtYd", lineWidth: lineWidth("F.CrtYd"), gridRounding: 0.01, deleteSourceItems: false }
    : { outset: 1, roundCorners: true, useSourceLayers: true, useSourceWidths: true, layer: "Edge.Cuts", lineWidth: lineWidth("Edge.Cuts"), gridRounding: null, deleteSourceItems: false };
}
export interface OutsetResult { changes: PcbChange[]; label: string; message: string | null; select: string[] }

type Seg = { kind: "line"; a: Pt; b: Pt } | { kind: "arc"; c: Pt; start: Pt; angle: number };
const EPS = 1e-9;
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]], sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const len = (v: Pt): number => Math.hypot(v[0], v[1]);
const resize = (v: Pt, l: number): Pt => { const n = len(v); return n ? [v[0] / n * l, v[1] / n * l] : [0, 0]; };
/** RotatePoint( p, c, angle ) in degrees */
const rotAbout = (p: Pt, c: Pt, deg: number): Pt => { const r = rotator(deg)(p[0] - c[0], p[1] - c[1]); return [c[0] + r[0], c[1] + r[1]]; };
/** SHAPE_ARC( center, start, angle ): the end and the mid point */
const arcEnd = (s: Extract<Seg, { kind: "arc" }>): Pt => rotAbout(s.start, s.c, -s.angle);
const arcMid = (s: Extract<Seg, { kind: "arc" }>): Pt => rotAbout(s.start, s.c, -s.angle / 2);

/** KIGEOM::RoundNW / RoundSE: a point rounded up-left / down-right to the grid */
const roundDown = (v: number, g: number): number => Math.floor(v / g + 1e-9) * g, roundUp = (v: number, g: number): number => Math.ceil(v / g - 1e-9) * g;
export function rectRoundedToGridOutwards(r: [number, number, number, number], g: number): [number, number, number, number] {
  return [roundDown(r[0], g), roundDown(r[1], g), roundUp(r[2], g), roundUp(r[3], g)];
}

/** ROUNDRECT::TransformToPolygon's outline: the corners TL TR BR BL, or the sides and corner arcs (clockwise on screen) */
function roundRectChain(x0: number, y0: number, x1: number, y1: number, r: number): { pts: Pt[] } | { segs: Seg[] } | null {
  const w = x1 - x0, h = y1 - y0;
  if (r <= 0) return { pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
  const xe = w - 2 * r, ye = h - 2 * r;
  if (xe < -EPS || ye < -EPS || w <= 0 || h <= 0) return null;
  const segs: Seg[] = [];
  const line = (a: Pt, b: Pt): void => { if (len(sub(b, a)) > EPS) segs.push({ kind: "line", a, b }); };
  // a corner continuing the one before it round the same centre (an oval's end, MakeSideArcCw180) joins it
  const corner = (c: Pt, from: Pt): void => {
    const last = segs[segs.length - 1];
    if (last && last.kind === "arc" && len(sub(last.c, c)) < EPS) last.angle += 90; else segs.push({ kind: "arc", c, start: from, angle: 90 });
  };
  // the corner centres, and the outline from the right of the top-left corner, clockwise on screen
  const tl: Pt = [x0 + r, y0 + r], tr: Pt = [x1 - r, y0 + r], br: Pt = [x1 - r, y1 - r], bl: Pt = [x0 + r, y1 - r];
  line([x0 + r, y0], [x1 - r, y0]); corner(tr, [x1 - r, y0]);
  line([x1, y0 + r], [x1, y1 - r]); corner(br, [x1, y1 - r]);
  line([x1 - r, y1], [x0 + r, y1]); corner(bl, [x0 + r, y1]);
  line([x0, y1 - r], [x0, y0 + r]); corner(tl, [x0, y0 + r]);
  // the last corner and the first one share a centre when the top side has no length
  const f = segs[0], l = segs[segs.length - 1];
  if (segs.length > 1 && f.kind === "arc" && l.kind === "arc" && len(sub(f.c, l.c)) < EPS) { l.angle += f.angle; segs.shift(); }
  return { segs };
}

/** The sweep (degrees, SHAPE_ARC's sense) of an arc from its start through mid to its end, and its centre. */
export function arcThrough(a: Pt, m: Pt, b: Pt): { c: Pt; angle: number } | null {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], m2 = m[0] * m[0] + m[1] * m[1], b2 = b[0] * b[0] + b[1] * b[1];
  const c: Pt = [(a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d, (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d];
  const ang = (p: Pt): number => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const norm = (x: number): number => { while (x < 0) x += 2 * Math.PI; while (x >= 2 * Math.PI) x -= 2 * Math.PI; return x; };
  const toEnd = norm(ang(b) - ang(a)), toMid = norm(ang(m) - ang(a));
  // a RotatePoint by -θ turns +θ in screen atan2 terms
  const sweep = toMid <= toEnd ? toEnd : toEnd - 2 * Math.PI;
  return { c, angle: sweep * 180 / Math.PI };
}

/** OUTSET_ROUTINE::ProcessItem over the selected items. */
export function outsetItems(doc: BoardDoc, ids: string[], p: OutsetParams): OutsetResult {
  const changes: PcbChange[] = [], select: string[] = [];
  let ok = 0, fail = 0;
  const emit = (n: SNode): void => { n.push(["uuid", K.newUuid()]); const c = addedChange(doc, n); changes.push(c); select.push(c.id); };
  for (const id of ids) {
    const it = doc.items.get(id); if (!it) continue;
    const n = it.node;
    const srcLayer = String((K.kid(n, "layer") || [])[1] || p.layer);
    let layer = p.useSourceLayers ? srcLayer : p.layer;
    let width = p.lineWidth;
    if (p.useSourceWidths && it.kind !== "pad") {   // GetBoardItemWidth: a shape's stroke; a pad has none
      const st = K.kid(n, "stroke"), w = st ? K.kid(st, "width") : K.kid(n, "width");
      if (w && isFinite(K.num(w[1]))) width = K.num(w[1]);
    }
    const tail = (): SNode[] => [strokeNode(width), ["fill", "no"], ["layer", layer]];
    const addPolyChain = (pts: Pt[]): void => emit(["gr_poly", ["pts", ...pts.map((q) => ["xy", r6(q[0]), r6(q[1])])], ...tail()]);
    const addSegs = (segs: Seg[]): void => {
      if (!segs.some((s) => s.kind === "arc")) { addPolyChain(segs.map((s) => (s as { a: Pt }).a)); return; }
      for (const s of segs) if (s.kind === "line" && len(sub(s.b, s.a)) > EPS) emit(["gr_line", ["start", r6(s.a[0]), r6(s.a[1])], ["end", r6(s.b[0]), r6(s.b[1])], strokeNode(width), ["layer", layer]]);
      for (const s of segs) {
        if (s.kind !== "arc") continue;
        const e = arcEnd(s), m = arcMid(s); if (len(sub(s.start, s.c)) < EPS || len(sub(e, s.start)) < EPS) continue;
        emit(["gr_arc", ["start", r6(s.start[0]), r6(s.start[1])], ["mid", r6(m[0]), r6(m[1])], ["end", r6(e[0]), r6(e[1])], strokeNode(width), ["layer", layer]]);
      }
    };
    const addRect = (r: [number, number, number, number]): void => {
      const q = p.gridRounding ? rectRoundedToGridOutwards(r, p.gridRounding) : r;
      emit(["gr_rect", ["start", r6(q[0]), r6(q[1])], ["end", r6(q[2]), r6(q[3])], ...tail()]);
    };
    const addCircleOrRect = (c: Pt, r: number): void => {
      if (p.roundCorners) emit(["gr_circle", ["center", r6(c[0]), r6(c[1])], ["end", r6(c[0] + r), r6(c[1])], ...tail()]);
      else addRect([c[0] - r, c[1] - r, c[0] + r, c[1] + r]);
    };
    const chainOrRect = (ch: ReturnType<typeof roundRectChain>, turn: (q: Pt) => Pt): void => {
      if (!ch) return;
      if ("pts" in ch) addPolyChain(ch.pts.map(turn));
      else addSegs(ch.segs.map((s): Seg => (s.kind === "line" ? { kind: "line", a: turn(s.a), b: turn(s.b) } : { kind: "arc", c: turn(s.c), start: turn(s.start), angle: s.angle })));
    };

    if (it.kind === "pad") {
      // PADSTACK::ForEachUniqueLayer of a normal padstack: F_Cu
      if (p.useSourceLayers) layer = "F.Cu";
      const shape = String(n[3] || ""), at = K.kid(n, "at"), size = K.kid(n, "size");
      const pos: Pt = at ? [K.num(at[1]), K.num(at[2])] : [0, 0], rot = at && at.length > 3 ? K.num(at[3]) || 0 : 0;
      const sz: Pt = size ? [K.num(size[1]), K.num(size[2])] : [0, 0];
      const dr = K.kid(n, "drill"), off = dr ? K.kid(dr, "offset") : null;
      const o: Pt = off ? [K.num(off[1]), K.num(off[2])] : [0, 0];
      if (shape === "rect" || shape === "roundrect" || shape === "oval") {
        const x0 = pos[0] - sz[0] / 2 + o[0] - p.outset, y0 = pos[1] - sz[1] / 2 + o[1] - p.outset;
        const x1 = x0 + sz[0] + 2 * p.outset, y1 = y0 + sz[1] + 2 * p.outset;
        if (x1 - x0 <= 0 || y1 - y0 <= 0) fail++;
        else {
          let radius = p.outset;
          if (shape === "roundrect") { const rr = K.kid(n, "roundrect_rratio"); radius += (rr ? K.num(rr[1]) : 0.25) * Math.min(sz[0], sz[1]); }
          else if (shape === "oval") radius += Math.min(sz[0], sz[1]) / 2;
          radius = p.roundCorners ? Math.max(radius, 0) : 0;
          chainOrRect(roundRectChain(x0, y0, x1, y1, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2)), (q) => rotAbout(q, pos, rot));
          ok++;
        }
      } else if (shape === "circle") {
        const r = sz[0] / 2 + p.outset;
        if (r <= 0) fail++; else { addCircleOrRect(add(pos, o), r); ok++; }
      }
    } else if (it.kind === "gr_rect") {
      const s = K.kid(n, "start"), e = K.kid(n, "end");
      const a: Pt = s ? [K.num(s[1]), K.num(s[2])] : [0, 0], b: Pt = e ? [K.num(e[1]), K.num(e[2])] : [0, 0];
      let r: [number, number, number, number] = [Math.min(a[0], b[0]) - p.outset, Math.min(a[1], b[1]) - p.outset, Math.max(a[0], b[0]) + p.outset, Math.max(a[1], b[1]) + p.outset];
      if (r[2] - r[0] <= 0 || r[3] - r[1] <= 0) fail++;
      else {
        const cr = K.kid(n, "radius"); let corner = cr ? K.num(cr[1]) || 0 : 0;
        if (p.roundCorners) corner = Math.max(corner + p.outset, 0);
        if (p.gridRounding) r = rectRoundedToGridOutwards(r, p.gridRounding);
        if (corner > 0) chainOrRect(roundRectChain(r[0], r[1], r[2], r[3], Math.min(corner, (r[2] - r[0]) / 2, (r[3] - r[1]) / 2)), (q) => q);
        else emit(["gr_rect", ["start", r6(r[0]), r6(r[1])], ["end", r6(r[2]), r6(r[3])], ...tail()]);
        ok++;
      }
    } else if (it.kind === "gr_circle") {
      const c = K.kid(n, "center"), e = K.kid(n, "end");
      const cc: Pt = c ? [K.num(c[1]), K.num(c[2])] : [0, 0], ee: Pt = e ? [K.num(e[1]), K.num(e[2])] : cc;
      const r = len(sub(ee, cc)) + p.outset;
      if (r <= 0) fail++; else { addCircleOrRect(cc, r); ok++; }
    } else if (it.kind === "gr_line") {
      const s = K.kid(n, "start"), e = K.kid(n, "end");
      const A: Pt = s ? [K.num(s[1]), K.num(s[2])] : [0, 0], B: Pt = e ? [K.num(e[1]), K.num(e[2])] : [0, 0];
      if (p.outset <= 0) fail++;
      else {
        if (p.roundCorners) {
          // KIGEOM::ConvertToChain( SHAPE_SEGMENT ): A - perp, the cap round A, B + perp, the cap round B
          const perp = resize(rotator(90)(B[0] - A[0], B[1] - A[1]) as Pt, p.outset);
          const capA: Seg = { kind: "arc", c: A, start: sub(A, perp), angle: 180 }, capB: Seg = { kind: "arc", c: B, start: add(B, perp), angle: 180 };
          addSegs([capA, { kind: "line", a: arcEnd(capA), b: add(B, perp) }, capB, { kind: "line", a: arcEnd(capB), b: sub(A, perp) }]);
        } else {
          const ext = resize(sub(B, A), p.outset), perp = rotator(90)(ext[0], ext[1]) as Pt;
          addPolyChain([add(sub(A, ext), perp), sub(sub(A, ext), perp), sub(add(B, ext), perp), add(add(B, ext), perp)]);
        }
        ok++;
      }
    } else if (it.kind === "gr_arc") {
      const s = K.kid(n, "start"), m = K.kid(n, "mid"), e = K.kid(n, "end");
      if (s && m && e) {
        let a: Pt = [K.num(s[1]), K.num(s[2])], b: Pt = [K.num(e[1]), K.num(e[2])];
        const mid: Pt = [K.num(m[1]), K.num(m[2])];
        let g = arcThrough(a, mid, b);
        // EDA_SHAPE keeps its arcs with a positive angle: a reversed one is the same arc from its other end
        if (g && g.angle < 0) { [a, b] = [b, a]; g = arcThrough(a, mid, b); }
        if (g && len(sub(a, g.c)) >= p.outset) {
          const norm = resize(sub(a, g.c), p.outset);
          const outer: Extract<Seg, { kind: "arc" }> = { kind: "arc", c: g.c, start: add(a, norm), angle: g.angle };
          const inner: Extract<Seg, { kind: "arc" }> = { kind: "arc", c: g.c, start: sub(a, norm), angle: g.angle };
          const segs: Seg[] = [outer, { kind: "arc", c: b, start: arcEnd(outer), angle: 180 }];
          if (len(sub(inner.start, g.c)) > EPS) segs.push({ kind: "arc", c: g.c, start: arcEnd(inner), angle: -g.angle });
          segs.push({ kind: "arc", c: a, start: inner.start, angle: 180 });
          addSegs(segs); ok++;
        }
      }
    }
    // the routine's counts run over all the items so far; a pad is never removed (it belongs to its footprint)
    if (p.deleteSourceItems && ok > 0 && fail === 0 && it.kind !== "pad") changes.push(removedChange(it));
  }
  const message = ok === 0 ? "Unable to outset the selected items." : fail > 0 ? "Some of the items could not be outset." : null;
  return { changes: ok ? changes : [], label: "Outset Items", message, select: ok ? select : [] };
}
export const outsetApi = { outsetItems, outsetDefaults, arcThrough, rectRoundedToGridOutwards };
