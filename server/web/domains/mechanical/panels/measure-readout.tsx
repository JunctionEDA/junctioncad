// The measure readout, in the corner of the viewport: what the selection measures (exact, from the worker),
// a click on a value copies it, Pin keeps the measurement drawn on the model.  inspect/measure-session.ts.
import { cx } from "../../../shared/util";
import { definePanel } from "../core/tool";
import { readout } from "../inspect/measure-format";
import { copyText, measureOf } from "../inspect/measure-session";
import { useStore } from "../inspect/store";
import { useStudio } from "../ui/hooks";
import type { PartStudio } from "../ui/studio";

function Readout({ studio }: { studio: PartStudio }) {
  const m = measureOf(studio);
  const result = useStore(m, (s) => s.result);
  const items = useStore(m, (s) => s.items);
  const busy = useStore(m, (s) => s.busy);
  const error = useStore(m, (s) => s.error);
  const active = useStore(m, (s) => s.active);
  const pins = useStore(m, (s) => s.pins);
  const sketch = useStudio(studio, (s) => !!s.sketch);
  useStudio(studio, (s) => s.units);   // the rows are written in the document's units
  if (sketch) return null;
  const r = readout(result);
  if (!items.length && !pins.length && !active) return null;
  return (
    <div className="cad-measure absolute right-2 bottom-2 z-[3] w-64 max-h-[60%] flex flex-col rounded-sm border border-line bg-panel text-sm shadow-panel" data-measure={busy ? "busy" : "ready"} aria-live="polite">
      <header className="flex items-center gap-1 h-6 px-2 border-b border-line text-xs font-semibold text-ink">
        <span className="flex-1 truncate">{items.length ? r.title || "Measuring…" : "Measure"}</span>
        {result && items.length ? <button type="button" className="btn sm ghost h-5 px-1 text-xs" title="Keep this measurement on the model" onClick={() => m.pin()}>Pin</button> : null}
      </header>
      <div className="overflow-y-auto">
        {!items.length && active ? <p className="note px-2 py-1 m-0 text-xs">Pick faces, edges, vertices or planes. Shift-click adds a second one.</p> : null}
        {error ? <p className="px-2 py-1 m-0 text-xs text-err">{error}</p> : null}
        {items.length && !r.rows.length && !error && !busy ? <p className="note px-2 py-1 m-0 text-xs">Nothing to measure on a plane alone.</p> : null}
        {r.rows.length ? (
          <table className="w-full border-collapse text-xs" data-rows={r.rows.length}>
            <tbody>
              {r.rows.map((row) => (
                <tr key={row.key} data-key={row.key} className="cursor-copy hover:bg-sel-soft" title="Click to copy" onClick={() => copyText(row.copy, studio)}>
                  <td className={cx("py-0.5 text-ink-2", row.minor ? "pl-5" : "pl-2")}>{row.label}</td>
                  <td className={cx("py-0.5 pr-2 text-right mono", row.minor ? "text-ink-3" : "text-ink")} data-copy={row.copy}>{row.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      {pins.length ? (
        <div className="border-t border-line py-0.5" aria-label="Pinned measurements">
          {pins.map((p) => (
            <div key={p.id} className="flex items-center gap-1 h-5.5 px-2 text-xs text-ink-2" data-pin={p.id}>
              <span className="flex-1 truncate">{p.title}{p.result ? "" : " (lost)"}</span>
              <button type="button" className="btn sm ghost h-5 px-1 text-xs" title="Unpin" aria-label={`Unpin ${p.title}`} onClick={() => m.unpin(p.id)}>×</button>
            </div>
          ))}
          {pins.length > 1 ? <button type="button" className="btn sm ghost h-5 mx-1 px-1 text-xs" onClick={() => m.unpin(null)}>Unpin all</button> : null}
        </div>
      ) : null}
    </div>
  );
}

export default definePanel({ id: "measure-readout", title: "Measure", side: "overlay", order: 10, render: (studio) => <Readout studio={studio} /> });
