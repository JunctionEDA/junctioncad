// mcp/host.ts — the mechanical domain's tools for an AI assistant (the cad_ tools of the MCP endpoint), as the
// table the headless tool host takes (web/platform/mcp/host.ts).  The catalog entries are mcp/tools.json.
//
// A part studio is opened here exactly as a browser tab opens it: an ItemDocSession on the collaboration socket,
// acting as the person.  An edit is planned from the feature registry (mcp/model.ts), committed through the
// session (so everyone in the document sees it, and it lands in the journal like anyone's edit), and then the
// model is rebuilt by the same regeneration engine the browser's worker runs, on the same OpenCascade build, so
// the assistant is told what the people in the document see: which features failed and why, the bodies, their
// volume.  One kernel serves every document this process has open; each document keeps its own engine (its
// cache of what every feature built).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpToolError, type McpDocEntry, type McpDomainTools, type McpProject, type McpReply, type McpRequest } from "../../../platform/mcp/host";
import type { ItemChange, ItemDoc } from "../../../shared/itemdoc/itemdoc";
import { ItemDocSession } from "../../../shared/itemdoc/sync";
import { BoardFeed } from "../board/feed";
import { PART_STUDIO_KIND, featuresOf, newPartStudioText } from "../document/format";
import { studioInputs } from "../document/inputs";
import { FEATURES, SERVICES, RegenEngine, type Kernel, type RegenResult } from "../kernel/index";
import { loadKernel } from "../kernel/load";
import { applyRecorded, featureTypes, planEdits, treeOf } from "./model";
import { VIEWS, encodePng, renderMeshes, type ViewName } from "./render";

declare const process: any;
declare function require(name: string): any;
const W = globalThis as any;

const DOC_TYPE = "part_studio";

// ---------------------------------------------------------------- the kernel

let kernelLoading: Promise<Kernel> | null = null;
function kernel(): Promise<Kernel> {
  if (!kernelLoading) {
    kernelLoading = (async () => {
      const fs = require("node:fs"), path = require("node:path");
      // beside the Python runtime the server serves (scripts/build-python.mjs puts it there), or where KC_OCC_WASM says
      const dirs = [process.env.KC_OCC_WASM, process.env.KC_PYODIDE_DIR && path.join(process.env.KC_PYODIDE_DIR, "occ-kernel.wasm"), path.join(process.cwd(), "static", "dist", "pyodide", "occ-kernel.wasm")].filter(Boolean) as string[];
      const file = dirs.find((f) => fs.existsSync(f));
      if (!file) throw new McpToolError("The modelling kernel is not installed on this server (occ-kernel.wasm is missing from its runtime folder), so part studios cannot be rebuilt here. The feature list can still be read with cad_get_features.");
      // in Node the kernel's loader reads the file itself, from the path it is told
      return loadKernel({ wasmUrl: path.resolve(file) });
    })();
    kernelLoading.catch(() => { kernelLoading = null; });
  }
  return kernelLoading;
}

// ---------------------------------------------------------------- documents

/** The collaboration socket, saying it is an assistant: the people in the document see who is editing. */
function agentSocket(agent: () => string): typeof WebSocket {
  return class {
    private ws: any;
    onopen: any = null; onclose: any = null; onmessage: any = null; onerror: any = null;
    constructor(url: string) {
      this.ws = new W.WebSocket(url);
      this.ws.onopen = (e: any) => this.onopen && this.onopen(e);
      this.ws.onclose = (e: any) => this.onclose && this.onclose(e);
      this.ws.onmessage = (e: any) => this.onmessage && this.onmessage(e);
      this.ws.onerror = (e: any) => this.onerror && this.onerror(e);
    }
    get readyState(): number { return this.ws.readyState; }
    send(data: string): void {
      if (typeof data === "string" && data.startsWith("{\"type\":\"hello\"")) { const m = JSON.parse(data); m.client = "mcp"; m.agent = agent(); data = JSON.stringify(m); }
      this.ws.send(data);
    }
    close(): void { this.ws.close(); }
  } as unknown as typeof WebSocket;
}

class OpenStudio {
  readonly session: ItemDocSession;
  engine: RegenEngine | null = null;
  lastUsed = Date.now();
  conn: { base: string; token: string; agent: string };
  private loaded: Promise<void>;
  private failed = "";
  /** the boards of the studio's Board features, read over the same socket route (board/feed.ts) */
  private readonly boards: BoardFeed;

  constructor(readonly entry: McpDocEntry, req: McpRequest) {
    this.conn = { base: req.base, token: req.token, agent: req.agent };
    let ok!: () => void;
    this.loaded = new Promise<void>((resolve) => { ok = resolve; });
    this.session = new ItemDocSession({
      docId: entry.docId, signedIn: true, expectKind: PART_STUDIO_KIND,
      onChange: (ids) => { if (ids === null) ok(); },
      onStatus: (s) => { if (s.state === "error") { this.failed = s.text; ok(); } },
      socketUrl: req.base.replace(/^http/, "ws") + "/ws",
      fetchTicket: async () => this.conn.token,
      WebSocketImpl: agentSocket(() => this.conn.agent || "AI assistant"),
    });
    this.session.start();
    this.boards = new BoardFeed({ signedIn: true, changed: () => {}, socket: { socketUrl: req.base.replace(/^http/, "ws") + "/ws", fetchTicket: async () => this.conn.token, WebSocketImpl: agentSocket(() => this.conn.agent || "AI assistant") } });
  }

  async doc(): Promise<ItemDoc> {
    await Promise.race([this.loaded, new Promise((r) => setTimeout(r, 20000))]);
    if (this.failed) throw new McpToolError(`${this.entry.path} could not be opened: ${this.failed}.`);
    if (!this.session.doc) throw new McpToolError(`${this.entry.path} could not be opened in time. Try again.`);
    return this.session.doc;
  }

  /** Rebuild a document (the live one, or a planned one for a dry run) and say what came of it. */
  async regen(doc: ItemDoc): Promise<{ k: Kernel; engine: RegenEngine; result: RegenResult }> {
    const k = await kernel();
    if (!this.engine) this.engine = new RegenEngine(k, FEATURES);
    // as the studio's own page builds it (document/inputs.ts): variables applied, the Board features' boards supplied
    studioInputs(doc, { filters: [this.boards.filter] });   // opens the boards it names
    await this.boards.settled(15000);
    const input = studioInputs(doc, { filters: [this.boards.filter] });
    const result = await this.engine.regenerate(input.features, input.rollback);
    return { k, engine: this.engine, result };
  }

  /** Commit and wait until the server has taken it. */
  async commit(changes: ItemChange[]): Promise<void> {
    if (!this.session.status.canEdit) throw new McpToolError(`This person cannot edit ${this.entry.path}.`);
    if (!this.session.commit(changes, { undoable: false })) return;
    const until = Date.now() + 15000;
    while (this.session.unsaved && Date.now() < until) await new Promise((r) => setTimeout(r, 15));
    if (this.session.unsaved) throw new McpToolError("The edit was made but the server has not confirmed it yet. Read the feature list again before changing more.");
  }

  close(): void { this.session.close(); this.boards.close(); if (this.engine) this.engine.dispose(); this.engine = null; }
}

const open = new Map<string, OpenStudio>();

function needProject(req: McpRequest): McpProject { if (!req.project) throw new McpToolError("This tool needs a project."); return req.project; }
function needWrite(req: McpRequest, p: McpProject): void {
  if (!req.canWrite) throw new McpToolError("This connection was allowed to read only.");
  if (p.role !== "editor") throw new McpToolError(`This person can only view "${p.name}". To change it they need the owner to give them the editor role.`);
}
const baseName = (p: string) => p.split("/").pop() || p;

function findStudio(p: McpProject, name: unknown): McpDocEntry {
  const docs = p.docs.filter((d) => d.docType === DOC_TYPE);
  const listed = () => docs.map((d) => d.path).join(", ") || "(none; cad_create_part_studio makes one)";
  if (typeof name !== "string" || !name.trim()) {
    if (docs.length === 1) return docs[0];
    throw new McpToolError(`Say which part studio: ${listed()}.`);
  }
  const q = name.trim().toLowerCase(), stem = (s: string) => s.replace(/\.jpart$/, "");
  const hit = docs.find((d) => d.path.toLowerCase() === q) || docs.find((d) => d.docId === q) || docs.find((d) => baseName(d.path).toLowerCase() === q)
    || docs.find((d) => stem(baseName(d.path).toLowerCase()) === stem(q));
  if (!hit) throw new McpToolError(`There is no part studio "${name}" in ${p.name}. The part studios are: ${listed()}.`);
  return hit;
}

async function studio(req: McpRequest): Promise<OpenStudio> {
  const entry = findStudio(needProject(req), req.args && req.args.document);
  let s = open.get(entry.docId);
  if (!s) { s = new OpenStudio(entry, req); open.set(entry.docId, s); }
  s.conn = { base: req.base, token: req.token, agent: req.agent }; s.lastUsed = Date.now();
  return s;
}

// ---------------------------------------------------------------- what the kernel says

const round = (v: number, digits = 4): number => { const m = Math.pow(10, digits); return Math.round(v * m) / m; };

function bodiesOf(k: Kernel, engine: RegenEngine, result: RegenResult, names: boolean): any[] {
  const mass = SERVICES.find((s) => s.name === "mass-properties");
  return engine.state.bodies.map((b) => {
    const out: any = { id: b.id, name: b.name, created_by: b.createdBy };
    const mesh = result.bodies.find((x) => x.id === b.id)?.mesh;
    if (mesh) out.bbox_mm = { min: [0, 1, 2].map((i) => round(mesh.bbox[i])), max: [3, 4, 5].map((i) => round(mesh.bbox[i])) };
    if (mass) {
      const mine: { delete(): void }[] = []; k.scope = mine;
      try {
        const m = mass.run({ oc: k.oc, k, state: engine.state, fail: (t) => new Error(t) }, { body: b.id }) as any;
        out.volume_mm3 = round(m.volume, 3); out.area_mm2 = round(m.area, 3); out.centre_of_mass = (m.centre as number[]).map((v) => round(v));
      } catch (e) { out.mass_properties = "not available"; }
      finally { k.scope = null; for (const o of mine.reverse()) { try { o.delete(); } catch (x) { /* gone */ } } }
    }
    out.faces = b.topo.faces.length; out.edges = b.topo.edges.length;
    if (names) { out.face_names = b.topo.faces.map((f) => f.name); out.edge_names = b.topo.edges.map((f) => f.name); }
    return out;
  });
}

function problemsOf(doc: ItemDoc, result: RegenResult): string[] {
  const features = featuresOf(doc);
  return result.features.filter((r) => r.status === "error" || r.status === "warning").map((r) => `${features.find((f) => f.id === r.id)?.name || r.id}: ${r.status === "error" ? "failed" : "note"}: ${r.message || ""}`);
}

async function report(s: OpenStudio, doc: ItemDoc, o: { entities?: boolean; names?: boolean } = {}): Promise<any> {
  let built: Awaited<ReturnType<OpenStudio["regen"]>>;
  try { built = await s.regen(doc); }
  catch (e) { if (!(e instanceof McpToolError)) throw e; return { ...treeOf(doc, null, o), kernel: e.message }; }
  const errors = problemsOf(doc, built.result);
  return { ...treeOf(doc, built.result.features, o), bodies: bodiesOf(built.k, built.engine, built.result, !!o.names), problems: errors.length ? errors : undefined, rebuild_ms: built.result.ms };
}

// ---------------------------------------------------------------- the tools

async function getFeatures(req: McpRequest): Promise<McpReply> {
  const s = await studio(req), doc = await s.doc();
  return { result: { document: s.entry.path, ...(await report(s, doc, { entities: req.args.entities === true })) } };
}

async function getBodies(req: McpRequest): Promise<McpReply> {
  const s = await studio(req), doc = await s.doc();
  const built = await s.regen(doc);
  let bodies = bodiesOf(built.k, built.engine, built.result, req.args.names === true);
  if (typeof req.args.body === "string" && req.args.body) {
    const q = req.args.body.toLowerCase();
    bodies = bodies.filter((b) => b.id === req.args.body || String(b.name).toLowerCase() === q);
    if (!bodies.length) throw new McpToolError(`There is no body "${req.args.body}". The bodies are: ${built.engine.state.bodies.map((b) => `${b.name} (${b.id})`).join(", ") || "(none)"}.`);
  }
  const total = bodies.reduce((n, b) => n + (b.volume_mm3 || 0), 0);
  return { result: { document: s.entry.path, units: "mm", count: bodies.length, total_volume_mm3: round(total, 3), bodies, problems: problemsOf(doc, built.result) } };
}

async function editFeatures(req: McpRequest): Promise<McpReply> {
  const p = needProject(req), s = await studio(req), doc = await s.doc();
  const dry = req.args.dry_run === true;
  if (!dry) needWrite(req, p);
  const plan = planEdits(doc, FEATURES, req.args.edits);
  if (plan.problems.length) throw new McpToolError(`Nothing was changed. ${plan.problems.join("; ")}.`);
  if (dry) {
    const after = await report(s, plan.after);
    return { result: { document: s.entry.path, dry_run: true, would: plan.done, ...after, note: "Nothing was changed. This is the part studio as it would be." } };
  }
  await s.commit(plan.changes);
  const after = await report(s, await s.doc());
  const title = plan.done.length === 1 ? plan.done[0] : `${plan.done.length} edits to ${baseName(s.entry.path)}`;
  const reply: McpReply = { result: { document: s.entry.path, applied: plan.done, ...after } };
  if (plan.changes.length) reply.record = { docId: s.entry.docId, title: title.slice(0, 200), edits: plan.done, undo: { domain: "mechanical", inverse: plan.inverse } };
  return reply;
}

async function undo(req: McpRequest): Promise<McpReply> {
  const p = needProject(req); needWrite(req, p);
  const rec = req.args.__record as { docId: string; title: string; undo: { inverse: ItemChange[] } };
  const entry = p.docs.find((d) => d.docId === rec.docId);
  if (!entry) throw new McpToolError("The document of that change is no longer in the project.");
  req.args.document = entry.docId;
  const s = await studio(req), doc = await s.doc();
  const redo = req.tool === "redo_changes", word = redo ? "redone" : "undone";
  const { applied, inverse } = applyRecorded(doc, rec.undo.inverse || []);
  await s.commit(applied);
  const after = await report(s, await s.doc());
  return { result: { [word]: rec.title, document: entry.path, changes: applied.length, ...after, note: redo ? "undo_changes takes it back again." : "redo_changes puts it back." }, swap: { domain: "mechanical", inverse } };
}

async function renderView(req: McpRequest): Promise<McpReply> {
  const s = await studio(req), doc = await s.doc();
  const built = await s.regen(doc);
  const view = String(req.args.view || "iso").toLowerCase() as ViewName;
  if (!(view in VIEWS)) throw new McpToolError(`view is one of ${Object.keys(VIEWS).join(", ")}.`);
  const width = Math.max(300, Math.min(1600, Number(req.args.width_px) || 900));
  const meshes = built.result.bodies.filter((b) => b.mesh).map((b) => b.mesh!);
  const pic = renderMeshes(meshes, { width, height: Math.round(width * 0.75), view, edges: req.args.edges !== false });
  const png = encodePng(pic);
  const b64 = typeof W.Buffer !== "undefined" ? W.Buffer.from(png).toString("base64") : "";
  return {
    result: { document: s.entry.path, view, image_px: [pic.width, pic.height], bodies: built.result.bodies.map((b) => b.name), problems: problemsOf(doc, built.result),
      note: meshes.length ? "Orthographic, framed on the bodies. The triad in the corner is X red, Y green, Z blue." : "There are no bodies to draw yet." },
    png: b64,
  };
}

async function createStudio(req: McpRequest): Promise<McpReply> {
  const p = needProject(req); needWrite(req, p);
  let name = typeof req.args.name === "string" ? req.args.name.trim().replace(/\.jpart$/i, "") : "";
  if (/[\\/:*?"<>|]/.test(name)) throw new McpToolError("The name cannot contain / \\ : * ? \" < > |.");
  const taken = new Set(p.docs.map((d) => d.path.toLowerCase()));
  if (!name) { for (let n = 1; ; n++) if (!taken.has(`part studio ${n}.jpart`)) { name = `Part Studio ${n}`; break; } }
  const path = `${name}.jpart`;
  if (taken.has(path.toLowerCase())) throw new McpToolError(`${p.name} already has a document called ${path}.`);
  const call = async (url: string, init: any): Promise<any> => {
    const r = await W.fetch(req.base + url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${req.token}` } });
    const text = await r.text(); let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!r.ok) throw new McpToolError((body && body.message) || `The server refused (${r.status}).`);
    return body;
  };
  const made = await call(`/api/projects/${p.projectId}/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
  await call(`/api/docs/${made.docId}/snapshots?seq=0`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: newPartStudioText() });
  return { result: { created: path, document: path, note: "An empty part studio. Add a sketch and an extrude with cad_edit_features." } };
}

export const MECHANICAL_TOOLS: McpDomainTools = {
  domain: "mechanical",
  tools: {
    cad_feature_types: async () => ({ result: featureTypes(FEATURES) }),
    cad_get_features: getFeatures,
    cad_get_bodies: getBodies,
    cad_edit_features: editFeatures,
    cad_render_view: renderView,
    cad_create_part_studio: createStudio,
  },
  undo,
  sweep(idleMs: number): void {
    const now = Date.now();
    for (const [id, s] of open) if (now - s.lastUsed > idleMs) { s.close(); open.delete(id); }
  },
};
