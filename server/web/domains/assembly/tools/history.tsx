// History: the project's versions and branches beside the assembly (web/platform/history/HistoryDrawer.tsx):
// save a version, restore one, start a branch, merge.  All of that is the server's and works for an assembly as
// for any document.  What is not here yet: showing the assembly as it was at an earlier point (the editor has no
// read-only view of another document state), so picking a row only selects it for Restore or Branch.
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HistoryDrawer, type HistoryHost, type Viewing } from "../../../platform/history/HistoryDrawer";
import { defineAssemblyTool } from "../core/tool";
import type { AssemblyEditor } from "../ui/assembly";

interface Mounted { root: Root; el: HTMLElement; canvasHost: HTMLElement }
const open = new WeakMap<AssemblyEditor, Mounted>();

function Drawer({ assembly, close }: { assembly: AssemblyEditor; close(): void }) {
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const host: HistoryHost = {
    projectId: assembly.host.project.projectId, doc: assembly.host.doc, canEdit: assembly.getState().canEdit, signedIn: assembly.host.signedIn,
    viewing, view: setViewing,
    note: "An earlier state of an assembly cannot be shown here yet. It can be restored.",
    toast: (text, ms) => assembly.host.toast(text, ms),
    navigate: (url) => { window.location.assign(url); },
    close,
  };
  return <div className="absolute top-0 right-0 bottom-0"><HistoryDrawer host={host} /></div>;
}

function toggle(assembly: AssemblyEditor): void {
  const was = open.get(assembly);
  if (was) { open.delete(assembly); was.canvasHost.style.right = "0"; was.root.unmount(); was.el.remove(); return; }
  const canvasHost = assembly.viewport.canvas.parentElement as HTMLElement | null, stage = canvasHost && canvasHost.parentElement;
  if (!canvasHost || !stage) return;
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:3";
  stage.appendChild(el);
  canvasHost.style.right = "20rem";
  const root = createRoot(el);
  open.set(assembly, { root, el, canvasHost });
  root.render(<Drawer assembly={assembly} close={() => toggle(assembly)} />);
}

export default defineAssemblyTool({
  id: "history", title: "History", hint: "Versions and branches", order: 900,
  icon: '<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 5v4h4"/><path d="M12 8v4l3 2"/>',
  active: (assembly) => open.has(assembly),
  run: (assembly) => toggle(assembly),
});
