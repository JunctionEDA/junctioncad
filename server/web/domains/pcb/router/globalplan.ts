// Global routing before the detailed search: the board is cut into square tiles, every connection gets a coarse path
// over the tile graph with negotiated congestion, its layers are assigned along that path, and the detailed router
// takes three things from the result: the order to lay connections in (the ones the negotiation had to fight for
// first), which routes to take up when one is blocked (those same contested ones first), and, only for a connection
// the negotiation moved off its direct path, a corridor (the path's tiles and a ring round them) with the layer the
// plan put each tile on.  A connection whose plan is its direct path is left to the detailed router alone.
//
// Ported from Copper's router v2 (src/copper_kicad/pcb/v2/globalroute.py and tiles.py; MIT licence,
// github.com/claynicholson/copper-kicad-mcp):
// - tile graph: a node is (layer, tile); the tile is 0.5 mm on a board with a pad pitch of 0.5 mm or finer and 1 mm
//   otherwise, doubled until the graph has at most 60 000 nodes.  Neighbouring tiles of a layer share a border whose
//   capacity is the number of reference tracks (width + clearance) its free stretches carry, plus the largest
//   remainder; a free stretch cut by a tile corner is counted together with its continuation in the next border; and
//   the borders a connection's own pads touch are free for that connection (it is leaving its own pad there).  A
//   column's via capacity is how many vias fit in the tile.  Copper measures the borders on exact geometry; here they
//   are read off the detailed router's own occupancy maps for the most common rule class, so the two see the same
//   obstacles;
// - negotiated congestion (PathFinder): every connection is laid on the tile graph, then for a few rounds the ones on
//   an overflowing border, via column or forced crossing are laid again with a present-congestion factor that grows
//   1.5 times a round and a history cost that stays on what overflowed; the round with the least overflow is kept;
// - crossings: two paths of different nets that share a run of tiles on a layer must cross iff the second leaves the
//   first on its left at one end of the run and on its right at the other; a forced crossing counts as overflow and
//   puts history on the run.  Inside the search, a step pays for the traffic straight across it (the cheap price);
// - layer assignment: a Viterbi pass over each coarse path (state: layer and vias used so far) against the final
//   congestion picture, kept only when it adds no overflow and no crossing.
// The coarse search is plain Dijkstra (no A*: the owner's rule); the detailed router keeps its own line search.
// Not ported: waypoints, buses, tees onto another connection's path, regions and the calibration of capacities.
import { viaFits, type Grid, type Pt } from "./grid";

/** An end of a connection: where it is, its layers, and the box of its pad's copper (mm) when it ends on a pad. */
export interface PlanEnd { p: Pt; layers: number[]; box?: number[] }
export interface PlanConn { id: number; net: string; a: PlanEnd; b: PlanEnd; demand: number }
export interface PlanInput {
  G: Grid; maps: Uint16Array[]; vmaps: Uint16Array[];   // the reference class's occupancy maps (what was on the board before the run)
  pitch: number; viaPitch: number;                      // reference track width + clearance; via diameter + clearance (mm)
  need?: number;                                        // how far a reference track's centre keeps from a pad (clearance + half width, mm)
  pref: number[];                                       // per layer: +1 runs horizontally, -1 vertically (route.ts)
  viaMm: number;                                        // what a via costs, in mm of track
  minPitch?: number;                                    // the finest pad pitch on the board (mm): sets the tile size
  tile?: number; iters?: number; maxMs?: number;
  /** The repair ladder's feedback (Copper's repair.py, _feedback): capacity booked away on tile borders where a
   *  connection failed, as [layer, tx, ty, side (0: the tile's east border, 1: its north one), mm]. */
  book?: [number, number, number, number, number][];
  /** Coarse paths of connections that are not planned again: they hold their capacity and are never moved. */
  fixed?: { conn: PlanConn; path: number[] }[];
}
/** A connection's corridor: per tile 1 when the detailed route may run there, and the layer the plan put it on (-1: any).
 *  moved: the negotiation took it off its direct path (only then is it steered); contest: how many rounds of the
 *  negotiation laid it again because it sat on an overflowing border, via column or forced crossing. */
export interface Corridor { tiles: Uint8Array; layer: Int8Array; vias: number; overflow: number; path: number[]; moved: boolean; contest: number }
export interface PlanResult {
  k: number; T: number; nx: number; ny: number; corridors: Map<number, Corridor>;
  iterations: number; overflowFirst: number; overflow: number; crossings: number; relayered: number; moved: number; contested: number; ms: number;
}

const WALL = 8, WALL_VIA = 2;      // extra cost factor of a border without capacity / a column without a via site (soft)
const DIR_BIAS = 0.3;              // a step against its layer's direction costs this much more (times |pref|)
const MAX_ITERS = 16, BOX_MARGIN = 8;
const MAX_DP_VIAS = 6, TURN_AT_TRAFFIC = 1;
const MAX_NODES = 60000;           // tiles x layers (Copper's choose_tile_mm)
const MOVED_MM = 1;                // a connection counts as moved when its path leaves its direct path by more than this
const INF = Infinity;

/** Copper's tile size: 0.5 mm on a board with a pad pitch of 0.5 mm or finer, 1 mm otherwise, doubled until the
 *  graph fits in MAX_NODES. */
export function tileFor(minPitch: number, w: number, h: number, layers: number): number {
  let t = minPitch <= 0.5 + 1e-6 ? 0.5 : 1;
  while (Math.max(1, Math.ceil(w / t - 1e-9)) * Math.max(1, Math.ceil(h / t - 1e-9)) * layers > MAX_NODES) t *= 2;
  return t;
}

export function plan(inp: PlanInput, conns: PlanConn[]): PlanResult {
  const t0 = Date.now(); const { G } = inp; const g = G.g; const L = G.layers.length;
  const tmm = inp.tile || tileFor(inp.minPitch ?? Infinity, G.W * g, G.H * g, G.routable.filter(Boolean).length || L);
  const k = Math.max(2, Math.round(tmm / g)), T = k * g;
  const nx = Math.max(1, Math.ceil(G.W / k)), ny = Math.max(1, Math.ceil(G.H / k)), GT = nx * ny, N = GT * L;
  const p = inp.pitch, rt = G.routable;
  const layersOf = (ls: number[]) => { const out = ls.filter((l) => l >= 0 && l < L && rt[l]); return out.length ? out : rt.map((r, l) => r ? l : -1).filter((l) => l >= 0); };
  // ---- capacities (mm), as Copper's tiles.py counts them.  A border's free stretches are the runs of cells where a
  // reference track may cross it (free on both sides of the line); a stretch whose centre line is c mm long carries
  // floor(c / p) + 1 tracks, and the border's capacity is that many pitches plus the largest remainder (the slack: a
  // track wider than the reference still fits where it physically does).  A stretch cut by a tile corner goes on in
  // the next border of the same grid line: the two pieces together carry what their joint length does, the larger
  // piece (one that spans its whole border always counts as the larger) keeps its own count and the smaller gets the
  // rest.  Without that a gap that happens to straddle a corner would count as closed.
  const capE = new Float64Array(N), capN = new Float64Array(N), capV = new Int32Array(GT);
  const tracksOf = (n: number) => n > 0 ? Math.floor(((n - 1) * g) / p + 1e-9) + 1 : 0;
  const runs: (Int32Array | null)[] = new Array(2 * N).fill(null);   // per border code (s * 2 + side): its free runs as [start, cells], start from the border's low corner
  const spanOf = (code: number) => { const r = (code >> 1) % GT, i = code & 1 ? r % nx : (r / nx) | 0; return Math.min(code & 1 ? G.W : G.H, (i + 1) * k) - i * k; };
  for (let l = 0; l < L; l++) {
    if (!rt[l]) continue; const m = inp.maps[l];
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
      const s = l * GT + ty * nx + tx;
      for (let side = 0; side < 2; side++) {   // 0: the east border (a vertical grid line), 1: the north one (+y)
        if (side === 0 ? tx + 1 >= nx : ty + 1 >= ny) continue;
        const line = (side === 0 ? tx + 1 : ty + 1) * k; if (line >= (side === 0 ? G.W : G.H)) continue;
        const a0 = (side === 0 ? ty : tx) * k, a1 = Math.min(side === 0 ? G.H : G.W, a0 + k);
        const out: number[] = []; let st = -1;
        for (let i = a0; i <= a1; i++) {
          const free = i < a1 && (side === 0 ? !m[i * G.W + line] && !m[i * G.W + line - 1] : !m[line * G.W + i] && !m[(line - 1) * G.W + i]);
          if (free) { if (st < 0) st = i; } else if (st >= 0) { out.push(st - a0, i - st); st = -1; }
        }
        if (out.length) runs[s * 2 + side] = Int32Array.from(out);
      }
    }
  }
  // the run of border `code` that touches its low (end 0) / high (end 1) corner: [cells, spans the whole border], or null
  const piece = (code: number, end: number): [number, boolean] | null => {
    const f = runs[code]; if (!f) return null; const span = spanOf(code);
    const i = end ? f.length - 2 : 0, a = f[i], n = f[i + 1];
    if (end ? a + n < span : a > 0) return null;
    return [n, a === 0 && a + n >= span];
  };
  for (let code = 0; code < 2 * N; code++) {
    const f = runs[code]; if (!f) continue;
    const s = code >> 1, side = code & 1, r = s % GT, tx = r % nx, ty = (r / nx) | 0, span = spanOf(code);
    const step = (side ? 1 : nx) * 2, first = side ? tx === 0 : ty === 0, last = side ? tx === nx - 1 : ty === ny - 1;   // the next border along the same grid line
    let n = 0, slack = 0;
    for (let i = 0; i < f.length; i += 2) {
      const a = f[i], ln = f[i + 1]; let own = tracksOf(ln), rem = own > 0 ? (ln - 1) * g - (own - 1) * p : 0;
      const atLo = a === 0, atHi = a + ln >= span;
      if (atLo !== atHi) {   // cut by exactly one corner
        let other: [number, boolean] | null = null, later = false;
        if (atLo && !first) { other = piece(code - step, 1); later = true; } else if (atHi && !last) other = piece(code + step, 0);
        if (other) { const [oln, whole] = other; if (whole || oln > ln || (oln === ln && later)) { own = Math.max(0, tracksOf(ln + oln) - tracksOf(oln)); rem = 0; } }
      }
      n += own; if (own > 0 && rem > slack) slack = rem;
    }
    (side ? capN : capE)[s] = n * p + (n > 0 ? slack : 0);
  }
  for (const [l, tx, ty, side, mm] of inp.book || []) {
    if (l < 0 || l >= L || tx < 0 || ty < 0 || tx >= nx || ty >= ny) continue; const s = l * GT + ty * nx + tx, cap = side ? capN : capE;
    cap[s] = Math.max(0, cap[s] - mm);
  }
  // via sites: how many vias fit in the tile, at least one where any cell takes one
  const per = Math.max(1, (inp.viaPitch * inp.viaPitch) / (g * g));
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    let n = 0; for (let iy = ty * k; iy < Math.min(G.H, (ty + 1) * k); iy++) for (let ix = tx * k; ix < Math.min(G.W, (tx + 1) * k); ix++) { const gi = iy * G.W + ix; if (!(G.outside && G.outside[gi]) && viaFits(G, inp.vmaps, gi)) n++; }
    capV[ty * nx + tx] = n > 0 ? Math.max(1, Math.floor(n / per)) : 0;
  }
  // a connection's own pads: the borders their copper, grown by what a reference track keeps from it, touches are free
  // for that connection (no capacity used, none missing): it is leaving its own pad there
  const freeOf = new Map<number, Set<number>>();
  const nd = inp.need ?? p / 2, cx = (x: number) => (x - G.ox) / g + 0.5, cy = (y: number) => (y - G.oy) / g + 0.5;   // in cells from the low edge of cell 0
  const fixed = inp.fixed || [];
  for (const c of conns.concat(fixed.map((f) => f.conn))) {
    const set = new Set<number>();
    for (const e of [c.a, c.b]) {
      if (!e.box) continue; const x0 = cx(e.box[0] - nd), y0 = cy(e.box[1] - nd), x1 = cx(e.box[2] + nd), y1 = cy(e.box[3] + nd); const ls = layersOf(e.layers);
      for (let K = Math.max(1, Math.ceil(x0 / k)); K <= Math.min(nx - 1, Math.floor(x1 / k)); K++) for (let j = Math.max(0, Math.floor(y0 / k)); j <= Math.min(ny - 1, Math.floor(y1 / k)); j++) for (const l of ls) set.add((l * GT + j * nx + K - 1) * 2);
      for (let K = Math.max(1, Math.ceil(y0 / k)); K <= Math.min(ny - 1, Math.floor(y1 / k)); K++) for (let i = Math.max(0, Math.floor(x0 / k)); i <= Math.min(nx - 1, Math.floor(x1 / k)); i++) for (const l of ls) set.add((l * GT + (K - 1) * nx + i) * 2 + 1);
    }
    if (set.size) freeOf.set(c.id, set);
  }
  // ---- negotiation state
  const useE = new Float64Array(N), useN = new Float64Array(N), useV = new Int32Array(GT);
  const histE = new Float64Array(N), histN = new Float64Array(N), histV = new Float64Array(GT), histX = new Float64Array(N);
  const hT = new Float64Array(N), vT = new Float64Array(N);   // straight-through traffic per node, east-west / north-south (mm)
  const shared = new Map<number, Map<string, { n: number; d: number }>>();   // border -> net -> how many of its paths cross it (a net pays once)
  const paths = new Map<number, number[]>(); const byId = new Map(conns.concat(fixed.map((f) => f.conn)).map((c) => [c.id, c]));
  let anyX = false, pres = 0, margin = BOX_MARGIN;
  const tileOf = (q: Pt): number => { const tx = Math.min(nx - 1, Math.max(0, Math.floor((q[0] - G.ox) / g / k))), ty = Math.min(ny - 1, Math.max(0, Math.floor((q[1] - G.oy) / g / k))); return ty * nx + tx; };
  const netOn = (code: number, net: string) => { const m = shared.get(code); return !!m && (m.get(net)?.n || 0) > 0; };
  const apply = (c: PlanConn, path: number[], sign: number) => {
    let pd = 0; const fr = freeOf.get(c.id);
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i], b = path[i + 1]; let st = b - a; const lo = Math.min(a, b), df = Math.abs(st);
      if (df >= GT) { useV[lo % GT] += sign; st = 0; }
      else {
        const vert = df === nx && ((a % GT) % nx) === ((b % GT) % nx); const code = lo * 2 + (vert ? 1 : 0);
        if (fr && fr.has(code)) { if (st === pd) (vert ? vT : hT)[a] += sign * c.demand; pd = st; continue; }   // its own pad's border: no capacity used
        let m = shared.get(code); if (!m) shared.set(code, m = new Map()); const e = m.get(c.net) || { n: 0, d: c.demand };
        if (sign > 0) { if (!e.n) { e.d = c.demand; (vert ? useN : useE)[lo] += e.d; } e.n++; m.set(c.net, e); }
        else { e.n--; if (!e.n) { (vert ? useN : useE)[lo] -= e.d; m.delete(c.net); } }
        if (st === pd) (vert ? vT : hT)[a] += sign * c.demand;
      }
      pd = st;
    }
  };
  // ---- one step's price
  const ecost = (l: number, ra: number, rb: number, c: PlanConn, pr: number): number => {
    const lo = ra < rb ? ra : rb, vert = Math.abs(rb - ra) === nx && (ra % nx) === (rb % nx), s = l * GT + lo, code = s * 2 + (vert ? 1 : 0);
    const own = freeOf.get(c.id)?.has(code) || false;   // its own pad's border: never short for it (Copper's _patch)
    const cap = (vert ? capN[s] : capE[s]) + (own ? c.demand : 0), use = vert ? useN[s] : useE[s], hist = vert ? histN[s] : histE[s];
    const pf = inp.pref[l] || 0; const against = vert ? Math.max(0, pf) : Math.max(0, -pf);
    let cost = T * (1 + DIR_BIAS * against) * (1 + hist + (cap <= 0 && !own ? WALL : 0));
    const o = netOn(code, c.net) ? use - cap : use + c.demand - cap;
    if (pr && o > 0) cost *= 1 + pr * o / p;
    const sa = l * GT + ra, sb = l * GT + rb;
    if (pr) { const other = vert ? hT : vT; const x = (other[sa] + other[sb]) / 2; if (x > 0) cost *= 1 + pr * Math.min(x, c.demand) / p; }
    if (anyX) cost *= 1 + histX[sa] + histX[sb];
    return cost;
  };
  const vcost = (r: number, pr: number): number => { let v = inp.viaMm * (1 + histV[r] + (capV[r] <= 0 ? WALL_VIA : 0)); const o = useV[r] + 1 - capV[r]; if (pr && o > 0) v *= 1 + pr * o; return v; };
  // ---- Dijkstra over the tile graph (inside a box round the terminals, the whole board when that finds nothing)
  const dist = new Float64Array(N), prev = new Int32Array(N), seen = new Int32Array(N); let gen = 0;
  const hk: number[] = [], hn: number[] = [];
  const push = (key: number, n: number) => { let i = hk.length; hk.push(key); hn.push(n); while (i > 0) { const j = (i - 1) >> 1; if (hk[j] <= key) break; hk[i] = hk[j]; hn[i] = hn[j]; i = j; } hk[i] = key; hn[i] = n; };
  const pop = (): number => { const top = hn[0]; const lk = hk.pop()!, ln = hn.pop()!; const n = hk.length; if (n) { let i = 0; for (;;) { let j = 2 * i + 1; if (j >= n) break; if (j + 1 < n && hk[j + 1] < hk[j]) j++; if (hk[j] >= lk) break; hk[i] = hk[j]; hn[i] = hn[j]; i = j; } hk[i] = lk; hn[i] = ln; } return top; };
  const search = (c: PlanConn, pr: number, box: number[] | null): number[] | null => {
    gen++; hk.length = 0; hn.length = 0;
    const ra = tileOf(c.a.p), rb = tileOf(c.b.p); const tgt = new Set(layersOf(c.b.layers).map((l) => l * GT + rb));
    for (const l of layersOf(c.a.layers)) { const n = l * GT + ra; seen[n] = gen; dist[n] = 0; prev[n] = -1; push(0, n); }
    const relax = (n: number, m: number, w: number) => { if (w === INF) return; const d = dist[n] + w; if (seen[m] !== gen || d < dist[m] - 1e-12) { seen[m] = gen; dist[m] = d; prev[m] = n; push(d, m); } };
    while (hk.length) {
      const key = hk[0], n = pop(); if (key > dist[n] + 1e-12) continue;
      if (tgt.has(n)) { const out: number[] = []; for (let x = n; x >= 0; x = prev[x]) out.push(x); return out.reverse(); }
      const l = (n / GT) | 0, r = n - l * GT, tx = r % nx, ty = (r / nx) | 0;
      const inBox = (x: number, y: number) => x >= 0 && y >= 0 && x < nx && y < ny && (!box || (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]));
      if (inBox(tx + 1, ty)) relax(n, n + 1, ecost(l, r, r + 1, c, pr));
      if (inBox(tx - 1, ty)) relax(n, n - 1, ecost(l, r, r - 1, c, pr));
      if (inBox(tx, ty + 1)) relax(n, n + nx, ecost(l, r, r + nx, c, pr));
      if (inBox(tx, ty - 1)) relax(n, n - nx, ecost(l, r, r - nx, c, pr));
      for (let l2 = 0; l2 < L; l2++) if (l2 !== l && rt[l2]) relax(n, l2 * GT + r, vcost(r, pr));
    }
    return null;
  };
  const route = (c: PlanConn, pr: number): boolean => {
    const ra = tileOf(c.a.p), rb = tileOf(c.b.p);
    const box = [Math.min(ra % nx, rb % nx) - margin, Math.min((ra / nx) | 0, (rb / nx) | 0) - margin, Math.max(ra % nx, rb % nx) + margin, Math.max((ra / nx) | 0, (rb / nx) | 0) + margin];
    const path = search(c, pr, box) || search(c, pr, null); if (!path) return false;
    paths.set(c.id, path); apply(c, path, 1); return true;
  };
  const rip = (c: PlanConn) => { const q = paths.get(c.id); if (q) { apply(c, q, -1); paths.delete(c.id); } };
  // ---- forced same-layer crossings: [(over mm, nodes of the shared run, id, id)]
  const crossings = (only?: number): [number, number[], number, number][] => {
    const occ = new Map<number, number[]>(); const mine = only !== undefined ? new Set(paths.get(only) || []) : null;
    for (const [id, q] of paths) for (const n of q) if (!mine || mine.has(n)) { let l = occ.get(n); if (!l) occ.set(n, l = []); if (l[l.length - 1] !== id) l.push(id); }
    const pairs = new Map<string, number[]>();
    for (const [n, ids] of occ) if (ids.length > 1) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const x = Math.min(ids[i], ids[j]), y = Math.max(ids[i], ids[j]); if (byId.get(x)!.net === byId.get(y)!.net || (only !== undefined && x !== only && y !== only)) continue;
      const key = x + "," + y; let l = pairs.get(key); if (!l) pairs.set(key, l = []); l.push(n);
    }
    const out: [number, number[], number, number][] = []; const pos = new Map<number, Map<number, number>>();
    const posOf = (id: number) => { let m = pos.get(id); if (!m) { m = new Map(); paths.get(id)!.forEach((n, i) => m!.set(n, i)); pos.set(id, m); } return m; };
    const xy = (n: number) => { const r = n % GT; return [r % nx, (r / nx) | 0]; };
    for (const [key, nodes] of pairs) {
      const [ip, iq] = key.split(",").map(Number); const P = paths.get(ip)!, Q = paths.get(iq)!; const pp = posOf(ip), pq = posOf(iq);
      const common = nodes.map((n) => pp.get(n)!).sort((a, b) => a - b);
      for (let kk = 0; kk < common.length;) {
        const i = common[kk]; let j = i;
        while (kk + 1 < common.length && common[kk + 1] === j + 1 && Math.abs(P[j + 1] - P[j]) < GT && Math.abs(pq.get(P[j + 1])! - pq.get(P[j])!) === 1) { j++; kk++; }
        kk++;
        if (i === 0 || j === P.length - 1) continue;
        const a = P[i - 1], b = P[j + 1], t0 = P[i], tm = P[j]; if (Math.abs(t0 - a) >= GT || Math.abs(b - tm) >= GT) continue;
        const qi = pq.get(t0)!, qj = pq.get(tm)!; let ci: number, di: number;
        if (i === j) { ci = qi - 1; di = qi + 1; } else { const dq = qj > qi ? 1 : -1; ci = qi - dq; di = qj + dq; }
        if (ci < 0 || di < 0 || ci >= Q.length || di >= Q.length) continue;
        const cc = Q[ci], dd = Q[di]; if (Math.abs(cc - t0) >= GT || Math.abs(dd - tm) >= GT || cc === a || dd === b) continue;
        const [ax, ay] = xy(a), [bx, by] = xy(b), [x0, y0] = xy(t0), [xm, ym] = xy(tm), [x1, y1] = xy(P[i + 1]), [xl, yl] = xy(P[j - 1]), [cx, cy] = xy(cc), [dx, dy] = xy(dd);
        let ux = (x0 - ax) + (x1 - x0), uy = (y0 - ay) + (y1 - y0); const s0 = ux * (cy - y0) - uy * (cx - x0);
        ux = (xm - xl) + (bx - xm); uy = (ym - yl) + (by - ym); const sm = ux * (dy - ym) - uy * (dx - xm);
        if (s0 * sm < 0) out.push([Math.min(byId.get(ip)!.demand, byId.get(iq)!.demand), P.slice(i, j + 1), ip, iq]);
      }
    }
    return out;
  };
  const pv = inp.viaPitch;
  const overflow = () => {
    let tot = 0; const edges: [number, number][] = [], cols: [number, number][] = [];
    for (let s = 0; s < N; s++) {
      if (useE[s] > 1e-9) { const o = useE[s] - capE[s]; if (o > 1e-6) { tot += o; edges.push([o, s * 2]); } }
      if (useN[s] > 1e-9) { const o = useN[s] - capN[s]; if (o > 1e-6) { tot += o; edges.push([o, s * 2 + 1]); } }
    }
    for (let r = 0; r < GT; r++) if (useV[r] > 0) { const o = useV[r] - capV[r]; if (o > 0) { tot += o * pv; cols.push([o, r]); } }
    const xruns = crossings(); for (const x of xruns) tot += x[0];
    return { tot, edges, cols, xruns };
  };
  const wire = () => { let w = 0; for (const q of paths.values()) for (let i = 0; i + 1 < q.length; i++) w += Math.abs(q[i + 1] - q[i]) >= GT ? inp.viaMm : T; return w; };
  const codesOf = (q: number[]) => { const out: number[] = []; for (let i = 0; i + 1 < q.length; i++) { const a = q[i], b = q[i + 1], lo = Math.min(a, b), df = Math.abs(b - a); if (df >= GT) out.push(-1 - (lo % GT)); else out.push(lo * 2 + (df === nx && (a % nx) === (b % nx) ? 1 : 0)); } return out; };
  // ---- negotiation
  const maxIters = Math.max(1, inp.iters || MAX_ITERS), maxMs = inp.maxMs || 8000;
  const mine = new Set(conns.map((c) => c.id));
  for (const f of fixed) if (!mine.has(f.conn.id) && f.path.length) { paths.set(f.conn.id, f.path); apply(f.conn, f.path, 1); }
  for (const c of conns) route(c, 0);
  const direct = new Map(paths);   // each connection's path before any negotiation: its direct path
  const contest = new Map<number, number>();
  let ov = overflow(); const first = ov.tot;
  let best = { tot: ov.tot, wire: wire(), paths: new Map(paths) }; let its = 1;
  for (let it = 0; ov.tot > 1e-6 && its < maxIters && Date.now() - t0 < maxMs; it++) {
    pres = 0.5 * Math.pow(1.5, it); margin = BOX_MARGIN + 2 * (it + 1);
    const hot = new Set<number>();
    for (const [o, code] of ov.edges) { hot.add(code); const s = code >> 1; if (code & 1) histN[s] += o / p; else histE[s] += o / p; }
    for (const [o, r] of ov.cols) { histV[r] += o; hot.add(-1 - r); }
    const hotx = new Set<number>(); for (const [o, run, a, b] of ov.xruns) { for (const n of run) histX[n] += o / p; hotx.add(a); hotx.add(b); anyX = true; }
    const redo = conns.filter((c) => { const q = paths.get(c.id); if (!q) return true; const fr = freeOf.get(c.id); return hotx.has(c.id) || codesOf(q).some((x) => hot.has(x) && !(fr && fr.has(x))); });
    if (!redo.length) break;
    for (const c of redo) contest.set(c.id, (contest.get(c.id) || 0) + 1);
    for (const c of redo) { const old = paths.get(c.id); rip(c); if (!route(c, pres) && old) { paths.set(c.id, old); apply(c, old, 1); } if (Date.now() - t0 > maxMs) break; }
    its++; ov = overflow(); const w = wire();
    if (ov.tot < best.tot - 1e-9 || (Math.abs(ov.tot - best.tot) <= 1e-9 && w < best.wire)) best = { tot: ov.tot, wire: w, paths: new Map(paths) };
  }
  if (best.paths !== paths) { for (const c of conns) rip(c); for (const [id, q] of best.paths) if (mine.has(id)) { paths.set(id, q); apply(byId.get(id)!, q, 1); } }
  // ---- layer assignment: Viterbi over each coarse path (state: layer, vias so far) against the final congestion
  const assign = (c: PlanConn, cols: number[], start: number[], end: number[]): number[] | null => {
    const n = cols.length, VM = MAX_DP_VIAS, S = L * (VM + 1); const lays = rt.map((r, l) => r ? l : -1).filter((l) => l >= 0);
    let cur = new Float64Array(S).fill(INF); for (const l of start) cur[l * (VM + 1)] = 0;
    const back: Int32Array[] = [];   // per position: the state it came from (-1: start), and whether a via was taken (encoded +S)
    for (let i = 0; i < n; i++) {
      const r = cols[i]; const here = new Float64Array(S).fill(INF), from = new Int32Array(S).fill(-1);
      const turn = i > 0 && i < n - 1 && (cols[i] - cols[i - 1]) !== (cols[i + 1] - cols[i]);
      for (let st = 0; st < S; st++) { if (cur[st] === INF) continue; const l = (st / (VM + 1)) | 0; let gc = cur[st]; if (turn && hT[l * GT + r] + vT[l * GT + r] > 1e-6) gc += inp.viaMm * TURN_AT_TRAFFIC; if (gc < here[st]) { here[st] = gc; from[st] = st; } }
      const vc = vcost(r, pres);
      for (let st = 0; st < S; st++) { if (cur[st] === INF) continue; const l = (st / (VM + 1)) | 0, v = st % (VM + 1); if (v >= VM) continue;
        for (const l2 of (i < n - 1 ? lays : end)) { if (l2 === l) continue; const s2 = l2 * (VM + 1) + v + 1, gc = cur[st] + vc; if (gc < here[s2] - 1e-12) { here[s2] = gc; from[s2] = st + S; } } }
      back.push(from);
      if (i === n - 1) { cur = here; break; }
      const nxt = new Float64Array(S).fill(INF); let any = false;
      for (let st = 0; st < S; st++) { if (here[st] === INF) continue; const l = (st / (VM + 1)) | 0; const e = ecost(l, r, cols[i + 1], c, pres); if (e === INF) continue; nxt[st] = here[st] + e; any = true; }
      if (!any) return null; cur = nxt;
    }
    let bs = -1; for (let st = 0; st < S; st++) if (cur[st] < INF && end.includes((st / (VM + 1)) | 0) && (bs < 0 || cur[st] < cur[bs])) bs = st;
    if (bs < 0) return null;
    const out: number[][] = []; let st = bs;
    for (let i = n - 1; i >= 0; i--) { const f = back[i][st]; const l = (st / (VM + 1)) | 0; if (f >= S) { const l0 = (((f - S) / (VM + 1)) | 0); out.push([l0 * GT + cols[i], l * GT + cols[i]]); st = f - S; } else { out.push([l * GT + cols[i]]); st = f < 0 ? st : f; } }
    return out.reverse().flat();
  };
  const overAt = (...qs: number[][]) => { let tot = 0; for (const code of new Set(qs.flatMap(codesOf))) { if (code < 0) { const r = -1 - code; const o = useV[r] - capV[r]; if (o > 0) tot += o * pv; } else { const s = code >> 1; const o = (code & 1 ? useN[s] - capN[s] : useE[s] - capE[s]); if (o > 1e-6) tot += o; } } return tot; };
  const crossOf = (id: number) => crossings(id).reduce((s, x) => s + x[0], 0);
  let relayered = 0;
  for (const c of conns) {
    const q = paths.get(c.id); if (!q || q.length < 2) continue;
    const cols: number[] = []; for (const n of q) { const r = n % GT; if (cols[cols.length - 1] !== r) cols.push(r); }
    const start = layersOf(c.a.layers), end = layersOf(c.b.layers);
    apply(c, q, -1); const nq = assign(c, cols, start, end); apply(c, q, 1);
    if (!nq || nq.join() === q.join()) continue;
    const before = overAt(q, nq) + crossOf(c.id);
    apply(c, q, -1); apply(c, nq, 1); paths.set(c.id, nq);
    if (overAt(q, nq) + crossOf(c.id) > before + 1e-9) { apply(c, nq, -1); apply(c, q, 1); paths.set(c.id, q); } else relayered++;
  }
  // ---- corridors: the path's tiles and a ring round them (at least 1 mm); the layer each tile is left on (any where
  // it changes layer); whether the negotiation moved it off its direct path, and how often it had to fight for it
  ov = overflow(); const overOf = new Map<number, number>(); for (const [o, , a, b] of ov.xruns) { overOf.set(a, (overOf.get(a) || 0) + o); overOf.set(b, (overOf.get(b) || 0) + o); }
  const corridors = new Map<number, Corridor>(); let nMoved = 0, nContested = 0;
  const R = Math.max(1, Math.ceil(MOVED_MM / T - 1e-9)), near = new Uint8Array(GT);
  for (const c of conns) {
    const q = paths.get(c.id); if (!q) continue;
    // moved: some tile of the plan lies farther than R tiles from every tile of the direct path
    const d = direct.get(c.id) || q; near.fill(0);
    for (const n of d) { const r = n % GT, tx = r % nx, ty = (r / nx) | 0; for (let y = Math.max(0, ty - R); y <= Math.min(ny - 1, ty + R); y++) near.fill(1, y * nx + Math.max(0, tx - R), y * nx + Math.min(nx - 1, tx + R) + 1); }
    const moved = q.some((n) => !near[n % GT]);
    const tiles = new Uint8Array(GT), layer = new Int8Array(GT).fill(-2); let vias = 0;
    for (let i = 0; i < q.length; i++) {
      const r = q[i] % GT, l = (q[i] / GT) | 0; const tx = r % nx, ty = (r / nx) | 0;
      for (let y = Math.max(0, ty - R); y <= Math.min(ny - 1, ty + R); y++) tiles.fill(1, y * nx + Math.max(0, tx - R), y * nx + Math.min(nx - 1, tx + R) + 1);
      if (i > 0 && q[i - 1] % GT === r) vias++;
      layer[r] = layer[r] === -2 || layer[r] === l ? l : -1;
    }
    for (let r = 0; r < GT; r++) if (layer[r] === -2) layer[r] = -1;
    const over = (overOf.get(c.id) || 0) + overAt(q), fought = (contest.get(c.id) || 0) + (over > 1e-6 ? 1 : 0);
    if (moved) nMoved++; if (fought) nContested++;
    corridors.set(c.id, { tiles, layer, vias, overflow: over, path: q, moved, contest: fought });
  }
  return { k, T, nx, ny, corridors, iterations: its, overflowFirst: first, overflow: ov.tot, crossings: ov.xruns.length, relayered, moved: nMoved, contested: nContested, ms: Date.now() - t0 };
}
