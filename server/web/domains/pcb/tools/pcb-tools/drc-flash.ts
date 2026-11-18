// pcb-tools/drc-flash.ts — PCB_VIA::FlashLayer / PAD::FlashLayer for the copper clearance tests.
//
// A via or plated hole with "remove unused layers" has no copper ring on a layer where nothing of its own net connects
// to it (tracks, arcs, vias, pads; zones never count), unless the layer is one of its start / end layers it keeps or
// the zone filler forced it flashed (zone_layer_connections).  On such a layer KiCad's GetEffectiveShape is only the
// drilled hole, and that is what the clearance tests measure.
import type { Conductor, CopperShape, Pt } from "./types";
import { boxGrid, shapeGap } from "./distances";
import { K } from "./state";
import { EPS } from "./transforms";
import { rotator } from "./util";

const flag = (n: SNode, key: string): boolean | null => { const k = K.kid(n, key); if (!k) return null; return k.length < 2 || K.str(k[1]) !== "no"; };

/** The drilled hole of a via or plated pad as a copper shape (a slot is a segment with round ends). */
function holeOf(c: Conductor): CopperShape | null {
  if (c.kind === "via") { const d = c.drill || 0; const a = c.anchors[0]; return d > 0 && a ? { t: "circle", x: a[0], y: a[1], r: d / 2 } : null; }
  if (c.kind !== "pad") return null;
  const p = c.pad; const d = K.kid(p.node, "drill"); if (!d) return null;
  let w: number, h: number;
  if (K.str(d[1]) === "oval") { w = K.num(d[2], 0); h = K.num(d[3], w); } else { w = h = K.num(d[1], 0); }
  if (!(w > 0) || !(h > 0)) return null;
  const half = Math.abs(w - h) / 2; const [dx, dy] = rotator(p.rot)(w >= h ? half : 0, w >= h ? 0 : half);
  const a: Pt = [p.x - dx, p.y - dy], b: Pt = [p.x + dx, p.y + dy];
  return { t: "seg", a, b, r: Math.min(w, h) / 2 };
}

/**
 * The per-layer shape of every conductor that is not flashed on some of its copper layers: conductor → layer → hole
 * shape.  `copper` is the board's copper stack, front to back.
 */
export function unflashedLayers(conds: Conductor[], copper: string[]): Map<Conductor, Map<string, CopperShape>> {
  const out = new Map<Conductor, Map<string, CopperShape>>();
  const cand = conds.filter((c) => c.kind === "via" || (c.kind === "pad" && c.pad.type === "thru_hole"));
  if (!cand.length) return out;
  const grid = boxGrid(conds.filter((c) => c.kind !== "zone"), (c) => c.bbox);
  for (const c of cand) {
    const node = c.kind === "pad" ? c.pad.node : c.item.node;
    const startEnd = flag(node, "start_end_only"), remove = flag(node, "remove_unused_layers");
    if (!remove && !startEnd) continue;
    const keepEnds = !!startEnd || !!flag(node, "keep_end_layers");
    let ends: string[];
    if (c.kind === "via") { const ls = K.kid(node, "layers"); ends = ls ? [K.str(ls[1]), K.str(ls[2])] : [copper[0], copper[copper.length - 1]]; }
    else ends = [copper[0], copper[copper.length - 1]];
    const zlc = K.kid(node, "zone_layer_connections"); const forced = new Set(zlc ? zlc.slice(1).map((x) => K.str(x as SNode)) : []);
    let hole: CopperShape | null | undefined;
    for (const layer of c.layers) {
      if (!/\.Cu$/.test(layer)) continue;
      if (ends.includes(layer) && keepEnds) continue;
      if (!startEnd) {
        if (forced.has(layer)) continue;
        if (c.net && grid.query(c.bbox, EPS).some((o) => o !== c && o.net === c.net && o.layers.has(layer) && shapeGap(o.shape, c.shape) <= EPS)) continue;
      }
      if (hole === undefined) hole = holeOf(c);
      if (!hole) break;
      let m = out.get(c); if (!m) out.set(c, m = new Map()); m.set(layer, hole);
    }
  }
  return out;
}
