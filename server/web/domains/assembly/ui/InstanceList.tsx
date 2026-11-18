// InstanceList.tsx — the instance tree: every instance of the assembly, in groups, with what each one's state is
// (fixed, how many freedoms are left, hidden, suppressed, a source that failed) and everything that can be done
// to it from a right-click: rename, fix, hide, suppress, replace, group, delete.
import { useState } from "react";
import { cx } from "../../../shared/util";
import type { InstanceItem } from "../document/format";
import type { AssemblyEditor, InstanceInfo } from "./assembly";
import { Caption, ContextMenu, Glyph, ICONS, useAssembly, type MenuItem, type MenuState } from "./parts";

function badge(i: InstanceItem, info: InstanceInfo | undefined): { text: string; title: string; tone?: "err" | "dim" } | null {
  if (i.suppressed) return { text: "suppressed", title: "Suppressed: not shown, and its mates are not applied.", tone: "dim" };
  if (!info) return null;
  if (info.status === "error") return { text: "!", title: info.message || "This instance could not be loaded.", tone: "err" };
  if (info.status === "loading") return { text: "…", title: info.message || "Loading", tone: "dim" };
  if (i.fixed) return { text: "fixed", title: "Fixed: it stays where it is." };
  if (info.grounded) return { text: "held", title: "Fastened to a fixed instance: it cannot move." };
  if (info.dof === null) return null;
  if (info.dof === 0) return { text: "held", title: "Its mates leave it no freedom." };
  return { text: info.dof === 6 ? "free" : `${info.dof} free`, title: info.dof === 6 ? "Nothing holds this instance: drag it anywhere, or mate it." : `Its mates leave ${info.dof} of 6 freedoms: drag it to see them.`, tone: "dim" };
}

export function NameField({ name, done }: { name: string; done(name: string | null): void }) {
  const [text, setText] = useState(name);
  return <input autoFocus className="input flex-1 min-w-0 h-5.5" value={text} aria-label="Name" onChange={(ev) => setText(ev.target.value)} onFocus={(ev) => ev.target.select()}
    onBlur={() => done(text)} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Enter") done(text); else if (ev.key === "Escape") done(null); }} onClick={(ev) => ev.stopPropagation()} />;
}

export function InstanceList({ assembly }: { assembly: AssemblyEditor }) {
  const s = useAssembly(assembly, (x) => x);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const selected = new Set(s.selection);
  const ordered: InstanceItem[] = [];
  const groupIds = new Set(s.groups.map((g) => g.id));
  // the flat order of rows: each group at the place of its first member, then the instances outside any group
  const rows: ({ kind: "group"; id: string } | { kind: "instance"; item: InstanceItem; inGroup: boolean })[] = [];
  const placed = new Set<string>();
  for (const i of s.instances) {
    const g = typeof i.group === "string" && groupIds.has(i.group) ? i.group : null;
    if (g) {
      if (placed.has(g)) continue;
      placed.add(g);
      rows.push({ kind: "group", id: g });
      const group = s.groups.find((x) => x.id === g)!;
      for (const m of s.instances) if (m.group === g) { ordered.push(m); if (!group.collapsed) rows.push({ kind: "instance", item: m, inGroup: true }); }
    } else { ordered.push(i); rows.push({ kind: "instance", item: i, inGroup: false }); }
  }
  for (const g of s.groups) if (!placed.has(g.id)) rows.push({ kind: "group", id: g.id });

  const click = (id: string, ev: React.MouseEvent) => {
    if (ev.shiftKey && anchor) {
      const ids = ordered.map((i) => i.id), a = ids.indexOf(anchor), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) { assembly.select(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
    }
    setAnchor(id);
    assembly.select(id, { toggle: ev.ctrlKey || ev.metaKey });
  };
  const openMenu = (id: string, ev: React.MouseEvent) => {
    ev.preventDefault();
    if (!selected.has(id)) assembly.select(id);
    const ids = selected.has(id) ? s.selection.filter((x) => s.instances.some((i) => i.id === x)) : [id];
    const items = s.instances.filter((i) => ids.includes(i.id));
    if (!items.length) return;
    const one = items.length === 1 ? items[0] : null, ro = !s.canEdit;
    const all = (f: (i: InstanceItem) => boolean) => items.every(f);
    const list: MenuItem[] = [
      { label: "Rename", run: () => assembly.startRename(one!.id), disabled: ro || !one },
      { label: all((i) => !!i.fixed) ? "Unfix" : "Fix", run: () => assembly.setFixed(ids, !all((i) => !!i.fixed)), disabled: ro },
      { label: all((i) => !!i.hidden) ? "Show" : "Hide", run: () => assembly.setHidden(ids, !all((i) => !!i.hidden)), disabled: ro },
      { label: all((i) => !!i.suppressed) ? "Unsuppress" : "Suppress", run: () => assembly.setSuppressed(ids, !all((i) => !!i.suppressed)), disabled: ro },
      { label: "Replace…", run: () => assembly.openInsert(one!.id), disabled: ro || !one },
      { label: "Group", run: () => assembly.group(ids), disabled: ro },
      { label: "Copy in a row…", run: () => assembly.ask({ title: "Copy in a row", acceptLabel: "Copy", fields: [{ key: "count", label: "Copies", kind: "number", value: 2 }, { key: "x", label: "Step X", kind: "number", value: 50, unit: "mm" }, { key: "y", label: "Step Y", kind: "number", value: 0, unit: "mm" }, { key: "z", label: "Step Z", kind: "number", value: 0, unit: "mm" }], accept: (v) => assembly.copyInRow(ids, Number(v.count), [Number(v.x), Number(v.y), Number(v.z)]) }), disabled: ro },
      { label: "Open its source", run: () => assembly.host.openDoc(one!.source.docId), disabled: !one },
      { label: "Delete", run: () => assembly.remove(ids), danger: true, disabled: ro },
    ];
    setMenu({ x: ev.clientX, y: ev.clientY, items: list });
  };
  const groupMenu = (id: string, ev: React.MouseEvent) => {
    ev.preventDefault();
    const members = s.instances.filter((i) => i.group === id).map((i) => i.id), ro = !s.canEdit;
    setMenu({ x: ev.clientX, y: ev.clientY, items: [
      { label: "Rename", run: () => assembly.startRename(id), disabled: ro },
      { label: "Select its instances", run: () => assembly.select(members) },
      { label: "Hide", run: () => assembly.setHidden(members, true), disabled: ro },
      { label: "Show", run: () => assembly.setHidden(members, false), disabled: ro },
      { label: "Ungroup", run: () => assembly.ungroup(id), disabled: ro },
    ] });
  };

  return (
    <section className="flex flex-col min-h-0 flex-[2_1_0] border-b border-line" data-panel="instances">
      <Caption right={<span className="font-normal text-ink-3 text-xs font-mono">{s.instances.length || ""}</span>}>Instances</Caption>
      <div className="flex-1 min-h-0 overflow-y-auto bg-paper py-1 text-sm outline-none" role="listbox" tabIndex={0} aria-label="Instances" aria-multiselectable="true" onClick={(ev) => { if (ev.target === ev.currentTarget) assembly.select(null); }}>
        {rows.map((r) => {
          if (r.kind === "group") {
            const g = s.groups.find((x) => x.id === r.id)!;
            return (
              <div key={g.id} role="option" aria-selected={selected.has(g.id)} data-group={g.name} className={cx("flex items-center gap-1 h-6.5 px-1 cursor-default", selected.has(g.id) ? "bg-sel" : "hover:bg-sel-soft")}
                onClick={() => assembly.select(g.id)} onContextMenu={(ev) => groupMenu(g.id, ev)} onDoubleClick={() => { if (s.canEdit) assembly.startRename(g.id); }}>
                <button type="button" className={cx("btn sm ghost px-0.5 transition-transform", !g.collapsed && "rotate-90")} title={g.collapsed ? "Open the group" : "Close the group"} onClick={(ev) => { ev.stopPropagation(); assembly.setCollapsed(g.id, !g.collapsed); }}><Glyph svg={ICONS.chevron} size={14} /></button>
                <Glyph svg={ICONS.folder} size={15} />
                {s.renaming === g.id ? <NameField name={g.name} done={(n) => (n === null ? assembly.startRename(null) : assembly.rename(g.id, n))} /> : <span className="flex-1 truncate font-medium">{g.name}</span>}
              </div>
            );
          }
          const i = r.item, info = s.instanceInfo[i.id], b = badge(i, info);
          return (
            <div key={i.id} role="option" aria-selected={selected.has(i.id)} data-instance={i.name} data-status={info?.status} title={b?.title}
              className={cx("group flex items-center gap-1.5 h-6.5 pr-2 cursor-default", r.inGroup ? "pl-7" : "pl-2", selected.has(i.id) ? "bg-sel" : "hover:bg-sel-soft", (i.suppressed || i.hidden) && "text-ink-3")}
              onClick={(ev) => click(i.id, ev)} onContextMenu={(ev) => openMenu(i.id, ev)} onDoubleClick={() => { if (s.canEdit) assembly.startRename(i.id); }}>
              <button type="button" className={cx("btn sm ghost px-0.5", !i.hidden && "opacity-0 group-hover:opacity-100 focus:opacity-100")} disabled={!s.canEdit} title={i.hidden ? "Show" : "Hide"} aria-label={i.hidden ? `Show ${i.name}` : `Hide ${i.name}`} data-eye
                onClick={(ev) => { ev.stopPropagation(); assembly.setHidden([i.id], !i.hidden); }}><Glyph svg={i.hidden ? ICONS.eyeOff : ICONS.eye} size={14} /></button>
              {s.renaming === i.id ? <NameField name={i.name} done={(n) => (n === null ? assembly.startRename(null) : assembly.rename(i.id, n))} /> : <span className={cx("flex-1 truncate", i.suppressed && "line-through")}>{i.name}</span>}
              {i.fixed && !i.suppressed ? <Glyph svg={ICONS.pin} size={13} /> : null}
              {b ? <span className={cx("flex-none text-xs", b.tone === "err" ? "text-err font-semibold" : b.tone === "dim" ? "text-ink-3" : "text-ink-2")} data-badge>{b.text}</span> : null}
            </div>
          );
        })}
        {s.loaded && !s.instances.length ? <p className="note px-2 m-0">Nothing is placed in this assembly yet. Use Insert to add parts.</p> : null}
        {!s.loaded ? <p className="note px-2 m-0">Loading…</p> : null}
      </div>
      <ContextMenu menu={menu} close={() => setMenu(null)} />
    </section>
  );
}
