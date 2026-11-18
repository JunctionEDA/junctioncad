// mech/enclosure.ts — the enclosure in the board's 3D viewer: the bodies of every part studio that drives the
// open board, drawn around it where the link places it, following the model as it changes; and, for the
// selected component, where it stands against the keep-outs over it.
//
// Where the meshes come from.  The part studio document stores features, not triangles, and nothing is cached
// with it: a mesh in the document would put megabytes through the collaboration log on every edit.  So the
// board page runs the modelling worker itself, headless: one KernelClient per linked part studio
// (mechanical/api.ts), fed the features of the session mech/links.ts already holds.  The worker and its 23 MB
// kernel are fetched only when the 3D viewer is opened on a board that has a link and the enclosure is not
// hidden, and are dropped when the viewer closes.  An edit in the part studio arrives over its session and
// re-evaluates only the features it touches (the worker's cache), so the enclosure follows within a rebuild.
import { store } from "../editor/appstore";
import { E } from "../editor/state";
import { BoardFeed, KernelClient, directionToBoard3D, modelToBoard3D, placementOf, studioInputs, type BodyResult, type Placement } from "../../mechanical/api";
import { stableJson, type Json } from "../../../shared/itemdoc/itemdoc";
import { headroom, type PartBody } from "./check";
import { mech } from "./sync";

type RGB = [number, number, number];
interface ExtraMesh { positions: Float32Array; normals: Float32Array; indices: Uint32Array; color: RGB; opacity: number; section?: boolean }
interface ViewerLike { setExtras(meshes: readonly ExtraMesh[], section?: { normal: RGB; constant: number } | null): void; extraCount: number }
interface WindowLike { viewer: ViewerLike | null; root: HTMLElement; closed: boolean }

export type EnclosureMode = "see-through" | "solid" | "section" | "hidden";
const MODES: { id: EnclosureMode; label: string }[] = [{ id: "see-through", label: "See-through" }, { id: "solid", label: "Solid" }, { id: "section", label: "Section" }, { id: "hidden", label: "Hidden" }];
const MODE_KEY = "kui.v3d.enclosure";
// scene colours, like viewer3d/colors.ts: the enclosure, the selected component, a limit it clears, one it breaks
const SHELL: RGB = [0.62, 0.65, 0.70], PICK: RGB = [1.0, 0.78, 0.18], CLEAR: RGB = [0.20, 0.72, 0.62], BREAK: RGB = [0.90, 0.22, 0.20];

interface Studio { client: KernelClient; /** the boards of the studio's own Board features (a studio may show the board it drives) */ feed: BoardFeed; key: string; /** the document version `key` was worked out for */ seen: number; bodies: BodyResult[]; busy: boolean; failed: string }

/** A box in the board's 3D space as a mesh. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: RGB, opacity: number): ExtraMesh {
  const P: number[] = [], N: number[] = [], I: number[] = [];
  const face = (a: number[], b: number[], c: number[], d: number[], n: number[]) => { const i = P.length / 3; P.push(...a, ...b, ...c, ...d); for (let k = 0; k < 4; k++) N.push(...n); I.push(i, i + 1, i + 2, i, i + 2, i + 3); };
  face([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
  face([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1]);
  face([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
  face([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0]);
  face([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
  face([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0]);
  return { positions: new Float32Array(P), normals: new Float32Array(N), indices: new Uint32Array(I), color, opacity };
}

class Enclosure {
  mode: EnclosureMode = "see-through";
  private win: WindowLike | null = null;
  private studios = new Map<string, Studio>();
  private control: HTMLElement | null = null;
  private note: HTMLElement | null = null;
  private timer = 0;
  private stop: (() => void)[] = [];
  private placed = new Map<string, ExtraMesh>();
  private selKey = "";
  private pick: ExtraMesh[] = [];
  private drawn = "";
  private meshIds = new WeakMap<ExtraMesh, number>(); private meshN = 0;
  private idOf(m: ExtraMesh): number { let id = this.meshIds.get(m); if (!id) { id = ++this.meshN; this.meshIds.set(m, id); } return id; }
  /** for tests: how many times the enclosure was drawn, and the bodies in the last drawing */
  draws = 0; lastBodies = 0;

  constructor() {
    try { const m = localStorage.getItem(MODE_KEY) as EnclosureMode | null; if (m && MODES.some((x) => x.id === m)) this.mode = m; } catch (e) { /* storage blocked */ }
    const g = globalThis as unknown as { KiCadViewer3DOpened?: ((win: WindowLike) => void)[] };
    (g.KiCadViewer3DOpened = g.KiCadViewer3DOpened || []).push((win) => this.attach(win));
  }

  private attach(win: WindowLike): void {
    this.detach();
    if (!win.viewer) return;
    this.win = win;
    this.stop.push(mech.subscribe(() => this.schedule()));
    this.stop.push(store.subscribe(() => { const k = store.get().selection.ids.join(","); if (k !== this.selKey) { this.selKey = k; void this.refreshPick(); } }));
    this.selKey = store.get().selection.ids.join(",");
    this.buildControl();
    this.schedule();
    void this.refreshPick();
    // the window has no close event: notice it by looking
    const watch = window.setInterval(() => { if (win.closed) this.detach(); }, 500);
    this.stop.push(() => clearInterval(watch));
  }

  private detach(): void {
    for (const f of this.stop.splice(0)) f();
    clearTimeout(this.timer);
    for (const s of this.studios.values()) { s.client.dispose(); s.feed.close(); }
    this.studios.clear(); this.placed.clear(); this.pick = [];
    this.drawn = "";
    if (this.control) this.control.remove();
    this.control = null; this.note = null; this.win = null;
  }

  setMode(mode: EnclosureMode): void {
    this.mode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* storage blocked */ }
    if (this.control) { const sel = this.control.querySelector("select"); if (sel) (sel as HTMLSelectElement).value = mode; }
    this.schedule();
  }

  private buildControl(): void {
    const win = this.win!; const stage = win.root.querySelector(".v3d-stage") as HTMLElement | null; if (!stage) return;
    const box = document.createElement("label");
    box.className = "v3d-enclosure";
    box.style.cssText = "position:absolute;left:8px;top:8px;z-index:3;display:none;align-items:center;gap:6px;padding:3px 6px;border:1px solid var(--line);border-radius:var(--r-2);background:var(--panel);color:var(--ink);font-size:var(--fs-sm)";
    const text = document.createElement("span"); text.textContent = "Enclosure";
    const sel = document.createElement("select"); sel.className = "input"; sel.setAttribute("aria-label", "Enclosure");
    for (const m of MODES) { const o = document.createElement("option"); o.value = m.id; o.textContent = m.label; sel.appendChild(o); }
    sel.value = this.mode;
    sel.addEventListener("change", () => this.setMode(sel.value as EnclosureMode));
    const note = document.createElement("span"); note.style.color = "var(--ink-3)";
    box.append(text, sel, note);
    if (getComputedStyle(stage).position === "static") stage.style.position = "relative";
    stage.appendChild(box);
    this.control = box; this.note = note;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.update(), 150);
  }

  /** Bring every linked studio's bodies up to date, then draw. */
  private async update(): Promise<void> {
    const win = this.win; if (!win || win.closed || !win.viewer) return;
    const state = mech.getState();
    const placed = state.sources.filter((s) => placementOf(s.link));
    if (this.control) this.control.style.display = placed.length ? "flex" : "none";
    const wanted = new Set(this.mode === "hidden" ? [] : placed.map((s) => s.studioDoc));
    for (const [id, s] of Array.from(this.studios)) if (!wanted.has(id)) { s.client.dispose(); s.feed.close(); this.studios.delete(id); }
    let working = false;
    for (const id of wanted) {
      const doc = mech.links.studioDoc(id); if (!doc) continue;
      let s = this.studios.get(id);
      if (!s) {
        const made: Studio = { client: new KernelClient(), feed: null as unknown as BoardFeed, key: "", seen: -1, bodies: [], busy: false, failed: "" };
        made.feed = new BoardFeed({ signedIn: mech.links.signedIn, changed: () => { made.seen = -1; this.schedule(); } });
        this.studios.set(id, made); s = made;
      }
      // most changes of the board's state are not changes of this part studio: do not walk its features for those
      const version = mech.links.version(id);
      if (version === s.seen) { working = working || s.busy; continue; }
      s.seen = version;
      // as the studio's own page builds it: variables applied, boards supplied (mechanical document/inputs.ts)
      const { features: inputs, rollback } = studioInputs(doc, { filters: [s.feed.filter] });
      const key = rollback + "|" + stableJson(inputs as unknown as Json);
      if (key === s.key) { working = working || s.busy; continue; }
      s.key = key; s.busy = true; working = true;
      const mine = s;
      mine.client.regenerate(inputs, rollback).then((result) => {
        if (this.studios.get(id) !== mine) return;
        // not the board's own stand-in solids (a Board feature's reference bodies): the real board is right here
        if (result) { mine.bodies = result.bodies.filter((b) => !b.reference); mine.failed = ""; }
        if (mine.key === key) mine.busy = false;
        this.draw();
      }).catch((e: unknown) => { mine.busy = false; mine.failed = (e as Error).message || String(e); this.draw(); });
    }
    if (this.note) this.note.textContent = working ? "building…" : "";
    this.draw();
  }

  /** A body's mesh moved into the board's 3D space; kept until the body or the placement changes. */
  private place(studioDoc: string, body: BodyResult, pl: Placement, thickness: number): ExtraMesh | null {
    const mesh = body.mesh; if (!mesh) return null;
    const key = `${studioDoc}:${body.rev}:${thickness}:${stableJson(pl as unknown as Json)}`;
    let out = this.placed.get(key);
    if (out) return out;
    const n = mesh.positions.length, P = new Float32Array(n), N = new Float32Array(n);
    for (let i = 0; i < n; i += 3) {
      const p = modelToBoard3D(pl, thickness, [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
      P[i] = p[0]; P[i + 1] = p[1]; P[i + 2] = p[2];
      const d = directionToBoard3D(pl, [mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]]);
      N[i] = d[0]; N[i + 1] = d[1]; N[i + 2] = d[2];
    }
    out = { positions: P, normals: N, indices: mesh.indices, color: SHELL, opacity: 1, section: true };
    this.placed.set(key, out);
    return out;
  }

  private draw(): void {
    const win = this.win; if (!win || win.closed || !win.viewer) return;
    const state = mech.getState(), thickness = mech.thickness();
    const meshes: ExtraMesh[] = [];
    const live = new Set<ExtraMesh>();
    let y0 = Infinity, y1 = -Infinity;
    if (this.mode !== "hidden") {
      for (const src of state.sources) {
        const pl = placementOf(src.link), s = this.studios.get(src.studioDoc); if (!pl || !s) continue;
        for (const body of s.bodies) {
          const m = this.place(src.studioDoc, body, pl, thickness); if (!m) continue;
          live.add(m);
          meshes.push({ ...m, opacity: this.mode === "see-through" ? 0.32 : 1 });
          for (let i = 1; i < m.positions.length; i += 3) { const y = m.positions[i]; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
      }
    }
    for (const [k, m] of Array.from(this.placed)) if (!live.has(m)) this.placed.delete(k);
    this.lastBodies = meshes.length;
    const working = Array.from(this.studios.values()).some((s) => s.busy), failed = Array.from(this.studios.values()).find((s) => s.failed);
    if (this.note) this.note.textContent = failed ? failed.failed : working ? "building…" : "";
    // the section cuts the enclosure through its middle and keeps the far half: the board is seen inside it
    const section = this.mode === "section" && meshes.length ? { normal: [0, 1, 0] as RGB, constant: -(y0 + y1) / 2 } : null;
    // the same picture as last time (most changes of the board do not move the enclosure): leave the scene alone
    const drawn = [this.mode, section ? section.constant : "", ...Array.from(live, (m) => this.idOf(m)), "|", ...this.pick.map((m) => this.idOf(m))].join(",");
    if (drawn === this.drawn && win.viewer.extraCount === meshes.length + this.pick.length) return;
    this.drawn = drawn;
    win.viewer.setExtras(meshes.concat(this.pick), section);
    this.draws++;
  }

  /** The selected component as a marker, with a plate at the height each keep-out over it allows. */
  private async refreshPick(): Promise<void> {
    const win = this.win; if (!win || win.closed) return;
    const ids = store.get().selection.ids;
    const doc = E.kdoc as KDoc | null;
    const fp = doc ? ids.map((id) => doc.items.get(id)).find((it) => it && it.kind === "footprint") : null;
    let pick: ExtraMesh[] = [];
    if (fp) {
      let part: PartBody | undefined;
      try { part = (await mech.parts()).find((p) => p.id === fp.id); } catch (e) { /* the viewer bundle is loading: no marker this time */ }
      if (part && this.win === win) {
        const t = mech.thickness(), xs = part.pts.map((p) => p[0]), ys = part.pts.map((p) => -p[1]);
        const x0 = Math.min(...xs) - 0.15, x1 = Math.max(...xs) + 0.15, yy0 = Math.min(...ys) - 0.15, yy1 = Math.max(...ys) + 0.15;
        const z = (h: number) => (part!.back ? -t - h : h);
        pick.push(box(x0, yy0, Math.min(z(0), z(part.height + 0.1)), x1, yy1, Math.max(z(0), z(part.height + 0.1)), PICK, 0.55));
        for (const { area, room } of headroom(part, mech.getState().areas)) {
          const at = z(area.limit);
          pick.push(box(x0 - 1.5, yy0 - 1.5, at - 0.04, x1 + 1.5, yy1 + 1.5, at + 0.04, room < 0 ? BREAK : CLEAR, 0.6));
        }
      }
    }
    if (this.win !== win) return;
    if (!pick.length && !this.pick.length) return;
    this.pick = pick;
    this.draw();
  }
}

export const enclosure = new Enclosure();
