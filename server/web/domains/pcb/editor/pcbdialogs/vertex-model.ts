// vertex-model.ts — PCB_VERTEX_EDITOR_PANE's model (pcbnew/widgets/vertex_editor_pane.cpp): the corners of a zone
// (every outline and hole, CIterateWithHoles) or of a polygon (PCB_SHAPE, SHAPE_T::POLY), one grid row each, and
// the edit of one coordinate.  Pure: the node tests load it.

type Node = (string | number | Node)[];
const isList = (v: unknown): v is Node => Array.isArray(v);
const kids = (n: Node, k: string): Node[] => n.filter((c): c is Node => isList(c) && c[0] === k);
const kid = (n: Node, k: string): Node | null => kids(n, k)[0] || null;

/** itemHasEditableCorners: a polygon, or a zone that is not a teardrop. */
export function hasEditableCorners(kind: string, node: Node): boolean {
  if (kind === "gr_poly") return true;
  if (kind === "zone") { const a = kid(node, "attr"); return !(a && kid(a, "teardrop")); }
  return false;
}
/** The (pts) lists that hold the corners: a zone's every (polygon), a polygon's own. */
function ptsLists(node: Node): Node[] {
  if (node[0] === "zone") return kids(node, "polygon").map((p) => kid(p, "pts")).filter((p): p is Node => !!p);
  const p = kid(node, "pts"); return p ? [p] : [];
}
/** m_rows: [list, xy index within it] per corner, with its coordinates (mm, board axes). */
export function vertexRows(node: Node): { list: number; at: number; x: number; y: number }[] {
  const out: { list: number; at: number; x: number; y: number }[] = [];
  ptsLists(node).forEach((pts, li) => kids(pts, "xy").forEach((xy, i) => out.push({ list: li, at: i, x: Number(xy[1]) || 0, y: Number(xy[2]) || 0 })));
  return out;
}
/**
 * OnGridCellChange on a CLONE of the item's node: the corner's X (axis 0) or Y (axis 1) becomes `mm`; a zone is
 * unfilled (UnFill + SetNeedRefill).  false when the corner is gone or already there.
 */
export function setVertex(node: Node, row: number, axis: 0 | 1, mm: number): boolean {
  const r = vertexRows(node)[row]; if (!r) return false;
  const xy = kids(ptsLists(node)[r.list], "xy")[r.at]; if (!xy) return false;
  const v = Math.round(mm * 1e6) / 1e6;
  if (Number(xy[axis + 1]) === v) return false;
  xy[axis + 1] = v;
  if (node[0] === "zone") {
    for (let i = node.length - 1; i > 0; i--) if (isList(node[i]) && (node[i] as Node)[0] === "filled_polygon") node.splice(i, 1);
    const fill = kid(node, "fill"); if (fill && fill[1] === "yes") fill.splice(1, 1);
  }
  return true;
}
/** parseCellValue's guard: the leading numeric token must hold a digit (a blank or non-numeric entry is refused). */
export function hasLeadingDigit(text: string): boolean {
  for (const ch of text.trim()) { if (/\d/.test(ch)) return true; if (!"+-.,".includes(ch)) return false; }
  return false;
}
