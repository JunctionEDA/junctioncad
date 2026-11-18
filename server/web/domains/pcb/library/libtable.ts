// library/libtable.ts — what the Symbol and Footprint Libraries dialogs (DIALOG_EDIT_LIBRARY_TABLES with
// PANEL_SYM_LIB_TABLE / PANEL_FP_LIB_TABLE) know about a library table without any DOM: the plugin lists behind the
// Library Format column and the Add Existing menu (SCH_IO_MGR / PCB_IO_MGR with each plugin's GetLibraryDesc), the
// format guessed from a path, LIB_ID::FixIllegalChars, LIB_TABLE_GRID_TRICKS::VerifyTable, LIBRARY_TABLE's options
// string, the clipboard rows LIB_TABLE_GRID_TRICKS::paste_text takes, and the path substitutions shown under the grid.
// The table text itself goes through KiCad's own writer (symedit/model.ts formatLibTable, LIBRARY_TABLE::Format).

export type LibTableKind = "symbol" | "footprint";
/** One LIBRARY_TABLE_ROW as the grid edits it. */
export interface LibTableRow { enabled: boolean; visible: boolean; nickname: string; uri: string; type: string; options: string; descr: string }

/** IO_BASE::IO_FILE_DESC of one plugin: files with these extensions, or a folder holding files with `inDir`. */
export interface IoDesc { type: string; exts: string[]; inDir?: string[]; folder?: boolean; options?: [string, string][] }

/** LIBRARY_TABLE_ROW::TABLE_TYPE_NAME: a row that is itself a library table. */
export const TABLE_TYPE = "Table";

// PCB_IO::GetLibraryOptions (pcbnew/pcb_io/pcb_io.cpp): the options every footprint plugin lists
const PCB_OPTIONS: [string, string][] = [
  ["debug_level", "Enable <b>debug</b> logging for Footprint*() functions in this PCB_IO."],
  ["enable_transaction_logging", "Enable transaction logging. The mere presence of this option turns on the logging, no need to set a Value."],
  ["password", "Password for <b>login</b> to some special library server."],
  ["python_footprint_plugin", "Enter the python module which implements the PCB_IO::Footprint*() functions."],
  ["read_filter_regex", "Regular expression <b>footprint name</b> filter."],
  ["username", "User name for <b>login</b> to some special library server."],
];

/**
 * PANEL_SYM_LIB_TABLE::populatePluginList: the SCH_IO plugins whose GetLibraryDesc names file extensions, in
 * SCH_FILE_T order (SCH_IO_MGR::ShowType names), then the nested table.
 */
export const SCH_IO: IoDesc[] = [
  { type: "KiCad", exts: ["kicad_sym"] },
  { type: "Legacy", exts: ["lib"] },
  { type: "Altium", exts: ["SchLib", "IntLib"] },
  { type: "CADSTAR Schematic Archive", exts: ["lib"], options: [
    ["csa", "Path to the CADSTAR schematic archive (*.csa) file related to this CADSTAR parts library. If none specified it is assumed to be 'symbol.csa' in the same folder."],
    ["fplib", "Name of the footprint library related to the symbols in this library. You should create a separate entry for the CADSTAR PCB Archive (*.cpa) file in the footprint library tables. If none specified, 'cadstarpcblib' is assumed."]] },
  { type: "Database", exts: ["kicad_dbl"] },
  { type: "EAGLE", exts: ["lbr"] },
  { type: "EasyEDA (JLCEDA) Std", exts: ["json"] },
  { type: "EasyEDA (JLCEDA) Pro", exts: ["elibz", "epro", "zip"] },
  { type: "EasyEDA (JLCEDA) Pro v3", exts: ["elibz2"] },
  { type: "HTTP", exts: ["kicad_httplib"] },
  { type: "PADS Logic", exts: ["asc", "txt"] },
  { type: "P-CAD", exts: ["SCH", "sch", "LIA", "lia"] },
  { type: "OrCAD", exts: ["olb"] },
  { type: "Easy-PC", exts: ["ssl", "cml"] },
  { type: TABLE_TYPE, exts: [] },
];

/**
 * PANEL_FP_LIB_TABLE::populatePluginList: the registered PCB_IO plugins with a library description, in PCB_FILE_T
 * order (the names they register under), then the nested table.
 */
export const PCB_IO: IoDesc[] = [
  { type: "KiCad", exts: [], inDir: ["kicad_mod"], folder: true },
  { type: "Legacy", exts: ["mod", "emp"] },
  { type: "Altium Designer", exts: ["PcbLib", "IntLib"] },
  { type: "CADSTAR PCB Archive", exts: ["cpa"] },
  { type: "Eagle", exts: ["lbr"] },
  { type: "EasyEDA / JLCEDA Std", exts: ["json", "zip"] },
  { type: "EasyEDA / JLCEDA Pro", exts: ["elibz", "epro", "zip"] },
  { type: "EasyEDA / JLCEDA Pro v3", exts: ["elibz2"] },
  { type: "gEDA / Lepton EDA", exts: [], inDir: ["fp"], folder: true },
  { type: "PADS", exts: ["asc"] },
  { type: "Sprint Layout", exts: [], inDir: ["lmk"], folder: true },
  { type: "PADS Binary", exts: ["pcb"] },
  { type: "Easy-PC", exts: ["psl"] },
  { type: TABLE_TYPE, exts: [] },
].map((d) => (d.type === TABLE_TYPE ? d : { ...d, options: PCB_OPTIONS }));

export const plugins = (kind: LibTableKind): IoDesc[] => (kind === "symbol" ? SCH_IO : PCB_IO);
/** The Library Format choices (m_pluginChoices), plus a type the table carries that no plugin names. */
export function formatChoices(kind: LibTableKind, current?: string): string[] {
  const list = plugins(kind).map((p) => p.type);
  return current && !list.includes(current) ? [...list, current] : list;
}

/** One entry of the Add Existing split button's menu. */
export interface AddExistingEntry { label: string; type: string; folder?: boolean; newDatabase?: boolean }
/** JoinExtensions (common.cpp): "*.a, *.b" for the footprint menu; the symbol panel's own joiner writes ".a, .b". */
const joinFp = (exts: string[]): string => exts.map((e) => "*." + e).join(", ");
const joinSym = (exts: string[]): string => exts.map((e) => "." + e).join(", ");
/**
 * The split button's menu: PANEL_SYM_LIB_TABLE (KiCad's folder entry after the file one, New Database Library...
 * after Database) or PANEL_FP_LIB_TABLE (a folder plugin reads "folder with %s files").
 */
export function addExistingMenu(kind: LibTableKind): AddExistingEntry[] {
  const out: AddExistingEntry[] = [];
  for (const p of plugins(kind)) {
    if (kind === "symbol") {
      out.push({ label: p.type + (p.exts.length ? ` (${joinSym(p.exts)})` : ""), type: p.type });
      if (p.type === "KiCad") out.push({ label: "KiCad (folder with .kicad_sym files)", type: "KiCad", folder: true });
      if (p.type === "Database") out.push({ label: "New Database Library...", type: "Database", newDatabase: true });
    } else {
      const mid = p.folder ? `folder with ${joinFp(p.inDir || [])} files` : "";
      out.push({ label: p.type + (!p.folder && p.exts.length ? ` (${joinFp(p.exts)})` : mid ? ` (${mid})` : ""), type: p.type, folder: !!p.folder });
    }
  }
  return out;
}

const extOf = (path: string): string => { const f = path.replace(/\/+$/, "").split("/").pop() || ""; const i = f.lastIndexOf("."); return i > 0 ? f.slice(i + 1) : ""; };
/** The library table file name of a kind (FILEEXT::SymbolLibraryTableFileName / FootprintLibraryTableFileName). */
export const tableFileName = (kind: LibTableKind): string => (kind === "symbol" ? "sym-lib-table" : "fp-lib-table");
/**
 * SCH_IO_MGR / PCB_IO_MGR::GuessPluginTypeFromLibPath: the first plugin (in enum order) that reads the path's
 * extension; a .pretty folder is KiCad's, a library table file is a nested table.  "" when none does.
 */
export function guessFormat(kind: LibTableKind, path: string): string {
  const p = path.replace(/\/+$/, ""); const name = p.split("/").pop() || "";
  if (name === tableFileName(kind)) return TABLE_TYPE;
  const ext = extOf(p);
  if (kind === "footprint" && ext.toLowerCase() === "pretty") return "KiCad";
  for (const io of plugins(kind)) if (io.exts.some((e) => e.toLowerCase() === ext.toLowerCase()) && ext) return io.type;
  return "";
}

/** LIB_ID::isLegalLibraryNameChar: control characters, '\' and ':' are not allowed in a nickname. */
export const isLegalNickChar = (c: string): boolean => c >= " " && c !== "\\" && c !== ":";
/** LIB_ID::FixIllegalChars( name, true ): each illegal character becomes '_'. */
export const fixIllegalChars = (name: string): string => [...name].map((c) => (isLegalNickChar(c) ? c : "_")).join("");
/**
 * The nickname Add Existing gives a picked library: the file's name without its extension (wxFileName::GetName),
 * except a footprint file of the KiCad plugin that is not a .pretty folder, which keeps its full name.
 */
export function nicknameFor(kind: LibTableKind, path: string, type: string): string {
  const full = path.replace(/\/+$/, "").split("/").pop() || "";
  const i = full.lastIndexOf("."); const base = i > 0 ? full.slice(0, i) : full;
  if (kind === "footprint" && type === "KiCad" && extOf(full).toLowerCase() !== "pretty") return fixIllegalChars(full);
  return fixIllegalChars(base);
}

/** LIB_TABLE_GRID_TRICKS::VerifyTable: rows without a path go silently; a nickname must be legal and unique. */
export function verifyRows(rows: LibTableRow[], visibility: boolean): { rows: LibTableRow[]; error?: string; row?: number } {
  const out = rows.filter((r) => r.uri.trim()).map((r) => ({ ...r, nickname: r.nickname.trim(), uri: r.uri.trim(), visible: visibility ? r.visible : true }));
  for (let i = 0; i < out.length; i++) {
    const nick = out[i].nickname;
    if (!nick) return { rows: out, error: "Library must have a nickname.", row: i };
    const bad = [...nick].find((c) => !isLegalNickChar(c)); if (bad) return { rows: out, error: `Illegal character '${bad}' in nickname '${nick}'.`, row: i };
  }
  for (let a = 0; a < out.length - 1; a++) for (let b = a + 1; b < out.length; b++) if (out[a].nickname === out[b].nickname) return { rows: out, error: `Multiple libraries cannot share the same nickname ('${out[a].nickname}').`, row: b };
  return { rows: out };
}

/** LIBRARY_TABLE::ParseOptions: "name=value|name|..." (a '\|' keeps the separator in a value), sorted by name. */
export function parseOptions(s: string): Map<string, string> {
  const out = new Map<string, string>(); let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    let pair = "";
    while (i < s.length) {
      if (s[i] === "\\" && s[i + 1] === "|") { pair += "|"; i += 2; }
      else if (s[i] === "|") { i++; break; }
      else pair += s[i++];
    }
    if (pair) { const eq = pair.indexOf("="); if (eq >= 0) out.set(pair.slice(0, eq), pair.slice(eq + 1)); else out.set(pair, ""); }
  }
  return new Map([...out].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}
/** LIBRARY_TABLE::FormatOptions: the std::map back to the string, names in order, '|' in a value escaped. */
export function formatOptions(opts: Map<string, string> | [string, string][]): string {
  const list = [...opts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).filter(([n]) => n);
  return list.map(([n, v]) => n + (v ? "=" + v.replace(/\|/g, "\\|") : "")).join("|");
}

/** LIB_TABLE_GRID_TRICKS::getTablePreamble. */
export const tablePreamble = (kind: LibTableKind): string => (kind === "symbol" ? "(sym_lib_table" : "(fp_lib_table");
/**
 * GRID_TRICKS::paste_text for a library table: spreadsheet rows (tab separated, or comma separated when there is no
 * tab) laid over the columns from the cursor's column on (Nickname, Library Path, Library Format, Options,
 * Description after the check columns, as COL_* orders them).
 */
export function pasteCells(text: string): string[][] {
  let t = text.replace(/\r\n?/g, "\n"); if (!t.includes("\t") && t.includes(",")) t = t.replace(/,/g, "\t");
  return t.split("\n").filter((l, i, a) => l !== "" || i < a.length - 1).map((l) => l.split("\t"));
}
/** The grid's text columns in COL_* order (lib_table_grid.h: COL_STATUS, COL_ENABLED, COL_VISIBLE, COL_NICKNAME, ...). */
export const TEXT_COLS: (keyof LibTableRow)[] = ["enabled", "visible", "nickname", "uri", "type", "options", "descr"];
/** Spreadsheet cells onto rows from `row`/`col` on (rows appended past the end), as GRID_TRICKS::paste_text writes them. */
export function applyPaste(rows: LibTableRow[], cells: string[][], row: number, col: number, blank: () => LibTableRow): void {
  cells.forEach((line, i) => {
    const r = row + i; while (rows.length <= r) rows.push(blank());
    line.forEach((v, j) => {
      const key = TEXT_COLS[col + j]; if (!key) return;
      if (key === "enabled" || key === "visible") (rows[r] as unknown as Record<string, boolean>)[key] = !/^(0|false|)$/i.test(v.trim());
      else (rows[r] as unknown as Record<string, string>)[key] = v;
    });
  });
}
/** Rows as GRID_TRICKS::copy_selection writes them: one line per row, the visible columns tab separated. */
export function copyRows(rows: LibTableRow[], visibility: boolean): string {
  return rows.map((r) => [r.enabled ? "1" : "0", ...(visibility ? [r.visible ? "1" : "0"] : []), r.nickname, r.uri, r.type, r.options, r.descr].join("\t")).join("\n");
}

/**
 * The project-relative path of a ${KIPRJMOD} uri ("${KIPRJMOD}/lib/x.kicad_sym" -> "lib/x.kicad_sym"), "" for the
 * project folder itself, null for a path outside the project.
 */
export function projectPath(uri: string): string | null {
  const m = /^\$\{KIPRJMOD\}\/?(.*)$/.exec(uri.trim().replace(/\\/g, "/")); if (!m) return null;
  return m[1].replace(/^\.\//, "").replace(/\/+$/, "");
}
/** NormalizePath with the project path: a project file as ${KIPRJMOD}/<path>. */
export const projectUri = (path: string): string => "${KIPRJMOD}/" + path.replace(/^\/+/, "");

/** The ${VAR} and $(VAR) names a uri uses (populateEnvironReadOnlyTable's regex). */
export function envVarsIn(uri: string): string[] {
  const out: string[] = []; const re = /\$\{(.+?)\}|\$\((.+?)\)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(uri))) out.push(m[1] || m[2]);
  return out;
}
/**
 * populateEnvironReadOnlyTable: every variable the tables' paths use, plus KIPRJMOD and the kind's library folder
 * (and the 3D model folder for footprints), sorted as the std::set keeps them.
 */
export function pathSubstitutions(kind: LibTableKind, uris: string[]): string[] {
  const set = new Set<string>(["KIPRJMOD", kind === "symbol" ? "KICAD10_SYMBOL_DIR" : "KICAD10_FOOTPRINT_DIR"]);
  if (kind === "footprint") set.add("KICAD10_3DMODEL_DIR");
  for (const u of uris) for (const v of envVarsIn(u)) set.add(v);
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The rows of a project table file as a set of the libraries a project document is: path -> row. */
export function rowsByProjectPath(rows: LibTableRow[]): Map<string, LibTableRow> {
  const out = new Map<string, LibTableRow>();
  for (const r of rows) { const p = projectPath(r.uri); if (p !== null) out.set(p, r); }
  return out;
}
/**
 * Whether a project library a row names is there: the file (a symbol library, a table, another plugin's file) or,
 * for a folder plugin, a file inside that folder.  `null` = not a project path (nothing to check here).
 */
export function projectLibraryExists(kind: LibTableKind, row: LibTableRow, paths: string[]): boolean | null {
  const p = projectPath(row.uri); if (p === null) return null;
  const io = plugins(kind).find((x) => x.type === row.type);
  if (io && io.folder || (kind === "symbol" && row.type === "KiCad" && !/\.kicad_sym$/i.test(p))) return paths.some((x) => x.startsWith(p + "/"));
  return paths.includes(p);
}
/**
 * The libraries of the project a picker offers for one Add Existing entry: files with the plugin's extensions, or the
 * folders holding files with its in-folder extensions (a .pretty folder for KiCad footprints, a folder of .kicad_sym
 * files for KiCad symbols); a nested table entry offers the project's library table files.
 */
export function projectCandidates(kind: LibTableKind, entry: { type: string; folder?: boolean }, paths: string[]): string[] {
  const io = plugins(kind).find((x) => x.type === entry.type); const out = new Set<string>();
  const dirOf = (p: string): string => p.split("/").slice(0, -1).join("/");
  for (const p of paths) {
    const ext = extOf(p).toLowerCase(); const name = p.split("/").pop() || "";
    if (entry.type === TABLE_TYPE) { if (name === tableFileName(kind) && p.includes("/")) out.add(p); continue; }
    if (!io) continue;
    if (kind === "symbol" && entry.folder) { if (ext === "kicad_sym" && p.includes("/")) out.add(dirOf(p)); continue; }
    if (io.folder) { if ((io.inDir || []).some((e) => e.toLowerCase() === ext) && p.includes("/")) out.add(dirOf(p)); continue; }
    if (io.exts.some((e) => e.toLowerCase() === ext)) out.add(p);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}
/** Whether the web can read a format's libraries (the KiCad formats; everything else loads in the desktop app). */
export const webReadsFormat = (type: string): boolean => type === "KiCad" || type === TABLE_TYPE;
