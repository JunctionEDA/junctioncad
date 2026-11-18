// The Appearance panel: how the model is drawn (view mode, perspective), each part's colour, opacity and
// visibility, colours of selected faces, and named views.  Colours, opacity and named views are stored in the
// document (document/appearance-items.ts) and seen by everyone; hide, show and isolate are this person's own.
import { useEffect, useRef, useState } from "react";
import { cx } from "../../../shared/util";
import type { CameraState } from "../../../shared/viewport3d/viewport3d";
import { definePanel } from "../core/tool";
import { addNamedView, namedViews, removeNamedView, resetLook, setBodyLook, setFaceColor, type CameraJson } from "../document/appearance-items";
import { VIEW_MODES, displayOf, selectedBodies, type ViewMode } from "../inspect/appearance-display";
import { useStore } from "../inspect/store";
import { useStudio } from "../ui/hooks";
import type { PartStudio } from "../ui/studio";

/** Calls `fn` once the value has stopped changing for a moment: a colour picker or a slider makes one edit. */
function useSettled<T>(fn: (v: T) => void, ms = 350): (v: T) => void {
  const timer = useRef(0), latest = useRef(fn);
  latest.current = fn;
  useEffect(() => () => clearTimeout(timer.current), []);
  return (v: T) => { clearTimeout(timer.current); timer.current = window.setTimeout(() => latest.current(v), ms); };
}

function ColorInput({ value, label, disabled, onPick }: { value: string; label: string; disabled?: boolean; onPick(c: string): void }) {
  const [now, setNow] = useState(value);
  useEffect(() => setNow(value), [value]);
  const settle = useSettled(onPick);
  return <input type="color" className="w-5 h-5 p-0 border border-line rounded-sm bg-panel flex-none cursor-pointer" value={now} aria-label={label} title={label} disabled={disabled}
    onChange={(e) => { setNow(e.target.value); settle(e.target.value); }} />;
}

function Appearance({ studio }: { studio: PartStudio }) {
  const display = displayOf(studio);
  const ds = useStore(display, (s) => s);
  const bodies = useStudio(studio, (s) => s.bodies);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const selection = useStudio(studio, (s) => s.selection);
  useStudio(studio, (s) => s.features);   // the document changed: colours and views may have
  const [viewName, setViewName] = useState("");
  const selected = selectedBodies(studio);
  const faces = selection.filter((p) => p.kind === "face") as { kind: "face"; body: string; name: string }[];
  const doc = studio.doc;
  const commit = (changes: ReturnType<typeof setBodyLook>) => { if (changes.length) studio.commit(changes); };
  const opacityOf = selected.length ? display.opacityOf(selected[0]) : 1;
  const settleOpacity = useSettled((v: number) => { if (doc) commit(setBodyLook(doc, selected, { opacity: v })); }, 250);
  const [opacity, setOpacity] = useState(opacityOf);
  useEffect(() => setOpacity(opacityOf), [opacityOf, selected.join()]);
  const views = namedViews(doc);

  return (
    <div className="flex flex-col gap-2 p-2 text-sm" data-appearance>
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          <span className="w-14">Display</span>
          <select className="input h-6 text-xs flex-1 min-w-0" value={ds.mode} aria-label="View mode" onChange={(e) => display.setMode(e.target.value as ViewMode)}>
            {VIEW_MODES.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" checked={ds.perspective} onChange={(e) => display.setPerspective(e.target.checked)} />Perspective</label>
      </div>

      <div role="list" aria-label="Parts" className="flex flex-col">
        {bodies.map((b) => {
          const visible = !ds.hidden.includes(b.id) && (!ds.isolated || ds.isolated.includes(b.id));
          const look = display.lookOf(b.id);
          return (
            <div key={b.id} role="listitem" data-body={b.id} className={cx("flex items-center gap-1.5 h-6.5", selected.includes(b.id) && "bg-sel-soft")}>
              <button type="button" className={cx("btn sm ghost h-5 w-5 p-0 flex-none", !visible && "opacity-45")} aria-pressed={visible} title={visible ? "Hide" : "Show"} aria-label={`${visible ? "Hide" : "Show"} ${b.name}`} onClick={() => display.toggle(b.id)}>
                <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden="true" className="fill-none stroke-current" strokeWidth={1.8}>{visible ? <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></> : <><path d="M3 3l18 18" /><path d="M2 12s4-7 10-7c2 0 3.8.8 5.3 1.8M22 12s-4 7-10 7c-2 0-3.8-.8-5.3-1.8" /></>}</svg>
              </button>
              <ColorInput value={display.hexOf(b.id)} label={`Colour of ${b.name}`} disabled={!canEdit} onPick={(c) => doc && commit(setBodyLook(doc, [b.id], { color: c }))} />
              <span className="flex-1 truncate cursor-default" onClick={() => studio.select([])}>{b.name}</span>
              {look.opacity !== undefined ? <span className="text-ink-3 text-xs mono">{Math.round(look.opacity * 100)}%</span> : null}
              {look.color || look.opacity !== undefined || look.faces ? <button type="button" className="btn sm ghost h-5 px-1 text-xs" disabled={!canEdit} title="Back to the material's or the default colour" onClick={() => doc && commit(resetLook(doc, [b.id]))}>Reset</button> : null}
              <button type="button" className={cx("btn sm ghost h-5 px-1 text-xs", ds.isolated && ds.isolated.length === 1 && ds.isolated[0] === b.id && "on")} title="Show only this part" onClick={() => display.isolate(ds.isolated && ds.isolated[0] === b.id ? null : [b.id])}>Only</button>
            </div>
          );
        })}
        {!bodies.length ? <p className="note m-0 text-xs">No parts yet.</p> : null}
        {ds.hidden.length || ds.isolated ? <button type="button" className="btn sm mt-1 self-start" onClick={() => display.showAll()}>Show all</button> : null}
      </div>

      {selected.length ? (
        <div className="flex flex-col gap-1 border-t border-line pt-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            <span className="w-14">Opacity</span>
            <input type="range" min={0.1} max={1} step={0.05} value={opacity} className="flex-1 min-w-0" aria-label="Opacity of the selected parts" disabled={!canEdit}
              onChange={(e) => { const v = Number(e.target.value); setOpacity(v); settleOpacity(v); }} />
            <span className="mono w-8 text-right">{Math.round(opacity * 100)}%</span>
          </label>
          {faces.length ? (
            <div className="flex items-center gap-1.5 text-xs text-ink-2">
              <span className="w-14">{faces.length === 1 ? "Face" : `${faces.length} faces`}</span>
              <ColorInput value={display.lookOf(faces[0].body).faces?.[faces[0].name] || display.hexOf(faces[0].body)} label="Colour of the selected faces" disabled={!canEdit}
                onPick={(c) => doc && commit(setFaceColor(doc, faces.map((f) => ({ body: f.body, name: f.name })), c))} />
              <button type="button" className="btn sm ghost h-5 px-1 text-xs" disabled={!canEdit} onClick={() => doc && commit(setFaceColor(doc, faces.map((f) => ({ body: f.body, name: f.name })), null))}>Clear</button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-1 border-t border-line pt-2" aria-label="Named views">
        <div className="text-xs font-semibold text-ink">Named views</div>
        {views.map((v) => (
          <div key={v.id} className="flex items-center gap-1 h-6" data-view={v.name}>
            <button type="button" className="btn sm ghost flex-1 justify-start truncate h-5 px-1" title="Go to this view" onClick={() => { studio.viewport.setCameraState(v.camera as unknown as CameraState); display.syncProjection(); }}>{v.name}</button>
            <button type="button" className="btn sm ghost h-5 px-1 text-xs" disabled={!canEdit} aria-label={`Delete view ${v.name}`} title="Delete" onClick={() => doc && commit(removeNamedView(doc, v.id))}>×</button>
          </div>
        ))}
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (!doc) return; commit(addNamedView(doc, viewName, studio.viewport.cameraState() as unknown as CameraJson)); setViewName(""); }}>
          <input className="input h-6 text-xs flex-1 min-w-0" placeholder={`View ${views.length + 1}`} value={viewName} aria-label="Name of the view" onChange={(e) => setViewName(e.target.value)} disabled={!canEdit} />
          <button type="submit" className="btn sm h-6" disabled={!canEdit} title="Save the current view">Save view</button>
        </form>
      </div>
    </div>
  );
}

export default definePanel({ id: "appearance", title: "Appearance", side: "right", order: 30, open: false, render: (studio) => <Appearance studio={studio} /> });
