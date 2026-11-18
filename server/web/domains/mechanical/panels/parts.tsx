// The Parts panel: the bodies the features up to the rollback bar make.
//
//   click selects the part (its faces; Ctrl adds) · the pointer over a row lights the part up in the model
//   the eye hides and shows it; right-click: Hide, Isolate, Show all, Zoom to, Appearance and material, Delete
//
// Hiding and isolating are this person's view (inspect/appearance-display.ts); colour and material are the
// document's, set in the Appearance panel, which the menu opens.
import { useEffect, useState } from "react";
import { cx } from "../../../shared/util";
import { definePanel } from "../core/tool";
import { displayOf } from "../inspect/appearance-display";
import { useStore } from "../inspect/store";
import type { BodyResult } from "../kernel/protocol";
import type { Pick } from "../viewport/modelview";
import { Eye } from "../ui/FeatureList";
import { useStudio } from "../ui/hooks";
import { showPanel } from "../ui/panels";
import type { PartStudio } from "../ui/studio";

const facesOf = (studio: PartStudio, b: BodyResult): Pick[] => (studio.view.bodyObjects(b.id)?.result.mesh?.faces.names || []).map((name) => ({ kind: "face", body: b.id, name, point: [0, 0, 0] } as Pick));

function Parts({ studio }: { studio: PartStudio }) {
  const bodies = useStudio(studio, (s) => s.bodies);
  const selection = useStudio(studio, (s) => s.selection);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const busy = useStudio(studio, (s) => !!s.editing || !!s.sketch);
  const display = displayOf(studio);
  const ds = useStore(display, (s) => s);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close); window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); };
  }, [menu]);
  if (!bodies.length) return <p className="note px-2 py-1 m-0" data-empty>No parts yet. A part appears when a feature makes a solid: extrude or revolve a sketch.</p>;
  const on = (id: string) => selection.some((p) => (p.kind === "face" || p.kind === "edge" || p.kind === "vertex") && p.body === id);
  const b = menu ? bodies.find((x) => x.id === menu.id) : undefined;
  const item = (label: string, run: () => void, danger = false) => (
    <button type="button" key={label} data-menu-item={label} className={cx("block w-full text-left px-3 h-7 hover:bg-sel-soft", danger && "text-err")} onPointerDown={(ev) => ev.stopPropagation()} onClick={() => { setMenu(null); run(); }}>{label}</button>
  );
  return (
    <div className="flex flex-col py-1 text-sm" role="listbox" aria-label="Parts" aria-multiselectable="true">
      {bodies.map((b) => {
        const visible = display.isVisible(b.id);
        return (
          <div key={b.id} role="option" aria-selected={on(b.id)} data-body={b.id} data-visible={visible} className={cx("group flex items-center gap-1.5 h-6.5 pl-2 pr-1.5 cursor-default select-none", on(b.id) ? "bg-sel" : "hover:bg-sel-soft", (b.reference || !visible) && "text-ink-3")}
            title={b.reference ? `${b.name}: reference geometry (not a part of this studio)` : undefined}
            onClick={(ev) => { if (busy) return; const faces = facesOf(studio, b), add = ev.ctrlKey || ev.metaKey || ev.shiftKey; studio.select(on(b.id) ? selection.filter((p) => !("body" in p && p.body === b.id)) : [...(add ? selection : []), ...faces]); }}
            onPointerEnter={() => studio.view.setFeatureHover(visible ? facesOf(studio, b) : null)} onPointerLeave={() => studio.view.setFeatureHover(null)}
            onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, id: b.id }); }}>
            <span className="flex-1 truncate">{b.name}</span>
            {b.reference ? <span className="text-xs text-ink-3">reference</span> : null}
            <Eye shown={visible} label={b.name} onToggle={() => display.toggle(b.id)} />
          </div>
        );
      })}
      {ds.hidden.length || ds.isolated ? <button type="button" className="btn sm ghost self-start mx-1.5 mt-0.5 h-5 min-h-0 px-1 text-xs" data-show-all onClick={() => display.showAll()}>Show all parts</button> : null}
      {menu && b ? (
        <div className="fixed z-[50] min-w-48 py-1 rounded-md border border-line bg-panel shadow-panel text-base" style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 200) }} role="menu">
          {item(display.isVisible(b.id) ? "Hide" : "Show", () => display.toggle(b.id))}
          {item(ds.isolated && ds.isolated.length === 1 && ds.isolated[0] === b.id ? "Show all parts" : "Isolate", () => display.isolate(ds.isolated && ds.isolated[0] === b.id ? null : [b.id]))}
          {item("Zoom to", () => { const box = studio.view.boxOf(facesOf(studio, b)); if (box) studio.viewport.fit(box); })}
          {item("Appearance and material…", () => { studio.select(facesOf(studio, b).slice(0, 1)); showPanel("appearance"); })}
          {canEdit && !b.reference && !busy ? item("Delete part…", () => { studio.startFeature("delete-body"); studio.setDraft({ params: { bodies: [b.id] } }); }, true) : null}
        </div>
      ) : null}
    </div>
  );
}

export default definePanel({ id: "parts", title: "Parts", side: "left", order: 20, count: (studio) => studio.getState().bodies.filter((b) => !b.reference).length || null, render: (studio) => <Parts studio={studio} /> });
