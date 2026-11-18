// assembly.ts — an open assembly: its document's session, the source documents it reads, the solver, the
// viewport and the interface state, in the one object every assembly tool and panel is handed.
//
// The flow of one refresh: the document's instances and mates (plus a mate being drafted) → the geometry each
// source offers (sources/manager.ts) → connector frames (connectors/infer.ts) → the solver (model/problem.ts)
// → placements on screen (viewport/scene.ts).  The document changes only through `commit`: item changes on the
// session, so every edit is sent, shared and undoable.  Placements being tried (a drag, a mate draft, an
// animation) live in `live` and reach the document when the gesture ends.
//
// For analysis tools and panels (see README.md, "For tools"): `placed()`, `sources`, `scene.setMarked`,
// `showPanel`, `ask`, `commit`, `getState` / `subscribe`.
import type { ReactNode } from "react";
import { newId, type Item, type ItemChange, type ItemDoc, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import { ItemDocSession, type SessionStatus } from "../../../shared/itemdoc/sync";
import type { DocumentHostContext } from "../../../platform/documents/host";
import { Viewport3D } from "../../../shared/viewport3d/viewport3d";
import type { BodyMesh, GeomRef, Vec3 } from "../../mechanical/api";
import { connectorOf } from "../connectors/infer";
import { multiply } from "../core/transform";
import type { MateDefinition } from "../core/mate";
import {
  addConnector, addMate, connectorsOf, copyInstances, deleteItems, groupInstances, groupsOf, insertInstances, numberedName, positionsOf, renameItem, replaceSource, savePosition, setCollapsed,
  setFixed, setHidden, setMateValues, setSuppressed, setTransforms, ungroup, updateConnector, updateMate, type ConnectorItem, type GroupItem, type PositionItem,
} from "../document/edits";
import { ASSEMBLY_KIND, instancesOf, isInstance, isMate, matesOf, transformOf as storedTransform, type InstanceItem, type InstanceSource, type MateConnector, type MateItem, type Transform } from "../document/format";
import { MATES, TOOLS } from "../generated/page";
import { buildProblem, endFrame, measureMates, reachOf, solveProblem, type Geometry, type MateInfo, type Problem } from "../model/problem";
import { frameInWorld, prepareA, prepareB } from "../solver/frames";
import { applyPose, dot, inverse, poseDistance, poseOf, qaxis, qmul, qnorm, transformOf, type Pose } from "../solver/math";
import { solve } from "../solver/solver";
import type { DragGoal, MateFrame } from "../solver/types";
import { SourceManager } from "../sources/manager";
import { BoardPictures } from "../viewport/boards";
import type { SourceOffer } from "../sources/types";
import { AssemblyScene, type AssemblyPick, type ConnectorMark } from "../viewport/scene";
import type { TriadHandle } from "../viewport/triad";

/** A mate being made or edited: nothing is in the document until it is accepted. */
export interface MateDraft {
  id: string;
  isNew: boolean;
  mateType: string;
  name: string;
  a: MateConnector | null;
  b: MateConnector | null;
  params: JsonObject;
  /** which connector the next click in the model fills */
  field: "a" | "b" | null;
}

export interface InstanceInfo {
  status: "ready" | "loading" | "error";
  message?: string;
  /** fixed, or fastened to something fixed */
  grounded: boolean;
  /** the freedoms the mates leave it; null when not known */
  dof: number | null;
}

/** A panel a tool adds beside the viewport (a bill of materials, an interference report). */
export interface PanelDefinition { id: string; title: string; /** "bottom": under the viewport, for something wide (a table) */ side?: "left" | "right" | "bottom"; render(assembly: AssemblyEditor): ReactNode }
/** A small form a tool asks ("how many copies?"). */
export interface FormField { key: string; label: string; kind: "number" | "text"; value: number | string; unit?: string }
export interface FormDefinition { title: string; fields: FormField[]; acceptLabel?: string; accept(values: { [key: string]: number | string }): void }

/** One instance as it stands on screen, with its geometry: what an analysis tool reads. */
export interface PlacedPiece { id: string; name: string; mesh: BodyMesh; /** the piece in assembly space */ transform: Transform }
export interface PlacedInstance { item: InstanceItem; transform: Transform; status: InstanceInfo["status"]; pieces: PlacedPiece[] }

export interface AssemblyState {
  loaded: boolean;
  status: SessionStatus;
  canEdit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  instances: InstanceItem[];
  mates: MateItem[];
  groups: GroupItem[];
  positions: PositionItem[];
  /** explicit mate connectors (document/edits.ts) */
  connectors: ConnectorItem[];
  /** ids of the selected instances, mates, groups or positions */
  selection: string[];
  instanceInfo: { [id: string]: InstanceInfo };
  mateInfo: { [id: string]: MateInfo };
  /** the freedoms of the whole assembly; null when not known */
  dof: number | null;
  /** how long the last full solve took, ms */
  solveMs: number;
  /** part studios being built right now */
  building: number;
  kernelFailure: string | null;
  mating: MateDraft | null;
  inserting: { replace: string | null } | null;
  /** true while the next click in the model adds an explicit mate connector */
  connecting: boolean;
  /** the id of the item whose name is being typed in the lists */
  renaming: string | null;
  /** 0: assembled; above: how far the exploded view pulls the parts apart */
  explode: number;
  exploding: boolean;
  animating: { mate: string; key: string } | null;
  /** what a manipulator drag has done so far: "25 mm", "30°" */
  readout: string | null;
  panels: PanelDefinition[];
  form: FormDefinition | null;
}

const EMPTY: AssemblyState = {
  loaded: false, status: { state: "connecting", text: "connecting…", role: null, canEdit: false }, canEdit: false, canUndo: false, canRedo: false,
  instances: [], mates: [], groups: [], positions: [], connectors: [], selection: [], instanceInfo: {}, mateInfo: {}, dof: null, solveMs: 0, building: 0, kernelFailure: null,
  mating: null, inserting: null, connecting: false, renaming: null, explode: 0, exploding: false, animating: null, readout: null, panels: [], form: null,
};

export const mateDef = (type: string): MateDefinition | undefined => MATES.find((d) => d.type === type);

export class AssemblyEditor {
  readonly session: ItemDocSession;
  readonly viewport: Viewport3D;
  readonly scene: AssemblyScene;
  /** board instances as they look (viewport/boards.ts) */
  readonly boards: BoardPictures;
  readonly sources: SourceManager;
  private state: AssemblyState = EMPTY;
  private listeners = new Set<() => void>();
  private closed = false;
  /** placements on screen, by instance id */
  private display = new Map<string, Pose>();
  /** placements being tried and not committed (a drag, a mate draft, an animation); null: the document's */
  private live: Map<string, Pose> | null = null;
  private connectors = new Map<string, ConnectorItem>();
  private followTimer: ReturnType<typeof setTimeout> | undefined;
  private fitted = false;
  private hover: AssemblyPick | null = null;
  private down: { x: number; y: number; pick: AssemblyPick | null; toggle: boolean } | null = null;
  private drag: { problem: Problem; reach: number; goal(ev: PointerEvent): DragGoal | null; moved: boolean; pending: PointerEvent | null; frame: number; triad: { local: Vec3; instance: string } | null; label(ev: PointerEvent): string | null } | null = null;
  private anim: { frame: number; before: Map<string, Pose> | null; t0: number; from: number; to: number; loop: boolean } | null = null;
  private refreshQueued = false;

  constructor(readonly host: DocumentHostContext, canvasHost: HTMLElement) {
    this.viewport = new Viewport3D(canvasHost);
    this.viewport.fit();
    this.scene = new AssemblyScene(this.viewport);
    this.sources = new SourceManager(host.doc.docId, host.signedIn, () => this.queueRefresh());
    this.boards = new BoardPictures(this.viewport, this.sources);
    this.session = new ItemDocSession({
      docId: host.doc.docId, signedIn: host.signedIn, expectKind: ASSEMBLY_KIND,
      onChange: () => { this.state = { ...this.state, loaded: true }; this.refresh(); },
      onStatus: (status) => { host.setConnection(status.state === "live" ? "live" : status.state === "error" ? "error" : "offline", status.text); this.set({ status, canEdit: status.canEdit }); },
      onNotice: (text) => host.toast(text, 4000),
    });
    const c = this.viewport.canvas;
    c.addEventListener("pointerdown", this.onDown);
    c.addEventListener("pointermove", this.onMove);
    c.addEventListener("pointerup", this.onUp);
    c.addEventListener("pointercancel", this.onUp);
    c.addEventListener("pointerleave", this.onLeave);
    c.addEventListener("dblclick", this.onDouble);
    c.addEventListener("keydown", this.onKey);
    this.session.start();
  }

  getState = (): AssemblyState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<AssemblyState>): void { if (this.closed) return; this.state = { ...this.state, ...patch }; for (const fn of Array.from(this.listeners)) fn(); }

  get doc(): ItemDoc | null { return this.session.doc; }
  mateTypes(): readonly MateDefinition[] { return MATES; }
  tools() { return TOOLS; }
  /** The one way the assembly changes: item changes through the session (applied here, sent, undoable). */
  commit(changes: ItemChange[], o: { undoable?: boolean } = {}): boolean { return this.session.commit(changes, o); }
  undo(): void { if (this.state.mating) return; this.session.undo(); }
  redo(): void { if (this.state.mating) return; this.session.redo(); }

  // ---------------------------------------------------------------- what tools read
  /** Every instance that is not suppressed, where it stands on screen (solved, not exploded), with its geometry. */
  placed(): PlacedInstance[] {
    const out: PlacedInstance[] = [];
    for (const item of this.state.instances) {
      if (item.suppressed) continue;
      const pose = this.display.get(item.id);
      const transform = pose ? transformOf(pose) : storedTransform(item);
      const src = this.sources.piecesOf(item);
      out.push({ item, transform, status: src.status, pieces: src.pieces.map((p) => ({ id: p.id, name: p.name, mesh: p.mesh, transform: p.transform ? multiply(transform, p.transform) : transform })) });
    }
    return out;
  }
  /** The solved placement of an instance as shown. */
  transformOf(id: string): Transform | null { const p = this.display.get(id); return p ? transformOf(p) : null; }

  showPanel(def: PanelDefinition): void { this.set({ panels: [...this.state.panels.filter((p) => p.id !== def.id), def] }); }
  closePanel(id: string): void { this.set({ panels: this.state.panels.filter((p) => p.id !== id) }); }
  ask(form: FormDefinition | null): void { this.set({ form }); }

  // ---------------------------------------------------------------- refresh: document + sources → solver → screen
  private geometry: Geometry = {
    frame: (instance, ref) => {
      const { pieces, status } = this.sources.piecesOf(instance);
      if (status === "loading") return undefined;
      let piece = pieces.find((p) => p.id === ref.body);
      let f = piece ? connectorOf(piece.mesh, ref) : null;
      if (!f) for (const p of pieces) { f = connectorOf(p.mesh, ref); if (f) { piece = p; break; } }   // the name moved to another piece
      if (!f || !piece) return null;
      return piece.transform ? frameInWorld(poseOf(piece.transform), f) : f;
    },
    centre: (instance) => this.localCentre(instance),
  };

  private queueRefresh(): void {
    if (this.refreshQueued || this.closed) return;
    this.refreshQueued = true;
    queueMicrotask(() => { this.refreshQueued = false; if (!this.closed && !this.drag) this.refresh(); });
  }

  private draftItem(d: MateDraft): MateItem | null {
    return d.a && d.b ? { id: d.id, type: "mate", mateType: d.mateType, name: d.name, order: "~", a: d.a, b: d.b, params: d.params } : null;
  }
  private activeMates(doc: ItemDoc): MateItem[] {
    const d = this.state.mating, mates = matesOf(doc);
    if (!d) return mates;
    const draft = this.draftItem(d);
    return [...mates.filter((m) => m.id !== d.id), ...(draft ? [draft] : [])];
  }
  private problem(doc: ItemDoc): Problem { return buildProblem(instancesOf(doc), this.activeMates(doc), this.connectors, MATES, this.geometry, this.live || undefined); }

  /** Read the document and the sources again, solve, draw.  `seed`: a mate whose second part should jump into place. */
  private refresh(o: { seed?: string; drives?: { mate: string; key: string; value: number }[] } = {}): void {
    const doc = this.session.doc;
    if (!doc || this.closed) return;
    const instances = instancesOf(doc), mates = matesOf(doc);
    this.connectors = new Map(connectorsOf(doc).map((c) => [c.id, c]));
    this.sources.sync(instances);
    const problem = this.problem(doc);
    const reach = reachOf(problem.mates);
    let solved = solveProblem(problem, { analyze: true, reach, seed: o.seed, drives: o.drives });
    if (!this.live && !o.drives && solved.result.iterations > 0) {
      // Something moved under the stored placements: a part was rebuilt, or a mate was changed elsewhere.  Of the
      // placements that satisfy the mates, take the one that keeps every mate's value (a lid open at 45° stays
      // at 45° when its box grows); only when that is impossible, the nearest one.
      const drives: { mate: string; key: string; value: number }[] = [];
      for (const m of problem.mates) {
        // the values stored with the placements; for a mate that has none yet, the ones last seen here
        const item = doc.items.get(m.id), was = this.state.mateInfo[m.id];
        const kept = isMate(item) && item.values && typeof item.values === "object" ? item.values : was && was.state === "ok" ? was.values : null;
        if (!kept) continue;
        for (const v of m.solve.values || []) { const x = kept[v.key]; if (typeof x === "number") drives.push({ mate: m.id, key: v.key, value: v.unit === "deg" ? (x * Math.PI) / 180 : x }); }
      }
      if (drives.length) { const held = solveProblem(problem, { analyze: true, reach, drives }); if (held.result.ok) solved = held; }
    }
    this.display = solved.result.poses;
    if (this.live) this.live = new Map(this.display);

    const instanceInfo: { [id: string]: InstanceInfo } = {};
    let anyReady = false;
    for (const i of instances) {
      const src = this.sources.piecesOf(i), body = solved.result.bodies.get(i.id);
      if (src.pieces.length) anyReady = true;
      instanceInfo[i.id] = { status: src.status, message: src.status === "ready" ? undefined : src.message, grounded: body ? body.grounded : !!i.fixed, dof: body ? body.dof : null };
    }
    const mateInfo: { [id: string]: MateInfo } = {};
    for (const [id, info] of solved.mates) mateInfo[id] = info;
    const ids = new Set<string>([...instances.map((i) => i.id), ...mates.map((m) => m.id)]);
    const groups = groupsOf(doc), positions = positionsOf(doc);
    for (const g of groups) ids.add(g.id);
    for (const p of positions) ids.add(p.id);
    const connectors = Array.from(this.connectors.values());
    for (const c of connectors) ids.add(c.id);
    const activity = this.sources.activity;
    this.draw(instances);
    this.set({
      instances, mates, groups, positions, connectors, instanceInfo, mateInfo, dof: solved.result.dof, solveMs: solved.result.ms,
      selection: this.state.selection.filter((id) => ids.has(id)), building: activity.building, kernelFailure: activity.failure,
      canUndo: this.session.canUndo, canRedo: this.session.canRedo,
      renaming: this.state.renaming && ids.has(this.state.renaming) ? this.state.renaming : null,
    });
    this.decorate();
    if (!this.fitted && anyReady && instances.every((i) => i.suppressed || instanceInfo[i.id].status !== "loading")) { this.fitted = true; this.fit(); }
    this.follow(solved.result.ok && !Object.values(mateInfo).some((m) => m.state === "pending") && !instances.some((i) => !i.suppressed && instanceInfo[i.id].status === "loading"));
  }

  /**
   * The document always stores solved placements.  When a part changed upstream and the solver moved things to
   * keep the mates, an editor writes the new placements back (not as an undo step: nobody made an edit).
   */
  private follow(sound: boolean): void {
    clearTimeout(this.followTimer);
    if (!sound || this.live || !this.state.canEdit) return;
    const pending = (): ItemChange[] => (this.session.doc ? setTransforms(this.session.doc, this.transforms(), 1e-7) : []);
    if (!pending().length) return;   // (mate values are not rewritten here: they are what the solve aimed at)
    this.followTimer = setTimeout(() => { if (this.closed || this.live || this.drag || !this.state.canEdit) return; const changes = pending(); if (changes.length) this.session.commit(changes, { undoable: false }); }, 500);
  }

  /** What a finished gesture stores: the placements on screen and the values the mates have in them. */
  private settled(doc: ItemDoc): ItemChange[] {
    return [...setTransforms(doc, this.transforms()), ...setMateValues(doc, measureMates(this.problem(doc), this.display))];
  }
  private transforms(): Map<string, Transform> { const out = new Map<string, Transform>(); for (const [id, p] of this.display) out.set(id, transformOf(p)); return out; }

  /** The instances' own centres (in their own space), for the exploded view and the manipulator. */
  private localCentre(i: InstanceItem): Vec3 | null {
    const { pieces } = this.sources.piecesOf(i);
    if (!pieces.length) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of pieces) {
      const b = p.mesh.bbox;
      for (let c = 0; c < 8; c++) {
        let v: Vec3 = [c & 1 ? b[3] : b[0], c & 2 ? b[4] : b[1], c & 4 ? b[5] : b[2]];
        if (p.transform) v = applyPose(poseOf(p.transform), v);
        for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
      }
    }
    return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  }

  /** Put the instances on screen where `display` says (pulled apart when the view is exploded). */
  private draw(instances: readonly InstanceItem[] = this.state.instances): void {
    this.scene.setInstances(instances.filter((i) => !i.suppressed).map((i) => ({ id: i.id, pieces: this.sources.piecesOf(i).pieces, hidden: !!i.hidden })));
    this.place(instances);
  }
  private place(instances: readonly InstanceItem[] = this.state.instances): void {
    const out = new Map<string, Transform>();
    const k = this.state.explode;
    let centre: Vec3 | null = null;
    const centres = new Map<string, Vec3>();
    if (k > 0) {
      const sum: Vec3 = [0, 0, 0]; let n = 0;
      for (const i of instances) { const pose = this.display.get(i.id), c = pose && this.localCentre(i); if (!pose || !c) continue; const w = applyPose(pose, c); centres.set(i.id, w); sum[0] += w[0]; sum[1] += w[1]; sum[2] += w[2]; n++; }
      if (n) centre = [sum[0] / n, sum[1] / n, sum[2] / n];
    }
    for (const [id, pose] of this.display) {
      const t = transformOf(pose), c = centres.get(id);
      if (centre && c) { t[3] += (c[0] - centre[0]) * k; t[7] += (c[1] - centre[1]) * k; t[11] += (c[2] - centre[2]) * k; }
      out.set(id, t);
    }
    this.scene.setTransforms(out);
    // the boards' pictures stand where their instances do
    this.boards.sync(instances.filter((i) => !i.suppressed && i.source && i.source.kind === "board").map((i) => ({ id: i.id, docId: i.source.docId, hidden: !!i.hidden })), (id) => out.get(id) || null);
  }

  /** Selection tint, the manipulator and the connector glyphs. */
  private decorate(): void {
    const s = this.state;
    const instanceIds = new Set(s.instances.map((i) => i.id));
    this.scene.setSelection(s.selection.filter((id) => instanceIds.has(id)));
    // the manipulator sits on the one selected instance that can move
    const only = s.selection.length === 1 && !s.mating && !s.exploding && s.canEdit ? s.instances.find((i) => i.id === s.selection[0]) : undefined;
    const info = only && s.instanceInfo[only.id], pose = only && this.display.get(only.id), centre = only && this.localCentre(only);
    if (!this.drag) this.scene.triad.setPose(only && info && !info.grounded && pose && centre && !only.hidden && !only.suppressed ? { p: applyPose(pose, centre), q: pose.q } : null);
    // connector glyphs: the mate being drafted, the selected mates, and what is under the pointer while picking
    const marks: ConnectorMark[] = [];
    const ends = (m: { a: MateConnector | null; b: MateConnector | null; params: JsonObject }) => {
      for (const side of ["a", "b"] as const) { const f = m[side] && this.worldConnector(m[side]!, side, m.params); if (f) marks.push({ frame: f, strong: true }); }
    };
    if (s.mating) ends(s.mating);
    else for (const id of s.selection) { const m = s.mates.find((x) => x.id === id); if (m) ends(m); }
    // explicit connectors are always there to be picked; the one under the pointer and the selected ones stand out
    const near = this.nearConnector;
    for (const c of s.connectors) { const f = this.explicitFrame(c); if (f) marks.push({ frame: f, strong: c.id === near || s.selection.includes(c.id) }); }
    if ((s.connecting || (s.mating && s.mating.field)) && this.hover && !near) { const f = this.pickFrame(this.hover); if (f) marks.push({ frame: f }); }
    this.scene.setConnectors(marks);
  }

  private instance(id: string): InstanceItem | undefined { const i = this.session.doc?.items.get(id); return isInstance(i) ? i : undefined; }
  /** A mate end as a frame in assembly space, as the solver sees it. */
  private worldConnector(end: MateConnector, side: "a" | "b", params: JsonObject): MateFrame | null {
    const inst = this.instance(end.instance), pose = this.display.get(end.instance);
    if (!inst || !pose) return null;
    const f = endFrame(end, inst, this.connectors, this.geometry);
    if (!f) return null;
    return frameInWorld(pose, side === "a" ? prepareA(f, !!end.flip, params) : prepareB(f, !!end.flip, params));
  }
  /** The implicit connector of what the pointer is over, in assembly space. */
  private pickFrame(pick: AssemblyPick): MateFrame | null {
    const inst = this.instance(pick.instance), pose = this.display.get(pick.instance);
    if (!inst || !pose) return null;
    const f = this.geometry.frame(inst, { kind: pick.kind, body: pick.piece, name: pick.name });
    return f ? frameInWorld(pose, f) : null;
  }

  fit(): void { const box = this.scene.box(); if (!box.isEmpty()) this.viewport.fit(box); }

  // ---------------------------------------------------------------- selection and instance edits
  select(ids: string | string[] | null, o: { toggle?: boolean } = {}): void {
    const list = ids === null ? [] : Array.isArray(ids) ? ids : [ids];
    let next = list;
    if (o.toggle) { const cur = new Set(this.state.selection); for (const id of list) { if (cur.has(id)) cur.delete(id); else cur.add(id); } next = Array.from(cur); }
    this.set({ selection: next });
    this.decorate();
  }
  private selected<T extends Item>(test: (i: Item | undefined) => i is T): T[] { const doc = this.session.doc; return doc ? this.state.selection.map((id) => doc.items.get(id)).filter(test) : []; }
  selectedInstances(): InstanceItem[] { return this.selected(isInstance); }
  selectedMates(): MateItem[] { return this.selected(isMate); }

  private edit(make: (doc: ItemDoc) => ItemChange[]): boolean { const doc = this.session.doc; return !!doc && this.commit(make(doc)); }
  rename(id: string, name: string): void { this.set({ renaming: null }); this.edit((doc) => renameItem(doc, id, name)); }
  startRename(id: string | null): void { this.set({ renaming: id }); }
  setFixed(ids: string[], on: boolean): void { this.edit((doc) => setFixed(doc, ids, on)); }
  setHidden(ids: string[], on: boolean): void { this.edit((doc) => setHidden(doc, ids, on)); }
  setSuppressed(ids: string[], on: boolean): void { this.edit((doc) => setSuppressed(doc, ids, on)); }
  remove(ids: string[] = this.state.selection): void { if (ids.length) this.edit((doc) => deleteItems(doc, ids)); }
  group(ids: string[]): void { const doc = this.session.doc; if (!doc || !ids.length) return; const g = groupInstances(doc, ids); if (this.commit(g.changes)) this.set({ renaming: g.group.id }); }
  ungroup(id: string): void { this.edit((doc) => ungroup(doc, id)); }
  setCollapsed(id: string, on: boolean): void { const doc = this.session.doc; if (doc) this.commit(setCollapsed(doc, id, on), { undoable: false }); }
  /** Copies of the selected instances in a row: `count` more, each `step` further. */
  copyInRow(ids: string[], count: number, step: [number, number, number]): void {
    const doc = this.session.doc; if (!doc || !ids.length || !(count >= 1)) return;
    const c = copyInstances(doc, ids, Math.min(200, Math.floor(count)), step);
    if (this.commit(c.changes)) this.select(c.items.map((i) => i.id));
  }

  // ---------------------------------------------------------------- insert and replace
  openInsert(replace: string | null = null): void { if (this.state.mating) this.cancelMate(); this.set({ inserting: { replace } }); }
  closeInsert(): void { this.set({ inserting: null }); }
  /** Add instances.  Parts keep the place their studio gave them; one that is already there is set beside it. */
  insert(offers: SourceOffer[]): void {
    const doc = this.session.doc; if (!doc || !offers.length) return;
    const same = (a: InstanceSource, b: InstanceSource) => a.kind === b.kind && a.docId === b.docId && (a.kind !== "part" || (b.kind === "part" && a.body === b.body));
    const counts = new Map<SourceOffer, number>();
    const existing = instancesOf(doc);
    const list = offers.map((o) => {
      const n = existing.filter((i) => same(i.source, o.source)).length + offers.filter((x) => counts.has(x) && same(x.source, o.source)).length;
      counts.set(o, n);
      const t: Transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
      // a source that says where it belongs (a board: its middle at the origin); the Insert dialog offers a
      // board before it has been read, so ask again now that it probably has
      const snapNow = this.sources.snapshot(o.source.kind, o.source.docId), prov = this.sources.provider(o.source.kind);
      const at = o.transform || (snapNow && prov ? prov.offers(o.source.docId, o.name, snapNow).find((x) => same(x.source, o.source))?.transform : undefined);
      if (at) for (let k = 0; k < 12; k++) t[k] = at[k];
      if (n) {
        const snap = this.sources.snapshot(o.source.kind, o.source.docId), p = this.sources.provider(o.source.kind);
        let width = 0;
        for (const piece of snap && p ? p.select(o.source, snap) : []) width = Math.max(width, piece.mesh.bbox[3] - piece.mesh.bbox[0]);
        t[3] += n * (width * 1.15 + 5);
      }
      return { source: o.source, name: o.name, transform: t };
    });
    const made = insertInstances(doc, list);
    if (this.commit(made.changes)) { this.fitted = false; this.select(made.items.map((i) => i.id)); }
    this.set({ inserting: null });
  }
  replace(id: string, source: InstanceSource): void { this.edit((doc) => replaceSource(doc, id, source)); this.set({ inserting: null }); }

  // ---------------------------------------------------------------- mates
  startMate(type: string): void {
    const def = mateDef(type), doc = this.session.doc;
    if (!def || !doc || !this.state.canEdit) return;
    this.stopAnimation();
    this.live = new Map(this.display);
    this.set({ mating: { id: newId(), isNew: true, mateType: type, name: numberedName(matesOf(doc).map((m) => m.name), def.title), a: null, b: null, params: def.defaults(), field: "a" }, inserting: null, selection: [] });
    this.decorate();
    this.viewport.canvas.focus();
  }
  editMate(id: string): void {
    const m = this.session.doc?.items.get(id);
    if (!isMate(m) || !this.state.canEdit) return;
    this.stopAnimation();
    this.live = new Map(this.display);
    this.set({ mating: { id, isNew: false, mateType: m.mateType, name: m.name, a: m.a, b: m.b, params: { ...(mateDef(m.mateType)?.defaults() || {}), ...(m.params || {}) }, field: null }, inserting: null, selection: [id] });
    this.decorate();
  }
  /** Change the draft.  `snap`: the change turns the second part round (a connector, a flip), so it jumps into place again. */
  setMateDraft(patch: Partial<Omit<MateDraft, "params">> & { params?: JsonObject }, snap = false): void {
    const d = this.state.mating; if (!d) return;
    const next: MateDraft = { ...d, ...patch, params: patch.params ? { ...d.params, ...patch.params } : d.params };
    this.state = { ...this.state, mating: next };
    this.refresh({ seed: snap ? next.id : undefined });
  }
  flipMate(side: "a" | "b"): void { const d = this.state.mating, end = d && d[side]; if (d && end) this.setMateDraft({ [side]: { ...end, flip: !end.flip } }, true); }
  reorientMate(): void { const d = this.state.mating; if (d) this.setMateDraft({ params: { reorient: ((Number(d.params.reorient) || 0) + 1) % 4 } }, true); }

  /** An explicit connector as a frame in assembly space, or null when its instance is not shown. */
  private explicitFrame(c: ConnectorItem): MateFrame | null {
    const inst = this.instance(c.instance);
    if (!inst || inst.suppressed || inst.hidden) return null;
    return this.worldConnector({ instance: c.instance, ref: c.ref, connector: c.id }, "b", {});
  }
  /** The explicit connector whose glyph is under the pointer (within a dozen pixels of its origin). */
  private nearConnector: string | null = null;
  private connectorAt(ev: { clientX: number; clientY: number }): string | null {
    const r = this.viewport.canvas.getBoundingClientRect();
    let best: string | null = null, bd = 13;
    for (const c of this.state.connectors) {
      const f = this.explicitFrame(c); if (!f) continue;
      const s = this.viewport.project(this.viewport.target.clone().set(f.o[0], f.o[1], f.o[2]));
      const d = Math.hypot(s.x - (ev.clientX - r.left), s.y - (ev.clientY - r.top));
      if (d < bd) { bd = d; best = c.id; }
    }
    return best;
  }

  /** The next click in the model adds an explicit mate connector to the instance under it. */
  setConnecting(on: boolean): void {
    if (on && this.state.mating) this.cancelMate();
    this.hover = null; this.scene.setHover(null);
    this.set({ connecting: on && this.state.canEdit, inserting: null });
    this.decorate();
  }
  private addConnectorAt(pick: AssemblyPick): void {
    const doc = this.session.doc; if (!doc) return;
    const made = addConnector(doc, { instance: pick.instance, ref: { kind: pick.kind, body: pick.piece, name: pick.name } as GeomRef });
    this.state = { ...this.state, connecting: false };
    this.hover = null; this.scene.setHover(null);
    if (this.commit(made.changes)) this.select(made.item.id); else this.refresh();
  }
  /** Move an explicit connector on its geometry: an offset along its own axes (mm), a turn about its axis (degrees), a flip. */
  editConnector(id: string, patch: { offset?: number[]; rotation?: number; flip?: boolean }): void { this.edit((doc) => updateConnector(doc, id, patch)); }

  private pickConnector(pick: AssemblyPick | null, explicit: string | null = null): void {
    const d = this.state.mating; if (!d || !d.field) return;
    const item = explicit ? this.connectors.get(explicit) : undefined;
    if (!item && !pick) return;
    const end: MateConnector = item ? { instance: item.instance, ref: item.ref, connector: item.id } : { instance: pick!.instance, ref: { kind: pick!.kind, body: pick!.piece, name: pick!.name } as GeomRef };
    const other = d.field === "a" ? d.b : d.a;
    if (other && other.instance === end.instance) { this.host.toast("A mate joins two different instances. Pick a face, an edge or a point of another one.", 4000); return; }
    const patch: Partial<MateDraft> = { [d.field]: end };
    const a = d.field === "a" ? end : d.a, b = d.field === "b" ? end : d.b;
    if (a && b) {
      // which way the second connector faces: two flat faces meet face to face; anything else keeps the second part the way it is
      const fa = this.worldConnector({ ...a, flip: false }, "a", {}), fb = this.worldConnector({ ...b, flip: false }, "b", {});
      if (fa && fb) {
        const facing = fa.surface === "plane" && fb.surface === "plane";
        const want = facing ? true : dot(fa.z, fb.z) < 0;
        if (d.field === "b") patch.b = { ...end, flip: a.flip ? !want : want }; else patch.a = { ...end, flip: b.flip ? !want : want };
      }
      patch.field = null;
    } else patch.field = d.field === "a" ? "b" : "a";
    this.hover = null; this.scene.setHover(null);
    this.setMateDraft(patch, true);
  }

  acceptMate(): void {
    const d = this.state.mating, doc = this.session.doc;
    if (!d || !doc) return;
    if (!d.a || !d.b) { this.host.toast("Pick a connector on each of two instances: click a face, an edge or a point.", 4000); return; }
    this.stopAnimation();
    const changes = d.isNew ? addMate(doc, { mateType: d.mateType, name: d.name.trim() || "Mate", a: d.a, b: d.b, params: d.params }, d.id).changes
      : updateMate(doc, d.id, { name: d.name.trim() || "Mate", a: d.a, b: d.b, params: d.params, mateType: d.mateType });
    changes.push(...this.settled(doc));
    this.live = null;
    this.state = { ...this.state, mating: null, selection: [d.id] };
    if (!this.commit(changes)) this.refresh();
  }
  cancelMate(): void {
    if (!this.state.mating) return;
    this.stopAnimation();
    this.live = null;
    this.state = { ...this.state, mating: null };
    this.hover = null; this.scene.setHover(null);
    this.refresh();
  }
  setMateSuppressed(ids: string[], on: boolean): void { this.edit((doc) => setSuppressed(doc, ids, on)); }

  /**
   * Set one of a mate's values (an angle in degrees, a distance in mm): the parts move to it, the other mates
   * still hold.  In a mate dialog the result waits for Done; otherwise it is committed at once.
   */
  driveMate(id: string, key: string, value: number): boolean {
    const def = mateDef(this.state.mating && this.state.mating.id === id ? this.state.mating.mateType : this.state.mates.find((m) => m.id === id)?.mateType || "");
    const v = def?.solve?.values?.find((x) => x.key === key);
    if (!v || !Number.isFinite(value)) return false;
    const drafting = !!this.state.mating;
    if (!this.live) this.live = new Map(this.display);
    this.refresh({ drives: [{ mate: id, key, value: v.unit === "deg" ? (value * Math.PI) / 180 : value }] });
    const ok = this.state.mateInfo[id]?.state === "ok";
    if (!drafting && !this.anim) { const doc = this.session.doc; const changes = doc && ok ? this.settled(doc) : []; this.live = null; if (!changes.length || !this.commit(changes)) this.refresh(); }
    return ok;
  }
  /** Sweep a mate's value back and forth between its limits (or through a full turn) until stopped.  Nothing is stored. */
  animateMate(id: string, key: string): void {
    if (this.anim) { this.stopAnimation(); return; }
    const m = this.state.mating && this.state.mating.id === id ? this.state.mating : this.state.mates.find((x) => x.id === id);
    const v = m && mateDef(m.mateType)?.solve?.values?.find((x) => x.key === key);
    if (!m || !v) return;
    const now = this.state.mateInfo[id]?.values[key] ?? 0, p = m.params || {};
    const limited = !!p.limits && typeof p[key + "Min"] === "number" && typeof p[key + "Max"] === "number";
    const from = limited ? Number(p[key + "Min"]) : v.unit === "deg" ? now : now - 25, to = limited ? Number(p[key + "Max"]) : v.unit === "deg" ? now + 360 : now + 25;
    this.anim = { frame: 0, before: this.live ? new Map(this.live) : null, t0: performance.now(), from, to, loop: !limited && v.unit === "deg" };
    if (!this.live) this.live = new Map(this.display);
    this.set({ animating: { mate: id, key } });
    const period = 2600;
    const tick = () => {
      const a = this.anim; if (!a || this.closed) return;
      const t = ((performance.now() - a.t0) % (a.loop ? period : 2 * period)) / period;
      const u = a.loop ? t : t <= 1 ? t : 2 - t;
      const value = a.from + (a.to - a.from) * (a.loop ? u : (1 - Math.cos(u * Math.PI)) / 2);
      this.refresh({ drives: [{ mate: id, key, value: v.unit === "deg" ? (value * Math.PI) / 180 : value }] });
      a.frame = requestAnimationFrame(tick);
    };
    this.anim.frame = requestAnimationFrame(tick);
  }
  stopAnimation(): void {
    const a = this.anim; if (!a) return;
    cancelAnimationFrame(a.frame);
    this.anim = null;
    this.live = a.before;
    this.state = { ...this.state, animating: null };
    this.refresh();
  }

  // ---------------------------------------------------------------- exploded view and named positions
  setExploding(on: boolean): void { if (on && this.state.mating) this.cancelMate(); this.set({ exploding: on, explode: on ? this.state.explode || 0.6 : 0 }); this.place(); this.decorate(); }
  setExplode(k: number): void { this.set({ explode: Math.max(0, Math.min(3, k)) }); this.place(); }

  saveCurrentPosition(name?: string): void {
    const doc = this.session.doc; if (!doc) return;
    const moving = new Map<string, Transform>();
    for (const i of this.state.instances) if (!i.suppressed && !this.state.instanceInfo[i.id]?.grounded) { const p = this.display.get(i.id); if (p) moving.set(i.id, transformOf(p)); }
    const made = savePosition(doc, moving, name);
    if (this.commit(made.changes)) this.set({ selection: [made.item.id] });
  }
  /** Move the instances to a saved position; the mates are solved from there, and the result is one undo step. */
  applyPosition(id: string): void {
    const doc = this.session.doc, p = this.state.positions.find((x) => x.id === id);
    if (!doc || !p || this.state.mating) return;
    const start = new Map(this.display);
    for (const [inst, t] of Object.entries(p.transforms)) if (start.has(inst) && Array.isArray(t) && t.length === 12) start.set(inst, poseOf(t));
    const problem = buildProblem(instancesOf(doc), matesOf(doc), this.connectors, MATES, this.geometry, start);
    const solved = solveProblem(problem, { reach: reachOf(problem.mates) });
    const out = new Map<string, Transform>();
    for (const [inst, pose] of solved.result.poses) out.set(inst, transformOf(pose));
    const changes = [...setTransforms(doc, out), ...setMateValues(doc, measureMates(problem, solved.result.poses))];
    if (changes.length) this.commit(changes);
    this.set({ selection: [id] });
  }

  // ---------------------------------------------------------------- the pointer
  private onLeave = (): void => { if (this.hover) { this.hover = null; this.scene.setHover(null); this.decorate(); } };

  private onDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    this.viewport.canvas.focus();
    const s = this.state;
    if (!s.mating && !s.exploding && s.canEdit) {
      const handle = this.scene.triad.hit(ev);
      if (handle && s.selection.length === 1) { this.startTriadDrag(handle, s.selection[0], ev); return; }
    }
    this.down = { x: ev.clientX, y: ev.clientY, pick: this.scene.pick(ev), toggle: ev.shiftKey || ev.ctrlKey || ev.metaKey };
  };

  private onMove = (ev: PointerEvent): void => {
    if (this.viewport.navigating) return;
    if (this.drag) { this.drag.pending = ev; if (!this.drag.frame) this.drag.frame = requestAnimationFrame(() => this.dragStep()); return; }
    const s = this.state, d = this.down;
    if (d) {
      if (d.pick && !s.mating && !s.exploding && s.canEdit && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 4) { this.startBodyDrag(d.pick, ev); this.down = null; }
      return;
    }
    if (s.connecting || (s.mating && s.mating.field)) {
      this.nearConnector = s.mating ? this.connectorAt(ev) : null;
      const pick = this.nearConnector ? null : this.scene.pick(ev);
      this.hover = pick; this.scene.setHover(pick); this.decorate();
      this.viewport.canvas.style.cursor = pick || this.nearConnector ? "crosshair" : "";
    } else {
      const over = !s.mating && !s.exploding && s.canEdit && (this.scene.triad.hit(ev) || this.scene.pick(ev, { faces: true }));
      this.viewport.canvas.style.cursor = over ? "grab" : "";
    }
  };

  private onUp = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    if (this.drag) { this.finishDrag(ev); return; }
    const d = this.down; this.down = null;
    if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) >= 5) return;
    const s = this.state;
    if (s.mating) { if (s.mating.field) { const explicit = this.connectorAt(ev); if (explicit || d.pick) this.pickConnector(d.pick, explicit); } return; }
    if (s.connecting) { if (d.pick) this.addConnectorAt(d.pick); return; }
    if (d.pick) this.select(d.pick.instance, { toggle: d.toggle }); else if (!d.toggle) this.select(null);
  };

  private onDouble = (ev: MouseEvent): void => { const pick = this.scene.pick(ev); if (!pick) this.fit(); };

  /** A tool or a view may take keys first (return true when handled). */
  keyHandler: ((ev: KeyboardEvent) => boolean) | null = null;
  /** A key pressed anywhere in the assembly's frame (the view passes on the ones no field took). */
  handleKey(ev: KeyboardEvent): void { this.onKey(ev); }
  private onKey = (ev: KeyboardEvent): void => {
    if (this.keyHandler && this.keyHandler(ev)) { ev.preventDefault(); return; }
    const s = this.state, mod = ev.ctrlKey || ev.metaKey;
    const done = () => { ev.preventDefault(); ev.stopPropagation(); };
    if (ev.key === "Escape") { if (s.form) this.ask(null); else if (s.mating) this.cancelMate(); else if (s.connecting) this.setConnecting(false); else if (s.inserting) this.closeInsert(); else if (s.exploding) this.setExploding(false); else this.select(null); done(); return; }
    if (ev.key === "Enter" && s.mating) { this.acceptMate(); done(); return; }
    if (mod && ev.key.toLowerCase() === "z") { if (ev.shiftKey) this.redo(); else this.undo(); done(); return; }
    if (mod && ev.key.toLowerCase() === "y") { this.redo(); done(); return; }
    if (s.mating || mod || ev.altKey) return;
    if ((ev.key === "Delete" || ev.key === "Backspace") && s.canEdit && s.selection.length) { this.remove(); done(); return; }
    if (ev.key === "F2" && s.selection.length === 1) { this.startRename(s.selection[0]); done(); return; }
    const tool = this.tools().find((t) => t.key && t.key.toLowerCase() === ev.key.toLowerCase());
    if (tool && !(tool.disabled && tool.disabled(this))) { tool.run(this); done(); }
  };

  // ---------------------------------------------------------------- dragging: every step goes through the solver
  private beginDrag(instance: string, goal: (ev: PointerEvent) => DragGoal | null, triad: { local: Vec3; instance: string } | null, label: (ev: PointerEvent) => string | null, ev: PointerEvent): boolean {
    const doc = this.session.doc;
    if (!doc) return false;
    if (this.state.instanceInfo[instance]?.grounded) { this.host.toast("This instance is fixed (or fastened to a fixed one). Unfix it to move it.", 3500); return false; }
    this.stopAnimation();
    this.live = new Map(this.display);
    const problem = this.problem(doc);
    this.drag = { problem, reach: reachOf(problem.mates), goal, moved: false, pending: null, frame: 0, triad, label };
    try { this.viewport.canvas.setPointerCapture(ev.pointerId); } catch (e) { /* a synthetic event has no pointer to capture */ }
    this.viewport.canvas.style.cursor = "grabbing";
    return true;
  }

  private startBodyDrag(pick: AssemblyPick, ev: PointerEvent): void {
    const pose = this.display.get(pick.instance);
    if (!pose) return;
    if (!this.state.selection.includes(pick.instance)) this.select(pick.instance);
    const local = applyPose(inverse(pose), pick.point);
    // the grabbed point slides in the plane through it that faces the camera
    const n = this.viewport.ray(ev).direction.clone().normalize(), p0 = pick.point;
    const goal = (e: PointerEvent): DragGoal | null => {
      const ray = this.viewport.ray(e), den = ray.direction.dot(n);
      if (Math.abs(den) < 1e-9) return null;
      const t = ((p0[0] - ray.origin.x) * n.x + (p0[1] - ray.origin.y) * n.y + (p0[2] - ray.origin.z) * n.z) / den;
      return { body: pick.instance, point: local, target: [ray.origin.x + ray.direction.x * t, ray.origin.y + ray.direction.y * t, ray.origin.z + ray.direction.z * t] };
    };
    if (this.beginDrag(pick.instance, goal, null, () => null, ev)) { this.drag!.pending = ev; this.dragStep(); }
  }

  private startTriadDrag(handle: TriadHandle, instance: string, ev: PointerEvent): void {
    const pose = this.display.get(instance), shown = this.scene.triad.shown;
    if (!pose || !shown) return;
    const local = applyPose(inverse(pose), shown.p), q0 = pose.q;
    const grip = this.scene.triad.begin(handle, ev);
    let last = 0;
    const goal = (e: PointerEvent): DragGoal => {
      last = grip.measure(e, e.altKey);
      if (handle.kind === "move") return { body: instance, point: local, target: [grip.origin[0] + grip.axis[0] * last, grip.origin[1] + grip.axis[1] * last, grip.origin[2] + grip.axis[2] * last], rotation: q0 };
      return { body: instance, point: local, target: grip.origin, rotation: qnorm(qmul(qaxis(grip.axis, last), q0)) };
    };
    const label = (): string => (handle.kind === "move" ? `${Math.round(last * 1000) / 1000} mm` : `${Math.round(((last * 180) / Math.PI) * 100) / 100}°`);
    if (this.beginDrag(instance, goal, { local, instance }, label, ev)) this.scene.triad.setActive(handle);
  }

  private dragStep(): void {
    const d = this.drag; if (!d) return;
    d.frame = 0;
    const ev = d.pending; d.pending = null;
    const t0 = performance.now();
    if (!ev || !this.live) return;
    const goal = d.goal(ev);
    if (!goal) return;
    for (const b of d.problem.bodies) { const p = this.live.get(b.id); if (p) b.pose = p; }
    const r = solve(d.problem.bodies, d.problem.mates, { drag: goal, reach: d.reach, maxIterations: 16 });
    this.dragMs = r.ms;
    if (!r.ok) return;   // the mates would not hold there: stay where they did
    d.moved = true;
    this.live = r.poses; this.display = r.poses;
    this.place();
    if (d.triad) { const pose = r.poses.get(d.triad.instance); if (pose) this.scene.triad.setPose({ p: applyPose(pose, d.triad.local), q: pose.q }); }
    const readout = d.label(ev);
    if (readout !== this.state.readout) this.set({ readout });
    this.stepMs = performance.now() - t0;
  }

  private finishDrag(ev: PointerEvent): void {
    const d = this.drag; if (!d) return;
    if (d.pending) { cancelAnimationFrame(d.frame); this.dragStep(); }
    this.drag = null;
    try { this.viewport.canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* not captured */ }
    this.viewport.canvas.style.cursor = "";
    this.scene.triad.setActive(null);
    const doc = this.session.doc;
    const changes = doc && d.moved ? this.settled(doc) : [];
    this.live = null;
    this.state = { ...this.state, readout: null };
    if (!changes.length || !this.commit(changes)) this.refresh();
  }

  /** how long the solver took for the last step of a drag, ms */
  dragMs = 0;
  /** how long the whole last step of a drag took (solve, then moving what is drawn), ms */
  stepMs = 0;

  /** How far the display is from what the document stores, mm: zero once everything is committed (tests wait on it). */
  get unsettled(): number {
    let top = 0;
    for (const i of this.state.instances) { const p = this.display.get(i.id); if (p) top = Math.max(top, poseDistance(p, poseOf(storedTransform(i)))); }
    return top;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.followTimer);
    if (this.anim) cancelAnimationFrame(this.anim.frame);
    if (this.drag) cancelAnimationFrame(this.drag.frame);
    const c = this.viewport.canvas;
    c.removeEventListener("pointerdown", this.onDown); c.removeEventListener("pointermove", this.onMove); c.removeEventListener("pointerup", this.onUp);
    c.removeEventListener("pointercancel", this.onUp); c.removeEventListener("pointerleave", this.onLeave); c.removeEventListener("dblclick", this.onDouble); c.removeEventListener("keydown", this.onKey);
    this.session.close(); this.boards.dispose(); this.sources.dispose(); this.scene.dispose(); this.viewport.dispose(); this.listeners.clear();
  }
}
