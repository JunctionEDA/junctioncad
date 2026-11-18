// The Mass properties panel: the material of each part (document/mass-materials.ts), and the volume, surface
// area, mass, centre of mass, moments of inertia and box of the selected parts (every part when none is
// selected), exact from the worker.  A click on a value copies it.
import { useEffect } from "react";
import { usePanelOpen } from "../ui/panels";
import { cx } from "../../../shared/util";
import { definePanel } from "../core/tool";
import { assignMaterial, materialsOf } from "../document/mass-materials";
import { massOf } from "../inspect/mass-session";
import { inertia, kg, mm, mm2, mm3, copyNum } from "../inspect/measure-format";
import { copyText } from "../inspect/measure-session";
import { useStore } from "../inspect/store";
import { useStudio } from "../ui/hooks";
import type { PartStudio } from "../ui/studio";

function Value({ studio, label, text, value, minor }: { studio: PartStudio; label: string; text: string; value: number; minor?: boolean }) {
  return (
    <tr className="cursor-copy hover:bg-sel-soft" title="Click to copy" data-key={label} onClick={() => copyText(copyNum(value), studio)}>
      <td className={cx("py-0.5 text-ink-2", minor ? "pl-3" : "")}>{label}</td>
      <td className={cx("py-0.5 text-right mono", minor ? "text-ink-3" : "text-ink")}>{text}</td>
    </tr>
  );
}

function MassProperties({ studio }: { studio: PartStudio }) {
  useStudio(studio, (s) => s.units);   // the values are written in the document's units
  const mass = massOf(studio);
  const s = useStore(mass, (x) => x);
  const bodies = useStudio(studio, (x) => x.bodies);
  const canEdit = useStudio(studio, (x) => x.canEdit);
  useStudio(studio, (x) => x.features);
  const open = usePanelOpen(studio, "mass-properties");
  useEffect(() => (open ? mass.watch() : undefined), [mass, open]);   // nothing is weighed while the panel is folded
  const { library, assign } = materialsOf(studio.doc);
  const names = Object.entries(library).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const t = s.total;
  const one = s.parts.length === 1 ? s.parts[0] : null;
  const setMaterial = (ids: string[], m: string) => { if (!studio.doc) return; const c = assignMaterial(studio.doc, ids, m || null); if (c.length) studio.commit(c); };

  return (
    <div className="flex flex-col gap-2 p-2 text-sm" data-mass={s.busy ? "busy" : "ready"}>
      <div className="flex flex-col gap-1" role="list" aria-label="Materials">
        {bodies.map((b) => (
          <label key={b.id} role="listitem" className="flex items-center gap-1.5 text-xs" data-body={b.id}>
            <span className={cx("flex-1 truncate", s.bodies.includes(b.id) ? "text-ink" : "text-ink-3")}>{b.name}</span>
            <select className="input h-6 text-xs w-32" value={assign[b.id] || ""} disabled={!canEdit} aria-label={`Material of ${b.name}`} onChange={(e) => setMaterial([b.id], e.target.value)}>
              <option value="">No material</option>
              {names.map(([id, m]) => <option key={id} value={id}>{m.name} ({m.density} g/cm³)</option>)}
            </select>
          </label>
        ))}
        {!bodies.length ? <p className="note m-0 text-xs">No parts yet.</p> : null}
      </div>

      {t && s.parts.length ? (
        <div className="border-t border-line pt-1.5">
          <div className="flex items-center text-xs mb-1">
            <span className="flex-1 font-semibold text-ink" data-mass-title>{s.fromSelection ? (one ? one.name : `${s.parts.length} selected parts`) : s.parts.length === 1 ? s.parts[0].name : `All ${s.parts.length} parts`}</span>
            <label className="flex items-center gap-1 text-ink-2"><input type="checkbox" checked={s.showCentre} onChange={(e) => mass.setShowCentre(e.target.checked)} />Show centre</label>
          </div>
          <table className="w-full border-collapse text-xs" aria-label="Mass properties">
            <tbody>
              {t.mass !== null ? <Value studio={studio} label="Mass" text={kg(t.mass)} value={t.mass} /> : null}
              <Value studio={studio} label="Volume" text={mm3(t.volume)} value={t.volume} />
              <Value studio={studio} label="Surface area" text={mm2(t.area)} value={t.area} />
              <tr><td colSpan={2} className="pt-1 text-ink-2">Centre of mass</td></tr>
              {(["X", "Y", "Z"] as const).map((a, i) => <Value key={a} studio={studio} label={a} text={mm(t.centre[i])} value={t.centre[i]} minor />)}
              {t.inertia ? <>
                <tr><td colSpan={2} className="pt-1 text-ink-2">Inertia about the centre</td></tr>
                {([["Ixx", t.inertia.xx], ["Iyy", t.inertia.yy], ["Izz", t.inertia.zz], ["Ixy", t.inertia.xy], ["Ixz", t.inertia.xz], ["Iyz", t.inertia.yz]] as const).map(([l, v]) => <Value key={l} studio={studio} label={l} text={inertia(v)} value={v} minor />)}
              </> : null}
              {t.principal ? <>
                <tr><td colSpan={2} className="pt-1 text-ink-2">Principal moments</td></tr>
                {t.principal.moments.map((v, i) => <Value key={i} studio={studio} label={`I${i + 1}`} text={inertia(v)} value={v} minor />)}
              </> : null}
              {t.bbox ? <>
                <tr><td colSpan={2} className="pt-1 text-ink-2">Bounding box</td></tr>
                {(["X", "Y", "Z"] as const).map((a, i) => <Value key={a} studio={studio} label={`${a} size`} text={mm(t.bbox![i + 3] - t.bbox![i])} value={t.bbox![i + 3] - t.bbox![i]} minor />)}
              </> : null}
            </tbody>
          </table>
          {t.mass === null ? <p className="note m-0 mt-1 text-xs">Give {s.parts.length === 1 ? "the part" : "every part"} a material for its mass and inertia.</p> : null}
        </div>
      ) : null}
      {s.error ? <p className="m-0 text-xs text-err">{s.error}</p> : null}
    </div>
  );
}

export default definePanel({ id: "mass-properties", title: "Mass properties", side: "right", order: 20, open: false, render: (studio) => <MassProperties studio={studio} /> });
