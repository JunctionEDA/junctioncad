// sim/dialogs.ts — the simulator's dialogs: DIALOG_SIM_COMMAND (the analysis of a tab, its SPICE options and its plot
// setup), DIALOG_SIM_FORMAT_VALUE (a cursor / measurement value's significant digits and range) and
// DIALOG_USER_DEFINED_SIGNALS (expressions over the simulation's vectors, with the syntax help).
import { KD, checkbox, form, h, select, textInput } from "../dialogs/dom";
import { messageBox } from "../dialogs/sch-items";
import { bitmapButton } from "../../../shared/components/kicon-dom";
import {
  NEW_TAB_TYPES, OPT_FIX_INCLUDES, OPT_SAVE_EVENTS, OPT_SAVE_I, OPT_SAVE_P, OPT_SAVE_V, acCommand, commandToSimType, dcCommand, fftCommand,
  formatToString, noiseCommand, parseCommand, parseSpiceValue, pzCommand, spCommand, toSpiceString, tranCommand, typeToName,
  type DcSrc, type Scale, type SimType, type ValueFormat,
} from "./sim-logic";

// ---------------------------------------------------------------- DIALOG_SIM_COMMAND
export interface PlotSetup {
  /** the Y axes the tab has: [label, units] or null */
  axes: ([string, string] | null)[];
  fixed: ({ min: number; max: number } | null)[];
  grid: boolean; legend: boolean; dotted: boolean;
  margins: { left: number; top: number; right: number; bottom: number };
  /** SIM_PLOT_TAB::IsSmithMode: an S-parameter tab drawn on a Smith chart */
  smith?: boolean;
}
export interface SimCommandInput {
  /** the tab's command, or "*" for the New Simulation Tab dialog */
  command: string; options: number;
  nets: string[]; vSources: string[]; iSources: string[]; resistors: string[];
  /** FFT input signals offered (the tab's signals) */
  signals: string[];
  /** the schematic's simulation directives ("Load Directives from Schematic") */
  schDirectives: string;
  compat: string;
  plot: PlotSetup | null;
}
export interface SimCommandResult { command: string; options: number; compat: string; plot: PlotSetup | null }

const SCALES: [Scale, string][] = [["dec", "Decade"], ["oct", "Octave"], ["lin", "Linear"]];
const POINTS_LABEL: Record<Scale, string> = { dec: "Number of points per decade:", oct: "Number of points per octave:", lin: "Number of points:" };
export const COMPAT_MODES = ["User configuration", "Spice", "PSpice", "LTSpice", "PSpice and LTSpice", "HSpice"];
const DC_UNITS: Record<DcSrc["type"], string> = { V: "V", I: "A", R: "Ω", TEMP: "°C" };

function radios(name: string, items: [string, string][], value: string, onChange?: (v: string) => void): { el: HTMLElement; value(): string } {
  const el = h("div", { class: "sim-radios" }); let cur = value;
  for (const [v, label] of items) {
    const r = h("input", { type: "radio", name, value: v, checked: v === value, id: `${name}-${v}` });
    r.addEventListener("change", () => { if (r.checked) { cur = v; if (onChange) onChange(v); } });
    el.append(h("label", { class: "kd-chk" }, r, label));
  }
  return { el, value: () => cur };
}

/** DIALOG_SIM_COMMAND: resolves with the new command and settings, or null when cancelled. */
export function openSimCommand(inp: SimCommandInput): Promise<SimCommandResult | null> {
  return new Promise((resolve) => {
    const isNew = inp.command === "*";
    const parsed = parseCommand(isNew ? "" : inp.command);
    let type: SimType = isNew ? "OP" : commandToSimType(inp.command);
    const title = isNew ? "New Simulation Tab" : `${typeToName(type, true)}  —  ${typeToName(type, false)}`;
    const pages: Partial<Record<SimType, HTMLElement>> = {};
    let build: () => string | { error: string } = () => "";
    const getters: Partial<Record<SimType, () => string | { error: string }>> = {};
    let opts = inp.options, compat = inp.compat;
    const plot = inp.plot ? JSON.parse(JSON.stringify(inp.plot)) as PlotSetup : null;
    let settled = false;
    const finish = (r: SimCommandResult | null): void => { if (!settled) { settled = true; resolve(r); } };

    // ---- the analysis pages
    const freqPage = (key: string, c: { scale: Scale; points: string; fStart: string; fStop: string }, extra?: HTMLElement): { el: HTMLElement; get(): { scale: Scale; points: string; fStart: string; fStop: string } } => {
      const ptsLabel = h("label", null, POINTS_LABEL[c.scale]);
      const sc = radios(`sim-${key}-scale`, SCALES, c.scale, (v) => { ptsLabel.textContent = POINTS_LABEL[v as Scale]; });
      const pts = textInput(c.points || "", undefined, { id: `sim-${key}-points` }), f0 = textInput(c.fStart || "", undefined, { id: `sim-${key}-fstart` }), f1 = textInput(c.fStop || "", undefined, { id: `sim-${key}-fstop` });
      const box = h("div");
      const sb = KD().staticBox(box, "Frequency scale"); sb.append(sc.el);
      const f = h("div", { class: "kv", style: "grid-template-columns:max-content 1fr max-content" }, ptsLabel, pts, h("span"), h("label", null, "Start frequency:"), f0, h("span", { class: "sim-unit" }, "Hz"), h("label", null, "Stop frequency:"), f1, h("span", { class: "sim-unit" }, "Hz"));
      box.append(f); if (extra) box.append(extra);
      return { el: box, get: () => ({ scale: sc.value() as Scale, points: pts.value.trim(), fStart: f0.value, fStop: f1.value }) };
    };
    const freqError = (c: { points: string; fStart: string; fStop: string }): string | null => {
      if (!/^\d+$/.test(c.points) || Number(c.points) < 1) return "The number of points must be a positive integer.";
      if (!Number.isFinite(parseSpiceValue(c.fStart)) || !Number.isFinite(parseSpiceValue(c.fStop))) return "A frequency range must be specified.";
      return null;
    };
    // AC
    { const p = freqPage("ac", parsed.ac || { scale: "dec", points: "", fStart: "", fStop: "" }); pages.AC = p.el; getters.AC = () => { const c = p.get(); const e = freqError(c); return e ? { error: e } : acCommand(c); }; }
    // SP
    {
      const noise = checkbox("Compute noise current correlation matrix", !!parsed.sp?.noise, undefined, { id: "sim-sp-noise" });
      const p = freqPage("sp", parsed.sp || { scale: "dec", points: "", fStart: "", fStop: "" }, noise); pages.SP = p.el;
      getters.SP = () => { const c = p.get(); const e = freqError(c); return e ? { error: e } : spCommand({ ...c, noise: (noise.firstChild as HTMLInputElement).checked }); };
    }
    // DC
    {
      const dc = parsed.dc || { src1: { type: "V", source: "", start: "", stop: "", incr: "" } as DcSrc, src2: null };
      const col = (n: 1 | 2, s: DcSrc | null): { el: HTMLElement; on(): boolean; get(): DcSrc; setFrom(o: DcSrc): void; cur(): DcSrc } => {
        const el = h("div", { class: "sim-dccol" });
        const enable = n === 2 ? checkbox("Source 2", !!s, (on) => sync(on), { id: "sim-dc-en2" }) : null;
        el.append(enable || h("div", { class: "sim-dchead" }, "Source 1"));
        const st = s || { type: "V", source: "", start: "", stop: "", incr: "" } as DcSrc;
        const srcSel = select([], "", undefined, { id: `sim-dc-src${n}` });
        const fill = (t: DcSrc["type"], keep: string): void => {
          const list = t === "V" ? inp.vSources : t === "I" ? inp.iSources : t === "R" ? inp.resistors : [];
          srcSel.innerHTML = ""; for (const x of list) srcSel.append(h("option", { value: x }, x));
          srcSel.value = list.includes(keep) ? keep : list[0] || ""; srcSel.toggleAttribute("disabled", t === "TEMP");
          for (const u of units) u.textContent = DC_UNITS[t];
        };
        const units = [h("span", { class: "sim-unit" }), h("span", { class: "sim-unit" }), h("span", { class: "sim-unit" })];
        const typeSel = select(["V", "I", "R", "TEMP"], st.type, (v) => fill(v as DcSrc["type"], srcSel.value), { id: `sim-dc-type${n}` });
        const a = textInput(st.start, undefined, { id: `sim-dc-start${n}` }), b = textInput(st.stop, undefined, { id: `sim-dc-stop${n}` }), c = textInput(st.incr, undefined, { id: `sim-dc-incr${n}` });
        el.append(h("div", { class: "kv", style: "grid-template-columns:max-content 1fr max-content" },
          h("label", null, "Sweep type:"), typeSel, h("span"), h("label", null, "Source:"), srcSel, h("span"),
          h("label", null, "Starting value:"), a, units[0], h("label", null, "Final value:"), b, units[1], h("label", null, "Increment step:"), c, units[2]));
        fill(st.type, st.source);
        const sync = (on: boolean): void => { for (const x of [typeSel, srcSel, a, b, c]) x.toggleAttribute("disabled", !on || (x === srcSel && typeSel.value === "TEMP")); };
        if (n === 2) sync(!!s);
        const cur = (): DcSrc => ({ type: typeSel.value as DcSrc["type"], source: typeSel.value === "TEMP" ? "TEMP" : srcSel.value, start: a.value, stop: b.value, incr: c.value });
        return { el, on: () => (enable ? (enable.firstChild as HTMLInputElement).checked : true), get: cur, cur, setFrom: (o) => { typeSel.value = o.type; fill(o.type, o.source); a.value = o.start; b.value = o.stop; c.value = o.incr; } };
      };
      const c1 = col(1, dc.src1), c2 = col(2, dc.src2);
      const swap = h("button", { type: "button", id: "sim-dc-swap", onclick: () => { const x = c1.cur(), y = c2.cur(); c1.setFrom(y); c2.setFrom(x); } }, "Swap sources");
      pages.DC = h("div", null, h("div", { class: "sim-dc" }, c1.el, c2.el), h("div", { style: "margin-top:8px" }, swap));
      getters.DC = () => {
        const bad = (s: DcSrc): boolean => [s.start, s.stop, s.incr].some((v) => !Number.isFinite(parseSpiceValue(v)));
        const s1 = c1.get(), s2 = c2.on() ? c2.get() : null;
        if (bad(s1) || (s2 && bad(s2))) return { error: "Invalid DC sweep values." };
        return dcCommand({ src1: s1, src2: s2 });
      };
    }
    // OP
    pages.OP = h("div");
    getters.OP = () => ".op";
    // TRAN
    {
      const t = parsed.tran || { step: "", final: "", initial: "", maxStep: "", uic: false };
      const step = textInput(t.step, undefined, { id: "sim-tran-step" }), fin = textInput(t.final, undefined, { id: "sim-tran-final" });
      const ini = textInput(t.initial, undefined, { id: "sim-tran-initial" }), max = textInput(t.maxStep, undefined, { id: "sim-tran-max" });
      const uic = checkbox("Use initial conditions", t.uic, undefined, { id: "sim-tran-uic" });
      const s = (x: string): HTMLElement => h("span", { class: "sim-unit" }, x);
      pages.TRAN = h("div", null, h("div", { class: "kv", style: "grid-template-columns:max-content minmax(90px,1fr) max-content max-content" },
        h("label", null, "Time step:"), step, s("seconds"), h("span"), h("label", null, "Final time:"), fin, s("seconds"), h("span"),
        h("label", null, "Initial time:"), ini, s("seconds"), s("(optional; default 0)"),
        h("label", null, "Max time step:"), max, s("seconds"), s("(optional; default min{tstep, (tstop-tstart)/50})")), uic);
      getters.TRAN = () => {
        const v = (x: string): boolean => Number.isFinite(parseSpiceValue(x));
        if (!v(step.value) || !v(fin.value) || (ini.value.trim() && !v(ini.value)) || (max.value.trim() && !v(max.value))) return { error: "Invalid transient analysis values." };
        return tranCommand({ step: step.value, final: fin.value, initial: ini.value, maxStep: max.value, uic: (uic.firstChild as HTMLInputElement).checked });
      };
    }
    // FFT
    {
      const f = parsed.fft || { signals: [], linearize: true };
      const chosen = new Set(f.signals.map((x) => x.toLowerCase()));
      const filter = textInput("", undefined, { id: "sim-fft-filter", placeholder: "Filter" });
      const list = h("div", { class: "sim-checklist", id: "sim-fft-list" });
      const sigs = inp.signals.filter((x) => /^V\(/i.test(x) && !/ \(/.test(x));
      const draw = (): void => {
        list.innerHTML = ""; const q = filter.value.trim().toLowerCase();
        for (const s of sigs) { if (q && !s.toLowerCase().includes(q)) continue; const cb = checkbox(s, chosen.has(s.toLowerCase()), (on) => { if (on) chosen.add(s.toLowerCase()); else chosen.delete(s.toLowerCase()); }); list.append(cb); }
      };
      filter.addEventListener("input", draw); draw();
      const lin = checkbox("Linearize inputs before performing FFT", f.linearize, undefined, { id: "sim-fft-lin" });
      pages.FFT = h("div", null, h("label", null, "Input signals:"), filter, list, lin);
      getters.FFT = () => {
        const s = sigs.filter((x) => chosen.has(x.toLowerCase())); for (const x of f.signals) if (!sigs.some((y) => y.toLowerCase() === x.toLowerCase()) && chosen.has(x.toLowerCase())) s.push(x);
        return fftCommand({ signals: s, linearize: (lin.firstChild as HTMLInputElement).checked });
      };
    }
    // NOISE
    {
      const n = parsed.noise || { meas: "", ref: "", src: "", scale: "dec" as Scale, points: "", fStart: "", fStop: "", saveAll: false };
      const meas = select(inp.nets, n.meas, undefined, { id: "sim-noise-meas" }), ref = select([["", ""] as [string, string], ...inp.nets.map((x) => [x, x] as [string, string])], n.ref, undefined, { id: "sim-noise-ref" });
      const src = select(inp.vSources, n.src, undefined, { id: "sim-noise-src" });
      const save = checkbox("Save contributions from all noise generators", n.saveAll, undefined, { id: "sim-noise-save" });
      const top = h("div", { class: "kv", style: "grid-template-columns:max-content 1fr max-content" },
        h("label", null, "Measured node:"), meas, h("span"), h("label", null, "Reference node:"), ref, h("span", { class: "sim-unit" }, "(optional; default GND)"), h("label", null, "Noise source:"), src, h("span"));
      const p = freqPage("noise", n, save); p.el.prepend(top); pages.NOISE = p.el;
      getters.NOISE = () => { const c = p.get(); const e = freqError(c); if (e) return { error: e }; return noiseCommand({ ...c, meas: meas.value, ref: ref.value, src: src.value, saveAll: (save.firstChild as HTMLInputElement).checked }); };
    }
    // Custom
    {
      const ta = h("textarea", { id: "sim-custom", rows: 10, spellcheck: "false", style: "width:100%;font-family:var(--mono,monospace)" }) as HTMLTextAreaElement;
      ta.value = parsed.custom !== undefined && type === "Custom" ? parsed.custom : inp.schDirectives;
      const load = h("button", { type: "button", id: "sim-custom-load", onclick: () => { ta.value = inp.schDirectives; } }, "Load Directives from Schematic");
      pages.Custom = h("div", null, h("label", null, "SPICE directives:"), ta, h("div", { style: "margin-top:6px" }, load));
      getters.Custom = () => ta.value.trim();
    }
    // PZ
    {
      const p = parsed.pz || { input: "", inputRef: "", output: "", outputRef: "", func: "vol" as const, find: "pz" as const };
      const fn = radios("sim-pz-func", [["vol", "(output voltage) / (input voltage)"], ["cur", "(output voltage) / (input current)"]], p.func);
      const sel = (v: string, id: string): HTMLSelectElement => select(inp.nets, v, undefined, { id });
      const i0 = sel(p.input, "sim-pz-in"), i1 = sel(p.inputRef, "sim-pz-inref"), o0 = sel(p.output, "sim-pz-out"), o1 = sel(p.outputRef, "sim-pz-outref");
      const find = radios("sim-pz-find", [["pz", "Poles and Zeros"], ["pol", "Poles"], ["zer", "Zeros"]], p.find);
      pages.PZ = h("div", null, h("label", null, "Transfer function:"), fn.el,
        h("div", { class: "kv", style: "grid-template-columns:max-content 1fr max-content 1fr" }, h("label", null, "Input:"), i0, h("label", null, "Ref:"), i1, h("label", null, "Output:"), o0, h("label", null, "Ref:"), o1),
        h("label", null, "Find:"), find.el);
      getters.PZ = () => pzCommand({ input: i0.value, inputRef: i1.value, output: o0.value, outputRef: o1.value, func: fn.value() as "vol" | "cur", find: find.value() as "pz" | "pol" | "zer" });
    }

    KD().open({
      title, width: 640, persist: false, geomKey: "DIALOG_SIM_COMMAND",
      build(body) {
        KD().notebook(body, [
          { label: "SPICE Command", build(pg) {
            const host = h("div", { class: "sim-pages" });
            const show = (t: SimType): void => { type = t; for (const [k, el] of Object.entries(pages)) if (el) el.hidden = k !== t; };
            if (isNew) {
              const names = NEW_TAB_TYPES.map((t) => [t, `${typeToName(t, true)}  —  ${typeToName(t, false)}`] as [string, string]);
              pg.append(form([["Analysis type:", select(names, "OP", (v) => show(v as SimType), { id: "sim-type" })]]));
            }
            for (const el of Object.values(pages)) if (el) host.append(el);
            pg.append(host); show(type);
            build = () => (getters[type] || (() => inp.command))();
            const cb = (label: string, bit: number, id: string): HTMLElement => checkbox(label, !!(opts & bit), (on) => { opts = on ? opts | bit : opts & ~bit; }, { id });
            pg.append(h("div", { class: "sim-opts" },
              cb("Add full path for .include library directives", OPT_FIX_INCLUDES, "sim-opt-fix"), cb("Save all voltages", OPT_SAVE_V, "sim-opt-v"), cb("Save all currents", OPT_SAVE_I, "sim-opt-i"),
              cb("Save all power dissipations", OPT_SAVE_P, "sim-opt-p"), cb("Save all digital event data", OPT_SAVE_EVENTS, "sim-opt-ev"),
              form([["Compatibility mode:", select(COMPAT_MODES, compat, (v) => { compat = v; }, { id: "sim-compat" })]])));
          } },
          ...(plot ? [{ label: "Plot Setup", build(pg: HTMLElement) {
            plot.axes.forEach((ax, i) => {
              if (!ax) return;
              const f = plot.fixed[i];
              const mn = textInput(f ? toSpiceString(f.min) : "", undefined, { id: `sim-y${i + 1}-min` }), mx = textInput(f ? toSpiceString(f.max) : "", undefined, { id: `sim-y${i + 1}-max` });
              const sync = (on: boolean): void => { mn.disabled = mx.disabled = !on; };
              const lock = checkbox(`Fixed ${ax[0]} scale`, !!f, (on) => { sync(on); upd(); }, { id: `sim-y${i + 1}-lock` });
              const upd = (): void => { const on = (lock.firstChild as HTMLInputElement).checked; const a = parseSpiceValue(mn.value), b = parseSpiceValue(mx.value); plot.fixed[i] = on && Number.isFinite(a) && Number.isFinite(b) ? { min: a, max: b } : on ? { min: NaN, max: NaN } : null; };
              mn.addEventListener("change", upd); mx.addEventListener("change", upd); sync(!!f);
              pg.append(lock, h("div", { class: "kv", style: "grid-template-columns:max-content 1fr max-content 1fr max-content;margin:0 0 8px 22px" }, h("label", null, "Min:"), mn, h("label", null, "Max:"), mx, h("span", { class: "sim-unit" }, ax[1])));
            });
            pg.append(checkbox("Show grid", plot.grid, (on) => { plot.grid = on; }, { id: "sim-grid" }), checkbox("Show legend", plot.legend, (on) => { plot.legend = on; }, { id: "sim-legend" }),
              checkbox("Dotted current/phase", plot.dotted, (on) => { plot.dotted = on; }, { id: "sim-dotted" }));
            const m = (k: "left" | "top" | "right" | "bottom"): HTMLInputElement => { const i = textInput(String(plot.margins[k]), (v) => { const n = parseInt(v, 10); if (n >= 0) plot.margins[k] = n; }, { id: `sim-margin-${k}`, style: "width:60px" }); return i; };
            pg.append(h("label", { style: "margin-top:8px;display:block" }, "Margins:"), h("div", { class: "kv", style: "grid-template-columns:max-content 70px max-content 70px" },
              h("label", null, "Left:"), m("left"), h("label", null, "Top:"), m("top"), h("label", null, "Bottom:"), m("bottom"), h("label", null, "Right:"), m("right")));
          } }] : []),
        ]);
      },
      ok() {
        const r = build();
        if (typeof r !== "string") { void messageBox(r.error); return false; }
        if (plot && plot.fixed.some((f) => f && !(Number.isFinite(f.min) && Number.isFinite(f.max)))) { void messageBox("Invalid fixed scale values."); return false; }
        finish({ command: r, options: opts, compat, plot });
      },
      cancel() { finish(null); },
    });
  });
}

// ---------------------------------------------------------------- DIALOG_SIM_FORMAT_VALUE
const QUANTITY: Record<string, string> = { V: "Voltage", A: "Current", s: "Time", Hz: "Frequency", dB: "Gain", "°": "Phase" };
const RANGES = ["f", "p", "n", "u", "m", "", "K", "M", "G", "T", "P"];
/** DIALOG_SIM_FORMAT_VALUE: "Format <quantity>" with significant digits (1–9) and a range ("Auto" or a fixed prefix). */
export function openFormatValue(format: ValueFormat, units: string): Promise<ValueFormat | null> {
  return new Promise((resolve) => {
    const quantity = QUANTITY[units] || "Value";
    const fixed = units === "°" || units === "dB";
    let prec = format.precision, range = format.range.startsWith("~") ? "~" : format.range.slice(0, format.range.length - units.length);
    let done = false;
    KD().open({
      title: `Format ${quantity}`, width: 300, geomKey: "DIALOG_SIM_FORMAT_VALUE", fixedSize: true,
      build(body) {
        const digits = textInput(String(prec), (v) => { const n = parseInt(v, 10); if (n >= 1 && n <= 9) prec = n; }, { id: "sim-fmt-digits", type: "number", min: "1", max: "9", style: "width:70px" });
        const choices: [string, string][] = fixed ? [["", units]] : [["~", "Auto"], ...RANGES.map((r) => [r, r + units] as [string, string])];
        if (fixed) range = "";
        const rs = select(choices, range, (v) => { range = v; }, { id: "sim-fmt-range", disabled: fixed });
        body.append(form([["Significant digits:", digits], ["Range:", rs]]));
      },
      ok() { done = true; resolve({ precision: Math.min(9, Math.max(1, prec)), range: (range === "~" ? "~" : range) + units }); },
      cancel() { if (!done) resolve(null); },
    });
  });
}
export const formatLabel = (f: ValueFormat): string => formatToString(f);

// ---------------------------------------------------------------- DIALOG_USER_DEFINED_SIGNALS
export const USER_SIGNALS_HELP = `<p>Use this dialog to create user-defined signals from the simulation's vectors, e.g. <code>V(/in) - V(/out)</code> or <code>P(R1) * 1000</code>.</p>
<p>The following functions may be used in signal expressions:</p>
<table class="sim-help"><tr><td>sqrt(x)</td><td>sin(x)</td><td>cos(x)</td><td>tan(x)</td></tr><tr><td>sinh(x)</td><td>cosh(x)</td><td>tanh(x)</td><td>asin(x)</td></tr>
<tr><td>acos(x)</td><td>atan(x)</td><td>asinh(x)</td><td>acosh(x)</td></tr><tr><td>atanh(x)</td><td>arctan(x)</td><td>exp(x)</td><td>ln(x)</td></tr>
<tr><td>log(x)</td><td>abs(x)</td><td>nint(x)</td><td>int(x)</td></tr><tr><td>floor(x)</td><td>ceil(x)</td><td>pow(x, y)</td><td>pwr(x, y)</td></tr>
<tr><td>min(x, y)</td><td>max(x, y)</td><td>sgn(x)</td><td>ternary_fcn(x, y, z)</td></tr><tr><td>gauss(nom, rvar, sigma)</td><td>agauss(nom, avar, sigma)</td><td>unif(nom, rvar)</td><td>aunif(nom, avar)</td></tr>
<tr><td>limit(nom, avar)</td><td></td><td></td><td></td></tr></table>
<p>Signals: <code>V(net)</code>, <code>I(device)</code>, <code>P(device)</code>; operators <code>+ - * / ^</code> and parentheses.</p>`;

/** The user-defined signals list; resolves with the new list, or null when cancelled. */
export function openUserDefinedSignals(signals: string[], validate: (expr: string) => string | null): Promise<string[] | null> {
  return new Promise((resolve) => {
    const rows = signals.map((s) => ({ expr: s }));
    let done = false;
    KD().open({
      title: "User-defined Signals", width: 520, geomKey: "DIALOG_USER_DEFINED_SIGNALS",
      build(body) {
        const info = h("div", { class: "sim-infobar", hidden: true, id: "sim-uds-info" });
        body.append(info);
        const host = h("div"); body.append(host);
        const g = KD().grid(host, [{ key: "expr", label: "Signal", width: 460 }], rows, { height: 220, buttons: { add: () => ({ expr: "" }), addTitle: "Add field", remove: true, removeTitle: "Delete field" } });
        const help = h("a", { href: "#", id: "sim-uds-help", title: "Show syntax help window", onclick: (e: Event) => {
          e.preventDefault();
          KD().open({ title: "Syntax Help", width: 560, child: true, readOnly: true, build(b) { const d = h("div", { class: "sim-helpbody" }); d.innerHTML = USER_SIGNALS_HELP; b.append(d); } });
        } }, "Syntax help");
        if (g.bar) g.bar.append(h("span", { style: "margin-left:auto" }, help)); else body.append(help);
        (body as HTMLElement & { _info?: HTMLElement })._info = info;
      },
      ok() {
        const list = rows.map((r) => r.expr.trim());
        for (const e of list) { if (!e) continue; const err = validate(e); if (err) { void messageBox(err); return false; } }
        done = true; resolve(list.filter(Boolean));
      },
      cancel() { if (!done) resolve(null); },
    });
  });
}

/** A bitmap "×" style close for a tuner, small_trash as KiCad's TUNER_SLIDER uses. */
export const tunerCloseButton = (fn: () => void): HTMLButtonElement => bitmapButton("small_trash", "Remove tuner", fn, { flat: true });
