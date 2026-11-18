// ngspice for the simulator and the plugins: the circuit simulator behind the simulator frame (sim/frame.ts), the
// `ngspice` program and the libngspice stand-in of the Python runtime (plugins/python/kicad_spice.py).  The simulator
// is the real ngspice, compiled to WebAssembly with XSPICE (scripts/ngspice-wasm/build.sh, plugins/ngspice-module.ts);
// it runs as the interactive program does, reading one command after another.  This file gives that a session: run
// some commands and get what ngspice printed, and reach its files.
//
// Two ways to run it:
//   * open(url): in this thread.  The plugin frame uses it (its Python waits on the promise with run_sync).
//   * openWorker(url): in a dedicated Web Worker, as libngspice runs in its own thread for KiCad (NGSPICE's
//     background thread): the page stays live during a long analysis, progress comes as ngspice reports it
//     (SetAnalyse, libngspice's status callback) and Stop halts the run (NGSPICE::Stop's bg_halt: the analysis ends
//     where it is and keeps its points); a run that does not give way in time is ended with the worker, and the next
//     session starts a new one.
//
// The worker runs the same session code as this thread: `sessionCode` is self-contained and is sent to the worker as
// its source, so there is one implementation of the session.

export interface SpiceResult { out: string; err: string[]; halted?: boolean }
export interface SpiceSession {
  exec(commands: string[]): Promise<SpiceResult>;
  write(path: string, data: Uint8Array | string): void;
  read(path: string): Uint8Array | null;
  list(dir: string): string[];
  remove(path: string): void;
  version: string;
  /** ngspice ended (a fatal error: it called exit); the session takes no more commands and a new one is needed */
  readonly dead: boolean;
}
/** A session in a worker: the same calls, its file reads answered later; progress and Stop. */
export interface WorkerSpiceSession {
  exec(commands: string[]): Promise<SpiceResult>;
  write(path: string, data: Uint8Array | string): void;
  read(path: string): Promise<Uint8Array | null>;
  list(dir: string): Promise<string[]>;
  remove(path: string): void;
  /** NGSPICE::Stop: halt the running analysis (its results so far are kept); the worker is ended when ngspice does
   *  not give way within `graceMs` */
  halt(graceMs?: number): void;
  /** end the worker */
  close(): void;
  version: string;
  readonly dead: boolean;
}
export interface Progress { analysis: string; permille: number; text: string }

/** The session code: a function of nothing but its arguments (it is also the worker's source). */
function sessionCode(): { open: (url: string, progress?: (analysis: string, permille: number) => boolean | Promise<boolean>) => Promise<SpiceSession> } {
  /** ngspice's own chatter about every start: not errors, and not for the console. */
  const quietly = async <T,>(job: () => Promise<T>): Promise<T> => {
    const real = console.error; console.error = () => undefined;
    try { return await job(); } finally { console.error = real; }
  };
  async function open(url: string, progress?: (analysis: string, permille: number) => boolean | Promise<boolean>): Promise<SpiceSession> {
    const mod: any = await import(url);
    const sim: any = new mod.Simulation();
    let done: (() => void) | null = null;
    // ngspice asks for its next command list here: the one it had is finished
    sim.waitForNextRun = () => { const d = done; done = null; if (d) d(); return new Promise<void>((go) => { sim.continuePromiseResolve = go; }); };
    if (progress) sim.kcProgress = progress;
    await quietly(() => sim.start());
    const fs: any = sim.__getSpiceModuleForTests().FS;
    const version = (/ngspice-([\w.]+)/.exec(String(sim.getInitInfo())) || ["", ""])[1];
    let busy: Promise<unknown> = Promise.resolve();
    let dead = false;
    const fatal = (): boolean => (sim.error as string[]).some((e) => /fatal error in ngspice/i.test(String(e)));
    const exec = (commands: string[]): Promise<SpiceResult> => {
      const turn = busy.then(() => quietly(async () => {
        if (dead) return { out: "", err: ["ngspice has stopped; start it again."] };
        sim.info = ""; sim.error = [];
        sim.commandList = [" ", ...commands.map((c) => (c === "source test.cir" ? "source ./test.cir" : c))];
        const finished = new Promise<void>((ok) => { done = ok; });
        // a fatal error ends ngspice (controlled_exit) without its asking for more: the turn ends there
        const watch = setInterval(() => { if (fatal()) { dead = true; const d = done; done = null; if (d) d(); } }, 50);
        sim.continueRun();
        await finished;
        clearInterval(watch);
        return { out: String(sim.info), err: (sim.error as string[]).slice() };
      }));
      busy = turn.catch(() => undefined);
      return turn;
    };
    return {
      exec, version, get dead() { return dead; },
      write(path, data) { const dir = path.slice(0, path.lastIndexOf("/")); if (dir) fs.mkdirTree(dir); fs.writeFile(path, data); },
      read(path) { try { return fs.readFile(path) as Uint8Array; } catch { return null; } },
      list(dir) { try { return (fs.readdir(dir) as string[]).filter((n) => n !== "." && n !== ".."); } catch { return []; } },
      remove(path) { try { fs.unlink(path); } catch { /* not there */ } },
    };
  }
  return { open };
}

export const open = (url: string): Promise<SpiceSession> => sessionCode().open(url);

/** The worker: the session code, and a message loop around one session.  Progress goes out at most every 150 ms
 *  (sharedspice.c's DELTATIME, with its text: "tran: 45.3%"); every 100 ms the run gives way so a halt can come in. */
function workerMain(code: typeof sessionCode): void {
  const post = (m: unknown, t?: Transferable[]): void => (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(m, t || []);
  // a halt names the last command list sent before it (`upTo`): that one and any earlier one still to run are halted,
  // so a Stop that comes in while an earlier list is running, or before its list is reached, is not lost
  let session: SpiceSession | null = null, haltUpTo = 0, current = 0, lastPost = 0, lastYield = Date.now();
  const halted = (): boolean => current > 0 && current <= haltUpTo;
  const say = (analysis: string, permille: number): string =>
    permille < 0 || permille >= 1000 ? "--ready--" : permille === 0 ? analysis : analysis === "shooting" ? `${analysis}: ${permille}` : `${analysis}: ${(permille / 10).toFixed(1)}%`;
  const progress = async (analysis: string, permille: number): Promise<boolean> => {
    const now = Date.now();
    if (now - lastPost > 150 || permille === 0 || permille >= 1000) { lastPost = now; post({ kind: "progress", analysis, permille, text: say(analysis, permille) }); }
    if (now - lastYield > 100) { lastYield = now; await new Promise((go) => setTimeout(go, 0)); lastYield = Date.now(); }
    return halted();
  };
  let queue: Promise<unknown> = Promise.resolve();
  self.onmessage = (ev: MessageEvent) => {
    const m = ev.data as { kind: string; id?: number; upTo?: number; url?: string; commands?: string[]; path?: string; data?: Uint8Array | string };
    if (m.kind === "halt") { haltUpTo = Math.max(haltUpTo, m.upTo || 0); return; }
    queue = queue.then(async () => {
      try {
        if (m.kind === "open") { session = await code().open(m.url || "", progress); post({ kind: "reply", id: m.id, version: session.version }); return; }
        if (!session) throw new Error("ngspice is not started");
        if (m.kind === "exec") {
          current = m.id || 0; lastYield = Date.now();
          const r = await session.exec(halted() ? [] : m.commands || []);
          const was = halted(); current = 0;
          post({ kind: "reply", id: m.id, result: { ...r, halted: was }, dead: session.dead });
        } else if (m.kind === "write") session.write(m.path || "", m.data || "");
        else if (m.kind === "remove") session.remove(m.path || "");
        else if (m.kind === "read") { const d = session.read(m.path || ""); const c = d ? new Uint8Array(d) : null; post({ kind: "reply", id: m.id, data: c }, c ? [c.buffer] : []); }
        else if (m.kind === "list") post({ kind: "reply", id: m.id, names: session.list(m.path || "") });
      } catch (e) { post({ kind: "reply", id: m.id, error: e instanceof Error ? e.message : String(e) }); }
    });
  };
}

/** A session in its own worker.  `onProgress` gets ngspice's progress reports while a command runs; `onExit` is called
 *  when the worker is ended (halted without giving way, or failed). */
export async function openWorker(url: string, onProgress?: (p: Progress) => void): Promise<WorkerSpiceSession> {
  const abs = new URL(url, location.href).href;
  const src = `(${workerMain.toString()})(${sessionCode.toString()});`;
  const blob = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const worker = new Worker(blob, { type: "module", name: "ngspice" });
  URL.revokeObjectURL(blob);
  let seq = 0, dead = false, killTimer = 0, haltUpTo = 0;
  /** the command lists sent and not answered yet */
  const execs = new Set<number>();
  const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  const end = (why: string, halted: boolean): void => {
    if (dead) return;
    dead = true; clearTimeout(killTimer); worker.terminate();
    for (const [, w] of waiting) w.ok({ result: { out: "", err: halted ? [] : [why], halted }, dead: true, data: null, names: [] });
    waiting.clear();
  };
  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data as { kind: string; id: number; error?: string } & Record<string, unknown>;
    if (m.kind === "progress") { if (onProgress) onProgress(m as unknown as Progress); return; }
    const w = waiting.get(m.id); if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.fail(new Error(m.error)); else w.ok(m);
  };
  worker.onerror = (e) => { e.preventDefault(); const why = `ngspice stopped: ${e.message || "the worker failed"}`; for (const [, w] of waiting) w.fail(new Error(why)); waiting.clear(); dead = true; worker.terminate(); };
  const ask = (msg: Record<string, unknown>): Promise<any> => {
    if (dead) return Promise.reject(new Error("ngspice has stopped; start it again."));
    const id = ++seq;
    return new Promise((ok, fail) => { waiting.set(id, { ok, fail }); worker.postMessage({ ...msg, id }); });
  };
  const tell = (msg: Record<string, unknown>): void => { if (!dead) worker.postMessage(msg); };
  const opened = await ask({ kind: "open", url: abs });
  const version = String(opened.version || "");
  return {
    version, get dead() { return dead; },
    async exec(commands) {
      if (dead) return { out: "", err: ["ngspice has stopped; start it again."] };
      const id = seq + 1; execs.add(id);
      try {
        const r = await ask({ kind: "exec", commands });
        if (r.dead) dead = true;
        return r.result as SpiceResult;
      } finally {
        execs.delete(id);
        // the halted lists have all given way: the worker is not ended
        if (![...execs].some((x) => x <= haltUpTo)) { clearTimeout(killTimer); killTimer = 0; }
      }
    },
    write(path, data) { tell({ kind: "write", path, data }); },
    remove(path) { tell({ kind: "remove", path }); },
    async read(path) { if (dead) return null; const r = await ask({ kind: "read", path }); return (r.data as Uint8Array) || null; },
    async list(dir) { if (dead) return []; const r = await ask({ kind: "list", path: dir }); return (r.names as string[]) || []; },
    halt(graceMs = 1500) {
      if (dead) return;
      haltUpTo = seq;
      worker.postMessage({ kind: "halt", upTo: haltUpTo });
      // the worker is ended only when a command list it is running or still has to run does not give way in time
      if (execs.size && !killTimer) killTimer = window.setTimeout(() => end("Simulation stopped.", true), graceMs);
    },
    close() { end("ngspice was closed.", false); },
  };
}

(globalThis as any).__kcSpice = { open };
