#!/usr/bin/env node
// ci-web-tests.mjs — runs the web tests the way `npm test` does, but reports every file instead of stopping at
// the first failure, and allows the files listed in static/tests/known-failures.txt to fail.
//
// The list of test files is read from package.json's "test" script, so `npm test` stays the one place to add a
// test.  Exit status: 1 when a test outside the known-failures list fails (a regression), 0 otherwise.  A known
// failure that now passes is reported so it can be taken off the list.
//
//   node scripts/ci-web-tests.mjs          (from server/)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(server, "package.json"), "utf8"));
const loop = /for t in (.*?); do/.exec(pkg.scripts.test);
if (!loop) throw new Error('package.json\'s "test" script no longer has the "for t in …; do" loop this runner reads');
const files = loop[1].trim().split(/\s+/);

const knownPath = path.join(server, "static", "tests", "known-failures.txt");
const known = new Set(fs.readFileSync(knownPath, "utf8").split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean));

const results = [];
const run = (name, cmd, args, cwd) => {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const ok = r.status === 0;
  results.push({ name, ok, ms: Date.now() - t0 });
  if (!ok && !known.has(name)) {
    console.log(`::group::${name} output`);
    process.stdout.write((r.stdout || "") + (r.stderr || ""));
    console.log("::endgroup::");
  }
};

for (const t of files) run(t, process.execPath, [`tests/${t}.test.js`], path.join(server, "static"));
for (const s of ["test:review", "test:compact", "test:drcrules"]) run(s, "npm", ["run", "--silent", s], server);

const regressions = results.filter((r) => !r.ok && !known.has(r.name));
const stillKnown = results.filter((r) => !r.ok && known.has(r.name));
const fixed = results.filter((r) => r.ok && known.has(r.name));
const unknownListed = [...known].filter((k) => !results.some((r) => r.name === k));

console.log(`\n${results.length} test files: ${results.filter((r) => r.ok).length} passed, ${stillKnown.length} known failures, ${regressions.length} regressions`);
for (const r of stillKnown) console.log(`  known failure: ${r.name}`);
for (const r of fixed) console.log(`::notice::${r.name} passes now; take it off static/tests/known-failures.txt`);
for (const k of unknownListed) console.log(`::warning::known-failures.txt lists ${k}, which is not a test`);
for (const r of regressions) console.log(`::error::${r.name} failed`);
process.exit(regressions.length ? 1 : 0);
