// sketch-load.js — bundles a sketcher module for the node tests (sketch-solver, sketch-ops, sketch-regions).
// As cad-load.js, plus one thing: the constraint solver's WebAssembly glue asks for `import.meta.url` when it
// runs in node, which a CommonJS bundle does not have, so it is given this file's address.
"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const server = path.join(__dirname, "..", "..");
const esbuild = require(path.join(server, "node_modules", "esbuild"));

let generated = false;
/** load("domains/mechanical/sketch/solver/load.ts") → the module's exports. */
function load(rel) {
  if (!generated) { execFileSync(process.execPath, [path.join(server, "scripts", "gen-cad-registry.mjs")]); generated = true; }
  const b = esbuild.buildSync({
    entryPoints: [path.join(server, "web", ...rel.split("/"))], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node", jsx: "automatic",
    define: { "import.meta.url": JSON.stringify(pathToFileURL(__filename).href) },
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}

module.exports = { load, server };
