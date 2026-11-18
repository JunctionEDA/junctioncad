// github/index.ts — the GitHub page (served by src/github.rs, built to static/dist/github.js).
//
//   /github          connect an account, bring a repository folder online as a project
//   /p/<id>/github   one project's link to a repository: what differs, push, pull, merge
//
// Plain DOM on purpose: the page is small, has no canvas, and must not depend on the
// editor bundles (it is reachable from the desktop app's browser hand-off too).

import "../../shared/components/kselect";   // <k-select>, the themed drop-down the page uses in place of <select>
import { askConfirm } from "../../shared/components/msgbox";

// ---------------------------------------------------------------- what the server sends (src/github.rs)
interface GithubApp { name: string; slug: string; url: string }
interface Connection {
  configured: boolean; connected: boolean; login: string; privateRepos?: boolean;
  /** Junction's GitHub App, when the server has one: connecting goes through it. */
  app?: GithubApp | null;
  /** How the stored grant was made: the app (chosen repositories) or the old OAuth `repo` scope. */
  via?: "app" | "oauth" | null;
  /** Connected with the old grant while the app exists: offer the switch. */
  legacy?: boolean;
}
interface Repo { fullName: string; private: boolean; pushedAt?: string; defaultBranch?: string }
/** Something the person should know about the repository: a submodule that cannot be read, a library that is not there. */
interface Note { kind: string; path: string; repo?: string | null; message: string }
interface ScanProject {
  path: string; name: string; files: number;
  /** Every project file in the folder, when there are several (they travel as one online project). */
  projectFiles?: string[];
  /** The project folder this one is inside. */
  inside?: string;
  /** The submodule repository the folder is in. */
  submodule?: string;
  /** Libraries its tables name outside its folder. */
  shared?: { path: string; repoPath?: string | null; found: boolean }[];
  /** The online project already linked to this folder. */
  online?: { projectId: string; name: string; isOwner?: boolean };
}
interface Scan { repo: string; branch: string; branches: string[]; projects: ScanProject[]; truncated: boolean; notes?: Note[] }
interface Imported { path: string; projectId?: string; name?: string; files?: number; shared?: number; existing?: boolean; error?: string; notes?: Note[] }
interface LastAuto { ok: boolean; message?: string; at: string; by?: string; checkpoint?: string; commitUrl?: string | null }
interface Link {
  repo: string; branch: string; path: string; url: string; linkedBy?: string | null; syncedAt?: string | null;
  autoPush: boolean; lastAuto?: LastAuto | null;
}
type FileState = "push" | "pull" | "conflict" | "synced";
interface FileEntry {
  path: string; state: FileState; detail: string; size: number; unsavedOps: number; mergeable: boolean;
  /** The side that deleted the file. */
  deleted?: "online" | "github";
  renamedFrom?: string; renamedOn?: "online" | "github";
  /** Lives outside the project folder (a library several projects share). */
  shared?: boolean;
  /** The repository the file is really in, when that is a submodule. */
  submodule?: string;
}
interface Commit { sha: string; message: string; author?: string; date: string; url?: string }
interface Remote { reachable: boolean; reason?: string; branchExists: boolean; truncated: boolean; canPush: boolean; commits?: Commit[] }
interface Summary { push: number; pull: number; conflict: number; synced: number; unsaved: number }
interface ProjectInfo { projectId: string; name: string; isOwner: boolean; role: string }
interface Missing { reason: "branch" | "folder" | "project"; message: string; candidates: string[] }
interface Removed { id: number; path: string; at: string; size?: number | null; by?: string | null }
interface Status {
  project: ProjectInfo; github: Connection; link: Link | null; remote: Remote; summary: Summary; files: FileEntry[];
  notes?: Note[]; nested?: string[]; submodules?: { path: string; repo: string; commit: string; branch?: string | null }[];
  /** The project is gone from where the link says it is; syncing is paused. */
  missing?: Missing;
  /** The folder was found elsewhere and the link followed it. */
  moved?: { from: string; to: string };
  branchMoved?: { from: string; to: string };
  /** Other online projects linked to the same folder of the same branch. */
  alsoLinked?: { projectId: string; name: string }[];
  /** Where the project was linked until it was unlinked. */
  lastLink?: Where;
  renamedRepo?: { from: string; to: string };
  /** Files a pull removed, kept so they can be put back. */
  removed?: Removed[];
}
interface Change { kind: "added" | "removed" | "changed"; item: string; parts?: string[] }
interface Side { opaque?: boolean; oldSize: number; newSize: number; total: number; changes: Change[] }
interface Diff { hasBase: boolean; online?: Side; github?: Side; between?: Side }
interface PushResult {
  pushed: string[]; deleted?: string[]; blocked?: { path: string; reason: string }[];
  submodules?: { path: string; repo: string; commit: string; commitUrl?: string | null }[];
  commit: string; commitUrl?: string | null; branch: string; pullRequest?: { number: number; url: string };
}
interface PullConflict { item: string; kept: "github" | "online" }
interface PullUpdate { path: string; action: string; from?: string; fromGithub: number; fromOnline: number; conflicts: PullConflict[] }
interface PullResult { updated: PullUpdate[]; skipped: { path: string; reason: string }[]; checkpoint?: string | null }
interface Where { repo: string; branch: string; path: string }
interface ListedProject { projectId: string; name: string; ownerLogin: string; updatedAt: string; github?: Where | null }
type Resolution = "merge" | "github" | "online" | "";

/** A failed request: the server's message, its status and its machine code. */
class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const statusOf = (e: unknown): number | undefined => (e instanceof ApiError ? e.status : undefined);

const app = document.getElementById("app") as HTMLElement;
const projectId: string | null = (location.pathname.match(/^\/p\/([0-9a-f-]{36})\/github\/?$/i) || [])[1] || null;
const here = location.pathname;

// ---------------------------------------------------------------- helpers
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown): string => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ENTITIES[c]);
/** The element matching `sel`. Typed loosely on purpose: the page writes its own markup, so a selector's element kind is known where it is used. */
function $<T extends HTMLElement = HTMLElement>(sel: string, root?: ParentNode): T | null {
  return (root || document).querySelector<T>(sel);
}
/** As `$`, for an element the page has just rendered. */
function need<T extends HTMLElement = HTMLElement>(sel: string, root?: ParentNode): T {
  const el = $<T>(sel, root);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}
function $$<T extends HTMLElement = HTMLElement>(sel: string, root?: ParentNode): T[] {
  return Array.from((root || document).querySelectorAll<T>(sel));
}

async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const init: RequestInit = { credentials: "same-origin", method: opts.method };
  if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers = { "Content-Type": "application/json" }; }
  const r = await fetch(path, init);
  let j: (T & { message?: string; error?: string }) | null = null;
  try { j = await r.json(); } catch (_) { /* not json */ }
  if (!r.ok) throw new ApiError((j && j.message) || `Request failed (${r.status})`, r.status, (j && j.error) || undefined);
  return j as T;
}

function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
  return new Date(iso).toLocaleDateString();
}
const kb = (n: number): string => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " kB" : n + " B");
const plural = (n: number, one: string, many?: string): string => `${n} ${n === 1 ? one : many || one + "s"}`;
const installUrl = (): string => `/auth/github/install?next=${encodeURIComponent(here)}`;
/** The latest connection, for pieces drawn without it in hand (the repository picker). */
let conn: Connection | null = null;
const connectUrl = (access: string): string => `/auth/github/connect?next=${encodeURIComponent(here)}${access ? "&access=" + access : ""}`;

/** Run an async action behind a button: spinner while it runs, the error shown where the page says. */
async function busy(btn: HTMLButtonElement, fn: () => Promise<unknown>): Promise<void> {
  const label = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> ${label}`;
  try { await fn(); }
  catch (e) { showError(e); }
  finally { btn.disabled = false; btn.innerHTML = label; }
}

let flash: { kind: string; html: string } | null = null; // shown once at the top of the next render
function showError(e: unknown): void {
  flash = { kind: "err", html: esc(message(e)) };
  const slot = $("#flash");
  if (slot) slot.innerHTML = flashHtml();
  else render();
}
function flashHtml(): string {
  if (!flash) return "";
  const f = flash; flash = null;
  return `<div class="callout ${f.kind}" role="status">${f.html}</div>`;
}

/** "owner/repo · branch · /folder", the way a link is written everywhere on the page. */
const whereHtml = (w: Where): string =>
  `<b>${esc(w.repo)}</b> <span class="pill">${esc(w.branch)}</span> <span class="pill">/${esc(w.path)}</span>`;

/**
 * Ask, then unlink a project from its repository.  The question says what unlinking does and does not do, so nobody
 * has to guess whether it deletes anything.  Resolves true when the project was unlinked.
 */
async function unlinkProject(id: string, name: string, w: Where | null): Promise<boolean> {
  const from = w ? ` from ${w.repo}` : "";
  const yes = await askConfirm("Unlink from GitHub",
    `Unlink "${name}"${from}?\n\nNothing is deleted, online or on GitHub. Pushing and pulling stop until the project is linked again; `
    + "linking it to the same folder later carries on where it left off.", { ok: "Unlink" });
  if (!yes) return false;
  await api(`/api/projects/${id}/github`, { method: "DELETE" });
  flash = { kind: "ok", html: `Unlinked <b>${esc(name)}</b>${w ? ` from <b>${esc(w.repo)}</b>` : ""}. Nothing was deleted.` };
  return true;
}

// ---------------------------------------------------------------- shared pieces
function connectBox(gh: Connection): string {
  conn = gh;
  if (!gh.configured) {
    return `<section class="box"><h2>GitHub account</h2><div class="in">
      <p>GitHub sign-in is not configured on this server, so repositories can't be connected.</p></div></section>`;
  }
  const appName = esc(gh.app?.name || "Junction");
  if (gh.connected && gh.via === "app") {
    return `<section class="box"><h2>GitHub account</h2><div class="in"><div class="row">
      <div class="grow"><b>${esc(gh.login)}</b> is connected <span class="pill">chosen repositories</span>
        <div class="muted">${appName} sees only the repositories you chose, and can only read and change their files and open pull requests.</div></div>
      <a class="btn small" id="ghChoose" href="${installUrl()}">Choose repositories</a>
      <button class="btn small" id="ghDisconnect">Disconnect</button></div></div></section>`;
  }
  if (gh.connected && gh.legacy) {
    return `<section class="box"><h2>GitHub account</h2><div class="in">
      <div class="callout warn" id="ghLegacy">This connection reaches every repository you have, private ones included.
        Switch to ${appName} to choose which repositories it can see; the old access is then withdrawn on GitHub. Linked projects stay linked.</div>
      <div class="row actions" style="margin-top:10px"><div class="grow"><b>${esc(gh.login)}</b> is connected <span class="pill">all repositories</span></div>
        <a class="btn primary" id="ghSwitch" href="${connectUrl("")}">Switch to chosen repositories</a>
        <button class="btn small" id="ghDisconnect">Disconnect</button></div></div></section>`;
  }
  if (gh.connected) {
    return `<section class="box"><h2>GitHub account</h2><div class="in"><div class="row">
      <div class="grow"><b>${esc(gh.login)}</b> is connected
        <span class="pill">${gh.privateRepos === false ? "public repositories" : "repositories"}</span>
        ${gh.privateRepos === false ? `<div class="muted">Private repositories are not included. <a href="${connectUrl("")}">Add them</a>.</div>` : ""}</div>
      <button class="btn small" id="ghDisconnect">Disconnect</button></div></div></section>`;
  }
  if (gh.app) {
    return `<section class="box"><h2>GitHub account</h2><div class="in">
      <p>Signing in only tells this site who you are. To sync, install ${appName} on the repositories you choose: it can read and change their files and open pull requests, and sees nothing else. You can change the repositories or take access back at any time.</p>
      <div class="row actions"><a class="btn primary" id="ghConnect" href="${connectUrl("")}">Connect repositories</a></div></div></section>`;
  }
  return `<section class="box"><h2>GitHub account</h2><div class="in">
    <p>Signing in only tells this site who you are. To read and write your repositories it needs your permission separately — you can take it back at any time.</p>
    <div class="row actions">
      <a class="btn primary" id="ghConnect" href="${connectUrl("")}">Connect repositories</a>
      <a class="btn" id="ghConnectPublic" href="${connectUrl("public")}">Public repositories only</a>
    </div></div></section>`;
}
function bindConnectBox(after: () => Promise<unknown>): void {
  const d = $<HTMLButtonElement>("#ghDisconnect");
  if (d) d.onclick = () => busy(d, async () => { await api("/api/github", { method: "DELETE" }); await after(); });
}

/** A searchable repository list; calls onPick(fullName, repo). */
function repoPicker(el: HTMLElement, onPick: (fullName: string, repo: Repo | null) => void): void {
  el.innerHTML = `<label class="f">Repository
      <input type="text" id="repoQ" placeholder="Search your repositories, or type owner/name" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <div class="list" id="repoList" style="margin-top:8px"><div class="empty">Loading your repositories…</div></div>`;
  const q = need<HTMLInputElement>("#repoQ", el), list = need("#repoList", el);
  let all: Repo[] = [], picked: string | null = null;
  const draw = () => {
    const needle = q.value.trim().toLowerCase();
    const hits = all.filter((r) => !needle || r.fullName.toLowerCase().includes(needle)).slice(0, 60);
    let html = hits.map((r) => `<button type="button" class="it${r.fullName === picked ? " sel" : ""}" data-repo="${esc(r.fullName)}">
        <span class="nm">${esc(r.fullName)}</span>${r.private ? '<span class="pill">private</span>' : ""}
        <span class="sp"></span><span class="muted">${esc(ago(r.pushedAt))}</span></button>`).join("");
    // A repository that is not in the list (not a member, or beyond the first few hundred) can still be named outright.
    if (/^[\w.-]+\/[\w.-]+$/.test(q.value.trim()) && !hits.some((r) => r.fullName.toLowerCase() === needle)) {
      html += `<button type="button" class="it" data-repo="${esc(q.value.trim())}"><span class="nm">Use ${esc(q.value.trim())}</span></button>`;
    }
    const viaApp = conn?.via === "app";
    list.innerHTML = html || (viaApp && !all.length
      ? `<div class="empty">No repositories chosen yet. <a href="${installUrl()}">Choose repositories</a> for ${esc(conn?.app?.name || "Junction")} to see.</div>`
      : `<div class="empty">No repository matches.</div>`);
    if (viaApp && all.length) list.insertAdjacentHTML("beforeend", `<div class="empty">Missing one? <a class="btn small" href="${installUrl()}">Add repositories</a></div>`);
    $$(".it", list).forEach((b) => (b.onclick = () => {
      const name = b.dataset.repo || "";
      picked = name; draw();
      onPick(name, all.find((r) => r.fullName === name) || null);
    }));
  };
  q.oninput = draw;
  api<{ repos: Repo[] }>("/api/github/repos").then((j) => { all = j.repos; draw(); })
    .catch((e) => { list.innerHTML = `<div class="empty">${esc(message(e))}</div>`; });
}

// ================================================================ /github
async function renderImport(): Promise<void> {
  document.title = "GitHub — Junction";
  let gh: Connection;
  try { gh = await api<Connection>("/api/github"); }
  catch (e) { return renderSignedOut(e); }
  need("#who").textContent = gh.login;
  me = gh.login;

  app.innerHTML = `<div><h1>GitHub</h1>
      <p class="muted">Keep an online project and a repository folder in step: push what changed online, pull what changed on GitHub, and merge item by item when both did.</p></div>
    <div id="flash">${flashHtml()}</div>
    ${connectBox(gh)}
    ${gh.connected ? `<section class="box"><h2>Bring a repository online</h2><div class="in">
        <div id="picker"></div><div id="scan" style="margin-top:12px"></div></div></section>` : ""}
    <section class="box"><h2>Your online projects</h2><div id="mine"><div class="in muted">Loading…</div></div></section>`;
  bindConnectBox(renderImport);

  if (gh.connected) {
    repoPicker(need("#picker"), (full) => scan(full, null));
  }

  loadMine();
}

let me = "";   // the signed-in person's login: only a project's owner links and unlinks it

/** The caller's online projects, each with where it is linked and the way to link or unlink it. */
function loadMine(): void {
  api<{ projects: ListedProject[] }>("/api/projects").then((j) => {
    need("#mine").innerHTML = j.projects.length
      ? j.projects.map((p) => {
          const owner = p.ownerLogin === me;
          return `<div class="commit proj" data-project="${esc(p.projectId)}">
          <span class="msg"><span><a href="/p/${esc(p.projectId)}/github"><b>${esc(p.name)}</b></a> <span class="muted">· ${esc(p.ownerLogin)}</span></span>
            <span class="where">${p.github ? `Linked to ${whereHtml(p.github)}` : `<span class="muted">Not linked to a repository</span>`}</span></span>
          ${p.github
            ? `<a class="btn small" href="/p/${esc(p.projectId)}/github">Sync</a>${owner ? `<button type="button" class="btn small danger" data-unlink="${esc(p.projectId)}">Unlink</button>` : ""}`
            : owner ? `<a class="btn small" href="/p/${esc(p.projectId)}/github">Link to a repository</a>` : ""}</div>`;
        }).join("")
      : `<div class="in muted">No projects yet. Bring one in from a repository above, or start a session from the desktop app.</div>`;
    $$<HTMLButtonElement>("#mine [data-unlink]").forEach((b) => (b.onclick = () => busy(b, async () => {
      const p = j.projects.find((x) => x.projectId === b.dataset.unlink);
      if (p && await unlinkProject(p.projectId, p.name, p.github || null)) await renderImport();
    })));
  }).catch((e) => { need("#mine").innerHTML = `<div class="in muted">${esc(message(e))}</div>`; });
}

const notesHtml = (notes: Note[] | undefined): string =>
  (notes || []).map((n) => `<div class="callout warn" data-note="${esc(n.kind)}">${esc(n.message)}${
    n.kind === "submodule_no_access" && conn?.via === "app" ? ` <a href="${installUrl()}">Choose repositories</a>` : ""}</div>`).join("");

async function scan(full: string, branch: string | null): Promise<void> {
  const el = need("#scan");
  el.innerHTML = `<div class="muted"><span class="spinner"></span> Looking for KiCad projects in ${esc(full)}…</div>`;
  let s: Scan;
  try { s = await api<Scan>(`/api/github/scan?repo=${encodeURIComponent(full)}${branch ? "&branch=" + encodeURIComponent(branch) : ""}`); }
  catch (e) { el.innerHTML = `<div class="callout err">${esc(message(e))}</div>`; return; }
  const branches = s.branches.includes(s.branch) ? s.branches : [s.branch].concat(s.branches);
  const fresh = s.projects.filter((p) => !p.online);
  // What a row says about its project beyond the name: where it sits, what it shares, whether it is online.
  const about = (p: ScanProject): string => {
    const bits: string[] = [];
    if (p.projectFiles) bits.push(`${p.projectFiles.length} project files in this folder (${esc(p.projectFiles.join(", "))}), kept together as one online project`);
    if (p.inside !== undefined) bits.push(`inside the project in <span class="mono">${esc(p.inside || "/")}</span>; its files stay its own`);
    if (p.submodule) bits.push(`a submodule: <span class="mono">${esc(p.submodule)}</span>`);
    for (const l of p.shared || []) bits.push(l.found
      ? `shares <span class="mono">${esc(l.repoPath || l.path)}</span>, which comes along`
      : `<span class="warnText">names <span class="mono">${esc(l.path)}</span>, which is not in the repository</span>`);
    return bits.length ? `<div class="about muted">${bits.join(" · ")}</div>` : "";
  };
  el.innerHTML = `<div class="row" style="margin-bottom:8px">
      <label class="f">Branch <k-select id="scanBranch">${branches.map((b) => `<option${b === s.branch ? " selected" : ""}>${esc(b)}</option>`).join("")}</k-select></label>
      <div class="grow muted">${s.projects.length ? `${plural(s.projects.length, "KiCad project")} in <b>${esc(s.repo)}</b>` : ""}</div></div>
    ${s.truncated ? `<div class="callout warn">This repository is too large for GitHub to list completely; some folders may be missing.</div>` : ""}
    ${notesHtml(s.notes)}
    <div class="list" id="scanList">${s.projects.length ? s.projects.map((p, i) => `<label class="it pick${p.online ? " isOnline" : ""}">
        ${p.online ? `<span class="tick"></span>` : `<input type="checkbox" data-pick="${i}"${fresh.length === 1 ? " checked" : ""}>`}
        <span class="what"><span class="line"><span class="nm">${esc(p.name)}</span><span class="muted mono">${esc(p.path || "/")}</span></span>${about(p)}</span>
        <span class="sp"></span><span class="muted">${plural(p.files, "file")}</span>
        ${p.online ? `<span class="pill synced" title="This folder is already an online project">online</span>
          <a class="btn small" href="/p/${esc(p.online.projectId)}/github" data-open="${i}">Open sync</a>
          ${p.online.isOwner ? `<button type="button" class="btn small danger" data-unlink-scan="${i}">Unlink</button>` : ""}` : ""}</label>`).join("")
      : `<div class="empty">No KiCad files on this branch.</div>`}</div>
    ${fresh.length ? `<div class="row actions" style="margin-top:10px">
      ${fresh.length > 1 ? `<label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="pickAll"> Select all</label>` : ""}
      <span class="grow muted" id="pickNote">Each project becomes its own online project, linked to its folder.</span>
      <button class="btn primary" id="doImport" disabled>Bring online</button></div>` : ""}
    <div id="imported"></div>`;
  const pick = need<HTMLSelectElement>("#scanBranch");
  pick.onchange = () => scan(full, pick.value);
  const boxes = $$<HTMLInputElement>("[data-pick]", el);
  const go = $<HTMLButtonElement>("#doImport"), all = $<HTMLInputElement>("#pickAll");
  const chosen = (): ScanProject[] => boxes.filter((b) => b.checked).map((b) => s.projects[Number(b.dataset.pick)]);
  const sync = (): void => {
    const n = chosen().length;
    if (go) { go.disabled = !n; go.textContent = n > 1 ? `Bring ${n} projects online` : "Bring online"; }
    if (all) { all.checked = n === boxes.length; all.indeterminate = n > 0 && n < boxes.length; }
  };
  $$<HTMLButtonElement>("[data-unlink-scan]", el).forEach((b) => (b.onclick = (ev) => {
    ev.preventDefault();
    const p = s.projects[Number(b.dataset.unlinkScan)];
    if (!p.online) return;
    const o = p.online;
    void busy(b, async () => {
      if (!await unlinkProject(o.projectId, o.name, { repo: s.repo, branch: s.branch, path: p.path })) return;
      const slot = $("#flash"); if (slot) slot.innerHTML = flashHtml();
      loadMine();
      await scan(full, s.branch);
    });
  }));
  boxes.forEach((b) => (b.onchange = sync));
  if (all) all.onchange = () => { boxes.forEach((b) => (b.checked = all.checked)); sync(); };
  sync();
  if (go) go.onclick = () => busy(go, async () => {
    const picks = chosen();
    const j = await api<{ projects: Imported[] }>("/api/github/import", { method: "POST", body: { repo: s.repo, branch: s.branch, paths: picks.map((p) => p.path) } });
    const made = j.projects.filter((p) => p.projectId && !p.error);
    // One project with nothing to tell: straight to it.
    if (j.projects.length === 1 && made.length === 1 && !(made[0].notes || []).length) { location.href = `/p/${made[0].projectId}/github`; return; }
    await scan(full, s.branch);
    need("#imported").innerHTML = `<div class="callout ${j.projects.some((p) => p.error) ? "warn" : "ok"}" id="importResult" style="margin-top:10px">
      ${made.length ? `Brought ${plural(made.filter((p) => !p.existing).length, "project")} online:` : "Nothing was brought online:"}
      <ul>${j.projects.map((p) => p.error
        ? `<li><span class="mono">${esc(p.path || "/")}</span> — ${esc(p.error)}</li>`
        : `<li><a href="/p/${esc(p.projectId)}/github"><b>${esc(p.name)}</b></a> <span class="muted mono">${esc(p.path || "/")}</span> — ${
            p.existing ? "was online already" : `${plural(p.files || 0, "file")}${p.shared ? `, ${p.shared} of them shared from outside its folder` : ""}`}${
            (p.notes || []).map((n) => `<div class="muted">${esc(n.message)}</div>`).join("")}</li>`).join("")}</ul></div>`;
  });
}

function renderSignedOut(e: unknown): void {
  if (e && statusOf(e) !== 401) { app.innerHTML = `<div class="callout err">${esc(message(e))}</div>`; return; }
  app.innerHTML = `<section class="box"><h2>GitHub</h2><div class="in">
    <p>Sign in to connect repositories to your online projects.</p>
    <a class="btn primary" href="/auth/github/login?next=${encodeURIComponent(here)}">Sign in with GitHub</a></div></section>`;
}

// ================================================================ /p/<id>/github
let st: Status | null = null;                        // last status
const resolve: Record<string, Resolution> = {};      // how to settle each file changed on both sides
let lastResult: string | null = null;                // html of the last push/pull outcome

// ---------------------------------------------------------------- what changed inside a file
const openDiffs = new Set<string>();                 // paths whose change list is expanded
const diffs: Record<string, Diff | { error: string } | undefined> = {};   // undefined while loading

async function loadDiff(path: string): Promise<void> {
  diffs[path] = undefined;
  try { diffs[path] = await api<Diff>(`/api/projects/${projectId}/github/diff?path=${encodeURIComponent(path)}`); }
  catch (e) { diffs[path] = { error: message(e) }; }
  const cell = $$("[data-diffbody]").find((c) => c.dataset.diffbody === path);
  if (cell) cell.innerHTML = diffHtml(path);
}

function changeList(title: string, side: Side | undefined): string {
  if (!side) return "";
  let body: string;
  if (side.opaque) body = `<p class="muted">This file type can't be compared item by item (${kb(side.oldSize)} → ${kb(side.newSize)}).</p>`;
  else if (!side.total) body = `<p class="muted">No changes.</p>`;
  else body = `<ul class="changes">${side.changes.map((c) => `<li><span class="k ${c.kind}">${c.kind}</span> ${esc(c.item)}${
      c.parts && c.parts.length ? ` <span class="muted">— ${esc(c.parts.join(", "))}</span>` : ""}</li>`).join("")}${
      side.total > side.changes.length ? `<li class="muted">…and ${side.total - side.changes.length} more</li>` : ""}</ul>`;
  return `<div class="side"><h3>${title}${side.total ? ` <span class="muted">(${side.total})</span>` : ""}</h3>${body}</div>`;
}

function diffHtml(path: string): string {
  const d = diffs[path];
  if (!d) return `<div class="muted"><span class="spinner"></span> Comparing…</div>`;
  if ("error" in d) return `<div class="callout err">${esc(d.error)}</div>`;
  if (d.hasBase) return `<div class="sides">${changeList("Changed online", d.online)}${changeList("Changed on GitHub", d.github)}</div>`;
  return `<div class="sides">${changeList("Online, compared with GitHub", d.between)}</div>
    <p class="muted" style="margin-top:6px">These two were never synced, so there is no common version to tell who changed what.</p>`;
}

async function loadStatus(): Promise<void> {
  let now: Status;
  try { now = await api<Status>(`/api/projects/${projectId}/github`); }
  catch (e) {
    const code = statusOf(e);
    if (code === 401) return renderSignedOut(e);
    app.innerHTML = `<div class="callout err">${esc(code === 403 || code === 404 ? "You don't have access to this project." : message(e))}</div>`;
    return;
  }
  st = now;
  render();
  // A refresh may have changed the files: re-read the open change lists, close those that no longer apply.
  openDiffs.forEach((p) => {
    if (now.files && now.files.some((f) => f.path === p && f.state !== "synced")) loadDiff(p); else openDiffs.delete(p);
  });
}

/** One sentence saying where things stand and what to press next. */
function nextStep(s: Summary, canPush: boolean, branch: string): string {
  const files = (n: number): string => plural(n, "file");
  if (s.conflict) {
    return `<b>${files(s.conflict)} changed both online and on GitHub.</b> Choose what to keep for each in the list below, then press Pull`
      + (s.push ? "; after that, Push sends your online changes." : ".");
  }
  if (s.pull && s.push) return `<b>GitHub has ${files(s.pull)} to bring online, and ${files(s.push)} changed online.</b> Pull first, then Push.`;
  if (s.pull) return `<b>GitHub has changes in ${files(s.pull)} that are not online yet.</b> Press Pull to bring them in.`;
  if (s.push) return canPush
    ? `<b>${files(s.push)} changed online since the last sync.</b> Press Push to commit ${s.push === 1 ? "it" : "them"} to <b>${esc(branch)}</b>.`
    : `<b>${files(s.push)} changed online</b>, but your GitHub account cannot write to this repository.`;
  return `Everything is in sync with <b>${esc(branch)}</b>. Nothing to push or pull.`;
}

const STATE_LABEL: Record<FileState, string> = { push: "push", pull: "pull", conflict: "both changed", synced: "in sync" };

function render(): void {
  if (!projectId) { renderImport(); return; }
  if (!st) return;
  const status = st;
  const p = status.project, gh = status.github, link = status.link;
  document.title = `${p.name} — GitHub — Junction`;
  need("#crumb").textContent = "· " + p.name;
  need("#who").textContent = gh.login;
  const back = need<HTMLAnchorElement>("#back"); back.classList.remove("hide"); back.href = `/p/${p.projectId}/edit`;

  let html = `<div id="flash">${flashHtml()}</div>`;
  if (lastResult) { html += lastResult; }

  if (!link) {
    const last = status.lastLink;
    html += `<div><h1>${esc(p.name)}</h1><p class="muted">This project is not linked to a repository${last ? "" : " yet"}. Link it to a folder of a GitHub repository to push its files there and pull changes made with git.</p></div>`;
    html += connectBox(gh);
    if (!p.isOwner) html += `<div class="callout">Only the project's owner can link it to a repository.</div>`;
    else if (gh.connected) {
      if (last) html += `<section class="box" id="lastLink"><h2>Link it again</h2><div class="in"><div class="row">
          <div class="grow">It was linked to ${whereHtml(last)}<div class="muted">Linking it there again carries on where it left off: what you changed since is ready to push.</div></div>
          <button class="btn primary" id="relink">Link again</button></div></div></section>`;
      html += linkForm(p, gh, !!last);
    }
    app.innerHTML = html;
    bindConnectBox(loadStatus);
    if (p.isOwner && gh.connected) {
      bindLinkForm();
      const again = $<HTMLButtonElement>("#relink");
      if (again && last) again.onclick = () => busy(again, async () => {
        await api(`/api/projects/${projectId}/github`, { method: "PUT", body: { repo: last.repo, branch: last.branch, path: last.path } });
        flash = { kind: "ok", html: `Linked to <b>${esc(last.repo)}</b> again.` };
        await loadStatus();
      });
    }
    return;
  }

  html += `<section class="box"><h2>${esc(p.name)}<span class="sp"></span><span class="pill synced" id="linked">linked</span></h2><div class="in">
      <div class="row"><div class="grow">
        <span class="muted">Linked to</span> <a href="${esc(link.url)}" target="_blank" rel="noreferrer" title="Open this folder on GitHub"><b>${esc(link.repo)}</b></a>
        <span class="pill" title="Branch">${esc(link.branch)}</span> <span class="pill" title="Folder in the repository">/${esc(link.path)}</span>
        <div class="muted">${link.syncedAt ? `Last synced ${esc(ago(link.syncedAt))}` : "Not synced yet"}${link.linkedBy ? ` · linked by ${esc(link.linkedBy)}` : ""}</div>
      </div><button class="btn small" id="refresh" title="Look at GitHub again">Refresh</button>
      ${p.isOwner ? `<button class="btn small danger" id="unlink" title="Stop syncing with this repository. Nothing is deleted.">Unlink</button>` : ""}</div></div></section>`;

  if (!gh.connected) {
    html += connectBox(gh);
    app.innerHTML = html; bindConnectBox(loadStatus); bindCommon();
    return;
  }
  conn = gh;
  if (gh.legacy) {
    html += `<div class="callout warn" id="ghLegacy">Your GitHub connection reaches every repository you have.
      <a href="${connectUrl("")}">Switch to chosen repositories</a>; this link keeps working.</div>`;
  }
  const r = status.remote;
  if (!r.reachable) {
    html += `<div class="callout err">${esc(r.reason)}</div>`;
    app.innerHTML = html; bindCommon();
    return;
  }

  const s = status.summary, files = status.files;
  const canWrite = p.role === "editor";
  if (status.renamedRepo) html += `<div class="callout ok" id="renamedRepo">The repository was renamed on GitHub from <b>${esc(status.renamedRepo.from)}</b> to <b>${esc(status.renamedRepo.to)}</b>. The link follows it.</div>`;
  if (status.alsoLinked?.length) {
    const names = status.alsoLinked.map((o) => `<a href="/p/${esc(o.projectId)}/github">${esc(o.name)}</a>`).join(", ");
    html += `<div class="callout warn" id="also-linked">This folder is also linked to ${status.alsoLinked.length > 1 ? "other online projects" : "another online project"}: ${names}. Both can sync: what one pushes, the other pulls, and a file changed in both is a conflict to settle, never overwritten.</div>`;
  }
  if (status.branchMoved) html += `<div class="callout ok" id="branch-moved">The branch <span class="mono">${esc(status.branchMoved.from)}</span> is no longer on GitHub. The project is on <span class="mono">${esc(status.branchMoved.to)}</span>, and the link follows it there.</div>`;
  if (status.moved) html += `<div class="callout ok" id="moved">The project's folder moved on GitHub from <span class="mono">${esc(status.moved.from || "/")}</span> to <span class="mono">${esc(status.moved.to || "/")}</span>. The link follows it, and nothing was duplicated.</div>`;

  // Gone from where the link points: nothing is compared, nothing is pushed or pulled until the person says what to do.
  const missing = status.missing;
  if (missing) {
    html += `<section class="box" id="missing"><h2>The project is no longer on GitHub where it was</h2><div class="in">
      <div class="callout warn">${esc(missing.message)}</div>
      ${missing.candidates.length ? `<p style="margin-top:10px">It may have moved. Folders on <b>${esc(link.branch)}</b> that hold its files:</p>
        <div class="list">${missing.candidates.map((c) => `<div class="it" style="cursor:default"><span class="nm mono">${esc(c || "/")}</span><span class="sp"></span>
          ${canWrite ? `<button class="btn small primary" data-relocate="${esc(c)}">Link to this folder</button>` : ""}</div>`).join("")}</div>` : ""}
      ${canWrite ? `<div class="row actions" style="margin-top:12px">
        <span class="grow muted">${missing.reason === "branch" ? "Putting it back creates the branch again." : "Putting it back adds the online project's files to the repository again, in a new commit."} Your online project is untouched either way.</span>
        ${r.canPush ? `<button class="btn" id="restoreProject">Put it back on GitHub</button>` : ""}</div>` : ""}
    </div></section>`;
    html += notesHtml(status.notes);
    html += removedHtml(status, canWrite);
    app.innerHTML = html;
    bindCommon(); bindMissing();
    return;
  }
  html += notesHtml(status.notes);
  if (status.nested && status.nested.length) html += `<div class="callout" id="nested">${status.nested.length === 1 ? "The folder" : "The folders"} ${status.nested.map((n) => `<span class="mono">${esc(n)}</span>`).join(", ")} ${status.nested.length === 1 ? "is a project of its own" : "are projects of their own"} and ${status.nested.length === 1 ? "is" : "are"} not part of this one. <a href="/github">Bring ${status.nested.length === 1 ? "it" : "them"} online</a> separately.</div>`;
  if (status.submodules && status.submodules.length) html += `<div class="callout" id="submodules">Some of these files are in ${status.submodules.length === 1 ? "a submodule" : "submodules"}: ${status.submodules.map((m) => `<span class="mono">${esc(m.path)}</span> (<b>${esc(m.repo)}</b>)`).join(", ")}. A push commits them to that repository and moves <b>${esc(link.repo)}</b> to the new commit.</div>`;
  const chip = (cls: string, n: number, text: string): string => `<div class="chip ${n ? cls : "zero"}"><b>${n}</b><span>${text}</span></div>`;
  html += `<div class="chips">${chip("push", s.push, "to push")}${chip("pull", s.pull, "to pull")}${chip("conflict", s.conflict, "changed on both")}${chip("synced", s.synced, "in sync")}</div>`;

  if (!r.branchExists) html += `<div class="callout">The branch <b>${esc(link.branch)}</b> does not exist on GitHub yet. The first push creates it.</div>`;
  if (r.truncated) html += `<div class="callout warn">This repository is too large for GitHub to list completely; some files may be missing from the comparison.</div>`;
  if (s.unsaved) html += `<div class="callout warn">${plural(s.unsaved, "document has", "documents have")} live edits that are not saved into the project file yet. Pushing asks an open desktop app to save first; without one, the last saved version is what gets pushed.</div>`;
  if (!canWrite) html += `<div class="callout">You can view this project's sync state. Pushing and pulling need edit access.</div>`;
  else if (!r.canPush) html += `<div class="callout warn">Your GitHub account can read <b>${esc(link.repo)}</b> but not write to it, so you can pull but not push.</div>`;

  if (canWrite) {
    const nothing = !s.push && !s.pull && !s.conflict;
    html += `<section class="box"><h2>Sync</h2><div class="in">
      <p id="next" class="${nothing ? "muted" : ""}" style="margin-bottom:10px">${nextStep(s, r.canPush, link.branch)}</p>
      <div class="row actions">
        <button class="btn primary" id="pull" ${s.pull || s.conflict ? "" : `disabled title="Nothing on GitHub to bring online"`}>Pull from GitHub${s.pull + s.conflict ? ` (${s.pull + s.conflict})` : ""}</button>
        <button class="btn primary" id="push" ${s.push && r.canPush ? "" : `disabled title="${!r.canPush ? "Your GitHub account cannot write to this repository" : s.conflict ? "Settle the files changed on both sides first (Pull)" : "Nothing online that GitHub does not have"}"`}>Push to GitHub${s.push ? ` (${s.push})` : ""}</button>
      </div>
      <div class="row" style="margin-top:12px">
        <label class="f grow">Commit message <input type="text" id="msg" placeholder="Update ${esc(p.name)} from Junction" maxlength="200"></label>
        <label class="muted" style="display:flex;gap:6px;align-items:center;min-height:34px"><input type="checkbox" id="asPr" ${r.branchExists ? "" : "disabled"}> Open a pull request instead</label>
      </div>
      <div class="row" style="margin-top:12px">
        <label class="muted" style="display:flex;gap:6px;align-items:center;min-height:34px"><input type="checkbox" id="autoPush" ${link.autoPush ? "checked" : ""}> Push to GitHub every time a checkpoint is saved</label>
      </div>
      ${link.autoPush && link.lastAuto ? `<div class="callout ${link.lastAuto.ok ? "ok" : "warn"}" id="lastAuto" style="margin-top:8px">Checkpoint <b>${esc(link.lastAuto.checkpoint || "")}</b>, ${esc(ago(link.lastAuto.at))}${link.lastAuto.by ? ` by ${esc(link.lastAuto.by)}` : ""}: ${link.lastAuto.ok ? "" : "not pushed. "}${esc(link.lastAuto.message || "")}${link.lastAuto.commitUrl ? ` · <a href="${esc(link.lastAuto.commitUrl)}" target="_blank" rel="noreferrer">view commit</a>` : ""}</div>` : ""}
      ${s.conflict ? `<div class="row" style="margin-top:12px"><span class="muted">When both sides changed the same item, keep</span>
          <span class="seg" id="prefer"><button type="button" data-v="online" class="on">the online version</button><button type="button" data-v="github">GitHub's version</button></span></div>` : ""}
    </div></section>`;
  }

  html += `<section class="box"><h2>Files<span class="sp"></span><span class="muted" style="font-weight:400">${plural(files.length, "file")}</span></h2>
    <table class="files"><thead><tr><th>File</th><th>State</th><th>What changed</th><th></th></tr></thead><tbody>
    ${files.map((f) => `<tr>
      <td class="path">${esc(f.path)}${f.renamedFrom ? `<div class="muted was">was ${esc(f.renamedFrom)}</div>` : ""}${
        f.shared || f.submodule ? `<div class="tags">${f.shared ? `<span class="pill" title="Outside the project folder: a file this project shares with others">shared</span>` : ""}${
          f.submodule ? `<span class="pill" title="This file is in a submodule">${esc(f.submodule)}</span>` : ""}</div>` : ""}</td>
      <td class="st"><span class="pill ${f.state}">${STATE_LABEL[f.state]}</span></td>
      <td class="detail">${esc(f.detail)}${f.unsavedOps > 0 ? ` · ${plural(f.unsavedOps, "unsaved edit")}` : ""} <span class="muted">· ${kb(f.size)}</span></td>
      <td class="act">${f.state === "conflict" && canWrite ? `<k-select data-resolve="${esc(f.path)}" aria-label="How to resolve ${esc(f.path)}">
          ${f.deleted === "github" ? `<option value="">Choose…</option><option value="online">Keep it online</option><option value="github">Remove it online too</option>`
            : f.deleted === "online" ? `<option value="">Choose…</option><option value="github">Bring it back</option><option value="online">Delete on GitHub too</option>`
            : `${f.mergeable ? `<option value="merge">Merge both</option>` : `<option value="">Choose…</option>`}
          <option value="github">Use GitHub's</option><option value="online">Keep online</option>`}</k-select>` : ""}${
          f.state !== "synced" && !f.deleted ? `<button class="btn small" data-diff="${esc(f.path)}" aria-expanded="${openDiffs.has(f.path)}">Changes</button>` : ""}</td></tr>
      ${f.state !== "synced" && openDiffs.has(f.path) ? `<tr class="diffrow"><td colspan="4" data-diffbody="${esc(f.path)}">${diffHtml(f.path)}</td></tr>` : ""}`).join("")
      || `<tr><td colspan="4" class="muted">No KiCad files on either side yet.</td></tr>`}
    </tbody></table></section>`;

  html += removedHtml(status, canWrite);

  if (r.commits && r.commits.length) {
    html += `<section class="box"><h2>Recent commits on ${esc(link.branch)}</h2>
      ${r.commits.map((c) => `<div class="commit"><a class="mono" href="${esc(c.url || "#")}" target="_blank" rel="noreferrer">${esc(String(c.sha).slice(0, 7))}</a>
        <span class="msg">${esc(c.message)}</span><span class="muted">${esc(c.author || "")} · ${esc(ago(c.date))}</span></div>`).join("")}</section>`;
  }

  app.innerHTML = html;
  bindCommon(); bindRemoved();
  $$<HTMLSelectElement>("[data-resolve]").forEach((sel) => {
    const path = sel.dataset.resolve || "";
    const chosen = resolve[path];
    if (chosen !== undefined) sel.value = chosen;
    sel.onchange = () => { resolve[path] = sel.value as Resolution; };
  });
  $$("[data-diff]").forEach((b) => (b.onclick = () => {
    const path = b.dataset.diff || "";
    if (openDiffs.has(path)) openDiffs.delete(path); else { openDiffs.add(path); loadDiff(path); }
    render();
  }));
  const seg = $("#prefer");
  if (seg) $$("button", seg).forEach((b) => (b.onclick = () => { $$("button", seg).forEach((x) => x.classList.toggle("on", x === b)); }));
  const auto = $<HTMLInputElement>("#autoPush");
  if (auto) auto.onchange = async () => {
    auto.disabled = true;
    try {
      await api(`/api/projects/${projectId}/github/settings`, { method: "POST", body: { autoPush: auto.checked } });
      link.autoPush = auto.checked;
      render();
    } catch (e) { auto.checked = !auto.checked; auto.disabled = false; showError(e); }
  };
  const pullBtn = $<HTMLButtonElement>("#pull"), pushBtn = $<HTMLButtonElement>("#push");
  if (pullBtn) pullBtn.onclick = () => busy(pullBtn, () => doPull(false));
  if (pushBtn) pushBtn.onclick = () => busy(pushBtn, doPush);
}

/** Files a pull removed because they were deleted on GitHub, each with a way back. */
function removedHtml(status: Status, canWrite: boolean): string {
  if (!status.removed || !status.removed.length) return "";
  return `<section class="box" id="removed"><h2>Removed by a pull<span class="sp"></span><span class="muted" style="font-weight:400">kept so they can be put back</span></h2>
    ${status.removed.map((x) => `<div class="commit"><span class="mono msg">${esc(x.path)}</span>
      <span class="muted">${x.size != null ? kb(x.size) + " · " : ""}${esc(ago(x.at))}${x.by ? ` · ${esc(x.by)}` : ""}</span>
      ${canWrite ? `<button class="btn small" data-putback="${x.id}">Put back</button>` : ""}</div>`).join("")}</section>`;
}
function bindRemoved(): void {
  $$<HTMLButtonElement>("[data-putback]").forEach((b) => (b.onclick = () => busy(b, async () => {
    const j = await api<{ path: string }>(`/api/projects/${projectId}/github/restore-file`, { method: "POST", body: { id: Number(b.dataset.putback) } });
    lastResult = `<div class="callout ok" id="result"><span class="mono">${esc(j.path)}</span> is back in the project. Push to add it to GitHub again.</div>`;
    await loadStatus();
  })));
}
function bindMissing(): void {
  bindRemoved();
  $$<HTMLButtonElement>("[data-relocate]").forEach((b) => (b.onclick = () => busy(b, async () => {
    await api(`/api/projects/${projectId}/github/relocate`, { method: "POST", body: { path: b.dataset.relocate || "" } });
    lastResult = `<div class="callout ok" id="result">Linked to <span class="mono">${esc(b.dataset.relocate || "/")}</span>. What was synced before still counts.</div>`;
    await loadStatus();
  })));
  const rs = $<HTMLButtonElement>("#restoreProject");
  if (rs) rs.onclick = () => busy(rs, async () => {
    const j = await api<PushResult>(`/api/projects/${projectId}/github/push`, { method: "POST", body: { restore: true } });
    lastResult = pushedHtml(j);
    await loadStatus();
  });
}

function bindCommon(): void {
  const rf = $<HTMLButtonElement>("#refresh"); if (rf) rf.onclick = () => busy(rf, async () => { lastResult = null; await loadStatus(); });
  const un = $<HTMLButtonElement>("#unlink");
  if (un) un.onclick = () => busy(un, async () => {
    if (!st || !st.link || !projectId) return;
    if (await unlinkProject(projectId, st.project.name, st.link)) { lastResult = null; await loadStatus(); }
  });
}

/** What a push did: files written and removed, where, and what was held back and why. */
function pushedHtml(j: PushResult): string {
  const sha = String(j.commit).slice(0, 7);
  const n = j.pushed.length, d = (j.deleted || []).length;
  const what = [n || !d ? `Pushed ${plural(n, "file")}` : "", d ? `${n ? "removed" : "Removed"} ${plural(d, "file")}` : ""].filter(Boolean).join(" and ");
  const subs = (j.submodules || []).map((m) => ` The files in <span class="mono">${esc(m.path)}</span> went to <b>${esc(m.repo)}</b>${
    m.commitUrl ? ` (<a class="mono" href="${esc(m.commitUrl)}" target="_blank" rel="noreferrer">${esc(String(m.commit).slice(0, 7))}</a>)` : ""}.`).join("");
  const held = (j.blocked || []).length
    ? `<div class="callout warn" id="blocked" style="margin-top:8px">Held back:<ul>${(j.blocked || []).map((b) => `<li><span class="mono">${esc(b.path)}</span> — ${esc(b.reason)}</li>`).join("")}</ul></div>` : "";
  return `<div id="result">` + (j.pullRequest
    ? `<div class="callout ok">${what} to <b>${esc(j.branch)}</b> and opened <a href="${esc(j.pullRequest.url)}" target="_blank" rel="noreferrer">pull request #${esc(j.pullRequest.number)}</a>. The files show as in sync once it is merged.</div>`
    : `<div class="callout ok">${what} on <b>${esc(j.branch)}</b> as ${j.commitUrl ? `<a class="mono" href="${esc(j.commitUrl)}" target="_blank" rel="noreferrer">${esc(sha)}</a>` : `<span class="mono">${esc(sha)}</span>`}.${subs}</div>`) + held + `</div>`;
}

async function doPush(): Promise<void> {
  const body = { message: need<HTMLInputElement>("#msg").value, pullRequest: need<HTMLInputElement>("#asPr").checked };
  const j = await api<PushResult>(`/api/projects/${projectId}/github/push`, { method: "POST", body });
  lastResult = pushedHtml(j);
  await loadStatus();
}

async function doPull(force: boolean): Promise<void> {
  const seg = $("#prefer");
  const prefer = seg ? $(".on", seg)?.dataset.v : "online";
  const res: Record<string, Resolution> = {};
  (st ? st.files : []).filter((f) => f.state === "conflict").forEach((f) => {
    const v: Resolution = resolve[f.path] !== undefined ? resolve[f.path] : (f.mergeable ? "merge" : "");
    if (v) res[f.path] = v;
  });
  const j = await api<PullResult>(`/api/projects/${projectId}/github/pull`, { method: "POST", body: { resolve: res, prefer, force } });
  const lines = j.updated.map((u) => {
    let t = `<span class="mono">${esc(u.path)}</span> — ${esc(u.action)}${u.from ? ` (was <span class="mono">${esc(u.from)}</span>)` : ""}`;
    if (u.action === "removed") t += "; its content is kept below, to put back";
    if (u.action === "merged") {
      t += `: ${plural(u.fromGithub, "change")} from GitHub, ${plural(u.fromOnline, "change")} kept from online`;
      if (u.conflicts.length) {
        t += `; ${plural(u.conflicts.length, "item")} changed on both sides:<ul>` +
          u.conflicts.slice(0, 12).map((c) => `<li>${esc(c.item)} — kept the ${c.kept === "github" ? "GitHub" : "online"} version</li>`).join("") +
          (u.conflicts.length > 12 ? `<li>…and ${u.conflicts.length - 12} more</li>` : "") + `</ul>`;
      }
    }
    return `<li>${t}</li>`;
  });
  const skipped = j.skipped.map((s) => `<li><span class="mono">${esc(s.path)}</span> — ${esc(s.reason)}</li>`);
  const needsForce = j.skipped.some((s) => /live edits/.test(s.reason));
  lastResult = `<div id="result">` +
    (lines.length ? `<div class="callout ok">Pulled from GitHub:<ul>${lines.join("")}</ul>${j.checkpoint ? `<p class="muted" style="margin-top:6px">The previous versions are kept in History as “${esc(j.checkpoint)}”.</p>` : ""}</div>` : "") +
    (skipped.length ? `<div class="callout warn" style="margin-top:8px">Left alone:<ul>${skipped.join("")}</ul>${needsForce ? `<p style="margin-top:8px"><button class="btn small" id="forcePull">Pull anyway, discarding the unsaved edits</button></p>` : ""}</div>` : "") +
    (!lines.length && !skipped.length ? `<div class="callout">Nothing to pull.</div>` : "") + `</div>`;
  await loadStatus();
  const fp = $<HTMLButtonElement>("#forcePull");
  if (fp) fp.onclick = () => busy(fp, () => doPull(true));
}

// ---------------------------------------------------------------- link form
function linkForm(p: ProjectInfo, gh: Connection, again = false): string {
  // The app is not allowed to create repositories: a new one is made on GitHub and then chosen.
  const viaApp = gh.via === "app";
  return `<section class="box"><h2>${again ? "Or link it somewhere else" : "Link to a repository"}</h2><div class="in">
    ${viaApp
      ? `<p class="muted" style="margin-bottom:10px">For a new repository, <a href="https://github.com/new" target="_blank" rel="noreferrer">create it on GitHub</a>, then <a href="${installUrl()}">add it to the chosen repositories</a>.</p>`
      : `<div class="seg" id="mode" style="margin-bottom:12px"><button type="button" data-v="existing" class="on">Existing repository</button><button type="button" data-v="new">New repository</button></div>`}
    <div id="existing"><div id="picker"></div></div>
    <div id="new" class="hide"><div class="row">
      <label class="f grow">Repository name <input type="text" id="newName" value="${esc(p.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "kicad-project")}" autocapitalize="off" spellcheck="false"></label>
      <label class="f">Visibility <k-select id="newPrivate"><option value="1">Private</option><option value="0">Public</option></k-select></label></div></div>
    <div class="row" style="margin-top:12px">
      <label class="f grow">Branch <input type="text" id="lBranch" placeholder="the repository's default branch" autocapitalize="off" spellcheck="false"></label>
      <label class="f grow">Folder in the repository <input type="text" id="lPath" placeholder="/ (the repository root)" autocapitalize="off" spellcheck="false"></label>
    </div>
    <div id="folders" class="muted" style="margin-top:8px"></div>
    <p class="muted" style="margin-top:10px">Linking writes nothing to GitHub and changes nothing online. After linking you see what differs and choose to push or pull. You can unlink at any time.</p>
    <div class="row actions" style="margin-top:4px"><button class="btn primary" id="doLink" disabled>Link</button></div>
  </div></section>`;
}
function bindLinkForm(): void {
  let mode = "existing", picked: string | null = null;
  const btn = need<HTMLButtonElement>("#doLink");
  const newName = need<HTMLInputElement>("#newName"), branch = need<HTMLInputElement>("#lBranch");
  const sync = () => { btn.disabled = mode === "existing" ? !picked : !newName.value.trim(); };
  $$("#mode button").forEach((b) => (b.onclick = () => {
    mode = b.dataset.v || "existing";
    $$("#mode button").forEach((x) => x.classList.toggle("on", x === b));
    need("#existing").classList.toggle("hide", mode !== "existing");
    need("#new").classList.toggle("hide", mode !== "new");
    sync();
  }));
  newName.oninput = sync;
  repoPicker(need("#picker"), (full, repo) => {
    picked = full;
    if (repo && repo.defaultBranch) branch.placeholder = repo.defaultBranch + " (default)";
    sync();
    void suggestFolders(full);
  });
  btn.onclick = () => busy(btn, async () => {
    const body: { branch: string; path: string; repo?: string | null; create?: { name: string; private: boolean } } =
      { branch: branch.value, path: need<HTMLInputElement>("#lPath").value };
    if (mode === "existing") body.repo = picked;
    else body.create = { name: newName.value.trim(), private: need<HTMLSelectElement>("#newPrivate").value === "1" };
    await api(`/api/projects/${projectId}/github`, { method: "PUT", body });
    await loadStatus();
  });
}

/** The KiCad project folders of the picked repository, to click instead of typing the folder. */
async function suggestFolders(full: string): Promise<void> {
  const el = $("#folders"), path = $<HTMLInputElement>("#lPath"), branch = $<HTMLInputElement>("#lBranch");
  if (!el || !path || !branch) return;
  el.innerHTML = `<span class="spinner"></span> Looking for KiCad projects in ${esc(full)}…`;
  let s: Scan;
  try { s = await api<Scan>(`/api/github/scan?repo=${encodeURIComponent(full)}${branch.value.trim() ? "&branch=" + encodeURIComponent(branch.value.trim()) : ""}`); }
  catch { el.innerHTML = ""; return; }
  if (!$("#folders")) return;
  if (!s.projects.length) { el.innerHTML = `No KiCad project in <b>${esc(s.repo)}</b> (${esc(s.branch)}) yet: the first push puts this one in the folder you name.`; return; }
  el.innerHTML = `KiCad projects in <b>${esc(s.repo)}</b>, click one to use its folder: ` + s.projects.map((f, i) =>
    `<button type="button" class="btn small" data-folder="${i}" title="${f.online ? `Already linked to the online project ${esc(f.online.name)}` : `${plural(f.files, "file")}`}">${esc(f.path || "/")}${f.online ? " · linked" : ""}</button>`).join(" ");
  $$<HTMLButtonElement>("[data-folder]", el).forEach((b) => (b.onclick = () => {
    path.value = s.projects[Number(b.dataset.folder)].path;
    $$("[data-folder]", el).forEach((x) => x.classList.toggle("on", x === b));
  }));
}

// ---------------------------------------------------------------- go
if (projectId) loadStatus(); else renderImport();

export {};
