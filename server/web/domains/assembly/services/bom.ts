// bom.ts — the assembly's combined bill of materials: the mechanical parts with their quantities, and under
// each board the electronic parts it carries, in one table.  Pure: it is given the instances, the project's
// documents and what was read from the part studios and boards (bom-sources.ts reads them), and returns rows.
//
// One row per distinct thing placed: a part studio body (by document and body id), a board, a sub-assembly or
// a model file; its quantity is how many unsuppressed instances place it.  A board's electronic parts follow
// its row, each line's quantity multiplied by the number of boards (the electronics domain's own grouping,
// pcb/parts/bom-export.ts).  A sub-assembly is one row; its contents are not expanded yet.
import type { ElectronicBomLine } from "../../pcb/parts/bom-export";
import type { InstanceItem } from "../document/format";

export interface BomRow {
  /** "1", "2", and "2.1", "2.2" for the parts on board 2 */
  item: string;
  kind: "part" | "board" | "assembly" | "file" | "component";
  name: string;
  /** the document it comes from, for a part; the value for an electronic part */
  description: string;
  quantity: number;
  /** what an electronic part is called on the board ("R1 R2 R5") */
  refs?: string;
  footprint?: string;
  mpn?: string;
  manufacturer?: string;
  /** "lcsc C25804" */
  vendorPart?: string;
  material?: string;
  /** the instances it counts */
  instances: string[];
  /** why a board's parts are not listed */
  note?: string;
}

export interface BomInput {
  instances: readonly InstanceItem[];
  docs: readonly { docId: string; path: string; docType: string }[];
  /** part studio document → body id → what that body is called and made of */
  parts?: { [docId: string]: { [bodyId: string]: { name: string; material?: string } } };
  /** board document → its electronic BOM, or why it could not be read */
  boards?: { [docId: string]: ElectronicBomLine[] | { error: string } };
}

const stem = (p: string) => (p.split("/").pop() || p).replace(/\.[^.]+$/, "");
/** "Bracket <2>" → "Bracket": the name an instance is given when it is placed again. */
const baseName = (n: string) => n.replace(/\s*<\d+>\s*$/, "").trim();
const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

export function combinedBom(input: BomInput): BomRow[] {
  const docs = new Map(input.docs.map((d) => [d.docId, d]));
  const groups = new Map<string, { kind: BomRow["kind"]; docId: string; body?: string; instances: InstanceItem[] }>();
  for (const i of input.instances) {
    if (i.suppressed) continue;
    const s = i.source;
    const key = s.kind === "part" ? `part:${s.docId}:${s.body}` : `${s.kind}:${s.docId}`;
    if (!groups.has(key)) groups.set(key, { kind: s.kind, docId: s.docId, body: s.kind === "part" ? s.body : undefined, instances: [] });
    groups.get(key)!.instances.push(i);
  }
  const rank: Record<string, number> = { part: 0, assembly: 1, file: 2, board: 3 };
  const named = Array.from(groups.values()).map((g) => {
    const doc = docs.get(g.docId), from = doc ? stem(doc.path) : "missing document";
    const body = g.kind === "part" && g.body ? input.parts?.[g.docId]?.[g.body] : undefined;
    const name = body ? body.name : g.kind === "part" ? baseName(g.instances[0].name) : from;
    return { g, name, from, material: body?.material };
  }).sort((a, b) => rank[a.g.kind] - rank[b.g.kind] || natural(a.name, b.name) || natural(a.from, b.from));

  const rows: BomRow[] = [];
  named.forEach(({ g, name, from, material }, n) => {
    const item = String(n + 1), count = g.instances.length;
    const row: BomRow = { item, kind: g.kind, name, description: g.kind === "part" ? from : g.kind === "board" ? "Board" : g.kind === "assembly" ? "Sub-assembly" : "Model file", quantity: count, instances: g.instances.map((i) => i.id).sort(natural) };
    if (material) row.material = material;
    rows.push(row);
    if (g.kind !== "board") return;
    const bom = input.boards?.[g.docId];
    if (!bom) { row.note = "Its parts were not read."; return; }
    if (!Array.isArray(bom)) { row.note = bom.error; return; }
    bom.forEach((l, k) => {
      rows.push({
        item: `${item}.${k + 1}`, kind: "component", name: l.value || l.refs[0] || "?", description: l.value, quantity: l.quantity * count,
        refs: l.refs.join(" "), footprint: l.footprint, ...(l.mpn ? { mpn: l.mpn } : {}), ...(l.manufacturer ? { manufacturer: l.manufacturer } : {}),
        ...(l.vendor ? { vendorPart: `${l.vendor} ${l.vendorId}` } : {}), instances: row.instances,
      });
    });
  });
  return rows;
}

const cell = (s: string) => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
const KIND: Record<BomRow["kind"], string> = { part: "Part", board: "Board", assembly: "Sub-assembly", file: "Model file", component: "Electronic part" };

/** The table as CSV, for a spreadsheet: one line per row, the header first. */
export function bomCsv(rows: readonly BomRow[]): string {
  const out = [["Item", "Type", "Name", "Description", "Quantity", "References", "Footprint", "MPN", "Manufacturer", "Vendor part", "Material"]];
  for (const r of rows) out.push([r.item, KIND[r.kind], r.name, r.description, String(r.quantity), r.refs || "", r.footprint || "", r.mpn || "", r.manufacturer || "", r.vendorPart || "", r.material || ""]);
  return out.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
