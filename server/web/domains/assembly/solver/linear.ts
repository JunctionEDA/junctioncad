// linear.ts — the two factorisations the solver needs.
//
//   EnvelopeMatrix   a symmetric positive-definite system stored as a skyline (each row from its first non-zero
//                    column to the diagonal).  With the bodies ordered breadth-first along the mates, a chain or
//                    a tree of mates has a narrow envelope, and factoring costs n · width² instead of n³: this
//                    is what keeps a few hundred instances interactive.
//   pivotedCholesky  a dense, rank-revealing factorisation of a positive semi-definite matrix, used once per
//                    solve (not per iteration) to count the freedoms left and find which bodies still move.

export class EnvelopeMatrix {
  readonly rows: Float64Array[];
  constructor(readonly n: number, readonly first: Int32Array) {
    this.rows = new Array(n);
    for (let i = 0; i < n; i++) this.rows[i] = new Float64Array(i - first[i] + 1);
  }
  clear(): void { for (const r of this.rows) r.fill(0); }
  /** Add to entry (i, j), which must be inside the envelope (j ≤ i is stored). */
  add(i: number, j: number, v: number): void { if (j > i) { const t = i; i = j; j = t; } this.rows[i][j - this.first[i]] += v; }
  diagonal(out: Float64Array): void { for (let i = 0; i < this.n; i++) out[i] = this.rows[i][i - this.first[i]]; }

  /** Factor (this + shift) into L·Lᵀ in `into` (same envelope).  False when it is not positive definite. */
  factor(into: EnvelopeMatrix, shift: Float64Array): boolean {
    const n = this.n, first = this.first;
    for (let i = 0; i < n; i++) {
      const src = this.rows[i], ri = into.rows[i], fi = first[i];
      for (let j = fi; j <= i; j++) {
        const rj = into.rows[j], fj = first[j];
        let s = src[j - fi] + (j === i ? shift[i] : 0);
        for (let k = fi > fj ? fi : fj; k < j; k++) s -= ri[k - fi] * rj[k - fj];
        if (j < i) ri[j - fi] = s / rj[j - fj];
        else { if (!(s > 0)) return false; ri[i - fi] = Math.sqrt(s); }
      }
    }
    return true;
  }
  /** Solve L·Lᵀ·x = b in place (this holds L). */
  solve(b: Float64Array): void {
    const n = this.n, first = this.first;
    for (let i = 0; i < n; i++) {
      const ri = this.rows[i], fi = first[i];
      let s = b[i];
      for (let k = fi; k < i; k++) s -= ri[k - fi] * b[k];
      b[i] = s / ri[i - fi];
    }
    for (let i = n - 1; i >= 0; i--) {
      const ri = this.rows[i], fi = first[i];
      const x = b[i] / ri[i - fi];
      b[i] = x;
      for (let k = fi; k < i; k++) b[k] -= ri[k - fi] * x;
    }
  }
}

/**
 * Cholesky with diagonal pivoting of a dense symmetric positive semi-definite matrix (row-major, n × n; it is
 * overwritten).  Stops when the largest remaining diagonal falls below `tol` × the largest at the start: the
 * number of steps taken is the rank.  Returns the rank and a basis of the null space (n − rank vectors).
 */
export function pivotedCholesky(a: Float64Array, n: number, tol = 1e-9): { rank: number; nullspace: Float64Array[] } {
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  let top = 0;
  for (let i = 0; i < n; i++) top = Math.max(top, a[i * n + i]);
  const floor = Math.max(top * tol, 1e-300);
  let rank = 0;
  const swap = (p: number, q: number) => {
    if (p === q) return;
    for (let k = 0; k < n; k++) { const t = a[p * n + k]; a[p * n + k] = a[q * n + k]; a[q * n + k] = t; }
    for (let k = 0; k < n; k++) { const t = a[k * n + p]; a[k * n + p] = a[k * n + q]; a[k * n + q] = t; }
    const t = perm[p]; perm[p] = perm[q]; perm[q] = t;
  };
  for (let k = 0; k < n; k++) {
    let best = k, bv = a[k * n + k];
    for (let i = k + 1; i < n; i++) if (a[i * n + i] > bv) { bv = a[i * n + i]; best = i; }
    if (!(bv > floor)) break;
    swap(k, best);
    const d = Math.sqrt(a[k * n + k]);
    a[k * n + k] = d;
    for (let i = k + 1; i < n; i++) a[i * n + k] /= d;
    for (let i = k + 1; i < n; i++) {
      const lik = a[i * n + k];
      if (lik === 0) continue;
      for (let j = k + 1; j <= i; j++) a[i * n + j] -= lik * a[j * n + k];
    }
    // keep the trailing block symmetric for the swaps
    for (let i = k + 1; i < n; i++) for (let j = i + 1; j < n; j++) a[i * n + j] = a[j * n + i];
    rank++;
  }
  // null vectors: for each free column j (permuted index ≥ rank), x solves L11ᵀ·x = L21[j], and the vector is
  // −x on the pivoted columns and 1 on column j
  const nullspace: Float64Array[] = [];
  for (let j = rank; j < n; j++) {
    const x = new Float64Array(rank);
    for (let i = rank - 1; i >= 0; i--) {
      let s = a[j * n + i];
      for (let k = i + 1; k < rank; k++) s -= a[k * n + i] * x[k];
      x[i] = s / a[i * n + i];
    }
    const v = new Float64Array(n);
    for (let i = 0; i < rank; i++) v[perm[i]] = -x[i];
    v[perm[j]] = 1;
    nullspace.push(v);
  }
  return { rank, nullspace };
}

/** The rank of a small set of vectors (each of length `m`), by Gram–Schmidt with a relative tolerance. */
export function rankOf(vectors: Float64Array[], m: number, tol = 1e-6): number {
  const basis: Float64Array[] = [];
  let scale = 0;
  for (const v of vectors) { let s = 0; for (let i = 0; i < m; i++) s += v[i] * v[i]; scale = Math.max(scale, Math.sqrt(s)); }
  if (scale === 0) return 0;
  for (const v0 of vectors) {
    const v = Float64Array.from(v0);
    for (let pass = 0; pass < 2; pass++) for (const b of basis) { let d = 0; for (let i = 0; i < m; i++) d += v[i] * b[i]; for (let i = 0; i < m; i++) v[i] -= d * b[i]; }
    let s = 0; for (let i = 0; i < m; i++) s += v[i] * v[i];
    s = Math.sqrt(s);
    if (s > tol * scale) { for (let i = 0; i < m; i++) v[i] /= s; basis.push(v); if (basis.length === m) break; }
  }
  return basis.length;
}
