// dialogs/edit-libid.ts — Tools > Bulk Edit Symbol Library Links... (eeschema/dialogs/dialog_edit_symbols_libid.cpp,
// DIALOG_EDIT_SYMBOLS_LIBID): every symbol of the hierarchy grouped by library identifier (Symbols / Current Library
// Reference / New Library Reference, the orphans — whose library symbol is not in the sheet's cache — in bold
// italics), a browse button per row (the symbol chooser), "Map Orphans" (the first library holding a symbol of the
// same name; a choice when several do), and "Update symbol fields from new library".  OK relinks each symbol of a
// changed row: SetLibId, the new flattened library symbol embedded, a Value that named the old symbol renamed, and,
// with the checkbox, UpdateFields( reset other fields ).
import { bitmapButton } from "../../../shared/components/kicon-dom";
import { E, pushUndoFor, toolCtx } from "./editor";
import { KD, checkbox, h } from "./dom";
import { messageBox } from "./sch-items";
import { projectDocs, submitDocOp } from "./project";
import * as L from "./change-symbols-logic";
import { allSheets, libCache, libSymbol, type Sheet } from "./change-symbols";
import { officialIndex, officialLibraries } from "../library/sources";

interface LibApi { openChooser(kind: "symbol", opts?: { title?: string; filter?: string; browser?: boolean }): Promise<{ libId?: string } | null> }
const libApi = (): LibApi | null => (window as unknown as { KiCadLibrary?: LibApi }).KiCadLibrary || null;

export interface LibIdRow { refs: string; cur: string; next: string; orphan: boolean; items: { sheet: Sheet; item: KItem }[] }
/** initDlg: the symbols sorted by lib id, one row per id, the references joined with ", " (a repeated reference once). */
export function libIdRows(sheets: { sheet: Sheet; items: KItem[] }[]): LibIdRow[] {
  const all: { sheet: Sheet; item: KItem; libId: string; ref: string; orphan: boolean }[] = [];
  for (const { sheet, items } of sheets) for (const it of items) {
    if (it.kind !== "symbol") continue;
    const libId = L.libIdOf(it.node), refs = L.symbolRefs(it.node);
    all.push({ sheet, item: it, libId, ref: refs.join(", "), orphan: !(sheet.doc.lib && sheet.doc.lib.has(libId)) });
  }
  all.sort((a, b) => (a.libId < b.libId ? -1 : a.libId > b.libId ? 1 : a.ref.localeCompare(b.ref, undefined, { numeric: true })));
  const rows: LibIdRow[] = [];
  for (const s of all) {
    let r = rows[rows.length - 1];
    if (!r || r.cur !== s.libId) { r = { refs: "", cur: s.libId, next: "", orphan: s.orphan, items: [] }; rows.push(r); }
    r.items.push({ sheet: s.sheet, item: s.item });
    const seen = r.refs ? r.refs.split(", ") : [];
    for (const ref of s.ref.split(", ")) if (ref && !seen.includes(ref)) seen.push(ref);
    r.refs = seen.join(", ");
  }
  return rows;
}
/** LIB_ID::Parse: "nickname:name", neither part empty. */
export const validLibId = (s: string): boolean => /^[^:]+:[^:]+$/.test(s.trim());

/** The names in a project .kicad_sym (top-level (symbol "Name" …)). */
function projectSymbolNames(text: string): string[] {
  const out: string[] = []; const re = /^\t?\(symbol "((?:[^"\\]|\\.)*)"/gm; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

export async function openEditSymbolsLibId(): Promise<void> {
  if (!E.kdoc || E.kdoc.type !== "sch") return;
  libCache.clear();
  const sheets = await allSheets();
  const rows = libIdRows(sheets.map((s) => ({ sheet: s, items: Array.from(s.doc.items.values()) })));
  let updateFields = false;
  const inputs: HTMLInputElement[] = [];
  const mapOrphans = async (btn: HTMLButtonElement): Promise<void> => {
    btn.disabled = true;
    try {
      // the library names: the project's own libraries first, then the official ones
      const libs: { name: string; names: () => Promise<string[]> }[] = [];
      const docs = projectDocs();
      for (const d of docs.filter((x) => /\.kicad_sym$/i.test(x.path))) {
        const name = d.path.split("/").pop()!.replace(/\.kicad_sym$/i, "");
        libs.push({ name, names: async () => { try { const r = await fetch(`/api/docs/${d.docId}/content`, { credentials: "same-origin" }); return projectSymbolNames(await r.text()); } catch { return []; } } });
      }
      try { const off = await officialLibraries("symbol"); for (const l of off.libraries) if (!libs.some((x) => x.name === l.name)) libs.push({ name: l.name, names: async () => (await officialIndex("symbol", l.name)).map((i) => i.name) }); } catch { /* offline */ }
      let fixes = 0; const orphans = rows.filter((r) => r.orphan);
      const wanted = new Set(orphans.map((r) => r.cur.split(":").pop() || ""));
      const found = new Map<string, string[]>();
      for (const lib of libs) { const names = await lib.names(); for (const n of names) if (wanted.has(n)) { const a = found.get(n) || []; a.push(lib.name + ":" + n); found.set(n, a); } }
      for (const r of orphans) {
        const cands = found.get(r.cur.split(":").pop() || "") || [];
        if (!cands.length) continue;
        fixes++; r.next = cands[0];
        if (cands.length > 1) {
          const pick = await chooseCandidate(`Available Candidates for ${r.cur} `, `Candidates count ${cands.length} `, cands);
          if (pick) r.next = pick;
        }
        const i = rows.indexOf(r); if (inputs[i]) inputs[i].value = r.next;
      }
      await messageBox(fixes < orphans.length ? `${fixes} link(s) mapped, ${orphans.length - fixes} not found` : `All ${fixes} link(s) resolved`, "Map Orphans");
    } finally { btn.disabled = false; }
  };
  KD().open({
    title: "Symbol Library References", width: 820, geomKey: "DIALOG_EDIT_SYMBOLS_LIBID",
    build(body) {
      const tb = h("tbody");
      rows.forEach((r, i) => {
        const inp = h("input", { type: "text", value: r.next, "data-row": String(i), style: "flex:1;min-width:0" }) as HTMLInputElement;
        inp.addEventListener("input", () => { r.next = inp.value; });
        inputs[i] = inp;
        const browse = bitmapButton("small_library", "Browse library", async () => {
          const lib = libApi(); if (!lib) return;
          const cur = (r.next || r.cur).split(":").pop() || "";
          const got = await lib.openChooser("symbol", { title: "Choose Symbol", filter: cur });
          if (!got || !got.libId) return;
          if (!validLibId(got.libId)) { await messageBox("Invalid symbol library identifier"); return; }
          r.next = got.libId; inp.value = got.libId;
        }, { flat: true });
        const tr = h("tr", null, h("td", { style: "white-space:normal;word-break:break-word;padding:2px 6px" }, r.refs),
          h("td", { style: "padding:2px 6px" + (r.orphan ? ";font-weight:700;font-style:italic" : ""), class: r.orphan ? "kd-libid-orphan" : "" }, r.cur),
          h("td", null, h("div", { style: "display:flex;gap:2px;align-items:center" }, inp, browse)));
        tr.addEventListener("dblclick", (ev) => { if ((ev.target as HTMLElement).tagName !== "INPUT") browse.click(); });
        tb.append(tr);
      });
      const tbl = h("table", { class: "kd-grid", id: "kd-libid-grid" },
        h("thead", null, h("tr", null, h("th", { style: "width:33%" }, "Symbols"), h("th", null, "Current Library Reference"), h("th", { style: "width:36%" }, "New Library Reference"))), tb);
      body.append(h("div", { class: "kd-grid-wrap", style: "max-height:420px" }, tbl));
      const orphanBtn = h("button", { class: "btn", type: "button", id: "kd-libid-orphans", title: "If some symbols are orphaned (the linked symbol is not found anywhere),\ntry to find a candidate having the same name in one of loaded symbol libraries.", disabled: !rows.some((r) => r.orphan) }, "Map Orphans") as HTMLButtonElement;
      orphanBtn.addEventListener("click", () => void mapOrphans(orphanBtn));
      body.append(h("div", { style: "display:flex;gap:12px;align-items:center;margin-top:8px" }, orphanBtn,
        checkbox("Update symbol fields from new library", false, (on) => { updateFields = on; }, { id: "kd-libid-update", title: "Replace current symbols fields by fields from the new library.\nWarning: fields \"Value\" and \"Footprints\" will be therefore replaced." })));
    },
    ok() {
      const bad = rows.find((r) => r.next.trim() && !validLibId(r.next));
      if (bad) { void messageBox(`Symbol library identifier ${bad.next} is not valid.`); return false; }
      void apply(rows, updateFields);
    },
  });
}

async function chooseCandidate(message: string, title: string, list: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let pick = list[0], done = false;
    KD().open({
      title, width: 420, child: true,
      build(body) {
        body.append(h("p", { style: "margin:0 0 6px" }, message));
        const box = h("div", { class: "kd-list", style: "height:180px;overflow:auto;border:1px solid var(--line)" });
        for (const c of list) {
          const row = h("div", { class: "kd-li" + (c === pick ? " sel" : ""), style: "padding:2px 6px;cursor:default" }, c);
          row.addEventListener("click", () => { pick = c; for (const r of Array.from(box.children)) r.classList.toggle("sel", r === row); });
          box.append(row);
        }
        body.append(box);
      },
      ok() { done = true; resolve(pick); },
      cancel() { if (!done) resolve(null); },
    });
  });
}

/** TransferDataFromWindow: validateLibIds, then each changed row's symbols relinked; one step per sheet. */
async function apply(rows: LibIdRow[], updateFields: boolean): Promise<void> {
  const perSheet = new Map<Sheet, { changes: KChange[]; inverse: KChange[] }>();
  const K = KiCadCanvas;
  for (const r of rows) {
    const id = r.next.trim(); if (!id || id === r.cur) continue;
    const lib = await libSymbol(id);
    if (!lib) { const [nick, name] = id.split(":"); await messageBox(`Error loading symbol ${name} from library ${nick}.\n\nSymbol not found.`); continue; }
    for (const { sheet, item } of r.items) {
      const unitN = K.kid(item.node, "unit") as SNode | null, unit = unitN ? K.num(unitN[1], 1) : 1;
      if (L.libUnits(lib) < unit) { await messageBox(`Cannot remap symbol ${L.symbolRefs(item.node)[0] || ""} to '${id}': the new symbol has too few units.`); continue; }
      const node = (K.cloneNode as (n: SNode) => SNode)(item.node);
      // a Value that is a proxy for the item name follows it
      const oldName = r.cur.split(":").pop() || "", newName = id.split(":").pop() || "";
      const val = L.fieldOf(node, "Value");
      const o: L.UpdateOptions = Object.assign(L.defaultOptions("update"), { fields: new Set<string>(), resetText: false, resetEmpty: false, resetVisibility: false, resetEffects: false, resetPositions: false, resetAttributes: false, resetPinTextVisibility: false, resetAlternates: false, resetPinMaps: false });
      if (updateFields) { o.fields = new Set(L.fieldsOf(lib).map((p) => L.propName(p)).filter((n) => n !== "Reference")); o.resetText = true; o.resetEmpty = true; }
      const out = L.updateSymbolNode(node, lib, id, o, { used: new Set(), renamed: new Map() }, () => K.newUuid());
      if (val && L.propValue(val) === oldName) { const v = L.fieldOf(out, "Value"); if (v && L.propValue(v) === oldName) v[v.length > 3 && L.isPrivate(v) ? 3 : 2] = newName; }
      const acc = perSheet.get(sheet) || { changes: [], inverse: [] }; perSheet.set(sheet, acc);
      acc.inverse.push(K.replaceChange(sheet.doc, item));
      acc.changes.push({ id: item.id, kind: "MODIFIED", typeName: "SCH_SYMBOL", sexpr: "(lib_symbols " + K.serialize(lib) + ") " + K.serialize(out) } as KChange);
    }
  }
  const label = "Change Symbol Library Indentifier";
  for (const [sheet, acc] of perSheet) {
    if (sheet.current) { toolCtx().commit(acc.changes, label); continue; }
    try { await submitDocOp(sheet.docId, acc.changes); pushUndoFor(sheet.docId, { label, changes: acc.changes, inverse: acc.inverse }); }
    catch (e) { await messageBox(`Could not update ${sheet.path}: ${(e as Error).message}`); }
  }
}
