// MateList.tsx — the mates of the assembly with their state: the value a mate has now, a conflict or a lost
// reference with the reason, suppressed.  Double-click edits a mate; a right-click offers the rest.  Below it,
// the named positions when there are any.
import { useState } from "react";
import { cx } from "../../../shared/util";
import type { MateItem } from "../document/format";
import type { MateInfo } from "../model/problem";
import { mateDef, type AssemblyEditor } from "./assembly";
import { NameField } from "./InstanceList";
import { Caption, ContextMenu, Glyph, useAssembly, type MenuState } from "./parts";

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

function valueText(m: MateItem, info: MateInfo | undefined): string {
  const values = mateDef(m.mateType)?.solve?.values;
  if (!info || !values || info.state !== "ok") return "";
  return values.map((v) => (v.unit === "deg" ? `${round(info.values[v.key] ?? 0, 1)}°` : `${round(info.values[v.key] ?? 0, 2)} mm`)).join("  ");
}

export function MateList({ assembly }: { assembly: AssemblyEditor }) {
  const s = useAssembly(assembly, (x) => x);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const selected = new Set(s.selection);
  const bad = s.mates.filter((m) => { const st = s.mateInfo[m.id]?.state; return st === "conflict" || st === "error"; }).length;
  const openMenu = (m: MateItem, ev: React.MouseEvent) => {
    ev.preventDefault();
    if (!selected.has(m.id)) assembly.select(m.id);
    const ids = selected.has(m.id) ? s.selection.filter((x) => s.mates.some((y) => y.id === x)) : [m.id], ro = !s.canEdit;
    setMenu({ x: ev.clientX, y: ev.clientY, items: [
      { label: "Edit…", run: () => assembly.editMate(m.id), disabled: ro },
      { label: "Rename", run: () => assembly.startRename(m.id), disabled: ro },
      { label: m.suppressed ? "Unsuppress" : "Suppress", run: () => assembly.setMateSuppressed(ids, !m.suppressed), disabled: ro },
      { label: "Select its instances", run: () => assembly.select([m.a.instance, m.b.instance]) },
      { label: "Delete", run: () => assembly.remove(ids), danger: true, disabled: ro },
    ] });
  };
  return (
    <>
      <section className="flex flex-col min-h-0 flex-[1_1_0] border-b border-line last:border-b-0" data-panel="mates">
        <Caption right={bad ? <span className="font-normal text-err text-xs" data-conflicts>{bad} with a problem</span> : null}>Mates</Caption>
        <div className="flex-1 min-h-0 overflow-y-auto bg-paper py-1 text-sm outline-none" role="listbox" tabIndex={0} aria-label="Mates" onClick={(ev) => { if (ev.target === ev.currentTarget) assembly.select(null); }}>
          {s.mates.map((m) => {
            const def = mateDef(m.mateType), info = s.mateInfo[m.id], st = info?.state;
            const problem = st === "conflict" || st === "error";
            return (
              <div key={m.id} role="option" aria-selected={selected.has(m.id)} data-mate={m.name} data-state={st} title={info?.message || def?.title || m.mateType}
                className={cx("flex items-center gap-1.5 h-6.5 px-2 cursor-default", selected.has(m.id) ? "bg-sel" : "hover:bg-sel-soft", (m.suppressed || st === "inactive") && "text-ink-3", problem && "text-err")}
                onClick={(ev) => assembly.select(m.id, { toggle: ev.ctrlKey || ev.metaKey })} onDoubleClick={() => assembly.editMate(m.id)} onContextMenu={(ev) => openMenu(m, ev)}>
                <Glyph svg={def?.icon} size={15} />
                {s.renaming === m.id ? <NameField name={m.name} done={(n) => (n === null ? assembly.startRename(null) : assembly.rename(m.id, n))} /> : <span className={cx("flex-1 truncate", m.suppressed && "line-through")}>{m.name}</span>}
                <span className="flex-none text-xs font-mono text-ink-3" data-value>{valueText(m, info)}</span>
                {problem ? <span className="flex-none text-xs font-semibold" data-problem>{st === "conflict" ? "conflict" : "!"}</span> : null}
                {st === "unknown-type" || st === "inactive" || st === "pending" ? <span className="flex-none text-xs text-ink-3">{st === "pending" ? "…" : st === "inactive" ? "off" : "?"}</span> : null}
              </div>
            );
          })}
          {s.loaded && !s.mates.length ? <p className="note px-2 m-0">No mates yet. Choose a mate in the toolbar, then click a connector on each of two instances.</p> : null}
        </div>
        <ContextMenu menu={menu} close={() => setMenu(null)} />
      </section>
      {s.connectors.length ? (
        <section className="flex flex-col min-h-0 flex-[0_1_auto] max-h-[30%] border-b border-line last:border-b-0" data-panel="connectors">
          <Caption>Mate connectors</Caption>
          <div className="min-h-0 overflow-y-auto bg-paper py-1 text-sm" role="listbox" aria-label="Mate connectors">
            {s.connectors.map((c) => {
              const owner = s.instances.find((i) => i.id === c.instance), o = c.offset || [0, 0, 0];
              return (
                <div key={c.id} role="option" aria-selected={selected.has(c.id)} data-connector-row={c.name} className={cx("flex items-center gap-1.5 h-6.5 px-2 cursor-default", selected.has(c.id) ? "bg-sel" : "hover:bg-sel-soft")}
                  title="An explicit mate connector: click its mark in the model when making a mate" onClick={() => assembly.select(c.id)} onDoubleClick={() => { if (s.canEdit) assembly.startRename(c.id); }}
                  onContextMenu={(ev) => { ev.preventDefault(); assembly.select(c.id); setMenu({ x: ev.clientX, y: ev.clientY, items: [
                    { label: "Move or turn…", disabled: !s.canEdit, run: () => assembly.ask({ title: c.name, fields: [{ key: "x", label: "Along X", kind: "number", value: o[0], unit: "mm" }, { key: "y", label: "Along Y", kind: "number", value: o[1], unit: "mm" }, { key: "z", label: "Along its axis", kind: "number", value: o[2], unit: "mm" }, { key: "r", label: "Turn", kind: "number", value: c.rotation || 0, unit: "°" }], accept: (v) => assembly.editConnector(c.id, { offset: [Number(v.x), Number(v.y), Number(v.z)], rotation: Number(v.r) }) }) },
                    { label: c.flip ? "Unflip" : "Flip", disabled: !s.canEdit, run: () => assembly.editConnector(c.id, { flip: !c.flip }) },
                    { label: "Rename", disabled: !s.canEdit, run: () => assembly.startRename(c.id) },
                    { label: "Delete", danger: true, disabled: !s.canEdit, run: () => assembly.remove([c.id]) },
                  ] }); }}>
                  {s.renaming === c.id ? <NameField name={c.name} done={(n) => (n === null ? assembly.startRename(null) : assembly.rename(c.id, n))} /> : <span className="flex-1 truncate">{c.name}</span>}
                  <span className="flex-none text-xs text-ink-3 truncate max-w-[45%]">{owner ? owner.name : "?"}</span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      {s.positions.length ? (
        <section className="flex flex-col min-h-0 flex-[0_1_auto] max-h-[30%] border-b border-line last:border-b-0" data-panel="positions">
          <Caption>Named positions</Caption>
          <div className="min-h-0 overflow-y-auto bg-paper py-1 text-sm" role="listbox" aria-label="Named positions">
            {s.positions.map((p) => (
              <div key={p.id} role="option" aria-selected={selected.has(p.id)} data-position={p.name} className={cx("flex items-center gap-1.5 h-6.5 px-2 cursor-default", selected.has(p.id) ? "bg-sel" : "hover:bg-sel-soft")}
                title="Click to move the instances to this position" onClick={() => assembly.applyPosition(p.id)} onDoubleClick={() => { if (s.canEdit) assembly.startRename(p.id); }}
                onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, items: [{ label: "Go to this position", run: () => assembly.applyPosition(p.id), disabled: !s.canEdit }, { label: "Rename", run: () => assembly.startRename(p.id), disabled: !s.canEdit }, { label: "Delete", run: () => assembly.remove([p.id]), danger: true, disabled: !s.canEdit }] }); }}>
                {s.renaming === p.id ? <NameField name={p.name} done={(n) => (n === null ? assembly.startRename(null) : assembly.rename(p.id, n))} /> : <span className="flex-1 truncate">{p.name}</span>}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
