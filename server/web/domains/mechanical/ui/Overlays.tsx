// Overlays.tsx — what opens over the part studio for a moment and goes again:
//
//   CommandPalette   the tool search: S opens it at the pointer, Ctrl/Cmd+K in the middle.  Type a few letters
//                    of any tool or feature, Enter runs the first; ↑ ↓ choose.
//   ContextMenu      a right click in the viewport that did not turn the view: what can be done with what is
//                    under the pointer (studio.ts onContext puts it in `ui.menu`).
//   Shortcuts        the sheet of every key (?), read from the same registries as the toolbar.
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../../shared/util";
import { displayOf, selectedBodies } from "../inspect/appearance-display";
import { sketchEditor } from "../sketch/editor";
import type { Pick } from "../viewport/modelview";
import { allCommands, type Entry } from "./commands";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import { FEATURE_KEYS, featureDef, type PartStudio } from "./studio";

const BARE = "appearance-none bg-transparent border-0 m-0 text-inherit [font-family:inherit] [font-size:inherit]";

/** How well `q` matches a title: lower is better; -1 is no match.  Starts of words count most. */
export function matchScore(title: string, q: string): number {
  const t = title.toLowerCase(), s = q.trim().toLowerCase();
  if (!s) return 0;
  if (t.startsWith(s)) return 0;
  const word = t.split(/[\s-]+/).findIndex((w) => w.startsWith(s));
  if (word >= 0) return 1 + word;
  const at = t.indexOf(s);
  if (at >= 0) return 10 + at;
  // the letters in order: "cr" finds Centre rectangle
  let i = 0; for (const ch of t) if (ch === s[i]) i++;
  return i === s.length ? 50 : -1;
}

export function CommandPalette({ studio }: { studio: PartStudio }) {
  const at = useStudio(studio, (s) => (s.ui?.palette as { x: number | null; y: number | null } | undefined) || null);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const close = () => { studio.setUi({ palette: null }); studio.viewport.canvas.focus(); };
  useEffect(() => { if (at) { setQ(""); setIndex(0); input.current?.focus(); } }, [at]);
  const all = useMemo(() => (at ? allCommands(studio) : []), [at, studio]);
  if (!at) return null;
  const found = all.map((e) => ({ e, score: matchScore(e.title, q) })).filter((x) => x.score >= 0).sort((a, b) => a.score - b.score).map((x) => x.e).slice(0, q ? 12 : 60);
  const run = (e: Entry | undefined) => { if (!e || e.why) return; close(); e.run(); };
  const w = 320, h = 360;
  const left = at.x === null ? Math.round(window.innerWidth / 2 - w / 2) : Math.max(8, Math.min(at.x - 20, window.innerWidth - w - 8));
  const top = at.y === null ? Math.round(window.innerHeight * 0.2) : Math.max(8, Math.min(at.y - 18, window.innerHeight - h - 8));
  return (
    <div className="fixed inset-0 z-[60]" onPointerDown={close} data-palette-scrim>
      <div className="cad-palette absolute flex flex-col rounded-md border border-line bg-panel shadow-panel text-base text-ink overflow-hidden" style={{ left, top, width: w, maxHeight: h }} role="dialog" aria-label="Find a tool" onPointerDown={(ev) => ev.stopPropagation()}>
        <input ref={input} autoFocus className="input m-1.5 flex-none" type="search" placeholder="Find a tool or a feature…" aria-label="Find a tool" value={q} data-palette-input
          onChange={(ev) => { setQ(ev.target.value); setIndex(0); }}
          onKeyDown={(ev) => {
            ev.stopPropagation();
            if (ev.key === "Escape") { ev.preventDefault(); close(); }
            else if (ev.key === "Enter") { ev.preventDefault(); run(found[index]); }
            else if (ev.key === "ArrowDown") { ev.preventDefault(); setIndex(Math.min(found.length - 1, index + 1)); }
            else if (ev.key === "ArrowUp") { ev.preventDefault(); setIndex(Math.max(0, index - 1)); }
          }} />
        <div className="overflow-y-auto pb-1" role="listbox">
          {found.length ? found.map((e, i) => (
            <button key={e.id} type="button" role="option" aria-selected={i === index} aria-disabled={e.why ? true : undefined} data-command={e.title} ref={i === index ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
              className={cx(BARE, "flex w-full items-center gap-2 px-2.5 h-7 text-left cursor-pointer", i === index ? "bg-sel" : "hover:bg-sel-soft", e.why && "opacity-45")} title={e.why || e.hint}
              onPointerMove={() => { if (i !== index) setIndex(i); }} onClick={() => run(e)}>
              <Glyph svg={e.icon} size={16} /><span className="flex-1 truncate">{e.title}</span>{e.shortcut ? <span className="kbd">{e.shortcut}</span> : null}
            </button>
          )) : <p className="note px-2.5 py-1 m-0">Nothing is called that.</p>}
        </div>
      </div>
    </div>
  );
}

interface MenuAt { x: number; y: number; pick: Pick | null }

export function ContextMenu({ studio }: { studio: PartStudio }) {
  const at = useStudio(studio, (s) => (s.ui?.menu as MenuAt | undefined) || null);
  const close = () => studio.setUi({ menu: null });
  useEffect(() => {
    if (!at) return;
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
    const away = () => close();
    document.addEventListener("keydown", key, true); document.addEventListener("pointerdown", away); window.addEventListener("blur", away);
    return () => { document.removeEventListener("keydown", key, true); document.removeEventListener("pointerdown", away); window.removeEventListener("blur", away); };
  }, [at]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!at) return null;
  const s = studio.getState();
  const items: ({ label: string; key?: string; why?: string | null; run(): void } | null)[] = [];
  const add = (label: string, run: () => void, key?: string, why?: string | null) => items.push({ label, run, key, why });
  if (s.sketch) {
    const ed = sketchEditor(studio), sel = ed.getState().selection.length;
    add("Finish sketch", () => studio.finishSketch());
    add("Cancel sketch", () => studio.cancelSketch());
    items.push(null);
    if (sel) { add(`Delete ${sel} selected`, () => ed.deleteSelection(), "Del"); add("Construction on or off", () => ed.toggleConstruction(), "Q"); items.push(null); }
    add("View normal to the sketch", () => studio.normalTo(), "N");
    add("Extrude this sketch", () => studio.startFeature("extrude"), "Shift+E");
    add("Revolve this sketch", () => studio.startFeature("revolve"), "Shift+W");
  } else if (s.editing) {
    add("Accept", () => studio.acceptFeature(), "Enter");
    add("Cancel", () => studio.cancelFeature(), "Esc");
    if (s.editing.field) add("Clear this field", () => studio.clearField(s.editing!.field!));
  } else {
    const p = at.pick, bodies = selectedBodies(studio), display = displayOf(studio);
    const flat = p ? !!studio.view.normalOf(p) : false;
    const owner = p ? studio.view.featureOf(p, s.features.map((f) => f.id)) : null;
    if (s.canEdit && flat) add(p && p.kind === "sketch" ? "New sketch on this plane" : "New sketch here", () => studio.startFeature("sketch"), "Shift+S");
    if (s.canEdit && p && p.kind === "sketch") { add("Edit this sketch", () => studio.editFeature(p.featureId)); add("Extrude this sketch", () => studio.startFeature("extrude"), "Shift+E"); }
    if (owner && !(p && p.kind === "sketch")) add(`Edit ${s.features.find((f) => f.id === owner)?.name || "the feature"}…`, () => studio.editFeature(owner));
    if (s.canEdit && p && p.kind === "edge") { add("Fillet", () => studio.startFeature("fillet"), "Shift+F"); add("Chamfer", () => studio.startFeature("chamfer"), "Shift+C"); }
    if (items.length) items.push(null);
    if (flat) add("View normal to", () => studio.normalTo(), "N");
    if (s.selection.length) add("Zoom to selection", () => studio.zoomToSelection(), "Z");
    add("Zoom to fit", () => studio.fit(), "F");
    if (p && p.kind === "plane") add("Hide this plane", () => studio.setVisible(p.plane, false));
    if (p && (p.kind === "datum" || p.kind === "sketch")) add("Hide", () => studio.setVisible(p.featureId, false));
    if (bodies.length) { add(bodies.length === 1 ? "Hide this part" : "Hide these parts", () => { display.hide(bodies); studio.select([]); }, "H"); add("Isolate", () => display.isolate(bodies), "I"); }
    if (display.getState().hidden.length || display.getState().isolated) add("Show all parts", () => display.showAll());
    items.push(null);
    if (s.selection.length) add("Clear the selection", () => studio.select([]), "Esc");
    add("Find a tool…", () => studio.setUi({ palette: { x: at.x, y: at.y } }), "S");
  }
  const shown = items.filter((x, i) => x || (i > 0 && items[i - 1] && i < items.length - 1));
  return (
    <div className="cad-context-menu fixed z-[55] min-w-52 py-1 rounded-md border border-line bg-panel shadow-panel text-base text-ink" role="menu" style={{ left: Math.min(at.x, window.innerWidth - 230), top: Math.min(at.y, window.innerHeight - shown.length * 28 - 12) }} onPointerDown={(ev) => ev.stopPropagation()} onContextMenu={(ev) => ev.preventDefault()}>
      {shown.map((x, i) => x ? (
        <button key={x.label} type="button" role="menuitem" aria-disabled={x.why ? true : undefined} data-menu-item={x.label} className={cx(BARE, "flex w-full items-center px-3 h-7 text-left cursor-pointer hover:bg-sel-soft", x.why && "opacity-45")} title={x.why || undefined}
          onClick={() => { if (x.why) return; close(); x.run(); studio.viewport.canvas.focus(); }}>
          <span className="flex-1">{x.label}</span>{x.key ? <span className="mono text-xs text-ink-3 ml-4">{x.key}</span> : null}
        </button>
      ) : <div key={"sep" + i} className="my-1 border-t border-line" role="separator" />)}
    </div>
  );
}

const MOUSE: [string, string][] = [
  ["Right drag", "Turn the view"], ["Middle drag", "Slide the view (also Ctrl + right drag)"], ["Wheel", "Zoom about the pointer"],
  ["Middle double click", "Zoom to fit"], ["Click", "Select; Shift or Ctrl adds"], ["Drag left to right", "Select what is wholly inside the box"],
  ["Drag right to left", "Select what the box touches"], ["Right click", "The menu for what is under the pointer; in a sketch, put the tool down"],
];

export function Shortcuts({ studio }: { studio: PartStudio }) {
  const open = useStudio(studio, (s) => !!s.ui?.help);
  const close = () => { studio.setUi({ help: false }); studio.viewport.canvas.focus(); };
  useEffect(() => {
    if (!open) return;
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape" || ev.key === "?") { ev.stopPropagation(); ev.preventDefault(); close(); } };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  const tools = studio.tools().filter((t) => t.key).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const k = (key: string) => (key.length === 1 ? key.toUpperCase() : key === "Delete" ? "Del" : key);
  const groups: { title: string; rows: [string, string][] }[] = [
    { title: "Mouse", rows: MOUSE },
    { title: "View", rows: [["F", "Zoom to fit"], ["Z", "Zoom to selection"], ["N", "View normal to the selected face, plane or sketch"], ["Shift+1 … 6", "Front, back, left, right, top, bottom"], ["Shift+7", "Isometric"], ["← ↑ → ↓", "Turn 15° (Shift: 90°)"], ...tools.filter((t) => t.group === "view").map((t): [string, string] => [k(t.key!), t.title])] },
    { title: "Part studio", rows: [["S", "Find a tool, at the pointer"], ["Ctrl+K", "Find a tool"], ...Object.keys(FEATURE_KEYS).filter((key) => featureDef(FEATURE_KEYS[key])).map((key): [string, string] => [`Shift+${key.toUpperCase()}`, featureDef(FEATURE_KEYS[key])!.title]), ...tools.filter((t) => t.group === "inspect" || t.group === "edit").map((t): [string, string] => [k(t.key!), t.title]), ["F2", "Rename the selected feature"], ["Ctrl+Z / Ctrl+Y", "Undo / redo"], ["?", "This sheet"]] },
    { title: "In a dialog", rows: [["Click", "Add to the field that is listening; click again to take out"], ["Tab", "The next field that takes geometry"], ["Esc", "Stop the field listening; again: cancel"], ["Enter", "Accept"], ["↑ ↓ in a number", "One step (Shift: ten)"]] },
    { title: "In a sketch", rows: [...tools.filter((t) => t.group === "sketch").map((t): [string, string] => [k(t.key!), t.title]), ["Esc", "Put the tool down, then clear the selection"], ["Del", "Delete what is selected"], ["Double click a dimension", "Type its value"]] },
  ];
  return (
    <div className="fixed inset-0 z-[65] grid place-items-center bg-[var(--scrim)]" onPointerDown={close} data-shortcuts>
      <div className="cad-shortcuts w-[min(880px,94vw)] max-h-[86vh] flex flex-col rounded-md border border-line bg-bench shadow-panel text-sm text-ink" role="dialog" aria-label="Keyboard shortcuts" onPointerDown={(ev) => ev.stopPropagation()}>
        <header className="flex items-center h-9 px-3 border-b border-line bg-paper rounded-t-md"><span className="flex-1 font-semibold text-base">Keys and mouse</span><button type="button" className="btn sm ghost" onClick={close}>Close</button></header>
        <div className="overflow-y-auto p-3 columns-1 sm:columns-2 lg:columns-3 gap-5">
          {groups.map((g) => (
            <section key={g.title} className="break-inside-avoid mb-3">
              <h3 className="m-0 mb-1 text-2xs uppercase tracking-wide text-ink-3 mono font-normal">{g.title}</h3>
              {g.rows.map(([key, what]) => <div key={key + what} className="flex items-baseline gap-2 py-0.5"><span className="flex-none min-w-16"><span className="kbd">{key}</span></span><span className="text-ink-2">{what}</span></div>)}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
