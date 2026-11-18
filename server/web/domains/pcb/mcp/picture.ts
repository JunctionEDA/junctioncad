// mcp/picture — a document drawn as an SVG that needs no fonts.
//
// The editor's own SVG export (canvas/export.ts renderSvg) writes text as <text> elements, which
// is right for a file a person opens in a browser.  The MCP endpoint rasterises the picture on the
// server, where there are no fonts to draw them with, so here text is laid out in KiCad's stroke
// font by the same code that paints the canvas (drawTextStroke) and written as plain paths.  It
// then looks the way the editor shows it.  Everything else is the export's own geometry.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { PCB_BG, PCB_PAGE_LIMITS, PCB_SHEET, SCH } from "../canvas/colors";
import { exportBox, fmt, svgGeom } from "../canvas/export";
import { HIDDEN_TEXT_ALPHA, drawTextStroke } from "../canvas/render";
import { documentDrawingSheet } from "../canvas/sheet";

/** The handful of canvas calls the stroke-font painter makes, recorded as SVG. */
class Recorder {
  out: string[] = [];
  strokeStyle: any = "#000"; fillStyle: any = "#000"; lineWidth = 1; lineCap = "round"; lineJoin = "round";
  private m = [1, 0, 0, 1, 0, 0];
  private d = "";
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void { this.m = [a, b, c, d, e, f]; }
  private pt(x: number, y: number): string { const m = this.m; return fmt(m[0] * x + m[2] * y + m[4]) + " " + fmt(m[1] * x + m[3] * y + m[5]); }
  beginPath(): void { this.d = ""; }
  moveTo(x: number, y: number): void { this.d += "M" + this.pt(x, y); }
  lineTo(x: number, y: number): void { this.d += "L" + this.pt(x, y); }
  stroke(): void {
    if (!this.d) return; const m = this.m;
    // the pen is given in the units of the current transform
    const w = this.lineWidth * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    this.out.push(`<path d="${this.d}" fill="none" stroke="${this.strokeStyle}" stroke-width="${fmt(w)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    this.d = "";
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.out.push(`<path d="M${this.pt(x, y)}L${this.pt(x + w, y)}L${this.pt(x + w, y + h)}L${this.pt(x, y + h)}Z" fill="${this.fillStyle}"/>`);
  }
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

export function textPaths(g: any, hairline: number, bg: string): string {
  if (!g.text && !g.raw) return "";
  const rec = new Recorder();
  drawTextStroke(rec as any, g, hairline, g.color, IDENTITY, false, bg);
  if (!rec.out.length) return "";
  const op = g.alpha !== undefined && g.alpha < 1 ? ` opacity="${fmt(g.alpha)}"` : "";
  return `<g${op}>${rec.out.join("")}</g>`;
}

/** What a picture can point out on top of the drawing (all in mm). */
export interface Emphasis {
  /** items drawn again at full strength over a dimmed drawing */ ids?: Set<string>;
  /** dim everything that is not emphasised */ dim?: boolean;
  /** outlines: [x0, y0, x1, y1, colour?] */ boxes?: (number | string)[][];
  /** lines: [x1, y1, x2, y2, width, colour?] */ segs?: (number | string)[][];
  /** numbered rings: where a check found something */ marks?: { x: number; y: number; label: string; color?: string }[];
  /** name tags: a person's cursor */ tags?: { x: number; y: number; label: string; color: string }[];
}

function emphasisSvg(doc: any, e: Emphasis, x0: number, y0: number, w: number, h: number, hairline: number, bg: string, one: (g: any) => string, hidden: Set<string>): string[] {
  const out: string[] = []; const isPcb = doc.type === "pcb"; const u = Math.max(w, h) / 500;   // a pen that reads at any zoom
  const ink = isPcb ? "#FFFFFF" : "#D0109A";
  if (e.dim) out.push(`<rect x="${fmt(x0)}" y="${fmt(y0)}" width="${fmt(w)}" height="${fmt(h)}" fill="${bg || PCB_BG}" opacity="0.72"/>`);
  if (e.ids && e.ids.size && e.dim) {
    const buckets = new Map<number, any[]>();
    for (const id of e.ids) { const it = doc.items.get(id); if (!it) continue; for (const g of it.geom) { if (hidden.has(g.layer)) continue; const z = g.z === undefined ? 0 : g.z; let arr = buckets.get(z); if (!arr) buckets.set(z, arr = []); arr.push(g); } }
    for (const z of Array.from(buckets.keys()).sort((a, b) => a - b)) for (const g of buckets.get(z)!) { const s = one(g); if (s) out.push(s); }
  }
  for (const s of e.segs || []) out.push(`<line x1="${fmt(+s[0])}" y1="${fmt(+s[1])}" x2="${fmt(+s[2])}" y2="${fmt(+s[3])}" stroke="${s[5] || ink}" stroke-opacity="0.6" stroke-width="${fmt(Math.max(+s[4] || 0, 1.6 * u))}" stroke-linecap="round"/>`);
  for (const b of e.boxes || []) out.push(`<rect x="${fmt(+b[0])}" y="${fmt(+b[1])}" width="${fmt(Math.max(+b[2] - +b[0], u))}" height="${fmt(Math.max(+b[3] - +b[1], u))}" fill="none" stroke="${b[4] || ink}" stroke-width="${fmt(1.4 * u)}"/>`);
  const label = (x: number, y: number, text: string, color: string, size: number) => textPaths({ t: "text", x, y, text, size, w: size * 0.16, color, rot: 0, h: "left", v: "center", bold: true }, hairline, bg);
  for (const m of e.marks || []) {
    const c = m.color || "#FF2A2A", r = 5 * u;
    out.push(`<circle cx="${fmt(m.x)}" cy="${fmt(m.y)}" r="${fmt(r)}" fill="none" stroke="${c}" stroke-width="${fmt(1.6 * u)}"/>`);
    out.push(label(m.x + r * 1.25, m.y - r * 1.1, m.label, c, 7 * u));
  }
  for (const t of e.tags || []) {
    const s = 9 * u;
    out.push(`<path d="M${fmt(t.x)} ${fmt(t.y)}L${fmt(t.x + 0.38 * s)} ${fmt(t.y + s)}L${fmt(t.x + s)} ${fmt(t.y + 0.38 * s)}Z" fill="${t.color}" stroke="#fff" stroke-width="${fmt(0.5 * u)}"/>`);
    out.push(label(t.x + s * 1.1, t.y + s * 1.3, t.label, t.color, 6.5 * u));
  }
  return out;
}

/** Same options as KiCadCanvas.renderSvg: bbox, ids, margin, hidden, background, frame; and `emphasis`. */
export function renderPicture(doc: any, opts: any): string {
  opts = opts || {}; const isPcb = doc.type === "pcb"; const hidden: Set<string> = opts.hidden || new Set();
  const { ids, x0, y0, w, h } = exportBox(doc, opts) as any; const x1 = x0 + w, y1 = y0 + h;
  const hairline = 0.1; const bg: string = opts.background === undefined ? (isPcb ? PCB_BG : SCH.bg) : opts.background;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="${fmt(x0)} ${fmt(y0)} ${fmt(w)} ${fmt(h)}" stroke-linejoin="round">`];
  if (bg) out.push(`<rect x="${fmt(x0)}" y="${fmt(y0)}" width="${fmt(w)}" height="${fmt(h)}" fill="${bg}"/>`);
  const one = (g: any): string => (g.t === "text" ? textPaths(g, hairline, bg || PCB_BG) : svgGeom(g, hairline, isPcb, bg || PCB_BG));

  // KiCad's drawing sheet (frame and title block) belongs to a whole schematic page; a board picture is cropped to the board
  const frame = opts.frame !== undefined ? opts.frame : (!isPcb && !ids && !opts.bbox);
  if (frame) {
    const ink = isPcb ? PCB_SHEET : SCH.frame;
    for (const it of documentDrawingSheet(doc) as any[]) {
      if (it.t === "line") out.push(`<line x1="${fmt(it.x1)}" y1="${fmt(it.y1)}" x2="${fmt(it.x2)}" y2="${fmt(it.y2)}" stroke="${ink}" stroke-width="${fmt(it.w)}"/>`);
      else if (it.t === "rect") out.push(`<rect x="${fmt(it.x)}" y="${fmt(it.y)}" width="${fmt(it.w)}" height="${fmt(it.h)}" fill="none" stroke="${ink}" stroke-width="${fmt(it.lw)}"/>`);
      else if (it.t === "text") out.push(textPaths({ t: "text", x: it.x, y: it.y, text: it.text, size: it.size, w: it.w, color: it.color || ink, rot: it.rot, h: it.h, v: it.v, bold: it.bold, italic: it.italic, multiline: it.multiline }, hairline, bg));
    }
    out.push(`<rect x="0" y="0" width="${fmt(doc.page[0])}" height="${fmt(doc.page[1])}" fill="none" stroke="${isPcb ? PCB_PAGE_LIMITS : SCH.pageLimits}" stroke-width="${fmt(hairline)}"/>`);
  }

  const buckets = new Map<number, any[]>();
  const take = (g: any) => { const z = g.z === undefined ? 0 : g.z; let arr = buckets.get(z); if (!arr) { arr = []; buckets.set(z, arr); } arr.push(g); };
  for (const it of doc.items.values()) {
    if (ids && !ids.has(it.id)) continue;
    if (opts.zones === false && it.kind === "zone") continue;
    const b = it.bbox; if (b && (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1)) continue;
    for (const g of it.geom) { if (hidden.has(g.layer) || (opts.padNumbers === false && g.padNum) || (opts.copperOnly && g.layer && /Silk|Fab|CrtYd|Courtyard|Paste|Mask|User|Cmts|Dwgs|Eco|Margin/i.test(g.layer))) continue; take(g); }
  }
  for (const z of Array.from(buckets.keys()).sort((a, b) => a - b)) for (const g of buckets.get(z)!) {
    const s = one(g); if (!s) continue;
    out.push(g.hiddenText ? `<g opacity="${HIDDEN_TEXT_ALPHA}">${s}</g>` : s);
  }
  if (opts.emphasis) out.push(...emphasisSvg(doc, opts.emphasis, x0, y0, w, h, hairline, bg, one, hidden));
  out.push("</svg>");
  return out.join("\n");
}
