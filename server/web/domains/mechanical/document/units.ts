// units.ts — the units a part studio is worked in: how lengths and angles are shown and what a bare number
// typed into a field means.
//
// The model itself is always millimetres and degrees (CONTRACT.md).  The studio item says how a person reads and
// writes it:
//
//   { id: "studio", type: "studio", units: "in", angleUnits: "deg", precision: 3, … }
//
// `units` is the length unit (mm, cm, m, in, ft), `angleUnits` deg or rad, `precision` the number of decimal
// places readouts show.  They belong to the document, so everybody working on it sees the same numbers.
//
// Pure (no DOM): the dialogs, the sketcher, the measure readout, mass properties and the tests all format and
// parse through here.  static/tests/cad-units.test.js.
import type { ItemChange, ItemDoc } from "../../../shared/itemdoc/itemdoc";
import { tryEvaluate as trySketch } from "../sketch/expr";
import { STUDIO_ITEM_ID } from "./format";
import { isPlainNumber, valueIn, type Lookup } from "./variables";

export type LengthUnit = "mm" | "cm" | "m" | "in" | "ft";
export type AngleUnit = "deg" | "rad";
export interface Units { length: LengthUnit; angle: AngleUnit; /** decimal places shown in readouts */ places: number }

export const LENGTH_UNITS: readonly { id: LengthUnit; title: string; mm: number }[] = [
  { id: "mm", title: "Millimetre", mm: 1 }, { id: "cm", title: "Centimetre", mm: 10 }, { id: "m", title: "Metre", mm: 1000 },
  { id: "in", title: "Inch", mm: 25.4 }, { id: "ft", title: "Foot", mm: 304.8 },
];
export const ANGLE_UNITS: readonly { id: AngleUnit; title: string; deg: number }[] = [
  { id: "deg", title: "Degree", deg: 1 }, { id: "rad", title: "Radian", deg: 180 / Math.PI },
];
export const DEFAULT_UNITS: Units = { length: "mm", angle: "deg", places: 3 };
export const MAX_PLACES = 6;

/** Millimetres in one of a length unit. */
export const lengthFactor = (u: LengthUnit): number => LENGTH_UNITS.find((x) => x.id === u)?.mm ?? 1;
/** Degrees in one of an angle unit. */
export const angleFactor = (u: AngleUnit): number => ANGLE_UNITS.find((x) => x.id === u)?.deg ?? 1;
/** How an angle unit is written after a number. */
export const angleSuffix = (u: AngleUnit): string => (u === "deg" ? "°" : " rad");

/** The units of a part studio document; the defaults for anything it does not say (or says wrongly). */
export function unitsOf(doc: ItemDoc | null | undefined): Units {
  const s = doc ? (doc.items.get(STUDIO_ITEM_ID) as { units?: unknown; angleUnits?: unknown; precision?: unknown } | undefined) : undefined;
  if (!s) return DEFAULT_UNITS;
  const length = LENGTH_UNITS.some((x) => x.id === s.units) ? (s.units as LengthUnit) : DEFAULT_UNITS.length;
  const angle = ANGLE_UNITS.some((x) => x.id === s.angleUnits) ? (s.angleUnits as AngleUnit) : DEFAULT_UNITS.angle;
  const p = typeof s.precision === "number" && Number.isFinite(s.precision) ? Math.max(0, Math.min(MAX_PLACES, Math.round(s.precision))) : DEFAULT_UNITS.places;
  return { length, angle, places: p };
}

/** Changes that set the document's units (commit them with studio.commit).  Nothing in the model moves. */
export function setUnits(doc: ItemDoc, patch: Partial<Units>): ItemChange[] {
  const now = unitsOf(doc);
  const props: { path: string[]; value: string | number }[] = [];
  if (patch.length && patch.length !== now.length) props.push({ path: ["units"], value: patch.length });
  if (patch.angle && patch.angle !== now.angle) props.push({ path: ["angleUnits"], value: patch.angle });
  if (patch.places !== undefined && patch.places !== now.places) props.push({ path: ["precision"], value: Math.max(0, Math.min(MAX_PLACES, Math.round(patch.places))) });
  if (!props.length) return [];
  if (!doc.items.get(STUDIO_ITEM_ID)) {
    const next = { ...now, ...patch };
    return [{ id: STUDIO_ITEM_ID, kind: "ADDED", typeName: "studio", item: { id: STUDIO_ITEM_ID, type: "studio", units: next.length, angleUnits: next.angle, precision: next.places, rollback: null } }];
  }
  return [{ id: STUDIO_ITEM_ID, kind: "MODIFIED", typeName: "studio", props }];
}

const trim = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
/** A number with up to `places` decimals, no trailing zeros, no "-0". */
export function num(v: number, places = 3): string {
  if (!Number.isFinite(v)) return "—";
  const r = Math.abs(v) < 0.5 * Math.pow(10, -places) ? 0 : v;
  return trim(r.toFixed(places));
}

/** A length of the model (mm) as the document shows it: "12.5 mm", "0.492 in". */
export function formatLength(mm: number, u: Units = DEFAULT_UNITS, o: { unit?: boolean; places?: number } = {}): string {
  const text = num(mm / lengthFactor(u.length), o.places ?? u.places);
  return o.unit === false || text === "—" ? text : `${text} ${u.length}`;
}
/** An angle of the model (degrees) as the document shows it: "45°", "0.785 rad". */
export function formatAngle(deg: number, u: Units = DEFAULT_UNITS, o: { unit?: boolean; places?: number } = {}): string {
  const text = num(deg / angleFactor(u.angle), o.places ?? (u.angle === "deg" ? Math.min(u.places, 2) : Math.max(u.places, 3)));
  return o.unit === false || text === "—" ? text : `${text}${angleSuffix(u.angle)}`;
}
export function formatArea(mm2: number, u: Units = DEFAULT_UNITS): string { const f = lengthFactor(u.length); return `${num(mm2 / (f * f), u.places)} ${u.length}²`; }
export function formatVolume(mm3: number, u: Units = DEFAULT_UNITS): string { const f = lengthFactor(u.length); return `${num(mm3 / (f * f * f), u.places)} ${u.length}³`; }

/** A stored number in the document's units, as a field shows it for editing: every digit that matters, no unit. */
export function fieldText(value: number, quantity: Quantity, u: Units = DEFAULT_UNITS): string {
  if (!Number.isFinite(value)) return "";
  const v = quantity === "length" ? value / lengthFactor(u.length) : quantity === "angle" ? value / angleFactor(u.angle) : value;
  return num(v, quantity === "none" ? 9 : 6);
}
/** The unit a field shows after its number ("" for a plain number). */
export function fieldUnit(quantity: Quantity, u: Units = DEFAULT_UNITS): string { return quantity === "length" ? u.length : quantity === "angle" ? (u.angle === "deg" ? "°" : "rad") : ""; }
/** How many of the model's units (mm, degrees) one of the field's unit is. */
export function fieldFactor(quantity: Quantity, u: Units = DEFAULT_UNITS): number { return quantity === "length" ? lengthFactor(u.length) : quantity === "angle" ? angleFactor(u.angle) : 1; }

/** What a number field holds: a length, an angle or a plain number (a count, a ratio). */
export type Quantity = "length" | "angle" | "none";
export const quantityOf = (unit: "mm" | "deg" | "none" | undefined): Quantity => (unit === "mm" ? "length" : unit === "deg" ? "angle" : "none");

export interface Typed {
  /** in millimetres or degrees (or as typed, for a plain number) */
  value: number;
  /** the text is more than a plain number in the document's unit: keep it with the value */
  isExpression: boolean;
}

/**
 * What was typed into a number field.  A bare number is in the document's unit; a unit typed with it wins
 * ("1 in", "25.4mm", "3/8 in + 2 mm"); variables are looked up.  Null when it does not come to a number.
 */
export function parseField(text: string, quantity: Quantity, u: Units = DEFAULT_UNITS, lookup: Lookup = () => undefined): Typed | null {
  const t = text.trim().replace(/,/g, ".");
  if (!t) return null;
  const factor = fieldFactor(quantity, u);
  if (isPlainNumber(t)) return { value: Math.round(Number(t) * factor * 1e9) / 1e9, isExpression: false };
  // 1' 6", 45° and the like: the sketcher's reader knows the marks the variables' reader does not
  if (/["'°]/.test(t) && quantity !== "none") { const r = trySketch(t, quantity, factor); return r ? { value: r.value, isExpression: true } : null; }
  try { return { value: valueIn(t, lookup, factor), isExpression: true }; } catch { return null; }
}
