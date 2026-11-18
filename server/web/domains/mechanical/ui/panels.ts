// panels.ts — which docked panels are open.  A panel's header folds and unfolds it, and a whole dock folds to a
// rail; what a person chose is remembered in this browser (not in the document: it is a way of looking).  A
// panel the person has not touched follows its definition's `open` (core/tool.ts), which may depend on the
// studio: the Board panel opens when the part studio has a board.
import { useSyncExternalStore } from "react";
import type { PanelDefinition } from "../core/tool";
import { PANELS } from "../generated/page";
import type { PartStudio } from "./studio";

const KEY = "junction.cad.panels";
type Stored = { [id: string]: boolean };

function read(): Stored {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "{}"); return v && typeof v === "object" ? v as Stored : {}; } catch { return {}; }
}
let chosen: Stored = read();
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
function set(id: string, open: boolean): void {
  if (chosen[id] === open) return;
  chosen = { ...chosen, [id]: open };
  try { localStorage.setItem(KEY, JSON.stringify(chosen)); } catch { /* private mode: the choice lasts as long as the page */ }
  version++;
  for (const fn of Array.from(listeners)) fn();
}

const dockKey = (side: string): string => "dock:" + side;

/** Is this panel unfolded? */
export function panelOpen(studio: PartStudio, p: PanelDefinition): boolean {
  const mine = chosen[p.id];
  if (mine !== undefined) return mine;
  return typeof p.open === "function" ? p.open(studio) : p.open !== false;
}
export function setPanelOpen(id: string, open: boolean): void { set(id, open); }
/** Is the dock on this side folded to its rail? */
export function dockFolded(side: "left" | "right"): boolean { return chosen[dockKey(side)] === true; }
export function setDockFolded(side: "left" | "right", folded: boolean): void { set(dockKey(side), folded); }

/** Unfold a panel, and its dock: what a tool calls when what it does shows up there (Comment → Comments). */
export function showPanel(id: string): void {
  const p = PANELS.find((x) => x.id === id); if (!p) return;
  if (p.side === "left" || p.side === "right") setDockFolded(p.side, false);
  set(id, true);
}

/** Redraw when a panel or a dock is folded or unfolded. */
export function usePanels(): number { return useSyncExternalStore(subscribe, () => version); }
/** For a panel whose content costs something to keep current: true while it is unfolded. */
export function usePanelOpen(studio: PartStudio, id: string): boolean {
  usePanels();
  const p = PANELS.find((x) => x.id === id);
  return !!p && panelOpen(studio, p) && !(p.side !== "overlay" && dockFolded(p.side));
}
