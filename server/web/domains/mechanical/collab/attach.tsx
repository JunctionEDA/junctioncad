// attach.tsx — live presence for any 3D document editor that has a session and a Viewport3D: the people in the
// document as avatars over the viewport, their pointers, views and selections in it, and Follow.
//
// The part studio builds more on the same parts (its panels, the feature list, the edit guard).  Another editor
// (the assembly) calls this once when it opens and `dispose` when it closes:
//
//   const presence = mountViewportCollab({
//     session, viewport, ctx,
//     local: () => ({ sel: [], feat: selectedRowId, edit: null, hit: null }),
//     subscribe: editor.subscribe,
//   });
//
// `local()` is what this person has selected and open; `sources` lets the overlay draw other people's selected
// faces and edges when the editor has meshes to draw them on.
import { createRoot } from "react-dom/client";
import { Collab, type CollabHost } from "./collab";
import { Avatars, FollowFrame } from "./Avatars";

export interface ViewportCollabOptions extends Omit<CollabHost, "sources"> { sources?: CollabHost["sources"] }

export function mountViewportCollab(o: ViewportCollabOptions): { collab: Collab; dispose(): void } {
  const collab = new Collab({ ...o, sources: o.sources || { mesh: () => null, sketch: () => null } });
  // an element of no size: its children are placed against the viewport's own box
  const el = document.createElement("div");
  el.className = "cad-collab";
  el.style.cssText = "position:static";
  o.viewport.host.appendChild(el);
  const root = createRoot(el);
  root.render(<><FollowFrame collab={collab} /><Avatars collab={collab} /></>);
  return { collab, dispose() { collab.dispose(); root.unmount(); el.remove(); } };
}
