// worker.ts — the modelling worker (static/dist/cad-worker.js): OpenCascade, the regeneration engine and the
// worker services, off the page's thread.  The protocol is protocol.ts.  Messages are handled one at a time in
// the order they arrive, except that a regeneration is skipped when a newer one is already waiting.
import { loadKernel } from "./load";
import { FEATURES, SERVICES, RegenEngine, resultBuffers, type FromWorker, type ToWorker } from "./index";
import { transferables } from "./ops/exchange-export";

/* eslint-disable @typescript-eslint/no-explicit-any */
const scope = self as any;
const post = (msg: FromWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

let engine: RegenEngine | null = null;
let starting: Promise<void> | null = null;
const queue: ToWorker[] = [];
let busy = false;

async function handle(msg: ToWorker): Promise<void> {
  if (msg.t === "init") {
    if (!starting) {
      const t0 = Date.now();
      starting = loadKernel({ wasmUrl: msg.wasmUrl, module: msg.module }).then((k) => { engine = new RegenEngine(k, FEATURES); post({ t: "ready", ms: Date.now() - t0 }); })
        .catch((e) => { starting = null; post({ t: "failed", message: `The modelling kernel could not start: ${e && e.message ? e.message : e}` }); });
    }
    await starting;
    return;
  }
  if (starting) await starting;
  if (!engine) { if (msg.t === "call") post({ t: "call", seq: msg.seq, ok: false, error: "The modelling kernel is not running." }); return; }
  if (msg.t === "regen") {
    if (queue.some((m) => m.t === "regen")) return;   // superseded before it started
    const total = Math.min(msg.rollback, msg.features.length);
    try {
      const result = await engine.regenerate(msg.features, msg.rollback, msg.have, (index, featureId) => post({ t: "progress", seq: msg.seq, index, total, featureId }));
      post({ t: "regen", seq: msg.seq, result }, resultBuffers(result));
    } catch (e) {
      // the engine reports a feature's failure itself; this is the engine failing
      post({ t: "failed", message: `Regeneration failed: ${engine.k.describe(e)}` });
    }
    return;
  }
  if (msg.t === "call") {
    const svc = SERVICES.find((s) => s.name === msg.service);
    const k = engine.k, state = engine.state;
    if (!svc) { post({ t: "call", seq: msg.seq, ok: false, error: `No kernel service is called "${msg.service}".` }); return; }
    const mine: { delete(): void }[] = [];
    k.scope = mine;
    try {
      const value = await svc.run({ oc: k.oc, k, state, before: (id) => (engine ? engine.before(id) : null), fail: (m) => new Error(m) }, msg.args);
      // a file in the result (an export) is a typed array: transferred, not copied
      post({ t: "call", seq: msg.seq, ok: true, value }, transferables(value));
    } catch (e) { post({ t: "call", seq: msg.seq, ok: false, error: k.describe(e) }); }
    finally { k.scope = null; for (const o of mine.reverse()) { try { o.delete(); } catch (x) { /* already gone */ } } }
  }
}

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  while (queue.length) await handle(queue.shift()!);
  busy = false;
}

scope.onmessage = (ev: MessageEvent<ToWorker>) => { queue.push(ev.data); void pump(); };
