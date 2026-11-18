// sim/plot.ts — SIM_PLOT_TAB's plot window (wxMathPlot's mpWindow as KiCad configures it in sim_plot_tab.cpp):
// an X axis (linear time / swept value, or logarithmic frequency), up to three Y axes (Y1 on the left, Y2 on the
// right, Y3 at the right border when a power trace is shown), the traces in their colours (current / phase ones dotted
// when "Dotted Current/Phase" is on), a grid, a legend, the two cursors, and mpWindow's mouse handling: the wheel
// zooms (Ctrl pans left / right, Shift up / down, SIM_MOUSE_WHEEL_ACTION_SET::GetMouseDefaults), a left drag zooms to
// a box, a right drag pans, a right click opens the context menu, and every zoom is kept for Undo / Redo Last Zoom.
// The plot keeps KiCad's own colours (SIM_PLOT_COLORS: white or black background), not the page theme.

export interface PlotTrace {
  name: string; xs: ArrayLike<number>; ys: ArrayLike<number>; color: string;
  /** 0 = Y1 (left), 1 = Y2 (right), 2 = Y3 (right border) */
  axis: 0 | 1 | 2;
  /** current / phase trace: drawn dotted when the tab's dottedSecondary is on */
  secondary?: boolean;
  /** cursors 1 and 2 are shown on this trace */
  cursor1?: boolean; cursor2?: boolean;
  /** the complex values (reflection coefficients) a Smith chart draws: SMITH_TRACE's data */
  gamma?: { re: ArrayLike<number>; im: ArrayLike<number> };
}
export interface PlotAxis { name: string; units: string }
interface Range { min: number; max: number }
interface View { x: Range; y: [Range, Range, Range] }

export const PLOT_COLORS = {
  light: { bg: "#ffffff", fg: "#000000", axis: "rgb(130,130,130)" },
  dark: { bg: "#000000", fg: "#ffffff", axis: "rgb(130,130,130)" },
};
/** SIM_PLOT_COLORS::m_colorList: the trace colours, picked in turn for new traces. */
export const TRACE_COLORS = ["#E41A1C", "#377EB8", "#4DAF4A", "#984EA3", "#FF7F00", "#FFFF33", "#A65628", "#F781BF",
  "#66C2A5", "#FC8D62", "#8DA0CB", "#E78AC3", "#A6D854", "#FFD92F", "#E5C494", "#B3B3B3"];

const SI: [number, string][] = [[1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "K"], [1, ""], [1e-3, "m"], [1e-6, "u"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]];
/** LIN_SCALE / LOG_SCALE tick labels: the value with the SI prefix that fits the axis span and the unit. */
export type WheelAction = "none" | "panLR" | "panRL" | "panUD" | "zoom" | "zoomH" | "zoomV";
export function tickLabel(v: number, units: string, span: number): string {
  if (v === 0 || !Number.isFinite(v)) return "0" + units;
  if (units === "°" || units === "dB" || units === "°C") { const d = span >= 10 ? 0 : span >= 1 ? 1 : 2; return v.toFixed(d) + units; }
  const ref = Math.max(Math.abs(v), span / 10);
  let [mul, pfx] = SI[SI.length - 1]; for (const s of SI) if (ref >= s[0] * 0.9999) { [mul, pfx] = s; break; }
  const x = v / mul, sp = span / mul, dec = sp >= 100 ? 0 : sp >= 10 ? 1 : sp >= 1 ? 2 : 3;
  let t = x.toFixed(dec); if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
  return t + pfx + units;
}
/** A tick step of 1, 2 or 5 × 10ⁿ giving about `n` ticks over the span. */
export function niceStep(span: number, n: number): number {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

export interface PlotOptions { logX: boolean; x: PlotAxis; y: (PlotAxis | null)[] }

export class SimPlot {
  readonly el: HTMLDivElement; readonly canvas: HTMLCanvasElement;
  traces: PlotTrace[] = [];
  opts: PlotOptions = { logX: false, x: { name: "Time", units: "s" }, y: [{ name: "Voltage", units: "V" }, null, null] };
  showGrid = true; showLegend = true; dottedSecondary = true; dark = false;
  /** SIM_VIEW::SetSmithChart: an S-parameter tab drawn on a Smith chart (SMITH_GRID, SMITH_TRACE) */
  smith = false;
  /** SIM_VIEW's Smith zoom (1 fits the window, up to 50) and pan (the reflection coefficient at the window's centre) */
  smithZoom = 1; smithPan = { x: 0, y: 0 };
  /** SMITH_GRID::SetReferenceImpedance / SetMixedReferences: the ports' one reference impedance (0 when they differ or
   *  one is unknown), and whether they differ */
  smithZ0 = 0; smithMixed = false;
  /** the legend's top-left corner inside the plot area (mpInfoLegend's position, kept in the workbook) */
  legendAt = { x: 10, y: 10 };
  fixed: (Range | null)[] = [null, null, null];
  margins = { left: 70, top: 30, right: 70, bottom: 45 };
  cursorX: [number | null, number | null] = [null, null];
  /** called when a cursor moves or the view changes (the cursors grid follows) */
  onChange: (() => void) | null = null;
  onContextMenu: ((x: number, y: number) => void) | null = null;
  private view: View | null = null;
  private undo: View[] = []; private redo: View[] = [];
  private drag: { kind: "box" | "pan" | "cursor" | "legend" | "smithpan" | "smithmenu"; x0: number; y0: number; x1: number; y1: number; view?: View; cursor?: 0 | 1; moved: boolean; lx?: number; ly?: number; x1Prev?: number; y1Prev?: number } | null = null;

  constructor() {
    this.el = document.createElement("div"); this.el.className = "sim-plot";
    this.canvas = document.createElement("canvas"); this.canvas.tabIndex = 0; this.el.appendChild(this.canvas);
    this.canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.canvas.addEventListener("dblclick", (e) => this.dclick(e));
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.render()).observe(this.el);
  }

  // ------------------------------------------------------------ geometry
  private rightMargin(): number { return this.opts.y[2] ? 160 : this.margins.right; }
  private area(): { l: number; t: number; r: number; b: number; w: number; h: number } {
    const w = this.el.clientWidth, h = this.el.clientHeight, l = this.margins.left, t = this.margins.top, r = w - this.rightMargin(), b = h - this.margins.bottom;
    return { l, t, r, b, w: Math.max(1, r - l), h: Math.max(1, b - t) };
  }
  private fx(v: number): number { return this.opts.logX ? Math.log10(Math.max(v, 1e-300)) : v; }
  private ifx(v: number): number { return this.opts.logX ? Math.pow(10, v) : v; }
  /** screen x of data x */
  sx(x: number): number { const a = this.area(), v = this.cur(); return a.l + ((this.fx(x) - v.x.min) / ((v.x.max - v.x.min) || 1)) * a.w; }
  sy(y: number, axis: number): number { const a = this.area(), r = this.cur().y[axis]; return a.b - ((y - r.min) / ((r.max - r.min) || 1)) * a.h; }
  dataX(px: number): number { const a = this.area(), v = this.cur(); return this.ifx(v.x.min + ((px - a.l) / a.w) * (v.x.max - v.x.min)); }

  // ------------------------------------------------------------ the view
  private cur(): View { if (!this.view) this.view = this.fitView(); return this.view; }
  private fitView(): View {
    let x0 = Infinity, x1 = -Infinity; const y: Range[] = [0, 1, 2].map(() => ({ min: Infinity, max: -Infinity }));
    for (const t of this.traces) {
      for (let i = 0; i < t.xs.length; i++) {
        const xv = t.xs[i]; if (this.opts.logX && !(xv > 0)) continue;
        const fx = this.fx(xv), yv = t.ys[i]; if (!Number.isFinite(fx) || !Number.isFinite(yv)) continue;
        if (fx < x0) x0 = fx; if (fx > x1) x1 = fx; const r = y[t.axis]; if (yv < r.min) r.min = yv; if (yv > r.max) r.max = yv;
      }
    }
    if (!Number.isFinite(x0)) { x0 = this.opts.logX ? 0 : 0; x1 = this.opts.logX ? 3 : 1; }
    if (x0 === x1) { x0 -= 0.5; x1 += 0.5; }
    const ys = y.map((r, i) => {
      const f = this.fixed[i]; if (f) return { min: f.min, max: f.max };
      if (!Number.isFinite(r.min)) return { min: -1, max: 1 };
      if (r.min === r.max) { const d = Math.abs(r.min) * 0.1 || 1; return { min: r.min - d, max: r.max + d }; }
      const pad = (r.max - r.min) * 0.05; return { min: r.min - pad, max: r.max + pad };
    }) as [Range, Range, Range];
    return { x: { min: x0, max: x1 }, y: ys };
  }
  private clone(v: View): View { return { x: { ...v.x }, y: v.y.map((r) => ({ ...r })) as [Range, Range, Range] }; }
  private push(next: View): void { this.undo.push(this.clone(this.cur())); if (this.undo.length > 50) this.undo.shift(); this.redo = []; this.view = next; this.render(); if (this.onChange) this.onChange(); }
  /** The traces changed: re-fit (mpWindow::Fit after AddLayer) unless the user zoomed. */
  setTraces(traces: PlotTrace[], refit: boolean): void { this.traces = traces; if (refit || !this.view) this.view = this.fitView(); this.render(); }
  fit(): void { this.push(this.fitView()); }
  canUndo(): boolean { return this.undo.length > 0; }
  canRedo(): boolean { return this.redo.length > 0; }
  undoZoom(): void { const v = this.undo.pop(); if (!v) return; this.redo.push(this.clone(this.cur())); this.view = v; this.render(); if (this.onChange) this.onChange(); }
  redoZoom(): void { const v = this.redo.pop(); if (!v) return; this.undo.push(this.clone(this.cur())); this.view = v; this.render(); if (this.onChange) this.onChange(); }
  /** mpWindow::ZoomIn / ZoomOut (factor 1.5) about a screen point, horizontally, vertically or both. */
  zoom(factor: number, dir: "both" | "h" | "v", at?: [number, number]): void {
    const a = this.area(), v = this.clone(this.cur()), px = at ? at[0] : a.l + a.w / 2, py = at ? at[1] : a.t + a.h / 2;
    if (dir !== "v") { const c = v.x.min + ((px - a.l) / a.w) * (v.x.max - v.x.min); v.x = { min: c - (c - v.x.min) / factor, max: c + (v.x.max - c) / factor }; }
    if (dir !== "h") v.y = v.y.map((r) => { const c = r.max - ((py - a.t) / a.h) * (r.max - r.min); return { min: c - (c - r.min) / factor, max: c + (r.max - c) / factor }; }) as [Range, Range, Range];
    this.push(v);
  }
  /** mpWindow's "Center on Cursor": the view's middle moves to the point. */
  centerOn(px: number, py: number): void {
    const a = this.area(), v = this.clone(this.cur());
    const dx = ((px - (a.l + a.w / 2)) / a.w) * (v.x.max - v.x.min); v.x = { min: v.x.min + dx, max: v.x.max + dx };
    v.y = v.y.map((r) => { const d = -((py - (a.t + a.h / 2)) / a.h) * (r.max - r.min); return { min: r.min + d, max: r.max + d }; }) as [Range, Range, Range];
    this.push(v);
  }
  private pan(dxPx: number, dyPx: number, from: View): View {
    const a = this.area(), v = this.clone(from), dx = (dxPx / a.w) * (v.x.max - v.x.min);
    v.x = { min: v.x.min - dx, max: v.x.max - dx };
    v.y = v.y.map((r) => { const d = (dyPx / a.h) * (r.max - r.min); return { min: r.min + d, max: r.max + d }; }) as [Range, Range, Range];
    return v;
  }
  /** the X range on screen, in data units */
  xRange(): Range { const v = this.cur(); return { min: this.ifx(v.x.min), max: this.ifx(v.x.max) }; }

  // ------------------------------------------------------------ mouse
  private local(e: MouseEvent): [number, number] { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  /** the scroll gestures (Preferences > Schematic Editor > Simulator): the action per modifier for vertical scrolling, and for horizontal */
  gestures: () => { vNone: WheelAction; vCtrl: WheelAction; vShift: WheelAction; vAlt: WheelAction; h: WheelAction } = () => ({ vNone: "zoom", vCtrl: "panLR", vShift: "panUD", vAlt: "none", h: "panLR" });
  private wheel(e: WheelEvent): void {
    e.preventDefault(); const p = this.local(e);
    // SIM_VIEW::onSmithMouseWheel: a vertical wheel zooms the chart about the mouse, a horizontal one does nothing
    if (this.smith) { if (Math.abs(e.deltaY) >= Math.abs(e.deltaX) && e.deltaY) this.smithZoomAt(p[0], p[1], e.deltaY < 0 ? 1.2 : 1 / 1.2); return; }
    const g = this.gestures(), horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    const d = horiz ? e.deltaX : e.deltaY; if (!d) return;
    const act: WheelAction = horiz ? g.h : e.ctrlKey || e.metaKey ? g.vCtrl : e.shiftKey ? g.vShift : e.altKey ? g.vAlt : g.vNone;
    const a = this.area();
    switch (act) {
      case "panLR": this.push(this.pan(d > 0 ? -a.w * 0.1 : a.w * 0.1, 0, this.cur())); break;
      case "panRL": this.push(this.pan(d > 0 ? a.w * 0.1 : -a.w * 0.1, 0, this.cur())); break;
      case "panUD": this.push(this.pan(0, d > 0 ? -a.h * 0.1 : a.h * 0.1, this.cur())); break;
      case "zoom": this.zoom(d < 0 ? 1.5 : 1 / 1.5, "both", p); break;
      case "zoomH": this.zoom(d < 0 ? 1.5 : 1 / 1.5, "h", p); break;
      case "zoomV": this.zoom(d < 0 ? 1.5 : 1 / 1.5, "v", p); break;
      default: break;
    }
  }
  private cursorNear(px: number): 0 | 1 | null {
    for (const i of [0, 1] as const) { const x = this.cursorX[i]; if (x !== null && this.traces.some((t) => (i ? t.cursor2 : t.cursor1)) && Math.abs(this.sx(x) - px) <= 5) return i; }
    return null;
  }
  private legendBox: { x: number; y: number; w: number; h: number } | null = null;
  /** SIM_VIEW::onSmithDClick: a double click on the chart (not the legend) fits it to the window again */
  private dclick(e: MouseEvent): void {
    if (!this.smith) return;
    const [x, y] = this.local(e), lb = this.legendBox;
    if (lb && this.showLegend && x >= lb.x && x <= lb.x + lb.w && y >= lb.y && y <= lb.y + lb.h) return;
    this.resetSmith();
  }
  private down(e: PointerEvent): void {
    const [x, y] = this.local(e); this.canvas.focus();
    this.canvas.setPointerCapture(e.pointerId);
    const lb0 = this.legendBox, onLegend = !!lb0 && this.showLegend && x >= lb0.x && x <= lb0.x + lb0.w && y >= lb0.y && y <= lb0.y + lb0.h;
    if (this.smith) {
      // SIM_VIEW::onSmithLeftDown / onSmithRightUp: the left button pans the chart (or drags the legend), the right one
      // opens the menu, the middle one does nothing
      if (e.button === 2) this.drag = { kind: "smithmenu", x0: x, y0: y, x1: x, y1: y, moved: false };
      else if (e.button === 0 && onLegend) this.drag = { kind: "legend", x0: x, y0: y, x1: x, y1: y, lx: this.legendAt.x, ly: this.legendAt.y, moved: false };
      else if (e.button === 0) this.drag = { kind: "smithpan", x0: x, y0: y, x1: x, y1: y, moved: false };
      return;
    }
    if (e.button === 2 || e.button === 1) { this.drag = { kind: "pan", x0: x, y0: y, x1: x, y1: y, view: this.clone(this.cur()), moved: false }; return; }
    if (e.button !== 0) return;
    const c = this.cursorNear(x);
    if (c !== null) { this.drag = { kind: "cursor", x0: x, y0: y, x1: x, y1: y, cursor: c, moved: false }; return; }
    const lb = this.legendBox;
    if (lb && this.showLegend && x >= lb.x && x <= lb.x + lb.w && y >= lb.y && y <= lb.y + lb.h) { this.drag = { kind: "legend", x0: x, y0: y, x1: x, y1: y, lx: this.legendAt.x, ly: this.legendAt.y, moved: false }; return; }
    this.drag = { kind: "box", x0: x, y0: y, x1: x, y1: y, moved: false };
  }
  private move(e: PointerEvent): void {
    const [x, y] = this.local(e), d = this.drag;
    if (!d) { this.canvas.style.cursor = this.cursorNear(x) !== null ? "ew-resize" : ""; return; }
    if (d.x1Prev === undefined) { d.x1Prev = d.x0; d.y1Prev = d.y0; }
    d.x1 = x; d.y1 = y; if (Math.abs(x - d.x0) + Math.abs(y - d.y0) > 3) d.moved = true;
    if (d.kind === "smithpan") { this.smithPanBy(x - d.x1Prev!, y - d.y1Prev!); d.x1Prev = x; d.y1Prev = y; return; }
    if (d.kind === "pan" && d.moved) { this.view = this.pan(x - d.x0, y - d.y0, d.view!); }
    else if (d.kind === "cursor") { this.cursorX[d.cursor!] = this.dataX(x); if (this.onChange) this.onChange(); }
    else if (d.kind === "legend") { this.legendAt = { x: Math.max(0, d.lx! + x - d.x0), y: Math.max(0, d.ly! + y - d.y0) }; }
    this.render();
  }
  private up(e: PointerEvent): void {
    const d = this.drag; this.drag = null; if (!d) return;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (d.kind === "smithmenu") { if (this.onContextMenu) this.onContextMenu(e.clientX, e.clientY); return; }
    if (d.kind === "smithpan") { if (d.moved && this.onChange) this.onChange(); return; }
    if (d.kind === "pan") {
      if (!d.moved) { this.view = d.view!; if (e.button === 2 && this.onContextMenu) this.onContextMenu(e.clientX, e.clientY); return; }
      const fin = this.clone(this.cur()); this.view = d.view!; this.push(fin); return;
    }
    if (d.kind === "box" && d.moved && Math.abs(d.x1 - d.x0) > 4 && Math.abs(d.y1 - d.y0) > 4) {
      const a = this.area(), v = this.clone(this.cur());
      const xa = Math.min(d.x0, d.x1), xb = Math.max(d.x0, d.x1), ya = Math.min(d.y0, d.y1), yb = Math.max(d.y0, d.y1);
      const lx = (px: number): number => v.x.min + ((px - a.l) / a.w) * (v.x.max - v.x.min);
      const nv: View = { x: { min: lx(xa), max: lx(xb) }, y: v.y.map((r) => ({ min: r.max - ((yb - a.t) / a.h) * (r.max - r.min), max: r.max - ((ya - a.t) / a.h) * (r.max - r.min) })) as [Range, Range, Range] };
      this.push(nv); return;
    }
    this.render();
  }

  // ------------------------------------------------------------ drawing
  render(): void {
    const w = this.el.clientWidth, h = this.el.clientHeight; if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1, cv = this.canvas;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext("2d"); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const C = this.dark ? PLOT_COLORS.dark : PLOT_COLORS.light, a = this.area(), v = this.cur();
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h);
    g.font = "11px sans-serif"; g.textBaseline = "middle";
    if (this.smith) { this.renderSmith(g, C); return; }
    // ---- X ticks and grid
    const xt: { px: number; label: string; major: boolean }[] = [];
    if (this.opts.logX) {
      for (let d = Math.floor(v.x.min); d <= Math.ceil(v.x.max); d++) for (let m = 1; m < 10; m++) {
        const lv = d + Math.log10(m); if (lv < v.x.min || lv > v.x.max) continue;
        const span = Math.pow(10, d + 1);
        xt.push({ px: a.l + ((lv - v.x.min) / (v.x.max - v.x.min)) * a.w, label: m === 1 ? tickLabel(Math.pow(10, lv), this.opts.x.units, span) : "", major: m === 1 });
      }
    } else {
      const step = niceStep(v.x.max - v.x.min, Math.max(2, Math.floor(a.w / 90)));
      for (let t = Math.ceil(v.x.min / step) * step; t <= v.x.max + step * 1e-9; t += step) xt.push({ px: this.sx(t), label: tickLabel(Math.abs(t) < step * 1e-9 ? 0 : t, this.opts.x.units, v.x.max - v.x.min), major: true });
    }
    // ---- Y ticks (Y2 / Y3 follow Y1's tick positions: SetMasterScale)
    const y1 = v.y[0], ystep = niceStep(y1.max - y1.min, Math.max(2, Math.floor(a.h / 40)));
    const yt: number[] = []; for (let t = Math.ceil(y1.min / ystep) * ystep; t <= y1.max + ystep * 1e-9; t += ystep) yt.push(t);
    if (this.showGrid) {
      g.strokeStyle = C.axis; g.lineWidth = 1; g.setLineDash([1, 2]);
      for (const t of xt) { g.globalAlpha = t.major ? 1 : 0.4; g.beginPath(); g.moveTo(Math.round(t.px) + 0.5, a.t); g.lineTo(Math.round(t.px) + 0.5, a.b); g.stroke(); }
      g.globalAlpha = 1;
      for (const t of yt) { const py = Math.round(this.sy(t, 0)) + 0.5; g.beginPath(); g.moveTo(a.l, py); g.lineTo(a.r, py); g.stroke(); }
      g.setLineDash([]);
    }
    // ---- frame and labels
    g.strokeStyle = C.fg; g.lineWidth = 1; g.strokeRect(a.l + 0.5, a.t + 0.5, a.w, a.h);
    g.fillStyle = C.fg; g.textAlign = "center";
    for (const t of xt) if (t.label) g.fillText(t.label, t.px, a.b + 12);
    if (this.opts.x.name) g.fillText(this.opts.x.name, a.l + a.w / 2, a.b + 30);
    const axisX = [a.l, a.r, a.r + 80];
    for (let i = 0; i < 3; i++) {
      const ax = this.opts.y[i]; if (!ax) continue;
      const r = v.y[i], span = r.max - r.min;
      g.textAlign = i === 0 ? "right" : "left";
      if (i === 2) { g.beginPath(); g.moveTo(axisX[2] + 0.5, a.t); g.lineTo(axisX[2] + 0.5, a.b); g.stroke(); }
      for (const t of yt) {
        const frac = (t - y1.min) / ((y1.max - y1.min) || 1), val = r.min + frac * span, py = a.b - frac * a.h;
        g.fillText(tickLabel(Math.abs(val) < span * 1e-9 ? 0 : val, ax.units, span), axisX[i] + (i === 0 ? -4 : 4), py);
      }
      g.textAlign = i === 0 ? "left" : "right";
      g.fillText(ax.name, i === 0 ? 4 : i === 1 ? axisX[1] + 66 : w - 4, a.t - 14);
    }
    // ---- traces
    g.save(); g.beginPath(); g.rect(a.l, a.t, a.w, a.h); g.clip();
    for (const t of this.traces) {
      if (!this.opts.y[t.axis]) continue;
      g.strokeStyle = t.color; g.lineWidth = 1; g.setLineDash(t.secondary && this.dottedSecondary ? [2, 2] : []);
      g.beginPath(); let pen = false;
      for (let i = 0; i < t.xs.length; i++) {
        const xv = t.xs[i], yv = t.ys[i];
        if ((this.opts.logX && !(xv > 0)) || !Number.isFinite(yv)) { pen = false; continue; }
        const px = this.sx(xv), py = this.sy(yv, t.axis);
        if (pen) g.lineTo(px, py); else { g.moveTo(px, py); pen = true; }
      }
      g.stroke();
    }
    g.setLineDash([]);
    // ---- cursors (CURSOR::Plot: a crosshair on the trace with the cursor's number)
    for (const ci of [0, 1] as const) {
      const cx = this.cursorX[ci]; if (cx === null) continue;
      for (const t of this.traces) {
        if (!(ci ? t.cursor2 : t.cursor1) || !this.opts.y[t.axis]) continue;
        const yv = this.valueAt(t, cx), px = this.sx(cx), py = this.sy(yv, t.axis);
        g.strokeStyle = t.color; g.setLineDash(ci ? [4, 3] : []);
        g.beginPath(); g.moveTo(px, a.t); g.lineTo(px, a.b); g.moveTo(a.l, py); g.lineTo(a.r, py); g.stroke(); g.setLineDash([]);
        g.fillStyle = t.color; g.textAlign = "left"; g.fillText(String(ci + 1), px + 4, a.t + 9);
      }
    }
    // ---- the box being dragged
    const d = this.drag;
    if (d && d.kind === "box" && d.moved) { g.strokeStyle = C.fg; g.setLineDash([3, 3]); g.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)); g.setLineDash([]); }
    g.restore();
    // ---- legend (mpInfoLegend)
    this.legendBox = null;
    if (this.showLegend && this.traces.length) {
      const lw = Math.max(...this.traces.map((t) => g.measureText(t.name).width)) + 34, lh = this.traces.length * 16 + 6;
      const lx = Math.min(a.l + this.legendAt.x, a.r - lw), ly = Math.min(a.t + this.legendAt.y, a.b - lh);
      g.fillStyle = C.bg; g.strokeStyle = C.fg; g.fillRect(lx, ly, lw, lh); g.strokeRect(lx + 0.5, ly + 0.5, lw, lh);
      this.traces.forEach((t, i) => {
        const yy = ly + 11 + i * 16; g.strokeStyle = t.color; g.lineWidth = 2; g.setLineDash(t.secondary && this.dottedSecondary ? [2, 2] : []);
        g.beginPath(); g.moveTo(lx + 6, yy); g.lineTo(lx + 24, yy); g.stroke(); g.setLineDash([]); g.lineWidth = 1;
        g.fillStyle = C.fg; g.textAlign = "left"; g.fillText(t.name, lx + 28, yy);
      });
      this.legendBox = { x: lx, y: ly, w: lw, h: lh };
    }
  }
  /** SMITH_GRID::GetChartView with the view's zoom and pan (SMITH_VIEW): the unit circle's centre and radius on screen. */
  private smithView(): { cx: number; cy: number; radius: number; zoom: number; pan: { x: number; y: number }; a: { l: number; t: number; r: number; b: number; w: number; h: number } } | null {
    const a = this.area(), radius = Math.floor(Math.min(a.w, a.h) / 2) - 15; if (radius <= 20) return null;
    return { cx: a.l + Math.floor(a.w / 2), cy: a.t + Math.floor(a.h / 2), radius: radius * this.smithZoom, zoom: this.smithZoom, pan: this.smithPan, a };
  }
  /** SMITH_VIEW::ToGamma: the reflection coefficient under a screen point. */
  private smithGamma(px: number, py: number): { x: number; y: number } | null {
    const v = this.smithView(); if (!v) return null;
    return { x: v.pan.x + (px - v.cx) / v.radius, y: v.pan.y - (py - v.cy) / v.radius };
  }
  /** SIM_VIEW::ResetSmithView: fit to the window. */
  resetSmith(): void { this.smithZoom = 1; this.smithPan = { x: 0, y: 0 }; this.render(); if (this.onChange) this.onChange(); }
  /** SIM_VIEW::SmithZoomAt: zoom by a factor (1 to 50) keeping the point under the mouse fixed (SMITH_MATH::ZoomAboutPoint). */
  smithZoomAt(px: number, py: number, factor: number): void {
    const v = this.smithView(); if (!v) return;
    const zoom = Math.min(50, Math.max(1, this.smithZoom * factor));
    if (zoom <= 1) { this.resetSmith(); return; }
    const g = this.smithGamma(px, py)!, r = (v.radius / v.zoom) * zoom;
    this.smithPan = { x: g.x - (px - v.cx) / r, y: g.y + (py - v.cy) / r }; this.smithZoom = zoom;
    this.render(); if (this.onChange) this.onChange();
  }
  /** SIM_VIEW::SmithPanBy: move the chart with the mouse. */
  private smithPanBy(dx: number, dy: number): void {
    const v = this.smithView(); if (!v) return;
    this.smithPan = { x: this.smithPan.x - dx / v.radius, y: this.smithPan.y + dy / v.radius }; this.render();
  }
  /** the "Center on Cursor" of a Smith chart: the point moves to the window's middle. */
  smithCenterOn(px: number, py: number): void { const g = this.smithGamma(px, py); if (!g) return; this.smithPan = g; this.render(); if (this.onChange) this.onChange(); }
  /** SMITH_GRID::Plot and SMITH_TRACE::Plot: the unit circle of the reflection coefficient, the constant resistance
   *  circles and constant reactance arcs (0.2, 0.5, 1, 2 and 5, with finer values as the view zooms in, clipped to the
   *  unit circle), their labels (in ohms when the ports share one reference impedance), the reference note, each
   *  trace's Γ in the plane, then the legend. */
  private renderSmith(g: CanvasRenderingContext2D, C: { bg: string; fg: string; axis: string }): void {
    const view = this.smithView(); if (!view) return;
    const { l: mL, t: mT, w: plotW, h: plotH } = view.a;
    const toScreen = (re: number, im: number): [number, number] => {
      const LIMIT = 1e7; let x = (re - view.pan.x) * view.radius, y = (im - view.pan.y) * view.radius;
      x = Number.isFinite(x) ? Math.min(LIMIT, Math.max(-LIMIT, x)) : 0; y = Number.isFinite(y) ? Math.min(LIMIT, Math.max(-LIMIT, y)) : 0;
      return [view.cx + Math.round(x), view.cy - Math.round(y)];
    };
    const toGamma = (px: number, py: number): { x: number; y: number } => ({ x: view.pan.x + (px - view.cx) / view.radius, y: view.pan.y - (py - view.cy) / view.radius });
    const inPlot = (p: [number, number]): boolean => p[0] >= mL && p[0] < mL + plotW && p[1] >= mT && p[1] < mT + plotH;
    g.save(); g.beginPath(); g.rect(mL, mT, plotW, plotH); g.clip();
    const segmentsFor = (r: number): number => Math.min(4096, Math.max(64, Math.round(Math.PI * Math.sqrt(r * view.radius))));
    const circle = (ccx: number, ccy: number, r: number): void => {
      const n = segmentsFor(r); let run: [number, number][] = [];
      const flush = (): void => { if (run.length > 1) { g.beginPath(); g.moveTo(...run[0]); for (const q of run.slice(1)) g.lineTo(...q); g.stroke(); } run = []; };
      for (let i = 0; i <= n; i++) {
        const ang = (2 * Math.PI * i) / n, re = ccx + r * Math.cos(ang), im = ccy + r * Math.sin(ang);
        if (re * re + im * im <= 1.0002) run.push(toScreen(re, im)); else flush();
      }
      flush();
    };
    const fmt = (v: number): string => String(Number(v.toPrecision(6)));
    // ohm labels for a single reference impedance, normalized labels without one
    const labelScale = this.smithZ0 > 0 ? this.smithZ0 : 1;
    const gridVals = [0.2, 0.5, 1, 2, 5];
    const FINEST_SCALE = 2 / (1 + 20);
    const lowGamma = toGamma(mL, mT + plotH), highGamma = toGamma(mL + plotW, mT);
    const poleDistance = (re: number): number => Math.hypot(Math.max(lowGamma.x - re, re - highGamma.x, 0), Math.max(lowGamma.y, -highGamma.y, 0));
    const zoomedIn = plotW / 2 / view.radius < 1;
    const converged = zoomedIn && Math.min(poleDistance(1), poleDistance(-1)) < FINEST_SCALE;
    if (view.zoom >= 2 && !converged) gridVals.push(0.1, 0.3, 0.4, 0.7, 1.5, 3, 10);
    if (view.zoom >= 5 && !converged) gridVals.push(0.05, 0.15, 0.6, 0.8, 1.2, 1.7, 2.5, 4, 7, 20);
    if (this.showGrid) {
      g.strokeStyle = C.axis; g.lineWidth = 1; g.setLineDash([1, 2]);
      for (const r of gridVals) circle(r / (1 + r), 0, 1 / (1 + r));
      for (const x of gridVals) { circle(1, 1 / x, 1 / x); circle(1, -1 / x, 1 / x); }
      g.setLineDash([]);
    }
    g.strokeStyle = C.axis; g.lineWidth = 1;
    g.beginPath(); g.moveTo(...toScreen(-1, 0)); g.lineTo(...toScreen(1, 0)); g.stroke();
    { const [ox, oy] = toScreen(0, 0); g.beginPath(); g.arc(ox, oy, Math.round(view.radius), 0, 2 * Math.PI); g.stroke(); }
    // each gridline's label at its axis or rim anchor, or where the line meets the plot's edge when the anchor is out of view
    const LABEL_LIMIT = 1.0002;
    const anchorPos = (re: number, im: number): [number, number] | null => { if (re * re + im * im > LABEL_LIMIT) return null; const p = toScreen(re, im); return inPlot(p) ? p : null; };
    const edgePos = (ccx: number, ccy: number, r: number): [number, number] | null => {
      let best = Infinity, out: [number, number] | null = null; const n = segmentsFor(r);
      for (let i = 0; i <= n; i++) {
        const ang = (2 * Math.PI * i) / n, re = ccx + r * Math.cos(ang), im = ccy + r * Math.sin(ang);
        if (re * re + im * im > LABEL_LIMIT) continue;
        const p = toScreen(re, im); if (!inPlot(p)) continue;
        const margin = Math.min(p[0] - mL, mL + plotW - p[0], p[1] - mT, mT + plotH - p[1]);
        if (margin < best) { best = margin; out = p; }
      }
      return out;
    };
    g.fillStyle = C.axis; g.textAlign = "left"; g.textBaseline = "top";
    const TEXT_H = 12;
    const extent = (s: string): [number, number] => [Math.ceil(g.measureText(s).width), TEXT_H];
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const drawLabel = (label: string, x: number, y: number, ext: [number, number]): void => {
      const px = Math.min(Math.max(x, mL + 1), mL + plotW - ext[0] - 1), py = Math.min(Math.max(y, mT + 1), mT + plotH - ext[1] - 1);
      const box = { x: px - 2, y: py - 1, w: ext[0] + 4, h: ext[1] + 2 };
      if (placed.some((o) => o.x < box.x + box.w && box.x < o.x + o.w && o.y < box.y + box.h && box.y < o.y + o.h)) return;
      placed.push(box); g.fillText(label, px, py);
    };
    const drawEdgeLabel = (label: string, at: [number, number]): void => { const ext = extent(label); drawLabel(label, at[0] - Math.trunc(ext[0] / 2), at[1] + 3, ext); };
    // reactance labels go just outside the rim
    const drawRimLabel = (label: string, at: [number, number], re: number, im: number): void => {
      const ext = extent(label);
      const x = at[0] + Math.round(re * 6) - Math.round((ext[0] * (1 - re)) / 2), y = at[1] - Math.round(im * 6) - Math.round((ext[1] * (1 + im)) / 2);
      drawLabel(label, x, y, ext);
    };
    let at: [number, number] | null;
    // the short (r = 0)
    if ((at = anchorPos(-1, 0))) drawRimLabel("0", at, -1, 0); else if ((at = edgePos(0, 0, 1))) drawEdgeLabel("0", at);
    for (const r of gridVals) if ((at = anchorPos((r - 1) / (r + 1), 0) || edgePos(r / (1 + r), 0, 1 / (1 + r)))) drawEdgeLabel(fmt(r * labelScale), at);
    for (const x of gridVals) {
      const d = x * x + 1, re = (x * x - 1) / d, im = (2 * x) / d;
      const pos = "j" + fmt(x * labelScale), neg = "-j" + fmt(x * labelScale);
      if ((at = anchorPos(re, im))) drawRimLabel(pos, at, re, im); else if ((at = edgePos(1, 1 / x, 1 / x))) drawEdgeLabel(pos, at);
      if ((at = anchorPos(re, -im))) drawRimLabel(neg, at, re, -im); else if ((at = edgePos(1, -1 / x, 1 / x))) drawEdgeLabel(neg, at);
    }
    // the ohm labels mean nothing unless the reference impedance is named
    const note = this.smithZ0 > 0 ? `Z0 = ${fmt(this.smithZ0)} Ω` : this.smithMixed ? "Normalized Z/Z0 (ports differ)" : "Normalized Z/Z0";
    g.fillText(note, mL + 4, mT + plotH - TEXT_H - 4);
    for (const t of this.traces) {
      const gm = t.gamma; if (!gm) continue;
      g.strokeStyle = t.color; g.fillStyle = t.color; g.lineWidth = 1; g.setLineDash(t.secondary && this.dottedSecondary ? [2, 2] : []);
      let pts: [number, number][] = [];
      // a non-finite sample breaks the locus rather than drawing a bogus segment
      const flush = (): void => {
        if (pts.length > 1) { g.beginPath(); g.moveTo(...pts[0]); for (const q of pts.slice(1)) g.lineTo(...q); g.stroke(); }
        else if (pts.length === 1) { g.beginPath(); g.arc(pts[0][0], pts[0][1], 2, 0, 2 * Math.PI); g.fill(); }
        pts = [];
      };
      for (let i = 0; i < gm.re.length; i++) {
        const re = gm.re[i], im = gm.im[i];
        if (!Number.isFinite(re) || !Number.isFinite(im)) { flush(); continue; }
        pts.push(toScreen(re, im));
      }
      flush(); g.setLineDash([]);
    }
    g.restore();
    g.textBaseline = "middle";
    this.legendBox = null;
    const a = view.a, shown = this.traces.filter((t) => t.gamma);
    if (this.showLegend && shown.length) {
      const lw = Math.max(...shown.map((t) => g.measureText(t.name).width)) + 34, lh = shown.length * 16 + 6;
      const lx = Math.min(a.l + this.legendAt.x, a.r - lw), ly = Math.min(a.t + this.legendAt.y, a.b - lh);
      g.fillStyle = C.bg; g.strokeStyle = C.fg; g.fillRect(lx, ly, lw, lh); g.strokeRect(lx + 0.5, ly + 0.5, lw, lh);
      shown.forEach((t, i) => {
        const yy = ly + 11 + i * 16; g.strokeStyle = t.color; g.lineWidth = 2;
        g.beginPath(); g.moveTo(lx + 6, yy); g.lineTo(lx + 24, yy); g.stroke(); g.lineWidth = 1;
        g.fillStyle = C.fg; g.textAlign = "left"; g.fillText(t.name, lx + 28, yy);
      });
      this.legendBox = { x: lx, y: ly, w: lw, h: lh };
    }
  }
  /** a trace's value at x (linear interpolation, as CURSOR::Move looks it up) */
  valueAt(t: PlotTrace, x: number): number {
    const n = t.xs.length; if (!n) return NaN; if (x <= t.xs[0]) return t.ys[0]; if (x >= t.xs[n - 1]) return t.ys[n - 1];
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t.xs[m] <= x) lo = m; else hi = m; }
    const f = (x - t.xs[lo]) / ((t.xs[hi] - t.xs[lo]) || 1); return t.ys[lo] + f * (t.ys[hi] - t.ys[lo]);
  }
  /** a cursor placed in the middle of the view (SIM_PLOT_TAB::EnableCursor) */
  placeCursor(i: 0 | 1): void { if (this.cursorX[i] !== null) return; const r = this.xRange(); this.cursorX[i] = this.opts.logX ? Math.sqrt(r.min * r.max) * (i ? 2 : 1) : r.min + (r.max - r.min) * (i ? 0.6 : 0.4); }
  pngDataUrl(): string { return this.canvas.toDataURL("image/png"); }
  /** "Export Current Plot as CSV": the X column then each trace (interpolated on the first trace's points). */
  csv(): string {
    if (!this.traces.length) return "";
    const xs = this.traces[0].xs, head = [this.opts.x.name + (this.opts.x.units ? ` (${this.opts.x.units})` : ""), ...this.traces.map((t) => t.name)];
    const rows = [head.join(";")];
    for (let i = 0; i < xs.length; i++) rows.push([xs[i], ...this.traces.map((t, k) => (k === 0 ? t.ys[i] : this.valueAt(t, xs[i])))].map(String).join(";"));
    return rows.join("\n") + "\n";
  }
}
