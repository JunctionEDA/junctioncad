// pcb-tools/fp-diff.ts — the report FOOTPRINT::FootprintNeedsUpdate( aLibFP, 0, aReporter ) writes
// (pcbnew/drc/drc_test_provider_library_parity.cpp) for BOARD_INSPECTION_TOOL::DiffFootprint (Inspect > Compare
// Footprint with Library): the board footprint, normalised the way a library load is (editableCopy: at the origin,
// on the front, unrotated), against the library's.  Footprint type and attributes, board-level overrides, net tie
// groups, the graphic shapes (sorted, as FOOTPRINT::cmp_drawings does, so their order aside) and the pads (by
// number and position, FOOTPRINT::cmp_pads) with padNeedsUpdate's per-pad lines.  Texts are left out, as KiCad does.
import { K } from "./state";
import { editableCopy } from "./exchange";
import { isList } from "./util";

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const kidText = (n: SNode, key: string) => { const k = K.kid(n, key); return k ? K.serialize(k) : ""; };
const flags = (n: SNode) => new Set((K.kid(n, "attr") || []).slice(1).map(str));
const fpType = (f: Set<string>) => (f.has("smd") ? "smd" : f.has("through_hole") ? "through_hole" : "");
const near = (a: number, b: number) => Math.abs(a - b) < 5e-7;
const nums = (n: SNode | null): number[] => (n ? n.slice(1).filter((x) => typeof x === "number") as number[] : []);
const sameNums = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => near(x, b[i]));
const SHAPES = ["fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve"];
const SHAPE_NAME: Record<string, string> = { fp_line: "Line", fp_rect: "Rectangle", fp_circle: "Circle", fp_arc: "Arc", fp_poly: "Polygon", fp_curve: "Bezier" };

/** A shape as text without its uuid (and without the locked flag), the key cmp_drawings sorts on. */
function shapeKey(n: SNode): string { return K.serialize(n.filter((c) => !(isList(c) && (c[0] === "uuid" || c[0] === "tstamp" || c[0] === "locked")))); }
/** PCB_SHAPE::GetItemDescription: "<Shape> on <layer>". */
function shapeDesc(n: SNode): string { return `${SHAPE_NAME[str(n[0])] || "Graphic"} on ${str((K.kid(n, "layer") || [])[1])}`; }
const padNum = (p: SNode) => str(p[1]);
const padAt = (p: SNode): number[] => { const a = K.kid(p, "at"); return a ? [K.num(a[1]), K.num(a[2]), a.length > 3 ? K.num(a[3]) : 0] : [0, 0, 0]; };
/** FOOTPRINT::cmp_pads: by number, then position. */
function cmpPads(a: SNode, b: SNode): number {
  const na = padNum(a), nb = padNum(b);
  if (na !== nb) return na.localeCompare(nb, undefined, { numeric: true });
  const pa = padAt(a), pb = padAt(b);
  return pa[0] - pb[0] || pa[1] - pb[1];
}
const OVERRIDES: [string, string][] = [["clearance", "Pad clearance overridden."], ["solder_mask_margin", "Solder mask expansion overridden."],
  ["solder_paste_margin", "Solder paste absolute clearance overridden."], ["solder_paste_margin_ratio", "Solder paste relative clearance overridden."], ["zone_connect", "Zone connection overridden."]];
const PAD_OVERRIDES: [string, string][] = [["clearance", "%s has clearance override."], ["solder_mask_margin", "%s has solder mask expansion override."],
  ["solder_paste_margin", "%s has solder paste clearance override."], ["solder_paste_margin_ratio", "%s has solder paste clearance override."], ["zone_connect", "%s has zone connection override."],
  ["thermal_gap", "%s has thermal relief gap override."], ["thermal_bridge_width", "%s has thermal relief spoke width override."], ["thermal_bridge_angle", "%s has thermal relief spoke angle override."]];
const ATTR_FLAGS: [string, string][] = [["board_only", "Not in schematic"], ["exclude_from_pos_files", "Exclude from position files"], ["exclude_from_bom", "Exclude from bill of materials"],
  ["exclude_from_sim", "Exclude from simulation"], ["dnp", "Do not populate"]];

/** padNeedsUpdate (and, when it finds nothing, padHasOverrides): its report lines for one pad pair. */
function padLines(a: SNode, b: SNode): string[] {
  const out: string[] = [], D = `Pad ${padNum(a)}`, first = (n: SNode) => str((K.kid(n, "layers") || [])[1]) || "F.Cu";
  const pa = padAt(a), pb = padAt(b);
  if (!near(pa[0], pb[0]) || !near(pa[1], pb[1])) out.push(`${D} position differs.`);
  if (padNum(a) !== padNum(b)) out.push(`${D} has different numbers.`);
  if (kidText(a, "die_length") !== kidText(b, "die_length")) out.push(`${D} pad to die length differs.`);
  if (kidText(a, "layers") !== kidText(b, "layers")) out.push(`${D} layers differ.`);
  if (str(a[2]) !== str(b[2])) out.push(`${D} pad type differs.`);
  if (kidText(a, "property") !== kidText(b, "property")) out.push(`${D} fabrication property differs.`);
  if (!near(pa[2], pb[2])) out.push(`${D} orientation differs.`);
  const layer = first(a);
  if (str(a[3]) !== str(b[3])) out.push(`${D} pad shape type differs on layer ${layer}.`);
  if (!sameNums(nums(K.kid(a, "size")), nums(K.kid(b, "size")))) out.push(`${D} size differs on layer ${layer}.`);
  if (kidText(a, "rect_delta") !== kidText(b, "rect_delta")) out.push(`${D} trapezoid delta differs on layer ${layer}.`);
  if (kidText(a, "roundrect_rratio") !== kidText(b, "roundrect_rratio")) out.push(`${D} rounded corners differ on layer ${layer}.`);
  if (kidText(a, "chamfer_ratio") !== kidText(b, "chamfer_ratio")) out.push(`${D} chamfered corner sizes differ on layer ${layer}.`);
  if (kidText(a, "chamfer") !== kidText(b, "chamfer")) out.push(`${D} chamfered corners differ on layer ${layer}.`);
  const da = K.kid(a, "drill"), db = K.kid(b, "drill");
  const off = (d: SNode | null) => (d ? kidText(d, "offset") : "");
  if (off(da) !== off(db)) out.push(`${D} shape offset from hole differs on layer ${layer}.`);
  const oval = (d: SNode | null) => !!d && d.includes("oval");
  if (oval(da) !== oval(db)) out.push(`${D} drill shape differs.`);
  if (!sameNums(nums(da), nums(db))) out.push(`${D} drill size differs.`);
  if (kidText(a, "primitives") !== kidText(b, "primitives")) out.push(`${D} shape primitives differ on layer ${layer}.`);
  if (out.length) return out;
  for (const [k, msg] of PAD_OVERRIDES) if (K.kid(a, k) && kidText(a, k) !== kidText(b, k)) out.push(msg.replace("%s", D));
  return out;
}

/** The lines FootprintNeedsUpdate reports, in its order; empty when there are no relevant differences. */
export function footprintDiffLines(boardFp: SNode, libFp: SNode): string[] {
  const a = editableCopy(boardFp).node, b = libFp, out: string[] = [];
  const fa = flags(a), fb = flags(b);
  if (fpType(fa) !== fpType(fb)) out.push("Footprint types differ.");
  if (fa.has("allow_soldermask_bridges") !== fb.has("allow_soldermask_bridges")) out.push("'Allow bridged solder mask apertures between pads' settings differ.");
  for (const [k, l] of ATTR_FLAGS) if (fa.has(k) !== fb.has(k)) out.push(`'${l}' settings differ.`);
  if (kidText(a, "stackup") !== kidText(b, "stackup")) out.push("Footprint stackup differs.");
  for (const [k, msg] of OVERRIDES) if (K.kid(a, k) && kidText(a, k) !== kidText(b, k)) out.push(msg);
  if (kidText(a, "net_tie_pad_groups") !== kidText(b, "net_tie_pad_groups")) out.push("Net tie pad groups differ.");
  const shapes = (n: SNode) => (n.filter((c) => isList(c) && SHAPES.includes(str(c[0]))) as SNode[]).map((c) => ({ n: c, k: shapeKey(c) })).sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0));
  const sa = shapes(a), sb = shapes(b);
  if (sa.length !== sb.length) out.push("Graphic item count differs.");
  else sa.forEach((s, i) => { if (s.k !== sb[i].k) out.push(`${shapeDesc(s.n)} differs.`); });
  const bar = (n: SNode) => n.filter((c) => isList(c) && c[0] === "barcode") as SNode[];
  const ba = bar(a).map(shapeKey).sort(), bb = bar(b).map(shapeKey).sort();
  if (ba.length !== bb.length) out.push("Barcode count differs.");
  else ba.forEach((k, i) => { if (k !== bb[i]) out.push("Barcode differs."); });
  const pads = (n: SNode) => (n.filter((c) => isList(c) && c[0] === "pad") as SNode[]).sort(cmpPads);
  const pa = pads(a), pb = pads(b);
  if (pa.length !== pb.length) out.push("Pad count differs.");
  else pa.forEach((p, i) => out.push(...padLines(p, pb[i])));
  const zones = (n: SNode) => (n.filter((c) => isList(c) && c[0] === "zone") as SNode[]).map(shapeKey).sort();
  const za = zones(a), zb = zones(b);
  if (za.length !== zb.length) out.push("Rule area count differs.");
  else za.forEach((k, i) => { if (k !== zb[i]) out.push("Rule area differs."); });
  return out;
}
