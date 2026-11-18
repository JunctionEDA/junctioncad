// The hero's schematic tab: the same three teammates draw the STM32 board's schematic, a block
// each at a time, before the window turns to the board (mini.ts).  Shown whole when the visitor
// opens the tab themselves.

import { Box, K, PEERS, Pt, View, clamp, drawCursor, fit, lerp, mixBox, toMm, toPx } from "./demo";
import { SANS, Stage, makeStage, reducedMotion } from "./stage";
import { schText } from "./hero";

/** One thing a teammate does: the pointer travels to `at`, then `ids` are on the sheet. */
interface Beat { t: number; at: Pt; ids: string[] }
const FADE = 650;                                    // ms the schematic and the board take to cross-fade
const ZOOM = 1200;                                   // ms the camera takes to ease out from the close-up to the whole sheet
const HOLD = ZOOM + 1500;                            // ms the finished schematic is left up before the board takes over
const snapG = (v: number): number => Math.round(v / 1.27) * 1.27;
const easeOut = (u: number): number => 1 - Math.pow(1 - u, 3);
const minJerk = (u: number): number => u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (10 - 15 * u + 6 * u * u);
const mid = (b: number[]): Pt => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const inside = (b: number[], r: number[]): boolean => { const c = mid(b); return c[0] >= r[0] && c[0] <= r[2] && c[1] >= r[1] && c[1] <= r[3]; };

export interface SchScene { /** Draw it again from an empty sheet. */ play(): void; /** Show it complete. */ whole(): void; symbols: number }

export function startSch(canvas: HTMLCanvasElement, onEnd: () => void): SchScene {
  const doc: KDoc = K.parseDoc(schText);
  const items = [...doc.items.values()].filter((it: any) => it.bbox) as any[];
  const real = (it: any): boolean => it.kind === "symbol" && !/^#/.test(it.ref || "");
  // Framed by what is drawn, not by the A3 page around it: the page border is left out, so the blocks sit centred in the window.
  const view: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const it of items) { view[0] = Math.min(view[0], it.bbox[0]); view[1] = Math.min(view[1], it.bbox[1]); view[2] = Math.max(view[2], it.bbox[2]); view[3] = Math.max(view[3], it.bbox[3]); }
  view[0] -= 5; view[1] -= 5; view[2] += 5; view[3] += 5;

  // Each dashed block with what is inside it: its title, its parts, then the wiring around them.
  const blocks = items.filter((it) => it.kind === "rectangle").sort((a, b) => a.bbox[0] - b.bbox[0] || a.bbox[1] - b.bbox[1]);
  const taken = new Set<string>(blocks.map((b) => b.id));
  const lanes: Beat[][] = [[], [], []], load = [0, 0, 0], at: Pt[] = [mid(view), mid(view), mid(view)];
  const beat = (k: number, dur: number, to: Pt, ids: string[]): void => { load[k] += dur; lanes[k].push({ t: load[k], at: to, ids }); at[k] = to; };
  blocks.forEach((b, bi) => {
    const mine = items.filter((it) => !taken.has(it.id) && inside(it.bbox, b.bbox)); for (const it of mine) taken.add(it.id);
    const k = load.indexOf(Math.min(...load));
    const title = mine.filter((it) => it.kind === "text").sort((p, q) => p.bbox[1] - q.bbox[1]);
    beat(k, 620 + (bi ? Math.hypot(b.bbox[0] - at[k][0], b.bbox[1] - at[k][1]) * 2 : 0), [b.bbox[0] + 6, b.bbox[1] + 5], [b.id, ...title.slice(0, 1).map((t) => t.id)]);
    const parts = mine.filter(real).sort((p, q) => p.bbox[0] - q.bbox[0] || p.bbox[1] - q.bbox[1]);
    for (const p of parts) beat(k, 360 + Math.random() * 220, mid(p.bbox), [p.id]);
    // the wiring: a few items at a time, working outwards from each part in turn
    const rest = mine.filter((it) => !real(it) && it !== title[0]).sort((p, q) => p.bbox[0] - q.bbox[0] || p.bbox[1] - q.bbox[1]);
    for (let i = 0; i < rest.length; i += 4) { const g = rest.slice(i, i + 4); beat(k, 230 + Math.random() * 130, mid(g[g.length - 1].bbox), g.map((it) => it.id)); }
  });
  // what stands outside every block (the supply table) goes on last, by whoever is free first
  const loose = items.filter((it) => !taken.has(it.id));
  if (loose.length) { const k = load.indexOf(Math.min(...load)); beat(k, 700, mid(loose[0].bbox), loose.map((it) => it.id)); }
  const total = Math.max(...load);
  const all = new Set(items.map((it) => it.id));

  let t = Infinity, ended = true, focus = NaN;
  // Where the camera and the hands were on the last frame of the drawing: the zoom out starts from there.
  let lastBox: Box | null = null, lastHands: Pt[] = [];
  const still = reducedMotion();

  // The sheet is drawn into a kept image and only what is new is added to it, so a frame is a copy of that
  // image plus the cursors (drawing the whole sheet each frame took 35 to 90 ms).  The drawing image holds the
  // whole sheet at the drawing's scale, wider than the window when the window drifts along it; the finished
  // image is the whole sheet fitted to the window.
  const sheet = document.createElement("canvas"), sctx = sheet.getContext("2d")!, done = document.createElement("canvas");
  let sheetKey = "", sheetView: View | null = null, doneKey = "";
  const inSheet = new Set<string>();
  function drawing(W: number, H: number, dpr: number, ids: Set<string>): View {
    const vw = view[2] - view[0], bw = (view[3] - view[1]) * W / H, sw = bw < vw * 0.8 ? W * vw / bw : W;
    const key = `${Math.round(sw)}x${H}@${dpr}`;
    if (key !== sheetKey) { sheetKey = key; sheet.width = Math.round(sw * dpr); sheet.height = Math.round(H * dpr); sheetView = fit(sw, H, dpr, view); inSheet.clear(); }
    if (!inSheet.size) { K.render(doc, sctx, sheetView, { ids, grid: 1.27, frame: false }); for (const id of ids) inSheet.add(id); }
    else {
      const add = new Set<string>(); for (const id of ids) if (!inSheet.has(id)) { add.add(id); inSheet.add(id); }
      if (add.size) K.render(doc, sctx, sheetView, { ids: add, frame: false, overlay: true, background: null });
    }
    return sheetView!;
  }
  /** Copies the part of the drawing image that `v` shows onto the window. */
  function blit(ctx: CanvasRenderingContext2D, W: number, H: number, dpr: number, v: View): void {
    const a = toPx(sheetView!, ...toMm(v, 0, 0)), b = toPx(sheetView!, ...toMm(v, W, H));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(sheet, a[0] * dpr, a[1] * dpr, (b[0] - a[0]) * dpr, (b[1] - a[1]) * dpr, 0, 0, Math.round(W * dpr), Math.round(H * dpr));
  }
  const stage: Stage = makeStage(canvas, (s, _now, dt) => {
    const { ctx, w: W, h: H } = s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const playing = t <= total + HOLD;
    if (playing) t += dt;
    if (t >= total) {
      // The camera eases out to the whole sheet while the three of them let go and leave.
      const u = lastBox ? minJerk(clamp((t - total) / ZOOM)) : 1;
      const v = fit(W, H, s.dpr, lastBox && u < 1 ? mixBox(lastBox, view, u) : view);
      if (u < 1) { drawing(W, H, s.dpr, all); blit(ctx, W, H, s.dpr, v); }
      else {
        const key = `${W}x${H}@${s.dpr}`;
        if (key !== doneKey) { doneKey = key; done.width = canvas.width; done.height = canvas.height; K.render(doc, done.getContext("2d")!, v, { ids: all, grid: 1.27, frame: false }); }
        ctx.drawImage(done, 0, 0);
      }
      if (u < 1) {
        ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
        lastHands.forEach((h, k) => { if (lanes[k].length) { const p = toPx(v, h[0], h[1]); drawCursor(ctx, p[0], p[1], PEERS[k].name, PEERS[k].color, SANS, 1 - u); } });
      } else lastBox = null;
      focus = NaN;
    }
    else {
      const ids = new Set<string>(), fresh = new Set<string>();
      for (const lane of lanes) for (const b of lane) { if (b.t > t) break; for (const id of b.ids) { ids.add(id); if (t - b.t < 260) fresh.add(id); } }
      const hands: Pt[] = lanes.map((lane, k) => {
        if (!lane.length) return mid(view);
        let i = lane.findIndex((b) => b.t > t); if (i < 0) i = lane.length - 1;
        const a = i ? lane[i - 1] : { t: 0, at: [view[0] + (view[2] - view[0]) * (0.25 + 0.25 * k), view[3] - 6] as Pt }, b = lane[i];
        // A real hand: a quick, direct reach (longer for farther places, as Fitts has it), then still for the
        // rest of the beat.  Drawn where KiCad's cursor would be, snapped to the sheet's 1.27 mm grid.
        const d = Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]);
        const reach = Math.min((b.t - a.t) * 0.8, 110 + 95 * Math.log2(1 + d / 4));
        const u = easeOut(clamp((t - a.t) / Math.max(1, reach)));
        return [snapG(lerp(a.at[0], b.at[0], u)), snapG(lerp(a.at[1], b.at[1], u))];
      });
      // A narrow window cannot show the whole sheet at a readable size: it shows the sheet's full height and
      // drifts along it with the work.
      let box = view;
      const bw = (view[3] - view[1]) * W / H;
      if (bw < (view[2] - view[0]) * 0.8) {
        const want = clamp((hands[0][0] + hands[1][0] + hands[2][0]) / 3, view[0] + bw / 2, view[2] - bw / 2);
        focus = isNaN(focus) ? want : focus + (want - focus) * Math.min(1, dt / 900);
        box = [focus - bw / 2, view[1], focus + bw / 2, view[3]];
      }
      lastBox = box.slice() as Box; lastHands = hands;
      const v = fit(W, H, s.dpr, box);
      drawing(W, H, s.dpr, ids); blit(ctx, W, H, s.dpr, v);
      // what was just put down shows selected for a moment, as it does in the editor
      if (fresh.size) K.render(doc, ctx, v, { ids: fresh, frame: false, overlay: true, background: null, selected: fresh });
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      hands.forEach((h, k) => { if (lanes[k].length) { const p = toPx(v, h[0], h[1]); drawCursor(ctx, p[0], p[1], PEERS[k].name, PEERS[k].color, SANS); } });
    }
    if (playing && t > total + HOLD && !ended) { ended = true; onEnd(); }
    return playing;
  });
  return {
    symbols: items.filter(real).length,
    play() { lastBox = null; inSheet.clear(); if (still) { t = Infinity; ended = true; } else { t = 0; ended = false; } stage.invalidate(); },
    whole() { t = Infinity; ended = true; lastBox = null; stage.invalidate(); },
  };
}

/** The hero window's two tabs.  It opens on the schematic being drawn, turns to the board when
 *  that is done, and comes back to the schematic each time the teammates start the board over. */
export function startTabs(root: HTMLElement, sch: SchScene, auto: boolean): void {
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-tab]"));
  const app = root.querySelector<HTMLElement>("[data-app]"), stat = root.querySelector<HTMLElement>("[data-sch-counts]");
  if (stat) stat.textContent = `Symbols ${sch.symbols}`;
  const cap = root.querySelector<HTMLElement>("[data-sch-cap]");
  const says = (drawing: boolean): void => { if (cap) cap.textContent = drawing ? "Mara, Jun and Ada are drawing the schematic. The board comes next." : "The schematic the board is made from."; };
  const body = root.querySelector<HTMLElement>(".win-body");
  /** Switches the window to the other editor.  The view that is left fades out over the new one,
   *  from a still copy of its last frame, so neither scene has to keep running for it. */
  function show(v: "sch" | "pcb", fade = true): void {
    const was = root.dataset.view;
    if (fade && was && was !== v && body && !reducedMotion()) {
      const old = root.querySelector<HTMLCanvasElement>(was === "sch" ? ".win-body > canvas[data-sch]" : ".win-body > canvas:not([data-sch])");
      if (old && old.width > 1 && old.offsetWidth) {
        const r = old.getBoundingClientRect(), b = body.getBoundingClientRect();
        const still = document.createElement("canvas");
        still.width = old.width; still.height = old.height; still.getContext("2d")!.drawImage(old, 0, 0);
        still.className = "fading"; still.setAttribute("aria-hidden", "true");
        Object.assign(still.style, { left: `${r.left - b.left}px`, top: `${r.top - b.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        body.appendChild(still);
        requestAnimationFrame(() => requestAnimationFrame(() => { still.style.opacity = "0"; }));
        setTimeout(() => still.remove(), FADE + 100);
      }
    }
    root.dataset.view = v;
    for (const b of tabs) b.setAttribute("aria-selected", String(b.dataset.tab === v));
    if (app) app.textContent = v === "sch" ? "Schematic Editor" : "PCB Editor";
  }
  for (const b of tabs) b.addEventListener("click", () => { const v = b.dataset.tab as "sch" | "pcb"; if (v === "sch") { sch.whole(); says(false); } show(v); });
  root.addEventListener("hero:sch-done", () => show("pcb"));
  if (auto) {
    root.addEventListener("hero:again", () => { show("sch"); says(true); sch.play(); });
    show("sch", false); says(true); sch.play();
  } else { sch.whole(); says(false); show("pcb", false); }
}
