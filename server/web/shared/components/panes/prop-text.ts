// prop-text.ts — the Properties grid's value as text (no React here, so node tests can load it).

/** wxPGProperty::GetValueAsString: what Ctrl+C copies from the selected row (wxBoolProperty: True / False, a choice's label). */
export function rowValueText(row: { type: string; value: string; mixed: boolean; choices?: [string, string][] }): string {
  if (row.mixed) return "";
  if (row.type === "bool") return row.value === "1" ? "True" : "False";
  if (row.type === "enum" && row.choices) { const c = row.choices.find(([v]) => v === row.value); return c ? c[1] : row.value; }
  return row.value;
}

/** A colour cell's text: "#rrggbb" when opaque, else "rgba(r,g,b,a)" (the alpha is kept, not forced to 1). */
export function colorText(rgb: number[], a: number): string {
  const [r, g, b] = rgb.map((x) => Math.max(0, Math.min(255, Math.round(x))));
  return a >= 1 ? "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("") : `rgba(${r},${g},${b},${+Math.max(0, a).toFixed(4)})`;
}
/** The (color r g b a) of a colour cell's text ("#rrggbb", "#rrggbbaa" or "rgb[a](…)"), null when it is none of them. */
export function parseColorText(t: string): number[] | null {
  const h = /^\s*#([0-9a-f]{6})([0-9a-f]{2})?\s*$/i.exec(t);
  if (h) { const x = parseInt(h[1], 16); return [x >> 16, (x >> 8) & 255, x & 255, h[2] ? +(parseInt(h[2], 16) / 255).toFixed(4) : 1]; }
  const m = /^\s*rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)\s*$/i.exec(t);
  if (!m) return null;
  const rgb = [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(+v))));
  return [...rgb, m[4] === undefined ? 1 : +Math.max(0, Math.min(1, +m[4])).toFixed(4)];
}
