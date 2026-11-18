// editor-load.test.js — the built editor page scripts load without throwing, in app.html's order, and register what
// the chrome needs (the action HANDLERS of editor/actions.ts and the menu actions editor/menu-actions.ts adds to it,
// the pcb dialog actions, the window APIs).  Modules that register at load time make the bundle's module order
// matter: an import cycle that runs one of them before what it uses (HANDLERS, appState) throws a ReferenceError
// ("Cannot access 'X' before initialization") or a TypeError while the page loads, and this test fails on it.
//
// The page runs in a node vm against a permissive fake DOM: every element, style, list and API answers with a
// harmless stand-in, so only the bundle's own load-time logic can fail.
// Run after `npm run build`: node server/static/tests/editor-load.test.js
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert/strict");
const STATIC = path.join(__dirname, "..");
// app.html's order (dist/parts.js is the vendor parts dialog and dist/ui.js the React chrome: neither registers actions)
const SCRIPTS = ["kicad-canvas.js", "kicad-dialogs.js", "sch-tools.js", "props.js", "dist/editor.js"];

// ---------------------------------------------------------------- the fake DOM
const FN_NAMES = new Set(["addEventListener", "removeEventListener", "dispatchEvent", "appendChild", "append", "prepend", "insertBefore", "removeChild", "remove", "replaceChildren", "replaceWith",
  "setAttribute", "removeAttribute", "toggleAttribute", "setAttributeNS", "focus", "blur", "click", "scrollTo", "scrollIntoView", "observe", "unobserve", "disconnect", "setPointerCapture", "releasePointerCapture",
  "add", "toggle", "contains", "insertAdjacentElement", "insertAdjacentHTML", "attachShadow", "animate", "fill", "stroke", "fillRect", "clearRect", "beginPath", "moveTo", "lineTo", "arc", "save", "restore",
  "translate", "scale", "rotate", "setTransform", "drawImage", "setProperty", "removeProperty", "closePath", "clip", "rect", "fillText", "strokeText", "setLineDash", "postMessage", "close", "open", "send"]);
const NULL_PROPS = new Set(["parentNode", "parentElement", "firstChild", "lastChild", "firstElementChild", "lastElementChild", "nextSibling", "previousSibling", "nextElementSibling", "previousElementSibling",
  "offsetParent", "ownerSVGElement", "shadowRoot", "assignedSlot", "onload", "onerror", "onclick", "then"]);
const NUM_PROPS = /^(length|childElementCount|clientWidth|clientHeight|offsetWidth|offsetHeight|offsetLeft|offsetTop|scrollWidth|scrollHeight|scrollTop|scrollLeft|width|height|left|top|right|bottom|x|y|nodeType|selectedIndex|devicePixelRatio|innerWidth|innerHeight|readyState|tabIndex)$/;
const STR_PROPS = /^(id|className|textContent|innerHTML|outerHTML|innerText|value|tagName|nodeName|localName|type|name|title|href|src|cssText|nodeValue|data|placeholder|font|key|code|search|hash|pathname|origin|host|hostname|protocol|baseURI|cookie|userAgent|platform|language|visibilityState|dir|lang|accept|contentType|charset|fillStyle|strokeStyle|textAlign|textBaseline|direction)$/;
const BOOL_PROPS = /^(checked|disabled|hidden|isConnected|open|multiple|readOnly|selected|draggable|isContentEditable|onLine|indeterminate|defaultPrevented|ctrlKey|shiftKey|altKey|metaKey)$/;
const LISTS = /^(children|childNodes|classList|options|selectedOptions|files|attributes|styleSheets|cssRules|languages|touches|changedTouches)$/;
function fake(name) {
  const store = Object.create(null);
  const target = function () { return fake(name + "()"); };
  return new Proxy(target, {
    get(_t, k) {
      if (k in store) return store[k];
      if (k === Symbol.toPrimitive) return (hint) => (hint === "number" ? 0 : "");
      if (k === Symbol.iterator) return function* () { /* empty */ };
      if (typeof k === "symbol") return undefined;
      if (k === "toString" || k === "valueOf") return () => "";
      if (NULL_PROPS.has(k)) return null;
      if (NUM_PROPS.test(k)) return 0;
      if (STR_PROPS.test(k)) return "";
      if (BOOL_PROPS.test(k)) return false;
      if (LISTS.test(k)) return store[k] = fakeList(name + "." + k);
      if (k === "dataset" || k === "style") return store[k] = plainBag();
      if (/^(querySelector|getElementById|closest|getAttribute|getPropertyValue|item|namedItem|elementFromPoint|getItem|matches)$/.test(k)) return k === "matches" ? () => false : k === "querySelector" || k === "getElementById" ? () => fake(name + ".el") : () => null;
      if (/^(querySelectorAll|getElementsByClassName|getElementsByTagName|getClientRects|getAnimations)$/.test(k)) return () => fakeList(name + "." + k);
      if (k === "getBoundingClientRect") return () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
      if (k === "hasAttribute" || k === "hasPointerCapture" || k === "hasChildNodes") return () => false;
      if (k === "measureText") return () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 });
      if (FN_NAMES.has(k)) return () => undefined;
      return store[k] = fake(name + "." + k);
    },
    set(_t, k, v) { store[k] = v; return true; },
    has() { return true; },
    apply() { return fake(name + "()"); },
    construct() { return fake("new " + name); },
  });
}
function plainBag() { return new Proxy(Object.create(null), { get: (t, k) => (k in t ? t[k] : typeof k === "symbol" ? undefined : ""), set: (t, k, v) => { t[k] = v; return true; } }); }
function fakeList(name) { const a = []; a.item = () => null; a.add = a.remove = a.toggle = () => false; a.contains = () => false; a.namedItem = () => null; void name; return a; }
function storage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; }

// ---------------------------------------------------------------- the page
const errors = [];
const listeners = {};
const document = fake("document");
const win = {
  document, console: { log() {}, info() {}, debug() {}, warn() {}, error: (...a) => errors.push("console.error: " + a.map(String).join(" ")) },
  localStorage: storage(), sessionStorage: storage(),
  location: { href: "http://localhost/p/1/edit", pathname: "/p/1/edit", search: "", hash: "", origin: "http://localhost", host: "localhost", hostname: "localhost", protocol: "http:", reload() {}, assign() {}, replace() {} },
  history: { pushState() {}, replaceState() {}, back() {}, state: null },
  navigator: { userAgent: "node", platform: "Linux x86_64", language: "en", languages: ["en"], clipboard: fake("clipboard"), onLine: true, maxTouchPoints: 0, hardwareConcurrency: 4 },
  screen: { width: 1440, height: 900 }, devicePixelRatio: 1, innerWidth: 1440, innerHeight: 900,
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, requestIdleCallback: () => 0, queueMicrotask: (f) => Promise.resolve().then(f),
  fetch: () => new Promise(() => { /* never answers: the page stays at load */ }),
  matchMedia: () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  getComputedStyle: () => plainBag(), getSelection: () => null,
  addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); }, removeEventListener() {}, dispatchEvent() { return true; }, postMessage() {}, open: () => null, close() {}, focus() {}, scrollTo() {}, alert() {}, confirm: () => false, prompt: () => null,
  atob: (s) => Buffer.from(s, "base64").toString("binary"), btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  TextEncoder, TextDecoder, URL, URLSearchParams, Blob, AbortController, Event: class { constructor(t) { this.type = t; } preventDefault() {} stopPropagation() {} }, crypto: globalThis.crypto,
  performance: { now: () => 0, mark() {}, measure() {} }, structuredClone,
};
for (const n of ["HTMLElement", "Element", "Node", "HTMLCanvasElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "HTMLButtonElement", "HTMLDivElement", "HTMLAnchorElement", "HTMLImageElement", "SVGElement", "SVGSVGElement",
  "KeyboardEvent", "MouseEvent", "PointerEvent", "WheelEvent", "CustomEvent", "FocusEvent", "InputEvent", "DragEvent", "ClipboardEvent", "Image", "FileReader", "DOMParser", "XMLSerializer", "OffscreenCanvas", "Path2D", "DOMMatrix",
  "ResizeObserver", "MutationObserver", "IntersectionObserver", "WebSocket", "Worker", "BroadcastChannel", "EventSource", "FontFace", "CanvasRenderingContext2D", "ImageData", "XMLHttpRequest", "Notification", "DataTransfer", "Range"]) {
  // classes the page subclasses or tests with instanceof
  win[n] = class { constructor() { return fake("new " + n); } static [Symbol.hasInstance]() { return false; } };
}
win.customElements = { define() {}, get: () => undefined, whenDefined: () => new Promise(() => {}) };
win.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
win.document.fonts = fake("fonts");
win.window = win; win.self = win; win.globalThis = win; win.top = win; win.parent = win;
const ctx = vm.createContext(win);

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 8).join("\n       ")); } }
console.log("editor-load: the built editor page loads and registers its actions");

for (const s of SCRIPTS) {
  test(`${s} loads without throwing`, () => {
    const file = path.join(STATIC, s);
    assert.ok(fs.existsSync(file), `${file} is missing: run npm run build first`);
    try { vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file }); }
    catch (e) { throw new Error(`${s} threw while loading: ${e && e.name}: ${e && e.message}\n${(e && e.stack || "").split("\n").slice(1, 4).join("\n")}`); }
  });
}
test("no console.error while loading", () => assert.deepEqual(errors, []));
test("the page APIs are published", () => {
  for (const g of ["KiCadCanvas", "CollabApp", "CollabEditor", "CollabTools", "KDialogs"]) assert.ok(win[g], `window.${g}`);
  assert.equal(typeof win.CollabApp.dispatch, "function"); assert.equal(typeof win.CollabApp.getState, "function");
});
test("core HANDLERS and the menu actions are registered", () => {
  const handled = (win.CollabApp.getState().tool || {}).handled || [];
  assert.ok(handled.length > 50, "handled ids: " + handled.length);
  // editor/actions.ts itself
  for (const id of ["undo", "redo", "selectAll", "zoomFitScreen", "zoomInCenter", "navigateUp", "rotateCW", "mirrorH", "doDelete"]) assert.ok(handled.includes(id), "actions.ts: " + id);
  // editor/menu-actions.ts (registered into HANDLERS at load)
  for (const id of ["listHotKeys", "about", "toggleUnits", "saveCopy", "exportNetlist", "gridNext", "properties"]) assert.ok(handled.includes(id), "menu-actions.ts: " + id);
});
// the board tools arrive with a board (editor/pcbtools-loader.ts): the script, then the "kc-pcb-tools" event
test("pcb-tools.js loads after the editor and its dialogs register on the pcb tool module", () => {
  const file = path.join(STATIC, "pcb-tools.js");
  try { vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file }); }
  catch (e) { throw new Error(`pcb-tools.js threw while loading: ${e && e.name}: ${e && e.message}`); }
  for (const f of listeners["kc-pcb-tools"] || []) f({ type: "kc-pcb-tools" });
  const pcb = win.CollabTools.pcb;
  assert.ok(pcb && win.PcbTools, "window.CollabTools.pcb and window.PcbTools");
  for (const id of ["editTracksAndVias", "globalDeletions"]) assert.ok(pcb.actions && pcb.actions[id], "pcb action " + id);
  assert.deepEqual(errors, []);
});
console.log(`${passed} passed, ${failed} failed`); if (failed) process.exit(1);
