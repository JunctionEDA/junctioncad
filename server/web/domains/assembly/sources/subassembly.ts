// subassembly.ts — the "assembly" source: another assembly of the project as one rigid instance
// (`{ kind: "assembly", docId }`).
//
// The sub-assembly's document stores solved placements (document/format.ts), so showing it needs no solver:
// each of its instances is drawn where its own document says, and the whole moves as one body here.  A piece's
// id is `<instance id in the sub-assembly>/<piece id in that instance's source>`, which is stable for as long
// as that instance exists, so mates to a sub-assembly survive edits inside it.
import { ItemDocSession } from "../../../shared/itemdoc/sync";
import { multiply } from "../core/transform";
import { ASSEMBLY_KIND, instancesOf, transformOf, type InstanceItem, type Transform } from "../document/format";
import type { SourceEnv, SourceHandle, SourcePiece, SourceProvider, SourceSnapshot } from "./types";

class SubAssemblyHandle implements SourceHandle {
  private snap: SourceSnapshot = { status: "loading", message: "Opening the assembly…", pieces: [], version: 0 };
  private session: ItemDocSession | null = null;
  private readonly children = new Map<string, { handle: SourceHandle; kind: InstanceItem["source"]["kind"]; docId: string }>();
  private made = new Map<string, SourcePiece>();
  private closed = false;

  constructor(private readonly docId: string, private readonly env: SourceEnv, private readonly providers: () => readonly SourceProvider[]) {
    if (env.ancestry.includes(docId)) { this.snap = { status: "error", message: "This assembly contains itself.", pieces: [], version: 1 }; return; }
    this.session = new ItemDocSession({
      docId, signedIn: env.signedIn, expectKind: ASSEMBLY_KIND,
      onChange: () => this.rebuild(),
      onStatus: (s) => { if (s.state === "error" && this.snap.status === "loading") this.set({ status: "error", message: s.text || "The assembly could not be opened." }); },
    });
    this.session.start();
  }

  snapshot(): SourceSnapshot { return this.snap; }
  close(): void { this.closed = true; this.session?.close(); for (const c of this.children.values()) c.handle.close(); this.children.clear(); }
  private set(patch: Partial<SourceSnapshot>): void { if (this.closed) return; this.snap = { ...this.snap, ...patch, version: this.snap.version + 1 }; this.env.changed(); }

  private rebuild(): void {
    const doc = this.session?.doc;
    if (!doc || this.closed) return;
    const instances = instancesOf(doc).filter((i) => !i.suppressed && !i.hidden);
    const wanted = new Set<string>();
    for (const i of instances) {
      const key = i.source.kind + ":" + i.source.docId;
      wanted.add(key);
      if (!this.children.has(key)) this.children.set(key, { handle: this.env.open(i.source.kind, i.source.docId, () => this.rebuild()), kind: i.source.kind, docId: i.source.docId });
    }
    for (const [key, c] of Array.from(this.children)) if (!wanted.has(key)) { c.handle.close(); this.children.delete(key); }
    const pieces: SourcePiece[] = [], made = new Map<string, SourcePiece>();
    let loading = false, trouble = "";
    for (const i of instances) {
      const child = this.children.get(i.source.kind + ":" + i.source.docId)!.handle.snapshot();
      if (child.status === "loading") loading = true;
      if (child.status === "error") trouble = child.message || "A part of this assembly could not be loaded.";
      const provider = this.providers().find((p) => p.kind === i.source.kind);
      const place = transformOf(i);
      for (const p of provider ? provider.select(i.source, child) : []) {
        const id = i.id + "/" + p.id;
        const transform: Transform = p.transform ? multiply(place, p.transform) : place;
        const was = this.made.get(id);
        const same = was && was.mesh === p.mesh && was.name === i.name && was.transform!.every((v, k) => v === transform[k]);
        const piece = same ? was! : { id, name: i.name, mesh: p.mesh, transform };
        pieces.push(piece); made.set(id, piece);
      }
    }
    this.made = made;
    // "loading" until every part is in: the pieces that are ready are shown meanwhile, but nothing is mated to half an assembly
    this.set({ status: loading ? "loading" : "ready", message: trouble || (loading ? "Loading its parts…" : undefined), pieces });
  }
}

export function subAssemblySource(providers: () => readonly SourceProvider[]): SourceProvider {
  return {
    kind: "assembly",
    docTypes: ["assembly"],
    title: "Assembly",
    unavailable: () => null,
    open: (docId, env) => new SubAssemblyHandle(docId, env, providers),
    select: (_source, snapshot) => snapshot.pieces,
    offers: (docId, docName) => [{ source: { kind: "assembly", docId }, name: docName }],
    offersAll: false,
  };
}
