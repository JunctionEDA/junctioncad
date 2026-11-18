// selmods.test.js — SELECTION_TOOL::setModifiersState (common/tool/selection_tool.cpp) as editor/selmodes.ts ports it:
// every Shift / Ctrl / Alt combination, MD_CTRL as Control or (macOS) Command, MS Windows' Alt, and pcbnew's
// "Ctrl+click highlights net"; what a click, a box and the cursor make of them.
// Run: node server/static/tests/selmods.test.js
"use strict";
const path = require("path"), assert = require("assert");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const M = load(["editor", "selmodes.ts"]);

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }
const ev = (o) => Object.assign({ shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }, o);
const LINUX = { mac: false, windows: false };

/** setModifiersState, transcribed from selection_tool.cpp, as the oracle. */
function kicad(shift, ctrl, alt, { highlights = false, windows = false } = {}) {
  return {
    subtractive: ctrl && shift, additive: !ctrl && shift,
    exclusiveOr: highlights ? false : ctrl && !shift, highlight: highlights ? ctrl && !shift : false,
    dragAdditive: (ctrl || shift) && !alt, dragSubtractive: ctrl && shift && !alt,
    skipHeuristics: windows ? false : alt,
  };
}

test("setModifiersState: all eight Shift / Ctrl / Alt combinations, with and without Ctrl-click highlighting, on and off Windows", () => {
  for (const shift of [false, true]) for (const ctrl of [false, true]) for (const alt of [false, true]) for (const highlights of [false, true]) for (const windows of [false, true]) {
    const got = M.modifiersState(ev({ shiftKey: shift, ctrlKey: ctrl, altKey: alt }), { mac: false, windows, ctrlHighlights: highlights });
    assert.deepEqual(got, kicad(shift, ctrl, alt, { highlights, windows }), JSON.stringify({ shift, ctrl, alt, highlights, windows }));
  }
});
test("MD_CTRL: Control off macOS (the Super key does nothing), Command on macOS (the Control key does nothing)", () => {
  assert.equal(M.ctrlDown(ev({ ctrlKey: true }), false), true);
  assert.equal(M.ctrlDown(ev({ metaKey: true }), false), false);
  assert.equal(M.ctrlDown(ev({ metaKey: true }), true), true);
  assert.equal(M.ctrlDown(ev({ ctrlKey: true }), true), false);
  assert.equal(M.selModifier(ev({ metaKey: true }), LINUX), null);
  assert.equal(M.selModifier(ev({ metaKey: true }), { mac: true }), "toggle");
  assert.equal(M.selModifier(ev({ metaKey: true, shiftKey: true }), { mac: true }), "remove");
  assert.equal(M.selModifier(ev({ ctrlKey: true, shiftKey: true }), { mac: true }), "add");   // Shift with the (raw) Control key: Shift alone counts
  assert.equal(M.selModifier(ev({ ctrlKey: true }), { mac: true }), null);
});
test("a click: Shift adds, Ctrl toggles, Ctrl+Shift removes, Alt changes none of it", () => {
  for (const altKey of [false, true]) {
    assert.equal(M.selModifier(ev({ altKey }), LINUX), null);
    assert.equal(M.selModifier(ev({ shiftKey: true, altKey }), LINUX), "add");
    assert.equal(M.selModifier(ev({ ctrlKey: true, altKey }), LINUX), "toggle");
    assert.equal(M.selModifier(ev({ ctrlKey: true, shiftKey: true, altKey }), LINUX), "remove");
  }
  // ctrlClickHighlights: Ctrl alone is the highlight modifier, no selection modifier (hasModifier false)
  const hl = M.modifiersState(ev({ ctrlKey: true }), { mac: false, ctrlHighlights: true });
  assert.equal(M.clickMode(hl), null); assert.equal(M.hasModifier(hl), false); assert.equal(hl.highlight, true);
  assert.equal(M.selModifier(ev({ ctrlKey: true, shiftKey: true }), { mac: false, ctrlHighlights: true }), "remove");
});
test("hasModifier: m_subtractive || m_additive || m_exclusive_or (Alt alone is none)", () => {
  assert.equal(M.hasModifier(M.modifiersState(ev({}), LINUX)), false);
  assert.equal(M.hasModifier(M.modifiersState(ev({ altKey: true }), LINUX)), false);
  for (const o of [{ shiftKey: true }, { ctrlKey: true }, { ctrlKey: true, shiftKey: true }, { shiftKey: true, altKey: true }]) assert.equal(M.hasModifier(M.modifiersState(ev(o), LINUX)), true, JSON.stringify(o));
});
test("a box in eeschema: SelectMultiple( area, m_drag_subtractive, false ) — Ctrl or Shift adds, Ctrl+Shift removes, Alt drops both", () => {
  assert.equal(M.dragModifier(ev({ shiftKey: true }), true, LINUX), "add");
  assert.equal(M.dragModifier(ev({ ctrlKey: true }), true, LINUX), "add");
  assert.equal(M.dragModifier(ev({ ctrlKey: true, shiftKey: true }), true, LINUX), "remove");
  assert.equal(M.dragModifier(ev({ shiftKey: true, altKey: true }), true, LINUX), null);
  assert.equal(M.dragModifier(ev({ metaKey: true, shiftKey: true }), true, { mac: true }), "remove");
});
test("a box in pcbnew: SelectMultiple( area, m_subtractive, m_exclusive_or ) — Ctrl toggles unless Ctrl-click highlights, then it adds", () => {
  assert.equal(M.dragModifier(ev({ ctrlKey: true }), false, LINUX), "toggle");
  assert.equal(M.dragModifier(ev({ ctrlKey: true }), false, { mac: false, ctrlHighlights: true }), "add");
  assert.equal(M.dragKeeps(ev({ ctrlKey: true }), { mac: false, ctrlHighlights: true }), true);
  assert.equal(M.dragModifier(ev({ ctrlKey: true, shiftKey: true }), false, { mac: false, ctrlHighlights: true }), "remove");
  assert.equal(M.dragModifier(ev({ shiftKey: true }), false, LINUX), "add");
});
test("OnIdle's cursor: ADD, SUBTRACT, XOR, none for Ctrl when Ctrl-click highlights", () => {
  const c = (o, opts = LINUX) => M.modifierCursorOf(M.modifiersState(ev(o), opts));
  assert.equal(c({}), null); assert.equal(c({ shiftKey: true }), "ADD"); assert.equal(c({ ctrlKey: true, shiftKey: true }), "SUBTRACT"); assert.equal(c({ ctrlKey: true }), "XOR");
  assert.equal(c({ ctrlKey: true }, { mac: false, ctrlHighlights: true }), null);
  assert.equal(c({ metaKey: true }, { mac: true }), "XOR");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
