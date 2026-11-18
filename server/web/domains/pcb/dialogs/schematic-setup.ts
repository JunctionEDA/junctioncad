// dialogs/schematic-setup.ts — File → Schematic Setup… (eeschema/dialogs/dialog_schematic_setup.cpp): KiCad's paged
// dialog over the project file.  General > Formatting / Annotation / Field Name Templates / BOM Presets, Electrical
// Rules > Violation Severity / Compare Symbol with Library / Pin Conflicts Map, Project > Net Classes / Bus Alias
// Definitions / Net Chains / Text Variables, Schematic Data > Embedded Files (./schematic-setup-pages.ts), the
// "Import Settings from Another Project..." button and the read-only infobar.
// OK writes the .kicad_pro (project.ts saveProject) — schematic.drawing, schematic.bom_*presets, schematic.bus_aliases,
// erc.rule_severities, erc.pin_map, net_settings.classes / netclass_patterns and text_variables — keeping every key the
// dialog does not show.  The web editor itself honours the text variables, the junction dot size, the dash / gap
// ratios, the rule severities and the pin conflicts map; the other values are stored for the desktop.
import { E, api, rootSchematic, toast } from "./editor";
import { KD, checkbox, h, popupMenu, select, textInput, type GridApi } from "./dom";
import { messageBox } from "./sch-items";
import { canWriteProject } from "../editor/projectfile";
import { state as appState } from "../editor/appstore";
import { allNetNames, loadSheets } from "../editor/schnets";
import { netclassPatternMatches } from "../canvas/pcb-sizes";
import { infoBar } from "../editor/pcbdialogs/ui";
import { SCH_IMPORT_OPTIONS, annotationOf, annotationPage, chainClassError, chainClassesJson, chainsOf, embeddedFilesPage, importSections, netChainsPage, parityOf, parityPage, writeAnnotation, type ChainState } from "./schematic-setup-pages";
import { kicadIcon } from "../../../shared/components/kicon-dom";
import { colorPicker, type RGBA } from "../editor/pcbdialogs/color-picker";
import { PIN_MAP_BMP } from "./pinmap-bitmaps";
import { effectiveTheme } from "../../../shared/theme";
import { DEFAULT_PIN_MAP, ERC_RULES, PIN_TYPE_NAMES, defaultSeverity, type Severity } from "./erc-rules";
import { schParamInRange, str } from "./logic";
import { loadProject, obj, proDoc, saveProject, sub, type Json, type JsonObj } from "./project";

const MIL = 0.0254;
const JUNCTION_SIZES = ["None", "Smallest", "Small", "Default", "Large", "Largest"], HOP_SIZES = ["None", "Smallest", "Small", "Medium", "Large", "Largest"];
/** EESCHEMA_SETTINGS::m_Drawing.junction_size_mult_list: the dot's diameter as a multiple of the default wire width. */
export const JUNCTION_MULT = [0, 1.7, 4, 6, 9, 12];
/** PANEL_SETUP_NETCLASSES' g_lineStyleIcons / g_lineStyleNames by LINE_STYLE (DEFAULT is -1): what the Line Style cells draw. */
const LINE_STYLES: [number, string, string][] = [[-1, "<Not defined>", "stroke_none"], [0, "Solid", "stroke_solid"], [1, "Dashed", "stroke_dash"], [2, "Dotted", "stroke_dot"], [3, "Dash-Dot", "stroke_dashdot"], [4, "Dash-Dot-Dot", "stroke_dashdotdot"]];
const lineStyle = (v: number): [number, string, string] => LINE_STYLES.find((x) => x[0] === v) || LINE_STYLES[1];
const cssOf = (c: RGBA): string => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a.toFixed(3)})`;
function rgbaOf(css: string): RGBA | null {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(css || "");
  return m ? { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: m[4] === undefined ? 1 : +m[4] } : null;
}
/** GRID_CELL_COLOR_RENDERER: the colour as a swatch over a checkerboard (transparent shows the board through), a click edits it. */
function colorCell(td: HTMLElement, css: string, ro: boolean, commit: (css: string) => void): void {
  const sw = h("span", { style: "position:relative;display:inline-block;width:36px;height:14px;border:1px solid var(--line-2);background-image:linear-gradient(45deg, var(--line) 25%, transparent 25%, transparent 75%, var(--line) 75%),linear-gradient(45deg, var(--line) 25%, transparent 25%, transparent 75%, var(--line) 75%);background-size:8px 8px;background-position:0 0,4px 4px" });
  const fillEl = h("i", { style: `position:absolute;inset:0;background:${css || "transparent"}` }); sw.append(fillEl);
  const b = h("button", { type: "button", class: "kd-cell-swatch", title: css, "aria-label": "Color", "data-color": css, disabled: ro, style: "display:inline-flex;align-items:center;padding:2px 4px;border:0;background:transparent;cursor:pointer" }, sw) as HTMLButtonElement;
  b.addEventListener("click", () => colorPicker(rgbaOf(css), true, (c) => { css = cssOf(c); fillEl.style.background = css; b.title = css; b.dataset.color = css; commit(css); }, { r: 0, g: 0, b: 0, a: 0 }));
  td.append(b);
}
/** GRID_CELL_ICON_TEXT_POPUP: the line style's bitmap and name; the editor is the bitmap combo of the six styles. */
function lineStyleCell(td: HTMLElement, value: number, ro: boolean, commit: (v: number) => void): void {
  const b = h("button", { type: "button", class: "kd-cell-style", disabled: ro, "data-style": String(value), style: "display:inline-flex;align-items:center;gap:6px;width:100%;padding:2px 4px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer" }) as HTMLButtonElement;
  const draw = (v: number): void => { const [, name, bmp] = lineStyle(v); b.replaceChildren(h("span", { "data-bitmap": bmp, style: "display:inline-flex;flex:none" }, kicadIcon(bmp, 40, 10)), name); b.dataset.style = String(v); };
  draw(value);
  b.addEventListener("click", () => { const r = b.getBoundingClientRect(); popupMenu(r.left, r.bottom, LINE_STYLES.map(([v, name, bmp]) => ({ label: name, icon: bmp, iconW: 40, iconH: 10, run: () => { draw(v); commit(v); } }))); });
  td.append(b);
}
const V_RANGES = ["Auto", "fV", "pV", "nV", "uV", "mV", "V", "KV", "MV", "GV", "TV", "PV"], I_RANGES = ["Auto", "fA", "pA", "nA", "uA", "mA", "A", "KA", "MA", "GA", "TA", "PA"];
const DRAWING_DEFAULTS: Record<string, Json> = { default_text_size: 50, overbar_offset_ratio: 1.23, text_offset_ratio: 0.15, label_size_ratio: 0.375, default_line_thickness: 6, pin_symbol_size: 25, show_dnp_markers: true,
  junction_size_choice: 3, hop_over_size_choice: 0, intersheets_ref_show: false, intersheets_ref_own_page: true, intersheets_ref_short: false, intersheets_ref_prefix: "[", intersheets_ref_suffix: "]",
  dashed_lines_dash_length_ratio: 12, dashed_lines_gap_length_ratio: 3, operating_point_overlay_v_precision: 3, operating_point_overlay_v_range: "~V", operating_point_overlay_i_precision: 3, operating_point_overlay_i_range: "~A" };
const numOf = (v: Json | undefined, d: number): number => (typeof v === "number" ? v : d);

/**
 * The values the renderer takes from the project (SCHEMATIC_SETTINGS): junction diameter in mm, dash / gap ratios,
 * and the Formatting page's text offset / label size ratios, pin symbol size and default line width (mm), DNP markers.
 */
export interface SchRenderSettings { junctionDiameter: number; dash: number; gap: number; textOffsetRatio: number; labelSizeRatio: number; pinSymbolSize: number; lineWidth: number; showDnpMarkers: boolean; overbarHeight: number; hopOverChoice: number }
export function schRenderSettings(pro: JsonObj): SchRenderSettings {
  const s = obj(pro.schematic), d = obj(s.drawing), classes = obj(pro.net_settings).classes;
  const dflt = Array.isArray(classes) ? (classes as JsonObj[]).find((c) => c && c.name === "Default") : undefined;
  const wire = numOf(dflt ? dflt.wire_width : undefined, numOf(d.default_wire_thickness, 6));
  const choice = schParamInRange(d.junction_size_choice, 3, 0, 5, true);
  return { junctionDiameter: +(wire * JUNCTION_MULT[choice] * MIL).toFixed(4), dash: numOf(d.dashed_lines_dash_length_ratio, 12), gap: numOf(d.dashed_lines_gap_length_ratio, 3),
    textOffsetRatio: schParamInRange(d.text_offset_ratio, 0.15, 0, 2), labelSizeRatio: schParamInRange(d.label_size_ratio, 0.375, 0, 2),
    pinSymbolSize: +(schParamInRange(d.pin_symbol_size, 25, 0, 1000) * MIL).toFixed(6), lineWidth: +(schParamInRange(d.default_line_thickness, 6, 5, 1000) * MIL).toFixed(6),
    showDnpMarkers: d.show_dnp_markers !== false, overbarHeight: numOf(d.overbar_offset_ratio, 1.23) > 0 ? numOf(d.overbar_offset_ratio, 1.23) : 1.23,
    hopOverChoice: schParamInRange(d.hop_over_size_choice, 0, 0, 5, true) };
}

interface FieldTpl { name: string; visible: boolean; url: boolean }
interface NameRow { name: string }
interface NetClassRow { name: string; wire: string; bus: string; color: string; style: number; src: JsonObj }
interface PatternRow { pattern: string; netclass: string }
interface VarRow { name: string; value: string }

export function openSchematicSetup(page?: string): void {
  if (!proDoc()) { toast("This project has no .kicad_pro file"); return; }
  void loadProject().then((pro0) => build(JSON.parse(JSON.stringify(pro0)) as JsonObj, page));
}
/** the root sheet's file text (its net chains and embedded files), read once per dialog */
function rootText(): Promise<string> {
  const r = rootSchematic(); if (!r) return Promise.resolve("");
  return api(`/api/docs/${r.docId}/content`).then((t) => (typeof t === "string" ? t : ""), () => "");
}
function build(pro: JsonObj, page?: string, root?: Promise<string>): void {
  const ro = !!E.viewOnly || !canWriteProject();
  const rootP = root || rootText();
  const sch = sub(pro, "schematic"), drawing = sub(pro, "schematic", "drawing"), erc = sub(pro, "erc"), net = sub(pro, "net_settings");
  const dv = (k: string): Json => (drawing[k] !== undefined ? drawing[k] : DRAWING_DEFAULTS[k]);
  const units: string = E.units === "mil" ? "mils" : E.units === "in" ? "in" : "mm";
  const toUser = (mils: number) => (units === "mils" ? mils : units === "in" ? mils / 1000 : mils * MIL), fromUser = (v: number) => (units === "mils" ? v : units === "in" ? v * 1000 : v / MIL);
  const fmt = (v: number) => String(+v.toFixed(units === "mm" ? 4 : units === "in" ? 5 : 2));
  // ---- working copies
  const templates: FieldTpl[] = (Array.isArray(drawing.field_names) ? drawing.field_names as JsonObj[] : []).map((f) => ({ name: str(f.name), visible: !!f.visible, url: !!f.url }));
  const bomPresets: NameRow[] = (Array.isArray(sch.bom_presets) ? sch.bom_presets as JsonObj[] : []).map((p) => ({ name: str(p.name) }));
  const bomFmts: NameRow[] = (Array.isArray(sch.bom_fmt_presets) ? sch.bom_fmt_presets as JsonObj[] : []).map((p) => ({ name: str(p.name) }));
  const sev: Record<string, Severity> = {}; const stored = obj(erc.rule_severities);
  for (const r of ERC_RULES) if (r[1]) { const s = stored[r[1]]; sev[r[1]] = s === "error" || s === "warning" || s === "ignore" ? s : defaultSeverity(r[1]); }
  const pinMap: number[][] = DEFAULT_PIN_MAP.map((row, i) => row.map((v, j) => { const pm = erc.pin_map as number[][] | undefined; const x = Array.isArray(pm) && Array.isArray(pm[i]) ? pm[i][j] : undefined; return x === 0 || x === 1 || x === 2 || x === 3 ? x : v; }));   // ERC_SETTINGS takes OK .. UNCONNECTED
  const classes: NetClassRow[] = (Array.isArray(net.classes) ? net.classes as JsonObj[] : [{ name: "Default", wire_width: 6, bus_width: 12, line_style: 0, schematic_color: "rgba(0, 0, 0, 0.000)" }]).map((c) => ({ name: str(c.name), wire: numOf(c.wire_width, 6) + " mils", bus: numOf(c.bus_width, 12) + " mils", color: str(c.schematic_color || "rgba(0, 0, 0, 0.000)"), style: lineStyle(numOf(c.line_style, 0))[0], src: c }));
  const classes0 = classes.map((c) => c.src);
  const patterns: PatternRow[] = (Array.isArray(net.netclass_patterns) ? net.netclass_patterns as JsonObj[] : []).map((p) => ({ pattern: str(p.pattern), netclass: str(p.netclass) }));
  const aliases: { name: string; members: NameRow[] }[] = Object.entries(obj(sch.bus_aliases)).map(([name, m]) => ({ name, members: (Array.isArray(m) ? m : []).map((x) => ({ name: str(x) })) }));
  const vars: VarRow[] = Object.entries(obj(pro.text_variables)).map(([name, value]) => ({ name, value: str(value) }));
  const annotation = annotationOf(sch), parity = parityOf(sch), annotation0 = JSON.stringify(annotation), parity0 = JSON.stringify(parity);
  const chainClasses = obj(net.net_chain_classes);
  let chainsLoaded = false;
  const chains: ChainState = { chains: [], classes: [...new Set(Object.values(chainClasses).map((v) => str(v)).filter(Boolean))].sort() };
  const chainsReady = rootP.then((t) => { const K = KiCadCanvas; const nodes = t ? (K.parseAll ? (K.parseAll(t) as unknown[]) : []) : []; const top = Array.isArray(nodes[0]) ? nodes[0] as unknown[] : []; chains.chains = chainsOf(top as never[], chainClasses); chainsLoaded = true; });

  const numField = (key: string, id: string, scale: "len" | "pct" | "raw", width = 90) => {
    const cur = numOf(dv(key), 0), shown = scale === "len" ? fmt(toUser(cur)) : scale === "pct" ? String(+(cur * 100).toFixed(2)) : String(cur);
    return textInput(shown, (v) => { const x = parseFloat(v); if (isNaN(x)) return; drawing[key] = scale === "len" ? +fromUser(x).toFixed(4) : scale === "pct" ? +(x / 100).toFixed(4) : x; }, { id, disabled: ro, style: `width:${width}px` });
  };
  const row3 = (host: HTMLElement, label: string, ctl: HTMLElement, unit: string, title?: string) => host.append(h("label", { title }, label), ctl, h("span", { class: "ro" }, unit));
  const flex = (host: HTMLElement, title: string) => { const b = KD().staticBox(host, title); const g = h("div", { style: "display:grid;grid-template-columns:max-content max-content max-content;gap:6px 10px;align-items:center" }); b.append(g); return { box: b, grid: g }; };

  /** the working copies written into a project file (OK, and before an import replaces some of them) */
  const writeInto = (p: JsonObj): void => {
    const s = sub(p, "schematic"), d = sub(p, "schematic", "drawing"), e = sub(p, "erc"), n = sub(p, "net_settings");
    Object.assign(d, drawing); d.field_names = templates.filter((t) => t.name.trim()).map((t) => ({ name: t.name.trim(), url: t.url, visible: t.visible }));
    if (sch.connection_grid_size !== undefined) s.connection_grid_size = sch.connection_grid_size;
    if (Array.isArray(s.bom_presets)) s.bom_presets = (s.bom_presets as JsonObj[]).filter((x) => bomPresets.some((b) => b.name === str(x.name)));
    if (Array.isArray(s.bom_fmt_presets)) s.bom_fmt_presets = (s.bom_fmt_presets as JsonObj[]).filter((x) => bomFmts.some((b) => b.name === str(x.name)));
    const ba: JsonObj = {}; for (const a of aliases) if (a.name.trim()) ba[a.name.trim()] = a.members.map((m) => m.name.trim()).filter(Boolean); s.bus_aliases = ba;
    // the Annotation and Compare Symbol pages write their keys only once changed (an untouched project keeps its file)
    if (JSON.stringify(annotation) !== annotation0) writeAnnotation(s, annotation);
    if (JSON.stringify(parity) !== parity0) s.compare_symbols = Object.assign({}, obj(s.compare_symbols), parity);
    e.rule_severities = Object.assign({}, obj(e.rule_severities), sev); e.pin_map = pinMap;
    // NETCLASS priorities follow the grid order once the move buttons changed it
    const moved = classes.map((c) => c.src).some((src, i) => src !== classes0[i]);
    n.classes = classes.filter((c) => c.name.trim()).map((c, i) => Object.assign({}, c.src, moved ? { priority: c.name.trim() === "Default" ? 2147483647 : i } : {}, { name: c.name.trim(), wire_width: parseFloat(c.wire) || 6, bus_width: parseFloat(c.bus) || 12, schematic_color: c.color || "rgba(0, 0, 0, 0.000)", line_style: c.style }));
    n.netclass_patterns = patterns.filter((x) => x.pattern.trim()).map((x) => ({ netclass: x.netclass, pattern: x.pattern.trim() }));
    const cc = chainClassesJson(chains, chainClasses); if (chainsLoaded && JSON.stringify(cc) !== JSON.stringify(chainClasses)) n.net_chain_classes = cc;
    const tv: JsonObj = {}; for (const v of vars) if (v.name.trim()) tv[v.name.trim()] = v.value; p.text_variables = tv;
  };
  let tb: { current(): string | null } | null = null;
  const importSettings = (): void => importDialog((other, sel) => {
    // ImportSettingsFrom on each chosen page: this dialog's edits so far, then the other project's sections, shown again
    writeInto(pro); importSections(pro, other, sel);
    KD().close(); build(pro, (tb && tb.current()) || page, rootP);
  });
  KD().open({ title: "Schematic Setup", width: 980, cls: "kd-wide kd-flush", readOnly: ro,
    extra: [{ label: "Import Settings from Another Project...", fn: importSettings, id: "kd-ss-import" }],
    build(body) {
      // the infobar: KiCad shows it when the project is missing or read-only
      const bar = infoBar(); body.append(bar.el);
      if (ro) bar.show("Project is missing or read-only. Settings will not be editable.");
      tb = KD().treebook(body, [
        { label: "General", pages: [
          { label: "Formatting", build(pg) {
            const cols = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:0 20px" }), L = h("div"), R = h("div"); cols.append(L, R); pg.append(cols);
            const text = flex(L, "Text");
            row3(text.grid, "Default text size:", numField("default_text_size", "kd-ss-textsize", "len"), units);
            row3(text.grid, "Overbar offset ratio:", numField("overbar_offset_ratio", "kd-ss-overbar", "pct"), "%");
            row3(text.grid, "Label offset ratio:", numField("text_offset_ratio", "kd-ss-labeloffset", "pct"), "%", "Percentage of the text size to offset labels above (or below) a wire, bus, or pin");
            row3(text.grid, "Global label margin ratio:", numField("label_size_ratio", "kd-ss-glabel", "pct"), "%", "Percentage of the text size to use as space around a global label");
            const sym = flex(L, "Symbols");
            row3(sym.grid, "Default line width:", numField("default_line_thickness", "kd-ss-linewidth", "len"), units);
            row3(sym.grid, "Pin symbol size:", numField("pin_symbol_size", "kd-ss-pinsize", "len"), units);
            sym.box.append(checkbox("Show 'Do not populate' markers", dv("show_dnp_markers") !== false, (on) => { drawing.show_dnp_markers = on; }, { disabled: ro, title: "Draw a cross over symbols marked 'Do not populate'" }));
            const conn = flex(L, "Connections");
            row3(conn.grid, "Junction dot size:", select(JUNCTION_SIZES, JUNCTION_SIZES[numOf(dv("junction_size_choice"), 3)] || "Default", (v) => { drawing.junction_size_choice = JUNCTION_SIZES.indexOf(v); }, { id: "kd-ss-junction", disabled: ro }), "");
            row3(conn.grid, "Hop-over size:", select(HOP_SIZES, HOP_SIZES[numOf(dv("hop_over_size_choice"), 0)] || "None", (v) => { drawing.hop_over_size_choice = HOP_SIZES.indexOf(v); }, { id: "kd-ss-hop", disabled: ro }), "");
            const cg = numOf(sch.connection_grid_size, 50);
            row3(conn.grid, "Connection grid:", textInput(fmt(toUser(cg)), (v) => { const x = parseFloat(v); if (!isNaN(x)) sch.connection_grid_size = +fromUser(x).toFixed(4); }, { id: "kd-ss-conngrid", disabled: ro, style: "width:90px" }), units);
            const isr = KD().staticBox(R, "Inter-sheet References");
            const radio = (label: string, short: boolean) => { const r = h("input", { type: "radio", name: "kd-ss-isr", checked: !!dv("intersheets_ref_short") === short, disabled: ro }); r.addEventListener("change", () => { if ((r as HTMLInputElement).checked) drawing.intersheets_ref_short = short; }); return h("label", { class: "kd-chk", style: "margin-left:18px" }, r, label); };
            isr.append(checkbox("Show inter-sheet references", !!dv("intersheets_ref_show"), (on) => { drawing.intersheets_ref_show = on; }, { disabled: ro, id: "kd-ss-isr-show" }), h("div", { style: "margin-left:18px" }, checkbox("Show own page reference", !!dv("intersheets_ref_own_page"), (on) => { drawing.intersheets_ref_own_page = on; }, { disabled: ro })),
              radio("Standard (1,2,3)", false), radio("Abbreviated (1..3)", true),
              h("div", { class: "kv", style: "margin:6px 0 0 18px;grid-template-columns:max-content 90px" }, h("label", null, "Prefix:"), textInput(str(dv("intersheets_ref_prefix")), (v) => { drawing.intersheets_ref_prefix = v; }, { disabled: ro }), h("label", null, "Suffix:"), textInput(str(dv("intersheets_ref_suffix")), (v) => { drawing.intersheets_ref_suffix = v; }, { disabled: ro })));
            const dash = flex(R, "Dashed Lines");
            row3(dash.grid, "Dash length:", numField("dashed_lines_dash_length_ratio", "kd-ss-dash", "raw"), "");
            row3(dash.grid, "Gap length:", numField("dashed_lines_gap_length_ratio", "kd-ss-gap", "raw"), "");
            dash.box.append(h("p", { class: "kd-note", style: "margin:8px 0 0" }, "Dash and dot lengths are ratios of the line width."));
            const opo = flex(R, "Operating-point Overlay");
            const range = (key: string, list: string[]) => { const cur = str(dv(key)); const shown = cur.startsWith("~") ? "Auto" : cur; return select(list, list.includes(shown) ? shown : "Auto", (v) => { drawing[key] = v === "Auto" ? "~" + list[6] : v; }, { disabled: ro }); };
            row3(opo.grid, "Significant digits (voltages):", numField("operating_point_overlay_v_precision", "kd-ss-vprec", "raw", 60), "");
            row3(opo.grid, "Range (voltages):", range("operating_point_overlay_v_range", V_RANGES), "");
            row3(opo.grid, "Significant digits (currents):", numField("operating_point_overlay_i_precision", "kd-ss-iprec", "raw", 60), "");
            row3(opo.grid, "Range (currents):", range("operating_point_overlay_i_range", I_RANGES), "");
          } },
          { label: "Annotation", build(pg) { annotationPage(pg, annotation, ro); } },
          { label: "Field Name Templates", build(pg) {
            pg.append(h("div", { style: "font-weight:600;margin-bottom:6px" }, "Field Name Templates"));
            KD().grid<FieldTpl>(pg, [{ key: "name", label: "Name", type: "text" }, { key: "visible", label: "Visible", type: "bool", width: 70 }, { key: "url", label: "URL", type: "bool", width: 60 }], templates,
              { readOnly: ro, height: 330, buttons: { add: () => ({ name: "", visible: false, url: false }), move: true, remove: true } });
          } },
          { label: "BOM Presets", build(pg) {
            pg.append(h("div", { style: "font-weight:600;margin-bottom:6px" }, "Bill of Materials Presets"));
            KD().grid<NameRow>(pg, [{ key: "name", label: "Name", type: "ro" }], bomPresets, { readOnly: ro, height: 150, buttons: { remove: true } });
            pg.append(h("div", { style: "font-weight:600;margin:14px 0 6px" }, "Bill of Materials Formatting Presets"));
            KD().grid<NameRow>(pg, [{ key: "name", label: "Name", type: "ro" }], bomFmts, { readOnly: ro, height: 150, buttons: { remove: true } });
          } },
        ] },
        { label: "Electrical Rules", pages: [
          { label: "Violation Severity", build(pg) {
            const g = h("div", { id: "kd-ss-severities", style: "display:grid;grid-template-columns:1fr max-content max-content max-content;gap:3px 16px;align-items:center" });
            for (const r of ERC_RULES) {
              if (!r[1]) { g.append(h("div", { style: "grid-column:1/-1;font-weight:600;margin-top:8px" }, r[0])); continue; }
              const code = r[1]; g.append(h("label", null, r[0]));
              const opts: [Severity, string][] = code === "pin_to_pin" ? [["error", "From Pin Conflicts Map"], ["warning", ""], ["ignore", "Ignore"]] : [["error", "Error"], ["warning", "Warning"], ["ignore", "Ignore"]];
              for (const [val, label] of opts) {
                if (!label) { g.append(h("span")); continue; }
                const rb = h("input", { type: "radio", name: "kd-sev-" + code, value: val, checked: sev[code] === val || (code === "pin_to_pin" && val === "error" && sev[code] !== "ignore"), disabled: ro });
                rb.addEventListener("change", () => { if ((rb as HTMLInputElement).checked) sev[code] = val; }); g.append(h("label", { class: "kd-chk", style: "margin:0" }, rb, label));
              }
            }
            pg.append(g);
          } },
          { label: "Compare Symbol with Library", build(pg) { parityPage(pg, parity, ro); } },
          { label: "Pin Conflicts Map", build(pg) {
            // PANEL_SETUP_PINMAP::reBuildMatrixPanel: a lower-triangular matrix of bitmap buttons, row titles right-aligned
            // on the left, each column title written above its diagonal cell with a "|" callout; a click cycles OK →
            // warning → error (changeErrorLevel, % 3) and sets both [row][col] and [col][row] on OK
            const dark = effectiveTheme() === "dark", BMP = ["erc_green", "ercwarn", "ercerr"], TIP = ["No error or warning", "Generate warning", "Generate error"];
            const BW = 24, BH = 24, PX = 8, PY = 6, CH = 17, top = CH * 2;   // bitmapSize, text_padding, charSize.y
            const paint = (b: HTMLElement, v: number) => {
              // setDRCMatrixButtonState: PIN_ERROR::UNCONNECTED has no bitmap of its own and keeps the one it was built with
              const k = v >= 0 && v <= 2 ? v : 0, set = PIN_MAP_BMP[BMP[k]][dark ? "dark" : "light"], img = b.firstElementChild as HTMLImageElement;
              if (v >= 0 && v <= 2) { img.src = set[0]; img.srcset = `${set[0]} 1x, ${set[1]} 2x`; b.title = TIP[v]; b.dataset.bitmap = BMP[k]; }
              else if (!img.src) { img.src = set[0]; img.srcset = `${set[0]} 1x, ${set[1]} 2x`; b.dataset.bitmap = BMP[0]; }
              b.dataset.level = String(v);
            };
            const wrap = h("div", { id: "kd-ss-pinmap", style: "display:flex;align-items:flex-start" });
            const labels = h("div", { style: `padding-top:${top}px;padding-left:5px;padding-right:5px;text-align:right;white-space:nowrap` });
            const box = h("div", { style: `position:relative;width:${12 * (BW + PX) + 140}px;height:${top + 12 * (BH + PY)}px` });
            for (let i = 0; i < 12; i++) {
              labels.append(h("div", { style: `height:${BH + PY}px;line-height:${BH + PY}px` }, PIN_TYPE_NAMES[i]));
              const y = top + i * (BH + PY);
              for (let j = 0; j <= i; j++) {
                const x = j * (BW + PX);
                if (i === j) box.append(h("div", { style: `position:absolute;left:${x + Math.round((BW + PX) / 2)}px;top:${y - CH * 2}px;white-space:nowrap;line-height:${CH}px` }, PIN_TYPE_NAMES[i]),
                  h("div", { style: `position:absolute;left:${x + Math.round((BW + PX) / 2)}px;top:${y - CH}px;line-height:${CH}px` }, "|"));
                const b = h("button", { type: "button", class: "kd-bmpbtn", disabled: ro, style: `position:absolute;left:${x}px;top:${y}px;width:${BW + PX}px;height:${BH + PY}px;padding:0;border:0;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer` }, h("img", { width: "16", height: "16", alt: "" }));
                b.dataset.cell = `${i},${j}`; paint(b, pinMap[i][j]);
                b.addEventListener("click", () => { const v = (pinMap[i][j] + 1) % 3; pinMap[i][j] = pinMap[j][i] = v; paint(b, v); }); box.append(b);
              }
            }
            wrap.append(labels, box);
            // m_ResetMatrixButton under the matrix
            pg.append(wrap, h("div", { class: "kd-row", style: "margin-top:8px" },
              h("button", { class: "btn sm", type: "button", disabled: ro, onclick: () => { for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) pinMap[i][j] = DEFAULT_PIN_MAP[i][j]; box.querySelectorAll<HTMLElement>("button[data-cell]").forEach((b) => { const [i, j] = b.dataset.cell!.split(",").map(Number); paint(b, pinMap[i][j]); }); } }, "Reset to Defaults")));
          } },
        ] },
        { label: "Project", pages: [
          { label: "Net Classes", build(pg) {
            // PANEL_SETUP_NETCLASSES: the classes over the assignments, split by a sash; the assignments pane carries the
            // WX_HTML_REPORT_BOX of the nets the selected pattern matches
            const top = h("div", { id: "kd-ss-nc-top", style: "height:250px;min-height:160px;overflow:auto;resize:vertical;padding-bottom:6px" }), bottom = h("div", { style: "min-height:160px" });
            pg.append(top, h("div", { class: "kd-sash", style: "height:4px;border-top:1px solid var(--line);margin:2px 0 6px" }), bottom);
            top.append(h("div", { style: "font-weight:600;margin-bottom:6px" }, "Netclasses"));
            // PANEL_SETUP_NETCLASSES: Color is a swatch (GRID_CELL_COLOR_RENDERER), Line Style the stroke_* bitmap and its
            // name; Move Up / Move Down (small_up / small_down) move any class but Default, and nothing past it
            const isDefault = (r: NetClassRow): boolean => r.name === "Default" && r.src.name === "Default";
            KD().grid<NetClassRow>(top, [{ key: "name", label: "Name", type: "text", ro: isDefault }, { key: "wire", label: "Wire Thickness", type: "text", width: 120 }, { key: "bus", label: "Bus Thickness", type: "text", width: 120 },
              { key: "color", label: "Color", width: 80, render: (td, r, cro, commit) => colorCell(td, r.color, cro || isDefault(r), commit) },
              { key: "style", label: "Line Style", width: 150, render: (td, r, cro, commit) => lineStyleCell(td, r.style, cro || isDefault(r), commit) }], classes,
              { readOnly: ro, height: 150, buttons: { add: () => ({ name: "NewClass", wire: classes[0] ? classes[0].wire : "6 mils", bus: classes[0] ? classes[0].bus : "12 mils", color: "rgba(0, 0, 0, 0.000)", style: 0, src: Object.assign({}, classes[0] ? classes[0].src : {}, { name: "NewClass", priority: classes.length - 1 }) }), move: true, remove: true,
                canMove: (r, other) => !isDefault(r) && !isDefault(other), canRemove: (r) => { if (r.name === "Default") { toast("The default net class is required."); return false; } return true; } } });
            top.append(h("p", { class: "kd-note", style: "margin:6px 0 0" }, "Set color to transparent to use KiCad default color."));
            bottom.append(h("div", { style: "font-weight:600;margin-bottom:6px" }, "Netclass Assignments"));
            const report = h("div", { id: "kd-ss-nc-matches", style: "flex:1;min-width:180px;height:150px;overflow:auto;border:1px solid var(--line);border-radius:var(--r-1);background:var(--field);padding:4px 6px" });
            let nets: string[] | null = null, last = "";
            const showMatches = (pattern: string): void => {
              if (pattern === last) return; last = pattern; report.replaceChildren();
              if (!pattern) return;
              report.append(h("div", null, h("b", null, `Nets matching '${pattern}':`)));
              for (const n of nets || []) if (netclassPatternMatches(pattern, n)) report.append(h("div", null, n));
            };
            void loadSheets().then(() => { nets = allNetNames(); const i = pg2.selected(); last = ""; showMatches(i >= 0 && patterns[i] ? patterns[i].pattern : ""); }).catch(() => undefined);
            const ghost = h("div", { style: "flex:2;min-width:0" });
            const pg2 = KD().grid<PatternRow>(ghost, [{ key: "pattern", label: "Pattern", type: "text" }, { key: "netclass", label: "Net Class", type: "choice", options: () => classes.map((c) => c.name), width: 200 }], patterns,
              { readOnly: ro, height: 150, onSelect: (r) => showMatches(r ? r.pattern : ""), onChange: (r, key) => { if (key === "pattern") showMatches(r.pattern); }, buttons: { add: () => ({ pattern: "", netclass: classes[0] ? classes[0].name : "Default" }), remove: true } });
            bottom.append(h("div", { style: "display:flex;gap:10px;align-items:flex-start" }, ghost, report));
          } },
          { label: "Bus Alias Definitions", build(pg) {
            const cols = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:16px" }), L = h("div"), R = h("div"); cols.append(L, R); pg.append(cols);
            const rtitle = h("div", { style: "font-weight:600;margin-bottom:6px" }, "Members of ''"); let mg: GridApi<NameRow> | null = null; const mhost = h("div");
            const show = (a: { name: string; members: NameRow[] } | null) => { rtitle.textContent = `Members of '${a ? a.name : ""}'`; mhost.replaceChildren(); mg = a ? KD().grid<NameRow>(mhost, [{ key: "name", label: "Net or Nested Bus Name", type: "text" }], a.members, { readOnly: ro, height: 280, buttons: { add: () => ({ name: "" }), remove: true } }) : null; void mg; };
            L.append(h("div", { style: "font-weight:600;margin-bottom:6px" }, "Bus Definitions"));
            const ag = KD().grid<{ name: string; members: NameRow[] }>(L, [{ key: "name", label: "Alias", type: "text" }], aliases, { readOnly: ro, height: 280, onSelect: (r) => show(r), onChange: (r, key) => { if (key === "name" && r) rtitle.textContent = `Members of '${r.name}'`; }, buttons: { add: () => ({ name: "", members: [] }), remove: true } });
            R.append(rtitle, mhost); if (aliases.length) ag.select(0); else show(null);
          } },
          { label: "Net Chains", build(pg) { const wait = h("div", { class: "ro" }, "Loading..."); pg.append(wait); void chainsReady.then(() => { wait.remove(); netChainsPage(pg, chains, () => classes.map((c) => c.name), ro); }); } },
          { label: "Text Variables", build(pg) {
            KD().grid<VarRow>(pg, [{ key: "name", label: "Variable Name", type: "text", width: 260 }, { key: "value", label: "Text Substitution", type: "text" }], vars, { readOnly: ro, height: 330, buttons: { add: () => ({ name: "", value: "" }), remove: true } });
          } },
        ] },
        { label: "Schematic Data", pages: [
          { label: "Embedded Files", build(pg) { embeddedFilesPage(pg, () => rootP); } },
        ] },
      ], { selected: page });
    },
    ok() {
      if (ro) return;
      const ce = chainClassError(chains.classes); if (ce) { void messageBox(ce, "Net Chain Classes"); return false; }
      const bad = vars.find((v) => v.name && !/^[^\s${}:]+$/.test(v.name)); if (bad) { toast(`Text variable name '${bad.name}' may not contain spaces, $, {, } or :`, 4000); return false; }
      saveProject((p) => {
        writeInto(p);
      }, "schematic setup").then(() => toast("Schematic setup saved to the project"), (err: Error) => toast("Could not save the project settings: " + err.message, 5000));
    } });
}

/** DIALOG_SCH_IMPORT_SETTINGS: "Import from:" another project of the person's, the sections to import, Select All. */
function importDialog(onImport: (other: JsonObj, sel: string[]) => void): void {
  const projects: [string, string][] = [];
  const from = h("k-select", { id: "kd-ssi-from", style: "flex:1" }) as HTMLElement & { value: string };
  from.append(h("option", { value: "" }, "Loading projects..."));
  const picked = new Set<string>();
  const boxes = SCH_IMPORT_OPTIONS.map(([k, label]) => checkbox(label, false, (on) => { if (on) picked.add(k); else picked.delete(k); sync(); }, { id: "kd-ssi-" + k }));
  let okBtn: HTMLButtonElement | null = null;
  const sync = (): void => { if (okBtn) okBtn.disabled = !picked.size || !from.value; };
  const all = h("button", { type: "button", class: "btn", id: "kd-ssi-all" }, "Select All") as HTMLButtonElement;
  all.addEventListener("click", () => {
    const on = picked.size !== SCH_IMPORT_OPTIONS.length;
    boxes.forEach((b, i) => { const cb = b.querySelector("input") as HTMLInputElement; cb.checked = on; if (on) picked.add(SCH_IMPORT_OPTIONS[i][0]); else picked.delete(SCH_IMPORT_OPTIONS[i][0]); });
    all.textContent = on ? "Deselect All" : "Select All"; sync();
  });
  from.addEventListener("change", sync);
  void (async () => {
    try {
      const list = await api("/api/projects") as { projects: { projectId: string; name: string }[] };
      const here = appState.project ? (appState.project as { projectId: string }).projectId : "";
      for (const p of list.projects || []) {
        if (p.projectId === here) continue;
        const info = await api(`/api/projects/${p.projectId}/info`) as { docs: { docId: string; docType: string; path: string }[] };
        const pro = (info.docs || []).find((d) => d.docType === "kicad_pro"); if (pro) projects.push([pro.docId, `${p.name} / ${pro.path}`]);
      }
    } catch { /* no list: nothing to pick */ }
    from.replaceChildren(h("option", { value: "" }, projects.length ? "" : "No other projects"), ...projects.map(([v, l]) => h("option", { value: v }, l)));
    sync();
  })();
  KD().open({ title: "Import Settings", width: 520, okLabel: "Import Settings", child: true,
    build(body, a) {
      okBtn = (a.foot.querySelector(".btn.primary") as HTMLButtonElement) || null;
      body.append(h("div", { class: "kd-row" }, h("label", null, "Import from:"), from), h("div", { style: "margin:8px 0 4px" }, "Import:"), ...boxes, h("div", { class: "kd-row", style: "margin-top:8px" }, all));
      sync();
    },
    ok() {
      const id = from.value; if (!id || !picked.size) return false;
      const sel = SCH_IMPORT_OPTIONS.map((o) => o[0]).filter((k) => picked.has(k));
      void api(`/api/docs/${id}/content`).then((t) => {
        let other: JsonObj | null = null;
        try { other = (typeof t === "string" ? JSON.parse(t) : t) as JsonObj; } catch { other = null; }
        if (!other || typeof other !== "object") { void messageBox(`Error importing settings from project:\nProject file ${projects.find((p) => p[0] === id)?.[1] || ""} could not be loaded.`); return; }
        onImport(other, sel);
      }, () => { void messageBox("Error importing settings from project:\nProject file could not be loaded."); });
      return true;
    } });
}
