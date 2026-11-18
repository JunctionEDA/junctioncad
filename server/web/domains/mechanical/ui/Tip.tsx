// Tip.tsx — the tooltip of a tool: its name, its key and one line on what it does (or why it cannot run now).
//
// A browser's own `title` shows late, in one grey line, and cannot set a key apart; an icon-only toolbar leans on
// its tooltips, so they are drawn here.  One tooltip for the whole page: `tipHandlers(tip)` on anything that has
// one, `<TipHost />` once in the frame.
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

export interface TipContent { title: string; shortcut?: string; hint?: string; why?: string | null }
interface Shown { tip: TipContent; at: DOMRect }

let shown: Shown | null = null;
let timer = 0;
let lastHidden = 0;
const listeners = new Set<() => void>();
const tell = () => { for (const fn of Array.from(listeners)) fn(); };

function show(tip: TipContent, el: Element): void {
  clearTimeout(timer);
  // moving along a toolbar, the next tooltip comes at once; the first one waits a moment
  const wait = performance.now() - lastHidden < 300 || shown ? 0 : 450;
  timer = window.setTimeout(() => { if (!el.isConnected) return; shown = { tip, at: el.getBoundingClientRect() }; tell(); }, wait);
}
export function hideTip(): void {
  clearTimeout(timer);
  if (shown) { shown = null; lastHidden = performance.now(); tell(); }
}

/** Spread on an element that has a tooltip. */
export function tipHandlers(tip: TipContent): { onPointerEnter(ev: React.PointerEvent): void; onPointerLeave(): void; onPointerDown(): void; onFocus(ev: React.FocusEvent): void; onBlur(): void } {
  return {
    onPointerEnter: (ev) => { if (ev.pointerType !== "touch") show(tip, ev.currentTarget); },
    onPointerLeave: hideTip, onPointerDown: hideTip,
    onFocus: (ev) => { if ((ev.target as Element).matches(":focus-visible")) show(tip, ev.currentTarget); },
    onBlur: hideTip,
  };
}

/** The tooltip as plain text, for `aria-description` and for tests. */
export const tipText = (t: TipContent): string => `${t.title}${t.shortcut ? ` (${t.shortcut})` : ""}${t.why ? `: ${t.why}` : t.hint ? `. ${t.hint}` : ""}`;

export function TipHost() {
  const s = useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => shown);
  if (!s) return null;
  const below = s.at.bottom + 6, left = Math.max(6, Math.min(s.at.left + s.at.width / 2 - 120, window.innerWidth - 256));
  // under the element, or above it when there is no room below
  const style = below + 70 < window.innerHeight ? { left, top: below } : { left, bottom: window.innerHeight - s.at.top + 6 };
  return createPortal(
    <div className="cad-tip fixed z-[70] w-max max-w-62 px-2 py-1.5 rounded-md border border-line bg-panel shadow-panel text-sm text-ink pointer-events-none" role="tooltip" style={style}>
      <div className="flex items-center gap-2">
        <span className="font-semibold">{s.tip.title}</span>
        {s.tip.shortcut ? <span className="kbd ml-auto">{s.tip.shortcut}</span> : null}
      </div>
      {s.tip.why ? <div className="text-xs text-warn mt-0.5">{s.tip.why}</div> : s.tip.hint ? <div className="text-xs text-ink-2 mt-0.5 leading-snug">{s.tip.hint}</div> : null}
    </div>,
    document.body,
  );
}
