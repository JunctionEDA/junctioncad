// pcbdialogs/vrml — File > Export > VRML... (DIALOG_EXPORT_VRML over pcbnew/dialogs/dialog_export_vrml_base.cpp and
// BOARD_EDITOR_CONTROL::ExportVRML in dialog_export_vrml.cpp).  File name (with the browse button), Footprint 3D model
// path, User defined origin with X / Y, Units (mm / meter / 0.1 inch / inch), Ignore 'Do not populate' components,
// Ignore 'Unspecified' components, Copy 3D model files to 3D model path and Use relative paths (enabled only while
// copying, OnUpdateUseRelativePath).  The file is web/domains/pcb/fab/vrml.ts; a part's model is the mesh the 3D viewer
// tessellates from its STEP file.  With the models copied, the board file and the model folder come as one zip.
import type { KiCadFabApi } from "../../fab/index";
import { E } from "../state";
import { fabContext, loadFab } from "../fab-outputs";
import { loadViewer } from "../viewer3d-loader";
import { loadPrefs, saveBlob, savePrefs } from "./plot-out";
import { bitmapButton, checkField, coordField, h, messageBox, openDialog, selectField, textField, unitLabel } from "./ui";

/** DIALOG_EXPORT_VRML::GetScale: the mm to VRML unit factor of each Units choice */
export const VRML_SCALES = [1.0, 0.001, 10.0 / 25.4, 1.0 / 25.4];
interface Prefs { subdir: string; userOrigin: boolean; x: number; y: number; units: number; noDnp: boolean; noUnspecified: boolean; copy: boolean; relative: boolean }
const KEY = "kicad.vrml";
const DEFAULTS: Prefs = { subdir: "shapes3D", userOrigin: false, x: 0, y: 0, units: 0, noDnp: false, noUnspecified: false, copy: false, relative: false };

/** ExportVRML's origin when none is given: the centre of BOARD::ComputeBoundingBox( true, true ), the board edges' box */
export function boardEdgesCentre(doc: KDoc): [number, number] {
  let b: number[] | null = null;
  for (const it of doc.items.values()) {
    if (it.layer !== "Edge.Cuts" || !it.bbox || it.kind === "footprint") continue;
    b = b ? [Math.min(b[0], it.bbox[0]), Math.min(b[1], it.bbox[1]), Math.max(b[2], it.bbox[2]), Math.max(b[3], it.bbox[3])] : it.bbox.slice();
  }
  if (!b) b = doc.bbox && doc.bbox[2] > doc.bbox[0] ? doc.bbox.slice() : [0, 0, 0, 0];
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** BOARD_EDITOR_CONTROL::ExportVRML */
export async function openExportVrml(ctx: ToolCtx): Promise<void> {
  if (!E.kdoc || E.kdoc.type !== "pcb") { ctx.toast("A VRML file is made from a board: open the PCB editor first"); return; }
  let fab: KiCadFabApi;
  try { fab = await loadFab(); } catch (e) { console.warn(e); ctx.toast("The VRML exporter could not be loaded"); return; }
  const first = await fabContext(); if (!first) return;
  const board = first.projectName || "board";
  const pref = loadPrefs<Prefs>(KEY, DEFAULTS);

  const file = textField(`${board}.wrl`, { key: "outputFile" });
  const browse = bitmapButton("small_folder", "Browse", () => undefined, { key: "browse", disabled: true });
  const subdir = textField(pref.subdir, { key: "subdir" });
  const xField = coordField(pref.x, "x", { key: "xref" }), yField = coordField(pref.y, "y", { key: "yref" });
  const originRow = (label: string, f: { el: HTMLElement }): HTMLElement[] => [h("label", null, label), f.el, unitLabel()];
  const enableOrigin = (on: boolean): void => { for (const f of [xField, yField]) (f.input as HTMLInputElement).disabled = !on; };
  const userOrigin = checkField(pref.userOrigin, "User defined origin", { key: "userOrigin", onChange: enableOrigin });
  const units = selectField<number>(pref.units, [[0, "mm"], [1, "meter"], [2, "0.1 inch"], [3, "inch"]], { key: "units" });
  const noDnp = checkField(pref.noDnp, "Ignore 'Do not populate' components", { key: "noDnp" });
  const noUnspecified = checkField(pref.noUnspecified, "Ignore 'Unspecified' components", { key: "noUnspecified" });
  const relative = checkField(pref.relative, "Use relative paths to model files in board VRML file", { key: "relative", tip: "Use paths for model files in board VRML file relative to the VRML file" });
  const enableRelative = (on: boolean): void => { (relative.input as HTMLInputElement).disabled = !on; relative.el.classList.toggle("disabled", !on); };   // OnUpdateUseRelativePath
  const copy = checkField(pref.copy, "Copy 3D model files to 3D model path", { key: "copy", tip: "If checked: copy 3D models to the destination folder\nIf not checked: Embed 3D models in the VRML board file", onChange: enableRelative });

  openDialog({
    title: "Export VRML", width: 560, okLabel: "Export",
    build(body) {
      file.el.style.flex = "1"; subdir.el.style.width = "100%";
      body.append(
        h("div", { class: "pd-lbl" }, "File name:"),
        h("div", { style: "display:flex;gap:4px;align-items:center;margin-bottom:6px" }, file.el, browse),
        h("div", { class: "pd-lbl" }, "Footprint 3D model path:"),
        h("div", { style: "margin-bottom:10px" }, subdir.el),
        h("div", { style: "display:flex;gap:24px;align-items:flex-start" },
          h("div", { style: "display:flex;flex-direction:column;gap:4px" }, userOrigin.el,
            h("div", { style: "display:grid;grid-template-columns:auto 110px auto;gap:3px 6px;align-items:center;margin-left:20px" }, ...originRow("X:", xField), ...originRow("Y:", yField))),
          h("div", { style: "display:flex;gap:6px;align-items:center" }, h("label", null, "Units:"), units.el)),
        h("hr", { style: "border:0;border-top:1px solid var(--line);margin:10px 0" }),
        h("div", { style: "display:flex;flex-direction:column;gap:4px" }, noDnp.el, noUnspecified.el, copy.el, relative.el));
      enableOrigin(pref.userOrigin); enableRelative(pref.copy);
    },
    ok() {
      const p: Prefs = { subdir: subdir.get(), userOrigin: userOrigin.get(), x: xField.get(), y: yField.get(), units: units.get(), noDnp: noDnp.get(), noUnspecified: noUnspecified.get(), copy: copy.get(), relative: relative.get() };
      savePrefs(KEY, p);
      void run(p);
    },
  });

  async function run(p: Prefs): Promise<void> {
      const fctx = await fabContext(); if (!fctx) return;
      const [xref, yref] = p.userOrigin ? [p.x, p.y] : boardEdgesCentre(fctx.doc as unknown as KDoc);
      const name = (file.get().trim().replace(/\\/g, "/").split("/").pop() || `${board}.wrl`).replace(/(\.wrl)?$/i, ".wrl");
      ctx.toast("Exporting VRML...");
      // the parts' models, as the 3D viewer has them
      const refs = fab.vrmlModels(fctx);
      let meshOf = (_url: string): ReturnType<Parameters<KiCadFabApi["writeVrml"]>[2]> => null;
      if (refs.length) {
        try {
          const V = await loadViewer() as unknown as { models?(): { want(r: unknown): void; settled(): Promise<unknown>; get(u: string): unknown } };
          const store = V.models ? V.models() : null;
          if (store) {
            store.want(refs); await Promise.race([store.settled(), new Promise((r) => setTimeout(r, 90000))]);
            meshOf = (url) => { const m = store.get(url); return m && m !== "missing" ? m as ReturnType<typeof meshOf> : null; };
          }
        } catch (e) { console.warn("vrml: 3D models", e); }
      }
      let r: ReturnType<KiCadFabApi["writeVrml"]>;
      try {
        r = fab.writeVrml(fctx, { unit: VRML_SCALES[p.units] || 1, separateModels: p.copy, relativePaths: p.relative, subdir: p.subdir, xref, yref,
          includeUnspecified: !p.noUnspecified, includeDnp: !p.noDnp, fileName: name }, meshOf);
      } catch (e) { messageBox("Error", `Failed to create file '${name}'.\n${(e as Error).message || e}`); return; }
      if (p.copy && r.models.length) {
        const dir = p.subdir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || "shapes3D";
        const zip = await fab.zip([{ name, data: r.text }, ...r.models.map((m) => ({ name: `${dir}/${m.name}`, data: m.text }))]);
        saveBlob(zip, name.replace(/\.wrl$/i, "") + "-vrml.zip");
      } else saveBlob(r.text, name);
      if (r.stats.missing.length) ctx.toast(`VRML file created; ${r.stats.missing.length} 3D model${r.stats.missing.length > 1 ? "s" : ""} could not be loaded and ${r.stats.missing.length > 1 ? "were" : "was"} left out.`);
  }
}
