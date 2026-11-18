// simulate.ts — the `simulate` tool: the schematic (or a netlist the model writes) run through ngspice, the result
// as a few numbers per signal and one plot.  The netlist is KiCad's own SPICE export (sim/spice-netlist.ts, the
// exporter the editor's File > Export > Netlist uses); the simulator is the real ngspice compiled to WebAssembly
// with XSPICE (scripts/ngspice-wasm/build.sh, the build the plugin runtime ships as ngspice.mjs), run in a worker
// thread so a long or diverging analysis can be stopped.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ToolError } from "../ai/design";

declare const require: any;
import { textPaths } from "./picture";

export interface Vector { name: string; type: string; re: number[]; im?: number[] }
export interface SimRun { kind: "op" | "tran" | "ac" | "dc" | "other"; vectors: Vector[]; points: number; errors: string[]; info: string }

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const quiet = console.error; console.error = () => {}; console.log = () => {};
  const m = await import(workerData.url);
  const sim = new m.Simulation();
  await sim.start();
  const fs = sim.__getSpiceModuleForTests().FS;
  for (const [p, text] of workerData.files) { const dir = p.slice(0, p.lastIndexOf('/')); if (dir) { try { fs.mkdirTree(dir); } catch (e) {} } fs.writeFile(p, text); }
  sim.setNetList(workerData.netlist);
  const r = await sim.runSim();
  const vectors = (r.data || []).map((d) => r.dataType === 'complex'
    ? { name: d.name, type: d.type, re: Float64Array.from(d.values, (v) => v.real), im: Float64Array.from(d.values, (v) => v.img) }
    : { name: d.name, type: d.type, re: Float64Array.from(d.values) });
  console.error = quiet;
  parentPort.postMessage({ ok: true, points: r.numPoints || 0, vectors, errors: sim.getError(), info: String(sim.getInfo() || '').slice(-4000) });
})().catch((e) => parentPort.postMessage({ ok: false, error: String((e && e.message) || e) }));
`;

/** Run one netlist (with its analysis command inside) and return every saved vector. */
export function runSpice(netlist: string, files: [string, string][], runtimeDir: string, timeoutMs: number): Promise<SimRun> {
  const fs = require("node:fs"), path = require("node:path"), { Worker } = require("node:worker_threads"), { pathToFileURL } = require("node:url");
  const engine = path.join(runtimeDir || "", "ngspice.mjs");
  if (!runtimeDir || !fs.existsSync(engine)) throw new ToolError("The simulator is not available on this server (its runtime is not built).");
  const line = netlist.split("\n").map((l) => l.trim().toLowerCase()).find((l) => /^\.(tran|ac|dc|op)\b/.test(l)) || "";
  const kind = (/^\.(tran|ac|dc|op)/.exec(line) || ["", "other"])[1] as SimRun["kind"];
  return new Promise<SimRun>((ok, fail) => {
    const w = new Worker(WORKER, { eval: true, workerData: { url: pathToFileURL(engine).href, netlist, files } });
    const timer = setTimeout(() => { void w.terminate(); fail(new ToolError(`The simulation did not finish in ${Math.round(timeoutMs / 1000)} s and was stopped. Simulate a shorter time or fewer points, or raise timeout_s.`)); }, timeoutMs);
    w.once("message", (m: any) => {
      clearTimeout(timer); void w.terminate();
      if (!m.ok) { fail(new ToolError(`ngspice could not run this: ${m.error}`)); return; }
      ok({ kind, points: m.points, errors: (m.errors || []).map(String), info: m.info,
        vectors: m.vectors.map((v: any) => ({ name: String(v.name), type: String(v.type), re: Array.from(v.re as Float64Array), im: v.im ? Array.from(v.im as Float64Array) : undefined })) });
    });
    w.once("error", (e: Error) => { clearTimeout(timer); fail(new ToolError(`The simulator stopped: ${e.message}`)); });
  });
}

// ---------------------------------------------------------------- numbers

const PREFIX: [number, string][] = [[1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "u"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]];
/** 0.0047 -> "4.7m": three significant digits with an SI prefix. */
export function eng(v: number, unit = ""): string {
  if (!isFinite(v)) return String(v); if (v === 0) return "0" + unit;
  const a = Math.abs(v); const [m, p] = PREFIX.find(([s]) => a >= s * 0.9995) || PREFIX[PREFIX.length - 1]!;
  return `${+(v / m).toPrecision(3)}${p}${unit}`;
}
const sig = (v: number) => +v.toPrecision(4);
const unitOf = (v: Vector) => (/current/i.test(v.type) || /^i\(|#branch$/.test(v.name) ? "A" : /voltage/i.test(v.type) || /^v\(/.test(v.name) ? "V" : "");
const mag = (v: Vector, i: number) => (v.im ? Math.hypot(v.re[i]!, v.im[i]!) : Math.abs(v.re[i]!));
const dB = (v: Vector, i: number) => 20 * Math.log10(Math.max(mag(v, i), 1e-300));
const phase = (v: Vector, i: number) => (v.im ? (Math.atan2(v.im[i]!, v.re[i]!) * 180) / Math.PI : v.re[i]! < 0 ? 180 : 0);

/** The vector a probe names: "V(OUT)", "out", "I(R1)", "/out" in any case. */
export function findVector(run: SimRun, probe: string): Vector | null {
  const want = probe.trim().toLowerCase(); const by = new Map(run.vectors.map((v) => [v.name.toLowerCase(), v]));
  const inner = (/^[vi]\((.*)\)$/.exec(want) || ["", want])[1]!; const isI = /^i\(/.test(want);
  const tries = isI ? [want, `${inner}#branch`, `i(${inner})`, `@${inner}[i]`] : [want, `v(${inner})`, inner, `v(/${inner})`, `/${inner}`];
  for (const t of tries) { const v = by.get(t); if (v) return v; }
  return null;
}

function crossings(x: number[], y: number[], level: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < y.length; i++) { const a = y[i - 1]! - level, b = y[i]! - level; if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) out.push(x[i - 1]! + ((x[i]! - x[i - 1]!) * (0 - a)) / (b - a || 1)); }
  return out;
}

/** What one signal did, in a handful of numbers that fit the analysis. */
export function summarize(run: SimRun, v: Vector): Record<string, unknown> {
  const u = unitOf(v), n = v.re.length, x = run.vectors[0]!.re;
  if (run.kind === "op" || n <= 1) return { value: eng(v.re[0] ?? NaN, u) };
  if (run.kind === "ac") {
    let peak = 0; for (let i = 1; i < n; i++) if (dB(v, i) > dB(v, peak)) peak = i;
    const ref = dB(v, peak), db = v.re.map((_, i) => dB(v, i)); const cut = crossings(x, db, ref - 3);
    const out: Record<string, unknown> = { gain_at_start: `${sig(db[0]!)} dB at ${eng(x[0]!, "Hz")}`, gain_at_end: `${sig(db[n - 1]!)} dB at ${eng(x[n - 1]!, "Hz")}`, peak: `${sig(ref)} dB at ${eng(x[peak]!, "Hz")}`,
      phase_at_start_deg: sig(phase(v, 0)), phase_at_end_deg: sig(phase(v, n - 1)) };
    if (cut.length) out.minus_3db_at = cut.slice(0, 4).map((f) => eng(f, "Hz"));
    return out;
  }
  let lo = 0, hi = 0, sum = 0, span = 0;
  for (let i = 0; i < n; i++) { if (v.re[i]! < v.re[lo]!) lo = i; if (v.re[i]! > v.re[hi]!) hi = i; if (i) { sum += ((v.re[i]! + v.re[i - 1]!) / 2) * (x[i]! - x[i - 1]!); span += x[i]! - x[i - 1]!; } }
  const xu = run.kind === "tran" ? "s" : "";
  const out: Record<string, unknown> = { min: `${eng(v.re[lo]!, u)} at ${eng(x[lo]!, xu)}`, max: `${eng(v.re[hi]!, u)} at ${eng(x[hi]!, xu)}`, start: eng(v.re[0]!, u), end: eng(v.re[n - 1]!, u) };
  if (run.kind === "tran") {
    const mean = span ? sum / span : v.re[0]!; out.mean = eng(mean, u);
    const pp = v.re[hi]! - v.re[lo]!;
    if (pp > 1e-9 * Math.max(1, Math.abs(mean))) {
      const mid = (v.re[hi]! + v.re[lo]!) / 2; const up: number[] = [];
      for (let i = 1; i < n; i++) if (v.re[i - 1]! < mid && v.re[i]! >= mid) up.push(x[i - 1]! + ((x[i]! - x[i - 1]!) * (mid - v.re[i - 1]!)) / (v.re[i]! - v.re[i - 1]! || 1));
      if (up.length >= 3) { const period = (up[up.length - 1]! - up[0]!) / (up.length - 1); out.frequency = eng(1 / period, "Hz"); out.cycles = up.length - 1; }
      // how long it takes to come within 2 % of where it ends (a step response)
      else { const end = v.re[n - 1]!, band = 0.02 * pp; let last = 0; for (let i = n - 1; i >= 0; i--) if (Math.abs(v.re[i]! - end) > band) { last = i + 1; break; } if (last > 0 && last < n - 1) out.settles_within_2pct_at = eng(x[last]!, "s"); }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the plot

const COLORS = ["#d1242f", "#0969da", "#1a7f37", "#9a6700", "#8250df", "#bf3989", "#1b7c83", "#57606a"];
function ticks(lo: number, hi: number, want: number): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / want, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  const out: number[] = []; for (let t = Math.ceil(lo / step - 1e-9) * step; t <= hi + step * 1e-9; t += step) out.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  return out;
}
interface Trace { name: string; y: number[]; color: string }
interface Panel { title: string; unit: string; traces: Trace[] }

/** One or more stacked panels over a shared x axis, as an SVG whose text is drawn as paths (no fonts needed). */
export function plotSvg(x: number[], panels: Panel[], xUnit: string, logX: boolean, heading: string): string {
  const W = 300, PH = 78, L = 30, R = 8, T = 14, GAP = 16, B = 14; const H = T + panels.length * PH + (panels.length - 1) * GAP + B;
  const bg = "#ffffff", ink = "#24292f", grid = "#d8dee4", hair = 0.1;
  const text = (tx: number, ty: number, s: string, size: number, h: string, color = ink, rot = 0) => textPaths({ t: "text", x: tx, y: ty, text: s, size, w: size * 0.13, color, rot, h, v: "center" }, hair, bg);
  const fx = (v: number) => (logX ? Math.log10(Math.max(v, 1e-300)) : v); const x0 = fx(x[0]!), x1 = fx(x[x.length - 1]!);
  const px = (v: number) => L + ((fx(v) - x0) / (x1 - x0 || 1)) * (W - L - R);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" stroke-linejoin="round" stroke-linecap="round">`, `<rect width="${W}" height="${H}" fill="${bg}"/>`];
  out.push(text(L, 6, heading, 3.6, "left"));
  const xt = logX ? Array.from({ length: Math.floor(x1) - Math.ceil(x0) + 1 }, (_, i) => Math.pow(10, Math.ceil(x0) + i)) : ticks(x[0]!, x[x.length - 1]!, 8);
  const step = Math.max(1, Math.ceil(x.length / 1600));
  panels.forEach((p, k) => {
    const top = T + k * (PH + GAP), bot = top + PH;
    let lo = Infinity, hi = -Infinity; for (const t of p.traces) for (const v of t.y) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-12 * Math.max(1, Math.abs(hi))) { const d = Math.abs(hi) * 0.1 || 1; lo -= d; hi += d; } else { const m = (hi - lo) * 0.06; lo -= m; hi += m; }
    const py = (v: number) => bot - ((v - lo) / (hi - lo)) * PH;
    out.push(`<rect x="${L}" y="${top}" width="${W - L - R}" height="${PH}" fill="none" stroke="${ink}" stroke-width="0.25"/>`);
    for (const t of ticks(lo, hi, 5)) { const y = py(t); if (y < top - 0.01 || y > bot + 0.01) continue; out.push(`<path d="M${L} ${y.toFixed(2)}H${W - R}" stroke="${grid}" stroke-width="0.18"/>`, text(L - 1.5, y, eng(t, p.unit), 2.6, "right")); }
    for (const t of xt) { const xx = px(t); if (xx < L - 0.01 || xx > W - R + 0.01) continue; out.push(`<path d="M${xx.toFixed(2)} ${top}V${bot}" stroke="${grid}" stroke-width="0.18"/>`); if (k === panels.length - 1) out.push(text(xx, bot + 3.5, eng(t, xUnit), 2.6, "center")); }
    p.traces.forEach((t, i) => {
      let d = ""; for (let j = 0; j < x.length; j += step) d += `${j ? "L" : "M"}${px(x[j]!).toFixed(2)} ${Math.min(bot, Math.max(top, py(t.y[j]!))).toFixed(2)}`;
      out.push(`<path d="${d}" fill="none" stroke="${t.color}" stroke-width="0.45"/>`);
      // the legend, along the top of the panel
      const lx = L + 3 + i * 44; if (lx < W - R - 30) out.push(`<path d="M${lx} ${top + 4}h6" stroke="${t.color}" stroke-width="0.8"/>`, text(lx + 7.5, top + 4, t.name, 2.6, "left"));
    });
    out.push(text(4, (top + bot) / 2, p.title, 2.8, "center", ink, 90));
  });
  out.push("</svg>");
  return out.join("");
}

/** The panels for a run and its chosen signals: volts and amps apart, an AC sweep as gain and phase. */
export function plotOf(run: SimRun, shown: Vector[], heading: string): string | null {
  if (run.kind === "op" || run.points < 2 || !shown.length) return null;
  const x = run.vectors[0]!.re; const color = (i: number) => COLORS[i % COLORS.length]!;
  if (run.kind === "ac") {
    return plotSvg(x, [{ title: "Gain", unit: "dB", traces: shown.map((v, i) => ({ name: v.name, color: color(i), y: v.re.map((_, j) => dB(v, j)) })) },
      { title: "Phase", unit: "°", traces: shown.map((v, i) => ({ name: v.name, color: color(i), y: v.re.map((_, j) => phase(v, j)) })) }], "Hz", x[0]! > 0 && x[x.length - 1]! / x[0]! >= 50, heading);
  }
  const panels: Panel[] = [];
  shown.forEach((v, i) => { const u = unitOf(v); let p = panels.find((q) => q.unit === u); if (!p) { p = { title: u === "A" ? "Current" : u === "V" ? "Voltage" : "Value", unit: u, traces: [] }; panels.push(p); } p.traces.push({ name: v.name, color: color(i), y: v.re }); });
  return plotSvg(x, panels, run.kind === "tran" ? "s" : "", false, heading);
}
