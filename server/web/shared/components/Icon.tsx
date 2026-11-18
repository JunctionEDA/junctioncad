// Icon.tsx — KiCad's own icons (light + dark variants from resources/bitmaps_png, chosen by
// the `dark:` variant on the .lt / .dk groups) and the stroke glyphs of the collab tools.
import { SPEC } from "../../domains/pcb/spec";
import { loadIconPack, packIcon, useIconPack } from "../../domains/pcb/iconpack";
import { useMemo } from "react";
import { uniqueIconIds } from "./icon-ids";
import { ensureIconCss } from "./kicon-dom";

loadIconPack();

/* `kicon` / `lt` / `dk` stay as plain hooks; the sizing and the light/dark swap are the utilities. */
const ICON = "kicon block w-6 h-6";

export function KIcon({ name, size }: { name: string | null | undefined; size?: number }) {
  // the icons of the menu entries the toolbars do not use come from the lazily fetched pack (iconpack.ts)
  const ready = useIconPack();
  const ic = name ? SPEC.icons[name] || packIcon(name) : undefined;
  // this copy's own gradient / marker ids (icon-ids.ts)
  const markup = useMemo(() => (ic ? { lt: uniqueIconIds(ic.light || ic.dark || ""), dk: uniqueIconIds(ic.dark || ic.light || "") } : null), [ic]);
  if (!ic && name && !ready) return <svg className={size ? "kicon block" : ICON} viewBox="0 0 24 24" aria-hidden="true" width={size} height={size} />;
  if (!ic) {
    return (
      <svg className={ICON} viewBox="0 0 24 24" aria-hidden="true" width={size} height={size} data-missing={name || ""}>
        <rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  }
  return (
    <svg className={size ? "kicon block" : ICON} viewBox={ic.vb || "0 0 24 24"} aria-hidden="true" width={size} height={size}>
      <g className="lt dark:hidden" dangerouslySetInnerHTML={{ __html: markup ? markup.lt : "" }} />
      <g className="dk hidden dark:inline" dangerouslySetInnerHTML={{ __html: markup ? markup.dk : "" }} />
    </svg>
  );
}

/** A 24×24 stroke glyph given as inline SVG markup (module tools, the collab buttons). */
export function Glyph({ svg }: { svg: string }) {
  return (
    <svg className={ICON + " fill-none stroke-current stroke-[1.8] [stroke-linecap:round] [stroke-linejoin:round]"}
      viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
  );
}

// The drawn platform glyphs of the chrome (kicon-dom.ts): tree expanders, menu arrows and check marks, header sort
// arrows and combo arrows, never font characters.
ensureIconCss();
/** wxTreeCtrl / wxDataViewCtrl expander (a GTK triangle); `kids` false keeps the space of a leaf. */
export function TreeExpander({ open, kids = true, onToggle, className }: { open: boolean; kids?: boolean; onToggle?: () => void; className?: string }) {
  return <span className={"ktw" + (kids ? (open ? "" : " shut") : " leaf") + (className ? " " + className : "")} aria-hidden="true" data-twist="" data-open={kids ? String(open) : undefined}
    onClick={onToggle ? (ev) => { ev.stopPropagation(); onToggle(); } : undefined} />;
}
/** A menu entry's sub-menu marker. */
export function MenuArrow({ className }: { className?: string }) { return <span className={"kmarrow" + (className ? " " + className : "")} aria-hidden="true" />; }
/** A checkable (or radio) menu entry's indicator. */
export function MenuCheck({ on, radio }: { on: boolean; radio?: boolean }) { return <span className={"kmchk" + (radio ? " radio" : "") + (on ? " on" : "")} aria-hidden="true" />; }
/** A sorted column header's arrow. */
export function SortArrow({ asc }: { asc: boolean }) { return <span className={"ksort" + (asc ? "" : " desc")} aria-hidden="true" data-sort-ind={asc ? "asc" : "desc"} />; }
/** A drop-down button's arrow. */
export function ComboArrow({ className }: { className?: string }) { return <span className={"kcarrow" + (className ? " " + className : "")} aria-hidden="true" />; }
/** A close box (frame title bar, pane caption, notebook tab), drawn. */
export function CloseMark() { return <svg className="kclose" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.4" fill="none" /></svg>; }
