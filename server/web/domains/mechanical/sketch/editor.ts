// editor.ts — the sketcher: what happens between opening a sketch and finishing it.
//
// One `SketchEditor` per part studio (`sketchEditor(studio)`).  While a sketch is open it
//   • holds the sketch as the document has it, and solves every edit before committing it (sketch/solver):
//     `edit((draft) => …)` is the one way a tool changes the sketch, and is one undo step;
//   • draws the sketch itself (sketch/paint.ts), coloured by what the solver says: free, settled, in conflict;
//   • owns the pointer and the keys: a tool file under tools/ hands it handlers with `useTool`, and when no
//     tool is in hand it selects, drags geometry under the solver, moves dimension texts and opens them for typing;
//   • keeps the selection (entity and constraint ids), the hover, the degrees of freedom and the hint line.
//
// The part studio (ui/studio.ts) knows none of this.  It says which sketch is open and which tool id is in
// hand; the editor follows by subscribing, and reaches the document only through `studio.commit`.
import { DEFAULT_PLANES, type Frame, type PlaneRef, type Vec2 } from "../core/geometry";
import { getPrefs, subscribePrefs } from "../ui/prefs";
import type { PartStudio } from "../ui/studio";
import { evaluate } from "./expr";
import { dimensionText, drawDimension, lenNum, angNum, setSketchUnits, sketchUnits, typedFactor } from "./dims";
import { angleSuffix } from "../document/units";
import type { SketchData } from "./format";
import { nearestOn } from "./infer";
import { Draft, normalise, sketchChange } from "./model";
import { SketchPainter, relatedEntities, type Box, type Preview, type Scene } from "./paint";
import { findRegions } from "./planar";
import type { Regions } from "./profiles";
import { ORIGIN, entitiesOf, isDimension, measure, pointAt, pointsOf, resolveEntity } from "./refs";
import { loadSolver } from "./solver/load";
import type { DragTarget, SketchSolver, SolveResult } from "./solver/solve";

/** What is under the pointer. */
export interface Target { id: string; kind: "point" | "curve" | "glyph" | "dimension"; /** the pointer in sketch coordinates */ p: Vec2 }

/** The pointer and key handling of a sketch tool.  Every handler is optional. */
export interface ToolHandlers {
  down?(ev: PointerEvent, ed: SketchEditor): void;
  move?(ev: PointerEvent, ed: SketchEditor): void;
  up?(ev: PointerEvent, ed: SketchEditor): void;
  /** A key while the tool is in hand; true when it was used. */
  key?(ev: KeyboardEvent, ed: SketchEditor): boolean;
  /** The tool is being put down (another was picked, the sketch was finished). */
  stop?(ed: SketchEditor): void;
}

export interface EditorState {
  open: boolean;
  featureId: string | null;
  /** the solver has started: edits are possible */
  ready: boolean;
  data: SketchData;
  /** degrees of freedom left; 0 is fully constrained */
  dof: number;
  /** "conflict": constraints that cannot all hold; "unsolved": the solver did not find a solution */
  health: "ok" | "conflict" | "unsolved";
  conflicting: string[];
  redundant: string[];
  /** the entities the constraints settle completely; null while that is being worked out */
  defined: ReadonlySet<string> | null;
  selection: string[];
  hover: string | null;
  /** new geometry is construction geometry */
  construction: boolean;
  tool: string;
  /** what the tool in hand is waiting for */
  hint: string;
  /** how long the last solve took */
  solveMs: number;
}

const editors = new WeakMap<PartStudio, SketchEditor>();
/** The sketch editor of a part studio (made on first use). */
export function sketchEditor(studio: PartStudio): SketchEditor {
  let e = editors.get(studio);
  if (!e) { e = new SketchEditor(studio); editors.set(studio, e); }
  return e;
}

const EMPTY: SketchData = { version: 1, entities: {}, constraints: {} };

export class SketchEditor {
  private state: EditorState = { open: false, featureId: null, ready: false, data: EMPTY, dof: 0, health: "ok", conflicting: [], redundant: [], defined: null, selection: [], hover: null, construction: false, tool: "select", hint: "", solveMs: 0 };
  private listeners = new Set<() => void>();
  private painter: SketchPainter | null = null;
  private solver: SketchSolver | null = null;
  private docRef: unknown = null;
  private handlers: ToolHandlers = {};
  private preview: Preview | null = null;
  private box: Scene["box"] = null;
  /** the sketch as a drag has it now, not yet committed */
  private dragData: SketchData | null = null;
  private regionsOf: SketchData | null = null;
  private regions: Regions | null = null;
  private probe = 0;
  private syncing = false;
  private input: HTMLInputElement | null = null;
  private editingId: string | null = null;
  /** the result of the solve an edit was committed with, so the sketch that comes back is not solved again */
  private expected: { json: string; result: SolveResult } | null = null;
  /** the last pointer event over the viewport, for tools that redraw on a key */
  lastPointer: PointerEvent | null = null;

  private disposed = false;
  private pendingDrag: DragTarget[] | null = null;
  private dragFrame = 0;
  private readonly unsubscribe: () => void;

  constructor(readonly studio: PartStudio) {
    this.unsubscribe = studio.subscribe(() => this.sync());
    studio.viewport.onFrame.push(() => this.paint());
    studio.viewport.onTheme.push(() => { this.painter?.readColors(); this.invalidate(); });
    subscribePrefs(() => this.invalidate());
    this.sync();
  }

  // ---------------------------------------------------------------- state
  getState = (): EditorState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of Array.from(this.listeners)) fn();
    this.invalidate();
  }
  invalidate(): void { this.studio.viewport.invalidate(); }

  /** The sketch as it is shown: the document's, or a drag's working copy. */
  get shown(): SketchData { return this.dragData || this.state.data; }
  get frame(): Frame | null {
    const id = this.state.featureId; if (!id) return null;
    const f = this.studio.getState().features.find((x) => x.id === id);
    const plane = f && (f.params.plane as unknown as PlaneRef | undefined);
    return this.studio.view.sketchFrame(id) || (plane && plane.kind === "plane" && DEFAULT_PLANES[plane.plane] ? DEFAULT_PLANES[plane.plane].frame : null);
  }
  /** millimetres per pixel */
  get px(): number { return this.studio.viewport.pixelSize(); }

  // ---------------------------------------------------------------- following the part studio
  private sync(): void {
    if (this.syncing || this.disposed) return;
    this.syncing = true;
    try {
      const s = this.studio.getState();
      if (s.units !== sketchUnits()) { setSketchUnits(s.units); this.invalidate(); }
      if (!s.sketch) { if (this.state.open) this.close(); return; }
      const f = s.features.find((x) => x.id === s.sketch!.featureId);
      if (!f) return;
      if (!this.state.open || this.state.featureId !== f.id) this.open(f.id);
      if (f.params.sketch !== this.docRef) { this.docRef = f.params.sketch; this.reload(normalise(f.params.sketch as unknown as SketchData)); }
      // the studio put the tool down (Esc), or picked one this editor has not been told about
      if (s.sketch.tool !== this.state.tool) this.adopt(s.sketch.tool, selectTool(this), "");
      this.install();
    } finally { this.syncing = false; }
  }

  private open(featureId: string): void {
    if (!this.painter) this.painter = new SketchPainter(this.studio.viewport);
    this.studio.view.setSketchHidden(featureId);
    this.docRef = null; this.dragData = null; this.preview = null; this.box = null; this.expected = null;
    this.handlers = selectTool(this);
    this.state = { ...this.state, open: true, featureId, data: EMPTY, selection: [], hover: null, tool: "select", hint: "", defined: null, construction: false };
    this.studio.viewport.canvas.focus();   // the sketch shortcuts (L, R, C, D, …) work at once
    (window as unknown as { JunctionSketch?: SketchEditor }).JunctionSketch = this;   // for tests and the console, as window.JunctionPartStudio
    if (!this.solver) void loadSolver().then((solver) => { this.solver = solver; this.set({ ready: true }); if (this.state.open) this.diagnose(); }, () => this.studio.host.toast("The sketch solver could not be started. Reload the page.", 6000));
    this.set({});
  }

  private close(): void {
    this.handlers.stop?.(this);
    this.handlers = {};
    this.closeInput();
    const w = window as unknown as { JunctionSketch?: SketchEditor }; if (w.JunctionSketch === this) delete w.JunctionSketch;
    this.studio.view.setSketchHidden(null);
    this.studio.viewport.canvas.style.cursor = "";
    this.painter?.clear();
    this.dragData = null; this.preview = null; this.box = null; this.docRef = null;
    clearTimeout(this.probe);
    this.set({ open: false, featureId: null, data: EMPTY, selection: [], hover: null, tool: "select", hint: "" });
  }

  /** The part studio is going away: put everything down and take the drawing layer out of the viewport. */
  dispose(): void {
    if (this.disposed) return;
    if (this.state.open) this.close();
    this.disposed = true;
    this.unsubscribe();
    this.painter?.dispose(); this.painter = null;
    this.listeners.clear();
    if (editors.get(this.studio) === this) editors.delete(this.studio);
  }

  /** The document's sketch changed (an edit here, an undo, somebody else): take it and see how it stands. */
  private reload(data: SketchData): void {
    this.dragData = null;
    const keep = (id: string) => id === ORIGIN || id in data.entities || id in data.constraints;
    this.state = { ...this.state, data, selection: this.state.selection.filter(keep), hover: this.state.hover && keep(this.state.hover) ? this.state.hover : null };
    this.diagnose();
  }

  /** Count the freedoms and find the conflicts of the sketch as it is.  Changes nothing in the document. */
  private diagnose(): void {
    const data = this.state.data;
    clearTimeout(this.probe);
    if (!this.solver) { this.set({}); return; }
    const r = this.expected && this.expected.json === JSON.stringify(data) ? this.expected.result : this.solver.solve(data);
    this.expected = null;
    const bad = r.conflicting.length > 0;
    this.set({ dof: r.dof, health: r.ok ? "ok" : bad ? "conflict" : "unsolved", conflicting: r.conflicting, redundant: r.redundant, defined: r.ok && r.dof === 0 ? new Set(Object.keys(data.entities)) : null, solveMs: r.ms });
    if (!r.ok || r.dof === 0) return;
    // which entities are settled: a solve each, spread over idle moments so a large sketch does not stall typing
    const steps = this.solver.definedSteps(data, r.dof);
    const run = () => {
      if (this.state.data !== data || !this.state.open) return;
      const until = performance.now() + 8;
      for (;;) {
        const s = steps.next();
        if (s.done) { this.set({ defined: s.value }); return; }
        if (performance.now() > until) break;
      }
      this.probe = window.setTimeout(run, 0);
    };
    this.probe = window.setTimeout(run, 30);
  }

  // ---------------------------------------------------------------- edits
  /**
   * Change the sketch.  `fn` edits a private copy; the result is solved and committed as one undo step.  Return
   * false from `fn` to change nothing.  Returns whether anything was committed.
   */
  edit(fn: (draft: Draft) => void | false): boolean {
    if (!this.state.open || !this.state.featureId) return false;
    if (!this.studio.getState().canEdit) { this.studio.host.toast("You have view-only access to this project.", 3000); return false; }
    const draft = new Draft(this.state.data);
    draft.construction = this.state.construction;
    if (fn(draft) === false) return false;
    return this.commit(draft.data);
  }

  /** Solve `next` and commit what differs from the document.  `quiet`: no message when it cannot be solved. */
  commit(next: SketchData, o: { quiet?: boolean } = {}): boolean {
    const id = this.state.featureId; if (!id) return false;
    let out = next;
    if (this.solver) {
      const r = this.solver.solve(next);
      if (r.ok) out = r.data;
      else if (!o.quiet) this.studio.host.toast(r.conflicting.length ? "These constraints cannot all hold. The ones in conflict are shown in red: delete one, or undo." : "The sketch could not be solved with that change. Undo, or loosen a constraint.", 5000);
      this.expected = { json: JSON.stringify(out), result: r };
    }
    const change = sketchChange(id, this.state.data, out);
    this.dragData = null;
    if (!change) { this.expected = null; this.invalidate(); return false; }
    return this.studio.commit([change]);   // the document changes, and `sync` takes it from there
  }

  /** How a sketch would stand if it were committed: solved, with its freedoms and conflicts.  Changes nothing. */
  check(data: SketchData): SolveResult | null { return this.solver ? this.solver.solve(data) : null; }

  // ---------------------------------------------------------------- selection
  select(ids: readonly string[]): void { this.set({ selection: Array.from(new Set(ids)) }); }
  toggle(id: string): void { const s = this.state.selection; this.select(s.includes(id) ? s.filter((x) => x !== id) : [...s, id]); }
  setHover(id: string | null): void { if (id !== this.state.hover) this.set({ hover: id }); }
  setHint(hint: string): void { if (hint !== this.state.hint) this.set({ hint }); }

  /** Delete what is selected: entities with what hangs on them, and constraints. */
  deleteSelection(): boolean {
    const ids = this.state.selection.filter((id) => id !== ORIGIN);
    if (!ids.length) return false;
    this.select([]);
    return this.edit((d) => d.remove(ids));
  }

  /** Flip construction on the selected curves; with none selected, flip it for what is drawn next. */
  toggleConstruction(): void {
    const curves = this.state.selection.filter((id) => { const e = this.state.data.entities[id]; return e && e.type !== "point"; });
    if (!curves.length) { this.set({ construction: !this.state.construction }); return; }
    const on = !curves.every((id) => this.state.data.entities[id].construction);
    this.edit((d) => { for (const id of curves) { const e = { ...d.data.entities[id] }; if (on) e.construction = true; else delete e.construction; d.set(id, e); } });
  }

  // ---------------------------------------------------------------- tools
  /** Take a tool in hand.  `id` is the tool's id as the toolbar knows it; "select" puts tools down. */
  useTool(id: string, handlers: ToolHandlers, hint = ""): void {
    if (!this.state.open) return;
    this.adopt(id, handlers, hint);
    if (this.studio.getState().sketch?.tool !== id) this.studio.setSketchTool(id);
    this.install();
    this.studio.viewport.canvas.focus();
  }
  useSelect(): void { this.useTool("select", selectTool(this)); }
  private adopt(id: string, handlers: ToolHandlers, hint: string): void {
    this.handlers.stop?.(this);
    this.closeInput();
    this.studio.viewport.canvas.style.cursor = id === "select" ? "" : "crosshair";
    this.handlers = handlers; this.preview = null; this.box = null; this.dragData = null;
    this.set({ tool: id, hint, hover: null });
  }
  /** The part studio clears these whenever its tool changes; they are this editor's while a sketch is open. */
  private install(): void {
    const view = this.studio.view;
    if (view.pointerTool !== this.pointer) view.pointerTool = this.pointer;
    if (this.studio.keyHandler !== this.onKey) this.studio.keyHandler = this.onKey;
  }
  private pointer = {
    // the part studio may take the pointer for a moment (choosing another plane for the sketch)
    down: (ev: PointerEvent) => { this.lastPointer = ev; if (this.studio.pointerOverride) return; this.handlers.down?.(ev, this); },
    move: (ev: PointerEvent) => { this.lastPointer = ev; const o = this.studio.pointerOverride; if (o) { o.move?.(ev); return; } this.handlers.move?.(ev, this); },
    up: (ev: PointerEvent) => { this.lastPointer = ev; const o = this.studio.pointerOverride; if (o) { o.up?.(ev); return; } this.handlers.up?.(ev, this); },
  };
  private onKey = (ev: KeyboardEvent): boolean => {
    if (!this.state.open) return false;
    if (this.handlers.key && this.handlers.key(ev, this)) return true;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
    if (ev.key === "Escape") {
      if (this.studio.pointerOverride) return false;   // the part studio's Esc stops what took the pointer
      if (this.state.tool !== "select") { this.useSelect(); return true; }
      if (this.state.selection.length) this.select([]);
      return true;   // Esc never leaves the sketch: one press too many would throw the person out of it
    }
    if (ev.key === "Delete" || ev.key === "Backspace") { this.deleteSelection(); return true; }
    if (ev.key === "Tab") return true;   // Tab moves between typed measures; it never takes the keyboard away from the sketch
    // a sketch tool's key wins over any other tool's while a sketch is open (M is Mirror here, whatever it is outside)
    const tool = ev.key.length === 1 ? this.studio.tools().find((t) => t.group === "sketch" && !!t.key && t.key.toLowerCase() === ev.key.toLowerCase()) : undefined;
    if (tool && !(tool.disabled && tool.disabled(this.studio))) { tool.run(this.studio); return true; }
    return false;
  };

  /** Show what a tool is about to draw (null: nothing). */
  setPreview(p: Preview | null): void { this.preview = p; this.invalidate(); }
  setBox(b: Scene["box"]): void { this.box = b; this.invalidate(); }

  // ---------------------------------------------------------------- the pointer
  /** The pointer in sketch coordinates. */
  planePoint(ev: { clientX: number; clientY: number }): Vec2 | null { const f = this.frame; return f ? this.studio.view.planePoint(ev, f) : null; }
  /** The pointer in canvas pixels. */
  canvasPoint(ev: { clientX: number; clientY: number }): { x: number; y: number } { const r = this.studio.viewport.canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }

  /** What is under the pointer: a point before a glyph or a dimension's text before a curve. */
  hit(ev: { clientX: number; clientY: number }, o: { boxes?: boolean; curves?: boolean; points?: boolean; skip?: ReadonlySet<string> } = {}): Target | null {
    const p = this.planePoint(ev); if (!p || !this.painter) return null;
    const data = this.shown, px = this.px, at = this.canvasPoint(ev);
    if (o.points !== false) {
      let best = 8 * px, id: string | null = null;
      for (const [pid, e] of Object.entries(data.entities)) {
        if (e.type !== "point" || o.skip?.has(pid)) continue;
        const d = Math.hypot(e.x - p[0], e.y - p[1]);
        if (d < best) { best = d; id = pid; }
      }
      if (id) return { id, kind: "point", p };
      if (Math.hypot(p[0], p[1]) < 8 * px && !o.skip?.has(ORIGIN)) return { id: ORIGIN, kind: "point", p };
    }
    if (o.boxes !== false) {
      const boxes = this.painter.boxes;
      for (let i = boxes.length - 1; i >= 0; i--) { const b: Box = boxes[i]; if (at.x >= b.x - 1 && at.x <= b.x + b.w + 1 && at.y >= b.y - 1 && at.y <= b.y + b.h + 1) return { id: b.id, kind: b.kind, p }; }
    }
    if (o.curves !== false) {
      let best = 6 * px, id: string | null = null;
      for (const cid of Object.keys(data.entities)) {
        if (o.skip?.has(cid)) continue;
        const r = resolveEntity(data, cid); if (!r || r.kind === "point") continue;
        const n = nearestOn(r, p);
        if (n && n.d < best) { best = n.d; id = cid; }
      }
      if (id) return { id, kind: "curve", p };
    }
    return null;
  }

  // ---------------------------------------------------------------- dragging under the solver
  /** Pull things towards the pointer and show the result; nothing is committed until `endDrag`. */
  drag(targets: DragTarget[]): boolean {
    if (!this.solver) return false;
    const r = this.solver.solve(this.dragData || this.state.data, { drag: targets, diagnose: false });
    if (!r.ok) return false;
    this.dragData = r.data;
    this.state = { ...this.state, solveMs: r.ms };
    this.invalidate();
    return true;
  }
  /**
   * `drag`, at most once a frame: pointer moves can arrive faster than a large sketch solves, and only the
   * latest position matters.
   */
  dragSoon(targets: DragTarget[]): void {
    this.pendingDrag = targets;
    if (this.dragFrame) return;
    this.dragFrame = requestAnimationFrame(() => { this.dragFrame = 0; const t = this.pendingDrag; this.pendingDrag = null; if (t && this.state.open) this.drag(t); });
  }
  /** Show a changed sketch without solving or committing it (a dimension's text being moved). */
  showDraft(data: SketchData | null): void { this.dragData = data; this.invalidate(); }
  /** Commit what a drag arrived at (or drop it). */
  endDrag(commit = true): void {
    if (this.dragFrame) { cancelAnimationFrame(this.dragFrame); this.dragFrame = 0; }
    const last = this.pendingDrag; this.pendingDrag = null;
    if (last && commit) this.drag(last);   // the position the pointer was let go at
    const d = this.dragData; this.dragData = null;
    if (d && commit) this.commit(d, { quiet: true }); else this.invalidate();
  }

  // ---------------------------------------------------------------- typing a dimension's value
  /** Open a dimension for typing, at its text.  `fresh`: it was just placed (Esc keeps what it measured). */
  editDimension(id: string, done?: () => void): void {
    this.closeInput();
    const c = this.state.data.constraints[id]; if (!c || !isDimension(c) || !this.painter) return;
    const d = drawDimension(this.state.data, c, this.px); if (!d) return;
    this.paint();
    const at = this.painter.screen(d.label);
    const input = document.createElement("input");
    input.className = "input mono cad-dim-input";
    input.type = "text"; input.spellcheck = false; input.autocomplete = "off";
    input.setAttribute("aria-label", "Dimension value");
    input.style.cssText = `position:absolute;z-index:4;left:${Math.round(at.x - 44)}px;top:${Math.round(at.y - 12)}px;width:88px;height:24px;text-align:center;padding:0 4px`;
    const shownValue = typeof c.value === "number" ? c.value : measure(this.state.data, c) ?? 0;
    // the value as the document's units have it, with the unit written out; typing a bare number means that unit
    const angle = c.type === "angle", u = sketchUnits();
    input.value = typeof c.expr === "string" && c.expr ? c.expr : angle ? `${angNum(shownValue)}${angleSuffix(u.angle).trim() === "°" ? "°" : " rad"}` : `${lenNum(shownValue)} ${u.length}`;
    input.title = `In ${angle ? (u.angle === "deg" ? "degrees" : "radians") : u.length}. Type another unit to convert: 1 in, 25.4 mm, 3/8 in + 2 mm.`;
    let closed = false;
    const finish = (apply: boolean) => {
      if (closed) return;
      if (apply) {
        let parsed;
        try { parsed = evaluate(input.value, angle ? "angle" : "length", typedFactor(angle)); }
        catch (err) { input.classList.add("bad"); input.title = (err as Error).message; this.studio.host.toast((err as Error).message, 3000); return; }
        if ((c.type !== "angle" && !(parsed.value > 0) && !(c.type === "distance" && parsed.value === 0)) || parsed.value < 0) { input.classList.add("bad"); this.studio.host.toast("A dimension must be more than zero.", 3000); return; }
        const text = input.value.trim();
        closed = true;
        this.closeInput();
        this.edit((draft) => {
          const now = draft.data.constraints[id]; if (!now) return false;
          const next = { ...now, value: parsed.value, driving: true };
          if (parsed.isExpression) next.expr = text; else delete next.expr;
          draft.data.constraints[id] = next;
        });
      } else { closed = true; this.closeInput(); }
      this.studio.viewport.canvas.focus();
      done?.();
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      else input.classList.remove("bad");
    });
    input.addEventListener("blur", () => { if (!closed) finish(!!tryValue(input.value, angle)); if (!closed) finish(false); });
    for (const t of ["pointerdown", "pointerup", "dblclick", "wheel"]) input.addEventListener(t, (ev) => ev.stopPropagation());
    this.studio.viewport.host.appendChild(input);
    this.input = input; this.editingId = id;
    // after the click that opened it has finished: a press on the canvas takes the focus as its default action
    window.setTimeout(() => { if (this.input === input) { input.focus(); input.select(); } }, 0);
    this.invalidate();
  }
  private closeInput(): void {
    const i = this.input; this.input = null; this.editingId = null;
    if (i) i.remove();
    this.invalidate();
  }
  /** True while a dimension's value is being typed. */
  get typing(): boolean { return !!this.input; }

  // ---------------------------------------------------------------- drawing
  private paint(): void {
    if (!this.state.open || !this.painter || this.disposed) return;
    const frame = this.frame; if (!frame) { this.painter.clear(); return; }
    const s = this.state, data = this.shown;
    if (this.regionsOf !== data) { this.regionsOf = data; try { this.regions = findRegions(data); } catch { this.regions = null; } }
    const conflicting = new Set(s.conflicting), redundant = new Set(s.redundant);
    const inConflict = new Set<string>();
    for (const id of s.conflicting) { const c = data.constraints[id]; if (c) for (const e of entitiesOf(data, c)) inConflict.add(e); }
    const related = new Set<string>();
    for (const id of [s.hover, ...s.selection]) { const c = id ? data.constraints[id] : null; if (c) for (const e of relatedEntities(data, c)) related.add(e); }
    const settled = s.defined;
    this.painter.draw({
      data, frame,
      state: (id) => (inConflict.has(id) ? "conflict" : s.health !== "ok" ? "under" : s.dof === 0 || (settled && settled.has(id)) ? "defined" : "under"),
      selection: new Set(s.selection), hover: s.hover, related, conflicting, redundant,
      regions: this.regions, preview: this.preview, box: this.box, editing: this.editingId, glyphs: getPrefs().showConstraints,
    });
  }

  /** The text of a dimension, as it is drawn. */
  textOf(id: string): string { const c = this.state.data.constraints[id]; return c ? dimensionText(this.state.data, c) : ""; }
}

function tryValue(text: string, angle: boolean): boolean { try { evaluate(text, angle ? "angle" : "length", typedFactor(angle)); return true; } catch { return false; } }

// ---------------------------------------------------------------- the tool when no tool is in hand
/**
 * Select: click picks (Shift or Ctrl adds), a drag on empty space boxes, a drag on geometry moves it as far as
 * the constraints allow, a drag on a dimension's text moves the text, and a double click on it opens it.
 */
function selectTool(ed: SketchEditor): ToolHandlers {
  let down: { x: number; y: number; target: Target | null; moved: boolean; many: boolean; start: Vec2; origin: { [id: string]: Vec2 }; label: Vec2 | null } | null = null;
  let lastClick = { id: "", t: 0 };
  return {
    down(ev) {
      const target = ed.hit(ev), p = ed.planePoint(ev) || [0, 0];
      const origin: { [id: string]: Vec2 } = {};
      let label: Vec2 | null = null;
      const data = ed.getState().data;
      if (target && target.kind === "curve") for (const pid of pointsOf(data.entities[target.id])) { const q = pointAt(data, pid); if (q) origin[pid] = q; }
      if (target && target.kind === "dimension") { const d = drawDimension(data, data.constraints[target.id], ed.px); label = d ? d.label : null; }
      down = { x: ev.clientX, y: ev.clientY, target, moved: false, many: ev.shiftKey || ev.ctrlKey || ev.metaKey, start: p, origin, label };
    },
    move(ev) {
      if (!down) { const t = ed.hit(ev); ed.setHover(t ? t.id : null); return; }
      if (!down.moved && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 4) return;
      down.moved = true;
      const p = ed.planePoint(ev); if (!p) return;
      const t = down.target, data = ed.getState().data;
      if (!t) { const a = ed.canvasPoint({ clientX: down.x, clientY: down.y }), b = ed.canvasPoint(ev); ed.setBox({ x0: a.x, y0: a.y, x1: b.x, y1: b.y }); return; }
      if (t.kind === "point") { if (t.id !== ORIGIN) ed.dragSoon([{ point: t.id, to: p }]); return; }
      if (t.kind === "dimension" && down.label) {
        const c = data.constraints[t.id]; if (!c) return;
        const at: Vec2 = [down.label[0] + p[0] - down.start[0], down.label[1] + p[1] - down.start[1]];
        ed.showDraft({ ...data, constraints: { ...data.constraints, [t.id]: { ...c, label: { x: at[0], y: at[1] } } } });
        return;
      }
      if (t.kind !== "curve") return;
      const e = data.entities[t.id]; if (!e) return;
      if (e.type === "line") ed.dragSoon([e.a, e.b].filter((pid) => down!.origin[pid]).map((pid) => ({ point: pid, to: [down!.origin[pid][0] + p[0] - down!.start[0], down!.origin[pid][1] + p[1] - down!.start[1]] as Vec2 })));
      else if (e.type === "circle" || e.type === "arc") { const c = down.origin[e.center]; if (c) ed.dragSoon([{ curve: t.id, radius: Math.max(1e-3, Math.hypot(p[0] - c[0], p[1] - c[1])) }]); }
    },
    up(ev) {
      const d = down; down = null;
      if (!d) return;
      if (d.moved) {
        if (!d.target) {
          // the box takes every entity that lies wholly inside it
          const a = ed.planePoint({ clientX: d.x, clientY: d.y }), b = ed.planePoint(ev);
          ed.setBox(null);
          if (!a || !b) return;
          const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1])], hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
          const data = ed.getState().data;
          const inside = (pid: string) => { const q = pointAt(data, pid); return !!q && q[0] >= lo[0] && q[0] <= hi[0] && q[1] >= lo[1] && q[1] <= hi[1]; };
          const ids = Object.keys(data.entities).filter((id) => {
            const e = data.entities[id];
            if (e.type === "point") return inside(id);
            if (e.type === "circle") { const c = pointAt(data, e.center); return !!c && c[0] - e.r >= lo[0] && c[0] + e.r <= hi[0] && c[1] - e.r >= lo[1] && c[1] + e.r <= hi[1]; }
            return pointsOf(e).filter((pid) => e.type !== "arc" || pid !== e.center).every(inside);
          });
          ed.select(d.many ? [...ed.getState().selection, ...ids] : ids);
          return;
        }
        ed.endDrag(true);
        return;
      }
      const t = d.target;
      if (!t) { if (!d.many) ed.select([]); return; }
      const now = performance.now();
      if (t.kind === "dimension" && lastClick.id === t.id && now - lastClick.t < 450) { lastClick = { id: "", t: 0 }; ed.select([t.id]); ed.editDimension(t.id); return; }
      lastClick = { id: t.id, t: now };
      const sel = ed.getState().selection;
      if (d.many) ed.toggle(t.id);
      else ed.select(sel.length === 1 && sel[0] === t.id ? [] : [t.id]);
    },
    stop() { ed.setBox(null); ed.showDraft(null); },
  };
}
