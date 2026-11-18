// dialogs/update-from-pcb-logic.ts — BACK_ANNOTATE (eeschema/tools/backannotate.cpp) on plain data: the board's
// footprints matched to the schematic's symbols by their path (or, re-linking, by reference designator), and the
// changes Tools > Update Schematic from PCB... lists and applies: references, footprint assignments, values, the
// attribute flags, the other fields, and the net labels whose net was renamed on the board.

export interface BaOptions {
  relink: boolean; references: boolean; footprints: boolean; values: boolean; netNames: boolean; attributes: boolean; otherFields: boolean;
  /** m_preferUnitSwaps / m_preferPinSwaps: gate and pin swaps on the board become symbol unit / pin swaps, not label changes */
  unitSwaps?: boolean; pinSwaps?: boolean;
  /** EESCHEMA_SETTINGS input.allow_unconstrained_pin_swaps (a pin swap is only reported without it) */
  allowPinSwaps?: boolean;
}
/** One placed unit of a symbol: its path, the unit it shows, and per unit number the library's pins (GetUnitPinInfo:
 *  the unit's pins with the common ones, ordered by position) with their electrical types. */
export interface SymUnit { key: string; unit: number; unitPins: Map<number, string[]>; pinTypes: Map<string, string>; shared?: boolean }
/** A footprint as PCB_EDIT_FRAME's back-annotation netlist describes it. */
export interface FpData {
  ref: string; path: string; fpid: string; value: string;
  dnp: boolean; excludeFromBom: boolean; excludeFromPos: boolean;
  /** every field except Reference and Value */
  fields: Map<string, string>;
  /** pad number -> board net name */
  pads: Map<string, string>;
}
/** One schematic symbol instance (all units share it; `units` are the items to edit). */
export interface SymRef {
  /** the first unit's path ("/<sheet uuid>…/<symbol uuid>"), what a footprint's (path) names; `keys` every unit's */
  key: string; keys: string[]; ref: string; power: boolean;
  value: string; footprint: string; dnp: boolean; inBom: boolean; inPos: boolean; onBoard: boolean;
  /** non-mandatory fields */
  fields: Map<string, string>;
  /** pin number -> schematic net name */
  pins: Map<string, string>;
  /** the placed units, for unit and pin swaps */
  units?: SymUnit[];
}
export interface BaLine { severity: "error" | "warning" | "action" | "info"; text: string }
export interface SymEdit {
  key: string; ref?: string; footprint?: string; value?: string; dnp?: boolean; inBom?: boolean; inPos?: boolean;
  setFields: Map<string, string>; addFields: Map<string, string>; deleteFields: string[];
}
export interface LabelEdit { from: string; to: string; ref: string; pin: string }
/** a unit swap: the placed unit `key` shows unit `unit` from now on */
export interface UnitEdit { key: string; unit: number }
/** a pin swap: pins `a` and `b` of the placed unit `key` trade their positions (SwapPinGeometry) */
export interface PinSwap { key: string; a: string; b: string }

const MANDATORY = new Set(["Reference", "Value", "Footprint", "Datasheet", "Description"]);
const hasVars = (s: string): boolean => /\$\{[^}]*\}/.test(s);
const tf = (b: boolean): string => (b ? "true" : "false");
/** DescribeRef: "R1", or "<no reference designator>" */
export const describeRef = (r: string): string => (r ? r : "<no reference designator>");
/** A board net named after a pad ("Net-(R1-Pad2)", "unconnected-(…)") was not named by anyone. */
const autoNet = (n: string): boolean => /^(Net-\(|unconnected-\()/.test(n) || n === "";

/** BackAnnotateSymbols: the report and the edits, for the dry run and the update alike. */
export interface BaResult { lines: BaLine[]; edits: SymEdit[]; labels: LabelEdit[]; relinks: { fpRef: string; path: string }[]; changes: number; unitEdits: UnitEdit[]; pinSwaps: PinSwap[] }
export function backAnnotate(syms: SymRef[], fps: FpData[], o: BaOptions): BaResult {
  const lines: BaLine[] = [], edits: SymEdit[] = [], labels: LabelEdit[] = [], relinks: { fpRef: string; path: string }[] = [], unitEdits: UnitEdit[] = [], pinSwaps: PinSwap[] = [];
  let changes = 0;
  if (!o.relink && !o.values && !o.footprints && !o.references && !o.netNames && !o.attributes && !o.otherFields) {
    lines.push({ severity: "error", text: "Select at least one property to back annotate." });
    return { lines, edits, labels, relinks, changes, unitEdits, pinSwaps };
  }
  const refs = syms.filter((s) => !s.power);
  const byKey = new Map<string, SymRef>(); for (const s of refs) for (const k of s.keys) byKey.set(k, s);
  const byRef = new Map<string, SymRef>(); for (const s of refs) if (!byRef.has(s.ref)) byRef.set(s.ref, s);
  // getPcbModulesFromString / getChangeList
  const linked = new Map<SymRef, FpData>();
  const used = new Map<SymRef, FpData>();
  for (const fp of fps) {
    const path = o.relink ? fp.ref : fp.path;
    if (!path) { lines.push({ severity: "warning", text: `Footprint '${describeRef(fp.ref)}' has no assigned symbol.` }); continue; }
    const s = o.relink ? byRef.get(fp.ref) : byKey.get(fp.path);
    if (!s) { lines.push({ severity: "error", text: `Cannot find symbol for footprint '${describeRef(fp.ref)}'.` }); continue; }
    const other = used.get(s);
    if (other) { lines.push({ severity: "error", text: `Footprints '${describeRef(other.ref)}' and '${describeRef(fp.ref)}' linked to same symbol.` }); continue; }
    used.set(s, fp); linked.set(s, fp);
    if (o.relink && fp.path !== s.key) relinks.push({ fpRef: fp.ref, path: s.key });
  }
  // checkForUnusedSymbols
  for (const s of refs) if (!linked.has(s) && s.onBoard) lines.push({ severity: "warning", text: `Footprint '${describeRef(s.ref)}' is not present on PCB. Corresponding symbols in schematic must be manually deleted (if desired).` });
  // applyChangelist
  // the references after the update: a footprint's new reference may not land on another symbol's
  const finalRef = new Map<SymRef, string>(); for (const s of refs) finalRef.set(s, o.references && !o.relink && linked.has(s) ? linked.get(s)!.ref : s.ref);
  const count = new Map<string, number>(); for (const r of finalRef.values()) count.set(r, (count.get(r) || 0) + 1);
  // applyChangelist: unit swaps first (they change which pins the label pass looks at)
  const skipPins = new Map<SymRef, Set<string>>();
  if (o.netNames && o.unitSwaps) {
    for (const [s, fp] of linked) {
      const plan = unitSwapPlan(s, fp); if (!plan) continue;
      const skip = new Set<string>();
      for (const st of plan) {
        lines.push({ severity: "action", text: `Swap ${describeRef(s.ref)} unit ${unitLetter(st.aUnit)} with unit ${unitLetter(st.bUnit)}.` }); changes++;
        unitEdits.push({ key: st.a.key, unit: st.bUnit }, { key: st.b.key, unit: st.aUnit });
        // the swapped units' symbols are SKIP_STRUCT: no label changes for their pins
        for (const u of [st.a, st.b]) for (const list of u.unitPins.values()) for (const n of list) skip.add(n);
      }
      skipPins.set(s, skip);
    }
  }
  for (const [s, fp] of linked) {
    const e: SymEdit = { key: s.key, setFields: new Map(), addFields: new Map(), deleteFields: [] };
    let any = false;
    if (o.references && !o.relink && s.ref !== fp.ref && !hasVars(s.ref)) {
      if ((count.get(fp.ref) || 0) > 1) lines.push({ severity: "error", text: `Cannot change ${s.ref} to '${fp.ref}', because the change will cause duplicated references.` });
      else { changes++; any = true; e.ref = fp.ref; lines.push({ severity: "action", text: `Change ${describeRef(s.ref)} reference designator to '${fp.ref}'.` }); }
    }
    const R = s.ref;
    if (o.footprints && s.footprint !== fp.fpid && !hasVars(s.footprint)) { changes++; any = true; e.footprint = fp.fpid; lines.push({ severity: "action", text: `Change ${describeRef(R)} footprint assignment from '${s.footprint}' to '${fp.fpid}'.` }); }
    if (o.values && s.value !== fp.value && !hasVars(s.value)) { changes++; any = true; e.value = fp.value; lines.push({ severity: "action", text: `Change ${describeRef(R)} value from '${s.value}' to '${fp.value}'.` }); }
    if (o.attributes && s.dnp !== fp.dnp) { changes++; any = true; e.dnp = fp.dnp; lines.push({ severity: "action", text: `Change ${describeRef(R)} 'Do not populate' from '${tf(s.dnp)}' to '${tf(fp.dnp)}'.` }); }
    if (o.attributes && !s.inBom !== fp.excludeFromBom) { changes++; any = true; e.inBom = !fp.excludeFromBom; lines.push({ severity: "action", text: `Change ${describeRef(R)} 'Exclude from bill of materials' from '${tf(!s.inBom)}' to '${tf(fp.excludeFromBom)}'.` }); }
    if (o.attributes && !s.inPos !== fp.excludeFromPos) { changes++; any = true; e.inPos = !fp.excludeFromPos; lines.push({ severity: "action", text: `Change ${describeRef(R)} 'Exclude from position files' from '${tf(!s.inPos)}' to '${tf(fp.excludeFromPos)}'.` }); }
    // applyPinSwaps: reciprocal pad net swaps become pin swaps before the labels are looked at
    const swapped = o.pinSwaps && o.netNames ? pinSwapsFor(s, fp, !!o.allowPinSwaps, skipPins.get(s), lines, pinSwaps) : new Set<string>();
    changes += swapped.size / 2;
    if (o.netNames) {
      const skip = skipPins.get(s);
      for (const [pad, boardNet] of fp.pads) {
        if (swapped.has(pad) || (skip && skip.has(pad))) continue;
        const schNet = s.pins.get(pad);
        if (schNet === undefined) continue;
        if (schNet === boardNet || autoNet(boardNet) || autoNet(schNet) || labels.some((l) => l.from === schNet)) continue;
        changes++; labels.push({ from: schNet, to: boardNet, ref: R, pin: pad });
        lines.push({ severity: "action", text: `Change ${describeRef(R)} pin ${pad} net label from '${schNet}' to '${boardNet}'.` });
      }
    }
    if (o.otherFields) {
      for (const [name, val] of fp.fields) {
        if (name === "Reference" || name === "Value" || name === "Footprint") continue;
        const cur = s.fields.get(name);
        if (cur !== undefined && !hasVars(cur) && cur !== val) { changes++; any = true; e.setFields.set(name, val); lines.push({ severity: "action", text: `Change ${describeRef(R)} field '${name}' value to '${val}'.` }); }
        if (cur === undefined && !MANDATORY.has(name)) { changes++; any = true; e.addFields.set(name, val); lines.push({ severity: "action", text: `Add ${describeRef(R)} field '${name}' with value '${val}'.` }); }
      }
      for (const name of s.fields.keys()) if (!MANDATORY.has(name) && !fp.fields.has(name)) { changes++; any = true; e.deleteFields.push(name); lines.push({ severity: "action", text: `Delete ${describeRef(R)} field '${name}.'` }); }
    }
    if (any) edits.push(e);
  }
  return { lines, edits, labels, relinks, changes, unitEdits, pinSwaps };
}

/** LIB_SYMBOL::LetterSubReference / SubReference( unit, false ): A … Z, AA … */
function unitLetter(unit: number): string { let n = unit, out = ""; while (n > 0) { n--; out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26); } return out || String(unit); }
const netsInUnitOrder = (pins: string[], net: (p: string) => string): string[] => pins.map(net);
const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * PlanBackannotateUnitSwaps over the placed units of one footprint: each unit's board nets (in its unit's pin order)
 * must match some unit's schematic nets; the mapping's cycles become pairwise swaps.  Null: nothing to do.
 */
export function unitSwapPlan(s: SymRef, fp: FpData): { a: SymUnit; b: SymUnit; aUnit: number; bUnit: number }[] | null {
  const units = (s.units || []).slice().sort((x, y) => x.unit - y.unit);
  if (units.length < 2) return null;
  const pinsOf = (u: SymUnit, unit: number): string[] => u.unitPins.get(unit) || [];
  const target = new Map<number, number>(), used = new Set<number>();
  for (let i = 0; i < units.length; i++) {
    const pcb = netsInUnitOrder(pinsOf(units[i], units[i].unit), (p) => fp.pads.get(p) || "");
    let hit = -1;
    for (let j = 0; j < units.length; j++) {
      if (used.has(j)) continue;
      const sch = netsInUnitOrder(pinsOf(units[j], units[j].unit), (p) => s.pins.get(p) || "");
      if (sameList(pcb, sch)) { hit = j; break; }
    }
    if (hit < 0) return null;   // !m_mappingOk
    target.set(i, hit); used.add(hit);
  }
  if ([...target].every(([i, j]) => i === j)) return null;   // m_identity
  const steps: { a: SymUnit; b: SymUnit; aUnit: number; bUnit: number }[] = [], visited = new Set<number>();
  const cur = units.map((u) => u.unit);
  for (let start = 0; start < units.length; start++) {
    if (visited.has(start)) continue;
    const cycle: number[] = []; let i = start;
    while (!visited.has(i)) { visited.add(i); cycle.push(i); const n = target.get(i); if (n === undefined || n === i) break; i = n; }
    if (cycle.length < 2) continue;
    for (let k = cycle.length - 1; k > 0; k--) {
      const a = cycle[k - 1], b = cycle[k], aUnit = cur[a], bUnit = cur[b];
      steps.push({ a: units[a], b: units[b], aUnit, bUnit });
      cur[a] = bUnit; cur[b] = aUnit;
    }
  }
  return steps.length ? steps : null;
}

/**
 * BACK_ANNOTATE::applyPinSwaps for each placed unit: two pins of one unit whose board nets are each other's schematic
 * nets swap places (power pins left out).  Without "Allow unconstrained pin swaps", or on a symbol shared by several
 * sheet instances, the swap is only reported and the labels are changed as usual.  Returns the pins swapped.
 */
function pinSwapsFor(s: SymRef, fp: FpData, allow: boolean, skip: Set<string> | undefined, lines: BaLine[], out: PinSwap[]): Set<string> {
  const swapped = new Set<string>();
  for (const u of s.units || []) {
    const pins = u.unitPins.get(u.unit) || [];
    const mism: { pin: string; cur: string; want: string }[] = [];
    for (const [pin, want] of fp.pads) {
      if (!pins.includes(pin) || (skip && skip.has(pin))) continue;
      const t = u.pinTypes.get(pin) || ""; if (t === "power_in" || t === "power_out") continue;
      const cur = s.pins.get(pin) || "";
      if (!want || !cur || want === cur) continue;
      mism.push({ pin, cur, want });
    }
    if (mism.length < 2) continue;
    const done = new Array(mism.length).fill(false);
    for (let i = 0; i < mism.length; i++) {
      if (done[i]) continue;
      const j = mism.findIndex((m, k) => k !== i && !done[k] && m.cur === mism[i].want && m.want === mism[i].cur);
      if (j < 0) continue;
      done[i] = done[j] = true;
      const a = mism[i].pin, b = mism[j].pin;
      if (!allow || u.shared) {
        lines.push({ severity: "info", text: u.shared ? `Would swap ${describeRef(s.ref)} pins ${a} and ${b} to match PCB, but the symbol is shared.`
          : `Would swap ${describeRef(s.ref)} pins ${a} and ${b} to match PCB, but unconstrained pin swaps are disabled in the schematic preferences.` });
        continue;
      }
      swapped.add(a); swapped.add(b); out.push({ key: u.key, a, b });
      lines.push({ severity: "action", text: `Swap ${describeRef(s.ref)} pins ${a} and ${b} to match PCB.` });
    }
  }
  return swapped;
}

/** LIB_SYMBOL::GetUnitPinInfo on a (flattened) library symbol: per unit, its pins and the common ones (any body style)
 *  ordered by position (x, then y downwards), each number once; with every pin's electrical type. */
export function libUnitPins(lib: N): { unitPins: Map<number, string[]>; pinTypes: Map<string, string> } {
  const subs = kids(lib, "symbol").map((sub) => { const m = /_(\d+)_(\d+)$/.exec(sv(sub[1])); return { unit: m ? +m[1] : 0, pins: kids(sub, "pin") }; });
  let count = 1; for (const sb of subs) count = Math.max(count, sb.unit);
  const unitPins = new Map<number, string[]>(), pinTypes = new Map<string, string>();
  for (let u = 1; u <= count; u++) {
    const list: { n: string; x: number; y: number }[] = [];
    for (const sb of subs) if (sb.unit === 0 || sb.unit === u) for (const p of sb.pins) {
      const num = kid(p, "number"), at = kid(p, "at"); if (!num) continue;
      const n = sv(num[1]); pinTypes.set(n, sv(p[1]));
      list.push({ n, x: at ? Number(at[1]) || 0 : 0, y: at ? -(Number(at[2]) || 0) : 0 });
    }
    list.sort((a, b) => a.x - b.x || a.y - b.y);
    const seen = new Set<string>(), nums: string[] = [];
    for (const p of list) if (!seen.has(p.n)) { seen.add(p.n); nums.push(p.n); }
    unitPins.set(u, nums);
  }
  return { unitPins, pinTypes };
}

/** SwapPinGeometry on the library copy: the two pins (in every body style of the unit's sub-symbols) trade position,
 *  orientation and length. */
export function swapLibPins(lib: N, unit: number, a: string, b: string): boolean {
  let any = false;
  for (const sub of kids(lib, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(sv(sub[1])); const u = m ? +m[1] : 0; if (u !== 0 && u !== unit) continue;
    const pins = kids(sub, "pin"), pa = pins.find((p) => sv((kid(p, "number") || [])[1]) === a), pb = pins.find((p) => sv((kid(p, "number") || [])[1]) === b);
    if (!pa || !pb) continue;
    for (const key of ["at", "length"]) {
      const ia = pa.findIndex((c) => isList(c) && c[0] === key), ib = pb.findIndex((c) => isList(c) && c[0] === key);
      if (ia < 0 || ib < 0) continue;
      const t = pa[ia]; pa[ia] = pb[ib]; pb[ib] = t;
    }
    any = true;
  }
  return any;
}

// ---------------------------------------------------------------- reading the board
type N = SNode;
const isList = Array.isArray;
const sv = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const kid = (n: N, k: string): N | null => { for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && c[0] === k) return c as N; } return null; };
const kids = (n: N, k: string): N[] => n.filter((c) => isList(c) && c[0] === k) as N[];
/** The footprint's data the back-annotation reads (its (path), fpid, fields, attributes and pad nets). */
export function fpData(fp: N): FpData {
  const fields = new Map<string, string>();
  let ref = "", value = "";
  for (const p of kids(fp, "property")) { const name = sv(p[1]), val = sv(p[2]); if (name === "Reference") ref = val; else if (name === "Value") value = val; else if (!/^ki_/.test(name) && !/^Sheet ?(file|name)$/i.test(name)) fields.set(name, val); }
  for (const t of kids(fp, "fp_text")) { if (sv(t[1]) === "reference" && !ref) ref = sv(t[2]); if (sv(t[1]) === "value" && !value) value = sv(t[2]); }
  const attr = kid(fp, "attr"), flags = attr ? attr.slice(1).map(sv) : [];
  const pads = new Map<string, string>();
  for (const pad of kids(fp, "pad")) { const num = sv(pad[1]), net = kid(pad, "net"); if (!num || !net) continue; const name = sv(net.length > 2 ? net[2] : net[1]); if (!pads.has(num)) pads.set(num, name); }
  const path = kid(fp, "path");
  return { ref, path: path ? sv(path[1]) : "", fpid: sv(fp[1]), value, dnp: flags.includes("dnp"), excludeFromBom: flags.includes("exclude_from_bom"), excludeFromPos: flags.includes("exclude_from_pos_files"), fields, pads };
}
