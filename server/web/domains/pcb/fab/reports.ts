// web/domains/pcb/fab/reports — the small text outputs of File > Export and File > Fabrication Outputs:
//  - the footprint association file .cmp (RecreateCmpFile, pcbnew/exporters/export_footprint_associations.cpp)
//  - the legacy BOM .csv (BOARD_EDITOR_CONTROL::GenBOMFileFromBoard, pcbnew/build_BOM_from_board.cpp)
//  - the footprint report .rpt (PLACE_FILE_EXPORTER::GenReportData, pcbnew/exporters/place_file_exporter.cpp)
//  - the IPC-D-356A netlist .d356 (IPC356D_WRITER, pcbnew/exporters/export_d356.cpp with FabTestPoints)
import { kid, str } from "../canvas/sexpr";
import { type BoardModel, type Footprint, type Pad, padShapeOn } from "./model";
import { refCompare } from "./parts";

const isoNow = (d: Date): string => { const p = (n: number): string => String(Math.abs(n)).padStart(2, "0"); const off = -d.getTimezoneOffset(); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`; };
/** StrNumCmp( …, CMP_T::IGNORE_CASE ) */
const strNum = (a: string, b: string): number => refCompare(a.toUpperCase(), b.toUpperCase());

/** RecreateCmpFile */
export function cmpFile(m: BoardModel, date: Date): string {
  let s = `Cmp-Mod V01 Created by PcbNew   date = ${isoNow(date)}\n`;
  for (const fp of m.footprints) {
    const path = kid(fp.node, "path") as SNode | null;
    s += `\nBeginCmp\nTimeStamp = ${fp.id}\nPath = ${path ? str(path[1]) : ""}\nReference = ${fp.ref || "[NoRef]"};\nValeurCmp = ${fp.value || "[NoVal]"};\nIdModule  = ${fp.lib};\nEndCmp\n`;
  }
  return s + "\nEndListe\n";
}

/** GenBOMFileFromBoard: one row per value and footprint, the references sorted, the rows by their first reference */
export function legacyBom(m: BoardModel): string | null {
  if (!m.footprints.length) return null;
  const list: { refs: string[]; val: string; fpid: string; name: string; count: number }[] = [];
  for (const fp of m.footprints) {
    if (fp.excludeFromBom) continue;
    const e = list.find((x) => x.val === fp.value && x.fpid === fp.lib);
    if (e) { e.refs.push(fp.ref); e.count++; } else list.push({ refs: [fp.ref], val: fp.value, fpid: fp.lib, name: fp.name, count: 1 });
  }
  for (const e of list) e.refs.sort(strNum);
  list.sort((a, b) => strNum(a.refs[0], b.refs[0]));
  let s = '"Id";"Designator";"Footprint";"Quantity";"Designation";"Supplier and ref";\n';
  list.forEach((e, i) => { s += `${i + 1};"${e.refs.join(", ")}";"${e.name}";${e.count};"${e.val}";;;\n`; });
  return s;
}

const LEGACY_SHAPE: Record<string, string> = { circle: "Circle", oval: "Oval", rect: "Rect", trapezoid: "Trap", roundrect: "Roundrect", chamfer: "Chamferedrect", custom: "CustomShape" };
const f96 = (v: number): string => { const s = v.toFixed(6); return s.length >= 9 ? s : s.padStart(9, " "); };
/** PLACE_FILE_EXPORTER::GenReportData (units mm or inches, the place offset 0) */
export function footprintReport(m: BoardModel, o: { mm: boolean; date: Date; version: string; bbox: [number, number] }): string {
  const k = o.mm ? 1 : 1 / 25.4;
  let s = `## Footprint report - date ${isoNow(o.date)}\n## Printed by KiCad version ${o.version}\n${o.mm ? "## Unit = mm, Angle = deg.\n" : "## Unit = inches, Angle = deg.\n"}\n$BeginDESCRIPTION\n`;
  s += `\n$BOARD\nupper_left_corner ${f96(o.bbox[0] * k)} ${f96(o.bbox[1] * k)}\n$EndBOARD\n\n`;
  const fps = [...m.footprints].sort((a, b) => strNum(a.ref, b.ref));
  for (const fp of fps) {
    s += `$MODULE ${fp.ref}\nreference ${fp.ref}\nvalue ${fp.value}\nfootprint ${fp.lib}\nattribut`;
    if (!fp.smd && !fp.throughHole) s += " virtual"; if (fp.smd) s += " smd"; if (fp.throughHole) s += " none";
    s += `\nposition ${f96(fp.x * k)} ${f96(fp.y * k)}  orientation ${fp.rot.toFixed(2)}\n`;
    s += fp.side === "F.Cu" ? "layer front\n" : fp.side === "B.Cu" ? "layer back\n" : "layer other\n";
    for (const p of [...fp.pads].sort((a, b) => strNum(a.number, b.number))) {
      const lay = (p.layers.has("B.Cu") || p.layers.has("*.Cu") ? 1 : 0) | (p.layers.has("F.Cu") || p.layers.has("*.Cu") ? 2 : 0);
      s += `$PAD "${p.number}"\nShape ${LEGACY_SHAPE[p.base.shape] || "???"} Layer ${["nocopper", "back", "front", "both"][lay]}\n`;
      const at = kid(p.node, "at") as SNode | null; const lx = at ? Number(at[1]) || 0 : 0, ly = at ? Number(at[2]) || 0 : 0;
      s += `position ${f96(lx * k)} ${f96(ly * k)} size ${f96(p.base.w * k)} ${f96(p.base.h * k)} orientation ${p.rot.toFixed(2)}\n`;
      s += `drill ${f96((p.drill ? p.drill.w : 0) * k)}\nshape_offset ${f96(p.base.offset[0] * k)} ${f96(p.base.offset[1] * k)}\n$EndPAD\n`;
    }
    s += `$EndMODULE ${fp.ref}\n\n`;
  }
  return s + "$EndDESCRIPTION\n";
}

// ---------------------------------------------------------------- IPC-D-356A
interface D356 { netname: string; refdes: string; pin: string; midpoint: boolean; drill: number; hole: boolean; smd: boolean; mechanical: boolean; access: number; start: number; end: number; x: number; y: number; w: number; h: number; rot: number; mask: number }
/** iu_to_d356: decimils, clamped */
const dm = (mm: number, clamp: number): number => { const v = Math.round(mm / 0.00254); return Math.max(-clamp, Math.min(clamp, v)); };
const sanitize = (n: string, upper: boolean): string => [...n].map((c) => { const code = c.codePointAt(0) || 0; if (code > 126 || code <= 32) return "?"; return upper && c >= "a" && c <= "z" ? c.toUpperCase() : c; }).join("");
const alias = (i: number): string => { const d = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; let a = "M"; for (let div = 36 * 36 * 36; div > 0; div = Math.floor(div / 36)) a += d[Math.floor(i / div) % 36]; return a; };
const pad = (s: string, n: number, right = false): string => { const t = s.slice(0, n); return right ? t.padStart(n, " ") : t.padEnd(n, " "); };
const signed = (v: number, w: number): string => (v < 0 ? "-" : "+") + String(Math.abs(v)).padStart(w - 1, "0");
const z = (v: number, w: number): string => String(v).padStart(w, "0");

/** IPC356D_WRITER::Write */
export function d356(m: BoardModel, o: { job: string; auxOrigin: [number, number]; skipUnconnected: boolean }): string {
  const n = m.copper.length, phys = (l: string): number => (l === "B.Cu" ? n : m.copper.indexOf(l) + 1);
  const [ox, oy] = o.auxOrigin, recs: D356[] = [];
  for (const v of m.vias) {
    const top = v.layers[0], bot = v.layers[v.layers.length - 1];
    const access = top === "F.Cu" && bot === "B.Cu" ? 0 : top === "F.Cu" ? 1 : bot === "B.Cu" ? n : phys(top);
    const w = (l: string): number => (v.sizes && v.sizes.get(l)) || v.size;
    const size = access === 1 ? w("F.Cu") : access === n ? w("B.Cu") : v.sizes ? Math.min(w("F.Cu"), w("B.Cu")) : w("F.Cu");
    recs.push({ netname: v.net, refdes: "VIA", pin: "", midpoint: true, drill: v.drill, hole: true, smd: false, mechanical: false, access, start: access ? phys(top) : 0, end: access ? phys(bot) : 0,
      x: v.x - ox, y: oy - v.y, w: size, h: 0, rot: 0, mask: (v.tentFront !== false ? 1 : 0) | (v.tentBack !== false ? 2 : 0) });
  }
  const cuOf = (p: Pad): string[] => m.copper.filter((l) => p.layers.has(l) || p.layers.has("*.Cu") || (l === "F.Cu" && p.layers.has("F&B.Cu")) || (l === "B.Cu" && p.layers.has("F&B.Cu")));
  for (const fp of m.footprints) for (const p of fp.pads) {
    const cu = cuOf(p); if (!cu.length) continue;
    const access = cu.includes("F.Cu") && cu.includes("B.Cu") ? 0 : cu.includes("F.Cu") ? 1 : cu.includes("B.Cu") ? n : phys(cu[0]);
    if (o.skipUnconnected && !p.net) continue;
    const side = fp.side === "B.Cu" ? "B.Cu" : "F.Cu", sh = padShapeOn(p, side, m.copper);
    let rot = Math.round(-p.rot); if (rot < 0) rot += 360;
    const fm = p.layers.has("F.Mask") || p.layers.has("*.Mask"), bm = p.layers.has("B.Mask") || p.layers.has("*.Mask");
    recs.push({ netname: p.net, refdes: fp.ref, pin: p.number, midpoint: !p.number, drill: p.drill ? Math.min(p.drill.w, p.drill.h) : 0, hole: !!p.drill && p.drill.w > 0,
      smd: p.type === "smd" || p.type === "connect", mechanical: p.type === "np_thru_hole", access, start: 0, end: 0,
      x: p.x - ox, y: oy - p.y, w: sh.w, h: sh.shape === "circle" ? 0 : sh.h, rot, mask: 3 & ~(fm ? 1 : 0) & ~(bm ? 2 : 0) });
  }
  const line = (s: string): string => s.slice(0, 72).padEnd(80, " ").slice(0, 80) + "\n";
  let out = line(`P  JOB   ${o.job}`) + line("P  CODE  00") + line("P  UNITS CUST 0") + line("P  arrayDim   N") + line("P  VER   IPC-D-356A") + line("P  IMAGE PRIMARY");
  // write_D356_records: the net names (upper case, at most 14) or M-aliases declared by NNAME records
  const NC = "N/C", map = new Map<string, string>(), taken = new Set<string>([NC]), canonCount = new Map<string, number>();
  for (const r of recs) if (r.netname && !map.has(r.netname)) { map.set(r.netname, ""); const c = sanitize(r.netname, true); canonCount.set(c, (canonCount.get(c) || 0) + 1); }
  for (const c of canonCount.keys()) taken.add(c);
  const names = [...map.keys()].sort();
  for (const nm of names) { const c = sanitize(nm, true); if (c.length <= 14 && c !== NC && canonCount.get(c) === 1) map.set(nm, c); }
  let ai = 0;
  for (const nm of names) {
    if (map.get(nm)) continue;
    let c: string; do { c = alias(ai++); } while (taken.has(c)); taken.add(c); map.set(nm, c);
    out += `P  NNAME${pad(c, 5)} ${pad(sanitize(nm, false).slice(-58), 66)}\n`;
  }
  const sig = (r: D356): string => (r.netname ? map.get(r.netname)! : NC);
  const sorted = recs.map((r, i) => ({ r, i })).sort((a, b) => (sig(a.r) < sig(b.r) ? -1 : sig(a.r) > sig(b.r) ? 1 : a.i - b.i)).map((x) => x.r);
  for (const r of sorted) {
    const net = sig(r), bb = r.start !== 0;
    const type = r.smd ? 327 : r.mechanical ? 367 : bb ? 307 : 317;
    const comp = (op: number, mid: boolean): string => `${z(op, 3)}${pad(net, 14)}   ${pad(r.refdes, 6)}${r.pin ? "-" : " "}${pad(r.pin, 4)}${mid ? "M" : " "}`;
    const acc = (): string => `A${z(r.access, 2)}X${signed(dm(r.x, 999999), 7)}Y${signed(dm(r.y, 999999), 7)}X${z(dm(r.w, 9999), 4)}Y${z(dm(r.h, 9999), 4)}R${z(r.rot, 3)}`;
    let s = comp(type, r.midpoint) + (r.hole ? `D${z(dm(r.drill, 9999), 4)}${r.mechanical ? "U" : "P"}` : "      ");
    s += bb ? `A${z(r.access, 2)}X${signed(dm(r.x, 999999), 7)}Y${signed(dm(r.y, 999999), 7)}${"".padStart(14, " ")}` : acc();
    s += ` S${r.mask}` + (bb ? `L${z(r.start, 2)}L${z(r.end, 2)}\n` : "      \n");
    if (bb && (r.start === 1 || r.end === n)) s += comp(27, false) + "      " + acc() + ` S${r.mask}      \n`;
    out += s;
  }
  return out + line("999");
}
export type { Footprint };
