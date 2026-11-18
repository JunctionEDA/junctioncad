// pcbdialogs/fp-fields — Edit > Bulk Edit Footprint Fields... (DIALOG_FOOTPRINT_FIELDS_TABLE over
// common/dialogs/dialog_fields_table_base.fbp, "Footprint Fields Table").
//
// Left (collapsible with the sidebar button): the view-controls grid (Field / BOM Name / Include / Group By) with the
// add, rename and remove field bitmap buttons, "View presets:" and the "Schematic variants:" list (the variant buttons
// are hidden: variants come only from the schematic).  Right: the Edit page (the filter, its scope References /
// Visible / All, the scope Entire Project / Current Sheet Only / Current Sheet and Down / Selection, Group symbols,
// refresh and the menu button with Include 'DNP' Footprints, Include 'Exclude from BOM' Footprints, Highlight /
// Select on Cross-probe) and the Export page (delimiters, Keep tabs / line breaks, byte order mark, Format presets,
// Output file with its browse button, Preview with refresh).  The buttons: Export, "Apply, Save Board & Continue",
// Cancel, OK.  A cell edit applies to every footprint of its row; OK / Apply commit them as one change.
import { E } from "../state";
import { popupMenu } from "../../dialogs/dom";
import { BOM_FMT_PRESETS, BOM_PRESETS, ITEM_NO, QTY, bomExport, bomRows, refCmp, type BomField, type BomFmt, type BomPreset, type SymRow } from "../../dialogs/logic";
import * as VM from "../../canvas/variant-model";
import { loadPrefs, savePrefs } from "./plot-out";
import { bitmapButton, checkField, download, grid, h, messageBox, notebook, openDialog, selectField, textEntryBox, textField, type CellValue, type GridApi, type GridColumn } from "./ui";

const isList = Array.isArray;
const K = (): KiCadCanvasApi => KiCadCanvas;
export interface FpField { name: string; value: string; node: SNode; slot: number }
/** The fields of a footprint node: (property "Name" "value" …) and, on older boards, (fp_text reference|value …). */
export function footprintFields(fp: SNode): FpField[] {
  const out: FpField[] = [];
  for (const c of fp) {
    if (!isList(c)) continue;
    if (c[0] === "property" && typeof c[1] === "string" && c.some((x) => isList(x))) out.push({ name: c[1], value: String(c[2] ?? ""), node: c, slot: 2 });
    else if (c[0] === "fp_text" && (c[1] === "reference" || c[1] === "value")) out.push({ name: c[1] === "reference" ? "Reference" : "Value", value: String(c[2] ?? ""), node: c, slot: 2 });
  }
  return out;
}

/** The generated columns the table adds to the footprint fields (FOOTPRINT_FIELDS_EDITOR_GRID_DATA_MODEL). */
const ATTR: Record<string, keyof VM.FpFlags> = { "${DNP}": "dnp", "${EXCLUDE_FROM_BOM}": "exclude_from_bom", "${EXCLUDE_FROM_SIM}": "exclude_from_sim", "${EXCLUDE_FROM_POS_FILES}": "exclude_from_pos_files" };
const ATTR_LABEL: Record<string, string> = { "${DNP}": "DNP", "${EXCLUDE_FROM_BOM}": "Exclude from BOM", "${EXCLUDE_FROM_SIM}": "Exclude from Simulation", "${EXCLUDE_FROM_POS_FILES}": "Exclude from Position Files", [QTY]: "Qty", [ITEM_NO]: "#" };
const MANDATORY = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
const FLAG_OF: Record<keyof VM.FpFlags, keyof SymRow> = { dnp: "dnp", exclude_from_bom: "excludeBom", exclude_from_sim: "excludeSim", exclude_from_pos_files: "excludePos" };

interface Fp { id: string; node: SNode; path: string }
/** A footprint as a fields-table row under `variant` (its variant overrides resolved). */
export function footprintRow(fp: Fp, variant: string): SymRow {
  const values: Record<string, string> = {};
  for (const f of footprintFields(fp.node)) values[f.name] = variant ? VM.footprintFieldForVariant(fp.node, variant, f.name) : f.value;
  values.Footprint = String(fp.node[1] ?? "");
  const fl = VM.footprintFlagsForVariant(fp.node, variant || null);
  return { id: fp.id, ids: [fp.id], ref: values.Reference || "", values, dnp: fl.dnp, excludeBom: fl.exclude_from_bom, excludeBoard: false, excludeSim: fl.exclude_from_sim, excludePos: fl.exclude_from_pos_files, sheet: fp.path, editable: true };
}

/** LoadFieldNames: the mandatory fields, Qty and #, then the user fields in the order the footprints carry them. */
export function defaultFields(fps: SNode[]): BomField[] {
  const F = (name: string, label: string, show: boolean, group_by: boolean): BomField => ({ name, label, show, group_by });
  const out: BomField[] = [F("Reference", "Reference", true, true), F("Value", "Value", true, true), F("Footprint", "Footprint", true, true), F("Datasheet", "Datasheet", true, false), F("Description", "Description", false, false), F(QTY, "Qty", true, false), F(ITEM_NO, "#", true, false)];
  for (const a of Object.keys(ATTR)) out.push(F(a, ATTR_LABEL[a], false, false));
  for (const fp of fps) for (const f of footprintFields(fp)) if (!out.some((x) => x.name === f.name)) out.push(F(f.name, f.name, true, false));
  return out;
}

/** One footprint's staged edits: field values (a new field when absent) and flags, for one variant. */
export interface FpEdit { values: Record<string, string>; flags: Partial<VM.FpFlags>; removed: string[]; renamed: Record<string, string> }
const newField = (name: string, value: string): SNode => K().parse(`(property ${JSON.stringify(name)} ${JSON.stringify(value)} (at 0 0 0) (layer "F.Fab") (hide yes) (uuid ${JSON.stringify(K().newUuid())}) (effects (font (size 1 1) (thickness 0.15))))`) as SNode;
/** The footprint node with `edit` applied: the default variant writes the fields and (attr …) flags, another one its (variant …). */
export function applyFootprintEdit(node: SNode, edit: FpEdit, variant: string): SNode {
  let n = (K().cloneNode as (x: SNode) => SNode)(node);
  for (const [from, to] of Object.entries(edit.renamed)) for (const c of n) if (isList(c) && c[0] === "property" && c[1] === from) c[1] = to;
  if (edit.removed.length) n = n.filter((c) => !(isList(c) && c[0] === "property" && edit.removed.includes(String(c[1])) && !MANDATORY.includes(String(c[1])))) as SNode;
  if (variant) {
    const fields: Record<string, string> = {}; for (const [k, v] of Object.entries(edit.values)) if (k !== "Reference" && k !== "Footprint") fields[k] = v;
    if (Object.keys(fields).length || Object.keys(edit.flags).length) n = VM.setFootprintVariant(n, variant, { flags: edit.flags, fields }) as SNode;
    return n;
  }
  for (const [k, v] of Object.entries(edit.values)) {
    if (k === "Footprint") continue;
    const f = footprintFields(n).find((x) => x.name === k);
    if (f) f.node[f.slot] = v;
    else { let at = n.length; for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && c[0] !== "property" && c[0] !== "layer" && c[0] !== "uuid" && c[0] !== "at" && c[0] !== "descr" && c[0] !== "tags" && c[0] !== "path" && c[0] !== "sheetname" && c[0] !== "sheetfile" && c[0] !== "locked" && c[0] !== "placed" && c[0] !== "attr") { at = i; break; } } n.splice(at, 0, newField(k, v)); }
  }
  const flagKeys = Object.keys(edit.flags) as (keyof VM.FpFlags)[];
  if (flagKeys.length) {
    const a = K().kid(n, "attr") as SNode | null; const toks = a ? a.slice(1).map(String) : [];
    const set = new Set(toks); for (const k of flagKeys) { if (edit.flags[k]) set.add(k); else set.delete(k); }
    const order = ["smd", "through_hole", "board_only", "exclude_from_pos_files", "exclude_from_bom", "allow_missing_courtyard", "dnp", "allow_soldermask_bridges", "exclude_from_sim"];
    const next = [...order.filter((t) => set.has(t)), ...[...set].filter((t) => !order.includes(t))];
    const ai = n.findIndex((c) => isList(c) && c[0] === "attr");
    if (next.length) { const nn = ["attr", ...next] as SNode; if (ai > 0) n[ai] = nn; else { const pi = n.findIndex((c, i) => i > 0 && isList(c) && (c[0] === "fp_line" || c[0] === "fp_text" || c[0] === "fp_rect" || c[0] === "fp_circle" || c[0] === "fp_arc" || c[0] === "fp_poly" || c[0] === "pad" || c[0] === "model")); n.splice(pi > 0 ? pi : n.length, 0, nn); } }
    else if (ai > 0) n.splice(ai, 1);
  }
  return n;
}

interface Cfg { includeDnp: boolean; includeExcluded: boolean; selectOnProbe: boolean; outFile: string; sidebar: boolean }
const CFG_KEY = "kicad.fpFieldsTable";
const CFG0: Cfg = { includeDnp: true, includeExcluded: true, selectOnProbe: false, outFile: "${PROJECTNAME}.csv", sidebar: true };
type Scope = 0 | 1 | 2 | 3;
const SCOPES: [Scope, string][] = [[0, "Entire Project"], [1, "Current Sheet Only"], [2, "Current Sheet and Down"], [3, "Selection"]];
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function openFootprintFields(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("The Footprint Fields Table needs a board"); return; }
  const ro = !!E.viewOnly;
  const cfg = loadPrefs<Cfg>(CFG_KEY, CFG0);
  const fps: Fp[] = Array.from(doc.items.values()).filter((it) => it.kind === "footprint").map((it) => ({ id: it.id, node: it.node, path: String(((K().kid(it.node, "path") as SNode | null) || [])[1] || "") }));
  const selection = new Set<string>(E.selection as Set<string>); if (E.selected) selection.add(E.selected.id);
  const headerVariants = (doc as unknown as { variants?: SNode }).variants || null;
  const variants = VM.boardVariantNamesForUI(headerVariants);
  let variant = String((E as { currentVariant?: string }).currentVariant || "");
  if (variant && !variants.includes(variant)) variant = "";
  // staged edits per variant ("" = default) and footprint
  const edits = new Map<string, Map<string, FpEdit>>();
  const editOf = (id: string): FpEdit => { let m = edits.get(variant); if (!m) { m = new Map(); edits.set(variant, m); } let e = m.get(id); if (!e) { e = { values: {}, flags: {}, removed: [], renamed: {} }; m.set(id, e); } return e; };
  const renamed: Record<string, string> = {}, removed: string[] = [], added: string[] = [];
  let preset: BomPreset = { ...clone(BOM_PRESETS[0]), fields_ordered: defaultFields(fps.map((f) => f.node)), name: BOM_PRESETS[0].name };
  let presetName = BOM_PRESETS[0].name;
  let fmt: BomFmt = clone(BOM_FMT_PRESETS[0]); let fmtName = BOM_FMT_PRESETS[0].name;
  let filterScope = 0, scope: Scope = 0, filter = "";
  let dataGrid: GridApi | null = null, fieldGrid: GridApi | null = null;
  const gridHost = h("div", { class: "ft-gridhost" }), countEl = h("span", { class: "ft-count" });
  const presetSel = h("k-select", { "data-k": "viewPreset" }) as HTMLSelectElement;
  const preview = h("textarea", { class: "ft-preview", readonly: true, "data-k": "preview", spellcheck: false }) as HTMLTextAreaElement;

  /** the rows under the current edits, filtered by scope */
  const symRows = (): SymRow[] => fps.filter((fp) => {
    if (scope === 3) return selection.has(fp.id);
    if (scope === 1) return fp.path.split("/").filter(Boolean).length <= 1;
    return true;
  }).map((fp) => {
    const r = footprintRow(fp, variant); const e = edits.get(variant)?.get(fp.id);
    for (const [from, to] of Object.entries(renamed)) if (from in r.values) { r.values[to] = r.values[from]; delete r.values[from]; }
    for (const f of removed) delete r.values[f];
    if (e) { Object.assign(r.values, e.values); for (const [k, v] of Object.entries(e.flags)) (r as unknown as Record<string, boolean>)[FLAG_OF[k as keyof VM.FpFlags]] = !!v; }
    return r;
  });
  const viewPreset = (): BomPreset => ({ ...preset, exclude_dnp: !cfg.includeDnp, include_excluded_from_bom: cfg.includeExcluded, filter_string: filterScope === 0 ? filter : "" });
  /** FIELDS_EDITOR_GRID_DATA_MODEL::RebuildRows with the Visible / All filter scopes */
  const viewRows = () => {
    const p = viewPreset(); let rows = symRows();
    if (filter && filterScope) {
      const q = filter.toLowerCase(), names = filterScope === 1 ? p.fields_ordered.filter((f) => f.show).map((f) => f.name) : null;
      rows = rows.filter((r) => Object.entries(r.values).some(([k, v]) => (!names || names.includes(k)) && String(v).toLowerCase().includes(q)));
    }
    return bomRows(rows, p);
  };
  const markUnsaved = (): void => { if (presetName !== "(unsaved)") { presetName = "(unsaved)"; syncPresets(); } };
  const syncPresets = (): void => {
    presetSel.replaceChildren(...[...BOM_PRESETS.map((p) => p.name), "(unsaved)"].map((n) => { const o = h("option", { value: n }, n); if (n === presetName) o.selected = true; return o; }));
  };
  const drawData = (): void => {
    const shown = preset.fields_ordered.filter((f) => f.show);
    const g = viewRows();
    const cols: GridColumn[] = shown.map((f) => ({ key: f.name, label: f.label, sort: preset.sort_field === f.name ? (preset.sort_asc ? "asc" : "desc") : undefined,
      type: ATTR[f.name] ? "check" : f.name === "Footprint" || f.name === QTY || f.name === ITEM_NO ? "ro" : "text",
      readOnly: (row: Record<string, CellValue>) => f.name === "Reference" && ((row.__n as number) > 1) }));
    const rows: Record<string, CellValue>[] = g.map((b) => {
      const r: Record<string, CellValue> = { __ids: b.rows.map((x) => x.id).join(","), __n: b.rows.length };
      for (const f of shown) r[f.name] = ATTR[f.name] ? b.rows.every((x) => !!(x as unknown as Record<string, boolean>)[FLAG_OF[ATTR[f.name]]]) : b.cells[f.name] ?? "";
      return r;
    });
    const before = rows.map((r) => ({ ...r }));
    dataGrid = grid(cols, rows, { ro, height: "100%", key: "fieldsGrid",
      onSelect: (i) => { const r = rows[i]; if (!r) return; const ids = String(r.__ids).split(",").filter(Boolean); if (cfg.selectOnProbe) { const T = (window as unknown as { PcbTools?: { applySelection(c: ToolCtx, ids: string[]): void } }).PcbTools; if (T) T.applySelection(ctx, ids); } else ctx.setHighlight(new Set(ids)); ctx.requestRender(); },
      onChange: () => {
        rows.forEach((r, i) => {
          const b = before[i]; const ids = String(r.__ids).split(",").filter(Boolean);
          for (const f of shown) {
            if (r[f.name] === b[f.name]) continue;
            for (const id of ids) { const e = editOf(id); if (ATTR[f.name]) e.flags[ATTR[f.name]] = !!r[f.name]; else e.values[f.name] = String(r[f.name]); }
            b[f.name] = r[f.name];
          }
        });
      } });
    // the column headers sort (OnColSort): a second click reverses
    Array.from(dataGrid.el.querySelectorAll("thead th")).forEach((th, i) => { (th as HTMLElement).style.cursor = "pointer"; th.addEventListener("click", () => { const f = shown[i]; if (preset.sort_field === f.name) preset.sort_asc = !preset.sort_asc; else { preset.sort_field = f.name; preset.sort_asc = true; } markUnsaved(); drawData(); }); });
    // FOOTPRINT_FIELDS_EDITOR_GRID_TRICKS::showPopupMenu: Show Datasheet on a datasheet cell
    dataGrid.el.addEventListener("contextmenu", (ev) => {
      const td = (ev.target as HTMLElement).closest("td"); const tr = td && td.closest("tr"); if (!td || !tr || !tr.parentElement) return;
      const ci = Array.from(tr.children).indexOf(td), ri = Array.from(tr.parentElement.children).indexOf(tr), f = shown[ci], r = rows[ri];
      ev.preventDefault();
      const url = f && f.name === "Datasheet" ? String(r.Datasheet || "") : "";
      popupMenu(ev.clientX, ev.clientY, [{ label: "Show Datasheet", disabled: !/^\w+:\/\/|^www\./.test(url), run: () => { window.open(/^www\./.test(url) ? "https://" + url : url, "_blank", "noopener"); } }]);
    });
    gridHost.replaceChildren(dataGrid.el);
    const n = g.reduce((s, b) => s + b.rows.length, 0);
    countEl.textContent = `${n} footprint${n === 1 ? "" : "s"}${preset.group_symbols ? `, ${g.length} row${g.length === 1 ? "" : "s"}` : ""}`;
  };
  const drawFields = (host: HTMLElement): void => {
    const rows: Record<string, CellValue>[] = preset.fields_ordered.map((f) => ({ name: f.name, label: f.label, show: f.show, group_by: f.group_by }));
    fieldGrid = grid([{ key: "name", label: "Field", type: "ro" }, { key: "label", label: "BOM Name" }, { key: "show", label: "Include", type: "check", width: "56px" }, { key: "group_by", label: "Group By", type: "check", width: "64px", readOnly: (r) => r.name === QTY || r.name === ITEM_NO }],
      rows, { ro, height: "100%", key: "viewControls", onChange: () => { rows.forEach((r, i) => { const f = preset.fields_ordered[i]; f.label = String(r.label); f.show = !!r.show; f.group_by = !!r.group_by; }); markUnsaved(); drawData(); } });
    host.replaceChildren(fieldGrid.el);
  };
  const fieldsHost = h("div", { class: "ft-fields" });
  const selectedField = (): BomField | null => { const i = fieldGrid ? fieldGrid.selected() : -1; return i >= 0 ? preset.fields_ordered[i] : null; };
  const addField = (): void => void textEntryBox("Add Field", "New field name:", "", false, (name) => {
    name = name.trim(); if (!name) return;
    if (preset.fields_ordered.some((f) => f.name === name)) { void messageBox("Add Field", `Field name '${name}' already in use.`); return; }
    preset.fields_ordered.push({ name, label: name, show: true, group_by: false }); added.push(name);
    for (const fp of fps) { const e = editOf(fp.id); if (!(name in e.values)) e.values[name] = ""; }
    markUnsaved(); drawFields(fieldsHost); drawData();
  });
  const renameField = (): void => {
    const f = selectedField(); if (!f) return;
    if (MANDATORY.includes(f.name) || f.name.startsWith("${")) { void messageBox("Rename Field", `The first ${MANDATORY.length} fields are mandatory.`); return; }
    textEntryBox("Rename Field", "New field name:", f.name, false, (name) => {
      name = name.trim(); if (!name || name === f.name) return;
      if (preset.fields_ordered.some((x) => x.name === name)) { void messageBox("Rename Field", `Field name '${name}' already exists.`); return; }
      renamed[f.name] = name; if (f.label === f.name) f.label = name; f.name = name; markUnsaved(); drawFields(fieldsHost); drawData();
    });
  };
  const removeField = (): void => {
    const f = selectedField(); if (!f) return;
    if (MANDATORY.includes(f.name) || f.name.startsWith("${")) { void messageBox("Remove Field", `The first ${MANDATORY.length} fields are mandatory.`); return; }
    messageBox("Remove Field", `Are you sure you want to remove the field '${f.name}'?`, [{ label: "Cancel" }, { label: "OK", fn: () => {
      removed.push(f.name); preset.fields_ordered = preset.fields_ordered.filter((x) => x !== f); markUnsaved(); drawFields(fieldsHost); drawData();
    } }]);
  };
  const collect = (): KChange[] => {
    const out: KChange[] = [];
    for (const fp of fps) {
      let n = fp.node; let any = false;
      if (Object.keys(renamed).length || removed.length) { n = applyFootprintEdit(n, { values: {}, flags: {}, removed, renamed }, ""); any = true; }
      for (const [v, m] of edits) { const e = m.get(fp.id); if (e && (Object.keys(e.values).length || Object.keys(e.flags).length)) { n = applyFootprintEdit(n, { ...e, removed: [], renamed: {} }, v); any = true; } }
      if (!any) continue;
      const it = doc.items.get(fp.id); if (!it || K().serialize(n) === K().serialize(it.node)) continue;
      out.push(K().replaceChange(doc, { ...it, node: n, geom: [], bbox: null }));
    }
    return out;
  };
  const apply = (): boolean => {
    if (ro) return true;
    const changes = collect(); if (!changes.length) return true;
    ctx.commit(changes, "Edit Footprint Fields");
    for (const fp of fps) { const it = doc.items.get(fp.id); if (it) fp.node = it.node; }
    edits.clear(); for (const k of Object.keys(renamed)) delete renamed[k]; removed.length = 0; added.length = 0;
    return true;
  };
  const exportText = (): string => bomExport(symRows(), { ...viewPreset(), filter_string: filter }, fmt);
  const outName = (): string => (cfg.outFile || "${PROJECTNAME}.csv").replace(/\$\{PROJECTNAME\}/g, (document.title.split(" ")[0] || "board").replace(/\.kicad_pcb$/, ""));
  const doExport = (): void => { download(outName().split("/").pop() || "bom.csv", exportText(), "text/csv;charset=utf-8"); };

  // ---- the Export page's fields
  const fieldDelim = textField(fmt.field_delimiter, { key: "fieldDelimiter" }), stringDelim = textField(fmt.string_delimiter, { key: "stringDelimiter" });
  const refDelim = textField(fmt.ref_delimiter, { key: "refDelimiter" }), rangeDelim = textField(fmt.ref_range_delimiter, { key: "refRangeDelimiter" });
  rangeDelim.input.title = "Leave blank to disable ranges.";
  const keepTabs = checkField(fmt.keep_tabs, "Keep tabs", { key: "keepTabs" }), keepBreaks = checkField(fmt.keep_line_breaks, "Keep line breaks", { key: "keepLineBreaks" });
  const bom = checkField(!!fmt.include_bom, "Include byte order mark", { key: "includeBom", tip: "Can increase compatibility with older software that does not import UTF-8 correctly, such as Excel. Can worsen compatibility in some cases." });
  const fmtSel = selectField<string>(fmtName, [...BOM_FMT_PRESETS.map((p): [string, string] => [p.name, p.name]), ["(unsaved)", "(unsaved)"]], { key: "fmtPreset", onChange: (v) => { const p = BOM_FMT_PRESETS.find((x) => x.name === v); if (!p) return; fmt = clone(p); fmtName = v; fieldDelim.set(fmt.field_delimiter); stringDelim.set(fmt.string_delimiter); refDelim.set(fmt.ref_delimiter); rangeDelim.set(fmt.ref_range_delimiter); keepTabs.set(fmt.keep_tabs); keepBreaks.set(fmt.keep_line_breaks); refreshPreview(); } });
  const readFmt = (): void => { fmt = { ...fmt, field_delimiter: fieldDelim.get(), string_delimiter: stringDelim.get(), ref_delimiter: refDelim.get(), ref_range_delimiter: rangeDelim.get(), keep_tabs: keepTabs.get(), keep_line_breaks: keepBreaks.get(), include_bom: bom.get() }; const p = BOM_FMT_PRESETS.find((x) => x.name === fmtName); if (p && (p.field_delimiter !== fmt.field_delimiter || p.string_delimiter !== fmt.string_delimiter || p.ref_delimiter !== fmt.ref_delimiter || p.ref_range_delimiter !== fmt.ref_range_delimiter || p.keep_tabs !== fmt.keep_tabs || p.keep_line_breaks !== fmt.keep_line_breaks)) { fmtName = "(unsaved)"; fmtSel.set("(unsaved)"); } };
  const refreshPreview = (): void => { readFmt(); preview.value = exportText(); };
  for (const f of [fieldDelim, stringDelim, refDelim, rangeDelim, keepTabs, keepBreaks, bom]) f.input.addEventListener("change", refreshPreview);
  const outFile = textField(cfg.outFile, { key: "outputFile" });
  outFile.input.addEventListener("change", () => { cfg.outFile = outFile.get(); savePrefs(CFG_KEY, cfg); });

  const css = `.ft-body { display: flex; gap: 8px; height: 560px; }
.ft-left { width: 400px; flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; min-height: 0; }
.ft-left.collapsed { display: none; }
.ft-fields { flex: 1 1 60%; min-height: 0; display: flex; } .ft-fields > .pd-grid { flex: 1; }
.ft-variants { flex: 1 1 30%; min-height: 60px; overflow: auto; border: 1px solid var(--line); border-radius: 3px; background: var(--panel); }
.ft-variants > div { padding: 2px 6px; cursor: default; } .ft-variants > div.sel { background: var(--accent); color: var(--on-accent); }
.ft-right { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ft-right .pd-notebook, .ft-right .pd-nb { flex: 1; min-height: 0; }
.ft-controls { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; } .ft-controls .vline { width: 1px; align-self: stretch; background: var(--line); }
.ft-gridhost { height: 440px; display: flex; } .ft-gridhost > .pd-grid { flex: 1; }
.ft-count { color: var(--ink-2); margin-left: auto; white-space: nowrap; }
.ft-preview { width: 100%; height: 260px; font-family: var(--mono, monospace); font-size: 12px; resize: none; }
.ft-export { display: grid; grid-template-columns: max-content 80px 24px max-content; gap: 4px 8px; align-items: center; }`;
  const left = h("div", { class: "ft-left" + (cfg.sidebar ? "" : " collapsed") });
  openDialog({ title: "Footprint Fields Table", width: 1240, noEnter: true, readOnly: ro,
    extra: [{ label: "Export", fn: () => { readFmt(); doExport(); } }, ...(ro ? [] : [{ label: "Apply, Save Board & Continue", fn: () => { apply(); drawData(); } }])],
    build(body) {
      body.append(h("style", null, css));
      // ---- left: view controls, presets, variants
      const addB = bitmapButton("small_plus", "Add a new field", addField, { key: "addField", disabled: ro });
      const renB = bitmapButton("small_edit", "Rename selected field", renameField, { key: "renameField", disabled: ro });
      const remB = bitmapButton("small_trash", "Remove selected field", removeField, { key: "removeField", disabled: ro });
      syncPresets();
      presetSel.addEventListener("change", () => {
        const p = BOM_PRESETS.find((x) => x.name === presetSel.value); if (!p) return;
        presetName = p.name;
        const all = defaultFields(fps.map((f) => f.node));
        const fields = p.fields_ordered.filter((f) => !f.name.startsWith("${EXCLUDE_FROM_BOARD")).map((f) => ({ ...f }));
        for (const f of all) if (!fields.some((x) => x.name === f.name)) fields.push({ ...f, show: false, group_by: false });
        preset = { ...clone(p), fields_ordered: fields };
        cfg.includeDnp = !p.exclude_dnp; cfg.includeExcluded = p.include_excluded_from_bom; groupBox.set(p.group_symbols);
        drawFields(fieldsHost); drawData();
      });
      const vlist = h("div", { class: "ft-variants", "data-k": "variants" });
      const drawVariants = (): void => { vlist.replaceChildren(...variants.map((v) => { const sel = (v === VM.DEFAULT_VARIANT_NAME && !variant) || v === variant; const d = h("div", { class: sel ? "sel" : "" }, v); d.addEventListener("click", () => { variant = v === VM.DEFAULT_VARIANT_NAME ? "" : v; drawVariants(); drawData(); }); return d; })); };
      drawVariants(); drawFields(fieldsHost);
      left.append(fieldsHost, h("div", { style: "display:flex;gap:4px" }, addB, renB, h("span", { style: "flex:1" }), remB),
        h("hr", { class: "pd-sep" }), h("div", { style: "display:flex;gap:6px;align-items:center" }, h("label", null, "View presets:"), presetSel),
        h("div", { class: "pd-lbl" }, "Schematic variants:"), vlist);
      // ---- right: Edit / Export
      const search = textField("", { key: "filter", placeholder: "Filter" });
      search.input.setAttribute("type", "search");
      search.input.addEventListener("input", () => { filter = search.get().trim(); drawData(); });
      const fscope = selectField<number>(0, [[0, "References"], [1, "Visible"], [2, "All"]], { key: "filterScope", onChange: (v) => { filterScope = v; drawData(); } });
      const scopeSel = selectField<Scope>(0, SCOPES, { key: "scope", onChange: (v) => { scope = v; drawData(); } });
      const groupBox = checkField(preset.group_symbols, "Group symbols", { key: "groupSymbols", tip: "Group symbols together based on common properties", onChange: (v) => { preset.group_symbols = v; markUnsaved(); drawData(); } });
      const refresh = bitmapButton("small_refresh", "Refresh", () => drawData(), { key: "refresh" });
      const menuB = bitmapButton("config", "", () => {
        const r = menuB.getBoundingClientRect();
        popupMenu(r.left, r.bottom, [
          { label: "Include 'DNP' Footprints", check: true, checked: cfg.includeDnp, run: () => { cfg.includeDnp = !cfg.includeDnp; savePrefs(CFG_KEY, cfg); markUnsaved(); drawData(); } },
          { label: "Include 'Exclude from BOM' Footprints", check: true, checked: cfg.includeExcluded, run: () => { cfg.includeExcluded = !cfg.includeExcluded; savePrefs(CFG_KEY, cfg); markUnsaved(); drawData(); } },
          { sep: true },
          { label: "Highlight on Cross-probe", check: true, checked: !cfg.selectOnProbe, run: () => { cfg.selectOnProbe = false; savePrefs(CFG_KEY, cfg); } },
          { label: "Select on Cross-probe", check: true, checked: cfg.selectOnProbe, run: () => { cfg.selectOnProbe = true; savePrefs(CFG_KEY, cfg); } },
        ]);
      }, { key: "menu" });
      const vline = () => h("span", { class: "vline" });
      const nb = notebook([
        { label: "Edit", build(el) { el.append(h("div", { class: "ft-controls" }, search.el, fscope.el, vline(), scopeSel.el, vline(), groupBox.el, vline(), refresh, menuB), h("div", { style: "text-align:right;margin:-2px 0 2px" }, countEl), gridHost); drawData(); } },
        { label: "Export", build(el) {
          const browse = bitmapButton("small_folder", "Browse", () => { /* the web downloads to the browser's folder */ }, { key: "browse", disabled: true });
          const refreshP = bitmapButton("small_refresh", "Refresh preview", refreshPreview, { key: "refreshPreview" });
          el.append(h("div", { class: "ft-export" },
            h("label", null, "Field delimiter:"), fieldDelim.el, h("span"), keepTabs.el,
            h("label", null, "String delimiter:"), stringDelim.el, h("span"), keepBreaks.el,
            h("label", null, "Reference delimiter:"), refDelim.el, h("span"), bom.el,
            h("label", null, "Range delimiter:"), rangeDelim.el, h("span"), h("span")),
          h("hr", { class: "pd-sep" }),
          h("div", { style: "display:flex;gap:6px;align-items:center;margin:4px 0" }, h("label", null, "Format presets:"), fmtSel.el),
          h("div", { style: "display:flex;gap:6px;align-items:center;margin:4px 0" }, h("label", null, "Output file:"), h("div", { style: "flex:1;display:flex" }, outFile.el), browse),
          h("div", { style: "display:flex;gap:6px;align-items:center;margin:4px 0" }, h("label", null, "Preview:"), h("span", { style: "flex:1" }), refreshP), preview);
          (outFile.input as HTMLInputElement).style.flex = "1";
        } },
      ], { onShow: (i) => { if (i === 1) refreshPreview(); } });
      const sidebar = bitmapButton(cfg.sidebar ? "left" : "right", cfg.sidebar ? "Collapse left panel" : "Expand left panel", () => {
        cfg.sidebar = !cfg.sidebar; savePrefs(CFG_KEY, cfg); left.classList.toggle("collapsed", !cfg.sidebar);
        sidebar.title = cfg.sidebar ? "Collapse left panel" : "Expand left panel"; sidebar.dataset.icon = cfg.sidebar ? "left" : "right";
        sidebar.replaceChildren(); const fresh = bitmapButton(cfg.sidebar ? "left" : "right", "", () => undefined); sidebar.append(...Array.from(fresh.childNodes));
      }, { key: "sidebar" });
      body.append(h("div", { class: "ft-body" }, left, h("div", { class: "ft-right" }, nb.el, h("div", { style: "margin-top:6px" }, sidebar))));
    },
    ok() { apply(); ctx.setHighlight(null); },
    cancel() { ctx.setHighlight(null); } });
}
export { refCmp };
