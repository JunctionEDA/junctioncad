// kernels.ts — the modelling workers an assembly runs to build its parts.
//
// A worker holds one part studio's model at a time (the regeneration engine caches one feature list), so each
// part studio an assembly reads gets a worker of its own, and an edit to that studio rebuilds only what
// changed.  Workers are costly (each loads the kernel), so only the most recently used few are kept; a studio
// whose worker was retired gets a fresh one, and a full rebuild, the next time it changes.
import { KernelClient, type FeatureInput, type KernelState, type RegenResult } from "../../mechanical/api";

interface Slot { client: KernelClient; used: number; busy: number; state: KernelState; message?: string }

export class KernelPool {
  private readonly slots = new Map<string, Slot>();
  private tick = 0;
  /** called when a worker starts, finishes or fails: the editor shows "building…" */
  onActivity: () => void = () => {};

  constructor(private readonly max = 3) {}

  private slot(docId: string): Slot {
    let s = this.slots.get(docId);
    if (!s) {
      const made: Slot = { client: null as unknown as KernelClient, used: 0, busy: 0, state: "idle" };
      made.client = new KernelClient({ onState: (state, message) => { made.state = state; made.message = message; this.onActivity(); } });
      this.slots.set(docId, made);
      s = made;
      // retire the least recently used idle worker beyond the limit
      while (this.slots.size > this.max) {
        let victim: string | null = null, oldest = Infinity;
        for (const [id, x] of this.slots) if (id !== docId && !x.busy && x.used < oldest) { oldest = x.used; victim = id; }
        if (!victim) break;
        this.slots.get(victim)!.client.dispose();
        this.slots.delete(victim);
      }
    }
    s.used = ++this.tick;
    return s;
  }

  /** Build a part studio.  Resolves with null when a newer request for the same studio overtook this one, or the kernel failed. */
  async regenerate(docId: string, features: FeatureInput[], rollback: number): Promise<RegenResult | null> {
    const s = this.slot(docId);
    s.busy++; this.onActivity();
    try { return await s.client.regenerate(features, rollback); }
    finally { s.busy--; this.onActivity(); }
  }

  /** The worker that holds this studio's model, or null when it has none (never built here, or retired). */
  clientFor(docId: string): KernelClient | null { return this.slots.get(docId)?.client || null; }
  /** How many studios are being built right now. */
  get working(): number { let n = 0; for (const s of this.slots.values()) if (s.busy) n++; return n; }
  /** The message of a kernel that could not start, if any. */
  get failure(): string | null { for (const s of this.slots.values()) if (s.state === "failed") return s.message || "The modelling kernel could not start."; return null; }
  /** True when any worker was ever started (a test asks: did opening this assembly need the kernel?). */
  get started(): number { return this.tick; }
  /** How many workers are alive now (one per source document built in this session, the most recent few). */
  get workers(): number { return this.slots.size; }
  forget(docId: string): void { const s = this.slots.get(docId); if (s && !s.busy) { s.client.dispose(); this.slots.delete(docId); } }
  dispose(): void { for (const s of this.slots.values()) s.client.dispose(); this.slots.clear(); }
}
