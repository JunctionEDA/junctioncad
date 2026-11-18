// viewport3d.ts — the 3D viewport every modelling domain draws in: a WebGL canvas with an orthographic camera,
// orbit / pan / zoom, the standard views, fit, an axis triad, and colours taken from the theme tokens.
//
// It knows nothing about parts or assemblies.  A domain puts its own objects in `scene`, calls `invalidate()`
// when they change, and asks for rays (`ray(ev)`) to do its own picking.  Model space is millimetres, Z up.
//
//   pointer   right-drag orbits, middle-drag (or Shift + right-drag) pans, the wheel zooms about the pointer;
//             the left button is the domain's (selection, sketching)
//   keys      none here: the domain binds its own
import * as THREE from "three";
import { subscribeTheme as onThemeChange } from "../theme";

export type StandardView = "top" | "bottom" | "front" | "back" | "right" | "left" | "iso";

/** [direction the camera looks along, up] for each standard view, Z up. */
const VIEWS: Record<StandardView, [THREE.Vector3Tuple, THREE.Vector3Tuple]> = {
  top: [[0, 0, -1], [0, 1, 0]], bottom: [[0, 0, 1], [0, -1, 0]],
  front: [[0, 1, 0], [0, 0, 1]], back: [[0, -1, 0], [0, 0, 1]],
  right: [[-1, 0, 0], [0, 0, 1]], left: [[1, 0, 0], [0, 0, 1]],
  iso: [[-1, 1, -1], [0, 0, 1]],
};

/** A theme token as a three.js colour.  Any CSS colour syntax works: the browser resolves it. */
let probe: CanvasRenderingContext2D | null = null;
export function tokenColor(name: string, fallback = "#888"): THREE.Color {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  if (!probe) { const c = document.createElement("canvas"); c.width = c.height = 1; probe = c.getContext("2d", { willReadFrequently: true }); }
  if (!probe) return new THREE.Color(fallback);
  probe.clearRect(0, 0, 1, 1); probe.fillStyle = fallback; probe.fillStyle = raw; probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return new THREE.Color().setRGB(d[0] / 255, d[1] / 255, d[2] / 255, THREE.SRGBColorSpace);
}

export interface ViewportOptions {
  /** the standard-view buttons in the corner (default true) */
  viewButtons?: boolean;
}

export type Projection = "orthographic" | "perspective";

/** Where the camera is: what a named view stores (`cameraState()` / `setCameraState()`). */
export interface CameraState { quaternion: [number, number, number, number]; target: [number, number, number]; zoom: number; projection: Projection }

export class Viewport3D {
  readonly scene = new THREE.Scene();
  /** The camera navigation drives.  In perspective it still holds the view (turn, target, zoom); frames are drawn with `activeCamera`. */
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
  /** Follows `camera` in perspective: same direction, and the same height of view at the target. */
  readonly perspectiveCamera = new THREE.PerspectiveCamera(30, 1, 1, 1e6);
  private persp = false;
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  /** the point the camera orbits */
  readonly target = new THREE.Vector3();
  /** Called after the theme changed, before the next frame: re-read your token colours. */
  onTheme: (() => void)[] = [];
  /** Called before every frame. */
  onFrame: (() => void)[] = [];
  private readonly light = new THREE.DirectionalLight(0xffffff, 2.2);
  private readonly triad = new THREE.Scene();
  private readonly triadCam = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, -10, 10);
  private frame = 0;
  private disposed = false;
  private readonly ro: ResizeObserver;
  private readonly offTheme: () => void;
  private readonly views: HTMLElement | null = null;
  private drag: { mode: "orbit" | "pan"; x: number; y: number; id: number } | null = null;
  private anim: { from: THREE.Quaternion; to: THREE.Quaternion; t0: number; ms: number } | null = null;

  constructor(readonly host: HTMLElement, opts: ViewportOptions = {}) {
    host.style.position = host.style.position || "relative";
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;outline:none;touch-action:none";
    this.canvas.tabIndex = 0;
    host.appendChild(this.canvas);
    // a stencil buffer for capped section views (the mechanical domain's section tool)
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, stencil: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.autoClear = false;
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    this.scene.add(this.light);
    this.scene.add(this.light.target);
    this.camera.up.set(0, 0, 1);
    this.setView("iso", false);

    const axis = (dir: THREE.Vector3Tuple, token: string) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...dir)]);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: tokenColor(token) }));
      l.userData.token = token;
      this.triad.add(l);
    };
    axis([1, 0, 0], "--err"); axis([0, 1, 0], "--wire"); axis([0, 0, 1], "--blue");

    if (opts.viewButtons !== false) {
      const bar = document.createElement("div");
      bar.className = "v3-views seg";
      bar.style.cssText = "position:absolute;top:8px;right:8px;z-index:2";
      const names: [string, StandardView | "fit"][] = [["Top", "top"], ["Front", "front"], ["Right", "right"], ["Iso", "iso"], ["Fit", "fit"]];
      for (const [label, view] of names) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = label; b.dataset.view = view;
        b.title = view === "fit" ? "Zoom to fit" : `${label} view`;
        b.onclick = () => { if (view === "fit") this.fit(); else this.setView(view); this.canvas.focus(); };
        bar.appendChild(b);
      }
      host.appendChild(bar);
      this.views = bar;
    }

    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.offTheme = onThemeChange(() => this.themeChanged());
    this.themeChanged();
    this.resize();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.ro.disconnect(); this.offTheme();
    this.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
    this.renderer.dispose();
    this.canvas.remove(); this.views?.remove();
  }

  private themeChanged(): void {
    this.scene.background = tokenColor("--paper");
    for (const o of this.triad.children) ((o as THREE.Line).material as THREE.LineBasicMaterial).color.copy(tokenColor(o.userData.token));
    for (const fn of this.onTheme) fn();
    this.invalidate();
  }

  /** Ask for a frame.  Cheap to call often: frames are drawn once per animation frame, and only on request. */
  invalidate(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  get width(): number { return this.host.clientWidth || 1; }
  get height(): number { return this.host.clientHeight || 1; }
  /** Millimetres per CSS pixel at the current zoom. */
  pixelSize(): number { return (this.camera.top - this.camera.bottom) / this.camera.zoom / this.height; }

  private resize(): void {
    const w = this.width, h = this.height;
    this.renderer.setSize(w, h, false);
    const half = 100;   // the view is 200 mm tall at zoom 1
    this.camera.left = (-half * w) / h; this.camera.right = (half * w) / h; this.camera.top = half; this.camera.bottom = -half;
    this.camera.updateProjectionMatrix();
    this.render();   // at once: a resized canvas is cleared, and a frame later would flicker
  }

  private place(): void {
    // the camera sits far back along its own view direction; orthographic, so the distance only orders depth
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
    this.camera.position.copy(this.target).addScaledVector(back, 2e4);
    this.camera.updateMatrixWorld();
    if (this.persp) {
      // as far back as makes the view at the target as tall as the orthographic one: zoom and fit keep working
      const pc = this.perspectiveCamera, h = (this.camera.top - this.camera.bottom) / this.camera.zoom;
      const d = h / 2 / Math.tan((pc.fov * Math.PI) / 360);
      pc.quaternion.copy(this.camera.quaternion);
      pc.position.copy(this.target).addScaledVector(back, d);
      pc.aspect = this.width / this.height; pc.near = d / 50; pc.far = d + 200 * h + 1e3;
      pc.updateProjectionMatrix(); pc.updateMatrixWorld();
    }
  }

  /** The camera frames are drawn with: `camera`, or in perspective `perspectiveCamera`. */
  get activeCamera(): THREE.Camera { return this.persp ? this.perspectiveCamera : this.camera; }
  get projection(): Projection { return this.persp ? "perspective" : "orthographic"; }
  setProjection(p: Projection): void { this.persp = p === "perspective"; this.place(); this.invalidate(); }

  /** Where the camera is, to come back to later (a named view). */
  cameraState(): CameraState {
    const q = this.camera.quaternion;
    return { quaternion: [q.x, q.y, q.z, q.w], target: [this.target.x, this.target.y, this.target.z], zoom: this.camera.zoom, projection: this.projection };
  }
  /** Go back to a `cameraState()`: turned, centred and zoomed as it was. */
  setCameraState(s: CameraState, animate = true): void {
    const q = new THREE.Quaternion(...s.quaternion).normalize();
    this.target.set(...s.target);
    this.camera.zoom = Math.max(0.02, Math.min(4000, s.zoom || 1)); this.camera.updateProjectionMatrix();
    this.persp = s.projection === "perspective";
    if (animate && !this.disposed && matchMedia("(prefers-reduced-motion: no-preference)").matches) this.anim = { from: this.camera.quaternion.clone(), to: q, t0: performance.now(), ms: 220 };
    else { this.anim = null; this.camera.quaternion.copy(q); }
    this.invalidate();
  }

  private render(): void {
    if (this.disposed) return;
    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.t0) / this.anim.ms), e = t * t * (3 - 2 * t);
      this.camera.quaternion.slerpQuaternions(this.anim.from, this.anim.to, e);
      if (t >= 1) this.anim = null; else this.invalidate();
    }
    this.place();
    this.light.position.copy(this.camera.position).addScaledVector(new THREE.Vector3(-0.4, 0.6, 0).applyQuaternion(this.camera.quaternion), 2e4);
    this.light.target.position.copy(this.target);
    this.light.target.updateMatrixWorld();
    for (const fn of this.onFrame) fn();
    const w = this.width, h = this.height;
    this.renderer.setViewport(0, 0, w, h); this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.render(this.scene, this.activeCamera);
    // the axis triad, bottom left
    const s = 64;
    this.triadCam.quaternion.copy(this.camera.quaternion);
    this.triadCam.position.set(0, 0, 0);
    this.renderer.clearDepth();
    this.renderer.setViewport(6, 6, s, s);
    this.renderer.render(this.triad, this.triadCam);
    this.renderer.setViewport(0, 0, w, h);
  }

  /** Look along `dir` with `up` at the top of the screen. */
  lookAlong(dir: THREE.Vector3, up: THREE.Vector3, animate = true): void {
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir.clone().normalize(), up.clone().normalize());
    const to = new THREE.Quaternion().setFromRotationMatrix(m);
    if (animate && !this.disposed && matchMedia("(prefers-reduced-motion: no-preference)").matches) this.anim = { from: this.camera.quaternion.clone(), to, t0: performance.now(), ms: 220 };
    else { this.anim = null; this.camera.quaternion.copy(to); }
    this.invalidate();
  }

  /**
   * Turn the view by these angles (radians) about the screen's vertical and horizontal axes: the arrows beside a
   * view cube, the arrow keys.
   */
  rotateBy(yaw: number, pitch: number, animate = true): void {
    const from = this.anim ? this.anim.to : this.camera.quaternion;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(from), right = new THREE.Vector3(1, 0, 0).applyQuaternion(from);
    const to = from.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(up, yaw)).premultiply(new THREE.Quaternion().setFromAxisAngle(right, pitch)).normalize();
    if (animate && !this.disposed && matchMedia("(prefers-reduced-motion: no-preference)").matches) this.anim = { from: this.camera.quaternion.clone(), to, t0: performance.now(), ms: 180 };
    else { this.anim = null; this.camera.quaternion.copy(to); }
    this.invalidate();
  }

  setView(view: StandardView, animate = true): void {
    const [d, u] = VIEWS[view];
    this.lookAlong(new THREE.Vector3(...d), new THREE.Vector3(...u), animate);
  }

  /** Zoom and centre so that `box` (default: everything visible in the scene) fills the view. */
  fit(box?: THREE.Box3): void {
    const b = box || this.contentBox();
    if (b.isEmpty()) { b.set(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50)); }
    const sphere = b.getBoundingSphere(new THREE.Sphere());
    this.target.copy(sphere.center);
    const r = Math.max(sphere.radius, 1e-3);
    const fitH = (this.camera.top - this.camera.bottom) / (2 * r), fitW = (this.camera.right - this.camera.left) / (2 * r);
    this.camera.zoom = Math.min(fitH, fitW) * 0.85;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  /** The box of what `fit()` frames: objects flagged `userData.fit`, or nothing. */
  contentBox(): THREE.Box3 {
    const box = new THREE.Box3();
    this.scene.traverseVisible((o) => { if (o.userData.fit) box.expandByObject(o); });
    return box;
  }

  /** The ray under a pointer event, in model space. */
  ray(ev: { clientX: number; clientY: number }): THREE.Ray {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.place();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.activeCamera);
    return rc.ray;
  }

  /** A model-space point in CSS pixels relative to the canvas. */
  project(p: THREE.Vector3): { x: number; y: number } {
    this.place();
    const v = p.clone().project(this.activeCamera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  // ---------------------------------------------------------------- navigation
  private onDown = (ev: PointerEvent): void => {
    const pan = ev.button === 1 || (ev.button === 2 && (ev.shiftKey || ev.ctrlKey));
    if (ev.button !== 2 && !pan) return;
    this.drag = { mode: pan ? "pan" : "orbit", x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    this.canvas.setPointerCapture(ev.pointerId);
    this.anim = null;
    ev.preventDefault();
  };
  private onMove = (ev: PointerEvent): void => {
    const d = this.drag; if (!d || ev.pointerId !== d.id) return;
    const dx = ev.clientX - d.x, dy = ev.clientY - d.y; d.x = ev.clientX; d.y = ev.clientY;
    if (d.mode === "pan") {
      const px = this.pixelSize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      this.target.addScaledVector(right, -dx * px).addScaledVector(up, dy * px);
    } else {
      // a turntable: left-right turns about the model's Z, up-down tilts about the screen's horizontal
      const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -dx * 0.008);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const pitch = new THREE.Quaternion().setFromAxisAngle(right, -dy * 0.008);
      this.camera.quaternion.premultiply(pitch).premultiply(yaw).normalize();
    }
    this.invalidate();
  };
  private onUp = (ev: PointerEvent): void => {
    if (this.drag && ev.pointerId === this.drag.id) { this.drag = null; try { this.canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* not captured */ } }
  };
  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const before = this.anchor(ev);
    const k = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015));
    this.camera.zoom = Math.max(0.02, Math.min(4000, this.camera.zoom * k));
    this.camera.updateProjectionMatrix();
    // keep what was under the pointer under the pointer
    const after = this.anchor(ev);
    this.target.add(before.sub(after));
    this.invalidate();
  };
  /** Where the pointer's ray crosses the plane through the target square to the view (zooming keeps it put). */
  private anchor(ev: { clientX: number; clientY: number }): THREE.Vector3 {
    const r = this.ray(ev), n = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const den = r.direction.dot(n);
    const t = Math.abs(den) < 1e-12 ? 0 : this.target.clone().sub(r.origin).dot(n) / den;
    return r.origin.clone().addScaledVector(r.direction, t);
  }
  /** True while a navigation drag is in progress (the domain's pointer handlers stand down). */
  get navigating(): boolean { return !!this.drag; }
}
