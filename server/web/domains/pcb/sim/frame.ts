// sim/frame.ts — SIMULATOR_FRAME (eeschema/sim/simulator_frame.cpp, simulator_frame_ui.cpp, toolbars_simulator_frame.cpp):
// the menu bar (File / View / Simulation / Preferences), the toolbar, the notebook of analysis tabs (each a plot,
// SIM_PLOT_TAB, or the operating point's values), the console, and the side panel: the signals grid (with its
// filter and SIGNALS_GRID_TRICKS context menu), the cursors grid, the measurements grid and the tuners
// (TUNER_SLIDER).  The circuit is the project's SPICE netlist (editor/export-netlist.ts) run by ngspice compiled to
// WebAssembly (plugins/spice.ts); the results come back as ngspice's ASCII raw file.  Probe and Tune pick on the
// schematic canvas the way SIMULATOR_CONTROL::Probe / Tune do.  The workbook (.wbk JSON, version 8) holds the tabs.
import { KD, h, popupMenu, promptText, download, confirmBox, unsavedChangesBox, type PopItem } from "../dialogs/dom";
import { E, api, isSch, requestRender, toast, toolCtx } from "../dialogs/editor";
import { messageBox } from "../dialogs/sch-items";
import { bitmapButton, bitmapToggle, kicadIcon, closeMark } from "../../../shared/components/kicon-dom";
import { ensureStyle, icon, meta, showMenu, closeMenus, type MenuEntry } from "../symedit/ui";
import { menuKey } from "../../../shared/keys";
import { projectSpiceNetlist } from "../editor/export-netlist";
import { pxPerMm, worldMm } from "../editor/view";
import { convertToSpiceMarkup } from "./spice-netlist";
import { builtinLibrary } from "./builtin-libs";
import { forWasmNgspice } from "./ngspice-wasm";
import ngspiceBuild from "../../../../vendor/ngspice/build-meta.json";
import { NGSPICE_MODULE_REVISION } from "../plugins/ngspice-revision";
import { toDouble } from "../dialogs/sim-model-logic";
import { clearOperatingPoints, setOperatingPoints, setSimItems } from "./op-overlay";
import type { SimItemInfo } from "./spice-netlist";
import { editProject } from "../canvas/project-file";
import { openPreferences } from "../dialogs/preferences";
import { prefs } from "../dialogs/prefs";
import { nameOfPick } from "../editor/schnets";
import { colorPicker, fromHex, toHex } from "../editor/pcbdialogs/color-picker";
import { adoptProjectFile, canWriteProject, loadProjectFile, projectDocs, saveProjectFile, saveTextDocument } from "../editor/projectfile";
import { state } from "../editor/appstore";
import { openWorker as openSpice, type WorkerSpiceSession as SpiceSession, type Progress } from "../plugins/spice";
import { SimPlot, TRACE_COLORS, type PlotTrace } from "./plot";
import { COMPAT_MODES, openFormatValue, openSimCommand, openUserDefinedSignals, type PlotSetup } from "./dialogs";
import {
  DEFAULT_OPTIONS, OPT_SAVE_EVENTS, OPT_SAVE_I, OPT_SAVE_P, OPT_SAVE_V, acPart, commandToSimType, commandsFromOptions, eSeries, findVector,
  formatFromString, formatToString, formatValue, isPlottable, measCommand, measurementFor, measurementUnits, optionsFromCommands, parseCommand,
  readRaw, parseSpiceValue, readCircuit, signalKind, signalsFor, snapToSeries, splitSignal, toSpiceString, typeToName, unitsOf, updateUnits,
  userSignalLet, userVectorName, xAxisOf, parseSParamPorts, smithPortImpedance, type CircuitItem, type RawPlot, type SimType, type ValueFormat, type WbTab, type Workbook,
} from "./sim-logic";

// ---------------------------------------------------------------- state
interface Trace { signal: string; color: string; cursor1: boolean; cursor2: boolean }
interface Meas { expr: string; format: ValueFormat; value: string }
interface Tab {
  command: string; options: number; traces: Trace[]; meas: Meas[];
  plot: SimPlot | null; data: RawPlot | null; opText: string;
  setup: PlotSetup; cursorFmt: [ValueFormat, ValueFormat];
  /** SIM_TAB::m_lastSchTextSimCommand: the schematic's directive this tab last took (the first tab follows it) */
  lastSch: string;
  /** SIM_VIEW's Smith zoom and pan, and what the Smith toggle set aside (SIM_PLOT_TAB::SmithStashedTraces /
   *  SmithStashedCursors: the transmission traces and every cursor, for the way back) */
  smithZoom: number; smithPan: { x: number; y: number };
  stashTraces: { vector: string; name: string; base_type: number }[];
  stashCursors: { id: number; vector: string; base_type: number; sub_type: number; frequency: number }[];
}
interface Tuner { name: string; value: number; min: number; max: number; steps: number; multi: boolean; series: 0 | 24 | 48 | 96 | 192; orig: string; symId: string | null; el?: HTMLElement }

type Circuit = { items: CircuitItem[]; nets: string[]; directives: string[] };
const S = {
  root: null as HTMLElement | null, tabs: [] as Tab[], cur: -1, userSignals: [] as string[], circuit: { items: [], nets: [], directives: [] } as Circuit,
  netlist: "", schCommand: "", spice: null as SpiceSession | null, running: false, stopping: false, sidePanel: true, console: true, darkPlots: false, compat: "User configuration",
  simItems: [] as SimItemInfo[], tuners: [] as Tuner[], wbName: "", dirty: false, filter: "", probing: null as null | "probe" | "tune", colorN: 0, simulated: false,
};
// served by src/pcm.rs runtime() (static/dist/pyodide in the build, /usr/local/share/kicad-collab/pyodide in the image),
// which lets browsers keep it a day: the query names the engine's build and the module's revision, so a deploy that
// changes either is not answered from yesterday's cache
const NGSPICE_URL = `/static/pyodide/ngspice.mjs?v=${ngspiceBuild.sha256.slice(0, 12)}-${NGSPICE_MODULE_REVISION}`;
const SIM_OPTS = OPT_SAVE_V | OPT_SAVE_I | OPT_SAVE_P | OPT_SAVE_EVENTS;
const curTab = (): Tab | null => S.tabs[S.cur] || null;
const tabType = (t: Tab | null): SimType => (t ? commandToSimType(t.command) : "TRAN");

// ---------------------------------------------------------------- the project's simulator settings
/** NGSPICE_SETTINGS (spice_settings.cpp): the .kicad_pro's schematic.ngspice — model_mode (NGSPICE_COMPATIBILITY_MODE,
 *  LT_PSPICE by default), workbook_filename (relative to the project), fix_include_paths. */
interface NgSettings { model_mode: number; workbook_filename: string; fix_include_paths: boolean }
function ngSettings(): NgSettings {
  const d: NgSettings = { model_mode: 4, workbook_filename: "", fix_include_paths: true };
  try {
    const j = JSON.parse(String(E.proSettings || "{}")) as { schematic?: { ngspice?: Partial<NgSettings> } };
    const n = (j.schematic && j.schematic.ngspice) || {};
    if (typeof n.model_mode === "number" && n.model_mode >= 0 && n.model_mode <= 5) d.model_mode = n.model_mode;
    if (typeof n.workbook_filename === "string") d.workbook_filename = n.workbook_filename;
    if (typeof n.fix_include_paths === "boolean") d.fix_include_paths = n.fix_include_paths;
  } catch { /* no project file: the defaults */ }
  return d;
}
/** The changed simulator settings into the .kicad_pro (the project is saved with them, as KiCad's is). */
async function saveNgSettings(edits: Partial<NgSettings>): Promise<void> {
  if (!canWriteProject()) return;
  try {
    const text = await loadProjectFile(); if (!text) return;
    const res = editProject(text, Object.entries(edits).map(([k, v]) => ({ path: ["schematic", "ngspice", k], value: v as never })));
    if (res.changed.length && await saveProjectFile(res.text, res.changed)) adoptProjectFile(res.text);
  } catch (e) { log(`Warning: the simulator settings were not saved to the project file (${e instanceof Error ? e.message : String(e)}).\n`); }
}
/** NGSPICE::GetSettingCommands: the compatibility mode as ngspice's ngbehavior. */
const COMPAT_COMMANDS: string[][] = [[], ["unset ngbehavior"], ["set ngbehavior=psa"], ["set ngbehavior=lta"], ["set ngbehavior=ltpsa"], ["set ngbehavior=hsa"]];
const compatIndex = (): number => Math.max(0, COMPAT_MODES.indexOf(S.compat));

const CSS = `
#simframe[hidden],#simframe [hidden]{display:none !important}
#simframe .sim-body{flex:1;display:flex;min-height:0}
#simframe .sim-left{flex:1;display:flex;flex-direction:column;min-width:0}
#simframe .sim-plotarea{flex:1;position:relative;min-height:80px;background:var(--bg)}
#simframe .sim-plot{position:absolute;inset:0}
#simframe .sim-plot canvas{position:absolute;inset:0;width:100%;height:100%;outline:none}
#simframe .sim-op{position:absolute;inset:0;overflow:auto;padding:8px 12px;font-family:var(--mono,monospace);white-space:pre}
#simframe .sim-split-h{flex:none;height:5px;cursor:row-resize;background:var(--panel);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
#simframe .sim-split-v{flex:none;width:5px;cursor:col-resize;background:var(--panel);border-left:1px solid var(--line);border-right:1px solid var(--line)}
#simframe .sim-console{flex:none;height:140px;resize:none;border:0;padding:4px 8px;background:var(--bg);color:var(--ink);font:12px/1.35 var(--mono,monospace);outline:none}
#simframe .sim-back{width:auto;gap:4px;padding:0 8px 0 4px;display:inline-flex;align-items:center;font:12px var(--ui,inherit);color:var(--ink)}
#simframe .sim-side{flex:none;width:400px;display:flex;flex-direction:column;min-height:0;background:var(--panel)}
#simframe .sim-sec{display:flex;flex-direction:column;min-height:0;border-bottom:1px solid var(--line)}
#simframe .sim-sec.grow{flex:1}
#simframe .sim-filter{margin:6px;height:24px;padding:2px 6px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:var(--r-1,3px);font:inherit}
#simframe .sim-gridwrap{overflow:auto;min-height:60px}
#simframe table.sim-grid{width:100%;border-collapse:collapse;font:inherit}
#simframe .sim-grid th{position:sticky;top:0;background:var(--bench);font-weight:400;text-align:left;padding:2px 4px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);white-space:nowrap}
#simframe .sim-grid td{padding:1px 4px;border-bottom:1px solid var(--line-soft,var(--line));border-right:1px solid var(--line-soft,var(--line));white-space:nowrap;height:21px}
#simframe .sim-grid td.c{text-align:center}
#simframe .sim-grid tr.sel td{background:var(--sel-soft)}
#simframe .sim-grid td input[type=text]{width:100%;border:0;background:transparent;color:var(--ink);font:inherit;padding:0}
#simframe .sim-swatch{display:inline-block;width:28px;height:12px;border:1px solid var(--line-2,var(--line));vertical-align:middle;cursor:pointer}
#simframe .sim-tuners{flex:none;display:flex;gap:4px;overflow-x:auto;padding:4px;min-height:0}
#simframe .sim-tuner{flex:none;display:flex;flex-direction:column;align-items:center;gap:3px;width:96px;padding:4px;border:1px solid var(--line);border-radius:var(--r-1,3px);background:var(--bg)}
#simframe .sim-tuner .nm{display:flex;align-items:center;gap:2px;width:100%;font-weight:600}
#simframe .sim-tuner .nm span{flex:1;overflow:hidden;text-overflow:ellipsis}
#simframe .sim-tuner input[type=text]{width:100%;height:22px;padding:1px 4px;text-align:center;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:var(--r-1,3px);font:inherit}
#simframe .sim-tuner input[type=range]{writing-mode:vertical-lr;direction:rtl;height:120px;width:22px;accent-color:var(--accent)}
#simframe .sim-tuner .es{display:flex;gap:1px}
#simframe .sim-tuner .es .kbmp{width:22px;height:20px}
#simframe .sim-tuner k-select{width:100%;height:22px}
#simframe .sim-tuner button.txt{width:100%;height:22px}
#simframe .sim-status{flex:none;height:22px;padding:0 8px;border-top:1px solid var(--line);background:var(--panel);color:var(--ink-2);font:12px/21px var(--font);white-space:nowrap;overflow:hidden}
#simframe .sim-hint{padding:6px 10px;color:var(--ink-3)}
.sim-probe-banner{position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:60;padding:6px 12px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:4px;box-shadow:var(--shadow);font:var(--fs-sm,12px)/1.35 var(--font)}
.sim-unit{color:var(--ink-2);white-space:nowrap}
.sim-radios{display:flex;gap:14px;flex-wrap:wrap;margin:2px 0 6px}
.sim-pages .kv{margin:6px 0}
.sim-dc{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.sim-dchead{font-weight:600;margin-bottom:4px}
.sim-checklist{border:1px solid var(--line);height:140px;overflow:auto;padding:4px;margin:4px 0;display:flex;flex-direction:column}
.sim-opts{margin-top:12px;padding-top:8px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:2px}
.sim-help td{padding:1px 10px 1px 0;font-family:var(--mono,monospace)}
.sim-helpbody code{font-family:var(--mono,monospace)}
`;
let styled = false;
function ensureCss(): void { ensureStyle(); if (styled) return; styled = true; const st = document.createElement("style"); st.id = "sim-css"; st.textContent = CSS; document.head.appendChild(st); }

// ---------------------------------------------------------------- open / close
export function isSimulatorOpen(): boolean { return !!S.root; }
/** SCH_EDITOR_CONTROL::Simulate (showSimulator): the frame, with the last workbook of this project. */
export async function openSimulator(): Promise<void> {
  if (S.root) { S.root.hidden = false; return; }
  if (!E.kdoc || !isSch()) { toast("Open a schematic first"); return; }
  ensureCss();
  const root = h("div", { class: "se-root", id: "simframe" }); S.root = root;
  document.body.append(root);
  layout();
  // SIMULATOR_FRAME: the project's ngspice settings (a project without a workbook simulates in LTspice/PSpice mode)
  const cfg = ngSettings();
  S.compat = COMPAT_MODES[cfg.workbook_filename ? cfg.model_mode : 4] || COMPAT_MODES[4];
  await loadCircuit();
  let wb: Workbook | null = null;
  // SIMULATOR_FRAME_UI::InitWorkbook: the workbook the project names (workbook_filename, relative to the project)
  if (cfg.workbook_filename) {
    const docs = wbkDocs(), want = cfg.workbook_filename.replace(/\\/g, "/").replace(/^\.\//, "");
    const d = docs.find((x) => x.path === want || x.path.endsWith("/" + want)) || null;
    if (d) { try { const t = await api(`/api/docs/${d.docId}/content`); wb = JSON.parse(typeof t === "string" ? t : JSON.stringify(t)) as Workbook; S.wbName = d.path; } catch { wb = null; } }
    else log(`Workbook file '${cfg.workbook_filename}' not found. Loading simulation settings from schematic.\n`);
  }
  // no workbook named (or it could not be read): the settings come from the schematic, its simulation directive as
  // the first tab
  if (wb && wb.tabs && wb.tabs.length) applyWorkbook(wb);
  else if (S.schCommand) { newTab(S.schCommand, DEFAULT_OPTIONS).lastSch = S.schCommand; }
  S.dirty = false;
  renderAll();
  window.addEventListener("keydown", onKey, true);
}
/** SIMULATOR_FRAME::canCloseWindow: a modified workbook asks to be saved first. */
export async function closeSimulator(): Promise<void> {
  if (!S.root) return;
  if (S.dirty && S.tabs.length) {
    const c = await unsavedChangesBox("Save changes to workbook?");
    if (c === "cancel") return;
    if (c === "save") { await saveWorkbook(false); if (S.dirty) return; }
  }
  if (!S.root) return;
  stopProbe();
  S.root.remove(); S.root = null; S.tabs = []; S.cur = -1; S.tuners = []; S.simulated = false;
  window.removeEventListener("keydown", onKey, true);
  closeMenus();
}
function onKey(ev: KeyboardEvent): void {
  if (!S.root || S.root.hidden || document.querySelector(".kd-overlay")) return;
  const t = ev.target as HTMLElement | null; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "K-SELECT")) return;
  const mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase(); let run: (() => void) | null = null;
  if (!mod && !ev.altKey && !ev.shiftKey && k === "r") run = () => void runSimulation();
  else if (!mod && ev.shiftKey && k === "p") run = () => startProbe("probe");
  else if (!mod && ev.shiftKey && k === "t") run = () => startProbe("tune");
  else if (mod && !ev.shiftKey && k === "n") run = () => void newAnalysisTab();
  else if (mod && !ev.shiftKey && k === "o") run = () => openWorkbook();
  else if (mod && !ev.shiftKey && k === "s") run = () => void saveWorkbook(false);
  else if (mod && ev.shiftKey && k === "s") run = () => void saveWorkbook(true);
  else if (mod && k === "w") run = () => void closeSimulator();
  if (!run) return;
  ev.preventDefault(); ev.stopPropagation(); run();
}

// ---------------------------------------------------------------- the circuit
async function loadCircuit(): Promise<void> {
  const msgs: string[] = [];
  let simItems: SimItemInfo[] = [];
  const withCmd = await projectSpiceNetlist(SIM_OPTS | 0x0400, (m) => msgs.push(m), false, (list) => { simItems = list; });
  const text = withCmd || "";
  S.circuit = readCircuit(text);
  S.simItems = simItems;
  // each element's currents as its generator names them (SPICE_GENERATOR::CurrentNames)
  const byName = new Map(simItems.map((x) => [x.name.toLowerCase(), x]));
  for (const it of S.circuit.items) { const x = byName.get(it.name.toLowerCase()); if (x) it.currents = x.currents; }
  setSimItems(simItems);
  // SPICE_CIRCUIT_MODEL::GetDirectives: the schematic's own directives, not the .save / .probe lines the options add
  S.circuit.directives = S.circuit.directives.filter((d) => !/^\.save\s+all$/i.test(d) && !/^\.probe\s+all[ip]?$/i.test(d) && !/^\.probe\s+p\([^()\s]+\)$/i.test(d));
  const sim = S.circuit.directives.filter((d) => /^\.(ac|dc|tran|op|noise|pz|sp|disto|sens|tf|fft)\b/i.test(d));
  S.schCommand = sim[0] || "";
  S.netlist = (await projectSpiceNetlist(SIM_OPTS, () => undefined)) || text;
  for (const m of msgs) log(m + "\n");
}
const vSources = (): string[] => S.circuit.items.filter((i) => /^v/i.test(i.name)).map((i) => i.name);
const iSources = (): string[] => S.circuit.items.filter((i) => /^i/i.test(i.name)).map((i) => i.name);
const resistors = (): string[] => S.circuit.items.filter((i) => /^r/i.test(i.name)).map((i) => i.name);

// ---------------------------------------------------------------- tabs
function defaultSetup(): PlotSetup { return { axes: [null, null, null], fixed: [null, null, null], grid: true, legend: false, dotted: true, margins: { left: 70, top: 30, right: 70, bottom: 45 } }; }
function newTab(command: string, options: number): Tab {
  const t: Tab = { command, options, traces: [], meas: [], plot: null, data: null, opText: "", lastSch: "", setup: defaultSetup(), smithZoom: 1, smithPan: { x: 0, y: 0 }, stashTraces: [], stashCursors: [], cursorFmt: [{ precision: 3, range: "~s" }, { precision: 3, range: "~V" }] };
  S.tabs.push(t); S.cur = S.tabs.length - 1; S.dirty = true;
  return t;
}
async function newAnalysisTab(): Promise<void> {
  const r = await openSimCommand({ command: "*", options: DEFAULT_OPTIONS, nets: S.circuit.nets, vSources: vSources(), iSources: iSources(), resistors: resistors(), signals: allSignalsFor("TRAN", DEFAULT_OPTIONS), schDirectives: S.circuit.directives.join("\n"), compat: S.compat, plot: null });
  if (!r) return;
  setCompat(r.compat); newTab(r.command, r.options); renderAll();
}
async function editAnalysisTab(): Promise<void> {
  const t = curTab(); if (!t) return;
  syncSetup(t);
  const r = await openSimCommand({ command: t.command, options: t.options, nets: S.circuit.nets, vSources: vSources(), iSources: iSources(), resistors: resistors(), signals: allSignalsFor("TRAN", t.options), schDirectives: S.circuit.directives.join("\n"), compat: S.compat, plot: isPlottable(tabType(t)) ? t.setup : null });
  if (!r) return;
  setCompat(r.compat);
  if (commandToSimType(r.command) !== tabType(t)) { t.traces = []; t.data = null; }
  t.command = r.command; t.options = r.options; if (r.plot) t.setup = r.plot; S.dirty = true;
  renderAll();
}
/** DIALOG_SIM_COMMAND::TransferDataFromWindow: a new compatibility mode is the project's (NGSPICE_SETTINGS). */
function setCompat(mode: string): void {
  if (mode === S.compat) return;
  S.compat = mode;
  const i = COMPAT_MODES.indexOf(mode); if (i >= 0) void saveNgSettings({ model_mode: i });
}
function closeTab(i: number): void {
  S.tabs.splice(i, 1); if (S.cur >= S.tabs.length) S.cur = S.tabs.length - 1; S.dirty = true; renderAll();
  // onPlotClosed: the schematic's operating point goes with the last OP tab in front
  if (tabType(curTab()) !== "OP" || !curTab()) clearOperatingPoints();
}
function syncSetup(t: Tab): void {
  if (!t.plot) return;
  t.setup.axes = t.plot.opts.y.map((a) => (a ? [a.name, a.units] as [string, string] : null));
}

// ---------------------------------------------------------------- signals
function allSignalsFor(type: SimType, options: number, smith = false): string[] { return signalsFor(type, S.circuit, options, S.userSignals, smith); }
const isSmith = (t: Tab | null): boolean => !!t && tabType(t) === "SP" && !!t.setup.smith;
function axisOf(signal: string, type: SimType): 0 | 1 | 2 {
  const { part } = splitSignal(signal);
  if (part === "phase") return 1;
  if (part) return 0;
  const k = userKind(signal) || signalKind(signal, type);
  if (type === "TRAN" || type === "DC") return k === "I" ? 1 : k === "P" ? 2 : 0;
  return 0;
}
function userKind(signal: string): "V" | "I" | "P" | null {
  if (!S.userSignals.includes(signal)) return null;
  const m = /\b([VIP])\(/i.exec(signal); return m ? (m[1].toUpperCase() as "V" | "I" | "P") : "V";
}
function axesFor(t: Tab): ({ name: string; units: string } | null)[] {
  const type = tabType(t) === "Custom" ? "TRAN" : tabType(t);
  const kinds = new Set(t.traces.map((tr) => axisOf(tr.signal, type)));
  switch (type) {
    case "AC": return [{ name: "Gain", units: "dB" }, { name: "Phase", units: "°" }, null];
    case "SP": return [{ name: "Amplitude", units: "" }, { name: "Phase", units: "°" }, null];
    case "NOISE": return [{ name: "Noise (V/√Hz)", units: "" }, { name: "Noise (A/√Hz)", units: "" }, null];
    case "FFT": return [{ name: "Intensity", units: "dB" }, null, null];
    case "DC": return [{ name: "Voltage (measured)", units: "V" }, { name: "Current", units: "A" }, kinds.has(2) ? { name: "Power", units: "W" } : null];
    default: return [{ name: "Voltage", units: "V" }, { name: "Current", units: "A" }, kinds.has(2) ? { name: "Power", units: "W" } : null];
  }
}
function xAxisFor(t: Tab): { name: string; units: string; log: boolean } {
  const type = tabType(t) === "Custom" ? "TRAN" : tabType(t);
  if (type === "DC") {
    const src = (parseCommand(t.command).dc?.src1.type) || "V";
    const names: Record<string, [string, string]> = { V: ["Voltage (swept)", "V"], I: ["Current (swept)", "A"], R: ["Resistance (swept)", "Ω"], TEMP: ["Temperature (swept)", "°C"] };
    return { name: names[src][0], units: names[src][1], log: false };
  }
  const x = xAxisOf(type); return { name: x.label, units: x.units, log: x.log || type === "FFT" };
}
/** The data of one signal row from the tab's results. */
function traceData(t: Tab, signal: string): { xs: Float64Array; ys: Float64Array } | null {
  const d = t.data; if (!d || !d.vectors.length) return null;
  const { base, part } = splitSignal(signal);
  const ui = S.userSignals.indexOf(base);
  const vec = ui >= 0 ? d.vectors.find((v) => v.name.toLowerCase() === userVectorName(ui)) || null : findVector(d, base);
  if (!vec) return null;
  const xs = d.vectors[0].re, type = tabType(t);
  const ys = part ? acPart(vec, part) : type === "FFT" ? acPart(vec, "gain") : vec.im ? acPart(vec, "") : vec.re;
  return { xs, ys };
}
/** A signal's complex values (an S-parameter is the reflection coefficient a Smith chart plots). */
function gammaData(t: Tab, signal: string): { re: Float64Array; im: Float64Array } | null {
  const d = t.data; if (!d || !d.vectors.length) return null;
  const vec = findVector(d, splitSignal(signal).base);
  return vec && vec.im ? { re: vec.re, im: vec.im } : null;
}
function nextColor(t: Tab): string {
  const used = new Set(t.traces.map((x) => x.color.toUpperCase()));
  for (const c of TRACE_COLORS) if (!used.has(c.toUpperCase())) return c;
  return TRACE_COLORS[(S.colorN++) % TRACE_COLORS.length];
}
/** SIMULATOR_FRAME_UI::AddTrace / toggling the Plot cell. */
export function addTrace(signal: string): void {
  let t = curTab();
  if (!t) { if (!S.schCommand) { log("Error: no current simulation.\n"); return; } t = newTab(S.schCommand, DEFAULT_OPTIONS); }
  if (!isPlottable(tabType(t)) && tabType(t) !== "Custom") { log("Error: simulation type doesn't support plotting.\n"); return; }
  if (t.traces.some((x) => x.signal === signal)) return;
  t.traces.push({ signal, color: nextColor(t), cursor1: false, cursor2: false }); S.dirty = true;
  renderAll();
}
function removeTrace(signal: string): void { const t = curTab(); if (!t) return; t.traces = t.traces.filter((x) => x.signal !== signal); S.dirty = true; renderAll(); }

/** SIMULATOR_FRAME_UI::ToggleSmithChart: the shown signals rebuilt in the other coordinate system.  Entering, the
 *  transmission parameters (S_i_j, not impedances) and every cursor are set aside on the tab; leaving, they come back,
 *  each cursor on the trace and part (amplitude or phase) it came from, at its frequency. */
function toggleSmithChart(t: Tab): void {
  if (tabType(t) !== "SP") return;
  const smith = !t.setup.smith;
  const isReflection = (name: string): boolean => { const p = parseSParamPorts(name); return p ? p.response === p.drive : true; };
  const partBits = (part: string): number => (part === "phase" ? 0x04 : part === "amplitude" ? 0x20 : 0x40);
  const shown: { vector: string; name: string; base_type: number; color: string }[] = [];
  const saved: { id: number; vector: string; base_type: number; sub_type: number; x: number }[] = [];
  const p = t.plot;
  for (const tr of t.traces) {
    const { base, part } = splitSignal(tr.signal), base_type = traceType(t, tr.signal) & ~(0x04 | 0x08 | 0x20 | 0x40);
    if (!shown.some((x) => x.vector === base)) shown.push({ vector: base, name: base, base_type, color: tr.color });
    for (const id of [1, 2] as const) {
      if (!(id === 1 ? tr.cursor1 : tr.cursor2)) continue;
      const x = p ? p.cursorX[id - 1] : null;
      saved.push({ id, vector: base, base_type, sub_type: partBits(part), x: x === null ? NaN : x });
    }
  }
  if (smith) {
    // set aside what the Smith chart cannot show, so leaving it restores that
    t.stashTraces = shown.filter((x) => !isReflection(x.vector)).map((x) => ({ vector: x.vector, name: x.name, base_type: x.base_type }));
    t.stashCursors = saved.map((x) => ({ id: x.id, vector: x.vector, base_type: x.base_type, sub_type: x.sub_type, frequency: x.x }));
  } else {
    for (const st of t.stashTraces) if (!shown.some((x) => x.vector === st.vector)) shown.push({ ...st, color: "" });
  }
  const colors = new Map(t.traces.map((tr) => [splitSignal(tr.signal).base, tr.color] as [string, string]));
  t.traces = []; t.setup.smith = smith;
  const cursorAt: [number, number] = [NaN, NaN];
  const add = (signal: string, vector: string): void => { if (!t.traces.some((x) => x.signal === signal)) t.traces.push({ signal, color: colors.get(vector) || nextColor(t), cursor1: false, cursor2: false }); };
  for (const sv of shown) {
    if (smith) { if (isReflection(sv.vector)) add(sv.vector, sv.vector); }
    else { add(sv.vector + " (amplitude)", sv.vector); add(sv.vector + " (phase)", sv.vector); }
  }
  const setCursor = (signal: string, id: 1 | 2, freq: number): boolean => {
    const tr = t.traces.find((x) => x.signal === signal); if (!tr) return false;
    for (const o of t.traces) { if (id === 1) o.cursor1 = o === tr; else o.cursor2 = o === tr; }
    cursorAt[id - 1] = freq; return true;
  };
  if (smith) {
    // amplitude and phase cursors with the same id collapse onto one: the first is kept, the stash has both
    const done = new Set<number>();
    for (const c of saved) { if (done.has(c.id) || (c.id !== 1 && c.id !== 2)) continue; if (setCursor(c.vector, c.id as 1 | 2, c.x)) done.add(c.id); }
  } else {
    const restored = new Set<number>();
    const restore = (id: number, vector: string, sub: number, freq: number): boolean => (id === 1 || id === 2) && setCursor(vector + (sub === 0x04 ? " (phase)" : " (amplitude)"), id, freq);
    // live Smith cursors go back to the part they came from, at their frequency now
    for (const c of saved) {
      const st = t.stashCursors.find((x) => x.id === c.id && x.vector === c.vector);
      if (restore(c.id, c.vector, st ? st.sub_type : 0x20, c.x)) restored.add(c.id);
    }
    // cursors whose trace could not be on the Smith chart come back from the stash alone
    for (const st of t.stashCursors) { if (isReflection(st.vector) || restored.has(st.id)) continue; restore(st.id, st.vector, st.sub_type, st.frequency); }
    t.stashTraces = []; t.stashCursors = [];
  }
  if (p) for (const i of [0, 1] as const) p.cursorX[i] = Number.isFinite(cursorAt[i]) ? cursorAt[i] : null;
  S.dirty = true; renderAll();
}

// ---------------------------------------------------------------- running ngspice
function log(s: string): void { const c = S.root && S.root.querySelector<HTMLTextAreaElement>(".sim-console"); if (c) { c.value += s; c.scrollTop = c.scrollHeight; } }
async function session(): Promise<SpiceSession> {
  if (S.spice && S.spice.dead) { S.spice = null; S.simulated = false; }
  if (!S.spice) {
    log("Loading ngspice...\n"); setStatus("Loading ngspice...");
    S.spice = await openSpice(NGSPICE_URL, (p) => setStatus(progressText(p))); log(`Note: using ngspice ${S.spice.version}\n`); setStatus("");
    // NGSPICE::init_dll's workarounds, sent whatever the init script says
    await S.spice.exec(["set noaskquit", "set nomoremode"]);
  }
  return S.spice;
}
/** The .include files the netlist names, written into ngspice's file system from the project's documents, and the
 *  data files their models read (an XSPICE d_state's state_file, a filesource's file): ngspice opens those relative
 *  to the folder it runs in, the project's folder on the desktop and the file system's root here. */
async function stageIncludes(sp: SpiceSession, netlist: string): Promise<void> {
  const docs = projectDocs() as { docId: string; path: string }[];
  const texts = [netlist];
  const fetchDoc = async (p: string): Promise<string | null> => {
    const base = p.split("/").pop() || p;
    const doc = docs.find((d) => d.path === p || d.path.endsWith("/" + base) || d.path === base);
    if (!doc) return null;
    const txt = await api(`/api/docs/${doc.docId}/content`);
    return typeof txt === "string" ? txt : JSON.stringify(txt);
  };
  for (const m of netlist.matchAll(/^\.include\s+"([^"]+)"/gim)) {
    const p = m[1];
    const builtin = builtinLibrary(p);
    if (builtin !== null) { sp.write(p.startsWith("/") ? p : "/" + p, forWasmNgspice(builtin)); continue; }
    try {
      const txt = await fetchDoc(p);
      if (txt === null) { log(`Warning: library '${p}' is not part of the project.\n`); continue; }
      sp.write(p.startsWith("/") ? p : "/" + p, forWasmNgspice(txt)); texts.push(txt);
    } catch { log(`Warning: could not read '${p}'.\n`); }
  }
  const data = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/\b(?:\w+_)?file\s*=\s*"([^"]+)"/gi)) if (!/^(\/|[a-z]:)/i.test(m[1])) data.add(m[1]);
  for (const p of data) {
    try { const txt = await fetchDoc(p); if (txt !== null) sp.write("/" + p, txt); else log(`Warning: file '${p}' is not part of the project.\n`); } catch { log(`Warning: could not read '${p}'.\n`); }
  }
}
function circuitFor(t: Tab): string {
  const type = tabType(t);
  let net = S.netlist.replace(/\r/g, "");
  if (!(t.options & OPT_SAVE_V)) net = net.replace(/^\.save all\n/m, "");
  if (!(t.options & OPT_SAVE_I)) net = net.replace(/^\.probe alli\n/m, "");
  if (!(t.options & OPT_SAVE_P)) net = net.replace(/^\.probe p\(.*\)\n/gm, "");
  // FFT: the transform of the TRAN tab's results (SIMULATOR_FRAME::StartSimulation sets ngspice on that tab's plot)
  const tran = type === "FFT" ? S.tabs.find((x) => tabType(x) === "TRAN") : null;
  const cmd = type === "FFT" ? (tran ? tran.command : ".tran 1u 1m") : t.command;
  return net.replace(/^\.end\s*$/m, cmd + "\n.end");
}
let tuneTimer = 0;
/** SIMULATOR_FRAME::StartSimulation: the netlist with the tab's command, the tuners' values, then the results. */
export async function runSimulation(reuse = false): Promise<void> {
  const t = curTab();
  if (!t) { await newAnalysisTab(); if (!curTab()) return; return runSimulation(); }
  if (S.running) return;
  if (tabType(t) === "FFT" && !S.tabs.some((x) => tabType(x) === "TRAN" && x.data)) {
    void messageBox("You must run a TRAN simulation first; its results will be used for the fast Fourier transform."); return;
  }
  S.running = true; renderToolbar();
  let merged: RawPlot | null = null, listing = false, stopped = false; const multiTraces: PlotTrace[] = [];
  try {
    // StartSimulation: the netlist of the schematic as it is now (a tuner's rerun keeps the loaded circuit)
    if (!reuse || !S.netlist) await loadCircuit();
    // the first tab follows the schematic's simulation directive, asking once it had taken an earlier one
    if (!reuse && S.tabs.indexOf(t) === 0 && S.schCommand && S.schCommand !== t.lastSch) {
      if (!t.lastSch || await confirmBox("Confirmation", "Schematic sheet simulation command directive has changed.  Do you wish to update the Simulation Command?")) {
        if (commandToSimType(S.schCommand) !== tabType(t)) { t.traces = []; t.data = null; }
        t.command = S.schCommand; t.lastSch = S.schCommand; S.dirty = true; renderTabs();
      }
    }
    const sp = await session();
    // Stop pressed while ngspice was starting, or before a run's commands were sent: that run is not started
    let saidStopped = false;
    const sayStopped = (): void => { if (!saidStopped) log("Simulation stopped.\n"); saidStopped = true; };
    const stoppedHere = (k: number): boolean => { if (!S.stopping) return false; sayStopped(); stopped = k === 0; return true; };
    const multi = S.tuners.find((x) => x.multi);
    const steps = multi ? Math.max(2, multi.steps) : 1;
    for (let k = 0; k < steps; k++) {
      if (stoppedHere(k)) break;
      if (multi) multi.value = multi.min + ((multi.max - multi.min) * k) / (steps - 1);
      const cir = circuitFor(t);
      await stageIncludes(sp, cir);
      sp.write("/sim.cir", forWasmNgspice(cir.replace(/^(\s*\.include\s+")(?!\/)/gim, "$1/"), (w) => log(w + "\n")));
      if (stoppedHere(k)) break;
      await sp.exec(["destroy all", "remcirc"]).catch(() => undefined);
      if (stoppedHere(k)) break;
      const lines = [...COMPAT_COMMANDS[compatIndex()], "source /sim.cir", ...tunerCommands(), "run"];
      const r = await sp.exec(lines);
      if (r.halted || S.stopping) sayStopped();
      // ended with its worker: nothing of this run can be read
      if (sp.dead && (r.halted || S.stopping)) { stopped = true; break; }
      // SIMULATOR_FRAME::onSimFinished: every finished run clears the schematic's operating point; only an OP run's
      // results (OnSimRefresh) set it again
      clearOperatingPoints();
      const said = noPrompts(r.out); if (said.trim()) log(said.endsWith("\n") ? said : said + "\n");
      for (const e of r.err) if (e.trim() && !/^(Note|Warning: can't find)/.test(e)) log(e + "\n");
      const type = tabType(t);
      if (type === "FFT") { const f = await sp.exec(t.command.split(/\n/).map((l) => l.trim()).filter(Boolean)); if (f.out.trim()) log(f.out); }
      const lets = S.userSignals.map((s, i) => userSignalLet(i, s));
      if (lets.length) { const u = await sp.exec(lets); for (const e of u.err) if (e.trim()) log(e + "\n"); }
      if (type === "OP") { await operatingPointResults(t, sp); t.data = null; continue; }
      // the other analyses without a plot (PZ, TF, SENS, DISTO): ngspice's own listing, as KiCad prints PZ's
      if (!isPlottable(type) && type !== "Custom" && type !== "FFT") {
        const p = await sp.exec(["print all"]); const said2 = noPrompts(p.out);
        log("\n\nSimulation results:\n\n" + said2 + (said2.endsWith("\n") ? "" : "\n"));
        t.opText = said2.trim() ? said2 : "No results."; t.data = null; listing = true; continue;
      }
      sp.remove("/out.raw");
      await sp.exec(["set filetype=binary", "write /out.raw"]);
      const raw = await sp.read("/out.raw");
      const plots = raw ? readRaw(raw) : [];
      const plot = plots[plots.length - 1] || null;
      if (multi && plot) {
        const save = t.data; t.data = plot;
        for (const tr of t.traces) { const dd = traceData(t, tr.signal); if (dd) multiTraces.push({ name: `${tr.signal} (${multi.name} = ${toSpiceString(multi.value)})`, xs: dd.xs, ys: dd.ys, color: TRACE_COLORS[(k + t.traces.indexOf(tr) * steps) % TRACE_COLORS.length], axis: axisOf(tr.signal, type) }); }
        t.data = save; merged = plot;
      } else merged = plot;
    }
    if (stopped) { S.simulated = false; return; }
    t.data = merged; S.simulated = true;
    await updateMeasurements(t, sp);
    (t as Tab & { multi?: PlotTrace[] }).multi = multi ? multiTraces : undefined;
    // OP and the listing analyses (PZ, TF, SENS, DISTO) have no plot to produce
    if (!t.data && tabType(t) !== "OP" && !listing) log("Error: the simulation produced no results.\n");
  } catch (e) {
    log("Error: " + (e instanceof Error ? e.message : String(e)) + "\n");
  } finally {
    S.running = false; S.stopping = false; setStatus(""); renderAll();
  }
}
/** SIMULATOR_FRAME_UI::OnSimRefresh (ST_OP): "Simulation results:" in the console, one line per vector (the signal
 *  padded to 25 characters, the value with its unit), and each value on the schematic (SetOperatingPoint). */
async function operatingPointResults(t: Tab, sp: SpiceSession): Promise<void> {
  sp.remove("/out.raw");
  await sp.exec(["set filetype=binary", "write /out.raw"]);
  const raw = await sp.read("/out.raw");
  const plot = raw ? readRaw(raw).pop() || null : null;
  const lines: string[] = [], vectors: { name: string; value: number }[] = [];
  for (const v of plot ? plot.vectors : []) {
    if (!v.re.length) continue;
    const n = v.name; let signal: string, unit: string;
    let m: RegExpExecArray | null;
    if ((m = /^v\((.*)\)$/i.exec(n))) { signal = `V(${m[1]})`; unit = "V"; }
    else if ((m = /^i\((.*)\)$/i.exec(n))) { signal = `I(${m[1]})`; unit = "A"; }
    else if ((m = /^(.*)#branch$/i.exec(n))) { signal = `I(${m[1]})`; unit = "A"; }
    else if ((m = /^(.*):power$/i.exec(n))) { signal = `P(${m[1]})`; unit = "W"; }
    else if ((m = /^@(\w*[.\w+]*)\[(i\w*)\]$/i.exec(n))) { signal = `I${m[2].slice(1)}(${m[1].toUpperCase()})`; unit = "A"; }
    else if (/^@/.test(n)) { signal = n; unit = "?"; }
    else { signal = `V(${n})`; unit = "V"; }
    if (lines.some((l) => l.startsWith(signal + ":"))) continue;
    // ( signal + ":" ).Pad( padding ): padding = 25 - len (1 from 25 characters on) spaces after the colon
    const padding = signal.length < 25 ? 25 - signal.length : 1;
    lines.push(signal + ":" + " ".repeat(padding) + toSpiceString(v.re[0]) + unit);
    if (unit !== "?") vectors.push({ name: unit === "W" ? `${signal.slice(2, -1)}:power` : n, value: v.re[0] });
  }
  t.opText = lines.length ? lines.join("\n") + "\n" : "No operating point results.";
  log("\n\nSimulation results:\n\n" + (lines.length ? lines.join("\n") + "\n" : ""));
  setOperatingPoints(vectors);
}
/** ngspice's interactive prompts ("ngspice 12 -> ") are not part of what it says. */
function noPrompts(s: string): string { return s.replace(/^\s*ngspice \d+ -> ?$/gm, "").replace(/(?:ngspice \d+ -> )+/g, "").replace(/\n{3,}/g, "\n\n"); }
/** SIMULATOR_FRAME's Stop (NGSPICE::Stop, bg_halt): the analysis ends where it is and what it computed is shown.
 *  ngspice gives way to the page while it runs (plugins/spice.ts); one that does not within a moment is ended with
 *  its worker, and the next run starts a new one. */
function stopSimulation(): void {
  if (!S.running) return;
  // pressed again: the halt is sent again (a run that has not given way is still ended with its worker)
  S.stopping = true; setStatus("Stopping...");
  if (S.spice) S.spice.halt();
  renderToolbar();
}
/** The status line: ngspice's progress reports (libngspice's SendStat text, "tran: 45.3%"). */
function progressText(p: Progress): string { return p.text === "--ready--" ? "" : p.text; }
function setStatus(text: string): void { const el = S.root && S.root.querySelector<HTMLElement>(".sim-status"); if (el) el.textContent = text; }
async function updateMeasurements(t: Tab, sp: SpiceSession): Promise<void> {
  const type = tabType(t);
  for (let i = 0; i < t.meas.length; i++) {
    const m = t.meas[i]; if (!m.expr.trim()) { m.value = ""; continue; }
    const r = await sp.exec([measCommand(m.expr, type, i)]);
    const mm = new RegExp(`meas_result_${i}\\s*=\\s*([-+0-9.eE]+)`).exec(r.out);
    if (mm) { const u = measurementUnits(m.expr, type) || ""; m.format = updateUnits(m.format, u); m.value = formatValue(Number(mm[1]), m.format); }
    else m.value = "";
  }
}
function scheduleTune(): void { if (!S.simulated) return; clearTimeout(tuneTimer); tuneTimer = window.setTimeout(() => void runSimulation(true), 250); }

// ---------------------------------------------------------------- layout
let els: { menubar: HTMLElement; toolbar: HTMLElement; tabs: HTMLElement; area: HTMLElement; console: HTMLTextAreaElement; side: HTMLElement; signals: HTMLElement; cursors: HTMLElement; meas: HTMLElement; tuners: HTMLElement; split: HTMLElement; splitH: HTMLElement; filter: HTMLInputElement };
function layout(): void {
  const root = S.root!;
  const menubar = h("div", { class: "se-menubar" }), toolbar = h("div", { class: "se-tb" });
  const tabs = h("div", { class: "se-tabs", id: "sim-tabs" }), area = h("div", { class: "sim-plotarea" });
  const cons = h("textarea", { class: "sim-console", readonly: true, spellcheck: "false", id: "sim-console" }) as HTMLTextAreaElement;
  const splitH = h("div", { class: "sim-split-h" }), split = h("div", { class: "sim-split-v" });
  const filter = h("input", { class: "sim-filter", type: "search", placeholder: "Filter", id: "sim-filter" }) as HTMLInputElement;
  filter.addEventListener("input", () => { S.filter = filter.value; renderSignals(); });
  const signals = h("div", { class: "sim-gridwrap", id: "sim-signals" }), cursors = h("div", { class: "sim-gridwrap", id: "sim-cursors", style: "max-height:110px" }), meas = h("div", { class: "sim-gridwrap", id: "sim-meas", style: "max-height:150px" });
  const tuners = h("div", { class: "sim-tuners", id: "sim-tuners" });
  const side = h("div", { class: "sim-side" }, h("div", { class: "sim-sec grow" }, filter, signals), h("div", { class: "sim-sec" }, cursors), h("div", { class: "sim-sec" }, meas), tuners);
  root.append(menubar, toolbar, h("div", { class: "sim-body" }, h("div", { class: "sim-left" }, tabs, area, splitH, cons), split, side), h("div", { class: "sim-status", id: "sim-status" }));
  els = { menubar, toolbar, tabs, area, console: cons, side, signals, cursors, meas, tuners, split, splitH, filter };
  dragSplit(split, (dx) => { side.style.width = Math.max(240, Math.min(window.innerWidth - 300, side.offsetWidth - dx)) + "px"; });
  dragSplit(splitH, (_dx, dy) => { cons.style.height = Math.max(40, Math.min(window.innerHeight - 200, cons.offsetHeight - dy)) + "px"; });
  buildMenubar();
}
function dragSplit(el: HTMLElement, move: (dx: number, dy: number) => void): void {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault(); el.setPointerCapture(e.pointerId); let x = e.clientX, y = e.clientY;
    const mv = (ev: PointerEvent): void => { move(ev.clientX - x, ev.clientY - y); x = ev.clientX; y = ev.clientY; const t = curTab(); if (t && t.plot) t.plot.render(); };
    const up = (): void => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); };
    el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
  });
}

// ---------------------------------------------------------------- menus and toolbar
const A = (id: string, run: () => void, enabled?: () => boolean, check?: () => boolean): MenuEntry => { const m = meta(id); return { id, label: m.label, icon: m.icon, key: m.key, tip: m.tip, run, enabled: enabled || (() => true), check }; };
const SEP: MenuEntry = { sep: true };
const hasTab = (): boolean => !!curTab();
const hasPlot = (): boolean => { const t = curTab(); return !!t && !!t.plot; };
function zoomCmd(id: string): () => void {
  return () => { const p = curTab()?.plot; if (!p) return;
    if (id === "zoomInCenter") p.zoom(1.5, "both"); else if (id === "zoomOutCenter") p.zoom(1 / 1.5, "both");
    else if (id === "zoomInHorizontally") p.zoom(1.5, "h"); else if (id === "zoomOutHorizontally") p.zoom(1 / 1.5, "h");
    else if (id === "zoomInVertically") p.zoom(1.5, "v"); else if (id === "zoomOutVertically") p.zoom(1 / 1.5, "v");
    else if (id === "zoomFitScreen") p.fit(); else if (id === "zoomUndo") p.undoZoom(); else if (id === "zoomRedo") p.redoZoom();
    renderToolbar(); };
}
function menus(): [string, MenuEntry[]][] {
  const t = (): Tab | null => curTab();
  return [
    ["File", [A("newAnalysisTab", () => void newAnalysisTab()), SEP, A("openWorkbook", openWorkbook), A("saveWorkbook", () => void saveWorkbook(false)), A("saveWorkbookAs", () => void saveWorkbook(true)), SEP,
      A("exportPlotAsPNG", exportPng, hasPlot), A("exportPlotAsCSV", exportCsv, hasPlot), SEP, A("exportPlotToClipboard", () => void exportClipboard(), hasPlot),
      A("exportPlotToSchematic", exportToSchematic, () => hasPlot() && canWriteProject()), SEP,
      { label: "Close", icon: "exit", tip: "Close Simulator", key: "Ctrl+W", run: () => void closeSimulator(), enabled: () => true }]],
    ["View", [A("toggleSimSidePanel", () => { S.sidePanel = !S.sidePanel; renderAll(); }, undefined, () => S.sidePanel), A("toggleSimConsole", () => { S.console = !S.console; renderAll(); }, undefined, () => S.console), SEP,
      A("zoomUndo", zoomCmd("zoomUndo"), () => !!t()?.plot?.canUndo()), A("zoomRedo", zoomCmd("zoomRedo"), () => !!t()?.plot?.canRedo()), SEP,
      ...["zoomInCenter", "zoomOutCenter", "zoomInHorizontally", "zoomOutHorizontally", "zoomInVertically", "zoomOutVertically", "zoomFitScreen"].map((id) => A(id, zoomCmd(id), hasPlot)), SEP,
      A("toggleGrid", () => { const x = t(); if (x) { x.setup.grid = !x.setup.grid; S.dirty = true; renderPlot(); } }, hasPlot, () => !!t()?.setup.grid),
      A("toggleLegend", () => { const x = t(); if (x) { x.setup.legend = !x.setup.legend; S.dirty = true; renderPlot(); } }, hasPlot, () => !!t()?.setup.legend),
      A("toggleDottedSecondary", () => { const x = t(); if (x) { x.setup.dotted = !x.setup.dotted; S.dirty = true; renderPlot(); } }, hasPlot, () => !!t()?.setup.dotted),
      A("toggleSmithChart", () => { const x = t(); if (x) toggleSmithChart(x); }, () => { const x = t(); return !!x && tabType(x) === "SP"; }, () => { const x = t(); return !!x && tabType(x) === "SP" && !!x.setup.smith; }),
      A("toggleDarkModePlots", () => { S.darkPlots = !S.darkPlots; renderPlot(); }, undefined, () => S.darkPlots)]],
    ["Simulation", [A("newAnalysisTab", () => void newAnalysisTab()), A("simAnalysisProperties", () => void editAnalysisTab(), hasTab), A("runSimulation", () => void runSimulation(), () => !S.running), SEP,
      A("simProbe", () => startProbe("probe"), hasTab), A("simTune", () => startProbe("tune"), hasTab), SEP, A("editUserDefinedSignals", () => void editUserSignals()), A("showNetlist", showNetlist)]],
    ["Preferences", [A("openPreferences", () => openPreferences("Simulator"))]],
  ];
}
function buildMenubar(): void {
  els.menubar.innerHTML = "";
  for (const [name, items] of menus()) {
    const b = h("div", { class: "se-mb", "data-menu": name }, name);
    b.addEventListener("click", (ev) => { ev.stopPropagation(); const r = b.getBoundingClientRect(); showMenu(r.left, r.bottom, menus().find((m) => m[0] === name)![1], 0, { row: r, parent: r, overlap: 0 } as never); b.classList.add("open"); });
    els.menubar.append(b);
  }
}
function renderToolbar(): void {
  const tb = els.toolbar; tb.innerHTML = "";
  const btn = (id: string, run: () => void, enabled = true): void => {
    const m = meta(id), b = h("button", { class: "se-btn", title: m.tip + (m.key ? ` (${menuKey(m.key)})` : ""), "data-id": id, "aria-label": m.label }, icon(m.icon)) as HTMLButtonElement;
    b.disabled = !enabled; b.addEventListener("click", () => run()); tb.append(b);
  };
  const sep = (): void => { tb.append(h("span", { class: "se-sep" })); };
  const back = h("button", { class: "se-btn sim-back", id: "sim-back", title: "Back to Schematic Editor", "aria-label": "Back to Schematic Editor" }, icon("leave_sheet"), h("span", {}, "Back")) as HTMLButtonElement;
  back.addEventListener("click", () => void closeSimulator()); tb.append(back); sep();
  btn("openWorkbook", openWorkbook); btn("saveWorkbook", () => void saveWorkbook(false)); sep();
  btn("newAnalysisTab", () => void newAnalysisTab()); btn("simAnalysisProperties", () => void editAnalysisTab(), hasTab()); sep();
  btn("runSimulation", () => void runSimulation(), !S.running); btn("stopSimulation", stopSimulation, S.running); sep();
  for (const id of ["zoomInCenter", "zoomOutCenter", "zoomInHorizontally", "zoomOutHorizontally", "zoomInVertically", "zoomOutVertically", "zoomFitScreen"]) btn(id, zoomCmd(id), hasPlot());
  sep(); btn("simProbe", () => startProbe("probe"), hasTab()); btn("simTune", () => startProbe("tune"), hasTab()); sep();
  btn("editUserDefinedSignals", () => void editUserSignals()); btn("showNetlist", showNetlist);
}

// ---------------------------------------------------------------- rendering
function renderAll(): void {
  if (!S.root) return;
  renderToolbar(); renderTabs(); renderPlot(); renderSignals(); renderCursors(); renderMeas(); renderTuners();
  els.side.hidden = !S.sidePanel; els.split.hidden = !S.sidePanel;
  els.console.hidden = !S.console; els.splitH.hidden = !S.console;
}
function renderTabs(): void {
  els.tabs.innerHTML = "";
  S.tabs.forEach((t, i) => {
    const x = h("span", { class: "x", title: "Close" }, closeMark());
    x.addEventListener("click", (ev) => { ev.stopPropagation(); closeTab(i); });
    const tab = h("div", { class: "se-tab" + (i === S.cur ? " cur" : ""), "data-i": String(i), title: t.command }, `Analysis ${i + 1} - ${typeToName(tabType(t), true)}`, x);
    tab.addEventListener("click", () => { S.cur = i; renderAll(); });
    tab.addEventListener("dblclick", () => { S.cur = i; void editAnalysisTab(); });
    els.tabs.append(tab);
  });
}
function renderPlot(): void {
  const area = els.area; const t = curTab();
  for (const c of Array.from(area.children)) c.remove();
  if (!t) {
    area.append(h("div", { class: "se-empty" }, h("div", null, "Select Simulation > New Analysis Tab... (", menuKey("Ctrl+N"), ") to start.", h("br"), h("br"),
      h("button", { type: "button", id: "sim-start", onclick: () => void newAnalysisTab() }, meta("newAnalysisTab").label))));
    return;
  }
  const type = tabType(t);
  if (!isPlottable(type) && type !== "Custom" && type !== "FFT") { area.append(h("div", { class: "sim-op", id: "sim-op" }, t.opText || "Run the simulation to see the results.")); return; }
  if (!t.plot) {
    const p = new SimPlot(); t.plot = p; p.gestures = () => prefs().sim;
    p.onChange = () => {
      // the Smith chart's zoom and pan are the tab's (saved in the workbook)
      if (p.smith && (p.smithZoom !== t.smithZoom || p.smithPan.x !== t.smithPan.x || p.smithPan.y !== t.smithPan.y)) { t.smithZoom = p.smithZoom; t.smithPan = { ...p.smithPan }; S.dirty = true; }
      renderCursors();
    };
    p.onContextMenu = (x, y) => plotMenu(t, x, y);
  }
  const p = t.plot, x = xAxisFor(t);
  // SIM_PLOT_TAB::UpdateAxisVisibility: Y2 / Y3 only while a trace uses them
  const used = new Set(t.traces.map((tr) => axisOf(tr.signal, type)));
  p.opts = { logX: x.log, x: { name: x.name, units: x.units }, y: axesFor(t).map((a, i) => (i === 0 || used.has(i as 0 | 1 | 2) ? a : null)) };
  p.showGrid = t.setup.grid; p.showLegend = t.setup.legend; p.dottedSecondary = t.setup.dotted; p.dark = S.darkPlots;
  p.fixed = t.setup.fixed.slice(); p.margins = { ...t.setup.margins };
  p.smith = isSmith(t);
  if (p.smith) {
    p.smithZoom = t.smithZoom; p.smithPan = { ...t.smithPan };
    // SIM_VIEW::UpdateSmithReferenceImpedance: one z0 for every port shown, or none (mixed, or one unknown)
    let z0 = 0, mixed = false, unresolved = false;
    for (const tr of t.traces) {
      const tz = smithPortImpedance(S.circuit, splitSignal(tr.signal).base);
      if (tz <= 0) unresolved = true; else if (z0 === 0) z0 = tz; else if (tz !== z0) mixed = true;
    }
    p.smithZ0 = mixed || unresolved ? 0 : z0; p.smithMixed = mixed;
  }
  const traces: PlotTrace[] = [];
  const multi = (t as Tab & { multi?: PlotTrace[] }).multi;
  if (multi && multi.length) traces.push(...multi);
  else for (const tr of t.traces) {
    const d = traceData(t, tr.signal); if (!d) continue;
    const ax = axisOf(tr.signal, type);
    const pt: PlotTrace = { name: tr.signal, xs: d.xs, ys: d.ys, color: tr.color, axis: ax, secondary: ax === 1, cursor1: tr.cursor1, cursor2: tr.cursor2 };
    // SMITH_TRACE: the complex S-parameter itself, once per signal whatever part of it the trace plots
    if (p.smith) { const g = gammaData(t, tr.signal); if (!g || splitSignal(tr.signal).part) continue; pt.gamma = g; pt.secondary = false; }
    traces.push(pt);
  }
  if (traces.some((x2) => x2.cursor1)) p.placeCursor(0);
  if (traces.some((x2) => x2.cursor2)) p.placeCursor(1);
  const key = traces.map((x2) => x2.name).join("|") + "#" + (t.data ? t.data.vectors[0]?.re.length : 0);
  const refit = (p as SimPlot & { _key?: string })._key !== key; (p as SimPlot & { _key?: string })._key = key;
  area.append(p.el);
  p.setTraces(traces, refit);
  syncSetup(t);
}
function plotMenu(t: Tab, x: number, y: number): void {
  const p = t.plot; if (!p) return;
  const r = p.canvas.getBoundingClientRect(), lx = x - r.left, ly = y - r.top;
  const it = (id: string, run: () => void, en = true): PopItem => ({ label: meta(id).label, run, disabled: !en });
  // SIM_VIEW::onSmithRightUp / onSmithMenuCommand: no zoom history on a Smith chart; the zooms are about where the menu opened
  if (p.smith) {
    popupMenu(x, y, [
      it("zoomUndo", () => undefined, false), it("zoomRedo", () => undefined, false), { sep: true },
      { label: "Zoom In", run: () => p.smithZoomAt(lx, ly, 1.5) }, { label: "Zoom Out", run: () => p.smithZoomAt(lx, ly, 1 / 1.5) },
      { label: "Center on Cursor", run: () => p.smithCenterOn(lx, ly) }, { label: "Fit on Screen", run: () => p.resetSmith() },
    ]);
    return;
  }
  popupMenu(x, y, [
    it("zoomUndo", () => p.undoZoom(), p.canUndo()), it("zoomRedo", () => p.redoZoom(), p.canRedo()), { sep: true },
    { label: "Zoom In", run: () => p.zoom(1.5, "both", [lx, ly]) }, { label: "Zoom Out", run: () => p.zoom(1 / 1.5, "both", [lx, ly]) },
    { label: "Center on Cursor", run: () => p.centerOn(lx, ly) }, { label: "Fit on Screen", run: () => p.fit() },
  ]);
}

// ---------------------------------------------------------------- the side panel grids
function table(head: string[]): { table: HTMLTableElement; body: HTMLTableSectionElement } {
  const tb = h("tbody"), tbl = h("table", { class: "sim-grid" }, h("thead", null, h("tr", null, ...head.map((x) => h("th", null, x)))), tb);
  return { table: tbl, body: tb };
}
function renderSignals(): void {
  const host = els.signals; host.innerHTML = "";
  const t = curTab();
  const { table: tbl, body } = table(["Signal", "Plot", "Y Scale", "Color", "Cursor 1", "Cursor 2"]); tbl.id = "sim-signals-grid";
  if (!t) { host.append(tbl); return; }
  const type = tabType(t), q = S.filter.trim().toLowerCase();
  const list = !isPlottable(type) && type !== "Custom" && type !== "FFT" ? [] : allSignalsFor(type, t.options, isSmith(t));
  for (const tr of t.traces) if (!list.includes(tr.signal)) list.push(tr.signal);
  const axes = axesFor(t);
  for (const sig of list) {
    if (q && !matchFilter(sig.toLowerCase(), q)) continue;
    const tr = t.traces.find((x) => x.signal === sig) || null;
    const plotCb = h("input", { type: "checkbox", checked: !!tr, "data-col": "plot" }) as HTMLInputElement;
    plotCb.addEventListener("change", () => { if (plotCb.checked) addTrace(sig); else removeTrace(sig); });
    const cur = (n: 1 | 2): HTMLElement => {
      const cb = h("input", { type: "checkbox", checked: !!(tr && (n === 1 ? tr.cursor1 : tr.cursor2)), disabled: !tr, "data-col": "cursor" + n }) as HTMLInputElement;
      cb.addEventListener("change", () => { if (!tr) return; for (const o of t.traces) if (n === 1) o.cursor1 = o === tr ? cb.checked : false; else o.cursor2 = o === tr ? cb.checked : false; S.dirty = true; renderPlot(); renderSignals(); renderCursors(); });
      return cb;
    };
    const sw = tr ? h("span", { class: "sim-swatch", style: `background:${tr.color}`, title: "Change color" }) : h("span");
    if (tr) sw.addEventListener("click", () => { colorPicker(fromHex(tr.color), false, (c) => { tr.color = toHex(c).slice(0, 7); S.dirty = true; renderPlot(); renderSignals(); }); });
    const ax = tr ? axes[axisOf(sig, type)] : null;
    const row = h("tr", { "data-signal": sig }, h("td", null, sig), h("td", { class: "c" }, plotCb), h("td", null, ax ? ax.name : ""), h("td", { class: "c" }, sw), h("td", { class: "c" }, cur(1)), h("td", { class: "c" }, cur(2)));
    row.addEventListener("contextmenu", (ev) => { ev.preventDefault(); signalMenu(t, sig, ev.clientX, ev.clientY); });
    row.addEventListener("pointerdown", () => { for (const r of Array.from(body.children)) r.classList.toggle("sel", r === row); });
    body.append(row);
  }
  host.append(tbl);
}
/** wxString::Matches with the filter's wildcards ("*" and "?"), or a plain substring. */
function matchFilter(s: string, q: string): boolean {
  if (!/[*?]/.test(q)) return s.includes(q);
  const re = new RegExp("^" + q.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"); return re.test(s);
}
/** SIGNALS_GRID_TRICKS::showPopupMenu on the Signal column. */
function signalMenu(t: Tab, sig: string, x: number, y: number): void {
  const type = tabType(t);
  if (!(type === "TRAN" || type === "AC" || type === "DC" || type === "SP")) return;
  const meas = (label: string, fn: string): PopItem => ({ label, run: () => { const m = measurementFor(fn, sig); if (m) addMeasurement(m); } });
  const ac = type === "AC" || type === "SP";
  const items: PopItem[] = [meas("Measure Min", "MIN"), meas("Measure Max", "MAX"), meas("Measure Average", "AVG"), meas("Measure RMS", "RMS"), meas("Measure Peak-to-peak", "PP"),
    meas(ac ? "Measure Frequency of Min" : "Measure Time of Min", "MIN_AT"), meas(ac ? "Measure Frequency of Max" : "Measure Time of Max", "MAX_AT"), meas("Measure Integral", "INTEG")];
  if (type === "TRAN") items.push({ sep: true }, { label: "Perform Fourier Analysis...", run: () => void fourier(sig) });
  items.push({ sep: true }, { label: "Copy Signal Name\t" + menuKey("Ctrl+C"), run: () => { void navigator.clipboard?.writeText(sig).catch(() => undefined); } });
  popupMenu(x, y, items);
}
async function fourier(sig: string): Promise<void> {
  const fund = await promptText(`Fourier Analysis of ${sig}`, "Fundamental frequency:", "1K"); if (fund === null) return;
  if (!S.spice || !S.simulated) { log("Error: run the simulation first.\n"); return; }
  const r = await S.spice.exec([`fourier ${toSpiceString(parseSpiceValue(fund || "1K"))} ${sig.toLowerCase()}`]);
  log(r.out); for (const e of r.err) if (e.trim()) log(e + "\n");
}
function addMeasurement(expr: string): void {
  const t = curTab(); if (!t || !t.plot && !isPlottable(tabType(t))) return;
  if (t.meas.some((m) => m.expr === expr)) return;
  t.meas.push({ expr, format: { precision: 3, range: "~V" }, value: "" }); S.dirty = true;
  if (S.spice && S.simulated) void updateMeasurements(t, S.spice).then(renderMeas); else renderMeas();
}
function renderCursors(): void {
  const host = els.cursors; host.innerHTML = "";
  const t = curTab(); const xn = t ? xAxisFor(t).name : "Time";
  const { table: tbl, body } = table(["Cursor", "Signal", xn === "Time" ? "Time" : xn.split(" ")[0], "Value"]); tbl.id = "sim-cursors-grid";
  host.append(tbl);
  if (!t || !t.plot) return;
  const p = t.plot, type = tabType(t), xu = xAxisFor(t).units;
  const rows: { name: string; sig: string; x: number; y: number; units: string }[] = [];
  for (const ci of [0, 1] as const) {
    const tr = t.traces.find((o) => (ci ? o.cursor2 : o.cursor1)); const cx = p.cursorX[ci];
    if (!tr || cx === null) continue;
    const pt = p.traces.find((o) => o.name === tr.signal); if (!pt) continue;
    const { part } = splitSignal(tr.signal);
    rows.push({ name: String(ci + 1), sig: tr.signal, x: cx, y: p.valueAt(pt, cx), units: unitsOf(userKind(tr.signal) || signalKind(tr.signal, type), part, type) });
  }
  if (rows.length === 2) rows.push({ name: "Diff", sig: rows[0].sig === rows[1].sig ? rows[0].sig : `${rows[1].sig} - ${rows[0].sig}`, x: rows[1].x - rows[0].x, y: rows[1].y - rows[0].y, units: rows[0].units });
  for (const r of rows) {
    const fx = updateUnits(t.cursorFmt[0], xu), fy = updateUnits(t.cursorFmt[1], r.units);
    const tr = h("tr", null, h("td", null, r.name), h("td", null, r.sig), h("td", { "data-col": "x" }, formatValue(r.x, fx)), h("td", { "data-col": "y" }, formatValue(r.y, fy)));
    tr.addEventListener("contextmenu", (ev) => {
      ev.preventDefault(); const td = (ev.target as HTMLElement).closest("td"); const col = td ? td.dataset.col : null; if (!col) return;
      const axis = col === "x" ? 0 : 1, label = col === "x" ? (tbl.querySelectorAll("th")[2].textContent || "Time") : "Value";
      popupMenu(ev.clientX, ev.clientY, [{ label: `Format ${label}...`, run: async () => { const f = await openFormatValue(axis ? fy : fx, axis ? r.units : xu); if (f) { t.cursorFmt[axis] = f; S.dirty = true; renderCursors(); } } }]);
    });
    body.append(tr);
  }
}
function renderMeas(): void {
  const host = els.meas; host.innerHTML = "";
  const t = curTab();
  const { table: tbl, body } = table(["Measurement", "Value", "Format"]); tbl.id = "sim-meas-grid";
  host.append(tbl);
  if (!t) return;
  const rows = [...t.meas, { expr: "", format: { precision: 3, range: "~V" }, value: "" }];
  rows.forEach((m, i) => {
    const inp = h("input", { type: "text", value: m.expr, "data-col": "expr" }) as HTMLInputElement;
    inp.addEventListener("change", () => {
      const v = inp.value.trim();
      if (i === t.meas.length) { if (v) addMeasurement(v); return; }
      if (!v) { t.meas.splice(i, 1); } else { t.meas[i].expr = v; }
      S.dirty = true; if (S.spice && S.simulated) void updateMeasurements(t, S.spice).then(renderMeas); else renderMeas();
    });
    const tr = h("tr", null, h("td", null, inp), h("td", null, m.value), h("td", null, i < t.meas.length ? formatToString(m.format) : ""));
    if (i < t.meas.length) tr.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      popupMenu(ev.clientX, ev.clientY, [
        { label: "Format Value...", run: async () => { const u = measurementUnits(m.expr, tabType(t)) || ""; const f = await openFormatValue(updateUnits(m.format, u), u); if (f) { m.format = f; S.dirty = true; if (S.spice && S.simulated) await updateMeasurements(t, S.spice); renderMeas(); } } },
        { sep: true }, { label: "Delete Measurement", run: () => { t.meas.splice(i, 1); S.dirty = true; renderMeas(); } },
      ]);
    });
    body.append(tr);
  });
}

// ---------------------------------------------------------------- tuners (TUNER_SLIDER)
function renderTuners(): void {
  const host = els.tuners; host.innerHTML = ""; host.hidden = !S.tuners.length;
  for (const tu of S.tuners) host.append(tunerEl(tu));
}
function tunerEl(tu: Tuner): HTMLElement {
  const set = (v: number, rerun = true): void => { tu.value = tu.series ? snapToSeries(v, tu.series as 24) : v; val.value = toSpiceString(tu.value); slider.value = String(Math.round(((tu.value - tu.min) / ((tu.max - tu.min) || 1)) * 100)); if (rerun) scheduleTune(); };
  const max = h("input", { type: "text", value: toSpiceString(tu.max), title: "Maximum value", "data-k": "max" }) as HTMLInputElement;
  const min = h("input", { type: "text", value: toSpiceString(tu.min), title: "Minimum value", "data-k": "min" }) as HTMLInputElement;
  const val = h("input", { type: "text", value: toSpiceString(tu.value), title: "Value", "data-k": "value" }) as HTMLInputElement;
  const slider = h("input", { type: "range", min: "0", max: "100", step: "1" }) as HTMLInputElement;
  slider.addEventListener("input", () => set(tu.min + ((tu.max - tu.min) * Number(slider.value)) / 100));
  max.addEventListener("change", () => { const v = parseSpiceValue(max.value); if (Number.isFinite(v) && v > tu.min) { tu.max = v; if (tu.value > v) set(v); else set(tu.value, false); } max.value = toSpiceString(tu.max); });
  min.addEventListener("change", () => { const v = parseSpiceValue(min.value); if (Number.isFinite(v) && v < tu.max) { tu.min = v; if (tu.value < v) set(v); else set(tu.value, false); } min.value = toSpiceString(tu.min); });
  val.addEventListener("change", () => { const v = parseSpiceValue(val.value); if (Number.isFinite(v)) { if (v > tu.max) tu.max = v; if (v < tu.min) tu.min = v; max.value = toSpiceString(tu.max); min.value = toSpiceString(tu.min); set(v); } else val.value = toSpiceString(tu.value); });
  const es = h("div", { class: "es" });
  const toggles = ([24, 48, 96, 192] as const).map((n) => bitmapToggle(`e_${n}`, `Limit to E${n} series values.`, tu.series === n, (on) => { tu.series = on ? n : 0; for (const o of toggles) if (o !== b) o.setOn(false); if (on) set(tu.value); }, { key: `e${n}` }));
  let b: HTMLButtonElement | null = null;
  toggles.forEach((t2) => { t2.addEventListener("click", () => { b = t2; }, { capture: true }); es.append(t2); });
  const mode = h("k-select", { title: "Run mode" }) as HTMLSelectElement;
  for (const [v, l] of [["single", "Single Run"], ["multi", "Multi Run"]]) mode.append(h("option", { value: v }, l));
  mode.value = tu.multi ? "multi" : "single";
  const steps = h("input", { type: "text", value: String(tu.steps), title: "Steps", "data-k": "steps", style: "display:" + (tu.multi ? "block" : "none") }) as HTMLInputElement;
  mode.addEventListener("change", () => { tu.multi = mode.value === "multi"; if (tu.multi) for (const o of S.tuners) if (o !== tu) o.multi = false; renderTuners(); });
  steps.addEventListener("change", () => { const n = parseInt(steps.value, 10); if (n >= 2 && n <= 100) tu.steps = n; steps.value = String(tu.steps); });
  const save = h("button", { type: "button", class: "txt", title: "Save the value to the schematic" }, "Save");
  save.addEventListener("click", () => saveTuner(tu));
  const close = bitmapButton("small_trash", "Remove tuner", () => { S.tuners = S.tuners.filter((o) => o !== tu); renderTuners(); scheduleTune(); }, { flat: true });
  const el = h("div", { class: "sim-tuner", "data-tuner": tu.name }, h("div", { class: "nm" }, h("span", { title: `Tune ${tu.name}` }, tu.name), close), max, slider, val, min, es, mode, steps, save);
  set(tu.value, false);
  return el;
}
/** SIMULATOR_FRAME_UI::applyTuners: each tuner's value through its model's TunerCommand (SPICE_GENERATOR_IDEAL's
 *  "alter @r1=…", SPICE_GENERATOR_R_POT's "altermod @a…[position]=…", a DC source's "alter @v1=…"). */
function tunerCommands(): string[] {
  const out: string[] = [], report: string[] = [];
  const items = (E.kdoc as unknown as { items: Map<string, unknown> }).items;
  for (const tu of S.tuners) {
    if (tu.symId && !items.has(tu.symId)) { report.push(`${tu.name} not found`); continue; }
    const si = S.simItems.find((x) => x.name.toLowerCase() === tu.name.toLowerCase());
    const cmd = si && si.tunerCommand ? si.tunerCommand(tu.value) : "";
    if (cmd) out.push(cmd); else report.push(`${tu.name} is not tunable`);
  }
  // one message for every tuner, after them all (WX_STRING_REPORTER, DisplayErrorMessage)
  if (report.length) void messageBox("Could not apply tuned value(s):\n" + report.join("\n"));
  return out;
}
function addTuner(name: string, symId: string | null): void {
  if (S.tuners.some((t) => t.name.toLowerCase() === name.toLowerCase())) return;
  // SIMULATOR_FRAME_UI::AddTuner: the exporter's item of the reference (GetExporter()->FindItem), nothing without one
  const si = S.simItems.find((x) => x.ref === name) || S.simItems.find((x) => x.name.toLowerCase() === name.toLowerCase());
  const it = si ? S.circuit.items.find((i) => i.name.toLowerCase() === si.name.toLowerCase()) : null;
  if (!si || !it) return;
  // TUNER_SLIDER: SIM_MODEL::GetTunerParam, so ideal passives, potentiometers and sources can be tuned
  if (!si.tunerCommand) {
    void messageBox(`${name} has simulation model of type '${si.device} ${si.typeField}'.\n\nOnly passive R, L, C models and voltage and current sources may be tuned.`);
    return;
  }
  if (S.tuners.some((t) => t.name.toLowerCase() === it.name.toLowerCase())) return;
  const line = S.netlist.split(/\r?\n/).find((l) => l.trim().toLowerCase().startsWith(name.toLowerCase() + " ")) || "";
  const tok = line.trim().split(/\s+/);
  const v = si.tunerPot && si.tunerValue === "" ? 0.5 : toDouble(si.tunerValue);
  if (!Number.isFinite(v)) { void messageBox(`${name} has no value that can be tuned.`); return; }
  // TUNER_SLIDER: a potentiometer's wiper from 0 to 1, anything else half to twice the value (a zero value gets ±1)
  const lo = si.tunerPot ? 0 : v === 0 ? -1 : v > 0 ? v / 2 : v * 2, hi = si.tunerPot ? 1 : v === 0 ? 1 : v > 0 ? v * 2 : v / 2;
  S.tuners.push({ name: it.name, value: v, min: lo, max: hi, steps: 5, multi: false, series: 0, orig: tok[3] || "", symId });
  renderTuners();
}
/** TUNER_SLIDER::onSave: the tuned value becomes the symbol's Value field (when the symbol is on the open sheet). */
function saveTuner(tu: Tuner): void {
  const doc = E.kdoc as unknown as { items: Map<string, { id: string; kind: string; node: unknown[] }> } | null;
  const K = (window as unknown as { KiCadCanvas: { replaceChange(d: unknown, it: unknown): unknown; kids(n: unknown, k: string): unknown[][]; str(v: unknown): string } }).KiCadCanvas;
  if (!doc || !isSch()) return;
  let target: { id: string; kind: string; node: unknown[] } | null = null;
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const ref = K.kids(it.node, "property").find((p) => K.str(p[1]) === "Reference");
    if (ref && K.str(ref[2]).toLowerCase() === tu.name.toLowerCase()) { target = it; break; }
  }
  if (!target) { void messageBox(`${tu.name} is not on the sheet shown in the schematic editor.`); return; }
  const node = JSON.parse(JSON.stringify(target.node)) as unknown[];
  const val = K.kids(node, "property").find((p) => K.str(p[1]) === "Value"); if (!val) return;
  val[2] = toSpiceString(tu.value);
  const ctx = toolCtx();
  ctx.commit([K.replaceChange(ctx.doc, Object.assign({}, target, { node, geom: [], bbox: null }))] as never, "Update Value");
  requestRender(); toast(`${tu.name} = ${toSpiceString(tu.value)}`);
}

// ---------------------------------------------------------------- probe / tune on the schematic
let banner: HTMLElement | null = null;
/** SIMULATOR_CONTROL::Probe / Tune: the schematic comes forward; each click adds a signal (or a tuner); Esc returns. */
function startProbe(kind: "probe" | "tune"): void {
  if (!S.root || !curTab()) return;
  S.probing = kind; S.root.hidden = true;
  banner = h("div", { class: "sim-probe-banner", id: "sim-probe-banner" }, kind === "probe" ? "Probe: click a wire or pin to plot it; Esc to return to the simulator" : "Tune: click a symbol to add a tuner; Esc to return to the simulator");
  document.body.append(banner);
  for (const t of SWALLOW) window.addEventListener(t, swallow, true);
  window.addEventListener("pointerdown", probeClick, true);
  window.addEventListener("keydown", probeKey, true);
}
function stopProbe(): void {
  for (const t of SWALLOW) window.removeEventListener(t, swallow, true);
  window.removeEventListener("pointerdown", probeClick, true);
  window.removeEventListener("keydown", probeKey, true);
  if (banner) { banner.remove(); banner = null; }
  S.probing = null; if (S.root) { S.root.hidden = false; renderAll(); }
}
function probeKey(ev: KeyboardEvent): void { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); stopProbe(); } }
interface SchInternals { _: { pickNet(ctx: unknown, mm: number[]): { item: { id: string; kind: string; node: unknown[] }; at: number[]; pin?: string } | null; cursorOf(ctx: unknown): number[] } }
/** the clicks of the probe are the probe's: the editor under it does not select or drag */
const SWALLOW = ["mousedown", "mouseup", "click", "dblclick", "pointerup"];
const onStage = (ev: Event): boolean => { const st = document.getElementById("stage"), t = ev.target as Node | null; return !!st && !!t && st.contains(t); };
function swallow(ev: Event): void { if (onStage(ev) && (ev as MouseEvent).button === 0) { ev.preventDefault(); ev.stopPropagation(); } }
function probeClick(ev: PointerEvent): void {
  if (ev.button !== 0 || !onStage(ev)) return;
  ev.preventDefault(); ev.stopPropagation();
  const sch = (window as unknown as { CollabTools?: { sch?: SchInternals } }).CollabTools?.sch;
  if (!sch || !sch._) return;
  const ctx = toolCtx(); const mm = mmAt(ev) || sch._.cursorOf(ctx);
  const K = (window as unknown as { KiCadCanvas: { hitTest(d: unknown, x: number, y: number, tol: number): string | null; kids(n: unknown, k: string): unknown[][]; str(v: unknown): string } }).KiCadCanvas;
  if (S.probing === "tune") {
    const id = K.hitTest(E.kdoc, mm[0], mm[1], 1); const it = id ? (E.kdoc as unknown as { items: Map<string, { kind: string; node: unknown[] }> }).items.get(id) : null;
    if (!it || it.kind !== "symbol") return;
    const ref = K.kids(it.node, "property").find((p) => K.str(p[1]) === "Reference");
    if (ref) addTuner(K.str(ref[2]), id);
    return;
  }
  // SCH_EDITOR_CONTROL::SimProbe: a pin (GetNode) probes the symbol's current, anything on a net its voltage
  const pinHit = pinUnder(mm, Math.max(0.3, 5 / pxPerMm()));
  if (pinHit) {
    const { ref, number } = pinHit;
    // SIM_LIB_MGR::CreateModel's model of the symbol (as the netlist built it): one current for the item, else the
    // current of the model pin the clicked pin is wired to (FindModelPinIndex)
    const item = S.simItems.find((x) => x.ref === ref); if (!item) return;
    const names = item.currents;
    if (!names.length) return;
    if (names.length === 1) { addProbe(names[0]); return; }
    const idx = item.pins.findIndex((p) => p.symbolPin === number);
    if (idx >= 0 && idx < names.length) addProbe(names[idx]);
    return;
  }
  const pick = sch._.pickNet(ctx, mm); if (!pick) return;
  const r = nameOfPick(pick as never); if (!r || !r.name) return;
  // the net as the netlist names it (NETLIST_EXPORTER_SPICE::ConvertToSpiceMarkup); ground has no voltage to plot
  const net = convertToSpiceMarkup(r.name);
  if (net === "0" || /^gnd$/i.test(net)) return;
  addProbe(`V(${S.circuit.nets.find((n) => n.toLowerCase() === net.toLowerCase()) || net})`);
}
/** The symbol pin whose line (body root to connection point) passes within `tol` of the point. */
function pinUnder(mm: number[], tol: number): { ref: string; number: string } | null {
  const doc = E.kdoc as unknown as { items: Map<string, { id: string; kind: string; node: unknown[] }> } | null;
  const K = (window as unknown as { KiCadCanvas: { kids(n: unknown, k: string): unknown[][]; str(v: unknown): string } }).KiCadCanvas;
  const sch = (window as unknown as { CollabTools?: { sch?: { _: { symbolPins(d: unknown, it: unknown): { x: number; y: number; root: number[]; number: string; hidden: boolean }[] } } } }).CollabTools?.sch;
  if (!doc || !sch || !sch._) return null;
  let best: { ref: string; number: string } | null = null, bd = tol;
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const prop = (n: string): string => { const p = K.kids(it.node, "property").find((q) => K.str(q[1]) === n); return p ? K.str(p[2]) : ""; };
    const ref = prop("Reference"); if (!ref || ref.startsWith("#")) continue;
    for (const p of sch._.symbolPins(E.kdoc, it)) {
      if (p.hidden) continue;
      const ax = p.root[0], ay = p.root[1], dx = p.x - ax, dy = p.y - ay, l2 = dx * dx + dy * dy;
      const u = l2 ? Math.max(0, Math.min(1, ((mm[0] - ax) * dx + (mm[1] - ay) * dy) / l2)) : 0;
      const d = Math.hypot(ax + u * dx - mm[0], ay + u * dy - mm[1]);
      if (d < bd) { bd = d; best = { ref, number: p.number }; }
    }
  }
  return best;
}
function mmAt(ev: PointerEvent): number[] | null { try { return worldMm(ev); } catch { return null; } }
function addProbe(signal: string): void {
  const t = curTab(); if (!t) return;
  const type = tabType(t);
  const smith = isSmith(t);
  const name = type === "AC" ? signal + " (gain)" : type === "SP" && !smith ? signal + " (amplitude)" : signal;
  addTrace(name); if (type === "AC" || (type === "SP" && !smith)) addTrace(signal + " (phase)");
  toast(`Added ${signal}`);
}

// ---------------------------------------------------------------- dialogs and exports
async function editUserSignals(): Promise<void> {
  const r = await openUserDefinedSignals(S.userSignals, (e) => (/^[\w\s+\-*/^().,:#@[\]]+$/.test(e) && balanced(e) ? null : `Invalid expression: ${e}`));
  if (!r) return;
  S.userSignals = r; S.dirty = true; renderAll();
}
function balanced(e: string): boolean { let d = 0; for (const c of e) { if (c === "(") d++; else if (c === ")" && --d < 0) return false; } return d === 0; }
function showNetlist(): void {
  const t = curTab(); const text = t ? circuitFor(t) : S.netlist;
  KD().open({ title: "SPICE Netlist", width: 640, readOnly: true, geomKey: "NETLIST_VIEW_DIALOG", build(b) { const ta = h("textarea", { readonly: true, spellcheck: "false", id: "sim-netlist", style: "width:100%;height:420px;font:12px/1.35 var(--mono,monospace)" }) as HTMLTextAreaElement; ta.value = text; b.append(ta); } });
}
function exportPng(): void { const p = curTab()?.plot; if (!p) return; const a = document.createElement("a"); a.href = p.pngDataUrl(); a.download = "plot.png"; a.click(); }
function exportCsv(): void { const p = curTab()?.plot; if (!p) return; download("plot.csv", p.csv()); }
/** SIMULATOR_CONTROL::ExportPlotToSchematic: the plot's PNG as an (image …) on the clipboard, pasted into the schematic
 *  (it rides the cursor until the click that places it), the schematic brought forward. */
function exportToSchematic(): void {
  const p = curTab()?.plot; if (!p) return;
  const b64 = p.pngDataUrl().replace(/^data:image\/png;base64,/, "");
  let text = "(image (at 0 0)\n  (data\n";
  for (let i = 0; i < b64.length; i += 76) text += `    "${b64.slice(i, i + 76)}"\n`;
  text += "  )\n)\n";
  void navigator.clipboard?.writeText(text).catch(() => undefined);
  const sch = (window as unknown as { CollabTools?: { sch?: { _: { pasteText(ctx: unknown, text: string, opts?: unknown): boolean } } } }).CollabTools?.sch;
  if (!sch || !sch._ || !sch._.pasteText) return;
  if (S.root) S.root.hidden = true;
  if (!sch._.pasteText(toolCtx(), text, { label: "Export Plot to Schematic" }) && S.root) S.root.hidden = false;
}
async function exportClipboard(): Promise<void> {
  const p = curTab()?.plot; if (!p) return;
  const blob = await new Promise<Blob | null>((ok) => p.canvas.toBlob(ok, "image/png"));
  const CI = (window as unknown as { ClipboardItem?: new (d: Record<string, Blob>) => unknown }).ClipboardItem;
  if (!blob || !CI || !navigator.clipboard || !(navigator.clipboard as unknown as { write?: unknown }).write) { toast("The clipboard does not take images here"); return; }
  try { await (navigator.clipboard as unknown as { write(items: unknown[]): Promise<void> }).write([new CI({ "image/png": blob })]); toast("Plot copied to the clipboard"); } catch { toast("The clipboard does not take images here"); }
}

// ---------------------------------------------------------------- the workbook
export function workbook(): Workbook {
  return {
    version: 8,
    tabs: S.tabs.map((t): WbTab => {
      syncSetup(t);
      const wt: WbTab = { analysis: typeToName(tabType(t), true), commands: commandsFromOptions(t.command, t.options) };
      if (isPlottable(tabType(t)) || tabType(t) === "Custom") {
        wt.traces = t.traces.map((tr) => ({ trace_type: traceType(t, tr.signal), signal: splitSignal(tr.signal).base, color: tr.color }));
        wt.measurements = t.meas.map((m) => ({ expr: m.expr, format: formatToString(m.format) }));
        wt.dottedSecondary = t.setup.dotted; wt.showGrid = t.setup.grid;
        if (t.setup.legend && t.plot) wt.legend = { x: t.plot.legendAt.x, y: t.plot.legendAt.y };
        t.setup.fixed.forEach((f, i) => { if (f) (wt as unknown as Record<string, unknown>)[`fixedY${i + 1}scale`] = { min: f.min, max: f.max }; });
        wt.margins = { ...t.setup.margins };
        wt.smithMode = isSmith(t);
        if (isSmith(t)) {
          wt.smithZoom = t.smithZoom; wt.smithPanX = t.smithPan.x; wt.smithPanY = t.smithPan.y;
          // what the Smith toggle set aside, so a workbook written in Smith mode keeps it across a reload
          if (t.stashTraces.length) wt.smithStashedTraces = t.stashTraces.map((x) => ({ ...x }));
          if (t.stashCursors.length) wt.smithStashedCursors = t.stashCursors.map((x) => { const { frequency, ...rest } = x; return Number.isFinite(frequency) ? { ...rest, frequency } : rest; });
        }
      }
      return wt;
    }),
    user_defined_signals: S.userSignals.slice(),
    last_sch_text_sim_command: S.tabs.length ? S.tabs[0].lastSch : "",
  };
}
/** SIM_TRACE_TYPE bits: SPT_VOLTAGE 0x01, SPT_CURRENT 0x02, SPT_AC_PHASE 0x04, SPT_AC_GAIN 0x08, SPT_POWER 0x10, SPT_SP_AMP 0x20 … */
function traceType(t: Tab, signal: string): number {
  const { base, part } = splitSignal(signal); const k = userKind(base) || signalKind(base, tabType(t));
  let v = k === "I" ? 0x02 : k === "P" ? 0x10 : 0x01;
  if (part === "phase") v |= 0x04; else if (part === "gain") v |= 0x08; else if (part === "amplitude") v |= 0x20;
  else if (isSmith(t)) v |= 0x40;
  const type = tabType(t);
  v |= type === "AC" || type === "SP" || type === "NOISE" || type === "FFT" ? 0x400 : type === "DC" ? 0x800 : 0x100;
  return v;
}
function signalOfTrace(tr: { trace_type?: number; signal: string }): string[] {
  const tt = tr.trace_type || 0;
  if (tt & 0x04 && tt & 0x08) return [tr.signal + " (gain)", tr.signal + " (phase)"];
  if (tt & 0x04) return [tr.signal + " (phase)"];
  if (tt & 0x08) return [tr.signal + " (gain)"];
  if (tt & 0x20) return [tr.signal + " (amplitude)"];
  return [tr.signal];
}
export function applyWorkbook(wb: Workbook): void {
  S.tabs = []; S.cur = -1;
  S.userSignals = Array.isArray(wb.user_defined_signals) ? wb.user_defined_signals.slice() : [];
  for (const wt of wb.tabs || []) {
    const { command, options } = optionsFromCommands(wt.commands || []);
    const t = newTab(command, options);
    for (const tr of wt.traces || []) for (const s of signalOfTrace(tr)) if (!t.traces.some((x) => x.signal === s)) t.traces.push({ signal: s, color: tr.color && /^#|^rgb/.test(tr.color) ? cssHex(tr.color) : nextColor(t), cursor1: false, cursor2: false });
    t.meas = (wt.measurements || []).map((m) => ({ expr: m.expr, format: formatFromString(m.format), value: "" }));
    t.setup.dotted = wt.dottedSecondary !== false; t.setup.grid = wt.showGrid !== false; t.setup.legend = !!wt.legend;
    t.setup.fixed = [wt.fixedY1scale || null, wt.fixedY2scale || null, wt.fixedY3scale || null];
    if (wt.margins) t.setup.margins = { ...t.setup.margins, ...wt.margins };
    // SIM_PLOT_TAB::SetSmithMode: only an S-parameter tab has one
    t.setup.smith = !!wt.smithMode && tabType(t) === "SP";
    if (t.setup.smith) {
      const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
      t.smithZoom = Math.min(50, Math.max(1, num(wt.smithZoom, 1))); t.smithPan = { x: num(wt.smithPanX, 0), y: num(wt.smithPanY, 0) };
      for (const st of Array.isArray(wt.smithStashedTraces) ? wt.smithStashedTraces : []) {
        if (!st || !st.vector) continue;
        t.stashTraces.push({ vector: st.vector, name: st.name || st.vector, base_type: num(st.base_type, 0) });
      }
      for (const st of Array.isArray(wt.smithStashedCursors) ? wt.smithStashedCursors : []) {
        const id = num(st && st.id, 0);
        if (!st || !st.vector || (id < 1 && id !== -1)) continue;
        t.stashCursors.push({ id, vector: st.vector, base_type: num(st.base_type, 0), sub_type: num(st.sub_type, 0), frequency: num(st.frequency, NaN) });
      }
    }
  }
  if (S.tabs.length) S.tabs[0].lastSch = typeof wb.last_sch_text_sim_command === "string" ? wb.last_sch_text_sim_command : "";
  S.cur = S.tabs.length ? 0 : -1; S.dirty = false;
}
function cssHex(c: string): string { const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); return m ? "#" + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, "0")).join("").toUpperCase() : c.slice(0, 7); }
function wbkDocs(): { docId: string; path: string }[] { return (projectDocs() as { docId: string; path: string }[]).filter((d) => /\.wbk$/i.test(d.path)); }
/** File > Open Workbook…: a project's .wbk, or one from the computer. */
function openWorkbook(): void {
  const docs = wbkDocs();
  const fromFile = (): void => {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".wbk,application/json";
    inp.addEventListener("change", async () => { const f = inp.files && inp.files[0]; if (!f) return; loadWorkbookText(await f.text(), f.name); });
    inp.click();
  };
  if (!docs.length) { fromFile(); return; }
  const r = els.toolbar.getBoundingClientRect();
  popupMenu(r.left + 8, r.bottom, [...docs.map((d) => ({ label: d.path, run: async () => { try { const t = await api(`/api/docs/${d.docId}/content`); loadWorkbookText(typeof t === "string" ? t : JSON.stringify(t), d.path); } catch { void messageBox(`Unable to load ${d.path}.`); } } })), { sep: true }, { label: "From this computer...", run: fromFile }]);
}
function loadWorkbookText(text: string, name: string): void {
  try {
    const wb = JSON.parse(text) as Workbook;
    if (!wb || !Array.isArray(wb.tabs)) throw new Error("not a workbook");
    applyWorkbook(wb); S.wbName = name; S.simulated = false; renderAll(); log(`Loaded workbook ${name}\n`);
  } catch { void messageBox(`Unable to load or parse file ${name}.`); }
}
/** File > Save Workbook (As…): the .wbk next to the project file (SIMULATOR_FRAME::SaveWorkbook), or a download for a viewer. */
async function saveWorkbook(as: boolean): Promise<void> {
  const text = JSON.stringify(workbook(), null, 2) + "\n";
  const docs = projectDocs() as { docId: string; path: string; docType: string }[];
  const pro = docs.find((d) => d.docType === "kicad_pro");
  const dir = pro && pro.path.includes("/") ? pro.path.slice(0, pro.path.lastIndexOf("/") + 1) : "";
  const stem = pro ? pro.path.split("/").pop()!.replace(/\.kicad_pro$/, "") : "simulation";
  let path = S.wbName && /\.wbk$/i.test(S.wbName) ? S.wbName : dir + stem + ".wbk";
  if (as) {
    const name = await promptText("Save Simulation Workbook", "File name:", path.split("/").pop() || stem + ".wbk", (v) => /^[^/\\]+$/.test(v.trim()));
    if (name === null) return;
    path = dir + (/\.wbk$/i.test(name.trim()) ? name.trim() : name.trim() + ".wbk");
  }
  if (!canWriteProject()) { download(path.split("/").pop()!, text, "application/json"); S.wbName = path; S.dirty = false; log(`Downloaded workbook ${path}\n`); return; }
  try {
    const have = docs.find((d) => d.path === path);
    if (have) { if (!(await saveTextDocument(have.docId, text, { id: "workbook", kind: "MODIFIED", typeName: "WORKBOOK_FILE", properties: [] } as never))) throw new Error("not saved"); }
    else {
      const project = (state as unknown as { project?: { projectId: string; docs: { docId: string; path: string; docType: string }[] } }).project;
      if (!project) throw new Error("no project");
      const res = await api(`/api/projects/${project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path, docType: "other" }) }) as { docId?: string; path?: string };
      if (!res.docId) throw new Error("no document");
      const r = await fetch(`/api/docs/${res.docId}/snapshots?seq=0`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: text });
      if (!r.ok) throw new Error(String(r.status));
      if (!project.docs.some((d) => d.docId === res.docId)) project.docs.push({ docId: res.docId, path: res.path || path, docType: "other" });
    }
    S.wbName = path; S.dirty = false; log(`Saved workbook ${path}\n`);
    // SaveWorkbook: the saved workbook is the project's (workbook_filename, relative to the project)
    const rel = dir && path.startsWith(dir) ? path.slice(dir.length) : path;
    if (ngSettings().workbook_filename !== rel) await saveNgSettings({ workbook_filename: rel });
  } catch (e) { void messageBox(`Error saving workbook ${path}: ${e instanceof Error ? e.message : String(e)}`); }
}

/** Test hooks (static/tests and the rigs). */
export const simInternals = { S, workbook, applyWorkbook, addTrace, runSimulation, renderAll, curTab, kicon: kicadIcon, COMPAT_MODES };
