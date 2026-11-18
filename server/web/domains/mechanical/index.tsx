// index.tsx — the mechanical domain's page bundle (static/dist/mechanical.js): the part studio editor.
// Loaded by the app shell the first time a part studio tab is opened (web/platform/documents/host.ts).
import { createRoot } from "react-dom/client";
import { registerDocumentEditor } from "../../platform/documents/host";
import "./compare/index";
import { disposeHistory, followHistoryRequests } from "./history/index";
import { attachThumbnail } from "./thumbnail";
import { PartStudioView } from "./ui/PartStudioView";
import { PartStudio } from "./ui/studio";

registerDocumentEditor({
  docTypes: ["part_studio"],
  open(ctx) {
    const canvasHost = document.createElement("div");
    canvasHost.style.cssText = "position:absolute;inset:0";
    const studio = new PartStudio(ctx, canvasHost);
    const root = createRoot(ctx.el);
    root.render(<PartStudioView studio={studio} canvasHost={canvasHost} />);
    // for tests and for poking at a studio from the console
    (window as unknown as { JunctionPartStudio?: PartStudio }).JunctionPartStudio = studio;
    const stopThumbnail = attachThumbnail(studio);
    const stopRequests = followHistoryRequests(studio);
    return {
      close() {
        stopThumbnail(); stopRequests(); disposeHistory(studio);
        studio.close(); root.unmount(); ctx.el.replaceChildren();
        const w = window as unknown as { JunctionPartStudio?: PartStudio };
        if (w.JunctionPartStudio === studio) delete w.JunctionPartStudio;
      },
    };
  },
});
