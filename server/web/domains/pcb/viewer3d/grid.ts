// viewer3d/grid.ts — View > 3D Grid (EDA_3D_ACTIONS::noGrid / show10mmGrid / show5mmGrid / show2_5mmGrid /
// show1mmGrid): the line grid RENDER_3D_OPENGL::generate3dGrid draws, as plain arrays for a LineSegments mesh.
// One horizontal grid in the board plane over max(board, 100 mm) x 1.2 centred on the board, and one vertical grid
// through the board's centre from z = -50 mm to +100 mm; every fifth line in the marker colour.

/** GRID3D_TYPE: the grid pitch in millimetres, 0 for NONE. */
export type Grid3D = 0 | 10 | 5 | 2.5 | 1;
export const GRID3D_CHOICES: Grid3D[] = [0, 10, 5, 2.5, 1];
/** DARKGRAY and LIGHTBLUE of colorRefs(), at generate3dGrid's 0.35 transparency */
export const GRID_COLOR: [number, number, number] = [72 / 255, 72 / 255, 72 / 255];
export const GRID_MARKER: [number, number, number] = [144 / 255, 144 / 255, 1];
export const GRID_ALPHA = 0.35;

export interface GridGeometry { pos: number[]; col: number[] }

/** The grid lines for a board of w x h mm centred on the origin, the board plane at z = zBoard. */
export function gridLines(w: number, h: number, pitch: Grid3D, zBoard = 0): GridGeometry {
  const pos: number[] = [], col: number[] = [];
  if (!pitch) return { pos, col };
  const xsize = Math.max(w, 100) * 1.2, ysize = Math.max(h, 100) * 1.2;
  const xmin = -xsize / 2, xmax = xsize / 2, ymin = -ysize / 2, ymax = ysize / 2, zmin = -50, zmax = 100;
  const line = (ii: number, a: number[], b: number[]): void => { const c = ii % 5 ? GRID_COLOR : GRID_MARKER; pos.push(...a, ...b); col.push(...c, ...c); };
  // the horizontal grid, centred on the board
  for (let ii = 0; ; ii++) {
    const d = ii * pitch;
    if (d <= xsize / 2) { line(ii, [d, ymin, zBoard], [d, ymax, zBoard]); if (ii) line(ii, [-d, ymin, zBoard], [-d, ymax, zBoard]); }
    if (d <= ysize / 2) { line(ii, [xmin, d, zBoard], [xmax, d, zBoard]); if (ii) line(ii, [xmin, -d, zBoard], [xmax, -d, zBoard]); }
    if (d > xsize / 2 && d > ysize / 2) break;
  }
  // the vertical grid through the board's centre: lines parallel to Z, then parallel to X
  let xlo = 0, xhi = 0;
  for (let ii = 0; ; ii++) {
    const d = ii * pitch; xhi = d; line(ii, [d, 0, zBoard + zmin], [d, 0, zBoard + zmax]);
    if (ii) { xlo = -d; line(ii, [-d, 0, zBoard + zmin], [-d, 0, zBoard + zmax]); }
    if (d > xsize / 2) break;
  }
  for (let ii = 0; ; ii++) {
    const d = ii * pitch;
    if (d <= zmax) line(ii, [xlo, 0, zBoard + d], [xhi, 0, zBoard + d]);
    if (d <= -zmin && ii) line(ii, [xlo, 0, zBoard - d], [xhi, 0, zBoard - d]);
    if (d > zmax && d > -zmin) break;
  }
  return { pos, col };
}
