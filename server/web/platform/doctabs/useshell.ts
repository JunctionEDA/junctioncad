// useshell.ts — the open project as the shell's React parts see it: the tab bar (DocTabs.tsx), the tab manager
// and the Home tab (web/platform/projecthome) all read the project through `useProjectShell()` and act on it
// through the one `ShellContext` it returns (actions.ts).
//
// DocTabs owns the two live things, for as long as a project is open: the project's document (shell.ts: tab
// order, folders) and the project room (room.ts: who is on which tab).  It publishes them here, so the Home tab
// uses the same ones.
import { useMemo, useSyncExternalStore } from "react";
import { dispatch, useApp, type DocEntry } from "../../shared/store";
import { pendingDeletes, type ShellContext } from "./actions";
import { fetchDocs } from "./api";
import { elementsOf, emptyFoldersOf, orderedElements, SHELL_DOC_TYPE, type ProjectElement } from "./elements";
import { inDir } from "./pcbs";
import type { ProjectRoom } from "./room";
import type { RoomState } from "./roomapi";
import type { ProjectShell, ShellState } from "./shell";
import type { Item } from "../../shared/itemdoc/itemdoc";

interface Handles { shell: ProjectShell | null; room: ProjectRoom | null; tick: number }
let handles: Handles = { shell: null, room: null, tick: 0 };
const subs = new Set<() => void>();
const emit = (): void => { for (const fn of Array.from(subs)) fn(); };
export function setHandles(next: Partial<Handles>): void { handles = { ...handles, ...next }; emit(); }
const subscribe = (fn: () => void): (() => void) => { subs.add(fn); return () => { subs.delete(fn); }; };
const getHandles = (): Handles => handles;

const NO_ROOM: RoomState = { live: false, me: null, members: [] };
const NO_SHELL: ShellState = { items: [], live: false, version: 0 };
const never = () => () => {};

/** Read the project's list again and hand it to the app; `open` names the tab to open when it is there. */
export async function refreshProject(projectId: string, current: readonly DocEntry[], open?: string): Promise<void> {
  const docs = await fetchDocs(projectId);
  const same = !open && docs.length === current.length && docs.every((d, i) => d.docId === current[i].docId && d.path === current[i].path);
  if (!same) dispatch({ type: "projectDocs", docs, open });
  setHandles({ tick: handles.tick + 1 });
}

export interface ProjectShellView {
  projectId: string | null;
  name: string;
  /** every document of the project (not the ones being deleted) */
  docs: DocEntry[];
  /** the elements in tab order */
  elements: ProjectElement<DocEntry>[];
  /** the items of the project's document */
  items: Item[];
  emptyFolders: string[];
  room: RoomState;
  /** the tab that is open */
  current: string | null;
  canEdit: boolean;
  /** bumped whenever the list was read again */
  tick: number;
  ctx: ShellContext | null;
}

export function useProjectShell(): ProjectShellView {
  const project = useApp((s) => s.project);
  const current = useApp((s) => s.document.docId);
  const canEdit = useApp((s) => !!s.me && !s.viewOnly);
  const h = useSyncExternalStore(subscribe, getHandles);
  const shellState = useSyncExternalStore(h.shell ? h.shell.subscribe : never, () => (h.shell ? h.shell.getState() : NO_SHELL));
  const room = useSyncExternalStore(h.room ? h.room.subscribe : never, () => (h.room ? h.room.getState() : NO_ROOM));
  const hidden = useSyncExternalStore(pendingDeletes.subscribe, pendingDeletes.get);
  const all = project ? project.allDocs || project.docs : null;
  const projectId = project ? project.projectId : null, name = project ? project.name : "";

  const view = useMemo(() => {
    const raw = all || [];
    const whole = elementsOf(raw, name);
    // what is on its way out is not shown: a document, an element with all its documents, a folder with all of them
    const goneFolders = Array.from(hidden).filter((id) => id.startsWith("folder:")).map((id) => id.slice(7));
    const goneDocs = new Set<string>();
    for (const e of whole) if (hidden.has(e.key)) for (const d of e.pcb ? e.pcb.docs : [e.doc!]) goneDocs.add(d.docId);
    const docs = raw.filter((d) => !hidden.has(d.docId) && !goneDocs.has(d.docId) && !goneFolders.some((f) => inDir(d.path, f)));
    const elements = orderedElements(docs.length === raw.length ? whole : elementsOf(docs, name), shellState.items);
    const emptyFolders = emptyFoldersOf(shellState.items).map((f) => f.path).filter((p) => !goneFolders.some((f) => p === f || inDir(p, f)));
    return { docs, elements, emptyFolders };
  }, [all, name, hidden, shellState]);

  const ctx = useMemo<ShellContext | null>(() => (projectId && all ? {
    projectId, docs: view.docs, elements: view.elements, shell: h.shell, current,
    refresh: (open?: string) => refreshProject(projectId, all, open),
    openTab: (id: string) => dispatch({ type: "openDoc", docId: id }),
  } : null), [projectId, all, view, h.shell, current]);

  return { projectId, name, docs: view.docs, elements: view.elements, items: shellState.items, emptyFolders: view.emptyFolders, room, current, canEdit, tick: h.tick, ctx };
}

/** The project's own document in a list of documents, if it has one. */
export const shellDocOf = (docs: readonly DocEntry[]): DocEntry | undefined => docs.find((d) => d.docType === SHELL_DOC_TYPE);
