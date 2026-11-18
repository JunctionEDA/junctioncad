// symedit/rect-edit.ts — the Symbol Editor's rectangle edit points (sch_point_editor.cpp
// RECTANGLE_POINT_EDIT_BEHAVIOR): the four corners, the centre and the four edge handles (EDIT_LINE midpoints).
// A corner reshapes the rectangle, the centre moves it, an edge moves that one side.  With Preferences > Symbol
// Editor > Editing Options "Keep pins attached when dragging edges" (m_dragPinsAlongWithEdges) an edge drag also moves
// the pins whose root lies on that edge, ends excluded (dragPinsOnEdge); corner drags never move pins.
// File coordinates (Y up) throughout.
import * as M from "./model";

/** RECT_TOPLEFT, RECT_TOPRIGHT, RECT_BOTLEFT, RECT_BOTRIGHT, RECT_CENTER, then RECT_TOP, RECT_RIGHT, RECT_BOT, RECT_LEFT. */
export const RECT_HANDLES = 9;
export type FileBox = [number, number, number, number];   // minX, minY, maxX, maxY

export function rectBox(n: M.Node): FileBox | null {
  const s = M.kidOf(n, "start"), e = M.kidOf(n, "end"); if (!s || !e) return null;
  const x0 = Number(s[1]) || 0, y0 = Number(s[2]) || 0, x1 = Number(e[1]) || 0, y1 = Number(e[2]) || 0;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** The handles of a rectangle, in the order of RECT_HANDLES (file coordinates; "top" is the larger Y). */
export function rectHandles(b: FileBox): [number, number][] {
  const [x0, y0, x1, y1] = b, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return [[x0, y1], [x1, y1], [x0, y0], [x1, y0], [cx, cy], [cx, y1], [x1, cy], [cx, y0], [x0, cy]];
}

/** Where a pin meets the body (SCH_PIN::GetPinRoot): its position plus its length along its orientation. */
export function pinRoot(pin: M.Node): [number, number] {
  const at = M.kidOf(pin, "at"), len = M.kidOf(pin, "length");
  const x = at ? Number(at[1]) || 0 : 0, y = at ? Number(at[2]) || 0 : 0, a = at ? Number(at[3]) || 0 : 0, l = len ? Number(len[1]) || 0 : 0;
  const r = (a * Math.PI) / 180;
  return [x + Math.round(Math.cos(r)) * l, y + Math.round(Math.sin(r)) * l];
}

const EPS = 1e-6;
/** SEG::Contains with the ends left out (getPinsOnSeg( ..., aIncludeEnds = false )) for an axis-aligned edge. */
function onEdge(p: [number, number], a: [number, number], b: [number, number]): boolean {
  const same = (u: [number, number], v: [number, number]) => Math.abs(u[0] - v[0]) < EPS && Math.abs(u[1] - v[1]) < EPS;
  if (same(p, a) || same(p, b)) return false;
  if (Math.abs(a[0] - b[0]) < EPS) return Math.abs(p[0] - a[0]) < EPS && p[1] > Math.min(a[1], b[1]) - EPS && p[1] < Math.max(a[1], b[1]) + EPS;
  return Math.abs(p[1] - a[1]) < EPS && p[0] > Math.min(a[0], b[0]) - EPS && p[0] < Math.max(a[0], b[0]) + EPS;
}

/**
 * Drag handle `h` of rectangle `rect` (unit `unit` of `sym`) by (dx, dy).  Returns the pins moved with an edge.
 * `dragPins`: SYMBOL_EDITOR_SETTINGS m_dragPinsAlongWithEdges.
 */
export function dragRectHandle(sym: M.Node, rect: M.Node, unit: number, h: number, dx: number, dy: number, dragPins: boolean): M.Node[] {
  const b = rectBox(rect); if (!b) return [];
  let [x0, y0, x1, y1] = b;
  let edge: [[number, number], [number, number]] | null = null, mv: [number, number] = [0, 0];
  switch (h) {
    case 0: x0 += dx; y1 += dy; break;
    case 1: x1 += dx; y1 += dy; break;
    case 2: x0 += dx; y0 += dy; break;
    case 3: x1 += dx; y0 += dy; break;
    case 4: x0 += dx; x1 += dx; y0 += dy; y1 += dy; break;
    case 5: edge = [[b[0], b[3]], [b[2], b[3]]]; mv = [0, dy]; y1 += dy; break;
    case 6: edge = [[b[2], b[1]], [b[2], b[3]]]; mv = [dx, 0]; x1 += dx; break;
    case 7: edge = [[b[0], b[1]], [b[2], b[1]]]; mv = [0, dy]; y0 += dy; break;
    case 8: edge = [[b[0], b[1]], [b[0], b[3]]]; mv = [dx, 0]; x0 += dx; break;
    default: return [];
  }
  // PinEditedCorner: the corners keep at least a mil between them
  const MIN = 0.0254;
  if (h !== 4) {
    if (x1 - x0 < MIN) { if (h === 0 || h === 2 || h === 8) x0 = x1 - MIN; else x1 = x0 + MIN; }
    if (y1 - y0 < MIN) { if (h === 2 || h === 3 || h === 7) y0 = y1 - MIN; else y1 = y0 + MIN; }
  }
  const s = M.kidOf(rect, "start")!, e = M.kidOf(rect, "end")!;
  // m_rect.Normalize(): start top-left, end bottom-right
  s[1] = +M.fmt(x0); s[2] = +M.fmt(y1); e[1] = +M.fmt(x1); e[2] = +M.fmt(y0);
  if (!edge || !dragPins || (!mv[0] && !mv[1])) return [];
  const moved: M.Node[] = [];
  // GetGraphicalPins( aUnit, 0 ): every body style; unit 0 reaches every unit's pins
  for (const d of M.allPins(sym)) {
    if (unit !== 0 && d.unit !== 0 && d.unit !== unit) continue;
    if (!onEdge(pinRoot(d.node), edge[0], edge[1])) continue;
    M.moveNode(d.node, mv[0], mv[1]); moved.push(d.node);
  }
  return moved;
}
