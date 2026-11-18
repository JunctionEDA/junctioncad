// pcbdialogs/drc-rule-model.test.ts — the DRC Rule Editor's load and save against a hand-written .kicad_dru.
// Run by `npm test` (bundled for node by esbuild; the canvas library is the built static/kicad-canvas.js).
import { loadRules, rulesText, ruleText, ruleEdited } from "./drc-rule-model";

declare const require: (m: string) => unknown;
declare const process: { exit(code: number): void; env: Record<string, string | undefined>; cwd(): string };
const path = require("path") as { join(...p: string[]): string };
require(path.join(process.env.KC_SERVER_DIR || process.cwd(), "static", "kicad-canvas.js"));

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", (e as Error).message); } }
function ok(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function eq<T>(a: T, b: T, msg: string): void { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const DRU = `(version 1)

# keep vias and tracks out of the antenna
(rule antenna_keepout
	(constraint disallow track via zone)
	(condition "A.intersectsArea('ANT')"))

(rule min_width
	(constraint track_width (min 0.2mm)))

(rule inner_only
	(constraint assertion "A.Layer == 'In1.Cu'"))

(rule via_budget
	(constraint via_count (min 1) (max 4))
	(condition "A.NetClass == 'HS'"))

(rule clear_gnd
	# GND gets more room
	(constraint clearance (min 0.3mm))
	(condition "A.NetName == 'GND'"))
# trailing note
`;

test("untouched rules are written back unchanged", () => {
  const rules = loadRules(DRU), out = rulesText(rules);
  for (const r of ["(constraint disallow track via zone)", "(constraint track_width (min 0.2mm))", `(constraint assertion "A.Layer == 'In1.Cu'")`, "(constraint via_count (min 1) (max 4))"]) ok(out.includes(r), `kept ${r}\n${out}`);
  ok(out.includes("# keep vias and tracks out of the antenna\n(rule antenna_keepout"), "top-level comment kept above its rule\n" + out);
  ok(out.includes("# trailing note"), "trailing comment kept");
  ok(!/\(opt 0mm\)|\(max 0mm\)/.test(out), "no invented bounds");
  ok(rules.every((r) => !ruleEdited(r)), "nothing reads as edited");
});
test("rules a panel cannot hold stay Custom", () => {
  const rules = loadRules(DRU), by = (n: string) => rules.find((r) => r.name === n)!;
  eq(by("antenna_keepout").type, "CUSTOM_RULE", "disallow track via zone");
  eq(by("inner_only").type, "CUSTOM_RULE", "In1.Cu assertion");
  eq(by("via_budget").type, "CUSTOM_RULE", "via_count with a min");
  eq(by("min_width").type, "ROUTING_WIDTH", "track_width min only");
  eq(by("clear_gnd").type, "MINIMUM_CLEARANCE", "clearance");
  eq(by("clear_gnd").comment, "GND gets more room", "rule comment");
});
test("an edited panel rule writes only its own bounds", () => {
  const rules = loadRules(DRU), w = rules.find((r) => r.name === "min_width")!;
  w.v.min = 0.25; ok(ruleEdited(w), "edited");
  const out = rulesText(rules);
  ok(out.includes("(constraint track_width (min 0.25mm))"), out);
  ok(out.includes("(constraint disallow track via zone)"), "other rules untouched");
  eq(ruleText(w).includes("opt"), false, "no opt written");
});

console.log(`drc-rule-model: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
