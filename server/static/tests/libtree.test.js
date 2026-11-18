// libtree.test.js — the editor trees' filter and order (web/domains/pcb/library/libtree.ts): LIB_TREE_NODE_ITEM::UpdateScore,
// LIB_TREE_NODE::Compare with Sort by Best Match / Sort Alphabetically, and the recent searches.
// Run: node server/static/tests/libtree.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const built = esbuild.buildSync({ entryPoints: [webPath("domains", "pcb", "library", "libtree.ts")], bundle: true, format: "cjs", target: "es2020", write: false });
const mod = { exports: {} }; new Function("exports", "module", "require", built.outputFiles[0].text)(mod.exports, mod, require); const L = mod.exports;

const items = [
  { name: "R_Small", desc: "Resistor, small symbol", lib: "Device", pins: 2 },
  { name: "R", desc: "Resistor", lib: "Device", pins: 2 },
  { name: "C", desc: "Unpolarized capacitor", lib: "Device", pins: 2 },
  { name: "LM358", desc: "Dual op amp", keywords: "opamp", lib: "Amplifier", pins: 8 },
];

test("every term must match; numbers match the pin count", () => {
  assert.equal(L.treeScore(items[1], "").score, 1);
  assert.ok(L.treeScore(items[1], "resistor").score > 0);
  assert.equal(L.treeScore(items[2], "resistor").score, 0);
  assert.ok(L.treeScore(items[3], "opamp 8").score > 0, "keyword and pin count");
  assert.equal(L.treeScore(items[3], "opamp 14").score, 0);
  assert.equal(L.treeScore(items[1], "R").exact, true);
  assert.equal(L.treeScore(items[1], "Device:R").exact, true);
});

test("best match puts the exact name first; alphabetical ignores the score", () => {
  assert.deepEqual(L.filterItems(items, "R", "best").map((x) => x.name)[0], "R");
  assert.deepEqual(L.filterItems(items, "resistor", "alpha").map((x) => x.name), ["R", "R_Small"]);
  assert.deepEqual(L.filterItems(items, "", "best").map((x) => x.name), ["C", "LM358", "R", "R_Small"]);
});

test("libraries: pinned first, then the better match, then the name", () => {
  const libs = [{ name: "B", best: 10 }, { name: "A", best: 5 }, { name: "Z", pinned: true, best: 1 }, { name: "E", exact: true, best: 2 }];
  assert.deepEqual(L.sortLibraries(libs, "x", "best").map((l) => l.name), ["Z", "E", "B", "A"]);
  assert.deepEqual(L.sortLibraries(libs, "x", "alpha").map((l) => l.name), ["Z", "A", "B", "E"]);
  assert.deepEqual(L.sortLibraries(libs, "", "best").map((l) => l.name), ["Z", "A", "B", "E"]);
  assert.deepEqual(L.sortLibraries([{ name: "a" }, { name: "b", rank: 1 }], "", "best").map((l) => l.name), ["b", "a"], "project libraries rank first");
  assert.deepEqual(L.libraryScore(items, "R").exact, true);
});

test("recent searches: newest first, no repeats, at most ten", () => {
  for (let i = 0; i < 12; i++) L.pushRecentSearch("t", "q" + i);
  L.pushRecentSearch("t", "q5"); L.pushRecentSearch("t", "  ");
  const r = L.recentSearches("t");
  assert.equal(r.length, L.RECENT_SEARCHES_MAX);
  assert.equal(r[0], "q5");
  assert.equal(r.filter((x) => x === "q5").length, 1);
  assert.deepEqual(L.recentSearches("other"), []);
});
