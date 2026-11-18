// FeatureDialog.tsx — the property dialog of a feature, generated from the feature type's schema
// (core/feature.ts ParamField).  A feature file never writes dialog code: it lists its fields.
//
// The dialog edits a draft (studio.getState().editing); the model previews it; ✓ commits it as one change.
//
// How it behaves (ui/fields.ts holds the rules, studio.ts applies them):
//   • a field that takes geometry listens while it is active (outlined): every click in the model adds to it,
//     a click on something it holds takes that out, a click on nothing changes nothing.  It lists what it
//     holds, each with a × and all with Clear, and what it holds stays highlighted on the model;
//   • a number shows the document's unit, takes any unit typed with it ("1 in", "25.4 mm"), expressions and
//     variables; ↑ and ↓ step it, dragging its label scrubs it;
//   • Tab moves between the geometry fields, Esc puts the active one down and then cancels, Enter accepts;
//   • the frame is DialogShell: it stays where it was put and folds to its title.
import { useEffect, useRef, useState } from "react";
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import { cx } from "../../../shared/util";
import type { ParamField } from "../core/feature";
import { DEFAULT_PLANES, type DefaultPlaneId } from "../core/geometry";
import { fieldFactor, fieldText, fieldUnit, num, parseField, quantityOf, type Units } from "../document/units";
import { EXPR_KEY, UNIT_KEY, exprUnitsOf, exprsOf, lookupOf, variableValues, variablesOf } from "../document/variables";
import { targetsIn } from "../features/_refs";
import type { Pick } from "../viewport/modelview";
import { DialogShell } from "./DialogShell";
import { describeKinds, heldItems, nextEmptyField, pickKindsFor, type HeldItem } from "./fields";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import { featureDef, type PartStudio } from "./studio";
import { tipHandlers } from "./Tip";

const row = "grid grid-cols-[104px_minmax(0,1fr)] items-start gap-x-2 gap-y-1 min-h-7";
const labelCls = "text-ink-2 truncate leading-7";

/** The step ↑, ↓ and scrubbing move a number by, in the unit the field shows. */
function stepOf(field: Extract<ParamField, { kind: "number" }>, u: Units): number {
  const q = quantityOf(field.unit);
  if (q === "length") return u.length === "mm" ? (field.step ?? 1) : u.length === "cm" ? 0.1 : u.length === "m" ? 0.001 : u.length === "in" ? 0.0625 : 0.01;
  if (q === "angle") return u.angle === "deg" ? (field.step ?? 1) : 0.01;
  return field.step ?? 1;
}

function NumberField({ studio, field, params }: { studio: PartStudio; field: Extract<ParamField, { kind: "number" }>; params: JsonObject }) {
  const u = useStudio(studio, (s) => s.units);
  const q = quantityOf(field.unit), factor = fieldFactor(q, u);
  const value = params[field.key];
  const exprs = exprsOf(params), expr: string | undefined = exprs[field.key];
  const shown = expr ?? (typeof value === "number" ? fieldText(value, q, u) : "");
  const [text, setText] = useState(shown);
  const lookup = lookupOf(variableValues(studio.doc ? variablesOf(studio.doc) : []));
  // an expression keeps the unit its bare numbers were typed in, so changing the document's units changes no size
  const pinned = expr !== undefined ? exprUnitsOf(params)[field.key] : undefined;
  const read = (t: string) => parseField(t, q, expr !== undefined && t === expr && q !== "none" ? { ...u, ...(q === "length" ? { length: (pinned || "mm") as Units["length"] } : { angle: (pinned || "deg") as Units["angle"] }) } : u, lookup);
  useEffect(() => { if (text !== shown && read(text)?.value !== value) setText(shown); /* the draft changed elsewhere, or the units did */ }, [value, expr, u]);   // eslint-disable-line react-hooks/exhaustive-deps
  const ok = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v) && (field.min === undefined || v >= field.min - 1e-9) && (field.max === undefined || v <= field.max + 1e-9);
  const typed = read(text), bad = !typed || !ok(typed.value);
  const commit = (t: string) => {
    setText(t);
    const r = parseField(t, q, u, lookup); if (!r || !ok(r.value)) return;
    const nextExpr = { ...exprs }, nextUnit = { ...exprUnitsOf(params) };
    delete nextExpr[field.key]; delete nextUnit[field.key];
    if (r.isExpression) {
      nextExpr[field.key] = t.trim();
      const unit = q === "length" ? u.length : q === "angle" ? u.angle : "";
      if (unit && unit !== "mm" && unit !== "deg") nextUnit[field.key] = unit;
    }
    studio.setDraft({ params: { [field.key]: r.value, [EXPR_KEY]: Object.keys(nextExpr).length ? nextExpr : null, [UNIT_KEY]: Object.keys(nextUnit).length ? nextUnit : null } });
  };
  /** Move the value by `n` steps: only a plain number steps; an expression is the person's own. */
  const nudge = (n: number, from?: number) => {
    const base = from ?? (typed && !typed.isExpression ? typed.value / factor : null);
    if (base === null) return;
    const next = Math.round((base + n * stepOf(field, u)) * 1e6) / 1e6;
    if (ok(next * factor)) commit(num(next, 6));
  };
  const scrub = (ev: React.PointerEvent) => {
    if (ev.button !== 0 || !typed || typed.isExpression) return;
    ev.preventDefault();
    const x0 = ev.clientX, base = typed.value / factor;
    const move = (e: PointerEvent) => nudge(Math.round((e.clientX - x0) / 6) * (e.shiftKey ? 10 : 1), base);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.style.cursor = ""; };
    document.body.style.cursor = "ew-resize";
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const unit = fieldUnit(q, u);
  return (
    <div className={row} data-field={field.key}>
      <span className={cx(labelCls, "cursor-ew-resize select-none")} {...tipHandlers({ title: field.label, hint: `${field.hint ? field.hint + " " : ""}Drag to change it, or use ↑ and ↓ in the box (Shift: ten steps).` })} onPointerDown={scrub}>{field.label}</span>
      <span className="flex items-center gap-1.5 h-7">
        <input className={cx("input mono w-full", bad && "bad")} inputMode="decimal" value={text} data-param={field.key} aria-label={field.label} aria-invalid={bad || undefined}
          title={typed && typed.isExpression && !bad ? `= ${fieldText(typed.value, q, u)}${unit ? " " + unit : ""}` : bad ? "This does not come to a number the field can take." : undefined}
          onChange={(ev) => commit(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === "ArrowUp" || ev.key === "ArrowDown") { ev.preventDefault(); nudge((ev.key === "ArrowUp" ? 1 : -1) * (ev.shiftKey ? 10 : 1)); } }} />
        {unit ? <span className="flex-none w-6 text-ink-3 font-mono text-xs" data-unit={unit}>{unit}</span> : null}
      </span>
    </div>
  );
}

/** A field that is filled by clicking in the model: it lists what it holds and listens while it is active. */
function PickList({ studio, param, armed, items, empty, onArm, onClear, onRemove, single, children }: {
  studio: PartStudio; param: string; armed: boolean; items: HeldItem[]; empty: string; onArm(): void; onClear?(): void; onRemove?(index: number): void; single?: boolean; children?: React.ReactNode;
}) {
  const light = (item: HeldItem | null) => studio.view.setFeatureHover(item && item.pick ? [{ ...item.pick, point: [0, 0, 0] } as Pick] : null);
  useEffect(() => () => studio.view.setFeatureHover(null), [studio]);
  return (
    <div className={cx("flex flex-col rounded-sm border bg-panel cursor-pointer", armed ? "border-blue outline outline-1 outline-blue" : "border-line")} data-param={param} data-armed={armed || undefined} data-count={items.length}
      onClick={onArm} {...tipHandlers({ title: armed ? "Listening" : "Click to choose", hint: armed ? "Click in the model to add; click a chosen one to take it out. Esc or a click here stops." : "Then click in the model." })}>
      {items.length ? (
        <div className="flex flex-col max-h-28 overflow-y-auto py-0.5" role="list">
          {items.map((item, i) => (
            <div key={item.key} role="listitem" className="group flex items-center gap-1 h-5.5 pl-1.5 pr-0.5 hover:bg-sel-soft" data-held={item.key} onPointerEnter={() => light(item)} onPointerLeave={() => light(null)}>
              <span className="flex-1 truncate">{item.label}</span>
              {onRemove ? <button type="button" className="btn sm ghost p-0 w-5 h-5 min-h-0 justify-center text-ink-3 opacity-60 group-hover:opacity-100" aria-label={`Remove ${item.label}`} data-held-remove onClick={(ev) => { ev.stopPropagation(); light(null); onRemove(i); }}>×</button> : null}
            </div>
          ))}
        </div>
      ) : <span className={cx("px-1.5 leading-6", armed ? "text-ink-2" : "text-ink-3")}>{empty}</span>}
      {!single && items.length > 1 && onClear ? (
        <div className="flex items-center gap-1 px-1.5 h-5.5 border-t border-line text-xs text-ink-3">
          <span className="flex-1" data-held-count>{items.length} chosen</span>
          <button type="button" className="btn sm ghost h-5 min-h-0 px-1 text-xs" data-held-clear onClick={(ev) => { ev.stopPropagation(); onClear(); }}>Clear</button>
        </div>
      ) : null}
      {children}
    </div>
  );
}

function Field({ studio, field, params }: { studio: PartStudio; field: ParamField; params: JsonObject }) {
  const armed = useStudio(studio, (s) => s.editing?.field === field.key);
  const features = useStudio(studio, (s) => s.features);
  const bodies = useStudio(studio, (s) => s.bodies);
  const draftId = useStudio(studio, (s) => s.editing?.draft.id);
  if (field.kind === "number") return <NumberField studio={studio} field={field} params={params} />;
  const value = params[field.key];
  const set = (v: JsonObject[string]) => studio.setDraft({ params: { [field.key]: v } });
  const arm = () => studio.setField(armed ? null : field.key);
  const names = { feature: (id: string) => features.find((f) => f.id === id)?.name, body: (id: string) => bodies.find((b) => b.id === id)?.name };
  const what = describeKinds(pickKindsFor(field));
  let control: JSX.Element;
  switch (field.kind) {
    case "boolean": control = <span className="flex items-center h-7"><input type="checkbox" checked={!!value} data-param={field.key} aria-label={field.label} onChange={(ev) => set(ev.target.checked)} /></span>; break;
    case "text": control = <input className="input w-full" value={String(value ?? "")} data-param={field.key} aria-label={field.label} onChange={(ev) => set(ev.target.value)} />; break;
    case "enum":
      control = field.options.length <= 4
        ? <span className="seg" data-param={field.key}>{field.options.map((o) => <button key={o.value} type="button" className={cx(value === o.value && "on")} onClick={() => set(o.value)}>{o.label}</button>)}</span>
        : <select className="input w-full" value={String(value ?? "")} data-param={field.key} onChange={(ev) => set(ev.target.value)}>{field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
      break;
    case "profile": {
      const me = features.findIndex((f) => f.id === draftId);
      const sketches = features.filter((f, i) => f.featureType === "sketch" && (me < 0 || i < me));
      const cur = (value as { sketch?: string } | null)?.sketch || "";
      // which of the sketch's regions are used: all of them, or the ones clicked in the viewport
      const chosen = (value as { regions?: string[] | null } | null)?.regions || null;
      const all = cur ? (studio.getState().sketches.find((v) => v.featureId === cur)?.regions.length ?? 0) : 0;
      const used = chosen ? chosen.length : all;
      control = (
        <span className="flex flex-col gap-1 min-w-0">
          <span className={cx("flex rounded-sm", armed && "outline outline-1 outline-blue")}>
            <select className="input w-full" value={cur} data-param={field.key} aria-label={field.label} onFocus={() => { if (!armed) studio.setField(field.key); }}
              onChange={(ev) => set(ev.target.value ? { sketch: ev.target.value, regions: null } : null)}>
              <option value="">{sketches.length ? "Click a sketch" : "Draw a sketch first"}</option>
              {sketches.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </span>
          {cur && all > 1 ? (
            <span className="flex items-center gap-1.5 text-xs text-ink-2" data-regions={chosen ? chosen.join(" ") : "all"}>
              <span className="flex-1">{chosen ? `${used} of ${all} regions` : `All ${all} regions`}{armed ? ": click a region to choose" : ""}</span>
              {chosen ? <button type="button" className="btn sm ghost h-5 px-1" data-act="all-regions" onClick={() => set({ sketch: cur, regions: null })}>All</button>
                : !armed ? <button type="button" className="btn sm ghost h-5 px-1" data-act="pick-regions" onClick={() => studio.setField(field.key)}>Choose</button> : null}
            </span>
          ) : null}
        </span>
      );
      break;
    }
    case "plane": {
      const items = heldItems(field, value ?? ({ kind: "plane", plane: "top" } as unknown as JsonObject), names);
      const now = items[0]?.key;
      control = (
        <span className="flex flex-col gap-1">
          <PickList studio={studio} param={field.key} armed={armed} items={items} empty="Click a plane or a flat face" onArm={arm} single />
          <span className="seg">{(Object.keys(DEFAULT_PLANES) as DefaultPlaneId[]).map((id) => <button key={id} type="button" data-plane={id} className={cx(now === `plane:${id}` && "on")} onClick={() => studio.fillField(field.key, { kind: "plane", plane: id, point: [0, 0, 0] })}>{DEFAULT_PLANES[id].title}</button>)}</span>
        </span>
      );
      break;
    }
    case "refs": {
      const refs = targetsIn(value);
      const items = heldItems(field, value, names);
      control = <PickList studio={studio} param={field.key} armed={armed} items={items} empty={armed ? `Click ${what} in the model` : `Click here, then ${what}`} onArm={arm} onClear={() => studio.clearField(field.key)} onRemove={(i) => studio.clearField(field.key, i)} single={field.single} />;
      if (field.planes) {
        // the default planes are often behind the model: offer them as buttons too
        const add = (id: DefaultPlaneId) => { const t = { kind: "plane", plane: id }; set(field.single ? t : [...refs.filter((r) => !(r.kind === "plane" && r.plane === id)), t]); };
        control = (
          <span className="flex flex-col gap-1">
            {control}
            <span className="seg">{(Object.keys(DEFAULT_PLANES) as DefaultPlaneId[]).map((id) => <button key={id} type="button" data-plane={id} className={cx(refs.some((r) => r.kind === "plane" && r.plane === id) && "on")} onClick={() => add(id)}>{DEFAULT_PLANES[id].title}</button>)}</span>
          </span>
        );
      }
      break;
    }
    case "features": {
      const me = features.findIndex((f) => f.id === draftId);
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const offered = features.filter((f, i) => (me < 0 || i < me) && (!field.types || field.types.includes(f.featureType)) && !(field.exclude || []).includes(f.featureType));
      control = (
        <span className="flex flex-col gap-0.5 max-h-32 overflow-y-auto rounded-sm border border-line bg-panel px-1 py-0.5" data-param={field.key}>
          {offered.length ? offered.map((f) => {
            const at = ids.indexOf(f.id);
            return (
              <button key={f.id} type="button" data-feature-option={f.id} aria-pressed={at >= 0} className={cx("flex items-center gap-1.5 text-left px-1 rounded-sm", at >= 0 ? "bg-sel text-ink" : "text-ink-2")}
                onPointerEnter={() => studio.setHoverFeature(f.id)} onPointerLeave={() => studio.setHoverFeature(null)}
                onClick={() => set(at >= 0 ? ids.filter((x) => x !== f.id) : [...ids, f.id])}>
                <span className="w-3 font-mono text-xs text-ink-3">{at >= 0 ? at + 1 : ""}</span><span className="truncate">{f.name}</span>
              </button>
            );
          }) : <span className="text-ink-3">Nothing above this feature to choose.</span>}
        </span>
      );
      break;
    }
    case "document": {
      const docs = studio.host.docs.filter((d) => field.docTypes.includes(d.docType));
      const title = (path: string) => (path.split("/").pop() || path).replace(/\.[^.]+$/, "");
      control = (
        <select className="input w-full" value={typeof value === "string" ? value : ""} data-param={field.key} aria-label={field.label} onChange={(ev) => set(ev.target.value || null)}>
          <option value="">{docs.length ? "Choose…" : "The project has none"}</option>
          {docs.map((d) => <option key={d.docId} value={d.docId}>{title(d.path)}</option>)}
        </select>
      );
      break;
    }
    case "bodies": {
      const items = heldItems(field, value, names);
      control = <PickList studio={studio} param={field.key} armed={armed} items={items} empty={armed ? "Click a part in the model" : "Every part"} onArm={arm} onClear={() => studio.clearField(field.key)} onRemove={(i) => studio.clearField(field.key, i)} />;
      break;
    }
  }
  // a row of choices too long for the column beside the label goes under it, the full width of the dialog: no clipped words
  const wide = field.kind === "enum" && field.options.length <= 4 && field.options.reduce((n, o) => n + o.label.length + 3, 0) > 26;
  return (
    <label className={wide ? "flex flex-col gap-0.5 pb-0.5" : row} data-field={field.key} onClick={(ev) => { if (field.kind !== "boolean" && field.kind !== "text") ev.preventDefault(); }}>
      <span className={wide ? "text-ink-2 truncate leading-6" : labelCls} {...(field.hint ? tipHandlers({ title: field.label, hint: field.hint }) : {})}>{field.label}</span>
      {control}
    </label>
  );
}

export function FeatureDialog({ studio }: { studio: PartStudio }) {
  const editing = useStudio(studio, (s) => s.editing);
  const report = useStudio(studio, (s) => (s.editing ? s.reports[s.editing.draft.id] : undefined));
  const later = useStudio(studio, (s) => (s.editing && !s.editing.isNew ? s.features.findIndex((f) => f.id === s.editing!.draft.id) < s.rollback - 1 : false));
  const body = useRef<HTMLDivElement>(null);
  if (!editing) return null;
  const def = featureDef(editing.draft.featureType);
  const params = editing.draft.params;
  const fields = def ? def.schema.filter((f) => !f.visible || f.visible(params)) : [];
  const failed = report && report.status === "error";
  // a new feature that has not been given its geometry yet is not in error: it is waiting, and says for what
  const waiting = !!failed && editing.isNew && !!def && nextEmptyField(def.schema, params) !== null;
  // a new sketch asks only where it goes: a click on a plane and drawing starts
  const sketchPlane = editing.isNew && editing.draft.featureType === "sketch";
  return (
    <DialogShell className="cad-dialog" icon={def?.icon} name={editing.draft.name} onName={(name) => studio.setDraft({ name })} attrs={{ "data-feature": editing.draft.featureType }}
      onAccept={() => studio.acceptFeature()} onCancel={() => studio.cancelFeature()} acceptAttrs={{ "data-accept": true }} cancelAttrs={{ "data-cancel": true }}
      acceptTip={{ title: sketchPlane ? "Start sketching" : "Accept", shortcut: "Enter", hint: sketchPlane ? "Draw on the plane shown." : "Keep the feature as it is previewed." }} cancelTip={{ title: "Cancel", shortcut: "Esc", hint: "Close and change nothing." }}
      onKeyDown={(ev) => {
        if (ev.key === "Escape") { ev.stopPropagation(); if (editing.field && !sketchPlane) studio.setField(null); else studio.cancelFeature(); }
        // Tab from the last control goes round to the first: the keyboard stays in the dialog
        if (ev.key === "Tab" && body.current) {
          const stops = Array.from(body.current.querySelectorAll<HTMLElement>("input,select,button")).filter((e) => !e.hasAttribute("disabled") && e.offsetParent !== null);
          const i = stops.indexOf(document.activeElement as HTMLElement);
          if (stops.length && ((ev.shiftKey && i === 0) || (!ev.shiftKey && i === stops.length - 1))) { ev.preventDefault(); stops[ev.shiftKey ? stops.length - 1 : 0].focus(); }
        }
      }}
      extra={later ? (
        <button type="button" className={cx("btn sm ghost flex-none h-6 min-h-0 px-1.5 text-xs", editing.final && "on")} aria-pressed={!!editing.final} data-final {...tipHandlers({ title: "Final", hint: "Show the finished model, with every later feature built, instead of the model as far as this feature." })} onClick={() => studio.setFinal(!editing.final)}>Final</button>
      ) : null}>
      <div ref={body} className="contents">
        {sketchPlane ? <p className="note m-0">Click a plane or a flat face to draw on.</p> : null}
        {def ? fields.map((f) => <Field key={f.key} studio={studio} field={f} params={params} />) : <p className="note">This Junction does not know the feature type “{editing.draft.featureType}”.</p>}
        {report && report.message ? (
          <div className={cx("callout m-0 flex items-start gap-2", waiting ? "" : failed ? "err" : "warn")} role="status" data-waiting={waiting || undefined}>
            <span className="flex-1">{report.message}</span>
            {waiting ? null : <button type="button" className="btn sm ghost flex-none h-5 min-h-0 px-1 text-xs" data-show-problem onClick={() => studio.zoomToFeature(editing.draft.id)}><Glyph svg='<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.500-4.500"/>' size={12} />Show</button>}
          </div>
        ) : null}
      </div>
    </DialogShell>
  );
}
