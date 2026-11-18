// index.tsx — the assembly domain's page bundle (static/dist/assembly.js): the assembly editor.
// Loaded by the app shell the first time an assembly tab is opened (web/platform/documents/host.ts).
import { createRoot } from "react-dom/client";
import { registerDocumentEditor } from "../../platform/documents/host";
import { mountViewportCollab } from "../mechanical/api";
import { AssemblyEditor } from "./ui/assembly";
import { AssemblyView } from "./ui/AssemblyView";

registerDocumentEditor({
  docTypes: ["assembly"],
  open(ctx) {
    const canvasHost = document.createElement("div");
    canvasHost.style.cssText = "position:absolute;inset:0";
    const assembly = new AssemblyEditor(ctx, canvasHost);
    // who else is here, their pointers and views, Follow (mechanical/collab); the selected row goes along
    const presence = mountViewportCollab({
      session: assembly.session, viewport: assembly.viewport, ctx,
      local: () => ({ sel: [], feat: assembly.getState().selection[0] ?? null, edit: null, hit: null }),
      subscribe: assembly.subscribe,
    });
    const root = createRoot(ctx.el);
    root.render(<AssemblyView assembly={assembly} canvasHost={canvasHost} />);
    (window as unknown as { JunctionAssembly?: AssemblyEditor }).JunctionAssembly = assembly;
    return { close() { presence.dispose(); assembly.close(); root.unmount(); ctx.el.replaceChildren(); } };
  },
});
