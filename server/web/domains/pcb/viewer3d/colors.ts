// viewer3d/colors.ts — KiCad's default 3D viewer colours (3d-viewer/3d_canvas/board_adapter.cpp:212-225,
// the g_Default* COLOR4D values) and the placeholder colours of the component bodies.

/** r, g, b in 0..1 (sRGB, as KiCad's COLOR4D stores them) and alpha. */
export type RGBA = [number, number, number, number];

export const BACKGROUND_TOP: RGBA = [0.80, 0.80, 0.90, 1];      // g_DefaultBackgroundTop
export const BACKGROUND_BOTTOM: RGBA = [0.40, 0.40, 0.50, 1];   // g_DefaultBackgroundBot
export const SILKSCREEN: RGBA = [0.94, 0.94, 0.94, 1];          // g_DefaultSilkscreen
export const SOLDER_MASK: RGBA = [0.08, 0.20, 0.14, 0.83];      // g_DefaultSolderMask
export const SOLDER_PASTE: RGBA = [0.50, 0.50, 0.50, 1];        // g_DefaultSolderPaste
export const SURFACE_FINISH: RGBA = [0.75, 0.61, 0.23, 1];      // g_DefaultSurfaceFinish (copper)
export const BOARD_BODY: RGBA = [0.43, 0.45, 0.30, 0.90];       // g_DefaultBoardBody
/** The inside of a drilled hole seen from above where it could not be cut out of the board mesh. */
export const HOLE_SHADE: RGBA = [0.10, 0.09, 0.07, 1];

export function css(c: RGBA, alpha = c[3]): string {
  const v = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  return alpha >= 1 ? `rgb(${v(c[0])},${v(c[1])},${v(c[2])})` : `rgba(${v(c[0])},${v(c[1])},${v(c[2])},${+alpha.toFixed(3)})`;
}

export function hex(c: RGBA): string {
  const v = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
  return "#" + v(c[0]) + v(c[1]) + v(c[2]);
}

export function fromHex(h: string): RGBA {
  const m = /^#?([0-9a-f]{6})$/i.exec(h); if (!m) return [0, 0, 0, 1];
  const n = parseInt(m[1], 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

export const ADHESIVE: RGBA = [0.70, 0.11, 0.17, 1];            // g_DefaultAdhesive
export const COMMENTS: RGBA = [0.85, 0.85, 0.85, 1];            // g_DefaultComments
export const ECOS: RGBA = [0.70, 0.10, 0.10, 1];                // g_DefaultECOs
export const FAB: RGBA = [0.60, 0.60, 0.60, 1];                 // g_DefaultFabColor
export const COURTYARD: RGBA = [1.000, 0.149, 0.886, 1];        // g_DefaultCourtyardColor

/**
 * The extra board layers the 3D viewer can draw on a face (BOARD_ADAPTER::Is3dLayerEnabled): the Appearance key,
 * the board layers it covers, the face, the default colour (LAYER_PRESET_3D's colours) and whether it shows by default.
 * The user layers User.1 … User.45 follow, on the front face, in the comments colour.
 */
export interface ExtraLayer { key: string; label: string; layers: string[]; tip: string; color: RGBA; on: boolean }
export const EXTRA_LAYERS: ExtraLayer[] = [
  { key: "adhesive", label: "Adhesive", layers: ["F.Adhes", "B.Adhes"], tip: "Show adhesive", color: ADHESIVE, on: true },
  { key: "Dwgs.User", label: "User.Drawings", layers: ["Dwgs.User"], tip: "Show user drawings layer", color: COMMENTS, on: false },
  { key: "Cmts.User", label: "User.Comments", layers: ["Cmts.User"], tip: "Show user comments layer", color: COMMENTS, on: false },
  { key: "Eco1.User", label: "User.Eco1", layers: ["Eco1.User"], tip: "Show user ECO1 layer", color: ECOS, on: false },
  { key: "Eco2.User", label: "User.Eco2", layers: ["Eco2.User"], tip: "Show user ECO2 layer", color: ECOS, on: false },
  { key: "F.Fab", label: "F.Fab", layers: ["F.Fab"], tip: "Show front fabrication layer", color: FAB, on: false },
  { key: "B.Fab", label: "B.Fab", layers: ["B.Fab"], tip: "Show back fabrication layer", color: FAB, on: false },
  { key: "F.CrtYd", label: "F.Courtyard", layers: ["F.CrtYd"], tip: "Show front courtyard layer", color: COURTYARD, on: false },
  { key: "B.CrtYd", label: "B.Courtyard", layers: ["B.CrtYd"], tip: "Show back courtyard layer", color: COURTYARD, on: false },
  ...Array.from({ length: 45 }, (_, i): ExtraLayer => ({ key: `User.${i + 1}`, label: `User.${i + 1}`, layers: [`User.${i + 1}`], tip: `Show user defined layer ${i + 1}`, color: COMMENTS, on: false })),
];
/** The face an extra board layer is drawn on: the back for B.* layers, the front for everything else. */
export const extraSide = (layer: string): "F" | "B" => (layer.startsWith("B.") ? "B" : "F");

/**
 * The colours the board is drawn with: KiCad's 3D layer colours (EDA_3D_VIEWER_SETTINGS / the Appearance manager's
 * swatches, LAYER_3D_BOARD … LAYER_3D_SOLDERPASTE and the extra layers by key), changed by the Appearance panel.
 * Each face has its own silkscreen and mask colour.
 */
export type LayerColors = Record<string, RGBA>;
export const DEFAULT_LAYER_COLORS: LayerColors = { board: BOARD_BODY, copper: SURFACE_FINISH, paste: SOLDER_PASTE, silkTop: SILKSCREEN, silkBottom: SILKSCREEN, maskTop: SOLDER_MASK, maskBottom: SOLDER_MASK,
  ...Object.fromEntries(EXTRA_LAYERS.map((l) => [l.key, l.color])) };
export const LAYER_COLORS: LayerColors = cloneLayerColors(DEFAULT_LAYER_COLORS);
export function cloneLayerColors(c: LayerColors): LayerColors { const out: LayerColors = {}; for (const k of Object.keys(c)) out[k] = c[k].slice() as RGBA; return out; }
export function setLayerColors(c: Partial<LayerColors>): void { for (const k of Object.keys(c)) { const v = c[k]; if (v && v.length === 4 && k in DEFAULT_LAYER_COLORS) LAYER_COLORS[k] = v.slice() as RGBA; } }

/**
 * Colours that stand in for the user's while an Appearance option asks for them: "Use board stackup colors"
 * (BOARD_ADAPTER::InitSettings reads the stackup's silkscreen, mask and dielectric colours) and "Use PCB editor
 * copper colors" (copperTop / copperBottom from the board editor's F.Cu / B.Cu).
 */
let OVERRIDE: Partial<LayerColors> = {};
export function setColorOverride(c: Partial<LayerColors> | null): void { OVERRIDE = c ? { ...c } : {}; }
/** The colour a layer is drawn with now: an override, else the user's colour; copperTop / copperBottom fall back to copper. */
export function layerColor(key: string): RGBA {
  const o = OVERRIDE[key]; if (o) return o;
  if ((key === "copperTop" || key === "copperBottom")) return OVERRIDE.copper || LAYER_COLORS.copper;
  return LAYER_COLORS[key] || DEFAULT_LAYER_COLORS[key] || BOARD_BODY;
}
export function colorStamp(): string { return JSON.stringify(LAYER_COLORS) + JSON.stringify(OVERRIDE); }

/**
 * BOARD_ADAPTER's own colour tables (3d-viewer/3d_canvas/board_adapter.cpp:170-210: g_SilkColors, g_MaskColors,
 * g_FinishColors, g_BoardColors), r, g, b in 0..255 and alpha in 0..1, which a stackup colour name is looked up in.
 * The first silkscreen and mask rows are NotSpecifiedPrm() ("Not specified").
 */
type Named = [string, number, number, number, number];
const NOT_SPECIFIED = "Not specified";
const SILK_COLORS: Named[] = [[NOT_SPECIFIED, 245, 245, 245, 1], ["Green", 20, 51, 36, 1], ["Red", 181, 19, 21, 1], ["Blue", 2, 59, 162, 1], ["Black", 11, 11, 11, 1],
  ["White", 245, 245, 245, 1], ["Purple", 32, 2, 53, 1], ["Yellow", 194, 195, 0, 1]];
const MASK_COLORS: Named[] = [[NOT_SPECIFIED, 20, 51, 36, 0.83], ["Green", 20, 51, 36, 0.83], ["Light Green", 91, 168, 12, 0.83], ["Saturated Green", 13, 104, 11, 0.83],
  ["Red", 181, 19, 21, 0.83], ["Light Red", 210, 40, 14, 0.83], ["Red/Orange", 239, 53, 41, 0.83], ["Blue", 2, 59, 162, 0.83], ["Light Blue 1", 54, 79, 116, 0.83],
  ["Light Blue 2", 61, 85, 130, 0.83], ["Green/Blue", 21, 70, 80, 0.83], ["Black", 11, 11, 11, 0.83], ["White", 245, 245, 245, 0.83], ["Purple", 32, 2, 53, 0.83],
  ["Light Purple", 119, 31, 91, 0.83], ["Yellow", 194, 195, 0, 0.83]];
const FINISH_COLORS: Named[] = [["Copper", 184, 115, 50, 1], ["Gold", 178, 156, 0, 1], ["Silver", 213, 213, 213, 1], ["Tin", 160, 160, 160, 1]];
const BOARD_COLORS: Named[] = [["FR4 natural, dark", 51, 43, 22, 0.83], ["FR4 natural", 109, 116, 75, 0.83], ["PTFE natural", 252, 252, 250, 0.90], ["Polyimide", 205, 130, 0, 0.68],
  ["Phenolic natural", 92, 17, 6, 0.90], ["Brown 1", 146, 99, 47, 0.83], ["Brown 2", 160, 123, 54, 0.83], ["Brown 3", 146, 99, 47, 0.83], ["Aluminum", 213, 213, 213, 1]];
/**
 * BOARD_ADAPTER::GetLayerColors' findColor: "#RRGGBB" / "#RRGGBBAA" as written, else the name in the table, else
 * COLOR4D() (opaque black), as KiCad does for a name the table lacks.
 */
export function stackupColor(name: string | undefined, table: "silk" | "mask" | "board" | "finish"): RGBA {
  const n = name === undefined || name === "" ? NOT_SPECIFIED : name;
  if (n.startsWith("#")) {
    const hx = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(n);
    if (hx) { const v = parseInt(hx[1], 16); return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, hx[2] ? parseInt(hx[2], 16) / 255 : 1]; }
    return [0, 0, 0, 1];
  }
  const set = table === "silk" ? SILK_COLORS : table === "mask" ? MASK_COLORS : table === "board" ? BOARD_COLORS : FINISH_COLORS;
  const row = set.find((c) => c[0] === n);
  return row ? [row[1] / 255, row[2] / 255, row[3] / 255, row[4]] : [0, 0, 0, 1];
}
/** The finish colour of a stackup copper_finish (board_adapter.cpp:796-815), or null when the copper keeps its colour. */
export function finishColor(finish: string | null | undefined): RGBA | null {
  const f = finish || "";
  if (f.endsWith("OSP")) return stackupColor("Copper", "finish");
  if (f.endsWith("IG") || f.endsWith("gold")) return stackupColor("Gold", "finish");
  if (f.startsWith("HAL") || f.startsWith("HASL") || f.endsWith("tin") || f.endsWith("nickel")) return stackupColor("Tin", "finish");
  if (f.endsWith("silver")) return stackupColor("Silver", "finish");
  return null;
}
/**
 * "Use board stackup colors" (BOARD_ADAPTER::GetLayerColors with m_UseStackupColors): silkscreen and solder mask by
 * name, the board body mixed from every dielectric layer (COLOR4D::Mix by 1 - alpha, alpha raised by half the layer's),
 * and the copper from the surface finish.
 */
export function stackupOverride(layers: { name: string; type?: string; color?: string }[], finish?: string | null): Partial<LayerColors> {
  const out: Partial<LayerColors> = {};
  let body: RGBA | null = null;
  for (const l of layers) {
    if (l.name === "F.SilkS") out.silkTop = stackupColor(l.color, "silk");
    else if (l.name === "B.SilkS") out.silkBottom = stackupColor(l.color, "silk");
    else if (l.name === "F.Mask") out.maskTop = stackupColor(l.color, "mask");
    else if (l.name === "B.Mask") out.maskBottom = stackupColor(l.color, "mask");
    else if (/^dielectric/.test(l.name) || l.type === "core" || l.type === "prepreg") {
      const c = stackupColor(l.color, "board");
      if (!body) body = c.slice() as RGBA;
      else { const f = 1 - c[3]; body = [c[0] * (1 - f) + body[0] * f, c[1] * (1 - f) + body[1] * f, c[2] * (1 - f) + body[2] * f, body[3]]; }
      body[3] += (1 - body[3]) * c[3] / 2;
    }
  }
  if (body && !(body[0] === 0 && body[1] === 0 && body[2] === 0 && body[3] === 0)) out.board = body;
  const fc = finishColor(finish); if (fc) out.copper = fc;
  return out;
}
