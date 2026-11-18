// sim/builtin-libs — the SPICE library KiCad installs with its symbols: ${KICAD10_SYMBOL_DIR}/Simulation_SPICE.sp, the
// models behind the Simulation_SPICE symbols' "kicad_builtin_*" subcircuits (generic op-amps, the differential probe,
// the varistor, the dual potentiometer).  The text is the file of the kicad-symbols repository (10.0.8), which is
// licensed CC-BY-SA 4.0 with the KiCad libraries' design exception (gitlab.com/kicad/libraries/kicad-symbols,
// LICENSE.md).  A symbol's Sim.Library names it through any version's symbol directory variable.

/** Where the exporter puts the installed symbol directory (KiCad's Linux install path), as writeInclude expands it. */
export const SYMBOL_DIR = "/usr/share/kicad/symbols";

/** writeInclude: the include path with its environment variables expanded and Windows separators turned around;
 *  the project directory (${KIPRJMOD}) is the netlist's own, so a project file is named relative to it. */
export function expandIncludePath(path: string): string {
  return path.replace(/\\/g, "/")
    .replace(/^\$[{(]KIPRJMOD[})]\/+/, "")
    .replace(/\$[{(]KICAD\d*_SYMBOL_DIR[})]/g, SYMBOL_DIR);
}

const SIMULATION_SPICE_SP = ".subckt kicad_builtin_vdiff in+ in- out\n  Emeas out 0 in+ in- 1\n.ends\n\n.subckt kicad_builtin_varistor A B threshold=1k rdyn=1 rleak=100MEG\n  B1 A B I=( abs( V( A, B ) ) > {threshold} ?  ( abs( V( A, B ) ) - {threshold} ) / {rdyn} * sgn( V( A, B ) ) : 0 )\n  R1 A B {rleak} //Leakage helps with convergence in case of circuit with current sources\n.ends\n\n* Simple generic model for a single-pole OpAmp\n* Parameters are pole frequency, gain, offset, output resistance.\n* The output is limited to the supply voltage.\n* Author Holger Vogt, Public Domain\n.subckt kicad_builtin_opamp in+ in- vcc vee out params: POLE=20 GAIN=20k VOFF=10m ROUT=10\n* add offset voltage\n  Voff in+ inoff dc {VOFF}\n* gain stage with RC pole\n  G10 0 int inoff in- 100u\n  R1 int 0 {GAIN/100u}\n  C1 int 0 {1/(6.28*(GAIN/100u)*POLE)}\n* output decoupling, output resistance\n  Eout 2 0 int 0 1\n  Rout 2 out {ROUT}\n* output limited to vee, vcc\n  Elow lee 0 vee 0 1\n  Ehigh lcc 0 vcc 0 1\n  Dlow lee int Dlimit\n  Dhigh int lcc Dlimit\n  .model Dlimit D N=0.01\n*\n.ends\n\n* Simple generic model for a single-pole dual OpAmp\n* Parameters are pole frequency, gain, offset, output resistance.\n* The output is limited to the supply voltage.\n.subckt kicad_builtin_opamp_dual out1 in1- in1+ vee in2+ in2- out2 vcc params: POLE=20 GAIN=20k VOFF=10m ROUT=10\nX1 in1+ in1- vcc vee out1 kicad_builtin_opamp POLE={POLE} GAIN={GAIN} VOFF={VOFF} ROUT={ROUT}\nX2 in2+ in2- vcc vee out2 kicad_builtin_opamp POLE={POLE} GAIN={GAIN} VOFF={VOFF} ROUT={ROUT}\n.ends\n\n* Simple generic model for a single-pole quad OpAmp\n* Parameters are pole frequency, gain, offset, output resistance.\n* The output is limited to the supply voltage.\n.subckt kicad_builtin_opamp_quad out1 in1- in1+ vcc in2+ in2- out2 out3 in3- in3+ vee in4+ in4- out4 params: POLE=20 GAIN=20k VOFF=10m ROUT=10\nX1 in1+ in1- vcc vee out1 kicad_builtin_opamp POLE={POLE} GAIN={GAIN} VOFF={VOFF} ROUT={ROUT}\nX2 in2+ in2- vcc vee out2 kicad_builtin_opamp POLE={POLE} GAIN={GAIN} VOFF={VOFF} ROUT={ROUT}\nX3 in3+ in3- vcc vee out3 kicad_builtin_opamp POLE={POLE} GAIN={GAIN} VOFF={VOFF} ROUT={ROUT}\nX4 in4+ in4- vcc vee out4 kicad_builtin_opamp POLE={POLE} GAIN={GAIN} VOFF={VOFF} ROUT={ROUT}\n.ends\n\n* Dual Potentiometer model\n* Symbol pins 1 2 3 4 5 6\n.subckt pot_dual r1A wA r0A r1B wB r0B params: Rtot=1k wpos=0.4\nApot1 r0A wA r1A potmod\nApot2 r0B wB r1B potmod\n.model potmod potentiometer(position={wpos} r={Rtot})\n.ends\n";

/** The text of an installed library this editor carries, by its Sim.Library path (any spelling of the symbol
 *  directory); null for anything else. */
export function builtinLibrary(path: string): string | null {
  return expandIncludePath(path) === SYMBOL_DIR + "/Simulation_SPICE.sp" ? SIMULATION_SPICE_SP : null;
}
