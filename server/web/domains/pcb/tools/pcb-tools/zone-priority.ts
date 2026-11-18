// pcb-tools/zone-priority.ts — AutoAssignZonePriorities (pcbnew/zone_utils.cpp), the Zone Manager's "Automatically
// assign zone priorities" button: every pair of copper zones that overlap on a shared copper layer with different
// nets gets an edge from the zone whose net has more pads and vias inside the overlap (the smaller zone when the
// counts are within 20 % or both zero); a topological order of those edges gives the priorities (the first highest),
// and zones of one net that overlap share their group's highest priority.  Zones are the board's own (rule areas
// and teardrop areas sit out).
import { FillRule, areaPathsD, intersectD, type PathsD } from "clipper2-ts";
import type { BoardDoc } from "./types";
import { K } from "./state";
import { conductors, netTable } from "./netlist";
import { netOf } from "./nets";
import { zoneLayers } from "./nodes";
import { chainPoints } from "./zone-modes";

interface Z { id: string; net: string; layers: Set<string>; outlines: [number, number][][]; bbox: [number, number, number, number]; area: number; prio: number }
interface Edge { higher: Z; lower: Z; diff: number; fromArea: boolean }

const inPoly = (p: number[], poly: number[][]): boolean => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const inZone = (p: number[], z: Z): boolean => z.outlines.some((o) => inPoly(p, o));
const toPaths = (z: Z): PathsD => z.outlines.map((o) => o.map(([x, y]) => ({ x, y })));
const polyArea = (o: number[][]): number => { let a = 0; for (let i = 0, j = o.length - 1; i < o.length; j = i++) a += o[j][0] * o[i][1] - o[i][0] * o[j][1]; return Math.abs(a) / 2; };

/** The eligible zones: copper, no rule area, no teardrop. */
function eligible(doc: BoardDoc): Z[] {
  const NT = netTable(doc), out: Z[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "zone") continue;
    const n = it.node;
    if (K.kid(n, "keepout") || K.kid(n, "attr")) continue;
    const layers = new Set(zoneLayers(n).filter((l) => /\.Cu$/.test(l)));
    if (!layers.size) continue;
    const outlines = K.kids(n, "polygon").map((p) => chainPoints(K.kid(p, "pts")) as [number, number][]).filter((c) => c.length >= 3);
    if (!outlines.length) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of outlines) for (const [x, y] of o) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pr = K.kid(n, "priority");
    out.push({ id: it.id, net: NT.key(netOf(n)), layers, outlines, bbox: [x0, y0, x1, y1], area: outlines.reduce((s, o) => s + polyArea(o), 0), prio: pr ? K.num(pr[1]) : 0 });
  }
  return out;
}

/**
 * The priorities AutoAssignZonePriorities gives, by zone id, or null when it changes nothing (fewer than two zones,
 * no overlaps, or the same priorities).  `current` overrides the priorities the zones start from (the Zone
 * Manager's list order).
 */
export function autoZonePriorities(doc: BoardDoc, current?: Map<string, number>): Map<string, number> | null {
  const zones = eligible(doc);
  if (zones.length < 2) return null;
  if (current) for (const z of zones) if (current.has(z.id)) z.prio = current.get(z.id)!;
  const original = new Map(zones.map((z) => [z, z.prio]));
  // findOverlappingPairs
  const pairs: { a: Z; b: Z; shared: Set<string> }[] = [];
  for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) {
    const a = zones[i], b = zones[j];
    const shared = new Set([...a.layers].filter((l) => b.layers.has(l)));
    if (!shared.size) continue;
    if (a.bbox[2] < b.bbox[0] || b.bbox[2] < a.bbox[0] || a.bbox[3] < b.bbox[1] || b.bbox[3] < a.bbox[1]) continue;
    const inter = intersectD(toPaths(a), toPaths(b), FillRule.EvenOdd, 6);
    if (areaPathsD(inter) !== 0 || inZone(b.outlines[0][0], a) || inZone(a.outlines[0][0], b)) pairs.push({ a, b, shared });
  }
  if (!pairs.length) return null;
  // zones of one net that overlap form a group
  const parent = new Map<Z, Z>(zones.map((z) => [z, z]));
  const find = (z: Z): Z => { let p = parent.get(z)!; if (p !== z) { p = find(p); parent.set(z, p); } return p; };
  for (const p of pairs) if (p.a.net === p.b.net) { const ra = find(p.a), rb = find(p.b); if (ra !== rb) parent.set(rb, ra); }
  // computeConstraint
  const conds = conductors(doc).filter((c) => c.kind === "pad" || c.kind === "via");
  const edges: Edge[] = [];
  for (const p of pairs) {
    if (p.a.net === p.b.net) continue;
    let ca = 0, cb = 0;
    for (const c of conds) {
      const layer = [...c.layers].find((l) => p.shared.has(l)); if (!layer) continue;
      const at = c.anchors[0]; if (!at || !inZone(at, p.a) || !inZone(at, p.b)) continue;
      if (c.net === p.a.net) ca++; else if (c.net === p.b.net) cb++;
    }
    const byArea = (diff: number): Edge | null => {
      if (p.a.area === p.b.area) return null;
      const higher = p.a.area < p.b.area ? p.a : p.b;
      return { higher, lower: higher === p.a ? p.b : p.a, diff, fromArea: true };
    };
    let e: Edge | null;
    if (ca === 0 && cb === 0) e = byArea(0);
    else {
      const diff = Math.abs(ca - cb);
      if (diff / Math.max(ca, cb) < 0.2) e = byArea(diff);
      else { const higher = ca > cb ? p.a : p.b; e = { higher, lower: higher === p.a ? p.b : p.a, diff, fromArea: false }; }
    }
    if (e) edges.push(e);
  }
  // assignPrioritiesFromGraph
  if (edges.length) {
    const sorted = edges.slice().sort((x, y) => (x.fromArea !== y.fromArea ? (x.fromArea ? -1 : 1) : x.diff - y.diff));
    const adj = new Map<Z, Z[]>(), indeg = new Map<Z, number>(zones.map((z) => [z, 0]));
    for (const e of sorted) { if (!adj.has(e.higher)) adj.set(e.higher, []); adj.get(e.higher)!.push(e.lower); indeg.set(e.lower, indeg.get(e.lower)! + 1); }
    const byPrio = (x: Z, y: Z) => x.prio - y.prio;
    let queue = zones.filter((z) => indeg.get(z) === 0).sort(byPrio);
    const order: Z[] = [];
    while (queue.length) {
      const cur = queue.shift()!; order.push(cur);
      for (const nb of (adj.get(cur) || []).slice().sort(byPrio)) { indeg.set(nb, indeg.get(nb)! - 1); if (indeg.get(nb) === 0) queue.push(nb); }
      queue = queue.sort(byPrio);
    }
    if (order.length < zones.length) order.push(...zones.filter((z) => !order.includes(z)).sort(byPrio));
    order.forEach((z, i) => { z.prio = order.length - 1 - i; });
  }
  const groupMax = new Map<Z, number>();
  for (const z of zones) { const r = find(z); groupMax.set(r, Math.max(groupMax.get(r) || 0, z.prio)); }
  for (const z of zones) z.prio = groupMax.get(find(z))!;
  if (!zones.some((z) => z.prio !== original.get(z))) return null;
  return new Map(zones.map((z) => [z.id, z.prio]));
}
