// source.ts — a board document of the project, read live: `BoardSource` joins the board on the collaboration
// socket the editors use (server/src/ws.rs), takes the stored file and the edits since, and then every op as it
// is made, and keeps a `BoardReader` (model.ts) in step.  It never writes: a part studio only watches a board.
//
//   const src = new BoardSource({ docId, signedIn, onChange: (delta, timing) => …, onStatus: (s) => … });
//   src.start();  …  src.reader  …  src.close();
//
// The rules are those of shared/itemdoc/sync.ts, minus everything about our own edits: a gap in the sequence
// asks for a fresh copy, a dropped socket reconnects and asks only for what it missed.
import { applyBoardChanges, parseBoard, type BoardChange } from "../../pcb/exports/board-geometry";
import { BoardReader, type BoardDelta } from "./model";

export type BoardSourceState = "connecting" | "live" | "offline" | "error";
export interface BoardSourceStatus { state: BoardSourceState; text: string }
/** How long the steps of one update took, ms: applying the ops to the document, and reading the changed items. */
export interface BoardTiming { apply: number; read: number; at: number }

export interface BoardSourceOptions {
  docId: string;
  signedIn: boolean;
  /** The board changed.  `delta` says what, so each consumer does only its share. */
  onChange(delta: BoardDelta, timing: BoardTiming): void;
  onStatus?(status: BoardSourceStatus): void;
  /** test seams */
  socketUrl?: string; fetchTicket?: () => Promise<string>; WebSocketImpl?: typeof WebSocket;
}

interface Op { seq: number; changes: BoardChange[] }
const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class BoardSource {
  reader: BoardReader | null = null;
  status: BoardSourceStatus = { state: "connecting", text: "connecting…" };
  /** ops applied since the board was loaded */
  opsSeen = 0;
  private ws: WebSocket | null = null;
  private gen = 0;
  private retries = 0;
  private lastSeq = 0;
  private resyncAt = 0;
  private closed = false;
  private clientId = "";
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: BoardSourceOptions) {}

  start(): void { this.closed = false; void this.connect(); }
  close(): void {
    this.closed = true; this.gen++;
    clearTimeout(this.retryTimer);
    if (this.ws) { this.ws.onclose = null; this.ws.onmessage = null; try { this.ws.close(); } catch (e) { /* already gone */ } this.ws = null; }
  }

  private setStatus(state: BoardSourceState, text: string): void { this.status = { state, text }; this.opts.onStatus?.(this.status); }

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
        if (/^40[13]/.test(String((e as Error).message))) { this.setStatus("error", "sign-in expired"); return; }
        this.retry(); return;
      }
    }
    if (gen !== this.gen || this.closed) return;
    const url = this.opts.socketUrl || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    let sock: WebSocket;
    try { sock = new (this.opts.WebSocketImpl || WebSocket)(url); } catch (e) { this.setStatus("error", "connection blocked"); return; }
    this.ws = sock;
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
      this.ws = null;
      this.retry();
    };
    sock.onmessage = (ev) => {
      if (this.ws !== sock) return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
      if (msg.type === "hello_ok") {
        greeted = true; clearTimeout(watchdog); this.retries = 0;
        if (typeof msg.clientId === "string") this.clientId = msg.clientId;
        // a reconnect asks only for what it missed; the first join takes the file
        sock.send(JSON.stringify(this.reader && this.lastSeq ? { type: "join_doc", docId: this.opts.docId, sinceSeq: this.lastSeq } : { type: "join_doc", docId: this.opts.docId }));
        return;
      }
      this.onMessage(sock, msg);
    };
  }

  private onMessage(sock: WebSocket, msg: Record<string, unknown>): void {
    if (msg.docId && msg.docId !== this.opts.docId) return;
    switch (msg.type) {
      case "doc_info": this.setStatus("live", "live"); return;
      case "snapshot": {
        if (typeof msg.file !== "string") return;
        const t0 = now();
        let delta: BoardDelta;
        try {
          const doc = parseBoard(msg.file);
          const then = (msg.thenOps as Op[]) || [];
          for (const op of then) applyBoardChanges(doc, op.changes || []);
          this.lastSeq = then.length ? Number(then[then.length - 1].seq) || Number(msg.seq) || 0 : Number(msg.seq) || 0;
          const t1 = now();
          if (!this.reader) this.reader = new BoardReader();
          delta = this.reader.reload(doc);
          this.opts.onChange(delta, { apply: t1 - t0, read: now() - t1, at: t0 });
        } catch (e) { console.warn(e); this.setStatus("error", "the board could not be read"); }
        return;
      }
      case "op": this.remote(sock, [{ seq: Number(msg.seq), changes: (msg.changes as BoardChange[]) || [] }]); return;
      case "ops": this.remote(sock, ((msg.ops as Op[]) || []).map((op) => ({ seq: Number(op.seq), changes: op.changes || [] }))); return;
      case "reset": this.resync(sock, true); return;
      case "error": {
        const code = String(msg.code || "");
        if (code === "auth_failed") { sock.onclose = null; sock.close(); this.ws = null; this.setStatus("error", "sign-in expired"); }
        else if (code === "desynced") this.resync(sock, true);
        else if (code === "not_joined") sock.send(JSON.stringify({ type: "join_doc", docId: this.opts.docId }));
        else if (code === "permission_denied") this.setStatus("error", "no access to this board");
        else if (code === "not_found") this.setStatus("error", "this board has no stored file yet");
        return;
      }
    }
  }

  /** Sequenced ops from the server, in order.  They are applied together and reported as one change. */
  private remote(sock: WebSocket, ops: Op[]): void {
    const reader = this.reader; if (!reader) return;
    const t0 = now();
    const touched = new Set<string>();
    for (const op of ops) {
      if (op.seq && this.lastSeq && op.seq <= this.lastSeq) continue;                    // already applied
      if (op.seq && this.lastSeq && op.seq > this.lastSeq + 1) { this.resync(sock, false); break; }
      if (op.seq) this.lastSeq = op.seq;
      this.opsSeen++;
      for (const id of applyBoardChanges(reader.doc, op.changes)) touched.add(id);
    }
    if (!touched.size) return;
    const t1 = now();
    const delta = reader.update(touched);
    this.opts.onChange(delta, { apply: t1 - t0, read: now() - t1, at: t0 });
  }

  private resync(sock: WebSocket, force: boolean): void {
    if (sock.readyState !== 1) return;
    if (!force && Date.now() - this.resyncAt < 3000) return;
    this.resyncAt = Date.now();
    sock.send(JSON.stringify({ type: "resync", docId: this.opts.docId }));
  }
}
