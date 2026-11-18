// board.ts — the "board" source: a circuit board of the project as an instance (`{ kind: "board", docId }`).
//
// The board is read live (the mechanical domain's BoardFeed joins the board document, read-only) and built in a
// pooled modelling worker by the same code that builds a Board feature in a part studio: the input is a part
// studio of one Board feature, id "board", on the Top plane, with the board document's own sheet origin as its
// origin.  So the pieces and their names are exactly those of mechanical/board/README.md with `board` as the
// feature id, and they never change when the board is edited:
//
//   piece "board:board"   the laminate         faces "board:front", "board:back", "board:edge:<uuid>…", "board:hole:H1"
//   piece "board:parts"   the parts' envelopes  faces "board:part:J1:top", ":base", ":x+" …
//
// Mate a screw to "board:hole:H1", seat the board on "board:back".  Both pieces are ghosts (types.ts): the editor
// draws the board as it looks (viewport/boards.ts, the mechanical domain's BoardDisplay) and the solids are there
// for the pointer, the connectors and the interference check.
//
// The geometry is in millimetres, x to the right and y up as the board editor shows the board's front, z from the
// back face (0) to the front; the origin is the sheet's, so Insert places a new instance with the board's middle
// at the assembly's origin (`placeAtOrigin`).
import { BOARD_FEATURE_TYPE, BoardFeed, type BoardDelta, type FeatureInput } from "../../mechanical/api";
import type { Transform } from "../document/format";
import type { KernelPool } from "./kernels";
import type { SourceEnv, SourceHandle, SourcePiece, SourceProvider, SourceSnapshot } from "./types";

const FEATURE_ID = "board";

class BoardHandle implements SourceHandle {
  private snap: SourceSnapshot = { status: "loading", message: "Reading the board…", pieces: [], version: 0 };
  private readonly feed: BoardFeed;
  private readonly listeners = new Set<(delta: BoardDelta | null) => void>();
  private input: { features: FeatureInput[]; rollback: number } | null = null;
  private built: unknown = null;
  private wanted: unknown = null;
  private closed = false;
  private readonly key: string;

  constructor(private readonly docId: string, private readonly env: SourceEnv, private readonly pool: KernelPool) {
    this.key = "board:" + docId;
    this.feed = new BoardFeed({
      signedIn: env.signedIn,
      changed: () => void this.build(),
      onBoard: (_doc, _reader, delta) => { for (const fn of Array.from(this.listeners)) fn(delta.all ? null : delta); },
    });
    void this.build();
    // a board that cannot be read (no access, no stored file) never calls back: say so instead of "Reading…"
    void this.feed.settled(20000).then(() => { if (!this.closed && !this.feed.reader(docId) && this.snap.status === "loading") this.set({ status: "error", message: "The board could not be read." }); });
  }

  snapshot(): SourceSnapshot { return this.snap; }
  kernel() { return this.pool.clientFor(this.key); }
  features() { return this.input; }
  async ensureKernel() {
    if (!this.input || this.closed) return null;
    await this.pool.regenerate(this.key, this.input.features, this.input.rollback);
    return this.pool.clientFor(this.key);
  }
  board() {
    return {
      reader: () => this.feed.reader(this.docId),
      subscribe: (fn: (delta: BoardDelta | null) => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
      measured: () => this.feed.poke(this.docId),
    };
  }
  close(): void { this.closed = true; this.feed.close(); this.listeners.clear(); this.pool.forget(this.key); }

  private set(patch: Partial<SourceSnapshot>): void {
    if (this.closed) return;
    this.snap = { ...this.snap, ...patch, version: this.snap.version + 1 };
    this.env.changed();
  }

  private async build(): Promise<void> {
    if (this.closed) return;
    const bare: FeatureInput = { id: FEATURE_ID, type: BOARD_FEATURE_TYPE, name: "Board", suppressed: false, params: { board: this.docId, plane: { kind: "plane", plane: "top" }, x: 0, y: 0, z: 0, angle: 0, flip: false, origin: [0, 0], minHole: 1.5, minHeight: 1.5 } };
    const features = this.feed.filter([bare]);
    const board = features[0].params.$board;
    if (!board) return;                       // not read yet: the feed calls again
    if (board === this.built || board === this.wanted) return;
    this.wanted = board;
    this.input = { features, rollback: 1 };
    if (!this.built) this.set({ status: "loading", message: "Building the board…" });
    const result = await this.pool.regenerate(this.key, features, 1);
    if (this.closed) return;
    if (!result) { if (this.wanted === board) { this.wanted = null; const why = this.pool.failure; if (why) this.set({ status: "error", message: why }); } return; }
    if (this.wanted !== board) return;        // the board moved on while this was built
    this.built = board;
    const report = result.features[0];
    if (report && report.status === "error") { this.set({ status: "error", message: report.message || "The board could not be built.", pieces: [] }); return; }
    const old = new Map(this.snap.pieces.map((p) => [p.id, p]));
    const pieces: SourcePiece[] = [];
    for (const b of result.bodies) {
      if (!b.mesh) continue;
      const was = old.get(b.id);
      pieces.push(was && was.mesh === b.mesh ? was : { id: b.id, name: b.name, mesh: b.mesh, transform: null, ghost: true });
    }
    this.set({ status: "ready", message: report && report.status === "warning" ? report.message : undefined, pieces });
  }
}

/** A placement that puts the middle of these pieces over the origin, their underside on z = 0. */
export function placeAtOrigin(pieces: readonly SourcePiece[]): Transform | undefined {
  const laminate = pieces.find((p) => p.id.endsWith(":board")) || pieces[0];
  if (!laminate) return undefined;
  const b = laminate.mesh.bbox;
  return [1, 0, 0, -(b[0] + b[3]) / 2, 0, 1, 0, -(b[1] + b[4]) / 2, 0, 0, 1, -b[2]];
}

export function boardSource(pool: KernelPool): SourceProvider {
  return {
    kind: "board",
    docTypes: ["kicad_pcb"],
    title: "Board",
    unavailable: () => null,
    open: (docId: string, env: SourceEnv) => new BoardHandle(docId, env, pool),
    select: (_source, snap) => snap.pieces,
    offers: (docId, docName, snap) => [{ source: { kind: "board", docId }, name: docName, transform: placeAtOrigin(snap.pieces) }],
    offersAll: false,
  };
}
