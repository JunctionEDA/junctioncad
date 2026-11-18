// web/domains/pcb/fab/stats — the area figures of Inspect > Board Statistics (ComputeBoardStatistics in
// pcbnew/board_statistics_report.cpp): the board area (outlines, less their cut-outs and the drilled holes when
// "Subtract holes from board area" is set), the front and back copper areas (everything plotted on F.Cu / B.Cu,
// merged, less the holes when "Subtract holes from copper areas" is set) and the front and back footprint areas (the
// courtyards merged, with each plated pad's copper grown by its clearance and each NPTH hole, which take room on both
// sides).
import { boardShape } from "../viewer3d/outline";
import { type BoardModel } from "./model";
import { PlotLog, padPrims, plotLayer, type PlotOptions } from "./plot";
import { primPolys, subtract, union } from "./poly";
import { type Prim, type Pt, area } from "./prims";

export interface StatAreas { hasOutline: boolean; boardArea: number; frontCopper: number; backCopper: number; frontCourtyard: number; backCourtyard: number }
// signed: a merged set's holes run the other way round from its outlines
const total = (polys: Pt[][]): number => Math.abs(polys.reduce((s, p) => s + area(p), 0));

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const kidOf = (n: SNode, k: string): SNode | null => (n.find((c) => Array.isArray(c) && c[0] === k) as SNode | undefined) || null;
/** The pad holes' and via drills' area: SEG length × width plus a round end pair for a slot, π d² / 4 for a round hole. */
export function drilledArea(doc: KDoc): number {
  let a = 0;
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") {
      for (const p of it.node) {
        if (!Array.isArray(p) || p[0] !== "pad") continue;
        const dr = kidOf(p as SNode, "drill"); if (!dr) continue;
        const nums = dr.slice(1).filter((v) => !Array.isArray(v) && isFinite(num(v)) && v !== "oval").map(num);
        const x = nums[0] || 0, y = dr.includes("oval") && nums.length > 1 ? nums[1] : x;
        if (!(x > 0) || !(y > 0)) continue;
        const w = Math.min(x, y), len = Math.abs(x - y);
        a += len * w + Math.PI * 0.25 * w * w;
      }
    } else if (it.kind === "via") {
      const dr = kidOf(it.node, "drill"); const d = dr ? num(dr[1]) : 0;
      if (d > 0) a += Math.PI * 0.25 * d * d;
    }
  }
  return a;
}

const circlePts = (x: number, y: number, r: number): Pt[] => primPolys({ k: "circle", x, y, d: 2 * r })[0] || [];
/** PAD::TransformHoleToPolygon: a round hole, or an oval slot turned with the pad */
function padHolePts(p: { x: number; y: number; rot: number; drill: { w: number; h: number; oval: boolean } | null }): Pt[] | null {
  const dr = p.drill; if (!dr || !(dr.w > 0)) return null;
  const w = dr.w, hgt = dr.oval && dr.h > 0 ? dr.h : dr.w;
  if (Math.abs(w - hgt) < 1e-9) return circlePts(p.x, p.y, w / 2);
  return primPolys({ k: "oval", x: p.x, y: p.y, w, h: hgt, rot: p.rot })[0] || null;
}
const localClearance = (n: unknown): number | null => { if (!Array.isArray(n)) return null; const c = kidOf(n as SNode, "clearance"); return c && isFinite(num(c[1])) ? num(c[1]) : null; };

export function statAreas(m: BoardModel, o: { subtractHolesFromBoard: boolean; subtractHolesFromCopper: boolean; courtyards?: (fp: KItem) => Record<string, Pt[][]>; defaultClearance?: number }): StatAreas {
  const doc = m.doc as unknown as KDoc;
  const shape = boardShape(doc);
  const hasOutline = !shape.fallback && shape.outlines.length > 0;
  let boardArea = 0;
  if (hasOutline) {
    for (const ol of shape.outlines) {
      boardArea += Math.abs(area(ol.contour));
      if (o.subtractHolesFromBoard) for (const c of ol.cutouts) boardArea -= Math.abs(area(c));
    }
    // a pad's hole (a slot: its length by its width, and the round ends) and a via's drill, as KiCad reckons them
    if (o.subtractHolesFromBoard) boardArea -= drilledArea(doc);
  }
  const opt: PlotOptions = { plotReference: true, plotValue: true, subtractMaskFromSilk: false };
  const log = new PlotLog();
  const layerPolys = (layer: string): Pt[][] => {
    let have: Pt[][] = [], add: Pt[][] = [];
    const flush = (): void => { if (add.length) { have = union(have.concat(add)); add = []; } };
    for (const p of plotLayer(m, layer, opt, log)) {
      const polys = primPolys(p); if (!polys.length) continue;
      if (p.clear) { flush(); have = subtract(have, union(polys)); } else add.push(...polys);
    }
    flush(); return have;
  };
  let front = layerPolys("F.Cu"), back = layerPolys("B.Cu");
  if (o.subtractHolesFromCopper) {
    // every pad hole comes off both sides; a via's drill only off the outer layers it reaches (a blind via's one side)
    const frontHoles: Pt[][] = [], backHoles: Pt[][] = [];
    for (const fp of m.footprints) for (const p of fp.pads) { const pts = padHolePts(p); if (pts) { frontHoles.push(pts); backHoles.push(pts); } }
    for (const v of m.vias) {
      if (!(v.drill > 0)) continue;
      const pts = circlePts(v.x, v.y, v.drill / 2);
      if (v.layers.includes("F.Cu")) frontHoles.push(pts);
      if (v.layers.includes("B.Cu")) backHoles.push(pts);
    }
    front = subtract(front, union(frontHoles)); back = subtract(back, union(backHoles));
  }
  // courtyards; a plated pad's copper grown by min( default clearance, its own ) and an NPTH hole, on both sides
  const fc: Pt[][] = [], bc: Pt[][] = [];
  const defClr = o.defaultClearance ?? 0.2;
  for (const fp of m.footprints) for (const p of fp.pads) {
    if (!p.drill || !(p.drill.w > 0)) continue;
    if (p.type !== "np_thru_hole") {
      const own = localClearance(p.node) ?? localClearance(fp.node) ?? defClr, cl = Math.min(defClr, own);
      for (const [layer, list] of [["F.Cu", fc], ["B.Cu", bc]] as [string, Pt[][]][]) {
        const prims: Prim[] = []; padPrims(p, layer, m, prims, 2 * cl);
        for (const pr of prims) list.push(...primPolys(pr).filter((q) => q.length > 2));
      }
    } else { const pts = padHolePts(p); if (pts) { fc.push(pts); bc.push(pts); } }
  }
  if (o.courtyards) for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    const c = o.courtyards(it);
    for (const l of c["F.CrtYd"] || []) if (l.length > 2) fc.push(l);
    for (const l of c["B.CrtYd"] || []) if (l.length > 2) bc.push(l);
  }
  return { hasOutline, boardArea, frontCopper: total(front), backCopper: total(back), frontCourtyard: total(union(fc)), backCourtyard: total(union(bc)) };
}
