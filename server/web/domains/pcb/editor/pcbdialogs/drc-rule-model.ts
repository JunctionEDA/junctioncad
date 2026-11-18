// pcbdialogs/drc-rule-model — the DRC Rule Editor's rule model (pcbnew/drc/rule_editor): the constraint types of
// buildRuleTreeNodes, DRC_RULE_LOADER + DRC_RE_PANEL_MATCHER (loadRules) and DRC_RULE_SAVER (rulesText).  A rule is
// fitted into a constraint panel only when the panel writes it back unchanged; anything else stays a Custom rule.  A
// rule nobody edited is saved as its original text, and the comments between rules are kept.
// ---------------------------------------------------------------- the constraint types (buildRuleTreeNodes)
type Panel = "num" | "int" | "minmax" | "minoptmax" | "viastyle" | "text" | "diffpair" | "matchlen" | "layers" | "orient" | "smdvias" | "custom";
export interface RuleType { id: string; label: string; code: string; panel: Panel; two: boolean; cat: string[]; unitless?: boolean; field?: string }
export const RULE_TYPES: RuleType[] = [
  { id: "MINIMUM_CLEARANCE", label: "Minimum clearance", code: "clearance", panel: "num", two: true, cat: ["Electrical", "Clearance"] },
  { id: "COPPER_TO_EDGE_CLEARANCE", label: "Copper to edge clearance", code: "edge_clearance", panel: "num", two: false, cat: ["Electrical", "Clearance"] },
  { id: "COURTYARD_CLEARANCE", label: "Courtyard clearance", code: "courtyard_clearance", panel: "num", two: true, cat: ["Electrical", "Clearance"] },
  { id: "PHYSICAL_CLEARANCE", label: "Physical clearance", code: "physical_clearance", panel: "num", two: true, cat: ["Electrical", "Clearance"] },
  { id: "CREEPAGE_DISTANCE", label: "Creepage distance", code: "creepage", panel: "num", two: true, cat: ["Electrical", "Clearance"] },
  { id: "MINIMUM_CONNECTION_WIDTH", label: "Minimum connection width", code: "connection_width", panel: "num", two: false, cat: ["Electrical"] },
  { id: "COPPER_TO_HOLE_CLEARANCE", label: "Copper to hole clearance", code: "hole_clearance", panel: "num", two: true, cat: ["Electrical"] },
  { id: "MINIMUM_THERMAL_RELIEF_SPOKE_COUNT", label: "Minimum thermal relief spoke count", code: "min_resolved_spokes", panel: "int", two: false, cat: ["Electrical"], unitless: true },
  { id: "MINIMUM_ANNULAR_WIDTH", label: "Minimum annular width", code: "annular_width", panel: "num", two: false, cat: ["Manufacturability"] },
  { id: "MINIMUM_DRILL_SIZE", label: "Minimum drill size", code: "hole_size", panel: "num", two: false, cat: ["Manufacturability", "Hole"] },
  { id: "HOLE_TO_HOLE_DISTANCE", label: "Hole to hole distance", code: "hole_to_hole", panel: "num", two: true, cat: ["Manufacturability", "Hole"] },
  { id: "VIA_STYLE", label: "Via style", code: "via_style", panel: "viastyle", two: false, cat: ["Manufacturability", "Hole"] },
  { id: "HOLE_ASPECT_RATIO", label: "Maximum aspect ratio", code: "hole_aspect_ratio", panel: "int", two: false, cat: ["Manufacturability", "Hole"], unitless: true },
  { id: "MICROVIA_STACK_DEPTH", label: "Maximum stack depth", code: "microvia_stack_depth", panel: "int", two: false, cat: ["Manufacturability", "Microvia"], unitless: true },
  { id: "MINIMUM_TEXT_HEIGHT_AND_THICKNESS", label: "Minimum text height and thickness", code: "text_height", panel: "text", two: false, cat: ["Manufacturability"] },
  { id: "SILK_TO_SILK_CLEARANCE", label: "Silk to silk clearance", code: "silk_clearance", panel: "num", two: true, cat: ["Manufacturability"] },
  { id: "SILK_TO_SOLDERMASK_CLEARANCE", label: "Silk to soldermask clearance", code: "silk_clearance", panel: "num", two: true, cat: ["Manufacturability"] },
  { id: "MINIMUM_SOLDERMASK_SLIVER", label: "Minimum soldermask sliver", code: "solder_mask_sliver", panel: "num", two: false, cat: ["Manufacturability"] },
  { id: "SOLDERMASK_EXPANSION", label: "Soldermask expansion", code: "solder_mask_expansion", panel: "num", two: false, cat: ["Manufacturability"] },
  { id: "SOLDERPASTE_EXPANSION", label: "Solderpaste expansion", code: "solder_paste_abs_margin", panel: "num", two: false, cat: ["Manufacturability"] },
  { id: "ROUTING_WIDTH", label: "Routing width", code: "track_width", panel: "minoptmax", two: false, cat: ["Highspeed design"] },
  { id: "MAXIMUM_VIA_COUNT", label: "Maximum via count", code: "via_count", panel: "int", two: false, cat: ["Highspeed design"], unitless: true },
  { id: "ROUTING_DIFF_PAIR", label: "Routing diff pair", code: "diff_pair_gap", panel: "diffpair", two: false, cat: ["Highspeed design"] },
  { id: "MATCHED_LENGTH_DIFF_PAIR", label: "Matched length diff pair", code: "length", panel: "matchlen", two: false, cat: ["Highspeed design"] },
  { id: "ABSOLUTE_LENGTH", label: "Absolute length", code: "length", panel: "minmax", two: false, cat: ["Highspeed design"] },
  { id: "PERMITTED_LAYERS", label: "Permitted layers", code: "permitted_layers", panel: "layers", two: false, cat: ["Footprints"] },
  { id: "ALLOWED_ORIENTATION", label: "Allowed orientation", code: "allowed_orientation", panel: "orient", two: false, cat: ["Footprints"] },
  { id: "VIAS_UNDER_SMD", label: "Vias under SMD", code: "disallow_via", panel: "smdvias", two: false, cat: ["Footprints"] },
  { id: "CUSTOM_RULE", label: "Custom rule", code: "", panel: "custom", two: false, cat: ["Custom"] },
];
export const typeById = (id: string): RuleType => RULE_TYPES.find((t) => t.id === id) || RULE_TYPES[RULE_TYPES.length - 1];

// ---------------------------------------------------------------- the rule model
export type CondKind = "any" | "net" | "netclass" | "area" | "custom";
export interface Cond { op: "&&" | "||" | "&& !" | "|| !"; obj: "A" | "B"; kind: CondKind; value: string }
export interface Rule {
  type: string; name: string; comment: string; layer: string; severity: string; conds: Cond[]; v: Record<string, number | boolean | null>; text: string;
  /** the rule's text in the file it was loaded from, and what ruleText gave for it then: an untouched rule is saved as raw */
  raw?: string; gen?: string;
  /** the comment lines written above the rule in the file */
  lead?: string;
}
/** loadRules' result: the rules plus the comment lines after the last one */
export type RuleList = Rule[] & { trail?: string };

/** formatRuleName: quoted when it is a number or has characters other than letters, digits, _ - . */
export function formatRuleName(n: string): string {
  if (!n) return '""';
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(n) || !/^[\w.-]+$/.test(n)) return `"${n.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return n;
}
const num = (v: number): string => { let s = (Math.round(v * 1e6) / 1e6).toFixed(6); if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, ""); return s; };
const mm = (v: number | boolean | null | undefined): string => num(Number(v) || 0) + "mm";
/** DRC_RE_CONDITION_GROUP_PANEL::BuildCondition */
export function buildCondition(conds: Cond[], two: boolean): string {
  let out = "";
  for (const c of conds) {
    const p = two ? c.obj : "A";
    const e = c.kind === "net" ? (c.value ? `${p}.NetName == '${c.value}'` : "") : c.kind === "netclass" ? (c.value ? `${p}.hasNetclass('${c.value}')` : "") : c.kind === "area" ? (c.value ? `${p}.intersectsArea('${c.value}')` : "") : c.kind === "custom" ? c.value : "";
    if (!e) continue;
    if (out) out += c.op === "&&" ? " && " : c.op === "||" ? " || " : c.op === "&& !" ? " && !" : " || !";
    out += e;
  }
  return out;
}
/** ParseCondition / ParseExpression: top-level && / || parts become rows, anything else one Custom Query row */
export function parseCondition(expr: string): Cond[] {
  const s = expr.trim(); if (!s) return [{ op: "&&", obj: "A", kind: "any", value: "" }];
  const parts: { op: Cond["op"]; e: string }[] = []; let depth = 0, q = "", start = 0, op: Cond["op"] = "&&";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ""; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === "(") depth++; else if (c === ")") depth--;
    else if (depth === 0 && (s.startsWith("&&", i) || s.startsWith("||", i))) {
      parts.push({ op, e: s.slice(start, i).trim() });
      op = s[i] === "&" ? "&&" : "||"; i += 2; while (s[i] === " ") i++;
      if (s[i] === "!") { op = op === "&&" ? "&& !" : "|| !"; i++; }
      start = i; i--;
    }
  }
  parts.push({ op, e: s.slice(start).trim() });
  const rows: Cond[] = [];
  for (const p of parts) {
    let m: RegExpExecArray | null;
    if ((m = /^([AB])\.NetName\s*==\s*'([^']*)'$/.exec(p.e))) rows.push({ op: p.op, obj: m[1] as "A" | "B", kind: "net", value: m[2] });
    else if ((m = /^([AB])\.hasNetclass\('([^']*)'\)$/.exec(p.e))) rows.push({ op: p.op, obj: m[1] as "A" | "B", kind: "netclass", value: m[2] });
    else if ((m = /^([AB])\.intersectsArea\('([^']*)'\)$/.exec(p.e))) rows.push({ op: p.op, obj: m[1] as "A" | "B", kind: "area", value: m[2] });
    else rows.push({ op: p.op, obj: "A", kind: "custom", value: p.e });   // ParseExpression: no match -> CUSTOM
  }
  return rows;
}
/** The constraint clauses of a rule (GetConstraintClauses of each *_CONSTRAINT_DATA) */
export function constraintClauses(r: Rule): string[] {
  const t = typeById(r.type), v = r.v;
  // a bound left empty is not written (a rule read with only (min …) keeps only its min)
  const bnd = (k: string, key: string): string => (v[key] === null || v[key] === undefined ? "" : ` (${k} ${mm(v[key])})`);
  const mmm = (code: string, a: string, b: string, c: string): string => `(constraint ${code}${bnd("min", a)}${bnd("opt", b)}${bnd("max", c)})`;
  switch (t.panel) {
    case "num": return [`(constraint ${t.code} (min ${mm(v.value)}))`];
    case "int": return t.code === "min_resolved_spokes" ? [`(constraint ${t.code} ${num(Number(v.value) || 0)})`] : [`(constraint ${t.code} (max ${num(Number(v.value) || 0)}))`];
    case "minmax": return [`(constraint ${t.code}${bnd("min", "min")}${bnd("max", "max")})`];
    case "minoptmax": return [mmm(t.code, "min", "opt", "max")];
    case "viastyle": return [mmm("via_diameter", "dmin", "dopt", "dmax"), mmm("hole_size", "hmin", "hopt", "hmax")];
    case "text": return [`(constraint text_height (min ${mm(v.height)}))`, `(constraint text_thickness (min ${mm(v.thickness)}))`];
    case "diffpair": return [mmm("track_width", "wmin", "wopt", "wmax"), mmm("diff_pair_gap", "gmin", "gopt", "gmax"), `(constraint diff_pair_uncoupled${bnd("max", "uncoupled")})`];
    case "matchlen": return [mmm("length", "min", "opt", "max"), `(constraint skew${bnd("max", "skew")}${v.within ? " (within_diff_pairs)" : ""})`];
    case "layers": { const a = [v.top ? "A.Layer == 'F.Cu'" : "", v.bottom ? "A.Layer == 'B.Cu'" : ""].filter(Boolean); return a.length ? [`(constraint assertion "${a.join(" || ")}")`] : []; }
    case "orient": { const a = [0, 90, 180, 270].filter((d) => v["o" + d]).map((d) => `A.Orientation == ${d} deg`); return a.length ? [`(constraint assertion "${a.join(" || ")}")`] : []; }
    case "smdvias": {
      const ks = [["through", "through_via"], ["micro", "micro_via"], ["blind", "blind_via"], ["buried", "buried_via"]].filter(([k]) => v[k]);
      return !ks.length ? [] : ks.length === 4 ? ["(constraint disallow via)"] : [`(constraint disallow ${ks.map(([, c]) => c).join(" ")})`];
    }
    default: return [];
  }
}
/** buildRule: (rule name, the comment lines as # comments, the layer, the clauses, the condition) */
export function ruleText(r: Rule): string {
  const t = typeById(r.type);
  if (t.panel === "custom") return r.text.trim();
  let s = `(rule ${formatRuleName(r.name)}\n`;
  for (const line of r.comment.split("\n")) if (line) s += `\t# ${line}\n`;
  if (r.layer) s += `\t(layer ${/^(outer|inner)$/.test(r.layer) ? r.layer : `"${r.layer}"`})\n`;
  for (const c of constraintClauses(r)) s += `\t${c}\n`;
  if (r.severity) s += `\t(severity ${r.severity})\n`;
  const cond = buildCondition(r.conds, t.two);
  if (cond) s += `\t(condition "${cond.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")\n`;
  return s + ")";
}
/** A rule as saved: its original text while the editor's model of it is unchanged, else ruleText */
export const savedText = (r: Rule): string => (r.raw !== undefined && r.gen !== undefined && ruleText(r) === r.gen ? r.raw : ruleText(r));
/** true when the rule is new or its model differs from what was loaded */
export const ruleEdited = (r: Rule): boolean => r.raw === undefined || r.gen === undefined || ruleText(r) !== r.gen;
export const rulesText = (rules: Rule[]): string => {
  const parts = rules.map((r) => { const t = savedText(r); return t ? (r.lead ? r.lead + "\n" : "") + t : ""; }).filter(Boolean);
  const trail = (rules as RuleList).trail;
  return "(version 1)\n\n" + parts.join("\n\n") + (trail ? "\n\n" + trail : "") + "\n";
};

/** DSNLEXER comments: a line whose first non-blank character is # */
const isCommentAt = (text: string, i: number): boolean => { let j = i - 1; while (j >= 0 && (text[j] === " " || text[j] === "\t")) j--; return j < 0 || text[j] === "\n" || text[j] === "\r"; };
export function stripComments(text: string): string { return text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); }
/** a rule node compared the way the rule engine reads it: lengths in mm, conditions without blanks outside quotes, the
 *  clauses in any order */
function ruleKey(n: SNode): string {
  const atom = (a: unknown): string => {
    if (typeof a === "number") return num(a);
    const str = String(a ?? "");
    const m = /^(-?(?:\d+\.?\d*|\.\d+))(mm|mil|mils|in|um)$/.exec(str);
    if (m) { const f = m[2] === "mil" || m[2] === "mils" ? 0.0254 : m[2] === "in" ? 25.4 : m[2] === "um" ? 0.001 : 1; return num(+m[1] * f) + "mm"; }
    let out = "", q = "";
    for (const c of str) { if (q) { out += c; if (c === q) q = ""; continue; } if (c === "'" || c === '"') { q = c; out += c; continue; } if (!/\s/.test(c)) out += c; }
    return JSON.stringify(out);
  };
  const deep = (x: unknown): string => (Array.isArray(x) ? "(" + x.map(deep).join(" ") + ")" : atom(x));
  return String(n[1] ?? "") + "|" + n.slice(2).map(deep).sort().join("|");
}

/** DRC_RULE_LOADER + DRC_RE_PANEL_MATCHER: a .kicad_dru's rules as editor entries.  A rule goes into a constraint
 *  panel only when the panel's ruleText reads back as the same rule; any other rule is a Custom rule kept as written. */
export function loadRules(text: string): RuleList {
  const out: RuleList = [];
  let root: SNode;
  try { root = KiCadCanvas.parse("(dru " + stripComments(text) + "\n)") as SNode; } catch (e) { return out; }
  if (!root) return out;
  // the raw text of each top-level (rule …) and the comment lines written above it
  const raws: { text: string; lead: string }[] = []; let pending: string[] = [];
  {
    let depth = 0, q = false, st = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === "\\") i++; else if (c === '"') q = false; continue; }
      if (c === "#" && isCommentAt(text, i)) { const j = text.indexOf("\n", i), line = text.slice(i, j < 0 ? text.length : j).replace(/\r$/, ""); if (depth === 0) pending.push(line); i = j < 0 ? text.length : j; continue; }
      if (c === '"') q = true;
      else if (c === "(") { if (depth === 0) st = i; depth++; }
      else if (c === ")") { depth--; if (depth === 0 && st >= 0) { const t = text.slice(st, i + 1); if (/^\(\s*rule\b/.test(t)) { raws.push({ text: t, lead: pending.join("\n") }); pending = []; } st = -1; } }
    }
  }
  if (pending.length) out.trail = pending.join("\n");
  let ri = 0;
  for (const r of root.slice(1)) {
    if (!Array.isArray(r) || r[0] !== "rule") continue;
    const src = raws[ri++] || { text: "", lead: "" }, raw = src.text;
    const S = (x: unknown): string => String(x ?? "");
    const rule: Rule = { type: "CUSTOM_RULE", name: S(r[1]), comment: "", layer: "", severity: "", conds: [], v: {}, text: raw, raw };
    if (src.lead) rule.lead = src.lead;
    const comments = /\(rule[^\n]*\n((?:\s*#[^\n]*\n)*)/.exec(raw); if (comments) rule.comment = comments[1].split("\n").map((l) => l.replace(/^\s*#\s?/, "")).filter(Boolean).join("\n");
    const cons: SNode[] = []; let cond = "";
    for (const c of r.slice(2)) { if (!Array.isArray(c)) continue; if (c[0] === "constraint") cons.push(c as SNode); else if (c[0] === "condition") cond = S(c[1]); else if (c[0] === "layer") rule.layer = S(c[1]); else if (c[0] === "severity") rule.severity = S(c[1]); }
    const bound = (c: SNode | undefined, k: string): number | null => { if (!c) return null; const b = c.find((x) => Array.isArray(x) && x[0] === k) as SNode | undefined; if (!b) return null; const m = /^(-?[\d.]+)\s*(mm|mil|mils|in|um)?$/.exec(S(b[1])); if (!m) return null; const f = m[2] === "mil" || m[2] === "mils" ? 0.0254 : m[2] === "in" ? 25.4 : m[2] === "um" ? 0.001 : 1; return +m[1] * f; };
    const by = (code: string): SNode | undefined => cons.find((c) => c[1] === code);
    const codes = cons.map((c) => S(c[1])).sort().join(",");
    const set = (type: string, v: Record<string, number | boolean | null>): void => { rule.type = type; rule.v = v; };
    if (codes === "hole_size,via_diameter") { const d = by("via_diameter"), hh = by("hole_size"); set("VIA_STYLE", { dmin: bound(d, "min"), dopt: bound(d, "opt"), dmax: bound(d, "max"), hmin: bound(hh, "min"), hopt: bound(hh, "opt"), hmax: bound(hh, "max") }); }
    else if (codes === "text_height,text_thickness") set("MINIMUM_TEXT_HEIGHT_AND_THICKNESS", { height: bound(by("text_height"), "min"), thickness: bound(by("text_thickness"), "min") });
    else if (codes === "diff_pair_gap,diff_pair_uncoupled,track_width") { const w = by("track_width"), g = by("diff_pair_gap"); set("ROUTING_DIFF_PAIR", { wmin: bound(w, "min"), wopt: bound(w, "opt"), wmax: bound(w, "max"), gmin: bound(g, "min"), gopt: bound(g, "opt"), gmax: bound(g, "max"), uncoupled: bound(by("diff_pair_uncoupled"), "max") }); }
    else if (codes === "length,skew") { const l = by("length"), sk = by("skew"); set("MATCHED_LENGTH_DIFF_PAIR", { min: bound(l, "min"), opt: bound(l, "opt"), max: bound(l, "max"), skew: bound(sk, "max"), within: !!sk && sk.some((x) => Array.isArray(x) && x[0] === "within_diff_pairs") }); }
    else if (cons.length === 1) {
      const c = cons[0], code = S(c[1]);
      if (code === "assertion" && /A\.Layer == /.test(S(c[2]))) set("PERMITTED_LAYERS", { top: /'F\.Cu'/.test(S(c[2])), bottom: /'B\.Cu'/.test(S(c[2])) });
      else if (code === "assertion" && /A\.Orientation == /.test(S(c[2]))) { const v: Record<string, boolean> = {}; for (const d of [0, 90, 180, 270]) v["o" + d] = new RegExp(`== ${d} deg`).test(S(c[2])); set("ALLOWED_ORIENTATION", v); }
      else if (code === "disallow") { const items = c.slice(2).map(S); const all = items.includes("via"); set("VIAS_UNDER_SMD", { through: all || items.includes("through_via"), micro: all || items.includes("micro_via"), blind: all || items.includes("blind_via"), buried: all || items.includes("buried_via") }); }
      else if (code === "track_width") set("ROUTING_WIDTH", { min: bound(c, "min"), opt: bound(c, "opt"), max: bound(c, "max") });
      else if (code === "length") set("ABSOLUTE_LENGTH", { min: bound(c, "min"), max: bound(c, "max") });
      else if (code === "min_resolved_spokes") set("MINIMUM_THERMAL_RELIEF_SPOKE_COUNT", { value: +S(c[2]) || 0 });
      else if (code === "via_count" || code === "microvia_stack_depth" || code === "hole_aspect_ratio") set(RULE_TYPES.find((t) => t.code === code)!.id, { value: bound(c, "max") });
      else { const t = RULE_TYPES.find((x) => x.panel === "num" && x.code === code); if (t && bound(c, "min") !== null && c.length === 3) set(t.id, { value: bound(c, "min") }); }
    }
    if (rule.type !== "CUSTOM_RULE") {
      rule.conds = parseCondition(cond);
      // DRC_RE_PANEL_MATCHER only claims what its panel can hold: the panel's text must be the same rule
      let back: SNode | null = null; try { back = KiCadCanvas.parse(stripComments(ruleText(rule))) as SNode | null; } catch (e) { back = null; }
      if (!back || ruleKey(back) !== ruleKey(r as SNode)) { rule.type = "CUSTOM_RULE"; rule.v = {}; rule.conds = []; }
    }
    if (rule.type === "CUSTOM_RULE") rule.conds = [];
    rule.gen = ruleText(rule);
    out.push(rule);
  }
  return out;
}
