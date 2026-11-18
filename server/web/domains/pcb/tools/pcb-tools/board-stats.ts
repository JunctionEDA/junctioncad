// pcb-tools/board-stats.ts — ComputeBoardStatistics and CollectDrillLineItems (pcbnew/board_statistics_report.cpp,
// board_statistics.cpp) for Inspect > Board Statistics, apart from the areas (web/domains/pcb/fab/stats.ts):
//   footprints   THT / SMD / Unspecified on each side, by their attributes; "Exclude footprints with no pads" leaves
//                padless ones out of these and of the pad counts
//   pads         by attribute (Through hole, SMD, Connector, NPTH, Non-component) and by fabrication property
//                (Castellated, Press-fit)
//   vias         Through, Blind, Buried, Micro
//   minimums     the narrowest track or arc, the smallest round drill, and the closest approach of two tracks or vias
//                of different nets on a copper layer they share (their copper edges)
//   drills       one line per hole size, shape, plating, pad or via and layer span, the most used first
import type { BoardDoc, Pt } from "./types";
import { arcPoints, dPS, segSegDist, viaLayers } from "./distances";
import { copperStack } from "./net-lengths";
import { boardOutline } from "./drc";
import { K } from "./state";
import { pt } from "./util";

export interface DrillLine { count: number; shape: "Round" | "Slot"; x: number; y: number; plated: boolean; pad: boolean; start: string; stop: string }
export interface BoardStatsData {
  footprints: { title: string; front: number; back: number }[];
  pads: { title: string; count: number }[]; padTotal: number; padProps: { title: string; count: number }[];
  vias: { title: string; count: number }[]; viaTotal: number;
  minTrackWidth: number | null; minClearance: number | null; minDrill: number | null;
  drills: DrillLine[]; hasOutline: boolean; width: number; height: number;
}

/** a conductor's net, by its code or (newer files) its name; none is the unconnected net */
const netKey = (n: SNode): string => { const c = K.kid(n, "net"); const v = c ? String(c[1]) : "0"; return v === "" ? "0" : v; };
const kidNum = (n: SNode, k: string, i = 1): number => { const c = K.kid(n, k); return c ? K.num(c[i]) : NaN; };

/** CollectDrillLineItems, sorted by DRILL_LINE_ITEM::COMPARE( COL_COUNT, false ): the most used first. */
export function drillLines(doc: BoardDoc): DrillLine[] {
  const copper = copperStack(doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]);
  const out: DrillLine[] = [];
  const put = (d: Omit<DrillLine, "count">): void => {
    const e = out.find((o) => o.x === d.x && o.y === d.y && o.shape === d.shape && o.plated === d.plated && o.pad === d.pad && o.start === d.start && o.stop === d.stop);
    if (e) e.count++; else out.push({ count: 1, ...d });
  };
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") {
      for (const p of K.kids(it.node, "pad")) {
        const dr = K.kid(p, "drill"); if (!dr) continue;
        const nums = dr.slice(1).filter((v) => typeof v === "number" || (typeof v === "string" && /^[\d.]+$/.test(v))).map(Number);
        const oval = dr.includes("oval");
        const xs = nums[0] || 0, ys = oval && nums.length > 1 ? nums[1] : xs;
        if (!(xs > 0) || !(ys > 0)) continue;
        // the pad's copper span: the first and last copper layer of its layer set
        const ls = K.kid(p, "layers"); const names = ls ? ls.slice(1).map(K.str) : [];
        const cu = copper.filter((c) => names.includes(c) || names.includes("*.Cu") || (names.includes("F&B.Cu") && (c === "F.Cu" || c === "B.Cu")));
        put({ shape: oval ? "Slot" : "Round", x: xs, y: ys, plated: K.str(p[2]) !== "np_thru_hole", pad: true, start: cu[0] || "", stop: cu[cu.length - 1] || "" });
      }
    } else if (it.kind === "via") {
      const d = kidNum(it.node, "drill"); if (!(d > 0)) continue;
      const span = copper.filter((c) => viaLayers(it.node, copper).has(c));
      put({ shape: "Round", x: d, y: d, plated: true, pad: false, start: span[0] || "F.Cu", stop: span[span.length - 1] || "B.Cu" });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

interface Conductor { net: string; layers: Set<string>; segs: [Pt, Pt][]; r: number; box: [number, number, number, number] }

export function boardStatsData(doc: BoardDoc, o: { excludeNoPads: boolean }): BoardStatsData {
  const copper = copperStack(doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]);
  const footprints = [{ title: "THT:", front: 0, back: 0 }, { title: "SMD:", front: 0, back: 0 }, { title: "Unspecified:", front: 0, back: 0 }];
  const PAD_TYPES: [string, string][] = [["thru_hole", "Through hole:"], ["smd", "SMD:"], ["connect", "Connector:"], ["np_thru_hole", "NPTH:"], ["", "Non-component:"]];
  const pads = PAD_TYPES.map(([, title]) => ({ title, count: 0 }));
  const padProps = [{ title: "Castellated:", count: 0 }, { title: "Press-fit:", count: 0 }];
  const vias = [{ title: "Through vias:", count: 0 }, { title: "Blind vias:", count: 0 }, { title: "Buried vias:", count: 0 }, { title: "Micro vias:", count: 0 }];
  let minTrack = Infinity;
  const tracks: Conductor[] = [];
  for (const it of doc.items.values()) {
    const n = it.node;
    if (it.kind === "footprint") {
      const pl = K.kids(n, "pad");
      if (o.excludeNoPads && !pl.length) continue;
      const a = K.kid(n, "attr"); const toks = a ? a.slice(1).map(K.str) : [];
      const row = toks.includes("through_hole") ? 0 : toks.includes("smd") ? 1 : 2;
      const side = K.str((K.kid(n, "layer") || [])[1]);
      if (side === "B.Cu") footprints[row].back++; else if (side === "F.Cu" || !side) footprints[row].front++;
      for (const p of pl) {
        const i = PAD_TYPES.findIndex(([t]) => t === K.str(p[2])); if (i >= 0) pads[i].count++;
        const prop = K.str((K.kid(p, "property") || [])[1]);
        if (prop === "pad_prop_castellated") padProps[0].count++; else if (prop === "pad_prop_pressfit") padProps[1].count++;
      }
    } else if (it.kind === "segment" || it.kind === "arc") {
      const w = kidNum(n, "width"); if (w > 0) minTrack = Math.min(minTrack, w);
      const a = pt(n, "start"), b = pt(n, "end"); if (!a || !b) continue;
      let path: Pt[] = [a as Pt, b as Pt];
      if (it.kind === "arc") { const m = pt(n, "mid"); const arc = m && K.arcFrom3(a, m, b); if (arc) path = arcPoints(arc, a, b) as Pt[]; }
      const segs: [Pt, Pt][] = []; for (let i = 1; i < path.length; i++) segs.push([path[i - 1], path[i]]);
      const xs = path.map((q) => q[0]), ys = path.map((q) => q[1]);
      tracks.push({ net: netKey(n), layers: new Set([K.str((K.kid(n, "layer") || [])[1])]), segs, r: (w || 0) / 2, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    } else if (it.kind === "via") {
      const t = n.includes("micro") ? 3 : n.includes("blind") ? 1 : n.includes("buried") ? 2 : 0; vias[t].count++;
      const at = pt(n, "at"); const size = kidNum(n, "size");
      if (at) tracks.push({ net: netKey(n), layers: viaLayers(n, copper), segs: [[at as Pt, at as Pt]], r: (size || 0) / 2, box: [at[0], at[1], at[0], at[1]] });
    }
  }
  // the closest approach of two conductors of different nets that share a layer
  let minClear = Infinity;
  const order = tracks.slice().sort((a, b) => a.box[0] - b.box[0]);
  const maxR = order.reduce((m, t) => Math.max(m, t.r), 0);
  for (let i = 0; i < order.length; i++) {
    const A = order[i];
    for (let j = i + 1; j < order.length; j++) {
      const B = order[j];
      // sweep: B starts further right than A ends plus the best gap so far and the widest copper
      if (B.box[0] - A.box[2] > (isFinite(minClear) ? minClear : 50) + 2 * maxR) break;
      if (A.net === B.net) continue;
      let shared = false; for (const l of A.layers) if (B.layers.has(l)) { shared = true; break; }
      if (!shared) continue;
      if (B.box[1] - A.box[3] > (isFinite(minClear) ? minClear : 50) + 2 * maxR || A.box[1] - B.box[3] > (isFinite(minClear) ? minClear : 50) + 2 * maxR) continue;
      let d = Infinity;
      for (const [a, b] of A.segs) for (const [c, e] of B.segs) d = Math.min(d, a === b && c === e ? Math.hypot(a[0] - c[0], a[1] - c[1]) : c === e ? dPS(c, a, b) : a === b ? dPS(a, c, e) : segSegDist(a, b, c, e));
      minClear = Math.min(minClear, Math.max(0, d - A.r - B.r));
    }
  }
  const drills = drillLines(doc);
  let minDrill = Infinity; for (const d of drills) if (d.shape === "Round") minDrill = Math.min(minDrill, d.x);
  const ol = boardOutline(doc); const pts = ol.outline as Pt[] | null;
  const xs = pts ? pts.map((q) => q[0]) : [], ys = pts ? pts.map((q) => q[1]) : [];
  return {
    footprints, pads, padTotal: pads.reduce((s, p) => s + p.count, 0), padProps, vias, viaTotal: vias.reduce((s, v) => s + v.count, 0),
    minTrackWidth: isFinite(minTrack) ? minTrack : null, minClearance: isFinite(minClear) ? minClear : null, minDrill: isFinite(minDrill) ? minDrill : null,
    drills, hasOutline: !!pts, width: pts ? Math.max(...xs) - Math.min(...xs) : 0, height: pts ? Math.max(...ys) - Math.min(...ys) : 0,
  };
}
export const boardStatsApi = { boardStatsData, drillLines };
