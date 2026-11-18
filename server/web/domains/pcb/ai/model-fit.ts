// ai/model-fit.ts — do the parts' 3D models sit on their pads?
//
// A model is placed by the footprint's angle and side (KiCad's 3D transform), so a footprint written in another frame
// than KiCad's, or a model file drawn turned, shows its pins off the pads.  Each footprint's model is loaded as the 3D
// viewer loads it (the page's model store), and its pins are compared with pin 1 and the pad farthest from pin 1
// (viewer3d/models.ts modelFit).  A model that misses gets the quarter or half turn that lands it, when one does: the
// align_models edit writes it into the footprint's (model (rotate ...)), so the desktop and the web view agree.
import { flattenOcct, footprintModels, modelFit, modelTurn, type ModelMesh, type ModelRef } from "../viewer3d/models";
import { localPads } from "../viewer3d/parts";

declare const require: any;

interface Store { want(r: ModelRef[]): void; settled(): Promise<void>; get(url: string): ModelMesh | "missing" | undefined }

export interface FitRow { id: string; ref: string; model: string; index: number; checked: string[]; off: { pad: string; mm: number }[]; turn: number | null }
export interface FitPlan { checked: number; aligned: number; misaligned: FitRow[]; not_loaded: string[]; note?: string }

/** Every footprint of the board (or only `refs`) with a model: loaded, and checked against its pads. */
export async function planModelFit(doc: KDoc, refs?: string[] | null): Promise<FitPlan> {
  const only = refs && refs.length ? new Set(refs.map(String)) : null;
  const parts: { it: KItem; models: ModelRef[] }[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint" || (only && !only.has(it.ref || ""))) continue;
    const models = footprintModels(it.node, false); if (models.length) parts.push({ it, models });
  }
  const out: FitPlan = { checked: 0, aligned: 0, misaligned: [], not_loaded: [] };
  if (!parts.length) return out;
  const store = await modelSource();
  if (!store) { out.not_loaded = parts.map((p) => p.it.ref || "?"); out.note = "the 3D models could not be loaded here"; return out; }
  store.want(parts.flatMap((p) => p.models)); await store.settled();
  for (const { it, models } of parts) {
    const back = it.layer === "B.Cu"; const pads = localPads(it.node);
    let seen = false;
    models.forEach((ref, index) => {
      const mesh = store.get(ref.url); if (!mesh || mesh === "missing") return;
      seen = true; const fit = modelFit(mesh, ref, back, pads); if (!fit) return;
      out.checked++;
      if (fit.ok) { out.aligned++; return; }
      out.misaligned.push({ id: it.id, ref: it.ref || "?", model: ref.name, index, checked: fit.checked, off: fit.off, turn: modelTurn(mesh, ref, back, pads) });
    });
    if (!seen) out.not_loaded.push(it.ref || "?");
  }
  out.misaligned.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  return out;
}

/**
 * Where the meshes come from: in the browser, the page's model store (the 3D viewer's, so a model is fetched and
 * tessellated once for both); in the headless host (run_python, the MCP tools), the same OpenCascade build
 * (occt-import-js) loaded from the server, and the same model URLs.
 */
async function modelSource(): Promise<Store | null> {
  if (typeof document !== "undefined") {
    const { loadViewer } = await import("../editor/viewer3d-loader");
    const V = await loadViewer() as unknown as { models?(): Store };
    return V.models ? V.models() : null;
  }
  try { return new HeadlessStore(await headlessOcct()); } catch { return null; }
}

let occtLoad: Promise<any> | null = null;
function headlessOcct(): Promise<any> {
  return occtLoad || (occtLoad = (async () => {
    const js = await (await fetch("/static/pyodide/occt-import-js.js")).text();
    const wasm = new Uint8Array(await (await fetch("/static/pyodide/occt-import-js.wasm")).arrayBuffer());
    const mod: any = { exports: {} };
    new Function("module", "exports", "require", "__filename", "__dirname", js)(mod, mod.exports, typeof require === "function" ? require : undefined, "/occt-import-js.js", "/");
    const factory = typeof mod.exports === "function" ? mod.exports : mod.exports.default;
    return factory({ wasmBinary: wasm });
  })().catch((e) => { occtLoad = null; throw e; }));
}

class HeadlessStore implements Store {
  private have = new Map<string, ModelMesh | "missing">();
  private asked: Promise<void>[] = [];
  constructor(private occt: any) {}
  want(refs: ModelRef[]): void {
    for (const r of refs) if (!this.have.has(r.url)) { this.have.set(r.url, "missing"); this.asked.push(this.load(r.url)); }
  }
  async settled(): Promise<void> { await Promise.all(this.asked); }
  get(url: string): ModelMesh | "missing" | undefined { return this.have.get(url); }
  private async load(url: string): Promise<void> {
    try {
      const r = await fetch(url); if (!r.ok) return;
      const bytes = new Uint8Array(await r.arrayBuffer());
      const mesh = flattenOcct(this.occt.ReadStepFile(bytes, { linearUnit: "millimeter", linearDeflectionType: "absolute_value", linearDeflection: 0.05, angularDeflection: 0.5 }));
      if (mesh) this.have.set(url, mesh);
    } catch { /* stays missing */ }
  }
}
