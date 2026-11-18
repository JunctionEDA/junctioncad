// client.ts — the page's end of the modelling worker.  Nothing here loads until the first regeneration asks
// for it: opening a board never fetches the kernel.
//
//   const kernel = new KernelClient();
//   const result = await kernel.regenerate(features, rollback);   // null when a newer request overtook it
//   const mass = await kernel.call("mass-properties", { body });
//
// The client remembers which body revisions it has meshes for, so an edit sends back only the bodies it changed.
import type { Json } from "../../../shared/itemdoc/itemdoc";
import type { BodyMesh, FeatureInput, FromWorker, RegenResult, ToWorker } from "./protocol";
import { compileKernel } from "./wasm";

export type KernelState = "idle" | "loading" | "ready" | "working" | "failed";
export interface KernelOptions {
  workerUrl?: string; wasmUrl?: string;
  onState?(state: KernelState, message?: string): void;
  onProgress?(index: number, total: number, featureId: string): void;
}

const assetV = (): string => { const v = (globalThis as { __kcAssetV?: string }).__kcAssetV; return v ? "?v=" + v : ""; };

/** The page's compiled kernel, by URL; null when it could not be compiled here (each worker then tries for itself). */
const modules = new Map<string, Promise<WebAssembly.Module | null>>();
function sharedModule(url: string): Promise<WebAssembly.Module | null> {
  let m = modules.get(url);
  if (!m) {
    m = compileKernel(url).catch(() => { modules.delete(url); return null; });
    modules.set(url, m);
  }
  return m;
}

export class KernelClient {
  state: KernelState = "idle";
  private worker: Worker | null = null;
  private seq = 0;
  private regens = new Map<number, (r: RegenResult | null) => void>();
  private calls = new Map<number, { resolve(v: Json): void; reject(e: Error): void }>();
  /** body revision → its mesh, for the bodies of the last result */
  readonly meshes = new Map<number, BodyMesh>();
  private outstanding = 0;

  constructor(private readonly opts: KernelOptions = {}) {}

  private setState(s: KernelState, message?: string): void { this.state = s; this.opts.onState?.(s, message); }

  private start(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(this.opts.workerUrl || "/static/dist/cad-worker.js" + assetV());
    this.worker = w;
    this.setState("loading");
    w.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(ev.data);
    w.onerror = (ev) => { this.fail(`The modelling worker stopped: ${ev.message || "unknown error"}`); };
    // The kernel is compiled once per page and handed to every worker: an assembly's second and third worker
    // start without downloading or compiling 23 MB again.  Messages wait their turn behind it.
    const wasmUrl = new URL(this.opts.wasmUrl || "/static/pyodide/occ-kernel.wasm", location.href).href;
    this.sending = sharedModule(wasmUrl).then((module) => { if (this.worker === w) w.postMessage({ t: "init", wasmUrl, module } satisfies ToWorker); });
    return w;
  }

  /** what is still to be handed to the worker, in order (the init waits for the page's compiled kernel) */
  private sending: Promise<void> = Promise.resolve();
  private post(msg: ToWorker): void { const w = this.worker!; this.sending = this.sending.then(() => { if (this.worker === w) w.postMessage(msg); }); }

  private fail(message: string): void {
    this.setState("failed", message);
    for (const r of this.regens.values()) r(null);
    for (const c of this.calls.values()) c.reject(new Error(message));
    this.regens.clear(); this.calls.clear(); this.outstanding = 0;
    if (this.worker) { this.worker.terminate(); this.worker = null; }   // the next request starts a fresh one
  }

  private onMessage(msg: FromWorker): void {
    switch (msg.t) {
      case "ready": this.setState(this.outstanding ? "working" : "ready"); return;
      case "failed": this.fail(msg.message); return;
      case "progress": this.opts.onProgress?.(msg.index, msg.total, msg.featureId); return;
      case "regen": {
        // meshes the worker left out are the ones this side said it has
        const live = new Set<number>();
        for (const b of msg.result.bodies) { if (b.mesh) this.meshes.set(b.rev, b.mesh); else b.mesh = this.meshes.get(b.rev); live.add(b.rev); }
        for (const rev of Array.from(this.meshes.keys())) if (!live.has(rev)) this.meshes.delete(rev);
        // every request up to this one is answered: older ones were overtaken
        for (const [seq, resolve] of Array.from(this.regens)) { if (seq > msg.seq) continue; this.regens.delete(seq); resolve(seq === msg.seq ? msg.result : null); }
        this.done();
        return;
      }
      case "call": {
        const c = this.calls.get(msg.seq); if (!c) return;
        this.calls.delete(msg.seq);
        if (msg.ok) c.resolve(msg.value); else c.reject(new Error(msg.error));
        this.done();
        return;
      }
    }
  }
  private done(): void { this.outstanding = this.regens.size + this.calls.size; if (this.state === "working" && !this.outstanding) this.setState("ready"); }

  /** Build `features[0 .. rollback)`.  Resolves with null when a newer regeneration was asked for meanwhile. */
  regenerate(features: FeatureInput[], rollback: number): Promise<RegenResult | null> {
    this.start();
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.regens.set(seq, resolve); this.outstanding++;
      if (this.state === "ready") this.setState("working");
      this.post({ t: "regen", seq, features, rollback, have: Array.from(this.meshes.keys()) });
    });
  }

  /** Ask a worker service (services/*.ts) a question about the model on screen. */
  call<T extends Json = Json>(service: string, args: Json = null): Promise<T> {
    this.start();
    const seq = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(seq, { resolve: resolve as (v: Json) => void, reject }); this.outstanding++;
      if (this.state === "ready") this.setState("working");
      this.post({ t: "call", seq, service, args });
    });
  }

  dispose(): void {
    if (this.worker) this.worker.terminate();
    this.worker = null; this.meshes.clear();
    for (const r of this.regens.values()) r(null);
    this.regens.clear(); this.calls.clear();
    this.state = "idle";
  }
}
