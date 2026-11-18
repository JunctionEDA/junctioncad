// measure-classes.tsx — the class names of the dimension labels measure-session.ts draws over the canvas.  They
// live in a .tsx file because Tailwind builds only the classes it finds in the files it scans
// (shared/styles/tailwind.css @source), and it scans this domain's .tsx files.
export const DIMS_LAYER = "cad-dims absolute inset-0 pointer-events-none overflow-hidden z-[1]";
export const DIM_LABEL = "cad-dim absolute pointer-events-auto px-1 rounded-sm border text-xs mono whitespace-nowrap -translate-x-1/2 -translate-y-1/2 cursor-copy";
export const DIM_LIVE = "bg-panel border-line-2 text-ink";
export const DIM_PINNED = "bg-panel border-line text-ink-2";
