// sim/ngspice-wasm — the one thing the simulator's copy of the netlist and of every library it includes needs before
// the WebAssembly ngspice (scripts/ngspice-wasm/build.sh, plugins/spice.ts) reads it: line ends.  A library saved
// with lone carriage returns reads as one line in a file system that does not translate them.  The build is ngspice
// 45.2 with XSPICE, as KiCad bundles it, so POLY sources (spice2poly) and model parameters a device does not have
// ("unrecognized parameter (x) - ignored") read as on the desktop.  The netlist KiCad's exporter writes (Export
// Netlist, Show SPICE Netlist) is left as it is.

/** A netlist or library with "\n" line ends. */
export function forWasmNgspice(text: string, _warn?: (message: string) => void): string {
  return text.replace(/\r\n?/g, "\n");
}
