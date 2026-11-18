// Prepended to emscripten's module (build.sh --pre-js).  ngspice's interactive prompt reads its commands from stdin,
// a terminal: emscripten asks window.prompt() for each line, which ends here in Module.getInput
// (web/domains/pcb/plugins/ngspice-module.ts).  A worker and node have no window: one is made for them, so the module runs the
// same way everywhere.  Before each command ngspice gives way to the page (control.c, eesim_sleep_hack:
// Module.handleThings).  The hooks are EEcircuit-Engine's (MIT).
if (typeof globalThis !== "undefined") {
  if (!globalThis.window) globalThis.window = {};
  globalThis.window.prompt = function () { return Module["getInput"] ? Module["getInput"]() : null; };
}
Module["setGetInput"] = function (f) { Module["getInput"] = f; };
Module["setHandleThings"] = function (f) { Module["handleThings"] = f; };
Module["runThings"] = function () {
  Module["calledRun"] = false;
  if (Module["callMain"]) Module["callMain"](Array.prototype.slice.call(arguments));
  else if (typeof callMain !== "undefined") callMain(Array.prototype.slice.call(arguments));
};
