// vertex-editor.ts — PCB_VERTEX_EDITOR_PANE (pcbnew/widgets/vertex_editor_pane.cpp), opened by Edit Corners...
// (EDIT_TOOL::EditVertices): a floating "Edit Vertices" pane with an X coord / Y coord grid, one row per corner of the
// selected zone or polygon in the frame's units and user origin.  A changed cell is one "Edit Vertex" commit; the
// pane follows the selection (PCB_CONTROL::UpdateMessagePanel → UpdateVertexEditorSelection) and empties when the
// selection holds no zone or polygon.
import { E } from "../state";
import { toolCtx } from "../tools";
import { messageText } from "../../../../shared/units";
import type { Units } from "../../../../shared/store";
import { fromDisplayAbsAxis, toDisplayAbsAxis } from "../userorigin";
import { currentUnits, h, openDialog, parseLen, type DialogApi } from "./ui";
import { hasEditableCorners, hasLeadingDigit, setVertex, vertexRows } from "./vertex-model";

type Node = (string | number | Node)[];
const K = (): KiCadCanvasApi => KiCadCanvas;
let dlg: DialogApi | null = null, itemId: string | null = null, poll = 0, shownSig = "";

function selectedIds(): string[] {
  const ids = new Set<string>(E.selection as Set<string>);
  const P = (window as unknown as { PcbTools?: { state: { sel: Set<string> } } }).PcbTools; if (P) for (const id of P.state.sel) ids.add(id);
  return Array.from(ids);
}
/** EDIT_TOOL's selectionHasEditableCorners: exactly one item, a polygon or a non-teardrop zone. */
export function editableCornersSelected(): boolean {
  const ids = selectedIds(); if (ids.length !== 1 || !E.kdoc) return false;
  const it = E.kdoc.items.get(ids[0]); return !!it && hasEditableCorners(it.kind, it.node as Node);
}
const units = (): Units => currentUnits() as Units;
const fmt = (mm: number, axis: "x" | "y"): string => messageText(toDisplayAbsAxis(mm, axis), units(), "pcb");

function render(): void {
  if (!dlg) return;
  const it = itemId && E.kdoc ? E.kdoc.items.get(itemId) : null;
  const rows = it ? vertexRows(it.node as Node) : [];
  shownSig = (itemId || "") + "|" + (it ? K().serialize(it.node as never) : "") + "|" + units();
  const body = dlg.body; const keep = body.querySelector<HTMLElement>(".kv-scroll"); const top = keep ? keep.scrollTop : 0;
  const sel = body.querySelector<HTMLElement>("tr.on"); const selRow = sel ? Number(sel.dataset.row) : 0;
  const tbody = h("tbody");
  rows.forEach((r, i) => {
    const cell = (axis: 0 | 1) => {
      const ax = axis ? "y" : "x", shown = fmt(axis ? r.y : r.x, ax);
      const inp = h("input", { type: "text", class: "kv-cell", value: shown, spellcheck: false, autocomplete: "off", "data-row": String(i), "data-axis": ax }) as HTMLInputElement;
      inp.disabled = !!E.viewOnly;
      const commit = (): void => {
        if (inp.value === shown) return;
        const mm = hasLeadingDigit(inp.value) ? parseLen(inp.value, units()) : NaN;
        const cur = itemId && E.kdoc ? E.kdoc.items.get(itemId) : null;
        if (!cur || isNaN(mm)) { inp.value = shown; return; }   // updateRow: the old value comes back
        const node = K().cloneNode(cur.node as never) as unknown as Node;
        if (!setVertex(node, i, axis, fromDisplayAbsAxis(mm, ax))) { inp.value = shown; return; }
        toolCtx().commit([K().replaceChange(E.kdoc as KDoc, Object.assign({}, cur, { node, geom: [], bbox: null }))], "Edit Vertex");
        render();
      };
      inp.addEventListener("change", commit);
      inp.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        else if (ev.key === "Escape") { ev.preventDefault(); inp.value = shown; inp.blur(); }
      });
      inp.addEventListener("focus", () => { pick(i); inp.select(); });
      return h("td", null, inp);
    };
    const tr = h("tr", { "data-row": String(i), class: i === selRow ? "on" : "" }, cell(0), cell(1));
    tbody.append(tr);
  });
  const table = h("table", { class: "kv-grid", "data-vertex-grid": "" }, h("thead", null, h("tr", null, h("th", null, "X coord"), h("th", null, "Y coord"))), tbody);
  const scroll = h("div", { class: "kv-scroll" }, table);
  body.replaceChildren(scroll);
  scroll.scrollTop = top;
  function pick(i: number): void { for (const tr of Array.from(tbody.children)) tr.classList.toggle("on", Number((tr as HTMLElement).dataset.row) === i); }
}

/** PCB_BASE_EDIT_FRAME::OpenVertexEditor: the pane (made once) shows the item and takes the focus. */
export function openVertexEditor(): boolean {
  if (!editableCornersSelected()) return false;
  itemId = selectedIds()[0];
  if (dlg && dlg.dialog.isConnected) { render(); const f = dlg.body.querySelector<HTMLInputElement>(".kv-cell"); if (f) f.focus(); return true; }
  dlg = openDialog({ title: "Edit Vertices", width: 320, height: 360, modeless: true, noOk: true,
    build(body, api) {
      const foot = api.dialog.querySelector<HTMLElement>(".kd-foot"); if (foot) foot.style.display = "none";
      api.dialog.dataset.vertexEditor = "";
      ensureCss(); dlg = api; render();
    },
    cancel() { stop(); },
  });
  if (!dlg) return false;
  window.clearInterval(poll);
  // OnSelectionChanged, and the item edited elsewhere (undo, the point editor): the grid follows
  poll = window.setInterval(() => {
    if (!dlg || !dlg.dialog.isConnected) { stop(); return; }
    const ids = selectedIds(), it = ids.length === 1 && E.kdoc ? E.kdoc.items.get(ids[0]) : null;
    const next = it && hasEditableCorners(it.kind, it.node as Node) ? it.id : null;
    const editing = dlg.body.contains(document.activeElement) && next === itemId;
    if (next !== itemId) { itemId = next; render(); return; }
    if (!editing) { const cur = itemId && E.kdoc ? E.kdoc.items.get(itemId) : null; const sig = (itemId || "") + "|" + (cur ? K().serialize(cur.node as never) : "") + "|" + units(); if (sig !== shownSig) render(); }
  }, 200);
  const f = dlg.body.querySelector<HTMLInputElement>(".kv-cell"); if (f) f.focus();
  return true;
}
function stop(): void { window.clearInterval(poll); poll = 0; dlg = null; itemId = null; }

let css = false;
function ensureCss(): void {
  if (css) return; css = true;
  const s = document.createElement("style");
  s.textContent = `.kv-scroll{height:300px;overflow-y:scroll;overflow-x:hidden;border:1px solid var(--line);background:var(--paper)}
.kv-grid{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}
.kv-grid th{position:sticky;top:0;background:var(--bench);border-bottom:1px solid var(--line);border-right:1px solid var(--line);font-weight:600;text-align:left;padding:2px 4px;min-width:120px}
.kv-grid td{border-bottom:1px solid var(--line-soft,var(--line));border-right:1px solid var(--line-soft,var(--line));padding:0}
.kv-grid tr.on td{background:var(--sel)}
.kd-dialog .kv-grid input.kv-cell{width:100%;height:20px;border:0;border-radius:0;margin:0;padding:0 4px;background:transparent;color:var(--ink);font:12px var(--font);outline:none;box-shadow:none}
.kd-dialog .kv-grid input.kv-cell:focus{background:var(--panel);box-shadow:inset 0 0 0 1px var(--blue)}`;
  document.head.append(s);
}
