// SketchDialog.tsx — the dialog of the open sketch, in the place and the frame of a feature's dialog: its name,
// ✓ (keep it) and ✗ (put it back as it was), the plane it lies on (click the box, then a plane, a flat face or a
// row of the feature list, to move it), how it stands, and the two things a person sets about sketching.
import { useSyncExternalStore } from "react";
import { cx } from "../../../shared/util";
import { DEFAULT_PLANES, type DefaultPlaneId, type PlaneRef } from "../core/geometry";
import { sketchEditor } from "../sketch/editor";
import { DialogShell } from "./DialogShell";
import { useStudio } from "./hooks";
import { setPrefs, usePref } from "./prefs";
import { TONE, standing } from "./StatusBar";
import { featureDef, type PartStudio } from "./studio";
import { tipHandlers } from "./Tip";

const row = "grid grid-cols-[104px_minmax(0,1fr)] items-start gap-x-2 min-h-7";

export function SketchDialog({ studio }: { studio: PartStudio }) {
  const open = useStudio(studio, (s) => s.sketch);
  const feature = useStudio(studio, (s) => (s.sketch ? s.features.find((f) => f.id === s.sketch!.featureId) : undefined));
  const features = useStudio(studio, (s) => s.features);
  const picking = useStudio(studio, (s) => !!s.ui?.pickingPlane);
  const normal = usePref("sketchNormal"), glyphs = usePref("showConstraints");
  const ed = sketchEditor(studio);
  const st = useSyncExternalStore(ed.subscribe, ed.getState);
  if (!open || !feature) return null;
  const plane = feature.params.plane as unknown as PlaneRef | undefined;
  const where = !plane ? "No plane" : plane.kind === "plane" ? `${DEFAULT_PLANES[plane.plane]?.title || plane.plane} plane` : plane.kind === "datum" ? features.find((f) => f.id === plane.feature)?.name || "A missing plane" : "A face of the model";
  const s = standing(st);
  return (
    <DialogShell className="cad-sketch-dialog" keepFold icon={featureDef("sketch")?.icon} name={feature.name} attrs={{ "data-sketch": feature.id }}
      onAccept={() => studio.finishSketch()} onCancel={() => studio.cancelSketch()} acceptAttrs={{ "data-sketch-accept": true }} cancelAttrs={{ "data-sketch-cancel": true }}
      acceptTip={{ title: "Finish sketch", hint: "Keep the sketch and go back to the part." }} cancelTip={{ title: "Cancel sketch", hint: open.isNew ? "Leave, and take this new sketch away again." : "Leave, and put the sketch back as it was when you opened it." }}>
      <div className={row}>
        <span className="text-ink-2 leading-7">Sketch plane</span>
        <span className="flex flex-col gap-1">
          <button type="button" className={cx("appearance-none m-0 [font-family:inherit] [font-size:inherit] text-inherit text-left px-1.5 h-6 rounded-sm border bg-panel cursor-pointer truncate", picking ? "border-blue outline outline-1 outline-blue" : "border-line")} data-sketch-plane={plane ? (plane.kind === "plane" ? plane.plane : plane.kind) : ""} data-armed={picking || undefined}
            {...tipHandlers({ title: picking ? "Listening" : "Move the sketch", hint: picking ? "Click a plane or a flat face, in the model or in the feature list. Esc stops." : "Click here, then a plane or a flat face." })} onClick={() => studio.pickSketchPlane(!picking)}>
            {picking ? "Click a plane or a flat face" : where}
          </button>
          <span className="seg">{(Object.keys(DEFAULT_PLANES) as DefaultPlaneId[]).map((id) => <button key={id} type="button" data-plane={id} className={cx(plane && plane.kind === "plane" && plane.plane === id && "on")} onClick={() => { studio.pickSketchPlane(false); if (!(plane && plane.kind === "plane" && plane.plane === id)) studio.setSketchPlane({ kind: "plane", plane: id }); }}>{DEFAULT_PLANES[id].title}</button>)}</span>
        </span>
      </div>
      <div className="flex items-center gap-4 h-6">
        <label className="flex items-center gap-1.5 cursor-pointer" {...tipHandlers({ title: "Show constraints", hint: "The small marks that say what holds the sketch: horizontal, coincident, tangent… Those in conflict are always shown." })}><input type="checkbox" checked={glyphs} data-pref="showConstraints" onChange={(ev) => setPrefs({ showConstraints: ev.target.checked })} /><span>Constraints</span></label>
        <label className="flex items-center gap-1.5 cursor-pointer" {...tipHandlers({ title: "Face the plane", shortcut: "N", hint: "Opening a sketch turns the view to look straight at it, and finishing turns it back. N does it at any time." })}><input type="checkbox" checked={normal} data-pref="sketchNormal" onChange={(ev) => { setPrefs({ sketchNormal: ev.target.checked }); if (ev.target.checked) studio.faceSketch(); }} /><span>Face the plane on opening</span></label>
      </div>
      <div className="flex items-center gap-2 pt-1.5 border-t border-line text-xs" data-sketch-standing={s.tone} {...tipHandlers({ title: "The colours of the sketch", hint: "Teal: still free to move. Ink: settled by its dimensions and constraints. Red: constraints that cannot all hold." })}>
        <span className={cx("font-semibold whitespace-nowrap", TONE[s.tone])}>{s.text}</span>{s.detail ? <span className="text-ink-2 truncate">{s.detail}</span> : null}
        <span className="flex-1" />
        <span className="flex items-center gap-1 text-ink-3" aria-hidden="true"><span className="w-2 h-2 rounded-full bg-teal" /><span className="w-2 h-2 rounded-full bg-ink" /><span className="w-2 h-2 rounded-full bg-err" /></span>
      </div>
    </DialogShell>
  );
}
