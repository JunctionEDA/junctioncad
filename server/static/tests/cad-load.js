// cad-load.js — bundles a server/web module for the node tests of the JSON item documents and the mechanical and
// assembly domains (itemdoc, doctabs, mechanical-doc, mechanical-kernel, assembly-doc).  The generated registry
// files those domains import are written first (scripts/gen-cad-registry.mjs), as `npm run check` and the build do.
"use strict";
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const server = path.join(__dirname, "..", "..");
const esbuild = require(path.join(server, "node_modules", "esbuild"));

let generated = false;
/** load("shared/itemdoc/itemdoc.ts") → the module's exports. */
function load(rel) {
  if (!generated) { execFileSync(process.execPath, [path.join(server, "scripts", "gen-cad-registry.mjs")]); generated = true; }
  const b = esbuild.buildSync({ entryPoints: [path.join(server, "web", ...rel.split("/"))], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node", jsx: "automatic" });
  const m = { exports: {} };
  new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}

module.exports = { load, server };
