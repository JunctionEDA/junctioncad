// exports/board-geometry.ts — what other domains may import to read a board as geometry.
//
// The electronics domain's documented export surface for "the board as a mechanical object" (server/web/README.md:
// a domain never imports another domain's internals).  Everything here is pure: millimetres, the board
// document's own coordinates (Y down), no DOM, no three.js, so it also runs in a worker and in the node tests.
// The 3D side (meshes, face images, part models) is exports/board3d.ts.
//
//   parseBoard(text) / applyBoardChanges(doc, changes)   a board document in memory, kept current from the
//                                                        collaboration ops (the same code the editor runs)
//   boardShape / boardHoles / assignHoles                 the outline as polygons and the drilled holes, exactly
//                                                        as the 3D viewer draws them
//   itemEdges(item) / boardEdges(doc)                     the Edge.Cuts primitives one by one, each with the id
//                                                        of the graphic it came from (for stable names)
//   footprintHoles(item) / viaHole(item)                  drills with the pad they belong to
//   footprintBody(item)                                   the part on a footprint: outline, height, colour, models
//   footprintCourtyard(item, side)                        the courtyard's extent on a side
//   localPads(item.node)                                  the pads in the footprint's own frame
//   ruleAreas(doc)                                        keep-out areas
//
// The mechanical domain's reader of this is web/domains/mechanical/board/model.ts.
import { arcPoints, type Pt } from "../viewer3d/outline";

export { arcPoints, assignHoles, boardHoles, boardShape, circlePoints, ovalPoints, pointInPolygon, polyArea, type BoardShape, type Hole, type Outline, type Pt } from "../viewer3d/outline";
export { footprintAttrs, footprintBody, type Body, type BodyClass } from "../viewer3d/bodies";
export { localPads, type LocalPad, type Solid } from "../viewer3d/parts";
export type { RGBA } from "../viewer3d/colors";

/** The board document type of this domain's canvas (web/domains/pcb/globals.d.ts KDoc), for callers outside it. */
export type BoardDoc = KDoc;
export type BoardItem = KItem;
/** One item change of a collaboration op on a board (the wire shape of server/src/ws.rs ops). */
export type BoardChange = KChange;

const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);
/** Internal units per millimetre, as the editor passes them to applyChange. */
const IU = 1e6;

function canvas(): KiCadCanvasApi {
  const k = (globalThis as unknown as { KiCadCanvas?: KiCadCanvasApi }).KiCadCanvas;
  if (!k) throw new Error("the board reader (static/kicad-canvas.js) is not loaded");
  return k;
}

/** Parse a .kicad_pcb file. */
export function parseBoard(text: string): BoardDoc { return canvas().parseDoc(text, "pcb"); }

/** Apply the changes of one or more ops, in order.  Returns the ids of the items that changed. */
export function applyBoardChanges(doc: BoardDoc, changes: readonly BoardChange[]): Set<string> {
  const k = canvas(), touched = new Set<string>();
  for (const c of changes) {
    try { if (k.applyChange(doc, c, IU)) touched.add(String(c.id)); }
    catch (e) { touched.add(String(c.id)); }   // a change the reader could not apply: let the caller look at the item again
  }
  return touched;
}

/** One primitive of the board outline, with the graphic it came from. */
export type EdgeSegment = { /** stable: the graphic's uuid, plus an index when one graphic makes several primitives */ id: string; item: string } & (
  | { kind: "line"; a: Pt; b: Pt }
  /** an arc from a to b through mid */
  | { kind: "arc"; a: Pt; b: Pt; mid: Pt; centre: Pt; r: number }
  | { kind: "circle"; centre: Pt; r: number }
);

type RawEdge = { kind: "line"; a: Pt; b: Pt } | { kind: "arc"; a: Pt; b: Pt; mid: Pt; centre: Pt; r: number } | { kind: "circle"; centre: Pt; r: number };

/** The Edge.Cuts primitives of one item (a board graphic, or a footprint that carries a piece of the outline). */
export function itemEdges(item: BoardItem): EdgeSegment[] {
  const base = item.kind === "footprint" && item.ref ? `${item.ref}` : item.id;
  const raw: RawEdge[] = [];
  for (const g of item.geom) {
    if (g.layer !== "Edge.Cuts") continue;
    if (g.t === "line") raw.push({ kind: "line", a: [num(g.x1), num(g.y1)], b: [num(g.x2), num(g.y2)] });
    else if (g.t === "arc") {
      const pts = arcPoints(num(g.x), num(g.y), num(g.r), num(g.a0), num(g.a1), !!g.anticlockwise);
      raw.push({ kind: "arc", a: pts[0], b: pts[pts.length - 1], mid: midOfArc(num(g.x), num(g.y), num(g.r), num(g.a0), num(g.a1), !!g.anticlockwise), centre: [num(g.x), num(g.y)], r: num(g.r) });
    } else if (g.t === "circle") { if (num(g.r) > 0) raw.push({ kind: "circle", centre: [num(g.x), num(g.y)], r: num(g.r) }); }
    else if (g.t === "poly") {
      const pts = ((g.pts as Pt[] | undefined) || []).map((q): Pt => [q[0], q[1]]);
      const n = pts.length; if (n < 2) continue;
      for (let i = 0; i + 1 < n; i++) raw.push({ kind: "line", a: pts[i], b: pts[i + 1] });
      if (g.close && n > 2) raw.push({ kind: "line", a: pts[n - 1], b: pts[0] });
    }
  }
  const out: EdgeSegment[] = raw.map((r, i) => ({ ...r, id: raw.length === 1 ? base : `${base}:${i}`, item: item.id }));
  return out.filter((s) => s.kind === "circle" || Math.hypot(s.a[0] - s.b[0], s.a[1] - s.b[1]) > 1e-6);
}

function midOfArc(cx: number, cy: number, r: number, a0: number, a1: number, anticlockwise: boolean): Pt {
  const TAU = Math.PI * 2, norm = (a: number) => ((a % TAU) + TAU) % TAU;
  const sweep = anticlockwise ? -norm(a0 - a1) : norm(a1 - a0);
  const a = a0 + sweep / 2;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** Every Edge.Cuts primitive of the board. */
export function boardEdges(doc: BoardDoc): EdgeSegment[] {
  const out: EdgeSegment[] = [];
  for (const it of doc.items.values()) out.push(...itemEdges(it));
  return out;
}

/** A drilled hole with the pad it belongs to. */
export interface PadHole {
  /** the pad's number ("1", "A3"; "" for an unnumbered mechanical pad) and its index among the footprint's pads */
  pad: string; padIndex: number;
  x: number; y: number;
  /** drill size: w = h for a round hole; a slot is w × h turned by `rot` degrees (KiCad's sense) */
  w: number; h: number; rot: number; oval: boolean;
  plated: boolean;
}

/** The drills of a footprint's pads (through-hole and NPTH), in pad order. */
export function footprintHoles(item: BoardItem): PadHole[] {
  if (item.kind !== "footprint") return [];
  const numbers: string[] = [];
  for (const c of item.node) if (Array.isArray(c) && c[0] === "pad") numbers.push(typeof c[1] === "string" ? c[1] : String(c[1] ?? ""));
  const by = new Map<number, PadHole>();
  for (const g of item.geom) {
    if (!g.hole || g.layer !== "holes" || g.t !== "pad") continue;
    const w = num(g.w), h = num(g.h, w); if (!(w > 0) || !(h > 0)) continue;
    const i = num(g.padIndex, -1);
    const was = by.get(i);
    // a plated hole is drawn twice (the plating wall, then the drill): the drill is the smaller
    if (was && was.w * was.h <= w * h) continue;
    by.set(i, { pad: numbers[i] ?? "", padIndex: i, x: num(g.x), y: num(g.y), w, h, rot: num(g.rot), oval: g.shape === "oval" && Math.abs(w - h) > 1e-6, plated: !g.npth });
  }
  return Array.from(by.values()).sort((a, b) => a.padIndex - b.padIndex);
}

/** The drill of a through via (blind, buried and micro vias do not pierce the board), or null. */
export function viaHole(item: BoardItem): { x: number; y: number; d: number } | null {
  if (item.kind !== "via") return null;
  for (const g of item.geom) if (g.hole && g.layer === "holes" && g.t === "circle" && num(g.r) > 0) return { x: num(g.x), y: num(g.y), d: 2 * num(g.r) };
  return null;
}

/** The extent of a footprint's courtyard on a side, as the box [x0, y0, x1, y1] in board coordinates, or null. */
export function footprintCourtyard(item: BoardItem, side: "F" | "B"): [number, number, number, number] | null {
  if (item.kind !== "footprint") return null;
  const layer = side === "F" ? "F.CrtYd" : "B.CrtYd";
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const put = (x: number, y: number) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const g of item.geom) {
    if (g.layer !== layer || g.t === "text") continue;
    if (g.t === "line") { put(num(g.x1), num(g.y1)); put(num(g.x2), num(g.y2)); }
    else if (g.t === "poly") for (const p of (g.pts as Pt[] | undefined) || []) put(p[0], p[1]);
    else if (g.t === "circle" || g.t === "arc") { const x = num(g.x), y = num(g.y), r = num(g.r); put(x - r, y - r); put(x + r, y + r); }
  }
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/** A rule area (keep-out) of the board: its outline, its layers and what it keeps out. */
export interface RuleArea { id: string; name: string; layers: string[]; pts: Pt[]; keepout: { tracks: boolean; vias: boolean; pads: boolean; copperpour: boolean; footprints: boolean } }

export function ruleAreas(doc: BoardDoc): RuleArea[] {
  const out: RuleArea[] = [];
  const kid = (n: SNode, k: string): SNode | undefined => n.find((c) => Array.isArray(c) && c[0] === k) as SNode | undefined;
  for (const it of doc.items.values()) {
    if (it.kind !== "zone") continue;
    const ko = kid(it.node, "keepout"); if (!ko) continue;
    const not = (k: string) => { const c = kid(ko, k); return !!c && c[1] === "not_allowed"; };
    const poly = kid(it.node, "polygon"), pts = poly ? kid(poly, "pts") : undefined;
    const xy: Pt[] = pts ? (pts.filter((c) => Array.isArray(c) && c[0] === "xy") as SNode[]).map((c): Pt => [num(c[1]), num(c[2])]) : [];
    const layers: string[] = [];
    for (const c of it.node) if (Array.isArray(c) && (c[0] === "layer" || c[0] === "layers")) for (const l of c.slice(1)) if (typeof l === "string") layers.push(l);
    const name = kid(it.node, "name");
    out.push({ id: it.id, name: name && typeof name[1] === "string" ? name[1] : "", layers, pts: xy, keepout: { tracks: not("tracks"), vias: not("vias"), pads: not("pads"), copperpour: not("copperpour"), footprints: not("footprints") } });
  }
  return out;
}
