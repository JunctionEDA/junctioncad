// dialogs/zstd-compress.ts — a Zstandard (RFC 8878) frame encoder for the files the web embeds, as
// EMBEDDED_FILES::CompressAndEncode does with ZSTD_compress: a single-segment frame with its content size (the reader
// sizes its buffer with ZSTD_getFrameContentSize), blocks of at most 128 KiB holding LZ77 sequences found with a hash
// chain over the whole content and the three repeat offsets (lazy matching, one byte ahead), literals Huffman-coded
// (weights written directly, so for literals below 129) or raw, and the sequences coded with the predefined FSE tables.
// A block that would not get smaller is stored raw.  A STEP model comes out within about 1.4x of libzstd's level 15.
// The decoder is zstd.ts; it, libzstd and node's zlib.zstdDecompressSync read these frames back.

import { LL_BASE, LL_BITS, LL_NORM, ML_BASE, ML_BITS, ML_NORM, OF_NORM } from "./zstd";

const BLOCK = 128 * 1024;
const MIN_MATCH = 4;
const HASH_LOG = 17;
const MAX_CHAIN = 48;
const WINDOW = 1 << 26;
const highBit = (v: number): number => 31 - Math.clz32(v);

/** A forward bit stream that the decoder reads from its end (BIT_CStream): closed with the end marker bit. */
class BitW {
  bytes: number[] = []; private cur = 0; private nb = 0;
  add(v: number, n: number): void {
    while (n > 0) {
      const k = Math.min(n, 8 - this.nb);
      this.cur |= (v & ((1 << k) - 1)) << this.nb; this.nb += k; v = Math.floor(v / (1 << k)); n -= k;
      if (this.nb === 8) { this.bytes.push(this.cur); this.cur = 0; this.nb = 0; }
    }
  }
  close(): number[] { this.add(1, 1); if (this.nb) { this.bytes.push(this.cur); this.cur = 0; this.nb = 0; } return this.bytes; }
}

/** FSE_buildCTable over normalized counts (-1 = "less than one"), the same spread the decoder builds. */
interface FseC { log: number; state: Uint16Array; deltaNb: Int32Array; deltaFind: Int32Array }
function fseCTable(norm: number[], log: number): FseC {
  const size = 1 << log, mask = size - 1, step = (size >> 1) + (size >> 3) + 3;
  const sym = new Uint8Array(size), cumul: number[] = [0]; let high = size - 1;
  for (let u = 1; u <= norm.length; u++) {
    if (norm[u - 1] === -1) { cumul[u] = cumul[u - 1] + 1; sym[high--] = u - 1; } else cumul[u] = cumul[u - 1] + norm[u - 1];
  }
  let pos = 0;
  norm.forEach((c, s) => { for (let i = 0; i < c; i++) { sym[pos] = s; do pos = (pos + step) & mask; while (pos > high); } });
  const state = new Uint16Array(size);
  for (let u = 0; u < size; u++) state[cumul[sym[u]]++] = size + u;
  const deltaNb = new Int32Array(norm.length), deltaFind = new Int32Array(norm.length); let total = 0;
  norm.forEach((c, s) => {
    if (c === 0) deltaNb[s] = ((log + 1) << 16) - size;
    else if (c === -1 || c === 1) { deltaNb[s] = (log << 16) - size; deltaFind[s] = total - 1; total++; }
    else { const maxOut = log - highBit(c - 1), minPlus = c << maxOut; deltaNb[s] = (maxOut << 16) - minPlus; deltaFind[s] = total - c; total += c; }
  });
  return { log, state, deltaNb, deltaFind };
}
const LL_C = fseCTable(LL_NORM, 6), ML_C = fseCTable(ML_NORM, 6), OF_C = fseCTable(OF_NORM, 5);

/** FSE_initCState2 */
function fseInit(t: FseC, s: number): number {
  const nb = (t.deltaNb[s] + (1 << 15)) >> 16, v = (nb << 16) - t.deltaNb[s];
  return t.state[(v >> nb) + t.deltaFind[s]];
}
/** FSE_encodeSymbol: the bits of the state, and the next state */
function fseEncode(w: BitW, t: FseC, st: number, s: number): number {
  const nb = (st + t.deltaNb[s]) >> 16; w.add(st, nb); return t.state[(st >> nb) + t.deltaFind[s]];
}

const codeOf = (base: number[], v: number): number => { let c = base.length - 1; while (base[c] > v) c--; return c; };

/** One sequence: literal length, match length, and Offset_Value (1..3: a repeat offset, else the offset + 3). */
interface Seq { ll: number; ml: number; ov: number }

/** HUF code lengths of at most 11 bits for the used symbols; frequencies are flattened until the tree fits. */
function huffLengths(freq: number[]): number[] {
  let f = freq.slice();
  for (;;) {
    const len = new Array(f.length).fill(0);
    const nodes: { w: number; kids: number[] }[] = [];
    f.forEach((x, s) => { if (x) nodes.push({ w: x, kids: [s] }); });
    while (nodes.length > 1) {
      nodes.sort((a, b) => a.w - b.w);
      const a = nodes.shift()!, b = nodes.shift()!;
      for (const s of a.kids) len[s]++; for (const s of b.kids) len[s]++;
      nodes.push({ w: a.w + b.w, kids: a.kids.concat(b.kids) });
    }
    if (Math.max(...len) <= 11) return len;
    f = f.map((x) => (x ? (x >> 1) + 1 : 0));
  }
}

function literalsHeaderRaw(type: number, n: number): number[] {
  if (n < 32) return [type | (n << 3)];
  if (n < 4096) return [type | 4 | ((n & 15) << 4), n >> 4];
  return [type | 12 | ((n & 15) << 4), (n >> 4) & 255, n >> 12];
}

/** The literals section: Huffman-coded when that is smaller and every literal is below 129, else RLE or raw. */
function literalsSection(lit: Uint8Array): number[] {
  const n = lit.length;
  const raw = (): number[] => literalsHeaderRaw(0, n).concat(Array.from(lit));
  if (!n) return raw();
  const freq = new Array(256).fill(0); let maxSym = 0;
  for (let i = 0; i < n; i++) { freq[lit[i]]++; if (lit[i] > maxSym) maxSym = lit[i]; }
  const used = freq.filter((x) => x).length;
  if (used === 1) return literalsHeaderRaw(1, n).concat([lit[0]]);
  if (n < 64 || maxSym > 128) return raw();
  const len = huffLengths(freq.slice(0, maxSym + 1)), maxBits = Math.max(...len);
  const weight = len.map((l) => (l ? maxBits + 1 - l : 0));
  // HUF_readDTableX1's ranks: a symbol of weight w takes 2^(w-1) slots, lower weights first, symbols in order
  const count = new Array(maxBits + 2).fill(0); for (const x of weight) if (x) count[x]++;
  const start: number[] = []; let p = 0; for (let x = 1; x <= maxBits; x++) { start[x] = p; p += count[x] << (x - 1); }
  const code = new Array(weight.length).fill(0);
  weight.forEach((x, s) => { if (!x) return; code[s] = start[x] >> (x - 1); start[x] += 1 << (x - 1); });
  // the tree description: 127 + the number of weights written, two 4-bit weights a byte; the last symbol's is implied
  const tree = [127 + maxSym]; for (let i = 0; i < maxSym; i += 2) tree.push((weight[i] << 4) | (i + 1 < maxSym ? weight[i + 1] : 0));
  const stream = (from: number, to: number): number[] => { const w = new BitW(); for (let i = to - 1; i >= from; i--) w.add(code[lit[i]], len[lit[i]]); return w.close(); };
  let body: number[], sf: number;
  if (n <= 1023) { body = stream(0, n); sf = 0; }
  else {
    const q = (n + 3) >> 2, s = [stream(0, q), stream(q, 2 * q), stream(2 * q, 3 * q), stream(3 * q, n)];
    if (s[0].length > 65535 || s[1].length > 65535 || s[2].length > 65535) return raw();
    body = [s[0].length & 255, s[0].length >> 8, s[1].length & 255, s[1].length >> 8, s[2].length & 255, s[2].length >> 8].concat(s[0], s[1], s[2], s[3]);
    sf = -1;
  }
  const comp = tree.length + body.length;
  let hdr: number[];
  if (sf === 0) { if (comp > 1023) return raw(); hdr = [2 | ((n & 15) << 4), (n >> 4) | ((comp & 3) << 6), comp >> 2]; }
  else if (n < 1024 && comp < 1024) hdr = [2 | 4 | ((n & 15) << 4), (n >> 4) | ((comp & 3) << 6), comp >> 2];
  else if (n < 16384 && comp < 16384) hdr = [2 | 8 | ((n & 15) << 4), (n >> 4) & 255, (n >> 12) | ((comp & 63) << 2), comp >> 6];
  else if (comp < 262144) hdr = [2 | 12 | ((n & 15) << 4), (n >> 4) & 255, (n >> 12) | ((comp & 3) << 6), (comp >> 2) & 255, comp >> 10];
  else return raw();
  const out = hdr.concat(tree, body);
  return out.length < n + literalsHeaderRaw(0, n).length ? out : raw();
}

/** The sequences section with the predefined tables (ZSTD_encodeSequences, written last sequence first). */
function sequencesSection(seqs: Seq[]): number[] {
  const nb = seqs.length;
  const head = nb < 128 ? [nb] : nb < 0x7f00 ? [(nb >> 8) + 128, nb & 255] : [255, (nb - 0x7f00) & 255, (nb - 0x7f00) >> 8];
  if (!nb) return head;
  const ll = seqs.map((s) => codeOf(LL_BASE, s.ll)), ml = seqs.map((s) => codeOf(ML_BASE, s.ml)), of = seqs.map((s) => highBit(s.ov));
  const w = new BitW(), last = nb - 1;
  let sMl = fseInit(ML_C, ml[last]), sOf = fseInit(OF_C, of[last]), sLl = fseInit(LL_C, ll[last]);
  const extra = (i: number): void => {
    w.add(seqs[i].ll - LL_BASE[ll[i]], LL_BITS[ll[i]]); w.add(seqs[i].ml - ML_BASE[ml[i]], ML_BITS[ml[i]]);
    w.add(seqs[i].ov - 2 ** of[i], of[i]);
  };
  extra(last);
  for (let i = last - 1; i >= 0; i--) {
    sOf = fseEncode(w, OF_C, sOf, of[i]); sMl = fseEncode(w, ML_C, sMl, ml[i]); sLl = fseEncode(w, LL_C, sLl, ll[i]);
    extra(i);
  }
  w.add(sMl, ML_C.log); w.add(sOf, OF_C.log); w.add(sLl, LL_C.log);
  return head.concat([0], w.close());   // Symbol_Compression_Modes: predefined for all three
}

/** `data` as one zstd frame (ZSTD_compress): content size in the header, compressed blocks where they are smaller. */
export function zstdCompress(data: Uint8Array): Uint8Array {
  const n = data.length, out: number[] = [0x28, 0xb5, 0x2f, 0xfd, 0xe0];   // magic; FHD: 8-byte content size, single segment
  let size = n; for (let i = 0; i < 8; i++) { out.push(size % 256); size = Math.floor(size / 256); }
  const head = new Int32Array(1 << HASH_LOG).fill(-1), chain = new Int32Array(Math.max(1, n));
  const rep = [1, 4, 8];   // the repeat offsets, as the decoder will have them
  const hash = (i: number): number => (Math.imul(data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24), 0x9e3779b1) >>> (32 - HASH_LOG));
  let last = -1;   // the last position inserted: each goes in once
  const insert = (i: number): void => { if (i <= last || i + MIN_MATCH > n) return; last = i; const h = hash(i); chain[i] = head[h]; head[h] = i; };
  const offCost = (off: number): number => (rep.includes(off) ? 0 : highBit(off + 3));
  // Offset_Value for a match `off` back after `ll` literals, with the repeat offsets updated as the decoder will
  const offsetValue = (off: number, ll: number): number => {
    const cands = ll ? [rep[0], rep[1], rep[2]] : [rep[1], rep[2], rep[0] - 1];
    const k = cands.indexOf(off);
    if (k < 0) { rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = off; return off + 3; }
    const idx = k + (ll ? 0 : 1);   // the decoder's index: 0 = rep[0], 1 = rep[1], 2 = rep[2], 3 = rep[0] - 1
    if (idx !== 0) { if (idx === 1) rep[1] = rep[0]; else { rep[2] = rep[1]; rep[1] = rep[0]; } rep[0] = off; }
    return k + 1;
  };
  // the longest match for position i within the block (ending by `to`), among the chain's recent candidates and the
  // repeat offsets the decoder keeps
  const find = (i: number, to: number): [number, number] => {
    let best = 0, bestOff = 0;
    const tryAt = (cand: number): void => {
      if (cand < 0 || cand >= i || data[cand + best] !== data[i + best]) return;
      let l = 0; while (i + l < to && data[cand + l] === data[i + l]) l++;
      if (l > best || (l === best && l > 0 && offCost(i - cand) < offCost(bestOff))) { best = l; bestOff = i - cand; }
    };
    for (const r of rep) tryAt(i - r);
    let cand = head[hash(i)], depth = 0;
    while (cand >= 0 && depth++ < MAX_CHAIN && i - cand <= WINDOW && i + best < to) { tryAt(cand); cand = chain[cand]; }
    return [best, bestOff];
  };
  const blocks = Math.max(1, Math.ceil(n / BLOCK));
  for (let b = 0; b < blocks; b++) {
    const from = b * BLOCK, to = Math.min(n, from + BLOCK), lastFlag = b === blocks - 1 ? 1 : 0;
    const seqs: Seq[] = [], lits: number[] = [], rep0 = rep.slice(); let i = from, anchor = from;
    while (i + MIN_MATCH <= to) {
      let [best, bestOff] = find(i, to);
      if (best < MIN_MATCH) { insert(i); i++; continue; }
      // lazy matching: a longer match one byte on takes this byte as a literal
      while (i + 1 + MIN_MATCH <= to) {
        insert(i);
        const [l2, o2] = find(i + 1, to);
        if (l2 > best + (offCost(o2) > offCost(bestOff) ? 1 : 0)) { i++; best = l2; bestOff = o2; } else break;
      }
      for (let k = anchor; k < i; k++) lits.push(data[k]);
      seqs.push({ ll: i - anchor, ml: best, ov: offsetValue(bestOff, i - anchor) });
      const end = i + best; insert(i); for (i++; i < end; i++) insert(i); anchor = i;
    }
    for (let k = anchor; k < to; k++) lits.push(data[k]);
    const body = literalsSection(Uint8Array.from(lits)).concat(sequencesSection(seqs));
    const len = to - from;
    if (body.length < len) { const h = lastFlag | (2 << 1) | (body.length << 3); out.push(h & 255, (h >> 8) & 255, h >> 16); for (const x of body) out.push(x); }
    // a raw block has no sequences: the decoder's repeat offsets stay as they were
    else { rep.splice(0, 3, ...rep0); const h = lastFlag | (len << 3); out.push(h & 255, (h >> 8) & 255, h >> 16); for (let k = from; k < to; k++) out.push(data[k]); }
  }
  return Uint8Array.from(out);
}
