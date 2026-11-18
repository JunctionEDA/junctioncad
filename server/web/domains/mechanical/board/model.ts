// model.ts — a board as a mechanical object: the outline, the holes and the parts, with names that survive edits.
//
// `BoardReader` reads a board document (through the electronics domain's exports, pcb/exports/board-geometry.ts)
// item by item and keeps what it found, so one moved footprint costs one footprint.  `snapshot()` turns the
// current state into plain JSON in the board's own frame — what the Board feature builds its solids from in the
// worker (features/board-reference.ts, board/brep.ts), what the display model is drawn from (board/display.ts),
// and what the opposite direction (CAD geometry driving the board, mechanical/boardlink) reads.  README.md has
// the frame and the names.
//
// Pure: no DOM, no three.js, no kernel.
import { arcPoints, boardShape, footprintBody, footprintCourtyard, footprintHoles, itemEdges, localPads, pointInPolygon, polyArea, ruleAreas, viaHole, type BoardDoc, type BoardItem, type Body, type EdgeSegment, type PadHole, type Pt, type RuleArea } from "../../pcb/exports/board-geometry";
import { circleThrough, type BoardSnapshot, type SnapHole, type SnapOutline, type SnapPart, type SnapSeg, type SnapshotOptions } from "./snapshot";

export * from "./snapshot";

// ---------------------------------------------------------------- what is read from the document

/** A part on the board, in board document coordinates (millimetres, Y down). */
export interface BoardComponent {
  /** the footprint's uuid */
  id: string;
  /** reference designator ("J1") */
  ref: string;
  value: string;
  /** library footprint name ("Connector_USB:USB_C_Receptacle_…") */
  lib: string;
  side: "front" | "back";
  x: number; y: number; rot: number;
  /** the part itself, as the 3D viewer draws it; null for a footprint with no part on it (a mounting hole, a logo) */
  body: Body | null;
  /** how far the part stands off its face of the board, mm (0 when there is no part) */
  height: number;
  /**
   * The part's envelope in the footprint's own frame (millimetres from its anchor, before its rotation, Y down as
   * KiCad draws a footprint): a box, or a circle for a round part.  Null when there is no part.
   */
  box: PartBox | null;
  /** the courtyard's extent on the footprint's own side [x0, y0, x1, y1], or null */
  courtyard: [number, number, number, number] | null;
  holes: PadHole[];
}

/** What an update changed, so each consumer does only its share of the work. */
export interface BoardDelta {
  /** the whole document was (re)loaded */
  all: boolean;
  /** an Edge.Cuts graphic was added, removed or changed */
  outline: boolean;
  /** a drill was added, removed, moved or resized (pads and vias) */
  holes: boolean;
  /** footprints added, changed or removed, by uuid */
  components: Set<string>;
  /** anything drawn on a face may have changed (copper, silk, mask): the face images are stale */
  artwork: boolean;
  /** which faces that is: the front's image, the back's */
  front: boolean; back: boolean;
}

/** A part's envelope in its footprint's frame. */
export interface PartBox { x0: number; y0: number; x1: number; y1: number; round?: { x: number; y: number; r: number } }
/** A part's envelope and height as measured from its loaded 3D model (board/display.ts reports them). */
export interface Measured { key: string; box: PartBox; height: number }

interface ItemCache { edges: EdgeSegment[]; edgeKey: string; component: BoardComponent | null; holeKey: string; via: { x: number; y: number; d: number } | null; /** the faces the item draws on: 1 front, 2 back */ sides: number }

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

function readItem(item: BoardItem, doc: BoardDoc): ItemCache {
  const edges = itemEdges(item);
  let component: BoardComponent | null = null;
  if (item.kind === "footprint") {
    const back = item.layer === "B.Cu";
    let body: Body | null = null;
    try { body = footprintBody(item, false, (doc as BoardDoc & { embeddedFiles?: SNode | null }).embeddedFiles || null); } catch (e) { body = null; }
    let height = 0, box: PartBox | null = null;
    if (body) {
      height = body.height;
      for (const s of body.solids || []) height = Math.max(height, s.k === "prism" ? s.z1 : s.k === "cyl" ? s.z + s.r : Math.max(...s.outer.map((p) => p[1])));
      box = bodyBox(item, body);
    }
    component = { id: item.id, ref: item.ref || "", value: item.value || "", lib: item.lib || "", side: back ? "back" : "front", x: item.x || 0, y: item.y || 0, rot: item.rot || 0, body, height, box, courtyard: footprintCourtyard(item, back ? "B" : "F"), holes: footprintHoles(item) };
  }
  const via = viaHole(item);
  const holeKey = component ? component.holes.map((h) => [h.padIndex, r4(h.x), r4(h.y), r4(h.w), r4(h.h), r4(h.rot), h.plated ? 1 : 0].join(",")).join(";") : via ? [r4(via.x), r4(via.y), r4(via.d)].join(",") : "";
  // which face images the item is on: front layers, back layers, or both for what goes through (drills, the outline)
  let sides = 0;
  for (const g of item.geom) { const l = g.layer; sides |= l.startsWith("F.") ? 1 : l.startsWith("B.") ? 2 : l === "holes" || l === "Edge.Cuts" ? 3 : 0; if (sides === 3) break; }
  return { edges, edgeKey: edges.length ? JSON.stringify(edges) : "", component, holeKey, via, sides };
}

/** A board point in a footprint's own frame, and back (the canvas's rotation convention, as viewer3d/bodies.ts). */
export function toFootprint(c: { x: number; y: number; rot: number }, p: Pt): Pt {
  const a = (c.rot * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a), dx = p[0] - c.x, dy = p[1] - c.y;
  return [dx * co - dy * si, dx * si + dy * co];
}
export function fromFootprint(c: { x: number; y: number; rot: number }, p: Pt): Pt {
  const a = (c.rot * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
  return [c.x + p[0] * co + p[1] * si, c.y - p[0] * si + p[1] * co];
}

/**
 * The envelope of a part from what its footprint draws: the body outline the 3D viewer's stand-in uses (the
 * courtyard or the fabrication outline), or the extent of the pads when that outline is only a marker (vendor
 * footprints often draw nothing but a pin-1 dot on F.Fab).
 */
function bodyBox(item: BoardItem, body: Body): PartBox {
  const at = { x: item.x || 0, y: item.y || 0, rot: item.rot || 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of body.pts) { const [lx, ly] = toFootprint(at, p); x0 = Math.min(x0, lx); x1 = Math.max(x1, lx); y0 = Math.min(y0, ly); y1 = Math.max(y1, ly); }
  let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
  for (const pad of localPads(item.node)) { px0 = Math.min(px0, pad.x - pad.w / 2); px1 = Math.max(px1, pad.x + pad.w / 2); py0 = Math.min(py0, pad.y - pad.h / 2); py1 = Math.max(py1, pad.y + pad.h / 2); }
  const area = (x1 - x0) * (y1 - y0), padArea = px1 > px0 && py1 > py0 ? (px1 - px0) * (py1 - py0) : 0;
  if (!(area > 0) || area < 0.3 * padArea) return { x0: r4(px0), y0: r4(py0), x1: r4(px1), y1: r4(py1) };
  const box: PartBox = { x0: r4(x0), y0: r4(y0), x1: r4(x1), y1: r4(y1) };
  if (body.pts.length > 8) box.round = { x: r4((x0 + x1) / 2), y: r4((y0 + y1) / 2), r: r4((x1 - x0) / 2) };
  return box;
}

/** Reads a board document and follows it. */
export class BoardReader {
  private cache = new Map<string, ItemCache>();
  private measured = new Map<string, Measured>();
  /** bumped by every update that changed something */
  rev = 0;
  doc!: BoardDoc;
  constructor(doc?: BoardDoc) { if (doc) this.reload(doc); }

  /** Take a new document (a snapshot from the server). */
  reload(doc: BoardDoc): BoardDelta {
    this.doc = doc; this.cache.clear();
    for (const it of doc.items.values()) this.cache.set(it.id, readItem(it, doc));
    this.rev++;
    return { all: true, outline: true, holes: true, components: new Set(this.components().map((c) => c.id)), artwork: true, front: true, back: true };
  }

  /** The items with these ids changed (BoardSource applies the ops first).  Costs the changed items only. */
  update(touched: Iterable<string>): BoardDelta {
    const delta: BoardDelta = { all: false, outline: false, holes: false, components: new Set(), artwork: false, front: false, back: false };
    for (const id of touched) {
      const was = this.cache.get(id), item = this.doc.items.get(id);
      const now = item ? readItem(item, this.doc) : null;
      if (now) this.cache.set(id, now); else this.cache.delete(id);
      delta.artwork = true;
      const sides = (was ? was.sides : 0) | (now ? now.sides : 0);
      if (sides & 1) delta.front = true;
      if (sides & 2) delta.back = true;
      if ((was ? was.edgeKey : "") !== (now ? now.edgeKey : "")) delta.outline = true;
      if ((was ? was.holeKey : "") !== (now ? now.holeKey : "")) delta.holes = true;
      if ((was && was.component) || (now && now.component)) delta.components.add(id);
    }
    if (delta.artwork) this.rev++;
    return delta;
  }

  /**
   * A part's real size, measured from its loaded 3D model, replaces the guess from its footprint.  `key` says
   * which model was measured, so the same report twice changes nothing.  Returns true when the envelope changed.
   */
  setMeasured(id: string, m: Measured | null): boolean {
    const was = this.measured.get(id);
    if ((was ? was.key : "") === (m ? m.key : "")) return false;
    if (m) this.measured.set(id, m); else this.measured.delete(id);
    this.rev++;
    return true;
  }
  /** The envelope and height of a part: measured from its model when there is one, else read from the footprint. */
  envelope(c: BoardComponent): { box: PartBox; height: number } | null {
    const m = this.measured.get(c.id);
    if (m) return { box: m.box, height: m.height };
    return c.box ? { box: c.box, height: c.height } : null;
  }

  get thickness(): number { return Math.max(0.1, Number(this.doc.thickness) || 1.6); }
  components(): BoardComponent[] { const out: BoardComponent[] = []; for (const c of this.cache.values()) if (c.component) out.push(c.component); return out; }
  component(id: string): BoardComponent | null { return this.cache.get(id)?.component || null; }
  edges(): EdgeSegment[] { const out: EdgeSegment[] = []; for (const c of this.cache.values()) if (c.edges.length) out.push(...c.edges); return out; }
  ruleAreas(): RuleArea[] { return ruleAreas(this.doc); }

  /** The centre of the outline's bounding box, rounded to 0.1 mm: a sensible place for the board's own origin. */
  centre(): Pt {
    const b = boardShape(this.doc).bbox;
    return [Math.round((b[0] + b[2]) * 5) / 10, Math.round((b[1] + b[3]) * 5) / 10];
  }

  /**
   * The names parts go by in geometry names: the reference designator, or `ref~<start of uuid>` for the ones
   * that share a designator (two unannotated "R?"), so a name always means one footprint.
   */
  partNames(): Map<string, string> {
    const count = new Map<string, number>();
    const comps = this.components();
    for (const c of comps) count.set(c.ref, (count.get(c.ref) || 0) + 1);
    const out = new Map<string, string>();
    for (const c of comps) out.set(c.id, c.ref && count.get(c.ref) === 1 && !/[*?]/.test(c.ref) ? c.ref : `${c.ref || "part"}~${c.id.slice(0, 8)}`);
    return out;
  }

  /** The board as plain data in its own frame (README.md): the worker's input and the other direction's source. */
  snapshot(o: SnapshotOptions): BoardSnapshot {
    const [ox, oy] = o.origin;
    const local = (p: Pt): Pt => [r4(p[0] - ox), r4(oy - p[1])];
    const names = this.partNames();
    const found = chainOutline(this.edges());
    let outlines: SnapOutline[] = found.outlines.map((ol) => ({ outer: ol.outer.map((s) => snapSeg(s, local)), cuts: ol.cuts.map((c) => c.map((s) => snapSeg(s, local))) }));
    let fallback = false;
    if (!outlines.length) {
      // no closed outline: the box the 3D viewer falls back to
      fallback = true;
      const b = boardShape(this.doc).bbox;
      const c: Pt[] = [[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]].map((p) => local(p as Pt));
      outlines = [{ outer: c.map((p, i): SnapSeg => ({ k: "l", n: `box:${i}`, a: p, b: c[(i + 1) % 4] })), cuts: [] }];
    }
    const polys = outlines.map((ol) => ({ outer: loopPolygon(ol.outer), cuts: ol.cuts.map(loopPolygon) }));

    const holes: SnapHole[] = [];
    const parts: SnapPart[] = [];
    const placed: { x: number; y: number; r: number }[] = [];
    let skipped = 0;
    const comps = this.components().sort((a, b) => (names.get(a.id)! < names.get(b.id)! ? -1 : 1));
    for (const c of comps) {
      const name = names.get(c.id)!;
      const padCount = new Map<string, number>();
      for (const h of c.holes) padCount.set(h.pad, (padCount.get(h.pad) || 0) + 1);
      for (const h of c.holes) {
        const d = Math.min(h.w, h.h);
        if (d + 1e-9 < o.minHole) continue;
        // a pad number names the hole when it is the footprint's only pad with that number; otherwise its place in the footprint
        const hn = h.pad && padCount.get(h.pad) === 1 ? `${name}:${h.pad}` : c.holes.length === 1 ? name : `${name}:@${h.padIndex}`;
        const [x, y] = local([h.x, h.y]);
        const r = Math.max(h.w, h.h) / 2;
        // a hole that breaks the edge, a cut-out or another hole cannot be a clean cylinder in the solid
        const home = polys.find((p) => inside(p.outer, x, y) && edgeDistance(p.outer, x, y) >= r + 0.02 && !p.cuts.some((k) => inside(k, x, y) || edgeDistance(k, x, y) < r + 0.02));
        if (!home || placed.some((q) => Math.hypot(q.x - x, q.y - y) < q.r + r + 0.02)) { skipped++; continue; }
        placed.push({ x, y, r });
        const hole: SnapHole = { n: hn, part: name, pad: h.pad, x, y, d: r4(d), plated: h.plated, outline: polys.indexOf(home) };
        // KiCad turns clockwise on a Y-down sheet, which is counter-clockwise seen in the board's Y-up frame
        if (h.oval) { hole.slot = { w: r4(h.w), h: r4(h.h), rot: r4(h.rot) }; }
        holes.push(hole);
      }
      const env = this.envelope(c);
      if (!env || env.height + 1e-9 < o.minHeight) continue;
      const b = env.box;
      const part: SnapPart = { n: name, ref: c.ref, back: c.side === "back", h: r4(env.height), pts: [] };
      if (b.round) { const [x, y] = local(fromFootprint(c, [b.round.x, b.round.y])); part.round = { x, y, r: b.round.r }; }
      else part.pts = ([[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]] as Pt[]).map((p) => local(fromFootprint(c, p)));
      parts.push(part);
    }
    return { v: 1, thickness: r4(this.thickness), outlines, holes, parts, fallback, open: found.open, skippedHoles: skipped };
  }
}

function snapSeg(s: EdgeSegment, local: (p: Pt) => Pt): SnapSeg {
  if (s.kind === "line") return { k: "l", n: s.id, a: local(s.a), b: local(s.b) };
  if (s.kind === "arc") return { k: "a", n: s.id, a: local(s.a), b: local(s.b), m: local(s.mid) };
  return { k: "c", n: s.id, c: local(s.centre), r: r4(s.r) };
}

// ---------------------------------------------------------------- chaining the outline, keeping whose piece is whose

type Open = Exclude<EdgeSegment, { kind: "circle" }>;
const flip = (s: Open): Open => ({ ...s, a: s.b, b: s.a });

/** Points along a segment (document coordinates), end point excluded for lines and arcs. */
function segPoints(s: EdgeSegment): Pt[] {
  if (s.kind === "line") return [s.a];
  if (s.kind === "circle") { const out: Pt[] = []; for (let i = 0; i < 32; i++) { const t = (2 * Math.PI * i) / 32; out.push([s.centre[0] + s.r * Math.cos(t), s.centre[1] + s.r * Math.sin(t)]); } return out; }
  const c = circleThrough(s.a, s.mid, s.b);
  if (!c) return [s.a, s.mid];
  const a0 = Math.atan2(s.a[1] - c.y, s.a[0] - c.x), am = Math.atan2(s.mid[1] - c.y, s.mid[0] - c.x), a1 = Math.atan2(s.b[1] - c.y, s.b[0] - c.x);
  const TAU = Math.PI * 2, norm = (a: number) => ((a % TAU) + TAU) % TAU;
  // the way round from a to b that passes mid
  const ccw = norm(am - a0) < norm(a1 - a0);
  const pts = arcPoints(c.x, c.y, c.r, a0, a1, !ccw, 0.02);
  return pts.slice(0, -1);
}

interface ChainedOutline { outer: EdgeSegment[]; cuts: EdgeSegment[][] }

/**
 * Chain Edge.Cuts pieces into closed loops by their end points (within 0.01 mm, then 0.1 mm for a sloppy
 * outline, as the 3D viewer does), and nest the loops: even depth is an outline, odd a cut-out of its parent.
 * Each loop keeps its pieces, with the ends of neighbours made to meet exactly.
 */
export function chainOutline(edges: readonly EdgeSegment[]): { outlines: ChainedOutline[]; open: number } {
  const tight = chain(edges, 0.01);
  const got = tight.open ? (() => { const loose = chain(edges, 0.1); return loose.open < tight.open ? loose : tight; })() : tight;
  const loops = got.loops.map((segs) => ({ segs, poly: segs.flatMap(segPoints) })).filter((l) => l.poly.length >= 3 && Math.abs(polyArea(l.poly)) > 1e-6)
    .sort((a, b) => Math.abs(polyArea(b.poly)) - Math.abs(polyArea(a.poly)));
  const parent: number[] = [], depth: number[] = [];
  const out: ChainedOutline[] = []; const index = new Map<number, ChainedOutline>();
  loops.forEach((l, i) => {
    parent[i] = -1; depth[i] = 0;
    for (let j = i - 1; j >= 0; j--) if (pointInPolygon(loops[j].poly, l.poly[0][0], l.poly[0][1])) { parent[i] = j; depth[i] = depth[j] + 1; break; }
    if (depth[i] % 2 === 0) { const o: ChainedOutline = { outer: l.segs, cuts: [] }; index.set(i, o); out.push(o); }
    else index.get(parent[i])?.cuts.push(l.segs);
  });
  return { outlines: out, open: got.open };
}

function chain(edges: readonly EdgeSegment[], tol: number): { loops: EdgeSegment[][]; open: number } {
  const loops: EdgeSegment[][] = [];
  const rest: Open[] = [];
  for (const e of edges) { if (e.kind === "circle") loops.push([e]); else rest.push(e); }
  const used = new Array<boolean>(rest.length).fill(false);
  const near = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;
  const next = (p: Pt): { i: number; rev: boolean } | null => {
    let best: { i: number; rev: boolean } | null = null, bd = Infinity;
    for (let i = 0; i < rest.length; i++) {
      if (used[i]) continue;
      const d0 = Math.hypot(rest[i].a[0] - p[0], rest[i].a[1] - p[1]), d1 = Math.hypot(rest[i].b[0] - p[0], rest[i].b[1] - p[1]);
      if (d0 <= tol && d0 < bd) { bd = d0; best = { i, rev: false }; }
      if (d1 <= tol && d1 < bd) { bd = d1; best = { i, rev: true }; }
    }
    return best;
  };
  let open = 0;
  for (let s = 0; s < rest.length; s++) {
    if (used[s]) continue; used[s] = true;
    let segs: Open[] = [rest[s]]; let closed = false;
    for (;;) {
      const head = segs[0].a, tail = segs[segs.length - 1].b;
      if (segs.length > 1 && near(head, tail)) { closed = true; break; }
      const nx = next(tail);
      if (nx) { used[nx.i] = true; segs.push(nx.rev ? flip(rest[nx.i]) : rest[nx.i]); continue; }
      const hd = next(head);
      if (!hd) break;
      used[hd.i] = true; segs.unshift(hd.rev ? rest[hd.i] : flip(rest[hd.i]));
    }
    if (!closed) { open += segs.length; continue; }
    // make neighbours meet exactly: each piece starts where the one before it ends
    segs = segs.map((x) => ({ ...x }));
    for (let i = 0; i < segs.length; i++) segs[(i + 1) % segs.length].a = segs[i].b;
    loops.push(segs);
  }
  return { loops, open };
}

// ---------------------------------------------------------------- small geometry on snapshot loops

/** A loop of the snapshot as a polygon (arcs and circles sampled). */
export function loopPolygon(loop: readonly SnapSeg[]): Pt[] {
  const out: Pt[] = [];
  for (const s of loop) {
    if (s.k === "l") out.push(s.a);
    else if (s.k === "c") out.push(...segPoints({ kind: "circle", centre: s.c, r: s.r, id: "", item: "" }));
    else out.push(...segPoints({ kind: "arc", a: s.a, b: s.b, mid: s.m, centre: [0, 0], r: 0, id: "", item: "" }));
  }
  return out;
}
const inside = (poly: Pt[], x: number, y: number): boolean => pointInPolygon(poly, x, y);
function edgeDistance(poly: Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], ay = poly[j][1], dx = poly[i][0] - ax, dy = poly[i][1] - ay;
    const l2 = dx * dx + dy * dy; let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}
