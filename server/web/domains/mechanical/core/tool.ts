// tool.ts — the toolbar and side-panel contracts: what one file under tools/ or panels/ exports.
//
// The part studio's toolbar is drawn from a list, not written by hand.  Every feature type gets a button for
// free (core/feature.ts).  Anything else — a sketch tool, a measure command, a view option, an export — is a
// ToolDefinition in its own file under tools/, and shows up in the toolbar group it names.
import type { ReactNode } from "react";
import type { PartStudio } from "../ui/studio";

/**
 * The toolbar's groups, in the order they are drawn.  A tool in "sketch" shows only while a sketch is open, and
 * the feature buttons (which sit in "feature") are hidden meanwhile.
 */
export type ToolGroup = "edit" | "sketch" | "feature" | "inspect" | "view" | "file";
export const TOOL_GROUPS: readonly ToolGroup[] = ["edit", "sketch", "feature", "inspect", "view", "file"];

export interface ToolDefinition {
  /** stable id, unique among tools */
  id: string;
  title: string;
  /** shown in the tooltip after the title */
  hint?: string;
  /** inline SVG markup for a 24×24 stroke glyph (currentColor) */
  icon?: string;
  group: ToolGroup;
  /** lower first inside the group; ties in title order */
  order?: number;
  /** a single key that runs the tool while the viewport has the keyboard ("l", "Escape") */
  key?: string;
  /** tools of one group that name the same menu share one drop-down button with that title */
  menu?: string;
  /** false hides the button (a tool reached only by its key or from a menu) */
  button?: boolean;
  /** Greyed out, with this as the reason, when it returns a string.  Called on every toolbar draw: keep it cheap. */
  disabled?(studio: PartStudio): string | null;
  /** Drawn pressed when true (a mode that is on, the active sketch tool). */
  active?(studio: PartStudio): boolean;
  /** The button was pressed (or the key).  A mode tool usually calls `studio.setMode(...)`. */
  run(studio: PartStudio): void;
}

export function defineTool(def: ToolDefinition): ToolDefinition { return def; }

// A tool whose `active` or `disabled` reads state of its own (not the studio's) calls `toolsChanged()` when that
// state changes, and the toolbar draws again.
let toolsVersion = 0;
const toolListeners = new Set<() => void>();
export function toolsChanged(): void { toolsVersion++; for (const fn of Array.from(toolListeners)) fn(); }
export function subscribeTools(fn: () => void): () => void { toolListeners.add(fn); return () => { toolListeners.delete(fn); }; }
export function toolsRevision(): number { return toolsVersion; }

/** A panel docked beside the viewport (the feature list is one).  One file under panels/. */
export interface PanelDefinition {
  id: string;
  title: string;
  /** "overlay": drawn over the viewport with no frame of its own; the component places itself (a corner readout). */
  side: "left" | "right" | "overlay";
  order?: number;
  /** A React component; it reads the studio with the hooks in ui/hooks.ts. */
  render(studio: PartStudio): ReactNode;
  /**
   * Whether the panel starts open (its header folds and unfolds it; what a person chose is remembered).  A
   * function is asked each time the studio's state changes until the person chooses: a panel that is about
   * something not every part studio has (a board) opens when there is one.  Open when not given.
   */
  open?: boolean | ((studio: PartStudio) => boolean);
  /** A number shown beside the title (how many parts there are); null or absent: none. */
  count?(studio: PartStudio): number | null;
  /** The panel is in its dock only while this returns true (the Sketch panel, while a sketch is open). */
  visible?(studio: PartStudio): boolean;
}

export function definePanel(def: PanelDefinition): PanelDefinition { return def; }
