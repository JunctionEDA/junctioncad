// pcb-tools/drc.ts — design settings and the DRC subset.
import { copperCtx, sliverMarkers } from "./drc-sliver";
import { connectionWidthMarkers } from "./drc-connwidth";
import type { Box, Conductor, CopperShape, DesignSettings, DesignSource, DrcMarker, NetclassRules, BoardDoc, PolyShape, Pt } from "./types";
import { arcPoints, boxGrid, boxesTouch, firstEdgeConflict, polysOverlap, shapeBBox, shapeGap, shareLayer } from "./distances";
import { pointInPoly } from "./hit";
import { netlist, ratsnest } from "./netlist";
import { K } from "./state";
import { boardElements } from "./drc-silk";
import { DRC_EPS, EPS } from "./transforms";
import { isList, layerDefaults, layerOf, pt, r6, rotator, widthOf } from "./util";
import { evalRuleConstraint, parseDru, ruleClearance } from "./dru";
import { assertionMarkers, disallowMarkers, ruleItems, sizeMarkers, trackAngleMarkers } from "./drc-rules";
import type { DruRule } from "./dru";
import { moreDrcMarkers } from "./drc-more";
import { matchDpSuffix } from "./diffpair";
import { silkMaskMarkers } from "./drc-silk";
import { isolatedCopperMarkers, starvedThermalMarkers } from "./drc-zones";
import { unflashedLayers } from "./drc-flash";

// ---------------------------------------------------------------- design settings and DRC
// BOARD_DESIGN_SETTINGS / NETCLASS defaults (board_design_settings.h, netclass.cpp): what a board without a
// project file is checked against.  Rules can come from the .kicad_pro (parsed JSON) or a legacy board's (setup).
// The Board Setup > Constraints minimums are the implicit "board setup constraints" rules (DRC_ENGINE::loadImplicitRules),
// so a project that leaves one out is checked against BOARD_DESIGN_SETTINGS' default (board_design_settings_defaults.h).
export const DEFAULT_SETTINGS = (): DesignSettings => ({ clearance: 0.2, edgeClearance: 0.5, trackWidth: 0.2, viaDiameter: 0.6, viaDrill: 0.3,
  minClearance: 0, minConn: 0, minTrackWidth: 0.2, minViaDiameter: 0.5, minThroughDrill: 0.3, minMicroViaDiameter: 0.2, minMicroViaDrill: 0.1, minViaAnnular: (0.5 - 0.3) / 2,
  minHoleToHole: 0.25, holeClearance: 0.25, minSilkClearance: 0, minTextHeight: 1.0 * 0.8, minTextThickness: 0.1 * 0.8, minResolvedSpokes: 2, netclasses: { Default: { clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3 } }, netclassOf: {}, patterns: [], severities: {} });
export function designSettings(src: string | DesignSource | DesignSettings | null | undefined): DesignSettings {
  const s = DEFAULT_SETTINGS(); if (!src) return s;
  if (typeof src === "string" && /^\s*\{/.test(src)) { try { src = JSON.parse(src) as DesignSource; } catch (e) { return s; } }   // the .kicad_pro as text (the editor's ctx.designSettings)
  if (typeof src === "string") {   // a legacy board's (setup … (net_class …)) block
    let tree: SNode | null = null; try { tree = K.parse(src); } catch (e) { return s; }
    const setup = tree && K.kid(tree, "setup"); if (setup) { for (const [key, prop] of [["clearance", "clearance"], ["trace_clearance", "clearance"], ["edge_clearance", "edgeClearance"], ["copper_edge_clearance", "edgeClearance"], ["trace_min", "minTrackWidth"], ["via_min_size", "minViaDiameter"], ["via_min_drill", "minThroughDrill"], ["trace_width", "trackWidth"], ["via_size", "viaDiameter"], ["via_drill", "viaDrill"]]) { const c = K.kid(setup, key); if (c) s[prop] = K.num(c[1], s[prop] as number); } }
    for (const nc of (tree ? K.kids(tree, "net_class") : [])) { const name = K.str(nc[1]); const e = s.netclasses[name] = Object.assign({}, s.netclasses.Default); for (const [key, prop] of [["clearance", "clearance"], ["trace_width", "track_width"], ["via_dia", "via_diameter"], ["via_drill", "via_drill"]]) { const c = K.kid(nc, key); if (c) e[prop] = K.num(c[1]); } for (const a of K.kids(nc, "add_net")) s.netclassOf[K.str(a[1])] = name; }
    if (s.netclasses.Default) { s.clearance = s.netclasses.Default.clearance; s.trackWidth = s.netclasses.Default.track_width; }
    return s;
  }
  if (src.netclasses || src.clearance !== undefined) return Object.assign(s, src as DesignSettings);   // already our shape
  src = src as DesignSource;
  const rules = src.board && src.board.design_settings && src.board.design_settings.rules;   // a .kicad_pro
  const sev = src.board && src.board.design_settings && src.board.design_settings.rule_severities; if (sev) for (const [k, v] of Object.entries(sev)) s.severities[k] = String(v);
  if (rules) {
    const take = (key: string, prop: string) => { const v = rules[key]; if (typeof v === "number") s[prop] = v; };   // absent: the default stays (?? default)
    for (const [key, prop] of [["min_clearance", "minClearance"], ["min_connection", "minConn"], ["min_track_width", "minTrackWidth"], ["min_via_diameter", "minViaDiameter"],
      ["min_through_hole_diameter", "minThroughDrill"], ["min_microvia_diameter", "minMicroViaDiameter"], ["min_microvia_drill", "minMicroViaDrill"], ["min_via_annular_width", "minViaAnnular"],
      ["min_hole_clearance", "holeClearance"], ["min_copper_edge_clearance", "edgeClearance"], ["min_hole_to_hole", "minHoleToHole"], ["min_text_height", "minTextHeight"],
      ["min_text_thickness", "minTextThickness"], ["min_silk_line_width", "minSilkLineWidth"], ["min_silk_clearance", "minSilkClearance"], ["solder_mask_to_copper_clearance", "maskToCopperClearance"], ["min_resolved_spokes", "minResolvedSpokes"]]) take(key, prop);
  }
  const dflt = src.board && src.board.design_settings && src.board.design_settings.defaults; if (dflt) layerDefaults(dflt);   // Board Setup > Text & Graphics > Defaults: what a new item gets
  const ns = src.net_settings;
  if (ns && isList(ns.classes)) {
    // a class that leaves a value out takes the Default class's (NETCLASS composite: fields unset in every assigned class come from Default)
    const classes = (ns.classes as (Partial<NetclassRules> & { name?: string } | null)[]).filter((c): c is Partial<NetclassRules> & { name: string } => !!c && !!c.name);
    const dc = classes.find((c) => c.name === "Default"); const num = (v: unknown): v is number => typeof v === "number";
    const base = { clearance: dc && num(dc.clearance) ? dc.clearance : s.clearance, track_width: dc && num(dc.track_width) ? dc.track_width : s.trackWidth, via_diameter: dc && num(dc.via_diameter) ? dc.via_diameter : s.viaDiameter, via_drill: dc && num(dc.via_drill) ? dc.via_drill : s.viaDrill };
    const dpGap = dc && num(dc.diff_pair_gap) ? dc.diff_pair_gap : undefined;
    for (const c of classes) s.netclasses[c.name] = { clearance: num(c.clearance) ? c.clearance : base.clearance, track_width: num(c.track_width) ? c.track_width : base.track_width, via_diameter: num(c.via_diameter) ? c.via_diameter : base.via_diameter, via_drill: num(c.via_drill) ? c.via_drill : base.via_drill,
      ...(num(c.diff_pair_gap) ? { diff_pair_gap: c.diff_pair_gap } : num(dpGap) ? { diff_pair_gap: dpGap } : {}),
      ...(typeof c.microvia_diameter === "number" ? { microvia_diameter: c.microvia_diameter } : {}), ...(typeof c.microvia_drill === "number" ? { microvia_drill: c.microvia_drill } : {}) };
    if (s.netclasses.Default) { s.clearance = s.netclasses.Default.clearance; s.trackWidth = s.netclasses.Default.track_width; s.viaDiameter = s.netclasses.Default.via_diameter; s.viaDrill = s.netclasses.Default.via_drill; }
    if (ns.netclass_assignments) for (const [net, cls] of Object.entries(ns.netclass_assignments)) s.netclassOf[net] = cls;
    if (isList(ns.netclass_patterns)) for (const p of ns.netclass_patterns as ({ pattern?: string; netclass: string } | null)[]) if (p && p.pattern) s.patterns.push({ re: new RegExp("^" + String(p.pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"), netclass: p.netclass });
  }
  return s;
}
export function netclassName(s: DesignSettings, net: string | null | undefined) { const name = net ? (s.netclassOf[net] || (s.patterns.find((p) => p.re.test(net)) || { netclass: undefined }).netclass) : null; return name && s.netclasses[name] ? name : "Default"; }
export function netclassOf(s: DesignSettings, net: string | null | undefined): Partial<NetclassRules> { return s.netclasses[netclassName(s, net)] || s.netclasses.Default || { clearance: s.clearance, track_width: s.trackWidth, via_diameter: s.viaDiameter, via_drill: s.viaDrill }; }
export const netClearance = (s: DesignSettings, net: string | null | undefined): number => { const nc = netclassOf(s, net); return nc && nc.clearance !== undefined ? nc.clearance : s.clearance; };
export const mm4 = (v: number) => v.toFixed(4) + " mm";
/** DRC_TEST_PROVIDER::formatMsg: when the two read the same at 4 places, both are written to the nanometre. */
export const mmPair = (need: number, actual: number): [string, string] => {
  const a = mm4(need), b = mm4(actual); if (a !== b) return [a, b];
  const fine = (v: number) => v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") + " mm"; return [fine(need), fine(actual)];
};
/** Edge.Cuts geometry as shapes (lines with their half width) and the polylines they form, board items and footprint drawings alike. */
export function edgeShapes(doc: BoardDoc, o?: { layer?: string; zeroWidth?: boolean }) {
  const shapes: CopperShape[] = [], chains: Pt[][] = [], nodes: SNode[] = []; const want = (o && o.layer) || "Edge.Cuts";
  const take = (kind: string, node: SNode, tf: (x: number, y: number) => Pt, layer: string) => {
    if (layer !== want) return; const before = shapes.length;
    const w = o && o.zeroWidth ? 0 : K.kid(node, "stroke") ? K.num((K.kid(K.kid(node, "stroke")!, "width") || [0, 0])[1]) : widthOf(node, 0);
    takeShape(kind, node, tf, w); for (let i = before; i < shapes.length; i++) nodes.push(node);
  };
  const takeShape = (kind: string, node: SNode, tf: (x: number, y: number) => Pt, w: number) => {
    const P = (key: string) => { const p = pt(node, key); return p ? tf(p[0], p[1]) : null; };
    if (kind === "line") { const a = P("start"), b = P("end"); if (a && b) { shapes.push({ t: "seg", a, b, r: w / 2 }); chains.push([a, b]); } }
    else if (kind === "rect") { const a = P("start"), b = P("end"); if (a && b) { const c = tf(pt(node, "start")![0], pt(node, "end")![1]), d = tf(pt(node, "end")![0], pt(node, "start")![1]); const pts = [a, d, b, c]; shapes.push({ t: "path", pts: pts.concat([a]), r: w / 2 }); chains.push(pts.concat([a])); } }
    else if (kind === "circle") { const c = P("center"), e = P("end"); if (c && e) { const r = Math.hypot(e[0] - c[0], e[1] - c[1]); const pts: Pt[] = []; for (let i = 0; i < 48; i++) pts.push([c[0] + r * Math.cos(i * Math.PI / 24), c[1] + r * Math.sin(i * Math.PI / 24)]); pts.push(pts[0].slice()); shapes.push({ t: "path", pts, r: w / 2 }); chains.push(pts); } }
    else if (kind === "arc") { const a = P("start"), m = P("mid"), b = P("end"); if (a && m && b) { const arc = K.arcFrom3(a, m, b); const pts = arc ? arcPoints(arc, a, b) : [a, b]; shapes.push({ t: "path", pts, r: w / 2 }); chains.push(pts); } }
    else if (kind === "poly") { const pts = K.ptsOf(node).map(([x, y]) => tf(x, y)); if (pts.length > 2) { shapes.push({ t: "path", pts: pts.concat([pts[0]]), r: w / 2 }); chains.push(pts.concat([pts[0]])); } }
    else if (kind === "curve") { const pts = K.bezierPts(K.ptsOf(node).map(([x, y]) => tf(x, y))); if (pts.length > 1) { shapes.push({ t: "path", pts, r: w / 2 }); chains.push(pts); } }
  };
  const id = (x: number, y: number) => [x, y]; const ids: string[] = [];
  for (const it of doc.items.values()) {
    const n = it.node; const before = shapes.length;
    if (/^gr_(line|rect|circle|arc|poly|curve)$/.test(it.kind)) take(it.kind.slice(3), n, id, layerOf(n, "Dwgs.User"));
    else if (it.kind === "footprint") { const [fx, fy, frot] = K.atOf(n); const R = rotator(frot); const tf = (x: number, y: number) => { const [dx, dy] = R(x, y); return [fx + dx, fy + dy]; }; for (const g of n) if (isList(g) && /^fp_(line|rect|circle|arc|poly|curve)$/.test(g[0] as string)) take((g[0] as string).slice(3), g, tf, layerOf(g, "F.SilkS")); }
    for (let i = before; i < shapes.length; i++) ids.push(it.id);
  }
  return { shapes, chains, ids, nodes };
}
/** Join open polylines end to end (0.01 mm) into closed loops; returns the loops and whether anything stayed open. */
export function chainLoops(chains: Pt[][], tol?: number) {
  tol = tol || 0.01; const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= tol! && Math.abs(a[1] - b[1]) <= tol!;
  // a zero-length line (a stray dot in a library footprint) joins nothing and ends nothing: KiCad's chaining walks through it
  const loops: Pt[][] = [], open = chains.filter((c) => c.some((q) => !same(q, c[0]))).map((c) => c.slice()); let dangling = false;
  while (open.length) {
    let cur = open.pop()!; if (cur.length > 2 && same(cur[0], cur[cur.length - 1])) { loops.push(cur.slice(0, -1)); continue; }
    let grew = true;
    while (grew && !same(cur[0], cur[cur.length - 1])) {
      grew = false; const tail = cur[cur.length - 1];
      for (let i = 0; i < open.length; i++) {
        const c = open[i]; if (same(c[0], tail)) { cur = cur.concat(c.slice(1)); open.splice(i, 1); grew = true; break; }
        if (same(c[c.length - 1], tail)) { cur = cur.concat(c.slice(0, -1).reverse()); open.splice(i, 1); grew = true; break; }
      }
    }
    if (cur.length > 2 && same(cur[0], cur[cur.length - 1])) loops.push(cur.slice(0, -1)); else dangling = true;
  }
  return { loops, dangling };
}
export const polyArea = (pts: Pt[]) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
/** The board outline: the largest closed Edge.Cuts loop, or null (and whether edges exist that fail to close). */
export function boardOutline(doc: BoardDoc) {
  const { chains } = edgeShapes(doc); if (!chains.length) return { outline: null, dangling: false, hasEdges: false };
  const { loops, dangling } = chainLoops(chains); let best: Pt[] | null = null, bestA = 0;
  for (const l of loops) { const a = Math.abs(polyArea(l)); if (a > bestA) { bestA = a; best = l; } }
  return { outline: best, dangling, hasEdges: true, area: bestA };
}
/** A simple polygon moved inward by `d` (mitred corners; CHAMFER_ACUTE_CORNERS differs only at sharp spikes). */
export function deflatePoly(P: Pt[], d: number): Pt[] {
  const n = P.length; if (n < 3) return P;
  let a2 = 0; for (let i = 0; i < n; i++) { const p = P[i], q = P[(i + 1) % n]; a2 += p[0] * q[1] - q[0] * p[1]; }
  const sg = a2 > 0 ? 1 : -1; const out: Pt[] = [];
  // each edge's inward normal; a vertex moves to where its two shifted edges meet
  const nrm = (i: number): Pt => { const p = P[i], q = P[(i + 1) % n]; const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1; return [-dy / l * sg, dx / l * sg]; };
  for (let i = 0; i < n; i++) {
    const n0 = nrm((i + n - 1) % n), n1 = nrm(i); const bx = n0[0] + n1[0], by = n0[1] + n1[1]; const c = 1 + n0[0] * n1[0] + n0[1] * n1[1];
    if (c < 1e-6) { out.push([P[i][0] + n1[0] * d, P[i][1] + n1[1] * d]); continue; }
    out.push([P[i][0] + bx * d / c, P[i][1] + by * d / c]);
  }
  return out;
}
/** A footprint's courtyard polygons per side, chained from its F.CrtYd / B.CrtYd drawings in board coordinates. */
export function courtyards(fp: KItem) {
  const n = fp.node; const [fx, fy, frot] = K.atOf(n); const R = rotator(frot); const tf = (x: number, y: number) => { const [dx, dy] = R(x, y); return [fx + dx, fy + dy]; };
  const out: Record<string, Pt[][]> = { "F.CrtYd": [], "B.CrtYd": [] };
  for (const g of n) {
    if (!isList(g) || !/^fp_(line|rect|circle|arc|poly)$/.test(g[0] as string)) continue; const layer = layerOf(g, ""); if (!out[layer]) continue;
    const kind = (g[0] as string).slice(3); const P = (key: string) => { const p = pt(g, key); return p ? tf(p[0], p[1]) : null; };
    if (kind === "line") { const a = P("start"), b = P("end"); if (a && b) out[layer].push([a, b]); }
    else if (kind === "rect") { const s = pt(g, "start"), e = pt(g, "end"); if (s && e) { const pts = [tf(s[0], s[1]), tf(e[0], s[1]), tf(e[0], e[1]), tf(s[0], e[1])]; out[layer].push(pts.concat([pts[0]])); } }
    else if (kind === "circle") { const c = P("center"), e = P("end"); if (c && e) { const r = Math.hypot(e[0] - c[0], e[1] - c[1]); const pts: Pt[] = []; for (let i = 0; i < 32; i++) pts.push([c[0] + r * Math.cos(i * Math.PI / 16), c[1] + r * Math.sin(i * Math.PI / 16)]); out[layer].push(pts.concat([pts[0]])); } }
    else if (kind === "arc") { const a = P("start"), m = P("mid"), b = P("end"); if (a && m && b) { const arc = K.arcFrom3(a, m, b); out[layer].push(arc ? arcPoints(arc, a, b) : [a, b]); } }
    else if (kind === "poly") { const pts = K.ptsOf(g).map(([x, y]) => tf(x, y)); if (pts.length > 2) out[layer].push(pts.concat([pts[0]])); }
  }
  // BuildCourtyardCaches chains ends up to 0.02 mm apart
  const res: Record<string, Pt[][]> = {}; for (const layer of Object.keys(out)) res[layer] = out[layer].length ? chainLoops(out[layer], 0.02).loops : [];
  return res;
}
/** SEG::Intersect: where two track centre lines cross (touching ends included), or null. */
export function segCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d1 = [p2[0] - p1[0], p2[1] - p1[1]], d2 = [p4[0] - p3[0], p4[1] - p3[1]]; const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * d2[1] - (p3[1] - p1[1]) * d2[0]) / den, u = ((p3[0] - p1[0]) * d1[1] - (p3[1] - p1[1]) * d1[0]) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [p1[0] + t * d1[0], p1[1] + t * d1[1]];
}
export const marker = (code: string, severity: string, x: number, y: number, text: string, ids: string[]): DrcMarker => ({ code, severity, x: r6(x), y: r6(y), text, ids });
/** The markers' items as KiCad identifies them (RC_ITEM KIIDs): a pad by its own uuid, not its footprint's. */
export const withKiids = (m: DrcMarker, kiids: string[]): DrcMarker => { m.kiids = Array.from(new Set(kiids.filter(Boolean))); return m; };
const tieCache = new WeakMap<object, Map<string, number>>();
/** FOOTPRINT::MapPadNumbersToNetTieGroups: whether two pad numbers share a net-tie group. */
function tiedPads(fp: { node: SNode }, a: string, b: string): boolean {
  let m = tieCache.get(fp);
  if (!m) { m = new Map(); const g = K.kid(fp.node, "net_tie_pad_groups"); if (g) g.slice(1).forEach((grp, i) => { for (const n of K.str(grp as SNode).split(/[\s,]+/).filter(Boolean)) m!.set(n, i); }); tieCache.set(fp, m); }
  const x = m.get(a); return x !== undefined && x === m.get(b);
}
export const boxCenter = (a: Box, b: Box) => [(Math.max(a[0], b[0]) + Math.min(a[2], b[2])) / 2, (Math.max(a[1], b[1]) + Math.min(a[3], b[3])) / 2];
/**
 * The DRC subset: copper clearance (pads, tracks, arcs, vias against different nets on a shared layer), copper to
 * board edge, missing connections (from the ratsnest), shorts, zero-length and dangling tracks, via annular
 * width, courtyard overlaps and items outside the outline.  Returns markers [{ x, y, severity, text, ids, code }].
 */
/** Rules a footprint can break on its own, as its library drew it: waived when every item named is that one footprint. */
export const FOOTPRINT_OWN = new Set(["clearance", "shorting_items", "hole_clearance", "hole_to_hole", "holes_co_located", "solder_mask_bridge", "silk_over_copper", "silk_overlap", "malformed_courtyard", "missing_courtyard", "pth_inside_courtyard", "npth_inside_courtyard", "isolated_copper"]);
export function drc(doc: BoardDoc, settings: DesignSettings | DesignSource | string | null | undefined, opts?: { unconnected?: boolean; outline?: boolean; rules?: DruRule[] | string | null; footprintOwn?: boolean; allTrackErrors?: boolean }) {
  const s = settings && (settings as DesignSettings).netclasses ? settings as DesignSettings : designSettings(settings); opts = opts || {}; const out: DrcMarker[] = [];
  const nl = netlist(doc); const conds = nl.conductors.filter((c) => c.kind !== "zone");
  const clr = (c: Conductor) => netClearance(s, c.net);
  // vias and plated holes without copper on a layer (remove unused layers) are only their hole there (drc-flash.ts)
  const unfl = unflashedLayers(nl.conductors, doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]);
  const shapeOn = (c: Conductor, layer: string): CopperShape => { const m = unfl.get(c); return (m && m.get(layer)) || c.shape; };
  // DRC_ENGINE::EvalRules: a pad's or its footprint's own clearance (GetClearanceOverrides) beats every rule but the board
  // minimum; the larger of the two items' overrides wins and names the result ("pad", "footprint R1")
  const overrideOf = (c: Conductor): { v: number; name: string } | null => {
    if (c.kind !== "pad") return null;
    const pc = K.kid(c.pad.node, "clearance"); if (pc) return { v: K.num(pc[1], 0), name: "pad" };
    const fc = K.kid(c.item.node, "clearance"); if (fc) return { v: K.num(fc[1], 0), name: `footprint ${c.item.ref || ""}` };
    return null;
  };
  const override = (a: Conductor, b: Conductor | null): { need: number; name: string } | null => {
    const oa = overrideOf(a), ob = b ? overrideOf(b) : null; if (!oa && !ob) return null;
    let v = 0, name = ""; if (oa) { v = oa.v; name = oa.name; } if (ob && ob.v > v) { v = ob.v; name = ob.name; }
    if (!(v > 0)) return null;
    if (v < (s.minClearance || 0)) return { need: s.minClearance || 0, name: "board minimum" };
    return { need: v, name };
  };
  // DRC_ENGINE::loadImplicitRules: a netclass whose diff pair gap is under its clearance has the rule "netclass 'X' diff pair"
  // (A.hasExactNetclass('X') && AB.isCoupledDiffPair()): the two nets of a pair need only the gap between them
  const pairClr = (a: Conductor, b: Conductor): number => {
    const nc = netclassOf(s, a.net), c = clr(a); const g = nc.diff_pair_gap;
    if (typeof g !== "number" || !(g < c) || !a.net || !b.net) return c;
    const m = matchDpSuffix(a.net); return m.rv && m.complement === b.net ? g : c;
  };
  // the custom rules' clearance constraints (.kicad_dru) take over from the netclass clearance where they match
  const rules = typeof opts.rules === "string" ? parseDru(opts.rules).rules : opts.rules || [];
  const clrRules = rules.filter((r) => r.constraints.some((k) => k.type === "clearance" && k.min != null));
  const ruleMax = Math.max(0, ...clrRules.map((r) => r.constraints.find((k) => k.type === "clearance")!.min || 0));
  const maxClr = Math.max(s.clearance, s.minClearance || 0, ...Object.values(s.netclasses).map((n) => n.clearance || 0), s.edgeClearance, ruleMax);
  const ruleItem = (c: Conductor, layer: string) => (c.kind === "pad" ? { kind: c.kind, node: c.pad.node, parent: c.item, layer, shape: c.shape } : { kind: c.kind, node: c.item.node, item: c.item, layer, shape: c.shape });
  // copper clearance
  const order = conds.slice().sort((a, b) => a.bbox[0] - b.bbox[0]);
  // testTrackClearances: a track, arc or via stops at its first violation on a layer (unless "report all track errors")
  const TRACKISH = new Set(["segment", "arc", "via"]); const trackDone = new Set<string>();
  const trackOf = (a: Conductor, b: Conductor): Conductor | null => (TRACKISH.has(a.kind) && TRACKISH.has(b.kind) ? (a.id < b.id ? a : b) : TRACKISH.has(a.kind) ? a : TRACKISH.has(b.kind) ? b : null);
  const allTrackErrors = !!opts.allTrackErrors;
  const uid = (c: Conductor): string => (c.kind === "pad" ? K.uuidOf(c.pad.node) || c.id : K.uuidOf(c.item.node) || c.id);
  const firstOf = (a: Conductor, b: Conductor): [Conductor, Conductor] => {
    const ta = TRACKISH.has(a.kind), tb = TRACKISH.has(b.kind);
    if (ta !== tb) return ta ? [a, b] : [b, a];
    return uid(a) <= uid(b) ? [a, b] : [b, a];
  };
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    for (let j = i + 1; j < order.length; j++) {
      const b = order[j]; if (b.bbox[0] > a.bbox[2] + maxClr) break;
      // testItemAgainstItem: one net (no net included) tests nothing; testPadAgainstItem waives only one defined net
      if (a.kind === "pad" || b.kind === "pad" ? a.net && a.net === b.net : (a.net || "") === (b.net || "")) continue; if (!shareLayer(a.layers, b.layers)) continue;
      if (b.bbox[1] > a.bbox[3] + maxClr || b.bbox[3] < a.bbox[1] - maxClr) continue;
      // testTrackClearances / testPadClearances run once per copper layer the two share: through-hole items report on each
      for (const layer of a.layers) {
        if (!b.layers.has(layer)) continue;
        // PAD::SameLogicalPadAs: pads of one footprint with one (non-empty) number are one pad; only different real nets short
        if (a.kind === "pad" && b.kind === "pad" && a.item === b.item && a.pad.number && a.pad.number === b.pad.number) {
          // testPadAgainstItem: the one logical pad with two real nets shorts them (two "unconnected-(" nets do not)
          if (a.net && b.net && a.net !== b.net && !(a.net.startsWith("unconnected-(") && b.net.startsWith("unconnected-("))) out.push(withKiids(marker("shorting_items", "error", b.pad.x, b.pad.y, `Items shorting two nets (nets ${a.net} and ${b.net})`, [a.id, b.id]), [uid(a), uid(b)]));
          continue;
        }
        // testPadAgainstItem: two pads of one net-tie group in the same footprint may touch
        if (a.kind === "pad" && b.kind === "pad" && a.item === b.item && tiedPads(a.item, a.pad.number, b.pad.number)) continue;
        const tr = allTrackErrors ? null : trackOf(a, b), trKey = tr ? tr.id + "|" + layer : "";
        if (tr && trackDone.has(trKey)) continue;
        let need = Math.max(pairClr(a, b), pairClr(b, a), s.minClearance || 0), by = "";   // Board Setup > Constraints: the board minimum is a floor
        const ov = override(a, b);
        if (ov) { need = ov.need; by = ov.name; }
        else if (clrRules.length && boxesTouch(a.bbox, b.bbox, maxClr)) {
          const hit = ruleClearance(clrRules, doc, s, ruleItem(a, layer), ruleItem(b, layer));
          if (hit) { need = hit.min > 0 ? hit.min : 0; by = hit.name; }   // a custom rule wins outright (no board-minimum floor)
        }
        if (!need || !boxesTouch(a.bbox, b.bbox, need)) continue;
        const gap = shapeGap(shapeOn(a, layer), shapeOn(b, layer)); if (gap >= need - DRC_EPS) continue;
        if (tr) trackDone.add(trKey);
        if (a.kind === "segment" && b.kind === "segment") {   // DRC_TEST_PROVIDER_COPPER_CLEARANCE: crossing tracks are their own violation
          const sa = a.shape as { a: Pt; b: Pt }, sb = b.shape as { a: Pt; b: Pt }; const X = segCross(sa.a, sa.b, sb.a, sb.b);
          if (X) { out.push(marker("tracks_crossing", "error", X[0], X[1], "Tracks crossing", [a.id, b.id])); continue; }
        }
        // actual 0 between two nets: shorting_items (a pad needs both nets real; other items the second one's, in uuid order)
        if (gap <= 0) {
          const pad = a.kind === "pad" || b.kind === "pad"; const [p, q] = a.id <= b.id ? [a, b] : [b, a];
          if (pad ? !!(a.net && b.net) : !!q.net) {
            const [x, y] = boxCenter(a.bbox, b.bbox);
            out.push(withKiids(marker("shorting_items", "error", x, y, `Items shorting two nets (nets ${p.net || "<no net>"} and ${q.net || "<no net>"})`, Array.from(new Set([a.id, b.id]))), [uid(a), uid(b)])); continue;
          }
        }
        // EvalRules(item, other): the tested item's class names the rule unless the other's is strictly larger (a track tests
        // the pads near it; of two tracks or two pads the lower uuid tests the other)
        const [A, B] = firstOf(a, b);
        const ca = pairClr(A, B), cb = pairClr(B, A); const cls = cb > ca ? netclassName(s, B.net) + (cb < clr(B) ? "' diff pair" : "'") : netclassName(s, A.net) + (ca < clr(A) ? "' diff pair" : "'");
        const [x, y] = boxCenter(a.bbox, b.bbox);
        const [tn, tg] = mmPair(need, gap);
        out.push(withKiids(marker("clearance", "error", x, y, `Clearance violation (${by || `netclass '${cls}`} clearance ${tn}; actual ${tg})`, Array.from(new Set([a.id, b.id]))), [uid(a), uid(b)]));
      }
    }
  }
  // items against zone fills (testItemAgainstZone): the zone's own net waives it; the clearance is the rules' (or the two
  // netclasses'), raised to the zone's local clearance and the board minimum; one marker per item, zone and layer
  {
    const zones = nl.conductors.filter((c) => c.kind === "zone"); const zg = boxGrid(zones, (c) => c.bbox);
    const zoneLocal = (z: Conductor): number => { const cp = K.kid(z.item.node, "connect_pads"); const v = cp && K.kid(cp, "clearance"); return v ? K.num(v[1]) : 0; };
    const seen = new Map<string, { gap: number; need: number; name: string; c: Conductor; z: Conductor }>();
    for (const c of conds) {
      for (const z of zg.query(c.bbox, maxClr + 1)) {
        if (z.net && z.net === c.net) continue; const layer = [...c.layers].find((l) => z.layers.has(l)); if (!layer) continue;
        let hit: { min: number; name: string } | null = null, need = Math.max(clr(c), clr(z)), name = `netclass '${clr(c) >= clr(z) ? netclassName(s, c.net) : netclassName(s, z.net)}'`;
        const ov = override(c, null);
        if (ov) { need = ov.need; name = ov.name; hit = { min: ov.need, name: ov.name }; }
        else if (clrRules.length) { hit = ruleClearance(clrRules, doc, s, ruleItem(c, layer), ruleItem(z, layer)); if (hit) { if (!(hit.min > 0)) continue; need = hit.min; name = hit.name; } }
        // EvalRules: a custom rule wins outright; only the implicit (netclass) result is raised to the local clearance and the board minimum
        if (!hit) {
          const loc = zoneLocal(z); if (loc > need) { need = loc; name = "zone"; }
          if ((s.minClearance || 0) > need) { need = s.minClearance || 0; name = "board minimum"; }
        }
        if (!(need > 0) || !boxesTouch(c.bbox, z.bbox, need)) continue;
        const gap = shapeGap(shapeOn(c, layer), z.shape); if (gap >= need - DRC_EPS) continue;
        const key = c.id + "|" + (c.kind === "pad" ? c.index : "") + "|" + z.id + "|" + layer; const prev = seen.get(key);
        if (!prev || gap < prev.gap) seen.set(key, { gap: Math.max(0, gap), need, name, c, z });
      }
    }
    for (const v of seen.values()) { const [x, y] = boxCenter(v.c.bbox, v.z.bbox); const [tn, tg] = mmPair(v.need, v.gap); out.push(withKiids(marker("clearance", "error", x, y, `Clearance violation (${v.name} clearance ${tn}; actual ${tg})`, [v.c.id, v.z.id]), [uid(v.c), uid(v.z)])); }
    // testZonesToZones: the fills of two zones of different nets on one layer, nearer than their clearance (the rules',
    // else the netclasses' raised to the zones' own clearance and the board minimum); one marker per pair and layer
    // zones in board order (m_DRCCopperZones), each with its fill outlines on the layer in file order
    const zItems: { item: Conductor["item"]; conds: Conductor[] }[] = []; const zIdx = new Map<object, number>();
    for (const z of zones) { let k = zIdx.get(z.item); if (k === undefined) { zIdx.set(z.item, k = zItems.length); zItems.push({ item: z.item, conds: [] }); } zItems[k].conds.push(z); }
    const zz = new Map<string, { gap: number; need: number; name: string; a: Conductor; b: Conductor; p: Pt; layer: string }>();
    const layersAll = new Set<string>(); for (const z of zones) for (const l of z.layers) layersAll.add(l);
    for (const layer of layersAll) {
      const L = zItems.map((zi) => zi.conds.filter((c) => c.layers.has(layer))).filter((cs) => cs.length);
      for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
        const a = L[i][0], b = L[j][0]; if ((a.net || "") === (b.net || "")) continue;
        const ba = L[i].reduce((m, c) => [Math.min(m[0], c.bbox[0]), Math.min(m[1], c.bbox[1]), Math.max(m[2], c.bbox[2]), Math.max(m[3], c.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
        const bb = L[j].reduce((m, c) => [Math.min(m[0], c.bbox[0]), Math.min(m[1], c.bbox[1]), Math.max(m[2], c.bbox[2]), Math.max(m[3], c.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
        if (!boxesTouch(ba as Box, bb as Box, maxClr + 1)) continue;
        let need = Math.max(clr(a), clr(b)), name = `netclass '${clr(a) >= clr(b) ? netclassName(s, a.net) : netclassName(s, b.net)}'`, hit: { min: number; name: string } | null = null;
        if (clrRules.length) { hit = ruleClearance(clrRules, doc, s, ruleItem(a, layer), ruleItem(b, layer)); if (hit) { if (!(hit.min > 0)) continue; need = hit.min; name = hit.name; } }
        if (!hit) {
          const loc = Math.max(zoneLocal(a), zoneLocal(b)); if (loc > need) { need = loc; name = "zone"; }
          if ((s.minClearance || 0) > need) { need = s.minClearance || 0; name = "board minimum"; }
        }
        if (!(need > 0) || !boxesTouch(ba as Box, bb as Box, need)) continue;
        const r = firstEdgeConflict(L[i].map((c) => (c.shape as PolyShape).pts), L[j].map((c) => (c.shape as PolyShape).pts), need); if (!r) continue;
        zz.set(a.item.id + "|" + b.item.id + "|" + layer, { gap: r.gap, need, name, a, b, p: r.p, layer });
      }
    }
    for (const v of zz.values()) {
      const [tn, tg] = mmPair(v.need, v.gap); const m = withKiids(marker("clearance", "error", v.p[0], v.p[1], `Clearance violation (${v.name} clearance ${tn}; actual ${tg})`, [v.a.id, v.b.id]), [uid(v.a), uid(v.b)]);
      m.layer = v.layer; out.push(m);
    }
  }
  // copper graphics and text (testGraphicClearances, plus the track and pad passes' tests against them).  KiCad's nets:
  // a board shape on copper is connected (its net, or no net), a footprint's shapes and every text are not; two items
  // of one net (or two unconnected items) are never tested.  A shape is tested against pads, tracks, vias, texts and
  // other shapes (not another shape of its own footprint), a text against pads, tracks and vias, and every drawing
  // against the zones (clearance only; knockout text inherits the first zone it sits in and shorts any other).
  // Touching is a short when the item with the later uuid is connected, else a clearance violation.
  {
    const copperSet = new Set(doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]);
    const SKIP = new Set(["pad", "via", "segment", "arc", "zone", "dimension", "table", "barcode"]);
    const graphics = boardElements(doc as never, s, copperSet).filter((e) => !SKIP.has(e.kind) && copperSet.has(e.layer));
    if (graphics.length) {
      type G = (typeof graphics)[number];
      const isText = (e: G) => /text|property/.test(e.kind);
      const knockout = (e: G) => isText(e) && !/box/.test(e.kind) && ((K.kid(e.node, "layer") || []) as unknown[]).slice(2).includes("knockout");
      const gNet = (e: G): string | null => (e.fp || isText(e) ? null : e.net || "");
      const solid = (sh: CopperShape): CopperShape => (sh.t === "poly" ? { t: "poly", pts: sh.pts, solid: true } : sh);
      const gkiid = (e: G) => K.uuidOf(e.node) || e.uuid;
      const shapesOf = new Map<G, CopperShape[]>(); const shp = (e: G) => { let v = shapesOf.get(e); if (!v) shapesOf.set(e, v = e.shapes.map(solid)); return v; };
      const gapTo = (e: G, o: CopperShape) => { let g = Infinity; for (const sh of shp(e)) g = Math.min(g, shapeGap(sh, o)); return g; };
      const gNeed = (na: string | null, nb: string | null, c: Conductor | null) => {
        const ca = netClearance(s, na), cb = c ? clr(c) : netClearance(s, nb); const need = Math.max(ca, cb, s.minClearance || 0);
        return { need, name: `netclass '${cb >= ca ? (c ? netclassName(s, c.net) : netclassName(s, nb)) : netclassName(s, na)}'` };
      };
      // DRC_ENGINE::IsNetTieExclusion: a drawing of a net-tie footprint meeting copper of a net one of its tied pads carries
      const tiePads = (fp: KItem | null | undefined): Conductor[] => (fp && K.kid(fp.node, "net_tie_pad_groups") ? nl.conductors.filter((c) => c.kind === "pad" && c.item === fp && tiedPads(fp, c.pad.number, c.pad.number)) : []);
      const tieExcluded = (e: G, net: string | null, layer: string) => !!net && tiePads(e.fp).some((p) => p.net === net && p.layers.has(layer) && gapTo(e, shapeOn(p, layer)) <= DRC_EPS);
      const padNo = (c: Conductor) => (c.kind === "pad" ? c.pad.number : "");
      const seenG = new Set<string>();
      const report = (aId: string, aKiid: string, aNet: string | null, aBox: Box, bId: string, bKiid: string, bNet: string | null, bBox: Box, gap: number, need: number, name: string, layer: string, zone = false) => {
        const key = [aKiid, bKiid].sort().join("|") + "|" + layer; if (seenG.has(key)) return; seenG.add(key);
        const [x, y] = boxCenter(aBox, bBox);
        // the pair in uuid order: the second item's net decides a short
        const later = aKiid > bKiid ? aNet : bNet;
        if (!zone && gap <= 0 && later !== null) {
          const first = aKiid > bKiid ? bNet : aNet;
          out.push(withKiids(marker("shorting_items", "error", x, y, `Items shorting two nets (nets ${first || "<no net>"} and ${later || "<no net>"})`, Array.from(new Set([aId, bId]))), [aKiid, bKiid])); return;
        }
        const [tn, tg] = mmPair(need, Math.max(0, gap));
        out.push(withKiids(marker("clearance", "error", x, y, `Clearance violation (${name} clearance ${tn}; actual ${tg})`, Array.from(new Set([aId, bId]))), [aKiid, bKiid]));
      };
      const cg = boxGrid(conds, (c) => c.bbox);
      const zones = nl.conductors.filter((c) => c.kind === "zone"); const zg = boxGrid(zones, (c) => c.bbox);
      for (const e of graphics) {
        const layer = e.layer; const eNet = gNet(e); const text = isText(e);
        // against pads, tracks and vias
        for (const c of cg.query(e.bbox, maxClr)) {
          if (!c.layers.has(layer)) continue;
          const cNet = c.net || "";
          if (eNet === cNet) continue;
          const { need, name } = gNeed(eNet, cNet, c);
          if (!boxesTouch(e.bbox, c.bbox, need)) continue;
          const cs = shapeOn(c, layer); const gap = gapTo(e, cs);
          if (!(gap < need - DRC_EPS)) continue;
          // copper of a net the footprint ties is waived where it meets the tie (issue14008: KiCad lets every such via through)
          if (tieExcluded(e, cNet, layer)) continue;
          if (c.kind === "pad" && e.fp && e.fp === c.item && !text && tiedPads(c.item, c.pad.number, c.pad.number)) continue;
          report(e.id, gkiid(e), eNet, e.bbox, c.id, uid(c), cNet, c.bbox, gap, need, name, layer);
        }
        // a shape against texts and other shapes (once per pair; not two shapes of one footprint)
        if (!text) {
          for (const o of graphics) {
            if (o === e || o.layer !== layer) continue;
            const oText = isText(o);
            if (!oText && o.fp && o.fp === e.fp) continue;
            if (!oText && gkiid(o) < gkiid(e)) continue;
            const oNet = gNet(o); if (eNet === oNet) continue;
            const { need, name } = gNeed(eNet, oNet, null);
            if (!boxesTouch(e.bbox, o.bbox, need)) continue;
            let gap = Infinity; for (const sh of shp(o)) gap = Math.min(gap, gapTo(e, sh));
            if (!(gap < need - DRC_EPS)) continue;
            report(e.id, gkiid(e), eNet, e.bbox, o.id, gkiid(o), oNet, o.bbox, gap, need, name, layer);
          }
        }
        // against the zones (testItemAgainstZone / testKnockoutTextAgainstZone)
        const near = zg.query(e.bbox, maxClr).filter((z) => z.layers.has(layer));
        if (!near.length) continue;
        const byZone = new Map<KItem, Conductor[]>(); for (const z of near) { const l = byZone.get(z.item); if (l) l.push(z); else byZone.set(z.item, [z]); }
        const ko = knockout(e); let inherited: string | null | undefined;
        for (const [zi, fills] of byZone) {
          const zNet = fills[0].net || "";
          let gap = Infinity; for (const z of fills) gap = Math.min(gap, gapTo(e, z.shape));
          if (ko) {
            if (inherited === undefined && gap <= 0) inherited = zNet;
            if (inherited === zNet) continue;
            const { need, name } = gNeed(null, zNet, fills[0]);
            if (!(gap < need - DRC_EPS)) continue;
            if (gap <= 0 && inherited !== undefined) { const [x, y] = boxCenter(e.bbox, fills[0].bbox); out.push(withKiids(marker("shorting_items", "error", x, y, `Items shorting two nets (nets ${inherited || "<no net>"} and ${zNet || "<no net>"})`, [e.id, zi.id]), [gkiid(e), uid(fills[0])])); continue; }
            report(e.id, gkiid(e), null, e.bbox, zi.id, uid(fills[0]), zNet, fills[0].bbox, gap, need, name, layer, true); continue;
          }
          if (zNet && eNet === zNet) continue;
          if (e.fp && zNet && tiePads(e.fp).some((p) => p.layers.has(layer) && (p.net === zNet || tiePads(e.fp).some((q) => q.net === zNet && tiedPads(e.fp!, padNo(p), padNo(q)))) && gapTo(e, shapeOn(p, layer)) <= DRC_EPS)) continue;
          const { need, name } = gNeed(eNet, zNet, fills[0]);
          if (!(need > 0) || !(gap < need - DRC_EPS)) continue;
          report(e.id, gkiid(e), eNet, e.bbox, zi.id, uid(fills[0]), zNet, fills[0].bbox, gap, need, name, layer, true);
        }
      }
    }
  }
  // copper to board edge (DRC_TEST_PROVIDER_EDGE_CLEARANCE): every copper item (zone fills one layer at a time) against the
  // Edge.Cuts lines (their width taken as zero) and the Margin lines; EvalRules(edge, item) gives the clearance (a custom
  // edge_clearance rule, else the board setup value).  An item reports its first offending edge only; castellated and
  // edge-connector pads are not tested, nor a track inside a castellated pad's hole.
  const edges = (() => {
    const cut = edgeShapes(doc, { zeroWidth: true }), mar = edgeShapes(doc, { layer: "Margin" });
    return { shapes: cut.shapes.concat(mar.shapes), ids: cut.ids.concat(mar.ids), nodes: cut.nodes.concat(mar.nodes), layer: cut.shapes.map(() => "Edge.Cuts").concat(mar.shapes.map(() => "Margin")) };
  })();
  const edgeRules = rules.filter((r) => r.constraints.some((k) => k.type === "edge_clearance"));
  if (edges.shapes.length && (s.edgeClearance > 0 || edgeRules.length)) {
    const eb = edges.shapes.map((e) => shapeBBox(e)); const eg = boxGrid(edges.shapes.map((_, i) => i), (i) => eb[i]);
    const edgeMax = Math.max(s.edgeClearance, ...edgeRules.flatMap((r) => r.constraints.filter((k) => k.type === "edge_clearance").map((k) => k.min || 0)));
    const castHoles: CopperShape[] = [];
    for (const c of conds) if (c.kind === "pad" && K.kids(c.pad.node, "property").some((p) => K.str(p[1] as SNode) === "pad_prop_castellated")) { const d = K.kid(c.pad.node, "drill"); if (d) castHoles.push({ t: "circle", x: c.pad.x, y: c.pad.y, r: K.num(d[1], 0) / 2 }); }
    const edgeNeed = (c: Conductor, layer: string, i: number): { need: number; name: string } => {
      if (edgeRules.length) {
        const E = { kind: String(edges.nodes[i][0]), node: edges.nodes[i], layer: edges.layer[i] };
        const h = evalRuleConstraint(edgeRules, "edge_clearance", doc, s, E, ruleItem(c, layer)) || evalRuleConstraint(edgeRules, "edge_clearance", doc, s, ruleItem(c, layer), E);
        if (h) return { need: h.severity === "ignore" ? -1 : h.min || 0, name: h.name };
      }
      return { need: s.edgeClearance, name: "board setup constraints edge" };
    };
    const testUnit = (c: Conductor, layer: string, shape: CopperShape): void => {
      let best: { i: number; gap: number; need: number; name: string } | null = null;
      for (const i of eg.query(c.bbox, edgeMax)) {
        const r = edgeNeed(c, layer, i); if (r.need < 0) continue;
        if (!boxesTouch(c.bbox, eb[i], r.need)) continue;
        const gap = shapeGap(shape, edges.shapes[i]); if (gap >= Math.max(0, r.need - DRC_EPS) && !(r.need === 0 && gap <= 0)) continue;
        if (!best || gap < best.gap) best = { i, gap, need: r.need, name: r.name };
      }
      if (!best) return;
      if ((c.kind === "segment" || c.kind === "arc") && castHoles.some((h) => shapeGap(h, shape) <= 0 && shapeGap(h, edges.shapes[best!.i]) <= 0)) return;
      const [x, y] = boxCenter(c.bbox, eb[best.i]);
      out.push(marker("copper_edge_clearance", "error", x, y, best.need > 0 ? `Board edge clearance violation (${best.name} clearance ${mm4(best.need)}; actual ${mm4(Math.max(0, best.gap))})` : "Board edge clearance violation", Array.from(new Set([edges.ids[best.i], c.id]))));
    };
    for (const c of conds) {
      if (c.kind === "pad" && (c.pad.type === "connect" || K.kids(c.pad.node, "property").some((p) => K.str(p[1] as SNode) === "pad_prop_castellated"))) continue;
      const layer = c.kind === "segment" || c.kind === "arc" ? c.layers.values().next().value! : [...c.layers][0];
      testUnit(c, layer, c.shape);
    }
    // zone fills: one work unit per layer
    const zl = new Map<string, Conductor[]>();
    for (const z of nl.conductors) if (z.kind === "zone") { const k = z.id + "|" + [...z.layers][0]; let l = zl.get(k); if (!l) zl.set(k, l = []); l.push(z); }
    for (const list of zl.values()) {
      const before = out.length;
      for (const z of list) { testUnit(z, [...z.layers][0], z.shape); if (out.length > before) break; }
    }
  }
  // connectivity
  if (opts.unconnected !== false) for (const l of ratsnest(doc, nl)) out.push(marker("unconnected_items", "error", l.a[0], l.a[1], `Missing connection between items (net '${l.name}')`, l.ids.slice()));
  for (const net of nl.nets.values()) for (const cl of net.shorts) { const p = cl.anchors[0] ? cl.anchors[0].p : [0, 0]; out.push(marker("shorting_items", "error", p[0], p[1], `Items shorting two nets (${Array.from(cl.nets).join(", ")})`, Array.from(new Set(cl.items.map((c) => c.id))))); }
  // tracks and vias
  const condGrid = boxGrid(conds, (c) => c.bbox), zoneGrid = boxGrid(nl.conductors.filter((c) => c.kind === "zone"), (c) => c.bbox);
  const touches = (p: Pt, layer: string, self: Conductor) => { const pb = [p[0], p[1], p[0], p[1]];
    return condGrid.query(pb, EPS).some((c) => c !== self && c.layers.has(layer) && shapeGap(c.shape, { t: "circle", x: p[0], y: p[1], r: 0 }) <= EPS)
      || zoneGrid.query(pb, EPS).some((c) => c.layers.has(layer) && pointInPoly((c.shape as PolyShape).pts, p[0], p[1])); };
  for (const c of conds) {
    if (c.kind === "segment" || c.kind === "arc") {
      const [a, b] = c.anchors; const layer = c.layers.values().next().value!;
      if (c.length! < EPS) continue;   // KiCad reports nothing for a zero-length track
      // CONNECTIVITY_DATA::TestTrackEndpointDangling over the items connectivity joins to the track (an anchor of one
      // touching it; a zone by the track's ends in its fill)
      const acc = (c.width || 0) / 2, P0 = { t: "circle" as const, x: a[0], y: a[1], r: 0 }, P1 = { t: "circle" as const, x: b[0], y: b[1], r: 0 };
      const inside = (o: Conductor, p: Pt): boolean => (o.kind === "zone" ? pointInPoly((o.shape as PolyShape).pts, p[0], p[1]) : shapeGap(shapeOn(o, layer), { t: "circle", x: p[0], y: p[1], r: 0 }) <= EPS);
      let sc = 0, ec = 0, joined = false;
      const visit = (o: Conductor): boolean => {
        if (o === c || !o.layers.has(layer)) return false;   // CN_ITEM::CanChangeNet: a track joins items of any net
        if (o.kind === "zone" ? !c.anchors.some((p) => inside(o, p)) : shapeGap(shapeOn(o, layer), c.shape) > EPS) return false;   // CN_VISITOR: shapes touching; a zone by the track's anchors
        let hs: boolean, he: boolean;
        if (o.kind === "zone") { hs = shapeGap({ t: "circle", x: a[0], y: a[1], r: acc }, o.shape) <= 0; he = shapeGap({ t: "circle", x: b[0], y: b[1], r: acc }, o.shape) <= 0; }
        else { const sh = shapeOn(o, layer); hs = shapeGap(sh, P0) <= acc + EPS; he = shapeGap(sh, P1) <= acc + EPS; }
        if (hs && he) {
          if (o.kind === "zone" || o.kind === "pad" || o.kind === "via") return true;   // both ends in a zone, pad or via: not dangling
          const md = (p: Pt): number => Math.min(...o.anchors.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])));
          if (md(a) < md(b)) sc++; else ec++;
        } else if (hs) sc++; else if (he) ec++;
        return sc > 0 && ec > 0;
      };
      for (const o of condGrid.query(c.bbox, EPS)) if (visit(o)) { joined = true; break; }
      if (!joined) for (const o of zoneGrid.query(c.bbox, EPS)) if (visit(o)) { joined = true; break; }
      if (!joined) { const p = sc === 0 ? a : b; out.push(marker("track_dangling", "warning", p[0], p[1], "Track has unconnected end", [c.id])); }   // one marker per track, like DRCE_DANGLING_TRACK
    } else if (c.kind === "via") {
      // CONNECTIVITY_DATA::TestTrackEndpointDangling: a via with nothing connected (and a net), or whose connections all
      // start on one copper layer (CN_ITEM::Layer), dangles
      const [a] = c.anchors; const stack = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
      const startOf = (ls: Set<string>): string => { for (const l of stack) if (ls.has(l)) return l; return ls.values().next().value || ""; };
      const starts = new Set<string>();
      for (const o of condGrid.query(c.bbox, EPS)) {
        if (o === c || o.id === c.id) continue;   // a via joins items of any net (CanChangeNet)
        let hit = false; for (const l of c.layers) if (o.layers.has(l) && shapeGap(o.shape, shapeOn(c, l)) <= EPS) { hit = true; break; }
        if (hit) starts.add(startOf(o.layers));
      }
      for (const o of zoneGrid.query(c.bbox, EPS)) {
                const l = o.layers.values().next().value!; if (c.layers.has(l) && shapeGap(o.shape, shapeOn(c, l)) <= EPS) starts.add(l);
      }
      if (starts.size === 0 ? !!c.net : starts.size === 1) out.push(marker("via_dangling", "warning", a[0], a[1], "Via is not connected or connected on only one layer", [c.id]));
    }
  }
  // copper slivers and connection widths over the merged copper of each layer / net (drc-sliver.ts, drc-connwidth.ts)
  if (s.severities.copper_sliver !== "ignore" || s.severities.connection_width !== "ignore") {
    const cc = copperCtx(doc);
    if (s.severities.copper_sliver !== "ignore") out.push(...sliverMarkers(doc, nl.conductors, cc));
    if (s.severities.connection_width !== "ignore") out.push(...connectionWidthMarkers(doc, s, rules, nl.conductors, cc));
  }
  // track width, via diameter, hole size, annular width, segment length and angle through the rules (drc-rules.ts)
  out.push(...sizeMarkers(doc, s, rules, conds), ...trackAngleMarkers(doc, s, rules, conds));
  if (rules.length) { const items = ruleItems(doc); out.push(...disallowMarkers(doc, s, rules, items), ...assertionMarkers(doc, s, rules, items)); }
  // courtyards
  // the courtyard cache is deflated by maxError (5 um) so touching courtyards stay legal
  const fps = Array.from(doc.items.values()).filter((it) => it.kind === "footprint"); const cy = fps.map((fp) => { const c = courtyards(fp); for (const l of Object.keys(c)) c[l] = c[l].map((p) => deflatePoly(p, 0.005)); return c; });
  for (let i = 0; i < fps.length; i++) for (let j = i + 1; j < fps.length; j++) {
    if (!fps[i].bbox || !fps[j].bbox || !boxesTouch(fps[i].bbox!, fps[j].bbox!, 0)) continue;
    for (const layer of ["F.CrtYd", "B.CrtYd"]) { let hit = false; for (const P of cy[i][layer]) for (const Q of cy[j][layer]) if (polysOverlap(P, Q)) hit = true; if (hit) { const [x, y] = boxCenter(fps[i].bbox!, fps[j].bbox!); out.push(marker("courtyards_overlap", "error", x, y, `Courtyards overlap (${fps[i].ref || "footprint"} and ${fps[j].ref || "footprint"} on ${layer})`, [fps[i].id, fps[j].id])); } }
  }
  // outline
  const ol = boardOutline(doc);
  if (!ol.hasEdges && opts.outline !== false) {
    // testOutline: no Edge.Cuts drawing at all, marked at the centre of BOARD::GetBoundingBox (every item)
    let b: Box | null = null; for (const it of doc.items.values()) { const q = it.bbox; if (!q || !isFinite(q[0])) continue; b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : [q[0], q[1], q[2], q[3]]; }
    out.push(marker("invalid_outline", "error", b ? (b[0] + b[2]) / 2 : 0, b ? (b[1] + b[3]) / 2 : 0, "Board has malformed outline (no edges found on Edge.Cuts layer)", []));
  }
  else if (ol.hasEdges && !ol.outline) { const e = edges.shapes[0] as { a?: Pt; pts: Pt[] }; const p = e.a || e.pts[0]; out.push(marker("invalid_outline", "error", p[0], p[1], "Board has malformed outline (Edge.Cuts does not close)", [])); }
  else if (ol.outline && opts.outline !== false) {
    // DRC_TEST_PROVIDER_EDGE_CLEARANCE::testCopperOutsideBoard: copper that does not touch the board at all
    const seen = new Set<string>(); const board = { t: "poly" as const, pts: ol.outline };
    for (const c of nl.conductors) {
      const key = c.kind === "pad" ? c.id + ":" + c.index : c.id;   // one marker per pad, not per footprint
      if (seen.has(key) || c.kind === "zone") continue;
      if (boxesTouch(c.bbox, shapeBBox(board), 0) && shapeGap(c.shape, board) <= EPS) continue;
      seen.add(key); const p = c.kind === "pad" ? [c.pad!.x, c.pad!.y] : c.anchors[0];
      out.push(withKiids(marker("copper_outside_board", "warning", p[0], p[1], "Copper outside board outline", [c.id]), [uid(c)]));
    }
  }
  // hole to hole, text dimensions and mirroring, courtyard definitions and holes in courtyards, Edge.Cuts text,
  // keepout areas and disabled layers (drc-more.ts)
  out.push(...moreDrcMarkers(doc, s, rules));
  // silkscreen overlaps, silk clipped by mask or by the board edge, solder mask bridges (drc-silk.ts)
  out.push(...silkMaskMarkers(doc, s, rules));
  // thermal reliefs short of spokes (drc-zones.ts)
  out.push(...starvedThermalMarkers(doc, s, rules, nl.conductors), ...isolatedCopperMarkers(doc, nl.conductors));
  // Junction's rule: a footprint is drawn the way its maker wants it, so what lies wholly inside one footprint (its own pads,
  // holes, mask and silk, its courtyard) is not reported.  Anything the layout causes (another item, the edge, a keep-out) still is.
  const inOne = (m: DrcMarker) => m.ids.length > 0 && m.ids.every((id) => id === m.ids[0]) && (doc.items.get(m.ids[0]) as KItem | undefined)?.kind === "footprint";
  // (the Design Rules Checker dialog passes footprintOwn: true to list them as KiCad does)
  const kept = opts.footprintOwn ? out : out.filter((m) => !(FOOTPRINT_OWN.has(m.code) && inOne(m)));
  // the project's rule severities: ignored rules drop out, the rest take the severity the project gives them
  return kept.filter((m) => s.severities[m.code] !== "ignore").map((m) => { const sev = s.severities[m.code]; if (sev === "warning" || sev === "error") m.severity = sev; return m; });
}
