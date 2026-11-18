// import-file.ts — File › Import: a STEP or BREP file becomes an Import feature (features/import-file.ts) at the
// rollback bar.  The file is stored with the project first (platform/doctabs/api.ts uploadFile, in models/), so
// collaborators and reloads read the same bytes; a BREP file is converted to STEP in the worker on the way, as
// the server stores 3D models as STEP.  A file dropped on the viewport does the same.
import { uploadFile } from "../../../platform/doctabs/api";
import { defineTool } from "../core/tool";
import { addFeature } from "../document/edits";
import importFeature from "../features/import-file";
import type { PartStudio } from "../ui/studio";
import { formatBytes } from "./_dialog";

const ACCEPT = [".step", ".stp", ".brep", ".brp"];
const busy = new WeakSet<PartStudio>();

export async function importFile(studio: PartStudio, file: File): Promise<void> {
  const s = studio.getState();
  if (!s.canEdit) { studio.host.toast(studio.host.signedIn ? "You have view-only access to this project." : "Sign in to import.", 3000); return; }
  const lower = file.name.toLowerCase();
  if (!ACCEPT.some((ext) => lower.endsWith(ext))) { studio.host.toast(`Junction imports STEP and BREP files (${ACCEPT.join(", ")}), not “${file.name}”.`, 5000); return; }
  if (busy.has(studio)) { studio.host.toast("An import is already running.", 3000); return; }
  busy.add(studio);
  try {
    let blob: Blob = file, name = file.name;
    if (/\.(brep|brp)$/.test(lower)) {
      studio.host.toast(`Converting ${file.name} to STEP…`, 60000);
      const r = await studio.kernel.call<{ data: Uint8Array; name: string } & Record<string, never>>("export-convert", { data: new Uint8Array(await file.arrayBuffer()), name: file.name } as never);
      blob = new Blob([r.data as BlobPart], { type: "model/step" }); name = r.name;
    }
    const size = formatBytes(blob.size);
    studio.host.toast(`Uploading ${name} (${size})…`, 600000);
    const stored = await uploadFile(studio.host.project.projectId, "models", name, blob, (f) => studio.host.toast(`Uploading ${name}: ${Math.round(f * 100)}% of ${size}`, 600000));
    const doc = studio.doc;
    if (!doc) throw new Error("The part studio is not open.");
    const stem = name.replace(/\.[^.]+$/, "");
    const { changes } = addFeature(doc, importFeature, { file: { docId: stored.docId, path: stored.path, name: stored.path.split("/").pop() || name, bytes: blob.size, format: "step" } }, stem);
    studio.commit(changes);
    studio.host.toast(`Importing ${name}…`, 2500);
  } catch (e) {
    studio.host.toast(`The import failed: ${(e as Error).message || e}`, 6000);
  } finally { busy.delete(studio); }
}

function pickFile(studio: PartStudio): void {
  const input = document.createElement("input");
  input.type = "file"; input.accept = ACCEPT.join(","); input.hidden = true; input.dataset.cadImport = "";
  input.addEventListener("change", () => { const f = input.files && input.files[0]; input.remove(); if (f) void importFile(studio, f); });
  document.body.append(input);
  input.click();
}

// A file dropped on the viewport of the open part studio imports it.  One listener for the page: it acts only on
// drops inside a part studio's viewport, and finds the studio there.
if (typeof document !== "undefined") {
  const studioAt = (t: EventTarget | null): PartStudio | null => {
    const el = t instanceof Element ? t.closest(".cad-stage") : null;
    const w = window as unknown as { JunctionPartStudio?: PartStudio };
    return el && w.JunctionPartStudio && w.JunctionPartStudio.host.el.contains(el) ? w.JunctionPartStudio : null;
  };
  document.addEventListener("dragover", (ev) => { if (studioAt(ev.target) && ev.dataTransfer && Array.from(ev.dataTransfer.items).some((i) => i.kind === "file")) { ev.preventDefault(); ev.dataTransfer.dropEffect = "copy"; } });
  document.addEventListener("drop", (ev) => {
    const studio = studioAt(ev.target);
    if (!studio || !ev.dataTransfer || !ev.dataTransfer.files.length) return;
    ev.preventDefault();
    for (const f of Array.from(ev.dataTransfer.files)) void importFile(studio, f);
  });
}

export default defineTool({
  id: "import",
  title: "Import",
  hint: "Add a STEP or BREP file as a feature (or drop the file on the model)",
  icon: '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  group: "file",
  order: 10,
  disabled: (studio) => (studio.getState().canEdit ? null : "View-only access"),
  run: (studio) => pickFile(studio),
});
