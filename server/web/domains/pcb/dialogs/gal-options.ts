// dialogs/gal-options.ts — PANEL_GAL_OPTIONS' settings (common/dialogs/panel_gal_options.cpp), with no editor imports.

/**
 * PANEL_GAL_OPTIONS (WINDOW_SETTINGS grid.style / line_width / min_spacing / show_major and cursor.cross_hair_mode /
 * always_show_cursor), one per frame like the grids: the grid's look and the canvas cursor.
 */
export interface GalPrefs { style: "dots" | "lines" | "crosses"; lineWidth: number; minSpacing: number; showMajor: boolean; crosshair: "small" | "full" | "45"; alwaysShow: boolean }
/** PANEL_GAL_OPTIONS' spin controls: thickness 0.5..10 by 0.5 px, minimum spacing 5..200 by 5 px */
export const GRID_THICKNESS_CHOICES: number[] = Array.from({ length: 20 }, (_, i) => 0.5 + i * 0.5);
export const GRID_MIN_SPACING_RANGE = { min: 5, max: 200, step: 5 };
export const galDefaults = (): GalPrefs => ({ style: "dots", lineWidth: 1, minSpacing: 10, showMajor: true, crosshair: "small", alwaysShow: true });
/** A GalPrefs read back from storage, its numbers held to the panel's ranges. */
export function clampGal(g: GalPrefs): GalPrefs {
  const lw = GRID_THICKNESS_CHOICES.reduce((a, b) => (Math.abs(b - g.lineWidth) < Math.abs(a - g.lineWidth) ? b : a), 1);
  const ms = Math.max(GRID_MIN_SPACING_RANGE.min, Math.min(GRID_MIN_SPACING_RANGE.max, Math.round(+g.minSpacing || 10)));
  return { style: g.style === "lines" || g.style === "crosses" ? g.style : "dots", lineWidth: isFinite(lw) ? lw : 1, minSpacing: ms, showMajor: g.showMajor !== false,
    crosshair: g.crosshair === "full" || g.crosshair === "45" ? g.crosshair : "small", alwaysShow: g.alwaysShow !== false };
}
