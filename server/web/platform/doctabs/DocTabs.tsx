// DocTabs.tsx — the tab bar of an open project, at the bottom of the window.
//
//   [all tabs] [+]  Home │ PCB · Schematic · Board · BOM │ Part Studio 1 │ Assembly 1 │ …
//
// One tab per ELEMENT of the project (elements.ts): Home first and always there, then each PCB, part studio and
// assembly, in the order the project keeps (drag a tab to change it; everybody sees it move).  A PCB is one tab
// with its views inside it: Schematic, Board and BOM (and the 3D viewer and the fabrication outputs, which belong
// to the board).  The views show on the PCB's tab while it is the open one, and always in a project that has a
// single PCB, so its schematic and board are one click from anywhere.
//
// What exists, what "+" offers and which editor opens a tab all come from the domain registry
// (web/domains/registry.ts).  A click asks the shell to open the tab (dispatch openDoc); the menu bar, these tabs
// and the status bar stay, so moving between a board and a part studio is a tab switch and nothing else.
//
//   click opens · double-click or F2 renames · the menu (right-click) duplicates, moves to a folder, deletes
//   "+" makes a PCB, a part studio, an assembly or a folder, or imports files · files dropped on the bar are imported
//   the list button (or Alt+L) is the tab manager: every tab, searchable · Alt+PageUp / Alt+PageDown switch tabs
//
// The bar also keeps the two live things of an open project: the project's own document (shell.ts) and the
// project room (room.ts): a dot on a tab for each person who is on it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { KIND_SUMMARY, PCB_ELEMENT, type ElementTint } from "../../domains/registry";
import { askConfirm } from "../../shared/components/msgbox";
import { dispatch, useApp, type DocEntry } from "../../shared/store";
import { cx } from "../../shared/util";
import { Menu, toast, type MenuAt, type MenuEntry } from "../home/ui";
import { createElement, creatables, deleteElement, duplicateElement, importFiles, moveElement, newFolder, pickFiles, renameElement, type IncomingFile } from "./actions";
import { askName } from "./askname";
import { ensureShellDoc } from "./api";
import { FOLDER_ICON, HOME_ICON, elementOfTab, foldersOf, moveTabChanges, nameProblem, pcbViewOf, type ProjectElement } from "./elements";
import { HOME_TAB, baseOf, bomTabId, relativePath } from "./pcbs";
import { ProjectRoom } from "./room";
import { DOCS_EVENT, noteText, type DocsNotice, type RoomMember } from "./roomapi";
import { ProjectShell } from "./shell";
import { refreshProject, setHandles, shellDocOf, useProjectShell } from "./useshell";

type El = ProjectElement<DocEntry>;
const TINT: Record<ElementTint, string> = { wire: "text-wire", teal: "text-teal", copper: "text-copper", warn: "text-warn" };
const TINT_BAR: Record<ElementTint, string> = { wire: "var(--wire)", teal: "var(--teal)", copper: "var(--copper)", warn: "var(--warn)" };

export function Glyph({ svg, size = 15, className }: { svg: string; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={cx("flex-none fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round]", className)} strokeWidth={1.7} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** The people on a tab: a dot each (three at most, then a count), named in the tooltip. */
export function TabPeople({ people }: { people: RoomMember[] }) {
  if (!people.length) return null;
  return (
    <span className="flex flex-none items-center -space-x-0.5" data-tab-people={people.map((m) => m.login).join(" ")} title={people.map((m) => m.name).join(", ") + (people.length === 1 ? " is here" : " are here")}>
      {people.slice(0, 3).map((m) => <i key={m.key} className="block w-2 h-2 rounded-full ring-1 ring-bench" style={{ background: m.color }} />)}
      {people.length > 3 ? <span className="pl-1 text-2xs text-ink-3 font-mono">+{people.length - 3}</span> : null}
    </span>
  );
}

/** The folders a tab can be moved to, as a menu. */
export function folderMenu(folders: readonly string[], current: string, onPick: (folder: string) => void, onNew: () => void): MenuEntry[] {
  return [
    { id: "root", label: "Project (no folder)", icon: "projects", disabled: current === "", run: () => onPick("") },
    ...folders.map((f): MenuEntry => ({ id: "f:" + f, label: f, icon: "file", disabled: f === current, run: () => onPick(f) })),
    "-",
    { id: "new", label: "New folder…", icon: "plus", run: onNew },
  ];
}

const COLLAPSED = (projectId: string): string => "kui.tabs.folded." + projectId;
function readFolded(projectId: string): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED(projectId)) || "[]") as string[]); } catch (e) { return new Set(); } }

export function DocTabs() {
  const view = useApp((s) => s.view);
  const signedIn = useApp((s) => !!s.me);
  const myId = useApp((s) => (s.me ? s.me.id : 0));
  const openDocType = useApp((s) => s.document.doc?.docType || null);
  const hasDoc = useApp((s) => s.document.hasDoc);
  const shell = useProjectShell();
  const { projectId, docs, elements, current, canEdit, room, ctx } = shell;
  const [menu, setMenu] = useState<{ at: MenuAt; items: MenuEntry[]; title?: string } | null>(null);
  const [adding, setAdding] = useState<{ x: number; y: number } | null>(null);
  const [manager, setManager] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // the picture of a document, shown over its tab while the pointer rests there (the document's editor posts it:
  // web/platform/documents/thumbnail.ts); a document nobody has drawn yet has none, and then nothing is shown
  const [thumb, setThumb] = useState<{ docId: string; x: number; y: number; v: number } | null>(null);
  const thumbTimer = useRef(0);
  const [drag, setDrag] = useState<{ key: string; before: string | null; x: number } | null>(null);
  const [overflow, setOverflow] = useState({ any: false, left: false, right: false });
  const [after, setAfter] = useState<{ docId: string; action: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLButtonElement>(null);
  const open = !!projectId && view !== "home";
  const docsRef = useRef(docs); docsRef.current = docs;
  const suppressClick = useRef(false);
  const openTimer = useRef(0);
  const boundKey = useApp((s) => (s.project && s.project.pcb ? s.project.pcb.key : null));

  useEffect(() => { if (projectId) setFolded(readFolded(projectId)); }, [projectId]);
  useEffect(() => { if (!notice) return; const t = window.setTimeout(() => setNotice(null), 5000); return () => window.clearTimeout(t); }, [notice]);

  // ---- the two live things of an open project: its own document and its room
  useEffect(() => {
    if (!projectId || view === "home") return;
    const pid = projectId;
    const refresh = () => { void refreshProject(pid, docsRef.current).catch(() => {}); };
    const r = new ProjectRoom({ signedIn, onDocsChanged: refresh });
    const s = new ProjectShell({ signedIn, onNeedDoc: async () => { const id = await ensureShellDoc(pid); refresh(); return id; } });
    window.JunctionRoom = r; window.JunctionShell = s; setHandles({ room: r, shell: s });
    // somebody else may have added or renamed a document: look again when the window comes back
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      r.close(); s.close();
      if (window.JunctionRoom === r) delete window.JunctionRoom;
      if (window.JunctionShell === s) delete window.JunctionShell;
      setHandles({ room: null, shell: null });
    };
  }, [projectId, view === "home", signedIn]);
  const shellDocId = useMemo(() => shellDocOf(docs)?.docId || null, [docs]);
  useEffect(() => { if (open && window.JunctionShell) window.JunctionShell.setDoc(shellDocId); }, [open, shellDocId, ctx && ctx.shell]);
  const allDocs = useApp((s) => (s.project ? s.project.allDocs || s.project.docs : null));
  useEffect(() => { if (open && window.JunctionRoom && allDocs) (window.JunctionRoom as ProjectRoom).setDocs(allDocs); }, [open, allDocs, ctx && ctx.shell]);
  useEffect(() => { if (open && window.JunctionRoom) (window.JunctionRoom as ProjectRoom).setTab(current || null); }, [open, current, ctx && ctx.shell]);
  // the server says when a document of the project is added, renamed or deleted (roomapi.ts tellDocsChanged):
  // the tabs follow, and say who did it unless it was this person
  useEffect(() => {
    if (!projectId || view === "home") return;
    const heard = (ev: Event) => {
      const n = (ev as CustomEvent<DocsNotice>).detail;
      if (!n || n.projectId !== projectId) return;
      // of several changes in a row (a folder of files being imported) the first one is said, and stays readable
      if (n.by.userId !== myId && n.note.name !== "project") setNotice((cur) => cur || noteText(n.by.name, n.note));
      void refreshProject(projectId, docsRef.current).catch(() => {});
    };
    window.addEventListener(DOCS_EVENT, heard);
    return () => window.removeEventListener(DOCS_EVENT, heard);
  }, [projectId, view === "home", myId]);

  // ---- which tab is the open one
  const activeEl = elementOfTab(elements, current);
  const onHome = current === HOME_TAB;
  const pcbCount = elements.filter((e) => e.pcb).length;
  const peopleOn = (ids: (string | null)[]): RoomMember[] => room.members.filter((m) => ids.includes(m.tab));
  const peopleOnElement = (e: El): RoomMember[] => room.members.filter((m) => m.tab && elementOfTab([e], m.tab) === e);

  // a view of a PCB that is asked for with an action to run once it is on screen (3D viewer, fabrication outputs)
  useEffect(() => {
    if (!after || current !== after.docId || !hasDoc) return;
    const a = after.action; setAfter(null);
    const t = window.setTimeout(() => dispatch({ type: "action", id: a }), 60);
    return () => window.clearTimeout(t);
  }, [after, current, hasDoc]);

  // ---- overflow: the strip scrolls; arrows show where there is more, and the open tab is brought into view
  // The two arrows come and go together, and by what the strip would hold WITHOUT them: an arrow that appeared
  // or went with the scroll position would change the strip's width, and so the answer.  They also go at a
  // slightly smaller width than they come at, so a strip that is exactly full cannot flicker between the two.
  // Nothing is set unless the answer changed: this runs after every render.
  const overflowNow = useRef(overflow);
  const measure = () => {
    const el = scroller.current; if (!el) return;
    const o = overflowNow.current;
    let arrows = 0;
    for (const b of Array.from(el.parentElement!.querySelectorAll<HTMLElement>(":scope > [data-tab-scroll]"))) arrows += b.offsetWidth;
    const room = el.clientWidth + arrows;                    // the strip's width with no arrows
    const any = o.any ? el.scrollWidth > room - 4 : el.scrollWidth > room + 1;
    const left = any && el.scrollLeft > 2, right = any && el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    if (o.any === any && o.left === left && o.right === right) return;
    overflowNow.current = { any, left, right };
    setOverflow(overflowNow.current);
  };
  const shown = elements.map((e) => e.key + ":" + e.name + ":" + e.folder).join("|");
  useLayoutEffect(() => { measure(); });
  // the open tab is brought into view when it changes, or when the tabs do
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    const tab = el.querySelector<HTMLElement>('[data-el-tab][aria-selected="true"]');
    if (tab) { const a = tab.getBoundingClientRect(), b = el.getBoundingClientRect(); if (a.left < b.left) el.scrollLeft -= b.left - a.left + 24; else if (a.right > b.right) el.scrollLeft += a.right - b.right + 24; }
    measure();
  }, [current, shown, overflow.any, open]);
  useEffect(() => {
    const el = scroller.current; if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // ---- the keyboard: Alt+PageDown / Alt+PageUp walk the tabs, Alt+L opens the tab manager
  const order = useMemo(() => [HOME_TAB, ...elements.map((e) => e.key)], [elements]);
  const openElement = (e: El) => {
    if (!e.pcb) { dispatch({ type: "openDoc", docId: e.key }); return; }
    // a PCB opens on the view it was last seen in, else on its schematic
    const last = lastView.current.get(e.key);
    const doc = (last && e.pcb.docs.find((d) => d.docId === last)) || e.pcb.schematic || e.pcb.boards[0];
    dispatch({ type: "openDoc", docId: last === bomTabId(e.pcb) ? last : doc ? doc.docId : bomTabId(e.pcb) });
  };
  const lastView = useRef(new Map<string, string>());
  useEffect(() => { if (activeEl && activeEl.pcb && current) lastView.current.set(activeEl.key, current); }, [activeEl, current]);
  const step = useRef<(dir: number) => void>(() => {});
  step.current = (dir: number) => {
    const at = order.indexOf(onHome ? HOME_TAB : activeEl ? activeEl.key : HOME_TAB);
    const next = order[(at + dir + order.length) % order.length];
    if (next === HOME_TAB) dispatch({ type: "openDoc", docId: HOME_TAB });
    else { const e = elements.find((x) => x.key === next); if (e) openElement(e); }
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (!ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.key === "PageDown" || ev.key === "PageUp") { ev.preventDefault(); ev.stopPropagation(); step.current(ev.key === "PageDown" ? 1 : -1); }
      else if (ev.key.toLowerCase() === "l" && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); setManager((m) => !m); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open || !ctx) return <div id="doctabs" hidden />;

  const run = async (what: () => Promise<unknown>) => { setBusy(true); try { await what(); } finally { setBusy(false); } };
  const folders = foldersOf(docs, elements, shell.emptyFolders);
  const kinds = creatables(KIND_SUMMARY);

  const startRename = (e: El) => { if (canEdit && e.managed) setRenaming(e.key); };
  const rename = (e: El, name: string) => { setRenaming(null); if (name.trim() && name.trim() !== e.name) void run(() => renameElement(ctx, e, name)); };
  const remove = async (e: El) => {
    const what = e.pcb ? `“${e.name}”, its schematic, board, libraries and their history are` : `“${e.name}” and its history are`;
    if (!(await askConfirm(`Delete ${e.name}?`, `${what} deleted for everyone in this project.`, { ok: "Delete", danger: true }))) return;
    deleteElement(ctx, e);
  };
  const makeFolder = async (then?: (path: string) => void) => {
    const name = await askName("New folder", { label: "Folder name", ok: "Create", check: nameProblem });
    if (!name) return;
    const path = newFolder(ctx, "", name, folders);
    if (path && then) then(path); else if (path) { toast(`Made the folder ${path}. It is on the Home tab.`); }
  };
  const tabMenu = (e: El, at: MenuAt) => {
    const items: MenuEntry[] = [{ id: "open", label: "Open", icon: "open", run: () => openElement(e) }];
    if (canEdit) items.push(
      { id: "rename", label: "Rename", icon: "edit", disabled: !e.managed, hint: e.managed ? "F2, or double-click the tab" : "This PCB is the project's own KiCad files", run: () => startRename(e) },
      { id: "duplicate", label: "Duplicate", icon: "copy", disabled: !e.managed, run: () => void run(() => duplicateElement(ctx, e)) },
      { id: "move", label: "Move to folder…", icon: "file", disabled: !e.managed, run: () => setMenu({ at, title: `Move ${e.name} to`, items: folderMenu(folders.filter((f) => !e.pcb || (f !== e.pcb.dir && !f.startsWith(e.pcb.dir + "/"))), e.folder, (f) => void run(() => moveElement(ctx, e, f)), () => void makeFolder((p) => void run(() => moveElement(ctx, e, p)))) }) },
    );
    items.push({ id: "link", label: "Copy link", icon: "link", run: () => { void navigator.clipboard?.writeText(`${location.origin}/p/${ctx.projectId}/edit?doc=${e.pcb ? (e.pcb.schematic || e.pcb.boards[0] || { docId: e.key }).docId : e.key}`).then(() => toast("Link copied")); } });
    if (canEdit) items.push("-", { id: "delete", label: "Delete…", icon: "trash", danger: true, disabled: !e.managed, run: () => void remove(e) });
    setMenu({ at, items, title: e.name });
  };
  const bringIn = (files: IncomingFile[]) => {
    if (!files.length) return;
    // onto the bar: KiCad files join the PCB that is open, anything else goes to the project
    const pcb = activeEl && activeEl.pcb && files.every((f) => !/\.kicad_pro$/i.test(f.path)) && files.some((f) => /\.(kicad_sch|kicad_pcb|kicad_sym|kicad_mod|kicad_dru|kicad_wks)$/i.test(f.path)) ? activeEl.pcb : null;
    void run(() => importFiles(ctx, files, pcb ? pcb.dir : "", !!pcb, setNote));
  };
  const filesIn = (ev: React.DragEvent) => Array.from(ev.dataTransfer.items || []).some((i) => i.kind === "file");

  // ---- drag a tab to reorder it (pointer events: the same on a mouse, a pen and a finger)
  const beginDrag = (e: El, ev: React.PointerEvent) => {
    if (!canEdit || ev.button !== 0 || renaming) return;
    const x0 = ev.clientX; let moved = false;
    const where = (x: number): string | null => {
      const tabs = Array.from(scroller.current?.querySelectorAll<HTMLElement>("[data-el-tab]") || []);
      for (const t of tabs) { const r = t.getBoundingClientRect(); if (x < r.left + r.width / 2) return t.dataset.elTab!; }
      return null;
    };
    const move = (m: PointerEvent) => {
      if (!moved && Math.abs(m.clientX - x0) < 6) return;
      moved = true; setThumb(null); window.clearTimeout(thumbTimer.current);
      const el = scroller.current;
      if (el) { const b = el.getBoundingClientRect(); if (m.clientX < b.left + 24) el.scrollLeft -= 12; else if (m.clientX > b.right - 24) el.scrollLeft += 12; }
      setDrag({ key: e.key, before: where(m.clientX), x: m.clientX });
    };
    const up = (m: PointerEvent) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
      setDrag(null);
      if (!moved || m.type === "pointercancel") return;
      suppressClick.current = true; window.setTimeout(() => { suppressClick.current = false; }, 0);
      const changes = moveTabChanges(elements, shell.items, e.key, where(m.clientX));
      if (changes.length && ctx.shell) ctx.shell.commit(changes);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
  };
  const marker = (key: string | null): boolean => !!drag && drag.before === key && drag.key !== key;

  const hover = (docId: string | undefined, ev: React.PointerEvent) => {
    if (!docId || drag) return;
    const r = ev.currentTarget.getBoundingClientRect();
    window.clearTimeout(thumbTimer.current);
    thumbTimer.current = window.setTimeout(() => setThumb({ docId, x: r.left, y: r.top, v: Math.floor(Date.now() / 30000) }), 350);
  };
  const unhover = () => { window.clearTimeout(thumbTimer.current); setThumb(null); };

  // ---- a PCB's views, inside its tab
  const pcbViews = (e: El) => {
    const pcb = e.pcb!;
    const here = activeEl === e ? pcbViewOf(pcb, current) : null;
    const seg = (id: string, docType: string, label: string, on: boolean, title: string, people: RoomMember[], thumbDoc?: string) => (
      <div key={id} role="tab" tabIndex={0} aria-selected={on} data-doc-tab={id} data-doc-type={docType} data-pcb-view={docType === "kicad_sch" ? "schematic" : docType === "kicad_pcb" ? "board" : "bom"} title={title}
        className={cx("flex items-center gap-1 px-2 h-5 rounded-xs cursor-default", on ? "bg-accent text-on-accent font-medium" : "text-ink-2 hover:bg-sel-soft hover:text-ink")}
        onClick={(ev) => { ev.stopPropagation(); unhover(); if (id !== current) dispatch({ type: "openDoc", docId: id }); }}
        onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); dispatch({ type: "openDoc", docId: id }); } }}
        onPointerDown={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}
        onPointerEnter={(ev) => hover(thumbDoc, ev)} onPointerLeave={unhover}>
        <span className="truncate">{label}</span>
        <TabPeople people={people} />
      </div>
    );
    const sheetIds = pcb.sheets.map((d) => d.docId);
    const onSheet = here === "schematic";
    const act = (action: string, label: string, title: string) => (
      <button type="button" key={action} data-pcb-action={action} title={title} className="appearance-none border-0 bg-transparent p-0 m-0 px-1.5 h-5 rounded-xs text-ink-3 hover:bg-sel-soft hover:text-ink"
        onPointerDown={(ev) => ev.stopPropagation()}
        onClick={(ev) => { ev.stopPropagation(); const b = pcb.boards[0]; if (!b) return; if (current === b.docId) dispatch({ type: "action", id: action }); else { setAfter({ docId: b.docId, action }); dispatch({ type: "openDoc", docId: b.docId }); } }}>{label}</button>
    );
    return (
      <span className="flex flex-none items-center gap-0.5 ml-1 pl-1.5 border-l border-line" role="tablist" aria-label={`Views of ${e.name}`} data-pcb-views={e.key}>
        {pcb.schematic ? seg(onSheet && current ? current : pcb.schematic.docId, "kicad_sch", "Schematic", onSheet, pcb.sheets.length > 1 ? `The schematic of ${e.name} (${pcb.sheets.length} sheets)` : `The schematic of ${e.name}`, peopleOn(sheetIds), pcb.schematic.docId) : null}
        {pcb.schematic && pcb.sheets.length > 1 ? (
          <button type="button" data-pcb-sheets title="Go to a sheet" aria-label="Sheets" aria-haspopup="menu" className="appearance-none border-0 bg-transparent p-0 m-0 w-4 h-5 -ml-0.5 grid place-items-center rounded-xs text-ink-3 hover:bg-sel-soft hover:text-ink"
            onPointerDown={(ev) => ev.stopPropagation()}
            onClick={(ev) => { ev.stopPropagation(); const r = ev.currentTarget.getBoundingClientRect(); setMenu({ at: { x: r.left, y: r.top - 4, top: r.top }, title: "Sheets", items: pcb.sheets.map((d, i): MenuEntry => ({ id: d.docId, label: i === 0 ? `${baseOf(d.path).replace(/\.kicad_sch$/, "")} (root sheet)` : relativePath(pcb.dir, d.path).replace(/\.kicad_sch$/, ""), icon: d.docId === current ? "check" : "file", run: () => dispatch({ type: "openDoc", docId: d.docId }) })) }); }}>
            <Glyph svg='<path d="M7 14l5-5 5 5"/>' size={11} />
          </button>
        ) : null}
        {pcb.boards.map((b, i) => seg(b.docId, "kicad_pcb", pcb.boards.length > 1 ? baseOf(b.path).replace(/\.kicad_pcb$/, "") : "Board", current === b.docId, `The board of ${e.name}`, peopleOn([b.docId]), b.docId))}
        {pcb.schematic ? seg(bomTabId(pcb), "bom", "BOM", here === "bom", `The bill of materials of ${e.name}`, peopleOn([bomTabId(pcb)])) : null}
        {pcb.boards.length && activeEl === e ? <>{act("show3DViewer", "3D", "The board in 3D")}{act("plot", "Outputs", "Fabrication outputs: Gerbers, drill files, placement")}</> : null}
      </span>
    );
  };

  // ---- the tabs, with the ones of a folder together behind the folder's name
  const groups: { folder: string; els: El[] }[] = [];
  for (const e of elements) {
    const g = e.folder ? groups.find((x) => x.folder === e.folder) : undefined;
    if (g) g.els.push(e); else groups.push({ folder: e.folder, els: [e] });
  }
  const toggleFold = (folder: string) => {
    const next = new Set(folded); if (next.has(folder)) next.delete(folder); else next.add(folder);
    setFolded(next); try { localStorage.setItem(COLLAPSED(ctx.projectId), JSON.stringify(Array.from(next))); } catch (e) { /* private window */ }
  };

  const tab = (e: El) => {
    const on = activeEl === e;
    const expanded = !!e.pcb && (on || pcbCount === 1);
    const tint = e.tint ? TINT[e.tint] : "";
    const thumbDoc = e.pcb ? (e.pcb.boards[0] || e.pcb.schematic)?.docId : e.key;
    return (
      <div key={e.key} className="relative flex flex-none items-stretch">
        {marker(e.key) ? <i className="absolute left-0 top-0.5 bottom-0.5 w-0.5 -ml-px bg-blue z-10" data-tab-drop /> : null}
        <div role="tab" aria-selected={on} tabIndex={0} data-el-tab={e.key} data-doc-tab={e.key} data-doc-type={e.type} data-tab-name={e.name} title={e.pcb ? (e.pcb.dir ? `${e.title} · ${e.pcb.dir}` : `${e.title} · the project's KiCad files`) : `${e.title} · ${e.doc!.path}`}
          className={cx("flex flex-none items-center gap-1.5 pl-2.5 pr-2.5 border-r border-line cursor-default touch-none", !expanded && "max-w-56", on ? "bg-paper text-ink" : "text-ink-2 hover:bg-paper hover:text-ink", drag && drag.key === e.key && "opacity-50")}
          style={on ? { boxShadow: `inset 0 2px 0 ${e.tint ? TINT_BAR[e.tint] : "var(--blue)"}` } : undefined}
          onClick={() => {
            unhover();
            if (suppressClick.current || on) return;
            // Opening another PCB than the one the editor is on loads the page again (pcbscope.ts): wait a
            // moment for that one, so a double-click renames the tab instead of leaving the page under it.
            window.clearTimeout(openTimer.current);
            if (e.pcb && boundKey && boundKey !== e.key && canEdit && e.managed) openTimer.current = window.setTimeout(() => openElement(e), 260);
            else openElement(e);
          }}
          onKeyDown={(ev) => {
            if (ev.target !== ev.currentTarget) return;
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openElement(e); }
            else if (ev.key === "F2") startRename(e);
            else if (ev.key === "Delete" && canEdit && e.managed) void remove(e);
            else if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") { ev.preventDefault(); const all = Array.from(document.querySelectorAll<HTMLElement>("#doctabs [data-el-tab], #doctabs [data-doc-tab=home]")); const i = all.indexOf(ev.currentTarget); all[(i + (ev.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]?.focus(); }
            else if (ev.key === "ContextMenu" || (ev.key === "F10" && ev.shiftKey)) { ev.preventDefault(); const r = ev.currentTarget.getBoundingClientRect(); tabMenu(e, { x: r.left, y: r.top - 4, top: r.top }); }
          }}
          onDoubleClick={() => { window.clearTimeout(openTimer.current); startRename(e); }}
          onContextMenu={(ev) => { ev.preventDefault(); const r = ev.currentTarget.getBoundingClientRect(); tabMenu(e, { x: ev.clientX, y: r.top - 4, top: r.top }); }}
          onPointerDown={(ev) => beginDrag(e, ev)}
          onPointerEnter={(ev) => hover(thumbDoc, ev)} onPointerLeave={unhover}>
          <Glyph svg={e.icon} className={tint} />
          {renaming === e.key
            ? <input autoFocus className="input h-5 w-36" defaultValue={e.name} aria-label="Document name" maxLength={80} onClick={(ev) => ev.stopPropagation()} onPointerDown={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}
                onFocus={(ev) => ev.target.select()}
                onBlur={(ev) => rename(e, ev.target.value)}
                onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); if (ev.key === "Escape") setRenaming(null); }} />
            : <span className={cx("truncate", on && "font-medium")} data-tab-label>{e.name}</span>}
          {expanded ? pcbViews(e) : <TabPeople people={peopleOnElement(e)} />}
        </div>
      </div>
    );
  };

  const arrow = (dir: -1 | 1, more: boolean) => overflow.any ? (
    <button type="button" tabIndex={-1} aria-hidden="true" data-tab-scroll={dir} disabled={!more} title={dir < 0 ? "Earlier tabs" : "More tabs"}
      className={cx("appearance-none border-0 bg-transparent p-0 m-0 flex-none w-5 grid place-items-center border-solid border-line", more ? "text-ink-2 hover:bg-paper hover:text-ink" : "text-ink-3 opacity-40", dir < 0 ? "border-r" : "border-l")}
      onClick={() => { const el = scroller.current; if (el) el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.6), behavior: "smooth" }); }}>
      <Glyph svg={dir < 0 ? '<path d="M14 7l-5 5 5 5"/>' : '<path d="M10 7l5 5-5 5"/>'} size={13} />
    </button>
  ) : null;

  return (
    <div id="doctabs" className={cx("flex items-stretch h-8 min-w-0 bg-bench border-t border-line text-sm select-none", dropping && "outline outline-2 -outline-offset-2 outline-blue")} role="tablist" aria-label="Tabs of this project" aria-busy={busy || undefined}
      onDragOver={(ev) => { if (!canEdit || !filesIn(ev)) return; ev.preventDefault(); ev.dataTransfer.dropEffect = "copy"; setDropping(true); }}
      onDragLeave={() => setDropping(false)}
      onDrop={(ev) => { if (!canEdit || !ev.dataTransfer.files.length) return; ev.preventDefault(); setDropping(false); bringIn(Array.from(ev.dataTransfer.files).map((file) => ({ path: file.name, file }))); }}>
      <button ref={list} type="button" className={cx("appearance-none border-0 bg-transparent p-0 m-0 flex-none w-8 grid place-items-center border-r border-line hover:bg-paper hover:text-ink", manager ? "bg-paper text-ink" : "text-ink-2")} title="All tabs (Alt+L)" aria-label="All tabs" aria-haspopup="dialog" aria-expanded={manager} data-tab-manager
        onClick={() => setManager(!manager)}>
        <Glyph svg='<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11"/><circle cx="4.8" cy="6.5" r=".8"/><circle cx="4.8" cy="12" r=".8"/><circle cx="4.8" cy="17.5" r=".8"/>' />
      </button>
      {canEdit ? (
        <button ref={plus} type="button" className={cx("appearance-none border-0 bg-transparent p-0 m-0 flex-none w-8 grid place-items-center border-r border-line hover:bg-paper hover:text-ink", adding ? "bg-paper text-ink" : "text-ink-2")} title="Add a PCB, a part studio, an assembly, a folder or a file" aria-label="Add to this project" aria-haspopup="menu" aria-expanded={!!adding} data-doc-add
          onClick={() => { const r = plus.current!.getBoundingClientRect(); setAdding(adding ? null : { x: r.left, y: r.top }); }}>
          <Glyph svg='<path d="M12 5v14"/><path d="M5 12h14"/>' />
        </button>
      ) : null}
      <div role="tab" aria-selected={onHome} tabIndex={0} data-doc-tab={HOME_TAB} data-doc-type="home" title="Home: everything in this project"
        className={cx("flex flex-none items-center gap-1.5 px-3 border-r border-line cursor-default", onHome ? "bg-paper text-ink shadow-[inset_0_2px_0_var(--color-blue)]" : "text-ink-2 hover:bg-paper hover:text-ink")}
        onClick={() => { if (!onHome) dispatch({ type: "openDoc", docId: HOME_TAB }); }}
        onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); dispatch({ type: "openDoc", docId: HOME_TAB }); } }}>
        <Glyph svg={HOME_ICON} />
        <span className={cx("truncate", onHome && "font-medium")}>Home</span>
        <TabPeople people={peopleOn([HOME_TAB])} />
      </div>
      {arrow(-1, overflow.left)}
      <div ref={scroller} className="flex items-stretch min-w-0 overflow-x-auto [scrollbar-width:none]" onScroll={measure} data-tab-strip>
        {groups.map((g) => g.folder ? (
          <div key={"g:" + g.folder} className="flex flex-none items-stretch" data-tab-folder={g.folder}>
            <button type="button" className="appearance-none border-0 bg-transparent p-0 m-0 flex flex-none items-center gap-1 pl-2 pr-1.5 border-r border-line text-ink-3 hover:bg-paper hover:text-ink" title={`${g.folder}: ${g.els.length} ${g.els.length === 1 ? "tab" : "tabs"}. Click to ${folded.has(g.folder) ? "show" : "fold"} them`} aria-expanded={!folded.has(g.folder)}
              onClick={() => toggleFold(g.folder)}>
              <Glyph svg={FOLDER_ICON} size={13} />
              <span className="truncate max-w-28 text-xs">{baseOf(g.folder)}</span>
              {folded.has(g.folder) ? <span className="font-mono text-2xs">{g.els.length}</span> : null}
            </button>
            {folded.has(g.folder) && !g.els.includes(activeEl as El) ? null : g.els.filter((e) => !folded.has(g.folder) || e === activeEl).map(tab)}
          </div>
        ) : g.els.map(tab))}
        {drag && drag.before === null ? <i className="flex-none w-0.5 my-0.5 bg-blue" data-tab-drop /> : null}
      </div>
      {arrow(1, overflow.right)}
      {note ? <span className="flex flex-none items-center px-3 text-ink-2 truncate max-w-[40%]" role="status" data-doc-upload>{note}</span> : null}
      {notice ? <span className="flex flex-none items-center px-3 text-ink-2 truncate max-w-[40%]" role="status" data-docs-notice>{notice}</span> : null}
      {thumb && !menu && !renaming && !adding && !manager && !drag ? (
        <div className="fixed z-[55] p-1 rounded-md border border-line bg-panel shadow-panel pointer-events-none" data-doc-thumb={thumb.docId} style={{ left: Math.min(thumb.x, window.innerWidth - 260), bottom: window.innerHeight - thumb.y + 4 }}>
          <img className="block w-60 h-auto rounded-sm bg-paper" alt="" src={`/api/docs/${thumb.docId}/preview.svg?v=${thumb.v}`} onError={() => setThumb(null)} />
        </div>
      ) : null}
      {menu ? <Menu items={menu.items} at={menu.at} title={menu.title} onClose={() => setMenu(null)} /> : null}
      {adding ? (
        <AddMenu at={adding} onClose={() => setAdding(null)}
          kinds={kinds.map((k) => ({ key: k.type, label: k.type === PCB_ELEMENT.type ? "New PCB" : `New ${k.title.toLowerCase()}`, icon: k.icon, tint: k.tint as ElementTint | undefined, hint: k.summary, run: () => void run(() => createElement(ctx, k.type)) }))}
          onFolder={() => void makeFolder()}
          onImport={() => void pickFiles("", true).then(bringIn)}
          onImportFolder={() => void pickFiles("", true, true).then(bringIn)} />
      ) : null}
      {manager ? (
        <TabManager anchor={list.current} elements={elements} current={onHome ? HOME_TAB : activeEl ? activeEl.key : null} people={(e) => (e ? peopleOnElement(e) : peopleOn([HOME_TAB]))}
          onOpen={(e) => { setManager(false); if (e) openElement(e); else dispatch({ type: "openDoc", docId: HOME_TAB }); }} onClose={() => setManager(false)} />
      ) : null}
    </div>
  );
}

/** What "+" offers: each kind of element with a line on what it is, then a folder and files. */
function AddMenu({ at, kinds, onFolder, onImport, onImportFolder, onClose }: {
  at: { x: number; y: number };
  kinds: { key: string; label: string; icon: string; tint?: ElementTint; hint: string; run: () => void }[];
  onFolder: () => void; onImport: () => void; onImportFolder: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    const away = (ev: PointerEvent) => { if (!el.contains(ev.target as Node) && !(ev.target as HTMLElement).closest?.("[data-doc-add]")) onClose(); };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") { ev.stopPropagation(); onClose(); return; }
      if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
      ev.preventDefault();
      const f = Array.from(el.querySelectorAll<HTMLElement>("button")); const i = f.indexOf(document.activeElement as HTMLElement);
      f[(i + (ev.key === "ArrowDown" ? 1 : f.length - 1)) % f.length]?.focus();
    };
    window.addEventListener("pointerdown", away); window.addEventListener("blur", onClose); document.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("blur", onClose); document.removeEventListener("keydown", key, true); };
  }, []);
  const row = (key: string, label: string, icon: string, hint: string, run: () => void, tint?: ElementTint) => (
    <button type="button" key={key} role="menuitem" data-add={key} className="appearance-none border-0 bg-transparent p-0 m-0 flex items-center gap-2.5 w-full text-left px-2.5 py-1.5 rounded-sm hover:bg-sel-soft focus:bg-sel-soft outline-none"
      onClick={() => { onClose(); run(); }}>
      <Glyph svg={icon} size={18} className={tint ? TINT[tint] : "text-ink-2"} />
      <span className="flex flex-col min-w-0"><span className="text-ink">{label}</span>{hint ? <span className="text-xs text-ink-3 truncate">{hint}</span> : null}</span>
    </button>
  );
  return (
    <div ref={ref} className="fixed z-[60] w-80 max-w-[calc(100vw-16px)] p-1 rounded-md border border-line bg-panel shadow-panel text-base text-ink" role="menu" aria-label="Add to this project" style={{ left: Math.min(at.x, window.innerWidth - 328), bottom: window.innerHeight - at.y + 2 }}>
      {kinds.map((k) => row(k.key, k.label, k.icon, k.hint, k.run, k.tint))}
      <div className="h-px my-1 bg-line" />
      {row("folder", "New folder…", FOLDER_ICON, "Keep related tabs and files together.", onFolder)}
      {row("import", "Import files…", '<path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9M5 19.5h14"/>', "A STEP file, KiCad files, libraries, 3D models.", onImport)}
      {row("import-folder", "Import a folder…", '<path d="M3 7a1 1 0 011-1h5l2 2h8a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1z"/><path d="M12 16v-5M9.5 13l2.5-2.5 2.5 2.5"/>', "A KiCad project folder becomes a PCB.", onImportFolder)}
    </div>
  );
}

/** The tab manager: every tab of the project in one searchable list, by folder.  Type, then Enter opens the first. */
function TabManager({ anchor, elements, current, people, onOpen, onClose }: {
  anchor: HTMLElement | null; elements: El[]; current: string | null;
  people: (e: El | null) => RoomMember[]; onOpen: (e: El | null) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => {
    const hit = (s: string) => !needle || s.toLowerCase().includes(needle);
    const out: { e: El | null; folder: string }[] = [];
    if (hit("home")) out.push({ e: null, folder: "" });
    for (const e of elements) if (hit(e.name) || hit(e.title) || hit(e.folder)) out.push({ e, folder: e.folder });
    return out.sort((a, b) => Number(!!a.e) - Number(!!b.e) || a.folder.localeCompare(b.folder, undefined, { numeric: true }));
  }, [elements, needle]);
  useEffect(() => { setAt(0); }, [needle]);
  useEffect(() => {
    const el = ref.current!;
    const away = (ev: PointerEvent) => { if (!el.contains(ev.target as Node) && !(ev.target as HTMLElement).closest?.("[data-tab-manager]")) onClose(); };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, []);
  useEffect(() => { ref.current?.querySelector<HTMLElement>(`[data-row="${at}"]`)?.scrollIntoView({ block: "nearest" }); }, [at]);
  const r = anchor ? anchor.getBoundingClientRect() : { left: 0, top: window.innerHeight - 32 };
  let lastFolder = "\u0000";
  return (
    <div ref={ref} role="dialog" aria-label="All tabs" data-tab-list className="fixed z-[60] flex flex-col w-[22rem] max-w-[calc(100vw-16px)] max-h-[min(70vh,34rem)] rounded-md border border-line bg-panel shadow-panel text-base text-ink"
      style={{ left: Math.max(8, r.left), bottom: window.innerHeight - r.top + 2 }}
      onKeyDown={(ev) => {
        if (ev.key === "Escape") { ev.stopPropagation(); onClose(); }
        else if (ev.key === "ArrowDown") { ev.preventDefault(); setAt((i) => Math.min(rows.length - 1, i + 1)); }
        else if (ev.key === "ArrowUp") { ev.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
        else if (ev.key === "Enter" && rows[at]) { ev.preventDefault(); onOpen(rows[at].e); }
      }}>
      <div className="p-2 border-b border-line">
        <input autoFocus className="input w-full" type="search" placeholder={`Search ${elements.length + 1} tabs`} aria-label="Search tabs" value={q} onChange={(ev) => setQ(ev.target.value)} />
      </div>
      <div className="overflow-y-auto p-1" role="listbox" aria-label="Tabs">
        {rows.length ? rows.map((row, i) => {
          const e = row.e, head = row.folder !== lastFolder && !!row.folder; lastFolder = row.folder;
          return (
            <div key={e ? e.key : "home"}>
              {head ? <div className="flex items-center gap-1.5 px-2 pt-2 pb-0.5 text-2xs uppercase font-mono text-ink-3"><Glyph svg={FOLDER_ICON} size={12} />{row.folder}</div> : null}
              <button type="button" role="option" aria-selected={(e ? e.key : HOME_TAB) === current} data-row={i} data-list-tab={e ? e.key : HOME_TAB}
                className={cx("appearance-none border-0 bg-transparent p-0 m-0 flex items-center gap-2 w-full text-left px-2 h-7 rounded-sm outline-none", i === at ? "bg-sel-soft" : "hover:bg-sel-soft", (e ? e.key : HOME_TAB) === current && "font-medium")}
                onPointerEnter={() => setAt(i)} onClick={() => onOpen(e)}>
                <Glyph svg={e ? e.icon : HOME_ICON} className={e && e.tint ? TINT[e.tint] : "text-ink-2"} />
                <span className="truncate flex-1">{e ? e.name : "Home"}</span>
                <TabPeople people={people(e)} />
                <span className="flex-none text-xs text-ink-3">{e ? e.title : "Files"}</span>
              </button>
            </div>
          );
        }) : <div className="empty px-2 py-4">No tab is called that.</div>}
      </div>
    </div>
  );
}
