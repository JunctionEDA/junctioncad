// dialogs/configure-paths.ts — DIALOG_CONFIGURE_PATHS (Preferences > Configure Paths... in every editor, and the
// 3D Models tab's Configure Paths... button): the "Environment Variables" grid (Name / Path) and Help, which shows
// what each predefined variable is.  The variables are the server's: KiCad greys the ones defined outside the
// program, and here every one of them is, so the grid is read-only and its add / delete buttons are off.
import { box, grid, gridButtons, h, openDialog, type CellValue } from "../editor/pcbdialogs/ui";
import { serverEnvValues } from "./lib-tables";

/** ENV_VAR::LookUpEnvVarHelp (common/env_vars.cpp initialiseEnvVarHelp). */
export const ENV_VAR_HELP: Record<string, string> = {
  KICAD10_FOOTPRINT_DIR: "The base path of locally installed system footprint libraries (.pretty folders).",
  KICAD10_3DMODEL_DIR: "The base path of system footprint 3D shapes (.3Dshapes folders).",
  KICAD10_SYMBOL_DIR: "The base path of the locally installed symbol libraries.",
  KICAD10_TEMPLATE_DIR: "A directory containing project templates installed with KiCad.",
  KICAD_USER_TEMPLATE_DIR: "Optional. Can be defined if you want to create your own project templates folder.",
  KICAD_LTSPICE_LIB: "Optional. The LTspice library folder, which holds the sub and sym folders, used when importing LTspice schematics.",
  KICAD10_3RD_PARTY: "A directory containing 3rd party plugins, libraries and other downloadable content.",
  KIPRJMOD: "Internally defined by KiCad (cannot be edited) and is set to the absolute path of the currently loaded project file.  This environment variable can be used to define files and paths relative to the currently loaded project.  For instance, ${KIPRJMOD}/libs/footprints.pretty can be defined as a folder containing a project specific footprint library named footprints.pretty.",
};
/** ENV_VAR::GetPredefinedEnvVars, in KiCad's order. */
export const PREDEFINED_ENV_VARS = ["KIPRJMOD", "KICAD10_SYMBOL_DIR", "KICAD10_3DMODEL_DIR", "KICAD10_FOOTPRINT_DIR", "KICAD10_TEMPLATE_DIR", "KICAD_USER_TEMPLATE_DIR", "KICAD_PTEMPLATES", "KICAD_LTSPICE_LIB", "KICAD10_3RD_PARTY"];

/** The rows of the Environment Variables grid: the variables KiCad sets itself (Pgm().GetLocalEnvVariables), sorted. */
export function envVarRows(): { name: string; path: string }[] {
  const vals = serverEnvValues({});
  // KICAD_COLLAB_3DMODELS: the server's variable for vendor parts' 3D models, defined outside the program like the rest
  const names = ["KICAD10_3DMODEL_DIR", "KICAD10_3RD_PARTY", "KICAD10_FOOTPRINT_DIR", "KICAD10_SYMBOL_DIR", "KICAD10_TEMPLATE_DIR", "KICAD_COLLAB_3DMODELS", "KICAD_USER_TEMPLATE_DIR"];
  const other: Record<string, string> = { KICAD10_3RD_PARTY: "(Plugin and Content Manager packages of this server)", KICAD10_TEMPLATE_DIR: "(the project templates of this server)", KICAD_COLLAB_3DMODELS: "(3D models of vendor parts, fetched on use)", KICAD_USER_TEMPLATE_DIR: "" };
  return names.map((name) => ({ name, path: vals[name] !== undefined ? vals[name] : other[name] || "" }));
}

export function configurePaths(onOk?: () => void): void {
  const rows: Record<string, CellValue>[] = envVarRows().map((r) => ({ name: r.name, path: r.path }));
  const g = grid([{ label: "Name", key: "name", width: "220px", type: "ro" }, { label: "Path", key: "path", type: "ro" }], rows, { height: "220px", key: "envVars" });
  const bar = gridButtons(g, () => ({ name: "", path: "" }), { ro: true, addTip: "Add Environment Variable", delTip: "Remove Environment Variable" });
  // OnHelp: the text below the grid, shown and hidden by the Help button
  const help = h("div", { class: "pd-help", "data-k": "pathsHelp", style: "display:none;max-height:260px;overflow:auto;margin-top:8px;padding:8px;border:1px solid var(--line);background:var(--panel);font-size:var(--fs-sm)" },
    h("p", null, "Enter the name and value for each environment variable.  Grey entries are names that have been defined externally at the system or user level.  Environment variables defined at the system or user level take precedence over the ones defined in this table.  This means the values in this table are ignored."),
    h("p", null, h("b", null, "To ensure environment variable names are valid on all platforms, the name field will only accept upper case letters, digits, and the underscore characters.")),
    ...PREDEFINED_ENV_VARS.map((v) => h("p", null, h("b", null, v), ENV_VAR_HELP[v] ? ": " + ENV_VAR_HELP[v] : "")));
  openDialog({ title: "Configure Paths", width: 640, child: true,
    extra: [{ label: "Help", fn: () => { help.style.display = help.style.display === "none" ? "" : "none"; } }],
    build(body) { body.append(box("Environment Variables", g.el, bar), help); },
    ok() { if (onOk) onOk(); return true; } });
}
