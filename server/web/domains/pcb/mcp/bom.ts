// mcp/bom — the bill of materials as a buyer reads it: one line per distinct part with what it costs and whether
// it can be bought, from the vendor lookups the editor's own BOM window uses (web/domains/pcb/parts, /api/parts).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { collect, priceAt, type BomLine } from "../parts/bom";

const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** "C3 C4 C5 C7" as "C3-C5 C7": a run of references is one token. */
function runs(refs: string[]): string {
  const out: string[] = []; let i = 0;
  const split = (r: string) => { const m = /^(.*?)(\d+)$/.exec(r); return m ? [m[1], Number(m[2])] as [string, number] : null; };
  while (i < refs.length) {
    const a = split(refs[i]); let j = i;
    if (a) while (j + 1 < refs.length) { const b = split(refs[j + 1]); if (!b || b[0] !== a[0] || b[1] !== (split(refs[j]) as [string, number])[1] + 1) break; j++; }
    out.push(j - i >= 2 ? `${refs[i]}-${refs[j]}` : refs.slice(i, j + 1).join(" ")); i = j + 1;
  }
  return out.join(" ");
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/**
 * get_bom.  `get(path)` fetches a site-relative address as the person and returns the parsed JSON, or throws.
 * A line that names a vendor part is priced from that vendor; one that only has a manufacturer part number is
 * looked up by it (the first vendor that stocks it); the rest are listed as not yet chosen.
 */
export async function getBom(K: any, doc: any, others: { name: string; doc: any }[], a: any, get: (path: string) => Promise<any>): Promise<unknown> {
  const isSch = doc.type === "sch"; const lines: BomLine[] = collect(K, doc, isSch, others);
  const boards = Math.max(1, Math.min(100000, Math.floor(Number(a.boards) || 1))); const priced = a.prices !== false;
  const errors = new Set<string>();
  if (priced) await pool(lines, 6, async (l) => {
    try {
      if (l.vendor && l.vendorId) l.part = await get(`/api/parts/part?vendor=${encodeURIComponent(l.vendor)}&id=${encodeURIComponent(l.vendorId)}`);
      else if (l.mpn) {
        const r = await get(`/api/parts/search?q=${encodeURIComponent(l.mpn)}${a.vendor ? `&vendor=${encodeURIComponent(a.vendor)}` : ""}`);
        const same = (r.results || []).filter((p: any) => String(p.mpn || "").toLowerCase() === l.mpn.toLowerCase());
        l.part = same.sort((p: any, q: any) => (q.stock || 0) - (p.stock || 0))[0] || null;
        for (const e of r.errors || []) errors.add(e.message);
      }
    } catch (e) { l.err = e instanceof Error ? e.message : String(e); }
  });
  let cost = 0, currency = "", matched = 0; const short: string[] = [], unchosen: string[] = [];
  const rows = lines.map((l) => {
    const qty = l.refs.length, need = qty * boards; const p: any = l.part; const row: any = { refs: runs(l.refs), qty, value: l.value, footprint: (l.footprint.split(":").pop() || "") || undefined };
    if (l.vendor) row.part = `${l.vendor} ${l.vendorId}`; if (l.mpn) row.mpn = l.mpn; if (l.elsewhere.length) row.sheets = l.elsewhere;
    if (p) {
      matched++; if (!l.vendor) row.part = `${p.vendor} ${p.vendor_id}`; if (!row.mpn && p.mpn) row.mpn = p.mpn;
      const b = priceAt(p.prices || [], need);
      if (b) { row.unit = r4(b.price); row.total = r4(b.price * need); cost += b.price * need; currency = currency || b.currency; if (b.currency && currency && b.currency !== currency) row.currency = b.currency; }
      if (p.stock !== null && p.stock !== undefined) { row.stock = p.stock; if (p.stock < need) { row.short = need - p.stock; short.push(row.refs); } }
      if (p.lifecycle && !/^(active|production|)$/i.test(p.lifecycle)) row.lifecycle = p.lifecycle;
      if (p.assembly) row.assembly = p.assembly;
    } else if (l.err) row.lookup = l.err;
    else if (priced) unchosen.push(row.refs);
    return row;
  });
  const cap = 250; const parts = lines.reduce((n, l) => n + l.refs.length, 0);
  return { bom_of: isSch ? "the schematic (every sheet)" : "the board", boards, lines: rows.slice(0, cap), truncated: rows.length > cap ? `showing ${cap} of ${rows.length} lines` : undefined,
    totals: { parts, lines: lines.length, priced: priced ? matched : undefined, cost: priced && matched ? `${r4(cost)} ${currency || "USD"} for ${boards} board${boards > 1 ? "s" : ""}` : undefined, per_board: priced && matched ? r4(cost / boards) : undefined },
    short_of_stock: short.length ? short : undefined,
    no_part_chosen: unchosen.length ? unchosen : undefined,
    vendor_errors: errors.size ? Array.from(errors).slice(0, 4) : undefined,
    note: !priced ? undefined : unchosen.length ? "Lines under no_part_chosen carry no vendor part number or manufacturer part number, so they have no price: find_parts searches the vendors, and a set_field edit (LCSC, Mouser, DigiKey or MPN field) chooses one." : "Prices are the vendor's break for the quantity needed; stock is what the vendor listed when last asked." };
}
