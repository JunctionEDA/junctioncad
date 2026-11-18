// dialogs/field-templates.ts — TEMPLATES (common/template_fieldnames.cpp): the field name templates of the project
// (.kicad_pro schematic.drawing.field_names, Schematic Setup > Field Name Templates) and the global ones (Preferences >
// Schematic Editor > Field Name Templates, EESCHEMA_SETTINGS drawing.field_names).
import { prefs } from "./prefs";
import { obj, projectJson } from "./project";

export interface FieldTemplate { name: string; visible: boolean; url: boolean }

/** TEMPLATES::GetTemplateFieldNames( GLOBAL ). */
export function globalFieldTemplates(): FieldTemplate[] {
  return (prefs().schFieldNames || []).filter((t) => t && String(t.name || "").trim()).map((t) => ({ name: String(t.name).trim(), visible: !!t.visible, url: !!t.url }));
}

/** TEMPLATES::GetTemplateFieldNames( PROJECT ). */
export function projectFieldTemplates(): FieldTemplate[] {
  const fn = obj(obj(projectJson().schematic).drawing).field_names;
  return (Array.isArray(fn) ? fn : []).map((f) => obj(f)).filter((f) => typeof f.name === "string" && f.name.trim()).map((f) => ({ name: String(f.name).trim(), visible: !!f.visible, url: !!f.url }));
}

/** TEMPLATES::resolveTemplates: the project's templates, then each global one the project does not override by name. */
export function resolvedFieldTemplates(): FieldTemplate[] {
  return mergeFieldTemplates(projectFieldTemplates(), globalFieldTemplates());
}
export function mergeFieldTemplates(project: FieldTemplate[], globals: FieldTemplate[]): FieldTemplate[] {
  const out = project.slice();
  for (const g of globals) if (!project.some((p) => p.name === g.name)) out.push(g);
  return out;
}
