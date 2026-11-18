// pcbdialogs/find-by-props — Edit > Find by Properties... (DIALOG_FIND_BY_PROPERTIES, pcbnew/dialogs/
// dialog_find_by_properties_base.cpp and dialog_find_by_properties.cpp), a modeless dialog of two pages:
//   From Selection  the properties the selected items share (the Properties panel's rows), each with a Match choice
//                   (Ignored / Matching / Different); Select Matching selects every item of the selected items' types
//                   whose values agree with the rows that are not ignored (mixed rows sit out)
//   Query           a DRC-language expression over A (the rule conditions' evaluator, as PCBEXPR_COMPILER is there),
//                   with the ten most recent queries, Check Syntax and Create from Selection Tab (the rows written as
//                   A.<Property> == / != <value> joined with &&)
// Deselect non-matching items clears the selection first; Zoom to fit selected items frames the result.  The recent
// queries are kept per project in this browser (KiCad keeps them in the project file, which this does not change).
import { E } from "../state";
import { selectionChanged, selectionIds, toolCtx } from "../gestures";
import { itemPropText, propGrid, selectedItems, selectionSignature } from "../panels/propgrid";
import { kicadActionAvailable, runKicadAction } from "../hotkeys";
import { checkField, grid, h, messageBox, notebook, openDialog, selectField, type CellValue } from "./ui";

type Mode = "ignored" | "matching" | "different";
interface Row { id: string; name: string; value: string; mixed: boolean; mode: Mode }
interface Tools { applySelection?(ctx: ToolCtx, ids: string[]): void; parseDru(t: string): { rules: { name: string }[]; errors: string[] }; ruleMatchingItems(d: KDoc, s: unknown, t: string, n: string): string[] | null; designSettings(p: unknown): unknown }
const PT = (): Tools => (window as unknown as { PcbTools: Tools }).PcbTools;

/** propNameToExprField: spaces become underscores; Net compares by NetName */
export function propNameToExprField(name: string): string {
  const r = name.replace(/ /g, "_");
  return r.toLowerCase() === "net" ? "NetName" : r;
}
/** formatValueForExpression for the grid's text: yes/no as true/false, numbers bare, the rest quoted */
export function exprValue(type: string, text: string): string {
  if (type === "bool") return text === "1" || text === "true" ? "true" : "false";
  if (!text) return "";
  if (type === "length" || type === "coord" || type === "number" || type === "int" || type === "angle") {
    const t = text.replace(/°/g, "").trim();
    if (/^-?[\d.]+(\s*(mm|mil|in|deg))?$/.test(t)) return t.replace(/\s+/g, "");
  }
  return `'${text.replace(/'/g, "\\'")}'`;
}
/** generateExpressionFromProperties */
export function expressionFromRows(rows: { name: string; type: string; value: string; mixed: boolean; mode: Mode }[]): { expr: string; skipped: string[] } {
  const conds: string[] = [], skipped: string[] = [];
  for (const r of rows) {
    if (r.mode === "ignored" || r.mixed) continue;
    const v = exprValue(r.type, r.value);
    if (!v) { skipped.push(r.name); continue; }
    conds.push(`A.${propNameToExprField(r.name)} ${r.mode === "matching" ? "==" : "!="} ${v}`);
  }
  return { expr: conds.join(" && "), skipped };
}
/** normalizeQueryFieldAliases: A.<Field_Name> of a footprint field (Value, Datasheet, Description and the selection's
 *  own fields) becomes A.getField('<Field Name>') outside quoted strings, the longest names first */
export function normalizeQueryFieldAliases(expr: string, fieldNames: Iterable<string>): string {
  const names = new Set(["Value", "Datasheet", "Description", ...fieldNames]);
  const aliases = [...names].map((f) => ({ from: "A." + f.replace(/ /g, "_"), to: `A.getField('${f.replace(/'/g, "\\'")}')` })).sort((a, b) => b.from.length - a.from.length);
  const ident = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_]/u.test(c);
  let out = "", inString = false;
  for (let i = 0; i < expr.length;) {
    const ch = expr[i];
    if (ch === "'" && (i === 0 || expr[i - 1] !== "\\")) { inString = !inString; out += ch; i++; continue; }
    if (!inString) {
      const a = aliases.find((x) => expr.startsWith(x.from, i) && !ident(expr[i - 1]) && !ident(expr[i + x.from.length]));
      if (a) { out += a.to; i += a.from.length; continue; }
    }
    out += ch; i++;
  }
  return out;
}
/** queryUsesUnsupportedPairwiseSyntax */
export const usesB = (expr: string): boolean => /(^|[^\w.])B\./.test(expr);
/** The expression as a one-rule custom rules text, for the rules engine to compile and match. */
const ruleOf = (expr: string): string => `(version 1)\n(rule "find_by_properties"\n  (condition "${expr.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"))`;

const recentKey = (): string => "kicad.findByProperties." + String((E as { projectId?: string }).projectId || "");
function loadRecent(): string[] { try { const v = JSON.parse(localStorage.getItem(recentKey()) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 10) : []; } catch (e) { return []; } }
function saveRecent(list: string[]): void { try { localStorage.setItem(recentKey(), JSON.stringify(list.slice(0, 10))); } catch (e) { /* private window */ } }

let open = false;
const savedModes = new Map<string, Mode>();
const MODES: [string, string][] = [["ignored", "Ignored"], ["matching", "Matching"], ["different", "Different"]];

/** PCB_EDIT_FRAME's Find by Properties dialog (modeless; a second call brings the open one back). */
export function openFindByProperties(ctx: ToolCtx): void {
  if (!E.kdoc || E.kdoc.type !== "pcb") return;
  if (open) { const d = Array.from(document.querySelectorAll<HTMLElement>(".kd-dialog")).find((x) => x.querySelector("[data-k=findByProps]")); if (d) { d.style.display = ""; return; } }
  open = true;
  let rows: (Row & { type: string })[] = [], types = new Set<string>(), sig = "", fieldNames: string[] = [];
  const status = h("div", { class: "pd-lbl", "data-k": "selStatus" }, "No items selected");
  const g = grid([{ label: "Property", key: "name", type: "ro" }, { label: "Value", key: "value", type: "ro" }, { label: "Match", key: "mode", type: "select", options: MODES, width: "110px" }], [], { height: "260px", key: "propGrid",
    onChange: () => { for (const r of g.rows()) { const row = rows.find((x) => x.id === r.id); if (row) { row.mode = r.mode as Mode; if (row.mode === "ignored") savedModes.delete(row.name); else savedModes.set(row.name, row.mode); } } } });
  const createBtn = h("button", { type: "button", class: "btn", "data-k": "createQuery" }, "Create from Selection Tab");
  /** rebuildPropertyGrid: the shared rows of the selection, keeping the match modes set before */
  const rebuild = (): void => {
    sig = selectionSignature();
    const items = selectedItems(); types = new Set(items.map((it) => it.kind));
    if (!items.length) { rows = []; fieldNames = []; status.textContent = "No items selected"; (createBtn as HTMLButtonElement).disabled = true; g.setRows([]); return; }
    const pg = propGrid();
    status.textContent = items.length === 1 ? pg.title : `${items.length} objects selected`;
    rows = [];
    // getQueryableFootprintFieldNames: the footprint fields that are not a property of their own
    fieldNames = pg.groups.filter((grp) => grp.name === "Fields").flatMap((grp) => grp.rows.map((r) => r.name)).filter((n) => n !== "Reference" && n !== "Footprint");
    for (const grp of pg.groups) for (const r of grp.rows) if (!rows.some((x) => x.name === r.name)) rows.push({ id: r.id, name: r.name, type: r.type, value: r.mixed ? "" : String(r.value), mixed: !!r.mixed, mode: savedModes.get(r.name) || "ignored" });
    rows.sort((a, b) => a.name.localeCompare(b.name));
    (createBtn as HTMLButtonElement).disabled = false;
    g.setRows(rows.map((r): Record<string, CellValue> => ({ id: r.id, name: r.name, value: r.mixed ? "<...>" : r.value, mode: r.mode })));
  };
  /** loadRecentQueries: the Recently Used choice, rebuilt after each saved query */
  const recentHost = h("div", { "data-k": "recentHost" });
  const loadRecentQueries = (selected = ""): void => {
    const f = selectField<string>(selected, [["", ""], ...loadRecent().map((q): [string, string] => [q, q])], { key: "recent", onChange: (v) => { if (v) query.value = v; } });
    recentHost.replaceChildren(f.el);
  };
  const query = h("textarea", { class: "pd-mono", "data-k": "query", rows: "6", spellcheck: "false", style: "width:100%;font-family:var(--mono, monospace)" }) as HTMLTextAreaElement;
  const qStatus = h("div", { class: "pd-lbl", "data-k": "queryStatus" });
  const checkBtn = h("button", { type: "button", class: "btn", "data-k": "checkSyntax" }, "Check Syntax");
  const deselect = checkField(true, "Deselect non-matching items", { key: "deselect" });
  const zoom = checkField(false, "Zoom to fit selected items", { key: "zoomFit" });
  let page = 0;
  const normalized = (expr: string): string => normalizeQueryFieldAliases(expr, fieldNames);
  const syntaxErrors = (expr: string): string[] => PT().parseDru(ruleOf(normalized(expr))).errors.map((e) => e.replace(/^rule 'find_by_properties': /, ""));
  checkBtn.addEventListener("click", () => {   // onCheckSyntaxClick
    const expr = query.value.trim();
    if (!expr) { qStatus.textContent = "Expression is empty"; return; }
    if (usesB(normalized(expr))) { qStatus.textContent = "B. expressions are not supported."; return; }
    const errs = syntaxErrors(expr);
    qStatus.textContent = errs.length ? "Syntax error: " + errs.join("\n") : "Syntax OK";
  });
  createBtn.addEventListener("click", () => {   // onCreateQueryClick
    const { expr, skipped } = expressionFromRows(rows);
    if (!expr && !skipped.length) return;
    query.value = expr; book.show(1);
    qStatus.textContent = !skipped.length ? "" : skipped.length === 1 ? `No value to match: ${skipped[0]}` : `${skipped.length} rows have no value to match`;
  });
  /** applyMatchResults */
  const apply = (ids: string[], label: HTMLElement): void => {
    const tctx = toolCtx() as ToolCtx;
    const next = deselect.get() ? ids : Array.from(new Set([...selectionIds(), ...ids]));
    if (PT().applySelection) PT().applySelection!(tctx, next);
    selectionChanged();
    if (zoom.get() && ids.length && kicadActionAvailable("zoomFitSelection")) runKicadAction("zoomFitSelection");
    label.textContent = `${ids.length} items matched`;
    sig = selectionSignature();
  };
  const selectMatching = (): void => {
    const doc = E.kdoc as KDoc;
    if (page === 0) {   // selectMatchingFromProperties
      const crit = rows.filter((r) => r.mode !== "ignored" && !r.mixed);
      const ids: string[] = [];
      for (const it of doc.items.values()) {
        if (!types.has(it.kind)) continue;
        let ok = true;
        for (const r of crit) { const v = itemPropText(it, r.id); if (v === undefined) { ok = false; break; } if ((v === r.value) !== (r.mode === "matching")) { ok = false; break; } }
        if (ok) ids.push(it.id);
      }
      apply(ids, status);
    } else {   // selectMatchingFromQuery
      const expr = query.value.trim(); if (!expr) return;
      if (usesB(normalized(expr))) { qStatus.textContent = "B. expressions are not supported."; messageBox("Expression Error", "B. expressions are not supported."); return; }
      const errs = syntaxErrors(expr);
      if (errs.length) { qStatus.textContent = "Syntax error in expression"; messageBox("Expression Error", errs.join("\n")); return; }
      // saveRecentQuery: to the front, no duplicate, ten at most; then loadRecentQueries and SetSelection( 0 )
      const list = [expr, ...loadRecent().filter((q) => q !== expr)].slice(0, 10); saveRecent(list); loadRecentQueries(expr);
      const P = PT(); const ids = P.ruleMatchingItems(doc, P.designSettings((E as { proSettings?: unknown }).proSettings || null), ruleOf(normalized(expr)), "find_by_properties") || [];
      apply(ids, qStatus);
    }
  };
  loadRecentQueries();
  const book = notebook([
    { label: "From Selection", build: (el) => { el.append(status, g.el); } },
    { label: "Query", build: (el) => { el.append(h("div", { class: "pd-lbl" }, "Recently Used"), recentHost, h("div", { class: "pd-lbl", style: "margin-top:6px" }, "Expression"), query, h("div", { class: "pd-row", style: "margin-top:6px;gap:6px" }, checkBtn, createBtn), qStatus); } },
  ], { onShow: (i) => { page = i; if (i === 0) rebuild(); } });
  // the selection moving under the open dialog (OnSelectionChanged)
  const timer = window.setInterval(() => { if (!document.body.contains(book.el)) { window.clearInterval(timer); open = false; return; } if (page === 0 && selectionSignature() !== sig) rebuild(); }, 400);
  openDialog({ title: "Find by Properties", width: 560, modeless: true, okLabel: "Select Matching", cancelLabel: "Close",
    build(body) { body.append(h("div", { "data-k": "findByProps" }), book.el, h("div", { style: "display:flex;flex-direction:column;gap:4px;margin-top:8px" }, deselect.el, zoom.el)); rebuild(); },
    ok() { selectMatching(); return false; },
    cancel() { window.clearInterval(timer); open = false; } });
  void ctx;
}
