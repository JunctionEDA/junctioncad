// File > Import > Non-KiCad Board File... (PCB_EDIT_FRAME::OnFileHistory / ImportFile) and Non-KiCad Schematic...
// (SCH_EDIT_FRAME::importFile).  The desktop opens the file's own importer and makes a new KiCad board or schematic
// from it; online, the server runs the same importers (server/src/nonkicad_import.rs, `kicad-cli import`) and the
// result is a new online project, opened on the document asked for.  The open project is never overwritten.
import { navigate } from "./home";
import { messageBox } from "./pcbdialogs/ui";
import { toast } from "./util";

const ACCEPT = ".epro,.epro2,.eprj,.elibz,.elibz2,.esch,.epcb,.json,.zip,.pcbdoc,.schdoc,.cmpcbdoc,.cspcbdoc,.swpcbdoc,.cmschdoc,.csschdoc,.prjpcb,.brd,.mdd,.dsn,.sch,.cpa,.csa,.dip,.dch,.lay6,.lay,.t3001,.fab,.pcb,.prj,.asc,.cvg,.xml,.txt";

interface ImportResult { projectId: string; name: string; docs?: { docId?: string; path?: string; docType?: string }[]; converted?: { notes?: string[] } | null }

/** The file dialog lists every format the importers read (EasyEDA, Altium, Eagle, OrCAD / Allegro, CADSTAR, PADS, ...). */
export function importNonKicad(kind: "board" | "schematic"): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = ACCEPT;
  input.style.display = "none";
  document.body.appendChild(input);
  input.onchange = () => {
    const files = Array.from(input.files || []);
    input.remove();
    if (files.length) void run(kind, files);
  };
  input.click();
}

async function run(kind: "board" | "schematic", files: File[]): Promise<void> {
  const form = new FormData();
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) form.append("archive", files[0], files[0].name);
  else for (const f of files) form.append("file", f, f.name);
  toast(`Importing ${files.map((f) => f.name).join(", ")}…`, 60000);
  let r: Response;
  try {
    r = await fetch("/api/projects", { method: "POST", body: form, credentials: "same-origin" });
  } catch {
    toast(""); messageBox("Error", "Can't reach the server. Check your connection."); return;
  }
  const text = await r.text();
  if (!r.ok) {
    let why = text;
    try { const j = JSON.parse(text) as { error?: string; message?: string }; why = j.error || j.message || text; } catch { /* plain text */ }
    toast("");
    messageBox("Error", `Error loading ${kind} file:\n${files[0].name}\n\n${why}`);
    return;
  }
  const res = JSON.parse(text) as ImportResult;
  const want = kind === "board" ? "kicad_pcb" : "kicad_sch";
  const doc = (res.docs || []).filter((d) => d.docType === want && d.docId && d.path)
    .sort((a, b) => a.path!.split("/").length - b.path!.split("/").length || a.path!.length - b.path!.length)[0];
  const notes = res.converted?.notes || [];
  toast(`Imported as the new project “${res.name}”${notes.length ? ` (${notes.length} importer message${notes.length === 1 ? "" : "s"})` : ""}`, 5000);
  navigate(`/p/${res.projectId}/edit` + (doc ? `?doc=${doc.docId}` : ""));
}
