// regen.ts — regeneration: run the feature list, in order, into bodies.
//
// The engine keeps what every feature produced last time.  A feature is evaluated again only if it, or a
// feature before it, changed (id, type, suppression or parameters; a rename changes nothing): editing the
// tenth feature of twenty re-runs the last eleven, and moving the rollback bar back and forth re-runs nothing.
// A feature that fails leaves the model as it found it and the features after it still run.
//
// It talks to nothing but the kernel, so it runs the same in the worker (worker.ts) and in a node test.
import { stableJson } from "../../../shared/itemdoc/itemdoc";
import type { FeatureDefinition } from "../core/feature";
import { DEFAULT_PLANES, toWorld, type Frame, type GeomRef, type PlaneRef } from "../core/geometry";
import { curvePoints, pointOf } from "../sketch/format";
import { ShapeIndex, type Kernel } from "./occ";
import type { BodyResult, DatumView, FeatureInput, FeatureReport, RegenResult, SketchView } from "./protocol";
import { qualityFor, tessellate, type MeshQuality } from "./tessellate";
import { FeatureError, type Body, type BodyTopo, type Datum, type EvalContext, type FaceNamer, type ModelState, type NamedShape, type Resolved, type Shape, type SketchGeometry } from "./types";

interface Deletable { delete(): void }
interface Entry { json: string; state: ModelState; owned: Deletable[]; report: FeatureReport }

const EMPTY: ModelState = { bodies: [], sketches: {}, datums: {} };
let nextRev = 1;

/** Names for every face, edge and vertex of a shape.  An edge is named by the faces it lies between, a vertex by the faces that meet there. */
export function buildTopo(k: Kernel, shape: Shape, names: FaceNamer, featureId: string): BodyTopo {
  const faces = k.namedFaces(shape, names, featureId);
  const collect = (kind: "edge" | "vertex"): NamedShape[] => {
    const index = new ShapeIndex<number>(k);
    const shapes: Shape[] = [], around: Set<string>[] = [];
    for (const f of faces) {
      for (const s of k.sub(f.shape, kind)) {
        let i = index.get(s);
        if (i === undefined) { i = shapes.length; index.add(s, i); shapes.push(s); around.push(new Set()); }
        around[i].add(f.name);
      }
    }
    const out: (string | null)[] = around.map((set) => `${kind}(${Array.from(set).sort().join("|")})`);
    k.settleNames(shapes, out, `${featureId}:${kind}`, kind);
    return shapes.map((s, i) => ({ name: out[i]!, shape: s }));
  };
  return { faces, edges: collect("edge"), vertices: collect("vertex") };
}

export class RegenEngine {
  private entries: Entry[] = [];
  private readonly defs = new Map<string, FeatureDefinition>();
  /** the model after the last regeneration, for services (measure, export) */
  state: ModelState = EMPTY;

  /** `quality`: one tolerance for every body (a test, an export preview); by default each body gets what suits its size (tessellate.ts qualityFor). */
  constructor(readonly k: Kernel, defs: readonly FeatureDefinition[], private quality?: MeshQuality) {
    for (const d of defs) this.defs.set(d.type, d);
  }

  private drop(from: number): void {
    for (const e of this.entries.splice(from)) for (const o of e.owned.reverse()) { try { o.delete(); } catch (x) { /* already gone */ } }
  }
  dispose(): void { this.drop(0); this.state = EMPTY; }
  /** The model just before a feature was built, as the last regeneration has it (null: no such feature built). */
  before(featureId: string): ModelState | null {
    const i = this.entries.findIndex((e) => e.report.id === featureId);
    return i < 0 ? null : i ? this.entries[i - 1].state : EMPTY;
  }

  /**
   * Build `features[0 .. rollback)`.  `have` lists the body revisions the caller already holds meshes for.
   * `progress` is called before each feature that is evaluated.
   */
  async regenerate(features: readonly FeatureInput[], rollback: number, have: readonly number[] = [], progress?: (index: number, featureId: string) => void): Promise<RegenResult> {
    const t0 = Date.now();
    const built = Math.max(0, Math.min(rollback, features.length));
    const jsons = features.map((f) => stableJson({ id: f.id, type: f.type, suppressed: !!f.suppressed, params: f.suppressed ? null : f.params }));
    let valid = 0;
    while (valid < this.entries.length && valid < jsons.length && this.entries[valid].json === jsons[valid]) valid++;
    // Everything from the first change on is stale.  What lies beyond the rollback bar stays cached for as long
    // as nothing before it changed, so moving the bar costs nothing.
    if (valid < this.entries.length) this.drop(valid);
    const rebuiltFrom = valid >= built ? features.length : valid;

    for (let i = this.entries.length; i < built; i++) {
      const f = features[i];
      const before = i ? this.entries[i - 1].state : EMPTY;
      if (f.suppressed) { this.entries.push({ json: jsons[i], state: before, owned: [], report: { id: f.id, status: "suppressed" } }); continue; }
      progress?.(i, f.id);
      this.entries.push(await this.run(f, jsons[i], before));
    }

    const state = built ? this.entries[built - 1].state : EMPTY;
    this.state = state;
    const reports: FeatureReport[] = features.map((f, i) => {
      if (i >= built) return { id: f.id, status: "rolled-back" };
      const r = this.entries[i].report;
      return i < valid ? { ...r, cached: true, ms: undefined } : r;
    });

    const haveSet = new Set(have);
    const bodies: BodyResult[] = state.bodies.map((b) => {
      const out: BodyResult = { id: b.id, name: b.name, createdBy: b.createdBy, rev: b.rev, ...(b.reference ? { reference: true as const } : {}) };
      if (!haveSet.has(b.rev)) out.mesh = this.k.withScope(() => tessellate(this.k, b, this.quality || qualityFor(this.k, b)));
      return out;
    });
    const sketches = Object.values(state.sketches).map(sketchView);
    const datums = Object.values(state.datums || {}).map((d): DatumView => { const v: Datum = { ...d }; delete v.shape; return v; });
    return { features: reports, bodies, sketches, datums, rebuiltFrom, ms: Date.now() - t0 };
  }

  private async run(f: FeatureInput, json: string, before: ModelState): Promise<Entry> {
    const k = this.k;
    const def = this.defs.get(f.type);
    const datums: NonNullable<ModelState["datums"]> = { ...(before.datums || {}) };
    const state: ModelState = { bodies: before.bodies.slice(), sketches: { ...before.sketches }, datums };
    const owned: Deletable[] = [], temp: Deletable[] = [], notes: string[] = [];
    const t0 = Date.now();
    const made = (body: Body) => { owned.push(body.shape); return body; };
    // every wrapper the helpers hand out while this feature runs lives exactly as long as its cached result
    k.scope = owned;
    const ctx: EvalContext = {
      oc: k.oc, k, feature: { id: f.id, type: f.type, name: f.name },
      bodies: () => (state.bodies.some((b) => b.reference) ? state.bodies.filter((b) => !b.reference) : state.bodies),
      allBodies: () => state.bodies,
      body: (id) => state.bodies.find((b) => b.id === id),
      addBody: (shape, names, o = {}) => {
        let id = o.suffix ? `${f.id}:${o.suffix}` : f.id;
        for (let n = 2; state.bodies.some((b) => b.id === id); n++) id = `${f.id}:${o.suffix ? o.suffix + "." : ""}${n}`;
        const body = made({ id, name: o.name || `Part ${state.bodies.length + 1}`, rev: nextRev++, shape, topo: buildTopo(k, shape, names, f.id), createdBy: f.id, ...(o.reference ? { reference: true } : {}) });
        state.bodies.push(body);
        return body;
      },
      replaceBody: (body, shape, names) => {
        const i = state.bodies.indexOf(body);
        if (i < 0) throw new Error("replaceBody: the body is not in the model");
        const next = made({ ...body, rev: nextRev++, shape, topo: buildTopo(k, shape, names, f.id) });
        state.bodies[i] = next;
        return next;
      },
      removeBody: (body) => { const i = state.bodies.indexOf(body); if (i >= 0) state.bodies.splice(i, 1); },
      sketch: (id) => {
        const s = state.sketches[id];
        if (!s) throw new FeatureError("The sketch this feature uses is missing, suppressed or failed.");
        return s;
      },
      setSketch: (s) => { state.sketches[s.featureId] = s; },
      datum: (id) => {
        const d = datums[id];
        if (!d) throw new FeatureError("The reference geometry this feature uses is missing, suppressed or failed.");
        return d;
      },
      setDatum: (d) => { datums[d.featureId] = d; },
      history: (id) => {
        const i = this.entries.findIndex((e) => e.report.id === id);
        return i < 0 ? null : { before: i ? this.entries[i - 1].state : EMPTY, after: this.entries[i].state, status: this.entries[i].report.status };
      },
      resolve: (ref) => resolveRef(state, ref),
      frameOf: (plane) => frameOf(k, state, plane),
      own: (o) => { owned.push(o); return o; },
      tmp: (o) => { temp.push(o); return o; },
      fail: (m) => new FeatureError(m),
      warn: (m) => { notes.push(m); },
    };
    let report: FeatureReport;
    let result = state;
    try {
      if (!def) throw new FeatureError(`This Junction does not know the feature type "${f.type}". Reload the page to update.`);
      await def.evaluate(ctx, f.params);
      report = notes.length ? { id: f.id, status: "warning", message: notes.join(" ") } : { id: f.id, status: "ok" };
    } catch (e) {
      // the model stays as the feature found it; what it had made so far is released
      result = before;
      for (const o of owned.splice(0).reverse()) { try { o.delete(); } catch (x) { /* already gone */ } }
      report = { id: f.id, status: "error", message: e instanceof FeatureError ? e.message : `Internal error: ${k.describe(e)}` };
    }
    k.scope = null;
    for (const o of temp.reverse()) { try { o.delete(); } catch (x) { /* already gone */ } }
    report.ms = Date.now() - t0;
    return { json, state: result, owned, report };
  }
}

export function resolveRef(state: ModelState, ref: GeomRef): Resolved {
  const group = (b: Body) => (ref.kind === "face" ? b.topo.faces : ref.kind === "edge" ? b.topo.edges : b.topo.vertices);
  const home = state.bodies.find((b) => b.id === ref.body);
  for (const b of home ? [home, ...state.bodies.filter((x) => x !== home)] : state.bodies) {
    const hit = group(b).find((n) => n.name === ref.name);
    if (hit) return { kind: ref.kind, body: b, shape: hit.shape, name: hit.name };
  }
  throw new FeatureError(`A ${ref.kind} this feature refers to no longer exists. Edit the feature and pick it again.`);
}

export function frameOf(k: Kernel, state: ModelState, plane: PlaneRef): Frame {
  if (!plane || plane.kind === "plane") {
    const p = DEFAULT_PLANES[(plane && plane.plane) || "top"];
    if (!p) throw new FeatureError("The sketch plane is not one of Top, Front or Right.");
    return p.frame;
  }
  if (plane.kind === "datum") {
    const d = state.datums && state.datums[plane.feature];
    if (!d || d.kind !== "plane" || !d.frame) throw new FeatureError("The reference plane this sketch is on is missing, suppressed or failed.");
    return d.frame;
  }
  const r = resolveRef(state, plane.ref);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frame = r.kind === "face" ? k.faceFrame(r.shape as any) : null;
  if (!frame) throw new FeatureError("A sketch needs a flat face. Pick a planar face or one of the default planes.");
  return frame;
}

/** A sketch as the page draws it. */
export function sketchView(s: SketchGeometry): SketchView {
  const curves: SketchView["curves"] = [], points: SketchView["points"] = [];
  for (const id of Object.keys(s.data.entities).sort()) {
    const e = s.data.entities[id];
    if (e.type === "point") { const p = pointOf(s.data, id); if (p) points.push({ entity: id, position: toWorld(s.frame, p) }); continue; }
    const pts = curvePoints(s.data, e);
    if (pts.length < 2) continue;
    const out = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => { const w = toWorld(s.frame, p); out[i * 3] = w[0]; out[i * 3 + 1] = w[1]; out[i * 3 + 2] = w[2]; });
    curves.push({ entity: id, construction: !!e.construction, points: out });
  }
  const flat = (poly: readonly [number, number][]) => { const a = new Float32Array(poly.length * 2); poly.forEach((p, i) => { a[i * 2] = p[0]; a[i * 2 + 1] = p[1]; }); return a; };
  const regions = s.regions.map((r) => ({ id: r.id, outer: flat(r.region.outer.polygon), holes: r.region.holes.map((h) => flat(h.polygon)) }));
  return { featureId: s.featureId, frame: s.frame, curves, points, regions, open: s.open };
}

/** Every buffer of a result, for postMessage's transfer list. */
export function resultBuffers(r: RegenResult): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const b of r.bodies) if (b.mesh) for (const a of [b.mesh.positions, b.mesh.normals, b.mesh.indices, b.mesh.faces.start, b.mesh.faces.count, b.mesh.edges.positions, b.mesh.edges.start, b.mesh.edges.count, b.mesh.vertices.positions]) out.push(a.buffer as ArrayBuffer);
  for (const s of r.sketches) { for (const c of s.curves) out.push(c.points.buffer as ArrayBuffer); for (const g of s.regions) { out.push(g.outer.buffer as ArrayBuffer); for (const h of g.holes) out.push(h.buffer as ArrayBuffer); } }
  return out;
}
