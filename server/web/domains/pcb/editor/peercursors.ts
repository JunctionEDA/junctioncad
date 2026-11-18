// The other people's pointers, on a layer of their own.
//
// A presence message used to rebuild the whole peer overlay (selection outlines, ghosts, the pointer, its name tag
// with a text measurement) and re-render the people list; a pointer only moved when a message came.  Here each
// person's pointer is one persistent element that is moved by a transform on every display frame, and is rebuilt only
// when its name, colour or note change.
//
// How it moves (the way Figma and perfect-cursors do it): the sender sends its pointer every frame or so, stamped
// with its own clock (`ts`, peers.ts).  The receiver keeps the points it has not drawn yet and walks through them at
// the speed they were made (each step takes as long as it took the sender), a little behind the newest one.  The
// pointer is always somewhere on the line between two places the person really was: never guessed ahead, never past
// where they stopped.  The "little behind" (`delay`) adapts: it grows when the walk catches up with the newest point
// while the person is still moving (the network held a message), and shrinks back slowly while messages come evenly.
// When a backlog builds (a burst after a stall) the walk speeds up to catch up; when the sender says it stopped (the
// same place again), the walk just finishes.  Nothing is drawn ahead of what has arrived.
import { NS } from "./dom";
import { E } from "./state";
import { toast } from "./util";

// A peer's pointer and name tag, in screen pixels (the desktop's COLLAB_CURSOR_ITEM uses the same sizes).
const PEER_CURSOR_PX = 24, PEER_TAG_TEXT_PX = 16, PEER_TAG_PAD_PX = 5;
/** How far behind the newest point the walk aims to be, ms: its starting value and bounds. */
const DELAY_START_MS = 24, DELAY_MIN_MS = 16, DELAY_MAX_MS = 40;
/** How much one stall (the walk ran out of points mid-motion) adds to the delay, and how fast it comes back, ms/s. */
const DELAY_STALL_STEP_MS = 3, DELAY_DECAY_MS_PER_S = 8;
/** The longest a single step may take, ms (a longer gap is a pause, not slow motion), and the step for a sender that
 *  does not stamp its points. */
const STEP_MAX_MS = 60, STEP_DEFAULT_MS = 15;
/** The fastest the walk goes to catch up with a backlog (times real speed), and the slowest it goes when it is about
 *  to run out while the person is still moving. */
const RATE_MAX = 4, RATE_MIN = 0.8;

let rttMs = 0;
/** Our round trip to the server, from a ping (net.ts); a running estimate that leans to the fast samples, since a
 *  slow one is usually a hiccup and not the distance.  Sent along with presence (peers.ts) for diagnostics. */
export function noteRtt(ms: number) {
  if (!(ms > 0 && ms < 2000)) return;
  rttMs = !rttMs ? ms : ms < rttMs ? rttMs * 0.5 + ms * 0.5 : rttMs * 0.9 + ms * 0.1;
}
export function myRtt() { return rttMs; }

interface Step { x: number; y: number; d: number }
interface Cursor {
  g: SVGGElement;
  key: string;
  /** the newest point received (mm), its sender stamp, when it came (performance.now()) */
  x: number; y: number; ts: number; t: number;
  /** where the walk is: the point it left (mm), the points still ahead with how long each step takes, ms into the
   *  first step */
  fx: number; fy: number; q: Step[]; p: number;
  /** the sender said it stopped (its last point repeated): finish the walk at full speed */
  done: boolean;
  /** how far behind the newest point the walk aims to be, ms; when the walk last ran out of points mid-motion */
  delay: number; dry: number;
  /** what is drawn (mm) */
  dx: number; dy: number;
  /** the scale the element was last transformed with */
  s: number;
}

const cursors = new Map<string, Cursor>();
let layer: SVGGElement | null = null;
let raf = 0, lastFrame = 0;
let scaleOf: () => number = () => 4;
let onFollow: (cid: string, name: string) => void = () => {};

/** Brightness 0..1 of a #rgb / #rrggbb colour, as COLOR4D::GetBrightness (its weighted W3C formula). */
export function brightness(c: string): number {
  const h = c.replace("#", ""), f = h.length === 3 ? h.split("").map((d) => d + d).join("") : h.slice(0, 6);
  const n = parseInt(f, 16); if (!Number.isFinite(n)) return 0;
  return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.117) / 255;
}

/** Where the layer lives (right above the peer overlay) and how to read the current screen pixels per mm. */
export function initPeerCursors(peersG: SVGGElement, pxPerMm: () => number, follow: (cid: string, name: string) => void) {
  scaleOf = pxPerMm; onFollow = follow;
  if (layer && layer.isConnected) return;
  layer = document.createElementNS(NS, "g") as SVGGElement;
  layer.id = "peerCursorG";
  layer.style.pointerEvents = "none";
  peersG.after(layer);
}

export function clearPeerCursors() {
  for (const c of cursors.values()) c.g.remove();
  cursors.clear();
}

export interface PeerCursorSpec { cid: string; name: string; color: string; note: string; following: boolean; at: number[];
  /** cursor chat: what they are saying, in a bubble of their colour (chat.ts) */ say?: string;
  /** the sender's clock when it sent this point, ms (0 when it does not say) */ ts: number }

/** The pointers there should be now (mm), from the presence map. */
export function syncPeerCursors(specs: PeerCursorSpec[]) {
  if (!layer) return;
  const now = performance.now(), keep = new Set<string>();
  for (const sp of specs) {
    keep.add(sp.cid);
    const key = `${sp.name}\u0000${sp.color}\u0000${sp.note}\u0000${sp.say || ""}\u0000${sp.following ? 1 : 0}`;
    let c = cursors.get(sp.cid);
    if (!c) {
      const g = document.createElementNS(NS, "g") as SVGGElement;
      g.setAttribute("class", "peer-cursor");
      layer.appendChild(g);
      const [x, y] = sp.at;
      c = { g, key: "", x, y, ts: sp.ts, t: now, fx: x, fy: y, q: [], p: 0, done: true, delay: DELAY_START_MS, dry: 0, dx: x, dy: y, s: 0 };
      cursors.set(sp.cid, c);
    } else {
      sample(c, sp.at[0], sp.at[1], sp.ts, now);
    }
    if (c.key !== key) { c.key = key; build(c, sp); }
  }
  for (const [cid, c] of cursors) if (!keep.has(cid)) { c.g.remove(); cursors.delete(cid); }
  place(true);
  wake();
}

/** One cursor's new point, straight from a presence message (mm). */
function sample(c: Cursor, x: number, y: number, ts: number, now: number) {
  // the full peer map comes again with other people's updates: the same stamp is not a new point
  if (ts && ts === c.ts) return;
  if (ts && c.ts && ts < c.ts) return; // overtaken (a held state flushed late)
  const gap = ts && c.ts ? ts - c.ts : now - c.t;
  c.ts = ts; c.t = now;
  // The same place again is the sender saying it stopped: finish the walk, no new step.
  if (x === c.x && y === c.y) { c.done = true; return; }
  c.x = x; c.y = y;
  // A jump (a peer who zoomed out and back, or was off the page) is shown at once.
  if (Math.hypot(x - c.dx, y - c.dy) * scaleOf() > 400) { c.q = []; c.p = 0; c.fx = c.dx = x; c.fy = c.dy = y; c.done = true; return; }
  // Moving again after a rest: start the walk from where the pointer is drawn, after the delay, so the next point
  // (one send interval away) is likely here before the walk reaches this one.
  // The walk ran dry a moment ago although the person had not stopped: the network held this point.  Sit further
  // back from now on, by part of how long it was held.
  if (!c.done && !c.q.length && c.dry && now - c.dry < 200) c.delay = Math.min(DELAY_MAX_MS, c.delay + Math.min(DELAY_STALL_STEP_MS, (now - c.dry) / 2));
  c.dry = 0;
  const resting = c.done || !c.q.length;
  const d = resting ? c.delay : Math.max(1, Math.min(STEP_MAX_MS, gap > 0 ? gap : STEP_DEFAULT_MS));
  c.done = false;
  c.q.push({ x, y, d });
  if (c.q.length > 120) { const k = c.q.length - 120; const last = c.q[k - 1]; c.fx = last.x; c.fy = last.y; c.q.splice(0, k); c.p = 0; }
}

/** Advance every walk by one display frame and draw it.  Returns whether anything is still moving. */
function place(force: boolean) {
  const now = performance.now(), dt = lastFrame ? Math.min(50, now - lastFrame) : 0; lastFrame = now;
  const s = scaleOf();
  let moving = false;
  for (const c of cursors.values()) {
    if (c.q.length) {
      // how much walk is still ahead, against how far behind it should be
      let ahead = -c.p; for (const st of c.q) ahead += st.d;
      const rate = c.done ? Math.max(1, Math.min(RATE_MAX, 1 + (ahead - c.delay) / 40))
        : Math.max(RATE_MIN, Math.min(RATE_MAX, 1 + (ahead - c.delay) / 40));
      let adv = dt * rate;
      while (adv > 0 && c.q.length) {
        const st = c.q[0], left = st.d - c.p;
        if (adv >= left) { adv -= left; c.fx = st.x; c.fy = st.y; c.q.shift(); c.p = 0; }
        else { c.p += adv; adv = 0; }
      }
      // ran out while the person may still be moving: either they stopped (their stop message follows) or the
      // network is holding the next point (sample() tells which, and makes the delay longer)
      if (!c.q.length && !c.done) c.dry = now;
    }
    if (c.delay > DELAY_MIN_MS && dt > 0) c.delay = Math.max(DELAY_MIN_MS, c.delay - DELAY_DECAY_MS_PER_S * dt / 1000);
    if (c.q.length) {
      const st = c.q[0], k = st.d > 0 ? c.p / st.d : 1;
      c.dx = c.fx + (st.x - c.fx) * k; c.dy = c.fy + (st.y - c.fy) * k;
      moving = true;
    } else { c.dx = c.fx; c.dy = c.fy; }
    const tf = `translate(${c.dx.toFixed(4)} ${c.dy.toFixed(4)}) scale(${(1 / s).toFixed(6)})`;
    if (force || moving || c.s !== s || c.g.getAttribute("transform") !== tf) { c.g.setAttribute("transform", tf); c.s = s; }
  }
  return moving;
}

function wake() {
  if (raf) return;
  const frame = () => {
    raf = 0;
    if (place(false)) raf = requestAnimationFrame(frame);
    else lastFrame = 0;
  };
  lastFrame = performance.now();
  raf = requestAnimationFrame(frame);
}

/** COLLAB_CURSOR_ITEM's pointer and name tag, drawn in screen pixels about the pointer's tip at (0, 0): a triangle in
 *  the peer colour, and below-right of it a chip filled with that colour, the name in black or white on it. */
function build(c: Cursor, sp: PeerCursorSpec) {
  const g = c.g; g.replaceChildren();
  const t = PEER_CURSOR_PX, th = PEER_TAG_TEXT_PX, pad = PEER_TAG_PAD_PX, color = sp.color;
  const tri = document.createElementNS(NS, "path");
  tri.setAttribute("d", `M 0 0 L ${0.38 * t} ${t} L ${t} ${0.38 * t} Z`);
  tri.setAttribute("fill", color); tri.setAttribute("stroke", "white"); tri.setAttribute("stroke-opacity", "0.9"); tri.setAttribute("stroke-width", "1.5");
  tri.setAttribute("stroke-linejoin", "round");
  g.appendChild(tri);
  const tag = document.createElementNS(NS, "g");
  tag.style.pointerEvents = "auto"; tag.style.cursor = "pointer";
  const cx = 0.8 * t, cy = 1.2 * t;
  const chip = document.createElementNS(NS, "rect");
  chip.setAttribute("x", String(cx)); chip.setAttribute("y", String(cy)); chip.setAttribute("height", String(th + 2 * pad)); chip.setAttribute("rx", "2");
  chip.setAttribute("fill", color);
  const label = document.createElementNS(NS, "text");
  label.setAttribute("x", String(cx + pad)); label.setAttribute("y", String(cy + pad + th / 2)); label.setAttribute("dominant-baseline", "central");
  label.setAttribute("font-size", String(th)); label.setAttribute("font-weight", "600"); label.setAttribute("font-family", "system-ui, sans-serif");
  label.setAttribute("fill", brightness(color) > 0.5 ? "#000" : "#fff");
  label.textContent = sp.following ? sp.name + " (following)" : sp.name;
  tag.appendChild(chip); tag.appendChild(label); g.appendChild(tag);
  let tw = 0; try { tw = label.getComputedTextLength(); } catch { /* not laid out */ }
  if (!(tw > 0)) tw = label.textContent.length * 0.6 * th;
  chip.setAttribute("width", String(tw + 2 * pad));
  let below = cy + th + 2 * pad + 3;   // where the next chip under the name goes
  // what the assistant says about what it is pointing at: a second chip under its name, wrapped to a few lines
  if (sp.note) {
    const lines: string[] = []; let cur = "";
    for (const w of sp.note.split(/\s+/)) { if (cur && (cur + " " + w).length > 38) { lines.push(cur); cur = w; } else cur = cur ? cur + " " + w : w; }
    if (cur) lines.push(cur);
    const lh = th * 1.3, ny = cy + th + 2 * pad + 3, nh = lines.length * lh + 2 * pad;
    const box = document.createElementNS(NS, "rect"), txt = document.createElementNS(NS, "text");
    box.setAttribute("x", String(cx)); box.setAttribute("y", String(ny)); box.setAttribute("height", String(nh)); box.setAttribute("rx", "2");
    box.setAttribute("fill", "#16161a"); box.setAttribute("fill-opacity", "0.94"); box.setAttribute("stroke", color); box.setAttribute("stroke-width", "1");
    txt.setAttribute("font-size", String(th)); txt.setAttribute("font-family", "system-ui, sans-serif"); txt.setAttribute("fill", "#f2f2f4");
    lines.forEach((ln, i) => { const ts = document.createElementNS(NS, "tspan"); ts.setAttribute("x", String(cx + pad)); ts.setAttribute("y", String(ny + pad + lh * i + lh / 2)); ts.setAttribute("dominant-baseline", "central"); ts.textContent = ln; txt.appendChild(ts); });
    const note = document.createElementNS(NS, "g"); note.setAttribute("class", "ai-note"); note.appendChild(box); note.appendChild(txt); g.appendChild(note);
    let nw = 0; try { nw = txt.getBBox().width; } catch { /* not laid out */ }
    if (!(nw > 0)) nw = Math.max(...lines.map((l) => l.length)) * 0.55 * th;
    box.setAttribute("width", String(nw + 2 * pad));
    below = ny + nh + 3;
  }
  // cursor chat (chat.ts): what the person is typing, in a speech bubble of their own colour, as Figma draws it
  if (sp.say) {
    const lines: string[] = []; let cur = "";
    for (const w of sp.say.split(/\s+/)) { if (cur && (cur + " " + w).length > 34) { lines.push(cur); cur = w; } else cur = cur ? cur + " " + w : w; }
    if (cur) lines.push(cur);
    const fs = th + 2, lh = fs * 1.3, bp = pad + 3, bh = lines.length * lh + 2 * bp;
    const box = document.createElementNS(NS, "rect"), txt = document.createElementNS(NS, "text");
    box.setAttribute("x", String(cx)); box.setAttribute("y", String(below)); box.setAttribute("height", String(bh)); box.setAttribute("rx", String(Math.min(12, bh / 2)));
    box.setAttribute("fill", color);
    txt.setAttribute("font-size", String(fs)); txt.setAttribute("font-family", "system-ui, sans-serif"); txt.setAttribute("fill", brightness(color) > 0.5 ? "#000" : "#fff");
    lines.slice(0, 6).forEach((ln, i) => { const ts = document.createElementNS(NS, "tspan"); ts.setAttribute("x", String(cx + bp)); ts.setAttribute("y", String(below + bp + lh * i + lh / 2)); ts.setAttribute("dominant-baseline", "central"); ts.textContent = ln; txt.appendChild(ts); });
    const say = document.createElementNS(NS, "g"); say.setAttribute("class", "peer-say"); say.appendChild(box); say.appendChild(txt); g.appendChild(say);
    let sw = 0; try { sw = txt.getBBox().width; } catch { /* not laid out */ }
    if (!(sw > 0)) sw = Math.max(...lines.map((l) => l.length)) * 0.55 * fs;
    box.setAttribute("width", String(sw + 2 * bp));
  }
  tag.addEventListener("click", (ev) => { ev.stopPropagation(); onFollow(sp.cid, sp.name); });
}

/** Whether only the pointer or the view of a peer changed between two presence states (then nothing but the
 *  pointer layer needs to move). */
export function onlyPointerMoved(a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined): boolean {
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (k === "cursor" || k === "viewport" || k === "rtt" || k === "ts") continue;
    if (!(k in b)) return false;
    const x = a[k], y = b[k];
    if (x === y) continue;
    if (typeof x !== "object" || typeof y !== "object" || JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}

export function toggleFollowToast(cid: string, name: string, render: () => void) {
  E.followPeer = E.followPeer === cid ? null : cid;
  toast(E.followPeer ? `Following ${name}` : "Stopped following");
  render();
}

// for scripts/cursor-lag.mjs (DEBUG=1): each walk's state
(globalThis as Record<string, unknown>).__peerCursorState = () => [...cursors.values()].map((c) => ({ x: c.x, y: c.y, dx: c.dx, dy: c.dy, q: c.q.length, done: c.done, delay: Math.round(c.delay), ts: c.ts }));
