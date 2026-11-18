// dialogs/cvpcb/equfiles.ts — CvPcb's footprint association (equivalence) files: Preferences > Manage Footprint
// Association Files… is DIALOG_CONFIG_EQUFILES (cvpcb/dialogs/dialog_config_equfiles_base.cpp / .cpp): the project's
// cvpcb.equivalence_files list with Add / Move up / Move down / Edit / Remove bitmap buttons and the available path
// substitutions; OK writes that one key of the .kicad_pro.  readEquivalences is buildEquivalenceList: each entry
// resolved in the project (${KIPRJMOD} or a relative path), read and parsed (logic.ts parseEquFile).
import { E, appState, toast } from "../editor";
import { KD, h, promptText } from "../dom";
import { projectName } from "../project";
import { icon } from "../../symedit/ui";
import { loadProjectFile, saveProjectFile, adoptProjectFile, saveTextDocument } from "../../editor/projectfile";
import { editProject } from "../../canvas/project-file";
import { api } from "../editor";
import * as L from "./logic";
import { messageBox } from "./widgets";

interface Doc { docId: string; path: string; docType: string }
/** Every document of the project, the .equ files among them (project.ts projectDocs lists only schematics and boards). */
const docsNow = () => (appState.project ? appState.project.docs : []) as Doc[];
const FP_DIR = "KICAD10_FOOTPRINT_DIR";
/** The project folder as the picker's paths are rooted (documents are project-relative). */
const PROJECT_ROOT = "/project";

/** PROJECT_FILE::m_EquivalenceFiles from the .kicad_pro as it stands now. */
async function equivalenceFiles(): Promise<string[]> {
  const text = await loadProjectFile(); if (!text) return [];
  try { const j = JSON.parse(text) as { cvpcb?: { equivalence_files?: unknown } }; const l = j && j.cvpcb && j.cvpcb.equivalence_files; return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : []; } catch (e) { return []; }
}
const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() || p;
function docFor(entry: string): Doc | null { const p = L.equProjectPath(entry); return p === null ? null : docsNow().find((d) => d.path === p) || null; }
async function docText(docId: string): Promise<string> { const r = await fetch(`/api/docs/${docId}/content?v=${Date.now()}`, { credentials: "same-origin" }); if (!r.ok) throw new Error(String(r.status)); return r.text(); }

/** CVPCB_MAINFRAME::buildEquivalenceList: every equivalence of every listed file, and the load errors. */
export async function readEquivalences(): Promise<{ list: L.Equivalence[]; errors: string[] }> {
  const list: L.Equivalence[] = [], errors: string[] = [];
  for (const entry of await equivalenceFiles()) {
    const d = docFor(entry);
    if (!d) { errors.push(`Equivalence file '${baseName(L.expandVars(entry, {}))}' could not be found.`); continue; }
    try { list.push(...L.parseEquFile(await docText(d.docId))); } catch (e) { errors.push(`Error opening equivalence file '${d.path}'.`); }
  }
  return { list, errors };
}

/** The project's *.equ files, as Add offers them (a themed chooser in place of wxFileDialog). */
function pickEquFiles(): Promise<string[] | null> {
  return new Promise((resolve) => {
    let chosen = new Set<string>();
    const list = h("div", { class: "cv-elist", id: "cv-equ-pick", style: "height:180px" });
    const draw = () => {
      const files = docsNow().filter((d) => /\.equ$/i.test(d.path)).map((d) => d.path).sort();
      list.replaceChildren(...files.map((p) => { const r = h("div", { class: "cv-erow" + (chosen.has(p) ? " sel" : ""), "data-path": p }, p); r.addEventListener("click", (ev) => { if (ev.ctrlKey || ev.metaKey || ev.shiftKey) { if (chosen.has(p)) chosen.delete(p); else chosen.add(p); } else chosen = new Set([p]); draw(); }); r.addEventListener("dblclick", () => { chosen = new Set([p]); finish(true); }); return r; }));
      if (!files.length) list.append(h("div", { class: "kd-note", style: "padding:8px" }, "The project has no footprint association files (*.equ)."));
    };
    let finish = (_ok: boolean) => { /* set below */ };
    const create = async () => {
      if (E.viewOnly || !appState.project) return;
      const name = await promptText("New Footprint Association File", "File name:", "footprints.equ"); if (!name) return;
      let path = name.trim().replace(/\\/g, "/").replace(/^\/+/, ""); if (!/\.equ$/i.test(path)) path += ".equ";
      if (docsNow().some((d) => d.path === path)) { await messageBox("Error", `File '${path}' already exists.`); return; }
      try {
        const res = await api(`/api/projects/${appState.project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path }) }) as { docId?: string; path?: string; docType?: string };
        if (!res.docId) throw new Error("no document");
        await fetch(`/api/docs/${res.docId}/snapshots?seq=0`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: "" });
        appState.project.docs.push({ docId: res.docId, path: res.path || path, docType: res.docType || "other" } as never);
        chosen = new Set([res.path || path]); draw();
      } catch (e) { toast("The file could not be created: " + (e as Error).message, 4000); }
    };
    KD().open({ title: "Footprint Association File", width: 460, child: true, fixedSize: true,
      build(body) { body.append(list); const nb = h("button", { class: "btn", id: "cv-equ-new", style: "margin-top:8px" }, "New File..."); nb.addEventListener("click", () => { void create(); }); if (E.viewOnly) (nb as HTMLButtonElement).disabled = true; body.append(nb); draw(); },
      ok() { finish(true); }, cancel() { finish(false); } });
    let done = false;
    finish = (ok: boolean) => { if (done) return; done = true; resolve(ok ? [...chosen] : null); };
  });
}

/** Edit association file: the .equ in a text box (the web has no external text editor to hand it to). */
function editEquFile(entry: string): void {
  const d = docFor(entry);
  if (!d) { void messageBox("Error", `Equivalence file '${baseName(entry)}' could not be found.`); return; }
  const ta = h("textarea", { id: "cv-equ-text", spellcheck: "false", style: "width:100%;height:320px;font-family:var(--mono);white-space:pre" }) as HTMLTextAreaElement;
  void docText(d.docId).then((t) => { ta.value = t; }, () => { ta.value = ""; });
  KD().open({ title: d.path, width: 640, child: true, readOnly: !!E.viewOnly, build(body) { body.append(ta); },
    ok() {
      if (E.viewOnly) return true;
      const text = ta.value;
      void saveTextDocument(d.docId, text, { id: "file", kind: "MODIFIED", typeName: "TEXT_FILE", properties: [{ name: "text", after: { type: "string", v: text } }] } as unknown as KChange)
        .then((ok) => { if (!ok) toast("The file could not be saved", 4000); });
      return true;
    } });
}

/** DIALOG_CONFIG_EQUFILES. */
export async function openEquFiles(): Promise<void> {
  let files = await equivalenceFiles(); let sel: number[] = [];
  const ro = !!E.viewOnly;
  const list = h("div", { class: "cv-elist", id: "cv-equ-list", role: "listbox", "aria-multiselectable": "true", tabindex: "0" });
  let last = -1;
  const draw = () => {
    list.replaceChildren(...files.map((f, i) => {
      const r = h("div", { class: "cv-erow" + (sel.includes(i) ? " sel" : ""), role: "option", "data-i": String(i) }, f);
      r.addEventListener("click", (ev) => {
        if (ev.shiftKey && last >= 0) { sel = []; for (let k = Math.min(last, i); k <= Math.max(last, i); k++) sel.push(k); }
        else if (ev.ctrlKey || ev.metaKey) { sel = sel.includes(i) ? sel.filter((k) => k !== i) : [...sel, i]; last = i; }
        else { sel = [i]; last = i; }
        draw();
      });
      r.addEventListener("dblclick", () => editEquFile(f));
      return r;
    }));
  };
  const bbtn = (name: string, tip: string, id: string, fn: () => void) => { const b = h("button", { class: "btn", id, title: tip, "aria-label": tip }, icon(name)) as HTMLButtonElement; b.disabled = ro && id !== "cv-equ-edit"; b.addEventListener("click", fn); return b; };
  const subs: [string, string][] = [["KIPRJMOD", "(the project folder)"], [FP_DIR, "(the KiCad footprint libraries this server provides)"]];
  const add = async () => {
    const picked = await pickEquFiles(); if (!picked) return;
    for (const p of picked) {
      // OnAddFiles: relative to a substitution path when it is under one; KIPRJMOD is the project root here
      const entry = L.equEntryFor(PROJECT_ROOT + "/" + p, [["KIPRJMOD", PROJECT_ROOT]]);
      if (files.includes(entry)) { await messageBox("Error", `File '${entry}' already exists in list.`); continue; }
      files.push(entry.replace(/\\/g, "/"));
    }
    draw();
  };
  const move = (dir: -1 | 1) => { const r = L.moveRows(files, sel, dir); files = r.list; sel = r.sel; draw(); };
  const remove = () => { const s = [...sel].sort((a, b) => b - a); for (const i of s) files.splice(i, 1); sel = []; draw(); };
  const edit = () => { for (const i of [...sel].sort((a, b) => a - b)) editEquFile(files[i]!); };
  const proName = projectName();
  KD().open({ title: `Project file: '${proName}.kicad_pro'`, width: 560, cls: "cv-equ", readOnly: ro,
    build(body) {
      body.classList.add("cv-equ");
      body.append(h("div", { style: "margin-bottom:2px" }, "Footprint association files:"), list,
        h("div", { class: "cv-ebtns" }, bbtn("small_folder", "Add association file", "cv-equ-add", () => { void add(); }), bbtn("small_up", "Move up", "cv-equ-up", () => move(-1)),
          bbtn("small_down", "Move down", "cv-equ-down", () => move(1)), bbtn("small_edit", "Edit association file", "cv-equ-edit", edit), h("span", { class: "sp" }), bbtn("small_trash", "Remove association file", "cv-equ-del", remove)),
        h("div", { style: "margin:14px 0 2px" }, "Available path substitutions:"),
        h("table", { class: "kd-grid", id: "cv-equ-vars", style: "width:100%" }, h("tbody", null, ...subs.map(([n, v]) => h("tr", null, h("td", { class: "ro" }, n), h("td", { class: "ro" }, v))))));
      draw();
    },
    ok() {
      if (ro) return true;
      void (async () => {
        const text = await loadProjectFile(); if (text === null) { toast("This project has no .kicad_pro file", 4000); return; }
        const res = editProject(text, [{ path: ["cvpcb", "equivalence_files"], value: files.slice() }]);
        if (res.changed.length && await saveProjectFile(res.text, res.changed)) adoptProjectFile(res.text);
      })();
      return true;
    } });
}
