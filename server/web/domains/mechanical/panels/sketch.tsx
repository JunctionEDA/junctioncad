// The Sketch panel (right dock, while a sketch is open): how the open sketch stands — free, fully constrained or
// in conflict, and how many degrees of freedom are left — and its dimensions and constraints, which can be
// selected, edited and deleted from the list as from the drawing.
//
// The sketch tools are in the toolbar while a sketch is open (ui/Toolbar.tsx), the sketch's own dialog is
// ui/SketchDialog.tsx and the state of the sketch is also in the status bar (ui/StatusBar.tsx).
// Mounting this panel is what starts the sketch editor (sketch/editor.ts) for the part studio, and unmounting
// it is what takes the editor's drawing layer away again.
import { useEffect, useSyncExternalStore } from "react";
import { cx } from "../../../shared/util";
import { definePanel } from "../core/tool";
import { dimensionText, sketchUnits } from "../sketch/dims";
import { sketchEditor, type EditorState, type SketchEditor } from "../sketch/editor";
import { isDimension } from "../sketch/refs";
import { useStudio } from "../ui/hooks";
import { TONE, standing } from "../ui/StatusBar";
import type { PartStudio } from "../ui/studio";

export { standing };

function useEditor<T>(ed: SketchEditor, selector: (s: EditorState) => T): T {
  return useSyncExternalStore(ed.subscribe, () => selector(ed.getState()));
}

const TITLES: { [type: string]: string } = {
  coincident: "Coincident", horizontal: "Horizontal", vertical: "Vertical", parallel: "Parallel", perpendicular: "Perpendicular", tangent: "Tangent", equal: "Equal",
  midpoint: "Midpoint", concentric: "Concentric", collinear: "Collinear", symmetric: "Symmetric", fix: "Fix", distance: "Distance", radius: "Radius", diameter: "Diameter", angle: "Angle",
};

function SketchPanel({ studio }: { studio: PartStudio }) {
  const ed = sketchEditor(studio);
  // the editor follows the part studio from here on; when the part studio's view goes, so does its drawing layer
  useEffect(() => { const e = sketchEditor(studio); return () => e.dispose(); }, [studio]);
  const s = useEditor(ed, (x) => x);
  const open = useStudio(studio, (x) => !!x.sketch);
  useStudio(studio, (x) => x.units);
  if (!open || !s.open) return <p className="note px-2 py-1 m-0">Open a sketch to see its dimensions and constraints.</p>;
  const st = standing(s);
  const all = Object.entries(s.data.constraints);
  const dims = all.filter(([, c]) => isDimension(c)), rest = all.filter(([, c]) => !isDimension(c));
  const unit = sketchUnits().length;
  const row = (id: string, label: string, value: string, flag: string | null) => {
    const on = s.selection.includes(id);
    return (
      <div key={id} role="listitem" data-constraint={id} className={cx("group flex items-center gap-1.5 h-6 px-2 cursor-default", on ? "bg-sel" : "hover:bg-sel-soft")}
        onPointerEnter={() => ed.setHover(id)} onPointerLeave={() => ed.setHover(null)} onClick={(e) => (e.shiftKey || e.ctrlKey || e.metaKey ? ed.toggle(id) : ed.select([id]))}
        onDoubleClick={() => { if (value) ed.editDimension(id); }}>
        <span className={cx("truncate", flag === "conflict" && "text-err", flag === "redundant" && "text-warn")}>{label}</span>
        {value ? <span className="mono text-ink-2 ml-auto whitespace-nowrap">{value}</span> : <span className="ml-auto" />}
        {flag ? <span className={cx("pill", flag === "conflict" ? "err" : "warn")}>{flag}</span> : null}
        <button type="button" className="btn sm ghost p-0 w-5 min-h-0 h-5 opacity-0 group-hover:opacity-100 focus:opacity-100" title="Delete" aria-label={`Delete ${label}`} onClick={(e) => { e.stopPropagation(); ed.edit((d) => d.remove([id])); }}>×</button>
      </div>
    );
  };
  const flagOf = (id: string) => (s.conflicting.includes(id) ? "conflict" : s.redundant.includes(id) ? "redundant" : null);
  // a length's text carries no unit in the drawing (the status bar says it); in the list, it does
  const withUnit = (type: string, text: string) => (type === "angle" || text === "?" ? text : `${text} ${unit}`);
  return (
    <div className="flex flex-col text-sm" data-sketch-panel>
      <div className="px-2 py-1.5 border-b border-line">
        <div className={cx("font-semibold", TONE[st.tone])} data-standing={st.tone}>{st.text}</div>
        {st.detail ? <div className="text-ink-2 text-xs">{st.detail}</div> : null}
      </div>
      <div className="px-2 pt-1.5 pb-0.5 text-2xs uppercase tracking-wide text-ink-3 mono">Dimensions ({dims.length})</div>
      <div role="list" aria-label="Dimensions">
        {dims.length ? dims.map(([id, c]) => row(id, (TITLES[c.type] || c.type) + (c.driving === false ? " (reference)" : ""), withUnit(c.type, dimensionText(s.data, c)), flagOf(id))) : <p className="note px-2 py-0.5 m-0">None yet. Press D, then click what to measure.</p>}
      </div>
      <div className="px-2 pt-2 pb-0.5 text-2xs uppercase tracking-wide text-ink-3 mono">Constraints ({rest.length})</div>
      <div role="list" aria-label="Constraints">
        {rest.length ? rest.map(([id, c]) => row(id, TITLES[c.type] || c.type, "", flagOf(id))) : <p className="note px-2 py-0.5 m-0">None yet.</p>}
      </div>
    </div>
  );
}

export default definePanel({ id: "sketch", title: "Sketch", side: "right", order: 5, visible: (studio) => !!studio.getState().sketch, render: (studio) => <SketchPanel studio={studio} /> });
