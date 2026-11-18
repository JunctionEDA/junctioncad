// The repair ladder: what to do, rung by rung, with the connections the routing passes left open.
//
// Ported from Copper's router v2 (src/copper_kicad/pcb/v2/repair.py, its S5 "bounded stuck ladder": run(), _passes(),
// rescue(), mincut_rip(), _cluster(), permute_cluster() and _feedback(); MIT licence, Clay Nicholson,
// github.com/claynicholson/copper-kicad-mcp).  As there, with RESCUE_FIRST:
// - one rung is tried on every open connection before the next rung starts, so a connection that needs the expensive
//   rungs cannot starve one a cheap rung repairs;
// - rescue: the open connection alone, laid again with one extra via (above the via limit, and outside the global
//   plan's corridor and layer assignment), then on a lattice of half the search pitch, then at neck width (the
//   board's minimum track width, with the two before), then from the other side of its escape.  It disturbs nobody;
// - min-cut rip (ripcut.ts): the cheapest set of routes in its way comes up, it is laid, they are laid again;
// - permutation: the open connection and the routed connections that fight for its channel (at most 5 in all, in a
//   12 x 12 mm box round where it failed) all come up and are laid in every order (lexicographic, at most 120 orders,
//   a shared prefix laid once, a prefix that cannot beat the best order so far cut off);
// - feedback (only with a global plan): the capacity of the tile borders where it failed is booked away, the plan is
//   made again for the connections that cross them (at most 12 a loop, 2 loops a board), and they are laid again.
// Every rung is a transaction: it is kept only when fewer connections are open and none that was laid before is open
// now (a permutation may trade one of its own members for another only when the count still drops, as Copper's
// does); otherwise everything goes back exactly as it was.  No clock and no randomness chooses anything: the time
// budget may only stop the ladder early.
// Ours: Copper's transactions are its RouteState's; here the host snapshots every connection's copper.  The host
// (route.ts) does the geometry; this file only decides what to try and what to keep.

export const CLUSTER_BOX_MM = 12, CLUSTER_MAX = 5, PERM_MAX = 120;
export const FEEDBACK_LOOPS = 2, FEEDBACK_MAX_CONNS = 12;
export type RescueRung = "via" | "half" | "neck" | "escape";
export const RESCUE_RUNGS: RescueRung[] = ["via", "half", "neck", "escape"];

export interface LadderReport { rescued: number; mincut: number; permuted: number; orders: number; feedback: number; rungs: Record<RescueRung, number>; tried: number; rolledBack: number }
export const emptyLadder = (): LadderReport => ({ rescued: 0, mincut: 0, permuted: 0, orders: 0, feedback: 0, rungs: { via: 0, half: 0, neck: 0, escape: 0 }, tried: 0, rolledBack: 0 });

/** What the ladder needs from the router.  Connections are named by id. */
export interface LadderHost<S> {
  /** The open connections the ladder may work on, in the order to try them. */
  open(): number[];
  /** Is the connection laid? */
  routed(id: number): boolean;
  timeUp(): boolean;
  snap(): S; back(s: S): void;
  /** Lay the connection alone with this rescue rung; it touches nothing else.  True when it was laid. */
  rescue(id: number, rung: RescueRung): boolean;
  /** Lay it by taking up the cheapest set of routes in its way (and laying them again). */
  mincut(id: number): boolean;
  /** The routed connections that fight for its channel, nearest first (it is not among them). */
  contesting(id: number): number[];
  /** Take the connections up (each with what hangs on it); returns every connection taken up. */
  rip(ids: number[]): number[];
  /** Lay one connection with the ordinary search (and the same last resort as a member of a cluster). */
  lay(id: number): boolean;
  /** Book away the tile borders where these failed and plan again for those crossing them: returns the connections
   *  to lay again (already taken up), or null when there is no plan or nothing to book. */
  replan?(failed: number[]): number[] | null;
  /** Keep (true) or drop (false) what the last replan did to the plan. */
  replanned?(keep: boolean): void;
}

export class Ladder<S> {
  rep = emptyLadder(); private tabu = new Set<string>(); private loops = 0;
  /** The host may change between calls (the router's repair makes a new one each time); the tabu list and the
   *  feedback loops stay with the ladder, one per board. */
  constructor(public h: LadderHost<S>) {}

  /** Run every rung over every open connection; returns how many connections it laid. */
  run(): number {
    const h = this.h; const start = h.open().length;
    const rungs: ((id: number) => boolean)[] = [(id) => this.rescue(id), (id) => this.mincut(id), (id) => this.permute(id)];
    for (const rung of rungs) {
      for (const id of h.open()) { if (h.timeUp()) return start - h.open().length; if (!h.routed(id)) rung(id); }
    }
    while (h.replan && this.loops < FEEDBACK_LOOPS && !h.timeUp()) { const open = h.open(); if (!open.length || !this.feedback(open)) break; }
    return start - h.open().length;
  }

  /** Keep what was done since `s` when fewer are open and nobody laid before is open now (`swap`: members of `own`
   *  may trade places while the count drops); else put everything back.  */
  private settle(s: S, before: Set<number>, own: Set<number> | null = null): boolean {
    const h = this.h; const open = h.open(); let lost = 0;
    for (const id of open) if (!before.has(id)) { if (!own || !own.has(id)) { lost = Infinity; break; } lost++; }
    if (open.length < before.size && lost !== Infinity) return true;
    h.back(s); this.rep.rolledBack++; return false;
  }

  private rescue(id: number): boolean {
    const h = this.h;
    for (const rung of RESCUE_RUNGS) {
      if (h.timeUp()) return false; this.rep.tried++;
      const before = new Set(h.open()), s = h.snap();
      if (h.rescue(id, rung) && h.routed(id)) { if (this.settle(s, before)) { this.rep.rescued++; this.rep.rungs[rung]++; return true; } }
      else h.back(s);
    }
    return false;
  }

  private mincut(id: number): boolean {
    const h = this.h; this.rep.tried++;
    const before = new Set(h.open()), s = h.snap();
    if (h.mincut(id)) { if (this.settle(s, before)) { this.rep.mincut++; return true; } }
    else { h.back(s); this.rep.rolledBack++; }
    return false;
  }

  /** Copper's permute_cluster: the cluster comes up and is laid in every order. */
  private permute(id: number): boolean {
    const h = this.h; const members = [id, ...h.contesting(id).filter((x) => x !== id)].slice(0, CLUSTER_MAX);
    if (members.length < 2) return false;
    const key = members.slice().sort((a, b) => a - b).join(","); if (this.tabu.has(key)) return false; this.tabu.add(key);
    this.rep.tried++;
    const before = new Set(h.open()), s0 = h.snap(); const base = members.filter((m) => !h.routed(m)).length;
    const ripped = h.rip(members.filter((m) => h.routed(m)));
    const order = members.slice();   // lexicographic over the given order (the open connection first, then nearest first)
    const tail = ripped.filter((x) => !members.includes(x)).sort((a, b) => a - b);   // what hung on a member: laid after every order
    // a member left open that cannot be laid even with the whole cluster up fails in every order (Copper's stuck test)
    let stuck = 0;
    for (const m of members) { if (before.has(m) && !h.timeUp()) { const t = h.snap(); if (!h.lay(m)) stuck++; h.back(t); } }
    if (stuck >= base) { h.back(s0); this.rep.rolledBack++; return false; }
    const best = { fails: base, order: null as number[] | null }; let orders = 0, found = false;
    const laid = (ids: number[]): number => { let f = 0; for (const x of ids) if (!h.lay(x)) { f++; if (f >= best.fails) break; } return f; };
    const dfs = (rest: number[], prefix: number[], fails: number): void => {
      if (!rest.length) {
        orders++; const t = h.snap(); const f = fails + laid(tail);
        if (f < best.fails) { best.fails = f; best.order = prefix.slice(); }
        if (f === 0) { found = true; return; }
        h.back(t); return;
      }
      for (const m of rest) {
        if (found || orders >= PERM_MAX || h.timeUp()) return;
        const t = h.snap(); const f2 = fails + (h.lay(m) ? 0 : 1);
        if (f2 < best.fails) dfs(rest.filter((x) => x !== m), prefix.concat(m), f2); else orders++;   // this prefix cannot beat the best: its orders are skipped
        if (found) return;
        h.back(t);
      }
    };
    dfs(order, [], 0);
    this.rep.orders += orders;
    if (!found && best.order) { for (const m of best.order) h.lay(m); for (const x of tail) h.lay(x); }
    if ((found || best.order) && this.settle(s0, before, new Set(members.concat(tail)))) { this.rep.permuted++; return true; }
    if (!found && !best.order) { h.back(s0); this.rep.rolledBack++; }
    return false;
  }

  /** Copper's _feedback: one loop.  True when it was kept. */
  private feedback(open: number[]): boolean {
    const h = this.h; if (!h.replan || !h.replanned) return false;
    const before = new Set(open), s = h.snap(); const todo = h.replan(open); if (!todo) return false;
    this.loops++; this.rep.tried++;
    for (const id of todo) { if (h.timeUp()) break; if (!h.routed(id)) h.lay(id); }
    if (this.settle(s, before)) { h.replanned(true); this.rep.feedback += before.size - h.open().length; return true; }
    h.replanned(false); return false;
  }
}
