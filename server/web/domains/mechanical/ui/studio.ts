// studio.ts — an open part studio: the one object that ties the document's session, the modelling worker and
// the viewport together, and that every tool, panel and dialog is handed.
//
//   studio.getState()            what is on screen, as an immutable snapshot (React reads it with ui/hooks.ts)
//   studio.commit(changes)       the one way the document changes (see document/edits.ts for the changes)
//   studio.kernel.call(...)      ask a worker service about the model
//   studio.view                  the viewport (picking, overlays, camera)
//
// It holds the interface state that is not in the document: the selection, the feature being edited (a draft
// that is committed when its dialog is accepted), the sketch that is open and the tool in hand.
import type { ItemChange, ItemDoc, JsonObject } from "../../../shared/itemdoc/itemdoc";
import { clone } from "../../../shared/itemdoc/itemdoc";
import { ItemDocSession, type SessionPeer, type SessionStatus } from "../../../shared/itemdoc/sync";
import type { DocumentHostContext } from "../../../platform/documents/host";
import { Viewport3D } from "../../../shared/viewport3d/viewport3d";
import * as THREE from "three";
import type { FeatureDefinition, ParamField } from "../core/feature";
import type { PlaneRef } from "../core/geometry";
import { DEFAULT_PLANES } from "../core/geometry";
import * as edits from "../document/edits";
import { PART_STUDIO_KIND, featureInputs, featuresOf, nextName, orderAt, rollbackIndex, type FeatureItem } from "../document/format";
import { FEATURES, TOOLS } from "../generated/page";
import { KernelClient, type KernelState } from "../kernel/client";
import type { BodyResult, DatumView, FeatureInput, FeatureReport, RegenResult, SketchView } from "../kernel/protocol";
import { studioInputs, type InputFilter } from "../document/inputs";
import { DEFAULT_UNITS, setUnits as unitChanges, unitsOf, type Units } from "../document/units";
import { setMeasureUnits } from "../inspect/measure-format";
import { ModelView, pickKey, type Pick, type PickKind } from "../viewport/modelview";
import { DEFAULT_GEOMETRY } from "../viewport/planes";
import { fillFromSelection, heldPicks, holdsOne, neighbourField, nextEmptyField, pickKindsFor, takesPicks, valueAfterPick } from "./fields";
import { getPrefs, readVisibility, writeVisibility, type Visibility } from "./prefs";

export interface EditingFeature {
  /** the feature as the dialog shows it; the document is not changed until the dialog is accepted */
  draft: FeatureItem;
  isNew: boolean;
  /** the dialog field that viewport clicks fill, when one is active */
  field: string | null;
  /** show the whole model with this feature in it (every later feature built), not the model as far as this feature */
  final?: boolean;
}

export interface StudioState {
  /** the document has arrived and can be shown */
  loaded: boolean;
  status: SessionStatus;
  canEdit: boolean;
  features: FeatureItem[];
  /** how many features the document builds: the rollback bar's place */
  rollback: number;
  reports: { [featureId: string]: FeatureReport };
  bodies: BodyResult[];
  sketches: SketchView[];
  /** reference planes, axes, points and curves */
  datums: DatumView[];
  kernel: { state: KernelState; message: string; working: boolean };
  selection: Pick[];
  hover: Pick | null;
  /** the feature row that is selected in the list */
  selectedFeature: string | null;
  editing: EditingFeature | null;
  /** the sketch that is open for editing, and the sketch tool in hand ("select" when none) */
  sketch: { featureId: string; tool: string; /** made by this visit: cancelling takes the feature away again */ isNew?: boolean; /** its parameters when it was opened: what cancelling puts back */ before?: JsonObject } | null;
  /** every row selected in the feature list (Shift and Ctrl add); `selectedFeature` is the one clicked last */
  selectedFeatures: readonly string[];
  /** the feature row under the pointer: its geometry is highlighted in the model */
  hoverFeature: string | null;
  /** how lengths and angles are shown and typed (document/units.ts): the document's, the same for everybody */
  units: Units;
  /** what this person has hidden or shown: "origin", "top", "front", "right", feature ids (ui/prefs.ts) */
  visibility: Visibility;
  peers: SessionPeer[];
  canUndo: boolean; canRedo: boolean;
  planesVisible: boolean;
  /** set while an earlier version of the document is on screen (showPast): nothing can be edited meanwhile */
  past?: { label: string } | null;
  /** interface state that tools and panels keep for themselves (setUi), by a key of their own */
  ui?: { readonly [key: string]: unknown };
}

export const featureDef = (type: string): FeatureDefinition | undefined => FEATURES.find((f) => f.type === type);

/**
 * Something that lives as long as a part studio is open and is not a tool, a panel or a feature: a link to
 * another document, a presence layer.  It is called with each studio as it opens and may return what to do when
 * the studio closes.  Register at module load (`studioExtensions.push(...)`) from a file the page bundle imports
 * (a panel, a tool).
 */
export type StudioExtension = (studio: PartStudio) => (() => void) | void;
export const studioExtensions: StudioExtension[] = [];

export class PartStudio {
  readonly session: ItemDocSession;
  readonly kernel: KernelClient;
  readonly viewport: Viewport3D;
  readonly view: ModelView;
  private state: StudioState;
  private listeners = new Set<() => void>();
  private regenTimer = 0;
  private regenWhenShown: (() => void) | null = null;
  private fitted = false;
  private closed = false;
  /** the document on screen in place of the live one, while an earlier version is looked at */
  private pastDoc: ItemDoc | null = null;
  /** where the view was before a sketch turned it to its plane: finishing the sketch goes back there */
  private viewBefore: ReturnType<Viewport3D["cameraState"]> | null = null;
  /** While set, the pointer in an open sketch goes here, not to the sketcher (choosing another sketch plane). */
  pointerOverride: { move?(ev: PointerEvent): void; up?(ev: PointerEvent): void } | null = null;
  /** the last place the pointer was over the page, for what opens "at the pointer" (the tool search) */
  lastPointer = { x: 0, y: 0 };
  /** A sketch tool that is drawing gets the keys first; it returns true for the ones it used. */
  keyHandler: ((ev: KeyboardEvent) => boolean) | null = null;
  /**
   * Called on the worker's input just before every regeneration, in order: each may return a changed copy.  For
   * data a feature needs that is not in this document (the Board feature's board, read live from another
   * document): what a filter adds is never stored.
   */
  readonly inputFilters: InputFilter[] = [];
  /** Called after every regeneration whose result was shown. */
  readonly onRegen: ((result: RegenResult) => void)[] = [];
  private extensionClosers: (() => void)[] = [];

  constructor(readonly host: DocumentHostContext, canvasHost: HTMLElement) {
    this.state = {
      loaded: false, status: { state: "connecting", text: "connecting…", role: null, canEdit: false }, canEdit: false,
      features: [], rollback: 0, reports: {}, bodies: [], sketches: [], datums: [], kernel: { state: "idle", message: "", working: false },
      selection: [], hover: null, selectedFeature: null, editing: null, sketch: null, peers: [], canUndo: false, canRedo: false, planesVisible: true,
      selectedFeatures: [], hoverFeature: null, units: DEFAULT_UNITS, visibility: readVisibility(host.doc.docId),
    };
    this.state.planesVisible = DEFAULT_GEOMETRY.some((g) => g.id !== "origin" && this.state.visibility[g.id] !== false);
    // the part studio has a view cube (ui/ViewCube.tsx) in place of the viewport's own view buttons
    this.viewport = new Viewport3D(canvasHost, { viewButtons: false });
    this.view = new ModelView(this.viewport);
    this.view.onHover = (p) => this.set({ hover: p });
    this.view.onPick = (p, ev) => this.onPick(p, ev);
    this.view.onBox = (picks, ev) => this.onBox(picks, ev);
    this.view.onContext = (p, ev) => this.onContext(p, ev);
    this.applyVisibility();
    this.viewport.canvas.addEventListener("keydown", this.onKey);
    this.viewport.canvas.addEventListener("pointermove", this.onPointerSeen);
    this.viewport.canvas.addEventListener("mousedown", this.onMiddle);
    window.addEventListener("keydown", this.onKeyElsewhere);
    this.viewport.fit(new THREE.Box3(new THREE.Vector3(-40, -40, -40), new THREE.Vector3(40, 40, 40)));
    this.kernel = new KernelClient({
      onState: (s, message) => { if (!this.closed) this.set({ kernel: { state: s, message: message || "", working: s === "working" || s === "loading" } }); },
    });
    this.session = new ItemDocSession({
      docId: host.doc.docId, signedIn: host.signedIn, expectKind: PART_STUDIO_KIND,
      onChange: () => this.documentChanged(),
      onStatus: (status) => { host.setConnection(status.state === "live" ? "live" : status.state === "error" ? "error" : "offline", status.text); this.set({ status, canEdit: status.canEdit && !this.pastDoc }); },
      onPeers: (peers) => this.set({ peers }),
      onNotice: (text) => host.toast(text, 4000),
    });
    this.session.start();
    for (const ext of studioExtensions) { const stop = ext(this); if (stop) this.extensionClosers.push(stop); }
  }

  // ---------------------------------------------------------------- state
  getState = (): StudioState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<StudioState>): void {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    for (const fn of Array.from(this.listeners)) fn();
  }
  get doc(): ItemDoc | null { return this.pastDoc || this.session.doc; }
  /** Keep a piece of interface state of a tool or a panel; the toolbar and the panels redraw. */
  setUi(patch: { [key: string]: unknown }): void { this.set({ ui: { ...(this.state.ui || {}), ...patch } }); }

  /**
   * Show an earlier version of the document in place of the live one (null: the live one again).  The model
   * is rebuilt from it and nothing can be edited until the live document is back; edits other people make
   * meanwhile are kept by the session and shown then.
   */
  showPast(doc: ItemDoc | null, label = ""): void {
    if (!doc && !this.pastDoc) return;
    if (this.state.sketch) this.finishSketch();
    if (this.state.editing) this.cancelFeature();
    this.pastDoc = doc;
    this.select([]);
    this.set({ past: doc ? { label } : null, canEdit: this.session.status.canEdit && !doc, selectedFeature: null, selectedFeatures: [] });
    this.documentChanged();
  }
  definitions(): readonly FeatureDefinition[] { return FEATURES; }
  tools() { return TOOLS; }

  close(): void {
    for (const stop of this.extensionClosers.splice(0)) { try { stop(); } catch (e) { console.warn(e); } }
    this.closed = true;
    clearTimeout(this.regenTimer);
    if (this.regenWhenShown) document.removeEventListener("visibilitychange", this.regenWhenShown);
    this.viewport.canvas.removeEventListener("keydown", this.onKey);
    this.viewport.canvas.removeEventListener("pointermove", this.onPointerSeen);
    this.viewport.canvas.removeEventListener("mousedown", this.onMiddle);
    window.removeEventListener("keydown", this.onKeyElsewhere);
    this.session.close(); this.kernel.dispose(); this.view.dispose(); this.viewport.dispose();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- the document
  /** Make an edit.  The changes come from document/edits.ts (or are built the same way). */
  commit(changes: ItemChange[], o: { undoable?: boolean } = {}): boolean {
    if (this.pastDoc) { this.host.toast("This is an earlier version. Go back to the current one to edit.", 3000); return false; }
    return this.session.commit(changes, o);
  }
  undo(): void { if (!this.pastDoc && this.session.undo()) this.host.toast("Undone", 1200); }
  redo(): void { if (!this.pastDoc && this.session.redo()) this.host.toast("Redone", 1200); }

  private documentChanged(): void {
    const doc = this.doc; if (!doc) return;
    const features = featuresOf(doc);
    const patch: Partial<StudioState> = { loaded: true, features, rollback: rollbackIndex(doc, features), canUndo: !this.pastDoc && this.session.canUndo, canRedo: !this.pastDoc && this.session.canRedo };
    const units = unitsOf(doc), was = this.state.units;
    if (units.length !== was.length || units.angle !== was.angle || units.places !== was.places) patch.units = units;
    setMeasureUnits(units);   // the measure readout and mass properties write their numbers in them
    this.view.setDatumNames(new Map(features.map((f) => [f.id, f.name])));
    // somebody deleted what is open here
    const s = this.state;
    if (s.sketch && !features.some((f) => f.id === s.sketch!.featureId)) { patch.sketch = null; this.view.pointerTool = null; this.view.setOverlay(null); }
    if (s.editing && !s.editing.isNew && !features.some((f) => f.id === s.editing!.draft.id)) patch.editing = null;
    if (s.selectedFeature && !features.some((f) => f.id === s.selectedFeature)) patch.selectedFeature = null;
    if (s.selectedFeatures.some((id) => !features.some((f) => f.id === id))) patch.selectedFeatures = s.selectedFeatures.filter((id) => features.some((f) => f.id === id));
    if (s.hoverFeature && !features.some((f) => f.id === s.hoverFeature)) patch.hoverFeature = null;
    this.set(patch);
    this.scheduleRegen();
  }

  /** The features the worker is given: the document's, with the draft of the dialog laid over them. */
  private effective(): { features: FeatureItem[]; rollback: number } {
    const s = this.state;
    let features = s.features, rollback = s.rollback;
    if (s.editing) {
      const d = s.editing.draft;
      if (s.editing.isNew) { features = features.slice(); features.splice(rollback, 0, d); rollback += 1; }
      else { const i = features.findIndex((f) => f.id === d.id); if (i >= 0) { features = features.slice(); features[i] = d; rollback = s.editing.final ? Math.max(rollback, i + 1) : i + 1; } }
    } else if (s.sketch) {
      // while a sketch is open the model is shown as it was when the sketch was made
      const i = features.findIndex((f) => f.id === s.sketch!.featureId);
      if (i >= 0) rollback = i + 1;
    }
    return { features, rollback };
  }

  scheduleRegen(): void {
    clearTimeout(this.regenTimer);
    // A window nobody is looking at does not rebuild for every edit somebody else makes: it rebuilds once,
    // from the document as it is by then, when it is looked at again.
    if (document.visibilityState === "hidden") {
      if (!this.regenWhenShown) {
        this.regenWhenShown = () => { if (document.visibilityState === "hidden") return; document.removeEventListener("visibilitychange", this.regenWhenShown!); this.regenWhenShown = null; this.scheduleRegen(); };
        document.addEventListener("visibilitychange", this.regenWhenShown);
      }
      return;
    }
    this.regenTimer = window.setTimeout(() => void this.regen(), 20);
  }
  private async regen(): Promise<void> {
    if (this.closed || !this.state.loaded) return;
    const { features, rollback } = this.effective();
    // numbers typed as expressions follow the variables (document/variables.ts)
    // the one function every builder of a part studio uses (document/inputs.ts): variables, then the filters
    const doc = this.doc; if (!doc) return;
    const inputs = studioInputs(doc, { features, rollback, filters: this.inputFilters }).features;
    const result = await this.kernel.regenerate(inputs, rollback);
    if (!result || this.closed) return;
    const reports: StudioState["reports"] = {};
    for (const r of result.features) reports[r.id] = r;
    this.set({ reports, bodies: result.bodies, sketches: result.sketches, datums: result.datums || [] });
    this.view.setBodies(result.bodies);
    this.view.setDatums(result.datums || []);
    this.refreshSketches();
    this.refreshMarks();
    // frame the model when there first is one (a sketch being drawn is left where the person put it)
    if (!this.fitted && result.bodies.length && !this.state.sketch) { this.fitted = true; this.viewport.fit(); }
    for (const fn of this.onRegen) fn(result);
  }

  /** A sketch is shown while it is open, selected, being used by the dialog, or not yet used by a later feature. */
  private refreshSketches(): void {
    const s = this.state, { features, rollback } = this.effective();
    // a dialog field that takes sketch curves or a profile shows every sketch while it listens
    const armed = s.editing && s.editing.field ? featureDef(s.editing.draft.featureType)?.schema.find((x) => x.key === s.editing!.field) : undefined;
    const pickingCurves = !!armed && ((armed.kind === "refs" && !!armed.sketch) || armed.kind === "profile");
    const visible = new Set<string>();
    features.slice(0, rollback).forEach((f, i) => {
      if (f.featureType !== "sketch") return;
      const used = features.slice(i + 1, rollback).some((later) => JSON.stringify(later.params).includes(f.id));
      const inDialog = !!s.editing && JSON.stringify(s.editing.draft.params).includes(f.id);
      // what the person chose with the eye in the feature list wins, except over a dialog that needs the sketch
      const chosen = s.visibility[f.id];
      if (inDialog || pickingCurves || (chosen === undefined ? !used || s.selectedFeature === f.id : chosen)) visible.add(f.id);
    });
    this.view.setSketches(s.sketches, visible, s.sketch ? s.sketch.featureId : null);
  }

  // ---------------------------------------------------------------- selection
  select(picks: Pick[]): void { this.set({ selection: picks }); this.view.setSelection(picks); }
  /** Select a row of the feature list (null: none).  `add` keeps the rows already selected (Ctrl), toggling this one. */
  selectFeature(id: string | null, add = false): void {
    const now = this.state.selectedFeatures;
    const many = !id ? [] : !add ? [id] : now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
    this.set({ selectedFeature: many.length ? (many.includes(id!) ? id : many[many.length - 1]) : null, selectedFeatures: many });
    this.refreshSketches();
  }
  /** Select these rows of the feature list (a Shift-click's range). */
  selectFeatures(ids: readonly string[]): void { this.set({ selectedFeatures: ids.slice(), selectedFeature: ids.length ? ids[ids.length - 1] : null }); this.refreshSketches(); }
  /** The pointer is over a row of the feature list (null: it left): what the feature made lights up in the model. */
  setHoverFeature(id: string | null): void {
    if (id === this.state.hoverFeature) return;
    this.set({ hoverFeature: id });
    this.view.setFeatureHover(id ? this.view.picksOfFeature(id) : null);
  }
  /** The feature that made what the pointer is over in the model, for the feature list to mark its row. */
  hoveredFeature(): string | null {
    const s = this.state, p = s.hover;
    return p ? this.view.featureOf(p, s.features.map((f) => f.id)) : null;
  }

  /**
   * Something was chosen outside the viewport (a plane's row in the feature list): it means what a click on it
   * in the model would.  A dialog field that is listening takes it; otherwise it is selected.
   */
  pickFromList(p: Pick, ev?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): void {
    if (this.planeTaker) { this.planeTaker(p); return; }
    const s = this.state;
    if (s.editing && s.editing.field) { this.fillField(s.editing.field, p); return; }
    if (s.editing || s.sketch) return;
    const many = !!ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey);
    const has = s.selection.some((x) => pickKey(x) === pickKey(p));
    this.select(many ? (has ? s.selection.filter((x) => pickKey(x) !== pickKey(p)) : [...s.selection, p]) : has && s.selection.length === 1 ? [] : [p]);
  }

  private onPick(p: Pick | null, ev: PointerEvent): void {
    const s = this.state;
    // A listening field keeps what it has: a click on nothing neither empties it nor closes the dialog.
    if (s.editing && s.editing.field) { if (p) this.fillField(s.editing.field, p); return; }
    // a dialog is open but no field listens: the click must not wander off into a selection the dialog cannot use
    if (s.editing) { if (p) { const key = this.fieldFor(p); if (key) { this.setField(key); this.fillField(key, p); } } return; }
    const many = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (!p) { if (!many) this.select([]); return; }
    const has = s.selection.some((x) => pickKey(x) === pickKey(p));
    this.select(many ? (has ? s.selection.filter((x) => pickKey(x) !== pickKey(p)) : [...s.selection, p]) : has && s.selection.length === 1 ? [] : [p]);
  }
  /** A selection box: into the listening field (adding only), or the selection (Shift and Ctrl add to it). */
  private onBox(picks: Pick[], ev: PointerEvent): void {
    const s = this.state;
    if (s.editing) {
      const key = s.editing.field; if (!key) return;
      const field = featureDef(s.editing.draft.featureType)?.schema.find((f) => f.key === key); if (!field) return;
      let value = s.editing.draft.params[key], changed = false;
      for (const p of picks) { const v = valueAfterPick(field, value, p, { addOnly: true }); if (v !== undefined) { value = v; changed = true; } }
      if (changed) this.setDraft({ params: { [key]: value } });
      return;
    }
    const many = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    const keys = new Set(many ? s.selection.map(pickKey) : []);
    this.select([...(many ? s.selection : []), ...picks.filter((p) => !keys.has(pickKey(p)))]);
  }
  /** A right click that did not turn the view: the menu for what is under it (ui/ContextMenu.tsx draws it). */
  private onContext(p: Pick | null, ev: PointerEvent): void {
    const s = this.state;
    if (s.sketch && s.sketch.tool !== "select") { this.setSketchTool("select"); return; }   // a right click puts the tool down
    if (p && !s.editing && !s.sketch && !s.selection.some((x) => pickKey(x) === pickKey(p))) this.select([p]);
    this.setUi({ menu: { x: ev.clientX, y: ev.clientY, pick: p } });
  }
  /** The first field of the open dialog that would take this pick. */
  private fieldFor(p: Pick): string | null {
    const e = this.state.editing, def = e ? featureDef(e.draft.featureType) : undefined;
    if (!e || !def) return null;
    for (const f of def.schema) { if (f.visible && !f.visible(e.draft.params)) continue; if (takesPicks(f) && valueAfterPick(f, e.draft.params[f.key], p, { addOnly: true }) !== undefined) return f.key; }
    return null;
  }

  // ---------------------------------------------------------------- features
  /** Open the dialog for a new feature of this type.  The selection fills what it can (a plane, a sketch). */
  startFeature(type: string): void {
    const def = featureDef(type); if (!def || !this.requireEdit()) return;
    // started from inside a sketch, a feature takes that sketch
    const fromSketch = this.state.sketch ? this.state.sketch.featureId : null;
    if (this.state.sketch) this.finishSketch();
    if (this.state.editing) this.cancelFeature();
    const s = this.state;
    const params = def.defaults() as JsonObject;
    const picked = fillFromSelection(def.schema, params, s.selection);
    Object.assign(params, picked);
    for (const field of def.schema) {
      if (field.kind !== "profile" || params[field.key]) continue;
      // the sketch just left, or else the newest sketch that nothing uses yet, is what an extrude is usually for
      const free = fromSketch ? s.features.find((f) => f.id === fromSketch) : s.features.slice(0, s.rollback).filter((f, i) => f.featureType === "sketch" && !s.features.slice(i + 1).some((l) => JSON.stringify(l.params).includes(f.id))).pop();
      if (free) params[field.key] = { sketch: free.id, regions: null };
    }
    const draft: FeatureItem = { id: crypto.randomUUID(), type: "feature", featureType: def.type, name: nextName(s.features, def.title), order: orderAt(s.features, s.rollback), params };
    this.select([]);
    // A sketch needs nothing but its plane: with one selected, drawing starts at once; without, the dialog asks
    // for it and drawing starts when it is chosen (acceptFeature opens the sketch).
    if (def.type === "sketch") {
      const planeKey = def.schema.find((f) => f.kind === "plane")?.key || null;
      this.set({ editing: { draft, isNew: true, field: planeKey } });
      if (planeKey && picked[planeKey] !== undefined) { this.acceptFeature(); return; }
      this.applyFieldFilter(); this.refreshMarks(); this.scheduleRegen();
      return;
    }
    this.set({ editing: { draft, isNew: true, field: this.firstEmptyField(def, params) } });
    this.applyFieldFilter();
    this.refreshMarks();
    this.scheduleRegen();
  }

  /** Open a feature for editing: its dialog, or the sketch itself for a sketch. */
  editFeature(id: string): void {
    const f = this.state.features.find((x) => x.id === id); if (!f) return;
    if (this.state.sketch) this.finishSketch();
    if (this.state.editing) this.cancelFeature();
    if (f.featureType === "sketch") { this.openSketch(id); return; }
    if (!this.requireEdit()) return;
    this.select([]);
    this.set({ editing: { draft: clone(f), isNew: false, field: null }, selectedFeature: id, selectedFeatures: [id] });
    this.view.setFilter(null);
    this.refreshMarks();
    this.scheduleRegen();
  }

  /** Change the draft in the dialog; the model follows as a preview. */
  setDraft(patch: { params?: JsonObject; name?: string }): void {
    const e = this.state.editing; if (!e) return;
    const draft = { ...e.draft, ...(patch.name !== undefined ? { name: patch.name } : {}), params: patch.params ? { ...e.draft.params, ...patch.params } : e.draft.params };
    this.set({ editing: { ...e, draft } });
    this.refreshSketches();
    this.refreshMarks();
    this.scheduleRegen();
  }
  /** Show the whole model with the feature being edited in it (true), or the model as far as that feature. */
  setFinal(on: boolean): void {
    const e = this.state.editing; if (!e || !!e.final === on) return;
    this.set({ editing: { ...e, final: on } });
    this.refreshSketches();
    this.scheduleRegen();
  }
  /** Make a dialog field the one that viewport clicks fill (null: none). */
  setField(key: string | null): void {
    const e = this.state.editing; if (!e) return;
    this.set({ editing: { ...e, field: key } });
    this.applyFieldFilter();
    this.refreshSketches();
    this.refreshMarks();
  }
  /** Keep what the dialog's fields hold drawn on the model for as long as the dialog is open. */
  private refreshMarks(): void {
    const e = this.state.editing, def = e ? featureDef(e.draft.featureType) : undefined;
    if (!e || !def) { this.view.setMarks([], []); return; }
    const s = this.state;
    const held = heldPicks(def.schema, e.draft.params, e.field, {
      feature: (id) => s.features.find((f) => f.id === id)?.name, body: (id) => s.bodies.find((b) => b.id === id)?.name,
      faces: (id) => s.bodies.find((b) => b.id === id)?.mesh?.faces.names || this.view.bodyObjects(id)?.result.mesh?.faces.names || [],
    });
    const at = (p: (typeof held.active)[number]): Pick => ({ ...p, point: [0, 0, 0] } as Pick);
    const active = held.active.map(at), other = held.other.map(at);
    this.view.setMarks(active, other);
    // What the feature has consumed (the edges an existing fillet rounds) is not in the model on screen: ask the
    // worker what it looked like before the feature, once, so it is drawn as chosen and can be clicked out.
    const id = e.draft.id;
    if (this.heldFor !== id) { this.heldFor = id; this.heldAsked.clear(); }
    const missing = [...active, ...other].filter((p) => !this.view.hasGeometry(p) && !this.heldAsked.has(pickKey(p)));
    if (!missing.length || this.state.kernel.state !== "ready" || !this.state.reports[id]) return;
    for (const p of missing) this.heldAsked.add(pickKey(p));
    void this.kernel.call("ref-geometry", { feature: id, refs: missing.map((p) => ({ kind: p.kind, body: (p as { body: string }).body, name: (p as { name: string }).name })) }).then((r) => {
      if (this.closed || this.state.editing?.draft.id !== id) return;
      for (const item of ((r as { items?: { kind: string; body: string; name: string; segments?: number[]; triangles?: number[]; at?: [number, number, number] }[] } | null)?.items || [])) {
        this.view.hold({ kind: item.kind, body: item.body, name: item.name, point: [0, 0, 0] } as Pick, item);
      }
    }, () => { /* the highlight is a nicety: the dialog works without it */ });
  }
  private heldFor: string | null = null;
  private heldAsked = new Set<string>();
  private applyFieldFilter(): void {
    const e = this.state.editing;
    const def = e ? featureDef(e.draft.featureType) : undefined;
    const field = e && e.field && def ? def.schema.find((f) => f.key === e.field) : undefined;
    this.view.setFilter(pickKindsFor(field) as PickKind[] | null);
  }
  private firstEmptyField(def: FeatureDefinition, params: JsonObject): string | null {
    for (const f of def.schema) {
      if (f.kind === "profile" && !params[f.key]) return f.key;
      if (f.kind === "refs" && (!params[f.key] || (Array.isArray(params[f.key]) && !(params[f.key] as unknown[]).length))) return f.key;
    }
    return null;
  }

  /** The kinds of thing a click picks just now: the listening field's, or a sketch's; null when anything. */
  pickFilter(): string[] | null {
    const e = this.state.editing, def = e ? featureDef(e.draft.featureType) : undefined;
    const field = e && e.field && def ? def.schema.find((f) => f.key === e.field) : undefined;
    return pickKindsFor(field);
  }
  /** A pick for a field of the open dialog, as a click in the model while it listens would give it. */
  fillField(key: string, p: Pick): void {
    const e = this.state.editing; if (!e) return;
    const def = featureDef(e.draft.featureType), field = def && def.schema.find((f) => f.key === key); if (!def || !field) return;
    const v = valueAfterPick(field, e.draft.params[key], p);
    if (v === undefined) return;
    this.setDraft({ params: { [key]: v } });
    // a new sketch needs only its plane: with it chosen, drawing starts
    if (e.isNew && def.type === "sketch" && field.kind === "plane") { this.acceptFeature(); return; }
    // a field that holds one thing is done with one click: the next empty one listens
    if (holdsOne(field)) this.setField(nextEmptyField(def.schema, this.state.editing!.draft.params, key));
  }
  /** Take one thing out of a field of the dialog (the × beside it), or everything (index null). */
  clearField(key: string, index: number | null = null): void {
    const e = this.state.editing; if (!e) return;
    const field = featureDef(e.draft.featureType)?.schema.find((f) => f.key === key); if (!field) return;
    const value = e.draft.params[key];
    if (field.kind === "refs") this.setDraft({ params: { [key]: field.single ? null : index === null ? [] : (Array.isArray(value) ? value : []).filter((_x, i) => i !== index) } });
    else if (field.kind === "bodies") this.setDraft({ params: { [key]: index === null ? [] : (Array.isArray(value) ? value : []).filter((_x, i) => i !== index) } });
    else if (field.kind === "profile") this.setDraft({ params: { [key]: null } });
  }

  /** Accept the dialog: the draft becomes (or replaces) the feature in the document, as one undoable step. */
  acceptFeature(): void {
    const e = this.state.editing; if (!e || !this.doc) return;
    const d = e.draft;
    const changes: ItemChange[] = e.isNew
      ? [{ id: d.id, kind: "ADDED", typeName: "feature", item: { ...d, order: orderAt(featuresOf(this.doc), rollbackIndex(this.doc)) } }]
      : [...edits.setParams(this.doc, d.id, d.params), ...edits.renameFeature(this.doc, d.id, d.name)];
    this.set({ editing: null, selectedFeature: d.id, selectedFeatures: [d.id] });
    this.view.setFilter(null);
    this.view.setMarks([], []);
    if (changes.length) this.commit(changes); else this.scheduleRegen();
    if (e.isNew && d.featureType === "sketch") this.openSketch(d.id, true);
  }
  cancelFeature(): void {
    if (!this.state.editing) return;
    this.set({ editing: null });
    this.view.setFilter(null);
    this.view.setMarks([], []);
    this.refreshSketches();
    this.scheduleRegen();
  }

  private requireEdit(): boolean {
    if (this.state.canEdit) return true;
    if (this.pastDoc) { this.host.toast("This is an earlier version. Go back to the current one to edit.", 3000); return false; }
    this.host.toast(this.state.status.role === "commenter" ? "You can comment here, but not edit." : this.host.signedIn ? "You have view-only access to this project." : "Sign in to edit.", 3000);
    return false;
  }

  // ---------------------------------------------------------------- sketches
  /**
   * Open a sketch for drawing: the sketch tools take the toolbar's place and, when the person likes it so
   * (ui/prefs.ts sketchNormal), the view turns to face the sketch plane.  `isNew`: the sketch was made just now.
   */
  openSketch(featureId: string, isNew = false): void {
    if (!this.requireEdit()) return;
    const f = this.state.features.find((x) => x.id === featureId) || (this.doc ? featuresOf(this.doc).find((x) => x.id === featureId) : undefined);
    this.select([]);
    this.set({ sketch: { featureId, tool: "select", isNew, before: f ? clone(f.params) : undefined }, editing: null, selectedFeature: featureId, selectedFeatures: [featureId] });
    this.view.setFilter(["sketch"]);
    this.view.setMarks([], []);
    this.refreshSketches();
    this.scheduleRegen();
    this.viewBefore = null;
    if (!getPrefs().sketchNormal) return;
    this.viewBefore = this.viewport.cameraState();
    this.faceSketch();
    window.setTimeout(() => { if (this.state.sketch?.featureId === featureId) this.faceSketch(); }, 400);   // again once the worker has said where a sketch on a face lies
  }
  /** Turn the view to look straight at the open sketch's plane. */
  faceSketch(): void {
    const id = this.state.sketch?.featureId; if (!id) return;
    const f = this.state.features.find((x) => x.id === id);
    const plane = f && (f.params.plane as unknown as PlaneRef | undefined);
    const datum = plane && plane.kind === "datum" ? this.state.datums.find((d) => d.featureId === plane.feature) : undefined;
    const frame = this.view.sketchFrame(id) || (plane && plane.kind === "plane" ? DEFAULT_PLANES[plane.plane]?.frame : datum?.frame || null);
    if (frame) this.viewport.lookAlong(new THREE.Vector3(...frame.normal).negate(), new THREE.Vector3(...frame.y));
  }
  /** Leave the open sketch, keeping what was drawn (the ✓). */
  finishSketch(): void {
    if (!this.state.sketch) return;
    this.planeTaker = null; this.pointerOverride = null;
    this.view.pointerTool = null; this.keyHandler = null;
    this.view.setOverlay(null); this.view.setFilter(null);
    this.set({ sketch: null });
    this.select([]);
    this.refreshSketches();
    this.scheduleRegen();
    // back to where the person was looking from before the sketch turned the view
    if (this.viewBefore) { this.viewport.setCameraState({ ...this.viewport.cameraState(), quaternion: this.viewBefore.quaternion }); this.viewBefore = null; }
  }
  /** True when the open sketch is not as it was when it was opened. */
  sketchChanged(): boolean {
    const s = this.state.sketch; if (!s) return false;
    const f = this.state.features.find((x) => x.id === s.featureId);
    return !!f && JSON.stringify(f.params) !== JSON.stringify(s.before || null);
  }
  /**
   * Leave the open sketch and put it back as it was when it was opened (the ✗); a sketch made by this visit is
   * taken away again.  One undoable step, so nothing is lost for good.
   */
  cancelSketch(): void {
    const s = this.state.sketch; if (!s || !this.doc) return;
    const changes: ItemChange[] = s.isNew ? edits.deleteFeature(this.doc, s.featureId) : this.sketchChanged() && s.before ? edits.setParams(this.doc, s.featureId, s.before) : [];
    const drawn = this.sketchChanged();
    this.finishSketch();
    if (changes.length) this.commit(changes);
    if (s.isNew) this.set({ selectedFeature: null, selectedFeatures: [] });
    // nothing is thrown away for good, and the person should know where it went
    if (changes.length && drawn) this.host.toast(s.isNew ? "The new sketch was taken away. Undo brings it back." : "The sketch is as it was when you opened it. Undo brings your changes back.", 4000);
  }
  private planeTaker: ((p: Pick) => void) | null = null;
  /**
   * Choose another plane for the open sketch: the next click on a plane, a flat face or a reference plane (in the
   * model or in the feature list) moves the sketch there.  Esc, or `false`, stops listening.
   */
  pickSketchPlane(on = true): void {
    const s = this.state.sketch;
    if (!on || !s) { this.planeTaker = null; this.pointerOverride = null; this.view.setFilter(s ? ["sketch"] : null); this.setUi({ pickingPlane: false }); return; }
    this.view.setFilter(["plane", "face", "datum"]);
    const take = (p: Pick) => {
      const ref = valueAfterPick({ key: "plane", label: "", kind: "plane" }, undefined, p);
      if (ref === undefined || !this.doc) return;
      this.pickSketchPlane(false);
      this.setSketchPlane(ref as unknown as PlaneRef);
    };
    this.planeTaker = take;
    this.pointerOverride = { move: (ev) => this.view.hoverAt(ev), up: (ev) => { const p = this.view.pick(ev); if (p) take(p); } };
    this.setUi({ pickingPlane: true });
  }
  /** Move the open sketch to another plane. */
  setSketchPlane(ref: PlaneRef): void {
    const s = this.state.sketch; if (!s || !this.doc) return;
    this.commit(edits.setParamPath(this.doc, s.featureId, ["plane"], ref as unknown as JsonObject));
    if (getPrefs().sketchNormal) window.setTimeout(() => this.faceSketch(), 250);
  }
  /** Take a sketch tool in hand ("select" puts it down).  The tool's own file installs its pointer handling. */
  setSketchTool(tool: string): void {
    const s = this.state.sketch; if (!s) return;
    this.view.pointerTool = null; this.keyHandler = null; this.view.setOverlay(null);
    this.set({ sketch: { ...s, tool } });
  }

  // ---------------------------------------------------------------- what is hidden and shown
  /** Is this drawn?  `id`: "origin", "top", "front", "right", or the id of a sketch or of reference geometry. */
  isVisible(id: string): boolean {
    const s = this.state, chosen = s.visibility[id];
    if (chosen !== undefined) return chosen;
    const i = s.features.findIndex((f) => f.id === id);
    if (i < 0 || s.features[i].featureType !== "sketch") return true;
    return !s.features.slice(i + 1, s.rollback).some((later) => JSON.stringify(later.params).includes(id));
  }
  /** Hide or show the origin, a plane, a sketch or reference geometry.  A way of looking: this person's alone. */
  setVisible(ids: string | readonly string[], on: boolean): void {
    const visibility = { ...this.state.visibility };
    for (const id of typeof ids === "string" ? [ids] : ids) visibility[id] = on;
    this.set({ visibility, planesVisible: DEFAULT_GEOMETRY.some((g) => g.id !== "origin" && visibility[g.id] !== false) });
    writeVisibility(this.host.doc.docId, visibility);
    this.applyVisibility();
    this.refreshSketches();
  }
  toggleVisible(id: string): void { this.setVisible(id, !this.isVisible(id)); }
  private applyVisibility(): void {
    const hidden = new Set<string>();
    for (const [id, on] of Object.entries(this.state.visibility)) if (!on) hidden.add(id);
    this.view.setHiddenItems(hidden);
  }
  /** Show or hide every plane at once: the default three and the reference planes (P). */
  setPlanesVisible(on: boolean): void {
    this.setVisible([...DEFAULT_GEOMETRY.map((g) => g.id), ...this.state.datums.filter((d) => d.kind === "plane").map((d) => d.featureId)], on);
  }

  // ---------------------------------------------------------------- units
  /** Change the units the document is worked in.  Everybody sees it; nothing in the model moves. */
  setUnits(patch: Partial<Units>): void {
    if (!this.doc || !this.requireEdit()) return;
    const changes = unitChanges(this.doc, patch);
    if (changes.length) this.commit(changes);
  }

  // ---------------------------------------------------------------- the view
  /** Zoom so that everything is in view (F, a double click with the middle button). */
  fit(): void { this.viewport.fit(); }
  /** Zoom to what is selected (or to everything when nothing is). */
  zoomToSelection(): void {
    const s = this.state;
    const picks = s.selection.length ? s.selection : s.selectedFeature ? this.view.picksOfFeature(s.selectedFeature) : [];
    const box = this.view.boxOf(picks);
    if (box) this.viewport.fit(box.expandByScalar(Math.max(1, box.getSize(new THREE.Vector3()).length() * 0.15))); else this.viewport.fit();
  }
  /** Zoom to what a feature made: where to look when it reports a problem. */
  zoomToFeature(id: string): void {
    const i = this.state.features.findIndex((f) => f.id === id);
    let box = this.view.boxOf(this.view.picksOfFeature(id));
    // a feature that failed made nothing: look at what it was given instead
    if (!box && i >= 0) { const f = this.state.features[i]; for (const g of this.state.features.slice(0, i).reverse()) if (JSON.stringify(f.params).includes(g.id)) { box = this.view.boxOf(this.view.picksOfFeature(g.id)); if (box) break; } }
    if (box) this.viewport.fit(box.expandByScalar(Math.max(1, box.getSize(new THREE.Vector3()).length() * 0.15))); else this.viewport.fit();
  }
  /** Look straight at the selected flat face or plane, or at the open sketch's plane (N). */
  normalTo(): void {
    const s = this.state;
    if (s.sketch) { this.faceSketch(); return; }
    const marks = s.editing ? [] : s.selection;
    for (const p of marks.slice().reverse()) {
      const n = this.view.normalOf(p); if (!n) continue;
      const dir = new THREE.Vector3(...n.normal).negate();
      const up = n.up ? new THREE.Vector3(...n.up) : Math.abs(dir.z) > 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      this.viewport.lookAlong(dir, up);
      return;
    }
    this.host.toast("Select a flat face or a plane to look straight at it.", 2500);
  }

  private onPointerSeen = (ev: PointerEvent): void => { this.lastPointer = { x: ev.clientX, y: ev.clientY }; };
  private lastMiddle = 0;
  private onMiddle = (ev: MouseEvent): void => {
    if (ev.button !== 1) return;
    ev.preventDefault();   // no autoscroll
    const now = performance.now();
    if (now - this.lastMiddle < 400) { this.lastMiddle = 0; this.fit(); } else this.lastMiddle = now;
  };

  // ---------------------------------------------------------------- keys
  /**
   * The keys work wherever the keyboard is in the part studio, not only in the viewport: after a click on a
   * toolbar button, a row of the feature list or a dialog's chevron, L is still Line.  Typing into a field is
   * typing, and a key that means something to the button in focus (Enter, Space, Tab) is that button's.
   */
  private onKeyElsewhere = (ev: KeyboardEvent): void => {
    const t = ev.target as HTMLElement | null, canvas = this.viewport.canvas;
    if (this.closed || ev.defaultPrevented || !t || t === canvas || !canvas.isConnected || canvas.offsetParent === null) return;
    if (typeof t.closest !== "function" || t.closest("input, textarea, select, [contenteditable=true]")) return;
    const root = canvas.closest(".cad-root");
    if (t !== document.body && !(root && root.contains(t))) return;
    if (t.closest("button, a, summary") && (ev.key === "Enter" || ev.key === " ")) return;
    if (ev.key === "Tab" && t.closest("form, [role=menu], [role=dialog], [role=listbox]")) return;
    this.onKey(ev);
    if (ev.defaultPrevented) canvas.focus();
  };
  private onKey = (ev: KeyboardEvent): void => {
    // Shift + letter starts a feature wherever the keyboard is; in a sketch it comes before the sketch's own keys
    if (ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.length === 1 && this.state.sketch && !this.state.editing) {
      const type = FEATURE_KEYS[ev.key.toLowerCase()];
      if (type && type !== "sketch" && featureDef(type)) { this.startFeature(type); ev.preventDefault(); ev.stopPropagation(); return; }
    }
    if (this.keyHandler && this.keyHandler(ev)) { ev.preventDefault(); ev.stopPropagation(); return; }
    const s = this.state, mod = ev.ctrlKey || ev.metaKey;
    const used = () => { ev.preventDefault(); ev.stopPropagation(); };
    if (mod && !ev.shiftKey && ev.key.toLowerCase() === "z") { this.undo(); used(); return; }
    if (mod && (ev.key.toLowerCase() === "y" || (ev.shiftKey && ev.key.toLowerCase() === "z"))) { this.redo(); used(); return; }
    if (mod && ev.key.toLowerCase() === "k") { this.setUi({ palette: { x: null, y: null } }); used(); return; }
    if (mod || ev.altKey) return;
    if (ev.key === "Escape") {
      if (this.planeTaker) this.pickSketchPlane(false);
      else if (s.editing) { if (s.editing.field && !(s.editing.isNew && s.editing.draft.featureType === "sketch")) this.setField(null); else this.cancelFeature(); }
      else if (s.sketch && s.sketch.tool !== "select") this.setSketchTool("select");
      else if (s.selection.length) this.select([]);
      else if (s.selectedFeatures.length) this.selectFeature(null);
      used(); return;
    }
    if (ev.key === "Enter" && s.editing) { this.acceptFeature(); used(); return; }
    if (ev.key === "Tab" && s.editing) {
      const def = featureDef(s.editing.draft.featureType);
      if (def) this.setField(neighbourField(def.schema, s.editing.draft.params, s.editing.field, ev.shiftKey));
      used(); return;
    }
    // Shift + a digit: the standard views, numbered as an Onshape user's fingers know them
    if (ev.shiftKey && /^Digit[1-7]$/.test(ev.code)) {
      this.viewport.setView((["front", "back", "left", "right", "top", "bottom", "iso"] as const)[Number(ev.code.slice(5)) - 1]);
      used(); return;
    }
    if (ev.shiftKey && ev.key.length === 1) {
      const type = FEATURE_KEYS[ev.key.toLowerCase()];
      if (type && featureDef(type)) { this.startFeature(type); used(); return; }
    }
    if (ev.key === "?") { this.setUi({ help: true }); used(); return; }
    if (ev.key.startsWith("Arrow") && !s.sketch) {
      const step = ((ev.shiftKey ? 90 : 15) * Math.PI) / 180;
      this.viewport.rotateBy(ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0, ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0);
      used(); return;
    }
    const k = ev.key.toLowerCase();
    if (!ev.shiftKey) {
      if (k === "s") { this.setUi({ palette: { x: this.lastPointer.x, y: this.lastPointer.y } }); used(); return; }
      if (k === "n") { this.normalTo(); used(); return; }
      if (k === "f" && !s.sketch) { this.fit(); used(); return; }
      if (k === "z" && !s.sketch) { this.zoomToSelection(); used(); return; }
      if (k === "f2" && s.selectedFeature) { this.setUi({ renaming: s.selectedFeature }); used(); return; }
    }
    if (ev.shiftKey) return;
    for (const t of TOOLS) {
      if (!t.key || t.key.toLowerCase() !== k) continue;
      if (t.group === "sketch" && !s.sketch) continue;
      if (t.disabled && t.disabled(this)) continue;
      t.run(this); used(); return;
    }
  };
}

/** Shift + letter starts these features, in a sketch too (where the feature takes that sketch). */
export const FEATURE_KEYS: { readonly [key: string]: string } = { s: "sketch", e: "extrude", w: "revolve", f: "fillet", c: "chamfer", h: "hole", p: "plane" };
