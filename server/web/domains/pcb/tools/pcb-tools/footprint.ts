// pcb-tools/footprint.ts — footprint rotate / flip at the file level.
import type { SAtom } from "./types";
import { K } from "./state";
import { flipLayerName, isList, norm180, r6, sideSpecific } from "./util";

// ---------------------------------------------------------------- footprint rotate / flip (file-level)
// Pad and text angles in the file are absolute (KiCad writes lib angle + footprint angle), so a footprint
// turn re-derives each one from its angle relative to the footprint; a flip negates that relative angle.
export const ANGLED = (c: SAtom): c is SNode => isList(c) && (c[0] === "pad" || c[0] === "property" || c[0] === "fp_text") && !!K.kid(c, "at");
// the writer leaves a zero orientation out of a pad's and a footprint's (at x y): "(at 1 2)", never "(at 1 2 0)"; text always carries its angle
export function setAngle(c: SNode, a: number) { const at = K.kid(c, "at"); a = norm180(r6(a)); if (a === 0 && c[0] === "pad") { at!.length = Math.min(at!.length, 3); return; } if (at!.length >= 4) at![3] = a; else if (a !== 0) at!.push(a); }
export function setFootprintAt(node: SNode, x: number, y: number, a: number) { K.setAt(node, x, y, a); const at = K.kid(node, "at"); if (at && !K.kid(node, "transform") && a === 0 && at.length === 4 && typeof at[3] === "number") at.length = 3; }
export function rotateFootprintNode(node: SNode, deg: number) {
  const [x, y, a0] = K.atOf(node); const a1 = norm180(a0 + deg); setFootprintAt(node, x, y, a1);
  for (const c of node) if (ANGLED(c)) setAngle(c, K.atOf(c)[2] - a0 + a1);
  return node;
}
export function mirrorShapeX(g: SNode) {
  for (const key of ["start", "end", "center", "mid"]) { const k = K.kid(g, key); if (k) k[1] = r6(-K.num(k[1])); }
  const pts = K.kid(g, "pts");
  if (pts) for (const p of pts.slice(1)) { if (!isList(p)) continue; if (p[0] === "xy") p[1] = r6(-K.num(p[1])); else mirrorShapeX(p); }
}
export function flipLayerKid(c: SNode) {
  const l = K.kid(c, "layer"); if (l) l[1] = flipLayerName(K.str(l[1]));
  const ls = K.kid(c, "layers"); if (ls) for (let i = 1; i < ls.length; i++) ls[i] = flipLayerName(K.str(ls[i]));
}
export function toggleMirror(c: SNode) {
  const l = K.kid(c, "layer"); if (!l || !sideSpecific(K.str(l[1]))) return;   // user layers have no side: no mirroring
  let eff = K.kid(c, "effects"); if (!eff) { eff = ["effects"]; c.push(eff); }
  const j = K.kid(eff, "justify");
  if (!j) { eff.push(["justify", "mirror"]); return; }
  const i = j.indexOf("mirror");
  if (i < 0) j.push("mirror"); else { j.splice(i, 1); if (j.length === 1) eff.splice(eff.indexOf(j), 1); if (eff.length === 1) c.splice(c.indexOf(eff), 1); }
}
/** Flip to the other side about the footprint's own origin (KiCad's F): mirror local X, negate angles, swap F./B. layers, then KiCad's frame (turnFrame). */
export function flipFootprintNode(node: SNode) {
  const [x, y, a0] = K.atOf(node); const a1 = norm180(-a0); setFootprintAt(node, x, y, a1);
  const lay = K.kid(node, "layer"); if (lay) lay[1] = flipLayerName(K.str(lay[1]));
  for (const c of node) {
    if (!isList(c)) continue; const t = c[0] as string;
    if (ANGLED(c)) { const at = K.kid(c, "at"); at![1] = r6(-K.num(at![1])); setAngle(c, -(K.atOf(c)[2] - a0) + a1); }
    if (t === "pad") {
      flipLayerKid(c);
      const dr = K.kid(c, "drill"); const off = dr && K.kid(dr, "offset"); if (off) off[1] = r6(-K.num(off[1]));
      const prims = K.kid(c, "primitives"); if (prims) for (const p of prims.slice(1)) if (isList(p)) mirrorShapeX(p);
    } else if (t === "property" || t === "fp_text") { if (ANGLED(c)) { flipLayerKid(c); toggleMirror(c); } }
    else if (/^fp_(line|rect|circle|arc|poly|curve)$/.test(t)) { mirrorShapeX(c); flipLayerKid(c); }
    else if (t === "fp_text_box" || t === "zone") { mirrorShapeX(c); flipLayerKid(c); for (const poly of K.kids(c, "polygon").concat(K.kids(c, "filled_polygon"))) mirrorShapeX(poly); if (t === "fp_text_box") toggleMirror(c); }
  }
  return turnFrame(node);
}
/**
 * Write a flipped footprint the way KiCad does.  Mirroring local X with the angle negated puts every pad and line
 * where KiCad's left / right flip puts them, but KiCad gets there by mirroring local Y and turning half a turn
 * (FOOTPRINT::Flip: TOP_BOTTOM, then Rotate 180°), so it stores the angle 180 - a and the local Y mirrored.  The
 * board looks the same either way; the 3D model does not, because its transform follows the footprint's angle
 * (rotate(angle) · flip), so a footprint written the other way shows its model turned half a turn off its pads.
 * Same geometry, KiCad's frame: angle + 180, every local point turned half a turn about the origin.
 */
function turnFrame(node: SNode) {
  const neg = (v: number) => r6(-v) || 0;   // never write -0
  const [x, y, a] = K.atOf(node); setFootprintAt(node, x, y, norm180(a + 180));
  const half = (g: SNode) => {
    for (const key of ["start", "end", "center", "mid"]) { const k = K.kid(g, key); if (k) { k[1] = neg(K.num(k[1])); k[2] = neg(K.num(k[2])); } }
    const pts = K.kid(g, "pts");
    if (pts) for (const p of pts.slice(1)) { if (!isList(p)) continue; if (p[0] === "xy") { p[1] = neg(K.num(p[1])); p[2] = neg(K.num(p[2])); } else half(p); }
  };
  for (const c of node) {
    if (!isList(c)) continue; const t = c[0] as string;
    if (ANGLED(c)) { const at = K.kid(c, "at")!; at[1] = neg(K.num(at[1])); at[2] = neg(K.num(at[2])); }   // a text keeps its absolute angle
    if (t === "pad") {
      // a pad turns half a turn with the frame (PAD::Flip then the footprint's Rotate 180°): the same copper, KiCad's numbers
      setAngle(c, K.atOf(c)[2] + 180);
      const dr = K.kid(c, "drill"); const off = dr && K.kid(dr, "offset"); if (off) { off[1] = neg(K.num(off[1])); off[2] = neg(K.num(off[2])); }
      const rd = K.kid(c, "rect_delta"); if (rd) { rd[1] = neg(K.num(rd[1])); rd[2] = neg(K.num(rd[2])); }
      const prims = K.kid(c, "primitives"); if (prims) for (const p of prims.slice(1)) if (isList(p)) half(p);
      const ch = K.kid(c, "chamfer"); const opp: Record<string, string> = { top_left: "bottom_right", bottom_right: "top_left", top_right: "bottom_left", bottom_left: "top_right" };
      if (ch) for (let i = 1; i < ch.length; i++) { const v = K.str(ch[i]); if (opp[v]) ch[i] = opp[v]; }
    }
    else if (/^fp_(line|rect|circle|arc|poly|curve)$/.test(t)) half(c);
    else if (t === "fp_text_box" || t === "zone") { half(c); for (const poly of K.kids(c, "polygon").concat(K.kids(c, "filled_polygon"))) half(poly); }
  }
  return node;
}
