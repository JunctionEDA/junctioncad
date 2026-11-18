// sim/spice-netlist — NETLIST_EXPORTER_SPICE (eeschema/netlist_exporters/netlist_exporter_spice.cpp), pure.
//
// DoWriteNetlist writes, in order:
//   .title KiCad schematic
//   .include "<path>"            each SPICE library a symbol's Sim.Library names (path order), then raw includes
//   <ModelLine>…                 each enabled item's .model (SPICE_GENERATOR::ModelLine)
//   .save all / .probe alli / .probe p(<item>)…   (Save all voltages / currents / power dissipations; only when there
//                                 are items), then the schematic's directive texts (simulation commands only with
//                                 OPTION_SIM_COMMAND)
//   <ItemLine>…                  each enabled item (name, pin nets, model name, instance parameters)
//   .end
// Net names go through ConvertToSpiceMarkup; an unconnected pin is NC-<n> (one counter for the netlist).  Model names
// KiCad defines with a .model line are made unique with NAME_GENERATOR ("name", "name#1", …).
import * as S from "../dialogs/sim-model-logic";
import { ruleAreasAround } from "./netlist-kicad";
import { expandIncludePath } from "./builtin-libs";
import { dropLegacyEnable, legacyExcludedFromSim, migrateSimModel } from "./sim-migrate";
import { corner, findKibisPin, kibisSubckt, parseKibis, type KibisFile, type KibisWave } from "./kibis";

export const OPTION_SAVE_ALL_VOLTAGES = 0x0040, OPTION_SAVE_ALL_CURRENTS = 0x0080, OPTION_SAVE_ALL_DISSIPATIONS = 0x0100,
  OPTION_CUR_SHEET_AS_ROOT = 0x0200, OPTION_SIM_COMMAND = 0x0400, OPTION_SAVE_ALL_EVENTS = 0x0800;

/** One symbol as the exporter reads it (first unit; pins of every unit, CreatePinList order). */
export interface SpiceSymbol {
  ref: string;
  /** every field: name and shown value (Reference is the instance's) */
  fields: S.FieldLike[];
  /** the symbol's pin numbers and, for each, its net's name ("" when the pin is on no net) */
  pins: { number: string; net: string }[];
  /** a symbol of several units (its library symbol's GetUnitCount() > 1): each placed unit's number and its shown
   *  Sim.Pins and Sim.Decomposition, the unit read first ahead of the others (collectMergedSimPins,
   *  collectUnitPinMaps, getDecomposition) */
  units?: { unit: number; pins: string | null; decomposition: string }[];
  /** every pin number of the library symbol, in all its units and body styles (SCH_SYMBOL::GetGraphicalPins(
   *  ALL_UNITS, ALL_BODY_STYLES), which SIM_MODEL::MigrateSimModel builds a legacy symbol's pin map from) */
  libPins?: string[];
}
export interface SpiceLibraryRef { path: string; lib: S.SpiceLibrary }
export interface SpiceNetlistInput {
  symbols: SpiceSymbol[];
  /** the text of each schematic text / text box not excluded from simulation */
  texts: string[];
  options: number;
  /** a library by its Sim.Library path (as the field holds it); null when it cannot be read */
  library(path: string): S.SpiceLibrary | null;
  report?(message: string, severity: "error" | "warning"): void;
  /** NETLIST_EXPORTER_SPICE_MODEL: the .subckt's name (the project's) and its ports (readHierarchy's ports) */
  subckt?: { name: string; ports: Map<string, SpicePort> };
  /** receives the exporter's items (SPICE_CIRCUIT_MODEL::GetItems) as the simulator reads them */
  items?(list: SimItemInfo[]): void;
}
/** A netlist item as the simulator and the schematic's operating point use it: the symbol's reference, the item's
 *  name (SPICE_GENERATOR::ItemName), its currents (CurrentNames) and its model pins with the symbol pin each takes. */
export interface SimItemInfo {
  ref: string; name: string; enabled: boolean; currents: string[]; pins: { symbolPin: string; modelPin: string }[];
  /** SIM_MODEL::GetTunerParam's value ("" for none) and SPICE_GENERATOR::TunerCommand for a value */
  tunerValue: string; tunerCommand: ((value: number) => string) | null;
  /** a potentiometer: TUNER_SLIDER tunes its wiper from 0 to 1 */
  tunerPot: boolean;
  /** the model's Sim.Device and Sim.Type field values (SIM_MODEL::GetDeviceInfo / GetTypeInfo().fieldValue) */
  device: string; typeField: string;
}
/** A hierarchical label as a .subckt port: its text and LABEL_FLAG_SHAPE. */
export interface SpicePort { name: string; shape: string }
const PORT_DIR: Record<string, string> = { input: "input", output: "output", bidirectional: "inout", tri_state: "tristate", passive: "passive" };

/** NETLIST_EXPORTER_SPICE::ConvertToSpiceMarkup. */
export function convertToSpiceMarkup(netName: string): string {
  const unescape = (s: string): string => s.replace(/\{slash\}/g, "/").replace(/\{backslash\}/g, "\\").replace(/\{lt\}/g, "<").replace(/\{gt\}/g, ">").replace(/\{colon\}/g, ":").replace(/\{dquote\}/g, '"').replace(/\{space\}/g, " ");
  const lastSeg = netName.lastIndexOf("/") >= 0 ? netName.slice(netName.lastIndexOf("/") + 1) : netName;
  const literalSlash = unescape(lastSeg).includes("/");
  let name = unescape(netName);
  // MARKUP_PARSER: ~{x} → "~x", _{x} / ^{x} → "x"
  let out = "", i = 0;
  const walk = (stop: boolean): void => {
    while (i < name.length) {
      const c = name[i];
      if ((c === "~" || c === "_" || c === "^") && name[i + 1] === "{") {
        let depth = 1, j = i + 2;
        while (j < name.length && depth) { if (name[j] === "{") depth++; else if (name[j] === "}") depth--; if (depth) j++; }
        if (j >= name.length) { out += c; i++; continue; }   // unterminated: literal
        if (c === "~") out += "~";
        const inner = name.slice(i + 2, j); const saved = name; const savedI = j + 1;
        name = inner; i = 0; walk(true); name = saved; i = savedI; continue;
      }
      out += c; i++;
    }
    void stop;
  };
  walk(false);
  name = out;
  name = name.replace(/[%(),\[\]<>~ ]/g, "_");
  const localName = name.lastIndexOf("/") >= 0 ? name.slice(name.lastIndexOf("/") + 1) : name;
  if (!literalSlash && (localName === "0" || localName.toLowerCase() === "gnd") && !name.endsWith("//" + localName)) name = localName;
  if (name.startsWith("//")) name = name.split("//").join("/root/");
  return name;
}

const DIRECTIVES = [".AC", ".CONTROL", ".CSPARAM", ".DISTO", ".DC", ".ELSE", ".ELSEIF", ".END", ".ENDC", ".ENDIF", ".ENDS", ".FOUR", ".FUNC", ".GLOBAL", ".IC", ".IF", ".INCLUDE",
  ".LIB", ".MEAS", ".MODEL", ".NODESET", ".NOISE", ".OP", ".OPTIONS", ".PARAM", ".PLOT", ".PRINT", ".PROBE", ".PZ", ".SAVE", ".SENS", ".SP", ".SUBCKT", ".TEMP", ".TF", ".TITLE", ".TRAN", ".WIDTH"];
const SIM_COMMANDS = [".AC", ".DC", ".TRAN", ".OP", ".DISTO", ".NOISE", ".PZ", ".SENS", ".TF"];
const isDir = (line: string, d: string): boolean => line === d || line.startsWith(d + " ");

/** ReadDirectives: the texts that hold a SPICE directive (or a mutual-inductor K line). */
export function readDirectives(texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    let found = false;
    for (const raw of text.split(/[\r\n]+/).filter(Boolean)) {
      const line = raw.toUpperCase();
      if (line.startsWith(".")) { if (DIRECTIVES.some((d) => isDir(line, d))) { found = true; break; } }
      else if (line.startsWith("K")) {
        const t = line.split(/[ \t]+/).filter(Boolean);
        if (t.length < 3 || !t[0].startsWith("K") || !t[1].startsWith("L") || !t[2].startsWith("L")) continue;
        if (t.length > 3) { found = true; break; }
      }
    }
    if (found) out.push(text);
  }
  return out;
}

/** std::sort of wxStrings: code-unit order. */
const byteCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Item { ref: string; model: S.SimModel; modelName: string; baseModelName: string; pinNumbers: string[]; pinNetNames: string[]; multi?: MultiUnit }

// ---------------------------------------------------------------- SIM_MODEL_MULTIUNIT (sim_model_multiunit.cpp)
/** A repeat-per-unit wrapper: a .subckt that instantiates the base subcircuit once per unit. */
interface MultiUnit { signature: string; base: string; pins: { node: string; symbolPin: string }[]; instances: string[][] }
/** ParseSimPinsTokens: "symbolPin=modelPin" pairs, a pin given twice the same way kept once. */
function parseSimPinsTokens(pins: string, ref: string): [string, string][] {
  const out: [string, string][] = [], seen = new Map<string, string>();
  for (const t of pins.split(/[ \t\r\n]+/).filter(Boolean)) {
    const pos = t.indexOf("=");
    if (pos <= 0 || pos === t.length - 1) throw new Error(`Symbol '${ref}' has a malformed Sim.Pins entry '${t}'.`);
    const sp = t.slice(0, pos), mp = t.slice(pos + 1), was = seen.get(sp);
    if (was !== undefined) { if (was !== mp) throw new Error(`Symbol '${ref}' maps pin '${sp}' to both '${was}' and '${mp}'.`); continue; }
    seen.set(sp, mp); out.push([sp, mp]);
  }
  return out;
}
/** encodeIdentifier: ASCII letters and digits as they are, every other UTF-8 byte as _XX. */
function encodeIdentifier(raw: string): string {
  let out = "";
  for (const c of new TextEncoder().encode(raw)) out += (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? String.fromCharCode(c) : "_" + c.toString(16).toUpperCase().padStart(2, "0");
  return out;
}
const muNode = (symbolPin: string): string => "n" + encodeIdentifier(symbolPin);
/** stableHash64: 64-bit FNV-1a of the UTF-8 bytes, as 16 hex digits. */
function stableHash64(text: string): string {
  let h = 14695981039346656037n; const M = (1n << 64n) - 1n;
  for (const c of new TextEncoder().encode(text)) { h ^= BigInt(c); h = (h * 1099511628211n) & M; }
  return h.toString(16).padStart(16, "0");
}
/** SIM_MODEL_MULTIUNIT's constructor: the instances and the wrapper's outer pins, or an error. */
function buildMultiUnit(base: S.SimModel, baseName: string, units: { unit: number; pins: [string, string][] }[], shared: string[]): MultiUnit {
  for (const p of base.params) if (p.info.isSpiceInstanceParam) throw new Error(`Repeat-per-unit decomposition does not support model '${baseName}' because it has subcircuit parameters.`);
  const basePins = base.pins.map((p) => p.name), baseSet = new Set(basePins);
  const sharedSet = new Set<string>();
  for (const sp of shared) { if (!baseSet.has(sp)) throw new Error(`Shared pin '${sp}' is not a pin of model '${baseName}'.`); sharedSet.add(sp); }
  const infos = units.map((u) => {
    const m = new Map<string, string>();
    for (const [sym, mp] of u.pins) {
      if (!baseSet.has(mp)) throw new Error(`Unit ${u.unit} maps to unknown pin '${mp}' of model '${baseName}'.`);
      const was = m.get(mp); if (was !== undefined && was !== sym) throw new Error(`Unit ${u.unit} maps model pin '${mp}' to both symbol pins '${was}' and '${sym}'.`);
      if (was === undefined) m.set(mp, sym);
    }
    return { unit: u.unit, m };
  });
  const nonShared = (u: { m: Map<string, string> }): boolean => [...u.m.keys()].some((k) => !sharedSet.has(k));
  const sharedNode = new Map<string, string>();
  for (const sp of shared) {
    const syms = new Set<string>(); for (const u of infos) { const x = u.m.get(sp); if (x !== undefined) syms.add(x); }
    if (!syms.size) throw new Error(`Shared pin '${sp}' is not connected on any unit.`);
    if (syms.size > 1) throw new Error(`Shared pin '${sp}' resolves to more than one net.`);
    sharedNode.set(sp, muNode([...syms][0]));
  }
  for (const bp of basePins) if (!sharedSet.has(bp) && !infos.some((u) => u.m.has(bp))) throw new Error(`Model '${baseName}' pin '${bp}' is neither shared nor assigned to any unit.`);
  const instances: string[][] = [];
  for (const u of infos) {
    if (!nonShared(u)) continue;
    instances.push(basePins.map((bp) => (sharedSet.has(bp) ? (sharedNode.get(bp) as string) : u.m.has(bp) ? muNode(u.m.get(bp) as string) : `nc_${instances.length}_${encodeIdentifier(bp)}`)));
  }
  if (!instances.length) throw new Error("Repeat-per-unit decomposition produced no instances.");
  const pins: { node: string; symbolPin: string }[] = [], added = new Set<string>();
  const add = (node: string, sym: string): void => { if (!added.has(node)) { added.add(node); pins.push({ node, symbolPin: sym }); } };
  for (const u of infos) { if (!nonShared(u)) continue; for (const bp of basePins) { if (sharedSet.has(bp)) continue; const x = u.m.get(bp); if (x !== undefined) add(muNode(x), x); } }
  for (const bp of basePins) { if (!sharedSet.has(bp)) continue; for (const u of infos) { const x = u.m.get(bp); if (x !== undefined) { add(sharedNode.get(bp) as string, x); break; } } }
  const canon = baseName + "|" + pins.map((p) => p.node + ",").join("") + "|" + instances.map((i) => i.map((n) => n + ",").join("") + ";").join("");
  return { signature: `kicad_mu_${encodeIdentifier(baseName)}_${instances.length}u_${stableHash64(canon)}`, base: baseName, pins, instances };
}
/** NETLIST_EXPORTER_SPICE::getNodePattern / readNodePattern: Sim.NodesFormat's pattern for each pin ("%vd(? ?)",
 *  "[? ? ?]"), each pin's net put in for its "?". */
function nodePatterns(format: string): string[] {
  const out: string[] = []; let cur = "";
  for (const c of format) {
    if (/[\s()]/.test(c)) continue;
    if (c === "]") { if (out.length) out[out.length - 1] += c; else cur += c; continue; }
    cur += c; if (c === "?") { out.push(cur); cur = ""; }
  }
  return out;
}

/** The SPICE netlist text. */
export function spiceNetlist(inp: SpiceNetlistInput): string {
  const report = inp.report || (() => {});
  const items: Item[] = []; const libsUsed = new Set<string>(); const names = new Set<string>();
  const generate = (proposed: string): string => { let name = proposed, ii = 1; while (names.has(name)) name = `${proposed}#${ii++}`; names.add(name); return name; };
  let nc = 1;
  const kibisFiles = new Map<string, KibisFile>(), ibisCode = new Map<string, string>();
  for (const sym of inp.symbols) {
    const pinNumbers = sym.pins.map((p) => p.number);
    // SCH_SCREEN::MigrateSimModels: the simulation fields of older files, as KiCad migrates them on load
    let rows = migrateSimModel(dropLegacyEnable(sym.fields), { prefix: sym.ref.replace(/[^A-Za-z].*$/, ""), pins: sym.libPins || pinNumbers, libraryModel: (lib, name) => {
      const l = inp.library(lib); if (!l) return null;
      const lm = l.models.find((m) => m.name === name) || l.models.find((m) => m.name.toLowerCase() === name.toLowerCase());
      return lm ? lm.model : null;
    } });
    // Sim.Decomposition (getDecomposition: the unit read first, else any other): the whole device by default, its
    // units' Sim.Pins merged into one (collectMergedSimPins); "mode=repeat" a wrapper with one instance per unit
    const units = sym.units && sym.units.length ? sym.units : null;
    const deco = S.parseDecomposition(units ? units[0].decomposition || (units.find((u) => u.decomposition) || { decomposition: "" }).decomposition : "");
    const repeat = deco.repeat && !!units;
    if (units && !repeat) {
      const merged: string[] = [], seenPins = new Set<string>();
      for (const u of units) for (const t of (u.pins || "").split(/[ \t\r\n]+/).filter(Boolean)) {
        const pos = t.indexOf("="); if (pos < 0) continue;
        if (!seenPins.has(t.slice(0, pos))) { seenPins.add(t.slice(0, pos)); merged.push(t); }
      }
      if (merged.length) { const f = rows.find((r) => r.name === S.F.PINS); if (f) f.value = merged.join(" "); else rows.push({ name: S.F.PINS, value: merged.join(" ") }); }
    }
    // SIM_LIB_MGR::CreateModel: InferSimModel runs on every symbol (with the inference pins, the symbol's pin
    // numbers in std::sort order); RLC and VI models it infers write Sim.Device, Sim.Type (when it has one),
    // Sim.Params and Sim.Pins over the fields (getOrCreateField) and are stored in the value
    let storeInValue = false;
    const inf = S.inferSimModel(sym.ref.replace(/[^A-Za-z].*$/, ""), pinNumbers.slice().sort(byteCmp), rows);
    if (inf.ok) {
      const put = (name: string, value: string): void => { const f = rows.find((r) => r.name === name); if (f) f.value = value; else rows.push({ name, value }); };
      put(S.F.DEVICE, inf.deviceType);
      if (inf.modelType) put(S.F.TYPE, inf.modelType);
      put(S.F.PARAMS, inf.params); put(S.F.PINS, inf.pinMap);
      storeInValue = true;
    }
    let model: S.SimModel, baseModelName = "";
    const libPath = S.getFieldValue(rows, S.F.LIBRARY);
    if (libPath) {
      const lib = inp.library(libPath);
      if (!lib) { report(`Simulation model library not found at '${libPath}'`, "error"); continue; }
      const name = S.getFieldValue(rows, S.F.NAME);
      const lm = lib.models.find((m) => m.name === name) || lib.models.find((m) => m.name.toLowerCase() === name.toLowerCase());
      if (!lm) { report(`No model named '${name}' in library.`, "error"); continue; }
      model = S.createFromBase(lm.model, pinNumbers, rows); baseModelName = lm.name;
      if (lib.ibis) {
        // SIM_MODEL_IBIS::GetSpiceIncludes / SPICE_GENERATOR_IBIS::IbisDevice: KIBIS writes the pin's subcircuit,
        // named after the item (SPICE_GENERATOR_IBIS::ModelName "<ref>.<component>"), where KiCad includes it from
        // its cache file
        let kf = kibisFiles.get(libPath); if (!kf) { kf = parseKibis(lib.text || ""); kibisFiles.set(libPath, kf); }
        const kp = findKibisPin(kf, lm.name, S.getFieldValue(rows, S.F.IBIS_PIN), S.getFieldValue(rows, S.F.IBIS_MODEL));
        const modelName = `${sym.ref}.${lm.name}`;
        if (typeof kp === "string") report(kp, "error");
        else {
          const pv = (n: string): string => { const q = model.findParam(n); return q ? q.value : ""; };
          const num = (n: string, d: number): number => { const v = S.toDouble(pv(n), d); return Number.isFinite(v) ? v : d; };
          const int = (n: string, d: number): number => { const v = parseInt(pv(n), 10); return Number.isFinite(v) ? v : d; };
          const params = { supply: corner(pv("vcc")), rpin: corner(pv("rpin")), lpin: corner(pv("lpin")), cpin: corner(pv("cpin")), ccomp: corner("") };
          const dc = pv("dc");
          const wave: KibisWave = model.type === "KIBIS_DRIVER_RECT" ? { kind: "rect", ton: num("ton", 0), toff: num("toff", 0), delay: num("td", 0), cycles: int("n", 1) }
            : model.type === "KIBIS_DRIVER_PRBS" ? { kind: "prbs", bitrate: num("f0", 0), delay: num("td", 0), bits: Math.abs(int("n", 0)) }
            : dc === "hi-Z" ? { kind: "high_z" } : dc === "low" ? { kind: "stuck_low" } : dc === "high" ? { kind: "stuck_high" } : { kind: "none" };
          const code = kibisSubckt(kp, modelName, params, model.type === "KIBIS_DEVICE" ? "device" : "driver", wave, S.getFieldValue(rows, S.F.IBIS_DIFF) === "1",
            (m, sev) => { if (sev !== "info") report(m, sev === "error" ? "error" : "warning"); });
          if (code !== null) ibisCode.set(sym.ref, code);
        }
        model.storedInValue = storeInValue;
        const ports = inp.subckt ? inp.subckt.ports : null;
        const pinNetNames = sym.pins.map((p) => { const n = convertToSpiceMarkup(ports && ports.has(p.net) ? (ports.get(p.net) as SpicePort).name : p.net); return n === "" ? `NC-${nc++}` : n; });
        items.push({ ref: sym.ref, model, modelName, baseModelName, pinNumbers, pinNetNames });
        continue;
      }
      libsUsed.add(libPath);
    } else {
      const r = S.createFromFields(rows, pinNumbers); model = r.model;
      if (r.error) report(r.error, "error");
    }
    model.storedInValue = storeInValue;
    let multi: MultiUnit | undefined;
    if (repeat && units) {
      // the wrapper instantiates the base as a subcircuit, so it takes only a named subcircuit model
      if (model.type !== "SUBCKT" || model.fallback || baseModelName === "") { report(`Symbol '${sym.ref}' uses repeat-per-unit decomposition, which requires a named subcircuit model.`, "error"); continue; }
      try {
        const seenUnits = new Set<number>(), maps: { unit: number; pins: [string, string][] }[] = [];
        for (const u of units) { if (u.pins === null || seenUnits.has(u.unit)) continue; seenUnits.add(u.unit); const pp = parseSimPinsTokens(u.pins, sym.ref); if (pp.length) maps.push({ unit: u.unit, pins: pp }); }
        maps.sort((a, b) => a.unit - b.unit);
        multi = buildMultiUnit(model, baseModelName, maps, deco.shared);
      } catch (e) { report((e as Error).message, "error"); continue; }
    }
    // GenerateItemPinNetName (the model exporter names a port's net after the port first)
    const ports = inp.subckt ? inp.subckt.ports : null;
    const pinNetNames = sym.pins.map((p) => { const n = convertToSpiceMarkup(ports && ports.has(p.net) ? (ports.get(p.net) as SpicePort).name : p.net); return n === "" ? `NC-${nc++}` : n; });
    // readNodePattern: Sim.NodesFormat around each pin's net (XSPICE's "%vd(? ?)", "[? ?]")
    const nodesFormat = S.getFieldValue(sym.fields, "Sim.NodesFormat");
    if (nodesFormat) {
      const pats = nodePatterns(nodesFormat);
      if (pats.length && pats.length !== pinNetNames.length) { report(`Error in parsing model '${sym.ref}', wrong number of nodes '?' in Sim.NodesFormat compared to connections`, "error"); continue; }
      pats.forEach((pt, i) => { pinNetNames[i] = pt.replace("?", ` ${pinNetNames[i]} `); });
    }
    if (multi) { items.push({ ref: sym.ref, model, modelName: multi.signature, baseModelName: multi.signature, pinNumbers, pinNetNames, multi }); continue; }
    const probe: S.SpiceItem = { refName: sym.ref, modelName: "", baseModelName, pinNumbers, pinNetNames };
    // SPICE_GENERATOR::ModelName, uniquified only for names KiCad itself defines with a .model line
    const proposed = baseModelName === "" ? `__${sym.ref}` : `${sym.ref}.${baseModelName}`;
    const needsLine = S.modelLine(model, { ...probe, modelName: proposed }) !== "";
    const modelName = baseModelName === "" ? generate(proposed) : needsLine ? generate(proposed) : baseModelName;
    items.push({ ref: sym.ref, model, modelName, baseModelName, pinNumbers, pinNetNames });
  }
  const spiceItem = (it: Item): S.SpiceItem => ({ refName: it.ref, modelName: it.modelName, baseModelName: it.baseModelName, pinNumbers: it.pinNumbers, pinNetNames: it.pinNetNames });
  // SPICE_GENERATOR_MULTIUNIT: the wrapper's item ("X…" on its outer pins) and its .subckt, written once
  const muName = (it: Item): string => (it.ref.startsWith("X") ? it.ref : "X" + it.ref);
  const muCurrents = (it: Item, mu: MultiUnit): string[] => (mu.pins.length === 2 ? [`I(${muName(it)})`] : mu.pins.map((p) => `I(${muName(it)}:${p.node})`));
  const muModelLine = (mu: MultiUnit): string => `.subckt ${mu.signature}${mu.pins.map((p) => " " + p.node).join("")}\n` + mu.instances.map((ins, i) => `X${i + 1}${ins.map((n) => " " + n).join("")} ${mu.base}\n`).join("") + ".ends\n";
  const muItemLine = (it: Item, mu: MultiUnit): string => {
    let out = muName(it), ncN = 0;
    for (const p of mu.pins) { const k = it.pinNumbers.indexOf(p.symbolPin); out += k < 0 ? ` NC-${it.ref}-${ncN++}` : ` ${it.pinNetNames[k]}`; }
    return out + ` ${mu.signature}\n`;
  };
  const modelLineOf = (it: Item, emitted: Set<string>): string => (it.multi ? (emitted.has(it.multi.signature) ? "" : (emitted.add(it.multi.signature), muModelLine(it.multi))) : S.modelLine(it.model, spiceItem(it)));
  const itemLineOf = (it: Item): string => (it.multi ? muItemLine(it, it.multi) : S.itemLine(it.model, spiceItem(it)));
  if (inp.items) inp.items(items.map((it) => ({ ref: it.ref, name: it.multi ? muName(it) : S.itemName(it.model, spiceItem(it)), enabled: it.model.enabled, currents: it.multi ? muCurrents(it, it.multi) : S.currentNames(it.model, spiceItem(it)),
    pins: it.multi ? it.multi.pins.map((p) => ({ symbolPin: p.symbolPin, modelPin: p.node })) : it.model.pins.map((p) => ({ symbolPin: p.symbolPinNumber, modelPin: p.name })),
    tunerValue: S.tunerParam(it.model)?.value || "", tunerCommand: S.tunerParam(it.model) ? (v: number) => S.tunerCommand(it.model, spiceItem(it), v) : null, tunerPot: it.model.cls === "r_pot",
    device: S.deviceInfo(it.model.deviceType).fieldValue, typeField: S.typeInfo(it.model.type).fieldValue })));
  const directives = readDirectives(inp.texts);
  let out = ".title KiCad schematic\n";
  if (inp.subckt) {
    // NETLIST_EXPORTER_SPICE_MODEL::WriteHead
    out = `*\n\n.subckt ${inp.subckt.name}\n`;
    for (const [, port] of [...inp.subckt.ports.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) out += `+       ${port.name} ; ${PORT_DIR[port.shape] || "passive"}\n`;
    out += "\n\n";
  }
  // writeIncludes: the libraries by path (std::map order), each through writeInclude's expansion
  for (const p of [...libsUsed].sort()) out += `.include "${expandIncludePath(p)}"\n`;
  // SIM_MODEL_RAW_SPICE::GetSpiceIncludes: a raw model's lib= (m_rawIncludes, a std::set), after the libraries
  const rawIncludes = new Set<string>();
  for (const it of items) if (it.model.cls === "rawspice") { const lp = it.model.findParam("lib"); if (lp && lp.value !== "") rawIncludes.add(lp.value); }
  for (const p of [...rawIncludes].sort()) out += `.include "${expandIncludePath(p)}"\n`;
  // the IBIS pins' subcircuits, where KiCad includes "<ref>.cache" (the same set, by reference)
  for (const ref of [...ibisCode.keys()].sort()) out += `* IBIS model of ${ref} (KiCad's ${ref}.cache)\n` + ibisCode.get(ref) + "\n";
  const emitted = new Set<string>();
  for (const it of items) if (it.model.enabled) out += modelLineOf(it, emitted);
  if (items.length) {
    if (inp.options & OPTION_SAVE_ALL_VOLTAGES) out += ".save all\n";
    if (inp.options & OPTION_SAVE_ALL_CURRENTS) out += ".probe alli\n";
    if (inp.options & OPTION_SAVE_ALL_DISSIPATIONS) for (const it of items) {
      const nm = S.itemName(it.model, spiceItem(it));
      if (it.model.pins.length >= 2 && nm.length > 0 && nm[0] !== "A") out += `.probe p(${nm})\n`;
    }
    for (const d of directives) {
      const sim = d.startsWith(".") && SIM_COMMANDS.some((c) => isDir(d.toUpperCase(), c));
      if (!sim || (inp.options & OPTION_SIM_COMMAND)) out += d + "\n";
    }
  }
  for (const it of items) if (it.model.enabled) out += itemLineOf(it);
  out += inp.subckt ? "\n.ends\n" : ".end\n";
  return out;
}

// ---------------------------------------------------------------- the hierarchy as the exporter reads it
type N = SNode;
const isList = Array.isArray;
const kidOf = (n: N | null | undefined, key: string): N | null => { if (!n) return null; for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && c[0] === key) return c as N; } return null; };
const kidsOf = (n: N | null | undefined, key: string): N[] => (n ? (n.filter((c) => isList(c) && c[0] === key) as N[]) : []);
const sv = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const yesOf = (n: N, key: string, dflt: boolean): boolean => { const k = kidOf(n, key); return k ? (k.length < 2 || /^(yes|true)$/.test(sv(k[1]))) : dflt; };

export interface HierarchySheet {
  index: number; uuidPath: string[]; doc: KDoc;
  /** the (sheet …) that instantiates this sheet, in its parent's file (null / absent for the root) */
  sheetNode?: N | null;
  /** the parent file's (version …): the variant in_bom meaning of the sheet symbol */
  parentVersion?: number;
}
export interface HierarchyNetMember { inst: number; id: string; kind: string; pin?: string }
export interface HierarchyInput {
  sheets: HierarchySheet[];
  /** the net map of the hierarchy (pcb-netlist buildNetlist().netMap) */
  netMap: Map<string, { name: string; bus: boolean; members: HierarchyNetMember[] }>;
  symbolPins(doc: KDoc, item: KItem): { number: string }[];
  isPower(doc: KDoc, item: KItem): boolean;
  project?: string;
  /** the current variant (field values and exclude-from-simulation through it) */
  variant?: string;
  /** the project's text variables (.kicad_pro text_variables), for the fields' GetShownText */
  textVars?: Record<string, string>;
}

/** StrNumCmp, case-insensitive (CreatePinList's pin order). */
function strNumCmpI(a: string, b: string): number { return S.strNumCmp(a, b, true); }

/** ReadSchematicAndLibraries' walk: each sheet instance, its symbols by uuid, the first unit of each reference with
 *  the pins of all its units (CreatePinList: by number, duplicates dropped), net names from the net map; and the
 *  texts for ReadDirectives. */
export function readHierarchy(h: HierarchyInput): { symbols: SpiceSymbol[]; texts: string[]; ports: Map<string, SpicePort> } {
  const netOf = new Map<string, string>(), labelNet = new Map<string, string>();
  for (const e of h.netMap.values()) {
    if (e.bus) continue;
    for (const m of e.members) {
      if (m.kind === "pin" && m.pin !== undefined) netOf.set(`${m.inst}|${m.id}|${m.pin}`, e.name);
      else if (m.kind === "hierarchical_label") labelNet.set(`${m.inst}|${m.id}`, e.name);
    }
  }
  // NETLIST_EXPORTER_SPICE_MODEL::readPorts: each hierarchical label of the exported sheets, by its net (first wins)
  const ports = new Map<string, SpicePort>();
  for (const sh of h.sheets) for (const it of sh.doc.items.values()) {
    if (it.kind !== "hierarchical_label") continue;
    const net = labelNet.get(`${sh.index}|${it.id}`); if (net === undefined || ports.has(net)) continue;
    ports.set(net, { name: sv(it.node[1]), shape: sv((kidOf(it.node, "shape") || [])[1]) || "input" });
  }
  const symbols: SpiceSymbol[] = [], texts: string[] = [], seen = new Set<string>();
  // a root file older than 20221002 keeps the references, units and values in its (symbol_instances …)
  const rootSheet = h.sheets.find((x) => x.uuidPath.length === 1);
  const legacy = rootSheet ? rootSheet.doc.legacySymbolInstances : undefined;
  const legacyOf = (n: N, path: string) => (legacy ? legacy.get("/" + [...path.split("/").filter(Boolean).slice(1), sv((kidOf(n, "uuid") || [])[1])].join("/")) : undefined);
  const refOf = (n: N, path: string): string => {
    let ref = sv((kidsOf(n, "property").find((p) => sv(p[1]) === "Reference") || [])[2]);
    const old = legacyOf(n, path); if (old && old.reference) ref = old.reference;
    for (const pr of kidsOf(kidOf(n, "instances"), "project")) for (const p of kidsOf(pr, "path")) if (sv(p[1]) === path) { const r = kidOf(p, "reference"); if (r) ref = sv(r[1]); }
    return ref;
  };
  const viewOf = (n: N, path: string, ver?: number): N => (h.variant ? symbolViewForVariantAny(n, h.variant, path, ver) : n);
  // BuildSheetList: a sheet path any of whose sheets is excluded from simulation (for the current variant, on the
  // instance it is placed on) is not exported
  const excludedSheet = (sh: HierarchySheet): boolean => h.sheets.some((a) => a.sheetNode && a.uuidPath.length <= sh.uuidPath.length && a.uuidPath.every((u, i) => sh.uuidPath[i] === u)
    && yesOf(viewOf(a.sheetNode, "/" + a.uuidPath.slice(0, -1).join("/"), a.parentVersion), "exclude_from_sim", false));
  const sheets = h.sheets.filter((sh) => !excludedSheet(sh));
  // GetShownText( &sheet, FOR_NETNAME, variant ) of a field: the symbol's fields, ${REFERENCE} / ${UNIT}, the sheet's
  // fields, the project's text variables and ${REF:FIELD} cross-references (a name nothing defines stays as written)
  const crossRef = (ref: string, field: string, depth: number): string | undefined => {
    for (const s2 of sheets) {
      const p2 = "/" + s2.uuidPath.join("/");
      for (const u of s2.doc.items.values()) {
        if (u.kind !== "symbol" || refOf(u.node, p2) !== ref) continue;
        return fieldShown(viewOf(u.node, p2, s2.doc.version), ref, s2, field, depth + 1);
      }
    }
    return undefined;
  };
  const fieldShown = (node: N, ref: string, sh: HierarchySheet, field: string, depth: number): string | undefined => {
    const up = field.toUpperCase();
    if (up === "REFERENCE") return ref;
    const p = kidsOf(node, "property").find((q) => sv(q[1]).toUpperCase() === up);
    return p ? resolveText(node, ref, sh, sv(p[2]), depth) : undefined;
  };
  const resolveText = (node: N, ref: string, sh: HierarchySheet, text: string, depth: number): string => {
    if (depth > 10 || text.indexOf("${") < 0) return text;
    const tv = h.textVars || {};
    return text.replace(/\$\{([^}]+)\}/g, (m, name: string) => {
      const up = name.toUpperCase();
      let v: string | undefined;
      if (up === "UNIT") v = "";
      const colon = name.indexOf(":");
      if (v === undefined && colon > 0) v = crossRef(name.slice(0, colon), name.slice(colon + 1), depth);
      if (v === undefined && colon < 0) v = fieldShown(node, ref, sh, name, depth + 1);
      if (v === undefined && sh.sheetNode && colon < 0) { const q = kidsOf(sh.sheetNode, "property").find((x) => sv(x[1]).toUpperCase() === up); if (q) v = sv(q[2]); }
      if (v === undefined && Object.prototype.hasOwnProperty.call(tv, name)) v = tv[name];
      return v === undefined ? m : resolveText(node, ref, sh, v, depth + 1);
    });
  };
  for (const sh of sheets) {
    const path = "/" + sh.uuidPath.join("/");
    const items = [...sh.doc.items.values()];
    for (const it of items) {
      if ((it.kind === "text" || it.kind === "text_box") && !yesOf(it.node, "exclude_from_sim", false)) texts.push(sv(it.node[1]));
    }
    const syms = items.filter((it) => it.kind === "symbol").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const it of syms) {
      if (h.isPower(sh.doc, it)) continue;
      const ref = refOf(it.node, path);
      if (!ref || ref.startsWith("#") || seen.has(ref)) continue;
      const node = viewOf(it.node, path, sh.doc.version);
      // ResolveExcludedFromSim: the symbol's own flag, or a rule area around it excluded from simulation
      if (yesOf(node, "exclude_from_sim", false)) continue;
      // the parser's legacy Sim.Enable "0" / Spice_Netlist_Enabled "N"
      if (legacyExcludedFromSim(kidsOf(node, "property").map((p) => ({ name: sv(p[1]), value: sv(p[2]) })))) continue;
      if (ruleAreasAround(sh.doc, it).some((ra) => yesOf(ra.node, "exclude_from_sim", false))) continue;
      seen.add(ref);
      // every unit of the reference on every sheet instance
      const pins: { number: string; net: string }[] = []; const have = new Set<string>();
      for (const s2 of sheets) {
        const p2 = "/" + s2.uuidPath.join("/");
        for (const u of s2.doc.items.values()) {
          if (u.kind !== "symbol" || refOf(u.node, p2) !== ref) continue;
          for (const p of h.symbolPins(s2.doc, u)) { if (have.has(p.number)) continue; have.add(p.number); pins.push({ number: p.number, net: netOf.get(`${s2.index}|${u.id}|${p.number}`) || "" }); }
        }
      }
      pins.sort((a, b) => strNumCmpI(a.number, b.number));
      // a symbol of several units: each placed unit's Sim.Pins and Sim.Decomposition, this one first
      let units: SpiceSymbol["units"];
      if (unitCountOf(sh.doc, it.node) > 1) {
        units = [];
        const unitOf = (n: N, p2: string): number => {
          for (const pr of kidsOf(kidOf(n, "instances"), "project")) for (const q of kidsOf(pr, "path")) if (sv(q[1]) === p2) { const u = kidOf(q, "unit"); if (u) return Number(sv(u[1])) || 1; }
          const old = legacyOf(n, p2); if (old) return old.unit;
          return Number(sv((kidOf(n, "unit") || [])[1])) || 1;
        };
        const unitFields = (n: N, s2: HierarchySheet, p2: string): { unit: number; pins: string | null; decomposition: string } => {
          const v = viewOf(n, p2, s2.doc.version), prop = (name: string) => kidsOf(v, "property").find((q) => sv(q[1]) === name);
          const pp = prop(S.F.PINS), dp = prop("Sim.Decomposition");
          return { unit: unitOf(n, p2), pins: pp ? resolveText(v, ref, s2, sv(pp[2]), 0) : null, decomposition: dp ? resolveText(v, ref, s2, sv(dp[2]), 0) : "" };
        };
        units.push(unitFields(it.node, sh, path));
        for (const s2 of sheets) {
          const p2 = "/" + s2.uuidPath.join("/");
          for (const u of s2.doc.items.values()) if (u.kind === "symbol" && !(u === it && s2 === sh) && refOf(u.node, p2) === ref) units.push(unitFields(u.node, s2, p2));
        }
      }
      const old = legacyOf(it.node, path);
      const fields: S.FieldLike[] = kidsOf(node, "property").map((p) => ({ name: sv(p[1]), value: sv(p[1]) === "Reference" ? ref : sv(p[1]) === "Value" && old && old.value ? old.value : resolveText(node, ref, sh, sv(p[2]), 0) }));
      const libPins = libPinsOf(sh.doc, it.node);
      symbols.push(units ? { ref, fields, pins, units, libPins } : { ref, fields, pins, libPins });
    }
  }
  return { symbols, texts, ports };
}
/** SCH_SYMBOL::GetGraphicalPins( ALL_UNITS, ALL_BODY_STYLES ): the pin numbers of every unit and body style of a
 *  placed symbol's library symbol, in the library's order (a pin drawn in both body styles is there twice). */
function libPinsOf(doc: KDoc, node: N): string[] | undefined {
  const name = sv((kidOf(node, "lib_name") || [])[1]) || sv((kidOf(node, "lib_id") || [])[1]);
  const lib = doc.lib.get(name) || doc.lib.get(sv((kidOf(node, "lib_id") || [])[1]));
  if (!lib) return undefined;
  const out: string[] = [];
  for (const p of kidsOf(lib as N, "pin")) out.push(sv((kidOf(p, "number") || [])[1]));
  for (const sub of kidsOf(lib as N, "symbol")) for (const p of kidsOf(sub, "pin")) out.push(sv((kidOf(p, "number") || [])[1]));
  return out;
}
/** LIB_SYMBOL::GetUnitCount of a placed symbol's library symbol (its "<name>_<unit>_<style>" children). */
function unitCountOf(doc: KDoc, node: N): number {
  const name = sv((kidOf(node, "lib_name") || [])[1]) || sv((kidOf(node, "lib_id") || [])[1]);
  const lib = doc.lib.get(name) || doc.lib.get(sv((kidOf(node, "lib_id") || [])[1]));
  let n = 1;
  for (const sub of kidsOf(lib as N, "symbol")) { const m = /_(\d+)_(\d+)$/.exec(sv(sub[1])); if (m) n = Math.max(n, Number(m[1])); }
  return n;
}
let symbolViewForVariantAny: (n: N, v: string, path: string, ver?: number) => N = (n) => n;
/** The variant view the reader uses (canvas/variant-model symbolViewForVariant), set by the caller's bundle. */
export function setVariantView(fn: (n: N, v: string, path: string, ver?: number) => N): void { symbolViewForVariantAny = fn; }
