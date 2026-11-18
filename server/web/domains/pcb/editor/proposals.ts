// proposals.ts — changes an assistant proposes over MCP (propose_changes), for the people in the document to
// decide on.  A proposal arrives as a "proposal" notice (or is loaded with the document), is listed in a small
// panel over the canvas and previewed on it without touching the design: new and changed items as a ghost,
// green / amber / red boxes for added / changed / removed (web/domains/pcb/ai/proposals.ts showPreview).  Accept applies
// it as the accepting person's own edit, one undo step; Reject records why, for the assistant to read back.
import { clearPreview, previewing, showPreview, staleReason, writeRules, type Proposal } from "../ai/proposals";
import { saveProject } from "../dialogs/project";
import { state } from "./appstore";
import { E } from "./state";
import { commitChanges } from "./tools";
import { ago, api, toast } from "./util";
import { treeExpander } from "../../../shared/components/kicon-dom";

interface Who { login: string; name?: string | null }
interface Row {
  id: string; docId: string; docPath: string; app: string; title: string; rationale: string; status: string; reason: string;
  lines: { kind: "add" | "modify" | "remove"; text: string }[]; connectivity?: string[] | null; rules: boolean;
  createdAt: string; by: Who | null; decidedBy: Who | null;
  body?: { changes: unknown[]; basis: Record<string, string>; rules?: Record<string, number | string> | null };
}

let rows: Row[] = [];
let open = true;                       // the list is unfolded
let rejecting: string | null = null;   // the proposal whose "why" field is showing
const full = new Map<string, Row>();   // proposals with their changes, once fetched

const docId = (): string | null => { const id = (state as unknown as { docId: string | null }).docId; return id && !id.startsWith("board:") && !id.startsWith("lib:") ? id : null; };
const request = api as (path: string, opts?: RequestInit) => Promise<unknown>;
const nameOf = (w: Who | null): string => (w ? w.name || w.login : "Someone");
/** "Nathan's assistant (Claude)": whose assistant it is, and which app. */
const author = (r: Row): string => `${nameOf(r.by)}'s assistant${r.app ? ` (${r.app})` : ""}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e;
}
function panel(): HTMLElement | null {
  let p = document.getElementById("propPanel");
  if (!p) { const host = document.getElementById("cmtPanel")?.parentElement; if (!host) return null; p = el("div"); p.id = "propPanel"; host.appendChild(p);
    // the panel sits on the canvas: what is pressed, scrolled or typed in it is not a canvas gesture
    for (const type of ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu", "keydown"]) p.addEventListener(type, (ev) => ev.stopPropagation()); }
  return p;
}

export async function loadProposals(): Promise<void> {
  const id = docId(); rows = []; full.clear(); rejecting = null; clearPreview(); render();
  if (!id || !(state as unknown as { me: unknown }).me) return;
  try { const j = (await request(`/api/docs/${id}/proposals?status=pending`)) as { proposals?: Row[] }; if (docId() !== id) return; rows = (j.proposals || []).reverse(); } catch { rows = []; }
  render();
}

export function noteProposalMsg(msg: { docId?: string; action?: string; proposal?: Row }): void {
  const p = msg.proposal; if (!p || p.docId !== docId()) return;
  if (msg.action === "added") {
    if (!rows.some((r) => r.id === p.id)) rows.push(p);
    open = true; render();
    if (!previewing()) void preview(p.id, true);
    return;
  }
  const had = rows.some((r) => r.id === p.id); rows = rows.filter((r) => r.id !== p.id); full.delete(p.id);
  if (previewing() === p.id) clearPreview();
  if (rejecting === p.id) rejecting = null;
  render();
  if (!had) return;
  const who = nameOf(p.decidedBy);
  if (p.status === "accepted") toast(`${who} accepted "${p.title}"`, 3500);
  else if (p.status === "rejected") toast(`${who} rejected "${p.title}"`, 3500);
  else if (p.status === "withdrawn") toast(`"${p.title}" was withdrawn`, 3500);
}

async function load(id: string): Promise<Row | null> {
  const have = full.get(id); if (have) return have;
  try { const r = (await request(`/api/proposals/${id}`)) as Row; if (!r.body) return null; full.set(id, r); return r; }
  catch { toast("This proposal could not be loaded"); return null; }
}
const asProposal = (r: Row): Proposal => ({ id: r.id, title: r.title, rationale: r.rationale, docId: r.docId, docPath: r.docPath, lines: r.lines.map((l) => ({ kind: l.kind, text: l.text, ids: [] })),
  changes: (r.body?.changes || []) as Proposal["changes"], basis: r.body?.basis || {}, status: "pending", rules: r.body?.rules || undefined });

async function preview(id: string, quiet = false): Promise<void> {
  const r = await load(id); if (!r || !rows.some((x) => x.id === id) || r.docId !== docId()) return;
  showPreview(asProposal(r), quiet); render();
}

async function settle(id: string, status: string, reason = ""): Promise<boolean> {
  try { await request(`/api/proposals/${id}`, { method: "PATCH", body: JSON.stringify({ status, reason }) }); return true; }
  catch (e) { toast(/409/.test(String(e)) ? "Someone else has already decided this proposal" : "The decision could not be saved. Try again."); void loadProposals(); return false; }
}

async function accept(id: string): Promise<void> {
  if (E.viewOnly) { toast("You have view-only access to this project"); return; }
  const r = await load(id); if (!r) return;
  const p = asProposal(r), stale = staleReason(p);
  if (stale) { toast(stale + " Ask the assistant to propose it again.", 5000); render(); return; }
  // the proposal is claimed first, so two people accepting at once do not apply it twice
  if (!(await settle(id, "accepted"))) return;
  if (p.rules) { const rules = p.rules; try { await saveProject((pro) => writeRules(pro, rules), "board rules"); } catch (e) { console.warn("board rules were not saved:", e); toast("The board rules of this proposal could not be saved"); } }
  if (p.changes.length) commitChanges(p.changes as Parameters<typeof commitChanges>[0], "AI: " + p.title);
  clearPreview();
}

function card(r: Row): HTMLElement {
  const c = el("div", "prop-card" + (previewing() === r.id ? " shown" : "")); c.dataset.proposal = r.id;
  const meta = el("div", "meta"); meta.append(el("b", "", author(r)), el("span", "", ago(r.createdAt)));
  c.append(meta, el("div", "prop-title", r.title));
  if (r.rationale) c.appendChild(el("div", "prop-why", r.rationale));
  const list = el("ul", "prop-lines"), shown = r.lines.slice(0, 8);
  for (const l of shown) { const li = el("li", l.kind, l.text); list.appendChild(li); }
  if (r.lines.length > shown.length) list.appendChild(el("li", "more", `and ${r.lines.length - shown.length} more`));
  c.appendChild(list);
  if (r.connectivity && r.connectivity.length) c.appendChild(el("div", "prop-warn", `Changes connections: ${r.connectivity.slice(0, 3).join("; ")}${r.connectivity.length > 3 ? ` and ${r.connectivity.length - 3} more` : ""}`));
  if (r.rules) c.appendChild(el("div", "prop-note", "Also changes the board rules in the project file."));
  const have = full.get(r.id), stale = have ? staleReason(asProposal(have)) : null;
  if (stale) c.appendChild(el("div", "prop-warn", stale));

  const row = el("div", "row");
  const show = el("button", "btn sm", previewing() === r.id ? "Hide" : "Show"); show.type = "button"; show.dataset.act = "show";
  show.title = "Draw this change over the design without applying it";
  show.addEventListener("click", () => { if (previewing() === r.id) { clearPreview(); render(); } else void preview(r.id); });
  if (E.viewOnly) { row.append(show, el("span", "hint", "Only editors can accept or reject.")); c.appendChild(row); return c; }
  if (rejecting === r.id) {
    const why = el("input"); why.type = "text"; why.placeholder = "Why (optional, the assistant reads it)"; why.maxLength = 300; why.dataset.act = "why";
    const send = el("button", "btn sm", "Reject"), back = el("button", "btn sm", "Cancel"); send.type = "button"; back.type = "button"; send.dataset.act = "reject-send";
    const go = () => { void settle(r.id, "rejected", why.value.trim()); };
    send.addEventListener("click", go); why.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter") go(); if (ev.key === "Escape") { rejecting = null; render(); } });
    back.addEventListener("click", () => { rejecting = null; render(); });
    row.append(why, send, back); c.appendChild(row); setTimeout(() => why.focus(), 0);
    return c;
  }
  const ok = el("button", "btn sm primary", "Accept"), no = el("button", "btn sm", stale ? "Dismiss" : "Reject"); ok.type = "button"; no.type = "button"; ok.dataset.act = "accept"; no.dataset.act = "reject";
  ok.disabled = !!stale; ok.title = "Apply this change to the design as one undo step";
  ok.addEventListener("click", () => { ok.disabled = true; void accept(r.id).finally(() => { ok.disabled = false; }); });
  no.addEventListener("click", () => { if (stale) void settle(r.id, "stale", stale); else { rejecting = r.id; render(); } });
  row.append(ok, no, el("span", "grow"), show); c.appendChild(row);
  return c;
}

function render(): void {
  const p = panel(); if (!p) return;
  p.replaceChildren();
  if (!rows.length) { p.classList.remove("open"); return; }
  p.classList.add("open");
  const head = el("div", "prop-head"), fold = el("button", "prop-fold"); fold.appendChild(treeExpander(open)); fold.type = "button"; fold.title = open ? "Fold" : "Unfold";
  const toggle = () => { open = !open; if (!open) clearPreview(); render(); };
  fold.addEventListener("click", toggle);
  const title = el("span", "prop-heading", rows.length === 1 ? "1 proposed change" : `${rows.length} proposed changes`); title.addEventListener("click", toggle);
  head.append(fold, title); p.appendChild(head);
  if (!open) return;
  const list = el("div", "prop-list"); for (const r of rows) list.appendChild(card(r)); p.appendChild(list);
}
