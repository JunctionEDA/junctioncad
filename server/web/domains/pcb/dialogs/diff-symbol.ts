// dialogs/diff-symbol.ts — Inspect > Compare Symbol with Library (SCH_INSPECTION_TOOL::DiffSymbol in the
// DIALOG_BOOK_REPORTER SCH_EDIT_FRAME::GetSymbolDiffDialog makes).  A modeless book of two pages:
//   Summary  which symbol, library and item are compared, then LIB_SYMBOL::Compare's report with the schematic's
//            Compare Symbol with Library settings (Schematic Setup), or "No relevant differences detected."
//   Visual   SYMBOL_DIFF_WIDGET: both drawn over each other with the Schematic … Library slider and the A / B toggle
// Its Apply button is "Update Symbol from Library..." (DIALOG_CHANGE_SYMBOLS on that symbol).
import { E, api, toast, toolCtx } from "./editor";
import { projectDocs } from "./project";
import { officialLibraries, projectLibraries } from "../library/sources";
import { parseLibTable } from "../symedit/model";
import { manageLibraries } from "./lib-tables";
import { KD, h, type DlgApi } from "./dom";
import { bitmapButton } from "../../../shared/components/kicon-dom";
import { keyName } from "../../../shared/keys";
import { loadProject, proDoc, obj, type JsonObj } from "./project";
import { parityOf } from "./schematic-setup-logic";
import { libCache, libSymbol, openChangeSymbols } from "./change-symbols";
import { compareSymbols, instanceAtOrigin } from "./diff-symbol-logic";
import { parseLibId, symbolInstance } from "../library/core";
import { renderSymbolDiff } from "../library/preview";

const K = (): KiCadCanvasApi => window.KiCadCanvas;
const str = (v: unknown): string => K().str(v as SNode);

function selectedSymbol(): KItem | null {
  const doc = E.kdoc; if (!doc) return null;
  const ids = new Set<string>(E.selection); if (E.selected) ids.add(E.selected.id);
  for (const id of ids) { const it = doc.items.get(id); if (it && it.kind === "symbol") return it; }
  return null;
}

/** SYMBOL_LIBRARY_ADAPTER::HasLibrary( name, false / true ): a row of the project's sym-lib-table (enabled or not), a
 *  project library, or an official one; "ok" when the official list cannot be read. */
async function libraryState(libName: string): Promise<"ok" | "missing" | "disabled"> {
  if (!libName) return "missing";
  const docs = projectDocs(), table = docs.find((d) => d.path === "sym-lib-table");
  if (table) {
    try { const t = await api(`/api/docs/${table.docId}/content`); const row = parseLibTable(typeof t === "string" ? t : String(t)).find((r) => r.nickname === libName); if (row) return row.enabled ? "ok" : "disabled"; } catch { /* no table text */ }
  }
  if (projectLibraries("symbol", docs).some((l) => l.name === libName)) return "ok";
  const official = await officialLibraries("symbol").then((t) => t.libraries, () => null);
  return !official || official.some((l) => l.name === libName) ? "ok" : "missing";
}

export function openDiffSymbol(): void {
  if (!E.kdoc || E.kdoc.type !== "sch") return;
  const item = selectedSymbol();
  // RequestSelection( { SCH_SYMBOL_T } ) came back empty
  // m_frame->ShowInfoBarError: the editor's infobar (toast), shown for ShowMessageFor's 8 s
  if (!item) { toast("Select a symbol to diff against its library equivalent.", 8000); return; }
  void build(E.kdoc, item);
}

async function build(doc: KDoc, item: KItem): Promise<void> {
  const node = item.node;
  const libIdNode = K().kid(node, "lib_id"), libId = libIdNode ? str(libIdNode[1]) : "";
  const { lib: libName, name: symbolName } = parseLibId(libId);
  const refProp = K().kids(node, "property").find((p) => str(p[1]) === "Reference");
  const ref = refProp ? str(refProp[2]) : "?";
  const unitN = K().kid(node, "unit"), bodyN = K().kid(node, "body_style");
  const unit = unitN ? Math.max(1, K().num(unitN[1])) : 1, body = bodyN ? Math.max(1, K().num(bodyN[1])) : 1;
  let parity: Record<string, boolean> = parityOf({});
  if (proDoc()) { try { const pro = await loadProject(); parity = parityOf(obj((pro as JsonObj).schematic)); } catch { /* defaults */ } }
  libCache.delete(libId);
  const libSym = libId ? await libSymbol(libId) : null;
  const schSym = doc.lib.get(libId) || null;

  const lines: { text: string; cls?: string; manage?: boolean }[] = [];
  let diffs: string[] = [];
  const state = await libraryState(libName);
  // libs->HasLibrary( libName, false ) / HasLibrary( libName, true ), each with the Manage Symbol Libraries link
  if (state === "missing") lines.push({ text: "The library is not included in the current configuration.", manage: true });
  else if (state === "disabled") lines.push({ text: "The library is not enabled in the current configuration.", manage: true });
  else if (!libSym) lines.push({ text: `The library no longer contains the item ${symbolName}.` });
  else if (!schSym) lines.push({ text: `The schematic has no copy of ${libId}.` });
  else {
    diffs = compareSymbols(schSym, libSym, parity, node);
    if (!diffs.length) lines.push({ text: "No relevant differences detected." });
    for (const d of diffs) lines.push({ text: d, cls: "diff" });
  }

  let canvas: HTMLCanvasElement | null = null, slider: HTMLInputElement | null = null, docs: [KDoc, KDoc] | null = null;
  const repaint = (): void => { if (canvas && slider && docs && canvas.clientWidth) renderSymbolDiff(canvas, docs[0], docs[1], +slider.value / 100); };
  const toggleAB = (): void => { if (!slider) return; slider.value = +slider.value === 0 ? "100" : "0"; repaint(); };
  if (libSym && schSym) {
    const head = '(kicad_sch (version 20260101) (generator "eeschema") (paper "A4")';
    const schDoc = K().parseDoc(`${head} (lib_symbols ${K().serialize(schSym)}) ${K().serialize(instanceAtOrigin(node))})`);
    const inst = symbolInstance({ libId, symbol: libSym, at: [0, 0], unit, bodyStyle: body, reference: ref, uuid: "00000000-0000-4000-8000-000000000003" });
    const libDoc = K().parseDoc(`${head} (lib_symbols ${K().serialize(libSym)}) ${K().serialize(inst)})`);
    docs = [schDoc, libDoc];
  }

  let ro: ResizeObserver | null = null;
  const onKey = (ev: KeyboardEvent): void => {
    // the toggle's '/' hotkey, while the Visual page is showing
    if (ev.key === "/" && canvas && canvas.isConnected && canvas.offsetParent && !(ev.target instanceof HTMLInputElement && ev.target.type === "text")) { ev.preventDefault(); toggleAB(); }
  };
  KD().open({
    title: "Compare Symbol with Library", width: 640, modeless: true, geomKey: "DIFF_SYMBOLS_DIALOG",
    build(body: HTMLElement, api: DlgApi) {
      KD().notebook(body, [
        { label: "Summary", build(pg) {
          const box = h("div", { id: "kd-diffsym-summary", class: "kd-diffsym-report", style: "height:360px;overflow:auto;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-2);background:var(--panel);user-select:text;font-size:12px" });
          box.append(h("div", { style: "font-weight:600" }, "Schematic vs library diff for:"),
            h("ul", { style: "margin:4px 0 10px;padding-left:20px" }, h("li", null, `Symbol ${ref}`), h("li", null, `Library: ${libName}`), h("li", null, `Library item: ${symbolName}`)));
          for (const l of lines) {
            const ln = h("div", { class: l.cls ? "ln " + l.cls : "ln", style: "margin:2px 0" }, l.text);
            // <a href='$CONFIG'>: the Manage Symbol Libraries dialog (ACTIONS::showSymbolLibTable)
            if (l.manage) { const a = h("a", { href: "#", id: "kd-diffsym-manage", style: "margin-left:12px" }, "Manage Symbol Libraries"); a.addEventListener("click", (ev) => { ev.preventDefault(); void manageLibraries("symbol", { readOnly: !!E.viewOnly }); }); ln.append(a); }
            box.append(ln);
          }
          pg.append(box);
        } },
        ...(docs ? [{ label: "Visual", build(pg: HTMLElement) {
          canvas = h("canvas", { id: "kd-diffsym-canvas", style: "display:block;width:100%;height:330px;border:1px solid var(--line);border-radius:var(--r-2)" }) as HTMLCanvasElement;
          slider = h("input", { type: "range", id: "kd-diffsym-slider", min: "0", max: "100", value: "50", style: "flex:1" }) as HTMLInputElement;
          slider.addEventListener("input", repaint);
          const swap = bitmapButton("swap", `Toggle between A and B display (${keyName("/")})`, () => toggleAB(), { cls: "kd-diffsym-swap" });
          pg.append(canvas, h("div", { class: "kd-row", style: "gap:6px;margin-top:6px;align-items:center" }, h("span", null, "Schematic"), slider, h("span", null, "Library"), swap));
          ro = new ResizeObserver(() => repaint()); ro.observe(canvas);
        } }] : []),
      ], { onSelect: () => requestAnimationFrame(repaint) });
      document.addEventListener("keydown", onKey, true);
      const closeAll = (): void => { document.removeEventListener("keydown", onKey, true); if (ro) ro.disconnect(); };
      const obs = new MutationObserver(() => { if (!api.dlg.isConnected) { closeAll(); obs.disconnect(); } });
      obs.observe(document.body, { childList: true, subtree: true });
    },
    buttons: [
      { label: "Update Symbol from Library...", id: "kd-diffsym-update", fn: () => {
        // DIALOG_BOOK_REPORTER::OnApply: the Update Symbols dialog for this symbol
        toolCtx().setSelection([item.id]); KD().close(); openChangeSymbols("update");
      } },
      { label: "Close", primary: true, isDefault: true, close: true },
    ],
  });
}
