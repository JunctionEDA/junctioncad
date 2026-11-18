// pcbdialogs/inspect — the Inspect menu's dialogs in KiCad's layout: Design Rules Checker (DIALOG_DRC),
// Board Statistics (DIALOG_BOARD_STATISTICS), Net Inspector and Clearance Resolution.  The checks themselves
// are pcb-tools.js' (drc, netlist, boardStatistics, inspectClearance); this module lays their results out.
import { E } from "../state";
import { fitBox } from "../view";
import { DRC_ITEMS, drcItemTitle } from "../../canvas/drc-items";
import { NL } from "./canvas";
import { projectNetlist } from "./update-pcb";
import { runZoneFill } from "./zonefill";
import { fabContext, loadFab } from "../fab-outputs";
import { bitmapButton, box, checkField, currentUnits, download, fmtLenU, grid, h, messageBox, notebook, openDialog, textEntryBox, textField, type CellValue } from "./ui";
import { openPopupMenu, type PopupEntry } from "../contextmenu";
import { adoptProjectFile, canWriteProject, saveProjectFile } from "../projectfile";
import { editProject, type Plain, type ProjectEdit } from "../../canvas/project-file";
import { loadBoardHeader, openBoardSetup } from "./board-setup";
import { loadLibraryFootprint } from "../library";
import { kicadActionAvailable, runKicadAction } from "../hotkeys";
import { state as appStore } from "../appstore";
import { lastFallback, serverDrc, toMarker, uuidIndex } from "../kicad-check";

export interface Marker { code: string; severity: string; x: number; y: number; text: string; ids: string[]; kiids?: string[]; descs?: string[]; layer?: string; excluded?: boolean; comment?: string; selected?: boolean }
interface Settings { severities: Record<string, string>; netclasses: Record<string, { clearance?: number }>; clearance: number; edgeClearance: number; minTrackWidth: number; minThroughDrill: number; boardSetup?: unknown }
interface NetRow { name: string; code: number; padCount: number; viaCount: number; trackLength: number; zoneCount: number; unconnected: number }
interface Stats { footprints: { total: number; front: number; back: number; smd: number; tht: number; other: number }; pads: { total: number; smd: number; tht: number; npth: number; connect: number };
  vias: { total: number; through: number; blind: number; micro: number }; tracks: { count: number; length: number }; zones: number; drills: number; width: number; height: number; area: number }
interface PcbToolsApi {
  state: { markers: Marker[] };
  drc(doc: KDoc, settings: unknown, opts?: { unconnected?: boolean; outline?: boolean; rules?: string | null; footprintOwn?: boolean }): Marker[];
  /** the custom rules' (.kicad_dru) matched-length checks */
  customRuleMarkers?(doc: KDoc, settings: unknown, rules: string | null): Marker[];
  designSettings(src: unknown): Settings;
  netInspector(doc: KDoc): NetRow[];
  netItemIds(doc: KDoc, key: string): Set<string>;
  boardStatistics(doc: KDoc): Stats;
  boardLayerName(doc: KDoc, layer: string): string;
  inspectClearance(doc: KDoc, a: string, b: string, settings: unknown): { gap: number | null; required: number; sameNet: boolean; nets: string[] } | null;
  netclassOf(s: Settings, net: string): { clearance?: number };
  footprintDiffLines(boardFp: SNode, libFp: SNode): string[];
  inspectConstraints(doc: KDoc, id: string, s: Settings, fmt: (mm: number) => string): { title: string; header: string; item: string; lines: string[]; resolved: string }[] | null;
  selectionIds(ctx: ToolCtx): Set<string>;
}
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;
const settings = (): Settings => PT().designSettings(E.proSettings || null);
const board = (): KDoc | null => (E.kdoc && E.kdoc.type === "pcb" ? (E.kdoc as KDoc) : null);

/** A short description of a board item for the lists (what KiCad's GetItemDescription gives). */
export function describeItem(doc: KDoc, id: string): string {
  const it = doc.items.get(id); if (!it) return "";
  const net = KiCadCanvas.netNameOf ? String((KiCadCanvas.netNameOf as (d: KDoc, n: SNode) => string)(doc, it.node) || "") : "";
  const layer = it.layer || String(((KiCadCanvas.kid(it.node, "layer") as SNode | null) || [])[1] || "");
  const on = (what: string): string => `${what}${net ? ` [${net}]` : ""}${layer ? ` on ${layer}` : ""}`;
  switch (it.kind) {
    case "footprint": return `Footprint ${it.ref || it.lib || ""}`;
    case "segment": return on("Track");
    case "arc": return on("Track (arc)");
    case "via": return `Via${net ? ` [${net}]` : ""}`;
    case "zone": return on("Zone");
    default: return on(it.kind.replace(/^gr_/, "Graphic ").replace(/_/g, " "));
  }
}

const UNCONNECTED = new Set(["unconnected_items"]);
const PARITY = new Set(DRC_ITEMS.slice(DRC_ITEMS.findIndex((i) => i[0] === "Schematic Parity") + 1, DRC_ITEMS.findIndex((i) => i[0] === "Signal Integrity")).map((i) => i[1]).filter((c) => c !== "unconnected_items"));

// what the last run found, kept while the board stays open so the dialog reopens on it (KiCad keeps its markers too)
const last: { doc: KDoc | null; markers: Marker[]; ran: boolean; elapsed: number } = { doc: null, markers: [], ran: false, elapsed: 0 };
const prefs = { refill: true, parity: true, errors: true, warnings: true, exclusions: false };

/** One DRC run as DIALOG_DRC lists it: the board checks, then schematic parity when asked and the schematic can be read. */
async function collectMarkers(doc: KDoc, parity: boolean): Promise<{ markers: Marker[]; parityError: string }> {
  const s = settings();
  // the board's (setup …) decides the solder mask expansion, minimum web width and via tenting the mask checks use
  if (!s.boardSetup) { try { const h = await loadBoardHeader(); if (h && h.setup) s.boardSetup = h.setup; } catch (e) { /* the cached copy, if any */ } }
  let markers = PT().drc(doc, s, { rules: E.druText, footprintOwn: true }); const pt = PT(); if (pt.customRuleMarkers && E.druText) markers = markers.concat(pt.customRuleMarkers(doc, s, E.druText)); let parityError = parity ? "" : "not requested";
  if (parity) {
    const res = await projectNetlist();
    if ("error" in res) parityError = res.error;
    else {
      for (const p of NL().schematicParity(doc, res.netlist)) {
        const sev = s.severities[p.code] || (DRC_ITEMS.find((i) => i[1] === p.code) || ["", "", "warning"])[2];
        if (sev !== "ignore") markers.push({ ...p, severity: sev });
      }
    }
  }
  markers = markers.map((m) => (m.text.startsWith(drcItemTitle(m.code)) || (m as Marker & { message?: boolean }).message || !DRC_ITEMS.some((i) => i[1] === m.code) ? m : { ...m, text: `${drcItemTitle(m.code)}: ${m.text}` }));
  return { markers, parityError };
}

/**
 * The Design Rules Checker's result as data, for callers that have no dialog (a plugin running `kicad-cli pcb drc`):
 * each marker with the tab it belongs to and a description of every item it names.
 */
export async function drcReport(o: { parity?: boolean; text?: string } = {}): Promise<{ markers: (Marker & { group: "violation" | "unconnected" | "parity"; items: { id: string; description: string }[] })[]; parityError: string } | null> {
  // `text` is another board file's contents (a copy or a candidate a plugin wrote): it is checked instead of the open board, under the open project's rules.
  const doc = typeof o.text === "string" && o.text ? (KiCadCanvas.parseDoc as (t: string, k: string) => KDoc)(o.text, "kicad_pcb") : board(); if (!doc) return null;
  const r = await collectMarkers(doc, o.parity !== false);
  return { parityError: r.parityError, markers: r.markers.map((m) => ({ ...m, group: UNCONNECTED.has(m.code) ? "unconnected" as const : PARITY.has(m.code) ? "parity" as const : "violation" as const,
    items: m.ids.map((id) => ({ id, description: describeItem(doc, id) })) })) };
}

// ---------------------------------------------------------------- exclusions and severities (.kicad_pro)
interface ExclusionApi {
  exclusionOf(doc: KDoc, m: Marker, comment?: string): unknown; exclusionKey(ex: unknown): string; readExclusion(e: unknown): unknown;
  projectExclusions(text: string | null): unknown[]; applyExclusions(doc: KDoc, markers: Marker[], entries: unknown[]): Marker[];
  withExclusion(entries: unknown[], ex: unknown): unknown[]; withoutExclusions(entries: unknown[], keys: Set<string>): unknown[];
  violatingRuleName(m: Marker): string | null; inspectDrcAction(code: string): string | null; fixDrcEntry(code: string, mainKind?: string | null): { label: string; action: string } | null; DRC_RUN_TEXT: Record<string, string>;
}
const XA = (): ExclusionApi => (window as unknown as { PcbTools: ExclusionApi }).PcbTools;
/** The exclusions in force: the project's, or this session's when the project file cannot be written. */
let sessionExclusions: unknown[] | null = null;
const exclusions = (): unknown[] => sessionExclusions || XA().projectExclusions(E.proSettings || null);
/** Write project-file edits (board.design_settings …) and make the editor use the new file; false when it could not be saved. */
async function saveProjectEdits(edits: ProjectEdit[]): Promise<boolean> {
  const text = E.proSettings || null; if (!text || !canWriteProject()) return false;
  let res: { text: string; changed: ProjectEdit[] };
  try { res = editProject(text, edits); } catch (e) { return false; }
  if (!res.changed.length) return true;
  adoptProjectFile(res.text);                      // the dialog sees the change at once; the upload follows
  return saveProjectFile(res.text, res.changed);
}
const DS = ["board", "design_settings"];
function storeExclusions(ctx: ToolCtx, entries: unknown[]): void {
  sessionExclusions = entries;
  void saveProjectEdits([{ path: [...DS, "drc_exclusions"], value: entries as Plain }]).then((ok) => { if (ok) sessionExclusions = null; else if (!ctx.viewOnly) ctx.toast("The exclusion is kept for this session: the project file could not be written", 4000); });
}
function storeSeverity(ctx: ToolCtx, code: string, sev: string): void {
  sevOverride[code] = sev;
  void saveProjectEdits([{ path: [...DS, "rule_severities", code], value: sev }]).then((ok) => { if (ok) delete sevOverride[code]; else if (!ctx.viewOnly) ctx.toast("The severity is kept for this session: the project file could not be written", 4000); });
}
const sevOverride: Record<string, string> = {};
const severityOf = (code: string): string => sevOverride[code] || settings().severities[code] || (DRC_ITEMS.find((i) => i[1] === code) || ["", "", "error"])[2];
const errorText = (code: string): string => drcItemTitle(code);

// DIALOG_DRC's gear menu options (persisted like the dialog's settings)
const OPT_KEY = "kc.drc.options";
const opts = ((): { reportAllTrackErrors: boolean; crossprobe: boolean; scrollOnCrossprobe: boolean } => {
  const d = { reportAllTrackErrors: false, crossprobe: true, scrollOnCrossprobe: true };
  try { const j = JSON.parse(localStorage.getItem(OPT_KEY) || "null"); if (j && typeof j === "object") Object.assign(d, j); } catch (e) { /* defaults */ }
  return d;
})();
const saveOpts = (): void => { try { localStorage.setItem(OPT_KEY, JSON.stringify(opts)); } catch (e) { /* not kept */ } };
/** DIALOG_DRC's formatElapsed: "%.2f s", or "%d min %d s" from a minute on. */
export function formatElapsed(ms: number): string { const t = Math.round(ms / 1000); return t >= 60 ? `${Math.floor(t / 60)} min ${t % 60} s` : `${(ms / 1000).toFixed(2)} s`; }

/** The open DRC dialog's handles for Inspect > Previous / Next Marker and Exclude Marker (DRC_TOOL). */
let live: { step(dir: 1 | -1): void; exclude(): void } | null = null;
export function prevMarker(ctx: ToolCtx): void { if (live) live.step(-1); else openDrc(ctx); }
export function nextMarker(ctx: ToolCtx): void { if (live) live.step(1); else openDrc(ctx); }
export function excludeMarker(): void { if (live) live.exclude(); }

export function openDrc(ctx: ToolCtx): void {
  const doc = board(); if (!doc) { ctx.toast("The Design Rules Checker needs a board"); return; }
  if (last.doc !== doc) { last.doc = doc; last.markers = []; last.ran = false; }
  let selected: Marker | null = null, book: ReturnType<typeof notebook> | null = null;
  const lists: HTMLElement[] = [h("div", { class: "pd-list pd-drclist" }), h("div", { class: "pd-list pd-drclist" }), h("div", { class: "pd-list pd-drclist" }), h("div", { class: "pd-list pd-drclist" })];
  const status = h("span", { class: "pd-status", "data-k": "drc-status" });
  const gauge = h("progress", { class: "pd-gauge", max: "100", value: "0", style: "display:none;width:160px" }) as HTMLProgressElement;
  const badge = { errors: h("span", { class: "pd-badge", "data-k": "count-errors" }, "0"), warnings: h("span", { class: "pd-badge", "data-k": "count-warnings" }, "0"), exclusions: h("span", { class: "pd-badge", "data-k": "count-exclusions" }, "0") };
  const tabOf = (m: Marker): number => (UNCONNECTED.has(m.code) ? 1 : PARITY.has(m.code) ? 2 : 0);
  const shown = (m: Marker): boolean => (m.excluded ? prefs.exclusions : m.severity === "error" ? prefs.errors : prefs.warnings);
  // the canvas: excluded markers in LAYER_DRC_EXCLUSION's colour
  const show = (): void => { PT().state.markers = last.markers.filter(shown).map((m) => (m.excluded ? { ...m, severity: "exclusion" } : m)); ctx.requestRender(); };
  const rowsOf = (): { m: Marker; row: HTMLElement }[] => { const out: { m: Marker; row: HTMLElement }[] = []; for (const l of lists.slice(0, 3)) for (const r of Array.from(l.querySelectorAll<HTMLElement>(".it[data-i]"))) out.push({ m: last.markers[Number(r.dataset.i)], row: r }); return out; };
  const select = (m: Marker, row: HTMLElement): void => {
    selected = m;
    // DIALOG_DRC::OnDRCItemSelected selects the marker: it is drawn in LAYER_DRC_HIGHLIGHTED
    for (const x of last.markers) if (x.selected) delete x.selected;
    m.selected = true; show();
    for (const l of lists) for (const r of Array.from(l.querySelectorAll(".it.sel"))) r.classList.remove("sel");
    row.classList.add("sel"); row.scrollIntoView({ block: "nearest" });
    if (opts.crossprobe) ctx.setHighlight(m.ids.length ? new Set(m.ids) : null);
    if (opts.crossprobe && opts.scrollOnCrossprobe && (m.ids.length || m.x || m.y)) fitBox([m.x - 12, m.y - 9, m.x + 12, m.y + 9], 0.9);   // "Center on Cross-probe"
    ctx.requestRender();
  };
  const reExclude = (): void => { XA().applyExclusions(doc, last.markers, exclusions()); };
  const fill = (): void => {
    const counts = [0, 0, 0];
    const keep = selected;
    for (const l of lists) l.replaceChildren();
    last.markers.forEach((m, i) => {
      const t = tabOf(m); if (!shown(m)) return; counts[t]++;
      const row = h("div", { class: "it" + (m === keep ? " sel" : ""), "data-code": m.code, "data-i": String(i) }, h("span", { class: "pd-sev " + (m.excluded ? "exclusion" : m.severity) }), h("div", null, h("div", null, m.text),
        ...(m.descs || m.ids.map((id) => describeItem(doc, id))).map((d) => h("div", { class: "sub" }, d)), m.excluded && m.comment ? h("div", { class: "sub", "data-k": "comment" }, m.comment) : null));
      row.addEventListener("click", () => select(m, row));
      row.addEventListener("contextmenu", (ev) => { ev.preventDefault(); select(m, row); rowMenu(m, ev.clientX, ev.clientY); });
      lists[t].append(row);
    });
    if (!last.ran) for (const l of lists.slice(0, 3)) l.append(h("div", { class: "pd-empty" }, "DRC has not been run."));
    // ignored tests: the rules the project's severities switch off
    const ignored = DRC_ITEMS.filter((i) => i[1] && severityOf(i[1]) === "ignore");
    for (const i of ignored) {
      const row = h("div", { class: "it", "data-code": i[1] }, h("span", { class: "pd-sev ignore" }), h("div", null, " • " + i[0]));
      row.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ignoredMenu(i[1], ev.clientX, ev.clientY); });
      lists[3].append(row);
    }
    if (book) { book.setLabel(0, `Violations (${last.ran ? counts[0] : "not run"})`); book.setLabel(1, `Unconnected Items (${last.ran ? counts[1] : "not run"})`); book.setLabel(2, `Schematic Parity (${last.ran ? counts[2] : "not run"})`); book.setLabel(3, `Ignored Tests (${ignored.length})`); }
    badge.errors.textContent = String(last.markers.filter((m) => !m.excluded && m.severity === "error").length);
    badge.warnings.textContent = String(last.markers.filter((m) => !m.excluded && m.severity !== "error").length);
    badge.exclusions.textContent = String(last.markers.filter((m) => m.excluded).length);
  };
  const refresh = (): void => { fill(); show(); };

  // ---- the violation's right-click menu (DIALOG_DRC::OnDRCItemRClick)
  const listName = (code: string): string => { const s = severityOf(code); return s === "error" ? "errors" : s === "warning" ? "warnings" : "appropriate"; };
  const exclude = (m: Marker, comment: string): void => {
    m.excluded = true; m.comment = comment;
    storeExclusions(ctx, XA().withExclusion(exclusions(), XA().exclusionOf(doc, m, comment)));
    refresh();
  };
  const unexclude = (m: Marker): void => {
    m.excluded = false; m.comment = "";
    storeExclusions(ctx, XA().withoutExclusions(exclusions(), new Set([XA().exclusionKey(XA().exclusionOf(doc, m))])));
    refresh();
  };
  const setSeverity = (code: string, sev: string): void => {
    storeSeverity(ctx, code, sev);
    if (sev === "ignore") { last.markers = last.markers.filter((m) => m.code !== code); if (selected && selected.code === code) { selected = null; ctx.setHighlight(null); } }
    else for (const m of last.markers) if (m.code === code) m.severity = sev;
    refresh();
  };
  // DIALOG_DRC::OnDRCItemRClick: ID_ADD_EXCLUSION_ALL / ID_REMOVE_EXCLUSION_ALL for a custom rule's markers
  const excludeAll = (rule: string, on: boolean): void => {
    let list = exclusions(); const drop = new Set<string>();
    for (const o of last.markers) {
      if (XA().violatingRuleName(o) !== rule) continue;
      if (on) { if (!o.excluded) { o.excluded = true; o.comment = ""; list = XA().withExclusion(list, XA().exclusionOf(doc, o, "")); } }
      else if (o.excluded) { o.excluded = false; o.comment = ""; drop.add(XA().exclusionKey(XA().exclusionOf(doc, o))); }
    }
    if (!on) list = XA().withoutExclusions(list, drop);
    storeExclusions(ctx, list); refresh();
  };
  const pcbAction = (id: string): ((c: ToolCtx) => unknown) | null => { const a = ((CollabTools.pcb as ToolModule | undefined)?.actions || {})[id] as { run?: (c: ToolCtx) => unknown } | undefined; return a && a.run ? a.run : null; };
  const selectIds = (ids: string[]): void => { const P = PT() as unknown as { applySelection?(c: ToolCtx, ids: string[]): void }; if (P.applySelection) P.applySelection(ctx, ids.filter((id) => doc.items.has(id))); };
  const rowMenu = (m: Marker, x: number, y: number): void => {
    const ln = listName(m.code), et = errorText(m.code), sev = severityOf(m.code), rule = XA().violatingRuleName(m);
    const entries: PopupEntry[] = m.excluded
      ? [{ label: "Remove exclusion for this violation", tip: `It will be placed back in the ${ln} list`, run: () => unexclude(m) },
         { label: "Edit exclusion comment...", run: () => textEntryBox("Exclusion Comment", "", m.comment || "", true, (t) => exclude(m, t)) }]
      : [{ label: "Exclude this violation", tip: `It will be excluded from the ${ln} list`, run: () => exclude(m, "") },
         { label: "Exclude with comment...", tip: `It will be excluded from the ${ln} list`, run: () => textEntryBox("Exclusion Comment", "", "", true, (t) => exclude(m, t)) }];
    if (rule !== null) entries.push(m.excluded
      ? { label: `Remove all exclusions for violations of rule '${rule}'`, tip: `They will be placed back in the ${ln} list`, run: () => excludeAll(rule, false) }
      : { label: `Exclude all violations of rule '${rule}'...`, tip: `They will be excluded from the ${ln} list`, run: () => excludeAll(rule, true) });
    entries.push({ sep: true });
    // BOARD_INSPECTION_TOOL::InspectDRCErrorMenuText / DRC_TOOL::FixDRCErrorMenuText (offered where the board editor has the command)
    const main = doc.items.get(m.ids[0] || "");
    const insp = XA().inspectDrcAction(m.code), inspRun = insp ? pcbAction(insp) : null;
    const fix = XA().fixDrcEntry(m.code, main ? main.kind : null);
    const fixRun = !fix ? null : fix.action === "edit" ? (main && typeof KDialogs !== "undefined" && KDialogs ? () => KDialogs!.openItem(ctx, main) : null) : pcbAction(fix.action);
    if (insp && inspRun) entries.push({ label: XA().DRC_RUN_TEXT[insp], run: () => { selectIds(m.ids); inspRun(ctx); } });
    if (fix && fixRun) entries.push({ label: fix.label, run: () => { if (fix.action !== "edit") selectIds(m.ids.slice(0, 1)); fixRun(ctx); } });
    if ((insp && inspRun) || (fix && fixRun)) entries.push({ sep: true });
    if (sev === "warning") entries.push({ label: `Change severity to Error for all '${et}' violations`, tip: "Violation severities can also be edited in Board Setup", run: () => setSeverity(m.code, "error") });
    else entries.push({ label: `Change severity to Warning for all '${et}' violations`, tip: "Violation severities can also be edited in Board Setup", run: () => setSeverity(m.code, "warning") });
    entries.push({ label: `Ignore all '${et}' violations`, tip: "Violations will not be checked or reported", run: () => setSeverity(m.code, "ignore") },
      { sep: true }, { label: "Edit violation severities...", tip: "Open the Board Setup dialog", run: () => { void openBoardSetup(ctx, "Violation Severity"); } });
    openPopupMenu(x, y, entries);
  };
  // DIALOG_DRC::OnIgnoredItemRClick: Error / Warning / Ignore radio items
  const ignoredMenu = (code: string, x: number, y: number): void => {
    const cur = severityOf(code);
    openPopupMenu(x, y, ([["error", "Error"], ["warning", "Warning"], ["ignore", "Ignore"]] as [string, string][]).map(([v, label]) => ({ label, check: true, checked: cur === v, run: () => { if (cur !== v) { storeSeverity(ctx, code, v); refresh(); } } })));
  };

  const run = async (): Promise<void> => {
    const t0 = Date.now();
    const tick = setInterval(() => { status.textContent = `Elapsed: ${Math.round((Date.now() - t0) / 1000)} s`; }, 1000);
    gauge.style.display = ""; gauge.value = 5;
    try {
      // DRC_TOOL::RunTests: "Refilling all zones..." and ZONE_FILLER_TOOL::FillAllZones into the dialog's reporter
      if (prefs.refill && !ctx.viewOnly && [...doc.items.values()].some((it) => it.kind === "zone")) {
        status.textContent = "Refilling all zones...";
        await runZoneFill(ctx, { ids: [...doc.items.values()].filter((it) => it.kind === "zone").map((it) => it.id), status, label: "Fill Zone(s)", all: true });
      }
      gauge.value = 40; status.textContent = "Running KiCad's design rules checker...";
      await new Promise((r) => setTimeout(r, 0));
      // KiCad's own DRC on the server (kicad-check.ts); the browser's checks when it cannot run
      let markers: Marker[] | null = null, how = "";
      const docId = appStore.docId as string | null;
      if (docId) {
        const rep = await serverDrc(docId, { parity: prefs.parity, refill: prefs.refill, allTrackErrors: opts.reportAllTrackErrors });
        if (rep) { const ix = uuidIndex(doc); markers = [...(rep.violations || []), ...(rep.unconnected_items || []), ...(rep.schematic_parity || [])].map((v) => toMarker(v, ix)); }
      }
      if (!markers) { markers = (await collectMarkers(doc, prefs.parity)).markers; how = ` (checked in the browser: ${lastFallback || "no saved document"})`; }
      for (const m of markers) { const sv = sevOverride[m.code]; if (sv === "error" || sv === "warning") m.severity = sv; }
      markers = markers.filter((m) => sevOverride[m.code] !== "ignore");
      last.markers = XA().applyExclusions(doc, markers, exclusions()); last.ran = true; last.elapsed = (Date.now() - t0) / 1000; selected = null;
      gauge.value = 100;
      status.textContent = `Completed in ${formatElapsed(Date.now() - t0)}${how}`;
    } finally { clearInterval(tick); setTimeout(() => { gauge.style.display = "none"; }, 300); }
    ctx.setHighlight(null); refresh();
  };
  const report = (): string => {
    const lines = ["** Drc report for " + ((E.kdoc as KDoc & { fileName?: string }).fileName || "board") + " **", `** Created on ${new Date().toISOString().replace("T", " ").slice(0, 19)} **`, ""];
    const sect = (title: string, tab: number): void => {
      const list = last.markers.filter((m) => tabOf(m) === tab && shown(m));
      lines.push(`** Found ${list.length} ${title} **`);
      for (const m of list) { lines.push(`[${m.code}]: ${m.text}`, `    @(${m.x.toFixed(4)} mm, ${m.y.toFixed(4)} mm): ${m.excluded ? "Excluded" : m.severity}`); for (const d of m.descs || m.ids.map((id) => describeItem(doc, id))) lines.push("    " + d); if (m.excluded && m.comment) lines.push("    " + m.comment); }
      lines.push("");
    };
    sect("DRC violations", 0); sect("unconnected pads", 1); sect("Footprint errors", 2);
    lines.push("** End of Report **", "");
    return lines.join("\n");
  };
  const delMarker = (): void => {
    if (!selected) return;
    if (selected.excluded) storeExclusions(ctx, XA().withoutExclusions(exclusions(), new Set([XA().exclusionKey(XA().exclusionOf(doc, selected))])));   // RecordDRCExclusions drops it
    last.markers = last.markers.filter((m) => m !== selected); selected = null; ctx.setHighlight(null); refresh();
  };
  // DIALOG_DRC::OnDeleteAllClick: with exclusions on the board, "Delete exclusions too?"
  const deleteAll = (withExclusions: boolean): void => {
    const gone = last.markers.filter((m) => withExclusions || !m.excluded);
    if (withExclusions) { const keys = new Set(gone.filter((m) => m.excluded).map((m) => XA().exclusionKey(XA().exclusionOf(doc, m)))); if (keys.size) storeExclusions(ctx, XA().withoutExclusions(exclusions(), keys)); }
    last.markers = last.markers.filter((m) => !gone.includes(m)); last.ran = false; selected = null; ctx.setHighlight(null); refresh();
  };
  const delAll = (): void => {
    if (!last.markers.some((m) => m.excluded)) { deleteAll(false); return; }
    messageBox("Delete All Markers", "Delete exclusions too?", [{ label: "Cancel" }, { label: "Errors, Warnings and Exclusions", fn: () => deleteAll(true) }, { label: "Errors and Warnings Only", fn: () => deleteAll(false) }], 0);
  };
  const step = (dir: 1 | -1): void => {
    const rows = rowsOf(); if (!rows.length) return;
    let i = rows.findIndex((r) => r.m === selected); i = i < 0 ? (dir > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, i + dir));
    const r = rows[i]; if (book) book.show(tabOf(r.m)); select(r.m, r.row);
  };

  reExclude();
  openDialog({ title: "Design Rules Checker", width: 760, okLabel: "Run DRC", cancelLabel: "Close", noEnter: true, modeless: true,
    extra: [{ label: "Delete Marker", fn: delMarker }, { label: "Delete All Markers", fn: delAll }],
    build(body) {
      const refill = checkField(prefs.refill, "Refill all zones before performing DRC", { key: "refill", ro: ctx.viewOnly, onChange: (v) => { prefs.refill = v; } });
      const parity = checkField(prefs.parity, "Test for parity between PCB and schematic", { key: "parity", onChange: (v) => { prefs.parity = v; } });
      book = notebook([{ label: "Violations", build: (el) => el.append(lists[0]) }, { label: "Unconnected Items", build: (el) => el.append(lists[1]) }, { label: "Schematic Parity", build: (el) => el.append(lists[2]) }, { label: "Ignored Tests", build: (el) => el.append(lists[3]) }]);
      // OnSeverity: "All" ticks Errors and sets Warnings and Exclusions to itself
      const all = checkField(prefs.errors && prefs.warnings && prefs.exclusions, "All", { key: "showAll", onChange: (v) => { prefs.errors = true; prefs.warnings = prefs.exclusions = v; errors.set(true); warnings.set(v); excl.set(v); refresh(); } });
      const sync = (): void => { all.set(prefs.errors && prefs.warnings && prefs.exclusions); refresh(); };
      const errors = checkField(prefs.errors, "Errors", { key: "showErrors", onChange: (v) => { prefs.errors = v; sync(); } });
      const warnings = checkField(prefs.warnings, "Warnings", { key: "showWarnings", onChange: (v) => { prefs.warnings = v; sync(); } });
      const excl = checkField(prefs.exclusions, "Exclusions", { key: "showExclusions", onChange: (v) => { prefs.exclusions = v; sync(); } });
      const save = h("button", { type: "button" }, "Save...");
      save.addEventListener("click", () => download("DRC.rpt", report()));
      // the gear button (m_bMenu): the three persisted options
      const gear = bitmapButton("config", "Options", null, { key: "drc-options" });
      gear.addEventListener("click", () => { const r = gear.getBoundingClientRect(); openPopupMenu(r.left, r.bottom, [
        { label: "Report All Errors for Each Track", tip: "If unchecked, only the first error will be reported for each track", check: true, checked: opts.reportAllTrackErrors, run: () => { opts.reportAllTrackErrors = !opts.reportAllTrackErrors; saveOpts(); } },
        { sep: true },
        { label: "Cross-probe Selected Items", tip: "Highlight corresponding items on canvas when selected in the DRC list", check: true, checked: opts.crossprobe, run: () => { opts.crossprobe = !opts.crossprobe; saveOpts(); } },
        { label: "Center on Cross-probe", tip: "When cross-probing, scroll the canvas so that the item is visible", check: true, checked: opts.scrollOnCrossprobe, run: () => { opts.scrollOnCrossprobe = !opts.scrollOnCrossprobe; saveOpts(); } }]); });
      body.append(h("div", { class: "pd-row" }, refill.el, parity.el, h("span", { style: "flex:1" }), gauge, status, gear), book.el,
        h("div", { class: "pd-row pd-showrow" }, h("label", null, "Show:"), all.el, errors.el, badge.errors, warnings.el, badge.warnings, excl.el, badge.exclusions, h("span", { style: "flex:1" }), save));
      live = { step, exclude: () => { if (selected && !selected.excluded) exclude(selected, ""); } };
      refresh();
    },
    ok() { void run(); return false; },
    cancel() { live = null; ctx.setHighlight(null); let any = false; for (const x of last.markers) if (x.selected) { delete x.selected; any = true; } if (any) show(); } });
}

/** Inspect > Clear DRC Markers. */
export function clearDrcMarkers(ctx: ToolCtx): void { last.markers = []; last.ran = false; PT().state.markers = []; ctx.requestRender(); }

// ---------------------------------------------------------------- Board Statistics
interface DrillLine { count: number; shape: "Round" | "Slot"; x: number; y: number; plated: boolean; pad: boolean; start: string; stop: string }
interface StatsData {
  footprints: { title: string; front: number; back: number }[]; pads: { title: string; count: number }[]; padTotal: number; padProps: { title: string; count: number }[];
  vias: { title: string; count: number }[]; viaTotal: number; minTrackWidth: number | null; minClearance: number | null; minDrill: number | null;
  drills: DrillLine[]; hasOutline: boolean; width: number; height: number;
}
interface StatAreas { hasOutline: boolean; boardArea: number; frontCopper: number; backCopper: number; frontCourtyard: number; backCourtyard: number }
/** DIALOG_BOARD_STATISTICS' s_savedDialogState */
const statsState = { excludeNoPins: false, subtractHoles: false, subtractHolesFromCopper: false };
/** MessageTextFromValue( …, EDA_DATA_TYPE::AREA ) */
function areaText(mm2: number): string {
  const u = currentUnits();
  if (u === "in") return `${(mm2 / 645.16).toFixed(4)} in²`;
  if (u === "mil") return `${(mm2 / 0.00064516).toFixed(0)} mils²`;
  return `${mm2.toFixed(4)} mm²`;
}

/** Inspect > Board Statistics (DIALOG_BOARD_STATISTICS over board_statistics_report.cpp). */
export function openBoardStatistics(ctx: ToolCtx): void {
  const doc = board(); if (!doc) { ctx.toast("Board Statistics needs a board"); return; }
  const P = window as unknown as { PcbTools: { boardStats: { boardStatsData(d: KDoc, o: { excludeNoPads: boolean }): StatsData }; courtyards(fp: KItem): Record<string, [number, number][][]> } };
  const excl = checkField(statsState.excludeNoPins, "Exclude footprints with no pads", { key: "excludeNoPads", onChange: () => refresh() });
  const subHoles = checkField(statsState.subtractHoles, "Subtract holes from board area", { key: "subtractHoles", onChange: () => refresh() });
  const subCopper = checkField(statsState.subtractHolesFromCopper, "Subtract holes from copper areas", { key: "subtractHolesFromCopper", onChange: () => refresh() });
  const comp = h("table", { class: "pd-stat", "data-k": "components" }), pads = h("table", { class: "pd-stat", "data-k": "pads" });
  const boardT = h("table", { class: "pd-stat", "data-k": "board" }), viasT = h("table", { class: "pd-stat", "data-k": "vias" });
  const drillHost = h("div");
  let data: StatsData = P.PcbTools.boardStats.boardStatsData(doc, { excludeNoPads: statsState.excludeNoPins });
  let areas: StatAreas | null = null, areaSeq = 0, projectName = "";
  const row = (t: HTMLElement, cells: (string | number)[], cls?: string): void => { t.append(h("tr", cls ? { class: cls } : null, ...cells.map((c, i) => h("td", i ? { class: "n" } : null, String(c))))); };
  const unknownOr = (v: number | null): string => (v === null ? "unknown" : fmtLenU(v));
  const pct = (v: number): string => `${v.toFixed(2)} %`;
  // GetStackupOrDefault().BuildBoardThicknessFromStackup(): the stackup's layers (read with the areas), else the
  // default stackup, whose total is the board's thickness
  const stackupT = (): number => { const a = areas as (StatAreas & { stackupThickness?: number | null }) | null; return a && typeof a.stackupThickness === "number" ? a.stackupThickness : Number(doc.thickness) || 1.6; };
  const boardRows = (): [string, string][] => {
    const A = areas, pending = "…";
    return [
      ["Dimensions:", data.hasOutline ? `${fmtLenU(data.width)} x ${fmtLenU(data.height)}` : "unknown"],
      ["Area:", !data.hasOutline ? "unknown" : A ? areaText(A.boardArea) : pending],
      ["Front copper area:", A ? areaText(A.frontCopper) : pending], ["Back copper area:", A ? areaText(A.backCopper) : pending],
      ["Min track clearance:", unknownOr(data.minClearance)], ["Min track width:", unknownOr(data.minTrackWidth)], ["Min drill diameter:", unknownOr(data.minDrill)],
      ["Board stackup thickness:", fmtLenU(stackupT())],
      ["Front footprint area:", A ? areaText(A.frontCourtyard) : pending], ["Front footprint density:", !data.hasOutline ? "unknown" : A && A.boardArea > 0 ? pct(A.frontCourtyard * 100 / A.boardArea) : pending],
      ["Back footprint area:", A ? areaText(A.backCourtyard) : pending], ["Back footprint density:", !data.hasOutline ? "unknown" : A && A.boardArea > 0 ? pct(A.backCourtyard * 100 / A.boardArea) : pending],
    ];
  };
  const draw = (): void => {
    comp.replaceChildren(h("tr", null, h("th", null, "Components"), h("th", null, "Front Side"), h("th", null, "Back Side"), h("th", null, "Total")));
    let f = 0, b = 0;
    for (const e of data.footprints) { row(comp, [e.title, e.front, e.back, e.front + e.back]); f += e.front; b += e.back; }
    row(comp, ["Total:", f, b, f + b], "total");
    pads.replaceChildren(h("tr", null, h("th", { colspan: "2" }, "Pads")));
    for (const e of data.pads) row(pads, [e.title, e.count]);
    row(pads, ["Total:", data.padTotal], "total");
    for (const e of data.padProps) row(pads, [e.title, e.count]);
    boardT.replaceChildren(h("tr", null, h("th", { colspan: "2" }, "Board")));
    for (const [k, v] of boardRows()) row(boardT, [k, v]);
    viasT.replaceChildren(h("tr", null, h("th", { colspan: "2" }, "Vias")));
    for (const e of data.vias) row(viasT, [e.title, e.count]);
    row(viasT, ["Total:", data.viaTotal], "total");
    const rows: Record<string, CellValue>[] = data.drills.map((d) => ({ count: d.count, shape: d.shape, x: d.x, y: d.y, plated: d.plated ? "PTH" : "NPTH", kind: d.pad ? "Pad" : "Via",
      start: d.start ? PT().boardLayerName(doc, d.start) : "", stop: d.stop ? PT().boardLayerName(doc, d.stop) : "" }));
    drillHost.replaceChildren(grid([{ label: "Count", key: "count" }, { label: "Shape", key: "shape" }, { label: "X Size", key: "x", type: "len" }, { label: "Y Size", key: "y", type: "len" }, { label: "Plated", key: "plated" },
      { label: "Via/Pad", key: "kind" }, { label: "Start Layer", key: "start" }, { label: "Stop Layer", key: "stop" }], rows, { ro: true, height: "320px" }).el);
  };
  /** the Default net class's clearance (m_NetSettings->GetDefaultNetclass()->GetClearance()) */
  const defaultClearance = (): number => { const c = ((E.proSettings || {}) as { net_settings?: { classes?: { name: string; clearance?: number }[] } }).net_settings?.classes?.find((x) => x.name === "Default"); return c && typeof c.clearance === "number" ? c.clearance : 0.2; };
  // the areas come from the plotters' geometry (web/domains/pcb/fab), fetched with the fab bundle
  const loadAreas = async (): Promise<void> => {
    const seq = ++areaSeq; areas = null; draw();
    try {
      const F = await loadFab(); const fctx = await fabContext(); if (!fctx || seq !== areaSeq) return;
      projectName = fctx.projectName || "";
      const a = F.statAreas(fctx, { subtractHolesFromBoard: statsState.subtractHoles, subtractHolesFromCopper: statsState.subtractHolesFromCopper, courtyards: (fp: KItem) => P.PcbTools.courtyards(fp), defaultClearance: defaultClearance() });
      if (seq === areaSeq) { areas = a; draw(); }
    } catch (e) { console.warn("board statistics: areas", e); }
  };
  function refresh(): void {
    Object.assign(statsState, { excludeNoPins: excl.get(), subtractHoles: subHoles.get(), subtractHolesFromCopper: subCopper.get() });
    data = P.PcbTools.boardStats.boardStatsData(doc!, { excludeNoPads: statsState.excludeNoPins });
    void loadAreas();
  }
  /** FormatBoardStatisticsReport */
  const reportText = (): string => {
    const L: string[] = ["PCB statistics report\n=====================", `- Date: ${new Date().toLocaleString()}`, `- Project: ${projectName}`, `- Board name: ${projectName ? projectName + ".kicad_pcb" : ""}`, "", "Board\n-----"];
    const A = areas;
    if (data.hasOutline) L.push(`- Width: ${fmtLenU(data.width)}`, `- Height: ${fmtLenU(data.height)}`, `- Area: ${A ? areaText(A.boardArea) : "unknown"}`);
    else L.push("- Dimensions: unknown", "- Area: unknown");
    L.push(`- Front copper area: ${A ? areaText(A.frontCopper) : "unknown"}`, `- Back copper area: ${A ? areaText(A.backCopper) : "unknown"}`, `- Min track clearance: ${unknownOr(data.minClearance)}`,
      `- Min track width: ${unknownOr(data.minTrackWidth)}`, `- Min drill diameter: ${unknownOr(data.minDrill)}`, `- Board stackup thickness: ${fmtLenU(stackupT())}`, "",
      `- Front footprint area: ${A ? areaText(A.frontCourtyard) : "unknown"}`, `- Back footprint area: ${A ? areaText(A.backCourtyard) : "unknown"}`,
      `- Front component density: ${data.hasOutline && A && A.boardArea > 0 ? pct(A.frontCourtyard * 100 / A.boardArea) : "unknown"}`,
      `- Back component density: ${data.hasOutline && A && A.boardArea > 0 ? pct(A.backCourtyard * 100 / A.boardArea) : "unknown"}`, "Pads\n----");
    for (const e of [...data.pads, ...data.padProps]) L.push(`- ${e.title} ${e.count}`);
    L.push("", "Vias\n----"); for (const e of data.vias) L.push(`- ${e.title} ${e.count}`);
    const table = (rows: string[][]): string[] => {
      const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
      const line = (r: string[]): string => "|" + r.map((v, c) => " " + v.padEnd(w[c]) + " |").join("");
      return [line(rows[0]), "|" + w.map((n) => "-".repeat(n + 2) + "|").join(""), ...rows.slice(1).map(line)];
    };
    let f = 0, b = 0; const cr = [["", "Front Side", "Back Side", "Total"]];
    for (const e of data.footprints) { cr.push([e.title, String(e.front), String(e.back), String(e.front + e.back)]); f += e.front; b += e.back; }
    cr.push(["Total:", String(f), String(b), String(f + b)]);
    L.push("", "Components\n----------\n", ...table(cr), "", "Drill holes\n-----------\n",
      ...table([["Count", "Shape", "X Size", "Y Size", "Plated", "Via/Pad", "Start Layer", "Stop Layer"], ...data.drills.map((d) => [String(d.count), d.shape, fmtLenU(d.x), fmtLenU(d.y), d.plated ? "PTH" : "NPTH", d.pad ? "Pad" : "Via", d.start ? PT().boardLayerName(doc, d.start) : "", d.stop ? PT().boardLayerName(doc, d.stop) : ""])]));
    return L.join("\n") + "\n";
  };
  openDialog({ title: "Board Statistics", width: 760, noOk: true, extra: [{ label: "Generate Report File...", fn: () => download("board-statistics.txt", reportText()) }],
    build(body) {
      const general = h("div", null,
        h("div", { class: "pd-cols2" }, h("div", null, comp, pads), h("div", null, boardT, viasT)),
        h("div", { style: "display:flex;flex-direction:column;gap:4px;margin-top:8px" }, subHoles.el, subCopper.el, excl.el));
      body.append(notebook([{ label: "General", build: (el) => el.append(general) }, { label: "Drill Holes", build: (el) => el.append(drillHost) }]).el);
      void loadAreas();
    } });
}

// ---------------------------------------------------------------- Clearance Resolution
export function openClearance(ctx: ToolCtx): void {
  const doc = board(); if (!doc) return;
  const ids = Array.from(PT().selectionIds(ctx));   // the editor's selection and the board module's (tracks, vias, graphics)
  if (ids.length !== 2) { ctx.toast("Select two items for a clearance resolution report."); return; }
  const set = settings(), r = PT().inspectClearance(doc, ids[0], ids[1], set);
  if (!r) { ctx.toast("Both items need copper"); return; }
  const a = describeItem(doc, ids[0]), b = describeItem(doc, ids[1]);
  const ncName = (net: string): string => { const nc = PT().netclassOf(set, net); for (const [k, v] of Object.entries(set.netclasses)) if (v === nc) return k; return "Default"; };
  const lines: (string | [string, string])[] = [["h", "Clearance resolution for:"], ["li", a], ["li", b], ""];
  if (r.sameNet) lines.push(`Items belong to the same net ('${r.nets[0]}'). Min clearance is 0.`);
  else {
    for (const [i, net] of r.nets.entries()) lines.push(`Checking netclass '${ncName(net)}' clearance for ${i ? b : a}: ${fmtLenU(PT().netclassOf(set, net).clearance ?? set.clearance)}.`);
    lines.push("", `Resolved min clearance: ${fmtLenU(r.required)}.`, r.gap === null ? "The items share no copper layer." : `Actual clearance: ${fmtLenU(r.gap)}${r.gap < r.required - 1e-6 ? "  (violation)" : ""}.`);
  }
  openDialog({ title: "Clearance Report", width: 600, noOk: true,
    build(body) {
      const rep = h("div", { class: "pd-report", style: "min-height:220px" });
      for (const l of lines) rep.append(Array.isArray(l) ? h("div", { class: l[0] === "h" ? "ln hd" : "ln li" }, (l[0] === "li" ? "• " : "") + l[1]) : h("div", { class: "ln" }, l || " "));
      body.append(notebook([{ label: "Clearance", build: (el) => el.append(rep) }]).el);
    } });
}

// ---------------------------------------------------------------- Constraints Resolution
/**
 * BOARD_INSPECTION_TOOL::InspectConstraints in DIALOG_BOOK_REPORTER "Constraints Report": one page per constraint the
 * selected track, arc or via has, each the header, the item, what EvalRules checked and the resolved min / opt / max.
 */
export function openConstraints(ctx: ToolCtx): void {
  const doc = board(); if (!doc) return;
  const ids = Array.from(PT().selectionIds(ctx));
  if (ids.length !== 1) { ctx.toast("Select a single item for a constraints resolution report."); return; }
  const pages = PT().inspectConstraints(doc, ids[0], settings(), fmtLenU);
  if (!pages) { ctx.toast("Constraints resolution covers tracks, arcs and vias."); return; }
  // the report's <i>undefined</i> stays italic; everything else is text
  const line = (text: string, cls: string): HTMLElement => {
    const el = h("div", { class: cls });
    text.split(/(<i>undefined<\/i>)/).forEach((part) => { if (part === "<i>undefined</i>") el.append(h("i", null, "undefined")); else if (part) el.append(document.createTextNode(part)); });
    if (!text) el.textContent = "\u00a0";
    return el;
  };
  openDialog({ title: "Constraints Report", width: 640, noOk: true,
    build(body) {
      body.append(notebook(pages.map((pg) => ({ label: pg.title, build: (el: HTMLElement) => {
        const rep = h("div", { class: "pd-report", style: "min-height:260px", "data-k": "constraintsReport" });
        rep.append(line(pg.header, "ln hd"), line("\u2022 " + pg.item, "ln li"));
        for (const l of pg.lines) rep.append(line(l, "ln"));
        rep.append(line("", "ln"), line(pg.resolved, "ln"));
        el.append(rep);
      } }))).el);
    } });
}

// ---------------------------------------------------------------- Footprint Associations / Compare Footprint with Library
/** The one selected footprint, or null after the info-bar error KiCad shows. */
function selectedFootprint(ctx: ToolCtx, error: string): KItem | null {
  const doc = board(); if (!doc) return null;
  const ids = Array.from(PT().selectionIds(ctx)), it = ids.length === 1 ? doc.items.get(ids[0]) : null;
  if (!it || it.kind !== "footprint") { ctx.toast(error); return null; }
  return it;
}
/** The wxGrids here have no column labels (SetColLabelSize( 0 )). */
const hideHead = (g: { el: HTMLElement }): void => { const head = g.el.querySelector("thead"); if (head) (head as HTMLElement).style.display = "none"; };
const splitFpid = (it: KItem): { lib: string; name: string } => { const id = String(it.node[1] ?? ""), c = id.indexOf(":"); return c > 0 ? { lib: id.slice(0, c), name: id.slice(c + 1) } : { lib: "", name: id }; };

/**
 * BOARD_INSPECTION_TOOL::ShowFootprintLinks: DIALOG_FOOTPRINT_ASSOCIATIONS — Library Association (Library: / Footprint:
 * with the library's and the footprint's descriptions) and Schematic Association (the footprint's sheet path, one
 * "Sheet:" row per sheet and "Symbol:" last, with what the schematic names it).
 */
export function openFootprintAssociations(ctx: ToolCtx): void {
  const it = selectedFootprint(ctx, "Select a footprint for a footprint associations report."); if (!it) return;
  const { lib, name } = splitFpid(it);
  const libRows: Record<string, CellValue>[] = [{ k: "Library: ", v: lib, d: "" }, { k: "Footprint: ", v: name, d: "" }];
  const path = String((KiCadCanvas.kid(it.node, "path") as SNode | null || [])[1] ?? "").split("/").filter(Boolean);
  const symRows: Record<string, CellValue>[] = path.map((u, i) => ({ k: i === path.length - 1 ? "Symbol:" : "Sheet: ", v: u, d: "" }));
  const cols = [{ label: "", key: "k", width: "90px" }, { label: "", key: "v" }, { label: "", key: "d" }];
  const holder: { g: ReturnType<typeof grid> | null } = { g: null };
  openDialog({ title: "Footprint Associations", width: 640, noOk: true,
    build(body) {
      const libGrid = holder.g = grid(cols, libRows, { ro: true, height: "auto", key: "libraryAssociation" });
      const symGrid = grid(cols, symRows, { ro: true, height: "auto", key: "schematicAssociation" });
      for (const g of [libGrid, symGrid]) hideHead(g);
      body.append(box("Library Association", libGrid.el), box("Schematic Association", symGrid.el));
    } });
  // the library row's description (the library table) and the library footprint's (descr …)
  void (async () => {
    try { const L = (window as unknown as { KiCadLibrary?: { libraries(k: string): Promise<{ libraries: { name: string; description: string }[] }> } }).KiCadLibrary; if (L) { const t = await L.libraries("footprint"); const row = t.libraries.find((l) => l.name === lib); if (row) libRows[0].d = row.description; } } catch { /* none */ }
    try { const t = await loadLibraryFootprint(String(it.node[1] ?? "")); const n = t ? KiCadCanvas.parse(t) as SNode : null; const d = n ? KiCadCanvas.kid(n, "descr") as SNode | null : null; if (d) libRows[1].d = String(d[1] ?? ""); } catch { /* none */ }
    if (holder.g && holder.g.el.isConnected) { holder.g.refresh(); hideHead(holder.g); }
  })();
}

/**
 * BOARD_INSPECTION_TOOL::DiffFootprint in DIALOG_BOOK_REPORTER "Compare Footprint with Library": the Summary page
 * (the footprint, Library:, Library item:, then FootprintNeedsUpdate's report or "No relevant differences detected.")
 * and the Apply button relabelled Update Footprint from Library....
 */
export function openDiffFootprint(ctx: ToolCtx): void {
  const it = selectedFootprint(ctx, "Select a footprint to diff with its library equivalent."); if (!it) return;
  const { lib, name } = splitFpid(it);
  const rep = h("div", { class: "pd-report", style: "min-height:260px", "data-k": "footprintDiff" });
  const ln = (t: string, cls = "ln"): void => { rep.append(h("div", { class: cls }, t || "\u00a0")); };
  ln("Board vs library diff for:", "ln hd");
  ln("\u2022 " + (it.ref ? `Footprint ${it.ref}` : describeItem(board() as KDoc, it.id)), "ln li"); ln("\u2022 Library: " + lib, "ln li"); ln("\u2022 Library item: " + name, "ln li"); ln("");
  const waiting = h("div", { class: "ln" }, "Loading the library footprint...");
  rep.append(waiting);
  const canUpdate = !ctx.viewOnly && kicadActionAvailable("updateFootprint");
  openDialog({ title: "Compare Footprint with Library", width: 640, noOk: true,
    extra: canUpdate ? [{ label: "Update Footprint from Library...", fn: () => { const P = PT() as unknown as { applySelection?(c: ToolCtx, ids: string[]): void }; if (P.applySelection) P.applySelection(ctx, [it.id]); runKicadAction("updateFootprint"); } }] : undefined,
    build(body) { body.append(notebook([{ label: "Summary", build: (el) => el.append(rep) }]).el); } });
  void loadLibraryFootprint(String(it.node[1] ?? "")).then((t) => {
    waiting.remove();
    const n = t ? KiCadCanvas.parse(t) as SNode : null;
    if (!n) { ln(`The library no longer contains the item ${name}.`); return; }
    const lines = PT().footprintDiffLines(it.node, n);
    if (!lines.length) ln("No relevant differences detected.");
    for (const l of lines) ln(l);
  }).catch(() => { waiting.remove(); ln("The library is not included in the current configuration."); });
}
