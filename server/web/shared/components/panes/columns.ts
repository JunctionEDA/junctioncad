// Reorderable list columns (wxDATAVIEW_COL_REORDERABLE): the saved view order and a header drop.

/** The columns in the saved view order; columns the order does not name keep their model order after it. */
export function orderColumns<T extends { id: number }>(cols: T[], order?: number[]): T[] {
  if (!order || !order.length) return cols;
  const pos = new Map(order.map((id, i) => [id, i] as [number, number]));
  const rank = (c: T) => (pos.has(c.id) ? pos.get(c.id)! : 1e6 + cols.indexOf(c));
  return cols.slice().sort((a, b) => rank(a) - rank(b));
}

/** Move column `col` to the slot of column `to` (the header it was dropped on). */
export function moveColumn(order: number[], col: number, to: number): number[] {
  const from = order.indexOf(col), toIdx = order.indexOf(to);
  if (from < 0 || toIdx < 0 || col === to) return order.slice();
  const out = order.filter((id) => id !== col), at = out.indexOf(to);
  out.splice(from < toIdx ? at + 1 : at, 0, col);
  return out;
}
