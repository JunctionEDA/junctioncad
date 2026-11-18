// editor/viewer3d-loader.ts — View → 3D Viewer (ACTIONS::show3DViewer, Alt+3) for the board editor.
// The viewer is a bundle of its own (static/dist/viewer3d.js, server/web/domains/pcb/viewer3d) fetched on first
// use; this module loads it, hands it the live board document and tells it when the document changes.
import { state, store } from "./appstore";
import { E } from "./state";
import { toast } from "./util";
import { toolCtx } from "./tools";
import { centerOn } from "./comments";
import { colorPicker } from "./pcbdialogs/color-picker";
import { listDialog, messageBox, textEntryBox } from "./pcbdialogs/ui";
import { loadBoardHeader } from "./pcbdialogs/board-setup";
import { BS } from "./pcbdialogs/canvas";
import { HANDLERS } from "./actions";
import { LINKS } from "../tables";

type Rgba = { r: number; g: number; b: number; a: number };
interface Viewer3DOpenOptions {
  getDoc(): KDoc | null;
  getName?(): string;
  subscribe?(onChange: () => void): () => void;
  toast?(text: string, ms?: number): void;
  selectRef?(ref: string): void;
  pickColor?(current: Rgba, allowOpacity: boolean, done: (c: Rgba) => void, def: Rgba): void;
  textEntry?(title: string, caption: string, value: string, ok: (text: string) => void): void;
  listPick?(title: string, header: string, label: string, items: string[], ok: (item: string) => void): void;
  confirm?(message: string, yes: () => void): void;
  openPreferences?(): void;
  runAction?(id: string): void;
  links?: Record<string, string>;
  layerVisible?(layer: string): boolean;
  plotLayers?(): Promise<string[] | null>;
  stackupLayers?(): Promise<{ name: string; type?: string; color?: string }[] | null>;
  stackupFinish?(): Promise<string | null>;
  editorColor?(layer: string): string | null;
}
export interface Viewer3DGlobal { open(opts: Viewer3DOpenOptions): unknown; close(): void; isOpen(): boolean; embed?(host: HTMLElement, opts?: { wheel?: boolean }): EmbeddedViewer3D }
/** The bare 3D canvas (viewer3d/viewer.ts Viewer) a dialog embeds: the 3D model previews. */
export interface EmbeddedViewer3D { setDoc(doc: KDoc, fit: boolean): unknown; useModels(on: boolean): void; setVisibility(patch: Record<string, boolean>): void; view(name: string): void; ortho: boolean; setOrtho(on: boolean): void; modelsSettled(): Promise<void>; requestRender(): void; resize(): void; dispose(): void; zoomBy(f: number): void }

interface EditorState { kdoc: KDoc | null }
interface AppStore {
  get(): { document: { version: number; docId: string | null }; undo: { undo: number; redo: number }; connection: { edits: number }; view: string };
  subscribe(fn: () => void): () => void;
}
interface DocEntry { docId: string; path?: string }

const editor = E as unknown as EditorState;
const app = store as unknown as AppStore;

let loading: Promise<Viewer3DGlobal> | null = null;

function viewerGlobal(): Viewer3DGlobal | undefined { return (window as unknown as { KiCadViewer3D?: Viewer3DGlobal }).KiCadViewer3D; }

/** Fetch the viewer bundle once; its URL carries the same cache-busting version as the editor's own script. */
export function loadViewer(): Promise<Viewer3DGlobal> {
  const ready = viewerGlobal(); if (ready) return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise<Viewer3DGlobal>((resolve, reject) => {
    const own = document.querySelector<HTMLScriptElement>('script[src*="/static/dist/editor.js"]');
    const query = own ? (own.getAttribute("src") || "").split("?")[1] : "";
    const s = document.createElement("script"); s.src = "/static/dist/viewer3d.js" + (query ? "?" + query : "");
    s.onload = () => { const g = viewerGlobal(); if (g) resolve(g); else reject(new Error("viewer3d.js did not register")); };
    s.onerror = () => reject(new Error("could not load viewer3d.js"));
    document.head.appendChild(s);
  });
  loading.catch(() => { loading = null; });
  return loading;
}

function boardDoc(): KDoc | null { const d = editor.kdoc; return d && d.type === "pcb" ? d : null; }

function boardName(): string {
  const docs = ((state as unknown as { docs?: DocEntry[] }).docs) || [];
  const id = (state as unknown as { docId: string | null }).docId;
  const d = docs.find((x) => x.docId === id);
  return d && d.path ? String(d.path).split("/").pop() || "" : "";
}

/** Select the footprint with this reference on the board and bring it into view (the 3D viewer's status links). */
function selectRef(ref: string): void {
  const doc = boardDoc(); if (!doc) return;
  for (const it of doc.items.values() as Iterable<KItem & { ref?: string }>) {
    if (it.ref !== ref || !it.bbox) continue;
    (toolCtx() as unknown as { setSelection(ids: string[]): void }).setSelection([it.id]);
    centerOn((it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2);
    return;
  }
  toast(`${ref} is not on the board any more`);
}

/** Open (or focus) the 3D viewer on the board being edited. */
export function show3DViewer(): void {
  if (!boardDoc()) { toast("The 3D viewer shows a board: open the PCB editor first"); return; }
  loadViewer().then((viewer) => {
    viewer.open({
      getDoc: boardDoc, getName: boardName, toast, selectRef,
      pickColor: (cur, opacity, done, def) => colorPicker(cur, opacity, done, def),
      textEntry: (title, caption, value, ok) => { textEntryBox(title, caption, value, false, ok); },
      listPick: (title, header, label, items, ok) => { listDialog(title, [header], items.map((i) => [i]), (row) => ok(row[0]), { listLabel: label }); },
      // IsOK(): "Confirmation" with Yes / No
      confirm: (message, yes) => { messageBox("Confirmation", message, [{ label: "No" }, { label: "Yes", fn: yes }], 0); },
      openPreferences: () => { const h = HANDLERS.openPreferences; if (h) h(null); },
      runAction: (id) => { const h = HANDLERS[id]; if (h) h(null); },
      links: LINKS,
      layerVisible: (layer) => !(E.hiddenLayers as Set<string>).has(layer),
      // the plot dialog's layer selection (PCB_PLOT_PARAMS m_layerSelection) as the board stores it
      stackupLayers: async () => { const h = await loadBoardHeader(); return h ? BS().stackupLayers(h.setup) : null; },
      stackupFinish: async () => { const h = await loadBoardHeader(); return h ? BS().boardFinish(h.setup).copperFinish : null; },
      // the Appearance panel's colour of the layer (the user's, else the board editor's theme colour)
      editorColor: (layer) => { const own = E.renderOpts.layerColors as Map<string, string> | undefined; return (own && own.get(layer)) || KiCadCanvas.PCB_COLORS[layer] || null; },
      plotLayers: async () => { const h = await loadBoardHeader(); return h ? BS().readPlotParams(h.setup, h.version).layerSelection : null; },
      // An applied change — local or a collaborator's — bumps document.version (doc.ts bumpDoc); the board
      // editor's own footprint drag commits without it but records an undo step, and a remote op counts
      // in connection.edits: any of them moving means the board may have changed.
      subscribe(onChange) {
        const stamp = () => { const s = app.get(); return [s.document.docId, s.document.version, s.undo.undo, s.undo.redo, s.connection.edits].join("|"); };
        let last = stamp(); const docId = app.get().document.docId;
        return app.subscribe(() => {
          // left the board editor (home, another project, a schematic sheet, another board): the window goes with it, as
          // KiCad's 3D viewer closes with its PCB frame
          const s = app.get(), d = editor.kdoc;
          if (s.view !== "editor" || (s.document.docId && s.document.docId !== docId) || (d && d.type !== "pcb")) { viewer.close(); return; }
          const now = stamp(); if (now !== last) { last = now; onChange(); }
        });
      },
    });
  }).catch((e: unknown) => { console.warn(e); toast("The 3D viewer could not be loaded"); });
}

/** EDA_3D_VIEWER_FRAME on another frame's board (CvPcb's footprint viewer: a board holding the one footprint). */
export function show3DViewerOn(opts: Viewer3DOpenOptions): Promise<void> {
  return loadViewer().then((viewer) => { viewer.open(opts); }).catch((e: unknown) => { console.warn(e); toast("The 3D viewer could not be loaded"); });
}
export function close3DViewer(): void { const v = viewerGlobal(); if (v && v.isOpen()) v.close(); }

// Alt+3, KiCad's hotkey for show3DViewer (matched on the physical key: Alt+3 types a symbol on some layouts)
document.addEventListener("keydown", (ev) => {
  if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.code !== "Digit3") return;
  const t = ev.target as HTMLElement | null;
  if ((t && /^(INPUT|TEXTAREA|SELECT|K-SELECT)$/.test(t.tagName)) || app.get().view !== "editor" || !boardDoc()) return;
  ev.preventDefault(); show3DViewer();
});
