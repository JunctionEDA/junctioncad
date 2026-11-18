// PartStudioView.tsx — the part studio's frame:
//
//   the toolbar            the tools of the mode the studio is in (Toolbar.tsx)
//   left dock │ viewport │ right dock      the docked panels (panels/*.tsx); over the viewport the dialog of the
//                                          feature or sketch being edited, the view cube, and the overlay panels
//   the status bar         what is going on, what a click picks, the units (StatusBar.tsx)
import { Fragment, useEffect, useRef } from "react";
import { PANELS } from "../generated/page";
import { cx } from "../../../shared/util";
import { FeatureDialog } from "./FeatureDialog";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import { dockFolded, panelOpen, setDockFolded, setPanelOpen, usePanels } from "./panels";
import type { PartStudio } from "./studio";
import { CommandPalette, ContextMenu, Shortcuts } from "./Overlays";
import { SketchDialog } from "./SketchDialog";
import { StatusBar } from "./StatusBar";
import { TipHost } from "./Tip";
import { Toolbar } from "./Toolbar";
import { ViewCube } from "./ViewCube";

/** a button with nothing of the browser's own look */
export const BARE = "appearance-none bg-transparent border-0 m-0 p-0 text-inherit [font-family:inherit] [font-size:inherit] cursor-pointer";
const CHEVRON = '<path d="M9 6l6 6-6 6"/>';

function Dock({ studio, where }: { studio: PartStudio; where: "left" | "right" }) {
  usePanels();
  // a panel's `open` and `visible` may read anything of the studio: look again whenever it changes
  useStudio(studio, (s) => s.features); useStudio(studio, (s) => !!s.sketch); useStudio(studio, (s) => s.ui); useStudio(studio, (s) => s.bodies);
  const panels = PANELS.filter((p) => p.side === where).slice().sort((a, b) => (a.order ?? 1e6) - (b.order ?? 1e6));
  if (!panels.length) return null;
  const folded = dockFolded(where);
  const edge = where === "left" ? "border-r border-line" : "border-l border-line";
  const shown = panels.filter((p) => !p.visible || p.visible(studio));
  const firstOpen = shown.find((p) => panelOpen(studio, p));
  return (
    <aside className={cx("cad-dock flex min-h-0 bg-bench", edge, folded ? "w-6 flex-col items-center" : "w-60 flex-col")} data-side={where} data-folded={folded || undefined}>
      {folded ? (
        <button type="button" className="btn sm ghost p-0 w-5 h-6 mt-0.5 min-h-0" title={`Show the ${shown.map((p) => p.title).join(", ")} panels`} aria-label="Show the panels" data-dock-unfold={where} onClick={() => setDockFolded(where, false)}>
          <Glyph svg={where === "left" ? CHEVRON : '<path d="M15 6l-6 6 6 6"/>'} size={14} />
        </button>
      ) : null}
      {/* The left dock's first open panel (the feature list) takes the room there is; every other open panel is
          as tall as what it holds, and gives way, scrolling, when the dock is full. */}
      {/* every panel stays mounted whatever is folded: some keep a part of the studio alive (collaboration, the sketch palette) */}
      {panels.map((p) => {
        const visible = shown.includes(p), open = visible && panelOpen(studio, p);
        return (
          <section key={p.id} className={cx("flex flex-col min-h-0", (folded || !visible) && "hidden", open ? (where === "left" && p === firstOpen ? "flex-[1_1_0]" : "flex-[0_1_auto] min-h-16") : "flex-none", "border-b border-line last:border-b-0")} data-panel={p.id} data-open={open || undefined}>
            <header className="flex flex-none items-center h-5.5 text-sm text-ink bg-[linear-gradient(var(--color-paper),var(--color-bench))] border-b border-line select-none">
              <button type="button" className={cx(BARE, "flex flex-1 min-w-0 items-center gap-1 h-full px-1 text-left font-semibold")} aria-expanded={open} data-panel-toggle={p.id} title={open ? `Fold ${p.title}` : `Unfold ${p.title}`} onClick={() => setPanelOpen(p.id, !open)}>
                <span className={cx("flex-none text-ink-3 transition-transform", open && "rotate-90")}><Glyph svg={CHEVRON} size={12} /></span>
                <span className="truncate">{p.title}</span>
                {p.count && p.count(studio) !== null ? <span className="mono text-xs font-normal text-ink-3" data-panel-count={p.count(studio)}>{p.count(studio)}</span> : null}
              </button>
              {p === shown[0] ? (
                <button type="button" className={cx(BARE, "flex flex-none items-center h-full px-1 text-ink-3 hover:text-ink")} title="Fold these panels away" aria-label="Fold these panels away" data-dock-fold={where} onClick={() => setDockFolded(where, true)}>
                  <Glyph svg={where === "left" ? '<path d="M15 6l-6 6 6 6"/>' : CHEVRON} size={12} />
                </button>
              ) : null}
            </header>
            <div className={cx("flex-1 min-h-0 overflow-y-auto bg-paper", !open && "hidden")}>{p.render(studio)}</div>
          </section>
        );
      })}
    </aside>
  );
}

export function PartStudioView({ studio, canvasHost }: { studio: PartStudio; canvasHost: HTMLElement }) {
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => { stage.current?.prepend(canvasHost); return () => canvasHost.remove(); }, [canvasHost]);
  return (
    <div className="cad-root grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] text-ink" data-doc-kind="part-studio">
      <Toolbar studio={studio} />
      <div className="flex min-h-0 min-w-0">
        <Dock studio={studio} where="left" />
        <div ref={stage} className="cad-stage relative flex-1 min-w-0 min-h-0 overflow-hidden">
          <FeatureDialog studio={studio} />
          <SketchDialog studio={studio} />
          <ViewCube studio={studio} />
          {PANELS.filter((p) => p.side === "overlay").map((p) => <Fragment key={p.id}>{p.render(studio)}</Fragment>)}
        </div>
        <Dock studio={studio} where="right" />
      </div>
      <StatusBar studio={studio} />
      <CommandPalette studio={studio} />
      <ContextMenu studio={studio} />
      <Shortcuts studio={studio} />
      <TipHost />
    </div>
  );
}
