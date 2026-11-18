// pane-tabs.ts — panes that share one dock slot as tabs (a wxAUI notebook): Chat and History sit in one tabbed
// pane at the bottom of their dock, so the dock does not stack one more caption bar and sash for each.  When only
// one of a group is shown it looks like any other pane.  The tab in front is remembered per group (kui.paneTab).
// No editor imports here: Dock.tsx, MenuBar.tsx and panes.ts all read it.

/** Each group, in tab order. */
export const TAB_GROUPS: string[][] = [["chat", "history"]];
export function groupOf(name: string): string[] | undefined { return TAB_GROUPS.find((g) => g.includes(name)); }
/** The group's key in the dock layout (its remembered height) and on its section's data-pane. */
export function groupKey(g: string[]): string { return g.join("+"); }

const KEY = "kui.paneTab";
// The editor bundle (panes.ts) and the chrome bundle (Dock.tsx, MenuBar.tsx) each get their own copy of this
// module, so the state lives on one shared object on the window.
interface Shared { front: Record<string, string>; subs: Set<() => void> }
const shared: Shared = (() => {
  const g = globalThis as unknown as { __kuiPaneTabs?: Shared };
  if (!g.__kuiPaneTabs) {
    let front: Record<string, string> = {};
    try { front = JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, string>; } catch (e) { /* no storage */ }
    g.__kuiPaneTabs = { front, subs: new Set() };
  }
  return g.__kuiPaneTabs;
})();
export function subscribeFront(fn: () => void): () => void { shared.subs.add(fn); return () => { shared.subs.delete(fn); }; }
export function frontTabs(): Record<string, string> { return shared.front; }

/** The tab shown in front among the group's shown panes. */
export function frontOf(g: string[], shown: (n: string) => boolean): string | undefined {
  const f = shared.front[groupKey(g)];
  return f && g.includes(f) && shown(f) ? f : g.find(shown);
}
/** Bring a pane's tab to the front of its group (nothing for a pane in no group). */
export function bringToFront(name: string): void {
  const g = groupOf(name); if (!g) return;
  const k = groupKey(g); if (shared.front[k] === name) return;
  shared.front = Object.assign({}, shared.front, { [k]: name });
  try { localStorage.setItem(KEY, JSON.stringify(shared.front)); } catch (e) { /* no storage */ }
  for (const fn of Array.from(shared.subs)) fn();
}
/** True when the pane is shown but another tab of its group is in front of it. */
export function behindTab(name: string, panes: Record<string, boolean>): boolean {
  const g = groupOf(name); if (!g || !panes[name]) return false;
  return frontOf(g, (n) => !!panes[n]) !== name;
}
