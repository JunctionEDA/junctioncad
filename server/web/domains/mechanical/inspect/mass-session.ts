// mass-session.ts — mass properties in the part studio: asks the worker (the "mass-properties" service) about
// the selected parts, or every part when none is selected, with the densities of their materials, again after
// every rebuild and every material change; and marks the centre of mass in the viewport when asked.
import * as THREE from "three";
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { tokenColor } from "../../../shared/viewport3d/viewport3d";
import { densities } from "../document/mass-materials";
import type { MassBody, MassTotal } from "../services/mass-properties";
import type { PartStudio } from "../ui/studio";
import { selectedBodies } from "./appearance-display";
import { Store, perStudio } from "./store";

export interface MassState {
  /** the parts measured: the selection's, or every part */
  bodies: string[];
  fromSelection: boolean;
  parts: MassBody[];
  total: MassTotal | null;
  busy: boolean;
  error: string;
  showCentre: boolean;
}

export class MassSession extends Store<MassState> {
  private seq = 0;
  private timer = 0;
  private last: { sel: unknown; bodies: unknown; features: unknown; editing: boolean } = { sel: null, bodies: null, features: null, editing: false };
  private readonly marker = new THREE.Group();
  /** Panels that show mass properties say so: nothing is computed while no one is looking. */
  private watchers = 0;

  constructor(readonly studio: PartStudio) {
    super({ bodies: [], fromSelection: false, parts: [], total: null, busy: false, error: "", showCentre: false });
    studio.viewport.scene.add(this.marker);
    studio.viewport.onTheme.push(() => this.drawMarker());
    studio.subscribe(() => {
      const s = studio.getState();
      if (s.selection === this.last.sel && s.bodies === this.last.bodies && s.features === this.last.features && !!s.editing === this.last.editing) return;
      const changed = s.bodies !== this.last.bodies || s.features !== this.last.features || this.pickBodies().join() !== this.state.bodies.join();
      const ended = this.last.editing && !s.editing;
      this.last = { sel: s.selection, bodies: s.bodies, features: s.features, editing: !!s.editing };
      if (ended) { this.schedule(); return; }
      if (changed) this.schedule();
    });
  }

  watch(): () => void { this.watchers++; this.schedule(); return () => { this.watchers--; }; }

  private pickBodies(): string[] {
    const sel = selectedBodies(this.studio), bodies = this.studio.getState().bodies, all = bodies.map((b) => b.id);
    const chosen = sel.filter((b) => all.includes(b));
    // with nothing selected: every part, but not a body that is only there to be referred to (a board)
    return chosen.length ? chosen : bodies.filter((b) => !b.reference).map((b) => b.id);
  }

  schedule(): void { clearTimeout(this.timer); this.timer = window.setTimeout(() => void this.compute(), 40); }

  private async compute(): Promise<void> {
    if (!this.watchers && !this.state.showCentre) return;
    // not while a dialog previews or a sketch is open: the one modelling thread is busy with those, and the
    // bodies are a draft; the result of accepting or closing triggers a new computation
    const st = this.studio.getState();
    if (st.editing || st.sketch) return;
    const seq = ++this.seq;
    const bodies = this.pickBodies();
    const fromSelection = selectedBodies(this.studio).length > 0;
    if (!bodies.length) { this.set({ bodies, fromSelection, parts: [], total: null, busy: false, error: "" }); this.drawMarker(); return; }
    this.set({ busy: true, bodies, fromSelection });
    try {
      const r = await this.studio.kernel.call<Json>("mass-properties", { bodies, density: densities(this.studio.doc) } as unknown as Json) as unknown as { parts: MassBody[]; total: MassTotal };
      if (seq !== this.seq) return;
      this.set({ parts: r.parts, total: r.total, busy: false, error: "" });
    } catch (e) {
      if (seq !== this.seq) return;
      this.set({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
    this.drawMarker();
  }

  setShowCentre(on: boolean): void { this.set({ showCentre: on }); if (on) this.schedule(); this.drawMarker(); }

  /** A dot and three short axes at the centre of mass, drawn over the model. */
  private drawMarker(): void {
    for (const o of this.marker.children.slice()) { this.marker.remove(o); const m = o as THREE.Mesh; m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    const t = this.state.total;
    if (this.state.showCentre && t && this.state.parts.length) {
      const c = new THREE.Vector3(...t.centre);
      const size = t.bbox ? Math.max(1, Math.hypot(t.bbox[3] - t.bbox[0], t.bbox[4] - t.bbox[1], t.bbox[5] - t.bbox[2])) * 0.08 : 5;
      const mark = tokenColor("--mark");
      const dot = new THREE.Points(new THREE.BufferGeometry().setFromPoints([c]), new THREE.PointsMaterial({ color: mark, size: 11, sizeAttenuation: false, depthTest: false }));
      dot.renderOrder = 30; dot.raycast = () => {}; dot.name = "centre-of-mass";
      const pts: THREE.Vector3[] = [];
      for (const d of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) { pts.push(c.clone().addScaledVector(new THREE.Vector3(...d), -size), c.clone().addScaledVector(new THREE.Vector3(...d), size)); }
      const axes = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: mark, depthTest: false }));
      axes.renderOrder = 30; axes.raycast = () => {};
      this.marker.add(dot, axes);
    }
    this.studio.viewport.invalidate();
  }
}

export const massOf = (studio: PartStudio): MassSession => perStudio(studio, "mass-session", (s) => new MassSession(s));
