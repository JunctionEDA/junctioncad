// types.ts — instance sources: where an instance's geometry comes from.
//
// An instance stores `source: { kind, docId, … }` (document/format.ts) and copies no geometry.  A source KIND is
// one file in this folder that default-exports a SourceProvider; the manager (manager.ts) opens one handle per
// source document and keeps it live, so an assembly follows its parts as they are edited.
//
// To add a kind (a board, a STEP file): write `sources/<kind>.ts`, add it to the list in manager.ts, and give
// every piece a mesh in the mechanical domain's BodyMesh form with stable names for its faces, edges and
// vertices.  Those names are what mates store, so they must survive a rebuild of the source.
import type { BoardDelta, BoardReader, BodyMesh, KernelClient } from "../../mechanical/api";
import type { ItemDoc } from "../../../shared/itemdoc/itemdoc";
import type { InstanceSource, Transform } from "../document/format";

/** One rigid piece of geometry a source offers: a body of a part studio, a part inside a sub-assembly. */
export interface SourcePiece {
  /** stable within the source document; a mate's GeomRef.body names it */
  id: string;
  name: string;
  /** shared by every instance that shows this piece: never mutate it.  A new object means new geometry. */
  mesh: BodyMesh;
  /** where the piece sits in the source's own space; null is "where the mesh already is" */
  transform: Transform | null;
  /**
   * The piece is not drawn as a solid: something else draws what it stands for (a board's picture,
   * viewport/boards.ts).  It is still there for the pointer, for connectors and for analysis.
   */
  ghost?: boolean;
  /** a body that is in its part studio to be referred to, not as a part (a Board feature's board): not counted as "the part" of a studio */
  reference?: boolean;
}

export interface SourceSnapshot {
  status: "loading" | "ready" | "error";
  /** why it failed, or what it is waiting for */
  message?: string;
  pieces: SourcePiece[];
  /** goes up whenever `pieces` or `status` change */
  version: number;
}

/** One open source document. */
export interface SourceHandle {
  snapshot(): SourceSnapshot;
  /** the worker that holds this document's B-rep, when the kind has one and it is running (analysis tools) */
  kernel?(): KernelClient | null;
  /**
   * The worker that holds this document's B-rep, built now if it is not (the editor drew the part from its
   * cache, or the worker was retired).  What an analysis tool calls before asking the worker about bodies.
   */
  ensureKernel?(): Promise<KernelClient | null>;
  /** the source document itself, when it is an item document (a part studio): its materials, its names */
  doc?(): ItemDoc | null;
  /** the document as worker input, for a tool that wants to rebuild it in a worker of its own */
  features?(): { features: unknown[]; rollback: number } | null;
  /** a board source: the board as read, and its changes as they arrive (`null`: everything), for its picture */
  board?(): { reader(): BoardReader | null; subscribe(fn: (delta: BoardDelta | null) => void): () => void; measured(): void } | null;
  close(): void;
}

export interface SourceEnv {
  signedIn: boolean;
  /** call when the snapshot changed */
  changed(): void;
  /** the source documents this one is being opened inside, outermost first: a sub-assembly must not contain itself */
  ancestry: readonly string[];
  /** open another source from inside this one (a sub-assembly opens its parts) */
  open(kind: InstanceSource["kind"], docId: string, changed: () => void): SourceHandle;
}

export interface SourceOffer { source: InstanceSource; name: string; /** where a new instance of it goes (the editor decides when absent) */ transform?: Transform }

export interface SourceProvider {
  kind: InstanceSource["kind"];
  /** the server document types (DocumentHostContext.docs[].docType) this kind reads */
  docTypes: string[];
  /** what Insert calls a document of this kind: "Part studio" */
  title: string;
  /** Why this kind cannot be inserted yet, or null when it can. */
  unavailable(): string | null;
  open(docId: string, env: SourceEnv): SourceHandle;
  /** the pieces of the source document that an instance with this `source` shows */
  select(source: InstanceSource, snapshot: SourceSnapshot): SourcePiece[];
  /** what Insert offers from a loaded document: each is one instance to add */
  offers(docId: string, docName: string, snapshot: SourceSnapshot): SourceOffer[];
  /** true when Insert may also add everything the document offers at once ("the whole studio") */
  offersAll: boolean;
}
