// selmodes.ts — SELECTION_TOOL::setModifiersState: what Shift / Ctrl / Alt do to a click and to a box or lasso drag.
import { IS_MAC } from "../../../shared/keys";

/** The modifier keys of a pointer or key event. */
export interface ModKeys { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey?: boolean }

function detectWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  if (nav.platform) return /^Win/i.test(nav.platform);
  const uad = nav.userAgentData && nav.userAgentData.platform;
  if (uad) return /windows/i.test(uad);
  return /Windows/.test(nav.userAgent || "");
}
/** MS Windows: SELECTION_TOOL leaves Alt out there (the system menu has it). */
export const IS_WINDOWS = detectWindows();

/**
 * TOOL_DISPATCHER::decodeModifiers' MD_CTRL: wxMOD_CONTROL, which wxWidgets maps to the Command key on macOS (the
 * physical Control key is wxMOD_RAW_CONTROL there, and a Control+click is a right click).  Elsewhere it is Control;
 * the Super / Windows key is MD_SUPER, which the selection tool does not read.
 */
export function ctrlDown(ev: ModKeys, mac = IS_MAC): boolean { return mac ? !!ev.metaKey : !!ev.ctrlKey; }

/** The flags SELECTION_TOOL::setModifiersState sets. */
export interface ModState {
  additive: boolean; subtractive: boolean; exclusiveOr: boolean; highlight: boolean;
  dragAdditive: boolean; dragSubtractive: boolean; skipHeuristics: boolean;
}
export interface ModOpts {
  /** ctrlClickHighlights(): pcbnew with "Ctrl+click highlights net" set, not in the Footprint Editor. */
  ctrlHighlights?: boolean;
  mac?: boolean;
  windows?: boolean;
}
/** SELECTION_TOOL::setModifiersState( Shift, Ctrl, Alt ), with Ctrl read as ctrlDown(). */
export function modifiersState(ev: ModKeys, o: ModOpts = {}): ModState {
  const shift = !!ev.shiftKey, ctrl = ctrlDown(ev, o.mac ?? IS_MAC), alt = !!ev.altKey;
  const hl = !!o.ctrlHighlights;
  return {
    subtractive: ctrl && shift,
    additive: !ctrl && shift,
    exclusiveOr: hl ? false : ctrl && !shift,
    highlight: hl ? ctrl && !shift : false,
    // "Drag is more forgiving and allows either Ctrl+Drag or Shift+Drag to add to the selection"
    dragAdditive: (ctrl || shift) && !alt,
    dragSubtractive: ctrl && shift && !alt,
    skipHeuristics: (o.windows ?? IS_WINDOWS) ? false : alt,
  };
}
/** SELECTION_TOOL::hasModifier: m_subtractive || m_additive || m_exclusive_or. */
export function hasModifier(s: ModState): boolean { return s.subtractive || s.additive || s.exclusiveOr; }

/** selectPoint( ..., m_additive, m_subtractive, m_exclusive_or ) for a click: Shift adds, Ctrl toggles, Ctrl+Shift removes; null replaces. */
export function clickMode(s: ModState): "add" | "toggle" | "remove" | null {
  return s.subtractive ? "remove" : s.exclusiveOr ? "toggle" : s.additive ? "add" : null;
}
/** The click mode of an event: Shift adds, Ctrl (Cmd on macOS) toggles, Ctrl+Shift (Shift+Cmd) removes; null replaces. */
export function selModifier(ev: ModKeys, o: ModOpts = {}): "add" | "toggle" | "remove" | null { return clickMode(modifiersState(ev, o)); }

/**
 * SELECTION_TOOL::setModifiersState for a box or lasso drag: what SelectMultiple does with the items.  Eeschema calls
 * SelectMultiple( area, m_drag_subtractive, false ) with m_drag_additive = ( Ctrl || Shift ) && !Alt, so a Ctrl drag
 * adds like Shift.  Pcbnew calls SelectMultiple( area, m_subtractive, m_exclusive_or ), which do not look at Alt:
 * Ctrl alone toggles (m_exclusive_or = Ctrl && !Shift, false when Ctrl+click highlights nets, and the box then adds),
 * Ctrl+Shift removes, Shift adds.
 */
export function dragModifier(ev: ModKeys, sch = true, o: ModOpts = {}): "add" | "remove" | "toggle" | null {
  const s = modifiersState(ev, o);
  if (!sch) return s.subtractive ? "remove" : s.exclusiveOr ? "toggle" : s.additive || s.highlight ? "add" : null;
  return s.dragSubtractive ? "remove" : s.dragAdditive ? "add" : null;
}
/**
 * m_drag_additive || m_drag_subtractive, ( Ctrl || Shift ) && !Alt in both editors: the drag keeps the selection
 * instead of clearing it first.
 */
export function dragKeeps(ev: ModKeys, o: ModOpts = {}): boolean { const s = modifiersState(ev, o); return s.dragAdditive || s.dragSubtractive; }
/**
 * The SELECTION_AREA fill flags, SetAdditive / SetSubtractive (SetExclusiveOr is always false).  Box drags in both
 * editors and eeschema's lasso set them from m_drag_additive / m_drag_subtractive; PCB_SELECTION_TOOL::SelectPolyArea
 * sets them from m_additive ( Shift && !Ctrl ) and m_subtractive ( Ctrl && Shift ), so a Ctrl lasso on the board has
 * the normal fill and a Ctrl+Shift one the subtract fill.  ViewDraw tests additive first.
 */
export function areaFill(b: { lasso: boolean; add?: boolean; mode?: string | null }, sch: boolean): { additive: boolean; subtractive: boolean } {
  if (b.lasso && !sch) return { additive: b.mode === "add", subtractive: b.mode === "remove" };
  return { additive: !!b.add, subtractive: !!b.add && b.mode === "remove" };
}
/** OnIdle's cursor: ADD for m_additive, SUBTRACT for m_subtractive, XOR for m_exclusive_or, else none. */
export function modifierCursorOf(s: ModState): "ADD" | "SUBTRACT" | "XOR" | null {
  return s.additive ? "ADD" : s.subtractive ? "SUBTRACT" : s.exclusiveOr ? "XOR" : null;
}
