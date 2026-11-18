// pcbscope.ts — which PCB of the project this page's schematic and board editor works on, and the two things
// that keep it inside that PCB.  The rules are web/platform/doctabs/pcbs.ts; read that first.
//
//   1. THE LIST.  `state.project.docs` and `state.docs` hold the documents of the bound PCB only, with paths
//      relative to its folder (`viewOf`).  The editor's hundred lookups for "the project file", "the board",
//      "fp-lib-table" therefore cannot find another PCB's.  `state.project.allDocs` is the whole project, for
//      the shell: the tabs, the Home tab, a part studio that reads a board.
//   2. THE PATHS IT SENDS.  When the editor makes or moves a file (a new sheet, a library, a library table) it
//      names it as it sees it.  `installPathScope` wraps `fetch` for exactly two requests, POST
//      /api/projects/{id}/docs and PATCH /api/docs/{id}, and puts the PCB's folder in front of `path` on the
//      way out and takes it off the answer on the way back.  The shell's own requests carry project paths and go
//      through `rawFetch()`, which is the browser's.
//
// ONE PCB PER PAGE.  The editor keeps much about "the project" in module state (the project file's settings,
// the hierarchy it learned, net names, library caches), keyed by project at most.  Rather than trust every one of
// those to notice that the PCB under them changed, opening a different PCB of a project this page has already
// bound loads the page again at that document (`bindPcb` answers "reload").  Moving between the views of one
// PCB, and between a PCB and a part studio, an assembly or Home, stays in the page.
import { fullPath, pcbsOf, relativePath, scopedDocs, type Pcb } from "../../../platform/doctabs/pcbs";
import type { DocEntry } from "../../../shared/store";
import "../../../platform/documents/rawfetch";   // declares window.__junctionRawFetch

export interface BoundPcb { projectId: string; key: string; dir: string; name: string }

let bound: BoundPcb | null = null;
/** the PCB each project was first bound to on this page */
const first = new Map<string, string>();

/** projects whose bound PCB was renamed or moved under this page: what the editor remembers by path is out of date */
const stale = new Set<string>();

export function boundPcb(): BoundPcb | null { return bound; }

/** A project is being opened: nothing is bound until a PCB of it is. */
export function unbindPcb(): void { bound = null; }

/**
 * Work on `pcb` from now on.  "reload" when this page has already worked on another PCB of the project: the
 * caller loads the page again at the document it wanted, and nothing here changed.
 */
export function bindPcb(projectId: string, pcb: Pcb): "bound" | "same" | "reload" {
  if (stale.has(projectId)) return "reload";
  if (bound && bound.projectId === projectId && bound.key === pcb.key) { bound.dir = pcb.dir; bound.name = pcb.name; return "same"; }
  const was = first.get(projectId);
  if (was && was !== pcb.key) return "reload";
  first.set(projectId, pcb.key);
  bound = { projectId, key: pcb.key, dir: pcb.dir, name: pcb.name };
  return "bound";
}

/** The documents the editor may see, given the whole project: the bound PCB's, or with none bound the ones of no PCB. */
export function viewOf(all: DocEntry[], projectId: string, projectName: string): { docs: DocEntry[]; pcbs: Pcb<DocEntry>[]; pcb: Pcb<DocEntry> | null } {
  const pcbs = pcbsOf(all, projectName);
  const pcb = (bound && bound.projectId === projectId && pcbs.find((p) => p.key === bound!.key)) || null;
  // it was renamed or moved: the folder (and its own files' names) changed under the editor, which remembers
  // sheets by path.  The next time one of its documents is opened, the page loads again (bindPcb "reload").
  if (pcb && bound) { if (bound.dir !== pcb.dir) stale.add(projectId); bound.dir = pcb.dir; bound.name = pcb.name; }
  // a project that is one PCB at its root: the list itself, so what the editor adds to it the shell sees too
  if (pcb && !pcb.dir && pcbs.length === 1) return { docs: all, pcbs, pcb };
  return { docs: scopedDocs(all, pcbs, pcb), pcbs, pcb };
}

type RawFetch = typeof fetch;

/** `path` in a request body the editor wrote, as the project has it; null when it points outside the project. */
export function outgoingPath(dir: string, path: string): string | null { return dir ? fullPath(dir, path) : path; }
export function incomingPath(dir: string, path: string): string { return relativePath(dir, path); }

/** Wrap fetch once (see the top of this file). */
export function installPathScope(): void {
  if (typeof window === "undefined" || window.__junctionRawFetch) return;
  const raw: RawFetch = window.fetch.bind(window);
  window.__junctionRawFetch = raw;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const b = bound;
    if (!b || !b.dir || !init || typeof init.body !== "string") return raw(input, init);
    const method = (init.method || "GET").toUpperCase();
    if (method !== "POST" && method !== "PATCH") return raw(input, init);
    let pathname = "";
    try { pathname = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname; } catch (e) { return raw(input, init); }
    const creates = method === "POST" && pathname.replace(/\/$/, "") === `/api/projects/${b.projectId}/docs`;
    const moves = method === "PATCH" && /^\/api\/docs\/[0-9a-f-]{36}$/i.test(pathname);
    if (!creates && !moves) return raw(input, init);
    let body: { path?: unknown };
    try { body = JSON.parse(init.body); } catch (e) { return raw(input, init); }
    if (!body || typeof body.path !== "string") return raw(input, init);
    const full = outgoingPath(b.dir, body.path);
    if (full === null) return new Response("that path is outside the project", { status: 400, headers: { "content-type": "text/plain" } });
    const r = await raw(input, { ...init, body: JSON.stringify({ ...body, path: full }) });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return r;
    let answer: unknown;
    try { answer = await r.clone().json(); } catch (e) { return r; }
    if (!answer || typeof answer !== "object" || typeof (answer as { path?: unknown }).path !== "string") return r;
    const seen = { ...(answer as Record<string, unknown>), path: incomingPath(b.dir, (answer as { path: string }).path) };
    return new Response(JSON.stringify(seen), { status: r.status, statusText: r.statusText, headers: { "content-type": "application/json" } });
  }) as RawFetch;
}
