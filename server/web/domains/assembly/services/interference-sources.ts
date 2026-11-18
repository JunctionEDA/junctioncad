// interference-sources.ts — where the interference check and the bill of materials get the parts of an
// assembly from: the assembly editor itself.  The instances, where they stand (solved), their source documents
// and the modelling workers that hold their B-reps are the editor's (`assembly.placed()`,
// `assembly.sources.handle(...)`): nothing is opened or built a second time here.
//
// For a check, each source document's bodies are read once as BRep text from the worker that built it
// ("body-brep"); the worker is asked to build first when the editor drew the part from its cache and no worker
// holds it yet.  One of those workers also does the checking.
import type { ItemDoc } from "../../../shared/itemdoc/itemdoc";
import { KernelClient, materialOf } from "../../mechanical/api";
import { soleName } from "../sources/part";
import type { AssemblyEditor } from "../ui/assembly";
import { textHash, type Box, type InstanceShape } from "./interference";

interface BodyInfo { id: string; name: string; brep: string; bbox: Box; key: string }
interface Read { version: number; bodies: Map<string, BodyInfo>; kernel: KernelClient }

const sourceKey = (kind: string, docId: string): string => kind + ":" + docId;

export class PartSources {
  private readonly read = new Map<string, Read>();
  /** a worker of this class's own, only when no source has one (nothing to check, then) */
  private own: KernelClient | null = null;

  constructor(private readonly a: AssemblyEditor) {}

  /** The worker that checks: one that already holds shapes, so the 23 MB kernel is not started again. */
  private get checker(): KernelClient {
    for (const r of this.read.values()) return r.kernel;
    if (!this.own) this.own = new KernelClient();
    return this.own;
  }

  /** The bodies of one source document as BRep text, from the worker that holds it. */
  private async bodies(kind: string, docId: string): Promise<Read> {
    const handle = this.a.sources.handle(kind, docId);
    if (!handle) throw new Error("Its source is not open.");
    const snap = handle.snapshot();
    if (snap.status === "loading") throw new Error("It is still being built.");
    const k = sourceKey(kind, docId);
    const had = this.read.get(k);
    if (had && had.version === snap.version) return had;
    const kernel = handle.ensureKernel ? await handle.ensureKernel() : null;
    if (!kernel) throw new Error(snap.message || "Its source could not be built.");
    const r = await kernel.call("body-brep", { bodies: null }) as unknown as { bodies: { id: string; name: string; brep: string; bbox: Box }[] };
    const now: Read = { version: snap.version, kernel, bodies: new Map(r.bodies.map((b) => [b.id, { ...b, key: `${k}:${b.id}:${textHash(b.brep)}` }])) };
    this.read.set(k, now);
    return now;
  }

  /**
   * The solids of the instances as they stand: one per body of a part instance, the laminate and the parts'
   * envelopes of a board.  What cannot be checked is listed apart with the reason.  `only`: just these instances.
   */
  async shapes(only?: ReadonlySet<string>): Promise<{ shapes: InstanceShape[]; skipped: { instance: string; why: string }[] }> {
    const placed = this.a.placed().filter((p) => !only || only.has(p.item.id));
    const shapes: InstanceShape[] = [], skipped: { instance: string; why: string }[] = [];
    const docs = new Map<string, Read | Error>();
    const wanted = new Map<string, [string, string]>();
    for (const p of placed) { const s = p.item.source; if (s.kind === "part" || s.kind === "board") wanted.set(sourceKey(s.kind, s.docId), [s.kind, s.docId]); }
    await Promise.all(Array.from(wanted).map(async ([k, [kind, docId]]) => { try { docs.set(k, await this.bodies(kind, docId)); } catch (e) { docs.set(k, e instanceof Error ? e : new Error(String(e))); } }));
    for (const p of placed) {
      const s = p.item.source;
      if (s.kind !== "part" && s.kind !== "board") { skipped.push({ instance: p.item.id, why: s.kind === "assembly" ? "the parts inside a sub-assembly are not checked yet" : "only parts and boards are checked" }); continue; }
      const src = docs.get(sourceKey(s.kind, s.docId));
      if (!src || src instanceof Error) { skipped.push({ instance: p.item.id, why: src ? src.message : "not loaded" }); continue; }
      let any = false;
      for (const piece of p.pieces) {
        const b = src.bodies.get(piece.id);
        if (!b) continue;
        any = true;
        shapes.push({ instance: p.item.id, key: b.key, brep: b.brep, bbox: b.bbox, transform: piece.transform });
      }
      if (!any) skipped.push({ instance: p.item.id, why: "its body is no longer in its source" });
    }
    return { shapes, skipped };
  }

  /** What each body of the part studios in use is called and made of (for the bill of materials): no kernel needed. */
  bodyNames(): { [docId: string]: { [bodyId: string]: { name: string; material?: string } } } {
    const out: { [docId: string]: { [bodyId: string]: { name: string; material?: string } } } = {};
    for (const p of this.a.placed()) {
      const s = p.item.source;
      if (s.kind !== "part" || out[s.docId]) continue;
      const handle = this.a.sources.handle("part", s.docId); if (!handle) continue;
      const doc: ItemDoc | null = handle.doc ? handle.doc() : null;
      out[s.docId] = {};
      const pieces = handle.snapshot().pieces, entry = this.a.host.docs.find((d) => d.docId === s.docId);
      const docName = entry ? (entry.path.split("/").pop() || entry.path).replace(/\.[^.]+$/, "") : "";
      for (const piece of pieces) { const m = doc ? materialOf(doc, piece.id)?.name : undefined; out[s.docId][piece.id] = { name: docName ? soleName(pieces, piece, docName) : piece.name, ...(m ? { material: m } : {}) }; }
    }
    return out;
  }

  /** The checking worker's `call`, as interference.ts takes it. */
  call = (service: string, args: unknown): Promise<unknown> => this.checker.call(service, args as never);

  dispose(): void { this.own?.dispose(); this.own = null; this.read.clear(); }
}
