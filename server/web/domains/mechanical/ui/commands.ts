// commands.ts — everything a person can start in a part studio, as one list: the feature types (features/*.ts)
// and the tools (tools/*.ts), with their names, keys, one-line descriptions and whether they can run just now.
// The toolbar (Toolbar.tsx) draws the part of it that fits the mode the studio is in; the tool search
// (CommandPalette.tsx) and the shortcut sheet (Shortcuts.tsx) read all of it.  Nothing is listed by hand.
//
// The modes, and what the toolbar shows in each:
//
//   model    undo redo delete │ Sketch │ Extrude Revolve … │ Pattern ▾ │ Reference ▾ │ Board ▾ │ inspect │ view │ file
//   sketch   undo redo │ Line Rectangle ▾ Circle Arc ▾ Slot Point Construction │ Fillet Trim Extend Offset Mirror Use
//            │ Dimension │ the constraints │ Extrude Revolve │                                  ✓ Finish sketch  ✗
//   dialog   what is being edited and what a click will pick │ inspect │ view │                          ✓  ✗
//   view     (no edit rights) inspect │ view │ file
import { FEATURE_SECTIONS, type FeatureDefinition } from "../core/feature";
import type { ToolDefinition } from "../core/tool";
import { getPrefs, setPrefs } from "./prefs";
import { FEATURE_KEYS, type PartStudio } from "./studio";

export interface Entry {
  id: string; title: string;
  /** one line on what it does */
  hint?: string;
  icon?: string;
  /** as shown: "L", "Shift+E", "Del" */
  shortcut?: string;
  /** drawn pressed */
  on?: boolean;
  /** why it cannot run just now (null: it can) */
  why?: string | null;
  run(): void;
}
export type Slot = { menu: null; entry: Entry } | { menu: string; entries: Entry[] };
export interface Section {
  id: string; group: string; slots: Slot[];
  /** the density from which this section's buttons lose their labels (0: never labelled) */
  bare: number;
  /** when the bar is too narrow, the whole section folds into one drop-down with this title */
  fold?: string;
}
export type Mode = "model" | "sketch" | "dialog" | "view";

export const modeOf = (studio: PartStudio): Mode => {
  const s = studio.getState();
  return s.sketch ? "sketch" : s.editing ? "dialog" : s.canEdit ? "model" : "view";
};

/** What each feature does, in a line (the tooltip and the tool search). */
const FEATURE_HINTS: { [type: string]: string } = {
  sketch: "Draw on a plane or a flat face: the profile most features start from.",
  extrude: "Pull a sketch region straight out into a solid, or cut with it.",
  revolve: "Turn a sketch region about an axis into a solid, or cut with it.",
  sweep: "Carry a sketch region along a path.",
  loft: "Blend between two or more sketch regions.",
  fillet: "Round the picked edges.",
  chamfer: "Bevel the picked edges.",
  draft: "Tilt faces so a moulded part comes out of its tool.",
  shell: "Hollow a part, leaving walls of one thickness; the picked faces are opened.",
  hole: "Drill simple, counterbored or countersunk holes at sketch points.",
  boolean: "Join parts, cut one from another, or keep what they share.",
  split: "Cut a part in two with a plane or a face.",
  "delete-body": "Remove a part from the model.",
  transform: "Move, turn or copy a part.",
  "linear-pattern": "Repeat parts or features along one or two directions.",
  "circular-pattern": "Repeat parts or features around an axis.",
  mirror: "Copy parts or features across a plane.",
  plane: "A reference plane: offset, through points, at an angle, mid-way.",
  axis: "A reference axis.",
  point: "A reference point.",
  helix: "A helical curve to sweep along.",
  "board-reference": "Show a circuit board of this project in the model, kept current.",
  "board-cutout": "An opening that follows a part of the board.",
  "board-standoffs": "Posts under the board's mounting holes.",
};

const keyText = (key: string | undefined): string | undefined => (!key ? undefined : key.length === 1 ? key.toUpperCase() : key === "Delete" ? "Del" : key);
const byOrder = <T extends { title: string }>(order: (x: T) => number | undefined) => (a: T, b: T) => (order(a) ?? 1e6) - (order(b) ?? 1e6) || a.title.localeCompare(b.title);

export function toolEntry(studio: PartStudio, t: ToolDefinition): Entry {
  return {
    id: t.id, title: t.title, hint: t.hint, icon: t.icon, shortcut: keyText(t.key),
    on: t.active ? t.active(studio) : false, why: t.disabled ? t.disabled(studio) : null,
    run: () => { t.run(studio); studio.viewport.canvas.focus(); },
  };
}
export function featureEntry(studio: PartStudio, f: FeatureDefinition): Entry {
  const s = studio.getState();
  const key = Object.keys(FEATURE_KEYS).find((k) => FEATURE_KEYS[k] === f.type);
  return {
    id: "f:" + f.type, title: f.title, hint: FEATURE_HINTS[f.type], icon: f.icon, shortcut: key ? `Shift+${key.toUpperCase()}` : undefined,
    why: s.canEdit ? null : "View-only access", run: () => { studio.startFeature(f.type); studio.viewport.canvas.focus(); },
  };
}

function slotsOf<T>(list: T[], menuOf: (x: T) => string | undefined, entry: (x: T) => Entry): Slot[] {
  const slots: Slot[] = [];
  for (const x of list) {
    const menu = menuOf(x), e = entry(x);
    const have = menu ? slots.find((s) => s.menu === menu) : undefined;
    if (have && have.menu !== null) have.entries.push(e);
    else slots.push(menu ? { menu, entries: [e] } : { menu: null, entry: e });
  }
  // a family of one is a plain button
  return slots.map((s) => (s.menu !== null && s.entries.length === 1 ? { menu: null, entry: s.entries[0] } : s));
}

/** The parts of the sketch toolbar, by the tools' `order`: draw, modify, dimension, constrain. */
const SKETCH_PARTS: { id: string; from: number; to: number; fold?: string }[] = [
  { id: "sketch-draw", from: 1, to: 100 }, { id: "sketch-modify", from: 100, to: 200 }, { id: "sketch-dimension", from: 300, to: 900 }, { id: "sketch-constrain", from: 200, to: 300, fold: "Constrain" },
];

/** The toolbar for the mode the studio is in. */
export function toolbarSections(studio: PartStudio): Section[] {
  const mode = modeOf(studio);
  const out: Section[] = [];
  const features = studio.definitions().filter((f) => f.toolbar !== false).slice().sort(byOrder((f) => f.toolbarOrder));
  const tools = (group: string): ToolDefinition[] => studio.tools().filter((t) => t.group === group && t.button !== false).slice().sort(byOrder((t) => t.order));
  const te = (t: ToolDefinition) => toolEntry(studio, t), fe = (f: FeatureDefinition) => featureEntry(studio, f);
  const plain = (group: string, bare: number): Section => ({ id: group, group, slots: slotsOf(tools(group), (t) => t.menu, te), bare });

  if (mode === "sketch") {
    out.push({ id: "edit", group: "edit", slots: slotsOf(tools("edit").filter((t) => t.id !== "delete"), () => undefined, te), bare: 0 });
    const sk = tools("sketch");
    for (const part of SKETCH_PARTS) out.push({ id: part.id, group: "sketch", slots: slotsOf(sk.filter((t) => (t.order ?? 0) >= part.from && (t.order ?? 0) < part.to), (t) => t.menu, te), bare: 0, fold: part.fold });
    // what a finished profile is usually for: started from here, the feature takes this sketch
    out.push({ id: "sketch-use", group: "feature", slots: slotsOf(features.filter((f) => f.type === "extrude" || f.type === "revolve"), () => undefined, fe), bare: 0 });
    return out.filter((s) => s.slots.length);
  }
  if (mode === "dialog") {
    // tools that need the pointer for themselves (measure, section) would fight the dialog's picking
    out.push({ id: "view", group: "view", slots: slotsOf(tools("view"), (t) => t.menu, te), bare: 0 });
    return out.filter((s) => s.slots.length);
  }
  if (mode === "model") {
    out.push(plain("edit", 0));
    for (const sec of FEATURE_SECTIONS) {
      const slots = slotsOf(features.filter((f) => (f.toolbarSection || "solid") === sec), (f) => f.toolbarMenu, fe);
      // tools that put themselves among the features follow the solids
      if (sec === "solid") slots.push(...slotsOf(tools("feature"), (t) => t.menu, te));
      // the features a part is mostly made of keep their names longest
      out.push({ id: sec, group: "feature", slots, bare: sec === "sketch" || sec === "solid" ? 2 : 1 });
    }
  }
  out.push(plain("inspect", 1), plain("view", 1), plain("file", 1));
  return out.filter((s) => s.slots.length);
}

/** Everything that can be started, for the tool search: the tools of this mode first, in toolbar order. */
export function allCommands(studio: PartStudio): Entry[] {
  const s = studio.getState(), sketch = !!s.sketch;
  const tools = studio.tools().slice().sort(byOrder((t) => t.order));
  const out: Entry[] = [];
  if (sketch) out.push(...tools.filter((t) => t.group === "sketch").map((t) => toolEntry(studio, t)));
  out.push(...studio.definitions().filter((f) => f.toolbar !== false).slice().sort(byOrder((f) => f.toolbarOrder)).map((f) => featureEntry(studio, f)));
  out.push(...tools.filter((t) => t.group !== "sketch").map((t) => toolEntry(studio, t)));
  out.push(...viewCommands(studio));
  return out;
}

/** What has no tool file of its own: the views and the ways of looking the keys and the view cube also reach. */
export function viewCommands(studio: PartStudio): Entry[] {
  const v = (id: string, title: string, shortcut: string | undefined, hint: string, run: () => void): Entry => ({ id: "view:" + id, title, shortcut, hint, run: () => { run(); studio.viewport.canvas.focus(); } });
  const view = (name: "front" | "back" | "left" | "right" | "top" | "bottom" | "iso", n: number) => v(name, name === "iso" ? "Isometric view" : `${name[0].toUpperCase()}${name.slice(1)} view`, `Shift+${n}`, "Turn the view.", () => studio.viewport.setView(name));
  return [
    v("fit", "Zoom to fit", "F", "Everything in view. Also a double click with the middle button.", () => studio.fit()),
    v("zoom-selection", "Zoom to selection", "Z", "Bring what is selected into view.", () => studio.zoomToSelection()),
    v("normal", "View normal to", "N", "Look straight at the selected flat face or plane, or at the open sketch.", () => studio.normalTo()),
    view("front", 1), view("back", 2), view("left", 3), view("right", 4), view("top", 5), view("bottom", 6), view("iso", 7),
    v("shortcuts", "Keyboard shortcuts", "?", "Every key the part studio answers to.", () => studio.setUi({ help: true })),
  ];
}

/** The entry of a drop-down that its button runs: the one used last (remembered in this browser), else the first. */
export function lastUsed(menuKey: string, entries: readonly Entry[]): Entry {
  const id = getPrefs().toolVariant[menuKey];
  return entries.find((e) => e.id === id) || entries[0];
}
export function rememberUsed(menuKey: string, entry: Entry): void {
  if (getPrefs().toolVariant[menuKey] !== entry.id) setPrefs({ toolVariant: { ...getPrefs().toolVariant, [menuKey]: entry.id } });
}
