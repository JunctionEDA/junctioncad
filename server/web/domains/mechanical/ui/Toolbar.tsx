// Toolbar.tsx — the part studio's toolbar.  It shows the tools of the mode the studio is in and nothing else
// (ui/commands.ts builds the list from the registries; nothing is listed here by hand):
//
//   modelling   undo redo delete │ Sketch │ Extrude Revolve Sweep▾ Fillet▾ Shell Hole Boolean▾ │ Pattern▾ │ Reference▾ │ Board▾ │ inspect │ view │ file
//   in a sketch undo redo │ draw │ modify │ Dimension │ constraints │ Extrude Revolve │            ✓ Finish sketch  ✗
//   in a dialog what is being edited, what a click will pick │ view │                                          ✓  ✗
//
// A drop-down is a split button: its face runs the variant used last (remembered in this browser), its caret
// opens the list.  Every button has a tooltip with its name, its key and a line on what it does (Tip.tsx).
//
// The bar never scrolls sideways in a window of ordinary width: when the buttons do not fit, the tools lose
// their labels first (density 1), then the features (density 2); in a sketch the constraints fold into one
// drop-down.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { subscribeTools, toolsRevision } from "../core/tool";
import { cx } from "../../../shared/util";
import { lastUsed, modeOf, rememberUsed, toolbarSections, type Entry, type Slot } from "./commands";
import { describeKinds } from "./fields";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import { usePref } from "./prefs";
import { featureDef, type PartStudio } from "./studio";
import { hideTip, tipHandlers, tipText } from "./Tip";

const CARET = '<path d="M8 10l4 4 4-4"/>';
export const CHECK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
export const CROSS = '<path d="M6 6l12 12M18 6L6 18"/>';

function Button({ e, label, variant }: { e: Entry; label: boolean; variant?: boolean }) {
  return (
    <button type="button" className={cx("btn sm ghost cad-tb flex flex-none items-center gap-1 px-1", e.on && "on", e.why && "opacity-45", variant && "rounded-r-none pr-0.5")} aria-pressed={e.on || undefined} aria-disabled={e.why ? true : undefined}
      aria-label={e.title} aria-description={tipText(e)} data-tool={e.title} data-tool-id={e.id} data-variant={variant || undefined} {...tipHandlers(e)} onClick={() => { hideTip(); if (!e.why) e.run(); }}>
      <Glyph svg={e.icon} />{label ? <span>{e.title}</span> : null}
    </button>
  );
}

/** The caret of a split button, or a whole drop-down button when `face` is given (a folded section). */
function Caret({ title, entries, open, toggle, face, label }: { title: string; entries: Entry[]; open: boolean; toggle(at: DOMRect | null): void; face?: Entry; label?: boolean }) {
  const why = entries.every((e) => e.why) ? entries[0].why : null;
  return (
    <button type="button" className={cx("btn sm ghost cad-tb flex flex-none items-center", face ? "gap-0.5 px-1" : "px-0 w-3.5 rounded-l-none", (open || (face && entries.some((e) => e.on))) && "on", why && "opacity-45")} aria-haspopup="menu" aria-expanded={open}
      aria-label={`${title}: more`} data-menu={title} data-items={entries.map((e) => e.title).join("|")}
      {...tipHandlers({ title, hint: entries.map((e) => e.title).join(", "), why })}
      onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { hideTip(); toggle(open ? null : (ev.currentTarget.parentElement?.hasAttribute("data-split") ? ev.currentTarget.parentElement : ev.currentTarget).getBoundingClientRect()); }}>
      {face ? <><Glyph svg={face.icon} />{label ? <span>{title}</span> : null}</> : null}<Glyph svg={CARET} size={12} />
    </button>
  );
}

/** What the open dialog is waiting for, in the bar while a dialog has taken the tools' place. */
function DialogContext({ studio }: { studio: PartStudio }) {
  const editing = useStudio(studio, (s) => s.editing);
  if (!editing) return null;
  const def = featureDef(editing.draft.featureType);
  const field = def && editing.field ? def.schema.find((f) => f.key === editing.field) : undefined;
  const kinds = studio.pickFilter();
  return (
    <div className="flex flex-none items-center gap-2 px-2 min-w-0" data-group="context">
      <Glyph svg={def?.icon} size={16} />
      <span className="font-semibold truncate">{editing.draft.name}</span>
      <span className="text-ink-2 truncate" data-context-hint>{field ? `${field.label}: click ${describeKinds(kinds)} in the model` : "Set the values, then accept"}</span>
    </div>
  );
}

export function Toolbar({ studio }: { studio: PartStudio }) {
  // every slice a button's `disabled` / `active` may read: the toolbar redraws when one changes
  const sketch = useStudio(studio, (s) => !!s.sketch);
  const editing = useStudio(studio, (s) => !!s.editing);
  useStudio(studio, (s) => s.canEdit); useStudio(studio, (s) => s.editing?.field); useStudio(studio, (s) => s.sketch?.tool);
  useStudio(studio, (s) => s.selection); useStudio(studio, (s) => s.selectedFeature);
  useStudio(studio, (s) => s.canUndo); useStudio(studio, (s) => s.canRedo); useStudio(studio, (s) => s.planesVisible);
  useSyncExternalStore(subscribeTools, toolsRevision);   // tools with state of their own (core/tool.ts toolsChanged)
  useStudio(studio, (s) => s.bodies);
  useStudio(studio, (s) => s.ui); useStudio(studio, (s) => s.past);
  usePref("toolVariant");

  const mode = modeOf(studio);
  const sections = toolbarSections(studio);

  // ---- how much room there is: labels go when the buttons do not fit
  const bar = useRef<HTMLDivElement>(null);
  const [density, setDensity] = useState(0);
  const needs = useRef<{ sig: string; at: (number | undefined)[] }>({ sig: "", at: [] });
  const sig = mode + ":" + sections.map((s) => s.id + ":" + s.slots.length).join();
  useLayoutEffect(() => {
    const el = bar.current; if (!el) return;
    if (needs.current.sig !== sig) needs.current = { sig, at: [] };
    const fit = () => {
      let need = 0;
      for (const c of Array.from(el.children)) if (!(c as HTMLElement).dataset.spring) need += (c as HTMLElement).offsetWidth;
      const room = el.clientWidth, at = needs.current.at;
      at[density] = need;
      if (need > room && density < 2) setDensity(density + 1);
      else if (density > 0 && at[density - 1] !== undefined && at[density - 1]! <= room) setDensity(density - 1);
      else if (density > 0 && at[density - 1] === undefined && need <= room * 0.6) setDensity(density - 1);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [density, sig]);

  // ---- the open drop-down
  const [menu, setMenu] = useState<{ key: string; at: DOMRect } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const away = () => setMenu(null);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); setMenu(null); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", away); window.addEventListener("blur", away);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key, true); window.removeEventListener("resize", away); window.removeEventListener("blur", away); };
  }, [menu]);
  useEffect(() => setMenu(null), [mode]);
  let shown: { key: string; entries: Entry[] } | null = null;

  const slotView = (secId: string, slot: Slot, label: boolean) => {
    if (slot.menu === null) return <Button key={slot.entry.id} e={slot.entry} label={label} />;
    const key = secId + "/" + slot.menu, open = !!menu && menu.key === key;
    if (open) shown = { key, entries: slot.entries };
    const face = lastUsed(key, slot.entries);
    return (
      <span key={key} className="flex flex-none items-center" data-split>
        <Button e={face} label={label} variant />
        <Caret title={slot.menu} entries={slot.entries} open={open} toggle={(at) => setMenu(at ? { key, at } : null)} />
      </span>
    );
  };

  const groups = sections.map((sec, i) => {
    const folded = !!sec.fold && density >= 1;
    let inner: React.ReactNode;
    if (folded) {
      const entries = sec.slots.flatMap((s) => (s.menu === null ? [s.entry] : s.entries));
      const key = sec.id + "/" + sec.fold, open = !!menu && menu.key === key;
      if (open) shown = { key, entries };
      inner = <Caret title={sec.fold!} entries={entries} open={open} toggle={(at) => setMenu(at ? { key, at } : null)} face={entries.find((e) => e.on) || entries[0]} label />;
    } else inner = sec.slots.map((slot) => slotView(sec.id, slot, sec.bare > 0 && density < sec.bare));
    return (
      <div key={sec.id} className={cx("flex flex-none items-center gap-px px-1", i < sections.length - 1 && "border-r border-line")} data-group={sec.group} data-section={sec.id}>{inner}</div>
    );
  });

  const list = shown as { key: string; entries: Entry[] } | null;
  const confirm = (title: string, icon: string, primary: boolean, run: () => void, shortcut?: string, hint?: string, label?: string) => (
    <button type="button" className={cx("btn sm flex flex-none items-center gap-1", primary ? "primary px-2" : "ghost px-1")} aria-label={title} data-tool={title} {...tipHandlers({ title, shortcut, hint })} onClick={() => { hideTip(); run(); studio.viewport.canvas.focus(); }}>
      <Glyph svg={icon} size={16} />{label ? <span>{label}</span> : null}
    </button>
  );
  return (
    <div ref={bar} className="cad-toolbar flex items-center h-9 bg-bench border-b border-line overflow-x-auto select-none" role="toolbar" aria-label={mode === "sketch" ? "Sketch tools" : "Part studio tools"} data-density={density} data-mode={mode}>
      {mode === "dialog" ? <DialogContext studio={studio} /> : null}
      {groups}
      <div className="flex-1 min-w-2" data-spring="1" />
      {sketch ? (
        <div className="flex flex-none items-center gap-1 px-2 border-l border-line" data-group="confirm">
          {confirm("Finish sketch", CHECK, true, () => studio.finishSketch(), undefined, "Keep the sketch and go back to the part.", density < 2 ? "Finish sketch" : undefined)}
          {confirm("Cancel sketch", CROSS, false, () => studio.cancelSketch(), undefined, "Leave the sketch as it was when you opened it. Undo brings the changes back.")}
        </div>
      ) : editing ? (
        <div className="flex flex-none items-center gap-1 px-2 border-l border-line" data-group="confirm">
          {confirm("Accept", CHECK, true, () => studio.acceptFeature(), "Enter", "Keep the feature.")}
          {confirm("Cancel", CROSS, false, () => studio.cancelFeature(), "Esc", "Close the dialog and change nothing.")}
        </div>
      ) : null}
      {menu && list ? (
        <div className="cad-tb-menu fixed z-[50] min-w-48 py-1 rounded-md border border-line bg-panel shadow-panel text-base text-ink" role="menu" onPointerDown={(ev) => ev.stopPropagation()}
          style={{ left: Math.max(4, Math.min(menu.at.left, window.innerWidth - 216)), top: menu.at.bottom + 2 }}>
          {list.entries.map((e) => (
            <button key={e.id} type="button" role="menuitem" className={cx("appearance-none bg-transparent border-0 m-0 text-inherit [font-family:inherit] [font-size:inherit] flex w-full items-center gap-2 px-2.5 h-7 text-left hover:bg-sel-soft", e.on && "font-semibold", e.why && "opacity-45")} aria-disabled={e.why ? true : undefined}
              data-tool={e.title} {...tipHandlers(e)} onClick={() => { hideTip(); if (e.why) return; setMenu(null); rememberUsed(list.key, e); e.run(); }}>
              <Glyph svg={e.icon} size={16} /><span className="flex-1">{e.title}</span>{e.shortcut ? <span className="mono text-xs text-ink-3">{e.shortcut}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
