// editor/kicad-check.ts — Run DRC and Run ERC through KiCad itself.
//
// The server writes the project out as it is now and runs Junction desktop's own kicad-cli on it
// (server/src/kicad_check.rs), so the dialogs list exactly what the desktop's checkers report.  The
// browser's TypeScript checks (pcb-tools drc*.ts, sch-tools erc*.ts) stay as the instant checks while
// editing and as the fallback when the server cannot run kicad-cli (no kicad-cli installed, offline, a
// failure).  The report is kicad-cli's JSON (`--format json --units mm --severity-all`).
import { api } from "./util";

export interface CliItem { description: string; pos?: { x: number; y: number }; uuid?: string }
export interface CliViolation { type: string; severity: string; description: string; items: CliItem[]; pos?: { x: number; y: number }; layer?: string; excluded?: boolean; comment?: string }
export interface DrcReport { violations?: CliViolation[]; unconnected_items?: CliViolation[]; schematic_parity?: CliViolation[]; kicad_version?: string }
export interface ErcReport { sheets?: { path: string; uuid_path: string; violations: CliViolation[] }[]; kicad_version?: string }

/** Why the last server check did not run, for the dialog's status line ("" when it ran). */
export let lastFallback = "";

async function post<T>(path: string, body: unknown): Promise<T | null> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) { lastFallback = "offline"; return null; }
  try {
    const r = await api(path, { method: "POST", body: JSON.stringify(body) }) as { report?: T };
    lastFallback = "";
    return r && r.report ? r.report : null;
  } catch (e) {
    const msg = String((e as Error).message || e);
    lastFallback = /^501\b/.test(msg) ? "no kicad-cli on this server" : msg.replace(/^\d+\s*/, "").slice(0, 200);
    return null;
  }
}

/** KiCad's DRC of the board document `docId`, or null when the server could not run it. */
export function serverDrc(docId: string, o: { parity: boolean; refill: boolean; allTrackErrors?: boolean }): Promise<DrcReport | null> {
  return post<DrcReport>(`/api/docs/${encodeURIComponent(docId)}/drc`, { parity: o.parity, refill: o.refill, allTrackErrors: !!o.allTrackErrors });
}
/** KiCad's ERC of the project's whole hierarchy, asked from schematic `docId`, or null. */
export function serverErc(docId: string): Promise<ErcReport | null> {
  return post<ErcReport>(`/api/docs/${encodeURIComponent(docId)}/erc`, {});
}

/** Every uuid in a document mapped to the id of the item that holds it (a pad's or a pin's uuid to its footprint or symbol). */
export function uuidIndex(doc: KDoc): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: SNode, owner: string): void => {
    if (!Array.isArray(n)) return;
    if ((n[0] === "uuid" || n[0] === "tstamp") && typeof n[1] === "string") { if (!out.has(n[1])) out.set(n[1], owner); return; }
    for (const c of n) if (Array.isArray(c)) walk(c as SNode, owner);
  };
  for (const [id, it] of doc.items) { out.set(id, id); walk(it.node, id); }
  return out;
}

/** A kicad-cli violation as a dialog marker: its rule, severity, message, place and the items it names. */
export function toMarker(v: CliViolation, ids: Map<string, string>): { code: string; severity: string; x: number; y: number; text: string; ids: string[]; kiids: string[]; descs: string[]; layer?: string; excluded?: boolean; comment?: string; items: { x: number; y: number; desc: string }[] } {
  const items = v.items || [];
  const at = v.pos || (items[0] && items[0].pos) || { x: 0, y: 0 };
  const found = items.map((i) => (i.uuid ? ids.get(i.uuid) || "" : "")).filter((x) => x);
  return {
    code: v.type, severity: v.severity === "error" ? "error" : v.severity === "warning" ? "warning" : v.severity,
    x: at.x, y: at.y, text: v.description, ...(v.layer ? { layer: v.layer } : {}), ids: Array.from(new Set(found)), kiids: items.map((i) => i.uuid || "").filter((u) => u), descs: items.map((i) => i.description),
    items: items.map((i) => ({ x: i.pos ? i.pos.x : at.x, y: i.pos ? i.pos.y : at.y, desc: i.description })),
    ...(v.excluded ? { excluded: true, comment: v.comment || "" } : {}),
  };
}
