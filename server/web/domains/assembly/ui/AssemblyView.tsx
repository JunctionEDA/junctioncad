// AssemblyView.tsx — the assembly's frame: a toolbar drawn from tools/*.ts and one button per mate type
// (mates/*.ts), the instance tree, the mates, the viewport with its dialogs, and whatever panels tools add.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../../../shared/util";
import type { AssemblyEditor, FormDefinition, PanelDefinition } from "./assembly";
import { InsertDialog } from "./InsertDialog";
import { InstanceList } from "./InstanceList";
import { MateDialog } from "./MateDialog";
import { MateList } from "./MateList";
import { Caption, Glyph, useAssembly } from "./parts";

function Toolbar({ assembly }: { assembly: AssemblyEditor }) {
  const s = useAssembly(assembly, (x) => x);
  const tools = assembly.tools().slice().sort((a, b) => (a.order ?? 1e6) - (b.order ?? 1e6) || a.title.localeCompare(b.title));
  const mates = assembly.mateTypes().slice().sort((a, b) => (a.order ?? 1e6) - (b.order ?? 1e6) || a.title.localeCompare(b.title));
  // As in the part studio: the bar does not scroll sideways in a window of ordinary width.  When the buttons do
  // not fit, the mates lose their labels first (density 1), then the tools (2); a tooltip names every button.
  const bar = useRef<HTMLDivElement>(null);
  const [density, setDensity] = useState(0);
  const needs = useRef<(number | undefined)[]>([]);
  useLayoutEffect(() => {
    const el = bar.current; if (!el) return;
    const fit = () => {
      let need = 12;
      for (const c of Array.from(el.children)) need += (c as HTMLElement).offsetWidth + 2;
      const room = el.clientWidth, at = needs.current;
      at[density] = need;
      if (need > room && density < 2) setDensity(density + 1);
      else if (density > 0 && at[density - 1] !== undefined && at[density - 1]! <= room) setDensity(density - 1);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [density]);
  return (
    <div ref={bar} className="cad-toolbar flex items-center gap-0.5 h-9 px-1.5 bg-bench border-b border-line overflow-x-auto select-none" role="toolbar" aria-label="Assembly tools" data-density={density}>
      {tools.map((t) => {
        const why = t.disabled ? t.disabled(assembly) : null;
        return <button key={t.id} type="button" data-tool={t.title} aria-label={t.title} className={cx("btn sm ghost flex flex-none items-center gap-1.5 px-1.5", t.active && t.active(assembly) && "on", why && "opacity-45")} aria-disabled={!!why} title={why ? `${t.title}: ${why}` : `${t.title}${t.key ? ` (${t.key.toUpperCase()})` : ""}${t.hint ? `\n${t.hint}` : ""}`} onClick={() => { if (!why) t.run(assembly); }}><Glyph svg={t.icon} />{density < 2 ? <span>{t.title}</span> : null}</button>;
      })}
      <span className="flex-none w-px h-5 mx-1 bg-line" />
      <span className="flex flex-none items-center gap-0.5" data-group="mates">
        {mates.filter((m) => m.solve).map((m) => (
          <button key={m.type} type="button" data-mate-tool={m.type} aria-label={`${m.title} mate`} className={cx("btn sm ghost flex flex-none items-center gap-1.5 px-1.5", s.mating?.isNew && s.mating.mateType === m.type && "on", !s.canEdit && "opacity-45")} aria-disabled={!s.canEdit}
            title={s.canEdit ? `${m.title} mate\nThen click a connector on each of two instances.` : `${m.title}: you have view-only access`} onClick={() => { if (!s.canEdit) return; if (s.mating?.isNew && s.mating.mateType === m.type) assembly.cancelMate(); else { if (s.mating) assembly.cancelMate(); assembly.startMate(m.type); } }}>
            <Glyph svg={m.icon} />{density < 1 ? <span>{m.title}</span> : null}
          </button>
        ))}
      </span>
    </div>
  );
}

function FormDialog({ assembly, form }: { assembly: AssemblyEditor; form: FormDefinition }) {
  const [values, setValues] = useState<{ [key: string]: string }>(() => Object.fromEntries(form.fields.map((f) => [f.key, String(f.value)])));
  const bad = form.fields.some((f) => f.kind === "number" && (values[f.key].trim() === "" || !Number.isFinite(Number(values[f.key]))));
  return (
    <form className="cad-dialog absolute left-2 top-2 z-[5] w-[280px] flex flex-col rounded-md border border-line bg-bench shadow-panel text-sm" data-form={form.title}
      onSubmit={(ev) => { ev.preventDefault(); if (bad) return; assembly.ask(null); form.accept(Object.fromEntries(form.fields.map((f) => [f.key, f.kind === "number" ? Number(values[f.key]) : values[f.key]]))); }}
      onKeyDown={(ev) => { if (ev.key === "Escape") { ev.stopPropagation(); assembly.ask(null); } }}>
      <header className="flex items-center h-8 px-2 border-b border-line bg-paper rounded-t-md font-semibold text-base">{form.title}</header>
      <div className="flex flex-col gap-1.5 p-2">
        {form.fields.map((f, i) => (
          <label key={f.key} className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-x-2 min-h-7">
            <span className="text-ink-2 truncate">{f.label}</span>
            <span className="flex items-center gap-1.5">
              <input autoFocus={i === 0} className={cx("input w-full", f.kind === "number" && "mono")} inputMode={f.kind === "number" ? "decimal" : undefined} value={values[f.key]} data-param={f.key} aria-label={f.label} onChange={(ev) => setValues({ ...values, [f.key]: ev.target.value })} />
              {f.unit ? <span className="text-ink-3 font-mono text-xs w-5">{f.unit}</span> : null}
            </span>
          </label>
        ))}
      </div>
      <footer className="flex justify-end gap-1.5 p-2 border-t border-line">
        <button type="button" className="btn sm" onClick={() => assembly.ask(null)}>Cancel</button>
        <button type="submit" className="btn sm primary" data-accept disabled={bad}>{form.acceptLabel || "Done"}</button>
      </footer>
    </form>
  );
}

function Panel({ assembly, panel }: { assembly: AssemblyEditor; panel: PanelDefinition }) {
  return (
    <section className="flex flex-col min-h-0 flex-[1_1_0] border-b border-line last:border-b-0" data-panel={panel.id}>
      <Caption right={<button type="button" className="btn sm ghost px-1" title="Close" aria-label={`Close ${panel.title}`} onClick={() => assembly.closePanel(panel.id)}>×</button>}>{panel.title}</Caption>
      <div className="flex-1 min-h-0 overflow-auto bg-paper text-sm">{panel.render(assembly)}</div>
    </section>
  );
}

function StatusNote({ assembly }: { assembly: AssemblyEditor }) {
  const s = useAssembly(assembly, (x) => x);
  let text: string, tone = "";
  if (!s.loaded) text = s.status.state === "error" ? s.status.text : "Opening the assembly…";
  else if (s.kernelFailure) { text = s.kernelFailure; tone = "err"; }
  else if (s.readout) text = s.readout;
  else if (s.connecting) text = "Click a face, an edge or a point to put a mate connector there. Esc to stop.";
  else if (s.building) text = s.building === 1 ? "Building a part…" : `Building ${s.building} parts…`;
  else if (!s.instances.length) text = "An empty assembly. Insert parts to begin; right-drag turns the view, the wheel zooms.";
  else {
    const bad = s.mates.filter((m) => { const st = s.mateInfo[m.id]?.state; return st === "conflict" || st === "error"; }).length;
    if (bad) { text = `${bad} mate${bad === 1 ? " has" : "s have"} a problem: see the list`; tone = "err"; }
    else if (s.dof === null) text = `${s.instances.length} instances`;
    else if (s.dof === 0) text = "Fully held: nothing can move";
    else text = `${s.dof} freedom${s.dof === 1 ? "" : "s"} left: drag a part to move it`;
  }
  return <div className={cx("cad-note absolute left-2 bottom-2 z-[2] px-2 py-0.5 rounded-sm border border-line bg-panel text-xs pointer-events-none", tone === "err" ? "text-err" : "text-ink-2")} role="status" data-status-note data-dof={s.dof ?? ""} data-building={s.building}>{text}</div>;
}

function ExplodeBar({ assembly }: { assembly: AssemblyEditor }) {
  const on = useAssembly(assembly, (s) => s.exploding), k = useAssembly(assembly, (s) => s.explode);
  if (!on) return null;
  return (
    <div className="absolute left-1/2 -translate-x-1/2 top-2 z-[3] flex items-center gap-2 h-8 px-2 rounded-md border border-line bg-bench shadow-panel text-sm" data-explode>
      <span className="text-ink-2">Exploded view</span>
      <input type="range" min={0} max={2} step={0.02} value={k} aria-label="How far apart" onChange={(ev) => assembly.setExplode(Number(ev.target.value))} />
      <button type="button" className="btn sm" onClick={() => assembly.setExploding(false)}>Done</button>
    </div>
  );
}

export function AssemblyView({ assembly, canvasHost }: { assembly: AssemblyEditor; canvasHost: HTMLElement }) {
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => { stage.current?.prepend(canvasHost); return () => canvasHost.remove(); }, [canvasHost]);
  const panels = useAssembly(assembly, (s) => s.panels);
  const form = useAssembly(assembly, (s) => s.form);
  const left = panels.filter((p) => p.side === "left"), right = panels.filter((p) => p.side !== "left" && p.side !== "bottom"), bottom = panels.filter((p) => p.side === "bottom");
  return (
    <div className="cad-root grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] text-ink" data-doc-kind="assembly"
      onKeyDown={(ev) => { const t = ev.target as HTMLElement; if (t === assembly.viewport.canvas || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable) return; assembly.handleKey(ev.nativeEvent); }}>
      <Toolbar assembly={assembly} />
      <div className="flex min-h-0 min-w-0">
        <aside className="cad-dock flex flex-col min-h-0 w-60 flex-none bg-bench border-r border-line">
          <InstanceList assembly={assembly} />
          <MateList assembly={assembly} />
          {left.map((p) => <Panel key={p.id} assembly={assembly} panel={p} />)}
        </aside>
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          <div ref={stage} className="cad-stage relative flex-1 min-w-0 min-h-0 overflow-hidden">
            <MateDialog assembly={assembly} />
            <InsertDialog assembly={assembly} />
            {form ? <FormDialog key={form.title} assembly={assembly} form={form} /> : null}
            <ExplodeBar assembly={assembly} />
            <StatusNote assembly={assembly} />
          </div>
          {bottom.length ? <aside className="cad-dock flex flex-col min-h-0 h-[38%] flex-none bg-bench border-t border-line" data-side="bottom">{bottom.map((p) => <Panel key={p.id} assembly={assembly} panel={p} />)}</aside> : null}
        </div>
        {right.length ? <aside className="cad-dock flex flex-col min-h-0 w-72 flex-none bg-bench border-l border-line">{right.map((p) => <Panel key={p.id} assembly={assembly} panel={p} />)}</aside> : null}
      </div>
    </div>
  );
}
