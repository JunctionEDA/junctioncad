// web/domains/pcb/fab/ipc2581 — the IPC-2581 file of a board (File > Fabrication Outputs > IPC-2581, PCB_IO_IPC2581 in
// pcbnew/pcb_io/ipc2581/pcb_io_ipc2581.cpp).
//
// The element tree is KiCad's: IPC-2581 (revision B or C) > Content (FunctionMode with its sectionKey, StepRef,
// LayerRef, BomRef and the dictionaries), LogisticHeader, HistoryRecord, Bom, Ecad > CadHeader (Spec per stackup
// layer) and CadData (Layer, the drill and slot layers, Stackup, Step: Datum, Profile, Package, Component,
// LogicalNet, LayerFeature per layer with a Set per net, and the drill LayerFeatures with their Holes).  The sections
// follow the function mode table (fab_sections.cpp TABLE_4) and ResolveSections (ipc2581_function_mode.cpp).
//
// Padstacks (addPadStack): a PadStackDef per distinct pad or via, with its round hole (PadstackHoleDef) and a
// PadstackPadDef per layer of its layer set; the Pad elements of the layer features name it in padstackDefRef.  The
// physical netlist (generatePhyNetGroup) lists every pad and via that can be probed from an outer side.
//
// What differs from the desktop: the via filling / capping / plugging / covering / tenting pad definitions are not
// written (the web writer has no layers for them); a pad's shape in the layer features is its standard primitive
// (Circle / RectCenter / Oval / RectRound) or a filled Polygon for custom and chamfered shapes; the profile's arcs are polylines (the web outline is chained from polygonised
// Edge.Cuts); a package outline is the courtyard or else the box of the pads.
import { stackupRows, stackupThickness } from "../canvas/board-setup";
import { boardShape } from "../viewer3d/outline";
import { type BoardModel, type Footprint, type Node, type Pad, type Track, type Via, type ZoneFill, isCopper, padShapeOn } from "./model";
import { Connections, PlotLog, flashed, padPrims, plotLayer } from "./plot";
import { courtyardLoops } from "./pnp";
import { primPolys } from "./poly";
import { type Prim, type Pt, norm360, rot } from "./prims";

/** fab_sections.h SECTION, in key order K B C A S U M P L R D O I E F G Y X */
export const SECTION_KEYS = "KBCASUMPLRDOIEFGYX";
export type Mode = "USERDEF" | "BOM" | "STACKUP" | "FABRICATION" | "ASSEMBLY" | "TEST" | "STENCIL" | "DFX";
export const MODES: Mode[] = ["USERDEF", "BOM", "STACKUP", "FABRICATION", "ASSEMBLY", "TEST", "STENCIL", "DFX"];
/** TABLE_4: per section (key order) the rule per mode, N excluded, O optional, Y required */
const TABLE_4 = ["ONNOONNN", "OYOOYYNN", "ONNNYYON", "ONNNYYNN", "ONYYNNNN", "ONOYYYYN", "ONNYNNON", "ONNNONYN", "ONNYYYON", "ONOYYYON", "ONOOOOON", "ONYYYYON", "ONYYNNNN", "ONOONNNN", "ONOONNNN", "ONNOOONN", "ONNYOYNN", "OOOOOOOY"];
const rule = (mode: Mode, key: string): string => TABLE_4[SECTION_KEYS.indexOf(key)][MODES.indexOf(mode)];
export const requiredSections = (mode: Mode): Set<string> => new Set([...SECTION_KEYS].filter((k) => rule(mode, k) === "Y"));
export const optionalSections = (mode: Mode): Set<string> => new Set([...SECTION_KEYS].filter((k) => rule(mode, k) === "O"));
/** RecommendedOptionalSections */
export function recommendedSections(mode: Mode): Set<string> {
  switch (mode) {
    case "USERDEF": return new Set([...SECTION_KEYS].filter((k) => k !== "G" && k !== "Y" && k !== "X"));   // LegacySections
    case "STACKUP": return new Set(["E"]);
    case "FABRICATION": return new Set(["K", "E", "F"]);
    case "ASSEMBLY": return new Set(["K", "P"]);
    default: return new Set();
  }
}
export interface Resolved { included: Set<string>; conflicts: string[]; suppress: Set<string> }
/** IPC2581::ResolveSections */
export function resolveSections(rev: "B" | "C", mode: Mode, requested: Set<string>): Resolved {
  const out: Resolved = { included: new Set(), conflicts: [], suppress: new Set() };
  if (mode === "DFX") { out.conflicts.push("Cannot produce this IPC-2581 data set."); return out; }
  const opt = optionalSections(mode), req = requiredSections(mode);
  for (const k of SECTION_KEYS) if (k !== "X" && ((requested.has(k) && opt.has(k)) || req.has(k))) out.included.add(k);
  if (!out.included.size) { out.conflicts.push("No IPC-2581 content selected."); return out; }
  const has = (k: string): boolean => out.included.has(k);
  if (has("A") && !has("O")) out.conflicts.push("Cannot export assembly data without outer copper layers.");
  if (has("Y") && !has("O")) out.conflicts.push("Cannot export physical netlist without outer copper layers.");
  if (!has("K")) out.suppress.add("PAD_PADSTACKDEFREF");
  if (has("B") && !has("C")) out.suppress.add("BOM_REFDES_PACKAGEREF");
  if (has("B") && !has("O")) out.suppress.add("BOM_REFDES_LAYERREF");
  if (rev === "C") { if (!has("B")) { out.suppress.add("COMPONENT_REFDES"); out.suppress.add("PINREF_COMPONENTREF"); } if (!has("C")) out.suppress.add("COMPONENT_PACKAGEREF"); }
  else {
    if (has("A") && !has("C")) out.conflicts.push("Component assembly data cannot be exported without component packages in IPC-2581B.");
    if (!has("A")) { out.suppress.add("PINREF_COMPONENTREF"); if (has("B")) out.suppress.add("BOM_REFDES"); }
  }
  return out;
}
export const sectionKeyString = (s: Set<string>): string => [...SECTION_KEYS].filter((k) => s.has(k)).join("");
/** IPC2581::SectionForBoardLayer */
export function sectionForLayer(layer: string, copper: string[]): string | null {
  if (isCopper(layer)) return layer === copper[0] || layer === copper[copper.length - 1] ? "O" : "I";
  if (/\.Adhes$/.test(layer)) return "F";
  if (/\.Paste$/.test(layer)) return "P";
  if (/\.SilkS$/.test(layer)) return "L";
  if (/\.Mask$/.test(layer)) return "M";
  if (layer === "Edge.Cuts") return "U";
  if (/\.CrtYd$/.test(layer) || layer === "Margin") return "D";
  if (/\.Fab$/.test(layer)) return "A";
  if (/User/.test(layer)) return "D";
  return null;
}

export interface Ipc2581Options {
  rev: "B" | "C"; inch: boolean; precision: number; mode: Mode; sections: Set<string>;
  anonymizeNets: boolean; omitRefDes: boolean;
  /** BOM field columns ("" = omit / generate unique) and the distributor's name */
  internalId: string; mpn: string; mfg: string; distPn: string; dist: string; bomRev: string;
  layers: string[]; nameOf: (layer: string) => string; boardName: string; version: string; date: Date;
}
export interface Ipc2581Result { xml: string; warnings: string[]; errors: string[] }

// ---------------------------------------------------------------- XML
class X {
  attrs: [string, string][] = []; kids: X[] = [];
  constructor(public name: string) {}
  a(k: string, v: string | number): this { this.attrs.push([k, String(v)]); return this; }
  add(name: string): X { const x = new X(name); this.kids.push(x); return x; }
  insert(x: X, before?: (k: X) => boolean): void { const i = before ? this.kids.findIndex(before) : -1; if (i < 0) this.kids.push(x); else this.kids.splice(i, 0, x); }
  write(depth: number, out: string[]): void {
    const pad = "  ".repeat(depth), at = this.attrs.map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
    if (!this.kids.length) { out.push(`${pad}<${this.name}${at}/>`); return; }
    out.push(`${pad}<${this.name}${at}>`); for (const k of this.kids) k.write(depth + 1, out); out.push(`${pad}</${this.name}>`);
  }
}
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");

/** PCB_IO_IPC2581::SaveBoard */
export function writeIpc2581(m: BoardModel, setup: Node | null, o: Ipc2581Options): Ipc2581Result {
  const warnings: string[] = [], errors: string[] = [];
  const res = resolveSections(o.rev, o.mode, o.sections);
  if (res.conflicts.length) return { xml: "", warnings, errors: res.conflicts };
  const inc = (k: string): boolean => res.included.has(k), sup = (k: string): boolean => res.suppress.has(k);
  const units = o.inch ? "INCH" : "MILLIMETER", scale = o.inch ? 1 / 25.4 : 1, sig = Math.max(1, Math.min(10, Math.round(o.precision) || 6));
  /** FormatTrimmedDecimal */
  const fv = (v: number, digits = sig): string => {
    let s = (Math.round(v * scale * 1e6) / 1e6).toFixed(digits); if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, ".0");
    return /^-0(\.0)?$/.test(s) ? "0.0" : s;
  };
  const xy = (n: X, x: number, y: number, xn = "x", yn = "y"): X => n.a(xn, fv(x)).a(yn, fv(-y));
  // ---- names (sanitizeId / genString)
  const ok = /[A-Za-z0-9_\\\-.+><]/;
  const sanitize = (s: string): string => (o.rev === "C" ? s.replace(/:/g, "_") : [...s].map((c) => (ok.test(c) ? c : "_")).join(""));
  const generated = new Map<string, string>(), used = new Map<string, Set<string>>();
  const gen = (s: string, prefix = ""): string => {
    const key = prefix ? `${prefix}:${s}` : s; const hit = generated.get(key); if (hit) return hit;
    const set = prefix === "CMP" || prefix === "REF" ? prefix : ""; let names = used.get(set); if (!names) { names = new Set(); used.set(set, names); }
    const base = sanitize(s); let name = base, k = 1; while (names.has(name)) name = `${base}_${k++}`;
    names.add(name); generated.set(key, name); return name;
  };
  const layerName = (l: string): string => gen(o.nameOf(l), "LAYER");
  const anon = new Map<string, string>(); if (o.anonymizeNets) { const all = new Set<string>(); for (const f of m.footprints) for (const p of f.pads) if (p.net) all.add(p.net); for (const t of m.tracks) if (t.net) all.add(t.net); for (const v of m.vias) if (v.net) all.add(v.net); [...all].sort().forEach((n, i) => anon.set(n, `NET_${i + 1}`)); }
  const netName = (n: string): string => gen(anon.get(n) || n, "NET");
  const refDesOut = !o.omitRefDes && !sup("COMPONENT_REFDES");
  const cmpName = (fp: Footprint): string => gen(fp.ref || "UNNAMED", "CMP");
  const pinName = (p: Pad): string => (p.number ? p.number : `NOPIN_${p.fp.pads.indexOf(p) + 1}`);

  const root = new X("IPC-2581").a("revision", o.rev).a("xmlns", "http://webstds.ipc.org/2581").a("xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance").a("xmlns:xsd", "http://www.w3.org/2001/XMLSchema")
    .a("xsi:schemaLocation", o.rev === "B" ? "http://webstds.ipc.org/2581 http://webstds.ipc.org/2581/IPC-2581B1.xsd" : "http://webstds.ipc.org/2581 http://webstds.ipc.org/2581/IPC-2581C.xsd");
  // ---- Content
  const content = root.add("Content").a("roleRef", "Owner");
  const fm = content.add("FunctionMode").a("mode", o.mode); if (o.rev === "B") fm.a("level", o.mode === "USERDEF" ? "1" : "3");
  const needsCad = [...res.included].some((k) => k !== "B");
  const stepName = gen(o.boardName, "BOARD");
  if (needsCad) content.add("StepRef").a("name", stepName);
  const color = new X("DictionaryColor"), lineD = new X("DictionaryLineDesc").a("units", units), fillD = new X("DictionaryFillDesc").a("units", units);
  const stdD = new X("DictionaryStandard").a("units", units), userD = new X("DictionaryUser").a("units", units);
  if (o.rev === "C") content.kids.push(color, lineD, fillD, stdD, userD); else content.kids.push(stdD, userD, lineD, color);
  // ---- LogisticHeader, HistoryRecord
  const lg = root.add("LogisticHeader");
  lg.add("Role").a("id", "Owner").a("roleFunction", "SENDER"); lg.add("Enterprise").a("id", "UNKNOWN").a("code", "NONE"); lg.add("Person").a("name", "UNKNOWN").a("enterpriseRef", "UNKNOWN").a("roleRef", "Owner");
  const p2 = (n: number): string => String(n).padStart(2, "0"), d = o.date;
  const iso = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const hist = root.add("HistoryRecord").a("number", "1").a("origination", iso).a("software", "KiCad EDA").a("lastChange", iso);
  const sw = hist.add("FileRevision").a("fileRevisionId", "1").a("comment", "NO COMMENT").a("label", "NO LABEL").add("SoftwarePackage").a("name", "KiCad").a("revision", o.version).a("vendor", "KiCad EDA");
  sw.add("Certification").a("certificationStatus", "SELFTEST");

  // ---- Ecad
  const ecad = root.add("Ecad").a("name", "Design");
  const cadHeader = ecad.add("CadHeader").a("units", units);
  const cad = ecad.add("CadData");
  const rows = stackupRows(setup as unknown as SNode | null);
  const thickness = stackupThickness(rows) || (m.doc as unknown as { thickness?: number }).thickness || 1.6;
  const enabled = o.layers.length ? o.layers : [...m.copper, "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "F.Paste", "B.Paste", "Edge.Cuts"];
  const layerIncluded = (l: string): boolean => { const s = sectionForLayer(l, m.copper); return !!s && inc(s); };
  const attrsFor = (n: X, l: string): void => {
    const side = /^F\./.test(l) ? "TOP" : /^B\./.test(l) ? "BOTTOM" : "NONE";
    const fn = isCopper(l) ? "CONDUCTOR" : /\.Adhes$/.test(l) ? "GLUE" : /\.Paste$/.test(l) ? "SOLDERPASTE" : /\.SilkS$/.test(l) ? "SILKSCREEN" : /\.Mask$/.test(l) ? "SOLDERMASK" : l === "Edge.Cuts" ? "BOARD_OUTLINE" : /\.CrtYd$/.test(l) ? "COURTYARD" : /\.Fab$/.test(l) ? "ASSEMBLY" : "DOCUMENT";
    n.a("layerFunction", fn).a("polarity", "POSITIVE").a("side", isCopper(l) ? (l === m.copper[0] ? "TOP" : l === m.copper[m.copper.length - 1] ? "BOTTOM" : "INTERNAL") : l === "Edge.Cuts" ? "ALL" : side);
  };
  // stackup rows first (generateCadLayers), then the other enabled layers
  const added = new Set<string>(); const specs: { name: string; row: (typeof rows)[number] }[] = [];
  const rowLayer = (r: (typeof rows)[number]): string | null => (r.id ? null : r.layer);
  for (const r of rows) {
    const diel = !!r.id, l = rowLayer(r);
    if (diel ? !inc("E") : !l || !layerIncluded(l)) continue;
    const name = diel ? gen(`DIELECTRIC_${r.id}${r.sub ? "_" + rows.filter((x) => x.id === r.id).indexOf(r) : ""}`, "LAYER") : layerName(l!);
    const n = cad.add("Layer").a("name", name);
    if (diel) n.a("layerFunction", r.type === "Core" ? "DIELCORE" : "DIELPREG").a("polarity", "POSITIVE").a("side", "INTERNAL");
    else { attrsFor(n, l!); added.add(l!); }
    specs.push({ name, row: r });
  }
  for (const l of enabled) { if (added.has(l) || !layerIncluded(l)) continue; added.add(l); attrsFor(cad.add("Layer").a("name", layerName(l)), l); }
  // drill and slot layers
  const first = m.copper[0], last = m.copper[m.copper.length - 1];
  interface Hole { x: number; y: number; d: number; plated: string; net: string; from: string; to: string; pad?: Pad; via?: Via; slot?: { w: number; h: number; rot: number } }
  const holes: Hole[] = [];
  for (const fp of m.footprints) for (const p of fp.pads) if (p.drill && p.drill.w > 0) holes.push({ x: p.x, y: p.y, d: Math.min(p.drill.w, p.drill.h), plated: p.type === "thru_hole" ? "PLATED" : "NONPLATED", net: p.net, from: first, to: last, pad: p, slot: p.drill.oval && p.drill.w !== p.drill.h ? { w: p.drill.w, h: p.drill.h, rot: p.rot } : undefined });
  for (const v of m.vias) holes.push({ x: v.x, y: v.y, d: v.drill, plated: "VIA", net: v.net, from: v.type === "through" ? first : v.layers[0], to: v.type === "through" ? last : v.layers[v.layers.length - 1], via: v });
  const spanKey = (h: Hole): string => `${h.from}|${h.to}`;
  const drillSpans = new Map<string, Hole[]>(), slotSpans = new Map<string, Hole[]>();
  for (const h of holes) { const mp = h.slot ? slotSpans : drillSpans; const k = spanKey(h); if (!mp.has(k)) mp.set(k, []); mp.get(k)!.push(h); }
  const spanName = (k: string, prefix: string): string => { const [a, b] = k.split("|"); return gen(`${o.nameOf(a)}_${o.nameOf(b)}`, prefix); };
  if (inc("R")) for (const [mp, prefix, fn] of [[drillSpans, "DRILL", "DRILL"], [slotSpans, "SLOT", "ROUT"]] as const) for (const k of mp.keys()) {
    const [a, b] = k.split("|"); const n = cad.add("Layer").a("name", spanName(k, prefix)).a("layerFunction", fn).a("polarity", "POSITIVE").a("side", "ALL");
    n.add("Span").a("fromLayer", layerName(a)).a("toLayer", layerName(b));
  }
  // Spec (generateCadSpecs) and Stackup
  if (inc("S") || inc("E")) for (const s of specs) {
    const sp = cadHeader.add("Spec").a("name", gen(s.name, "SPEC_LAYER"));
    if (s.row.material) sp.add("General").a("type", "MATERIAL").add("Property").a("text", s.row.material);
    if (s.row.type === "Copper") sp.add("Conductor").a("type", "CONDUCTIVITY").add("Property").a("value", "5.959e7").a("unit", "SIEMENS/M");
    else if (s.row.epsilonR) { sp.add("Dielectric").a("type", "DIELECTRIC_CONSTANT").add("Property").a("value", fv(s.row.epsilonR / scale)); if (s.row.lossTangent) sp.add("Dielectric").a("type", "LOSS_TANGENT").add("Property").a("value", fv(s.row.lossTangent / scale)); }
  }
  if (inc("S")) {
    const st = cad.add("Stackup").a("name", "Primary_Stackup").a("overallThickness", fv(thickness)).a("tolPlus", "0.0").a("tolMinus", "0.0").a("whereMeasured", "MASK");
    if (o.rev === "C") st.a("stackupStatus", "PROPOSED");
    const g = st.add("StackupGroup").a("name", "Primary_Stackup_Group").a("thickness", fv(thickness)).a("tolPlus", "0.0").a("tolMinus", "0.0");
    specs.forEach((s, i) => { const sl = g.add("StackupLayer").a("layerOrGroupRef", s.name).a("thickness", fv(s.row.thickness || 0)).a("tolPlus", "0.0").a("tolMinus", "0.0").a("sequence", i); sl.add("SpecRef").a("id", gen(s.name, "SPEC_LAYER")); });
  }

  // ---- Step
  const step = cad.add("Step").a("name", stepName); if (o.rev === "C") step.a("type", "BOARD");
  step.add("Datum").a("x", "0.0").a("y", "0.0");
  const fill = (n: X, hollow: boolean): void => { if (hollow) n.add("FillDesc").a("fillProperty", "HOLLOW"); };
  const polygon = (parent: X, pts: Pt[], hollowWidth = 0): boolean => {
    if (pts.length < 3) return false;
    const pg = parent.add("Polygon"); xy(pg.add("PolyBegin"), pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) xy(pg.add("PolyStepSegment"), pts[i][0], pts[i][1]);
    xy(pg.add("PolyStepSegment"), pts[0][0], pts[0][1]);
    if (hollowWidth > 0) pg.add("LineDesc").a("lineWidth", fv(hollowWidth)).a("lineEnd", "ROUND");
    fill(pg, hollowWidth > 0); return true;
  };
  if (inc("U")) {
    const shape = boardShape(m.doc);
    let best = -1, bestA = -1; shape.outlines.forEach((ol, i) => { let a = 0; const p = ol.contour; for (let j = 0; j < p.length; j++) { const q = p[(j + 1) % p.length]; a += p[j][0] * q[1] - q[0] * p[j][1]; } if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = i; } });
    if (shape.fallback || best < 0) errors.push("Board outline is invalid or missing.  Please run DRC.");
    else { const pr = step.add("Profile"); polygon(pr, shape.outlines[best].contour); for (const c of shape.outlines[best].cutouts) { if (c.length < 3) continue; const cu = pr.add("Cutout"); xy(cu.add("PolyBegin"), c[0][0], c[0][1]); for (let i = 1; i < c.length; i++) xy(cu.add("PolyStepSegment"), c[i][0], c[i][1]); xy(cu.add("PolyStepSegment"), c[0][0], c[0][1]); } }
  }
  // standard primitives (addShape for pads)
  const stdShapes = new Map<string, string>();
  const stdRef = (parent: X, p: Prim): boolean => {
    let key = "", make: ((e: X) => void) | null = null, kind = "";
    if (p.k === "circle") { key = `C${fv(p.d)}`; kind = "CIRCLE"; make = (e) => { e.add("Circle").a("diameter", fv(p.d)); }; }
    else if (p.k === "rect") { key = `R${fv(p.w)}x${fv(p.h)}`; kind = "RECT"; make = (e) => { e.add("RectCenter").a("width", fv(p.w)).a("height", fv(p.h)); }; }
    else if (p.k === "oval") { key = `O${fv(p.w)}x${fv(p.h)}`; kind = "OVAL"; make = (e) => { e.add("Oval").a("width", fv(p.w)).a("height", fv(p.h)); }; }
    else if (p.k === "roundrect") { key = `RR${fv(p.w)}x${fv(p.h)}r${fv(p.r)}`; kind = "ROUNDRECT"; make = (e) => { e.add("RectRound").a("width", fv(p.w)).a("height", fv(p.h)).a("radius", fv(p.r)).a("upperRight", "true").a("upperLeft", "true").a("lowerRight", "true").a("lowerLeft", "true"); }; }
    if (!make) return false;
    let id = stdShapes.get(key);
    if (!id) { id = `${kind}_${stdShapes.size + 1}`; stdShapes.set(key, id); make(stdD.add("EntryStandard").a("id", id)); }
    parent.add("StandardPrimitiveRef").a("id", id); return true;
  };
  const feature = (parent: X, p: Prim): void => {
    if (p.k === "seg") { if (p.w > 0) { const l = xy(xy(parent.add("Line"), p.x1, p.y1, "startX", "startY"), p.x2, p.y2, "endX", "endY"); l.add("LineDesc").a("lineWidth", fv(p.w)).a("lineEnd", "ROUND"); } return; }
    if (p.k === "arc") {
      if (!(p.w > 0)) return;
      const s: Pt = [p.cx + p.r * Math.cos(p.a0), p.cy + p.r * Math.sin(p.a0)], e: Pt = [p.cx + p.r * Math.cos(p.a1), p.cy + p.r * Math.sin(p.a1)];
      const a = xy(xy(xy(parent.add("Arc"), s[0], s[1], "startX", "startY"), e[0], e[1], "endX", "endY"), p.cx, p.cy, "centerX", "centerY").a("clockwise", p.acw ? "true" : "false");
      a.add("LineDesc").a("lineWidth", fv(p.w)).a("lineEnd", "ROUND"); return;
    }
    if (p.k === "td") return;
    for (const poly of primPolys(p)) polygon(parent, poly);
  };
  // user primitives (addShape into DictionaryUser): a pad shape that is no standard primitive, in the pad's frame
  const userShapes = new Map<string, string>();
  const userRef = (parent: X, p: Prim, unrot = 0): void => {
    const px = (p as { x?: number }).x || 0, py = (p as { y?: number }).y || 0;
    const polys = primPolys(p).map((q) => q.map(([x, y]): Pt => rot(x - px, y - py, -unrot)));
    const key = "P" + JSON.stringify(polys.map((q) => q.map(([x, y]) => `${fv(x)},${fv(y)}`)));
    let id = userShapes.get(key);
    if (!id) { id = `SHAPE_${userShapes.size + 1}`; userShapes.set(key, id); const sp = userD.add("EntryUser").a("id", id).add("UserSpecial"); for (const q of polys) polygon(sp, q); }
    parent.add("UserPrimitiveRef").a("id", id);
  };
  const shapeRef = (parent: X, p: Prim | null | undefined, unrot = 0): void => { if (p && !stdRef(parent, p) && "x" in p) userRef(parent, p, unrot); };
  /** addShape of a PCB_SHAPE circle (a via's pad, an unflashed pad layer): an outlined UCIRCLE user primitive */
  const userCircle = (parent: X, d: number, cx = 0, cy = 0): void => {
    const key = `C${fv(d)}@${fv(cx)},${fv(cy)}`; let id = userShapes.get(key);
    if (!id) { id = `UCIRCLE_${userShapes.size + 1}`; userShapes.set(key, id); const c = userD.add("EntryUser").a("id", id).add("UserSpecial").add("Circle").a("diameter", fv(d)); c.add("LineDesc").a("lineWidth", fv(0.1)).a("lineEnd", "ROUND"); c.add("FillDesc").a("fillProperty", "HOLLOW"); }
    parent.add("UserPrimitiveRef").a("id", id);
  };
  // padstacks (addPadStack): one PadStackDef per distinct pad or via, numbered in the order they are met
  const conn = new Connections(m);
  const LAYER_IDS: Record<string, number> = { "F.Mask": 1, "B.Mask": 3, "F.SilkS": 5, "B.SilkS": 7, "F.Adhes": 9, "B.Adhes": 11, "F.Paste": 13, "B.Paste": 15, "Dwgs.User": 17, "Cmts.User": 19, "Eco1.User": 21, "Eco2.User": 23, "Edge.Cuts": 25, "Margin": 27, "B.CrtYd": 29, "F.CrtYd": 31, "B.Fab": 33, "F.Fab": 35 };
  /** LSET::Seq: the layers by PCB_LAYER_ID (F.Cu 0, F.Mask 1, B.Cu 2, B.Mask 3, In1.Cu 4 …) */
  const layerId = (l: string): number => { if (l === "F.Cu") return 0; if (l === "B.Cu") return 2; const i = /^In(\d+)\.Cu$/.exec(l); if (i) return 2 + 2 * +i[1]; const u = /^User\.(\d+)$/.exec(l); return u ? 37 + 2 * +u[1] : LAYER_IDS[l] ?? 1000; };
  const bySeq = (a: string, b: string): number => layerId(a) - layerId(b);
  const layerOk = (l: string): boolean => (isCopper(l) ? m.copper.includes(l) : !o.layers.length || o.layers.includes(l)) && layerIncluded(l);
  const nm = (v: number): number => Math.round(v * 1e6);
  const padstackNames = new Map<string, string>(), pkgStacks: X[] = [], featStacks: X[] = [];
  let stackList = pkgStacks;
  const register = (def: X): string => {
    const text: string[] = []; def.write(0, text); const key = text.join("\n");
    let name = padstackNames.get(key); if (name) return name;
    name = `PADSTACK_${padstackNames.size + 1}`; padstackNames.set(key, name);
    def.attrs.unshift(["name", name]); stackList.push(def); return name;
  };
  const padStack = (p: Pad): string => {
    const def = new X("PadStackDef"), dr = p.drill;
    // only round holes: IPC-2581 has no slotted padstack hole, slots go to the slot layer
    if (dr && dr.w > 0 && !(dr.oval && Math.abs(dr.w - dr.h) > 1e-9)) {
      const dh = dr.h > 0 ? dr.h : dr.w, off = padShapeOn(p, "F.Cu", m.copper).offset;
      xy(def.add("PadstackHoleDef").a("name", `${p.type === "thru_hole" ? "PTH" : "NPTH"}${nm(dr.w)}_${nm(dh)}`).a("diameter", fv(Math.min(dr.w, dh))).a("platingStatus", p.type === "thru_hole" ? "PLATED" : "NONPLATED").a("plusTol", "0.0").a("minusTol", "0.0"), off[0], off[1]);
    }
    for (const l of [...p.layers].sort(bySeq)) {
      if (!layerOk(l)) continue;
      const shape = padShapeOn(p, l, m.copper), off = shape.offset;
      const pd = def.add("PadstackPadDef").a("layerRef", layerName(l)).a("padUse", "REGULAR"); xy(pd.add("Location"), off[0], off[1]);
      if (isCopper(l) && p.type === "thru_hole" && dr && !flashed(p.removeUnused, p.keepEnds, p.zoneLayers, l, m.copper[0], m.copper[m.copper.length - 1], p.x, p.y, Math.max(shape.w, shape.h) / 2, conn)) {
        userCircle(pd, Math.min(dr.w, dr.h > 0 ? dr.h : dr.w), off[0], off[1]); continue;
      }
      const prims: Prim[] = []; padPrims(p, l, m, prims); shapeRef(pd, prims[0], p.rot);
    }
    return register(def);
  };
  const viaStack = (v: Via): string => {
    const def = new X("PadStackDef");
    def.add("PadstackHoleDef").a("name", `PH${nm(v.drill)}`).a("diameter", fv(v.drill)).a("platingStatus", "VIA").a("plusTol", "0.0").a("minusTol", "0.0").a("x", "0.0").a("y", "0.0");
    // PCB_VIA::GetLayerSet: the copper it spans, and the masks of an untented outer side
    const ls = [...v.layers];
    if (!(v.tentFront ?? m.settings.tentFront) && ls.includes("F.Cu")) ls.push("F.Mask");
    if (!(v.tentBack ?? m.settings.tentBack) && ls.includes("B.Cu")) ls.push("B.Mask");
    for (const l of ls.sort(bySeq)) {
      if (!layerOk(l)) continue;
      const d = (v.sizes && v.sizes.get(isCopper(l) ? l : l === "B.Mask" ? "B.Cu" : "F.Cu")) || v.size;
      if (isCopper(l) && !flashed(v.removeUnused, v.keepEnds, v.zoneLayers, l, v.layers[0], v.layers[v.layers.length - 1], v.x, v.y, d / 2, conn)) continue;
      const pd = def.add("PadstackPadDef").a("layerRef", layerName(l)).a("padUse", "REGULAR"); xy(pd.add("Location"), 0, 0);
      userCircle(pd, d);
    }
    return register(def);
  };
  // packages and components (generateComponents / addPackage)
  const pkgOf = new Map<Footprint, string>(); const pkgNodes: X[] = [], compNodes: X[] = [];
  const pkgSeen = new Map<string, string>();
  const oemOf = new Map<Footprint, string>();
  const netPins = new Map<string, [string, string][]>();
  for (const fp of m.footprints) {
    const comp = new X("Component");
    if (refDesOut) comp.a("refDes", cmpName(fp));
    for (const p of fp.pads) if (p.net) { if (!netPins.has(p.net)) netPins.set(p.net, []); netPins.get(p.net)!.push([cmpName(fp), pinName(p)]); }
    const sig = `${fp.lib}|${fp.pads.map((p) => `${p.number}:${p.base.shape}:${fv(p.base.w)}x${fv(p.base.h)}`).join(",")}`;
    let pkg = pkgSeen.get(sig);
    if (!pkg) {
      pkg = gen(fp.lib || fp.name || "PKG", "PKG"); pkgSeen.set(sig, pkg);
      const local = (q: Pt): Pt => { const r = rot(q[0] - fp.x, q[1] - fp.y, -fp.rot); return fp.side === "B.Cu" ? [-r[0], r[1]] : r; };
      let outline: Pt[] | null = null;
      for (const side of ["F.CrtYd", "B.CrtYd"]) { const loops = courtyardLoops(fp, side); if (loops && loops.length) { outline = loops[0].map(local); break; } }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of fp.pads) { const [lx, ly] = local([p.x, p.y]); const r = Math.max(p.base.w, p.base.h) / 2; x0 = Math.min(x0, lx - r); y0 = Math.min(y0, ly - r); x1 = Math.max(x1, lx + r); y1 = Math.max(y1, ly + r); }
      if (!isFinite(x0)) { x0 = y0 = -0.5; x1 = y1 = 0.5; }
      const pn = new X("Package").a("name", pkg).a("type", "OTHER").a("pinOne", fp.pads.length ? pinName(fp.pads[0]) : "1").a("pinOneOrientation", "OTHER").a("height", fv(parseFloat(fp.props.get("Height") || "0") || 0));
      const ol = pn.add("Outline"); polygon(ol, outline || [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]); ol.add("LineDesc").a("lineWidth", fv(0)).a("lineEnd", "ROUND");
      // addPackage asks for each pad's padstack: they come first in the Step
      for (const p of fp.pads) padStack(p);
      for (const p of fp.pads) { const pin = pn.add("Pin").a("number", pinName(p)).a("type", p.drill ? "THRU" : "SURFACE").a("electricalType", p.type === "np_thru_hole" ? "MECHANICAL" : "ELECTRICAL"); const [lx, ly] = local([p.x, p.y]); xy(pin.add("Location"), lx, ly); }
      pkgNodes.push(pn);
    }
    pkgOf.set(fp, pkg);
    const field = (f: string): string => (f ? fp.props.get(f) || "" : "");
    const oem = field(o.internalId) || `${fp.lib.split(":")[0]}_${fp.name}_${fp.value}`;
    oemOf.set(fp, oem);
    if (!sup("COMPONENT_PACKAGEREF") && inc("C")) comp.a("packageRef", pkg);
    comp.a("part", gen(oem, "REF")).a("layerRef", layerName(fp.side)).a("mountType", fp.throughHole ? "THMT" : fp.smd ? "SMT" : "OTHER");
    if (fp.rot || fp.side === "B.Cu") { const xf = comp.add("Xform"); let ang = norm360(fp.rot); if (fp.side === "B.Cu") ang = norm360(-ang - 180); if (ang) xf.a("rotation", fv(ang / scale, 2)); if (fp.side === "B.Cu") xf.a("mirror", "true"); }
    xy(comp.add("Location"), fp.x, fp.y);
    compNodes.push(comp);
  }
  if (inc("C")) step.kids.push(...pkgNodes);
  if (inc("A")) step.kids.push(...compNodes);
  // FOOTPRINT_COUNT goes at the start of the Step and the later padstacks follow it (m_last_padstack)
  const countAttr = inc("A") && refDesOut ? new X("NonstandardAttribute").a("name", "FOOTPRINT_COUNT").a("type", "INTEGER").a("value", m.footprints.length) : null;
  if (countAttr) stackList = featStacks;
  if (inc("G")) for (const [net, pins] of netPins) { const n = step.add("LogicalNet").a("name", netName(net)); for (const [c, p] of pins) { const r = n.add("PinRef"); if (!sup("PINREF_COMPONENTREF") && refDesOut) r.a("componentRef", c); r.a("pin", p); } }
  // the physical netlist (generatePhyNetGroup over FabTestPoints): every probe-able pad and via, pads first
  if (inc("Y")) {
    const shapeOf = (parent: X, p: Prim | null, unrot = 0): void => shapeRef(parent, p, unrot);
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
    interface NetPoint { x: number; y: number; layer: string; secondary: string | null; exposure: string; end: boolean; via: boolean; shape: Prim | null; rot: number }
    const byNet = new Map<string, NetPoint[]>();
    const exposure = (front: boolean, back: boolean, fm: boolean, bm: boolean): string => {
      const fo = !front || fm, bo = !back || bm;
      return fo && bo ? "EXPOSED" : bo ? "COVERED_PRIMARY" : fo ? "COVERED_SECONDARY" : "COVERED";
    };
    const push = (net: string, pt: NetPoint): void => { if (!byNet.has(net)) byNet.set(net, []); byNet.get(net)!.push(pt); };
    for (const fp of m.footprints) for (const p of fp.pads) {
      const front = p.layers.has("F.Cu"), back = p.layers.has("B.Cu");
      if (!p.net || (!front && !back)) continue;   // inner-only pads cannot be probed
      const layer = front ? "F.Cu" : "B.Cu", prims: Prim[] = [];
      padPrims(p, layer, m, prims);
      push(p.net, { x: p.x, y: p.y, layer, secondary: front && back ? "B.Cu" : null, exposure: exposure(front, back, p.layers.has("F.Mask"), p.layers.has("B.Mask")), end: true, via: false, shape: prims[0] || null, rot: p.rot });
    }
    for (const v of m.vias) {
      const front = v.layers.includes("F.Cu"), back = v.layers.includes("B.Cu");
      if (!v.net || (!front && !back)) continue;   // buried vias cannot be probed
      const tf = v.tentFront ?? m.settings.tentFront, tb = v.tentBack ?? m.settings.tentBack;
      // a via with more copper after it is a midpoint (GetConnectedItemsAtAnchor of tracks and arcs)
      const tracks = m.tracks.filter((t) => v.layers.includes(t.layer) && ((near(t.x1, v.x) && near(t.y1, v.y)) || (near(t.x2, v.x) && near(t.y2, v.y)))).length;
      const layer = front ? "F.Cu" : "B.Cu", d = (v.sizes && v.sizes.get(layer)) || v.size;
      push(v.net, { x: v.x, y: v.y, layer, secondary: front && back ? "B.Cu" : null, exposure: exposure(front, back, front && !tf, back && !tb), end: tracks < 2, via: true, shape: { k: "circle", x: v.x, y: v.y, d } as Prim, rot: 0 });
    }
    if (byNet.size) {
      const codes = new Map<string, number>(); const docNets = (m.doc as unknown as { nets?: Map<number, string> }).nets;
      if (docNets) for (const [c, n] of docNets) if (!codes.has(n)) codes.set(n, c);
      const order = [...byNet.keys()].sort((a, b) => (codes.get(a) ?? 1e9) - (codes.get(b) ?? 1e9) || (a < b ? -1 : a > b ? 1 : 0));
      const group = step.add("PhyNetGroup").a("name", "NETS");
      for (const net of order) {
        // NetKey is one key for LogicalNet@name and PhyNet@name, so the physical net takes a suffix
        const pn = group.add("PhyNet").a("name", o.anonymizeNets ? (anon.get(net) || "NET_0") + "_PHY" : gen(net + "_PHY", "NET"));
        for (const pt of byNet.get(net)!) {
          const n = xy(pn.add("PhyNetPoint"), pt.x, pt.y).a("layerRef", layerName(pt.layer));
          if (pt.secondary) n.a("secondaryLayerRef", layerName(pt.secondary));
          n.a("netNode", pt.end ? "END" : "MIDDLE").a("exposure", pt.exposure);
          if (pt.via) n.a("via", "true");
          shapeOf(n, pt.shape, pt.rot);
        }
      }
    }
  }
  // layer features (generateLayerFeatures / generateLayerSetNet)
  const log = new PlotLog();
  const padSet = new Set<unknown>(), viaSet = new Set<unknown>(m.vias), trackSet = new Set<unknown>(m.tracks), fillSet = new Set<unknown>(m.fills);
  for (const fp of m.footprints) for (const p of fp.pads) padSet.add(p);
  const netOfSrc = (s: unknown): string => (padSet.has(s) ? (s as Pad).net : viaSet.has(s) ? (s as Via).net : trackSet.has(s) ? (s as Track).net || "" : fillSet.has(s) ? (s as ZoneFill).net || "" : "");
  for (const l of enabled) {
    if (!layerIncluded(l) || l === "Edge.Cuts") continue;
    const lf = new X("LayerFeature").a("layerRef", layerName(l));
    const sets = new Map<string, { set: X; feats: X | null; pads: X | null }>();
    const setFor = (net: string, kind: "f" | "p"): X => {
      let s = sets.get(net);
      if (!s) { const set = lf.add("Set"); if (net && isCopper(l)) set.a("net", netName(net)); s = { set, feats: null, pads: null }; sets.set(net, s); }
      if (kind === "f") { if (!s.feats) s.feats = s.set.add("Features").add("UserSpecial"); return s.feats; }
      return s.set;
    };
    for (const p of plotLayer(m, l, { plotReference: true, plotValue: true, subtractMaskFromSilk: false }, log, conn)) {
      if (p.clear) continue;
      const src = p.meta ? p.meta.src : undefined, net = isCopper(l) ? netOfSrc(src) : "";
      if (src && (padSet.has(src) || viaSet.has(src)) && (p.k === "circle" || p.k === "rect" || p.k === "oval" || p.k === "roundrect")) {
        const set = setFor(net, "p"); const pd = set.add("Pad");
        // addPad / addVia: the padstack first (padstackDefRef), then the rotation, location and shape
        const stackName = padSet.has(src) ? padStack(src as Pad) : viaStack(src as Via);
        if (!sup("PAD_PADSTACKDEFREF")) pd.a("padstackDefRef", stackName);
        const deg = p.k === "circle" ? 0 : p.rot; if (deg) pd.add("Xform").a("rotation", fv(norm360(deg) / scale));
        xy(pd.add("Location"), p.x, p.y); stdRef(pd, p);
        if (padSet.has(src)) { const pad = src as Pad, pr = pd.add("PinRef"); if (!sup("PINREF_COMPONENTREF") && refDesOut) pr.a("componentRef", cmpName(pad.fp)); pr.a("pin", pinName(pad)); }
        else if (!set.attrs.some(([k]) => k === "padUsage")) set.a("padUsage", "VIA");
        continue;
      }
      feature(setFor(net, "f"), p);
    }
    if (lf.kids.length) step.kids.push(lf);
  }
  for (const w of log.messages) warnings.push(w);
  if (inc("R")) {
    let n = 1;
    for (const [k, hs] of drillSpans) {
      const lf = step.add("LayerFeature").a("layerRef", spanName(k, "DRILL"));
      for (const h of hs) { const s = lf.add("Set"); if (h.net) s.a("net", netName(h.net)); xy(s.add("Hole").a("name", `H${n++}`).a("diameter", fv(h.d)).a("platingStatus", h.plated).a("plusTol", "0.0").a("minusTol", "0.0"), h.x, h.y); }
    }
    n = 1;
    for (const [k, hs] of slotSpans) {
      const lf = step.add("LayerFeature").a("layerRef", spanName(k, "SLOT"));
      for (const h of hs) {
        const s = lf.add("Set"); if (h.net) s.a("net", netName(h.net));
        const sc = s.add("SlotCavity").a("name", `SLOT${n++}`).a("platingStatus", h.plated === "PLATED" ? "PLATED" : "NONPLATED").a("plusTol", "0.0").a("minusTol", "0.0");
        xy(sc.add("Location"), h.x, h.y); if (h.slot!.rot) sc.add("Xform").a("rotation", fv(norm360(h.slot!.rot) / scale));
        sc.add("Oval").a("width", fv(h.slot!.w)).a("height", fv(h.slot!.h));
      }
    }
  }
  // the Step starts with FOOTPRINT_COUNT and the padstacks met after it, then those of the packages (insertNode /
  // insertNodeAfter( m_last_padstack ))
  step.kids.unshift(...(countAttr ? [countAttr] : []), ...(inc("K") ? featStacks : []), ...(inc("K") ? pkgStacks : []));
  const haveLayer = cad.kids.some((k) => k.name === "Layer");
  if (!needsCad || !haveLayer) { ecad.kids = ecad.kids.filter((k) => k !== cad); content.kids = content.kids.filter((k) => k.name !== "StepRef"); }
  else { const refs = cad.kids.filter((k) => k.name === "Layer").map((k) => new X("LayerRef").a("name", k.attrs[0][1])); for (const r of refs) content.insert(r, (k) => k.name.startsWith("Dictionary")); }

  // ---- Bom (generateBOMSection), inserted before Ecad
  if (inc("B")) {
    interface Entry { oem: string; count: number; pads: number; type: string; desc: string; refs: { name: string; pkg: string; populate: boolean; layer: string }[]; props: Map<string, string> }
    const entries = new Map<string, Entry>();
    for (const fp of m.footprints) {
      const oem = gen(oemOf.get(fp) || "", "REF");
      let e = entries.get(oem);
      if (!e) { e = { oem, count: 0, pads: fp.pads.length, type: fp.pads.length === 0 || fp.excludeFromBom ? "DOCUMENT" : "ELECTRICAL", desc: fp.props.get("Description") || "", refs: [], props: new Map() }; entries.set(oem, e); }
      e.count++;
      e.refs.push({ name: cmpName(fp), pkg: pkgOf.get(fp) || "", populate: !fp.dnp && !fp.excludeFromBom, layer: layerName(fp.side) });
      for (const [k, v] of fp.props) if (k !== "Reference" && k !== "Datasheet" && k !== "Description" && k !== "Footprint") e.props.set(k, v);
      const map: [string, string][] = [[o.mpn, "MPN"], [o.mfg, "Manufacturer"], [o.distPn, "Distributor P/N"]];
      for (const [col, label] of map) if (col && fp.props.get(col)) e.props.set(label, fp.props.get(col)!);
      if (o.dist && o.dist !== "N/A") e.props.set("Distributor", o.dist);
    }
    if (entries.size) {
      const bom = new X("Bom").a("name", gen(o.boardName, "BOM"));
      const hd = bom.add("BomHeader").a("revision", o.bomRev || (m.doc.titleBlock && m.doc.titleBlock.rev) || "1.0").a("assembly", gen(o.boardName));
      if (needsCad && haveLayer) hd.add("StepRef").a("name", stepName);
      for (const e of [...entries.values()].sort((a, b) => (a.oem < b.oem ? -1 : a.oem > b.oem ? 1 : 0))) {
        const it = bom.add("BomItem").a("OEMDesignNumberRef", e.oem).a("quantity", e.count).a("pinCount", e.pads).a("category", e.type);
        if (e.desc) it.a("description", e.desc);
        if (!sup("BOM_REFDES") && refDesOut) for (const r of e.refs) { const rn = it.add("RefDes").a("name", r.name); if (!sup("BOM_REFDES_PACKAGEREF") && r.pkg) rn.a("packageRef", r.pkg); rn.a("populate", r.populate ? "true" : "false"); if (!sup("BOM_REFDES_LAYERREF")) rn.a("layerRef", r.layer); }
        const ch = it.add("Characteristics").a("category", e.type);
        for (const [k, v] of e.props) ch.add("Textual").a("definitionSource", "KICAD").a("textualCharacteristicName", k).a("textualCharacteristicValue", v);
      }
      root.insert(bom, (k) => k === ecad);
      content.insert(new X("BomRef").a("name", bom.attrs[0][1]), (k) => k.name.startsWith("Dictionary"));
    }
  }
  if (!ecad.kids.some((k) => k.name === "CadData") && !inc("S") && !inc("E")) { /* the CadHeader alone stays: Ecad needs it */ }
  // the sectionKey names what the file carries (emittedSections): B only with a Bom, Y only with a PhyNetGroup
  const has = (name: string): boolean => { const walk = (x: X): boolean => x.name === name || x.kids.some(walk); return walk(root); };
  const emitted = new Set([...res.included].filter((k) => (k !== "B" || root.kids.some((x) => x.name === "Bom")) && (k !== "Y" || has("PhyNetGroup"))));
  fm.a("sectionKey", sectionKeyString(emitted));
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>']; root.write(0, out);
  return { xml: out.join("\n") + "\n", warnings, errors };
}
