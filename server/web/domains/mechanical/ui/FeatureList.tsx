// FeatureList.tsx — the feature list: the default geometry (origin and planes), then every feature in order with
// its state, and the rollback bar.
//
//   click selects (Ctrl adds, Shift takes the range) · double-click edits · F2 or a second slow click renames
//   right-click: Edit, Rename, Suppress, Roll to here, Hide, Zoom to, Used by, Delete
//   the eye (on hover) hides and shows a plane, a sketch or reference geometry, for this person only
//   the pointer over a row lights up what the feature made, and over the model marks the row that made it
//   drag a row to reorder · drag the bar to roll the model back; the rows under it are not built
//   the box at the top filters by name
import { useEffect, useRef, useState } from "react";
import { cx } from "../../../shared/util";
import * as edits from "../document/edits";
import type { FeatureItem } from "../document/format";
import { DEFAULT_GEOMETRY, type DefaultGeometryId } from "../viewport/planes";
import type { Pick } from "../viewport/modelview";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import { FEATURE_ROW_SLOTS } from "./slots";
import { featureDef, type PartStudio } from "./studio";
import { tipHandlers } from "./Tip";

interface Menu { x: number; y: number; id: string }

export const EYE = '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>';
export const EYE_OFF = '<path d="M4 4l16 16"/><path d="M10 5.700a9 9 0 0 1 2-.2c6 0 9.500 6.500 9.500 6.500a17 17 0 0 1-2.800 3.600M6.400 7.500A16.600 16.600 0 0 0 2.500 12s3.500 6.500 9.500 6.500c1.200 0 2.300-.25 3.300-.65"/>';
const PLANE_ICON = '<path d="M3 15l6-8h12l-6 8z"/>';
const ORIGIN_ICON = '<circle cx="12" cy="12" r="2"/><path d="M12 4v5M12 15v5M4 12h5M15 12h5"/>';
/** feature types whose result is reference geometry or a sketch: things that are looked at, so can be hidden */
const HIDEABLE = new Set(["sketch", "plane", "axis", "point", "helix"]);

/** The eye at the right of a row: shown while the pointer is over the row, and always while the thing is hidden. */
export function Eye({ shown, label, onToggle }: { shown: boolean; label: string; onToggle(): void }) {
  return (
    <button type="button" className={cx("btn sm ghost flex-none p-0 w-5 h-5 min-h-0 justify-center", shown ? "text-ink-3 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : "text-ink-3")} aria-pressed={shown} aria-label={`${shown ? "Hide" : "Show"} ${label}`} data-eye={shown ? "shown" : "hidden"}
      {...tipHandlers({ title: shown ? "Hide" : "Show", hint: "Only in your view: nobody else's changes." })} onClick={(ev) => { ev.stopPropagation(); onToggle(); }} onDoubleClick={(ev) => ev.stopPropagation()}>
      <Glyph svg={shown ? EYE : EYE_OFF} size={14} />
    </button>
  );
}

export function FeatureList({ studio }: { studio: PartStudio }) {
  const features = useStudio(studio, (s) => s.features);
  const rollback = useStudio(studio, (s) => s.rollback);
  const reports = useStudio(studio, (s) => s.reports);
  const selected = useStudio(studio, (s) => s.selectedFeatures);
  const sketch = useStudio(studio, (s) => s.sketch?.featureId);
  const editing = useStudio(studio, (s) => s.editing?.draft);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const loaded = useStudio(studio, (s) => s.loaded);
  const selection = useStudio(studio, (s) => s.selection);
  const hover = useStudio(studio, (s) => s.hover);
  const armedPlane = useStudio(studio, (s) => !!s.ui?.pickingPlane || (!!s.editing?.field && (studio.pickFilter() || []).includes("plane")));
  const renameAsk = useStudio(studio, (s) => (s.ui?.renaming as string | undefined) || null);
  useStudio(studio, (s) => s.visibility);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<number | null>(null);         // where a dragged row would land
  const [barAt, setBarAt] = useState<number | null>(null);       // where the dragged rollback bar is
  const [filter, setFilter] = useState("");
  const [geometryOpen, setGeometryOpen] = useState(true);
  const [deps, setDeps] = useState<{ of: string; uses: string[]; usedBy: string[] } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const anchor = useRef<string | null>(null);                    // where a Shift-click's range starts
  const slow = useRef<{ id: string; t: number; timer: number }>({ id: "", t: 0, timer: 0 });

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close); window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); };
  }, [menu]);
  // F2 in the viewport asks for the selected row to be renamed
  useEffect(() => { if (renameAsk) { if (canEdit) setRenaming(renameAsk); studio.setUi({ renaming: null }); } }, [renameAsk]);   // eslint-disable-line react-hooks/exhaustive-deps

  const doc = () => studio.doc!;
  const q = filter.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);
  /** The gap (0 … n) nearest a pointer position: 0 is above the first row. */
  const gapAt = (clientY: number): number => {
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-feature-row]") || []);
    for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (clientY < r.top + r.height / 2) return i; }
    return rows.length;
  };
  const setBar = (gap: number) => studio.commit(edits.setRollback(doc(), gap >= features.length ? null : features[gap].id));

  const dragBar = (ev: React.PointerEvent) => {
    if (!canEdit || q) return;
    ev.preventDefault();
    const move = (e: PointerEvent) => setBarAt(gapAt(e.clientY));
    const up = (e: PointerEvent) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setBarAt(null); setBar(gapAt(e.clientY)); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  const usesOf = (f: FeatureItem): string[] => { const text = JSON.stringify(f.params); return features.filter((g) => g.id !== f.id && text.includes(g.id)).map((g) => g.id); };
  const usedBy = (id: string): string[] => features.filter((g) => g.id !== id && JSON.stringify(g.params).includes(id)).map((g) => g.id);
  const clickRow = (f: FeatureItem, ev: React.MouseEvent) => {
    if (ev.shiftKey && anchor.current) {
      const a = features.findIndex((x) => x.id === anchor.current), b = features.findIndex((x) => x.id === f.id);
      if (a >= 0 && b >= 0) { studio.selectFeatures(features.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id)); return; }
    }
    const add = ev.ctrlKey || ev.metaKey;
    // a second, unhurried click on the one selected row renames it, as in a file list
    const now = performance.now(), alone = selected.length === 1 && selected[0] === f.id;
    clearTimeout(slow.current.timer);
    if (!add && alone && canEdit && slow.current.id === f.id && now - slow.current.t > 500 && now - slow.current.t < 2500 && (ev.target as HTMLElement).closest("[data-row-name]")) {
      slow.current = { id: "", t: 0, timer: window.setTimeout(() => setRenaming(f.id), 250) };
      return;
    }
    slow.current = { id: f.id, t: now, timer: 0 };
    anchor.current = f.id;
    if (!(alone && !add)) studio.selectFeature(f.id, add);
  };

  // ---------------------------------------------------------------- the default geometry
  const hoverKey = hover ? (hover.kind === "plane" ? hover.plane : null) : null;
  const made = studio.hoveredFeature();
  const geometry = DEFAULT_GEOMETRY.filter((g) => matches(g.title)).map((g) => {
    const shown = studio.isVisible(g.id);
    const pick: Pick | null = g.id === "origin" ? null : { kind: "plane", plane: g.id, point: [0, 0, 0] };
    const on = !!pick && selection.some((p) => p.kind === "plane" && p.plane === g.id);
    return (
      <div key={g.id} role="option" aria-selected={on} data-default-geometry={g.id} data-visible={shown} className={cx("group flex items-center gap-1.5 h-6.5 pl-5 pr-1.5 cursor-default select-none", on ? "bg-sel" : hoverKey === g.id ? "bg-sel-soft" : "hover:bg-sel-soft", !shown && "text-ink-3", armedPlane && pick && "cursor-pointer")}
        onClick={(ev) => { if (pick) studio.pickFromList(pick, ev); }}
        onPointerEnter={() => studio.view.setFeatureHover(pick && shown ? [pick] : null)} onPointerLeave={() => studio.view.setFeatureHover(null)}
        onContextMenu={(ev) => { ev.preventDefault(); studio.toggleVisible(g.id); }}>
        <Glyph svg={g.id === "origin" ? ORIGIN_ICON : PLANE_ICON} size={16} />
        <span className="flex-1 truncate">{g.title}</span>
        <Eye shown={shown} label={g.title} onToggle={() => studio.toggleVisible(g.id as DefaultGeometryId)} />
      </div>
    );
  });

  // ---------------------------------------------------------------- the features and the bar
  const rowsOut: JSX.Element[] = [];
  const hiddenBelow = features.length - rollback;
  const bar = (key: string, live: boolean) => (
    <div key={key} className={cx("cad-rollback group/bar relative flex items-center h-2.5 mx-1", live && canEdit && !q && "cursor-row-resize")} data-rollback={live || undefined} data-rolled={live && hiddenBelow > 0 ? hiddenBelow : undefined}
      {...(live ? tipHandlers({ title: "Rollback bar", hint: hiddenBelow > 0 ? `${hiddenBelow} feature${hiddenBelow === 1 ? "" : "s"} below it ${hiddenBelow === 1 ? "is" : "are"} not built. Drag it down, or right-click a feature and choose Roll to end.` : "Drag it up to see the model as it was at an earlier feature." }) : {})} onPointerDown={live ? dragBar : undefined}>
      <span className={cx("flex-1 h-[3px] rounded-full", live ? (hiddenBelow > 0 || barAt !== null ? "bg-accent" : "bg-line-2 group-hover/bar:bg-accent") : "bg-line-2")} />
      {live ? <span className={cx("flex-none ml-1 w-3 h-2.5 rounded-sm border", hiddenBelow > 0 || barAt !== null ? "border-accent bg-accent" : "border-line-2 bg-panel group-hover/bar:border-accent")} aria-hidden="true" /> : null}
    </div>
  );
  const shownBar = barAt ?? rollback;
  const all: FeatureItem[] = editing && !features.some((f) => f.id === editing.id) ? [...features.slice(0, rollback), editing, ...features.slice(rollback)] : features;
  let gap = 0, shownRows = 0;
  for (const f of all) {
    const isDraft = !!editing && editing.id === f.id && !features.some((x) => x.id === f.id);
    if (!isDraft && !q) { if (gap === shownBar) rowsOut.push(bar("bar", barAt === null)); if (drop === gap) rowsOut.push(<div key="drop" className="h-0.5 mx-1 bg-blue" />); }
    if (!isDraft) gap++;
    if (!matches(f.name) && !isDraft) continue;
    shownRows++;
    const def = featureDef(f.featureType);
    const rep = reports[f.id];
    const below = !isDraft && gap - 1 >= rollback;
    // the row of a feature that is still being given its geometry is not an error yet
    const state = f.suppressed ? "suppressed" : below ? "rolled-back" : rep ? (isDraft && rep.status === "error" ? "ok" : rep.status) : "ok";
    const on = selected.includes(f.id) || sketch === f.id || isDraft;
    const hideable = !isDraft && HIDEABLE.has(f.featureType);
    const shown = hideable ? studio.isVisible(f.id) : true;
    const dep = deps ? (deps.of === f.id ? "this" : deps.uses.includes(f.id) ? "uses" : deps.usedBy.includes(f.id) ? "used by" : null) : null;
    rowsOut.push(
      <div key={f.id} data-feature-row={isDraft ? undefined : f.id} data-feature-type={f.featureType} data-state={state} data-message={rep && rep.message ? rep.message : undefined} data-made-hover={made === f.id || undefined} role="option" aria-selected={selected.includes(f.id)}
        draggable={canEdit && !isDraft && renaming !== f.id && !q}
        className={cx("group flex items-center gap-1.5 h-6.5 pl-2 pr-1.5 cursor-default select-none", on ? "bg-sel" : made === f.id ? "bg-sel-soft" : "hover:bg-sel-soft", (below || f.suppressed) && "text-ink-3", isDraft && "italic")}
        onClick={(ev) => { if (!isDraft) clickRow(f, ev); }}
        onDoubleClick={() => { clearTimeout(slow.current.timer); if (!isDraft) studio.editFeature(f.id); }}
        onPointerEnter={() => { if (!isDraft) studio.setHoverFeature(f.id); }} onPointerLeave={() => studio.setHoverFeature(null)}
        onContextMenu={(ev) => { ev.preventDefault(); if (!isDraft) { if (!selected.includes(f.id)) studio.selectFeature(f.id); setMenu({ x: ev.clientX, y: ev.clientY, id: f.id }); } }}
        onDragStart={(ev) => { dragId.current = f.id; ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", f.id); }}
        onDragEnd={() => { dragId.current = null; setDrop(null); }}>
        <Glyph svg={def?.icon} size={16} />
        {renaming === f.id
          ? <input autoFocus className="input flex-1 min-w-0 h-5" defaultValue={f.name} aria-label="Feature name" onFocus={(ev) => ev.target.select()} onClick={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}
              onBlur={(ev) => { studio.commit(edits.renameFeature(doc(), f.id, ev.target.value)); setRenaming(null); }}
              onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); if (ev.key === "Escape") setRenaming(null); ev.stopPropagation(); }} />
          : <span data-row-name className={cx("flex-1 truncate", f.suppressed && "line-through", !shown && "text-ink-3")}>{f.name}</span>}
        {dep && dep !== "this" ? <span className="pill info" data-dep={dep}>{dep}</span> : null}
        {state === "error" || state === "warning" ? (
          <button type="button" className={cx("pill cursor-pointer", state === "error" ? "err" : "warn")} data-problem={state} aria-label={`${state === "error" ? "Error" : "Note"}: ${rep?.message || ""} Show it.`}
            {...tipHandlers({ title: state === "error" ? "This feature failed" : "A note on this feature", hint: `${rep?.message || ""} Click to look at it.` })} onClick={(ev) => { ev.stopPropagation(); studio.selectFeature(f.id); studio.zoomToFeature(f.id); }}>
            {state === "error" ? "error" : "note"}
          </button>
        ) : state === "suppressed" ? <span className="text-xs">off</span> : null}
        {isDraft ? null : FEATURE_ROW_SLOTS.map((Slot, i) => <Slot key={i} studio={studio} featureId={f.id} />)}
        {hideable ? <Eye shown={shown} label={f.name} onToggle={() => studio.toggleVisible(f.id)} /> : null}
      </div>,
    );
  }
  if (!q && shownBar >= features.length) rowsOut.push(bar("bar", barAt === null));
  if (drop === features.length) rowsOut.push(<div key="drop" className="h-0.5 mx-1 bg-blue" />);

  const f = menu ? features.find((x) => x.id === menu.id) : undefined;
  const targets = f ? (selected.includes(f.id) && selected.length > 1 ? selected.slice() : [f.id]) : [];
  const item = (label: string, run: () => void, o: { danger?: boolean; key?: string } = {}) => (
    <button type="button" key={label} data-menu-item={label} className={cx("flex items-center w-full text-left px-3 h-7 hover:bg-sel-soft", o.danger && "text-err")} onPointerDown={(ev) => ev.stopPropagation()} onClick={() => { setMenu(null); run(); }}>
      <span className="flex-1">{label}</span>{o.key ? <span className="mono text-xs text-ink-3 ml-4">{o.key}</span> : null}
    </button>
  );
  const many = targets.length > 1;
  const commitAll = (make: (id: string) => ReturnType<typeof edits.deleteFeature>) => { const changes = targets.flatMap((id) => make(id)); if (changes.length) studio.commit(changes); };
  return (
    <div ref={list} className="cad-features flex flex-col text-sm min-h-full" role="listbox" aria-label="Features" aria-multiselectable="true"
      onKeyDown={(ev) => { if (ev.key === "Escape" && deps) setDeps(null); }}
      onDragOver={(ev) => { if (dragId.current) { ev.preventDefault(); setDrop(gapAt(ev.clientY)); } }}
      onDrop={(ev) => {
        ev.preventDefault();
        const id = dragId.current, g = gapAt(ev.clientY); dragId.current = null; setDrop(null);
        if (!id) return;
        const from = features.findIndex((x) => x.id === id);
        studio.commit(edits.moveFeature(doc(), id, g > from ? g - 1 : g));
      }}>
      <div className="flex flex-none items-center gap-1 px-1.5 py-1 border-b border-line bg-paper sticky top-0 z-[1]">
        <input className="input sm flex-1 min-w-0 h-5.5" type="search" placeholder="Filter by name" aria-label="Filter the features by name" value={filter} data-feature-filter onChange={(ev) => setFilter(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Escape") { setFilter(""); ev.stopPropagation(); } }} />
        <span className="flex-none mono text-xs text-ink-3" data-feature-count {...tipHandlers({ title: `${features.length} feature${features.length === 1 ? "" : "s"}`, hint: hiddenBelow > 0 ? `${hiddenBelow} below the rollback bar.` : undefined })}>{q ? `${shownRows}/${features.length}` : features.length}</span>
      </div>
      {geometry.length ? (
        <div data-default-group>
          <button type="button" className="appearance-none bg-transparent border-0 m-0 p-0 text-inherit [font-family:inherit] [font-size:inherit] flex w-full items-center gap-1 h-6 px-1.5 text-left text-ink-2 hover:bg-sel-soft cursor-pointer" aria-expanded={geometryOpen} data-default-toggle onClick={() => setGeometryOpen(!geometryOpen)}>
            <span className={cx("flex-none text-ink-3 transition-transform", geometryOpen && "rotate-90")}><Glyph svg='<path d="M9 6l6 6-6 6"/>' size={12} /></span>
            <span className="flex-1 truncate">Default geometry</span>
          </button>
          {geometryOpen || q ? geometry : null}
        </div>
      ) : null}
      <div className="flex flex-col pb-1">{rowsOut}</div>
      {loaded && !all.length ? <p className="note px-2 m-0" data-empty>No features yet. Choose <b>Sketch</b>, click a plane, and draw a profile; then <b>Extrude</b> it.</p> : null}
      {loaded && all.length > 0 && q && !shownRows && !geometry.length ? <p className="note px-2 m-0">Nothing is called “{filter.trim()}”.</p> : null}
      {!loaded ? <p className="note px-2 m-0">Loading…</p> : null}
      {deps ? (
        <p className="note px-2 py-1 m-0 border-t border-line" data-deps>
          {features.find((x) => x.id === deps.of)?.name} uses {deps.uses.length || "no"} feature{deps.uses.length === 1 ? "" : "s"} and is used by {deps.usedBy.length || "none"}. <button type="button" className="btn sm ghost h-5 min-h-0 px-1" onClick={() => setDeps(null)}>Done</button>
        </p>
      ) : null}
      {menu && f ? (
        <div className="cad-feature-menu fixed z-[50] min-w-52 py-1 rounded-md border border-line bg-panel shadow-panel text-base" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 300) }} role="menu">
          {many ? <div className="px-3 h-6 text-xs text-ink-3 flex items-center">{targets.length} features</div> : null}
          {!many ? item(f.featureType === "sketch" ? "Edit sketch" : "Edit…", () => studio.editFeature(f.id), { key: "double-click" }) : null}
          {canEdit && !many ? item("Rename", () => setRenaming(f.id), { key: "F2" }) : null}
          {canEdit ? item(f.suppressed ? "Unsuppress" : "Suppress", () => commitAll((id) => edits.suppressFeature(doc(), id, !f.suppressed))) : null}
          {canEdit && !many ? item("Roll back to here", () => { const i = features.findIndex((x) => x.id === f.id); setBar(i + 1); }) : null}
          {canEdit && rollback < features.length ? item("Roll to end", () => setBar(features.length)) : null}
          {HIDEABLE.has(f.featureType) ? item(studio.isVisible(f.id) ? "Hide" : "Show", () => studio.setVisible(targets.filter((id) => HIDEABLE.has(features.find((x) => x.id === id)?.featureType || "")), !studio.isVisible(f.id))) : null}
          {!many ? item("Zoom to", () => studio.zoomToFeature(f.id)) : null}
          {!many ? item("Show what it uses and what uses it", () => setDeps({ of: f.id, uses: usesOf(f), usedBy: usedBy(f.id) })) : null}
          {canEdit ? item(many ? `Delete ${targets.length} features` : "Delete", () => commitAll((id) => edits.deleteFeature(doc(), id)), { danger: true, key: "Del" }) : null}
        </div>
      ) : null}
    </div>
  );
}
