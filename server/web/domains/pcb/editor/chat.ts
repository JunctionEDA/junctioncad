// chat.ts — the project chat: one running conversation per project, for the people working on it together.
//
// Review threads (comments.ts) stay pinned to a part or a net; the chat is the room beside them (people were
// typing to each other in text items on the sheet before it existed).  A message can carry a link to the
// selection or the place you are looking at, on any document of the project: a click on it opens that
// document and brings the place into view.  Messages live on the server (server/src/chat.rs) and reach every
// open document of the project over its socket as {"type": "chat"}.  The Chat pane (components/panes/Chat.tsx)
// and the menu bar's Chat button (with its unread count) render from store.chat.
//
// Cursor chat, as in Figma: Alt+M opens a bubble at your pointer; what you type there shows beside your cursor on
// everyone's canvas as you type it (presence `say`), and Enter posts it to the chat with a link to that spot.
import type { ChatLink, ChatMessage, ChatState } from "../../../shared/store";
import { state, store } from "./appstore";
import { describe, netIds, netOfItem } from "./comments";
import { centerOn } from "./comments";
import { applyPickMode, clearAllSelection, selectionChanged, selectionHooks, selectionIds } from "./gestures";
import { sendPresence } from "./peers";
import { E } from "./state";
import { api, toast } from "./util";
import { pxPerMm, requestRender, stage, visibleRectNm, worldMm, zoomBy } from "./view";

const request = api as (path: string, opts?: RequestInit) => Promise<unknown>;
const EMPTY: ChatState = { projectId: null, messages: [], loading: false, more: false, error: null, lastReadId: 0, unread: 0, canWrite: false, link: null };
interface Me { id: number; login: string; name?: string | null; avatarUrl?: string | null }
const me = (): Me | null => (state as unknown as { me: Me | null }).me;
const projectId = (): string | null => (state.project ? state.project.projectId : null);
const chat = (): ChatState => store.get().chat || EMPTY;
const setChat = (patch: Partial<ChatState>): void => store.set({ chat: Object.assign({}, chat(), patch) });

/** Whether the composer attaches the selection (or the view) to the next message. */
let attach = false;
let pendingId = 0;

// ---------------------------------------------------------------- loading
let loadN = 0;
/** The chat of the open project: loaded once per project (switching documents keeps it). */
export async function loadChat(force = false): Promise<void> {
  hookOnce();
  const pid = projectId();
  if (!pid) { store.set({ chat: EMPTY }); return; }
  if (!force && chat().projectId === pid) { refreshLink(); return; }
  const n = ++loadN;
  store.set({ chat: Object.assign({}, EMPTY, { projectId: pid, loading: true }) });
  try {
    const j = (await request(`/api/projects/${pid}/chat?limit=100`)) as { messages: ChatMessage[]; more: boolean; lastReadId: number; unread: number; canWrite: boolean };
    if (n !== loadN || projectId() !== pid) return;
    setChat({ messages: j.messages || [], more: !!j.more, lastReadId: j.lastReadId || 0, unread: j.unread || 0, canWrite: !!j.canWrite, loading: false });
  } catch (e) {
    if (n !== loadN) return;
    setChat({ loading: false, error: "The chat could not be loaded." });
    console.warn("chat load failed", e);
  }
  refreshLink();
  maybeMarkRead();
}

async function loadOlder(): Promise<void> {
  const c = chat(), pid = c.projectId; if (!pid || !c.more || c.loading || !c.messages.length) return;
  setChat({ loading: true });
  try {
    const j = (await request(`/api/projects/${pid}/chat?limit=100&before=${c.messages[0].id}`)) as { messages: ChatMessage[]; more: boolean };
    if (chat().projectId !== pid) return;
    const have = new Set(chat().messages.map((m) => m.id));
    setChat({ messages: [...(j.messages || []).filter((m) => !have.has(m.id)), ...chat().messages], more: !!j.more, loading: false });
  } catch { setChat({ loading: false }); }
}

// ---------------------------------------------------------------- live updates
const chatOpen = (): boolean => !!store.get().panes.chat;
const watching = (): boolean => chatOpen() && typeof document !== "undefined" && document.visibilityState === "visible";

/** A message somebody posted, edited or deleted (the server's {"type": "chat"} notice). */
export function noteChatMsg(msg: { projectId?: string; action?: string; message?: ChatMessage & { id: number } }): void {
  const c = chat(), m = msg.message;
  if (!m || !c.projectId || msg.projectId !== c.projectId) return;
  let list = c.messages;
  if (msg.action === "deleted") list = list.filter((x) => x.id !== m.id);
  else if (msg.action === "updated") list = list.map((x) => (x.id === m.id ? m : x));
  else if (msg.action === "added") {
    if (list.some((x) => x.id === m.id)) return;   // our own, already in place (or the same notice twice)
    list = [...list, m];
    const mine = me() && m.authorId === me()!.id;
    if (!mine) {
      setChat({ messages: list, unread: c.unread + 1 });
      if (!watching()) toast(`${m.authorName || m.authorLogin}: ${m.body.length > 90 ? m.body.slice(0, 89) + "…" : m.body}`, 5000, { text: "Open Chat", run: () => openChat() });
      maybeMarkRead();
      return;
    }
  }
  setChat({ messages: list });
}

// ---------------------------------------------------------------- read marks
let readTimer: ReturnType<typeof setTimeout> | 0 = 0;
/** The chat is on screen: whatever is in it has been read (sent a moment later, once). */
export function maybeMarkRead(): void {
  const c = chat(); if (!c.projectId || !me() || !watching()) return;
  const last = c.messages.filter((m) => m.id > 0).reduce((a, m) => Math.max(a, m.id), 0);
  if (!c.unread && last <= c.lastReadId) return;
  setChat({ unread: 0 });
  if (readTimer) return;
  readTimer = setTimeout(async () => {
    readTimer = 0;
    const cc = chat(), pid = cc.projectId; if (!pid) return;
    const upTo = cc.messages.filter((m) => m.id > 0).reduce((a, m) => Math.max(a, m.id), 0);
    if (upTo <= cc.lastReadId) return;
    try {
      const j = (await request(`/api/projects/${pid}/chat/read`, { method: "POST", body: JSON.stringify({ id: upTo }) })) as { lastReadId: number; unread: number };
      if (chat().projectId === pid) setChat({ lastReadId: j.lastReadId, unread: watching() ? 0 : j.unread });
    } catch { /* tried again with the next message */ }
  }, 400);
}
let wasOpen = false, hooked = false;
/** Hooks into the editor, made on the first load (not at import: chat.ts is imported while the editor's modules
 *  are still being set up, and the selection hooks do not exist yet). */
function hookOnce(): void {
  if (hooked) return; hooked = true;
  document.addEventListener("visibilitychange", () => maybeMarkRead());
  store.subscribe((s) => { const open = !!s.panes.chat; if (open && !wasOpen) setTimeout(maybeMarkRead, 0); wasOpen = open; });
  selectionHooks.push(() => { if (attach) refreshLink(); });
}

export function openChat(): void {
  const show = (E.hooks as Record<string, ((n: string, s?: unknown) => void) | undefined>).showPane;
  if (show) show("chat", true);
  setTimeout(() => { const ta = document.getElementById("chatText") as HTMLTextAreaElement | null; if (ta) ta.focus(); maybeMarkRead(); }, 30);
}

// ---------------------------------------------------------------- links
const IU = (): number => E.IU as number;
const docPath = (id: string): string => ((state.docs || []).find((d) => d.docId === id) || { path: "" }).path;

const refOf = (id: string): string => { const it = E.kdoc ? (E.kdoc as KDoc).items.get(id) : null; return (it && (it.ref || it.name)) || "Part"; };
const nm = (v: number): number => Math.round(v * IU());
/** A pad's number from the board module's pad key ("<footprint>#<index among its pads>"). */
function padNumber(fpId: string, index: number): string {
  const it = E.kdoc ? (E.kdoc as KDoc).items.get(fpId) : null; if (!it) return String(index + 1);
  const pads = (it.node as unknown as unknown[]).filter((c) => Array.isArray(c) && c[0] === "pad") as unknown[][];
  const p = pads[index]; return p ? KiCadCanvas.str(p[1] as SNode) : String(index + 1);
}

/** Everything selected now, as link tokens: item uuids, a pad, pins, a field (the forms ChatLink.sel names). */
function selectionTokens(): string[] {
  const out: string[] = [...selectionIds()];
  const ps = !E.kdoc || (E.kdoc as KDoc).type !== "pcb" ? null : (CollabTools.pcb && CollabTools.pcb.state as unknown as { padSel?: string | null });
  if (ps && ps.padSel) out.push(ps.padSel);
  for (const p of (E.selPins || []) as { id: string; number: string }[]) out.push(`pin:${p.id}#${p.number}`);
  if (E.selField) out.push(`field:${E.selField.id}#${E.selField.name}`);
  return out;
}

/** What the composer would link right now: exactly the selection (a part, a pin, a pad, a field, a track or wire
 *  by its net, several things), else the middle of the view. */
export function currentLink(): ChatLink | null {
  const did = state.docId; if (!did || did.startsWith("board:") || did.startsWith("lib:") || !E.kdoc) return null;
  const d = E.kdoc as KDoc, base = { docId: did, path: docPath(did) };
  const sel = selectionTokens();
  const box = selectionBoxNm(sel);
  const cx = box ? (box[0] + box[2]) / 2 : 0, cy = box ? (box[1] + box[3]) / 2 : 0;
  if (sel.length) {
    const more = sel.length > 1 ? ` +${sel.length - 1}` : "";
    const t = sel[0];
    if (t.startsWith("pin:")) { const [id, num] = t.slice(4).split("#"); return { ...base, kind: "pin", id: t, label: `${refOf(id)} pin ${num}${more}`, x: cx, y: cy, sel, bbox: box }; }
    if (t.startsWith("field:")) { const i = t.indexOf("#"); return { ...base, kind: "field", id: t, label: `${refOf(t.slice(6, i))} ${t.slice(i + 1)}${more}`, x: cx, y: cy, sel, bbox: box }; }
    if (!d.items.has(t) && t.includes("#")) { const i = t.lastIndexOf("#"); return { ...base, kind: "pad", id: t, label: `${refOf(t.slice(0, i))} pad ${padNumber(t.slice(0, i), Number(t.slice(i + 1)))}${more}`, x: cx, y: cy, sel, bbox: box }; }
    const it = d.items.get(t);
    if (it) {
      const b = it.bbox, mx = b ? (b[0] + b[2]) / 2 : 0, my = b ? (b[1] + b[3]) / 2 : 0;
      // one wire, track or label: its net says more than "Wire" (and the reader lights the whole net)
      if (!it.ref && sel.length === 1) {
        const net = netOfItem(it, [mx, my]);
        if (net && net.name) return { ...base, kind: "net", id: net.name, label: net.name, item: it.id, x: cx, y: cy, sel, bbox: box };
      }
      return { ...base, kind: "item", id: it.id, label: describe(it) + more, x: cx, y: cy, sel, bbox: box };
    }
  }
  const v = visibleRectNm(); if (!v) return null;
  return { ...base, kind: "spot", id: "", label: "", x: Math.round(v[0] + v[2] / 2), y: Math.round(v[1] + v[3] / 2) };
}
/** The box (nm) round the selection as this editor draws it (selG holds the halos of items, pads, pins and fields). */
function selectionBoxNm(sel: string[]): number[] | null {
  if (!sel.length) return null;
  const b = haloBoxMm();
  if (b) return b.map((v) => nm(v));
  const d = E.kdoc as KDoc; let out: number[] | null = null;
  for (const t of sel) { const it = d.items.get(t.replace(/^(pin|field):/, "").split("#")[0]); const q = it && it.bbox; if (!q) continue; out = out ? [Math.min(out[0], q[0]), Math.min(out[1], q[1]), Math.max(out[2], q[2]), Math.max(out[3], q[3])] : [q[0], q[1], q[2], q[3]]; }
  return out ? out.map((v) => nm(v)) : null;
}
function haloBoxMm(): number[] | null {
  const g = document.getElementById("selG") as unknown as SVGGraphicsElement | null;
  if (!g || !g.childNodes.length) return null;
  try { const r = g.getBBox(); return r.width > 0 || r.height > 0 ? [r.x, r.y, r.x + r.width, r.y + r.height] : null; } catch { return null; }
}
function refreshLink(): void { const next = attach ? currentLink() : null; if (JSON.stringify(next) !== JSON.stringify(chat().link)) setChat({ link: next }); }

export function linkText(l: ChatLink): string {
  const where = l.kind === "net" ? `Net ${l.label || l.id}` : l.kind === "spot" ? "A spot" : l.label || "Item";
  const file = (l.path || docPath(l.docId) || "").split("/").pop() || "";
  return file ? `${where} · ${file}` : where;
}

/** Bring a link into view: open its document if it is another, then select the part, light up the net, or centre the spot. */
export function gotoLink(l: ChatLink): void {
  if (l.docId !== state.docId) {
    if (!(state.docs || []).some((d) => d.docId === l.docId)) { toast("That document is no longer in the project"); return; }
    const app = window.CollabApp; if (app) app.dispatch({ type: "openDoc", docId: l.docId });
    // the document arrives over the network: wait for it (at most 20 s)
    const t0 = Date.now();
    const wait = setInterval(() => {
      if (Date.now() - t0 > 20000) { clearInterval(wait); return; }
      if (state.docId === l.docId && E.kdoc && (E.kdoc as KDoc).items.size) { clearInterval(wait); setTimeout(() => gotoHere(l), 60); }
    }, 120);
    return;
  }
  gotoHere(l);
}
/** Select what the writer had selected, light the net, centre it, and flash an outline round it. */
function gotoHere(l: ChatLink): void {
  const d = E.kdoc as KDoc | null; if (!d) return;
  // older messages carry no selection: their one item
  const sel = l.sel && l.sel.length ? l.sel : l.kind === "item" ? [l.id] : l.kind === "net" && l.item ? [l.item] : [];
  clearAllSelection(false);
  let found = 0;
  const pins: { id: string; number: string }[] = [];
  for (const t of sel) {
    if (t.startsWith("pin:")) { const [id, num] = t.slice(4).split("#"); if (d.items.has(id)) { pins.push({ id, number: num }); found++; } continue; }
    if (t.startsWith("field:")) { const i = t.indexOf("#"), id = t.slice(6, i); if (d.items.has(id)) { E.selField = { id, name: t.slice(i + 1) }; found++; } continue; }
    if (!d.items.has(t) && t.includes("#")) {   // a pad
      const fp = t.slice(0, t.lastIndexOf("#")), ps = CollabTools.pcb && (CollabTools.pcb.state as unknown as { padSel?: string | null });
      if (d.items.has(fp) && ps) { ps.padSel = t; found++; }
      continue;
    }
    if (d.items.has(t)) { applyPickMode(t, "add"); found++; }
  }
  if (pins.length) E.selPins = pins;
  selectionChanged();
  let lit = 0, netBox: number[] | null = null;
  if (l.kind === "net") {
    // an unnamed net (Net-(C6)) has no label to find it by: go through the item it was picked from
    const from = l.item ? d.items.get(l.item) : null;
    const viaItem = from ? netOfItem(from, from.bbox ? [(from.bbox[0] + from.bbox[2]) / 2, (from.bbox[1] + from.bbox[3]) / 2] : undefined) : null;
    const ids = viaItem && viaItem.ids.length ? viaItem.ids : netIds({ kind: "net", id: l.id, label: l.label, item: l.item || null });
    if (ids.length) { E.highlightIds = new Set(ids); lit = ids.length; requestRender(); netBox = unionBox(ids); }
  }
  if (sel.length && !found && !lit) toast(`${l.label || "That"} is no longer here; showing where it was`);
  else if (!sel.length && l.kind === "net" && !lit) toast(`Net ${l.label || l.id} is not on this document`);
  // the outline: what this editor now draws as the selection, else the box the writer saw, else the spot
  const halo = found ? haloBoxMm() : null;
  const wb = l.bbox && l.bbox.length === 4 ? l.bbox.map((v) => v / IU()) : null;
  const box = netBox || halo || wb;
  const x = box ? (box[0] + box[2]) / 2 : l.x / IU(), y = box ? (box[1] + box[3]) / 2 : l.y / IU();
  centerOn(x, y);
  // close enough to see it: a pin or a pad seen from a whole sheet is a few pixels (never zooms out)
  if (box) {
    const ppm = pxPerMm(), w = Math.max((box[2] - box[0]) * ppm, 1), h = Math.max((box[3] - box[1]) * ppm, 1);
    // …but not closer than about 30 mm across the stage: what is round it is part of the answer
    const minView = 30 * ppm / stage.clientWidth;   // zoom factor at which the stage spans 30 mm
    const f = Math.min(8, 1 / Math.max(minView, 1e-6), (stage.clientWidth * 0.3) / w, (stage.clientHeight * 0.3) / h);
    if (f > 1.15) zoomBy(f);
  }
  flash(box, [x, y], l);
}

function unionBox(ids: Iterable<string>): number[] | null {
  const d = E.kdoc as KDoc; let out: number[] | null = null;
  for (const id of ids) { const q = d.items.get(id)?.bbox; if (!q) continue; out = out ? [Math.min(out[0], q[0]), Math.min(out[1], q[1]), Math.max(out[2], q[2]), Math.max(out[3], q[3])] : [q[0], q[1], q[2], q[3]]; }
  return out;
}

let flashTimer: ReturnType<typeof setTimeout> | 0 = 0;
/** A pulsing outline (or a ring, for a spot) with the link's name, for a few seconds, so the eye lands on it. */
function flash(box: number[] | null, at: [number, number], l: ChatLink): void {
  const host = (document.getElementById("selG") as SVGGElement | null)?.parentNode as SVGElement | null; if (!host) return;
  let g = document.getElementById("chatFlash") as SVGGElement | null;
  if (!g) { g = document.createElementNS("http://www.w3.org/2000/svg", "g") as SVGGElement; g.id = "chatFlash"; host.appendChild(g); }
  g.replaceChildren();
  const px = 1 / pxPerMm(), ns = "http://www.w3.org/2000/svg";
  const shape = box && (box[2] - box[0] > 0.05 || box[3] - box[1] > 0.05)
    ? (() => { const pad = 6 * px, r = document.createElementNS(ns, "rect");
        r.setAttribute("x", String(box[0] - pad)); r.setAttribute("y", String(box[1] - pad)); r.setAttribute("width", String(box[2] - box[0] + 2 * pad)); r.setAttribute("height", String(box[3] - box[1] + 2 * pad)); r.setAttribute("rx", String(4 * px)); return r; })()
    : (() => { const c = document.createElementNS(ns, "circle"); c.setAttribute("cx", String(at[0])); c.setAttribute("cy", String(at[1])); c.setAttribute("r", String(18 * px)); return c; })();
  shape.setAttribute("class", "chat-flash"); shape.setAttribute("stroke-width", String(2.5 * px));
  g.appendChild(shape);
  const label = document.createElementNS(ns, "text"), top = box ? box[1] - 6 * px : at[1] - 18 * px;
  label.setAttribute("x", String(box ? box[0] - 6 * px : at[0] - 18 * px)); label.setAttribute("y", String(top - 5 * px));
  label.setAttribute("font-size", String(12 * px)); label.setAttribute("class", "chat-flash-label");
  label.textContent = l.kind === "spot" ? "here" : l.kind === "net" ? `Net ${l.label || l.id}` : l.label;
  g.appendChild(label);
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashTimer = 0; g!.replaceChildren(); }, 4500);
}

// ---------------------------------------------------------------- sending
async function send(body: string, link: ChatLink | null): Promise<boolean> {
  const c = chat(), pid = c.projectId, u = me(); if (!pid) return false;
  const text = body.trim(); if (!text) return false;
  if (!E.canComment || !u) { toast(u ? "You can view this project but not write in its chat" : "Sign in to chat"); return false; }
  // shown at once, greyed, until the server has it
  const temp: ChatMessage = { id: -(++pendingId), projectId: pid, authorId: u.id, authorLogin: u.login, authorName: u.name, authorAvatar: u.avatarUrl, body: text, link, createdAt: new Date().toISOString(), pending: true };
  setChat({ messages: [...c.messages, temp] });
  try {
    const made = (await request(`/api/projects/${pid}/chat`, { method: "POST", body: JSON.stringify({ body: text, link: link || undefined }) })) as ChatMessage;
    if (chat().projectId !== pid) return true;
    const list = chat().messages.filter((m) => m.id !== temp.id && m.id !== made.id);
    setChat({ messages: [...list, made].sort((a, b) => (a.id < 0 ? Infinity : a.id) - (b.id < 0 ? Infinity : b.id)), lastReadId: Math.max(chat().lastReadId, made.id) });
    return true;
  } catch (e) {
    setChat({ messages: chat().messages.filter((m) => m.id !== temp.id) });
    toast("The message was not sent: " + String((e as Error).message || e).replace(/^\d+ /, "").slice(0, 120));
    return false;
  }
}

export function chatAction(a: { cmd: string; body?: string; id?: number; link?: ChatLink; on?: boolean }): void {
  switch (a.cmd) {
    case "send": { const link = attach ? currentLink() : null; void send(a.body || "", link).then((ok) => { if (ok && attach) { attach = false; setChat({ link: null }); } }); return; }
    case "edit": void editMessage(a.id!, a.body || ""); return;
    case "delete": void deleteMessage(a.id!); return;
    case "goto": if (a.link) gotoLink(a.link); return;
    case "read": maybeMarkRead(); return;
    case "older": void loadOlder(); return;
    case "attach": attach = !!a.on; refreshLink(); if (attach && !chat().link) toast("Open a document to link a place in it"); return;
  }
}

async function editMessage(id: number, body: string): Promise<void> {
  const text = body.trim(); if (!text) return;
  try {
    const m = (await request(`/api/chat/${id}`, { method: "PATCH", body: JSON.stringify({ body: text }) })) as ChatMessage;
    setChat({ messages: chat().messages.map((x) => (x.id === id ? m : x)) });
  } catch { toast("The message could not be changed"); }
}
async function deleteMessage(id: number): Promise<void> {
  try {
    await request(`/api/chat/${id}`, { method: "DELETE" });
    setChat({ messages: chat().messages.filter((x) => x.id !== id) });
  } catch { toast("The message could not be deleted"); }
}

// ---------------------------------------------------------------- cursor chat
let bubble: HTMLDivElement | null = null;
let sayClear: ReturnType<typeof setTimeout> | 0 = 0;

function setSay(text: string | null): void {
  E.chatSay = text ? text.slice(0, 200) : null;
  E.lastPresence = 0;   // goes out now, not after the pointer's next move
  sendPresence(null);
}

/** Open the cursor-chat bubble at the pointer (Alt+M). */
export function startCursorChat(): boolean {
  if (state.view !== "editor" || !state.docId || !E.kdoc) return false;
  if (!E.canComment || !me()) { toast(me() ? "You can view this project but not write in its chat" : "Sign in to chat"); return true; }
  closeCursorChat(false);
  if (sayClear) { clearTimeout(sayClear); sayClear = 0; }
  const mm = (E.lastCursorMm || [0, 0]) as [number, number];
  const at = screenOf(mm);
  const box = document.createElement("div"); box.className = "cursor-chat"; box.id = "cursorChat";
  const input = document.createElement("input"); input.type = "text"; input.maxLength = 200; input.placeholder = "Say something"; input.setAttribute("aria-label", "Say something at your cursor");
  const hint = document.createElement("span"); hint.className = "hint"; hint.textContent = "Enter sends to Chat · Esc";
  box.appendChild(input); box.appendChild(hint);
  box.style.left = Math.round(at[0] + 14) + "px"; box.style.top = Math.round(at[1] + 16) + "px";
  stage.appendChild(box); bubble = box;
  input.addEventListener("input", () => setSay(input.value.trim() || null));
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") { ev.preventDefault(); closeCursorChat(true); }
    else if (ev.key === "Enter") {
      ev.preventDefault();
      const text = input.value.trim(); if (!text) { closeCursorChat(true); return; }
      const did = state.docId!;
      void send(text, { docId: did, path: docPath(did), kind: "spot", id: "", label: "", x: Math.round(mm[0] * IU()), y: Math.round(mm[1] * IU()) });
      closeCursorChat(false);
      // what was said stays beside the pointer for a few seconds, as in Figma
      sayClear = setTimeout(() => { sayClear = 0; setSay(null); }, 5000);
    }
  });
  input.addEventListener("blur", () => setTimeout(() => { if (bubble === box) closeCursorChat(true); }, 0));
  input.focus();   // now, not on the next tick: the first key typed after Alt+M must land in the bubble
  return true;
}
function closeCursorChat(clearSay: boolean): void {
  if (bubble) { const b = bubble; bubble = null; b.remove(); }
  if (clearSay && E.chatSay) setSay(null);
}
function screenOf(mm: [number, number]): [number, number] {
  // invert worldMm: the stage pixel under a world point
  const sr = stage.getBoundingClientRect();
  const probe = (px: number, py: number) => worldMm({ clientX: sr.left + px, clientY: sr.top + py });
  const o = probe(0, 0), u = probe(100, 100);
  const sx = (u[0] - o[0]) / 100 || 1, sy = (u[1] - o[1]) / 100 || 1;
  const x = (mm[0] - o[0]) / sx, y = (mm[1] - o[1]) / sy;
  return [Math.max(4, Math.min(sr.width - 240, x)), Math.max(4, Math.min(sr.height - 40, y))];
}
/** Leaving the document ends whatever was being said. */
export function leaveCursorChat(): void { closeCursorChat(false); if (sayClear) { clearTimeout(sayClear); sayClear = 0; } E.chatSay = null; }
