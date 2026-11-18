// The hero: a cut-down board editor the visitor can use.  It is a real board (an STM32 USB-C
// devboard, ./hero) with nothing on it yet but its outline, painted by the editor's renderer, with
// just enough tools to work on it: move a footprint or a text, route a track, drop a via, switch
// layer, undo.  Three scripted collaborators design the board from scratch as teammates would in a
// real project: they take the parts out of the pile and place them, route every connection, pour
// the ground planes and stitch them, and add the silkscreen.  Nothing they do is idle: every
// selection is the start of an edit.  On the way one of them leaves a review comment on something
// that is not right yet (a capacitor in too small a package, a part the wrong way round, a thin
// supply track), another one makes the change, and the comment is resolved.  Each has a pointer
// that moves like a hand on a mouse and never does the same thing twice.  When the visitor has
// changed something one of them comes over and puts it back by hand.

import {
  Box, HIDDEN, K, PEERS, Pt, Rat, View, clamp, clash, copperAt, dist, drawCursor, fit, lerp, mixBox, ratsnest, toMm, toPx, trackAt,
} from "./demo";
import { BOARD, loadPcb, loadPcbOpen, meta } from "./hero";
import { keysInText } from "../../shared/keys";
import { SANS, Stage, makeStage, reducedMotion } from "./stage";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tool = "select" | "route" | "via";
type Layer = "F.Cu" | "B.Cu";
const GRID = 0.25, VIA = { size: 0.4, drill: 0.25 };
/** The board's net class clearance: new copper keeps this far from every other net. */
const CLEARANCE = 0.15;
const LAYER_COLOR: Record<Layer, string> = { "F.Cu": "#C83434", "B.Cu": "#4D7FC4" };
/** The back silkscreen (the pin names under the headers) would read mirrored through the board. */
const HID = new Set([...HIDDEN, "B.SilkS"]);
const HOME: Box = [BOARD.x - 4.5, BOARD.y - 3, BOARD.x + BOARD.w + 3, BOARD.y + BOARD.h + 3];
/** Where a part lies at the start: the pile is in rows left of the board, the groups mixed up. */
const pileAt = (p: { pile: Pt }): Pt => p.pile;
/** The view while the board is being built: the board, the pile its parts start in beside it, and under both the
 *  band where the parts are sorted into their groups. */
const BUILD: Box = [BOARD.x - meta.left - 2, HOME[1], Math.max(HOME[2], ...meta.groups.map((g) => g.box[2] + 2)), Math.max(meta.pileBottom, meta.stageBottom) + 2.5];
/** For each connection, the earlier ones it starts or ends on (a via, a track it tees into):
 *  those have to be on the board before it can be routed. */
const NEEDS: number[][] = meta.routes.map((r) => r.needs);
/** Connections the board starts without when the visitor has it to themselves (`?hero=alone`):
 *  the two LEDs and the two CC resistors, each a short track from pad to pad. */
const OPEN = meta.routes.map((r, i) => (r.loose && !r.via && /^Net-\((D1|D2)-A\)$|^Net-\(J1-CC[12]\)$/.test(r.net) ? i : -1)).filter((i) => i >= 0);
const PARTS = new Set(meta.parts.map((p) => p.id));
const TEXTS = new Set(meta.texts.map((t) => t.id));
/** The width each net is routed at: what the board's own tracks have. */
const WIDTH = new Map<string, number>(); for (const r of meta.routes) WIDTH.set(r.net, Math.max(WIDTH.get(r.net) || 0, r.w));
const PLANES = [{ net: meta.ground, layers: ["F.Cu", "B.Cu"] }];
const snap = (v: number, o: number): number => o + Math.round((v - o) / GRID) * GRID;

/** What a scripted teammate can be busy with.  All up to "fix" change the board and are seen
 *  through to the end; the rest can be dropped when the visitor's change needs taking back. */
type Task = "undo" | "sort" | "place" | "wire" | "route" | "label" | "pour" | "stitch" | "fix" | "note" | "rest";
const HARD = new Set<Task>(["undo", "sort", "place", "wire", "route", "label", "pour", "stitch", "fix"]);
/** How each of them handles a mouse: Mara is quick and overshoots, Jun is slower and exact. */
const HANDS = [{ tempo: 0.86, miss: 1.3 }, { tempo: 1.2, miss: 0.55 }, { tempo: 1, miss: 1 }];
/**
 * Review comments, each a small story with an end: the board starts with the thing not right
 * yet, one teammate says so in a comment on the part, another makes the change, and the comment
 * is resolved with `done`.
 *   swap:  the part comes out of the pile in the footprint of `like` (same pads, smaller package)
 *   turn:  it is placed half a turn round
 *   move:  it is placed `off` its place
 *   width: the net's tracks are laid at `thin` mm
 *   label: the silkscreen texts `texts` are still missing when the board is otherwise done
 */
interface Story { kind: "swap" | "turn" | "move" | "width" | "label"; ref: string; text: string; done: string; like?: string; off?: Pt; net?: string; thin?: number; texts?: string[]; state: 0 | 1 | 2; by: number }
const STORIES: Omit<Story, "state" | "by">[] = [
  { kind: "swap", ref: "C4", like: "C6", text: "C4 is 4.7 uF: that needs 0603, not 0402", done: "C4 is 0603 now" },
  { kind: "turn", ref: "U3", text: "U3 is the wrong way round: pin 1 is VBUS", done: "Turned U3 round" },
  { kind: "move", ref: "C5", off: [2.4, -2.75], text: "C5 belongs right at pin 5", done: "C5 moved next to pin 5" },
  { kind: "width", ref: "U3", net: "VBUS", thin: 0.2, text: "VBUS is thin for 500 mA: make it 0.4 mm", done: "VBUS is 0.4 mm now" },
  { kind: "label", ref: "SW1", texts: ["RST", "BOOT"], text: "Which button is reset? Label them", done: "Buttons labelled" },
];
/** A change the visitor made, kept so that it can be taken back: by them, or by a teammate. */
type Edit = { kind: "move"; id: string; from: Pt } | { kind: "add"; ids: string[] } | { kind: "del"; item: any };
/** One stretch of a teammate's pointer: to `to` in `dur` seconds, along a curve when `c` gives
 *  its two control points.  `skew` bends the speed (fast away, slow in), `wob` is how far the
 *  hand strays sideways on a drag. */
interface Step { dur: number; to: Pt; c?: [Pt, Pt]; skew?: number; wob?: number; ph?: number; start?: () => void; tick?: (at: Pt) => void; end?: () => void }
/** A track being pulled out by a teammate: from `a` towards `b`, so far up to `at`. */
interface Pull { a: Pt; b: Pt; at: Pt; layer: Layer; w: number }
interface Actor {
  who: number; at: Pt; from: Pt; steps: Step[]; i: number; t0: number; task: Task; last: Task;
  marks: string[]; held: string | null; pull: Pull | null; poly: Pt[] | null;
  move: { id: string; from: Pt } | null; route: number | null; story: Story | null;
  /** the cluster this one is moving onto the board */
  unit: number | null;
}
/** A comment pinned on the board: typed by `who`, kept until its story is resolved (`ok`). */
interface Note { who: number; at: Pt; text: string; n: number; born: number; dies: number; ok: boolean }
const IDLE = 2200, GAP = 900;                       // ms the visitor is left alone before, and between, undos
const AGAIN = 16000;                                // ms a finished board is left to be looked at before they start over
const minJerk = (u: number): number => u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (10 - 15 * u + 6 * u * u);
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const chance = (p: number): boolean => Math.random() < p;
/** Roughly -1 to 1, bunched around 0. */
const gauss = (): number => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const any1 = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

export function startMini(root: HTMLElement): void {
  const canvas = root.querySelector("canvas")!;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const xy = q("[data-xy]"), zoomOut = q("[data-z]"), counts = q("[data-counts]"), unrouted = q("[data-unrouted]"), toolName = q("[data-toolname]");
  const still = reducedMotion();
  /** `/?hero=alone` leaves the visitor the board to themselves, with the same four connections
   *  open every time: scripts/onboarding-ui.mjs routes one of them and carries the board over. */
  const alone = /[?&]hero=alone\b/.test(location.search);

  let doc = loadPcbOpen();
  let tool: Tool = "select", layer: Layer = "F.Cu", box: Box = HOME.slice() as Box;
  let view: View | null = null, selected: string | null = null, hover: Pt | null = null;
  let rats: Rat[] = [], dirty = true, touched = false;
  // What a teammate is carrying right now.  The board under it is drawn once without it and kept;
  // only the carried items (and the ratsnest, which follows them) are drawn again each frame.
  const motion = new Map<string, number>();
  let motionKey = "", clock = 0;
  const stir = (id: string): void => { motion.set(id, clock); };
  let drag: { id: string; from: Pt; grab: Pt; moved: boolean } | null = null;
  let pan: { at: Pt; box: Box } | null = null;
  let route: { net: number; from: Pt; layer: Layer; made: string[] } | null = null;
  const edits: Edit[] = [];
  const actors: Actor[] = []; const gone = new Set<number>();
  let note: Note | null = null;
  let lastAct = 0, nextUndo = 0, stillTimer = 0, doneAt = 0, blocked: number | null = null;
  let base: HTMLCanvasElement | null = null, t0 = 0, serial = 0;

  /** The tracks and vias taken off the board at the start, for the teammates to lay again. */
  const spare = new Map<string, any>();
  /** Takes a connection's tracks and via off the board and keeps them for laying again. */
  function lift(i: number): void {
    const r = meta.routes[i];
    for (const id of [...r.ids, ...(r.via ? [r.via] : [])]) { const it = doc.items.get(id); if (it) { spare.set(id, it); orig.set(id, it); doc.items.delete(id); } }
    gone.add(i);
  }
  /** Parts still in the pile, and the labels, the ground pours and their stitching vias not
   *  yet made: the teammates start from the bare outline and design the board while the
   *  visitor watches. */
  /** Parts still in the pile: each is sorted into its group's cluster before any part is placed. */
  const unsorted = new Set<string>();
  /** Clusters not on the board yet, and every track and via as it is on the finished board (a cluster's own
   *  tracks are laid beside the board first, shifted by the cluster's offset). */
  const staged = new Set<number>(), orig = new Map<string, any>();
  const UNIT = new Map<string, number>(); meta.units.forEach((u, k) => { for (const id of u.parts) UNIT.set(id, k); });
  const unplaced = new Set<string>(), shelf = new Map<string, any>(), stitches: string[] = [];
  let poured = true, fitTo: Box = HOME, own = false, glide: { from: Box; t0: number } | null = null;
  /** The review stories of this run, and for each part or track that starts out not right yet
   *  the real one, kept for when a teammate makes the change. */
  let stories: Story[] = [];
  const real = new Map<string, any>(), pending = new Set<string>();
  const refId = (ref: string): string => meta.parts.find((p) => p.ref === ref)!.id;
  const home = (id: string): Pt => { const q = meta.parts.find((p) => p.id === id)!; return [q.x, q.y]; };
  /** Where a part is put down: its place, or beside it while its "move" story is open. */
  const spotOf = (id: string): Pt => { const h = home(id), st = stories.find((x) => x.kind === "move" && x.state < 2 && refId(x.ref) === id); return st ? [h[0] + st.off![0], h[1] + st.off![1]] : h; };
  /** The parts each connection reaches, which have to be placed before it is routed. */
  const reaches: string[][] = (() => {
    const full = loadPcb();
    return meta.routes.map((r) => { const ids = new Set<string>(); for (const p of r.pts) { const c = copperAt(full, p[0], p[1], r.layer); if (c && c.kind === "pad") ids.add(c.id); } return [...ids]; });
  })();
  /** Connections that pass where a part waits beside its place: they wait until it has moved. */
  const crowded = new Map<number, string>();
  /** For each connection, the cluster it lies wholly inside (its pads are all that cluster's, and so is what it
   *  starts on), or -1: those are wired in the cluster before it goes onto the board. */
  const INNER: number[] = [];
  /** Each cluster's extent on the finished board: a connection that leaves it is not the cluster's own. */
  const UBOX: Box[] = (() => {
    const full = loadPcb();
    return meta.units.map((u) => { const b: Box = [Infinity, Infinity, -Infinity, -Infinity]; for (const id of u.parts) { const q = full.items.get(id)?.bbox; if (q) { b[0] = Math.min(b[0], q[0] - 1); b[1] = Math.min(b[1], q[1] - 1); b[2] = Math.max(b[2], q[2] + 1); b[3] = Math.max(b[3], q[3] + 1); } } return b; });
  })();
  meta.routes.forEach((r, i) => {
    const us = new Set(reaches[i].map((id) => UNIT.get(id)!)), ns = new Set(r.needs.map((k) => INNER[k]));
    for (const k of r.needs) if (k >= i) throw new Error("routes out of order");
    const all = new Set([...us, ...ns]);
    const u = all.size === 1 && !all.has(-1) && (us.size || ns.size) ? [...all][0] : -1;
    INNER[i] = u >= 0 && r.pts.every((q) => q[0] >= UBOX[u][0] && q[0] <= UBOX[u][2] && q[1] >= UBOX[u][1] && q[1] <= UBOX[u][3]) ? u : -1;
  });
  /** How far a connection is drawn from where it ends up: its cluster's offset while that waits beside the board. */
  const offOf = (i: number): Pt => INNER[i] >= 0 && staged.has(INNER[i]) ? meta.units[INNER[i]].off : [0, 0];
  /** A track or via moved by an offset, as an item of its own under the same id. */
  function shifted(it: any, off: Pt): any {
    if (!off[0] && !off[1]) return it;
    return variant(it, (node) => { for (const key of ["start", "end", "at"]) { const k = K.kid(node, key); if (k) { k[1] = f3(+k[1] + off[0]); k[2] = f3(+k[2] + off[1]); } } });
  }
  /** Puts a cluster, its parts and the tracks laid in it, `off` away from its place on the board. */
  function setUnit(u: number, off: Pt): void {
    for (const id of meta.units[u].parts) { const it = doc.items.get(id), h = spotOf(id); if (it) { K.moveItem(doc, it, f3(h[0] + off[0]), f3(h[1] + off[1]), 1e6); stir(id); } }
    meta.routes.forEach((r, i) => {
      if (INNER[i] !== u) return;
      for (const id of [...r.ids, ...(r.via ? [r.via] : [])]) { const base = orig.get(id); if (!base) continue; const had = doc.items.has(id); if (had) { doc.items.set(id, shifted(base, off)); stir(id); } else if (spare.has(id)) spare.set(id, shifted(base, off)); }
    });
  }
  /** A copy of an item's node with one thing changed, as an item of its own under the same id. */
  function variant(it: any, change: (node: any[]) => void): any {
    const node = K.parse(K.serialize(it.node)); change(node);
    doc.items.delete(it.id); const v = K.addItem(doc, node, it.id); doc.items.delete(it.id);
    return v;
  }
  function open(): void {
    spare.clear(); gone.clear(); unplaced.clear(); unsorted.clear(); staged.clear(); orig.clear(); shelf.clear(); stitches.length = 0; real.clear(); pending.clear(); crowded.clear(); stories = [];
    poured = true; fitTo = HOME; own = false; glide = null; doneAt = 0;
    if (still) return;                                   // without motion the board is simply complete
    if (alone) { for (const i of OPEN) lift(i); return; }
    stories = STORIES.map((x) => ({ ...x, state: 0, by: -1 }));
    meta.routes.forEach((_, i) => lift(i));
    for (const st of stories) {
      const id = refId(st.ref), it = doc.items.get(id);
      if (st.kind === "swap" && it) {
        // the smaller package: the neighbour's footprint under this part's name, pads on the same nets
        const like = doc.items.get(refId(st.like!))!, q = meta.parts.find((x) => x.id === id)!;
        const v = variant({ id, node: like.node }, (node) => { for (const p of K.kids(node, "property")) { if (p[1] === "Reference") p[2] = q.ref; else if (p[1] === "Value") p[2] = q.value; } });
        real.set(id, it); doc.items.set(id, v); K.moveItem(doc, v, q.x, q.y, 1e6); pending.add(id);
      } else if (st.kind === "turn" && it) {
        const v = variant(it, (node) => { const at = K.kid(node, "at"); at[3] = ((+at[3] || 0) + 180) % 360; });
        real.set(id, it); doc.items.set(id, v); pending.add(id);
      } else if (st.kind === "move") {
        pending.add(id); const c = spotOf(id);
        meta.routes.forEach((r, i) => { if (r.pts.some((p, k) => k > 0 && nearLine(c, r.pts[k - 1], p) < 1.5)) crowded.set(i, id); });
      } else if (st.kind === "width") {
        for (const r of meta.routes) if (r.net === st.net) for (const sid of r.ids) {
          const thick = spare.get(sid); if (!thick || (thick.geom as any[])[0].w <= st.thin!) continue;
          const thin = variant(thick, (node) => { K.kid(node, "width")[1] = st.thin; });
          real.set(sid, thick); spare.set(sid, thin); orig.set(sid, thin);
        }
      }
    }
    for (const q of meta.parts) { const it = doc.items.get(q.id); if (it) { const at = pileAt(q); K.moveItem(doc, it, at[0], at[1], 1e6); unplaced.add(q.id); unsorted.add(q.id); } }
    meta.units.forEach((_, k) => staged.add(k));
    for (const id of [...TEXTS, ...meta.zones, ...meta.stitch]) { const it = doc.items.get(id); if (it) { shelf.set(id, it); doc.items.delete(id); } }
    stitches.push(...meta.stitch);
    poured = false; fitTo = BUILD;
  }
  function nearLine(e: Pt, a: Pt, b: Pt): number { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy, t = l ? clamp(((e[0] - a[0]) * dx + (e[1] - a[1]) * dy) / l) : 0; return Math.hypot(e[0] - a[0] - t * dx, e[1] - a[1] - t * dy); }
  /** Brings every open story to its end at once: what the board is handed on as is the real one. */
  function settle(): void {
    for (const st of stories) { if (st.state < 2) finish(st); st.state = 2; }
    note = null;
  }
  /** The change a story asks for, made. */
  function finish(st: Story): void {
    const id = refId(st.ref);
    if (st.kind === "swap" || st.kind === "turn") {
      const it = real.get(id), cur = doc.items.get(id);
      if (it && cur) { const at = posOf(cur); doc.items.set(id, it); K.moveItem(doc, it, at[0], at[1], 1e6); real.delete(id); }
    } else if (st.kind === "move") {
      const it = doc.items.get(id), h = home(id); if (it && !unplaced.has(id)) K.moveItem(doc, it, h[0], h[1], 1e6);
      for (const [i, pid] of [...crowded]) if (pid === id) crowded.delete(i);
    } else if (st.kind === "width") {
      for (const r of meta.routes) if (r.net === st.net) for (const sid of r.ids) { const it = real.get(sid); if (!it) continue; if (doc.items.has(sid)) doc.items.set(sid, it); else if (spare.has(sid)) spare.set(sid, it); orig.set(sid, it); real.delete(sid); }
    }
    pending.delete(id);
  }
  open(); box = fitTo.slice() as Box;

  const netName = (net: number): string => { const n = (doc as any).nets && (doc as any).nets.get ? (doc as any).nets.get(net) : null; return typeof n === "string" && n ? n : `net ${net}`; };
  const netWidth = (net: number): number => WIDTH.get(netName(net)) || 0.2;
  const newId = (): string => `mini-${++serial}-${Math.random().toString(36).slice(2, 8)}`;
  const f3 = (v: number): number => Math.round(v * 1000) / 1000;
  function addSegment(a: Pt, b: Pt, net: number, on: Layer): string {
    const id = newId();
    K.addItem(doc, K.parse(`(segment (start ${f3(a[0])} ${f3(a[1])}) (end ${f3(b[0])} ${f3(b[1])}) (width ${netWidth(net)}) (layer "${on}") (net ${net}) (uuid "${id}"))`));
    return id;
  }
  function addVia(at: Pt, net: number): string {
    const id = newId();
    K.addItem(doc, K.parse(`(via (at ${f3(at[0])} ${f3(at[1])}) (size ${VIA.size}) (drill ${VIA.drill}) (layers "F.Cu" "B.Cu") (net ${net}) (uuid "${id}"))`));
    return id;
  }
  const posOf = (it: any): Pt => { const at = K.atOf(it.node); return [at[0], at[1]]; };
  /** What a press with the arrow tool takes hold of: the item under it, and a text anywhere in its box. */
  function pick(at: Pt): string | null {
    const hit: string | null = K.hitTest(doc, at[0], at[1], 0.3, { hidden: HID });
    // A track or via under the pointer beats a part that is only hit by its outline, as in
    // PCB_SELECTION_TOOL::GuessSelectionCandidates: on a pad the part still wins.
    if (hit && PARTS.has(hit)) {
      const tr = trackAt(doc, at[0], at[1], 0), it = tr ? doc.items.get(tr) : null;
      if (it) { const on = it.kind === "via" ? layer : (it.geom as any[])[0].layer, c = copperAt(doc, at[0], at[1], on); if (!c || c.kind !== "pad") return tr; }
    }
    if (hit && (PARTS.has(hit) || TEXTS.has(hit))) return hit;
    for (const it of doc.items.values()) if (TEXTS.has(it.id) && it.bbox && at[0] >= it.bbox[0] && at[0] <= it.bbox[2] && at[1] >= it.bbox[1] && at[1] <= it.bbox[3]) return it.id;
    return hit;
  }
  /** The other net whose copper is under the pointer while a track is being laid, if any. */
  function foreign(at: Pt | null): number | null {
    if (!route || !at) return null;
    const c = copperAt(doc, at[0], at[1], route.layer);
    return c && c.net !== route.net ? c.net : null;
  }
  const movable = (id: string | null): boolean => !!id && (PARTS.has(id) || TEXTS.has(id));
  /** One undo step that takes back everything added since `made` was started. */
  function remember(made: string[]): void { if (made.length) edits.push({ kind: "add", ids: made }); }
  function revert(e: Edit): void {
    if (e.kind === "move") { const it = doc.items.get(e.id); if (it) K.moveItem(doc, it, e.from[0], e.from[1], 1e6); }
    else if (e.kind === "add") { for (const id of e.ids) doc.items.delete(id); }
    else doc.items.set(e.item.id, e.item);
  }
  function redraw(): void { dirty = true; stage.invalidate(); sync(); }
  function change(): void {
    touched = true; lastAct = performance.now(); redraw();
    // Without motion nobody walks over: the change is simply taken back after a moment.
    if (still) { clearTimeout(stillTimer); stillTimer = window.setTimeout(stillUndo, IDLE + 600); }
  }
  function stillUndo(): void {
    if (drag || route) { stillTimer = window.setTimeout(stillUndo, GAP); return; }
    const e = edits.pop(); if (!e) return;
    revert(e); selected = null; redraw();
    if (edits.length) stillTimer = window.setTimeout(stillUndo, GAP + 300);
  }

  // ------------------------------------------------------------------ teammates

  const inset = (m: number): Pt => [rnd(BOARD.x + m, BOARD.x + BOARD.w - m), rnd(BOARD.y + m, BOARD.y + BOARD.h - m)];
  /** The point of the line a-b nearest the pointer, on the grid along it; a little past `b` is
   *  allowed, since a hand runs over the corner before it comes back to click. */
  function along(a: Pt, b: Pt, c: Pt): Pt {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy); if (len < 1e-6) return a;
    const t = clamp(((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / (len * len), 0, 1 + 0.6 / len), s = Math.round((t * len) / GRID) * GRID;
    return [a[0] + (dx / len) * s, a[1] + (dy / len) * s];
  }
  /** Where a step's pointer is at `u` (0 to 1) of its time. */
  function spot(from: Pt, st: Step, u: number): Pt {
    const k = minJerk(st.skew ? Math.pow(u, st.skew) : u), j = 1 - k;
    let x = lerp(from[0], st.to[0], k), y = lerp(from[1], st.to[1], k);
    if (st.c) {
      const [p, q] = st.c;
      x = j * j * j * from[0] + 3 * j * j * k * p[0] + 3 * j * k * k * q[0] + k * k * k * st.to[0];
      y = j * j * j * from[1] + 3 * j * j * k * p[1] + 3 * j * k * k * q[1] + k * k * k * st.to[1];
    }
    if (st.wob) {
      const dx = st.to[0] - from[0], dy = st.to[1] - from[1], d = Math.hypot(dx, dy) || 1, s = st.wob * Math.sin((st.ph || 0) + u * 9) * Math.sin(Math.PI * u);
      x -= (dy / d) * s; y += (dx / d) * s;
    }
    return [x, y];
  }
  /**
   * Writes a teammate's pointer the way a hand moves a mouse.  A reach takes longer the further
   * it goes (Fitts's law) and never the same time twice; it follows a bent path, leaves fast and
   * comes in slowly, often lands a little past or short of the target and is then corrected, and
   * on a long way it may stop once to look.  While waiting the hand shifts now and then.
   */
  function plan(who: number, from: Pt) {
    const h = HANDS[who], steps: Step[] = []; let at = from;
    const curve = (to: Pt, dur: number, bend: number): void => {
      const dx = to[0] - at[0], dy = to[1] - at[1], d = Math.hypot(dx, dy) || 1, nx = -dy / d, ny = dx / d;
      const b1 = gauss() * d * 0.17 * bend, b2 = (chance(0.8) ? b1 : -b1) * rnd(0.3, 1.1), k1 = rnd(0.18, 0.42), k2 = rnd(0.58, 0.86);
      steps.push({ dur, to, skew: rnd(0.7, 0.98), c: [[at[0] + dx * k1 + nx * b1, at[1] + dy * k1 + ny * b1], [at[0] + dx * k2 + nx * b2, at[1] + dy * k2 + ny * b2]] });
      at = to;
    };
    const reach = (to: Pt): void => {
      const d = dist(at, to); if (d < 0.02) return;
      const dx = (to[0] - at[0]) / d, dy = (to[1] - at[1]) / d;
      const T = (0.17 + 0.15 * Math.log2(1 + d / 1.5)) * rnd(0.82, 1.3) * h.tempo;
      if (d > 14 && chance(0.2)) {                         // a stop on the way, to find the thing
        const k = rnd(0.35, 0.68), off = gauss() * d * 0.07;
        curve([at[0] + dx * d * k - dy * off, at[1] + dy * d * k + dx * off], T * (0.35 + k * 0.65), 1);
        steps.push({ dur: rnd(0.16, 0.55), to: at });
        reach(to); return;
      }
      if (d > 5 && chance(0.5 * h.miss)) {                 // past it or short of it, then corrected
        const over = (chance(0.75) ? 1 : -1) * Math.min(1.6, d * rnd(0.03, 0.075)), side = gauss() * Math.min(0.9, d * 0.035);
        curve([to[0] + dx * over - dy * side, to[1] + dy * over + dx * side], T, 1);
        steps.push({ dur: rnd(0.04, 0.13), to: at });
        curve(to, rnd(0.13, 0.24) * h.tempo, 0.4);
      } else curve(to, T, 1);
    };
    const p = {
      steps,
      get at(): Pt { return at; },
      /** Stay exactly here, then do `fn`. */
      wait(sec: number, fn?: () => void) { steps.push({ dur: sec, to: at, end: fn }); return p; },
      /** Stay around here: still for a while, a small shift, still again. */
      rest(sec: number) {
        let left = sec;
        while (left > 0) {
          const s = Math.min(left, rnd(0.45, 1.5)); steps.push({ dur: s, to: at }); left -= s;
          if (left > 0.25 && chance(0.55)) { const t = rnd(0.12, 0.3); curve([at[0] + gauss() * 0.5, at[1] + gauss() * 0.5], t, 0.3); left -= t; }
        }
        return p;
      },
      /** Reach for a point. */
      go(to: Pt) { reach(to); return p; },
      /** The beat on a point before the button goes down, then `fn`. */
      click(fn: () => void) { steps.push({ dur: rnd(0.07, 0.17), to: at, end: fn }); return p; },
      /** Drag to a point with the button held: nearly straight, at `speed` mm a second, with
       *  a pause on the way now and then. */
      pull(to: Pt, speed: number, tick: (at: Pt) => void, lo = 0.3, hi = 3) {
        const d = dist(at, to), sec = clamp(d / speed, lo, hi) * h.tempo, wob = (): number => Math.min(0.32, d * 0.05) * rnd(0.3, 1);
        if (d > 4 && chance(0.2)) {
          const k = rnd(0.3, 0.7), mid: Pt = [lerp(at[0], to[0], k), lerp(at[1], to[1], k)];
          steps.push({ dur: sec * k + 0.08, to: mid, wob: wob(), ph: rnd(0, 6), skew: rnd(0.8, 1), tick });
          steps.push({ dur: rnd(0.15, 0.5), to: mid, tick });
          steps.push({ dur: sec * (1 - k) + 0.08, to, wob: wob(), ph: rnd(0, 6), skew: rnd(0.8, 1), tick });
        } else steps.push({ dur: sec, to, wob: wob(), ph: rnd(0, 6), skew: rnd(0.8, 1), tick });
        at = to;
        return p;
      },
    };
    return p;
  }
  type Plan = ReturnType<typeof plan>;

  /** Puts the three of them on the board, each waiting a different moment before starting. */
  function cast(now: number): void {
    actors.length = 0; note = null;
    if (alone) return;
    const py = BOARD.y + BOARD.h + 8;
    const at: Pt[] = unplaced.size ? [[BOARD.x - 28, py], [BOARD.x - 8, py + 3], [BOARD.x - 18, py - 2]] : [[BOARD.x + 9, BOARD.y + 4], [BOARD.x + 34, BOARD.y + 6], [BOARD.x + 17, BOARD.y + 14]];
    PEERS.forEach((_, who) => {
      const p: Pt = still ? at[who] : [at[who][0] + gauss() * 3, at[who][1] + gauss() * 2];
      actors.push({ who, at: p, from: p, steps: [{ dur: 0.5 + who * 0.8 + rnd(0, 0.5), to: p }], i: 0, t0: now, task: "rest", last: "rest", marks: [], held: null, pull: null, poly: null, move: null, route: null, story: null, unit: null });
    });
  }
  /** Lets go of whatever a teammate holds or shows. */
  function drop(a: Actor, now: number): void {
    if (a.task === "note" && a.story && a.story.state === 0 && note && !note.ok) note = null;   // interrupted while typing: it is written again later
    if (a.task === "undo") nextUndo = now + GAP;
    a.last = a.task; a.task = "rest"; a.steps = []; a.i = 0; a.t0 = now; a.from = a.at;
    a.marks = []; a.held = null; a.pull = null; a.poly = null; a.move = null; a.route = null; a.story = null; a.unit = null;
  }
  /** Moves a teammate along to `now`, running what their steps do, and has them pick the next
   *  thing when one is finished. */
  function run(a: Actor, now: number): void {
    for (;;) {
      const st = a.steps[a.i];
      if (!st) { drop(a, now); think(a, now); if (!a.steps.length) return; continue; }
      const u = st.dur > 0 ? (now - a.t0) / (st.dur * 1000) : 1;
      if (st.start) { st.start(); st.start = undefined; }
      a.at = spot(a.from, st, clamp(u));
      if (st.tick) st.tick(a.at);
      if (u < 1) return;
      a.at = st.to; if (st.end) st.end();
      if (a.steps[a.i] !== st) return;                      // what it did ended the task
      a.from = st.to; a.t0 += st.dur * 1000; a.i++;
    }
  }
  /** Carries an item with the pointer, on the grid measured from `home`. */
  function carry(it: any, c: Pt, home: Pt): void {
    const x = snap(c[0], home[0]), y = snap(c[1], home[1]), q = posOf(it);
    if (q[0] !== x || q[1] !== y) { K.moveItem(doc, it, x, y, 1e6); stir(it.id); }
  }

  /** Takes back the visitor's latest change the way a person would: over to it, press, and
   *  slowly back to where it was. */
  function planUndo(a: Actor, p: Plan, e: Edit): boolean {
    if (e.kind === "move") {
      const it = doc.items.get(e.id); if (!it) return false;
      const at = posOf(it), home = e.from; if (dist(at, home) < 1e-6) return false;
      a.move = { id: e.id, from: home };
      p.go(at).click(() => { a.marks = [e.id]; });
      p.pull(home, rnd(4, 6), (c) => carry(it, c, home), 1, 3.2);
      p.wait(0.05, () => { K.moveItem(doc, it, home[0], home[1], 1e6); redraw(); });
      p.wait(0.3, () => { a.marks = []; a.move = null; });
    } else if (e.kind === "add") {
      // Last placed first, one piece at a time, as repeated undo would.
      for (const id of e.ids.slice().reverse()) {
        const it = doc.items.get(id), g = it && (it.geom as any[])[0]; if (!g) continue;
        const c: Pt = it!.kind === "via" ? [g.x, g.y] : [lerp(g.x1, g.x2, rnd(0.3, 0.7)), lerp(g.y1, g.y2, rnd(0.3, 0.7))];
        p.go(c).click(() => { a.marks = [id]; });
        p.wait(rnd(0.2, 0.4), () => { doc.items.delete(id); a.marks = []; redraw(); });
      }
    } else {
      // Something the visitor deleted is laid again.
      const it = e.item, g = (it.geom as any[])[0];
      if (it.kind === "via" || !g) { if (g) p.go([g.x, g.y]); p.click(() => { doc.items.set(it.id, it); redraw(); }); }
      else {
        const s: Pt = [g.x1, g.y1], t: Pt = [g.x2, g.y2];
        p.go(s).click(() => { a.pull = { a: s, b: t, at: s, layer: g.layer, w: g.w }; });
        p.pull(t, rnd(5.5, 8.5), (c) => { if (a.pull) a.pull.at = along(s, t, c); }, 0.45, 1.6);
        p.click(() => { a.pull = null; doc.items.set(it.id, it); redraw(); });
      }
    }
    p.rest(rnd(0.2, 0.5));
    return p.steps.length > 1;
  }
  /** Routes an open connection as the router does it: click on the pad, pull the track out,
   *  click at each corner, and the via drops where it ends. */
  function planRoute(a: Actor, p: Plan, ri: number): boolean {
    const r = meta.routes[ri], off = offOf(ri), pts = (r.pts as Pt[]).map((q): Pt => [f3(q[0] + off[0]), f3(q[1] + off[1])]), on = r.layer as Layer;
    if (off[0] || off[1]) for (const id of [...r.ids, ...(r.via ? [r.via] : [])]) { const base = orig.get(id); if (base && spare.has(id)) spare.set(id, shifted(base, off)); }
    const out = (i: number): Pull | null => { const it = spare.get(r.ids[i]); return it ? { a: pts[i], b: pts[i + 1], at: pts[i], layer: on, w: (it.geom as any[])[0].w } : null; };
    a.route = ri;
    p.go(pts[0]).click(() => { a.pull = out(0); });
    for (let i = 1; i < pts.length; i++) {
      const s = pts[i - 1], t = pts[i], id = r.ids[i - 1], last = i === pts.length - 1, d = dist(s, t) || 1;
      const tick = (c: Pt): void => { if (a.pull) a.pull.at = along(s, t, c); };
      if (d > 1.5 && chance(0.3 * HANDS[a.who].miss)) {     // runs over the corner and comes back
        const o = rnd(0.25, 0.6);
        p.pull([t[0] + ((t[0] - s[0]) / d) * o, t[1] + ((t[1] - s[1]) / d) * o], rnd(5, 9), tick, 0.3, 1.5).wait(rnd(0.04, 0.1));
        p.pull(t, 4, tick, 0.12, 0.2);
      } else p.pull(t, rnd(5, 9), tick, 0.3, 1.5);
      p.click(() => {
        const it = spare.get(id); if (it) { doc.items.set(id, it); spare.delete(id); }
        if (last) { a.pull = null; const v = r.via ? spare.get(r.via) : null; if (v) { doc.items.set(v.id, v); spare.delete(v.id); } gone.delete(ri); } else a.pull = out(i);
        redraw();
      });
      if (!last && chance(0.3)) p.wait(rnd(0.15, 0.5));       // looks where it goes next
    }
    p.rest(rnd(0.3, 0.9));
    return true;
  }
  /** Takes a part out of the pile and puts it in its place, sometimes a little off first. */
  function planPlace(a: Actor, p: Plan, id: string): boolean {
    const it = doc.items.get(id); if (!it || !PARTS.has(id)) return false;
    const to = spotOf(id), tick = (c: Pt): void => carry(it, c, to);
    a.move = { id, from: to };
    p.go(posOf(it)).click(() => { a.held = id; });
    if (chance(0.35 * HANDS[a.who].miss)) {
      p.pull([to[0] + gauss() * 1.6, to[1] + gauss() * 1.2], rnd(26, 36), tick, 0.6, 1.7).rest(rnd(0.2, 0.6));
      p.pull(to, 3, tick, 0.25, 0.6);
    } else p.pull(to, rnd(26, 36), tick, 0.6, 1.7);
    p.click(() => { K.moveItem(doc, it, to[0], to[1], 1e6); unplaced.delete(id); a.held = null; a.move = null; redraw(); });
    p.rest(rnd(0.1, 0.5));
    return true;
  }
  /** Moves a finished cluster onto the board in one piece: its parts and the tracks between them. */
  function planUnit(a: Actor, p: Plan, u: number): boolean {
    const unit = meta.units[u], size = (id: string): number => { const b = doc.items.get(id)?.bbox; return b ? (b[2] - b[0]) * (b[3] - b[1]) : 0; };
    const lead = unit.parts.reduce((b, id) => (size(id) > size(b) ? id : b), unit.parts[0]), it = doc.items.get(lead); if (!it) return false;
    const to = spotOf(lead);
    const tick = (c: Pt): void => { const off: Pt = [snap(c[0], to[0]) - to[0], snap(c[1], to[1]) - to[1]], q = posOf(it); if (Math.abs(q[0] - to[0] - off[0]) > 1e-6 || Math.abs(q[1] - to[1] - off[1]) > 1e-6) setUnit(u, off); };
    a.unit = u;
    p.go(posOf(it)).click(() => { a.held = lead; a.marks = unit.parts.filter((id) => id !== lead); });
    p.pull(to, rnd(20, 28), tick, 0.8, 2.2);
    p.click(() => {
      staged.delete(u); setUnit(u, [0, 0]);
      for (const id of unit.parts) unplaced.delete(id);
      a.held = null; a.marks = []; a.unit = null; redraw();
    });
    p.rest(rnd(0.2, 0.6));
    return true;
  }
  /** Takes a part out of the pile to its group's cluster under the board. */
  function planSort(a: Actor, p: Plan, id: string): boolean {
    const it = doc.items.get(id), q = meta.parts.find((x) => x.id === id); if (!it || !q) return false;
    const h = spotOf(id), off = meta.units[UNIT.get(id)!].off, to: Pt = [f3(h[0] + off[0]), f3(h[1] + off[1])], tick = (c: Pt): void => carry(it, c, to);
    a.move = { id, from: to };
    p.go(posOf(it)).click(() => { a.held = id; });
    p.pull(to, rnd(52, 70), tick, 0.5, 1.4);                  // sorting is quick work: nothing has to land exactly
    p.click(() => { K.moveItem(doc, it, to[0], to[1], 1e6); unsorted.delete(id); a.held = null; a.move = null; redraw(); });
    p.rest(rnd(0.05, 0.3));
    return true;
  }
  /** Adds one of the silkscreen texts: it appears on the pointer and is set down where it goes. */
  function planLabel(a: Actor, p: Plan, id: string): boolean {
    const it = shelf.get(id); if (!it) return false;
    const home = posOf(it), from: Pt = [home[0] + rnd(-7, 7), home[1] + rnd(3, 6) * (home[1] > BOARD.y + BOARD.h / 2 ? -1 : 1)];
    p.go(from).wait(rnd(0.3, 0.7), () => { shelf.delete(id); doc.items.set(id, it); carry(it, from, home); a.held = id; a.move = { id, from: home }; redraw(); });
    p.pull(home, rnd(7, 10), (c) => carry(it, c, home), 0.5, 1.4);
    p.click(() => { K.moveItem(doc, it, home[0], home[1], 1e6); a.held = null; a.move = null; redraw(); });
    p.rest(rnd(0.2, 0.6));
    return true;
  }
  /** Draws the ground planes: a click in each corner of the board, and the zones fill, front
   *  and back, when the outline closes. */
  function planPour(a: Actor, p: Plan): boolean {
    const zs = meta.zones.map((id) => shelf.get(id)).filter(Boolean); if (!zs.length) return false;
    const B = BOARD, c: Pt[] = [[B.x, B.y], [B.x + B.w, B.y], [B.x + B.w, B.y + B.h], [B.x, B.y + B.h]];
    const k = Math.floor(rnd(0, 4)), ring = chance(0.5) ? [0, 1, 2, 3, 4] : [0, 3, 2, 1, 4], at = (i: number): Pt => c[(k + ring[i]) % 4];
    p.go(at(0)).rest(rnd(0.3, 0.8)).go(at(0)).click(() => { a.poly = [at(0)]; a.pull = { a: at(0), b: at(1), at: at(0), layer: "B.Cu", w: 0.2 }; });
    for (let i = 1; i <= 4; i++) {
      const s = at(i - 1), t = at(i);
      p.pull(t, rnd(16, 24), (q) => { if (a.pull) a.pull.at = along(s, t, q); }, 0.5, 1.6);
      p.click(() => {
        if (i < 4) { a.poly!.push(t); a.pull = { a: t, b: at(i + 1), at: t, layer: "B.Cu", w: 0.2 }; return; }
        a.poly = null; a.pull = null; for (const z of zs) { shelf.delete(z.id); doc.items.set(z.id, z); } poured = true; redraw();
      });
      if (i < 4 && chance(0.3)) p.wait(rnd(0.15, 0.4));
    }
    p.rest(rnd(0.8, 1.6));
    return true;
  }
  /** Ties the two ground planes together: a run of vias, one click each, the nearest first. */
  function planStitch(a: Actor, p: Plan): boolean {
    const mine: string[] = []; let at = a.at;
    const where = (id: string): Pt => { const g = (shelf.get(id).geom as any[])[0]; return [g.x, g.y]; };
    for (let n = Math.round(rnd(4, 8)); n > 0 && stitches.length; n--) {
      let k = 0; for (let i = 1; i < stitches.length; i++) if (dist(where(stitches[i]), at) < dist(where(stitches[k]), at)) k = i;
      const id = stitches.splice(k, 1)[0]; mine.push(id); at = where(id);
    }
    if (!mine.length) return false;
    for (const id of mine) p.go(where(id)).click(() => { const v = shelf.get(id); if (v) { shelf.delete(id); doc.items.set(id, v); redraw(); } });
    p.rest(rnd(0.3, 0.8));
    return true;
  }
  /** Where a story's comment is pinned: on its part, or on the first track of its net. */
  function pinOf(st: Story): Pt | null {
    if (st.kind === "width") { for (const r of meta.routes) if (r.net === st.net && r.ids.every((id) => doc.items.has(id))) { const i = Math.floor(r.pts.length / 2); return [(r.pts[i - 1][0] + r.pts[i][0]) / 2, (r.pts[i - 1][1] + r.pts[i][1]) / 2]; } return null; }
    const it = doc.items.get(refId(st.ref)); return it ? posOf(it) : null;
  }
  /** Pins a review comment where the trouble is and types it.  It stays until someone has made the change. */
  function planNote(a: Actor, p: Plan, st: Story): boolean {
    const c = pinOf(st); if (!c) return false;
    const at: Pt = [c[0] + gauss() * 0.2, c[1] + gauss() * 0.2], text = st.text;
    const n: Note = { who: a.who, at, text, n: 0, born: 0, dies: Infinity, ok: false };
    a.story = st;
    p.go(at).rest(rnd(0.5, 1.1)).go(at).click(() => { n.born = performance.now(); note = n; });
    p.wait(rnd(0.4, 0.9));                                    // hands go to the keyboard
    for (let i = 0; i < text.length; i++) p.wait((/[ ,?:]/.test(text[i]) ? rnd(0.09, 0.22) : rnd(0.035, 0.1)) * (chance(0.06) ? 4 : 1), () => { n.n = i + 1; });
    p.wait(rnd(0.5, 0.9), () => { st.state = 1; st.by = a.who; });
    return true;
  }
  /** Does what a comment asks for, and resolves it. */
  function planFix(a: Actor, p: Plan, st: Story): boolean {
    const id = refId(st.ref), c = pinOf(st); if (!c) return false;
    const resolved = (): void => { finish(st); st.state = 2; a.marks = []; a.held = null; a.move = null; note = { who: a.who, at: note ? note.at : c, text: st.done, n: st.done.length, born: performance.now() - 200, dies: performance.now() + 3200, ok: true }; redraw(); };
    a.story = st;
    p.go([c[0] + rnd(1.5, 3), c[1] + rnd(1, 2.5)]).rest(rnd(0.7, 1.4));         // reads the comment
    if (st.kind === "move") {
      const it = doc.items.get(id)!, h = home(id);
      a.move = { id, from: h };
      p.go(posOf(it)).click(() => { a.held = id; });
      p.pull(h, rnd(3.5, 5), (q) => carry(it, q, h), 0.6, 1.8);
      p.click(resolved);
    } else if (st.kind === "swap" || st.kind === "turn") {
      p.go(c).click(() => { a.marks = [id]; });
      p.wait(rnd(0.7, 1.2), resolved);                        // Change Footprint, or R twice
    } else if (st.kind === "width") {
      const ids = meta.routes.filter((r) => r.net === st.net).flatMap((r) => r.ids);
      p.go(c).click(() => { a.marks = ids.filter((x) => doc.items.has(x)); });
      p.wait(rnd(0.8, 1.3), resolved);
    } else {
      const ids = meta.texts.filter((t) => st.texts!.includes(t.text)).map((t) => t.id);
      for (const tid of ids) planLabel(a, p, tid);
      p.wait(0.1, resolved);
    }
    p.rest(rnd(0.5, 1));
    return true;
  }

  /** What a teammate turns to next.  There is always board work to do until the board is done:
   *  parts to place, connections to route, the planes, the stitching, the labels; and a comment
   *  to write where something is not right yet, or one of a colleague's to act on. */
  function think(a: Actor, now: number): void {
    const others = actors.filter((o) => o !== a), doing = (t: Task): boolean => others.some((o) => o.task === t);
    const quiet = !edits.length && !drag && !route && !pan && now - lastAct > 1200;
    const settled = (id: string): boolean => !unplaced.has(id) && !pending.has(id);
    const taken = new Set<string>(); for (const o of others) { if (o.held) taken.add(o.held); if (o.move) taken.add(o.move.id); }
    const busy = new Set<number>(); for (const o of others) { if (o.unit !== null) busy.add(o.unit); }
    const inCluster = (i: number): boolean => INNER[i] >= 0 && staged.has(INNER[i]);
    // A connection inside a cluster is laid while the cluster waits beside the board, once its parts are sorted there;
    // any other needs its parts on the board, and what it starts on laid on the board too.
    const can = (i: number): boolean => inCluster(i)
      ? !busy.has(INNER[i]) && reaches[i].every((id) => !unsorted.has(id) && !pending.has(id) && !taken.has(id))
      : reaches[i].every(settled) && NEEDS[i].every((k) => !inCluster(k));
    const open = [...gone].filter((i) => !others.some((o) => o.route === i) && NEEDS[i].every((k) => !gone.has(k)) && can(i) && !crowded.has(i));
    const inner = open.filter(inCluster), outer = open.filter((i) => !inCluster(i));
    // what is still to be wired inside clusters, by anyone: nothing goes onto the board before that is done
    const wiring = inner.length > 0 || others.some((o) => o.task === "wire" || (o.route !== null && inCluster(o.route)));
    const free = (q: { id: string }): boolean => !taken.has(q.id) && !(drag && drag.id === q.id);
    // Sorting comes first, a group at a time; nothing is placed until the pile is empty, and then the groups go onto the
    // board one after another.
    const first = <T extends { group: number }>(list: T[]): T[] => { const g = Math.min(...list.map((q) => q.group)); return list.filter((q) => q.group === g); };
    const heap = first(meta.parts.filter((q) => unsorted.has(q.id))).filter(free);
    const ready = unsorted.size || others.some((o) => o.task === "sort") || wiring ? [] : [...staged].filter((u) => !busy.has(u) && meta.units[u].parts.every((id) => !taken.has(id) && !(drag && drag.id === id)));
    const pile = ready.filter((u) => meta.units[u].group === Math.min(...ready.map((v) => meta.units[v].group)));
    const kept = new Set(stories.filter((x) => x.kind === "label" && x.state < 2).flatMap((x) => x.texts!));
    const texts = meta.texts.filter((t) => shelf.has(t.id) && !kept.has(t.text)).map((t) => t.id);
    const routed = !gone.size && !unplaced.size;
    // A story can be told once what it is about is on the board: the part placed, half the net's tracks laid, the board all but done.
    const told = (st: Story): boolean => st.kind === "width" ? meta.routes.filter((r) => r.net === st.net).length > 1 && meta.routes.filter((r, i) => r.net === st.net && !gone.has(i)).length >= 3 && meta.routes.every((r, i) => r.net !== st.net || !inCluster(i)) && !!pinOf(st)
      : st.kind === "label" ? routed && poured && !stitches.length && !texts.length : !unplaced.has(refId(st.ref)) && !taken.has(refId(st.ref)) && !busy.has(UNIT.get(refId(st.ref))!);
    const tell = !note ? stories.filter((x) => x.state === 0 && told(x)) : [];
    const fix = stories.filter((x) => x.state === 1 && x.by !== a.who && !others.some((o) => o.story === x));
    const opts: [Task, number][] = [["rest", 0.25]];
    if (quiet && heap.length) opts.push(["sort", 10]);
    if (quiet && pile.length) opts.push(["place", 10]);
    if (quiet && inner.length && !unsorted.size) opts.push(["wire", 12]);
    if (quiet && outer.length) opts.push(["route", 9]);
    if (quiet && routed && !poured && !doing("pour")) opts.push(["pour", 40]);
    if (quiet && poured && stitches.length) opts.push(["stitch", 8]);
    if (quiet && routed && texts.length && !doing("label")) opts.push(["label", 4]);
    if (quiet && tell.length && !doing("note")) opts.push(["note", 14]);
    if (quiet && fix.length) opts.push(["fix", 60]);
    let sum = 0; for (const o of opts) sum += o[1];
    let pick = Math.random() * sum, task: Task = "rest";
    for (const o of opts) { pick -= o[1]; if (pick <= 0) { task = o[0]; break; } }

    const p = plan(a.who, a.at); let ok = false;
    if (!HARD.has(a.last) || chance(0.5)) p.rest(rnd(0.15, 0.8));
    if (task === "sort") ok = planSort(a, p, any1(heap).id);
    else if (task === "place") ok = planUnit(a, p, any1(pile));
    else if (task === "label") ok = planLabel(a, p, any1(texts));
    else if (task === "pour") ok = planPour(a, p);
    else if (task === "stitch") ok = planStitch(a, p);
    else if (task === "wire") ok = planRoute(a, p, inner.reduce((b, i) => (dist(meta.routes[i].pts[0], a.at) * rnd(0.6, 1.4) < dist(meta.routes[b].pts[0], a.at) ? i : b), any1(inner)));
    else if (task === "route") ok = planRoute(a, p, outer.reduce((b, i) => (dist(meta.routes[i].pts[0], a.at) * rnd(0.6, 1.4) < dist(meta.routes[b].pts[0], a.at) ? i : b), any1(outer)));
    else if (task === "note") ok = planNote(a, p, tell[0]);
    else if (task === "fix") ok = planFix(a, p, fix[0]);
    // Nothing to do just now: the hand waits near where the work is, on nothing in particular.
    if (!ok) { task = "rest"; if (chance(0.4)) p.go(inset(3)); p.rest(rnd(0.8, 2.2)); }
    a.task = task; a.steps = p.steps; a.i = 0; a.t0 = now; a.from = a.at;
  }
  /** One of those not in the middle of board work comes over to take back the visitor's change. */
  function sendUndo(now: number): void {
    const free = actors.filter((a) => !HARD.has(a.task)); if (!free.length) return;
    const a = any1(free);
    while (edits.length) {
      const e = edits.pop()!; drop(a, now);
      const p = plan(a.who, a.at);
      if (planUndo(a, p, e)) { a.task = "undo"; a.steps = p.steps; return; }
    }
    drop(a, now); sync();
  }
  /** The visitor took hold of what a teammate was carrying: the teammate lets go, and the
   *  item still has to get home some time. */
  function yieldTo(id: string): void {
    const a = actors.find((o) => o.move && o.move.id === id); if (!a || !a.move) return;
    if (!unplaced.has(id) && !edits.some((e) => e.kind === "move" && e.id === id)) edits.push({ kind: "move", id, from: a.move.from });
    drop(a, performance.now());
  }
  cast(performance.now());

  // "Keep going in a real project": opens the visitor's own Devboard Demo (server/src/demo.rs, the copy of
  // Cyberboard every account starts with) in the editor.  Signed out, sign-in comes first and returns to the
  // same place (Home.tsx reads ?start=demo).
  const keep = document.querySelector<HTMLAnchorElement>("[data-keep]");   // under the window, beside the caption
  if (keep) {
    const next = "/?start=demo";
    keep.href = document.documentElement.dataset.me ? next : "/auth/github/login?next=" + encodeURIComponent(next);
    keep.addEventListener("click", () => { endRoute(); settle(); });
  }

  /** KiCad's two-leg track: straight along the longer axis, then 45 degrees into the target. */
  function legs(a: Pt, b: Pt): Pt[] {
    const dx = b[0] - a[0], dy = b[1] - a[1], ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < 1e-3 || ay < 1e-3 || Math.abs(ax - ay) < 1e-3) return [a, b];
    const d = Math.min(ax, ay);
    const mid: Pt = ax > ay ? [b[0] - Math.sign(dx) * d, a[1]] : [a[0], b[1] - Math.sign(dy) * d];
    return [a, mid, b];
  }
  /** The same two legs the other way round: 45 degrees first, then straight. */
  function legsAlt(a: Pt, b: Pt): Pt[] {
    const p = legs(b, a); return p.length === 3 ? [a, p[1], b] : p;
  }
  /** How far along `pts` a track of `net` can be laid before it would come too close to
   *  another net's copper: the points of the part that may be placed. */
  function clear(pts: Pt[], net: number, on: Layer): { pts: Pt[]; whole: boolean; len: number } {
    const w = netWidth(net), out: Pt[] = [pts[0]]; let len = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], d = dist(a, b);
      if (!clash(doc, a, b, w, [on], net, CLEARANCE)) { out.push(b); len += d; continue; }
      let ok = 0;
      for (let s = 0.05; s < d; s += 0.05) { const p: Pt = [lerp(a[0], b[0], s / d), lerp(a[1], b[1], s / d)]; if (clash(doc, a, p, w, [on], net, CLEARANCE)) break; ok = s; }
      if (ok > 0) { out.push([lerp(a[0], b[0], ok / d), lerp(a[1], b[1], ok / d)]); len += ok; }
      return { pts: out, whole: false, len };
    }
    return { pts: out, whole: true, len };
  }
  /** The track from the last placed point towards `to`, as far as the net rule lets it go.
   *  A track belongs to the net it started on and never touches another one's copper. */
  function reach(from: Pt, to: Pt, net: number, on: Layer): { pts: Pt[]; whole: boolean } {
    const a = clear(legs(from, to), net, on); if (a.whole) return a;
    const b = clear(legsAlt(from, to), net, on);
    return b.whole || b.len > a.len + 1e-6 ? b : a;
  }
  const viaFits = (at: Pt, net: number): boolean => !clash(doc, at, at, VIA.size, null, net, CLEARANCE);
  /** Where a click lands while a tool is active: copper of the right net if there is some, else the grid. */
  function target(at: Pt, net: number | null): { at: Pt; net: number; onCopper: boolean } {
    const c = copperAt(doc, at[0], at[1], layer);
    if (c && (net === null || net === 0 || c.net === net)) return { at: [c.x, c.y], net: c.net, onCopper: true };
    return { at: [snap(at[0], BOARD.x), snap(at[1], BOARD.y)], net: net || 0, onCopper: false };
  }

  function setTool(t: Tool): void {
    if (route && t !== "route") endRoute();
    tool = t; if (t !== "select") selected = null;
    sync(); stage.invalidate();
  }
  function setLayer(l: Layer): void {
    if (l === layer) return;
    // Changing layer mid-track drops a via, as the router does.
    if (route && hover) {
      const made = route.made, t = target(hover, route.net), r = reach(route.from, t.at, route.net, route.layer), end = r.pts[r.pts.length - 1];
      if (!viaFits(end, route.net)) return;                // no room for the via here: stay on this layer
      for (let i = 1; i < r.pts.length; i++) made.push(addSegment(r.pts[i - 1], r.pts[i], route.net, route.layer));
      made.push(addVia(end, route.net)); route = { net: route.net, from: end, layer: l, made };
    }
    layer = l; dirty = true; sync(); stage.invalidate();
  }
  function endRoute(): void { if (route) { remember(route.made); route = null; change(); } }
  function reset(): void {
    doc = loadPcbOpen(); open(); edits.length = 0; cast(performance.now()); clearTimeout(stillTimer); route = null; drag = null; selected = null; box = fitTo.slice() as Box; tool = "select"; layer = "F.Cu";
    dirty = true; touched = false; nextUndo = performance.now() + 1800; sync(); stage.invalidate();
  }
  function zoom(k: number, about?: Pt): void {
    const cx = about ? about[0] : (box[0] + box[2]) / 2, cy = about ? about[1] : (box[1] + box[3]) / 2;
    const w = clamp((box[2] - box[0]) * k, (HOME[2] - HOME[0]) / 6, (HOME[2] - HOME[0]) * 1.5), r = w / (box[2] - box[0]);
    box = [cx - (cx - box[0]) * r, cy - (cy - box[1]) * r, cx + (box[2] - cx) * r, cy + (box[3] - cy) * r];
    own = true; glide = null; dirty = true; stage.invalidate();
  }
  function removeSelected(): void {
    if (!selected) return;
    const it = doc.items.get(selected); if (!it || (it.kind !== "segment" && it.kind !== "via")) return;
    doc.items.delete(it.id);
    // Taking out a piece the visitor laid themselves is not a change of its own: it just shortens that one.
    const own = edits.find((e) => e.kind === "add" && e.ids.includes(it.id));
    if (own && own.kind === "add") { own.ids.splice(own.ids.indexOf(it.id), 1); if (!own.ids.length) edits.splice(edits.indexOf(own), 1); }
    else edits.push({ kind: "del", item: it });
    selected = null; change();
  }

  /** Status bar, toolbar states. */
  function sync(): void {
    root.dataset.tool = tool; root.dataset.layer = layer;
    root.querySelectorAll<HTMLElement>("[data-tool-btn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.toolBtn === tool)));
    root.querySelectorAll<HTMLElement>("[data-layer-btn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.layerBtn === layer)));
    const u = q<HTMLButtonElement>("[data-act=undo]"); if (u) u.disabled = !edits.length && !route;
    const r = q<HTMLButtonElement>("[data-act=reset]"); if (r) r.disabled = !touched;
    if (toolName) toolName.textContent = tool === "route" ? (route ? (foreign(hover) !== null ? `Route Tracks: ${netName(route.net)} cannot connect to ${netName(foreign(hover)!)}` : `Route Tracks: ${netName(route.net)}, click to place, double-click to finish`) : "Route Tracks: click a pad or a track to start") : tool === "via" ? "Add Via" : "Select item(s)";
    if (dirty) rats = ratsnest(doc, { planes: poured ? PLANES : [] });
    if (counts) {
      let vias = 0, segs = 0; for (const it of doc.items.values()) { if (it.kind === "via") vias++; else if (it.kind === "segment") segs++; }
      counts.textContent = `Pads ${meta.pads}   Vias ${vias}   Track Segments ${segs}   Nets ${meta.nets}`;
      if (unrouted) { unrouted.textContent = `Unrouted ${rats.length}`; unrouted.classList.toggle("ok", rats.length === 0); }
    }
  }

  const stage: Stage = makeStage(canvas, (s, now) => {
    if (!t0) { t0 = now; nextUndo = now + 1800; }
    const { ctx, w: W, h: H, dpr } = s;
    // Once the pile is empty the view closes in on the board, unless the visitor has set their own.
    if (!unplaced.size && fitTo !== HOME) { fitTo = HOME; if (!own) glide = { from: box.slice() as Box, t0: now }; }
    if (glide) { const k = minJerk((now - glide.t0) / 1400); box = mixBox(glide.from, HOME, k); dirty = true; if (k >= 1) glide = null; }
    view = fit(W, H, dpr, box);
    if (!base) base = document.createElement("canvas");
    if (base.width !== canvas.width || base.height !== canvas.height) { base.width = canvas.width; base.height = canvas.height; dirty = true; }
    clock = now;
    for (const [id, t] of motion) if (now - t > 250) motion.delete(id);   // put down: it goes back into the kept board
    const key = [...motion.keys()].sort().join();
    if (key !== motionKey) { motionKey = key; dirty = true; }
    const moving = motion.size ? new Set(motion.keys()) : null;
    if (dirty || moving) rats = ratsnest(doc, { planes: poured ? PLANES : [] });
    if (dirty) {
      K.render(doc, base.getContext("2d")!, view, { hidden: HID, grid: 1, ratsnest: moving ? [] : rats, selected: selected ? new Set([selected]) : null, zoneFill: true, activeLayer: layer, skip: moving || undefined });
      dirty = false;
      if (zoomOut) zoomOut.textContent = `Z ${(view.ppm / 3.78).toFixed(2)}`;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(base, 0, 0);
    if (moving) K.render(doc, ctx, view, { hidden: HID, ids: moving, ratsnest: rats, overlay: true, background: null, frame: false, zoneFill: true, activeLayer: layer });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const px = (p: Pt): Pt => toPx(view!, p[0], p[1]);

    // The track being routed and the via that a layer change would drop.
    if (route && hover) {
      const t = target(hover, route.net), pts = reach(route.from, t.at, route.net, route.layer).pts.map(px);
      ctx.strokeStyle = LAYER_COLOR[route.layer]; ctx.globalAlpha = 0.85; ctx.lineWidth = Math.max(1.5, netWidth(route.net) * view.ppm); ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (tool === "via" && hover) {
      const t = target(hover, null), c = px(t.at);
      ctx.globalAlpha = viaFits(t.at, t.net) ? 0.8 : 0.22; ctx.fillStyle = "#ECECEC"; ctx.beginPath(); ctx.arc(c[0], c[1], VIA.size / 2 * view.ppm, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#001023"; ctx.beginPath(); ctx.arc(c[0], c[1], VIA.drill / 2 * view.ppm, 0, 6.3); ctx.fill(); ctx.globalAlpha = 1;
    }
    if (tool !== "select" && hover) {
      // The snapped point, as the editor's crosshair shows it.
      const t = target(hover, route ? route.net : null), c = px(t.at);
      ctx.strokeStyle = "#FFFFFFB0"; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(Math.round(c[0]) + 0.5, c[1] - 9); ctx.lineTo(Math.round(c[0]) + 0.5, c[1] + 9); ctx.moveTo(c[0] - 9, Math.round(c[1]) + 0.5); ctx.lineTo(c[0] + 9, Math.round(c[1]) + 0.5); ctx.stroke();
      if (t.onCopper) { ctx.beginPath(); ctx.arc(c[0], c[1], 6, 0, 6.3); ctx.stroke(); }
    }

    // The scripted collaborators: a pointer each, and what each of them holds, pulls or selects.
    if (!still) {
      if (edits.length && !drag && !route && !pan && now - lastAct > IDLE && now > nextUndo && !actors.some((a) => a.task === "undo")) sendUndo(now);
      for (const a of actors) run(a, now);
    }
    const frame = (id: string, color: string): void => {
      const it = doc.items.get(id), g = it && (it.geom as any[])[0]; if (!it) return;
      ctx.strokeStyle = color; ctx.lineCap = "round";
      if ((it.kind === "segment" || it.kind === "via") && g) {
        const s = it.kind === "via" ? px([g.x, g.y]) : px([g.x1, g.y1]), t = it.kind === "via" ? s : px([g.x2, g.y2]);
        ctx.globalAlpha = 0.75; ctx.lineWidth = (it.kind === "via" ? g.r * 2 : g.w) * view!.ppm + 4; ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(t[0], t[1] + 0.01); ctx.stroke(); ctx.globalAlpha = 1;
      } else if (it.bbox) { const p0 = px([it.bbox[0], it.bbox[1]]), p1 = px([it.bbox[2], it.bbox[3]]); ctx.lineWidth = 1.5; ctx.strokeRect(p0[0] - 3, p0[1] - 3, p1[0] - p0[0] + 6, p1[1] - p0[1] + 6); }
    };
    for (const a of actors) {
      const color = PEERS[a.who].color;
      for (const id of a.marks) frame(id, color);
      if (a.held) frame(a.held, color);
      if (a.poly) {
        // The zone outline drawn so far.
        ctx.strokeStyle = LAYER_COLOR["B.Cu"]; ctx.globalAlpha = 0.85; ctx.lineWidth = Math.max(1.5, 0.2 * view.ppm); ctx.lineJoin = "round";
        ctx.beginPath(); a.poly.forEach((q, i) => { const c = px(q); if (i) ctx.lineTo(c[0], c[1]); else ctx.moveTo(c[0], c[1]); }); ctx.stroke(); ctx.globalAlpha = 1;
      }
      if (a.pull) {
        const s = px(a.pull.a), t = px(a.pull.at);
        ctx.strokeStyle = LAYER_COLOR[a.pull.layer] || LAYER_COLOR["F.Cu"]; ctx.globalAlpha = 0.85; ctx.lineWidth = Math.max(1.5, a.pull.w * view.ppm); ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(t[0], t[1]); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    // The board is done: it is left to be looked at for a while, then they start over (not while the visitor is at work on it).
    if (!still && !alone && !touched && !unplaced.size && !gone.size && poured && !stitches.length && ![...TEXTS].some((id) => shelf.has(id)) && stories.every((x) => x.state === 2)) {
      if (!doneAt) doneAt = now; else if (now - doneAt > AGAIN && !drag && !pan && !route) { reset(); own = false; root.dispatchEvent(new CustomEvent("hero:again")); }
    } else doneAt = 0;
    if (note && now >= note.dies) note = null;
    if (note) {
      // A comment pinned to a part, typed as its author writes it; once the change is made it
      // reads what was done, with a tick, in the name of who did it.
      const peer = PEERS[note.who], c = px(note.at), typing = note.n < note.text.length;
      const text = note.text.slice(0, note.n) + (typing && Math.floor(now / 400) % 2 ? "|" : "");
      ctx.save(); ctx.globalAlpha = clamp(Math.min((now - note.born) / 160, (note.dies - now) / 350));
      ctx.font = `12px ${SANS}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
      const w = Math.max(30, ctx.measureText(note.text.slice(0, note.n) + "|").width) + (note.ok ? 62 : 42), hgt = 28;
      const x = Math.round(clamp(c[0] + 12, 6, W - 6 - w)), y = Math.round(c[1] - hgt - 10 < 6 ? c[1] + 12 : c[1] - hgt - 10);
      ctx.beginPath(); ctx.arc(c[0], c[1], 5, 0, 6.3); ctx.fillStyle = peer.color; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.4; ctx.stroke(); ctx.fill();
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x + 0.5, y + 0.5, w, hgt, 8); else ctx.rect(x + 0.5, y + 0.5, w, hgt);
      ctx.fillStyle = "#111113"; ctx.fill(); ctx.strokeStyle = note.ok ? "#3FB37F" : "#FFFFFF3D"; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); ctx.arc(x + 15, y + hgt / 2 + 0.5, 8, 0, 6.3); ctx.fillStyle = peer.color; ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = `600 10px ${SANS}`; ctx.textAlign = "center"; ctx.fillText(peer.name[0], x + 15, y + hgt / 2 + 1);
      let tx = x + 30;
      if (note.ok) {
        const cy = y + hgt / 2 + 0.5; ctx.strokeStyle = "#3FB37F"; ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.beginPath(); ctx.moveTo(tx + 1, cy); ctx.lineTo(tx + 5, cy + 4); ctx.lineTo(tx + 12, cy - 4); ctx.stroke(); tx += 20;
      }
      ctx.fillStyle = "#FAFAFA"; ctx.font = `12px ${SANS}`; ctx.textAlign = "left"; ctx.fillText(text, tx, y + hgt / 2 + 1);
      ctx.restore();
    }
    // The groups: a frame and a name for each cluster while it holds parts that are not on the board yet.
    if (unplaced.size) {
      ctx.save(); ctx.font = `11px ${SANS}`; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      meta.groups.forEach((g, gi) => {
        if (!meta.parts.some((q) => q.group === gi && unplaced.has(q.id) && !unsorted.has(q.id))) return;
        const p0 = px([g.box[0], g.box[1]]), p1 = px([g.box[2], g.box[3]]);
        ctx.strokeStyle = "#7C8AA5"; ctx.strokeRect(Math.round(p0[0]) + 0.5, Math.round(p0[1]) + 0.5, Math.round(p1[0] - p0[0]), Math.round(p1[1] - p0[1]));
        ctx.fillStyle = "#AEB9CF"; ctx.fillText(g.name, p0[0] + 6, p0[1] + 5);
      });
      ctx.restore();
    }
    // Where KiCad would draw each of them: the cursor snaps to the 0.25 mm grid, so it moves in small steps.
    for (const a of actors) { const c = px([snap(a.at[0], BOARD.x), snap(a.at[1], BOARD.y)]); drawCursor(ctx, c[0], c[1], PEERS[a.who].name, PEERS[a.who].color, SANS); }
    return !still;
  });

  // ------------------------------------------------------------------ input

  function where(e: { clientX: number; clientY: number }): Pt | null {
    if (!view) return null;
    const r = canvas.getBoundingClientRect();
    return toMm(view, e.clientX - r.left, e.clientY - r.top);
  }
  const touches = new Set<number>();
  const untouch = (e: PointerEvent) => { touches.delete(e.pointerId); };
  canvas.addEventListener("pointerup", untouch);
  canvas.addEventListener("pointercancel", untouch);
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") { touches.add(e.pointerId); if (touches.size > 1) return; }   // a second finger: a pinch, see below
    const at = where(e); if (!at || e.button !== 0) return;
    canvas.focus({ preventScroll: true }); hover = at; lastAct = performance.now();
    if (tool === "select") {
      const hit = pick(at);
      if (movable(hit)) {
        const it = doc.items.get(hit!)!; selected = hit; yieldTo(hit!);
        drag = { id: hit!, from: posOf(it), grab: at, moved: false };
        canvas.setPointerCapture(e.pointerId);
      } else {
        selected = trackAt(doc, at[0], at[1], 0.25);
        if (!selected) { pan = { at: [e.clientX, e.clientY], box: box.slice() as Box }; own = true; glide = null; canvas.setPointerCapture(e.pointerId); }
      }
      dirty = true; stage.invalidate();
    } else if (tool === "via") {
      const t = target(at, null);
      if (viaFits(t.at, t.net)) { remember([addVia(t.at, t.net)]); change(); }
    } else if (!route) {
      // A track takes its net from the copper it starts on, so it has to start on some.
      const t = target(at, null);
      if (t.onCopper) { route = { net: t.net, from: t.at, layer, made: [] }; sync(); stage.invalidate(); }
    } else {
      if (foreign(at) !== null) return;                     // another net's copper: the track may not land on it
      const t = target(at, route.net);
      if (dist(route.from, t.at) < 1e-6) { endRoute(); return; }
      const r = reach(route.from, t.at, route.net, route.layer);
      for (let i = 1; i < r.pts.length; i++) route.made.push(addSegment(r.pts[i - 1], r.pts[i], route.net, route.layer));
      route.from = r.pts[r.pts.length - 1];
      if (t.onCopper && r.whole) endRoute(); else change();
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pinch) return;
    const at = where(e); if (!at) return;
    hover = at;
    if (xy) xy.textContent = `X ${(at[0] - BOARD.x).toFixed(2)}  Y ${(at[1] - BOARD.y).toFixed(2)}`;
    if (drag) {
      const dx = Math.round((at[0] - drag.grab[0]) / GRID) * GRID, dy = Math.round((at[1] - drag.grab[1]) / GRID) * GRID;
      const it = doc.items.get(drag.id)!, x = drag.from[0] + dx, y = drag.from[1] + dy;
      const p = posOf(it); lastAct = performance.now();
      if (p[0] !== x || p[1] !== y) { K.moveItem(doc, it, x, y, 1e6); drag.moved = true; dirty = true; }
    } else if (pan && view) {
      const dx = (e.clientX - pan.at[0]) / view.ppm, dy = (e.clientY - pan.at[1]) / view.ppm;
      box = [pan.box[0] - dx, pan.box[1] - dy, pan.box[2] - dx, pan.box[3] - dy]; dirty = true;
    } else if (route) {
      const f = foreign(at); if (f !== blocked) { blocked = f; sync(); }
    } else if (tool === "select") {
      canvas.style.cursor = movable(pick(at)) ? "move" : "";
    }
    stage.invalidate();
  });
  const release = () => {
    if (drag && drag.moved) {
      // One entry per item, holding where it first was, so it goes all the way home in one carry.
      // A part still waiting in the pile has no place to go back to: a teammate places it from wherever it was left.
      const d = drag; if (!unplaced.has(d.id) && !edits.some((e) => e.kind === "move" && e.id === d.id)) edits.push({ kind: "move", id: d.id, from: d.from });
      change();
    }
    drag = null; pan = null;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => { if (!drag && !pan) { hover = null; if (xy) xy.textContent = "X --.--  Y --.--"; stage.invalidate(); } });
  canvas.addEventListener("dblclick", () => { if (route) endRoute(); });
  // Two fingers zoom and pan the board, as in the editor on a phone or tablet; one finger still scrolls the page.
  let pinch: { d: number; mid: [number, number] } | null = null;
  const fingers = (t: TouchList) => {
    const a = t[0], b = t[1];
    return { d: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)), mid: [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2] as [number, number] };
  };
  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length < 2) return;
    e.preventDefault();
    // Whatever the first finger started is let go: a part it picked up goes back where it was.
    if (drag) { const it = doc.items.get(drag.id); if (it && drag.moved) { K.moveItem(doc, it, drag.from[0], drag.from[1], 1e6); dirty = true; } drag = null; }
    pan = null; pinch = fingers(e.touches); own = true; glide = null; lastAct = performance.now();
  }, { passive: false });
  canvas.addEventListener("touchmove", (e) => {
    if (!pinch || e.touches.length < 2 || !view) return;
    e.preventDefault();
    const f = fingers(e.touches), at = where({ clientX: f.mid[0], clientY: f.mid[1] });
    const dx = (f.mid[0] - pinch.mid[0]) / view.ppm, dy = (f.mid[1] - pinch.mid[1]) / view.ppm;
    box = [box[0] - dx, box[1] - dy, box[2] - dx, box[3] - dy];
    zoom(pinch.d / f.d, at ? [at[0] - dx, at[1] - dy] : undefined);
    pinch = f; lastAct = performance.now();
  }, { passive: false });
  const unpinch = (e: TouchEvent) => { if (e.touches.length < 2) pinch = null; };
  canvas.addEventListener("touchend", unpinch);
  canvas.addEventListener("touchcancel", unpinch);
  canvas.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;               // a plain wheel scrolls the page
    e.preventDefault(); const at = where(e); zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, at || undefined);
  }, { passive: false });
  canvas.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase(); lastAct = performance.now();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); act("undo"); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === "escape") { if (route) endRoute(); else if (tool !== "select") setTool("select"); else { selected = null; dirty = true; stage.invalidate(); } }
    else if (k === "x") setTool("route");
    else if (k === "v") { if (route) setLayer(layer === "F.Cu" ? "B.Cu" : "F.Cu"); else setTool("via"); }
    else if (k === "pageup") { e.preventDefault(); setLayer("F.Cu"); }
    else if (k === "pagedown") { e.preventDefault(); setLayer("B.Cu"); }
    else if (k === "delete" || k === "backspace") { e.preventDefault(); removeSelected(); }
    else if (k === "+" || k === "=") zoom(1 / 1.25);
    else if (k === "-") zoom(1.25);
    else if (k === "home") { e.preventDefault(); box = fitTo.slice() as Box; own = false; glide = null; dirty = true; stage.invalidate(); }
  });

  function act(name: string): void {
    if (name === "undo") {
      if (route) { for (const id of route.made) doc.items.delete(id); route = null; change(); }
      else { const u = edits.pop(); if (u) { revert(u); selected = null; change(); } }
    } else if (name === "zoom-in") zoom(1 / 1.25);
    else if (name === "zoom-out") zoom(1.25);
    else if (name === "zoom-fit") { box = fitTo.slice() as Box; own = false; glide = null; dirty = true; stage.invalidate(); }
    else if (name === "reset") reset();
  }
  root.querySelectorAll<HTMLElement>("[data-tool-btn]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.toolBtn as Tool)));
  root.querySelectorAll<HTMLElement>("[data-layer-btn]").forEach((b) => b.addEventListener("click", () => setLayer(b.dataset.layerBtn as Layer)));
  root.querySelectorAll<HTMLElement>("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act!)));
  // the page spells hotkeys as KiCad's tables do ("Undo (Ctrl+Z)"): a Mac reads them with its own names ("Cmd+Z")
  root.querySelectorAll<HTMLElement>("[title]").forEach((b) => { b.title = keysInText(b.title); });
  sync();
}
