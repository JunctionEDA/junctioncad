// pcbdialogs/ipc2581 — File > Fabrication Outputs > IPC-2581 File... (DIALOG_EXPORT_2581 over
// pcbnew/dialogs/dialog_export_2581_base.cpp, with PANEL_FAB_EXPORT_CONTENT, DIALOG_FAB_CUSTOMIZE and
// DIALOG_EXPORT_2581_BOM).  File: with the browse button; File Format: Units, Precision (4-10), Version (B / C),
// Compress output; Content: Data set, Net names, Variant, Reference designators, the "Includes:" summary with
// Customize... and BOM Fields...; the messages panel; Export / Close.  The file itself is web/domains/pcb/fab/ipc2581.ts.
// A browser saves into its download folder: the browse button is shown and disabled.
import type { KiCadFabApi } from "../../fab/index";
import { E } from "../state";
import { toolCtx } from "../tools";
import { fabContext, loadFab } from "../fab-outputs";
import * as VM from "../../canvas/variant-model";
import { loadPrefs, saveBlob, savePrefs } from "./plot-out";
import { bitmapButton, checkField, grid, h, openDialog, reportPanel, selectField, spinField, subDialog, textField, type CellValue, type ReportLine } from "./ui";

/** PANEL_FAB_EXPORT_CONTENT sectionRows: the label of each section and its IPC-2581 elements */
export const SECTION_ROWS: [string, string, string][] = [
  ["B", "BOM", "Bom, Avl"], ["C", "footprints", "Package"], ["A", "components", "Component"], ["K", "padstacks", "PadStackDef"],
  ["S", "stackup", "Stackup, Spec"], ["U", "board profile", "Profile"], ["M", "solder mask", "SOLDERMASK"], ["P", "solder paste", "SOLDERPASTE"],
  ["L", "silkscreen", "SILKSCREEN"], ["R", "drill and router", "DRILL, ROUT"], ["D", "documentation", "DOCUMENT"], ["O", "outer copper", "CONDUCTOR, SIGNAL"],
  ["I", "inner copper", "SIGNAL, PLANE, MIXED"], ["E", "dielectric", "DIELCORE, DIELPREG"], ["F", "misc fab layers", "Layer (other functions)"],
  ["G", "logical netlist", "LogicalNet"], ["Y", "physical netlist", "PhyNetGroup"],
];
const DATA_SETS: [string, string][] = [["USERDEF", "All data (user-defined)"], ["BOM", "Bill of materials"], ["STACKUP", "Stackup"], ["FABRICATION", "Fabrication"], ["ASSEMBLY", "Assembly"], ["TEST", "Test"], ["STENCIL", "Stencil"]];
type Mode = "USERDEF" | "BOM" | "STACKUP" | "FABRICATION" | "ASSEMBLY" | "TEST" | "STENCIL";

interface Prefs { inch: boolean; precision: number; rev: "B" | "C"; compress: boolean; mode: Mode; sections: string | null; anonymize: boolean; omitRefDes: boolean; id: string; mpn: string; mfg: string; distPn: string; dist: string; bomRev: string }
const KEY = "kicad.ipc2581";
const DEFAULTS: Prefs = { inch: false, precision: 6, rev: "C", compress: false, mode: "USERDEF", sections: null, anonymize: false, omitRefDes: false, id: "", mpn: "", mfg: "", distPn: "", dist: "N/A", bomRev: "" };

/** The "Includes: …" summary of PANEL_FAB_EXPORT_CONTENT::updateSummary, wrapped at 60 characters. */
export function includesSummary(sections: Set<string>): string {
  let s = "Includes: ";
  for (const [k, label] of SECTION_ROWS) {
    if (!sections.has(k)) continue;
    if (s !== "Includes: ") s += ", ";
    if (s.slice(s.lastIndexOf("\n") + 1).length + label.length > 60) s += "\n";
    s += label;
  }
  return s;
}

/** DIALOG_EXPORT_2581 — BOARD_EDITOR_CONTROL::GenerateIPC2581File. */
export async function openIpc2581(): Promise<void> {
  const ctx = toolCtx() as ToolCtx;
  if (!E.kdoc || E.kdoc.type !== "pcb") { ctx.toast("An IPC-2581 file is made from a board: open the PCB editor first"); return; }
  let fab: KiCadFabApi;
  try { fab = await loadFab(); } catch (e) { console.warn(e); ctx.toast("The IPC-2581 writer could not be loaded"); return; }
  const first = await fabContext(); if (!first) return;
  const S = fab.ipc2581Sections;
  const board = first.projectName || "board";
  const pref = loadPrefs<Prefs>(KEY, DEFAULTS);
  // field names of the board's footprints for the BOM Fields choices
  const fieldNames: string[] = [];
  for (const it of first.doc.items.values()) if (it.kind === "footprint") for (const c of it.node) if (Array.isArray(c) && c[0] === "property" && typeof c[1] === "string" && !["Reference", "Value", "Footprint", "Datasheet", "Description"].includes(c[1]) && !fieldNames.includes(c[1])) fieldNames.push(c[1]);
  fieldNames.sort((a, b) => a.localeCompare(b));
  const headerVariants = (E.kdoc as unknown as { variants?: SNode }).variants || null;
  const variants = VM.boardVariantNamesForUI(headerVariants).filter((v) => v !== VM.DEFAULT_VARIANT_NAME);
  const current = String((E as { currentVariant?: string }).currentVariant || "") || VM.DEFAULT_VARIANT_NAME;

  const out = textField(`${board}.${pref.compress ? "zip" : "xml"}`, { key: "outputFile" });
  const browse = bitmapButton("small_folder", "Browse", () => undefined, { key: "browse", disabled: true });
  const units = selectField<number>(pref.inch ? 1 : 0, [[0, "Millimeters"], [1, "Inches"]], { key: "units" });
  const precision = spinField(pref.precision, { min: 4, max: 10, key: "precision" });
  precision.input.title = "The number of values following the decimal separator";
  const version = selectField<string>(pref.rev, [["B", "B"], ["C", "C"]], { key: "version", onChange: () => summary() });
  const compress = checkField(pref.compress, "Compress output", { key: "compress", tip: "Compress output into 'zip' file", onChange: (v) => out.set(out.get().replace(/\.(xml|zip)$/i, "") + (v ? ".zip" : ".xml")) });   // onCompressCheck
  let sections: string | null = pref.sections;
  const dataSet = selectField<string>(pref.mode, DATA_SETS, { key: "dataSet", onChange: () => { sections = null; summary(); } });
  dataSet.input.title = "Which sections of the design the file carries, per the IPC-2581 function mode table";
  const netNames = selectField<number>(pref.anonymize ? 1 : 0, [[0, "Include"], [1, "Anonymize"]], { key: "netNames" });
  netNames.input.title = "Anonymized names keep connectivity for netlist compare without carrying the design intent";
  const variant = selectField<string>("", [["", `Current (${current})`], ...variants.map((v): [string, string] => [v, v])], { key: "variant", ro: !variants.length });
  variant.input.title = "Select a board variant for this export";
  const refDes = selectField<number>(pref.omitRefDes ? 1 : 0, [[0, "Include"], [1, "Omit"]], { key: "refDes" });
  refDes.input.title = "Omits the designator from the component, BOM and artwork metadata. Reference text drawn on silkscreen is artwork the fabricator must reproduce and is always kept.";
  const includes = h("div", { class: "pd-lbl", "data-k": "includes", style: "white-space:pre-line" });
  const bomBtn = h("button", { type: "button", class: "btn", "data-k": "bomFields" }, "BOM Fields...");
  const custBtn = h("button", { type: "button", class: "btn", "data-k": "customize" }, "Customize...");
  const bomFields = { id: pref.id, mpn: pref.mpn, mfg: pref.mfg, distPn: pref.distPn, dist: pref.dist, bomRev: pref.bomRev || (first.doc.titleBlock && first.doc.titleBlock.rev) || "" };
  const report = reportPanel("150px", { empty: "", fileName: `${board}-ipc2581-report.txt` });

  const mode = (): Mode => dataSet.get() as Mode;
  const requested = (): Set<string> => (sections !== null ? new Set(sections) : S.recommended(mode()));
  /** ResolvedSections */
  const resolved = (): Set<string> => S.resolve("C", mode(), requested()).included;
  function summary(): void {
    const r = resolved(); includes.textContent = includesSummary(r);
    (bomBtn as HTMLButtonElement).disabled = !r.has("B");
  }
  custBtn.addEventListener("click", () => {
    // DIALOG_FAB_CUSTOMIZE: a preset allows changes only to its optional sections
    const opt = S.optional(mode()), cur = resolved();
    const rows: Record<string, CellValue>[] = SECTION_ROWS.map(([k, label, ipc]) => ({ key: k, on: cur.has(k), label, ipc, edit: opt.has(k) }));
    subDialog("Customize IPC-2581 Content", 520, (body) => {
      body.append(h("p", null, "Choose the optional sections to include:"),
        grid([{ key: "on", label: "", type: "check", width: "36px", readOnly: (r) => !r.edit }, { key: "label", label: "Section", type: "ro" }, { key: "ipc", label: "IPC-2581", type: "ro" }], rows, { height: "380px", key: "sections" }).el);
    }, () => { sections = rows.filter((r) => r.on).map((r) => String(r.key)).join(""); summary(); }, { key: "customizeDlg" });
  });
  bomBtn.addEventListener("click", () => {
    // DIALOG_EXPORT_2581_BOM
    const cols = (first0: string): [string, string][] => [["", first0], ...fieldNames.map((f): [string, string] => [f, f])];
    const rev = textField(bomFields.bomRev, { key: "bomRev" }); rev.input.title = "Revision string for the BOM section. Auto-populated from schematic title block revision";
    const id = selectField<string>(bomFields.id, cols("Generate unique"), { key: "oemRef" }); id.input.title = "Part ID number used internally during design.\nThis number must be unique to each part.";
    const mpn = selectField<string>(bomFields.mpn, cols("Omit"), { key: "mpn" }); mpn.input.title = "Column containing the manufacturer part number";
    const mfg = selectField<string>(bomFields.mfg, cols("N/A"), { key: "mfg" });
    const dpn = selectField<string>(bomFields.distPn, cols("Omit"), { key: "distPn" }); dpn.input.title = "Column containing the distributor part number";
    const dist = textField(bomFields.dist, { key: "distributor" });
    const lbl = (t: string, tip?: string): HTMLElement => h("span", { class: "pd-lbl", title: tip || "" }, t);
    subDialog("IPC-2581 BOM Fields", 420, (body) => {
      body.append(h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:5px 8px;align-items:center" },
        lbl("BOM revision:", rev.input.title), rev.el, lbl("Internal ID:", id.input.title), id.el, lbl("Manufacturer P/N:", mpn.input.title), mpn.el, lbl("Manufacturer:"), mfg.el, lbl("Distributor P/N:", dpn.input.title), dpn.el, lbl("Distributor:"), dist.el));
    }, () => { Object.assign(bomFields, { bomRev: rev.get(), id: id.get(), mpn: mpn.get(), mfg: mfg.get(), distPn: dpn.get(), dist: dist.get() }); }, { key: "bomDlg" });
  });

  const read = (): Prefs => ({ inch: units.get() === 1, precision: precision.get(), rev: version.get() as "B" | "C", compress: compress.get(), mode: mode(), sections, anonymize: netNames.get() === 1, omitRefDes: refDes.get() === 1, ...bomFields });
  async function run(): Promise<void> {
    const p = read(); savePrefs(KEY, p);   // saveToProject
    const lines: ReportLine[] = [];
    const name = (out.get().trim().replace(/\\/g, "/").split("/").pop() || "").trim();
    if (!name) { report.set([{ severity: "error", text: "The board must be saved before generating IPC-2581 file." }]); return; }
    const fctx = await fabContext(); if (!fctx) return;
    if (variant.get()) fctx.variant = variant.get();
    let r: ReturnType<KiCadFabApi["ipc2581"]>;
    try {
      r = fab.ipc2581(fctx, { rev: p.rev, inch: p.inch, precision: p.precision, mode: p.mode, sections: requested(), anonymizeNets: p.anonymize, omitRefDes: p.omitRefDes,
        internalId: p.id, mpn: p.mpn, mfg: p.mfg, distPn: p.distPn, dist: p.dist, bomRev: p.bomRev });
    } catch (e) { console.warn(e); report.set([{ severity: "error", text: `Error generating IPC-2581 file '${name}'.\n${e instanceof Error ? e.message : String(e)}` }]); return; }
    for (const w of r.warnings) lines.push({ severity: "warning", text: w });
    for (const e of r.errors) lines.push({ severity: "error", text: e });
    if (!r.xml) { report.set(lines); return; }
    if (p.compress) { const base = name.replace(/\.(zip|xml)$/i, ""); saveBlob(await fab.zip([{ name: base + ".xml", data: r.xml }]), base + ".zip"); }
    else saveBlob(r.xml, /\.xml$/i.test(name) ? name : name + ".xml");
    lines.push({ severity: "action", text: "IPC-2581 file generated successfully." });
    report.set(lines);
  }

  const lbl = (t: string, tip?: string): HTMLElement => h("span", { class: "pd-lbl", title: tip || "" }, t);
  openDialog({ title: "Export IPC-2581", width: 720, okLabel: "Export", cancelLabel: "Close",
    build(body) {
      out.el.style.flex = "1";
      body.append(
        h("div", { class: "pd-row", style: "margin-bottom:10px;display:flex;gap:6px;align-items:center" }, lbl("File:"), out.el, browse),
        h("div", { style: "display:flex;gap:20px" },
          h("div", { style: "flex:2" }, h("div", { class: "pd-hd" }, "File Format"), h("hr", { class: "pd-sep" }),
            h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:5px 8px;align-items:center" },
              lbl("Units:"), units.el, lbl("Precision:", "The number of values following the decimal separator"), precision.el, lbl("Version:"), version.el), h("div", { style: "margin-top:5px" }, compress.el)),
          h("div", { style: "flex:3" }, h("div", { class: "pd-hd" }, "Content"), h("hr", { class: "pd-sep" }),
            h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:5px 8px;align-items:center" },
              lbl("Data set:"), dataSet.el, lbl("Net names:"), netNames.el, lbl("Variant:"), variant.el, lbl("Reference designators:"), refDes.el),
            h("div", { style: "margin-top:6px" }, includes), h("div", { style: "display:flex;gap:6px;margin-top:4px" }, custBtn, bomBtn))),
        h("div", { style: "margin-top:10px" }, report.el));
      summary();
    },
    ok() { void run(); return false; },
    cancel() { savePrefs(KEY, read()); } });
}
