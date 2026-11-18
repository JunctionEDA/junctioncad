// comments.ts — the review threads of a 3D document, pinned to its geometry.
//
// These are the platform's comments (server/src/http.rs: /api/docs/{id}/comments, /api/comments/{id}), the
// same threads the electronics editor has: a root comment with replies, resolved or open, and news of every
// change on the document's socket.  What is new is only what a thread is pinned to: a feature, a face, an edge
// or a vertex, written into the anchor the platform already stores (anchor.ts).
//
// The store keeps the threads of one document, the thread that is open, and the comment being written.  Where
// a pin is in space is worked out by `pinPoint` from the meshes on screen, so a pin follows its face through
// rebuilds; when the face is gone the pin stays where the thread was started.
import type { ItemDocSession } from "../../../shared/itemdoc/sync";
import type { BodyMesh } from "../kernel/protocol";
import { anchorFor, packPoint3, targetOf, unpackPoint3, type CommentTarget, type PlatformAnchor } from "./anchor";
import type { V3 } from "./presence";

export interface PlatformComment {
  id: number; docId: string; parentId: number | null; authorId: number; authorLogin: string;
  x: number; y: number; body: string; resolved: boolean; createdAt: string; editedAt?: string | null;
  anchor: PlatformAnchor | null;
}

export interface Composing { target: CommentTarget; point: V3 | null; label: string; createdBy: string | null }

export interface CommentsState {
  loaded: boolean;
  comments: PlatformComment[];
  /** the thread that is open (a root comment's id) */
  open: number | null;
  composing: Composing | null;
  /** the comment tool is waiting for a click on the model */
  picking: boolean;
  error: string | null;
  busy: boolean;
}

async function call(path: string, method: string, body?: unknown): Promise<unknown> {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) {
    let text = "";
    try { const j = await r.clone().json(); text = j.message || j.error || ""; } catch (e) { text = await r.text().catch(() => ""); }
    throw new Error(text || (r.status === 401 ? "Sign in to comment." : r.status === 403 ? "You can view this project but not comment on it." : `The server said ${r.status}.`));
  }
  return r.json();
}

export class CommentStore {
  private state: CommentsState = { loaded: false, comments: [], open: null, composing: null, picking: false, error: null, busy: false };
  private listeners = new Set<() => void>();
  private off: () => void;

  constructor(private readonly docId: string, session: ItemDocSession) {
    const tap = (msg: Record<string, unknown>) => {
      if (msg.type === "comment") this.onEvent(msg.comment as { action?: string; comment?: PlatformComment });
      // after a reconnect, anything that happened meanwhile was not announced
      else if (msg.type === "doc_info" && this.state.loaded) void this.load();
    };
    session.taps.add(tap);
    this.off = () => session.taps.delete(tap);
    void this.load();
  }

  getState = (): CommentsState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<CommentsState>): void { this.state = { ...this.state, ...patch }; for (const fn of Array.from(this.listeners)) fn(); }
  dispose(): void { this.off(); this.listeners.clear(); }

  async load(): Promise<void> {
    try {
      const got = (await call(`/api/docs/${this.docId}/comments`, "GET")) as { comments: PlatformComment[] };
      this.set({ loaded: true, comments: got.comments || [], error: null });
    } catch (e) { this.set({ loaded: true, error: (e as Error).message }); }
  }

  private onEvent(ev: { action?: string; comment?: PlatformComment } | undefined): void {
    const c = ev && ev.comment; if (!c || typeof c.id !== "number") return;
    if (ev!.action === "deleted") {
      this.set({ comments: this.state.comments.filter((x) => x.id !== c.id && x.parentId !== c.id), open: this.state.open === c.id ? null : this.state.open });
      return;
    }
    const at = this.state.comments.findIndex((x) => x.id === c.id);
    const comments = this.state.comments.slice();
    if (at >= 0) comments[at] = c; else comments.push(c);
    comments.sort((a, b) => a.id - b.id);
    this.set({ comments });
  }

  private async run(what: () => Promise<void>): Promise<boolean> {
    this.set({ busy: true, error: null });
    try { await what(); this.set({ busy: false }); return true; }
    catch (e) { this.set({ busy: false, error: (e as Error).message }); return false; }
  }

  // ---------------------------------------------------------------- writing
  /** Start a comment on something (the composer opens at it). */
  compose(c: Composing | null): void { this.set({ composing: c, picking: false, error: null }); }
  setPicking(on: boolean): void { this.set({ picking: on, composing: on ? null : this.state.composing }); }
  openThread(id: number | null): void { this.set({ open: id }); }

  /** Post the comment being written. */
  post(body: string): Promise<boolean> {
    const c = this.state.composing; if (!c) return Promise.resolve(false);
    const anchor = anchorFor(c.target, c.label, c.createdBy);
    const { x, y } = packPoint3(c.point);
    return this.run(async () => {
      const made = (await call(`/api/docs/${this.docId}/comments`, "POST", { body, x, y, anchor })) as PlatformComment;
      this.onEvent({ action: "added", comment: made });
      this.set({ composing: null, open: made.id });
    });
  }
  reply(threadId: number, body: string): Promise<boolean> {
    return this.run(async () => { this.onEvent({ action: "added", comment: (await call(`/api/docs/${this.docId}/comments`, "POST", { body, parentId: threadId })) as PlatformComment }); });
  }
  resolve(id: number, resolved: boolean): Promise<boolean> {
    return this.run(async () => { this.onEvent({ action: "updated", comment: (await call(`/api/comments/${id}`, "PATCH", { resolved })) as PlatformComment }); });
  }
  remove(id: number): Promise<boolean> {
    return this.run(async () => { await call(`/api/comments/${id}`, "DELETE"); this.onEvent({ action: "deleted", comment: { id } as PlatformComment }); });
  }
}

// ---------------------------------------------------------------- where a pin is
/** The middle of a face (area-weighted), an edge (by length) or a vertex of a mesh; null when the name is gone. */
export function geometryPoint(mesh: BodyMesh, kind: "face" | "edge" | "vertex", name: string): V3 | null {
  if (kind === "vertex") {
    const i = mesh.vertices.names.indexOf(name); if (i < 0) return null;
    return [mesh.vertices.positions[i * 3], mesh.vertices.positions[i * 3 + 1], mesh.vertices.positions[i * 3 + 2]];
  }
  if (kind === "edge") {
    const i = mesh.edges.names.indexOf(name); if (i < 0) return null;
    const p = mesh.edges.positions, from = mesh.edges.start[i], n = mesh.edges.count[i];
    let total = 0;
    const len: number[] = [];
    for (let k = 0; k + 1 < n; k += 2) { const a = (from + k) * 3, b = a + 3; const l = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]); len.push(l); total += l; }
    if (!len.length) return null;
    let half = total / 2;
    for (let s = 0; s < len.length; s++) {
      const a = (from + s * 2) * 3, b = a + 3;
      if (half <= len[s] || s === len.length - 1) { const t = len[s] ? Math.min(1, half / len[s]) : 0; return [p[a] + (p[b] - p[a]) * t, p[a + 1] + (p[b + 1] - p[a + 1]) * t, p[a + 2] + (p[b + 2] - p[a + 2]) * t]; }
      half -= len[s];
    }
    return null;
  }
  const i = mesh.faces.names.indexOf(name); if (i < 0) return null;
  const pos = mesh.positions, idx = mesh.indices;
  let area = 0, cx = 0, cy = 0, cz = 0, best = -1, bx = 0, by = 0, bz = 0;
  for (let k = mesh.faces.start[i]; k + 2 < mesh.faces.start[i] + mesh.faces.count[i]; k += 3) {
    const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const w = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    const mx = (pos[a] + pos[b] + pos[c]) / 3, my = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, mz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
    area += w; cx += mx * w; cy += my * w; cz += mz * w;
    if (w > best) { best = w; bx = mx; by = my; bz = mz; }
  }
  if (best < 0) return null;
  if (!(area > 0)) return [bx, by, bz];
  // the centroid of a face with a hole, or a bent one, may lie off the face: then the middle of its largest triangle is a point on it
  const c: V3 = [cx / area, cy / area, cz / area];
  return onFace(mesh, i, c) ? c : [bx, by, bz];
}

/** Is a point (already in the face's plane, or near it) inside one of the face's triangles? */
function onFace(mesh: BodyMesh, face: number, p: V3): boolean {
  const pos = mesh.positions, idx = mesh.indices;
  for (let k = mesh.faces.start[face]; k + 2 < mesh.faces.start[face] + mesh.faces.count[face]; k += 3) {
    const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
    const v0 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]], v1 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]], v2 = [p[0] - pos[a], p[1] - pos[a + 1], p[2] - pos[a + 2]];
    const d00 = v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2], d01 = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2], d11 = v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2];
    const d20 = v2[0] * v0[0] + v2[1] * v0[1] + v2[2] * v0[2], d21 = v2[0] * v1[0] + v2[1] * v1[1] + v2[2] * v1[2];
    const den = d00 * d11 - d01 * d01; if (Math.abs(den) < 1e-12) continue;
    const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
    if (v < -1e-6 || w < -1e-6 || v + w > 1 + 1e-6) continue;
    // and not far off the triangle's plane
    const off = [v2[0] - v * v0[0] - w * v1[0], v2[1] - v * v0[1] - w * v1[1], v2[2] - v * v0[2] - w * v1[2]];
    if (Math.hypot(off[0], off[1], off[2]) < 1e-3 * (1 + Math.sqrt(Math.max(d00, d11)))) return true;
  }
  return false;
}

export interface PinSources {
  mesh(bodyId: string): BodyMesh | null;
  /** every body on screen: a body merged into another keeps its faces' names there */
  meshes(): BodyMesh[];
  /** the bodies a feature made, for a thread on a feature that was started without a point */
  bodiesOf(featureId: string): BodyMesh[];
  hasFeature(featureId: string): boolean;
}

export interface Pin { point: V3; /** the geometry or feature the thread names is not there any more */ lost: boolean }

/** Where a thread's pin is drawn, or null when it has no place in the viewport. */
export function pinPoint(c: PlatformComment, src: PinSources): Pin | null {
  const target = targetOf(c.anchor), started = unpackPoint3(c.x, c.y);
  if (!target) return started ? { point: started, lost: false } : null;
  if (target.kind === "feature") {
    const there = src.hasFeature(target.featureId);
    if (started) return { point: started, lost: !there };
    if (!there) return null;
    const boxes = src.bodiesOf(target.featureId).map((m) => m.bbox);
    if (!boxes.length) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const b of boxes) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b[k]); hi[k] = Math.max(hi[k], b[k + 3]); }
    return { point: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2]], lost: false };
  }
  const own = src.mesh(target.body);
  for (const mesh of own ? [own, ...src.meshes().filter((m) => m !== own)] : src.meshes()) {
    const p = geometryPoint(mesh, target.kind, target.name);
    if (p) return { point: p, lost: false };
  }
  return started ? { point: started, lost: true } : null;
}
