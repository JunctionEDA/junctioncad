// solve.ts — worker side of the board link: turn each link's drives into board geometry (format.ts `Solved`)
// from the model the last regeneration left.  Called through the "boardlink-solve" service.
//
// Every length that leaves here is in the board's units (whole nanometres, Y down) and went through
// transform.ts.  A drive that cannot be solved keeps the geometry it had and gets a line in `errors`.
import { DEFAULT_PLANES, toWorld, type Frame, type GeomRef, type PlaneRef, type Vec3 } from "../core/geometry";
import type { ServiceContext } from "../kernel/service";
import type { Body, Shape } from "../kernel/types";
import { pointOf } from "../sketch/format";
import { readLink, type BoardLinkItem, type Curve, type Drive, type DriveSource, type Solved, type SolvedDrive } from "./format";
import { builtFrames } from "../board/placement";
import { liftFrame, mmToNm, modelToBoard, type Placement } from "./transform";
import type { Item } from "../../../shared/itemdoc/itemdoc";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

class Lost extends Error {}
const lost = (m: string) => new Lost(m);

function findFace(ctx: ServiceContext, ref: GeomRef): { body: Body; shape: Shape } {
  const bodies = ctx.state.bodies;
  const order = [...bodies.filter((b) => b.id === ref.body), ...bodies.filter((b) => b.id !== ref.body)];
  for (const body of order) { const f = body.topo.faces.find((x) => x.name === ref.name); if (f) return { body, shape: f.shape }; }
  throw lost("A face this was taken from no longer exists.");
}

function planeFrame(ctx: ServiceContext, plane: PlaneRef): Frame {
  if (plane.kind === "plane") { const p = DEFAULT_PLANES[plane.plane]; if (!p) throw lost("The board's plane is not a plane of this part studio."); return p.frame; }
  if (plane.kind === "datum") {   // a reference plane feature
    const d = ctx.state.datums && ctx.state.datums[plane.feature];
    if (!d || d.kind !== "plane" || !d.frame) throw lost("The reference plane the board lies on is missing, suppressed or failed.");
    return d.frame;
  }
  const f = ctx.k.faceFrame(findFace(ctx, plane.ref).shape as Any);
  if (!f) throw lost("The face the board lies on is no longer flat.");
  return f;
}

/** The planar faces a source names, each checked to lie parallel to the board. */
function sourceFaces(ctx: ServiceContext, source: DriveSource, normal: Vec3): Shape[] {
  if (source.kind === "sketch") {
    const sk = ctx.state.sketches[source.feature];
    if (!sk) throw lost("The sketch this was taken from is not built (deleted, suppressed or below the rollback bar).");
    if (Math.abs(sk.frame.normal[0] * normal[0] + sk.frame.normal[1] * normal[1] + sk.frame.normal[2] * normal[2]) < 0.9999) throw lost("The sketch is not parallel to the board.");
    if (!sk.regions.length) throw lost("The sketch has no closed region.");
    return sk.regions.map((r) => r.face as Shape);
  }
  if (!source.refs.length) throw lost("No face is picked.");
  return source.refs.map((ref) => {
    const face = findFace(ctx, ref).shape;
    const f = ctx.k.faceFrame(face as Any);
    if (!f) throw lost("A picked face is not flat.");
    if (Math.abs(f.normal[0] * normal[0] + f.normal[1] * normal[1] + f.normal[2] * normal[2]) < 0.9999) throw lost("A picked face is not parallel to the board.");
    return face;
  });
}

/** The wires of a planar face, the outer one first (the one whose bounding box is largest). */
function wiresOf(ctx: ServiceContext, face: Shape): Shape[] {
  const oc = ctx.oc as Any, wires = ctx.k.sub(face, "wire");
  if (wires.length < 2) return wires;
  const size = (w: Shape): number => {
    const box = new oc.Bnd_Box(); oc.BRepBndLib.Add(w, box, false);
    const lo = box.CornerMin(), hi = box.CornerMax();
    const d = Math.hypot(hi.X() - lo.X(), hi.Y() - lo.Y(), hi.Z() - lo.Z());
    lo.delete(); hi.delete(); box.delete();
    return d;
  };
  const sized = wires.map((w) => ({ w, d: size(w) })).sort((a, b) => b.d - a.d);
  return sized.map((s) => s.w);
}

/** A face made of one wire of another (its outer boundary alone). */
function faceOfWire(ctx: ServiceContext, wire: Shape, own: { delete(): void }[]): Shape {
  const oc = ctx.oc as Any;
  const mf = new oc.BRepBuilderAPI_MakeFace(oc.TopoDS.Wire(wire), true); own.push(mf);
  if (!mf.IsDone()) throw lost("The outline could not be closed.");
  const f = mf.Face(); own.push(f);
  return f;
}

/** The wires of `face` moved inwards by `inset` (outwards when negative), as a shape. */
function insetWires(ctx: ServiceContext, face: Shape, inset: number, own: { delete(): void }[]): Shape[] {
  const oc = ctx.oc as Any;
  const mk = new oc.BRepOffsetAPI_MakeOffset(oc.TopoDS.Face(face), oc.GeomAbs_JoinType.GeomAbs_Arc, false); own.push(mk);
  try { mk.Perform(-inset, 0); } catch (e) { throw lost("The outline could not be offset by that much."); }
  if (!mk.IsDone()) throw lost("The outline could not be offset by that much.");
  const shape = mk.Shape(); own.push(shape);
  const wires = ctx.k.sub(shape, "wire");
  if (!wires.length) throw lost("The inset leaves nothing of the outline.");
  return wires;
}

interface EdgeCurve { curve: Curve | null; /** the edge as a polyline in board nanometres (x, y pairs), for loops */ poly: number[] }

/** One edge as a board curve and as a polyline. */
function edgeCurve(ctx: ServiceContext, edge: Shape, pl: Placement): EdgeCurve[] {
  const oc = ctx.oc as Any;
  const ad = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  try {
    const t0 = ad.FirstParameter(), t1 = ad.LastParameter();
    const at = (t: number): [number, number] => { const p = ad.Value(t); const b = modelToBoard(pl, [p.X(), p.Y(), p.Z()]); p.delete(); return [b.x, b.y]; };
    const type = ad.GetType(), T = oc.GeomAbs_CurveType;
    const sample = (n: number): number[] => { const out: number[] = []; for (let i = 0; i <= n; i++) out.push(...at(t0 + (t1 - t0) * i / n)); return out; };
    if (type === T.GeomAbs_Line) {
      const a = at(t0), b = at(t1);
      return [{ curve: ["l", a[0], a[1], b[0], b[1]], poly: [...a, ...b] }];
    }
    if (type === T.GeomAbs_Circle) {
      const circ = ad.Circle(), loc = circ.Location();
      const c = modelToBoard(pl, [loc.X(), loc.Y(), loc.Z()]), r = mmToNm(circ.Radius());
      loc.delete(); circ.delete();
      const sweep = Math.abs(t1 - t0), n = Math.max(4, Math.ceil(sweep / (Math.PI / 24)));
      if (Math.abs(sweep - 2 * Math.PI) < 1e-9) return [{ curve: ["c", c.x, c.y, r], poly: sample(n) }];
      const a = at(t0), m = at((t0 + t1) / 2), b = at(t1);
      return [{ curve: ["a", a[0], a[1], m[0], m[1], b[0], b[1]], poly: sample(n) }];
    }
    // anything else (an ellipse, a spline) goes to the board as short lines
    const poly = sample(32), out: EdgeCurve[] = [];
    for (let i = 0; i + 3 < poly.length; i += 2) out.push({ curve: ["l", poly[i], poly[i + 1], poly[i + 2], poly[i + 3]], poly: poly.slice(i, i + 4) });
    return out;
  } finally { ad.delete(); }
}

/** Join polylines end to end into closed loops (x, y pairs; the closing point is not repeated). */
export function chainLoops(polys: number[][], tol = 2000): number[][] {
  const left = polys.filter((p) => p.length >= 4).map((p) => p.slice());
  const loops: number[][] = [];
  const near = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) <= tol && Math.abs(ay - by) <= tol;
  while (left.length) {
    const cur = left.shift()!;
    for (let grew = true; grew;) {
      grew = false;
      const ex = cur[cur.length - 2], ey = cur[cur.length - 1];
      if (cur.length >= 6 && near(ex, ey, cur[0], cur[1])) break;
      for (let i = 0; i < left.length; i++) {
        const p = left[i];
        if (near(ex, ey, p[0], p[1])) { cur.push(...p.slice(2)); left.splice(i, 1); grew = true; break; }
        if (near(ex, ey, p[p.length - 2], p[p.length - 1])) { for (let j = p.length - 4; j >= 0; j -= 2) cur.push(p[j], p[j + 1]); left.splice(i, 1); grew = true; break; }
      }
    }
    if (cur.length >= 6 && near(cur[cur.length - 2], cur[cur.length - 1], cur[0], cur[1])) { cur.length -= 2; }
    // drop repeated points
    const out: number[] = [];
    for (let i = 0; i < cur.length; i += 2) { const n = out.length; if (!n || out[n - 2] !== cur[i] || out[n - 1] !== cur[i + 1]) out.push(cur[i], cur[i + 1]); }
    if (out.length >= 6) loops.push(out);
  }
  return loops;
}

function solveDrive(ctx: ServiceContext, drive: Drive, pl: Placement): SolvedDrive {
  const oc = ctx.oc as Any, k = ctx.k, normal = pl.frame.normal;
  const own: { delete(): void }[] = [];
  try {
    if (drive.kind === "holes") {
      const holes: [number, number, number][] = [];
      const fixed = drive.diameter > 0 ? drive.diameter : 0;
      if (drive.source.kind === "sketch") {
        const sk = ctx.state.sketches[drive.source.feature];
        if (!sk) throw lost("The sketch this was taken from is not built (deleted, suppressed or below the rollback bar).");
        for (const id of Object.keys(sk.data.entities).sort()) {
          const e = sk.data.entities[id];
          if (e.type !== "circle" || e.construction) continue;
          const c = pointOf(sk.data, e.center); if (!c) continue;
          const b = modelToBoard(pl, toWorld(sk.frame, c));
          holes.push([b.x, b.y, mmToNm(fixed || e.r * 2)]);
        }
        if (!holes.length) throw lost("The sketch has no circles: draw one where each hole goes.");
      } else {
        if (!drive.source.refs.length) throw lost("No face is picked.");
        for (const ref of drive.source.refs) {
          const face = findFace(ctx, ref).shape;
          const ad = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
          try {
            const type = ad.GetType(), S = oc.GeomAbs_SurfaceType;
            if (type === S.GeomAbs_Cylinder) {
              const cyl = ad.Cylinder(), loc = cyl.Location(), r = cyl.Radius();
              const b = modelToBoard(pl, [loc.X(), loc.Y(), loc.Z()]);
              loc.delete(); cyl.delete();
              holes.push([b.x, b.y, mmToNm(fixed || r * 2)]);
            } else if (type === S.GeomAbs_Plane) {
              if (!fixed) throw lost("Give the holes a diameter.");
              const b = modelToBoard(pl, k.centre(face, "face"));
              holes.push([b.x, b.y, mmToNm(fixed)]);
            } else throw lost("A hole is taken from a flat face (its centre) or a round bore.");
          } finally { ad.delete(); }
        }
      }
      return { kind: "holes", holes, pad: mmToNm(Math.max(0, drive.pad || 0)) };
    }

    const faces = sourceFaces(ctx, drive.source, normal);
    if (drive.kind === "outline") {
      const curves: Curve[] = [];
      for (const face of faces) {
        const all = wiresOf(ctx, face);
        if (!all.length) continue;
        let wires = drive.cutouts ? all : [all[0]];
        if (drive.inset) wires = insetWires(ctx, drive.cutouts ? face : faceOfWire(ctx, all[0], own), drive.inset, own);
        for (const w of wires) for (const e of k.sub(w, "edge")) for (const c of edgeCurve(ctx, e, pl)) {
          if (!c.curve) continue;
          if (c.curve[0] === "l" && c.curve[1] === c.curve[3] && c.curve[2] === c.curve[4]) continue;   // shorter than a nanometre
          curves.push(c.curve);
        }
      }
      if (!curves.length) throw lost("The source has no outline.");
      return { kind: "outline", curves };
    }

    // keep-out: the outer boundary of each face as a polygon
    const loops: number[][] = [];
    let gap = 0, n = 0;
    for (const face of faces) {
      const outer = wiresOf(ctx, face)[0]; if (!outer) continue;
      const polys: number[][] = [];
      for (const e of k.sub(outer, "edge")) for (const c of edgeCurve(ctx, e, pl)) polys.push(c.poly);
      loops.push(...chainLoops(polys));
      gap += modelToBoard(pl, k.centre(face, "face")).w; n++;
    }
    if (!loops.length) throw lost("The source has no closed boundary.");
    gap = n ? Math.round(gap / n * 1e6) / 1e6 : 0;
    const ceiling = drive.mode === "ceiling";
    return { kind: "keepout", loops, mode: drive.mode, side: ceiling ? (gap >= 0 ? "top" : "bottom") : drive.side === "bottom" ? "bottom" : "top", max: Math.max(0, drive.maxHeight || 0), gap: ceiling ? gap : 0, clearance: ceiling ? Math.max(0, drive.clearance || 0) : 0 };
  } finally { for (const o of own.reverse()) { try { o.delete(); } catch (x) { /* already gone */ } } }
}

/** Solve one link against the model. */
export function solveLink(ctx: ServiceContext, link: BoardLinkItem, origins: { [featureId: string]: unknown } = {}): Solved {
  const prev = link.solved;
  const out: Solved = { v: 1, frame: prev.frame, drives: {}, errors: {} };
  const message = (e: unknown) => (e instanceof Lost ? e.message : `The kernel could not work this out (${ctx.k.describe(e)}).`);
  let frame: Frame | null = null;
  let anchor = link.anchor, rotation = link.rotation;
  if (typeof link.feature === "string" && link.feature) {
    // One placement: the board lies where its Board feature put it.  That feature's frame is the board's own
    // (x right and y up on the sheet, the normal from back to front), with the feature's `origin` at its origin,
    // so the sheet position of a model point needs no further turn.
    const built = builtFrames.get(link.feature), o = origins[link.feature];
    const alive = ctx.state.bodies.some((b) => b.createdBy === link.feature);
    if (!built || !alive || !Array.isArray(o) || typeof o[0] !== "number" || typeof o[1] !== "number") out.errors.plane = "The Board feature that places this board is missing, suppressed or has not been built.";
    else { frame = built.frame; anchor = [o[0], o[1]]; rotation = 0; out.anchor = anchor; out.rotation = 0; }
    if (!frame && Array.isArray(prev.anchor)) { out.anchor = prev.anchor; out.rotation = prev.rotation; }
  } else {
    try { frame = liftFrame(planeFrame(ctx, link.plane), link.lift); } catch (e) { out.errors.plane = message(e); }
  }
  if (frame) out.frame = { origin: frame.origin.map(round9) as Vec3, x: frame.x.map(round9) as Vec3, y: frame.y.map(round9) as Vec3, normal: frame.normal.map(round9) as Vec3 };
  for (const [id, drive] of Object.entries(link.drives)) {
    if (!out.frame || out.errors.plane) { if (prev.drives[id]) out.drives[id] = prev.drives[id]; continue; }
    try { out.drives[id] = solveDrive(ctx, drive, { frame: out.frame, anchor, rotation }); }
    catch (e) { out.errors[id] = message(e); if (prev.drives[id]) out.drives[id] = prev.drives[id]; }
  }
  return out;
}
const round9 = (v: number): number => { const r = Math.round(v * 1e9) / 1e9; return r === 0 ? 0 : r; };

/** The service: `{ links: <board-link items> }` → `{ <link id>: Solved }`. */
export function solveLinks(ctx: ServiceContext, args: unknown): { [linkId: string]: Solved } {
  const out: { [linkId: string]: Solved } = {};
  const a = args as { links?: Item[]; origins?: { [featureId: string]: unknown } } | null;
  const items = a?.links, origins = (a && typeof a.origins === "object" && a.origins) || {};
  for (const item of Array.isArray(items) ? items : []) { const link = readLink(item); if (link) out[link.id] = solveLink(ctx, link, origins); }
  return out;
}
