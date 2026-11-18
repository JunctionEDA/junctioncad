// sim/sim-logic — the simulator's pure parts: SPICE_VALUE (spice_value.cpp), SPICE_VALUE_FORMAT, the analysis
// commands DIALOG_SIM_COMMAND writes and parses (dialog_sim_command.cpp), SPICE_CIRCUIT_MODEL::CommandToSimType /
// VectorToSignal (spice_circuit_model.cpp), the signal list of SIMULATOR_FRAME_UI::rebuildSignalsList, ngspice's
// ASCII raw file and the workbook (.wbk, SIMULATOR_FRAME_UI::SaveWorkbook / loadJsonWorkbook).

// ---------------------------------------------------------------- SPICE_VALUE
const PREFIX_EXP: Record<string, number> = { f: -15, p: -12, n: -9, u: -6, m: -3, k: 3, meg: 6, g: 9, t: 12 };
/** SPICE_VALUE( const wxString& ): "%lf%7s" then a SPICE unit prefix (f p n u m k meg g t, any case); NaN when no number leads. */
export function parseSpiceValue(s: string): number {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(\S*)/.exec(s || "");
  if (!m) return NaN;
  const base = Number(m[1]), units = m[2].toLowerCase();
  if (!units) return base;
  const exp = units.startsWith("meg") ? 6 : PREFIX_EXP[units[0]] ?? 0;
  return exp < 0 ? base / Math.pow(10, -exp) : base * Math.pow(10, exp);
}
/** SPICE_VALUE::Normalize: a mantissa in [1, 1000) and its prefix exponent (-15 … 12). */
export function normalizeSpice(v: number): { base: number; exp: number } {
  let base = v, exp = 0;
  while (Math.abs(base) >= 1000 && exp < 12) { base *= 0.001; exp += 3; }
  while (base !== 0 && Math.abs(base) < 1 && exp > -15) { base *= 1000; exp -= 3; }
  return { base, exp };
}
const SPICE_PFX: Record<number, string> = { [-15]: "f", [-12]: "p", [-9]: "n", [-6]: "u", [-3]: "m", 0: "", 3: "k", 6: "Meg", 9: "G", 12: "T" };
const SI_PFX: Record<number, string> = { [-15]: "f", [-12]: "p", [-9]: "n", [-6]: "u", [-3]: "m", 0: "", 3: "K", 6: "M", 9: "G", 12: "T" };
/** wxString::FromCDouble( x ) with no precision: a C-locale std::ostream at its default precision, i.e. printf's "%g"
 *  (6 significant digits, scientific below 1e-4 or from 1e6, the exponent signed and at least two digits). */
export function fromCDouble(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x < 0 ? "-inf" : "inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const P = 6, e = Number(x.toExponential(P - 1).split("e")[1]);
  const strip = (m: string): string => (m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m);
  if (e < -4 || e >= P) {
    const [m, ex] = x.toExponential(P - 1).split("e"), n = Number(ex);
    return strip(m) + "e" + (n < 0 ? "-" : "+") + String(Math.abs(n)).padStart(2, "0");
  }
  return strip(x.toFixed(Math.max(0, P - 1 - e)));
}
/** SPICE_VALUE::StripZeros: with a decimal point, trailing zeros and then the point go. */
function stripZeros(s: string): string {
  if (!s.includes(".") && !s.includes(",")) return s;
  s = s.replace(/0+$/, "");
  return s.endsWith(".") || s.endsWith(",") ? s.slice(0, -1) : s;
}
/** SPICE_VALUE::ToSpiceString: "1u", "4.7k", "10Meg". */
export function toSpiceString(v: number): string { const { base, exp } = normalizeSpice(v); return stripZeros(fromCDouble(base)) + (SPICE_PFX[exp] ?? ""); }
/** SPICE_VALUE( string ).ToSpiceString(): a field's text as the command writes it ("" stays ""). */
export function spiceText(s: string): string { const v = parseSpiceValue(s); return Number.isFinite(v) ? toSpiceString(v) : s.trim(); }
/** SPICE_VALUE_FORMAT: significant digits and a range ("~V" auto prefix + units, "mV", "°", …). */
export interface ValueFormat { precision: number; range: string }
export function formatFromString(s: string): ValueFormat { return s ? { precision: Number(s[0]) || 0, range: s.slice(1) } : { precision: 3, range: "~V" }; }
export function formatToString(f: ValueFormat): string { return `${Math.min(9, Math.max(0, f.precision))}${f.range}`; }
const SI_EXP: Record<string, number> = { f: -15, p: -12, n: -9, u: -6, m: -3, K: 3, M: 6, G: 9, T: 12 };
/** SPICE_VALUE_FORMAT::UpdateUnits. */
export function updateUnits(f: ValueFormat, units: string): ValueFormat {
  const c = f.range[0];
  return { precision: f.precision, range: c === "~" || (c !== undefined && SI_EXP[c] !== undefined) ? c + units : units };
}
/** SPICE_VALUE::ToString( SPICE_VALUE_FORMAT ). */
export function formatValue(v: number, f: ValueFormat): string {
  let range = f.range;
  if (range.endsWith("°")) {
    let a = v % 360; if (a > 180) a -= 360; if (a <= -180) a += 360;
    return a.toFixed(f.precision) + "°";
  }
  let base: number;
  if (range.startsWith("~")) { const n = normalizeSpice(v); base = n.base; range = (SI_PFX[n.exp] ?? "") + range.slice(1); }
  else { const e = SI_EXP[range[0]] ?? 0; base = v / Math.pow(10, e); }
  let mant = base, scale = 0;
  while (Math.abs(mant) >= 10) { mant *= 0.1; scale += 1; }
  while (mant !== 0 && Math.abs(mant) < 1) { mant *= 10; scale -= 1; }
  mant = Math.round(mant * Math.pow(10, f.precision - 1));
  mant *= Math.pow(10, scale - f.precision + 1);
  let res = mant.toFixed(Math.max(0, f.precision - scale - 1));
  // "an excessively long number": wxString::FromCDouble( mantissa ), "%g" (scientific for tiny values)
  if (res.length > f.precision + scale + 1) res = fromCDouble(mant);
  return res + range;
}

// ---------------------------------------------------------------- SIM_TYPE
export type SimType = "OP" | "AC" | "DC" | "TRAN" | "DISTO" | "NOISE" | "PZ" | "SENS" | "TF" | "SP" | "FFT" | "Custom";
const TYPE_NAMES: Record<SimType, string> = { OP: "DC Operating Point", AC: "Small-Signal Analysis", DC: "DC Sweep Analysis", TRAN: "Transient Analysis",
  DISTO: "Small-Signal Distortion Analysis", NOISE: "Noise Analysis", PZ: "Pole-Zero Analysis", SENS: "Sensitivity Analysis", TF: "Transfer Function Analysis",
  SP: "S-Parameter Analysis", FFT: "Frequency Content Analysis", Custom: "Custom" };
/** SPICE_SIMULATOR::TypeToName. */
export function typeToName(t: SimType, short: boolean): string { return short ? t : TYPE_NAMES[t]; }
/** The analysis types DIALOG_SIM_COMMAND::parseCommand( "*" ) lists for a new tab, in its order. */
export const NEW_TAB_TYPES: SimType[] = ["OP", "DC", "AC", "TRAN", "PZ", "NOISE", "SP", "FFT", "Custom"];
/** SPICE_CIRCUIT_MODEL::CommandToSimType. */
export function commandToSimType(cmd: string): SimType {
  const c = cmd.toLowerCase().trim();
  if (c === ".op") return "OP";
  for (const [p, t] of [[".ac", "AC"], [".dc", "DC"], [".tran", "TRAN"], [".disto", "DISTO"], [".noise", "NOISE"], [".pz", "PZ"], [".sens", "SENS"], [".sp", "SP"], [".tf", "TF"]] as const) if (c.startsWith(p)) return t;
  if (c.startsWith("fft") || c.includes("\nfft")) return "FFT";
  return "Custom";
}
/** SIM_TAB::IsPlottable. */
export const isPlottable = (t: SimType): boolean => t === "AC" || t === "DC" || t === "SENS" || t === "TRAN" || t === "NOISE" || t === "SP" || t === "FFT";
/** The tab title SIMULATOR_FRAME gives an analysis (the short name, "Custom" for anything else). */
export const tabTitle = (cmd: string): string => typeToName(commandToSimType(cmd), true);

// ---------------------------------------------------------------- the command pages
export type Scale = "dec" | "oct" | "lin";
export interface AcCmd { scale: Scale; points: string; fStart: string; fStop: string }
export interface SpCmd extends AcCmd { noise: boolean }
export interface DcSrc { type: "V" | "I" | "R" | "TEMP"; source: string; start: string; stop: string; incr: string }
export interface DcCmd { src1: DcSrc; src2: DcSrc | null }
export interface TranCmd { step: string; final: string; initial: string; maxStep: string; uic: boolean }
export interface NoiseCmd { meas: string; ref: string; src: string; scale: Scale; points: string; fStart: string; fStop: string; saveAll: boolean }
export interface PzCmd { input: string; inputRef: string; output: string; outputRef: string; func: "vol" | "cur"; find: "pz" | "pol" | "zer" }
export interface FftCmd { signals: string[]; linearize: boolean }

export const acCommand = (c: AcCmd): string => `.ac ${c.scale} ${c.points} ${spiceText(c.fStart)} ${spiceText(c.fStop)}`;
export const spCommand = (c: SpCmd): string => `.sp ${c.scale} ${c.points} ${spiceText(c.fStart)} ${spiceText(c.fStop)} ${c.noise ? "1" : ""}`.trim();
/** evaluateDCControls: "<source> <start> <stop> <incr>", TEMP as is. */
export const dcPart = (s: DcSrc): string => `${s.type === "TEMP" ? "TEMP" : s.source} ${spiceText(s.start)} ${spiceText(s.stop)} ${spiceText(s.incr)}`;
export function dcCommand(c: DcCmd): string | { error: string } {
  if (c.src1.type !== "TEMP" && !c.src1.source) return { error: "A DC source must be specified." };
  if (c.src2 && c.src2.type !== "TEMP" && !c.src2.source) return { error: "A DC source must be specified." };
  if (c.src2 && dcName(c.src1) === dcName(c.src2)) return { error: "Source 1 and Source 2 must be different." };
  return ".dc " + dcPart(c.src1) + (c.src2 ? " " + dcPart(c.src2) : "");
}
const dcName = (s: DcSrc): string => (s.type === "TEMP" ? "TEMP" : s.source);
/** The .tran line TransferDataFromWindow builds: optional initial time, max step (defaulted when "uic" needs one), uic. */
export function tranCommand(c: TranCmd): string {
  const step = parseSpiceValue(c.step), fin = parseSpiceValue(c.final);
  const start = c.initial.trim() ? parseSpiceValue(c.initial) : 0;
  let opt = c.uic ? "uic" : "";
  if (c.maxStep.trim()) opt = toSpiceString(parseSpiceValue(c.maxStep)) + " " + opt;
  else if (opt) { let ms = (fin - start) / 50; if (ms > step) ms = step; opt = toSpiceString(ms) + " " + opt; }
  if (c.initial.trim()) opt = toSpiceString(start) + " " + opt;
  else if (opt) opt = "0 " + opt;
  return `.tran ${toSpiceString(step)} ${toSpiceString(fin)} ${opt}`.trim();
}
export function noiseCommand(c: NoiseCmd): string | { error: string } {
  if (!c.fStart.trim() || !c.fStop.trim()) return { error: "A frequency range must be specified." };
  return `.noise v(${c.meas}${c.ref ? "," + c.ref : ""}) ${c.src} ${c.scale} ${c.points} ${spiceText(c.fStart)} ${spiceText(c.fStop)} ${c.saveAll ? "1" : ""}`.trim();
}
export const pzCommand = (c: PzCmd): string => `.pz ${c.input} ${c.inputRef} ${c.output} ${c.outputRef} ${c.func} ${c.find}`;
export function fftCommand(c: FftCmd): string { const v = c.signals.map((s) => " " + s).join(""); return (c.linearize ? "linearize" + v + "\n" : "") + "fft" + v; }

/** DIALOG_SIM_COMMAND::parseCommand, as plain values for the pages. */
export interface ParsedCommand { type: SimType; ac?: AcCmd; sp?: SpCmd; dc?: DcCmd; tran?: TranCmd; noise?: NoiseCmd; pz?: PzCmd; fft?: FftCmd; custom?: string }
export function parseCommand(cmd: string): ParsedCommand {
  const type = commandToSimType(cmd), tok = cmd.trim().split(/[ \t\r\n]+/), at = (i: number): string => tok[i] || "";
  const sv = (s: string): string => (s ? spiceText(s) : "");
  const scale = (s: string): Scale => (s.toLowerCase() === "oct" ? "oct" : s.toLowerCase() === "lin" ? "lin" : "dec");
  switch (type) {
    case "AC": return { type, ac: { scale: scale(at(1)), points: at(2), fStart: sv(at(3)), fStop: sv(at(4)) } };
    case "SP": return { type, sp: { scale: scale(at(1)), points: at(2), fStart: sv(at(3)), fStop: sv(at(4)), noise: at(5) === "1" } };
    case "DC": {
      const t = cmd.trim().slice(3).trim().split(/[ \t]+/);
      const src = (o: number): DcSrc => { const s = t[o] || ""; const ty = s.toUpperCase() === "TEMP" ? "TEMP" : (["V", "I", "R"].includes(s[0]?.toUpperCase()) ? s[0].toUpperCase() : "V") as DcSrc["type"]; return { type: ty, source: ty === "TEMP" ? "TEMP" : s, start: sv(t[o + 1] || ""), stop: sv(t[o + 2] || ""), incr: sv(t[o + 3] || "") }; };
      return { type, dc: { src1: src(0), src2: t.length > 4 ? src(4) : null } };
    }
    case "TRAN": {
      const r: TranCmd = { step: sv(at(1)), final: sv(at(2)), initial: "", maxStep: "", uic: false };
      const t3 = at(3), t4 = at(4), t5 = at(5);
      if (/^uic$/i.test(t3)) r.uic = true; else if (t3) r.initial = sv(t3);
      if (/^uic$/i.test(t4)) r.uic = true; else if (t4) r.maxStep = sv(t4);
      if (/^uic$/i.test(t5)) r.uic = true;
      return { type, tran: r };
    }
    case "NOISE": {
      const m = /^\.noise\s+v\(([^)]*)\)(.*)$/i.exec(cmd.trim());
      const r: NoiseCmd = { meas: "", ref: "", src: "", scale: "dec", points: "", fStart: "", fStop: "", saveAll: false };
      if (m) {
        const fn = m[1].split(/[ ,\t]+/).filter(Boolean); r.meas = fn[0] || ""; r.ref = fn[1] || "";
        const p = m[2].trim().split(/[ \t]+/).filter(Boolean); let i = 0;
        if (p[i]) r.src = p[i++];
        if (p[i] && /^(dec|oct|lin)$/i.test(p[i])) r.scale = scale(p[i++]);
        if (p[i]) r.points = p[i++]; if (p[i]) r.fStart = sv(p[i++]); if (p[i]) r.fStop = sv(p[i++]); if (p[i]) r.saveAll = true;
      }
      return { type, noise: r };
    }
    case "PZ": { const f = at(6).toLowerCase(); return { type, pz: { input: at(1), inputRef: at(2), output: at(3), outputRef: at(4), func: at(5).toLowerCase() === "cur" ? "cur" : "vol", find: f === "pol" ? "pol" : f === "zer" ? "zer" : "pz" } }; }
    case "FFT": { const lines = cmd.split(/\r?\n/); const f = lines.find((l) => /^\s*fft\b/i.test(l)) || ""; return { type, fft: { signals: f.trim().split(/[ \t]+/).slice(1), linearize: lines.some((l) => /^\s*linearize\b/i.test(l)) } }; }
    case "OP": return { type };
    default: return { type, custom: cmd };
  }
}

// ---------------------------------------------------------------- the circuit (from the netlist text)
/** A SPICE element of the netlist: its name as written ("R1", "XU1") and the nodes it connects. */
export interface CircuitItem { name: string; nodes: string[]; currents?: string[]; /** an S-parameter port (a voltage source's portnum and z0) */ portnum?: string; z0?: string }
const NODE_COUNT: Record<string, number> = { R: 2, C: 2, L: 2, V: 2, I: 2, D: 2, B: 2, F: 2, H: 2, E: 4, G: 4, Q: 3, J: 3, Z: 3, M: 4, S: 4, W: 2, T: 4, O: 4, U: 3, K: 0, A: 0, N: 0, P: 0, Y: 0 };
/** The elements and nets of a netlist: lines joined over "+", .subckt bodies and dot-cards skipped. */
export function readCircuit(netlist: string): { items: CircuitItem[]; nets: string[]; directives: string[] } {
  const lines: string[] = [];
  for (const raw of netlist.split(/\r?\n/)) { if (/^\+/.test(raw) && lines.length) lines[lines.length - 1] += " " + raw.slice(1); else lines.push(raw); }
  const items: CircuitItem[] = [], nets = new Set<string>(), directives: string[] = []; let depth = 0, control = false;
  for (const l of lines) {
    const t = l.trim(); if (!t || t[0] === "*") continue;
    // a .control … .endc block holds ngspice commands ("version", "let …"), not elements
    if (/^\.control\b/i.test(t)) { control = true; continue; } if (/^\.endc\b/i.test(t)) { control = false; continue; }
    if (control) continue;
    if (/^\.subckt\b/i.test(t)) { depth++; continue; } if (/^\.ends\b/i.test(t)) { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    if (t[0] === ".") { directives.push(t); continue; }
    const tok = t.split(/\s+/), name = tok[0], kind = name[0].toUpperCase();
    let nodes: string[];
    if (kind === "X") { const rest = tok.slice(1).filter((x) => !x.includes("=")); nodes = rest.slice(0, -1); }
    else nodes = tok.slice(1, 1 + (NODE_COUNT[kind] ?? 2));
    const item: CircuitItem = { name, nodes };
    // SPICE_GENERATOR_SOURCE::ItemLine writes an S-parameter port as "portnum <n> [z0 <ohms>]"
    if (kind === "V") {
      const pi = tok.findIndex((x) => x.toLowerCase() === "portnum");
      if (pi > 0 && tok[pi + 1]) { item.portnum = tok[pi + 1]; const zi = tok.findIndex((x) => x.toLowerCase() === "z0"); if (zi > pi && tok[zi + 1]) item.z0 = tok[zi + 1]; }
    }
    items.push(item);
    for (const n of nodes) nets.add(n);
  }
  return { items, nets: [...nets].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), directives };
}
/** SPICE_GENERATOR::CurrentNames of an item: the exporter's own list (spice-netlist SimItemInfo) when the circuit
 *  carries it, else what the element letter tells (SPICE_GENERATOR_NGSPICE's I(Q1:c), I(M1:d) …; a subcircuit's
 *  pins are unknown from the netlist alone). */
export function currentNames(it: CircuitItem): string[] {
  if (it.currents) return it.currents.slice();
  const k = it.name[0].toUpperCase();
  if (k === "Q") return ["c", "b", "e"].map((p) => `I(${it.name}:${p})`);
  if (k === "M" || k === "J" || k === "Z") return ["d", "g", "s"].map((p) => `I(${it.name}:${p})`);
  if (k === "X") return [];
  return [`I(${it.name})`];
}
export const OPT_SAVE_V = 0x0040, OPT_SAVE_I = 0x0080, OPT_SAVE_P = 0x0100, OPT_SAVE_EVENTS = 0x0800, OPT_FIX_INCLUDES = 0x0010;
/** SIMULATOR_FRAME_UI::rebuildSignalsList: the signals the grid offers for an analysis. */
export function signalsFor(type: SimType, circuit: { items: CircuitItem[]; nets: string[]; directives: string[] }, options: number, userSignals: string[] = [], smith = false): string[] {
  const t = type === "Custom" ? "TRAN" : type, out: string[] = [], seen = new Set<string>();
  // a Smith chart's rows carry no suffix: the trace is the complex reflection coefficient
  const add = (s: string): void => { if (seen.has(s.toUpperCase())) return; seen.add(s.toUpperCase()); if (t === "AC") out.push(s + " (gain)", s + " (phase)"); else if (t === "SP" && !smith) out.push(s + " (amplitude)", s + " (phase)"); else out.push(s); };
  if (options & OPT_SAVE_V && (t === "TRAN" || t === "DC" || t === "AC" || t === "FFT"))
    for (const n of circuit.nets) { if (/^gnd$/i.test(n) || n === "0" || n.startsWith("unconnected-_")) continue; add(`V(${n})`); }
  if (options & OPT_SAVE_I && (t === "TRAN" || t === "DC" || t === "AC")) for (const it of circuit.items) for (const c of currentNames(it)) add(c);
  if (options & OPT_SAVE_P && (t === "TRAN" || t === "DC")) for (const it of circuit.items) if (it.nodes.length >= 2) add(`P(${it.name})`);
  if (t === "NOISE") { add("inoise_spectrum"); add("onoise_spectrum"); }
  if (t === "SP") {
    // the voltage sources with a port number; a Smith chart has only the reflection parameters (S_i_i): the
    // transmission ones are not impedances
    const ports = circuit.items.filter((it) => /^V/.test(it.name) && it.portnum).map((it) => it.portnum!);
    for (const p1 of ports) for (const p2 of ports) { if (smith && p1 !== p2) continue; add(`S_${p1}_${p2}`); }
  }
  for (const d of circuit.directives) { const m = /^\.(save|probe)\s+(.*)$/i.exec(d); if (m) for (const p of m[2].trim().split(/[ \t]+/)) if (p && !/^(all|alli|allp)$/i.test(p)) add(p.toUpperCase()); }
  for (const u of userSignals) if (u.trim()) add(u);
  return out;
}

/** SMITH_MATH::ParseSParamPorts: S-parameter vectors are named S_<responsePort>_<drivePort>. */
export function parseSParamPorts(name: string): { response: number; drive: number } | null {
  const m = /^S_(-?\d+)_(-?\d+)$/.exec(name); return m ? { response: Number(m[1]), drive: Number(m[2]) } : null;
}
/** SIMULATOR_FRAME_UI::getSmithPortImpedance: the z0 of the port an S-parameter is normalized to (its response port),
 *  0 when it has none.  A port without a z0 of its own has ngspice's 50 Ω (the model's default). */
export function smithPortImpedance(circuit: { items: CircuitItem[] }, vector: string): number {
  const ports = parseSParamPorts(vector); if (!ports) return 0;
  for (const it of circuit.items) {
    if (!it.portnum || parseInt(it.portnum, 10) !== ports.response || !/^-?\d+$/.test(it.portnum)) continue;
    const z0 = it.z0 === undefined ? 50 : parseSpiceValue(it.z0);
    if (z0 > 0) return z0;
  }
  return 0;
}

// ---------------------------------------------------------------- vectors and signals
export type TraceKind = "V" | "I" | "P" | "?";
/** SPICE_CIRCUIT_MODEL::VectorToSignal on ngspice's vector names (and the raw file's v(…) / i(…)). */
export function vectorToSignal(vec: string): { signal: string; kind: TraceKind } {
  const dev = /^@(\w*[.\w+]*)\[(\w*)\]$/.exec(vec);
  if (dev) { if (dev[2].toLowerCase().startsWith("i")) return { signal: "I" + dev[2].slice(1) + "(" + dev[1].toUpperCase() + ")", kind: "I" }; return { signal: vec, kind: "?" }; }
  if (/#branch$/i.test(vec)) return { signal: `I(${vec.slice(0, -7)})`, kind: "I" };
  if (/:power$/i.test(vec)) return { signal: `P(${vec.slice(0, -6)})`, kind: "P" };
  const vi = /^([vi])\((.*)\)$/i.exec(vec);
  if (vi) return vi[1].toLowerCase() === "v" ? { signal: `V(${vi[2]})`, kind: "V" } : { signal: `I(${vi[2]})`, kind: "I" };
  return { signal: `V(${vec})`, kind: "V" };
}
/** The ngspice expression a signal plots (vectorNameFromSignalName with the ngspice spellings): V(x) → v(x), P(R1) → r1:power. */
export function signalExpr(signal: string): string {
  const p = /^P\((.*)\)$/i.exec(signal); if (p) return p[1].toLowerCase() + ":power";
  const t = /^I([a-z]?)\((.*)\)$/i.exec(signal); if (t && t[1]) return `@${t[2].toLowerCase()}[i${t[1].toLowerCase()}]`;
  return signal.toLowerCase();
}
/** The suffix a signal row carries: " (gain)", " (phase)", " (amplitude)" or "". */
export function splitSignal(s: string): { base: string; part: "" | "gain" | "phase" | "amplitude" } {
  const m = / \((gain|phase|amplitude)\)$/.exec(s); return m ? { base: s.slice(0, -m[0].length), part: m[1] as "gain" | "phase" | "amplitude" } : { base: s, part: "" };
}
export function signalKind(s: string, type: SimType, noiseSource = ""): TraceKind {
  if (type === "NOISE") return noiseSource.toUpperCase().startsWith("I") ? "I" : "V";
  const c = s.toUpperCase()[0]; return c === "V" ? "V" : c === "I" ? "I" : c === "P" ? "P" : "?";
}
/** The unit a trace's Y axis carries. */
export function unitsOf(kind: TraceKind, part: string, type: SimType): string {
  if (part === "phase") return "°";
  if (part === "gain" || part === "amplitude") return "dB";
  if (type === "NOISE") return kind === "I" ? "A/√Hz" : "V/√Hz";
  return kind === "V" ? "V" : kind === "I" ? "A" : kind === "P" ? "W" : "";
}
/** getXAxisType: what the X axis of an analysis is. */
export function xAxisOf(type: SimType, dcSource = ""): { label: string; units: string; log: boolean } {
  if (type === "AC" || type === "SP" || type === "NOISE" || type === "FFT") return { label: "Frequency", units: "Hz", log: type !== "FFT" };
  if (type === "DC") { const k = dcSource.toUpperCase(); return { label: "Voltage (swept)", units: k.startsWith("I") ? "A" : k.startsWith("R") ? "Ω" : k === "TEMP" ? "°C" : "V", log: false }; }
  return { label: "Time", units: "s", log: false };
}

// ---------------------------------------------------------------- ngspice's ASCII raw file
export interface RawVector { name: string; type: string; re: Float64Array; im: Float64Array | null }
export interface RawPlot { title: string; plotname: string; complex: boolean; vectors: RawVector[] }
/** `write` with filetype=ascii: Title / Plotname / Flags / No. Variables / No. Points / Variables / Values, one or more plots. */
export function parseRaw(text: string): RawPlot[] {
  const plots: RawPlot[] = [], lines = text.split(/\r?\n/); let i = 0;
  while (i < lines.length) {
    let title = "", plotname = "", complex = false, nv = 0, np = 0; const names: [string, string][] = [];
    for (; i < lines.length; i++) {
      const l = lines[i], m = /^([A-Za-z. ]+):\s*(.*)$/.exec(l); if (!m) continue;
      const k = m[1].trim().toLowerCase();
      if (k === "title") title = m[2]; else if (k === "plotname") plotname = m[2]; else if (k === "flags") complex = /complex/i.test(m[2]);
      else if (k === "no. variables") nv = Number(m[2]); else if (k === "no. points") np = Number(m[2]);
      else if (k === "variables") { i++; for (let v = 0; v < nv && i < lines.length; v++, i++) { const p = lines[i].trim().split(/\s+/); names.push([p[1] || "", p[2] || ""]); } i--; }
      else if (k === "values") { i++; break; }
    }
    if (!nv) break;
    const vecs: RawVector[] = names.map(([name, type]) => ({ name, type, re: new Float64Array(np), im: complex ? new Float64Array(np) : null }));
    const nums: string[] = [];
    for (; i < lines.length && nums.length < np * (nv + 1); i++) {
      const l = lines[i].trim(); if (!l) continue;
      if (/^[A-Za-z]+:/.test(l)) break;
      for (const t of l.split(/\s+/)) nums.push(t);
    }
    let k = 0;
    for (let p = 0; p < np; p++) {
      k++;   // the point index
      for (let v = 0; v < nv; v++) { const t = nums[k++] || "0"; if (complex) { const [a, b] = t.split(","); vecs[v].re[p] = Number(a); vecs[v].im![p] = Number(b || 0); } else vecs[v].re[p] = Number(t); }
    }
    plots.push({ title, plotname, complex, vectors: vecs });
  }
  return plots;
}
/** A raw file as `write` makes it, binary (the default filetype) or ASCII: one or more plots.  The binary form is the
 *  one read after a run, as it is several times smaller and quicker for ngspice to write than the text. */
export function readRaw(bytes: Uint8Array): RawPlot[] {
  const plots: RawPlot[] = []; let at = 0;
  const latin = new TextDecoder("latin1");
  while (at < bytes.length) {
    // the header runs to "Binary:\n" or "Values:\n"
    let end = -1, binary = false;
    for (let k = at; k + 7 < bytes.length; k++) {
      if (bytes[k] !== 0x0a && k !== at) continue;
      const s = k === at ? k : k + 1;
      const w = latin.decode(bytes.subarray(s, Math.min(bytes.length, s + 8)));
      if (w === "Binary:\n") { end = s + 8; binary = true; break; }
      if (w.startsWith("Values:")) { end = s; break; }
    }
    if (end < 0) break;
    if (!binary) { plots.push(...parseRaw(latin.decode(bytes.subarray(at)))); break; }
    const head = latin.decode(bytes.subarray(at, end)).split(/\r?\n/);
    let title = "", plotname = "", complex = false, nv = 0, np = 0; const names: [string, string][] = [];
    for (let i = 0; i < head.length; i++) {
      const m = /^([A-Za-z. ]+):\s*(.*)$/.exec(head[i]); if (!m) continue;
      const k = m[1].trim().toLowerCase();
      if (k === "title") title = m[2]; else if (k === "plotname") plotname = m[2]; else if (k === "flags") complex = /complex/i.test(m[2]);
      else if (k === "no. variables") nv = Number(m[2]); else if (k === "no. points") np = Number(m[2]);
      else if (k === "variables") { for (let v = 0; v < nv && i + 1 < head.length; v++) { const p = head[++i].trim().split(/\s+/); names.push([p[1] || "", p[2] || ""]); } }
    }
    if (!nv) break;
    const per = complex ? 16 : 8, size = np * nv * per;
    const view = new DataView(bytes.buffer, bytes.byteOffset + end, Math.min(size, bytes.length - end));
    const vecs: RawVector[] = names.map(([name, type]) => ({ name, type, re: new Float64Array(np), im: complex ? new Float64Array(np) : null }));
    for (let p = 0; p < np; p++) for (let v = 0; v < nv; v++) {
      const o = (p * nv + v) * per; if (o + per > view.byteLength) break;
      vecs[v].re[p] = view.getFloat64(o, true); if (complex) vecs[v].im![p] = view.getFloat64(o + 8, true);
    }
    plots.push({ title, plotname, complex, vectors: vecs });
    at = end + size;
  }
  return plots;
}
/** A raw vector by signal or ngspice name, case-insensitively, under any of its spellings. */
export function findVector(plot: RawPlot, signalOrVec: string): RawVector | null {
  const want = signalOrVec.toLowerCase(), alts = new Set([want, signalExpr(signalOrVec)]);
  const v = /^v\((.*)\)$/.exec(want); if (v) alts.add(v[1]);
  const i = /^i\((.*)\)$/.exec(want); if (i) { alts.add(i[1] + "#branch"); alts.add(`@${i[1]}[i]`); }
  const p = /^p\((.*)\)$/.exec(want); if (p) alts.add(p[1] + ":power");
  for (const vec of plot.vectors) { const n = vec.name.toLowerCase(); if (alts.has(n)) return vec; const s = vectorToSignal(vec.name).signal.toLowerCase(); if (s === want) return vec; }
  return null;
}
/** A complex vector as the AC page plots it: gain in dB (20·log10|x|) or phase in degrees. */
/** MagnitudeToDb (sim_types.h): 20·log10 of the magnitude, NaN where there is no signal (a magnitude of 0 or NaN).
 *  mathplot leaves a non-finite point out of the axis range (mpFiniteRange) and draws a gap there. */
export function magnitudeToDb(m: number): number { return m > 0 ? 20 * Math.log10(m) : NaN; }
export function acPart(vec: RawVector, part: "gain" | "phase" | "amplitude" | ""): Float64Array {
  const n = vec.re.length, out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const re = vec.re[k], im = vec.im ? vec.im[k] : 0;
    if (part === "phase") out[k] = (Math.atan2(im, re) * 180) / Math.PI;
    else if (part === "gain" || part === "amplitude") out[k] = magnitudeToDb(Math.hypot(re, im));
    else out[k] = vec.im ? Math.hypot(re, im) : re;
  }
  return out;
}
/** The value of `ys` at `x` by linear interpolation over the sorted `xs` (CURSOR::Move's lookup). */
export function interpolate(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length; if (!n) return NaN; if (x <= xs[0]) return ys[0]; if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  const t = (x - xs[lo]) / ((xs[hi] - xs[lo]) || 1); return ys[lo] + t * (ys[hi] - ys[lo]);
}

// ---------------------------------------------------------------- measurements
/** UpdateMeasurement: the units a measurement's value carries ("MAX V(x)" → V, "MAX_AT" → s / Hz, INTEG → V.s …). */
export function measurementUnits(text: string, type: SimType): string | null {
  const m = /^ *([a-zA-Z_]+) +([a-zA-Z]*)\(([^)]+)\)/.exec(text); if (!m) return null;
  const fn = m[1].toUpperCase(), st = m[2].toUpperCase();
  let u = st.endsWith("DB") ? "dB" : st.startsWith("I") ? "A" : st.startsWith("P") ? "W" : "V";
  if (fn.endsWith("_AT")) u = type === "AC" || type === "SP" ? "Hz" : "s";
  else if (fn.startsWith("INTEG")) u = type === "TRAN" ? (st.startsWith("P") ? "J" : u + ".s") : type === "AC" || type === "SP" || type === "NOISE" || type === "FFT" ? u + "·Hz" : u + "·?";
  return u;
}
/** The ngspice `meas` line of a measurement row (power signals spell "<dev>:power"). */
export function measCommand(text: string, type: SimType, row: number): string {
  const m = /^ *([a-zA-Z_]+) +([a-zA-Z]*)\(([^)]+)\)/.exec(text); let t = text;
  if (m && m[2].toUpperCase().startsWith("P")) t = m[1].toUpperCase() + " " + m[3] + ":power";
  return `meas ${typeToName(type, true)} meas_result_${row} ${t}`;
}
/** SIGNALS_GRID_TRICKS addMeasurement: "<FN> <signal>", a gain row measured in dB (vdb(…)), a phase row never. */
export function measurementFor(fn: string, signal: string): string | null {
  const { base, part } = splitSignal(signal);
  if (part === "phase") return null;
  let s = base; if ((part === "gain" || part === "amplitude") && /^V\(/i.test(s)) s = "vdb" + s.slice(1);
  return fn + " " + s;
}

// ---------------------------------------------------------------- user-defined signals
/** DIALOG_USER_DEFINED_SIGNALS / SIMULATOR_FRAME_UI::applyUserDefinedSignals: "user<id>" vectors made with `let`. */
export const userVectorName = (id: number): string => `user${id}`;
/** The `let` line a user-defined signal runs: its V(x) / I(x) / P(x) terms in ngspice's spellings. */
export function userSignalLet(id: number, expr: string): string {
  const e = expr.replace(/\bP\(([^)]*)\)/gi, (_m, d: string) => `${d.toLowerCase()}:power`).replace(/\b([VI])\(([^)]*)\)/gi, (_m, k: string, a: string) => `${k.toLowerCase()}(${a})`);
  return `let ${userVectorName(id)} = ${e}`;
}

// ---------------------------------------------------------------- the workbook
export interface WbTrace { trace_type?: number; signal: string; color?: string; view?: number; yScaleView?: number }
export interface WbTab { analysis?: string; commands: string[]; traces?: WbTrace[]; measurements?: { expr: string; format: string }[]; dottedSecondary?: boolean; showGrid?: boolean; legend?: { x: number; y: number }; fixedY1scale?: { min: number; max: number }; fixedY2scale?: { min: number; max: number }; fixedY3scale?: { min: number; max: number }; margins?: { left: number; right: number; top: number; bottom: number }; smithMode?: boolean; smithZoom?: number; smithPanX?: number; smithPanY?: number; smithStashedTraces?: { vector: string; name?: string; base_type?: number }[]; smithStashedCursors?: { id: number; vector: string; base_type?: number; sub_type?: number; frequency?: number }[] }
export interface Workbook { version: number; tabs: WbTab[]; user_defined_signals: string[]; custom_cursors?: number; last_sch_text_sim_command?: string }
/** The options a tab's command lines carry (".save all", ".probe alli", ".probe allp", ".kicad esavenone", ".kicad adjustpaths"). */
export function optionsFromCommands(cmds: string[]): { command: string; options: number } {
  let options = OPT_SAVE_EVENTS; const rest: string[] = [];
  for (const c of cmds) {
    const l = c.trim().toLowerCase();
    if (l === ".kicad adjustpaths") options |= OPT_FIX_INCLUDES; else if (l === ".save all") options |= OPT_SAVE_V; else if (l === ".probe alli") options |= OPT_SAVE_I;
    else if (l === ".probe allp") options |= OPT_SAVE_P; else if (l === ".kicad esavenone") options &= ~OPT_SAVE_EVENTS; else rest.push(c);
  }
  return { command: rest[0] || "", options };
}
export function commandsFromOptions(command: string, options: number): string[] {
  const out = [command];
  if (options & OPT_FIX_INCLUDES) out.push(".kicad adjustpaths");
  if (options & OPT_SAVE_V) out.push(".save all");
  if (options & OPT_SAVE_I) out.push(".probe alli");
  if (options & OPT_SAVE_P) out.push(".probe allp");
  if (!(options & OPT_SAVE_EVENTS)) out.push(".kicad esavenone");
  return out;
}
export const DEFAULT_OPTIONS = OPT_FIX_INCLUDES | OPT_SAVE_V | OPT_SAVE_I | OPT_SAVE_P | OPT_SAVE_EVENTS;

// ---------------------------------------------------------------- the tuner (TUNER_SLIDER)
/** The E-series decades (E24, E48, E96, E192) TUNER_SLIDER snaps to. */
export const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
export function eSeries(n: 24 | 48 | 96 | 192): number[] {
  if (n === 24) return E24;
  const out: number[] = []; for (let i = 0; i < n; i++) out.push(Math.round(Math.pow(10, i / n) * 100) / 100);
  return out;
}
/** The nearest E-series value to `v` (TUNER_SLIDER::onESeries). */
export function snapToSeries(v: number, n: 24 | 48 | 96 | 192): number {
  if (!(v > 0)) return v;
  const dec = Math.pow(10, Math.floor(Math.log10(v))), m = v / dec, s = [...eSeries(n), 10];
  let best = s[0]; for (const x of s) if (Math.abs(x - m) < Math.abs(best - m)) best = x;
  return best * dec;
}
