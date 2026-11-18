// bomview.ts — the bill of materials of a PCB as a view of its own: the BOM sub-tab of a PCB's tab.
//
// The same BOM as the Vendor Parts dialog's (bom.ts collect / totals / CSV writers, and the vendor lookups of
// api.ts), laid out as a page: one line per distinct part of the PCB's schematic (every sheet), with its
// references, quantity, value, footprint, the vendor part its symbols name, stock and price for the number of
// boards asked for, and the two exports.
//
// It reads the schematic of ITS PCB and of no other: the sheets come from the project's list by the PCB's key
// (web/platform/doctabs/pcbs.ts), each as it is now (the stored file with the edits made since, the way the
// editor opens it).  The shell opens it like a tab: it is the editor of the "@bom" view
// (web/platform/documents/host.ts), whose document id is "bom:<PCB key>".
import { registerDocumentEditor, type DocumentHostContext } from "../../../platform/documents/host";
import { pcbsOf, relativePath, type Pcb, type PcbDoc } from "../../../platform/doctabs/pcbs";
import { api, type Part } from "./api";
import { collect, fullCsv, jlcCsv, priceAt, totals, type BomLine } from "./bom";

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, unknown> | null, ...kids: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "style") el.style.cssText = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "value") (el as HTMLInputElement).value = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const money = (n: number, currency: string): string => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", maximumFractionDigits: n < 1 ? 4 : 2 }).format(n); } catch (e) { return `${n.toFixed(n < 1 ? 4 : 2)} ${currency}`; } };
const stockText = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US"));

/** A schematic sheet as it is now: the stored file with the edits made since applied (the editor's own way, doc.ts openDoc). */
export async function readSheet(K: KiCadCanvasApi, docId: string, get: typeof fetch = fetch): Promise<KDoc | null> {
  const r = await get(`/api/docs/${docId}/content?v=${Date.now()}`);
  if (!r.ok) return null;
  const text = await r.text();
  const seq = Number(r.headers.get("x-snapshot-seq")) || 0, head = Number(r.headers.get("x-head-seq")) || 0;
  let doc: KDoc;
  try { doc = K.parseDoc(text, "kicad_sch"); } catch (e) { return null; }
  if (head > seq) {
    try {
      const o = await get(`/api/docs/${docId}/ops?since=${seq}`);
      if (o.ok) {
        const j = await o.json() as { ops?: { changes?: unknown[] }[] };
        for (const op of j.ops || []) for (const c of op.changes || []) { try { K.applyChange(doc, c as never, 1e4); } catch (e) { /* an edit this reader does not know: the line may be stale */ } }
      }
    } catch (e) { /* a guest may not read the edits: the stored file stands */ }
  }
  return doc;
}

/** The BOM lines of a PCB: its root sheet and every other sheet of it. */
export async function pcbBom(K: KiCadCanvasApi, pcb: Pcb<PcbDoc>, get: typeof fetch = fetch): Promise<{ lines: BomLine[]; sheets: number }> {
  if (!pcb.sheets.length) return { lines: [], sheets: 0 };
  const read = await Promise.all(pcb.sheets.map(async (d) => ({ d, doc: await readSheet(K, d.docId, get).catch(() => null) })));
  const got = read.filter((x) => x.doc) as { d: PcbDoc; doc: KDoc }[];
  if (!got.length) throw new Error("The schematic could not be read.");
  const [root, ...rest] = got;
  return { lines: collect(K, root.doc, true, rest.map((x) => ({ name: relativePath(pcb.dir, x.d.path).replace(/\.kicad_sch$/, ""), doc: x.doc }))), sheets: got.length };
}

const CSS = `
.bomv{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--paper);color:var(--ink);font-size:var(--fs-base)}
.bomv-head{display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px 24px;padding:20px 24px 14px}
.bomv-head h1{margin:0;font-size:var(--fs-xl);font-weight:600}
.bomv-head p{margin:2px 0 0;color:var(--ink-2)}
.bomv-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 24px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--bench)}
.bomv-bar label{display:flex;align-items:center;gap:6px;color:var(--ink-2)}
.bomv-body{flex:1;min-height:0;overflow:auto}
.bomv table{width:100%;border-collapse:collapse}
.bomv th{position:sticky;top:0;z-index:1;background:var(--bench);border-bottom:1px solid var(--line);padding:6px 10px;text-align:left;font:500 var(--fs-2xs) var(--mono);text-transform:uppercase;color:var(--ink-3);white-space:nowrap}
.bomv td{padding:7px 10px;border-bottom:1px solid color-mix(in srgb, var(--line) 50%, transparent);vertical-align:top}
.bomv th:first-child,.bomv td:first-child{padding-left:24px}
.bomv th:last-child,.bomv td:last-child{padding-right:24px}
.bomv tbody tr:hover{background:var(--sel-soft)}
.bomv .num{text-align:right;font-family:var(--mono);font-size:var(--fs-sm);white-space:nowrap}
.bomv .refs{font-family:var(--mono);font-size:var(--fs-sm);color:var(--teal);max-width:26ch;overflow-wrap:anywhere}
.bomv .dim{color:var(--ink-3);font-size:var(--fs-sm)}
.bomv .mono{font-family:var(--mono);font-size:var(--fs-sm)}
.bomv tfoot td{position:sticky;bottom:0;background:var(--bench);border-top:1px solid var(--line);font-weight:600}
.bomv-empty{padding:48px 24px;text-align:center;color:var(--ink-2)}
.bomv .short{color:var(--err)}
`;

class BomView {
  private root: HTMLElement;
  private lines: BomLine[] | null = null;
  private sheets = 0;
  private boards = 1;
  private error = "";
  private gen = 0;
  private closed = false;
  private onFocus = () => { void this.load(false); };

  constructor(private readonly ctx: DocumentHostContext, private readonly key: string) {
    if (!document.getElementById("bomv-css")) document.head.append(h("style", { id: "bomv-css" }, CSS));
    this.root = h("div", { class: "bomv", "data-bom-view": key });
    ctx.el.replaceChildren(this.root);
    window.addEventListener("focus", this.onFocus);
    void this.load(true);
  }

  close(): void { this.closed = true; this.gen++; window.removeEventListener("focus", this.onFocus); this.ctx.el.replaceChildren(); }

  private pcb(): Pcb<PcbDoc> | undefined { return pcbsOf(this.ctx.docs, this.ctx.project.name).find((p) => p.key === this.key); }

  private async load(first: boolean): Promise<void> {
    const pcb = this.pcb(); const gen = ++this.gen;
    if (!pcb) { this.error = "This PCB is no longer in the project."; this.lines = []; this.render(); return; }
    if (first) { this.ctx.setConnection("live", "reading the schematic…"); this.render(); }
    try {
      const K = (window as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas;
      const got = await pcbBom(K, pcb);
      if (gen !== this.gen || this.closed) return;
      // the vendor answers already on screen stay: a re-read changes the lines, not what a part costs
      const had = new Map((this.lines || []).filter((l) => l.part).map((l) => [l.key, l.part as Part]));
      for (const l of got.lines) if (had.has(l.key)) l.part = had.get(l.key)!;
      this.lines = got.lines; this.sheets = got.sheets; this.error = "";
      this.ctx.setConnection("live", "");
      const todo = got.lines.filter((l) => l.vendor && !l.part); for (const l of todo) l.loading = true;
      this.render();
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const l = todo[next++]; if (!l) return;
          try { l.part = await api.part(l.vendor!, l.vendorId); } catch (e) { l.err = (e as Error).message || "not found"; }
          l.loading = false;
          if (gen === this.gen && !this.closed) this.render();
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    } catch (e) {
      if (gen !== this.gen || this.closed) return;
      this.error = (e as Error).message || "The bill of materials could not be read."; this.lines = this.lines || [];
      this.ctx.setConnection("error", "could not read"); this.render();
    }
  }

  private download(name: string, text: string): void {
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  private render(): void {
    const pcb = this.pcb(), name = pcb ? pcb.name : "PCB", lines = this.lines || [];
    const t = totals(lines, this.boards);
    const stem = name.replace(/[^\w.-]+/g, "_");
    const focus = document.activeElement && (document.activeElement as HTMLElement).id === "bomv-boards";
    const summary = this.lines === null ? "Reading the schematic…" : this.error ? this.error : lines.length
      ? `${t.parts} ${t.parts === 1 ? "part" : "parts"} in ${t.lines} ${t.lines === 1 ? "line" : "lines"}${this.sheets > 1 ? ` on ${this.sheets} sheets` : ""} · ${t.matched} with a vendor part${t.matched ? ` · ${money(t.cost, t.currency)} for ${this.boards === 1 ? "one board" : this.boards + " boards"}` : ""}${t.short ? ` · ${t.short} short of stock` : ""}`
      : "No parts yet.";
    const head = h("div", { class: "bomv-head" },
      h("div", { style: "flex:1;min-width:0" }, h("h1", { "data-bom-title": "" }, `${name} — bill of materials`), h("p", { id: "bomv-sum", "data-bom-summary": "" }, summary)));
    const bar = h("div", { class: "bomv-bar" },
      h("label", null, "Boards", h("input", { class: "input mono", type: "number", id: "bomv-boards", min: "1", max: "100000", value: String(this.boards), style: "width:88px",
        oninput: (ev: Event) => { const n = Math.floor(+(ev.target as HTMLInputElement).value); if (n >= 1 && n !== this.boards) { this.boards = Math.min(n, 100000); this.render(); } } })),
      h("span", { style: "flex:1" }),
      h("button", { class: "btn", type: "button", "data-bom-refresh": "", title: "Read the schematic again", onclick: () => void this.load(false) }, "Refresh"),
      pcb && pcb.schematic ? h("button", { class: "btn", type: "button", "data-bom-open-sch": "", title: "Parts are added and given vendor parts in the schematic", onclick: () => this.ctx.openDoc(pcb.schematic!.docId) }, "Open schematic") : null,
      h("button", { class: "btn", type: "button", id: "bomv-jlc", disabled: !lines.length, title: "Comment, Designator, Footprint, LCSC Part #: the file JLCPCB's assembly order asks for", onclick: () => this.download(`${stem}-jlcpcb-bom.csv`, jlcCsv(lines)) }, "JLCPCB BOM"),
      h("button", { class: "btn primary", type: "button", id: "bomv-csv", "data-bom-csv": "", disabled: !lines.length, title: "Every line with stock and prices, for a spreadsheet", onclick: () => this.download(`${stem}-bom.csv`, fullCsv(lines, this.boards)) }, "Export CSV"));
    let main: HTMLElement;
    if (this.lines === null) main = h("div", { class: "bomv-empty" }, h("span", { class: "spinner" }), " Reading the schematic…");
    else if (!lines.length) main = h("div", { class: "bomv-empty", "data-bom-empty": "" }, h("b", null, this.error || `${name} has no parts yet.`), h("p", null, "Place symbols on the schematic and they are listed here. Symbols marked “exclude from BOM” or “do not populate”, and power symbols, are left out."));
    else {
      const body = h("tbody");
      lines.forEach((l, i) => {
        const need = l.refs.length * this.boards, p = l.part, pr = p ? priceAt(p.prices, need) : null;
        const part: Child[] = l.vendor
          ? [h("div", null, (p && p.mpn) || l.mpn || l.vendorId), h("div", { class: "dim" }, `${p ? p.vendor_name : l.vendor.toUpperCase()} `, h("span", { class: "mono" }, l.vendorId), l.loading ? h("span", { class: "spinner", style: "margin-left:6px" }) : null, l.err ? h("span", { class: "short", style: "margin-left:6px", title: l.err }, "not found") : null)]
          : [h("span", { class: "dim" }, l.mpn ? l.mpn : "No vendor part")];
        body.append(h("tr", { "data-bom-line": l.key, "data-refs": l.refs.join(" ") },
          h("td", { class: "num dim" }, String(i + 1)),
          h("td", { class: "refs", title: l.refs.join(", ") }, l.refs.length > 12 ? l.refs.slice(0, 12).join(", ") + ` +${l.refs.length - 12}` : l.refs.join(", ")),
          h("td", { class: "num" }, String(need)),
          h("td", null, l.value),
          h("td", { class: "dim", title: l.footprint }, l.footprint.includes(":") ? l.footprint.slice(l.footprint.indexOf(":") + 1) : l.footprint),
          h("td", null, ...part),
          h("td", { class: "num" + (p && p.stock !== null && p.stock < need ? " short" : ""), title: p ? `In stock at ${p.vendor_name}` : "" }, p && p.stock !== null ? stockText(p.stock) : ""),
          h("td", { class: "num", title: p && pr ? `${p.vendor_name} price for ${pr.qty.toLocaleString("en-US")} or more` : "" }, pr ? money(pr.price, pr.currency) : ""),
          h("td", { class: "num" }, pr ? money(pr.price * need, pr.currency) : "")));
      });
      main = h("table", { id: "bomv-table", "data-bom-table": "" },
        h("thead", null, h("tr", null, h("th", { class: "num" }, "#"), h("th", null, "References"), h("th", { class: "num" }, "Qty"), h("th", null, "Value"), h("th", null, "Footprint"), h("th", null, "Vendor part"), h("th", { class: "num" }, "Stock"), h("th", { class: "num" }, "Each"), h("th", { class: "num" }, "Total"))),
        body,
        h("tfoot", null, h("tr", null, h("td"), h("td", null, `${t.lines} ${t.lines === 1 ? "line" : "lines"}`), h("td", { class: "num" }, String(t.parts * this.boards)), h("td", { colspan: "5", class: "dim" }, t.matched < t.lines ? `${t.lines - t.matched} ${t.lines - t.matched === 1 ? "line has" : "lines have"} no vendor part: no price for them` : ""), h("td", { class: "num" }, t.matched ? money(t.cost, t.currency) : ""))));
    }
    this.root.replaceChildren(head, bar, h("div", { class: "bomv-body" }, main));
    if (focus) { const i = this.root.querySelector<HTMLInputElement>("#bomv-boards"); if (i) { i.focus(); } }
  }
}

/** Called once by the editor's script as it loads. */
export function registerBomView(): void {
  registerDocumentEditor({
    docTypes: ["@bom"],
    open(ctx) { return new BomView(ctx, ctx.doc.docId.replace(/^bom:/, "")); },
  });
}
