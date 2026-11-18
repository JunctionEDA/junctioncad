// pcb-tools/inspect-constraints.ts — BOARD_INSPECTION_TOOL::InspectConstraints (pcbnew/tools/board_inspection_tool.cpp)
// for a track, an arc or a via: the pages (Track Width; Via Diameter, Via Annular Width, Hole Size) with the lines
// DRC_ENGINE::EvalRules reports while it walks the constraints of one type — the implicit board setup constraints,
// the item's net class, then the custom rules in file order, each applied one overriding the ones before — and the
// resolved min / opt / max.
import type { BoardDoc, DesignSettings } from "./types";
import { K, S } from "./state";
import { netclassName, netclassOf } from "./drc";
import { netName, viaTypeOf, type RuleItem } from "./dru-eval";
import { ruleMatches } from "./dru";

export interface ConstraintPage { title: string; header: string; item: string; lines: string[]; resolved: string }
interface MOM { min: number | null; opt: number | null; max: number | null }
type Fmt = (mm: number) => string;

const UNDEF = "<i>undefined</i>";
const kidNum = (n: SNode, key: string): number => { const c = K.kid(n, key); return c && typeof c[1] === "number" ? c[1] as number : 0; };
const layerOf = (n: SNode): string => { const l = K.kid(n, n[0] === "via" ? "layers" : "layer"); return l ? K.str(l[1]) : ""; };

/** BOARD_INSPECTION_TOOL::getItemDescription: GetItemDescription, then the net and its net class for a connected item. */
export function constraintItemDescription(doc: BoardDoc, it: KItem, s: DesignSettings, fmt: Fmt): string {
  const n = it.node, net = netName(doc, n), nc = netclassName(s, net);
  let msg: string;
  if (it.kind === "via") {
    const t = viaTypeOf(n), l = K.kid(n, "layers");
    const kind = t === "micro" ? "Micro via" : t === "blind" ? "Blind via" : t === "buried" ? "Buried via" : "Via";
    msg = `${kind} ${fmt(kidNum(n, "size"))} on ${l ? `${K.str(l[1])} - ${K.str(l[2])}` : ""}`;
  } else msg = `${it.kind === "arc" ? "Track (arc)" : "Track"} ${fmt(kidNum(n, "width"))} on ${layerOf(n)}`;
  return `${msg} [${net || "<no net>"}] (net class '${nc}')`;
}

/** One EvalRules pass with its report. */
function evalReport(doc: BoardDoc, s: DesignSettings, it: KItem, type: string, implicit: { name: string; v: Partial<MOM>; cond?: () => boolean }[], label: string, fmt: Fmt): { lines: string[]; c: MOM } {
  const lines: string[] = [], c: MOM = { min: null, opt: null, max: null };
  const apply = (v: Partial<MOM>): void => { if (v.min != null) c.min = v.min; if (v.opt != null) c.opt = v.opt; if (v.max != null) c.max = v.max; };
  for (const im of implicit) {
    lines.push("");
    // reportConstraintHeader, implicit: the opt when it has one, else the min (annular width: its min)
    lines.push(im.v.opt != null ? `Checking ${im.name} ${label}: opt ${fmt(im.v.opt)}.` : `Checking ${im.name} ${label}: min ${fmt(im.v.min ?? 0)}.`);
    if (!im.cond) { lines.push("Unconditional constraint applied."); apply(im.v); }
    else if (im.cond()) { lines.push("Constraint applied."); apply(im.v); }
    else lines.push("Membership not satisfied; constraint ignored.");
  }
  const rules = S.dru ? S.dru.rules : [];
  const A: RuleItem = { kind: it.kind, node: it.node, layer: layerOf(it.node), item: it, id: it.id };
  for (const r of rules) {
    const k = r.constraints.find((x) => x.type === type); if (!k) continue;
    lines.push("");
    lines.push(`Checking rule '${r.name}': min ${k.min != null ? fmt(k.min) : UNDEF}; opt ${k.opt != null ? fmt(k.opt) : UNDEF}; max ${k.max != null ? fmt(k.max) : UNDEF}.`);
    if (r.error) { lines.push("Rule could not be compiled; rule ignored."); continue; }
    if (r.layer && !ruleMatches({ ...r, expr: null }, doc, s, A, null)) { lines.push(`Rule layer '${r.layer}' not matched; rule ignored.`); continue; }
    if (!r.condition.trim()) { lines.push("Unconditional rule applied; overrides previous constraints."); apply(k); continue; }
    lines.push(`Checking rule condition '${r.condition}'.`);
    if (ruleMatches(r, doc, s, A, null)) { lines.push("Rule applied; overrides previous constraints."); apply(k); }
    else lines.push("Condition not satisfied; rule ignored.");
  }
  return { lines, c };
}

/** The Constraints Report's pages for the item, or null when it is not a track, an arc or a via. */
export function inspectConstraints(doc: BoardDoc, id: string, s: DesignSettings, fmt: Fmt = (v) => `${+v.toFixed(4)} mm`): ConstraintPage[] | null {
  const it = doc.items.get(id); if (!it) return null;
  const n = it.node, net = netName(doc, n), ncName = netclassName(s, net), nc = netclassOf(s, net) as Record<string, number | undefined>;
  const micro = it.kind === "via" && viaTypeOf(n) === "micro";
  const isMicro = (): boolean => micro;
  const item = constraintItemDescription(doc, it, s, fmt);
  const resolved = (what: string, c: MOM): string => `Resolved ${what} constraints: min ${c.min != null ? fmt(c.min) : UNDEF}; opt ${c.opt != null ? fmt(c.opt) : UNDEF}; max ${c.max != null ? fmt(c.max) : UNDEF}.`;
  const page = (title: string, header: string, type: string, label: string, what: string, implicit: { name: string; v: Partial<MOM>; cond?: () => boolean }[]): ConstraintPage => {
    const r = evalReport(doc, s, it, type, implicit, label, fmt);
    return { title, header, item, lines: r.lines, resolved: resolved(what, r.c) };
  };
  const BS = "board setup constraints", NC = `netclass '${ncName}'`;
  const has = (v: number | undefined): v is number => typeof v === "number" && v > 0;
  if (it.kind === "segment" || it.kind === "arc") {
    const im: { name: string; v: Partial<MOM>; cond?: () => boolean }[] = [{ name: BS, v: { min: s.minTrackWidth || 0 } }];
    if (has(nc.track_width)) im.push({ name: NC, v: { opt: nc.track_width }, cond: () => true });
    return [page("Track Width", "Track width resolution for:", "track_width", "track width", "width", im)];
  }
  if (it.kind === "via") {
    // createImplicitRule( board setup constraints ) and ( board setup constraints micro-via ) with A.Via_Type == 'Micro'
    const dia: { name: string; v: Partial<MOM>; cond?: () => boolean }[] = [{ name: BS, v: { min: s.minViaDiameter || 0 } }, { name: "board setup constraints micro-via", v: { min: s.minMicroViaDiameter || 0 }, cond: isMicro }];
    const hole: { name: string; v: Partial<MOM>; cond?: () => boolean }[] = [{ name: BS, v: { min: s.minThroughDrill || 0 } }, { name: "board setup constraints micro-via", v: { min: s.minMicroViaDrill || 0 }, cond: isMicro }];
    if (micro) { if (has(nc.microvia_diameter)) dia.push({ name: `${NC} uvia`, v: { opt: nc.microvia_diameter }, cond: () => true }); if (has(nc.microvia_drill)) hole.push({ name: `${NC} uvia`, v: { opt: nc.microvia_drill }, cond: () => true }); }
    else { if (has(nc.via_diameter)) dia.push({ name: NC, v: { opt: nc.via_diameter }, cond: () => true }); if (has(nc.via_drill)) hole.push({ name: NC, v: { opt: nc.via_drill }, cond: () => true }); }
    return [
      page("Via Diameter", "Via diameter resolution for:", "via_diameter", "via diameter", "diameter", dia),
      page("Via Annular Width", "Via annular width resolution for:", "annular_width", "annular width", "annular width", [{ name: BS, v: { min: s.minViaAnnular || 0 } }]),
      page("Hole Size", "Hole size resolution for:", "hole_size", "hole size", "hole size", hole),
    ];
  }
  return null;
}
