// pcb-tools/global-tracks.ts — DIALOG_GLOBAL_EDIT_TRACKS_AND_VIAS::TransferDataFromWindow / visitItem / processItem
// (pcbnew/dialogs/dialog_global_edit_tracks_and_vias.cpp): Edit > Edit Track & Via Properties... on board nodes.
// The scope picks tracks (and arcs) and the four via types; the filters keep items of a net, a net class, on a
// layer, of one track width or via diameter, or selected; the action either sets the specified values (layer,
// pre-defined track width, pre-defined via size, annular rings, IPC-4761 protection) or the sizes the net class /
// custom rules give (PCB_EDIT_FRAME::SetTrackSegmentWidth with aUseDesignRules).  Plain node editing.
import type { BoardDoc, DesignSettings, PcbChange } from "./types";
import { K, S } from "./state";
import { netclassOf, netclassName } from "./drc";
import { netName, viaTypeOf } from "./dru-eval";
import { evalRuleConstraint } from "./dru";
import { pinnedOpt, routedRuleItem } from "./rule-resolver";
import { replacedChange } from "./changes";
import { clone, r6 } from "./util";
import { setAnnularMode, setProtectionPreset } from "../../editor/pcbdialogs/track-via-model";

export interface GlobalTracksScope { tracks?: boolean; throughVias?: boolean; microVias?: boolean; blindVias?: boolean; buriedVias?: boolean }
export interface GlobalTracksFilter {
  net?: string | null; netclass?: string | null; layer?: string | null;
  /** m_filterByTrackWidth / m_filterByViaSize: the exact width or diameter in mm */
  trackWidth?: number | null; viaDiameter?: number | null;
  /** m_selectedItemsFilter: the selected ids with their groups' members already added */
  selection?: Set<string> | null;
}
/** Set to specified values: each null / undefined is "-- leave unchanged --". */
export interface GlobalTracksValues {
  layer?: string | null; trackWidth?: number | null; via?: { diameter: number; drill: number } | null;
  /** m_annularRingsCtrl: 0 All copper layers, 1 Start, end, and connected layers, 2 Connected layers only, 3 Start and end layers only */
  annular?: number | null;
  /** m_protectionFeatures: an index into IPC4761 (track-via-model.ts) */
  protection?: number | null;
}
export interface GlobalTracksJob { scope: GlobalTracksScope; filter: GlobalTracksFilter; specified: boolean; values: GlobalTracksValues; settings: DesignSettings }

const near = (a: number, b: number) => Math.abs(a - b) < 5e-7;   // the board's 1 nm grid
const kidNum = (n: SNode, key: string, d = 0) => { const c = K.kid(n, key); return c && typeof c[1] === "number" ? c[1] as number : d; };
/** PCB_TRACK::GetLayer: a track's layer, a via's top layer. */
function layerOf(n: SNode): string { const l = K.kid(n, n[0] === "via" ? "layers" : "layer"); return l ? K.str(l[1]) : ""; }

/** MINOPTMAX from the custom rules for a track / via of the item's net, else the net class value (GetWidthConstraint / GetDrillConstraint). */
function ruleSize(doc: BoardDoc, s: DesignSettings, n: SNode, type: "track_width" | "via_diameter" | "hole_size", fallback: number | undefined): number | undefined {
  const d = S.dru;
  if (d && d.rules.length) {
    const item = n[0] === "via" ? routedRuleItem({ kind: "via", net: netName(doc, n), layer: layerOf(n), size: kidNum(n, "size"), drill: kidNum(n, "drill") })
      : routedRuleItem({ kind: n[0] === "arc" ? "arc" : "segment", net: netName(doc, n), layer: layerOf(n), width: kidNum(n, "width") });
    item.node = n;   // the item itself, so A.Type, A.Via_Type and friends read what it is
    const hit = evalRuleConstraint(d.rules, type, doc, s, item, null);
    if (hit) { const v = pinnedOpt(hit); if (v != null && v > 0) return v; }
  }
  return fallback;
}
function setWidth(n: SNode, w: number): boolean {
  if (!(w > 0)) return false;
  const wn = K.kid(n, "width"); if (wn && near(K.num(wn[1]), w)) return false;
  if (wn) wn[1] = r6(w); else { const l = K.kid(n, "layer"); n.splice(l ? n.indexOf(l) : n.length, 0, ["width", r6(w)]); }
  return true;
}
function setViaSize(n: SNode, dia: number | undefined, drill: number | undefined): boolean {
  let did = false;
  if (dia && dia > 0) { const sn = K.kid(n, "size"); if (sn && !near(K.num(sn[1]), dia)) { sn[1] = r6(dia); did = true; } }
  if (drill && drill > 0) { const dn = K.kid(n, "drill"); if (dn && !near(K.num(dn[1]), drill)) { dn[1] = r6(drill); did = true; } }
  return did;
}
const parse = (t: string) => K.parse(t) as SNode;

/** visitItem's filters. */
export function passesTrackFilter(doc: BoardDoc, it: KItem, f: GlobalTracksFilter, s: DesignSettings): boolean {
  const n = it.node;
  if (f.selection && !f.selection.has(it.id)) return false;
  if (f.net != null && netName(doc, n) !== f.net) return false;
  if (f.netclass != null && netclassName(s, netName(doc, n)) !== f.netclass) return false;
  if (f.layer != null && layerOf(n) !== f.layer) return false;
  if (it.kind === "via") { if (f.viaDiameter != null && !near(kidNum(n, "size"), f.viaDiameter)) return false; }
  else if (f.trackWidth != null && !near(kidNum(n, "width"), f.trackWidth)) return false;
  return true;
}
/** processItem on a copy of the node: true when it changed. */
export function processTrackItem(doc: BoardDoc, it: KItem, n: SNode, job: GlobalTracksJob): boolean {
  const s = job.settings, v = job.values, isVia = it.kind === "via";
  const nc = netclassOf(s, netName(doc, n)) as Record<string, number | undefined>;
  const micro = isVia && viaTypeOf(n) === "micro";
  let did = false;
  if (job.specified) {
    if (!isVia && v.trackWidth != null) did = setWidth(n, v.trackWidth) || did;
    if (isVia && v.via) {
      // SetTrackSegmentWidth( …, false ): a microvia takes the net class's uvia sizes, the others the chosen size
      if (micro) did = setViaSize(n, ruleSize(doc, s, n, "via_diameter", nc.microvia_diameter), ruleSize(doc, s, n, "hole_size", nc.microvia_drill)) || did;
      else did = setViaSize(n, v.via.diameter, v.via.drill) || did;
    }
    if (isVia && v.annular != null) { const before = K.serialize(n); setAnnularMode(n, v.annular, parse); did = did || K.serialize(n) !== before; }
    if (isVia && v.protection != null) { const before = K.serialize(n); setProtectionPreset(n, v.protection, parse); did = did || K.serialize(n) !== before; }
    if (!isVia && v.layer) { const l = K.kid(n, "layer"); if (l && K.str(l[1]) !== v.layer) { l[1] = v.layer; did = true; } }
  } else if (isVia) {
    did = setViaSize(n, ruleSize(doc, s, n, "via_diameter", micro ? nc.microvia_diameter : nc.via_diameter), ruleSize(doc, s, n, "hole_size", micro ? nc.microvia_drill : nc.via_drill));
  } else {
    did = setWidth(n, ruleSize(doc, s, n, "track_width", nc.track_width) || 0);
  }
  return did;
}
/** TransferDataFromWindow: one replaced change per track or via the scope and the filters keep and the action changes. */
export function globalTrackViaChanges(doc: BoardDoc, job: GlobalTracksJob): PcbChange[] {
  const out: PcbChange[] = [], sc = job.scope;
  for (const it of doc.items.values()) {
    if (it.kind === "segment" || it.kind === "arc") { if (!sc.tracks) continue; }
    else if (it.kind === "via") {
      const t = viaTypeOf(it.node);
      if (!(t === "micro" ? sc.microVias : t === "blind" ? sc.blindVias : t === "buried" ? sc.buriedVias : sc.throughVias)) continue;
    } else continue;
    if (!passesTrackFilter(doc, it, job.filter, job.settings)) continue;
    const n = clone(it.node);
    if (processTrackItem(doc, it, n, job)) out.push(replacedChange(it, n));
  }
  return out;
}
