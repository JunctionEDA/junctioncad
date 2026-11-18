// pcbdialogs/barcode — Barcode Properties (DIALOG_BARCODE_PROPERTIES, dialog_barcode_properties_base.fbp) for a
// PCB_BARCODE: the text on top; Locked / Knockout / Show text; Layer, Position X / Y, Size X / Y, Orientation, Text
// size, Min margin X / Y beside the "Code" and "Error Correction" radio boxes; the preview on the right, redrawn on
// every change (OnValuesChanged / OnTextValueChanged).  OnUpdateUI greys the error correction for the 1D codes, the
// text size without Show text, the margins without Knockout, and level H for Micro QR (Q is picked instead).
// TransferDataFromWindow refuses a text the symbology cannot encode ("Barcode Error"), else commits "Modify Barcode";
// DRAWING_TOOL::DrawBarcode opens it on the new barcode and commits "Draw Barcode" on OK.
import { code128, code39 } from "../../canvas/barcode";
import { barcode2D } from "../../canvas/barcode2d";
import { PCB_BG, pcbColor } from "../../canvas/colors";
import { comboBox } from "../../../../shared/components/kcombo";
import { checkField, coordField, errorMessage, form, h, lenField, numField, openDialog, radioBox, selectField, textField, unitLabel, type Field } from "./ui";

const isList = Array.isArray;
const K = (): KiCadCanvasApi => KiCadCanvas;
const kid = (n: SNode | null, key: string): SNode | null => (n ? (K().kid(n, key) as SNode | null) : null);
const sval = (n: SNode | null, i = 1): string => (n && n[i] !== undefined ? String(n[i]) : "");
const nval = (n: SNode | null, i = 1, d = 0): number => (n && typeof n[i] === "number" ? (n[i] as number) : d);
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const f6 = (v: number): string => String(+(+v).toFixed(6));
const yes = (n: SNode | null): boolean => !!n && (n.length < 2 || String(n[1]) !== "no");
function idxOf(node: SNode, key: string): number { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return j; } return -1; }
function put(node: SNode, key: string, text: string | null, before: string[] = []): void {
  const i = idxOf(node, key);
  if (text === null) { if (i > 0) node.splice(i, 1); return; }
  const n = K().parse(text) as SNode;
  if (i > 0) { node[i] = n; return; }
  let at = node.length;
  for (const b of before) { const j = idxOf(node, b); if (j > 0) { at = j; break; } }
  node.splice(at, 0, n);
}
interface LockApi { isLocked(n: SNode): boolean }
const PT = (): LockApi => (window as unknown as { PcbTools: LockApi }).PcbTools;

/** BARCODE_T in m_barcode's order, and BARCODE_ECC_T L..H. */
export const BARCODE_TYPES = ["code39", "code128", "datamatrix", "qr", "microqr"];
const TYPE_LABELS = ["Code 39 (ISO 16388)", "Code 128 (ISO 15417)", "Data Matrix (ECC 200)", "QR Code (ISO 18004)", "Micro QR Code"];
const ECC_LABELS = ["~20% (Level L)", "~37% (Level M)", "~55% (Level Q)", "~65% (Level H)"];

export interface BarcodeValues { text: string; locked: boolean; layer: string; x: number; y: number; w: number; h: number; angle: number; textSize: number; showText: boolean; knockout: boolean; marginX: number; marginY: number; type: number; ecc: number }

export function readBarcode(node: SNode): BarcodeValues {
  const at = kid(node, "at"), sz = kid(node, "size"), mg = kid(node, "margins");
  const type = Math.max(0, BARCODE_TYPES.indexOf(sval(kid(node, "type")) || "qr"));
  return { text: sval(kid(node, "text")), locked: PT() ? PT().isLocked(node) : yes(kid(node, "locked")), layer: sval(kid(node, "layer")) || "Dwgs.User",
    x: nval(at, 1), y: nval(at, 2), angle: nval(at, 3), w: nval(sz, 1, 40), h: nval(sz, 2, nval(sz, 1, 40)), textSize: nval(kid(node, "text_height"), 1, 1.5),
    showText: !yes(kid(node, "hide")), knockout: yes(kid(node, "knockout")), marginX: nval(mg, 1), marginY: nval(mg, 2), type, ecc: Math.max(0, "LMQH".indexOf(sval(kid(node, "ecc_level")) || "L")) };
}

/** transferDataToBarcode onto the node, in PCB_IO_KICAD_SEXPR::format( PCB_BARCODE )'s order. */
export function writeBarcode(node: SNode, v: BarcodeValues): void {
  const keep = (k: string) => { const c = kid(node, k); return c ? K().serialize(c) : null; };
  const uuid = keep("uuid");
  node.length = 1;
  if (v.locked) node.push(K().parse("(locked yes)") as SNode);
  const parts = [`(at ${f6(v.x)} ${f6(v.y)} ${f6(normAngle(v.angle))})`, `(layer ${quote(v.layer)})`, `(size ${f6(v.w)} ${f6(v.h)})`, `(text ${quote(v.text)})`, `(text_height ${f6(v.textSize)})`, `(type ${BARCODE_TYPES[v.type]})`];
  if (v.type >= 3) parts.push(`(ecc_level ${"LMQH"[v.ecc]})`);
  parts.push(`(hide ${v.showText ? "no" : "yes"})`, `(knockout ${v.knockout ? "yes" : "no"})`);
  if (v.marginX || v.marginY) parts.push(`(margins ${f6(v.marginX)} ${f6(v.marginY)})`);
  if (uuid) parts.push(uuid);
  for (const p of parts) node.push(K().parse(p) as SNode);
}
const normAngle = (a: number): number => { let r = a % 360; if (r <= -180) r += 360; if (r > 180) r -= 360; return Math.abs(r) < 1e-9 ? 0 : r; };

/** The symbol's modules as rectangles in its own frame (centred, w x h), or the encoder's error; empty text: none. */
export function barcodeSymbol(v: Pick<BarcodeValues, "text" | "type" | "ecc" | "w" | "h">): { rects: number[][]; error: string | null } {
  const rects: number[][] = [], W = v.w, H = v.h, type = BARCODE_TYPES[v.type];
  if (!v.text) return { rects, error: null };
  if (/[^\x00-\x7f]/.test(v.text) && (type === "code39" || type === "code128")) return { rects, error: "This barcode type does not support international characters. Use QR Code or Data Matrix instead." };
  if (type === "code39" || type === "code128") {
    const bc = type === "code39" ? code39(v.text) : code128(v.text);
    if (!bc) return { rects, error: type === "code39" ? "Invalid character in input (alphanumerics, space and \"-.$/+%\" only)" : "Invalid character in input" };
    for (const [a, b] of bc.bars) rects.push([-W / 2 + W * a / bc.modules, -H / 2, -W / 2 + W * b / bc.modules, H / 2]);
    return { rects, error: null };
  }
  const m = barcode2D(type, v.text, v.ecc);
  if (!m || !m.rows) return { rects, error: (m && m.error) || "Invalid barcode type" };
  const nr = m.rows.length, nc = m.rows[0].length;
  m.rows.forEach((row, y) => { for (let x = 0; x < nc;) { if (!row[x]) { x++; continue; } let e = x; while (e < nc && row[e]) e++; rects.push([-W / 2 + W * x / nc, -H / 2 + H * y / nr, -W / 2 + W * e / nc, -H / 2 + H * (y + 1) / nr]); x = e; } });
  return { rects, error: null };
}

/** m_panelShowBarcodeGal: the barcode alone, auto-zoomed to its polygon box at 0.7 (refreshPreview). */
function drawPreview(cv: HTMLCanvasElement, v: BarcodeValues): void {
  const g = cv.getContext("2d"); if (!g) return;
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1, Wc = cv.clientWidth || 300, Hc = cv.clientHeight || 300;
  cv.width = Wc * dpr; cv.height = Hc * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = PCB_BG; g.fillRect(0, 0, Wc, Hc);
  if (!(v.w > 0) || !(v.h > 0)) return;
  const { rects } = barcodeSymbol(v);
  const textY = v.h / 2 + 1, showText = v.showText && !!v.text;
  let y1 = v.h / 2; if (showText) y1 = textY + v.textSize;
  const minSide = Math.min(v.w, v.h), m = Math.max(Math.ceil(minSide * 0.1 / 0.1 - 1e-9) * 0.1, 0);
  const ml = v.knockout ? Math.max(v.marginX, m) : 0, mt = v.knockout ? Math.max(v.marginY, m) : 0;
  const bx0 = -v.w / 2 - ml, by0 = -v.h / 2 - mt, bx1 = v.w / 2 + ml, by1 = y1 + mt;
  const back = /^B\./.test(v.layer), mx = back ? -1 : 1, rad = -v.angle * Math.PI / 180;
  // the turned box's extent, for the zoom
  const cs = Math.abs(Math.cos(rad)), sn = Math.abs(Math.sin(rad)), bw = bx1 - bx0, bh = by1 - by0;
  const ext = Math.max((bw * cs + bh * sn) / Wc, (bw * sn + bh * cs) / Hc);
  const scale = 0.7 / ext;
  g.save(); g.translate(Wc / 2, Hc / 2); g.scale(scale, scale); g.rotate(rad); g.scale(mx, 1);
  g.translate(-(bx0 + bx1) / 2, -(by0 + by1) / 2);
  const color = pcbColor(v.layer);
  if (v.knockout) { g.fillStyle = color; g.fillRect(bx0, by0, bw, bh); }
  const ink = v.knockout ? PCB_BG : color;
  g.fillStyle = ink;
  for (const [x0, y0, x2, y2] of rects) g.fillRect(x0, y0, x2 - x0, y2 - y0);
  if (showText) {
    g.save(); g.translate(0, textY); if (back) g.scale(-1, 1);
    g.font = `${v.textSize * 1.25}px sans-serif`; g.textAlign = "center"; g.textBaseline = "top"; g.fillText(v.text, 0, 0); g.restore();
  }
  g.restore();
}

const layerLabel = (doc: KDoc, name: string): string => { const l = doc.layers.get(name); return l && l.userName ? l.userName : name; };

/**
 * Open Barcode Properties on `node` (a copy is edited).  `done(node)` receives the edited node on OK (null on Cancel)
 * for a new barcode; for an existing one pass `item` and the change is committed here.
 */
export function barcodeDialog(ctx: ToolCtx, node: SNode, item: KItem | null, done?: (n: SNode | null) => void): boolean {
  const doc = ctx.doc; if (!doc) return false;
  const ro = !!ctx.viewOnly, v0 = readBarcode(node);
  const layers: [string, string][] = Array.from(doc.layers.keys()).map((n): [string, string] => [n, layerLabel(doc, n)]);
  if (!layers.some((l) => l[0] === v0.layer)) layers.unshift([v0.layer, v0.layer]);
  const text = textField(v0.text, { ro, key: "text" });
  const locked = checkField(v0.locked, "Locked", { ro, key: "locked" });
  const knockout = checkField(v0.knockout, "Knockout", { ro, key: "knockout", onChange: () => update() });
  const showText = checkField(v0.showText, "Show text", { ro, key: "showText", onChange: () => update() });
  const layer = selectField<string>(v0.layer, layers, { ro, key: "layer", onChange: () => update() });
  const x = coordField(v0.x, "x", { ro, key: "posX" }), y = coordField(v0.y, "y", { ro, key: "posY" });
  const w = lenField(v0.w, { ro, key: "sizeX" }), ht = lenField(v0.h, { ro, key: "sizeY" });
  const angle: Field<number> = numField(normAngle(v0.angle), { ro, key: "orientation", digits: 3 });
  comboBox(angle.input as HTMLInputElement, () => ["0.0", "90.0", "-90.0", "180.0"]);
  const textSize = lenField(v0.textSize, { ro, key: "textSize" });
  const marginX = lenField(v0.marginX, { ro, key: "marginX" }), marginY = lenField(v0.marginY, { ro, key: "marginY" });
  const kind = radioBox("Code", TYPE_LABELS, v0.type, { ro, key: "code", onChange: () => update() });
  const ecc = radioBox("Error Correction", ECC_LABELS, v0.ecc, { ro, key: "ecc", onChange: () => update() });
  const cv = h("canvas", { class: "bc-preview", "data-k": "preview" }) as HTMLCanvasElement;
  const values = (): BarcodeValues => ({ text: text.get(), locked: locked.get(), layer: layer.get(), x: x.get(), y: y.get(), w: w.get(), h: ht.get(), angle: angle.get(), textSize: textSize.get(),
    showText: showText.get(), knockout: knockout.get(), marginX: marginX.get(), marginY: marginY.get(), type: kind.get(), ecc: ecc.get() });
  const dis = (f: Field<number>, on: boolean) => { (f.input as HTMLInputElement).disabled = ro || !on; };
  /** OnUpdateUI then refreshPreview. */
  const update = (): void => {
    const enableEC = kind.get() >= 3; ecc.enable(enableEC);
    dis(textSize, showText.get()); dis(marginX, knockout.get()); dis(marginY, knockout.get());
    if (enableEC) { const micro = kind.get() === 4; ecc.enableItem(3, !micro); if (micro && ecc.get() === 3) ecc.set(2); }
    drawPreview(cv, values());
  };
  for (const f of [text, x, y, w, ht, angle, textSize, marginX, marginY]) { f.input.addEventListener("input", update); f.input.addEventListener("change", update); }
  const label = (t: string): HTMLElement => h("label", null, t);
  const gridEl = h("div", { class: "bc-grid" },
    label("Layer:"), h("div", { style: "grid-column: span 2" }, layer.el),
    label("Position X:"), x.el, unitLabel(), label("Position Y:"), y.el, unitLabel(),
    label("Size X:"), w.el, unitLabel(), label("Size Y:"), ht.el, unitLabel(), h("div", { class: "gap" }),
    label("Orientation:"), angle.el, unitLabel("deg"), h("div", { class: "gap" }),
    label("Text size:"), textSize.el, unitLabel(), h("div", { class: "gap" }),
    label("Min margin X:"), marginX.el, unitLabel(), label("Min margin Y:"), marginY.el, unitLabel());
  const css = `.bc-body { display: flex; flex-direction: column; gap: 8px; }
.bc-main { display: flex; gap: 10px; min-height: 0; }
.bc-checks { display: flex; gap: 25px; }
.bc-grid { display: grid; grid-template-columns: max-content minmax(90px, 130px) max-content; gap: 3px 6px; align-items: center; }
.bc-grid .gap { grid-column: 1 / -1; height: 6px; }
.bc-left { display: flex; gap: 10px; }
.bc-radios { display: flex; flex-direction: column; gap: 8px; }
.bc-preview { flex: 1; min-width: 260px; min-height: 300px; border: 1px solid var(--line); border-radius: 3px; }`;
  return !!openDialog({ title: "Barcode Properties", width: 860, readOnly: ro,
    build(body) {
      body.append(h("style", null, css), h("div", { class: "bc-body" },
        h("div", { class: "pd-row", style: "display:flex;gap:6px;align-items:center" }, label("Text:"), h("div", { style: "flex:1;display:flex" }, text.el)),
        h("div", { class: "bc-main" },
          h("div", { style: "display:flex;flex-direction:column;gap:8px" }, h("div", { class: "bc-checks" }, locked.el, knockout.el, showText.el),
            h("div", { class: "bc-left" }, gridEl, h("div", { class: "bc-radios" }, kind.el, ecc.el))),
          cv)));
      (text.input as HTMLInputElement).style.flex = "1";
      requestAnimationFrame(() => { update(); (text.input as HTMLInputElement).focus(); });
    },
    cancel: done ? () => done(null) : undefined,
    ok() {
      if (ro) return true;
      const v = values();
      if (!(v.w > 0) || !(v.h > 0)) { errorMessage("Size must be greater than 0."); return false; }
      const sym = barcodeSymbol(v);
      if (v.text && sym.error) { errorMessage(sym.error); return false; }   // wxMessageBox( GetLastError(), "Barcode Error" )
      const staged = (K().cloneNode as (n: SNode) => SNode)(node); writeBarcode(staged, v);
      if (done) { done(staged); return true; }
      if (item && K().serialize(staged) !== K().serialize(item.node)) ctx.commit([K().replaceChange(doc, { ...item, node: staged, geom: [], bbox: null })], "Modify Barcode");
      return true;
    } });
}

/** setNewItemDialogs' barcode entry: DRAWING_TOOL::DrawBarcode's dialog on the new item. */
export function newBarcodeDialog(ctx: ToolCtx, node: SNode, done: (node: SNode | null) => void): boolean {
  const ok = barcodeDialog(ctx, node, null, done);
  if (!ok) done(null);
  return ok;
}
