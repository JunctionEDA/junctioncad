// bom-export.ts — the electronic bill of materials of a board or a schematic, for other domains.  This is the
// documented export: the assembly's combined bill of materials (web/domains/assembly/services/bom.ts) imports
// this file and nothing else of the electronics domain, so parts/bom.ts can change as the BOM window needs.
//
//   electronicBom(text, "kicad_pcb")   → one line per distinct part: references, quantity, value, footprint,
//                                         and the vendor part, MPN and manufacturer the fields name
//
// It groups parts the way the BOM window and the get_bom tool do (parts/bom.ts collect): by vendor part when a
// field names one, else by value, footprint and MPN.  Footprints marked "exclude from BOM", DNP or board-only
// are left out (on a schematic: symbols not in the BOM, DNP, and power symbols).  `K` is the KiCad canvas API
// (static/kicad-canvas.js, loaded on every editor page as window.KiCadCanvas; a node test requires the file).
import { collect } from "./bom";

export interface ElectronicBomLine {
  /** "R1", "R2", … in natural order */
  refs: string[];
  quantity: number;
  value: string;
  /** "Library:Footprint" */
  footprint: string;
  vendor: string | null;
  vendorId: string;
  mpn: string;
  manufacturer: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function electronicBom(text: string, docType: "kicad_pcb" | "kicad_sch", K: any = (globalThis as any).KiCadCanvas): ElectronicBomLine[] {
  if (!K || typeof K.parseDoc !== "function") throw new Error("The KiCad canvas is not loaded on this page.");
  const doc = K.parseDoc(text, docType);
  return collect(K, doc, docType === "kicad_sch").map((l) => ({
    refs: l.refs.slice(), quantity: l.refs.length, value: l.value, footprint: l.footprint,
    vendor: l.vendor, vendorId: l.vendorId, mpn: l.mpn, manufacturer: l.manufacturer,
  }));
}
