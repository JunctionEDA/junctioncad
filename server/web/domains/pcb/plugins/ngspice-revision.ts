// The revision of the simulator's JavaScript face (web/domains/pcb/plugins/ngspice-module.ts): the first 12 hex digits of its
// sha256.  /static/pyodide/ngspice.mjs is cached by browsers for a day (src/pcm.rs runtime()), so the simulator asks
// for it under a query naming the engine's build (vendor/ngspice/build-meta.json) and this revision: a deploy that
// changes either is fetched afresh.  scripts/build-python.mjs refuses to build when this is not ngspice-module.ts's.
export const NGSPICE_MODULE_REVISION = "fcf7f8ebf608";
