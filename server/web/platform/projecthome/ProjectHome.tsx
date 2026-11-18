// ProjectHome.tsx — the Home tab of an open project: everything the project holds, in one place.
//
//   · what you can make (a PCB, a part studio, an assembly), large while the project is empty and a row of
//     buttons afterwards;
//   · the file tree: every element and every file in its folder, with its kind, picture, when it last changed and
//     who changed it.  A PCB opens to show its own files (sheets, board, libraries);
//   · search, sort, new folder, import; drag a row onto a folder to move it; drop files to import them
//     (a STEP file becomes a part studio, KiCad files become a PCB or join the one they are dropped on);
//   · who else is in the project, and on which tab.
//
// The rows are built by elements.ts treeRows (pure, tested); every action is one of actions.ts, the same ones the
// tab bar runs.  The shell opens this like any tab: it registers itself as the editor of the "@home" view
// (web/platform/documents/host.ts) and reads the project from the app's store, so it follows the list live.
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { KIND_SUMMARY, PCB_ELEMENT, documentKind, type ElementTint } from "../../domains/registry";
import { askConfirm } from "../../shared/components/msgbox";
import { dispatch, useApp, type DocEntry } from "../../shared/store";
import { cx } from "../../shared/util";
import { registerDocumentEditor } from "../documents/host";
import { Menu, ago, toast, type MenuAt, type MenuEntry } from "../home/ui";
import { filesFromDrop } from "../home/UploadDialog";
import {
  createElement, creatables, deleteElement, deleteFile, duplicateElement, duplicateFile, fileIsLoose, importFiles, moveElement, moveFile, newFolder,
  pickFiles, relocateFolder, removeFolder, renameElement, renameFile, type IncomingFile, type ShellContext,
} from "../doctabs/actions";
import { askName } from "../doctabs/askname";
import { fetchFiles, type ProjectFile } from "../doctabs/api";
import { Glyph, TabPeople, folderMenu } from "../doctabs/DocTabs";
import { FOLDER_ICON, elementOfTab, fileKind, foldersOf, nameProblem, pcbViewOf, treeRows, type ProjectElement, type TreeRow } from "../doctabs/elements";
import { baseOf, dirOf, inDir, pcbOfDoc, pcbsOf } from "../doctabs/pcbs";
import type { RoomMember } from "../doctabs/roomapi";
import { useProjectShell } from "../doctabs/useshell";

type El = ProjectElement<DocEntry>;
type Row = TreeRow<DocEntry>;
type Sort = "name" | "kind" | "modified";
const TINT: Record<ElementTint, string> = { wire: "text-wire", teal: "text-teal", copper: "text-copper", warn: "text-warn" };
const BTN0 = "appearance-none border-0 bg-transparent p-0 m-0 ";
const size = (n: number | null | undefined): string => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB` : `${(n / 1048576).toFixed(1)} MB`);
const OPEN_KEY = (projectId: string): string => "kui.home.open." + projectId;

/** Where somebody is, in words: "Home", "Motor driver · Board", "Lid". */
function whereabouts(m: RoomMember, elements: readonly El[]): string {
  if (!m.tab) return "in the project";
  if (m.tab === "home") return "Home";
  const e = elementOfTab(elements, m.tab);
  if (!e) return "in the project";
  const v = e.pcb ? pcbViewOf(e.pcb, m.tab) : null;
  return v ? `${e.name} · ${v === "bom" ? "BOM" : v === "board" ? "Board" : "Schematic"}` : e.name;
}

export function ProjectHome() {
  const shell = useProjectShell();
  const { projectId, name, docs, elements, room, canEdit, ctx, tick } = shell;
  const me = useApp((s) => s.me);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [desc, setDesc] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ at: MenuAt; items: MenuEntry[]; title?: string } | null>(null);
  const [files, setFiles] = useState<Map<string, ProjectFile>>(new Map());
  const [note, setNote] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);     // a row id, or "" for the whole page
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  // which folders and PCBs are open is this browser's own, per project; a small project starts with everything open
  useEffect(() => {
    if (!projectId) return;
    try { const saved = localStorage.getItem(OPEN_KEY(projectId)); if (saved) { setOpen(new Set(JSON.parse(saved) as string[])); return; } } catch (e) { /* private window */ }
    setOpen(new Set(foldersOf(docs, elements, shell.emptyFolders).map((f) => "folder:" + f)));
  }, [projectId]);
  const toggle = (id: string) => {
    const next = new Set(open); if (next.has(id)) next.delete(id); else next.add(id);
    setOpen(next); if (projectId) try { localStorage.setItem(OPEN_KEY(projectId), JSON.stringify(Array.from(next))); } catch (e) { /* private window */ }
  };

  // sizes, and when and by whom each file last changed: asked for when the tab opens and whenever the list was read again
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    fetchFiles(projectId).then((list) => { if (live) setFiles(new Map(list.map((f) => [f.docId, f]))); }).catch(() => {});
    return () => { live = false; };
  }, [projectId, tick, docs.length]);

  const modified = useMemo(() => new Map(Array.from(files.values()).map((f) => [f.docId, f.updatedAt ? Date.parse(f.updatedAt) : 0])), [files]);
  const rows = useMemo(() => treeRows(docs, elements, { open, filter: q, sort, desc, modified, emptyFolders: shell.emptyFolders }), [docs, elements, open, q, sort, desc, modified, shell.emptyFolders]);
  const folders = useMemo(() => foldersOf(docs, elements, shell.emptyFolders), [docs, elements, shell.emptyFolders]);
  const pcbs = useMemo(() => pcbsOf(docs, name), [docs, name]);

  if (!projectId || !ctx) return null;
  const run = async (what: () => Promise<unknown>) => { setBusy(true); try { await what(); } finally { setBusy(false); } };
  const kinds = creatables(KIND_SUMMARY);
  const empty = elements.length === 0;
  const fileCount = docs.filter((d) => d.docType !== "project_shell").length;

  // ---- what a row is, and what can be done with it
  const latest = (r: Row): ProjectFile | undefined => {
    const ids = r.kind === "folder" ? docs.filter((d) => inDir(d.path, r.path)).map((d) => d.docId) : r.element && r.element.pcb ? r.element.pcb.docs.map((d) => d.docId) : r.doc ? [r.doc.docId] : [];
    let best: ProjectFile | undefined;
    for (const id of ids) { const f = files.get(id); if (f && f.updatedAt && (!best || f.updatedAt > best.updatedAt!)) best = f; }
    return best;
  };
  const bytesOf = (r: Row): number | null => {
    if (r.kind === "file" || (r.element && !r.element.pcb)) return files.get(r.doc!.docId)?.bytes ?? null;
    const list = r.kind === "folder" ? docs.filter((d) => inDir(d.path, r.path)) : r.element!.pcb!.docs;
    return list.length ? list.reduce((n, d) => n + (files.get(d.docId)?.bytes || 0), 0) : null;
  };
  const openRow = (r: Row) => {
    if (r.kind === "folder") { toggle(r.id); return; }
    if (r.element) { const e = r.element; dispatch({ type: "openDoc", docId: e.pcb ? (e.pcb.schematic || e.pcb.boards[0] || { docId: "bom:" + e.key }).docId : e.key }); return; }
    const d = r.doc!;
    if (d.docType === "kicad_sch" || d.docType === "kicad_pcb" || documentKind(d.docType)?.bundle) { dispatch({ type: "openDoc", docId: d.docId }); return; }
    toast(`${baseOf(d.path)} has no editor of its own here. Download it, or open the PCB it belongs to.`);
  };
  const canOpen = (r: Row): boolean => r.kind !== "file" || r.doc!.docType === "kicad_sch" || r.doc!.docType === "kicad_pcb";
  const manageable = (r: Row): boolean => canEdit && (r.kind === "folder" || (r.kind === "element" ? r.element!.managed : fileIsLoose(r.doc!)));
  const download = (d: DocEntry) => { const a = document.createElement("a"); a.href = `/api/docs/${d.docId}/content`; a.download = baseOf(d.path); document.body.append(a); a.click(); a.remove(); };
  const makeFolder = async (parent: string, then?: (path: string) => void) => {
    const n = await askName("New folder", { label: parent ? `Folder name (in ${parent})` : "Folder name", ok: "Create", check: nameProblem });
    if (!n) return;
    const path = newFolder(ctx, parent, n, folders);
    if (!path) return;
    if (parent) setOpen((o) => new Set(o).add("folder:" + parent));
    if (then) then(path);
  };
  const moveTo = (r: Row, folder: string) => run(async () => {
    if (r.kind === "folder") await relocateFolder(ctx, r.path, (folder ? folder + "/" : "") + baseOf(r.path));
    else if (r.element) await moveElement(ctx, r.element, folder);
    else await moveFile(ctx, r.doc!, folder);
    if (folder) setOpen((o) => new Set(o).add("folder:" + folder));
  });
  const rename = (r: Row, to: string) => {
    setRenaming(null);
    const n = to.trim(); if (!n || n === r.name) return;
    void run(async () => {
      if (r.kind === "folder") await relocateFolder(ctx, r.path, (dirOf(r.path) ? dirOf(r.path) + "/" : "") + n);
      else if (r.element) await renameElement(ctx, r.element, n);
      else await renameFile(ctx, r.doc!, n);
    });
  };
  const remove = async (r: Row) => {
    const inside = r.kind === "folder" ? docs.filter((d) => inDir(d.path, r.path)).length : 0;
    const what = r.kind === "folder" ? (inside ? `The folder “${r.name}” and the ${inside} ${inside === 1 ? "file" : "files"} in it, with their history, are` : `The folder “${r.name}” is`)
      : r.element && r.element.pcb ? `“${r.name}”, its schematic, board, libraries and their history are` : `“${r.name}” and its history are`;
    if (!(await askConfirm(`Delete ${r.name}?`, `${what} deleted for everyone in this project.`, { ok: "Delete", danger: true }))) return;
    if (r.kind === "folder") removeFolder(ctx, r.path); else if (r.element) deleteElement(ctx, r.element); else deleteFile(ctx, r.doc!);
  };
  const duplicate = (r: Row) => run(async () => { if (r.element) await duplicateElement(ctx, r.element); else if (r.doc) await duplicateFile(ctx, r.doc); });
  const rowMenu = (r: Row, at: MenuAt) => {
    const can = manageable(r), here = r.kind === "folder" ? dirOf(r.path) : r.path;
    const items: MenuEntry[] = [];
    if (r.kind === "folder") items.push({ id: "open", label: open.has(r.id) ? "Close" : "Open", icon: "open", run: () => toggle(r.id) });
    else items.push({ id: "open", label: "Open", icon: "open", disabled: !canOpen(r), run: () => openRow(r) });
    if (r.kind === "folder" && canEdit) items.push(
      ...kinds.map((k): MenuEntry => ({ id: "new:" + k.type, label: k.type === PCB_ELEMENT.type ? "New PCB here" : `New ${k.title.toLowerCase()} here`, icon: "plus", run: () => { setOpen((o) => new Set(o).add(r.id)); void run(() => createElement(ctx, k.type, r.path)); } })),
      { id: "newfolder", label: "New folder here…", icon: "plus", run: () => void makeFolder(r.path) }, "-");
    if (canEdit) items.push(
      { id: "rename", label: "Rename", icon: "edit", disabled: !can, hint: can ? "F2" : "It moves with the PCB it belongs to", run: () => setRenaming(r.id) },
      { id: "duplicate", label: "Duplicate", icon: "copy", disabled: r.kind === "folder" || !can, run: () => void duplicate(r) },
      { id: "move", label: "Move to folder…", icon: "file", disabled: !can, run: () => setMenu({ at, title: `Move ${r.name} to`, items: folderMenu(folders.filter((f) => r.kind !== "folder" || (f !== r.path && !inDir(f, r.path))), here, (f) => void moveTo(r, f), () => void makeFolder("", (p) => void moveTo(r, p))) }) },
    );
    if (r.doc) items.push({ id: "download", label: "Download", icon: "download", run: () => download(r.doc!) });
    if (r.element && r.element.pcb) items.push({ id: "zip", label: "Download the project (.zip)", icon: "download", run: () => { location.href = `/api/projects/${ctx.projectId}/archive`; } });
    if (r.kind !== "folder") items.push({ id: "link", label: "Copy link", icon: "link", disabled: !canOpen(r), run: () => { const id = r.element ? (r.element.pcb ? (r.element.pcb.schematic || r.element.pcb.boards[0] || { docId: r.element.key }).docId : r.element.key) : r.doc!.docId; void navigator.clipboard?.writeText(`${location.origin}/p/${ctx.projectId}/edit?doc=${id}`).then(() => toast("Link copied")); } });
    if (canEdit) items.push("-", { id: "delete", label: "Delete…", icon: "trash", danger: true, disabled: !can, run: () => void remove(r) });
    setMenu({ at, items, title: r.name });
  };

  // ---- files coming in: onto a folder or a PCB, or onto the page
  const bringIn = (list: IncomingFile[], onto: Row | null) => {
    if (!list.length) return;
    const pcb = onto && onto.element && onto.element.pcb && onto.element.pcb.dir ? onto.element.pcb : onto && onto.doc ? pcbOfDoc(pcbs, onto.doc.docId) : undefined;
    const into = pcb && pcb.dir ? pcb.dir : onto && onto.kind === "folder" ? onto.path : "";
    void run(() => importFiles(ctx, list, into, !!(pcb && pcb.dir), setNote));
  };
  const hasFiles = (ev: React.DragEvent) => Array.from(ev.dataTransfer.types || []).includes("Files");
  const dropRow = (ev: React.DragEvent): Row | null => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-row-id]");
    const r = el ? rows.find((x) => x.id === el.dataset.rowId) : undefined;
    return r && (r.kind === "folder" || (r.element && r.element.pcb && r.element.pcb.dir)) ? r : null;
  };

  // ---- drag a row onto a folder (or onto the list's own ground: the project) to move it there
  const beginDrag = (r: Row, ev: React.PointerEvent) => {
    if (ev.button !== 0 || !manageable(r) || renaming || (ev.target as HTMLElement).closest("button, input, a")) return;
    const x0 = ev.clientX, y0 = ev.clientY; let moved = false;
    const target = (x: number, y: number): string | null => {
      const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-row-id], [data-home-root]");
      if (!el) return null;
      if (el.dataset.homeRoot !== undefined) return "";
      const t = rows.find((row) => row.id === el.dataset.rowId);
      if (!t || t.id === r.id) return null;
      const folder = t.kind === "folder" ? t.path : t.path;   // onto a folder: into it; onto anything else: beside it
      if (r.kind === "folder" && (folder === r.path || inDir(folder, r.path))) return null;
      return folder;
    };
    const move = (m: PointerEvent) => {
      if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 6) return;
      moved = true; setDrag({ id: r.id, over: target(m.clientX, m.clientY) });
    };
    const up = (m: PointerEvent) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
      setDrag(null);
      if (!moved || m.type === "pointercancel") return;
      const to = target(m.clientX, m.clientY);
      const from = r.kind === "folder" ? dirOf(r.path) : r.path;
      if (to !== null && to !== from) void moveTo(r, to);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
  };

  const others = room.members;
  const header = (
    <header className="flex flex-wrap items-end gap-x-6 gap-y-3 px-6 pt-5 pb-4">
      <div className="min-w-0 flex-1">
        <h1 className="m-0 font-semibold text-ink truncate" style={{ fontSize: "var(--fs-xl)" }} data-home-title>{name}</h1>
        <p className="m-0 mt-0.5 text-ink-2" data-home-summary>
          {empty ? "This project is empty. Start with one of these." : `${elements.length} ${elements.length === 1 ? "tab" : "tabs"} · ${fileCount} ${fileCount === 1 ? "file" : "files"}`}
        </p>
      </div>
      <div className="flex flex-none items-center gap-2 min-h-7" data-home-people aria-label="People in this project">
        {others.length ? others.slice(0, 6).map((m) => (
          <span key={m.key} className="flex items-center gap-1.5 pl-1.5 pr-2 h-6 rounded-full border border-line bg-panel text-sm" data-home-person={m.login} title={`${m.name} is on ${whereabouts(m, elements)}`}>
            <i className="block w-2.5 h-2.5 rounded-full" style={{ background: m.color }} />
            <span className="text-ink">{m.name}</span>
            <span className="text-ink-3" data-home-where>{whereabouts(m, elements)}</span>
          </span>
        )) : <span className="text-ink-3 text-sm">{room.live ? (me ? "Only you are here" : "") : ""}</span>}
        {others.length > 6 ? <span className="text-ink-3 text-sm">+{others.length - 6}</span> : null}
      </div>
    </header>
  );

  const createCards = (
    <div className="grid gap-3 px-6 pb-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }} data-home-create="cards">
      {kinds.map((k) => (
        <button key={k.type} type="button" data-create={k.type} disabled={!canEdit || busy}
          className="appearance-none m-0 flex flex-col items-start gap-2 p-4 text-left rounded-md border border-solid border-line bg-panel hover:border-line-2 hover:bg-paper disabled:opacity-60"
          onClick={() => void run(() => createElement(ctx, k.type))}>
          <Glyph svg={k.icon} size={28} className={k.tint ? TINT[k.tint as ElementTint] : "text-ink-2"} />
          <span className="font-semibold text-ink" style={{ fontSize: "var(--fs-lg)" }}>{k.type === PCB_ELEMENT.type ? "New PCB" : `New ${k.title.toLowerCase()}`}</span>
          <span className="text-ink-2">{k.summary}</span>
        </button>
      ))}
    </div>
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 px-6 py-2 border-y border-line bg-bench" data-home-toolbar>
      {canEdit && !empty ? kinds.map((k) => (
        <button key={k.type} type="button" className="btn" data-create={k.type} disabled={busy} title={k.summary} onClick={() => void run(() => createElement(ctx, k.type))}>
          <Glyph svg={k.icon} className={k.tint ? TINT[k.tint as ElementTint] : ""} />{k.type === PCB_ELEMENT.type ? "New PCB" : `New ${k.title.toLowerCase()}`}
        </button>
      )) : null}
      {canEdit ? <button type="button" className="btn" data-home-newfolder onClick={() => void makeFolder("")}><Glyph svg={FOLDER_ICON} />New folder</button> : null}
      {canEdit ? <button type="button" className="btn" data-home-import title="A STEP file, KiCad files, libraries, 3D models" onClick={() => void pickFiles("", true).then((l) => bringIn(l, null))}><Glyph svg='<path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9M5 19.5h14"/>' />Import files</button> : null}
      {canEdit ? <button type="button" className="btn" data-home-import-folder title="A KiCad project folder becomes a PCB, with its sheets and libraries where they were" onClick={() => void pickFiles("", true, true).then((l) => bringIn(l, null))}><Glyph svg={FOLDER_ICON} />Import folder</button> : null}
      <span className="flex-1" />
      <input className="input" style={{ width: 220 }} type="search" placeholder="Search this project" aria-label="Search this project" value={q} onChange={(ev) => setQ(ev.target.value)} data-home-search />
      <label className="flex items-center gap-1.5 text-ink-2">Sort
        <select className="input" style={{ width: "auto" }} aria-label="Sort by" value={sort} onChange={(ev) => { const s = ev.target.value as Sort; setSort(s); setDesc(false); }} data-home-sort>
          <option value="name">Name</option><option value="kind">Kind</option><option value="modified">Last modified</option>
        </select>
      </label>
      <button type="button" className="btn" aria-label={desc ? "Reversed order" : "Usual order"} aria-pressed={desc} title="Reverse the order" onClick={() => setDesc(!desc)}>
        <Glyph svg={desc ? '<path d="M12 5v14M7 14l5 5 5-5"/>' : '<path d="M12 19V5M7 10l5-5 5 5"/>'} />
      </button>
    </div>
  );

  const rowView = (r: Row) => {
    const e = r.element, d = r.doc;
    const kind = r.kind === "folder" ? { title: "Folder", icon: FOLDER_ICON } : e ? { title: e.title, icon: e.icon } : fileKind(d!.docType, d!.path);
    const f = latest(r), by = f && f.updatedBy ? f.updatedBy.name || f.updatedBy.login : "";
    const thumbDoc = e ? (e.pcb ? e.pcb.boards.find((b) => b.hasPreview) || (e.pcb.schematic && e.pcb.schematic.hasPreview ? e.pcb.schematic : undefined) : e.doc && e.doc.hasPreview ? e.doc : undefined) : d && d.hasPreview ? d : undefined;
    const people: RoomMember[] = e ? room.members.filter((m) => m.tab && elementOfTab([e], m.tab) === e) : d ? room.members.filter((m) => m.tab === d.docId) : [];
    const on = sel === r.id, over = (drag && drag.over !== null && r.kind === "folder" && drag.over === r.path) || dropOn === r.id;
    return (
      <div key={r.id} role="row" aria-selected={on} tabIndex={0} data-row-id={r.id} data-row-kind={r.kind} data-row-name={r.name} data-row-type={e ? e.type : d ? d.docType : "folder"}
        className={cx("grid items-center gap-3 px-6 h-9 border-b border-line-soft cursor-default outline-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]",
          on ? "bg-sel" : "hover:bg-sel-soft", over && "outline outline-2 -outline-offset-2 outline-blue", drag && drag.id === r.id && "opacity-50")}
        style={{ gridTemplateColumns: "minmax(0, 1fr) 150px 120px 150px 80px 64px" }}
        onClick={() => setSel(r.id)}
        onDoubleClick={(ev) => { if (!(ev.target as HTMLElement).closest("input")) openRow(r); }}
        onContextMenu={(ev) => { ev.preventDefault(); setSel(r.id); rowMenu(r, { x: ev.clientX, y: ev.clientY }); }}
        onPointerDown={(ev) => beginDrag(r, ev)}
        onKeyDown={(ev) => {
          if (ev.target !== ev.currentTarget) return;
          if (ev.key === "Enter") { ev.preventDefault(); openRow(r); }
          else if (ev.key === "F2" && manageable(r)) setRenaming(r.id);
          else if (ev.key === "Delete" && manageable(r)) void remove(r);
          else if (ev.key === "ArrowRight" && r.expandable && !open.has(r.id)) toggle(r.id);
          else if (ev.key === "ArrowLeft" && r.expandable && open.has(r.id)) toggle(r.id);
          else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); const sib = ev.key === "ArrowDown" ? ev.currentTarget.nextElementSibling : ev.currentTarget.previousElementSibling; (sib as HTMLElement | null)?.focus(); }
        }}
        onFocus={() => setSel(r.id)}>
        <div role="gridcell" className="flex items-center gap-2 min-w-0" style={{ paddingLeft: r.depth * 20 }}>
          {r.expandable || r.kind === "folder"
            ? <button type="button" className={BTN0 + "flex-none w-4 h-4 grid place-items-center text-ink-3 hover:text-ink"} aria-label={open.has(r.id) ? "Close" : "Open"} aria-expanded={open.has(r.id)} data-row-toggle onClick={(ev) => { ev.stopPropagation(); toggle(r.id); }}>
                <Glyph svg={open.has(r.id) || !!q.trim() ? '<path d="M7 10l5 5 5-5"/>' : '<path d="M10 7l5 5-5 5"/>'} size={13} />
              </button>
            : <span className="flex-none w-4" />}
          {thumbDoc
            ? <img className="flex-none w-9 h-6 object-cover rounded-xs border border-line bg-paper" alt="" loading="lazy" src={`/api/docs/${thumbDoc.docId}/preview.svg`} data-row-thumb />
            : <span className="flex-none w-9 h-6 grid place-items-center rounded-xs border border-line-soft bg-panel"><Glyph svg={kind.icon} size={15} className={e && e.tint ? TINT[e.tint] : r.kind === "folder" ? "text-ink-2" : "text-ink-3"} /></span>}
          {renaming === r.id
            ? <input autoFocus className="input h-6" style={{ maxWidth: 320 }} defaultValue={r.kind === "file" ? baseOf(r.doc!.path) : r.name} aria-label="Name" maxLength={120}
                onFocus={(ev) => { const v = ev.target.value, dot = r.kind === "file" ? v.lastIndexOf(".") : -1; ev.target.setSelectionRange(0, dot > 0 ? dot : v.length); }}
                onClick={(ev) => ev.stopPropagation()} onPointerDown={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}
                onBlur={(ev) => rename(r, ev.target.value)}
                onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); if (ev.key === "Escape") setRenaming(null); }} />
            : <span className={cx("truncate", (e || r.kind === "folder") && "font-medium text-ink", r.kind === "file" && "text-ink")} data-row-label title={r.kind === "folder" ? r.path : d ? d.path : e && e.pcb ? e.pcb.dir : ""}>{r.name}</span>}
          {r.count !== undefined && r.kind !== "file" ? <span className="flex-none text-xs text-ink-3">{r.count} {r.count === 1 ? "file" : "files"}</span> : null}
          <TabPeople people={people} />
        </div>
        <div role="gridcell" className="truncate text-ink-2">{kind.title}</div>
        <div role="gridcell" className="truncate text-ink-2" title={f && f.updatedAt ? new Date(f.updatedAt).toLocaleString() : ""} data-row-modified>{f ? ago(f.updatedAt || undefined) : ""}</div>
        <div role="gridcell" className="truncate text-ink-2" data-row-by>{by}</div>
        <div role="gridcell" className="truncate text-right font-mono text-xs text-ink-3">{size(bytesOf(r))}</div>
        <div role="gridcell" className="flex items-center justify-end gap-1">
          {canOpen(r) && r.kind !== "folder" ? <button type="button" className="btn sm ghost" data-row-open title={`Open ${r.name}`} onClick={(ev) => { ev.stopPropagation(); openRow(r); }}>Open</button> : null}
          <button type="button" className={BTN0 + "w-6 h-6 grid place-items-center rounded-sm text-ink-2 hover:bg-paper hover:text-ink"} aria-label={`Actions for ${r.name}`} aria-haspopup="menu" data-row-menu
            onClick={(ev) => { ev.stopPropagation(); setSel(r.id); const b = ev.currentTarget.getBoundingClientRect(); rowMenu(r, { x: b.left, y: b.bottom + 2, right: b.right, top: b.top }); }}>
            <Glyph svg='<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>' />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className={cx("flex flex-col h-full min-h-0 bg-paper text-base text-ink", dropOn === "" && "outline outline-2 -outline-offset-4 outline-blue")} data-project-home aria-busy={busy || undefined}
      onDragOver={(ev) => { if (!canEdit || !hasFiles(ev)) return; ev.preventDefault(); ev.dataTransfer.dropEffect = "copy"; const r = dropRow(ev); setDropOn(r ? r.id : ""); }}
      onDragLeave={(ev) => { if (ev.currentTarget === ev.target) setDropOn(null); }}
      onDrop={(ev) => {
        if (!canEdit || !hasFiles(ev)) return;
        ev.preventDefault(); const onto = dropRow(ev); setDropOn(null);
        void filesFromDrop(ev.dataTransfer).then((list) => bringIn(list.map((f) => ({ path: f.path, file: f.file })), onto));
      }}>
      {header}
      {empty && canEdit ? createCards : null}
      {toolbar}
      {note ? <div className="px-6 py-1.5 border-b border-line bg-bench text-ink-2" role="status" data-home-upload>{note}</div> : null}
      <div className="grid items-center gap-3 px-6 h-7 border-b border-line bg-bench text-2xs uppercase font-mono text-ink-3 select-none" style={{ gridTemplateColumns: "minmax(0, 1fr) 150px 120px 150px 80px 64px" }} role="row">
        <span role="columnheader">Name</span><span role="columnheader">Kind</span><span role="columnheader">Modified</span><span role="columnheader">By</span><span role="columnheader" className="text-right">Size</span><span />
      </div>
      <div ref={body} className="flex-1 min-h-0 overflow-y-auto select-none" role="grid" aria-label="Everything in this project" data-home-rows data-home-root>
        {rows.map(rowView)}
        {!rows.length ? (
          <div className="px-6 py-10 text-center text-ink-2" data-home-empty>
            {q.trim() ? <>Nothing in this project is called “{q.trim()}”.</>
              : canEdit ? <>Nothing here yet. Make a PCB, a part studio or an assembly above, or drop files anywhere on this page:<br />a STEP file opens as a part studio, KiCad files become a PCB.</>
              : <>This project is empty.</>}
          </div>
        ) : canEdit && !q.trim() ? <div className="px-6 py-4 text-ink-3 text-sm">Drop files anywhere to import them. Drag a row onto a folder to move it there.</div> : null}
      </div>
      {menu ? <Menu items={menu.items} at={menu.at} title={menu.title} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

/** The shell opens Home like any tab: this is its editor (web/platform/documents/host.ts). */
export function registerProjectHome(): void {
  registerDocumentEditor({
    docTypes: ["@home"],
    open(host) {
      const el = document.createElement("div");
      el.style.cssText = "height:100%;min-height:0";
      host.el.replaceChildren(el);
      const root = createRoot(el);
      root.render(<ProjectHome />);
      host.setConnection("live", "");
      return { close() { root.unmount(); host.el.replaceChildren(); } };
    },
  });
}

export type { ShellContext };
