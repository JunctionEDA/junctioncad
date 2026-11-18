// compare/index.tsx — two versions of a part studio in the Compare window (web/platform/review): the renderer
// the mechanical domain registers for its documents.
//
// On the left, what changed feature by feature (compare/diff.ts): added, removed and modified features, and for
// a modified one the parameters before and after.  On the right, the two parts in one viewport: what both
// versions have in the body colour, material the newer version added in the "added" colour and material it
// removed in the "removed" colour.  The slider goes from the older version to the newer: at the left end the
// part as it was (with what will go marked), at the right end the part as it is (with what came marked), in
// between both fade.  The solids are compared in the modelling worker (services/compare-versions.ts) by a kernel
// of its own, so the part studio that is open underneath is not disturbed.
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { registerCompareRenderer, type CompareContext } from "../../../platform/review/renderers";
import { parseItemDoc, type ItemDoc, type Json } from "../../../shared/itemdoc/itemdoc";
import { Viewport3D, tokenColor } from "../../../shared/viewport3d/viewport3d";
import { BoardFeed } from "../board/feed";
import { PART_STUDIO_KIND } from "../document/format";
import { studioInputs } from "../document/inputs";
import { FEATURES } from "../generated/page";
import { KernelClient } from "../kernel/client";
import type { CompareResult, PlainMesh } from "../services/compare-versions";
import { countsText, diffStudios, type Category, type FeatureChange, type StudioDiff } from "./diff";

const CATS: Category[] = ["added", "removed", "modified"];
const CAT_NAME: Record<Category, string> = { added: "Added", removed: "Removed", modified: "Modified" };
const cx = (...c: (string | false | null | undefined)[]): string => c.filter(Boolean).join(" ");
const mm3 = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(2)} cm³` : `${v.toFixed(v < 10 ? 2 : 1)} mm³`);

type Part = "common" | "added" | "removed";

/** The three solids in a viewport, with the slider's fade. */
class DiffScene {
  readonly viewport: Viewport3D;
  private groups: Partial<Record<Part, { mesh: THREE.Mesh; edges: THREE.LineSegments }>> = {};
  private t = 0.5; private marked = true; private fitted = false;
  constructor(host: HTMLElement) {
    this.viewport = new Viewport3D(host);
    this.viewport.onTheme.push(() => this.paint());
  }
  set(result: CompareResult): void {
    for (const g of Object.values(this.groups)) { if (!g) continue; this.viewport.scene.remove(g.mesh, g.edges); g.mesh.geometry.dispose(); g.edges.geometry.dispose(); }
    this.groups = {};
    const add = (part: Part, m: PlainMesh | null) => {
      if (!m) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
      g.setIndex(new THREE.BufferAttribute(m.indices, 1));
      // the changed solids sit exactly on the faces of the common one: they win the depth test
      const offset = part === "common" ? 2 : 1;
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide, transparent: true, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset }));
      mesh.userData.fit = true; mesh.renderOrder = part === "common" ? 0 : 1;
      const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.BufferAttribute(m.edges, 3));
      const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ transparent: true }));
      this.viewport.scene.add(mesh, edges);
      this.groups[part] = { mesh, edges };
    };
    add("common", result.common); add("added", result.added); add("removed", result.removed);
    this.paint();
    if (!this.fitted && Object.keys(this.groups).length) { this.fitted = true; this.viewport.fit(); }
  }
  /** `t` runs from the older version (0) to the newer (1); `marked` colours what changed. */
  show(t: number, marked: boolean): void { this.t = t; this.marked = marked; this.paint(); }
  private paint(): void {
    const body = tokenColor("--ink-3").lerp(tokenColor("--paper"), 0.55), edge = tokenColor("--ink");
    const colors: Record<Part, THREE.Color> = { common: body, added: this.marked ? tokenColor("--wire") : body, removed: this.marked ? tokenColor("--err") : body };
    const opacity: Record<Part, number> = { common: 1, added: Math.min(1, this.t * 2), removed: Math.min(1, (1 - this.t) * 2) };
    for (const part of ["common", "added", "removed"] as Part[]) {
      const g = this.groups[part]; if (!g) continue;
      const m = g.mesh.material as THREE.MeshStandardMaterial, o = opacity[part];
      m.color.copy(colors[part]); m.opacity = o; m.depthWrite = o > 0.98; g.mesh.visible = o > 0.01;
      const e = g.edges.material as THREE.LineBasicMaterial;
      e.color.copy(edge); e.opacity = o; g.edges.visible = o > 0.01;
    }
    this.viewport.invalidate();
  }
  dispose(): void { this.viewport.dispose(); }
}

function read(text: string): ItemDoc | null { try { return parseItemDoc(text, PART_STUDIO_KIND); } catch (e) { return null; } }

function StudioCompare({ ctx }: { ctx: CompareContext }) {
  const a = useMemo(() => read(ctx.a.text), [ctx.a.text]), b = useMemo(() => read(ctx.b.text), [ctx.b.text]);
  const diff: StudioDiff | null = useMemo(() => (a && b ? diffStudios(a, b, FEATURES) : null), [a, b]);
  const [selected, setSelected] = useState<FeatureChange | null>(null);
  const [show, setShow] = useState<Record<Category, boolean>>({ added: true, removed: true, modified: true });
  const [t, setT] = useState(50);
  const [marked, setMarked] = useState(true);
  const [solid, setSolid] = useState<CompareResult | null>(null);
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [message, setMessage] = useState("");
  const stage = useRef<HTMLDivElement>(null);
  const scene = useRef<DiffScene | null>(null);

  useEffect(() => {
    const host = stage.current; if (!host) return;
    const s = new DiffScene(host); scene.current = s;
    return () => { scene.current = null; s.dispose(); };
  }, []);

  // ---- build both versions and compare them, in a worker of this window's own
  useEffect(() => {
    if (!a || !b) { setState("failed"); setMessage("One of the two versions is not a part studio this editor can read."); return; }
    let gone = false;
    const kernel = new KernelClient();
    setState("working"); setMessage("");
    // Each version as its own page would build it (document/inputs.ts): its variables applied, and the boards
    // of its Board features supplied.  A board is not stored with a version: both sides get it as it is now.
    const feeds = [new BoardFeed({ signedIn: true, changed: () => {} }), new BoardFeed({ signedIn: true, changed: () => {} })];
    const side = (doc: ItemDoc, i: number) => studioInputs(doc, { filters: [feeds[i].filter] });
    side(a, 0); side(b, 1);   // opens the boards the two versions name
    Promise.all(feeds.map((f) => f.settled())).then(() => kernel.call("compare-versions", { a: side(a, 0), b: side(b, 1) } as unknown as Json)).then((r) => {
      if (gone) return;
      const result = r as unknown as CompareResult;
      setSolid(result); setState("done");
      scene.current?.set(result);
    }).catch((e) => { if (!gone) { setState("failed"); setMessage(e instanceof Error ? e.message : String(e)); } });
    return () => { gone = true; kernel.dispose(); for (const f of feeds) f.close(); };
  }, [a, b]);
  useEffect(() => { scene.current?.show(t / 100, marked); }, [t, marked, solid]);

  // ---- the line in the window's footer
  useEffect(() => {
    if (!diff) return;
    const parts: string[] = [diff.changes.length ? `${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"}: ${countsText(diff)}` : "No feature differs"];
    if (solid) parts.push(solid.volumes.added || solid.volumes.removed ? `${mm3(solid.volumes.added)} of material added, ${mm3(solid.volumes.removed)} removed` : "the solids are the same");
    ctx.setSummary(parts.join(" · ") + ".");
  }, [diff, solid, ctx]);

  const failures = (side: "a" | "b"): number => (solid ? solid[side].reports.filter((r) => r.status === "error").length : 0);
  return (
    <>
      <aside className="rv-side" data-cad-compare>
        <div className="rv-cats">
          {CATS.map((c) => (
            <label key={c} className={cx("rv-cat", c)}><input type="checkbox" checked={show[c]} onChange={(ev) => setShow((s) => ({ ...s, [c]: ev.target.checked }))} /><i />{CAT_NAME[c]}<b>{diff ? diff.counts[c] : 0}</b></label>
          ))}
        </div>
        <div className="rv-tree" role="tree" aria-label="Changed features">
          {diff ? CATS.map((cat) => {
            const list = diff.changes.filter((c) => c.category === cat);
            if (!list.length || !show[cat]) return null;
            return (
              <div key={cat} className="rv-group">
                <div className={cx("rv-group-title", cat)}><i />{CAT_NAME[cat]} <span>{list.length}</span></div>
                {list.map((c) => (
                  <div key={c.key} role="treeitem" aria-selected={selected?.key === c.key} className={cx("rv-row", cat, selected?.key === c.key && "sel")} data-key={c.key} data-change={c.category} onClick={() => setSelected(selected?.key === c.key ? null : c)}>
                    <div className="rv-row-text"><span className="rv-label" title={c.label}>{c.label}</span><span className="rv-detail" title={c.detail}>{c.detail}</span></div>
                  </div>
                ))}
              </div>
            );
          }) : null}
          {diff && !diff.changes.length ? <p className="note rv-empty px-2">No feature differs between the two versions.</p> : null}
        </div>
      </aside>
      <section className="rv-view">
        <div className="rv-bar">
          <span className="text-ink-2 truncate max-w-48" title={ctx.a.label}>{ctx.a.label}</span>
          <input type="range" min={0} max={100} value={t} onChange={(ev) => setT(Number(ev.target.value))} className="flex-1 min-w-24" aria-label="From the older version to the newer" data-compare-slider />
          <span className="text-ink-2 truncate max-w-48" title={ctx.b.label}>{ctx.b.label}</span>
          <div className="seg" role="group" aria-label="Show">
            <button type="button" className={cx(t === 0 && "on")} data-compare-show="before" onClick={() => setT(0)}>Before</button>
            <button type="button" className={cx(t === 50 && "on")} data-compare-show="both" onClick={() => setT(50)}>Both</button>
            <button type="button" className={cx(t === 100 && "on")} data-compare-show="after" onClick={() => setT(100)}>After</button>
          </div>
          <label className="rv-check"><input type="checkbox" checked={marked} onChange={(ev) => setMarked(ev.target.checked)} />Colour changes</label>
        </div>
        <div className="rv-stage" style={{ background: "var(--paper)" }} data-compare-state={state}>
          <div ref={stage} style={{ position: "absolute", inset: 0 }} />
          {state === "done" && solid ? (
            <div className="absolute left-2 bottom-2 z-[2] flex flex-col gap-0.5 px-2 py-1 rounded-sm border border-line bg-panel text-xs pointer-events-none" data-compare-legend>
              <span><i className="inline-block w-2.5 h-2.5 mr-1.5 align-middle bg-wire" />Added {mm3(solid.volumes.added)}</span>
              <span><i className="inline-block w-2.5 h-2.5 mr-1.5 align-middle bg-err" />Removed {mm3(solid.volumes.removed)}</span>
              <span className="text-ink-2">{mm3(solid.a.volume)} before, {mm3(solid.b.volume)} after</span>
              {failures("a") || failures("b") ? <span className="text-warn">{failures("a") ? `${failures("a")} feature${failures("a") === 1 ? "" : "s"} failed before. ` : ""}{failures("b") ? `${failures("b")} failed after.` : ""}</span> : null}
            </div>
          ) : null}
          {state === "working" ? <div className="rv-hint"><span className="spinner" /> Building both versions…</div> : null}
          {state === "failed" ? <div className="rv-hint">{message || "The solids could not be compared."}</div> : null}
        </div>
        <div className="rv-props">
          {selected ? (
            selected.props.length ? (
              <table>
                <thead><tr><th>{selected.label}</th><th>Before</th><th>After</th></tr></thead>
                <tbody>{selected.props.map((p, i) => <tr key={i}><td>{p.name}</td><td className="before" title={p.before}>{p.before}</td><td className="after" title={p.after}>{p.after}</td></tr>)}</tbody>
              </table>
            ) : <p className="note">{selected.label}: {CAT_NAME[selected.category].toLowerCase()} ({selected.detail}).</p>
          ) : <p className="note">{diff && diff.changes.length ? "Select a feature to see what changed in it." : ""}</p>}
        </div>
      </section>
    </>
  );
}

registerCompareRenderer({
  docTypes: ["part_studio"],
  mount(ctx) {
    const root = createRoot(ctx.el);
    root.render(<StudioCompare ctx={ctx} />);
    return { close() { root.unmount(); } };
  },
});
