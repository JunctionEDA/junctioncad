// main.tsx — mounts the React chrome into app.html's mount points.  app.js (loaded first) owns
// the stage, the canvas, the SVG overlays, pointer handling and the websocket, and publishes the
// store on window.CollabApp; each root below renders from it.  The hosts are `display: contents`
// wrappers so the rendered elements are the page grid's own children, exactly as the static
// markup used to be.
import { createRoot } from "react-dom/client";
import { Guide } from "./platform/onboarding/Guide";
import type { ReactNode } from "react";
// chrome styling: web/shared/styles/tailwind.css (built by @tailwindcss/cli into static/dist/ui.css)
import { MenuBar } from "./shared/components/MenuBar";
import { AuxToolbar, LeftOptionsToolbar, RightDrawToolbar, TopToolbar } from "./shared/components/Toolbar";
import { DockBottom, DockLeft, DockRight } from "./shared/components/Dock";
import { StatusBar } from "./shared/components/StatusBar";
import { MsgPanel } from "./shared/components/MsgPanel";
import { Popover, SignInOverlay, Toast } from "./shared/components/Overlays";
import { Home } from "./platform/home/Home";
import { Toasts } from "./platform/home/ui";
import { PluginDialogs, PluginDock } from "./domains/pcb/plugins/PluginUi";
import { ContextMenu } from "./shared/components/ContextMenu";
import { HistoryBar, VersionDialogs } from "./shared/components/VersionHistory";
import { CompareWindow } from "./platform/review/Compare";
import { installReview } from "./platform/review/store";
import { DocTabs } from "./platform/doctabs/DocTabs";
import { registerProjectHome } from "./platform/projecthome/ProjectHome";
import { installToolbarTooltips } from "./shared/tooltip";
import { SPEC } from "./domains/pcb/spec";
import { loadIconPack, packIcon } from "./domains/pcb/iconpack";

// The Symbol Editor (web/domains/pcb/symedit, in editor.js) draws its toolbars from the same spec and icons: published here so
// the 670 KB spec is not bundled twice.
Object.assign(window, {
  KiCadUiToolbars: SPEC.toolbars,
  KiCadIconFor: (name: string) => SPEC.icons[name] || packIcon(name),
  KiCadIconsReady: loadIconPack(),
});

function mount(id: string, node: ReactNode) {
  const host = document.getElementById(id);
  if (!host) { console.warn(`ui: no mount point #${id}`); return; }
  createRoot(host).render(node);
}

mount("ui-menubar", <MenuBar />);
mount("ui-tbTop", <TopToolbar />);
mount("ui-tbAux", <AuxToolbar />);
mount("ui-dockL", <DockLeft />);
mount("ui-tbLeft", <LeftOptionsToolbar />);
mount("ui-tbRight", <RightDrawToolbar />);
mount("ui-dockR", <DockRight />);
mount("ui-dockPlugins", <PluginDock />);
mount("ui-dockB", <DockBottom />);
mount("ui-msgpanel", <MsgPanel />);
mount("ui-doctabs", <DocTabs />);
mount("ui-statusbar", <StatusBar />);
mount("ui-home", <><Home /><Toasts /></>);
mount("ui-overlays", <><Toast /><Popover /><SignInOverlay /><ContextMenu /><PluginDialogs /><HistoryBar /><VersionDialogs /><CompareWindow /><Guide /></>);
registerProjectHome();   // the Home tab of an open project (the shell opens it like a document)
installReview();
installToolbarTooltips();
