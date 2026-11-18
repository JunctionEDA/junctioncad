// collab.ts — live presence in a 3D document: tells the others where this person is, keeps the list of who else
// is here, draws them (overlay.ts) and follows one of them.
//
// It needs a document session, a viewport and a little of the editor's state (`CollabHost`), so the part studio
// and the assembly use the same one.  What it sends is in presence.ts.
//
//   sending    the camera, the pointer, the selection and what is open, at most twenty times a second and only
//              when something changed; once every ten seconds regardless (the server forgets a silent client)
//   following  the camera eases to the other person's each time theirs moves.  Moving one's own view (or
//              starting to edit) stops it, as in the electronics editor.  When they go to another tab, so does the follower (through the
//              project room, platform/doctabs/roomapi.ts), and the follow carries over to the editor there.
import * as THREE from "three";
import type { DocumentHostContext } from "../../../platform/documents/host";
import { projectRoom, type RoomMember } from "../../../platform/doctabs/roomapi";
import type { ItemDocSession } from "../../../shared/itemdoc/sync";
import type { Viewport3D } from "../../../shared/viewport3d/viewport3d";
import { PeerOverlay, type OverlaySources } from "./overlay";
import { collaboratorsOf, fitPresence, followZoom, packCam, packPoint, sameCam, type CadPresence, type CamState, type Collaborator, type EditState, type SelRef, type V3 } from "./presence";

export interface LocalPresence { sel: SelRef[]; feat: string | null; edit: EditState | null; hit: V3 | null }

export interface CollabHost {
  session: ItemDocSession;
  viewport: Viewport3D;
  ctx: DocumentHostContext;
  /** what this person has selected and open, and the model point under their pointer when it is on the model */
  local(pointer: { clientX: number; clientY: number } | null): LocalPresence;
  /** `fn` is called when `local()` may have changed */
  subscribe(fn: () => void): () => void;
  sources: OverlaySources;
}

export interface CollabState {
  /** everybody else who has this document open */
  people: Collaborator[];
  /** people in the project who are on another tab */
  elsewhere: RoomMember[];
  /** the key of the person being followed */
  follow: string | null;
  /** the people following this person */
  followers: Collaborator[];
  showViews: boolean;
  /** this person's own colour, as the others see it ("" when not known) */
  myColor: string;
}

const GAP_MS = 50, BEAT_MS = 10000, GONE_MS = 5000;
const VIEWS_KEY = "junction.cad.peerViews";

interface FollowMemo { key: string; name: string }
const memo = (): FollowMemo | null => (window as unknown as { JunctionFollow?: FollowMemo }).JunctionFollow || null;
const setMemo = (m: FollowMemo | null): void => { const w = window as unknown as { JunctionFollow?: FollowMemo }; if (m) w.JunctionFollow = m; else delete w.JunctionFollow; };

export class Collab {
  readonly overlay: PeerOverlay;
  private state: CollabState;
  private listeners = new Set<() => void>();
  private disposed = false;
  private offs: (() => void)[] = [];
  private pointer: { clientX: number; clientY: number } | null = null;
  private lastSent = 0;
  private lastJson = "";
  private trailing: ReturnType<typeof setTimeout> | 0 = 0;
  private dirty = false;
  private peersKey = "";
  private followName = "";
  private goneSince = 0;
  private applied: CamState | null = null;
  private easing = 0;
  private switching = false;

  constructor(readonly host: CollabHost) {
    let showViews = true;
    try { showViews = localStorage.getItem(VIEWS_KEY) !== "0"; } catch (e) { /* no storage */ }
    const m = memo();
    this.state = { people: [], elsewhere: [], follow: m ? m.key : null, followers: [], showViews, myColor: "" };
    this.followName = m ? m.name : "";
    if (m) this.goneSince = Date.now();
    this.overlay = new PeerOverlay(host.viewport, host.sources);

    const session = host.session, canvas = host.viewport.canvas;
    const tap = (msg: Record<string, unknown>) => {
      const t = msg.type;
      if (t === "presence" || t === "peer_left" || t === "peer_joined" || t === "doc_info") queueMicrotask(() => this.readPeers());
      // we just (re)joined: say where we are at once, whatever was sent before
      if (t === "doc_info") queueMicrotask(() => { this.lastJson = ""; this.send(true); });
    };
    session.taps.add(tap);
    this.offs.push(() => session.taps.delete(tap));

    const move = (ev: PointerEvent) => { this.pointer = { clientX: ev.clientX, clientY: ev.clientY }; this.touch(); };
    const leave = () => { this.pointer = null; this.touch(); };
    canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerleave", leave);
    this.offs.push(() => { canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerleave", leave); });
    // moving one's own view ends a follow: turning or panning (not the left button, which selects), the wheel,
    // a standard-view button
    const own = (ev: Event) => { if (!this.state.follow) return; if (ev.type === "pointerdown" && (ev as PointerEvent).button === 0) return; this.stopFollowing("Stopped following"); };
    // the view buttons are the viewport's own (an assembly) or the part studio's view cube beside the canvas, which
    // is drawn after this layer starts: both are called .v3-views, wherever in the editor they are
    const views = (ev: Event) => { const t = ev.target as Element | null, v = t && t.closest ? t.closest(".v3-views") : null; if (v && (host.viewport.host.contains(v) || host.viewport.host.parentElement?.contains(v))) own(ev); };
    canvas.addEventListener("pointerdown", own, true); canvas.addEventListener("wheel", own, { capture: true, passive: true }); document.addEventListener("click", views, true);
    this.offs.push(() => { canvas.removeEventListener("pointerdown", own, true); canvas.removeEventListener("wheel", own, true); document.removeEventListener("click", views, true); });

    const frame = () => this.onFrame();
    host.viewport.onFrame.push(frame);
    this.offs.push(() => { const i = host.viewport.onFrame.indexOf(frame); if (i >= 0) host.viewport.onFrame.splice(i, 1); });

    // so does starting to edit: a sketch turns the camera to its plane, and one draws from one's own view
    let editing = !!host.local(null).edit;
    this.offs.push(host.subscribe(() => {
      const now = !!host.local(null).edit;
      if (now && !editing && this.state.follow) this.stopFollowing("Stopped following");
      editing = now;
      this.touch();
    }));
    const room = projectRoom();
    if (room) this.offs.push(room.subscribe(() => this.readPeers()));
    // peers vanish without a message when the socket drops; the heartbeat; a follow whose person never came
    const timer = setInterval(() => { this.readPeers(); if (Date.now() - this.lastSent > BEAT_MS) { this.lastJson = ""; this.send(true); } }, 1500);
    this.offs.push(() => clearInterval(timer));
    this.readPeers();
  }

  getState = (): CollabState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<CollabState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const fn of Array.from(this.listeners)) fn();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.trailing) clearTimeout(this.trailing);
    cancelAnimationFrame(this.easing);
    for (const off of this.offs) off();
    this.overlay.dispose();
    this.listeners.clear();
  }

  /** This person's key: their window, the same on every tab (the project room's), else this session's client. */
  myKey(): string { return projectRoom()?.getState().me?.key || this.host.session.clientId; }

  // ---------------------------------------------------------------- the others
  private readPeers(): void {
    if (this.disposed) return;
    const people = collaboratorsOf(this.host.session.peerList());
    const room = projectRoom()?.getState();
    const here = new Set(people.map((p) => p.key));
    const elsewhere = room ? room.members.filter((m) => !here.has(m.key) && m.tab !== this.host.ctx.doc.docId) : [];
    const mine = this.myKey();
    const followers = people.filter((p) => p.state.fol === mine);
    const myColor = room?.me?.color || "";
    const key = JSON.stringify([people.map((p) => [p.cid, p.key, p.name, p.color, p.state]), elsewhere.map((m) => [m.key, m.tab, m.name, m.color]), myColor]);
    if (key !== this.peersKey) {
      this.peersKey = key;
      this.set({ people, elsewhere, followers, myColor });
      this.draw();
    }
    this.followTick();
  }

  private draw(): void { this.overlay.update(this.state.people, { hideViewOf: this.state.follow, showViews: this.state.showViews }); }

  /** The meshes or sketches the overlay draws selections on changed. */
  sourcesChanged(): void { this.overlay.sourcesChanged(); this.draw(); }

  setShowViews(on: boolean): void {
    try { localStorage.setItem(VIEWS_KEY, on ? "1" : "0"); } catch (e) { /* no storage */ }
    this.set({ showViews: on }); this.draw();
  }

  // ---------------------------------------------------------------- telling the others
  /** Something that is sent may have changed. */
  touch(): void {
    if (this.disposed) return;
    const wait = GAP_MS - (Date.now() - this.lastSent);
    if (wait <= 0) this.send(false);
    else { this.dirty = true; if (!this.trailing) this.trailing = setTimeout(() => { this.trailing = 0; if (this.dirty) this.send(false); }, wait); }
  }

  private camera(): CamState {
    const v = this.host.viewport;
    return packCam(v.camera.quaternion.toArray(), v.target.toArray(), v.camera.zoom, v.width / v.height);
  }

  private presence(): CadPresence {
    const v = this.host.viewport, local = this.host.local(this.pointer);
    const room = projectRoom()?.getState();
    const st: CadPresence = { cad: 1, cam: this.camera(), sel: local.sel, feat: local.feat, edit: local.edit, fol: this.state.follow };
    if (room?.me) { st.key = room.me.key; if (room.me.color) st.col = room.me.color; }
    if (this.pointer && !v.navigating) {
      let p: V3 | null = local.hit;
      if (!p) {
        // not on the model: the point of the pointer's ray nearest the point the camera turns about
        const ray = v.ray(this.pointer);
        const at = ray.origin.clone().addScaledVector(ray.direction, v.target.clone().sub(ray.origin).dot(ray.direction));
        p = [at.x, at.y, at.z];
      }
      st.cur = { p: packPoint(p), hit: !!local.hit };
    } else st.cur = null;
    return fitPresence(st);
  }

  private send(force: boolean): void {
    if (this.disposed) return;
    this.dirty = false;
    const st = this.presence();
    const json = JSON.stringify(st);
    if (!force && json === this.lastJson) return;
    this.lastJson = json; this.lastSent = Date.now();
    this.host.session.setPresence({ ...st, ts: Math.round(performance.now()) } as unknown as Parameters<ItemDocSession["setPresence"]>[0]);
  }

  // ---------------------------------------------------------------- following
  /** Follow this person's view (a key from `people` or `elsewhere`), or stop with null. */
  follow(key: string | null, quiet = false): void {
    if (key === this.state.follow) return;
    const who = key ? this.state.people.find((p) => p.key === key) || this.state.elsewhere.find((m) => m.key === key) : null;
    if (key && !who) return;
    cancelAnimationFrame(this.easing); this.easing = 0;
    this.applied = null; this.goneSince = 0; this.switching = false;
    this.followName = who ? who.name : "";
    setMemo(key && who ? { key, name: who.name } : null);
    if (key && !quiet) this.host.ctx.toast(`Following ${who!.name}. Zoom or pan to stop`, 2600);
    this.set({ follow: key });
    this.draw(); this.touch();
    this.followTick();
  }

  private stopFollowing(why: string): void {
    if (!this.state.follow) return;
    cancelAnimationFrame(this.easing); this.easing = 0;
    this.applied = null; this.goneSince = 0;
    setMemo(null);
    this.set({ follow: null });
    this.draw(); this.touch();
    this.host.ctx.toast(why, 2200);
  }

  /** Where the followed person is now: ease to their camera, go to their tab, or give up when they are gone. */
  private followTick(): void {
    const key = this.state.follow; if (!key || this.disposed || this.switching) return;
    const p = this.state.people.find((x) => x.key === key);
    if (p) {
      this.goneSince = 0; this.followName = p.name;
      if (p.state.cam) this.ease();
      return;
    }
    const m = this.state.elsewhere.find((x) => x.key === key);
    if (m && m.tab && m.tab !== this.host.ctx.doc.docId) {
      // they are on another tab: go there; the editor that opens picks the follow up again (if it can follow)
      const doc = this.host.ctx.docs.find((d) => d.docId === m.tab);
      const hosted = !doc || doc.docType === "part_studio" || doc.docType === "assembly";
      this.switching = true;
      if (!hosted) setMemo(null);
      this.host.ctx.toast(hosted ? `Following ${m.name} to another tab` : `${m.name} went to another tab; following ends there`, 2600);
      this.host.ctx.openDoc(m.tab);
      return;
    }
    // not here and not on another tab.  While this document is still opening, that says nothing yet
    if (this.host.session.status.state !== "live") { this.goneSince = 0; return; }
    if (!this.goneSince) this.goneSince = Date.now();
    else if (Date.now() - this.goneSince > GONE_MS) this.stopFollowing(`Stopped following (${this.followName || "they"} left)`);
  }

  private goal(): CamState | null {
    const p = this.state.people.find((x) => x.key === this.state.follow);
    const cam = p && p.state.cam; if (!cam) return null;
    const v = this.host.viewport;
    return { q: cam.q, t: cam.t, z: followZoom(cam.z, cam.a, v.width / v.height), a: cam.a };
  }

  private ease(): void {
    if (this.easing) return;
    let last = performance.now();
    const step = () => {
      this.easing = 0;
      const g = this.goal(); if (!g || this.disposed) return;
      const v = this.host.viewport, cam = v.camera;
      const q = new THREE.Quaternion(g.q[0], g.q[1], g.q[2], g.q[3]).normalize(), t = new THREE.Vector3(...g.t);
      const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      // by the clock, not by the frame: the view arrives in about a fifth of a second whatever the frame rate
      const now = performance.now(), k = reduced ? 1 : 1 - Math.exp(-(now - last) / 70);
      last = now;
      const near = cam.quaternion.angleTo(q) < 2e-3 && v.target.distanceTo(t) < v.pixelSize() * 0.5 && Math.abs(Math.log(cam.zoom / g.z)) < 2e-3;
      if (near || k === 1) { cam.quaternion.copy(q); v.target.copy(t); cam.zoom = g.z; }
      else { cam.quaternion.slerp(q, k); v.target.lerp(t, k); cam.zoom = Math.exp(Math.log(cam.zoom) + (Math.log(g.z) - Math.log(cam.zoom)) * k); }
      cam.updateProjectionMatrix();
      this.applied = this.camera();
      v.invalidate();
      if (!near && k !== 1) this.easing = requestAnimationFrame(step);
    };
    this.easing = requestAnimationFrame(step);
  }

  /** Before every frame: tell the others when the camera moved, and keep a followed view where it belongs. */
  private onFrame(): void {
    if (this.disposed) return;
    if (this.state.follow && this.applied && !this.easing && !sameCam({ ...this.camera(), a: this.applied.a }, this.applied)) {
      // the editor moved the camera itself (it frames a model that has just arrived): back to their view
      this.ease();
    }
    this.touch();
  }
}
