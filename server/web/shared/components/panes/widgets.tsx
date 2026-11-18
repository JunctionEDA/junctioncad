// widgets.tsx — what the docked panels share: the hook onto the editor's panel models
// (window.CollabPanels, see web/domains/pcb/panels-api.ts), a popup context menu, the colour swatch with its
// picker, and KiCad's collapsible pane section (WX_COLLAPSIBLE_PANE).
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PanelAction, PanelsApi, PanelsState } from "../../../domains/pcb/panels-api";
import { cx } from "../../util";
import { menuScroller, menuSize, placeMenu } from "../../menufit";
import { KIcon, MenuCheck, TreeExpander } from "../Icon";

const EMPTY: PanelsState = {
  appearance: { layers: [], active: "", objects: [], nets: [], netClasses: [], inactive: "normal", flip: false, netColorMode: "ratsnest", ratsnestMode: "all", presets: [], builtinPresets: [], preset: null, viewports: [], viewport: null },
  hierarchy: { root: null, version: 0 }, netNav: { root: null, version: 0 }, selVersion: 0,
};
export const panels = (): PanelsApi | null => window.CollabPanels || null;
const subscribe = (fn: () => void) => { const p = panels(); return p ? p.subscribe(fn) : () => {}; };
const snapshot = () => { const p = panels(); return p ? p.getState() : EMPTY; };
/** Select a slice of the panel models' store; re-renders when the selected value changes identity. */
export function usePanels<T>(selector: (s: PanelsState) => T): T { return selector(useSyncExternalStore(subscribe, snapshot)); }
export function pdispatch(a: PanelAction): void { const p = panels(); if (p) p.dispatch(a); }

// ---------------------------------------------------------------- context menu
/**
 * A wxMenu row: `icon` is a KiCad bitmap name (KIcon), `check` makes it a check item (wxITEM_CHECK, or wxITEM_RADIO with
 * `radio`) drawn ticked when true, as the shared menus draw them.
 */
export type MenuItem = { label: string; run: () => void; disabled?: boolean; /** why it is dimmed (the row's tooltip) */ title?: string; icon?: string; check?: boolean; radio?: boolean } | "-";
export interface MenuAt { x: number; y: number; items: MenuItem[] }

/** A wxMenu popped at the pointer: closes on a pick, an outside press or Escape; kept inside the window. */
export function ContextMenu({ at, onClose }: { at: MenuAt | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; h: number } | null>(null);
  useLayoutEffect(() => {
    if (!at || !ref.current) { setPos(null); return; }
    const p = placeMenu(menuSize(ref.current), { at });
    setPos({ x: p.left, y: p.top, h: p.maxHeight }); menuScroller(ref.current);
  }, [at]);
  useEffect(() => {
    if (!at) return;
    const down = (ev: PointerEvent) => { if (ref.current && !ref.current.contains(ev.target as Node)) onClose(); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", down, true); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key, true); };
  }, [at, onClose]);
  if (!at) return null;
  return createPortal(
    <div ref={ref} className="kctx fixed z-[400] min-w-[180px] py-1 bg-panel border border-line rounded-md shadow-panel text-sm text-ink select-none" role="menu"
      style={{ left: (pos || at).x, top: (pos || at).y, maxHeight: pos ? pos.h : undefined, overflowY: "auto", visibility: pos ? "visible" : "hidden" }} onContextMenu={(ev) => ev.preventDefault()}>
      {at.items.map((it, i) => it === "-"
        ? <div key={i} className="my-1 border-t border-line" />
        : <div key={i} role={it.check === undefined ? "menuitem" : it.radio ? "menuitemradio" : "menuitemcheckbox"} aria-checked={it.check === undefined ? undefined : it.check}
            aria-disabled={it.disabled || undefined} data-icon={it.icon} className={cx("flex items-center pl-1.5 pr-3 py-[3px] whitespace-nowrap", it.disabled ? "text-ink-3" : "cursor-default hover:bg-accent hover:text-on-accent")}
            title={it.title} onClick={() => { if (it.disabled) return; onClose(); it.run(); }}>
            <span className={cx("w-5 h-4 mr-1.5 shrink-0 flex items-center justify-center text-base leading-none", it.disabled && it.icon && "opacity-40")} data-check={it.check === undefined ? undefined : it.check ? "on" : "off"}>
              {it.check !== undefined ? <MenuCheck on={!!it.check} radio={it.radio} /> : it.icon ? <KIcon name={it.icon} size={16} /> : null}</span>
            <span className="flex-1">{it.label}</span></div>)}
    </div>, document.body);
}
/** State for one ContextMenu: `open(ev, items)` from an onContextMenu handler. */
export function useContextMenu(): { at: MenuAt | null; open: (ev: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) => void; close: () => void } {
  const [at, setAt] = useState<MenuAt | null>(null);
  return { at, open: (ev, items) => { ev.preventDefault(); setAt({ x: ev.clientX, y: ev.clientY, items }); }, close: () => setAt(null) };
}

// ---------------------------------------------------------------- colour swatch + picker
/** A css colour as "#rrggbb" plus its opacity 0..100 (the colours here are "#rrggbb", "#rrggbbaa" or "rgb[a](r,g,b[,a])"). */
export function splitColor(c: string | null): { hex: string; alpha: number } {
  const h = c ? /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c) : null;
  if (h) return { hex: "#" + h[1], alpha: h[2] ? Math.round(parseInt(h[2], 16) / 2.55) : 100 };
  const m = c ? /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c) : null;
  if (m) return { hex: "#" + [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(+v))).toString(16).padStart(2, "0")).join(""), alpha: m[4] === undefined ? 100 : Math.round(Math.max(0, Math.min(1, +m[4])) * 100) };
  return { hex: "#808080", alpha: 100 };
}

/**
 * COLOR_SWATCH::GetNewSwatchColor: the swatch opens DIALOG_COLOR_PICKER (editor/pcbdialogs/color-picker.ts, published
 * by the editor as CollabPanels.pickColor) with the current colour, the swatch's default (Reset to Default, or Clear
 * Color when it has none) and the Opacity slider (aAllowOpacityControl, on for every Appearance swatch).  `set` gets
 * the new colour, or null when the colour was cleared or reset to the default.
 */
export interface ColorAt { title?: string; color: string | null; def: string | null; set: (c: string | null) => void; opacity?: boolean }
export function pickColor(c: ColorAt): void {
  const p = panels(); if (!p) return;
  p.pickColor(c.color, c.def, c.opacity !== false, (v) => c.set(v));
}

const CHECKER = "linear-gradient(45deg,#888 25%,transparent 25%,transparent 75%,#888 75%),linear-gradient(45deg,#888 25%,#ccc 25%,#ccc 75%,#888 75%)";
/**
 * KiCad's COLOR_SWATCH: a bordered square; with no colour set it shows the checkerboard of "no colour", and a
 * translucent colour is blended over that checkerboard (COLOR_SWATCH::RenderToDC).
 */
export function Swatch({ color, title, onPick, small }: { color: string | null; title?: string; onPick?: (ev: { clientX: number; clientY: number }) => void; small?: boolean }) {
  const translucent = !!color && splitColor(color).alpha < 100;
  const bg = color && !translucent ? { background: color }
    : { backgroundImage: (translucent ? `linear-gradient(${color},${color}),` : "") + CHECKER, backgroundSize: translucent ? "100% 100%,6px 6px,6px 6px" : "6px 6px", backgroundPosition: translucent ? "0 0,0 0,3px 3px" : "0 0,3px 3px" };
  return <span className={cx("sw flex-none rounded-xs border border-black/50", small ? "w-3 h-3" : "w-[18px] h-3.5")} style={bg} title={title}
    onDoubleClick={onPick ? (ev) => { ev.stopPropagation(); onPick(ev); } : undefined}
    onAuxClick={onPick ? (ev) => { if (ev.button === 1) { ev.preventDefault(); onPick(ev); } } : undefined} />;
}

// ---------------------------------------------------------------- collapsible section
export function Collapsible({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("kui.collapse." + id) === "1"; } catch (e) { return false; } });
  const toggle = () => { const n = !open; setOpen(n); try { localStorage.setItem("kui.collapse." + id, n ? "1" : "0"); } catch (e) { /* no storage */ } };
  return (
    <div className="kcollapse flex-none border-t border-line bg-bench" data-collapse={id}>
      <button type="button" className="flex items-center gap-1 w-full px-1.5 py-1 border-0 bg-transparent text-ink text-sm text-left cursor-pointer" onClick={toggle} aria-expanded={open}>
        <TreeExpander open={open} />{title}
      </button>
      {open ? <div className="px-2 pb-2 pt-0.5">{children}</div> : null}
    </div>
  );
}

/** The +/- of a tree row (wxTreeCtrl's twist button); an empty slot keeps leaf labels aligned. */
export function Twist({ open, onToggle, leaf }: { open: boolean; onToggle: () => void; leaf?: boolean }) {
  if (leaf) return <span className="inline-block w-3.5 flex-none" />;
  return <TreeExpander className="twist" open={open} onToggle={onToggle} />;
}
