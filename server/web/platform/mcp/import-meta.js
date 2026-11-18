// import-meta.js — injected into the tool host's bundle (`npm run build:mcp`: --inject, with
// --define:import.meta.url=__kc_import_meta_url).  The host is one CommonJS file, where `import.meta.url` does not
// exist; the modelling kernel's loader (npm replicad-opencascadejs, an ES module) reads it to make a `require`.
// This gives it the address of the bundle itself.
export const __kc_import_meta_url = require("node:url").pathToFileURL(__filename).href;
