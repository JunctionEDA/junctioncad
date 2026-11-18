// measure-format.ts — what the measure readout says: the rows a measurement turns into, with their numbers
// formatted for reading and for copying.  Pure (no DOM, no kernel); tested in static/tests/cad-analysis.test.js.
//
// Lengths are millimetres throughout the model; the readout shows them in the units of the document being
// looked at (document/units.ts; `setMeasureUnits`, millimetres with three decimals until told otherwise),
// trailing zeros dropped ("12.5 mm"), and copies the number alone, in those units, at full working precision
// ("12.5"), so a pasted value is the value.
import type { Vec3 } from "../core/geometry";
import { DEFAULT_UNITS, angleFactor, formatAngle, formatArea, formatLength, formatVolume, lengthFactor, type Units } from "../document/units";
import type { EntityInfo, PairInfo } from "../services/_measure-kernel";
import type { MeasureResult } from "../services/measure-entities";

export interface Row {
  /** stable id: what a test or a pinned dimension refers to */
  key: string;
  label: string;
  /** as shown, with its unit */
  text: string;
  /** what a click copies: the number, without its unit */
  copy: string;
  /** a sub-row (dX, dY, dZ under a distance) */
  minor?: boolean;
}

const trim = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
/** A number with up to `places` decimals, no trailing zeros, no "-0". */
export function num(v: number, places = 3): string {
  if (!Number.isFinite(v)) return "—";
  const r = Math.abs(v) < 0.5 * Math.pow(10, -places) ? 0 : v;
  return trim(r.toFixed(places));
}
/** The number as copied: enough digits to round-trip a measurement (1e-9 mm), none beyond. */
export function copyNum(v: number): string { return Number.isFinite(v) ? trim((Math.abs(v) < 5e-10 ? 0 : v).toFixed(9)) : ""; }

// The units readouts are written in: those of the part studio on screen.  The part studio sets them when its
// document's units change; the functions below stay plain functions of a number.
let U: Units = DEFAULT_UNITS;
export function setMeasureUnits(u: Units): void { U = u; }
export const measureUnits = (): Units => U;

/** A length, an area, a volume (given in mm, mm², mm³) and an angle (degrees) in the units on screen. */
export const mm = (v: number) => formatLength(v, U);
export const mm2 = (v: number) => formatArea(v, U);
export const mm3 = (v: number) => formatVolume(v, U);
export const deg = (v: number) => formatAngle(v, U);
/** The number a row copies: the value in the units its text is in. */
function shownValue(text: string, value: number): number {
  const f = lengthFactor(U.length);
  if (text.endsWith(`${U.length}³`)) return value / (f * f * f);
  if (text.endsWith(`${U.length}²`)) return value / (f * f);
  if (text.endsWith(` ${U.length}`)) return value / f;
  if (text.endsWith("°") || text.endsWith(" rad")) return value / angleFactor(U.angle);
  return value;
}
/** Kilograms, shown in grams below one kilogram. */
export const kg = (v: number) => (Math.abs(v) < 1 ? `${num(v * 1000)} g` : `${num(v, 4)} kg`);
export const inertia = (v: number) => `${num(v, 3)} kg·mm²`;

const row = (key: string, label: string, text: string, value: number, minor = false): Row => ({ key, label, text, copy: copyNum(shownValue(text, value)), ...(minor ? { minor } : {}) });
const point = (key: string, label: string, p: Vec3): Row[] => [
  row(`${key}.x`, `${label} X`, mm(p[0]), p[0]), row(`${key}.y`, `${label} Y`, mm(p[1]), p[1]), row(`${key}.z`, `${label} Z`, mm(p[2]), p[2]),
];
const deltas = (key: string, a: Vec3, b: Vec3): Row[] => (["X", "Y", "Z"] as const).map((axis, i) => row(`${key}.d${axis.toLowerCase()}`, `Δ${axis}`, mm(Math.abs(b[i] - a[i])), Math.abs(b[i] - a[i]), true));

/** The rows for one thing on its own. */
export function entityRows(e: EntityInfo, key = "item"): Row[] {
  const out: Row[] = [];
  if (e.kind === "vertex" && e.point) return point(key, "Point", e.point);
  if (e.kind === "plane") return out;
  if (e.kind === "edge") {
    if (e.curve === "circle" && e.radius !== undefined) {
      if (e.closed) out.push(row(`${key}.circumference`, "Circumference", mm(e.length || 0), e.length || 0));
      else out.push(row(`${key}.length`, "Arc length", mm(e.length || 0), e.length || 0));
      out.push(row(`${key}.radius`, "Radius", mm(e.radius), e.radius), row(`${key}.diameter`, "Diameter", mm(2 * e.radius), 2 * e.radius));
      if (e.center) out.push(...point(`${key}.center`, "Centre", e.center));
    } else out.push(row(`${key}.length`, "Length", mm(e.length || 0), e.length || 0));
    return out;
  }
  out.push(row(`${key}.area`, "Area", mm2(e.area || 0), e.area || 0));
  if (e.surface === "cylinder" && e.radius !== undefined) out.push(row(`${key}.radius`, "Radius", mm(e.radius), e.radius), row(`${key}.diameter`, "Diameter", mm(2 * e.radius), 2 * e.radius));
  if (e.surface === "sphere" && e.radius !== undefined) out.push(row(`${key}.radius`, "Radius", mm(e.radius), e.radius), row(`${key}.diameter`, "Diameter", mm(2 * e.radius), 2 * e.radius));
  out.push(row(`${key}.perimeter`, "Perimeter", mm(e.perimeter || 0), e.perimeter || 0));
  return out;
}

/** The rows for two things together. */
export function pairRows(p: PairInfo): Row[] {
  const out: Row[] = [];
  if (p.min) { out.push(row("min", "Distance", mm(p.min.distance), p.min.distance)); if (p.min.distance > 1e-9) out.push(...deltas("min", p.min.a, p.min.b)); }
  if (p.normalDistance !== undefined && (!p.min || Math.abs(p.normalDistance - p.min.distance) > 1e-6)) out.push(row("normal", "Normal distance", mm(p.normalDistance), p.normalDistance));
  if (p.centre && (!p.min || Math.abs(p.centre.distance - p.min.distance) > 1e-6)) { out.push(row("centre", "Centre to centre", mm(p.centre.distance), p.centre.distance)); if (p.centre.distance > 1e-9) out.push(...deltas("centre", p.centre.a, p.centre.b)); }
  if (p.angle !== undefined) out.push(row("angle", "Angle", deg(p.angle), p.angle));
  return out;
}

/** What the readout shows for a measurement: a heading and its rows. */
export function readout(r: MeasureResult | null): { title: string; rows: Row[] } {
  if (!r || !r.items.length) return { title: "", rows: [] };
  const name = (e: EntityInfo) => (e.kind === "plane" ? "plane" : e.kind === "edge" ? (e.curve === "circle" ? (e.closed ? "circle" : "arc") : e.curve === "line" ? "line" : "edge") : e.kind === "face" ? (e.surface && e.surface !== "other" ? `${e.surface} face` : "face") : "vertex");
  if (r.items.length === 1) return { title: cap(name(r.items[0])), rows: entityRows(r.items[0]) };
  if (r.items.length === 2 && r.pair) {
    const rows = pairRows(r.pair);
    // two faces or two edges also say how much there is of them together
    if (r.totals.area !== undefined) rows.push(row("total.area", "Total area", mm2(r.totals.area), r.totals.area));
    if (r.totals.length !== undefined) rows.push(row("total.length", "Total length", mm(r.totals.length), r.totals.length));
    return { title: `${cap(name(r.items[0]))} and ${name(r.items[1])}`, rows };
  }
  const rows: Row[] = [];
  if (r.totals.area !== undefined) rows.push(row("total.area", "Total area", mm2(r.totals.area), r.totals.area));
  if (r.totals.length !== undefined) rows.push(row("total.length", "Total length", mm(r.totals.length), r.totals.length));
  return { title: `${r.items.length} selected`, rows };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
