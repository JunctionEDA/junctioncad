// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/domains/pcb/editor/index.ts — edit these modules, not the bundle).
import { state, store } from "./appstore";
import { E } from "./state";
import { toast } from "./util";
import type { PeerEntry, PresenceState } from "./types";
import { myRtt } from "./peercursors";
import { applyView, mmH, mmW, mmX0, mmY0, stage, visibleRectNm, world } from "./view";
export function cycleFollow() {
  const ids = Object.keys(E.peerState);
  if (!ids.length) { toast("No one else is here to follow"); return; }
  const i = ids.indexOf(E.followPeer);
  E.followPeer = ids[(i + 1) % ids.length] || null;
  const p = E.peerState[E.followPeer];
  toast(`Following ${peerName(p)} — zoom or pan to stop`);
  applyFollowWeb(E.peerState); renderPeers();
}

export function peerName(p: PeerEntry | null | undefined) { return (p && p.user && (p.user.name || p.user.login)) || "peer"; }


// ---- follow ----
export function applyFollowWeb(peers: Record<string, PeerEntry>) {
  if (!E.followPeer) return;
  const entry = peers[E.followPeer];
  if (!entry) { E.followPeer = null; toast("Stopped following (they left)"); renderPeers(); return; }
  const vp = (entry.state || {}).viewport;
  if (!vp || vp.length < 4 || vp[2] <= 0) return;
  const w = world.clientWidth || stage.clientWidth;
  const xMm = vp[0] / E.IU, yMm = vp[1] / E.IU, wMm = vp[2] / E.IU;
  E.zoom = Math.min(40, Math.max(0.2, (stage.clientWidth / w) * (mmW() / wMm)));
  E.panX = -((xMm - mmX0()) / mmW()) * w * E.zoom;
  E.panY = -((yMm - mmY0()) / mmH()) * (w * mmH() / mmW()) * E.zoom;
  E.suppressBreakout = true; applyView(); E.suppressBreakout = false;
}

export function breakFollow() {
  if (!E.followPeer || E.suppressBreakout) return;
  E.followPeer = null; toast("Stopped following"); renderPeers();
}

export function renderPeers() {
  store.set({ peers: { list: Object.keys(E.peerState).map((cid) => { const p = E.peerState[cid]; return { cid, name: peerName(p), color: (p.user && p.user.color) || "#4477ee" }; }), follow: E.followPeer } });
}

export function followAction(cid: string | null) { E.followPeer = cid && E.peerState[cid] ? cid : null; applyFollowWeb(E.peerState); renderPeers(); }

/** The last cursor position we told anyone about, so the keepalive can re-send it. */
/** The shortest time between two presence messages, ms: every display frame at 60 Hz (the server forwards each one
 *  at once, presence_lane.rs).  A call that comes sooner is not dropped: it is sent when the gap is up, with whatever
 *  is newest by then, so the place the pointer stopped always reaches everyone. */
const PRESENCE_GAP_MS = 14;
let trailing: ReturnType<typeof setTimeout> | 0 = 0;
/** No pointer move for this long after the last update means it stopped. */
const STOP_AFTER_MS = 40;
let stopTimer: ReturnType<typeof setTimeout> | 0 = 0, stopping = false;
let trailingGhost: number[][] | null | undefined;
export function sendPresence(mmPos: number[] | null, ghostSegs?: number[][] | null) {
  const now = Date.now();
  if (mmPos) E.lastPresenceMm = mmPos;
  // A peer who has joined but not yet moved the pointer must still appear: fall back to the
  // centre of what they are looking at, which is also what the desktop's follow reads.
  const at = mmPos || E.lastPresenceMm || viewCentreMm();
  if (!at || !E.ws || E.ws.readyState !== 1 || !state.docId) return;
  // Ghost updates are rate-limited like the cursor; an *empty* ghost is the "I stopped drawing"
  // signal and must go out at once so peers do not keep painting a stale in-flight wire.
  const clearing = Array.isArray(ghostSegs) && ghostSegs.length === 0;
  if (now - E.lastPresence < PRESENCE_GAP_MS && !clearing) {
    // the newest ghost wins; "no ghost given" keeps the one already waiting
    if (ghostSegs !== undefined) trailingGhost = ghostSegs;
    if (!trailing) trailing = setTimeout(() => { trailing = 0; const g = trailingGhost; trailingGhost = undefined; sendPresence(null, g); }, PRESENCE_GAP_MS - (now - E.lastPresence));
    return;
  }
  if (trailing) { clearTimeout(trailing); trailing = 0; if (ghostSegs === undefined) ghostSegs = trailingGhost; trailingGhost = undefined; }
  E.lastPresence = now;
  // The pointer stopped: say so once more a moment later, with the same place, so peers replaying it (peercursors.ts)
  // know the motion ended and finish it at once.
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = stopping ? 0 : setTimeout(() => { stopTimer = 0; E.lastPresence = 0; stopping = true; try { sendPresence(null); } finally { stopping = false; } }, STOP_AFTER_MS);
  const st: PresenceState = { cursor: [Math.round(at[0] * E.IU), Math.round(at[1] * E.IU)] };
  const rtt = myRtt(); if (rtt > 0) st.rtt = Math.round(rtt);
  st.ts = Math.round(performance.now() * 10) / 10;
  const vp = visibleRectNm(); if (vp) st.viewport = vp;
  if (ghostSegs) st.ghost = ghostSegs;
  if (E.chatSay) st.say = E.chatSay as string;   // cursor chat (chat.ts)
  // What the peer has selected (desktop rebuildOverlay pairs selection[i] with boxes[i] and at[i]; boxes are
  // BOX2I(origin, size) in IU).  Everything this client has picked: the multi-selection, the single symbol /
  // footprint (E.selected), and the schematic or board module's own pick (wires, labels, tracks, vias, graphics).
  const picked = new Set<string>(E.selection || []);
  if (E.selected && E.selected.id) picked.add(E.selected.id);
  const T = typeof CollabTools !== "undefined" ? CollabTools : null;
  if (E.DOC_TYPE === "kicad_sch") {
    const schSel = T && T.sch && T.sch.state ? T.sch.state.sel : null;
    if (typeof schSel === "string" && schSel) picked.add(schSel);
  } else {
    const modSel = E.kdoc && T && T.pcb && T.pcb.state && T.pcb.state.sel;
    if (modSel) for (const id of modSel) picked.add(id);
  }
  const sel = picked.size ? cachedSelection(picked) : null;
  if (sel) {
    st.selection = sel.selection;
    if (sel.boxes) {
      st.boxes = sel.boxes;
      // The item's anchor (its GetPosition on the desktop): a receiver that holds the item ghosts it displaced by
      // `at - its own anchor`, which is exact, where a bounding-box difference never is (fonts, text layers).
      st.at = sel.selection.map((id) => { const it = E.kdoc.items.get(id), a = it && anchorMm(it); return a ? [Math.round(a[0] * E.IU), Math.round(a[1] * E.IU)] : null; });
    }
  }
  // The desktop only draws a peer that says which sheet it is on: SCH_COLLAB_TOOL::rebuildOverlay
  // skips any peer whose state.sheetFile differs from the sheet it is showing, and an absent field
  // reads as "" and never matches.  It is the document's project-relative path, which is exactly
  // what the server's doc list carries.
  // (the path in the whole project: the editor's own list has it relative to the PCB's folder, pcbscope.ts)
  const doc = ((state.project && state.project.allDocs) || state.docs || []).find((d) => d.docId === state.docId);
  if (doc && doc.path) st.sheetFile = doc.path;
  E.ws.send(JSON.stringify({ type: "presence", docId: state.docId, state: fitPresence(st) }));
}

/** The selection part of the last message: at rest it only changes with the selection (or the document), and the
 *  pointer goes out sixty times a second, so it is not worked out again each time.  While something moves, it is,
 *  and at rest it is refreshed a few times a second anyway (an edit can change a selected item's box). */
let selCache: { key: string; doc: unknown; at: number; sel: ReturnType<typeof presenceSelection> } | null = null;
function cachedSelection(picked: Set<string>) {
  const moving = presenceMoving();
  const key = [...picked].join("\u0000");
  if (!moving && selCache && selCache.key === key && selCache.doc === E.kdoc && performance.now() - selCache.at < 250) return selCache.sel;
  const sel = presenceSelection(E.kdoc, picked, E.IU, moving);
  selCache = moving ? null : { key, doc: E.kdoc, at: performance.now(), sel };
  return sel;
}

/** The server refuses a presence state over 8 KB (ws.rs MAX_PRESENCE_BYTES) with bad_message, which reads as a broken
 *  session; keep under it with room to spare.  A large selection (an imported sheet riding the cursor) is cut down: the
 *  parallel selection / boxes / at lists are shortened together, so a peer still sees the first items move with it. */
const PRESENCE_LIMIT = 7600;
export function fitPresence(st: PresenceState): PresenceState {
  let s = JSON.stringify(st);
  if (s.length <= PRESENCE_LIMIT) return st;
  const out: PresenceState = { ...st };
  let n = out.selection ? out.selection.length : 0;
  while (n > 0 && s.length > PRESENCE_LIMIT) {
    n = Math.floor(n * Math.min(0.9, PRESENCE_LIMIT / s.length));
    out.selection = st.selection!.slice(0, n);
    if (st.boxes) out.boxes = st.boxes.slice(0, n);
    if (st.at) out.at = st.at.slice(0, n);
    if (!n) { delete out.selection; delete out.boxes; delete out.at; }
    s = JSON.stringify(out);
  }
  if (s.length > PRESENCE_LIMIT && out.dragLines) { delete out.dragLines; delete out.dragAdded; s = JSON.stringify(out); }
  if (s.length > PRESENCE_LIMIT && out.ghost) { delete out.ghost; s = JSON.stringify(out); }
  return out;
}

/** Where an item is placed by (mm): its (at) / transform for symbols, footprints, vias and texts, else its first point. */
export function anchorMm(it: KItem): number[] | null {
  const n = it.node, K = KiCadCanvas;
  if (!n) return null;
  if (n[0] === "arc" || n[0] === "gr_arc") return null;   // the desktop anchors arcs on their centre (EDA_SHAPE::getPosition), which the file's three points do not carry
  if (K.kid(n, "at") || K.kid(n, "transform")) { const a = K.atOf(n); return a ? [a[0], a[1]] : null; }
  for (const key of ["start", "center"]) { const p = K.kid(n, key); if (p) return [K.num(p[1]), K.num(p[2])]; }
  const pts = K.ptsOf(n); if (pts.length) return pts[0];
  const poly = K.kid(n, "polyline"); if (poly) { const pp = K.ptsOf(poly); if (pp.length) return pp[0]; }
  return null;
}

/**
 * What this client has selected, for peers.
 *
 * The desktop's rebuildOverlay (pcbnew/collab/pcb_collab_tool.cpp, eeschema/collab/sch_collab_tool.cpp) reads
 * `boxes` as BOX2I(origin, size) in internal units — the sender's GetBoundingBox() of each selected item,
 * paired by index with `selection` — and takes any difference between a box's origin and its own
 * GetBoundingBox() of that item as "the peer is dragging it": it then paints a copy of the item displaced by
 * the difference and airwires to it.  With only `selection` it resolves the ids in its own board and outlines
 * its own boxes.  So:
 *   · at rest a board sends ids alone: the desktop's own geometry is exact, where any box computed here that
 *     is off by more than one unit (a footprint's box hangs on text extents and on what the desktop shows)
 *     would draw a second, shifted copy of everything selected;
 *   · while something is being moved the boxes go along, computed the way pcbnew does (canvas/kicad-bbox.ts),
 *     so the difference the desktop sees is the move itself.
 * A schematic keeps sending its boxes always (the renderer's extents), as before.
 */
export const presenceSelection = (doc: KDoc | null, selection: Iterable<string> | null, IU: number, moving: boolean) => KiCadCanvas.presenceSelection(doc, selection, IU, moving, MAX_PRESENCE_ITEMS);

/** Is a move in flight — the app's own drag, or one of the board / schematic modules' — so that live boxes matter? */
function presenceMoving() {
  if (E.drag && (E.drag.moved || E.drag.group)) return true;
  const T = typeof CollabTools !== "undefined" ? CollabTools : null;
  const p = T && T.pcb && T.pcb.state, sc = T && T.sch && T.sch.state;
  return !!((p && ((p.move && p.move.moved) || p.drag || p.carry)) || (sc && sc.drag));
}

/** ws.rs rejects a presence state over 8 KB outright, and the desktop caps its own lists too. */
export const MAX_PRESENCE_ITEMS = 60;

/**
 * The server drops a client's presence after 30 s of silence (doc_actor.rs PRESENCE_STALE) and
 * broadcasts a null entry for it, which blanks the cursor on the desktop and — because the web's
 * peer list *is* the presence map — removes the peer from the web's pane entirely.  The desktop
 * beats that by re-sending unchanged state every 10 s off its tool timer; without this the web
 * has no such heartbeat, so a web user who stops moving the mouse simply disappears.
 */
export function startPresenceKeepalive() {
  stopPresenceKeepalive();
  E.presenceTimer = setInterval(() => {
    if (!E.ws || E.ws.readyState !== 1) return;
    if (Date.now() - E.lastPresence < 10000) return;
    E.lastPresence = 0;   // the 80 ms rate limit must not swallow the heartbeat
    sendPresence(null);
  }, 5000);
}

function viewCentreMm() { const v = visibleRectNm(); return v ? [(v[0] + v[2] / 2) / E.IU, (v[1] + v[3] / 2) / E.IU] : null; }

export function stopPresenceKeepalive() { if (E.presenceTimer) { clearInterval(E.presenceTimer); E.presenceTimer = 0; } }
