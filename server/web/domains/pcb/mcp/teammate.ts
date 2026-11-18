// mcp/teammate — what makes the assistant a visible member of the document rather than a hand that
// edits it from nowhere: pointing at things for everyone in it (a mark in its peer colour, like a
// person's selection), knowing who else is there and what they have selected, and working out what
// "this net" or "these parts" are as items, boxes and lines, for the mark and for a picture alike.
//
// The mark travels as ordinary presence (cursor, selection, ghost lines, viewport), so every client
// that draws a person's presence draws the assistant's, the released desktop editors included.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as design from "../ai/design";
import { ToolError } from "../ai/design";
import type { DocSession } from "./session";

const W = globalThis as any;
const K = (): any => W.KiCadCanvas;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** What a tool call pointed at, resolved against the document (millimetres). */
export interface Target {
  /** whole items: parts, tracks, vias, wires, labels */ ids: string[];
  /** lines along a net: [x1, y1, x2, y2, width] */ segs: number[][];
  /** small outlines that are not items of their own: a net's pads and pins, a region */ boxes: number[][];
  /** everything pointed at, [x0, y0, x1, y1] */ box: number[] | null;
  /** what it is, in words, for the answer */ what: string[];
  missing: string[];
}

const sameNet = (q: string) => { const want = q.trim().toLowerCase().replace(/^\//, ""); return (n: string) => String(n || "").toLowerCase().replace(/^\//, "") === want; };

function grow(t: Target, b: number[] | null | undefined): void {
  if (!b || !b.every((v) => isFinite(v))) return;
  t.box = t.box ? [Math.min(t.box[0], b[0]), Math.min(t.box[1], b[1]), Math.max(t.box[2], b[2]), Math.max(t.box[3], b[3])] : b.slice(0, 4);
}

/** A net of the board with everything on it. */
function boardNet(doc: any, name: string): any | null {
  const P = W.PcbTools; if (!P) throw new ToolError("The board tools are not loaded.");
  const same = sameNet(name);
  for (const n of P.netlist(doc).nets.values()) if (same(n.name)) return n;
  return null;
}

/** Parts, nets, items and regions as the items, lines and boxes that show them. */
export function resolveTargets(doc: any, a: { refs?: unknown; nets?: unknown; ids?: unknown; area?: unknown; at?: unknown }): Target {
  const t: Target = { ids: [], segs: [], boxes: [], box: null, what: [], missing: [] };
  const seen = new Set<string>(); const add = (it: any) => { if (it && !seen.has(it.id)) { seen.add(it.id); t.ids.push(it.id); grow(t, it.bbox); } };
  const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).map((x) => String(x)).filter((x) => x.trim());

  for (const r of list(a.refs)) {
    const hits = design.findByRef(doc, r); if (!hits.length) { t.missing.push(r); continue; }
    for (const it of hits) add(it); t.what.push(hits[0].ref || r);
  }
  for (const id of list(a.ids)) { const it = doc.items.get(id); if (!it) { t.missing.push(id); continue; } add(it); t.what.push(it.ref || it.kind); }

  for (const name of list(a.nets)) {
    if (doc.type === "sch") {
      const same = sameNet(name); const net = design.schNets(doc).find((n) => same(n.name) || same(n.board) || n.labels.some(same));
      if (!net) { t.missing.push(name); continue; }
      const k = K(), S = W.CollabTools && W.CollabTools.sch; const pinsOf = new Map<string, Set<string>>();
      for (const p of net.pins) { let s = pinsOf.get(p.ref); if (!s) pinsOf.set(p.ref, s = new Set()); s.add(p.number); }
      for (const id of net.ids) {
        const it = doc.items.get(id); if (!it) continue;
        if (it.kind === "wire" || it.kind === "bus") { const pts = k.ptsOf(it.node); for (let i = 1; i < pts.length; i++) t.segs.push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], 0.3]); add(it); }
        else if (/label$/.test(it.kind) || it.kind === "junction") add(it);
      }
      // the pins on the net: a small box on each pin's end, the symbol itself is not "the net"
      if (S && S._ && S._.symbolPins) for (const it of doc.items.values() as Iterable<any>) {
        if (it.kind !== "symbol") continue;
        const power = it.lib && /^power:/.test(it.lib) && same(it.value || "");
        const nums = pinsOf.get(it.ref || ""); if (!nums && !power) continue;
        for (const p of S._.symbolPins(doc, it)) if (power || (nums && nums.has(p.number))) { const b = [p.x - 0.9, p.y - 0.9, p.x + 0.9, p.y + 0.9]; t.boxes.push(b); grow(t, b); }
      }
      t.what.push(`net ${net.name}`);
    } else {
      const net = boardNet(doc, name); if (!net) { t.missing.push(name); continue; }
      for (const c of net.tracks) { add(c.item); const sh = c.shape; if (sh.t === "seg") t.segs.push([sh.a[0], sh.a[1], sh.b[0], sh.b[1], c.width]); else if (sh.pts) for (let i = 1; i < sh.pts.length; i++) t.segs.push([sh.pts[i - 1][0], sh.pts[i - 1][1], sh.pts[i][0], sh.pts[i][1], c.width]); }
      for (const c of net.vias) add(c.item);
      for (const c of net.pads) { const b = c.bbox; if (b) { t.boxes.push([b[0], b[1], b[2], b[3]]); grow(t, b); } }
      t.what.push(`net ${net.name}`);
    }
  }

  if (Array.isArray(a.area) && a.area.length === 4 && a.area.every((v: unknown) => typeof v === "number" && isFinite(v as number))) {
    const v = a.area as number[]; const b = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
    t.boxes.push(b); grow(t, b); t.what.push(`area ${b.map(r3).join(", ")}`);
  }
  if (Array.isArray(a.at) && a.at.length === 2 && a.at.every((v: unknown) => typeof v === "number" && isFinite(v as number))) {
    const [x, y] = a.at as number[]; const r = doc.type === "sch" ? 2.54 : 1; const b = [x - r, y - r, x + r, y + r];
    t.boxes.push(b); grow(t, b); t.what.push(`point ${r3(x)}, ${r3(y)}`);
  }
  return t;
}

// ---------------------------------------------------------------- the mark

const MARK_DEFAULT_S = 45, MARK_MAX_S = 300, MARK_ITEMS = 60, MARK_BYTES = 7000, NOTE_MAX = 140;

/** The people in the document besides this peer, by name (one entry per person and client kind). */
function watchers(sess: DocSession): string[] {
  const out = new Set<string>();
  for (const p of sess.peers.values()) { const u = p.user || {}; if (u.client === "mcp") continue; out.add(`${u.name || u.login || "someone"} (${u.client === "web" ? "browser" : "desktop"})`); }
  return Array.from(out);
}

/** The people already in a document are announced just after joining it; give that a moment on a fresh join. */
export async function settle(sess: DocSession): Promise<void> {
  const left = 450 - (Date.now() - sess.joinedAt);
  if (left > 0) await new Promise<void>((r) => setTimeout(r, left));
}

/**
 * highlight: mark parts, nets, items or a region for everyone in the document, the way a person's selection shows
 * to their collaborators, with a short note beside the assistant's name tag.  Cleared after `seconds`.
 */
export async function highlight(sess: DocSession, doc: any, a: any): Promise<unknown> {
  await settle(sess);
  if (a.clear === true) { const had = sess.unmark(); return { document: sess.entry.path, cleared: had, note: had ? undefined : "Nothing was highlighted." }; }
  const t = resolveTargets(doc, a);
  if (!t.box) throw new ToolError(t.missing.length ? `Not on ${sess.entry.path}: ${t.missing.join(", ")}.` : "Say what to highlight: refs, nets, ids, area [x0, y0, x1, y1] or at [x, y].");
  const IU = sess.IU, iu = (v: number) => Math.round(v * IU);
  const seconds = Math.max(5, Math.min(MARK_MAX_S, Number(a.seconds) || MARK_DEFAULT_S));
  const note = typeof a.note === "string" ? a.note.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) : "";

  const state: any = { ai: { note: note || undefined, what: t.what.slice(0, 6).join(", ").slice(0, 120), until: Date.now() + seconds * 1000 } };
  // the name tag hangs below and right of the cursor: at the bottom right corner it stays clear of what is marked
  state.cursor = [iu(t.box[2]), iu(t.box[3])];
  // where somebody following the assistant is taken: the marked things with room around them
  const bw = t.box[2] - t.box[0], bh = t.box[3] - t.box[1]; const least = doc.type === "sch" ? 70 : 16;
  let vw = Math.max(bw * 1.8, least), vh = Math.max(bh * 1.8, least * 0.6); if (vw < vh * 1.6) vw = vh * 1.6; else vh = vw / 1.6;
  state.viewport = [iu((t.box[0] + t.box[2]) / 2 - vw / 2), iu((t.box[1] + t.box[3]) / 2 - vh / 2), iu(vw), iu(vh)];
  // whole items go as a selection, exactly as a browser sends its own (ids alone on a board at rest, boxes on a sheet)
  const sel = t.ids.length ? K().presenceSelection(doc, t.ids.slice(0, MARK_ITEMS), IU, false, MARK_ITEMS) : null;
  state.selection = sel ? sel.selection : []; if (sel && sel.boxes) state.boxes = sel.boxes;
  // regions and a net's pads are outlines, a net's copper is its own centre lines: both travel as the lines every
  // client already draws for a peer's wire in flight.  The server takes 8 KB of presence; outlines go first.
  const ghost: number[][] = []; let bytes = JSON.stringify(state).length; let cut = false;
  const push = (s: number[]) => { const row = [iu(s[0]), iu(s[1]), iu(s[2]), iu(s[3]), iu(s[4] || 0)]; const n = JSON.stringify(row).length + 1; if (bytes + n > MARK_BYTES) { cut = true; return; } bytes += n; ghost.push(row); };
  for (const b of t.boxes) { push([b[0], b[1], b[2], b[1], 0]); push([b[2], b[1], b[2], b[3], 0]); push([b[2], b[3], b[0], b[3], 0]); push([b[0], b[3], b[0], b[1], 0]); }
  const len = (s: number[]) => Math.hypot(s[2] - s[0], s[3] - s[1]);
  for (const s of t.segs.slice().sort((p, q) => len(q) - len(p))) push(s);
  state.ghost = ghost;
  sess.mark(state, seconds * 1000);
  const people = watchers(sess);
  return { document: sess.entry.path, highlighted: t.what, not_on_this_document: t.missing.length ? t.missing : undefined, note: note || undefined, clears_in_s: seconds,
    seen_by: people.length ? people : "Nobody else has this document open right now; they will see the mark if they open it before it clears.",
    partly: cut || t.ids.length > MARK_ITEMS ? "The net or selection is large, so its longest tracks and first items are marked rather than every piece." : undefined };
}

// ---------------------------------------------------------------- the people

/** One person in the document: who, with what, what they have selected and what they are looking at. */
function person(doc: any, sess: DocSession, p: { user: any; state: any }): any {
  const u = p.user || {}, st = p.state || {}; const IU = sess.IU; const mm = (v: number) => r3(v / IU);
  const out: any = { name: u.name || u.login || "someone", login: u.login || undefined, with: u.client === "web" ? "browser" : u.client === "mcp" ? "assistant" : "desktop" };
  if (typeof st.sheetFile === "string" && st.sheetFile && st.sheetFile !== sess.entry.path) { out.on = st.sheetFile; return out; }
  if (Array.isArray(st.cursor) && st.cursor.length >= 2) out.cursor = [mm(st.cursor[0]), mm(st.cursor[1])];
  if (Array.isArray(st.viewport) && st.viewport.length >= 4) out.looking_at = [mm(st.viewport[0]), mm(st.viewport[1]), mm(st.viewport[0] + st.viewport[2]), mm(st.viewport[1] + st.viewport[3])];
  const ids: string[] = Array.isArray(st.selection) ? st.selection : [];
  if (ids.length) {
    const rows: any[] = []; let gone = 0; let box: number[] | null = null;
    for (const id of ids) {
      const it = doc.items.get(id); if (!it) { gone++; continue; }
      const b = it.bbox; if (b) box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b.slice(0, 4);
      if (rows.length >= 30) continue;
      if (it.kind === "symbol" || it.kind === "footprint") rows.push({ ref: it.ref || "?", value: it.value || undefined });
      else {
        const row: any = { kind: it.kind, id: it.id };
        if (doc.type === "pcb") { const n = K().netNameOf(doc, it.node); if (n) row.net = n; }
        else if (/label$/.test(it.kind)) row.text = K().str(it.node[1]);
        rows.push(row);
      }
    }
    out.selected = rows; out.selected_count = ids.length - gone; if (box) out.selection_box = box.map(r3);
  }
  if (st.ai && st.ai.what) out.pointing_at = st.ai.what;
  return out;
}

/** get_selection: who is in the document, what each has selected and where each is looking. */
export async function people(sess: DocSession, doc: any): Promise<any> {
  await settle(sess);
  const rows = Array.from(sess.peers.values()).map((p) => person(doc, sess, p));
  return { document: sess.entry.path, people: rows,
    note: rows.length ? "Coordinates are millimetres. render_view with view_of shows what a person is looking at; refs and ids here are what the other tools take." : "Nobody else has this document open right now." };
}

/** The peer a name refers to: by display name or login, loosely; the only person there when the name is "anyone". */
export function findPerson(sess: DocSession, name: string): { user: any; state: any } | null {
  const q = name.trim().toLowerCase(); const here = Array.from(sess.peers.values()).filter((p) => p.user && p.user.client !== "mcp" && p.state && (!p.state.sheetFile || p.state.sheetFile === sess.entry.path));
  if (!here.length) return null;
  // one person can be here twice (browser and desktop): the client where they have something selected is the one they mean
  const rank = (p: { state: any }) => (Array.isArray(p.state.selection) && p.state.selection.length ? 2 : 0) + (Array.isArray(p.state.viewport) ? 1 : 0);
  const by = (f: (u: any) => boolean) => here.filter((p) => f(p.user)).sort((p, q) => rank(q) - rank(p))[0];
  return by((u) => String(u.login || "").toLowerCase() === q) || by((u) => String(u.name || "").toLowerCase() === q) || by((u) => String(u.name || "").toLowerCase().includes(q) || String(u.login || "").toLowerCase().includes(q))
    || (/^(anyone|them|person|user|me|owner|human)$/.test(q) ? by(() => true) : null) || null;
}

// ---------------------------------------------------------------- trace_net

/** trace_net: one net end to end. */
export function traceNet(doc: any, path: string, name: string): unknown {
  if (typeof name !== "string" || !name.trim()) throw new ToolError("Say which net: its name as list_nets gives it.");
  if (doc.type === "sch") {
    const same = sameNet(name); const net = design.schNets(doc).find((n) => same(n.name) || same(n.board) || n.labels.some(same));
    if (!net) throw new ToolError(`There is no net ${name} on ${path}. list_nets gives the names.`);
    const k = K(); let wire = 0, wires = 0; const labels: any[] = [];
    for (const id of net.ids) {
      const it = doc.items.get(id); if (!it) continue;
      if (it.kind === "wire" || it.kind === "bus") { const pts = k.ptsOf(it.node); for (let i = 1; i < pts.length; i++) wire += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); wires++; }
      else if (/label$/.test(it.kind)) { const [x, y] = k.atOf(it.node); labels.push({ text: k.str(it.node[1]), kind: it.kind, x: r3(x), y: r3(y) }); }
    }
    const t = resolveTargets(doc, { nets: [name] });
    return { document: path, net: net.name, on_the_board: net.board !== net.name ? net.board : undefined, pins: net.pins.map((p) => `${p.ref}.${p.number}${p.name ? `(${p.name})` : ""} ${p.type}`), labels, wires, wire_length_mm: r3(wire), box: t.box ? t.box.map(r3) : undefined,
      leaves_the_sheet: labels.some((l) => l.kind !== "label") ? "through its global or hierarchical labels; trace it on the other sheets and on the board as well" : undefined };
  }
  const P = W.PcbTools; const net = boardNet(doc, name);
  if (!net) throw new ToolError(`There is no net ${name} on the board. list_nets gives the names.`);
  const layers: Record<string, { length_mm: number; segments: number }> = {}; const widths = new Set<number>(); let total = 0;
  for (const c of net.tracks) { const l = Array.from(c.layers as Set<string>)[0] || "?"; const e = layers[l] || (layers[l] = { length_mm: 0, segments: 0 }); e.length_mm += c.length || 0; e.segments++; total += c.length || 0; widths.add(r3(c.width)); }
  for (const l of Object.keys(layers)) layers[l].length_mm = r3(layers[l].length_mm);
  const padName = (c: any) => `${c.item.ref || "?"}.${c.pad.number}`;
  const pads = net.pads.map((c: any) => ({ pad: padName(c), x: r3(c.pad.x), y: r3(c.pad.y), side: c.layers.has("F.Cu") && c.layers.has("B.Cu") ? "through" : c.layers.has("B.Cu") ? "back" : "front" }))
    .sort((p: any, q: any) => p.pad.localeCompare(q.pad, undefined, { numeric: true }));
  // what is still open: the ratsnest lines of this net, between the pads (or copper) nearest each end
  const near = (pt: number[]) => { let best = "", d = 0.6; for (const c of net.pads) { const q = Math.hypot(c.pad.x - pt[0], c.pad.y - pt[1]); if (q < d) { d = q; best = padName(c); } } return best || `${r3(pt[0])}, ${r3(pt[1])}`; };
  const open = (P.ratsnest(doc) as any[]).filter((l) => l.net === net.key).map((l) => ({ from: near(l.a), to: near(l.b), gap_mm: r3(l.length) }));
  const t = resolveTargets(doc, { nets: [name] });
  return { document: path, net: net.name, pads: pads.slice(0, 120), pad_count: pads.length, routed_length_mm: r3(total), by_layer: layers, track_widths_mm: Array.from(widths).sort((a, b) => a - b),
    vias: net.vias.length, via_positions: net.vias.slice(0, 40).map((c: any) => [r3(c.shape.x), r3(c.shape.y)]), zones: net.zones.length ? new Set(net.zones.map((c: any) => c.id)).size : undefined,
    islands: net.clusters.length, open_connections: open.length ? open.slice(0, 40) : 0, shorted_to: net.shorts.length ? Array.from(new Set(net.shorts.flatMap((c: any) => Array.from(c.nets as Set<string>)))).filter((n) => n !== net.key) : undefined,
    box: t.box ? t.box.map(r3) : undefined };
}
