// variables.ts — variables of a part studio, and the expressions that use them.
//
// A variable is an item of the `.jpart` (CONTRACT.md "Unknown items": an older reader keeps it):
//
//   { id, type: "variable", name: "width", expr: "40 mm + 2 * wall", order }
//
// Any number field of a feature can hold an expression instead of a number.  The feature's params keep the
// number (so every reader, and the kernel, sees a plain value) and the text it came from, under the reserved
// key `$expr`:
//
//   params: { depth: 12.5, $expr: { depth: "width / 4 + 2.5" } }
//
// Before the features go to the worker, the page evaluates every `$expr` again with the current variables
// (`resolveInputs`), so a model always follows its variables, even when a stored number is stale.  Editing a
// variable also rewrites the stored numbers that depend on it, in the same change, so the file stays true.
//
// Expressions: numbers with optional units (mm, cm, m, in, ft for lengths, all turned into millimetres; deg and
// rad for angles, turned into degrees), + − × ÷ ^ and brackets, variables by name, the constant pi, and
// sin cos tan (of degrees), asin acos atan atan2 (in degrees), sqrt abs min max floor ceil round.
import { addedChange, byOrder, newId, orderBetween, removedChange, type Item, type ItemChange, type ItemDoc, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { FeatureInput } from "../kernel/protocol";
import { isFeature } from "./format";

export const VARIABLE_TYPE = "variable";
/** The params key that holds the expressions a feature's numbers were typed as. */
export const EXPR_KEY = "$expr";

export interface VariableItem extends Item { type: "variable"; name: string; expr: string; order: string }

export const isVariable = (i: Item | undefined): i is VariableItem => !!i && i.type === VARIABLE_TYPE && typeof i.name === "string";

export function variablesOf(doc: ItemDoc): VariableItem[] {
  const out: VariableItem[] = [];
  for (const i of doc.items.values()) if (isVariable(i)) out.push(i);
  return byOrder(out);
}

// ---------------------------------------------------------------- expressions

export class ExprError extends Error {}

const UNITS: { [u: string]: number } = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, deg: 1, rad: 180 / Math.PI };
const D2R = Math.PI / 180;
const FUNCS: { [f: string]: (...a: number[]) => number } = {
  sin: (x) => Math.sin(x * D2R), cos: (x) => Math.cos(x * D2R), tan: (x) => Math.tan(x * D2R),
  asin: (x) => Math.asin(x) / D2R, acos: (x) => Math.acos(x) / D2R, atan: (x) => Math.atan(x) / D2R, atan2: (y, x) => Math.atan2(y, x) / D2R,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round,
};
const CONSTS: { [c: string]: number } = { pi: Math.PI };

type Token = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokens(text: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/^(),×÷]))/y;
  let i = 0;
  while (i < text.length) {
    if (/^\s*$/.test(text.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) throw new ExprError(`I do not understand “${text.slice(i).trim().slice(0, 12)}”.`);
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: "id", v: m[2] });
    else out.push({ t: "op", v: m[3] === "**" ? "^" : m[3] === "×" ? "*" : m[3] === "÷" ? "/" : m[3] });
  }
  return out;
}

/** The variable names an expression mentions (for dependencies and renames). */
export function namesIn(text: string): string[] {
  try { return Array.from(new Set(tokens(text).filter((t) => t.t === "id" && !FUNCS[t.v] && !CONSTS[t.v] && !(t.v in UNITS)).map((t) => t.v as string))); } catch (e) { return []; }
}

/** A value and whether it carries a unit: 0 a plain number, 1 a length (mm) or an angle (degrees). */
export interface Dimensioned { v: number; dim: 0 | 1 }
/** What a name stands for: a number (taken as carrying its unit already), a value with its dimension, or nothing. */
export type Lookup = (name: string) => number | Dimensioned | undefined;

/**
 * Evaluate an expression, keeping track of whether the result carries a unit.  `factor` is what a bare number
 * is worth where it stands for a quantity (25.4 in a length field of a document in inches): a bare number added
 * to a quantity is scaled by it ("2 + 1 mm" in inches is 51.8 mm), and so is a result that carries no unit at
 * all (`valueIn`).  With a factor of 1 this is plain arithmetic in millimetres and degrees.
 */
export function evaluateDim(text: string, lookup: Lookup = () => undefined, factor = 1): Dimensioned {
  const ts = tokens(String(text));
  if (!ts.length) throw new ExprError("The expression is empty.");
  let i = 0;
  const peek = () => ts[i];
  const isOp = (v: string) => { const t = ts[i]; return !!t && t.t === "op" && t.v === v; };
  const expect = (v: string) => { if (!isOp(v)) throw new ExprError(`Expected “${v}”.`); i++; };
  const top = (a: Dimensioned, b: Dimensioned): 0 | 1 => (a.dim || b.dim ? 1 : 0);
  const expr = (): Dimensioned => {
    let a = term();
    while (isOp("+") || isOp("-")) {
      const op = (ts[i++] as { v: string }).v; const b = term();
      // a bare number beside a quantity is in the unit of the place it was typed
      const av = a.dim || !b.dim ? a.v : a.v * factor, bv = b.dim || !a.dim ? b.v : b.v * factor;
      a = { v: op === "+" ? av + bv : av - bv, dim: top(a, b) };
    }
    return a;
  };
  // A unit follows a whole product, so "3/8 in" is three eighths of an inch; when the product already carries a
  // unit, it belongs to the number it stands behind ("10 mm / 2 mm").
  const unitNext = (): number | null => { const u = ts[i]; return u && u.t === "id" && u.v in UNITS && lookup(u.v) === undefined ? UNITS[u.v] : null; };
  const term = (): Dimensioned => {
    let a = unary();
    let f = unitNext();
    if (f !== null && !a.dim) { i++; a = { v: a.v * f, dim: 1 }; }
    while (isOp("*") || isOp("/")) {
      const op = (ts[i++] as { v: string }).v; let b = unary();
      f = unitNext();
      if (f !== null && a.dim && !b.dim) { i++; b = { v: b.v * f, dim: 1 }; f = null; }
      if (op === "/" && b.v === 0) throw new ExprError("The expression divides by zero.");
      a = op === "*" ? { v: a.v * b.v, dim: top(a, b) } : { v: a.v / b.v, dim: a.dim && !b.dim ? 1 : 0 };
      if (f !== null && !a.dim) { i++; a = { v: a.v * f, dim: 1 }; }
    }
    return a;
  };
  const unary = (): Dimensioned => {
    if (isOp("-")) { i++; const a = unary(); return { v: -a.v, dim: a.dim }; }
    if (isOp("+")) { i++; return unary(); }
    return power();
  };
  const power = (): Dimensioned => {
    const b = postfix();
    if (isOp("^")) { i++; return { v: Math.pow(b.v, unary().v), dim: b.dim }; }
    return b;
  };
  const postfix = (): Dimensioned => {
    const t = peek();
    if (!t) throw new ExprError("The expression ends too soon.");
    if (t.t === "num") {
      i++;
      return { v: t.v, dim: 0 };
    }
    if (t.t === "id") {
      i++;
      if (isOp("(")) {
        const f = FUNCS[t.v];
        if (!f) throw new ExprError(`There is no function called “${t.v}”.`);
        i++;
        const args: Dimensioned[] = [];
        if (!isOp(")")) { args.push(expr()); while (isOp(",")) { i++; args.push(expr()); } }
        expect(")");
        return { v: f(...args.map((a) => a.v)), dim: KEEPS_UNIT.has(t.v) && args.some((a) => a.dim) ? 1 : 0 };
      }
      const known = lookup(t.v);
      if (known !== undefined) return typeof known === "number" ? { v: known, dim: 1 } : known;
      if (t.v in CONSTS) return { v: CONSTS[t.v], dim: 0 };
      throw new ExprError(`There is no variable called “${t.v}”.`);
    }
    if (t.v === "(") { i++; const v = expr(); expect(")"); return v; }
    throw new ExprError(`Unexpected “${t.v}”.`);
  };
  const v = expr();
  if (i < ts.length) throw new ExprError(`Unexpected “${(ts[i] as { v: unknown }).v}”.`);
  if (!Number.isFinite(v.v)) throw new ExprError("The expression has no finite value.");
  return v;
}
const KEEPS_UNIT = new Set(["sqrt", "abs", "min", "max", "floor", "ceil", "round"]);

/** Evaluate an expression.  `lookup` gives a variable's value, or undefined when there is none by that name. */
export function evaluate(text: string, lookup: Lookup = () => undefined): number { return evaluateDim(text, lookup, 1).v; }

/**
 * What an expression typed into a field is worth, in millimetres or degrees: a result that carries no unit is
 * in the field's own unit (`factor` of them to the millimetre or degree).
 */
export function valueIn(text: string, lookup: Lookup, factor: number): number {
  const r = evaluateDim(text, lookup, factor);
  return Math.round((r.dim ? r.v : r.v * factor) * 1e9) / 1e9;
}

/** A plain number typed as text, as opposed to an expression. */
export const isPlainNumber = (text: string): boolean => /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(text);

/** A name a variable may have: a letter or _, then letters, digits and _; not a function, unit or constant. */
export function nameProblem(name: string, taken: readonly string[] = []): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "A name starts with a letter and has only letters, digits and _.";
  if (FUNCS[name] || CONSTS[name] || name in UNITS) return `“${name}” is a function, unit or constant.`;
  if (taken.includes(name)) return `There is already a variable called “${name}”.`;
  return null;
}

/** The params key that says which unit the bare numbers of each expression were typed in ("in", "rad"); absent: mm, degrees. */
export const UNIT_KEY = "$unit";
/** How many millimetres (or degrees) one of a unit is; 1 for a unit this does not know. */
export const unitFactor = (unit: unknown): number => (typeof unit === "string" && unit in UNITS ? UNITS[unit] : 1);

export interface VariableValues {
  values: Map<string, number>;
  /** which variables carry a unit (a length or an angle); the others are plain numbers */
  dims: Map<string, 0 | 1>;
  /** variable id → why it has no value */
  errors: Map<string, string>;
}

/** Every variable's value.  A variable may use any other; a cycle is an error on each variable in it. */
export function variableValues(vars: readonly VariableItem[]): VariableValues {
  const byName = new Map<string, VariableItem>();
  const errors = new Map<string, string>();
  for (const v of vars) { if (byName.has(v.name)) errors.set(v.id, `There is already a variable called “${v.name}”.`); else byName.set(v.name, v); }
  const values = new Map<string, number>();
  const dims = new Map<string, 0 | 1>();
  const visiting = new Set<string>();
  const value = (name: string): Dimensioned | undefined => {
    if (values.has(name)) return { v: values.get(name)!, dim: dims.get(name) || 0 };
    const v = byName.get(name);
    if (!v) return undefined;
    if (errors.has(v.id)) throw new ExprError(`“${name}” has no value.`);
    if (visiting.has(name)) throw new ExprError(`“${name}” is defined in terms of itself.`);
    visiting.add(name);
    try { const x = evaluateDim(v.expr, value, 1); values.set(name, x.v); dims.set(name, x.dim); return x; }
    catch (e) { errors.set(v.id, e instanceof Error ? e.message : String(e)); throw new ExprError(`“${name}” has no value.`); }
    finally { visiting.delete(name); }
  };
  for (const v of byName.values()) { try { value(v.name); } catch (e) { /* recorded */ } }
  return { values, dims, errors };
}

/** How a field's expression looks a variable up: its value with its dimension. */
export function lookupOf(vv: { values: ReadonlyMap<string, number>; dims?: ReadonlyMap<string, 0 | 1> }): Lookup {
  return (name) => { const v = vv.values.get(name); return v === undefined ? undefined : { v, dim: vv.dims ? vv.dims.get(name) || 0 : 1 }; };
}

/** The units the expressions of a feature's params were typed in (key → unit). */
export function exprUnitsOf(params: JsonObject | undefined): { [key: string]: string } {
  const e = params && params[UNIT_KEY];
  return e && typeof e === "object" && !Array.isArray(e) ? (e as { [key: string]: string }) : {};
}

/** The expressions stored with a feature's params (key → text). */
export function exprsOf(params: JsonObject | undefined): { [key: string]: string } {
  const e = params && params[EXPR_KEY];
  return e && typeof e === "object" && !Array.isArray(e) ? (e as { [key: string]: string }) : {};
}

/** The features with every expression evaluated again; a feature whose expression fails keeps its stored number. */
export function resolveInputs(inputs: FeatureInput[], values: ReadonlyMap<string, number>, dims?: ReadonlyMap<string, 0 | 1>): FeatureInput[] {
  const lookup = lookupOf({ values, dims });
  return inputs.map((f) => {
    const ex = exprsOf(f.params);
    const keys = Object.keys(ex);
    if (!keys.length) return f;
    const params: JsonObject = { ...f.params };
    const units = exprUnitsOf(f.params);
    for (const key of keys) { try { params[key] = units[key] ? valueIn(ex[key], lookup, unitFactor(units[key])) : evaluate(ex[key], lookup); } catch (e) { /* keep the stored number */ } }
    return { ...f, params };
  });
}

// ---------------------------------------------------------------- edits (changes only; commit them with studio.commit)

/** Changes that add a variable at the end of the list. */
export function addVariable(doc: ItemDoc, name: string, expr: string): { changes: ItemChange[]; variable: VariableItem } {
  const vars = variablesOf(doc);
  const variable: VariableItem = { id: newId(), type: "variable", name, expr, order: orderBetween(vars.length ? vars[vars.length - 1].order : null, null) };
  return { changes: [addedChange(variable)], variable };
}

/** A name not taken yet: "v1", "v2", … */
export function freeName(doc: ItemDoc, stem = "v"): string {
  const taken = new Set(variablesOf(doc).map((v) => v.name));
  for (let n = 1; ; n++) if (!taken.has(`${stem}${n}`)) return `${stem}${n}`;
}

const renameIn = (text: string, from: string, to: string) => text.replace(new RegExp(`(^|[^A-Za-z0-9_])${from}(?![A-Za-z0-9_])`, "g"), (_m, pre) => `${pre}${to}`);

/**
 * Change a variable's name and/or expression.  A rename is carried into every expression that used the old name;
 * either way, the stored numbers of features that depend on the variable are brought up to date.
 */
export function setVariable(doc: ItemDoc, id: string, patch: { name?: string; expr?: string }): ItemChange[] {
  const v = doc.items.get(id);
  if (!isVariable(v)) return [];
  const out: ItemChange[] = [];
  const props: { path: string[]; value: string }[] = [];
  const name = patch.name !== undefined ? patch.name.trim() : v.name;
  const expr = patch.expr !== undefined ? patch.expr : v.expr;
  if (name !== v.name) props.push({ path: ["name"], value: name });
  if (expr !== v.expr) props.push({ path: ["expr"], value: expr });
  if (!props.length) return [];
  out.push({ id, kind: "MODIFIED", typeName: VARIABLE_TYPE, props });
  const renamed = name !== v.name;
  // the variables as they will be, with the rename carried into the others' expressions
  const vars = variablesOf(doc).map((x) => {
    if (x.id === id) return { ...x, name, expr };
    if (renamed && namesIn(x.expr).includes(v.name)) {
      const next = renameIn(x.expr, v.name, name);
      out.push({ id: x.id, kind: "MODIFIED", typeName: VARIABLE_TYPE, props: [{ path: ["expr"], value: next }] });
      return { ...x, expr: next };
    }
    return x;
  });
  const vv = variableValues(vars), lookup = lookupOf(vv);
  for (const item of doc.items.values()) {
    if (!isFeature(item)) continue;
    const ex = exprsOf(item.params), units = exprUnitsOf(item.params);
    const fprops: { path: string[]; value: JsonObject[string] }[] = [];
    for (const key of Object.keys(ex)) {
      let text = ex[key];
      if (renamed && namesIn(text).includes(v.name)) { text = renameIn(text, v.name, name); fprops.push({ path: ["params", EXPR_KEY, key], value: text }); }
      try { const n = units[key] ? valueIn(text, lookup, unitFactor(units[key])) : evaluate(text, lookup); if (n !== item.params[key]) fprops.push({ path: ["params", key], value: n }); } catch (e) { /* leave the stored number */ }
    }
    if (fprops.length) out.push({ id: item.id, kind: "MODIFIED", typeName: "feature", props: fprops });
  }
  return out;
}

export function deleteVariable(doc: ItemDoc, id: string): ItemChange[] {
  const v = doc.items.get(id);
  return isVariable(v) ? [removedChange(v)] : [];
}

/** Which features use a variable (by name), for the panel. */
export function usersOf(doc: ItemDoc, name: string): string[] {
  const out: string[] = [];
  for (const item of doc.items.values()) {
    if (isFeature(item) && Object.values(exprsOf(item.params)).some((t) => namesIn(t).includes(name))) out.push(item.id);
  }
  return out;
}
