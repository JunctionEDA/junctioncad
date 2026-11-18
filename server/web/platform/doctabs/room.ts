// room.ts — the project room: who is in the project, and on which tab.
//
// Presence on the server is per document: every socket joins documents.  So the room is built on that.  Each
// page opens one more socket (the "watcher") and joins the project's first few part studios and assemblies with
// it (roomapi.ts roomDocs), sends there which tab the person is on, and listens to what the other watchers say.
//
//   · Only JSON item documents are joined: no KiCad client is ever in one, so a watcher shows up in nobody's
//     collaborator list.  A session of those documents leaves watchers out of its peers: it knows one by its
//     client id, "room-…" (shared/itemdoc/sync.ts isRoomWatcher), and by the state it sends (`room: 1`, where a
//     person's editor sends `cad: 1`; domains/mechanical/collab/presence.ts).
//   · A watcher takes the document's file once when it joins and then its edits as they come, and ignores
//     both.  That is why at most four documents are joined.
//   · A project with no part studio or assembly has no room: nobody is shown on its tabs.
//
// That the project's DOCUMENTS changed (one was added, renamed, deleted) is not the room's business any more:
// the server says so itself, to every open document of the project (`docs` notice, src/http.rs notify_docs).
// The watcher hears it like every other socket and passes it on (roomapi.ts tellDocsChanged).
import type { DocEntry } from "../../shared/store";
import { parseRoomPresence, pickColor, roomDocs, tellDocsChanged, type ProjectRoomApi, type RoomMember, type RoomState } from "./roomapi";

export interface RoomOptions {
  signedIn: boolean;
  /** The room suspects the list of documents is stale (it was away, or a document it joined is gone): fetch it again. */
  onDocsChanged(): void;
  /** test seams */
  socketUrl?: string; fetchTicket?: () => Promise<string>; WebSocketImpl?: typeof WebSocket;
}

interface PeerUser { clientId: string; userId: number; login: string; name?: string | null; color: string }
interface Seen { user: PeerUser; tab: string | null; col?: string }

const EMPTY: RoomState = { live: false, me: null, members: [] };

export class ProjectRoom implements ProjectRoomApi {
  private state: RoomState = EMPTY;
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private gen = 0;
  private retries = 0;
  private closed = false;
  private clientId = "";
  /** the colour the server gave this socket, and the one taken instead when somebody here has the same */
  private color = "";
  private col = "";
  private want: string[] = [];
  /** documents this socket has asked to join, and the ones that answered */
  private asked = new Set<string>();
  private joined = new Set<string>();
  /** documents the server would not let us join; not asked again until the list changes */
  private refused = new Set<string>();
  private seen = new Map<string, Map<string, Seen>>();
  private tab: string | null = null;
  private everLive = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private beat: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: RoomOptions) {
    this.beat = setInterval(() => this.say(), 10000);
  }

  getState = (): RoomState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };

  /** The project's documents as the page has them now. */
  setDocs(docs: readonly Pick<DocEntry, "docId" | "docType">[]): void {
    const want = roomDocs(docs);
    if (want.join() === this.want.join()) return;
    this.want = want;
    for (const id of Array.from(this.refused)) if (!want.includes(id)) this.refused.delete(id);
    for (const id of Array.from(this.seen.keys())) if (!docs.some((d) => d.docId === id)) { this.seen.delete(id); this.joined.delete(id); }
    if (!want.length) { this.drop(); this.publish(); return; }
    if (this.ws && this.ws.readyState === 1 && this.clientId) this.join(); else if (!this.ws) void this.connect();
    this.publish();
  }

  /** The tab this person is on. */
  setTab(docId: string | null): void { if (docId !== this.tab) { this.tab = docId; this.say(); } }

  close(): void {
    this.closed = true;
    clearInterval(this.beat);
    this.drop(); this.listeners.clear();
  }

  private drop(): void {
    this.gen++;
    clearTimeout(this.retryTimer);
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch (e) { /* already gone */ } }
    this.asked.clear(); this.joined.clear(); this.seen.clear();
  }

  private publish(): void {
    const members = new Map<string, RoomMember>();
    for (const doc of this.seen.values()) for (const [cid, s] of doc) {
      members.set(cid, { key: cid, userId: s.user.userId, login: s.user.login, name: s.user.name || s.user.login || "Someone", color: s.col || s.user.color, tab: s.tab });
    }
    const list = Array.from(members.values()).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
    const live = this.joined.size > 0;
    // two people the server gave one colour: the later key takes another, and says so
    if (this.clientId && this.color) {
      const col = pickColor({ key: this.clientId, color: this.col || this.color }, list);
      if (col !== (this.col || this.color)) { this.col = col; this.say(); }
    }
    const me = this.clientId ? { key: this.clientId, color: this.col || this.color } : null;
    const was = this.state;
    if (was.live === live && was.me?.key === me?.key && was.me?.color === me?.color && was.members.length === list.length && was.members.every((m, i) => m.key === list[i].key && m.tab === list[i].tab && m.name === list[i].name && m.color === list[i].color)) return;
    this.state = { live, me, members: list };
    for (const fn of Array.from(this.listeners)) fn();
  }

  private say(to?: string): void {
    const ws = this.ws; if (!ws || ws.readyState !== 1) return;
    const state = { room: 1, tab: this.tab, ...(this.col ? { col: this.col } : {}), ts: Date.now() };
    for (const docId of to ? [to] : Array.from(this.joined)) ws.send(JSON.stringify({ type: "presence", docId, state }));
  }

  private join(): void {
    const ws = this.ws; if (!ws || ws.readyState !== 1) return;
    for (const docId of this.want) {
      if (this.asked.has(docId) || this.refused.has(docId)) continue;
      this.asked.add(docId);
      ws.send(JSON.stringify({ type: "join_doc", docId }));
    }
  }

  private retry(): void {
    if (this.closed || !this.want.length) return;
    const gen = this.gen, delay = Math.min(15000, 1000 * Math.pow(2, this.retries++));
    this.retryTimer = setTimeout(() => { if (gen === this.gen && !this.closed) void this.connect(); }, delay);
  }

  private async connect(): Promise<void> {
    if (this.closed || !this.want.length) return;
    const gen = ++this.gen;
    let token = "";
    if (this.opts.signedIn) {
      try {
        token = this.opts.fetchTicket ? await this.opts.fetchTicket()
          : await fetch("/api/ws-ticket", { headers: { "content-type": "application/json" } }).then(async (r) => { if (!r.ok) throw new Error(`${r.status}`); return (await r.json()).token || ""; });
      } catch (e) {
        if (gen !== this.gen) return;
        if (!/^40[13]/.test(String((e as Error).message))) this.retry();   // a sign-in that expired is the editor's to report
        return;
      }
    }
    if (gen !== this.gen || this.closed) return;
    const url = this.opts.socketUrl || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    let sock: WebSocket;
    try { sock = new (this.opts.WebSocketImpl || WebSocket)(url); } catch (e) { return; }
    this.ws = sock; this.asked.clear(); this.joined.clear();
    sock.onopen = () => {
      if (this.ws !== sock) return;
      if (!this.clientId) this.clientId = "room-" + Math.random().toString(36).slice(2, 10);
      sock.send(JSON.stringify({ type: "hello", proto: 1, token, clientId: this.clientId, linkToken: null, client: "web" }));
    };
    sock.onclose = () => {
      if (this.ws !== sock || gen !== this.gen) return;
      this.ws = null; this.asked.clear(); this.joined.clear(); this.seen.clear();
      this.publish();
      this.retry();
    };
    sock.onmessage = (ev) => {
      if (this.ws !== sock) return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
      this.onMessage(msg);
    };
  }

  private isMe(cid: string): boolean { return cid === this.clientId || cid.endsWith(":" + this.clientId); }

  private onMessage(msg: Record<string, unknown>): void {
    const docId = typeof msg.docId === "string" ? msg.docId : "";
    switch (msg.type) {
      case "hello_ok": {
        this.retries = 0;
        if (typeof msg.clientId === "string") this.clientId = msg.clientId;
        if (typeof msg.color === "string") this.color = msg.color;
        this.join(); this.publish();
        return;
      }
      case "doc_info": {
        if (!docId) return;
        const again = this.everLive && !this.joined.size;
        this.joined.add(docId); this.everLive = true;
        if (!this.seen.has(docId)) this.seen.set(docId, new Map());
        this.say(docId); this.publish();
        // back after being away: the list may have changed while nobody could say so
        if (again) this.opts.onDocsChanged();
        return;
      }
      case "presence": {
        const doc = this.seen.get(docId); if (!doc) return;
        for (const [cid, e] of Object.entries((msg.peers as Record<string, { user?: PeerUser; state?: unknown } | null>) || {})) {
          if (this.isMe(cid)) continue;
          const room = e ? parseRoomPresence(e.state) : null;
          const user = e && e.user ? e.user : doc.get(cid)?.user;
          if (!e) { doc.delete(cid); continue; }      // they left, or fell silent
          if (!room || !user) continue;               // a person's editor session, not a watcher
          doc.set(cid, { user, tab: room.tab, col: room.col });
        }
        this.publish();
        return;
      }
      case "docs": tellDocsChanged(msg); return;   // the server: a document was added, renamed or deleted
      case "peer_left": {
        const doc = this.seen.get(docId);
        if (doc && typeof msg.clientId === "string" && doc.delete(msg.clientId)) this.publish();
        return;
      }
      case "error": {
        const code = String(msg.code || "");
        if (docId && (code === "not_found" || code === "permission_denied")) {
          this.refused.add(docId); this.joined.delete(docId); this.seen.delete(docId);
          this.publish();
          if (code === "not_found") {
            // either the list is stale (the document was deleted), or the document is so new that its first
            // file is not stored yet: look at the list, and ask once more in a moment
            this.opts.onDocsChanged();
            const gen = this.gen;
            setTimeout(() => { if (gen !== this.gen || this.closed) return; this.refused.delete(docId); this.asked.delete(docId); this.join(); }, 5000);
          }
        }
        return;
      }
    }
  }
}
