// Which tracks belong inside one block (a cluster's own wiring) and which join blocks: the board's tracks are
// grouped into connected pieces (shared ends, vias), and a piece that only touches the pads of one block is that
// block's.  Pads are found from the footprints as the layout left them (prepare.mjs).
const kid = (n, k) => n.find((c) => Array.isArray(c) && c[0] === k);
const kids = (n, k) => n.filter((c) => Array.isArray(c) && c[0] === k);
export function padsOf(fp) {
  const [X, Y, A = 0] = kid(fp.node, 'at').slice(1).map(Number); const r = (A * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return kids(fp.node, 'pad').map((p) => {
    const at = kid(p, 'at'), size = kid(p, 'size') || ['size', 1, 1]; const x = +at[1], y = +at[2];
    const n = kid(p, 'net'); const net = n ? String(n[n.length - 1]) : null;
    return { ref: fp.ref, block: fp.block, x: X + x * c + y * s, y: Y - x * s + y * c, r: Math.max(+size[1], +size[2]) / 2 + 0.05, net };
  });
}
export function splitTracks(I) {
  const pads = I.footprints.flatMap(padsOf);
  const tracks = I.board.filter((t) => t.kind !== 'zone');
  const parent = tracks.map((_, i) => i); const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const ends = (t) => (t.kind === 'via' ? [t.pts[0]] : [t.pts[0], t.pts[t.pts.length - 1]]);
  const key = (p) => `${Math.round(p[0] * 200)},${Math.round(p[1] * 200)}`;
  const at = new Map();
  tracks.forEach((t, i) => { for (const p of ends(t)) { const k = `${t.net}|${key(p)}`; if (at.has(k)) parent[find(i)] = find(at.get(k)); else at.set(k, i); } });
  // a via joins every track of its net that ends on it, on any layer (the key above is per point, any layer)
  const touch = tracks.map((t) => { const b = new Set(); for (const p of ends(t)) for (const q of pads) if ((q.net === t.net || !q.net) && Math.hypot(q.x - p[0], q.y - p[1]) <= q.r) b.add(q.block); return b; });
  const comp = new Map(); tracks.forEach((t, i) => { const r = find(i); if (!comp.has(r)) comp.set(r, { ids: [], blocks: new Set() }); const c = comp.get(r); c.ids.push(t.id); for (const b of touch[i]) c.blocks.add(b); });
  const inside = {}, between = [];
  for (const c of comp.values()) { if (c.blocks.size === 1) { const b = [...c.blocks][0]; (inside[b] = inside[b] || []).push(...c.ids); } else between.push(...c.ids); }
  return { inside, between, pads };
}
