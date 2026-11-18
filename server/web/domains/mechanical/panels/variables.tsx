// The Variables panel: the part studio's variables (name = expression) and their values.  Any number field of
// a feature dialog takes an expression that uses them (document/variables.ts).  An edit is committed when the
// field is left or Enter is pressed, as one undoable change that also brings the features' numbers up to date.
import { useState } from "react";
import { cx } from "../../../shared/util";
import { definePanel } from "../core/tool";
import { addVariable, deleteVariable, freeName, nameProblem, setVariable, usersOf, variableValues, variablesOf, type VariableItem } from "../document/variables";
import { useStudio } from "../ui/hooks";
import type { PartStudio } from "../ui/studio";

const fmt = (v: number) => String(Math.round(v * 1e6) / 1e6);

function Row({ studio, v, value, error, names, canEdit }: { studio: PartStudio; v: VariableItem; value: number | undefined; error: string | undefined; names: string[]; canEdit: boolean }) {
  const [name, setName] = useState<string | null>(null);
  const [expr, setExpr] = useState<string | null>(null);
  const nameBad = name !== null && name !== v.name ? nameProblem(name.trim(), names.filter((n) => n !== v.name)) : null;
  const commit = () => {
    const doc = studio.doc; if (!doc) return;
    const patch: { name?: string; expr?: string } = {};
    if (name !== null && name.trim() !== v.name && !nameBad) patch.name = name.trim();
    if (expr !== null && expr !== v.expr && expr.trim()) patch.expr = expr.trim();
    setName(null); setExpr(null);
    const changes = setVariable(doc, v.id, patch);
    if (changes.length) studio.commit(changes);
  };
  const keys = (ev: React.KeyboardEvent<HTMLInputElement>) => { if (ev.key === "Enter") { ev.preventDefault(); (ev.target as HTMLInputElement).blur(); } else if (ev.key === "Escape") { setName(null); setExpr(null); (ev.target as HTMLInputElement).blur(); } };
  const used = studio.doc ? usersOf(studio.doc, v.name).length : 0;
  return (
    <div role="listitem" data-variable={v.name} className="grid grid-cols-[minmax(0,5fr)_auto_minmax(0,7fr)_auto] items-center gap-1 px-1.5 py-0.5">
      <input className={cx("input mono h-6 min-w-0", nameBad && "bad")} value={name ?? v.name} disabled={!canEdit} aria-label="Variable name" title={nameBad || undefined}
        onChange={(ev) => setName(ev.target.value)} onBlur={commit} onKeyDown={keys} />
      <span className="text-ink-3">=</span>
      <input className={cx("input mono h-6 min-w-0", error && "bad")} value={expr ?? v.expr} disabled={!canEdit} aria-label={`Value of ${v.name}`} title={error || undefined}
        onChange={(ev) => setExpr(ev.target.value)} onBlur={commit} onKeyDown={keys} />
      <button type="button" className="btn sm ghost px-1" disabled={!canEdit} title={used ? `Delete (used by ${used} feature${used === 1 ? "" : "s"}, which keep their last value)` : "Delete"} aria-label={`Delete ${v.name}`}
        onClick={() => { const doc = studio.doc; if (doc) studio.commit(deleteVariable(doc, v.id)); }}>×</button>
      <span className={cx("col-start-3 col-span-2 font-mono text-xs truncate", error ? "text-err" : "text-ink-3")} data-value={value ?? ""}>{error ? error : value !== undefined ? `= ${fmt(value)}` : ""}</span>
    </div>
  );
}

function Variables({ studio }: { studio: PartStudio }) {
  useStudio(studio, (s) => s.features);   // a new list on every change of the document: re-read the variables
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const doc = studio.doc;
  if (!doc) return null;
  const vars = variablesOf(doc);
  const { values, errors } = variableValues(vars);
  const names = vars.map((v) => v.name);
  return (
    <div className="flex flex-col py-1 text-sm" role="list" aria-label="Variables">
      {vars.map((v) => <Row key={v.id} studio={studio} v={v} value={values.get(v.name)} error={errors.get(v.id)} names={names} canEdit={canEdit} />)}
      {!vars.length ? <p className="note px-2 m-0">No variables. Add one, then type its name in any number of a feature, as in “width / 2”.</p> : null}
      <div className="px-1.5 pt-1">
        <button type="button" className="btn sm" disabled={!canEdit} data-add-variable onClick={() => { const { changes } = addVariable(doc, freeName(doc), "10"); studio.commit(changes); }}>Add variable</button>
      </div>
    </div>
  );
}

export default definePanel({ id: "variables", title: "Variables", side: "right", order: 10, render: (studio) => <Variables studio={studio} /> });
