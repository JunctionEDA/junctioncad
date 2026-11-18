// manager.ts — the source documents an open assembly reads, kept live.
//
// One handle per source document, shared by every instance that uses it and by the Insert dialog while it lists
// that document's parts; a handle is closed when nothing needs it any more.  The editor asks for an instance's
// pieces and is told when anything changed.
import type { InstanceItem, InstanceSource } from "../document/format";
import { boardSource } from "./board";
import { KernelPool } from "./kernels";
import { partSource } from "./part";
import { subAssemblySource } from "./subassembly";
import type { SourceHandle, SourcePiece, SourceProvider, SourceSnapshot } from "./types";

const EMPTY: SourceSnapshot = { status: "error", message: "This kind of instance is not known to this Junction.", pieces: [], version: 0 };
const key = (kind: string, docId: string): string => kind + ":" + docId;

export class SourceManager {
  readonly kernels = new KernelPool();
  /** the kinds of source: add a provider here to add a kind (sources/types.ts) */
  readonly providers: readonly SourceProvider[];
  private readonly open = new Map<string, { handle: SourceHandle; holders: Set<string> }>();
  private pending = false;
  private closed = false;

  /** `self` is the assembly being edited: it may not contain itself.  `changed` is called (once per tick) when any source changed. */
  constructor(private readonly self: string, private readonly signedIn: boolean, private readonly changed: () => void) {
    const list: SourceProvider[] = [];
    list.push(partSource(this.kernels), subAssemblySource(() => list), boardSource(this.kernels));
    this.providers = list;
    this.kernels.onActivity = () => this.notify();
  }

  provider(kind: string): SourceProvider | undefined { return this.providers.find((p) => p.kind === kind); }

  private notify(): void {
    if (this.pending || this.closed) return;
    this.pending = true;
    queueMicrotask(() => { this.pending = false; if (!this.closed) this.changed(); });
  }

  private make(kind: InstanceSource["kind"], docId: string, ancestry: readonly string[], changed: () => void): SourceHandle {
    const p = this.provider(kind);
    if (!p) return { snapshot: () => EMPTY, close() {} };
    return p.open(docId, { signedIn: this.signedIn, changed, ancestry, open: (k, d, ch) => this.make(k, d, [...ancestry, docId], ch) });
  }

  /** Keep a source document open on behalf of `holder` ("instances", "insert") until it is released. */
  hold(kind: InstanceSource["kind"], docId: string, holder: string): SourceHandle {
    const k = key(kind, docId);
    let e = this.open.get(k);
    if (!e) { e = { handle: this.make(kind, docId, [this.self], () => this.notify()), holders: new Set() }; this.open.set(k, e); }
    e.holders.add(holder);
    return e.handle;
  }
  release(kind: string, docId: string, holder: string): void {
    const k = key(kind, docId), e = this.open.get(k);
    if (!e) return;
    e.holders.delete(holder);
    if (!e.holders.size) { e.handle.close(); this.open.delete(k); }
  }
  /** Make the open set match what these instances need (they hold as "instances"). */
  sync(instances: readonly InstanceItem[]): void {
    const wanted = new Set<string>();
    for (const i of instances) { if (!i.source || typeof i.source.docId !== "string") continue; wanted.add(key(i.source.kind, i.source.docId)); this.hold(i.source.kind, i.source.docId, "instances"); }
    for (const [k, e] of Array.from(this.open)) if (e.holders.has("instances") && !wanted.has(k)) { const at = k.indexOf(":"); this.release(k.slice(0, at), k.slice(at + 1), "instances"); }
  }

  snapshot(kind: string, docId: string): SourceSnapshot | null { return this.open.get(key(kind, docId))?.handle.snapshot() || null; }
  handle(kind: string, docId: string): SourceHandle | null { return this.open.get(key(kind, docId))?.handle || null; }

  /** The pieces an instance shows, and the state of its source. */
  piecesOf(instance: InstanceItem): { pieces: SourcePiece[]; status: SourceSnapshot["status"]; message?: string } {
    const s = instance.source;
    const snap = s && this.snapshot(s.kind, s.docId), p = s && this.provider(s.kind);
    if (!snap || !p) return { pieces: [], status: snap ? "error" : "loading", message: snap ? EMPTY.message : undefined };
    const pieces = p.select(s, snap);
    if (snap.status === "ready" && !pieces.length) return { pieces, status: "error", message: s.kind === "part" ? "The part this instance showed is no longer in its part studio. Replace it, or bring the part back." : "Its source has nothing to show." };
    return { pieces, status: snap.status === "error" && pieces.length ? "ready" : snap.status, message: snap.message };
  }

  /** How many part studios are being built right now, and why the kernel failed if it did. */
  get activity(): { building: number; failure: string | null } { return { building: this.kernels.working, failure: this.kernels.failure }; }

  dispose(): void { this.closed = true; for (const e of this.open.values()) e.handle.close(); this.open.clear(); this.kernels.dispose(); }
}
