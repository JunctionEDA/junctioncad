// pcbdialogs/fp-3d-panel — the Embedded Files notebook page both Footprint Properties dialogs share
// (PANEL_EMBEDDED_FILES: Filename / Embedded Reference, the add and delete bitmap buttons, Embed fonts, Export...).  The 3D
// Models page is model3d.ts' models3dPanel; the node work is pcb-tools' (fp-models.ts).
import { decodeEmbedded, embeddedFileData, embeddedFileSexpr } from "../../library/embedded-file";
import { bitmapButton, errorMessage, grid, h, messageBox, type CellValue, type Field } from "./ui";

/**
 * EMBEDDED_FILES::DecompressAndDecode of a footprint's file `name`: base64, then the zstd frame.  On a board the data is
 * the board's own file of that name when it has one (`boardFiles`, its (embedded_files …): a board KiCad saved keeps the
 * data there and BOARD::FixupEmbeddedData copies it into the footprints).
 */
export function embeddedFileBytes(fp: SNode, name: string, boardFiles?: SNode | null): Uint8Array | null {
  return decodeEmbedded(embeddedFileData(fp, name, boardFiles));
}

/** A file added on the page, written into (embedded_files …) when the dialog's OK applies: the (file …) form. */
export interface AddedEmbeddedFile { name: string; sexpr: string; bytes: Uint8Array }
/**
 * PANEL_EMBEDDED_FILES over a footprint's files: get() is the names listed, added() the files added on the page
 * (onAddEmbeddedFiles / AddEmbeddedFile: a picked file whose name is already embedded with other content asks
 * Replace / Reuse Existing / Cancel; the same content keeps the existing file).
 */
export function embeddedFilesPanel(opts: { names: string[]; ro: boolean; bytes(name: string): Uint8Array | null; embedFonts?: Field<boolean> }): { el: HTMLElement; get(): string[]; added(): AddedEmbeddedFile[] } {
  const rows: Record<string, CellValue>[] = opts.names.map((n) => ({ name: n, ref: "kicad-embed://" + n }));
  const g = grid([{ label: "Filename", key: "name", readOnly: () => true }, { label: "Embedded Reference", key: "ref", readOnly: () => true }], rows, { ro: true, height: "260px", key: "embeddedFiles" });
  const added = new Map<string, AddedEmbeddedFile>();
  const bytesOf = (n: string): Uint8Array | null => (added.has(n) ? added.get(n)!.bytes : opts.bytes(n));
  const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
  const addOne = (name: string, data: Uint8Array, next: () => void): void => {
    const put = (): void => {
      added.set(name, { name, sexpr: embeddedFileSexpr(name, data), bytes: data });
      const r = g.rows(); let i = r.findIndex((x) => x.name === name);
      if (i < 0) { r.push({ name, ref: "kicad-embed://" + name }); i = r.length - 1; }
      g.refresh(); g.select(i); next();
    };
    if (!g.rows().some((x) => x.name === name)) { put(); return; }
    const cur = bytesOf(name);
    if (cur && same(cur, data)) { next(); return; }
    messageBox("Embedded File Conflict", `A file named '${name}' is already embedded, but the file on disk has different content.\n\nDo you want to replace the embedded file with the new version?`,
      [{ label: "Cancel", fn: next }, { label: "Reuse Existing", fn: next }, { label: "Replace", fn: put }], 0);
  };
  const picker = h("input", { type: "file", multiple: true, style: "display:none", "data-k": "efPicker" }) as HTMLInputElement;
  picker.addEventListener("change", () => {
    const files = Array.from(picker.files || []); picker.value = "";
    const step = (k: number): void => {
      const f = files[k]; if (!f) return;
      f.arrayBuffer().then((buf) => addOne(f.name, new Uint8Array(buf), () => step(k + 1)), () => { errorMessage(`Failed to read file '${f.name}'.`); step(k + 1); });
    };
    step(0);
  });
  const add = bitmapButton("small_folder", "Add embedded file", () => picker.click(), { key: "efAdd", disabled: opts.ro });
  const del = bitmapButton("small_trash", "Remove embedded file", () => { const i = g.selected(); const r = g.rows(); if (i < 0 || i >= r.length) return; added.delete(String(r[i].name)); r.splice(i, 1); g.refresh(); if (r.length) g.select(Math.min(i, r.length - 1)); }, { key: "efDelete", disabled: opts.ro });
  const exp = h("button", { type: "button", class: "btn", "data-k": "efExport" }, "Export...") as HTMLButtonElement;
  exp.addEventListener("click", () => {
    const r = g.rows(), i = g.selected(); const names = i >= 0 && i < r.length ? [String(r[i].name)] : r.map((x) => String(x.name));
    for (const n of names) {
      const b = bytesOf(n); if (!b) { errorMessage(`Could not read the embedded file '${n}'.`); continue; }
      const a = h("a", { href: URL.createObjectURL(new Blob([b as BlobPart], { type: "application/octet-stream" })), download: n }) as HTMLAnchorElement;
      document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  });
  const el = h("div", null, g.el, picker, h("div", { class: "pd-row", style: "margin-top:6px;gap:8px" }, add, del, h("span", { style: "flex:1" }), opts.embedFonts ? opts.embedFonts.el : null, exp));
  const names = (): string[] => g.rows().map((r) => String(r.name));
  return { el, get: names, added: () => [...added.values()].filter((a) => names().includes(a.name)) };
}
