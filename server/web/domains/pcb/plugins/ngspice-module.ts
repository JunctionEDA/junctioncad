// ngspice-module — the JavaScript face of the ngspice WebAssembly build (scripts/ngspice-wasm/build.sh: ngspice 45.2
// with XSPICE and its code models).  build-python.mjs bundles this file with the build's emscripten module
// (vendor/ngspice/ngspice-core.mjs) into static/dist/pyodide/ngspice.mjs, served as /static/pyodide/ngspice.mjs.
//
// It keeps the interface of the Simulation class of EEcircuit-Engine (MIT), which the callers were written against:
// plugins/spice.ts (the simulator's and the plugins' session), mcp/simulate.ts (the assistant's simulate tool) and
// scripts/plugin-spice.mjs.  ngspice runs as the interactive program: it asks for one command after another
// (getInput); when it has read the last of the list it gives way (handleThings) and waits until it is given more.
//
// Two additions: `kcProgress(analysis, permille)` is ngspice's SetAnalyse (the libngspice status callback KiCad's
// status bar shows), awaited, so the page can take its events during a run and answer true to stop it there; and the
// init script loads the code models (spinit's `codemodel` lines), linked into ngspice itself.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — emscripten's module, made by build.sh; no types
import Module from "../../../../vendor/ngspice/ngspice-core.mjs";

export type RealNumber = number;
export interface ComplexNumber { real: number; img: number }
export interface DataVector { name: string; type: string; values: (RealNumber | ComplexNumber)[] }
export interface ResultType { header: string; numVariables: number; variableNames: string[]; numPoints: number; dataType: "real" | "complex"; data: DataVector[] }

/** The init file: spinit's settings and its code model libraries (kc_static_cm.c answers `codemodel`). */
const SPINIT = [
  "* Standard ngspice init file",
  "alias exit quit",
  "alias acct rusage all",
  "set x11lineararcs",
  "unset osdi_enabled",
  "if $?xspice_enabled",
  ...["spice2poly", "analog", "digital", "xtradev", "xtraevt", "table", "tlines"].map((l) => ` codemodel /usr/local/lib/ngspice/${l}.cm`),
  "end",
  "",
].join("\n");

/** ngspice's routine notes on stderr: not errors. */
const ROUTINE = new Set(["Warning: can't find the initialization file spinit.", "Using SPARSE 1.3 as Direct Linear Solver", "Note: Starting dynamic gmin stepping", "Note: Dynamic gmin stepping completed"]);

/** A binary raw file (`write`) as vectors; the "notype" ones left out. */
export function readOutput(raw: Uint8Array): ResultType {
  const data = new Uint8Array(raw);
  const text = new TextDecoder("latin1").decode(data);
  const at = text.indexOf("Binary:\n");
  const header = (at >= 0 ? text.slice(0, at) : text) + "\n";
  const lines = header.split("\n");
  const field = (k: string): string => { const l = lines.find((s) => s.startsWith(k)); return l ? l.slice(l.indexOf(":") + 1).trim() : ""; };
  const nv = parseInt(field("No. Variables"), 10) || 0, np = parseInt(field("No. Points"), 10) || 0;
  const complex = /complex/i.test(field("Flags"));
  const vi = lines.indexOf("Variables:");
  const vars = Array.from({ length: nv }, (_, i) => { const p = (lines[vi + 1 + i] || "").split(/\s+/).filter(Boolean); return { name: p[1] || "", type: p[2] || "notype" }; });
  const view = at >= 0 ? new DataView(data.buffer, data.byteOffset + at + 8) : new DataView(new ArrayBuffer(0));
  const per = complex ? 16 : 8;
  const cols: (RealNumber | ComplexNumber)[][] = vars.map(() => []);
  for (let p = 0; p < np; p++) for (let v = 0; v < nv; v++) {
    const o = (p * nv + v) * per; if (o + per > view.byteLength) break;
    cols[v].push(complex ? { real: view.getFloat64(o, true), img: view.getFloat64(o + 8, true) } : view.getFloat64(o, true));
  }
  const kept = vars.map((v, i) => ({ name: v.name, type: v.type, values: cols[i] })).filter((v) => v.type !== "notype");
  return { header, numVariables: kept.length, variableNames: kept.map((v) => v.name), numPoints: np, dataType: complex ? "complex" : "real", data: kept };
}

export class Simulation {
  private static readonly MAX_INFO_CHARS = 2_000_000;
  commandList: string[] = [" ", "source test.cir", "destroy all", "run", "write out.raw"];
  info = "";
  error: string[] = [];
  /** SetAnalyse: what ngspice is doing and how far (in 1/1000), awaited; true stops the analysis there. */
  kcProgress: ((analysis: string, permille: number) => boolean | Promise<boolean>) | null = null;
  continuePromiseResolve: (() => void) | null = null;
  private cmd = 0;
  private cleanupPending = false;
  private netList = "";
  private initInfo = "";
  private initialized = false;
  private module: any = null;
  private startPromise: Promise<void> | null = null;
  private initResolve: (() => void) | null = null;
  private runResolve: ((r: ResultType) => void) | null = null;

  __getSpiceModuleForTests(): any { return this.module; }
  getInfo = (): string => this.info;
  getInitInfo = (): string => this.initInfo;
  getError = (): string[] => this.error;
  isInitialized = (): boolean => this.initialized;

  private getInput = (): string => {
    let c = " ";
    if (this.cmd < this.commandList.length) {
      c = this.commandList[this.cmd];
      // runSim's fixed list: the previous circuit goes before the next is read
      if (c === "source test.cir" && this.cleanupPending) { c = "remcirc"; this.cleanupPending = false; }
      else { this.cmd++; if (c === "source test.cir") this.cleanupPending = true; }
    } else this.cmd = 0;
    return c;
  };

  /** The next command list: called when ngspice has read the last one.  A session replaces it. */
  waitForNextRun = (): Promise<void> => new Promise<void>((go) => { this.continuePromiseResolve = go; });

  continueRun = (): void => { const go = this.continuePromiseResolve; this.continuePromiseResolve = null; if (go) go(); };

  private async startInternal(): Promise<void> {
    const options: any = {
      noInitialRun: true,
      print: (e = "") => { this.info = (this.info + e + "\n").slice(-Simulation.MAX_INFO_CHARS); },
      printErr: (e = "") => {
        this.info = (this.info + e + "\n\n").slice(-Simulation.MAX_INFO_CHARS);
        if (!ROUTINE.has(e)) { console.error(e); this.error.push(e); }
      },
      kcProgress: async (analysis: string, permille: number) => (this.kcProgress ? !!(await this.kcProgress(analysis, permille)) : false),
    };
    const m = this.module || (this.module = await Module(options));
    m.kcProgress = options.kcProgress;
    m.FS.mkdirTree("/usr/local/share/ngspice/scripts");
    m.FS.writeFile("/usr/local/share/ngspice/scripts/spinit", SPINIT);
    m.FS.writeFile("/spinit", SPINIT);
    try { m.FS.mkdirTree("/proc"); m.FS.writeFile("/proc/meminfo", "MemTotal: 2097152 kB\nMemFree: 2097152 kB\nMemAvailable: 2097152 kB\n"); } catch { /* there */ }
    m.setHandleThings(() => {
      m.Asyncify.handleAsync(async () => {
        if (this.cmd === 0) {
          try {
            const raw = m.FS.readFile("out.raw") as Uint8Array;
            const r = readOutput(raw);
            if (this.runResolve) { this.runResolve(r); this.runResolve = null; }
          } catch { /* no results: the run failed, or the list was a session's own */ }
        }
        if (!this.initialized) {
          this.initialized = true; this.initInfo = this.info;
          if (this.initResolve) { this.initResolve(); this.initResolve = null; }
        }
        if (this.cmd === 0) {
          await this.waitForNextRun();
          m.FS.writeFile("/test.cir", this.netList);
        }
      });
    });
    m.setGetInput(this.getInput);
    m.runThings();
  }

  start = (): Promise<void> => {
    if (this.initialized) return Promise.resolve();
    if (!this.startPromise) { this.startPromise = new Promise<void>((ok) => { this.initResolve = ok; }); void this.startInternal(); }
    return this.startPromise;
  };

  /** One run of the netlist set with setNetList: its results, read from the raw file it wrote. */
  runSim = async (): Promise<ResultType> => {
    await this.start();
    this.info = ""; this.error = [];
    const result = new Promise<ResultType>((ok) => { this.runResolve = ok; });
    this.continueRun();
    return result;
  };

  setNetList = (input: string): void => {
    this.netList = input;
    this.commandList = /^\s*\.noise\b/im.test(input)
      ? [" ", "source test.cir", "destroy all", "run", "setplot noise1", "write out.raw"]
      : [" ", "source test.cir", "destroy all", "run", "write out.raw"];
  };
}
