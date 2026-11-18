// download.ts — the current document's file name and the browser download every File > Export / Fabrication
// Output ends in.  A leaf module: fab-outputs and export-netlist import it without pulling in menu-actions, which
// registers into HANDLERS when it loads and so must load after editor/actions.ts.
import { state } from "./appstore";
import { isSch } from "./view";

interface DocEntry { docId: string; path: string; docType: string }

export function currentDoc(): DocEntry | null {
  // read at call time: this module can load before appstore has run
  const st = state as unknown as { docs?: DocEntry[]; docId?: string | null };
  return (st.docs || []).find((d) => d.docId === st.docId) || null;
}
export function fileStem(): { name: string; stem: string } {
  const d = currentDoc(); const name = d ? d.path.split("/").pop() || d.path : (isSch() ? "sheet.kicad_sch" : "board.kicad_pcb");
  return { name, stem: name.replace(/\.kicad_(sch|pcb)$/, "") };
}
export function download(data: Blob | string, name: string, type = "text/plain"): void {
  const blob = typeof data === "string" ? new Blob([data], { type }) : data;
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.style.display = "none";
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
