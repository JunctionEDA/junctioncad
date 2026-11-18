// mech/sync.ts — the board editor's end of the board link: while a board is open it watches the project's part
// studios (links.ts), keeps the board's driven items equal to what their links ask for (boarditems.ts), and
// runs the enclosure check (check.ts).
//
// How a driven item reaches the board.  The reconciler builds ordinary item changes and puts them through the
// board's own change path: applied to the document here, journalled and sent as one op (editor/net.ts sendOp),
// sequenced, stored and broadcast by the server like any edit, so collaborators, the desktop client, version
// history and the stored file all see them.  They are NOT pushed on this person's undo list: the board follows
// the model, and what undoes a move of the outline is undoing the edit in the part studio that moved it.
//
// When.  Live while the board is open (a link changes, or somebody edits a driven item on the board), and
// once on open for whatever changed in the model while no browser had the board open.  Every editor of the
// board runs this; the items and their ids are a function of the link, so whoever is second finds nothing to do.
import { store, state } from "../editor/appstore";
import { applyChanges } from "../editor/doc";
import { sendOp } from "../editor/net";
import { E } from "../editor/state";
import { toolCtx } from "../editor/tools";
import { toast } from "../editor/util";
import { historyActive } from "../editor/versions";
import { centerOn } from "../editor/comments";
import { requestRender } from "../editor/view";
import { loadViewer } from "../editor/viewer3d-loader";
import { drivenId, isDrivenId } from "../../mechanical/api";
import { desiredItems, liveGroups, reconcile, type BoardChange, type BoardItemView, type BoardView, type DrivenItem, type LinkSource } from "./boarditems";
import { clashText, heightClashes, headroom, keepoutAreas, parseHeight, type Clash, type KeepoutArea, type PartBody } from "./check";
import { LinkWatch } from "./links";

const MARKER_CODE = "enclosure_height";
const membersOf = (node: SNode): string[] => { const m = KiCadCanvas.kid(node, "members"); return m ? m.slice(1).map((x) => KiCadCanvas.str(x)) : []; };
const wrapFragment = (doc: KDoc, sexpr: string): string => (KiCadCanvas as unknown as { wrapFragment(doc: KDoc, body: string): string }).wrapFragment(doc, sexpr);
const TYPE_NAMES: Record<string, string> = { footprint: "FOOTPRINT", zone: "ZONE", group: "PCB_GROUP" };

export interface MechState {
  /** a board is open and its project has part studios to watch */
  active: boolean;
  boardId: string;
  sources: LinkSource[];
  /** every part studio has been read */
  complete: boolean;
  /** the driven items on the board, by drive ("<link>/<drive>") */
  driven: { [key: string]: string[] };
  /** driven items nobody asks for (their link is gone and they could not be released: view-only) */
  orphans: string[];
  areas: KeepoutArea[];
  clashes: Clash[];
  /** the check has run on the board as it is */
  checked: boolean;
  /** how many times the reconciler wrote to the board */
  writes: number;
  /** when it last did (Date.now()), for the badge's "updated" */
  wroteAt: number;
  canEdit: boolean;
}

interface BodyLike { ref: string; back: boolean; pts: [number, number][]; height: number }

class MechSync {
  readonly links = new LinkWatch();
  private s: MechState = { active: false, boardId: "", sources: [], complete: false, driven: {}, orphans: [], areas: [], clashes: [], checked: false, writes: 0, wroteAt: 0, canEdit: false };
  private listeners = new Set<() => void>();
  private timer = 0; private checkTimer = 0;
  private lastStamp = "";
  private normCache = new Map<string, string>();
  /** what the reconciler last wrote for an id and what the board then held: an item the board's writer spells differently is not written again and again */
  private settled = new Map<string, { want: string; got: string }>();
  private checkGen = 0;
  private checkedKey = "";

  constructor() {
    this.links.subscribe(() => { this.refresh(); this.schedule(); });
    store.subscribe(() => this.onStore());
  }

  getState = (): MechState => this.s;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<MechState>): void { this.s = { ...this.s, ...patch }; for (const fn of Array.from(this.listeners)) { try { fn(); } catch (e) { console.warn(e); } } }

  private board(): KDoc | null { const d = E.kdoc as KDoc | null; return d && d.type === "pcb" && !(d as KDoc & { fpEditor?: unknown }).fpEditor ? d : null; }
  private canEdit(): boolean { return !!this.board() && !E.viewOnly && !historyActive(); }
  thickness(): number { const d = this.board() as (KDoc & { thickness?: number }) | null; return Math.max(0.1, Number(d && d.thickness) || 1.6); }

  // ---------------------------------------------------------------- following the editor
  private onStore(): void {
    const st = store.get();
    const doc = this.board();
    const boardId = doc && st.view === "editor" && state.docId && !/^(board|lib):/.test(state.docId) ? state.docId : "";
    const docs = (state.project && state.project.docs) || [];
    const stamp = [boardId, docs.map((d) => d.docId).join(","), st.document.version, st.connection.edits, st.undo.undo, st.undo.redo, st.viewOnly].join("|");
    if (stamp === this.lastStamp) return;
    const boardChanged = boardId !== this.s.boardId;
    this.lastStamp = stamp;
    if (!boardId) { if (this.s.active || this.links.boardId) { this.links.stop(); this.settled.clear(); this.set({ active: false, boardId: "", sources: [], driven: {}, orphans: [], areas: [], clashes: [], checked: false, complete: false }); } return; }
    if (boardChanged) { this.settled.clear(); this.set({ boardId, active: false, sources: [], driven: {}, orphans: [], areas: [], clashes: [], checked: false }); }
    this.links.start(boardId, docs, !!state.me);
    this.refresh();
    this.schedule();
  }

  /** Read the links and the board again (no writes). */
  private refresh(): void {
    const doc = this.board(); if (!doc || !this.s.boardId) return;
    const sources = this.links.sources();
    const driven: MechState["driven"] = {}; const claimed = new Set<string>();
    for (const { link } of sources) for (const id of Object.keys(link.drives)) {
      const g = doc.items.get(drivenId(link.id, id, "group", 0));
      const members = g ? membersOf(g.node).filter((m: string) => doc.items.has(m)) : [];
      driven[`${link.id}/${id}`] = members;
      if (g) claimed.add(g.id); for (const m of members) claimed.add(m);
    }
    const orphans: string[] = [];
    for (const it of doc.items.values()) if (isDrivenId(it.id) && !claimed.has(it.id) && it.kind === "group") orphans.push(it.id);
    const areas = keepoutAreas(sources, this.thickness(), (l, d, n) => drivenId(l, d, "keepout", n));
    this.set({ active: this.links.studioCount > 0, sources, complete: this.links.complete, driven, orphans, areas, canEdit: this.canEdit() });
    this.scheduleCheck();
  }

  // ---------------------------------------------------------------- reconciling
  private schedule(): void {
    clearTimeout(this.timer);
    // a little apart for each browser, so two people with the board open rarely write the same op twice
    this.timer = window.setTimeout(() => this.reconcileNow(), 120 + Math.random() * 180);
  }

  private normalise = (sexpr: string): string => {
    let n = this.normCache.get(sexpr);
    if (n === undefined) {
      if (this.normCache.size > 4000) this.normCache.clear();
      n = JSON.stringify(KiCadCanvas.parse(sexpr)); this.normCache.set(sexpr, n);
    }
    return n;
  };

  private view(doc: KDoc, desired: readonly DrivenItem[]): BoardView {
    const want = new Map(desired.map((d) => [d.id, d]));
    const self = this;
    return {
      *driven(): Iterable<BoardItemView> {
        for (const it of doc.items.values()) {
          if (!isDrivenId(it.id)) continue;
          let sexpr = KiCadCanvas.serialize(it.node);
          // written before, and the board holds what it held right after: its writer's spelling, not an edit
          const d = want.get(it.id), was = self.settled.get(it.id);
          if (d && was && was.want === self.normalise(d.sexpr) && was.got === self.normalise(sexpr)) sexpr = d.sexpr;
          yield { id: it.id, kind: it.kind, typeName: TYPE_NAMES[it.kind] || "PCB_SHAPE", sexpr, members: it.kind === "group" ? membersOf(it.node) : undefined };
        }
      },
      normalise: this.normalise,
      wrap: (sexpr) => wrapFragment(doc, sexpr),
      unlocked: (sexpr) => {
        const node = KiCadCanvas.parse(sexpr); if (!node) return sexpr;
        for (let i = node.length - 1; i > 0; i--) { const c = node[i]; if (c === "locked" || (Array.isArray(c) && c[0] === "locked")) node.splice(i, 1); }
        return KiCadCanvas.serialize(node);
      },
    };
  }

  /** Make the board's driven items what the links ask for.  Returns the number of changes written. */
  reconcileNow(): number {
    clearTimeout(this.timer);
    const doc = this.board();
    if (!doc || !this.s.boardId || !this.canEdit()) { this.refresh(); return 0; }
    const sources = this.links.sources();
    const desired = desiredItems(sources, this.thickness());
    const r = reconcile(desired, this.view(doc, desired), liveGroups(sources), this.links.complete);
    if (!r.changes.length) { this.refresh(); return 0; }
    const changes = r.changes as unknown as KChange[];
    applyChanges(changes);
    sendOp(changes);
    // remember what the board made of each item, so its own spelling of it is not taken for an edit
    for (const c of r.changes as BoardChange[]) {
      const it = doc.items.get(c.id), d = desired.find((x) => x.id === c.id);
      if (it && d && c.kind !== "REMOVED") this.settled.set(c.id, { want: this.normalise(d.sexpr), got: this.normalise(KiCadCanvas.serialize(it.node)) }); else this.settled.delete(c.id);
    }
    this.set({ writes: this.s.writes + 1, wroteAt: Date.now() });
    // following the model is routine and is shown on the badge; a release is said out loud, once
    if (r.released.length && !r.added && !r.modified && !r.removed) toast("A link was broken: what it made stays on the board, unlocked", 2600);
    window.setTimeout(() => this.set({}), 2600);
    this.refresh();
    return r.changes.length;
  }

  // ---------------------------------------------------------------- the enclosure check
  /** What the check depends on: the board as it is (the store's stamp) and the keep-outs. */
  private checkKey(): string { return this.lastStamp + "|" + this.s.areas.map((a) => `${a.zone}:${a.limit}:${a.side}:${a.loop.join(";")}`).join("|"); }

  private scheduleCheck(): void {
    clearTimeout(this.checkTimer);
    if (!this.s.areas.length) { this.checkedKey = ""; if (this.s.clashes.length || !this.s.checked) { this.setMarkers([]); this.set({ clashes: [], checked: true }); } return; }
    if (this.checkKey() === this.checkedKey) return;      // nothing it depends on has changed
    if (this.s.checked) this.set({ checked: false });      // what is shown is of an earlier board
    this.checkTimer = window.setTimeout(() => void this.check(), 250);
  }

  /** The components of the board as bodies: outline, side and height. */
  async parts(): Promise<PartBody[]> {
    const doc = this.board(); if (!doc) return [];
    const viewer = await loadViewer() as unknown as { geometry: { boardBodies(doc: KDoc, withDnp?: boolean): BodyLike[] } };
    const now = this.board(); if (!now) return [];
    const byRef = new Map<string, KItem>();
    for (const it of now.items.values()) if (it.kind === "footprint" && it.ref) byRef.set(it.ref, it);
    const out: PartBody[] = [];
    for (const b of viewer.geometry.boardBodies(now, true)) {
      const it = byRef.get(b.ref); if (!it || isDrivenId(it.id) || b.pts.length < 3) continue;
      let field: number | null = null;
      for (const p of KiCadCanvas.kids(it.node, "property")) if (/^height$/i.test(KiCadCanvas.str(p[1]))) field = parseHeight(KiCadCanvas.str(p[2]));
      out.push({ id: it.id, ref: b.ref, back: b.back, pts: b.pts, height: field ?? b.height, source: field !== null ? "field" : "estimate" });
    }
    return out;
  }

  async check(): Promise<Clash[]> {
    const gen = ++this.checkGen, key = this.checkKey();
    let parts: PartBody[];
    try { parts = await this.parts(); } catch (e) { console.warn(e); return this.s.clashes; }
    if (gen !== this.checkGen) return this.s.clashes;
    const clashes = heightClashes(parts, this.s.areas);
    this.setMarkers(clashes);
    this.checkedKey = key;
    this.set({ clashes, checked: key === this.checkKey() });
    if (key !== this.checkKey()) this.scheduleCheck();
    return clashes;
  }

  /** The room over a component in the keep-outs it stands in (cross-probe: where a part sits against the enclosure). */
  async roomOver(footprintId: string): Promise<{ part: PartBody; rooms: { area: KeepoutArea; room: number }[] } | null> {
    const part = (await this.parts()).find((p) => p.id === footprintId);
    return part ? { part, rooms: headroom(part, this.s.areas) } : null;
  }

  private setMarkers(clashes: readonly Clash[]): void {
    const others = ((E.markers || []) as { code?: string }[]).filter((m) => m && m.code !== MARKER_CODE);
    if (!clashes.length && others.length === (E.markers || []).length) return;
    const all = others.concat(clashes.map((c) => ({ code: MARKER_CODE, severity: "error", x: c.x, y: c.y, text: clashText(c), ids: [c.part, c.area.zone] })));
    E.markers = all; E.renderOpts.markers = all.length ? all : undefined;
    store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) });
    requestRender();
  }

  // ---------------------------------------------------------------- what the panel does
  select(ids: readonly string[], centre = true): void {
    const doc = this.board(); if (!doc) return;
    const here = ids.filter((id) => doc.items.has(id)); if (!here.length) return;
    (toolCtx() as unknown as { setSelection(ids: string[]): void }).setSelection(here);
    if (!centre) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of here) { const b = doc.items.get(id)!.bbox; if (b) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); } }
    if (isFinite(x0)) centerOn((x0 + x1) / 2, (y0 + y1) / 2);
  }

  /** Stop a drive from driving this board.  What it made stays, unlocked (the next reconcile releases it). */
  breakLink(source: LinkSource, driveId?: string): boolean {
    if (!this.links.breakLink(source.studioDoc, source.link, driveId)) return false;
    this.reconcileNow();
    return true;
  }
}

export const mech = new MechSync();
