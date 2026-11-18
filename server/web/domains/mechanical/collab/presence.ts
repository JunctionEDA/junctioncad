// presence.ts — what one person tells the others about where they are in a 3D document, and how the list of
// people in the document is read from the session's peers.  Pure: no DOM, no three.js.
//
// The state travels on the collaboration socket's presence lane (ItemDocSession.setPresence); the server keeps
// the newest one per client, hands it to whoever joins, and forgets it after 30 s of silence.  It is never
// stored.  A state is small and flat on purpose: the server refuses one over 8 KB.
//
//   cad   1: this is a person looking at the document (a project room's watcher, platform/doctabs/room.ts,
//         sends `room` instead and is not "here")
//   key   the person's window, the same on every tab of it (the room's client id): what Follow follows
//   col   the colour the person has on every tab (the room's), so a cursor and a tab dot agree
//   cam   the camera: orientation, the point it looks at, zoom, width / height
//   cur   the pointer: the model-space point under it, and whether that point is on the model
//   sel   what is selected in the viewport
//   feat  the row selected in the list (a feature, an instance)
//   edit  what is open for editing: a feature's dialog or a sketch
//   fol   whose view this person is following
import type { Json } from "../../../shared/itemdoc/itemdoc";
import type { SessionPeer } from "../../../shared/itemdoc/sync";

export type V3 = [number, number, number];
export interface CamState { q: [number, number, number, number]; t: V3; z: number; a: number }
export interface CursorState { p: V3; hit: boolean }
/** A selected thing, short: ["f" | "e" | "v", body, name], ["p", plane], ["s", sketch feature, entity, region]. */
export type SelRef = ["f" | "e" | "v", string, string] | ["p", string] | ["s", string, string, string];
export interface EditState { id: string; kind: "dialog" | "sketch"; isNew?: boolean; name?: string }

export interface CadPresence {
  cad: 1;
  key?: string;
  col?: string;
  cam?: CamState;
  cur?: CursorState | null;
  sel?: SelRef[];
  feat?: string | null;
  edit?: EditState | null;
  fol?: string | null;
  ts?: number;
}

/** Somebody else who has this document open. */
export interface Collaborator {
  /** the session's client id: unique per socket */
  cid: string;
  /** what Follow follows: the person's window (the same on every tab), or the client id when it says none */
  key: string;
  userId: number;
  login: string;
  name: string;
  color: string;
  state: CadPresence;
}

const round = (n: number, d: number): number => { const k = Math.pow(10, d); return Math.round(n * k) / k; };
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const v3 = (v: unknown): V3 | null => (Array.isArray(v) && v.length === 3 && v.every(num) ? [v[0], v[1], v[2]] : null);

/** A camera as it is sent: five decimals of rotation, micrometres of position. */
export function packCam(q: ArrayLike<number>, t: ArrayLike<number>, zoom: number, aspect: number): CamState {
  return { q: [round(q[0], 5), round(q[1], 5), round(q[2], 5), round(q[3], 5)], t: [round(t[0], 3), round(t[1], 3), round(t[2], 3)], z: round(zoom, 5), a: round(aspect, 4) };
}
export const packPoint = (p: ArrayLike<number>): V3 => [round(p[0], 3), round(p[1], 3), round(p[2], 3)];

export function sameCam(a: CamState | undefined | null, b: CamState | undefined | null): boolean {
  if (!a || !b) return a === b;
  return a.z === b.z && a.a === b.a && a.q.every((x, i) => x === b.q[i]) && a.t.every((x, i) => x === b.t[i]);
}

/** Read a presence state somebody sent.  Null when it is not a person in a 3D document; bad parts are dropped. */
export function parsePresence(raw: Json | undefined): CadPresence | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.cad !== 1) return null;
  const out: CadPresence = { cad: 1 };
  if (typeof raw.key === "string" && raw.key.length <= 80) out.key = raw.key;
  if (typeof raw.col === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw.col)) out.col = raw.col;
  const cam = raw.cam as { q?: unknown; t?: unknown; z?: unknown; a?: unknown } | undefined;
  if (cam && typeof cam === "object" && Array.isArray(cam.q) && cam.q.length === 4 && cam.q.every(num) && v3(cam.t) && num(cam.z) && cam.z > 0 && num(cam.a) && cam.a > 0) {
    out.cam = { q: [cam.q[0], cam.q[1], cam.q[2], cam.q[3]], t: v3(cam.t)!, z: cam.z, a: cam.a };
  }
  const cur = raw.cur as { p?: unknown; hit?: unknown } | null | undefined;
  if (cur && typeof cur === "object" && v3(cur.p)) out.cur = { p: v3(cur.p)!, hit: !!cur.hit };
  if (Array.isArray(raw.sel)) {
    out.sel = [];
    for (const s of raw.sel) {
      if (!Array.isArray(s) || !s.every((x) => typeof x === "string")) continue;
      const k = s[0];
      if ((k === "f" || k === "e" || k === "v") && s.length === 3) out.sel.push([k, s[1] as string, s[2] as string]);
      else if (k === "p" && s.length === 2) out.sel.push(["p", s[1] as string]);
      else if (k === "s" && s.length === 4) out.sel.push(["s", s[1] as string, s[2] as string, s[3] as string]);
    }
  }
  if (typeof raw.feat === "string") out.feat = raw.feat;
  const e = raw.edit as { id?: unknown; kind?: unknown; isNew?: unknown; name?: unknown } | null | undefined;
  if (e && typeof e === "object" && typeof e.id === "string" && (e.kind === "dialog" || e.kind === "sketch")) {
    out.edit = { id: e.id, kind: e.kind, ...(e.isNew ? { isNew: true } : {}), ...(typeof e.name === "string" ? { name: e.name.slice(0, 80) } : {}) };
  }
  if (typeof raw.fol === "string") out.fol = raw.fol;
  if (num(raw.ts)) out.ts = raw.ts;
  return out;
}

/** The server refuses a state over 8 KB (ws.rs MAX_PRESENCE_BYTES); stay well under it. */
export const PRESENCE_LIMIT = 7000;
/** How many selected things are sent at most. */
export const MAX_SEL = 40;

/** Cut a state down until it fits: the selection goes first (the longest names first), never the camera. */
export function fitPresence(st: CadPresence): CadPresence {
  let out: CadPresence = st.sel && st.sel.length > MAX_SEL ? { ...st, sel: st.sel.slice(0, MAX_SEL) } : st;
  while (JSON.stringify(out).length > PRESENCE_LIMIT && out.sel && out.sel.length) {
    out = { ...out, sel: out.sel.slice(0, Math.floor(out.sel.length / 2)) };
  }
  if (JSON.stringify(out).length > PRESENCE_LIMIT) { out = { ...out }; delete out.sel; if (out.edit) out.edit = { id: out.edit.id, kind: out.edit.kind }; }
  return out;
}

/**
 * The people in the document, from the session's peers.  A peer that has said nothing yet, a project room's
 * watcher and anything that is not a 3D editor are left out.  One person with two windows is two entries.
 */
export function collaboratorsOf(peers: readonly SessionPeer[]): Collaborator[] {
  const out: Collaborator[] = [];
  for (const p of peers) {
    const state = parsePresence(p.state);
    if (!state) continue;
    out.push({ cid: p.clientId, key: state.key || p.clientId, userId: p.userId, login: p.login, name: p.name || p.login || "Someone", color: state.col || p.color || "", state });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.cid.localeCompare(b.cid));
}

/** Up to two letters for an avatar: "Ada Lovelace" → "AL", "bob" → "B". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0][0]).toUpperCase();
}

/** Brightness 0..1 of a #rgb / #rrggbb colour (the weights the electronics editor's cursor tags use). */
export function brightness(c: string): number {
  const h = c.replace("#", ""), f = h.length === 3 ? h.split("").map((d) => d + d).join("") : h.slice(0, 6);
  const n = parseInt(f, 16); if (!Number.isFinite(n)) return 0;
  return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.117) / 255;
}

/**
 * The zoom that shows on a view of aspect `mine` everything a camera of zoom `z` and aspect `theirs` shows
 * (an orthographic view 200 mm tall at zoom 1): never closer than they are, wider when their window is.
 */
export function followZoom(z: number, theirs: number, mine: number): number { return z * Math.min(1, mine / theirs); }

/** "Ada", "Ada and Bob", "Ada, Bob and 2 others". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}
