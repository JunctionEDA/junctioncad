// dialogs/diff-symbol-logic.ts — the comparison behind Inspect > Compare Symbol with Library
// (SCH_INSPECTION_TOOL::DiffSymbol → LIB_SYMBOL::Compare with SCHEMATIC_SETTINGS::SymbolCompareFlags).  The schematic
// side is the sheet's embedded library symbol with the placed symbol's own fields laid over it (moved by minus the
// symbol's position, as DiffSymbol does); the library side is the library's symbol, flattened.  Each difference is
// one report line, worded as LIB_SYMBOL::Compare reports it.  Pure functions over s-expression nodes, so the node
// tests load this file directly.

import { parityOf } from "./schematic-setup-logic";

const K = (): KiCadCanvasApi => (globalThis as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas;
const isList = Array.isArray;
const kid = (n: SNode, k: string): SNode | null => K().kid(n, k) as SNode | null;
const kids = (n: SNode, k: string): SNode[] => K().kids(n, k) as SNode[];
const str = (v: unknown): string => K().str(v as SNode);
const num = (v: unknown): number => { const x = Number(str(v)); return isFinite(x) ? x : 0; };
/** schematic internal units are 100 nm: values closer than that are the same */
const iu = (mm: number): number => Math.round(mm * 1e4);
const META = /^ki_/;

/** SYMBOL_PARITY_SETTINGS keys (schematic-setup-logic.ts PARITY), true = compared; a missing key takes its default. */
export type Parity = Record<string, boolean>;

/** ElectricalPinTypeGetText / PinShapeGetText. */
const PIN_TYPE: Record<string, string> = { input: "Input", output: "Output", bidirectional: "Bidirectional", tri_state: "Tri-state", passive: "Passive", free: "Free", unspecified: "Unspecified", power_in: "Power input", power_out: "Power output", open_collector: "Open collector", open_emitter: "Open emitter", no_connect: "Unconnected" };
const PIN_SHAPE: Record<string, string> = { line: "Line", inverted: "Inverted", clock: "Clock", inverted_clock: "Inverted clock", input_low: "Input low", clock_low: "Clock low", output_low: "Output low", edge_clock_high: "Falling edge clock", non_logic: "NonLogic" };

/** MessageTextFromValue in millimetres for schematic units (the "%.3f" short form). */
export const mmText = (mm: number): string => `${mm.toFixed(3)} mm`;
const flag = (n: SNode, key: string, dflt: boolean): boolean => { const k = kid(n, key); if (!k) return dflt; return k.length < 2 || str(k[1]) !== "no"; };
const unescape = (s: string): string => s.replace(/\{slash\}/g, "/").replace(/\{backslash\}/g, "\\").replace(/\{lt\}/g, "<").replace(/\{gt\}/g, ">").replace(/\{colon\}/g, ":").replace(/\{dblquote\}/g, "\"").replace(/\{brace\}/g, "{");

interface Sub { unit: number; body: number; node: SNode }
function subs(sym: SNode): Sub[] {
  return kids(sym, "symbol").map((s) => { const m = /_(\d+)_(\d+)$/.exec(str(s[1])); return { unit: m ? +m[1] : 0, body: m ? +m[2] : 0, node: s }; });
}

// ---- fields ----
interface Field { name: string; text: string; x: number; y: number; angle: number; face: string; sw: number; sh: number; style: string; visible: boolean; nameShown: boolean; priv: boolean }
function fieldOf(p: SNode, dx: number, dy: number, flipY: boolean): Field {
  const priv = str(p[1]) === "private" && p.length > 3 && !isList(p[2]) && !isList(p[3]);
  const name = str(p[priv ? 2 : 1]), text = str(p[priv ? 3 : 2]);
  const at = kid(p, "at"), eff = kid(p, "effects"), font = eff && kid(eff, "font"), size = font && kid(font, "size");
  const face = font && kid(font, "face") ? str(kid(font, "face")![1]) : "";
  const hidden = flag(p, "hide", false) || (!!eff && (flag(eff, "hide", false) || eff.some((x) => str(x) === "hide")));
  const just = eff && kid(eff, "justify") ? (kid(eff, "justify") as SNode).slice(1).map(str).sort().join(" ") : "";
  const style = [font && flag(font, "bold", false) ? "b" : "", font && flag(font, "italic", false) ? "i" : "", just,
    font && kid(font, "thickness") ? String(iu(num(kid(font, "thickness")![1]))) : "", font && kid(font, "color") ? (kid(font, "color") as SNode).slice(1).map(str).join(",") : "",
    font && kid(font, "line_spacing") ? str(kid(font, "line_spacing")![1]) : "", at ? String(num(at[3])) : "0"].join("|");
  const x = at ? num(at[1]) : 0, y = at ? num(at[2]) : 0;
  return { name, text, x: iu(x - dx), y: iu(flipY ? -y : y - dy), angle: at ? num(at[3]) : 0, face, sw: size ? iu(num(size[1])) : 0, sh: size ? iu(num(size[2] ?? size[1])) : 0, style,
    visible: !hidden, nameShown: flag(p, "show_name", false), priv };
}
const fieldsOf = (n: SNode): SNode[] => kids(n, "property").filter((p) => { const priv = str(p[1]) === "private" && p.length > 3 && !isList(p[2]); return !META.test(str(p[priv ? 2 : 1])); });
const metaOf = (n: SNode, name: string): string => { const p = kids(n, "property").find((q) => str(q[1]) === name); return p ? str(p[2]) : ""; };

// ---- pins ----
interface Pin { unit: number; body: number; number: string; name: string; type: string; shape: string; x: number; y: number; rot: number; len: number; hidden: boolean; numSize: number; nameSize: number; alts: string }
function pinsOf(sym: SNode): Pin[] {
  const out: Pin[] = [];
  for (const s of subs(sym)) for (const p of kids(s.node, "pin")) {
    const at = kid(p, "at"), nm = kid(p, "name"), nb = kid(p, "number");
    const tsize = (n: SNode | null): number => { const e = n && kid(n, "effects"), f = e && kid(e, "font"), z = f && kid(f, "size"); return z ? iu(num(z[1])) : 0; };
    out.push({ unit: s.unit, body: s.body, number: nb ? str(nb[1]) : "", name: nm ? str(nm[1]) : "", type: str(p[1]), shape: str(p[2]),
      x: at ? iu(num(at[1])) : 0, y: at ? iu(num(at[2])) : 0, rot: at ? num(at[3]) : 0, len: kid(p, "length") ? iu(num(kid(p, "length")![1])) : 0,
      hidden: flag(p, "hide", false) || p.some((x) => str(x) === "hide"), numSize: tsize(nb), nameSize: tsize(nm),
      alts: kids(p, "alternate").map((a) => `${str(a[1])}:${str(a[2])}:${str(a[3])}`).sort().join(";") });
  }
  return out;
}
/** SCH_PIN::getItemDescription. */
export function pinDesc(p: Pin): string {
  const name = p.name === "~" ? "" : unescape(p.name), type = PIN_TYPE[p.type] || p.type, shape = PIN_SHAPE[p.shape] || p.shape;
  const what = p.hidden ? "Hidden pin" : "Pin";
  return name ? `${what} ${p.number} [${name}, ${type}, ${shape}]` : `${what} ${p.number} [${type}, ${shape}]`;
}
/** LIB_SYMBOL::GetPin( number, unit, bodyStyle ): unit / body style 0 is common to all. */
function findPin(pins: Pin[], number: string, unit: number, body: number): Pin | null {
  return pins.find((q) => q.number === number && (!unit || !q.unit || q.unit === unit) && (!body || !q.body || q.body === body)) || null;
}
/** PIN_COMPARISON_VIEW::Compare with the unit flag off: equal or not. */
function pinsDiffer(a: Pin, b: Pin, alt: boolean): boolean {
  return a.number !== b.number || a.x !== b.x || a.y !== b.y || a.len !== b.len || a.rot !== b.rot || a.shape !== b.shape || a.type !== b.type
    || a.hidden !== b.hidden || a.numSize !== b.numSize || a.nameSize !== b.nameSize || (alt && a.alts !== b.alts);
}

// ---- graphics ----
const SHAPES = new Set(["rectangle", "circle", "arc", "polyline", "bezier", "ellipse", "ellipse_arc"]);
function canon(n: unknown): string {
  if (!isList(n)) { const s = str(n); return /^-?\d+(\.\d+)?$/.test(s) ? String(iu(Number(s))) : s; }
  return "(" + (n as SNode).filter((c) => !(isList(c) && str((c as SNode)[0]) === "uuid")).map(canon).join(" ") + ")";
}
const pts = (n: SNode, k: string): [number, number] => { const c = kid(n, k); return c ? [num(c[1]), num(c[2])] : [0, 0]; };
/** SCH_SHAPE::GetItemDescription. */
export function shapeDesc(n: SNode): string {
  const t = str(n[0]);
  if (t === "rectangle") { const a = pts(n, "start"), b = pts(n, "end"); return `Rectangle, width ${mmText(Math.abs(a[0] - b[0]))} height ${mmText(Math.abs(a[1] - b[1]))}`; }
  if (t === "circle") { const c = kid(n, "radius"); return `Circle, radius ${mmText(c ? num(c[1]) : 0)}`; }
  if (t === "arc") {
    const [a, m, b] = [pts(n, "start"), pts(n, "mid"), pts(n, "end")];
    const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
    let r = 0;
    if (Math.abs(d) > 1e-12) { const s2 = (p: [number, number]): number => p[0] * p[0] + p[1] * p[1];
      const ux = (s2(a) * (m[1] - b[1]) + s2(m) * (b[1] - a[1]) + s2(b) * (a[1] - m[1])) / d, uy = (s2(a) * (b[0] - m[0]) + s2(m) * (a[0] - b[0]) + s2(b) * (m[0] - a[0])) / d;
      r = Math.hypot(a[0] - ux, a[1] - uy); }
    return `Arc, radius ${mmText(r)}`;
  }
  const count = (): number => { const p = kid(n, "pts"); return p ? kids(p, "xy").length : 0; };
  if (t === "polyline") return `Polyline, ${count()} points`;
  if (t === "bezier") return `Bezier Curve, ${count()} points`;
  const ra = kid(n, "major_radius"), rb = kid(n, "minor_radius");
  return `Ellipse, ${mmText(ra ? num(ra[1]) : 0)} x ${mmText(rb ? num(rb[1]) : 0)}`;
}
function shapesOf(sym: SNode): { key: string; node: SNode }[] {
  const out: { key: string; node: SNode }[] = [];
  for (const s of subs(sym)) for (const c of s.node) if (isList(c) && SHAPES.has(str((c as SNode)[0]))) out.push({ key: canon(c), node: c as SNode });
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const unitCount = (sym: SNode): number => Math.max(1, ...subs(sym).map((s) => s.unit));
const powerOf = (sym: SNode): string => { const p = kid(sym, "power"); return p ? (p.length > 1 ? str(p[1]) : "global") : ""; };
const pinOffset = (sym: SNode): number => { const pn = kid(sym, "pin_names"), o = pn && kid(pn, "offset"); return o ? iu(num(o[1])) : iu(0.508); };
const hidesKid = (sym: SNode, k: string): boolean => { const n = kid(sym, k); return !!n && (n.some((x) => str(x) === "hide") || flag(n, "hide", false)); };
const filters = (sym: SNode): string[] => metaOf(sym, "ki_fp_filters").split(/\s+/).filter(Boolean);
const listKid = (sym: SNode, k: string): SNode[] => { const n = kid(sym, k); return n ? (n.slice(1).filter(isList) as SNode[]) : []; };

/**
 * LIB_SYMBOL::Compare( lib, SymbolCompareFlags(), reporter ): every difference between the schematic's copy and the
 * library's.  `inst` is the placed symbol: its fields stand in for the embedded symbol's (FIELD_T ids are matched by
 * name, as they are fixed); null compares the two library symbols' own fields.
 */
export function compareSymbols(sch: SNode, lib: SNode, parity: Parity, inst: SNode | null = null): string[] {
  const p = Object.assign(parityOf({}), parity), out: string[] = [], on = (k: string): boolean => !!p[k];
  if (powerOf(sch) !== powerOf(lib)) out.push("Power flag differs.");
  if (unitCount(sch) !== unitCount(lib)) out.push("Unit count differs.");
  const sa = shapesOf(sch), sb = shapesOf(lib);
  if (sa.length !== sb.length) out.push("Graphic item count differs.");
  else for (let i = 0; i < sa.length; i++) if (sa[i].key !== sb[i].key) out.push(`Graphic item differs: ${shapeDesc(sa[i].node)}; ${shapeDesc(sb[i].node)}.`);
  const pa = pinsOf(sch), pb = pinsOf(lib), alt = on("pin_alt_function_definitions");
  for (const a of pa) {
    const b = findPin(pb, a.number, a.unit, a.body);
    if (!b) out.push(`Extra pin in schematic symbol: ${pinDesc(a)}.`);
    else if (pinsDiffer(a, b, alt)) out.push(`Pin ${a.number} differs: ${pinDesc(a)}; ${pinDesc(b)}`);
  }
  for (const b of pb) if (!findPin(pa, b.number, b.unit, b.body)) out.push(`Missing pin in schematic symbol: ${pinDesc(b)}.`);
  // fields: the placed symbol's, relative to its position; the library's have Y up in the file
  const at = inst && kid(inst, "at"), sx = at ? num(at[1]) : 0, sy = at ? num(at[2]) : 0;
  const fa = (inst ? fieldsOf(inst).map((p) => Object.assign(fieldOf(p, sx, sy, false), { priv: false })) : fieldsOf(sch).map((p) => fieldOf(p, 0, 0, true)));
  const fb = fieldsOf(lib).map((p) => fieldOf(p, 0, 0, true));
  for (const a of fa) {
    const b = fb.find((f) => f.name === a.name);
    if (!b) { if (on("extra_fields")) out.push(`Extra field in schematic symbol: ${a.name}.`); continue; }
    if (on("field_texts") && a.name !== "Reference" && a.text !== b.text) out.push(`Field '${a.name}' differs: ${a.text}; ${b.text}.`);
    if (on("field_styles")) {
      if (a.face !== b.face) out.push(`Field '${a.name}' fonts differ.`);
      if (a.sw !== b.sw || a.sh !== b.sh) out.push(`Field '${a.name}' text sizes differ.`);
      if (a.style !== b.style) out.push(`Field '${a.name}' text styles differ.`);
    }
    if (on("field_visibilities")) {
      if (a.visible !== b.visible) out.push(`Field '${a.name}' visibility flags differ.`);
      if (a.nameShown !== b.nameShown) out.push(`Field '${a.name}' name shown flags differ.`);
    }
    if (a.priv !== b.priv) out.push(`Field '${a.name}' privacy flags differ.`);
    if (on("field_positions") && (a.x !== b.x || a.y !== b.y)) out.push(`Field '${a.name}' positions differ.`);
  }
  if (on("missing_fields")) for (const b of fb) if (!fa.some((f) => f.name === b.name)) out.push(`Missing field in schematic symbol: ${b.name}.`);
  const ffa = filters(sch), ffb = filters(lib);
  if (ffa.length !== ffb.length) out.push("Footprint filter count differs.");
  else for (let i = 0; i < ffa.length; i++) if (ffa[i] !== ffb[i]) out.push("Footprint filters differ.");
  for (const [k, what] of [["pin_maps", "Pin map"], ["associated_footprints", "Associated footprint"]] as const) {
    const a = listKid(sch, k), b = listKid(lib, k);
    if (a.length !== b.length) out.push(`${what} count differs.`);
    else if (a.map(canon).join() !== b.map(canon).join()) out.push(`${what}s differ.`);
  }
  if (metaOf(sch, "ki_keywords") !== metaOf(lib, "ki_keywords")) out.push("Symbol keywords differ.");
  if (pinOffset(sch) !== pinOffset(lib)) out.push("Symbol pin name offsets differ.");
  if (on("pin_name_number_visibilities")) {
    if (hidesKid(sch, "pin_names") !== hidesKid(lib, "pin_names")) out.push("Show pin names settings differ.");
    if (hidesKid(sch, "pin_numbers") !== hidesKid(lib, "pin_numbers")) out.push("Show pin numbers settings differ.");
  }
  // EXCLUDE_FROM_SIM is always masked out of SymbolCompareFlags
  if (on("exclude_from_bom_flags") && flag(sch, "in_bom", true) !== flag(lib, "in_bom", true)) out.push("Exclude from bill of materials settings differ.");
  if (on("exclude_from_board_flags") && flag(sch, "on_board", true) !== flag(lib, "on_board", true)) out.push("Exclude from board settings differ.");
  if (on("dnp_flags") && flag(sch, "dnp", false) !== flag(lib, "dnp", false)) out.push("Do not populate settings differ.");
  if (on("exclude_from_position_file_flags") && flag(sch, "in_pos_files", true) !== flag(lib, "in_pos_files", true)) out.push("Exclude from position files settings differ.");
  return out;
}

/** A copy of the placed symbol drawn alone at the origin, unrotated, its fields moved with it (the diff's schematic side). */
export function instanceAtOrigin(inst: SNode): SNode {
  const at = kid(inst, "at"), sx = at ? num(at[1]) : 0, sy = at ? num(at[2]) : 0;
  const move = (n: SNode): SNode => n.map((c) => {
    if (!isList(c)) return c;
    const t = str((c as SNode)[0]);
    if (t === "at" && n === inst) return ["at", 0, 0, 0];
    if (t === "mirror" && n === inst) return null;
    if (t === "property") return (c as SNode).map((d) => (isList(d) && str((d as SNode)[0]) === "at" ? ["at", +(num((d as SNode)[1]) - sx).toFixed(4), +(num((d as SNode)[2]) - sy).toFixed(4), ...(d as SNode).slice(3)] : d));
    return c;
  }).filter((c) => c !== null) as SNode;
  return move(inst);
}
