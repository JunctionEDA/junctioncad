// part.ts — the "part" source: a body of a part studio (`{ kind: "part", docId, body }`).
//
// The handle joins the part studio's document like an editor would (ItemDocSession), so it sees every edit as
// it is made, and turns the document into meshes without the person ever opening that tab: from the cache when
// this content was built before (cache.ts), else in a modelling worker (kernels.ts).  A regeneration is keyed
// by the document's content, so a rename or a reconnect costs nothing.
import { stableJson } from "../../../shared/itemdoc/itemdoc";
import { ItemDocSession } from "../../../shared/itemdoc/sync";
import { BoardFeed, PART_STUDIO_KIND, studioInputs, type FeatureInput } from "../../mechanical/api";
import { fingerprint, readCached, writeCached } from "./cache";
import type { KernelPool } from "./kernels";
import type { SourceEnv, SourceHandle, SourcePiece, SourceProvider, SourceSnapshot } from "./types";

const assetV = (): string => String((globalThis as { __kcAssetV?: string }).__kcAssetV || "");

class PartHandle implements SourceHandle {
  private snap: SourceSnapshot = { status: "loading", message: "Opening the part studio…", pieces: [], version: 0 };
  private readonly session: ItemDocSession;
  private builtHash = "";
  private wantHash = "";
  private input: { features: FeatureInput[]; rollback: number } | null = null;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** the regeneration on its way, and the content the pool's worker last built (it may hold nothing: cache.ts) */
  private inFlight: Promise<unknown> | null = null;
  private workerHash = "";
  /** the boards of the studio's Board features, read live: the studio is built with them, and again when they change */
  private readonly boards: BoardFeed;

  constructor(private readonly docId: string, private readonly env: SourceEnv, private readonly pool: KernelPool) {
    this.boards = new BoardFeed({ signedIn: env.signedIn, changed: () => this.schedule() });
    this.session = new ItemDocSession({
      docId, signedIn: env.signedIn, expectKind: PART_STUDIO_KIND,
      onChange: () => this.schedule(),
      onStatus: (s) => { if (s.state === "error" && this.snap.status === "loading") this.set({ status: "error", message: s.text || "The part studio could not be opened." }); },
    });
    this.session.start();
  }

  snapshot(): SourceSnapshot { return this.snap; }
  kernel() { return this.pool.clientFor(this.docId); }
  features() { return this.input; }
  doc() { return this.session.doc; }
  /** Build in the pool if no worker holds this studio (the engine keeps what it built, so asking again is cheap). */
  async ensureKernel() {
    if (this.inFlight) await this.inFlight.catch(() => null);
    if (!this.input || this.closed) return null;
    const have = this.pool.clientFor(this.docId);
    if (have && this.workerHash === this.builtHash) return have;
    const hash = this.builtHash;
    const result = await (this.inFlight = this.pool.regenerate(this.docId, this.input.features, this.input.rollback));
    if (result) this.workerHash = hash;
    return this.pool.clientFor(this.docId);
  }
  close(): void { this.closed = true; clearTimeout(this.timer); this.session.close(); this.boards.close(); this.pool.forget(this.docId); }

  private set(patch: Partial<SourceSnapshot>): void {
    if (this.closed) return;
    this.snap = { ...this.snap, ...patch, version: this.snap.version + 1 };
    this.env.changed();
  }

  /** Edits arrive in bursts (a drag in a sketch): build once they pause for a moment. */
  private schedule(): void { clearTimeout(this.timer); this.timer = setTimeout(() => void this.build(), this.builtHash ? 80 : 0); }

  private async build(): Promise<void> {
    const doc = this.session.doc;
    if (!doc || this.closed) return;
    // as the studio's own page builds it: variables applied, boards supplied (mechanical document/inputs.ts)
    const { features, rollback } = studioInputs(doc, { filters: [this.boards.filter] });
    this.input = { features, rollback };
    // a board the studio shows is still being read: build once it is here, not twice
    if (this.boards.pending) return;
    // what the kernel would see: names are left out, so renaming a feature rebuilds nothing
    const hash = fingerprint(assetV() + "|" + rollback + "|" + stableJson(features.map((f) => ({ id: f.id, type: f.type, suppressed: f.suppressed, params: f.suppressed ? null : f.params })) as never));
    if (hash === this.builtHash) { this.wantHash = hash; return; }   // back to what is shown: drop whatever is on its way
    if (hash === this.wantHash) return;
    this.wantHash = hash;
    const first = !this.builtHash;
    if (first) {
      const cached = await readCached(this.docId, hash);
      if (this.closed || this.wantHash !== hash) return;
      if (cached) { this.builtHash = hash; this.set({ status: "ready", message: undefined, pieces: cached.map((b) => ({ id: b.id, name: b.name, mesh: b.mesh, transform: null, ...(b.reference ? { reference: true } : {}) })) }); return; }
    }
    if (first) this.set({ status: "loading", message: "Building the part…" });
    const run = this.pool.regenerate(this.docId, features, rollback);
    this.inFlight = run;
    const result = await run;
    if (this.inFlight === run) this.inFlight = null;
    if (this.closed) return;
    if (result) this.workerHash = hash;
    if (!result) {
      if (this.wantHash === hash) { this.wantHash = ""; const why = this.pool.failure; if (why) this.set({ status: "error", message: why }); }
      return;
    }
    if (this.wantHash !== hash) return;   // a newer edit is already being built
    this.builtHash = hash;
    const old = new Map(this.snap.pieces.map((p) => [p.id, p]));
    const pieces: SourcePiece[] = [];
    for (const b of result.bodies) {
      if (!b.mesh) continue;
      const was = old.get(b.id);
      // an unchanged body keeps its piece object: nothing downstream rebuilds
      pieces.push(was && was.mesh === b.mesh && was.name === b.name ? was : { id: b.id, name: b.name, mesh: b.mesh, transform: null, ...(b.reference ? { reference: true } : {}) });
    }
    const failed = result.features.filter((f) => f.status === "error").length;
    this.set({ status: "ready", message: failed ? `${failed} feature${failed === 1 ? "" : "s"} of the part studio failed to build.` : undefined, pieces });
    void writeCached(this.docId, hash, pieces.map((p) => ({ id: p.id, name: p.name, mesh: p.mesh, ...(p.reference ? { reference: true } : {}) })));
  }
}

/**
 * What a piece of a part studio is called outside it: a studio with one part is known by its own name
 * ("Enclosure"), not by the part's default one ("Part 1").  Reference bodies (a board shown there) do not count.
 */
export function soleName(pieces: readonly SourcePiece[], piece: SourcePiece, docName: string): string {
  return !piece.reference && pieces.filter((p) => !p.reference).length === 1 ? docName : piece.name;
}

export function partSource(pool: KernelPool): SourceProvider {
  return {
    kind: "part",
    docTypes: ["part_studio"],
    title: "Part studio",
    unavailable: () => null,
    open: (docId, env) => new PartHandle(docId, env, pool),
    select: (source, snapshot) => (source.kind === "part" ? snapshot.pieces.filter((p) => p.id === source.body) : []),
    // a studio with one part is known by its own name ("Enclosure"), not by the part's default one ("Part 1")
    offers: (docId, docName, snapshot) => snapshot.pieces.map((p) => ({ source: { kind: "part", docId, body: p.id }, name: soleName(snapshot.pieces, p, docName) })),
    offersAll: true,
  };
}
