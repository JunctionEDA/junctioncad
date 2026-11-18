// dialogs/lib-tables.ts — DIALOG_EDIT_LIBRARY_TABLES with PANEL_SYM_LIB_TABLE ("Symbol Libraries") or
// PANEL_FP_LIB_TABLE ("Footprint Libraries"): Preferences > Manage Symbol / Footprint Libraries in every editor.
//
//   notebook   Global Libraries (the libraries this server provides: read-only) and Project Specific Libraries
//              (the project's sym-lib-table / fp-lib-table), plus a closable tab per nested table opened from a row
//   grid       status, Enable, Show (symbols only: PANEL_FP_LIB_TABLE hides COL_VISIBLE), Nickname, Library Path
//              (with GRID_CELL_PATH_EDITOR's browse button), Library Format, Options, Description; LIB_TABLE_GRID_TRICKS'
//              right-click menu, multi-row selection, s-expression / spreadsheet paste
//   buttons    small_plus, the Add Existing split button, small_up, small_down, small_trash, Reset Libraries,
//              Migrate Libraries; the read-only "Available path substitutions" grid under them
//   OK         VerifyTable on every tab ("Library Nickname Error"), then each modified table is written
//   Cancel     with changes: "Save changes to library tables?" (DIALOG_EDIT_LIBRARY_TABLES::CanClose)
//
// The web reads project files only: Add Existing and the path browser list the project's files (in a themed list,
// never the browser's file picker), and libraries outside the project are the ones the server provides.
import { KD, h, popupMenu, type GridApi, type GridColumn, type PopItem } from "./dom";
import * as T from "../library/libtable";
import { formatLibTable, parseLibTable } from "../symedit/model";
import { bitmapButton, kicadIcon, comboArrow, closeMark } from "../../../shared/components/kicon-dom";
import { trapTab } from "../tools/kicad-dialogs/shell";
import { fitMenu } from "../../../shared/menufit";
import { saveTextDocument } from "../editor/projectfile";
import { appState, api } from "./editor";

type Row = T.LibTableRow;
/** One notebook page: a table and its grid (LIB_TABLE_NOTEBOOK_PANEL). */
interface Page { title: string; rows: Row[]; readOnly: boolean; closable: boolean; path: string | null; docId: string | null; original: string; grid: GridApi<Row> | null; el: HTMLElement; tab: HTMLElement; dirty: boolean }

export interface LibTablesOpts {
  kind: T.LibTableKind;
  /** the libraries the server provides (the global table) */
  globalRows: Row[];
  /** ${VAR} values for the path substitutions grid */
  envValues: Record<string, string>;
  /** a view-only project: nothing can be changed */
  readOnly: boolean;
  /** a library's load error, for the status column (LIBRARY_TABLE_ROW::ErrorDescription) */
  loadError?(row: Row): string | null;
  /** after the project table was written: reload the libraries (PreloadLibraries) */
  onSaved?(rows: Row[]): void;
}

const blankRow = (): Row => ({ enabled: true, visible: true, nickname: "", uri: "", type: "KiCad", options: "", descr: "" });
const rowsKey = (rows: Row[]): string => JSON.stringify(rows.map((r) => [r.enabled, r.visible, r.nickname, r.uri, r.type, r.options, r.descr]));
const projectDocs = (): { docId: string; path: string; docType: string }[] => (appState.project ? appState.project.docs : []);
const projectPaths = (): string[] => projectDocs().map((d) => d.path);

async function readDoc(docId: string): Promise<string> {
  const r = await fetch(`/api/docs/${docId}/content?v=${Date.now()}`, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
/** A new document's first contents: its seq-0 snapshot, else an ordinary text save. */
export async function firstSnapshot(docId: string, text: string): Promise<boolean> {
  try { const r = await fetch(`/api/docs/${docId}/snapshots?seq=0`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: text }); if (r.ok) return true; } catch (e) { /* fall through */ }
  return saveTextDocument(docId, text, { id: "lib", kind: "MODIFIED", typeName: "LIB_SAVED", properties: [] } as unknown as KChange);
}
/** Write a project text file: the next snapshot of its document, or a new document with this as its first snapshot. */
export async function writeProjectText(path: string, text: string): Promise<string | null> {
  const proj = appState.project; if (!proj) return null;
  const d = proj.docs.find((x) => x.path === path);
  if (d) return (await saveTextDocument(d.docId, text, { id: "table", kind: "MODIFIED", typeName: "LIB_TABLE", properties: [{ name: "text", after: { type: "string", v: text } }] } as unknown as KChange)) ? d.docId : null;
  const made = await api(`/api/projects/${proj.projectId}/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }) as { docId?: string; path?: string; docType?: string };
  if (!made || !made.docId) return null;
  const r = await fetch(`/api/docs/${made.docId}/snapshots?seq=0`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: text });
  if (!r.ok) return null;
  proj.docs.push({ docId: made.docId, path: made.path || path, docType: made.docType || "lib_table" });
  return made.docId;
}

// ---------------------------------------------------------------- small modal boxes over the dialog
/** A wxMessageDialog with its own buttons (and an optional "Apply to all" check, KICAD_MESSAGE_DIALOG's checkbox). */
export function choiceBox(title: string, message: string, buttons: string[], opts?: { detail?: string; check?: string; def?: number; esc?: number }): Promise<{ index: number; checked: boolean }> {
  return new Promise((resolve) => {
    const cb = opts && opts.check ? h("input", { type: "checkbox", "data-k": "apply-all" }) as HTMLInputElement : null;
    const done = (i: number): void => { ov.remove(); resolve({ index: i, checked: !!(cb && cb.checked) }); };
    const def = opts && opts.def !== undefined ? opts.def : buttons.length - 1;
    const btns = buttons.map((b, i) => h("button", { class: "btn" + (i === def ? " primary" : ""), type: "button", "data-k": "mb-" + b.toLowerCase().replace(/\s+/g, "-"), onclick: () => done(i) }, b));
    const body = h("div", { class: "kd-body" }, h("p", { style: "margin:4px 0;white-space:pre-wrap;font-weight:600" }, message),
      opts && opts.detail ? h("p", { style: "margin:6px 0 2px;white-space:pre-wrap" }, opts.detail) : null,
      cb ? h("label", { class: "kd-chk", style: "margin-top:10px" }, cb, opts!.check!) : null);
    const dlg = h("div", { class: "kd-dialog", style: "width:max-content;min-width:400px;max-width:min(600px, calc(100vw - 32px))" }, h("div", { class: "kd-title" }, h("span", null, title)), body, h("div", { class: "kd-foot" }, h("span", { class: "spacer" }), ...btns));
    const ov = h("div", { class: "kd-overlay kd-prompt", style: "z-index:90", "data-k": "choicebox" }, dlg);
    ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Tab") trapTab(ev, ov); if (ev.key === "Escape") { ev.preventDefault(); done(opts && opts.esc !== undefined ? opts.esc : buttons.length - 1); } });
    document.body.append(ov); btns[def].focus();
  });
}
const okBox = (title: string, message: string): Promise<unknown> => choiceBox(title, message, ["OK"]);
const isOK = async (message: string): Promise<boolean> => (await choiceBox("Confirmation", message, ["Cancel", "OK"])).index === 1;

/**
 * A themed picker over the project's files (the web's stand-in for wxFileDialog / wxDirDialog with wxFD_MULTIPLE):
 * the candidates in a list with a filter; resolves the chosen paths, or null on Cancel.
 */
export function pickProjectPaths(title: string, paths: string[], opts?: { multiple?: boolean; select?: string; empty?: string }): Promise<string[] | null> {
  return new Promise((resolve) => {
    let shown = paths.slice(); const chosen = new Set<string>(opts && opts.select && paths.includes(opts.select) ? [opts.select] : shown.length ? [shown[0]] : []);
    let anchor = 0;
    const filter = h("input", { type: "text", class: "input", placeholder: "Filter", "data-k": "filter", style: "width:100%;box-sizing:border-box;margin-bottom:6px" }) as HTMLInputElement;
    const list = h("div", { class: "kd-grid-wrap", "data-k": "paths", style: "height:260px;overflow:auto;border:1px solid var(--line);background:var(--panel)" });
    const render = (): void => {
      list.innerHTML = "";
      if (!shown.length) { list.append(h("div", { class: "muted", style: "padding:8px" }, opts && opts.empty || "No matching files in the project.")); return; }
      shown.forEach((p, i) => {
        const row = h("div", { class: "kd-path-row" + (chosen.has(p) ? " sel" : ""), "data-path": p, style: "padding:3px 8px;cursor:default;white-space:nowrap;font-family:var(--mono, monospace);font-size:12px" + (chosen.has(p) ? ";background:var(--sel)" : "") }, "${KIPRJMOD}/" + p);
        row.addEventListener("pointerdown", (ev) => {
          if (opts && opts.multiple && (ev.ctrlKey || ev.metaKey)) { if (chosen.has(p)) chosen.delete(p); else chosen.add(p); anchor = i; }
          else if (opts && opts.multiple && ev.shiftKey) { chosen.clear(); for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) chosen.add(shown[k]); }
          else { chosen.clear(); chosen.add(p); anchor = i; }
          render();
        });
        row.addEventListener("dblclick", () => { chosen.clear(); chosen.add(p); done(true); });
        list.append(row);
      });
    };
    filter.addEventListener("input", () => { const f = filter.value.toLowerCase(); shown = paths.filter((p) => p.toLowerCase().includes(f)); render(); });
    const done = (ok: boolean): void => { ov.remove(); resolve(ok ? shown.filter((p) => chosen.has(p)) : null); };
    const ok = h("button", { class: "btn primary", type: "button", "data-k": "pick-ok", onclick: () => { if (chosen.size) done(true); } }, "Open");
    const cancel = h("button", { class: "btn", type: "button", onclick: () => done(false) }, "Cancel");
    const dlg = h("div", { class: "kd-dialog", style: "width:560px;max-width:calc(100vw - 32px)" }, h("div", { class: "kd-title" }, h("span", null, title)),
      h("div", { class: "kd-body" }, filter, list), h("div", { class: "kd-foot" }, h("span", { class: "spacer" }), cancel, ok));
    const ov = h("div", { class: "kd-overlay kd-prompt", style: "z-index:85", "data-k": "path-picker" }, dlg);
    ov.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Tab") trapTab(ev, ov); if (ev.key === "Escape") { ev.preventDefault(); done(false); } else if (ev.key === "Enter") { ev.preventDefault(); if (chosen.size) done(true); } });
    render(); document.body.append(ov); filter.focus();
  });
}

/**
 * DIALOG_PLUGIN_OPTIONS "Options for Library '%s'": the row's options as an Option / Value grid, and the plugin's
 * option choices with "<<    Append Selected Option".  Resolves the formatted options, or null on Cancel.
 */
export function pluginOptionsDialog(nickname: string, options: string, choices: [string, string][], readOnly: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const rows = [...T.parseOptions(options)].map(([option, value]) => ({ option, value }));
    let grid: GridApi<{ option: string; value: string }> | null = null; let picked = -1; let settled = false;
    const finish = (v: string | null): void => { if (settled) return; settled = true; resolve(v); };
    KD().open({
      title: `Options for Library '${nickname}'`, width: 720, child: true, readOnly,
      build(body) {
        const wrap = h("div", { style: "display:flex;gap:10px;min-height:260px" });
        const left = KD().staticBox(wrap, "Plugin Options"); left.style.flex = "3"; left.style.margin = "8px 0";
        grid = KD().grid(left, [{ key: "option", label: "Option", width: 160 }, { key: "value", label: "Value", width: 220 }], rows,
          { readOnly, height: 200, buttons: readOnly ? undefined : { add: () => ({ option: "", value: "" }), addTitle: "Add", remove: true, removeTitle: "Delete" } });
        const right = KD().staticBox(wrap, "Option Choices"); right.style.flex = "2"; right.style.margin = "8px 0";
        const lb = h("div", { "data-k": "choices", title: "Options supported by current plugin", style: "height:110px;overflow:auto;border:1px solid var(--line);background:var(--panel)" });
        const help = h("div", { "data-k": "help", style: "margin-top:6px;min-height:60px;font-size:12px;color:var(--ink-2)" });
        const showHelp = (): void => { help.innerHTML = picked >= 0 ? choices[picked][1].replace(/</g, "&lt;").replace(/&lt;(\/?)b>/g, "<$1b>") : "Select an <b>Option Choice</b> in the listbox above, and then click the <b>Append Selected Option</b> button."; };
        const append = (): void => {
          if (picked < 0 || readOnly || !grid) return; const name = choices[picked][0];
          if (!rows.some((r) => r.option === name)) { rows.push({ option: name, value: "" }); grid.refresh(); grid.select(rows.length - 1); }
        };
        choices.forEach(([name], i) => { const it = h("div", { style: "padding:2px 6px;cursor:default", "data-choice": name }, name);
          it.addEventListener("click", () => { picked = i; [...lb.children].forEach((c, j) => { (c as HTMLElement).style.background = j === i ? "var(--sel)" : ""; }); showHelp(); });
          it.addEventListener("dblclick", append); lb.append(it); });
        const btn = h("button", { class: "btn", type: "button", "data-k": "append-option", disabled: readOnly || !choices.length, onclick: append }, "<<    Append Selected Option");
        right.append(lb, h("div", { style: "margin-top:6px" }, btn), help); showHelp();
        body.append(wrap);
      },
      ok() { finish(T.formatOptions(rows.map((r) => [r.option.trim(), r.value.trim()] as [string, string]))); },
      cancel() { finish(null); },
    });
  });
}

// ---------------------------------------------------------------- the dialog
const CSS = `
.kd-libtable .kd-split .btn:disabled { opacity: .45; }
`;
let cssDone = false;
function ensureCss(): void { if (cssDone || typeof document === "undefined") return; cssDone = true; document.head.append(h("style", { id: "kd-libtable-css" }, CSS)); }

export async function openLibTables(opts: LibTablesOpts): Promise<void> {
  const proj = appState.project; if (!proj) return;
  const kind = opts.kind, sym = kind === "symbol", tableFile = T.tableFileName(kind);
  const tableDoc = proj.docs.find((d) => d.path === tableFile);
  let projText = "";
  if (tableDoc) { try { projText = await readDoc(tableDoc.docId); } catch { /* an unreadable table lists nothing */ } }
  const ro = opts.readOnly;
  const pages: Page[] = [];
  let cur = 0;
  ensureCss();
  const nb = h("div", { class: "kd-nb", "data-k": "libtable-notebook" }); const bar = h("div", { class: "kd-nb-tabs" }); nb.append(bar);
  const pageOf = (): Page => pages[cur];
  const subsRows: { name: string; value: string }[] = []; let subsGrid: GridApi<{ name: string; value: string }> | null = null;

  /** LIB_TABLE_NOTEBOOK_PANEL::MarkDirty / ClearDirty: " *" after a modified tab's title. */
  const markDirty = (p: Page): void => { p.dirty = rowsKey(p.rows) !== p.original; const t = p.tab.querySelector<HTMLElement>(".kd-nb-label"); if (t) t.textContent = p.title + (p.dirty ? " *" : ""); };
  const refreshSubs = (): void => {
    subsRows.splice(0, subsRows.length, ...T.pathSubstitutions(kind, pages.flatMap((p) => p.rows.map((r) => r.uri))).map((n) => ({ name: "${" + n + "}", value: opts.envValues[n] || "" })));
    if (subsGrid) subsGrid.refresh();
  };
  const select = (i: number): void => {
    cur = i; pages.forEach((p, j) => { p.el.style.display = j === i ? "" : "none"; p.tab.classList.toggle("on", j === i); });
  };

  const statusCell = (p: Page) => (r: Row) => {
    if (r.type === T.TABLE_TYPE && !r.enabled) return null;
    const err = !r.enabled ? null : rowError(r);
    const title = r.type === T.TABLE_TYPE ? `Error loading library table '${r.nickname}'` : `Error loading library '${r.nickname}'`;
    if (err) return { icon: "small_warning", title: err, run: () => { void okBox(title, err); } };
    if (r.type === T.TABLE_TYPE) return { icon: "small_new_window", title: "Open library table", run: () => { void openNested(r, p); } };
    return null;
  };
  /** CheckTableRow: a project library that is not in the project, a format the web does not read, the caller's own errors. */
  const rowError = (r: Row): string | null => {
    if (!r.uri.trim()) return null;
    const there = T.projectLibraryExists(kind, r, projectPaths());
    if (there === false) return `Library '${r.uri}' not found.`;
    if (!T.webReadsFormat(r.type)) return `The ${r.type} library format is read by KiCad's desktop applications only.`;
    return opts.loadError ? opts.loadError(r) : null;
  };

  const columns = (p: Page): GridColumn<Row>[] => {
    const lock = (c: GridColumn<Row>): GridColumn<Row> => (p.readOnly ? { ...c, ro: () => true } : c);
    const cols: GridColumn<Row>[] = [
      { key: "status", label: " ", type: "icon", width: 24, icon: statusCell(p) },
      lock({ key: "enabled", label: "Enable", type: "bool", width: 52 }),
    ];
    if (sym) cols.push(lock({ key: "visible", label: "Show", type: "bool", width: 46 }));
    cols.push(lock({ key: "nickname", label: "Nickname", width: 150 }),
      lock({ key: "uri", label: "Library Path", width: 300, button: p.readOnly ? undefined : (r) => ({ icon: () => "small_folder", title: () => "Browse...", run: (_v, set) => { void browsePath(r, set); } }) }),
      lock({ key: "type", label: "Library Format", type: "choice", width: 150, options: (r) => T.formatChoices(kind, r.type) }),
      lock({ key: "options", label: "Options", width: 90, button: p.readOnly ? undefined : (r) => (r.type === T.TABLE_TYPE ? null : { icon: () => "small_edit", title: () => "Edit Options...", run: (_v, set) => { void editOptions(r, p, set); } }) }),
      lock({ key: "descr", label: "Description", width: 200 }));
    return cols;
  };

  /** GRID_CELL_PATH_EDITOR: a project file for the row; the format follows the path (SYMBOL_LIB_TABLE_GRID::SetValue). */
  const browsePath = async (r: Row, set: (v: string) => void): Promise<void> => {
    const io = T.plugins(kind).find((x) => x.type === r.type);
    const entry = { type: r.type, folder: !!(io && io.folder) || (sym && r.type === "KiCad" && /\.kicad_symdir$|\/$/.test(r.uri)) };
    const cands = T.projectCandidates(kind, entry, projectPaths());
    const cur0 = T.projectPath(r.uri);
    const got = await pickProjectPaths(r.type === T.TABLE_TYPE ? "Select Library Table" : `Select ${r.type} Library`, cands, { select: cur0 || undefined });
    if (!got || !got[0]) return;
    const uri = T.projectUri(got[0]); const g = T.guessFormat(kind, got[0]);
    r.uri = uri; if (g) r.type = g;
    set(uri); const p = pageOf(); if (p.grid) p.grid.refresh(); markDirty(p); refreshSubs();
  };
  const editOptions = async (r: Row, p: Page, set?: (v: string) => void): Promise<void> => {
    const io = T.plugins(kind).find((x) => x.type === r.type);
    const res = await pluginOptionsDialog(r.nickname, r.options, (io && io.options) || [], p.readOnly);
    if (res === null || res === r.options) return;
    r.options = res; if (set) set(res); if (p.grid) p.grid.refresh(); markDirty(p);
  };

  /** PANEL_*_LIB_TABLE::OpenTable: a nested table in its own closable tab (" (read-only)" when it cannot be written). */
  const openNested = async (r: Row, from: Page): Promise<void> => {
    const path = T.projectPath(r.uri);
    const ro2 = path === null || ro || from.readOnly;
    const title = r.nickname + (ro2 ? " (read-only)" : "");
    const have = pages.findIndex((p) => p.title === title); if (have >= 0) { select(have); return; }
    const d = path !== null ? projectDocs().find((x) => x.path === path) : undefined;
    if (!d) { await okBox("Message", "Unable to load library table."); return; }
    let rows: Row[];
    try { rows = parseLibTable(await readDoc(d.docId)); } catch { await okBox("Message", "Unable to load library table."); return; }
    addPage(title, rows, ro2, true, path, d.docId); select(pages.length - 1);
  };

  const addPage = (title: string, rows: Row[], readOnly: boolean, closable: boolean, path: string | null, docId: string | null): Page => {
    const el = h("div", { class: "kd-nb-page", "data-page": String(pages.length) });
    const tab = h("div", { class: "kd-nb-tab", "data-tab": title }, h("span", { class: "kd-nb-label" }, title));
    const p: Page = { title, rows, readOnly, closable, path, docId, original: rowsKey(rows), grid: null, el, tab, dirty: false };
    if (closable) {
      // wxAUI_NB_CLOSE_ON_ALL_TABS: the tab's close box, drawn like the dialog's own
      const x = h("button", { class: "kd-nb-x", type: "button", title: "Close", "aria-label": "Close", style: "border:0;background:transparent;margin-left:6px;padding:0 2px;cursor:pointer;color:var(--ink-2);line-height:1;display:inline-flex;align-items:center" }, closeMark());
      x.addEventListener("click", (ev) => { ev.stopPropagation(); void closePage(p); });
      tab.append(x);
    }
    tab.addEventListener("click", () => select(pages.indexOf(p)));
    bar.append(tab); nb.append(el); pages.push(p);
    buildGrid(p);
    return p;
  };
  /** onNotebookPageCloseRequest: a modified nested table asks first. */
  const closePage = async (p: Page): Promise<void> => {
    if (p.dirty) { const c = await choiceBox("Confirmation", `Save changes to '${p.title}'?`, ["Cancel", "Discard Changes", "Save"], { def: 2, esc: 0 }); if (c.index === 0) return; if (c.index === 2 && !(await savePage(p))) return; }
    const i = pages.indexOf(p); pages.splice(i, 1); p.el.remove(); p.tab.remove(); select(Math.min(cur, pages.length - 1)); refreshSubs();
  };

  const buildGrid = (p: Page): void => {
    const g = KD().grid(p.el, columns(p), p.rows, {
      height: 300, multiSelect: true,
      onChange: (r, key) => {
        if (key === "uri") { const path = T.projectPath(String(r.uri)); const guess = path !== null ? T.guessFormat(kind, path) : T.guessFormat(kind, String(r.uri)); if (guess && guess !== r.type) { r.type = guess; g.refresh(); } refreshSubs(); }
        if (key === "enabled" || key === "uri" || key === "type") g.refresh();
        markDirty(p);
      },
      onContextMenu: (ev, i) => { const sel = g.selectedRows(); if (!sel.includes(i)) g.select(i); showMenu(p, ev); },
      buttons: p.readOnly ? undefined : {
        add: () => blankRow(), addTitle: "Add empty row to table", remove: true, removeTitle: "Remove library from table", move: true, gapBeforeRemove: true,
        afterAdd: [addExistingButton()],
      },
    });
    p.grid = g;
    // a read-only page still shows the button row (disabled): KiCad keeps one row under the notebook
    const bar2 = g.bar || readOnlyBar(); if (!g.bar) p.el.append(bar2);
    appendTrailingButtons(bar2, pages.indexOf(p) === 0);
    if (p.rows.length) g.select(0);
    // Ctrl+V while a cell editor is open: multi-column text goes into an empty row (LIB_TABLE_GRID_TRICKS::onCharHook)
    g.el.addEventListener("paste", (ev) => {
      const text = ev.clipboardData ? ev.clipboardData.getData("text/plain") : ""; if (!text || p.readOnly) return;
      const multi = /[\t\n\r]/.test(text) || (!text.includes("\t") && text.includes(",") && text.includes(T.tablePreamble(kind)));
      if (!multi && !text.includes(T.tablePreamble(kind))) return;
      ev.preventDefault(); pasteInto(p, text);
    });
    g.el.addEventListener("keydown", (ev) => {
      if (ev.target instanceof HTMLInputElement && ev.target.type === "text") return;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === "a") { ev.preventDefault(); g.selectRows(p.rows.map((_r, i) => i)); }
      else if (mod && ev.key.toLowerCase() === "c") { ev.preventDefault(); void copySel(p, false); }
      else if (mod && ev.key.toLowerCase() === "x" && !p.readOnly) { ev.preventDefault(); void copySel(p, true); }
      else if (mod && ev.key.toLowerCase() === "v" && !p.readOnly) { ev.preventDefault(); void navigator.clipboard.readText().then((t) => pasteInto(p, t)).catch(() => undefined); }
      else if ((ev.key === "Delete" || ev.key === "Backspace") && !p.readOnly && g.removeRows) { ev.preventDefault(); g.removeRows(g.selectedRows()); markDirty(p); }
    });
  };
  const readOnlyBar = (): HTMLElement => {
    const b = h("div", { class: "kd-grid-btns" });
    for (const [icon, title] of [["small_plus", "Add empty row to table"]] as [string, string][]) b.append(bitmapButton(icon, title, null, { disabled: true }));
    b.append(addExistingButton(true));
    for (const [icon, title] of [["small_up", "Move up"], ["small_down", "Move down"]] as [string, string][]) b.append(bitmapButton(icon, title, null, { disabled: true }));
    b.append(h("span", { class: "kd-gap" }), bitmapButton("small_trash", "Remove library from table", null, { disabled: true }));
    return b;
  };
  /** SPLIT_BUTTON "Add Existing" with small_folder: the button adds a KiCad library, its arrow lists every plugin. */
  const addExistingButton = (disabled = false): HTMLElement => {
    const main = h("button", { class: "btn", type: "button", "data-btn": "add-existing", title: "Add Existing", disabled, style: "display:inline-flex;align-items:center;gap:4px;padding:1px 6px;height:24px;border-top-right-radius:0;border-bottom-right-radius:0" }, kicadIcon("small_folder", 16), "Add Existing");
    const arrow = h("button", { class: "btn", type: "button", "data-btn": "add-existing-menu", title: "Add Existing", disabled, style: "padding:0 4px;height:24px;margin-left:-1px;border-top-left-radius:0;border-bottom-left-radius:0" }, comboArrow());
    main.addEventListener("click", () => { void browseLibraries(T.addExistingMenu(kind)[0]); });
    arrow.addEventListener("click", () => {
      const r = arrow.getBoundingClientRect();
      const m = popupMenu(r.left, r.bottom + 2, T.addExistingMenu(kind).map((e): PopItem => ({ label: e.label, run: () => { if (e.newDatabase) void okBox("Message", "Database libraries connect to a database server through ODBC, which only KiCad's desktop applications can reach."); else void browseLibraries(e); } })));
      m.dataset.k = "add-existing-menu"; fitMenu(m, { at: { x: r.left, y: r.bottom + 2 } });
    });
    return h("span", { class: "kd-split", style: "display:inline-flex" }, main, arrow);
  };
  /** Reset Libraries and Migrate Libraries, right of the grid buttons. */
  const appendTrailingButtons = (b: HTMLElement, global: boolean): void => {
    b.append(h("span", { class: "kd-fill" }));
    // onPageChange: Reset Libraries is enabled on the global page only
    const reset = h("button", { class: "btn", type: "button", "data-btn": "reset", disabled: !global }, "Reset Libraries") as HTMLButtonElement;
    reset.addEventListener("click", () => { void onReset(); });
    const migrate = h("button", { class: "btn", type: "button", "data-btn": "migrate", disabled: ro || global }, "Migrate Libraries") as HTMLButtonElement;
    migrate.addEventListener("click", () => { void onMigrate(); });
    b.append(reset, migrate);
  };

  /** browseLibrariesHandler: pick project files of the entry's kind; a duplicate nickname asks Skip / Add Anyway. */
  const browseLibraries = async (entry: T.AddExistingEntry): Promise<void> => {
    const p = pageOf(); if (p.readOnly || !p.grid) return;
    const title = entry.type === T.TABLE_TYPE ? "Select Library Table" : `Select ${entry.type} Library`;
    const cands = T.projectCandidates(kind, entry, projectPaths());
    const files = await pickProjectPaths(title, cands, { multiple: true, empty: `The project has no ${entry.label.replace(/^[^(]*\(|\)$/g, "")} to add.` });
    if (!files || !files.length) return;
    let addDuplicates = false, applyToAll = false;
    for (const f of files) {
      const nick = T.nicknameFor(kind, f, entry.type); let doAdd = true;
      if (p.rows.some((r) => r.nickname === nick)) {
        if (!applyToAll) {
          // OKOrCancelDialog: OK is Skip, Cancel adds the library anyway
          const c = await choiceBox("Warning: Duplicate Nicknames", `An item nicknamed '${nick}' already exists.`, ["Add Anyway", "Skip"], { detail: "One of the nicknames will need to be changed.", check: "Apply to all", def: 1, esc: 0 });
          addDuplicates = c.index === 0; applyToAll = c.checked;
        }
        doAdd = addDuplicates;
      }
      if (doAdd) p.rows.push({ ...blankRow(), nickname: nick, type: entry.type, uri: T.projectUri(f) });
    }
    p.grid.refresh(); p.grid.select(p.rows.length - 1); markDirty(p); refreshSubs();
    const last = p.grid.el.querySelector<HTMLElement>("tbody tr:last-child"); if (last && last.scrollIntoView) last.scrollIntoView({ block: "nearest" });
  };
  /** onReset: the global table is the server's own, so there is nothing on disk to reset. */
  const onReset = async (): Promise<void> => {
    const g = pages[0]; if (!g) return;
    if (g.rows.length && !(await isOK("This action will reset your global library table on disk and cannot be undone."))) return;
    await okBox("Message", `The global library table is the KiCad ${sym ? "symbol" : "footprint"} library set this server provides. It is already the default table.`);
  };
  /** onMigrateLibraries: the selected rows of a non-KiCad format, saved as KiCad libraries. */
  const onMigrate = async (): Promise<void> => {
    const p = pageOf(); if (!p.grid || p.readOnly) return;
    const skip = new Set(["KiCad", T.TABLE_TYPE, ...(sym ? ["Database", "HTTP"] : [])]);
    const rows = p.grid.selectedRows().filter((i) => p.rows[i] && !skip.has(p.rows[i].type));
    if (!rows.length) { await okBox("Message", "Select one or more rows containing libraries to save as current KiCad format."); return; }
    const msg = rows.length === 1
      ? (sym ? `Save '${p.rows[rows[0]].nickname}' as current KiCad format (*.kicad_sym) and replace legacy entry in table?` : `Save '${p.rows[rows[0]].nickname}' as current KiCad format and replace entry in table?`)
      : (sym ? `Save ${rows.length} libraries as current KiCad format (*.kicad_sym) and replace legacy entries in table?` : `Save ${rows.length} libraries as current KiCad format and replace entries in table?`);
    if (!(await isOK(msg))) return;
    for (const i of rows) {
      const r = p.rows[i]; const path = T.projectPath(r.uri);
      if (path === null || !projectPaths().some((x) => x === path || x.startsWith(path + "/"))) { await okBox("Error", `Library '${r.uri}' not found.`); continue; }
      const target = sym ? path.replace(/\.[^./]*$/, "") + ".kicad_sym" : path.replace(/\.[^./]*$/, "") + ".pretty";
      if (projectPaths().some((x) => x === target || x.startsWith(target + "/"))) {
        const c = await choiceBox("Migrate Library", sym ? `File '${target}' already exists. Do you want overwrite this file?` : `Folder '${target}' already exists. Do you want overwrite any existing footprints?`, ["Cancel", "No", "Yes"], { def: 2, esc: 0 });
        if (c.index === 0) return; if (c.index === 1) continue;
      }
      // SCH_IO_MGR / PCB_IO_MGR::ConvertLibrary: the readers of these formats live in KiCad's desktop applications
      await okBox("Error", (sym ? `Failed to save symbol library file '${target}'.` : `Failed to save footprint library file '${target}'.`) + `\n\nThe web editor cannot read ${r.type} libraries; migrate this one in KiCad.`);
    }
  };

  // ---------------------------------------------------------------- LIB_TABLE_GRID_TRICKS
  const showMenu = (p: Page, ev: MouseEvent): void => {
    const g = p.grid!; const sel = g.selectedRows(); const first = p.rows[sel[0]]; if (!first) return;
    const items: PopItem[] = [];
    if (first.type === T.TABLE_TYPE) items.push({ label: "Open Library Table", run: () => { void openNested(first, p); } }, { sep: true });
    const anyOn = sel.some((i) => p.rows[i].enabled), anyOff = sel.some((i) => !p.rows[i].enabled);
    const anyVis = sel.some((i) => p.rows[i].visible), anyHid = sel.some((i) => !p.rows[i].visible);
    const setAll = (key: "enabled" | "visible", v: boolean) => () => { for (const i of sel) p.rows[i][key] = v; g.refresh(); g.selectRows(sel); markDirty(p); };
    let block = false;
    if (!p.readOnly) {
      if (anyOff) { items.push({ label: "Activate Selected", run: setAll("enabled", true) }); block = true; }
      if (anyOn) { items.push({ label: "Deactivate Selected", run: setAll("enabled", false) }); block = true; }
      if (sym && anyHid) { items.push({ label: "Set Visible Flag", run: setAll("visible", true) }); block = true; }
      if (sym && anyVis) { items.push({ label: "Unset Visible Flag", run: setAll("visible", false) }); block = true; }
      if (sel.length === 1 && first.type !== T.TABLE_TYPE) { items.push({ label: "Edit Options...", title: "Edit options for this library entry", run: () => { void editOptions(first, p); } }); block = true; }
      if (block) items.push({ sep: true });
      // GRID_TRICKS::showPopupMenu
      items.push({ label: "Cut", key: "Ctrl+X", title: "Clear selected cells placing original contents on clipboard", run: () => { void copySel(p, true); } },
        { label: "Copy", key: "Ctrl+C", title: "Copy selected cells to clipboard", run: () => { void copySel(p, false); } },
        { label: "Paste", key: "Ctrl+V", title: "Paste clipboard cells to matrix at current cell", run: () => { void navigator.clipboard.readText().then((t) => pasteInto(p, t)).catch(() => undefined); } },
        { label: "Delete", key: "Del", title: "Clear contents of selected cells", run: () => { if (g.removeRows) { g.removeRows(sel); markDirty(p); } } },
        { label: "Select All", key: "Ctrl+A", title: "Select all cells", run: () => g.selectRows(p.rows.map((_r, i) => i)) });
    } else {
      items.push({ label: "Copy", key: "Ctrl+C", title: "Copy selected cells to clipboard", run: () => { void copySel(p, false); } },
        { label: "Select All", key: "Ctrl+A", title: "Select all cells", run: () => g.selectRows(p.rows.map((_r, i) => i)) });
    }
    if (items[items.length - 1] && items[items.length - 1].sep) items.pop();
    const m = popupMenu(ev.clientX, ev.clientY, items); m.dataset.k = "libtable-menu";
  };
  const copySel = async (p: Page, cut: boolean): Promise<void> => {
    const g = p.grid!; const sel = g.selectedRows(); if (!sel.length) return;
    try { await navigator.clipboard.writeText(T.copyRows(sel.map((i) => p.rows[i]), sym)); } catch { /* no clipboard access */ }
    if (cut && !p.readOnly) { for (const i of sel) Object.assign(p.rows[i], { nickname: "", uri: "", options: "", descr: "" }); g.refresh(); markDirty(p); }
  };
  /** paste_text: a "(sym_lib_table" / "(fp_lib_table" text inserts its rows at the top; spreadsheet text fills cells from the cursor. */
  const pasteInto = (p: Page, text: string): void => {
    if (p.readOnly || !p.grid) return;
    const pre = T.tablePreamble(kind); const at = text.indexOf(pre);
    if (at >= 0) {
      const rows = parseLibTable(text.slice(at));
      if (!rows.length) { void okBox("Error", "Unable to read the pasted library table."); return; }
      p.rows.unshift(...rows);
    } else {
      const g = p.grid; let row = Math.max(0, g.selected());
      // an open cell editor on a row that has a nickname takes nothing (wxBell)
      const focus = document.activeElement as HTMLInputElement | null;
      if (focus && focus.dataset && focus.dataset.col && p.rows[row] && p.rows[row].nickname) return;
      if (row >= p.rows.length) row = p.rows.length;
      const startCol = focus && focus.dataset && focus.dataset.col ? Math.max(0, T.TEXT_COLS.indexOf(focus.dataset.col as keyof Row)) : T.TEXT_COLS.indexOf("nickname");
      const cells = T.pasteCells(text);
      // the Show column is hidden for footprints: pasted columns skip it
      const cols = sym ? cells : cells.map((l) => (startCol <= 1 ? [...l.slice(0, 1 - startCol), "1", ...l.slice(1 - startCol)] : l));
      T.applyPaste(p.rows, cols, row, startCol, blankRow);
    }
    p.grid.refresh(); markDirty(p); refreshSubs();
  };

  // ---------------------------------------------------------------- saving
  const written = new Set<Page>();
  const savePage = async (p: Page): Promise<boolean> => {
    if (p.readOnly || !p.path) return true;
    const v = T.verifyRows(p.rows, sym);
    if (v.error) { select(pages.indexOf(p)); if (p.grid && v.row !== undefined) { p.rows.splice(0, p.rows.length, ...v.rows); p.grid.refresh(); p.grid.select(v.row); } await okBox("Library Nickname Error", v.error); return false; }
    p.rows.splice(0, p.rows.length, ...v.rows); if (p.grid) p.grid.refresh();
    // TransferDataFromWindow writes a table only when it differs from the one loaded (a missing table loads empty)
    if (rowsKey(p.rows) === p.original) return true;
    const text = formatLibTable(p.rows, kind === "symbol" ? "sym_lib_table" : "fp_lib_table");
    const id = await writeProjectText(p.path, text);
    if (!id) { await okBox("File Save Error", `Error saving project library table:\n\n'${p.path}' could not be written.`); return false; }
    p.docId = id; p.original = rowsKey(p.rows); markDirty(p); written.add(p);
    window.dispatchEvent(new CustomEvent("kc-doc-saved", { detail: { docId: id, savedDocId: id } }));
    return true;
  };
  const saveAll = async (): Promise<boolean> => {
    // VerifyTable on every page before anything is written
    for (const p of pages) {
      if (p.readOnly) continue;
      const v = T.verifyRows(p.rows, sym);
      if (v.error) { select(pages.indexOf(p)); p.rows.splice(0, p.rows.length, ...v.rows); if (p.grid) { p.grid.refresh(); if (v.row !== undefined) p.grid.select(v.row); } await okBox("Library Nickname Error", v.error); return false; }
    }
    const projPage = pages[1]; written.clear();
    for (const p of pages) if (!(await savePage(p))) return false;
    // PreloadLibraries runs only when the project table was written
    if (projPage && written.has(projPage) && opts.onSaved) opts.onSaved(projPage.rows.slice());
    return true;
  };

  let closing = false; let dlgApi: { close(): void } | null = null;
  KD().open({
    title: sym ? "Symbol Libraries" : "Footprint Libraries", width: 1000, cls: "kd-wide kd-libtable kd-nowrap", readOnly: ro, geomKey: sym ? "DIALOG_EDIT_LIBRARY_TABLES:sym" : "DIALOG_EDIT_LIBRARY_TABLES:fp",
    build(body, a) {
      dlgApi = a;
      body.append(nb);
      addPage("Global Libraries", opts.globalRows.map((r) => ({ ...r })), true, false, null, null);
      addPage("Project Specific Libraries", projText ? parseLibTable(projText) : [], ro, false, tableFile, tableDoc ? tableDoc.docId : null);
      const lbl = h("div", { style: "margin:10px 0 2px" }, "Available path substitutions:"); body.append(lbl);
      const subsWrap = h("div", { "data-k": "path-subs", title: "This is a read-only table which shows pertinent environment variables.", class: "kd-subs" }); body.append(subsWrap);
      subsGrid = KD().grid(subsWrap, [{ key: "name", label: "Name", type: "ro", width: 220 }, { key: "value", label: "Value", type: "ro", width: 620 }], subsRows, { readOnly: true, height: 92, noHeader: true });
      refreshSubs();
      select(1);
    },
    ok() {
      if (ro) return true;
      void saveAll().then((ok) => { if (ok) { closing = true; if (dlgApi) dlgApi.close(); } });
      return false;
    },
    cancel() {
      if (closing || ro) return true;
      if (!pages.some((p) => !p.readOnly && rowsKey(p.rows) !== p.original)) return true;
      // DIALOG_EDIT_LIBRARY_TABLES::CanClose through HandleUnsavedChanges
      void choiceBox("Save Changes?", "Save changes to library tables?", ["Discard Changes", "Cancel", "Save"], { def: 2, esc: 1, detail: "If you don't save, all your changes will be permanently lost." }).then(async (c) => {
        if (c.index === 1) return;
        if (c.index === 2 && !(await saveAll())) return;
        closing = true; if (dlgApi) dlgApi.close();
      });
      return false;
    },
  });
}

/** The values the path substitutions grid shows for the server's library folders (populateEnvironReadOnlyTable). */
export function serverEnvValues(refs: { symbol?: string; footprint?: string }): Record<string, string> {
  const proj = appState.project;
  return {
    KIPRJMOD: proj ? `${proj.name} (this project's files)` : "",
    KICAD10_SYMBOL_DIR: `gitlab.com/kicad/libraries/kicad-symbols${refs.symbol ? " @ " + refs.symbol : ""}`,
    KICAD10_FOOTPRINT_DIR: `gitlab.com/kicad/libraries/kicad-footprints${refs.footprint ? " @ " + refs.footprint : ""}`,
    KICAD10_3DMODEL_DIR: "gitlab.com/kicad/libraries/kicad-packages3D",
  };
}

/**
 * InvokeSchEditSymbolLibTable / InvokePcbLibTableEditor from any frame: the server's libraries as the global table,
 * the project's table, and the frame's own reload after the project table changes.
 */
export async function manageLibraries(kind: T.LibTableKind, frame?: { readOnly?: boolean; loadError?(row: Row): string | null; onSaved?(rows: Row[]): void }): Promise<void> {
  let ref = ""; let globalRows: Row[] = [];
  try {
    const { officialLibraries } = await import("../library/sources");
    const t = await officialLibraries(kind); ref = t.ref || "";
    globalRows = t.libraries.map((l) => ({ enabled: true, visible: true, nickname: l.name, type: "KiCad", options: "", descr: l.description || "",
      uri: kind === "symbol" ? "${KICAD10_SYMBOL_DIR}/" + l.name + ".kicad_symdir" : "${KICAD10_FOOTPRINT_DIR}/" + l.name + ".pretty" }));
  } catch { /* the server's libraries are out of reach: an empty global table */ }
  await openLibTables({ kind, globalRows, envValues: serverEnvValues(kind === "symbol" ? { symbol: ref } : { footprint: ref }), readOnly: !!(frame && frame.readOnly),
    loadError: frame && frame.loadError, onSaved: (rows) => {
      // PreloadLibraries: the choosers and trees read the project's libraries again
      window.dispatchEvent(new CustomEvent("kc-libtable-changed", { detail: { kind, rows } }));
      if (frame && frame.onSaved) frame.onSaved(rows);
    } });
}
