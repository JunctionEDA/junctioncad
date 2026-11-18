// UploadDialog.tsx — start a project: put a KiCad project online from the browser (pick or drop a project
// folder, its files, or a .zip; only KiCad project files are sent, everything else is listed as left out),
// import one from another EDA tool, or start a blank project, which is empty and opens on its Home tab.
import { useEffect, useMemo, useRef, useState } from "react";
import { addProjectFile, createBlank, DEFAULT_LIMITS, NONKICAD_ACCEPT, getLimits, isNonKicadFile, isLocalState, isProjectFile, uploadProject, type MissingFile, type UploadFile, type UploadResult } from "./api";
import { Ic, Modal, PHONE, useMedia } from "./ui";

export type NewMode = "upload" | "import" | "blank";

/** Files of a drop, walking dropped folders (DataTransferItem.webkitGetAsEntry). */
export async function filesFromDrop(dt: DataTransfer): Promise<UploadFile[]> {
  const out: UploadFile[] = [];
  const entries = Array.from(dt.items || []).map((it) => (it.kind === "file" && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return Array.from(dt.files || []).map((file) => ({ path: file.name, file }));
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length > 2000) return;
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ path: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      if (isLocalState(entry.name) || entry.name === "node_modules") return;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries hands back batches; an empty batch ends the directory.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, prefix + entry.name + "/");
      }
    }
  };
  for (const e of entries) await walk(e, "").catch(() => {});
  return out;
}

export const filesFromInput = (list: FileList | null): UploadFile[] =>
  Array.from(list || []).map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file }));

const stem = (p: string) => (p.split("/").pop() || p).replace(/\.[^.]+$/, "");
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1048576).toFixed(1)} MB`);
const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

/** The chosen files that fill in what the project lacks: a file under a missing footprint library's folder, or the
 *  missing symbol library / 3D model itself.  Matched from the end of the path, so the folder picked can sit at any
 *  depth ("project/lib/x.pretty/A.kicad_mod" fills "lib/x.pretty").  Returns project path → file. */
export function filesForMissing(missing: MissingFile[], chosen: UploadFile[]): Map<string, File> {
  const out = new Map<string, File>();
  for (const f of chosen) {
    const p = f.path.replace(/\\/g, "/"), lower = p.toLowerCase();
    for (const m of missing) {
      const want = m.path.toLowerCase();
      if (m.kind === "footprint_library") {
        if (!/\.kicad_mod$/.test(lower)) continue;
        const folder = want.split("/").pop() + "/";
        const at = lower.lastIndexOf(folder);
        if (at >= 0 && (at === 0 || lower[at - 1] === "/") && !lower.slice(at + folder.length).includes("/")) { out.set(m.path + "/" + p.slice(at + folder.length), f.file); break; }
      } else if (lower === want || lower.endsWith("/" + want) || (!p.includes("/") && lower === want.split("/").pop())) { out.set(m.path, f.file); break; }
    }
  }
  return out;
}
const KIND: Record<MissingFile["kind"], string> = { symbol_library: "symbol library", footprint_library: "footprint library", model: "3D model" };

export function UploadDialog({ initial, start, onClose, onDone, onBlank, onBusy }: { initial?: UploadFile[]; start?: NewMode; onClose: () => void; onDone: (r: UploadResult) => void; onBlank: (r: UploadResult) => void; onBusy?: (busy: boolean) => void }) {
  // Dropped files that hold no KiCad design but another tool's open on the import.
  const easyOnly = (list: UploadFile[]) => list.length > 0 && !list.some((f) => /\.kicad_(pro|sch|pcb)$/i.test(f.path)) && list.some((f) => /\.(epro|epro2|eprj|elibz|elibz2|esch|epcb|pcbdoc|schdoc|cmpcbdoc|cspcbdoc|swpcbdoc|cmschdoc|csschdoc|prjpcb|brd|mdd|dsn|sch|cpa|csa|dip|dch|lay6|lay|t3001|fab|pcb|prj|asc|cvg)$/i.test(f.path));
  const [mode, setMode] = useState<NewMode>(initial && initial.length ? (easyOnly(initial) ? "import" : "upload") : start || "upload");
  // A phone has no drag and drop, and iOS cannot pick a folder: one "choose files" button, worded for that.
  const touch = useMedia(PHONE) || !("webkitdirectory" in HTMLInputElement.prototype);
  const [blankName, setBlankName] = useState("");
  const [creating, setCreating] = useState(false);
  const [files, setFiles] = useState<UploadFile[]>(initial || []);
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [limits, setLimits] = useState(DEFAULT_LIMITS);
  useEffect(() => { let on = true; getLimits().then((l) => { if (on) setLimits(l); }); return () => { on = false; }; }, []);
  // The project is online but names libraries or 3D models that were not among the files.
  const [done, setDone] = useState<UploadResult | null>(null);
  const [left, setLeft] = useState<MissingFile[]>([]);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(0);
  const addFiles = useRef<HTMLInputElement>(null);
  const addFolder = useRef<HTMLInputElement>(null);
  const abort = useRef<(() => void) | null>(null);
  const pickFiles = useRef<HTMLInputElement>(null);
  const pickFolder = useRef<HTMLInputElement>(null);

  const eda = mode === "import";
  const zip = files.length === 1 && /\.zip$/i.test(files[0].path) ? files[0] : null;
  const { kept, skipped } = useMemo(() => {
    if (zip) return { kept: [zip], skipped: [] as UploadFile[] };
    const usable = files.filter((f) => !isLocalState(f.path));
    const keep = eda ? isNonKicadFile : isProjectFile;
    return { kept: usable.filter((f) => keep(f.path)), skipped: usable.filter((f) => !keep(f.path)) };
  }, [files, zip, eda]);
  const total = kept.reduce((n, f) => n + f.file.size, 0);
  const count = (re: RegExp) => kept.filter((f) => re.test(f.path)).length;

  // A sensible default name: the .kicad_pro, else the dropped folder, else the zip.
  useEffect(() => {
    if (named) return;
    const pro = kept.find((f) => /\.kicad_pro$/i.test(f.path));
    const dir = kept[0] && kept[0].path.includes("/") ? kept[0].path.split("/")[0] : "";
    // EasyEDA exports carry a kind prefix and a date: "ProProject_Name_2023-09-02.epro", "PCB_Name.json"
    const edaName = (p: string) => stem(p).replace(/^(ProProject|ProPrj|ProDoc|BackupProjects|PCB_PCB|SCH_SCH|PCB|SCH|Schematic)_/, "").replace(/_\d{4}-\d{2}-\d{2}.*$/, "");
    if (eda) { setName(kept[0] ? edaName(kept[0].path) : ""); return; }
    setName(zip ? stem(zip.path) : pro ? stem(pro.path) : dir || (kept[0] ? stem(kept[0].path) : ""));
  }, [kept, zip, named, eda]);

  const busy = progress !== null;
  const take = (list: UploadFile[], into?: NewMode) => { if (list.length && !busy) { setMode(into || (easyOnly(list) ? "import" : mode === "import" ? "import" : "upload")); setFiles(list); setError(null); setNamed(false); } };
  useEffect(() => { onBusy?.(busy); return () => onBusy?.(false); }, [busy]);   // eslint-disable-line
  // A file dropped beside the dashed box would otherwise make the browser leave the page for it.
  useEffect(() => {
    const over = (ev: DragEvent) => { ev.preventDefault(); };
    const drop = async (ev: DragEvent) => { ev.preventDefault(); if (!ev.dataTransfer) return; const list = await filesFromDrop(ev.dataTransfer); if (done) addMissing(list); else take(list); };
    window.addEventListener("dragover", over); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
  });
  const largest = zip ? null : kept.reduce<UploadFile | null>((a, f) => (!a || f.file.size > a.file.size ? f : a), null);
  const problem = !files.length ? null
    : eda && !kept.length ? "None of these are designs Junction can import. Choose an EasyEDA, Altium, Eagle, OrCAD / Allegro, CADSTAR, PADS, DipTrace, Easy-PC, P-CAD, TARGET 3001!, Sprint Layout, IPC-2581 or ODB++ file."
    : eda ? (total > limits.maxUploadBytes ? `That is ${fmtSize(total)}; an upload can be at most ${mb(limits.maxUploadBytes)}.` : null)
    : !kept.length ? "None of these are KiCad project files. Choose a project folder, its .kicad_pro / .kicad_sch / .kicad_pcb files, or a .zip of them."
    : !zip && kept.length > limits.maxFiles ? `That is ${kept.length} files; an online project can hold ${limits.maxFiles}.`
    : largest && largest.file.size > limits.maxFileBytes ? `${largest.path} is ${fmtSize(largest.file.size)}; one file of an online project can be at most ${mb(limits.maxFileBytes)}.`
    : total > (zip ? limits.maxUploadBytes : limits.maxTotalBytes) ? `That is ${fmtSize(total)}; an online project can hold ${mb(limits.maxTotalBytes)}. Leave out 3D models that are not needed, or split the project.`
    : !zip && !kept.some((f) => /\.kicad_(pro|sch|pcb)$/i.test(f.path)) ? "There is no schematic or board among these files." : null;

  const createEmpty = async () => {
    if (creating || !blankName.trim()) return;
    setCreating(true); setError(null);
    try { onBlank(await createBlank(blankName.trim())); } catch (e) { setCreating(false); setError(e instanceof Error ? e.message : String(e)); }
  };
  const go = () => {
    if (mode === "blank") { createEmpty(); return; }
    if (busy || problem || !kept.length) return;
    setError(null); setProgress(0);
    const up = uploadProject(name, kept, setProgress);
    abort.current = up.abort;
    up.promise.then((r) => { if (r.missing?.length || r.converted?.notes?.length) { setProgress(null); setLeft(r.missing || []); setDone(r); } else onDone(r); }).catch((e) => { setProgress(null); setError(e instanceof Error ? e.message : String(e)); });
  };

  const addMissing = async (chosen: UploadFile[]) => {
    if (!done || adding || !chosen.length) return;
    const fill = filesForMissing(left, chosen);
    if (!fill.size) { setError("None of those files are the ones this project is missing."); return; }
    setAdding(true); setError(null);
    let n = 0;
    try {
      for (const [path, file] of fill) {
        if (file.size > limits.maxFileBytes) throw new Error(`${path} is ${fmtSize(file.size)}; one file of an online project can be at most ${mb(limits.maxFileBytes)}.`);
        await addProjectFile(done.projectId, path, file); n++;
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    const got = Array.from(fill.keys()).slice(0, n).map((p) => p.toLowerCase());
    setLeft((l) => l.filter((m) => !got.some((p) => p === m.path.toLowerCase() || p.startsWith(m.path.toLowerCase() + "/"))));
    setAdded((a) => a + n); setAdding(false);
  };
  if (done) {
    return (
      <Modal title={`“${done.name}” is online`} onClose={() => onDone(done)} width={520} busy={adding}
        footer={<><button type="button" className="btn" disabled={adding} onClick={() => addFiles.current?.click()}>Add files…</button>
          {touch ? null : <button type="button" className="btn" disabled={adding} onClick={() => addFolder.current?.click()}>Add folder…</button>}
          <button type="button" className="btn primary" disabled={adding} onClick={() => onDone(done)}>{left.length ? "Continue without them" : "Done"}</button></>}>
        {left.length ? (
          <>
            <p className="hp-note">The project names {left.length === 1 ? "a file" : `${left.length} files`} of its own that {left.length === 1 ? "was" : "were"} not among the ones you uploaded. The design is complete and opens as it is; libraries are written back from the design when the project is opened in the desktop app, but parts you had not placed yet and 3D models cannot be recovered that way.</p>
            <ul className="hp-missing">{left.slice(0, 40).map((m) => <li key={m.path}><span className="hp-dim">{KIND[m.kind]}</span> {m.path}</li>)}{left.length > 40 ? <li>…and {left.length - 40} more</li> : null}</ul>
            <p className="hp-note">Choose the project folder again, or the missing files, to add them now.</p>
          </>
        ) : done.converted ? <p className="hp-note">The {done.converted.format} design is now a KiCad project: schematic, board, and the symbols and footprints it uses.</p>
          : <p className="hp-note">Everything the project names is online now.</p>}
        {done.converted?.notes?.length ? (
          <details className="hp-skipped" open={!left.length}><summary>Converted from {done.converted.format} · {done.converted.notes.length} importer message{done.converted.notes.length === 1 ? "" : "s"}</summary>
            <ul>{done.converted.notes.slice(0, 80).map((n, i) => <li key={i}>{n}</li>)}{done.converted.notes.length > 80 ? <li>…and {done.converted.notes.length - 80} more</li> : null}</ul></details>
        ) : null}
        {added ? <p className="hp-note" role="status">{added} file{added === 1 ? "" : "s"} added.</p> : null}
        {error ? <p className="hp-note err" role="alert">{error}</p> : null}
        <input ref={addFiles} type="file" multiple hidden onChange={(ev) => { addMissing(filesFromInput(ev.target.files)); ev.target.value = ""; }} />
        <input ref={addFolder} type="file" hidden multiple {...({ webkitdirectory: "", directory: "" } as object)} onChange={(ev) => { addMissing(filesFromInput(ev.target.files)); ev.target.value = ""; }} />
      </Modal>
    );
  }

  return (
    <Modal title="New online project" onClose={onClose} width={520} busy={busy || creating}
      footer={<><button type="button" className="btn" disabled={creating} onClick={() => { if (busy) abort.current?.(); else onClose(); }}>{busy ? "Cancel upload" : "Cancel"}</button>
        {mode === "blank" ? <button type="button" className="btn primary" onClick={go} disabled={creating || !blankName.trim()}>{creating ? "Creating…" : "Create and open"}</button>
          : <button type="button" className="btn primary" onClick={go} disabled={busy || !kept.length || !!problem || !name.trim()}>{busy ? ((progress || 0) >= 1 ? (eda ? "Converting…" : "Saving…") : "Uploading…") : eda ? "Import" : "Upload"}</button>}</>}>
      <div className="hp-seg hp-modes" role="tablist" aria-label="How to start">
        <button type="button" role="tab" aria-selected={mode === "upload"} className={mode === "upload" ? "on" : undefined} onClick={() => { setMode("upload"); setError(null); }} disabled={busy || creating}>Upload a KiCad project</button>
        <button type="button" role="tab" aria-selected={mode === "import"} className={mode === "import" ? "on" : undefined} onClick={() => { setMode("import"); setError(null); }} disabled={busy || creating}>Import from another EDA<small>(EasyEDA, Altium, Eagle, etc.)</small></button>
        <button type="button" role="tab" aria-selected={mode === "blank"} className={mode === "blank" ? "on" : undefined} onClick={() => { setMode("blank"); setError(null); }} disabled={busy || creating}>Blank project</button>
      </div>
      {mode === "blank" ? (
        <>
          <label className="hp-field"><span>Project name</span>
            <input className="hp-input" autoFocus value={blankName} maxLength={120} placeholder="My project" disabled={creating} onChange={(ev) => setBlankName(ev.target.value)}
              onKeyDown={(ev) => { if (ev.key === "Enter") createEmpty(); }} /></label>
          <p className="hp-note">Starts an empty project and opens its Home tab. From there you add what it needs, as many as you like: PCBs (each a schematic and a board), part studios and assemblies. You can share it straight away.</p>
        </>
      ) : (<>
      <div className={"hp-drop" + (over ? " over" : "") + (files.length ? " has" : "")}
        onDragOver={(ev) => { ev.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={async (ev) => { ev.preventDefault(); ev.stopPropagation(); setOver(false); take(await filesFromDrop(ev.dataTransfer)); }}>
        <Ic name="upload" size={26} />
        {eda ? <p><b>{touch ? "Choose a design from another EDA tool" : "Drop a design from another EDA tool here"}</b><br /><span className="hp-dim">EasyEDA Std and Pro (.json, .epro, .eprj, .epro2, .zip) · Altium (.PrjPcb, .PcbDoc, .SchDoc) · Eagle (.brd, .sch) · OrCAD / Allegro (.dsn, .brd) · CADSTAR · PADS · DipTrace · Easy-PC · P-CAD · TARGET 3001! · Sprint Layout · IPC-2581 and ODB++ (Flux and others export these). Choose the schematic and the board together.</span></p>
          : touch ? <p><b>Choose your KiCad project files</b><br /><span className="hp-dim">the .kicad_pro, .kicad_sch and .kicad_pcb files together, or a .zip of the project folder</span></p>
          : <p><b>Drop a KiCad project here</b><br /><span className="hp-dim">a project folder, its files, or a .zip</span></p>}
        <div className="hp-drop-btns">
          {touch ? null : <button type="button" className="btn" onClick={() => pickFolder.current?.click()} disabled={busy}>Choose folder…</button>}
          <button type="button" className={"btn" + (touch || eda ? " primary" : "")} onClick={() => pickFiles.current?.click()} disabled={busy}>{eda ? "Choose files…" : "Choose files or .zip…"}</button>
        </div>
        <input ref={pickFiles} type="file" multiple hidden accept={eda ? NONKICAD_ACCEPT : undefined} onChange={(ev) => { take(filesFromInput(ev.target.files), mode); ev.target.value = ""; }} />
        <input ref={pickFolder} type="file" hidden multiple {...({ webkitdirectory: "", directory: "" } as object)} onChange={(ev) => { take(filesFromInput(ev.target.files), mode); ev.target.value = ""; }} />
      </div>

      {files.length ? (
        <>
          <label className="hp-field"><span>Project name</span>
            <input className="hp-input" value={name} maxLength={120} disabled={busy} onChange={(ev) => { setName(ev.target.value); setNamed(true); }}
              onKeyDown={(ev) => { if (ev.key === "Enter") go(); }} /></label>
          {kept.length ? (
            <p className="hp-summary">
              {zip || eda ? <><Ic name="file" /> {kept.map((f) => f.path).join(", ")} · {fmtSize(total)}{eda ? " · converted to a KiCad project on import" : ""}</> : (
                <><Ic name="file" /> {kept.length} file{kept.length === 1 ? "" : "s"} · {fmtSize(total)}
                  {count(/\.kicad_sch$/i) ? ` · ${count(/\.kicad_sch$/i)} schematic sheet${count(/\.kicad_sch$/i) === 1 ? "" : "s"}` : ""}
                  {count(/\.kicad_pcb$/i) ? ` · ${count(/\.kicad_pcb$/i)} board${count(/\.kicad_pcb$/i) === 1 ? "" : "s"}` : ""}</>
              )}
            </p>
          ) : null}
          {skipped.length ? (
            <details className="hp-skipped"><summary>{skipped.length} other file{skipped.length === 1 ? "" : "s"} will be left out</summary>
              <ul>{skipped.slice(0, 40).map((f) => <li key={f.path}>{f.path}</li>)}{skipped.length > 40 ? <li>…and {skipped.length - 40} more</li> : null}</ul></details>
          ) : null}
        </>
      ) : eda ? <p className="hp-note">The files are converted on the server with KiCad's own importers (the desktop's File &gt; Import Non-KiCad Project), into a KiCad schematic, board and the libraries they use. Nothing on your {touch ? "device" : "computer"} changes.</p>
      : <p className="hp-note">Your files are copied to the server; nothing on your {touch ? "device" : "computer"} changes. You can also publish straight from the desktop app with File &gt; Publish Project Online, or <a href="/github">import a repository from GitHub</a>.</p>}
      </>)}
      {mode === "upload" && problem ? <p className="hp-note err" role="alert">{problem}</p> : null}
      {error ? <p className="hp-note err" role="alert">{error}</p> : null}
      {busy ? <div className="hp-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress || 0) * 100)}><i style={{ width: `${Math.round((progress || 0) * 100)}%` }} /></div> : null}
    </Modal>
  );
}
