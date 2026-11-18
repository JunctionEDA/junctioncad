// driver.ts — keeps every board link of an open part studio solved.
//
// After each rebuild of the committed model (not a dialog's preview, not a sketch that is open, not a model
// rolled back) it asks the worker for the links' board geometry (solve.ts) and, when the answer differs from
// what the document holds, stores it in the link item.  That one change is what the board editor follows
// (web/domains/pcb/mech).  It is not an undo step: undoing the edit that moved the model moves the answer back.
//
// Every editor of the studio runs this; the answer is a function of the model, so they all write the same
// thing and whoever is second sends nothing.
import { stableJson, type ItemChange, type Json } from "../../../shared/itemdoc/itemdoc";
import { featuresOf } from "../document/format";
import type { PartStudio } from "../ui/studio";
import { linksOf, setSolved, type Solved } from "./format";

export interface DriverStatus { solving: boolean; error: string | null; /** how many times an answer was stored */ writes: number }

const SETTLE_MS = 120;

export class BoardLinkDriver {
  status: DriverStatus = { solving: false, error: null, writes: 0 };
  private timer = 0;
  private running = false;
  private again = false;
  /** what the last solve was asked: the links without their answers, and the rebuild it saw */
  private lastKey = "";
  private seenReports: unknown = null;
  private rebuilds = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly studio: PartStudio) {
    studio.subscribe(() => this.schedule());
    this.schedule();
  }

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getStatus = (): DriverStatus => this.status;
  private set(patch: Partial<DriverStatus>): void { this.status = { ...this.status, ...patch }; for (const fn of Array.from(this.listeners)) fn(); }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.run(), SETTLE_MS);
  }

  /** The model on screen is the document's, whole and built. */
  private quiet(): boolean {
    const s = this.studio.getState();
    return s.loaded && s.canEdit && !s.editing && !s.sketch && s.kernel.state === "ready" && s.rollback >= s.features.length
      && s.features.every((f) => f.suppressed || !!s.reports[f.id]);
  }

  private async run(): Promise<void> {
    if (this.running) { this.again = true; return; }
    const doc = this.studio.doc;
    if (!doc || !this.quiet()) return;
    const links = linksOf(doc);
    if (!links.length) return;
    const reports = this.studio.getState().reports;
    // a link placed by a Board feature takes that feature's origin on the sheet (solve.ts)
    const origins: { [featureId: string]: Json } = {};
    for (const f of featuresOf(doc)) if (f.featureType === "board-reference" && Array.isArray(f.params.origin)) origins[f.id] = f.params.origin as Json;
    const asked = stableJson([links.map((l) => ({ ...l, solved: null })), origins] as unknown as Json);
    if (reports !== this.seenReports) { this.seenReports = reports; this.rebuilds++; }
    const key = `${this.rebuilds}|${asked}`;
    if (key === this.lastKey) return;
    this.running = true; this.set({ solving: true });
    try {
      const answer = await this.studio.kernel.call<Json>("boardlink-solve", { links: links as unknown as Json, origins }) as unknown as { [id: string]: Solved };
      // the model moved on while the worker was busy: this answer may be of a preview
      if (!this.quiet() || this.studio.getState().reports !== reports || !this.studio.doc) { this.again = true; return; }
      const now = this.studio.doc;
      const changes: ItemChange[] = [];
      for (const l of linksOf(now)) if (answer[l.id]) changes.push(...setSolved(now, l.id, answer[l.id]));
      this.lastKey = key;
      if (changes.length && this.studio.commit(changes, { undoable: false })) this.set({ writes: this.status.writes + 1, error: null });
      else this.set({ error: null });
    } catch (e) {
      this.set({ error: (e as Error).message || String(e) });
    } finally {
      this.running = false; this.set({ solving: false });
      if (this.again) { this.again = false; this.schedule(); }
    }
  }
}

const drivers = new WeakMap<PartStudio, BoardLinkDriver>();
/** The studio's driver, started on first use. */
export function ensureDriver(studio: PartStudio): BoardLinkDriver {
  let d = drivers.get(studio);
  if (!d) { d = new BoardLinkDriver(studio); drivers.set(studio, d); }
  return d;
}
