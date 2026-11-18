// export-file.tsx — File › Export: the part studio's parts as STEP, STL, 3MF, OBJ, glTF or BREP, or a sketch or a
// flat face as DXF or SVG, downloaded.  The heavy work runs in the modelling worker (services/export-*.ts); the
// dialog shows how long it is taking and what came out.
import { cx } from "../../../shared/util";
import { defineTool } from "../core/tool";
import type { PartStudio } from "../ui/studio";
import { download, formatBytes, openDialog, type DialogHandle } from "./_dialog";
import { FORMATS, formatOf, initialOptions, problem, runExport, saveOptions, type ExportOptions, type FormatId } from "./_export";

const row = "grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-2 min-h-7";

interface Status { running: boolean; text: string; error: boolean }

function ExportForm({ studio, o, status, set }: { studio: PartStudio; o: ExportOptions; status: Status; set(patch: Partial<ExportOptions>): void }) {
  const s = studio.getState(), f = formatOf(o.format);
  const sketches = s.features.slice(0, s.rollback).filter((x) => x.featureType === "sketch");
  const faceSource = o.source && o.source.kind === "face" ? o.source : null;
  const all = !o.bodies.length;
  const seg = (value: string, options: [string, string][], on: (v: string) => void, param: string) => (
    <span className="seg" data-param={param}>{options.map(([v, label]) => <button key={v} type="button" className={cx(value === v && "on")} onClick={() => on(v)}>{label}</button>)}</span>
  );
  return (
    <div className="flex flex-col gap-1.5 text-sm" data-export-dialog>
      <label className={row}><span className="text-ink-2">Format</span>
        <select className="input w-full" value={o.format} data-param="format" onChange={(ev) => set({ format: ev.target.value as FormatId })}>
          {FORMATS.map((x) => <option key={x.id} value={x.id}>{x.label} ({x.ext})</option>)}
        </select>
      </label>
      <p className="note m-0 pl-[118px] text-ink-3 text-xs">{f.hint}</p>
      <label className={row}><span className="text-ink-2">File name</span>
        <span className="flex items-center gap-1"><input className="input w-full" value={o.name} data-param="name" onChange={(ev) => set({ name: ev.target.value })} /><span className="text-ink-3 font-mono text-xs">{f.ext}</span></span>
      </label>
      {f.kind === "flat" ? (
        <label className={row}><span className="text-ink-2">Drawing of</span>
          <select className="input w-full" data-param="source" value={o.source ? (o.source.kind === "sketch" ? o.source.featureId : "face") : ""}
            onChange={(ev) => set({ source: ev.target.value === "face" ? faceSource : ev.target.value ? { kind: "sketch", featureId: ev.target.value } : null })}>
            <option value="">{sketches.length || faceSource ? "Choose a sketch" : "Draw a sketch or select a flat face first"}</option>
            {faceSource ? <option value="face">The selected face</option> : null}
            {sketches.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      ) : (
        <div className={row + " items-start"}><span className="text-ink-2 pt-1">Parts</span>
          <div className="flex flex-col gap-0.5 max-h-36 overflow-y-auto rounded-sm border border-line bg-panel px-1.5 py-1" data-param="bodies">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={all} onChange={() => set({ bodies: all ? s.bodies.slice(0, 1).map((b) => b.id) : [] })} /><span>Every part ({s.bodies.length})</span></label>
            {s.bodies.map((b) => (
              <label key={b.id} className="flex items-center gap-1.5 pl-4" data-body={b.id}>
                <input type="checkbox" checked={all || o.bodies.includes(b.id)} onChange={(ev) => {
                  const now = all ? s.bodies.map((x) => x.id) : o.bodies;
                  const next = ev.target.checked ? [...now, b.id] : now.filter((id) => id !== b.id);
                  set({ bodies: next.length === s.bodies.length ? [] : next });
                }} /><span className="truncate">{b.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {o.format === "step" ? <div className={row}><span className="text-ink-2">Protocol</span>{seg(o.schema, [["AP214", "AP214"], ["AP242", "AP242"]], (v) => set({ schema: v as ExportOptions["schema"] }), "schema")}</div> : null}
      {o.format !== "glb" && o.format !== "brep" ? <div className={row}><span className="text-ink-2">Units</span>{seg(o.unit, [["mm", "mm"], ["cm", "cm"], ["m", "m"], ["in", "inch"]], (v) => set({ unit: v as ExportOptions["unit"] }), "unit")}</div> : null}
      {f.kind === "mesh" ? (
        <>
          <div className={row}><span className="text-ink-2">Resolution</span>{seg(o.resolution, [["coarse", "Coarse"], ["medium", "Medium"], ["fine", "Fine"], ["custom", "Custom"]], (v) => set({ resolution: v as ExportOptions["resolution"] }), "resolution")}</div>
          {o.resolution === "custom" ? (
            <>
              <label className={row} title="The largest distance between a triangle and the true surface"><span className="text-ink-2">Deflection</span>
                <span className="flex items-center gap-1.5"><input className="input mono w-full" inputMode="decimal" defaultValue={o.deflection} data-param="deflection" onChange={(ev) => set({ deflection: Number(ev.target.value) })} /><span className="text-ink-3 font-mono text-xs">mm</span></span></label>
              <label className={row} title="The largest angle between neighbouring triangles on a curved face"><span className="text-ink-2">Angle</span>
                <span className="flex items-center gap-1.5"><input className="input mono w-full" inputMode="decimal" defaultValue={o.angle} data-param="angle" onChange={(ev) => set({ angle: Number(ev.target.value) })} /><span className="text-ink-3 font-mono text-xs">°</span></span></label>
            </>
          ) : null}
          {o.format === "stl" ? <div className={row}><span className="text-ink-2">Encoding</span>{seg(o.ascii ? "ascii" : "binary", [["binary", "Binary"], ["ascii", "ASCII"]], (v) => set({ ascii: v === "ascii" }), "encoding")}</div> : null}
        </>
      ) : null}
      <p className={cx("m-0 mt-1 min-h-5 text-xs", status.error ? "text-err" : "text-ink-2")} role="status" data-export-status={status.running ? "running" : status.error ? "error" : status.text ? "done" : "idle"}>{status.text}</p>
    </div>
  );
}

function openExport(studio: PartStudio): void {
  let o = initialOptions(studio);
  let status: Status = { running: false, text: "", error: false };
  let timer = 0;
  const draw = (h: DialogHandle) => {
    const why = status.running ? null : problem(studio, o);
    if (h.okButton) h.okButton.disabled = status.running || !!why;
    h.render(<ExportForm studio={studio} o={o} status={why && !status.text ? { running: false, text: why, error: false } : status} set={(patch) => { o = { ...o, ...patch }; if (!status.running) status = { running: false, text: "", error: false }; draw(h); }} />);
  };
  const unsubscribe = studio.subscribe(() => { if (handle) draw(handle); });
  const handle: DialogHandle = openDialog({
    title: "Export", width: 460, okLabel: "Export",
    render: (h) => { setTimeout(() => draw(h), 0); return <ExportForm studio={studio} o={o} status={status} set={() => {}} />; },
    onClose: () => { unsubscribe(); clearInterval(timer); },
    async ok(h) {
      if (status.running || problem(studio, o)) return;
      saveOptions(o);
      const t0 = performance.now();
      status = { running: true, text: "Exporting…", error: false }; draw(h);
      timer = window.setInterval(() => { status = { ...status, text: `Exporting… ${((performance.now() - t0) / 1000).toFixed(1)} s` }; draw(h); }, 250);
      try {
        const r = await runExport(studio, o);
        clearInterval(timer);
        download(r.data, r.name, r.mime);
        const what = `${r.name}, ${formatBytes(r.bytes)}${r.triangles ? `, ${r.triangles.toLocaleString()} triangles` : ""}, in ${(r.ms / 1000).toFixed(1)} s`;
        studio.host.toast(`Exported ${what}`, 4000);
        status = { running: false, text: `Saved ${what}.`, error: false };
        h.close();
      } catch (e) {
        clearInterval(timer);
        status = { running: false, text: (e as Error).message || "The export failed.", error: true };
        draw(h);
      }
    },
  });
}

export default defineTool({
  id: "export",
  title: "Export",
  hint: "Download the parts as STEP, STL, 3MF, OBJ, glTF or BREP, or a sketch or flat face as DXF or SVG",
  icon: '<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  group: "file",
  order: 20,
  // never greyed out: the toolbar is not redrawn when the parts change, and the dialog says what is missing
  run: (studio) => openExport(studio),
});
