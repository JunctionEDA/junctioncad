// components/colorswatch.ts — KiCad's COLOR_SWATCH (common/widgets/color_swatch.cpp) for the plain-DOM dialogs: a
// bordered swatch showing the colour over the checkerboard where it is translucent (COLOR_SWATCH::MakeBitmap), the
// checkerboard alone for COLOR4D::UNSPECIFIED; a click opens DIALOG_COLOR_PICKER (GetNewSwatchColor).  Never a
// browser-native colour input.
import { colorPicker, fromHex, toHex, type RGBA } from "../../domains/pcb/editor/pcbdialogs/color-picker";

export type { RGBA };
export interface SwatchOpts {
  /** DIALOG_COLOR_PICKER's opacity slider (aAllowOpacityControl) */
  opacity?: boolean;
  /** the picker's Reset to Default colour; null is UNSPECIFIED (its Clear Color) */
  def?: RGBA | null;
  /** called after the picker's OK changed the colour */
  onChange?(c: RGBA | null): void;
  id?: string; title?: string; key?: string;
  /** swatch size in pixels (KiCad's default swatch is 24 x 14 in dialogs) */
  w?: number; h?: number;
  /** a swatch that only shows its colour (COLOR_SWATCH::SetReadOnly) */
  readOnly?: boolean;
  /** open the picker on double-click / middle-click only, as the appearance panels do (SWATCH_EXPAND) */
  doubleClick?: boolean;
  /** pick the colour another way (a caller-provided picker, e.g. outside the editor bundle) */
  pick?(current: RGBA | null, allowOpacity: boolean, done: (c: RGBA) => void, def: RGBA | null): void;
}
export interface Swatch { el: HTMLSpanElement; get(): RGBA | null; set(c: RGBA | null): void; open(): void; /** wxWindow::Enable */ setDisabled(on: boolean): void }

const CHECKER = "repeating-conic-gradient(#c0c0c0 0 25%, #ffffff 0 50%) 0 0 / 8px 8px";
const b255 = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));
/** The CSS background of a swatch: the colour, blended over the checkerboard when it is translucent. */
export function swatchBackground(c: RGBA | null): string {
  if (!c) return CHECKER;
  const rgba = `rgba(${b255(c.r)},${b255(c.g)},${b255(c.b)},${Math.max(0, Math.min(1, c.a))})`;
  return c.a >= 1 ? rgba : `linear-gradient(${rgba},${rgba}),${CHECKER}`;
}
/** "#rrggbb" / "#rrggbbaa" / "rgb(a)(…)" to RGBA (null when it is none of them). */
export function parseColor(text: string | null | undefined): RGBA | null {
  if (!text) return null;
  const t = text.trim();
  if (t.startsWith("#")) return fromHex(t.length === 7 ? t + "FF" : t);
  const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\s*\)$/i.exec(t);
  if (!m) return null;
  return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: m[4] === undefined ? 1 : +m[4] };
}
/** RGBA to "#rrggbb" (opaque) or "#rrggbbaa". */
export function colorText(c: RGBA): string { const x = toHex(c).toLowerCase(); return c.a >= 1 ? x.slice(0, 7) : x; }
/** RGBA to the CSS rgba() a canvas takes. */
export function cssColor(c: RGBA): string { return `rgba(${b255(c.r)},${b255(c.g)},${b255(c.b)},${+c.a.toFixed(3)})`; }

export function colorSwatch(init: RGBA | null, opts: SwatchOpts = {}): Swatch {
  let cur = init ? { ...init } : null;
  const w = opts.w ?? 24, hh = opts.h ?? 14;
  const el = document.createElement("span");
  el.className = "k-swatch";
  if (opts.id) el.id = opts.id;
  if (opts.key) el.dataset.k = opts.key;
  el.tabIndex = opts.readOnly ? -1 : 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", opts.title || "Color");
  el.style.cssText = `display:inline-block;flex:none;width:${w}px;height:${hh}px;border:1px solid var(--ink-3);border-radius:2px;vertical-align:middle;box-sizing:border-box;cursor:${opts.readOnly ? "default" : "pointer"}`;
  const paint = (): void => { el.style.background = swatchBackground(cur); el.title = opts.title || (cur ? colorText(cur) : "Unspecified"); el.dataset.color = cur ? colorText(cur) : ""; };
  let disabled = false;
  const open = (): void => {
    if (opts.readOnly || disabled) return;
    const pick = opts.pick || colorPicker;
    pick(cur, !!opts.opacity, (c) => {
      cur = c.r === 0 && c.g === 0 && c.b === 0 && c.a === 0 && opts.def === null ? null : { ...c };
      paint(); if (opts.onChange) opts.onChange(cur);
    }, opts.def === undefined ? null : opts.def);
  };
  if (opts.doubleClick) {
    el.addEventListener("dblclick", (ev) => { ev.preventDefault(); ev.stopPropagation(); open(); });
    el.addEventListener("auxclick", (ev) => { if (ev.button === 1) { ev.preventDefault(); open(); } });
  } else el.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); open(); });
  el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
  paint();
  const setDisabled = (on: boolean): void => { disabled = on; el.style.opacity = on ? "0.4" : ""; el.style.cursor = on || opts.readOnly ? "default" : "pointer"; el.setAttribute("aria-disabled", on ? "true" : "false"); };
  return { el, get: () => (cur ? { ...cur } : null), set(c) { cur = c ? { ...c } : null; paint(); }, open, setDisabled };
}
