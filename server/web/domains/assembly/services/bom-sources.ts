// bom-sources.ts — what the combined bill of materials reads: the names and materials of the part studios'
// bodies (interference-sources.ts PartSources) and each board's electronic BOM, from the board's stored file
// through the electronics domain's documented export (pcb/parts/bom-export.ts).
import { electronicBom, type ElectronicBomLine } from "../../pcb/parts/bom-export";
import type { InstanceItem } from "../document/format";
import { combinedBom, type BomRow } from "./bom";
import type { PartSources } from "./interference-sources";

/** A board document's electronic BOM, from its stored file (edits not yet folded into it are not seen). */
export async function boardBom(docId: string, docType: string): Promise<ElectronicBomLine[]> {
  const r = await fetch(`/api/docs/${docId}/content?v=${Date.now()}`, { credentials: "same-origin" });
  if (!r.ok) throw new Error(r.status === 404 ? "The board has no stored file yet." : `The board could not be read (${r.status}).`);
  return electronicBom(await r.text(), docType === "kicad_sch" ? "kicad_sch" : "kicad_pcb");
}

/** Everything the table needs, read, then the rows. */
export async function readBom(instances: readonly InstanceItem[], docs: readonly { docId: string; path: string; docType: string }[], parts: PartSources): Promise<BomRow[]> {
  const live = instances.filter((i) => !i.suppressed);
  const boardIds = Array.from(new Set(live.filter((i) => i.source.kind === "board").map((i) => i.source.docId)));
  const boards: { [docId: string]: ElectronicBomLine[] | { error: string } } = {};
  const names = parts.bodyNames();
  await Promise.all([
    ...boardIds.map(async (d) => {
      const doc = docs.find((x) => x.docId === d);
      try { boards[d] = await boardBom(d, doc ? doc.docType : "kicad_pcb"); } catch (e) { boards[d] = { error: e instanceof Error ? e.message : String(e) }; }
    }),
  ]);
  return combinedBom({ instances: live, docs, parts: names, boards });
}
