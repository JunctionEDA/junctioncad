// DialogShell.tsx — the frame every dialog over the viewport shares (a feature's, the open sketch's): a title
// that can be edited, ✓ and ✗ at its right, a body.  It stays where it is put: drag it by its title, fold it to
// its title with the chevron.  The place is kept for the next dialog, so a dialog never jumps; the fold is kept
// only where `keepFold` asks (the sketch's dialog, which a person folds to draw under it): a feature's dialog
// always opens showing its fields.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../../../shared/util";
import { Glyph } from "./Glyph";
import { CHECK, CROSS } from "./Toolbar";
import { tipHandlers } from "./Tip";

// where the person last left a dialog (pixels from the stage's top left), and whether it was folded
let place = { x: 8, y: 8 };
const folded: { [kind: string]: boolean } = {};

export interface ShellProps {
  className: string;
  /** remember, for the next dialog of this kind, that this one was folded to its title */
  keepFold?: boolean;
  icon?: string;
  name: string;
  /** given: the name is an input */
  onName?(name: string): void;
  onAccept(): void;
  onCancel(): void;
  acceptTip: { title: string; shortcut?: string; hint?: string };
  cancelTip: { title: string; shortcut?: string; hint?: string };
  /** buttons between the name and ✓ (a preview toggle) */
  extra?: ReactNode;
  /** attributes for the form (data-feature, …) and for ✓ and ✗, so tests and styles can tell dialogs apart */
  attrs?: { [key: string]: string | undefined };
  acceptAttrs?: { [key: string]: string | boolean | undefined };
  cancelAttrs?: { [key: string]: string | boolean | undefined };
  onKeyDown?(ev: React.KeyboardEvent): void;
  children: ReactNode;
}

export function DialogShell(p: ShellProps) {
  const form = useRef<HTMLFormElement>(null);
  const [at, setAt] = useState(place);
  const [shut, setShut] = useState(!!p.keepFold && !!folded[p.className]);
  // inside the stage, whatever its size is now
  const clamp = (x: number, y: number) => {
    const el = form.current, host = el?.parentElement;
    if (!el || !host) return { x, y };
    return { x: Math.max(4, Math.min(x, host.clientWidth - el.offsetWidth - 4)), y: Math.max(4, Math.min(y, host.clientHeight - 40)) };
  };
  useLayoutEffect(() => { const c = clamp(at.x, at.y); if (c.x !== at.x || c.y !== at.y) setAt(c); });   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { place = at; }, [at]);
  useEffect(() => { if (p.keepFold) folded[p.className] = shut; }, [shut, p.keepFold, p.className]);

  const drag = (ev: React.PointerEvent) => {
    const target = ev.target as HTMLElement;
    if (ev.button !== 0 || target.closest("button")) return;
    // the name is most of the title: a drag that starts on it moves the dialog, a click edits the name
    const name = target.closest("input");
    if (!name) ev.preventDefault();
    const sx = ev.clientX - at.x, sy = ev.clientY - at.y, x0 = ev.clientX, y0 = ev.clientY;
    let moving = false;
    const move = (e: PointerEvent) => {
      if (!moving && Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
      if (!moving) { moving = true; if (name) { name.blur(); window.getSelection()?.removeAllRanges(); } }
      setAt(clamp(e.clientX - sx, e.clientY - sy));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const icon = (title: string, svg: string, primary: boolean, attrs: ShellProps["acceptAttrs"], tip: ShellProps["acceptTip"], submit: boolean, run?: () => void) => (
    <button type={submit ? "submit" : "button"} className={cx("btn sm flex-none p-0 w-6 h-6 min-h-0 justify-center", primary ? "primary" : "ghost")} aria-label={title} {...attrs} {...tipHandlers(tip)} onClick={run}>
      <Glyph svg={svg} size={15} />
    </button>
  );
  return (
    <form ref={form} className={cx(p.className, "absolute z-[4] w-[300px] max-h-[calc(100%-16px)] flex flex-col rounded-md border border-line bg-bench shadow-panel text-sm")} style={{ left: at.x, top: at.y }} {...p.attrs} data-folded={shut || undefined}
      onSubmit={(ev) => { ev.preventDefault(); p.onAccept(); }} onKeyDown={p.onKeyDown}>
      <header className={cx("flex items-center gap-1 h-8 pl-1 pr-1.5 bg-paper rounded-t-md cursor-move", shut ? "rounded-b-md" : "border-b border-line")} onPointerDown={drag} data-dialog-title>
        <button type="button" className="btn sm ghost flex-none p-0 w-5 h-6 min-h-0 justify-center text-ink-3" aria-expanded={!shut} aria-label={shut ? "Unfold the dialog" : "Fold the dialog to its title"} data-dialog-fold {...tipHandlers({ title: shut ? "Unfold" : "Fold to the title", hint: "Drag the title to move the dialog." })} onClick={() => setShut(!shut)}>
          <span className={cx("transition-transform", !shut && "rotate-90")}><Glyph svg='<path d="M9 6l6 6-6 6"/>' size={12} /></span>
        </button>
        {p.icon ? <span className="flex-none text-ink-2"><Glyph svg={p.icon} size={15} /></span> : null}
        {p.onName
          ? <input className="flex-1 min-w-0 bg-transparent border-0 outline-none font-semibold text-ink text-base cursor-text" value={p.name} aria-label="Feature name" onChange={(ev) => p.onName!(ev.target.value)} />
          : <span className="flex-1 min-w-0 truncate font-semibold text-ink text-base">{p.name}</span>}
        {p.extra}
        {icon(p.acceptTip.title, CHECK, true, p.acceptAttrs, p.acceptTip, true)}
        {icon(p.cancelTip.title, CROSS, false, p.cancelAttrs, p.cancelTip, false, p.onCancel)}
      </header>
      <div className={cx("flex flex-col gap-1.5 p-2 overflow-y-auto", shut && "hidden")}>{p.children}</div>
    </form>
  );
}
