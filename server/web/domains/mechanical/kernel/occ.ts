// occ.ts — loading OpenCascade and the helpers every feature needs over its raw bindings: walking sub-shapes,
// reading an operation's history, extrusion and booleans that carry face names, error text.
//
// The kernel is npm `replicad-opencascadejs` (OpenCascade 7.x compiled to WebAssembly, LGPL-2.1 with the Open
// CASCADE exception; the same licence family as the OCCT the desktop app links).  Only its bindings are used,
// not the replicad library.  The .wasm (about 23 MB, 7 MB compressed) is copied to static/dist/pyodide by
// scripts/build-python.mjs and fetched by the worker on first use; nothing on the page loads it.
//
// The bindings are embind objects: everything made with `new oc.X()` or returned by value lives in the wasm heap
// until `.delete()` is called.  Features use `ctx.tmp()` / `ctx.own()` (types.ts); helpers here take a `keep`
// callback for the same purpose.
import type { TopoDS_Edge, TopoDS_Face } from "replicad-opencascadejs";
import type { Frame, Vec3 } from "../core/geometry";
import { FeatureError, type FaceNamer, type NamedShape, type OC, type Shape } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
export type Keep = <T extends { delete(): void }>(obj: T) => T;
const HASH_MAX = 2147483647;

/** A set of shapes that answers "which of these is this shape" without comparing against every one. */
export class ShapeIndex<T> {
  private readonly buckets = new Map<number, { shape: Shape; value: T }[]>();
  constructor(private readonly k: Kernel) {}
  add(shape: Shape, value: T): void {
    const h = this.k.hash(shape);
    const b = this.buckets.get(h);
    if (b) b.push({ shape, value }); else this.buckets.set(h, [{ shape, value }]);
  }
  get(shape: Shape): T | undefined {
    for (const e of this.buckets.get(this.k.hash(shape)) || []) if (e.shape.IsSame(shape)) return e.value;
    return undefined;
  }
  has(shape: Shape): boolean { return this.get(shape) !== undefined; }
}

/** What an operation that made a shape from others says about them (BRepBuilderAPI_MakeShape's history). */
export interface History { Modified(s: Shape): Any; Generated(s: Shape): Any; IsDeleted(s: Shape): boolean }

/** The result of an operation and how to name its faces. */
export interface NamedResult { shape: Shape; names: FaceNamer }

export class Kernel {
  constructor(readonly oc: OC) {}
  private get o(): Any { return this.oc; }

  /**
   * Where the shape wrappers that `sub` and `list` hand out are recorded, so somebody deletes them.  The
   * regeneration engine points it at the running feature's cache entry; anything else uses `withScope`.
   */
  scope: { delete(): void }[] | null = null;
  private track<T extends { delete(): void }>(o: T): T { if (this.scope) this.scope.push(o); return o; }
  /** Run `fn`, then delete every wrapper the helpers handed out during it. */
  withScope<T>(fn: () => T): T {
    const outer = this.scope, mine: { delete(): void }[] = [];
    this.scope = mine;
    try { return fn(); } finally {
      this.scope = outer;
      for (const o of mine.reverse()) { try { o.delete(); } catch (x) { /* already gone */ } }
    }
  }

  hash(shape: Shape): number { return this.o.ReplicadShapeHasher.HashCode(shape, HASH_MAX); }

  /** The shapes in an OpenCascade list, as an array. */
  list(l: Any): Shape[] {
    const out: Shape[] = [];
    const copy = new this.o.NCollection_List_TopoDS_Shape(l);
    while (!copy.IsEmpty()) { out.push(this.track(copy.First())); copy.RemoveFirst(); }
    copy.delete();
    return out;
  }

  /** The distinct faces, edges, vertices or solids of a shape, in the explorer's order. */
  sub(shape: Shape, kind: "face" | "edge" | "vertex" | "solid" | "wire" | "shell"): Shape[] {
    const E = this.o.TopAbs_ShapeEnum;
    const what = { face: E.TopAbs_FACE, edge: E.TopAbs_EDGE, vertex: E.TopAbs_VERTEX, solid: E.TopAbs_SOLID, wire: E.TopAbs_WIRE, shell: E.TopAbs_SHELL }[kind];
    const out: Shape[] = [];
    const seen = new ShapeIndex<true>(this);
    const ex = new this.o.TopExp_Explorer(shape, what, E.TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) {
      const s = ex.Current();
      if (seen.has(s)) { s.delete(); continue; }
      seen.add(s, true);
      out.push(this.track(kind === "face" ? this.o.TopoDS.Face(s) : kind === "edge" ? this.o.TopoDS.Edge(s) : kind === "vertex" ? this.o.TopoDS.Vertex(s) : s));
    }
    ex.delete();
    return out;
  }

  pnt(p: Vec3): Any { return new this.o.gp_Pnt(p[0], p[1], p[2]); }
  dir(v: Vec3): Any { return new this.o.gp_Dir(v[0], v[1], v[2]); }
  vec(v: Vec3): Any { return new this.o.gp_Vec(v[0], v[1], v[2]); }
  xyz(p: Any): Vec3 { return [p.X(), p.Y(), p.Z()]; }

  /** A message for whatever a kernel call threw: OpenCascade's own text when there is one. */
  describe(e: unknown): string {
    if (e instanceof FeatureError) return e.message;
    try {
      if (typeof e === "number") { const f = this.o.OCJS.getStandard_FailureData(e); return f.GetMessageString() || f.ExceptionType() || "the kernel failed"; }
      const WE = (globalThis as Any).WebAssembly && (globalThis as Any).WebAssembly.Exception;
      if (WE && e instanceof WE) { const m = this.o.getExceptionMessage(e); return m[1] || m[0] || "the kernel failed"; }
    } catch (x) { /* fall through to the plain text */ }
    return e instanceof Error ? e.message : String(e);
  }

  /** The solids of a boolean's result: a compound is taken apart, a lone solid is itself. */
  solids(shape: Shape): Shape[] {
    if (shape.IsNull()) return [];
    return this.sub(shape, "solid");
  }

  volume(shape: Shape): number {
    const g = new this.o.GProp_GProps();
    this.o.BRepGProp.VolumeProperties(shape, g, true, false, false);
    const v = g.Mass(); g.delete();
    return v;
  }

  /** A point of a face or edge that orders siblings the same way on every rebuild: its centre of mass. */
  centre(shape: Shape, kind: "face" | "edge"): Vec3 {
    const g = new this.o.GProp_GProps();
    if (kind === "face") this.o.BRepGProp.SurfaceProperties(shape, g, false, false); else this.o.BRepGProp.LinearProperties(shape, g, false, false);
    const c = g.CentreOfMass(); const out = this.xyz(c); c.delete(); g.delete();
    return out;
  }

  /**
   * The plane of a planar face as a sketch frame, or null when the face is not planar.  The normal points out of
   * the solid; x is the surface's own first direction; the origin is the point of the plane nearest the world
   * origin, so it does not move when the face is trimmed differently.
   */
  faceFrame(face: TopoDS_Face): Frame | null {
    const ad = new this.o.BRepAdaptor_Surface(face, true);
    try {
      if (ad.GetType() !== this.o.GeomAbs_SurfaceType.GeomAbs_Plane) return null;
      const pln = ad.Plane(), pos = pln.Position();
      const at = this.xyz(pos.Location()), x = this.xyz(pos.XDirection());
      let n = this.xyz(pos.Direction());
      pln.delete(); pos.delete();
      if (face.Orientation() === this.o.TopAbs_Orientation.TopAbs_REVERSED) n = [-n[0], -n[1], -n[2]];
      const d = at[0] * n[0] + at[1] * n[1] + at[2] * n[2];
      const y: Vec3 = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
      return { origin: [n[0] * d, n[1] * d, n[2] * d], x, y, normal: n };
    } finally { ad.delete(); }
  }

  /** Where a vertex is. */
  vertexPoint(vertex: Shape): Vec3 {
    const p = this.o.BRep_Tool.Pnt(vertex); const out = this.xyz(p); p.delete();
    return out;
  }

  // ---------------------------------------------------------------- names through an operation

  /**
   * Name the faces of an operation's result from the faces that went in.
   *   • a face the operation left alone, or modified, keeps the name it had;
   *   • when one named face became several, the first (in a fixed geometric order) keeps the name and the others
   *     get `name~2`, `name~3`, …;
   *   • a face generated from a named face, edge or vertex of an input (a fillet from an edge) is
   *     `<feature>:from(<that name>)`;
   *   • anything left is `<feature>:new#<n>` in geometric order.
   * `inputs` are the named sub-shapes of everything that went in, the body being changed first: when two inputs
   * end up as one face (a tool's cap flush with the target's), the first input's name wins.
   */
  carryNames(result: Shape, history: History, inputs: readonly NamedShape[], featureId: string, generators: readonly NamedShape[] = []): FaceNamer {
    const faces = this.sub(result, "face");
    const index = new ShapeIndex<number>(this);
    faces.forEach((f, i) => index.add(f, i));
    const claims: string[][] = faces.map(() => []);
    for (const input of inputs) {
      const images = this.list(history.Modified(input.shape));
      if (images.length) { for (const im of images) { const i = index.get(im); if (i !== undefined) claims[i].push(input.name); } }
      else if (!history.IsDeleted(input.shape)) { const i = index.get(input.shape); if (i !== undefined) claims[i].push(input.name); }
    }
    for (const g of [...inputs, ...generators]) {
      for (const im of this.list(history.Generated(g.shape))) { const i = index.get(im); if (i !== undefined && !claims[i].length) claims[i].push(`${featureId}:from(${g.name})`); }
    }
    const names: (string | null)[] = claims.map((c) => c[0] || null);
    this.settleNames(faces, names, `${featureId}:new`, "face");
    const final = new ShapeIndex<string>(this);
    faces.forEach((f, i) => final.add(f, names[i]!));
    return (face) => final.get(face) ?? null;
  }

  /** Make names unique: duplicates get ~2, ~3 in a fixed geometric order, and unnamed shapes get `<fallback>#n`. */
  settleNames(shapes: Shape[], names: (string | null)[], fallback: string, kind: "face" | "edge" | "vertex"): void {
    const key = (i: number) => (kind === "vertex" ? this.vertexPoint(shapes[i]) : this.centre(shapes[i], kind)).map((v) => Math.round(v * 1e4) / 1e4);
    const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    const groups = new Map<string, number[]>();
    names.forEach((n, i) => { const g = n ?? "\u0000"; if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(i); });
    for (const [name, members] of groups) {
      if (name !== "\u0000" && members.length === 1) continue;
      const keys = new Map(members.map((i) => [i, key(i)]));
      members.sort((a, b) => cmp(keys.get(a)!, keys.get(b)!));
      members.forEach((i, n) => { names[i] = name === "\u0000" ? `${fallback}#${n + 1}` : n ? `${name}~${n + 1}` : name; });
    }
  }

  // ---------------------------------------------------------------- operations that keep names

  /**
   * Extrude a planar face along a vector.  The caps are `<feature>:start:<region>` and `<feature>:end:<region>`,
   * and the side swept by each edge is `<feature>:side:<the edge's sketch entity>`.
   */
  prism(face: TopoDS_Face, along: Vec3, featureId: string, regionId: string, edges: readonly { entity: string; edge: TopoDS_Edge }[], keep: Keep): NamedResult {
    const v = this.vec(along);
    const prism = keep(new this.o.BRepPrimAPI_MakePrism(face, v, false, true));
    v.delete();
    prism.Build();
    if (!prism.IsDone()) throw new FeatureError("The profile could not be extruded.");
    const shape: Shape = this.track(prism.Shape());
    const named = new ShapeIndex<string>(this);
    named.add(this.track(prism.FirstShape()), `${featureId}:start:${regionId}`);
    named.add(this.track(prism.LastShape()), `${featureId}:end:${regionId}`);
    for (const e of edges) for (const side of this.list(prism.Generated(e.edge))) if (!named.has(side)) named.add(side, `${featureId}:side:${e.entity}`);
    return { shape, names: (f) => named.get(f) ?? null };
  }

  /**
   * A boolean of two named shapes: "fuse" (a ∪ b), "cut" (a − b) or "common" (a ∩ b).  Coplanar faces left by
   * the operation are merged, as a modeller expects.  Names are carried by `carryNames`, `a` first.
   */
  boolean(op: "fuse" | "cut" | "common", a: { shape: Shape; faces: readonly NamedShape[] }, b: { shape: Shape; faces: readonly NamedShape[] }, featureId: string, keep: Keep): NamedResult {
    const range = new this.o.Message_ProgressRange();
    const Algo = op === "fuse" ? this.o.BRepAlgoAPI_Fuse : op === "cut" ? this.o.BRepAlgoAPI_Cut : this.o.BRepAlgoAPI_Common;
    const algo = keep(new Algo(a.shape, b.shape, range));
    range.delete();
    algo.Build();
    if (!algo.IsDone() || algo.HasErrors()) throw new FeatureError(op === "fuse" ? "The bodies could not be joined." : op === "cut" ? "The material could not be removed." : "The bodies could not be intersected.");
    algo.SimplifyResult(true, true, 1e-4);
    const shape: Shape = this.track(algo.Shape());
    return { shape, names: this.carryNames(shape, algo, [...a.faces, ...b.faces], featureId) };
  }

  /** The faces of `shape` with the names `names` gives them, fallbacks settled: what booleans take as input. */
  namedFaces(shape: Shape, names: FaceNamer, featureId: string): NamedShape[] {
    const faces = this.sub(shape, "face");
    const out: (string | null)[] = faces.map((f, i) => names(f as TopoDS_Face, i));
    this.settleNames(faces, out, `${featureId}:new`, "face");
    return faces.map((f, i) => ({ name: out[i]!, shape: f }));
  }
}
