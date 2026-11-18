// kibis — KIBIS (eeschema/sim/kibis/kibis.cpp, ibis_parser.cpp): an IBIS model turned into a SPICE subcircuit for
// one pin of a component, as SPICE_GENERATOR_IBIS::IbisDevice writes it to the netlist.
//
//   * a device (KIBIS_DEVICE, an input): the pin's package R / L / C, the die's C_comp and its GND / POWER clamps
//     (IVtable::Spice, XSPICE pwl sources) on the [Voltage Range] supply;
//   * a driver (KIBIS_DRIVER_DC / _RECT / _PRBS): the same with the pullup and pulldown tables switched by the KU / KD
//     coefficients over time (KIBIS_PIN::getKuKdNoWaveform from the [Ramp]);
//   * differential (Sim.Ibis.Diff): the two of them in one subcircuit (writeSpiceDiffDriver / writeSpiceDiffDevice).
//
// What is not here: KiCad derives the KU / KD of a model with [Rising Waveform] / [Falling Waveform] tables by running
// ngspice on them while it writes the netlist (getKuKdOneWaveform / getKuKdTwoWaveforms); this writer uses the [Ramp]
// for every model and says so.  Dynamic clamp submodels and Series models are not written either.

/** IBIS_CORNER: typ, min, max. */
type Corner = 0 | 1 | 2;
type TMM = [number, number, number];
interface IvEntry { V: number; I: TMM }
interface Dvdt { dv: number; dt: number }
interface IbisModelData {
  name: string; type: string;
  cComp: TMM; voltageRange: TMM;
  pulldown: IvEntry[]; pullup: IvEntry[]; gndClamp: IvEntry[]; powerClamp: IvEntry[];
  rampR: [Dvdt, Dvdt, Dvdt]; rampF: [Dvdt, Dvdt, Dvdt];
  waveforms: number;
}
interface IbisPinData { number: string; signal: string; model: string; R: number; L: number; C: number }
interface IbisComponentData { name: string; pins: IbisPinData[]; R: TMM; L: TMM; C: TMM }
export interface KibisFile { components: IbisComponentData[]; models: IbisModelData[]; selectors: Map<string, string[]> }

const NA = NaN;
/** IbisParser::parseDouble: a number, then an optional scale letter (M is mega); NA is no value. */
function num(s: string | undefined): number {
  if (s === undefined || s === "NA") return NA;
  const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s); if (!m) return NA;
  let v = Number(m[0]);
  const scale: Record<string, number> = { T: 1e12, G: 1e9, M: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
  const c = s[m[0].length]; if (c && scale[c] !== undefined) v *= scale[c];
  return v;
}
const tmm = (t: string[]): TMM => [num(t[0]), num(t[1]), num(t[2])];
/** IbisParser::parseDvdt: "dV/dt" (each with its scale), NA for none. */
function dvdt(s: string | undefined): Dvdt { if (!s || s === "NA") return { dv: NA, dt: NA }; const i = s.indexOf("/"); return i < 0 ? { dv: NA, dt: NA } : { dv: num(s.slice(0, i)), dt: num(s.slice(i + 1)) }; }
/** compareIbisWord: keywords match whatever their case, a space and an underscore alike. */
const key = (s: string): string => s.trim().toLowerCase().replace(/[ _]+/g, "_");

/** The parts of an IBIS file KIBIS uses: components (package, pins), models (type, C_comp, voltage range, the IV
 *  tables, the ramp) and model selectors. */
export function parseKibis(text: string): KibisFile {
  const out: KibisFile = { components: [], models: [], selectors: new Map() };
  let comment = "|", section = "", comp: IbisComponentData | null = null, model: IbisModelData | null = null, selector: string[] | null = null;
  let pinCols: string[] = [];
  for (const raw0 of text.replace(/\r\n?/g, "\n").split("\n")) {
    const ci = raw0.indexOf(comment); const raw = ci >= 0 ? raw0.slice(0, ci) : raw0;
    const kw = /^\s*\[([^\]]+)\]\s*(.*)$/.exec(raw);
    if (kw) {
      section = key(kw[1]); const arg = kw[2].trim();
      if (section === "comment_char") { const c = arg.charAt(0); if (c) comment = c; section = ""; continue; }
      if (section === "component") { comp = { name: arg, pins: [], R: [NA, NA, NA], L: [NA, NA, NA], C: [NA, NA, NA] }; out.components.push(comp); }
      else if (section === "model") {
        model = { name: arg.split(/\s+/)[0], type: "", cComp: [NA, NA, NA], voltageRange: [NA, NA, NA], pulldown: [], pullup: [], gndClamp: [], powerClamp: [], rampR: [dvdt(""), dvdt(""), dvdt("")], rampF: [dvdt(""), dvdt(""), dvdt("")], waveforms: 0 };
        out.models.push(model);
      } else if (section === "model_selector") { selector = []; out.selectors.set(arg.split(/\s+/)[0], selector); }
      else if (section === "pin") pinCols = arg.split(/\s+/).map((c) => c.toLowerCase());
      else if (section === "voltage_range" && model) model.voltageRange = tmm(arg.split(/\s+/));
      else if ((section === "rising_waveform" || section === "falling_waveform") && model) model.waveforms++;
      continue;
    }
    const t = raw.trim().split(/\s+/).filter(Boolean); if (!t.length) continue;
    if (section === "package" && comp) {
      const k = t[0].toLowerCase();
      if (k === "r_pkg") comp.R = tmm(t.slice(1)); else if (k === "l_pkg") comp.L = tmm(t.slice(1)); else if (k === "c_pkg") comp.C = tmm(t.slice(1));
    } else if (section === "pin" && comp && t.length >= 3) {
      const col = (n: string): number => { const i = pinCols.indexOf(n); return i < 0 ? NA : num(t[i + 1]); };
      comp.pins.push({ number: t[0], signal: t[1], model: t[2], R: col("r_pin"), L: col("l_pin"), C: col("c_pin") });
    } else if (section === "model_selector" && selector) selector.push(t[0]);
    else if (section === "model" && model) {
      const k = key(t[0]);
      if (k === "model_type") model.type = key(t.slice(1).join(" "));
      else if (k === "c_comp") model.cComp = tmm(t.slice(1));
    } else if (model && (section === "pulldown" || section === "pullup" || section === "gnd_clamp" || section === "power_clamp")) {
      const e = { V: num(t[0]), I: tmm(t.slice(1)) };
      if (Number.isNaN(e.V)) continue;
      (section === "pulldown" ? model.pulldown : section === "pullup" ? model.pullup : section === "gnd_clamp" ? model.gndClamp : model.powerClamp).push(e);
    } else if (section === "ramp" && model) {
      const k = t[0].toLowerCase();
      if (k === "dv/dt_r") model.rampR = [dvdt(t[1]), dvdt(t[2]), dvdt(t[3])];
      else if (k === "dv/dt_f") model.rampF = [dvdt(t[1]), dvdt(t[2]), dvdt(t[3])];
    }
  }
  return out;
}

/** IBIS_BASE::doubleToString: std::scientific, six decimals ("5.000000e+00"). */
export function sci(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const [m, e] = x.toExponential(6).split("e"); const n = Number(e);
  return `${m}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
}
/** IVtable::Spice: an XSPICE pwl source between two nodes (its current negated when asked), the points of the
 *  corner that has a value there. */
function ivSpice(table: IvEntry[], n: number, p1: string, p2: string, negate: boolean, modelName: string, corner: Corner): string {
  if (!table.length) return "";
  const pts = table.filter((e) => !Number.isNaN(e.I[corner]));
  let r = `a${n} %vd(${p1} ${p2}) %id(${negate ? p2 : p1} ${negate ? p1 : p2}) ${modelName}\n\n.model ${modelName} pwl(\n+ x_array=[`;
  for (const e of pts) r += sci(e.V) + "\n+";
  r += "]\n+ y_array=[";
  for (const e of pts) r += sci(e.I[corner]) + "\n+";
  return r + "]\n+ input_domain=0.05 fraction=TRUE)\n\n";
}

export interface KibisParams { supply: Corner; rpin: Corner; lpin: Corner; cpin: Corner; ccomp: Corner }
/** KIBIS_PARAMETER::SetCornerFromString: "MIN" and "MAX" as written, anything else typical. */
export const corner = (s: string): Corner => (s === "MIN" ? 1 : s === "MAX" ? 2 : 0);
export type KibisWave =
  | { kind: "none" } | { kind: "high_z" } | { kind: "stuck_high" } | { kind: "stuck_low" }
  | { kind: "rect"; ton: number; toff: number; delay: number; cycles: number }
  | { kind: "prbs"; bitrate: number; delay: number; bits: number };

const DRIVER_TYPES = new Set(["output", "i/o", "3-state", "open_drain", "i/o_open_drain", "open_sink", "i/o_open_sink", "open_source", "i/o_open_source", "output_ecl", "i/o_ecl", "3-state_ecl"]);
const DEVICE_TYPES = new Set(["input", "i/o", "i/o_open_drain", "i/o_open_sink", "i/o_open_source", "i/o_ecl"]);

/** KIBIS_MODEL::SpiceDie (no submodels): the supply, C_comp, the clamps, and for a driver the KU / KD weighted
 *  pullup and pulldown. */
function spiceDie(m: IbisModelData, p: KibisParams, i: number, driver: boolean): string {
  const s = p.supply;
  let r = `\nVPWR POWER GND ${sci(m.voltageRange[s])}\nCCPOMP DIE${i} GND ${sci(m.cComp[p.ccomp])}\n`;
  if (m.gndClamp.length) r += ivSpice(m.gndClamp, i * 4 + 1, `DIE${i}`, `GC_GND${i}`, false, `GC${i}`, s) + `VmeasGC${i} GND GC_GND${i} 0\n`;
  if (m.powerClamp.length) r += ivSpice(m.powerClamp, i * 4 + 2, `PC_PWR${i}`, `DIE${i}`, true, `PC${i}`, s) + `VmeasPC${i} POWER PC_PWR${i} 0\n`;
  if (driver && m.pulldown.length) r += ivSpice(m.pulldown, i * 4 + 3, `DIEBUFF${i}`, `PD_GND${i}`, false, `PD${i}`, s) + `VmeasPD GND PD_GND${i} 0\nBKD GND DIE${i} i=( i(VmeasPD) * v(KD) )\n`;
  if (driver && m.pullup.length) r += ivSpice(m.pullup, i * 4 + 4, `PU_PWR${i}`, `DIEBUFF${i}`, false, `PU${i}`, s) + `VmeasPU POWER PU_PWR${i} 0\nBKU POWER DIE${i} i=( -i(VmeasPU) * v(KU) )\n`;
  if (driver && (m.pullup.length || m.pulldown.length)) r += `BDIEBUFF DIEBUFF${i} GND v=v(DIE${i})\n`;
  return r;
}

/** One pin of a component with its model, ready to write. */
export interface KibisPin { comp: IbisComponentData; pin: IbisPinData; model: IbisModelData }
/** KIBIS::GetComponent, KIBIS_COMPONENT::GetPin, KIBIS::GetModel: the pin and model, or the error KiCad gives. */
export function findKibisPin(f: KibisFile, compName: string, pinName: string, modelName: string): KibisPin | string {
  const comp = f.components.find((c) => c.name === compName); if (!comp) return `Could not find IBIS component '${compName}'`;
  const pin = comp.pins.find((p) => p.number === pinName); if (!pin) return `Could not find IBIS pin '${pinName}' in component '${compName}'`;
  const model = f.models.find((m) => m.name === modelName); if (!model) return `Could not find IBIS model '${modelName}'`;
  return { comp, pin, model };
}
/** KIBIS_PIN's R / L / C: the [Pin] row's value at every corner, else the [Package] one. */
function pinRlc(k: KibisPin, which: "R" | "L" | "C", c: Corner): number { const v = k.pin[which]; return Number.isNaN(v) ? k.comp[which][c] : v; }
function pinHead(k: KibisPin, p: KibisParams): string {
  return `RPIN 1 PIN ${sci(pinRlc(k, "R", p.rpin))}\nLPIN DIE0 1 ${sci(pinRlc(k, "L", p.lpin))}\nCPIN PIN GND ${sci(pinRlc(k, "C", p.cpin))}\n`;
}

/** KIBIS_WAVEFORM_*::GenerateBitSequence and SimplifyBitSequence. */
function bitSequence(w: KibisWave, inverted: boolean): [number, number][] {
  const bits: [number, number][] = [];
  if (w.kind === "rect") {
    for (let i = 0; i < w.cycles; i++) { bits.push([inverted ? 0 : 1, (w.ton + w.toff) * i + w.delay]); bits.push([inverted ? 1 : 0, (w.ton + w.toff) * i + w.delay + w.ton]); }
  } else if (w.kind === "prbs") {
    if (w.bitrate === 0) return bits;
    const poly = 0b1100000, period = 1 / w.bitrate; let lfsr = 0x12, t = 0, n = 0;
    do { const lsb = lfsr & 1; bits.push([(inverted ? 1 : 0) ^ lsb ? 1 : 0, t]); lfsr >>= 1; if (lsb) lfsr ^= poly; t += period; } while (++n < w.bits);
  }
  const out: [number, number][] = []; let prev = -1;
  for (const b of bits) { if (b[0] !== prev) out.push(b); prev = b[0]; }
  return out;
}
/** KIBIS_WAVEFORM_RECTANGULAR / _PRBS::Check against the ramp: the reports KiCad gives (errors) for a bad wave. */
function checkWave(w: KibisWave, m: IbisModelData, report: (msg: string) => void): void {
  const rise = Math.max(...m.rampR.map((d) => d.dt)) / 0.6, fall = Math.max(...m.rampF.map((d) => d.dt)) / 0.6;
  if (w.kind === "rect") {
    if (w.cycles < 1) report("Number of cycles should be greater than 0.");
    if (w.ton <= 0) report("ON time should be greater than 0.");
    if (w.toff <= 0) report("OFF time should be greater than 0.");
    if (w.ton < rise) report("Rising edge is longer than ON time.");
    if (w.toff < fall) report("Falling edge is longer than OFF time.");
  } else if (w.kind === "prbs") {
    if (w.bitrate <= 0) report("Bitrate should be greater than 0.");
    if (w.bits <= 0) report("Number of bits should be greater than 0.");
    else if (w.bitrate > 0 && 1 / w.bitrate < Math.max(rise, fall)) report("Bitrate is too high for rising / falling edges");
  }
}
/** KIBIS_PIN::getKuKdNoWaveform: KU and KD from the bit sequence, each edge taking the ramp's 20-80 % time / 0.6. */
function kuKd(m: IbisModelData, p: KibisParams, w: KibisWave, inverted: boolean, report: (msg: string) => void): { t: number[]; ku: number[]; kd: number[] } {
  const t: number[] = [], ku: number[] = [], kd: number[] = [];
  if (w.kind === "rect" || w.kind === "prbs") {
    checkWave(w, m, report);
    for (const [b, at] of bitSequence(w, inverted)) {
      ku.push(b ? 0 : 1); kd.push(b ? 1 : 0); t.push(at);
      ku.push(b ? 1 : 0); kd.push(b ? 0 : 1); t.push(at + (b ? m.rampR[p.supply].dt : m.rampF[p.supply].dt) / 0.6);
    }
  } else if (w.kind === "stuck_high") { ku.push(inverted ? 0 : 1); kd.push(inverted ? 1 : 0); t.push(0); }
  else if (w.kind === "stuck_low") { ku.push(inverted ? 1 : 0); kd.push(inverted ? 0 : 1); t.push(0); }
  else { ku.push(0); kd.push(0); t.push(0); }
  return { t, ku, kd };
}

/** KIBIS_PIN::writeSpiceDriver. */
function driver(k: KibisPin, name: string, p: KibisParams, w: KibisWave, inverted: boolean, report: (msg: string, sev: "error" | "warning" | "info") => void): string | null {
  const m = k.model;
  if (!DRIVER_TYPES.has(m.type)) { report(m.type === "series" || m.type === "series_switch" ? "Series and Series_switch models are passive devices, not drivers." : "Invalid model type for a driver.", "error"); return null; }
  let r = `\n*Driver model generated by Kicad using Ibis data. \n*Pin number: ${k.pin.number}\n*Signal name: ${k.pin.signal}\n*Model: ${m.name}\n.SUBCKT ${name} GND PIN \n\n` + pinHead(k, p);
  if (m.waveforms >= 2) report("This model's waveform tables are not used here: its driver follows the [Ramp], as KiCad does for a model without them.", "warning");
  else report("Model has no waveform pair, using [Ramp] instead, poor accuracy", "info");
  const kk = kuKd(m, p, w, inverted, (msg) => report(msg, "error"));
  r += "Vku KU GND pwl ( " + kk.t.map((x, i) => `${sci(x)} ${sci(kk.ku[i])} `).join("") + ") \n";
  r += "Vkd KD GND pwl ( " + kk.t.map((x, i) => `${sci(x)} ${sci(kk.kd[i])} `).join("") + ") \n";
  return r + spiceDie(m, p, 0, true) + "\n.ENDS DRIVER\n\n";
}
/** KIBIS_PIN::writeSpiceDevice. */
function device(k: KibisPin, name: string, p: KibisParams, report: (msg: string, sev: "error" | "warning" | "info") => void): string | null {
  const m = k.model;
  if (!DEVICE_TYPES.has(m.type)) { report(m.type === "series" || m.type === "series_switch" ? "Series models are not written by this exporter." : "Invalid model type for a device", "error"); return null; }
  return `*Device model generated by Kicad using Ibis data.\n.SUBCKT ${name} GND PIN\n\n\n` + pinHead(k, p) + spiceDie(m, p, 0, false) + "\n.ENDS DEVICE\n\n";
}

/** SPICE_GENERATOR_IBIS::IbisDevice: the subcircuit text for the item (named `name`), or null after a report. */
export function kibisSubckt(k: KibisPin, name: string, p: KibisParams, kind: "device" | "driver", wave: KibisWave, diff: boolean,
  report: (msg: string, sev: "error" | "warning" | "info") => void): string | null {
  if (kind === "device") {
    if (!diff) return device(k, name, p, report);
    // writeSpiceDiffDevice (writeSpiceDevice replaces what it is given, so the result is the N half's subcircuit)
    const a = device(k, name + "_P", p, report), b = device(k, name + "_N", p, report);
    if (a === null || b === null) return null;
    return b + `\nx1 GND PIN_P ${name}_P \nx2 GND PIN_N ${name}_N \n\n\n.ENDS ${name}\n\n`;
  }
  if (!diff) return driver(k, name, p, wave, false, report);
  if (wave.kind === "none") return null;
  const a = driver(k, name + "_P", p, wave, false, report), b = driver(k, name + "_N", p, wave, true, report);
  if (a === null || b === null) return null;
  return `\n*Differential driver model generated by Kicad using Ibis data. \n.SUBCKT ${name} GND PIN_P PIN_N\n\n` + a + b + `\nx1 GND PIN_P ${name}_P \nx2 GND PIN_N ${name}_N \n\n\n.ENDS ${name}\n\n`;
}
