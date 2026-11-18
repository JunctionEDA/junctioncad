// dialogs/schematic-setup-logic.ts — the plain-data half of the Schematic Setup pages (schematic-setup-pages.ts):
// the annotation and compare-symbol settings as the project file keeps them, the root sheet's net chains and
// embedded files, and DIALOG_SCH_IMPORT_SETTINGS' section copy.
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObj = { [k: string]: Json };
const obj = (v: Json | undefined): JsonObj => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** PANEL_EESCHEMA_ANNOTATION_OPTIONS' m_choiceSeparatorRefId: label, subpart_first_id, subpart_id_separator */
export const UNIT_NOTATIONS: [string, number, number][] = [["A", 65, 0], [".A", 65, 46], ["-A", 65, 45], ["_A", 65, 95], [".1", 49, 46], ["-1", 49, 45], ["_1", 49, 95]];
export function separatorChoice(firstId: Json | undefined, sep: Json | undefined): number {
  const f = typeof firstId === "number" ? firstId : 65, s = typeof sep === "number" ? sep : 0;
  if (f === 49) { const i = UNIT_NOTATIONS.findIndex((n) => n[1] === 49 && n[2] === s); return i >= 0 ? i : 4; }
  const i = UNIT_NOTATIONS.findIndex((n) => n[1] === 65 && n[2] === s); return i >= 0 ? i : 0;
}
export interface AnnotationSettings { notation: number; sortY: boolean; method: 0 | 1 | 2; startNum: number; reuse: boolean; suffixes: boolean; incrementPasted: boolean }
export function annotationOf(sch: JsonObj): AnnotationSettings {
  const a = obj(sch.annotation), m = typeof a.method === "number" ? a.method : 0;
  return { notation: separatorChoice(sch.subpart_first_id, sch.subpart_id_separator), sortY: a.sort_order === 1, method: (m === 1 || m === 2 ? m : 0) as 0 | 1 | 2,
    startNum: typeof sch.annotate_start_num === "number" ? sch.annotate_start_num : 0, reuse: sch.reuse_designators !== false, suffixes: a.reused_sheet_suffixes === true, incrementPasted: a.increment_pasted_suffix !== false };
}
export function writeAnnotation(sch: JsonObj, s: AnnotationSettings): void {
  const n = UNIT_NOTATIONS[s.notation] || UNIT_NOTATIONS[0];
  sch.subpart_first_id = n[1]; sch.subpart_id_separator = n[2]; sch.annotate_start_num = s.startNum; sch.reuse_designators = s.reuse;
  const a = obj(sch.annotation); sch.annotation = Object.assign({}, a, { sort_order: s.sortY ? 1 : 0, method: s.method, reused_sheet_suffixes: s.suffixes, increment_pasted_suffix: s.incrementPasted });
}

/** SYMBOL_PARITY_SETTINGS: [key, label, default], grouped as PANEL_SETUP_SYMBOL_PARITY shows them */
export const PARITY: [string, [string, string, boolean][]][] = [
  ["Fields", [["missing_fields", "Check for missing fields", true], ["extra_fields", "Check for extra fields", false], ["field_texts", "Compare non-reference field text", true],
    ["field_visibilities", "Compare field visibilities", false], ["field_styles", "Compare field text sizes and styles", false], ["field_positions", "Compare field positions", false]]],
  ["Pins", [["pin_name_number_visibilities", "Compare pin name/number visibilities", false], ["pin_alt_function_definitions", "Compare alternate pin functions", true]]],
  ["Attributes", [["exclude_from_board_flags", "Compare exclude from board flags", true], ["dnp_flags", "Compare do not populate flags", false],
    ["exclude_from_bom_flags", "Compare exlucde from bill of materials flags", false], ["exclude_from_position_file_flags", "Compare exclude from position file flags", true]]]];
export function parityOf(sch: JsonObj): Record<string, boolean> {
  const c = obj(sch.compare_symbols), out: Record<string, boolean> = {};
  for (const [, rows] of PARITY) for (const [k, , d] of rows) out[k] = typeof c[k] === "boolean" ? c[k] as boolean : d;
  return out;
}

export interface ChainRow { name: string; nets: string[]; chainClass: string; netClass: string; color: string; from: string; to: string }
type SNode = (string | number | SNode)[];
const sv = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
/** The root sheet's committed (net_chain "name" (from ref pin) (to ref pin) (net_class …) (color r g b a) (nets …)). */
export function chainsOf(nodes: SNode[], classes: JsonObj): ChainRow[] {
  const out: ChainRow[] = [];
  for (const n of nodes) {
    if (!Array.isArray(n) || n[0] !== "net_chain") continue;
    const kid = (k: string): SNode | null => (n.find((c) => Array.isArray(c) && c[0] === k) as SNode) || null;
    const nc = kid("net_class"), col = kid("color"), nets = kid("nets"), f = kid("from"), t = kid("to");
    const name = sv(n[1]);
    out.push({ name, nets: nets ? nets.slice(1).map(sv) : [], chainClass: sv(classes[name] || ""), netClass: nc ? sv(nc[1]) : "",
      color: col ? `rgba(${+col[1]}, ${+col[2]}, ${+col[3]}, ${+(+col[4]).toFixed(3)})` : "", from: f ? `${sv(f[1])}-${sv(f[2])}` : "", to: t ? `${sv(t[1])}-${sv(t[2])}` : "" });
  }
  return out;
}
export const validChainName = (s: string): boolean => !!s && !/["'() ]/.test(s);

export interface ChainState { chains: ChainRow[]; classes: string[] }

/** Validate: the class names must be set and distinct (the chain names come from the schematic). */
export function chainClassError(classes: string[]): string | null {
  for (let i = 0; i < classes.length; i++) {
    if (!classes[i].trim()) return `Class on row ${i + 1} cannot have an empty name.`;
    if (classes.indexOf(classes[i]) !== i) return `Duplicate class name '${classes[i]}' on row ${i + 1}.`;
  }
  return null;
}
/** net_settings.net_chain_classes: each chain with a class (an empty class is no entry). */
export function chainClassesJson(st: ChainState, prev: JsonObj = {}): JsonObj {
  // entries for chains this schematic does not list stay (ApplyEdits only touches its rows), unless their class went
  const out: JsonObj = {};
  for (const [k, v] of Object.entries(prev)) if (!st.chains.some((c) => c.name === k) && st.classes.includes(String(v))) out[k] = v;
  for (const c of st.chains) if (c.chainClass && st.classes.includes(c.chainClass)) out[c.name] = c.chainClass;
  return out;
}


/** where a top-level (kicad_sch …) child form starting with `head` begins, or -1 (strings skipped) */
function topLevel(text: string, head: string): number {
  let d = 0, q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === "\\") i++; else if (c === '"') q = false; continue; }
    if (c === '"') q = true; else if (c === ")") d--; else if (c === "(") { if (d === 1 && text.startsWith(head, i)) return i; d++; }
  }
  return -1;
}
/** The root file's (embedded_files …) form as text ("" when it has none). */
export function embeddedFilesText(text: string): string {
  const at = topLevel(text, "(embedded_files"); if (at < 0) return "";
  let depth = 0, inStr = false;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "(") depth++; else if (c === ")" && --depth === 0) return text.slice(at, i + 1);
  }
  return text.slice(at);
}
export function embeddedOf(text: string): { files: string[]; fonts: boolean } {
  // the sheet's own (embedded_files …) sits directly in (kicad_sch …); a library symbol may carry one of its own
  const files: string[] = [], at = topLevel(text, "(embedded_files");
  if (at >= 0) {
    // the form's extent: its closing parenthesis, strings skipped
    let depth = 0, end = text.length, inStr = false;
    for (let i = at; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === "(") depth++; else if (c === ")" && --depth === 0) { end = i; break; }
    }
    const body = text.slice(at, end), re = /\(file\s*\(name\s+"((?:[^"\\]|\\.)*)"\)/g; let m: RegExpExecArray | null;
    while ((m = re.exec(body))) files.push(m[1]);
  }
  const f = topLevel(text, "(embedded_fonts");
  return { files, fonts: f >= 0 && /^\(embedded_fonts\s+yes\)/.test(text.slice(f, f + 30)) };
}

/** DIALOG_SCH_IMPORT_SETTINGS' options, in its order: key, label */
export const SCH_IMPORT_OPTIONS: [string, string][] = [["formatting", "Formatting preferences"], ["annotation", "Annotation preferences"], ["fieldNames", "Field name templates"],
  ["bomPresets", "BOM presets"], ["bomFmtPresets", "BOM format presets"], ["parity", "Compare symbol with library settings"], ["severities", "Violation severities"],
  ["pinMap", "Pin conflict map"], ["netClasses", "Net classes"], ["busAliases", "Bus alias definitions"], ["textVars", "Text variables"]];
const ANNOTATION_KEYS = ["annotation", "annotate_start_num", "subpart_id_separator", "subpart_first_id", "reuse_designators"];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** DIALOG_SCHEMATIC_SETUP::onAuxiliaryAction: the chosen sections of `from` copied over `to` (both whole project files). */
export function importSections(to: JsonObj, from: JsonObj, sel: string[]): void {
  const ensure = (o: JsonObj, k: string): JsonObj => { if (!o[k] || typeof o[k] !== "object" || Array.isArray(o[k])) o[k] = {}; return o[k] as JsonObj; };
  const tSch = ensure(to, "schematic"), fSch = obj(from.schematic), tErc = ensure(to, "erc"), fErc = obj(from.erc);
  const has = (k: string): boolean => sel.includes(k);
  if (has("formatting")) {
    const fd = obj(fSch.drawing), td = ensure(tSch, "drawing"), keep = td.field_names;
    for (const k of Object.keys(td)) if (k !== "field_names") delete td[k];
    for (const [k, v] of Object.entries(fd)) if (k !== "field_names") td[k] = clone(v);
    if (keep !== undefined) td.field_names = keep;
    if (fSch.connection_grid_size !== undefined) tSch.connection_grid_size = fSch.connection_grid_size;
  }
  if (has("fieldNames")) { const td = ensure(tSch, "drawing"); td.field_names = clone(obj(fSch.drawing).field_names || []); }
  if (has("annotation")) for (const k of ANNOTATION_KEYS) { if (fSch[k] !== undefined) tSch[k] = clone(fSch[k]); else delete tSch[k]; }
  if (has("bomPresets")) tSch.bom_presets = clone(fSch.bom_presets || []);
  if (has("bomFmtPresets")) tSch.bom_fmt_presets = clone(fSch.bom_fmt_presets || []);
  if (has("parity")) tSch.compare_symbols = clone(fSch.compare_symbols || {});
  if (has("severities")) tErc.rule_severities = clone(fErc.rule_severities || {});
  if (has("pinMap") && fErc.pin_map !== undefined) tErc.pin_map = clone(fErc.pin_map);
  if (has("netClasses")) { const tn = ensure(to, "net_settings"), fn = obj(from.net_settings); tn.classes = clone(fn.classes || []); tn.netclass_patterns = clone(fn.netclass_patterns || []); }
  if (has("busAliases")) tSch.bus_aliases = clone(fSch.bus_aliases || {});
  if (has("textVars")) to.text_variables = clone(from.text_variables || {});
}
