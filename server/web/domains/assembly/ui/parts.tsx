// parts.tsx — the small pieces the assembly's panels and dialogs share: the state hook, a glyph, a context menu,
// a number field that only reports valid numbers, and the caption every docked list has.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cx } from "../../../shared/util";
import type { AssemblyEditor, AssemblyState } from "./assembly";

export function useAssembly<T>(a: AssemblyEditor, selector: (s: AssemblyState) => T): T { return useSyncExternalStore(a.subscribe, () => selector(a.getState())); }

export function Glyph({ svg, size = 18 }: { svg?: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="flex-none fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round]" strokeWidth={1.7} dangerouslySetInnerHTML={{ __html: svg || '<rect x="5" y="5" width="14" height="14" rx="2"/>' }} />;
}

export const ICONS = {
  eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M9.5 6.4A9.6 9.6 0 0 1 12 6c6.4 0 10 6 10 6a16 16 0 0 1-3.2 3.7"/><path d="M6.3 8.2A15.7 15.7 0 0 0 2 12s3.6 6 10 6c1.2 0 2.3-.2 3.3-.6"/>',
  pin: '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>',
  folder: '<path d="M3 7h6l2 2h10v10H3z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  flip: '<path d="M12 4v16"/><path d="M8 8l-4 4 4 4"/><path d="M16 8l4 4-4 4"/>',
  turn: '<path d="M5 12a7 7 0 1 1 2 5"/><path d="M4 13v5h5"/>',
  play: '<path d="M8 5l11 7-11 7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12"/>',
  part: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>',
};

export function Caption({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <header className="flex flex-none items-center h-5.5 px-1.5 text-sm font-semibold text-ink bg-[linear-gradient(var(--color-paper),var(--color-bench))] border-b border-line select-none">
      <span className="flex-1 truncate">{children}</span>{right}
    </header>
  );
}

export interface MenuItem { label: string; run(): void; danger?: boolean; disabled?: boolean }
export interface MenuState { x: number; y: number; items: MenuItem[] }

/** A context menu at a point of the window; closes on a choice, a click elsewhere or Escape. */
export function ContextMenu({ menu, close }: { menu: MenuState | null; close(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (ev: Event) => { if (!ref.current || !ref.current.contains(ev.target as Node)) close(); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") close(); };
    window.addEventListener("pointerdown", away, true); window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", away, true); window.removeEventListener("keydown", key, true); };
  }, [menu, close]);
  if (!menu) return null;
  const x = Math.min(menu.x, window.innerWidth - 190), y = Math.min(menu.y, window.innerHeight - menu.items.length * 26 - 12);
  return (
    <div ref={ref} role="menu" className="cad-menu fixed z-[60] min-w-[170px] py-1 rounded-md border border-line bg-panel shadow-panel text-sm" style={{ left: x, top: y }}>
      {menu.items.map((it) => (
        <button key={it.label} type="button" role="menuitem" disabled={it.disabled} className={cx("block w-full text-left px-3 h-6.5 hover:bg-sel-soft disabled:opacity-45 disabled:hover:bg-transparent", it.danger && "text-err")}
          onClick={() => { close(); it.run(); }}>{it.label}</button>
      ))}
    </div>
  );
}

/** A number field: shows `value`, and calls `set` only with finite numbers inside the bounds. */
export function NumberInput({ value, set, unit, min, max, label, param, digits = 3 }: { value: number; set(v: number): void; unit?: string; min?: number; max?: number; label: string; param?: string; digits?: number }) {
  const shown = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 10 ** digits) / 10 ** digits) : "");
  const [text, setText] = useState(shown(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current || Math.abs(Number(text) - value) > 0.5 * 10 ** -digits) { if (!focused.current) setText(shown(value)); } }, [value]);   // eslint-disable-line react-hooks/exhaustive-deps
  const n = Number(text), bad = text.trim() === "" || !Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max);
  return (
    <span className="flex items-center gap-1.5">
      <input className={cx("input mono w-full", bad && "bad")} inputMode="decimal" value={text} aria-label={label} data-param={param}
        onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; setText(shown(value)); }}
        onChange={(ev) => { setText(ev.target.value); const v = Number(ev.target.value); if (ev.target.value.trim() !== "" && Number.isFinite(v) && (min === undefined || v >= min) && (max === undefined || v <= max)) set(v); }} />
      {unit && unit !== "none" ? <span className="text-ink-3 font-mono text-xs w-5">{unit === "deg" ? "°" : unit}</span> : null}
    </span>
  );
}
