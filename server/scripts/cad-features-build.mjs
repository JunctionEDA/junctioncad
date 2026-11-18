// cad-features-build.mjs — builds the part studio's two bundles (mechanical.js, cad-worker.js) into a folder
// of your choosing, for scripts/cad-features-ui.mjs to serve in place of the ones a server binary embeds.  The
// same esbuild options as `npm run build:cad`, without the minifier, so a failure in the browser has names.
//
//   node scripts/cad-features-build.mjs /some/dir
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] || path.join(server, "target", "cad-features-dist"));
const esbuild = require(path.join(server, "node_modules", "esbuild"));
execFileSync(process.execPath, [path.join(server, "scripts", "gen-cad-registry.mjs")]);
const web = path.join(server, "web", "domains", "mechanical");
esbuild.buildSync({ entryPoints: [path.join(web, "index.tsx")], bundle: true, format: "iife", target: "es2020", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, outfile: path.join(out, "mechanical.js"), logLevel: "warning" });
esbuild.buildSync({ entryPoints: [path.join(web, "kernel", "worker.ts")], bundle: true, format: "iife", target: "es2022", external: ["node:*"], define: { "import.meta.url": '""' }, outfile: path.join(out, "cad-worker.js"), logLevel: "warning" });
console.log(out);
