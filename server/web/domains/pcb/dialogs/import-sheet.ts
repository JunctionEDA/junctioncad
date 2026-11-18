// dialogs/import-sheet.ts — Place > Import Sheet... (SCH_DRAWING_TOOLS::ImportSheet).  KiCad asks for a .kicad_sch with
// its "Choose Schematic" file dialog and the FILEDLG_IMPORT_SHEET_CONTENTS options; here the project's schematics are
// listed (another file can be read from this computer), with the same options:
//   Place as sheet   draw a sheet whose name is the file's and whose file is the chosen schematic (drawSheetFromFile;
//                    the sheet dialog then links the existing file)
//   Place as group   the imported items become one new group named after the file (UniqueGroupName)
//   Keep annotations the symbols keep their references; otherwise they are annotated afresh (AnnotateSymbols with
//                    aResetAnnotation, numbers compared as numbers, in order of position)
// The items ride the cursor like a paste and one click places them ("Import Schematic Sheet Content").
import { E, appState, setTool, toast, toolCtx } from "./editor";
import { KD, checkbox, h } from "./dom";
import { messageBox } from "./sch-items";
import { projectDocs, readDoc } from "./project";
import { relativeSheetPath, sheetBaseName } from "./logic";
import "../../../shared/components/kselect";

interface ImportOpts { asSheet: boolean; asGroup: boolean; keepAnnotations: boolean }
const KEY = "kui.importSheet";
function loadOpts(): ImportOpts {
  // APP_SETTINGS design_block_chooser.*: place_as_sheet false, place_as_group true, keep_annotations false
  const d: ImportOpts = { asSheet: false, asGroup: true, keepAnnotations: false };
  try { const v = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<ImportOpts>; return { asSheet: v.asSheet ?? d.asSheet, asGroup: v.asGroup ?? d.asGroup, keepAnnotations: v.keepAnnotations ?? d.keepAnnotations }; } catch { return d; }
}
function saveOpts(o: ImportOpts): void { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* private window */ } }

interface SchModule { state: Record<string, unknown>; clipboardText(doc: KDoc, items: KItem[], opts?: { wrap?: boolean }): string; _: { pasteText(ctx: unknown, text: string, opts?: Record<string, unknown>): boolean } }
const sch = (): SchModule | null => ((window as unknown as { CollabTools?: { sch?: SchModule } }).CollabTools?.sch) || null;

export function openImportSheet(): void {
  if (!E.kdoc || E.kdoc.type !== "sch") return;
  if (E.viewOnly) { toast("View-only access"); return; }
  const here = appState.docId || "";
  const files = projectDocs().filter((d) => d.docType === "kicad_sch" && d.docId !== here).sort((a, b) => a.path.localeCompare(b.path));
  const curPath = (projectDocs().find((d) => d.docId === here) || { path: "" }).path;
  const opts = loadOpts();
  let local: { name: string; text: string } | null = null;
  let list: HTMLSelectElement, sheetCb: HTMLInputElement, localNote: HTMLElement;
  KD().open({
    title: "Choose Schematic", width: 520, geomKey: "IMPORT_SHEET",
    build(body) {
      list = h("k-select", { id: "kd-imp-files", size: 10, style: "width:100%" }) as HTMLSelectElement;
      for (const d of files) list.append(h("option", { value: d.docId }, d.path));
      if (files.length) list.selectedIndex = 0;
      list.addEventListener("change", () => { local = null; localNote.textContent = ""; sheetCb.disabled = false; });
      const browse = h("button", { class: "btn", type: "button", id: "kd-imp-browse" }, "From File...");
      browse.addEventListener("click", () => {
        const i = h("input", { type: "file", accept: ".kicad_sch", style: "display:none" }) as HTMLInputElement;
        i.addEventListener("change", () => { const f = i.files && i.files[0]; i.remove(); if (!f) return;
          void f.text().then((text) => { local = { name: f.name, text }; localNote.textContent = f.name; list.selectedIndex = -1;
            // a file from this computer is not in the project: only its contents can be imported
            sheetCb.checked = false; opts.asSheet = false; sheetCb.disabled = true; }); });
        document.body.append(i); i.click();
      });
      localNote = h("span", { id: "kd-imp-local", style: "color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" });
      const cb = (label: string, k: keyof ImportOpts, id: string): HTMLLabelElement => checkbox(label, opts[k], (on) => { opts[k] = on; }, { id }) as HTMLLabelElement;
      const asSheet = cb("Place as sheet", "asSheet", "kd-imp-sheet"); sheetCb = asSheet.querySelector("input") as HTMLInputElement;
      body.append(h("label", { style: "display:block;color:var(--ink-2);margin-bottom:4px" }, files.length ? "Project schematics:" : "The project has no other schematic."), list,
        h("div", { class: "kd-row", style: "margin:8px 0;gap:8px" }, browse, localNote),
        h("div", { style: "display:flex;gap:18px;flex-wrap:wrap;margin-top:6px" }, cb("Place as group", "asGroup", "kd-imp-group"), asSheet, cb("Keep annotations", "keepAnnotations", "kd-imp-keep")));
    },
    ok() {
      const docId = list.value;
      if (!local && !docId) { void messageBox("Choose a schematic to import."); return false; }
      saveOpts(opts);
      const entry = files.find((d) => d.docId === docId);
      void run(entry ? { docId: entry.docId, path: entry.path } : null, local, opts, curPath);
    },
  });
}

async function run(entry: { docId: string; path: string } | null, local: { name: string; text: string } | null, opts: ImportOpts, curPath: string): Promise<void> {
  const m = sch(); if (!m) return;
  if (entry && opts.asSheet) {
    // SCH_ACTIONS::drawSheetFromFile: the sheet tool, its next sheet named after the file and pointing at it
    m.state.sheetPreset = { name: sheetBaseName(entry.path), file: relativeSheetPath(curPath, entry.path), armed: true };
    setTool("sheet");
    return;
  }
  let text: string;
  if (local) text = local.text;
  else if (entry) {
    try { const d = await readDoc(entry.docId, "kicad_sch"); text = m.clipboardText(d, Array.from(d.items.values())); }
    catch (e) { await messageBox(`Could not read ${entry.path}: ${(e as Error).message}`); return; }
  } else return;
  const base = sheetBaseName(local ? local.name : entry!.path);
  if (E.tool !== "select") setTool("select");
  const ok = m._.pasteText(toolCtx(), text, { label: "Import Schematic Sheet Content", pasteMode: opts.keepAnnotations ? "keep" : "reset", ...(opts.asGroup ? { group: base } : {}) });
  if (!ok) await messageBox("The schematic has no items to import.");
}
