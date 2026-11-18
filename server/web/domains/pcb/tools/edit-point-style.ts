// tools/edit-point-style.ts — how KiCad draws edit points (common/tool/edit_points.cpp EDIT_POINTS::ViewDraw), shared
// by the schematic point editor (sch-tools/point-edit.ts) and the Symbol Editor's (symedit/rect-edit.ts).
export const EDIT_POINT_PX = 8;                                  // EDIT_POINT::POINT_SIZE
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
export const EDIT_BORDER_PX = IS_MAC ? 3 : 2;                  // EDIT_POINT::BORDER_SIZE (3 on macOS)
export function editPointColors(aux: string, bg: string) {
  let d = parseRgb(aux) || [0, 0, 0]; const b = parseRgb(bg);
  if (b && (d[0] - b[0]) ** 2 + (d[1] - b[1]) ** 2 + (d[2] - b[2]) ** 2 < 0.5) d = [1 - d[0], 1 - d[1], 1 - d[2]];   // COLOR4D::Distance < 0.5: Invert
  const br = d[0] * 0.299 + d[1] * 0.587 + d[2] * 0.117;
  const shade = (f: number, dark: boolean) => "rgba(" + d.map((v) => Math.round(255 * (dark ? v * (1 - f) : v + (1 - v) * f))).join(",") + ",0.8)";
  const [bf, dark] = br > 0.5 ? [0.7, true] : br > 0.2 ? [0.4, false] : [0.7, false];
  return { fill: "rgb(" + d.map((v) => Math.round(255 * v)).join(",") + ")", border: shade(bf as number, dark as boolean) };
}
function parseRgb(c: string): number[] | null {
  if (!c) return null;
  let m = /^#([0-9a-f]{6})/i.exec(c); if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16) / 255);
  m = /^#([0-9a-f]{3})$/i.exec(c); if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16) / 255);
  m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(c); return m ? [+m[1] / 255, +m[2] / 255, +m[3] / 255] : null;
}
