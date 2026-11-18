// mech/check.ts — the enclosure check: components that stand in a keep-out the model put on the board and are
// taller than it allows.  Pure geometry in board millimetres (Y down); static/tests/pcb-mech.test.js.
//
// A component's height is its footprint's "Height" field (millimetres) when it has one, else the height of
// the stand-in body the 3D viewer draws for it (viewer3d/bodies.ts), which is an estimate from the kind and
// size of the part.  The clash says which it was.
import { keepoutLimit, nmToMm, type SolvedKeepout } from "../../mechanical/api";
import type { LinkSource } from "./boarditems";

export type Pt = [number, number];

export interface PartBody {
  /** the footprint's item id */
  id: string;
  ref: string;
  back: boolean;
  /** the body's outline on the board, millimetres */
  pts: Pt[];
  height: number;
  /** where the height came from */
  source: "field" | "estimate";
}

export interface KeepoutArea {
  link: string; drive: string; studioDoc: string; studio: string;
  name: string;
  side: "top" | "bottom";
  /** the tallest component allowed, mm; 0: none may stand here */
  limit: number;
  loop: Pt[];
  /** the id of the rule area on the board */
  zone: string;
}

export interface Clash {
  part: string; ref: string;
  area: KeepoutArea;
  height: number; limit: number;
  /** how far the part stands over the limit, mm */
  over: number;
  source: PartBody["source"];
  /** where to point: the middle of the part */
  x: number; y: number;
  /** the part's outline and side, for drawing it elsewhere */
  pts: Pt[]; back: boolean;
}

/** The keep-outs the links put on a board of this thickness. */
export function keepoutAreas(sources: readonly LinkSource[], thickness: number, zoneId: (link: string, drive: string, n: number) => string): KeepoutArea[] {
  const out: KeepoutArea[] = [];
  for (const { link, studio, studioDoc } of sources) {
    for (const [id, drive] of Object.entries(link.drives)) {
      const solved = link.solved.drives[id];
      if (drive.kind !== "keepout" || !solved || solved.kind !== "keepout") continue;
      const k = solved as SolvedKeepout;
      k.loops.forEach((loop, n) => {
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < loop.length; i += 2) pts.push([nmToMm(loop[i]), nmToMm(loop[i + 1])]);
        out.push({ link: link.id, drive: id, studioDoc, studio, name: drive.name, side: k.side, limit: k.mode === "none" ? 0 : keepoutLimit(k, thickness), loop: pts, zone: zoneId(link.id, id, n) });
      });
    }
  }
  return out;
}

export function pointInPoly(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Do two simple polygons share any area? */
export function polysOverlap(a: readonly Pt[], b: readonly Pt[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) if (segmentsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  return pointInPoly(a[0], b) || pointInPoly(b[0], a);
}

const centre = (pts: readonly Pt[]): Pt => { let x = 0, y = 0; for (const p of pts) { x += p[0]; y += p[1]; } return [x / (pts.length || 1), y / (pts.length || 1)]; };

/** The keep-outs a part stands in (on its side of the board), with the room each leaves over it (negative: too tall). */
export function headroom(part: PartBody, areas: readonly KeepoutArea[]): { area: KeepoutArea; room: number }[] {
  const out: { area: KeepoutArea; room: number }[] = [];
  for (const area of areas) {
    if ((area.side === "bottom") !== part.back) continue;
    if (!polysOverlap(part.pts, area.loop)) continue;
    out.push({ area, room: area.limit - part.height });
  }
  return out;
}

/** Every part that is taller than a keep-out it stands in allows, worst first. */
export function heightClashes(parts: readonly PartBody[], areas: readonly KeepoutArea[]): Clash[] {
  const out: Clash[] = [];
  for (const part of parts) {
    for (const { area, room } of headroom(part, areas)) {
      if (room >= -1e-9) continue;
      const c = centre(part.pts);
      out.push({ part: part.id, ref: part.ref, area, height: part.height, limit: area.limit, over: -room, source: part.source, x: c[0], y: c[1], pts: part.pts, back: part.back });
    }
  }
  return out.sort((a, b) => b.over - a.over || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/** "Height" as people write it in a field: "5", "5.2mm", "5,2 mm"; null when it is not a length. */
export function parseHeight(text: string | null | undefined): number | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(mm)?\s*$/i.exec(String(text || ""));
  if (!m) return null;
  const v = Number(m[1].replace(",", "."));
  return isFinite(v) && v > 0 ? v : null;
}

export function clashText(c: Clash): string {
  const h = `${c.ref} is ${round2(c.height)} mm tall${c.source === "estimate" ? " (estimated)" : ""}`;
  return c.limit <= 0 ? `${h}: no components may stand in “${c.area.name}”` : `${h}: “${c.area.name}” allows ${round2(c.limit)} mm (${round2(c.over)} mm over)`;
}
const round2 = (v: number): number => Math.round(v * 100) / 100;
