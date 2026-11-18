// editor/crossprobe.ts — cross-probing between a project's schematic and its board, as Eeschema and Pcbnew do
// over KIWAY mail (SCH_EDITOR_CONTROL::CrossProbeSchToPcb, PCB_SELECTION_TOOL::CrossProbePcbToSch and the
// "$SELECT:" remote command each side runs on the other's message).
//
// Selecting symbols in a schematic window selects their footprints in a board window of the same project, and
// the other way round.  The windows are tabs of one browser, so the message goes over a BroadcastChannel named
// for the project; it carries the references, never the other side's ids.  What the receiving side does follows
// its Preferences: the schematic's Cross-probing (select, center, zoom) and the board's (on selection, center on
// items, zoom to fit).  "Select on PCB" / "Select on Schematic" in the context menus send the selection even
// when sending on selection is off, as KiCad's actions do.
import { E } from "./state";
import { state } from "./appstore";
import { clearAllSelection, selectionChanged, selectionHooks, selectionItems } from "./gestures";
import { fitBox, isSch, pxPerMm, stage } from "./view";
import { prefs } from "../dialogs/prefs";

interface Probe { from: "sch" | "pcb"; refs: string[]; window: string }

const WINDOW = Math.random().toString(36).slice(2);
let channel: BroadcastChannel | null = null, channelFor = "", lastSent = "", applying = false;

function projectId(): string | null {
  const p = state.project as { projectId?: string } | null;
  if (p && p.projectId) return p.projectId;
  const m = location.pathname.match(/^\/p\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}
function bus(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const id = projectId(); if (!id) return null;
  if (channel && channelFor === id) return channel;
  if (channel) channel.close();
  channel = new BroadcastChannel("kc-crossprobe:" + id); channelFor = id;
  channel.onmessage = (ev: MessageEvent<Probe>) => { if (ev.data && ev.data.window !== WINDOW) receive(ev.data); };
  return channel;
}

/** The references of what is selected: symbols on a schematic, footprints on a board. */
function selectedRefs(): string[] {
  const want = isSch() ? "symbol" : "footprint";
  const refs = new Set<string>();
  for (const it of selectionItems()) if (it && it.kind === want && it.ref && !it.ref.startsWith("#")) refs.add(it.ref);
  return [...refs].sort();
}
const sendOnSelection = (): boolean => (isSch() ? prefs().schDisplay.crossProbeSelect !== false : (prefs().pcbDisplay.crossProbing || { onSelection: true }).onSelection !== false);

/** Tell the other editor of this project what is selected here (force: the Select on PCB / Schematic actions). */
export function sendSelection(force = false): void {
  if (applying || !E.kdoc || E.DOC_TYPE !== "kicad_sch" && E.DOC_TYPE !== "kicad_pcb" || (E.kdoc as KDoc & { fpEditor?: unknown }).fpEditor) return;
  if (!force && !sendOnSelection()) return;
  const refs = selectedRefs(), key = refs.join(" ");
  if (!force && (key === lastSent || (!refs.length && !lastSent))) return;
  lastSent = key;
  const b = bus(); if (b) b.postMessage({ from: isSch() ? "sch" : "pcb", refs, window: WINDOW } as Probe);
}

function receive(p: Probe): void {
  if (!E.kdoc || (p.from === "sch") === isSch()) return;
  const sch = isSch(), want = sch ? "symbol" : "footprint", refs = new Set(p.refs);
  const opts = sch ? { select: prefs().schDisplay.crossProbeSelect !== false, center: prefs().schDisplay.crossProbeCenter !== false, zoom: prefs().schDisplay.crossProbeZoom !== false }
    : (() => { const x = prefs().pcbDisplay.crossProbing || { onSelection: true, centerOnItems: true, zoomToFit: true }; return { select: x.onSelection !== false, center: x.centerOnItems !== false, zoom: x.zoomToFit !== false }; })();
  if (!opts.select) return;
  const hits: KItem[] = [];
  for (const it of (E.kdoc as KDoc).items.values()) if (it.kind === want && it.ref && refs.has(it.ref)) hits.push(it);
  applying = true;
  try {
    clearAllSelection(false);
    E.selection = new Set(hits.map((h) => h.id));
    lastSent = selectedRefs().join(" ");
    selectionChanged();
    if (hits.length && (opts.center || opts.zoom)) {
      const b = hits.reduce((a, h) => (h.bbox ? [Math.min(a[0], h.bbox[0]), Math.min(a[1], h.bbox[1]), Math.max(a[2], h.bbox[2]), Math.max(a[3], h.bbox[3])] : a), [Infinity, Infinity, -Infinity, -Infinity]);
      if (isFinite(b[0])) {
        if (opts.zoom) { const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.12 + (sch ? 8 : 2); fitBox([b[0] - pad, b[1] - pad, b[2] - b[0] + 2 * pad, b[3] - b[1] + 2 * pad]); }   // fitBox takes x, y, width, height
        else { const ppm = pxPerMm(), w = stage.clientWidth / ppm, h = stage.clientHeight / ppm, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2; fitBox([cx - w / 2, cy - h / 2, w, h]); }
      }
    }
  } finally { applying = false; }
}

// a selection made with the mouse or keys settles after the event; selectionChanged() covers the rest
selectionHooks.push(() => sendSelection());
const later = (): void => { setTimeout(() => sendSelection(), 0); };
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pointerup", later, true); window.addEventListener("keyup", later, true);
  // listen from the start: a window that has selected nothing yet still has to take the other's selection
  const listen = window.setInterval(() => { if (E.kdoc && bus()) window.clearInterval(listen); }, 500);
}
