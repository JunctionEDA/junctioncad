// profiles.ts — the closed regions of a sketch: what Extrude and the other profile features consume.
//
// Pure geometry on the sketch format (no kernel), so it is the same answer in the worker, in the viewport's
// region highlighting and in tests.
//
// What counts as a region today, and its limits (CONTRACT.md repeats them):
//   • a closed loop is a chain of non-construction lines and arcs in which every point joins exactly two curves
//     (by shared point id, or by two points at the same place), or a circle;
//   • a loop inside another is a hole of it; a loop inside a hole is a region again (even-odd nesting);
//   • curves that cross without sharing a point, or three curves meeting at a point, are NOT split into the
//     faces they enclose: the chain is reported in `open` and makes no region.  A sketcher that needs that
//     replaces this function with a planar arrangement; region ids are opaque so consumers do not change.
// A region's id is the smallest entity id on its outer loop, which survives edits that keep the loop's curves.
import type { Vec2 } from "../core/geometry";
import { curvePoints, pointOf, type SketchCurve, type SketchData } from "./format";

/** One curve of a loop, and whether the loop runs against the curve's own direction (b→a, end→start). */
export interface LoopEdge { entity: string; reversed: boolean }
/** A closed chain, counter-clockwise in sketch coordinates. */
export interface Loop { edges: LoopEdge[]; polygon: Vec2[]; area: number }
export interface Region { id: string; outer: Loop; holes: Loop[] }
export interface Regions { regions: Region[]; /** curves that are on no closed loop */ open: string[] }

const EPS = 1e-6;

function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function makeLoop(sketch: SketchData, edges: LoopEdge[]): Loop | null {
  let poly: Vec2[] = [];
  for (const e of edges) {
    const pts = curvePoints(sketch, sketch.entities[e.entity]);
    if (pts.length < 2) return null;
    if (e.reversed) pts.reverse();
    poly.push(...pts.slice(0, -1));   // the last point is the next curve's first
  }
  if (poly.length < 3) return null;
  let area = signedArea(poly);
  if (Math.abs(area) < EPS) return null;
  if (area < 0) { edges = edges.slice().reverse().map((e) => ({ entity: e.entity, reversed: !e.reversed })); poly = poly.reverse(); area = -area; }
  return { edges, polygon: poly, area };
}

export function findRegions(sketch: SketchData): Regions {
  const loops: Loop[] = [];
  const open: string[] = [];
  const ids = Object.keys(sketch.entities || {}).sort();

  // points at the same place are one node, whatever their ids
  const nodeOf = new Map<string, string>();
  const byPlace = new Map<string, string>();
  for (const id of ids) {
    const p = pointOf(sketch, id); if (!p) continue;
    const key = `${Math.round(p[0] / EPS)},${Math.round(p[1] / EPS)}`;
    if (!byPlace.has(key)) byPlace.set(key, id);
    nodeOf.set(id, byPlace.get(key)!);
  }

  interface Link { entity: string; from: string; to: string }
  const links = new Map<string, Link[]>();
  const chained: Link[] = [];
  for (const id of ids) {
    const e = sketch.entities[id] as SketchCurve;
    if (!e || e.construction) continue;
    if (e.type === "circle") {
      const loop = makeLoop(sketch, [{ entity: id, reversed: false }]);
      if (loop) loops.push(loop); else open.push(id);
      continue;
    }
    if (e.type !== "line" && e.type !== "arc") continue;
    const from = nodeOf.get(e.type === "line" ? e.a : e.start), to = nodeOf.get(e.type === "line" ? e.b : e.end);
    if (!from || !to || from === to) { open.push(id); continue; }
    const link: Link = { entity: id, from, to };
    chained.push(link);
    for (const n of [from, to]) { if (!links.has(n)) links.set(n, []); links.get(n)!.push(link); }
  }

  const used = new Set<string>();
  for (const first of chained) {
    if (used.has(first.entity)) continue;
    // the whole connected piece this curve belongs to
    const piece: Link[] = [], nodes = new Set<string>(), queue = [first.from];
    while (queue.length) {
      const n = queue.pop()!; if (nodes.has(n)) continue; nodes.add(n);
      for (const l of links.get(n) || []) { if (!used.has(l.entity)) { used.add(l.entity); piece.push(l); } queue.push(l.from, l.to); }
    }
    const simple = Array.from(nodes).every((n) => (links.get(n) || []).length === 2);
    if (!simple) { open.push(...piece.map((l) => l.entity)); continue; }
    // walk it once round
    const edges: LoopEdge[] = [];
    let at = first.from, link: Link | undefined = first;
    const seen = new Set<string>();
    while (link && !seen.has(link.entity)) {
      seen.add(link.entity);
      const reversed: boolean = link.from !== at;
      edges.push({ entity: link.entity, reversed });
      at = reversed ? link.from : link.to;
      const here: Link = link;
      link = (links.get(at) || []).find((l) => l !== here);
    }
    const loop = edges.length === piece.length ? makeLoop(sketch, edges) : null;
    if (loop) loops.push(loop); else open.push(...piece.map((l) => l.entity));
  }

  // nesting: a loop's depth is the number of loops it lies inside
  const inside = (a: Loop, b: Loop) => a !== b && a.area < b.area && pointInPolygon(a.polygon[0], b.polygon);
  const parents = loops.map((l) => loops.filter((o) => inside(l, o)));
  const regions: Region[] = [];
  loops.forEach((outer, i) => {
    if (parents[i].length % 2) return;   // a hole
    const holes = loops.filter((h, j) => parents[j].length === parents[i].length + 1 && parents[j].includes(outer));
    regions.push({ id: outer.edges.map((e) => e.entity).sort()[0], outer, holes });
  });
  regions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { regions, open: open.sort() };
}
