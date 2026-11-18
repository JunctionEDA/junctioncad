// Fine-pitch fan-out before routing: every connected pin of a fine-pitch row gets its escape laid analytically, off
// the grid, before any track is searched for, and its connections start from the escape's end.  Which rows, and
// whether the escapes stay, is route.ts's (routeRuns, after Copper's engine): only the rows of Copper's needs_fanout
// parts where a plain route left a pin open, and only when the board then comes out better.
//
// Ported from Copper's router v2 (src/copper_kicad/pcb/v2/fanout.py and flow.py; MIT licence,
// github.com/claynicholson/copper-kicad-mcp):
// - ring fan: a straight stub out of the pad to a ring parallel to the row, or a 45-degree leg on to a slot on a
//   higher ring; slots keep pad order, so the escapes cannot cross;
// - lane kept: no escape (stub, leg or via) may close the outward lane of any other connected pad of the row,
//   escaped or not, so a pin escaped late is never boxed in by its neighbours;
// - via escapes for pins whose net must change layer, matched to via sites by min-cost flow; every proposal is
//   checked exactly against the rules and an illegal one is dropped and the flow solved again.
// What makes a 0.4 mm QFN at the rule escapable is that the geometry is exact: a grid search sees no room there.
import type { Pt, Shape } from "./grid";

export interface FanPad { name: string; p: Pt; len: number; across: number; layer: number }
export interface FanRow { n: Pt; t: Pt; pads: FanPad[] }            // pads sorted along t; n points out of the part
export interface FanJob { pad: FanPad; net: string; w: number; clr: number; viaD: number; viaDrill: number; partner: Pt; near: number; offLayer: boolean; blocker?: string }
interface Lane { t: number; lane: number; a: number; b: number; w: number; cl: number; real: boolean }
export interface Escape { pad: FanPad; net: string; kind: "ring" | "via"; segs: [Pt, Pt][]; w: number; via: Pt | null; end: Pt; n: Pt; lane: Lane | null; cost: number }
export interface Boxed { pad: string; net: string; reason: string; blockedBy: string[] }
export interface FanCtx {
  /** What a piece of copper of `net` on `layer` comes too close to: a net name, "edge", "keep-out" or "via"; null when legal. */
  hit(s: Shape, layer: number, net: string, clr: number): string | null;
  /** The same for a through via of the job's net and size. */
  viaHit(p: Pt, j: FanJob): string | null;
  place(e: Escape): void;
  unplace(e: Escape): void;
}

const RINGS = 3, VIA_DEPTHS = 3, LANE_TOL = 1e-4;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const at = (p: Pt, n: Pt, d: number, t?: Pt, s = 0): Pt => [r6(p[0] + n[0] * d + (t ? t[0] * s : 0)), r6(p[1] + n[1] * d + (t ? t[1] * s : 0))];

/** The rows of one part's pads: pads of one size on one line, whose long axis points out of the part.  `axis` is each
 *  pad's long direction, `c` the middle of the part. */
export function padRows(pads: { name: string; p: Pt; len: number; across: number; axis: Pt; layer: number }[], c: Pt): FanRow[] {
  // by layer and outward direction, then by distance along it (pads within 0.02 mm of one line are on it)
  const by = new Map<string, { n: Pt; pads: FanPad[] }>();
  for (const q of pads) {
    const s = dot([q.p[0] - c[0], q.p[1] - c[1]], q.axis); if (Math.abs(s) < q.len / 2) continue;   // a pad in the middle
    const n: Pt = s > 0 ? q.axis : [-q.axis[0], -q.axis[1]]; const k = `${q.layer}/${Math.round(Math.atan2(n[1], n[0]) * 180 / Math.PI)}`;
    let r = by.get(k); if (!r) by.set(k, r = { n, pads: [] }); r.pads.push({ name: q.name, p: q.p, len: q.len, across: q.across, layer: q.layer });
  }
  const out: FanRow[] = [];
  for (const { n, pads: ps } of by.values()) {
    ps.sort((a, b) => dot(a.p, n) - dot(b.p, n)); const t: Pt = [-n[1], n[0]];
    for (let i = 0; i < ps.length;) {
      let k = i + 1; while (k < ps.length && dot(ps[k].p, n) - dot(ps[k - 1].p, n) < 0.02) k++;
      const line = ps.slice(i, k); i = k; if (line.length < 3) continue;
      line.sort((a, b) => dot(a.p, t) - dot(b.p, t)); out.push({ n, t, pads: line });
    }
  }
  return out;
}

// ---- lanes: the planar order of a row's slots (Copper's _maxh, _blocks, _lane_ok)
/** Highest ring level escape F's copper reaches inside the lateral window [lo, hi] (-1: none there). */
function maxH(F: Lane, lo: number, hi: number, rs: number): number {
  let h = -1; const tf = F.t;
  if (lo <= tf && tf <= hi) h = F.a;
  if (F.b > F.a) {
    const l0 = Math.min(tf, F.lane), l1 = Math.max(tf, F.lane); const i0 = Math.max(lo, l0), i1 = Math.min(hi, l1);
    if (i0 <= i1) { const far = Math.abs(i0 - tf) > Math.abs(i1 - tf) ? i0 : i1; h = Math.max(h, F.a + Math.abs(far - tf) / rs); }
  }
  return h;
}
/** Does F's copper close the outward lane of E (the ray from E's slot along the row normal)? */
function blocks(E: Lane, F: Lane, rs: number): boolean {
  const sp = (E.w + F.w) / 2 + Math.max(E.cl, F.cl);
  if (!E.real) {   // a pad not escaped yet: only a leg heading across its exit counts (its neighbours' stubs are where the part put them)
    if (F.b <= F.a) return false; const d = F.lane - F.t, off = E.t - F.t;
    return off * d > 0 && Math.abs(off) < Math.abs(d) + sp - LANE_TOL;
  }
  return maxH(F, E.lane - sp + LANE_TOL, E.lane + sp - LANE_TOL, rs) >= E.b - 1e-6;
}
function laneOK(E: Lane, others: Lane[], rs: number): boolean {
  for (const F of others) {
    if ((E.lane - F.lane) * (E.t - F.t) <= 0 && Math.abs(E.t - F.t) > LANE_TOL) return false;   // slot order is pad order
    if (blocks(E, F, rs) || blocks(F, E, rs)) return false;
  }
  return true;
}
/** Does a via in front of the row at lateral `lat` close the outward lane at `t`? */
const closes = (lat: number, vr: number, vclr: number, t: number, w: number, clr: number) => Math.abs(lat - t) < vr + Math.max(vclr, clr) + w / 2 - LANE_TOL;

// ---- min-cost flow (Copper's flow.py): successive shortest paths, Bellman-Ford on the residual graph.  The
// networks are unit-capacity assignments of a few hundred arcs, so the simple form is fast enough; costs are
// rounded to integers (nm) so ties are real ties and the answer never depends on float noise.
export function minCostFlow(n: number, edges: [number, number, number, number][], s: number, t: number, want: number): number[] {
  const m = edges.length; const to = new Int32Array(2 * m), cap = new Int32Array(2 * m), cost = new Float64Array(2 * m); const adj: number[][] = Array.from({ length: n }, () => []);
  edges.forEach(([u, v, c, w], i) => { const k = Math.round(w * 1e6); to[2 * i] = v; cap[2 * i] = c; cost[2 * i] = k; to[2 * i + 1] = u; cap[2 * i + 1] = 0; cost[2 * i + 1] = -k; adj[u].push(2 * i); adj[v].push(2 * i + 1); });
  let flow = 0;
  while (flow < want) {
    const dist = new Float64Array(n).fill(Infinity), via = new Int32Array(n).fill(-1); dist[s] = 0;
    for (let round = 0, changed = true; changed && round < n; round++) { changed = false; for (let u = 0; u < n; u++) if (dist[u] < Infinity) for (const a of adj[u]) if (cap[a] > 0 && dist[u] + cost[a] < dist[to[a]]) { dist[to[a]] = dist[u] + cost[a]; via[to[a]] = a; changed = true; } }
    if (dist[t] === Infinity) break;
    let f = want - flow; for (let v = t; v !== s; v = to[via[v] ^ 1]) f = Math.min(f, cap[via[v]]);
    for (let v = t; v !== s; v = to[via[v] ^ 1]) { cap[via[v]] -= f; cap[via[v] ^ 1] += f; }
    flow += f;
  }
  return edges.map(([, , c], i) => c - cap[2 * i]);
}

interface Geo { n: Pt; t: Pt; rs: number; R: number[] }
interface Option extends Escape { a: number; b: number; d: number; bin?: string; cut?: string; seq: number }

/** Escape the jobs' pads of each row.  `depth` is how far past the pad's end the first ring lies (at least one
 *  track pitch).  `spread` > 1 (ours, not Copper's; route.ts leaves it off) first tries a spreading fan: the slots of
 *  the row end `spread` times the pad pitch apart (each pin straight out, then a 45-degree leg away from the middle of
 *  the row, the outer pins turning first so the legs nest).  Returns the escapes laid (already handed to ctx.place) and the pads that got none. */
export function fanout(rows: FanRow[], jobs: Map<string, FanJob>, ctx: FanCtx, depth = 0, spread = 0): { escapes: Escape[]; boxed: Boxed[] } {
  const book = new Map<string, Escape>(); const boxed: Boxed[] = [];
  for (const row of rows) {
    const rj = row.pads.map((p) => jobs.get(p.name)).filter(Boolean) as FanJob[]; if (!rj.length) continue;
    // the row's usual track pitch sets the rings: one wide supply pin must not push every slot outwards
    const count = new Map<number, number>(); for (const j of rj) { const u = r6(j.w + j.clr); count.set(u, (count.get(u) || 0) + 1); }
    const rs = Array.from(count).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    const hl = Math.max(...row.pads.map((p) => p.len / 2)); const r1 = hl + Math.max(rs, depth);
    const geo: Geo = { n: row.n, t: row.t, rs, R: Array.from({ length: RINGS }, (_, k) => r6(r1 + k * rs)) };
    const tc = (p: FanPad) => dot(p.p, geo.t);
    const lanes = (skip: string): Lane[] => { const out: Lane[] = []; for (const p of row.pads) { if (p.name === skip) continue; const e = book.get(p.name); if (e) { if (e.lane) out.push(e.lane); } else { const j = jobs.get(p.name); if (j) out.push({ t: tc(p), lane: tc(p), a: 0, b: 0, w: j.w, cl: j.clr, real: false }); } } return out; };
    const ring = (j: FanJob, a: number, b: number, d: number): Option => {
      const ra = geo.R[a - 1], p1 = at(j.pad.p, geo.n, ra); const segs: [Pt, Pt][] = [[j.pad.p, p1]]; let end = p1, sh = 0;
      if (b > a) { sh = geo.R[b - 1] - ra; end = at(j.pad.p, geo.n, ra + sh, geo.t, d * sh); segs.push([p1, end]); }
      return { pad: j.pad, net: j.net, kind: "ring", segs, w: j.w, via: null, end, n: geo.n, lane: { t: tc(j.pad), lane: tc(j.pad) + d * sh, a, b, w: j.w, cl: j.clr, real: true }, cost: ra + sh * Math.SQRT2, a, b, d, seq: 0 };
    };
    const segHit = (j: FanJob, o: { segs: [Pt, Pt][]; w: number }) => { for (const [p, q] of o.segs) { const h = ctx.hit({ t: "seg", a: p, b: q, r: o.w / 2 }, j.pad.layer, j.net, j.clr); if (h !== null) return h; } return null; };
    // legal copper that leaves a way on from the slot: straight ahead or one of the two outward diagonals
    const check = (j: FanJob, o: Option): string | null => {
      const h = segHit(j, o); if (h !== null) return h; const e = o.end, len = geo.rs;
      let ahead: string | null = null;
      for (const dir of [geo.n, [geo.n[0] + geo.t[0], geo.n[1] + geo.t[1]] as Pt, [geo.n[0] - geo.t[0], geo.n[1] - geo.t[1]] as Pt]) { const q = ctx.hit({ t: "seg", a: e, b: at(e, dir, len), r: o.w / 2 }, j.pad.layer, j.net, j.clr); if (q === null) return null; ahead = ahead ?? q; }
      return ahead || "dead end";   // what stands straight ahead of the slot
    };
    const tryRing = (j: FanJob, cands: [number, number, number][]): [Option | null, string | null] => {
      let last: string | null = null;
      for (const [a, b, d] of cands) { const o = ring(j, a, b, d); if (!laneOK(o.lane!, lanes(j.pad.name), geo.rs)) { last = last || "lane taken"; continue; } const r = check(j, o); if (r === null) return [o, null]; if (last === null || last === "lane taken") last = r; }
      return [null, last];
    };
    const put = (o: Escape) => { const old = book.get(o.pad.name); if (old) ctx.unplace(old); ctx.place(o); book.set(o.pad.name, o); };
    // a pad whose partner is next to it needs no escape (its lane is still kept)
    const short = geo.R[0] + 2 * geo.rs;
    const active = rj.filter((j) => j.near >= short).sort((a, b) => tc(a.pad) - tc(b.pad));
    // the pads that must change layer try a via first (Copper's auto style); the rest, and those without a via, the ring
    const viaFirst = active.filter((j) => j.offLayer); const viaDone = viaEscape(viaFirst, row, geo, jobs, book, ctx, put);
    const ringJobs = active.filter((j) => !viaDone.has(j.pad.name));
    // pass 0, the spreading fan.  At the pad pitch two neighbours' tracks can only run on straight out side by side
    // (a 0.4 mm row at 0.2 / 0.15 mm), and off a part turned 45 degrees not even that on a routing grid; spread to
    // `spread` x the pitch they can go any way.  Pin k from the middle shifts k (spread - 1) pitches sideways on a
    // 45-degree leg that ends on one common line, H out from the pads; the outer pins turn first, so the legs nest.
    const fanned = new Set<string>();
    if (spread > 1 && ringJobs.length > 1) {
      let pitch = Infinity; for (let i = 1; i < row.pads.length; i++) pitch = Math.min(pitch, tc(row.pads[i]) - tc(row.pads[i - 1]));
      const mid = (tc(row.pads[0]) + tc(row.pads[row.pads.length - 1])) / 2, step = (spread - 1) * pitch;
      const shift = (j: FanJob) => Math.round((tc(j.pad) - mid) / pitch * 2) / 2 * step;
      const H = geo.R[0] + Math.max(...ringJobs.map((j) => Math.abs(shift(j)))); const lvl = (d: number) => 1 + (d - geo.R[0]) / geo.rs;
      // the outer pins first: an inner pin's leg must nest inside theirs, and a pin not laid yet only objects to a
      // leg that heads across its exit
      for (const j of ringJobs.slice().sort((a, b) => Math.abs(tc(b.pad) - mid) - Math.abs(tc(a.pad) - mid))) {
        const s = shift(j), turn = H - Math.abs(s), p1 = at(j.pad.p, geo.n, turn), end = at(j.pad.p, geo.n, H, geo.t, s);
        const segs: [Pt, Pt][] = Math.abs(s) < 1e-6 ? [[j.pad.p, end]] : [[j.pad.p, p1], [p1, end]];
        const o: Option = { pad: j.pad, net: j.net, kind: "ring", segs, w: j.w, via: null, end, n: geo.n, lane: { t: tc(j.pad), lane: tc(j.pad) + s, a: lvl(turn), b: lvl(H), w: j.w, cl: j.clr, real: true }, cost: turn + Math.abs(s) * Math.SQRT2, a: 0, b: 0, d: Math.sign(s), seq: 0 };
        if (laneOK(o.lane!, lanes(j.pad.name), geo.rs) && check(j, o) === null) { put(o); fanned.add(j.pad.name); }
      }
    }
    // pass 1: the straight stub to the first ring, in pad order
    const failed: FanJob[] = [];
    for (const j of ringJobs) { if (fanned.has(j.pad.name)) continue; const [o, why] = tryRing(j, [[1, 1, 0]]); if (o) put(o); else { j.blocker = why || undefined; failed.push(j); } }
    // pass 2: pads without a straight exit try a leg, towards the partner first
    const lean = (j: FanJob): number => {
      const v: Pt = [j.partner[0] - j.pad.p[0], j.partner[1] - j.pad.p[1]]; const fwd = dot(v, geo.n), lat = dot(v, geo.t);
      return Math.abs(lat) < geo.rs || Math.abs(lat) <= 0.41421356 * Math.max(fwd, 0) + 1e-9 ? 0 : lat > 0 ? 1 : -1;
    };
    const stuck: FanJob[] = [];
    for (const j of failed) {
      const d0 = lean(j) || 1; const cands: [number, number, number][] = []; for (const d of [d0, -d0]) for (const [a, b] of [[1, 2], [1, 3], [2, 3]]) cands.push([a, b, d]);
      const [o, why] = tryRing(j, cands); if (o) put(o); else { j.blocker = j.blocker || why || undefined; stuck.push(j); }
    }
    // pass 3: a pad whose partner is off to one side leans its slot that way where a lane is free; the pad nearest
    // the end of the row the fan heads to goes first, so the others nest inside it
    const straight = ringJobs.filter((j) => { const e = book.get(j.pad.name); return e && e.kind === "ring" && e.lane!.b === 1; }).map((j) => [j, lean(j)] as [FanJob, number]);
    const order = straight.filter((x) => x[1] < 0).sort((x, y) => tc(x[0].pad) - tc(y[0].pad)).concat(straight.filter((x) => x[1] > 0).sort((x, y) => tc(y[0].pad) - tc(x[0].pad)));
    for (const [j, d] of order) { const [o] = tryRing(j, [[1, 3, d], [2, 3, d], [1, 2, d]]); if (o) put(o); }
    // the last resort for a pad the ring cannot serve: a via
    const late = stuck.filter((j) => !j.offLayer); const got = viaEscape(late, row, geo, jobs, book, ctx, put);
    for (const j of stuck) if (!book.has(j.pad.name) && !got.has(j.pad.name)) {
      const bl = j.blocker && !["lane taken", "dead end"].includes(j.blocker) ? [j.blocker] : [];
      boxed.push({ pad: j.pad.name, net: j.net, reason: j.blocker === "lane taken" ? "every lane out is another pin's" : j.blocker === "dead end" ? "no way on past the escape" : "no legal escape", blockedBy: bl });
    }
  }
  return { escapes: Array.from(book.values()), boxed };
}

/** Via escapes for some pads of a row, matched to via sites by min-cost flow.  An outward via never closes the lane
 *  of another connected pad of the row.  Returns the pads that got one. */
function viaEscape(js: FanJob[], row: FanRow, geo: Geo, jobs: Map<string, FanJob>, book: Map<string, Escape>, ctx: FanCtx, put: (e: Escape) => void): Set<string> {
  const done = new Set<string>(); if (!js.length) return done;
  const batch = new Set(js.map((j) => j.pad.name)); const tc = (p: FanPad) => dot(p.p, geo.t);
  // the lanes an outward via must keep open: every connected pad of the row outside the batch
  const hard: [number, number, number][] = []; for (const p of row.pads) { if (batch.has(p.name)) continue; const e = book.get(p.name); if (e) { if (e.lane) hard.push([e.lane.lane, e.lane.w, e.lane.cl]); } else { const j = jobs.get(p.name); if (j) hard.push([tc(p), j.w, j.clr]); } }
  // the neighbouring pad pairs of the row: a stub through the gap between two of them uses one of its tracks
  const gaps: { a: FanPad; b: FanPad; tracks: number }[] = []; for (let i = 0; i + 1 < row.pads.length; i++) { const a = row.pads[i], b = row.pads[i + 1]; const g = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]) - (a.across + b.across) / 2; const j = js[0]; gaps.push({ a, b, tracks: Math.max(0, Math.floor((g - j.clr) / (j.w + j.clr) + 1e-9)) }); }
  const cross = (p: Pt, q: Pt, a: Pt, b: Pt) => { const o = (u: Pt, v: Pt, w: Pt) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]); return o(p, q, a) * o(p, q, b) < 0 && o(a, b, p) * o(a, b, q) < 0; };
  const opts = new Map<string, Option[]>(); let seq = 0; const bin = (v: Pt, size: number) => `${Math.floor(v[0] / size)},${Math.floor(v[1] / size)}`;
  let size = Infinity; for (const j of js) size = Math.min(size, (j.viaD + j.clr) * Math.SQRT1_2);
  // congestion: a site among vias already laid costs a track pitch per neighbour, so the vias spread out
  const crowd = (v: Pt, r: number) => { let k = 0; for (const e of book.values()) if (e.via && Math.hypot(e.via[0] - v[0], e.via[1] - v[1]) < r) k++; return k; };
  for (const j of js) {
    const list: Option[] = []; const vr = j.viaD / 2, lv = j.viaD + j.clr, dl = j.w + j.clr; let first: string | null = null;
    for (const [name, d] of [["out", geo.n], ["in", [-geo.n[0], -geo.n[1]] as Pt]] as [string, Pt][]) {
      const base = j.pad.len / 2 + j.clr + vr;
      for (let k = 0; k < VIA_DEPTHS; k++) for (const m of [0, -1, 1]) {
        const dist = base + k * lv; const v = at(j.pad.p, d, dist, geo.t, m * dl); const segs: [Pt, Pt][] = m === 0 ? [[j.pad.p, v]] : [[j.pad.p, at(j.pad.p, d, dist - dl)], [at(j.pad.p, d, dist - dl), v]];
        if (name === "out" && hard.some(([t, w, c]) => closes(dot(v, geo.t), vr, j.clr, t, w, c))) { first = first || "a via would close a neighbour's lane"; continue; }
        const o: Option = { pad: j.pad, net: j.net, kind: "via", segs, w: j.w, via: v, end: v, n: d, lane: null, cost: segs.reduce((s, [p, q]) => s + Math.hypot(q[0] - p[0], q[1] - p[1]), 0) + dl * crowd(v, 2 * lv), a: 0, b: 0, d: m, seq: seq++ };
        const h = viaCheck(j, o, ctx); if (h !== null) { first = first || h; continue; }
        const g = gaps.find((x) => x.a !== j.pad && x.b !== j.pad && segs.some(([p, q]) => cross(p, q, x.a.p, x.b.p))); if (g) { if (!g.tracks) continue; o.cut = g.a.name + "|" + g.b.name; }
        o.bin = bin(v, size); list.push(o);
      }
    }
    if (!list.length) j.blocker = j.blocker || first || "no via site"; opts.set(j.pad.name, list);
  }
  const used = new Set<string>(); let todo = js.filter((j) => opts.get(j.pad.name)!.length);
  for (let round = 0; todo.length && round < 50; round++) {
    // pads -> via columns (capacity 1: vias go through every layer) -> pad-pair gaps (their track capacity) -> sink
    const S = 0, T = 1; let n = 2 + todo.length; const edges: [number, number, number, number][] = []; const pick: (Option | null)[] = [];
    const binNode = new Map<string, number>(), cutNode = new Map<string, number>(); const tails = new Set<string>();
    todo.forEach((_, i) => { edges.push([S, 2 + i, 1, 0]); pick.push(null); });
    todo.forEach((j, i) => {
      const best = new Map<string, Option>(); for (const o of opts.get(j.pad.name)!) if (!used.has(o.bin!) && (!best.has(o.bin!) || o.cost < best.get(o.bin!)!.cost - 1e-12)) best.set(o.bin!, o);
      for (const [b, o] of Array.from(best).sort((x, y) => x[0] < y[0] ? -1 : 1)) {
        if (!binNode.has(b)) { binNode.set(b, n); n += 2; edges.push([binNode.get(b)!, binNode.get(b)! + 1, 1, 0]); pick.push(null); }
        edges.push([2 + i, binNode.get(b)!, 1, o.cost]); pick.push(o); tails.add(b + "\n" + (o.cut || ""));
      }
    });
    const gapCap = new Map(gaps.map((g) => [g.a.name + "|" + g.b.name, g.tracks]));
    for (const tl of Array.from(tails).sort()) { const [b, ck] = tl.split("\n"); if (!ck) edges.push([binNode.get(b)! + 1, T, 1, 0]); else { if (!cutNode.has(ck)) cutNode.set(ck, n++); edges.push([binNode.get(b)! + 1, cutNode.get(ck)!, 1, 0]); } pick.push(null); }
    for (const [ck, node] of Array.from(cutNode).sort()) { edges.push([node, T, gapCap.get(ck) || 0, 0]); pick.push(null); }
    const per = minCostFlow(n, edges, S, T, todo.length); const choice = new Map<string, Option>(); per.forEach((f, e) => { const o = pick[e]; if (f && o) choice.set(o.pad.name, o); });
    // the flow proposes, the exact check disposes: escapes placed this round are on the board now
    let dropped = false;
    for (const j of todo) { const o = choice.get(j.pad.name); if (!o) continue; const h = viaCheck(j, o, ctx); if (h === null) { put(o); done.add(j.pad.name); used.add(o.bin!); } else { opts.set(j.pad.name, opts.get(j.pad.name)!.filter((x) => x !== o)); j.blocker = j.blocker || h; dropped = true; } }
    todo = todo.filter((j) => !done.has(j.pad.name) && opts.get(j.pad.name)!.length);
    if (!dropped) break;
  }
  // a pad of the batch left without a via keeps its exit: the batch vias standing in front of it come out again
  const need = js.filter((j) => !done.has(j.pad.name));
  while (need.length) {
    const j = need.shift()!;
    for (const k of Array.from(done).sort()) { const e = book.get(k)!, jk = jobs.get(k)!; if (dot(e.n, geo.n) <= 0 || !closes(dot(e.via!, geo.t), jk.viaD / 2, jk.clr, tc(j.pad), j.w, j.clr)) continue; ctx.unplace(e); book.delete(k); done.delete(k); jk.blocker = "its via would close a neighbour's exit"; need.push(jk); }
  }
  return done;
}
function viaCheck(j: FanJob, o: Option, ctx: FanCtx): string | null {
  for (const [p, q] of o.segs) { const h = ctx.hit({ t: "seg", a: p, b: q, r: o.w / 2 }, j.pad.layer, j.net, j.clr); if (h !== null) return h; }
  return ctx.viaHit(o.via!, j);
}
