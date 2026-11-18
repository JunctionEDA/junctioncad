// A 2D field solver for the cross-section of one track: the potential round it is solved on a grid (red-black SOR)
// once with the dielectrics and once in air, and the line's impedance follows from the two capacitances,
// Z = 1 / (c * sqrt(C * C_air)).  It handles what the closed forms cannot: ground copper beside the track on its own
// layer (grounded coplanar), planes cut away under the track, and a stack of dielectrics with different permittivity.
// Two grid sizes are solved and the answer extrapolated to a fine grid (the error falls about linearly with the cell),
// which agrees with Hammerstad's microstrip to about 1% where that one holds.

export interface FeedSection {
  w: number;                 // track width, mm
  t: number;                 // copper thickness, mm
  gap: number;               // gap to the ground copper beside it on its own layer (0: none)
  dielectrics: { th: number; er: number }[];    // from the track's layer downwards, each ending at a copper layer
  voidHalf: number;          // the planes above the reference are cut away within this distance of the centre line (0: none)
  reference: number;         // index of the dielectric under which the reference plane lies (the planes above it are voided)
  above?: { th: number; er: number }[];          // stripline: the dielectrics from the track's layer upwards, each ending at a copper layer
  referenceAbove?: number;   // stripline: index of the dielectric above which the upper reference lies (the planes nearer are voided)
}

interface Field { V: Float64Array; nx: number; ny: number; res: number; half: number; air: number }
function solveC(s: FeedSection, res: number, withDielectric: boolean): number { return solveField(s, res, withDielectric).energy; }
function solveField(s: FeedSection, res: number, withDielectric: boolean): { energy: number; f: Field } {
  // a coarser solution first, as the starting guess: SOR is slow on the long waves, and the coarse grid gets those cheaply
  const coarse = res < 0.03 ? solveField(s, res * 2, withDielectric).f : null;
  const depth = s.dielectrics.slice(0, s.reference + 1).reduce((a, d) => a + d.th, 0);
  const up = s.above && s.above.length ? s.above.slice(0, (s.referenceAbove ?? 0) + 1) : null;
  const depthUp = up ? s.t + up.reduce((a, d) => a + d.th, 0) : 0, deep = Math.max(depth, depthUp);
  const side = s.gap > 0 ? s.w / 2 + s.gap + Math.max(0.6, 1.2 * deep) : s.w / 2 + Math.max(1.5, 5 * deep);
  const half = Math.max(side, s.voidHalf + Math.max(0.5, deep));
  const air = up ? depthUp + res : Math.max(0.8, 2 * s.w);            // above the track: open air, or the stack up to the upper plane
  const nx = Math.round((2 * half) / res) + 1, ny = Math.round((air + depth + res) / res) + 1;
  const V = new Float64Array(nx * ny), eps = new Float64Array(nx * ny).fill(1), fixed = new Uint8Array(nx * ny);
  const X = (i: number) => -half + i * res, Y = (j: number) => -air + j * res;
  if (coarse) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cx = (X(i) + coarse.half) / coarse.res, cy = (Y(j) + coarse.air) / coarse.res; const i0 = Math.max(0, Math.min(coarse.nx - 2, Math.floor(cx))), j0 = Math.max(0, Math.min(coarse.ny - 2, Math.floor(cy))); const fx = Math.min(1, Math.max(0, cx - i0)), fy = Math.min(1, Math.max(0, cy - j0));
    const c = coarse.V, n = coarse.nx; V[j * nx + i] = (c[j0 * n + i0] * (1 - fx) + c[j0 * n + i0 + 1] * fx) * (1 - fy) + (c[(j0 + 1) * n + i0] * (1 - fx) + c[(j0 + 1) * n + i0 + 1] * fx) * fy;
  }
  const planes: number[] = []; let acc = 0; for (let k = 0; k <= s.reference; k++) { acc += s.dielectrics[k].th; planes.push(acc); }
  const planesUp: number[] = []; if (up) { let a = -s.t; for (const d of up) { a -= d.th; planesUp.push(a); } }
  for (let j = 0; j < ny; j++) {
    const y = Y(j);
    let er = 1; if (withDielectric && y >= 0) { let a = 0; er = s.dielectrics[s.dielectrics.length - 1].er; for (const d of s.dielectrics) { if (y < a + d.th) { er = d.er; break; } a += d.th; } }
    else if (withDielectric && up) { let a = -s.t; er = up[0].er; if (y < a) for (const d of up) { er = d.er; if (y >= a - d.th) break; a -= d.th; } }
    for (let i = 0; i < nx; i++) {
      const x = X(i), id = j * nx + i; eps[id] = er;
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) { fixed[id] = 1; V[id] = 0; continue; }
      if (y >= -s.t - 1e-9 && y <= 1e-9) { if (Math.abs(x) <= s.w / 2 + 1e-9) { fixed[id] = 1; V[id] = 1; continue; } if (s.gap > 0 && Math.abs(x) >= s.w / 2 + s.gap - 1e-9) { fixed[id] = 1; V[id] = 0; continue; } }
      for (let k = 0; k < planes.length; k++) if (Math.abs(y - planes[k]) < res / 2 && (k === planes.length - 1 || Math.abs(x) >= s.voidHalf)) { fixed[id] = 1; V[id] = 0; break; }
      if (y > planes[planes.length - 1]) { fixed[id] = 1; V[id] = 0; }
      if (up && !fixed[id]) { for (let k = 0; k < planesUp.length; k++) if (Math.abs(y - planesUp[k]) < res / 2 && (k === planesUp.length - 1 || Math.abs(x) >= s.voidHalf)) { fixed[id] = 1; V[id] = 0; break; } if (y < planesUp[planesUp.length - 1]) { fixed[id] = 1; V[id] = 0; } }
    }
  }
  const om = 1.94;
  for (let it = 0; it < 20000; it++) {
    let delta = 0;
    for (let colour = 0; colour < 2; colour++) for (let j = 1; j < ny - 1; j++) for (let i = 1 + ((j + colour) & 1); i < nx - 1; i += 2) {
      const id = j * nx + i; if (fixed[id]) continue;
      const e0 = eps[id]; const ew = (e0 + eps[id - 1]) / 2, ee = (e0 + eps[id + 1]) / 2, en = (e0 + eps[id - nx]) / 2, es = (e0 + eps[id + nx]) / 2;
      const nv = (ew * V[id - 1] + ee * V[id + 1] + en * V[id - nx] + es * V[id + nx]) / (ew + ee + en + es);
      const d = om * (nv - V[id]); V[id] += d; if (Math.abs(d) > delta) delta = Math.abs(d);
    }
    if (delta < 2e-6) break;
  }
  let energy = 0;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const id = j * nx + i; const gx = (V[id + 1] - V[id]) / res, gy = (V[id + nx] - V[id]) / res; energy += eps[id] * (gx * gx + gy * gy) * res * res; }
  return { energy, f: { V, nx, ny, res, half, air } };            // energy: C / eps0 per unit length (V = 1)
}

const C0 = 299792458, E0 = 8.8541878128e-12;
function zAt(s: FeedSection, res: number): { z: number; eeff: number } {
  const c = solveC(s, res, true), ca = solveC(s, res, false);
  return { z: 1 / (C0 * Math.sqrt(c * E0 * ca * E0)), eeff: c / ca };
}
/** The impedance of the section, extrapolated from two grids. */
export function feedImpedance(s: FeedSection, res = 0.01): { z: number; eeff: number } {
  const a = zAt(s, res), b = zAt(s, res / 2);
  return { z: 2 * b.z - a.z, eeff: 2 * b.eeff - a.eeff };
}
/** The width that gives `target` ohms; the voided band, when there is one, follows the width (voidHalf = w/2 + gap + margin). */
export function feedWidth(base: Omit<FeedSection, "w" | "voidHalf">, target: number, margin: number | null, lo = 0.08, hi = 3, res = 0.02): { w: number; z: number; voidHalf: number } | null {
  const at = (w: number) => { const voidHalf = margin === null ? 0 : w / 2 + base.gap + margin; return { voidHalf, ...feedImpedance({ ...base, w, voidHalf }, res) }; };
  let a = lo, b = hi; let fa = at(a).z - target, fb = at(b).z - target;
  if (fa < 0 || fb > 0) return null;
  for (let i = 0; i < 18 && b - a > 0.004; i++) {      // regula falsi (Illinois), a few solves
    const m = Math.min(b - 0.001, Math.max(a + 0.001, b - fb * (b - a) / (fb - fa))); const r = at(m); const fm = r.z - target;
    if (Math.abs(fm) < 0.25) return { w: m, z: r.z, voidHalf: r.voidHalf };
    if (fm > 0) { a = m; fa = fm; fb /= 2; } else { b = m; fb = fm; fa /= 2; }
  }
  const w = (a + b) / 2; const r = at(w); return { w, z: r.z, voidHalf: r.voidHalf };
}
/** feedWidth searched on a coarse grid, then corrected once on a fine one (the coarse grid's bias is near constant). */
export function feedDesign(base: Omit<FeedSection, "w" | "voidHalf">, target: number, margin: number | null): { w: number; z: number; voidHalf: number } | null {
  const first = feedWidth(base, target, margin); if (!first) return null;
  const fine = feedImpedance({ ...base, w: first.w, voidHalf: first.voidHalf }, 0.01).z; const shifted = target - (fine - first.z);
  const second = feedWidth(base, shifted, margin, Math.max(0.08, first.w * 0.6), first.w * 1.6); if (!second) return { ...first, z: fine };
  return { w: second.w, voidHalf: second.voidHalf, z: feedImpedance({ ...base, w: second.w, voidHalf: second.voidHalf }, 0.01).z };
}
