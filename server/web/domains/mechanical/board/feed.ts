// feed.ts — the boards of a part studio's Board features, for everything that builds the studio OUTSIDE its own
// page: an assembly drawing an instance, Compare, the assistant's host, the board editor's enclosure.  (The
// page itself has board/link.ts, which also draws the board.)
//
// A Board feature does not store its board: the worker is handed the board as it is now in the transient
// parameter `$board`.  `feed.filter` is an input filter (document/inputs.ts) that adds it; the feed opens every
// board it meets on the collaboration socket (source.ts), read-only, and calls `changed` when a board arrives
// or an edit of it changes what a feature is built from, so the caller builds again.
//
//   const feed = new BoardFeed({ signedIn, changed: () => rebuild() });
//   const input = studioInputs(doc, { filters: [feed.filter] });     // Board features without their board yet fail with
//   await feed.settled();                                            // "has not been read yet"; build again when told
//   feed.close();
//
// Part envelopes here come from the footprints' courtyards and outlines; the page refines them from the parts'
// 3D models once those have loaded, so a tall connector's box may differ a little between the two.  Names do not.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import { stableJson } from "../../../shared/itemdoc/itemdoc";
import type { FeatureInput } from "../kernel/protocol";
import type { BoardDelta, BoardReader, BoardSnapshotJson, Pt } from "./model";
import { BoardSource, type BoardSourceOptions } from "./source";

export const BOARD_FEATURE_TYPE = "board-reference";
/** How long after the last edit of a board the caller is told, ms (a dragged footprint arrives every 150 ms). */
const SETTLE_MS = 260;

export interface BoardFeedOptions {
  signedIn: boolean;
  /** a board arrived, or changed what a Board feature is built from */
  changed(): void;
  /** every change of a board as it arrives, before the wait: for a picture of the board that follows a drag */
  onBoard?(docId: string, reader: BoardReader, delta: BoardDelta): void;
  /** how to reach the server where there is no page (the assistant's host): BoardSource's seams */
  socket?: Pick<BoardSourceOptions, "socketUrl" | "fetchTicket" | "WebSocketImpl">;
}

const num = (v: unknown, d: number): number => (typeof v === "number" && isFinite(v) ? v : d);

export class BoardFeed {
  private readonly sources = new Map<string, BoardSource>();
  /** per feature: what it was last given, to tell a change that matters from one that does not */
  private readonly given = new Map<string, { key: string; json: string; snapshot: BoardSnapshotJson }>();
  private wanted = new Map<string, FeatureInput>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private waiters: (() => void)[] = [];

  constructor(private readonly opts: BoardFeedOptions) {}

  /** The reader of a board that is open, or null. */
  reader(docId: string): BoardReader | null { return this.sources.get(docId)?.reader || null; }
  /** The boards the last input named. */
  boards(): string[] { return Array.from(new Set(Array.from(this.wanted.values()).map((f) => f.params.board as string))); }
  /** True while a board the last input named has neither been read nor failed. */
  get pending(): boolean {
    for (const docId of this.boards()) { const s = this.sources.get(docId); if (!s || (!s.reader && s.status.state !== "error")) return true; }
    return false;
  }
  /** Resolves when nothing is pending (or after `ms`): for a caller that builds once. */
  settled(ms = 20000): Promise<void> {
    if (!this.pending) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const end = () => { if (done) return; done = true; this.waiters = this.waiters.filter((w) => w !== end); resolve(); };
      this.waiters.push(end);
      setTimeout(end, ms);
    });
  }

  private snapshotFor(f: FeatureInput): BoardSnapshotJson | null {
    const reader = this.reader(f.params.board as string); if (!reader) return null;
    const o = f.params.origin as unknown;
    const origin: Pt = Array.isArray(o) && o.length === 2 && typeof o[0] === "number" && typeof o[1] === "number" ? [o[0], o[1]] : reader.centre();
    const minHole = num(f.params.minHole, 1.5), minHeight = num(f.params.minHeight, 1.5);
    const key = `${reader.rev}|${origin[0]},${origin[1]}|${minHole}|${minHeight}`;
    const had = this.given.get(f.id);
    if (had && had.key === key) return had.snapshot;
    const snapshot = reader.snapshot({ origin, minHole, minHeight }) as BoardSnapshotJson;
    const json = stableJson(snapshot as unknown as JsonObject);
    // the same data again (an edit that changes nothing a feature uses): keep the object, so nothing rebuilds
    const now = had && had.json === json ? { key, json, snapshot: had.snapshot } : { key, json, snapshot };
    this.given.set(f.id, now);
    return now.snapshot;
  }

  /** The input filter: every Board feature gets its board as it is now; boards not met before are opened. */
  filter = (inputs: FeatureInput[]): FeatureInput[] => {
    if (this.closed) return inputs;
    const wanted = new Map<string, FeatureInput>();
    for (const f of inputs) if (f.type === BOARD_FEATURE_TYPE && typeof f.params.board === "string" && f.params.board) wanted.set(f.id, f);
    this.wanted = wanted;
    const docs = new Set(this.boards());
    for (const docId of docs) {
      if (this.sources.has(docId)) continue;
      const source = new BoardSource({
        ...(this.opts.socket || {}), docId, signedIn: this.opts.signedIn,
        onChange: (delta) => { const r = source.reader; if (r && this.opts.onBoard) this.opts.onBoard(docId, r, delta); this.boardChanged(docId, false); },
        onStatus: (s) => { if (s.state === "error") this.boardChanged(docId, true); },
      });
      this.sources.set(docId, source);
      source.start();
    }
    for (const [docId, s] of Array.from(this.sources)) if (!docs.has(docId)) { s.close(); this.sources.delete(docId); }
    for (const id of Array.from(this.given.keys())) if (!wanted.has(id)) this.given.delete(id);
    if (!wanted.size) return inputs;
    return inputs.map((f) => {
      if (!wanted.has(f.id)) return f;
      const snapshot = this.snapshotFor(f);
      return snapshot ? { ...f, params: { ...f.params, $board: snapshot } } : f;
    });
  };

  /** Look at a board again (its parts' envelopes were measured from their 3D models). */
  poke(docId: string): void { if (this.sources.has(docId)) this.boardChanged(docId, false); }

  private boardChanged(docId: string, failed: boolean): void {
    if (this.closed) return;
    if (!this.pending) for (const w of this.waiters.slice()) w();
    if (failed) return;
    clearTimeout(this.timer);
    // the first copy of a board is wanted at once; edits are waited out
    const first = Array.from(this.wanted.values()).some((f) => f.params.board === docId && !this.given.has(f.id));
    this.timer = setTimeout(() => {
      if (this.closed) return;
      let differs = false;
      for (const f of this.wanted.values()) {
        if (f.params.board !== docId) continue;
        const before = this.given.get(f.id)?.snapshot;
        if (this.snapshotFor(f) !== before) differs = true;
      }
      if (differs) this.opts.changed();
    }, first ? 0 : SETTLE_MS);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    for (const s of this.sources.values()) s.close();
    this.sources.clear(); this.given.clear(); this.wanted.clear();
    for (const w of this.waiters.slice()) w();
  }
}
