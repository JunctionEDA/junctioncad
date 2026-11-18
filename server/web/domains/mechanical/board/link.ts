// link.ts — what keeps a part studio's Board features in step with their boards.  One `BoardLink` per open part
// studio (it registers itself as a studio extension, ui/studio.ts):
//
//   • for every board a Board feature names, a `BoardSource` (source.ts) reads the board document live;
//   • for every Board feature, a `BoardDisplay` (display.ts) draws the board in the viewport, and follows each
//     edit of the board at once: a moved footprint costs one small mesh;
//   • the board as data (`BoardReader.snapshot`) is added to the feature's input for the worker as the transient
//     parameter `$board`, and when an edit of the board changes that data the part studio is regenerated, a
//     moment after the edits stop, so the features built on the board follow without a rebuild per drag step.
//
// `window.JunctionBoardLink` is the open studio's link, for tests and the console (`.stats`, `.boards()`).
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import { stableJson } from "../../../shared/itemdoc/itemdoc";
import { DEFAULT_PLANES, type Frame, type PlaneRef } from "../core/geometry";
import * as edits from "../document/edits";
import type { FeatureItem } from "../document/format";
import type { BodyResult, FeatureInput, RegenResult } from "../kernel/protocol";
import { studioExtensions, type PartStudio } from "../ui/studio";
import { BoardDisplay } from "./display";
import type { BoardDelta, BoardReader, BoardSnapshotJson, Pt } from "./model";
import { boardFrame } from "./placement";
import { BoardSource, type BoardSourceStatus, type BoardTiming } from "./source";

export const BOARD_FEATURE = "board-reference";
/**
 * How long after the last edit of a board the part studio is regenerated, ms.  The board editor sends a dragged
 * footprint's place every 150 ms, so this is longer: a drag regenerates once, when it ends.
 */
const REGEN_AFTER_MS = 260;
/** how long a board nothing refers to any more is still followed, ms */
const SWEEP_AFTER_MS = 2000;

export interface BoardUse { featureId: string; name: string; docId: string; path: string; status: BoardSourceStatus; parts: number; ops: number }
/** One update of a board as the part studio saw it, ms from the moment the op arrived. */
export interface UpdateSample { apply: number; read: number; display: number; parts: number }
export interface LinkStats {
  /** updates since the studio opened, and the most recent ones */
  updates: number; samples: UpdateSample[];
  /** regenerations a board edit caused, the last one's time from the first unbuilt edit to the model on screen, and the worker's share */
  regens: number; lastRegenMs: number; lastWorkerMs: number;
  /** of lastRegenMs: from asking for the regeneration to handing the worker its input (the page was busy), and from there to the model on screen */
  lastQueueMs: number; lastRoundtripMs: number;
  /** board edits that changed nothing the features use (a track, a part too low to matter): no regeneration */
  skipped: number;
}

interface Entry { source: BoardSource; docId: string }
interface Shown { display: BoardDisplay; docId: string; origin: Pt | null; json: string; snapshot: BoardSnapshotJson | null; key: string }

const isBoard = (f: { featureType?: string; type?: string }): boolean => (f.featureType || f.type) === BOARD_FEATURE;
const num = (v: unknown, d: number): number => (typeof v === "number" && isFinite(v) ? v : d);

export class BoardLink {
  private sources = new Map<string, Entry>();
  private shown = new Map<string, Shown>();
  private listeners = new Set<() => void>();
  private timer = 0;
  private sweepTimer = 0;
  private pendingSince = 0;
  private waitingRegen = 0;
  private pending = false;
  private askedRegen = 0;
  private sentRegen = 0;
  private unsubscribe: () => void;
  private closed = false;
  private lastFeatures: readonly FeatureItem[] | null = null;
  private lastEditing: unknown = null;
  private lastReports: unknown = null;
  private workerFrames: { [featureId: string]: { frame: Frame; thickness: number } } = {};
  readonly stats: LinkStats = { updates: 0, samples: [], regens: 0, lastRegenMs: 0, lastWorkerMs: 0, lastQueueMs: 0, lastRoundtripMs: 0, skipped: 0 };

  constructor(readonly studio: PartStudio) {
    studio.inputFilters.push(this.filter);
    studio.onRegen.push(this.afterRegen);
    const before = studio.view.bodyStyle;
    // the feature's solids are there to be picked and referred to; the display model is what is looked at
    studio.view.bodyStyle = (b: BodyResult) => (this.shown.has(b.createdBy) ? { faces: false, edges: false } : before ? before(b) : null);
    this.unsubscribe = studio.subscribe(() => this.sync());
    this.sync();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer); clearTimeout(this.sweepTimer);
    this.unsubscribe();
    for (const e of this.sources.values()) e.source.close();
    for (const s of this.shown.values()) s.display.dispose();
    this.sources.clear(); this.shown.clear(); this.listeners.clear();
  }

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private tell(): void { for (const fn of Array.from(this.listeners)) fn(); }

  /** The Board features of the studio as it is shown: the document's, with the dialog's draft laid over them. */
  private features(): FeatureItem[] {
    const s = this.studio.getState();
    let list = s.features.filter(isBoard);
    if (s.editing && isBoard(s.editing.draft)) {
      const d = s.editing.draft;
      list = s.editing.isNew ? [...list, d] : list.map((f) => (f.id === d.id ? d : f));
    }
    return list.filter((f) => typeof f.params.board === "string" && f.params.board);
  }

  /** What the panel lists. */
  boards(): BoardUse[] {
    return this.features().map((f) => {
      const docId = f.params.board as string, e = this.sources.get(docId);
      const doc = this.studio.host.docs.find((d) => d.docId === docId);
      return { featureId: f.id, name: f.name, docId, path: doc ? doc.path : "", status: e ? e.source.status : { state: "connecting", text: "connecting…" }, parts: e && e.source.reader ? e.source.reader.components().length : 0, ops: e ? e.source.opsSeen : 0 };
    });
  }
  /** True while an edit of a board is still on its way into the model: waiting for the edits to stop, or for the worker. */
  get busy(): boolean { return this.pending || !!this.waitingRegen; }
  /** Resolves when the part models of every board shown have arrived (their envelopes are then final). */
  async modelsSettled(): Promise<void> { for (const sh of Array.from(this.shown.values())) await sh.display.modelsSettled(); }
  /** The reader of a board that is being followed, or null (for the other direction, and for tests). */
  reader(docId: string): BoardReader | null { return this.sources.get(docId)?.source.reader || null; }

  // ---------------------------------------------------------------- following the studio
  private sync(): void {
    if (this.closed) return;
    const s = this.studio.getState();
    if (s.features === this.lastFeatures && s.editing === this.lastEditing && s.reports === this.lastReports) return;
    this.lastFeatures = s.features; this.lastEditing = s.editing; this.lastReports = s.reports;
    const features = this.features();
    const wanted = new Set(features.map((f) => f.params.board as string));
    for (const docId of wanted) {
      if (this.sources.has(docId)) continue;
      const source = new BoardSource({
        docId, signedIn: this.studio.host.signedIn,
        onChange: (delta, timing) => this.boardChanged(docId, delta, timing),
        onStatus: () => this.tell(),
      });
      this.sources.set(docId, { source, docId });
      source.start();
    }
    // What is no longer used is hidden now and let go a little later: accepting a dialog takes the draft away a
    // moment before the feature arrives in the document, and the board should not be read and drawn twice for it.
    const ids = new Set(features.map((f) => f.id));
    let stale = false;
    for (const [id, sh] of this.shown) if (!ids.has(id) || sh.docId !== features.find((f) => f.id === id)!.params.board) { sh.display.setVisible(false); stale = true; }
    for (const docId of this.sources.keys()) if (!wanted.has(docId)) stale = true;
    if (stale) { clearTimeout(this.sweepTimer); this.sweepTimer = window.setTimeout(() => this.sweep(), SWEEP_AFTER_MS); }
    for (const f of features) {
      let sh = this.shown.get(f.id);
      if (sh && sh.docId !== f.params.board) { sh.display.dispose(); this.shown.delete(f.id); sh = undefined; }
      if (!sh) {
        const display = new BoardDisplay(this.studio.viewport);
        display.onMeasured = () => this.schedule();
        sh = { display, docId: f.params.board as string, origin: null, json: "", snapshot: null, key: "" };
        this.shown.set(f.id, sh);
        display.setVisible(false);
      }
      this.place(f, sh, null);
    }
    this.tell();
  }

  /** Let go of the boards and displays nothing uses any more. */
  private sweep(): void {
    if (this.closed) return;
    const features = this.features();
    const wanted = new Set(features.map((f) => f.params.board as string)), ids = new Set(features.map((f) => f.id));
    for (const [docId, e] of Array.from(this.sources)) if (!wanted.has(docId)) { e.source.close(); this.sources.delete(docId); }
    for (const [id, sh] of Array.from(this.shown)) if (!ids.has(id)) { sh.display.dispose(); this.shown.delete(id); }
    this.tell();
  }

  private originOf(f: FeatureItem, reader: BoardReader): Pt {
    const o = f.params.origin as unknown;
    return Array.isArray(o) && o.length === 2 && typeof o[0] === "number" && typeof o[1] === "number" ? [o[0], o[1]] : reader.centre();
  }

  /** Draw a feature's board where the feature puts it, as far as the page can know. */
  private place(f: FeatureItem, sh: Shown, delta: BoardDelta | null): void {
    const reader = this.reader(sh.docId);
    const s = this.studio.getState();
    const index = s.features.findIndex((x) => x.id === f.id);
    const editing = !!s.editing && s.editing.draft.id === f.id;
    const report = s.reports[f.id];
    const built = editing || (index >= 0 && index < s.rollback && !f.suppressed);
    if (!reader || !built || (report && report.status === "error")) { sh.display.setVisible(false); return; }
    const origin = this.originOf(f, reader);
    const fresh = !sh.origin || sh.origin[0] !== origin[0] || sh.origin[1] !== origin[1];
    if (fresh || delta) { sh.display.update(reader, origin, fresh ? null : delta); sh.origin = origin; }
    const plane = f.params.plane as unknown as PlaneRef | undefined;
    let frame: Frame | null = null;
    if (!plane || plane.kind === "plane") {
      const p = DEFAULT_PLANES[(plane && plane.plane) || "top"];
      if (p) frame = boardFrame(p.frame, { x: num(f.params.x, 0), y: num(f.params.y, 0), z: num(f.params.z, 0), angle: num(f.params.angle, 0), flip: !!f.params.flip }, reader.thickness);
    } else frame = this.workerFrames[f.id]?.frame || null;   // on a face of the model: only the worker knows where that is
    if (!frame) { sh.display.setVisible(false); return; }
    sh.display.setFrame(frame);
    sh.display.setVisible(true);
  }

  // ---------------------------------------------------------------- following the boards
  private boardChanged(docId: string, delta: BoardDelta, timing: BoardTiming): void {
    if (this.closed) return;
    const reader = this.reader(docId); if (!reader) return;
    let parts = 0;
    for (const f of this.features()) {
      if (f.params.board !== docId) continue;
      const sh = this.shown.get(f.id); if (!sh) continue;
      this.place(f, sh, delta);
      parts += sh.display.stats.parts;
      if (delta.all) this.keepOrigin(f, reader);
    }
    if (!delta.all) {
      this.stats.updates++;
      this.stats.samples.push({ apply: timing.apply, read: timing.read, display: performance.now() - timing.at, parts });
      if (this.stats.samples.length > 200) this.stats.samples.shift();
    }
    if (!this.pendingSince) this.pendingSince = timing.at;
    this.schedule();
    this.tell();
  }

  /**
   * A Board feature starts without an origin and takes the middle of the board the first time the board is
   * read; the feature then keeps it, so the board stays where it is when its outline changes.
   */
  private keepOrigin(f: FeatureItem, reader: BoardReader): void {
    if (Array.isArray(f.params.origin)) return;
    const c = reader.centre();
    const s = this.studio.getState();
    if (s.editing && s.editing.draft.id === f.id) { this.studio.setDraft({ params: { origin: c } }); return; }
    if (s.canEdit && this.studio.doc && s.features.some((x) => x.id === f.id)) this.studio.commit(edits.setParamPath(this.studio.doc, f.id, ["origin"], c), { undoable: false });
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.pending = true;
    this.timer = window.setTimeout(() => this.settle(), REGEN_AFTER_MS);
  }

  /** The edits have stopped for a moment: if they changed what the features are built from, regenerate. */
  private settle(): void {
    if (this.closed) return;
    this.pending = false;
    let changed = false;
    for (const f of this.features()) { const sh = this.shown.get(f.id); if (sh && this.refresh(f, sh)) changed = true; }
    if (changed) { this.waitingRegen = this.pendingSince || performance.now(); this.askedRegen = performance.now(); this.studio.scheduleRegen(); }
    else if (this.pendingSince) this.stats.skipped++;
    this.pendingSince = 0;
  }

  /** Take the board's data again for a feature; true when it differs from what the worker was last given. */
  private refresh(f: FeatureItem | FeatureInput, sh: Shown): boolean {
    const reader = this.reader(sh.docId); if (!reader) return false;
    const p = f.params;
    const origin = this.originOf(f as FeatureItem, reader);
    const key = `${reader.rev}|${origin[0]},${origin[1]}|${num(p.minHole, 1.5)}|${num(p.minHeight, 1.5)}`;
    if (key === sh.key) return false;
    sh.key = key;
    const snapshot = reader.snapshot({ origin, minHole: num(p.minHole, 1.5), minHeight: num(p.minHeight, 1.5) }) as BoardSnapshotJson;
    const json = stableJson(snapshot as unknown as JsonObject);
    if (json === sh.json) return false;
    sh.json = json; sh.snapshot = snapshot;
    return true;
  }

  /** The worker's input: each Board feature gets its board as it is now. */
  private filter = (inputs: FeatureInput[]): FeatureInput[] => { this.sentRegen = performance.now(); return inputs.map(this.withBoard); };
  private withBoard = (f: FeatureInput): FeatureInput => {
    if (f.type !== BOARD_FEATURE || typeof f.params.board !== "string") return f;
    const sh = this.shown.get(f.id); if (!sh) return f;
    this.refresh(f, sh);
    return sh.snapshot ? { ...f, params: { ...f.params, $board: sh.snapshot } } : f;
  };

  private afterRegen = (result: RegenResult): void => {
    if (this.closed) return;
    if (this.waitingRegen) {
      this.stats.regens++; this.stats.lastRegenMs = performance.now() - this.waitingRegen; this.stats.lastWorkerMs = result.ms; this.stats.lastQueueMs = this.sentRegen - this.askedRegen; this.stats.lastRoundtripMs = performance.now() - this.sentRegen;
      this.waitingRegen = 0;
    }
    const onFace = this.features().some((f) => (f.params.plane as unknown as PlaneRef | undefined)?.kind === "face");
    if (onFace) {
      void this.studio.kernel.call("board-placement", {}).then((v) => {
        if (this.closed) return;
        this.workerFrames = (v || {}) as unknown as BoardLink["workerFrames"];
        for (const f of this.features()) { const sh = this.shown.get(f.id); if (sh) this.place(f, sh, null); }
      }).catch(() => { /* the kernel is busy or gone; the next regeneration asks again */ });
    }
    this.tell();
  };
}

declare global { interface Window { JunctionBoardLink?: BoardLink } }

studioExtensions.push((studio) => {
  const link = new BoardLink(studio);
  window.JunctionBoardLink = link;
  return () => { link.close(); if (window.JunctionBoardLink === link) delete window.JunctionBoardLink; };
});

/** The link of an open studio (the panel reads it). */
export function boardLinkOf(studio: PartStudio): BoardLink | null {
  const l = window.JunctionBoardLink;
  return l && l.studio === studio ? l : null;
}
