// dialogs/preferences-sym.ts — the Preferences pages of the Symbol Editor (PANEL_SYM_DISPLAY_OPTIONS,
// PANEL_SYM_EDITING_OPTIONS, PANEL_SYM_COLOR_SETTINGS) and the Schematic Editor's global Field Name Templates
// (PANEL_TEMPLATE_FIELDNAMES over EESCHEMA_SETTINGS drawing.field_names).  They edit the staged Prefs; the dialog's OK
// saves them and the Symbol Editor frame takes them up (symedit/editor.ts applySymPrefs).
import { KD, checkbox, h, select } from "./dom";
import { lenField } from "../editor/pcbdialogs/ui";
import { loadUnits, unitName } from "../../../shared/units";
import { COLOR_THEMES, type Prefs, type SchThemeId } from "./prefs";

/** PANEL_SYM_DISPLAY_OPTIONS: the Appearance box. */
export function symDisplayPage(pg: HTMLElement, p: Prefs): void {
  const d = p.symDisplay;
  const box = KD().staticBox(pg, "Appearance");
  box.append(
    checkbox("Show hidden pins", d.showHiddenPins, (on) => { d.showHiddenPins = on; }, { id: "kd-pref-sym-hiddenpins" }),
    checkbox("Show hidden fields", d.showHiddenFields, (on) => { d.showHiddenFields = on; }, { id: "kd-pref-sym-hiddenfields" }),
    checkbox("Show pin electrical type", d.showETypes, (on) => { d.showETypes = on; }, { id: "kd-pref-sym-etypes" }),
    checkbox("Show pin alternate mode indicator icons", d.showAltIcons, (on) => { d.showAltIcons = on; }, { id: "kd-pref-sym-alticons" }));
}

/** PANEL_SYM_EDITING_OPTIONS: Defaults for New Objects, Repeated Items and General Editing, lengths in the editor's units. */
export function symEditingPage(pg: HTMLElement, p: Prefs): void {
  const e = p.symEditing, su = loadUnits("symbol_editor").units, uname = unitName(su);
  const len = (id: string, mm: number, set: (x: number) => void, min = 0): HTMLInputElement => {
    const f = lenField(mm, { units: su, onChange: (x: number) => { if (isFinite(x) && x >= min) set(x); } }); f.input.id = id; f.input.style.width = "90px"; return f.input as HTMLInputElement;
  };
  const grid = (...cells: (HTMLElement | string)[]): HTMLElement => h("div", { style: "display:grid;grid-template-columns:max-content max-content max-content;gap:6px 8px;align-items:center" }, ...cells);
  const row = (label: string, ctl: HTMLElement): (HTMLElement | string)[] => [h("label", null, label), ctl, h("span", { class: "ro" }, uname)];
  const L = h("div", { style: "flex:1;min-width:0" }), R = h("div", { style: "flex:1;min-width:0" });
  pg.append(h("div", { style: "display:flex;gap:16px" }, L, R));
  const dn = KD().staticBox(L, "Defaults for New Objects");
  dn.append(grid(
    ...row("Default line width:", len("kd-pref-sym-linewidth", e.lineWidth, (x) => { e.lineWidth = x; })),
    h("span", { class: "kd-note", style: "grid-column:1/-1;margin:0 0 4px;white-space:pre-line" }, "Set to 0 to allow symbols to inherit line width properties\nfrom schematic"),
    ...row("Default text size:", len("kd-pref-sym-textsize", e.textSize, (x) => { e.textSize = x; }, 0.0001)),
    ...row("Default pin length:", len("kd-pref-sym-pinlength", e.pinLength, (x) => { e.pinLength = x; })),
    ...row("Default pin number size:", len("kd-pref-sym-pinnumsize", e.pinNumSize, (x) => { e.pinNumSize = x; }, 0.0001)),
    ...row("Default pin name size:", len("kd-pref-sym-pinnamesize", e.pinNameSize, (x) => { e.pinNameSize = x; }, 0.0001))));
  const ri = KD().staticBox(L, "Repeated Items");
  // m_spinRepeatLabel: -10 .. 10
  const inc = h("input", { type: "number", id: "kd-pref-sym-labeldelta", min: "-10", max: "10", step: "1", value: String(e.labelDelta), style: "width:90px" }) as HTMLInputElement;
  inc.addEventListener("change", () => { const x = Math.round(+inc.value); if (isFinite(x)) { e.labelDelta = Math.max(-10, Math.min(10, x)); inc.value = String(e.labelDelta); } });
  // onKillFocusPinPitch / TransferDataFromWindow: the pitch is forced to a multiple of MIN_GRID (25 mils)
  e.pinPitch = roundPinPitch(e.pinPitch);
  const pitch = lenField(e.pinPitch, { units: su, onChange: (x: number) => { if (!isFinite(x)) return; e.pinPitch = roundPinPitch(x); pitch.set(e.pinPitch); } });
  pitch.input.id = "kd-pref-sym-pinpitch"; pitch.input.style.width = "90px";
  ri.append(grid(...row("Pitch of repeated pins:", pitch.input as HTMLInputElement), h("label", null, "Label increment:"), inc, h("span")));
  KD().staticBox(R, "General Editing").append(checkbox("Keep pins attached when dragging edges", e.dragPinsWithEdges, (on) => { e.dragPinsWithEdges = on; }, { id: "kd-pref-sym-dragpins" }));
}

/** PANEL_SYM_EDITING_OPTIONS' MIN_GRID rounding of the repeat pin pitch: KiROUND( mils / 25 ) * 25, in mm. */
export function roundPinPitch(mm: number): number {
  const mils = Math.round(mm / 0.0254);
  return Math.round(mils / 25) * 25 * 0.0254;
}

/** PANEL_SYM_COLOR_SETTINGS: the schematic editor's theme, or one of the Symbol Editor's own. */
export function symColorsPage(pg: HTMLElement, p: Prefs): void {
  const c = p.symColors;
  const radio = (v: "sch" | "own", label: string): HTMLLabelElement => {
    const r = h("input", { type: "radio", name: "kd-pref-sym-colors", id: "kd-pref-sym-colors-" + v, style: "width:auto;margin:0" }) as HTMLInputElement;
    r.checked = (v === "sch") === c.useSch;
    r.addEventListener("change", () => { if (r.checked) { c.useSch = v === "sch"; theme.disabled = c.useSch; } });
    return h("label", { class: "kd-row", style: "gap:6px;margin-bottom:6px" }, r, label) as HTMLLabelElement;
  };
  const theme = select(COLOR_THEMES, c.theme, (v) => { c.theme = v as SchThemeId; }, { id: "kd-pref-sym-theme", style: "width:220px", disabled: c.useSch });
  pg.append(radio("sch", "Use schematic editor color theme"), h("div", { class: "kd-row", style: "gap:8px" }, radio("own", "Use theme:"), theme));
}

/** PANEL_TEMPLATE_FIELDNAMES( global ): Name / Visible / URL with add, move up / down and delete. */
export function fieldTemplatesPage(pg: HTMLElement, p: Prefs): void {
  pg.append(h("div", { style: "font-weight:600;margin-bottom:6px" }, "Field Name Templates"));
  KD().grid<Prefs["schFieldNames"][number]>(pg, [{ key: "name", label: "Name", type: "text" }, { key: "visible", label: "Visible", type: "bool", width: 70 }, { key: "url", label: "URL", type: "bool", width: 60 }], p.schFieldNames,
    { height: 330, buttons: { add: () => ({ name: "", visible: false, url: false }), move: true, remove: true } });
}

/** PANEL_TEMPLATE_FIELDNAMES::TransferDataFromWindow: names are trimmed, empty rows dropped, the first of a name kept. */
export function cleanFieldTemplates(rows: Prefs["schFieldNames"]): Prefs["schFieldNames"] {
  const seen = new Set<string>(), out: Prefs["schFieldNames"] = [];
  for (const r of rows) { const name = String(r.name || "").trim(); if (!name || seen.has(name)) continue; seen.add(name); out.push({ name, visible: !!r.visible, url: !!r.url }); }
  return out;
}
