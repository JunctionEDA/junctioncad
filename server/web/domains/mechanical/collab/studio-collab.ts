// studio-collab.ts — the collaboration layer of an open part studio: presence (collab.ts), the edit guard
// (guard.ts) and the comment threads (comments.ts), made once per studio and shared by the panels, the tools
// and the feature rows that show them.
//
// The studio does not know this exists.  A panel acquires it when it mounts and releases it when it unmounts;
// the last release (the studio closing) disposes of everything.
import { toWorld, type Vec3 } from "../core/geometry";
import type { BodyMesh, SketchView } from "../kernel/protocol";
import type { PartStudio } from "../ui/studio";
import type { Pick } from "../viewport/modelview";
import { Collab, type LocalPresence } from "./collab";
import { CommentStore, type PinSources } from "./comments";
import { EditGuard } from "./guard";
import type { Collaborator, SelRef } from "./presence";

export interface StudioCollab {
  studio: PartStudio;
  collab: Collab;
  guard: EditGuard;
  comments: CommentStore;
  /** the meshes on screen, by body id (the studio's state drops a mesh the worker did not send again) */
  meshes: Map<string, { rev: number; createdBy: string; mesh: BodyMesh }>;
  pins: PinSources;
}

interface Entry { c: StudioCollab; refs: number; dispose(): void }
const open = new WeakMap<PartStudio, Entry>();

/** A pick as presence carries it; a reference plane, axis or point is not shown to others yet (null). */
export const selRef = (p: Pick): SelRef | null => (p.kind === "datum" ? null : p.kind === "plane" ? ["p", p.plane] : p.kind === "sketch" ? ["s", p.featureId, p.entity || "", p.region || ""] : [p.kind === "face" ? "f" : p.kind === "edge" ? "e" : "v", p.body, p.name]);

const watchers = new Set<() => void>();
const changed = (): void => { for (const fn of Array.from(watchers)) fn(); };
/** `fn` is called when a studio's collaboration layer is made or disposed of. */
export function subscribeOpen(fn: () => void): () => void { watchers.add(fn); return () => { watchers.delete(fn); }; }

/** The collaboration layer of a studio, when a panel has it open. */
export function studioCollab(studio: PartStudio): StudioCollab | null { return open.get(studio)?.c || null; }

/** Take the studio's collaboration layer (making it the first time).  Call `release` to give it back. */
export function acquireStudioCollab(studio: PartStudio): { c: StudioCollab; release(): void } {
  let entry = open.get(studio);
  if (!entry) { entry = make(studio); open.set(studio, entry); queueMicrotask(changed); }
  entry.refs++;
  const mine = entry;
  let released = false;
  return {
    c: entry.c,
    release() {
      if (released) return;
      released = true;
      // a moment's grace: React may unmount and mount a panel again in one pass
      setTimeout(() => { if (--mine.refs <= 0) { mine.dispose(); if (open.get(studio) === mine) open.delete(studio); changed(); } }, 0);
    },
  };
}

function make(studio: PartStudio): Entry {
  const meshes: StudioCollab["meshes"] = new Map();
  let sketches = new Map<string, SketchView>();
  let bodiesSeen: unknown = null, sketchesSeen: unknown = null;

  const local = (pointer: { clientX: number; clientY: number } | null): LocalPresence => {
    const s = studio.getState();
    let hit: Vec3 | null = s.hover && !studio.view.pointerTool ? s.hover.point : null;
    if (!hit && pointer && s.sketch) {
      // drawing in a sketch: the pointer is on the sketch's plane
      const frame = studio.view.sketchFrame(s.sketch.featureId);
      const p = frame ? studio.view.planePoint(pointer, frame) : null;
      if (frame && p) hit = toWorld(frame, p);
    }
    const name = (id: string) => s.features.find((f) => f.id === id)?.name;
    return {
      sel: s.selection.map(selRef).filter((r): r is SelRef => !!r),
      feat: s.selectedFeature,
      edit: s.editing ? { id: s.editing.draft.id, kind: "dialog", name: s.editing.draft.name, ...(s.editing.isNew ? { isNew: true } : {}) }
        : s.sketch ? { id: s.sketch.featureId, kind: "sketch", name: name(s.sketch.featureId) } : null,
      hit,
    };
  };

  const collab = new Collab({
    session: studio.session, viewport: studio.viewport, ctx: studio.host, local,
    subscribe: (fn) => studio.subscribe(fn),
    sources: {
      mesh: (id) => meshes.get(id)?.mesh || null,
      sketch: (id) => sketches.get(id) || null,
      editLabel: (p: Collaborator) => { const e = p.state.edit!; return `${e.kind === "sketch" ? "sketching" : e.isNew ? "adding" : "editing"}${e.name ? " " + e.name : ""}`; },
    },
  });
  const guard = new EditGuard(studio);
  // names stay known after their people left (an edit read back after a reconnect is by somebody not here yet)
  const names = new Map<string, string>();
  const offNames = collab.subscribe(() => { const s = collab.getState(); for (const p of s.people) names.set(p.login, p.name); for (const m of s.elsewhere) names.set(m.login, m.name); });
  guard.nameOf = (login) => names.get(login) || login;
  const comments = new CommentStore(studio.host.doc.docId, studio.session);

  const sync = () => {
    const s = studio.getState();
    let changed = false;
    if (s.bodies !== bodiesSeen) {
      bodiesSeen = s.bodies;
      const ids = new Set(s.bodies.map((b) => b.id));
      for (const id of Array.from(meshes.keys())) if (!ids.has(id)) { meshes.delete(id); changed = true; }
      for (const b of s.bodies) {
        const had = meshes.get(b.id);
        if (b.mesh && (!had || had.rev !== b.rev || had.mesh !== b.mesh)) { meshes.set(b.id, { rev: b.rev, createdBy: b.createdBy, mesh: b.mesh }); changed = true; }
      }
    }
    if (s.sketches !== sketchesSeen) { sketchesSeen = s.sketches; sketches = new Map(s.sketches.map((v) => [v.featureId, v])); changed = true; }
    if (changed) collab.sourcesChanged();
  };
  const off = studio.subscribe(sync);
  sync();

  const pins: PinSources = {
    mesh: (id) => meshes.get(id)?.mesh || null,
    meshes: () => Array.from(meshes.values()).map((m) => m.mesh),
    bodiesOf: (featureId) => Array.from(meshes.values()).filter((m) => m.createdBy === featureId).map((m) => m.mesh),
    hasFeature: (featureId) => studio.getState().features.some((f) => f.id === featureId),
  };
  const c: StudioCollab = { studio, collab, guard, comments, meshes, pins };
  (window as unknown as { JunctionCadCollab?: StudioCollab }).JunctionCadCollab = c;   // for tests and the console
  return {
    c, refs: 0,
    dispose() {
      off(); offNames(); collab.dispose(); guard.dispose(); comments.dispose();
      const w = window as unknown as { JunctionCadCollab?: StudioCollab };
      if (w.JunctionCadCollab === c) delete w.JunctionCadCollab;
    },
  };
}
