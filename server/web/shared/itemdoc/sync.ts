// sync.ts — a live session on one JSON item document (itemdoc.ts): the document in memory, kept in step with
// the server over the collaboration socket every editor uses (server/src/ws.rs, doc_actor.rs).
//
//   const s = new ItemDocSession({ docId, signedIn, expectKind: "part-studio", onChange, onStatus });
//   s.start();                      // connects, joins, loads the stored file and the edits since
//   s.commit([change, ...]);        // applies here at once, sends, and can be undone
//   s.close();
//
// What the server gives every document, this gets: sequenced and stored ops, broadcast to everyone in the
// document, replay on join, roles (a viewer's ops are refused), presence.  The rules it follows are the web
// editor's (web/domains/pcb/editor/net.ts): an op is journalled before it is sent and replayed after a
// reconnect (the server drops a clientOpId it has seen), an op of ours that is not acknowledged yet is put back
// on top of whatever arrives before its ack, and a gap in the sequence asks for a fresh copy.  An op the server
// stored just before the connection dropped (its ack was lost) is recognised when it comes back in the catch-up,
// so it is not put on top of what others did after it.
import { applyChanges, invertChange, parseItemDoc, stableJson, type ItemChange, type ItemDoc, type Json } from "./itemdoc";

export type SessionState = "connecting" | "live" | "offline" | "error";
export interface SessionStatus { state: SessionState; text: string; role: string | null; canEdit: boolean }
export interface SessionPeer { clientId: string; userId: number; login: string; name?: string | null; color: string; state?: Json }
export type ChangeOrigin = "load" | "local" | "remote" | "undo";

/**
 * A project room's watcher (web/platform/doctabs/room.ts) joins a document only to hear who is in the project;
 * it is not somebody in the document, and a session leaves it out of its peers.  It is known by its client id.
 */
export const isRoomWatcher = (clientId: string): boolean => /(^|:)room-[a-z0-9]+$/.test(clientId);

export interface SessionOptions {
  docId: string;
  /** false for a guest: no ticket is asked for and the server lets them watch what they may read */
  signedIn: boolean;
  /** the `junction` kind the file must have */
  expectKind?: string;
  /** The document changed.  `ids` is null when the whole document was (re)loaded. */
  onChange(ids: Set<string> | null, origin: ChangeOrigin): void;
  onStatus?(status: SessionStatus): void;
  onPeers?(peers: SessionPeer[]): void;
  /** somebody (or the server) said something a person should read */
  onNotice?(text: string): void;
  /** test seams */
  socketUrl?: string; fetchTicket?: () => Promise<string>; WebSocketImpl?: typeof WebSocket;
}

interface Pending { clientOpId: string; changes: ItemChange[] }
interface UndoEntry { undo: ItemChange[]; redo: ItemChange[] }

export class ItemDocSession {
  doc: ItemDoc | null = null;
  status: SessionStatus = { state: "connecting", text: "connecting…", role: null, canEdit: false };
  clientId = "";
  private ws: WebSocket | null = null;
  private gen = 0;
  private retries = 0;
  private joined = false;
  private lastSeq = 0;
  private opN = 0;
  private pending: Pending[] = [];
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private peers = new Map<string, SessionPeer>();
  private resyncAt = 0;
  /** a fresh copy was asked for because an op of ours turned out to be older than what we hold (see "ack") */
  private refetching = false;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Listeners that are shown every message the server sends for this document, before the session handles it
   * (so `doc` is still as it was), and this session's own edits as `{ type: "local_op", changes, origin }`
   * after they are applied.  A collaboration layer reads from here what the session itself does not keep: who
   * made an op (`author`), comment events, notices.  A listener must not change the message.
   */
  readonly taps = new Set<(msg: Record<string, unknown>) => void>();

  constructor(private readonly opts: SessionOptions) {}

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  /** edits made here that the server has not acknowledged yet */
  get unsaved(): number { return this.pending.length; }
  /** everybody else in the document now (the list `onPeers` is given) */
  peerList(): SessionPeer[] { return Array.from(this.peers.values()); }

  start(): void { this.closed = false; void this.connect(); }

  close(): void {
    this.closed = true; this.gen++;
    clearTimeout(this.retryTimer);
    if (this.ws) { this.ws.onclose = null; this.ws.onmessage = null; try { this.ws.close(); } catch (e) { /* already gone */ } this.ws = null; }
    this.joined = false; this.peers.clear();
  }

  /**
   * Make an edit: applied here at once, sent to the server, and (unless `undoable` is false) put on the undo
   * stack as one step.  Returns false when nothing changed or the session may not edit.
   */
  commit(changes: ItemChange[], o: { undoable?: boolean } = {}): boolean {
    if (!this.doc || !changes.length) return false;
    if (!this.status.canEdit) { this.opts.onNotice?.(this.status.role === "commenter" ? "You can comment here, but not edit." : "You have view-only access."); return false; }
    return this.applyLocal(changes, o.undoable === false ? "none" : "push", "local");
  }

  undo(): boolean { const e = this.undoStack.pop(); if (!e) return false; this.redoStack.push(e); return this.applyLocal(e.undo, "none", "undo"); }
  redo(): boolean { const e = this.redoStack.pop(); if (!e) return false; this.undoStack.push(e); return this.applyLocal(e.redo, "none", "undo"); }

  /** Tell the others where this person is (a selection, a camera, a feature being edited).  Not stored. */
  setPresence(state: Json): void {
    if (this.ws && this.ws.readyState === 1 && this.joined) this.ws.send(JSON.stringify({ type: "presence", docId: this.opts.docId, state }));
  }

  private applyLocal(changes: ItemChange[], undo: "push" | "none", origin: ChangeOrigin): boolean {
    const doc = this.doc!;
    const inverse: ItemChange[] = [];
    const touched = new Set<string>();
    const done: ItemChange[] = [];
    for (const c of changes) {
      const inv = invertChange(doc, c);
      if (applyChanges(doc, [c]).size) { touched.add(c.id); done.push(c); if (inv) inverse.unshift(inv); }
    }
    if (!done.length) return false;
    if (undo === "push") { this.undoStack.push({ undo: inverse, redo: done }); if (this.undoStack.length > 200) this.undoStack.shift(); this.redoStack.length = 0; }
    const op: Pending = { clientOpId: `web:${Date.now().toString(36)}:${++this.opN}`, changes: done };
    this.pending.push(op);       // journal first, send second: a dropped socket replays it
    this.send(op);
    for (const tap of Array.from(this.taps)) { try { tap({ type: "local_op", changes: done, origin }); } catch (e) { console.warn(e); } }
    this.opts.onChange(touched, origin);
    return true;
  }

  private send(op: Pending): void {
    if (this.ws && this.ws.readyState === 1 && this.joined) this.ws.send(JSON.stringify({ type: "op", docId: this.opts.docId, clientOpId: op.clientOpId, baseSeq: null, changes: op.changes }));
  }

  private setStatus(state: SessionState, text: string, role?: string | null): void {
    const r = role === undefined ? this.status.role : role;
    this.status = { state, text, role: r, canEdit: r === "editor" && this.opts.signedIn };
    this.opts.onStatus?.(this.status);
  }

  private retry(): void {
    if (this.closed) return;
    const gen = this.gen, delay = Math.min(15000, 1000 * Math.pow(2, this.retries++));
    this.setStatus("offline", `reconnecting in ${Math.round(delay / 1000)}s`);
    this.retryTimer = setTimeout(() => { if (gen === this.gen && !this.closed) void this.connect(); }, delay);
  }

  private async connect(): Promise<void> {
    const gen = ++this.gen;
    this.setStatus("connecting", this.retries ? "reconnecting…" : "connecting…");
    let token = "";
    if (this.opts.signedIn) {
      try {
        token = this.opts.fetchTicket ? await this.opts.fetchTicket()
          : await fetch("/api/ws-ticket", { headers: { "content-type": "application/json" } }).then(async (r) => { if (!r.ok) throw new Error(`${r.status}`); return (await r.json()).token || ""; });
      } catch (e) {
        if (gen !== this.gen) return;
        if (/^40[13]/.test(String((e as Error).message))) { this.setStatus("error", "sign-in expired — reload to reconnect"); return; }
        this.retry(); return;
      }
    }
    if (gen !== this.gen || this.closed) return;
    const url = this.opts.socketUrl || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    let sock: WebSocket;
    try { sock = new (this.opts.WebSocketImpl || WebSocket)(url); } catch (e) { this.setStatus("error", "connection blocked (VPN or proxy?)"); return; }
    this.ws = sock; this.joined = false; this.refetching = false;
    let greeted = false;
    const watchdog = setTimeout(() => { if (this.ws === sock && !greeted) { try { sock.close(); } catch (e) { /* closing */ } } }, 8000);
    sock.onopen = () => {
      if (this.ws !== sock) return;
      if (!this.clientId) this.clientId = "web-" + Math.random().toString(36).slice(2, 10);
      sock.send(JSON.stringify({ type: "hello", proto: 1, token, clientId: this.clientId, linkToken: null, client: "web" }));
    };
    sock.onclose = () => {
      clearTimeout(watchdog);
      if (this.ws !== sock || gen !== this.gen) return;
      this.ws = null; this.joined = false; this.peers.clear(); this.opts.onPeers?.([]);
      this.retry();
    };
    sock.onmessage = (ev) => {
      if (this.ws !== sock) return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
      if (msg.type === "hello_ok") {
        greeted = true; clearTimeout(watchdog); this.retries = 0;
        if (typeof msg.clientId === "string") this.clientId = msg.clientId;
        // a reconnect asks only for what it missed; the first join, or a document that could not be read, takes the file
        sock.send(JSON.stringify(this.doc && this.lastSeq ? { type: "join_doc", docId: this.opts.docId, sinceSeq: this.lastSeq } : { type: "join_doc", docId: this.opts.docId }));
        return;
      }
      this.onMessage(sock, msg);
    };
  }

  private onMessage(sock: WebSocket, msg: Record<string, unknown>): void {
    const docId = this.opts.docId;
    if (msg.docId && msg.docId !== docId) return;
    for (const tap of Array.from(this.taps)) { try { tap(msg); } catch (e) { console.warn(e); } }
    switch (msg.type) {
      case "doc_info": {
        this.joined = true;
        this.peers.clear();
        for (const p of (msg.peers as SessionPeer[]) || []) if (!isRoomWatcher(p.clientId)) this.peers.set(p.clientId, p);
        this.opts.onPeers?.(Array.from(this.peers.values()));
        const role = typeof msg.role === "string" ? msg.role : null;
        this.setStatus("live", role === "editor" && this.opts.signedIn ? "live" : role === "commenter" ? "live · comment-only" : "live · view-only", role);
        // a tail-only join (sinceSeq) sends no snapshot, so what is still unacknowledged goes out again now
        if (this.doc) for (const op of this.pending) this.send(op);
        return;
      }
      case "snapshot": {
        if (typeof msg.file !== "string") return;
        let doc: ItemDoc;
        try { doc = parseItemDoc(msg.file, this.opts.expectKind); }
        catch (e) { this.setStatus("error", (e as Error).message); return; }
        const then = (msg.thenOps as { seq: number; changes: ItemChange[] }[]) || [];
        for (const op of then) applyChanges(doc, op.changes);
        this.lastSeq = then.length ? Number(then[then.length - 1].seq) || Number(msg.seq) || 0 : Number(msg.seq) || 0;
        // the server's document does not have our unacknowledged edits yet: put them back, and send them again
        for (const op of this.pending) applyChanges(doc, op.changes);
        this.doc = doc; this.refetching = false;
        for (const op of this.pending) this.send(op);
        this.opts.onChange(null, "load");
        return;
      }
      case "op": this.remote(sock, Number(msg.seq), msg.changes as ItemChange[], (msg.author as { clientId?: string } | undefined)?.clientId); return;
      case "ops": for (const op of (msg.ops as { seq: number; changes: ItemChange[]; author?: { clientId?: string } }[]) || []) if (!this.remote(sock, Number(op.seq), op.changes, op.author?.clientId)) break; return;
      case "ack": {
        const i = this.pending.findIndex((p) => p.clientOpId === msg.clientOpId), seq = Number(msg.seq) || 0;
        if (i >= 0) {
          this.pending.splice(i, 1);
          // The op was sequenced before something we already hold: it was stored just before the connection
          // dropped, its ack was lost, and since the reconnect it has sat on top of what others did after it.
          // Only a fresh copy puts it back in its place.  (An op of ours that came by in the catch-up was
          // taken out of `pending` there, in `remote`, and does not get here.)
          if (seq && seq <= this.lastSeq && !this.refetching) { this.refetching = true; this.resync(sock, true); }
        }
        this.lastSeq = Math.max(this.lastSeq, seq);
        return;
      }
      case "reset": this.resync(sock, true); return;
      case "role": if (typeof msg.role === "string") this.setStatus("live", msg.role === "editor" ? "live" : msg.role === "commenter" ? "live · comment-only" : "live · view-only", msg.role); return;
      case "peer_joined": { const p = (msg.user || msg.peer) as SessionPeer | undefined; if (p && p.clientId && !isRoomWatcher(p.clientId)) { this.peers.set(p.clientId, p); this.opts.onPeers?.(Array.from(this.peers.values())); } return; }
      case "peer_left": if (typeof msg.clientId === "string" && this.peers.delete(msg.clientId)) this.opts.onPeers?.(Array.from(this.peers.values())); return;
      case "presence": {
        for (const [cid, e] of Object.entries((msg.peers as Record<string, { user?: SessionPeer; state?: Json } | null>) || {})) {
          if (cid === this.clientId || cid.endsWith(":" + this.clientId) || isRoomWatcher(cid)) continue;
          if (e === null) this.peers.delete(cid);
          else { const old = this.peers.get(cid); const user = e.user || old; if (user) this.peers.set(cid, { ...user, clientId: cid, state: e.state }); }
        }
        this.opts.onPeers?.(Array.from(this.peers.values()));
        return;
      }
      case "error": this.onError(sock, msg); return;
    }
  }

  /**
   * One sequenced op: somebody else's, or (in the catch-up after a reconnect) one of ours that the server stored
   * before the connection dropped.  False when it left a gap (a fresh copy is on its way).
   */
  private remote(sock: WebSocket, seq: number, changes: ItemChange[], author?: string): boolean {
    if (!this.doc) return true;
    if (seq && this.lastSeq && seq <= this.lastSeq) return true;                       // already applied
    if (seq && this.lastSeq && seq > this.lastSeq + 1) { this.resync(sock, false); return false; }
    if (seq) this.lastSeq = seq;
    // Ours: it has its place in the sequence now, so it is no longer "on top".  Our ops are stored in the order
    // we sent them, so it is the oldest one waiting (checked by content; if it is not, the ack sorts it out).
    if (author && this.clientId && author === this.clientId && this.pending.length && stableJson(this.pending[0].changes as unknown as Json) === stableJson(changes as unknown as Json)) this.pending.shift();
    const touched = applyChanges(this.doc, changes);
    // ours that are not acknowledged come after this one in the server's order: they stay on top
    for (const op of this.pending) for (const c of op.changes) if (touched.has(c.id)) applyChanges(this.doc, [c]);
    if (touched.size) this.opts.onChange(touched, "remote");
    return true;
  }

  private resync(sock: WebSocket, force: boolean): void {
    if (sock.readyState !== 1) return;
    if (!force && Date.now() - this.resyncAt < 3000) return;
    this.resyncAt = Date.now();
    sock.send(JSON.stringify({ type: "resync", docId: this.opts.docId }));
  }

  private onError(sock: WebSocket, msg: Record<string, unknown>): void {
    const code = String(msg.code || "");
    if (code === "auth_failed") { sock.onclose = null; sock.close(); this.ws = null; this.setStatus("error", "sign-in expired — reload to reconnect"); return; }
    if (code === "desynced") { this.resync(sock, true); return; }
    if (code === "not_joined") { this.joined = false; sock.send(JSON.stringify({ type: "join_doc", docId: this.opts.docId })); return; }
    if (typeof msg.clientOpId === "string") {
      // that one edit was refused: forget it and take the server's document back
      const i = this.pending.findIndex((p) => p.clientOpId === msg.clientOpId);
      if (i >= 0) this.pending.splice(i, 1);
      if (code === "permission_denied" && typeof msg.role === "string") this.setStatus("live", "live · view-only", msg.role);
      this.opts.onNotice?.(code === "permission_denied" ? "That edit was not saved: you have view-only access." : "The server refused an edit; the document was reloaded.");
      this.resync(sock, true);
      return;
    }
    if (code === "permission_denied") { this.setStatus("error", "no access", null); this.opts.onNotice?.("You no longer have access to this project."); return; }
    if (code === "not_found") { this.setStatus("error", "this document has no stored file yet"); return; }
    if (code === "bad_message" || code === "unsupported_protocol") this.setStatus("error", `server refused the session (${code}) — reload`);
  }
}
