// Node test for the RF feed field solver (web/domains/pcb/router/fieldsolve.ts): plain microstrip agrees with
// Hammerstad's closed form, ground copper beside the track lowers the impedance, and feedWidth finds a 50 ohm width.
// Run: node server/static/tests/fieldsolve.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");

const src = buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", "domains", "pcb", "router", "fieldsolve.ts")], bundle: true, format: "cjs", write: false, platform: "node" }).outputFiles[0].text;
const M = { exports: {} }; new Function("module", "exports", src)(M, M.exports);
const { feedImpedance, feedWidth } = M.exports;

function hammerstad(w, h, er) {             // microstrip, zero thickness
  const u = w / h, a = 1 + Math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + Math.log(1 + (u / 18.1) ** 3) / 18.7, b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053;
  const ee = (er + 1) / 2 + (er - 1) / 2 * (1 + 10 / u) ** (-a * b), f = 6 + (2 * Math.PI - 6) * Math.exp(-((30.666 / u) ** 0.7528));
  return 60 / Math.sqrt(ee) * Math.log(f / u + Math.sqrt(1 + (2 / u) ** 2));
}
const stack = [{ th: 0.2, er: 4.5 }, { th: 1.2, er: 4.5 }];

test("microstrip matches Hammerstad within 3%", () => {
  const z = feedImpedance({ w: 0.36, t: 0.001, gap: 0, dielectrics: stack, voidHalf: 0, reference: 0 }, 0.02).z;
  const ref = hammerstad(0.36, 0.2, 4.5);
  assert.ok(Math.abs(z - ref) / ref < 0.03, `solver ${z.toFixed(1)} vs ${ref.toFixed(1)}`);
});

test("coplanar ground lowers the impedance", () => {
  const base = { w: 0.36, t: 0.035, dielectrics: stack, voidHalf: 0, reference: 0 };
  const ms = feedImpedance({ ...base, gap: 0 }, 0.02).z, cp = feedImpedance({ ...base, gap: 0.1 }, 0.02).z;
  assert.ok(cp < ms - 3, `cpwg ${cp.toFixed(1)} vs microstrip ${ms.toFixed(1)}`);
});

test("feedWidth finds 50 ohm, wider when the near plane is voided", () => {
  const base = { t: 0.035, gap: 0.15, dielectrics: stack, reference: 0 };
  const near = feedWidth(base, 50, null);
  const deep = feedWidth({ ...base, reference: 1 }, 50, 0.6);
  assert.ok(near && Math.abs(near.z - 50) < 1.5, JSON.stringify(near));
  assert.ok(deep && deep.w > near.w * 1.5, `voided ${deep && deep.w} vs ${near.w}`);
});

test("symmetric stripline matches the closed form within 4%", () => {
  // Cohn / IPC-2141 for a thin strip centred between planes b apart: Z = 60/sqrt(er) ln(4b / (0.67 pi (0.8w + t)))
  const h = 0.2, w = 0.15, t = 0.0175, er = 4.2, b = 2 * h + t;
  const z = feedImpedance({ w, t, gap: 0, dielectrics: [{ th: h, er }], above: [{ th: h, er }], voidHalf: 0, reference: 0, referenceAbove: 0 }, 0.01).z;
  const ref = 60 / Math.sqrt(er) * Math.log(4 * b / (0.67 * Math.PI * (0.8 * w + t)));
  assert.ok(Math.abs(z - ref) / ref < 0.04, `solver ${z.toFixed(1)} vs ${ref.toFixed(1)}`);
});
