// appearance-display.ts — how the part studio's bodies are drawn: their colours and opacity (per part and per
// face, from the document's appearance and material items), the view mode (shaded with edges, shaded,
// wireframe, hidden line), which parts are hidden or isolated, and the clipping planes of a section view.
//
// It dresses the meshes ModelView makes (`view.bodyObjects`) with its own materials, again after every
// regeneration (`view.onBodies`), so ModelView stays the one place bodies are built.  Hidden parts are moved to
// another layer as well as made invisible: the picking ray skips them.
import * as THREE from "three";
import { tokenColor } from "../../../shared/viewport3d/viewport3d";
import { looksOf, type BodyLook } from "../document/appearance-items";
import { materialsOf, type Material } from "../document/mass-materials";
import type { PartStudio } from "../ui/studio";
import { Store, perStudio } from "./store";

export type ViewMode = "shaded-edges" | "shaded" | "wireframe" | "hidden-line";
export const VIEW_MODES: { id: ViewMode; title: string }[] = [
  { id: "shaded-edges", title: "Shaded with edges" }, { id: "shaded", title: "Shaded" },
  { id: "wireframe", title: "Wireframe" }, { id: "hidden-line", title: "Hidden line" },
];

export interface DisplayState {
  mode: ViewMode;
  /** parts hidden by hand */
  hidden: string[];
  /** when set, only these parts are shown */
  isolated: string[] | null;
  perspective: boolean;
}

const HIDDEN_LAYER = 7;

interface Dressed { mats: THREE.Material[]; edge: THREE.LineBasicMaterial }

export class BodyDisplay extends Store<DisplayState> {
  private dressed = new Map<string, Dressed>();
  private clip: THREE.Plane[] = [];
  private lastFeatures: unknown = null;
  private looks: { [bodyId: string]: BodyLook } = {};
  private materials: { library: { [id: string]: Material }; assign: { [bodyId: string]: string } } = { library: {}, assign: {} };
  private theme = { body: new THREE.Color(), edge: new THREE.Color(), paper: new THREE.Color() };
  /** Called after the bodies were re-dressed (the section view rebuilds its caps). */
  readonly onApplied: (() => void)[] = [];

  constructor(readonly studio: PartStudio) {
    super({ mode: "shaded-edges", hidden: [], isolated: null, perspective: studio.viewport.projection === "perspective" });
    studio.viewport.renderer.localClippingEnabled = true;
    this.readTheme();
    studio.viewport.onTheme.push(() => { this.readTheme(); this.apply(); });
    studio.view.onBodies.push(() => this.apply());
    studio.subscribe(() => {
      const s = studio.getState();
      if (s.features === this.lastFeatures) return;
      this.lastFeatures = s.features;
      if (this.readDocument()) this.apply();
    });
    this.readDocument();
    this.apply();
  }

  private readTheme(): void {
    const ink = tokenColor("--ink"), paper = tokenColor("--paper");
    this.theme.body.copy(paper).lerp(ink, 0.22);
    this.theme.edge.copy(ink);
    this.theme.paper.copy(paper);
  }

  /** Re-read the appearance and material items; true when what is drawn must change. */
  private readDocument(): boolean {
    const doc = this.studio.doc;
    const looks = looksOf(doc), m = materialsOf(doc);
    const materials = { library: m.library, assign: m.assign };
    const same = JSON.stringify(looks) === JSON.stringify(this.looks) && JSON.stringify(materials) === JSON.stringify(this.materials);
    this.looks = looks; this.materials = materials;
    return !same;
  }

  // ---------------------------------------------------------------- what a part looks like
  /** The colour a part is drawn in: its own, else its material's, else the theme's. */
  colorOf(bodyId: string): THREE.Color {
    const own = this.looks[bodyId]?.color;
    if (own) return new THREE.Color(own);
    const mat = this.materials.assign[bodyId] && this.materials.library[this.materials.assign[bodyId]];
    if (mat) return new THREE.Color(mat.color);
    return this.theme.body.clone();
  }
  /** The colour as "#rrggbb" for an input. */
  hexOf(bodyId: string): string { return "#" + this.colorOf(bodyId).getHexString(); }
  opacityOf(bodyId: string): number { return this.looks[bodyId]?.opacity ?? 1; }
  lookOf(bodyId: string): BodyLook { return this.looks[bodyId] || {}; }
  isVisible(bodyId: string): boolean {
    const s = this.state;
    return !s.hidden.includes(bodyId) && (!s.isolated || s.isolated.includes(bodyId));
  }

  // ---------------------------------------------------------------- what the person asks for
  setMode(mode: ViewMode): void { this.set({ mode }); this.apply(); }
  cycleMode(): void { const i = VIEW_MODES.findIndex((m) => m.id === this.state.mode); this.setMode(VIEW_MODES[(i + 1) % VIEW_MODES.length].id); }
  setPerspective(on: boolean): void { this.studio.viewport.setProjection(on ? "perspective" : "orthographic"); this.set({ perspective: on }); }
  /** Keep the toggle in step after a named view changed the projection. */
  syncProjection(): void { this.set({ perspective: this.studio.viewport.projection === "perspective" }); }
  hide(ids: readonly string[]): void { this.set({ hidden: Array.from(new Set([...this.state.hidden, ...ids])) }); this.apply(); }
  show(ids: readonly string[]): void {
    const s = this.state;
    const isolated = s.isolated ? Array.from(new Set([...s.isolated, ...ids])) : null;
    this.set({ hidden: s.hidden.filter((h) => !ids.includes(h)), isolated }); this.apply();
  }
  toggle(id: string): void { if (this.isVisible(id)) this.hide([id]); else this.show([id]); }
  isolate(ids: readonly string[] | null): void { this.set({ isolated: ids && ids.length ? ids.slice() : null, hidden: ids ? this.state.hidden.filter((h) => !ids.includes(h)) : this.state.hidden }); this.apply(); }
  showAll(): void { this.set({ hidden: [], isolated: null }); this.apply(); }
  /** The clipping planes every body is cut by (the section view). */
  setClip(planes: THREE.Plane[]): void { this.clip = planes; for (const d of this.dressed.values()) { for (const m of d.mats) m.clippingPlanes = planes; d.edge.clippingPlanes = planes; } this.studio.viewport.invalidate(); }

  // ---------------------------------------------------------------- dressing the meshes
  apply(): void {
    const s = this.state, view = this.studio.view;
    const live = new Set<string>();
    for (const b of this.studio.getState().bodies) {
      const o = view.bodyObjects(b.id); if (!o || !b.mesh) continue;
      live.add(b.id);
      const old = this.dressed.get(b.id);
      if (old) { for (const m of old.mats) m.dispose(); old.edge.dispose(); }
      const color = this.colorOf(b.id), opacity = this.opacityOf(b.id), look = this.looks[b.id] || {};
      const see = opacity < 1;
      const surface = (c: THREE.Color): THREE.Material => {
        const common = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, transparent: see, opacity, depthWrite: !see, clippingPlanes: this.clip };
        return s.mode === "hidden-line" ? new THREE.MeshBasicMaterial({ ...common, color: this.theme.paper, transparent: false, opacity: 1, depthWrite: true })
          : new THREE.MeshStandardMaterial({ ...common, color: c, roughness: 0.75, metalness: 0.05 });
      };
      // per-face colours: one material per colour, the faces' triangle ranges as geometry groups
      const g = o.mesh.geometry;
      g.clearGroups();
      const mats: THREE.Material[] = [surface(color)];
      const faceColors = s.mode === "hidden-line" ? {} : look.faces || {};
      if (Object.keys(faceColors).length) {
        const slot = new Map<string, number>();
        const names = b.mesh.faces.names;
        for (let i = 0; i < names.length; i++) {
          const c = faceColors[names[i]];
          let at = 0;
          if (c) { if (!slot.has(c)) { slot.set(c, mats.length); mats.push(surface(new THREE.Color(c))); } at = slot.get(c)!; }
          g.addGroup(b.mesh.faces.start[i], b.mesh.faces.count[i], at);
        }
      }
      o.mesh.material = mats.length > 1 ? mats : mats[0];
      const edge = new THREE.LineBasicMaterial({ color: this.theme.edge, clippingPlanes: this.clip, transparent: see, opacity: see ? Math.max(0.35, opacity) : 1 });
      o.edges.material = edge;
      this.dressed.set(b.id, { mats, edge });
      // the view mode
      // (a body something else draws in its own way, as the Board feature's solids under the board's picture,
      // stays hidden: viewport/modelview.ts bodyStyle)
      const style = this.studio.view.bodyStyle ? this.studio.view.bodyStyle(o.result) : null;
      o.mesh.visible = s.mode !== "wireframe" && !(style && style.faces === false);
      o.edges.visible = s.mode !== "shaded" && !(style && style.edges === false);
      // hidden parts: not drawn, and not on the layer the picking ray sees
      const visible = this.isVisible(b.id);
      o.group.visible = visible;
      for (const x of [o.mesh, o.edges, o.points]) x.layers.set(visible ? 0 : HIDDEN_LAYER);
    }
    for (const [id, d] of Array.from(this.dressed)) if (!live.has(id)) { for (const m of d.mats) m.dispose(); d.edge.dispose(); this.dressed.delete(id); }
    this.studio.viewport.invalidate();
    for (const fn of this.onApplied) fn();
  }
}

export const displayOf = (studio: PartStudio): BodyDisplay => perStudio(studio, "appearance-display", (s) => new BodyDisplay(s));

/** The bodies a selection is on (faces, edges and vertices of them). */
export function selectedBodies(studio: PartStudio): string[] {
  const out: string[] = [];
  for (const p of studio.getState().selection) if ((p.kind === "face" || p.kind === "edge" || p.kind === "vertex") && !out.includes(p.body)) out.push(p.body);
  return out;
}
