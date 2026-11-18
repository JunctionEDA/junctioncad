// Rip-up by minimum cut: which routes to take up so that a connection left open gets through.
//
// Ported from Copper's router v2 (src/copper_kicad/pcb/v2/repair.py, the "min-cut rip" rung of its repair ladder;
// MIT licence, github.com/claynicholson/copper-kicad-mcp):
// - every route already laid is a wall with a price: what it costs to take it up and lay it again (4 mm of track,
//   more for a wide one, eight times as much for a critical net, less for one that already wanders, and more each
//   time taking it up did not pay);
// - the cheapest set of walls between the two ends is the minimum cut.  On a board's plane it is found as its dual,
//   a shortest path (Dijkstra, no A*) on the grid through the board's own fixed copper that pays a wall's price on
//   entering its copper, so the walls the path crosses are exactly the routes to take up;
// - only those come up; the open connection is laid, then they are laid again, and the result is kept only when
//   fewer connections are open than before (keep-best), else everything goes back; a set that did not pay is not
//   tried again, and the routes that could not be laid again become walls nothing may cross on the next try.
// Ours: the cut is taken on the routing grid of the line search (route.ts), per layer, with vias as edges between
// layers; the open connection and the routes taken up are laid by the line search itself.
import { DX, DY, Grid, viaFits, type Obstacle } from "./grid";
import { work, type Node, type Win } from "./probe";

/** A route already laid that the cut may cross: its copper, and what crossing it costs (Infinity: a wall). */
export interface CutRoute { id: number; shapes: Obstacle[]; price: number }
export interface CutInput {
  G: Grid; maps: Uint16Array[]; vmaps: Uint16Array[];   // the board's own copper only (the run's routes are `routes`)
  routable: boolean[]; allowVias: boolean; viaMm: number;
  src: Node[]; dst: Node[]; win: Win;
  routes: CutRoute[];
  /** How far a track centre (or a via centre) of the connection must keep from a piece of copper. */
  grow(o: Obstacle): number; vgrow(o: Obstacle): number;
  maxSteps?: number;
}
export interface Cut { victims: number[]; price: number; length: number; vias: number; steps: number }

const SHAPE_PIECE = 1.5;
/** Grid cells (window-local) within `grow` of a shape. */
function cells(G: Grid, win: Win, s: any, grow: number, out: (k: number) => void): void {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const ww = win.x1 - win.x0 + 1;
  const one = (gap: (x: number, y: number) => number, bb: number[]) => {
    const x0 = Math.max(win.x0, Math.ceil((bb[0] - grow - G.ox) / G.g)), x1 = Math.min(win.x1, Math.floor((bb[2] + grow - G.ox) / G.g));
    const y0 = Math.max(win.y0, Math.ceil((bb[1] - grow - G.oy) / G.g)), y1 = Math.min(win.y1, Math.floor((bb[3] + grow - G.oy) / G.g));
    for (let iy = y0; iy <= y1; iy++) { const y = G.oy + iy * G.g; for (let ix = x0; ix <= x1; ix++) if (gap(G.ox + ix * G.g, y) <= grow) out((iy - win.y0) * ww + ix - win.x0); }
  };
  const seg = (a: number[], b: number[], r: number) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]); const n = Math.max(1, Math.ceil(len / SHAPE_PIECE));
    for (let i = 0; i < n; i++) {
      const p = [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n], q = [a[0] + (b[0] - a[0]) * (i + 1) / n, a[1] + (b[1] - a[1]) * (i + 1) / n];
      const dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy;
      one((x, y) => { let t = l2 ? ((x - p[0]) * dx + (y - p[1]) * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t; return Math.max(0, Math.hypot(x - p[0] - t * dx, y - p[1] - t * dy) - r); },
        [Math.min(p[0], q[0]) - r, Math.min(p[1], q[1]) - r, Math.max(p[0], q[0]) + r, Math.max(p[1], q[1]) + r]);
    }
  };
  if (s.t === "circle") one((x, y) => Math.max(0, Math.hypot(x - s.x, y - s.y) - s.r), [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r]);
  else if (s.t === "seg") seg(s.a, s.b, s.r);
  else if (s.t === "path") for (let i = 0; i + 1 < s.pts.length; i++) seg(s.pts[i], s.pts[i + 1], s.r || 0);
}

/** Who owns each cell: -1 nobody, k >= 0 that route, k <= -2 the list lists[-2 - k]. */
class Owners {
  own: Int32Array; lists: number[][] = [];
  constructor(n: number) { this.own = new Int32Array(n).fill(-1); }
  add(k: number, id: number): void {
    const o = this.own[k]; if (o === id) return;
    if (o === -1) { this.own[k] = id; return; }
    if (o >= 0) { this.own[k] = -2 - this.lists.length; this.lists.push([o, id]); return; }
    const l = this.lists[-2 - o]; if (!l.includes(id)) l.push(id);
  }
  at(k: number): number[] { const o = this.own[k]; return o === -1 ? [] : o >= 0 ? [o] : this.lists[-2 - o]; }
}

/** A binary heap of (cost, node) on plain arrays. */
class Heap {
  k: number[] = []; v: number[] = [];
  get size(): number { return this.k.length; }
  push(key: number, val: number): void {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k, v = this.v; const top: [number, number] = [k[0], v[0]]; const lk = k.pop()!, lv = v.pop()!; const n = k.length;
    if (n) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; } k[i] = lk; v[i] = lv; }
    return top;
  }
}

/**
 * The cheapest set of laid routes whose removal opens a way from `src` to `dst`: a shortest path on the grid that
 * pays a route's price each time it enters that route's copper (and the mm it runs, and a via's price).  The routes
 * it crosses are the cut.  null when there is no way even through every route that may be taken up.
 */
export function minCut(inp: CutInput): Cut | null {
  const { G, maps, vmaps, win, routable: RT } = inp; const L = G.layers.length;
  const ww = win.x1 - win.x0 + 1, wh = win.y1 - win.y0 + 1, n = ww * wh; if (ww <= 0 || wh <= 0) return null;
  // the routes' copper, per layer for tracks and over every layer for a via
  const own: Owners[] = []; for (let l = 0; l < L; l++) own.push(new Owners(RT[l] ? n : 0));
  const vown = new Owners(inp.allowVias ? n : 0);
  const price = new Map<number, number>();
  const bbOf = (s: any): number[] | null => s.t === "circle" ? [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r] : s.t === "seg" ? [Math.min(s.a[0], s.b[0]) - s.r, Math.min(s.a[1], s.b[1]) - s.r, Math.max(s.a[0], s.b[0]) + s.r, Math.max(s.a[1], s.b[1]) + s.r] : null;   // eslint-disable-line @typescript-eslint/no-explicit-any
  const wx0 = G.ox + win.x0 * G.g, wy0 = G.oy + win.y0 * G.g, wx1 = G.ox + win.x1 * G.g, wy1 = G.oy + win.y1 * G.g;
  for (const r of inp.routes) {
    price.set(r.id, r.price);
    for (const o of r.shapes) {
      const gt = inp.grow(o), gv = inp.vgrow(o), bb = bbOf(o.shape); const m = Math.max(gt, gv);
      if (bb && (bb[0] - m > wx1 || bb[2] + m < wx0 || bb[1] - m > wy1 || bb[3] + m < wy0)) continue;
      for (const l of o.layers) if (RT[l]) cells(G, win, o.shape, gt, (k) => own[l].add(k, r.id));
      if (inp.allowVias) cells(G, win, o.shape, gv, (k) => vown.add(k, r.id));
    }
  }
  const P = (id: number) => price.get(id) ?? Infinity;
  /** What entering cell b (owners ob) from a cell with owners oa costs; Infinity through a wall. */
  const charge = (ob: number[], oa: number[]): number => { let c = 0; for (const x of ob) if (!oa.includes(x)) c += P(x); return c; };
  const N = L * n; const dist = new Float64Array(N).fill(Infinity), from = new Int32Array(N).fill(-1);
  const goal = new Uint8Array(N); let goals = 0;
  const local = (p: Node) => p.ix >= win.x0 && p.ix <= win.x1 && p.iy >= win.y0 && p.iy <= win.y1 && RT[p.l] ? p.l * n + (p.iy - win.y0) * ww + p.ix - win.x0 : -1;
  for (const p of inp.dst) { const k = local(p); if (k >= 0) { goal[k] = 1; goals++; } }
  if (!goals) return null;
  const heap = new Heap();
  for (const p of inp.src) { const k = local(p); if (k < 0) continue; const c = charge(own[p.l].at(k - p.l * n), []); if (c < dist[k]) { dist[k] = c; heap.push(c, k); } }
  const D = [G.g, G.g * Math.SQRT2]; let steps = 0, end = -1; const max = inp.maxSteps || 4e6;
  while (heap.size) {
    const [d, k] = heap.pop(); if (d > dist[k]) continue; steps++;
    if (goal[k]) { end = k; break; }
    if (steps > max) break;
    const l = (k / n) | 0, li = k - l * n, x = li % ww, y = (li / ww) | 0; const m = maps[l], ow = own[l], oa = ow.at(li);
    for (let dd = 0; dd < 8; dd++) {
      const nx = x + DX[dd], ny = y + DY[dd]; if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue;
      const nli = ny * ww + nx; if (m[(ny + win.y0) * G.W + nx + win.x0]) continue;
      const c = d + D[dd & 1] + (ow.own[nli] === -1 ? 0 : charge(ow.at(nli), oa)); const nk = l * n + nli;
      if (c < dist[nk]) { dist[nk] = c; from[nk] = k; heap.push(c, nk); }
    }
    if (inp.allowVias) {
      const gi = (y + win.y0) * G.W + x + win.x0; const thru = G.thru[gi] !== 0;
      if (!thru && !viaFits(G, vmaps, gi)) continue;
      const vc = thru ? 0 : inp.viaMm + charge(vown.at(li), oa);
      for (let l2 = 0; l2 < L; l2++) {
        if (l2 === l || !RT[l2] || maps[l2][gi]) continue;
        const c = d + vc + charge(own[l2].at(li), thru ? oa : oa.concat(vown.at(li))); const nk = l2 * n + li;
        if (c < dist[nk]) { dist[nk] = c; from[nk] = k; heap.push(c, nk); }
      }
    }
  }
  work.steps += steps * 4;
  if (end < 0 || !isFinite(dist[end])) return null;
  const hit = new Set<number>(); let length = 0, vias = 0;
  for (let k = end; k >= 0; k = from[k]) {
    const l = (k / n) | 0, li = k - l * n; for (const x of own[l].at(li)) hit.add(x);
    const p = from[k]; if (p < 0) break; const pl = (p / n) | 0, pli = p - pl * n;
    if (pl !== l) { const gi = ((li / ww) | 0) * G.W + win.y0 * G.W + (li % ww) + win.x0; if (!G.thru[gi]) { vias++; for (const x of vown.at(li)) hit.add(x); } }
    else length += pli % ww !== li % ww && ((pli / ww) | 0) !== ((li / ww) | 0) ? D[1] : D[0];
  }
  const victims = Array.from(hit).sort((a, b) => a - b); let total = 0; for (const v of victims) total += P(v);
  return { victims, price: total, length, vias, steps };
}
