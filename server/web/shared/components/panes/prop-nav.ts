// prop-nav.ts — PROPERTIES_PANEL::onCharHook's moves between property editors, shared by the docked Properties pane
// and the Symbol Editor's panel: Enter / Down go to the next property, Up to the previous one, Tab / Shift+Tab to
// the next / previous editable one (wrapping).

export type PropNav = "next" | "prev" | "tab" | "backtab";

/** The move a key asks for, or null. */
export function propNavOf(ev: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): PropNav | null {
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return null;
  if (ev.key === "Tab") return ev.shiftKey ? "backtab" : "tab";
  if (ev.shiftKey) return null;
  return ev.key === "Enter" || ev.key === "ArrowDown" ? "next" : ev.key === "ArrowUp" ? "prev" : null;
}

/** The cell editor a navigation key lands on, from the one it left. */
export function navTarget(cells: { readOnly: boolean }[], from: number, nav: PropNav): number {
  const n = cells.length; if (!n) return -1;
  if (nav === "next") return Math.min(n - 1, from + 1);
  if (nav === "prev") return Math.max(0, from - 1);
  const step = nav === "tab" ? 1 : -1;
  for (let k = 1; k <= n; k++) { const i = ((from + step * k) % n + n) % n; if (!cells[i].readOnly) return i; }
  return from;
}
