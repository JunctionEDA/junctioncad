// The section view's controls, over the top left of the viewport while a section is on: which plane, how far
// along it, which side is kept, hatching.  inspect/section-view.ts does the drawing.
import { cx } from "../../../shared/util";
import { definePanel } from "../core/tool";
import { num } from "../inspect/measure-format";
import { sectionFromSelection } from "../inspect/section-pick";
import { sectionOf, type SectionPlane } from "../inspect/section-view";
import { useStore } from "../inspect/store";
import { useStudio } from "../ui/hooks";
import type { PartStudio } from "../ui/studio";

const PLANES: { id: SectionPlane; title: string }[] = [{ id: "top", title: "Top" }, { id: "front", title: "Front" }, { id: "right", title: "Right" }, { id: "face", title: "Face" }];

function SectionControls({ studio }: { studio: PartStudio }) {
  const sec = sectionOf(studio);
  const s = useStore(sec, (x) => x);
  const hasFace = useStudio(studio, (x) => x.selection.some((p) => p.kind === "face"));
  if (!s.on) return null;
  const [lo, hi] = s.range, span = Math.max(1e-6, hi - lo);
  const step = Math.pow(10, Math.floor(Math.log10(span / 200)));
  return (
    <div className="cad-section absolute left-2 top-2 z-[3] w-60 flex flex-col gap-1.5 p-2 rounded-sm border border-line bg-panel text-sm shadow-panel" role="group" aria-label="Section view">
      <div className="flex items-center gap-1">
        <span className="flex-1 font-semibold text-ink">Section</span>
        <button type="button" className="btn sm ghost h-5 px-1" title="End the section view (X)" onClick={() => sec.close()}>Close</button>
      </div>
      <div className="seg flex" role="radiogroup" aria-label="Plane">
        {PLANES.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={s.plane === p.id} className={cx("flex-1", s.plane === p.id && "on")}
            disabled={p.id === "face" && !hasFace && s.plane !== "face"} title={p.id === "face" ? "The plane of the selected flat face" : `Parallel to the ${p.title} plane`}
            onClick={() => { if (p.id === "face") void sectionFromSelection(studio); else sec.open(p.id); }}>{p.title}</button>
        ))}
      </div>
      <label className="flex items-center gap-1.5 text-xs text-ink-2">
        <span className="w-10">Offset</span>
        <input type="range" className="flex-1 min-w-0" min={lo} max={hi} step={step} value={s.offset} aria-label="Offset" onChange={(e) => sec.setOffset(Number(e.target.value))} />
        <input key={num(s.offset, 3)} type="number" className="input mono w-16 h-6 text-xs" step={step} defaultValue={num(s.offset, 3)} aria-label="Offset in millimetres"
          onBlur={(e) => { const v = Number(e.target.value); if (e.target.value !== "" && Number.isFinite(v)) sec.setOffset(v); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      </label>
      <div className="flex items-center gap-3 text-xs text-ink-2">
        <label className="flex items-center gap-1"><input type="checkbox" checked={s.flip} onChange={(e) => sec.setFlip(e.target.checked)} />Flip</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={s.hatch} onChange={(e) => sec.setHatch(e.target.checked)} />Hatch</label>
      </div>
    </div>
  );
}

export default definePanel({ id: "section-controls", title: "Section", side: "overlay", order: 20, render: (studio) => <SectionControls studio={studio} /> });
