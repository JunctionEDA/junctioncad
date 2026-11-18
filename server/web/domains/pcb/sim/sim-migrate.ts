// sim-migrate — SIM_MODEL::MigrateSimModel (eeschema/sim/sim_model.cpp), which SCH_SCREEN::MigrateSimModels runs on
// every symbol when a schematic is loaded: the simulation fields of KiCad 6 and the 7.0 development versions become
// the Sim.* fields of today.  The web exporter reads the files as they are written, so it runs the same migration on
// a symbol's fields before it builds the symbol's model.
//
//   * V7 fields (Sim.Device / Sim.Type / Sim.Pins / Sim.Params): the potentiometer's "+"/"-" pins become r1/r0
//     (before 7.0RC2), random sources' NORMAL becomes GAUSSIAN and min/max/dt are put right (before 8.0RC1), and a
//     MUTUAL inductor becomes a K device (before 8.0.1);
//   * the KiCad 6 fields (Spice_Primitive, Spice_Model, Spice_Node_Sequence, Spice_Lib_File, Spice_Netlist_Enabled):
//     a library model becomes Sim.Library / Sim.Name (and Sim.Params for what followed the name); a passive or a
//     source whose value is its model stays inferred; a source function ("sin(0 1 60)") becomes the source model
//     with its parameters; anything else a raw SPICE model (type="X" model="…" lib="…");
//   * the 7.0 development names (Sim_Type, Sim_Device, Sim_Pins as pin indexes, Sim_Params) take their final names.
//
// The exclude-from-simulation flag of the old Sim.Enable ("0") and Spice_Netlist_Enabled ("N") fields is the
// parser's (SCH_IO_KICAD_SEXPR_PARSER: the field is dropped and the symbol excluded): legacyExcludedFromSim.

import * as S from "../dialogs/sim-model-logic";
import { TYPES } from "../dialogs/sim-model-data";

export interface MigrateField { name: string; value: string }
export interface MigrateContext {
  /** the symbol's reference prefix (SCH_SYMBOL::GetPrefix) */
  prefix: string;
  /** the symbol's pin numbers, every unit (GetGraphicalPins( ALL_UNITS, ALL_BODY_STYLES )) */
  pins: string[];
  /** SIM_LIB_MGR::CreateModel( lib, name, … ): the library model, or null when the library or the model is missing */
  libraryModel(lib: string, name: string): S.SimModel | null;
}

const LEGACY = { PRIMITIVE: "Spice_Primitive", MODEL: "Spice_Model", PINS: "Spice_Node_Sequence", ENABLE: "Spice_Netlist_Enabled", LIBRARY: "Spice_Lib_File" };

/** The parser's handling of Sim.Enable / Spice_Netlist_Enabled: whether they exclude the symbol from simulation
 *  (undefined when neither is there).  Both fields are dropped from the symbol. */
export function legacyExcludedFromSim(fields: MigrateField[]): boolean | undefined {
  let excluded: boolean | undefined;
  for (const f of fields) {
    if (f.name === S.F.ENABLE) excluded = f.value === "0";
    else if (f.name === LEGACY.ENABLE) excluded = f.value === "N";
  }
  return excluded;
}
export const dropLegacyEnable = <R extends MigrateField>(fields: R[]): R[] => fields.filter((f) => f.name !== S.F.ENABLE && f.name !== LEGACY.ENABLE);

/** MigrateSimModel on a symbol's fields; returns the migrated fields (a new list, the symbol's own untouched). */
export function migrateSimModel(input: MigrateField[], ctx: MigrateContext): MigrateField[] {
  const fields = input.map((f) => ({ ...f }));
  const get = (name: string): MigrateField | undefined => fields.find((f) => f.name === name);
  const remove = (f: MigrateField): void => { const i = fields.indexOf(f); if (i >= 0) fields.splice(i, 1); };
  const add = (name: string, value: string): void => { fields.push({ name, value }); };
  const deviceF = get(S.F.DEVICE), subtypeF = get(S.F.TYPE), pinsF = get(S.F.PINS), paramsF = get(S.F.PARAMS);

  if (deviceF || subtypeF || pinsF || paramsF) {
    let subtype = subtypeF ? subtypeF.value.toUpperCase() : "";
    if (subtype === "POT" && pinsF) pinsF.value = pinsF.value.split("=+").join("=r1").split("=-").join("=r0");
    if (subtype.startsWith("RAND") && subtypeF) {
      subtype = subtypeF.value.toUpperCase();
      if (subtype.includes("NORMAL")) subtypeF.value = subtype.split("NORMAL").join("GAUSSIAN");
      if (paramsF) {
        let params = paramsF.value.toLowerCase(); const before = params;
        params = params.split("min=0 ").join("").split("max=0 ").join("").split("dt=").join("ts=");
        if (params !== before) paramsF.value = params;
      }
    }
    if (subtype === "MUTUAL") {
      if (subtypeF) remove(subtypeF);
      if (deviceF) deviceF.value = "K"; else add(S.F.DEVICE, "K");
    }
    return fields;
  }

  // getSIValue: "Meg" spelled "M" (the SI notation's mega), its prefix and suffix kept
  const siValue = (f: MigrateField): string => f.value.replace(/([^a-z])(M)(e|E)(g|G)($|[^a-z])/g, "$1$2$5");
  const sortedPins = ctx.pins.slice().sort((a, b) => S.strNumCmp(a, b, true));
  const defaultPinMap = (): string => sortedPins.map((p, i) => `${p}=${i + 1}`).join(" ");
  const valueF = get("Value");

  let device = "", model = "", lib = "", pinMap = "", subtypeText = "", spiceParams = "";
  let modelFromValueField = false;
  if (get(LEGACY.PRIMITIVE) || get(LEGACY.PINS) || get(LEGACY.MODEL) || get(LEGACY.ENABLE) || get(LEGACY.LIBRARY)) {
    const prim = get(LEGACY.PRIMITIVE); if (prim) { device = prim.value; remove(prim); }
    const seq = get(LEGACY.PINS);
    if (seq) {
      // "{:,; }"-separated symbol pin numbers, in model pin order
      const toks = seq.value.split(/[{:,; }]+/).filter(Boolean);
      pinMap = toks.map((t, i) => `${parseInt(t, 10) || 0}=${i + 1}`).join(" ");
      remove(seq);
    }
    const mf = get(LEGACY.MODEL);
    if (mf) { model = siValue(mf); remove(mf); }
    else if (valueF) { model = siValue(valueF); modelFromValueField = true; }
    const lf = get(LEGACY.LIBRARY); if (lf) { lib = lf.value; remove(lf); }
  } else {
    // names used during 7.0 development
    const t = get("Sim_Type"); if (t) t.name = S.F.TYPE;
    const d = get("Sim_Device"); if (d) d.name = S.F.DEVICE;
    const p = get("Sim_Pins");
    if (p) {
      const passive = /^[RLC]/.test(ctx.prefix);
      const idx = p.value.split(" ");
      if (passive && idx.length === 2 && sortedPins.length === 2) p.value = idx[0] === "2" ? `${sortedPins[0]}=- ${sortedPins[1]}=+` : `${sortedPins[0]}=+ ${sortedPins[1]}=-`;
      else p.value = idx.slice(0, sortedPins.length).map((x, i) => `${sortedPins[i]}=${x}`).join(" ");
      p.name = S.F.PINS;
    }
    const q = get("Sim_Params"); if (q) q.name = S.F.PARAMS;
    return fields;
  }

  device = device.trim(); lib = lib.trim(); model = model.trim();
  let libraryModel = false, inferredModel = false, internalModel = false, modelLineParams = "";
  if (lib !== "") {
    const sp = model.indexOf(" ");
    if (sp >= 0) { modelLineParams = model.slice(sp + 1); model = model.slice(0, sp); }
    const base = ctx.libraryModel(lib, model);
    libraryModel = !!base;
    if (pinMap === "") {
      if (base) { const m = S.createFromBase(base, sortedPins, []); pinMap = S.generatePins(m); }
      if (pinMap === "") pinMap = defaultPinMap();
    }
  } else if (/^[RLCVI]$/.test(device) && ctx.prefix.startsWith(device) && modelFromValueField) {
    inferredModel = true;
  } else if (device === "V" || device === "I") {
    // a SPICE source function, "sin(0 1 60)" or "sin 0 1 60", that a built-in source model takes
    const toks = model.split(/[() ]+/).filter(Boolean);
    if (toks.length) {
      subtypeText = toks[0].toUpperCase();
      const rest = toks.slice(1);
      for (const [type] of TYPES) {
        const si = S.spiceInfo(type);
        if (device !== si.itemType || subtypeText !== si.functionName) continue;
        try {
          const m = S.createModel(type);
          if (subtypeText === "DC" && rest.length === 1) {
            if (valueF) valueF.value = rest[0];
            modelFromValueField = false;
          } else {
            rest.forEach((t, i) => m.setParamValue(i, t, "SPICE"));
            subtypeText = S.typeInfo(type).fieldValue;
            spiceParams = S.generateParams(m);
          }
          internalModel = true;
          if (pinMap === "") { m.createPins(sortedPins); pinMap = S.generatePins(m); }
        } catch { /* a raw SPICE model instead */ }
        break;
      }
    }
  }

  if (libraryModel) {
    add(S.F.LIBRARY, lib); add(S.F.NAME, model);
    if (modelLineParams !== "") add(S.F.PARAMS, modelLineParams);
    if (modelFromValueField && valueF) valueF.value = "${SIM.NAME}";
  } else if (inferredModel) {
    // the device stays in the reference and the model in the value
  } else if (internalModel) {
    add(S.F.DEVICE, device);
    if (subtypeText !== "") add(S.F.TYPE, subtypeText);
    if (spiceParams !== "") add(S.F.PARAMS, spiceParams);
    if (modelFromValueField && valueF) valueF.value = "${SIM.PARAMS}";
  } else {
    // a raw SPICE model stands in: nothing is known of its pins, so they are the symbol's in order
    spiceParams = device === "" && lib === "" ? model : `type="${device}" model="${model}" lib="${lib}"`;
    add(S.F.DEVICE, S.deviceInfo("SPICE").fieldValue);
    add(S.F.PARAMS, spiceParams);
    if (modelFromValueField && valueF) valueF.value = "${SIM.PARAMS}";
    if (pinMap === "") pinMap = defaultPinMap();
  }
  if (pinMap !== "") add(S.F.PINS, pinMap);
  return fields;
}
