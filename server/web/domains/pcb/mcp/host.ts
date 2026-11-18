// mcp/host — the headless editor behind the MCP endpoint (src/mcp.rs).
//
// The design assistant's tools (web/domains/pcb/ai) read and change a design through the editor that has it
// open: the parsed document, the schematic and board tool modules, the autorouter, and the commit
// path that turns a change into an op.  None of that exists on the server, which never parses a
// KiCad file.  So the server starts this program (Node, one per person who is using the endpoint)
// and hands it each tool call.  It opens the document the call names exactly as a browser tab
// would, over the collaboration socket, and stands in for the editor: the same modules run against
// the same live document, and an edit leaves as the same op, so it shows up at once for everyone
// in the document.
//
// Wire format, one JSON object per line.  In: { id, base, token, agent, canWrite, user, tool,
// project, args }.  Out: { id, ok: true, result, record?, svg? } or { id, ok: false, error }.
// Calls are run one at a time: the modules keep the open editor in a global.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { foldOps } from "./compact";
import { fullPath, pcbOfDoc, pcbsOf, relativePath, scopedDocs, type Pcb } from "../../../platform/doctabs/pcbs";
import "./env";
import "../canvas/index";
import "../../../../static/sch-tools.js";
import "../../../../static/pcb-tools.js";
import "../router/index";
import "../fab/index";
import * as design from "../ai/design";
import { ToolError } from "../ai/design";
import { textFaces } from "../fonts-used";
import { checkLayout } from "../ai/layout";
import { reviewDesign } from "../ai/review";
import * as library from "../ai/library";
import { buildProposal, staleReason, writeRules } from "../ai/proposals";
import { planFixes } from "./fixes";
import { eng, findVector, plotOf, runSpice, summarize, type SimRun, type Vector } from "./simulate";
import * as NK from "../sim/netlist-kicad";
import * as SP from "../sim/spice-netlist";
import * as SM from "../dialogs/sim-model-logic";
import { NGSPICE } from "../dialogs/sim-model-ngspice";
import { builtinLibrary } from "../sim/builtin-libs";
import { diffDocs } from "../../../platform/review/diff";
import { getBom } from "./bom";
import { buildPackage, packageZip } from "../fab/index";
import { renderPicture, type Emphasis } from "./picture";
import { findPerson, highlight, people, resolveTargets, settle, traceNet } from "./teammate";
import { topLevelSheetsOf } from "../editor/bootpick";
import { DocSession, editProjectFile, readTextDocument, type Conn, type DocEntry, type UndoRecord } from "./session";
import { McpToolError } from "../../../platform/mcp/host";
import { DOMAIN_TOOLS } from "../../mcp-tools";

declare const process: any;
declare function require(name: string): any;

const W = globalThis as any;
const K = (): any => W.KiCadCanvas;

interface Project { projectId: string; name: string; role: string; docs: DocEntry[] }
interface Request { id: number; base: string; token: string; agent: string; canWrite: boolean; user: { id: number; login: string; name: string }; tool: string; project: Project | null; args: any }
interface Reply { result: unknown; record?: unknown; records?: unknown[]; swap?: unknown; svg?: string; svgs?: string[] }

const SESSION_IDLE_MS = 5 * 60 * 1000, PROCESS_IDLE_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------- the server, as the person

let conn: Conn = { base: "", token: "", agent: "" };
const realFetch = W.fetch.bind(W);
/** The shared modules fetch site-relative URLs with the browser's cookie; here they go to the server with the person's token. */
W.fetch = (input: any, init?: any) => {
  if (typeof input === "string" && input.startsWith("/")) {
    const headers = new W.Headers((init && init.headers) || {}); headers.set("authorization", `Bearer ${conn.token}`);
    return scopedFetch(conn.base + input, input, Object.assign({}, init, { headers, credentials: undefined }));
  }
  return realFetch(input, init);
};

/**
 * The folder of the PCB the running tool call works on ("" at the project's root, or none), and the project
 * (scopeToPcb).  The shared modules name the files they make as the PCB's own editor sees them; as in the browser
 * (editor/pcbscope.ts), the two requests that carry such a path get the folder put in front on the way out and
 * taken off the answer.
 */
let scope: { projectId: string; dir: string } | null = null;
async function scopedFetch(url: string, path: string, init: any): Promise<any> {
  const sc = scope, method = String((init && init.method) || "GET").toUpperCase();
  const at = path.split("?")[0].replace(/\/$/, "");
  const names = !!sc && !!sc.dir && typeof init.body === "string" && ((method === "POST" && at === `/api/projects/${sc.projectId}/docs`) || (method === "PATCH" && /^\/api\/docs\/[0-9a-f-]{36}$/i.test(at)));
  if (!names) return realFetch(url, init);
  let body: any; try { body = JSON.parse(init.body); } catch { return realFetch(url, init); }
  if (!body || typeof body.path !== "string") return realFetch(url, init);
  const full = fullPath(sc!.dir, body.path);
  if (full === null) return new W.Response("that path is outside the project", { status: 400 });
  const r = await realFetch(url, Object.assign({}, init, { body: JSON.stringify(Object.assign({}, body, { path: full })) }));
  if (!r.ok) return r;
  let answer: any; try { answer = await r.clone().json(); } catch { return r; }
  if (!answer || typeof answer.path !== "string") return r;
  return new W.Response(JSON.stringify(Object.assign({}, answer, { path: relativePath(sc!.dir, answer.path) })), { status: r.status, headers: { "content-type": "application/json" } });
}

async function api(path: string, init?: any): Promise<any> {
  let r: any;
  try { r = await W.fetch(path, init); } catch { throw new ToolError("The server could not be reached."); }
  const text = await r.text(); let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new ToolError((body && body.message) || `The server refused the request (${r.status}).`);
  return body;
}
const post = (path: string, body: unknown, method = "POST") => api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---------------------------------------------------------------- fonts

let fontProject = "";
/** The font files of a document's text, from the project, for the zone filler (web/domains/pcb/fab/outline-font.ts). */
K().loadFontsFor = async (doc: unknown): Promise<void> => {
  const pid = fontProject; if (!pid) return;
  await Promise.all(textFaces(doc).filter(([face, bold, italic]) => !K().fontData(face, bold, italic)).map(async ([face, bold, italic]) => {
    try {
      const r = await W.fetch(`/api/projects/${pid}/fonts/file?family=${encodeURIComponent(face)}&bold=${bold ? 1 : 0}&italic=${italic ? 1 : 0}`);
      if (!r.ok || fontProject !== pid) return;
      K().setFontData(face, bold, italic, { data: await r.arrayBuffer(), bold: r.headers.get("x-font-bold") === "1", italic: r.headers.get("x-font-italic") === "1" });
    } catch { /* the text is then treated as stroke-font text */ }
  }));
};
/** Another project's uploaded fonts must not answer for this one's under the same names. */
function useFontProject(id: string): void { if (id !== fontProject) { fontProject = id; K().fontChanged(); } }

// ---------------------------------------------------------------- documents

const sessions = new Map<string, DocSession>();
function session(entry: DocEntry): DocSession {
  let s = sessions.get(entry.docId);
  if (!s) { s = new DocSession(entry, conn); sessions.set(entry.docId, s); }
  s.touch(conn); return s;
}

const baseName = (p: string) => p.split("/").pop() || p;
const drawable = (d: DocEntry) => d.docType === "kicad_sch" || d.docType === "kicad_pcb";
const depth = (p: string) => p.split("/").length;

/** The sheet KiCad opens first: the one named after the project file, else the shallowest. */
function rootSchematic(p: Project): DocEntry | null {
  const sch = p.docs.filter((d) => d.docType === "kicad_sch"); if (!sch.length) return null;
  const pro = p.docs.find((d) => d.docType === "kicad_pro");
  const want = pro ? pro.path.replace(/\.kicad_pro$/, ".kicad_sch") : "";
  return sch.find((d) => d.path === want) || sch.slice().sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))[0];
}

function findDocument(p: Project, name: unknown): DocEntry {
  const docs = p.docs.filter(drawable);
  const listed = () => docs.map((d) => d.path).join(", ") || "(none)";
  if (typeof name !== "string" || !name.trim()) throw new ToolError(`Say which document: ${listed()}.`);
  const q = name.trim().toLowerCase(); const stem = (s: string) => s.replace(/\.kicad_(sch|pcb)$/, "");
  const hit = docs.find((d) => d.path.toLowerCase() === q) || docs.find((d) => d.docId === q)
    || docs.find((d) => baseName(d.path).toLowerCase() === q)
    || (/^(board|pcb|the board)$/.test(q) ? docs.find((d) => d.docType === "kicad_pcb") : undefined)
    || (/^(schematic|sch|root|the schematic)$/.test(q) ? rootSchematic(p) || undefined : undefined)
    || (() => { const m = docs.filter((d) => stem(baseName(d.path).toLowerCase()) === stem(q)); return m.length === 1 ? m[0] : undefined; })();
  if (!hit) throw new ToolError(`There is no document "${name}" in ${p.name}. The documents are: ${listed()}.`);
  return hit;
}

const proCache = new Map<string, { at: number; text: string }>();
/** The project file as it stands (design rules, net classes, text variables); null when the project has none. */
async function projectFile(p: Project, fresh = false): Promise<string | null> {
  const pro = p.docs.find((d) => d.docType === "kicad_pro"); if (!pro) return null;
  const hit = proCache.get(pro.docId); if (hit && !fresh && Date.now() - hit.at < 4000) return hit.text;
  try { const text = await readTextDocument(conn, pro.docId); proCache.set(pro.docId, { at: Date.now(), text }); return text; }
  catch (e) { console.warn("mcp host: project file not read", e); return hit ? hit.text : null; }
}

/** What the drawing sheet and the text variables need to know about where a document sits in its project. */
function sheetContext(doc: any, entry: DocEntry, p: Project, pro: string | null): void {
  doc.fileName = baseName(entry.path); doc.filePath = entry.path; doc.projectName = p.name;
  try { const v = pro ? JSON.parse(pro).text_variables : null; doc.projectVars = v && typeof v === "object" && Object.keys(v).length ? v : null; } catch { doc.projectVars = null; }
  if (doc.type !== "sch") { doc.sheetName = ""; doc.sheetPath = ""; doc.sheetCount = 1; return; }
  doc.sheetCount = p.docs.filter((d) => d.docType === "kicad_sch").length || 1;
  // several top-level sheets (SCHEMATIC::GetTopLevelSheets): each is named by the project file, and in its path
  let tops: { doc: DocEntry; name: string }[] = [];
  try { tops = topLevelSheetsOf(pro ? JSON.parse(pro) : null, p.docs, p.docs); } catch { tops = []; }
  const top = tops.length > 1 ? tops.find((t) => t.doc.docId === entry.docId) : undefined;
  const root = rootSchematic(p);
  if (top) { doc.sheetName = top.name; doc.sheetPath = "/" + top.name + "/"; }
  else if (root && root.docId === entry.docId) { doc.sheetName = "Root"; doc.sheetPath = "/"; }
  else { doc.sheetName = baseName(entry.path).replace(/\.kicad_sch$/, ""); doc.sheetPath = "/" + doc.sheetName + "/"; }
}

/** The object the shared modules know as the editor (window.CollabEditor), for one document of one project. */
function editorFor(req: Request, p: Project, sess: DocSession | null, pro: string | null): any {
  const tabs = p.docs.filter(drawable);
  const viewOnly = !req.canWrite || p.role !== "editor" || (!!sess && sess.role !== "editor");
  const state = { project: { projectId: p.projectId, name: p.name, docs: p.docs }, docs: tabs, doc: sess ? sess.entry : null, docId: sess ? sess.entry.docId : null, role: p.role, me: req.user };
  const nothing = () => undefined;
  return { kdoc: sess ? sess.kdoc : null, IU: sess ? sess.IU : 1e6, proSettings: pro, viewOnly, selection: new Set<string>(), selected: null, zoom: 1,
    api: { state, toolCtx: () => ({ setHighlight: nothing, setSelection: nothing }), applyView: nothing, requestRender: nothing } };
}

/** Run `fn` with a document open as the editor's, the way the assistant's tools expect to find it. */
async function withDocument<T>(req: Request, name: unknown, fn: (sess: DocSession, doc: any, ed: any) => T | Promise<T>): Promise<T> {
  const p = needProject(req); const entry = findDocument(p, name); const sess = session(entry);
  const pro = await projectFile(p); const doc = await sess.current();
  sheetContext(doc, entry, p, pro);
  // a board text set in a font is written with its outlines, as pcbnew stores them: the font files have to be here
  if (doc && doc.type === "pcb" && req.canWrite) { try { await K().loadFontsFor(doc); } catch { /* written without outlines */ } }
  const ed = editorFor(req, p, sess, pro); W.CollabEditor = ed;
  try { return await fn(sess, doc, ed); } finally { W.CollabEditor = null; }
}

/** The shared modules word their errors for the in-app assistant (a proposal card, "the open document"); here there is neither. */
function plain(message: string): string {
  return message.replace(/^No proposal was shown, because/, "Nothing was applied, because").replace(/\bfor one proposal; split it into steps a person can review/, "for one call; split it into several")
    .replace(/\bsplit the proposal\b/g, "split the call").replace(/\bon the open document\b/g, "in this document").replace(/\bthe proposal\b/g, "the change").replace(/\bproposal\b/g, "change");
}
function needProject(req: Request): Project { if (!req.project) throw new ToolError("This tool needs a project."); return req.project; }
const without = (args: any, ...keys: string[]) => { const o = Object.assign({}, args); for (const k of ["project", "document", ...keys]) delete o[k]; return o; };
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- changes

function needWrite(req: Request, p: Project): void {
  if (!req.canWrite) throw new ToolError("This connection was allowed to read only. Reconnect it and tick \"Let it make changes\" to edit.");
  if (p.role !== "editor") throw new ToolError(`You have view-only access to ${p.name}.`);
}

const RULE_PATHS = ["min_track_width", "min_clearance", "min_copper_edge_clearance", "min_hole_clearance", "min_text_height"];
/** The parts of the project file a set_rules edit writes, as they were, so the edit can be taken back. */
function rulesBefore(text: string): { classes: unknown; rules: Record<string, unknown> } {
  const pro = JSON.parse(text); const rules: Record<string, unknown> = {};
  const now = (((pro.board || {}).design_settings || {}).rules || {}) as Record<string, unknown>;
  const defaults = (K().projectFile && K().projectFile.RULE_DEFAULTS) || {};
  for (const k of RULE_PATHS) rules[k] = now[k] !== undefined ? now[k] : defaults[k];
  return { classes: JSON.parse(JSON.stringify(((pro.net_settings || {}).classes) || [])), rules };
}
function restoreRules(pro: any, was: { classes: unknown; rules: Record<string, unknown> }): void {
  const ns = pro.net_settings = pro.net_settings || { classes: [], meta: { version: 0 } }; ns.classes = was.classes;
  const board = pro.board = pro.board || {}; const ds = board.design_settings = board.design_settings || {}; const rules = ds.rules = ds.rules || {};
  for (const [k, v] of Object.entries(was.rules)) if (v !== undefined) rules[k] = v;
}

async function applyChanges(req: Request, live = false, stage?: (sess: DocSession) => void): Promise<Reply> {
  const p = needProject(req); const args = req.args || {};
  return withDocument(req, args.document, async (sess, _doc, ed) => {
    const prop = await buildProposal({ title: args.title, rationale: args.rationale, edits: args.edits });
    const summary: any = { document: prop.docPath, edits: prop.lines.map((l) => l.text), details: prop.details,
      connectivity: !prop.connectivity ? undefined : prop.connectivity.length
        ? { changed: prop.connectivity, note: "These pins are connected differently by the change. If that is not what it is for (a tidy-up must not change connections), undo it and apply a corrected version." }
        : prop.lines.some((l) => /^Add /.test(l.text)) ? "the pins that were there before are on the same nets as before; list_nets shows how the new parts are connected"
        : "unchanged: every pin is on the same net as before" };
    if (args.dry_run) return { result: Object.assign({ applied: false, note: "Dry run: nothing was changed. Call again without dry_run to apply." }, summary) };
    needWrite(req, p);
    if (ed.viewOnly) throw new ToolError(`You have view-only access to ${p.name}.`);
    const stale = staleReason(prop); if (stale) throw new ToolError(stale);
    if (args.propose === true) {
      if (stage) throw new ToolError("A script's edits are applied as it runs; propose changes with apply_changes and propose: true.");
      return { result: Object.assign(await park(req, sess, _doc, prop), summary) };
    }

    let rules: unknown; const pro = p.docs.find((d) => d.docType === "kicad_pro");
    if (prop.rules) {
      if (!pro) throw new ToolError("This project has no .kicad_pro file, so its board rules cannot be changed.");
      const text = await projectFile(p, true); if (!text) throw new ToolError("The project file could not be read.");
      rules = rulesBefore(text); const r = prop.rules;
      const saved = await editProjectFile(conn, pro.docId, (j) => writeRules(j, r), "board rules");
      proCache.set(pro.docId, { at: Date.now(), text: saved.text });
    }
    let undo: UndoRecord = { inverse: [], after: {} };
    if (stage && prop.changes.length) {
      // planned, not yet drawn: the script reads and measures its plan here, and the watchers see it drawn when it is done
      // (the board setup is a document header, not a drawing, and is sent at once)
      const setup = prop.changes.filter((c: any) => c.typeName === "BOARD_SETUP"), rest = prop.changes.filter((c: any) => c.typeName !== "BOARD_SETUP");
      if (setup.length) {
        undo = await sess.commit(setup);
      }
      stage(sess);
      const added = rest.length ? sess.stageApply(rest) : [];
      return { result: Object.assign({ applied: true, changes: prop.changes.length, staged: true, added, board_rules: rules ? "written to the project file" : undefined }, summary),
        record: setup.length || rules ? { docId: sess.entry.docId, title: prop.title, edits: summary.edits, undo: Object.assign({}, undo, rules ? { rules } : {}) } : undefined };
    }
    if (prop.changes.length) {
      try { undo = await sess.commit(prop.changes, live); }
      catch (e) { if (rules) throw new ToolError(`${e instanceof Error ? e.message : String(e)} The board rules of this change were saved; the other edits were not applied.`); throw e; }
    }
    return { result: Object.assign({ applied: true, changes: prop.changes.length, board_rules: rules ? "written to the project file" : undefined }, summary),
      record: { docId: sess.entry.docId, title: prop.title, edits: summary.edits, undo: Object.assign({}, undo, rules ? { rules } : {}) } };
  });
}

// ---------------------------------------------------------------- proposals: changes a person accepts

/**
 * Where a planned change lands, for an editor that cannot draw it itself (the desktop app draws these over the
 * canvas): one box per touched item in mm with its kind, and new tracks and wires as line segments.
 */
function previewOf(sess: DocSession, doc: any, changes: any[]): { boxes: (number | string)[][]; segs: number[][] } {
  const k = K(); const boxes: (number | string)[][] = [], segs: number[][] = []; const r = (v: number) => Math.round(v * 1e4) / 1e4;
  const scratch = Object.assign({}, doc, { items: new Map() });
  for (const c of changes) if (c.kind !== "REMOVED") { try { k.applyChange(scratch, c, sess.IU); } catch { /* not drawn */ } }
  for (const c of changes) {
    const now = doc.items.get(c.id), next: any = scratch.items.get(c.id);
    const b = c.kind === "REMOVED" ? now && now.bbox : (next && next.bbox) || (now && now.bbox);
    if (b && boxes.length < 200) boxes.push([r(b[0]), r(b[1]), r(b[2]), r(b[3]), c.kind === "REMOVED" ? "remove" : c.kind === "ADDED" ? "add" : "modify"]);
    if (c.kind !== "ADDED" || !next || segs.length >= 600) continue;
    try {
      if (next.kind === "wire" || next.kind === "bus") { const pts = k.ptsOf(next.node); for (let i = 1; i < pts.length; i++) segs.push([r(pts[i - 1][0]), r(pts[i - 1][1]), r(pts[i][0]), r(pts[i][1]), 0.15]); }
      else if (next.kind === "segment") { const a = k.kid(next.node, "start"), e = k.kid(next.node, "end"), w = k.kid(next.node, "width"); if (a && e) segs.push([r(k.num(a[1])), r(k.num(a[2])), r(k.num(e[1])), r(k.num(e[2])), w ? r(k.num(w[1])) : 0.2]); }
    } catch { /* a box is enough */ }
  }
  return { boxes, segs };
}

/** Store a planned change for the people in the document to accept or reject (src/proposals.rs), and point at it. */
async function park(req: Request, sess: DocSession, doc: any, prop: any): Promise<any> {
  if (!prop.changes.length && !prop.rules) throw new ToolError("These edits change nothing, so there is nothing to propose.");
  const body = { lines: prop.lines.map((l: any) => ({ kind: l.kind, text: l.text })), changes: prop.changes, basis: prop.basis, rules: prop.rules || null, connectivity: prop.connectivity || null,
    preview: previewOf(sess, doc, prop.changes) };
  const stored = await api(`/api/docs/${sess.entry.docId}/proposals`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: prop.title, rationale: prop.rationale || "", app: req.agent || "", body }) });
  // the assistant's cursor goes to what the proposal touches, so people look there
  let seen: unknown;
  try {
    const ids = prop.changes.filter((c: any) => c.kind !== "ADDED" && doc.items.has(c.id)).map((c: any) => c.id).slice(0, 40);
    let box: number[] | null = null;
    const scratch = Object.assign({}, doc, { items: new Map() });
    for (const c of prop.changes) if (c.kind === "ADDED") { try { K().applyChange(scratch, c, sess.IU); } catch { /* drawn by the editor */ } }
    for (const it of scratch.items.values() as Iterable<any>) if (it.bbox) box = box ? [Math.min(box[0], it.bbox[0]), Math.min(box[1], it.bbox[1]), Math.max(box[2], it.bbox[2]), Math.max(box[3], it.bbox[3])] : it.bbox.slice();
    if (ids.length || box) { const h: any = await highlight(sess, doc, { ids: ids.length ? ids : undefined, area: !ids.length && box ? box : undefined, note: `Proposed: ${prop.title}`, seconds: 60 }); seen = h.seen_by; }
  } catch { /* the proposal stands without the pointer */ }
  return { applied: false, proposed: true, proposal: stored.id, status: "pending", seen_by: seen,
    note: "Nothing was changed. The people in this document see the change drawn over the design and choose Accept or Reject. Read the outcome with list_proposals (wait_s waits for it); do not apply the same edits yourself meanwhile." };
}

const proposalRow = (r: any) => ({ proposal: r.id, document: r.docPath, title: r.title, status: r.status, edits: (r.lines || []).length, proposed: r.createdAt,
  decided_by: r.decidedBy ? r.decidedBy.name || r.decidedBy.login : undefined, decided: r.decidedAt || undefined, reason: r.reason || undefined });

async function listProposals(req: Request): Promise<Reply> {
  const p = needProject(req), a = req.args || {};
  if (a.withdraw) {
    needWrite(req, p);
    const r = await api(`/api/proposals/${encodeURIComponent(String(a.withdraw))}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "withdrawn", reason: String(a.reason || "") }) });
    return { result: proposalRow(r) };
  }
  if (a.proposal) {
    const until = Date.now() + Math.max(0, Math.min(50, Number(a.wait_s) || 0)) * 1000;
    for (;;) {
      const r = await api(`/api/proposals/${encodeURIComponent(String(a.proposal))}`);
      if (r.projectId !== p.projectId) throw new ToolError("That proposal is not in this project.");
      if (r.status !== "pending" || Date.now() >= until) {
        const row: any = proposalRow(r);
        if (r.status === "pending") row.note = "Still waiting for a person to decide. Carry on with other work or ask them; do not apply it yourself.";
        if (r.status === "accepted") row.note = "Applied by the person as their own edit; the design now contains it.";
        if (r.status === "stale") row.note = "The design changed under it. Read the design again and propose a new version if it is still wanted.";
        return { result: row };
      }
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }
  const docs = a.document ? [findDocument(p, a.document)] : p.docs.filter((d) => d.docType === "kicad_sch" || d.docType === "kicad_pcb");
  const out: any[] = [];
  for (const d of docs) {
    const j = await api(`/api/docs/${d.docId}/proposals${a.status ? `?status=${encodeURIComponent(String(a.status))}` : ""}`);
    for (const r of j.proposals || []) out.push(proposalRow(r));
  }
  out.sort((x, y) => String(y.proposed).localeCompare(String(x.proposed)));
  return { result: { proposals: out.slice(0, 30), note: out.length ? undefined : "No proposals." } };
}

async function proposeFixes(req: Request): Promise<Reply> {
  const p = needProject(req), a = req.args || {}; needWrite(req, p);
  return withDocument(req, a.document, async (sess, doc, ed) => {
    if (ed.viewOnly) throw new ToolError(`You have view-only access to ${p.name}.`);
    let markers: any[];
    if (doc.type === "sch") markers = await design.projectErc(doc, sess.entry.path);
    else { const P = W.PcbTools; if (!P || !P.drc) throw new ToolError("The DRC is not available."); markers = P.drc(doc, P.designSettings(ed.proSettings || null), {}); }
    const rows = markers.filter((m) => m.severity === "error" || m.severity === "warning");
    const { plans, left } = planFixes(doc, rows, Array.isArray(a.codes) ? a.codes.map(String) : undefined);
    const waiting = (await api(`/api/docs/${sess.entry.docId}/proposals?status=pending`)).proposals || [];
    const proposed: any[] = [], failed: any[] = [];
    for (const plan of plans) {
      if (waiting.some((w: any) => w.title === plan.title)) { failed.push({ fix: plan.title, why: "The same fix is already waiting for a decision." }); continue; }
      try {
        const prop = await buildProposal({ title: plan.title, rationale: plan.rationale, edits: plan.edits });
        const stored = await park(req, sess, doc, prop);
        proposed.push({ proposal: stored.proposal, title: plan.title, fixes: plan.fixes, codes: plan.codes, edits: prop.lines.length });
      } catch (e) { failed.push({ fix: plan.title, why: plain(e instanceof Error ? e.message : String(e)) }); }
    }
    return { result: { document: sess.entry.path, check: doc.type === "sch" ? "ERC" : "DRC", violations: rows.length, proposed, could_not_plan: failed.length ? failed : undefined,
      left_for_you: left.length ? left.slice(0, 20) : undefined,
      note: proposed.length ? "Nothing was changed. Each fix waits as its own proposal for a person to Accept or Reject in the editor; list_proposals gives the outcome. Run the check again after they decide."
        : rows.length ? "None of these violations has a mechanical fix. Work through left_for_you: each needs a design decision; propose your change with apply_changes propose: true." : "The check is clean: nothing to fix." } };
  });
}

// ---------------------------------------------------------------- simulation

const ANALYSIS = /^\s*\.(tran|ac|dc|op)\b/i;

/** KiCad's SPICE netlist of the project's schematic hierarchy (editor/export-netlist.ts projectSpiceNetlist), read from the live documents. */
async function schematicSpice(req: Request, p: Project, withCommands: boolean, notes: string[]): Promise<{ netlist: string; files: [string, string][] }> {
  const schs = p.docs.filter((d) => d.docType === "kicad_sch"); if (!schs.length) throw new ToolError("This project has no schematic to simulate. Pass a netlist instead.");
  const pro = p.docs.find((d) => d.docType === "kicad_pro"); const stem = (x: string) => x.replace(/\.[^./]+$/, "");
  const root = (req.args.document ? findDocument(p, req.args.document) : null) || (pro && schs.find((d) => stem(d.path) === stem(pro.path)))
    || schs.slice().sort((x, y) => x.path.split("/").length - y.path.split("/").length || x.path.length - y.path.length)[0]!;
  if (root.docType !== "kicad_sch") throw new ToolError("Simulation reads a schematic: name a sheet, or leave document out for the root sheet.");
  return withDocument(req, root.path, async (_sess, doc, ed) => {
    const k = K(), sch = W.CollabTools && W.CollabTools.sch, hp = sch && sch._; if (!hp || !hp.symbolPins) throw new ToolError("The schematic tools are not loaded.");
    const files = new Map<string, { doc: any; uuid: string; file: string }>();
    for (const d of schs) { try { const dd = d.path === root.path ? doc : (await design.resolveDoc(d.path)).doc; files.set(d.path, { doc: dd, uuid: dd.uuid || "", file: d.path }); } catch { /* reported as a missing sheet */ } }
    const rootFile = files.get(root.path)!;
    // a KiCad 10 project with several top-level sheets: the netlist covers all of them (unless a sheet was named)
    let tops: { sheet: { doc: any; uuid: string; file: string }; name: string; uuid: string }[] = [];
    if (!req.args.document) { try { const pt = await projectFile(p); tops = topLevelSheetsOf(pt ? JSON.parse(pt) : null, p.docs, p.docs).map((t) => ({ sheet: files.get(t.doc.path)!, name: t.name, uuid: t.uuid })).filter((t) => !!t.sheet); } catch { tops = []; } }
    const resolve = (file: string, parent: { file: string }) => {
      const parts = [...parent.file.split("/").slice(0, -1), ...file.split("/")].filter((x) => x && x !== "."); const out: string[] = [];
      for (const x of parts) { if (x === "..") out.pop(); else out.push(x); }
      return files.get(out.join("/")) || files.get(file) || null;
    };
    const isPower = (d: any, it: any) => hp.isPowerSymbol(d, String((k.kid(it.node, "lib_id") || [])[1]));
    const nl = k.pcbNetlist.buildNetlist(tops.length > 1 ? tops : rootFile, resolve, { symbolPins: hp.symbolPins, isPower }, root.path.split("/").pop()!.replace(/\.kicad_sch$/, ""));
    const insts: any[] = nl.instances || []; const docOf = (f: string) => { const x = files.get(f); return x ? x.doc : null; };
    const placed = new Map<string, any>(NK.nlSheets(insts, docOf).map((x: any) => [x.uuidPath.join("/"), x]));
    const parentDoc = (u: string[]) => { const par = insts.find((i) => i.uuidPath.length === u.length - 1 && i.uuidPath.every((x: string, j: number) => u[j] === x)); return par ? docOf(par.file) : null; };
    const sheets = insts.map((i) => { const pl = placed.get(i.uuidPath.join("/")), pd = parentDoc(i.uuidPath);
      return { index: i.index, uuidPath: i.uuidPath, doc: docOf(i.file), sheetNode: pl ? pl.sheetNode : null, parentVersion: pd ? pd.version : undefined }; }).filter((x) => x.doc);
    let textVars: Record<string, string> = {}; try { textVars = ((ed.proSettings ? JSON.parse(ed.proSettings) : {}).text_variables as Record<string, string>) || {}; } catch { textVars = {}; }
    if (!SM.hasNgspiceData()) SM.setNgspiceData(NGSPICE);   // the ngspice models' parameters (instance l=/w=, .model overrides)
    const { symbols, texts } = SP.readHierarchy({ sheets, netMap: nl.netMap || new Map(), symbolPins: hp.symbolPins, isPower, textVars } as any);
    // the project's SPICE model files: parsed for the exporter, and handed to ngspice where the netlist includes them
    const models = p.docs.filter((d) => d.docType === "spice_model" || /\.(lib|sub|cir|mod|model|sp|spice|ibs)$/i.test(d.path));
    const norm = (x: string) => x.replace(/\\/g, "/").replace(/^\$\{KIPRJMOD\}\//, "").replace(/^\.\//, "");
    const loaded = new Map<string, string | null>(); let bytes = 0;
    const load = async (d: DocEntry) => { if (!loaded.has(d.path)) { let t: string | null = null; try { t = await readTextDocument(conn, d.docId); } catch { t = null; } if (t !== null && (bytes += t.length) > 8e6) t = null; loaded.set(d.path, t); } return loaded.get(d.path)!; };
    const find = (path: string) => models.find((x) => norm(x.path) === norm(path)) || models.find((x) => norm(path).endsWith("/" + norm(x.path))) || null;
    const libs = new Map<string, any>();
    for (const sym of symbols) {
      const path = (sym.fields.find((f: any) => f.name === SM.F.LIBRARY) || { value: "" }).value; if (!path || libs.has(path)) continue;
      const f = find(path); let text = builtinLibrary(path); if (text === null) text = f ? await load(f) : null;
      if (text !== null && !SM.isIbisPath(path)) text = await SM.expandSpiceIncludes(text, path, async (cands: string[]) => { for (const c of cands) { const g = find(c); if (g) { const t = await load(g); if (t !== null) return t; } } return null; }, []);
      if (text === null) notes.push(`The model library ${path} is not in the project.`);
      libs.set(path, text === null ? null : SM.isIbisPath(path) ? SM.parseIbisLibrary(text, path) : SM.parseSpiceLibrary(text));
    }
    let netlist = SP.spiceNetlist({ symbols, texts, options: SP.OPTION_SAVE_ALL_VOLTAGES | SP.OPTION_SAVE_ALL_CURRENTS | (withCommands ? SP.OPTION_SIM_COMMAND : 0), library: (x) => libs.get(x) || null,
      report: (m, sev) => { if (notes.length < 12) notes.push(`${sev === "error" ? "Error" : "Warning"}: ${m}`); } });
    for (const d of models) await load(d);
    const given: [string, string][] = [];
    for (const [path, text] of loaded) if (text !== null) given.push([`/proj/${norm(path)}`, text]);
    for (const m of netlist.matchAll(/^\s*\.include\s+"([^"]+)"/gim)) { const b = builtinLibrary(m[1]); if (b !== null) given.push([m[1], b]); }
    netlist = netlist.replace(/^(\s*\.(?:include|lib)\s+)"([^"]+)"/gim, (all, head, path) => { const f = find(path); return f ? `${head}"/proj/${norm(f.path)}"` : all; });
    return { netlist, files: given };
  });
}

async function simulate(req: Request): Promise<Reply> {
  const p = needProject(req), a = req.args || {}; const notes: string[] = [];
  const cmd = String(a.command || "").trim();
  if (cmd && !ANALYSIS.test(cmd)) throw new ToolError("command is one ngspice analysis line: .op, .tran <step> <stop>, .ac dec <points> <fstart> <fstop> or .dc <source> <start> <stop> <step>.");
  let netlist: string, files: [string, string][] = [];
  if (typeof a.netlist === "string" && a.netlist.trim()) { netlist = a.netlist; if (netlist.length > 400000) throw new ToolError("The netlist is too long (400,000 characters at most)."); if (!/^\s*\.end\s*$/im.test(netlist)) netlist += "\n.end\n"; }
  else ({ netlist, files } = await schematicSpice(req, p, !cmd, notes));
  if (cmd) { const lines = netlist.split("\n").filter((l) => !ANALYSIS.test(l)); let end = lines.findIndex((l) => /^\s*\.end\s*$/i.test(l)); if (end < 0) end = lines.length; lines.splice(end, 0, cmd); netlist = lines.join("\n"); }
  const lineOf = netlist.split("\n").find((l) => ANALYSIS.test(l));
  if (!lineOf) throw new ToolError("There is no analysis to run: the schematic has no simulation command in a text. Pass command, for example \".tran 10u 10m\" or \".ac dec 20 10 1meg\".");
  if (netlist.split("\n").filter((l) => ANALYSIS.test(l)).length > 1) throw new ToolError("One analysis per call: pass command to choose it.");
  if (a.netlist_only === true) return { result: { netlist, notes: notes.length ? notes : undefined } };
  const limit = Math.max(5, Math.min(120, Number(a.timeout_s) || 40)) * 1000;
  let run: SimRun;
  try { run = await runSpice(netlist, files, String(process.env.KC_PYODIDE_DIR || ""), limit); }
  catch (e) { if (e instanceof ToolError && typeof a.netlist !== "string") throw new ToolError(`${e.message}${notes.length ? ` Notes from the netlist: ${notes.join(" ")}` : ""}`); throw e; }
  const problems = run.errors.map((x) => x.trim()).filter((x) => x && !/^(Note:|Using SPARSE|No compatibility mode|Warning: No job)/i.test(x)).slice(0, 10);
  if (!run.vectors.length || !run.points) throw new ToolError(`ngspice produced no result. ${problems.concat(notes).join(" ").slice(0, 1500) || "Check that the circuit has a ground (net 0 or GND), a source, and a model for every part (the Sim fields of each symbol)."} Pass netlist_only: true to read the netlist that was run.`);
  const sweep = run.vectors[0]!, rest = run.kind === "op" ? run.vectors : run.vectors.slice(1);
  const missing: string[] = []; let shown: Vector[] = [];
  if (Array.isArray(a.probes) && a.probes.length) for (const pr of a.probes.slice(0, 8)) { const v = findVector(run, String(pr)); if (v && v !== sweep) { if (!shown.includes(v)) shown.push(v); } else missing.push(String(pr)); }
  else {
    const volts = rest.filter((v) => /^v\(/i.test(v.name) || /voltage/i.test(v.type));
    const named = volts.filter((v) => !/net-\(|unconnected|#/i.test(v.name));
    shown = (named.length ? named : volts.length ? volts : rest).slice(0, run.kind === "op" ? 60 : 6);
  }
  if (run.kind === "op" && !(Array.isArray(a.probes) && a.probes.length)) shown = rest.slice(0, 80);
  const signals: Record<string, unknown> = {}; for (const v of shown) signals[v.name] = run.kind === "op" ? (summarize(run, v) as any).value : summarize(run, v);
  const others = rest.filter((v) => !shown.includes(v)).map((v) => v.name);
  const result: any = { analysis: lineOf.trim(), points: run.points, sweep: run.kind === "op" ? undefined : `${sweep.name} ${eng(sweep.re[0]!)} to ${eng(sweep.re[sweep.re.length - 1]!)}`, signals,
    not_found: missing.length ? missing : undefined, other_signals: others.length ? others.slice(0, 60) : undefined, more: others.length > 60 ? others.length - 60 : undefined,
    warnings: problems.concat(notes).length ? problems.concat(notes).slice(0, 12) : undefined };
  const svg = a.plot === false ? null : plotOf(run, shown, `${p.name}: ${lineOf.trim()}`);
  return svg ? { result, svg } : { result };
}

async function undoChanges(req: Request): Promise<Reply> {
  const p = needProject(req); needWrite(req, p);
  const rec = req.args.__record as { docId: string; title: string; undo: UndoRecord & { rules?: any; domain?: string } };
  // a change one of the other domains' tools made is that domain's to take back
  const owner = rec.undo && rec.undo.domain ? DOMAIN_TOOLS.find((d) => d.domain === rec.undo.domain && d.undo) : undefined;
  if (owner) return owner.undo!(req);
  const entry = p.docs.find((d) => d.docId === rec.docId); if (!entry) throw new ToolError("The document of that change is no longer in the project.");
  return withDocument(req, entry.path, async (sess, doc) => {
    const k = K(); const blocked: string[] = [];
    for (const [id, was] of Object.entries(rec.undo.after || {})) {
      const it = doc.items.get(id);
      if (was === null) { if (it) blocked.push(`${it.ref || it.kind} was put back by someone since`); }
      else if (!it) blocked.push(`an item the change touched (${id.slice(0, 8)}) has been deleted since`);
      else if (k.serialize(it.node) !== was) blocked.push(`${it.ref || it.kind + " " + id.slice(0, 8)} has been edited since`);
      if (blocked.length >= 8) break;
    }
    const redo = req.tool === "redo_changes", word = redo ? "redone" : "undone";
    if (blocked.length) throw new ToolError(`"${rec.title}" cannot be ${word} as a whole, because the design has moved on: ${blocked.join("; ")}. Nothing was changed. Make the correction as a new change instead.`);
    // what this call takes away is kept, so that the opposite tool can put it back
    let rulesNow: unknown;
    if (rec.undo.rules) {
      const pro = p.docs.find((d) => d.docType === "kicad_pro");
      if (pro) {
        const text = await projectFile(p, true); if (text) rulesNow = rulesBefore(text);
        const saved = await editProjectFile(conn, pro.docId, (j) => restoreRules(j, rec.undo.rules), "board rules"); proCache.set(pro.docId, { at: Date.now(), text: saved.text });
      }
    }
    let back: UndoRecord = { inverse: [], after: {} };
    if (rec.undo.inverse && rec.undo.inverse.length) back = await sess.commit(rec.undo.inverse);
    return { result: { [word]: rec.title, document: entry.path, changes: (rec.undo.inverse || []).length, [redo ? "board_rules_set_again" : "board_rules_restored"]: rec.undo.rules ? true : undefined,
        note: redo ? "undo_changes takes it back again." : "redo_changes puts it back." },
      swap: Object.assign({}, back, rulesNow ? { rules: rulesNow } : {}) };
  });
}

// ---------------------------------------------------------------- run_python

declare const __dirname: string;
const PY_OUTPUT_MAX = 6000, PY_DEFAULT_S = 180, PY_MAX_S = 400;
/** The calls a script's kicad_harness makes, by the names the harness uses, and the tools that answer them. */
const HARNESS_CALLS: Record<string, string> = {
  overview: "get_design_overview", list_components: "list_components", get_component: "get_component", list_nets: "list_nets", get_geometry: "get_geometry", check_layout: "check_layout", review_design: "review_design",
  run_checks: "run_checks", get_board_info: "get_board_info", get_items: "get_items", find_datasheets: "find_datasheets", find_parts: "find_parts",
  get_library_part: "get_library_part", read_datasheet: "read_datasheet", highlight: "highlight", trace_net: "trace_net",
};

interface ChangeRecord { docId: string; title: string; edits: string[]; undo: UndoRecord & { rules?: unknown } }

/** Several changes to one document as one: undone together, each item back to how it was before the first of them. */
function mergeRecords(title: string, recs: ChangeRecord[]): ChangeRecord[] {
  const byDoc = new Map<string, ChangeRecord[]>();
  for (const r of recs) { const l = byDoc.get(r.docId); if (l) l.push(r); else byDoc.set(r.docId, [r]); }
  const out: ChangeRecord[] = [];
  for (const [docId, list] of byDoc) {
    const after: Record<string, string | null> = {}; const first = new Map<string, any>(); let rules: unknown; const edits: string[] = [];
    for (const r of list) {
      // a record's inverse is in undo order; an item's state before the run is in the earliest record that touched it
      for (const c of r.undo.inverse) if (!first.has(c.id)) first.set(c.id, c);
      Object.assign(after, r.undo.after);
      if (rules === undefined && r.undo.rules) rules = r.undo.rules;
      for (const e of r.edits) if (edits.length < 200) edits.push(e);
    }
    const inverse: any[] = [];
    for (const [id, c] of first) {
      const here = after[id] !== null && after[id] !== undefined;
      if (c.kind === "REMOVED") { if (here) inverse.push(c); }                                   // made by the run: taken away again
      else inverse.push(Object.assign({}, c, { kind: here ? "MODIFIED" : "ADDED" }));              // there before: back as it was
    }
    for (const id of Object.keys(after)) if (!first.has(id)) delete after[id];
    out.push({ docId, title, edits, undo: Object.assign({ inverse, after }, rules ? { rules } : {}) });
  }
  return out;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6), tail = max - head;
  return `${text.slice(0, head)}\n... (${text.length - max} characters left out) ...\n${text.slice(text.length - tail)}`;
}

/**
 * Run a Python script that drives the design through kicad_harness.  The script runs in a locked-down process of
 * its own (web/domains/pcb/harness/sandbox.ts); each of its design calls comes back here and is run as the tool of that name,
 * so it reads the live document and its edits leave as ordinary ops, drawn step by step when `live`.
 */
async function runPython(req: Request): Promise<Reply> {
  const p = needProject(req); const a = req.args || {};
  if (typeof a.code !== "string" || !a.code.trim()) throw new ToolError("Give the script as `code`.");
  if (a.code.length > 200000) throw new ToolError("The script is too long (200,000 characters at most).");
  const runtime = String(process.env.KC_PYODIDE_DIR || ""); const fs = require("node:fs"), path = require("node:path");
  const program = path.join(__dirname, "harness-sandbox.js");
  if (!runtime || !fs.existsSync(path.join(runtime, "pyodide.asm.wasm")) || !fs.existsSync(program)) throw new ToolError("Python is not available on this server (its runtime is not built). The other tools work; use apply_changes instead.");
  const live = a.live !== false; const title = typeof a.title === "string" && a.title.trim() ? a.title.trim().slice(0, 120) : "Python script";
  const limit = Math.max(5, Math.min(PY_MAX_S, Number(a.timeout_s) || PY_DEFAULT_S)) * 1000;
  const records: ChangeRecord[] = []; let calls = 0;
  // Planned first, drawn after: while the script runs its edits stay in the host's copy of each document (it reads,
  // measures and checks them there), and the people watching see each document drawn once, live, at its final
  // places, when the script ends or calls project.publish().  plan: false sends each batch as it is made.
  // dry_run: the script runs on the host's copy only.  Nothing is drawn or stored; the answer is what the script
  // printed and how much it would change, so a design is tried, checked and corrected before anyone sees it.
  const dry = a.dry_run === true;
  const plan = dry || (live && a.plan !== false);
  const staged = new Map<string, { sess: DocSession; edits: string[] }>();
  const stage = (sess: DocSession) => { sess.beginStage(); if (!staged.has(sess.entry.docId)) staged.set(sess.entry.docId, { sess, edits: [] }); };
  const publish = async (): Promise<number> => {
    let n = 0; const alone = staged.size === 1;
    for (const [docId, st] of [...staged]) {
      staged.delete(docId);
      const undo = await st.sess.publishStage(live, alone);
      if (undo) { n += undo.inverse.length; records.push({ docId, title, edits: st.edits.slice(0, 200), undo }); }
    }
    return n;
  };
  const would: { document: string; items: number }[] = [];
  const drop = () => { for (const st of staged.values()) { const n = st.sess.dropStage(); if (n) would.push({ document: st.sess.entry.path, items: n }); } staged.clear(); };

  const answer = async (tool: string, args: any): Promise<unknown> => {
    calls++; args = args || {};
    if (tool === "documents") return { project: p.name, documents: p.docs.filter(drawable).map((d) => ({ path: d.path, type: d.docType === "kicad_pcb" ? "board" : "schematic" })) };
    if (tool === "text") return withDocument(req, args.document, (sess, doc) => ({ document: sess.entry.path, text: sourceText(sess, doc) }));
    const sub: Request = Object.assign({}, req, { args });
    if (tool === "apply") {
      // a document the script has planned and not yet drawn is read as planned (a board synced from the sheet built two lines above)
      design.planned.doc = (id: string) => { const st = staged.get(id); return st ? st.sess.kdoc : null; };
      let r: Reply;
      try { r = await applyChanges(Object.assign(sub, { tool: "apply_changes", args: Object.assign({}, args, { title: args.title || title, dry_run: false }) }), live, plan ? stage : undefined); }
      finally { design.planned.doc = null; }
      if (r.record) records.push(r.record as ChangeRecord);
      const res: any = r.result; const c = res && res.connectivity;
      if (res && res.staged) {
        const st = [...staged.values()].find((x) => x.sess.entry.path === res.document); if (st) for (const e of res.edits || []) if (st.edits.length < 200) st.edits.push(e);
        return Object.assign({}, res, { staged: undefined, connectivity: c && typeof c === "object" ? c.changed : undefined });
      }
      // the ids of the items this batch made, as the local workspace gives them: the harness takes a via or a text back by its id
      const added = r.record ? ((r.record as ChangeRecord).undo.inverse || []).filter((x: any) => x.kind === "REMOVED").map((x: any) => x.id).reverse() : [];
      return Object.assign({}, res, { added, connectivity: c && typeof c === "object" ? c.changed : undefined });
    }
    if (tool === "publish") return { drawn: dry ? 0 : await publish() };
    const name = HARNESS_CALLS[tool]; if (!name) throw new ToolError(`Unknown harness call ${tool}.`);
    sub.tool = name; return (await TOOLS[name](sub)).result;
  };

  // Node 22.13 and later call the permission model --permission; before that it was --experimental-permission
  const permission = process.allowedNodeEnvironmentFlags && process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
  const flags = [permission, `--allow-fs-read=${runtime}`, `--allow-fs-read=${program}`, "--disallow-code-generation-from-strings", "--max-old-space-size=768", "--no-warnings"];
  const child = require("node:child_process").spawn(process.execPath, [...flags, program, runtime.replace(/\/*$/, "/")], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
  let errText = "";
  child.stderr.on("data", (d: any) => { if (errText.length < 4000) errText += String(d); });
  const started = Date.now();
  const done: any = await new Promise((resolve) => {
    let settled = false; let chain: Promise<void> = Promise.resolve();
    const finish = (v: any) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => finish({ ok: false, error: `The script ran past its time limit of ${Math.round(limit / 1000)} s and was stopped.`, output: "" }), limit);
    const rl2 = require("node:readline").createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl2.on("line", (line: string) => {
      let msg: any; try { msg = JSON.parse(line); } catch { return; }
      if (msg && msg.done) { chain.then(() => finish(msg)); return; }
      if (!msg || typeof msg.call !== "string") return;
      chain = chain.then(async () => {
        if (settled) return; let out: any;
        try { out = { ok: true, result: await answer(msg.call, msg.args) }; }
        catch (e) { if (!(e instanceof ToolError)) console.error("mcp host: harness call failed", msg.call, e); out = { ok: false, error: e instanceof ToolError ? plain(e.message) : `The call failed: ${e instanceof Error ? e.message : String(e)}` }; }
        if (!settled) { try { child.stdin.write(JSON.stringify(out) + "\n"); } catch { /* the script is gone */ } }
      });
    });
    child.on("error", (e: any) => finish({ ok: false, error: `Python could not be started (${e && e.message}).`, output: "" }));
    child.on("exit", () => chain.then(() => finish({ ok: false, error: "The Python runtime stopped before the script finished" + (errText.trim() ? `: ${errText.trim().split("\n").slice(-2).join(" ")}` : "."), output: "" })));
    child.stdin.on("error", () => undefined);
    child.stdin.write(JSON.stringify({ code: a.code, dry }) + "\n");
  });

  if (done.ok && dry) {
    drop();
    // what could not be staged (the board's layer set-up, its rules in the project file) was applied: take it back
    let clean = true;
    try {
      for (const rec of mergeRecords(title, records).reverse()) {
        const entry = p.docs.find((d) => d.docId === rec.docId); if (!entry) continue;
        if (rec.undo.rules) { const pro = p.docs.find((d) => d.docType === "kicad_pro"); if (pro) { const saved = await editProjectFile(conn, pro.docId, (j) => restoreRules(j, rec.undo.rules as any), "board rules"); proCache.set(pro.docId, { at: Date.now(), text: saved.text }); } }
        if (rec.undo.inverse.length) await withDocument(req, entry.path, (sess) => sess.commit(rec.undo.inverse));
      }
    } catch (e) { clean = false; console.error("mcp host: dry run not taken back", e); }
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    return { result: { ok: true, dry_run: true, output: clip(String(done.output || "").trim(), PY_OUTPUT_MAX) || undefined, result: done.result, refused: Array.isArray(done.refused) && done.refused.length ? done.refused : undefined,
      notes: Array.isArray(done.notes) && done.notes.length ? done.notes : undefined, would_change: would,
      design: clean ? "Dry run: nothing was changed and nobody saw it. When the output shows no errors and nothing refused, run the same script again without dry_run; it is then drawn once." : "Dry run, but the board set-up it changed could not all be taken back; read the design before going on.", calls, seconds } };
  }
  if (done.ok) {
    try { await publish(); }
    catch (e) { drop(); Object.assign(done, { ok: false, error: `The finished drawing could not be sent: ${e instanceof Error ? plain(e.message) : String(e)}` }); }
  } else drop();
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const output = clip(String(done.output || "").trim(), PY_OUTPUT_MAX) || undefined;
  const notes = Array.isArray(done.notes) && done.notes.length ? done.notes : undefined;
  if (!done.ok) {
    // a script that failed part way leaves nothing behind unless it was told to keep what it had done
    let kept = records.length > 0; let rolled: string | undefined;
    if (records.length && a.keep_on_error !== true) {
      try {
        for (const rec of mergeRecords(title, records).reverse()) {
          const entry = p.docs.find((d) => d.docId === rec.docId); if (!entry) continue;
          if (rec.undo.rules) { const pro = p.docs.find((d) => d.docType === "kicad_pro"); if (pro) { const saved = await editProjectFile(conn, pro.docId, (j) => restoreRules(j, rec.undo.rules as any), "board rules"); proCache.set(pro.docId, { at: Date.now(), text: saved.text }); } }
          if (rec.undo.inverse.length) await withDocument(req, entry.path, (sess) => sess.commit(rec.undo.inverse));
        }
        kept = false; rolled = "The edits the script had made before it failed were taken back: the design is as it was.";
      } catch (e) { console.error("mcp host: script edits not taken back", e); rolled = "The edits the script had made before it failed could not all be taken back; read the design before going on."; }
    }
    const where = typeof done.line === "number" ? ` (line ${done.line} of the script)` : "";
    const res = { ok: false, error: `${done.error || "The script failed."}${where}`, output, notes, design: rolled || (kept ? "The edits made before the failure were kept (keep_on_error)." : "Nothing was changed."), seconds };
    return kept ? { result: res, records: mergeRecords(title, records) } : { result: res };
  }
  const merged = mergeRecords(title, records);
  const result = { ok: true, output, result: done.result, notes, changed: merged.map((r) => ({ document: (p.docs.find((d) => d.docId === r.docId) || { path: r.docId }).path, items: r.undo.inverse.length })), calls, seconds };
  return merged.length ? { result, records: merged } : { result };
}

// ---------------------------------------------------------------- reading as text and as a picture

const HEADER = ["version", "generator", "generator_version", "general", "paper", "layers", "setup", "uuid", "title_block"];
/** The document in KiCad's own format, as it stands now: the stored file's header with the live items. */
function sourceText(sess: DocSession, doc: any): string {
  const k = K(); const base = k.parse(sess.file); const out: any[] = [base[0]];
  const bs = doc.boardSetup || {};   // board sections changed since the file was stored (layer count, stackup, thickness)
  for (const n of base.slice(1)) if (Array.isArray(n) && HEADER.includes(n[0])) out.push((n[0] === "general" || n[0] === "layers" || n[0] === "setup") && bs[n[0]] ? bs[n[0]] : n);
  if (doc.type === "sch") out.push(["lib_symbols", ...doc.lib.values()]);
  for (const it of doc.items.values()) out.push(it.node);
  if (doc.type === "sch") { const si = base.find((n: any) => Array.isArray(n) && n[0] === "sheet_instances"); if (si) out.push(si); }
  return k.serialize(out) + "\n";
}

async function readDocument(req: Request): Promise<Reply> {
  const a = req.args || {};
  return withDocument(req, a.document, (sess, doc) => {
    const text = sourceText(sess, doc); const offset = Math.max(0, Math.floor(Number(a.offset) || 0)); const max = Math.min(100000, Math.max(1000, Math.floor(Number(a.max_chars) || 40000)));
    const part = text.slice(offset, offset + max); const next = offset + part.length;
    return { result: { document: sess.entry.path, format: doc.type === "sch" ? "kicad_sch" : "kicad_pcb", total_chars: text.length, offset, text: part,
      next_offset: next < text.length ? next : undefined,
      note: next < text.length ? `Cut at ${max} characters; call again with offset ${next} for more. get_items with a filter is usually the better way to read part of a design.` : undefined } };
  });
}

async function renderView(req: Request): Promise<Reply> {
  const a = req.args || {};
  return withDocument(req, a.document, async (sess, doc) => {
    const k = K(); const opts: any = {}; let box: number[] | null = null; const em: Emphasis = {}; const result: any = { document: sess.entry.path };
    const pad = (b: number[]) => { const m = Math.max(doc.type === "sch" ? 12 : 4, 0.25 * Math.max(b[2] - b[0], b[3] - b[1])); return [b[0] - m, b[1] - m, b[2] + m, b[3] + m]; };
    if (Array.isArray(a.area) && a.area.length === 4 && a.area.every((v: unknown) => typeof v === "number" && isFinite(v as number))) box = [Math.min(a.area[0], a.area[2]), Math.min(a.area[1], a.area[3]), Math.max(a.area[0], a.area[2]), Math.max(a.area[1], a.area[3])];
    // parts, nets and items: the picture is cropped to them (unless an area says otherwise) and can make them stand out
    const scoped = (Array.isArray(a.refs) && a.refs.length) || (Array.isArray(a.nets) && a.nets.length) || (Array.isArray(a.ids) && a.ids.length);
    if (scoped) {
      const t = resolveTargets(doc, { refs: a.refs, nets: a.nets, ids: a.ids });
      if (!t.box) throw new ToolError(`Not on ${sess.entry.path}: ${t.missing.join(", ")}.`);
      if (t.missing.length) result.not_on_this_document = t.missing;
      if (!box) box = pad(t.box);
      const nets = Array.isArray(a.nets) && a.nets.length > 0;
      if (a.emphasize === undefined ? nets : a.emphasize === true) { em.dim = true; em.ids = new Set(t.ids); em.boxes = t.boxes.slice(0, 400); if (doc.type === "sch") em.segs = t.segs.slice(0, 600); result.emphasized = t.what; }
    }
    // what a person in the document is looking at, with their selection outlined and their cursor
    if (typeof a.view_of === "string" && a.view_of.trim()) {
      await settle(sess); const p = findPerson(sess, a.view_of);
      if (!p) { const here = Array.from(sess.peers.values()).filter((q) => q.user && q.user.client !== "mcp").map((q) => q.user.name || q.user.login); throw new ToolError(here.length ? `${a.view_of} does not have ${sess.entry.path} open. In it now: ${here.join(", ")}.` : `Nobody else has ${sess.entry.path} open right now, so there is no view to show.`); }
      const st = p.state || {}, IU = sess.IU, color = (p.user && p.user.color) || "#4477ee", name = p.user.name || p.user.login || "peer";
      if (!box && Array.isArray(st.viewport) && st.viewport.length >= 4 && st.viewport[2] > 0) box = [st.viewport[0] / IU, st.viewport[1] / IU, (st.viewport[0] + st.viewport[2]) / IU, (st.viewport[1] + st.viewport[3]) / IU];
      const sel: string[] = Array.isArray(st.selection) ? st.selection : []; em.boxes = em.boxes || [];
      for (const id of sel) { const b = doc.items.get(id)?.bbox; if (b) em.boxes.push([b[0], b[1], b[2], b[3], color]); }
      if (Array.isArray(st.cursor)) em.tags = [{ x: st.cursor[0] / IU, y: st.cursor[1] / IU, label: name, color }];
      result.view_of = name; result.their_selection = sel.length ? sel.map((id) => doc.items.get(id)).filter(Boolean).slice(0, 30).map((it: any) => it.ref || `${it.kind} ${it.id}`) : "nothing selected";
    }
    if (box) { if (box[2] - box[0] < 0.5 || box[3] - box[1] < 0.5) throw new ToolError("The area is too small to draw; give at least half a millimetre each way."); opts.bbox = box; opts.margin = 0; }
    if (doc.type === "pcb" && Array.isArray(a.layers) && a.layers.length) {
      const all: any[] = k.layerList(doc); const want = new Set(a.layers.map((l: unknown) => String(l).toLowerCase()));
      const unknown = Array.from(want).filter((w) => !all.some((l) => String(l.name).toLowerCase() === w));
      if (unknown.length) throw new ToolError(`Not layers of this board: ${unknown.join(", ")}. It has: ${all.map((l) => l.name).join(", ")}.`);
      opts.hidden = new Set(all.filter((l) => !want.has(String(l.name).toLowerCase())).map((l) => l.key));
    } else if (doc.type === "pcb") opts.hidden = new Set(Array.from(k.PCB_HIDDEN_DEFAULT || []));
    // the findings of the rules check, numbered on the picture in the order run_checks lists them
    if (a.violations === true) {
      const res: any = await design.runChecks({}); const rows: any[] = res.violations || []; const inBox = (m: any) => !box || (m.x >= box[0] && m.x <= box[2] && m.y >= box[1] && m.y <= box[3]);
      em.marks = []; const listed: any[] = [];
      rows.forEach((m, i) => { if (typeof m.x !== "number" || typeof m.y !== "number" || !inBox(m) || em.marks!.length >= 60) return; em.marks!.push({ x: m.x, y: m.y, label: String(i + 1), color: m.severity === "error" ? "#FF2A2A" : "#FFB000" }); listed.push({ n: i + 1, severity: m.severity, message: m.message, x: m.x, y: m.y, refs: m.refs && m.refs.length ? m.refs : undefined }); });
      result.violations = listed; result.violations_total = rows.length;
    }
    if (em.dim || (em.boxes && em.boxes.length) || (em.marks && em.marks.length) || (em.tags && em.tags.length)) opts.emphasis = em;
    const svg: string = renderPicture(doc, opts);
    const vb = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(svg);
    result.shown_mm = vb ? [Number(vb[1]), Number(vb[2]), Number(vb[1]) + Number(vb[3]), Number(vb[2]) + Number(vb[4])].map(r3) : box;
    result.note = "Coordinates in the image run from the top left of shown_mm, x to the right and y down, in millimetres.";
    return { svg, result };
  });
}

/**
 * compare_versions: what changed in a document between a saved version (a named checkpoint, or any point of the
 * version history) and now, as the Compare window lists it, with a picture of the changed area: the document as
 * it is now with each change boxed in its colour, and on request the older version beside it.
 */
async function compareVersions(req: Request): Promise<Reply> {
  const p = needProject(req); const a = req.args || {};
  const rows: any[] = (await api(`/api/projects/${p.projectId}/versions`)).versions || [];
  return withDocument(req, a.document, async (sess, doc) => {
    const mine = rows.map((v) => ({ v, d: (v.docs || []).find((x: any) => x.docId === sess.entry.docId) })).filter((x) => x.d);
    const names = () => mine.filter((x) => x.v.name).slice(0, 12).map((x) => x.v.name);
    if (!mine.length) throw new ToolError(`${sess.entry.path} has no saved version to compare with yet. create_checkpoint saves one.`);
    let pick = mine[0];
    if (typeof a.with === "string" && a.with.trim() && !/^(last|latest|previous)$/i.test(a.with.trim())) {
      const q = a.with.trim().toLowerCase();
      const hit = mine.find((x) => String(x.v.name || "").toLowerCase() === q) || mine.find((x) => String(x.v.id) === q) || mine.find((x) => String(x.v.name || "").toLowerCase().includes(q));
      if (!hit) throw new ToolError(`There is no checkpoint "${a.with}" of ${sess.entry.path}. The named ones are: ${names().join(", ") || "(none)"}.`);
      pick = hit;
    } else if (/^(last|latest|previous)$/i.test(String(a.with || "").trim()) || a.with === undefined) {
      // the newest saved version that differs from now: the one a person means by "since the last checkpoint"
      pick = mine.find((x) => x.v.name) || mine[0];
    }
    const k = K(); const j = await api(`/api/docs/${sess.entry.docId}/at/${pick.d.seq}`);
    let old: any; try { old = k.parseDoc(j.file, sess.entry.docType); } catch { throw new ToolError("That version could not be read."); }
    for (const op of j.ops || []) for (const c of op.changes || []) { try { k.applyChange(old, c, sess.IU); } catch { /* an edit that does not replay leaves the item as the snapshot had it */ } }
    k.computeBBox(old);
    const diff = diffDocs(k, old, doc); const cap = Math.max(5, Math.min(200, Number(a.limit) || 60));
    const result: any = { document: sess.entry.path, compared_with: pick.v.name || `version of ${pick.v.createdAt}`, saved: pick.v.createdAt, by: pick.v.author || undefined,
      added: diff.counts.added, removed: diff.counts.removed, modified: diff.counts.modified,
      changes: diff.changes.slice(0, cap).map((c) => ({ change: c.category, what: c.label, detail: c.detail || undefined, ref: c.ref, net: c.net, box: c.bbox ? c.bbox.map(r3) : undefined })),
      truncated: diff.changes.length > cap ? `showing ${cap} of ${diff.changes.length}; raise limit or give an area` : undefined };
    if (!diff.changes.length) { result.note = "Nothing differs: the document is as that version left it."; return { result }; }
    if (a.picture === false) return { result };
    let box: number[] | null = Array.isArray(a.area) && a.area.length === 4 ? [Math.min(a.area[0], a.area[2]), Math.min(a.area[1], a.area[3]), Math.max(a.area[0], a.area[2]), Math.max(a.area[1], a.area[3])] : null;
    if (!box) { for (const c of diff.changes) { const b = c.bbox; if (b) box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b.slice(); }
      if (box) { const m = Math.max(doc.type === "sch" ? 8 : 3, 0.15 * Math.max(box[2] - box[0], box[3] - box[1])); box = [box[0] - m, box[1] - m, box[2] + m, box[3] + m]; } }
    const COLORS = { added: "#22C55E", removed: "#EF4444", modified: "#F59E0B" };
    const boxes = (cats: string[]) => diff.changes.filter((c) => c.bbox && cats.includes(c.category)).slice(0, 300).map((c) => [...(c.bbox as number[]), COLORS[c.category]]);
    const hidden = doc.type === "pcb" ? new Set(Array.from(k.PCB_HIDDEN_DEFAULT || [])) : undefined;
    const opts = (cats: string[]) => Object.assign({ hidden, emphasis: { boxes: boxes(cats) } }, box ? { bbox: box, margin: 0 } : {});
    sheetContext(old, sess.entry, p, await projectFile(p));
    const after = renderPicture(doc, opts(["added", "modified", "removed"]));
    result.picture = "The document as it is now. Green boxes: added. Amber: changed or moved. Red: where something was removed.";
    if (a.side_by_side === true) { result.picture = "Two pictures of the same area: first the saved version (red: removed since, amber: changed), then now (green: added, amber: changed)."; return { svgs: [renderPicture(old, opts(["removed", "modified"])), renderPicture(doc, opts(["added", "modified"]))], result }; }
    return { svg: after, result };
  });
}

/** get_bom: the bill of materials of the whole schematic (or of the board), priced and checked for stock. */
async function bomTool(req: Request): Promise<Reply> {
  const p = needProject(req); const a = req.args || {};
  const name = a.document || (rootSchematic(p) || p.docs.find((d) => d.docType === "kicad_pcb") || { path: "" }).path;
  const entry = findDocument(p, name); const others: { name: string; doc: any }[] = [];
  // a schematic's parts are spread over its sheets: the other sheets are read as well
  if (entry.docType === "kicad_sch") for (const d of p.docs.filter((x) => x.docType === "kicad_sch" && x.docId !== entry.docId).slice(0, 40)) { try { others.push({ name: d.path, doc: await session(d).current() }); } catch { /* a sheet that will not open is left out */ } }
  return withDocument(req, entry.path, async (sess, doc) => ({ result: Object.assign({ document: sess.entry.path }, await getBom(K(), doc, others, a, (path) => api(path)) as object) }));
}

/**
 * export_fab: the fabrication package of the board (Gerbers, drill files, BOM and placement, as the fabricator
 * named by the preset takes them), built by the editor's own writers, stored with the project and handed back as
 * a link the person downloads.  The rules check is run first and its result reported with the files: a package
 * of a board with open connections or errors is still made, and says so.
 */
async function exportFab(req: Request): Promise<Reply> {
  const p = needProject(req); const a = req.args || {};
  return withDocument(req, "board", async (sess, doc) => {
    const preset = ["jlcpcb", "pcbway", "kicad"].includes(a.preset) ? a.preset : "jlcpcb";
    const checks: any = await design.runChecks({}); const P = W.PcbTools;
    let open = 0; try { for (const n of P.netlist(doc).nets.values()) open += n.unconnected || 0; } catch { /* reported by the checks */ }
    const pkg = await buildPackage({ doc, setup: sess.file, projectName: p.name } as any, { preset, includeBom: a.bom !== false, includePlacement: a.placement !== false });
    const zipped = await packageZip(pkg);
    let stored: any;
    try {
      const r = await W.fetch(`/api/projects/${p.projectId}/exports?name=${encodeURIComponent(zipped.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: zipped.data });
      if (!r.ok) throw new Error(String(r.status)); stored = await r.json();
    } catch { throw new ToolError("The package was built but could not be stored on the server. Try again."); }
    const sm = pkg.summary;
    return { result: { document: sess.entry.path, preset: pkg.preset.id, download: `${a.__site || conn.base}${stored.path}`, file: stored.name, size_kb: Math.round(stored.bytes / 102.4) / 10, kept_days: stored.keptDays,
      contains: pkg.files.map((f) => (f.note ? `${f.name} (${f.note})` : f.name)),
      board: { width_mm: r3(sm.width), height_mm: r3(sm.height), copper_layers: sm.copperLayers, holes: sm.holes, slots: sm.slots || undefined, parts: sm.parts, placed: sm.placed, bom_lines: sm.bomLines },
      ready: checks.errors === 0 && open === 0 ? true : `Not ready to order: the design rule check has ${checks.errors} error${checks.errors === 1 ? "" : "s"} and ${open} connection${open === 1 ? " is" : "s are"} still open. The files describe the board as it is now.`,
      warnings: pkg.warnings.length ? pkg.warnings : undefined,
      note: "Give the person the download link: it opens for members of the project signed in to the site. Zone fills are plotted as stored; run a fill_zones edit first when the board changed since the last fill." } };
  });
}

/** Who is in the project's documents right now: one document when named, else every sheet and the board. */
async function getSelection(req: Request): Promise<Reply> {
  const p = needProject(req); const a = req.args || {};
  if (typeof a.document === "string" && a.document.trim()) return withDocument(req, a.document, async (sess, doc) => ({ result: await people(sess, doc) }));
  const docs = p.docs.filter(drawable).slice(0, 16); const out: any[] = [];
  // joined together, so the wait for each document's people is spent once
  await Promise.all(docs.map((d) => session(d).current().catch(() => null)));
  for (const d of docs) { try { const r = await withDocument(req, d.path, (sess, doc) => people(sess, doc)); if (r.people.length) out.push({ document: r.document, people: r.people }); } catch { /* a document that would not open has nobody to report */ } }
  return { result: { project: p.name, documents: out, note: out.length ? "Coordinates are millimetres. Only documents somebody has open are listed." : "Nobody else has a document of this project open right now." } };
}

// ---------------------------------------------------------------- comments, checkpoints, projects

async function listComments(req: Request): Promise<Reply> {
  const p = needProject(req); const entry = findDocument(p, req.args.document); const IU = entry.docType === "kicad_sch" ? 1e4 : 1e6;
  const all: any[] = (await api(`/api/docs/${entry.docId}/comments`)).comments || [];
  const row = (c: any) => ({ id: c.id, author: c.authorLogin, text: c.body, at: c.createdAt });
  // what the thread is pinned to: a component (or other item) or a net; absent for a thread pinned to a place
  const pinned = (c: any) => (c.anchor ? (c.anchor.kind === "net" ? { net: c.anchor.label || c.anchor.id } : { on: c.anchor.label || "item" }) : {});
  const threads = all.filter((c) => !c.parentId).filter((c) => req.args.include_resolved || !c.resolved)
    .map((c) => Object.assign(row(c), pinned(c), { x: r3(c.x / IU), y: r3(c.y / IU), resolved: !!c.resolved, replies: all.filter((r) => r.parentId === c.id).map(row) }));
  return { result: { document: entry.path, count: threads.length, comments: threads } };
}

async function addComment(req: Request): Promise<Reply> {
  const p = needProject(req); const a = req.args || {};
  if (!req.canWrite) throw new ToolError("This connection was allowed to read only.");
  if (typeof a.text !== "string" || !a.text.trim()) throw new ToolError("text is required.");
  if (a.reply_to !== undefined) {
    const c = await post(`/api/docs/${findDocument(p, a.document).docId}/comments`, { body: a.text, parentId: Number(a.reply_to) });
    return { result: { id: c.id, reply_to: c.parentId, document: findDocument(p, a.document).path } };
  }
  return withDocument(req, a.document, async (sess, doc) => {
    let x = a.x, y = a.y; let anchor: { kind: "item" | "net"; id: string; label: string; item?: string } | undefined;
    const mid = (it: any) => { const b = it.bbox; return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [it.x || 0, it.y || 0]; };
    if (typeof a.ref === "string" && a.ref) {
      const hit = design.findByRef(doc, a.ref)[0]; if (!hit) throw new ToolError(`There is no ${a.ref} on ${sess.entry.path}.`);
      [x, y] = mid(hit); anchor = { kind: "item", id: hit.id, label: hit.ref || a.ref };
    } else if (typeof a.net === "string" && a.net) {
      const on = netAnchorItem(doc, a.net); if (!on) throw new ToolError(`There is no net ${a.net} on ${sess.entry.path}. list_nets gives the names.`);
      if (typeof x !== "number" || typeof y !== "number") [x, y] = mid(on.item);
      anchor = { kind: "net", id: on.name, label: on.name, item: on.item.kind === "footprint" || on.item.kind === "symbol" ? undefined : on.item.id };
    }
    if (typeof x !== "number" || typeof y !== "number" || !isFinite(x) || !isFinite(y)) throw new ToolError("Say what the comment is about: ref, net, or x and y in millimetres.");
    const c = await post(`/api/docs/${sess.entry.docId}/comments`, { body: a.text, x: Math.round(x * sess.IU), y: Math.round(y * sess.IU), anchor });
    return { result: { id: c.id, document: sess.entry.path, x: r3(x), y: r3(y), on: anchor && anchor.kind === "item" ? anchor.label : undefined, net: anchor && anchor.kind === "net" ? anchor.label : undefined } };
  });
}

/** An item of the document that is on the named net, with the net's name as the document spells it. */
function netAnchorItem(doc: any, name: string): { name: string; item: any } | null {
  const q = name.trim().toLowerCase().replace(/^\//, ""); const same = (n: string) => n.toLowerCase().replace(/^\//, "") === q;
  if (doc.type === "sch") {
    const net = design.schNets(doc).find((n) => same(n.name) || same(n.board) || n.labels.some(same)); if (!net) return null;
    const items = net.ids.map((id: string) => doc.items.get(id)).filter(Boolean);
    const item = items.find((it: any) => /label$/.test(it.kind)) || items.find((it: any) => it.kind === "wire") || items[0];
    return item ? { name: net.name, item } : null;
  }
  const k = design.K();
  for (const it of doc.items.values()) if ((it.kind === "segment" || it.kind === "arc" || it.kind === "via" || it.kind === "zone") && same(k.netNameOf(doc, it.node) || "")) return { name: k.netNameOf(doc, it.node), item: it };
  for (const it of doc.items.values()) if (it.kind === "footprint") for (const p of k.kids(it.node, "pad")) { const n = k.netNameOf(doc, p) || ""; if (n && same(n)) return { name: n, item: it }; }
  return null;
}

async function resolveComment(req: Request): Promise<Reply> {
  if (!req.canWrite) throw new ToolError("This connection was allowed to read only.");
  const c = await post(`/api/comments/${Number(req.args.comment_id)}`, { resolved: req.args.resolved !== false }, "PATCH");
  return { result: { id: c.id, resolved: c.resolved } };
}

async function listCheckpoints(req: Request): Promise<Reply> {
  const p = needProject(req); const rows: any[] = (await api(`/api/projects/${p.projectId}/checkpoints`)).checkpoints || [];
  const by = new Map<string, { name: string; created: string; documents: string[] }>();
  for (const r of rows) { const g = by.get(r.name) || { name: r.name, created: r.createdAt, documents: [] as string[] }; g.documents.push(r.path); if (r.createdAt > g.created) g.created = r.createdAt; by.set(r.name, g); }
  return { result: { project: p.name, checkpoints: Array.from(by.values()).sort((a, b) => b.created.localeCompare(a.created)) } };
}

async function createCheckpoint(req: Request): Promise<Reply> {
  const p = needProject(req); needWrite(req, p);
  if (typeof req.args.name !== "string" || !req.args.name.trim()) throw new ToolError("name is required.");
  const r = await post(`/api/projects/${p.projectId}/checkpoints`, { name: req.args.name.trim() });
  return { result: { checkpoint: r.name, documents: (r.docs || []).map((d: any) => d.path),
    note: "As in the web editor, a checkpoint marks each document's most recent saved file; edits made since that save (by anyone, through any client) come after it in the history." } };
}

async function createProject(req: Request): Promise<Reply> {
  if (!req.canWrite) throw new ToolError("This connection was allowed to read only.");
  if (typeof req.args.name !== "string" || !req.args.name.trim()) throw new ToolError("name is required.");
  // a project with a KiCad project at its root: one schematic sheet and one board (the route's default is an empty project)
  const r = await post("/api/projects/blank", { name: req.args.name.trim(), template: "pcb" });
  return { result: { project_id: r.projectId, name: r.name || req.args.name.trim(), documents: (r.docs || []).map((d: any) => d.path), url: `${req.args.__site || conn.base}/p/${r.projectId}/edit`,
    note: "An empty project: one schematic sheet and one board. Design it with run_python (sch.build for the schematic, then board.sync, autoplace and route), or edit by edit with apply_changes." } };
}

// ---------------------------------------------------------------- dispatch

const TOOLS: Record<string, (req: Request) => Promise<Reply>> = {
  get_design_overview: async (req) => {
    const p = needProject(req); const name = req.args.document || (rootSchematic(p) || p.docs.find((d) => d.docType === "kicad_pcb") || { path: "" }).path;
    if (!name) { W.CollabEditor = editorFor(req, p, null, null); try { return { result: design.overview() }; } finally { W.CollabEditor = null; } }
    return withDocument(req, name, () => { const o: any = design.overview(); delete o.selection; for (const d of o.documents || []) { d.described_below = d.open || undefined; delete d.open; } o.document = o.open_document; delete o.open_document; return { result: o }; });
  },
  list_components: (req) => withDocument(req, req.args.document, async () => ({ result: await design.listComponents(without(req.args)) })),
  get_component: (req) => withDocument(req, req.args.document, async () => ({ result: await design.getComponent(without(req.args) as any) })),
  list_nets: (req) => withDocument(req, req.args.document, async () => ({ result: await design.listNets(without(req.args)) })),
  run_checks: (req) => withDocument(req, req.args.document, async () => ({ result: await design.runChecks({}) })),
  get_items: (req) => withDocument(req, req.args.document, async () => ({ result: await design.getItems(without(req.args)) })),
  fits: (req) => withDocument(req, req.args.document, async () => ({ result: await design.fitsCheck(without(req.args)) })),
  get_geometry: (req) => withDocument(req, req.args.document, async () => ({ result: await design.geometry({ silk: req.args.silk === true }) })),
  check_layout: (req) => withDocument(req, req.args.document, async () => ({ result: await checkLayout({ within: req.args.within, of: req.args.of, wrap: req.args.wrap, limit: req.args.limit, free: req.args.free }) })),
  review_design: (req) => withDocument(req, req.args.document, async () => ({ result: await reviewDesign({ level: req.args.level, rule: req.args.rule, plan: req.args.plan }) })),
  find_datasheets: (req) => withDocument(req, req.args.document, async () => ({ result: await design.findDatasheets(without(req.args)) })),
  get_board_info: (req) => withDocument(req, "board", async () => ({ result: await design.boardInfo() })),
  read_datasheet: async (req) => ({ result: await library.readDatasheet(req.args || {}) }),
  find_parts: async (req) => ({ result: await library.findParts(req.args || {}) }),
  get_library_part: async (req) => ({ result: await library.getLibraryPart(req.args || {}) }),
  apply_changes: (req) => applyChanges(req, req.args && req.args.live === true),
  run_python: runPython,
  undo_changes: undoChanges,
  redo_changes: undoChanges,
  read_document: readDocument,
  render_view: renderView,
  highlight: (req) => withDocument(req, req.args.document, async (sess, doc) => ({ result: await highlight(sess, doc, req.args || {}) })),
  get_selection: getSelection,
  compare_versions: compareVersions,
  get_bom: bomTool,
  export_fab: exportFab,
  list_proposals: listProposals,
  simulate,
  propose_fixes: proposeFixes,
  trace_net: (req) => withDocument(req, req.args.document, async (sess, doc) => {
    const res: any = traceNet(doc, sess.entry.path, req.args.net);
    if (req.args.highlight === true) res.highlight = await highlight(sess, doc, { nets: [req.args.net], note: req.args.note, seconds: req.args.seconds });
    return { result: res };
  }),
  list_comments: listComments,
  add_comment: addComment,
  resolve_comment: resolveComment,
  list_checkpoints: listCheckpoints,
  create_checkpoint: createCheckpoint,
  create_project: createProject,
  // not a person's tool: the server folds a document's journal into a new stored file with it (src/compact.rs)
  fold_ops: async (req) => ({ result: foldOps(K(), String(req.args.docType), String(req.args.file), Array.isArray(req.args.ops) ? req.args.ops : []) }),
};

/** The PCB of each project the electronics tools last worked on, for calls that do not say which. */
const lastPcb = new Map<string, string>();

/**
 * A project may hold several PCBs, each a KiCad project in a folder of its own (web/platform/doctabs/pcbs.ts).
 * The electronics tools work on one at a time, exactly as the browser's editor does: before a tool runs, the
 * request's project is narrowed to the documents of ONE PCB, with paths relative to its folder, so "the board",
 * "the root sheet", the project file and the library tables it finds are that PCB's and no other's.
 *
 * Which PCB: the one `document` names (a path as get_project lists it, "Motor driver/Motor driver.kicad_sch"; or
 * the PCB's name in front of what a document may be called, "Motor driver/board"); a call that names none works on
 * the PCB this connection used last, else the first.  A project that is one PCB at its root is left as it is.
 * Returns what to tell the assistant when there was a choice.
 */
export function scopeToPcb(req: Request): { pcb: string; note: string } | null {
  const p = req.project; if (!p) return null;
  const pcbs = pcbsOf(p.docs, p.name);
  if (!pcbs.length || (pcbs.length === 1 && !pcbs[0].dir)) return null;
  const said = req.args && typeof req.args.document === "string" ? req.args.document.trim().replace(/\\/g, "/") : "";
  const lower = said.toLowerCase();
  let pcb: Pcb<DocEntry> | undefined, within: string | undefined;
  if (said) {
    const whole = p.docs.find((d) => d.docId === said || d.path.toLowerCase() === lower);
    if (whole) { pcb = pcbOfDoc(pcbs, whole.docId); if (pcb) within = relativePath(pcb.dir, whole.path); }
    if (!pcb) {
      // "<PCB folder or name>/<what>", the longest that fits
      const fits = (x: Pcb<DocEntry>): string | null => [x.dir, x.name].filter(Boolean).map((n) => n.toLowerCase()).find((n) => lower === n || lower.startsWith(n + "/")) || null;
      pcb = pcbs.filter((x) => fits(x) !== null).sort((a, b) => fits(b)!.length - fits(a)!.length)[0];
      if (pcb) within = said.slice(fits(pcb)!.length).replace(/^\/+/, "");
    }
  }
  const named = !!pcb;
  if (!pcb) pcb = pcbs.find((x) => x.key === lastPcb.get(p.projectId)) || pcbs[0];
  lastPcb.set(p.projectId, pcb.key);
  if (named) { if (within) req.args.document = within; else delete req.args.document; }
  req.project = { ...p, docs: scopedDocs(p.docs, pcbs, pcb) };
  scope = { projectId: p.projectId, dir: pcb.dir };
  if (pcbs.length < 2) return { pcb: pcb.name, note: "" };
  return { pcb: pcb.name, note: `This project has ${pcbs.length} PCBs: ${pcbs.map((x) => `"${x.name}"`).join(", ")}. This call worked on "${pcb.name}"${named ? "" : " (none was named: the one used last, else the first)"}. Documents are named inside their PCB; to work on another, pass document as "<PCB name>/board", "<PCB name>/schematic" or "<PCB name>/<sheet>.kicad_sch".` };
}

async function handle(req: Request): Promise<any> {
  useFontProject(req.project ? req.project.projectId : "");
  conn = { base: req.base, token: req.token, agent: req.agent || "" };
  // the electronics tools are this file's; every other domain brings its own table (web/domains/mcp-tools.ts)
  const tool = TOOLS[req.tool] || DOMAIN_TOOLS.map((d) => d.tools[req.tool]).find(Boolean);
  if (!tool) return { id: req.id, ok: false, error: `Unknown tool ${req.tool}.` };
  try {
    // the electronics tools see one PCB of the project; the other domains' tools see the whole project
    scope = null;
    const chosen = TOOLS[req.tool] ? scopeToPcb(req) : null;
    const r = await tool(req);
    if (chosen && r && r.result && typeof r.result === "object" && !Array.isArray(r.result)) {
      (r.result as Record<string, unknown>).pcb = chosen.pcb;
      if (chosen.note) (r.result as Record<string, unknown>).pcbs = chosen.note;
    }
    return Object.assign({ id: req.id, ok: true }, r);
  }
  catch (e) {
    const told = e instanceof ToolError || e instanceof McpToolError;
    if (!told) console.error("mcp host: tool failed", req.tool, e);
    return { id: req.id, ok: false, error: told ? plain((e as Error).message) : `The tool failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

let queue: Promise<void> = Promise.resolve(); let lastCall = Date.now(); let busy = 0;
const rl = require("node:readline").createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line: string) => {
  if (!line.trim()) return;
  let req: Request; try { req = JSON.parse(line); } catch { return; }
  busy++;
  queue = queue.then(() => handle(req)).then((out) => { process.stdout.write(JSON.stringify(out) + "\n"); }, (e) => { process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: String(e) }) + "\n"); })
    .then(() => { busy--; lastCall = Date.now(); });
});
rl.on("close", () => process.exit(0));

// Documents nobody asked about for a while are let go (the peer leaves the document), and so is the process.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_IDLE_MS) { s.close(); sessions.delete(id); }
  for (const d of DOMAIN_TOOLS) if (d.sweep) d.sweep(SESSION_IDLE_MS);
  if (!busy && now - lastCall > PROCESS_IDLE_MS) process.exit(0);
}, 30000);
if (typeof (sweep as any).unref === "function") (sweep as any).unref();
process.stdout.write(JSON.stringify({ ready: true }) + "\n");
