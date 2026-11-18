// dialogs/cvpcb/logic.ts — the DOM-free half of Assign Footprints (KiCad's CvPcb, cvpcb/*.cpp): the list rows,
// FOOTPRINT_FILTER (common/footprint_filter.cpp) with EDA_COMBINED_MATCHER( CTX_LIBITEM ) for the search text, the
// three status lines (CVPCB_MAINFRAME::DisplayStatus), the unassigned-symbol navigation (CVPCB_CONTROL::ToNA), the
// association undo / redo lists (CVPCB_UNDO_REDO_ENTRIES), the footprint equivalence files and the automatic
// assignment (auto_associate.cpp), and DIALOG_CONFIG_EQUFILES' path handling.  The node tests load it directly.

/** FOOTPRINTS_LISTBOX filter bits (cvpcb/listboxes.h); 0 is UNFILTERED_FP_LIST. */
export const FILTER_FP_FILTERS = 0x1, FILTER_PIN_COUNT = 0x2, FILTER_LIBRARY = 0x4;

/** One FOOTPRINT_INFO: library nickname, name, description, keywords and numbered pad count (-1 when unknown). */
export interface FpInfo { lib: string; name: string; desc: string; keywords: string; pads: number }
/** The parts of a netlist COMPONENT the filters read. */
export interface SymFilterInfo { pins: number; filters: string[] }

// ---------------------------------------------------------------- formatting

const pad = (s: string, n: number): string => (s.length < n ? " ".repeat(n - s.length) + s : s);
/** CVPCB_MAINFRAME::formatSymbolDesc: "%3d " then the reference right-aligned in 8, " - ", the value right-aligned in 16, " : " fpid. */
export function formatSymbolDesc(idx: number, ref: string, value: string, fpid: string): string {
  return pad(String(idx), 3) + " " + pad(ref, 8) + " - " + pad(value, 16) + " : " + fpid;
}
/** FOOTPRINTS_LISTBOX::SetFootprints: "%3d %s:%s". */
export function formatFootprintRow(idx: number, lib: string, name: string): string { return pad(String(idx), 3) + " " + lib + ":" + name; }

/** StrNumCmp: runs of digits compare by value; IGNORE_CASE folds case first. */
export function strNumCmp(a: string, b: string, ignoreCase = false): number {
  if (ignoreCase) { a = a.toUpperCase(); b = b.toUpperCase(); }
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.charCodeAt(i), cb = b.charCodeAt(j);
    const da = ca >= 48 && ca <= 57, db = cb >= 48 && cb <= 57;
    if (da && db) {
      let ia = i, jb = j; while (ia < a.length && /\d/.test(a[ia]!)) ia++; while (jb < b.length && /\d/.test(b[jb]!)) jb++;
      const na = Number(a.slice(i, ia)), nb = Number(b.slice(j, jb));
      if (na !== nb) return na < nb ? -1 : 1;
      i = ia; j = jb; continue;
    }
    if (ca !== cb) return ca < cb ? -1 : 1;
    i++; j++;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}
/** FOOTPRINT_INFO operator<: library nickname then footprint name, StrNumCmp case-sensitive. */
export function fpInfoCmp(a: FpInfo, b: FpInfo): number { return strNumCmp(a.lib, b.lib) || strNumCmp(a.name, b.name); }

/** CVPCB_MAINFRAME::BuildLibrariesList: pinned nicknames first, each group sorted StrNumCmp ignoring case. */
export const PIN_GLYPH = "☆ ";
export function libraryOrder(names: string[], pinned: Set<string>): { name: string; pinned: boolean }[] {
  const uniq = [...new Set(names)], cmp = (x: string, y: string) => strNumCmp(x, y, true);
  const p = uniq.filter((n) => pinned.has(n)).sort(cmp), o = uniq.filter((n) => !pinned.has(n)).sort(cmp);
  return [...p.map((name) => ({ name, pinned: true })), ...o.map((name) => ({ name, pinned: false }))];
}

// ---------------------------------------------------------------- LIB_ID

/** LIB_ID::Parse followed by IsValid: "lib:name" with both parts present and no control characters. */
export function parseFpid(text: string): { lib: string; name: string; valid: boolean; empty: boolean } {
  const t = String(text || ""); const at = t.indexOf(":");
  const lib = at >= 0 ? t.slice(0, at) : "", name = at >= 0 ? t.slice(at + 1) : t;
  // eslint-disable-next-line no-control-regex
  const bad = /[\u0000-\u001f\u007f]/.test(t);
  return { lib, name, valid: !bad && !!lib && !!name, empty: !lib && !name };
}
/** '$noname' is how old files spelled "no footprint" (CVPCB_MAINFRAME::ReadNetListAndFpFiles treats it as empty). */
export function cleanFpid(fp: string): string { const s = String(fp || "").trim(); return s === "$noname" ? "" : s; }

// ---------------------------------------------------------------- matchers

const RE_SPECIAL = /[.*+?^${}()|[\]/\\]/;
function wildcardBody(p: string): string {
  let out = "";
  for (const c of p) out += c === "?" ? "." : c === "*" ? ".*" : RE_SPECIAL.test(c) ? "\\" + c : c;
  return out;
}
/** EDA_PATTERN_MATCH_WILDCARD_ANCHORED. */
export function wildcardAnchored(pattern: string): RegExp { return new RegExp("^" + wildcardBody(pattern) + "$"); }
/** wxString::Matches: '*' and '?' wildcards over the whole string, case-sensitive. */
export function wxMatches(text: string, pattern: string): boolean { try { return wildcardAnchored(pattern).test(text); } catch { return false; } }

/** One EDA_COMBINED_MATCHER( term, CTX_LIBITEM ): regex (explicit /…/ or ^…$), wildcard, relational, substring. */
export interface LibItemMatcher { pattern: string; find(text: string): number }
const UNITS: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, "": 1, k: 1e3, meg: 1e6, g: 1e9, t: 1e12, ki: 1024, mi: 1048576, gi: 1073741824, ti: 1099511627776 };
export function libItemMatcher(term: string): LibItemMatcher {
  const finders: ((t: string) => number)[] = [];
  // EDA_PATTERN_MATCH_REGEX: only an explicit expression
  let rx: string | null = null;
  if (term.startsWith("^") && term.endsWith("$")) rx = term;
  else if (term.startsWith("/")) { rx = term.slice(1); if (rx.endsWith("/")) rx = rx.slice(0, -1); }
  if (rx !== null) { try { const re = new RegExp(rx); finders.push((t) => { const m = re.exec(t); return m ? m.index : -1; }); } catch { /* not an expression */ } }
  // EDA_PATTERN_MATCH_WILDCARD: unanchored
  try { const re = new RegExp(wildcardBody(term)); finders.push((t) => { const m = re.exec(t); return m ? m.index : -1; }); } catch { /* cannot compile */ }
  // EDA_PATTERN_MATCH_RELATIONAL: key<rel>value[unit] against "key:value" tokens
  const rel = /^(\w+)(<|<=|=|>=|>)([-+]?[\d.]*)(\w*)$/.exec(term);
  if (rel && (rel[4]!.toLowerCase() in UNITS)) {
    const key = rel[1]!.toLowerCase(), op = rel[2]!, any = rel[3] === "", val = Number(rel[3]) * (UNITS[rel[4]!.toLowerCase()] ?? 1);
    if (any || Number.isFinite(val)) finders.push((t) => {
      let pos = 0;
      for (const tok of t.split(/[ \t\r\n]+/)) {
        const at = t.indexOf(tok, pos); pos = at + tok.length;
        const m = /^(\w+):([-+]?[\d.]+)(\w*)$/.exec(tok); if (!m || m[1]!.toLowerCase() !== key) continue;
        const u = UNITS[m[3]!.toLowerCase()]; if (u === undefined) continue;
        const v = Number(m[2]) * u; if (!Number.isFinite(v)) continue;
        const ok = any || (op === "<" ? v < val : op === "<=" ? v <= val : op === "=" ? v === val : op === ">=" ? v >= val : v > val);
        if (ok) return at;
      }
      return -1;
    });
  }
  // EDA_PATTERN_MATCH_SUBSTR
  finders.push((t) => t.indexOf(term));
  return { pattern: term, find(text: string) { for (const f of finders) { const p = f(text); if (p >= 0) return p; } return -1; } };
}

/** FOOTPRINT_INFO::GetSearchTerms: (text, weight) pairs, lower-cased and trimmed as ScoreTerms normalises them. */
export function searchTerms(fp: FpInfo): [string, number][] {
  const out: [string, number][] = [[fp.lib, 4], [fp.name, 8], [fp.lib + ":" + fp.name, 16]];
  for (const k of fp.keywords.split(/[ \t\r\n]+/)) if (k) out.push([k, 4]);
  out.push([fp.keywords, 1], [fp.desc, 1]);
  return out.map(([t, w]) => [t.toLowerCase().trim().slice(0, 1000), w]);
}
/** EDA_COMBINED_MATCHER::ScoreTerms: 8× weight on equality, 2× on a match at 0, 1× elsewhere; 0 = no match. */
export function scoreTerms(m: LibItemMatcher, terms: [string, number][]): number {
  let score = 0;
  for (const [t, w] of terms) {
    if (m.pattern === t) score += 8 * w;
    else { const p = m.find(t); if (p === 0) score += 2 * w; else if (p > 0) score += w; }
  }
  return score;
}

/** FootprintFilterMatchesName: lower-case name, with "lib:" in front when the pattern holds a ':'. */
export function footprintFilterMatches(pattern: string, lib: string, name: string): boolean {
  const p = pattern.toLowerCase(); const cand = (p.includes(":") ? lib.toLowerCase() + ":" : "") + name.toLowerCase();
  try { return wildcardAnchored(p).test(cand); } catch { return false; }
}

export interface FilterOpts { flags: number; lib: string; sym: SymFilterInfo | null; text: string }
/**
 * FOOTPRINTS_LISTBOX::SetFootprints over FOOTPRINT_FILTER_IT: the symbol's footprint filters and pin count apply only
 * with a symbol selected; the library filter only with a library selected; the search text splits on white space and
 * every term must score.  No filter at all lists every footprint.
 */
export function filterFootprints(list: FpInfo[], o: FilterOpts): FpInfo[] {
  let flags = 0;
  const fpFilters = o.flags & FILTER_FP_FILTERS && o.sym ? o.sym.filters.filter(Boolean) : null; if (fpFilters) flags |= FILTER_FP_FILTERS;
  const pins = o.flags & FILTER_PIN_COUNT && o.sym ? o.sym.pins : null; if (pins !== null) flags |= FILTER_PIN_COUNT;
  if (o.flags & FILTER_LIBRARY) flags |= FILTER_LIBRARY;
  const matchers = o.text ? o.text.toLowerCase().split(/[ \t\r\n]+/).filter(Boolean).map(libItemMatcher) : [];
  if (!flags && !matchers.length) return list.slice();
  return list.filter((fp) => {
    if (pins !== null && !(pins >= 0 && pins === fp.pads)) return false;
    if (flags & FILTER_LIBRARY && o.lib && fp.lib !== o.lib) return false;
    if (fpFilters && fpFilters.length && !fpFilters.some((p) => footprintFilterMatches(p, fp.lib, fp.name))) return false;
    if (matchers.length) { const terms = searchTerms(fp); for (const m of matchers) if (!scoreTerms(m, terms)) return false; }
    return true;
  });
}

// ---------------------------------------------------------------- status lines

/** DisplayStatus line 1: "Filtered by Keywords (…), Pin Count (n), Library (lib), Search Text (txt): N matching footprints". */
export function filterStatus(flags: number, sym: SymFilterInfo | null, lib: string, text: string, count: number): string {
  const parts: string[] = [];
  if (flags & FILTER_FP_FILTERS) { const f = sym ? sym.filters.join(", ") : ""; parts.push("Keywords" + (f ? ` (${f})` : "")); }
  if (flags & FILTER_PIN_COUNT) parts.push("Pin Count" + (sym ? ` (${sym.pins})` : ""));
  if (flags & FILTER_LIBRARY) parts.push("Library" + (lib ? ` (${lib})` : ""));
  if (text) parts.push(`Search Text (${text})`);
  return (parts.length ? `Filtered by ${parts.join(", ")}` : "No Filtering") + `: ${count} matching footprints`;
}
/** DisplayStatus line 2. */
export function footprintStatus(fp: FpInfo | null): string { return fp ? `Description: ${fp.desc};  Keywords: ${fp.keywords}` : ""; }

// ---------------------------------------------------------------- navigation

/** CVPCB_CONTROL::ToNA: the next unassigned index after the first selected one (or the first of all with none
 *  selected); the previous one before it (nothing with none selected).  null = leave the selection alone. */
export function toNA(unassigned: number[], selected: number[], dir: "next" | "prev"): number | null {
  if (!unassigned.length) return null;
  const first = selected.length ? Math.min(...selected) : null;
  if (dir === "next") { for (const i of unassigned) if (first === null || i > first) return i; return null; }
  if (first === null) return null;
  for (let k = unassigned.length - 1; k >= 0; k--) if (unassigned[k]! < first) return unassigned[k]!;
  return null;
}

// ---------------------------------------------------------------- undo / redo

/** CVPCB_ASSOCIATION: one symbol's footprint going from `old` to `now`. */
export interface Association { index: number; old: string; now: string }
/** m_undoList / m_redoList of CVPCB_UNDO_REDO_ENTRIES: one entry per user action, several associations each. */
export class AssocHistory {
  undoList: Association[][] = []; redoList: Association[][] = [];
  /** AssociateFootprint( …, aNewEntry, aAddUndoItem ): a new entry clears redo; otherwise it joins the last one. */
  record(a: Association, newEntry: boolean): void {
    if (newEntry || !this.undoList.length) { this.undoList.push([a]); this.redoList = []; } else this.undoList[this.undoList.length - 1]!.push(a);
  }
  canUndo(): boolean { return this.undoList.length > 0; }
  canRedo(): boolean { return this.redoList.length > 0; }
  /** UndoAssociation: the associations to put back (each reversed), in the order they were made. */
  undo(): Association[] | null {
    const e = this.undoList.pop(); if (!e) return null;
    const rev = e.map((a) => ({ index: a.index, old: a.now, now: a.old }));
    this.redoList.push(rev); return rev;
  }
  /** RedoAssociation: the reversed entry reversed again, recorded as a new undo entry (AssociateFootprint with aNewEntry);
   *  that clears the rest of the redo list, as in KiCad. */
  redo(): Association[] | null {
    const e = this.redoList.pop(); if (!e) return null;
    const fwd = e.map((a) => ({ index: a.index, old: a.now, now: a.old }));
    // AssociateFootprint( assoc, firstAssoc ) adds the undo item, which clears m_redoList
    this.undoList.push(fwd); this.redoList = []; return fwd;
  }
  /** The symbols' rows moved (the list was rebuilt): each association's index through `map`; -1 drops it. */
  remap(map: (index: number) => number): void {
    const f = (list: Association[][]) => list.map((e) => e.map((a) => ({ ...a, index: map(a.index) })).filter((a) => a.index >= 0)).filter((e) => e.length > 0);
    this.undoList = f(this.undoList); this.redoList = f(this.redoList);
  }
  clear(): void { this.undoList = []; this.redoList = []; }
}

// ---------------------------------------------------------------- equivalence files

/** GetQuotedText: the text between the next pair of single quotes; the rest of the line after it. */
function quoted(s: string): [string, string] {
  const i = s.indexOf("'"); if (i < 0) return ["", s];
  const rest = s.slice(i + 1); const j = rest.indexOf("'"); if (j < 0) return ["", s];
  return [rest.slice(0, j), rest.slice(j + 1)];
}
export interface Equivalence { value: string; fpid: string }
/** buildEquivalenceList for one file: lines "'value' 'lib:footprint'", spaces in the value become '_'. */
export function parseEquFile(text: string): Equivalence[] {
  const out: Equivalence[] = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line) continue;
    const [value, rest] = quoted(line); if (!value) continue;
    const [fpid] = quoted(rest); if (!fpid) continue;
    out.push({ value: value.replace(/ /g, "_"), fpid });
  }
  return out;
}
/** sortListbyCmpValue: descending by value (wxString::Cmp, code units). */
export function sortEquivalences(list: Equivalence[]): Equivalence[] { return list.slice().sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0)); }

export interface AutoSym { ref: string; value: string; fpid: string; filters: string[] }
export interface AutoResult { assign: { index: number; fpid: string }[]; warnings: string[] }
/**
 * CVPCB_MAINFRAME::AutomaticFootprintMatching over the sorted list: symbols that already have a footprint are left
 * alone; a value (case-insensitive) with one equivalence whose footprint exists is taken; several are narrowed by the
 * symbol's footprint filters (wxString::Matches on the footprint name), else the first that exists; an equivalence
 * naming a missing footprint is reported; with none, a lone footprint filter that names an existing footprint is used.
 */
export function autoAssociate(syms: AutoSym[], sortedEquivs: Equivalence[], exists: (fpid: string) => FpInfo | null): AutoResult {
  const assign: { index: number; fpid: string }[] = [], warnings: string[] = [];
  syms.forEach((c, kk) => {
    if (c.fpid) return;
    let found = false, candidate = "";
    for (let idx = 0; idx < sortedEquivs.length; idx++) {
      const e = sortedEquivs[idx]!;
      if (e.value.toLowerCase() !== c.value.toLowerCase()) continue;
      const fp = exists(e.fpid);
      let unique = true;
      if (idx + 1 < sortedEquivs.length && e.value === sortedEquivs[idx + 1]!.value) unique = false;
      if (idx - 1 >= 0 && e.value === sortedEquivs[idx - 1]!.value) unique = false;
      if (fp && unique) { assign.push({ index: kk, fpid: e.fpid }); found = true; break; }
      if (fp && !candidate) candidate = e.fpid;
      if (fp) { found = !c.filters.length; for (let j = 0; j < c.filters.length && !found; j++) found = wxMatches(fp.name, c.filters[j]!); }
      else warnings.push(`Component ${c.ref}: footprint ${e.fpid} not found in any of the project footprint libraries.`);
      if (found) { assign.push({ index: kk, fpid: e.fpid }); break; }
    }
    if (found) return;
    if (candidate) { assign.push({ index: kk, fpid: candidate }); return; }
    if (c.filters.length === 1 && exists(c.filters[0]!)) assign.push({ index: kk, fpid: c.filters[0]! });
  });
  return { assign, warnings };
}

/** wxExpandEnvVars for ${VAR} / $(VAR) with the variables given; unknown ones stay as written. */
export function expandVars(path: string, vars: Record<string, string>): string {
  return String(path || "").replace(/\$\{(\w+)\}|\$\((\w+)\)/g, (m, a: string | undefined, b: string | undefined) => { const k = (a || b)!; return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k]! : m; });
}
/** A project path for an equivalence file entry: ${KIPRJMOD}/x.equ -> "x.equ"; null when it is outside the project. */
export function equProjectPath(entry: string): string | null {
  const s = String(entry || "").replace(/\\/g, "/").trim();
  const m = /^\$\{KIPRJMOD\}\/?(.*)$/.exec(s) || /^\$\(KIPRJMOD\)\/?(.*)$/.exec(s);
  if (m) return m[1]!.replace(/^\.\//, "");
  if (s.startsWith("/") || /^[A-Za-z]:\//.test(s) || /^\$[{(]/.test(s)) return null;
  return s.replace(/^\.\//, "");   // a relative entry: SEARCH_STACK starts in the project folder
}
/** DIALOG_CONFIG_EQUFILES::OnAddFiles: a file under one of the substitution paths becomes "${VAR}/rel", unix separators. */
export function equEntryFor(file: string, subs: [string, string][]): string {
  const f = String(file || "").replace(/\\/g, "/");
  for (const [name, root] of subs) {
    const r = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (r && f.startsWith(r + "/")) return "${" + name + "}/" + f.slice(r.length + 1);
  }
  return f;
}
/** OnButtonMoveUp / OnButtonMoveDown on a multi-selection: nothing when the first (last) row is selected. */
export function moveRows<T>(list: T[], sel: number[], dir: -1 | 1): { list: T[]; sel: number[] } {
  const s = [...new Set(sel)].sort((a, b) => a - b); if (!s.length) return { list, sel };
  if (dir < 0 && s[0] === 0) return { list, sel: s };
  if (dir > 0 && s[s.length - 1] === list.length - 1) return { list, sel: s };
  const out = list.slice();
  const order = dir < 0 ? s : s.slice().reverse();
  for (const j of order) { const t = out[j]!; out[j] = out[j + dir]!; out[j + dir] = t; }
  return { list: out, sel: s.map((j) => j + dir) };
}

// ---------------------------------------------------------------- type-ahead

/** FOOTPRINTS_LISTBOX::OnChar: the first row whose footprint name (after the line number) starts with the key. */
export function typeAheadFootprint(rows: string[], key: string): number {
  const k = key.toUpperCase();
  for (let i = 0; i < rows.length; i++) { const t = rows[i]!.trimStart(); const sp = t.indexOf(" "); const rest = sp < 0 ? "" : t.slice(sp).trimStart(); if (rest.charAt(0).toUpperCase() === k) return i; }
  return -1;
}
/** LIBRARY_LISTBOX::OnChar / SYMBOLS_LISTBOX::OnChar: the next row after `from` (wrapping) whose text starts with the key. */
export function typeAheadFrom(rows: string[], key: string, from: number): number {
  const k = key.toUpperCase(), n = rows.length;
  for (let d = 1; d <= n; d++) { const i = (from + d + n) % n; if (rows[i]!.trimStart().charAt(0).toUpperCase() === k) return i; }
  return -1;
}
