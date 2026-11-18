// cad-usage.ts — on a board, the way to the part studios and assemblies that use it.
//
// A part studio brings a board in with a Board feature and follows it live (web/domains/mechanical/board); an
// assembly instances it.  Somebody moving a connector here wants to see what that does to the enclosure, so the
// board editor shows a small button at the top of the canvas, "Used in Part Studio 1", that opens it (a tab
// switch); with several, the button opens a list.  Nothing is shown for a board no CAD document uses.
//
// Which documents use the board is read from the documents themselves: every part studio and assembly of the
// project as it stands now (the stored file and the edits since), looked through for this board's id.
import { applyChanges, parseItemDoc, serializeItemDoc, type ItemChange } from "../../../shared/itemdoc/itemdoc";
import type { DocEntry } from "../../../shared/store";
import { documentKind } from "../../registry";
import { state, store } from "./appstore";
import { openDocId } from "./doc";

const CAD_TYPES = ["part_studio", "assembly"];
const title = (d: DocEntry): string => (d.path.split("/").pop() || d.path).replace(/\.[^.]+$/, "");

let shownFor = "";          // the board the button was last worked out for, with the documents looked at
let users: DocEntry[] = [];
let menuOpen = false;
let asked = 0;

async function current(doc: DocEntry): Promise<string> {
  const r = await fetch(`/api/docs/${doc.docId}/content`);
  if (!r.ok) return "";
  const text = await r.text(), seq = Number(r.headers.get("x-snapshot-seq")) || 0;
  try {
    const item = parseItemDoc(text);
    const ops = await fetch(`/api/docs/${doc.docId}/ops?since=${seq}`).then((o) => (o.ok ? o.json() : { ops: [] })).catch(() => ({ ops: [] }));
    for (const op of (ops.ops || []) as { changes: ItemChange[] }[]) applyChanges(item, op.changes || []);
    return serializeItemDoc(item);
  } catch (e) { return text; }
}

/** The CAD documents of the project that refer to this board. */
export async function boardUsers(boardId: string, docs: readonly DocEntry[]): Promise<DocEntry[]> {
  const out: DocEntry[] = [];
  await Promise.all(docs.filter((d) => CAD_TYPES.includes(d.docType)).map(async (d) => {
    try { if ((await current(d)).includes(boardId)) out.push(d); } catch (e) { /* a document that cannot be read uses nothing */ }
  }));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function host(): HTMLElement | null { return document.getElementById("stage"); }

function render(): void {
  const stage = host(); if (!stage) return;
  let el = document.getElementById("cadUsage");
  const onBoard = state.view === "editor" && !!state.doc && state.doc.docType === "kicad_pcb";
  if (!onBoard || !users.length) { if (el) el.remove(); menuOpen = false; return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "cadUsage";
    el.style.cssText = "position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:5;display:flex;flex-direction:column;align-items:center;gap:2px";
    // the canvas under it must not take these clicks as its own
    for (const t of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) el.addEventListener(t, (ev) => ev.stopPropagation());
    stage.appendChild(el);
  }
  el.replaceChildren();
  const glyph = (d: DocEntry): string => `<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${documentKind(d.docType)?.icon || ""}</svg>`;
  const button = document.createElement("button");
  button.type = "button"; button.className = "btn sm"; button.dataset.cadUsage = String(users.length);
  button.style.cssText = "display:inline-flex;align-items:center;gap:6px;box-shadow:var(--shadow-panel, 0 1px 4px rgba(0,0,0,.25))";
  if (users.length === 1) {
    button.innerHTML = `${glyph(users[0])}<span></span>`;
    button.lastElementChild!.textContent = `Used in ${title(users[0])}`;
    button.title = `This board is in ${title(users[0])}, which follows it as you edit. Click to open it.`;
    button.onclick = () => openDocId(users[0].docId);
  } else {
    button.innerHTML = `${glyph(users[0])}<span></span>`;
    button.lastElementChild!.textContent = `Used in ${users.length} CAD documents`;
    button.title = "The part studios and assemblies this board is in. They follow it as you edit.";
    button.setAttribute("aria-haspopup", "menu"); button.setAttribute("aria-expanded", String(menuOpen));
    button.onclick = () => { menuOpen = !menuOpen; render(); };
  }
  el.appendChild(button);
  if (menuOpen && users.length > 1) {
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.style.cssText = "min-width:180px;padding:4px 0;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink);box-shadow:var(--shadow-panel, 0 2px 8px rgba(0,0,0,.3))";
    for (const d of users) {
      const item = document.createElement("button");
      item.type = "button"; item.setAttribute("role", "menuitem"); item.dataset.cadUser = d.docId;
      item.style.cssText = "display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 12px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:default";
      item.onmouseenter = () => { item.style.background = "var(--sel-soft, rgba(128,128,128,.18))"; };
      item.onmouseleave = () => { item.style.background = "transparent"; };
      item.innerHTML = `${glyph(d)}<span></span>`;
      item.lastElementChild!.textContent = title(d);
      item.onclick = () => { menuOpen = false; openDocId(d.docId); };
      menu.appendChild(item);
    }
    el.appendChild(menu);
  }
}

function refresh(force = false): void {
  const doc = state.doc, docs = state.project ? state.project.docs : [];
  const onBoard = state.view === "editor" && !!doc && doc.docType === "kicad_pcb";
  if (!onBoard) { if (shownFor) { shownFor = ""; users = []; render(); } return; }
  const cad = docs.filter((d) => CAD_TYPES.includes(d.docType));
  const key = `${doc!.docId}|${cad.map((d) => d.docId + d.path).join(",")}`;
  if (key === shownFor && !force) return;
  if (key !== shownFor) { users = []; menuOpen = false; render(); }
  shownFor = key;
  if (!cad.length) return;
  const mine = ++asked, boardId = doc!.docId;
  void boardUsers(boardId, cad).then((found) => { if (mine === asked && shownFor === key) { users = found; render(); } });
}

store.subscribe(() => refresh());
// a part studio may have taken the board in, or let it go, while this window was elsewhere
window.addEventListener("focus", () => refresh(true));
window.addEventListener("pointerdown", (ev) => { if (menuOpen && !(ev.target as HTMLElement | null)?.closest?.("#cadUsage")) { menuOpen = false; render(); } });
