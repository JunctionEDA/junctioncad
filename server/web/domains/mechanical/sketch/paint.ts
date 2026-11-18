// paint.ts — drawing the open sketch.  The sketch editor draws it itself, on a 2D canvas laid over the 3D
// viewport, instead of waiting for the modelling worker to send lines back: a drag has to follow the pointer
// in the same frame, and curves, glyphs, dimensions and hints are all cheaper to draw (and to hit-test) flat.
//
// The camera is orthographic, so a sketch-plane point maps to the screen by one affine transform per frame
// (three projected points); curves are drawn as their true shapes under it.  Colours are the theme's tokens:
//   ink     fully constrained          teal    still free to move            red     in conflict
//   mark    selected or hovered        ink-2   dimensions                    dashed  construction geometry
// (The theme has no blue: its `--blue` is a neutral.  Teal is its colour for what can still take a value.)
import * as THREE from "three";
import type { Viewport3D } from "../../../shared/viewport3d/viewport3d";
import { toWorld, type Frame, type Vec2 } from "../core/geometry";
import { drawDimension, type DimensionDrawing } from "./dims";
import type { SketchConstraint, SketchData } from "./format";
import type { Hint } from "./infer";
import type { Regions } from "./profiles";
import { arcSweep, isDimension, mid, pointsOf, resolve, resolveEntity, type Resolved } from "./refs";

export type EntityState = "defined" | "under" | "conflict";

export interface Preview {
  lines?: Vec2[][];
  points?: Vec2[];
  hints?: Hint[];
  guides?: [Vec2, Vec2][];
  /** a dimension being placed */
  dimension?: SketchConstraint;
}

export interface Scene {
  data: SketchData;
  frame: Frame;
  state(id: string): EntityState;
  selection: ReadonlySet<string>;
  hover: string | null;
  /** entities lit because the constraint they belong to is hovered or selected */
  related: ReadonlySet<string>;
  conflicting: ReadonlySet<string>;
  redundant: ReadonlySet<string>;
  regions: Regions | null;
  preview: Preview | null;
  /** a selection box being dragged, in canvas pixels */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** the dimension whose value is being typed: its text is not drawn under the input */
  editing: string | null;
  /** false: the constraint glyphs are not drawn (a person turned them off; the ones in conflict still are) */
  glyphs?: boolean;
}

/** Something drawn that is not geometry and can be clicked: a constraint glyph or a dimension's text. */
export interface Box { id: string; kind: "glyph" | "dimension"; x: number; y: number; w: number; h: number }

const GLYPH = 15;
const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

export class SketchPainter {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** hit boxes of the glyphs and dimension texts drawn last, topmost last */
  boxes: Box[] = [];
  private colors = { ink: "", ink2: "", ink3: "", paper: "", panel: "", line: "", blue: "", err: "", mark: "", teal: "", warn: "" };
  // the affine map of the frame being drawn: screen = o + u·x + v·y
  private o = { x: 0, y: 0 }; private ux = { x: 1, y: 0 }; private uy = { x: 0, y: -1 };
  private font = "";

  constructor(private readonly viewport: Viewport3D) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cad-sketch-overlay";
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;z-index:1";
    viewport.host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.readColors();
  }

  readColors(): void {
    const c = this.colors;
    c.ink = css("--ink"); c.ink2 = css("--ink-2"); c.ink3 = css("--ink-3"); c.paper = css("--paper"); c.panel = css("--panel"); c.line = css("--line-2");
    c.blue = css("--blue"); c.err = css("--err"); c.mark = css("--mark"); c.teal = css("--teal"); c.warn = css("--warn");
    const body = getComputedStyle(document.body);
    this.font = `11px ${getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || body.fontFamily}`;
  }

  dispose(): void { this.canvas.remove(); }
  clear(): void { this.fit(); this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this.boxes = []; }

  private fit(): void {
    const w = this.viewport.width, h = this.viewport.height, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) { this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr); }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Set the sketch-to-screen map for this frame. */
  private aim(frame: Frame): void {
    const at = (p: Vec2) => this.viewport.project(new THREE.Vector3(...toWorld(frame, p)));
    const o = at([0, 0]), x = at([1, 0]), y = at([0, 1]);
    this.o = o; this.ux = { x: x.x - o.x, y: x.y - o.y }; this.uy = { x: y.x - o.x, y: y.y - o.y };
  }
  /** A sketch point in canvas pixels (valid after a draw). */
  screen(p: Vec2): { x: number; y: number } { return { x: this.o.x + this.ux.x * p[0] + this.uy.x * p[1], y: this.o.y + this.ux.y * p[0] + this.uy.y * p[1] }; }

  draw(s: Scene): void {
    this.fit();
    this.aim(s.frame);
    const g = this.ctx, c = this.colors;
    g.clearRect(0, 0, this.viewport.width, this.viewport.height);
    this.boxes = [];
    g.lineCap = "round"; g.lineJoin = "round";
    const px = this.viewport.pixelSize();

    // ---- closed regions, lightly filled
    if (s.regions) {
      g.fillStyle = c.ink; g.globalAlpha = 0.07;
      for (const r of s.regions.regions) {
        g.beginPath();
        for (const loop of [r.outer, ...r.holes]) { loop.polygon.forEach((p, i) => { const q = this.screen(p); if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); }); g.closePath(); }
        g.fill("evenodd");
      }
      g.globalAlpha = 1;
    }

    // ---- the origin
    const o = this.screen([0, 0]);
    g.strokeStyle = c.ink3; g.lineWidth = 1; g.setLineDash([]);
    g.beginPath(); g.moveTo(o.x - 7, o.y); g.lineTo(o.x + 7, o.y); g.moveTo(o.x, o.y - 7); g.lineTo(o.x, o.y + 7); g.stroke();
    if (s.selection.has("$origin") || s.hover === "$origin") { g.fillStyle = c.mark; g.beginPath(); g.arc(o.x, o.y, 4.5, 0, 7); g.fill(); }

    // ---- curves
    const lit = (id: string) => s.selection.has(id) || s.hover === id || s.related.has(id);
    const colorOf = (id: string) => (lit(id) ? c.mark : s.state(id) === "conflict" ? c.err : s.state(id) === "under" ? c.teal : c.ink);
    const ids = Object.keys(s.data.entities);
    for (const pass of [0, 1]) for (const id of ids) {
      const e = s.data.entities[id];
      if (e.type === "point" || lit(id) !== !!pass) continue;
      const r = resolveEntity(s.data, id); if (!r) continue;
      g.strokeStyle = colorOf(id);
      g.lineWidth = lit(id) ? 3 : e.construction ? 1 : 1.75;
      g.setLineDash(e.construction ? [6, 4] : []);
      if (e.construction && !lit(id) && s.state(id) === "defined") g.strokeStyle = c.ink3;
      this.path(r); g.stroke();
    }
    g.setLineDash([]);

    // ---- points (the ends and centres of curves, and loose points)
    for (const id of ids) {
      const e = s.data.entities[id]; if (e.type !== "point") continue;
      const q = this.screen([e.x, e.y]), on = lit(id);
      g.fillStyle = on ? c.mark : colorOf(id);
      g.beginPath(); g.arc(q.x, q.y, on ? 4.5 : 2.6, 0, 7); g.fill();
    }

    // ---- dimensions
    // (every dimension's lines first, then the texts, so no line runs through another dimension's text)
    for (const text of [false, true]) for (const [id, k] of Object.entries(s.data.constraints)) {
      if (!isDimension(k)) continue;
      const d = drawDimension(s.data, k, px); if (!d) continue;
      const on = s.selection.has(id) || s.hover === id;
      this.dimension(d, s.conflicting.has(id) ? c.err : on ? c.mark : k.driving === false ? c.ink3 : c.ink2, on, id, s.editing === id, text ? "text" : "lines");
    }

    // ---- constraint glyphs, stacked where several sit on one thing
    const stacks = new Map<string, number>();
    for (const [id, k] of Object.entries(s.data.constraints)) {
      if (isDimension(k)) continue;
      if (s.glyphs === false && !s.conflicting.has(id) && !s.selection.has(id) && s.hover !== id) continue;
      const anchor = glyphAnchor(s.data, k); if (!anchor) continue;
      // zoomed far out, a glyph would be bigger than the line it sits on: leave it out until there is room
      if (anchor.room < 26 * px && !s.selection.has(id) && s.hover !== id && !s.conflicting.has(id)) continue;
      const q = this.screen(anchor.at);
      const key = `${Math.round(q.x / 4)},${Math.round(q.y / 4)}`, n = stacks.get(key) || 0; stacks.set(key, n + 1);
      const x = q.x + anchor.dx * 14 + n * (GLYPH + 2) - GLYPH / 2, y = q.y + anchor.dy * 14 - GLYPH / 2;
      const on = s.selection.has(id) || s.hover === id;
      const color = s.conflicting.has(id) ? c.err : s.redundant.has(id) ? c.warn : on ? c.mark : c.ink2;
      g.fillStyle = c.panel; g.strokeStyle = color; g.lineWidth = on ? 1.75 : 1;
      g.beginPath(); (g as CanvasRenderingContext2D & { roundRect?: (...a: number[]) => void }).roundRect ? g.roundRect(x, y, GLYPH, GLYPH, 3) : g.rect(x, y, GLYPH, GLYPH); g.fill(); g.stroke();
      glyph(g, k.type, x + GLYPH / 2, y + GLYPH / 2, color);
      this.boxes.push({ id, kind: "glyph", x, y, w: GLYPH, h: GLYPH });
    }

    // ---- what a tool is drawing
    const p = s.preview;
    if (p) {
      g.strokeStyle = c.ink3; g.lineWidth = 1; g.setLineDash([4, 4]);
      for (const [a, b] of p.guides || []) { const q = this.screen(a), r = this.screen(b); g.beginPath(); g.moveTo(q.x, q.y); g.lineTo(r.x, r.y); g.stroke(); }
      g.setLineDash([]);
      g.strokeStyle = c.mark; g.lineWidth = 2;
      for (const line of p.lines || []) { if (line.length < 2) continue; g.beginPath(); line.forEach((v, i) => { const q = this.screen(v); if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); }); g.stroke(); }
      g.fillStyle = c.mark;
      for (const v of p.points || []) { const q = this.screen(v); g.beginPath(); g.arc(q.x, q.y, 3.5, 0, 7); g.fill(); }
      if (p.dimension) { const d = drawDimension(s.data, p.dimension, px); if (d) this.dimension(d, c.mark, true, null, false); }
      // inference hints: the glyph of the relation the click will make, beside where it applies
      (p.hints || []).forEach((h, i) => {
        const q = this.screen(h.at), x = q.x + 12 + i * (GLYPH + 2), y = q.y - GLYPH - 10;
        g.fillStyle = c.panel; g.strokeStyle = c.mark; g.lineWidth = 1.25;
        g.beginPath(); g.rect(x, y, GLYPH, GLYPH); g.fill(); g.stroke();
        glyph(g, h.kind === "point" || h.kind === "origin" || h.kind === "on" ? "coincident" : h.kind, x + GLYPH / 2, y + GLYPH / 2, c.mark);
        if (h.kind === "point" || h.kind === "origin" || h.kind === "midpoint" || h.kind === "tangent") { g.strokeStyle = c.mark; g.lineWidth = 1.5; g.beginPath(); g.arc(q.x, q.y, 6.5, 0, 7); g.stroke(); }
      });
    }
    if (s.box) {
      const b = s.box;
      g.strokeStyle = c.mark; g.lineWidth = 1; g.setLineDash([4, 3]); g.fillStyle = c.mark;
      g.globalAlpha = 0.08; g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.globalAlpha = 1;
      g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.setLineDash([]);
    }
  }

  /** Trace a curve as the current path. */
  private path(r: Resolved): void {
    const g = this.ctx;
    g.beginPath();
    if (r.kind === "line") { const a = this.screen(r.a), b = this.screen(r.b); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); return; }
    if (r.kind === "point") return;
    const sweep = r.kind === "circle" ? { a0: 0, a1: Math.PI * 2 } : arcSweep(r.c, r.s, r.en);
    this.arc(r.c, r.r, sweep.a0, sweep.a1);
  }
  private arc(c: Vec2, r: number, a0: number, a1: number): void {
    const g = this.ctx, n = Math.max(8, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 96));
    for (let i = 0; i <= n; i++) { const t = a0 + ((a1 - a0) * i) / n, q = this.screen([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); }
  }

  private dimension(d: DimensionDrawing, color: string, strong: boolean, id: string | null, hideText: boolean, part: "all" | "lines" | "text" = "all"): void {
    const g = this.ctx, c = this.colors;
    g.strokeStyle = color; g.fillStyle = color; g.lineWidth = strong ? 1.5 : 1; g.setLineDash([]);
    if (part !== "text") this.dimensionLines(d);
    if (part === "lines") return;
    g.font = this.font; g.textAlign = "center"; g.textBaseline = "middle";
    const at = this.screen(d.label), w = Math.ceil(g.measureText(d.text).width) + 8, h = 16;
    if (id) this.boxes.push({ id, kind: "dimension", x: at.x - w / 2, y: at.y - h / 2, w, h });
    if (hideText) return;
    g.fillStyle = c.paper; g.globalAlpha = 0.92; g.fillRect(at.x - w / 2, at.y - h / 2, w, h); g.globalAlpha = 1;
    if (strong) { g.strokeStyle = color; g.lineWidth = 1; g.strokeRect(at.x - w / 2 + 0.5, at.y - h / 2 + 0.5, w - 1, h - 1); }
    g.fillStyle = color; g.fillText(d.text, at.x, at.y + 0.5);
  }
  private dimensionLines(d: DimensionDrawing): void {
    const g = this.ctx;
    for (const [a, b] of d.lines) { const p = this.screen(a), q = this.screen(b); g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke(); }
    for (const a of d.arcs) { g.beginPath(); this.arc(a.c, a.r, a.a0, a.a1); g.stroke(); }
    for (const a of d.arrows) {
      const tip = this.screen(a.at), to = this.screen([a.at[0] + a.dir[0], a.at[1] + a.dir[1]]);
      const dx = to.x - tip.x, dy = to.y - tip.y, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
      g.beginPath(); g.moveTo(tip.x, tip.y); g.lineTo(tip.x - ux * 9 - uy * 3, tip.y - uy * 9 + ux * 3); g.lineTo(tip.x - ux * 9 + uy * 3, tip.y - uy * 9 - ux * 3); g.closePath(); g.fill();
    }
  }
}

/** Where a constraint's glyph sits: a point of the sketch and the side to step off to (in glyph steps, screen axes). */
export function glyphAnchor(data: SketchData, k: SketchConstraint): { at: Vec2; dx: number; dy: number; /** the size of what it sits on, mm */ room: number } | null {
  const a = anchorOf(data, k); if (!a) return null;
  const sizes = (k.refs || []).map((ref) => resolve(data, ref)).map((x) => (!x || x.kind === "point" ? Infinity : x.kind === "line" ? Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1]) : x.r * 2));
  return { ...a, room: Math.min(...sizes) };
}
function anchorOf(data: SketchData, k: SketchConstraint): { at: Vec2; dx: number; dy: number } | null {
  const r = (k.refs || []).map((ref) => resolve(data, ref));
  if (!r.length || r.some((x) => !x)) return null;
  const first = r[0] as Resolved;
  const centre = (x: Resolved): Vec2 => (x.kind === "point" ? x.p : x.kind === "line" ? mid(x.a, x.b) : x.kind === "circle" ? [x.c[0] + x.r * Math.SQRT1_2, x.c[1] + x.r * Math.SQRT1_2] : arcMid(x));
  // a relation between a point and something sits at the point; one between curves sits on the first curve
  const point = (r as Resolved[]).find((x) => x.kind === "point");
  if (k.type === "symmetric") { const axis = (r as Resolved[]).find((x) => x.kind === "line") || (r[2] as Resolved); return { at: centre(axis), dx: 1, dy: 1 }; }
  if (point && k.type !== "horizontal" && k.type !== "vertical") return { at: point.p, dx: 1, dy: -1 };
  if (point) return { at: mid((r[0] as { p: Vec2 }).p, (r[1] as { p: Vec2 }).p), dx: 0, dy: -1 };
  if (first.kind === "line") {
    // step off square to the line, upwards on screen
    const dx = first.b[0] - first.a[0], dy = first.b[1] - first.a[1], l = Math.hypot(dx, dy) || 1;
    let nx = -dy / l, ny = dx / l; if (ny < 0 || (ny === 0 && nx < 0)) { nx = -nx; ny = -ny; }
    const second = k.type === "parallel" || k.type === "equal" || k.type === "collinear" ? 0.62 : 0.5;
    return { at: [first.a[0] + dx * second, first.a[1] + dy * second], dx: nx, dy: -ny };
  }
  return { at: centre(first), dx: 0.7, dy: -0.7 };
}
function arcMid(x: Extract<Resolved, { kind: "arc" }>): Vec2 { const { a0, a1 } = arcSweep(x.c, x.s, x.en), t = (a0 + a1) / 2; return [x.c[0] + x.r * Math.cos(t), x.c[1] + x.r * Math.sin(t)]; }

/** The little picture of a constraint type, drawn in a 15 px box centred on (x, y). */
export function glyph(g: CanvasRenderingContext2D, type: string, x: number, y: number, color: string): void {
  g.save();
  g.translate(x, y); g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 1.4; g.setLineDash([]); g.lineCap = "round";
  const line = (...p: number[]) => { g.beginPath(); g.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]); g.stroke(); };
  const dot = (cx: number, cy: number, r = 1.6) => { g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill(); };
  switch (type) {
    case "horizontal": line(-4.5, 0, 4.5, 0); break;
    case "vertical": line(0, -4.5, 0, 4.5); break;
    case "parallel": line(-3.5, 4, 0.5, -4); line(-0.5, 4, 3.5, -4); break;
    case "perpendicular": line(-4.5, 4, 4.5, 4); line(0, 4, 0, -4.5); break;
    case "tangent": g.beginPath(); g.arc(0, 1.5, 3.5, 0, 7); g.stroke(); line(-5, -2.2, 5, -2.2); break;
    case "equal": line(-4, -1.8, 4, -1.8); line(-4, 1.8, 4, 1.8); break;
    case "coincident": dot(0, 0, 2.4); g.beginPath(); g.arc(0, 0, 4.6, 0, 7); g.stroke(); break;
    case "midpoint": line(-5, 3, 5, 3); dot(0, 3, 2); line(0, -4.5, 0, 0.5); break;
    case "concentric": g.beginPath(); g.arc(0, 0, 1.8, 0, 7); g.stroke(); g.beginPath(); g.arc(0, 0, 4.8, 0, 7); g.stroke(); break;
    case "collinear": line(-5, 0, -1.5, 0); line(1.5, 0, 5, 0); dot(-5, 0, 1.1); dot(5, 0, 1.1); break;
    case "symmetric": line(0, -5, 0, 5); line(-4.5, 0, -1.8, 0); line(4.5, 0, 1.8, 0); line(-3.2, -1.6, -1.8, 0, -3.2, 1.6); line(3.2, -1.6, 1.8, 0, 3.2, 1.6); break;
    case "fix": line(-3.5, 4.5, 3.5, 4.5); line(0, 4.5, 0, -1); g.beginPath(); g.arc(0, -2.6, 1.8, 0, 7); g.stroke(); line(-3, 1, 3, 1); break;
    default: g.font = "9px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("?", 0, 0.5);
  }
  g.restore();
}

/** The point ids to light when a constraint is hovered: what it ties together. */
export function relatedEntities(data: SketchData, k: SketchConstraint): string[] {
  const out: string[] = [];
  for (const ref of k.refs || []) { const r = resolve(data, ref); if (r) out.push(r.id); }
  return out.concat(out.flatMap((id) => (data.entities[id] && data.entities[id].type !== "point" ? [] : pointsOf(data.entities[id]))));
}
